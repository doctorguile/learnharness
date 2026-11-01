import { spawn } from "node:child_process";
import * as fs from "node:fs";
import type { SearchProvider } from "../../core/search.ts";
import { htmlToMarkdown, htmlToPlainText } from "./web-extract.ts";
import { parseDuckDuckGoHtml, type PageReader } from "./web-keyless.ts";

/**
 * Surf fallback (2026-11, owner request): the LAST route for web_search and
 * web_fetch. Surf (npm surf-cli) drives the owner's own Chrome through a
 * browser extension, so pages render with real JavaScript, real cookies and
 * a real browser fingerprint. Bot checks that stop plain HTTP (Cloudflare,
 * DuckDuckGo's 202 page) usually pass.
 *
 * One call = one surf session = one new unfocused Chrome window:
 *   session.new <name> <url> → wait.ready (challenge pages get retried while
 *   the browser solves them) → short settle for JS apps → page.html →
 *   session.close (always, also on error and abort).
 *
 * SUBTLE: surf 2.22–2.25 `page.html` fails with "Value is unserializable"
 * unless --selector is passed (the extension sends the absent selector as
 * undefined to chrome.scripting.executeScript). `--selector html` is the
 * workaround; `--strip-scripts` only drops <script> elements we do not
 * need. `surf js` is no alternative: its output is cut at ~50,000 chars.
 *
 * Privacy: the page loads with the owner's browser cookies. Content behind
 * the owner's logins can reach the model provider. Private hosts never get
 * here (web.ts skips every reader for them). LH_SURF=off turns Surf off.
 *
 * The process runner is injected (tests never start a browser).
 */

/** Run one surf command; resolves with the exit code and output (never
 *  rejects on a non-zero exit — surfJson reads the error JSON). */
export type SurfRunner = (args: string[], signal: AbortSignal) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Readiness cap. Cloudflare checks in real Chrome were seen to clear in
 *  ~12–25 s (glassdoor.com, 2026-11); Surf runs last with ~37 s left. */
const READY_CAP_MS = 30_000;
const CHALLENGE_RETRY_MS = 2_000;
const SETTLE_STEP_MS = 1_000;
const SETTLE_STEPS = 3;
/** Rendered pages shorter than this get a settle wait (JS still drawing). */
const SETTLE_MIN_TEXT = 500;
const CLOSE_TIMEOUT_MS = 5_000;

// ── binary + process ─────────────────────────────────────────────────────────

/** Find the surf binary: LH_SURF_BIN, then PATH, then common global-install
 *  folders (the packaged app starts with a minimal PATH that misses them). */
export function resolveSurfBinary(env: Record<string, string | undefined> = process.env): string | null {
	if (env.LH_SURF?.toLowerCase() === "off") return null;
	const home = env.HOME ?? "";
	const dirs = [
		...(env.PATH ?? "").split(":"),
		`${home}/npm/bin`,
		`${home}/.npm-global/bin`,
		`${home}/.local/bin`,
		`${home}/.bun/bin`,
		`${home}/.volta/bin`,
		"/opt/homebrew/bin",
		"/usr/local/bin",
	].filter(Boolean);
	const candidates = [env.LH_SURF_BIN, ...dirs.map((d) => `${d}/surf`)].filter((p): p is string => !!p);
	for (const candidate of candidates) {
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return candidate;
		} catch {
			/* next */
		}
	}
	return null;
}

/** The real runner. surf is a Node script (#!/usr/bin/env node); the
 *  packaged app may have no `node` on PATH, so a Node-script binary runs
 *  under this process's own executable (Electron with ELECTRON_RUN_AS_NODE
 *  in the app, plain node in dev) — the same idiom electron/main.cjs uses. */
export function surfProcessRunner(bin: string): SurfRunner {
	let command = bin;
	let prefix: string[] = [];
	try {
		const real = fs.realpathSync(bin);
		const head = fs.readFileSync(real, { encoding: "utf8", flag: "r" }).slice(0, 100);
		if (/^#!.*\bnode\b/.test(head)) {
			command = process.execPath;
			prefix = [real];
		}
	} catch {
		/* run the binary directly */
	}
	return (args, signal) =>
		new Promise((resolve, reject) => {
			if (signal.aborted) return reject(new Error("surf: aborted"));
			const child = spawn(command, [...prefix, ...args], {
				env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
			child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
			const onAbort = () => child.kill("SIGTERM");
			signal.addEventListener("abort", onAbort, { once: true });
			child.once("error", (err) => {
				signal.removeEventListener("abort", onAbort);
				reject(err);
			});
			child.once("close", (code) => {
				signal.removeEventListener("abort", onAbort);
				if (signal.aborted) reject(new Error("surf: timed out"));
				else resolve({ code: code ?? 1, stdout, stderr });
			});
		});
}

// ── protocol ─────────────────────────────────────────────────────────────────

class SurfError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
	}
}

/** Run with --json and parse. surf prints {"error":{code,message}} on
 *  failure (exit 1); anything unparseable reads as a failure too. */
export async function surfJson(run: SurfRunner, args: string[], signal: AbortSignal): Promise<Record<string, unknown>> {
	const { code, stdout, stderr } = await run([...args, "--json"], signal);
	let parsed: Record<string, unknown> | null = null;
	try {
		parsed = JSON.parse(stdout) as Record<string, unknown>;
	} catch {
		/* below */
	}
	const error = parsed?.error as { code?: string; message?: string } | undefined;
	if (error) throw new SurfError(error.code ?? "error", `surf ${args[0] === "--session" ? args[2] : args[0]}: ${error.message ?? error.code}`);
	if (!parsed || code !== 0) {
		const detail = (stderr || stdout).replace(/^\[surf [^\]]*\]\s*/gm, "").trim().slice(0, 200);
		throw new SurfError("error", `surf ${args[0]} exited ${code}: ${detail || "no output"}`);
	}
	return parsed;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(new Error("surf: timed out"));
		const t = setTimeout(resolve, ms);
		signal.addEventListener("abort", () => (clearTimeout(t), reject(new Error("surf: timed out"))), { once: true });
	});
}

let sessionSeq = 0;

/** Open `url` in a new surf window, wait for it, return the rendered HTML.
 *  The window is closed on every path. */
export async function renderWithSurf(
	run: SurfRunner,
	url: string,
	signal: AbortSignal,
	now: () => number = Date.now,
): Promise<{ html: string; href: string; title: string }> {
	// The step signal is the only clock web.ts gives us; track our own
	// deadline from the readiness cap so wait.ready never outlives it.
	const started = now();
	const name = `lh-${process.pid}-${Date.now().toString(36)}-${++sessionSeq}`;
	const session = ["--session", name];
	let opened = false;
	try {
		await surfJson(run, ["session.new", name, url], signal);
		opened = true;

		// Readiness. A challenge page fails fast; the real browser often
		// solves it within seconds, so retry until the cap.
		let ready: { href?: string; title?: string } = {};
		for (;;) {
			const left = READY_CAP_MS - (now() - started);
			try {
				const out = await surfJson(run, [...session, "wait.ready", "--timeout", String(Math.max(1_000, left))], signal);
				ready = (out.result ?? {}) as typeof ready;
				break;
			} catch (err) {
				const challenge = err instanceof SurfError && /challenge/i.test(`${err.code} ${err.message}`);
				if (!challenge || left <= CHALLENGE_RETRY_MS) throw err;
				await sleep(CHALLENGE_RETRY_MS, signal);
			}
		}

		// Settle: JS apps often draw after readyState=complete.
		for (let i = 0; i < SETTLE_STEPS; i++) {
			const out = await surfJson(run, [...session, "js", "return document.body ? document.body.innerText.length : 0"], signal);
			if (Number(out.result) >= SETTLE_MIN_TEXT) break;
			await sleep(SETTLE_STEP_MS, signal);
		}

		const page = await surfJson(run, [...session, "page.html", "--selector", "html", "--strip-scripts"], signal);
		const html = (page.result as { html?: unknown } | undefined)?.html;
		if (typeof html !== "string" || !html) throw new Error("surf page.html returned no HTML");
		return { html, href: ready.href ?? url, title: ready.title ?? "" };
	} finally {
		if (opened) {
			// Own short timeout: the window must close even after an abort.
			void run(["session.close", name, "--json"], AbortSignal.timeout(CLOSE_TIMEOUT_MS)).catch(() => {});
		}
	}
}

// ── adapters ─────────────────────────────────────────────────────────────────

export function surfReader(run: SurfRunner): PageReader {
	return {
		label: "Surf (your Chrome)",
		async read(url, signal) {
			const page = await renderWithSurf(run, url, signal);
			const extracted = htmlToMarkdown(page.html) ?? htmlToPlainText(page.html);
			if (!extracted) throw new Error("the rendered page has no readable content");
			return { title: extracted.title || page.title, content: extracted.content };
		},
	};
}

/** DuckDuckGo's HTML results, loaded in the owner's browser — the bot
 *  check that stops the plain-HTTP DuckDuckGo adapter usually passes. */
export function surfSearchProvider(run: SurfRunner): SearchProvider {
	return {
		id: "surf",
		async search(query, count, signal = AbortSignal.timeout(30_000)) {
			const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
			const page = await renderWithSurf(run, url, signal);
			return parseDuckDuckGoHtml(page.html, count);
		},
	};
}
