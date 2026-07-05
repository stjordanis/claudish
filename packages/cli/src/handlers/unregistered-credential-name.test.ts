/**
 * Hardening regression: a provider whose RUNTIME name is NOT registered in the
 * credential authority must NOT surface as an HTTP 500.
 *
 * The original bug: the "google" catalog entry is renamed to "gemini" for the
 * request path (toRemoteProvider), proxy-server signed with that runtime name,
 * and the authority had no "gemini" registration → getRequestAuth threw →
 * HTTP 500 "No credential provider for gemini" on every direct-Gemini probe.
 *
 * Fix 1a registers the alias; THIS test pins fix 1b — the hardening that any
 * remaining/future registration gap degrades to the same routable
 * "no credential" 400 a missing key produces, with a loud stderr warning,
 * never a 500.
 *
 * Black-box: drives the real proxy in-process via createProxyServer() (same
 * pattern as explicit-spec-no-credential.test.ts). The registration gap is
 * simulated by shadowing credentials.get() for the "gemini" runtime name —
 * the exact condition proxy-server's guard checks. No network call happens.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { credentials } from "../auth/credentials/authority.js";
import { createProxyServer } from "../proxy-server.js";
import type { ProxyServer } from "../types.js";

const PORT_BASE = 19910;
let portCounter = 0;
const nextPort = () => PORT_BASE + (portCounter++ % 50);

let activeProxy: ProxyServer | null = null;

// ── Simulate the registration gap (own-property shadow, removable) ──────────
const realGet = credentials.get.bind(credentials);
function installGap(missingName: string): void {
  Object.defineProperty(credentials, "get", {
    value: (name: string) => (name === missingName ? undefined : realGet(name)),
    configurable: true,
    writable: true,
  });
}
function removeGap(): void {
  // Deleting the own property re-exposes the prototype method.
  delete (credentials as { get?: unknown }).get;
}

// ── Env sandbox: the gap must be hit even WITH the key present ──────────────
let savedGeminiKey: string | undefined;

// ── stderr spy ───────────────────────────────────────────────────────────────
const errLines: string[] = [];
const realConsoleError = console.error;

afterEach(async () => {
  removeGap();
  console.error = realConsoleError;
  errLines.length = 0;
  if (savedGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = savedGeminiKey;
  // Drop the memoized test key from the shared singleton so it cannot bleed
  // into sibling test files running in the same process.
  credentials.invalidate();
  if (activeProxy) {
    try {
      await activeProxy.shutdown();
    } catch {}
    activeProxy = null;
  }
});

describe("unregistered credential name — warn + graceful 400, never 500", () => {
  test("explicit g@ spec with a registration gap returns 400 with a warning, not 500", async () => {
    savedGeminiKey = process.env.GEMINI_API_KEY;
    // The key IS present — proving the 400 comes from the NAME gap (the
    // pre-fix repro surfaced a 500 here), not from an ordinary missing key.
    process.env.GEMINI_API_KEY = "sk-gemini-present-but-name-unregistered";
    credentials.invalidate();

    installGap("gemini");
    console.error = (...args: unknown[]) => {
      errLines.push(args.map(String).join(" "));
    };

    const port = nextPort();
    activeProxy = await createProxyServer(
      port,
      process.env.OPENROUTER_API_KEY,
      undefined,
      false,
      process.env.ANTHROPIC_API_KEY,
      undefined,
      { quiet: true }
    );

    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "g@gemini-2.5-flash",
        max_tokens: 16,
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const raw: any = await res.json();

    // Routable terminal 400 — the same rejection a missing key produces.
    expect(res.status).toBe(400);
    expect(raw?.type).toBe("error");
    expect(raw?.error?.type).toBe("invalid_request_error");

    // NOT silently swallowed: the registration gap is loud on stderr.
    const warning = errLines.find((l) => l.includes("No credential provider registered"));
    expect(warning).toBeDefined();
    expect(warning).toContain('"gemini"');
  });
});
