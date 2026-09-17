import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const schema = JSON.parse(
  readFileSync(
    new URL("../contracts/v2/core.schema.json", import.meta.url),
    "utf8",
  ),
);
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addSchema(schema);
const validators = new Map();
export function validate(kind, value) {
  if (!validators.has(kind)) {
    validators.set(kind, ajv.compile({ $ref: `${schema.$id}#/$defs/${kind}` }));
  }
  const check = validators.get(kind);
  if (!check(value)) {
    throw new DomainError(
      "invalid_request",
      `${kind}: ${ajv.errorsText(check.errors)}`.slice(0, 2000),
    );
  }
  return value;
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
