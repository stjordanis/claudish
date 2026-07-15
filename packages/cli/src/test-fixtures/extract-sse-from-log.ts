#!/usr/bin/env bun
/**
 * Extract raw SSE events from claudish debug logs into replay fixture files.
 *
 * Usage:
 *   bun run src/test-fixtures/extract-sse-from-log.ts <debug-log-path> [output-dir]
 *
 * Parses [SSE:openai] and [SSE:anthropic] log lines, groups them by API turn
 * (bounded by "HANDLER STARTED" / "Calling API" markers), and writes each turn
 * as a standalone .sse fixture file.
 *
 * Output:
 *   <output-dir>/<model>-<format>-turn<N>.sse
 *
 * Example:
 *   bun run src/test-fixtures/extract-sse-from-log.ts logs/claudish_2026-03-17_09-41-32.log
 *   → sse-responses/kimi-k2.5-openai-turn1.sse
 *   → sse-responses/kimi-k2.5-openai-turn2.sse
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const logFile = process.argv[2];
if (!logFile) {
  console.error("Usage: bun run extract-sse-from-log.ts <debug-log-path> [output-dir]");
  process.exit(1);
}

const outputDir =
  process.argv[3] || join(dirname(new URL(import.meta.url).pathname), "sse-responses");
mkdirSync(outputDir, { recursive: true });

const content = readFileSync(logFile, "utf-8");
const lines = content.split("\n");

// Detect model name from first HANDLER STARTED or AnthropicSSE line
let model = "unknown";
for (const line of lines) {
  const handlerMatch = line.match(/HANDLER STARTED for (.+?) =====/);
  if (handlerMatch) {
    model = handlerMatch[1].replace(/\//g, "-");
    break;
  }
  const anthropicMatch = line.match(/Stream complete for (.+?):/);
  if (anthropicMatch) {
    model = anthropicMatch[1].replace(/\//g, "-");
    break;
  }
}

console.log(`Log file: ${logFile}`);
console.log(`Model: ${model}`);
console.log(`Output dir: ${outputDir}`);

interface Turn {
  format: "openai" | "anthropic";
  events: string[];
}

const turns: Turn[] = [];
let currentTurn: Turn | null = null;

for (const line of lines) {
  // New API turn boundary (OpenAI format)
  if (line.includes("HANDLER STARTED")) {
    if (currentTurn && currentTurn.events.length > 0) {
      turns.push(currentTurn);
    }
    currentTurn = { format: "openai", events: [] };
    continue;
  }

  // New API turn boundary (Anthropic format)
  if (line.includes("Calling API:") && !currentTurn?.format) {
    if (currentTurn && currentTurn.events.length > 0) {
      turns.push(currentTurn);
    }
    currentTurn = { format: "anthropic", events: [] };
    continue;
  }

  // OpenAI SSE line
  const openaiMatch = line.match(/\[SSE:openai\] (.+)/);
  if (openaiMatch) {
    if (!currentTurn) {
      currentTurn = { format: "openai", events: [] };
    }
    currentTurn.events.push(openaiMatch[1]);
    continue;
  }

  // Anthropic SSE line
  const anthropicMatch = line.match(/\[SSE:anthropic\] (.+)/);
  if (anthropicMatch) {
    if (!currentTurn) {
      currentTurn = { format: "anthropic", events: [] };
    }
    currentTurn.format = "anthropic";
    currentTurn.events.push(anthropicMatch[1]);
  }
}

// Push last turn
if (currentTurn && currentTurn.events.length > 0) {
  turns.push(currentTurn);
}

// Write fixture files
let written = 0;
for (let i = 0; i < turns.length; i++) {
  const turn = turns[i];
  const filename = `${model}-${turn.format}-turn${i + 1}.sse`;
  const filepath = join(outputDir, filename);

  const sseContent = `${turn.events.map((data) => `data: ${data}\n`).join("\n")}\n`;
  writeFileSync(filepath, sseContent, "utf-8");
  written++;

  const textChunks = turn.events.filter((e) => {
    try {
      const parsed = JSON.parse(e);
      // OpenAI format
      if (parsed.choices?.[0]?.delta?.content) return true;
      // Anthropic format
      if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta") return true;
      return false;
    } catch {
      return false;
    }
  }).length;

  const toolCalls = turn.events.filter((e) => {
    try {
      const parsed = JSON.parse(e);
      if (parsed.choices?.[0]?.delta?.tool_calls) return true;
      if (parsed.type === "content_block_start" && parsed.content_block?.type === "tool_use")
        return true;
      return false;
    } catch {
      return false;
    }
  }).length;

  console.log(
    `  ${filename}: ${turn.events.length} events, ${textChunks} text chunks, ${toolCalls} tool calls`
  );
}

console.log(`\nWrote ${written} fixture file(s) to ${outputDir}`);

if (written === 0) {
  console.log("\nNo [SSE:openai] or [SSE:anthropic] lines found in log.");
  console.log(
    "Make sure the log was captured with claudish v5.13.2+ (which includes raw SSE logging)."
  );
  console.log("Re-run with: claudish --model <model> --debug-claudish ...");
}
