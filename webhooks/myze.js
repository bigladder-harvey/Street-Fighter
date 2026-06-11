import express from "express";
import crypto from "crypto";
import { Resend } from "resend";
import {
    getCache,
    setCache
} from "../utils/redis.js";
import {
    shopifyRequest,
    createShopifyFulfillment
} from "../services/shopify.js";

/* =========================================
   RESEND CONFIG
========================================= */

const resend = new Resend(
    process.env.RESEND_API_KEY
);

const ORDER_NOTIFICATION_EMAIL =
    process.env.ORDER_NOTIFICATION_EMAIL ||
    "support@streetfighterstore.co.uk";
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

/* =========================================
   FORMAT CURRENCY
========================================= */

function formatCurrency(amount, currency) {
    if (!amount && amount !== 0) return "N/A";
    return new Intl.NumberFormat("en-GB", {
        style: "currency",
        currency: currency || "GBP"
    }).format(amount);
}

/* =========================================
   FORMAT DATE
========================================= */

function formatDate(isoString) {
    if (!isoString) return "N/A";
    return new Date(isoString).toLocaleString(
        "en-GB",
        {
            day: "2-digit",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            timeZone: "UTC",
            timeZoneName: "short"
        }
    );
}

/* =========================================
   BUILD ORDER NOTIFICATION EMAIL HTML
========================================= */

function buildOrderNotificationEmail(data) {
    const {
        id,
        externalId,
        externalOrderNumber,
        orderedVia,
        createdAt,
        totalPrice,
        recipient,
        items = []
    } = data;

    /* =========================
       ITEMS ROWS
    ========================= */
    const itemRows = items.map(item => `
        <tr>
            <td style="padding: 14px 16px; border-bottom: 1px solid #1a1a1a; vertical-align: top;">
                <div style="font-weight: 600; color: #ffffff; font-size: 14px; margin-bottom: 4px;">
                    ${item.productName || "Unknown Product"}
                </div>
                <div style="font-size: 12px; color: #888888; line-height: 1.6;">
                    ${item.productCategory ? `<span>${item.productCategory}</span> &nbsp;·&nbsp; ` : ""}
                    ${item.productBrand ? `<span>${item.productBrand}</span> &nbsp;·&nbsp; ` : ""}
                    <span>${item.productColor || ""}</span>
                    ${item.productSize ? ` &nbsp;·&nbsp; <span>Size: ${item.productSize}</span>` : ""}
                </div>
                ${item.design ? `<div style="font-size: 12px; color: #666; margin-top: 4px;">Design: ${item.design}</div>` : ""}
                ${item.productSku ? `<div style="font-size: 11px; color: #555; margin-top: 4px; font-family: monospace;">SKU: ${item.productSku}</div>` : ""}
            </td>
            <td style="padding: 14px 16px; border-bottom: 1px solid #1a1a1a; text-align: center; vertical-align: top;">
                <span style="display: inline-block; background: #1a1a1a; color: #ffffff; border-radius: 4px; padding: 4px 12px; font-size: 13px; font-weight: 600;">
                    ×${item.quantity || 1}
                </span>
            </td>
            <td style="padding: 14px 16px; border-bottom: 1px solid #1a1a1a; vertical-align: top; text-align: right;">
                <span style="font-size: 12px; color: #555; font-family: monospace;">
                    ${item.printFaces?.length ? item.printFaces.join(", ") : "—"}
                </span>
            </td>
        </tr>
    `).join("");

    /* =========================
       RECIPIENT BLOCK
    ========================= */
    const recipientLines = [
        recipient?.recipient,
        recipient?.company,
        recipient?.street,
        recipient?.supplement,
        `${recipient?.city || ""}${recipient?.state ? `, ${recipient.state}` : ""} ${recipient?.zip || ""}`.trim(),
        recipient?.country,
        recipient?.email,
        recipient?.phone
    ].filter(Boolean);

    const recipientHtml = recipientLines
        .map(line => `<div>${line}</div>`)
        .join("");

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>New Order — Street Fighter Store</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0a0a0a; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #ffffff;">

    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #0a0a0a; padding: 40px 20px;">
        <tr>
            <td align="center">
                <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; width: 100%;">

                    <!-- HEADER -->
                    <tr>
                        <td style="padding-bottom: 32px;">
                            <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                <tr>
                                    <td>
                                        <div style="font-size: 11px; letter-spacing: 3px; text-transform: uppercase; color: #555; margin-bottom: 8px;">Street Fighter Store</div>
                                        <div style="font-size: 26px; font-weight: 700; color: #ffffff; letter-spacing: -0.5px;">New Order Received</div>
                                    </td>
                                    <td align="right" style="vertical-align: top;">
                                        <div style="background: #f5c518; color: #000000; font-size: 11px; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; padding: 6px 14px; border-radius: 4px; display: inline-block;">
                                            Production
                                        </div>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>

                    <!-- DIVIDER -->
                    <tr>
                        <td style="padding-bottom: 28px;">
                            <div style="height: 1px; background: linear-gradient(to right, #f5c518, #333, #0a0a0a);"></div>
                        </td>
                    </tr>

                    <!-- ORDER META -->
                    <tr>
                        <td style="padding-bottom: 28px;">
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background: #111111; border-radius: 8px; border: 1px solid #1e1e1e; overflow: hidden;">
                                <tr>
                                    <td style="padding: 20px 24px;">
                                        <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                            <tr>
                                                <td width="50%" style="vertical-align: top; padding-bottom: 16px;">
                                                    <div style="font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: #555; margin-bottom: 6px;">Order Number</div>
                                                    <div style="font-size: 18px; font-weight: 700; color: #f5c518;">${externalOrderNumber || externalId || id}</div>
                                                </td>
                                                <td width="50%" style="vertical-align: top; padding-bottom: 16px; text-align: right;">
                                                    <div style="font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: #555; margin-bottom: 6px;">Order Total</div>
                                                    <div style="font-size: 18px; font-weight: 700; color: #ffffff;">${formatCurrency(totalPrice?.amount, totalPrice?.currency)}</div>
                                                </td>
                                            </tr>
                                            <tr>
                                                <td style="vertical-align: top;">
                                                    <div style="font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: #555; margin-bottom: 6px;">Ordered Via</div>
                                                    <div style="font-size: 13px; color: #cccccc;">${orderedVia || "Direct"}</div>
                                                </td>
                                                <td style="vertical-align: top; text-align: right;">
                                                    <div style="font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: #555; margin-bottom: 6px;">Created At</div>
                                                    <div style="font-size: 13px; color: #cccccc;">${formatDate(createdAt)}</div>
                                                </td>
                                            </tr>
                                            <tr>
                                                <td colspan="2" style="padding-top: 16px;">
                                                    <div style="font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: #555; margin-bottom: 6px;">Myze Order ID</div>
                                                    <div style="font-size: 12px; color: #555; font-family: monospace;">${id}</div>
                                                </td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>

                    <!-- ITEMS TABLE -->
                    <tr>
                        <td style="padding-bottom: 28px;">
                            <div style="font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: #555; margin-bottom: 12px;">Items to Procure</div>
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background: #111111; border-radius: 8px; border: 1px solid #1e1e1e; overflow: hidden;">
                                <!-- TABLE HEADER -->
                                <tr style="background: #161616;">
                                    <td style="padding: 10px 16px; font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: #444; border-bottom: 1px solid #1e1e1e;">Product</td>
                                    <td style="padding: 10px 16px; font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: #444; border-bottom: 1px solid #1e1e1e; text-align: center;">Qty</td>
                                    <td style="padding: 10px 16px; font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: #444; border-bottom: 1px solid #1e1e1e; text-align: right;">Print Faces</td>
                                </tr>
                                ${itemRows}
                                <!-- TOTAL ROW -->
                                <tr>
                                    <td colspan="2" style="padding: 14px 16px; text-align: right; font-size: 12px; color: #555; text-transform: uppercase; letter-spacing: 1px;">
                                        Total Items
                                    </td>
                                    <td style="padding: 14px 16px; text-align: right; font-size: 16px; font-weight: 700; color: #f5c518;">
                                        ${items.reduce((sum, i) => sum + (i.quantity || 1), 0)}
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>

                    <!-- RECIPIENT -->
                    <tr>
                        <td style="padding-bottom: 32px;">
                            <div style="font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: #555; margin-bottom: 12px;">Ship To</div>
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background: #111111; border-radius: 8px; border: 1px solid #1e1e1e;">
                                <tr>
                                    <td style="padding: 20px 24px; font-size: 13px; color: #cccccc; line-height: 1.8;">
                                        ${recipientHtml}
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>

                    <!-- DIVIDER -->
                    <tr>
                        <td style="padding-bottom: 24px;">
                            <div style="height: 1px; background: #1a1a1a;"></div>
                        </td>
                    </tr>

                    <!-- FOOTER -->
                    <tr>
                        <td style="text-align: center; font-size: 11px; color: #333; line-height: 1.8;">
                            <div>This is an automated notification from Street Fighter Store.</div>
                            <div>Order received via Myze production system.</div>
                        </td>
                    </tr>

                </table>
            </td>
        </tr>
    </table>

</body>
</html>
    `;
}

/* =========================================
   SEND ORDER NOTIFICATION EMAIL
========================================= */

async function sendOrderNotificationEmail(
    orderData
) {
    try {
        const {
            externalOrderNumber,
            externalId,
            id,
            items = []
        } = orderData;

        const orderRef =
            externalOrderNumber ||
            externalId ||
            id;

        const totalItems =
            items.reduce(
                (sum, i) => sum + (i.quantity || 1),
                0
            );

        const { data, error } =
            await resend.emails.send({
                from: process.env.RESEND_FROM_EMAIL,
                to: ORDER_NOTIFICATION_EMAIL,
                subject: `New Order: ${orderRef} — ${totalItems} item${totalItems !== 1 ? "s" : ""}`,
                html: buildOrderNotificationEmail(
                    orderData
                )
            });

        if (error) {
            console.error(
                "Resend order notification error:",
                error
            );
            return;
        }

        console.log(
            `✅ Order notification sent for ${orderRef} — email id: ${data.id}`
        );
    } catch (err) {
        console.error(
            "sendOrderNotificationEmail error:",
            err.message
        );
    }
}

/* =========================================
   CUSTOM STORE ORDER CREATED WEBHOOK
   Fires when Myze receives a new order.
   Sends a notification email to the store
   owner with full order details.
========================================= */

router.post(
    "/order-created",
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
                    error: "Invalid signature"
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
                "order.created"
            ) {
                return res.status(200).json({
                    success: true,
                    ignored: true
                });
            }

            const orderData = body.data;

            if (!orderData) {
                console.error(
                    "❌ Missing order data in payload"
                );
                return res.status(200).json({
                    success: false,
                    error: "Missing order data"
                });
            }

            console.log(
                `📦 Myze order created: ${orderData.externalOrderNumber || orderData.id}`
            );

            /* =========================
               DUPLICATE PROTECTION
            ========================= */
            const redisKey =
                `myze:order-created:${body.id}`;

            const alreadyProcessed =
                await getCache(redisKey);

            if (alreadyProcessed) {
                console.log(
                    `⏭ Already processed order created event ${body.id}`
                );
                return res.status(200).json({
                    success: true,
                    duplicate: true
                });
            }

            /* =========================
               SEND NOTIFICATION EMAIL
            ========================= */
            await sendOrderNotificationEmail(
                orderData
            );

            /* =========================
               MARK AS PROCESSED
               TTL: 30 days
            ========================= */
            await setCache(
                redisKey,
                { processed: true },
                60 * 60 * 24 * 30
            );

            return res.status(200).json({
                success: true
            });

        } catch (err) {
            console.error(
                "❌ Myze order-created webhook error:",
                err.message
            );
            return res.status(200).json({
                success: false,
                error: err.message
            });
        }
    }
);

export default router;