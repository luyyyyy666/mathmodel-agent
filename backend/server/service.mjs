import { mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DomainError, validate } from "./contracts.mjs";

const active = new Set([
  "queued",
  "starting",
  "running",
  "waiting_approval",
  "cancelling",
]);
const terminal = new Set([
  "completed",
  "failed",
  "cancelled",
  "awaiting_review",
]);
const now = () => new Date().toISOString();
const conflict = (message) => {
  throw new DomainError("conflict", message);
};

export class Service {
  constructor({ store, workspaceRoot, runtimeFactory }) {
    this.store = store;
    this.workspaceRoot = realpathSync(workspaceRoot);
    this.runtimeFactory = runtimeFactory;
    this.live = new Map();
    this.jobs = new Set();
    this.stopping = false;
  }
  recover() {
    for (const run of this.store.runs()) {
      if (active.has(run.status) && run.status !== "queued") {
        this.uncertain(
          run.run_id,
          "Service restarted; reconcile runtime history before continuing",
        );
      }
    }
    this.schedule();
  }
  workspace(projectId) {
    this.store.project(projectId);
    const directory = path.join(this.workspaceRoot, projectId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const resolved = realpathSync(directory);
    if (path.dirname(resolved) !== this.workspaceRoot) {
      throw new DomainError(
        "invalid_request",
        "Project workspace escaped its root",
      );
    }
    return resolved;
  }
  command(command) {
    validate("command", command);
    if (this.stopping)
      throw new DomainError("runtime_unavailable", "Service is stopping");
    const result = this.store.command(command, () => {
      if (command.command === "create_project") {
        const project = {
          project_id: randomUUID(),
          name: command.name,
          created_at: now(),
        };
        this.store.addProject(project);
        return project;
      }
      if (command.command === "create_run") {
        this.store.project(command.project_id);
        const at = now();
        return this.store.save(
          {
            contract_version: "v2",
            run_id: randomUUID(),
            project_id: command.project_id,
            task: command.task,
            status: "ready",
            state_version: 0,
            last_sequence: 0,
            attempts: [],
            approvals: [],
            review: null,
            created_at: at,
            updated_at: at,
          },
          "run.created",
        );
      }
      const run = this.store.run(command.run_id);
      if (run.state_version !== command.expected_version)
        conflict("Stale run version; reload state");
      switch (command.command) {
        case "start_run":
        case "retry_run": {
          const allowed =
            command.command === "start_run"
              ? ["ready"]
              : ["failed", "cancelled"];
          if (!allowed.includes(run.status))
            conflict("Run cannot be started from this state");
          if (run.attempts.length >= 1000) conflict("Attempt limit reached");
          if (
            this.live.size ||
            this.store
              .runs()
              .some(
                (other) =>
                  active.has(other.status) ||
                  other.status === "recovery_required",
              )
          ) {
            conflict("Another execution is active or needs reconciliation");
          }
          run.status = "queued";
          run.review = null;
          return this.store.save(run, "run.queued");
        }
        case "cancel_run": {
          if (["ready", "queued"].includes(run.status)) {
            run.status = "cancelled";
            return this.store.save(run, "run.cancelled");
          }
          if (
            !["starting", "running", "waiting_approval"].includes(run.status)
          ) {
            conflict("Run cannot be cancelled from this state");
          }
          run.status = "cancelling";
          this.expire(run);
          return this.store.save(run, "run.cancelling");
        }
        case "resolve_approval": {
          const approval = run.approvals.find(
            (item) => item.approval_id === command.approval_id,
          );
          const runtime = this.live.get(run.run_id);
          if (
            run.status !== "waiting_approval" ||
            approval?.status !== "pending" ||
            !runtime ||
            runtime.generation !== approval.generation ||
            !runtime.approvals.has(approval.request_id)
          )
            conflict("Approval is stale or unavailable");
          approval.status =
            command.decision === "accept" ? "accepted" : "declined";
          run.status = run.approvals.some((item) => item.status === "pending")
            ? "waiting_approval"
            : "running";
          return this.store.save(run, "approval.resolved", {
            approval_id: approval.approval_id,
            decision: command.decision,
          });
        }
        case "review_run": {
          if (run.status !== "awaiting_review")
            conflict("There is no completed result to review");
          run.review = {
            decision: command.decision,
            comment: command.comment,
            at: now(),
          };
          run.status = command.decision === "accept" ? "completed" : "failed";
          run.attempts.at(-1).status =
            command.decision === "accept" ? "completed" : "rejected";
          return this.store.save(run, "run.reviewed", run.review);
        }
        case "reconcile_run": {
          if (run.status !== "recovery_required" || this.live.size) {
            conflict(
              "Run does not need reconciliation or runtime is still connected",
            );
          }
          if (!run.attempts.at(-1)?.thread_id)
            conflict("No durable runtime identity; inspect manually");
          return this.store.save(run, "run.reconciled", {
            outcome: "inspection_requested",
          });
        }
        default:
          throw new DomainError("invalid_request", "Unknown command");
      }
    });
    // The durable receipt precedes every external effect. Replays do not resend an RPC.
    if (!result.replay) {
      if (command.command === "resolve_approval") {
        const approval = result.value.approvals.find(
          (a) => a.approval_id === command.approval_id,
        );
        try {
          this.live
            .get(command.run_id)
            .respond(approval.request_id, command.decision);
        } catch {
          this.uncertain(
            command.run_id,
            "Approval delivery outcome is unknown",
          );
          const runtime = this.live.get(command.run_id);
          if (runtime)
            this.background(() => this.release(command.run_id, runtime));
        }
      } else if (
        command.command === "cancel_run" &&
        result.value.status === "cancelling"
      ) {
        this.background(() => this.cancel(command.run_id));
      } else if (command.command === "reconcile_run") {
        this.background(() => this.reconcile(command.run_id));
      }
      this.schedule();
    }
    return result;
  }
  background(fn) {
    const job = Promise.resolve().then(fn);
    this.jobs.add(job);
    job.catch(() => {}).finally(() => this.jobs.delete(job));
  }
  schedule() {
    if (this.stopping) return;
    this.background(async () => {
      if (this.live.size || this.stopping) return;
      const run = this.store.runs().find((item) => item.status === "queued");
      if (run) await this.execute(run.run_id);
    });
  }
  expire(run) {
    for (const approval of run.approvals) {
      if (approval.status === "pending") approval.status = "expired";
    }
  }
  uncertain(id, message) {
    const run = this.store.run(id);
    if (terminal.has(run.status) || run.status === "recovery_required") return;
    this.store.update(id, (current) => {
      current.status = "recovery_required";
      this.expire(current);
      if (current.attempts.length) {
        current.attempts.at(-1).status = "recovery_required";
        current.attempts.at(-1).error = message.slice(0, 2000);
      }
      this.store.save(current, "run.recovery_required", {
        message: message.slice(0, 2000),
      });
    });
  }
  async execute(id) {
    let runtime;
    let dispatched = false;
    try {
      this.store.update(id, (run) => {
        if (run.status !== "queued") conflict("Run no longer queued");
        run.status = "starting";
        run.attempts.push({
          attempt: run.attempts.length + 1,
          thread_id: null,
          turn_id: null,
          status: "starting",
          result: "",
          error: null,
          created_at: now(),
          finished_at: null,
        });
        this.store.save(run, "attempt.starting");
      });
      const directory = this.workspace(this.store.run(id).project_id);
      runtime = this.runtimeFactory();
      this.live.set(id, runtime);
      runtime.on("fault", () => {
        if (this.live.get(id) === runtime) {
          this.uncertain(
            id,
            "Runtime connection lost; external effects may have occurred",
          );
          this.background(() => this.release(id, runtime));
        }
      });
      runtime.on("notification", (message) => {
        if (this.live.get(id) !== runtime) return;
        this.notification(id, message);
      });
      runtime.on("approval", (request) => this.approval(id, runtime, request));
      await runtime.connect();
      dispatched = true;
      const thread = await runtime.startThread(directory);
      this.store.update(id, (run) => {
        run.attempts.at(-1).thread_id = thread.thread.id;
        this.store.save(run, "runtime.bound", { thread_id: thread.thread.id });
      });
      if (this.store.run(id).status === "cancelling") {
        this.store.update(id, (run) => {
          run.status = "cancelled";
          run.attempts.at(-1).status = "cancelled";
          run.attempts.at(-1).finished_at = now();
          this.store.save(run, "run.cancelled");
        });
        await this.release(id, runtime);
        return;
      }
      const response = await runtime.startTurn(
        thread.thread.id,
        this.store.run(id).task,
      );
      const run = this.store.run(id);
      if (run.attempts.at(-1).turn_id === null) {
        this.bindTurn(id, response.turn.id);
      }
      if (this.store.run(id).status === "cancelling") await this.cancel(id);
    } catch (error) {
      if (dispatched) this.uncertain(id, error.message);
      else
        this.store.update(id, (run) => {
          run.status = "failed";
          const attempt = run.attempts.at(-1);
          attempt.status = "failed";
          attempt.error = error.message.slice(0, 2000);
          attempt.finished_at = now();
          this.expire(run);
          this.store.save(run, "run.failed", {
            reason: "pre_dispatch_failure",
          });
        });
      if (runtime) await this.release(id, runtime);
    }
  }
  bindTurn(id, turnId) {
    this.store.update(id, (run) => {
      const attempt = run.attempts.at(-1);
      if (attempt.turn_id && attempt.turn_id !== turnId)
        throw new Error("Unexpected runtime turn");
      if (attempt.turn_id) return;
      attempt.turn_id = turnId;
      attempt.status = "running";
      if (run.status === "starting") run.status = "running";
      this.store.save(run, "runtime.started", { turn_id: turnId });
    });
  }
  notification(id, { method, params }) {
    const run = this.store.run(id);
    const attempt = run.attempts.at(-1);
    if (
      !params ||
      params.threadId !== attempt?.thread_id ||
      terminal.has(run.status)
    )
      return;
    if (method === "serverRequest/resolved") {
      this.store.update(id, (current) => {
        const approval = current.approvals.find(
          (item) =>
            item.request_id === params.requestId && item.status === "pending",
        );
        if (!approval) return;
        approval.status = "expired";
        if (
          current.status === "waiting_approval" &&
          !current.approvals.some((item) => item.status === "pending")
        ) {
          current.status = "running";
        }
        this.store.save(current, "approval.resolved", {
          approval_id: approval.approval_id,
          decision: "expired_by_runtime",
        });
      });
    } else if (method === "turn/started") {
      this.bindTurn(id, params.turn.id);
    } else if (method === "turn/completed") {
      if (attempt.turn_id && params.turn.id !== attempt.turn_id) return;
      this.finish(id, params.turn);
      const runtime = this.live.get(id);
      if (runtime) this.background(() => this.release(id, runtime));
    } else if (
      method === "item/completed" &&
      params.turnId === attempt.turn_id
    ) {
      this.store.update(id, (current) => {
        const item = params.item;
        if (item?.type === "agentMessage" && typeof item.text === "string") {
          current.attempts.at(-1).result = item.text.slice(0, 1000000);
          this.store.save(current, "runtime.message", {
            item_id: item.id,
            text: item.text.slice(0, 1000000),
          });
        } else {
          this.store.save(current, "runtime.item", {
            item_id: item?.id ?? "unknown",
            kind: item?.type ?? "unknown",
            status: item?.status ?? null,
            exit_code: item?.exitCode ?? null,
          });
        }
      });
    }
  }
  approval(id, runtime, request) {
    const { params } = request;
    const run = this.store.run(id);
    const attempt = run.attempts.at(-1);
    if (
      this.live.get(id) !== runtime ||
      params?.threadId !== attempt?.thread_id ||
      !["starting", "running", "waiting_approval"].includes(run.status)
    ) {
      runtime.respond(request.request_id, "decline");
      return;
    }
    this.bindTurn(id, params.turnId);
    this.store.update(id, (current) => {
      if (current.approvals.length >= 1000)
        throw new Error("Approval history limit exceeded");
      const approval = {
        approval_id: randomUUID(),
        attempt: attempt.attempt,
        kind: request.kind,
        request_id: request.request_id,
        generation: runtime.generation,
        status: "pending",
        details: params,
        created_at: now(),
      };
      current.approvals.push(approval);
      current.status = "waiting_approval";
      this.store.save(current, "approval.requested", {
        approval_id: approval.approval_id,
      });
    });
  }
  finish(id, turn) {
    const statuses = {
      completed: "awaiting_review",
      failed: "failed",
      interrupted: "cancelled",
    };
    const status = statuses[turn.status];
    if (!status) return;
    this.store.update(id, (run) => {
      const attempt = run.attempts.at(-1);
      attempt.turn_id = turn.id;
      attempt.status = status;
      attempt.finished_at = now();
      attempt.error = turn.error
        ? "Codex turn failed; inspect the runtime locally"
        : null;
      const final = turn.items
        ?.filter((item) => item.type === "agentMessage")
        .at(-1);
      if (final?.text) attempt.result = final.text.slice(0, 1000000);
      run.status = status;
      this.expire(run);
      this.store.save(run, `run.${status}`, { runtime_status: turn.status });
    });
  }
  async cancel(id) {
    const run = this.store.run(id);
    if (run.status !== "cancelling") return;
    const attempt = run.attempts.at(-1);
    if (!attempt?.turn_id) return; // execute observes the durable cancellation after dispatch.
    try {
      const runtime = this.live.get(id);
      if (!runtime) throw new Error("No live runtime");
      await runtime.interrupt(attempt.thread_id, attempt.turn_id);
      // An RPC acknowledgment does not prove that the turn or its effects ended.
    } catch {
      this.uncertain(id, "Cancellation could not be confirmed");
      const runtime = this.live.get(id);
      if (runtime) await this.release(id, runtime);
    }
  }
  async reconcile(id) {
    let runtime;
    try {
      const run = this.store.run(id);
      if (run.status !== "recovery_required" || this.live.size) return;
      runtime = this.runtimeFactory();
      this.live.set(id, runtime);
      await runtime.connect();
      const attempt = run.attempts.at(-1);
      const response = await runtime.readThread(attempt.thread_id);
      const turns = response.thread.turns ?? [];
      // Each attempt owns a fresh thread; ambiguous dispatch may have no saved turn id.
      const turn = attempt.turn_id
        ? turns.find((item) => item.id === attempt.turn_id)
        : turns.length === 1
          ? turns[0]
          : null;
      if (
        turn &&
        ["completed", "failed", "interrupted"].includes(turn.status)
      ) {
        this.finish(id, turn);
      } else {
        this.store.update(id, (current) =>
          this.store.save(current, "run.reconciled", {
            outcome: "unresolved",
            message: "No authoritative terminal turn; no task was replayed",
          }),
        );
      }
    } catch {
      this.store.update(id, (current) =>
        this.store.save(current, "run.reconciled", {
          outcome: "unavailable",
          message: "Runtime history unavailable; no task was replayed",
        }),
      );
    } finally {
      if (runtime) await this.release(id, runtime);
    }
  }
  async release(id, runtime) {
    // Keep the global execution slot occupied until the child has actually exited.
    runtime.removeAllListeners("notification");
    runtime.removeAllListeners("approval");
    runtime.removeAllListeners("fault");
    await runtime.close();
    if (this.live.get(id) === runtime) this.live.delete(id);
  }
  async close() {
    this.stopping = true;
    for (const [id, runtime] of this.live) {
      this.uncertain(id, "Service stopped; reconcile before retrying");
      await this.release(id, runtime);
    }
    await Promise.allSettled([...this.jobs]);
  }
}
