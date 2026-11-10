# Jev Router for Codex

This fork routes each fresh Codex user turn to a supported model and reasoning
effort using TypeSafe Jev. It launches the real Codex CLI and uses its existing
authentication, tools, permissions and sessions.

The maintained commands are `jev-codex` and `jev-explain`. The upstream Claude
implementation remains in the source tree, but this fork does not install its
launcher.

## Install from this fork

Requires Linux, Node.js 20.12+ and an authenticated
[Codex CLI](https://developers.openai.com/codex/cli). The Codex integration has
been exercised with CLI 0.167.0.

```bash
git clone https://github.com/WarGloom/jev-router.git
cd jev-router
npm ci --ignore-scripts
npm run catalog
node bin/jev-codex.mjs --version
```

Use `node bin/jev-codex.mjs` directly, or run `npm link --ignore-scripts` to make
`jev-codex` and `jev-explain` available on your PATH. The ordinary `codex` command
keeps its configuration.

## TypeSafe credentials

The default key location is `~/.config/typesafe/api-key`. It must be a regular
file owned by the current user, with no group or other permissions, containing
one TypeSafe API token. Symlinks are rejected.

To reference another existing key file, create an owner-only
`~/.config/jev-router/config.json` containing an absolute path:

```json
{"api_key_file": "/absolute/path/to/typesafe-api-key", "share_previous_exchange": false}
```

The config file also requires owner-only permissions. No project dotenv files
are loaded. The TypeSafe endpoint is fixed to `https://api.typesafe.ai`, with
decision model `jev-1.14.0` and SDK `0.6.0`.

The router reads the token in its parent process. It does not copy it into the
Codex child environment or put it in command arguments or routing logs. Existing
Codex authentication is forwarded to its normal upstream backend.

## Model and effort selection

Leave `jev-router` selected in the native model picker for automatic routing.
Jev first chooses a model using explicit capability criteria: Luna for simple
self-contained or mechanical work, Terra for ordinary scoped engineering, and
Sol for unknown-cause diagnosis, architecture, security, or concurrency. After
policy resolves the final model, a separate Jev Choice selects one of that
model's supported reasoning levels on every new user turn. Supported levels
come from the Codex capability catalog:

| Model | Supported efforts |
| --- | --- |
| `gpt-6-luna` | `low`, `medium`, `high`, `xhigh`, `max` |
| `gpt-6.1-terra` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| `gpt-6.1-sol` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |

Astra and all other model IDs are blocked in the picker and in forwarded model
requests. Environment model substitutions cannot expand this allowlist. Allowed model IDs are pinned in the bundled capability catalog; changing the
allowlist requires an explicit source change. `npm run catalog` builds the native
Codex catalog from `~/.codex/models_cache.json`. Runtime instruction templates
remain only in the generated, ignored `codex-model-catalog.json` with mode `0600`.
The outer cache identity and session metadata are not copied. If your cache lives
elsewhere, use `npm run catalog -- /absolute/path/to/models_cache.json`.

```bash
jev-codex
jev-codex exec "Fix the failing test"
jev-codex -c 'model_reasoning_effort="high"'
```

An explicit CLI effort setting restricts eligible models and pins the forwarded
effort. Selecting a concrete allowed model manually pauses automatic model
routing. Tool-loop continuations and steering messages received before a final
assistant reply retain the selected model and effort without calling Jev again.
If assistant phase metadata is absent, follow-ups conservatively keep the current
selection. Routing resumes for user input after a final reply or in a new conversation.
This guard detects active-turn steering; a final reply does not establish that the
user's entire task is complete.

Only real user tasks trigger Jev routing. Injected `AGENTS.md` instruction blocks
remain context. Codex title generation, automatic approval assessments and returning-user
catch-up requests bypass Jev and retain the conversation's selected model. Their
contents still reach Codex, but they do not publish new task-routing decisions.

Routing sends the current user request and model metadata to TypeSafe. Set
`share_previous_exchange` to `true` in the owner-only local configuration to also
send the preceding user/assistant exchange for contextual follow-ups. It defaults
to `false`. Developer instructions, analysis messages, raw tool results and
injected routing notices are excluded from that exchange. Exact routing requests
and model/effort decisions are retained in the private routing history.

The native footer can show the routing sentinel and client effort setting. The
injected commentary reports the actual forwarded pair:

```text
[Jev] routed this turn to gpt-6-luna (low). Jev recommended gpt-6-luna. Reasoning effort: model default.
```

Routine notices explain the selected model, retained model, and uncertain fallback
in plain language. Detailed explanations retain model-choice confidence, its meaning
and the configured policy threshold so scores can be interpreted in context.

Conversation length never vetoes a routing recommendation. At low confidence,
a downgrade from a stronger model uses the balanced fallback without going below
Jev's recommended tier; uncertain upgrades remain capped. If the effort Choice
is unavailable or uncertain, the selected model's default effort is used.
Explicit reasoning settings win. If model routing is unavailable, policy keeps
the current allowed model and compatible effort.

## Shutdown

Terminal interrupts retain native Codex behavior. Use `/exit` or `/quit` to leave
the CLI. When the Codex child exits, the wrapper stops accepting proxy requests,
closes active connections and cancels pending routing and upstream streams.
Disconnecting a Codex request also cancels its upstream stream.

## Explanations and private state

`jev-explain` renders a recorded routing exchange locally, without asking Jev
again. To enable the `$jev-explain` skill explicitly:

```bash
node --input-type=module -e 'import { installCodexSkill } from "./src/codex-cli.mjs"; installCodexSkill();'
```

Installation preserves an existing skill whose contents differ. Launching the
router does not rewrite global skills.

State is stored in `~/.local/state/jev-router` with directory mode `0700` and
file mode `0600`. Up to 20 exchanges are retained per session; files stale for
seven days are pruned on subsequent writes. These exchanges contain prompt text
and the exact Jev request and response. Do not commit or publish them.

`JEV_ROUTER_CONFIG_FILE` and `JEV_ROUTER_STATE_DIR` override the local config and
state paths. `JEV_DEBUG=1` enables private diagnostic logging. Raw request-body
dumping is disabled.

## Proxy protections

The proxy binds to loopback, requires a random per-session token, rejects browser
Origin requests, and limits request bodies to 32 MiB. Its authentication header
is stripped before forwarding. Prompt text is sent to TypeSafe for routing;
normal inference requests go to the Codex backend.

## Development

```bash
npm ci --ignore-scripts
npm run catalog
npm test
```

Tests cover model and effort routing, explicit overrides, tool continuations,
fallbacks, first-turn cache behavior, proxy authentication, model restrictions,
and private credential/state handling. The inherited shared-policy and Claude
tests remain part of the suite.

The Codex catalog schema and wire format can change between CLI versions.
Passing unit tests does not establish coding quality or cost savings; verify a
real completed Codex turn when updating the integration.

## Upstream and license

Based on [gargpratyush/jev-router](https://github.com/gargpratyush/jev-router).
Report issues for this fork at
[WarGloom/jev-router](https://github.com/WarGloom/jev-router/issues).

MIT; see [LICENSE](LICENSE).
