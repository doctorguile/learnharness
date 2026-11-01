/**
 * The Anthropic-compatible endpoint: pi's built-in Anthropic catalog served
 * from a configured base URL. Pins:
 *   1. Connect verifies BEFORE it saves: /v1/models, the catalog intersection,
 *      then a 1-token /v1/messages call through pi-ai's own client.
 *   2. The key (LITELLM_KEY) only ever travels to the configured base URL.
 *   3. Connected models keep catalog metadata and prices; the picker sees them.
 *   4. Disconnect retires the provider and forgets the saved key.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { normalizeContext, type AnthropicMessagesCompat } from "@earendil-works/pi-ai";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-anthropic-compatible-"));
process.env.LH_DATA_DIR = dir;
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
// The developer shell may export the real key; this suite owns the name.
delete process.env.LITELLM_KEY;
const SETTINGS_FILE = path.join(dir, "settings.json");
const AUTH_FILE = path.join(dir, "auth.json");

const BASE = "https://proxy.example.test";
const KEY = "sk-test-litellm-key-0123";
const realFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = realFetch;
	fs.rmSync(dir, { recursive: true, force: true });
	delete process.env.LH_DATA_DIR;
	delete process.env.LH_AUTH_FILE;
	delete process.env.LITELLM_KEY;
});

type Route = typeof import("../app/api/anthropic-compatible/route.ts");
type Server = typeof import("../src/server/index.ts");
type Lib = typeof import("../src/server/anthropic-compatible.ts");
type Models = typeof import("../src/agent/models.ts");
type Settings = typeof import("../src/core/settings.ts");
let route: Route;
let server: Server;
let lib: Lib;
let models: Models;
let settings: Settings;
before(async () => {
	server = await import("../src/server/index.ts");
	route = await import("../app/api/anthropic-compatible/route.ts");
	lib = await import("../src/server/anthropic-compatible.ts");
	models = await import("../src/agent/models.ts");
	settings = await import("../src/core/settings.ts");
});

interface Seen { url: string; method: string; apiKey: string | null; body?: Record<string, unknown> }
let seen: Seen[] = [];

function sse(events: [string, object][]): Response {
	const text = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
	return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** A fake endpoint: /v1/models lists `listed`; /v1/messages answers "ok" or `messagesStatus`. */
function endpoint(listed: string[], messagesStatus = 200): void {
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		const body = request.method === "POST" ? await request.clone().json() as Record<string, unknown> : undefined;
		seen.push({ url: request.url, method: request.method, apiKey: request.headers.get("x-api-key"), body });
		const url = new URL(request.url);
		if (url.origin !== BASE) throw new Error(`unexpected host ${url.origin}`);
		if (url.pathname === "/v1/models") return Response.json({ data: [...listed.map((id) => ({ id })), { id: "gemini-2.5-pro" }, { id: "text-embedding-005" }] });
		if (url.pathname === "/v1/messages") {
			if (messagesStatus !== 200) return Response.json({ type: "error", error: { type: "authentication_error", message: "bad key" } }, { status: messagesStatus });
			const model = String(body?.model);
			return sse([
				["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } }],
				["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
				["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
				["content_block_stop", { type: "content_block_stop", index: 0 }],
				["message_delta", { type: "message_delta", delta: { stop_reason: "max_tokens", stop_sequence: null }, usage: { output_tokens: 1 } }],
				["message_stop", { type: "message_stop" }],
			]);
		}
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
}

function request(method: "POST" | "DELETE", payload: object): Request {
	return new Request("http://localhost/api/anthropic-compatible", {
		method,
		headers: { "content-type": "application/json", origin: "http://localhost" },
		body: JSON.stringify(payload),
	});
}

function stored(): { anthropicCompatible?: { baseUrl?: string; models?: string[] } } {
	return fs.existsSync(SETTINGS_FILE) ? JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8")) : {};
}
function authFile(): Record<string, string> {
	return fs.existsSync(AUTH_FILE) ? JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8")) : {};
}

/** Two real catalog ids (the cheapest one is the connect-check target). */
function catalogIds(): { cheap: string; other: string } {
	const catalog = models.piModels().getModels("anthropic");
	const sorted = [...catalog].sort((a, b) => a.cost.output - b.cost.output || a.id.localeCompare(b.id));
	return { cheap: sorted[0]!.id, other: sorted[sorted.length - 1]!.id };
}

beforeEach(async () => {
	seen = [];
	await route.DELETE(request("DELETE", {}));
	fs.rmSync(SETTINGS_FILE, { force: true });
	seen = [];
});

describe("anthropicCompatible settings section", () => {
	it("normalizes the base URL and parses ids; invalid URLs drop", () => {
		const out = settings.sanitizeUserSettings({ version: 1, anthropicCompatible: { baseUrl: "https://x.test/", models: ["a", " a ", "b", 3] } });
		assert.deepEqual(out?.anthropicCompatible, { baseUrl: "https://x.test", models: ["a", "b"] });
		const bad = settings.sanitizeUserSettings({ version: 1, anthropicCompatible: { baseUrl: "ftp://x.test" } });
		assert.deepEqual(bad?.anthropicCompatible, {});
	});
});

describe("buildAnthropicCompatibleProvider", () => {
	it("restamps catalog models and resolves the base URL together with the key", async () => {
		const catalog = models.piModels().getModels("anthropic");
		const { cheap } = catalogIds();
		let key: string | undefined = KEY;
		const provider = lib.buildAnthropicCompatibleProvider({ baseUrl: BASE, ids: [cheap], catalog, key: () => key });
		const [model] = provider.getModels();
		assert.equal(provider.getModels().length, 1);
		assert.equal(model!.provider, "anthropic-compatible");
		assert.equal(model!.baseUrl, BASE);
		const original = catalog.find((m) => m.id === cheap)!;
		assert.deepEqual(model!.cost, original.cost, "catalog prices are kept (list-price estimates)");
		assert.equal(model!.contextWindow, original.contextWindow);
		assert.equal((model!.compat as AnthropicMessagesCompat | undefined)?.supportsMidConvoEffort, false, "beta-dependent effort messages off (gateway 400)");
		assert.equal((model!.compat as AnthropicMessagesCompat | undefined)?.supportsMidConvoToolChanges, false, "beta-dependent tool changes off (gateway 400)");

		const auth = (provider.auth as { apiKey: { resolve: (a: unknown) => Promise<unknown> } }).apiKey;
		const resolved = await auth.resolve({ signal: new AbortController().signal }) as { auth: { apiKey: string; baseUrl: string } };
		assert.deepEqual(resolved.auth, { apiKey: KEY, baseUrl: BASE });
		key = undefined;
		assert.equal(await auth.resolve({ signal: new AbortController().signal }), undefined, "no key → not configured");
	});

	it("latestPerFamily keeps the newest version of each family", () => {
		assert.deepEqual(lib.latestPerFamily([
			"claude-opus-4-6", "claude-opus-4-8", "claude-opus-5", "claude-opus-5-5",
			"claude-sonnet-4-6", "claude-sonnet-5",
			"claude-haiku-4-5-20251001", "claude-haiku-4-5",
			"claude-fable-5", "claude-fable-5-1",
			"odd-model",
		]), ["claude-fable-5-1", "claude-haiku-4-5", "claude-opus-5-5", "claude-sonnet-5", "odd-model"]);
		// 5.1 beats 5 and every 4.x; a dated snapshot only when no alias exists.
		assert.deepEqual(lib.latestPerFamily(["claude-opus-4-8", "claude-opus-5-1", "claude-opus-5"]), ["claude-opus-5-1"]);
		assert.deepEqual(lib.latestPerFamily(["claude-haiku-4-5-20251001", "claude-haiku-4-5-20250101"]), ["claude-haiku-4-5-20251001"]);
		// 10 > 9 numerically, not lexically.
		assert.deepEqual(lib.latestPerFamily(["claude-opus-9", "claude-opus-10"]), ["claude-opus-10"]);
	});

	it("intersectCatalog keeps only listed catalog ids", () => {
		const catalog = models.piModels().getModels("anthropic");
		const { cheap, other } = catalogIds();
		assert.deepEqual(lib.intersectCatalog(catalog, [other, "gemini-2.5-pro", cheap, "anthropic/" + cheap]), [cheap, other].sort());
	});
});

describe("POST /api/anthropic-compatible", () => {
	it("verifies, then saves config and key; the picker gets priced models", async () => {
		const listed = ["claude-haiku-4-5-20251001", "claude-haiku-5-5", "claude-sonnet-4-6", "claude-sonnet-5-5"];
		const latest = ["claude-haiku-5-5", "claude-sonnet-5-5"];
		const catalog = models.piModels().getModels("anthropic");
		assert.ok(listed.every((id) => catalog.some((m) => m.id === id)), "fixture ids are in pi's catalog");
		endpoint(listed);
		const res = await route.POST(request("POST", { baseUrl: `${BASE}/`, key: KEY }));
		const body = await res.json() as { models: string[]; checkedModel: string };
		assert.equal(res.status, 200, JSON.stringify(body));
		assert.deepEqual(body.models, latest, "older versions of each family are dropped");
		assert.equal(body.checkedModel, lib.cheapestModel(catalog, latest)!.id, "the check uses the cheapest kept model");

		assert.deepEqual(stored().anthropicCompatible, { baseUrl: BASE, models: latest });
		assert.equal(authFile().LITELLM_KEY, KEY);
		assert.ok(seen.every((s) => s.url.startsWith(`${BASE}/v1/`) && s.apiKey === KEY), "the key only goes to the configured base URL");
		const messages = seen.find((s) => s.url.includes("/v1/messages"))!;
		assert.equal(messages.body?.max_tokens, 1);

		const picker = server.modelCatalog();
		const row = picker.providers.find((p) => p.id === "anthropic-compatible");
		assert.deepEqual(row, { id: "anthropic-compatible", envVar: "LITELLM_KEY", keyPresent: true });
		const entries = picker.models.filter((m) => m.provider === "anthropic-compatible");
		assert.deepEqual(entries.map((m) => m.id), latest);
		assert.ok(entries.every((m) => m.cost !== null), "cost shows list-price estimates");
		assert.equal(server.providerKeyPresent("anthropic-compatible"), true);
		assert.ok(server.keyStatuses().some((s) => s.id === "LITELLM_KEY" && s.present && s.source === "file"));
	});

	it("a failed messages check saves nothing", async () => {
		const { cheap } = catalogIds();
		endpoint([cheap], 401);
		const res = await route.POST(request("POST", { baseUrl: BASE, key: KEY }));
		assert.equal(res.status, 502);
		assert.match((await res.json() as { error: string }).error, /Messages API check failed/);
		assert.equal(stored().anthropicCompatible, undefined);
		assert.equal(authFile().LITELLM_KEY, undefined);
		assert.equal(models.piModels().getProvider("anthropic-compatible"), undefined);
	});

	it("an endpoint that lists no catalog ids is refused", async () => {
		endpoint([]);
		const res = await route.POST(request("POST", { baseUrl: BASE, key: KEY }));
		assert.equal(res.status, 502);
		assert.equal(seen.some((s) => s.url.includes("/v1/messages")), false);
	});

	it("needs a key; the stored one is reused when the field is blank", async () => {
		const { cheap } = catalogIds();
		endpoint([cheap]);
		assert.equal((await route.POST(request("POST", { baseUrl: BASE }))).status, 400);
		server.saveKey("LITELLM_KEY", KEY);
		const res = await route.POST(request("POST", { baseUrl: BASE }));
		assert.equal(res.status, 200);
		assert.ok(seen.filter((s) => s.apiKey !== null).every((s) => s.apiKey === KEY));
	});

	it("rejects untrusted origins and bad URLs", async () => {
		const res = await route.POST(new Request("http://localhost/api/anthropic-compatible", { method: "POST", headers: { "content-type": "application/json", origin: "http://evil.test" }, body: JSON.stringify({ baseUrl: BASE, key: KEY }) }));
		assert.equal(res.status, 403);
		assert.equal((await route.POST(request("POST", { baseUrl: "https://u:p@x.test", key: KEY }))).status, 400);
	});
});

describe("engine turn", () => {
	it("piEngineForSpec streams through the configured base URL with the current key", async () => {
		const { cheap } = catalogIds();
		endpoint([cheap]);
		assert.equal((await route.POST(request("POST", { baseUrl: BASE, key: KEY }))).status, 200);
		seen = [];
		const engine = models.piEngineForSpec({ provider: "anthropic-compatible", id: cheap, thinkingLevel: "off" });
		const reply = await engine.streamFn(engine.model, normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }), {}).result();
		assert.equal(reply.stopReason, "length");
		assert.equal(seen.length, 1);
		assert.ok(seen[0]!.url.startsWith(`${BASE}/v1/messages`), seen[0]!.url);
		assert.equal(seen[0]!.apiKey, KEY);
	});
});

describe("gateway wire format", () => {
	it("a multi-turn thinking request sends effort top-level, never inside messages", async () => {
		const id = "claude-haiku-5-5";
		const original = models.piModels().getModels("anthropic").find((m) => m.id === id)!;
		assert.equal((original.compat as AnthropicMessagesCompat | undefined)?.supportsMidConvoEffort, true, "the catalog model would send mid-conversation effort");
		endpoint([id]);
		assert.equal((await route.POST(request("POST", { baseUrl: BASE, key: KEY }))).status, 200);
		seen = [];
		const engine = models.piEngineForSpec({ provider: "anthropic-compatible", id, thinkingLevel: "low" });
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		await engine.streamFn(engine.model, normalizeContext({ messages: [
			{ role: "user", content: "Remember 7.", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "OK." }], api: engine.model.api, provider: engine.model.provider, model: id, usage, stopReason: "stop", timestamp: 2 },
			{ role: "user", content: "Which number?", timestamp: 3 },
		] }), {}).result();
		const body = seen.find((s) => s.url.includes("/v1/messages"))!.body!;
		assert.equal(JSON.stringify(body.messages).includes("output_config"), false, "messages.N.output_config is rejected by LiteLLM \u2192 Vertex");
		assert.ok(body.output_config, "effort rides top-level output_config");
	});
});

describe("DELETE /api/anthropic-compatible", () => {
	it("retires the provider and forgets the saved key", async () => {
		const { cheap } = catalogIds();
		endpoint([cheap]);
		assert.equal((await route.POST(request("POST", { baseUrl: BASE, key: KEY }))).status, 200);
		assert.ok(models.piModels().getProvider("anthropic-compatible"));
		const res = await route.DELETE(request("DELETE", {}));
		assert.equal(res.status, 200);
		assert.equal(stored().anthropicCompatible, undefined);
		assert.equal(authFile().LITELLM_KEY, undefined);
		assert.equal(models.piModels().getProvider("anthropic-compatible"), undefined);
		assert.equal(server.modelCatalog().providers.some((p) => p.id === "anthropic-compatible"), false);
	});
});
