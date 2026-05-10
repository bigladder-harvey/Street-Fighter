import express from "express";
import nodemailer from "nodemailer";

import {
    body,
    validationResult
} from "express-validator";

const router = express.Router();

/* =========================
   EMAIL TRANSPORTER
========================= */

const transporter = nodemailer.createTransport({
    service: "gmail",

    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

/* =========================
   VALIDATION RULES
========================= */

const validateContact = [

    body("name")
        .trim()
        .notEmpty()
        .withMessage("Name is required")
        .isLength({ min: 2 })
        .withMessage("Name is too short"),

    body("email")
        .trim()
        .isEmail()
        .withMessage("Invalid email address"),

    body("message")
        .trim()
        .notEmpty()
        .withMessage("Message is required")
        .isLength({ min: 10 })
        .withMessage("Message must be at least 10 characters")
];

/* =========================
   CONTACT ROUTE
========================= */

router.post(
    "/",

    validateContact,

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
                name,
                email,
                message
            } = req.body;

            console.log("📩 New contact form submission");

            /* =========================
               EMAIL CONTENT
            ========================= */

            const mailOptions = {

                from: process.env.EMAIL_USER,

                to: process.env.EMAIL_USER,

                replyTo: email,

                subject: `New Contact Form Message from ${name}`,

                html: `
          <div style="font-family: Arial, sans-serif; line-height: 1.6;">
            
            <h2>New Contact Form Submission</h2>

            <p>
              <strong>Name:</strong><br>
              ${name}
            </p>

            <p>
              <strong>Email:</strong><br>
              ${email}
            </p>

            <p>
              <strong>Message:</strong><br>
              ${message}
            </p>

          </div>
        `
            };

            /* =========================
               SEND EMAIL
            ========================= */

            await transporter.sendMail(mailOptions);

            /* =========================
               SUCCESS RESPONSE
            ========================= */

            res.json({
                success: true,
                message: "Message sent successfully"
            });

        } catch (err) {

            console.error("Contact route error:", err.message);

            res.status(500).json({
                success: false,
                error: "Failed to send message"
            });
        }
    }
);

export default router;
