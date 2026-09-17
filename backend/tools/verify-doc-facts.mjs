#!/usr/bin/env node

/*
 * GATE 1 - DOCUMENTED FACTS
 *
 * WHAT IT ASSERTS
 *   Every measured number quoted in a document equals the output of the
 *   command the document says it came from, right now.
 *
 * WHY A GATE AND NOT A CONVENTION
 *   A repository that writes measurements into prose accumulates them faster
 *   than anyone re-checks them. Hand cleanup does not work: the numbers are
 *   hunted by literal, two unrelated quantities that happen to read alike get
 *   cross-edited, and the next round starts from a tree that is already wrong
 *   again. The only durable form is an enumerable "document location ->
 *   command" table that a machine re-runs.
 *
 * NOTHING ABOUT THIS REPOSITORY IS COMPILED IN
 *   Every probe - its id, the command that measures it, how the value is cut
 *   out of that command's output - is declared by the consumer in
 *   governance/doc-facts.json. This file holds the engine and no data. A
 *   repository with no such file has no documented facts to check and the gate
 *   says so and exits 0; that is the state a new repository starts in.
 *
 * HOW A LOCATION IS IDENTIFIED - BY CONTEXT, NEVER BY THE LITERAL
 *   An anchor is the exact prose surrounding the number with `{probe.id}`
 *   standing where the number goes, plus how many times that prose is expected
 *   to occur in the file. Identifying by literal would cross-contaminate two
 *   quantities that currently read the same. Identifying by context also makes
 *   prose rewrites loud: reword the sentence and the anchor stops matching,
 *   and this gate fails rather than silently checking nothing.
 *
 * THE SELF-REFERENCE PROBLEM, AND WHY --write ITERATES
 *   Some quantities are functions of the documents that quote them: a byte
 *   total, a line count, a census of the documents themselves. Writing the new
 *   value changes the value. --write therefore runs a fixed-point loop -
 *   measure, write, measure again - and stops only when a whole round writes
 *   nothing. Equal-width substitution (474 -> 475) leaves the file size
 *   unchanged, so a fixed point exists; a substitution that changes digit
 *   width (99 -> 100) costs one more round. After maxWriteRounds the loop
 *   gives up and names the quantities that never settled, rather than looping
 *   forever or claiming a convergence that did not happen.
 *
 * PROBE COMMANDS MUST BE READ-ONLY. This gate runs them, in --write mode it
 * runs them repeatedly, and it cannot tell a measurement from a mutation. The
 * declaration in governance/doc-facts.json is the place that responsibility
 * sits; docs/standards/05-DOCUMENTATION.md rule D-08 states it as a rule.
 */

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  Report,
  codePointOrder,
  fileExists,
  loadConfig,
  parseArgv,
  readText,
  resolveRoot,
  run,
} from "../lib/kit.mjs";

const NAME = "doc-facts";
const DEFAULT_MAX_WRITE_ROUNDS = 5;
const PLACEHOLDER = /\{([A-Za-z0-9_.-]+)\}/g;
const VALUE = /^\d+(?:\.\d+)?$/;
const VALUE_CAPTURE = "(\\d+(?:\\.\\d+)?)";

function help() {
  process.stdout.write(
    [
      "node tools/verify-doc-facts.mjs [--write] [--print-observed]",
      "                               [--root <dir>] [--config <path>]",
      "",
      "  Re-runs the command behind every measured number quoted in the",
      "  documents named by governance/doc-facts.json and compares its output",
      "  with the literal standing in the document.",
      "",
      "  --write           fixed-point rewrite: measure, write, measure again,",
      "                    stop when a round writes nothing.",
      "  --print-observed  print every probe and its measured value, then stop.",
      "",
    ].join("\n"),
  );
}

/* -------------------------------------------------------------- validation */

function validate(config, relative) {
  const probes = config.probes ?? [];
  const anchors = config.anchors ?? [];
  if (!Array.isArray(probes))
    throw new Error(`${relative}: probes must be an array`);
  if (!Array.isArray(anchors))
    throw new Error(`${relative}: anchors must be an array`);
  const byId = new Map();
  for (const probe of probes) {
    if (typeof probe.id !== "string" || probe.id.length === 0) {
      throw new Error(`${relative}: every probe needs a non-empty string id`);
    }
    if (!PLACEHOLDER.test(`{${probe.id}}`)) {
      PLACEHOLDER.lastIndex = 0;
      throw new Error(
        `${relative}: probe id ${probe.id} contains characters a {placeholder} cannot carry`,
      );
    }
    PLACEHOLDER.lastIndex = 0;
    if (byId.has(probe.id)) {
      throw new Error(`${relative}: probe id ${probe.id} is declared twice`);
    }
    if (!Array.isArray(probe.command) || probe.command.length === 0) {
      throw new Error(
        `${relative}: probe ${probe.id} needs a command as a non-empty argv array, for example ["sh", "-c", "..."]`,
      );
    }
    byId.set(probe.id, probe);
  }
  const onProbeError = config.onProbeError ?? "fail";
  if (onProbeError !== "fail" && onProbeError !== "skip") {
    throw new Error(`${relative}: onProbeError must be "fail" or "skip"`);
  }
  for (const anchor of anchors) {
    if (
      typeof anchor.file !== "string" ||
      typeof anchor.template !== "string"
    ) {
      throw new Error(
        `${relative}: every anchor needs string file and template`,
      );
    }
    const ids = [...anchor.template.matchAll(PLACEHOLDER)].map(
      (found) => found[1],
    );
    if (ids.length === 0) {
      throw new Error(
        `${relative}: anchor in ${anchor.file} carries no {probe.id} placeholder; an anchor with nothing to compare is not a check`,
      );
    }
    for (const id of ids) {
      if (!byId.has(id)) {
        throw new Error(
          `${relative}: anchor in ${anchor.file} references probe id ${id}, which no probe declares`,
        );
      }
    }
    if (anchor.occurrences !== undefined) {
      if (!Number.isInteger(anchor.occurrences) || anchor.occurrences < 1) {
        throw new Error(
          `${relative}: anchor in ${anchor.file} declares occurrences ${anchor.occurrences}; it must be a positive integer`,
        );
      }
    }
  }
  return { probes, anchors, onProbeError };
}

/* ---------------------------------------------------------------- probing */

function measure(root, probes) {
  const observed = new Map();
  const unavailable = new Map();
  for (const probe of probes) {
    const [program, ...rest] = probe.command;
    const result = spawnSync(program, rest, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const printable = probe.command.join(" ");
    if (result.error) {
      unavailable.set(
        probe.id,
        `${printable} could not be spawned: ${result.error.message}`,
      );
      continue;
    }
    if (result.status !== 0) {
      unavailable.set(
        probe.id,
        `${printable} exited ${result.status}; refusing to compare documentation against the output of a failed command`,
      );
      continue;
    }
    let text = result.stdout;
    if (probe.capture !== undefined && probe.capture !== null) {
      const match = text.match(new RegExp(probe.capture, "m"));
      if (match === null || match[1] === undefined) {
        unavailable.set(
          probe.id,
          `${printable} produced output that capture ${probe.capture} did not match with a group 1`,
        );
        continue;
      }
      text = match[1];
    }
    const value = text.trim();
    if (!VALUE.test(value)) {
      unavailable.set(
        probe.id,
        `${printable} yielded ${JSON.stringify(value.slice(0, 60))}, which is not a number; this gate compares numeric literals only`,
      );
      continue;
    }
    observed.set(probe.id, value);
  }
  return { observed, unavailable };
}

/* ----------------------------------------------------------------- engine */

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compile(template) {
  const ids = [];
  let pattern = "";
  let cursor = 0;
  for (const match of template.matchAll(PLACEHOLDER)) {
    pattern += escapeRegExp(template.slice(cursor, match.index));
    ids.push(match[1]);
    pattern += VALUE_CAPTURE;
    cursor = match.index + match[0].length;
  }
  pattern += escapeRegExp(template.slice(cursor));
  return { ids, regex: new RegExp(pattern, "g") };
}

function fill(template, observed) {
  return template.replace(PLACEHOLDER, (whole, id) => observed.get(id));
}

function lineOf(body, index) {
  return body.slice(0, index).split("\n").length;
}

function describe(anchor) {
  const head = anchor.template.split("\n")[0];
  const shown = head.length > 80 ? `${head.slice(0, 80)}...` : head;
  return `${anchor.file}: ${shown}`;
}

/*
 * Compares one anchor against one document body. Separated from both the
 * checking and the writing entry points so that --write can never repair a
 * problem the check would have reported: a missing anchor or a wrong
 * occurrence count means the table and the document disagree about shape, and
 * only a human knows which of the two is wrong.
 */
function inspect(anchor, body, observed, unavailable) {
  const { ids, regex } = compile(anchor.template);
  const expectedOccurrences = anchor.occurrences ?? 1;
  const blocked = ids.filter((id) => unavailable.has(id));
  if (blocked.length > 0) {
    return {
      blocked: `${describe(anchor)} needs ${blocked.join(", ")}: ${unavailable.get(blocked[0])}`,
      structural: [],
      values: [],
    };
  }
  const matches = [...body.matchAll(regex)];
  if (matches.length !== expectedOccurrences) {
    return {
      blocked: null,
      values: [],
      structural: [
        `ANCHOR ${describe(anchor)} matched ${matches.length} time(s), the configuration declares ${expectedOccurrences}. Either the prose moved (fix the template) or a restatement was added or removed (fix the document). This gate refuses to pass an anchor it cannot locate exactly`,
      ],
    };
  }
  const values = [];
  for (const match of matches) {
    for (let index = 0; index < ids.length; index += 1) {
      const expected = observed.get(ids[index]);
      const actual = match[index + 1];
      if (expected === actual) continue;
      values.push(
        `VALUE ${anchor.file}:${lineOf(body, match.index)} states ${ids[index]} = ${actual}, the command reports ${expected}`,
      );
    }
  }
  return { blocked: null, structural: [], values };
}

function bodies(root, anchors) {
  const map = new Map();
  for (const anchor of anchors) {
    if (map.has(anchor.file)) continue;
    if (!fileExists(root, anchor.file)) {
      throw new Error(
        `anchor names ${anchor.file}, which does not exist under the workspace root`,
      );
    }
    map.set(anchor.file, readText(root, anchor.file));
  }
  return map;
}

/* -------------------------------------------------------------------- main */

function checkOnce(root, anchors, observed, unavailable, report) {
  const documents = bodies(root, anchors);
  let comparisons = 0;
  let located = 0;
  const skipped = [];
  for (const anchor of anchors) {
    const result = inspect(
      anchor,
      documents.get(anchor.file),
      observed,
      unavailable,
    );
    if (result.blocked !== null) {
      skipped.push(result.blocked);
      continue;
    }
    located += 1;
    comparisons +=
      compile(anchor.template).ids.length * (anchor.occurrences ?? 1);
    for (const problem of [...result.structural, ...result.values]) {
      report.fail("DF1", problem);
    }
  }
  return { comparisons, located, skipped, documentCount: documents.size };
}

function writeRounds(root, anchors, probes, maxRounds, report) {
  for (let round = 1; round <= maxRounds; round += 1) {
    const { observed, unavailable } = measure(root, probes);
    const documents = bodies(root, anchors);
    const structural = [];
    const edits = [];
    for (const anchor of anchors) {
      const body = documents.get(anchor.file);
      const result = inspect(anchor, body, observed, unavailable);
      if (result.blocked !== null) continue;
      if (result.structural.length > 0) {
        structural.push(...result.structural);
        continue;
      }
      if (result.values.length === 0) continue;
      const { regex } = compile(anchor.template);
      documents.set(
        anchor.file,
        body.replace(regex, fill(anchor.template, observed)),
      );
      edits.push(`${describe(anchor)} (${result.values.length} value(s))`);
    }
    if (structural.length > 0) {
      for (const problem of structural) report.fail("DF1", problem);
      report.detail(
        `round ${round}: structural problems found; nothing was written. Fix the anchors before retrying.`,
      );
      return { rounds: round, converged: false };
    }
    for (const [file, body] of documents) {
      if (readText(root, file) !== body) {
        writeFileSync(path.resolve(root, file), body);
      }
    }
    report.detail(`round ${round}: ${edits.length} anchor(s) rewritten`);
    for (const edit of edits) report.detail(`  ${edit}`);
    if (edits.length === 0) return { rounds: round, converged: true };
  }
  report.fail(
    "DF3",
    `no fixed point after ${maxRounds} round(s). The remaining quantities are self-referential in a way this loop cannot settle; re-run with --print-observed and compare by hand rather than assuming convergence`,
  );
  return { rounds: maxRounds, converged: false };
}

run(NAME, () => {
  const { flags, options } = parseArgv(process.argv.slice(2), {
    flags: ["--write", "--print-observed"],
  });
  if (flags.has("--help")) {
    help();
    return;
  }
  const root = resolveRoot(options);
  const report = new Report(NAME);
  const loaded = loadConfig(root, "doc-facts", options);
  if (!loaded.present) {
    report.finish(
      `no ${loaded.relative} in this workspace, so no documented fact is claimed and none is checked (0 probes, 0 anchors)`,
    );
    return;
  }
  const { probes, anchors, onProbeError } = validate(
    loaded.config,
    loaded.relative,
  );
  if (anchors.length === 0) {
    report.finish(
      `${loaded.relative} declares ${probes.length} probe(s) and 0 anchors, so there is nothing to compare`,
    );
    return;
  }

  if (flags.has("--print-observed")) {
    const { observed, unavailable } = measure(root, probes);
    for (const id of [...observed.keys()].sort(codePointOrder)) {
      process.stdout.write(`${id} = ${observed.get(id)}\n`);
    }
    for (const id of [...unavailable.keys()].sort(codePointOrder)) {
      process.stdout.write(`${id} = UNAVAILABLE (${unavailable.get(id)})\n`);
    }
    return;
  }

  const maxRounds = loaded.config.maxWriteRounds ?? DEFAULT_MAX_WRITE_ROUNDS;

  if (flags.has("--write")) {
    const { rounds, converged } = writeRounds(
      root,
      anchors,
      probes,
      maxRounds,
      report,
    );
    report.finish(
      converged
        ? `documented values reached a fixed point after ${rounds} round(s); every anchor now equals its command output`
        : `${rounds} write round(s) run without reaching a fixed point`,
    );
    return;
  }

  const { observed, unavailable } = measure(root, probes);
  if (onProbeError === "fail") {
    for (const id of [...unavailable.keys()].sort(codePointOrder)) {
      report.fail(
        "DF2",
        `probe ${id} could not be measured: ${unavailable.get(id)}. onProbeError is "fail", so this gate will not report a green run for values it did not re-measure`,
      );
    }
  }
  const { comparisons, located, skipped, documentCount } = checkOnce(
    root,
    anchors,
    observed,
    unavailable,
    report,
  );
  for (const note of skipped) report.detail(`skip - ${note}`);
  const referenced = new Set();
  for (const anchor of anchors) {
    for (const id of compile(anchor.template).ids) referenced.add(id);
  }
  const unreferenced = [...observed.keys()]
    .filter((id) => !referenced.has(id))
    .sort(codePointOrder);
  if (unreferenced.length > 0) {
    report.detail(
      `note - ${unreferenced.length} probe(s) measured but quoted nowhere: ${unreferenced.join(", ")}`,
    );
  }
  report.finish(
    `${comparisons} value comparison(s) over ${located} located anchor(s) in ${documentCount} document(s), ` +
      `${observed.size} probe(s) measured, ${unavailable.size} unavailable, ${skipped.length} anchor(s) skipped`,
  );
});
