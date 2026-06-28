// E2E probe (manual, not part of `bun test`): does `claudish --mcp` boot cleanly
// under the async credential layer — WITHOUT pre-hydrating 1Password at startup,
// and WITHOUT dying on a multi-account ambiguity?
//
// Run:  bun packages/cli/src/scratch-mcp-op-probe.ts
//
// What it checks:
//   1. The MCP server starts (initialize + tools/list respond) — i.e. the server
//      did NOT process.exit at boot. Under the OLD design a multi-account op user
//      with no saved account would have died here; now op auth is lazy + soft-fail.
//   2. No 1Password SDK auth prompt blocks boot (op:// is resolved on demand only
//      when a tool routes a model whose key is missing — not at startup).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = join(__dirname, "index.ts");

const proc = spawn("bun", [entry, "--mcp"], {
  env: { ...process.env },
  stdio: ["pipe", "pipe", "pipe"],
});

let stdoutBuf = "";
let stderrBuf = "";
proc.stdout.on("data", (d) => (stdoutBuf += d.toString()));
proc.stderr.on("data", (d) => (stderrBuf += d.toString()));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await sleep(3000); // allow boot (should be fast — no startup op hydration)
  proc.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "op-probe", version: "0.0.0" },
      },
    }) + "\n"
  );
  await sleep(2000);
  proc.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n"
  );
  await sleep(2000);

  const exited = proc.exitCode !== null;
  proc.kill("SIGTERM");

  console.log("=== EXIT STATE ===");
  console.log(
    "child exitCode:",
    proc.exitCode,
    exited ? "(EXITED before responses — BAD)" : "(still running — GOOD)"
  );

  console.log("\n=== STDERR (startup / 1Password logs) ===");
  console.log(stderrBuf.trim() || "(empty)");

  console.log("\n=== STDOUT (JSON-RPC) ===");
  let sawInit = false;
  let toolCount = 0;
  for (const line of stdoutBuf.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (obj.id === 1) {
        sawInit = true;
        console.log(`init → serverInfo=${JSON.stringify(obj.result?.serverInfo)} ✓`);
      } else if (obj.id === 2 && obj.result?.tools) {
        toolCount = obj.result.tools.length;
        console.log(`tools/list → ${toolCount} tools ✓`);
      }
    } catch {
      // dotenv / non-JSON noise
    }
  }

  console.log("\n=== VERDICT ===");
  if (/1Password authentication failed/.test(stderrBuf)) {
    console.log("❌ Auth hard-failed at startup — should be soft (server should boot).");
  } else if (exited && !sawInit) {
    console.log("❌ Server exited before responding.");
  } else if (sawInit && toolCount > 0) {
    console.log(
      "✓ MCP server booted cleanly with no startup 1Password hydration; keys resolve on demand."
    );
  } else {
    console.log("? Inconclusive — inspect output above.");
  }
})();
