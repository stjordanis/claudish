/** @jsxImportSource @opentui/react */
import { C } from "../theme.js";
import { FOOTER_H } from "../constants.js";
import type { Mode, ProbeMode, Tab } from "../types.js";

interface FooterProps {
  activeTab: Tab;
  mode: Mode;
  probeMode: ProbeMode;
}

export function Footer({ activeTab, mode, probeMode }: FooterProps) {
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
    keys = [
      [C.blue, "↑↓", "navigate"],
      [C.green, "s", "set key"],
      [C.green, "e", "endpoint"],
      [C.cyan, "t", "test key"],
      [C.red, "x", "remove"],
      [C.blue, "Tab", "section"],
      [C.dim, "q", "quit"],
    ];
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
            {i > 0 && <span fg={C.dim}>{" │ "}</span>}
            <span fg={color as string} bold>
              {key}
            </span>
            <span fg={C.fgMuted}> {label}</span>
          </span>
        ))}
      </text>
    </box>
  );
}
