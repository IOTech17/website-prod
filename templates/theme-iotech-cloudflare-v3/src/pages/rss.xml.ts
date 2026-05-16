import type { APIRoute } from "astro";
import { getEmDashCollection, getSiteSettings } from "emdash";

const RE_TRAILING_SLASH = /\/$/;
const RE_AMP = /&/g;
const RE_LT = /</g;
const RE_GT = />/g;

function escapeXml(str: string) {
	return (str || "").replace(RE_AMP, "&amp;").replace(RE_LT, "&lt;").replace(RE_GT, "&gt;");
}

export const GET: APIRoute = async ({ site }) => {
	const settings = await getSiteSettings();
	const { entries: posts } = await getEmDashCollection("posts", {
		orderBy: { published_at: "desc" },
		limit: 20,
	});

	const baseUrl = site?.toString().replace(RE_TRAILING_SLASH, "") || "https://iotech17.com";

	const items = posts
		.map(
			(post) => `
  <item>
    <title>${escapeXml(post.data.title ?? "")}</title>
    <link>${baseUrl}/posts/${post.id}</link>
    <description>${escapeXml(post.data.excerpt ?? "")}</description>
    ${post.data.publishedAt ? `<pubDate>${post.data.publishedAt.toUTCString()}</pubDate>` : ""}
    <guid>${baseUrl}/posts/${post.id}</guid>
  </item>`,
		)
		.join("");

	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(settings.title ?? "")}</title>
    <description>${escapeXml(settings.tagline ?? "")}</description>
    <link>${baseUrl}</link>
    <language>fr</language>
    <atom:link href="${baseUrl}/rss.xml" rel="self" type="application/rss+xml"/>
    ${items}
  </channel>
</rss>`;

	return new Response(xml, {
		headers: { "Content-Type": "application/xml" },
	});
};
