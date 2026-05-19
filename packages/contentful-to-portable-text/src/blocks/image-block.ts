import type { ArbitraryTypedObject } from "@portabletext/types";

import { sanitizeUri } from "../sanitize.js";
import type { ContentfulEntry, ContentfulIncludes } from "../types.js";

export function transformImageBlock(
	entry: ContentfulEntry,
	includes: ContentfulIncludes,
	key: string,
): ArbitraryTypedObject {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Contentful API returns Record<string,unknown>; shape validated at runtime via optional chaining
	const assetLink = entry.fields.assetFile as { sys?: { id?: string } } | undefined;
	const assetId = assetLink?.sys?.id;
	const asset = assetId ? includes.assets.get(assetId) : undefined;

	const src = asset?.url ? (asset.url.startsWith("//") ? `https:${asset.url}` : asset.url) : "";

	return {
		_type: "image",
		_key: key,
		asset: {
			src,
			alt: asset?.description ?? asset?.title ?? "",
			width: asset?.width,
			height: asset?.height,
		},
		linkUrl:
			typeof entry.fields.linkUrl === "string" ? sanitizeUri(entry.fields.linkUrl) : undefined,
		size: typeof entry.fields.size === "string" ? entry.fields.size : undefined,
	};
}
