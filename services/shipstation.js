import fetch from "node-fetch";

/* =========================================
   SHIPSTATION V2 CONFIG
========================================= */

const SHIPSTATION_API_KEY =
    process.env.SHIPSTATION_API_KEY;

const SHIPSTATION_BASE_URL =
    "https://api.shipstation.com/v2";

/* =========================================
   SHIPSTATION REQUEST HELPER
========================================= */

async function shipstationRequest(
    endpoint,
    method = "GET",
    body = null
) {
    try {
        const response = await fetch(
            `${SHIPSTATION_BASE_URL}${endpoint}`,
            {
                method,
                headers: {
                    "API-Key": SHIPSTATION_API_KEY,
                    "Content-Type":
                        "application/json"
                },
                ...(body && {
                    body: JSON.stringify(body)
                })
            }
        );

        /* =========================
           RATE LIMIT HANDLING
        ========================= */
        if (response.status === 429) {
            const resetIn =
                response.headers.get(
                    "X-Rate-Limit-Reset"
                ) || 10;

            console.warn(
                `⚠ ShipStation rate limited — retry in ${resetIn}s`
            );

            throw new Error(
                `ShipStation rate limited. Retry after ${resetIn}s`
            );
        }

        const data = await response.json();

        if (!response.ok) {
            console.error(
                "ShipStation API error:",
                data
            );
            throw new Error(
                data?.message ||
                "ShipStation request failed"
            );
        }

        return data;
    } catch (err) {
        console.error(
            "ShipStation request error:",
            err.message
        );
        throw err;
    }
}

/* =========================================
   CREATE SHIPMENT
   Creates a shipment in ShipStation from
   a Myze order ready for shipping.
   Returns the shipment_id.
========================================= */

export async function createShipStationShipment({
    externalOrderId,
    shopifyOrderName,
    recipient,
    items,
    warehouseId
}) {
    const payload = {
        /* =========================
           LINK BACK TO SHOPIFY ORDER
           external_shipment_id lets us
           look it up later from the
           ShipStation label webhook
        ========================= */
        external_shipment_id:
            String(externalOrderId),

        /* =========================
           CREATES ORDER IN SS UI
        ========================= */
        create_sales_order: true,

        /* =========================
           SHIP FROM WAREHOUSE
           Set SHIPSTATION_WAREHOUSE_ID
           in your .env
        ========================= */
        warehouse_id:
            warehouseId ||
            process.env.SHIPSTATION_WAREHOUSE_ID,

        /* =========================
           SHIP TO ADDRESS
        ========================= */
        ship_to: {
            name: recipient.name,
            company:
                recipient.company || null,
            address_line1:
                recipient.street,
            city_locality:
                recipient.city,
            state_province:
                recipient.state || null,
            postal_code:
                recipient.zip || null,
            country_code:
                recipient.country,
            phone:
                recipient.phone || null,
            email:
                recipient.email || null
        },

        /* =========================
           ORDER ITEMS
        ========================= */
        items: items.map(item => ({
            name: item.name,
            sku: item.sku,
            quantity: item.quantity || 1,
            unit_price: item.price || 0
        })),

        /* =========================
           ORDER REFERENCE
        ========================= */
        order_number:
            shopifyOrderName ||
            String(externalOrderId)
    };

    console.log(
        `📦 Creating ShipStation shipment for order ${externalOrderId}`
    );

    const data = await shipstationRequest(
        "/v2/shipments",
        "POST",
        payload
    );

    console.log(
        `✅ ShipStation shipment created: ${data.shipment_id}`
    );

    return data;
}

/* =========================================
   GET LABEL BY SHIPMENT ID
   Used to fetch label details after
   a label is purchased in ShipStation
========================================= */

export async function getLabelByShipmentId(
    shipmentId
) {
    const data = await shipstationRequest(
        `/v2/labels?shipment_id=${shipmentId}`
    );

    const labels = data.labels || [];

    if (!labels.length) {
        return null;
    }

    /* Return most recently created label */
    return labels.sort((a, b) => {
        return (
            new Date(b.created_at) -
            new Date(a.created_at)
        );
    })[0];
}

/* =========================================
   REGISTER SHIPSTATION WEBHOOK
   One-time setup — call this once to
   register your label_purchased webhook
   with ShipStation.

   Run via:
   node -e "import('./services/shipstation.js')
     .then(m => m.registerShipStationWebhook())"
========================================= */

export async function registerShipStationWebhook() {
    const webhookUrl =
        `${process.env.SERVER_URL}/webhooks/shipstation`;

    try {
        const existing =
            await shipstationRequest(
                "/v2/environment/webhooks"
            );

        const webhooks =
            existing.webhooks || [];

        /* =========================
           CHECK IF ALREADY REGISTERED
        ========================= */
        const alreadyRegistered =
            webhooks.find(
                w => w.url === webhookUrl
            );

        if (alreadyRegistered) {
            console.log(
                "⏭ ShipStation webhook already registered:",
                webhookUrl
            );
            return alreadyRegistered;
        }

        /* =========================
           REGISTER LABEL PURCHASED
           WEBHOOK
        ========================= */
        const data =
            await shipstationRequest(
                "/v2/environment/webhooks",
                "POST",
                {
                    url: webhookUrl,
                    event: "label_purchased",
                    friendly_name:
                        "SF Label Purchased"
                }
            );

        console.log(
            "✅ ShipStation webhook registered:",
            webhookUrl
        );

        return data;
    } catch (err) {
        console.error(
            "Failed to register ShipStation webhook:",
            err.message
        );
        throw err;
    }
}