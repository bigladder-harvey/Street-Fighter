import express from "express";

import crypto from "crypto";

import Redis from "ioredis";

import {
    createMyzeOrder
} from "../services/myze.js";

const router = express.Router();

/* =========================================
   REDIS
========================================= */

const redis =
    new Redis(
        process.env.REDIS_URL
    );

/* =========================================
   SHOPIFY WEBHOOK SECRET
========================================= */

const SHOPIFY_WEBHOOK_SECRET =
    process.env.SHOPIFY_WEBHOOK_SECRET;

/* =========================================
   RAW BODY MIDDLEWARE
========================================= */

router.use(
    express.raw({
        type: "application/json"
    })
);

/* =========================================
   VERIFY SHOPIFY WEBHOOK
========================================= */

function verifyShopifyWebhook({
    rawBody,
    signature
}) {

    const generatedSignature =
        crypto
            .createHmac(
                "sha256",
                SHOPIFY_WEBHOOK_SECRET
            )
            .update(rawBody)
            .digest("base64");

    return crypto.timingSafeEqual(

        Buffer.from(
            generatedSignature
        ),

        Buffer.from(signature)
    );
}

/* =========================================
   ORDERS PAID WEBHOOK
========================================= */

router.post(
    "/orders-paid",

    async (req, res) => {

        try {

            /*
              ===================================
              SHOPIFY HMAC
            ===================================
            */

            const signature =
                req.headers[
                "x-shopify-hmac-sha256"
                ];

            /*
              ===================================
              VERIFY WEBHOOK
            ===================================
            */

            const isValid =
                verifyShopifyWebhook({

                    rawBody: req.body,

                    signature
                });

            if (!isValid) {

                console.error(
                    "❌ Invalid Shopify webhook"
                );

                return res.status(401).send(
                    "Invalid signature"
                );
            }

            /*
              ===================================
              PARSE ORDER
            ===================================
            */

            const order =
                JSON.parse(
                    req.body.toString()
                );

            /*
              ===================================
              ORDER ID
            ===================================
            */

            const orderId =
                String(order.id);

            console.log(
                `\n🛒 Shopify Order Paid: ${order.name}`
            );

            /*
              ===================================
              DUPLICATE PROTECTION
            ===================================
            */

            const redisKey =
                `shopify_order:${orderId}`;

            const alreadyProcessed =
                await redis.get(redisKey);

            if (alreadyProcessed) {

                console.log(
                    `⏭ Order already processed: ${orderId}`
                );

                return res.status(200).send(
                    "Already processed"
                );
            }

            /*
              ===================================
              CREATE MYZE ORDER
            ===================================
            */

            const myzeResponse =
                await createMyzeOrder(
                    order
                );

            /*
              ===================================
              STORE IN REDIS
            ===================================
            */

            await redis.set(

                redisKey,

                "processed",

                /*
                  Expire after 30 days
                */

                "EX",

                60 *
                60 *
                24 *
                30
            );

            /*
              ===================================
              SUCCESS
            ===================================
            */

            console.log(
                `✅ Successfully sent order ${order.name} to Myze`
            );

            return res.status(200).json({

                success: true,

                myzeResponse
            });

        } catch (err) {

            console.error(
                "❌ Shopify webhook error:",
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