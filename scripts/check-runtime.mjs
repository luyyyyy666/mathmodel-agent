import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("..", import.meta.url));
const backend = process.argv[2] ?? path.join(root, "backend");
if (!backend || !path.isAbsolute(backend))
  throw new Error("Pass the absolute backend directory");
const registration = JSON.parse(
  readFileSync(path.join(root, ".runtime/runtime.json"), "utf8"),
);
if (registration.kind !== "source-build")
  throw new Error("Source build required");
const load = (name) =>
  import(pathToFileURL(path.join(backend, "server", name + ".mjs")));
const { Codex } = await load("codex");
const { Store } = await load("store");
const { Service } = await load("service");
const { createApi } = await load("http");
const dir = mkdtempSync(path.join(tmpdir(), "mathmodel-agent-source-smoke-"));
const home = path.join(dir, "codex-home");
const workspaces = path.join(dir, "workspaces");
mkdirSync(home, { mode: 0o700 });
mkdirSync(workspaces, { mode: 0o700 });
let requests = 0;
let holdModel = false;
const model = createServer(async (req, res) => {
  for await (const chunk of req) {
    void chunk;
  }
  if (!req.url.endsWith("/responses")) {
    res.writeHead(404);
    res.end();
    return;
  }
  requests++;
  res.writeHead(200, { "content-type": "text/event-stream" });
  if (holdModel) {
    res.write(
      'data: {"type":"response.created","response":{"id":"held-response"}}\n\n',
    );
    return;
  }
  const events = [
    { type: "response.created", response: { id: "smoke-response" } },
    {
      type: "response.output_item.done",
      item: {
        id: "smoke-message",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "42" }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: "smoke-response",
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end();
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
writeFileSync(
  path.join(home, "config.toml"),
  `model = "gpt-5.4"
model_provider = "local-smoke"
[model_providers.local-smoke]
name = "Local protocol smoke fixture"
base_url = "http://127.0.0.1:${model.address().port}/v1"
wire_api = "responses"
requires_openai_auth = false
`,
  { mode: 0o600 },
);
const store = new Store(path.join(dir, "state.sqlite"));
const service = new Service({
  store,
  workspaceRoot: workspaces,
  runtimeFactory: () =>
    new Codex({
      binary: registration.binary,
      sha256: registration.sha256,
      home,
      env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir },
    }),
});
const token = randomUUID();
const api = createApi({ service, token });
await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${api.address().port}`;
async function command(value) {
  const response = await fetch(base + "/v2/commands", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ idempotency_key: randomUUID(), ...value }),
  });
  assert.equal(response.status, 200);
  return (await response.json()).value;
}
try {
  const project = await command({
    command: "create_project",
    name: "Source smoke",
  });
  const run = await command({
    command: "create_run",
    project_id: project.project_id,
    task: {
      title: "Protocol smoke",
      prompt: "Reply 42; do not use tools.",
      acceptance_criteria: ["Response is exactly 42"],
    },
  });
  await command({
    command: "start_run",
    run_id: run.run_id,
    expected_version: run.state_version,
  });
  let current;
  for (let count = 0; count < 600; count++) {
    current = store.run(run.run_id);
    if (
      ["awaiting_review", "failed", "recovery_required"].includes(
        current.status,
      )
    )
      break;
    await delay(100);
  }
  assert.equal(
    current.status,
    "awaiting_review",
    JSON.stringify(current.attempts),
  );
  assert.equal(current.attempts[0].result, "42");
  const accepted = await command({
    command: "review_run",
    run_id: run.run_id,
    expected_version: current.state_version,
    decision: "accept",
    comment: "Protocol result checked",
  });
  assert.equal(accepted.status, "completed");
  assert.equal(requests, 1);
  async function until(predicate) {
    for (let count = 0; count < 600; count++) {
      if (predicate()) return;
      await delay(100);
    }
    throw new Error("Source smoke state deadline exceeded");
  }
  await until(() => service.live.size === 0);
  const reader = new Codex({
    binary: registration.binary,
    sha256: registration.sha256,
    home,
    env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir },
  });
  try {
    await reader.connect();
    const history = await reader.readThread(current.attempts[0].thread_id);
    const saved = history.thread.turns.find(
      (turn) => turn.id === current.attempts[0].turn_id,
    );
    assert.equal(saved.status, "completed");
  } finally {
    await reader.close();
  }
  holdModel = true;
  const cancellable = await command({
    command: "create_run",
    project_id: project.project_id,
    task: {
      title: "Cancellation smoke",
      prompt: "Reply 42; do not use tools.",
      acceptance_criteria: ["Execution can be interrupted"],
    },
  });
  await command({
    command: "start_run",
    run_id: cancellable.run_id,
    expected_version: cancellable.state_version,
  });
  await until(
    () => requests === 2 && store.run(cancellable.run_id).status === "running",
  );
  await command({
    command: "cancel_run",
    run_id: cancellable.run_id,
    expected_version: store.run(cancellable.run_id).state_version,
  });
  await until(() => store.run(cancellable.run_id).status === "cancelled");
  assert.equal(store.run(cancellable.run_id).attempts[0].status, "cancelled");
  const report = {
    checked_at: new Date().toISOString(),
    source_commit: registration.source_commit,
    binary_sha256: registration.sha256,
    result: "passed",
    model_transport: "local HTTP fixture",
    external_model_calls: 0,
    saved_history_read: "passed",
    cancellation: "passed",
    scope:
      "HTTP command -> SQLite -> source Codex -> local mock model -> human review",
  };
  writeFileSync(
    path.join(root, ".runtime/smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  process.stdout.write(JSON.stringify(report) + "\n");
} finally {
  api.closeIdleConnections();
  await new Promise((resolve) => api.close(resolve));
  await service.close();
  store.close();
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}
