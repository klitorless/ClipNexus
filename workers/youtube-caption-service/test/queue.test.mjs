// Deterministic tests for the caption request queue.
// No network, no Cloudflare account: KV, Queue, and the
// caption retriever are all mocked/stubbed.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequestHandler } from "../src/index.js";
import {
    createJob,
    getJob,
    publicJobStatus,
    processJobMessage,
    createJobId,
    estimateWaitSeconds,
    JOB_STATUS,
    MAX_BACKLOG
} from "../src/queue.js";

const VID = "dQw4w9WgXcQ";
const BASE = "https://clipnexus-youtube-caption-test.klitorless.workers.dev";

function createMockStore() {
    const data = new Map();
    return {
        data,
        async get(key) { return data.has(key) ? data.get(key) : null; },
        async put(key, value) { data.set(key, value); }
    };
}

function createMockQueue() {
    return {
        sent: [],
        async send(message) { this.sent.push(message); }
    };
}

function createMockMsg() {
    return {
        acked: false,
        retried: null,
        ack() { this.acked = true; },
        retry(opts) { this.retried = opts || {}; }
    };
}

function postJob(body, env) {
    const handler = createRequestHandler();
    const request = new Request(`${BASE}/caption-jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body)
    });
    return handler(request, env);
}

function getPath(path, env) {
    const handler = createRequestHandler();
    return handler(new Request(`${BASE}${path}`, { method: "GET" }), env);
}

function fullEnv() {
    return { JOB_STORE: createMockStore(), CAPTION_QUEUE: createMockQueue() };
}

const okRetrieve = (vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhello\n") =>
    async () => ({
        ok: true,
        vtt,
        meta: {
            language: "en", generated: false, source: "innertube",
            format: "xml", videoTitle: "Test Title", videoDuration: "213"
        }
    });

describe("caption job enqueue", () => {
    it("accepts a valid request with 202 and a stable job id", async () => {
        const env = fullEnv();
        const res = await postJob({ v: VID }, env);
        assert.equal(res.status, 202);
        assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
        const { job } = await res.json();
        assert.match(job.id, /^job_[a-z0-9]+_[0-9a-f]{16}$/);
        assert.equal(job.status, JOB_STATUS.QUEUED);
        assert.equal(job.videoId, VID);
        assert.equal(typeof job.positionApproximate, "number");
        // No timing data yet: the wait estimate is omitted
        // rather than invented.
        assert.equal(job.estimatedWaitSeconds, undefined);
        assert.equal(job.estimatedWaitNote, undefined);
        // The id is stable: status lookup returns the same id.
        const statusRes = await getPath(`/caption-jobs/${job.id}`, env);
        assert.equal(statusRes.status, 200);
        const { job: again } = await statusRes.json();
        assert.equal(again.id, job.id);
        // The message reached the queue.
        assert.equal(env.CAPTION_QUEUE.sent.length, 1);
        assert.equal(env.CAPTION_QUEUE.sent[0].jobId, job.id);
    });

    it("rejects invalid video ids", async () => {
        const env = fullEnv();
        for (const body of [{}, { v: "short" }, { v: "https://evil.example/x" }, { v: 123 }]) {
            const res = await postJob(body, env);
            assert.equal(res.status, 400);
            const { error } = await res.json();
            assert.equal(error.type, "invalid-video-id");
        }
        assert.equal(env.CAPTION_QUEUE.sent.length, 0);
    });

    it("rejects malformed JSON and bad lang", async () => {
        const env = fullEnv();
        const badJson = await postJob("{not json", env);
        assert.equal(badJson.status, 400);
        const badLang = await postJob({ v: VID, lang: "xx!!" }, env);
        assert.equal(badLang.status, 400);
    });

    it("answers 501 when queue bindings are missing", async () => {
        const res = await postJob({ v: VID }, {});
        assert.equal(res.status, 501);
        const { error } = await res.json();
        assert.equal(error.type, "queue-unavailable");
    });

    it("answers 429 when the backlog is full", async () => {
        const env = fullEnv();
        await env.JOB_STORE.put("queue:pending", String(MAX_BACKLOG));
        const res = await postJob({ v: VID }, env);
        assert.equal(res.status, 429);
        const { error } = await res.json();
        assert.equal(error.type, "queue-full");
        assert.equal(env.CAPTION_QUEUE.sent.length, 0);
    });

    it("wait estimate appears once timing data exists", async () => {
        const env = fullEnv();
        const { job } = await (await postJob({ v: VID }, env)).json();
        // A retrieve that takes measurable time, so the
        // completion samples the timing average.
        const slowRetrieve = async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            return okRetrieve()();
        };
        await processJobMessage(
            { jobId: job.id, videoId: VID, lang: null },
            { store: env.JOB_STORE, retrieve: slowRetrieve, msg: createMockMsg() }
        );
        const { job: second } = await (await postJob({ v: VID }, env)).json();
        assert.equal(typeof second.estimatedWaitSeconds, "number");
        assert.equal(second.estimatedWaitNote, "Estimate only — not a guarantee.");
    });

    it("failed jobs do not seed the timing average", async () => {
        const env = fullEnv();
        const { job } = await (await postJob({ v: VID }, env)).json();
        await processJobMessage(
            { jobId: job.id, videoId: VID, lang: null },
            {
                store: env.JOB_STORE,
                retrieve: async () => ({ ok: false, errorType: "transcript-unavailable" }),
                msg: createMockMsg()
            }
        );
        assert.equal(await env.JOB_STORE.get("queue:avgms"), null);
        const { job: second } = await (await postJob({ v: VID }, env)).json();
        assert.equal(second.estimatedWaitSeconds, undefined);
    });

    it("second job sees a larger backlog and position", async () => {
        const env = fullEnv();
        const first = await (await postJob({ v: VID }, env)).json();
        const second = await (await postJob({ v: VID }, env)).json();
        assert.ok(second.job.positionApproximate > first.job.positionApproximate);
        assert.ok(second.job.backlog > first.job.backlog);
    });
});

describe("caption job status", () => {
    it("unknown and malformed ids yield 404", async () => {
        const env = fullEnv();
        const missing = await getPath("/caption-jobs/job_abc_0123456789abcdef", env);
        assert.equal(missing.status, 404);
        const malformed = await getPath("/caption-jobs/not-a-job", env);
        assert.equal(malformed.status, 404);
    });

    it("status without bindings yields 501", async () => {
        const res = await getPath("/caption-jobs/job_abc_0123456789abcdef", {});
        assert.equal(res.status, 501);
    });

    it("public status exposes no secrets", async () => {
        const env = fullEnv();
        const { job } = await (await postJob({ v: VID }, env)).json();
        const { job: status } = await (await getPath(`/caption-jobs/${job.id}`, env)).json();
        const text = JSON.stringify(status).toLowerCase();
        for (const needle of ["api key", "apikey", "secret", "token", "credential", "password"]) {
            assert.ok(!text.includes(needle), `leaked: ${needle}`);
        }
    });
});

describe("queue consumer", () => {
    async function enqueuedJob(env) {
        const { job } = await (await postJob({ v: VID }, env)).json();
        return job;
    }

    it("successful processing completes the job and stores the result", async () => {
        const env = fullEnv();
        const job = await enqueuedJob(env);
        const msg = createMockMsg();
        const result = await processJobMessage(
            { jobId: job.id, videoId: VID, lang: null },
            { store: env.JOB_STORE, retrieve: okRetrieve(), msg }
        );
        assert.equal(result.outcome, "completed");
        assert.equal(msg.acked, true);
        const record = await getJob(env.JOB_STORE, job.id);
        assert.equal(record.status, JOB_STATUS.COMPLETED);
        assert.equal(record.resultMeta.language, "en");
        const vtt = await env.JOB_STORE.get(`jobresult:${job.id}`);
        assert.ok(vtt.startsWith("WEBVTT"));
        const pending = await env.JOB_STORE.get("queue:pending");
        assert.equal(pending, "0");
    });

    it("retryable failures requeue with backoff", async () => {
        const env = fullEnv();
        const job = await enqueuedJob(env);
        const msg = createMockMsg();
        const result = await processJobMessage(
            { jobId: job.id, videoId: VID, lang: null },
            {
                store: env.JOB_STORE,
                retrieve: async () => ({ ok: false, errorType: "rate-limited" }),
                msg
            }
        );
        assert.equal(result.outcome, "retried");
        assert.equal(msg.acked, false);
        assert.ok(msg.retried && typeof msg.retried.delaySeconds === "number");
        const record = await getJob(env.JOB_STORE, job.id);
        assert.equal(record.status, JOB_STATUS.QUEUED);
        assert.equal(record.attempts, 1);
        // Still pending: not decremented on retry.
        assert.equal(await env.JOB_STORE.get("queue:pending"), "1");
    });

    it("non-retryable failures fail the job", async () => {
        const env = fullEnv();
        const job = await enqueuedJob(env);
        const msg = createMockMsg();
        const result = await processJobMessage(
            { jobId: job.id, videoId: VID, lang: null },
            {
                store: env.JOB_STORE,
                retrieve: async () => ({ ok: false, errorType: "transcript-unavailable" }),
                msg
            }
        );
        assert.equal(result.outcome, "failed");
        assert.equal(msg.acked, true);
        const record = await getJob(env.JOB_STORE, job.id);
        assert.equal(record.status, JOB_STATUS.FAILED);
        assert.equal(record.errorType, "transcript-unavailable");
        assert.equal(await env.JOB_STORE.get("queue:pending"), "0");
        const { job: status } = await (await getPath(`/caption-jobs/${job.id}`, env)).json();
        assert.equal(status.status, JOB_STATUS.FAILED);
        assert.equal(typeof status.error.message, "string");
    });

    it("exhausted attempts fail instead of retrying forever", async () => {
        const env = fullEnv();
        const job = await enqueuedJob(env);
        const store = env.JOB_STORE;
        // Simulate two prior attempts.
        const raw = JSON.parse(store.data.get(`job:${job.id}`));
        raw.attempts = 2;
        store.data.set(`job:${job.id}`, JSON.stringify(raw));
        const msg = createMockMsg();
        const result = await processJobMessage(
            { jobId: job.id, videoId: VID, lang: null },
            {
                store,
                retrieve: async () => ({ ok: false, errorType: "timeout" }),
                msg
            }
        );
        assert.equal(result.outcome, "failed");
        assert.equal(msg.retried, null);
    });

    it("already-completed jobs ack without re-fetching", async () => {
        const env = fullEnv();
        const job = await enqueuedJob(env);
        let calls = 0;
        const msg = createMockMsg();
        await processJobMessage(
            { jobId: job.id, videoId: VID, lang: null },
            { store: env.JOB_STORE, retrieve: async () => { calls += 1; return okRetrieve()(); }, msg }
        );
        const msg2 = createMockMsg();
        const result = await processJobMessage(
            { jobId: job.id, videoId: VID, lang: null },
            { store: env.JOB_STORE, retrieve: async () => { calls += 1; return okRetrieve()(); }, msg: msg2 }
        );
        assert.equal(result.outcome, "acked");
        assert.equal(calls, 1);
        assert.equal(msg2.acked, true);
    });

    it("orphan messages ack without poisoning the queue", async () => {
        const env = fullEnv();
        const msg = createMockMsg();
        // Malformed id: could never have been enqueued.
        const result = await processJobMessage(
            { jobId: "not-a-job-id", videoId: VID, lang: null },
            { store: env.JOB_STORE, retrieve: okRetrieve(), msg }
        );
        assert.equal(result.outcome, "acked");
        assert.equal(msg.acked, true);
        // Malformed ids were never enqueued: counter untouched.
        assert.equal(await env.JOB_STORE.get("queue:pending"), null);
    });

    it("expired orphans resolve their pending count", async () => {
        const env = fullEnv();
        const { job } = await (await postJob({ v: VID }, env)).json();
        assert.equal(await env.JOB_STORE.get("queue:pending"), "1");
        // Simulate the 1h TTL beating the consumer.
        env.JOB_STORE.data.delete(`job:${job.id}`);
        const msg = createMockMsg();
        const result = await processJobMessage(
            { jobId: job.id, videoId: VID, lang: null },
            { store: env.JOB_STORE, retrieve: okRetrieve(), msg }
        );
        assert.equal(result.outcome, "expired");
        assert.equal(msg.acked, true);
        assert.equal(await env.JOB_STORE.get("queue:pending"), "0");
    });

    it("duplicate completion never decrements twice", async () => {
        const env = fullEnv();
        const { job } = await (await postJob({ v: VID }, env)).json();
        const run = (msg) => processJobMessage(
            { jobId: job.id, videoId: VID, lang: null },
            { store: env.JOB_STORE, retrieve: okRetrieve(), msg }
        );
        assert.equal((await run(createMockMsg())).outcome, "completed");
        assert.equal(await env.JOB_STORE.get("queue:pending"), "0");
        // A redelivered duplicate sees the terminal record.
        const dup = await run(createMockMsg());
        assert.equal(dup.outcome, "acked");
        assert.equal(await env.JOB_STORE.get("queue:pending"), "0");
    });

    it("retries never inflate the pending count", async () => {
        const env = fullEnv();
        const { job } = await (await postJob({ v: VID }, env)).json();
        const run = () => processJobMessage(
            { jobId: job.id, videoId: VID, lang: null },
            {
                store: env.JOB_STORE,
                retrieve: async () => ({ ok: false, errorType: "rate-limited" }),
                msg: createMockMsg()
            }
        );
        assert.equal((await run()).outcome, "retried");
        assert.equal(await env.JOB_STORE.get("queue:pending"), "1");
        assert.equal((await run()).outcome, "retried");
        assert.equal(await env.JOB_STORE.get("queue:pending"), "1");
    });

    it("queue.send failure answers 503 without stranding a pending job", async () => {
        const store = createMockStore();
        const failingQueue = { async send() { throw new Error("queue down"); } };
        const handler = createRequestHandler();
        const request = new Request(`${BASE}/caption-jobs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ v: VID })
        });
        const res = await handler(request, { JOB_STORE: store, CAPTION_QUEUE: failingQueue });
        assert.equal(res.status, 503);
        const { error } = await res.json();
        assert.equal(error.type, "queue-unavailable");
        // No phantom pending job left behind.
        assert.equal(await store.get("queue:pending"), "0");
    });

    it("retriever exceptions become failures, not crashes", async () => {
        const env = fullEnv();
        const job = await enqueuedJob(env);
        const msg = createMockMsg();
        const result = await processJobMessage(
            { jobId: job.id, videoId: VID, lang: null },
            {
                store: env.JOB_STORE,
                retrieve: async () => { throw new Error("boom"); },
                msg
            }
        );
        // retrieval-failure is retryable -> retried on first attempt
        assert.equal(result.outcome, "retried");
    });
});

describe("caption job result", () => {
    it("completed jobs serve WebVTT with caption headers", async () => {
        const env = fullEnv();
        const { job } = await (await postJob({ v: VID }, env)).json();
        await processJobMessage(
            { jobId: job.id, videoId: VID, lang: null },
            { store: env.JOB_STORE, retrieve: okRetrieve(), msg: createMockMsg() }
        );
        const res = await getPath(`/caption-jobs/${job.id}/result`, env);
        assert.equal(res.status, 200);
        assert.ok(res.headers.get("Content-Type").includes("text/vtt"));
        assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
        assert.equal(res.headers.get("X-Caption-Language"), "en");
        assert.equal(res.headers.get("X-Caption-Generated"), "false");
        assert.equal(res.headers.get("X-Video-Title"), encodeURIComponent("Test Title"));
        assert.equal(res.headers.get("X-Video-Duration"), "213");
        const text = await res.text();
        assert.ok(text.startsWith("WEBVTT"));
    });

    it("incomplete jobs yield 409, unknown jobs 404", async () => {
        const env = fullEnv();
        const { job } = await (await postJob({ v: VID }, env)).json();
        const pending = await getPath(`/caption-jobs/${job.id}/result`, env);
        assert.equal(pending.status, 409);
        const missing = await getPath("/caption-jobs/job_abc_0123456789abcdef/result", env);
        assert.equal(missing.status, 404);
    });
});

describe("job id utilities", () => {
    it("createJobId produces unique, well-formed ids", () => {
        const ids = new Set(Array.from({ length: 100 }, () => createJobId()));
        assert.equal(ids.size, 100);
        for (const id of ids) assert.match(id, /^job_[a-z0-9]+_[0-9a-f]{16}$/);
    });

    it("estimateWaitSeconds scales with position", () => {
        assert.equal(estimateWaitSeconds(1, 5000), 0);
        assert.equal(estimateWaitSeconds(4, 6000), 18);
        assert.ok(estimateWaitSeconds(2, null) >= 0);
    });
});
