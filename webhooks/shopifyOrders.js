import crypto from "crypto";
import express from "express";
import { enqueueShopifyOrder } from "../services/shopifyOrderQueue.js";

const router = express.Router();

router.use(express.raw({ type: "application/json" }));

function verifyShopifyWebhook({ rawBody, signature }) {
    if (!signature || !process.env.SHOPIFY_WEBHOOK_SECRET) {
        return false;
    }

    const expected = crypto
        .createHmac("sha256", process.env.SHOPIFY_WEBHOOK_SECRET)
        .update(rawBody)
        .digest();

    let received;
    try {
        received = Buffer.from(signature, "base64");
    } catch {
        return false;
    }

    return received.length === expected.length &&
        crypto.timingSafeEqual(received, expected);
}

router.post("/orders-paid", async (req, res) => {
    try {
        const signature = req.get("x-shopify-hmac-sha256");

        if (!verifyShopifyWebhook({ rawBody: req.body, signature })) {
            console.error("Invalid Shopify webhook signature");
            return res.status(401).send("Invalid signature");
        }

        const order = JSON.parse(req.body.toString("utf8"));
        if (!order?.id) {
            return res.status(400).json({ success: false, error: "Missing Shopify order ID" });
        }

        const result = await enqueueShopifyOrder({
            order,
            webhookId: req.get("x-shopify-webhook-id") || null,
            eventId: req.get("x-shopify-event-id") || null
        });

        if (result.created) {
            console.log(`Shopify order queued for Myze: ${order.name || order.id}`);
        } else {
            console.log(`Duplicate Shopify paid-order delivery ignored: ${order.id}`);
        }

        return res.status(result.created ? 202 : 200).json({
            success: true,
            queued: result.created,
            duplicate: !result.created,
            status: result.status
        });
    } catch (error) {
        console.error("Shopify paid-order webhook error:", error);

        // Shopify should retry if the order could not be stored durably.
        return res.status(500).json({
            success: false,
            error: "Webhook could not be queued"
        });
    }
});

export default router;
