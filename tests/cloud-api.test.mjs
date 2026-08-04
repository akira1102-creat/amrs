import assert from "node:assert/strict";
import test from "node:test";
import transportModule from "../cloud-api.js";

const {
  AmrsTransportError,
  createDualTransport,
} = transportModule;

const CLOUD = "https://cloud.synthetic.invalid";
const GAS = "https://gas.synthetic.invalid/exec";
const DEPLOY_ID = "synthetic-deploy-id-1234567890";

class MemoryStorage {
  #values = new Map();

  getItem(key) { return this.#values.has(key) ? this.#values.get(key) : null; }
  setItem(key, value) { this.#values.set(key, String(value)); }
  removeItem(key) { this.#values.delete(key); }
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createHarness(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    return handler(call, calls);
  };
  return { calls, fetchImpl };
}

function baseOptions(fetchImpl, extra = {}) {
  return {
    cloudflareBaseUrl: CLOUD,
    gasUrl: GAS,
    deployId: DEPLOY_ID,
    fetchImpl,
    storage: new MemoryStorage(),
    idFactory: (prefix) => `${prefix}-synthetic`,
    pollAttempts: 2,
    pollDelayMs: 0,
    ...extra,
  };
}

function requestBody(call) {
  return JSON.parse(String(call.init.body || "{}"));
}

test("GET keeps the original query and falls back to GAS on a Cloudflare network failure", async () => {
  const harness = createHarness((call) => {
    if (call.url === `${CLOUD}/session`) return jsonResponse({ success: true, token: "token-get-fallback" });
    if (call.url.startsWith(`${CLOUD}/api?`)) throw new TypeError("synthetic network failure");
    if (call.url.startsWith(GAS)) return jsonResponse({ success: true, backend: "gas", rows: [1] });
    throw new Error(`unexpected URL: ${call.url}`);
  });
  const api = createDualTransport(baseOptions(harness.fetchImpl));

  const result = await api.get("?action=dashboard&company=SCL&company=MGM");

  assert.deepEqual(result, { success: true, backend: "gas", rows: [1] });
  assert.equal(harness.calls.length, 3);
  assert.equal(harness.calls[1].url, `${CLOUD}/api?action=dashboard&company=SCL&company=MGM`);
  assert.equal(harness.calls[2].url, `${GAS}?action=dashboard&company=SCL&company=MGM`);
  assert.equal(harness.calls[2].init.method, "GET");
});

test("GET returns the Cloudflare primary response without touching GAS", async () => {
  const harness = createHarness((call) => {
    if (call.url === `${CLOUD}/session`) return jsonResponse({ success: true, token: "token-primary" });
    if (call.url === `${CLOUD}/api?action=ping`) return jsonResponse({ success: true, backend: "cloudflare" });
    throw new Error(`unexpected URL: ${call.url}`);
  });
  const api = createDualTransport(baseOptions(harness.fetchImpl));

  const result = await api.get("action=ping");

  assert.deepEqual(result, { success: true, backend: "cloudflare" });
  assert.equal(harness.calls.length, 2);
  assert.equal(harness.calls[1].init.headers.authorization, "Bearer token-primary");
});

test("POST uses GAS only after a preflight proves Cloudflare unavailable", async () => {
  const harness = createHarness((call) => {
    if (call.url === `${CLOUD}/health`) return jsonResponse({ success: false }, 503);
    if (call.url === GAS) return jsonResponse({ success: true, backend: "gas" });
    throw new Error(`unexpected URL: ${call.url}`);
  });
  const api = createDualTransport(baseOptions(harness.fetchImpl));

  const result = await api.post([{ serialNo: 42 }], { batchId: "batch-preflight" });

  assert.deepEqual(result, { success: true, backend: "gas" });
  assert.equal(harness.calls.length, 2);
  assert.equal(harness.calls[0].url, `${CLOUD}/health`);
  assert.equal(harness.calls[1].url, GAS);
  assert.equal(harness.calls[1].init.headers["content-type"], "text/plain");
  const body = requestBody(harness.calls[1]);
  assert.equal(body.action, "submitRecords");
  assert.equal(body.batchId, "batch-preflight");
  assert.equal(body.requestId, "batch-preflight");
});

test("unknown submit outcome reconciles through /submissions/:batchId and never calls GAS", async () => {
  const harness = createHarness((call) => {
    if (call.url === `${CLOUD}/health`) return jsonResponse({ success: true });
    if (call.url === `${CLOUD}/session`) return jsonResponse({ success: true, token: "token-submit" });
    if (call.url === `${CLOUD}/api`) throw new TypeError("synthetic timeout after request reached server");
    if (call.url === `${CLOUD}/submissions/batch-submit`) return jsonResponse({ success: true, status: "completed", inserted: 1 });
    throw new Error(`unexpected URL: ${call.url}`);
  });
  const api = createDualTransport(baseOptions(harness.fetchImpl));

  const result = await api.post({ action: "submitRecords", records: [{ serialNo: 7 }] }, { batchId: "batch-submit" });

  assert.deepEqual(result, { success: true, status: "completed", inserted: 1 });
  assert.equal(harness.calls.filter((call) => call.url === GAS).length, 0);
  assert.equal(harness.calls[2].init.headers["content-type"], "application/json");
  assert.equal(requestBody(harness.calls[2]).batchId, "batch-submit");
  assert.equal(requestBody(harness.calls[2]).requestId, "batch-submit");
  assert.equal(harness.calls[3].url, `${CLOUD}/submissions/batch-submit`);
});

test("unknown non-submit mutation reconciles through /operations/:requestId", async () => {
  const harness = createHarness((call) => {
    if (call.url === `${CLOUD}/health`) return jsonResponse({ success: true });
    if (call.url === `${CLOUD}/session`) return jsonResponse({ success: true, token: "token-operation" });
    if (call.url === `${CLOUD}/api`) return Promise.reject(new Error("synthetic connection reset"));
    if (call.url === `${CLOUD}/operations/request-synthetic`) return jsonResponse({ success: true, status: "succeeded", changed: 1 });
    throw new Error(`unexpected URL: ${call.url}`);
  });
  const api = createDualTransport(baseOptions(harness.fetchImpl));

  const result = await api.post({ action: "updateRecord", record: { rowNumber: 9 } }, { requestId: "request-synthetic" });

  assert.deepEqual(result, { success: true, status: "succeeded", changed: 1 });
  assert.equal(harness.calls.filter((call) => call.url === GAS).length, 0);
  assert.equal(harness.calls.at(-1).url, `${CLOUD}/operations/request-synthetic`);
});

test("a successful processing response is polled until the mutation completes", async () => {
  let apiCalls = 0;
  const harness = createHarness((call) => {
    if (call.url === `${CLOUD}/health`) return jsonResponse({ success: true });
    if (call.url === `${CLOUD}/session`) return jsonResponse({ success: true, token: "token-processing" });
    if (call.url === `${CLOUD}/api`) {
      apiCalls += 1;
      return jsonResponse({ success: true, status: "processing", operationId: "request-processing" });
    }
    if (call.url === `${CLOUD}/operations/request-processing`) {
      return jsonResponse({ success: true, status: "completed", result: { success: true, changed: 1 } });
    }
    throw new Error(`unexpected URL: ${call.url}`);
  });
  const api = createDualTransport(baseOptions(harness.fetchImpl));

  const result = await api.post({ action: "updateRecord", record: { rowNumber: 3 } }, { requestId: "request-processing" });

  assert.equal(apiCalls, 1);
  assert.equal(result.status, "completed");
  assert.equal(harness.calls.filter((call) => call.url === GAS).length, 0);
});

test("a Worker 4xx is a known mutation rejection and is not reconciled or sent to GAS", async () => {
  const harness = createHarness((call) => {
    if (call.url === `${CLOUD}/health`) return jsonResponse({ success: true });
    if (call.url === `${CLOUD}/session`) return jsonResponse({ success: true, token: "token-400" });
    if (call.url === `${CLOUD}/api`) return jsonResponse({ success: false, message: "validation failed" }, 400);
    if (call.url === GAS) return jsonResponse({ success: true, backend: "gas" });
    throw new Error(`unexpected URL: ${call.url}`);
  });
  const api = createDualTransport(baseOptions(harness.fetchImpl));

  await assert.rejects(
    api.post({ action: "updateBrokenPartsList", company: "SCL", records: [] }, { requestId: "request-400" }),
    (error) => {
      assert.equal(error.httpStatus, 400);
      assert.equal(error.unknownOutcome, false);
      assert.equal(error.retryable, false);
      return true;
    },
  );
  assert.equal(harness.calls.some((call) => call.url.includes("/operations/")), false);
  assert.equal(harness.calls.filter((call) => call.url === GAS).length, 0);
});

test("an exhausted reconciliation exposes unknownOutcome and does not cross-fallback to GAS", async () => {
  const harness = createHarness((call) => {
    if (call.url === `${CLOUD}/health`) return jsonResponse({ success: true });
    if (call.url === `${CLOUD}/session`) return jsonResponse({ success: true, token: "token-unknown" });
    if (call.url === `${CLOUD}/api`) return new Response("upstream failure", { status: 503 });
    if (call.url === `${CLOUD}/operations/request-unknown`) return jsonResponse({ success: false, status: "pending" });
    if (call.url === GAS) return jsonResponse({ success: true, backend: "gas" });
    throw new Error(`unexpected URL: ${call.url}`);
  });
  const api = createDualTransport(baseOptions(harness.fetchImpl, { pollAttempts: 2 }));

  await assert.rejects(
    api.post({ action: "updateRecord", record: { rowNumber: 10 } }, { requestId: "request-unknown" }),
    (error) => {
      assert.ok(error instanceof AmrsTransportError);
      assert.equal(error.backend, "cloudflare");
      assert.equal(error.unknownOutcome, true);
      assert.equal(error.retryable, true);
      assert.equal(error.operationId, "request-unknown");
      return true;
    },
  );
  assert.equal(harness.calls.filter((call) => call.url === GAS).length, 0);
});

test("session token is cached in memory and local storage", async () => {
  const storage = new MemoryStorage();
  let sessionCalls = 0;
  const harness = createHarness((call) => {
    if (call.url === `${CLOUD}/session`) {
      sessionCalls += 1;
      return jsonResponse({ success: true, token: "token-cached", expiresIn: 3600 });
    }
    throw new Error(`unexpected URL: ${call.url}`);
  });
  const first = createDualTransport(baseOptions(harness.fetchImpl, { storage }));

  assert.equal(await first.ensureSession(), "token-cached");
  assert.equal(await first.ensureSession(), "token-cached");
  const second = createDualTransport(baseOptions(harness.fetchImpl, { storage }));
  assert.equal(await second.ensureSession(), "token-cached");
  assert.equal(sessionCalls, 1);
});

test("session cache reads exp from the Worker payload.signature token format", async () => {
  const storage = new MemoryStorage();
  const now = 1_000_000_000;
  const exp = Math.floor(now / 1000) + 3600;
  const payload = Buffer.from(JSON.stringify({ scope: "amrs", exp }), "utf8").toString("base64url");
  const workerToken = `${payload}.synthetic-signature`;
  let sessionCalls = 0;
  const harness = createHarness((call) => {
    if (call.url === `${CLOUD}/session`) {
      sessionCalls += 1;
      return jsonResponse({ success: true, token: workerToken, expiresIn: 120 });
    }
    throw new Error(`unexpected URL: ${call.url}`);
  });
  const first = createDualTransport(baseOptions(harness.fetchImpl, { storage, now: () => now }));
  await first.ensureSession();
  const second = createDualTransport(baseOptions(harness.fetchImpl, { storage, now: () => now }));

  await second.ensureSession();

  assert.equal(sessionCalls, 1);
});

test("implicit non-submit requestId is stable for an identical mutation payload", async () => {
  const bodies = [];
  const harness = createHarness((call) => {
    if (call.url === `${CLOUD}/health`) return jsonResponse({ success: true });
    if (call.url === `${CLOUD}/session`) return jsonResponse({ success: true, token: "token-stable" });
    if (call.url === `${CLOUD}/api`) {
      bodies.push(requestBody(call));
      return jsonResponse({ success: true, changed: 1 });
    }
    throw new Error(`unexpected URL: ${call.url}`);
  });
  const api = createDualTransport(baseOptions(harness.fetchImpl));
  const payload = { action: "updateBrokenPartsList", company: "SCL", records: [{ serialNo: 42, partsNo: "AE-1" }] };

  await api.post(payload);
  await api.post({ records: payload.records, company: payload.company, action: payload.action });

  assert.equal(bodies.length, 2);
  assert.match(bodies[0].requestId, /^request-[0-9a-f]{16}$/);
  assert.equal(bodies[0].requestId, bodies[1].requestId);
});

test("submission ids produce a stable implicit batch id across retries", async () => {
  const bodies = [];
  const harness = createHarness((call) => {
    if (call.url === `${CLOUD}/health`) return jsonResponse({ success: true });
    if (call.url === `${CLOUD}/session`) return jsonResponse({ success: true, token: "token-batch" });
    if (call.url === `${CLOUD}/api`) {
      bodies.push(requestBody(call));
      return jsonResponse({ success: true, inserted: 2 });
    }
    throw new Error(`unexpected URL: ${call.url}`);
  });
  const api = createDualTransport(baseOptions(harness.fetchImpl));
  const records = [
    { submissionId: "submission-a", serialNo: 1 },
    { submissionId: "submission-b", serialNo: 2 },
  ];

  await api.post(records);
  await api.post(records.map((record) => ({ ...record })));

  assert.equal(bodies.length, 2);
  assert.match(bodies[0].batchId, /^batch-[0-9a-f]{16}$/);
  assert.equal(bodies[0].batchId, bodies[1].batchId);
  assert.equal(bodies[0].requestId, bodies[0].batchId);
});
