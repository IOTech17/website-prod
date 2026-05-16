const RE_MD_EXT = /\.md$/;

export interface NoteEntry {
	id: string;
	title: string;
	path: string;
	visibility: "public" | "private" | "clients";
	tags: string[];
	updatedAt: string;
}

export interface TreeNode {
	type: "folder" | "note";
	name: string;
	path: string;
	children?: TreeNode[];
	note?: NoteEntry;
	depth: number;
}

export function buildTree(notes: NoteEntry[]): TreeNode[] {
	const folders = new Map<string, TreeNode>();
	const result: TreeNode[] = [];

	const sorted = notes.toSorted((a, b) =>
		a.path.localeCompare(b.path, "fr", { sensitivity: "base" }),
	);

	for (const note of sorted) {
		const parts = note.path.split("/");

		for (let i = 1; i < parts.length; i++) {
			const folderPath = parts.slice(0, i).join("/");
			if (!folders.has(folderPath)) {
				const folder: TreeNode = {
					type: "folder",
					name: parts[i - 1],
					path: folderPath,
					children: [],
					depth: i - 1,
				};
				folders.set(folderPath, folder);
				if (i === 1) {
					result.push(folder);
				} else {
					const parentPath = parts.slice(0, i - 1).join("/");
					folders.get(parentPath)?.children?.push(folder);
				}
			}
		}

		const noteNode: TreeNode = {
			type: "note",
			name: parts.at(-1)!.replace(RE_MD_EXT, ""),
			path: note.path,
			note,
			depth: parts.length - 1,
		};

		if (parts.length === 1) {
			result.push(noteNode);
		} else {
			const parentPath = parts.slice(0, -1).join("/");
			folders.get(parentPath)?.children?.push(noteNode);
		}
	}

	return sortTree(result);
}

function sortTree(nodes: TreeNode[]): TreeNode[] {
	return nodes
		.toSorted((a, b) => {
			if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
			return a.name.localeCompare(b.name, "fr", { sensitivity: "base" });
		})
		.map((node) => {
			if (node.children) node.children = sortTree(node.children);
			return node;
		});
}

export function countNotes(tree: TreeNode[]): number {
	let count = 0;
	for (const node of tree) {
		if (node.type === "note") count++;
		if (node.type === "folder" && node.children) count += countNotes(node.children);
	}
	return count;
}

export function getSiblings(notes: NoteEntry[], notePath: string): NoteEntry[] {
	const parentParts = notePath.split("/").slice(0, -1).join("/");
	return notes.filter((n) => {
		const nParent = n.path.split("/").slice(0, -1).join("/");
		return nParent === parentParts && n.path !== notePath;
	});
}
