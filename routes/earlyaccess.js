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

            const { email } = req.body;

            if (!email) {
                return res.status(400).json({
                    success: false,
                    error: "Email is required"
                });
            }

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
               SEND EVENT
            ========================= */

            const {
                error: eventError
            } = await resend.events.send({

                event:
                    "early.access",

                email,
            });

            if (eventError) {

                console.error(
                    "Resend Event Error:",
                    eventError
                );
            }

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