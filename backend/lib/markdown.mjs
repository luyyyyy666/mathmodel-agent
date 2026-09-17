/*
 * Markdown structural primitives.
 *
 * Subject (docs/standards/03-TOOL-SHAPE.md rule T-03): telling apart the parts
 * of a Markdown document that can carry a rule from the parts that cannot -
 * fences, headings, table scaffolding, inline code spans. No gate policy lives
 * here; the gates decide what to do with the structure this module reports.
 */

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(\s*>*\s*)(#{1,6})\s+(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR = /^\s*\|[\s:|-]+\|\s*$/;
const BOLD_ONLY = /^\s*\*\*[^*]+\*\*\s*$/;

/*
 * One record per line. `inFence` is true for the content of a fenced block and
 * for the fence markers themselves: a gate must never read a rule, a path or a
 * measured number out of a code sample, because a code sample is an
 * illustration of something and not an assertion about this repository.
 */
export function scanDocument(text) {
  const lines = text.split("\n");
  const records = [];
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const isFenceMarker = FENCE.test(raw);
    if (isFenceMarker) inFence = !inFence;
    const heading = raw.match(HEADING);
    records.push({
      number: index + 1,
      text: raw,
      inFence: inFence || isFenceMarker,
      isHeading: !inFence && !isFenceMarker && heading !== null,
      headingLevel: heading === null ? null : heading[2].length,
      headingText: heading === null ? null : heading[3].trim(),
      isTableRow: !inFence && !isFenceMarker && TABLE_ROW.test(raw),
      isTableSeparator: !inFence && TABLE_SEPARATOR.test(raw),
      isBoldOnlyLabel: BOLD_ONLY.test(raw),
    });
  }
  return records;
}

/*
 * A table's first row is its column titles when the row directly below it is
 * the `|---|---|` separator. Column titles are labels, not rules, however many
 * modal words they contain.
 */
export function tableHeaderLines(records) {
  const headers = new Set();
  for (let index = 0; index < records.length; index += 1) {
    if (!records[index].isTableRow) continue;
    if (records[index].isTableSeparator) continue;
    if (records[index + 1]?.isTableSeparator)
      headers.add(records[index].number);
  }
  return headers;
}

/*
 * Line numbers belonging to a section whose heading text matches `predicate`,
 * where a section runs to the next heading of equal or shallower depth. Used
 * for the fixed opening and closing sections a document must carry, whose
 * prose states what the document covers rather than what a reader must do.
 */
export function sectionLines(records, predicate) {
  const covered = new Set();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record.isHeading) continue;
    if (!predicate(record.headingText, record.headingLevel)) continue;
    for (let cursor = index + 1; cursor < records.length; cursor += 1) {
      const inner = records[cursor];
      if (inner.isHeading && inner.headingLevel <= record.headingLevel) break;
      covered.add(inner.number);
    }
  }
  return covered;
}

export function headings(records) {
  return records
    .filter((record) => record.isHeading)
    .map((record) => ({
      number: record.number,
      level: record.headingLevel,
      text: record.headingText,
    }));
}

/*
 * Inline code spans, with the column each one starts at. A path reference is
 * only ever read out of a code span: unbackticked prose that happens to look
 * like a path is prose, and treating it as a reference is how a documentation
 * link checker earns its reputation for noise.
 */
export function codeSpans(line) {
  const spans = [];
  const pattern = /`([^`\n]+)`/g;
  let match = pattern.exec(line);
  while (match !== null) {
    spans.push({ text: match[1], start: match.index, end: pattern.lastIndex });
    match = pattern.exec(line);
  }
  return spans;
}
