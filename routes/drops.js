import express from "express";
import fetch from "node-fetch";

import { getCache, setCache } from "../utils/redis.js";

const router = express.Router();

/* =========================
   SHOPIFY API HEADERS
========================= */

const headers = {
    "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
    "Content-Type": "application/json"
};

/* =========================
   FETCH COLLECTIONS
========================= */

async function fetchCollections() {
    const response = await fetch(
        `https://${process.env.SHOPIFY_STORE}/admin/api/2024-01/custom_collections.json`,
        {
            method: "GET",
            headers
        }
    );

    if (!response.ok) {
        throw new Error("Failed to fetch collections");
    }

    const data = await response.json();

    return data.custom_collections || [];
}

/* =========================
   FETCH COLLECTION PRODUCTS
========================= */

async function fetchCollectionProducts(collectionId) {
    const response = await fetch(
        `https://${process.env.SHOPIFY_STORE}/admin/api/2024-01/collections/${collectionId}/products.json`,
        {
            method: "GET",
            headers
        }
    );

    if (!response.ok) {
        throw new Error("Failed to fetch collection products");
    }

    const data = await response.json();

    return data.products || [];
}

/* =========================
   FETCH COLLECTION METAFIELDS
========================= */

async function fetchCollectionMetafields(collectionId) {
    const response = await fetch(
        `https://${process.env.SHOPIFY_STORE}/admin/api/2024-01/collections/${collectionId}/metafields.json`,
        {
            method: "GET",
            headers
        }
    );

    if (!response.ok) {
        throw new Error("Failed to fetch metafields");
    }

    const data = await response.json();

    return data.metafields || [];
}

/* =========================
   DETERMINE STATUS
========================= */

function determineStatus(dropStart, products) {
    const now = Date.now();

    // Before drop
    if (now < dropStart) {
        return "coming-soon";
    }

    // Check stock
    const hasStock = products.some(product => {
        return product.variants.some(variant => {
            return variant.inventory_quantity > 0;
        });
    });

    if (hasStock) {
        return "live";
    }

    return "archive";
}

/* =========================
   GET ALL DROPS
========================= */

async function getDrops() {

    /* =========================
       CHECK REDIS CACHE
    ========================= */

    const cachedDrops = await getCache("drops");

    if (cachedDrops) {
        console.log("⚡ Returning cached drops");
        return cachedDrops;
    }

    console.log("🛒 Fetching drops from Shopify");

    const collections = await fetchCollections();

    const drops = [];

    for (const collection of collections) {

        try {

            const metafields = await fetchCollectionMetafields(collection.id);

            // Find drop date metafield
            const dropStartField = metafields.find(field => {
                return (
                    field.namespace === "custom" &&
                    field.key === "drop_start"
                );
            });

            // Skip if no drop date
            if (!dropStartField) {
                continue;
            }

            const products = await fetchCollectionProducts(collection.id);

            const dropStart = new Date(dropStartField.value).getTime();

            const status = determineStatus(dropStart, products);

            drops.push({
                id: collection.id,
                title: collection.title,
                handle: collection.handle,
                image: collection.image?.src || null,

                dropStart,

                status,

                productCount: products.length,

                products: products.map(product => ({
                    id: product.id,
                    title: product.title,
                    handle: product.handle,
                    image: product.images?.[0]?.src || null
                }))
            });

        } catch (err) {
            console.error(
                `Error processing collection ${collection.id}:`,
                err.message
            );
        }
    }

    /* =========================
       SORT BY DROP DATE
    ========================= */

    drops.sort((a, b) => {
        return a.dropStart - b.dropStart;
    });

    /* =========================
       SAVE TO REDIS
    ========================= */

    await setCache("drops", drops, 60);

    return drops;
}

/* =========================
   GET NEXT DROP
========================= */

function getNextDrop(drops) {
    const now = Date.now();

    return drops.find(drop => {
        return drop.dropStart > now;
    }) || null;
}

/* =========================
   MAIN API ROUTE
========================= */

router.get("/", async (req, res) => {

    try {

        const drops = await getDrops();

        const nextDrop = getNextDrop(drops);

        res.json({
            success: true,

            serverTime: Date.now(),

            nextDrop,

            drops
        });

    } catch (err) {

        console.error("Drops route error:", err);

        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

export default router;
