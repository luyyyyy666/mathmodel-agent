import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");
const schemaRoot = path.join(root, "contracts/v1");

function typeMatches(value, type) {
  if (Array.isArray(type))
    return type.some((candidate) => typeMatches(value, candidate));
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object")
    return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number")
    return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function loadSchema(schemaPath) {
  return JSON.parse(readFileSync(schemaPath, "utf8"));
}

function validate(value, schema, schemaPath, trail = "$", seen = new Set()) {
  if (schema.$ref) {
    const target = path.resolve(path.dirname(schemaPath), schema.$ref);
    const key = `${target}:${trail}`;
    if (seen.has(key)) throw new Error(`cyclic $ref at ${trail}`);
    return validate(
      value,
      loadSchema(target),
      target,
      trail,
      new Set(seen).add(key),
    );
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((candidate) => {
      try {
        validate(value, candidate, schemaPath, trail, seen);
        return true;
      } catch {
        return false;
      }
    });
    if (matches.length !== 1)
      throw new Error(`${trail} must match exactly one oneOf branch`);
  }
  if (schema.const !== undefined && value !== schema.const)
    throw new Error(`${trail} must equal ${JSON.stringify(schema.const)}`);
  if (
    schema.enum &&
    !schema.enum.some((candidate) => Object.is(candidate, value))
  )
    throw new Error(`${trail} must be one of ${schema.enum.join(", ")}`);
  if (schema.type && !typeMatches(value, schema.type))
    throw new Error(`${trail} has invalid type`);
  if (typeof value === "string") {
    if (schema.minLength !== undefined && [...value].length < schema.minLength)
      throw new Error(`${trail} is too short`);
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength)
      throw new Error(`${trail} is too long`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value))
      throw new Error(`${trail} has invalid format`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum)
      throw new Error(`${trail} is below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum)
      throw new Error(`${trail} is above maximum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      throw new Error(`${trail} has too few items`);
    if (schema.uniqueItems) {
      const encoded = value.map((item) => JSON.stringify(item));
      if (new Set(encoded).size !== encoded.length)
        throw new Error(`${trail} must contain unique items`);
    }
    if (schema.items)
      value.forEach((item, index) =>
        validate(item, schema.items, schemaPath, `${trail}[${index}]`, seen),
      );
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const name of schema.required ?? [])
      if (!Object.hasOwn(value, name))
        throw new Error(`${trail} is missing required property ${name}`);
    if (schema.additionalProperties === false)
      for (const name of Object.keys(value))
        if (!Object.hasOwn(schema.properties ?? {}, name))
          throw new Error(`${trail} has additional property ${name}`);
    for (const [name, child] of Object.entries(schema.properties ?? {}))
      if (Object.hasOwn(value, name))
        validate(value[name], child, schemaPath, `${trail}.${name}`, seen);
  }
}

const valid = {
  checkpoint_id: "checkpoint-1",
  run_id: "run-1",
  step_id: "step-1",
  kind: "model_approval",
  status: "pending",
  allowed_actions: ["approve", "request_changes", "cancel"],
  payload: { message: "请确认模型假设", artifact_ids: ["model-v1"] },
  resolved_action: null,
};
const relative = "checkpoint.schema.json";

test("checkpoint.schema.json: valid sample passes", () => {
  const schemaPath = path.join(schemaRoot, relative);
  assert.doesNotThrow(() =>
    validate(valid, loadSchema(schemaPath), schemaPath),
  );
});

test("checkpoint.schema.json: missing required and extra property fail", () => {
  const schemaPath = path.join(schemaRoot, relative);
  const schema = loadSchema(schemaPath);
  for (const required of schema.required ?? schema.oneOf[0].required) {
    const missing = { ...valid };
    delete missing[required];
    assert.throws(
      () => validate(missing, schema, schemaPath),
      /missing required|oneOf branch/,
    );
  }
  const extra = { ...valid, unexpected: true };
  assert.throws(
    () => validate(extra, schema, schemaPath),
    /additional property|oneOf branch/,
  );
});

test("checkpoint.schema.json: enum constraints reject invalid kind", () => {
  const schemaPath = path.join(schemaRoot, relative);
  assert.throws(
    () =>
      validate(
        { ...valid, kind: "unknown" },
        loadSchema(schemaPath),
        schemaPath,
      ),
    /one of/,
  );
});

function accepts(changes) {
  const schemaPath = path.join(schemaRoot, relative);
  assert.doesNotThrow(() =>
    validate({ ...valid, ...changes }, loadSchema(schemaPath), schemaPath),
  );
}

function rejects(changes, expected) {
  const schemaPath = path.join(schemaRoot, relative);
  assert.throws(
    () =>
      validate({ ...valid, ...changes }, loadSchema(schemaPath), schemaPath),
    expected,
  );
}
