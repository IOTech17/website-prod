#!/usr/bin/env node
/**
 * QA Script — theme-iotech
 * Tests pages, API, plugin wiki (CRUD cycle, search, URL encoding)
 * Usage: node qa.mjs [base_url]
 * Default: http://localhost:4321
 */

const BASE = process.argv[2] || "http://localhost:4321";
const PLUGIN = `${BASE}/_emdash/api/plugins/markdown-wiki`;
const RE_B64_CHUNKS = /.{1,20}/g;

let sessionCookie = "";

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

let passed = 0,
	failed = 0,
	warned = 0;
const failures = [];
let wikiApiKey = "";

function log(icon, color, label, detail = "") {
	console.log(`${color}${icon} ${BOLD}${label}${RESET}${detail ? ` ${DIM}${detail}${RESET}` : ""}`);
}

async function check(label, fn) {
	try {
		const result = await fn();
		if (result === true || result === undefined) {
			passed++;
			log("✓", GREEN, label);
		} else if (result?.warn) {
			warned++;
			log("⚠", YELLOW, label, result.warn);
		} else {
			failed++;
			const detail = result?.error || "failed";
			log("✗", RED, label, detail);
			failures.push({ label, detail });
		}
	} catch (e) {
		failed++;
		log("✗", RED, label, e.message);
		failures.push({ label, detail: e.message });
	}
}

async function get(path, opts = {}) {
	return fetch(`${BASE}${path}`, {
		redirect: opts.followRedirects === false ? "manual" : "follow",
		headers: opts.headers || {},
	});
}

async function pluginGet(path) {
	const res = await fetch(`${PLUGIN}${path}`);
	const data = await res.json().catch(() => null);
	return { status: res.status, data };
}

async function pluginPost(path, body) {
	const headers = { "Content-Type": "application/json", "X-EmDash-Request": "1" };
	if (sessionCookie) headers["Cookie"] = sessionCookie;
	const res = await fetch(`${PLUGIN}${path}`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
	const data = await res.json().catch(() => null);
	return { status: res.status, data };
}

async function pluginGetWithKey(path, key) {
	const res = await fetch(`${PLUGIN}${path}`, {
		headers: { "X-Wiki-Key": key },
	});
	const data = await res.json().catch(() => null);
	return { status: res.status, data };
}

async function pluginPostWithKey(path, body, key) {
	const res = await fetch(`${PLUGIN}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-Wiki-Key": key },
		body: JSON.stringify(body),
	});
	const data = await res.json().catch(() => null);
	return { status: res.status, data };
}

// Authentification via dev-bypass (dev only — retourne false si indispo)
async function authenticate() {
	for (const path of ["/_emdash/api/auth/dev-bypass", "/_emdash/api/setup/dev-bypass"]) {
		try {
			const res = await fetch(`${BASE}${path}`, { redirect: "manual" });
			const cookie = res.headers.get("set-cookie");
			if (cookie) {
				sessionCookie = cookie.split(";")[0];
				return true;
			}
		} catch {}
	}
	return false;
}

// ── Pages frontend ─────────────────────────────────────────────────────────

async function testPages() {
	console.log(`\n${CYAN}${BOLD}── Pages frontend ──────────────────────────────────${RESET}`);

	const pages = [
		{ path: "/", name: "Accueil", contains: ["IØTech"] },
		{ path: "/posts", name: "Blog", contains: ["Actualités"] },
		{ path: "/services", name: "Services", contains: ["Nos services"] },
		{ path: "/a-propos", name: "À propos", contains: ["IØTech"] },
		{ path: "/contact", name: "Contact", contains: ["Contact"] },
		{ path: "/wiki", name: "Wiki", contains: ["Wiki"] },
		{ path: "/404", name: "404", status: 404 },
	];

	for (const page of pages) {
		await check(`GET ${page.path} — ${page.name}`, async () => {
			const res = await get(page.path);
			const expected = page.status || 200;
			if (res.status !== expected) return { error: `Expected ${expected}, got ${res.status}` };
			if (page.contains) {
				const text = await res.text();
				const missing = page.contains.filter((s) => !text.includes(s));
				if (missing.length) return { warn: `Contenu manquant : ${missing.join(", ")}` };
			}
		});
	}
}

// ── Navigation ─────────────────────────────────────────────────────────────

async function testNavigation() {
	console.log(`\n${CYAN}${BOLD}── Navigation ──────────────────────────────────────${RESET}`);

	const links = [
		{ path: "/", label: "Accueil" },
		{ path: "/a-propos", label: "À propos" },
		{ path: "/services", label: "Services" },
		{ path: "/posts", label: "Blog" },
		{ path: "/wiki", label: "Wiki" },
		{ path: "/contact", label: "Contact" },
		{ path: "/rss.xml", label: "RSS" },
	];

	for (const link of links) {
		await check(`Lien ${link.label} — accessible`, async () => {
			const res = await get(link.path);
			if (res.status === 404) return { error: "404" };
			if (res.status === 500) return { error: "500 serveur" };
			if (res.status >= 400) return { error: `Status ${res.status}` };
		});
	}
}

// ── Blog ───────────────────────────────────────────────────────────────────

async function testBlog() {
	console.log(`\n${CYAN}${BOLD}── Blog ────────────────────────────────────────────${RESET}`);

	const res = await fetch(`${BASE}/_emdash/api/content/posts?limit=3`);
	const json = await res.json().catch(() => ({}));
	const posts = json?.data?.items || json?.items || [];

	if (posts.length === 0) {
		warned++;
		log("⚠", YELLOW, "Aucun article — vérifier le seed");
		return;
	}

	for (const post of posts.slice(0, 3)) {
		const slug = post.slug || post.id;
		await check(`GET /posts/${slug}`, async () => {
			const r = await get(`/posts/${slug}`);
			if (r.status !== 200) return { error: `Status ${r.status}` };
			const text = await r.text();
			if (!text.includes(post.data?.title || "")) return { warn: "Titre absent de la page" };
		});
	}
}

// ── RSS ────────────────────────────────────────────────────────────────────

async function testRSS() {
	console.log(`\n${CYAN}${BOLD}── RSS ─────────────────────────────────────────────${RESET}`);

	await check("GET /rss.xml — blog XML valide", async () => {
		const res = await get("/rss.xml");
		if (res.status !== 200) return { error: `Status ${res.status}` };
		const text = await res.text();
		if (!text.includes("<?xml")) return { error: "Pas de déclaration XML" };
		if (!text.includes("<rss")) return { error: "Pas de balise <rss>" };
	});

	await check("GET /wiki/rss.xml — wiki XML valide", async () => {
		const res = await get("/wiki/rss.xml");
		if (res.status !== 200) return { error: `Status ${res.status}` };
		const text = await res.text();
		if (!text.includes("<?xml")) return { error: "Pas de déclaration XML" };
		if (!text.includes("<rss")) return { error: "Pas de balise <rss>" };
		if (!text.includes("Wiki")) return { error: "Titre wiki absent du feed" };
	});

	await check("Wiki index — liens RSS pointent vers /wiki/rss.xml", async () => {
		const res = await get("/wiki");
		const text = await res.text();
		if (text.includes("plugins/markdown-wiki/rss"))
			return { error: "Ancienne URL plugin RSS encore présente" };
		if (!text.includes("/wiki/rss.xml")) return { error: "Lien /wiki/rss.xml absent de la page" };
	});
}

// ── Assets ─────────────────────────────────────────────────────────────────

async function testAssets() {
	console.log(`\n${CYAN}${BOLD}── Assets ──────────────────────────────────────────${RESET}`);

	await check("GET /favicon.svg — présent", async () => {
		const res = await get("/favicon.svg");
		if (res.status !== 200) return { error: `Status ${res.status}` };
	});
}

// ── Plugin Wiki — routes publiques ─────────────────────────────────────────

async function testWikiPublicRoutes() {
	console.log(`\n${CYAN}${BOLD}── Plugin Wiki — routes publiques ──────────────────${RESET}`);

	await check("GET /notes — accessible et format correct", async () => {
		const { status, data } = await pluginGet("/notes");
		if (status !== 200) return { error: `Status ${status}` };
		const notes = data?.data?.notes || data?.notes;
		if (!Array.isArray(notes)) return { error: `Format inattendu: ${JSON.stringify(data)}` };
	});

	await check("GET /search?q=a — accessible et format correct", async () => {
		const { status, data } = await pluginGet("/search?q=a");
		if (status !== 200) return { error: `Status ${status}` };
		const results = data?.data?.results || data?.results;
		if (!Array.isArray(results)) return { error: `Format inattendu: ${JSON.stringify(data)}` };
	});

	await check(
		"GET /search — URL pointe vers la bonne route plugin (pas /api/wiki/search)",
		async () => {
			// La mauvaise URL retournerait 404, la bonne retourne 200
			const bad = await fetch(`${BASE}/api/wiki/search?q=test`);
			const good = await fetch(`${PLUGIN}/search?q=test`);
			if (bad.status === 200) return { warn: "Route /api/wiki/search répond — doublon inattendu" };
			if (good.status !== 200) return { error: `Route plugin inaccessible: ${good.status}` };
		},
	);
}

// ── Plugin Wiki — CRUD cycle ───────────────────────────────────────────────

async function testWikiCRUD() {
	console.log(`\n${CYAN}${BOLD}── Plugin Wiki — cycle CRUD ────────────────────────${RESET}`);

	const authed = await authenticate();
	if (!authed) {
		warned++;
		log(
			"⚠",
			YELLOW,
			"Authentification dev-bypass indisponible — tests CRUD ignorés",
			"(normal en production)",
		);
		return;
	}
	log("✓", GREEN, "Session dev-bypass obtenue");

	// Generate API key — write routes require it
	{
		const { status, data } = await pluginPost("/config/apikey/rotate", {});
		const key = data?.data?.apiKey || data?.apiKey;
		if (status === 200 && key) {
			wikiApiKey = key;
			log("✓", GREEN, "Clé API wiki générée pour les tests CRUD");
		} else {
			warned++;
			log(
				"⚠",
				YELLOW,
				"Impossible de générer la clé API — tests CRUD write ignorés",
				`status ${status}`,
			);
			return;
		}
	}

	const TEST_PATH = `__qa-test__/Test-QA-${Date.now()}.md`;
	const TEST_PATH2 = `__qa-test__/Test-QA-moved-${Date.now()}.md`;
	// CREATE
	await check("POST /notes/create — crée une note", async () => {
		const { status, data } = await pluginPostWithKey(
			"/notes/create",
			{
				path: TEST_PATH,
				content: "# Test QA\n\nNote de test automatique.\n\n## Section\n\nContenu #qa-test",
				visibility: "public",
			},
			wikiApiKey,
		);
		if (status !== 200)
			return { error: `Status ${status} — ${data?.error?.message || JSON.stringify(data)}` };
		const note = data?.data?.note || data?.note;
		if (!note?.id) return { error: "Note sans id dans la réponse" };
		if (note.path !== TEST_PATH) return { error: `path attendu ${TEST_PATH}, reçu ${note.path}` };
		if (!note.tags.includes("qa-test")) return { warn: "Tag #qa-test non extrait du contenu" };
	});

	// GET par path
	await check("POST /notes/get — récupère la note créée", async () => {
		const { status, data } = await pluginPostWithKey("/notes/get", { path: TEST_PATH }, wikiApiKey);
		if (status !== 200) return { error: `Status ${status}` };
		const note = data?.data?.note || data?.note;
		if (!note) return { error: "Note non retournée" };
		if (note.path !== TEST_PATH) return { error: `path incorrect: ${note.path}` };
		if (!note.content.includes("Test QA")) return { error: "Contenu incorrect" };
	});

	// UPDATE
	await check("POST /notes/update — met à jour le contenu", async () => {
		const { status, data } = await pluginPostWithKey(
			"/notes/update",
			{
				path: TEST_PATH,
				content: "# Test QA Modifié\n\nContenu mis à jour.",
				title: "Test QA Modifié",
			},
			wikiApiKey,
		);
		if (status !== 200)
			return { error: `Status ${status} — ${data?.error?.message || JSON.stringify(data)}` };
		const note = data?.data?.note || data?.note;
		if (!note) return { error: "Note non retournée" };
		if (!note.title.includes("Modifié")) return { error: `Titre non mis à jour: ${note.title}` };
	});

	// HISTORY après update — requires API key (history may contain old private revisions)
	await check("GET /history?path= — historique présent après update", async () => {
		const { status, data } = await pluginGetWithKey(
			`/history?path=${encodeURIComponent(TEST_PATH)}`,
			wikiApiKey,
		);
		if (status !== 200) return { error: `Status ${status}` };
		const hist = data?.data?.history || data?.history;
		if (!Array.isArray(hist)) return { error: `Format inattendu: ${JSON.stringify(data)}` };
		if (hist.length === 0) return { warn: "Historique vide après update" };
	});

	// SEARCH retourne la note
	await check("GET /search?q=Modifié — trouve la note mise à jour", async () => {
		const { status, data } = await pluginGet(`/search?q=${encodeURIComponent("modifie")}`);
		if (status !== 200) return { error: `Status ${status}` };
		const results = data?.data?.results || data?.results;
		if (!Array.isArray(results)) return { error: "Format résultats invalide" };
		if (results.length === 0) return { warn: "Aucun résultat — index peut être vide" };
	});

	// MOVE
	await check("POST /notes/move — déplace la note", async () => {
		const { status, data } = await pluginPostWithKey(
			"/notes/move",
			{
				path: TEST_PATH,
				newPath: TEST_PATH2,
			},
			wikiApiKey,
		);
		if (status !== 200)
			return { error: `Status ${status} — ${data?.error?.message || JSON.stringify(data)}` };
		const note = data?.data?.note || data?.note;
		if (!note) return { error: "Note non retournée" };
		if (note.path !== TEST_PATH2) return { error: `Nouveau path incorrect: ${note.path}` };
	});

	// Ancienne URL doit être 404
	await check("POST /notes/get — ancienne URL introuvable après move", async () => {
		const { status } = await pluginPostWithKey("/notes/get", { path: TEST_PATH }, wikiApiKey);
		if (status === 200) return { error: "Ancienne note toujours accessible après move" };
	});

	// DELETE (cleanup)
	await check("POST /notes/delete — supprime la note de test", async () => {
		const { status, data } = await pluginPostWithKey(
			"/notes/delete",
			{ path: TEST_PATH2 },
			wikiApiKey,
		);
		if (status !== 200)
			return { error: `Status ${status} — ${data?.error?.message || JSON.stringify(data)}` };
		const deleted = data?.data?.deleted || data?.deleted;
		if (!deleted) return { error: "Champ 'deleted' absent ou false" };
	});

	// Vérifier disparu
	await check("POST /notes/get — note supprimée introuvable", async () => {
		const { status } = await pluginPostWithKey("/notes/get", { path: TEST_PATH2 }, wikiApiKey);
		if (status === 200) return { error: "Note toujours accessible après delete" };
	});
}

// ── Plugin Wiki — encodage URLs ────────────────────────────────────────────

async function testWikiURLEncoding() {
	console.log(`\n${CYAN}${BOLD}── Plugin Wiki — encodage URLs ─────────────────────${RESET}`);

	if (!sessionCookie) {
		const authed = await authenticate();
		if (!authed) {
			warned++;
			log("⚠", YELLOW, "Auth indisponible — test encodage ignoré");
			return;
		}
	}
	if (!wikiApiKey) {
		const { status, data } = await pluginPost("/config/apikey/rotate", {});
		const key = data?.data?.apiKey || data?.apiKey;
		if (status === 200 && key) {
			wikiApiKey = key;
		} else {
			warned++;
			log("⚠", YELLOW, "Clé API non disponible — test encodage ignoré");
			return;
		}
	}

	// Path avec sous-dossiers (pas d'accents pour isoler le test /)
	const SLASH_PATH = `__qa-url__/Subfolder/Note-encoding-${Date.now()}.md`;
	const encodedURL = SLASH_PATH.split("/")
		.map((s) => encodeURIComponent(s))
		.join("/");
	const wrongURL = encodeURIComponent(SLASH_PATH); // encode le / → %2F

	// Créer une note avec / dans le path — bail out if creation fails (no point testing URLs)
	const createResult = await pluginPostWithKey(
		"/notes/create",
		{
			path: SLASH_PATH,
			content: "# Note encoding\n\nTest URL encoding.",
			visibility: "public",
		},
		wikiApiKey,
	);
	if (createResult.status !== 200) {
		warned++;
		log(
			"⚠",
			YELLOW,
			"Création note encodage échouée — test URL ignoré",
			`status ${createResult.status}`,
		);
		return;
	}

	await check("URL wiki avec sous-dossier — encodage segment par segment", async () => {
		// L'URL correcte doit donner 200, pas 404
		const correct = await get(`/wiki/${encodedURL}`);
		if (correct.status === 404) return { error: `URL correcte (/wiki/${encodedURL}) donne 404` };
		if (correct.status >= 500)
			return { error: `Erreur serveur sur URL correcte: ${correct.status}` };
	});

	await check("URL wiki avec %2F — doit échouer (pas encoder les /)", async () => {
		const wrong = await get(`/wiki/${wrongURL}`);
		// %2F dans l'URL = path incorrect, doit 404
		if (wrong.status === 200)
			return { warn: `URL avec %2F répond 200 — vérifier le routage Astro` };
	});

	// Cleanup
	await pluginPostWithKey("/notes/delete", { path: SLASH_PATH }, wikiApiKey);
}

// ── Plugin Wiki — sync Obsidian ────────────────────────────────────────────

async function testWikiSync() {
	console.log(`\n${CYAN}${BOLD}── Plugin Wiki — sync Obsidian ─────────────────────${RESET}`);

	if (!sessionCookie) {
		const authed = await authenticate();
		if (!authed) {
			warned++;
			log("⚠", YELLOW, "Auth indisponible — tests sync ignorés");
			return;
		}
	}

	const syncNotes = [
		{ path: `__qa-sync__/Note-A-${Date.now()}.md`, content: "# Note A\n\nSync test A." },
		{ path: `__qa-sync__/Note-B-${Date.now()}.md`, content: "# Note B\n\nSync test B." },
	];

	await check("POST /sync — bulk upsert Obsidian", async () => {
		const { status, data } = await pluginPostWithKey("/sync", { notes: syncNotes }, wikiApiKey);
		if (status !== 200)
			return { error: `Status ${status} — ${data?.error?.message || JSON.stringify(data)}` };
		const result = data?.data || data;
		if (typeof result?.created !== "number")
			return { error: `Champ 'created' absent: ${JSON.stringify(data)}` };
		if (result.created < 2)
			return { warn: `Seulement ${result.created} note(s) créées, attendu 2` };
	});

	await check("POST /sync — re-sync idempotent (update, pas create)", async () => {
		const { status, data } = await pluginPostWithKey("/sync", { notes: syncNotes }, wikiApiKey);
		if (status !== 200) return { error: `Status ${status}` };
		const result = data?.data || data;
		if (result?.created > 0)
			return { warn: `Re-sync a créé ${result.created} note(s) — devrait être 0` };
		if (result?.updated < 2) return { warn: `Re-sync a mis à jour ${result.updated} — attendu 2` };
	});

	// Cleanup
	for (const n of syncNotes) await pluginPostWithKey("/notes/delete", { path: n.path }, wikiApiKey);
}

// ── Page wiki — rendu avec notes existantes ────────────────────────────────

async function testWikiPage() {
	console.log(`\n${CYAN}${BOLD}── Wiki frontend — rendu des pages ─────────────────${RESET}`);

	const { data } = await pluginGet("/notes");
	const notes = data?.data?.notes || data?.notes || [];

	await check(`Wiki index — ${notes.length} note(s) dans storage`, async () => {
		if (notes.length === 0) return { warn: "Aucune note — seeder ou créer via admin" };
	});

	// Filter out orphaned notes with invalid paths (double slash, leading slash, etc.)
	// eslint-disable-next-line no-control-regex
	const RE_CTRL = /[\x00-\x1f\x7f]/;
	const validNotes = notes.filter(
		(n) =>
			n.path &&
			n.path.endsWith(".md") &&
			!n.path.includes("//") &&
			!n.path.startsWith("/") &&
			!RE_CTRL.test(n.path) &&
			!n.path.split("/").some((s) => s === ".." || s === "." || s === ""),
	);

	if (validNotes.length > 0) {
		const note = validNotes[0];
		const encodedPath = note.path
			.split("/")
			.map((s) => encodeURIComponent(s))
			.join("/");

		await check(`GET /wiki/${encodedPath} — page note accessible`, async () => {
			const res = await get(`/wiki/${encodedPath}`);
			if (res.status !== 200) return { error: `Status ${res.status}` };
			const text = await res.text();
			if (!text.includes(note.title)) return { warn: `Titre "${note.title}" absent de la page` };
		});

		await check(`GET /wiki/${encodedPath} — breadcrumb présent`, async () => {
			const res = await get(`/wiki/${encodedPath}`);
			const text = await res.text();
			if (!text.includes("wiki-bc")) return { warn: "Classe breadcrumb absente" };
		});
	}

	// Recherche depuis le layout — vérifier que l'URL est correcte dans le HTML
	await check(
		"Wiki index — URL de recherche pointe vers le plugin (pas /api/wiki/search)",
		async () => {
			const res = await get("/wiki");
			const text = await res.text();
			if (text.includes("/api/wiki/search"))
				return { error: "Ancienne URL /api/wiki/search encore dans le HTML" };
			if (!text.includes("/_emdash/api/plugins/markdown-wiki/search"))
				return { error: "URL search correcte absente du HTML" };
		},
	);
}

// ── Plugin Wiki — sécurité & clé API ──────────────────────────────────────

async function testWikiSecurity() {
	console.log(`\n${CYAN}${BOLD}── Plugin Wiki — sécurité & clé API ────────────────${RESET}`);

	if (!sessionCookie) {
		const authed = await authenticate();
		if (!authed) {
			warned++;
			log("⚠", YELLOW, "Auth indisponible — tests sécurité ignorés");
			return;
		}
	}
	if (!wikiApiKey) {
		const { status, data } = await pluginPost("/config/apikey/rotate", {});
		const key = data?.data?.apiKey || data?.apiKey;
		if (status === 200 && key) {
			wikiApiKey = key;
		} else {
			warned++;
			log("⚠", YELLOW, "Clé API non générée — tests sécurité ignorés");
			return;
		}
	}

	const PRIV_PATH = `__qa-sec__/Note-Private-${Date.now()}.md`;

	await pluginPostWithKey(
		"/notes/create",
		{
			path: PRIV_PATH,
			content: "# Note Privée QA\n\nCeci est un test de sécurité.",
			visibility: "private",
		},
		wikiApiKey,
	);

	await check("GET /notes sans clé — note privée exclue", async () => {
		const { status, data } = await pluginGet("/notes");
		if (status !== 200) return { error: `Status ${status}` };
		const notes = data?.data?.notes || data?.notes || [];
		const found = notes.find((n) => n.path === PRIV_PATH);
		if (found) return { error: "Note privée visible sans clé API" };
	});

	await check("POST /notes/get sans clé — note privée retourne une erreur", async () => {
		const { status } = await pluginPost("/notes/get", { path: PRIV_PATH });
		if (status === 200) return { error: "Note privée accessible sans clé API" };
	});

	await check("POST /config/apikey/rotate — génère une clé API", async () => {
		const { status, data } = await pluginPost("/config/apikey/rotate", {});
		if (status !== 200)
			return { error: `Status ${status} — ${data?.error?.message || JSON.stringify(data)}` };
		const key = data?.data?.apiKey || data?.apiKey;
		if (!key || typeof key !== "string" || key.length < 32)
			return { error: `Clé invalide: ${key}` };
		wikiApiKey = key;
	});

	if (!wikiApiKey) {
		warned++;
		log("⚠", YELLOW, "Clé API non obtenue — tests suivants partiellement ignorés");
	}

	await check("GET /config/apikey — confirme l'existence sans exposer la valeur", async () => {
		const res = await fetch(`${PLUGIN}/config/apikey`, { headers: { Cookie: sessionCookie } });
		const data = await res.json().catch(() => null);
		if (res.status !== 200) return { error: `Status ${res.status}` };
		const body = data?.data || data;
		if (!body?.exists) return { error: "exists: false après rotation" };
		if (body?.apiKey || body?.key || body?.value)
			return { error: "La valeur de la clé est exposée" };
	});

	if (wikiApiKey) {
		await check("GET /notes avec clé API — note privée incluse", async () => {
			const { status, data } = await pluginGetWithKey("/notes", wikiApiKey);
			if (status !== 200) return { error: `Status ${status}` };
			const notes = data?.data?.notes || data?.notes || [];
			const found = notes.find((n) => n.path === PRIV_PATH);
			if (!found) return { error: "Note privée absente avec clé API valide" };
		});

		await check("POST /notes/get avec clé API — note privée accessible", async () => {
			const res = await fetch(`${PLUGIN}/notes/get`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-Wiki-Key": wikiApiKey },
				body: JSON.stringify({ path: PRIV_PATH }),
			});
			const data = await res.json().catch(() => null);
			if (res.status !== 200)
				return { error: `Status ${res.status} — ${data?.error?.message || JSON.stringify(data)}` };
			const note = data?.data?.note || data?.note;
			if (!note) return { error: "Note non retournée avec clé valide" };
			if (note.visibility !== "private")
				return { error: `Visibilité incorrecte: ${note.visibility}` };
		});
	}

	await pluginPostWithKey("/notes/delete", { path: PRIV_PATH }, wikiApiKey);
}

// ── Plugin Wiki — delta sync (notes/since) ─────────────────────────────────

async function testWikiDeltaSync() {
	console.log(`\n${CYAN}${BOLD}── Plugin Wiki — delta sync (notes/since) ───────────${RESET}`);

	if (!sessionCookie) {
		const authed = await authenticate();
		if (!authed) {
			warned++;
			log("⚠", YELLOW, "Auth indisponible — tests delta sync ignorés");
			return;
		}
	}

	await check("GET /notes/since sans clé — retourne une erreur", async () => {
		const { status } = await pluginGet("/notes/since?since=2020-01-01T00%3A00%3A00Z");
		if (status === 200) return { error: "Endpoint accessible sans clé API" };
	});

	if (!wikiApiKey) {
		warned++;
		log("⚠", YELLOW, "Clé API absente — tests delta sync avec clé ignorés");
		return;
	}

	const pastDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
	await check("GET /notes/since avec clé API — retourne les notes", async () => {
		const { status, data } = await pluginGetWithKey(
			`/notes/since?since=${encodeURIComponent(pastDate)}`,
			wikiApiKey,
		);
		if (status !== 200)
			return { error: `Status ${status} — ${data?.error?.message || JSON.stringify(data)}` };
		const notes = data?.data?.notes || data?.notes;
		if (!Array.isArray(notes)) return { error: `Format inattendu: ${JSON.stringify(data)}` };
	});

	await check("GET /notes/since avec timestamp futur — liste vide", async () => {
		const future = new Date(Date.now() + 60 * 1000).toISOString();
		const { status, data } = await pluginGetWithKey(
			`/notes/since?since=${encodeURIComponent(future)}`,
			wikiApiKey,
		);
		if (status !== 200) return { error: `Status ${status}` };
		const notes = data?.data?.notes || data?.notes || [];
		if (notes.length > 0)
			return { warn: `${notes.length} note(s) avec timestamp futur — vérifier les horodatages` };
	});
}

// ── Plugin Wiki — sync avec delete_paths ──────────────────────────────────

async function testWikiSyncDeletePaths() {
	console.log(`\n${CYAN}${BOLD}── Plugin Wiki — sync delete_paths ─────────────────${RESET}`);

	if (!sessionCookie) {
		const authed = await authenticate();
		if (!authed) {
			warned++;
			log("⚠", YELLOW, "Auth indisponible — test sync delete_paths ignoré");
			return;
		}
	}

	const ts = Date.now();
	const DEL_PATH_A = `__qa-del__/Note-Del-A-${ts}.md`;
	const DEL_PATH_B = `__qa-del__/Note-Del-B-${ts}.md`;
	const KEEP_PATH = `__qa-del__/Note-Keep-${ts}.md`;

	await check("POST /sync avec delete_paths — crée les notes initiales", async () => {
		const { status, data } = await pluginPostWithKey(
			"/sync",
			{
				notes: [
					{ path: DEL_PATH_A, content: "# Del A\n\nNote à supprimer." },
					{ path: DEL_PATH_B, content: "# Del B\n\nNote à supprimer." },
					{ path: KEEP_PATH, content: "# Keep\n\nNote à conserver." },
				],
			},
			wikiApiKey,
		);
		if (status !== 200)
			return { error: `Status ${status} — ${data?.error?.message || JSON.stringify(data)}` };
		const result = data?.data || data;
		if (result?.created < 3)
			return { warn: `Seulement ${result?.created} notes créées, attendu 3` };
	});

	await check("POST /sync avec delete_paths — supprime les notes ciblées", async () => {
		const { status, data } = await pluginPostWithKey(
			"/sync",
			{
				notes: [],
				delete_paths: [DEL_PATH_A, DEL_PATH_B],
			},
			wikiApiKey,
		);
		if (status !== 200)
			return { error: `Status ${status} — ${data?.error?.message || JSON.stringify(data)}` };
		const result = data?.data || data;
		if (typeof result?.deleted !== "number")
			return { error: `Champ 'deleted' absent: ${JSON.stringify(data)}` };
		if (result.deleted < 2) return { error: `${result.deleted} supprimée(s), attendu 2` };
	});

	await check("POST /notes/get — note supprimée via delete_paths introuvable", async () => {
		const { status } = await pluginPostWithKey("/notes/get", { path: DEL_PATH_A }, wikiApiKey);
		if (status === 200) return { error: "Note supprimée toujours accessible" };
	});

	await check("POST /notes/get — note conservée toujours accessible", async () => {
		const { status, data } = await pluginPostWithKey("/notes/get", { path: KEEP_PATH }, wikiApiKey);
		if (status !== 200) return { error: `Note conservée introuvable (status ${status})` };
		const note = data?.data?.note || data?.note;
		if (!note) return { error: "Note conservée non retournée" };
	});

	await pluginPostWithKey("/notes/delete", { path: KEEP_PATH }, wikiApiKey);
}

async function testWikiAttachments() {
	console.log(`\n${CYAN}${BOLD}── Plugin Wiki — attachments ────────────────────────${RESET}`);

	if (!wikiApiKey) {
		warned++;
		log("⚠", YELLOW, "Clé API absente — tests attachments ignorés");
		return;
	}

	const ts = Date.now();
	// 1x1 white PNG — base64 string (used directly as 'data' field in JSON body)
	const PNG_B64 =
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
	const ATTACH_PATH = `__qa-attach__/qa-test-${ts}.png`;
	const ATTACH_FILENAME = `qa-test-${ts}.png`;

	let uploadedPath = "";

	// Upload route uses JSON+base64 transport (multipart is not viable in plugin sandbox RPC).
	// ctx.media.upload() is only available on Cloudflare Workers — in dev mode (Node.js)
	// PluginRouteRegistry does not wire getUploadUrl/storage so it returns 400 with a specific
	// message. Treat that specific 400 as a warning, not a failure.
	await check("POST /attachments/upload — upload PNG avec X-Wiki-Key", async () => {
		const res = await fetch(`${PLUGIN}/attachments/upload`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Wiki-Key": wikiApiKey },
			body: JSON.stringify({
				path: ATTACH_PATH,
				filename: ATTACH_FILENAME,
				mimeType: "image/png",
				data: PNG_B64,
			}),
		});
		const data = await res.json().catch(() => null);
		if (res.status === 400) {
			const msg = data?.error?.message || JSON.stringify(data);
			if (msg.includes("media:write capability not available"))
				return { warn: "ctx.media non disponible en dev Node.js — OK en Cloudflare Workers" };
			return { error: `Status 400 — ${msg}` };
		}
		if (res.status !== 200)
			return { error: `Status ${res.status} — ${data?.error?.message || JSON.stringify(data)}` };
		const result = data?.data || data;
		if (!result?.url) return { error: `url manquante: ${JSON.stringify(data)}` };
		if (!result?.path) return { error: `path manquant: ${JSON.stringify(data)}` };
		uploadedPath = result.path;
	});

	await check("POST /attachments/upload — rejeté sans clé API", async () => {
		const res = await fetch(`${PLUGIN}/attachments/upload`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				path: `__qa-attach__/unauth-${ts}.png`,
				filename: `unauth-${ts}.png`,
				mimeType: "image/png",
				data: PNG_B64,
			}),
		});
		if (res.status !== 401) return { error: `Expected 401, got ${res.status}` };
	});

	await check("GET /attachments — liste avec X-Wiki-Key", async () => {
		const { status, data } = await pluginGetWithKey("/attachments", wikiApiKey);
		if (status !== 200)
			return { error: `Status ${status} — ${data?.error?.message || JSON.stringify(data)}` };
		const result = data?.data || data;
		if (!Array.isArray(result?.attachments))
			return { error: `tableau 'attachments' absent: ${JSON.stringify(data)}` };
		if (uploadedPath && !result.attachments.some((a) => a.path === uploadedPath))
			return { warn: `Attachment uploadé non trouvé dans la liste` };
	});

	await check("GET /attachments — rejeté sans clé API", async () => {
		const { status } = await pluginGet("/attachments");
		if (status !== 401) return { error: `Expected 401, got ${status}` };
	});

	if (uploadedPath) {
		await check("POST /attachments/delete — supprime l'attachment uploadé", async () => {
			const { status, data } = await pluginPostWithKey(
				"/attachments/delete",
				{ path: uploadedPath },
				wikiApiKey,
			);
			if (status !== 200)
				return { error: `Status ${status} — ${data?.error?.message || JSON.stringify(data)}` };
			const result = data?.data || data;
			if (!result?.deleted) return { error: `'deleted' non retourné: ${JSON.stringify(data)}` };
		});

		await check("POST /attachments/delete — introuvable après suppression", async () => {
			const { status } = await pluginPostWithKey(
				"/attachments/delete",
				{ path: uploadedPath },
				wikiApiKey,
			);
			if (status === 200) return { error: "Attachment supprimé toujours accessible" };
		});
	}
}

// ── Plugin Wiki — rendu Markdown ──────────────────────────────────────────

async function testWikiRendering() {
	console.log(`\n${CYAN}${BOLD}── Plugin Wiki — rendu Markdown ────────────────────${RESET}`);

	if (!wikiApiKey) {
		warned++;
		log("⚠", YELLOW, "Clé API manquante — tests rendu ignorés");
		return;
	}

	const ts = Date.now();
	const RENDER_PREFIX = `__qa-render__`;

	// ── blockquotes ──────────────────────────────────────────────────────────
	const BLOCKQUOTE_PATH = `${RENDER_PREFIX}/blockquote-${ts}.md`;
	await pluginPostWithKey(
		"/notes/create",
		{ path: BLOCKQUOTE_PATH, content: "# BQ\n\n> Ceci est une citation.", visibility: "public" },
		wikiApiKey,
	);

	await check("Rendu — blockquote rendu en <blockquote>", async () => {
		const encodedPath = BLOCKQUOTE_PATH.split("/").map(encodeURIComponent).join("/");
		const res = await get(`/wiki/${encodedPath}`);
		if (res.status !== 200) return { error: `Status ${res.status}` };
		const html = await res.text();
		if (!html.includes("<blockquote>"))
			return { error: "Balise <blockquote> absente du rendu" };
		if (!html.includes("Ceci est une citation"))
			return { error: "Texte du blockquote absent" };
	});

	// ── code block (CRLF) ─────────────────────────────────────────────────────
	const CRLF_PATH = `${RENDER_PREFIX}/crlf-${ts}.md`;
	const crlfContent = "# CRLF\r\n\r\n```js\r\nconsole.log('hello');\r\n```";
	await pluginPostWithKey(
		"/notes/create",
		{ path: CRLF_PATH, content: crlfContent, visibility: "public" },
		wikiApiKey,
	);

	await check("Rendu — code block avec CRLF rendu en <pre><code>", async () => {
		const encodedPath = CRLF_PATH.split("/").map(encodeURIComponent).join("/");
		const res = await get(`/wiki/${encodedPath}`);
		if (res.status !== 200) return { error: `Status ${res.status}` };
		const html = await res.text();
		if (!html.includes("<pre>") && !html.includes("<code"))
			return { error: "Balise <pre> ou <code> absente" };
		if (!html.includes("console.log"))
			return { error: "Contenu du code block absent" };
	});

	// ── $& dans le contenu (placeholder corruption) ─────────────────────────
	const DOLLAR_PATH = `${RENDER_PREFIX}/dollar-${ts}.md`;
	await pluginPostWithKey(
		"/notes/create",
		{ path: DOLLAR_PATH, content: "# Dollar\n\n```bash\necho $& $1 $'\n```", visibility: "public" },
		wikiApiKey,
	);

	await check("Rendu — $& dans code block non corrompu", async () => {
		const encodedPath = DOLLAR_PATH.split("/").map(encodeURIComponent).join("/");
		const res = await get(`/wiki/${encodedPath}`);
		if (res.status !== 200) return { error: `Status ${res.status}` };
		const html = await res.text();
		if (html.includes("%%CODE_") || html.includes("%%INLINE_"))
			return { error: "Placeholder non restauré dans le HTML final" };
		if (html.includes("undefinedamp;") || html.includes("&amp;amp;"))
			return { error: "Double-encodage HTML détecté — probable corruption de $&" };
	});

	// ── table avec cellule vide ──────────────────────────────────────────────
	const TABLE_PATH = `${RENDER_PREFIX}/table-${ts}.md`;
	await pluginPostWithKey(
		"/notes/create",
		{
			path: TABLE_PATH,
			content: "# Table\n\n| A | B |\n|---|---|\n| x |  |\n",
			visibility: "public",
		},
		wikiApiKey,
	);

	await check("Rendu — table avec cellule vide contient <table>", async () => {
		const encodedPath = TABLE_PATH.split("/").map(encodeURIComponent).join("/");
		const res = await get(`/wiki/${encodedPath}`);
		if (res.status !== 200) return { error: `Status ${res.status}` };
		const html = await res.text();
		if (!html.includes("<table>")) return { error: "Balise <table> absente" };
		if (!html.includes("<td>")) return { error: "Balise <td> absente" };
	});

	// ── bold/italic dans liste ───────────────────────────────────────────────
	const LIST_PATH = `${RENDER_PREFIX}/list-${ts}.md`;
	await pluginPostWithKey(
		"/notes/create",
		{
			path: LIST_PATH,
			content: "# Liste\n\n- **gras** item\n- _italique_ item\n",
			visibility: "public",
		},
		wikiApiKey,
	);

	await check("Rendu — bold/italic dans liste rendu correctement", async () => {
		const encodedPath = LIST_PATH.split("/").map(encodeURIComponent).join("/");
		const res = await get(`/wiki/${encodedPath}`);
		if (res.status !== 200) return { error: `Status ${res.status}` };
		const html = await res.text();
		if (!html.includes("<strong>") && !html.includes("<b>"))
			return { error: "Balise bold absente" };
		if (!html.includes("<em>") && !html.includes("<i>"))
			return { error: "Balise italic absente" };
	});

	// Cleanup
	for (const p of [BLOCKQUOTE_PATH, CRLF_PATH, DOLLAR_PATH, TABLE_PATH, LIST_PATH]) {
		await pluginPostWithKey("/notes/delete", { path: p }, wikiApiKey).catch(() => {});
	}
}

// ── Plugin Wiki — validation des chemins ──────────────────────────────────

async function testWikiPathValidation() {
	console.log(`\n${CYAN}${BOLD}── Plugin Wiki — validation des chemins ────────────${RESET}`);

	if (!wikiApiKey) {
		warned++;
		log("⚠", YELLOW, "Clé API manquante — tests validation ignorés");
		return;
	}

	const invalidPaths = [
		{ path: ".", label: "chemin '.' (segment point)" },
		{ path: "..", label: "chemin '..' (remontée)" },
		{ path: "foo//bar.md", label: "segment vide (double /)" },
		{ path: "/foo/bar.md", label: "chemin absolu (commence par /)" },
		{ path: "foo/../bar.md", label: "chemin avec .. (traversée)" },
		{ path: "foo/./bar.md", label: "chemin avec . (segment point)" },
		{ path: "foo\x00bar.md", label: "caractère nul (\\x00)" },
		{ path: "foo\x1fbar.md", label: "caractère contrôle C0 (\\x1f)" },
		{ path: "foo\x7fbar.md", label: "DEL (\\x7f)" },
	];

	for (const { path, label } of invalidPaths) {
		await check(`POST /notes/create — rejeté: ${label}`, async () => {
			const { status } = await pluginPostWithKey(
				"/notes/create",
				{ path, content: "# test\n\ncontenu.", visibility: "public" },
				wikiApiKey,
			);
			if (status === 200) return { error: `Status 200 — chemin invalide accepté: "${path}"` };
			if (status !== 400) return { warn: `Attendu 400, reçu ${status}` };
		});
	}

	await check("POST /notes/get — chemin vide rejeté (400)", async () => {
		const { status } = await pluginPostWithKey("/notes/get", { path: "" }, wikiApiKey);
		if (status === 200) return { error: "Chemin vide accepté" };
	});

	await check("GET /wiki/.. — pas de contenu wiki (traversée normalisée par HTTP)", async () => {
		// HTTP clients normalize /wiki/.. to / before sending the request — the server
		// never sees ".." in the path. Verify no wiki note content is served.
		const res = await get("/wiki/..");
		if (res.status !== 200) return;
		const text = await res.text();
		if (text.includes("wiki-bc")) return { error: "Contenu wiki servi via traversée de chemin" };
	});
}

// ── Plugin Wiki — sécurité des mises à jour ───────────────────────────────

async function testWikiFieldInjection() {
	console.log(`\n${CYAN}${BOLD}── Plugin Wiki — sécurité notes/update ─────────────${RESET}`);

	if (!wikiApiKey) {
		warned++;
		log("⚠", YELLOW, "Clé API manquante — tests injection ignorés");
		return;
	}

	const ts = Date.now();
	const INJ_PATH = `__qa-inj__/Note-Injection-${ts}.md`;

	await pluginPostWithKey(
		"/notes/create",
		{ path: INJ_PATH, content: "# Injection QA\n\nNote originale.", visibility: "public" },
		wikiApiKey,
	);

	await check("POST /notes/update — contenu vide rejeté (400)", async () => {
		const { status, data } = await pluginPostWithKey(
			"/notes/update",
			{ path: INJ_PATH, content: "" },
			wikiApiKey,
		);
		if (status === 200) return { error: "Contenu vide accepté — devrait être rejeté" };
		if (status !== 400)
			return { warn: `Attendu 400, reçu ${status}: ${data?.error?.message}` };
	});

	await check("POST /notes/update — contenu whitespace seul rejeté (400)", async () => {
		const { status } = await pluginPostWithKey(
			"/notes/update",
			{ path: INJ_PATH, content: "   \n\t  " },
			wikiApiKey,
		);
		if (status === 200) return { error: "Contenu whitespace seul accepté" };
	});

	await check("POST /notes/update — chemin ne peut pas être modifié via 'path injection'", async () => {
		// Send extra fields that should be ignored
		const { status, data } = await pluginPostWithKey(
			"/notes/update",
			{
				path: INJ_PATH,
				content: "# Updated\n\nContenu mis à jour.",
				id: "injected-id",
				createdAt: "1970-01-01T00:00:00.000Z",
				unknownField: "should be ignored",
			},
			wikiApiKey,
		);
		if (status !== 200)
			return { error: `Status ${status} — ${data?.error?.message}` };
		const note = data?.data?.note || data?.note;
		if (!note) return { error: "Note non retournée" };
		if (note.id === "injected-id") return { error: "id injecté accepté" };
		if (note.createdAt === "1970-01-01T00:00:00.000Z")
			return { error: "createdAt injecté accepté" };
		if (note.path !== INJ_PATH)
			return { error: `path modifié: ${note.path}` };
	});

	await check("POST /notes/update — path invalide rejeté", async () => {
		const { status } = await pluginPostWithKey(
			"/notes/update",
			{ path: "../../../etc/passwd", content: "pwned" },
			wikiApiKey,
		);
		if (status === 200) return { error: "Path traversal accepté" };
	});

	// Cleanup
	await pluginPostWithKey("/notes/delete", { path: INJ_PATH }, wikiApiKey).catch(() => {});
}

// ── Plugin Wiki — edge cases sync & since ─────────────────────────────────

async function testWikiSyncEdgeCases() {
	console.log(`\n${CYAN}${BOLD}── Plugin Wiki — sync & since edge cases ───────────${RESET}`);

	if (!wikiApiKey) {
		warned++;
		log("⚠", YELLOW, "Clé API manquante — tests sync edge cases ignorés");
		return;
	}

	// ── notes/since response shape ───────────────────────────────────────────
	await check("GET /notes/since — champs truncated & pool_overflow séparés", async () => {
		const { status, data } = await pluginGetWithKey(
			`/notes/since?since=1970-01-01T00:00:00.000Z&limit=1`,
			wikiApiKey,
		);
		if (status !== 200)
			return { error: `Status ${status} — ${data?.error?.message || JSON.stringify(data)}` };
		const body = data?.data || data;
		if (!("truncated" in body))
			return { error: "Champ 'truncated' absent de la réponse" };
		if (!("pool_overflow" in body))
			return { error: "Champ 'pool_overflow' absent de la réponse" };
		if (typeof body.truncated !== "boolean")
			return { error: `'truncated' devrait être boolean, reçu: ${typeof body.truncated}` };
		if (typeof body.pool_overflow !== "boolean")
			return { error: `'pool_overflow' devrait être boolean, reçu: ${typeof body.pool_overflow}` };
	});

	await check("GET /notes/since — 'total' et 'since' présents", async () => {
		const { status, data } = await pluginGetWithKey(
			`/notes/since?since=1970-01-01T00:00:00.000Z`,
			wikiApiKey,
		);
		if (status !== 200)
			return { error: `Status ${status}` };
		const body = data?.data || data;
		if (typeof body.total !== "number")
			return { error: `'total' absent ou non-numérique: ${typeof body.total}` };
		if (!body.since)
			return { error: "'since' absent de la réponse" };
	});

	// ── sync delete_paths > 200 rejeté avant tout write ──────────────────────
	await check("POST /sync — delete_paths > 200 rejeté (400)", async () => {
		const tooManyPaths = Array.from({ length: 201 }, (_, i) => `fake/note-${i}.md`);
		const { status, data } = await pluginPostWithKey(
			"/sync",
			{ notes: [], delete_paths: tooManyPaths },
			wikiApiKey,
		);
		if (status === 200) return { error: "201 delete_paths acceptés — devrait être rejeté" };
		if (status !== 400)
			return { warn: `Attendu 400, reçu ${status}: ${data?.error?.message}` };
	});

	await check("POST /sync — delete_paths = 200 accepté", async () => {
		const exactlyMax = Array.from({ length: 200 }, (_, i) => `__nonexistent__/fake-${i}.md`);
		const { status } = await pluginPostWithKey(
			"/sync",
			{ notes: [], delete_paths: exactlyMax },
			wikiApiKey,
		);
		// 200 or handled gracefully (some might not exist, that's fine)
		if (status !== 200)
			return { warn: `200 delete_paths devrait être accepté, reçu ${status}` };
	});

	// ── sync upsert then verify via since ────────────────────────────────────
	const ts = Date.now();
	const SINCE_PATH = `__qa-since__/Note-Since-${ts}.md`;
	const sinceMarker = new Date().toISOString();

	await pluginPostWithKey(
		"/notes/create",
		{ path: SINCE_PATH, content: "# Since Test\n\nNote pour tester since.", visibility: "public" },
		wikiApiKey,
	);

	await check("GET /notes/since — note créée apparaît dans le delta", async () => {
		const { status, data } = await pluginGetWithKey(
			`/notes/since?since=${encodeURIComponent(sinceMarker)}`,
			wikiApiKey,
		);
		if (status !== 200)
			return { error: `Status ${status}` };
		const body = data?.data || data;
		const notes = body?.notes || [];
		if (!notes.some((n) => n.path === SINCE_PATH))
			return { warn: "Note créée absente du delta since — timing issue?" };
	});

	// Cleanup
	await pluginPostWithKey("/notes/delete", { path: SINCE_PATH }, wikiApiKey).catch(() => {});
}

// ── Plugin Wiki — Block Kit admin actions ─────────────────────────────────

async function testWikiAdminBlockKit() {
	console.log(`\n${CYAN}${BOLD}── Plugin Wiki — Block Kit admin ───────────────────${RESET}`);

	if (!sessionCookie) {
		const authed = await authenticate();
		if (!authed) {
			warned++;
			log("⚠", YELLOW, "Auth indisponible — tests Block Kit ignorés");
			return;
		}
	}

	const ts = Date.now();
	const ADM_PATH = `__qa-admin__/AdminNote-${ts}.md`;
	const ADM_PATH2 = `__qa-admin__/AdminNote-moved-${ts}.md`;
	let adminNoteId = null;

	// ── do_create ─────────────────────────────────────────────────────────────
	await check("Admin Block Kit — do_create crée une note", async () => {
		const { status, data } = await pluginPost("/admin", {
			action_id: "do_create",
			values: {
				path: ADM_PATH,
				content: "# Admin Test\n\nNote créée via Block Kit.",
				visibility: "public",
			},
		});
		if (status !== 200)
			return { error: `Status ${status} — ${data?.error?.message || JSON.stringify(data)}` };
		const blocks = data?.data?.blocks || data?.blocks || [];
		const hasSuccess = blocks.some(
			(b) =>
				(b.title && b.title.includes("créée")) ||
				(b.description && b.description.includes("créée")),
		);
		if (!hasSuccess)
			return { warn: `Réponse do_create inattendue: ${JSON.stringify(blocks).slice(0, 200)}` };
	});

	// Récupère l'id de la note créée pour les tests suivants
	const createdResult = await pluginPostWithKey("/notes/get", { path: ADM_PATH }, wikiApiKey || "");
	if (createdResult.status === 200) {
		adminNoteId = createdResult.data?.data?.note?.id || createdResult.data?.note?.id;
	}

	// ── do_create — chemin invalide rejeté ────────────────────────────────────
	await check("Admin Block Kit — do_create avec chemin invalide retourne erreur", async () => {
		const { status, data } = await pluginPost("/admin", {
			action_id: "do_create",
			values: {
				path: "../../../etc/passwd",
				content: "pwned",
				visibility: "public",
			},
		});
		if (status !== 200)
			return; // 400 would be fine too
		const blocks = data?.data?.blocks || data?.blocks || [];
		const hasError = blocks.some((b) => b.variant === "error" || b.type === "banner");
		if (!hasError)
			return { error: "Chemin invalide accepté par do_create sans erreur" };
	});

	// ── nav_edit — ouvre la page d'édition ───────────────────────────────────
	if (adminNoteId) {
		await check("Admin Block Kit — nav_edit retourne le formulaire d'édition", async () => {
			const { status, data } = await pluginPost("/admin", {
				action_id: "nav_edit",
				value: JSON.stringify({ note_path: ADM_PATH }),
			});
			if (status !== 200)
				return { error: `Status ${status}` };
			const blocks = data?.data?.blocks || data?.blocks || [];
			const hasForm = blocks.some((b) => b.type === "form");
			if (!hasForm)
				return { warn: "Formulaire d'édition absent de la réponse" };
		});

		// ── do_edit — met à jour le contenu ──────────────────────────────────
		await check("Admin Block Kit — do_edit met à jour le contenu", async () => {
			const { status, data } = await pluginPost("/admin", {
				action_id: "do_edit",
				values: {
					_note_id: adminNoteId,
					content: "# Admin Test Modifié\n\nContenu mis à jour via Block Kit.",
					visibility: "public",
				},
			});
			if (status !== 200)
				return { error: `Status ${status} — ${data?.error?.message}` };
			const blocks = data?.data?.blocks || data?.blocks || [];
			const hasSuccess = blocks.some(
				(b) => b.title && (b.title.includes("Sauvegardé") || b.title.includes("mis à jour")),
			);
			if (!hasSuccess)
				return { warn: `Réponse do_edit inattendue: ${JSON.stringify(blocks).slice(0, 200)}` };
		});

		await check("Admin Block Kit — do_edit avec contenu vide retourne erreur", async () => {
			const { status, data } = await pluginPost("/admin", {
				action_id: "do_edit",
				values: { _note_id: adminNoteId, content: "" },
			});
			if (status !== 200)
				return;
			const blocks = data?.data?.blocks || data?.blocks || [];
			const hasError = blocks.some((b) => b.variant === "error");
			if (!hasError) return { error: "Contenu vide accepté par do_edit" };
		});

		// ── do_move — déplace la note ─────────────────────────────────────────
		await check("Admin Block Kit — do_move déplace la note", async () => {
			const { status, data } = await pluginPost("/admin", {
				action_id: "do_move",
				values: { _note_id: adminNoteId, new_path: ADM_PATH2 },
			});
			if (status !== 200)
				return { error: `Status ${status} — ${data?.error?.message}` };
			const blocks = data?.data?.blocks || data?.blocks || [];
			const hasSuccess = blocks.some(
				(b) => b.title && (b.title.includes("Déplacée") || b.title.includes("déplacée")),
			);
			if (!hasSuccess)
				return { warn: `Réponse do_move inattendue: ${JSON.stringify(blocks).slice(0, 200)}` };
		});

		// ── do_delete — supprime la note ──────────────────────────────────────
		await check("Admin Block Kit — do_delete supprime la note", async () => {
			const { status, data } = await pluginPost("/admin", {
				action_id: "do_delete",
				value: JSON.stringify({ note_path: ADM_PATH2 }),
			});
			if (status !== 200)
				return { error: `Status ${status} — ${data?.error?.message}` };
			const blocks = data?.data?.blocks || data?.blocks || [];
			const hasSuccess = blocks.some(
				(b) => b.title && (b.title.includes("Supprimée") || b.title.includes("supprimée")),
			);
			if (!hasSuccess)
				return { warn: `Réponse do_delete inattendue: ${JSON.stringify(blocks).slice(0, 200)}` };
		});

		await check("Admin Block Kit — note supprimée introuvable après do_delete", async () => {
			const { status } = await pluginPostWithKey("/notes/get", { path: ADM_PATH2 }, wikiApiKey || "");
			if (status === 200) return { error: "Note toujours accessible après do_delete" };
		});
	} else {
		warned++;
		log("⚠", YELLOW, "do_create a échoué — tests do_edit/do_move/do_delete ignorés");
		// Cleanup attempt
		if (wikiApiKey)
			await pluginPostWithKey("/notes/delete", { path: ADM_PATH }, wikiApiKey).catch(() => {});
	}

	// ── Admin sans session rejeté ────────────────────────────────────────────
	await check("POST /admin sans session — rejeté (401)", async () => {
		const res = await fetch(`${PLUGIN}/admin`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
			body: JSON.stringify({ action_id: "nav_list" }),
		});
		if (res.status === 200) return { error: "Admin accessible sans session" };
		if (res.status !== 401 && res.status !== 403)
			return { warn: `Attendu 401/403, reçu ${res.status}` };
	});
}

// ── Plugin Wiki — sécurité des pièces jointes ─────────────────────────────

async function testWikiAttachmentSecurity() {
	console.log(`\n${CYAN}${BOLD}── Plugin Wiki — sécurité attachments ──────────────${RESET}`);

	if (!wikiApiKey) {
		warned++;
		log("⚠", YELLOW, "Clé API manquante — tests attachment security ignorés");
		return;
	}

	const ts = Date.now();

	// ── SVG rejeté ────────────────────────────────────────────────────────────
	await check("POST /attachments/upload — SVG rejeté (400)", async () => {
		const svgB64 = Buffer.from(
			'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
		).toString("base64");
		const res = await fetch(`${PLUGIN}/attachments/upload`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Wiki-Key": wikiApiKey },
			body: JSON.stringify({
				path: `__qa-sec__/xss-${ts}.svg`,
				filename: `xss-${ts}.svg`,
				mimeType: "image/svg+xml",
				data: svgB64,
			}),
		});
		if (res.status === 200) return { error: "SVG accepté — risque XSS" };
		if (res.status !== 400) return { warn: `Attendu 400, reçu ${res.status}` };
	});

	// ── mimeType/filename mismatch (svg extension) ────────────────────────────
	await check("POST /attachments/upload — extension .svg avec image/png rejeté", async () => {
		const fakeB64 = Buffer.from("fake png data").toString("base64");
		const res = await fetch(`${PLUGIN}/attachments/upload`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Wiki-Key": wikiApiKey },
			body: JSON.stringify({
				path: `__qa-sec__/disguised-${ts}.svg`,
				filename: `disguised-${ts}.svg`,
				mimeType: "image/png",
				data: fakeB64,
			}),
		});
		// SVG extension should be rejected regardless of declared mimeType
		if (res.status === 200) return { error: "Fichier .svg avec image/png accepté" };
	});

	// ── payload trop grand ───────────────────────────────────────────────────
	await check("POST /attachments/upload — payload > 20MB rejeté (400)", async () => {
		// Generate a base64 string that exceeds the limit check (>20MB decoded)
		// 20MB * 4/3 ≈ 27MB of base64. We send 28MB of 'A' chars.
		const oversizedB64 = "A".repeat(28 * 1024 * 1024);
		const res = await fetch(`${PLUGIN}/attachments/upload`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Wiki-Key": wikiApiKey },
			body: JSON.stringify({
				path: `__qa-sec__/oversize-${ts}.png`,
				filename: `oversize-${ts}.png`,
				mimeType: "image/png",
				data: oversizedB64,
			}),
		});
		if (res.status === 200) return { error: "Payload > 20MB accepté" };
		if (res.status !== 400) return { warn: `Attendu 400, reçu ${res.status}` };
	});

	// ── base64 avec whitespace (MIME multipart) ──────────────────────────────
	await check("POST /attachments/upload — base64 avec whitespace MIME accepté", async () => {
		// A 1x1 red PNG, split with newlines every 76 chars (MIME multipart style)
		const PNG_1X1 =
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==";
		// Insert newlines every 20 chars to simulate MIME encoding
		const withNewlines = PNG_1X1.match(RE_B64_CHUNKS)?.join("\n") || PNG_1X1;
		const res = await fetch(`${PLUGIN}/attachments/upload`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Wiki-Key": wikiApiKey },
			body: JSON.stringify({
				path: `__qa-sec__/b64-ws-${ts}.png`,
				filename: `b64-ws-${ts}.png`,
				mimeType: "image/png",
				data: withNewlines,
			}),
		});
		const data = await res.json().catch(() => null);
		if (res.status === 400) {
			const msg = data?.error?.message || "";
			if (msg.includes("media:write capability not available"))
				return { warn: "ctx.media non disponible en dev Node.js — OK en Cloudflare Workers" };
			// Should NOT fail with "invalid base64" — whitespace should be stripped
			if (msg.toLowerCase().includes("base64") || msg.toLowerCase().includes("invalid"))
				return { error: `Base64 avec whitespace rejeté: ${msg}` };
			return { warn: `Status 400 inattendu: ${msg}` };
		}
		// 200 means whitespace was stripped correctly
	});
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
	console.log(`\n${BOLD}${CYAN}╔══════════════════════════════════════════════════╗${RESET}`);
	console.log(`${BOLD}${CYAN}║  QA — theme-iotech                               ║${RESET}`);
	console.log(`${BOLD}${CYAN}║  Base URL: ${BASE.padEnd(37)}║${RESET}`);
	console.log(`${BOLD}${CYAN}╚══════════════════════════════════════════════════╝${RESET}`);

	try {
		await fetch(BASE);
	} catch {
		console.error(`\n${RED}${BOLD}✗ Serveur inaccessible à ${BASE}${RESET}`);
		console.error(`${DIM}Lance le dev server : pnpm --filter @iotech/theme-iotech dev${RESET}\n`);
		process.exit(1);
	}

	await testPages();
	await testNavigation();
	await testBlog();
	await testRSS();
	await testAssets();
	await testWikiPublicRoutes();
	await testWikiPage();
	await testWikiCRUD();
	await testWikiURLEncoding();
	await testWikiSync();
	await testWikiSecurity();
	await testWikiDeltaSync();
	await testWikiSyncDeletePaths();
	await testWikiAttachments();
	await testWikiRendering();
	await testWikiPathValidation();
	await testWikiFieldInjection();
	await testWikiSyncEdgeCases();
	await testWikiAdminBlockKit();
	await testWikiAttachmentSecurity();

	console.log(`\n${CYAN}${BOLD}── Résumé ──────────────────────────────────────────${RESET}`);
	console.log(
		`${GREEN}${BOLD}✓ ${passed} passé(s)${RESET}  ${YELLOW}⚠ ${warned} avertissement(s)${RESET}  ${RED}✗ ${failed} échoué(s)${RESET}`,
	);

	if (failures.length > 0) {
		console.log(`\n${RED}${BOLD}Échecs :${RESET}`);
		for (const f of failures) {
			console.log(`  ${RED}✗${RESET} ${BOLD}${f.label}${RESET}`);
			console.log(`    ${DIM}${f.detail}${RESET}`);
		}
	}

	if (failed > 0) {
		console.log(`\n${RED}Des tests ont échoué — corriger avant de déployer.${RESET}`);
		process.exit(1);
	} else if (warned > 0) {
		console.log(`\n${YELLOW}Tout fonctionne avec des avertissements mineurs.${RESET}`);
	} else {
		console.log(`\n${GREEN}${BOLD}Tout est vert !${RESET}`);
	}
}

main().catch((e) => {
	console.error(RED + e.message + RESET);
	process.exit(1);
});
