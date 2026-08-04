import assert from "node:assert/strict";
import test from "node:test";
import { getGoogleAccessToken } from "../src/google.mjs";

test("exchanges a signed service-account assertion for an access token", async () => {
  const calls = [];
  const token = await getGoogleAccessToken(
    {
      client_email: "synthetic-service-account@example.invalid",
      private_key: "synthetic-private-key",
    },
    {
      signJwt: async (_credentials, scope) => {
        assert.equal(scope, "https://www.googleapis.com/auth/spreadsheets");
        return "synthetic.jwt.assertion";
      },
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ access_token: "synthetic-access-token", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  );

  assert.equal(token, "synthetic-access-token");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://oauth2.googleapis.com/token");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["content-type"], "application/x-www-form-urlencoded");
  const body = new URLSearchParams(calls[0].init.body);
  assert.equal(body.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  assert.equal(body.get("assertion"), "synthetic.jwt.assertion");
});

test("does not retry a non-transient token error", async () => {
  let calls = 0;
  await assert.rejects(
    getGoogleAccessToken(
      { client_email: "synthetic@example.invalid", private_key: "synthetic" },
      {
        signJwt: async () => "synthetic.jwt.assertion",
        fetchImpl: async () => {
          calls += 1;
          return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
        },
        sleep: async () => {
          throw new Error("sleep should not be called");
        },
      },
    ),
    (error) => error.status === 400 && error.retryable === false,
  );
  assert.equal(calls, 1);
});
