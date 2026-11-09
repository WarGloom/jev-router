import { spawn } from "node:child_process";
import { accessSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CODEX_AUTO_MODEL, startCodexProxy } from "./codex-proxy.mjs";
import { codexEnvironment, readJevApiKey, readLocalConfig } from "./local-config.mjs";

const PROVIDER = "jev";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXPLAIN_SKILL = join(ROOT, "skills", "codex", "jev-explain", "SKILL.md");

export function installCodexSkill(home = homedir()) {
  const target = join(home, ".agents", "skills", "jev-router-explain", "SKILL.md");
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target)) {
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()
        || readFileSync(target, "utf8") !== readFileSync(EXPLAIN_SKILL, "utf8")) {
      throw new Error("Existing explanation skill differs; preserving it");
    }
    return target;
  }
  copyFileSync(EXPLAIN_SKILL, target, constants.COPYFILE_EXCL);
  return target;
}

export function loadEnv() {
  // Configuration names a key file; it never imports project dotenv variables.
  return readLocalConfig();
}

export function explicitEffort(args) {
  let effort = null;
  for (let index = 0; index < args.length; index++) {
    const value = ["-c", "--config"].includes(args[index]) ? args[index + 1]
      : args[index].startsWith("--config=") ? args[index].slice(9) : null;
    const match = value?.match(/^model_reasoning_effort\s*=\s*(?:"([a-z]+)"|'([a-z]+)'|([a-z]+))\s*$/);
    if (match) effort = match[1] ?? match[2] ?? match[3];
  }
  return effort;
}

export function resolveCodex() {
  const win = process.platform === "win32";
  const exts = win ? [".exe", ".ps1", ".cmd", ".bat"] : [""];
  for (const dir of (process.env.PATH ?? "").split(win ? ";" : ":")) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = join(dir.replace(/^"|"$/g, ""), `codex${ext}`);
      try {
        accessSync(file, constants.F_OK);
        if (/\.ps1$/i.test(file)) {
          return { file: "powershell.exe", prefix: ["-NoProfile", "-File", file], shell: false };
        }
        return { file, prefix: [], shell: /\.(cmd|bat)$/i.test(file) };
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return null;
}

export const codexArgs = (baseURL, args) => [
  ...(args.some((arg) => arg === "--model" || arg === "-m" || arg.startsWith("--model="))
    ? []
    : ["--model", CODEX_AUTO_MODEL]),
  "--config",
  `model_provider="${PROVIDER}"`,
  "--config",
  `model_providers.${PROVIDER}.name="Jev Router"`,
  "--config",
  `model_providers.${PROVIDER}.base_url="${baseURL}"`,
  "--config",
  `model_providers.${PROVIDER}.wire_api="responses"`,
  "--config",
  `model_providers.${PROVIDER}.requires_openai_auth=true`,
  "--config",
  `model_providers.${PROVIDER}.supports_websockets=false`,
  "--config",
  `model_providers.${PROVIDER}.env_http_headers.X-Jev-Session="JEV_ROUTER_SESSION_TOKEN"`,
  "--config",
  `model_catalog_json=${JSON.stringify(join(ROOT, "codex-model-catalog.json"))}`,
  ...args,
];

// Loads configuration, starts the optional routing proxy, and launches the Codex CLI.
export async function runCodex() {
  const command = resolveCodex();
  if (!command) {
    process.stderr.write(
      "[jev] OpenAI Codex is not installed, or `codex` is not on your PATH.\n" +
        "[jev] jev-codex runs the real Codex CLI; install it first:\n" +
        "[jev]   https://developers.openai.com/codex/cli\n",
    );
    process.exitCode = 1;
    return;
  }

  let args = process.argv.slice(2);
  const informational = args.length === 1 && ["--help", "-h", "help", "--version", "-V"].includes(args[0]);
  for (let i = 0; i < args.length; i++) {
    const value = ["-m", "--model"].includes(args[i]) ? args[i + 1]
      : args[i].startsWith("--model=") ? args[i].slice(8)
      : ["-c", "--config"].includes(args[i]) && /^model\s*=/.test(args[i + 1] ?? "") ? args[i + 1] : "";
    if (/astra/i.test(value ?? "")) {
      process.stderr.write("[jev] Astra is disabled in jev-codex.\n");
      process.exitCode = 2;
      return;
    }
  }
  let close = () => {};
  const statusId = `codex-${process.pid}`;
  let env = codexEnvironment("");
  env.JEV_CODEX_STATUS_ID = statusId;
  if (!informational) {
    if (!existsSync(join(ROOT, "codex-model-catalog.json"))) {
      process.stderr.write("[jev] Local Codex catalog is missing; run npm run catalog in the router checkout.\n");
      process.exitCode = 1;
      return;
    }
    try { loadEnv(); readJevApiKey(); } catch {
      process.stderr.write("[jev] Cannot read the owner-only TypeSafe key file; check ~/.config/jev-router/config.json.\n");
      process.exitCode = 1;
      return;
    }
    const proxy = await startCodexProxy({ statusId, effortOverride: explicitEffort(args) });
    close = proxy.close;
    env = { ...codexEnvironment(proxy.token), JEV_CODEX_STATUS_ID: statusId };
    args = codexArgs(`http://127.0.0.1:${proxy.port}`, args);
  }

  const childArgs = [...command.prefix, ...args];
  const child = spawn(
    command.file,
    command.shell ? childArgs.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)) : childArgs,
    { stdio: "inherit", shell: command.shell, env },
  );
  child.on("error", (err) => {
    close();
    process.stderr.write(`[jev] could not start Codex: ${err.message}\n`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    close();
    process.exitCode = signal ? 1 : (code ?? 0);
  });
}
