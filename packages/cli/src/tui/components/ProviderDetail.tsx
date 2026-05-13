/** @jsxImportSource @opentui/react */
import { C } from "../theme.js";
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
  cfgKeyMask: string;
  envKeyMask: string;
  keySrc: string;
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
  cfgKeyMask,
  envKeyMask,
  keySrc,
  activeEndpoint,
  testResults,
  isInputMode,
}: ProviderDetailProps) {
  const displayKey = hasCfgKey ? cfgKeyMask : hasEnvKey ? envKeyMask : "────────";

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
          <span fg={C.green} bold>
            Enter{" "}
          </span>
          <span fg={C.fgMuted}>to save · </span>
          <span fg={C.red} bold>
            Esc{" "}
          </span>
          <span fg={C.fgMuted}>to cancel</span>
        </text>
        <box flexDirection="row">
          <text>
            <span fg={C.green} bold>
              &gt;{" "}
            </span>
          </text>
          <input
            value={inputValue}
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
      <box flexDirection="row">
        <text>
          <span fg={C.blue} bold>
            Status:{" "}
          </span>
          {hasKey ? (
            <span fg={C.green} bold>
              ● Ready
            </span>
          ) : (
            <span fg={C.fgMuted}>○ Not configured</span>
          )}
          <span fg={C.dim}>{"    "}</span>
          <span fg={C.blue} bold>
            Key:{" "}
          </span>
          <span fg={C.green}>{displayKey}</span>
          {keySrc && <span fg={C.fgMuted}> (source: {keySrc})</span>}
        </text>
      </box>
      {selectedProvider.endpointEnvVar && (
        <text>
          <span fg={C.blue} bold>
            URL:{" "}
          </span>
          <span fg={C.cyan}>
            {activeEndpoint || selectedProvider.defaultEndpoint || "default"}
          </span>
        </text>
      )}
      <text>
        <span fg={C.blue} bold>
          Desc:{" "}
        </span>
        <span fg={C.white}>{selectedProvider.description}</span>
      </text>
      {selectedProvider.keyUrl && (
        <text>
          <span fg={C.blue} bold>
            Get Key:{" "}
          </span>
          <span fg={C.cyan}>{selectedProvider.keyUrl}</span>
        </text>
      )}
      {tr && (
        <text>
          <span fg={C.blue} bold>
            {"Test:  "}
          </span>
          {tr.status === "testing" && (
            <span fg={C.yellow} bold>
              {"◌ testing..."}
            </span>
          )}
          {tr.status === "valid" && (
            <>
              <span fg={C.green} bold>
                {"● valid"}
              </span>
              {tr.ms !== undefined && <span fg={C.dim}>{`  ${tr.ms}ms`}</span>}
              <span fg={C.fgMuted}>{"  API key is valid and endpoint is reachable."}</span>
            </>
          )}
          {tr.status === "failed" && (
            <>
              <span fg={C.red} bold>
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
        </text>
      )}
    </box>
  );
}
