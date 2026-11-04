/** Public metadata only. Attachment bytes live in the server's data directory. */
export interface Attachment {
	id: string;
	name: string;
	mimeType: string;
	size: number;
	kind: "image" | "pdf" | "text" | "notebook";
}

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENT_TOTAL_BYTES = 100 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
