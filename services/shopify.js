import fetch from "node-fetch";

/* =========================
   SHOPIFY CONFIG
========================= */

const SHOPIFY_STORE =
    process.env.SHOPIFY_STORE;

const SHOPIFY_API_VERSION =
    "2024-01";

const SHOPIFY_HEADERS = {
    "X-Shopify-Access-Token":
        process.env.SHOPIFY_ADMIN_TOKEN,

    "Content-Type":
        "application/json"
};

/* =========================
   SHOPIFY REQUEST HELPER
========================= */

async function shopifyRequest(
    endpoint,
    method = "GET",
    body = null
) {

    try {

        const response = await fetch(
            `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}${endpoint}`,
            {
                method,

                headers: SHOPIFY_HEADERS,

                ...(body && {
                    body: JSON.stringify(body)
                })
            }
        );

        const data = await response.json();

        if (!response.ok) {

            console.error(
                "Shopify API Error:",
                data
            );

            throw new Error(
                data.errors
                    ? JSON.stringify(data.errors)
                    : "Shopify request failed"
            );
        }

        return data;

    } catch (err) {

        console.error(
            "Shopify request error:",
            err
        );

        throw err;
    }
}

/* =========================
   CREATE PRODUCT
========================= */

export async function createProduct({
    title,
    description,
    vendor = "Myze",
    productType = "Limited Drop",
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

                vendor,

                product_type:
                    productType,

                tags: tags.join(","),

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

                    inventory_management:
                        "shopify",

                    inventory_quantity: 100
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

/* =========================
   GET COLLECTION BY HANDLE
========================= */

export async function getCollectionByHandle(
    handle
) {

    try {

        const data =
            await shopifyRequest(
                "/custom_collections.json"
            );

        const collection =
            data.custom_collections.find(
                c => c.handle === handle
            );

        return collection || null;

    } catch (err) {

        console.error(
            "Get collection error:",
            err
        );

        return null;
    }
}

/* =========================
   ADD PRODUCT TO COLLECTION
========================= */

export async function addProductToCollection({
    productId,
    collectionId
}) {

    try {

        const payload = {
            collect: {
                product_id: productId,
                collection_id: collectionId
            }
        };

        const data =
            await shopifyRequest(
                "/collects.json",
                "POST",
                payload
            );

        console.log(
            "✅ Product added to collection"
        );

        return data;

    } catch (err) {

        console.error(
            "Add to collection error:",
            err
        );

        throw err;
    }
}

/* =========================
   UPDATE INVENTORY
========================= */

export async function updateInventory({
    inventoryItemId,
    locationId,
    quantity
}) {

    try {

        const payload = {
            location_id: locationId,
            inventory_item_id:
                inventoryItemId,
            available: quantity
        };

        const data =
            await shopifyRequest(
                "/inventory_levels/set.json",
                "POST",
                payload
            );

        console.log(
            "✅ Inventory updated"
        );

        return data;

    } catch (err) {

        console.error(
            "Inventory update error:",
            err
        );

        throw err;
    }
}

/* =========================
   GET SHOPIFY LOCATIONS
========================= */

export async function getLocations() {

    try {

        const data =
            await shopifyRequest(
                "/locations.json"
            );

        return data.locations || [];

    } catch (err) {

        console.error(
            "Get locations error:",
            err
        );

        return [];
    }
}

/* =========================
   EXPORT REQUEST HELPER
========================= */

export {
    shopifyRequest
};