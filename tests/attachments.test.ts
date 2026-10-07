import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openDb, setDbForTests } from "@/lib/db";
import { ensureSeed } from "@/lib/seed";
import { createTask, getTask } from "@/lib/repo/tasks";
import { hireAgent } from "@/lib/team";
import { buildTools } from "@/lib/agents/tools";
import { runTask, type QueryFn } from "@/lib/agents/runner";
import { attachmentContent, resolveAttachments, saveAttachment, toRef } from "@/lib/files/attachments";
import { FileTree, fileAccessOf, hasSharedFolders, resolveForAgent } from "@/lib/files/repo";
import { ALLOWED_EXTENSIONS } from "@/lib/files/rules";
import { UPLOAD_EXTENSIONS } from "@/lib/files/accept";
import { answerDecision, createDecision, listDecisions } from "@/lib/decisions/repo";
import "@/lib/agents/modules";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj << >> endobj\n%%EOF");
const CSV = new TextEncoder().encode("a;b\n1;2\n");

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orden-adjuntos-"));
  process.env.ORDEN_FILES_DIR = tmp;
});
afterAll(() => {
  delete process.env.ORDEN_FILES_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  setDbForTests(openDb(":memory:"));
  ensureSeed();
});

describe("adjuntos del chat", () => {
  it("la web y el servidor admiten las mismas extensiones", () => {
    expect([...UPLOAD_EXTENSIONS].sort()).toEqual([...ALLOWED_EXTENSIONS].sort());
  });

  it("se guardan en «Adjuntos/<hoy>», una carpeta compartida que ven todos los agentes", () => {
    const marta = hireAgent({ name: "Marta", specialty: "Producto" });
    expect(fileAccessOf(marta)).not.toBe("todo");
    const node = saveAttachment("captura.png", PNG);
    const ref = toRef(node);
    expect(ref.path).toMatch(/^Adjuntos\/\d{4}-\d{2}-\d{2}\/captura\.png$/);
    expect(hasSharedFolders()).toBe(true);
    // Un agente sin acceso a todo lo encuentra igualmente.
    expect(resolveForAgent(new FileTree(), fileAccessOf(marta), ref.path)?.id).toBe(node.id);
    // Y tiene herramientas para leerlo.
    const task = createTask({ agentId: marta.id, kind: "chat", prompt: "x" });
    expect(buildTools({ agent: marta, task, signal: new AbortController().signal, note: () => {} }).map((t) => t.name)).toContain("archivo_leer");
  });

  it("valida lo que llega: que exista y no más de 10", () => {
    const ids = Array.from({ length: 11 }, (_, i) => saveAttachment(`c${i}.png`, PNG).id);
    expect(() => resolveAttachments(ids)).toThrow(/Como mucho 10/);
    expect(() => resolveAttachments(["no-existe"])).toThrow(/ya no existe/);
    expect(resolveAttachments([ids[0], ids[0]])).toHaveLength(1);
  });

  it("imágenes y PDF van dentro del mensaje; el resto, por referencia", () => {
    const refs = [saveAttachment("a.png", PNG), saveAttachment("b.pdf", PDF), saveAttachment("c.csv", CSV)].map(toRef);
    const { note, blocks } = attachmentContent(refs);
    expect(blocks.map((b) => b.type)).toEqual(["image", "document"]);
    expect(note).toContain("a.png");
    expect(note).toMatch(/c\.csv.*archivo_leer/);
  });

  it("el agente recibe el mensaje con la imagen dentro", async () => {
    const marta = hireAgent({ name: "Marta", specialty: "Producto" });
    const ref = toRef(saveAttachment("captura.png", PNG));
    const task = createTask({ agentId: marta.id, kind: "chat", prompt: "Mira esto", data: { attachments: [ref] } });
    let content: unknown[] = [];
    const q = ((args: { prompt: string | AsyncIterable<{ message: { content: unknown[] } }> }) => {
      return (async function* () {
        if (typeof args.prompt !== "string") for await (const m of args.prompt) content = m.message.content;
        yield { type: "result", subtype: "success", result: "Visto", usage: {}, total_cost_usd: 0, num_turns: 1, duration_ms: 1 };
      })();
    }) as unknown as QueryFn;
    await runTask(task, { queryFn: q });
    expect(getTask(task.id)?.status).toBe("done");
    expect(content.map((c) => (c as { type: string }).type)).toEqual(["text", "image"]);
    expect((content[0] as { text: string }).text).toContain("Mira esto");
  });

  it("archivo_leer devuelve la imagen para que el agente la vea", async () => {
    const marta = hireAgent({ name: "Marta", specialty: "Producto" });
    const ref = toRef(saveAttachment("captura.png", PNG));
    const task = createTask({ agentId: marta.id, kind: "chat", prompt: "x" });
    const read = buildTools({ agent: marta, task, signal: new AbortController().signal, note: () => {} }).find((t) => t.name === "archivo_leer")!;
    const out = (await read.handler({ archivo: ref.path }, {})) as { content: { type: string; mimeType?: string }[] };
    expect(out.content.map((c) => c.type)).toEqual(["text", "image"]);
    expect(out.content[1].mimeType).toBe("image/png");
  });

  it("una decisión se puede responder solo con una captura y le llega al agente", () => {
    const marta = hireAgent({ name: "Marta", specialty: "Producto" });
    const d = createDecision({ title: "Pega los números de App Store Connect", context: "" }, marta);
    const ref = toRef(saveAttachment("app-store.png", PNG));
    const answered = answerDecision(d.id, { action: "responder", attachments: [ref] });
    expect(answered).toMatchObject({ status: "resuelta", answerKind: "texto" });
    expect(answered.attachments.map((a) => a.id)).toEqual([ref.id]);
    const delivered = listDecisions().find((x) => x.id === d.id)!;
    expect(getTask(delivered.taskId!)?.data.attachments).toEqual([ref]);
  });
});
