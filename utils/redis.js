import Redis from "ioredis";

/* =========================
   REDIS CONNECTION
========================= */

const redis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 3
});

/* =========================
   CONNECTION EVENTS (DEBUG)
========================= */

redis.on("connect", () => {
    console.log("🟢 Redis connected");
});

redis.on("error", (err) => {
    console.error("🔴 Redis error:", err.message);
});

/* =========================
   HELPER FUNCTIONS
========================= */

// Get cached data
export async function getCache(key) {
    try {
        const data = await redis.get(key);
        return data ? JSON.parse(data) : null;
    } catch (err) {
        console.error("Redis GET error:", err.message);
        return null;
    }
}

// Set cached data
export async function setCache(key, value, ttl = 60) {
    try {
        await redis.set(key, JSON.stringify(value), "EX", ttl);
    } catch (err) {
        console.error("Redis SET error:", err.message);
    }
}

export default redis;