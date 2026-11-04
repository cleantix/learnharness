"use client";
/* The image optimizer cannot access the desktop session's protected API. */
/* eslint-disable @next/next/no-img-element */
import { useEffect, useState } from "react";
import { FileTextIcon, XIcon } from "lucide-react";
import type { Attachment } from "@/src/core";

export function MessageAttachments({ chatId, attachments }: { chatId: string; attachments: Attachment[] }) {
	const [opened, setOpened] = useState<Attachment | null>(null);
	useEffect(() => {
		if (!opened) return;
		const close = (event: KeyboardEvent) => { if (event.key === "Escape") setOpened(null); };
		window.addEventListener("keydown", close);
		return () => window.removeEventListener("keydown", close);
	}, [opened]);
	return <><div className="flex flex-wrap gap-2 py-2">{attachments.map((file) => {
		const url = `/api/chats/${encodeURIComponent(chatId)}/attachments/${encodeURIComponent(file.id)}`;
		return <div key={file.id} className="flex max-w-56 items-center gap-2 rounded-lg border bg-background p-2">
			{file.kind === "image" ? <button type="button" onClick={() => setOpened(file)} aria-label={`Open ${file.name}`}><img src={`${url}?preview`} alt={file.name} className="max-h-32 max-w-36 rounded object-contain" /></button> : <FileTextIcon className="size-6" />}
			<span className="min-w-0"><a href={url} download={file.name} className="block truncate underline" title={`Download ${file.name}`}>{file.name}</a><span className="text-muted-foreground">{(file.size / 1024).toFixed(1)} KB</span></span>
		</div>;
	})}</div>{opened && <div role="dialog" aria-modal="true" aria-label={opened.name} className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-8" onClick={() => setOpened(null)}>
		<button type="button" className="absolute right-5 top-5 rounded bg-background p-2" aria-label="Close image" onClick={() => setOpened(null)}><XIcon className="size-5" /></button>
		<img src={`/api/chats/${encodeURIComponent(chatId)}/attachments/${encodeURIComponent(opened.id)}?preview`} alt={opened.name} className="max-h-full max-w-full object-contain" onClick={(event) => event.stopPropagation()} />
	</div>}</>;
}
