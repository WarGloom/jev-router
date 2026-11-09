import {
  chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync,
  openSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";

export const TYPESAFE_ORIGIN = "https://api.typesafe.ai";
export const JEV_MODEL = "jev-1.14.0";
export const CONFIG_FILE = process.env.JEV_ROUTER_CONFIG_FILE ?? join(homedir(), ".config", "jev-router", "config.json");
export const STATE_DIR = process.env.JEV_ROUTER_STATE_DIR ?? join(homedir(), ".local", "state", "jev-router");

function ownedRegular(fd, label) {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw new Error(`${label} must be an owner-only regular file`);
  }
  return stat;
}

function privateRead(path, label) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = ownedRegular(fd, label);
    if (stat.size > 16384) throw new Error(`${label} is unexpectedly large`);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

export function readLocalConfig() {
  let data = {};
  try {
    data = JSON.parse(privateRead(CONFIG_FILE, "Jev configuration"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).some((key) => key !== "api_key_file")) {
    throw new Error("Jev configuration supports only api_key_file");
  }
  const apiKeyFile = data.api_key_file ?? join(homedir(), ".config", "typesafe", "api-key");
  if (typeof apiKeyFile !== "string" || !isAbsolute(apiKeyFile)) throw new Error("api_key_file must be absolute");
  return { apiKeyFile };
}

export function readJevApiKey() {
  const key = privateRead(readLocalConfig().apiKeyFile, "TypeSafe API key").trim();
  if (!key || /\s/.test(key)) throw new Error("TypeSafe API key file must contain one token");
  return key;
}

export function ensureStateDir() {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const stat = lstatSync(STATE_DIR);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new Error("Unsafe Jev state directory");
  chmodSync(STATE_DIR, 0o700);
  return STATE_DIR;
}

export function writePrivateFile(path, content) {
  ensureStateDir();
  if (dirname(path) !== STATE_DIR) throw new Error("Jev state file must stay in its private directory");
  const temporary = join(STATE_DIR, `.write-${process.pid}-${randomUUID()}`);
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  let closed = false;
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, content);
    closeSync(fd);
    closed = true;
    renameSync(temporary, path);
  } catch (err) {
    if (!closed) try { closeSync(fd); } catch {}
    throw err;
  } finally {
    try { unlinkSync(temporary); } catch (err) { if (err.code !== "ENOENT") throw err; }
  }
}

export function readPrivateStateFile(path) {
  ensureStateDir();
  if (dirname(path) !== STATE_DIR) throw new Error("Jev state file must stay in its private directory");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    ownedRegular(fd, "Jev state");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}

export function codexEnvironment(sessionToken) {
  const env = { ...process.env, JEV_ROUTER_SESSION_TOKEN: sessionToken };
  for (const key of ["JEV_API_KEY", "TYPESAFE_API_KEY", "TYPESAFE_BASE_URL", "JEV_DUMP"]) delete env[key];
  return env;
}
