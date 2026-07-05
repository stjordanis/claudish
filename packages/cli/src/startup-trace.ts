/**
 * startup-trace — local startup-timing analytics for claudish.
 *
 * `claudish config` (and normal runs) can take 30-40s to become ready, and the
 * dominant costs hide inside 1Password hydration: the ~10MB SDK/WASM dynamic
 * import, the DesktopAuth handshake (which can include waiting for the user to
 * click Authorize in the 1Password app), per-op desktop IPC latency, the
 * process-wide SDK serialization queue, retry storms, and the model-catalog
 * warm fetch. This module records per-phase spans across a launch and appends
 * ONE JSON line per launch to ~/.claudish/startup-metrics.jsonl so slow starts
 * can be diagnosed ACROSS runs (cold WASM? approval wait? queue pile-up?).
 *
 * DESIGN CONSTRAINTS (mirrors providers/onepassword.ts):
 *  - Dependency-light: node built-ins only at module load. This is imported by
 *    index.ts BEFORE heavy deps. Do not import zod/hono/the provider stack.
 *  - NEVER throws: a tracing failure must never break startup. Every public
 *    entry point is defensively wrapped; the traced fn's OWN error always
 *    propagates untouched, but recording failures are swallowed.
 *  - Negligible overhead: recording a span is an in-memory array push. The
 *    buffer is capped (MAX_BUFFERED_SPANS) so a long-lived process (MCP server)
 *    that never finalizes can't grow unbounded. After finalize, spans are
 *    dropped entirely — unless CLAUDISH_STARTUP_TRACE=1, which live-prints each
 *    post-finalize span to stderr (useful for tracing TUI-runtime SDK ops).
 *  - NO SECRET VALUES ever land in a span. Env-var NAMES and 1Password
 *    vault/item TITLES are OK (they already appear in stderr warnings); field
 *    VALUES never. Error messages are truncated to one short line.
 *
 * OUTPUT (all local, no network):
 *  - Always: one JSONL line per launch → ~/.claudish/startup-metrics.jsonl
 *    (capped at STARTUP_METRICS_MAX_LINES lines; oldest dropped on overflow).
 *  - total > SLOW_START_THRESHOLD_MS: one concise stderr line (top 3 spans by
 *    duration, with wait/exec split when present) BEFORE any fullscreen UI
 *    mounts — the callers finalize pre-mount.
 *  - CLAUDISH_STARTUP_TRACE=1: the full aligned phase table on stderr at
 *    finalize, plus live per-span lines after finalize.
 *
 * SEAMS: clock, output path, env, stderr sink, cap, and threshold are all
 * injectable via __configureStartupTraceForTests so tests are hermetic.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { VERSION } from "./version.js";

/** Span metadata — primitives only, so a JSONL line stays flat and greppable. */
export type SpanMeta = Record<string, string | number | boolean>;

/** One recorded startup phase. Times are ms relative to process start. */
export interface StartupSpan {
  name: string;
  /** Start offset in ms since process start (performance.timeOrigin). */
  startMs: number;
  /** Total duration in ms (for queued spans: wait + exec). */
  durMs: number;
  meta?: SpanMeta;
}

/** The JSONL payload appended per launch. */
export interface StartupTracePayload {
  /** Wall-clock launch timestamp (ISO 8601). */
  ts: string;
  version: string;
  /** Coarse launch kind — "config" | "run" | "other". Never the full argv. */
  argvKind: string;
  /** Wall time from process start to "ready", in ms. */
  totalMs: number;
  /** How the 1Password SDK authenticated this run (or "none"). */
  authKind: "desktop" | "token" | "none";
  spans: StartupSpan[];
}

/** Default metrics file: ~/.claudish/startup-metrics.jsonl */
export const STARTUP_METRICS_FILE = join(homedir(), ".claudish", "startup-metrics.jsonl");
/** Cap on JSONL lines; oldest are dropped when a write would exceed this. */
export const STARTUP_METRICS_MAX_LINES = 500;
/** Total startup time above which the one-line slow-start warning prints. */
export const SLOW_START_THRESHOLD_MS = 8000;
/** In-memory span buffer cap (protects long-lived never-finalized processes). */
const MAX_BUFFERED_SPANS = 500;

interface TraceSeams {
  /** Monotonic ms since process start. Default: performance.now(). */
  now: () => number;
  outPath: string;
  env: NodeJS.ProcessEnv;
  stderr: (line: string) => void;
  maxLines: number;
  slowThresholdMs: number;
}

function defaultSeams(): TraceSeams {
  return {
    now: () => performance.now(),
    outPath: STARTUP_METRICS_FILE,
    env: process.env,
    stderr: (line) => {
      process.stderr.write(`${line}\n`);
    },
    maxLines: STARTUP_METRICS_MAX_LINES,
    slowThresholdMs: SLOW_START_THRESHOLD_MS,
  };
}

let seams: TraceSeams = defaultSeams();
let spans: StartupSpan[] = [];
let finalized = false;
let authKind: "desktop" | "token" | "none" = "none";
/** One-way latch: once the fullscreen TUI owns the terminal, NO trace line may
 *  be written to it (stderr and stdout share the TTY — a live-printed span
 *  overwrites TUI rows). Spans are still recorded in the buffer / log sink. */
let terminalSuppressed = false;
/** Optional off-terminal sink for post-suppression spans (the --debug logger). */
let suppressedLogSink: ((line: string) => void) | undefined;

/** Round to 1 decimal — keeps sub-ms spans visible without float noise. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Clock read that can never throw (a broken injected clock returns 0). */
function safeNow(): number {
  try {
    return seams.now();
  } catch {
    return 0;
  }
}

/** Is the full-detail trace mode on? (CLAUDISH_STARTUP_TRACE=1) */
function traceModeOn(): boolean {
  try {
    return seams.env.CLAUDISH_STARTUP_TRACE === "1";
  } catch {
    return false;
  }
}

/** One-line, truncated, secret-free error descriptor for span meta. */
function errorMeta(err: unknown): SpanMeta {
  let msg: string;
  try {
    msg = err instanceof Error ? err.message : String(err);
  } catch {
    msg = "unknown";
  }
  const firstLine = msg.split("\n")[0] ?? "";
  return { error: true, errorMsg: firstLine.slice(0, 120) };
}

/**
 * Record one span. Pre-finalize: buffered (capped). Post-finalize: dropped —
 * unless CLAUDISH_STARTUP_TRACE=1, which live-prints it to stderr instead.
 * Never throws.
 */
function record(name: string, startMs: number, meta?: SpanMeta): void {
  try {
    const span: StartupSpan = {
      name,
      startMs: round1(startMs),
      durMs: round1(safeNow() - startMs),
      ...(meta && Object.keys(meta).length > 0 ? { meta } : {}),
    };
    if (terminalSuppressed) {
      // The fullscreen TUI owns the terminal: NEVER write there (even with
      // CLAUDISH_STARTUP_TRACE=1 — a live line would overwrite TUI rows). The
      // span is still recorded: buffered (capped) and, when the --debug logger
      // is active, written to the log file (repo convention: suppress noise at
      // the terminal, keep full detail in log files).
      try {
        suppressedLogSink?.(`[startup-trace] ${formatSpanLine(span)}`);
      } catch {
        // A broken sink must never break the traced code path.
      }
      if (spans.length < MAX_BUFFERED_SPANS) spans.push(span);
      return;
    }
    if (finalized) {
      if (traceModeOn()) seams.stderr(`[startup-trace] ${formatSpanLine(span)}`);
      return;
    }
    if (spans.length >= MAX_BUFFERED_SPANS) return;
    spans.push(span);
  } catch {
    // Tracing must never break the traced code path.
  }
}

function isThenable(v: unknown): v is Promise<unknown> {
  return (
    !!v &&
    (typeof v === "object" || typeof v === "function") &&
    typeof (v as { then?: unknown }).then === "function"
  );
}

/**
 * Run `fn` inside a named span. Works for sync AND async fns (the async span
 * records when the promise settles). The fn's own error/rejection propagates
 * untouched — but the span is still recorded, with { error, errorMsg } meta,
 * so a locked/denied 1Password still leaves a visible failure phase.
 */
export function traceSpan<T>(name: string, fn: () => Promise<T>, meta?: SpanMeta): Promise<T>;
export function traceSpan<T>(name: string, fn: () => T, meta?: SpanMeta): T;
export function traceSpan<T>(
  name: string,
  fn: () => T | Promise<T>,
  meta?: SpanMeta
): T | Promise<T> {
  const start = safeNow();
  let result: T | Promise<T>;
  try {
    result = fn();
  } catch (err) {
    record(name, start, { ...meta, ...errorMeta(err) });
    throw err;
  }
  if (isThenable(result)) {
    return (result as Promise<T>).then(
      (value) => {
        record(name, start, meta);
        return value;
      },
      (err) => {
        record(name, start, { ...meta, ...errorMeta(err) });
        throw err;
      }
    );
  }
  record(name, start, meta);
  return result;
}

/**
 * Manual span for code that can't be wrapped in one closure (e.g. a run of
 * top-level awaits). Returns an idempotent `end(extraMeta?)` closure.
 */
export function beginSpan(name: string, meta?: SpanMeta): (extraMeta?: SpanMeta) => void {
  const start = safeNow();
  let ended = false;
  return (extraMeta?: SpanMeta) => {
    if (ended) return;
    ended = true;
    record(name, start, { ...meta, ...extraMeta });
  };
}

/**
 * Span for a QUEUED operation (the SDK serialization queues): records BOTH the
 * queue wait (enqueue → start) and the execution (start → finish) as
 * `waitMs` / `execMs` meta on one span whose durMs is the total. Call `start()`
 * when the op actually begins executing and `end()` when it settles.
 */
export function beginQueuedSpan(
  name: string,
  meta?: SpanMeta
): { start(): void; end(extraMeta?: SpanMeta): void } {
  const enqueuedAt = safeNow();
  let startedAt: number | undefined;
  let ended = false;
  return {
    start() {
      if (startedAt === undefined) startedAt = safeNow();
    },
    end(extraMeta?: SpanMeta) {
      if (ended) return;
      ended = true;
      const endAt = safeNow();
      const startAt = startedAt ?? endAt;
      record(name, enqueuedAt, {
        ...meta,
        ...extraMeta,
        waitMs: round1(startAt - enqueuedAt),
        execMs: round1(endAt - startAt),
      });
    },
  };
}

/**
 * Merge extra meta into the MOST RECENT recorded span with this name (e.g.
 * withSdkRetry attaching the final attempt count after the retry loop). No-op
 * when no such span exists or after finalize. Never throws.
 */
export function addSpanMeta(name: string, meta: SpanMeta): void {
  try {
    if (finalized) return;
    for (let i = spans.length - 1; i >= 0; i--) {
      if (spans[i].name === name) {
        spans[i].meta = { ...spans[i].meta, ...meta };
        return;
      }
    }
  } catch {
    // Never break the caller.
  }
}

/**
 * Suppress ALL trace output to the terminal — call right BEFORE mounting a
 * fullscreen TUI (the OpenTUI config interface). stderr vs stdout is irrelevant:
 * both share the TTY the TUI renders on, so ANY live-printed span (e.g. the
 * TUI's own 1Password ops under CLAUDISH_STARTUP_TRACE=1) overwrites rendered
 * rows. One-way latch: there is deliberately no "unsuppress".
 *
 * Post-suppression spans are STILL recorded — they stay in the in-memory buffer
 * (capped) and are mirrored to the --debug log file when that logger is active.
 * Pre-mount output (the slow-start line / the finalize table) is unaffected as
 * long as finalize ran before this call, which the config path guarantees.
 *
 * `opts.logSink` overrides the off-terminal sink (tests inject a capture);
 * by default the --debug logger is wired lazily via dynamic import so this
 * module stays dependency-light at load. Never throws.
 */
export function suppressStartupTraceTerminalOutput(
  opts: { logSink?: (line: string) => void } = {}
): void {
  try {
    terminalSuppressed = true;
    if (opts.logSink) {
      suppressedLogSink = opts.logSink;
      return;
    }
    // Lazy default: route to the --debug logger IF it's active. logger.js is
    // already loaded on every TUI path, so this import is a cache hit; gating
    // on getLogFilePath() keeps non-debug runs buffer-only.
    import("./logger.js")
      .then((logger) => {
        suppressedLogSink = (line) => {
          if (logger.getLogFilePath()) logger.log(line);
        };
      })
      .catch(() => {
        // Logger unavailable — buffer-only. Recording must never break.
      });
  } catch {
    // Suppression must never break the caller.
  }
}

/** Record how the 1Password SDK authenticated (for the JSONL authKind field). */
export function setStartupAuthKind(kind: "desktop" | "token"): void {
  try {
    if (!finalized) authKind = kind;
  } catch {
    // Never break the caller.
  }
}

/** "31.2s" for >=1s, "412ms" below. */
function fmtDur(ms: number): string {
  if (!Number.isFinite(ms)) return "?";
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

/** " (wait 4.0s + exec 5.1s)" when the span has the queued-split meta. */
function fmtWaitExec(meta: SpanMeta | undefined): string {
  if (typeof meta?.waitMs !== "number" || typeof meta?.execMs !== "number") return "";
  return ` (wait ${fmtDur(meta.waitMs)} + exec ${fmtDur(meta.execMs)})`;
}

/** Remaining meta (minus the wait/exec pair) as " key=value …". */
function fmtExtraMeta(meta: SpanMeta | undefined): string {
  if (!meta) return "";
  const parts = Object.entries(meta)
    .filter(([k]) => k !== "waitMs" && k !== "execMs")
    .map(([k, v]) => `${k}=${v}`);
  return parts.length > 0 ? `  ${parts.join(" ")}` : "";
}

function formatSpanLine(span: StartupSpan): string {
  return `${span.name} ${fmtDur(span.durMs)}${fmtWaitExec(span.meta)}${fmtExtraMeta(span.meta)}`;
}

/** Shorten the metrics path for display (homedir → ~). */
function displayPath(p: string): string {
  try {
    const home = homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  } catch {
    return p;
  }
}

/** Append the JSONL line, dropping oldest lines beyond the cap. */
function writeJsonlCapped(payload: StartupTracePayload): void {
  const path = seams.outPath;
  const line = JSON.stringify(payload);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // Directory may already exist or be uncreatable — the write below decides.
  }
  let existing: string[] | undefined;
  try {
    existing = readFileSync(path, "utf-8")
      .split("\n")
      .filter((l) => l.trim() !== "");
  } catch {
    existing = undefined; // no file yet (or unreadable) — plain append below.
  }
  if (existing && existing.length + 1 > seams.maxLines) {
    const kept = [...existing, line].slice(-seams.maxLines);
    writeFileSync(path, `${kept.join("\n")}\n`);
  } else {
    appendFileSync(path, `${line}\n`);
  }
}

/** The one-line slow-start warning: total + top 3 spans by duration. */
function printSlowLine(payload: StartupTracePayload): void {
  const top = [...payload.spans]
    .sort((a, b) => b.durMs - a.durMs)
    .slice(0, 3)
    .map((s) => `${s.name} ${fmtDur(s.durMs)}${fmtWaitExec(s.meta)}`);
  const detail = top.length > 0 ? ` — ${top.join(", ")}` : "";
  seams.stderr(
    `[claudish] slow start ${fmtDur(payload.totalMs)}${detail} … full data: ` +
      `${displayPath(seams.outPath)} (CLAUDISH_STARTUP_TRACE=1 for live detail)`
  );
}

/** The full aligned phase table (CLAUDISH_STARTUP_TRACE=1). */
function printTable(payload: StartupTracePayload): void {
  seams.stderr(
    `[claudish] startup trace (${payload.argvKind}) — total ${fmtDur(payload.totalMs)}` +
      ` · auth ${payload.authKind} · v${payload.version}`
  );
  seams.stderr("  start        dur  span");
  for (const s of payload.spans) {
    const start = fmtDur(s.startMs).padStart(7);
    const dur = fmtDur(s.durMs).padStart(9);
    seams.stderr(`  ${start}  ${dur}  ${s.name}${fmtWaitExec(s.meta)}${fmtExtraMeta(s.meta)}`);
  }
  seams.stderr(`  metrics: ${displayPath(seams.outPath)}`);
}

/**
 * Mark startup "ready": write the JSONL line and emit any stderr summary.
 * Idempotent — only the FIRST call wins (later calls, including the exit-hook
 * fallback, are no-ops). Never throws.
 *
 * `context` is the coarse argvKind ("config" | "run" | "other").
 * `opts.quiet` suppresses the slow-start warning line (honors --quiet); the
 * full table still prints when CLAUDISH_STARTUP_TRACE=1 (explicit opt-in).
 */
export function finalizeStartupTrace(context: string, opts: { quiet?: boolean } = {}): void {
  try {
    if (finalized) return;
    const totalMs = safeNow();
    const payload: StartupTracePayload = {
      ts: new Date().toISOString(),
      version: VERSION,
      argvKind: context,
      totalMs: round1(totalMs),
      authKind,
      spans,
    };
    // Latch BEFORE I/O so a mid-write failure can't cause a second attempt.
    finalized = true;
    try {
      writeJsonlCapped(payload);
    } catch {
      // Unwritable metrics file must never break startup.
    }
    try {
      if (terminalSuppressed) {
        // A TUI already owns the screen (finalize arrived late, e.g. the exit
        // hook): JSONL only — printing now would corrupt the render buffer.
      } else if (traceModeOn()) {
        printTable(payload);
      } else if (totalMs > seams.slowThresholdMs && !opts.quiet) {
        printSlowLine(payload);
      }
    } catch {
      // A broken stderr sink must never break startup.
    }
  } catch {
    // finalize NEVER throws.
  }
}

// ── Test seams ───────────────────────────────────────────────────────────────

/** Test-only: override clock/path/env/stderr/caps AND reset all state. */
export function __configureStartupTraceForTests(overrides: Partial<TraceSeams>): void {
  seams = { ...defaultSeams(), ...overrides };
  spans = [];
  finalized = false;
  authKind = "none";
  terminalSuppressed = false;
  suppressedLogSink = undefined;
}

/** Test-only: restore default seams and reset all state. */
export function __resetStartupTraceForTests(): void {
  seams = defaultSeams();
  spans = [];
  finalized = false;
  authKind = "none";
  terminalSuppressed = false;
  suppressedLogSink = undefined;
}

/** Test-only: snapshot of the recorded spans (copy — safe to inspect). */
export function __getStartupSpansForTests(): StartupSpan[] {
  return spans.map((s) => ({ ...s, meta: s.meta ? { ...s.meta } : undefined }));
}
