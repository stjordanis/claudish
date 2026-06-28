/**
 * op-source — the lazy 1Password seam behind the credential authority.
 *
 * These tests cover op-source's UNIQUE, mock-free contract: the SYNC laziness
 * gate (hasOpSources) and the short-circuits in resolveOpKeyForEnvVars that
 * return BEFORE any 1Password module/SDK is touched. The deep resolution
 * primitives (collectConfigImports / resolveGlobImportForEnvVars / resolveSecrets)
 * are exhaustively tested in providers/onepassword.test.ts; the full resolve path
 * against real 1Password is exercised by the manual scratch-op-hydrate-check probe.
 *
 * Deliberately NO `mock.module` here: Bun's module mocks are process-global and
 * would bleed into sibling files (providers/onepassword.test.ts, the lazy test)
 * in a full `bun test` run. Everything asserted below is hermetic via argv + an
 * empty wanted-set, so no mock is needed.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  hasOpSources,
  resolveOpKeyForEnvVars,
  __resetSniffForTests,
  __resetResolveCacheForTests,
} from "./op-source.js";

let savedArgv: string[];

beforeEach(() => {
  savedArgv = process.argv;
  __resetSniffForTests();
  __resetResolveCacheForTests();
});

afterEach(() => {
  process.argv = savedArgv;
  __resetSniffForTests();
  __resetResolveCacheForTests();
});

describe("hasOpSources() — the sync laziness gate", () => {
  // The no-flag case reads the real ~/.claudish/config.json (the sniff reads the
  // file directly), so we don't assert "false" — it depends on the host's config.
  // The argv-flag cases ARE deterministic regardless of host config.

  it("is true with --op <glob>", () => {
    process.argv = ["bun", "index.ts", "--op", "op://V/Item/**"];
    __resetSniffForTests();
    expect(hasOpSources()).toBe(true);
  });

  it("is true with --op=<glob> inline form", () => {
    process.argv = ["bun", "index.ts", "--op=op://V/Item/**"];
    __resetSniffForTests();
    expect(hasOpSources()).toBe(true);
  });

  it("is true with --op-env <id>", () => {
    process.argv = ["bun", "index.ts", "--op-env", "env-1"];
    __resetSniffForTests();
    expect(hasOpSources()).toBe(true);
  });

  it("is true with --op-env=<id> inline form", () => {
    process.argv = ["bun", "index.ts", "--op-env=env-1"];
    __resetSniffForTests();
    expect(hasOpSources()).toBe(true);
  });

  it("is memoized (config doesn't change mid-run)", () => {
    process.argv = ["bun", "index.ts"];
    __resetSniffForTests();
    const first = hasOpSources();
    process.argv = ["bun", "index.ts", "--op", "op://V/Item/**"]; // changed AFTER first sniff
    expect(hasOpSources()).toBe(first); // still cached, not re-read
  });
});

describe("resolveOpKeyForEnvVars() — short-circuits (no SDK touched)", () => {
  it("returns {} for an empty wanted set, even WITH an op source present", async () => {
    // A keyless/satisfied model produces an empty wanted set. This is the
    // "ollama@ / already-satisfied key" laziness case: no SDK, no resolution.
    process.argv = ["bun", "index.ts", "--op", "op://V/Item/**"];
    __resetSniffForTests();
    expect(hasOpSources()).toBe(true);
    const out = await resolveOpKeyForEnvVars(new Set(), { onAuthFailure: "skip" });
    expect(out).toEqual({});
  });
});
