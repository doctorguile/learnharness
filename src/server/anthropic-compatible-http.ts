/** GET/POST/DELETE /api/anthropic-compatible. GET never returns the key.
 * POST verifies before it saves anything: /v1/models discovery, the catalog
 * intersection (newest version per family), then a 1-token /v1/messages call. */
import { piModels } from "../agent/models.ts";
import { ANTHROPIC_COMPATIBLE, genericProviderKeyGuard } from "../core/auth-keys.ts";
import { normalizeBaseUrl } from "../core/settings.ts";
import { readSettings, writeSettings } from "../store/settings.ts";
import { checkAnthropicMessages, cheapestModel, discoverAnthropicModels, intersectCatalog, latestPerFamily } from "./anthropic-compatible.ts";
import { CustomBodyLimitError, readBoundedJson } from "./custom-provider-body.ts";
import { trustedMutationRequest } from "./custom-provider-http.ts";
import { deleteKey, keyStatuses, keyValue, saveKey } from "./keys.ts";

const failure = (error: string, status = 400) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

function keySource(): "env" | "file" | "none" {
	return keyStatuses().find((s) => s.id === ANTHROPIC_COMPATIBLE.envVar)?.source ?? "none";
}

export function anthropicCompatibleGet(): Response {
	const s = readSettings()?.anthropicCompatible;
	return Response.json({
		baseUrl: s?.baseUrl ?? "",
		models: s?.models ?? [],
		keyPresent: keyValue(ANTHROPIC_COMPATIBLE.envVar) !== undefined,
		keySource: keySource(),
	}, { headers: { "cache-control": "no-store" } });
}

function writeSection(section: { baseUrl: string; models: string[] } | undefined): void {
	const { anthropicCompatible: _old, ...rest } = readSettings() ?? { version: 1 };
	writeSettings(section ? { ...rest, anthropicCompatible: section } : rest);
	piModels(); // re-sync the provider now
}

export async function anthropicCompatibleMutation(request: Request): Promise<Response> {
	if (!trustedMutationRequest(request)) return failure("Endpoint configuration requires a trusted same-origin request.", 403);
	if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return failure("JSON content-type is required.", 415);
	try {
		const body = await readBoundedJson(request, 64 * 1024, request.method === "DELETE");
		if (!body || typeof body !== "object" || Array.isArray(body)) return failure("Invalid JSON body");
		if (request.method === "DELETE") {
			writeSection(undefined);
			// Mirrors the custom endpoint: disconnect forgets the saved key. An
			// environment-owned key is not ours to remove and stays.
			if (keySource() === "file") deleteKey(ANTHROPIC_COMPATIBLE.envVar);
			return Response.json({ ok: true });
		}
		if (request.method !== "POST") return failure("Unsupported method", 405);
		const raw = body as Record<string, unknown>;
		const base = normalizeBaseUrl(typeof raw.baseUrl === "string" ? raw.baseUrl : "");
		if (!base) return failure("Base URL must be http(s), with no credentials, query or fragment.");
		if (raw.key !== undefined && typeof raw.key !== "string") return failure("API key must be a string.");
		const supplied = typeof raw.key === "string" && raw.key.trim() ? raw.key.trim() : undefined;
		if (supplied && keySource() === "env") return failure(`The environment supplies ${ANTHROPIC_COMPATIBLE.envVar}. Change the environment to replace it.`);
		if (supplied) {
			const shape = genericProviderKeyGuard(ANTHROPIC_COMPATIBLE.envVar, supplied);
			if (!shape.ok) return failure(shape.error);
		}
		const key = supplied ?? keyValue(ANTHROPIC_COMPATIBLE.envVar)?.trim();
		if (!key) return failure(`Enter a key (saved as ${ANTHROPIC_COMPATIBLE.envVar}).`);

		const found = await discoverAnthropicModels(base, key);
		if (!found.ok) return failure(found.error, 502);
		const catalog = piModels().getModels("anthropic");
		// Newest version per family only (older versions crowd the pickers).
		const ids = latestPerFamily(intersectCatalog(catalog, found.ids));
		if (!ids.length) return failure("The endpoint lists none of the built-in Anthropic model ids.", 502);
		const probe = cheapestModel(catalog, ids)!;
		const checked = await checkAnthropicMessages(base, key, probe);
		if (!checked.ok) return failure(checked.error, 502);

		if (supplied) {
			const saved = saveKey(ANTHROPIC_COMPATIBLE.envVar, supplied);
			if (!saved.ok) return failure(saved.error);
		}
		writeSection({ baseUrl: base, models: ids });
		return Response.json({ ok: true, models: ids, checkedModel: probe.id });
	} catch (error) {
		return failure(error instanceof CustomBodyLimitError ? "Configuration body exceeds 64 KiB." : error instanceof SyntaxError ? "Invalid JSON body." : "Unable to save endpoint configuration.", error instanceof CustomBodyLimitError ? 413 : error instanceof SyntaxError ? 400 : 500);
	}
}
