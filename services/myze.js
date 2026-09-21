import fetch from "node-fetch";

const MYZE_REQUEST_TIMEOUT_MS = 15_000;

export class MyzeOrderError extends Error {
    constructor(message, {
        outcomeUnknown = false,
        retryable = false,
        status = null
    } = {}) {
        super(message);
        this.name = "MyzeOrderError";
        this.outcomeUnknown = outcomeUnknown;
        this.retryable = retryable;
        this.status = status;
    }
}

/* =========================================
   MYZE CONFIG
========================================= */

const MYZE_API_KEY =
    process.env.MYZE_API_KEY;

const MYZE_STORE_ID =
    process.env.MYZE_STORE_ID;

const MYZE_COMPANY_ID =
    process.env.MYZE_COMPANY_ID;

/* =========================================
   CREATE MYZE ORDER
========================================= */

export async function createMyzeOrder(
    shopifyOrder
) {

    const controller = new AbortController();
    const timeout = setTimeout(
        () => controller.abort(),
        MYZE_REQUEST_TIMEOUT_MS
    );

    try {

        /*
          =====================================
          SHOPIFY LINE ITEMS
        =====================================
        */

        const lineItems =
            shopifyOrder.line_items || [];

        /*
          =====================================
          CONVERT LINE ITEMS
        =====================================
        */

        const myzeLineItems =
            lineItems.map(item => ({

                /*
                  Shopify SKU
                  =
                  Myze SKU
                */

                sku: item.sku,

                quantity:
                    item.quantity,

                /*
                  Optional
                */

                externalId:
                    String(item.id),

                /*
                  Price
                */

                price: {

                    amount:
                        Number(item.price),

                    currency:
                        shopifyOrder.currency || "EUR"
                }
            }));

        /*
          =====================================
          SHIPPING ADDRESS
        =====================================
        */

        const shipping =
            shopifyOrder.shipping_address;

        /*
          =====================================
          PAYMENT GATEWAY
        =====================================
        */

        const paymentMethod =
            shopifyOrder.payment_gateway_names?.join(
                ", "
            ) || "Shopify";

        /*
          =====================================
          BUILD PAYLOAD
        =====================================
        */

        const payload = {

            lineItems:
                myzeLineItems,

            /*
              Shopify order ID
            */

            externalId:
                String(shopifyOrder.id),

            /*
              Customer-facing order number
            */

            externalOrderNumber:
                String(
                    shopifyOrder.order_number
                ),

            /*
              Payment method
            */

            paymentMethod,

            /*
              Total price
            */

            totalPrice: {

                amount:
                    Number(
                        shopifyOrder.total_price
                    ),

                currency:
                    shopifyOrder.currency || "EUR"
            },

            /*
              Recipient
            */

            recipient: {

                recipient:
                    `${shipping.first_name || ""} ${shipping.last_name || ""}`.trim(),

                company:
                    shipping.company || "",

                country:
                    shipping.country_code,

                city:
                    shipping.city,

                street:
                    shipping.address1,

                zip:
                    shipping.zip,

                email:
                    shopifyOrder.email,

                phone:
                    shipping.phone || "",

                supplement:
                    shipping.address2 || "",

                state:
                    shipping.province_code || ""
            }
        };

        /*
          =====================================
          SEND TO MYZE
        =====================================
        */

        const response =
            await fetch(

                `https://bb6pq1fm23.execute-api.eu-central-1.amazonaws.com/test/company/${MYZE_COMPANY_ID}/store/${MYZE_STORE_ID}/place-order`,

                {
                    method: "POST",

                    headers: {

                        "Content-Type":
                            "application/json",

                        /*
                          Myze auth
                        */

                        "x-accesstoken":
                            MYZE_API_KEY
                    },

                    body:
                        JSON.stringify(payload),

                    signal:
                        controller.signal
                }
            );

        /*
          =====================================
          RESPONSE DATA
        =====================================
        */

        const responseText = await response.text();
        let data = null;

        try {
            data = responseText ? JSON.parse(responseText) : {};
        } catch {
            throw new MyzeOrderError(
                "Myze returned an unreadable response",
                { outcomeUnknown: response.ok, status: response.status }
            );
        }

        /*
          =====================================
          ERROR HANDLING
        =====================================
        */

        if (!response.ok) {

            console.error(
                "Myze API Error:",
                data
            );

            throw new MyzeOrderError(
                "Myze rejected the order",
                {
                    // A server error can be returned after work was committed.
                    // Treat it as uncertain unless Myze documents otherwise.
                    outcomeUnknown: response.status >= 500 || response.status === 408,
                    retryable: response.status === 429,
                    status: response.status
                }
            );
        }

        /*
          =====================================
          SUCCESS
        =====================================
        */

        console.log(
            `✅ Myze order created for Shopify order ${shopifyOrder.order_number}`
        );

        return data;

    } catch (err) {

        console.error(
            "Create Myze order failed:",
            err
        );

        if (err instanceof MyzeOrderError) {
            throw err;
        }

        throw new MyzeOrderError(
            err.name === "AbortError"
                ? "Myze request timed out"
                : "Myze request failed before its result was known",
            { outcomeUnknown: true }
        );
    } finally {
        clearTimeout(timeout);
    }
}
