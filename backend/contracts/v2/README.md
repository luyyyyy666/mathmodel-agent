# Mathmodel Agent core contract v2

Schema: `contracts/v2/core.schema.json`. Each named definition is a separately
validated payload. The service uses Ajv Draft 2020-12 with format validation.
The older v1 candidate remains unchanged as a historical reference; v2 does not
change its schemas or claim to implement its routes.

## Business objects

- project: stable identity and name; the service owns its workspace directory.
- task: title, prompt and nonempty acceptance criteria. No fixed competition phase enum.
- run: task, status, optimistic state version, event watermark and attempt history.
- attempt: runtime thread/turn identities, execution result and terminal/error state.
- approval: pending command/file permission bound to a runtime connection generation.
- review: explicit human acceptance or rejection of the result.
- event: durable per-run sequence with the state version produced by that event.

A run is currently a single task, not a DAG or an entire competition template.
Execution results are text plus workspace files; files are not yet registered as
versioned artifact entities. Review means a human decision, not proof that the
scientific result is correct.

## HTTP

All requests require Authorization: Bearer with the configured private token.
The service listens on 127.0.0.1; use that literal hostname. Origin headers are
rejected until a separate browser integration is designed.

| Method | Endpoint                                   | Result                                             |
| ------ | ------------------------------------------ | -------------------------------------------------- |
| GET    | /health                                    | service availability and v2 version                |
| POST   | /v2/commands                               | replay flag and the original command receipt value |
| GET    | /v2/projects                               | current projects                                   |
| GET    | /v2/runs                                   | current runs                                       |
| GET    | /v2/runs/{run_id}                          | current run snapshot                               |
| GET    | /v2/runs/{run_id}/events?after=0&limit=200 | ordered events and next_sequence                   |

Lists are intended for a local single-user prototype and are not yet paginated.
Events are paginated, with a maximum page size of 500. Read a snapshot, then fetch
events after its last_sequence. Continue from next_sequence until caught up.
Every event and state update commit together. Polling is the current transport;
there is no WebSocket or SSE endpoint. Individual token deltas are not persisted;
completed messages and tool-item summaries are persisted.

Command bodies are strict JSON, bounded to 64 KiB. Invalid input returns 400,
missing resources 404, stale versions/state or idempotency conflicts 409, and
unavailable service 503. Authentication failures return 403. Internal errors do
not include raw exception details. No command accepts a shell command, executable
path, arbitrary workspace path or direct Codex protocol override.

## Commands

All commands carry idempotency_key, globally unique within this local service.
The same key and semantic JSON body returns the original receipt without repeating
an external action. A different body under that key returns 409. Property ordering
does not change semantic identity. The response is a receipt, not necessarily the
latest state; use GET after asynchronous execution progresses.

Create a project:

```json
{
  "command": "create_project",
  "idempotency_key": "project-001",
  "name": "选址建模"
}
```

Create a task using the returned project_id:

```json
{
  "command": "create_run",
  "idempotency_key": "run-001",
  "project_id": "RETURNED_PROJECT_ID",
  "task": {
    "title": "建立可解释基线",
    "prompt": "读取工作区数据，建立简单选址基线并保存计算脚本。",
    "acceptance_criteria": ["结果能由脚本重新计算", "说明变量单位和约束"]
  }
}
```

Start the returned run using its current state_version:

```json
{
  "command": "start_run",
  "idempotency_key": "start-001",
  "run_id": "RETURNED_RUN_ID",
  "expected_version": 1
}
```

The remaining mutation commands all require run_id, expected_version and
idempotency_key:

| Command          | Additional fields                        | Allowed state                                      |
| ---------------- | ---------------------------------------- | -------------------------------------------------- |
| cancel_run       | none                                     | ready, queued, starting, running, waiting_approval |
| retry_run        | none                                     | failed, cancelled                                  |
| reconcile_run    | none                                     | recovery_required, with a saved thread identity    |
| resolve_approval | approval_id, decision: accept or decline | waiting_approval, current connection               |
| review_run       | decision: accept or reject, comment      | awaiting_review                                    |

Reviews and approval responses are bound by optimistic concurrency. Reload the
snapshot after a 409 rather than reusing an old approval or old state version.
Retries create a new attempt with the original task; create a new run if the task
itself needs changed instructions. Prior attempts and review events remain available.

## State transitions

Normal execution:

```text
ready -> queued -> starting -> running -> awaiting_review -> completed
                                  |             |
                                  |             +-> failed (review rejected)
                                  +-> waiting_approval -> running
                                  +-> failed
                                  +-> cancelling -> cancelled
```

Cancellation before turn dispatch may complete without a turn. A turn that
finishes before its cancellation is processed still enters awaiting_review;
completed effects are not relabeled as cancelled. External side effects are not
rolled back by cancelling or closing the process.

An uncertain runtime outcome moves to recovery_required. A service restart does
not repeat an already dispatched attempt. Reconciliation reads history without
starting a new turn; completed/failed/interrupted results are mapped back into
business state. A missing, active or ambiguous historical turn stays unresolved.
No force-complete, force-retry or automatic rerun exists for this state.

The queued intent is persisted before dispatch and can start after a restart.
The starting intent is persisted before creating a runtime thread. Therefore a
crash can leave an unknown thread identity; this remains visible for manual
inspection rather than silently creating another execution.

## Runtime boundary

Codex protocol fields remain inside the runtime adapter. The executable comes
from an explicitly registered source build and is checked by SHA-256. Each active
run owns one process and one fresh thread per attempt. Only single-action command
and file-change approval are implemented. Session-wide permissions and policy
amendments are not exposed through the business command surface.

The adapter waits for initialization before sending initialized and thread
requests. RPC ids correlate responses, request deadlines close the connection,
and malformed/oversized frames stop it. Approval generation identifiers prevent
reusing a pending request after reconnect. An RPC timeout can occur after an
action happened; the business service treats it as uncertain.
