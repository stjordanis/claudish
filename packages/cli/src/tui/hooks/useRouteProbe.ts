import { useCallback, useState } from "react";
import { route } from "../../providers/routing-rules.js";
import type { ClaudishProfileConfig } from "../../profile-config.js";
import { PROVIDERS } from "../providers.js";
import { testProviderKey } from "../test-provider.js";
import type { ProbeEntry, ProbeMode } from "../types.js";

/**
 * Discriminated-union state for the route probe wizard.
 *
 * NOTE: this hook intentionally does NOT abort the in-flight test loop on
 * `cancel()`. The IIFE in `submit()` keeps running and continues calling
 * `setProbeResults` / `setProbeMode` even after `cancel()` flips the state to
 * idle. This preserves baseline behavior — see "Probe cancel does NOT abort
 * the in-flight loop" constraint in the refactor task description.
 */
export type ProbeState =
  | { kind: "idle" }
  | { kind: "input"; model: string }
  | { kind: "running"; model: string; results: ProbeEntry[] }
  | { kind: "done"; model: string; results: ProbeEntry[] };

export interface UseRouteProbeReturn {
  /** Discriminated-union view of the probe wizard state. */
  state: ProbeState;
  /** Legacy probe-mode tag (for prop drilling into render components). */
  probeMode: ProbeMode;
  /** Current input or submitted model name (empty string when idle). */
  probeModel: string;
  /** Per-provider probe results (empty when idle/input). */
  probeResults: ProbeEntry[];
  /** Switch to input mode with a blank model + cleared results. */
  startInput: () => void;
  /** Append a single character to the input. No-op outside input. */
  typeChar: (ch: string) => void;
  /** Trim one character. No-op outside input. */
  backspace: () => void;
  /**
   * Submit the current input. Empty input → idle; unroutable model → done with
   * single failed entry; otherwise → running, kicks off the async test loop.
   *
   * The async loop is INTENTIONALLY not abort-aware. See the type comment.
   */
  submit: () => void;
  /**
   * Cancel from running/done — clear results, set state to idle.
   * Does NOT abort an in-flight test loop (preserves baseline wart).
   */
  cancel: () => void;
  /** From done state, start a new probe (blank input). */
  enterFromDone: () => void;
}

export function useRouteProbe(config: ClaudishProfileConfig): UseRouteProbeReturn {
  const [probeMode, setProbeMode] = useState<ProbeMode>("idle");
  const [probeModel, setProbeModel] = useState("");
  const [probeResults, setProbeResults] = useState<ProbeEntry[]>([]);

  const startInput = useCallback(() => {
    setProbeModel("");
    setProbeResults([]);
    setProbeMode("input");
  }, []);

  const typeChar = useCallback((ch: string) => {
    setProbeModel((p) => p + ch);
  }, []);

  const backspace = useCallback(() => {
    setProbeModel((p) => p.slice(0, -1));
  }, []);

  const cancel = useCallback(() => {
    // NOTE: does NOT abort the in-flight async loop in submit() — see
    // type comment. Preserves baseline behavior.
    setProbeModel("");
    setProbeResults([]);
    setProbeMode("idle");
  }, []);

  const enterFromDone = useCallback(() => {
    setProbeModel("");
    setProbeResults([]);
    setProbeMode("input");
  }, []);

  const submit = useCallback(() => {
    const model = probeModel.trim();
    if (!model) {
      setProbeModel("");
      setProbeMode("idle");
      return;
    }
    const plan = route(model);
    if (plan.kind !== "ok") {
      setProbeResults([
        {
          provider: "none",
          displayName: "No routes found",
          status: "failed",
          error: plan.hint ?? plan.reason,
        },
      ]);
      setProbeMode("done");
      return;
    }
    const chain = [plan.primary, ...plan.fallbacks];
    // Check which routing rule matched. Case-INSENSITIVE — must mirror the
    // matching logic in matchRoutingRule (routing-rules.ts) so the probe panel
    // doesn't lie about which rule the engine actually picked.
    const ruleEntries = Object.entries(config.routing ?? {});
    const modelLower = model.toLowerCase();
    const matchedRule = ruleEntries.find(([pat]) => {
      if (pat.toLowerCase() === modelLower) return true;
      if (pat.includes("*")) {
        const regex = new RegExp("^" + pat.replace(/\*/g, ".*") + "$", "i");
        return regex.test(model);
      }
      return false;
    });

    const initial: ProbeEntry[] = chain.map((r) => {
      return {
        provider: r.provider,
        displayName: r.displayName,
        status: "pending",
        hasKey: true,
        reason: matchedRule ? `Custom rule: ${matchedRule[0]}` : "Default fallback chain",
      };
    });
    setProbeResults(initial);
    setProbeMode("running");

    // Run tests sequentially — skip providers without keys.
    // INTENTIONAL: the loop is NOT abort-aware. Even after the user presses
    // Esc to cancel and the state flips to idle, this loop keeps running and
    // can transition the state back to "done" via setProbeMode("done").
    // This preserves the baseline behavior — DO NOT add an AbortController.
    (async () => {
      for (let i = 0; i < chain.length; i++) {
        const entry = initial[i]!;
        if (!entry.hasKey) {
          // No key — mark as no_key (already set), continue to next
          continue;
        }
        // Mark current as testing
        setProbeResults((prev) =>
          prev.map((e, idx) => (idx === i ? { ...e, status: "testing" } : e))
        );
        const startMs = Date.now();
        const provDef = PROVIDERS.find((p) => p.name === chain[i]!.provider);
        const apiKey =
          (provDef
            ? config.apiKeys?.[provDef.apiKeyEnvVar] || process.env[provDef.apiKeyEnvVar]
            : undefined) ?? "";
        const elapsed = () => Date.now() - startMs;
        const result = await testProviderKey(chain[i]!.provider, apiKey);
        const ms = elapsed();
        const ok = result === "valid";
        setProbeResults((prev) =>
          prev.map((e, idx) => {
            if (idx === i)
              return {
                ...e,
                status: ok ? ("success" as const) : ("failed" as const),
                error: ok ? undefined : result,
                ms,
              };
            // After success: remaining providers with keys become "not reached",
            // without keys stay "no_key"
            if (idx > i && ok && e.status !== "no_key")
              return { ...e, status: "skipped" as const };
            return e;
          })
        );
        if (ok) break;
      }
      setProbeMode("done");
    })();
  }, [config, probeModel]);

  // Build the DU view from the underlying state atoms.
  let state: ProbeState;
  if (probeMode === "idle") state = { kind: "idle" };
  else if (probeMode === "input") state = { kind: "input", model: probeModel };
  else if (probeMode === "running")
    state = { kind: "running", model: probeModel, results: probeResults };
  else state = { kind: "done", model: probeModel, results: probeResults };

  return {
    state,
    probeMode,
    probeModel,
    probeResults,
    startInput,
    typeChar,
    backspace,
    submit,
    cancel,
    enterFromDone,
  };
}
