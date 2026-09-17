import assert from "node:assert/strict";
import test from "node:test";
import { canonical, validate, DomainError } from "../../server/contracts.mjs";

test("canonical command digests ignore property order but preserve content", () => {
  assert.equal(
    canonical({ b: [1, 2], a: { z: 3 } }),
    canonical({ a: { z: 3 }, b: [1, 2] }),
  );
  assert.notEqual(canonical({ b: [1, 2] }), canonical({ b: [2, 1] }));
});
test("invalid external commands produce bounded domain errors", () => {
  assert.throws(
    () => validate("command", { command: "shell", text: "x".repeat(20000) }),
    (error) =>
      error instanceof DomainError &&
      error.code === "invalid_request" &&
      error.message.length <= 2000,
  );
});
