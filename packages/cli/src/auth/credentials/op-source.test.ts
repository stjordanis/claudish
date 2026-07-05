/**
 * op-source — the lazy 1Password seam behind the credential authority.
 *
 * These tests cover op-source's UNIQUE contracts:
 *  1. the SYNC laziness gate (hasOpSources) and the short-circuits in
 *     resolveOpKeyForEnvVars that return BEFORE any 1Password module/SDK is
 *     touched;
 *  2. the GLOB SINGLE-FLIGHT: one configured glob resolves ONCE per process
 *     (one vaults.list + items.list + items.get + secrets.resolveAll) no matter
 *     how many providers ask, failures are never memoized, and two different
 *     globs never cross-contaminate.
 *
 * The deep resolution primitives (collectConfigImports / resolveGlobImportAll /
 * resolveSecrets) are exhaustively tested in providers/onepassword.test.ts; the
 * full resolve path against real 1Password is exercised by the manual
 * scratch-op-hydrate-check probe.
 *
 * Deliberately NO `mock.module` here: Bun's module mocks are process-global and
 * would bleed into sibling files (providers/onepassword.test.ts, the lazy test)
 * in a full `bun test` run. Everything is hermetic via the injectable
 * __setOpSourceSeamsForTests seams (in-memory config + fake SDK factory + stub
 * auth), mirroring onepassword.test.ts's SdkClientFactory idiom.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { SdkAuth, SdkClientFactory, SdkClientLike } from "../../providers/onepassword.js";
import {
  __configureStartupTraceForTests,
  __getStartupSpansForTests,
  __resetStartupTraceForTests,
} from "../../startup-trace.js";
import {
  __resetResolveCacheForTests,
  __resetSniffForTests,
  __setOpSourceSeamsForTests,
  hasOpSources,
  invalidateOpResolutionCache,
  resolveOpKeyForEnvVars,
} from "./op-source.js";

let savedArgv: string[];
let savedDisableOp: string | undefined;

beforeEach(() => {
  savedArgv = process.argv;
  // The glob tests need the real sniff path (CLAUDISH_DISABLE_OP would force
  // hasOpSources()=false and short-circuit before the seams are consulted).
  savedDisableOp = process.env.CLAUDISH_DISABLE_OP;
  delete process.env.CLAUDISH_DISABLE_OP;
  __resetSniffForTests();
  __resetResolveCacheForTests();
  __setOpSourceSeamsForTests(undefined);
});

afterEach(() => {
  process.argv = savedArgv;
  if (savedDisableOp === undefined) delete process.env.CLAUDISH_DISABLE_OP;
  else process.env.CLAUDISH_DISABLE_OP = savedDisableOp;
  __resetSniffForTests();
  __resetResolveCacheForTests();
  __setOpSourceSeamsForTests(undefined);
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

// ===========================================================================
// Glob single-flight + full-result memoization (the 36s-startup fix)
//
// Fixture DERIVED from providers/onepassword.test.ts's real-captured item (same
// vault/item/section/field titles — a compact subset; no invented secret-like
// data). The fake SdkClientFactory counts every SDK namespace call so the tests
// can assert "exactly ONE discovery + ONE batched resolveAll" for N providers.
// ===========================================================================

const VAULT = "Jack";
const ITEM = "AI LLM models API keys 10xlabs";
const GLOB_ALL = `op://${VAULT}/${ITEM}/**`;
const GLOB_OPENAI = `op://${VAULT}/${ITEM}/OpenAI/*`;
const GLOB_MOON = `op://${VAULT}/${ITEM}/Moonshot Kimi/*`;
const refOf = (rest: string): string => `op://${VAULT}/${ITEM}/${rest}`;

/** SDK-shaped item (subset of the captured fixture — same titles/sections). */
const SDK_ITEM: Awaited<ReturnType<SdkClientLike["items"]["get"]>> = {
  id: "abc123",
  title: ITEM,
  sections: [
    { id: "s-oai", title: "OpenAI" },
    { id: "s-moon", title: "Moonshot Kimi" },
    { id: "s-glm", title: "GLM Z models" },
  ],
  fields: [
    // sectionless, lowercase → invalid env name → skipped by the glob filter.
    { id: "f-0", title: "username", fieldType: "STRING", value: "" },
    { id: "f-1", title: "OPENAI_API_KEY", sectionId: "s-oai", fieldType: "CONCEALED", value: "x" },
    {
      id: "f-2",
      title: "MOONSHOT_API_KEY",
      sectionId: "s-moon",
      fieldType: "CONCEALED",
      value: "x",
    },
    {
      id: "f-3",
      title: "KIMI_CODING_API_KEY",
      sectionId: "s-moon",
      fieldType: "CONCEALED",
      value: "x",
    },
    { id: "f-4", title: "ZHIPU_API_KEY", sectionId: "s-glm", fieldType: "CONCEALED", value: "x" },
  ],
};

interface SdkCallCounts {
  vaultsList: number;
  itemsList: number;
  itemsGet: number;
  resolveAll: number;
}

/**
 * A counting fake SDK client factory (mirrors onepassword.test.ts's
 * makeFakeSdkFactory, plus per-namespace call counters). `failVaultsList` is a
 * one-shot latch: when active, the NEXT vaults.list throws (a transient
 * desktop-app failure), then the latch clears.
 */
function makeCountingFactory(opts: { failVaultsList?: { active: boolean } } = {}): {
  factory: SdkClientFactory;
  counts: SdkCallCounts;
} {
  const counts: SdkCallCounts = { vaultsList: 0, itemsList: 0, itemsGet: 0, resolveAll: 0 };
  const client: SdkClientLike = {
    secrets: {
      async resolve(ref: string): Promise<string> {
        return `sdk:${ref}`;
      },
      async resolveAll(refs: string[]) {
        counts.resolveAll++;
        const individualResponses: Record<string, { content?: { secret: string } }> = {};
        for (const r of refs) individualResponses[r] = { content: { secret: `sdk:${r}` } };
        return { individualResponses };
      },
    },
    vaults: {
      async list() {
        counts.vaultsList++;
        if (opts.failVaultsList?.active) {
          opts.failVaultsList.active = false;
          throw new Error("1Password desktop bridge failed (test)");
        }
        return [{ id: "vid", title: VAULT }];
      },
    },
    items: {
      async list() {
        counts.itemsList++;
        return [{ id: "abc123", title: ITEM }];
      },
      async get() {
        counts.itemsGet++;
        return SDK_ITEM;
      },
    },
    environments: {
      async getVariables() {
        return { variables: [] };
      },
    },
  };
  return { factory: async () => client, counts };
}

const stubAuth: SdkAuth = { kind: "token", token: "ops_test" };

/** Install the hermetic seams: in-memory config + counting SDK + stub auth. */
function seamWith(globs: string[], factory: SdkClientFactory): void {
  __setOpSourceSeamsForTests({
    config: { onepassword: globs },
    sdkFactory: factory,
    auth: stubAuth,
  });
  __resetSniffForTests(); // re-sniff against the seamed config
}

const resolveOne = (name: string): Promise<Record<string, string>> =>
  resolveOpKeyForEnvVars(new Set([name]), { onAuthFailure: "skip" });

describe("glob single-flight — one resolution shared by every provider", () => {
  it("N concurrent per-key resolves over ONE glob → exactly one vaults.list/items.list/items.get/resolveAll", async () => {
    const { factory, counts } = makeCountingFactory();
    seamWith([GLOB_ALL], factory);

    // Six concurrent "providers" (incl. a duplicate and a key the item lacks) —
    // the startup shape: everyone enqueues before the first resolution lands.
    const [openai, moonshot, kimi, zhipu, missing, openaiAgain] = await Promise.all([
      resolveOne("OPENAI_API_KEY"),
      resolveOne("MOONSHOT_API_KEY"),
      resolveOne("KIMI_CODING_API_KEY"),
      resolveOne("ZHIPU_API_KEY"),
      resolveOne("NOT_IN_THIS_ITEM_KEY"),
      resolveOne("OPENAI_API_KEY"),
    ]);

    // ONE full discovery + ONE batched resolveAll — not one per provider.
    expect(counts).toEqual({ vaultsList: 1, itemsList: 1, itemsGet: 1, resolveAll: 1 });

    // Every caller got ITS value out of the shared result.
    expect(openai).toEqual({ OPENAI_API_KEY: `sdk:${refOf("OpenAI/OPENAI_API_KEY")}` });
    expect(moonshot).toEqual({
      MOONSHOT_API_KEY: `sdk:${refOf("Moonshot Kimi/MOONSHOT_API_KEY")}`,
    });
    expect(kimi).toEqual({
      KIMI_CODING_API_KEY: `sdk:${refOf("Moonshot Kimi/KIMI_CODING_API_KEY")}`,
    });
    expect(zhipu).toEqual({ ZHIPU_API_KEY: `sdk:${refOf("GLM Z models/ZHIPU_API_KEY")}` });
    expect(missing).toEqual({}); // the glob simply doesn't hold this key
    expect(openaiAgain).toEqual(openai);
  });

  it("sequential resolves after completion → pure cache hits, zero additional SDK calls", async () => {
    const { factory, counts } = makeCountingFactory();
    seamWith([GLOB_ALL], factory);

    await resolveOne("OPENAI_API_KEY");
    expect(counts.itemsGet).toBe(1);

    // A var NEVER wanted before — but the full-glob result already holds it.
    const moonshot = await resolveOne("MOONSHOT_API_KEY");
    expect(moonshot).toEqual({
      MOONSHOT_API_KEY: `sdk:${refOf("Moonshot Kimi/MOONSHOT_API_KEY")}`,
    });
    // A var the glob does NOT hold → memoized empty pick, still no SDK.
    expect(await resolveOne("NOT_IN_THIS_ITEM_KEY")).toEqual({});

    expect(counts).toEqual({ vaultsList: 1, itemsList: 1, itemsGet: 1, resolveAll: 1 });
  });

  it("a FAILED glob resolution is not cached — the next resolve retries", async () => {
    const failLatch = { active: true };
    const { factory, counts } = makeCountingFactory({ failVaultsList: failLatch });
    seamWith([GLOB_ALL], factory);

    // First resolve: discovery throws → warn+skip (startup contract), {} back.
    expect(await resolveOne("OPENAI_API_KEY")).toEqual({});
    expect(counts.vaultsList).toBe(1);
    expect(counts.itemsGet).toBe(0);

    // Second resolve: the rejected promise was EVICTED → full retry, succeeds.
    const out = await resolveOne("OPENAI_API_KEY");
    expect(out).toEqual({ OPENAI_API_KEY: `sdk:${refOf("OpenAI/OPENAI_API_KEY")}` });
    expect(counts).toEqual({ vaultsList: 2, itemsList: 1, itemsGet: 1, resolveAll: 1 });
  });

  it("two DIFFERENT globs → two resolutions, no cross-contamination", async () => {
    const { factory, counts } = makeCountingFactory();
    seamWith([GLOB_OPENAI, GLOB_MOON], factory);

    // Wanted key lives in glob #1 → glob #2 is never touched (loop breaks).
    const openai = await resolveOne("OPENAI_API_KEY");
    expect(openai).toEqual({ OPENAI_API_KEY: `sdk:${refOf("OpenAI/OPENAI_API_KEY")}` });
    expect(counts.itemsGet).toBe(1);

    // Wanted key lives in glob #2 → glob #1 is a memoized miss, #2 resolves.
    const moonshot = await resolveOne("MOONSHOT_API_KEY");
    expect(moonshot).toEqual({
      MOONSHOT_API_KEY: `sdk:${refOf("Moonshot Kimi/MOONSHOT_API_KEY")}`,
    });
    expect(counts.itemsGet).toBe(2);

    // A key NEITHER scoped glob matches → both memoized, no more SDK calls.
    expect(await resolveOne("ZHIPU_API_KEY")).toEqual({});
    expect(counts.itemsGet).toBe(2);
    expect(counts.resolveAll).toBe(2);
  });

  it("invalidateOpResolutionCache() forces a fresh discovery on the next resolve", async () => {
    const { factory, counts } = makeCountingFactory();
    seamWith([GLOB_ALL], factory);

    await resolveOne("OPENAI_API_KEY");
    expect(counts.itemsGet).toBe(1);

    // TUI hydrate-on-add / item edited in 1Password → drop every memo.
    invalidateOpResolutionCache();
    __resetSniffForTests(); // invalidate also resets the sniff; re-sniff the seams

    await resolveOne("OPENAI_API_KEY");
    expect(counts.itemsGet).toBe(2);
  });

  it("trace observability: ONE op:glob-resolve span (masked), later resolves marked globCacheHit", async () => {
    __configureStartupTraceForTests({ now: () => 0, stderr: () => {}, outPath: "/dev/null" });
    try {
      const { factory } = makeCountingFactory();
      seamWith([GLOB_ALL], factory);

      await Promise.all([
        resolveOne("OPENAI_API_KEY"),
        resolveOne("MOONSHOT_API_KEY"),
        resolveOne("NOT_IN_THIS_ITEM_KEY"),
      ]);

      const spans = __getStartupSpansForTests();
      const globSpans = spans.filter((s) => s.name.startsWith("op:glob-resolve("));
      expect(globSpans).toHaveLength(1);
      // The label is MASKED: long item titles are mid-truncated.
      expect(globSpans[0].name).not.toContain(ITEM);
      expect(globSpans[0].name).toContain("op://Jack/");
      expect(globSpans[0].meta?.vars).toBe(4);

      // The queued resolves that were served from the shared result carry the
      // cache-hit marker (their exec is a pure in-memory pick).
      const cacheHits = spans.filter(
        (s) => s.name.startsWith("op:resolve(") && s.meta?.globCacheHit === true
      );
      expect(cacheHits.length).toBeGreaterThanOrEqual(2);
    } finally {
      __resetStartupTraceForTests();
    }
  });
});
