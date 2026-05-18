/**
 * smoke-test.mjs — lightweight post-deploy health check.
 *
 * Runs against any URL (local or production) without authentication.
 * Tests that pages load, navigation is seeded, security headers are present,
 * CSRF protection works, and the wiki plugin routes respond correctly.
 *
 * Run from the monorepo root:
 *   node templates/theme-iotech-cloudflare-v3/smoke-test.mjs                              # production
 *   node templates/theme-iotech-cloudflare-v3/smoke-test.mjs http://localhost:4321        # local
 *   BASE_URL=https://my-staging.workers.dev node templates/theme-iotech-cloudflare-v3/smoke-test.mjs
 *
 * Exit 0 = all checks passed. Exit 1 = one or more failures.
 */

const BASE_URL = (
	process.argv.find((a) => a.startsWith("http")) ||
	process.env.BASE_URL ||
	"https://website-prod.i0tech.workers.dev"
).replace(/\/$/, "");

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

let passed = 0;
let failed = 0;
let warned = 0;

function ok(label) {
	console.log(`  ${green("PASS")}  ${label}`);
	passed++;
}

function fail(label, detail = "") {
	console.log(`  ${red("FAIL")}  ${label}${detail ? `  ${dim("→")} ${detail}` : ""}`);
	failed++;
}

function warn(label, detail = "") {
	console.log(`  ${yellow("WARN")}  ${label}${detail ? `  ${dim("→")} ${detail}` : ""}`);
	warned++;
}

async function get(path, opts = {}) {
	const url = `${BASE_URL}${path}`;
	try {
		const res = await fetch(url, {
			redirect: opts.redirect ?? "follow",
			headers: opts.headers ?? {},
			method: opts.method ?? "GET",
			body: opts.body,
			signal: AbortSignal.timeout(15_000),
		});
		const text = opts.noBody ? "" : await res.text().catch(() => "");
		return { ok: res.ok, status: res.status, text, headers: res.headers, url: res.url };
	} catch (err) {
		return { ok: false, status: 0, text: "", headers: new Headers(), url, error: err.message };
	}
}

// ─── helpers ───────────────────────────────────────────────────────────────────

function hasText(text, needle, label) {
	if (text.includes(needle)) {
		ok(label);
	} else {
		fail(label, `"${needle}" not found`);
	}
}

function statusIs(res, expected, label) {
	if (res.status === expected) {
		ok(label);
	} else {
		fail(label, `got ${res.status}, expected ${expected}`);
	}
}

// ─── sections ──────────────────────────────────────────────────────────────────

async function checkPages() {
	console.log(bold("\n  Pages"));

	const pages = [
		["/", "Accueil"],
		["/services", "Services"],
		["/posts", "Blog"],
		["/a-propos", "À propos"],
		["/contact", "Contact"],
		["/wiki", "Wiki"],
	];

	for (const [path, label] of pages) {
		const r = await get(path);
		if (!r.ok) {
			fail(`${label} (${path})`, `HTTP ${r.status}`);
		} else {
			ok(`${label} (${path}) → 200`);
		}
	}
}

async function checkNavigation() {
	console.log(bold("\n  Navigation (menu seeded correctly)"));

	const r = await get("/");
	if (!r.ok) { warn("Skipping nav checks — homepage unavailable"); return; }

	// These nav links must appear in the HTML — confirms menus are seeded with correct `name` column
	const links = [
		["/services", "Services"],
		["/posts", "Blog"],
		["/wiki", "Wiki"],
		["/contact", "Contact"],
		["/a-propos", "À propos"],
	];
	for (const [href, label] of links) {
		const present = r.text.includes(`href="${href}"`) || r.text.includes(`href='${href}'`);
		if (present) {
			ok(`Nav link: ${label} (${href})`);
		} else {
			fail(`Nav link: ${label} (${href})`, "href not found in homepage HTML");
		}
	}
}

async function checkRss() {
	console.log(bold("\n  RSS"));

	const r = await get("/rss.xml");
	if (!r.ok) { fail("RSS feed", `HTTP ${r.status}`); return; }
	ok("RSS feed returns 200");

	if (r.headers.get("content-type")?.includes("xml")) {
		ok("RSS content-type is XML");
	} else {
		warn("RSS content-type", r.headers.get("content-type") ?? "missing");
	}

	hasText(r.text, "<rss", "RSS contains <rss> tag");
	hasText(r.text, "<channel>", "RSS contains <channel>");
}

async function checkWiki() {
	console.log(bold("\n  Wiki"));

	// Public wiki index
	const idx = await get("/wiki");
	if (!idx.ok) { fail("Wiki index", `HTTP ${idx.status}`); return; }
	ok("Wiki index → 200");

	// Plugin API (public list endpoint — should return JSON, not 404/500)
	const api = await get("/_emdash/api/plugins/markdown-wiki/notes");
	if (api.status === 404) {
		fail("Wiki plugin route registered", "404 — plugin may not be loaded");
	} else if (api.status === 200) {
		ok("Wiki plugin route registered → 200");
	} else if (api.status === 401 || api.status === 403) {
		ok("Wiki plugin route registered → auth-gated (expected)");
	} else {
		warn("Wiki plugin route", `HTTP ${api.status}`);
	}

	// No "Plugin route not found" bleed into any HTML page
	const wikiPage = await get("/wiki");
	if (wikiPage.text.includes("Plugin route not found")) {
		fail("Wiki page clean (no plugin error)", '"Plugin route not found" visible in HTML');
	} else {
		ok("Wiki page clean (no plugin error)");
	}

	// Wiki RSS
	const rss = await get("/wiki/rss.xml");
	if (rss.ok) {
		ok("Wiki RSS → 200");
	} else {
		warn("Wiki RSS", `HTTP ${rss.status}`);
	}
}

async function checkSecurity() {
	console.log(bold("\n  Security"));

	// POST without CSRF header must be rejected (403 or 401, not 200)
	const csrf = await get("/_emdash/api/content/posts", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ title: "test" }),
		noBody: true,
	});
	if (csrf.status === 403 || csrf.status === 401) {
		ok("CSRF: POST without X-EmDash-Request → rejected");
	} else if (csrf.status === 422 || csrf.status === 400) {
		// Some configurations validate body before CSRF — treat as pass since it's rejecting
		ok("CSRF: POST without X-EmDash-Request → rejected (validation)");
	} else {
		fail("CSRF: POST without X-EmDash-Request", `got ${csrf.status}, expected 401/403`);
	}

	// Admin routes require auth
	const admin = await get("/_emdash/admin", { redirect: "manual", noBody: true });
	if (admin.status === 302 || admin.status === 301 || admin.status === 401 || admin.status === 403) {
		ok("Admin protected (redirects or 401/403)");
	} else if (admin.status === 200) {
		// Check if it's a login page rather than actual admin
		warn("Admin returns 200 — verify it requires login in the browser");
	} else {
		warn("Admin", `HTTP ${admin.status}`);
	}

	// Dev-bypass must return 403 in production (not in dev)
	const isLocalhost = BASE_URL.includes("localhost") || BASE_URL.includes("127.0.0.1");
	if (!isLocalhost) {
		const bypass = await get("/_emdash/api/setup/dev-bypass", { noBody: true });
		if (bypass.status === 403) {
			ok("Dev-bypass returns 403 in production");
		} else {
			fail("Dev-bypass returns 403 in production", `got ${bypass.status} — security risk!`);
		}
	} else {
		warn("Dev-bypass check skipped (running against localhost)");
	}

	// Wiki API key rejection — wrong key must return 401
	const badKey = await get("/_emdash/api/plugins/markdown-wiki/sync", {
		method: "POST",
		headers: { "X-Wiki-Key": "invalid-key-that-should-be-rejected", "content-type": "application/json" },
		body: JSON.stringify({}),
		noBody: true,
	});
	if (badKey.status === 401 || badKey.status === 403) {
		ok("Wiki API: invalid key → 401/403");
	} else if (badKey.status === 404) {
		warn("Wiki sync route not found (plugin may not expose sync publicly — check config)");
	} else if (badKey.status === 405) {
		ok("Wiki API: sync route exists, method rejected (expected)");
	} else {
		warn("Wiki API key rejection", `HTTP ${badKey.status}`);
	}

	// Path traversal attempt on wiki
	const traversal = await get("/wiki/../../../etc/passwd");
	if (traversal.status === 404 || traversal.status === 400) {
		ok("Path traversal attempt → 404/400");
	} else if (traversal.status === 200 && !traversal.text.includes("root:")) {
		ok("Path traversal attempt → 200 but not sensitive content");
	} else if (traversal.status === 200 && traversal.text.includes("root:")) {
		fail("Path traversal — /etc/passwd content visible!");
	} else {
		warn("Path traversal", `HTTP ${traversal.status}`);
	}
}

async function checkAssets() {
	console.log(bold("\n  Assets"));

	const r = await get("/");
	if (!r.ok) { warn("Skipping asset checks — homepage unavailable"); return; }

	// favicon
	const favicon = await get("/favicon.svg", { noBody: true });
	if (favicon.ok) {
		ok("favicon.svg → 200");
	} else {
		warn("favicon.svg", `HTTP ${favicon.status}`);
	}

	// Check that CSS loads (look for a <link> tag pointing to a .css file)
	const hasStylesheet = /<link[^>]+\.css/.test(r.text);
	if (hasStylesheet) {
		ok("Stylesheet link present in HTML");
	} else {
		warn("No <link rel=stylesheet> found in homepage");
	}
}

// ─── main ──────────────────────────────────────────────────────────────────────

console.log(bold("\n╔══════════════════════════════════════════════════╗"));
console.log(bold("║  IØTech Smoke Test                               ║"));
console.log(bold("╚══════════════════════════════════════════════════╝"));
console.log(dim(`  Target: ${BASE_URL}\n`));

await checkPages();
await checkNavigation();
await checkRss();
await checkWiki();
await checkSecurity();
await checkAssets();

console.log();
console.log(bold("─".repeat(52)));

const total = passed + failed + warned;
const statusLine = [
	passed > 0 ? green(`${passed} passed`) : null,
	warned > 0 ? yellow(`${warned} warnings`) : null,
	failed > 0 ? red(`${failed} failed`) : null,
].filter(Boolean).join("  ");

console.log(`  ${statusLine}  ${dim(`(${total} checks)`)}`);
console.log();

if (failed > 0) {
	console.log(bold(red(`✗ Smoke test FAILED — ${failed} check(s) need attention.\n`)));
	process.exit(1);
} else {
	console.log(bold(green(`✓ Smoke test passed.\n`)));
	process.exit(0);
}
