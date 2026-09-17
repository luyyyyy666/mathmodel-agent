import assert from "node:assert/strict";
import test from "node:test";
import { validate } from "../../../server/contracts.mjs";

test("v2 task creation rejects missing acceptance criteria and unknown fields", () => {
  const value = {
    command: "create_run",
    idempotency_key: "c1",
    project_id: "p1",
    task: {
      title: "Baseline",
      prompt: "Compute a baseline",
      acceptance_criteria: ["Reproducible"],
    },
  };
  validate("command", value);
  assert.throws(() => validate("command", { ...value, cwd: "/tmp" }));
  assert.throws(() =>
    validate("command", {
      ...value,
      task: { ...value.task, acceptance_criteria: [] },
    }),
  );
});

test("mutation commands require optimistic concurrency and one-shot approval", () => {
  const value = {
    command: "resolve_approval",
    idempotency_key: "c2",
    run_id: "r1",
    expected_version: 1,
    approval_id: "a1",
    decision: "accept",
  };
  validate("command", value);
  assert.throws(() => validate("command", { ...value, expected_version: 0 }));
  assert.throws(() =>
    validate("command", { ...value, decision: "acceptForSession" }),
  );
});

test("date-time validation checks actual dates", () => {
  assert.throws(() =>
    validate("project", {
      project_id: "p1",
      name: "Project",
      created_at: "2026-02-31T12:00:00Z",
    }),
  );
});
