import type { ArbitraryTypedObject } from "@portabletext/types";

import type { ContentfulEntry } from "../types.js";

export function transformCodeBlock(entry: ContentfulEntry, key: string): ArbitraryTypedObject {
	return {
		_type: "code",
		_key: key,
		code: typeof entry.fields.code === "string" ? entry.fields.code : "",
		language: typeof entry.fields.language === "string" ? entry.fields.language : "",
	};
}
