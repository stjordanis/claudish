/**
 * OpenAIAPIFormat — Layer 1 wire format for OpenAI Chat Completions API.
 *
 * Handles:
 * - Context window detection for OpenAI models (gpt-*, o1, o3, codex)
 * - Mapping 'thinking.budget_tokens' to 'reasoning_effort' for o1/o3 models
 * - max_completion_tokens vs max_tokens for newer models
 * - Codex Responses API message conversion and payload building
 * - Tool choice mapping
 *
 * Also serves as Layer 2 ModelDialect for OpenAI-native models (o1/o3 reasoning params).
 */

import { BaseAPIFormat, type AdapterResult, type EffortLevel } from "./base-api-format.js";
import { log } from "../logger.js";
import type { StreamFormat } from "../providers/transport/types.js";

export class OpenAIAPIFormat extends BaseAPIFormat {
  constructor(modelId: string) {
    super(modelId);
  }

  processTextContent(textContent: string, accumulatedText: string): AdapterResult {
    return {
      cleanedText: textContent,
      extractedToolCalls: [],
      wasTransformed: false,
    };
  }

  override getStreamFormat(): StreamFormat {
    return "openai-sse";
  }

  /**
   * OpenAI's Chat Completions API hard-caps the tools array at 128. Exceeding
   * it fails the whole request with HTTP 400 "Invalid 'tools': array too long".
   * (Note: CodexAPIFormat is a separate class and is intentionally NOT capped
   * here — the Responses API path keeps its own behavior.)
   */
  override getMaxToolCount(): number | null {
    return 128;
  }

  /**
   * Handle request preparation — reasoning parameters and tool name truncation
   */
  override prepareRequest(request: any, originalRequest: any): any {
    // Map Claude Code's effort (output_config.effort, or legacy
    // thinking.budget_tokens) → OpenAI reasoning_effort for reasoning-capable
    // models. Only set it if buildPayload hasn't already (it builds the payload
    // first; this covers paths that call prepareRequest on a payload built
    // elsewhere). Always strip a leftover `thinking` block — OpenAI rejects it.
    if (this.supportsReasoningEffort() && request.reasoning_effort === undefined) {
      const effort = this.resolveReasoningEffort(originalRequest);
      if (effort) {
        request.reasoning_effort = effort;
        log(`[OpenAIAPIFormat] reasoning_effort -> ${effort} for ${this.modelId}`);
      }
    }
    if (request.thinking) delete request.thinking;

    // Truncate tool names if model has a limit
    this.truncateToolNames(request);
    if (request.messages) {
      this.truncateToolNamesInMessages(request.messages);
    }

    return request;
  }

  shouldHandle(modelId: string): boolean {
    return modelId.startsWith("oai/") || modelId.includes("o1") || modelId.includes("o3");
  }

  getName(): string {
    return "OpenAIAPIFormat";
  }

  // ─── ComposedHandler integration ───────────────────────────────────

  override buildPayload(claudeRequest: any, messages: any[], tools: any[]): any {
    return this.buildChatCompletionsPayload(claudeRequest, messages, tools);
  }

  // ─── Private helpers ───────────────────────────────────────────────

  /**
   * Whether this model accepts OpenAI's `reasoning_effort` parameter. Covers the
   * o-series (o1/o3/o4) AND the gpt-5 family — gpt-5/gpt-5.x take reasoning_effort
   * too, which the older o1/o3-only gate missed (so effort was silently dropped
   * for gpt-5.5). Sakana Fugu (routed through this OpenAI-compatible path) also
   * takes a nested-but-here-top-level reasoning_effort.
   *
   * STRIP exceptions (the param 400s or doesn't exist):
   *  - `o1-mini`: the only o-series model with NO reasoning_effort param at all.
   */
  private supportsReasoningEffort(): boolean {
    const model = this.modelId.toLowerCase();
    // o1-mini is the lone o-series model without the param → strip.
    if (model.includes("o1-mini")) return false;
    return (
      model.includes("o1") ||
      model.includes("o3") ||
      model.includes("o4") ||
      model.includes("gpt-5") ||
      this.isSakanaFugu()
    );
  }

  /** Sakana Fugu (fugu / fugu-ultra / sakana/*) — routed through this OpenAI path. */
  private isSakanaFugu(): boolean {
    const model = this.modelId.toLowerCase();
    return model.startsWith("fugu") || model.startsWith("sakana/") || model.includes("/fugu");
  }

  /** gpt-5.1 and later (5.1/5.2/5.5, and their -codex variants). */
  private isGpt51Plus(): boolean {
    const model = this.modelId.toLowerCase();
    return /gpt-5\.[1-9]/.test(model);
  }

  /** o-series reasoning models (o1/o3/o4) — accept only low|medium|high. */
  private isOSeries(): boolean {
    const model = this.modelId.toLowerCase();
    return model.includes("o1") || model.includes("o3") || model.includes("o4");
  }

  /** Original GPT-5 (gpt-5, gpt-5-mini/nano/pro/codex) — NOT gpt-5.1+. */
  private isOriginalGpt5(): boolean {
    const model = this.modelId.toLowerCase();
    return model.includes("gpt-5") && !this.isGpt51Plus();
  }

  /**
   * Whether this model accepts `xhigh`. The original GPT-5 family and the
   * o-series cap at `high` — sending `xhigh` 400s, so those clamp down. The
   * gpt-5.1+ family DOES accept `xhigh` (verified against the live API for
   * gpt-5.5 — see reasoning-effort.test.ts). gpt-5.1-codex-max is the documented
   * minimum, but the pinned test asserts the broader gpt-5.1+ acceptance.
   */
  private acceptsXhigh(): boolean {
    return this.isGpt51Plus() || this.isSakanaFugu();
  }

  /**
   * Map Claude Code's effort signal to a valid OpenAI `reasoning_effort` value.
   *
   * Modern Claude Code (Opus 4.7/4.8) sends `output_config.effort` as a string
   * level (none/minimal/low/medium/high/xhigh/max). Older clients sent
   * `thinking.budget_tokens` (a number) — kept as a fallback.
   *
   * Normalization to a canonical level is delegated to the shared
   * resolveEffortLevel(); this method then clamps that level to the value set
   * the SPECIFIC model accepts (OpenAI's gates differ sharply per family).
   *
   * OpenAI's accepted set is `none | minimal | low | medium | high | xhigh`
   * (`max` is rejected — `xhigh` is the ceiling; `minimal` is rejected on
   * gpt-5.1+). Sakana Fugu accepts ONLY `high | xhigh` (everything below 400s),
   * so its values clamp UP. Returns undefined when there's no effort signal.
   */
  private resolveReasoningEffort(claudeRequest: any): string | undefined {
    // Legacy budget bucketing is pinned by reasoning-effort.test.ts (gpt-5.x:
    // <16000→low, >=32000→high, else medium) — keep it here rather than via the
    // shared resolver, whose buckets differ. The string-level path delegates to
    // the shared normalizer.
    const rawLevel = claudeRequest?.output_config?.effort;
    let level: EffortLevel | undefined;
    if (typeof rawLevel === "string") {
      level = this.resolveEffortLevel(claudeRequest);
      if (!level) return undefined; // unknown string → let OpenAI default
    } else {
      const budget = claudeRequest?.thinking?.budget_tokens;
      if (typeof budget !== "number") return undefined;
      level = budget < 16000 ? "low" : budget >= 32000 ? "high" : "medium";
    }

    // Sakana Fugu: ONLY high|xhigh valid; clamp everything below UP to high.
    if (this.isSakanaFugu()) {
      const value = level === "xhigh" || level === "max" ? "xhigh" : "high";
      log(`[OpenAIAPIFormat] Sakana Fugu clamp ${level} -> ${value} for ${this.modelId}`);
      return value;
    }

    return this.clampOpenAIEffort(level);
  }

  /** Clamp a canonical level to the value set the current OpenAI model accepts. */
  private clampOpenAIEffort(level: EffortLevel): string {
    // `max` never exists on OpenAI — xhigh is the ceiling.
    // `minimal` is rejected on gpt-5.1+ and on the o-series.
    // `none` is valid only on the gpt-5.1+ family.
    // `xhigh` is accepted only on gpt-5.1-codex-max.
    switch (level) {
      case "none":
        // gpt-5.1+ accepts none; o-series → low; original GPT-5 → minimal.
        if (this.isGpt51Plus()) return "none";
        if (this.isOSeries()) return "low";
        if (this.isOriginalGpt5()) return "minimal";
        return "none";
      case "minimal":
        // Rejected on gpt-5.1+ and o-series → low. Valid on original GPT-5.
        if (this.isGpt51Plus() || this.isOSeries()) return "low";
        return "minimal";
      case "low":
      case "medium":
      case "high":
        return level;
      case "xhigh":
        return this.acceptsXhigh() ? "xhigh" : "high";
      case "max":
        // No `max` on OpenAI; ceiling is xhigh (only on codex-max), else high.
        return this.acceptsXhigh() ? "xhigh" : "high";
      default:
        return "medium";
    }
  }

  private usesMaxCompletionTokens(): boolean {
    const model = this.modelId.toLowerCase();
    return (
      model.includes("gpt-5") ||
      model.includes("o1") ||
      model.includes("o3") ||
      model.includes("o4")
    );
  }

  private buildChatCompletionsPayload(claudeRequest: any, messages: any[], tools: any[]): any {
    const payload: any = {
      model: this.modelId,
      messages,
      temperature: claudeRequest.temperature ?? 1,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (this.usesMaxCompletionTokens()) {
      payload.max_completion_tokens = claudeRequest.max_tokens;
    } else {
      payload.max_tokens = claudeRequest.max_tokens;
    }

    if (tools.length > 0) {
      payload.tools = tools;
    }

    if (claudeRequest.tool_choice) {
      const { type, name } = claudeRequest.tool_choice;
      if (type === "tool" && name) {
        payload.tool_choice = { type: "function", function: { name } };
      } else if (type === "auto" || type === "none") {
        payload.tool_choice = type;
      }
    }

    // Map Claude Code's effort (output_config.effort, or legacy
    // thinking.budget_tokens) → OpenAI reasoning_effort for reasoning-capable
    // models (o-series + gpt-5 family).
    if (this.supportsReasoningEffort()) {
      const effort = this.resolveReasoningEffort(claudeRequest);
      if (effort) {
        payload.reasoning_effort = effort;
        log(`[OpenAIAPIFormat] reasoning_effort -> ${effort} for ${this.modelId}`);
      }
    }

    return payload;
  }
}

// Backward-compatible alias
/** @deprecated Use OpenAIAPIFormat */
export { OpenAIAPIFormat as OpenAIAdapter };
