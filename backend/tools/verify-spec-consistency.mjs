#!/usr/bin/env node

/*
 * GATE 2 - SPECIFICATION SELF-CONSISTENCY
 *
 * Two independent checks over the same document set, both refusing every
 * dependency except the documents themselves. No lockfile, no manifest, no
 * generated index, no `git` invocation: a specification set must be checkable
 * on a clean checkout with nothing built, or the check will be switched off the
 * first time it crashes on a machine that has not run the build.
 *
 *   GROUP B - PATH REFERENCES
 *     A `path` or `path:line` written in a document must resolve, and when it
 *     carries a line number that line must be shown to hold what the citing
 *     sentence says it holds.
 *
 *   GROUP E - RULE MARKERS
 *     Every normative sentence must declare how it is enforced, by carrying one
 *     of the verification-class markers the consumer defines. A document must
 *     also open and close with the two fixed sections that state its scope and
 *     the blast radius of changing it.
 *
 * WHY GROUP B DOES NOT STRIP THE LINE NUMBER
 *   The obvious implementation of a `path:line` checker deletes `:line` with a
 *   `replace(/:\d+$/, "")` and then asks whether the file exists. That checker
 *   passes on every line number in the repository, including the ones that
 *   drifted twenty lines when a section was inserted above them, and including
 *   the ones that now point past the end of the file. It reports a count of
 *   "references checked" that silently means "paths checked".
 *
 *   This gate takes the line number as part of the claim:
 *
 *     1. RANGE. The target file must actually have that line. Out of range is
 *        a failure, and it is the single most common outcome of deleting a
 *        section without re-checking who cited it.
 *     2. CONTENT. When the citing sentence states what stands at that line -
 *        by quoting it, or by naming a stable identifier that the target line
 *        carries - the target line must hold it. If the same content is found
 *        at a different line, the failure names the line it moved to, which is
 *        the whole repair.
 *     3. HONESTY. When the citing sentence states nothing checkable, the
 *        reference is reported as UNVERIFIED and counted separately in the
 *        summary. It is never folded into the verified count. A consumer who
 *        wants the stronger regime sets unverifiedPolicy to "fail"; the default
 *        reports, because forcing every citation in an existing document set to
 *        grow a quotation in one commit is how a useful gate gets reverted.
 *
 *   Point 3 is the reason this gate can be honest at all. "Verify the line or
 *   admit you did not" is cheap; "verify the line" alone is not implementable
 *   without inventing a claim the author never made.
 */

import {
  Report,
  codePointOrder,
  fileExists,
  listTree,
  loadConfig,
  matchesAny,
  parseArgv,
  readText,
  resolveRoot,
  run,
} from "../lib/kit.mjs";
import {
  codeSpans,
  headings,
  scanDocument,
  sectionLines,
  tableHeaderLines,
} from "../lib/markdown.mjs";

const NAME = "spec-consistency";

const DEFAULT_PATH_EXTENSIONS = [
  "cjs",
  "css",
  "csv",
  "html",
  "js",
  "json",
  "jsonl",
  "lock",
  "md",
  "mjs",
  "mts",
  "py",
  "sh",
  "sql",
  "svg",
  "toml",
  "ts",
  "tsv",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml",
];

function help() {
  process.stdout.write(
    [
      "node tools/verify-spec-consistency.mjs [--print-references]",
      "                                      [--root <dir>] [--config <path>]",
      "",
      "  Group B: every `path` and `path:line` written in the configured",
      "  documents resolves, and every line number is either shown to point at",
      "  the cited content or reported as unverified.",
      "  Group E: every normative sentence carries a verification-class marker,",
      "  and every document opens and closes with its two fixed sections.",
      "",
      "  --print-references  print one line per resolved path reference.",
      "",
    ].join("\n"),
  );
}

/* ------------------------------------------------------ document selection */

function collectDocuments(root, roots, extraDocuments, suffix) {
  const found = [];
  for (const relative of roots) {
    for (const file of listTree(root, relative)) {
      if (file.endsWith(suffix)) found.push(file);
    }
  }
  for (const extra of extraDocuments) {
    if (fileExists(root, extra)) found.push(extra);
  }
  return [...new Set(found)].sort(codePointOrder);
}

/* ------------------------------------------- group B: reference extraction */

const LINE_SUFFIX = /:(\d+)(?:-(\d+))?$/;

/*
 * Decides whether an inline code span is a path reference at all. The job is
 * to separate `governance/doc-facts.json` and `docs/standards/01-LAYOUT.md:12`
 * from `process.env`, `npm run verify`, `verify:spec` and `1.2.3`. Everything
 * rejected is counted by reason and printed, so the exclusions are auditable
 * instead of being a silent blanket.
 */
function classify(raw, extensions) {
  if (raw.includes("<") || raw.includes(">")) return "placeholder";
  if (/[\s`|(){}[\]="',;#$!?%&\\]/.test(raw)) return "prose";
  if (raw.startsWith("/")) return "absolute";
  if (raw.startsWith("~")) return "home-relative";
  if (raw.startsWith("./") || raw.startsWith("../")) return "module-specifier";
  if (raw.startsWith("node:")) return "module-specifier";
  if (/^\d+(\.\d+)+$/.test(raw)) return "version";
  if (/^\d+\/\d+$/.test(raw)) return "ratio";
  if (/@\d/.test(raw)) return "package-spec";
  if (/^@[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(raw)) return "package-spec";
  const withoutLine = raw.replace(LINE_SUFFIX, "").replace(/\/+$/, "");
  if (withoutLine.length === 0) return "prose";
  if (!withoutLine.includes("/")) {
    if (withoutLine.startsWith(".") || withoutLine.startsWith("-")) {
      return "extension-or-dotfile";
    }
    if (!withoutLine.includes(".")) return "bare-word";
    const extension = withoutLine.slice(withoutLine.lastIndexOf(".") + 1);
    if (!extensions.has(extension.toLowerCase())) return "identifier";
  }
  return "path";
}

/*
 * A glob is validated by its longest literal directory prefix: `assets/**`
 * asserts that `assets/` exists, `docs/adr/0*.md` that `docs/adr/` does. Anything
 * finer would require expanding the pattern, which is a different check.
 */
function resolvePath(root, reference, documentDirectory, resolveRoots) {
  const star = reference.indexOf("*");
  if (star >= 0) {
    const cut = reference.lastIndexOf("/", star);
    if (cut <= 0) return { resolved: null, how: null, glob: true };
    return resolvePath(
      root,
      reference.slice(0, cut),
      documentDirectory,
      resolveRoots,
    );
  }
  if (fileExists(root, reference))
    return { resolved: reference, how: "root", glob: false };
  const beside =
    documentDirectory === "." ? reference : `${documentDirectory}/${reference}`;
  if (fileExists(root, beside))
    return { resolved: beside, how: "beside-document", glob: false };
  for (const base of resolveRoots) {
    const candidate = base.length === 0 ? reference : `${base}/${reference}`;
    if (fileExists(root, candidate)) {
      return {
        resolved: candidate,
        how: `resolve-root ${base || "."}`,
        glob: false,
      };
    }
  }
  return { resolved: null, how: null, glob: false };
}

/*
 * The claim a citing sentence makes about the line it points at. Two forms,
 * both declared by the consumer:
 *   quote       `docs/x.md:12`（「exact text」） - the quotation nearest to the
 *               right of the reference, within claimWindow characters.
 *   identifier  a stable rule id present on the citing line, which the target
 *               line must also carry.
 * Quote wins when both are present: it is the stronger claim.
 */
function claimFor(line, span, settings) {
  if (settings.quotePattern !== null) {
    const pattern = new RegExp(settings.quotePattern, "g");
    let match = pattern.exec(line);
    while (match !== null) {
      const distance = match.index - span.end;
      if (distance >= 0 && distance <= settings.claimWindow) {
        return { kind: "quote", text: match[1] ?? match[0] };
      }
      match = pattern.exec(line);
    }
  }
  if (settings.identifierPattern !== null) {
    const ids = [
      ...line.matchAll(new RegExp(settings.identifierPattern, "g")),
    ].map((match) => match[0]);
    if (ids.length > 0) return { kind: "identifier", text: ids[0], all: ids };
  }
  return null;
}

function checkPathReferences(root, config, report) {
  const settings = {
    documentRoots: config.documentRoots ?? ["docs"],
    extraDocuments: config.extraDocuments ?? [],
    resolveRoots: config.resolveRoots ?? [""],
    extensions: new Set(config.pathExtensions ?? DEFAULT_PATH_EXTENSIONS),
    ignoreGlobs: config.ignoreGlobs ?? [],
    prescriptiveLinePattern:
      config.prescriptiveLinePattern === undefined
        ? null
        : new RegExp(config.prescriptiveLinePattern),
    quotePattern: config.quotePattern ?? null,
    identifierPattern: config.identifierPattern ?? null,
    claimWindow: config.claimWindow ?? 12,
    unverifiedPolicy: config.unverifiedPolicy ?? "report",
  };
  if (
    settings.unverifiedPolicy !== "report" &&
    settings.unverifiedPolicy !== "fail"
  ) {
    throw new Error(
      'pathReferences.unverifiedPolicy must be "report" or "fail"',
    );
  }
  const documents = collectDocuments(
    root,
    settings.documentRoots,
    settings.extraDocuments,
    ".md",
  );
  const skipped = new Map();
  const targets = new Map();
  const stats = {
    references: 0,
    withLine: 0,
    verified: 0,
    unverified: 0,
    prescriptive: 0,
    ignored: 0,
    globs: 0,
  };
  const printed = [];

  for (const document of documents) {
    const records = scanDocument(readText(root, document));
    const directory = document.includes("/")
      ? document.slice(0, document.lastIndexOf("/"))
      : ".";
    for (const record of records) {
      if (record.inFence) continue;
      for (const span of codeSpans(record.text)) {
        const raw = span.text;
        const disposition = classify(raw, settings.extensions);
        if (disposition !== "path") {
          skipped.set(disposition, (skipped.get(disposition) ?? 0) + 1);
          continue;
        }
        stats.references += 1;
        const location = `${document}:${record.number}`;
        const lineMatch = raw.match(LINE_SUFFIX);
        const pathPart = raw.replace(LINE_SUFFIX, "").replace(/\/+$/, "");
        if (matchesAny(pathPart, settings.ignoreGlobs)) {
          stats.ignored += 1;
          continue;
        }
        const { resolved, how, glob } = resolvePath(
          root,
          pathPart,
          directory,
          settings.resolveRoots,
        );
        if (glob) {
          stats.globs += 1;
          continue;
        }
        if (resolved === null) {
          if (
            settings.prescriptiveLinePattern !== null &&
            settings.prescriptiveLinePattern.test(record.text)
          ) {
            stats.prescriptive += 1;
            continue;
          }
          report.fail(
            "B1",
            `${location}: referenced path \`${raw}\` resolves to nothing; the document links to a file that does not exist`,
          );
          continue;
        }
        printed.push(`${location} -> ${resolved} (${how})`);
        if (lineMatch === null) continue;

        stats.withLine += 1;
        const targetLine = Number(lineMatch[1]);
        if (!targets.has(resolved)) {
          targets.set(resolved, readText(root, resolved).split("\n"));
        }
        const targetLines = targets.get(resolved);
        if (targetLine < 1 || targetLine > targetLines.length) {
          report.fail(
            "B2",
            `${location}: \`${raw}\` points at line ${targetLine}, but ${resolved} has ${targetLines.length} line(s). The citation outlived the lines it cited`,
          );
          continue;
        }
        const claim = claimFor(record.text, span, settings);
        if (claim === null) {
          stats.unverified += 1;
          const message = `${location}: \`${raw}\` names a line number, but the citing sentence states nothing that can be found at that line (no quotation within ${settings.claimWindow} characters, no stable identifier). The path resolves; the line number is UNVERIFIED`;
          if (settings.unverifiedPolicy === "fail") report.fail("B5", message);
          else report.warn("B5", message);
          continue;
        }
        const wanted = claim.kind === "identifier" ? claim.all : [claim.text];
        const hitHere = wanted.filter((needle) =>
          targetLines[targetLine - 1].includes(needle),
        );
        if (hitHere.length > 0) {
          stats.verified += 1;
          continue;
        }
        const elsewhere = [];
        for (const needle of wanted) {
          for (let index = 0; index < targetLines.length; index += 1) {
            if (targetLines[index].includes(needle)) {
              elsewhere.push(`${needle} at ${resolved}:${index + 1}`);
              break;
            }
          }
        }
        if (elsewhere.length > 0) {
          report.fail(
            "B3",
            `${location}: \`${raw}\` points at line ${targetLine}, but the ${claim.kind} it cites is at a different line - ${elsewhere.join(", ")}. Update the line number in the citing document`,
          );
          continue;
        }
        report.fail(
          "B4",
          `${location}: \`${raw}\` cites ${claim.kind} ${JSON.stringify(claim.text)}, which appears nowhere in ${resolved}. Either the citation is wrong or the cited content was deleted`,
        );
      }
    }
  }

  const skippedSummary = [...skipped.entries()]
    .sort((left, right) => codePointOrder(left[0], right[0]))
    .map(([key, count]) => `${key} ${count}`)
    .join(", ");
  report.detail(
    `B path references: ${documents.length} document(s), ${stats.references} path reference(s), ` +
      `${stats.withLine} carrying a line number, of which ${stats.verified} content-verified and ` +
      `${stats.unverified} UNVERIFIED (policy: ${settings.unverifiedPolicy}); ` +
      `${stats.prescriptive} prescriptive mention(s), ${stats.ignored} ignored by glob, ${stats.globs} glob pattern(s); ` +
      `non-path token(s) skipped: ${skippedSummary || "none"}`,
  );
  return { printed, stats, documentCount: documents.length };
}

/* --------------------------------------------- group E: normative markers */

function checkRuleMarkers(root, config, report) {
  const settings = {
    documentRoots: config.documentRoots ?? ["docs/standards"],
    extraDocuments: config.extraDocuments ?? [],
    modal: new RegExp(config.modalPattern),
    marker: new RegExp(config.markerPattern),
    openingSection: config.openingSection ?? null,
    closingSection: config.closingSection ?? null,
    excludeTableRows: config.excludeTableRows ?? false,
    excludeLinePattern:
      config.excludeLinePattern === undefined
        ? null
        : new RegExp(config.excludeLinePattern),
  };
  const documents = collectDocuments(
    root,
    settings.documentRoots,
    settings.extraDocuments,
    ".md",
  );
  const excluded = {
    heading: 0,
    boldOnlyLabel: 0,
    tableHeaderRow: 0,
    tableRow: 0,
    fixedSection: 0,
    configuredPattern: 0,
  };
  let ruleLines = 0;
  let unmarked = 0;

  for (const document of documents) {
    const records = scanDocument(readText(root, document));
    const topLevel = headings(records).filter((heading) => heading.level === 2);
    if (settings.openingSection !== null) {
      if (
        topLevel.length === 0 ||
        topLevel[0].text !== settings.openingSection
      ) {
        report.fail(
          "S1",
          `${document}: the first level-2 section is ${topLevel.length === 0 ? "absent" : JSON.stringify(topLevel[0].text)}, not ${JSON.stringify(settings.openingSection)}. A specification that does not state what it governs cannot be applied or refused`,
        );
      }
    }
    if (settings.closingSection !== null) {
      const last = topLevel[topLevel.length - 1];
      if (last === undefined || last.text !== settings.closingSection) {
        report.fail(
          "S2",
          `${document}: the last level-2 section is ${last === undefined ? "absent" : JSON.stringify(last.text)}, not ${JSON.stringify(settings.closingSection)}. A rule change with no stated blast radius gets applied by someone who cannot see what it breaks`,
        );
      }
    }
    const headerRows = tableHeaderLines(records);
    const fixedSections = sectionLines(
      records,
      (text) =>
        text === settings.openingSection || text === settings.closingSection,
    );
    for (const record of records) {
      if (record.inFence) continue;
      if (!settings.modal.test(record.text)) continue;
      if (record.isHeading) {
        excluded.heading += 1;
        continue;
      }
      if (record.isBoldOnlyLabel) {
        excluded.boldOnlyLabel += 1;
        continue;
      }
      if (record.isTableRow && headerRows.has(record.number)) {
        excluded.tableHeaderRow += 1;
        continue;
      }
      if (record.isTableRow && settings.excludeTableRows) {
        excluded.tableRow += 1;
        continue;
      }
      if (fixedSections.has(record.number)) {
        excluded.fixedSection += 1;
        continue;
      }
      if (
        settings.excludeLinePattern !== null &&
        settings.excludeLinePattern.test(record.text)
      ) {
        excluded.configuredPattern += 1;
        continue;
      }
      ruleLines += 1;
      if (settings.marker.test(record.text)) continue;
      unmarked += 1;
      report.fail(
        "E1",
        `${document}:${record.number}: normative sentence carries no verification-class marker. Every rule must declare how it is enforced, or nobody can tell a rule a machine checks from a rule nobody checks`,
      );
    }
  }

  const excludedSummary = Object.entries(excluded)
    .map(([key, count]) => `${key} ${count}`)
    .join(", ");
  report.detail(
    `E rule markers: ${documents.length} document(s), ${ruleLines} normative sentence(s) checked, ` +
      `${unmarked} without a marker; structural exclusions: ${excludedSummary}`,
  );
  return { documentCount: documents.length, ruleLines, unmarked };
}

/* -------------------------------------------------------------------- main */

run(NAME, () => {
  const { flags, options } = parseArgv(process.argv.slice(2), {
    flags: ["--print-references"],
  });
  if (flags.has("--help")) {
    help();
    return;
  }
  const root = resolveRoot(options);
  const report = new Report(NAME);
  const loaded = loadConfig(root, "spec-consistency", options);
  if (!loaded.present) {
    report.finish(
      `no ${loaded.relative} in this workspace, so no specification set is declared and none is checked (0 documents)`,
    );
    return;
  }
  const parts = [];
  let referenceResult = null;
  if (loaded.config.pathReferences !== undefined) {
    referenceResult = checkPathReferences(
      root,
      loaded.config.pathReferences,
      report,
    );
    parts.push(
      `group B ${referenceResult.stats.references} reference(s) over ${referenceResult.documentCount} document(s), ` +
        `${referenceResult.stats.verified}/${referenceResult.stats.withLine} line number(s) content-verified, ` +
        `${referenceResult.stats.unverified} unverified`,
    );
  }
  if (loaded.config.ruleMarkers !== undefined) {
    const markerResult = checkRuleMarkers(
      root,
      loaded.config.ruleMarkers,
      report,
    );
    parts.push(
      `group E ${markerResult.ruleLines} normative sentence(s) over ${markerResult.documentCount} document(s), ` +
        `${markerResult.unmarked} unmarked`,
    );
  }
  if (parts.length === 0) {
    parts.push(
      `${loaded.relative} enables neither pathReferences nor ruleMarkers, so nothing was checked`,
    );
  }
  if (flags.has("--print-references") && referenceResult !== null) {
    for (const line of referenceResult.printed)
      process.stdout.write(`${line}\n`);
  }
  report.finish(parts.join("; "));
});
