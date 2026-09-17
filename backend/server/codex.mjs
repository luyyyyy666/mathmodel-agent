import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// One owned stdio process per active run. No terminal output parsing or RPC replay.
export class Codex extends EventEmitter {
  constructor({ binary, sha256, home, env = process.env, timeout = 30000 }) {
    super();
    if (!binary || !sha256 || !home)
      throw new Error("Codex build registration is required");
    const actual = createHash("sha256")
      .update(readFileSync(binary))
      .digest("hex");
    if (actual !== sha256) throw new Error("Codex executable digest mismatch");
    this.binary = binary;
    this.home = home;
    this.env = { ...env };
    delete this.env.MATHMODEL_AGENT_TOKEN;
    this.timeout = timeout;
    this.generation = randomUUID();
    this.pending = new Map();
    this.approvals = new Map();
    this.sequence = 0;
    this.buffer = "";
    this.closed = false;
  }
  async connect() {
    if (this.process || this.closed)
      throw new Error("Codex connection cannot be reused");
    this.process = spawn(this.binary, ["app-server", "--listen", "stdio://"], {
      env: { ...this.env, CODEX_HOME: this.home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk) => this.receive(chunk));
    // Drain stderr, but never persist credentials or arbitrary diagnostic content.
    this.process.stderr.resume();
    this.process.stdin.on("error", () =>
      this.fail(new Error("Codex input closed")),
    );
    this.process.on("error", () =>
      this.fail(new Error("Codex process could not start")),
    );
    this.exited = new Promise((resolve) => this.process.once("close", resolve));
    this.process.on("close", () =>
      this.fail(new Error("Codex connection closed")),
    );
    const initialized = await this.request("initialize", {
      clientInfo: {
        name: "mathmodel-agent",
        title: "Mathmodel Agent",
        version: "0.2.0",
      },
      capabilities: { experimentalApi: false },
    });
    this.send({ method: "initialized", params: {} });
    return initialized;
  }
  send(message) {
    if (this.closed || !this.process?.stdin.writable)
      throw new Error("Codex is disconnected");
    const encoded = JSON.stringify(message) + "\n";
    if (
      Buffer.byteLength(encoded) > 2 * 1024 * 1024 ||
      this.process.stdin.writableLength > 2 * 1024 * 1024
    ) {
      throw new Error("Codex outbound limit exceeded");
    }
    this.process.stdin.write(encoded);
  }
  request(method, params) {
    if (this.closed) return Promise.reject(new Error("Codex is disconnected"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(
          new Error(`Codex RPC timeout: ${method}; outcome may be unknown`),
        );
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        this.fail(error);
      }
    });
  }
  receive(chunk) {
    if (this.closed) return;
    try {
      this.buffer += chunk;
      // Bound even a producer that never terminates a frame.
      if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024) {
        throw new Error("Codex frame limit exceeded");
      }
      let newline;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (line.trim()) this.message(JSON.parse(line));
      }
    } catch (error) {
      this.fail(error);
    }
  }
  message(message) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      throw new Error("Invalid Codex message");
    }
    if (Object.hasOwn(message, "id") && message.method) {
      const kinds = {
        "item/commandExecution/requestApproval": "command",
        "item/fileChange/requestApproval": "file_change",
      };
      const kind = kinds[message.method];
      if (!kind) {
        this.send({
          id: message.id,
          error: {
            code: -32601,
            message:
              "This interaction is not supported by Mathmodel Agent core",
          },
        });
        throw new Error(`Unsupported Codex interaction: ${message.method}`);
      }
      if (this.approvals.size >= 100 || this.approvals.has(message.id)) {
        throw new Error("Invalid or excessive approval requests");
      }
      this.approvals.set(message.id, message.params);
      this.emit("approval", {
        kind,
        request_id: message.id,
        params: message.params,
      });
    } else if (Object.hasOwn(message, "id")) {
      const pending = this.pending.get(message.id);
      if (!pending) throw new Error("Uncorrelated Codex response");
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(new Error(`Codex RPC rejected (${message.error.code})`));
      else if (Object.hasOwn(message, "result"))
        pending.resolve(message.result);
      else pending.reject(new Error("Invalid Codex RPC response"));
    } else if (typeof message.method === "string") {
      if (message.method === "serverRequest/resolved") {
        this.approvals.delete(message.params?.requestId);
      }
      this.emit("notification", message);
    } else throw new Error("Invalid Codex message envelope");
  }
  respond(id, decision) {
    if (!this.approvals.has(id) || !["accept", "decline"].includes(decision)) {
      throw new Error("Approval is no longer pending on this connection");
    }
    this.send({ id, result: { decision } });
    this.approvals.delete(id);
  }
  startThread(cwd) {
    return this.request("thread/start", {
      cwd,
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      developerInstructions:
        "Work on the supplied modeling task. Keep calculations reproducible. " +
        "State assumptions and uncertainties. Do not declare scientific acceptance; " +
        "the caller reviews the result against explicit acceptance criteria.",
    });
  }
  startTurn(threadId, task) {
    return this.request("turn/start", {
      threadId,
      input: [
        {
          type: "text",
          text:
            `${task.title}\n\n${task.prompt}\n\nAcceptance criteria:\n` +
            task.acceptance_criteria.map((item) => `- ${item}`).join("\n"),
        },
      ],
    });
  }
  interrupt(threadId, turnId) {
    return this.request("turn/interrupt", { threadId, turnId });
  }
  readThread(threadId) {
    return this.request("thread/read", { threadId, includeTurns: true });
  }
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
    this.approvals.clear();
    this.process?.kill("SIGTERM");
    this.emit("fault", error);
  }
  async close() {
    this.fail(new Error("Codex connection closed by owner"));
    if (!this.process) return;
    const timer = setTimeout(() => this.process.kill("SIGKILL"), 2000);
    await this.exited;
    clearTimeout(timer);
  }
}
