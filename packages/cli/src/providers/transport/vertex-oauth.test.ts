/**
 * Regression pin for Step 5d — Vertex AI OAuth delegation.
 *
 * VertexProviderTransport.refreshAuth() used to call getVertexAuthManager()
 * .getAccessToken() directly and getHeaders() built Authorization: Bearer
 * <accessToken> inline. Step 5 delegates the normal-path header construction to
 * credentials.getRequestAuth("vertex"), while KEEPING forceRefreshAuth()'s
 * cache-busting 401-retry semantics (the credential's getRequestAuth does not
 * express a force-refresh, so the transport still busts the shared manager cache
 * directly, then re-delegates).
 *
 * This test pins:
 *   - getHeaders() after refreshAuth() → Authorization: Bearer <delegated token>
 *   - delegation targets the "vertex" catalog name
 *   - forceRefreshAuth() busts the manager cache (refreshToken called) AND
 *     re-delegates → getHeaders() returns the refreshed token
 *   - getEndpoint() / transformPayload() / getRequestInit() are unchanged
 *
 * Hermetic: mock credentials.getRequestAuth (delegation target) and the vertex-auth
 * manager (so refreshToken is observable and no gcloud/ADC is touched).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { VertexConfig } from "../../auth/vertex-auth.js";

let currentToken = "vertex-token-A";
const refreshTokenMock = mock(async () => {
  currentToken = "vertex-token-B"; // force-refresh swaps the token
});
const getAccessTokenMock = mock(async () => currentToken);

let getRequestAuthMock = mock(async (_name: string, _ctx: any) => ({
  headers: { Authorization: `Bearer ${currentToken}` },
}));

mock.module("../../auth/credentials/authority.js", () => ({
  credentials: {
    getRequestAuth: (name: string, ctx: any) => getRequestAuthMock(name, ctx),
  },
}));

mock.module("../../auth/vertex-auth.js", () => ({
  getVertexAuthManager: () => ({
    getAccessToken: getAccessTokenMock,
    refreshToken: refreshTokenMock,
  }),
  buildVertexOAuthEndpoint: (_config: any, publisher: string, model: string, _streaming: boolean) =>
    `https://vertex.example/${publisher}/${model}:streamGenerateContent`,
}));

const { VertexProviderTransport, parseVertexModel } = await import("./vertex-oauth.js");

const config = { project: "p", location: "us-central1" } as unknown as VertexConfig;

beforeEach(() => {
  currentToken = "vertex-token-A";
  refreshTokenMock.mockClear();
  getAccessTokenMock.mockClear();
  getRequestAuthMock = mock(async (_name: string, _ctx: any) => ({
    headers: { Authorization: `Bearer ${currentToken}` },
  }));
});

afterEach(() => {
  mock.restore();
});

describe("VertexProviderTransport — delegated auth", () => {
  test("refreshAuth() → getHeaders() returns the delegated Bearer token", async () => {
    const t = new VertexProviderTransport(config, parseVertexModel("gemini-2.5-flash"));
    await t.refreshAuth();
    const headers = await t.getHeaders();
    expect(headers["Authorization"]).toBe("Bearer vertex-token-A");

    expect(getRequestAuthMock).toHaveBeenCalledTimes(1);
    expect(getRequestAuthMock.mock.calls[0][0]).toBe("vertex");
  });

  test("forceRefreshAuth() busts the manager cache and re-delegates the fresh token", async () => {
    const t = new VertexProviderTransport(config, parseVertexModel("gemini-2.5-flash"));
    await t.refreshAuth();
    expect((await t.getHeaders())["Authorization"]).toBe("Bearer vertex-token-A");

    await t.forceRefreshAuth();
    // Cache was busted via the shared manager (401-retry semantics preserved).
    expect(refreshTokenMock).toHaveBeenCalledTimes(1);
    // Re-delegated artifact carries the refreshed token.
    expect((await t.getHeaders())["Authorization"]).toBe("Bearer vertex-token-B");
  });

  test("getEndpoint() / getRequestInit() unchanged; anthropic transformPayload unchanged", () => {
    const t = new VertexProviderTransport(config, parseVertexModel("anthropic/claude-3-5-sonnet"));
    expect(t.getEndpoint()).toBe(
      "https://vertex.example/anthropic/claude-3-5-sonnet:streamGenerateContent"
    );
    const init = t.getRequestInit();
    expect(init.signal).toBeDefined();

    const payload: any = { model: "claude-3-5-sonnet", messages: [] };
    const out = t.transformPayload(payload);
    expect(out.anthropic_version).toBe("vertex-2023-10-16");
    expect(out.model).toBeUndefined();
  });
});
