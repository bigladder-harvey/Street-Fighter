import fetch from "node-fetch";
import { Resend } from "resend";
import { getCache, setCache } from "../utils/redis.js";

/* =========================================
   SHOPIFY CONFIG
========================================= */

const SHOPIFY_STORE =
    process.env.SHOPIFY_STORE;
const SHOPIFY_ADMIN_TOKEN =
    process.env.SHOPIFY_ADMIN_TOKEN;
const SHOPIFY_API_VERSION =
    "2024-01";
const EMAIL_STORE_URL = 'https://streetfighterstore.co.uk';

/* =========================================
   RESEND CONFIG
========================================= */

const resend = new Resend(
    process.env.RESEND_API_KEY
);
const SEGMENT_ID =
    process.env.RESEND_SEGMENT_ID;

/* =========================================
   ERA → COLOR MAP
========================================= */

const ERA_COLOR_MAP = {
    sf2: "#f5c518",
    sf6: "#00aeef"
};

/* =========================================
   EARLY ACCESS WINDOW (20 minutes)
========================================= */

const EARLY_ACCESS_WINDOW_MS =
    20 * 60 * 1000;

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
        console.log(
            "⚠ Invalid products array"
        );
        return null;
    }

    let checkedVariants = 0;

    for (const product of products) {
        if (
            !product ||
            !Array.isArray(product.variants)
        ) {
            console.log(
                `⚠ Invalid product variants for product ${product?.id}`
            );
            continue;
        }

        for (const variant of product.variants) {
            if (!variant) {
                continue;
            }

            checkedVariants++;

            const inventory =
                Number(
                    variant.inventory_quantity || 0
                );

            if (inventory > 0) {
                console.log(
                    `✅ Inventory detected for variant ${variant.id}`
                );
                return true;
            }
        }
    }

    if (checkedVariants === 0) {
        console.log(
            "⚠ No valid variants checked"
        );
        return null;
    }

    return false;
}

/* =========================================
   SEND EARLY ACCESS EMAIL
========================================= */

async function sendEarlyAccessEmail({
    collectionId,
    collectionTitle,
    collectionHandle,
    password
}) {
    try {
        /* =========================
           CHECK IF ALREADY SENT
        ========================= */
        const redisKey =
            `earlyaccess:sent:${collectionId}`;
        const alreadySent =
            await getCache(redisKey);

        if (alreadySent) {
            console.log(
                `⏭ Early access email already sent for collection ${collectionId}`
            );
            return;
        }

        /* =========================
           BUILD COLLECTION URL
        ========================= */
        const collectionUrl =
            `${EMAIL_STORE_URL}/collections/${collectionHandle}`;

        /* =========================
           CREATE BROADCAST + SEND
           send: true sends immediately
           segmentId is the correct field
        ========================= */
        const { data, error } =
            await resend.broadcasts.create({
                segmentId: SEGMENT_ID,
                from: process.env.RESEND_FROM_EMAIL,
                subject: `Early access: ${collectionTitle} — your password inside`,
                html: `
                    <div style="font-family: Georgia, serif; max-width: 520px; margin: 0 auto; color: #111; font-size: 15px; line-height: 1.6;">
                        <p>${collectionTitle} goes live in 20 minutes. Enter your password below to unlock the drop before it opens to everyone:</p>
                        <div style="background: #f4f4f4; padding: 16px; border-radius: 6px; text-align: center; font-size: 26px; font-weight: bold; letter-spacing: 6px; margin: 24px 0; color: #111;">
                            ${password}
                        </div>
                        <p>Head to the collection page and enter the password to shop early:</p>
                        <p>
                            <a href="${collectionUrl}"
                               style="display: inline-block; background: #111; color: #fff; padding: 13px 28px; text-decoration: none; border-radius: 4px; font-size: 14px; font-weight: 600; letter-spacing: 1px;">
                                Access the Drop
                            </a>
                        </p>
                        <p>The drop opens to the public shortly after. Get in first.</p>
                        <p style="margin-top: 40px; font-size: 12px; color: #888;">
                            You're receiving this because you signed up for early access at officialstreetfighter.com.<br>
                            <a href="{{{RESEND_UNSUBSCRIBE_URL}}}" style="color: #888;">Unsubscribe</a>
                        </p>
                    </div>
                `,
                send: true
            });

        if (error) {
            console.error(
                "Resend broadcast error:",
                error
            );
            return;
        }

        /* =========================
           MARK AS SENT IN REDIS
           TTL: 7 days
        ========================= */
        await setCache(
            redisKey,
            { sent: true },
            60 * 60 * 24 * 7
        );

        console.log(
            `✅ Early access email sent for collection ${collectionId} — broadcast id: ${data.id}`
        );
    } catch (err) {
        console.error(
            "sendEarlyAccessEmail error:",
            err
        );
    }
}


/* =========================================
   UPDATE THEME ERA
========================================= */

async function updateThemeEra(eraValue) {
    try {
        const color =
            ERA_COLOR_MAP[eraValue];

        if (!color) {
            console.log(
                `⚠ Unknown era value: ${eraValue}`
            );
            return;
        }

        /* =========================
           CHECK IF UPDATE NEEDED
        ========================= */
        const redisKey = "theme:current_era";
        const cached = await getCache(redisKey);

        if (cached === color) {
            console.log(
                `⏭ Theme era already set to ${color}`
            );
            return;
        }

        /* =========================
           GET MAIN THEME
        ========================= */
        const themesData =
            await shopifyRequest(
                "/themes.json"
            );

        const mainTheme =
            themesData.themes.find(
                t => t.role === "main"
            );

        if (!mainTheme) {
            console.error(
                "❌ No main theme found"
            );
            return;
        }

        /* =========================
           GET CURRENT SETTINGS DATA
        ========================= */
        const assetData =
            await shopifyRequest(
                `/themes/${mainTheme.id}/assets.json?asset[key]=config/settings_data.json`
            );

        /* =========================
           SAFELY PARSE EXISTING JSON
           Fall back to empty current
           if file is empty or malformed
        ========================= */
        let settingsJson = { current: {} };

        try {
            const parsed = JSON.parse(
                assetData.asset.value
            );
            if (
                parsed &&
                typeof parsed === "object"
            ) {
                settingsJson = parsed;
            }
        } catch (parseErr) {
            console.warn(
                "⚠ Could not parse settings_data.json, starting fresh:",
                parseErr.message
            );
        }

        /* =========================
           ENSURE current EXISTS
        ========================= */
        if (
            !settingsJson.current ||
            typeof settingsJson.current !== "object"
        ) {
            settingsJson.current = {};
        }

        /* =========================
           PATCH ONLY current_era
           All other keys preserved
        ========================= */
        settingsJson.current.current_era = color;

        /* =========================
           SAVE BACK TO SHOPIFY
        ========================= */
        const updatedValue = JSON.stringify(
            settingsJson,
            null,
            2
        );

        await shopifyRequest(
            `/themes/${mainTheme.id}/assets.json`,
            "PUT",
            {
                asset: {
                    key: "config/settings_data.json",
                    value: updatedValue
                }
            }
        );

        /* =========================
           VERIFY WRITE SUCCEEDED
           Read back and confirm
        ========================= */
        const verifyData =
            await shopifyRequest(
                `/themes/${mainTheme.id}/assets.json?asset[key]=config/settings_data.json`
            );

        const verifyJson = JSON.parse(
            verifyData.asset.value
        );

        if (
            verifyJson?.current?.current_era !== color
        ) {
            console.error(
                `❌ Theme era write verification failed — expected ${color}, got ${verifyJson?.current?.current_era}`
            );
            return;
        }

        /* =========================
           CACHE THE NEW VALUE
        ========================= */
        await setCache(
            redisKey,
            color,
            60 * 60 * 24
        );

        console.log(
            `✅ Theme era updated and verified → ${eraValue} (${color})`
        );
    } catch (err) {
        console.error(
            "updateThemeEra error:",
            err
        );
    }
}

/* =========================================
   MAIN JOB
========================================= */

export async function runDropStateManager() {
    try {
        console.log(
            "🚀 Running drop state manager..."
        );

        const now = Date.now();

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
           TRACK ERA FOR THEME CONTROLLER
        ===================================== */
        let upcomingWithin2Days = null; // closest drop within 2 days
        let lastLimitedEra = null;      // era of most recently limited drop

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

                const dropStartField =
                    metafields.find(
                        field =>
                            field.namespace === "custom" &&
                            field.key === "drop_start"
                    );

                const dropStateField =
                    metafields.find(
                        field =>
                            field.namespace === "custom" &&
                            field.key === "state"
                    );

                const eraField =
                    metafields.find(
                        field =>
                            field.namespace === "custom" &&
                            field.key === "era"
                    );

                const passwordField =
                    metafields.find(
                        field =>
                            field.namespace === "custom" &&
                            field.key === "password"
                    );

                /* =================================
                   SKIP INVALID COLLECTIONS
                ================================= */
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
                   GET COLLECTION PRODUCTS
                ================================= */
                const collectionProductsData =
                    await shopifyRequest(
                        `/collections/${collection.id}/products.json?fields=id`
                    );

                const collectionProducts =
                    collectionProductsData.products || [];

                /* =================================
                   FETCH FULL PRODUCTS
                ================================= */
                const products = [];

                for (const item of collectionProducts) {
                    try {
                        const productData =
                            await shopifyRequest(
                                `/products/${item.id}.json`
                            );

                        if (productData.product) {
                            products.push(
                                productData.product
                            );
                        }
                    } catch (err) {
                        console.error(
                            `Failed fetching product ${item.id}`,
                            err
                        );
                    }
                }

                /* =================================
                   INVENTORY CHECK
                ================================= */
                const hasInventory =
                    collectionHasInventory(
                        products
                    );

                const currentState =
                    dropStateField.value;

                let newState = currentState;

                /* =================================
                   BEFORE DROP
                ================================= */
                if (now < dropStart) {
                    newState = "coming-soon";

                    /* =============================
                       EARLY ACCESS EMAIL
                       Fire if within 20 min window
                    ============================= */
                    const timeUntilDrop =
                        dropStart - now;

                    if (
                        timeUntilDrop <=
                        EARLY_ACCESS_WINDOW_MS &&
                        passwordField?.value
                    ) {
                        await sendEarlyAccessEmail({
                            collectionId:
                                collection.id,
                            collectionTitle:
                                collection.title,
                            collectionHandle:
                                collection.handle,
                            password:
                                passwordField.value
                        });
                    }

                    /* =============================
                       TRACK FOR THEME CONTROLLER
                       Check if within 2 days
                    ============================= */
                    const TWO_DAYS_MS =
                        2 * 24 * 60 * 60 * 1000;

                    if (
                        eraField?.value &&
                        timeUntilDrop <= TWO_DAYS_MS
                    ) {
                        if (
                            !upcomingWithin2Days ||
                            dropStart <
                            upcomingWithin2Days.dropStart
                        ) {
                            upcomingWithin2Days = {
                                dropStart,
                                era: eraField.value
                            };
                        }
                    }
                }

                /* =================================
                   AFTER DROP + INVENTORY EXISTS
                ================================= */
                else if (hasInventory === true) {
                    newState = "limited";

                    /* =============================
                       TRACK LAST LIMITED ERA
                    ============================= */
                    if (eraField?.value) {
                        if (
                            !lastLimitedEra ||
                            dropStart >
                            lastLimitedEra.dropStart
                        ) {
                            lastLimitedEra = {
                                dropStart,
                                era: eraField.value
                            };
                        }
                    }
                }

                /* =================================
                   AFTER DROP + NO INVENTORY
                ================================= */
                else if (hasInventory === false) {
                    newState = "archive";
                }

                /* =================================
                   INVENTORY CHECK FAILED
                ================================= */
                else {
                    console.log(
                        "⚠ Inventory check failed — preserving current state"
                    );
                }

                /* =================================
                   NO UPDATE NEEDED
                ================================= */
                if (currentState === newState) {
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

        /* =====================================
           THEME CONTROLLER
           Run after all collections processed
        ===================================== */
        console.log("\n🎨 Running theme controller...");

        const eraToApply =
            upcomingWithin2Days?.era ||
            lastLimitedEra?.era ||
            null;

        if (eraToApply) {
            await updateThemeEra(eraToApply);
        } else {
            console.log(
                "⏭ No era to apply to theme"
            );
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