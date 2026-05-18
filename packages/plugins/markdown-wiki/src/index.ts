/**
 * Markdown Wiki Plugin for EmDash CMS
 * Routes: /_emdash/api/plugins/markdown-wiki/<route-name>
 */

import type { PluginDescriptor } from "emdash";

export function wikiPlugin(): PluginDescriptor {
	return {
		id: "markdown-wiki",
		version: "0.4.0",
		format: "standard",
		entrypoint: "@iotech/markdown-wiki/sandbox",
		capabilities: ["content:read", "media:write"],
		adminPages: [{ path: "/", label: "Wiki", icon: "book" }],
		storage: {
			notes: {
				indexes: ["path", "visibility", "updatedAt"],
			},
			history: {
				indexes: ["notePath", "createdAt"],
			},
			search_index: {
				indexes: ["token", "notePath"],
			},
			config: {
				indexes: ["key"],
			},
			attachments: {
				indexes: ["path", "uploadedAt"],
			},
		},
	};
}
