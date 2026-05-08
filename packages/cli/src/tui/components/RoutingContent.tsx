/** @jsxImportSource @opentui/react */
import { C } from "../theme.js";
import { DETAIL_H, CHAIN_PROVIDERS } from "../constants.js";
import { DEFAULT_ROUTING_RULES } from "../../providers/default-routing-rules.js";
import type { ClaudishProfileConfig } from "../../profile-config.js";
import type { Mode, ProbeEntry, ProbeMode } from "../types.js";

// Format a chain as inline text: "kimi → openrouter"
function chainStr(chain: string[]): string {
  return chain.join(" → ");
}

// Reasons shown beneath each probe entry
const PROVIDER_REASONS: Record<string, string> = {
  litellm: "LiteLLM proxy",
  "opencode-zen": "Free tier (OpenCode Zen)",
  "opencode-zen-go": "Zen Go plan",
  kimi: "Native Kimi API",
  "kimi-coding": "Kimi Coding Plan",
  minimax: "Native MiniMax API",
  "minimax-coding": "MiniMax Coding Plan",
  glm: "Native GLM API",
  "glm-coding": "GLM Coding Plan",
  google: "Direct Gemini API",
  openai: "Direct OpenAI API",
  "openai-codex": "OpenAI Codex (Responses API)",
  zai: "Z.AI API",
  ollamacloud: "Cloud Ollama",
  vertex: "Vertex AI Express",
  openrouter: "Fallback: 580+ models",
};

interface RoutingContentProps {
  config: ClaudishProfileConfig;
  probeMode: ProbeMode;
  probeModel: string;
  probeResults: ProbeEntry[];
  mode: Mode;
  routingPattern: string;
  chainSelected: Set<string>;
  chainOrder: string[];
  chainCursor: number;
  // NOTE: shared with the Providers tab. See "Known wart" in
  // ai-docs/app-tsx-split/walkthrough.md — switching tabs preserves the cursor
  // across two unrelated lists. Intentionally not fixed in this refactor.
  providerIndex: number;
  ruleEntries: Array<[string, string[]]>;
  width: number;
  contentH: number;
  isRoutingInput: boolean;
}

export function RoutingContent({
  config,
  probeMode,
  probeModel,
  probeResults,
  mode,
  routingPattern,
  chainSelected,
  chainOrder,
  chainCursor,
  providerIndex,
  ruleEntries,
  width,
  contentH,
  isRoutingInput,
}: RoutingContentProps) {
  // Full-screen probe takes over when not idle
  const probeBoxH = contentH + DETAIL_H + 1; // spans content + detail area

  if (probeMode === "input") {
    return (
      <box
        height={probeBoxH}
        border
        borderStyle="single"
        borderColor={C.focusBorder}
        backgroundColor={C.bg}
        flexDirection="column"
        paddingX={2}
        paddingY={1}
      >
        <text>
          <span fg={C.white} bold>
            {"Route Probe"}
          </span>
        </text>
        <text> </text>
        <text>
          <span fg={C.fgMuted}>{"Enter a model name to trace its routing chain:"}</span>
        </text>
        <box flexDirection="row" height={1}>
          <text>
            <span fg={C.green} bold>
              {"> "}
            </span>
            <span fg={C.white}>{probeModel}</span>
            <span fg={C.cyan}>{"█"}</span>
          </text>
        </box>
        <text> </text>
        <text>
          <span fg={C.dim}>{"Examples: kimi-k2  deepseek-r1  gemini-2.0-flash  gpt-4o"}</span>
        </text>
        <text> </text>
        <text>
          <span fg={C.fgMuted}>
            {"The probe resolves the fallback chain and tests each provider's"}
          </span>
        </text>
        <text>
          <span fg={C.fgMuted}>{"API key in order, stopping at the first success."}</span>
        </text>
      </box>
    );
  }

  if (probeMode === "running" || probeMode === "done") {
    const successEntry = probeResults.find((e) => e.status === "success");
    const allFailed = probeMode === "done" && !successEntry;
    const totalMs = successEntry?.ms;

    const statusBadge =
      probeMode === "running"
        ? { text: "probing...", color: C.yellow }
        : successEntry
          ? { text: "routed", color: C.green }
          : { text: "no route", color: C.red };

    return (
      <box
        height={probeBoxH}
        border
        borderStyle="single"
        borderColor={probeMode === "running" ? C.focusBorder : C.blue}
        backgroundColor={C.bg}
        flexDirection="column"
        paddingX={2}
        paddingY={1}
      >
        {/* Title row */}
        <box flexDirection="row" height={1}>
          <text>
            <span fg={C.white} bold>
              {probeMode === "done" ? "Probe: " : "Probing: "}
            </span>
            <span fg={C.cyan} bold>
              {probeModel}
            </span>
            <span fg={C.dim}>{"  "}</span>
            {probeMode === "done" && (
              <span fg={statusBadge.color} bold>
                {successEntry ? "● " : "✗ "}
                {statusBadge.text}
              </span>
            )}
            {probeMode === "running" && <span fg={C.yellow}>{"◌ probing..."}</span>}
          </text>
        </box>
        <text> </text>
        {/* Route source */}
        <text>
          <span fg={C.fgMuted}>
            {probeResults[0]?.reason ?? `Chain (${probeResults.length} providers):`}
          </span>
        </text>
        <text> </text>
        {/* Chain entries — 2 lines each */}
        {probeResults.map((entry, idx) => {
          const isNoKey = entry.status === "no_key";
          const isNotReached = entry.status === "skipped";
          const isSelected = entry.status === "success" && probeMode === "done";

          const statusIcon =
            entry.status === "success"
              ? "●"
              : entry.status === "failed"
                ? "✗"
                : entry.status === "testing"
                  ? "◌"
                  : isNoKey
                    ? "○"
                    : isNotReached
                      ? "·"
                      : "○";

          const statusColor =
            entry.status === "success"
              ? C.green
              : entry.status === "failed"
                ? C.red
                : entry.status === "testing"
                  ? C.yellow
                  : C.dim;

          const nameCol = entry.displayName.padEnd(18).substring(0, 18);

          const statusText =
            entry.status === "success"
              ? entry.ms !== undefined
                ? `${entry.ms}ms`
                : "success"
              : entry.status === "failed"
                ? (entry.error ?? "failed")
                : entry.status === "testing"
                  ? "testing..."
                  : isNoKey
                    ? "not configured, skipping"
                    : isNotReached
                      ? "not reached"
                      : "waiting";

          const reason = PROVIDER_REASONS[entry.provider] ?? entry.provider;

          return (
            <box key={entry.provider} flexDirection="column">
              <text>
                <span fg={C.dim}>{`${idx + 1}. `}</span>
                <span
                  fg={isNoKey ? C.dim : isSelected ? C.white : isNotReached ? C.dim : C.fgMuted}
                  bold={isSelected}
                >
                  {nameCol}
                </span>
                <span fg={C.dim}>{"  "}</span>
                <span fg={statusColor} bold={entry.status === "success"}>
                  {statusIcon} {statusText}
                </span>
                {isSelected && (
                  <span fg={C.green} bold>
                    {" ← routed here"}
                  </span>
                )}
              </text>
              <text>
                <span fg={C.dim}>{"    ↳ "}</span>
                <span fg={isNoKey ? C.dim : C.fgMuted}>{reason}</span>
              </text>
            </box>
          );
        })}
        {/* Result line */}
        {probeMode === "done" && (
          <>
            <text> </text>
            <text>
              {allFailed ? (
                <>
                  <span fg={C.red} bold>
                    {"Result: "}
                  </span>
                  <span fg={C.red}>{"✗ No provider could serve this model"}</span>
                </>
              ) : (
                <>
                  <span fg={C.green} bold>
                    {"Result: "}
                  </span>
                  <span fg={C.fgMuted}>{"Routed to "}</span>
                  <span fg={C.cyan} bold>
                    {successEntry!.displayName}
                  </span>
                  {totalMs !== undefined && <span fg={C.fgMuted}>{` in ${totalMs}ms`}</span>}
                </>
              )}
            </text>
          </>
        )}
      </box>
    );
  }

  const innerH = contentH - 2;

  return (
    <box
      height={contentH}
      border
      borderStyle="single"
      borderColor={C.blue}
      backgroundColor={C.bg}
      flexDirection="column"
      paddingX={1}
    >
      {/* Catch-all default — the only "global" default that actually exists.
          Per-pattern defaults (gpt-* → codex/openai/openrouter, etc.) are
          visible in the rule table below alongside any user overrides. */}
      <text>
        <span fg={C.blue} bold>
          {" Catch-all default:"}
        </span>
        <span fg={C.fgMuted}>{"  (used for any model not matched by a rule)"}</span>
      </text>
      <text>
        <span fg={C.dim}>{"  * "}</span>
        <span fg={C.dim}>{"→ "}</span>
        <span fg={C.cyan}>
          {config.defaultProvider && config.defaultProvider.length > 0
            ? config.defaultProvider
            : (DEFAULT_ROUTING_RULES["*"]?.[0] ?? "openrouter")}
        </span>
        {(() => {
          const builtIn = DEFAULT_ROUTING_RULES["*"]?.[0] ?? "openrouter";
          const override = config.defaultProvider;
          const hasOverride = !!(override && override.length > 0);
          const overridesBuiltIn = hasOverride && override !== builtIn;
          return overridesBuiltIn ? (
            <span fg={C.fgMuted}>
              {`  (defaultProvider — overrides built-in '${builtIn}')`}
            </span>
          ) : (
            <span fg={C.fgMuted}>{"  (built-in)"}</span>
          );
        })()}
      </text>
      <text>
        <span fg={C.dim}>{" ─".repeat(Math.max(1, Math.floor((width - 6) / 2)))}</span>
      </text>
      {/* Custom rules header */}
      <text>
        <span fg={C.blue} bold>
          {" Custom rules:"}
        </span>
        <span fg={C.fgMuted}>{"  (override default for matching models)"}</span>
      </text>
      {/* Custom rules or empty state */}
      {ruleEntries.length === 0 && !isRoutingInput && (
        <text>
          <span fg={C.fgMuted}>{" None configured. Press "}</span>
          <span fg={C.green} bold>
            a
          </span>
          <span fg={C.fgMuted}>{" to add."}</span>
        </text>
      )}
      {ruleEntries.length > 0 && (
        <>
          <text>
            <span fg={C.blue} bold>
              {"PATTERN         "}
            </span>
            <span fg={C.blue} bold>
              {"CHAIN"}
            </span>
          </text>
          {ruleEntries.slice(0, Math.max(0, innerH - 3)).map(([pat, chain], idx) => {
            const sel = idx === providerIndex;
            return (
              <box
                key={pat}
                height={1}
                flexDirection="row"
                backgroundColor={sel ? C.bgHighlight : C.bg}
              >
                <text>
                  <span fg={sel ? C.white : C.fgMuted} bold={sel}>
                    {pat.padEnd(16).substring(0, 16)}
                  </span>
                  <span fg={C.dim}>{"  "}</span>
                  <span fg={sel ? C.cyan : C.fgMuted}>{chainStr(chain)}</span>
                </text>
              </box>
            );
          })}
        </>
      )}

      {/* Input fields */}
      {mode === "add_routing_pattern" && (
        <box flexDirection="column">
          <text>
            <span fg={C.blue} bold>
              {"Pattern "}
            </span>
            <span fg={C.dim}>{"(e.g. kimi-*, gpt-4o):"}</span>
          </text>
          <text>
            <span fg={C.green} bold>
              {"> "}
            </span>
            <span fg={C.white}>{routingPattern}</span>
            <span fg={C.cyan}>{"█"}</span>
          </text>
          <text>
            <span fg={C.green} bold>
              Enter{" "}
            </span>
            <span fg={C.fgMuted}>to continue · </span>
            <span fg={C.red} bold>
              Esc{" "}
            </span>
            <span fg={C.fgMuted}>to cancel</span>
          </text>
        </box>
      )}
      {mode === "add_routing_chain" && (
        <box flexDirection="column">
          <text>
            <span fg={C.blue} bold>
              {"Select providers for "}
            </span>
            <span fg={C.white} bold>
              {routingPattern}
            </span>
            <span fg={C.dim}>{" (Space=toggle, 1-9=set position, Enter=save)"}</span>
          </text>
          {chainOrder.length > 0 && (
            <text>
              <span fg={C.fgMuted}>{"  Chain: "}</span>
              <span fg={C.cyan}>{chainOrder.join(" → ")}</span>
            </text>
          )}
          {CHAIN_PROVIDERS.map((prov, idx) => {
            const isCursor = idx === chainCursor;
            const isOn = chainSelected.has(prov.name);
            const pos = isOn ? chainOrder.indexOf(prov.name) + 1 : 0;
            const hasKey = !!(
              config.apiKeys?.[prov.apiKeyEnvVar] || process.env[prov.apiKeyEnvVar]
            );
            const label = prov.displayName.padEnd(18).substring(0, 18);
            return (
              <box key={prov.name} height={1} backgroundColor={isCursor ? C.bgHighlight : C.bg}>
                <text>
                  {isOn ? (
                    <span fg={C.green} bold>{` [${pos}] `}</span>
                  ) : (
                    <span fg={C.dim}>{" [ ] "}</span>
                  )}
                  <span fg={isCursor ? C.white : hasKey ? C.fgMuted : C.dim} bold={isCursor}>
                    {label}
                  </span>
                  {hasKey ? (
                    <span fg={C.green}>{" ●"}</span>
                  ) : (
                    <span fg={C.dim}>{" ○ no key"}</span>
                  )}
                </text>
              </box>
            );
          })}
        </box>
      )}
    </box>
  );
}
