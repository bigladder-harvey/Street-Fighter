import express from "express";
import fetch from "node-fetch";

import { body, validationResult } from "express-validator";

const router = express.Router();

/* =========================
   VALIDATION RULES
========================= */

const validateSubscribe = [
    body("email")
        .optional()
        .isEmail()
        .withMessage("Invalid email address"),

    body("phone")
        .optional()
        .isMobilePhone()
        .withMessage("Invalid phone number")
];

/* =========================
   CREATE KLAVIYO PROFILE
========================= */

async function createProfile(email, phone) {

    const payload = {
        data: {
            type: "profile",
            attributes: {}
        }
    };

    if (email) {
        payload.data.attributes.email = email;
    }

    if (phone) {
        payload.data.attributes.phone_number = phone;
    }

    const response = await fetch(
        "https://a.klaviyo.com/api/profiles/",
        {
            method: "POST",

            headers: {
                "Authorization": `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`,
                "accept": "application/json",
                "content-type": "application/json",
                "revision": "2024-02-15"
            },

            body: JSON.stringify(payload)
        }
    );

    const data = await response.json();

    if (!response.ok) {
        throw new Error(
            data.errors?.[0]?.detail || "Failed to create profile"
        );
    }

    return data;
}

/* =========================
   ADD PROFILE TO LIST
========================= */

async function addToList(profileId, listId) {

    const response = await fetch(
        `https://a.klaviyo.com/api/lists/${listId}/relationships/profiles/`,
        {
            method: "POST",

            headers: {
                "Authorization": `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`,
                "accept": "application/json",
                "content-type": "application/json",
                "revision": "2024-02-15"
            },

            body: JSON.stringify({
                data: [
                    {
                        type: "profile",
                        id: profileId
                    }
                ]
            })
        }
    );

    if (!response.ok) {
        const errorData = await response.json();

        throw new Error(
            errorData.errors?.[0]?.detail || "Failed to add to list"
        );
    }
}

/* =========================
   SUBSCRIBE ROUTE
========================= */

router.post(
    "/subscribe",

    validateSubscribe,

    async (req, res) => {

        try {

            /* =========================
               VALIDATION CHECK
            ========================= */

            const errors = validationResult(req);

            if (!errors.isEmpty()) {
                return res.status(400).json({
                    success: false,
                    errors: errors.array()
                });
            }

            const { email, phone } = req.body;

            // Must provide at least one
            if (!email && !phone) {
                return res.status(400).json({
                    success: false,
                    error: "Email or phone is required"
                });
            }

            console.log("📨 New Klaviyo signup:", {
                email,
                phone
            });

            /* =========================
               CREATE PROFILE
            ========================= */

            const profile = await createProfile(email, phone);

            const profileId = profile.data.id;

            /* =========================
               OPTIONAL LIST ADD
            ========================= */

            // Add to your Klaviyo list if provided
            if (process.env.KLAVIYO_LIST_ID) {

                await addToList(
                    profileId,
                    process.env.KLAVIYO_LIST_ID
                );
            }

            /* =========================
               SUCCESS RESPONSE
            ========================= */

            res.json({
                success: true,
                message: "Successfully subscribed"
            });

        } catch (err) {

            console.error("Klaviyo route error:", err.message);

            res.status(500).json({
                success: false,
                error: err.message
            });
        }
    }
);

export default router;
