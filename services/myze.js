import fetch from "node-fetch";

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

                `https://bb6pq1fm23.execute-api.eu-central-1.amazonaws.com/tes/company/${MYZE_COMPANY_ID}/store/${MYZE_STORE_ID}/place-order`,

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
                        JSON.stringify(payload)
                }
            );

        /*
          =====================================
          RESPONSE DATA
        =====================================
        */

        const data =
            await response.json();

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

            throw new Error(
                "Failed creating Myze order"
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

        throw err;
    }
}