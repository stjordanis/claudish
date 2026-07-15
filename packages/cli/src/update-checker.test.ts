/**
 * Regression tests for the npm version check behind `claudish update`.
 *
 * Real failure: `claudish update` printed "Unable to fetch latest version from
 * npm registry. Please check your internet connection" while the registry was
 * reachable (curl returned 200 in <1s). The check used a hard 5s timeout with no
 * retry, and swallowed every error into `null` — so a slow-but-working network
 * (registry latency here swings from ~150ms to >5s on a cold DNS/TLS handshake)
 * was reported as no connectivity.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { fetchLatestVersion, fetchLatestVersionOrThrow } from "./update-checker.js";

const realFetch = globalThis.fetch;

describe("fetchLatestVersionOrThrow", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("returns the version on 200", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ version: "7.12.5" }), { status: 200 })
    ) as unknown as typeof fetch;

    expect(await fetchLatestVersionOrThrow()).toBe("7.12.5");
  });

  test("retries a transient failure and succeeds", async () => {
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls++;
      if (calls === 1) throw new Error("socket hang up");
      return new Response(JSON.stringify({ version: "7.12.5" }), { status: 200 });
    }) as unknown as typeof fetch;

    expect(await fetchLatestVersionOrThrow({ retries: 2 })).toBe("7.12.5");
    expect(calls).toBe(2);
  });

  test("gives up after exhausting retries, surfacing the real error", async () => {
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls++;
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;

    await expect(fetchLatestVersionOrThrow({ retries: 2 })).rejects.toThrow("socket hang up");
    expect(calls).toBe(3); // initial + 2 retries
  });

  test("a slow response inside the timeout succeeds (no premature abort)", async () => {
    globalThis.fetch = mock(async (_url: any, init: any) => {
      // Resolve after a delay, respecting the caller's abort signal.
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 60);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
      return new Response(JSON.stringify({ version: "7.12.5" }), { status: 200 });
    }) as unknown as typeof fetch;

    expect(await fetchLatestVersionOrThrow({ timeoutMs: 1000 })).toBe("7.12.5");
  });

  test("timeout is reported as a timeout, not a generic failure", async () => {
    globalThis.fetch = mock(async (_url: any, init: any) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    // The message must name the timeout — the old code blamed the connection.
    await expect(fetchLatestVersionOrThrow({ timeoutMs: 30 })).rejects.toThrow(
      /timed out after 30ms/
    );
  });

  test("non-2xx reports the status", async () => {
    globalThis.fetch = mock(
      async () => new Response("", { status: 503 })
    ) as unknown as typeof fetch;

    await expect(fetchLatestVersionOrThrow()).rejects.toThrow("HTTP 503");
  });

  test("a 200 with no version field is an error, not a silent null", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ name: "claudish" }), { status: 200 })
    ) as unknown as typeof fetch;

    await expect(fetchLatestVersionOrThrow()).rejects.toThrow("no version field");
  });
});

describe("fetchLatestVersion (startup notification wrapper)", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("returns null instead of throwing, so startup never breaks", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;

    expect(await fetchLatestVersion()).toBeNull();
  });

  test("defaults to a single attempt (startup must not stall on retries)", async () => {
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls++;
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;

    await fetchLatestVersion();
    expect(calls).toBe(1);
  });
});
