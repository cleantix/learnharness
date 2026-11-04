import { attachmentBytes, getChat } from "@/src/server";

export async function GET(req: Request, { params }: { params: Promise<{ id: string; attachmentId: string }> }) {
	const { id, attachmentId } = await params;
	if (!getChat(id)) return new Response(null, { status: 404 });
	const preview = new URL(req.url).searchParams.has("preview");
	const file = attachmentBytes(attachmentId, id, preview);
	if (!file) return new Response(null, { status: 404 });
	return new Response(new Uint8Array(file.bytes), { headers: {
		"Content-Type": file.mimeType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
		...(preview ? {} : { "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}` }),
	} });
}
