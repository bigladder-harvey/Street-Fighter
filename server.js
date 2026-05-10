import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";

import dropsRoute from "./routes/drops.js";
import klaviyoRoute from "./routes/klaviyo.js";
import contactRoute from "./routes/contact.js";
import myzeRoute from "./routes/myze.js";

dotenv.config();

const app = express();

app.use(cors());

// Parse JSON body
app.use(express.json());

const limiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 100, // max 100 requests per IP
    message: {
        error: "Too many requests, please try again later"
    }
});

app.use(limiter);

app.use("/drops", dropsRoute);
app.use("/klaviyo", klaviyoRoute);
app.use("/contact", contactRoute);
app.use("/myze", myzeRoute);

app.get("/", (req, res) => {
    res.json({
        status: "Backend is running 🚀"
    });
});

app.use((err, req, res, next) => {
    console.error("Error:", err);

    res.status(500).json({
        error: "Internal server error"
    });
});


const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});