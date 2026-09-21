import redis from "../utils/redis.js";
import { createMyzeOrder, MyzeOrderError } from "./myze.js";

const QUEUE_KEY = "shopify:myze:orders:queue";
const PROCESSING_KEY = "shopify:myze:orders:processing";
const RETRY_KEY = "shopify:myze:orders:retry";
const JOB_PREFIX = "shopify:myze:order:";
const JOB_TTL_SECONDS = 90 * 24 * 60 * 60;
const MAX_ATTEMPTS = 5;
const WORKER_WAIT_SECONDS = 5;
const BASE_RETRY_DELAY_MS = 30_000;

const ENQUEUE_SCRIPT = `
if redis.call("EXISTS", KEYS[1]) == 1 then
    return 0
end
redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[2])
redis.call("RPUSH", KEYS[2], ARGV[3])
return 1
`;

function jobKey(orderId) {
    return `${JOB_PREFIX}${orderId}`;
}

function parseJob(value) {
    return value ? JSON.parse(value) : null;
}

async function writeJob(client, job) {
    job.updatedAt = new Date().toISOString();
    await client.set(jobKey(job.orderId), JSON.stringify(job), "EX", JOB_TTL_SECONDS);
}

export async function enqueueShopifyOrder({ order, webhookId, eventId }) {
    const orderId = String(order.id);
    const now = new Date().toISOString();
    const job = {
        orderId,
        order,
        webhookId,
        eventId,
        status: "queued",
        attempts: 0,
        createdAt: now,
        updatedAt: now
    };

    const created = await redis.eval(
        ENQUEUE_SCRIPT,
        2,
        jobKey(orderId),
        QUEUE_KEY,
        JSON.stringify(job),
        JOB_TTL_SECONDS,
        orderId
    );

    if (created === 1) {
        return { created: true, status: "queued" };
    }

    const existing = parseJob(await redis.get(jobKey(orderId)));
    return { created: false, status: existing?.status || "existing" };
}

function retryDelayMs(attempts) {
    return BASE_RETRY_DELAY_MS * (2 ** Math.max(0, attempts - 1));
}

async function removeFromProcessing(client, orderId) {
    await client.lrem(PROCESSING_KEY, 0, orderId);
}

export async function processShopifyOrderJob({
    orderId,
    client = redis,
    submitOrder = createMyzeOrder,
    now = () => Date.now()
}) {
    const job = parseJob(await client.get(jobKey(orderId)));

    if (!job) {
        await removeFromProcessing(client, orderId);
        return "missing";
    }

    if (["completed", "needs_review", "failed"].includes(job.status)) {
        await removeFromProcessing(client, orderId);
        return job.status;
    }

    job.status = "submitting";
    job.attempts += 1;
    job.submissionStartedAt = new Date(now()).toISOString();
    await writeJob(client, job);

    try {
        const myzeResponse = await submitOrder(job.order);
        job.status = "completed";
        job.completedAt = new Date(now()).toISOString();
        job.myzeResponse = myzeResponse;
        delete job.lastError;
        await writeJob(client, job);
        await removeFromProcessing(client, orderId);
        return "completed";
    } catch (error) {
        job.lastError = error.message;
        job.lastFailedAt = new Date(now()).toISOString();

        if (!(error instanceof MyzeOrderError) || error.outcomeUnknown) {
            // Myze may have accepted the order before the connection failed.
            // Never retry an uncertain result automatically.
            job.status = "needs_review";
            await writeJob(client, job);
            await removeFromProcessing(client, orderId);
            console.error(`Myze outcome unknown for Shopify order ${orderId}; manual review required`);
            return "needs_review";
        }

        if (!error.retryable || job.attempts >= MAX_ATTEMPTS) {
            job.status = "failed";
            await writeJob(client, job);
            await removeFromProcessing(client, orderId);
            console.error(`Myze rejected Shopify order ${orderId} after ${job.attempts} attempts`);
            return "failed";
        }

        const retryAt = now() + retryDelayMs(job.attempts);
        job.status = "retry_scheduled";
        job.retryAt = new Date(retryAt).toISOString();
        await writeJob(client, job);
        await client.zadd(RETRY_KEY, retryAt, orderId);
        await removeFromProcessing(client, orderId);
        return "retry_scheduled";
    }
}

async function promoteDueRetries(client, now) {
    const due = await client.zrangebyscore(RETRY_KEY, 0, now);

    for (const orderId of due) {
        const removed = await client.zrem(RETRY_KEY, orderId);
        if (removed === 1) {
            await client.rpush(QUEUE_KEY, orderId);
        }
    }
}

async function recoverInterruptedJobs(client) {
    const interrupted = await client.lrange(PROCESSING_KEY, 0, -1);

    for (const orderId of interrupted) {
        const job = parseJob(await client.get(jobKey(orderId)));

        if (job?.status === "submitting") {
            job.status = "needs_review";
            job.lastError = "Worker stopped while Myze submission was in progress";
            await writeJob(client, job);
            console.error(`Interrupted Myze submission for Shopify order ${orderId}; manual review required`);
        } else if (job && !["completed", "needs_review", "failed"].includes(job.status)) {
            await client.rpush(QUEUE_KEY, orderId);
        }

        await removeFromProcessing(client, orderId);
    }
}

export function startShopifyOrderWorker() {
    const workerRedis = redis.duplicate({ maxRetriesPerRequest: null });
    let stopping = false;

    const run = async () => {
        try {
            await recoverInterruptedJobs(workerRedis);

            while (!stopping) {
                await promoteDueRetries(workerRedis, Date.now());
                const orderId = await workerRedis.brpoplpush(
                    QUEUE_KEY,
                    PROCESSING_KEY,
                    WORKER_WAIT_SECONDS
                );

                if (orderId) {
                    await processShopifyOrderJob({ orderId, client: workerRedis });
                }
            }
        } catch (error) {
            if (!stopping) {
                console.error("Shopify-to-Myze worker stopped unexpectedly:", error);
                setTimeout(run, 5_000);
            }
        }
    };

    run();
    console.log("Shopify-to-Myze order worker started");

    return () => {
        stopping = true;
        workerRedis.disconnect();
    };
}
