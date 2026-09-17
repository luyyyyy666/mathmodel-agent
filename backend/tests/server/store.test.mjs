import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Store } from "../../server/store.mjs";

const at = "2026-09-17T00:00:00Z";
function project(store) {
  store.addProject({ project_id: "p1", name: "Example", created_at: at });
}
function run() {
  return {
    contract_version: "v2",
    run_id: "r1",
    project_id: "p1",
    task: {
      title: "Baseline",
      prompt: "Compute",
      acceptance_criteria: ["Reproduce"],
    },
    status: "ready",
    state_version: 0,
    last_sequence: 0,
    attempts: [],
    approvals: [],
    review: null,
    created_at: at,
    updated_at: at,
  };
}

test("receipt and state survive restart, replay does not repeat writes", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "mathmodel-agent-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state.sqlite");
  let store = new Store(file);
  project(store);
  const command = { idempotency_key: "key", task: "example" };
  const result = store.command(command, () => store.save(run(), "run.created"));
  store.close();
  store = new Store(file);
  t.after(() => store.close());
  const replay = store.command(command, () =>
    assert.fail("must not run twice"),
  );
  assert.deepEqual(replay.value, result.value);
  assert.equal(replay.replay, true);
  assert.equal(store.events("r1").events.length, 1);
  assert.throws(
    () => store.command({ ...command, task: "changed" }, () => {}),
    /Idempotency/,
  );
});

test("transaction failure rolls back state, events and receipts", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  project(store);
  assert.throws(
    () =>
      store.command({ idempotency_key: "rollback" }, () => {
        store.save(run(), "run.created");
        throw new Error("injected");
      }),
    /injected/,
  );
  assert.equal(store.runs().length, 0);
  store.command({ idempotency_key: "rollback" }, () =>
    store.save(run(), "run.created"),
  );
  assert.equal(store.events("r1").events[0].sequence, 1);
  assert.throws(() => store.events("r1", -1), /cursor/);
  assert.throws(() => store.events("r1", 0, 501), /cursor/);
});
