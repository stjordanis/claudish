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

import {
  BaseAPIFormat,
  AdapterResult,
  ToolCall,
  type EffortLevel,
  matchesModelFamily,
} from "./base-api-format.js";
import { log } from "../logger.js";
import { lookupModel } from "./model-catalog.js";

export class GrokModelDialect extends BaseAPIFormat {
  private xmlBuffer: string = "";

  processTextContent(textContent: string, accumulatedText: string): AdapterResult {
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
   * `reasoning_effort`, gated per model tier. Grok rejects the param with HTTP
   * 400 on models that don't accept it (grok-4/grok-4-0709, non-reasoning,
   * grok-2), so those are STRIPPED, never passed.
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
   * undefined when this model accepts no reasoning_effort param (→ strip).
   *
   * Tiers (xAI docs / research §2):
   *  - grok-3-mini (*mini*): accepts low|high ONLY.
   *  - grok-4.3 / grok-4-fast-reasoning / grok-4-1-fast-reasoning: none|low|medium|high.
   *  - grok-4 / grok-4-0709 / *non-reasoning* / grok-2: NOT accepted → strip.
   */
  private effortToReasoningEffort(effort: EffortLevel): string | undefined {
    const model = this.modelId.toLowerCase();

    // Non-reasoning + original grok-4 + grok-2 reject the param entirely.
    if (
      model.includes("non-reasoning") ||
      model.includes("grok-2") ||
      this.isOriginalGrok4()
    ) {
      return undefined;
    }

    // grok-3-mini tier: low | high only.
    if (model.includes("mini")) {
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
      case "high":
      case "xhigh":
      case "max":
        return "high";
      default:
        return "high";
    }
  }

  /**
   * Original grok-4 / grok-4-0709 reason automatically and 400 on the param.
   * Matches grok-4 and grok-4-0709 but NOT grok-4.3, grok-4-fast-*,
   * grok-4-1-fast-* (those are reasoning-capable and DO accept the param).
   */
  private isOriginalGrok4(): boolean {
    const model = this.modelId.toLowerCase();
    if (model.includes("fast") || model.includes("mini")) return false;
    // grok-4 or grok-4-0709, but NOT grok-4.<n> (e.g. grok-4.3) — the char
    // right after "grok-4" must not be a dot or digit.
    return /grok-4(?![.\d])/.test(model);
  }

  /**
   * Parse xAI parameter XML format to JSON arguments
   * Handles: <xai:parameter name="key">value</xai:parameter>
   */
  private parseXmlParameters(xmlContent: string): Record<string, any> {
    const params: Record<string, any> = {};
    const paramPattern = /<xai:parameter name="([^"]+)">([^<]*)<\/xai:parameter>/g;

    let match;
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
