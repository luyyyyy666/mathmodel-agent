# Backend core implementation scope

The user explicitly requested implementation of the Codex integration and the backend
business contracts on 2026-09-17, with the frontend deferred. This request is the
implementation authority for this change. It does not mark an ADR accepted or assign
an approver. Existing governance standards are retained.

The user subsequently chose a maintained Codex source branch and local builds.
The application therefore requires a source-build registration, with no fallback
to a globally installed executable.

The implementation adds a versioned v2 contract alongside the existing unpublished
v1 candidate. It introduces a Node.js 24.19 runtime, SQLite through node:sqlite,
and Ajv with formats for runtime JSON Schema validation. The original governance
utilities remain independent of these application dependencies.

The initial unit of work is one bounded modeling task per run, with explicit
acceptance criteria. It supports durable attempts, execution approval, cancellation,
history reconciliation and human result review. It does not yet implement a DAG
scheduler, artifact provenance database, scientific validators or a graphical app.

Codex is an external, version-pinned executable using app-server stdio. Its source
is not copied or changed. Durable business state is owned by this service. A model
turn finishing is not scientific acceptance. Ambiguous dispatch is never replayed
automatically. Existing v1 files are preserved as reference material.

Alternatives considered: directly modifying the agent core would create unnecessary
upstream maintenance; parsing terminal output would discard structured events and
approval requests; a memory-only store would lose execution identity on restart.

The test-coverage mapping excludes tests/fixtures/\*\* because these are child-process
protocol fixtures, exercised by the mirrored runtime and service integration tests.
They are not production source files.
