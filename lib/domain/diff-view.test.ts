import assert from "node:assert/strict";
import test from "node:test";
import { createTwoFilesPatch } from "diff";
import { presentDiff } from "./diff-view.ts";

test("diff view counts changed lines and preserves old and new positions", () => {
  const patch = createTwoFilesPatch("before", "after", "first\nold\nlast\n", "first\nnew\nlast\n");
  const result = presentDiff(patch);

  assert.equal(result.additions, 1);
  assert.equal(result.deletions, 1);
  assert.deepEqual(
    result.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.kind === "add" || line.kind === "remove"),
    [
      { kind: "remove", oldLine: 2, newLine: null, text: "old" },
      { kind: "add", oldLine: null, newLine: 2, text: "new" },
    ],
  );
});
