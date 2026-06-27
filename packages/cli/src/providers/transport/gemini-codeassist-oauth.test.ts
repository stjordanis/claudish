/**
 * Regression pin for Step 5c — Gemini Code Assist OAuth delegation.
 *
 * GeminiCodeAssistProviderTransport.refreshAuth() used to call getValidAccessToken()
 * + setupGeminiUser() directly and build headers / the CodeAssist envelope inline.
 * Step 5 delegates the PRIMARY header + envelope construction to
 * credentials.getRequestAuth("gemini-codeassist"), while KEEPING the local
 * accessToken / projectId / tierId state that the 429 fallback chain and quota
 * logic depend on (request-routing, not auth).
 *
 * This test pins:
 *   - getHeaders() returns the delegated artifact's headers:
 *       Authorization: Bearer <token>, User-Agent: GeminiCLI/..., x-activity-request-id
 *   - transformPayload() returns the delegated CodeAssist envelope:
 *       { model, project, user_prompt_id, request: <inner> }  (+ enabled_credit_types on paid)
 *   - getEndpoint() is unchanged (fixed cloudcode-pa endpoint)
 *   - the queue / 429 classification helpers are untouched (covered elsewhere)
 *
 * Hermetic: mock credentials.getRequestAuth (the delegation target) AND the gemini
 * oauth leaf functions (getValidAccessToken/setupGeminiUser/getGeminiTierDisplayName)
 * that the transport still consults to populate fallback/quota state — both read the
 * SAME values, so behavior is identical to the pre-change inline path.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const FAKE_TOKEN = "gemini-oauth-token-123";
const PROJECT_ID = "proj-abc";

// The artifact credentials.getRequestAuth("gemini-codeassist") returns — mirrors
// GeminiCodeAssistCredentialProvider.getRequestAuth() exactly.
function makeAuth(tierId: string) {
  return {
    headers: {
      Authorization: `Bearer ${FAKE_TOKEN}`,
      "User-Agent": "GeminiCLI/0.5.6/gemini-2.5-pro (darwin; arm64)",
      "x-activity-request-id": "act-fixed-id",
    },
    transformPayload: (inner: any) => {
      const env: any = {
        model: "gemini-2.5-pro",
        project: PROJECT_ID,
        user_prompt_id: "uuid-fixed",
        request: inner,
      };
      if (tierId && tierId !== "free-tier") {
        env.enabled_credit_types = ["GOOGLE_ONE_AI"];
      }
      return env;
    },
  };
}

let currentTier = "free-tier";
let getRequestAuthMock = mock(async (_name: string, _ctx: any) => makeAuth(currentTier) as any);

mock.module("../../auth/credentials/authority.js", () => ({
  credentials: {
    getRequestAuth: (name: string, ctx: any) => getRequestAuthMock(name, ctx),
  },
}));

// Leaf oauth functions the transport keeps consulting for fallback/quota state.
mock.module("../../auth/gemini-oauth.js", () => ({
  getValidAccessToken: async () => FAKE_TOKEN,
  setupGeminiUser: async () => ({ projectId: PROJECT_ID, tierId: currentTier }),
  getGeminiTierDisplayName: () => (currentTier === "free-tier" ? "GeminiCA Free" : "GeminiCA Pro"),
  retrieveUserQuota: async () => ({ buckets: [] }),
  CODE_ASSIST_FALLBACK_CHAIN: ["gemini-2.5-pro", "gemini-2.5-flash"],
}));

const { GeminiCodeAssistProviderTransport } = await import("./gemini-codeassist.js");

beforeEach(() => {
  currentTier = "free-tier";
  getRequestAuthMock = mock(async (_name: string, _ctx: any) => makeAuth(currentTier) as any);
});

afterEach(() => {
  mock.restore();
});

describe("GeminiCodeAssistProviderTransport — delegated auth artifact", () => {
  test("getHeaders() returns the delegated headers (Bearer + User-Agent + activity id)", async () => {
    const t = new GeminiCodeAssistProviderTransport("gemini-2.5-pro");
    await t.refreshAuth();
    const headers = await t.getHeaders();

    expect(headers["Authorization"]).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(headers["User-Agent"]).toBe("GeminiCLI/0.5.6/gemini-2.5-pro (darwin; arm64)");
    expect(headers["x-activity-request-id"]).toBe("act-fixed-id");

    expect(getRequestAuthMock).toHaveBeenCalledTimes(1);
    expect(getRequestAuthMock.mock.calls[0][0]).toBe("gemini-codeassist");
  });

  test("transformPayload() returns the CodeAssist envelope (free tier: no credit types)", async () => {
    const t = new GeminiCodeAssistProviderTransport("gemini-2.5-pro");
    await t.refreshAuth();
    const env = t.transformPayload({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });

    expect(env.model).toBe("gemini-2.5-pro");
    expect(env.project).toBe(PROJECT_ID);
    expect(env.user_prompt_id).toBe("uuid-fixed");
    expect(env.request).toEqual({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });
    expect(env.enabled_credit_types).toBeUndefined();
  });

  test("transformPayload() adds enabled_credit_types on a paid tier", async () => {
    currentTier = "g1-pro-tier";
    getRequestAuthMock = mock(async (_name: string, _ctx: any) => makeAuth(currentTier) as any);
    const t = new GeminiCodeAssistProviderTransport("gemini-2.5-pro");
    await t.refreshAuth();
    const env = t.transformPayload({ contents: [] });
    expect(env.enabled_credit_types).toEqual(["GOOGLE_ONE_AI"]);
  });

  test("getEndpoint() is unchanged (fixed cloudcode-pa endpoint)", async () => {
    const t = new GeminiCodeAssistProviderTransport("gemini-2.5-pro");
    expect(t.getEndpoint()).toBe(
      "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"
    );
  });

  test("displayName reflects tier after refreshAuth (status line)", async () => {
    currentTier = "g1-pro-tier";
    getRequestAuthMock = mock(async (_name: string, _ctx: any) => makeAuth(currentTier) as any);
    const t = new GeminiCodeAssistProviderTransport("gemini-2.5-pro");
    await t.refreshAuth();
    expect(t.displayName).toBe("GeminiCA Pro");
  });
});
