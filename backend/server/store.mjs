import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { canonical, DomainError, validate } from "./contracts.mjs";

export class Store {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        run_id TEXT NOT NULL REFERENCES runs(id), sequence INTEGER NOT NULL,
        body TEXT NOT NULL, PRIMARY KEY(run_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS receipts (
        key TEXT PRIMARY KEY, digest TEXT NOT NULL, body TEXT NOT NULL
      );
    `);
    const version = this.db
      .prepare("SELECT value FROM metadata WHERE key='schema'")
      .get();
    if (version && version.value !== "2") {
      this.db.close();
      throw new Error("Unsupported database schema");
    }
    this.db
      .prepare("INSERT OR IGNORE INTO metadata VALUES ('schema', '2')")
      .run();
  }
  close() {
    this.db.close();
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  command(command, fn) {
    const digest = createHash("sha256")
      .update(canonical(command))
      .digest("hex");
    return this.transaction(() => {
      const prior = this.db
        .prepare("SELECT * FROM receipts WHERE key=?")
        .get(command.idempotency_key);
      if (prior) {
        if (prior.digest !== digest)
          throw new DomainError("conflict", "Idempotency key reused");
        return { replay: true, value: JSON.parse(prior.body) };
      }
      const value = fn();
      this.db
        .prepare("INSERT INTO receipts VALUES (?, ?, ?)")
        .run(command.idempotency_key, digest, JSON.stringify(value));
      return { replay: false, value };
    });
  }
  project(id) {
    const row = this.db.prepare("SELECT body FROM projects WHERE id=?").get(id);
    if (!row) throw new DomainError("not_found", "Project not found");
    return JSON.parse(row.body);
  }
  projects() {
    return this.db
      .prepare("SELECT body FROM projects ORDER BY id")
      .all()
      .map((row) => JSON.parse(row.body));
  }
  addProject(project) {
    validate("project", project);
    this.db
      .prepare("INSERT INTO projects VALUES (?, ?)")
      .run(project.project_id, JSON.stringify(project));
  }
  run(id) {
    const row = this.db.prepare("SELECT body FROM runs WHERE id=?").get(id);
    if (!row) throw new DomainError("not_found", "Run not found");
    return JSON.parse(row.body);
  }
  runs() {
    return this.db
      .prepare("SELECT body FROM runs ORDER BY id")
      .all()
      .map((row) => JSON.parse(row.body));
  }
  save(run, type, payload = {}) {
    run.state_version += 1;
    run.last_sequence += 1;
    run.updated_at = new Date().toISOString();
    validate("run", run);
    const event = validate("event", {
      contract_version: "v2",
      run_id: run.run_id,
      sequence: run.last_sequence,
      state_version: run.state_version,
      type,
      at: run.updated_at,
      payload,
    });
    this.db
      .prepare(
        `INSERT INTO runs VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET body=excluded.body`,
      )
      .run(run.run_id, run.project_id, JSON.stringify(run));
    this.db
      .prepare("INSERT INTO events VALUES (?, ?, ?)")
      .run(run.run_id, event.sequence, JSON.stringify(event));
    return run;
  }
  update(id, fn) {
    return this.transaction(() => fn(this.run(id)));
  }
  events(id, after = 0, limit = 200) {
    this.run(id);
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 500
    ) {
      throw new DomainError("invalid_request", "Invalid event cursor or limit");
    }
    const events = this.db
      .prepare(
        `SELECT body FROM events WHERE run_id=?
      AND sequence>? ORDER BY sequence LIMIT ?`,
      )
      .all(id, after, limit)
      .map((row) => JSON.parse(row.body));
    return { events, next_sequence: events.at(-1)?.sequence ?? after };
  }
}
