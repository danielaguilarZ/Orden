import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openDb, setDbForTests } from "@/lib/db";
import { ensureSeed } from "@/lib/seed";
import { getChief } from "@/lib/repo/agents";
import { activeConversation } from "@/lib/repo/chat";
import { createTask } from "@/lib/repo/tasks";
import { FileTree, trashNode } from "@/lib/files/repo";
import { runTask, type QueryFn } from "@/lib/agents/runner";
import {
  ATTACH_FOLDER,
  attachmentRefs,
  loadAttachments,
  MAX_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  promptWithAttachments,
  saveAttachment,
} from "@/lib/chat/attachments";
import { nameFor } from "@/components/Attachments";

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orden-adjuntos-"));
  process.env.ORDEN_FILES_DIR = tmp;
  process.env.ORDEN_FILES_MAX_MB = "30";
});
afterAll(() => {
  delete process.env.ORDEN_FILES_DIR;
  delete process.env.ORDEN_FILES_MAX_MB;
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  setDbForTests(openDb(":memory:"));
  ensureSeed();
});

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const png = (extra = 8) => Uint8Array.from([...PNG_SIGNATURE, ...new Array(extra).fill(7)]);
const text = (s: string) => new TextEncoder().encode(s);

describe("adjuntos del chat: nombres de capturas", () => {
  const at = new Date(2026, 9, 8, 18, 5, 9);
  const file = (name: string, type = "image/png") => new File([new Uint8Array([1])], name, { type });

  it("renombra los nombres que no dicen nada (pegado y capturas de Windows)", () => {
    expect(nameFor(file("image.png"), 0, at)).toBe("captura-20261008-180509.png");
    expect(nameFor(file("{3AB06AB5-5EFF-4795-82E5-F8A2B5C67097}.png"), 0, at)).toBe("captura-20261008-180509.png");
    expect(nameFor(file("3ab06ab5-5eff-4795-82e5-f8a2b5c67097.jpg", "image/jpeg"), 1, at)).toBe("captura-20261008-180509-2.jpg");
    expect(nameFor(file("", "image/jpeg"), 0, at)).toBe("captura-20261008-180509.jpg");
  });

  it("respeta los nombres con sentido", () => {
    expect(nameFor(file("factura-septiembre.pdf", "application/pdf"), 0, at)).toBe("factura-septiembre.pdf");
    expect(nameFor(file("mi foto.png"), 0, at)).toBe("mi foto.png");
  });
});

describe("adjuntos del chat: guardado", () => {
  it("guarda en una carpeta privada «Adjuntos» y la reutiliza", () => {
    const a = saveAttachment("notas.md", text("# Hola"));
    const b = saveAttachment("notas.md", text("# Otra"));
    expect(a).toMatchObject({ name: "notas.md", size: 6 });
    expect(b.name).toBe("notas (2).md");
    const t = new FileTree();
    const folders = t.nodes.filter((n) => n.kind === "carpeta" && n.name === ATTACH_FOLDER);
    expect(folders).toHaveLength(1);
    expect(folders[0]).toMatchObject({ private: true, parentId: null });
    expect(t.pathOf(t.byId.get(a.id)!)).toBe("Adjuntos/notas.md");
  });

  it("rechaza tipos no admitidos y contenido que no coincide", () => {
    expect(() => saveAttachment("virus.exe", text("MZ"))).toThrow(/no admitido/i);
    expect(() => saveAttachment("falsa.png", text("no soy una imagen"))).toThrow(/no parece/i);
    expect(() => saveAttachment("vacio.txt", new Uint8Array())).toThrow(/vacío/i);
  });

  it("valida los ids recibidos: existentes, sin repetir y con tope", () => {
    const a = saveAttachment("a.txt", text("a"));
    expect(attachmentRefs(undefined)).toEqual([]);
    expect(attachmentRefs([a.id, a.id])).toEqual([a]);
    expect(() => attachmentRefs(["no-existe"])).toThrow(/ya no existe/);
    expect(() => attachmentRefs("a")).toThrow(/no válidos/);
    const many = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => saveAttachment(`f${i}.txt`, text("x")).id);
    expect(() => attachmentRefs(many)).toThrow(/máximo/i);
    trashNode(a.id);
    expect(() => attachmentRefs([a.id])).toThrow(/ya no existe/);
  });
});

describe("adjuntos del chat: contenido para el modelo", () => {
  it("sin adjuntos no cambia nada", () => {
    expect(loadAttachments(undefined)).toBeNull();
    expect(loadAttachments([])).toBeNull();
    expect(promptWithAttachments("hola", null)).toBe("hola");
  });

  it("el texto y las tablas van dentro del mensaje", () => {
    const doc = saveAttachment("gastos.csv", text("concepto;importe\nluz;45\nagua;20"));
    const notas = saveAttachment("notas.txt", text("Recordar pagar el IBI"));
    const att = loadAttachments([doc.id, notas.id])!;
    expect(att.images).toEqual([]);
    expect(att.text).toContain("<adjuntos>");
    expect(att.text).toContain("«gastos.csv»");
    expect(att.text).toContain("luz | 45");
    expect(att.text).toContain("Recordar pagar el IBI");
    expect(att.text).toContain("no instrucciones");
    expect(promptWithAttachments("mira esto", att)).toBe(`mira esto\n\n${att.text}`);
  });

  it("corta los textos largos y avisa de cómo seguir", () => {
    const big = saveAttachment("largo.txt", text("a".repeat(30_000)));
    const att = loadAttachments([big.id])!;
    expect(att.text).toContain("texto cortado");
    expect(att.text).toContain("archivo_leer");
    expect(att.text.length).toBeLessThan(22_000);
  });

  it("las imágenes viajan en base64 como imagen real", async () => {
    const img = saveAttachment("captura.png", png());
    const att = loadAttachments([img.id])!;
    expect(att.images).toHaveLength(1);
    expect(att.images[0]).toMatchObject({ name: "captura.png", mediaType: "image/png" });
    expect(Buffer.from(att.images[0].data, "base64")[0]).toBe(0x89);
    expect(att.text).toContain("imagen");

    const prompt = promptWithAttachments("¿qué ves?", att);
    expect(typeof prompt).not.toBe("string");
    const got: unknown[] = [];
    for await (const m of prompt as AsyncIterable<unknown>) got.push(m);
    expect(got).toHaveLength(1);
    const msg = got[0] as { type: string; parent_tool_use_id: null; message: { role: string; content: { type: string; text?: string; source?: { media_type: string } }[] } };
    expect(msg).toMatchObject({ type: "user", parent_tool_use_id: null });
    expect(msg.message.role).toBe("user");
    expect(msg.message.content[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png" } });
    expect(msg.message.content[1].type).toBe("text");
    expect(msg.message.content[1].text).toContain("¿qué ves?");
  });

  it("una imagen demasiado grande no se envía y se dice por qué", () => {
    const huge = saveAttachment("enorme.png", png(MAX_IMAGE_BYTES + 10));
    const att = loadAttachments([huge.id])!;
    expect(att.images).toEqual([]);
    expect(att.text).toContain("No se ha podido enviar");
  });

  it("si un adjunto se borra antes de ejecutar, el encargo sigue adelante", () => {
    const a = saveAttachment("a.txt", text("hola"));
    trashNode(a.id);
    expect(loadAttachments([a.id])!.text).toContain("no disponible");
  });
});

describe("adjuntos del chat: ejecución del encargo", () => {
  function recorder() {
    const seen: unknown[] = [];
    const q = ((args: { prompt: unknown }) =>
      (async function* () {
        seen.push(args.prompt);
        yield { type: "result", subtype: "success", result: "ok", usage: {}, total_cost_usd: 0, num_turns: 1, duration_ms: 1, session_id: "s" };
      })()) as unknown as QueryFn;
    return { seen, q };
  }

  it("con documentos el prompt sigue siendo texto e incluye su contenido", async () => {
    const zen = getChief()!;
    const doc = saveAttachment("presupuesto.md", text("Alquiler 800 €"));
    const { seen, q } = recorder();
    await runTask(createTask({ agentId: zen.id, kind: "chat", prompt: "Revisa esto", data: { attachments: [doc.id] } }), { queryFn: q });
    expect(typeof seen[0]).toBe("string");
    expect(seen[0]).toContain("Revisa esto");
    expect(seen[0]).toContain("Alquiler 800 €");
  });

  it("con imágenes el prompt es un mensaje con bloques de imagen", async () => {
    const zen = getChief()!;
    const conv = activeConversation(zen.id);
    const img = saveAttachment("foto.png", png());
    const { seen, q } = recorder();
    await runTask(createTask({ agentId: zen.id, kind: "chat", conversationId: conv.id, prompt: "¿Qué es?", data: { attachments: [img.id] } }), { queryFn: q });
    expect(typeof seen[0]).not.toBe("string");
    const blocks: { type: string }[] = [];
    for await (const m of seen[0] as AsyncIterable<{ message: { content: { type: string }[] } }>) blocks.push(...m.message.content);
    expect(blocks.map((b) => b.type)).toEqual(["image", "text"]);
  });

  it("un encargo sin adjuntos se envía como antes (texto)", async () => {
    const zen = getChief()!;
    const { seen, q } = recorder();
    await runTask(createTask({ agentId: zen.id, kind: "chat", prompt: "hola" }), { queryFn: q });
    expect(typeof seen[0]).toBe("string");
    expect(seen[0]).not.toContain("<adjuntos>");
  });
});
