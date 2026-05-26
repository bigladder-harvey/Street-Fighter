import express from "express";
import fetch from "node-fetch";
import { createShopifyFulfillment } from "../services/shopify.js";

const router = express.Router();

/* =========================================
   MYZE CONFIG
========================================= */

// const MYZE_BASE_URL =
//     "https://api.myze.io";

const MYZE_STORE_ID =
    process.env.MYZE_STORE_ID;

const MYZE_API_KEY =
    process.env.MYZE_API_KEY;

const MYZE_COMPANY_ID =
    process.env.MYZE_COMPANY_ID;

/* =========================================
   UPDATE MYZE ORDER WITH SHIPPING INFO
   Calls Myze's external-order endpoint
   with the label and tracking details
   from ShipStation.
========================================= */

async function updateMyzeOrderShipment({
    externalOrderId,
    labelUrl,
    trackingUrl,
    trackingCode,
    carrier,
    labelFormat
}) {
    try {
        const response = await fetch(
            `https://bb6pq1fm23.execute-api.eu-central-1.amazonaws.com/test/company/${MYZE_COMPANY_ID}/store/${MYZE_STORE_ID}/external-order/${externalOrderId}`,
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
                        labelUrl,
                        trackingUrl:
                            trackingUrl || null,
                        trackingCode:
                            trackingCode || null,
                        labelFormat:
                            labelFormat || "pdf",
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
   SHIPSTATION LABEL PURCHASED WEBHOOK
   Fires when a label is bought in
   ShipStation UI or via API.

   Flow:
   1. Receive label details from ShipStation
   2. Update Myze order with label + tracking
   3. Create Shopify fulfillment so customer
      gets notified
========================================= */

router.post(
    "/",
    express.json(),
    async (req, res) => {
        try {
            const payload = req.body;

            console.log(
                "📬 ShipStation label webhook received"
            );

            /* =========================
               LOG FULL PAYLOAD
               Helpful during initial
               testing — remove later
            ========================= */
            console.log(
                "ShipStation payload:",
                JSON.stringify(payload, null, 2)
            );

            /* =========================
               EXTRACT LABEL DATA
            ========================= */
            const {
                label_id,
                shipment_id,
                label_download,
                tracking_number,
                carrier_code,
                carrier_id,
                service_code,
                shipment
            } = payload;

            if (!label_id) {
                console.warn(
                    "⚠ No label_id in payload — ignoring"
                );
                return res
                    .status(200)
                    .json({ ignored: true });
            }

            /* =========================
               GET EXTERNAL ORDER ID
               This is the Shopify order
               ID we set when creating
               the ShipStation shipment
            ========================= */
            const externalOrderId =
                shipment?.external_shipment_id;

            if (!externalOrderId) {
                console.error(
                    "❌ No external_shipment_id on shipment — cannot link to Myze/Shopify"
                );
                return res
                    .status(200)
                    .json({ ignored: true });
            }

            /* =========================
               BUILD LABEL URL
               label_download contains
               href, pdf, png, zpl links
            ========================= */
            const labelUrl =
                label_download?.href ||
                label_download?.pdf ||
                null;

            if (!labelUrl) {
                console.error(
                    "❌ No label URL in payload"
                );
                return res
                    .status(200)
                    .json({ ignored: true });
            }

            /* =========================
               BUILD TRACKING URL
               ShipStation doesn't always
               provide this directly —
               construct from carrier
               if not present
            ========================= */
            const trackingUrl =
                payload.tracking_url ||
                buildTrackingUrl(
                    carrier_code,
                    tracking_number
                );

            /* =========================
               STEP 1 — UPDATE MYZE
               Send label + tracking to
               Myze so they can ship
            ========================= */
            await updateMyzeOrderShipment({
                externalOrderId,
                labelUrl,
                trackingUrl,
                trackingCode:
                    tracking_number || null,
                carrier:
                    carrier_code || null,
                labelFormat: "pdf"
            });

            /* =========================
               STEP 2 — UPDATE SHOPIFY
               Create fulfillment so
               customer gets notified
            ========================= */
            await createShopifyFulfillment({
                shopifyOrderId:
                    externalOrderId,
                trackingNumber:
                    tracking_number || "",
                trackingUrl:
                    trackingUrl || "",
                carrier:
                    carrier_code || ""
            });

            console.log(
                `✅ ShipStation label webhook processed for order ${externalOrderId}`
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
               ShipStation will retry on
               non-200 — we don't want
               duplicate processing
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

/* =========================================
   BUILD TRACKING URL
   Constructs a tracking URL from carrier
   code + tracking number when ShipStation
   doesn't provide one directly
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

    return (
        trackingUrls[carrier] || null
    );
}

export default router;