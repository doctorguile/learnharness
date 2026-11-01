import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute, toolTimeoutMs } from "../tool-execute.ts";
// The search-hit shape lives in the core port since the search wave
// (2026-09-20); this alias keeps callers churn-free.
import type { SearchHit as WebSearchResult, SearchProvider } from "../../core/search.ts";
export type { WebSearchResult };
import { htmlToMarkdown } from "./web-extract.ts";
import { jinaReader, type PageReader } from "./web-keyless.ts";

/**
 * Server-side web tools for the researcher sub-agent:
 *
 *   web_search(query, count?) → {title, url, snippet}[]   (injected search port,
 *                                                          then keyless fallbacks)
 *   web_fetch(url)            → readable markdown text     (direct HTTP + Readability
 *                                                          + Turndown, then keyless
 *                                                          page readers)
 *
 * ROUTES (keyless fallback wave, 2026-11 — owner request: "if the built-in
 * route fails, we still have ways to do it"; the chain is ported from
 * pi-web-access 0.44, see web-keyless.ts):
 *
 *  web_search: keyed engine (Tavily/Brave, server/search.ts) → keyless
 *    engines in order (Exa MCP → DuckDuckGo → Surf, which runs DuckDuckGo
 *    in the owner's own Chrome; web-surf.ts). A fallback runs when the keyed
 *    engine is absent, throws, or returns zero hits. A fallback answer is
 *    LABELED ({engine, notice, results}) — never a silent substitute. This
 *    revises the 2026-09-20 "no silent fallback" rule: still not silent.
 *
 *  web_fetch: direct HTTP (markdown-first Accept, browser headers,
 *    Cloudflare-challenge detection) → keyless readers in order (Exa →
 *    Jina Reader → Surf, a real render in the owner's Chrome). Readers run on recoverable failures only: HTTP 401/403/
 *    429/5xx, network error or timeout, Cloudflare challenge, no readable
 *    article. 404/410, unsupported types and private hosts never leave the
 *    machine. The output names the route and why the direct fetch failed.
 *
 *  Both chains share the tool's time budget (webToolTimeoutMs, 75 s): each
 *  step gets a capped share so a hung primary still leaves room for the
 *  next route; the LAST route gets whatever is left.
 *
 * The fallback lists are injected (createWebTools' second argument): the
 * server composes them (server/search.ts webFallbacks — LH_WEB_FALLBACK=off
 * turns the keyless engines off). The default keeps the pre-wave behavior:
 * no search fallback, Jina Reader as the only fetch rescue — so tests that
 * inject nothing stay hermetic.
 *
 * Tool contract: NEVER throw into the agent loop — missing provider and
 * every failure path return a clear error STRING as the tool output, so the
 * researcher can adapt (or report) instead of crashing.
 */

/** The keyless routes, composed by the server and injected here. Resolved
 *  fresh per call (an env change or a new key lands on the next call). */
export interface WebFallbacks {
	/** Keyless engines, in order, after the keyed engine. */
	search: () => SearchProvider[];
	/** Keyless page readers, in order, after the direct fetch. */
	readers: () => PageReader[];
}

/** Pre-wave behavior: no search fallback, Jina Reader rescue on fetch. */
export const DEFAULT_WEB_FALLBACKS: WebFallbacks = { search: () => [], readers: () => [jinaReader()] };

// ── time budget ──────────────────────────────────────────────────────────────

/** The web tools' own guard: the fallback chains (ending in a real browser
 *  via Surf) need more than the 30 s default. 2.5 × toolTimeoutMs = 75 s;
 *  scales with the test seam. The researcher runs as a background job, so
 *  a long tool call blocks no lesson. */
const WEB_TOOL_TIMEOUT_FACTOR = 2.5;
export const webToolTimeoutMs = (): number => toolTimeoutMs.current * WEB_TOOL_TIMEOUT_FACTOR;
/** Leave the guard (tool-execute.ts) room to deliver our own result. */
const BUDGET_MARGIN_MS = 2_000;
/** Cap for the keyed search engine when fallbacks wait behind it. */
const PRIMARY_SEARCH_MS = 12_000;
/** Cap per keyless engine (the last one gets whatever is left). */
const FALLBACK_SEARCH_MS = 10_000;
/** Cap for the direct fetch when readers wait behind it. */
const DIRECT_FETCH_MS = 12_000;
/** Cap per keyless reader (the last one gets whatever is left). */
const READER_MS = 12_000;
/** Below this, a step cannot finish — skip it and report. */
const MIN_STEP_MS = 1_000;

class Budget {
	private readonly deadline: number;
	constructor(private readonly parent?: AbortSignal) {
		this.deadline = Date.now() + Math.max(MIN_STEP_MS, webToolTimeoutMs() - BUDGET_MARGIN_MS);
	}
	remaining(): number {
		return this.deadline - Date.now();
	}
	/** A signal for one step: the run's abort, the step cap, the deadline. */
	step(capMs = Infinity): AbortSignal {
		const ms = Math.max(1, Math.min(capMs, this.remaining()));
		return this.parent ? AbortSignal.any([this.parent, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
	}
	aborted(): boolean {
		return this.parent?.aborted ?? false;
	}
}

function errMsg(err: unknown): string {
	const msg = err instanceof Error ? err.message : String(err);
	return /abort|timeout/i.test(msg) && !/HTTP/.test(msg) ? "timed out" : msg;
}

// ── web_search ───────────────────────────────────────────────────────────────

const SEARCH_UNAVAILABLE =
	"web_search is not available: no search engine is configured. " +
	"Set a Tavily or Brave search API key in settings. Report in your brief that web search is unavailable.";

const ENGINE_LABEL: Record<string, string> = {
	exa: "Exa",
	duckduckgo: "DuckDuckGo",
	surf: "Surf (DuckDuckGo in your Chrome)",
	tavily: "Tavily",
	brave: "Brave",
};

/** A fallback answer: the hits plus WHY they did not come from the keyed
 *  engine (the researcher should say so in its brief when it matters). */
export interface FallbackSearchResult {
	engine: string;
	notice: string;
	results: WebSearchResult[];
}

async function runSearch(
	query: string,
	count: number,
	primary: SearchProvider | null,
	fallbacks: SearchProvider[],
	signal: AbortSignal | undefined,
): Promise<WebSearchResult[] | FallbackSearchResult | string> {
	const budget = new Budget(signal);

	// No fallbacks: the exact pre-wave contract.
	if (fallbacks.length === 0) {
		if (!primary) return SEARCH_UNAVAILABLE;
		try {
			return await primary.search(query, count, budget.step());
		} catch (err) {
			return `web_search failed: ${err instanceof Error ? err.message : String(err)}`;
		}
	}

	// Each attempt: the engine label + why it gave nothing (empty = it
	// answered with zero hits, which is a real answer, not a failure).
	const attempts: Array<{ label: string; reason: string; empty: boolean }> = [];
	let primaryReason = "No search API key is configured";
	if (primary) {
		const label = ENGINE_LABEL[primary.id] ?? primary.id;
		try {
			const hits = await primary.search(query, count, budget.step(PRIMARY_SEARCH_MS));
			if (hits.length > 0) return hits;
			primaryReason = `The configured engine (${label}) found no results`;
			attempts.push({ label, reason: "no results", empty: true });
		} catch (err) {
			primaryReason = `The configured engine (${label}) failed: ${errMsg(err)}`;
			attempts.push({ label, reason: errMsg(err), empty: false });
		}
	}

	for (const [i, engine] of fallbacks.entries()) {
		const label = ENGINE_LABEL[engine.id] ?? engine.id;
		const last = i === fallbacks.length - 1;
		if (budget.aborted()) break;
		if (budget.remaining() < MIN_STEP_MS) {
			attempts.push({ label, reason: "skipped (time budget used up)", empty: false });
			continue;
		}
		try {
			const hits = await engine.search(query, count, budget.step(last ? Infinity : FALLBACK_SEARCH_MS));
			if (hits.length > 0) {
				return {
					engine: label,
					notice: `${primaryReason}. These results come from the keyless ${label} fallback.`,
					results: hits,
				};
			}
			attempts.push({ label, reason: "no results", empty: true });
		} catch (err) {
			attempts.push({ label, reason: errMsg(err), empty: false });
		}
	}

	// Every engine answered and found nothing: an honest empty result.
	if (attempts.length > 0 && attempts.every((a) => a.empty)) return [];
	const summary = attempts.map((a) => `${a.label}: ${a.reason}`).join("; ");
	return primary
		? `web_search failed — ${summary}.`
		: `${SEARCH_UNAVAILABLE}\nKeyless fallbacks also failed — ${summary}.`;
}

// ── web_fetch ────────────────────────────────────────────────────────────────

const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
/** Servers that support markdown negotiation (Cloudflare Markdown for
 *  Agents, Mintlify, Vercel) answer markdown; others see browser order. */
const MARKDOWN_FIRST_ACCEPT =
	"text/markdown,text/html;q=0.9,application/xhtml+xml;q=0.9,application/xml;q=0.8,*/*;q=0.7";
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
/** Keep the researcher's context sane — long pages truncate with a marker. */
const MAX_CONTENT_CHARS = 40_000;

function truncate(text: string): string {
	if (text.length <= MAX_CONTENT_CHARS) return text;
	return `${text.slice(0, MAX_CONTENT_CHARS)}\n\n[Truncated at ${MAX_CONTENT_CHARS} characters]`;
}

/** Cloudflare interstitials served with HTTP 200 (pi-web-access rule): the
 *  header is authoritative; the body check needs BOTH challenge markers so a
 *  plain "Just a moment..." page never matches. */
export function isCloudflareChallenge(status: number, headers: Headers, text: string): boolean {
	if (headers.get("cf-mitigated") === "challenge") return true;
	if (status !== 200 && status !== 403 && status !== 503) return false;
	return (
		/<title>\s*Just a moment\.\.\.\s*<\/title>/i.test(text) &&
		text.includes("/cdn-cgi/challenge-platform/") &&
		/_cf_chl_opt/.test(text)
	);
}

/** Loopback, private and link-local hosts: never sent to third parties. */
export function isPrivateHost(hostname: string): boolean {
	const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
	if (h.includes(":")) return h === "::1" || /^f[cd][0-9a-f]{2}:/.test(h) || h.startsWith("fe80:");
	const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
	if (!m) return false;
	const [a, b] = [Number(m[1]), Number(m[2])];
	return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/** Direct fetch outcome: a finished tool answer, or a failure that says
 *  whether a keyless reader may try (recoverable) or not (final). */
type DirectResult = { ok: true; text: string } | { ok: false; reason: string; recoverable: boolean };

async function fetchDirect(url: string, signal: AbortSignal): Promise<DirectResult> {
	let resp: Response;
	try {
		resp = await fetch(url, {
			headers: {
				"User-Agent": USER_AGENT,
				Accept: MARKDOWN_FIRST_ACCEPT,
				"Accept-Language": "en-US,en;q=0.9",
				"Cache-Control": "no-cache",
				"Sec-Fetch-Dest": "document",
				"Sec-Fetch-Mode": "navigate",
				"Sec-Fetch-Site": "none",
				"Sec-Fetch-User": "?1",
				"Upgrade-Insecure-Requests": "1",
			},
			signal,
		});
	} catch (err) {
		return { ok: false, reason: errMsg(err), recoverable: true };
	}

	// Final URL after redirects + status — the researcher's only way to
	// tell a real page from a 200-served error body (owner-reported
	// "ill-formed request" case: the SITE answered, we just relayed it).
	const sourceLine = `Source: ${resp.url || url} (HTTP ${resp.status})`;
	const contentType = resp.headers.get("content-type") ?? "";

	if (!resp.ok) {
		const body = contentType.includes("html") ? await resp.text().catch(() => "") : "";
		if (isCloudflareChallenge(resp.status, resp.headers, body)) {
			return { ok: false, reason: `HTTP ${resp.status}: blocked by a Cloudflare challenge page`, recoverable: true };
		}
		const reason = `HTTP ${resp.status} ${resp.statusText}`.trim();
		return { ok: false, reason, recoverable: resp.status !== 404 && resp.status !== 410 };
	}

	if (contentType.includes("application/pdf")) {
		// Pointer, not dead-end (researcher PDF wave, 2026-10-07): the
		// researcher's web_fetch_pdf tool downloads + triages PDFs.
		return {
			ok: true,
			text: `web_fetch: this URL is a PDF document — call web_fetch_pdf on it to download and read it.`,
		};
	}
	if (/image\/|audio\/|video\/|zip|octet-stream/.test(contentType)) {
		return { ok: false, reason: `Unsupported content type: ${contentType.split(";")[0]}`, recoverable: false };
	}
	const length = Number(resp.headers.get("content-length") ?? 0);
	if (length > MAX_RESPONSE_BYTES) return { ok: false, reason: "Response too large", recoverable: false };

	let text: string;
	try {
		text = await resp.text();
	} catch (err) {
		return { ok: false, reason: errMsg(err), recoverable: true };
	}
	if (isCloudflareChallenge(resp.status, resp.headers, text)) {
		return { ok: false, reason: `HTTP ${resp.status}: blocked by a Cloudflare challenge page`, recoverable: true };
	}
	if (!contentType.includes("html")) return { ok: true, text: `${sourceLine}\n\n${truncate(text)}` }; // plain text / markdown / code

	const extracted = htmlToMarkdown(text);
	if (extracted) {
		const header = extracted.title ? `# ${extracted.title}\n\n${sourceLine}\n\n---\n\n` : `${sourceLine}\n\n---\n\n`;
		return { ok: true, text: header + truncate(extracted.content) };
	}
	return {
		ok: false,
		reason: "no readable content (the page may be JavaScript-rendered)",
		recoverable: true,
	};
}

async function fetchWithFallbacks(url: string, readers: PageReader[], signal: AbortSignal | undefined): Promise<string> {
	const budget = new Budget(signal);
	const direct = await fetchDirect(url, budget.step(readers.length > 0 ? DIRECT_FETCH_MS : Infinity));
	if (direct.ok) return direct.text;
	if (!direct.recoverable || readers.length === 0 || budget.aborted()) throw new Error(direct.reason);
	if (isPrivateHost(new URL(url).hostname)) {
		throw new Error(`${direct.reason} (keyless readers skipped: private address)`);
	}

	const failures: string[] = [];
	for (const [i, reader] of readers.entries()) {
		if (budget.aborted()) break;
		if (budget.remaining() < MIN_STEP_MS) {
			failures.push(`${reader.label}: skipped (time budget used up)`);
			continue;
		}
		const last = i === readers.length - 1;
		try {
			const page = await reader.read(url, budget.step(last ? Infinity : READER_MS));
			const sourceLine = `Source: ${url} (via ${reader.label} fallback — direct fetch failed: ${direct.reason})`;
			const header = page.title ? `# ${page.title}\n\n${sourceLine}\n\n---\n\n` : `${sourceLine}\n\n---\n\n`;
			return header + truncate(page.content);
		} catch (err) {
			failures.push(`${reader.label}: ${errMsg(err)}`);
		}
	}
	throw new Error(`${direct.reason}; fallbacks failed — ${failures.join("; ")}`);
}

// ── tool registry ────────────────────────────────────────────────────────────

const webSearchInput = Type.Object({
	query: Type.String({ description: "The search query (a normal search string, phrases included)" }),
	count: Type.Optional(
		Type.Integer({ minimum: 1, maximum: 10, description: "Number of results (default 5, max 10)" }),
	),
});

const webFetchInput = Type.Object({
	url: Type.String({ description: "The URL to fetch" }),
});

export function createWebTools(
	search: () => SearchProvider | null,
	fallbacks: WebFallbacks = DEFAULT_WEB_FALLBACKS,
): Record<string, AgentTool<any>> {
	return {
		web_search: {
			name: "web_search",
			label: "web_search",
			description: "Search the web. One search per call — use one call per search angle. " +
				"Returns an array of results with title, url, and snippet. When the configured engine is " +
				"unavailable, a keyless fallback may answer instead: {engine, notice, results}.",
			parameters: webSearchInput,
			execute: serverExecute("web_search", webSearchInput, async ({ query, count }, ctx) =>
				runSearch(query, count ?? 5, search(), fallbacks.search(), ctx.signal),
			{ timeoutMs: webToolTimeoutMs }),
		},

		web_fetch: {
			name: "web_fetch",
			label: "web_fetch",
			description:
				"Fetch a web page and extract its readable content as markdown (Readability). " +
				"Handles HTML pages and plain text; blocked or JS-rendered pages fall back to a reader service " +
				"(the Source line names the route).",
			parameters: webFetchInput,
			execute: serverExecute("web_fetch", webFetchInput, async ({ url }, ctx): Promise<string> => {
				try {
					const parsed = new URL(url);
					// URL.protocol carries a TRAILING COLON ("https:", WHATWG) — the
					// colon-less comparison born from the py-harness port (urlparse's
					// scheme has NO colon) rejected every valid URL ever fetched
					// (owner-reported via OpenRouter logs, 2026-10-07).
					if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
						throw new Error("Only http(s) URLs are supported");
				} catch {
					return `web_fetch failed: invalid URL "${url}"`;
				}
				try {
					return await fetchWithFallbacks(url, fallbacks.readers(), ctx.signal);
				} catch (err) {
					return `web_fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`;
				}
			}, { timeoutMs: webToolTimeoutMs }),
		},
	};
}

/** The provider-less backstop (tests pin the shape with it; the runner
 *  always injects the real seams — an absent seam reads as unavailable,
 *  never a crash). */
export const webTools = createWebTools(() => null);
