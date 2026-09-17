import assert from "node:assert/strict";
import test from "node:test";
import {
  codeSpans,
  headings,
  scanDocument,
  sectionLines,
  tableHeaderLines,
} from "../../lib/markdown.mjs";

const document = [
  "# Title",
  "",
  "## Scope",
  "",
  "Prose that MUST be excluded because it sits in the scope section.",
  "",
  "## Rules",
  "",
  "A rule line that MUST carry a marker.",
  "",
  "| Column | Meaning |",
  "| --- | --- |",
  "| a | MUST be a data row |",
  "",
  "```text",
  "Inside a fence a rule MUST NOT be seen.",
  "```",
  "",
  "## Impact",
  "",
  "Closing prose.",
].join("\n");

test("scanDocument marks fenced lines, including the fence markers", () => {
  const records = scanDocument(document);
  const fenced = records
    .filter((record) => record.inFence)
    .map((record) => record.number);
  assert.deepEqual(fenced, [15, 16, 17]);
});

test("scanDocument identifies headings with their level and text", () => {
  const found = headings(scanDocument(document));
  assert.deepEqual(
    found.map((heading) => `${heading.level}:${heading.text}`),
    ["1:Title", "2:Scope", "2:Rules", "2:Impact"],
  );
});

test("tableHeaderLines picks the row above the separator and nothing else", () => {
  const records = scanDocument(document);
  assert.deepEqual([...tableHeaderLines(records)], [11]);
  assert.equal(records[11].number, 12);
  assert.equal(records[11].isTableSeparator, true);
  assert.equal(records[11].isTableRow, true);
  assert.equal(records[12].isTableSeparator, false);
});

test("sectionLines covers a section up to the next heading of equal depth", () => {
  const records = scanDocument(document);
  const covered = sectionLines(records, (text) => text === "Scope");
  assert.deepEqual(
    [...covered].sort((left, right) => left - right),
    [4, 5, 6],
  );
  assert.equal(covered.has(9), false);
});

test("codeSpans returns each span with the column it starts at", () => {
  const spans = codeSpans("see `docs/a.md:12` and `lib/kit.mjs`");
  assert.deepEqual(
    spans.map((span) => span.text),
    ["docs/a.md:12", "lib/kit.mjs"],
  );
  assert.equal(spans[0].start, 4);
  assert.equal(spans[1].start > spans[0].end, true);
  assert.deepEqual(codeSpans("no spans here"), []);
});
