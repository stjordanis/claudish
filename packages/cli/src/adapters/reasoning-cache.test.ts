/**
 * Reasoning-item passback for the OpenAI Responses API.
 *
 * OpenAI: "Pass back all reasoning items from function calls (along with function
 * outputs) to maintain the model's reasoning continuity." Claudish requested
 * encrypted reasoning (include: ["reasoning.encrypted_content"]) but dropped it,
 * so the model re-derived its plan every turn — burning the output budget whose
 * exhaustion truncates tool calls (incomplete_details.reason=max_output_tokens).
 *
 * Measured on gpt-5.6-sol/codex across a tool boundary (high effort, 2 runs each):
 *   with reasoning replayed: reasoning_tokens 97 / 39
 *   without:                 reasoning_tokens 458 / 347
 */
import { afterEach, describe, expect, test } from "bun:test";
import { CodexAPIFormat } from "./codex-api-format.js";
import {
  clearReasoningCache,
  reasoningCacheSize,
  reasoningForCall,
  rememberReasoningForCall,
} from "./reasoning-cache.js";

// Real shape captured from chatgpt.com/backend-api/codex/responses (gpt-5.6-sol):
// a reasoning item carries encrypted_content and, far more often than not, an
// EMPTY summary — which is why the payload cannot ride in a thinking block.
const REAL_REASONING = {
  type: "reasoning" as const,
  content: [],
  encrypted_content: "gAAAAABqV6bekEfj3MKRoPhPCyr2cBbcj1XqZ_t2lr_tJRs8UVZ20S60sCi9DOnes",
  summary: [],
};

afterEach(() => clearReasoningCache());

describe("reasoning-cache", () => {
  test("stores and returns items for a call id", () => {
    rememberReasoningForCall("toolu_call_1", [REAL_REASONING]);
    expect(reasoningForCall("toolu_call_1")).toEqual([REAL_REASONING]);
  });

  test("a miss returns undefined (degrades to re-reasoning, never throws)", () => {
    expect(reasoningForCall("toolu_never_seen")).toBeUndefined();
  });

  test("ignores empty item lists and blank ids", () => {
    rememberReasoningForCall("toolu_call_1", []);
    rememberReasoningForCall("", [REAL_REASONING]);
    expect(reasoningCacheSize()).toBe(0);
  });

  test("evicts oldest beyond the cap so a long session stays bounded", () => {
    for (let i = 0; i < 520; i++) {
      rememberReasoningForCall(`toolu_call_${i}`, [REAL_REASONING]);
    }
    expect(reasoningCacheSize()).toBe(500);
    expect(reasoningForCall("toolu_call_0")).toBeUndefined(); // evicted
    expect(reasoningForCall("toolu_call_519")).toBeDefined(); // kept
  });
});

describe("CodexAPIFormat replays cached reasoning before its function_call", () => {
  const claudeRequest = {
    model: "gpt-5.6-sol",
    messages: [
      { role: "user", content: [{ type: "text", text: "read the file" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_call_abc", name: "read_file", input: { path: "/tmp/a.ts" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_call_abc", content: "export const answer = 42;" }],
      },
    ],
  };

  async function buildInput() {
    const { convertMessagesToOpenAI } = await import("../handlers/shared/format/openai-messages.js");
    const messages = convertMessagesToOpenAI(claudeRequest, "gpt-5.6-sol");
    const payload = new CodexAPIFormat("gpt-5.6-sol").buildPayload(claudeRequest, messages, []);
    return payload.input as any[];
  }

  test("reasoning item is emitted immediately before the function_call it produced", async () => {
    rememberReasoningForCall("toolu_call_abc", [REAL_REASONING]);
    const input = await buildInput();

    const types = input.map((i) => i.type);
    const reasoningIdx = types.indexOf("reasoning");
    const callIdx = types.indexOf("function_call");
    expect(reasoningIdx).toBeGreaterThanOrEqual(0);
    expect(reasoningIdx).toBe(callIdx - 1); // directly before, per OpenAI's ordering

    expect(input[reasoningIdx].encrypted_content).toBe(REAL_REASONING.encrypted_content);
    // The Responses API accepts a replayed reasoning item without its id
    // (verified live), which is what buildPayload's id-strip leaves us with.
    expect(input[reasoningIdx].id).toBeUndefined();
  });

  test("without a cached item the payload is unchanged (no stray reasoning)", async () => {
    const input = await buildInput();
    expect(input.some((i) => i.type === "reasoning")).toBe(false);
    expect(input.some((i) => i.type === "function_call")).toBe(true);
  });

  test("reasoning is not attached to an unrelated call", async () => {
    rememberReasoningForCall("toolu_call_SOMETHING_ELSE", [REAL_REASONING]);
    const input = await buildInput();
    expect(input.some((i) => i.type === "reasoning")).toBe(false);
  });
});
