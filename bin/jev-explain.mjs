#!/usr/bin/env node
import { readStatus } from "../src/status.mjs";
import { formatExplanation } from "../src/explain.mjs";

const id = process.argv[2] ?? process.env.JEV_CODEX_STATUS_ID;
if (!id) {
  process.stderr.write("Jev Router: session identity is unavailable; restart Codex through jev-codex or provide the status ID.\n");
  process.exitCode = 1;
} else {
  process.stdout.write(`${formatExplanation(readStatus(id))}\n`);
}
