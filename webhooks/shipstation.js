import express from "express";
import fetch from "node-fetch";
import { getCache, setCache } from "../utils/redis.js";
import { createShopifyFulfillment } from "../services/shopify.js";

const router = express.Router();

/* =========================================
   MYZE CONFIG
========================================= */

const MYZE_BASE_URL =
    "https://api.myze.io";

const MYZE_STORE_ID =
    process.env.MYZE_STORE_ID;

const MYZE_API_KEY =
    process.env.MYZE_API_KEY;

/* =========================================
   UPDATE MYZE ORDER WITH SHIPPING INFO
========================================= */

async function updateMyzeOrderShipment({
    externalOrderId,
    labelUrl,
    trackingUrl,
    trackingCode,
    carrier
}) {
    try {
        const response = await fetch(
            `${MYZE_BASE_URL}/store/${MYZE_STORE_ID}/external-order/${externalOrderId}`,
            {
                method: "PUT",
                headers: {
                    "Content-Type":
                        "application/json",
                    "x-accesstoken":
                        MYZE_API_KEY
                },
                body: JSON.stringify({
                    externalShipmentInfo: {
                        labelUrl:
                            labelUrl || null,
                        trackingUrl:
                            trackingUrl || null,
                        trackingCode:
                            trackingCode || null,
                        labelFormat: "pdf",
                        shippingProvider:
                            carrier || null
                    }
                })
            }
        );

        if (!response.ok) {
            const err =
                await response.json();
            console.error(
                "Myze update order error:",
                err
            );
            throw new Error(
                "Failed to update Myze order"
            );
        }

        console.log(
            `✅ Myze order ${externalOrderId} updated with shipping info`
        );
    } catch (err) {
        console.error(
            "updateMyzeOrderShipment error:",
            err.message
        );
        throw err;
    }
}

/* =========================================
   FETCH LABEL DETAILS FROM SHIPSTATION
   Given a tracking number, find the
   associated label to get the label URL
========================================= */

async function fetchLabelByTrackingNumber(
    trackingNumber
) {
    try {
        const response = await fetch(
            `https://api.shipstation.com/v2/labels?tracking_number=${trackingNumber}`,
            {
                headers: {
                    "API-Key":
                        process.env.SHIPSTATION_API_KEY
                }
            }
        );

        if (!response.ok) return null;

        const data = await response.json();
        const labels = data.labels || [];

        if (!labels.length) return null;

        /* Return most recent label */
        return labels.sort((a, b) => {
            return (
                new Date(b.created_at) -
                new Date(a.created_at)
            );
        })[0];
    } catch (err) {
        console.error(
            "fetchLabelByTrackingNumber error:",
            err.message
        );
        return null;
    }
}

/* =========================================
   FETCH SHIPMENT BY LABEL ID
   Gets the shipment to extract the
   external_shipment_id (Shopify order ID)
========================================= */

async function fetchShipmentByLabelId(
    labelId
) {
    try {
        const response = await fetch(
            `https://api.shipstation.com/v2/labels/${labelId}`,
            {
                headers: {
                    "API-Key":
                        process.env.SHIPSTATION_API_KEY
                }
            }
        );

        if (!response.ok) return null;

        return await response.json();
    } catch (err) {
        console.error(
            "fetchShipmentByLabelId error:",
            err.message
        );
        return null;
    }
}

/* =========================================
   BUILD TRACKING URL FROM CARRIER
========================================= */

function buildTrackingUrl(
    carrierCode,
    trackingNumber
) {
    if (!trackingNumber) return null;

    const carrier =
        (carrierCode || "").toLowerCase();

    const trackingUrls = {
        ups:
            `https://www.ups.com/track?tracknum=${trackingNumber}`,
        fedex:
            `https://www.fedex.com/fedextrack/?tracknumbers=${trackingNumber}`,
        usps:
            `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`,
        dhl:
            `https://www.dhl.com/en/express/tracking.html?AWB=${trackingNumber}`,
        dhl_express:
            `https://www.dhl.com/en/express/tracking.html?AWB=${trackingNumber}`
    };

    return trackingUrls[carrier] || null;
}

/* =========================================
   SHIPSTATION TRACKING WEBHOOK
   Fires on every tracking event.
   We only act on "AC" (Accepted) —
   first scan by carrier, meaning the
   label was purchased and handed over.
   All subsequent tracking events are
   ignored via Redis.
========================================= */

router.post(
    "/",
    express.json(),
    async (req, res) => {
        try {
            const payload = req.body;

            console.log(
                "📬 ShipStation tracking webhook received"
            );

            /* =========================
               LOG FULL PAYLOAD
               Remove after first test
            ========================= */
            console.log(
                "ShipStation payload:",
                JSON.stringify(payload, null, 2)
            );

            /* =========================
               EXTRACT TRACKING DATA
               Per the webhook schema:
               tracking_number, status_code,
               label_url are top-level
            ========================= */
            const {
                tracking_number,
                status_code,
                label_url
            } = payload;

            if (!tracking_number) {
                console.warn(
                    "⚠ No tracking_number — ignoring"
                );
                return res
                    .status(200)
                    .json({ ignored: true });
            }

            /* =========================
               ONLY PROCESS FIRST SCAN
               AC = Accepted by carrier
               This means label is bought
               and package handed over.
               All other status codes
               (IT, DE, etc) are ignored.
            ========================= */
            if (status_code !== "AC") {
                console.log(
                    `⏭ Ignoring tracking event: ${status_code} for ${tracking_number}`
                );
                return res
                    .status(200)
                    .json({ ignored: true });
            }

            /* =========================
               DUPLICATE PROTECTION
               Only process AC once per
               tracking number
            ========================= */
            const redisKey =
                `shipstation:tracking:${tracking_number}`;

            const alreadyProcessed =
                await getCache(redisKey);

            if (alreadyProcessed) {
                console.log(
                    `⏭ Already processed tracking: ${tracking_number}`
                );
                return res
                    .status(200)
                    .json({ duplicate: true });
            }

            /* =========================
               FETCH LABEL DETAILS
               We need the label to get
               external_shipment_id and
               the label download URL
            ========================= */
            const label =
                await fetchLabelByTrackingNumber(
                    tracking_number
                );

            if (!label) {
                console.error(
                    `❌ Could not find label for tracking number: ${tracking_number}`
                );
                return res
                    .status(200)
                    .json({ ignored: true });
            }

            /* =========================
               GET EXTERNAL ORDER ID
               This is the Shopify order
               ID we set as
               external_shipment_id when
               creating the shipment
            ========================= */
            const externalOrderId =
                label.external_shipment_id ||
                label.shipment?.external_shipment_id;

            if (!externalOrderId) {
                console.error(
                    "❌ No external_shipment_id on label — cannot link to order"
                );
                return res
                    .status(200)
                    .json({ ignored: true });
            }

            /* =========================
               RESOLVE LABEL URL
               Use from webhook payload
               first, fall back to label
            ========================= */
            const resolvedLabelUrl =
                label_url ||
                label.label_download?.href ||
                label.label_download?.pdf ||
                null;

            /* =========================
               BUILD TRACKING URL
            ========================= */
            const trackingUrl =
                buildTrackingUrl(
                    label.carrier_code,
                    tracking_number
                );

            /* =========================
               STEP 1 — UPDATE MYZE
            ========================= */
            await updateMyzeOrderShipment({
                externalOrderId,
                labelUrl: resolvedLabelUrl,
                trackingUrl,
                trackingCode: tracking_number,
                carrier: label.carrier_code
            });

            /* =========================
               STEP 2 — UPDATE SHOPIFY
            ========================= */
            await createShopifyFulfillment({
                shopifyOrderId:
                    externalOrderId,
                trackingNumber:
                    tracking_number,
                trackingUrl:
                    trackingUrl || "",
                carrier:
                    label.carrier_code || ""
            });

            /* =========================
               MARK AS PROCESSED
               TTL: 30 days
            ========================= */
            await setCache(
                redisKey,
                { processed: true },
                60 * 60 * 24 * 30
            );

            console.log(
                `✅ ShipStation tracking webhook processed for order ${externalOrderId}`
            );

            return res
                .status(200)
                .json({ success: true });

        } catch (err) {
            console.error(
                "❌ ShipStation webhook error:",
                err.message
            );

            /* =========================
               RETURN 200 EVEN ON ERROR
               Prevents ShipStation from
               retrying and double-processing
            ========================= */
            return res
                .status(200)
                .json({
                    success: false,
                    error: err.message
                });
        }
    }
);

export default router;