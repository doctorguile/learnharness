# LearnHarness notes

Working notes from code review. Sections 1–4 are checked against commit `5a15b74` (`main`) and the local profile on this Mac. Section 5 describes branch `keyless-web-fallback` (commits `a5ab950`, `c8ce811`). Where a point is my reading and not tested, it is marked.

---

## 1. How the app works

- Desktop app: Electron window plus a Next.js server on `127.0.0.1`. The server owns all state and calls the model providers the user configures (BYOK).
- Learning flow:
  1. **Probe.** The agent finds where understanding stops.
  2. **Plan.** It builds a dependency map from that point to the goal.
  3. **Teach.** It teaches step by step and asks questions.
  4. **Practice.** Separate chats pose problems.
- Background jobs (research, PDF reading, demos, visuals) run beside the teaching turn.
- After teaching, an extractor adds propositions and reasoning chains to a knowledge graph. Later sessions can read the graph.

Source: `README.md`, `docs/architecture.md`.

---

## 2. Where state is saved

### Packaged macOS app

```
~/Library/Application Support/LearnHarness/
├── data/                       all learning state (LH_DATA_DIR)
│   ├── chats/<id>.json
│   ├── jobs/<id>.json
│   ├── graph/                  knowledge graph files (section 3)
│   ├── settings.json
│   └── prompts/                only if prompts were edited
├── auth.json                   API keys, plaintext, mode 0600
├── chatgpt-credentials.json    subscription login token, plaintext
└── logs/main.log
```

- Electron forces `LH_DATA_DIR` to `userData/data` in the packaged app (`electron/main.cjs`). An environment variable cannot relocate it.
- Dev mode (`npm run dev`) uses the repo's `data/` and a repo-root `auth.json`. Both are gitignored. Dev mode honors `LH_DATA_DIR`.

### This Mac, current state

- Installed app `data/`: one chat (`title: "hi"`), `settings.json` (model slots on a LiteLLM Anthropic-compatible endpoint), empty `jobs/`. No `auth.json`.
- Repo `data/`: about 57 chats. Titles such as "getApiKey pin" and tool IDs such as `scratch-job-call` suggest test data, not the real profile (my reading).

---

## 3. How the state is organized

| Path | Contents | Format |
|---|---|---|
| `chats/<id>.json` | One conversation: messages, per-chat settings, usage log, plan tree | One JSON file, rewritten on save |
| `jobs/<id>.json` | One background job, its result, delivery status | One JSON file per job |
| `graph/nodes.jsonl` | Propositions (claims) | JSON lines |
| `graph/chains.jsonl` | Reasoning chains. Stored truth for graph edges. | JSON lines |
| `graph/coverage.jsonl` | Which teacher messages were already extracted | JSON lines |
| `graph/sessions.jsonl` | Extraction bookkeeping for notes imports | JSON lines |
| `graph/sources.json` | Notes-import metadata and usage | JSON map |
| `graph/source-organization.json` | Display names and folder placement for sources | JSON |
| `graph/positions.json` | Node layout. Rebuildable cache. | JSON |
| `graph/render-settings.json` | Graph render preferences | JSON |
| `graph/format.json` | Schema version for the graph family | JSON |
| `settings.json` | Non-secret preferences, stored as changes from defaults | JSON |
| `auth.json` | API keys | JSON, secret |

Notes:
- The graph stores propositions and how they connect. It stores no learner mastery score (`docs/architecture.md` §6).
- Chats carry a schema version. An older build refuses to read a newer chat file. All laptops must run the same version or a newer one.
- Graph files share one format version. A newer graph format throws on guarded reads.

---

## 4. Syncing between laptops

**The app has no sync feature.** Everything is plain files.

Why it matters:
- Chat writes rewrite the whole file. Settings writes do too.
- Graph writes are appends or rewrites of JSONL/JSON files.
- There is no cross-process lock. Two servers writing one file can lose messages or corrupt it.
- Sync tools make conflict copies (`chat_x 2.json`, `*.sync-conflict-*`). The app does not merge them.
- Background jobs live in the running process.

Rules:
1. **One active laptop at a time.** Quit the app (Cmd+Q) on A, let sync finish, then open it on B.
2. **Do not sync secrets casually.** `auth.json` and `chatgpt-credentials.json` are plaintext. Re-enter API keys on each laptop, or accept the risk.
3. **Same or newer app version** on every laptop.
4. **Imported notes:** source identity is a hash of the file path and name. The same notes file at a different path on the other laptop becomes a second source, with duplicate knowledge.

Options:

- **A. Manual copy.** Quit on A, copy `data/` to B with `rsync` or Finder. No conflicts. Simplest.
- **B. Sync folder.** Move the packaged `data/` into a synced folder and symlink it back. Not yet tested with the packaged app. Example:
  ```sh
  # quit the app first
  mv "$HOME/Library/Application Support/LearnHarness/data" "$HOME/Sync/LearnHarness-data"
  ln -s "$HOME/Sync/LearnHarness-data" "$HOME/Library/Application Support/LearnHarness/data"
  ```
  - Syncthing: peer-to-peer, no cloud.
  - iCloud or Dropbox: iCloud can evict files; both can make conflict copies.
- **C. One always-on machine plus remote browser (e.g. Tailscale).** No sync needed. The app has no login. File tools can read the host user's home folder. Do not expose it without adding authentication.

Recommendation: A if switching laptops now and then; B for automatic sync. Either way, one laptop open at a time.

---

## 5. How research works

State on branch `keyless-web-fallback`. `main` has only the old route (see "Before the change").

LearnHarness does **not** load `pi-web-access`. The research tools are its own code. The fallback chain is a port of the keyless parts of `pi-web-access` 0.44 (MIT, compatible with this AGPL project), plus Surf. No new npm dependencies.

### Run path

1. The teacher calls a research tool. The app saves a background job and starts a worker. The job is outside the teaching turn.
2. The worker is a separate agent loop with a 12-turn limit (`src/agent/subagents/researcher.ts`). Tools: `web_search`, `web_fetch`. For PDFs, also `web_fetch_pdf` and the local PDF readers.
3. `web_search` and `web_fetch` try routes in order until one gives content (chains below).
4. `web_fetch_pdf` (`pdf-read.ts`): downloads up to 25 MB into a per-job temp directory. Parsing is local (pdfjs).
5. The worker returns a brief: Summary, Findings with citations, Sources kept and dropped, Gaps.

The model sees only `web_search` and `web_fetch`. It never sees Exa, Jina or Surf as tools. The server code picks the route.

### `web_search` chain

```
Tavily/Brave (only if a key is set, max 12 s)
  └─ no key, error, or 0 hits → Exa MCP (keyless, max 10 s)
       └─ error or 0 hits → DuckDuckGo HTML (keyless, max 10 s)
            └─ error or 0 hits → Surf: DuckDuckGo in your Chrome (the remaining time)
```

- Keyed engine with hits: the same plain array as before.
- Fallback answer: `{engine, notice, results}`. The notice says why the keyed engine did not answer. The fallback is never silent.
- Every engine answered with 0 hits: `[]`.
- All failed, no key: the old "not available" text plus each route's error.

### `web_fetch` chain

```
direct HTTP (markdown-first Accept, browser Sec-Fetch headers, max 12 s)
  └─ 401/403/429/5xx, network error, timeout, Cloudflare challenge, no readable article
       → Exa web_fetch_exa (keyless, max 12 s)
            └─ error → Jina Reader (keyless, max 12 s)
                 └─ error → Surf: render in your Chrome (the remaining time)
```

- Direct HTML: Readability, then Turndown to markdown, capped at 40,000 characters. Plain text or markdown is returned as is. A PDF returns a pointer to `web_fetch_pdf`.
- Fallback output starts with `Source: <url> (via <route> fallback — direct fetch failed: <reason>)`.
- No fallback for 404/410, unsupported types, responses over 5 MB, or private hosts (localhost, 10.x, 172.16–31.x, 192.168.x, 169.254.x, `.local`, IPv6 loopback/ULA/link-local). Private URLs never leave the machine.
- Cloudflare detection is the `pi-web-access` rule: `cf-mitigated: challenge` header, or the "Just a moment..." title plus both challenge-platform markers.
- Surf output: Readability on the rendered HTML. If Readability finds no article, the visible body text (block elements on new lines).

### Time budget

- The web tools have their own guard: 75 s (2.5 × `toolTimeoutMs`, through a new `timeoutMs` option on `serverExecute` in `tool-execute.ts`). Other tools keep 30 s.
- Each step has a cap, so a slow step still leaves time for the next. The last route gets what is left.
- The researcher is a background job, so a long tool call blocks no lesson.

### Switches

| Variable | Effect |
|---|---|
| `LH_WEB_FALLBACK=off` | No Exa, no DuckDuckGo (third-party services). Jina Reader stays, as before the change. Surf is not affected. |
| `LH_SURF=off` | No Surf. |
| `LH_SURF_BIN=<path>` | Use this surf binary. |

Documented in `docs/development.md`.

### Privacy

- On fallback, the search query or URL goes to Exa, DuckDuckGo or Jina. Before the change, only Jina got URLs.
- Surf loads the page in your Chrome with your cookies. Content behind your logins can reach the model provider.

### Surf details

File: `src/agent/tools/web-surf.ts`. Surf (`surf-cli` 2.25.0, `~/npm/bin/surf`) drives your Chrome through its extension. One call:

```
session.new lh-<pid>-<id> <url>     new unfocused Chrome window
wait.ready                          a challenge page is retried every 2 s, up to 30 s
js innerText.length                 settle up to 3 s if the page has little text
page.html --selector html --strip-scripts --json
session.close                       always, also on error and timeout (own 5 s timeout)
```

- **Surf bug (2.22.0 and 2.25.0, still open):** `page.html` and `page.save` fail with `Value is unserializable [browser_error]` unless `--selector` is given. Cause, read in `dist/service-worker/index.js`: `chrome.scripting.executeScript({..., args:[e.selector, e.stripScripts]})`; an absent selector is `undefined` at index 0, which Chrome refuses. Tested: `--selector html` alone works (scripts kept); `--strip-scripts` alone fails; `--strip-scripts false` keeps scripts. Upgrading 2.22.0 → 2.25.0 did not fix it. The code passes `--selector html --strip-scripts` (the stripping is wanted, not needed for the bug). Reported: https://github.com/nicobailon/surf-cli/issues/423 (still present on `main` at `a69eecf`, `src/service-worker/index.ts` ~line 1700).
- `surf js` output is cut at about 50,000 characters (the JSON of the result). Do not use it to get page HTML.
- With the workaround, `page.html --json` returns the full page in one call (Reddit: 500 KB, ~0.1 s) as `{result: {html}}`.
- **Packaged app:** the app starts with a short `PATH`. The binary is found with `LH_SURF_BIN`, then `PATH`, then `~/npm/bin`, `~/.npm-global/bin`, `~/.local/bin`, `~/.bun/bin`, `~/.volta/bin`, `/opt/homebrew/bin`, `/usr/local/bin`. surf is a Node script, so it runs under the app's own executable with `ELECTRON_RUN_AS_NODE=1` (`node` may not be on `PATH`). Not yet tried in the packaged app.
- **Visible effect:** each Surf call opens and closes a Chrome window.

### Files

| File | Role |
|---|---|
| `src/agent/tools/web.ts` | The two chains, time budget, Cloudflare and private-host checks |
| `src/agent/tools/web-keyless.ts` | Exa MCP client (search + fetch), DuckDuckGo HTML, Jina Reader |
| `src/agent/tools/web-surf.ts` | Surf binary lookup, process runner, render, search and reader |
| `src/agent/tools/web-extract.ts` | HTML → markdown (Readability + Turndown); plain-text last resort |
| `src/agent/tool-execute.ts` | `serverExecute` per-tool `timeoutMs` option |
| `src/core/search.ts` | `SearchProvider` gets an optional `signal`; keyless engine ids `exa`, `duckduckgo`, `surf` |
| `src/server/search.ts` | `webFallbacks()`: route order and switches; Tavily/Brave accept the signal |
| `researcher.ts`, `runner.ts`, `chat-handler.ts` | Pass `webFallbacks` to the researcher |
| `tests/web-fallback.test.ts` | 31 tests, no network, fake surf process |

Checks: typecheck clean; lint has 0 errors (1 warning that was already there); full suite 3229/3230 pass. The one failure (`claude-code-tool-bridge` "binds 127.0.0.1") also fails on `main`.

### Live checks on this Mac (2026-11, no search key)

| Case | Result |
|---|---|
| Search, full chain | Exa answered, 1.2–1.3 s |
| Search, Surf only | DuckDuckGo results in Chrome, 1.6 s |
| Search, Exa + DuckDuckGo made to fail | Surf answered, 3.6 s |
| `npmjs.com/package/turndown` | Direct fetch OK |
| `glassdoor.com`, full chain | Direct: Cloudflare 403 detected → Exa answered |
| `glassdoor.com`, Surf only | One run: check page still shown at the old 20 s limit → fail; by hand it cleared after ~12 s, so the limit is now 30 s. Later runs: no check page, OK. Cloudflare does not show the check every time. |
| `reddit.com/r/rust/` | Direct: no article (JS page) → Exa answered; Surf only: rendered posts, 1.8 s |
| `medium.com/` | Exa too little, Jina 503 → Surf answered, 4.4 s (before Surf, every route failed) |
| `nowsecure.nl` | Every route: no readable content. Correct: the page has ~50 characters of text and no check page now. |
| 404 page | Error at once, no fallback |
| Surf windows left open | None (`surf session.list`) |

Facts found during the checks:
- **Jina Reader is blocked on this network.** `r.jina.ai` returns a "Web Page Blocked" filter page. That is why Exa is before Jina.
- **Plain-HTTP DuckDuckGo gets HTTP 202 (bot check) from this Mac.** In Chrome through Surf it works.
- Exa MCP's `web_search_exa` lists `objective` as required. The adapter sends `objective = query`. Exa also has a keyless `web_fetch_exa` tool, used as the first reader.

### Before the change (`main`)

- `web_search`: Tavily or Brave only. No key: a text message that search is unavailable.
- `web_fetch`: one HTTP GET (30 s, 5 MB), Readability + Turndown, Jina Reader if no article. No Cloudflare detection, no JavaScript, no cookies.
- Effect: docs, Wikipedia, arXiv, GitHub usually worked. Bot-protected sites, paywalls and many SPAs often failed.

### Options that were considered

- **A.** Keep as is.
- **B.** Cloudflare detection plus a self-hosted fetcher (Firecrawl or Crawl4AI).
- **C.** Port the keyless parts of `pi-web-access`. **Chosen** (by the agent, while the owner was away), then Surf added at the owner's request.
- **D.** Paid fetcher (Bright Data Web Unlocker).
- **E.** Manual: save the page or PDF and give the file to the teacher.

None of these defeats a human check (a CAPTCHA that needs a click). Surf passes many automatic checks because it is a real browser.

### Not done (possible next steps)

- **Surf bug** reported as nicobailon/surf-cli#423. When it is fixed, the code can keep `--selector html` (harmless).
- **Try Surf in the packaged app** (binary lookup and `ELECTRON_RUN_AS_NODE` are untested there).
- **Settings UI.** The search status line still says "no search engine configured" when no key is set. It does not mention the fallbacks.
- **Headless fallback without Surf.** The app's own browser (`headless.ts`) could render pages, but loading remote pages in the app's Electron window needs a security review.
- Firecrawl/Crawl4AI (option B) or Bright Data (option D) can be added as more `PageReader`s with no change to the chain.
- **Merge.** The branch is not merged into `main`.

---

## 6. Agent instructions (`AGENTS.md`)

- **The app reads no `AGENTS.md`, `CLAUDE.md` or skill files.** It uses `pi-agent-core` (the agent loop) and its own prompts, not the pi coding-agent harness that finds those files.
- `skills/learnharness/SKILL.md` in the repo is a skill for *outside* agents (like pi) to read your learning data. The app does not load it.
- **Prompt overrides** exist only for the prober, teacher and practice prompt parts: put a file in `data/prompts/<segment>.md` (packaged app: `~/Library/Application Support/LearnHarness/data/prompts/`) and switch it on in `settings.json` → `agent.prompts`, or in the Settings prompt screen. Details: `src/agent/prompts/README.md`.
- The researcher, PDF reader, demo builder and extractor prompts are constants in code (for example `INSTRUCTIONS` in `researcher.ts`). They cannot be changed without editing code.
- Setup facts about tools (like the surf bug) belong in **code** when the app runs the tool (`web-surf.ts` does), and in the **surf skill** (`~/dotfiles/.claude/skills/surf/SKILL.md`) for pi sessions that run `surf` directly. That skill now has a "Known bugs" section (`page.html`/`page.save` need `--selector`; `js` output cut at ~50,000 characters).

---

## 7. Open issues found while reviewing

- **Fixed.** `src/server/chat-handler.ts` (around line 111) said keyless servers never see the research tool. The code does not do this: `src/agent/tools/jobs.ts` says research dispatch does not depend on search credentials, and `searchAvailable` is passed through but never read by `jobTools`. The comment is now corrected.
- **Fixed.** `src/agent/tools/web.ts` header comment said research needs search configured. The header is rewritten.
- `docs/architecture.md` does not describe the research fetch path or its limits (Cloudflare, Jina). Candidate for an update.
