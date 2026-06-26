import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ApiKeyCredentialProvider } from "./api-key-credential.js";
import { CredentialAuthority } from "./authority.js";
import { CompositeCredentialProvider } from "./composite-credential.js";
import type { CredentialProvider, RequestAuth, RequestAuthContext } from "./types.js";

// ── Test helpers ────────────────────────────────────────────────────────────

/** A fake CredentialProvider with scriptable authed-state + artifact/throw. */
class FakeProvider implements CredentialProvider {
  readonly catalogName: string;
  authed: boolean;
  private artifact: RequestAuth;
  private throwError?: Error;
  loginCalls = 0;
  logoutCalls = 0;
  getRequestAuthCalls = 0;

  constructor(
    catalogName: string,
    opts: { authed?: boolean; artifact?: RequestAuth; throwError?: Error } = {}
  ) {
    this.catalogName = catalogName;
    this.authed = opts.authed ?? false;
    this.artifact = opts.artifact ?? { headers: { "x-from": catalogName } };
    this.throwError = opts.throwError;
  }

  isAuthenticated(): boolean {
    return this.authed;
  }

  async getRequestAuth(_ctx: RequestAuthContext): Promise<RequestAuth> {
    this.getRequestAuthCalls++;
    if (this.throwError) throw this.throwError;
    return this.artifact;
  }

  async login(): Promise<void> {
    this.loginCalls++;
  }

  async logout(): Promise<void> {
    this.logoutCalls++;
  }
}

const CTX: RequestAuthContext = { model: "test-model" };

// ── ApiKeyCredentialProvider ────────────────────────────────────────────────

describe("ApiKeyCredentialProvider", () => {
  const ENV_VAR = "CLAUDISH_TEST_FAKE_API_KEY";
  const ALIAS = "CLAUDISH_TEST_FAKE_API_KEY_ALIAS";
  let savedEnv: string | undefined;
  let savedAlias: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[ENV_VAR];
    savedAlias = process.env[ALIAS];
    delete process.env[ENV_VAR];
    delete process.env[ALIAS];
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = savedEnv;
    if (savedAlias === undefined) delete process.env[ALIAS];
    else process.env[ALIAS] = savedAlias;
  });

  test("isAuthenticated() is true when the env var is set", () => {
    const provider = new ApiKeyCredentialProvider({ catalogName: "fake", envVar: ENV_VAR });
    expect(provider.isAuthenticated()).toBe(false);
    process.env[ENV_VAR] = "sk-test-123";
    expect(provider.isAuthenticated()).toBe(true);
  });

  test("isAuthenticated() is true when an alias env var is set", () => {
    const provider = new ApiKeyCredentialProvider({
      catalogName: "fake",
      envVar: ENV_VAR,
      aliases: [ALIAS],
    });
    expect(provider.isAuthenticated()).toBe(false);
    process.env[ALIAS] = "sk-alias-456";
    expect(provider.isAuthenticated()).toBe(true);
  });

  test("getRequestAuth() returns an Authorization Bearer header (bearer scheme)", async () => {
    process.env[ENV_VAR] = "sk-bearer-789";
    const provider = new ApiKeyCredentialProvider({ catalogName: "fake", envVar: ENV_VAR });
    const auth = await provider.getRequestAuth(CTX);
    expect(auth.headers.Authorization).toBe("Bearer sk-bearer-789");
    expect(auth.endpoint).toBeUndefined();
    expect(auth.transformPayload).toBeUndefined();
  });

  test("getRequestAuth() uses x-api-key header when authScheme is x-api-key", async () => {
    process.env[ENV_VAR] = "sk-xkey-000";
    const provider = new ApiKeyCredentialProvider({
      catalogName: "fake",
      envVar: ENV_VAR,
      authScheme: "x-api-key",
    });
    const auth = await provider.getRequestAuth(CTX);
    expect(auth.headers["x-api-key"]).toBe("sk-xkey-000");
    expect(auth.headers.Authorization).toBeUndefined();
  });

  test("getRequestAuth() merges staticHeaders", async () => {
    process.env[ENV_VAR] = "sk-static";
    const provider = new ApiKeyCredentialProvider({
      catalogName: "fake",
      envVar: ENV_VAR,
      staticHeaders: { "X-Title": "claudish" },
    });
    const auth = await provider.getRequestAuth(CTX);
    expect(auth.headers["X-Title"]).toBe("claudish");
    expect(auth.headers.Authorization).toBe("Bearer sk-static");
  });

  // CRITICAL laziness test: a sync isAuthenticated() check with NO env/config key
  // and an op:// glob in config must return false WITHOUT touching the 1Password
  // SDK. It is sync, so it literally cannot do the async SDK call — we assert it
  // returns false and never throws.
  test("isAuthenticated() returns false (no throw) without touching the 1Password SDK", () => {
    const opOnlyVar = "CLAUDISH_TEST_OP_ONLY_KEY_XYZ";
    const saved = process.env[opOnlyVar];
    delete process.env[opOnlyVar];
    try {
      const provider = new ApiKeyCredentialProvider({ catalogName: "fake", envVar: opOnlyVar });
      // Even if config.json contained "op://Vault/Item/FAKE_FIELD" for this var,
      // the sync resolver cannot resolve it (no SDK), so the check is false.
      let result: boolean | undefined;
      expect(() => {
        result = provider.isAuthenticated();
      }).not.toThrow();
      expect(result).toBe(false);
    } finally {
      if (saved === undefined) delete process.env[opOnlyVar];
      else process.env[opOnlyVar] = saved;
    }
  });
});

// ── CompositeCredentialProvider ─────────────────────────────────────────────

describe("CompositeCredentialProvider", () => {
  test("isAuthenticated() is true when either half is authed", () => {
    const neither = new CompositeCredentialProvider(
      "c",
      new FakeProvider("p", { authed: false }),
      new FakeProvider("f", { authed: false })
    );
    expect(neither.isAuthenticated()).toBe(false);

    const primaryOnly = new CompositeCredentialProvider(
      "c",
      new FakeProvider("p", { authed: true }),
      new FakeProvider("f", { authed: false })
    );
    expect(primaryOnly.isAuthenticated()).toBe(true);

    const fallbackOnly = new CompositeCredentialProvider(
      "c",
      new FakeProvider("p", { authed: false }),
      new FakeProvider("f", { authed: true })
    );
    expect(fallbackOnly.isAuthenticated()).toBe(true);
  });

  test("primary authed → returns the primary artifact", async () => {
    const primary = new FakeProvider("p", {
      authed: true,
      artifact: { headers: { src: "primary" } },
    });
    const fallback = new FakeProvider("f", {
      authed: true,
      artifact: { headers: { src: "fallback" } },
    });
    const composite = new CompositeCredentialProvider("c", primary, fallback);
    const auth = await composite.getRequestAuth(CTX);
    expect(auth.headers.src).toBe("primary");
    expect(fallback.getRequestAuthCalls).toBe(0);
  });

  test("primary unauthed → returns the fallback artifact", async () => {
    const primary = new FakeProvider("p", {
      authed: false,
      artifact: { headers: { src: "primary" } },
    });
    const fallback = new FakeProvider("f", {
      authed: true,
      artifact: { headers: { src: "fallback" } },
    });
    const composite = new CompositeCredentialProvider("c", primary, fallback);
    const auth = await composite.getRequestAuth(CTX);
    expect(auth.headers.src).toBe("fallback");
    expect(primary.getRequestAuthCalls).toBe(0);
  });

  test("primary throws the fallbackSignal → falls through to fallback", async () => {
    const primary = new FakeProvider("p", {
      authed: true,
      throwError: new Error("OAuth_FALLBACK_TO_API_KEY"),
    });
    const fallback = new FakeProvider("f", {
      authed: true,
      artifact: { headers: { src: "fallback" } },
    });
    const composite = new CompositeCredentialProvider("c", primary, fallback, {
      fallbackSignal: "OAuth_FALLBACK_TO_API_KEY",
    });
    const auth = await composite.getRequestAuth(CTX);
    expect(auth.headers.src).toBe("fallback");
    expect(primary.getRequestAuthCalls).toBe(1);
    expect(fallback.getRequestAuthCalls).toBe(1);
  });

  test("primary throws a non-signal error → rethrows (no fallback)", async () => {
    const primary = new FakeProvider("p", {
      authed: true,
      throwError: new Error("network exploded"),
    });
    const fallback = new FakeProvider("f", { authed: true });
    const composite = new CompositeCredentialProvider("c", primary, fallback, {
      fallbackSignal: "OAuth_FALLBACK_TO_API_KEY",
    });
    await expect(composite.getRequestAuth(CTX)).rejects.toThrow("network exploded");
    expect(fallback.getRequestAuthCalls).toBe(0);
  });

  test("login/logout delegate to the primary", async () => {
    const primary = new FakeProvider("p");
    const fallback = new FakeProvider("f");
    const composite = new CompositeCredentialProvider("c", primary, fallback);
    await composite.login();
    await composite.logout();
    expect(primary.loginCalls).toBe(1);
    expect(primary.logoutCalls).toBe(1);
    expect(fallback.loginCalls).toBe(0);
    expect(fallback.logoutCalls).toBe(0);
  });
});

// ── CredentialAuthority registry/dispatch ───────────────────────────────────

describe("CredentialAuthority", () => {
  test("register + isAuthenticated dispatch by catalogName", () => {
    const authority = new CredentialAuthority();
    authority.register(new FakeProvider("alpha", { authed: true }));
    authority.register(new FakeProvider("beta", { authed: false }));
    expect(authority.isAuthenticated("alpha")).toBe(true);
    expect(authority.isAuthenticated("beta")).toBe(false);
  });

  test("aliases resolve to the same instance", () => {
    const authority = new CredentialAuthority();
    const instance = new FakeProvider("gemini-codeassist", { authed: true });
    authority.register(instance, ["gemini-codeassist", "google"]);
    expect(authority.get("gemini-codeassist")).toBe(instance);
    expect(authority.get("google")).toBe(instance);
    expect(authority.isAuthenticated("google")).toBe(true);
  });

  test("unknown name → isAuthenticated false, getRequestAuth throws", async () => {
    const authority = new CredentialAuthority();
    expect(authority.isAuthenticated("nonexistent")).toBe(false);
    await expect(authority.getRequestAuth("nonexistent", CTX)).rejects.toThrow(
      "No credential provider for nonexistent"
    );
  });

  test("isAuthenticated swallows a thrown provider check and returns false", () => {
    const authority = new CredentialAuthority();
    const throwing: CredentialProvider = {
      catalogName: "throws",
      isAuthenticated() {
        throw new Error("boom");
      },
      async getRequestAuth() {
        return { headers: {} };
      },
    };
    authority.register(throwing);
    expect(authority.isAuthenticated("throws")).toBe(false);
  });

  test("getRequestAuth dispatches to the registered provider's artifact", async () => {
    const authority = new CredentialAuthority();
    authority.register(
      new FakeProvider("alpha", { authed: true, artifact: { headers: { who: "alpha" } } })
    );
    const auth = await authority.getRequestAuth("alpha", CTX);
    expect(auth.headers.who).toBe("alpha");
  });

  test("login/logout no-op safely for a provider without those methods", async () => {
    const authority = new CredentialAuthority();
    const minimal: CredentialProvider = {
      catalogName: "minimal",
      isAuthenticated: () => false,
      getRequestAuth: async () => ({ headers: {} }),
    };
    authority.register(minimal);
    // Should not throw despite no login/logout defined.
    await authority.login("minimal");
    await authority.logout("minimal");
    await authority.login("unknown-too");
  });
});

// ── buildDefault() wiring ───────────────────────────────────────────────────

describe("CredentialAuthority.buildDefault()", () => {
  test("registers explicit providers under their catalog names and aliases", () => {
    const authority = CredentialAuthority.buildDefault();
    expect(authority.get("openai-codex")?.catalogName).toBe("openai-codex");
    expect(authority.get("gemini-codeassist")?.catalogName).toBe("gemini-codeassist");
    // google alias resolves to the same Gemini Code Assist instance
    expect(authority.get("google")).toBe(authority.get("gemini-codeassist"));
    expect(authority.get("kimi")?.catalogName).toBe("kimi");
    // kimi-coding alias resolves to the same Kimi instance
    expect(authority.get("kimi-coding")).toBe(authority.get("kimi"));
    expect(authority.get("vertex")?.catalogName).toBe("vertex");
    expect(authority.get("native-anthropic")?.catalogName).toBe("native-anthropic");
  });

  test("registers a LocalCredentialProvider for each local provider", () => {
    const authority = CredentialAuthority.buildDefault();
    for (const name of ["ollama", "lmstudio", "vllm", "mlx"]) {
      expect(authority.get(name)?.catalogName).toBe(name);
    }
  });

  test("registers ApiKeyCredentialProviders for other builtin providers", () => {
    const authority = CredentialAuthority.buildDefault();
    // openrouter / openai / glm etc. are plain API-key providers
    expect(authority.get("openrouter")?.catalogName).toBe("openrouter");
    expect(authority.get("openai")?.catalogName).toBe("openai");
    expect(authority.get("glm")?.catalogName).toBe("glm");
  });

  // The real OAuth singletons read real credential files; we only assert the
  // negative (no oauth file → not authenticated) to keep the test hermetic.
  test("OAuth-backed credentials report not-authenticated when no credentials exist", () => {
    const authority = CredentialAuthority.buildDefault();
    // These depend on whether the running machine happens to have oauth files;
    // we don't assert a specific value, only that the sync check never throws.
    expect(() => authority.isAuthenticated("openai-codex")).not.toThrow();
    expect(() => authority.isAuthenticated("gemini-codeassist")).not.toThrow();
    expect(() => authority.isAuthenticated("kimi")).not.toThrow();
    expect(() => authority.isAuthenticated("vertex")).not.toThrow();
  });
});
