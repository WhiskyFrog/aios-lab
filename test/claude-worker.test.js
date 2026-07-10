import assert from "node:assert/strict";
import test from "node:test";

import { extractPayload, validatePayload } from "../workers/claude-worker.mjs";

test("extractPayload accepts a reply that is exactly the JSON object", () => {
  const payload = extractPayload('{"summary":"done","verification":"ran tests"}');

  assert.deepEqual(payload, { summary: "done", verification: "ran tests" });
});

test("extractPayload accepts a reply wrapped in a markdown code fence", () => {
  const reply = ['```json', '{"decision":"approved"}', '```'].join("\n");

  assert.deepEqual(extractPayload(reply), { decision: "approved" });
});

test("extractPayload accepts a reply surrounded by prose", () => {
  const reply = 'Here is my answer:\n{"verdict":"pass","findings":"looks good"}\nThanks.';

  assert.deepEqual(extractPayload(reply), { verdict: "pass", findings: "looks good" });
});

test("extractPayload ignores stray prose braces that are not valid JSON", () => {
  const reply =
    'Note: {this is not json} the real reply is {"summary":"ok","verification":"checked"}';

  assert.deepEqual(extractPayload(reply), { summary: "ok", verification: "checked" });
});

test("extractPayload ignores braces nested inside a string value", () => {
  const reply = '{"summary":"uses a { character and a } too","verification":"checked"}';

  assert.deepEqual(extractPayload(reply), {
    summary: "uses a { character and a } too",
    verification: "checked",
  });
});

test("extractPayload returns null when no object can be found", () => {
  assert.equal(extractPayload("no JSON here at all"), null);
});

test("extractPayload returns null when multiple objects make extraction ambiguous", () => {
  const reply = 'First try: {"summary":"a","verification":"b"} second try: {"decision":"approved"}';

  assert.equal(extractPayload(reply), null);
});

test("extractPayload returns null for an unterminated object", () => {
  assert.equal(extractPayload('{"summary":"a","verification":"b"'), null);
});

test("validatePayload accepts a well-formed implementer reply", () => {
  assert.equal(
    validatePayload("implementer", { summary: "did work", verification: "ran suite" }),
    null,
  );
});

test("validatePayload rejects an implementer reply missing a key", () => {
  assert.match(
    validatePayload("implementer", { summary: "did work" }),
    /exactly summary and verification/,
  );
});

test("validatePayload accepts a well-formed reviewer reply", () => {
  assert.equal(
    validatePayload("reviewer", { verdict: "pass", findings: "all good" }),
    null,
  );
});

test("validatePayload rejects an invalid reviewer verdict", () => {
  assert.match(
    validatePayload("reviewer", { verdict: "maybe", findings: "all good" }),
    /verdict must be pass or changes_requested/,
  );
});

test("validatePayload accepts a well-formed approver reply", () => {
  assert.equal(validatePayload("approver", { decision: "approved" }), null);
});

test("validatePayload rejects an invalid approver decision", () => {
  assert.match(
    validatePayload("approver", { decision: "maybe" }),
    /decision must be approved or rejected/,
  );
});

test("validatePayload accepts a failure_reason reply for any role", () => {
  assert.equal(
    validatePayload("implementer", { failure_reason: "blocked on missing credentials" }),
    null,
  );
});

test("validatePayload rejects an empty failure_reason", () => {
  assert.match(
    validatePayload("reviewer", { failure_reason: "   " }),
    /failure_reason must be a non-empty string/,
  );
});

test("validatePayload rejects a non-object payload", () => {
  assert.match(validatePayload("implementer", null), /not a JSON object/);
});
