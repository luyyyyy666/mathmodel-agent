#!/usr/bin/env node

/*
 * GATE 3 - TEST COVERAGE POLICY
 *
 * WHAT AN EMPTY TEST RUN CANNOT TELL YOU
 *   A test runner pointed at a glob that matches nothing prints "0 tests" and
 *   exits 0. Two very different repository states produce that identical
 *   green:
 *     (a) every source module is judged by something other than a unit case -
 *         a differential oracle, a golden-output comparison, a property run,
 *         a generator that regenerates it - and the empty glob is correct;
 *     (b) somebody authored a module, no such judgement exists, the case was
 *         never written, and the empty glob is a hole.
 *   The runner cannot tell (a) from (b). This gate is the missing
 *   discriminator, and it is the whole reason it exists.
 *
 * THE OBLIGATION
 *   Every source file must be on exactly one of two sides:
 *     DECLARED    a rule in governance/test-coverage.json names it and states
 *                 what judges it instead of a mirrored case. The declaration
 *                 must carry a reason; a criterion with no reason is a mute
 *                 exemption, and mute exemptions grow.
 *     MIRRORED    a test file exists at the path the mapping rule derives.
 *   Neither is a failure that names the file. Both at once is a failure only
 *   when the consumer sets alternateCriteriaForbidTests, which is the right
 *   setting when the alternate criterion is the authority and a hand-written
 *   case would quietly become a weaker second opinion.
 *
 * WHY DECLARATIONS ARE PATHS AND NOT A LIST OF FILES
 *   A per-file exemption list is a place to append to. A pattern plus a stated
 *   reason is a place to argue with: adding a file under `generated/**` is
 *   covered by a reason a reviewer already accepted, and adding one outside it
 *   fails until somebody writes down why.
 *
 * NOTHING PROJECT-SPECIFIC IS COMPILED IN: roots, extensions, the mapping rule
 * and the criteria all come from the configuration file, and a workspace
 * without one exits 0.
 */

import {
  Report,
  codePointOrder,
  fileExists,
  listTree,
  loadConfig,
  matchesAny,
  parseArgv,
  resolveRoot,
  run,
} from "../lib/kit.mjs";

const NAME = "test-coverage-policy";

function help() {
  process.stdout.write(
    [
      "node tools/verify-test-coverage-policy.mjs [--print-classification]",
      "                                          [--root <dir>] [--config <path>]",
      "",
      "  Splits the configured source roots into files judged by a declared",
      "  alternate criterion and files that need a mirrored test case, then",
      "  enforces the obligation each side carries. This is what tells an empty",
      "  test glob apart from a missing test.",
      "",
      "  --print-classification  print one line per source file, then verify.",
      "",
    ].join("\n"),
  );
}

function validate(config, relative) {
  const sourceRoots = config.sourceRoots ?? [];
  if (!Array.isArray(sourceRoots)) {
    throw new Error(`${relative}: sourceRoots must be an array`);
  }
  const extensions = config.sourceExtensions ?? [".mjs", ".js", ".ts"];
  const testRoot = config.testRoot ?? "tests";
  const testSuffix = config.testSuffix ?? ".test.mjs";
  const criteria = config.alternateCriteria ?? [];
  if (!Array.isArray(criteria)) {
    throw new Error(`${relative}: alternateCriteria must be an array`);
  }
  for (const criterion of criteria) {
    if (typeof criterion.id !== "string" || criterion.id.length === 0) {
      throw new Error(`${relative}: every alternateCriteria entry needs an id`);
    }
    if (!Array.isArray(criterion.paths) || criterion.paths.length === 0) {
      throw new Error(
        `${relative}: alternate criterion ${criterion.id} needs a non-empty paths array of glob patterns`,
      );
    }
    if (
      typeof criterion.reason !== "string" ||
      criterion.reason.trim().length === 0
    ) {
      throw new Error(
        `${relative}: alternate criterion ${criterion.id} needs a non-empty reason. An exemption whose reason is unwritten cannot be reviewed and will be copied by the next one`,
      );
    }
  }
  return {
    sourceRoots,
    extensions,
    testRoot,
    testSuffix,
    criteria,
    ignoreGlobs: config.ignoreGlobs ?? [],
    forbidTests: config.alternateCriteriaForbidTests ?? false,
  };
}

function testPathFor(relative, settings) {
  const dot = relative.lastIndexOf(".");
  const stem =
    dot > relative.lastIndexOf("/") ? relative.slice(0, dot) : relative;
  return `${settings.testRoot}/${stem}${settings.testSuffix}`;
}

function sourceStemFor(testRelative, settings) {
  const prefix = `${settings.testRoot}/`;
  if (!testRelative.startsWith(prefix)) return null;
  if (!testRelative.endsWith(settings.testSuffix)) return null;
  return testRelative.slice(prefix.length, -settings.testSuffix.length);
}

run(NAME, () => {
  const { flags, options } = parseArgv(process.argv.slice(2), {
    flags: ["--print-classification"],
  });
  if (flags.has("--help")) {
    help();
    return;
  }
  const root = resolveRoot(options);
  const report = new Report(NAME);
  const loaded = loadConfig(root, "test-coverage", options);
  if (!loaded.present) {
    report.finish(
      `no ${loaded.relative} in this workspace, so no source root is declared and no coverage obligation exists (0 source files)`,
    );
    return;
  }
  const settings = validate(loaded.config, loaded.relative);

  const sources = [];
  const otherExtension = [];
  for (const relative of settings.sourceRoots) {
    for (const file of listTree(root, relative)) {
      if (matchesAny(file, settings.ignoreGlobs)) continue;
      if (settings.extensions.some((extension) => file.endsWith(extension))) {
        sources.push(file);
      } else {
        otherExtension.push(file);
      }
    }
  }
  sources.sort(codePointOrder);

  const tests = listTree(root, settings.testRoot)
    .filter((file) => !matchesAny(file, settings.ignoreGlobs))
    .sort(codePointOrder);
  const testSet = new Set(tests);

  const classification = new Map();
  const counts = { declared: 0, mirrored: 0, both: 0, uncovered: 0 };
  for (const relative of sources) {
    const criterion = settings.criteria.find((entry) =>
      matchesAny(relative, entry.paths),
    );
    const expected = testPathFor(relative, settings);
    const hasTest = testSet.has(expected);
    if (criterion !== undefined && hasTest) counts.both += 1;
    else if (criterion !== undefined) counts.declared += 1;
    else if (hasTest) counts.mirrored += 1;
    else counts.uncovered += 1;
    classification.set(relative, { criterion, expected, hasTest });

    if (criterion === undefined && !hasTest) {
      report.fail(
        "TC1",
        `${relative} has neither a mirrored case at ${expected} nor an alternate criterion in ${loaded.relative}. The test run cannot see this: its glob simply matches one fewer file and still exits 0. Write the case, or declare and justify what judges this file instead`,
      );
      continue;
    }
    if (criterion !== undefined && hasTest && settings.forbidTests) {
      report.fail(
        "TC2",
        `${expected} exists, but ${relative} is judged by alternate criterion ${criterion.id} (${criterion.reason}), and alternateCriteriaForbidTests is set. Delete the case; the declared criterion is the gate, and a second weaker opinion beside it is where the two start disagreeing`,
      );
    }
  }

  for (const relative of tests) {
    if (!relative.endsWith(settings.testSuffix)) {
      report.fail(
        "TC3",
        `${relative} is under ${settings.testRoot}/ but does not end with ${settings.testSuffix}, so the mapping rule cannot pair it with any source file`,
      );
      continue;
    }
    const stem = sourceStemFor(relative, settings);
    const subjects = settings.extensions
      .map((extension) => `${stem}${extension}`)
      .filter((candidate) => fileExists(root, candidate));
    if (subjects.length === 0) {
      report.fail(
        "TC4",
        `${relative} mirrors ${stem}.<ext>, which does not exist for any configured source extension (${settings.extensions.join(", ")}). This case gates nothing`,
      );
    }
  }

  if (flags.has("--print-classification")) {
    for (const relative of sources) {
      const verdict = classification.get(relative);
      const side =
        verdict.criterion !== undefined
          ? `declared:${verdict.criterion.id}`
          : verdict.hasTest
            ? "mirrored"
            : "uncovered";
      process.stdout.write(`${side.padEnd(24)} ${relative}\n`);
    }
  }

  report.finish(
    `${sources.length} source file(s) over ${settings.sourceRoots.length} root(s): ` +
      `${counts.mirrored} with a mirrored case, ${counts.declared} under a declared alternate criterion, ` +
      `${counts.both} with both, ${counts.uncovered} uncovered; ` +
      `${tests.length} file(s) under ${settings.testRoot}/, ` +
      `${otherExtension.length} file(s) skipped for extension, ${settings.criteria.length} criterion(s) declared`,
  );
});
