import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-attachments-"));
process.env.LH_DATA_DIR = path.join(scratch, "data");
process.env.LH_AUTH_FILE = path.join(scratch, "auth.json");
process.env.OPENROUTER_API_KEY = "synthetic-test-key";
process.env.OPENAI_API_KEY = "synthetic-test-key";
const store = await import("../src/server/attachments.ts");
const { createAttachmentTool } = await import("../src/agent/tools/read-attachment.ts");
const { parseChatInput } = await import("../src/core/input-events.ts");
const { newUserMessage, toLlmMessages } = await import("../src/core/native-messages.ts");
const { newCompactionMarker } = await import("../src/core/compaction.ts");
const { attachmentContext } = await import("../src/server/attachment-context.ts");
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function reader(chatId: string) {
	return createAttachmentTool((id) => {
		const attachment = store.attachmentFor(id, chatId);
		const file = store.attachmentBytes(id, chatId);
		const filePath = store.attachmentPath(id, chatId);
		return attachment && file && filePath ? { attachment, bytes: file.bytes, path: filePath } : null;
	});
}

test("staged copies are scoped to their chat, survive deletion of the original, and are removed with the chat", async () => {
	const original = path.join(scratch, "source.txt");
	fs.writeFileSync(original, "first\nsecond\nthird");
	const attachment = await store.stageAttachment("../source.txt", fs.readFileSync(original));
	assert.equal(attachment.name, "source.txt");
	assert.equal(attachment.kind, "text");
	store.claimAttachments([attachment.id], "chat_one");
	fs.unlinkSync(original);
	assert.equal(store.attachmentBytes(attachment.id, "chat_one")?.bytes.toString(), "first\nsecond\nthird");
	assert.equal(store.attachmentBytes(attachment.id, "chat_two"), null);
	assert.throws(() => store.claimAttachments([attachment.id], "chat_two"));
	assert.equal((await reader("chat_two").execute("x", { id: attachment.id })).isError, true);
	const result = await reader("chat_one").execute("x", { id: attachment.id, start: 2, limit: 1 });
	assert.match(JSON.stringify(result.content), /second/);
	assert.doesNotMatch(JSON.stringify(result.content), /first/);
	store.deleteChatAttachments("chat_one");
	assert.equal(store.attachmentBytes(attachment.id, "chat_one"), null);
});

test("deleting a chat removes only its own saved files", async () => {
	const { chatStore } = await import("../src/store/chats.ts");
	const { deleteChatSession } = await import("../src/server/chats.ts");
	const first = chatStore.createChat("delete attachments");
	const second = chatStore.createChat("keep attachments");
	const removed = await store.stageAttachment("removed.txt", Buffer.from("one"));
	const kept = await store.stageAttachment("kept.txt", Buffer.from("two"));
	store.claimAttachments([removed.id], first.id);
	store.claimAttachments([kept.id], second.id);
	assert.equal((await deleteChatSession(first.id, "preserve-graph")).ok, true);
	assert.equal(store.attachmentFor(removed.id, first.id), null);
	assert.ok(store.attachmentFor(kept.id, second.id));
});

test("images preserve their original bytes and have a separately processed preview", async () => {
	const canvas = createCanvas(24, 16);
	canvas.getContext("2d").fillRect(0, 0, 24, 16);
	const png = canvas.toBuffer("image/png");
	const attachment = await store.stageAttachment("screen.png", png);
	assert.equal(attachment.kind, "image");
	assert.deepEqual(store.stagedAttachmentBytes(attachment.id)?.bytes, png);
	assert.ok(store.stagedAttachmentBytes(attachment.id, true)?.bytes.length);
	store.claimAttachments([attachment.id], "chat_images");
	const result = await reader("chat_images").execute("x", { id: attachment.id });
	assert.ok(result.content.some((part) => part.type === "image"));
});

test("PDF content and rendered pages are read from the chat-owned copy", async () => {
	const pdf = fs.readFileSync(new URL("./fixtures/sample-3page.pdf", import.meta.url));
	const file = await store.stageAttachment("sample.pdf", pdf);
	assert.equal(file.kind, "pdf");
	store.claimAttachments([file.id], "chat_pdf");
	const text = await reader("chat_pdf").execute("x", { id: file.id, start: 1, limit: 1 });
	assert.equal(text.isError, undefined);
	assert.match(JSON.stringify(text.content), /Page 1/);
	const visual = await reader("chat_pdf").execute("x", { id: file.id, start: 1, limit: 1, visual: true });
	assert.ok(visual.content.some((part) => part.type === "image"));
	await assert.rejects(store.stageAttachment("broken.pdf", Buffer.from("%PDF-not a document")), /Could not open/);
});

test("upload and download routes enforce limits and chat ownership", async () => {
	const upload = await import("../app/api/attachments/route.ts");
	const staged = await import("../app/api/attachments/[id]/route.ts");
	const saved = await import("../app/api/chats/[id]/attachments/[attachmentId]/route.ts");
	const { chatStore } = await import("../src/store/chats.ts");
	const tooLarge = await upload.POST(new Request("http://test/api/attachments", { method: "POST", headers: { "content-length": String(26 * 1024 * 1024) }, body: "x" }));
	assert.equal(tooLarge.status, 413);
	const uploaded = await upload.POST(new Request("http://test/api/attachments", { method: "POST", headers: { "x-attachment-name": "note.txt" }, body: "synthetic route file" }));
	assert.equal(uploaded.status, 200);
	const file = await uploaded.json() as { id: string };
	const chat = chatStore.createChat("Route scope");
	const other = chatStore.createChat("Other scope");
	store.claimAttachments([file.id], chat.id);
	assert.equal((await staged.GET(new Request("http://test"), { params: Promise.resolve({ id: file.id }) })).status, 404);
	assert.equal((await saved.GET(new Request("http://test"), { params: Promise.resolve({ id: other.id, attachmentId: file.id }) })).status, 404);
	const response = await saved.GET(new Request("http://test"), { params: Promise.resolve({ id: chat.id, attachmentId: file.id }) });
	assert.equal(await response.text(), "synthetic route file");
	assert.match(response.headers.get("content-disposition") ?? "", /attachment/);
});

test("notebooks expose saved cells, errors and image outputs without executing code", async () => {
	const canvas = createCanvas(4, 4);
	const png = canvas.toBuffer("image/png").toString("base64");
	const notebook = { nbformat: 4, nbformat_minor: 5, cells: [
		{ cell_type: "markdown", source: ["# Heading"], metadata: {} },
		{ cell_type: "code", source: ["raise RuntimeError('never executed')"], metadata: {}, execution_count: 1, outputs: [
			{ output_type: "error", traceback: ["saved error"] },
			{ output_type: "display_data", data: { "image/png": png, "text/plain": "saved plot" }, metadata: {} },
		] },
	] };
	const file = await store.stageAttachment("lesson.ipynb", Buffer.from(JSON.stringify(notebook)));
	store.claimAttachments([file.id], "chat_notebook");
	const result = await reader("chat_notebook").execute("x", { id: file.id, start: 2, limit: 1 });
	assert.match(JSON.stringify(result.content), /saved error/);
	assert.match(JSON.stringify(result.content), /saved plot/);
	assert.ok(result.content.some((part) => part.type === "image"));
	await assert.rejects(store.stageAttachment("old.ipynb", Buffer.from('{"nbformat":3,"cells":[]}')), /format 4/);
});

test("long text reports a usable continuation, and message metadata never goes directly to the provider", async () => {
	const file = await store.stageAttachment("long.txt", Buffer.from("a".repeat(60_000)));
	store.claimAttachments([file.id], "chat_long");
	const first = await reader("chat_long").execute("x", { id: file.id, start: 1, limit: 1 });
	assert.match(JSON.stringify(first.content), /offset=50000/);
	const second = await reader("chat_long").execute("x", { id: file.id, start: 1, limit: 1, offset: 50_000 });
	assert.match(JSON.stringify(second.content), /a{100}/);
	assert.deepEqual(parseChatInput({ type: "text", text: "", attachmentIds: [file.id] }), { type: "text", text: "", attachmentIds: [file.id] });
	const message = { ...newUserMessage("question"), attachments: [file] };
	assert.ok(!JSON.stringify(toLlmMessages([message])).includes("attachments"));
});

test("unclaimed uploads expire after 24 hours while claimed chat attachments survive", async () => {
	const unclaimed = await store.stageAttachment("staged.txt", Buffer.from("staged"));
	const claimed = await store.stageAttachment("saved.txt", Buffer.from("saved"));
	store.claimAttachments([claimed.id], "chat_expiry");
	store.cleanStagedAttachments(Date.now() + 25 * 60 * 60 * 1000);
	assert.equal(store.stagedAttachmentFor(unclaimed.id), null);
	assert.ok(store.attachmentFor(claimed.id, "chat_expiry"));
});

test("images reach the model and the attachment catalog survives history compaction", async () => {
	const canvas = createCanvas(8, 8);
	const image = await store.stageAttachment("diagram.png", canvas.toBuffer("image/png"));
	store.claimAttachments([image.id], "chat_context");
	const first = { ...newUserMessage("Explain"), attachments: [image] };
	const kept = newUserMessage("Compare it again");
	const model = { input: ["text", "image"] as ("text" | "image")[] };
	const sent = await attachmentContext([first], "chat_context", model);
	assert.match(JSON.stringify(sent), /image\/png/);
	assert.match(JSON.stringify(sent), new RegExp(image.id));
	assert.ok(!JSON.stringify(sent).includes('"attachments"'));
	await assert.rejects(attachmentContext([first], "chat_context", { input: ["text"] }), /does not support images/);
	const cut = newCompactionMarker("Earlier lesson", { firstKeptMessageId: kept.id, tokensBefore: 100, at: "t" });
	const compacted = await attachmentContext([first, kept, cut], "chat_context", model);
	assert.match(JSON.stringify(compacted), new RegExp(image.id));
	assert.doesNotMatch(JSON.stringify(compacted), /image\/png/);
});

test("a first message with only an image is persisted and delivered to a scripted model", async () => {
	const { handleChatInput } = await import("../src/server/chat-handler.ts");
	const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
	const { chatStore } = await import("../src/store/chats.ts");
	const { isTurnRunning } = await import("../src/server/turn-liveness.ts");
	const chat = chatStore.createChat("Attachment integration");
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	const canvas = createCanvas(8, 8);
	const file = await store.stageAttachment("first.png", canvas.toBuffer("image/png"));
	const faux = createFauxCore({});
	let received = "";
	faux.setResponses([(context) => { received = JSON.stringify(context.messages); return fauxAssistantMessage([fauxText("ok")]); }]);
	const response = await handleChatInput(chat.id, { type: "text", text: "", attachmentIds: [file.id] }, (opts) =>
		createTeacherAgent(undefined, { ...opts, engine: { model: { ...faux.getModel(), input: ["text", "image"] }, streamFn: faux.streamSimple } }));
	assert.equal(response.status, 200);
	await response.text();
	for (let i = 0; i < 100 && isTurnRunning(chat.id); i++) await new Promise((resolve) => setTimeout(resolve, 20));
	assert.match(received, /image\/png/);
	assert.match(received, new RegExp(file.id));
	assert.equal(chatStore.getChat(chat.id)?.messages.find((m) => m.role === "user")?.attachments?.[0]?.id, file.id);
});

test("a later turn can read a saved document after compaction", async () => {
	const { handleChatInput } = await import("../src/server/chat-handler.ts");
	const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
	const { chatStore } = await import("../src/store/chats.ts");
	const { isTurnRunning } = await import("../src/server/turn-liveness.ts");
	const chat = chatStore.createChat("Reuse integration");
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	const file = await store.stageAttachment("notes.txt", Buffer.from("Synthetic saved document content."));
	store.claimAttachments([file.id], chat.id);
	const first = { ...newUserMessage("Read this"), attachments: [file] };
	const kept = newUserMessage("Continue");
	const cut = newCompactionMarker("Earlier lesson", { firstKeptMessageId: kept.id, tokensBefore: 100, at: "t" });
	chatStore.saveMessages(chat.id, [first, kept, cut]);
	const faux = createFauxCore({});
	let result = "";
	faux.setResponses([
		() => fauxAssistantMessage([fauxToolCall("read_attachment", { id: file.id, start: 1, limit: 10 }, { id: "read-file" })], { stopReason: "toolUse" }),
		(context) => { result = JSON.stringify(context.messages); return fauxAssistantMessage([fauxText("read")]); },
	]);
	const response = await handleChatInput(chat.id, { type: "text", text: "Read the document again" }, (opts) =>
		createTeacherAgent(undefined, { ...opts, engine: { model: { ...faux.getModel(), input: ["text", "image"] }, streamFn: faux.streamSimple } }));
	assert.equal(response.status, 200);
	await response.text();
	for (let i = 0; i < 100 && isTurnRunning(chat.id); i++) await new Promise((resolve) => setTimeout(resolve, 20));
	assert.match(result, /Synthetic saved document content/);
});

test("a model without vision rejects the image while keeping the upload available for retry", async () => {
	const { handleChatInput } = await import("../src/server/chat-handler.ts");
	const { chatStore } = await import("../src/store/chats.ts");
	const chat = chatStore.createChat("No vision");
	chatStore.saveSettings(chat.id, { model: { provider: "openai", id: "gpt-4" } });
	const canvas = createCanvas(8, 8);
	const file = await store.stageAttachment("image.png", canvas.toBuffer("image/png"));
	const response = await handleChatInput(chat.id, { type: "text", text: "look", attachmentIds: [file.id] });
	assert.equal(response.status, 400);
	assert.match(await response.text(), /does not support images/);
	assert.ok(store.stagedAttachmentFor(file.id));
	assert.equal(chatStore.getChat(chat.id)?.messages.length, 0);
});

test("a queued message carries its attachment, and a settled-turn race releases the staged copy", async () => {
	const { POST } = await import("../app/api/chats/[id]/steer/route.ts");
	const { chatStore } = await import("../src/store/chats.ts");
	const { registerLiveAgent, unregisterLiveAgent, discardChatDeliveries } = await import("../src/server/jobs.ts");
	const chat = chatStore.createChat("Steer attachments");
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	const first = await store.stageAttachment("queued.txt", Buffer.from("queued content"));
	const second = await store.stageAttachment("raced.txt", Buffer.from("raced content"));
	const delivered: Array<{ attachments?: Array<{ id: string }> }> = [];
	const agent = { steer: (message: { attachments?: Array<{ id: string }> }) => delivered.push(message), state: { model: { provider: "openrouter" } } } as unknown as Parameters<typeof registerLiveAgent>[1];
	const request = (id: string) => new Request("http://test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: { type: "steer", id: `steer_${id}`, text: "", attachmentIds: [id] } }) });
	registerLiveAgent(chat.id, agent);
	try {
		assert.equal((await POST(request(first.id), { params: Promise.resolve({ id: chat.id }) })).status, 200);
		assert.equal(delivered[0]?.attachments?.[0]?.id, first.id);
		assert.ok(store.attachmentFor(first.id, chat.id));
	} finally { unregisterLiveAgent(chat.id); discardChatDeliveries(chat.id); }
	assert.equal((await POST(request(second.id), { params: Promise.resolve({ id: chat.id }) })).status, 409);
	assert.ok(store.stagedAttachmentFor(second.id));
});
