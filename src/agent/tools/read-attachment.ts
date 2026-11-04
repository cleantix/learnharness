import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Attachment } from "../../core/attachments.ts";
import { processImage, detectSupportedImageMimeType, type ProcessImageOptions } from "../image-processing/index.ts";
import { checkImageDimensions, MAX_LEARNER_IMAGE_BYTES } from "./learner-image-dimensions.ts";
import { pdfExtract } from "../subagents/pdf-ops.ts";
import { getHeadless } from "../subagents/headless.ts";

const schema = Type.Object({
	id: Type.String({ description: "Attachment ID from the chat's attachment list." }),
	start: Type.Optional(Type.Integer({ minimum: 1, description: "First line, notebook cell, or PDF page (1-based)." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Number of lines, cells, or PDF pages." })),
	offset: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset within the selected text lines." })),
	visual: Type.Optional(Type.Boolean({ description: "Render the selected PDF pages as images." })),
});
type Lookup = (id: string) => { attachment: Attachment; bytes: Buffer; path: string } | null;

export function createAttachmentTool(lookup: Lookup, options?: { supportsImages: boolean; resizeOptions?: ProcessImageOptions["resizeOptions"] }): AgentTool<typeof schema> {
	return {
		name: "read_attachment", label: "Read attachment",
		description: "Read an attachment belonging to this chat. Use start and limit for lines, notebook cells, or PDF pages. Set visual to render PDF pages. Notebook output includes saved text, errors, and supported images; code is never executed.",
		parameters: schema,
		execute: async (_id, input) => {
			try {
				const found = lookup(input.id);
				if (!found) throw new Error("Attachment not found in this chat.");
				const { attachment, bytes, path } = found;
				const start = input.start ?? 1;
				const limit = input.limit ?? (attachment.kind === "text" ? 200 : 5);
				const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
				if (attachment.kind === "image") {
					if (options?.supportsImages === false) throw new Error("The selected model does not support images.");
					const result = await processImage(bytes, attachment.mimeType, { resizeOptions: options?.resizeOptions });
					if (!result.ok) throw new Error(result.message);
					content.push({ type: "text", text: attachment.name }, { type: "image", data: result.data, mimeType: result.mimeType });
				} else if (attachment.kind === "pdf") {
					const end = start + Math.min(limit, input.visual ? 6 : 100) - 1;
					if (input.visual) {
						if (options?.supportsImages === false) throw new Error("The selected model does not support images.");
						const pages = await getHeadless().renderPdfPages(path, Array.from({ length: end - start + 1 }, (_, i) => start + i), { dpi: 150 });
						for (const page of pages) {
							const image = await processImage(page.png, "image/png", { resizeOptions: options?.resizeOptions });
							if (image.ok) content.push({ type: "text", text: `Page ${page.page}` }, { type: "image", data: image.data, mimeType: image.mimeType });
							else content.push({ type: "text", text: `Page ${page.page} could not be rendered: ${image.message}` });
						}
					} else {
						const extracted = await pdfExtract(path, `${start}-${end}`);
						const offset = input.offset ?? 0;
						const fragment = extracted.slice(offset, offset + 50_000);
						const next = offset + fragment.length < extracted.length ? `Continue with start=${start}, limit=${limit}, offset=${offset + fragment.length}.` : `Continue with start=${end + 1}.`;
						content.push({ type: "text", text: `${fragment}\n${next}` });
					}
				} else if (attachment.kind === "text") {
					const lines = bytes.toString("utf8").split("\n");
					if (start > lines.length) return { content: [{ type: "text", text: `End of file (${lines.length} lines).` }], details: undefined };
					const selected = lines.slice(start - 1, start - 1 + limit).join("\n");
					const offset = input.offset ?? 0;
					const slice = selected.slice(offset, offset + 50_000);
					const next = offset + slice.length < selected.length ? `Continue with start=${start}, limit=${limit}, offset=${offset + slice.length}.` : `Continue with start=${start + Math.min(limit, Math.max(0, lines.length - start + 1))}.`;
					content.push({ type: "text", text: `Lines starting at ${start} of ${lines.length}:\n${slice}\n${next}` });
				} else {
					const notebook = JSON.parse(bytes.toString("utf8")) as { cells: Array<Record<string, unknown>> };
					if (start > notebook.cells.length) return { content: [{ type: "text", text: `End of notebook (${notebook.cells.length} cells).` }], details: undefined };
					for (const [index, cell] of notebook.cells.slice(start - 1, start - 1 + limit).entries()) {
						const source = Array.isArray(cell.source) ? cell.source.join("") : String(cell.source ?? "");
						const outputs = Array.isArray(cell.outputs) ? cell.outputs as Array<Record<string, unknown>> : [];
						const texts = outputs.map((output) => {
							const data = output.data && typeof output.data === "object" ? output.data as Record<string, unknown> : {};
							const text = output.text ?? output.traceback ?? data["text/plain"] ?? data["text/markdown"] ?? data["text/html"];
							return text ? `\nOutput: ${Array.isArray(text) ? text.join("") : String(text)}` : "";
						});
						const whole = `Cell ${start + index} (${String(cell.cell_type)}):\n${source}${texts.join("")}`;
						const offset = index === 0 ? input.offset ?? 0 : 0;
						const fragment = whole.slice(offset, offset + 50_000);
						content.push({ type: "text", text: fragment + (offset + fragment.length < whole.length ? `\nCell text truncated. Continue with start=${start + index}, limit=1, offset=${offset + fragment.length}.` : "") });
						for (const output of outputs) {
							const data = output.data && typeof output.data === "object" ? output.data as Record<string, unknown> : {};
							if (offset > 0) continue;
							for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]) {
								const encoded = data[type];
								const raw = Array.isArray(encoded) ? encoded.join("") : encoded;
								if (typeof raw !== "string") continue;
								if (raw.length > MAX_LEARNER_IMAGE_BYTES * 1.4) { content.push({ type: "text", text: "Saved notebook image exceeds 25 MiB and was omitted." }); continue; }
								if (options?.supportsImages === false) { content.push({ type: "text", text: "Saved image omitted: the selected model does not support images." }); continue; }
								const imageBytes = Buffer.from(raw, "base64");
								const detected = detectSupportedImageMimeType(imageBytes);
								if (!detected) { content.push({ type: "text", text: "Saved notebook image is invalid and was omitted." }); continue; }
								checkImageDimensions(imageBytes, detected);
								const image = await processImage(imageBytes, detected, { resizeOptions: options?.resizeOptions });
								if (image.ok) content.push({ type: "image", data: image.data, mimeType: image.mimeType });
								else content.push({ type: "text", text: `Saved notebook image could not be processed: ${image.message}` });
							}
							if (data["image/svg+xml"] && !["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"].some((type) => data[type])) content.push({ type: "text", text: "Saved SVG image omitted: this image format is not supported." });
						}
					}
					content.push({ type: "text", text: `Notebook has ${notebook.cells.length} cells. Continue with start=${start + limit}.` });
				}
				return { content, details: undefined };
			} catch (error) { return { content: [{ type: "text", text: error instanceof Error ? error.message : "Could not read attachment." }], details: undefined, isError: true }; }
		},
	};
}
