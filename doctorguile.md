# doctorguile fork: local macOS build notes

Personal notes for building and running LearnHarness locally on a Mac, without
an Apple Developer ID. This file is for the `doctorguile` branch only. It is not
part of the upstream project.

The branch also adds one feature: an **Anthropic-compatible endpoint**, so the
app can use Claude models through the LiteLLM proxy. See section 11 for setup.

- Fork: `https://github.com/doctorguile/learnharness`
- Local branch: `doctorguile` (created from `main` at `e69e852`)
- Remote name: `doctorguile` → `git@github.com:doctorguile/learnharness.git`
- Upstream remote `origin` is unchanged (`amosblomqvist/learnharness`)

---

## 1. Quick start (returning to this)

```bash
cd ~/Projects/learnharness   # adjust to your clone path
git switch doctorguile

make app       # preflight checks, package, sign -> dist/mac-arm64/LearnHarness.app
make run       # opens the app
make quit      # quits the app; its local server stops with it
```

On a Mac that has never built this repo:

```bash
make install   # npm ci (locked dependencies; run once)
make cert      # create the local self-signed code-signing identity (run once per Mac)
make app
```

`make cert` may show a macOS keychain prompt. Grant access; it is expected.

Run `make help` for the target list.

To use Claude through LiteLLM, see section 11.1 (one-time setup in the app).

---

## 2. Makefile targets

| Target | What it does |
|---|---|
| `make help` | Lists targets (default goal). |
| `make install` | `npm ci`. Needed once, and again after `package-lock.json` changes. |
| `make web` | `npm run build`, then `smoke-provider-runtime`, `build-server`, `smoke-server`. The same preflight as `desktop:dist`, without packaging. |
| `make pack` | Deletes `dist/`, then runs `electron-builder --mac --arm64 --dir` with no identity discovery, no notarization, and `build/icon.icns` as the icon. |
| `make sign` | Signs the app with `SIGN_ID` (default `LearnHarness Local Dev`). Fails with a clear message if the certificate is missing. |
| `make cert` | Creates the self-signed code-signing certificate `LearnHarness Local Dev` in the login keychain. Skips if it already exists. |
| `make app` | `web` + `pack` + `sign`. The normal full build. |
| `make verify` | Runs `codesign --verify --deep --strict`, prints identifiers, flags, and the designated requirement. |
| `make run` | `open -n dist/mac-arm64/LearnHarness.app` |
| `make quit` | Quits the app through AppleScript. |
| `make clean` | Removes `dist/` and `.next/standalone`. |

Overrides:

```bash
make app SIGN_ID=-                       # ad-hoc signature, no certificate needed
make cert CERT_CN="Some Other Name"      # different certificate name
```

Timing on this Mac: `make app` takes about 25 seconds after dependencies are
installed. Most of that is the Next build.

---

## 3. What `make app` does, step by step

1. `npm run build` (Next.js production build, `output: "standalone"`).
2. `node scripts/smoke-provider-runtime.mjs` (offline provider initialization check).
3. `node scripts/build-server.mjs` (curates the standalone server payload).
4. `node scripts/smoke-server.mjs` (boots the packaged server, checks `/`, `/api/graph`, `/api/models`, `/api/settings`).
5. `rm -rf dist`, then:
   ```bash
   CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --arm64 --dir --publish never \
     -c.mac.notarize=false -c.mac.icon=build/icon.icns
   ```
6. `codesign --force --deep --sign "<SIGN_ID>" --entitlements build/entitlements.mac.plist dist/mac-arm64/LearnHarness.app`, then `codesign --verify --deep --strict`.

Build output is ignored by git: `dist/`, `.next/`, `node_modules/`.

---

## 4. Decisions and why

Each row is a finding from this Mac, with the evidence.

| Decision | Why |
|---|---|
| `CSC_IDENTITY_AUTO_DISCOVERY=false` | This Mac has no Developer ID Application certificate. Auto-discovery would find nothing and skip signing with a warning. Setting it to `false` makes the choice explicit. |
| `-c.mac.notarize=false` | Notarization needs the `LH_NOTARY` keychain profile. This Mac does not have it. CI's unsigned rehearsal uses the same flag. |
| `-c.mac.icon=build/icon.icns` | `actool` is required to compile `build/icon.icon` (Liquid Glass). `actool` is only in full Xcode 26. Command Line Tools do not include it (checked: `xcrun --find actool` fails). The override gives the app the older full-resolution icon. Nothing else changes. |
| `--dir` (no DMG or ZIP) | Faster, and enough to run the app. DMG creation was not tested on this Mac. |
| Self-signed identity, not ad-hoc | A self-signed identity gives the app a stable designated requirement (`certificate leaf = H"…"`) across rebuilds. Ad-hoc signatures change on every build, so macOS treats each build as a new app. |
| **No `--options runtime`** | **Important.** With the hardened runtime, macOS library validation rejects the nested Electron Framework, and the app crashes at launch (fatal `309`, "mapping process and mapped file (non-platform) have different Team IDs"). This happened with both ad-hoc and self-signed identities. Without the flag, the app launches and runs. Tested on macOS 26.5.1. |
| `codesign --deep` | electron-builder leaves Electron's original prebuilt signature on the modified bundle. The bundle then fails `codesign --verify` (resources seal broken). Re-signing fixes it. |
| GNU Make 3.81 compatibility | macOS ships GNU Make 3.81. The Makefile avoids `.SHELLFLAGS`, `.ONESHELL`, and other 4.x features. |

Subtle point: `exit` inside a recipe line only ends that line's shell. The
`cert` target keeps its `if/else` in one shell command for this reason. An
earlier version fell through and imported a duplicate identity. This was fixed
and tested.

---

## 5. Verified on this Mac

- macOS 26.5.1 (25F80), Apple Silicon (arm64)
- Node 24.22.1, npm 11.19.1
- GNU Make 3.81
- Electron 44.9.3, electron-builder 26.16.1
- Xcode: not installed (Command Line Tools only)
- Developer ID identities: none. Notary profile `LH_NOTARY`: none.

Confirmed working:

- `make app` exits 0. All four preflight scripts pass.
- The app launches with `open`. The main process and the local server run. `GET /` returns 200 and the title is `Learning Harness`.
- `make quit` stops the app and the server.
- `make cert` is idempotent (second run reports "already exists").

---

## 6. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| App closes at launch. Crash report mentions `309` or "different Team IDs". | The bundle was signed with the hardened runtime. Run `make sign` (it has no runtime flag). Check the newest `~/Library/Logs/DiagnosticReports/LearnHarness-*.ips`. |
| `make sign` says "no certificate named …". | Run `make cert` once, or use `make app SIGN_ID=-`. |
| `make pack` says "Failed to check actool version". | Do not remove `-c.mac.icon=build/icon.icns`. Without it, electron-builder needs Xcode 26. |
| `make pack` hangs for about 10 minutes before failing. | Seen once on the first attempt. Cause not found. The second attempt failed at once on `actool`. If it recurs, check the network and the `actool` override. |
| `codesign --verify` fails with "a sealed resource is missing" | The bundle was modified after signing. Run `make sign` again. |
| Gatekeeper blocks a copy of the app that was downloaded or sent by AirDrop or zip. | Quarantine flag. Run `xattr -dr com.apple.quarantine LearnHarness.app`. **Not tested** on a quarantined copy. A locally built app (`make run`) does not have the flag and opens normally. |
| `curl http://127.0.0.1:<port>/api/settings` returns 403. | Expected. The packaged server requires a per-launch secret header (`x-learnharness-desktop`) that only the Electron shell sends (`src/server/desktop-access.ts`). |
| `main.log` shows `updater error: ENOENT … app-update.yml`. | Expected for `--dir` builds. The updater is disabled in practice here. |
| Shell warning "Most NODE_OPTIONs are not supported in packaged apps". | This shell sets `NODE_OPTIONS=--use-system-ca`. The packaged app ignores it. Harmless. |

Logs and diagnostics:

- App log: `~/Library/Application Support/LearnHarness/logs/main.log`
- Crash reports: `~/Library/Logs/DiagnosticReports/LearnHarness-*.ips`
- Server port: `grep 'server up' ~/Library/Application\ Support/LearnHarness/logs/main.log | tail -1`

---

## 7. Not tested yet

- A quarantined (downloaded) copy of the app.
- Whether macOS permission prompts (microphone, keychain) stop repeating after a rebuild. The stable identity should prevent this. Not verified.
- Real provider use **other than** the LiteLLM route. The LiteLLM route is tested (section 11.5).
- The new Anthropic-compatible settings screen was not clicked through by the agent. The user connected through it in the packaged app.
- Prompt caching through LiteLLM (prompts in the tests were too small to cache).
- DMG and ZIP output (`make pack` uses `--dir`).
- Notarized release builds. Those need the upstream release path, not this Makefile.

---

## 8. Changes made

### In this repository (branch `doctorguile`)

Committed (`3897744`):

- `Makefile` (new): the local build targets above.
- `doctorguile.md` (new): this file.

Committed after `3897744` (the Anthropic-compatible endpoint, section 11):

- New: `src/server/anthropic-compatible.ts`, `src/server/anthropic-compatible-http.ts`,
  `app/api/anthropic-compatible/route.ts`, `tests/anthropic-compatible.test.ts`.
- Changed: `src/agent/models.ts`, `src/core/auth-keys.ts`, `src/core/settings.ts`,
  `src/server/keys.ts`, `src/server/model-catalog.ts`, `src/server/index.ts`,
  `src/server/custom-provider.ts`, `src/server/custom-provider-http.ts`,
  `components/settings/keys-section.tsx`, `tests/cache-retention.test.ts`,
  `docs/custom-providers.md`, and this file.
- Untracked, never committed: `handoff/` (the research note and the live probe
  scripts in `handoff/probes/`). Local only.

`next build` rewrites `next-env.d.ts` (`.next/dev/types` → `.next/types`). Revert
that rewrite before you commit: `git checkout -- next-env.d.ts`.

### Outside the repository

- **Keychain:** one self-signed code-signing identity, `LearnHarness Local Dev`, in the login keychain. Remove it with `security delete-identity -c "LearnHarness Local Dev"` if you no longer need it. The private key is stored there too.
- **Repo-local directories (git-ignored):** `node_modules/`, `.next/`, `dist/`.
- **`tmp/`:** an empty directory. It is not git-ignored. `make cert` writes key files there briefly and deletes them on exit.
- **Electron cache:** the Electron 44.9.3 zip, downloaded during `make pack`.
- **App profile:** `~/Library/Application Support/LearnHarness/`. Created on the first launch of the local build. It is a fresh profile, separate from any installed release. It includes `data/` and `chatgpt-credentials.json`. Do not share or commit this folder.
- **Crash reports:** three `LearnHarness-*.ips` files in `~/Library/Logs/DiagnosticReports/` from failed launches during testing (2026-11-01, 08:19 and 08:26). They can be deleted.
- **Git:** remote `doctorguile` added. Branch `doctorguile` created with `branch.doctorguile.remote` and `branch.doctorguile.merge` set. Nothing has been pushed.
- **App profile, after LiteLLM setup:** `settings.json` gets an `anthropicCompatible` section (base URL and model IDs). `auth.json` gets `LITELLM_KEY` if you typed the key in the editor. Both are in `~/Library/Application Support/LearnHarness/data/`.

No system-wide changes. No Xcode, Homebrew, or other software was installed.

---

## 9. Open items

- **`tmp/` is not git-ignored.** Consider adding `tmp/` to `.gitignore`. Not done, because it changes a tracked file.
- **Upstream release path** is unchanged. Release builds still use `npm run desktop:dist` and need a Developer ID certificate, the `LH_NOTARY` profile, and Xcode 26.
- **First-run setup dialog** does not offer the Anthropic-compatible endpoint. It is only in Settings → Providers. Add it there if a fresh install must use LiteLLM from the start.
- **Upstream merges:** `src/agent/models.ts` and `components/settings/keys-section.tsx` are the files most likely to conflict with upstream changes.

---

## 10. Push when ready

```bash
git push -u doctorguile doctorguile
```

After the first push, the `[gone]` marker in `git branch -vv` clears.

---

## 11. LiteLLM: the Anthropic-compatible endpoint

The app can now call Claude models through the LiteLLM proxy. It uses LiteLLM's **native Anthropic
Messages API** (`/v1/messages`), not the OpenAI route. Thinking levels, tools,
images, catalog limits and cost estimates therefore work as they do for direct
Anthropic.

It is a separate provider, `anthropic-compatible`. Direct Anthropic and the
existing custom (OpenAI-compatible) endpoint stay available at the same time.

### 11.1 Setup (one time, in the app)

1. Build and open the app: `make app && make run`.
2. Open **Settings → Providers**.
3. Click **+ Add a provider**, then select **Anthropic-compatible endpoint**.
4. Base URL: 
   **Do not add `/v1`.** The client adds `/v1/messages` itself.
5. API key: paste your LiteLLM key. The app saves it as `LITELLM_KEY` in its own
   `auth.json`.
6. Click **Connect**. Connect takes a few seconds, because it checks the endpoint
   before it saves anything (section 11.2).
7. Open **Settings → Models** and pick models for the **Strong**, **Cheap** and
   **Vision** slots. The new models show under the provider `anthropic-compatible`.

**Subtle point: the packaged app does not see shell variables.** `make run` uses
`open -n`, which does not pass your shell's environment. `export LITELLM_KEY=…` in
your shell therefore has **no effect** on the packaged app. Type the key once in
the editor. A real `LITELLM_KEY` environment variable is used only when the app
is started from a shell that has it (for example `npm run desktop:dev`). Then the
environment value wins, and the key field is disabled.

**To change the URL or key, or to get new models:** click the row, edit the
fields, and click **Connect** again. Leave the key field blank to keep the saved
key.

**To remove:** click the row, then **Disconnect**. This removes the settings and
the saved key. A key from the environment stays.

### 11.2 What Connect does

Connect saves nothing until all steps pass:

1. `GET {base}/v1/models` with `x-api-key`. LiteLLM returns about 33 IDs
   (Claude, Gemini, embeddings, `anthropic/…` aliases).
2. Keep only the IDs that are also in pi-ai's built-in Anthropic catalog.
   Gemini, embeddings and aliases drop out.
3. Keep only the **newest version of each family** (opus, sonnet, haiku, fable,
   …). Versions compare as numbers: 5.5 > 5.1 > 5 > 4.8. At the same version, an
   undated alias wins over a dated snapshot (`claude-haiku-4-5` over
   `claude-haiku-4-5-20251001`).
4. Send one 1-token `/v1/messages` request to the cheapest model that is left,
   through pi-ai's own client, the same path that a real turn uses.
5. Save the key (if you typed one) and the settings.

With LiteLLM on 2026-11-01, the 10 Claude IDs became 3:
`claude-haiku-5-5`, `claude-opus-5-5`, `claude-sonnet-5-5`. The check ran on
`claude-haiku-5-5`.

The model list is a snapshot from connect time. When LiteLLM adds a model, click
**Connect** again.

### 11.3 Design decisions

| Decision | Why |
|---|---|
| Separate provider (`anthropic-compatible`), not an override of the built-in `anthropic` | Direct Anthropic and LiteLLM can run together. An override would also put the LiteLLM key in `ANTHROPIC_API_KEY`. If the override was later cleared, that key would go to `api.anthropic.com`. |
| Generic name, not "litellm" | Any gateway that serves `/v1/messages` works. |
| No `ANTHROPIC_BASE_URL` support | pi-ai's built-in Anthropic provider hard-codes `https://api.anthropic.com`, and its client always uses the model's base URL. The SDK's `ANTHROPIC_BASE_URL` default is never reached. Shell variables also do not reach the packaged app. |
| Key name `LITELLM_KEY` | Your choice. Env wins, else the copy saved in `auth.json` (the app's normal key rules). |
| Base URL and key resolved together, per request | The provider's auth step returns both the key and the base URL. pi-ai applies that base URL over the model's. A key can only go to the URL that is set at that time. |
| Models copied from pi-ai's Anthropic catalog | Correct context sizes, thinking levels and prices with no extra metadata. Cost shows Anthropic list prices as **estimates**. LiteLLM can bill differently. |
| Newest version per family only | Older versions crowd the model pickers. |
| Connect check = 1-token `/v1/messages` | Tests the real route, not only the model list. |
| Disconnect removes the saved key | Same as the custom endpoint. |

### 11.4 The LiteLLM compat fix (important)

The first real run in the app failed:

```
400 ... messages.1.output_config: Extra inputs are not permitted
```

**Cause.** pi-ai 1.4.0 marks the 5.x models (`haiku-5-5`, `sonnet-5-5`,
`opus-5`, `opus-5-5`, `fable-5-1`) with `supportsMidConvoEffort`. pi-ai then puts
`output_config` **inside** the messages. This needs an `anthropic-beta` header.
LiteLLM drops unknown beta headers, so Vertex receives the request without the
beta and rejects it. It fails only from the **second** message on. A one-turn test
does not show it.

**Fix.** Every model of this provider gets:

```ts
supportsMidConvoEffort: false       // else: 400 messages.1.output_config
supportsMidConvoToolChanges: false  // else: 400 Input tag 'tool_addition' / 'tool_removal'
```

pi-ai then sends the effort at the top level and the full tool list on each
request. The code is `GATEWAY_COMPAT` in `src/server/anthropic-compatible.ts`.
`supportsMidConvoSystemMessages` needs no beta and is not changed.

**Side effect.** These flags are off for the whole provider. If you point the
endpoint at `api.anthropic.com`, requests still work, but pi-ai cannot change
effort or tools mid-conversation. Prompt caching can be a little less efficient.

**If a new pi-ai version adds another beta-dependent flag**, the same kind of 400
can come back. Compare the catalog flags with the pi package's
`UNSUPPORTED_COMPAT` list, and add the new flag to `GATEWAY_COMPAT`.

### 11.5 Verified

| Test | Result |
|---|---|
| Connect through the real route handler, with no `LITELLM_KEY` in the environment (as in the packaged app) | 200. 3 models. Check model `claude-haiku-5-5`. |
| Two-turn conversation, thinking `medium`, on all 3 models | All answer. **Before the fix:** all 3 returned the 400 above. |
| `sonnet-5-5`: tool call, tool result, effort change (medium → high), tool added mid-conversation | Pass |
| `haiku-4-5`, `sonnet-4-6`: thinking + tool round trip; image input | Pass (research probe) |
| Model picker | All models present, with prices |
| Fetch guard in the probes | No request went to any host other than LiteLLM |

Automated: `tests/anthropic-compatible.test.ts` (12 tests, mocked endpoint):
settings sanitizer, model restamping and compat flags, newest-per-family rule,
connect success and failure paths (nothing is saved on failure), key reuse,
origin check, engine turn, the wire format (no `output_config` inside messages),
and disconnect. If the compat fix is removed, 2 of these tests fail (checked).

Full suite: 3198 pass, 1 fail. The failing test (`binds 127.0.0.1`) also fails
without these changes. It times out on this Mac's network. `npm run typecheck`
and `npm run lint` are clean.

### 11.6 Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Connect: `Endpoint returned HTTP 404 for /v1/models`, or the check fails with 404 | The base URL ends in `/v1`. Remove it. |
| Connect: `Enter a key (saved as LITELLM_KEY)` | No key is saved and none is in the environment. Paste the key. |
| Connect: `The environment supplies LITELLM_KEY` | The app was started from a shell that has `LITELLM_KEY`. Change the environment, or start the app with `make run`. |
| Connect: `The endpoint lists none of the built-in Anthropic model ids` | LiteLLM serves no Claude ID that pi-ai knows. A pi-ai upgrade may be needed for new model IDs. |
| Connect: `Messages API check failed (…)` | The key is wrong or has no access to that model. The message includes LiteLLM's error text. |
| A model slot shows the model as unavailable | The slot uses a model that a newer Connect removed (for example `sonnet-4-6`). Pick the model again. |
| Runs fail with `messages.1.output_config: Extra inputs are not permitted` | The build is older than the compat fix (section 11.4). Run `make app`, then **Connect** again. |
| Runs fail with `Provider is not configured: anthropic-compatible` | The key is gone (deleted, or the environment variable was removed). Connect again with the key. |

### 11.7 Code map

| File | Role |
|---|---|
| `src/server/anthropic-compatible.ts` | Provider builder, `GATEWAY_COMPAT`, `/v1/models` discovery, catalog intersection, `latestPerFamily`, connect check, and the provider source that syncs into `piModels()`. |
| `src/server/anthropic-compatible-http.ts` | `GET`/`POST`/`DELETE /api/anthropic-compatible`. |
| `app/api/anthropic-compatible/route.ts` | Next route. |
| `src/agent/models.ts` | Now supports more than one provider source (custom endpoint + this one). The field `isCustom` was renamed to `owns`. |
| `src/core/auth-keys.ts` | `ANTHROPIC_COMPATIBLE = { id: "anthropic-compatible", envVar: "LITELLM_KEY", label }`. |
| `src/core/settings.ts` | The `anthropicCompatible` settings section and its sanitizer. |
| `src/server/keys.ts` | `LITELLM_KEY` is a managed, writable key. Registers the provider source. |
| `src/server/model-catalog.ts` | Provider row for the model pickers. |
| `components/settings/keys-section.tsx` | Row, editor and the **Add a provider** entry. |
| `docs/custom-providers.md` | User doc section "Anthropic-compatible endpoint". |
| `handoff/` | Research note and live probe scripts. Untracked, local only. |

Run the live probes from the repo root (they need `LITELLM_KEY` in the shell):

```bash
npx tsx handoff/probes/lh_probe_deep.ts     # thinking, tool round trip, image
```
