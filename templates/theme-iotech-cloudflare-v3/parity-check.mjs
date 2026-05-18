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
import { fileURLToPath } from "url";
import { resolve, dirname } from "path";

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

console.log();
if (diffs === 0 && missing === 0) {
	console.log(bold(green(`✓ All ${SHARED_FILES.length} shared files are identical.\n`)));
	process.exit(0);
} else {
	if (missing > 0) console.log(red(`✗ ${missing} file(s) missing`));
	if (diffs > 0) {
		console.log(red(`✗ ${diffs} file(s) differ`));
		console.log(yellow("  Run: cp templates/theme-iotech-v3/<file> templates/theme-iotech-cloudflare-v3/<file>"));
	}
	console.log();
	process.exit(1);
}
