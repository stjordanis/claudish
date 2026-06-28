/**
 * DeepSeekModelDialect — Layer 2 dialect for DeepSeek models.
 *
 * Handles DeepSeek-specific quirks:
 * - V4 models (deepseek-v4-*, plus deepseek-chat/deepseek-reasoner as V4
 *   aliases) accept `reasoning_effort` (high|max only) + a `thinking` toggle.
 *   DeepSeek only honors high/max — low/medium remap UP to high; xhigh→max.
 * - Legacy (R1 / V3.x) models reason by model name with no knob → strip.
 */

import { BaseAPIFormat, AdapterResult, matchesModelFamily } from "./base-api-format.js";
import { log } from "../logger.js";

export class DeepSeekModelDialect extends BaseAPIFormat {
  processTextContent(textContent: string, accumulatedText: string): AdapterResult {
    return {
      cleanedText: textContent,
      extractedToolCalls: [],
      wasTransformed: false,
    };
  }

  /**
   * Handle request preparation — map Claude Code's effort to DeepSeek's V4
   * controls, or strip on legacy models (which reason by model name only).
   */
  override prepareRequest(request: any, originalRequest: any): any {
    const effort = this.resolveEffortLevel(originalRequest);

    if (effort && this.isV4Model()) {
      if (effort === "none" || effort === "minimal") {
        // Disable thinking on V4.
        request.thinking = { type: "disabled" };
        log(`[DeepSeekModelDialect] effort ${effort} -> thinking.type: disabled for ${this.modelId}`);
      } else {
        // DeepSeek honors only high|max — low/medium remap up to high; xhigh→max.
        const value = effort === "xhigh" || effort === "max" ? "max" : "high";
        request.reasoning_effort = value;
        log(
          `[DeepSeekModelDialect] effort ${effort} -> reasoning_effort: ${value} for ${this.modelId}`
        );
      }
      return request;
    }

    // Legacy DeepSeek (R1 / V3.x) or no effort signal: strip any raw thinking
    // object — the API rejects it (reasoning is model-name driven).
    if (request.thinking) {
      log(`[DeepSeekModelDialect] Stripping thinking object (not supported by ${this.modelId})`);
      delete request.thinking;
    }

    return request;
  }

  /**
   * Whether this is a DeepSeek V4 model that accepts explicit reasoning controls.
   * V4 is detectable by an explicit "v4" in the id, OR via the deepseek-chat /
   * deepseek-reasoner aliases which now point at V4-Flash (non-thinking /
   * thinking). Older R1 / V3.x ids keep stripping (conservative gate).
   */
  private isV4Model(): boolean {
    const model = this.modelId.toLowerCase();
    return (
      model.includes("v4") ||
      model.includes("deepseek-chat") ||
      model.includes("deepseek-reasoner")
    );
  }

  shouldHandle(modelId: string): boolean {
    return matchesModelFamily(modelId, "deepseek");
  }

  getName(): string {
    return "DeepSeekModelDialect";
  }
}

// Backward-compatible alias
/** @deprecated Use DeepSeekModelDialect */
export { DeepSeekModelDialect as DeepSeekAdapter };
