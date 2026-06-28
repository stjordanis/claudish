/**
 * Ollama local model discovery.
 *
 * Ollama exposes installed models at `GET {host}/api/tags` and per-model
 * capabilities at `POST {host}/api/show`. This module is the single shared
 * fetcher used by both the `--list` footer (cli.ts) and the interactive model
 * picker (model-selector.ts) so the two never drift.
 *
 * Network-light and fail-soft: every fetch is wrapped in a short timeout and
 * any error resolves to an empty list, so a missing/unreachable daemon never
 * throws — callers fall back to free-text entry.
 */

export interface OllamaModel {
  /** Prefixed id for routing, e.g. `ollama/llama3.2:3b`. */
  id: string;
  /** Bare model name as Ollama knows it, e.g. `llama3.2:3b`. */
  name: string;
  description: string;
  provider: "ollama";
  pricing: { prompt: string; completion: string };
  isLocal: true;
  supportsTools: boolean;
  isEmbeddingModel: boolean;
  capabilities: string[];
  details?: unknown;
  size?: number;
}

/** Resolve the Ollama base URL, honoring OLLAMA_HOST / OLLAMA_BASE_URL. */
export function ollamaBaseUrl(): string {
  return process.env.OLLAMA_HOST || process.env.OLLAMA_BASE_URL || "http://localhost:11434";
}

interface FetchOllamaOptions {
  /**
   * When true (default), enrich each model with capabilities via `/api/show`
   * (adds the tools indicator but one extra request per model). Pass false to
   * skip enrichment for a snappier interactive picker — embedding models are
   * still filtered out by name in that case.
   */
  enrichCapabilities?: boolean;
}

/**
 * Fetch installed Ollama models. Returns `[]` when the daemon is unreachable,
 * returns an error, or has no models — never throws. Embedding models are
 * filtered out (they can't be used for chat/completion).
 */
export async function fetchOllamaModels(options: FetchOllamaOptions = {}): Promise<OllamaModel[]> {
  const { enrichCapabilities = true } = options;
  const host = ollamaBaseUrl();

  try {
    const response = await fetch(`${host}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return [];

    const data = (await response.json()) as { models?: Array<Record<string, any>> };
    const models = data.models || [];

    const enriched = await Promise.all(
      models.map(async (m) => {
        let capabilities: string[] = [];

        if (enrichCapabilities) {
          try {
            const showResponse = await fetch(`${host}/api/show`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: m.name }),
              signal: AbortSignal.timeout(2000),
            });
            if (showResponse.ok) {
              const showData = (await showResponse.json()) as { capabilities?: string[] };
              capabilities = showData.capabilities || [];
            }
          } catch {
            // Ignore capability-fetch errors — fall back to name heuristics.
          }
        }

        const nameLower = String(m.name).toLowerCase();
        const supportsTools = capabilities.includes("tools");
        const isEmbeddingModel =
          capabilities.includes("embedding") || nameLower.includes("embed");
        const sizeInfo = m.details?.parameter_size || "unknown size";
        const toolsIndicator = supportsTools ? "✓ tools" : "✗ no tools";

        return {
          id: `ollama/${m.name}`,
          name: m.name as string,
          description: `Local Ollama model (${sizeInfo}, ${toolsIndicator})`,
          provider: "ollama" as const,
          pricing: { prompt: "0", completion: "0" },
          isLocal: true as const,
          supportsTools,
          isEmbeddingModel,
          capabilities,
          details: m.details,
          size: m.size,
        };
      })
    );

    return enriched.filter((m) => !m.isEmbeddingModel);
  } catch {
    // Ollama not running or not reachable.
    return [];
  }
}
