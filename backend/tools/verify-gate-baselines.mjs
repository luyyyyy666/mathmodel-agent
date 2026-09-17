#!/usr/bin/env node

/*
 * GATE 4 - BASELINE RATCHET
 *
 * THE PROBLEM THIS SOLVES
 *   A gate that fails on a clean checkout, for reasons no single change can be
 *   asked to fix, has exactly three futures. Run it raw and every change is red
 *   on day one, so it is switched off within a week. Drop it and the debt grows
 *   unobserved. Or write the pre-existing failure set down and fail on any
 *   difference from it - which is this tool.
 *
 * THE CONTRACT, IN FOUR DIRECTIONS
 *   NEW     observed entry absent from the baseline -> FAIL. A change that
 *           adds a violation cannot be green.
 *   GROWN   observed count above the recorded count -> FAIL.
 *   SHRUNK  observed count below the recorded count -> FAIL, with the
 *           instruction to lower the number in the same change.
 *   GONE    recorded entry that no longer fails -> FAIL, with the instruction
 *           to delete the line in the same change.
 *   Failing on improvement is deliberate. A baseline allowed to shrink silently
 *   goes stale, and a stale baseline hides the next regression. Debt may only
 *   leave the ledger through a diff a reviewer reads.
 *
 * WHY THE BASELINE IS A DATA FILE AND WHY THERE IS NO --update
 *   Data file: this tool is shipped as a package and the debt belongs to the
 *   consumer, so a baseline compiled into this file would be somebody else's
 *   debt. --update: the moment the ledger can be regenerated from the current
 *   tree, "regenerate the baseline" becomes a one-command way to accept a new
 *   violation and the gate stops gating. --print-observed prints the entries in
 *   copy-pasteable form; a human still moves them into the file.
 *
 * IDENTITY: an entry is (key, count). Whatever the parse rule cuts out of the
 * command's output is the key - a path, a path plus an error code, a rule name.
 * Line numbers make poor keys: they move when a file is edited and the identity
 * of the debt does not.
 */

import { spawnSync } from "node:child_process";
import {
  Report,
  codePointOrder,
  loadConfig,
  parseArgv,
  resolveRoot,
  run,
} from "../lib/kit.mjs";

const NAME = "gate-baselines";

function help() {
  process.stdout.write(
    [
      "node tools/verify-gate-baselines.mjs [--print-observed]",
      "                                    [--root <dir>] [--config <path>]",
      "",
      "  Runs each command declared in governance/gate-baselines.json and",
      "  compares its parsed failure set against the recorded baseline. Any",
      "  difference in any of the four directions is a failure.",
      "",
      "  --print-observed  print the observed sets as copy-pasteable baseline",
      "                    entries and skip the comparison.",
      "",
    ].join("\n"),
  );
}

function validate(config, relative) {
  const gates = config.gates ?? [];
  if (!Array.isArray(gates))
    throw new Error(`${relative}: gates must be an array`);
  const seen = new Set();
  for (const gate of gates) {
    if (typeof gate.id !== "string" || gate.id.length === 0) {
      throw new Error(`${relative}: every gate needs a non-empty string id`);
    }
    if (seen.has(gate.id)) {
      throw new Error(`${relative}: gate id ${gate.id} is declared twice`);
    }
    seen.add(gate.id);
    if (!Array.isArray(gate.command) || gate.command.length === 0) {
      throw new Error(
        `${relative}: gate ${gate.id} needs a command as a non-empty argv array`,
      );
    }
    if (gate.parse === undefined || typeof gate.parse.pattern !== "string") {
      throw new Error(
        `${relative}: gate ${gate.id} needs parse.pattern, the regular expression that cuts one entry key out of one line of output`,
      );
    }
    if (!Array.isArray(gate.entries)) {
      throw new Error(
        `${relative}: gate ${gate.id} needs an entries array; an absent ledger and an empty ledger are different claims and only one of them can be written down`,
      );
    }
  }
  return gates;
}

function observe(gate) {
  const [program, ...rest] = gate.command;
  const result = spawnSync(program, rest, {
    cwd: gate.cwd,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  const printable = gate.command.join(" ");
  if (result.error) {
    throw new Error(
      `gate ${gate.id}: ${printable} could not be spawned: ${result.error.message}`,
    );
  }
  const accepted = gate.acceptExitCodes ?? [0, 1];
  if (!accepted.includes(result.status)) {
    throw new Error(
      `gate ${gate.id}: ${printable} exited ${result.status}, which is not in acceptExitCodes ${JSON.stringify(accepted)}; refusing to compare a baseline against the output of a command that did not run as expected`,
    );
  }
  const text = `${result.stdout}${result.stderr}`;
  const pattern = new RegExp(gate.parse.pattern, "gm");
  const exclude =
    gate.parse.excludePattern === undefined
      ? null
      : new RegExp(gate.parse.excludePattern);
  const keyGroup = gate.parse.keyGroup ?? 1;
  const countGroup = gate.parse.countGroup ?? null;
  const observed = new Map();
  let matches = 0;
  let match = pattern.exec(text);
  while (match !== null) {
    const current = match;
    // A zero-length match would leave lastIndex where it is and spin forever;
    // a parse pattern that can match empty is a configuration mistake, but it
    // must not hang the gate.
    if (current[0].length === 0) pattern.lastIndex += 1;
    match = pattern.exec(text);
    const key = current[keyGroup];
    if (key === undefined) continue;
    if (exclude !== null && exclude.test(current[0])) continue;
    matches += 1;
    const amount = countGroup === null ? 1 : Number(current[countGroup] ?? 1);
    if (!Number.isFinite(amount)) {
      throw new Error(
        `gate ${gate.id}: countGroup ${countGroup} captured ${JSON.stringify(current[countGroup])}, which is not a number`,
      );
    }
    observed.set(key, (observed.get(key) ?? 0) + amount);
  }
  return { observed, matches, status: result.status, text };
}

function baselineOf(gate) {
  const baseline = new Map();
  for (const entry of gate.entries) {
    const key = typeof entry === "string" ? entry : entry.key;
    const count = typeof entry === "string" ? 1 : (entry.count ?? 1);
    if (typeof key !== "string") {
      throw new Error(`gate ${gate.id}: every entry needs a string key`);
    }
    if (baseline.has(key)) {
      throw new Error(`gate ${gate.id}: entry ${key} is recorded twice`);
    }
    baseline.set(key, count);
  }
  return baseline;
}

function compare(gate, baseline, observed, report, relative) {
  const keys = [...new Set([...baseline.keys(), ...observed.keys()])].sort(
    codePointOrder,
  );
  let agreed = 0;
  for (const key of keys) {
    const expected = baseline.get(key) ?? 0;
    const actual = observed.get(key) ?? 0;
    if (expected === actual) {
      agreed += 1;
      continue;
    }
    if (expected === 0) {
      report.fail(
        `${gate.id}/NEW`,
        `${key} fails ${actual} time(s) and is not in the baseline. A new violation must be fixed, not appended to ${relative}`,
      );
    } else if (actual === 0) {
      report.fail(
        `${gate.id}/GONE`,
        `${key} no longer fails, but ${relative} still records ${expected}. Delete its entry in this same change so the ledger cannot go stale`,
      );
    } else if (actual > expected) {
      report.fail(
        `${gate.id}/GROWN`,
        `${key} fails ${actual} time(s), the baseline records ${expected}. Fix the new one; do not raise the number`,
      );
    } else {
      report.fail(
        `${gate.id}/SHRUNK`,
        `${key} fails ${actual} time(s), the baseline records ${expected}. Lower the number in ${relative} in this same change`,
      );
    }
  }
  return agreed;
}

run(NAME, () => {
  const { flags, options } = parseArgv(process.argv.slice(2), {
    flags: ["--print-observed"],
  });
  if (flags.has("--help")) {
    help();
    return;
  }
  const root = resolveRoot(options);
  const report = new Report(NAME);
  const loaded = loadConfig(root, "gate-baselines", options);
  if (!loaded.present) {
    report.finish(
      `no ${loaded.relative} in this workspace, so no pre-existing failure set is recorded and none is compared (0 gates)`,
    );
    return;
  }
  const gates = validate(loaded.config, loaded.relative);
  if (gates.length === 0) {
    report.finish(
      `${loaded.relative} declares 0 gates, so there is no ledger to compare`,
    );
    return;
  }

  const summaries = [];
  for (const gate of gates) {
    const resolved = { ...gate, cwd: root };
    const { observed, matches } = observe(resolved);
    if (flags.has("--print-observed")) {
      process.stdout.write(
        `"${gate.id}" entries, copy into ${loaded.relative}:\n`,
      );
      for (const key of [...observed.keys()].sort(codePointOrder)) {
        process.stdout.write(
          `  { "key": ${JSON.stringify(key)}, "count": ${observed.get(key)} },\n`,
        );
      }
      continue;
    }
    const baseline = baselineOf(gate);
    const agreed = compare(gate, baseline, observed, report, loaded.relative);
    const recordedTotal = [...baseline.values()].reduce(
      (sum, value) => sum + value,
      0,
    );
    const observedTotal = [...observed.values()].reduce(
      (sum, value) => sum + value,
      0,
    );
    report.detail(
      `${gate.id}: ${baseline.size} recorded entr(y|ies) totalling ${recordedTotal}, ` +
        `${observed.size} observed totalling ${observedTotal} from ${matches} parsed line(s), ${agreed} agreed`,
    );
    summaries.push(`${gate.id} ${observed.size}/${baseline.size}`);
  }
  if (flags.has("--print-observed")) return;
  report.finish(
    `${gates.length} gate(s) compared against ${loaded.relative} (observed/recorded entries: ${summaries.join(", ")})`,
  );
});
