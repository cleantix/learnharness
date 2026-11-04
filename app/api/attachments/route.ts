import { MAX_ATTACHMENT_BYTES } from "@/src/core";
import { stageAttachment } from "@/src/server";

export async function POST(req: Request) {
	if (Number(req.headers.get("content-length")) > MAX_ATTACHMENT_BYTES) return Response.json({ error: "File exceeds 25 MiB." }, { status: 413 });
	const reader = req.body?.getReader();
	if (!reader) return Response.json({ error: "Missing file." }, { status: 400 });
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_ATTACHMENT_BYTES) return Response.json({ error: "File exceeds 25 MiB." }, { status: 413 });
			chunks.push(value);
		}
		const name = decodeURIComponent(req.headers.get("x-attachment-name") ?? "attachment");
		const bytes = Buffer.concat(chunks);
		return Response.json(await stageAttachment(name, bytes));
	} catch (error) {
		return Response.json({ error: error instanceof Error ? error.message : "Could not upload file." }, { status: 400 });
	} finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
