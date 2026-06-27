/**
 * Regression pin for Step 5b — OpenAI Codex OAuth delegation.
 *
 * OpenAICodexTransport used to read ~/.claudish/codex-oauth.json directly in BOTH
 * getEndpoint() and getHeaders(), and minted OAuth headers / picked the chatgpt.com
 * endpoint inline. Step 5 moves all of that to credentials.getRequestAuth("openai-codex"),
 * cached by a new refreshAuth() (called by composed-handler BEFORE getEndpoint/getHeaders).
 *
 * This test pins:
 *   OAuth present → chatgpt.com/backend-api/codex/responses endpoint
 *                 + buildOAuthHeaders shape (6 headers w/ accountId)
 *                 + transformPayload adds store:false / include + model normalization
 *   No OAuth (key only) → api.openai.com static endpoint + Bearer <apiKey>
 *                 + transformPayload still normalizes model (pure, non-auth) but
 *                   does NOT add the store/include auth bits.
 *
 * Hermetic: mock credentials.getRequestAuth (the delegation target). The OAuth case
 * returns the artifact the real CodexOAuthHalf.getRequestAuth() produces; the
 * no-OAuth case throws (composite would fall to the api-key half, which the
 * transport models by leaving cachedAuth null → super.getHeaders()/static endpoint).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { RemoteProvider } from "../../handlers/shared/remote-provider-types.js";

const FAKE_TOKEN = "codex-oauth-token-abc";
const FAKE_ACCOUNT = "acct-123";
const CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

// What the real CodexOAuthHalf.getRequestAuth() returns (buildOAuthHeaders + endpoint + transform).
const CODEX_OAUTH_AUTH = {
  headers: {
    Authorization: `Bearer ${FAKE_TOKEN}`,
    "OpenAI-Beta": "responses=experimental",
    originator: "codex_cli_rs",
    accept: "text/event-stream",
    "chatgpt-account-id": FAKE_ACCOUNT,
    "x-conversation-id": "claudish-session",
    "x-session-id": "claudish-session",
  },
  endpoint: CODEX_ENDPOINT,
  transformPayload: (p: any) => ({
    ...p,
    store: false,
    include: ["reasoning.encrypted_content"],
  }),
};

let getRequestAuthMock = mock(async (_name: string, _ctx: any) => CODEX_OAUTH_AUTH as any);

mock.module("../../auth/credentials/authority.js", () => ({
  credentials: {
    getRequestAuth: (name: string, ctx: any) => getRequestAuthMock(name, ctx),
  },
}));

const { OpenAICodexTransport } = await import("./openai-codex.js");

const provider: RemoteProvider = {
  name: "openai-codex",
  baseUrl: "https://api.openai.com",
  apiPath: "/v1/responses",
  apiKeyEnvVar: "OPENAI_CODEX_API_KEY",
  prefixes: ["cx@", "codex@"],
};

beforeEach(() => {
  getRequestAuthMock = mock(async (_name: string, _ctx: any) => CODEX_OAUTH_AUTH as any);
});

afterEach(() => {
  mock.restore();
});

describe("OpenAICodexTransport — OAuth present (delegated)", () => {
  test("refreshAuth → chatgpt.com endpoint + OAuth headers + store/include transform", async () => {
    const t = new OpenAICodexTransport(provider, "gpt-5.1-codex", "ignored-api-key");
    await t.refreshAuth();

    // endpoint comes from cachedAuth
    expect(t.getEndpoint()).toBe(CODEX_ENDPOINT);

    // headers come from cachedAuth (the 6 OAuth headers w/ accountId)
    const headers = await t.getHeaders();
    expect(headers["Authorization"]).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(headers["OpenAI-Beta"]).toBe("responses=experimental");
    expect(headers["originator"]).toBe("codex_cli_rs");
    expect(headers["accept"]).toBe("text/event-stream");
    expect(headers["chatgpt-account-id"]).toBe(FAKE_ACCOUNT);
    expect(headers["x-conversation-id"]).toBe("claudish-session");
    expect(headers["x-session-id"]).toBe("claudish-session");

    // transformPayload adds the auth-derived store/include bits.
    const out = t.transformPayload({ model: "gpt-5.1-codex", input: "hi" });
    expect(out.store).toBe(false);
    expect(out.include).toEqual(["reasoning.encrypted_content"]);

    // delegates with the openai-codex catalog name
    expect(getRequestAuthMock).toHaveBeenCalledTimes(1);
    expect(getRequestAuthMock.mock.calls[0][0]).toBe("openai-codex");
  });

  test("transformPayload still normalizes the model name under OAuth", async () => {
    const t = new OpenAICodexTransport(provider, "gpt-4.5", "ignored");
    await t.refreshAuth();
    const out = t.transformPayload({ model: "gpt-4.5", input: "x" });
    // model normalization is preserved (auth transform spreads the incoming payload,
    // which the transport has already normalized).
    expect(typeof out.model).toBe("string");
    expect(out.store).toBe(false);
  });
});

describe("OpenAICodexTransport — no OAuth (api-key only)", () => {
  beforeEach(() => {
    // Composite falls through to the api-key half → transport models this by
    // getRequestAuth throwing, leaving cachedAuth null.
    getRequestAuthMock = mock(async () => {
      throw new Error("no oauth");
    });
  });

  test("refreshAuth swallows failure → static api.openai.com endpoint + Bearer apiKey", async () => {
    const t = new OpenAICodexTransport(provider, "gpt-5.1-codex", "sk-codex-key");
    await t.refreshAuth();

    // Static fallback endpoint is the codex Responses endpoint on api.openai.com
    // (the base OpenAI transport routes codex models to /v1/responses).
    expect(t.getEndpoint()).toBe("https://api.openai.com/v1/responses");

    // Headers come from super.getHeaders() → Bearer <apiKey>, no OAuth headers.
    const headers = await t.getHeaders();
    expect(headers["Authorization"]).toBe("Bearer sk-codex-key");
    expect(headers["OpenAI-Beta"]).toBeUndefined();
    expect(headers["chatgpt-account-id"]).toBeUndefined();
  });

  test("transformPayload normalizes model but does NOT add auth store/include bits", async () => {
    const t = new OpenAICodexTransport(provider, "gpt-5.1-codex", "sk-codex-key");
    await t.refreshAuth();
    const out = t.transformPayload({ model: "gpt-5.1-codex", input: "y" });
    expect(out.store).toBeUndefined();
    expect(out.include).toBeUndefined();
    expect(typeof out.model).toBe("string");
  });
});
