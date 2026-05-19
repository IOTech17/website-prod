/**
 * Parity check: verifies that all shared source files between
 * theme-iotech-v3 (dev) and theme-iotech-cloudflare-v3 (prod) are identical.
 *
 * Run from the monorepo root:
 *   node templates/theme-iotech-cloudflare-v3/parity-check.mjs
 *
 * Exit 0 = all files identical. Exit 1 = drift detected.
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const SHARED_FILES = [
	"src/styles/global.css",
	"src/layouts/Base.astro",
	"src/layouts/WikiLayout.astro",
	"src/components/PostCard.astro",
	"src/components/ServiceCard.astro",
	"src/components/WikiTreeNode.astro",
	"src/pages/index.astro",
	"src/pages/services.astro",
	"src/pages/contact.astro",
	"src/pages/a-propos.astro",
	"src/pages/api/contact.ts",
	"src/pages/posts/index.astro",
	"src/pages/posts/[slug].astro",
	"src/pages/wiki/index.astro",
	"src/pages/wiki/[...path].astro",
	"src/pages/wiki/rss.xml.ts",
	"src/pages/rss.xml.ts",
	"src/utils/wiki-tree.ts",
];

const V3 = resolve(root, "templates/theme-iotech-v3");
const CF = resolve(root, "templates/theme-iotech-cloudflare-v3");

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

console.log(bold("\n╔══════════════════════════════════════════════════╗"));
console.log(bold("║  Parity Check — v3 ↔ cloudflare-v3              ║"));
console.log(bold("╚══════════════════════════════════════════════════╝\n"));

let diffs = 0;
let missing = 0;

for (const f of SHARED_FILES) {
	const pathV3 = resolve(V3, f);
	const pathCF = resolve(CF, f);

	if (!existsSync(pathV3)) {
		console.log(`  ${red("MISSING")}  ${f}  (in theme-iotech-v3)`);
		missing++;
		continue;
	}
	if (!existsSync(pathCF)) {
		console.log(`  ${red("MISSING")}  ${f}  (in theme-iotech-cloudflare-v3)`);
		missing++;
		continue;
	}

	const a = readFileSync(pathV3);
	const b = readFileSync(pathCF);

	if (a.equals(b)) {
		console.log(`  ${green("OK")}       ${f}`);
	} else {
		console.log(`  ${red("DIFF")}     ${f}`);
		diffs++;
	}
}

// ─── seed.json menu name validation ────────────────────────────────────────────

console.log(bold("\n╔══════════════════════════════════════════════════╗"));
console.log(bold("║  Seed Validation — menu names are slugs          ║"));
console.log(bold("╚══════════════════════════════════════════════════╝\n"));

let seedErrors = 0;

const REQUIRED_MENU_NAMES = ["header", "footer-nav", "footer-contact"];

for (const themeDir of [V3, CF]) {
	const themeName = themeDir === V3 ? "theme-iotech-v3" : "theme-iotech-cloudflare-v3";
	const seedPath = resolve(themeDir, "seed/seed.json");
	if (!existsSync(seedPath)) {
		console.log(`  ${yellow("SKIP")}     seed.json not found in ${themeName}`);
		continue;
	}

	let seed;
	try {
		seed = JSON.parse(readFileSync(seedPath, "utf8"));
	} catch {
		console.log(`  ${red("ERROR")}    Failed to parse seed.json in ${themeName}`);
		seedErrors++;
		continue;
	}

	const menus = seed.menus ?? [];
	const menuNames = menus.map((m) => m.name);
	const slugPattern = /^[a-z][a-z0-9-]*$/;

	for (const required of REQUIRED_MENU_NAMES) {
		if (menuNames.includes(required)) {
			console.log(`  ${green("OK")}       ${themeName}: menu name "${required}" ✓`);
		} else {
			console.log(
				`  ${red("MISSING")}  ${themeName}: menu name "${required}" — found: [${menuNames.join(", ")}]`,
			);
			seedErrors++;
		}
	}

	for (const menu of menus) {
		if (!slugPattern.test(menu.name ?? "")) {
			console.log(
				`  ${red("BAD")}      ${themeName}: menu name "${menu.name}" is not a slug — getMenu() will fail`,
			);
			seedErrors++;
		}
	}
}

// ─── astro.config.mjs plugin config validation ─────────────────────────────────

console.log(bold("\n╔══════════════════════════════════════════════════╗"));
console.log(bold("║  Plugin Config — cloudflare-v3 astro.config.mjs  ║"));
console.log(bold("╚══════════════════════════════════════════════════╝\n"));

let configErrors = 0;

const cfConfigPath = resolve(CF, "astro.config.mjs");
if (!existsSync(cfConfigPath)) {
	console.log(`  ${red("MISSING")}  astro.config.mjs not found in theme-iotech-cloudflare-v3`);
	configErrors++;
} else {
	const cfConfig = readFileSync(cfConfigPath, "utf8");

	// wikiPlugin must NOT be in sandboxed: [] — requires paid Worker Loader binding
	if (/sandboxed\s*:\s*\[[^\]]*wikiPlugin[^\]]*\]/.test(cfConfig)) {
		console.log(
			`  ${red("BAD")}      cloudflare-v3: wikiPlugin() is in sandboxed: [] — requires Worker Loader binding (paid). Move to plugins: []`,
		);
		configErrors++;
	} else {
		console.log(`  ${green("OK")}       cloudflare-v3: wikiPlugin() not in sandboxed: []`);
	}

	// wikiPlugin must be registered somewhere in the config
	if (!cfConfig.includes("wikiPlugin()")) {
		console.log(
			`  ${red("MISSING")}  cloudflare-v3: wikiPlugin() not found in astro.config.mjs — wiki will not work`,
		);
		configErrors++;
	} else {
		console.log(`  ${green("OK")}       cloudflare-v3: wikiPlugin() present in config`);
	}

	// auditLogPlugin should also be present (warn only — not critical)
	if (!cfConfig.includes("auditLogPlugin()")) {
		console.log(`  ${yellow("WARN")}     cloudflare-v3: auditLogPlugin() not found in config`);
	} else {
		console.log(`  ${green("OK")}       cloudflare-v3: auditLogPlugin() present in config`);
	}
}

// ─── summary ───────────────────────────────────────────────────────────────────

console.log();
const totalErrors = diffs + missing + seedErrors + configErrors;
if (totalErrors === 0) {
	console.log(
		bold(
			green(`✓ All ${SHARED_FILES.length} shared files identical. Seed and plugin config valid.\n`),
		),
	);
	process.exit(0);
} else {
	if (missing > 0) console.log(red(`✗ ${missing} file(s) missing`));
	if (diffs > 0) {
		console.log(red(`✗ ${diffs} file(s) differ`));
		console.log(yellow("  Run: node templates/theme-iotech-cloudflare-v3/sync-themes.mjs"));
	}
	if (seedErrors > 0) console.log(red(`✗ ${seedErrors} seed issue(s) — fix seed.json menu names`));
	if (configErrors > 0)
		console.log(
			red(`✗ ${configErrors} config issue(s) — fix astro.config.mjs plugin registration`),
		);
	console.log();
	process.exit(1);
}
