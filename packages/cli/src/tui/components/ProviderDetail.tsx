/** @jsxImportSource @opentui/react */
import { A, C } from "../theme.js";
import { DETAIL_H } from "../constants.js";
import type { ProviderDef } from "../providers.js";
import type { Mode, TestResultsMap } from "../types.js";

/**
 * Collapse newlines and clip an error string to a single line that fits
 * inside the detail box without wrapping. Used for `tr.error` which can
 * come back from describeProbeState as a multi-line, 200-char message.
 */
function truncateOneLine(text: string, maxWidth: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const limit = Math.max(20, maxWidth);
  if (collapsed.length <= limit) return collapsed;
  return collapsed.slice(0, limit - 1) + "…";
}

interface ProviderDetailProps {
  selectedProvider: ProviderDef;
  mode: Mode;
  inputValue: string;
  setInputValue: (v: string) => void;
  width: number;
  hasCfgKey: boolean;
  hasEnvKey: boolean;
  hasKey: boolean;
  /** True when the env-var key was hydrated from 1Password (not a shell env var). */
  isOpKey: boolean;
  /** True for a keyless/free provider usable via its built-in public key. */
  isPublicKey: boolean;
  cfgKeyMask: string;
  envKeyMask: string;
  activeEndpoint: string;
  testResults: TestResultsMap;
  isInputMode: boolean;
}

export function ProviderDetail({
  selectedProvider,
  mode,
  inputValue,
  setInputValue,
  width,
  hasCfgKey,
  hasEnvKey,
  hasKey,
  isOpKey,
  isPublicKey,
  cfgKeyMask,
  envKeyMask,
  activeEndpoint,
  testResults,
  isInputMode,
}: ProviderDetailProps) {
  // Show the mask of the key that's ACTUALLY being used at runtime.
  // process.env wins over config in the resolver, so env is shown first when both exist.
  const displayKey = selectedProvider.isLocal
    ? hasKey
      ? "enabled"
      : "disabled"
    : hasEnvKey
      ? envKeyMask
      : hasCfgKey
        ? cfgKeyMask
        : isPublicKey
          ? "free"
          : "────────";

  if (isInputMode) {
    return (
      <box
        height={DETAIL_H}
        border
        borderStyle="single"
        borderColor={C.focusBorder}
        title={` Set ${mode === "input_key" ? "API Key" : "Endpoint"} — ${selectedProvider.displayName} `}
        backgroundColor={C.bg}
        flexDirection="column"
        paddingX={1}
      >
        <text>
          <span fg={C.green} attributes={A.bold}>
            Enter{" "}
          </span>
          <span fg={C.fgMuted}>to save · </span>
          <span fg={C.red} attributes={A.bold}>
            Esc{" "}
          </span>
          <span fg={C.fgMuted}>to cancel</span>
        </text>
        <box flexDirection="row">
          <text>
            <span fg={C.green} attributes={A.bold}>
              &gt;{" "}
            </span>
          </text>
          <input
            value={inputValue}
            // onInput fires on every keystroke; onChange only fires on blur
            // or the input's own submit (which doesn't happen here because
            // our useKeyboard handler intercepts Enter first). Without this
            // the parent's inputValue stays at the prefilled value and the
            // user's edits are lost when they press Enter.
            onInput={setInputValue}
            onChange={setInputValue}
            focused={true}
            width={width - 8}
            backgroundColor={C.bgHighlight}
            textColor={C.white}
          />
        </box>
      </box>
    );
  }

  const tr = testResults[selectedProvider.name];

  return (
    <box
      height={DETAIL_H}
      border
      borderStyle="single"
      borderColor={C.dim}
      title={` ${selectedProvider.displayName} `}
      backgroundColor={C.bgAlt}
      flexDirection="column"
      paddingX={1}
    >
      {/*
        Single-row line: Status + Key + source breakdown.
        Source labels enumerate every place this key is found (env, config),
        in runtime precedence order. The runtime-active source is tagged
        `(used)`; a shadowed source is tagged `(shadowed)` so the user
        knows their `s`-saved config key isn't taking effect.

        Packed into ONE <text> row to fit inside DETAIL_H=7 (5 content
        rows: this + URL + Desc + Get Key + Test). All literal whitespace
        goes inside `{...}` to avoid JSX whitespace trimming.
      */}
      <text>
        <span fg={C.blue} attributes={A.bold}>{"Status: "}</span>
        {hasKey ? (
          <span fg={C.green} attributes={A.bold}>{"● Ready"}</span>
        ) : (
          <span fg={C.fgMuted}>{"○ Not configured"}</span>
        )}
        <span fg={C.dim}>{"   "}</span>
        <span fg={C.blue} attributes={A.bold}>{"Key: "}</span>
        <span fg={C.green}>{displayKey}</span>
        {hasKey && selectedProvider.isLocal && (
          <>
            <span fg={C.dim}>{"   "}</span>
            <span fg={C.blue} attributes={A.bold}>{"From: "}</span>
            <span fg={C.green} attributes={A.bold}>{"global config"}</span>
          </>
        )}
        {hasKey && !selectedProvider.isLocal && isPublicKey && (
          <>
            <span fg={C.dim}>{"   "}</span>
            <span fg={C.blue} attributes={A.bold}>{"From: "}</span>
            <span fg={C.green} attributes={A.bold}>{"public key (free)"}</span>
          </>
        )}
        {hasKey && !selectedProvider.isLocal && !isPublicKey && (
          <>
            <span fg={C.dim}>{"   "}</span>
            <span fg={C.blue} attributes={A.bold}>{"From: "}</span>
            {hasEnvKey && (
              <span fg={C.green} attributes={A.bold}>{isOpKey ? "1Password" : "env"}</span>
            )}
            {hasEnvKey && hasCfgKey && (
              <span fg={C.fgMuted}>{" (used) + "}</span>
            )}
            {hasEnvKey && !hasCfgKey && (
              <span fg={C.fgMuted}>{" (used)"}</span>
            )}
            {hasCfgKey && (
              <span fg={hasEnvKey ? C.fgMuted : C.green} attributes={A.boldIf(!hasEnvKey)}>
                {"config"}
              </span>
            )}
            {hasCfgKey && (
              <span fg={C.fgMuted}>
                {hasEnvKey ? " (shadowed)" : " (used)"}
              </span>
            )}
          </>
        )}
      </text>
      {selectedProvider.endpointEnvVar && (
        <text>
          <span fg={C.blue} attributes={A.bold}>
            URL:{" "}
          </span>
          <span fg={C.cyan}>
            {activeEndpoint || selectedProvider.defaultEndpoint || "default"}
          </span>
        </text>
      )}
      <text>
        <span fg={C.blue} attributes={A.bold}>
          Desc:{" "}
        </span>
        <span fg={C.white}>{selectedProvider.description}</span>
      </text>
      {selectedProvider.keyUrl && (
        <text>
          <span fg={C.blue} attributes={A.bold}>
            Get Key:{" "}
          </span>
          <span fg={C.cyan}>{selectedProvider.keyUrl}</span>
        </text>
      )}
      {tr && (
        <text>
          <span fg={C.blue} attributes={A.bold}>
            {"Test:  "}
          </span>
          {tr.status === "testing" && (
            <span fg={C.yellow} attributes={A.bold}>
              {"◌ testing..."}
            </span>
          )}
          {tr.status === "valid" && (
            <>
              <span fg={C.green} attributes={A.bold}>
                {"● valid"}
              </span>
              {tr.ms !== undefined && <span fg={C.dim}>{`  ${tr.ms}ms`}</span>}
              <span fg={C.fgMuted}>
                {selectedProvider.isLocal
                  ? "  Local provider responded through the shared probe path."
                  : "  API key is valid and endpoint is reachable."}
              </span>
            </>
          )}
          {tr.status === "failed" && (
            <>
              <span fg={C.red} attributes={A.bold}>
                {"✗ failed"}
              </span>
              {tr.error && (
                <span fg={C.red}>
                  {/* Clip the error to a single line. describeProbeState can
                      produce 200+ char strings ("HTTP 400. Request format
                      may be incompatible…") that wrap and overflow the
                      fixed-height detail box, bleeding into the provider
                      rows above. */}
                  {`  ${truncateOneLine(tr.error, width - 16)}`}
                </span>
              )}
            </>
          )}
          {tr.status === "unavailable" && (
            <>
              {/* Not a failure — the server is off or has no chat model to probe.
                  Neutral yellow, not red. */}
              <span fg={C.yellow} attributes={A.bold}>
                {"○ unavailable"}
              </span>
              {tr.error && (
                <span fg={C.yellow}>{`  ${truncateOneLine(tr.error, width - 16)}`}</span>
              )}
            </>
          )}
        </text>
      )}
    </box>
  );
}
