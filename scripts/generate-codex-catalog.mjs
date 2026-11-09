import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

// Runtime instruction templates stay in the user's local generated catalog.
// The tracked catalog contains capability metadata only.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cachePath = process.argv[2] ? resolve(process.argv[2]) : join(homedir(), ".codex", "models_cache.json");
const policy = JSON.parse(readFileSync(join(root, "models.json"), "utf8"));
const cache = JSON.parse(readFileSync(cachePath, "utf8"));
if (!Array.isArray(cache.models)) throw new Error("Codex cache must contain a models array");
const byId = new Map(cache.models.map((model) => [model.slug, model]));
const models = policy.models.map((metadata) => {
  const id = metadata.slug === "jev-router" ? "gpt-6.1-sol" : metadata.slug;
  const cached = byId.get(id);
  if (!cached) throw new Error(`Codex cache lacks ${id}; refresh it using the authenticated Codex CLI`);
  const card = structuredClone(cached);
  if (metadata.slug === "jev-router") {
    card.slug = metadata.slug;
    card.display_name = metadata.display_name;
    card.description = metadata.description;
    card.visibility = metadata.visibility;
  }
  return card;
});
const output = join(root, "codex-model-catalog.json");
const temporary = join(root, `.codex-model-catalog-${randomUUID()}.tmp`);
try {
  writeFileSync(temporary, JSON.stringify({ models }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  renameSync(temporary, output);
} finally {
  try { unlinkSync(temporary); } catch (err) { if (err.code !== "ENOENT") throw err; }
}
console.log(`Generated a private local Codex catalog with ${models.length} allowed entries.`);
