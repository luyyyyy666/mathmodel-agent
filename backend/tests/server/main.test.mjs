import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { start } from "../../server/main.mjs";

const binary = fileURLToPath(
  new URL("../fixtures/codex-process.mjs", import.meta.url),
);
const sha256 = createHash("sha256").update(readFileSync(binary)).digest("hex");
test("service boot requires source registration, owns lock and can restart", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "mathmodel-agent-main-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const registration = path.join(dir, "runtime.json");
  writeFileSync(
    registration,
    JSON.stringify({
      kind: "source-build",
      binary,
      sha256,
      source_commit: "1".repeat(40),
    }),
  );
  const config = {
    data_directory: path.join(dir, "data"),
    codex_home: path.join(dir, "codex"),
    runtime_registration: registration,
    port: 0,
  };
  const token = "private-test-token-".repeat(3);
  const app = await start(config, token);
  try {
    await assert.rejects(start(config, token), /locked/);
    const response = await fetch(`http://127.0.0.1:${app.port}/health`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
  } finally {
    await app.close();
  }
  const restarted = await start(config, token);
  await restarted.close();
  writeFileSync(
    registration,
    JSON.stringify({ kind: "official-binary", binary, sha256 }),
  );
  await assert.rejects(start(config, token), /source-build/);
});
