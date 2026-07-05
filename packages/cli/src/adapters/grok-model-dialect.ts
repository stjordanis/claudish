/**
 * GrokModelDialect — Layer 2 dialect for xAI Grok models.
 *
 * Translates xAI XML function calls to Claude Code tool_calls:
 * <xai:function_call name="ToolName">
 *   <xai:parameter name="param1">value1</xai:parameter>
 *   <xai:parameter name="param2">value2</xai:parameter>
 * </xai:function_call>
 *
 * This dialect translates that to Claude Code's expected tool_calls format.
 */

import { log } from "../logger.js";
import {
  type AdapterResult,
  BaseAPIFormat,
  type EffortLevel,
  type ToolCall,
  matchesModelFamily,
} from "./base-api-format.js";
import { lookupModel } from "./model-catalog.js";

export class GrokModelDialect extends BaseAPIFormat {
  private xmlBuffer = "";

  processTextContent(textContent: string, _accumulatedText: string): AdapterResult {
    // Accumulate text to handle XML split across multiple chunks
    this.xmlBuffer += textContent;

    // Pattern to match complete xAI function calls
    const xmlPattern = /<xai:function_call name="([^"]+)">(.*?)<\/xai:function_call>/gs;
    const matches = [...this.xmlBuffer.matchAll(xmlPattern)];

    if (matches.length === 0) {
      // No complete XML function calls found yet
      // Check if we have a partial XML opening tag
      const hasPartialXml = this.xmlBuffer.includes("<xai:function_call");

      if (hasPartialXml) {
        // Keep accumulating, don't send text yet
        return {
          cleanedText: "",
          extractedToolCalls: [],
          wasTransformed: false,
        };
      }

      // Normal text, not XML
      const result = {
        cleanedText: this.xmlBuffer,
        extractedToolCalls: [],
        wasTransformed: false,
      };
      this.xmlBuffer = ""; // Clear buffer
      return result;
    }

    // Extract tool calls from XML
    const toolCalls: ToolCall[] = matches.map((match) => {
      const toolName = match[1];
      const xmlParams = match[2];

      return {
        id: `grok_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        name: toolName,
        arguments: this.parseXmlParameters(xmlParams),
      };
    });

    // Remove XML from text and get any remaining content
    let cleanedText = this.xmlBuffer;
    for (const match of matches) {
      cleanedText = cleanedText.replace(match[0], "");
    }

    // Clear buffer for next chunk
    this.xmlBuffer = "";

    return {
      cleanedText: cleanedText.trim(),
      extractedToolCalls: toolCalls,
      wasTransformed: true,
    };
  }

  /**
   * Handle request preparation — map Claude Code's effort to xAI
   * `reasoning_effort`, gated per model via an ALLOWLIST. Grok rejects the param
   * with HTTP 400 on models that don't accept it, and naming is NOT a reliable
   * signal (live-verified 2026-07: grok-4.3 accepts it but grok-4.20 — same
   * dot-decimal shape — rejects it). So we SET the param only for models known
   * to accept it and STRIP for everything else (unknown/new models fail safe:
   * they run without effort rather than 400 on every request). See
   * effortToReasoningEffort.
   */
  override prepareRequest(request: any, originalRequest: any): any {
    const effort = this.resolveEffortLevel(originalRequest);

    if (effort) {
      const value = this.effortToReasoningEffort(effort);
      if (value) {
        request.reasoning_effort = value;
        log(`[GrokModelDialect] reasoning_effort -> ${value} (from ${effort}) for ${this.modelId}`);
      } else {
        log(
          `[GrokModelDialect] Model ${this.modelId} does not accept reasoning_effort — stripping.`
        );
        if (request.reasoning_effort !== undefined) delete request.reasoning_effort;
      }
    }

    // Always remove raw thinking object for Grok to avoid API errors.
    if (request.thinking) delete request.thinking;

    return request;
  }

  /**
   * Map a canonical effort level to a Grok `reasoning_effort` value, or
   * undefined when this model does NOT accept the param (→ strip).
   *
   * ALLOWLIST (fail-safe): only models KNOWN to accept reasoning_effort get it.
   * Live-verified 2026-07 against api.x.ai/v1/models — of the current chat
   * lineup ONLY grok-4.3 accepts it; grok-build-0.1 / grok-code-fast-1,
   * grok-4.20(-0309)(-reasoning), and every *-non-reasoning id 400 with
   * "does not support parameter reasoningEffort". Naming is NOT a reliable
   * signal (grok-4.20 matches grok-4.x yet rejects), so we enumerate accepting
   * families rather than guess. legacy grok-3-mini and grok-*-fast-reasoning are
   * kept on the allowlist (historically accepting; not in today's live list).
   * Anything else STRIPS → an unknown/new model runs without effort instead of
   * 400-ing every request.
   */
  private effortToReasoningEffort(effort: EffortLevel): string | undefined {
    const model = this.modelId.toLowerCase();

    const isMini = model.includes("mini"); // grok-3-mini (legacy): low|high
    const isGrok43 = /grok-4\.3(\b|[-.]|$)/.test(model); // grok-4.3 (live: accepts)
    const isFastReasoning = model.includes("fast-reasoning"); // grok-*-fast-reasoning family

    if (!(isMini || isGrok43 || isFastReasoning)) {
      return undefined; // not on the allowlist → strip
    }

    // grok-3-mini tier: low | high only.
    if (isMini) {
      switch (effort) {
        case "high":
        case "xhigh":
        case "max":
          return "high";
        default:
          // none/minimal/low/medium → low (mini has no none/medium).
          return "low";
      }
    }

    // grok-4.3 / fast-reasoning tier: none | low | medium | high.
    switch (effort) {
      case "none":
        return "none";
      case "minimal":
      case "low":
        return "low";
      case "medium":
        return "medium";
      default:
        return "high";
    }
  }

  /**
   * Parse xAI parameter XML format to JSON arguments
   * Handles: <xai:parameter name="key">value</xai:parameter>
   */
  private parseXmlParameters(xmlContent: string): Record<string, any> {
    const params: Record<string, any> = {};
    const paramPattern = /<xai:parameter name="([^"]+)">([^<]*)<\/xai:parameter>/g;

    let match: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: canonical RegExp.exec() iteration idiom
    while ((match = paramPattern.exec(xmlContent)) !== null) {
      const paramName = match[1];
      const paramValue = match[2];

      // Try to parse as JSON (for objects/arrays), otherwise use as string
      try {
        params[paramName] = JSON.parse(paramValue);
      } catch {
        // Not valid JSON, use as string
        params[paramName] = paramValue;
      }
    }

    return params;
  }

  shouldHandle(modelId: string): boolean {
    return matchesModelFamily(modelId, "grok") || modelId.toLowerCase().includes("x-ai/");
  }

  getName(): string {
    return "GrokModelDialect";
  }

  override getContextWindow(): number {
    return lookupModel(this.modelId)?.contextWindow ?? 0;
  }

  /**
   * Reset internal state (useful between requests)
   */
  reset(): void {
    this.xmlBuffer = "";
  }
}

// Backward-compatible alias
/** @deprecated Use GrokModelDialect */
export { GrokModelDialect as GrokAdapter };
