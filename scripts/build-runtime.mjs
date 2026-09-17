import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = JSON.parse(
  readFileSync(path.join(root, "runtime-source.json"), "utf8"),
);
const checkout = path.join(root, source.checkout);
const cwd = path.join(checkout, "codex-rs");
const out = path.join(root, ".runtime");
const cargo = process.env.CARGO ?? path.join(homedir(), ".cargo/bin/cargo");
const capture = (cmd, args, directory = cwd) => {
  const result = spawnSync(cmd, args, {
    cwd: directory,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(result.stderr || result.error?.message);
  return result.stdout.trim();
};
const commit = capture("git", ["rev-parse", "HEAD"]);
const branch = capture("git", ["branch", "--show-current"]);
const sourceTree = capture(
  "git",
  ["rev-parse", `HEAD:${source.checkout}`],
  root,
);
// Modified source needs an explicit commit before it can be registered reproducibly.
if (capture("git", ["status", "--porcelain", "--untracked-files=all"])) {
  throw new Error(
    "Commit runtime source changes before building a registered runtime",
  );
}
const result = spawnSync(
  cargo,
  [
    `+${source.toolchain}`,
    "build",
    "--locked",
    "-p",
    source.package,
    "--bin",
    source.binary,
    "--config",
    "profile.dev.debug=0",
    "--config",
    "profile.dev.incremental=false",
  ],
  {
    cwd,
    stdio: "inherit",
    env: { ...process.env, PATH: `${path.dirname(cargo)}:${process.env.PATH}` },
  },
);
if (result.error || result.status !== 0) {
  process.exitCode = result.status || 1;
} else {
  const targetDirectory = process.env.CARGO_TARGET_DIR
    ? path.resolve(cwd, process.env.CARGO_TARGET_DIR)
    : path.join(cwd, "target");
  const binary = path.join(
    targetDirectory,
    "debug",
    process.platform === "win32" ? "codex.exe" : "codex",
  );
  if (!existsSync(binary))
    throw new Error("Build did not produce the expected executable");
  const sha256 = createHash("sha256")
    .update(readFileSync(binary))
    .digest("hex");
  mkdirSync(out, { recursive: true });
  capture(binary, [
    "app-server",
    "generate-json-schema",
    "--out",
    path.join(out, "protocol"),
  ]);
  const registration = {
    kind: "source-build",
    source_commit: commit,
    source_branch: branch || "detached",
    source_tree: sourceTree,
    upstream_baseline: source.baseline_commit,
    upstream: source.upstream,
    binary,
    sha256,
    version: capture(binary, ["--version"]),
    toolchain: source.toolchain,
    profile: "dev",
    built_at: new Date().toISOString(),
  };
  writeFileSync(
    path.join(out, "runtime.json"),
    JSON.stringify(registration, null, 2) + "\n",
  );
  process.stdout.write(
    `Registered source build: ${path.join(out, "runtime.json")}\n`,
  );
}
