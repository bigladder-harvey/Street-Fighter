import express from "express";
import { Resend } from "resend";

const router = express.Router();

/* =================================
   RESEND CONFIG
================================= */

const resend =
    new Resend(
        process.env.RESEND_API_KEY
    );

const SEGMENT_ID =
    process.env.RESEND_SEGMENT_ID;

/* =================================
   SUBSCRIBE
================================= */

router.post(
    "/subscribe",
    async (req, res) => {

        try {

            const {
                email
            } = req.body;

            /* =========================
               VALIDATION
            ========================= */

            if (!email) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Email is required"
                });
            }

            /* =========================
               CREATE CONTACT
            ========================= */

            const {
                data,
                error
            } = await resend.contacts.create({

                email,

                unsubscribed:
                    false,

                segments: [
                    {
                        id: SEGMENT_ID
                    }
                ]
            });

            /* =========================
               HANDLE ERRORS
            ========================= */

            if (error) {

                /*
                  Ignore duplicate contacts
                */

                if (
                    error.message
                        ?.toLowerCase()
                        .includes(
                            "already exists"
                        )
                ) {

                    return res.json({
                        success: true,
                        existing: true
                    });
                }

                console.error(
                    "Resend Error:",
                    error
                );

                return res.status(500).json({
                    success: false
                });
            }

            /* =========================
               SUCCESS
            ========================= */

            return res.json({
                success: true,
                contactId:
                    data?.id || null
            });

        } catch (err) {

            console.error(
                "Early Access error:",
                err
            );

            return res.status(500).json({
                success: false
            });
        }
    }
);

export default router;