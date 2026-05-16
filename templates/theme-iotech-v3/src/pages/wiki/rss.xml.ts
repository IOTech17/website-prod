import type { APIRoute } from "astro";
import { getSiteSettings } from "emdash";

export const prerender = false;

const RE_TRAILING_SLASH = /\/$/;
const RE_AMP = /&/g;
const RE_LT = /</g;
const RE_GT = />/g;
const RE_QUOT = /"/g;
const RE_HEADING = /^#+ .+$/gm;
const RE_INLINE_MD = /[*_`~]/g;

function esc(str: string) {
	return (str || "")
		.replace(RE_AMP, "&amp;")
		.replace(RE_LT, "&lt;")
		.replace(RE_GT, "&gt;")
		.replace(RE_QUOT, "&quot;");
}

function encodePath(path: string) {
	return path
		.split("/")
		.map((s) => encodeURIComponent(s))
		.join("/");
}

export const GET: APIRoute = async ({ url, site }) => {
	const settings = await getSiteSettings();
	const baseUrl = site?.toString().replace(RE_TRAILING_SLASH, "") || url.origin;

	let notes: Array<{
		path: string;
		title: string;
		content: string;
		tags: string[];
		updatedAt: string;
		visibility: string;
	}> = [];

	try {
		const res = await fetch(new URL("/_emdash/api/plugins/markdown-wiki/notes", url));
		if (res.ok) {
			const data = await res.json();
			notes = data?.data?.notes || data?.notes || [];
		}
	} catch {}

	// Public notes only, sorted by updatedAt desc
	const items = notes
		.filter((n) => n.visibility === "public")
		.toSorted((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
		.slice(0, 20);

	const rssItems = items
		.map((note) => {
			const link = `${baseUrl}/wiki/${encodePath(note.path)}`;
			const excerpt = note.content
				.replace(RE_HEADING, "")
				.replace(RE_INLINE_MD, "")
				.trim()
				.slice(0, 280);
			const categories = (note.tags || []).map((t) => `<category>${esc(t)}</category>`).join("");
			return `
  <item>
    <title>${esc(note.title)}</title>
    <link>${link}</link>
    <guid isPermaLink="true">${link}</guid>
    <pubDate>${new Date(note.updatedAt).toUTCString()}</pubDate>
    <description>${esc(excerpt)}</description>
    ${categories}
  </item>`;
		})
		.join("");

	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(settings.title ?? "")} — Wiki</title>
    <description>Notes publiques du wiki ${esc(settings.title ?? "")}</description>
    <link>${esc(baseUrl)}/wiki</link>
    <language>fr</language>
    <atom:link href="${esc(baseUrl)}/wiki/rss.xml" rel="self" type="application/rss+xml"/>
    ${rssItems}
  </channel>
</rss>`;

	return new Response(xml, {
		headers: {
			"Content-Type": "application/xml; charset=utf-8",
			"Cache-Control": "public, max-age=3600",
		},
	});
};
