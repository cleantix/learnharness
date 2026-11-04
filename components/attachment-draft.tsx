"use client";
/* Local object URLs and session-protected previews cannot use the Next image optimizer. */
/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useRef, useState } from "react";
import { FileTextIcon, XIcon } from "lucide-react";
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_TOTAL_BYTES, type Attachment } from "@/src/core";

export const ATTACH_FILES_EVENT = "lh:attach-files";
type Item = { key: string; file: File; url?: string; attachment?: Attachment; error?: string; uploading: boolean };

export function useAttachmentDraft() {
	const [items, setItems] = useState<Item[]>([]);
	const [notice, setNotice] = useState("");
	const [restoring, setRestoring] = useState(false);
	const restoreCount = useRef(0);
	const itemsRef = useRef<Item[]>([]);
	const update = useCallback((fn: (current: Item[]) => Item[]) => {
		itemsRef.current = fn(itemsRef.current); setItems(itemsRef.current);
	}, []);
	const upload = useCallback(async (item: Item) => {
		update((current) => current.map((x) => x.key === item.key ? { ...x, uploading: true, error: undefined } : x));
		try {
			const res = await fetch("/api/attachments", { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Attachment-Name": encodeURIComponent(item.file.name || "screenshot.png") }, body: item.file });
			const data = await res.json() as Attachment & { error?: string };
			if (!res.ok) throw new Error(data.error || "Upload failed.");
			update((current) => current.map((x) => x.key === item.key ? { ...x, attachment: data, uploading: false } : x));
		} catch (error) {
			update((current) => current.map((x) => x.key === item.key ? { ...x, uploading: false, error: error instanceof Error ? error.message : "Upload failed." } : x));
		}
	}, [update]);
	const addFiles = useCallback((files: Iterable<File>) => {
		for (const file of files) {
			const current = itemsRef.current;
			const tooMany = current.length >= MAX_ATTACHMENTS;
			const tooLarge = file.size > MAX_ATTACHMENT_BYTES || current.reduce((sum, x) => sum + (x.attachment?.size ?? x.file.size), 0) + file.size > MAX_ATTACHMENT_TOTAL_BYTES;
			if (tooMany || tooLarge) {
				setNotice(tooMany ? "Maximum 10 files per message." : "File or message size limit exceeded.");
				continue;
			}
			const item: Item = { key: crypto.randomUUID(), file, uploading: true, ...(file.type.startsWith("image/") ? { url: URL.createObjectURL(file) } : {}) };
			update((items) => [...items, item]);
			void upload(item);
		}
	}, [update, upload]);
	useEffect(() => {
		const receive = (event: Event) => {
			if (!document.querySelector('[data-testid="composer"], [data-testid="home-attachment-composer"]')) return;
			addFiles((event as CustomEvent<File[]>).detail);
		};
		window.addEventListener(ATTACH_FILES_EVENT, receive);
		return () => window.removeEventListener(ATTACH_FILES_EVENT, receive);
	}, [addFiles]);
	useEffect(() => () => { for (const item of itemsRef.current) if (item.url) URL.revokeObjectURL(item.url); }, []);
	const remove = useCallback((key: string) => update((current) => {
		const removed = current.find((x) => x.key === key);
		if (removed?.url) URL.revokeObjectURL(removed.url);
		return current.filter((x) => x.key !== key);
	}), [update]);
	const clear = useCallback(() => { setNotice(""); update((current) => { for (const item of current) if (item.url) URL.revokeObjectURL(item.url); return []; }); }, [update]);
	const removeSent = useCallback((ids: string[]) => update((current) => current.filter((item) => {
		if (!item.attachment || !ids.includes(item.attachment.id)) return true;
		if (item.url) URL.revokeObjectURL(item.url);
		return false;
	})), [update]);
	const restore = useCallback(async (ids: string[], chatId: string) => {
		restoreCount.current++;
		setRestoring(true);
		try {
		for (const id of ids) {
			if (itemsRef.current.some((x) => x.attachment?.id === id)) continue;
			try {
				const response = await fetch(`/api/attachments/${encodeURIComponent(id)}?meta=1&chatId=${encodeURIComponent(chatId)}`);
				if (!response.ok) { setNotice("A saved attachment could not be restored. Remove this notice to send without it."); continue; }
				const attachment = await response.json() as Attachment;
				const file = new File([], attachment.name, { type: attachment.mimeType });
				update((current) => current.some((x) => x.attachment?.id === id) ? current : [...current, { key: id, file, attachment, uploading: false, ...(attachment.kind === "image" ? { url: `/api/attachments/${encodeURIComponent(id)}?preview=1&chatId=${encodeURIComponent(chatId)}` } : {}) }]);
			} catch { setNotice("A saved attachment could not be restored. Remove this notice to send without it."); }
		}
		} finally { if (--restoreCount.current === 0) setRestoring(false); }
	}, [update]);
	return { items, notice, dismissNotice: () => setNotice(""), addFiles, remove, clear, removeSent, retry: upload, restore, ready: items.length > 0 && items.every((x) => !!x.attachment && !x.uploading && !x.error), pending: restoring || !!notice || items.some((x) => x.uploading || !!x.error), ids: items.flatMap((x) => x.attachment ? [x.attachment.id] : []) };
}
export type AttachmentDraft = ReturnType<typeof useAttachmentDraft>;

export function AttachmentDraftView({ draft }: { draft: AttachmentDraft }) {
	if (!draft.items.length && !draft.notice && !draft.pending) return null;
	return <div className="flex flex-wrap gap-2 px-3 pt-3" data-testid="attachment-draft">
		{draft.notice && <div role="alert" className="flex items-center gap-2 text-xs text-destructive">{draft.notice}<button type="button" aria-label="Dismiss attachment error" onClick={draft.dismissNotice}><XIcon className="size-4" /></button></div>}
		{draft.pending && !draft.items.length && !draft.notice && <span className="text-xs text-muted-foreground">Restoring attachments…</span>}
		{draft.items.map((item) => <div key={item.key} className="relative flex max-w-48 items-center gap-2 rounded-lg border bg-background p-2 text-xs">
			{item.url ? <img src={item.url} alt="" className="size-12 rounded object-cover" /> : <FileTextIcon className="size-6 shrink-0" />}
			<div className="min-w-0"><div className="truncate" title={item.file.name}>{item.file.name || "screenshot.png"}</div>
				<div className="text-muted-foreground">{item.uploading ? "Uploading…" : item.error ? <button type="button" className="text-destructive underline" onClick={() => void draft.retry(item)}>{item.error} Retry</button> : `${((item.attachment?.size ?? item.file.size) / 1024).toFixed(1)} KB`}</div>
			</div>
			<button type="button" aria-label={`Remove ${item.file.name || "screenshot"}`} onClick={() => draft.remove(item.key)}><XIcon className="size-4" /></button>
		</div>)}
	</div>;
}
