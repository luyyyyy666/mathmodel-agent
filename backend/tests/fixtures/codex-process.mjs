#!/usr/bin/env node
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const mode = process.env.MATHMODEL_AGENT_FIXTURE_MODE ?? "complete";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const notify = (method, params) => send({ method, params });
const thread = { id: "thread-1", turns: [] };
const history = path.join(process.env.CODEX_HOME, "fixture-history.json");
const complete = (status = "completed") => {
  const turn = {
    id: "turn-1",
    status,
    items: [{ type: "agentMessage", id: "item-1", text: "42" }],
  };
  thread.turns = [turn];
  writeFileSync(history, JSON.stringify(thread));
  notify("turn/completed", { threadId: thread.id, turn });
};
let initialized = false;
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (!message.method) {
    if (message.id === "approval-1") complete();
    continue;
  }
  if (message.method === "initialize") {
    if (mode === "timeout") continue;
    if (mode === "malformed") {
      process.stdout.write("not json\n");
      continue;
    }
    send({
      id: message.id,
      result: {
        userAgent: "fixture",
        backendTokenPresent: Boolean(process.env.MATHMODEL_AGENT_TOKEN),
      },
    });
  } else if (message.method === "initialized") initialized = true;
  else if (!initialized) send({ id: message.id, error: { code: -32600 } });
  else if (message.method === "thread/start")
    send({ id: message.id, result: { thread } });
  else if (message.method === "thread/read") {
    send({
      id: message.id,
      result: { thread: JSON.parse(readFileSync(history, "utf8")) },
    });
  } else if (message.method === "turn/start") {
    const turn = { id: "turn-1", status: "inProgress", items: [] };
    thread.turns = [turn];
    writeFileSync(history, JSON.stringify(thread));
    notify("turn/started", { threadId: thread.id, turn });
    if (mode === "disconnect") process.exit(0);
    if (mode === "early") complete();
    send({ id: message.id, result: { turn } });
    if (mode === "approval") {
      send({
        id: "approval-1",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: thread.id,
          turnId: turn.id,
          itemId: "command-1",
          startedAtMs: 1,
          command: "python model.py",
          cwd: "/fixture",
        },
      });
    } else if (mode === "unsupported") {
      send({ id: "input-1", method: "item/tool/requestUserInput", params: {} });
    } else if (mode === "complete") complete();
  } else if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    if (mode !== "unconfirmed-cancel") complete("interrupted");
  } else send({ id: message.id, error: { code: -32601 } });
}
