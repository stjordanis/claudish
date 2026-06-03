/** @jsxImportSource @opentui/react */
import { A, C } from "../theme.js";
import { FOOTER_H } from "../constants.js";
import type { Mode, ProbeMode, Tab } from "../types.js";

interface FooterProps {
  activeTab: Tab;
  mode: Mode;
  probeMode: ProbeMode;
  /**
   * When on the Providers tab in browse mode, the cursor row's auth
   * capabilities. Used to hide `s set key` / `l login` / `e endpoint`
   * chips on rows that don't support the corresponding method. Omitting
   * the object means "show every chip" (back-compat).
   */
  providerCaps?: {
    apiKey: boolean;
    oauth: boolean;
    endpoint: boolean;
    local: boolean;
    localEnabled: boolean;
  };
}

/**
 * Pick black or white chip text for a `#rrggbb` background by its perceptual
 * luminance (luma weights — green dominates). Bright fills (neon green, cyan,
 * yellow) get black text; dark fills (blue, red, gray) get white. Computed, not
 * hardcoded per-hotkey, so it stays correct if a chip's color changes upstream.
 */
function chipTextColor(bgHex: string): string {
  const r = parseInt(bgHex.slice(1, 3), 16);
  const g = parseInt(bgHex.slice(3, 5), 16);
  const b = parseInt(bgHex.slice(5, 7), 16);
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  return luma > 150 ? C.black : C.fg;
}

export function Footer({ activeTab, mode, probeMode, providerCaps }: FooterProps) {
  // Recompute isProfileEditMode from the `mode` prop — pure on `mode`, kept
  // self-contained so the parent doesn't have to pass a derived bool.
  const isProfileEditMode =
    mode === "new_profile" ||
    mode === "pick_profile_scope" ||
    mode === "pick_provider_prefix" ||
    mode === "edit_profile_opus" ||
    mode === "edit_profile_sonnet" ||
    mode === "edit_profile_haiku" ||
    mode === "edit_profile_subagent";

  let keys: Array<[string, string, string]>;
  if (activeTab === "routing" && probeMode === "input") {
    keys = [
      [C.green, "Enter", "probe"],
      [C.red, "Esc", "cancel"],
    ];
  } else if (activeTab === "routing" && probeMode === "running") {
    keys = [
      [C.yellow, "◌", "probing..."],
      [C.red, "Esc", "cancel"],
    ];
  } else if (activeTab === "routing" && probeMode === "done") {
    keys = [
      [C.cyan, "p", "back to routes"],
      [C.green, "Enter", "probe another"],
      [C.red, "Esc", "back to routes"],
      [C.dim, "q", "quit"],
    ];
  } else if (activeTab === "providers") {
    // Hotkey row is computed per-cursor-row: chips that don't apply to the
    // selected provider are hidden. e.g. Gemini Code Assist has no API-key
    // path so `s set key` and `e endpoint` are omitted; bare Gemini has no
    // OAuth path so `l login` is omitted.
    //
    // When providerCaps is omitted (e.g. legacy callers, empty list), all
    // chips are shown — back-compat.
    const showKey = providerCaps ? providerCaps.apiKey : true;
    const showEndpoint = providerCaps ? providerCaps.endpoint || providerCaps.local : true;
    const showLogin = providerCaps ? providerCaps.oauth : true;
    const showRemove = providerCaps ? !providerCaps.local && (providerCaps.apiKey || providerCaps.endpoint) : true;
    // `u` is shown whenever the provider has an editable endpoint URL.
    // For local providers it's the ONLY way to change the URL because `e`
    // is taken by the enable/disable toggle. For remote providers it's a
    // shortcut equivalent to `e endpoint`.
    const showUrl = providerCaps ? providerCaps.endpoint : true;
    keys = [[C.blue, "↑↓", "navigate"]];
    if (showKey) keys.push([C.green, "s", "set key"]);
    if (showEndpoint) keys.push([C.green, "e", providerCaps?.local ? (providerCaps.localEnabled ? "disable" : "enable") : "endpoint"]);
    if (showUrl) keys.push([C.green, "u", "url"]);
    if (showLogin) keys.push([C.green, "l", "login"]);
    keys.push([C.cyan, "t", "test"]);
    keys.push([C.cyan, "T", "test all"]);
    if (showRemove) keys.push([C.red, "x", "remove"]);
    keys.push([C.dim, "q", "quit"]);
  } else if (activeTab === "profiles" && mode === "pick_profile_scope") {
    keys = [
      [C.green, "g", "global"],
      [C.cyan, "p", "project"],
      [C.red, "Esc", "cancel"],
    ];
  } else if (activeTab === "profiles" && mode === "pick_provider_prefix") {
    keys = [
      [C.blue, "↑↓", "navigate"],
      [C.green, "Enter", "select prefix"],
      [C.red, "Esc", "back"],
    ];
  } else if (activeTab === "profiles" && isProfileEditMode) {
    keys = [
      [C.green, "Enter", "save field"],
      [C.blue, "Tab", "provider picker"],
      [C.blue, "↑↓", "suggestion"],
      [C.yellow, "a", "auto-route"],
      [C.red, "Esc", "cancel"],
    ];
  } else if (activeTab === "profiles") {
    keys = [
      [C.blue, "↑↓", "navigate"],
      [C.green, "Enter", "activate"],
      [C.cyan, "n", "new"],
      [C.green, "e", "edit"],
      [C.red, "d", "delete"],
      [C.blue, "Tab", "section"],
      [C.dim, "q", "quit"],
    ];
  } else if (activeTab === "routing" && mode === "pick_routing_scope") {
    // Routing scope picker — menu navigation. Letters g/p still work as
    // accelerators but the visible affordance is arrows + Enter.
    keys = [
      [C.blue, "↑↓", "navigate"],
      [C.green, "Enter", "select"],
      [C.red, "Esc", "cancel"],
    ];
  } else if (activeTab === "routing") {
    keys = [
      [C.blue, "↑↓", "navigate"],
      [C.green, "a", "add rule"],
      [C.green, "e", "edit"],
      [C.red, "d", "delete"],
      [C.cyan, "p", "probe"],
      [C.blue, "Tab", "section"],
      [C.dim, "q", "quit"],
    ];
  } else {
    keys = [
      [C.green, "t", "telemetry"],
      [C.green, "u", "stats"],
      [C.red, "c", "clear"],
      [C.blue, "Tab", "section"],
      [C.dim, "q", "quit"],
    ];
  }

  return (
    <box height={FOOTER_H} flexDirection="row" paddingX={1} backgroundColor={C.bgAlt}>
      <text>
        {keys.map(([color, key, label], i) => (
          <span key={i}>
            {/* Gap between chip groups — no pipe separators; spacing carries it. */}
            {i > 0 && <span>{"  "}</span>}
            {/* Key badge: solid color fill, auto black/white text by luminance,
                spaces inside for pill padding. */}
            <span fg={chipTextColor(color as string)} bg={color as string} attributes={A.bold}>
              {` ${key} `}
            </span>
            {/* Label: muted plain text beside the badge. */}
            <span fg={C.fgMuted}>{` ${label}`}</span>
          </span>
        ))}
      </text>
    </box>
  );
}
