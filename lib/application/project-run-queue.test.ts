import assert from "node:assert/strict";
import test from "node:test";
import { createProjectRunQueue } from "./project-run-queue.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("project run queue processes one run at a time and ignores duplicates", async () => {
  const first = deferred();
  const order: string[] = [];
  let active = 0;
  let maxActive = 0;
  const queue = createProjectRunQueue(async (runId) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push(`start:${runId}`);
    if (runId === "r-1") await first.promise;
    order.push(`end:${runId}`);
    active -= 1;
  });

  queue.enqueue("r-1");
  queue.enqueue("r-1");
  queue.enqueue("r-2");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["start:r-1"]);

  first.resolve();
  await queue.idle();

  assert.equal(maxActive, 1);
  assert.deepEqual(order, ["start:r-1", "end:r-1", "start:r-2", "end:r-2"]);
});

test("a failed run does not stop the next queued run", async () => {
  const seen: string[] = [];
  const queue = createProjectRunQueue(async (runId) => {
    seen.push(runId);
    if (runId === "r-1") throw new Error("failed");
  });

  queue.enqueue("r-1");
  queue.enqueue("r-2");
  await queue.idle();

  assert.deepEqual(seen, ["r-1", "r-2"]);
});
