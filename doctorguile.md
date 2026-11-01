# doctorguile fork: local macOS build notes

Personal notes for building and running LearnHarness locally on a Mac, without
an Apple Developer ID. This file is for the `doctorguile` branch only. It is not
part of the upstream project.

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
- Real provider or model use. Only the offline smoke checks ran.
- DMG and ZIP output (`make pack` uses `--dir`).
- Notarized release builds. Those need the upstream release path, not this Makefile.

---

## 8. Changes made

### In this repository (branch `doctorguile`)

- `Makefile` (new): the local build targets above.
- `doctorguile.md` (new): this file.
- No tracked file was changed. `next build` rewrites `next-env.d.ts`. That rewrite was reverted each time.

### Outside the repository

- **Keychain:** one self-signed code-signing identity, `LearnHarness Local Dev`, in the login keychain. Remove it with `security delete-identity -c "LearnHarness Local Dev"` if you no longer need it. The private key is stored there too.
- **Repo-local directories (git-ignored):** `node_modules/`, `.next/`, `dist/`.
- **`tmp/`:** an empty directory. It is not git-ignored. `make cert` writes key files there briefly and deletes them on exit.
- **Electron cache:** the Electron 44.9.3 zip, downloaded during `make pack`.
- **App profile:** `~/Library/Application Support/LearnHarness/`. Created on the first launch of the local build. It is a fresh profile, separate from any installed release. It includes `data/` and `chatgpt-credentials.json`. Do not share or commit this folder.
- **Crash reports:** three `LearnHarness-*.ips` files in `~/Library/Logs/DiagnosticReports/` from failed launches during testing (2026-11-01, 08:19 and 08:26). They can be deleted.
- **Git:** remote `doctorguile` added. Branch `doctorguile` created with `branch.doctorguile.remote` and `branch.doctorguile.merge` set. Nothing has been pushed.

No system-wide changes. No Xcode, Homebrew, or other software was installed.

---

## 9. Open items

- **Commit author:** resolved. The branch's commit uses the repository-local identity (`doctorguile <doctorguile@gmail.com>`), not the global one. For new commits, check `git config --local user.name` and `user.email` first.
- **`tmp/` is not git-ignored.** Consider adding `tmp/` to `.gitignore`. Not done, because it changes a tracked file.
- **Makefile target names** are my choice. Rename them freely.
- **Upstream release path** is unchanged. Release builds still use `npm run desktop:dist` and need a Developer ID certificate, the `LH_NOTARY` profile, and Xcode 26.

---

## 10. Push when ready

```bash
git push -u doctorguile doctorguile
```

After the first push, the `[gone]` marker in `git branch -vv` clears.
