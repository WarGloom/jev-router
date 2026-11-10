import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const configModule = new URL("../src/local-config.mjs", import.meta.url).href;
const cliModule = new URL("../src/codex-cli.mjs", import.meta.url).href;

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "jev-local-security-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const key = join(directory, "api-key");
  const config = join(directory, "config.json");
  writeFileSync(key, "synthetic-test-token\n", { mode: 0o600 });
  writeFileSync(config, JSON.stringify({ api_key_file: key }), { mode: 0o600 });
  const env = { ...process.env, JEV_ROUTER_CONFIG_FILE: config, JEV_ROUTER_STATE_DIR: join(directory, "state") };
  for (const name of ["NODE_OPTIONS", "TYPESAFE_BASE_URL", "JEV_API_KEY", "TYPESAFE_API_KEY"]) delete env[name];
  const run = (script) => spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: directory, env, encoding: "utf8" });
  return { directory, key, config, env, run };
}

test("Codex launcher ignores project dotenv and loads the configured key file", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.directory, ".env"), "TYPESAFE_BASE_URL=http://attacker.invalid\nNODE_OPTIONS=--require ./attack.cjs\nJEV_API_KEY=wrong-key\n");
  const r = f.run(`import assert from 'node:assert/strict'; import {loadEnv} from ${JSON.stringify(cliModule)}; import {readJevApiKey,TYPESAFE_ORIGIN,JEV_MODEL} from ${JSON.stringify(configModule)}; assert.equal(loadEnv().apiKeyFile,${JSON.stringify(f.key)}); assert.equal(readJevApiKey(),'synthetic-test-token'); assert.equal(process.env.TYPESAFE_BASE_URL,undefined); assert.equal(process.env.NODE_OPTIONS,undefined); assert.equal(process.env.JEV_API_KEY,undefined); assert.equal(TYPESAFE_ORIGIN,'https://api.typesafe.ai'); assert.equal(JEV_MODEL,'jev-1.14.0');`);
  assert.equal(r.status, 0, r.stderr);
});

test("previous-exchange sharing defaults off and accepts explicit boolean consent", (t) => {
  const f = fixture(t);
  let r = f.run(`import assert from 'node:assert/strict'; import {loadEnv} from ${JSON.stringify(cliModule)}; assert.equal(loadEnv().sharePreviousExchange,false);`);
  assert.equal(r.status, 0, r.stderr);
  for (const enabled of [true, false]) {
    writeFileSync(f.config, JSON.stringify({ api_key_file: f.key, share_previous_exchange: enabled }), { mode: 0o600 });
    r = f.run(`import assert from 'node:assert/strict'; import {loadEnv} from ${JSON.stringify(cliModule)}; assert.equal(loadEnv().sharePreviousExchange,${enabled});`);
    assert.equal(r.status, 0, r.stderr);
  }
});

test("non-boolean previous-exchange consent is rejected", (t) => {
  const f = fixture(t);
  writeFileSync(f.config, JSON.stringify({ api_key_file: f.key, share_previous_exchange: "true" }), { mode: 0o600 });
  const r = f.run(`import {loadEnv} from ${JSON.stringify(cliModule)}; loadEnv();`);
  assert.notEqual(r.status, 0);
});

test("key files with shared permissions or symlink indirection are rejected", (t) => {
  const f = fixture(t);
  chmodSync(f.key, 0o644);
  let r = f.run(`import {readJevApiKey} from ${JSON.stringify(configModule)}; readJevApiKey();`);
  assert.notEqual(r.status, 0);
  chmodSync(f.key, 0o600);
  const link = join(f.directory, "key-link");
  symlinkSync(f.key, link);
  writeFileSync(f.config, JSON.stringify({ api_key_file: link }), { mode: 0o600 });
  r = f.run(`import {readJevApiKey} from ${JSON.stringify(configModule)}; readJevApiKey();`);
  assert.notEqual(r.status, 0);
});

test("TypeSafe credentials are not inherited by the Codex child", (t) => {
  const f = fixture(t);
  f.env.JEV_API_KEY = "synthetic-parent-key";
  f.env.TYPESAFE_API_KEY = "synthetic-parent-key";
  f.env.TYPESAFE_BASE_URL = "http://attacker.invalid";
  const r = f.run(`import assert from 'node:assert/strict'; import {codexEnvironment} from ${JSON.stringify(configModule)}; const e=codexEnvironment('ephemeral-session'); assert.equal(e.JEV_API_KEY,undefined); assert.equal(e.TYPESAFE_API_KEY,undefined); assert.equal(e.TYPESAFE_BASE_URL,undefined); assert.equal(e.JEV_ROUTER_SESSION_TOKEN,'ephemeral-session');`);
  assert.equal(r.status, 0, r.stderr);
});

test("Jev routing honors pre-aborted and in-flight lifecycle cancellation", (t) => {
  const f = fixture(t);
  const routerModule = new URL("../src/router.mjs", import.meta.url).href;
  const sdkModule = import.meta.resolve("@typesafe-ai/sdk");
  const r = f.run(`
    import assert from 'node:assert/strict';
    import {TypeSafeClient} from ${JSON.stringify(sdkModule)};
    let calls=0;
    TypeSafeClient.prototype.systemOne=async()=>{calls++;return {answers:{model:{choice:'gpt-6.1-sol',confidence:.9}}};};
    const {askJev}=await import(${JSON.stringify(routerModule)});
    const input={prompt:'synthetic task',current:'gpt-6.1-sol',contextTokens:1,models:[{id:'gpt-6.1-sol',tier:'opus'}]};
    assert.equal(await askJev({...input,signal:AbortSignal.abort()}),null);
    assert.equal(calls,0);
    const controller=new AbortController();let propagated=false;
    TypeSafeClient.prototype.systemOne=async(request,options)=>{controller.abort();propagated=options.signal.aborted;throw new Error('synthetic cancellation');};
    assert.equal(await askJev({...input,signal:controller.signal}),null);
    assert.equal(propagated,true);
  `);
  assert.equal(r.status, 0, r.stderr);
});

test("routing state is private and replacement cannot overwrite a symlink target", (t) => {
  const f = fixture(t);
  const r = f.run(`import assert from 'node:assert/strict'; import {statSync,readFileSync,writeFileSync,symlinkSync} from 'node:fs'; import {join} from 'node:path'; import {STATE_DIR,ensureStateDir,writePrivateFile,readPrivateStateFile} from ${JSON.stringify(configModule)}; ensureStateDir(); const outside=join(process.cwd(),'untouched');writeFileSync(outside,'keep'); const p=join(STATE_DIR,'session.json');symlinkSync(outside,p); assert.throws(()=>readPrivateStateFile(p)); writePrivateFile(p,'{"safe":true}'); assert.equal(readFileSync(outside,'utf8'),'keep'); assert.equal(statSync(STATE_DIR).mode&0o777,0o700); assert.equal(statSync(p).mode&0o777,0o600); assert.equal(JSON.parse(readPrivateStateFile(p)).safe,true);`);
  assert.equal(r.status, 0, r.stderr);
});
