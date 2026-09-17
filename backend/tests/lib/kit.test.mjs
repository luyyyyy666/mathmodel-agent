import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  codePointOrder,
  globToRegExp,
  listTree,
  loadConfig,
  matchesAny,
  parseArgv,
} from "../../lib/kit.mjs";

const packageRoot = path.resolve(import.meta.dirname, "../..");

test("globToRegExp: * stops at a separator, ** crosses it", () => {
  assert.equal(globToRegExp("lib/*.mjs").test("lib/kit.mjs"), true);
  assert.equal(globToRegExp("lib/*.mjs").test("lib/deep/kit.mjs"), false);
  assert.equal(globToRegExp("lib/**").test("lib/deep/kit.mjs"), true);
  assert.equal(globToRegExp("**/kit.mjs").test("kit.mjs"), true);
  assert.equal(globToRegExp("**/kit.mjs").test("lib/kit.mjs"), true);
});

test("globToRegExp: regex metacharacters in a pattern stay literal", () => {
  assert.equal(globToRegExp("a.b").test("a.b"), true);
  assert.equal(globToRegExp("a.b").test("axb"), false);
  assert.equal(globToRegExp("a+b").test("a+b"), true);
});

test("matchesAny is false for an empty pattern list", () => {
  assert.equal(matchesAny("lib/kit.mjs", []), false);
  assert.equal(matchesAny("lib/kit.mjs", ["tools/**", "lib/**"]), true);
});

test("parseArgv separates flags from options and rejects the unknown", () => {
  const parsed = parseArgv(["--write", "--root", "/tmp/x"], {
    flags: ["--write"],
  });
  assert.equal(parsed.flags.has("--write"), true);
  assert.equal(parsed.options.get("--root"), "/tmp/x");
  assert.equal(
    parseArgv(["--root=/tmp/y"], {}).options.get("--root"),
    "/tmp/y",
  );
  assert.throws(
    () => parseArgv(["--wrote"], { flags: ["--write"] }),
    /unknown argument/,
  );
  assert.throws(() => parseArgv(["--root"], {}), /needs a value/);
});

test("loadConfig reports absence instead of throwing", () => {
  const loaded = loadConfig(packageRoot, "no-such-gate", new Map());
  assert.equal(loaded.present, false);
  assert.equal(loaded.config, null);
  assert.equal(loaded.relative, "governance/no-such-gate.json");
});

test("listTree returns code-point-sorted repository-relative paths", () => {
  const found = listTree(packageRoot, "lib");
  assert.deepEqual(found, [...found].sort(codePointOrder));
  assert.equal(found.includes("lib/kit.mjs"), true);
  assert.equal(
    found.every((relative) => relative.startsWith("lib/")),
    true,
  );
});

test("listTree honours skip and returns nothing for an absent root", () => {
  const skipped = listTree(packageRoot, "lib", {
    skip: (relative) => relative.endsWith(".mjs"),
  });
  assert.deepEqual(skipped, []);
  assert.deepEqual(listTree(packageRoot, "no-such-directory"), []);
});
