/**
 * `claudish --op <glob>` preview mode — the 1Password CLI surface.
 *
 * PREVIEW (`claudish --op <op://glob> --list`): list what a glob WOULD import.
 * For each field that matches the section/field glob, the env var name it would
 * become, marking trimmed and skipped/invalid ones. NAMES ONLY — this NEVER
 * prints, resolves, or otherwise touches secret VALUES. It's read-only discovery
 * via the SDK (`items.get`), nothing is written.
 *
 * The non-preview path of `--op` (hydrate env vars then continue into the normal
 * dispatch) lives in index.ts's `applyOpImport()` — it calls `resolveGlobImport`
 * directly, so there's no inline-run entry point here anymore.
 *
 * Preview example:
 *   $ claudish --op "op://Jack/AI LLM models API keys 10xlabs/*\/*_API_KEY" --list
 *   Preview: op://Jack/AI LLM models API keys 10xlabs/*\/*_API_KEY
 *     OPENROUTER_API_KEY      ✓  (section: Open router)
 *     XAI_API_KEY             ✓  (section: XAI_API_KEY)
 *     GEMINI_API_KEY          ✓  (trimmed from 'GEMINI_API_KEY ')
 *     Customer Key            ✗  skipped (not a valid env var name)
 *   9 importable, 3 skipped
 */

import {
  discoverItemFields,
  filterGlobFields,
  isGlobImport,
  parseGlobImport,
  type SdkAuth,
} from "./providers/onepassword.js";

const USAGE =
  "Usage:\n" +
  "  claudish --op <op://vault/item/[section]/field-glob>\n" +
  "      Load API keys from a 1Password item glob, then run normally.\n" +
  "  claudish --op <op://vault/item/[section]/field-glob> --list\n" +
  "      Preview which fields the glob would import (names only, no values).\n" +
  "  Examples:\n" +
  "    claudish --op 'op://Jack/My Item/*/*_API_KEY' --list\n" +
  "    claudish --op 'op://Jack/My Item/*/*_API_KEY' --model gpt-4o 'task'";

/**
 * Preview command entry point. Prints a table of matching fields and their
 * resulting env var names. Exits non-zero on usage/discovery errors.
 *
 * (Renamed from `onepasswordFieldsCommand`. Behavior is identical — names only,
 * trim/skip-invalid, the ✓/✗ table.)
 */
export async function opPreviewCommand(
  globPath: string | undefined,
  opts: { auth?: SdkAuth } = {}
): Promise<void> {
  const path = (globPath ?? "").trim();
  if (path === "") {
    console.error("[claudish] `--op ... --list` requires an op:// path.\n");
    console.error(USAGE);
    process.exit(1);
  }
  if (!path.startsWith("op://")) {
    console.error(`[claudish] '${path}' is not an op:// path.\n`);
    console.error(USAGE);
    process.exit(1);
  }
  if (!isGlobImport(path)) {
    console.error(
      `[claudish] '${path}' is not a glob import (no '*' in the field/section ` +
        "segment). This command previews glob imports; a single op:// reference " +
        "resolves directly when used as a config value.\n"
    );
    console.error(USAGE);
    process.exit(1);
  }

  const glob = parseGlobImport(path);

  let fields;
  try {
    fields = await discoverItemFields(glob.vault, glob.item, { auth: opts.auth });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[claudish] 1Password discovery failed: ${message}`);
    process.exit(1);
  }

  const matches = filterGlobFields(fields, glob);

  console.log(`Preview: ${path}`);

  if (matches.length === 0) {
    console.log("  (no fields match this glob)");
    const available = fields
      .map((f) => f.label.trim())
      .filter((l) => l !== "")
      .slice(0, 8);
    console.log(`  Available field labels include: ${available.join(", ") || "(none)"}`);
    console.log("0 importable, 0 skipped");
    return;
  }

  // Column width for the name, capped so a stray long label doesn't blow it up.
  const NAME_COL = Math.min(30, Math.max(...matches.map((m) => m.envName.length), 0));

  let importable = 0;
  let skipped = 0;
  for (const m of matches) {
    const name = m.envName.padEnd(NAME_COL);
    if (!m.valid) {
      skipped++;
      console.log(`  ${name}  ✗  skipped (not a valid env var name)`);
      continue;
    }
    importable++;
    const trimmed = m.field.label !== m.envName;
    const detail = trimmed
      ? `(trimmed from '${m.field.label}')`
      : m.field.section
        ? `(section: ${m.field.section})`
        : "(top-level field)";
    console.log(`  ${name}  ✓  ${detail}`);
  }

  console.log(`${importable} importable, ${skipped} skipped`);
}
