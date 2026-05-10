import express from "express";
import fetch from "node-fetch";

import {
    body,
    validationResult
} from "express-validator";

const router = express.Router();

/* =========================
   VALIDATION RULES
========================= */

const validateMockup = [

    body("designUrl")
        .trim()
        .notEmpty()
        .withMessage("Design URL is required")
        .isURL()
        .withMessage("Invalid design URL"),

    body("productId")
        .trim()
        .notEmpty()
        .withMessage("Product ID is required")
];

/* =========================
   GENERATE MOCKUP
========================= */

router.post(
    "/generate-mockup",

    validateMockup,

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

            const {
                designUrl,
                productId
            } = req.body;

            console.log("🎨 Generating Myze mockup");

            /* =========================
               MYZE API REQUEST
            ========================= */

            const response = await fetch(
                "https://api.myze.com/mockups/generate",
                {
                    method: "POST",

                    headers: {
                        "Authorization": `Bearer ${process.env.MYZE_API_KEY}`,
                        "Content-Type": "application/json"
                    },

                    body: JSON.stringify({
                        design_url: designUrl,
                        product_id: productId
                    })
                }
            );

            const data = await response.json();

            /* =========================
               ERROR HANDLING
            ========================= */

            if (!response.ok) {

                console.error("Myze API error:", data);

                return res.status(500).json({
                    success: false,
                    error: data.message || "Failed to generate mockup"
                });
            }

            /* =========================
               SUCCESS RESPONSE
            ========================= */

            res.json({
                success: true,
                mockup: data
            });

        } catch (err) {

            console.error("Myze route error:", err.message);

            res.status(500).json({
                success: false,
                error: err.message
            });
        }
    }
);

/* =========================
   TEST ROUTE
========================= */

router.get("/test", (req, res) => {

    res.json({
        success: true,
        message: "Myze route working 🚀"
    });
});

export default router;
