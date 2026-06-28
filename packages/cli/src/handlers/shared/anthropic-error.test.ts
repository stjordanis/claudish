import { describe, it, expect } from "bun:test";
import {
  statusToErrorType,
  wrapAnthropicError,
  ensureAnthropicErrorFormat,
  isTerminalError,
  buildSurfacedErrorMessage,
  extractProviderMessage,
} from "./anthropic-error.js";

describe("statusToErrorType", () => {
  it("maps 400 to invalid_request_error", () => {
    expect(statusToErrorType(400)).toBe("invalid_request_error");
  });

  it("maps 401 to authentication_error", () => {
    expect(statusToErrorType(401)).toBe("authentication_error");
  });

  it("maps 403 to permission_error", () => {
    expect(statusToErrorType(403)).toBe("permission_error");
  });

  it("maps 404 to not_found_error", () => {
    expect(statusToErrorType(404)).toBe("not_found_error");
  });

  it("maps 429 to rate_limit_error", () => {
    expect(statusToErrorType(429)).toBe("rate_limit_error");
  });

  it("maps 503 to overloaded_error", () => {
    expect(statusToErrorType(503)).toBe("overloaded_error");
  });

  it("maps 529 to overloaded_error", () => {
    expect(statusToErrorType(529)).toBe("overloaded_error");
  });

  it("maps 500 to api_error", () => {
    expect(statusToErrorType(500)).toBe("api_error");
  });

  it("maps unknown status codes to api_error", () => {
    expect(statusToErrorType(502)).toBe("api_error");
    expect(statusToErrorType(418)).toBe("api_error");
  });
});

describe("wrapAnthropicError", () => {
  it("creates a valid Anthropic error envelope", () => {
    const result = wrapAnthropicError(500, "Something went wrong");
    expect(result).toEqual({
      type: "error",
      error: { type: "api_error", message: "Something went wrong" },
    });
  });

  it("infers error type from status code", () => {
    const result = wrapAnthropicError(429, "Too many requests");
    expect(result.error.type).toBe("rate_limit_error");
  });

  it("allows overriding error type", () => {
    const result = wrapAnthropicError(503, "Server down", "connection_error");
    expect(result).toEqual({
      type: "error",
      error: { type: "connection_error", message: "Server down" },
    });
  });

  it("uses status-derived type when errorType is undefined", () => {
    const result = wrapAnthropicError(401, "Bad key", undefined);
    expect(result.error.type).toBe("authentication_error");
  });
});

describe("ensureAnthropicErrorFormat", () => {
  it("passes through a valid Anthropic error envelope", () => {
    const valid = {
      type: "error" as const,
      error: { type: "invalid_request_error" as const, message: "Bad request" },
    };
    const result = ensureAnthropicErrorFormat(400, valid);
    expect(result).toEqual(valid);
  });

  it("wraps partial format (missing outer type)", () => {
    const partial = {
      error: { type: "authentication_error", message: "Invalid key" },
    };
    const result = ensureAnthropicErrorFormat(401, partial);
    expect(result).toEqual({
      type: "error",
      error: { type: "authentication_error", message: "Invalid key" },
    });
  });

  it("wraps OpenAI error format", () => {
    const openaiError = {
      error: { message: "Model not found", code: "model_not_found" },
    };
    const result = ensureAnthropicErrorFormat(404, openaiError);
    expect(result.type).toBe("error");
    expect(result.error.message).toBe("Model not found");
  });

  it("wraps a raw string body", () => {
    const result = ensureAnthropicErrorFormat(500, "Internal Server Error");
    expect(result).toEqual({
      type: "error",
      error: { type: "api_error", message: "Internal Server Error" },
    });
  });

  it("wraps null body", () => {
    const result = ensureAnthropicErrorFormat(500, null);
    expect(result.type).toBe("error");
    expect(result.error.type).toBe("api_error");
    expect(typeof result.error.message).toBe("string");
  });

  it("wraps undefined body", () => {
    const result = ensureAnthropicErrorFormat(500, undefined);
    expect(result.type).toBe("error");
    expect(result.error.type).toBe("api_error");
    expect(typeof result.error.message).toBe("string");
  });

  it("extracts message from nested error object", () => {
    const body = { error: { message: "Rate limit exceeded" } };
    const result = ensureAnthropicErrorFormat(429, body);
    expect(result.error.message).toBe("Rate limit exceeded");
    expect(result.error.type).toBe("rate_limit_error");
  });

  it("extracts message from top-level message field", () => {
    const body = { message: "Something went wrong", code: "server_error" };
    const result = ensureAnthropicErrorFormat(500, body);
    expect(result.error.message).toBe("Something went wrong");
  });

  it("preserves provider error type when present", () => {
    const body = { error: "some raw error", type: "overloaded_error" };
    const result = ensureAnthropicErrorFormat(503, body);
    expect(result.error.type).toBe("overloaded_error");
  });
});

describe("extractProviderMessage", () => {
  it("returns a raw string as-is", () => {
    expect(extractProviderMessage("plain error")).toBe("plain error");
  });

  it("pulls error.message from OpenAI-style bodies", () => {
    expect(extractProviderMessage({ error: { message: "invalid api key" } })).toBe(
      "invalid api key"
    );
  });

  it("pulls top-level message", () => {
    expect(extractProviderMessage({ message: "boom" })).toBe("boom");
  });

  it("pulls a string error field", () => {
    expect(extractProviderMessage({ error: "raw error string" })).toBe("raw error string");
  });

  it("pulls FastAPI-style string detail", () => {
    expect(extractProviderMessage({ detail: "model gpt-5 not supported" })).toBe(
      "model gpt-5 not supported"
    );
  });

  it("pulls the msg out of a FastAPI structured detail array", () => {
    expect(extractProviderMessage({ detail: [{ msg: "Missing API key", loc: ["header"] }] })).toBe(
      "Missing API key"
    );
  });

  it("pulls error.detail (nested) before falling back to JSON", () => {
    expect(
      extractProviderMessage({ error: { detail: "No active subscription for fugu-ultra" } })
    ).toBe("No active subscription for fugu-ultra");
  });

  it("prefers error.message over a less-specific detail", () => {
    // OpenAI-style nested message wins over a sibling detail.
    expect(
      extractProviderMessage({ error: { message: "real message", detail: "ignore me" } })
    ).toBe("real message");
  });

  it("falls back to JSON for structured bodies with no message", () => {
    expect(extractProviderMessage({ code: 42 })).toBe('{"code":42}');
  });

  it("handles null/undefined", () => {
    expect(extractProviderMessage(null)).toBe("");
    expect(extractProviderMessage(undefined)).toBe("");
  });
});

describe("isTerminalError", () => {
  it("treats 401/403 as terminal (auth never recovers)", () => {
    expect(isTerminalError(401, "unauthorized", false)).toBe(true);
    expect(isTerminalError(403, "forbidden", false)).toBe(true);
  });

  it("treats a terminal 429 as terminal", () => {
    expect(isTerminalError(429, "insufficient_quota", true)).toBe(true);
  });

  it("does NOT treat a plain 429 rate-limit as terminal", () => {
    expect(isTerminalError(429, "rate limit exceeded, slow down", false)).toBe(false);
  });

  it("does NOT treat a transient 503/overloaded/500 as terminal", () => {
    expect(isTerminalError(503, "service overloaded", false)).toBe(false);
    expect(isTerminalError(500, "internal server error", false)).toBe(false);
    expect(isTerminalError(502, "bad gateway", false)).toBe(false);
  });

  // Quota/billing phrases are specific enough to trust under ANY status —
  // including a 500, where a transient blip would never phrase itself this way.
  // Each case uses a NON-auth status so it can only pass via the keyword path
  // (a 401/403 would short-circuit to terminal and hide a broken matcher).
  it("catches billing/quota signals via the keyword path (not via status)", () => {
    expect(isTerminalError(402, "insufficient balance", false)).toBe(true);
    expect(isTerminalError(400, "out of credits", false)).toBe(true);
    expect(isTerminalError(500, '{"error":{"message":"billing_not_active"}}', false)).toBe(true);
    expect(isTerminalError(500, '{"error":{"message":"insufficient_quota"}}', false)).toBe(true);
    expect(isTerminalError(500, '{"detail":"No credits remaining"}', false)).toBe(true);
  });

  it("matches quota keywords case-insensitively", () => {
    expect(isTerminalError(500, '{"error":{"message":"INSUFFICIENT BALANCE"}}', false)).toBe(true);
  });

  it("catches model-not-supported errors on 4xx statuses", () => {
    expect(isTerminalError(400, "model gpt-5 is not supported", false)).toBe(true);
    expect(isTerminalError(404, "model_not_found", false)).toBe(true);
    expect(isTerminalError(400, '{"error":{"message":"Unknown model: fugu-ultra"}}', false)).toBe(
      true
    );
    expect(
      isTerminalError(404, '{"error":{"code":"unsupported_model"}}', false)
    ).toBe(true);
  });

  it("catches expired-subscription wording on a 4xx status", () => {
    expect(isTerminalError(400, "Your subscription has expired", false)).toBe(true);
    // Only one of the two words is not enough
    expect(isTerminalError(400, "subscription active", false)).toBe(false);
  });

  // --- FALSE-POSITIVE GUARDS (the load-bearing correctness cases) ---
  // Generic English ("not supported", "subscription ... expired") can appear
  // inside a TRANSIENT 5xx body. Classifying those as terminal would stop a
  // retry that would have succeeded — strictly worse than a wasted retry.
  it("does NOT classify a transient 5xx as terminal just because its prose contains 'not supported'", () => {
    expect(
      isTerminalError(
        503,
        "Retry-After header not supported by upstream gateway; service overloaded",
        false
      )
    ).toBe(false);
  });

  it("does NOT classify a transient 5xx as terminal for incidental 'subscription ... expired' prose", () => {
    expect(isTerminalError(503, "subscription usage cache expired; retry later", false)).toBe(
      false
    );
  });

  it("does NOT classify a transient 5xx 'unknown model' as terminal (server failure, retry)", () => {
    // A 5xx is a server failure; model-routing problems come back as 4xx.
    expect(isTerminalError(500, "temporary unknown model routing error", false)).toBe(false);
  });
});

describe("buildSurfacedErrorMessage", () => {
  it("combines provider, status, hint, and upstream message", () => {
    const msg = buildSurfacedErrorMessage({
      providerDisplayName: "Sakana Fugu",
      status: 401,
      hint: "Check API key / OAuth credentials.",
      providerMessage: "invalid api key",
    });
    expect(msg).toContain("Sakana Fugu error (HTTP 401)");
    expect(msg).toContain("Check API key / OAuth credentials.");
    expect(msg).toContain("invalid api key");
  });

  it("omits the detail tail when message is empty", () => {
    const msg = buildSurfacedErrorMessage({
      providerDisplayName: "Sakana Fugu",
      status: 503,
      hint: "Provider overloaded.",
      providerMessage: "",
    });
    expect(msg).toBe("Sakana Fugu error (HTTP 503): Provider overloaded.");
  });

  it("does not duplicate the message when hint already contains it", () => {
    const msg = buildSurfacedErrorMessage({
      providerDisplayName: "X",
      status: 400,
      hint: "out of credits",
      providerMessage: "out of credits",
    });
    // Appears once (in the hint), not twice
    expect(msg.match(/out of credits/g)?.length).toBe(1);
  });

  it("does NOT truncate a message exactly at the 600-char boundary", () => {
    const exact = "x".repeat(600);
    const msg = buildSurfacedErrorMessage({
      providerDisplayName: "X",
      status: 500,
      hint: "Server error.",
      providerMessage: exact,
    });
    expect(msg).not.toContain("…");
    expect(msg).toContain(exact);
  });

  it("truncates a message one char past the boundary to 600 + ellipsis", () => {
    const over = "x".repeat(601);
    const msg = buildSurfacedErrorMessage({
      providerDisplayName: "X",
      status: 500,
      hint: "Server error.",
      providerMessage: over,
    });
    expect(msg).toContain(`${"x".repeat(600)}…`);
    expect(msg).not.toContain("x".repeat(601));
  });
});
