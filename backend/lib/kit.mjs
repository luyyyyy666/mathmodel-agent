/*
 * Shared primitives for the gates in tools/.
 *
 * WHY A SHARED MODULE EXISTS AT ALL
 *   docs/standards/03-TOOL-SHAPE.md rule T-03 allows exactly one kind of
 *   sharing: a module under lib/ with a stated, narrow subject. This file's
 *   subject is "how a gate finds its workspace, reads its configuration, and
 *   reports". It deliberately holds no check logic: a reader who wants to know
 *   what a gate asserts reads that gate's own file and nothing else.
 *
 * WHY THE WORKSPACE IS THE CURRENT DIRECTORY, NOT THE PACKAGE DIRECTORY
 *   These gates are shipped as a package and run against a repository that is
 *   not this package. Resolving the workspace relative to the tool file (the
 *   usual `path.resolve(import.meta.dirname, "..")`) would make every gate
 *   inspect the package's own tree instead of the consumer's. Precedence:
 *   --root <dir>, then GOVERNANCE_ROOT, then process.cwd().
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export const CONFIG_DIRECTORY = "governance";

export function codePointOrder(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/*
 * Splits argv into bare flags (--write) and options (--root <dir>). An unknown
 * flag throws: a gate that silently ignores a misspelled flag reports a green
 * run for a check the caller did not actually request.
 */
export function parseArgv(argv, { flags = [], options = [] } = {}) {
  const knownFlags = new Set([...flags, "--help"]);
  const knownOptions = new Set([...options, "--root", "--config"]);
  const seenFlags = new Set();
  const seenOptions = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const equals = token.indexOf("=");
    const name = equals > 0 ? token.slice(0, equals) : token;
    if (knownOptions.has(name)) {
      const value = equals > 0 ? token.slice(equals + 1) : argv[(index += 1)];
      if (value === undefined) {
        throw new Error(`${name} needs a value`);
      }
      seenOptions.set(name, value);
      continue;
    }
    if (!knownFlags.has(token)) {
      const supported = [...knownFlags, ...knownOptions].sort(codePointOrder);
      throw new Error(
        `unknown argument ${token}; supported arguments are ${supported.join(", ")}`,
      );
    }
    seenFlags.add(token);
  }
  return { flags: seenFlags, options: seenOptions };
}

export function resolveRoot(options) {
  const explicit = options.get("--root") ?? process.env.GOVERNANCE_ROOT;
  const root = path.resolve(explicit ?? process.cwd());
  if (!existsSync(root)) {
    throw new Error(`workspace root ${root} does not exist`);
  }
  return root;
}

/*
 * A gate whose configuration file is absent has nothing to assert, and an
 * empty repository is the case where that happens. `present: false` is the
 * signal to print an ok line and stop: docs/standards/00-PRINCIPLES.md rule
 * P-05 forbids a gate from crashing on the state it is meant to bootstrap.
 */
export function loadConfig(root, basename, options) {
  const relative =
    options.get("--config") ?? `${CONFIG_DIRECTORY}/${basename}.json`;
  const absolute = path.resolve(root, relative);
  if (!existsSync(absolute)) {
    return { present: false, relative, absolute, config: null };
  }
  let config;
  try {
    config = JSON.parse(readFileSync(absolute, "utf8"));
  } catch (cause) {
    throw new Error(
      `${relative} is not valid JSON and could not be parsed: ${cause.message}`,
    );
  }
  if (config === null || typeof config !== "object") {
    throw new Error(`${relative} must contain a JSON object`);
  }
  return { present: true, relative, absolute, config };
}

export function readText(root, relative) {
  return readFileSync(path.resolve(root, relative), "utf8");
}

export function fileExists(root, relative) {
  return existsSync(path.resolve(root, relative));
}

export function byteLength(root, relative) {
  return statSync(path.resolve(root, relative)).size;
}

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/*
 * Depth-first walk returning repository-relative POSIX paths, sorted by code
 * point so that every gate's output is byte-identical across runs and across
 * file systems that enumerate in different orders.
 */
export function listTree(root, relative, { skip = () => false } = {}) {
  const found = [];
  const walk = (current) => {
    const absolute = path.resolve(root, current);
    if (!existsSync(absolute)) return;
    const entries = readdirSync(absolute, { withFileTypes: true }).sort(
      (left, right) => codePointOrder(left.name, right.name),
    );
    for (const entry of entries) {
      const child = current === "" ? entry.name : `${current}/${entry.name}`;
      if (skip(child, entry.isDirectory())) continue;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) found.push(child);
    }
  };
  walk(relative);
  return found;
}

/*
 * The one glob dialect these gates accept, defined here once so no gate
 * invents a second one: `**` spans directory separators, `*` and `?` do not,
 * everything else is literal. Anything richer belongs in a real matcher, and
 * pulling in a real matcher would break the zero-dependency rule (T-02).
 */
export function globToRegExp(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }
    source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

export function matchesAny(relative, patterns) {
  return patterns.some((pattern) => globToRegExp(pattern).test(relative));
}

/*
 * Report accumulator. The output contract is docs/standards/03-TOOL-SHAPE.md
 * rule T-07: every detail line and every failure goes to stderr, stdout
 * carries exactly one `ok - ` line and only when the gate passed. A caller can
 * therefore treat stdout as a machine-readable verdict without parsing noise.
 */
export class Report {
  constructor(name) {
    this.name = name;
    this.failures = [];
    this.warnings = [];
  }

  detail(text) {
    process.stderr.write(`${text}\n`);
  }

  fail(code, message) {
    this.failures.push(`${code}: ${message}`);
  }

  warn(code, message) {
    this.warnings.push(`${code}: ${message}`);
  }

  /*
   * Failure exits through process.exitCode, never process.exit(). T-09: an
   * abrupt exit can truncate a pending stdout write, which turns a reported
   * failure into a silent one on a pipe.
   */
  finish(summary) {
    for (const warning of this.warnings.sort(codePointOrder)) {
      process.stderr.write(`warn - ${warning}\n`);
    }
    for (const failure of this.failures.sort(codePointOrder)) {
      process.stderr.write(`fail - ${failure}\n`);
    }
    if (this.failures.length > 0) {
      process.stderr.write(
        `fail - ${this.name}: ${this.failures.length} violation(s); ${summary}\n`,
      );
      process.exitCode = 1;
      return false;
    }
    process.stdout.write(`ok - ${this.name}: ${summary}\n`);
    return true;
  }
}

/*
 * Turns a thrown error into the same exit discipline as a check failure.
 * Without this a configuration typo produces a stack trace and exit code 1
 * that looks nothing like the gate's own failure format.
 */
export function run(name, body) {
  try {
    body();
  } catch (cause) {
    process.stderr.write(`fail - ${name}: ${cause.message}\n`);
    process.exitCode = 1;
  }
}
