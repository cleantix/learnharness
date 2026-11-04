import React, { act } from "react";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { useAttachmentDraft, AttachmentDraftView, type AttachmentDraft } from "../components/attachment-draft.tsx";
import { SessionModel } from "../components/session-core.ts";

test("acknowledging one send retains files added while that send was in flight", async () => {
	const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({ React, window, document, Node: window.Node, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const oldFetch = globalThis.fetch;
	let next = 0;
	globalThis.fetch = async (_url, init) => {
		const file = init?.body as File;
		return Response.json({ id: `id-${++next}`, name: file.name, mimeType: "text/plain", size: file.size, kind: "text" });
	};
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	let draft!: AttachmentDraft;
	function Harness() { draft = useAttachmentDraft(); return <div data-testid="composer"><AttachmentDraftView draft={draft} /></div>; }
	try {
		await act(async () => { root.render(<Harness />); });
		await act(async () => { draft.addFiles([new File(["a"], "first.txt")]); });
		const sent = [...draft.ids];
		assert.equal(sent.length, 1);
		await act(async () => { draft.addFiles([new File(["b"], "second.txt")]); });
		await act(async () => { draft.removeSent(sent); });
		assert.deepEqual(draft.items.map((item) => item.file.name), ["second.txt"]);
		assert.equal(draft.ready, true);
	} finally {
		await act(async () => { root.unmount(); });
		globalThis.fetch = oldFetch;
		for (const [key, value] of previous) {
			if (value) Object.defineProperty(globalThis, key, value);
			else Reflect.deleteProperty(globalThis, key);
		}
	}
});

test("a refused attachment message shows a readable error and does not leave an unsaved bubble", async () => {
	const model = new SessionModel({ chatId: "c1", initialMessages: [], fetch: async () => Response.json({ error: "Choose a vision model." }, { status: 400 }) });
	const accepted = await model.send({ type: "text", text: "look", attachmentIds: ["11111111-1111-4111-8111-111111111111"] });
	assert.equal(accepted, false);
	assert.equal(model.getState().error?.message, "Choose a vision model.");
	assert.equal(model.getState().nativeMessages.length, 0);
});
