import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";

/* =========================
   ROUTES
========================= */

import dropsRoute from "./routes/drops.js";
import klaviyoRoute from "./routes/klaviyo.js";
import contactRoute from "./routes/contact.js";
import myzeRoute from "./routes/myze.js";

/* =========================
   WEBHOOKS
========================= */

import myzeWebhook from "./webhooks/myze.js";

/* =========================
   ENV CONFIG
========================= */

dotenv.config();

/* =========================
   APP INIT
========================= */

const app = express();

/* =========================
   CORS
========================= */

// app.use(cors());

const allowedOrigins = [
    'http://127.0.0.1:9292',     // Your local dev server
    'https://officialstreetfighter.com' // Your live production domain
];

app.use(cors({
    origin: function (origin, callback) {
        // allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);

        if (allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    }
}));

/* =========================
   WEBHOOK ROUTES
   MUST COME BEFORE JSON
========================= */

app.use("/webhooks/myze", myzeWebhook);

/* =========================
   JSON BODY PARSER
   EXCLUDE WEBHOOKS
========================= */

app.use((req, res, next) => {

    if (
        req.originalUrl.startsWith("/webhooks/myze")
    ) {

        next();

    } else {

        express.json()(req, res, next);
    }
});

/* =========================
   RATE LIMITING
========================= */

const limiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute

    max: 100,

    message: {
        success: false,
        error:
            "Too many requests, please try again later"
    }
});

app.use(limiter);

/* =========================
   API ROUTES
========================= */

app.use("/drops", dropsRoute);

app.use("/klaviyo", klaviyoRoute);

app.use("/contact", contactRoute);

app.use("/myze", myzeRoute);

/* =========================
   ROOT ROUTE
========================= */

app.get("/", (req, res) => {

    res.json({
        success: true,
        message:
            "Backend is running 🚀"
    });
});

/* =========================
   404 HANDLER
========================= */

app.use((req, res) => {

    res.status(404).json({
        success: false,
        error: "Route not found"
    });
});

/* =========================
   GLOBAL ERROR HANDLER
========================= */

app.use((err, req, res, next) => {

    console.error(
        "Global server error:",
        err
    );

    res.status(500).json({
        success: false,
        error: "Internal server error"
    });
});

/* =========================
   START SERVER
========================= */

const PORT =
    process.env.PORT || 3000;

app.listen(PORT, () => {

    console.log(
        `🚀 Server running on port ${PORT}`
    );
});