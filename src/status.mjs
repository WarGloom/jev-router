import { readdirSync, lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR, ensureStateDir, readPrivateStateFile, writePrivateFile } from "./local-config.mjs";

// One private file per session, with bounded history and stale-file cleanup.
const DIR = STATE_DIR;

// Files not updated for this long belong to finished sessions and are removed.
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
let pruned = false;

const fileFor = (sessionId) => join(DIR, `${sessionId.replace(/[^\w-]/g, "")}.json`);

/** Publish the latest routing decision so the status line can display it. */
export function writeStatus(sessionId, status) {
  if (!sessionId) return;
  try {
    ensureDir();
    const file = fileFor(sessionId);
    writePrivateFile(file, JSON.stringify(status));
    if (!pruned) {
      pruned = true;
      pruneStale();
    }
  } catch {
    // Status display is cosmetic and must never interfere with a request.
  }
}

/** Publish a routed prompt and retain recent exact Jev exchanges for diagnosis. */
export function writeDecision(sessionId, decision) {
  const previous = readStatus(sessionId);
  const history = [...(previous?.history ?? []), decision].slice(-20);
  writeStatus(sessionId, { ...decision, history });
}

/** Latest routing decision for a session, or null if none has been made yet. */
export function readStatus(sessionId) {
  try {
    return JSON.parse(readPrivateStateFile(fileFor(sessionId)));
  } catch {
    return null;
  }
}

function ensureDir() {
  ensureStateDir();
}

/** Delete status files untouched for `maxAgeMs`. Runs once per process on the first write. */
export function pruneStale(maxAgeMs = STALE_AFTER_MS, now = Date.now()) {
  let removed = 0;
  try {
    for (const name of readdirSync(DIR)) {
      if (!name.endsWith(".json")) continue;
      const file = join(DIR, name);
      try {
        const stat = lstatSync(file);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && now - stat.mtimeMs > maxAgeMs) {
          unlinkSync(file);
          removed++;
        }
      } catch {
        // Another session may have removed or replaced it; ignore.
      }
    }
  } catch {
    // Missing or unreadable directory: nothing to prune.
  }
  return removed;
}

/** Directory holding status files, exposed for tests and diagnostics. */
export const STATUS_DIR = DIR;
