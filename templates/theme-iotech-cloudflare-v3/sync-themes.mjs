/**
 * sync-themes.mjs — copy shared source files from theme-iotech-v3 to theme-iotech-cloudflare-v3.
 *
 * Run from the monorepo root:
 *   node templates/theme-iotech-cloudflare-v3/sync-themes.mjs
 *
 * Dry-run (show what would change without writing):
 *   node templates/theme-iotech-cloudflare-v3/sync-themes.mjs --dry
 *
 * Exit 0 always (sync is not a gate, parity-check is).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const dry = process.argv.includes("--dry");
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
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const label = dry ? "DRY RUN — " : "";
console.log(bold(`\n╔══════════════════════════════════════════════════╗`));
console.log(
	bold(`║  ${label}Sync Themes — v3 → cloudflare-v3${" ".repeat(Math.max(0, 16 - label.length))}║`),
);
console.log(bold(`╚══════════════════════════════════════════════════╝\n`));

let copied = 0;
let skipped = 0;
let errors = 0;

for (const f of SHARED_FILES) {
	const src = resolve(V3, f);
	const dst = resolve(CF, f);

	if (!existsSync(src)) {
		console.log(`  ${red("MISSING")}  ${f}  (source not found in theme-iotech-v3)`);
		errors++;
		continue;
	}

	const srcBytes = readFileSync(src);

	if (existsSync(dst)) {
		const dstBytes = readFileSync(dst);
		if (srcBytes.equals(dstBytes)) {
			console.log(`  ${dim("OK")}       ${f}`);
			skipped++;
			continue;
		}
	}

	if (dry) {
		console.log(`  ${yellow("WOULD")}    ${f}`);
		copied++;
	} else {
		const dir = dirname(dst);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(dst, srcBytes);
		console.log(`  ${green("COPIED")}   ${f}`);
		copied++;
	}
}

console.log();
if (errors > 0) {
	console.log(red(`✗ ${errors} source file(s) missing — check theme-iotech-v3`));
}
if (dry) {
	console.log(bold(yellow(`  ${copied} file(s) would be updated, ${skipped} already in sync.\n`)));
} else {
	console.log(bold(green(`✓ ${copied} file(s) synced, ${skipped} already in sync.\n`)));
}
