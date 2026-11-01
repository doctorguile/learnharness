/**
 * The Anthropic-compatible endpoint: pi-ai's built-in Anthropic catalog served
 * from a user-configured base URL over the native Messages API (for example a
 * LiteLLM proxy at https://litellm.example.com, no /v1 suffix).
 *
 * - Models: the catalog ids that the endpoint's /v1/models also lists,
 *   snapshotted at connect. Catalog metadata (limits, thinking, prices) is
 *   kept, so cost shows Anthropic list prices as estimates.
 * - Key: ANTHROPIC_COMPATIBLE.envVar (LITELLM_KEY), read per request from
 *   process.env (the keys seam reflects the file copy there; env wins).
 * - The base URL is resolved WITH the key, per request (pi-ai applies an
 *   auth-supplied baseUrl over the model's). A key can therefore never travel
 *   to a URL other than the one currently configured.
 */

import { createModels, createProvider, type Api, type Model, type MutableModels, type Provider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { APP_IDENTITY, configureProviderSource, piModels } from "../agent/models.ts";
import { ANTHROPIC_COMPATIBLE } from "../core/auth-keys.ts";
import { normalizeBaseUrl, type AnthropicCompatibleSettings } from "../core/settings.ts";
import { readSettings } from "../store/settings.ts";
import { CustomBodyLimitError, readBoundedJson } from "./custom-provider-body.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** The live key (env first; the keys seam fill-gaps the saved file copy). */
export function anthropicCompatibleKey(): string | undefined {
	return process.env[ANTHROPIC_COMPATIBLE.envVar]?.trim() || undefined;
}

/**
 * Catalog compat flags that depend on anthropic-beta headers a gateway may not
 * forward (ported from the dotfiles anthropic-litellm package). LiteLLM drops
 * unknown betas, so the request reaches Vertex without them:
 *   supportsMidConvoEffort      → 400 messages.1.output_config: Extra inputs are not permitted
 *   supportsMidConvoToolChanges → 400 Input tag 'tool_addition' / 'tool_removal' does not match
 * With both off, pi sends top-level output_config.effort and the full current
 * tool list on each request. supportsMidConvoSystemMessages needs no beta and
 * stays as the catalog sets it.
 */
export const GATEWAY_COMPAT = {
	supportsMidConvoEffort: false,
	supportsMidConvoToolChanges: false,
} as const;

/** Build the provider. `catalog` is pi's built-in Anthropic model list; only
 *  `ids` are kept, each restamped with this provider id and base URL, with
 *  the beta-dependent compat flags off (GATEWAY_COMPAT). */
export function buildAnthropicCompatibleProvider(input: {
	baseUrl: string;
	ids: readonly string[];
	catalog: readonly Model<Api>[];
	key: () => string | undefined;
}): Provider<Api> {
	const keep = new Set(input.ids);
	return createProvider<Api>({
		id: ANTHROPIC_COMPATIBLE.id,
		name: ANTHROPIC_COMPATIBLE.label,
		baseUrl: input.baseUrl,
		auth: { apiKey: {
			name: `${ANTHROPIC_COMPATIBLE.label} key`,
			resolve: async () => {
				const apiKey = input.key();
				// No key → "not configured" (pi-ai fails the stream honestly).
				return apiKey ? { auth: { apiKey, baseUrl: input.baseUrl }, source: ANTHROPIC_COMPATIBLE.envVar } : undefined;
			},
		} },
		models: input.catalog
			.filter((m) => keep.has(m.id))
			.map((m) => ({ ...m, provider: ANTHROPIC_COMPATIBLE.id, baseUrl: input.baseUrl, compat: { ...m.compat, ...GATEWAY_COMPAT } })),
		api: anthropicMessagesApi(),
	});
}

/** The usable stored config, or undefined. */
export function anthropicCompatibleSettings(): (AnthropicCompatibleSettings & { baseUrl: string; models: string[] }) | undefined {
	const s = readSettings()?.anthropicCompatible;
	return s?.baseUrl && s.models?.length ? { ...s, baseUrl: s.baseUrl, models: s.models } : undefined;
}

/** Register the source: on every piModels() sync, publish or retire the
 *  provider when the stored config changes. */
export function installAnthropicCompatibleSource(): void {
	let fingerprint: string | undefined;
	configureProviderSource({
		owns: (id) => id === ANTHROPIC_COMPATIBLE.id,
		sync(models: MutableModels) {
			const s = anthropicCompatibleSettings();
			const next = JSON.stringify(s ?? null);
			if (next === fingerprint) return;
			if (s) models.setProvider(buildAnthropicCompatibleProvider({ baseUrl: s.baseUrl, ids: s.models, catalog: models.getModels("anthropic"), key: anthropicCompatibleKey }));
			else models.deleteProvider(ANTHROPIC_COMPATIBLE.id);
			fingerprint = next;
		},
	}, ANTHROPIC_COMPATIBLE.id);
}

/** Is the provider registered AND its key present? */
export function anthropicCompatibleAvailable(): boolean {
	return piModels().getProvider(ANTHROPIC_COMPATIBLE.id) !== undefined && anthropicCompatibleKey() !== undefined;
}

export type AnthropicDiscoverResult =
	| { ok: true; ids: string[] }
	| { ok: false; error: string; status?: number };

/** GET {base}/v1/models with Anthropic-style auth (x-api-key). Redirects are
 *  refused so the key cannot follow a redirect to another host. */
export async function discoverAnthropicModels(baseUrl: string, apiKey: string): Promise<AnthropicDiscoverResult> {
	const base = normalizeBaseUrl(baseUrl);
	if (!base) return { ok: false, error: "Base URL must be a valid http(s) URL" };
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 15_000);
	try {
		const res = await fetch(`${base}/v1/models?limit=1000`, {
			headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
			signal: controller.signal,
			redirect: "manual",
		});
		if (res.status >= 300 && res.status < 400) {
			await res.body?.cancel();
			return { ok: false, error: "Discovery redirects are not allowed" };
		}
		if (!res.ok) { await res.body?.cancel(); return { ok: false, error: `Endpoint returned HTTP ${res.status} for /v1/models`, status: res.status }; }
		const body = await readBoundedJson(res, 8 * 1024 * 1024);
		const rows = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.data) ? body.data : isRecord(body) && Array.isArray(body.models) ? body.models : null;
		if (!rows) return { ok: false, error: "Endpoint response was not a model list" };
		const ids = rows.map((row) => (typeof row === "string" ? row : isRecord(row) && typeof row.id === "string" ? row.id : "").trim()).filter(Boolean);
		return { ok: true, ids: [...new Set(ids)] };
	} catch (err) {
		return { ok: false, error: err instanceof CustomBodyLimitError ? err.message : controller.signal.aborted ? "Endpoint timed out" : "Discovery request failed" };
	} finally {
		clearTimeout(timer);
	}
}

/** Pi's Anthropic catalog ids that the endpoint lists, sorted. */
export function intersectCatalog(catalog: readonly Model<Api>[], listed: readonly string[]): string[] {
	const listedSet = new Set(listed);
	return catalog.map((m) => m.id).filter((id) => listedSet.has(id)).sort((a, b) => a.localeCompare(b));
}

/** `claude-<family>-<major>[-<minor>][-<yyyymmdd>]`. A 1–2 digit minor only;
 *  an 8-digit tail is a snapshot date. */
const CLAUDE_ID = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-(\d{8}))?$/;

/**
 * Keep only the newest version of each family (opus, sonnet, haiku, fable, …):
 * highest major, then highest minor. At that version an undated alias wins
 * over dated snapshots; else the newest date. Ids that do not match the
 * pattern have no family to compare and are kept.
 */
export function latestPerFamily(ids: readonly string[]): string[] {
	type Entry = { id: string; major: number; minor: number; date: string };
	const best = new Map<string, Entry>();
	const kept: string[] = [];
	const rank = (e: Entry) => [e.major, e.minor, e.date === "" ? 1 : 0, Number(e.date || 0)];
	const newer = (a: Entry, b: Entry) => {
		const ra = rank(a), rb = rank(b);
		for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! > rb[i]!;
		return false;
	};
	for (const id of ids) {
		const match = CLAUDE_ID.exec(id);
		if (!match) { kept.push(id); continue; }
		const entry = { id, major: Number(match[2]), minor: Number(match[3] ?? 0), date: match[4] ?? "" };
		const current = best.get(match[1]!);
		if (!current || newer(entry, current)) best.set(match[1]!, entry);
	}
	return [...kept, ...[...best.values()].map((e) => e.id)].sort((a, b) => a.localeCompare(b));
}

/** The cheapest model by output price (ties: id order) — the connect check's
 *  target, so the check costs as little as possible. */
export function cheapestModel(catalog: readonly Model<Api>[], ids: readonly string[]): Model<Api> | undefined {
	const keep = new Set(ids);
	return catalog
		.filter((m) => keep.has(m.id))
		.sort((a, b) => a.cost.output - b.cost.output || a.id.localeCompare(b.id))[0];
}

/** The connect check: one 1-token Messages API call through pi-ai's own
 *  client, exactly as a real turn would send it. */
export async function checkAnthropicMessages(baseUrl: string, apiKey: string, model: Model<Api>): Promise<{ ok: true } | { ok: false; error: string }> {
	const provider = buildAnthropicCompatibleProvider({ baseUrl, ids: [model.id], catalog: [model], key: () => apiKey });
	const models = createModels({ identity: APP_IDENTITY });
	models.setProvider(provider);
	const target = models.getModel(ANTHROPIC_COMPATIBLE.id, model.id);
	if (!target) return { ok: false, error: "Connect check model is unavailable" };
	try {
		const reply = await models.completeSimple(target, {
			messages: [{ role: "user", content: "Reply with: ok", timestamp: Date.now() }],
		}, { maxTokens: 1, signal: AbortSignal.timeout(30_000) });
		if (reply.stopReason === "error" || reply.stopReason === "aborted") {
			return { ok: false, error: `Messages API check failed (${model.id}): ${reply.errorMessage ?? reply.stopReason}` };
		}
		return { ok: true };
	} catch (err) {
		return { ok: false, error: `Messages API check failed (${model.id}): ${err instanceof Error ? err.message : "request failed"}` };
	}
}
