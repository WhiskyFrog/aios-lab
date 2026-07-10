import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { approvalFilePath, readDecision } from "../workers/human-approver.mjs";

async function withTempDir(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "human-approver-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("approvalFilePath points at .aios/approvals/<task-id> under cwd", () => {
  assert.equal(
    approvalFilePath("task-0006", "C:\\repo"),
    path.join("C:\\repo", ".aios", "approvals", "task-0006"),
  );
});

test("readDecision returns success for an approved decision file", async () => {
  await withTempDir(async (dir) => {
    await mkdir(path.join(dir, ".aios", "approvals"), { recursive: true });
    await writeFile(path.join(dir, ".aios", "approvals", "task-0006"), "approved");

    assert.deepEqual(await readDecision("task-0006", dir), {
      status: "success",
      payload: { decision: "approved" },
    });
  });
});

test("readDecision returns success for a rejected decision file with surrounding whitespace", async () => {
  await withTempDir(async (dir) => {
    await mkdir(path.join(dir, ".aios", "approvals"), { recursive: true });
    await writeFile(path.join(dir, ".aios", "approvals", "task-0006"), "  rejected\n");

    assert.deepEqual(await readDecision("task-0006", dir), {
      status: "success",
      payload: { decision: "rejected" },
    });
  });
});

test("readDecision returns a failure naming the path and accepted contents when the file is missing", async () => {
  await withTempDir(async (dir) => {
    const result = await readDecision("task-0006", dir);

    assert.equal(result.status, "failure");
    assert.match(
      result.payload.reason,
      new RegExp(
        path.join(dir, ".aios", "approvals", "task-0006").replace(/\\/g, "\\\\"),
      ),
    );
    assert.match(result.payload.reason, /"approved"/);
    assert.match(result.payload.reason, /"rejected"/);
  });
});

test("readDecision returns a failure that quotes invalid file content", async () => {
  await withTempDir(async (dir) => {
    await mkdir(path.join(dir, ".aios", "approvals"), { recursive: true });
    await writeFile(path.join(dir, ".aios", "approvals", "task-0006"), "maybe later");

    assert.deepEqual(await readDecision("task-0006", dir), {
      status: "failure",
      payload: { reason: 'invalid decision file content: "maybe later"' },
    });
  });
});
