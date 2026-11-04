import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { processImage } from "../agent/image-processing/index.ts";
import { activeCompactionOf, keptIndexFor } from "../core/compaction.ts";
import { toLlmMessages, type LhMessage } from "../core/native-messages.ts";
import type { Attachment } from "../core/attachments.ts";
import { attachmentBytes } from "./attachments.ts";

/** Hydrate only the retained history; the complete chat's catalog remains
 * available even when its originating message was compacted. */
export async function attachmentContext(messages: AgentMessage[], chatId: string, model: Pick<Model<Api>, "input" | "inputLimits">) {
	const all = messages as LhMessage[];
	const inventory = new Map<string, Attachment>();
	for (const message of all) for (const item of message.attachments ?? []) inventory.set(item.id, item);
	const marker = activeCompactionOf(all);
	const cutoff = marker ? Math.max(0, keptIndexFor(all, marker)) : 0;
	const hydrated = await Promise.all(messages.map(async (message, index) => {
		const entry = message as LhMessage;
		if (index < cutoff || entry.role !== "user" || !entry.attachments?.length) return message;
		const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = typeof entry.content === "string" ? [{ type: "text", text: entry.content }] : [...entry.content];
		for (const item of entry.attachments) {
			content.push({ type: "text", text: `Attachment: ${item.name} (id: ${item.id}, ${item.kind}).` });
			if (item.kind !== "image") continue;
			if (!model.input.includes("image")) throw new Error("The selected model does not support images. Choose a vision model.");
			const file = attachmentBytes(item.id, chatId);
			if (!file) throw new Error(`Attachment unavailable: ${item.name}`);
			const result = await processImage(file.bytes, item.mimeType, { resizeOptions: model.inputLimits?.images?.resize });
			if (!result.ok) throw new Error(result.message);
			content.push({ type: "image", data: result.data, mimeType: result.mimeType });
		}
		return { ...entry, content } as AgentMessage;
	}));
	const result = toLlmMessages(hydrated);
	if (inventory.size) {
		const catalog = `Attachments available via read_attachment:\n${[...inventory.values()].map((a) => `${a.name} (${a.kind}, id: ${a.id})`).join("\n")}`;
		const user = result.find((m) => m.role === "user");
		if (user?.role === "user") user.content = typeof user.content === "string" ? `${catalog}\n\n${user.content}` : [{ type: "text", text: catalog }, ...user.content];
	}
	return result;
}
