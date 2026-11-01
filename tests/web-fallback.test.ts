/** Keyless web fallbacks (fallback wave, 2026-11): the chains in web.ts and
 * the keyless adapters in web-keyless.ts. No network — global fetch and
 * every adapter's fetchFn are stubs. */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createWebTools, isCloudflareChallenge, isPrivateHost, type WebFallbacks } from "../src/agent/tools/web.ts";
import {
	callExaMcp,
	duckDuckGoProvider,
	exaReader,
	exaSearchProvider,
	jinaReader,
	parseDuckDuckGoHtml,
	parseExaSearchText,
	type FetchLike,
	type PageReader,
} from "../src/agent/tools/web-keyless.ts";
import { webFallbacks } from "../src/server/search.ts";
import { htmlToPlainText } from "../src/agent/tools/web-extract.ts";
import {
	renderWithSurf,
	resolveSurfBinary,
	surfJson,
	surfReader,
	surfSearchProvider,
	type SurfRunner,
} from "../src/agent/tools/web-surf.ts";
import type { SearchHit, SearchProvider } from "../src/core/search.ts";

const HIT: SearchHit = { title: "t", url: "https://e.com/", snippet: "s" };
const LONG = "Readable fallback content. ".repeat(20);

function engine(id: SearchProvider["id"], impl: () => Promise<SearchHit[]>): SearchProvider & { calls: number } {
	const p = { id, calls: 0, async search() { p.calls++; return impl(); } };
	return p;
}

function reader(label: string, impl: () => Promise<{ title: string; content: string }>): PageReader & { calls: number } {
	const r = { label, calls: 0, async read() { r.calls++; return impl(); } };
	return r;
}

function fallbacks(search: SearchProvider[], readers: PageReader[] = []): WebFallbacks {
	return { search: () => search, readers: () => readers };
}

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});
function stubGlobalFetch(respond: () => Response) {
	globalThis.fetch = (async () => respond()) as typeof fetch;
}

describe("web_search keyless fallback chain", () => {
	it("no key → the first keyless engine answers, labeled with engine + notice", async () => {
		const exa = engine("exa", async () => [HIT]);
		const ddg = engine("duckduckgo", async () => [HIT]);
		const { web_search } = createWebTools(() => null, fallbacks([exa, ddg]));
		const out = await web_search!.execute!("c1", { query: "q" });
		assert.deepEqual(out.details, {
			engine: "Exa",
			notice: "No search API key is configured. These results come from the keyless Exa fallback.",
			results: [HIT],
		});
		assert.equal(ddg.calls, 0, "later fallbacks never run after a success");
	});

	it("keyed engine hits → its plain array, fallbacks untouched", async () => {
		const exa = engine("exa", async () => [HIT]);
		const { web_search } = createWebTools(() => engine("tavily", async () => [HIT]), fallbacks([exa]));
		const out = await web_search!.execute!("c1", { query: "q" });
		assert.deepEqual(out.details, [HIT]);
		assert.equal(exa.calls, 0);
	});

	it("keyed engine throws → fallback, and the notice says why", async () => {
		const brave = engine("brave", async () => { throw new Error("Brave search API 429: rate limited"); });
		const { web_search } = createWebTools(() => brave, fallbacks([engine("exa", async () => [HIT])]));
		const out = await web_search!.execute!("c1", { query: "q" });
		const details = out.details as { notice: string };
		assert.match(details.notice, /configured engine \(Brave\) failed: Brave search API 429/);
	});

	it("keyed engine empty → fallback; first fallback failing → next one answers", async () => {
		const exa = engine("exa", async () => { throw new Error("Exa MCP HTTP 429 (keyless rate limit reached)"); });
		const ddg = engine("duckduckgo", async () => [HIT]);
		const { web_search } = createWebTools(() => engine("tavily", async () => []), fallbacks([exa, ddg]));
		const out = await web_search!.execute!("c1", { query: "q" });
		const details = out.details as { engine: string; notice: string };
		assert.equal(details.engine, "DuckDuckGo");
		assert.match(details.notice, /Tavily\) found no results/);
	});

	it("no key and every fallback fails → the unavailable text plus each failure", async () => {
		const { web_search } = createWebTools(
			() => null,
			fallbacks([
				engine("exa", async () => { throw new Error("boom"); }),
				engine("duckduckgo", async () => { throw new Error("DuckDuckGo answered with a bot check (HTTP 202)"); }),
			]),
		);
		const out = String((await web_search!.execute!("c1", { query: "q" })).details);
		assert.match(out, /^web_search is not available: no search engine is configured\./);
		assert.match(out, /Keyless fallbacks also failed — Exa: boom; DuckDuckGo: DuckDuckGo answered with a bot check/);
	});

	it("every engine answers empty → an honest empty array, not an error", async () => {
		const { web_search } = createWebTools(
			() => engine("tavily", async () => []),
			fallbacks([engine("exa", async () => [])]),
		);
		assert.deepEqual((await web_search!.execute!("c1", { query: "q" })).details, []);
	});
});

describe("web_fetch keyless reader chain", () => {
	it("direct 403 → the first reader answers; the Source line names route and reason", async () => {
		stubGlobalFetch(() => new Response("nope", { status: 403, statusText: "Forbidden" }));
		const exa = reader("Exa", async () => ({ title: "Page", content: LONG }));
		const { web_fetch } = createWebTools(() => null, fallbacks([], [exa]));
		const out = String((await web_fetch!.execute!("c1", { url: "https://example.com/a" })).details);
		assert.match(out, /^# Page\n\nSource: https:\/\/example\.com\/a \(via Exa fallback — direct fetch failed: HTTP 403 Forbidden\)/);
		assert.match(out, /Readable fallback content/);
	});

	it("404 is final — no third-party reader is asked", async () => {
		stubGlobalFetch(() => new Response("gone", { status: 404, statusText: "Not Found" }));
		const exa = reader("Exa", async () => ({ title: "", content: LONG }));
		const { web_fetch } = createWebTools(() => null, fallbacks([], [exa]));
		const out = String((await web_fetch!.execute!("c1", { url: "https://example.com/a" })).details);
		assert.match(out, /web_fetch failed for https:\/\/example\.com\/a: HTTP 404/);
		assert.equal(exa.calls, 0);
	});

	it("a Cloudflare challenge served as 200 → reader", async () => {
		const challenge = `<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script>` +
			`<script src="/cdn-cgi/challenge-platform/h/b/orchestrate"></script>${"x".repeat(500)}</body></html>`;
		stubGlobalFetch(() => new Response(challenge, { status: 200, headers: { "content-type": "text/html" } }));
		const exa = reader("Exa", async () => ({ title: "", content: LONG }));
		const { web_fetch } = createWebTools(() => null, fallbacks([], [exa]));
		const out = String((await web_fetch!.execute!("c1", { url: "https://example.com/a" })).details);
		assert.match(out, /via Exa fallback — direct fetch failed: HTTP 200: blocked by a Cloudflare challenge page/);
	});

	it("readers fail in order → one message with every reason", async () => {
		stubGlobalFetch(() => new Response("<html><body><div id=app></div></body></html>", { headers: { "content-type": "text/html" } }));
		const { web_fetch } = createWebTools(
			() => null,
			fallbacks([], [
				reader("Exa", async () => { throw new Error("CRAWL_UNKNOWN_ERROR"); }),
				reader("Jina Reader", async () => { throw new Error("Jina Reader returned no markdown"); }),
			]),
		);
		const out = String((await web_fetch!.execute!("c1", { url: "https://example.com/a" })).details);
		assert.match(out, /no readable content .*; fallbacks failed — Exa: CRAWL_UNKNOWN_ERROR; Jina Reader: Jina Reader returned no markdown/);
	});

	it("private hosts never go to third-party readers", async () => {
		stubGlobalFetch(() => new Response("err", { status: 500, statusText: "Internal Server Error" }));
		const exa = reader("Exa", async () => ({ title: "", content: LONG }));
		const { web_fetch } = createWebTools(() => null, fallbacks([], [exa]));
		const out = String((await web_fetch!.execute!("c1", { url: "http://192.168.1.10/x" })).details);
		assert.match(out, /keyless readers skipped: private address/);
		assert.equal(exa.calls, 0);
	});

	it("a direct success never calls a reader", async () => {
		stubGlobalFetch(() => new Response(LONG, { headers: { "content-type": "text/markdown" } }));
		const exa = reader("Exa", async () => ({ title: "", content: LONG }));
		const { web_fetch } = createWebTools(() => null, fallbacks([], [exa]));
		const out = String((await web_fetch!.execute!("c1", { url: "https://example.com/a" })).details);
		assert.match(out, /^Source: https:\/\/example\.com\/a \(HTTP 200\)/);
		assert.equal(exa.calls, 0);
	});
});

describe("keyless adapters (web-keyless.ts)", () => {
	const sse = (payload: unknown) => new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});

	it("callExaMcp sends one JSON-RPC tools/call and reads the SSE data line", async () => {
		let seen: { url: string; body: unknown } | null = null;
		const fetchFn: FetchLike = async (url, init) => {
			seen = { url, body: JSON.parse(String(init.body)) };
			return sse({ result: { content: [{ type: "text", text: "hello" }] }, jsonrpc: "2.0", id: 1 });
		};
		assert.equal(await callExaMcp("web_fetch_exa", { urls: ["u"] }, AbortSignal.timeout(1000), fetchFn), "hello");
		assert.deepEqual(seen, {
			url: "https://mcp.exa.ai/mcp?tools=web_fetch_exa",
			body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "web_fetch_exa", arguments: { urls: ["u"] } } },
		});
	});

	it("callExaMcp surfaces tool errors and 429s", async () => {
		const toolErr: FetchLike = async () => sse({ result: { content: [{ type: "text", text: "Error fetching URL(s): CRAWL_UNKNOWN_ERROR" }], isError: true } });
		await assert.rejects(callExaMcp("t", {}, AbortSignal.timeout(1000), toolErr), /CRAWL_UNKNOWN_ERROR/);
		const limited: FetchLike = async () => new Response("slow down", { status: 429 });
		await assert.rejects(callExaMcp("t", {}, AbortSignal.timeout(1000), limited), /HTTP 429 \(keyless rate limit reached\)/);
	});

	it("parseExaSearchText reads Title/URL/Highlights blocks", () => {
		const text = "Title: A\nURL: https://a.dev/\nPublished: N/A\nHighlights:\nfirst  line\nsecond\n\nTitle: B\nURL: https://b.dev/\nText: body b\n---";
		assert.deepEqual(parseExaSearchText(text), [
			{ title: "A", url: "https://a.dev/", snippet: "first line second" },
			{ title: "B", url: "https://b.dev/", snippet: "body b" },
		]);
	});

	it("exaSearchProvider passes query + objective and caps the count", async () => {
		let args: Record<string, unknown> = {};
		const fetchFn: FetchLike = async (_url, init) => {
			args = (JSON.parse(String(init.body)) as { params: { arguments: Record<string, unknown> } }).params.arguments;
			return sse({ result: { content: [{ type: "text", text: "Title: A\nURL: https://a.dev/\nText: x" }] } });
		};
		const hits = await exaSearchProvider(fetchFn).search("rust lifetimes", 3);
		assert.deepEqual(args, { query: "rust lifetimes", objective: "rust lifetimes", numResults: 3 });
		assert.equal(hits[0]?.url, "https://a.dev/");
	});

	it("exaReader strips the title and URL header", async () => {
		const fetchFn: FetchLike = async () => sse({ result: { content: [{ type: "text", text: `# The Title\nURL: https://a.dev/\n\n${LONG}` }] } });
		const page = await exaReader(fetchFn).read("https://a.dev/", AbortSignal.timeout(1000));
		assert.equal(page.title, "The Title");
		assert.ok(page.content.startsWith("Readable fallback content."));
	});

	it("parseDuckDuckGoHtml decodes uddg links, skips ads, detects the bot check", () => {
		const html = `<div class="result result--ad"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fad.com">Ad</a></div>
			<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fsigmajs.org%2F">Sigma</a>
			<a class="result__snippet">Graph  rendering</a></div>`;
		assert.deepEqual(parseDuckDuckGoHtml(html, 5), [{ title: "Sigma", url: "https://sigmajs.org/", snippet: "Graph rendering" }]);
		assert.throws(() => parseDuckDuckGoHtml(`<div class="anomaly-modal__box"></div>`, 5), /bot check/);
	});

	it("duckDuckGoProvider treats HTTP 202 as a bot check", async () => {
		const fetchFn: FetchLike = async () => new Response("", { status: 202 });
		await assert.rejects(duckDuckGoProvider(fetchFn).search("q", 5), /bot check \(HTTP 202\)/);
	});

	it("jinaReader reads past the marker; a network block page fails clearly", async () => {
		const ok: FetchLike = async () => new Response(`Title: T\nURL Source: u\n\nMarkdown Content:\n${LONG}`);
		assert.equal((await jinaReader(ok).read("https://a.dev/", AbortSignal.timeout(1000))).title, "T");
		const blocked: FetchLike = async () => new Response("<html><title>Web Page Blocked</title></html>");
		await assert.rejects(jinaReader(blocked).read("https://a.dev/", AbortSignal.timeout(1000)), /blocked on this network/);
	});
});

describe("helpers + server composition", () => {
	it("isCloudflareChallenge: the header alone, or both body markers", () => {
		assert.equal(isCloudflareChallenge(200, new Headers({ "cf-mitigated": "challenge" }), ""), true);
		assert.equal(isCloudflareChallenge(200, new Headers(), "<title>Just a moment...</title>"), false);
	});

	it("htmlToPlainText keeps words apart across elements", () => {
		const html = `<html><head><title>M</title></head><body><nav><a href="/">Sitemap</a><a href="/s">Our story</a></nav><div>${"word ".repeat(60)}</div></body></html>`;
		const out = htmlToPlainText(html);
		assert.ok(out && /Sitemap Our story/.test(out.content), out?.content);
	});

	it("isPrivateHost", () => {
		for (const h of ["localhost", "127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.0.5", "169.254.1.1", "[::1]", "fd12:3456::1", "printer.local"]) {
			assert.equal(isPrivateHost(h), true, h);
		}
		for (const h of ["example.com", "8.8.8.8", "172.32.0.1", "fdroid.org"]) assert.equal(isPrivateHost(h), false, h);
	});

	it("webFallbacks: order, LH_WEB_FALLBACK=off, LH_SURF=off", () => {
		const noSurf = { PATH: "/nonexistent", HOME: "/nonexistent" };
		const on = webFallbacks(noSurf);
		assert.deepEqual(on.search().map((e) => e.id), ["exa", "duckduckgo"]);
		assert.deepEqual(on.readers().map((r) => r.label), ["Exa", "Jina Reader"]);

		const off = webFallbacks({ ...noSurf, LH_WEB_FALLBACK: "off" });
		assert.deepEqual(off.search(), []);
		assert.deepEqual(off.readers().map((r) => r.label), ["Jina Reader"]);

		// /bin/sh stands in for an executable surf binary.
		const withSurf = webFallbacks({ ...noSurf, LH_SURF_BIN: "/bin/sh" });
		assert.deepEqual(withSurf.search().map((e) => e.id), ["exa", "duckduckgo", "surf"]);
		assert.deepEqual(withSurf.readers().map((r) => r.label), ["Exa", "Jina Reader", "Surf (your Chrome)"]);
		assert.deepEqual(webFallbacks({ ...noSurf, LH_SURF_BIN: "/bin/sh", LH_WEB_FALLBACK: "off" }).readers().map((r) => r.label),
			["Jina Reader", "Surf (your Chrome)"], "Surf is local — LH_WEB_FALLBACK does not turn it off");
		assert.deepEqual(webFallbacks({ ...noSurf, LH_SURF_BIN: "/bin/sh", LH_SURF: "off" }).search().map((e) => e.id), ["exa", "duckduckgo"]);
	});
});

describe("Surf fallback (web-surf.ts) with a fake surf process", () => {
	const ok = (payload: unknown) => ({ code: 0, stdout: JSON.stringify(payload), stderr: "" });
	const fail = (code: string, message: string) => ({ code: 1, stdout: JSON.stringify({ error: { code, message } }), stderr: "" });
	const ARTICLE = `<html><head><title>T</title></head><body><article><h1>Heading</h1>${"<p>Rendered paragraph text for the reader. </p>".repeat(20)}</article></body></html>`;

	/** A scripted surf: answers by command name, records every call. */
	function fakeSurf(answers: Partial<Record<string, Array<ReturnType<typeof ok>>>>) {
		const calls: string[][] = [];
		const run: SurfRunner = async (args) => {
			calls.push(args);
			const cmd = args[0] === "--session" ? args[2]! : args[0]!;
			const queue = answers[cmd];
			const next = queue && queue.length > 1 ? queue.shift()! : queue?.[0];
			return next ?? ok({ success: true });
		};
		return { run, calls };
	}

	it("renders in a new session: new → wait.ready → page.html (with the 2.25 workaround flags) → close", async () => {
		const surf = fakeSurf({
			"wait.ready": [ok({ result: { state: "ready", href: "https://a.dev/final", title: "T" } })],
			js: [ok({ result: 5000 })],
			"page.html": [ok({ result: { html: ARTICLE } })],
		});
		const page = await renderWithSurf(surf.run, "https://a.dev/", AbortSignal.timeout(5000));
		assert.equal(page.html, ARTICLE);
		assert.equal(page.href, "https://a.dev/final");
		await new Promise((r) => setImmediate(r)); // the close is fire-and-forget
		const cmds = surf.calls.map((a) => (a[0] === "--session" ? a[2] : a[0]));
		assert.deepEqual(cmds, ["session.new", "wait.ready", "js", "page.html", "session.close"]);
		const html = surf.calls.find((a) => a[2] === "page.html")!;
		assert.deepEqual(html.slice(3), ["--selector", "html", "--strip-scripts", "--json"]);
		const name = surf.calls[0]![1];
		assert.match(name!, /^lh-\d+-/);
		assert.deepEqual(surf.calls.at(-1), ["session.close", name, "--json"], "the same session is closed");
	});

	it("a challenge page is retried while the browser solves it", async () => {
		const surf = fakeSurf({
			"wait.ready": [fail("page_challenge", "challenge page detected"), ok({ result: { state: "ready" } })],
			js: [ok({ result: 5000 })],
			"page.html": [ok({ result: { html: ARTICLE } })],
		});
		await renderWithSurf(surf.run, "https://a.dev/", AbortSignal.timeout(10_000));
		assert.equal(surf.calls.filter((a) => a[2] === "wait.ready").length, 2);
	});

	it("a login wall fails at once, and the window is still closed", async () => {
		const surf = fakeSurf({ "wait.ready": [fail("page_login", "login page detected")] });
		await assert.rejects(renderWithSurf(surf.run, "https://a.dev/", AbortSignal.timeout(5000)), /surf wait\.ready: login page detected/);
		await new Promise((r) => setImmediate(r));
		assert.equal(surf.calls.at(-1)?.[0], "session.close");
	});

	it("surfJson: unparseable output with a non-zero exit is a clear error", async () => {
		const run: SurfRunner = async () => ({ code: 1, stdout: "", stderr: "[surf tab=1]\nError: socket not found" });
		await assert.rejects(surfJson(run, ["session.new", "x", "u"], AbortSignal.timeout(1000)), /surf session\.new exited 1: Error: socket not found/);
	});

	it("surfReader turns the rendered HTML into markdown", async () => {
		const surf = fakeSurf({
			"wait.ready": [ok({ result: { state: "ready", title: "T" } })],
			js: [ok({ result: 5000 })],
			"page.html": [ok({ result: { html: ARTICLE } })],
		});
		const page = await surfReader(surf.run).read("https://a.dev/", AbortSignal.timeout(5000));
		assert.match(page.content, /Rendered paragraph text/);
	});

	it("surfSearchProvider loads DuckDuckGo HTML in the browser and parses it", async () => {
		const ddg = `<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fsigmajs.org%2F">Sigma</a><a class="result__snippet">Graphs</a></div>`;
		const surf = fakeSurf({
			"wait.ready": [ok({ result: { state: "ready" } })],
			js: [ok({ result: 5000 })],
			"page.html": [ok({ result: { html: ddg } })],
		});
		const hits = await surfSearchProvider(surf.run).search("sigma js", 5, AbortSignal.timeout(5000));
		assert.deepEqual(hits, [{ title: "Sigma", url: "https://sigmajs.org/", snippet: "Graphs" }]);
		assert.equal(surf.calls[0]![2], "https://html.duckduckgo.com/html/?q=sigma%20js");
	});

	it("resolveSurfBinary: LH_SURF=off wins; LH_SURF_BIN must be executable", () => {
		assert.equal(resolveSurfBinary({ LH_SURF: "off", LH_SURF_BIN: "/bin/sh" }), null);
		assert.equal(resolveSurfBinary({ LH_SURF_BIN: "/bin/sh", PATH: "", HOME: "/nonexistent" }), "/bin/sh");
		assert.notEqual(resolveSurfBinary({ LH_SURF_BIN: "/etc/hosts", PATH: "", HOME: "/nonexistent" }), "/etc/hosts");
	});
});
