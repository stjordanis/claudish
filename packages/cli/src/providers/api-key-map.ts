/**
 * Shared API key mapping — maps provider IDs to their environment variable names.
 * Used by both the CLI probe command and the probe TUI.
 */
export const API_KEY_MAP: Record<string, { envVar: string; aliases?: string[] }> = {
  litellm: { envVar: "LITELLM_API_KEY" },
  openrouter: { envVar: "OPENROUTER_API_KEY" },
  google: { envVar: "GEMINI_API_KEY" },
  openai: { envVar: "OPENAI_API_KEY" },
  minimax: { envVar: "MINIMAX_API_KEY" },
  "minimax-coding": { envVar: "MINIMAX_CODING_API_KEY" },
  kimi: { envVar: "MOONSHOT_API_KEY", aliases: ["KIMI_API_KEY"] },
  "kimi-coding": { envVar: "KIMI_CODING_API_KEY" },
  glm: { envVar: "ZHIPU_API_KEY", aliases: ["GLM_API_KEY"] },
  "glm-coding": { envVar: "GLM_CODING_API_KEY", aliases: ["ZAI_CODING_API_KEY"] },
  "z-ai": { envVar: "ZAI_API_KEY" },
  deepseek: { envVar: "DEEPSEEK_API_KEY" },
  sakana: { envVar: "SAKANA_API_KEY" },
  // No alias to SAKANA_API_KEY — the subscription plan (sc@) bills by a SEPARATE
  // key from the pay-as-you-go API. Aliasing made sc@ fall back to the PAYG key
  // and bill against prepaid credits despite an active subscription.
  "sakana-coding": { envVar: "SAKANA_CODING_API_KEY" },
  ollamacloud: { envVar: "OLLAMA_API_KEY" },
  "opencode-zen": { envVar: "OPENCODE_API_KEY" },
  "opencode-zen-go": { envVar: "OPENCODE_API_KEY" },
  "gemini-codeassist": { envVar: "GEMINI_API_KEY" },
  vertex: { envVar: "VERTEX_API_KEY", aliases: ["VERTEX_PROJECT"] },
  poe: { envVar: "POE_API_KEY" },
};
