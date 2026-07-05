/**
 * Hermetic tests for startup-trace.ts.
 *
 * Everything is injected via __configureStartupTraceForTests: a fake clock, a
 * temp-dir output path, a captured stderr sink, an isolated env object, and
 * small caps/thresholds. No real ~/.claudish file, no real timers needed for
 * the timing-math tests, and no output escapes the test.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SLOW_START_THRESHOLD_MS,
  STARTUP_METRICS_MAX_LINES,
  type StartupTracePayload,
  __configureStartupTraceForTests,
  __getStartupSpansForTests,
  __resetStartupTraceForTests,
  addSpanMeta,
  beginQueuedSpan,
  beginSpan,
  finalizeStartupTrace,
  setStartupAuthKind,
  suppressStartupTraceTerminalOutput,
  traceSpan,
} from "./startup-trace.js";

let tmpDir: string;
let outPath: string;
let stderrLines: string[];
let t: number; // fake clock (ms since "process start")

/** Configure the trace with the fake clock + captured stderr + temp path. */
function configure(
  overrides: { env?: NodeJS.ProcessEnv; slowThresholdMs?: number; maxLines?: number } = {}
): void {
  __configureStartupTraceForTests({
    now: () => t,
    outPath,
    env: overrides.env ?? {},
    stderr: (line) => stderrLines.push(line),
    slowThresholdMs: overrides.slowThresholdMs ?? SLOW_START_THRESHOLD_MS,
    maxLines: overrides.maxLines ?? STARTUP_METRICS_MAX_LINES,
  });
}

function readPayloads(): StartupTracePayload[] {
  return readFileSync(outPath, "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as StartupTracePayload);
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "claudish-startup-trace-"));
  outPath = join(tmpDir, "startup-metrics.jsonl");
  stderrLines = [];
  t = 0;
  configure();
});

afterEach(() => {
  __resetStartupTraceForTests();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("traceSpan timing math (injected clock)", () => {
  test("sync fn: records start/duration and returns the value", () => {
    t = 100;
    const out = traceSpan("phase:sync", () => {
      t = 350;
      return 42;
    });
    expect(out).toBe(42);
    const spans = __getStartupSpansForTests();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("phase:sync");
    expect(spans[0].startMs).toBe(100);
    expect(spans[0].durMs).toBe(250);
  });

  test("async fn: records when the promise settles", async () => {
    t = 10;
    const out = await traceSpan("phase:async", async () => {
      t = 1010;
      return "done";
    });
    expect(out).toBe("done");
    const spans = __getStartupSpansForTests();
    expect(spans).toHaveLength(1);
    expect(spans[0].startMs).toBe(10);
    expect(spans[0].durMs).toBe(1000);
  });

  test("meta is attached to the span", () => {
    traceSpan("phase:meta", () => 1, { providers: 16, mayIncludeUserPrompt: true });
    const [span] = __getStartupSpansForTests();
    expect(span.meta).toEqual({ providers: 16, mayIncludeUserPrompt: true });
  });

  test("a throwing sync fn propagates AND records an error span", () => {
    expect(() =>
      traceSpan("phase:boom", () => {
        t = 5;
        throw new Error("locked: user denied\nsecond line never logged");
      })
    ).toThrow("locked");
    const [span] = __getStartupSpansForTests();
    expect(span.name).toBe("phase:boom");
    expect(span.meta?.error).toBe(true);
    expect(span.meta?.errorMsg).toBe("locked: user denied"); // first line only
  });

  test("a rejecting async fn propagates AND records an error span", async () => {
    await expect(
      traceSpan("phase:reject", async () => {
        t = 77;
        throw new Error("1Password desktop app is locked");
      })
    ).rejects.toThrow("locked");
    const [span] = __getStartupSpansForTests();
    expect(span.durMs).toBe(77);
    expect(span.meta?.error).toBe(true);
    expect(String(span.meta?.errorMsg)).toContain("locked");
  });
});

describe("beginSpan / beginQueuedSpan", () => {
  test("beginSpan: manual end with extra meta; end is idempotent", () => {
    t = 0;
    const end = beginSpan("phase:manual", { stage: "imports" });
    t = 500;
    end({ modules: 9 });
    t = 900;
    end(); // second end must be a no-op
    const spans = __getStartupSpansForTests();
    expect(spans).toHaveLength(1);
    expect(spans[0].durMs).toBe(500);
    expect(spans[0].meta).toEqual({ stage: "imports", modules: 9 });
  });

  test("beginQueuedSpan: records queue-wait vs exec split", () => {
    t = 0;
    const span = beginQueuedSpan("op:resolve(GEMINI_API_KEY)");
    t = 4000; // waited 4s behind the queue
    span.start();
    t = 9100; // executed for 5.1s
    span.end();
    const [s] = __getStartupSpansForTests();
    expect(s.startMs).toBe(0);
    expect(s.durMs).toBe(9100);
    expect(s.meta?.waitMs).toBe(4000);
    expect(s.meta?.execMs).toBe(5100);
  });

  test("beginQueuedSpan: end without start counts everything as wait", () => {
    t = 0;
    const span = beginQueuedSpan("op:never-started");
    t = 300;
    span.end({ error: true });
    const [s] = __getStartupSpansForTests();
    expect(s.meta?.waitMs).toBe(300);
    expect(s.meta?.execMs).toBe(0);
    expect(s.meta?.error).toBe(true);
  });
});

describe("addSpanMeta", () => {
  test("merges into the MOST RECENT span with the name", () => {
    traceSpan("op:x", () => 1, { attempt: 1 });
    traceSpan("op:x", () => 2, { attempt: 2 });
    addSpanMeta("op:x", { attempts: 2, retried: true });
    const spans = __getStartupSpansForTests();
    expect(spans[0].meta).toEqual({ attempt: 1 });
    expect(spans[1].meta).toEqual({ attempt: 2, attempts: 2, retried: true });
  });

  test("no-op when no span has that name", () => {
    addSpanMeta("op:missing", { attempts: 3 });
    expect(__getStartupSpansForTests()).toHaveLength(0);
  });
});

describe("finalize → JSONL", () => {
  test("appends one parseable line with all payload fields", () => {
    traceSpan("phase:a", () => {
      t = 120;
    });
    setStartupAuthKind("desktop");
    t = 500;
    finalizeStartupTrace("config");
    const [payload] = readPayloads();
    expect(payload.argvKind).toBe("config");
    expect(payload.totalMs).toBe(500);
    expect(payload.authKind).toBe("desktop");
    expect(typeof payload.version).toBe("string");
    expect(new Date(payload.ts).toString()).not.toBe("Invalid Date");
    expect(payload.spans).toHaveLength(1);
    expect(payload.spans[0].name).toBe("phase:a");
  });

  test("authKind defaults to none", () => {
    finalizeStartupTrace("run");
    expect(readPayloads()[0].authKind).toBe("none");
  });

  test("finalize is idempotent — only the first call writes", () => {
    finalizeStartupTrace("run");
    finalizeStartupTrace("run");
    finalizeStartupTrace("other");
    expect(readPayloads()).toHaveLength(1);
  });

  test("spans recorded AFTER finalize are dropped (env off)", () => {
    finalizeStartupTrace("run");
    traceSpan("post:finalize", () => 1);
    expect(__getStartupSpansForTests()).toHaveLength(0);
    expect(stderrLines).toHaveLength(0);
  });

  test("line cap: oldest lines are dropped on overflow", () => {
    configure({ maxLines: 3 });
    writeFileSync(
      outPath,
      `${["one", "two", "three", "four"].map((n) => JSON.stringify({ old: n })).join("\n")}\n`
    );
    finalizeStartupTrace("run");
    const lines = readFileSync(outPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim() !== "");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(JSON.stringify({ old: "three" })); // one+two dropped
    expect(JSON.parse(lines[2]).argvKind).toBe("run"); // newest is ours
  });

  test("default cap is 500 lines", () => {
    expect(STARTUP_METRICS_MAX_LINES).toBe(500);
  });
});

describe("slow-start threshold gating", () => {
  test("below threshold → silent (JSONL still written)", () => {
    t = 2000;
    finalizeStartupTrace("run");
    expect(stderrLines).toHaveLength(0);
    expect(readPayloads()).toHaveLength(1);
  });

  test("above threshold → exactly ONE line with the top 3 spans by duration", () => {
    t = 0;
    traceSpan("op:vaults.list", () => {
      t = 900;
    });
    const q = beginQueuedSpan("op:items.list");
    t = 5000;
    q.start();
    t = 10100;
    q.end(); // 9.2s total: wait 4.1s (5000-900), exec 5.1s — dominant span
    traceSpan("op:client-handshake", () => {
      t = 18300;
    }); // 8.2s
    traceSpan("op:sdk-wasm-import", () => {
      t = 21400;
    }); // 3.1s
    t = 31200;
    finalizeStartupTrace("config");
    expect(stderrLines).toHaveLength(1);
    const line = stderrLines[0];
    expect(line).toContain("slow start 31.2s");
    // Top 3 by duration: items.list (9.2s wait+exec), handshake (8.2s), wasm (3.1s).
    expect(line).toContain("op:items.list 9.2s (wait 4.1s + exec 5.1s)");
    expect(line).toContain("op:client-handshake 8.2s");
    expect(line).toContain("op:sdk-wasm-import 3.1s");
    expect(line).not.toContain("op:vaults.list"); // 4th place — excluded
    expect(line).toContain("startup-metrics.jsonl");
    expect(line).toContain("CLAUDISH_STARTUP_TRACE=1");
  });

  test("quiet:true suppresses the slow line", () => {
    t = 20000;
    finalizeStartupTrace("run", { quiet: true });
    expect(stderrLines).toHaveLength(0);
    expect(readPayloads()).toHaveLength(1); // data still captured
  });

  test("injected threshold is honored", () => {
    configure({ slowThresholdMs: 100 });
    t = 150;
    finalizeStartupTrace("run");
    expect(stderrLines.some((l) => l.includes("slow start"))).toBe(true);
  });
});

describe("CLAUDISH_STARTUP_TRACE=1 full table + live detail", () => {
  test("finalize prints the aligned phase table instead of the slow line", () => {
    configure({ env: { CLAUDISH_STARTUP_TRACE: "1" } });
    traceSpan("startup:parse-args", () => {
      t = 42;
    });
    const q = beginQueuedSpan("op:resolve(GEMINI_API_KEY)");
    t = 100;
    q.start();
    t = 9000;
    q.end();
    t = 30000; // way past threshold — but table mode replaces the slow line
    finalizeStartupTrace("config");
    const all = stderrLines.join("\n");
    expect(all).toContain("startup trace (config)");
    expect(all).toContain("total 30.0s");
    expect(all).toContain("startup:parse-args");
    expect(all).toContain("op:resolve(GEMINI_API_KEY) (wait 58ms + exec 8.9s)"); // enqueued t=42
    expect(all).not.toContain("slow start");
  });

  test("post-finalize spans live-print when trace mode is on", () => {
    configure({ env: { CLAUDISH_STARTUP_TRACE: "1" } });
    finalizeStartupTrace("config");
    stderrLines.length = 0;
    t = 0;
    traceSpan("tui:load-fields", () => {
      t = 234;
    });
    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).toContain("[startup-trace] tui:load-fields 234ms");
  });
});

describe("suppressStartupTraceTerminalOutput — the TUI owns the terminal", () => {
  test("after suppression, a span produces ZERO terminal writes but IS still recorded", () => {
    // Trace mode ON — the worst case: without suppression this live-prints.
    configure({ env: { CLAUDISH_STARTUP_TRACE: "1" } });
    finalizeStartupTrace("config"); // pre-mount finalize (table prints — allowed)
    stderrLines.length = 0;

    suppressStartupTraceTerminalOutput(); // right before the TUI mounts
    t = 0;
    traceSpan("tui:load-fields", () => {
      t = 381;
    });
    const q = beginQueuedSpan("op:resolve(OLLAMA_API_KEY)");
    q.start();
    t = 5300;
    q.end();

    // NOTHING hit the terminal — these lines would overwrite TUI rows.
    expect(stderrLines).toHaveLength(0);
    // …but the spans were NOT dropped: they're in the buffer.
    const names = __getStartupSpansForTests().map((s) => s.name);
    expect(names).toContain("tui:load-fields");
    expect(names).toContain("op:resolve(OLLAMA_API_KEY)");
  });

  test("suppressed spans are mirrored to an injected log sink (the --debug logger seam)", () => {
    configure({ env: { CLAUDISH_STARTUP_TRACE: "1" } });
    finalizeStartupTrace("config");
    stderrLines.length = 0;

    const logLines: string[] = [];
    suppressStartupTraceTerminalOutput({ logSink: (line) => logLines.push(line) });
    t = 0;
    traceSpan("tui:confirm-add", () => {
      t = 1200;
    });

    expect(stderrLines).toHaveLength(0); // terminal stays untouched
    expect(logLines).toHaveLength(1); // full detail goes to the log file
    expect(logLines[0]).toContain("[startup-trace] tui:confirm-add 1.2s");
  });

  test("a late finalize after suppression prints nothing (JSONL still written)", () => {
    // Defensive path: suppression arrives BEFORE finalize (e.g. the exit hook
    // finalizes after a TUI mounted). The table/slow-line must not print.
    configure({ env: { CLAUDISH_STARTUP_TRACE: "1" } });
    suppressStartupTraceTerminalOutput();
    t = 30000; // way past the slow threshold, and trace mode is on
    finalizeStartupTrace("config");
    expect(stderrLines).toHaveLength(0);
    expect(readPayloads()).toHaveLength(1); // the metrics line still landed
  });

  test("a throwing log sink never breaks the traced code path", () => {
    configure({ env: {} });
    finalizeStartupTrace("config");
    suppressStartupTraceTerminalOutput({
      logSink: () => {
        throw new Error("log file closed");
      },
    });
    expect(traceSpan("tui:anything", () => "ok")).toBe("ok");
    expect(stderrLines.filter((l) => l.includes("startup-trace"))).toHaveLength(0);
  });

  test("pre-suppression behavior is unchanged (post-finalize live print still works)", () => {
    configure({ env: { CLAUDISH_STARTUP_TRACE: "1" } });
    finalizeStartupTrace("config");
    stderrLines.length = 0;
    traceSpan("tui:before-suppress", () => {
      t = 10;
    });
    expect(stderrLines).toHaveLength(1); // live print until suppression is invoked
  });
});

describe("never throws (tracing failures can't break startup)", () => {
  test("unwritable output path → finalize returns, startup continues", () => {
    // Parent "directory" is a FILE → mkdir + write both fail.
    const blocker = join(tmpDir, "blocker");
    writeFileSync(blocker, "i am a file");
    __configureStartupTraceForTests({
      now: () => t,
      outPath: join(blocker, "nested", "metrics.jsonl"),
      env: {},
      stderr: (line) => stderrLines.push(line),
    });
    t = 20000;
    expect(() => finalizeStartupTrace("run")).not.toThrow();
    // The slow line still prints — only the file write failed.
    expect(stderrLines.some((l) => l.includes("slow start"))).toBe(true);
    expect(existsSync(join(blocker, "nested"))).toBe(false);
  });

  test("a broken injected clock never breaks the traced fn", () => {
    __configureStartupTraceForTests({
      now: () => {
        throw new Error("clock exploded");
      },
      outPath,
      env: {},
      stderr: () => {},
    });
    expect(traceSpan("phase:x", () => "value")).toBe("value");
    expect(() => finalizeStartupTrace("run")).not.toThrow();
  });

  test("a broken stderr sink never breaks finalize", () => {
    __configureStartupTraceForTests({
      now: () => t,
      outPath,
      env: { CLAUDISH_STARTUP_TRACE: "1" },
      stderr: () => {
        throw new Error("stderr closed");
      },
    });
    t = 30000;
    expect(() => finalizeStartupTrace("run")).not.toThrow();
    expect(readPayloads()).toHaveLength(1); // the JSONL write still landed
  });

  test("span buffer is capped (long-lived process protection)", () => {
    for (let i = 0; i < 600; i++) traceSpan(`s${i}`, () => i);
    expect(__getStartupSpansForTests().length).toBeLessThanOrEqual(500);
  });
});
