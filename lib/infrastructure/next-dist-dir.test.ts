import assert from "node:assert/strict";
import test from "node:test";
import { nextDistDir } from "./next-dist-dir.ts";

test("Next development and production builds use separate output directories", () => {
  const development = nextDistDir("phase-development-server");
  const production = nextDistDir("phase-production-build");

  assert.equal(development, ".next");
  assert.equal(production, ".next-build");
  assert.notEqual(development, production);
});

