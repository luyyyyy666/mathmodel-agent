import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Codex } from "../../server/codex.mjs";

const binary = fileURLToPath(
  new URL("../fixtures/codex-process.mjs", import.meta.url),
);
const sha256 = createHash("sha256").update(readFileSync(binary)).digest("hex");
function fixture(t, mode) {
  const home = mkdtempSync(path.join(tmpdir(), "mathmodel-agent-rpc-"));
  const rpc = new Codex({
    binary,
    sha256,
    home,
    timeout: 15000,
    env: { ...process.env, MATHMODEL_AGENT_FIXTURE_MODE: mode },
  });
  t.after(async () => {
    await rpc.close();
    rmSync(home, { recursive: true, force: true });
  });
  return rpc;
}
test("stdio handshake, correlated calls and one-shot approval round trip", async (t) => {
  const rpc = fixture(t, "approval");
  await rpc.connect();
  const { thread } = await rpc.startThread("/fixture");
  const approval = once(rpc, "approval");
  await rpc.startTurn(thread.id, {
    title: "Test",
    prompt: "Compute",
    acceptance_criteria: ["42"],
  });
  const [request] = await approval;
  assert.equal(request.kind, "command");
  const completed = once(rpc, "notification");
  rpc.respond(request.request_id, "accept");
  assert.equal((await completed)[0].method, "turn/completed");
  assert.throws(
    () => rpc.respond(request.request_id, "accept"),
    /no longer pending/,
  );
});
test("malformed JSON closes transport and rejects pending calls", async (t) => {
  const rpc = fixture(t, "malformed");
  await assert.rejects(rpc.connect());
  assert.equal(rpc.closed, true);
});
test("request deadline poisons connection; never automatically replays", async (t) => {
  const rpc = fixture(t, "timeout");
  rpc.timeout = 100;
  await assert.rejects(rpc.connect(), /outcome may be unknown/);
  await assert.rejects(rpc.request("thread/start", {}), /disconnected/);
});
test("wrong executable digest is rejected before process launch", () => {
  assert.throws(
    () => new Codex({ binary, sha256: "0".repeat(64), home: "/tmp" }),
    /digest/,
  );
});

test("runtime-resolved approvals cannot be answered after expiration", async (t) => {
  const rpc = fixture(t, "approval");
  await rpc.connect();
  await rpc.startThread("/fixture");
  const waiting = once(rpc, "approval");
  await rpc.startTurn("thread-1", {
    title: "Test",
    prompt: "Compute",
    acceptance_criteria: ["42"],
  });
  const [approval] = await waiting;
  rpc.message({
    method: "serverRequest/resolved",
    params: {
      threadId: "thread-1",
      requestId: approval.request_id,
    },
  });
  assert.throws(
    () => rpc.respond(approval.request_id, "accept"),
    /no longer pending/,
  );
});

test("backend API credentials are not inherited by the execution process", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "mathmodel-agent-credentials-"));
  const rpc = new Codex({
    binary,
    sha256,
    home,
    env: {
      PATH: process.env.PATH,
      MATHMODEL_AGENT_TOKEN: "private-backend-credential",
    },
  });
  t.after(async () => {
    await rpc.close();
    rmSync(home, { recursive: true, force: true });
  });
  const handshake = await rpc.connect();
  assert.equal(handshake.backendTokenPresent, false);
  await assert.rejects(rpc.connect(), /cannot be reused/);
});
