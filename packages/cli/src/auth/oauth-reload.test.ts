import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getGeminiOAuth, reloadGeminiCredentials } from "./gemini-oauth.js";

/**
 * Regression for the "OAuth login doesn't take effect until reload" bug.
 *
 * The OAuth singletons load their credential file ONCE in the constructor. When
 * `claudish login <slug>` runs in a child process it writes a fresh token file
 * that the long-lived parent never re-reads — so the parent's request path keeps
 * using the stale startup snapshot and fails auth until a full relaunch.
 * `reloadCredentials()` re-reads the file in-process, fixing it.
 *
 * Bun's `os.homedir()` is resolved once at process start and does NOT honor a
 * mid-run `HOME` change, so we can't redirect the cred path to a temp dir.
 * Instead we operate on the REAL `~/.claudish/gemini-oauth.json`, backing up any
 * existing file and ALWAYS restoring it in afterEach — the test never destroys
 * a real login.
 */

const GEMINI_PATH = join(homedir(), ".claudish", "gemini-oauth.json");
let backup: string | null = null;
let hadFile = false;

function writeGeminiCreds(token: string) {
  mkdirSync(join(homedir(), ".claudish"), { recursive: true });
  writeFileSync(
    GEMINI_PATH,
    JSON.stringify({
      access_token: token,
      refresh_token: "refresh-xyz",
      expires_at: Date.now() + 3_600_000,
    })
  );
}

beforeEach(() => {
  hadFile = existsSync(GEMINI_PATH);
  backup = hadFile ? readFileSync(GEMINI_PATH, "utf-8") : null;
});

afterEach(() => {
  // Always restore the user's real credential file exactly as it was.
  if (hadFile && backup !== null) {
    writeFileSync(GEMINI_PATH, backup);
  } else if (existsSync(GEMINI_PATH)) {
    rmSync(GEMINI_PATH, { force: true });
  }
  // Re-sync the singleton with the restored on-disk state so this test never
  // leaks a fabricated token into other tests sharing the process.
  reloadGeminiCredentials();
});

describe("reloadCredentials picks up a credential file written after startup", () => {
  test("no file → write file → reload → hasCredentials() flips to true", () => {
    // Start from a known no-creds state.
    if (existsSync(GEMINI_PATH)) rmSync(GEMINI_PATH, { force: true });
    reloadGeminiCredentials();
    expect(getGeminiOAuth().hasCredentials()).toBe(false);

    // Simulate the login child writing the token file.
    writeGeminiCreds("access-token-NEW");

    // The fix: reload re-reads the file in-process.
    reloadGeminiCredentials();
    expect(getGeminiOAuth().hasCredentials()).toBe(true);
  });
});
