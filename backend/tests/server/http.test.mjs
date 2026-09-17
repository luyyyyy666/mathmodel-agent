import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { createApi } from "../../server/http.mjs";

const token = "test-credential-".repeat(3);
async function setup(t) {
  const calls = [];
  const api = createApi({
    token,
    service: {
      command(value) {
        calls.push(value);
        return { replay: false, value };
      },
      store: {
        projects() {
          return [];
        },
      },
    },
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        api.closeIdleConnections();
        api.close(resolve);
      }),
  );
  const port = api.address().port;
  function request({
    method = "GET",
    route = "/health",
    headers = {},
    body = "",
  } = {}) {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          port,
          method,
          path: route,
          headers: { authorization: `Bearer ${token}`, ...headers },
        },
        (res) => {
          let text = "";
          res.on("data", (chunk) => {
            text += chunk;
          });
          res.on("end", () =>
            resolve({ status: res.statusCode, body: JSON.parse(text) }),
          );
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  }
  return { request, calls };
}
test("HTTP boundary rejects unauthenticated, cross-origin and rebound hosts", async (t) => {
  const { request } = await setup(t);
  assert.equal((await request()).status, 200);
  assert.equal(
    (await request({ headers: { authorization: "Bearer wrong" } })).status,
    403,
  );
  assert.equal(
    (await request({ headers: { origin: "https://example.invalid" } })).status,
    403,
  );
  assert.equal(
    (await request({ headers: { host: "example.invalid" } })).status,
    403,
  );
});
test("HTTP accepts JSON commands and rejects malformed input without executing", async (t) => {
  const { request, calls } = await setup(t);
  const base = {
    method: "POST",
    route: "/v2/commands",
    headers: { "content-type": "application/json" },
  };
  assert.equal((await request({ ...base, body: "{" })).status, 400);
  assert.equal(calls.length, 0);
  assert.equal(
    (await request({ ...base, body: '{"command":"create_project"}' })).status,
    200,
  );
  assert.equal(calls.length, 1);
});

test("oversized commands get a bounded error without dispatch", async (t) => {
  const { request, calls } = await setup(t);
  const response = await request({
    method: "POST",
    route: "/v2/commands",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: "x".repeat(70000) }),
  });
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});
