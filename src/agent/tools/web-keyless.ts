import { parseHTML } from "linkedom";
import type { SearchHit, SearchProvider } from "../../core/search.ts";

/**
 * Keyless web fallbacks for the researcher's web tools — a selective port of
 * pi-web-access 0.44 (MIT, github.com/nicobailon/pi-web-access): exa.ts
 * (Exa's public MCP endpoint), duckduckgo.ts (DuckDuckGo HTML search) and
 * extract.ts (Jina Reader). No API key is needed for any of them.
 *
 * Why: the built-in routes fail in common cases — no Tavily/Brave key, a
 * rate-limited key, a 403 or Cloudflare page on direct fetch, a JS-only page,
 * or a network filter that blocks one of the services. web.ts tries these in
 * order and LABELS the route that answered, so the fallback is never silent.
 *
 * Privacy: each fallback is a third-party service. The search query or the
 * target URL goes to Exa, DuckDuckGo or Jina. The server can turn the Exa and
 * DuckDuckGo fallbacks off with LH_WEB_FALLBACK=off (src/server/search.ts).
 *
 * Every function takes an injectable fetch (tests never touch the network)
 * and an AbortSignal (web.ts owns the time budget). Failures THROW with a
 * short message; web.ts collects them for the tool output.
 */

/** The wire-callable shape (tests inject a stub). */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** A keyless page reader: URL → markdown, or throw with a short reason. */
export interface PageReader {
	/** Label for the tool output ("Exa", "Jina Reader"). */
	label: string;
	read(url: string, signal: AbortSignal): Promise<{ title: string; content: string }>;
}

const MIN_USEFUL_CONTENT = 200;

// ── Exa MCP (keyless) ────────────────────────────────────────────────────────
// https://mcp.exa.ai/mcp speaks MCP over streamable HTTP. One JSON-RPC
// tools/call per request; the answer arrives as an SSE "data:" line or as
// plain JSON. Tools checked live (tools/list, 2026-11): web_search_exa
// {query, objective, numResults} and web_fetch_exa {urls, maxCharacters}.

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";

interface McpRpcResponse {
	result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
	error?: { code?: number; message?: string };
}

function parseMcpBody(body: string): McpRpcResponse | null {
	const candidates = [
		...body.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()),
		body,
	];
	for (const payload of candidates) {
		if (!payload) continue;
		try {
			const parsed = JSON.parse(payload) as McpRpcResponse;
			if (parsed?.result || parsed?.error) return parsed;
		} catch {
			/* not this line */
		}
	}
	return null;
}

/** Call one Exa MCP tool and return its first text content. Throws on any
 *  HTTP, RPC or tool error. */
export async function callExaMcp(
	tool: string,
	args: Record<string, unknown>,
	signal: AbortSignal,
	fetchFn: FetchLike = fetch,
): Promise<string> {
	const resp = await fetchFn(`${EXA_MCP_URL}?tools=${tool}`, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
		signal,
	});
	if (!resp.ok) {
		const text = await resp.text().catch(() => "");
		const hint = resp.status === 429 ? " (keyless rate limit reached)" : "";
		throw new Error(`Exa MCP HTTP ${resp.status}${hint}: ${text.slice(0, 200)}`);
	}
	const parsed = parseMcpBody(await resp.text());
	if (!parsed) throw new Error("Exa MCP returned an empty response");
	if (parsed.error) throw new Error(`Exa MCP error ${parsed.error.code ?? ""}: ${parsed.error.message ?? "unknown"}`.trim());
	const text = parsed.result?.content?.find((c) => c.type === "text" && c.text?.trim())?.text ?? "";
	if (parsed.result?.isError) throw new Error(text.trim().slice(0, 300) || "Exa MCP tool error");
	if (!text) throw new Error("Exa MCP returned empty content");
	return text;
}

/** Exa answers web_search_exa as "Title: / URL: / Highlights: | Text:" blocks
 *  (some deployments answer raw Exa JSON). Pure; exported for tests. */
export function parseExaSearchText(text: string): SearchHit[] {
	try {
		const json = JSON.parse(text) as { results?: Array<{ title?: string; url?: string; text?: string; highlights?: string[] }> };
		if (Array.isArray(json.results)) {
			return json.results
				.filter((r) => typeof r.url === "string" && r.url)
				.map((r) => ({
					title: r.title || r.url!,
					url: r.url!,
					snippet: snippetOf(r.highlights?.join(" ") || r.text || ""),
				}));
		}
	} catch {
		/* text blocks below */
	}
	return text
		.split(/(?=^Title: )/m)
		.map((block) => {
			const title = block.match(/^Title: (.+)/m)?.[1]?.trim() ?? "";
			const url = block.match(/^URL: (.+)/m)?.[1]?.trim() ?? "";
			const body = block.match(/\n(?:Text|Highlights):\s*\n?([\s\S]*)$/)?.[1] ?? "";
			return { title: title || url, url, snippet: snippetOf(body.replace(/\n---\s*$/, "")) };
		})
		.filter((hit) => /^https?:\/\//.test(hit.url));
}

function snippetOf(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, 500);
}

export function exaSearchProvider(fetchFn: FetchLike = fetch): SearchProvider {
	return {
		id: "exa",
		async search(query, count, signal = AbortSignal.timeout(20_000)) {
			const text = await callExaMcp(
				"web_search_exa",
				{ query, objective: query, numResults: Math.min(count, 10) },
				signal,
				fetchFn,
			);
			return parseExaSearchText(text).slice(0, count);
		},
	};
}

/** web_fetch_exa answers "# Title\nURL: …\n\n<markdown>". */
export function exaReader(fetchFn: FetchLike = fetch, maxCharacters = 40_000): PageReader {
	return {
		label: "Exa",
		async read(url, signal) {
			const text = await callExaMcp("web_fetch_exa", { urls: [url], maxCharacters }, signal, fetchFn);
			const title = text.match(/^# (.+)/)?.[1]?.trim() ?? "";
			const content = text.replace(/^# .+\n/, "").replace(/^URL: .+\n/, "").trim();
			if (content.length < MIN_USEFUL_CONTENT) throw new Error("Exa returned too little content");
			return { title, content };
		},
	};
}

// ── DuckDuckGo HTML (keyless) ────────────────────────────────────────────────
// html.duckduckgo.com serves plain HTML results. It often answers bots with
// HTTP 202 and an "anomaly" page instead — detected and reported as blocked.

const DDG_URL = "https://html.duckduckgo.com/html/";

function decodeDdgUrl(href: string): string | null {
	try {
		const link = new URL(href, DDG_URL);
		const target = new URL(link.searchParams.get("uddg") ?? link.href);
		return target.protocol === "http:" || target.protocol === "https:" ? target.href : null;
	} catch {
		return null;
	}
}

/** Parse the DuckDuckGo HTML results page. Pure; exported for tests. */
export function parseDuckDuckGoHtml(html: string, count: number): SearchHit[] {
	const { document } = parseHTML(html);
	if (document.querySelector(".anomaly-modal__box, #challenge-form")) {
		throw new Error("DuckDuckGo answered with a bot check");
	}
	const hits: SearchHit[] = [];
	let parseable = 0;
	for (const node of document.querySelectorAll(".result")) {
		if (node.classList.contains("result--ad")) continue;
		const anchor = node.querySelector(".result__a");
		const title = anchor?.textContent?.trim() ?? "";
		const url = decodeDdgUrl(anchor?.getAttribute("href")?.trim() ?? "");
		if (!title || !url) continue;
		parseable++;
		hits.push({ title, url, snippet: snippetOf(node.querySelector(".result__snippet")?.textContent ?? "") });
		if (hits.length >= count) break;
	}
	if (parseable === 0 && !document.querySelector(".no-results__message")) {
		throw new Error("DuckDuckGo returned no parseable results");
	}
	return hits;
}

export function duckDuckGoProvider(fetchFn: FetchLike = fetch): SearchProvider {
	return {
		id: "duckduckgo",
		async search(query, count, signal = AbortSignal.timeout(15_000)) {
			const url = new URL(DDG_URL);
			url.searchParams.set("q", query);
			const resp = await fetchFn(url.toString(), {
				headers: {
					accept: "text/html",
					"user-agent": "Mozilla/5.0 (compatible; LearnHarness research; +https://github.com/nicobailon/pi-web-access)",
				},
				signal,
			});
			if (resp.status === 202) throw new Error("DuckDuckGo answered with a bot check (HTTP 202)");
			if (!resp.ok) throw new Error(`DuckDuckGo HTTP ${resp.status}`);
			return parseDuckDuckGoHtml(await resp.text(), count);
		},
	};
}

// ── Jina Reader (keyless) ────────────────────────────────────────────────────
// r.jina.ai renders the page (JS included) and answers with a header block
// ending in "Markdown Content:". A network filter can answer for it with an
// HTML block page — no marker, so it reads as a failure.

export function jinaReader(fetchFn: FetchLike = fetch): PageReader {
	return {
		label: "Jina Reader",
		async read(url, signal) {
			const resp = await fetchFn(`https://r.jina.ai/${url}`, {
				headers: { accept: "text/markdown", "x-no-cache": "true" },
				signal,
			});
			if (!resp.ok) throw new Error(`Jina Reader HTTP ${resp.status}`);
			const body = await resp.text();
			const marker = "Markdown Content:";
			const start = body.indexOf(marker);
			if (start < 0) throw new Error("Jina Reader returned no markdown (the service may be blocked on this network)");
			const content = body.slice(start + marker.length).trim();
			if (
				content.length < MIN_USEFUL_CONTENT ||
				content.startsWith("Loading...") ||
				content.startsWith("Please enable JavaScript")
			) {
				throw new Error("Jina Reader returned too little content");
			}
			const title = body.match(/^Title: (.+)$/m)?.[1]?.trim() ?? "";
			return { title, content };
		},
	};
}
