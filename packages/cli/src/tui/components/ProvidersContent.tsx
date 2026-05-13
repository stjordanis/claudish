/** @jsxImportSource @opentui/react */
import { C } from "../theme.js";
import {
  ProviderDef,
  maskKey,
  providerAuthCapabilities,
  providerAuthSource,
} from "../providers.js";
import type { TestResultsMap } from "../types.js";
import type { ClaudishProfileConfig } from "../../profile-config.js";

interface ProvidersContentProps {
  config: ClaudishProfileConfig;
  displayProviders: ProviderDef[];
  providerIndex: number;
  testResults: TestResultsMap;
  width: number;
  contentH: number;
  isInputMode: boolean;
}

// Column widths — kept here so headers and rows stay in lockstep.
const COL_NAME = 14;
const COL_STATUS = 9;  // "ready Xms" / "testing" / "not set" / "FAIL"
// AUTH column: icon-based encoding.
//   🔑 = key set       (2 cells)
//   🌐 = oauth set     (2 cells)
//   ·  = supported but not set (1 cell, padded to 2 for alignment)
//   (blank 2 cells) = method not supported by this provider
// Two slots side by side: [key-slot] " " [oauth-slot] → 5 cells total.
const COL_AUTH = 5;
const COL_KEY = 10;    // 8-char mask + a little breathing room

function pad(s: string, n: number): string {
  return s.length >= n ? s.substring(0, n) : s + " ".repeat(n - s.length);
}

export function ProvidersContent({
  config,
  displayProviders,
  providerIndex,
  testResults,
  width,
  contentH,
  isInputMode,
}: ProvidersContentProps) {
  // contentH = total height of the rounded box.
  //   -2 for top/bottom border, -1 for column header, -1 for legend row.
  const listH = contentH - 4;
  let separatorRendered = false;

  const getRow = (p: ProviderDef, idx: number) => {
    const auth = providerAuthSource(p, config);
    const caps = providerAuthCapabilities(p, config);
    const isReady = auth !== null;
    const isOauthOnly = auth === "oauth";
    const selected = idx === providerIndex;

    // KEY column. For API-key providers, show the masked key. For OAuth-
    // only providers, show "oauth···" placeholder so the column aligns and
    // makes the auth method obvious at a glance. For unauthenticated
    // providers, dashes.
    let keyDisplay: string;
    if (isOauthOnly) {
      keyDisplay = "oauth···";
    } else if (auth === "cfg") {
      keyDisplay = maskKey(config.apiKeys?.[p.apiKeyEnvVar]);
    } else if (auth === "env" || auth === "e+c") {
      keyDisplay = maskKey(process.env[p.apiKeyEnvVar]);
    } else {
      keyDisplay = "────────";
    }

    const isFirstUnready = !isReady && !separatorRendered;
    if (isFirstUnready) separatorRendered = true;

    // Inline test result for this provider.
    const tr = testResults[p.name];
    let statusFg: string = isReady ? C.green : C.dim;
    let statusText = isReady ? "ready" : "not set";
    if (tr) {
      if (tr.status === "testing") {
        statusFg = C.yellow;
        statusText = "testing";
      } else if (tr.status === "valid") {
        statusFg = C.green;
        statusText = tr.ms !== undefined ? `ready ${tr.ms}ms` : "ready";
      } else {
        statusFg = C.red;
        statusText = "FAIL";
      }
    }

    // AUTH column — two capability slots, side by side.
    //   ● = configured/set
    //   ○ = supported, not yet configured
    //  (space) = not supported by this provider
    //
    // Label "key" is green (API-key family), "oauth" is cyan (OAuth path).
    // When not supported, both label and glyph are blank-padded so columns
    // align between rows with different capability sets.
    const keySlot = caps.apiKey;
    const oauthSlot = caps.oauth;

    return (
      <box key={p.name} flexDirection="column">
        {isFirstUnready && (
          <box height={1} paddingX={1}>
            <text>
              <span fg={C.dim}>
                {"─ not configured "}
                {"─".repeat(Math.max(0, width - 22))}
              </span>
            </text>
          </box>
        )}
        <box height={1} flexDirection="row" backgroundColor={selected ? C.bgHighlight : C.bg}>
          <text>
            <span fg={tr?.status === "testing" ? C.yellow : isReady ? C.green : C.dim}>
              {tr?.status === "testing" ? "◌" : isReady ? "●" : "○"}
            </span>
            <span>{"  "}</span>
            <span fg={selected ? C.white : isReady ? C.fgMuted : C.dim} bold={selected}>
              {pad(p.displayName, COL_NAME)}
            </span>
            <span fg={C.dim}>{"  "}</span>
            <span fg={statusFg} bold={tr?.status === "valid" || isReady}>
              {pad(statusText, COL_STATUS)}
            </span>
            <span fg={C.dim}>{"  "}</span>
            {/* AUTH column: emoji icons. Each slot is 2 terminal cells.
                  🔑 / 🌐 = method set
                  ·       = method supported but not set (1 cell + 1 pad)
                  blank   = method not supported (2 cells)
                Legend at the bottom of the panel explains the icons. */}
            {(() => {
              const keySlotGlyph = !keySlot.supported
                ? "  "
                : keySlot.set
                  ? "🔑"
                  : "· ";
              const oauthSlotGlyph = !oauthSlot.supported
                ? "  "
                : oauthSlot.set
                  ? "🌐"
                  : "· ";
              // Color the unset dot dim; the emoji renders with terminal color.
              return (
                <>
                  <span fg={keySlot.set ? C.white : C.dim}>{keySlotGlyph}</span>
                  <span>{" "}</span>
                  <span fg={oauthSlot.set ? C.white : C.dim}>{oauthSlotGlyph}</span>
                </>
              );
            })()}
            <span fg={C.dim}>{"  "}</span>
            <span fg={isOauthOnly ? C.cyan : isReady ? C.cyan : C.dim}>
              {pad(keyDisplay, COL_KEY)}
            </span>
            <span fg={C.dim}>{"  "}</span>
            <span fg={selected ? C.white : C.dim}>{p.description}</span>
          </text>
        </box>
      </box>
    );
  };

  return (
    <box
      height={contentH}
      border
      borderStyle="single"
      borderColor={!isInputMode ? C.blue : C.dim}
      backgroundColor={C.bg}
      flexDirection="column"
      paddingX={1}
    >
      {/* Column header — widths match COL_* constants used by getRow.
          AUTH column shows per-row "key ● oauth ●" capability slots.
          Glyph legend: ● = set, ○ = supported but not set, blank = not
          supported. */}
      <text>
        <span fg={C.dim}>{"   "}</span>
        <span fg={C.blue} bold>{pad("PROVIDER", COL_NAME)}</span>
        <span>{"  "}</span>
        <span fg={C.blue} bold>{pad("STATUS", COL_STATUS)}</span>
        <span>{"  "}</span>
        <span fg={C.blue} bold>{pad("AUTH", COL_AUTH)}</span>
        <span>{"  "}</span>
        <span fg={C.blue} bold>{pad("KEY", COL_KEY)}</span>
        <span>{"  "}</span>
        <span fg={C.blue} bold>DESCRIPTION</span>
      </text>
      {displayProviders.slice(0, listH).map(getRow)}
      {/* AUTH column icon legend — sits at the bottom of the panel so users
          learn what 🔑 / 🌐 / · mean without us needing to repeat the
          hint per row or in the description column. */}
      <box flexDirection="row" height={1} paddingX={1}>
        <text>
          <span fg={C.dim}>{"AUTH:  "}</span>
          <span>{"🔑"}</span>
          <span fg={C.fgMuted}>{" key set  "}</span>
          <span>{"🌐"}</span>
          <span fg={C.fgMuted}>{" oauth set  "}</span>
          <span fg={C.dim}>{"·"}</span>
          <span fg={C.fgMuted}>{" supported, not set  "}</span>
          <span fg={C.dim}>{"(blank) not available"}</span>
        </text>
      </box>
    </box>
  );
}
