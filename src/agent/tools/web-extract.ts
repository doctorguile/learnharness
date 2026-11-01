import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

/**
 * HTML → readable markdown (Readability + Turndown), shared by the direct
 * fetch (web.ts) and the Surf browser reader (web-surf.ts).
 */

export const MIN_USEFUL_CONTENT = 200;

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

/** The main article as markdown, or null when Readability finds none or
 *  it is shorter than MIN_USEFUL_CONTENT. */
export function htmlToMarkdown(html: string): { title: string; content: string } | null {
	const { document } = parseHTML(html);
	const article = new Readability(document as unknown as Document).parse();
	if (!article?.content) return null;
	const markdown = turndown.turndown(article.content);
	if (markdown.trim().length < MIN_USEFUL_CONTENT) return null;
	return { title: article.title ?? "", content: markdown };
}

/** Last resort for pages Readability rejects (feeds, app shells): the
 *  visible body text, whitespace collapsed. Null when too short. */
export function htmlToPlainText(html: string): { title: string; content: string } | null {
	// textContent glues adjacent elements ("SitemapOur story"): put a line
	// break after block elements and a space after inline ones first.
	const spaced = html
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|li|h[1-6]|section|article|header|footer|nav|main|aside|tr|ul|ol|table|blockquote|pre)>/gi, "$&\n")
		.replace(/<\/(a|span|button|label|td|th|strong|em|b|i)>/gi, "$& ");
	const { document } = parseHTML(spaced);
	document.querySelectorAll("script,style,noscript,template,svg").forEach((n: Element) => n.remove());
	const text = (document.body?.textContent ?? "").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
	if (text.length < MIN_USEFUL_CONTENT) return null;
	return { title: document.title?.trim() ?? "", content: text };
}
