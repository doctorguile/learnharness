/** The Anthropic-compatible endpoint: connect (verify + save) and disconnect.
 * Host boundaries and mutations live behind the server barrel. */
import { anthropicCompatibleGet, anthropicCompatibleMutation } from "@/src/server";

export const dynamic = "force-dynamic";
export const GET = anthropicCompatibleGet;
export const POST = anthropicCompatibleMutation;
export const DELETE = anthropicCompatibleMutation;
