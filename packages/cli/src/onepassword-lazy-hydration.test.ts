import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// REGRESSION: claudish --version triggered 1Password resolution because hydrateOpSecrets ran before parseArgs. Fixed by moving hydration to the point of need (before key validation).
//
// This is a STRUCTURAL ordering test. The full CLI can't be driven in a unit
// test (it spawns Claude, exits the process inside parseArgs, etc.), and the
// real bug is purely about call ORDER inside runCli(): hydrateOpSecrets() must
// NOT run before parseArgs(), because parseArgs handles --version/--help/--init/
// --probe/--list-models and process.exit(0)s before any provider key is needed.

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexSource = readFileSync(join(__dirname, "index.ts"), "utf-8");

/**
 * Extract the body of the runCli function via brace matching, starting at the
 * `async function runCli()` declaration.
 */
function extractRunCliBody(source: string): string {
  const declIdx = source.indexOf("async function runCli()");
  expect(declIdx).toBeGreaterThanOrEqual(0);

  // Find the opening brace of the function body.
  const openBraceIdx = source.indexOf("{", declIdx);
  expect(openBraceIdx).toBeGreaterThanOrEqual(0);

  let depth = 0;
  for (let i = openBraceIdx; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(openBraceIdx, i + 1);
      }
    }
  }
  throw new Error("Could not find matching close brace for runCli()");
}

describe("1Password lazy hydration ordering", () => {
  const runCliBody = extractRunCliBody(indexSource);

  it("calls hydrateOpSecrets() AFTER parseArgs() inside runCli (not before)", () => {
    const parseArgsIdx = runCliBody.indexOf("await parseArgs(");
    expect(parseArgsIdx).toBeGreaterThanOrEqual(0);

    const firstHydrateIdx = runCliBody.indexOf("hydrateOpSecrets()");
    expect(firstHydrateIdx).toBeGreaterThanOrEqual(0);

    // The FIRST hydrateOpSecrets() call inside runCli must occur AFTER
    // parseArgs() so that terminal flags (--version/--help/--init/--probe/
    // --list-models) exit the process before any 1Password resolution.
    expect(firstHydrateIdx).toBeGreaterThan(parseArgsIdx);
  });

  it("still calls hydrateOpSecrets() somewhere in runCli (hydration not dropped)", () => {
    expect(runCliBody).toContain("hydrateOpSecrets()");
  });
});
