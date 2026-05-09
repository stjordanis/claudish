/** @jsxImportSource @opentui/react */
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useCallback, useMemo, useState } from "react";
import {
  loadConfig,
  loadLocalConfig,
  removeApiKey,
  removeEndpoint,
  saveConfig,
  saveLocalConfig,
  setApiKey,
  setEndpoint,
} from "../profile-config.js";
import { DEFAULT_ROUTING_RULES } from "../providers/default-routing-rules.js";
import { clearBuffer, getBufferStats } from "../stats-buffer.js";
import { testProviderKey } from "./test-provider.js";
import { PROVIDERS, maskKey } from "./providers.js";
import { C } from "./theme.js";
import {
  CHAIN_PROVIDERS,
  HEADER_H,
  TABS_H,
  FOOTER_H,
  DETAIL_H,
  VERSION,
} from "./constants.js";
import type { MergedRule, Mode, RoutingScope, Tab, TestResultsMap } from "./types.js";
import { useRouteProbe } from "./hooks/useRouteProbe.js";
import { useProfileWizard } from "./hooks/useProfileWizard.js";
import { TabBar } from "./components/TabBar.js";
import { Footer } from "./components/Footer.js";
import { ProvidersContent } from "./components/ProvidersContent.js";
import { ProviderDetail } from "./components/ProviderDetail.js";
import { ProfilesContent } from "./components/ProfilesContent.js";
import { ProfileDetail } from "./components/ProfileDetail.js";
import { RoutingContent } from "./components/RoutingContent.js";
import { RoutingDetail } from "./components/RoutingDetail.js";
import { PrivacyContent } from "./components/PrivacyContent.js";
import { PrivacyDetail } from "./components/PrivacyDetail.js";

export function App() {
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();

  const [config, setConfig] = useState(() => loadConfig());
  const [bufStats, setBufStats] = useState(() => getBufferStats());
  const [providerIndex, setProviderIndex] = useState(0);
  const [activeTab, setActiveTab] = useState<Tab>("providers");
  const [mode, setMode] = useState<Mode>("browse");
  const [inputValue, setInputValue] = useState("");
  const [routingPattern, setRoutingPattern] = useState("");
  const [routingChain, setRoutingChain] = useState("");
  const [chainSelected, setChainSelected] = useState<Set<string>>(new Set());
  const [chainOrder, setChainOrder] = useState<string[]>([]);
  const [chainCursor, setChainCursor] = useState(0);
  // Routing scope wizard state. `routingScope` carries the user's `g`/`p`
  // choice from `pick_routing_scope` into `add_routing_chain`'s save logic.
  // `routingScopeReturnsToEdit=true` when entering the chain builder via
  // `e` (edit existing rule), so the picker is skipped and the rule's own
  // scope is used (edit-in-place semantics, matching Profiles wizard).
  const [routingScope, setRoutingScope] = useState<RoutingScope>("global");
  // Cursor for the scope picker menu. 0 = global, 1 = project. Mirrors the
  // chain-selector navigation pattern (↑↓ + Enter) instead of g/p shortcuts.
  const [routingScopeCursor, setRoutingScopeCursor] = useState<0 | 1>(0);
  const [routingScopeReturnsToEdit, setRoutingScopeReturnsToEdit] = useState(false);
  // When `e` is pressed on an existing user/project rule, these track WHICH
  // rule we're editing. If the user picks a DIFFERENT scope in the picker,
  // the save path also deletes the old rule (effectively a move). For new
  // rules (a) and overrides of defaults (e on default), both are null.
  const [editingExistingScope, setEditingExistingScope] = useState<RoutingScope | null>(null);
  const [editingExistingPattern, setEditingExistingPattern] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<TestResultsMap>({});

  // Profile tab state — only the cursor is owned by App. The rest of the
  // profile-edit wizard state lives in useProfileWizard.
  const [profileIndex, setProfileIndex] = useState(0);

  const quit = useCallback(() => renderer.destroy(), [renderer]);

  // Sort: configured providers first, then unconfigured (preserving original order within groups)
  const displayProviders = useMemo(() => {
    return [...PROVIDERS].sort((a, b) => {
      const aHasKey = !!(config.apiKeys?.[a.apiKeyEnvVar] || process.env[a.apiKeyEnvVar]);
      const bHasKey = !!(config.apiKeys?.[b.apiKeyEnvVar] || process.env[b.apiKeyEnvVar]);
      if (aHasKey === bHasKey) return PROVIDERS.indexOf(a) - PROVIDERS.indexOf(b);
      return aHasKey ? -1 : 1;
    });
  }, [config]);

  const selectedProvider = displayProviders[providerIndex]!;
  const refreshConfig = useCallback(() => {
    setConfig(loadConfig());
    setBufStats(getBufferStats());
  }, []);

  // Route probe wizard — owns probeMode/probeModel/probeResults internally.
  // The keyboard handler delegates to verb methods (startInput, submit, etc.).
  const probe = useRouteProbe(config);
  const { probeMode, probeModel, probeResults } = probe;

  // Profile editor wizard — owns editProfileName/Value, profileScope,
  // suggestions/suggestionIndex, providerPickerIndex, and the
  // (intentionally hook-internal) providerPickerReturnMode. The keyboard
  // handler dispatches verb methods; the hook flips parent `mode` for its
  // visible sub-states.
  const wizard = useProfileWizard({ mode, setMode, refreshConfig, setStatusMsg });
  const {
    editProfileName,
    editProfileValue,
    profileScope,
    suggestions,
    suggestionIndex,
    providerPickerIndex,
  } = wizard;

  const hasCfgKey = !!config.apiKeys?.[selectedProvider.apiKeyEnvVar];
  const hasEnvKey = !!process.env[selectedProvider.apiKeyEnvVar];
  const hasKey = hasCfgKey || hasEnvKey;
  const cfgKeyMask = maskKey(config.apiKeys?.[selectedProvider.apiKeyEnvVar]);
  const envKeyMask = maskKey(process.env[selectedProvider.apiKeyEnvVar]);
  const keySrc = hasEnvKey && hasCfgKey ? "e+c" : hasEnvKey ? "env" : hasCfgKey ? "cfg" : "";
  const activeEndpoint =
    (selectedProvider.endpointEnvVar
      ? config.endpoints?.[selectedProvider.endpointEnvVar] ||
        process.env[selectedProvider.endpointEnvVar]
      : undefined) ||
    selectedProvider.defaultEndpoint ||
    "";

  const telemetryEnabled =
    process.env.CLAUDISH_TELEMETRY !== "0" &&
    process.env.CLAUDISH_TELEMETRY !== "false" &&
    config.telemetry?.enabled === true;

  const statsEnabled = process.env.CLAUDISH_STATS !== "0" && process.env.CLAUDISH_STATS !== "false";

  // Merged routing rules: built-in defaults + global config + project-local
  // config rendered as a flat list with NO shadowing. If a pattern exists at
  // multiple layers (e.g. a global override AND a project rule for `gpt-*`),
  // BOTH rows are visible — the user can edit/delete each independently.
  //
  // The runtime routing engine (loadRoutingRules + matchRoutingRule) still
  // applies precedence (project beats global beats default), but the TUI
  // shows the data as it exists on disk, not the runtime resolution.
  //
  // Catch-all `*` is rendered separately above the table and excluded here.
  //
  // Sort order: defaults first (alphabetical), then global, then project.
  // `loadLocalConfig()` is called inside the memo so a `refreshConfig()`
  // after a project save triggers re-derivation.
  const mergedRules: MergedRule[] = useMemo(() => {
    const out: MergedRule[] = [];
    const localCfg = loadLocalConfig();

    for (const [pat, chain] of Object.entries(DEFAULT_ROUTING_RULES)) {
      if (pat === "*") continue;
      out.push({ kind: "default", pattern: pat, chain, overridesDefault: false });
    }
    for (const [pat, chain] of Object.entries(config.routing ?? {})) {
      if (pat === "*") continue;
      out.push({
        kind: "global",
        pattern: pat,
        chain,
        overridesDefault: pat in DEFAULT_ROUTING_RULES,
      });
    }
    if (localCfg?.routing) {
      for (const [pat, chain] of Object.entries(localCfg.routing)) {
        if (pat === "*") continue;
        out.push({
          kind: "project",
          pattern: pat,
          chain,
          overridesDefault: pat in DEFAULT_ROUTING_RULES,
        });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.routing, JSON.stringify(loadLocalConfig()?.routing ?? {})]);
  const profileName = config.defaultProfile || "default";

  const readyCount = PROVIDERS.filter(
    (p) => !!(config.apiKeys?.[p.apiKeyEnvVar] || process.env[p.apiKeyEnvVar])
  ).length;

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") return quit();

    // Probe input mode — handled independently of main mode (non-blocking).
    // Delegates to useRouteProbe verb methods. Note: probe.submit() kicks off
    // an async test loop that does NOT abort on cancel — see the hook comment.
    if (probeMode === "input") {
      if (key.name === "return" || key.name === "enter") {
        probe.submit();
      } else if (key.name === "escape") {
        probe.cancel();
      } else if (key.name === "backspace" || key.name === "delete") {
        probe.backspace();
      } else if (key.raw && key.raw.length === 1 && !key.ctrl && !key.meta) {
        probe.typeChar(key.raw);
      }
      return;
    }

    // Probe running/done — handle keys before normal routing handlers
    if (probeMode === "running" && activeTab === "routing") {
      if (key.name === "escape") {
        probe.cancel();
      }
      // Block all other keys while running
      return;
    }

    if (probeMode === "done" && activeTab === "routing") {
      if (key.name === "q") {
        return quit();
      } else if (key.name === "escape" || key.name === "p") {
        // Return to normal routing view
        probe.cancel();
      } else if (key.name === "return" || key.name === "enter") {
        // Start a new probe
        probe.enterFromDone();
      }
      return;
    }

    // Input modes
    if (mode === "input_key" || mode === "input_endpoint") {
      if (key.name === "return" || key.name === "enter") {
        const val = inputValue.trim();
        if (!val) {
          setStatusMsg("Aborted (empty).");
          setMode("browse");
          return;
        }
        if (mode === "input_key") {
          setApiKey(selectedProvider.apiKeyEnvVar, val);
          process.env[selectedProvider.apiKeyEnvVar] = val;
          setStatusMsg(`Key saved for ${selectedProvider.displayName}.`);
        } else {
          if (selectedProvider.endpointEnvVar) {
            setEndpoint(selectedProvider.endpointEnvVar, val);
            process.env[selectedProvider.endpointEnvVar] = val;
          }
          setStatusMsg("Endpoint saved.");
        }
        refreshConfig();
        setInputValue("");
        setMode("browse");
      } else if (key.name === "escape") {
        setInputValue("");
        setMode("browse");
      }
      return;
    }

    if (mode === "add_routing_pattern") {
      if (key.name === "return" || key.name === "enter") {
        if (routingPattern.trim()) {
          setChainSelected(new Set());
          setChainCursor(0);
          setChainOrder([]);
          // For NEW rules (a from browse) advance to scope picker. For
          // overrides invoked from `e` on a default, the picker is also
          // needed (the user is creating a fresh user rule). The flag
          // routingScopeReturnsToEdit=true is set ONLY on `e` of an
          // existing user rule (global or project) — those already know
          // their scope and skip the picker entirely.
          if (routingScopeReturnsToEdit) {
            setMode("add_routing_chain");
          } else {
            setRoutingScopeCursor(0);
            setMode("pick_routing_scope");
          }
        }
      } else if (key.name === "escape") {
        setRoutingPattern("");
        setMode("browse");
      } else if (key.name === "backspace" || key.name === "delete") {
        setRoutingPattern((p) => p.slice(0, -1));
      } else if (key.raw && key.raw.length === 1 && !key.ctrl && !key.meta) {
        setRoutingPattern((p) => p + key.raw);
      }
      return;
    }

    // Routing scope picker — menu-style navigation (↑↓ + Enter), matching the
    // chain selector and Providers tab. Letter shortcuts (g/p) still work as
    // silent accelerators for users who learned the prior version, but the
    // primary interaction is the menu and the footer advertises that.
    if (mode === "pick_routing_scope") {
      if (key.name === "up" || key.name === "k") {
        setRoutingScopeCursor((i) => (i === 0 ? 0 : 0));
      } else if (key.name === "down" || key.name === "j") {
        setRoutingScopeCursor((i) => (i === 0 ? 1 : 1));
      } else if (key.name === "return" || key.name === "enter") {
        setRoutingScope(routingScopeCursor === 0 ? "global" : "project");
        setMode("add_routing_chain");
      } else if (key.raw === "g" || key.raw === "G") {
        // Silent accelerator — picks AND commits in one keystroke.
        setRoutingScope("global");
        setMode("add_routing_chain");
      } else if (key.raw === "p" || key.raw === "P") {
        setRoutingScope("project");
        setMode("add_routing_chain");
      } else if (key.name === "escape") {
        setRoutingPattern("");
        setChainSelected(new Set());
        setChainOrder([]);
        setRoutingScopeCursor(0);
        setRoutingScopeReturnsToEdit(false);
        setEditingExistingScope(null);
        setEditingExistingPattern(null);
        setMode("browse");
      }
      return;
    }

    if (mode === "add_routing_chain") {
      if (key.name === "up" || key.name === "k") {
        setChainCursor((i) => Math.max(0, i - 1));
      } else if (key.name === "down" || key.name === "j") {
        setChainCursor((i) => Math.min(CHAIN_PROVIDERS.length - 1, i + 1));
      } else if (key.name === "space" || key.raw === " ") {
        // Toggle: add to end or remove
        const provName = CHAIN_PROVIDERS[chainCursor].name;
        setChainSelected((prev) => {
          const next = new Set(prev);
          if (next.has(provName)) {
            next.delete(provName);
            setChainOrder((o) => o.filter((p) => p !== provName));
          } else {
            next.add(provName);
            setChainOrder((o) => [...o, provName]);
          }
          return next;
        });
      } else if (key.raw && key.raw >= "1" && key.raw <= "9") {
        // Number key: move current provider to that position in chain
        const provName = CHAIN_PROVIDERS[chainCursor].name;
        const targetPos = parseInt(key.raw, 10) - 1; // 0-indexed
        setChainSelected((prev) => {
          const next = new Set(prev);
          next.add(provName);
          return next;
        });
        setChainOrder((prev) => {
          const without = prev.filter((p) => p !== provName);
          const insertAt = Math.min(targetPos, without.length);
          without.splice(insertAt, 0, provName);
          return without;
        });
      } else if (key.name === "return" || key.name === "enter") {
        const pat = routingPattern.trim();
        if (pat && chainOrder.length) {
          // Move detection: if `e` was used on an existing rule AND the user
          // picked a different scope in the picker, write to the new scope
          // and delete from the old one. Otherwise this is a plain update
          // or a fresh add — just write.
          const isMove =
            editingExistingScope !== null &&
            editingExistingScope !== routingScope &&
            editingExistingPattern === pat;

          if (routingScope === "project") {
            const local = loadLocalConfig() ?? {
              version: "1.0.0",
              defaultProfile: "",
              profiles: {},
            };
            if (!local.routing) local.routing = {};
            local.routing[pat] = chainOrder;
            saveLocalConfig(local);
          } else {
            const cfg = loadConfig();
            if (!cfg.routing) cfg.routing = {};
            cfg.routing[pat] = chainOrder;
            saveConfig(cfg);
          }
          if (isMove && editingExistingScope === "global") {
            const cfg = loadConfig();
            if (cfg.routing && cfg.routing[pat] !== undefined) {
              delete cfg.routing[pat];
              saveConfig(cfg);
            }
            setStatusMsg(`Rule moved global → project: ${pat}`);
          } else if (isMove && editingExistingScope === "project") {
            const local = loadLocalConfig();
            if (local?.routing && local.routing[pat] !== undefined) {
              delete local.routing[pat];
              saveLocalConfig(local);
            }
            setStatusMsg(`Rule moved project → global: ${pat}`);
          } else if (routingScope === "project") {
            setStatusMsg(`Project rule saved: ${pat} → ${chainOrder.join(", ")}`);
          } else {
            setStatusMsg(`Global rule saved: ${pat} → ${chainOrder.join(", ")}`);
          }
          refreshConfig();
        }
        setRoutingPattern("");
        setRoutingChain("");
        setChainSelected(new Set());
        setChainOrder([]);
        setChainCursor(0);
        // Reset scope state for the next add cycle.
        setRoutingScope("global");
        setRoutingScopeReturnsToEdit(false);
        setEditingExistingScope(null);
        setEditingExistingPattern(null);
        setMode("browse");
      } else if (key.name === "escape") {
        setChainSelected(new Set());
        setChainOrder([]);
        setChainCursor(0);
        // If we entered the chain builder via `e` on an existing rule, the
        // pattern is fixed — go straight to browse. For fresh adds, fall
        // back to pattern input so the user can fix the pattern.
        if (routingScopeReturnsToEdit) {
          setRoutingPattern("");
          setRoutingScope("global");
          setRoutingScopeReturnsToEdit(false);
          setEditingExistingScope(null);
          setEditingExistingPattern(null);
          setMode("browse");
        } else {
          setMode("add_routing_pattern");
        }
      }
      return;
    }

    // Profile wizard: scope picker (g = global, p = project)
    if (mode === "pick_profile_scope") {
      if (key.raw === "g" || key.raw === "G") {
        wizard.pickScope("global");
      } else if (key.raw === "p" || key.raw === "P") {
        wizard.pickScope("project");
      } else if (key.name === "escape") {
        wizard.cancelPickScope();
      }
      return;
    }

    // Profile wizard: new profile name input
    if (mode === "new_profile") {
      if (key.name === "return" || key.name === "enter") {
        wizard.newProfileSubmit();
      } else if (key.name === "escape") {
        wizard.newProfileEscape();
      } else if (key.name === "backspace" || key.name === "delete") {
        wizard.newProfileBackspace();
      } else if (key.raw && key.raw.length === 1 && !key.ctrl && !key.meta) {
        wizard.newProfileTypeChar(key.raw);
      }
      return;
    }

    // Profile wizard: provider prefix picker (side-trip from edit fields)
    if (mode === "pick_provider_prefix") {
      if (key.name === "up" || key.name === "k") {
        wizard.prefixPickerUp();
      } else if (key.name === "down" || key.name === "j") {
        wizard.prefixPickerDown();
      } else if (key.name === "return" || key.name === "enter") {
        wizard.prefixPickerSubmit();
      } else if (key.name === "escape") {
        wizard.prefixPickerCancel();
      }
      return;
    }

    // Profile wizard: edit model role fields (opus → sonnet → haiku → subagent)
    if (
      mode === "edit_profile_opus" ||
      mode === "edit_profile_sonnet" ||
      mode === "edit_profile_haiku" ||
      mode === "edit_profile_subagent"
    ) {
      if (key.name === "return" || key.name === "enter") {
        wizard.editFieldSubmit();
      } else if (key.name === "tab") {
        wizard.editFieldTab();
      } else if (key.name === "up" || key.name === "k") {
        wizard.editFieldUp();
      } else if (key.name === "down" || key.name === "j") {
        wizard.editFieldDown();
      } else if (key.name === "escape") {
        wizard.editFieldEscape();
      } else if (key.name === "backspace" || key.name === "delete") {
        wizard.editFieldBackspace();
      } else if (key.raw && key.raw.length === 1 && !key.ctrl && !key.meta) {
        wizard.editFieldTypeChar(key.raw);
      }
      return;
    }

    // Browse mode
    if (key.name === "q") return quit();

    if (key.name === "tab") {
      const tabs: Tab[] = ["providers", "profiles", "routing", "privacy"];
      const idx = tabs.indexOf(activeTab);
      setActiveTab(tabs[(idx + 1) % tabs.length]!);
      setStatusMsg(null);
      return;
    }

    // Number keys switch tabs directly
    if (key.name === "1") {
      setActiveTab("providers");
      setStatusMsg(null);
      return;
    }
    if (key.name === "2") {
      setActiveTab("profiles");
      setStatusMsg(null);
      return;
    }
    if (key.name === "3") {
      setActiveTab("routing");
      setStatusMsg(null);
      return;
    }
    if (key.name === "4") {
      setActiveTab("privacy");
      setStatusMsg(null);
      return;
    }

    if (activeTab === "providers") {
      if (key.name === "up" || key.name === "k") {
        setProviderIndex((i) => Math.max(0, i - 1));
        setStatusMsg(null);
      } else if (key.name === "down" || key.name === "j") {
        setProviderIndex((i) => Math.min(displayProviders.length - 1, i + 1));
        setStatusMsg(null);
      } else if (key.name === "s") {
        setInputValue("");
        setStatusMsg(null);
        setMode("input_key");
      } else if (key.name === "e") {
        if (selectedProvider.endpointEnvVar) {
          setInputValue(activeEndpoint);
          setStatusMsg(null);
          setMode("input_endpoint");
        } else {
          setStatusMsg("This provider has no custom endpoint.");
        }
      } else if (key.name === "x") {
        if (hasCfgKey) {
          removeApiKey(selectedProvider.apiKeyEnvVar);
          if (selectedProvider.endpointEnvVar) {
            removeEndpoint(selectedProvider.endpointEnvVar);
          }
          refreshConfig();
          setStatusMsg(`Key removed for ${selectedProvider.displayName}.`);
        } else {
          setStatusMsg("No stored key to remove.");
        }
      } else if (key.name === "t") {
        const apiKey =
          config.apiKeys?.[selectedProvider.apiKeyEnvVar] ||
          process.env[selectedProvider.apiKeyEnvVar];
        const provName = selectedProvider.name;
        if (!apiKey) {
          setTestResults((prev) => ({
            ...prev,
            [provName]: { status: "failed", error: "No key configured" },
          }));
          return;
        }
        setTestResults((prev) => ({ ...prev, [provName]: { status: "testing" } }));
        const startMs = Date.now();
        testProviderKey(provName, apiKey).then((result) => {
          const ms = Date.now() - startMs;
          const ok = result === "valid";
          setTestResults((prev) => ({
            ...prev,
            [provName]: ok ? { status: "valid", ms } : { status: "failed", error: result, ms },
          }));
        });
      }
    } else if (activeTab === "profiles") {
      // Build profile list for navigation
      const globalCfg = loadConfig();
      const localCfg = loadLocalConfig();
      const localNames = localCfg ? Object.keys(localCfg.profiles) : [];
      const globalNames = Object.keys(globalCfg.profiles);
      const allNames = [...new Set([...localNames, ...globalNames])];

      if (key.name === "up" || key.name === "k") {
        setProfileIndex((i) => Math.max(0, i - 1));
        setStatusMsg(null);
      } else if (key.name === "down" || key.name === "j") {
        setProfileIndex((i) => Math.min(Math.max(0, allNames.length - 1), i + 1));
        setStatusMsg(null);
      } else if (key.name === "return" || key.name === "enter" || key.name === "a") {
        // Activate selected profile
        const selectedName = allNames[profileIndex];
        if (selectedName) {
          const cfg = loadConfig();
          cfg.defaultProfile = selectedName;
          saveConfig(cfg);
          refreshConfig();
          setStatusMsg(`Profile "${selectedName}" activated.`);
        }
      } else if (key.name === "n") {
        // New profile — first pick scope (delegates to wizard)
        wizard.startNewProfile();
      } else if (key.name === "e") {
        // Edit selected profile's model mappings (delegates to wizard)
        const selectedName = allNames[profileIndex];
        if (selectedName) {
          const isLocal = localCfg ? !!localCfg.profiles[selectedName] : false;
          wizard.startEditExisting(selectedName, isLocal);
        }
      } else if (key.name === "d") {
        // Delete selected profile (can't delete active one)
        const selectedName = allNames[profileIndex];
        const cfg = loadConfig();
        if (!selectedName) {
          setStatusMsg("No profile selected.");
        } else if (selectedName === cfg.defaultProfile) {
          setStatusMsg("Cannot delete the active profile.");
        } else {
          // Check if it's a local profile
          const localCfgCheck = loadLocalConfig();
          if (localCfgCheck?.profiles[selectedName]) {
            delete localCfgCheck.profiles[selectedName];
            saveLocalConfig(localCfgCheck);
            refreshConfig();
            setProfileIndex((i) => Math.max(0, i - 1));
            setStatusMsg(`Project profile "${selectedName}" deleted.`);
          } else if (Object.keys(cfg.profiles).length <= 1) {
            setStatusMsg("Cannot delete the last global profile.");
          } else if (cfg.profiles[selectedName]) {
            delete cfg.profiles[selectedName];
            saveConfig(cfg);
            refreshConfig();
            setProfileIndex((i) => Math.max(0, i - 1));
            setStatusMsg(`Profile "${selectedName}" deleted.`);
          } else {
            setStatusMsg("Profile not found.");
          }
        }
      }
    } else if (activeTab === "routing") {
      if (key.name === "a") {
        setRoutingPattern("");
        setRoutingChain("");
        setChainSelected(new Set());
        setChainOrder([]);
        setStatusMsg(null);
        setMode("add_routing_pattern");
      } else if (key.name === "e") {
        // Edit selected rule. ALWAYS opens the scope picker so the user can
        // either confirm the current scope (and proceed to chain edit) or
        // move the rule to the other scope (effectively a single-keystroke
        // promote/demote). The picker is prefilled with the rule's current
        // scope as the suggested choice.
        //
        // For `default` rows, there's no current scope — the picker just
        // asks the user to choose where to write the new override.
        if (mergedRules.length === 0) {
          setStatusMsg("No rules to edit.");
        } else {
          const idx = Math.min(providerIndex, mergedRules.length - 1);
          const rule = mergedRules[idx]!;
          setRoutingPattern(rule.pattern);
          setChainSelected(new Set(rule.chain));
          setChainOrder([...rule.chain]);
          setChainCursor(0);
          setStatusMsg(null);
          // Default scope to the rule's current scope (or "global" for defaults
          // — matches the typical case where users write personal overrides).
          const initialScope: RoutingScope = rule.kind === "project" ? "project" : "global";
          setRoutingScope(initialScope);
          setRoutingScopeCursor(initialScope === "global" ? 0 : 1);
          setEditingExistingScope(rule.kind === "default" ? null : rule.kind);
          setEditingExistingPattern(rule.pattern);
          setRoutingScopeReturnsToEdit(true);
          setMode("pick_routing_scope");
        }
      } else if (key.name === "d") {
        // No more peel: each row owns its scope. Delete from that scope only.
        if (mergedRules.length === 0) {
          setStatusMsg("No rules to delete.");
        } else {
          const idx = Math.min(providerIndex, mergedRules.length - 1);
          const rule = mergedRules[idx]!;
          if (rule.kind === "default") {
            setStatusMsg(
              `Built-in default '${rule.pattern}' cannot be deleted. Press e to override.`
            );
          } else if (rule.kind === "project") {
            const local = loadLocalConfig();
            if (local?.routing && local.routing[rule.pattern] !== undefined) {
              delete local.routing[rule.pattern];
              saveLocalConfig(local);
              refreshConfig();
              setStatusMsg(`Project rule deleted: '${rule.pattern}'.`);
            }
          } else {
            // rule.kind === "global"
            const cfg = loadConfig();
            if (cfg.routing && cfg.routing[rule.pattern] !== undefined) {
              delete cfg.routing[rule.pattern];
              saveConfig(cfg);
              refreshConfig();
              setStatusMsg(`Global rule deleted: '${rule.pattern}'.`);
            }
          }
        }
      } else if (key.name === "up" || key.name === "k") {
        setProviderIndex((i) => Math.max(0, i - 1));
      } else if (key.name === "down" || key.name === "j") {
        setProviderIndex((i) => Math.min(Math.max(0, mergedRules.length - 1), i + 1));
      } else if (key.name === "p") {
        setStatusMsg(null);
        probe.startInput();
      }
    } else if (activeTab === "privacy") {
      if (key.name === "t") {
        const cfg = loadConfig();
        const next = !telemetryEnabled;
        cfg.telemetry = {
          ...(cfg.telemetry ?? {}),
          enabled: next,
          askedAt: cfg.telemetry?.askedAt ?? new Date().toISOString(),
        };
        saveConfig(cfg);
        refreshConfig();
        setStatusMsg(`Telemetry ${next ? "enabled" : "disabled"}.`);
      } else if (key.name === "u") {
        const cfg = loadConfig();
        const statsKey = "CLAUDISH_STATS";
        // Toggle via config (env cannot be persisted, use telemetry-like flag)
        const next = !statsEnabled;
        if (!cfg.telemetry)
          cfg.telemetry = { enabled: telemetryEnabled, askedAt: new Date().toISOString() };
        (cfg as Record<string, unknown>).statsEnabled = next;
        saveConfig(cfg);
        refreshConfig();
        setStatusMsg(`Usage stats ${next ? "enabled" : "disabled"}.`);
        void statsKey; // used for env check
      } else if (key.name === "c") {
        clearBuffer();
        setBufStats(getBufferStats());
        setStatusMsg("Stats buffer cleared.");
      }
    }
  });

  if (height < 15 || width < 60) {
    return (
      <box width="100%" height="100%" padding={1} backgroundColor={C.bg}>
        <text>
          <span fg={C.red} bold>
            Terminal too small ({width}x{height}). Resize to at least 60x15.
          </span>
        </text>
      </box>
    );
  }

  const isInputMode = mode === "input_key" || mode === "input_endpoint";
  const isRoutingInput =
    mode === "add_routing_pattern" ||
    mode === "add_routing_chain" ||
    mode === "pick_routing_scope";

  // ── Layout math ───────────────────────────────────────────────────────────
  // header(1) + tab-bar(3) + content(flex) + detail(fixed) + footer(1)
  const contentH = Math.max(4, height - HEADER_H - TABS_H - DETAIL_H - FOOTER_H - 1);

  // ── Main render ───────────────────────────────────────────────────────────
  return (
    <box width={width} height={height} flexDirection="column" backgroundColor={C.bg}>
      {/* Header */}
      <box height={HEADER_H} flexDirection="row" backgroundColor={C.bgAlt} paddingX={1}>
        <text>
          <span fg={C.white} bold>
            claudish
          </span>
          <span fg={C.dim}> ─ </span>
          <span fg={C.blue} bold>
            {VERSION}
          </span>
          <span fg={C.dim}> ─ </span>
          <span fg={C.orange} bold>
            ★ {profileName}
          </span>
          <span fg={C.dim}> ─ </span>
          <span fg={C.green} bold>
            {readyCount}
          </span>
          <span fg={C.fgMuted}> providers configured</span>
          <span fg={C.dim}>
            {"─".repeat(Math.max(1, width - 38 - profileName.length - VERSION.length))}
          </span>
        </text>
      </box>

      {/* Tab bar */}
      <TabBar activeTab={activeTab} statusMsg={statusMsg} width={width} />

      {/* Content + detail */}
      {activeTab === "providers" && (
        <>
          <ProvidersContent
            config={config}
            displayProviders={displayProviders}
            providerIndex={providerIndex}
            testResults={testResults}
            width={width}
            contentH={contentH}
            isInputMode={isInputMode}
          />
          <ProviderDetail
            selectedProvider={selectedProvider}
            mode={mode}
            inputValue={inputValue}
            setInputValue={setInputValue}
            width={width}
            hasCfgKey={hasCfgKey}
            hasEnvKey={hasEnvKey}
            hasKey={hasKey}
            cfgKeyMask={cfgKeyMask}
            envKeyMask={envKeyMask}
            keySrc={keySrc}
            activeEndpoint={activeEndpoint}
            testResults={testResults}
            isInputMode={isInputMode}
          />
        </>
      )}
      {activeTab === "profiles" && (
        <>
          <ProfilesContent
            config={config}
            activeTab={activeTab}
            mode={mode}
            profileScope={profileScope}
            profileIndex={profileIndex}
            editProfileName={editProfileName}
            editProfileValue={editProfileValue}
            suggestions={suggestions}
            suggestionIndex={suggestionIndex}
            providerPickerIndex={providerPickerIndex}
            width={width}
            contentH={contentH}
          />
          <ProfileDetail config={config} profileIndex={profileIndex} />
        </>
      )}
      {activeTab === "routing" && (
        <>
          <RoutingContent
            config={config}
            probeMode={probeMode}
            probeModel={probeModel}
            probeResults={probeResults}
            mode={mode}
            routingPattern={routingPattern}
            chainSelected={chainSelected}
            chainOrder={chainOrder}
            chainCursor={chainCursor}
            // NOTE: `providerIndex` is shared with the Providers tab here. See
            // "Known wart" in ai-docs/app-tsx-split/walkthrough.md — switching
            // tabs preserves the cursor across two unrelated lists.
            providerIndex={providerIndex}
            mergedRules={mergedRules}
            width={width}
            contentH={contentH}
            isRoutingInput={isRoutingInput}
            editingExistingScope={editingExistingScope}
            routingScopeCursor={routingScopeCursor}
          />
          <RoutingDetail probeMode={probeMode} mergedRules={mergedRules} />
        </>
      )}
      {activeTab === "privacy" && (
        <>
          <PrivacyContent
            activeTab={activeTab}
            telemetryEnabled={telemetryEnabled}
            statsEnabled={statsEnabled}
            bufStats={bufStats}
            width={width}
            contentH={contentH}
          />
          <PrivacyDetail />
        </>
      )}

      {/* Footer */}
      <Footer activeTab={activeTab} mode={mode} probeMode={probeMode} />
    </box>
  );
}
