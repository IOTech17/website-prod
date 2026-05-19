export const prerender = false;

import type { APIRoute } from "astro";
import { handleContentCreate } from "emdash";
import { getDb } from "emdash/runtime";

const MAX_LEN = { name: 120, email: 254, phone: 30, message: 5000 };

function strVal(v: unknown): string {
	return typeof v === "string" ? v : "";
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

export const POST: APIRoute = async ({ request }) => {
	let firstname = "",
		lastname = "",
		email = "",
		phone = "",
		message = "";
	try {
		const ct = request.headers.get("content-type") ?? "";
		if (ct.includes("application/json")) {
			const raw: unknown = await request.json();
			const b: Record<string, unknown> = isRecord(raw) ? raw : {};
			firstname = strVal(b.firstname).trim();
			lastname = strVal(b.name).trim();
			email = strVal(b.email).trim();
			phone = strVal(b.phone).trim();
			message = strVal(b.message).trim();
		} else {
			const f = await request.formData();
			firstname = strVal(f.get("firstname")).trim();
			lastname = strVal(f.get("name")).trim();
			email = strVal(f.get("email")).trim();
			phone = strVal(f.get("phone")).trim();
			message = strVal(f.get("message")).trim();
		}
	} catch {
		return Response.json({ error: "Requête invalide" }, { status: 400 });
	}

	const name = [firstname, lastname].filter(Boolean).join(" ");

	if (!name) return Response.json({ error: "Le nom est requis" }, { status: 400 });
	if (!email || !email.includes("@"))
		return Response.json({ error: "Email invalide" }, { status: 400 });
	if (!message) return Response.json({ error: "Le message est requis" }, { status: 400 });
	if (name.length > MAX_LEN.name) return Response.json({ error: "Nom trop long" }, { status: 400 });
	if (email.length > MAX_LEN.email)
		return Response.json({ error: "Email trop long" }, { status: 400 });
	if (phone.length > MAX_LEN.phone)
		return Response.json({ error: "Téléphone trop long" }, { status: 400 });
	if (message.length > MAX_LEN.message)
		return Response.json({ error: "Message trop long" }, { status: 400 });

	const slug = `contact-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

	try {
		const db = await getDb();
		const result = await handleContentCreate(db, "messages", {
			slug,
			status: "published",
			data: { name, email, phone: phone || undefined, message },
		});

		if (!result.success) {
			const code = result.error.code;
			if (code === "COLLECTION_NOT_FOUND" || code === "UNKNOWN_COLLECTION") {
				return Response.json(
					{ error: "La boîte de réception n'est pas encore configurée." },
					{ status: 503 },
				);
			}
			return Response.json(
				{ error: "Erreur lors de l'envoi. Veuillez réessayer." },
				{ status: 500 },
			);
		}
	} catch {
		return Response.json({ error: "Erreur lors de l'envoi. Veuillez réessayer." }, { status: 500 });
	}

	return Response.json({ success: true });
};
