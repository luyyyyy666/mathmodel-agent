#!/usr/bin/env node

/*
 * CONTENT ENUMERATION MANIFEST
 *
 * WHAT IT IS FOR
 *   A consumer must be able to state exactly what it took from this package:
 *   every file, its size, and its digest. That enumeration is what separates a
 *   package from a copied directory tree. A copied tree has no boundary - it is
 *   whatever happened to be on disk that day, including everything nobody meant
 *   to hand over. An enumerated package has a boundary that a reviewer can read
 *   and a machine can re-check, and anything not on the list is not part of what
 *   was handed over.
 *
 *   The same enumeration makes tampering visible: --check recomputes every
 *   digest against the file on disk and fails on any addition, removal or edit.
 *
 * WHY THE MANIFEST DOES NOT LIST ITSELF
 *   A file cannot contain its own SHA-256. The manifest therefore enumerates
 *   every other file, and the manifest's own digest is what a consumer pins:
 *
 *     shasum -a 256 MANIFEST.json
 *
 *   One digest, pinned once, transitively covers the whole package.
 *
 * WHY THIS TOOL'S ROOT DEFAULTS TO THE PACKAGE AND NOT THE WORKING DIRECTORY
 *   Every other tool here checks the consumer's repository, so its root is the
 *   working directory. This one describes the package itself, so its root is
 *   the package. --root overrides it, which is what makes the tool reusable for
 *   enumerating a consumer's own release.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  Report,
  byteLength,
  codePointOrder,
  fileExists,
  listTree,
  matchesAny,
  parseArgv,
  run,
  sha256,
} from "../lib/kit.mjs";

const NAME = "content-manifest";
const MANIFEST = "MANIFEST.json";

/*
 * Not configurable on purpose. These are the four things that are never part of
 * a package's content: version control internals, installed dependencies,
 * packing output, and the manifest itself. A configurable exclusion list is a
 * place to hide a file from the enumeration, which is the one thing the
 * enumeration exists to prevent.
 */
const NEVER_ENUMERATED = [
  ".git",
  ".git/**",
  "node_modules",
  "node_modules/**",
  MANIFEST,
  "*.tgz",
  "**/.DS_Store",
];

function help() {
  process.stdout.write(
    [
      "node tools/build-content-manifest.mjs (--check | --print | --write)",
      "                                     [--root <dir>]",
      "",
      "  --check  recompute every entry and compare with MANIFEST.json.",
      "           Read-only. Any addition, removal or edit exits non-zero.",
      "  --print  write the regenerated manifest to stdout and touch nothing.",
      "           Read-only.",
      "  --write  regenerate MANIFEST.json on disk. The only writing mode.",
      "",
    ].join("\n"),
  );
}

function enumerate(root) {
  const files = listTree(root, "", {
    skip: (relative) => matchesAny(relative, NEVER_ENUMERATED),
  }).sort(codePointOrder);
  const entries = files.map((relative) => ({
    path: relative,
    bytes: byteLength(root, relative),
    sha256: sha256(readFileSync(path.resolve(root, relative))),
  }));
  const packageJson = JSON.parse(
    readFileSync(path.resolve(root, "package.json"), "utf8"),
  );
  return {
    name: packageJson.name,
    version: packageJson.version,
    algorithm: "sha256",
    selfExcluded: MANIFEST,
    regenerate: "node tools/build-content-manifest.mjs --print",
    verify: "node tools/build-content-manifest.mjs --check",
    fileCount: entries.length,
    byteTotal: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    files: entries,
  };
}

function serialise(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

run(NAME, () => {
  const { flags, options } = parseArgv(process.argv.slice(2), {
    flags: ["--check", "--print", "--write"],
  });
  if (flags.has("--help")) {
    help();
    return;
  }
  const root = path.resolve(
    options.get("--root") ?? path.resolve(import.meta.dirname, ".."),
  );
  const modes = ["--check", "--print", "--write"].filter((flag) =>
    flags.has(flag),
  );
  if (modes.length !== 1) {
    throw new Error(
      `exactly one of --check, --print, --write is required; got ${modes.length === 0 ? "none" : modes.join(" ")}`,
    );
  }
  const manifest = enumerate(root);
  const text = serialise(manifest);

  if (flags.has("--print")) {
    process.stdout.write(text);
    return;
  }
  if (flags.has("--write")) {
    writeFileSync(path.resolve(root, MANIFEST), text);
    process.stdout.write(
      `ok - ${NAME}: wrote ${MANIFEST} enumerating ${manifest.fileCount} file(s), ${manifest.byteTotal} byte(s)\n`,
    );
    return;
  }

  const report = new Report(NAME);
  if (!fileExists(root, MANIFEST)) {
    report.fail(
      "M0",
      `${MANIFEST} does not exist. A package with no content enumeration cannot state what it contains; run --write to create it`,
    );
    report.finish("no manifest to compare against");
    return;
  }
  const recorded = JSON.parse(
    readFileSync(path.resolve(root, MANIFEST), "utf8"),
  );
  const recordedByPath = new Map(
    (recorded.files ?? []).map((entry) => [entry.path, entry]),
  );
  const liveByPath = new Map(
    manifest.files.map((entry) => [entry.path, entry]),
  );
  const paths = [
    ...new Set([...recordedByPath.keys(), ...liveByPath.keys()]),
  ].sort(codePointOrder);
  let agreed = 0;
  for (const relative of paths) {
    const before = recordedByPath.get(relative);
    const after = liveByPath.get(relative);
    if (before === undefined) {
      report.fail("M1", `ADDED ${relative} is on disk but not in ${MANIFEST}`);
      continue;
    }
    if (after === undefined) {
      report.fail(
        "M2",
        `REMOVED ${relative} is in ${MANIFEST} but not on disk`,
      );
      continue;
    }
    if (before.sha256 !== after.sha256 || before.bytes !== after.bytes) {
      report.fail(
        "M3",
        `CHANGED ${relative}: ${MANIFEST} records ${before.bytes} byte(s) sha256 ${before.sha256.slice(0, 16)}..., disk holds ${after.bytes} byte(s) sha256 ${after.sha256.slice(0, 16)}...`,
      );
      continue;
    }
    agreed += 1;
  }
  if (
    recorded.version !== manifest.version ||
    recorded.name !== manifest.name
  ) {
    report.fail(
      "M4",
      `${MANIFEST} names ${recorded.name}@${recorded.version}, package.json names ${manifest.name}@${manifest.version}`,
    );
  }
  if (recorded.fileCount !== manifest.fileCount) {
    report.fail(
      "M5",
      `${MANIFEST} records fileCount ${recorded.fileCount}, the enumeration finds ${manifest.fileCount}`,
    );
  }
  if (recorded.byteTotal !== manifest.byteTotal) {
    report.fail(
      "M6",
      `${MANIFEST} records byteTotal ${recorded.byteTotal}, the enumeration finds ${manifest.byteTotal}`,
    );
  }
  report.finish(
    `${agreed} of ${paths.length} enumerated file(s) match ${MANIFEST} byte for byte ` +
      `(${manifest.name}@${manifest.version}, ${manifest.byteTotal} byte(s); ${MANIFEST} itself is excluded and is pinned by its own digest)`,
  );
});
