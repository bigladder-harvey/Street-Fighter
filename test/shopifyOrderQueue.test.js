import assert from "node:assert/strict";
import test from "node:test";
import { MyzeOrderError } from "../services/myze.js";
import { processShopifyOrderJob } from "../services/shopifyOrderQueue.js";

function createFakeClient(job) {
    const state = {
        job: JSON.stringify(job),
        removed: false,
        retry: null
    };

    return {
        state,
        async get() { return state.job; },
        async set(_key, value) { state.job = value; },
        async lrem() { state.removed = true; },
        async zadd(_key, score, orderId) { state.retry = { score, orderId }; }
    };
}

function queuedJob() {
    return {
        orderId: "123",
        order: { id: 123, order_number: 1001 },
        status: "queued",
        attempts: 0
    };
}

test("completes a queued order once Myze confirms it", async () => {
    const client = createFakeClient(queuedJob());
    let submissions = 0;

    const status = await processShopifyOrderJob({
        orderId: "123",
        client,
        now: () => 1_000,
        submitOrder: async () => {
            submissions += 1;
            return { id: "myze-1" };
        }
    });

    assert.equal(status, "completed");
    assert.equal(submissions, 1);
    assert.equal(JSON.parse(client.state.job).status, "completed");
    assert.equal(client.state.removed, true);
});

test("does not resubmit an already completed order", async () => {
    const client = createFakeClient({ ...queuedJob(), status: "completed" });
    let submissions = 0;

    const status = await processShopifyOrderJob({
        orderId: "123",
        client,
        submitOrder: async () => { submissions += 1; }
    });

    assert.equal(status, "completed");
    assert.equal(submissions, 0);
});

test("sends an uncertain Myze result to manual review without retrying", async () => {
    const client = createFakeClient(queuedJob());

    const status = await processShopifyOrderJob({
        orderId: "123",
        client,
        now: () => 2_000,
        submitOrder: async () => {
            throw new MyzeOrderError("timeout", { outcomeUnknown: true });
        }
    });

    assert.equal(status, "needs_review");
    assert.equal(JSON.parse(client.state.job).status, "needs_review");
    assert.equal(client.state.retry, null);
});

test("schedules a retry after a confirmed Myze rate limit", async () => {
    const client = createFakeClient(queuedJob());

    const status = await processShopifyOrderJob({
        orderId: "123",
        client,
        now: () => 10_000,
        submitOrder: async () => {
            throw new MyzeOrderError("rejected", {
                outcomeUnknown: false,
                retryable: true,
                status: 429
            });
        }
    });

    assert.equal(status, "retry_scheduled");
    assert.equal(JSON.parse(client.state.job).status, "retry_scheduled");
    assert.deepEqual(client.state.retry, { score: 40_000, orderId: "123" });
});

test("sends a Myze server error to review because acceptance is uncertain", async () => {
    const client = createFakeClient(queuedJob());

    const status = await processShopifyOrderJob({
        orderId: "123",
        client,
        submitOrder: async () => {
            throw new MyzeOrderError("server error", {
                outcomeUnknown: true,
                status: 503
            });
        }
    });

    assert.equal(status, "needs_review");
    assert.equal(client.state.retry, null);
});
