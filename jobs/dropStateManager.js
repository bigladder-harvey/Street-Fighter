import fetch from "node-fetch";

/* =========================================
   SHOPIFY CONFIG
========================================= */

const SHOPIFY_STORE =
    process.env.SHOPIFY_STORE;

const SHOPIFY_ADMIN_TOKEN =
    process.env.SHOPIFY_ADMIN_TOKEN;

const SHOPIFY_API_VERSION =
    "2024-01";

/* =========================================
   SHOPIFY REQUEST
========================================= */

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

                headers: {
                    "X-Shopify-Access-Token":
                        SHOPIFY_ADMIN_TOKEN,

                    "Content-Type":
                        "application/json"
                },

                ...(body && {
                    body: JSON.stringify(body)
                })
            }
        );

        const data =
            await response.json();

        if (!response.ok) {

            console.error(
                "Shopify API Error:",
                data
            );

            throw new Error(
                "Shopify request failed"
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

/* =========================================
   UPDATE COLLECTION METAFIELD
========================================= */

async function updateCollectionState({
    collectionId,
    metafieldId,
    newState
}) {

    try {

        const payload = {
            metafield: {

                id: metafieldId,

                value: newState,

                type:
                    "single_line_text_field"
            }
        };

        await shopifyRequest(
            `/metafields/${metafieldId}.json`,
            "PUT",
            payload
        );

        console.log(
            `✅ Collection ${collectionId} → ${newState}`
        );

    } catch (err) {

        console.error(
            "Failed updating collection state:",
            err
        );
    }
}

/* =========================================
   CHECK INVENTORY
========================================= */

function collectionHasInventory(
    products
) {

    if (!Array.isArray(products)) {
        return false;
    }

    for (const product of products) {

        /*
          Skip invalid products
        */

        if (
            !product ||
            !Array.isArray(product.variants)
        ) {

            console.log(
                `⚠ Invalid product variants for product ${product?.id}`
            );

            continue;
        }

        /*
          Check variants
        */

        for (const variant of product.variants) {

            /*
              Skip invalid variants
            */

            if (!variant) {
                continue;
            }

            /*
              Inventory detected
            */

            if (
                typeof variant.inventory_quantity ===
                "number" &&
                variant.inventory_quantity > 0
            ) {

                return true;
            }
        }
    }

    return false;
}

/* =========================================
   MAIN JOB
========================================= */

export async function runDropStateManager() {

    try {

        console.log(
            "🚀 Running drop state manager..."
        );

        const now =
            Date.now();

        /* =====================================
           GET COLLECTIONS
        ===================================== */

        const collectionsData =
            await shopifyRequest(
                "/custom_collections.json"
            );

        const collections =
            collectionsData.custom_collections || [];

        /* =====================================
           PROCESS COLLECTIONS
        ===================================== */

        for (const collection of collections) {

            try {

                console.log(
                    `\n📦 ${collection.title}`
                );

                /* =================================
                   GET METAFIELDS
                ================================= */

                const metafieldsData =
                    await shopifyRequest(
                        `/collections/${collection.id}/metafields.json`
                    );

                const metafields =
                    metafieldsData.metafields || [];

                /*
                  Drop start metafield
                */

                const dropStartField =
                    metafields.find(
                        field =>
                            field.namespace ===
                            "custom" &&
                            field.key ===
                            "drop_start"
                    );

                /*
                  Drop state metafield
                */

                const dropStateField =
                    metafields.find(
                        field =>
                            field.namespace ===
                            "custom" &&
                            field.key ===
                            "state"
                    );

                /*
                  Skip invalid collections
                */

                if (
                    !dropStartField ||
                    !dropStateField
                ) {

                    console.log(
                        "⏭ Missing metafields"
                    );

                    continue;
                }

                /* =================================
                   DROP DATE
                ================================= */

                const dropStart =
                    new Date(
                        dropStartField.value
                    ).getTime();

                /* =================================
                   GET PRODUCTS
                ================================= */

                const productsData =
                    await shopifyRequest(
                        `/collections/${collection.id}/products.json?fields=id,title,variants`
                    );

                const products =
                    productsData.products || [];

                /* =================================
                   INVENTORY CHECK
                ================================= */

                const hasInventory =
                    collectionHasInventory(
                        products
                    );

                /* =================================
                   DETERMINE STATE
                ================================= */

                let newState =
                    "coming-soon";

                /*
                  LIVE
                */

                if (
                    now >= dropStart &&
                    hasInventory
                ) {

                    newState = "live";
                }

                /*
                  ARCHIVE
                */

                if (
                    now >= dropStart &&
                    !hasInventory
                ) {

                    newState = "archive";
                }

                /* =================================
                   CURRENT STATE
                ================================= */

                const currentState =
                    dropStateField.value;

                /*
                  No update needed
                */

                if (
                    currentState === newState
                ) {

                    console.log(
                        `⏭ Already ${newState}`
                    );

                    continue;
                }

                /* =================================
                   UPDATE SHOPIFY METAFIELD
                ================================= */

                await updateCollectionState({

                    collectionId:
                        collection.id,

                    metafieldId:
                        dropStateField.id,

                    newState
                });

            } catch (err) {

                console.error(
                    `❌ Failed collection ${collection.id}`,
                    err
                );
            }
        }

        console.log(
            "\n✅ Drop state manager completed"
        );

    } catch (err) {

        console.error(
            "Drop state manager failed:",
            err
        );
    }
}