/**
 * QwenModelDialect — Layer 2 dialect for Qwen (Alibaba) models.
 *
 * Handles Qwen-specific quirks:
 * - Strips special tokens from output
 * - Maps thinking → enable_thinking + thinking_budget params
 */

import {
  BaseAPIFormat,
  AdapterResult,
  type EffortLevel,
  matchesModelFamily,
} from "./base-api-format.js";
import { log } from "../logger.js";

// Qwen special tokens that should be stripped from output
const QWEN_SPECIAL_TOKENS = [
  "<|im_start|>",
  "<|im_end|>",
  "<|endoftext|>",
  "<|end|>",
  "assistant\n", // Role marker that sometimes leaks
];

export class QwenModelDialect extends BaseAPIFormat {
  processTextContent(textContent: string, accumulatedText: string): AdapterResult {
    // Strip Qwen special tokens that may leak through
    // This can happen when the model gets confused and outputs its chat template
    let cleanedText = textContent;
    for (const token of QWEN_SPECIAL_TOKENS) {
      cleanedText = cleanedText.replaceAll(token, "");
    }

    // Also handle partial tokens at chunk boundaries
    // e.g., "<|im_" at the end of one chunk and "start|>" at the beginning of next
    cleanedText = cleanedText.replace(/<\|[a-z_]*$/i, ""); // Partial at end
    cleanedText = cleanedText.replace(/^[a-z_]*\|>/i, ""); // Partial at start

    const wasTransformed = cleanedText !== textContent;
    if (wasTransformed && cleanedText.length === 0) {
      // Entire chunk was special tokens, skip it
      return {
        cleanedText: "",
        extractedToolCalls: [],
        wasTransformed: true,
      };
    }

    return {
      cleanedText,
      extractedToolCalls: [],
      wasTransformed,
    };
  }

  /**
   * Handle request preparation — map Claude Code's effort to Qwen's
   * `enable_thinking` + `thinking_budget`. Qwen has no discrete effort enum;
   * none/minimal disable thinking, everything else enables it with a token
   * budget derived from the level (claudish conventions, research §4.3).
   */
  override prepareRequest(request: any, originalRequest: any): any {
    const effort = this.resolveEffortLevel(originalRequest);

    if (effort) {
      if (effort === "none" || effort === "minimal") {
        request.enable_thinking = false;
        log(`[QwenModelDialect] effort ${effort} -> enable_thinking: false for ${this.modelId}`);
      } else {
        request.enable_thinking = true;
        const budget = this.effortToThinkingBudget(effort);
        if (budget !== undefined) {
          request.thinking_budget = budget;
        }
        log(
          `[QwenModelDialect] effort ${effort} -> enable_thinking: true, thinking_budget: ${budget ?? "(model max)"} for ${this.modelId}`
        );
      }

      // Cleanup: remove raw thinking object so it doesn't double-send.
      if (originalRequest.thinking) delete request.thinking;
    }

    return request;
  }

  /**
   * Qwen `thinking_budget` per effort level (claudish convention). `max` omits
   * the budget so Qwen uses the model's full max CoT length.
   */
  private effortToThinkingBudget(effort: EffortLevel): number | undefined {
    switch (effort) {
      case "low":
        return 2048;
      case "medium":
        return 8192;
      case "high":
        return 24576;
      case "xhigh":
        return 38912;
      case "max":
        return undefined; // omit → model max
      default:
        return 8192;
    }
  }

  shouldHandle(modelId: string): boolean {
    return matchesModelFamily(modelId, "qwen") || matchesModelFamily(modelId, "alibaba");
  }

  getName(): string {
    return "QwenModelDialect";
  }
}

// Backward-compatible alias
/** @deprecated Use QwenModelDialect */
export { QwenModelDialect as QwenAdapter };
