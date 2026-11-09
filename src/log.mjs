import { closeSync, constants, fchmodSync, fstatSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR, ensureStateDir } from "./local-config.mjs";

export const LOG_FILE = join(STATE_DIR, "router.log");

// Claude Code owns the terminal in interactive mode and redraws over anything we print, so
// writing to stderr there corrupts its UI. Log to a file instead and leave stderr alone.
// In print mode (`-p`) there is no TUI to damage, so stderr stays convenient for piping.
const interactive = process.stdout.isTTY;

export function log(line) {
  const text = `[jev] ${line}\n`;
  if (!interactive) return void process.stderr.write(text);
  try {
    ensureStateDir();
    const fd = openSync(LOG_FILE, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid()) throw new Error("Unsafe Jev log file");
      fchmodSync(fd, 0o600);
      writeFileSync(fd, `${new Date().toISOString()} ${text}`);
    } finally { closeSync(fd); }
  } catch {
    // A broken log file must never take down the session.
  }
}

export const debug = (line) => process.env.JEV_DEBUG && log(line);
