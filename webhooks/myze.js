import express from "express";
import crypto from "crypto";
import {
    getCache,
    setCache
} from "../utils/redis.js";
import {
    shopifyRequest,
    createShopifyFulfillment
} from "../services/shopify.js";

const router = express.Router();

/* =========================================
   RAW BODY PARSER
   Must stay raw for HMAC verification
========================================= */

router.use(
    express.raw({
        type: "application/json"
    })
);

/* =========================================
   VERIFY MYZE SIGNATURE
========================================= */

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

/* =========================================
   RESOLVE PRODUCT TYPE FROM SKU
   sttu → t-shirts
   stsu → hoodies
   fallback → apparel
========================================= */

function resolveProductType(variants) {
    const sku =
        variants?.[0]?.sku?.toLowerCase() || "";

    if (sku.includes("sttu")) {
        return "t-shirts";
    }

    if (sku.includes("stsu")) {
        return "hoodies";
    }

    return "apparel";
}

/* =========================================
   CREATE SHOPIFY PRODUCT
   - Draft status
   - Zero stock, no inventory management
   - Only myze-{articleId} tag for sync
   - Vendor: Street Fighter Store
   - Type derived from SKU
========================================= */

async function createProduct({
    title,
    description,
    productType,
    tags = [],
    images = [],
    variants = []
}) {
    try {
        const payload = {
            product: {
                title,
                body_html:
                    description || "",
                vendor:
                    "Street Fighter Store",
                product_type:
                    productType,
                tags: tags.join(","),

                /* =========================
                   STAY DRAFT
                ========================= */
                status: "draft",

                images: images.map(src => ({
                    src
                })),

                variants: variants.map(v => ({
                    option1: v.color,
                    option2: v.size,
                    sku: v.sku,
                    price:
                        v.price?.amount || "0.00",

                    /* =========================
                       ZERO STOCK
                       No inventory_management
                       so Shopify won't block
                       purchases when stock added
                       manually later
                    ========================= */
                    inventory_quantity: 0
                })),

                options: [
                    {
                        name: "Color"
                    },
                    {
                        name: "Size"
                    }
                ]
            }
        };

        const data =
            await shopifyRequest(
                "/products.json",
                "POST",
                payload
            );

        console.log(
            "✅ Shopify product created:",
            data.product.title
        );

        return data.product;
    } catch (err) {
        console.error(
            "Create product error:",
            err
        );
        throw err;
    }
}

/* =========================================
   PUBLISH PRODUCT TO SALES CHANNELS
   Publishes to Online Store + Headless App
   Draft status is preserved — publishing
   to a channel and draft are independent
========================================= */

async function publishProductToChannels(
    productId
) {
    try {
        /* =========================
           GET ALL PUBLICATIONS
           (sales channels on store)
        ========================= */
        const publicationsData =
            await shopifyRequest(
                "/publications.json"
            );

        const publications =
            publicationsData.publications || [];

        if (!publications.length) {
            console.warn(
                "⚠ No publications found on store"
            );
            return;
        }

        /* =========================
           FILTER TO RELEVANT CHANNELS
           Online Store + any non-POS channel
           Excludes point_of_sale explicitly
        ========================= */
        const targetChannels =
            publications.filter(pub => {
                const handle =
                    pub.handle?.toLowerCase() || "";
                return (
                    handle !== "point_of_sale" &&
                    handle !== "pos"
                );
            });

        if (!targetChannels.length) {
            console.warn(
                "⚠ No non-POS channels found to publish to"
            );
            return;
        }

        /* =========================
           PUBLISH TO EACH CHANNEL
        ========================= */
        for (const channel of targetChannels) {
            try {
                await shopifyRequest(
                    `/publications/${channel.id}/product_listings.json`,
                    "POST",
                    {
                        product_listing: {
                            product_id: productId
                        }
                    }
                );

                console.log(
                    `✅ Published to channel: ${channel.name}`
                );
            } catch (err) {
                /* =========================
                   LOG BUT DON'T THROW
                   One channel failing shouldn't
                   break the whole webhook
                ========================= */
                console.error(
                    `❌ Failed to publish to channel ${channel.name}:`,
                    err.message
                );
            }
        }
    } catch (err) {
        console.error(
            "publishProductToChannels error:",
            err
        );
    }
}

/* =========================================
   ARTICLE PUBLISHED WEBHOOK
========================================= */

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

            /* =========================
               PARSE PAYLOAD
            ========================= */
            const payload =
                JSON.parse(
                    req.body.toString()
                );

            console.log(
                "🧢 Myze article-published webhook received"
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
               RESOLVE PRODUCT TYPE
               Based on first variant SKU
            ========================= */
            const productType =
                resolveProductType(variants);

            console.log(
                `📦 Product type resolved: ${productType}`
            );

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
               Deduplicated
            ========================= */
            const images = [
                ...new Set(
                    variants.map(
                        v => v.previewImageUrl
                    )
                )
            ];

            /* =========================
               CREATE SHOPIFY PRODUCT
               Only myze tag for sync —
               no extra tags
            ========================= */
            const product =
                await createProduct({
                    title: articleName,
                    description:
                        articleDescription,
                    productType,
                    tags: [
                        `myze-${articleId}`
                    ],
                    images,
                    variants: shopifyVariants
                });

            console.log(
                "✅ Shopify product created"
            );

            /* =========================
               PUBLISH TO SALES CHANNELS
               Online Store + Headless App
               Excludes POS
            ========================= */
            await publishProductToChannels(
                product.id
            );

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

/* =========================================
   ORDER SHIPPED WEBHOOK
========================================= */

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
               TTL: 7 days
            ========================= */
            await setCache(
                redisKey,
                { processed: true },
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