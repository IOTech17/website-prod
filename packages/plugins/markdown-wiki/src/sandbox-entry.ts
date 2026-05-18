/**
 * Markdown Wiki — Sandbox Entry (EmDash 0.10)
 *
 * Storage API: ctx.storage.<collection>.put/get/delete/query({where,orderBy,limit})
 * Routes: named keys → /_emdash/api/plugins/markdown-wiki/<name>
 * Admin: Block Kit UI for managing notes from the EmDash admin panel
 *
 * Security model:
 *  - Public read routes return only `visibility: "public"` notes by default.
 *  - A Bearer API key (stored in plugin config, generated via admin) grants full
 *    read access to all visibility levels. Used by Obsidian for two-way sync.
 *  - Write routes (create/update/delete/sync/move) always require EmDash admin auth.
 */

import { definePlugin, PluginRouteError } from "emdash";
import type { PluginContext } from "emdash";

// ── Types ──────────────────────────────────────────────────────────────────

export interface WikiNote {
	path: string;
	title: string;
	content: string;
	visibility: "public" | "private" | "clients";
	tags: string[];
	createdAt: string;
	updatedAt: string;
}

interface NoteHistory {
	notePath: string;
	content: string;
	createdAt: string;
}

interface SearchToken {
	token: string;
	notePath: string;
}

interface WikiConfig {
	key: string;
	value: string;
	updatedAt: string;
}

interface WikiAttachment {
	path: string; // vault-relative path, e.g. "attachments/screenshot.png"
	mediaId: string; // EmDash media record ID
	storageKey: string; // R2/local storage key
	url: string; // Stable serving URL: /_emdash/api/media/file/<storageKey>
	mimeType: string;
	size: number; // bytes
	uploadedAt: string;
}

type Storage = PluginContext["storage"] & {
	notes: {
		put: (id: string, data: WikiNote) => Promise<void>;
		get: (id: string) => Promise<WikiNote | null>;
		delete: (id: string) => Promise<void>;
		query: (opts?: {
			where?: Record<string, unknown>;
			orderBy?: Record<string, string>;
			limit?: number;
		}) => Promise<{ items: Array<{ id: string; data: WikiNote }>; hasMore?: boolean }>;
	};
	history: {
		put: (id: string, data: NoteHistory) => Promise<void>;
		delete: (id: string) => Promise<void>;
		query: (opts?: {
			where?: Record<string, unknown>;
			orderBy?: Record<string, string>;
			limit?: number;
		}) => Promise<{ items: Array<{ id: string; data: NoteHistory }> }>;
	};
	search_index: {
		put: (id: string, data: SearchToken) => Promise<void>;
		delete: (id: string) => Promise<void>;
		query: (opts?: {
			where?: Record<string, unknown>;
			limit?: number;
		}) => Promise<{ items: Array<{ id: string; data: SearchToken }> }>;
	};
	config: {
		put: (id: string, data: WikiConfig) => Promise<void>;
		get: (id: string) => Promise<WikiConfig | null>;
		delete: (id: string) => Promise<void>;
		query: (opts?: {
			where?: Record<string, unknown>;
		}) => Promise<{ items: Array<{ id: string; data: WikiConfig }> }>;
	};
	attachments: {
		put: (id: string, data: WikiAttachment) => Promise<void>;
		get: (id: string) => Promise<WikiAttachment | null>;
		delete: (id: string) => Promise<void>;
		query: (opts?: {
			where?: Record<string, unknown>;
			orderBy?: Record<string, string>;
			limit?: number;
		}) => Promise<{ items: Array<{ id: string; data: WikiAttachment }> }>;
	};
};

const MAX_HISTORY = 10;
const MAX_ATTACHMENT_SIZE = 20 * 1024 * 1024; // 20 MB

// Allowed MIME types for attachment uploads
const ALLOWED_MIME_TYPES = new Set([
	// Images — SVG excluded: browsers execute SVG as HTML/JS if served without
	// Content-Disposition: attachment, making it a stored XSS vector.
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/avif",
	"image/bmp",
	"image/tiff",
	// Documents
	"application/pdf",
	// Common files
	"text/plain",
	"text/csv",
	"text/markdown",
	"application/zip",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

const IMAGE_EXTENSIONS = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"avif",
	"bmp",
	"tiff",
]);

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} o`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

// ── Path validation ────────────────────────────────────────────────────────

// Validates a wiki note path. Returns a human-readable error string on failure,
// or null when the path is acceptable.
function validateNotePath(path: string): string | null {
	if (!path) return "path is required";
	if (!path.endsWith(".md")) return "path must end with .md";
	if (path.length > 512) return "path must be at most 512 characters";
	if (RE_INVALID_PATH_CHARS.test(path))
		return "path must not contain control characters";
	if (path.split("/").some((s) => s === ".."))
		return "path must not contain .. segments";
	return null;
}

// Module-scope regex constants to avoid re-compilation on every call
const RE_H1 = /^#\s+(.+)$/m;
const RE_MD_EXT = /\.md$/i;
const RE_SLUG_SEPS = /[-_]/g;
// Limit frontmatter to 4 KB to prevent catastrophic backtracking on notes that
// start with --- but lack a closing --- delimiter. Require EOL after closing ---
// to avoid matching horizontal rules (--- followed by text).
const RE_FRONTMATTER = /^---\r?\n([\s\S]{0,4096}?)\r?\n---(?:\r?\n|$)/; // \r?\n handles Windows CRLF
const RE_TAGS_LINE = /^tags:\s*\[(.+)\]/m; // inline: tags: [a, b]
const RE_TAGS_BLOCK = /^tags:\s*\r?\n((?:[ \t]*-[ \t]+.+\r?\n?)+)/m; // block: tags:\n  - a
const RE_TAGS_BLOCK_ITEM = /^[ \t]*-[ \t]+(.+)$/gm;
const RE_QUOTES = /['"]/g;
const RE_HASHTAGS = /#([a-zA-Z0-9_-]+)/g;
const RE_NON_ALNUM = /[^a-z0-9\s]/g;
const RE_WHITESPACE = /\s+/;
// eslint-disable-next-line no-control-regex
const RE_INVALID_PATH_CHARS = /[\x00-\x1f\x7f]/; // full C0 + DEL range
const RE_UUID = /^[0-9a-f-]{36}$/i;
const RE_ANY_WHITESPACE = /\s/g;
// Obsidian wiki embed: ![[filename]] or ![[filename|alias]]
const RE_WIKI_EMBED = /!\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
// Standard Markdown image with relative (non-http) path
const RE_MD_IMAGE_REL = /!\[([^\]]*)\]\((?!https?:\/\/)(?!\/_emdash\/)([^)]+)\)/g;

// ── Helpers ────────────────────────────────────────────────────────────────

function generateId(): string {
	return crypto.randomUUID();
}

function generateApiKey(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function pathToId(path: string): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path));
	return "att-" + Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

function extractApiKey(request: Request): string | null {
	// Custom header — avoids conflicting with EmDash's own auth middleware
	// which intercepts and validates all Authorization: Bearer headers.
	return request.headers.get("x-wiki-key");
}

// Constant-time string comparison via HMAC to prevent timing attacks.
// Both inputs are hashed to equal-length outputs before the XOR loop.
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
	const enc = new TextEncoder();
	const keyMaterial = await crypto.subtle.importKey(
		"raw",
		enc.encode("__wiki_key_compare__"),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const [hA, hB] = await Promise.all([
		crypto.subtle.sign("HMAC", keyMaterial, enc.encode(a)),
		crypto.subtle.sign("HMAC", keyMaterial, enc.encode(b)),
	]);
	const vA = new Uint8Array(hA);
	const vB = new Uint8Array(hB);
	let diff = 0;
	for (let i = 0; i < vA.length; i++) diff |= vA[i]! ^ vB[i]!;
	return diff === 0;
}

async function checkApiKey(request: Request, storage: Storage): Promise<boolean> {
	const token = extractApiKey(request);
	if (!token) return false;
	// Use fixed ID for single-record lookup — avoids query + TOCTOU risk
	const entry = await storage.config.get("api_key_entry");
	const stored = entry?.value;
	if (!stored) return false;
	return timingSafeEqual(token, stored);
}

async function authenticateWrite(request: Request, storage: Storage): Promise<void> {
	const valid = await checkApiKey(request, storage);
	if (!valid) throw PluginRouteError.unauthorized("Valid API key required — set X-Wiki-Key header");
}

function extractTitle(content: string, path: string): string {
	const match = content.match(RE_H1);
	if (match) return match[1]!.trim();
	return (path.split("/").pop() || path).replace(RE_MD_EXT, "").replace(RE_SLUG_SEPS, " ");
}

function extractTags(content: string): string[] {
	const tags = new Set<string>();
	const fm = content.match(RE_FRONTMATTER);
	if (fm) {
		const fmBody = fm[1]!;
		// Inline array: tags: [tag1, tag2]
		const inline = fmBody.match(RE_TAGS_LINE);
		if (inline) inline[1]!.split(",").forEach((s) => tags.add(s.trim().replace(RE_QUOTES, "")));
		// Block sequence: tags:\n  - tag1\n  - tag2  (Obsidian default format)
		const block = fmBody.match(RE_TAGS_BLOCK);
		if (block) {
			for (const m of block[1]!.matchAll(RE_TAGS_BLOCK_ITEM))
				tags.add(m[1]!.trim().replace(RE_QUOTES, ""));
		}
	}
	for (const m of content.matchAll(RE_HASHTAGS)) tags.add(m[1]!);
	return [...tags];
}

function buildTokens(text: string): string[] {
	const words = text
		.toLowerCase()
		.replace(RE_NON_ALNUM, " ")
		.split(RE_WHITESPACE)
		.filter((w) => w.length >= 2);
	const tokens = new Set<string>();
	for (const word of words) {
		tokens.add(word);
		for (let i = 0; i <= word.length - 3; i++) tokens.add(word.slice(i, i + 3));
	}
	return [...tokens];
}

async function indexNote(storage: Storage, note: WikiNote & { id: string }) {
	const old = await storage.search_index.query({ where: { notePath: note.path } });
	for (const e of old.items) await storage.search_index.delete(e.id);
	// Only index public notes in the search index so search results are safe for
	// unauthenticated clients. Private/clients notes are still searchable via the
	// admin panel.
	if (note.visibility === "public") {
		const excerpt = `${note.title} ${note.content}`.slice(0, 10_000);
		for (const token of buildTokens(excerpt)) {
			await storage.search_index.put(generateId(), { token, notePath: note.path });
		}
	}
}

// Rewrite Obsidian image/file references in note content using pre-built attachment maps.
// byPath: full vault path → attachment. byFilename: basename only → attachment.
// Called once per sync batch (maps built outside the per-note loop to minimise queries).
function rewriteObsidianLinks(
	content: string,
	byPath: Map<string, WikiAttachment>,
	byFilename: Map<string, WikiAttachment>,
): string {
	let out = content;

	// 1. Obsidian wiki embeds: ![[filename.ext]] and ![[filename.ext|alias]]
	out = out.replace(RE_WIKI_EMBED, (match, target: string) => {
		const t = target.trim();
		const basename = t.split("/").pop() || t;
		const attachment = byPath.get(t) || byPath.get(basename) || byFilename.get(basename);
		if (!attachment) return match; // unknown — keep as-is
		const ext = (basename.split(".").pop() || "").toLowerCase();
		if (IMAGE_EXTENSIONS.has(ext)) {
			return `![${basename}](${attachment.url})`;
		}
		return `[${basename}](${attachment.url})`;
	});

	// 2. Standard Markdown images with relative paths: ![alt](relative/path.png)
	out = out.replace(RE_MD_IMAGE_REL, (match, alt: string, imgPath: string) => {
		const p = imgPath.trim();
		const basename = p.split("/").pop() || p;
		const attachment = byPath.get(p) || byPath.get(basename) || byFilename.get(basename);
		if (!attachment) return match; // unknown — keep as-is
		return `![${alt}](${attachment.url})`;
	});

	return out;
}

async function saveHistory(storage: Storage, existing: WikiNote, path: string) {
	const hist: NoteHistory = {
		notePath: path,
		content: existing.content,
		createdAt: new Date().toISOString(),
	};
	await storage.history.put(generateId(), hist);
	// Fetch a generous window to handle concurrent-write races that temporarily
	// push the count above MAX_HISTORY before either caller trims.
	const allHist = await storage.history.query({
		where: { notePath: path },
		orderBy: { createdAt: "asc" },
		limit: MAX_HISTORY + 10,
	});
	if (allHist.items.length > MAX_HISTORY) {
		for (const old of allHist.items.slice(0, allHist.items.length - MAX_HISTORY)) {
			await storage.history.delete(old.id);
		}
	}
}

// ── Plugin ─────────────────────────────────────────────────────────────────

export default definePlugin({
	hooks: {
		"plugin:activate": {
			handler: async (_event: unknown, ctx: PluginContext) => {
				ctx.log.info("[markdown-wiki] Plugin activated — storage ready");
			},
		},
	},

	routes: {
		// ── Public read endpoints ──────────────────────────────────────────
		//
		// These are public so anonymous browsers can load the wiki.
		// Without a valid API key, only `visibility: "public"` notes are returned.
		// With a valid X-Wiki-Key header, all visibility levels are returned.

		// GET /_emdash/api/plugins/markdown-wiki/notes?tag=&limit=
		notes: {
			public: true,
			handler: async (routeCtx: { request: Request }, ctx: PluginContext) => {
				const url = new URL(routeCtx.request.url);
				const tag = url.searchParams.get("tag");
				const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit")) || 100), 500);

				const storage = ctx.storage as unknown as Storage;
				const authenticated = await checkApiKey(routeCtx.request, storage);

				const result = await storage.notes.query({ limit: 5000 });
				const pool_overflow = result.hasMore === true;
				let notes = result.items.map((i) => ({ id: i.id, ...i.data }));

				if (!authenticated) notes = notes.filter((n) => n.visibility === "public");
				if (tag) notes = notes.filter((n) => n.tags.includes(tag));
				const total = notes.length;
				// truncated: caller's view is capped by limit. pool_overflow: underlying pool
				// hit 5000 — authenticated clients should use notes/since for full sync.
				return { notes: notes.slice(0, limit), total, truncated: notes.length > limit, pool_overflow };
			},
		},

		// POST /notes/get — body: { path }
		"notes/get": {
			public: true,
			handler: async (
				routeCtx: { request: Request; input: { path: string } },
				ctx: PluginContext,
			) => {
				const { path } = routeCtx.input || {};
				if (!path) throw PluginRouteError.badRequest("path is required");
				const getPathErr = validateNotePath(path);
				if (getPathErr) throw PluginRouteError.badRequest(getPathErr);
				const storage = ctx.storage as unknown as Storage;
				const result = await storage.notes.query({ where: { path } });
				if (!result.items[0]) throw PluginRouteError.notFound("Note not found");
				const note = { id: result.items[0].id, ...result.items[0].data };

				if (note.visibility !== "public") {
					const authenticated = await checkApiKey(routeCtx.request, storage);
					// Return same "not found" error to avoid leaking that a private note exists
					if (!authenticated) throw PluginRouteError.notFound("Note not found");
				}

				return { note };
			},
		},

		// GET /search?q=...&limit=
		// Always scoped to public notes — search runs client-side with no auth context.
		search: {
			public: true,
			handler: async (routeCtx: { request: Request }, ctx: PluginContext) => {
				const url = new URL(routeCtx.request.url);
				const q = url.searchParams.get("q")?.toLowerCase().trim();
				const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit")) || 10), 50);

				if (!q || q.length < 2) return { results: [] };

				const storage = ctx.storage as unknown as Storage;
				const pathScores = new Map<string, number>();

				for (const token of buildTokens(q).slice(0, 5)) {
					const matches = await storage.search_index.query({ where: { token }, limit: 500 });
					for (const m of matches.items) {
						pathScores.set(m.data.notePath, (pathScores.get(m.data.notePath) || 0) + 1);
					}
				}
				const results = [];
				for (const [notePath] of [...pathScores.entries()]
					.toSorted((a, b) => b[1] - a[1])
					.slice(0, limit)) {
					const notes = await storage.notes.query({ where: { path: notePath } });
					if (notes.items[0] && notes.items[0].data.visibility === "public")
						results.push({ id: notes.items[0].id, ...notes.items[0].data });
				}
				return { results, query: q };
			},
		},

		// GET /history?path=... — requires API key; history may contain old private revisions
		history: {
			public: true,
			handler: async (routeCtx: { request: Request }, ctx: PluginContext) => {
				const storage = ctx.storage as unknown as Storage;
				const authenticated = await checkApiKey(routeCtx.request, storage);
				if (!authenticated) throw PluginRouteError.unauthorized("API key required");

				const url = new URL(routeCtx.request.url);
				const path = url.searchParams.get("path");
				if (!path) throw PluginRouteError.badRequest("path is required");
				const histPathErr = validateNotePath(path);
				if (histPathErr) throw PluginRouteError.badRequest(histPathErr);

				const noteResult = await storage.notes.query({ where: { path } });
				if (!noteResult.items[0]) throw PluginRouteError.notFound("Note not found");

				const result = await storage.history.query({
					where: { notePath: path },
					orderBy: { createdAt: "desc" },
					limit: MAX_HISTORY + 5,
				});
				return { history: result.items.map((i) => i.data), path };
			},
		},

		// GET /notes/since?since=<ISO>&limit=
		// Delta sync for Obsidian: returns notes updated after the given timestamp.
		// Requires API key. Returns all visibility levels for authenticated callers.
		"notes/since": {
			public: true,
			handler: async (routeCtx: { request: Request }, ctx: PluginContext) => {
				const storage = ctx.storage as unknown as Storage;
				const authenticated = await checkApiKey(routeCtx.request, storage);
				if (!authenticated) throw PluginRouteError.unauthorized("API key required");

				const url = new URL(routeCtx.request.url);
				const since = url.searchParams.get("since") || url.searchParams.get("timestamp") || null;
				const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit")) || 200), 500);

				const result = await storage.notes.query({ orderBy: { updatedAt: "desc" }, limit: 5000 });
				const poolTruncated = result.hasMore === true;
				let notes = result.items.map((i) => ({ id: i.id, ...i.data }));

				if (since) {
					const sinceMs = new Date(since).getTime();
					if (isNaN(sinceMs))
						throw PluginRouteError.badRequest("invalid since timestamp — use ISO 8601 format");
					notes = notes.filter((n) => new Date(n.updatedAt).getTime() > sinceMs);
				}

				const page = notes.slice(0, limit);
				return {
					notes: page,
					total: notes.length,
					since,
					truncated: notes.length > limit,
					pool_overflow: poolTruncated,
				};
			},
		},

		// ── Write endpoints (EmDash admin auth required) ──────────────────

		// POST /notes/create — body: { path, content, visibility?, title?, tags? }
		"notes/create": {
			public: true,
			handler: async (
				routeCtx: { request: Request; input: Partial<WikiNote> },
				ctx: PluginContext,
			) => {
				const storage = ctx.storage as unknown as Storage;
				await authenticateWrite(routeCtx.request, storage);
				const b = routeCtx.input;
				if (!b?.path || !b?.content)
					throw PluginRouteError.badRequest("path and content are required");
				const pathErr = validateNotePath(b.path);
				if (pathErr) throw PluginRouteError.badRequest(pathErr);
				if (b.visibility && !["public", "private", "clients"].includes(b.visibility)) {
					throw PluginRouteError.badRequest("Invalid visibility value");
				}

				const existing = await storage.notes.query({ where: { path: b.path } });
				if (existing.items[0])
					throw PluginRouteError.badRequest("A note with this path already exists");

				const now = new Date().toISOString();
				const id = generateId();
				const note: WikiNote = {
					path: b.path,
					title: b.title || extractTitle(b.content, b.path),
					content: b.content,
					visibility: b.visibility || "public",
					tags: b.tags || extractTags(b.content),
					createdAt: now,
					updatedAt: now,
				};
				await storage.notes.put(id, note);
				await indexNote(storage, { id, ...note });
				ctx.log.info(`[markdown-wiki] Created: ${note.path}`);
				return { note: { id, ...note } };
			},
		},

		// POST /notes/update — body: { path, content?, title?, visibility?, tags? }
		"notes/update": {
			public: true,
			handler: async (
				routeCtx: { request: Request; input: Partial<WikiNote> & { path: string } },
				ctx: PluginContext,
			) => {
				const storage = ctx.storage as unknown as Storage;
				await authenticateWrite(routeCtx.request, storage);
				// Allowlist fields — never spread raw caller input onto stored records
				const { path } = routeCtx.input || {};
				const input = routeCtx.input || {};
				if (!path) throw PluginRouteError.badRequest("path is required");
				const updatePathErr = validateNotePath(path);
				if (updatePathErr) throw PluginRouteError.badRequest(updatePathErr);
				if (input.content !== undefined && !input.content.trim())
					throw PluginRouteError.badRequest("content cannot be empty");
				if (input.visibility && !["public", "private", "clients"].includes(input.visibility)) {
					throw PluginRouteError.badRequest("Invalid visibility value");
				}
				const result = await storage.notes.query({ where: { path } });
				if (!result.items[0]) throw PluginRouteError.notFound("Note not found");

				const { id, data: existing } = result.items[0];
				await saveHistory(storage, existing, path);

				const updated: WikiNote = {
					...existing,
					path: existing.path,
					content: input.content !== undefined ? input.content : existing.content,
					visibility: input.visibility ?? existing.visibility,
					title: input.title || (input.content ? extractTitle(input.content, path) : existing.title),
					tags: input.tags || (input.content ? extractTags(input.content) : existing.tags),
					updatedAt: new Date().toISOString(),
				};
				await storage.notes.put(id, updated);
				await indexNote(storage, { id, ...updated });
				return { note: { id, ...updated } };
			},
		},

		// POST /notes/delete — body: { path }
		"notes/delete": {
			public: true,
			handler: async (
				routeCtx: { request: Request; input: { path: string } },
				ctx: PluginContext,
			) => {
				const storage = ctx.storage as unknown as Storage;
				await authenticateWrite(routeCtx.request, storage);
				const { path } = routeCtx.input || {};
				if (!path) throw PluginRouteError.badRequest("path is required");
				const deletePathErr = validateNotePath(path);
				if (deletePathErr) throw PluginRouteError.badRequest(deletePathErr);
				const result = await storage.notes.query({ where: { path } });
				if (!result.items[0]) throw PluginRouteError.notFound("Note not found");

				// Delete the note record first — if it succeeds, token/history cleanup
				// is best-effort. Inverting this order would leave the note accessible
				// but with no history if the note delete fails.
				await storage.notes.delete(result.items[0].id);
				const tokens = await storage.search_index.query({ where: { notePath: path } });
				for (const t of tokens.items) await storage.search_index.delete(t.id);
				const hist = await storage.history.query({ where: { notePath: path } });
				for (const h of hist.items) await storage.history.delete(h.id);

				return { deleted: true, path };
			},
		},

		// POST /notes/move — body: { path, newPath }
		"notes/move": {
			public: true,
			handler: async (
				routeCtx: { request: Request; input: { path: string; newPath: string } },
				ctx: PluginContext,
			) => {
				const storage = ctx.storage as unknown as Storage;
				await authenticateWrite(routeCtx.request, storage);
				const { path, newPath } = routeCtx.input || {};
				if (!path || !newPath) throw PluginRouteError.badRequest("path and newPath are required");
				const moveSourceErr = validateNotePath(path);
				if (moveSourceErr) throw PluginRouteError.badRequest(`path: ${moveSourceErr}`);
				const moveDestErr = validateNotePath(newPath);
				if (moveDestErr) throw PluginRouteError.badRequest(`newPath: ${moveDestErr}`);
				const result = await storage.notes.query({ where: { path } });
				if (!result.items[0]) throw PluginRouteError.notFound("Note not found");

				const existing = await storage.notes.query({ where: { path: newPath } });
				if (existing.items[0])
					throw PluginRouteError.badRequest("A note already exists at the destination path");

				const { id, data } = result.items[0];
				const moved: WikiNote = {
					...data,
					path: newPath,
					title: data.title,
					updatedAt: new Date().toISOString(),
				};
				await storage.notes.put(id, moved);

				const tokens = await storage.search_index.query({ where: { notePath: path } });
				for (const t of tokens.items) await storage.search_index.delete(t.id);
				// Delete history under old path — history entries are path-keyed and would leak
				// old-path references after the move, and visibility checks would skip them
				const oldHist = await storage.history.query({ where: { notePath: path } });
				for (const h of oldHist.items) await storage.history.delete(h.id);
				await indexNote(storage, { id, ...moved });

				ctx.log.info(`[markdown-wiki] Moved: ${path} → ${newPath}`);
				return { note: { id, ...moved } };
			},
		},

		// POST /sync — Obsidian bulk sync
		// Accepts both an upsert array and an optional delete_paths array for two-way sync.
		sync: {
			public: true,
			handler: async (
				routeCtx: {
					request: Request;
					input: {
						notes: Array<{ path: string; content: string; visibility?: WikiNote["visibility"] }>;
						delete_paths?: string[];
					};
				},
				ctx: PluginContext,
			) => {
				const storage = ctx.storage as unknown as Storage;
				await authenticateWrite(routeCtx.request, storage);
				const { notes, delete_paths } = routeCtx.input || {};
				if (!Array.isArray(notes)) throw PluginRouteError.badRequest("notes array required");
				if (notes.length > 200)
					throw PluginRouteError.badRequest("Sync payload too large — max 200 notes per request");
				if (Array.isArray(delete_paths) && delete_paths.length > 200)
					throw PluginRouteError.badRequest("delete_paths too large — max 200 per request");
				let created = 0,
					updated = 0,
					deleted = 0;
				const now = new Date().toISOString();

				// Pre-fetch all attachments once so we can rewrite Obsidian image links
				// in the note content without a per-note DB query.
				const allAttachments = (await storage.attachments.query({ limit: 2000 })).items;
				const attachByPath = new Map<string, WikiAttachment>();
				const attachByFilename = new Map<string, WikiAttachment>();
				for (const item of allAttachments) {
					attachByPath.set(item.data.path, item.data);
					const basename = item.data.path.split("/").pop() || item.data.path;
					if (!attachByFilename.has(basename)) attachByFilename.set(basename, item.data);
				}

				for (const n of notes) {
					if (!n.path || !n.content) continue;
					if (validateNotePath(n.path) !== null) continue;
					const resolvedVisibility =
						n.visibility && ["public", "private", "clients"].includes(n.visibility)
							? n.visibility
							: undefined;
					// Rewrite Obsidian image/file links to stable EmDash media URLs
					const content = rewriteObsidianLinks(n.content, attachByPath, attachByFilename);
					try {
						const existingResult = (await storage.notes.query({ where: { path: n.path } }))
							.items[0];
						if (existingResult) {
							const u: WikiNote = {
								...existingResult.data,
								content,
								title: extractTitle(content, n.path),
								tags: extractTags(content),
								visibility: resolvedVisibility || existingResult.data.visibility,
								updatedAt: now,
							};
							await storage.notes.put(existingResult.id, u);
							await indexNote(storage, { id: existingResult.id, ...u });
							updated++;
						} else {
							const id = generateId();
							const newNote: WikiNote = {
								path: n.path,
								title: extractTitle(content, n.path),
								content,
								visibility: resolvedVisibility || "public",
								tags: extractTags(content),
								createdAt: now,
								updatedAt: now,
							};
							await storage.notes.put(id, newNote);
							await indexNote(storage, { id, ...newNote });
							created++;
						}
					} catch (err) {
						ctx.log.error(`[markdown-wiki] Sync skipped ${n.path}: ${err}`);
					}
				}

				// Handle deletions pushed from Obsidian
				if (Array.isArray(delete_paths)) {
					for (const path of delete_paths) {
						if (!path || validateNotePath(path) !== null) continue;
						try {
							const toDelete = (await storage.notes.query({ where: { path } })).items[0];
							if (toDelete) {
								// Delete note record first; cleanup is best-effort after
								await storage.notes.delete(toDelete.id);
								deleted++;
								const tokens = await storage.search_index.query({ where: { notePath: path } });
								for (const t of tokens.items) await storage.search_index.delete(t.id);
								const hist = await storage.history.query({ where: { notePath: path } });
								for (const h of hist.items) await storage.history.delete(h.id);
							}
						} catch (err) {
							ctx.log.error(`[markdown-wiki] Sync delete failed for ${path}: ${err}`);
						}
					}
				}

				ctx.log.info(
					`[markdown-wiki] Sync: ${created} created, ${updated} updated, ${deleted} deleted`,
				);
				return { created, updated, deleted, total: created + updated };
			},
		},

		// ── Attachment management ──────────────────────────────────────────

		// POST /attachments/upload — JSON body: { path, filename, mimeType, data: "<base64>" }
		// The sandbox RPC transport serialises the Request without the body, so multipart
		// cannot reach the handler. Base64-encoded JSON is the only reliable cross-platform
		// transport for binary data in plugin routes.
		"attachments/upload": {
			public: true,
			handler: async (
				routeCtx: {
					request: Request;
					input: { path?: string; filename?: string; mimeType?: string; data?: string };
				},
				ctx: PluginContext,
			) => {
				const storage = ctx.storage as unknown as Storage;
				await authenticateWrite(routeCtx.request, storage);

				if (!ctx.media?.upload)
					throw PluginRouteError.badRequest(
						"media:write capability not available — attachment upload requires Cloudflare Workers deployment",
					);

				const { path, filename, mimeType, data } = routeCtx.input ?? {};

				if (!path?.trim())
					throw PluginRouteError.badRequest("path field required (vault-relative path)");
				if (!filename?.trim()) throw PluginRouteError.badRequest("filename field required");
				if (!mimeType) throw PluginRouteError.badRequest("mimeType field required");
				if (!data) throw PluginRouteError.badRequest("data field required (base64-encoded bytes)");

				const trimmedPath = path.trim();
				if (trimmedPath.length > 512 || RE_INVALID_PATH_CHARS.test(trimmedPath))
					throw PluginRouteError.badRequest("invalid path — max 512 chars, no control characters");

				const trimmedFilename = filename.trim();
				if (
					trimmedFilename.length > 255 ||
					trimmedFilename.includes("/") ||
					[...trimmedFilename].some((c) => c.charCodeAt(0) < 0x20)
				)
					throw PluginRouteError.badRequest(
						"invalid filename — must be a basename, max 255 chars, no control characters",
					);

				if (!ALLOWED_MIME_TYPES.has(mimeType))
					throw PluginRouteError.badRequest(`unsupported file type: ${mimeType}`);

				// Strip MIME base64 whitespace (newlines every 76 chars) before size check;
				// atob() accepts whitespace per WHATWG spec but the length check must use
				// the stripped form to avoid false-positives on valid ~20 MB files.
				const dataStripped = data.replace(RE_ANY_WHITESPACE, "");
				if (dataStripped.length > Math.ceil(MAX_ATTACHMENT_SIZE * (4 / 3)) + 4)
					throw PluginRouteError.badRequest("file too large — max 20 MB");

				// Decode base64 → ArrayBuffer
				let bytes: ArrayBuffer;
				try {
					const binary = atob(dataStripped);
					const arr = new Uint8Array(binary.length);
					for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
					bytes = arr.buffer;
				} catch {
					throw PluginRouteError.badRequest("data field is not valid base64");
				}

				if (bytes.byteLength > MAX_ATTACHMENT_SIZE)
					throw PluginRouteError.badRequest("file too large — max 20 MB");

				const { mediaId, storageKey, url } = await ctx.media.upload(
					trimmedFilename,
					mimeType,
					bytes,
				);

				const now = new Date().toISOString();
				const attachment: WikiAttachment = {
					path: trimmedPath,
					mediaId,
					storageKey,
					url,
					mimeType,
					size: bytes.byteLength,
					uploadedAt: now,
				};

				// Deterministic ID from path — concurrent uploads for the same path
				// compute the same ID so put() is idempotent (last write wins, no duplicates)
				const recordId = await pathToId(trimmedPath);
				await storage.attachments.put(recordId, attachment);

				ctx.log.info(
					`[markdown-wiki] Attachment uploaded: ${trimmedPath} (${bytes.byteLength} bytes)`,
				);
				return { path: trimmedPath, url, mediaId, size: bytes.byteLength };
			},
		},

		// GET /attachments?limit=&cursor= — list all attachments
		attachments: {
			public: true,
			handler: async (routeCtx: { request: Request }, ctx: PluginContext) => {
				const storage = ctx.storage as unknown as Storage;
				await authenticateWrite(routeCtx.request, storage);

				const url = new URL(routeCtx.request.url);
				const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit")) || 100), 500);

				const result = await storage.attachments.query({
					orderBy: { uploadedAt: "desc" },
					limit,
				});
				return {
					attachments: result.items.map((i) => ({ id: i.id, ...i.data })),
					total: result.items.length,
				};
			},
		},

		// POST /attachments/delete — body: { path }
		"attachments/delete": {
			public: true,
			handler: async (
				routeCtx: { request: Request; input: { path: string } },
				ctx: PluginContext,
			) => {
				const storage = ctx.storage as unknown as Storage;
				await authenticateWrite(routeCtx.request, storage);

				const { path } = routeCtx.input || {};
				if (!path) throw PluginRouteError.badRequest("path is required");

				const result = (await storage.attachments.query({ where: { path } })).items[0];
				if (!result) throw PluginRouteError.notFound("Attachment not found");

				// Delete metadata record first; R2 cleanup is best-effort.
				// Avoids a zombie metadata entry if the R2 delete throws.
				await storage.attachments.delete(result.id);
				if (ctx.media?.delete) {
					try {
						await ctx.media.delete(result.data.storageKey);
					} catch (err) {
						ctx.log.warn(`[markdown-wiki] Could not delete R2 object for ${path}: ${err}`);
					}
				}
				ctx.log.info(`[markdown-wiki] Attachment deleted: ${path}`);
				return { deleted: true, path };
			},
		},

		// ── API key management (EmDash admin auth required) ───────────────

		// POST /config/apikey/rotate — generate a new API key (invalidates the old one)
		"config/apikey/rotate": {
			handler: async (_routeCtx: unknown, ctx: PluginContext) => {
				const storage = ctx.storage as unknown as Storage;
				const newKey = generateApiKey();

				// Fixed ID — put() is idempotent; last write wins, no TOCTOU race on rotation
				await storage.config.put("api_key_entry", {
					key: "api_key",
					value: newKey,
					updatedAt: new Date().toISOString(),
				});

				ctx.log.info("[markdown-wiki] API key rotated");
				// Return the key once — the caller must store it; it cannot be retrieved again
				return { apiKey: newKey, rotatedAt: new Date().toISOString() };
			},
		},

		// GET /config/apikey — check whether an API key exists (does NOT return the value)
		"config/apikey": {
			handler: async (_routeCtx: unknown, ctx: PluginContext) => {
				const storage = ctx.storage as unknown as Storage;
				const entry = await storage.config.get("api_key_entry");
				return {
					exists: !!entry,
					updatedAt: entry?.updatedAt ?? null,
				};
			},
		},

		// ── Admin Block Kit UI ─────────────────────────────────────────────

		admin: {
			handler: async (
				routeCtx: {
					input: {
						type?: string;
						page?: string;
						action_id?: string;
						value?: string;
						values?: Record<string, unknown>;
						note_id?: string;
						note_path?: string;
					};
				},
				ctx: PluginContext,
			) => {
				const interaction = routeCtx.input || {};
				const storage = ctx.storage as unknown as Storage;

				// ── Page: config / API key ─────────────────────────────────
				if (interaction.action_id === "nav_config" || interaction.page === "config") {
					const keyEntry = await storage.config.get("api_key_entry");
					return {
						blocks: [
							{ type: "header", text: "⚙️ Configuration — Clé API" },
							{ type: "divider" },
							keyEntry
								? {
										type: "section",
										text: `✅ Une clé API est configurée (générée le ${new Date(keyEntry.updatedAt).toLocaleDateString("fr-FR")}).\n\n📋 Copiez la clé depuis l'action "Régénérer" pour l'utiliser dans Obsidian.`,
									}
								: {
										type: "section",
										text: "⚠️ Aucune clé API configurée. Générez une clé pour activer la synchronisation Obsidian et l'accès aux notes privées.",
									},
							{
								type: "section",
								text: "La clé API est utilisée comme header **X-Wiki-Key: \\<clé\\>** dans :\n- Le plugin Obsidian (lecture + sync deux sens)\n- Les requêtes admin server-side (var d'env WIKI_API_KEY)",
							},
							{ type: "divider" },
							{
								type: "actions",
								elements: [
									{
										type: "button",
										label: keyEntry ? "🔄 Régénérer la clé" : "🔑 Générer une clé API",
										action_id: "do_rotate_key",
										style: keyEntry ? "danger" : "primary",
										...(keyEntry
											? {
													confirm: {
														title: "Régénérer la clé ?",
														text: "L'ancienne clé sera invalidée. Le plugin Obsidian et WIKI_API_KEY devront être mis à jour.",
														confirm: "Régénérer",
														deny: "Annuler",
													},
												}
											: {}),
									},
									...(keyEntry
										? [
												{
													type: "button" as const,
													label: "🗑️ Supprimer la clé",
													action_id: "do_delete_key",
													style: "danger" as const,
													confirm: {
														title: "Supprimer la clé ?",
														text: "La synchronisation Obsidian et l'accès aux notes privées seront désactivés.",
														confirm: "Supprimer",
														deny: "Annuler",
													},
												},
											]
										: []),
									{ type: "button", label: "← Retour", action_id: "nav_list" },
								],
							},
						],
					};
				}

				// ── Action: rotate API key ─────────────────────────────────
				if (interaction.action_id === "do_rotate_key") {
					const newKey = generateApiKey();
					await storage.config.put("api_key_entry", {
						key: "api_key",
						value: newKey,
						updatedAt: new Date().toISOString(),
					});
					ctx.log.info("[markdown-wiki] API key rotated via admin");

					return {
						blocks: [
							{ type: "header", text: "🔑 Nouvelle clé API générée" },
							{ type: "divider" },
							{
								type: "banner",
								title: "Copiez cette clé maintenant",
								description:
									"Elle ne sera plus affichée après avoir quitté cette page. Révélez-la avec l'icône 👁, puis sélectionnez et copiez.",
								variant: "alert",
							},
							{
								type: "form",
								block_id: "key_display",
								fields: [
									{
										type: "secret_input",
										action_id: "key_value",
										label: "Clé API",
										initial_value: newKey,
									},
								],
								submit: { label: "← Retour à la configuration", action_id: "nav_config" },
							},
							{
								type: "section",
								text: "**Étapes suivantes :**\n1. Dans Obsidian : réglages du plugin Wiki Sync → coller la clé\n2. Dans votre `.env` : `WIKI_API_KEY=<clé>`\n3. Redémarrez le serveur de dev",
							},
						],
						toast: { message: "Clé API générée", type: "success" },
					};
				}

				// ── Action: delete API key ──────────────────────────────────
				if (interaction.action_id === "do_delete_key") {
					await storage.config.delete("api_key_entry");
					ctx.log.info("[markdown-wiki] API key deleted via admin");
					return {
						blocks: [
							{ type: "header", text: "⚙️ Configuration — Clé API" },
							{ type: "divider" },
							{
								type: "section",
								text: "⚠️ Aucune clé API configurée. Générez une clé pour activer la synchronisation Obsidian et l'accès aux notes privées.",
							},
							{
								type: "section",
								text: "La clé API est utilisée comme header **X-Wiki-Key: \\<clé\\>** dans :\n- Le plugin Obsidian (lecture + sync deux sens)\n- Les requêtes admin server-side (var d'env WIKI_API_KEY)",
							},
							{ type: "divider" },
							{
								type: "actions",
								elements: [
									{
										type: "button",
										label: "🔑 Générer une clé API",
										action_id: "do_rotate_key",
										style: "primary",
									},
									{ type: "button", label: "← Retour", action_id: "nav_list" },
								],
							},
						],
						toast: { message: "Clé API supprimée", type: "success" },
					};
				}

				// ── Page: liste des notes ──────────────────────────────────
				if (
					!interaction.type ||
					interaction.type === "page_load" ||
					interaction.page === "list" ||
					interaction.action_id === "nav_list"
				) {
					const result = await storage.notes.query({ limit: 100 });
					const notes = result.items
						.map((i) => ({ id: i.id, ...i.data }))
						.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));

					const visibilityBadge: Record<string, string> = {
						public: "🌐",
						private: "🔒",
						clients: "👥",
					};

					return {
						blocks: [
							{
								type: "columns",
								columns: [
									[{ type: "header", text: "📖 Wiki — Gestion des notes" }],
									[
										{
											type: "actions",
											elements: [
												{
													type: "button",
													label: "➕ Nouvelle note",
													action_id: "nav_create",
													style: "primary",
												},
												{ type: "button", label: "📎 Fichiers", action_id: "nav_attachments" },
												{ type: "button", label: "⚙️ Config API", action_id: "nav_config" },
											],
										},
									],
								],
							},
							{ type: "divider" },
							notes.length === 0
								? {
										type: "section",
										label:
											"Aucune note publiée. Créez votre première note ou synchronisez depuis Obsidian.",
									}
								: {
										type: "table",
										columns: [
											{ key: "title", label: "Titre" },
											{ key: "path", label: "Chemin" },
											{ key: "visibility", label: "Vis." },
											{ key: "updatedAt", label: "Modifié" },
										],
										rows: notes.map((n) => ({
											title: n.title,
											path: n.path,
											visibility: `${visibilityBadge[n.visibility] ?? ""} ${n.visibility}`,
											updatedAt: new Date(n.updatedAt).toLocaleDateString("fr-FR"),
											_note_id: n.id,
											_note_path: n.path,
										})),
									},
							{
								type: "actions",
								elements: notes
									.map((n) => ({
										type: "button",
										label: `✏️ ${n.title}`,
										action_id: "nav_edit",
										value: JSON.stringify({ note_id: n.id, note_path: n.path }),
									}))
									.slice(0, 10),
							},
						],
					};
				}

				// ── Page: créer une note ───────────────────────────────────
				if (interaction.action_id === "nav_create" || interaction.page === "create") {
					return {
						blocks: [
							{ type: "header", text: "➕ Créer une note" },
							{ type: "divider" },
							{
								type: "form",
								block_id: "create_note",
								fields: [
									{
										type: "text_input",
										action_id: "path",
										label: "Chemin (ex: Guide/Ma-note.md)",
										placeholder: "Dossier/Nom-de-la-note.md",
									},
									{
										type: "text_input",
										action_id: "title",
										label: "Titre (optionnel — déduit du contenu si absent)",
										placeholder: "Titre de la note",
									},
									{
										type: "text_input",
										action_id: "content",
										label: "Contenu Markdown",
										placeholder: "# Titre\n\nContenu de la note...",
										multiline: true,
									},
									{
										type: "select",
										action_id: "visibility",
										label: "Visibilité",
										options: [
											{ label: "🌐 Publique", value: "public" },
											{ label: "🔒 Privée", value: "private" },
											{ label: "👥 Clients", value: "clients" },
										],
									},
								],
								submit: { label: "Créer la note", action_id: "do_create" },
							},
							{
								type: "actions",
								elements: [{ type: "button", label: "← Retour", action_id: "nav_list" }],
							},
						],
					};
				}

				// ── Action: créer ──────────────────────────────────────────
				if (interaction.action_id === "do_create" && interaction.values) {
					const v = interaction.values as Record<string, string>;
					if (!v.path || !v.content) {
						return {
							blocks: [
								{
									type: "banner",
									title: "Erreur",
									description: "Le chemin et le contenu sont requis.",
									variant: "error",
								},
							],
							toast: { message: "Champs manquants", type: "error" },
						};
					}
					const createPathErr = validateNotePath(v.path);
					if (createPathErr) {
						return {
							blocks: [
								{
									type: "banner",
									title: "Erreur",
									description: `Chemin invalide : ${createPathErr}.`,
									variant: "error",
								},
							],
						};
					}

					const existing = await storage.notes.query({ where: { path: v.path } });
					if (existing.items[0]) {
						return {
							blocks: [
								{
									type: "banner",
									title: "Erreur",
									description: `Une note existe déjà à : ${v.path}`,
									variant: "error",
								},
							],
							toast: { message: "Note existante", type: "error" },
						};
					}

					const now = new Date().toISOString();
					const id = generateId();
					const note: WikiNote = {
						path: v.path,
						title: v.title || extractTitle(v.content, v.path),
						content: v.content,
						visibility: (["public", "private", "clients"] as const).includes(
							v.visibility as WikiNote["visibility"],
						)
							? (v.visibility as WikiNote["visibility"])
							: "public",
						tags: extractTags(v.content),
						createdAt: now,
						updatedAt: now,
					};
					await storage.notes.put(id, note);
					await indexNote(storage, { id, ...note });
					ctx.log.info(`[markdown-wiki] Admin created: ${note.path}`);

					return {
						blocks: [
							{
								type: "banner",
								title: "✓ Note créée",
								description: `"${note.title}" a été créée avec succès.`,
								variant: "default",
							},
							{
								type: "actions",
								elements: [{ type: "button", label: "← Retour à la liste", action_id: "nav_list" }],
							},
						],
						toast: { message: "Note créée", type: "success" },
					};
				}

				// ── Page: éditer une note ──────────────────────────────────
				if (interaction.action_id === "nav_edit" && interaction.value) {
					let note_path: string;
					try {
						({ note_path } = JSON.parse(interaction.value));
					} catch {
						return {
							blocks: [
								{
									type: "banner",
									title: "Erreur",
									description: "Données de navigation invalides.",
									variant: "error",
								},
							],
						};
					}
					const navEditPathErr = validateNotePath(note_path);
					if (navEditPathErr)
						return {
							blocks: [
								{
									type: "banner",
									title: "Erreur",
									description: "Chemin invalide.",
									variant: "error",
								},
							],
						};
					const result = await storage.notes.query({ where: { path: note_path } });
					if (!result.items[0]) {
						return {
							blocks: [
								{
									type: "banner",
									title: "Erreur",
									description: "Note introuvable.",
									variant: "error",
								},
							],
						};
					}
					const note = { id: result.items[0].id, ...result.items[0].data };

					return {
						blocks: [
							{ type: "header", text: `✏️ Modifier : ${note.title}` },
							{ type: "section", text: `Chemin : \`${note.path}\`` },
							{ type: "divider" },
							{
								type: "form",
								block_id: "edit_note",
								fields: [
									{
										type: "text_input",
										action_id: "title",
										label: "Titre",
										initial_value: note.title,
									},
									{
										type: "text_input",
										action_id: "content",
										label: "Contenu Markdown",
										initial_value: note.content,
										multiline: true,
									},
									{
										type: "select",
										action_id: "visibility",
										label: "Visibilité",
										initial_value: note.visibility,
										options: [
											{ label: "🌐 Publique", value: "public" },
											{ label: "🔒 Privée", value: "private" },
											{ label: "👥 Clients", value: "clients" },
										],
									},
									{
										type: "text_input",
										action_id: "_note_id",
										label: "_note_id",
										initial_value: note.id,
									},
								],
								submit: { label: "Enregistrer", action_id: "do_edit" },
							},
							{
								type: "actions",
								elements: [
									{
										type: "button",
										label: "🔀 Déplacer",
										action_id: "nav_move",
										value: JSON.stringify({ note_path: note.path, note_id: note.id }),
									},
									{
										type: "button",
										label: "🗑️ Supprimer",
										action_id: "do_delete",
										style: "danger",
										value: JSON.stringify({ note_path: note.path }),
										confirm: {
											title: "Supprimer cette note ?",
											text: `"${note.title}" sera supprimée définitivement.`,
											confirm: "Supprimer",
											deny: "Annuler",
										},
									},
									{ type: "button", label: "← Retour", action_id: "nav_list" },
								],
							},
						],
					};
				}

				// ── Action: sauvegarder l'édition ─────────────────────────
				if (interaction.action_id === "do_edit" && interaction.values) {
					const v = interaction.values as Record<string, string>;
					// Use the note UUID (not a user-supplied path) to prevent accidental
					// overwrite of a different note if _note_id were modified.
					const noteId = v._note_id;
					if (!noteId || !RE_UUID.test(noteId))
						return {
							blocks: [
								{
									type: "banner",
									title: "Erreur",
									description: "ID de note manquant.",
									variant: "error",
								},
							],
						};

					const existing = (await storage.notes.get(noteId)) as WikiNote | null;
					if (!existing)
						return {
							blocks: [
								{
									type: "banner",
									title: "Erreur",
									description: "Note introuvable.",
									variant: "error",
								},
							],
						};

					const id = noteId;
					const path = existing.path;

					if (v.content !== undefined && !v.content.trim()) {
						return {
							blocks: [
								{
									type: "banner",
									title: "Erreur",
									description: "Le contenu ne peut pas être vide.",
									variant: "error",
								},
							],
							toast: { message: "Contenu vide", type: "error" },
						};
					}

					await saveHistory(storage, existing, path);
					const updated: WikiNote = {
						...existing,
						path,
						title: v.title || existing.title,
						content: v.content !== undefined ? v.content : existing.content,
						visibility: (["public", "private", "clients"] as const).includes(
							v.visibility as WikiNote["visibility"],
						)
							? (v.visibility as WikiNote["visibility"])
							: existing.visibility,
						tags: v.content !== undefined ? extractTags(v.content) : existing.tags,
						updatedAt: new Date().toISOString(),
					};
					await storage.notes.put(id, updated);
					await indexNote(storage, { id, ...updated });

					return {
						blocks: [
							{
								type: "banner",
								title: "✓ Sauvegardé",
								description: `"${updated.title}" mis à jour.`,
								variant: "default",
							},
							{
								type: "actions",
								elements: [{ type: "button", label: "← Retour à la liste", action_id: "nav_list" }],
							},
						],
						toast: { message: "Note sauvegardée", type: "success" },
					};
				}

				// ── Page: déplacer une note ────────────────────────────────
				if (interaction.action_id === "nav_move" && interaction.value) {
					let note_path: string;
					let note_id: string;
					try {
						({ note_path, note_id } = JSON.parse(interaction.value));
					} catch {
						return {
							blocks: [
								{
									type: "banner",
									title: "Erreur",
									description: "Données de navigation invalides.",
									variant: "error",
								},
							],
						};
					}
					const navMovePathErr = validateNotePath(note_path);
					if (navMovePathErr || !note_id || !RE_UUID.test(note_id))
						return {
							blocks: [
								{
									type: "banner",
									title: "Erreur",
									description: "Chemin ou identifiant invalide.",
									variant: "error",
								},
							],
						};
					return {
						blocks: [
							{ type: "header", text: "🔀 Déplacer la note" },
							{ type: "section", text: `Chemin actuel : \`${note_path}\`` },
							{ type: "divider" },
							{
								type: "form",
								block_id: "move_note",
								fields: [
									{
										type: "text_input",
										action_id: "_note_id",
										label: "_note_id",
										initial_value: note_id,
									},
									{
										type: "text_input",
										action_id: "new_path",
										label: "Nouveau chemin",
										placeholder: "NouveauDossier/Nouvelle-note.md",
									},
								],
								submit: { label: "Déplacer", action_id: "do_move" },
							},
							{
								type: "actions",
								elements: [{ type: "button", label: "← Annuler", action_id: "nav_list" }],
							},
						],
					};
				}

				// ── Action: déplacer ───────────────────────────────────────
				if (interaction.action_id === "do_move" && interaction.values) {
					const v = interaction.values as Record<string, string>;
					const noteId = v._note_id;
					const newPath = v.new_path;
					if (!noteId || !RE_UUID.test(noteId) || !newPath)
						return {
							blocks: [
								{
									type: "banner",
									title: "Erreur",
									description: "Données manquantes.",
									variant: "error",
								},
							],
						};
					const moveNewPathErr = validateNotePath(newPath);
					if (moveNewPathErr)
						return {
							blocks: [
								{
									type: "banner",
									title: "Erreur",
									description: `Nouveau chemin invalide : ${moveNewPathErr}.`,
									variant: "error",
								},
							],
						};

					// Look up by UUID — prevents accidental move of a different note
					const existingData = (await storage.notes.get(noteId)) as WikiNote | null;
					if (!existingData)
						return {
							blocks: [
								{
									type: "banner",
									title: "Erreur",
									description: "Note introuvable.",
									variant: "error",
								},
							],
						};
					const oldPath = existingData.path;
					const id = noteId;

					const existingDest = await storage.notes.query({ where: { path: newPath } });
					if (existingDest.items[0])
						return {
							blocks: [
								{
									type: "banner",
									title: "Erreur",
									description: `Une note existe déjà à : ${newPath}`,
									variant: "error",
								},
							],
						};

					const moved: WikiNote = { ...existingData, path: newPath, updatedAt: new Date().toISOString() };
					await storage.notes.put(id, moved);

					const tokens = await storage.search_index.query({ where: { notePath: oldPath } });
					for (const t of tokens.items) await storage.search_index.delete(t.id);
					const oldHist = await storage.history.query({ where: { notePath: oldPath } });
					for (const h of oldHist.items) await storage.history.delete(h.id);
					await indexNote(storage, { id, ...moved });

					ctx.log.info(`[markdown-wiki] Admin moved: ${oldPath} → ${newPath}`);
					return {
						blocks: [
							{
								type: "banner",
								title: "✓ Déplacée",
								description: `Note déplacée vers \`${newPath}\`.`,
								variant: "default",
							},
							{
								type: "actions",
								elements: [{ type: "button", label: "← Retour à la liste", action_id: "nav_list" }],
							},
						],
						toast: { message: "Note déplacée", type: "success" },
					};
				}

				// ── Action: supprimer ──────────────────────────────────────
				if (interaction.action_id === "do_delete" && interaction.value) {
					let note_path: string;
					try {
						({ note_path } = JSON.parse(interaction.value));
					} catch {
						return {
							blocks: [
								{
									type: "banner",
									title: "Erreur",
									description: "Données de navigation invalides.",
									variant: "error",
								},
							],
						};
					}
					const deletePathErr = validateNotePath(note_path);
					if (deletePathErr)
						return {
							blocks: [
								{
									type: "banner",
									title: "Erreur",
									description: "Chemin invalide.",
									variant: "error",
								},
							],
						};
					const result = await storage.notes.query({ where: { path: note_path } });
					if (!result.items[0])
						return {
							blocks: [
								{
									type: "banner",
									title: "Erreur",
									description: "Note introuvable.",
									variant: "error",
								},
							],
						};

					// Delete note record first; cleanup is best-effort
					await storage.notes.delete(result.items[0].id);
					const tokens = await storage.search_index.query({ where: { notePath: note_path } });
					for (const t of tokens.items) await storage.search_index.delete(t.id);
					const hist = await storage.history.query({ where: { notePath: note_path } });
					for (const h of hist.items) await storage.history.delete(h.id);

					ctx.log.info(`[markdown-wiki] Admin deleted: ${note_path}`);
					return {
						blocks: [
							{
								type: "banner",
								title: "✓ Supprimée",
								description: `Note "${note_path}" supprimée.`,
								variant: "default",
							},
							{
								type: "actions",
								elements: [{ type: "button", label: "← Retour à la liste", action_id: "nav_list" }],
							},
						],
						toast: { message: "Note supprimée", type: "success" },
					};
				}

				// ── Page: fichiers / attachments ──────────────────────────
				if (interaction.action_id === "nav_attachments" || interaction.page === "attachments") {
					const result = await storage.attachments.query({
						orderBy: { uploadedAt: "desc" },
						limit: 200,
					});
					const attachments = result.items.map((i) => ({ id: i.id, ...i.data }));

					return {
						blocks: [
							{
								type: "columns",
								columns: [
									[{ type: "header", text: "📎 Fichiers attachés" }],
									[
										{
											type: "actions",
											elements: [
												{ type: "button", label: "← Retour aux notes", action_id: "nav_list" },
											],
										},
									],
								],
							},
							{ type: "divider" },
							{
								type: "section",
								label: `${attachments.length} fichier${attachments.length !== 1 ? "s" : ""} stocké${attachments.length !== 1 ? "s" : ""}. Uploadez des images et fichiers via le plugin Obsidian ou l'API \`POST /attachments/upload\`.`,
							},
							attachments.length === 0
								? {
										type: "section",
										text: "Aucun fichier uploadé. Synchronisez vos notes depuis Obsidian pour uploader les images automatiquement.",
									}
								: {
										type: "table",
										columns: [
											{ key: "path", label: "Chemin" },
											{ key: "type", label: "Type" },
											{ key: "size", label: "Taille" },
											{ key: "uploadedAt", label: "Uploadé le" },
										],
										rows: attachments.map((a) => ({
											path: a.path,
											type: a.mimeType.split("/")[1] ?? a.mimeType,
											size: formatBytes(a.size),
											uploadedAt: new Date(a.uploadedAt).toLocaleDateString("fr-FR"),
											_attachment_path: a.path,
										})),
									},
							...(attachments.length > 0
								? [
										{
											type: "actions",
											elements: attachments.slice(0, 10).map((a) => ({
												type: "button",
												label: `🗑️ ${a.path.split("/").pop()}`,
												action_id: "do_delete_attachment",
												style: "danger",
												value: JSON.stringify({ attachment_path: a.path }),
												confirm: {
													title: "Supprimer ce fichier ?",
													text: `"${a.path}" sera supprimé du wiki (l'entrée média restera dans EmDash).`,
													confirm: "Supprimer",
													deny: "Annuler",
												},
											})),
										},
									]
								: []),
						],
					};
				}

				// ── Action: supprimer un attachment ────────────────────────────
				if (interaction.action_id === "do_delete_attachment" && interaction.value) {
					let attachment_path: string;
					try {
						({ attachment_path } = JSON.parse(interaction.value));
					} catch {
						return {
							blocks: [
								{
									type: "banner",
									title: "Erreur",
									description: "Données de navigation invalides.",
									variant: "error",
								},
							],
						};
					}
					const result = (await storage.attachments.query({ where: { path: attachment_path } }))
						.items[0];
					if (!result) {
						return {
							blocks: [
								{
									type: "banner",
									title: "Erreur",
									description: "Fichier introuvable.",
									variant: "error",
								},
							],
						};
					}
					// Delete metadata record first; R2 cleanup is best-effort
					await storage.attachments.delete(result.id);
					if (ctx.media?.delete) {
						try {
							await ctx.media.delete(result.data.storageKey);
						} catch (err) {
							ctx.log.warn(`[markdown-wiki] Could not delete R2 object for ${attachment_path}: ${err}`);
						}
					}
					ctx.log.info(`[markdown-wiki] Admin deleted attachment: ${attachment_path}`);

					return {
						blocks: [
							{
								type: "banner",
								title: "✓ Fichier supprimé",
								description: `"${attachment_path}" a été supprimé du wiki.`,
								variant: "default",
							},
							{
								type: "actions",
								elements: [
									{ type: "button", label: "← Retour aux fichiers", action_id: "nav_attachments" },
									{ type: "button", label: "📖 Notes", action_id: "nav_list" },
								],
							},
						],
						toast: { message: "Fichier supprimé", type: "success" },
					};
				}

				// Fallback
				return { blocks: [{ type: "section", text: "Action non reconnue." }] };
			},
		},
	},
});
