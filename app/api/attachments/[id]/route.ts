import { attachmentBytes, attachmentFor, stagedAttachmentBytes, stagedAttachmentFor } from "@/src/server";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const query = new URL(req.url).searchParams;
	const chatId = query.get("chatId") ?? undefined;
	if (query.has("meta")) {
		const meta = stagedAttachmentFor(id) ?? (chatId ? attachmentFor(id, chatId) : null);
		return meta ? Response.json(meta, { headers: { "Cache-Control": "private, no-store" } }) : new Response(null, { status: 404 });
	}
	const file = stagedAttachmentBytes(id, query.has("preview")) ?? (chatId ? attachmentBytes(id, chatId, query.has("preview")) : null);
	if (!file) return new Response(null, { status: 404 });
	return new Response(new Uint8Array(file.bytes), { headers: { "Content-Type": file.mimeType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}
