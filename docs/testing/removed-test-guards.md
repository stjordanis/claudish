# Test cull — sacrificed coverage record

This records the behavior guards **deliberately removed** in the aggressive test cull
(per explicit instruction to "cut harder" past the adversarial verifier's protection).
These were the **sole automated guard** for the listed behaviors. Deleting them means a
regression in these areas will **not** be caught by the test suite. Recorded here so the
loss is explicit and can be reversed if any of these regress in the wild.

## Highest-risk removals (real shipped bugs these guarded)

- **`provider-routing.test.ts` — model→dialect routing matrix**, including the **#102
  regression guard** (`zai@glm-4.7 → DefaultAPIFormat`, not GLMModelDialect). #102 was a
  real shipped bug. Also removed: gemini/gpt/o-series/codex/qwen/deepseek/minimax/xiaomi
  dialect selection, vendor-prefix routing, mid-string false-positive guards, and the
  PROVIDER_PROFILES↔BUILTIN_PROVIDERS consistency checks.
- **`tool-count-cap.test.ts` — OpenAI 128-tool cap** (and Codex-uncapped divergence). This
  exact value was silently deleted once (commit 3edc60f) and broke every OpenAI run with
  >128 tools. No other checked-in test guards it; the head-slice is only exercised on the
  live `oai@` path.
- **`authority.test.ts` — credential/provider registration**: local providers
  (ollama/lmstudio/vllm/mlx), kimi/codex/vertex/native-anthropic registration, composite
  invalidate() fan-out (both halves), login/logout routing to primary. Dropping these
  means `--model ollama@…` / `cx@…` / vertex routing can break undetected, and
  hydrate-on-add (TUI) key application relies on the invalidate fan-out.

## Other sole-guard removals

- `model-selector.test.ts` — picker→Firebase slug mapping, user-deployed-provider
  classification, fixedModel (kimi-coding single-model) declarations.
- `provider-definitions.test.ts` — duplicate name/shortcut/prefix detection, local vs
  remote transport classification, direct-API classification, display names.
- `routing-rules.test.ts` — loadRoutingRules non-null + catch-all guarantee, displayName.
- `format-translation.test.ts` — MiniMax context-window/vision, Gemini stream format,
  Codex shouldHandle, ProviderProfile registration completeness.
- transport oauth tests — kimi-coding catalog-name delegation, Gemini CodeAssist envelope
  + headers, codex payload model normalization under OAuth.
- `mcp-server.test.ts` — async getRecommendedModels (not the stale sync path).
- `op-source.test.ts` — sniff memoization; `model-loader.test.ts` — sync freshness gate.

If any of these behaviors regress, restore the corresponding test from git history
(the commit immediately before the aggressive cull).
