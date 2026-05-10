import express from "express";
import crypto from "crypto";

import {
    getCache,
    setCache
} from "../utils/redis.js";

import {
    createProduct,
    getCollectionByHandle,
    addProductToCollection
} from "../services/shopify.js";

import {
    createShopifyFulfillment
} from "../services/shopify.js";

const router = express.Router();

/* =========================
   RAW BODY PARSER
========================= */

router.use(
    express.raw({
        type: "application/json"
    })
);

/* =========================
   VERIFY MYZE SIGNATURE
========================= */

function verifySignature(req) {

    try {

        const signature =
            req.headers["x-myze-webhook-signature"];

        const timestamp =
            req.headers["x-myze-webhook-timestamp"];

        const accessToken =
            req.headers["x-accesstoken"];

        /* =========================
           VERIFY ACCESS TOKEN
        ========================= */

        if (
            !accessToken ||
            accessToken !== process.env.MYZE_API_KEY
        ) {

            console.error(
                "Invalid Myze access token"
            );

            return false;
        }

        /* =========================
           VERIFY REQUIRED HEADERS
        ========================= */

        if (!signature || !timestamp) {

            console.error(
                "Missing webhook headers"
            );

            return false;
        }

        /* =========================
           RAW PAYLOAD
        ========================= */

        const rawBody =
            req.body.toString("utf8");

        const signedPayload =
            `${timestamp}.${rawBody}`;

        /* =========================
           CREATE EXPECTED SIGNATURE
        ========================= */

        const expectedHmac =
            crypto
                .createHmac(
                    "sha256",
                    process.env.MYZE_WEBHOOK_SECRET
                )
                .update(signedPayload)
                .digest("base64");

        const expectedSignature =
            `v1=${expectedHmac}`;

        /* =========================
           SAFE SIGNATURE COMPARISON
        ========================= */

        return crypto.timingSafeEqual(
            Buffer.from(signature),
            Buffer.from(expectedSignature)
        );

    } catch (err) {

        console.error(
            "Signature verification error:",
            err
        );

        return false;
    }
}

/* =========================
   ARTICLE PUBLISHED WEBHOOK
========================= */

router.post(
    "/article-published",

    async (req, res) => {

        try {

            /* =========================
               VERIFY WEBHOOK
            ========================= */

            const valid =
                verifySignature(req);

            if (!valid) {

                return res.status(401).json({
                    success: false,
                    error: "Invalid webhook signature"
                });
            }
            // console.log(req.headers);

            // console.log(req.body.toString());

            // const valid = true;

            /* =========================
               PARSE PAYLOAD
            ========================= */

            const payload =
                JSON.parse(
                    req.body.toString()
                );

            console.log(
                "🧢 Myze webhook received"
            );

            /* =========================
               EXTRACT DATA
            ========================= */

            const {
                articleId,
                articleName,
                articleDescription,
                variants
            } = payload.data;

            /* =========================
               PREPARE SHOPIFY VARIANTS
            ========================= */

            const shopifyVariants =
                variants.map(variant => ({
                    color: variant.color,
                    size: variant.size,
                    sku: variant.sku,

                    price:
                        variant.price?.amount ||
                        "0.00",

                    image:
                        variant.previewImageUrl
                }));

            /* =========================
               COLLECT IMAGES
            ========================= */

            const images =
                [
                    ...new Set(
                        variants.map(
                            v => v.previewImageUrl
                        )
                    )
                ];

            /* =========================
               CREATE SHOPIFY PRODUCT
            ========================= */

            const product =
                await createProduct({

                    title: articleName,

                    description:
                        articleDescription,

                    vendor: "Myze",

                    productType:
                        "Limited Drop",

                    tags: [
                        "limited-drop",
                        `myze-${articleId}`
                    ],

                    images,

                    variants:
                        shopifyVariants
                });

            console.log(
                "✅ Shopify product created"
            );

            // /* =========================
            //    FIND TARGET COLLECTION
            // ========================= */

            // /*
            //   IMPORTANT:
            //   Replace this with your
            //   actual collection handle
            // */

            // const collectionHandle =
            //     "limited";

            // const collection =
            //     await getCollectionByHandle(
            //         collectionHandle
            //     );

            // /* =========================
            //    ADD PRODUCT TO COLLECTION
            // ========================= */

            // if (collection) {

            //     await addProductToCollection({

            //         productId:
            //             product.id,

            //         collectionId:
            //             collection.id
            //     });

            //     console.log(
            //         "✅ Product added to collection"
            //     );

            // } else {

            //     console.log(
            //         "⚠️ Collection not found"
            //     );
            // }

            /* =========================
               SUCCESS RESPONSE
            ========================= */

            return res.json({
                success: true,
                message:
                    "Webhook processed successfully"
            });

        } catch (err) {

            console.error(
                "Myze webhook error:",
                err
            );

            return res.status(500).json({
                success: false,
                error:
                    "Failed to process webhook"
            });
        }
    }
);

/* =========================
   ORDER SHIPPED WEBHOOK
========================= */

router.post(

    "/order-shipped",

    async (req, res) => {

        try {

            /* =========================
               VERIFY SIGNATURE
            ========================= */

            const isValid =
                verifySignature(req);

            if (!isValid) {

                return res.status(401).json({

                    success: false,

                    error:
                        "Invalid signature"
                });
            }

            /* =========================
               PARSE BODY
            ========================= */

            const body = JSON.parse(
                req.body.toString("utf8")
            );

            /* =========================
               EVENT TYPE CHECK
            ========================= */

            if (
                body.eventType !==
                "order.shipped"
            ) {

                return res.status(200).json({

                    success: true,

                    ignored: true
                });
            }

            /* =========================
               WEBHOOK ID
            ========================= */

            const webhookId =
                body.id;

            /* =========================
               DUPLICATE PROTECTION
            ========================= */

            const redisKey =
                `myze:webhook:${webhookId}`;

            const alreadyProcessed =
                await getCache(redisKey);

            if (alreadyProcessed) {

                console.log(

                    `⚠️ Duplicate Myze webhook: ${webhookId}`

                );

                return res.status(200).json({

                    success: true,

                    duplicate: true
                });
            }

            /* =========================
               STORE WEBHOOK IN REDIS
            ========================= */

            await setCache(

                redisKey,

                {
                    processed: true
                },

                60 * 60 * 24 * 7
            );

            /* =========================
               ORDER DATA
            ========================= */

            const orderData =
                body.data;

            /* =========================
               SHOPIFY ORDER ID
            ========================= */

            const shopifyOrderId =
                orderData.externalId;

            if (!shopifyOrderId) {

                throw new Error(
                    "Missing Shopify order ID"
                );
            }

            /* =========================
               SHIPMENT INFO
            ========================= */

            const shipmentInfo =
                orderData.shipmentInfo || {};

            const trackingNumber =
                shipmentInfo.trackingCode || "";

            const trackingUrl =
                shipmentInfo.trackingUrl || "";

            const carrier =
                shipmentInfo.carrier || "";

            /* =========================
               LOG
            ========================= */

            console.log(

                `📦 Myze shipped Shopify order ${shopifyOrderId}`

            );

            /* =========================
               CREATE SHOPIFY FULFILLMENT
            ========================= */

            await createShopifyFulfillment({

                shopifyOrderId,

                trackingNumber,

                trackingUrl,

                carrier
            });

            /* =========================
               SUCCESS
            ========================= */

            console.log(

                `✅ Shopify order fulfilled ${shopifyOrderId}`

            );

            return res.status(200).json({

                success: true
            });

        } catch (err) {

            console.error(

                "❌ Myze shipped webhook error:",

                err
            );

            return res.status(500).json({

                success: false,

                error:
                    "Webhook processing failed"
            });
        }
    }
);

export default router;