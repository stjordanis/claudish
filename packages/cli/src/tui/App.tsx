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
import { clearBuffer, getBufferStats } from "../stats-buffer.js";
import { testProviderKey } from "./test-provider.js";
import { PROVIDERS, maskKey } from "./providers.js";
import { C } from "./theme.js";
import {
  COMMON_MODELS,
  PROVIDER_PREFIXES,
  CHAIN_PROVIDERS,
  HEADER_H,
  TABS_H,
  FOOTER_H,
  DETAIL_H,
  VERSION,
} from "./constants.js";
import type { Mode, Tab, TestResultsMap } from "./types.js";
import { useRouteProbe } from "./hooks/useRouteProbe.js";
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
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<TestResultsMap>({});

  // Profile tab state
  const [profileIndex, setProfileIndex] = useState(0);
  const [editProfileName, setEditProfileName] = useState("");
  const [editProfileValue, setEditProfileValue] = useState("");
  const [profileScope, setProfileScope] = useState<"global" | "project">("global");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggestionIndex, setSuggestionIndex] = useState(-1);
  const [providerPickerIndex, setProviderPickerIndex] = useState(0);
  const [providerPickerReturnMode, setProviderPickerReturnMode] =
    useState<Mode>("edit_profile_opus");

  // Compute autocomplete suggestions for model input
  const computeSuggestions = useCallback((input: string): string[] => {
    if (!input) return COMMON_MODELS.slice(0, 8);
    const lower = input.toLowerCase();
    return COMMON_MODELS.filter((m) => m.toLowerCase().includes(lower)).slice(0, 8);
  }, []);

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

  const ruleEntries = Object.entries(config.routing ?? {});
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
          setMode("add_routing_chain");
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
          const cfg = loadConfig();
          if (!cfg.routing) cfg.routing = {};
          cfg.routing[pat] = chainOrder;
          saveConfig(cfg);
          refreshConfig();
          setStatusMsg(`Rule added: ${pat} → ${chainOrder.join(", ")}`);
        }
        setRoutingPattern("");
        setRoutingChain("");
        setChainSelected(new Set());
        setChainOrder([]);
        setChainCursor(0);
        setMode("browse");
      } else if (key.name === "escape") {
        setChainSelected(new Set());
        setChainOrder([]);
        setChainCursor(0);
        setMode("add_routing_pattern");
      }
      return;
    }

    // Profile: scope picker (g = global, p = project)
    if (mode === "pick_profile_scope") {
      if (key.raw === "g" || key.raw === "G") {
        setProfileScope("global");
        setEditProfileValue("");
        setMode("new_profile");
      } else if (key.raw === "p" || key.raw === "P") {
        setProfileScope("project");
        setEditProfileValue("");
        setMode("new_profile");
      } else if (key.name === "escape") {
        setMode("browse");
      }
      return;
    }

    // Profile: new profile name input
    if (mode === "new_profile") {
      if (key.name === "return" || key.name === "enter") {
        const name = editProfileValue.trim();
        if (!name) {
          setMode("browse");
          setEditProfileValue("");
          return;
        }
        const now = new Date().toISOString();
        if (profileScope === "project") {
          // Save to local .claudish.json
          const localCfg = loadLocalConfig() ?? {
            version: "1.0.0",
            defaultProfile: "",
            profiles: {},
          };
          localCfg.profiles[name] = { name, models: {}, createdAt: now, updatedAt: now };
          saveLocalConfig(localCfg);
        } else {
          // Save to global config
          const cfg = loadConfig();
          cfg.profiles[name] = { name, models: {}, createdAt: now, updatedAt: now };
          saveConfig(cfg);
        }
        refreshConfig();
        setEditProfileName(name);
        setEditProfileValue("");
        setSuggestions(computeSuggestions(""));
        setSuggestionIndex(-1);
        setMode("edit_profile_opus");
      } else if (key.name === "escape") {
        setEditProfileValue("");
        setMode("browse");
      } else if (key.name === "backspace" || key.name === "delete") {
        setEditProfileValue((p) => p.slice(0, -1));
      } else if (key.raw && key.raw.length === 1 && !key.ctrl && !key.meta) {
        setEditProfileValue((p) => p + key.raw);
      }
      return;
    }

    // Profile: provider prefix picker
    if (mode === "pick_provider_prefix") {
      if (key.name === "up" || key.name === "k") {
        setProviderPickerIndex((i) => Math.max(0, i - 1));
      } else if (key.name === "down" || key.name === "j") {
        setProviderPickerIndex((i) => Math.min(PROVIDER_PREFIXES.length - 1, i + 1));
      } else if (key.name === "return" || key.name === "enter") {
        const prefix = PROVIDER_PREFIXES[providerPickerIndex]?.prefix ?? "";
        setEditProfileValue(prefix);
        setSuggestions(computeSuggestions(prefix));
        setSuggestionIndex(-1);
        setProviderPickerIndex(0);
        setMode(providerPickerReturnMode);
      } else if (key.name === "escape") {
        setProviderPickerIndex(0);
        setMode(providerPickerReturnMode);
      }
      return;
    }

    // Profile: edit model role fields (opus → sonnet → haiku → subagent)
    if (
      mode === "edit_profile_opus" ||
      mode === "edit_profile_sonnet" ||
      mode === "edit_profile_haiku" ||
      mode === "edit_profile_subagent"
    ) {
      // Helper: save value to correct scope config
      const saveModelField = (fieldVal: string) => {
        const val = fieldVal.trim() === "auto" ? undefined : fieldVal.trim();
        if (profileScope === "project") {
          const localCfg = loadLocalConfig() ?? {
            version: "1.0.0",
            defaultProfile: "",
            profiles: {},
          };
          const prof = localCfg.profiles[editProfileName];
          if (prof) {
            if (mode === "edit_profile_opus") prof.models.opus = val || undefined;
            else if (mode === "edit_profile_sonnet") prof.models.sonnet = val || undefined;
            else if (mode === "edit_profile_haiku") prof.models.haiku = val || undefined;
            else if (mode === "edit_profile_subagent") prof.models.subagent = val || undefined;
            prof.updatedAt = new Date().toISOString();
            saveLocalConfig(localCfg);
          }
        } else {
          const cfg = loadConfig();
          const prof = cfg.profiles[editProfileName];
          if (prof) {
            if (mode === "edit_profile_opus") prof.models.opus = val || undefined;
            else if (mode === "edit_profile_sonnet") prof.models.sonnet = val || undefined;
            else if (mode === "edit_profile_haiku") prof.models.haiku = val || undefined;
            else if (mode === "edit_profile_subagent") prof.models.subagent = val || undefined;
            prof.updatedAt = new Date().toISOString();
            saveConfig(cfg);
          }
        }
        refreshConfig();
      };

      const getNextFieldValue = (nextMode: Mode): string => {
        if (profileScope === "project") {
          const localCfg = loadLocalConfig();
          const prof = localCfg?.profiles[editProfileName];
          if (nextMode === "edit_profile_sonnet") return prof?.models?.sonnet ?? "";
          if (nextMode === "edit_profile_haiku") return prof?.models?.haiku ?? "";
          if (nextMode === "edit_profile_subagent") return prof?.models?.subagent ?? "";
        } else {
          const cfg = loadConfig();
          const prof = cfg.profiles[editProfileName];
          if (nextMode === "edit_profile_sonnet") return prof?.models?.sonnet ?? "";
          if (nextMode === "edit_profile_haiku") return prof?.models?.haiku ?? "";
          if (nextMode === "edit_profile_subagent") return prof?.models?.subagent ?? "";
        }
        return "";
      };

      if (key.name === "return" || key.name === "enter") {
        // Accept highlighted suggestion or typed value
        let val = editProfileValue;
        if (suggestionIndex >= 0 && suggestions[suggestionIndex]) {
          val = suggestions[suggestionIndex];
        }
        saveModelField(val);
        setSuggestions([]);
        setSuggestionIndex(-1);
        // Advance to next field or finish
        if (mode === "edit_profile_opus") {
          const nextVal = getNextFieldValue("edit_profile_sonnet");
          setEditProfileValue(nextVal);
          setSuggestions(computeSuggestions(nextVal));
          setSuggestionIndex(-1);
          setMode("edit_profile_sonnet");
        } else if (mode === "edit_profile_sonnet") {
          const nextVal = getNextFieldValue("edit_profile_haiku");
          setEditProfileValue(nextVal);
          setSuggestions(computeSuggestions(nextVal));
          setSuggestionIndex(-1);
          setMode("edit_profile_haiku");
        } else if (mode === "edit_profile_haiku") {
          const nextVal = getNextFieldValue("edit_profile_subagent");
          setEditProfileValue(nextVal);
          setSuggestions(computeSuggestions(nextVal));
          setSuggestionIndex(-1);
          setMode("edit_profile_subagent");
        } else {
          // subagent — done
          setEditProfileValue("");
          setEditProfileName("");
          setSuggestions([]);
          setSuggestionIndex(-1);
          setMode("browse");
          setStatusMsg(`Profile "${editProfileName}" saved.`);
        }
      } else if (key.name === "tab") {
        if (editProfileValue === "") {
          // Empty input + Tab → enter provider prefix picker
          setProviderPickerReturnMode(mode);
          setProviderPickerIndex(0);
          setMode("pick_provider_prefix");
        } else if (suggestionIndex >= 0 && suggestions[suggestionIndex]) {
          // Tab with suggestion highlighted → autocomplete into input, keep editing
          setEditProfileValue(suggestions[suggestionIndex]);
          setSuggestions(computeSuggestions(suggestions[suggestionIndex]!));
          setSuggestionIndex(-1);
        }
      } else if (key.name === "up" || key.name === "k") {
        if (suggestions.length > 0) {
          setSuggestionIndex((i) => Math.max(0, i - 1));
        }
      } else if (key.name === "down" || key.name === "j") {
        if (suggestions.length > 0) {
          setSuggestionIndex((i) => Math.min(suggestions.length - 1, i + 1));
        }
      } else if (key.name === "escape") {
        if (suggestionIndex >= 0) {
          // Esc dismisses suggestion selection first
          setSuggestionIndex(-1);
        } else {
          setEditProfileValue("");
          setEditProfileName("");
          setSuggestions([]);
          setSuggestionIndex(-1);
          setMode("browse");
        }
      } else if (key.name === "backspace" || key.name === "delete") {
        setEditProfileValue((p) => {
          const next = p.slice(0, -1);
          setSuggestions(computeSuggestions(next));
          setSuggestionIndex(-1);
          return next;
        });
      } else if (key.raw && key.raw.length === 1 && !key.ctrl && !key.meta) {
        setEditProfileValue((p) => {
          const next = p + key.raw;
          // Handle 'auto' shortcut with empty input + 'a'
          if (p === "" && key.raw === "a") {
            setSuggestions([]);
            setSuggestionIndex(-1);
            return "auto";
          }
          setSuggestions(computeSuggestions(next));
          setSuggestionIndex(-1);
          return next;
        });
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
        // New profile — first pick scope
        setEditProfileValue("");
        setProfileScope("global");
        setMode("pick_profile_scope");
        setStatusMsg(null);
      } else if (key.name === "e") {
        // Edit selected profile's model mappings
        const selectedName = allNames[profileIndex];
        if (selectedName) {
          // Determine which scope the selected profile is in
          const isLocal = localCfg ? !!localCfg.profiles[selectedName] : false;
          const scope: "global" | "project" = isLocal ? "project" : "global";
          setProfileScope(scope);
          const prof = isLocal
            ? localCfg?.profiles[selectedName]
            : loadConfig().profiles[selectedName];
          setEditProfileName(selectedName);
          const opusVal = prof?.models?.opus ?? "";
          setEditProfileValue(opusVal);
          setSuggestions(computeSuggestions(opusVal));
          setSuggestionIndex(-1);
          setMode("edit_profile_opus");
          setStatusMsg(null);
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
        setStatusMsg(null);
        setMode("add_routing_pattern");
      } else if (key.name === "d") {
        // delete selected rule — select by index
        if (ruleEntries.length > 0) {
          const [pat] = ruleEntries[Math.min(providerIndex, ruleEntries.length - 1)]!;
          const cfg = loadConfig();
          if (cfg.routing) {
            delete cfg.routing[pat];
            saveConfig(cfg);
            refreshConfig();
            setStatusMsg(`Rule deleted: '${pat}'.`);
          }
        } else {
          setStatusMsg("No routing rules to delete.");
        }
      } else if (key.name === "up" || key.name === "k") {
        setProviderIndex((i) => Math.max(0, i - 1));
      } else if (key.name === "down" || key.name === "j") {
        setProviderIndex((i) => Math.min(Math.max(0, ruleEntries.length - 1), i + 1));
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
  const isRoutingInput = mode === "add_routing_pattern" || mode === "add_routing_chain";

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
            ruleEntries={ruleEntries}
            width={width}
            contentH={contentH}
            isRoutingInput={isRoutingInput}
          />
          <RoutingDetail probeMode={probeMode} ruleEntries={ruleEntries} />
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
