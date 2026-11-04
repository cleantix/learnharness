import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PATHS } from "../../config.ts";
import { detectSupportedImageMimeType, processImage } from "../agent/image-processing/index.ts";
import { checkImageDimensions } from "../agent/tools/learner-image-dimensions.ts";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_TOTAL_BYTES, MAX_ATTACHMENTS, type Attachment } from "../core/attachments.ts";
import { writeFileAtomicSync } from "../store/atomic-write.ts";

type StoredAttachment = Attachment & { chatId: string | null; createdAt: number; previewMimeType?: string };
const root = () => path.join(PATHS.data, "attachments");
const validId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
function directory(id: string) {
	if (!validId(id)) throw new Error("Invalid attachment ID");
	return path.join(root(), id);
}
function readMeta(id: string): StoredAttachment | null {
	try { return JSON.parse(fs.readFileSync(path.join(directory(id), "metadata.json"), "utf8")) as StoredAttachment; }
	catch { return null; }
}
function publicMeta(meta: StoredAttachment): Attachment {
	return { id: meta.id, name: meta.name, mimeType: meta.mimeType, size: meta.size, kind: meta.kind };
}
export function cleanStagedAttachments(now = Date.now()) {
	let ids: string[];
	try { ids = fs.readdirSync(root()); } catch { return; }
	for (const id of ids) {
		if (!validId(id)) continue;
		const meta = readMeta(id);
		if (meta && meta.chatId === null && now - meta.createdAt > 24 * 60 * 60 * 1000) {
			fs.rmSync(directory(id), { recursive: true, force: true });
		}
	}
}

if (process.env.NODE_ENV !== "test") {
	cleanStagedAttachments();
	setInterval(() => cleanStagedAttachments(), 60 * 60 * 1000).unref();
}

export async function stageAttachment(name: string, bytes: Uint8Array): Promise<Attachment> {
	if (!bytes.length || bytes.length > MAX_ATTACHMENT_BYTES) throw new Error("File must be between 1 byte and 25 MiB.");
	const safeName = name.split(/[\\/]/).pop()?.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 255) || "attachment";
	const detected = detectSupportedImageMimeType(bytes);
	let kind: Attachment["kind"], mimeType: string, preview: Uint8Array | undefined, previewMimeType: string | undefined;
	if (detected) {
		checkImageDimensions(bytes, detected);
		const result = await processImage(bytes, detected);
		if (!result.ok) throw new Error("Could not process this image.");
		kind = "image"; mimeType = detected; preview = Buffer.from(result.data, "base64"); previewMimeType = result.mimeType;
	} else if (Buffer.from(bytes.subarray(0, 5)).toString("ascii") === "%PDF-") {
		const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
		const task = pdfjs.getDocument({ data: Uint8Array.from(bytes), verbosity: 0 });
		try { await task.promise; } catch { throw new Error("Could not open this PDF."); } finally { await task.destroy(); }
		kind = "pdf"; mimeType = "application/pdf";
	} else {
		if (/\.pdf$/i.test(safeName)) throw new Error("Could not open this PDF.");
		if (/\.(?:png|jpe?g|gif|webp|bmp)$/i.test(safeName)) throw new Error("Could not open this image.");
		let text: string;
		try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
		catch { throw new Error("Unsupported file type."); }
		if (text.includes("\0")) throw new Error("Unsupported file type.");
		if (/\.ipynb$/i.test(safeName)) {
			let notebook: unknown;
			try { notebook = JSON.parse(text); } catch { throw new Error("Invalid notebook."); }
			if (!notebook || typeof notebook !== "object" || (notebook as { nbformat?: unknown }).nbformat !== 4 || !Array.isArray((notebook as { cells?: unknown }).cells)) throw new Error("Only Jupyter notebook format 4 is supported.");
			kind = "notebook"; mimeType = "application/x-ipynb+json";
		} else { kind = "text"; mimeType = "text/plain; charset=utf-8"; }
	}
	cleanStagedAttachments();
	const id = randomUUID();
	const meta: StoredAttachment = { id, name: safeName, mimeType, size: bytes.length, kind, chatId: null, createdAt: Date.now(), ...(previewMimeType ? { previewMimeType } : {}) };
	const dir = directory(id);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		fs.writeFileSync(path.join(dir, "original"), bytes, { mode: 0o600 });
		if (preview) fs.writeFileSync(path.join(dir, "preview"), preview, { mode: 0o600 });
		writeFileAtomicSync(path.join(dir, "metadata.json"), JSON.stringify(meta));
	} catch (error) { fs.rmSync(dir, { recursive: true, force: true }); throw error; }
	return publicMeta(meta);
}

export function attachmentFor(id: string, chatId?: string): Attachment | null {
	const meta = readMeta(id);
	if (!meta || (chatId !== undefined && meta.chatId !== chatId)) return null;
	return publicMeta(meta);
}
export function attachmentBytes(id: string, chatId?: string, preview = false): { bytes: Buffer; mimeType: string; name: string } | null {
	const meta = readMeta(id);
	if (!meta || (chatId !== undefined && meta.chatId !== chatId)) return null;
	try { return { bytes: fs.readFileSync(path.join(directory(id), preview ? "preview" : "original")), mimeType: preview ? meta.previewMimeType ?? meta.mimeType : meta.mimeType, name: meta.name }; }
	catch { return null; }
}
export function stagedAttachmentBytes(id: string, preview = false) {
	return readMeta(id)?.chatId === null ? attachmentBytes(id, undefined, preview) : null;
}
export function stagedAttachmentFor(id: string): Attachment | null {
	const meta = readMeta(id);
	return meta?.chatId === null ? publicMeta(meta) : null;
}
export function attachmentPath(id: string, chatId: string): string | null {
	return readMeta(id)?.chatId === chatId ? path.join(directory(id), "original") : null;
}
export function claimAttachments(ids: string[], chatId: string): Attachment[] {
	if (ids.length > MAX_ATTACHMENTS || new Set(ids).size !== ids.length) throw new Error("Maximum 10 distinct files per message.");
	const metas = ids.map((id) => readMeta(id));
	if (metas.some((m) => !m || (m.chatId !== null && m.chatId !== chatId))) throw new Error("Attachment is unavailable.");
	const valid = metas as StoredAttachment[];
	if (valid.reduce((sum, m) => sum + m.size, 0) > MAX_ATTACHMENT_TOTAL_BYTES) throw new Error("Attachments exceed 100 MiB.");
	const claimed: string[] = [];
	try {
		for (const meta of valid) if (meta.chatId === null) {
			writeFileAtomicSync(path.join(directory(meta.id), "metadata.json"), JSON.stringify({ ...meta, chatId }));
			claimed.push(meta.id);
		}
	} catch (error) { releaseAttachmentClaims(claimed, chatId); throw error; }
	return valid.map(publicMeta);
}
export function releaseAttachmentClaims(ids: string[], chatId: string) {
	for (const id of ids) {
		const meta = readMeta(id);
		if (meta?.chatId === chatId) writeFileAtomicSync(path.join(directory(id), "metadata.json"), JSON.stringify({ ...meta, chatId: null }));
	}
}
export function deleteChatAttachments(chatId: string) {
	let ids: string[];
	try { ids = fs.readdirSync(root()); } catch { return; }
	for (const id of ids) if (validId(id) && readMeta(id)?.chatId === chatId) fs.rmSync(directory(id), { recursive: true, force: true });
}
