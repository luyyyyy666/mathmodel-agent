import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Codex } from "../../server/codex.mjs";
import { Store } from "../../server/store.mjs";
import { Service } from "../../server/service.mjs";

const binary = fileURLToPath(
  new URL("../fixtures/codex-process.mjs", import.meta.url),
);
const sha256 = createHash("sha256").update(readFileSync(binary)).digest("hex");
async function until(predicate) {
  for (let count = 0; count < 300; count++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail("Expected state did not arrive");
}
function fixture(t, mode = "complete") {
  const dir = mkdtempSync(path.join(tmpdir(), "mathmodel-agent-service-"));
  const workspaceRoot = path.join(dir, "workspaces");
  const home = path.join(dir, "home");
  mkdirSync(workspaceRoot);
  mkdirSync(home);
  const store = new Store(path.join(dir, "state.sqlite"));
  const service = new Service({
    store,
    workspaceRoot,
    runtimeFactory: () =>
      new Codex({
        binary,
        sha256,
        home,
        env: { ...process.env, MATHMODEL_AGENT_FIXTURE_MODE: mode },
      }),
  });
  t.after(async () => {
    await service.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const command = (value) =>
    service.command({ idempotency_key: randomUUID(), ...value }).value;
  const project = command({ command: "create_project", name: "Example" });
  const run = command({
    command: "create_run",
    project_id: project.project_id,
    task: {
      title: "Baseline",
      prompt: "Compute",
      acceptance_criteria: ["Result is reproducible"],
    },
  });
  const update = (kind, extra = {}) =>
    command({
      command: kind,
      run_id: run.run_id,
      expected_version: store.run(run.run_id).state_version,
      ...extra,
    });
  return { service, store, project, run, update, home, workspaceRoot, dir };
}
for (const mode of ["complete", "early"]) {
  test(`${mode}: completion requires business review, event history stays ordered`, async (t) => {
    const { service, store, run, update } = fixture(t, mode);
    update("start_run");
    await until(() => store.run(run.run_id).status === "awaiting_review");
    const current = store.run(run.run_id);
    assert.equal(current.attempts[0].result, "42");
    assert.equal(current.attempts[0].turn_id, "turn-1");
    assert.equal(
      update("review_run", { decision: "accept", comment: "Verified" }).status,
      "completed",
    );
    const events = store.events(run.run_id).events;
    assert.deepEqual(
      events.map((event) => event.sequence),
      events.map((_, index) => index + 1),
    );
    await until(() => service.live.size === 0);
  });
}
test("approval is correlated, versioned, and cannot be accepted twice", async (t) => {
  const { service, store, run, update } = fixture(t, "approval");
  update("start_run");
  await until(() => store.run(run.run_id).status === "waiting_approval");
  const current = store.run(run.run_id);
  const command = {
    command: "resolve_approval",
    idempotency_key: "approval-receipt",
    run_id: run.run_id,
    expected_version: current.state_version,
    approval_id: current.approvals[0].approval_id,
    decision: "accept",
  };
  assert.throws(
    () => service.command({ ...command, expected_version: 1 }),
    /Stale/,
  );
  const first = service.command(command);
  const second = service.command(command);
  assert.deepEqual(first.value, second.value);
  assert.equal(second.replay, true);
  await until(() => store.run(run.run_id).status === "awaiting_review");
  assert.throws(
    () =>
      update("resolve_approval", {
        approval_id: command.approval_id,
        decision: "accept",
      }),
    /stale|unavailable/,
  );
});
test("cancel waits for terminal notification and preserves an attempt", async (t) => {
  const { store, run, update } = fixture(t, "hold");
  update("start_run");
  await until(() => store.run(run.run_id).status === "running");
  assert.equal(update("cancel_run").status, "cancelling");
  await until(() => store.run(run.run_id).status === "cancelled");
  assert.equal(store.run(run.run_id).attempts[0].status, "cancelled");
});
test("interrupt acknowledgment alone cannot claim cancellation", async (t) => {
  const { service, store, run, update } = fixture(t, "unconfirmed-cancel");
  update("start_run");
  await until(() => store.run(run.run_id).status === "running");
  update("cancel_run");
  await until(() => service.jobs.size === 0);
  assert.equal(store.run(run.run_id).status, "cancelling");
  await service.close();
  assert.equal(store.run(run.run_id).status, "recovery_required");
});
test("lost start reply is not replayed and blocks competing execution", async (t) => {
  const { service, store, run, update } = fixture(t, "disconnect");
  update("start_run");
  await until(
    () =>
      store.run(run.run_id).status === "recovery_required" &&
      !service.live.size,
  );
  assert.equal(store.run(run.run_id).attempts.length, 1);
  assert.throws(() => update("retry_run"), /cannot be started/);
  update("reconcile_run");
  await until(() => service.jobs.size === 0);
  assert.equal(store.run(run.run_id).status, "recovery_required");
  assert.equal(store.run(run.run_id).attempts.length, 1);
});
test("unknown interactive requests fail visibly rather than silently approving", async (t) => {
  const { store, run, update } = fixture(t, "unsupported");
  update("start_run");
  await until(() => store.run(run.run_id).status === "recovery_required");
  assert.equal(store.run(run.run_id).approvals.length, 0);
});
test("workspace symlink escape is rejected before runtime executes", (t) => {
  const { service, project, workspaceRoot, home } = fixture(t);
  symlinkSync(home, path.join(workspaceRoot, project.project_id));
  assert.throws(() => service.workspace(project.project_id), /escaped/);
});
test("rejected result retries as a new attempt without overwriting history", async (t) => {
  const { service, store, run, update } = fixture(t);
  update("start_run");
  await until(
    () =>
      store.run(run.run_id).status === "awaiting_review" && !service.live.size,
  );
  update("review_run", {
    decision: "reject",
    comment: "Need additional verification",
  });
  update("retry_run");
  await until(() => store.run(run.run_id).status === "awaiting_review");
  const attempts = store.run(run.run_id).attempts;
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].status, "rejected");
  assert.equal(attempts[1].attempt, 2);
});
test("recovery expires approvals and retains identities without dispatch", (t) => {
  const { service, store, run } = fixture(t);
  store.update(run.run_id, (current) => {
    current.status = "running";
    current.attempts.push({
      attempt: 1,
      thread_id: "t1",
      turn_id: "u1",
      status: "running",
      result: "",
      error: null,
      created_at: current.created_at,
      finished_at: null,
    });
    store.save(current, "runtime.started");
  });
  service.recover();
  const current = store.run(run.run_id);
  assert.equal(current.status, "recovery_required");
  assert.equal(current.attempts[0].turn_id, "u1");
  assert.equal(service.live.size, 0);
});

test("runtime request resolution expires the matching business approval", async (t) => {
  const { service, store, run, update } = fixture(t, "approval");
  update("start_run");
  await until(() => store.run(run.run_id).status === "waiting_approval");
  const approval = store.run(run.run_id).approvals[0];
  service.live.get(run.run_id).message({
    method: "serverRequest/resolved",
    params: {
      threadId: "thread-1",
      requestId: approval.request_id,
    },
  });
  assert.equal(store.run(run.run_id).approvals[0].status, "expired");
  assert.throws(
    () =>
      update("resolve_approval", {
        approval_id: approval.approval_id,
        decision: "accept",
      }),
    /stale|unavailable/,
  );
});

test("read-only reconciliation imports a durable terminal result without another turn", async (t) => {
  const { service, store, run, update } = fixture(t, "complete");
  update("start_run");
  await until(
    () =>
      store.run(run.run_id).status === "awaiting_review" && !service.live.size,
  );
  store.update(run.run_id, (current) => {
    current.status = "recovery_required";
    current.attempts[0].status = "recovery_required";
    current.attempts[0].result = "";
    store.save(current, "run.recovery_required");
  });
  update("reconcile_run");
  await until(
    () =>
      store.run(run.run_id).status === "awaiting_review" && !service.live.size,
  );
  assert.equal(store.run(run.run_id).attempts.length, 1);
  assert.equal(store.run(run.run_id).attempts[0].result, "42");
});

test("a local setup failure is retryable rather than an ambiguous dispatch", async (t) => {
  const { service, store, run, update } = fixture(t);
  service.runtimeFactory = () => {
    throw new Error("Missing source build");
  };
  update("start_run");
  await until(() => store.run(run.run_id).status === "failed");
  assert.equal(store.run(run.run_id).attempts[0].thread_id, null);
  assert.equal(update("retry_run").status, "queued");
});

test("failed approval delivery releases the runtime for later reconciliation", async (t) => {
  const { service, store, run, update } = fixture(t, "approval");
  update("start_run");
  await until(() => store.run(run.run_id).status === "waiting_approval");
  const approval = store.run(run.run_id).approvals[0];
  service.live.get(run.run_id).respond = () => {
    throw new Error("Broken pipe");
  };
  update("resolve_approval", {
    approval_id: approval.approval_id,
    decision: "accept",
  });
  await until(() => !service.live.size);
  assert.equal(store.run(run.run_id).status, "recovery_required");
});
