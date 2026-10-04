import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { strToU8, zipSync, zlibSync } from "fflate";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, openDb, setDbForTests } from "@/lib/db";
import { ensureSeed } from "@/lib/seed";
import { getChief } from "@/lib/repo/agents";
import { createTask } from "@/lib/repo/tasks";
import { listActivity } from "@/lib/repo/system";
import { hireAgent } from "@/lib/team";
import { buildTools, type ToolDef } from "@/lib/agents/tools";
import { buildSystemPrompt } from "@/lib/agents/prompt";
import {
  blobPath,
  createFolder,
  emptyTrash,
  ensureFilesSeed,
  fileAccessOf,
  FileTree,
  filesRoot,
  listLiveNodes,
  listTrash,
  moveNode,
  parseDailyPath,
  purgeNode,
  renameNode,
  resolveForAgent,
  restoreNode,
  saveFile,
  setFileAccess,
  setFolderPrivate,
  trashNode,
  writeDailyFile,
  type FileNode,
} from "@/lib/files/repo";
import { checkContent, cleanName, contentDisposition, isInside, nameKey, splitVirtualPath, uniqueName } from "@/lib/files/rules";
import { decodeText, excelDate, extractText, parseCsv, parseXlsx } from "@/lib/files/read";
import { extractPdfText, hash2B } from "@/lib/files/pdf";
import { readForAgent } from "@/lib/files/tools";
import { readBodyLimited } from "@/lib/files/upload";
import "@/lib/agents/modules";
import type { Agent } from "@/lib/types";

// ───────────── Generadores de archivos de prueba ─────────────

const latin1 = (s: string) => Uint8Array.from(Buffer.from(s, "latin1"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const concat = (...parts: Uint8Array[]) => Uint8Array.from(Buffer.concat(parts));

/** null = ese número no es un objeto directo (p. ej. está dentro de un ObjStm). */
type PdfPart = string | { dict: string; stream: Uint8Array } | null;

/** PDF mínimo: objetos numerados desde 1 (el 1 es el catálogo) y un tráiler. */
function buildPdf(objects: PdfPart[], trailerExtra = ""): Uint8Array {
  const chunks: Uint8Array[] = [latin1("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")];
  objects.forEach((o, i) => {
    if (o === null) return;
    const head = latin1(`${i + 1} 0 obj\n`);
    if (typeof o === "string") chunks.push(head, latin1(`${o}\nendobj\n`));
    else chunks.push(head, latin1(`<< ${o.dict} /Length ${o.stream.length} >>\nstream\n`), o.stream, latin1("\nendstream\nendobj\n"));
  });
  chunks.push(latin1(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra} >>\n%%EOF\n`));
  return concat(...chunks);
}

const PAGES_2 = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  // Los recursos se heredan del nodo /Pages.
  "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 /Resources << /Font << /F1 5 0 R >> >> >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>",
];
const HELVETICA = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

function simplePdf(): Uint8Array {
  const page1 = latin1(
    "BT /F1 12 Tf 72 770 Td (N\\363mina septiembre 2026) Tj 0 -20 Td (Empresa: Ejemplo S.L.) Tj ET\n" +
      "BT /F1 10 Tf 72 700 Td (L\\355quido a percibir) Tj 300 0 Td (1.850,32 \\200) Tj ET",
  );
  return buildPdf([
    ...PAGES_2,
    { dict: "", stream: page1 },
    HELVETICA,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 7 0 R >>",
    { dict: "", stream: latin1("BT /F1 12 Tf 72 770 Td (Segunda p\\341gina) Tj ET") },
  ]);
}

/** Flujos comprimidos, TJ con huecos, un formulario (XObject) y una imagen en línea. */
function compressedPdf(): Uint8Array {
  const content = latin1(
    "BT /F1 12 Tf 1 0 0 1 72 760 Tm [(Saldo)-300(final)] TJ ET\n" +
      "BT /F1 12 Tf 72 740 Td [(Ho)20(la)] TJ ET\n" +
      "BI /W 2 /H 1 /BPC 8 /CS /G ID \x00\xff EI\n" +
      "q 1 0 0 1 0 -100 cm /Fm1 Do Q",
  );
  const form = latin1("BT /F1 12 Tf 72 760 Td (Desde formulario) Tj ET");
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /Fm1 6 0 R >> >> /Contents 4 0 R >>",
    { dict: "/Filter /FlateDecode", stream: zlibSync(content) },
    HELVETICA,
    { dict: "/Type /XObject /Subtype /Form /BBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Filter /FlateDecode", stream: zlibSync(form) },
  ]);
}

/** Fuente compuesta (Identity-H) con ToUnicode; la fuente vive en un flujo de objetos (ObjStm). */
function type0Pdf(): Uint8Array {
  const cmap = latin1(
    "/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n" +
      "1 begincodespacerange <0000> <FFFF> endcodespacerange\n" +
      "6 beginbfchar <0001> <0048> <0002> <006F> <0003> <006C> <0004> <0061> <0005> <0020> <0006> <20AC> endbfchar\n" +
      "1 beginbfrange <0007> <0009> <0041> endbfrange\n" +
      "endcmap CMapName currentdict /CMap defineresource pop end end",
  );
  const font = "<< /Type /Font /Subtype /Type0 /BaseFont /Fuente /Encoding /Identity-H /DescendantFonts [7 0 R] /ToUnicode 6 0 R >>";
  const cid = "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Fuente /DW 600 /W [1 [700 500]] >>";
  const header = `5 0 7 ${font.length + 1} `;
  const objstm = latin1(`${header}${font}\n${cid}`);
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F2 5 0 R >> >> /Contents 4 0 R >>",
    { dict: "", stream: latin1("BT /F2 11 Tf 50 800 Td <000100020003000400050006> Tj 0 -14 Td <000700080009> Tj ET") },
    null, // 5: en el ObjStm
    { dict: "", stream: cmap },
    null, // 7: en el ObjStm
    { dict: `/Type /ObjStm /N 2 /First ${header.length} /Filter /FlateDecode`, stream: zlibSync(objstm) },
  ]);
}

const PAD = Uint8Array.from([0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a]);
const md5 = (...p: Uint8Array[]) => new Uint8Array(p.reduce((h, x) => h.update(x), createHash("md5")).digest());
function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = new Uint8Array(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

const SECRET_CONTENT = latin1("BT /F1 12 Tf 72 770 Td (Extracto: saldo 2.345,67) Tj ET");
const encryptedBase = (stream: Uint8Array): PdfPart[] => [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
  { dict: "", stream },
  HELVETICA,
];

/** RC4 de 128 bits (R3) con contraseña de usuario vacía, como muchos PDF bancarios. */
function rc4Pdf(opts: { wrongPassword?: boolean } = {}): Uint8Array {
  const O = new Uint8Array(32).fill(0x11);
  const id0 = Uint8Array.from(randomBytes(16));
  const P = -4;
  const pBytes = Uint8Array.from([P & 255, (P >> 8) & 255, (P >> 16) & 255, (P >>> 24) & 255]);
  let key = md5(PAD, O, pBytes, id0).subarray(0, 16);
  for (let i = 0; i < 50; i++) key = md5(key).subarray(0, 16);
  let u = rc4(key, md5(PAD, id0));
  for (let i = 1; i <= 19; i++) u = rc4(key.map((b) => b ^ i), u);
  const U = concat(u, new Uint8Array(16));
  if (opts.wrongPassword) U[0] ^= 0xff;
  const objKey = md5(key, Uint8Array.from([4, 0, 0, 0, 0])).subarray(0, 16);
  return buildPdf(
    [...encryptedBase(rc4(objKey, SECRET_CONTENT)), `<< /Filter /Standard /V 2 /R 3 /Length 128 /O <${hex(O)}> /U <${hex(U)}> /P ${P} >>`],
    `/Encrypt 6 0 R /ID [<${hex(id0)}> <${hex(id0)}>]`,
  );
}

/** AES-256 (R6, PDF 2.0) con contraseña de usuario vacía. */
function aes256Pdf(): Uint8Array {
  const fileKey = Uint8Array.from(randomBytes(32));
  const vsalt = Uint8Array.from(randomBytes(8));
  const ksalt = Uint8Array.from(randomBytes(8));
  const empty = new Uint8Array(0);
  const U = concat(hash2B(empty, vsalt, empty), vsalt, ksalt);
  const c = createCipheriv("aes-256-cbc", hash2B(empty, ksalt, empty), new Uint8Array(16));
  c.setAutoPadding(false);
  const UE = concat(c.update(fileKey), c.final());
  const iv = Uint8Array.from(randomBytes(16));
  const s = createCipheriv("aes-256-cbc", fileKey, iv);
  const stream = concat(iv, s.update(SECRET_CONTENT), s.final());
  return buildPdf(
    [
      ...encryptedBase(stream),
      `<< /Filter /Standard /V 5 /R 6 /Length 256 /CF << /StdCF << /CFM /AESV3 /AuthEvent /DocOpen /Length 32 >> >> /StmF /StdCF /StrF /StdCF /O <${hex(new Uint8Array(48))}> /U <${hex(U)}> /OE <${hex(new Uint8Array(32))}> /UE <${hex(UE)}> /P -4 /Perms <${hex(new Uint8Array(16))}> >>`,
    ],
    "/Encrypt 6 0 R /ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>]",
  );
}

function scannedPdf(): Uint8Array {
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>",
    { dict: "", stream: latin1("q 595 0 0 842 0 0 cm /Im1 Do Q") },
    { dict: "/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode", stream: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]) },
  ]);
}

function xlsx(): Uint8Array {
  const sheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
    <row r="2"><c r="A2" s="1"><v>46296</v></c><c r="B2" t="s"><v>3</v></c><c r="C2"><v>-45.200000000000003</v></c><c r="D2" t="inlineStr"><is><t>nota</t></is></c><c r="F2" t="b"><v>1</v></c></row>
    <row r="3"/>
  </sheetData></worksheet>`;
  return zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "xl/workbook.xml": strToU8('<workbook xmlns:r="r"><workbookPr/><sheets><sheet name="Movimientos" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    "xl/_rels/workbook.xml.rels": strToU8('<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
    "xl/sharedStrings.xml": strToU8("<sst><si><t>Fecha</t></si><si><t>Concepto</t></si><si><t>Importe</t></si><si><r><t xml:space=\"preserve\">Compra </t></r><r><t>Mercadona &amp; co</t></r></si></sst>"),
    "xl/styles.xml": strToU8('<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>'),
    "xl/worksheets/sheet1.xml": strToU8(sheet),
  });
}

// ───────────── Entorno ─────────────

let tmp: string;
let ana: Agent, leo: Agent, gwen: Agent;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orden-archivos-"));
  process.env.ORDEN_FILES_DIR = tmp;
});
afterAll(() => {
  delete process.env.ORDEN_FILES_DIR;
  delete process.env.ORDEN_FILES_MAX_MB;
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  setDbForTests(openDb(":memory:"));
  ensureSeed();
  ana = hireAgent({ name: "Ana", specialty: "Finanzas personales" });
  leo = hireAgent({ name: "Leo", specialty: "Desarrollo web" });
  gwen = hireAgent({ name: "Gwen", specialty: "Decoradora" });
  ensureFilesSeed();
  setFileAccess(ana.id, "todo");
});

const folderByPath = (p: string) => {
  const t = new FileTree();
  return resolveForAgent(t, "todo", p)!;
};
const pdfIn = (folder: string, name: string, data = simplePdf()) => saveFile({ parentId: folderByPath(folder).id, name, data });

function toolsOf(agent: Agent): ToolDef[] {
  const task = createTask({ agentId: agent.id, kind: "chat", prompt: "x" });
  return buildTools({ agent, task, signal: new AbortController().signal, note: () => {} });
}
const fileToolNames = (a: Agent) =>
  toolsOf(a)
    .map((t) => t.name)
    .filter((n) => n.startsWith("archivo"))
    .sort();
async function call(agent: Agent, name: string, args: Record<string, unknown>) {
  const t = toolsOf(agent).find((x) => x.name === name);
  if (!t) throw new Error(`${agent.name} no tiene ${name}`);
  return (await t.handler(args, {})) as { content: { text: string }[]; isError?: boolean };
}

// ───────────── Tests ─────────────

describe("reglas: nombres, rutas y contenido", () => {
  it("valida nombres", () => {
    expect(cleanName("  Nóminas 2026 ")).toBe("Nóminas 2026");
    for (const bad of ["", "   ", ".", "..", "a/b", "a\\b", "x:y", "fin.", "fin. ", "CON", "nul.txt", "a\u0001b", "x".repeat(121)]) expect(() => cleanName(bad)).toThrow();
    expect(nameKey("Nóminas")).toBe(nameKey("NOMINAS"));
    expect(uniqueName("nomina.pdf", (k) => k === "nomina.pdf" || k === "nomina (2).pdf")).toBe("nomina (3).pdf");
    expect(uniqueName("Finanzas", (k) => k === "finanzas")).toBe("Finanzas (2)");
  });

  it("las rutas virtuales no salen de la raíz", () => {
    expect(splitVirtualPath("/Finanzas\\Nóminas//x.pdf")).toEqual(["Finanzas", "Nóminas", "x.pdf"]);
    expect(() => splitVirtualPath("Finanzas/../../etc/passwd")).toThrow();
    expect(() => splitVirtualPath("./x")).toThrow();
    expect(isInside(tmp, path.join(tmp, "blobs", "x"))).toBe(true);
    expect(isInside(tmp, path.join(tmp, "..", "fuera"))).toBe(false);
    expect(isInside(tmp, tmp)).toBe(false);
    expect(() => blobPath("../../secreto")).toThrow();
    expect(() => blobPath("abc")).toThrow();
    expect(blobPath("0f8fad5b-d9cb-469f-a165-70867728950e").startsWith(path.join(tmp, "blobs"))).toBe(true);
  });

  it("comprueba que el contenido coincide con la extensión y el límite de tamaño", () => {
    expect(checkContent("a.pdf", simplePdf()).category).toBe("pdf");
    expect(() => checkContent("virus.pdf", latin1("MZ\x90\x00 ejecutable"))).toThrow(/no parece/);
    expect(() => checkContent("hoja.xlsx", latin1("no es zip"))).toThrow();
    expect(() => checkContent("foto.png", Uint8Array.from([0xff, 0xd8, 0xff]))).toThrow();
    expect(() => checkContent("datos.csv", Uint8Array.from([0x61, 0x00, 0x62]))).toThrow();
    expect(() => checkContent("web.html", latin1("<script>"))).toThrow(/no admitido/);
    expect(() => checkContent("dibujo.svg", latin1("<svg/>"))).toThrow(/no admitido/);
    expect(() => checkContent("vacio.txt", new Uint8Array(0))).toThrow(/vacío/);
    process.env.ORDEN_FILES_MAX_MB = "0.001"; // ~1 KB
    expect(() => checkContent("grande.txt", new Uint8Array(2000).fill(65))).toThrow(/límite/);
    delete process.env.ORDEN_FILES_MAX_MB;
  });

  it("la subida se corta al pasar del límite", async () => {
    const big = new Request("http://localhost/api/files/upload", { method: "POST", body: new Uint8Array(5000) });
    await expect(readBodyLimited(big, 1000)).rejects.toThrow(/límite/);
    const small = new Request("http://localhost/api/files/upload", { method: "POST", body: new Uint8Array(500).fill(7) });
    expect((await readBodyLimited(small, 1000)).length).toBe(500);
  });

  it("descargas con nombre UTF-8", () => {
    expect(contentDisposition("Nómina sept.pdf", true)).toBe(`attachment; filename="Nomina sept.pdf"; filename*=UTF-8''N%C3%B3mina%20sept.pdf`);
    expect(contentDisposition('a"b.pdf', false).startsWith('inline; filename="a_b.pdf"')).toBe(true);
  });
});

describe("carpetas iniciales y permisos", () => {
  it("Finanzas (privada) con Nóminas y Extractos bancarios, una sola vez", () => {
    ensureFilesSeed();
    const nodes = listLiveNodes();
    expect(nodes.filter((n) => n.kind === "carpeta").map((n) => n.name).sort()).toEqual(["Extractos bancarios", "Finanzas", "Nóminas"]);
    const fin = nodes.find((n) => n.name === "Finanzas")!;
    expect(fin.private).toBe(true);
    expect(nodes.filter((n) => n.parentId === fin.id).every((n) => n.private)).toBe(true);
    expect(fileAccessOf(getChief()!)).toBe("todo");
    expect(fileAccessOf(leo)).toBe("compartido");
    expect(fileAccessOf(gwen)).toBe("compartido");
  });

  it("solo el jefe tiene acceso a todo de serie; al resto se le da y se le quita a mano", () => {
    setDbForTests(openDb(":memory:"));
    ensureSeed();
    ensureFilesSeed();
    const nueva = hireAgent({ name: "Ana", specialty: "Finanzas" });
    expect(fileAccessOf(nueva)).toBe("compartido");
    ensureFilesSeed();
    expect(fileAccessOf(nueva)).toBe("compartido");
    setFileAccess(nueva.id, "todo");
    expect(fileAccessOf(nueva)).toBe("todo");
    setFileAccess(nueva.id, null);
    expect(fileAccessOf(nueva)).toBe("compartido");
    expect(() => setFileAccess(getChief()!.id, null)).toThrow(/jefe/);
    expect(listLiveNodes().filter((n) => n.name === "Finanzas")).toHaveLength(1);
  });
});

describe("árbol: crear, renombrar, mover y papelera", () => {
  it("crea carpetas (heredan la privacidad) y no permite duplicados", () => {
    const fin = folderByPath("Finanzas");
    const imp = createFolder({ parentId: fin.id, name: "Impuestos" });
    expect(imp.private).toBe(true);
    expect(() => createFolder({ parentId: fin.id, name: "impuestos" })).toThrow(/Ya hay/);
    expect(createFolder({ parentId: null, name: "Personal" }).private).toBe(true); // primer nivel: privada
    expect(createFolder({ parentId: null, name: "Compartido", private: false }).private).toBe(false);
    expect(() => createFolder({ parentId: "no-existe", name: "x" })).toThrow();
  });

  it("guarda archivos en disco por id, numera duplicados y no cambia extensiones", () => {
    const a = pdfIn("Finanzas/Nóminas", "nomina-2026-09.pdf");
    const b = pdfIn("Finanzas/Nóminas", "NOMINA-2026-09.pdf");
    expect(b.name).toBe("NOMINA-2026-09 (2).pdf");
    expect(fs.existsSync(blobPath(a.id))).toBe(true);
    expect(fs.readdirSync(path.join(filesRoot(), "blobs")).every((f) => !f.includes("nomina"))).toBe(true);
    expect(() => renameNode(a.id, "nomina.exe")).toThrow(/extensión/);
    expect(() => renameNode(a.id, "NOMINA-2026-09 (2).pdf")).toThrow(/Ya hay/);
    expect(renameNode(a.id, "Nómina septiembre.pdf").name).toBe("Nómina septiembre.pdf");
    expect(() => saveFile({ parentId: null, name: "..\\..\\evil.pdf", data: simplePdf() })).not.toThrow(); // solo cuenta el nombre base
    expect(listLiveNodes().some((n) => n.name === "evil.pdf" && n.parentId === null)).toBe(true);
  });

  it("mueve sin meter una carpeta dentro de sí misma", () => {
    const fin = folderByPath("Finanzas");
    const nom = folderByPath("Finanzas/Nóminas");
    const sub = createFolder({ parentId: nom.id, name: "2026" });
    expect(() => moveNode(fin.id, sub.id)).toThrow(/sí misma/);
    expect(() => moveNode(fin.id, fin.id)).toThrow(/sí misma/);
    const f = pdfIn("Finanzas/Nóminas", "x.pdf");
    expect(moveNode(f.id, sub.id).parentId).toBe(sub.id);
    expect(new FileTree().pathOf(new FileTree().byId.get(f.id)!)).toBe("Finanzas/Nóminas/2026/x.pdf");
    expect(moveNode(sub.id, null).parentId).toBeNull();
  });

  it("papelera: se va con su contenido, se recupera y se borra para siempre", () => {
    const nom = folderByPath("Finanzas/Nóminas");
    const f = pdfIn("Finanzas/Nóminas", "n.pdf");
    trashNode(nom.id);
    expect(listLiveNodes().some((n) => n.id === f.id)).toBe(false);
    expect(listTrash().map((n) => n.name)).toEqual(["Nóminas"]); // solo lo de arriba
    expect(listTrash()[0].items).toBe(1);
    expect(() => purgeNode(folderByPath("Finanzas").id)).toThrow(/papelera/);
    restoreNode(nom.id);
    expect(listLiveNodes().some((n) => n.id === f.id)).toBe(true);

    // Si su carpeta ya no está, vuelve a la raíz (y se renombra si choca).
    trashNode(f.id);
    trashNode(nom.id);
    expect(restoreNode(f.id).parentId).toBeNull();

    const file = blobPath(f.id);
    trashNode(f.id);
    expect(emptyTrash()).toBe(2);
    expect(fs.existsSync(file)).toBe(false);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM file_nodes WHERE trashed_at IS NOT NULL").get()).toEqual({ n: 0 });
  });
});

describe("lectura de contenido", () => {
  it("CSV: separador, comillas y Windows-1252", () => {
    const raw = Buffer.from('Fecha;Concepto;Importe\r\n01/10/2026;"Pago; recibo ""luz""";-12,50\r\n02/10/2026;Nómina;1.850,32\r\n', "latin1");
    expect(decodeText(raw)).toContain("Nómina");
    expect(parseCsv(decodeText(raw))).toEqual([
      ["Fecha", "Concepto", "Importe"],
      ["01/10/2026", 'Pago; recibo "luz"', "-12,50"],
      ["02/10/2026", "Nómina", "1.850,32"],
    ]);
    expect(parseCsv("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    const ex = extractText("extracto.csv", Uint8Array.from(raw));
    expect(ex.text).toContain("02/10/2026 | Nómina | 1.850,32");
  });

  it("XLSX: textos compartidos, fechas, números, booleanos y celdas vacías", () => {
    expect(excelDate(46296)).toBe("2026-10-01");
    expect(excelDate(46296.5)).toBe("2026-10-01 12:00");
    const sheets = parseXlsx(xlsx());
    expect(sheets).toHaveLength(1);
    expect(sheets[0].name).toBe("Movimientos");
    expect(sheets[0].rows).toEqual([
      ["Fecha", "Concepto", "Importe"],
      ["2026-10-01", "Compra Mercadona & co", "-45.2", "nota", "", "VERDADERO"],
    ]);
    expect(extractText("mov.xlsx", xlsx()).text).toContain("## Hoja «Movimientos» (2 filas)");
  });

  it("PDF sencillo: páginas, tildes, € y columnas en la misma línea", () => {
    const { pages, warning } = extractPdfText(simplePdf());
    expect(warning).toBeUndefined();
    expect(pages).toHaveLength(2);
    expect(pages[0].split("\n")).toEqual(["Nómina septiembre 2026", "Empresa: Ejemplo S.L.", expect.stringMatching(/^Líquido a percibir {2,}1\.850,32 €$/)]);
    expect(pages[1]).toBe("Segunda página");
  });

  it("PDF comprimido: TJ con espacios y kerning, formularios e imágenes en línea", () => {
    const { pages } = extractPdfText(compressedPdf());
    expect(pages[0].split("\n")).toEqual(["Saldo final", "Hola", "Desde formulario"]);
  });

  it("PDF con fuente compuesta y ToUnicode dentro de un flujo de objetos", () => {
    const { pages, warning } = extractPdfText(type0Pdf());
    expect(warning).toBeUndefined();
    expect(pages[0].split("\n")).toEqual(["Hola €", "ABC"]);
  });

  it("PDF cifrados sin contraseña de usuario (RC4 y AES-256) y con contraseña", () => {
    expect(extractPdfText(rc4Pdf()).pages[0]).toBe("Extracto: saldo 2.345,67");
    expect(extractPdfText(aes256Pdf()).pages[0]).toBe("Extracto: saldo 2.345,67");
    expect(extractPdfText(rc4Pdf({ wrongPassword: true })).warning).toMatch(/contraseña/);
  });

  it("PDF escaneado o roto: avisa en vez de fallar", () => {
    expect(extractPdfText(scannedPdf()).warning).toMatch(/escaneo/);
    expect(extractPdfText(latin1("%PDF-1.4\nbasura sin objetos")).warning).toBeTruthy();
  });

  it("lectura por trozos", () => {
    const f = saveFile({ parentId: folderByPath("Finanzas").id, name: "largo.txt", data: latin1("0123456789".repeat(500)) });
    const first = readForAgent("todo", f.id, 0, 1000);
    expect(first.text).toMatch(/quedan 4\.?000 caracteres: vuelve a llamar con desde=1000/);
    const last = readForAgent("todo", "Finanzas/largo.txt", 4500, 1000);
    expect(last.text).not.toContain("quedan");
    expect(last.text.trimEnd().endsWith("0123456789")).toBe(true);
  });
});

describe("herramientas de los agentes y privacidad", () => {
  let nomina: FileNode;
  beforeEach(() => {
    nomina = pdfIn("Finanzas/Nóminas", "nomina-2026-09.pdf");
  });

  it("Ana y Zen las tienen; el resto no, mientras no haya carpetas compartidas", () => {
    const all = ["archivo_leer", "archivos_buscar", "archivos_listar"];
    expect(fileToolNames(ana)).toEqual(all);
    expect(fileToolNames(getChief()!)).toEqual(["archivo_escribir", ...all]);
    expect(fileToolNames(leo)).toEqual([]);
    expect(buildSystemPrompt(ana, createTask({ agentId: ana.id, kind: "chat", prompt: "x" }))).toContain("incluidas las carpetas privadas");
    expect(buildSystemPrompt(leo, createTask({ agentId: leo.id, kind: "chat", prompt: "x" }))).not.toContain("archivo_leer");
    createFolder({ parentId: null, name: "Compartido", private: false });
    expect(fileToolNames(leo)).toEqual(all);
  });

  it("Ana lista, busca y lee una nómina (queda en Actividad)", async () => {
    const list = await call(ana, "archivos_listar", { recursivo: true });
    expect(list.content[0].text).toContain("📁 Finanzas/");
    expect(list.content[0].text).toContain("nomina-2026-09.pdf");
    const found = await call(ana, "archivos_buscar", { texto: "NOMINAS 2026" });
    expect(found.content[0].text).toContain("Finanzas/Nóminas/nomina-2026-09.pdf");
    const read = await call(ana, "archivo_leer", { archivo: "finanzas/nominas/nomina-2026-09.pdf" });
    expect(read.isError).toBeUndefined();
    expect(read.content[0].text).toContain("PDF · 2 página(s)");
    expect(read.content[0].text).toContain("Líquido a percibir");
    expect(listActivity().some((a) => a.kind === "archivos" && a.text.includes("Ana ha leído"))).toBe(true);
  });

  it("los agentes sin acceso a todo no ven lo privado ni por ruta ni por id", async () => {
    const shared = createFolder({ parentId: null, name: "Compartido", private: false });
    const doc = saveFile({ parentId: shared.id, name: "menu.txt", data: latin1("Lunes: lentejas") });
    for (const ref of ["Finanzas/Nóminas/nomina-2026-09.pdf", nomina.id, nomina.id.slice(0, 8)]) {
      const r = await call(leo, "archivo_leer", { archivo: ref });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("no tienes acceso");
    }
    const list = (await call(leo, "archivos_listar", { recursivo: true })).content[0].text;
    expect(list).toContain("Compartido");
    expect(list).not.toContain("Finanzas");
    expect((await call(leo, "archivos_buscar", { texto: "nomina" })).content[0].text).toContain("Nada coincide");
    expect((await call(gwen, "archivo_leer", { archivo: doc.id })).content[0].text).toContain("Lunes: lentejas");

    // Una subcarpeta privada dentro de una compartida también se oculta…
    const priv = createFolder({ parentId: shared.id, name: "Solo yo", private: true });
    saveFile({ parentId: priv.id, name: "secreto.txt", data: latin1("x") });
    expect((await call(leo, "archivos_listar", { carpeta: "Compartido" })).content[0].text).not.toContain("Solo yo");
    // …y si se comparte Finanzas, ya la ven.
    setFolderPrivate(folderByPath("Finanzas").id, false);
    setFolderPrivate(folderByPath("Finanzas/Nóminas").id, false);
    expect((await call(leo, "archivo_leer", { archivo: nomina.id })).isError).toBeUndefined();
  });

  it("rutas con «..» no escapan", async () => {
    const r = await call(ana, "archivo_leer", { archivo: "Finanzas/../../../Windows/win.ini" });
    expect(r.isError).toBe(true);
  });
});

describe("escritura en «Daily»", () => {
  it("rutas: solo dentro de Daily, solo texto y .md por defecto", () => {
    expect(parseDailyPath("Daily/resumen 2026-10-04")).toEqual({ folders: [], name: "resumen 2026-10-04.md" });
    expect(parseDailyPath("daily\\2026\\octubre\\notas.txt")).toEqual({ folders: ["2026", "octubre"], name: "notas.txt" });
    expect(parseDailyPath("Daily/resumen v1.2")).toEqual({ folders: [], name: "resumen v1.2.md" });
    for (const bad of ["resumen.md", "Daily", "Finanzas/x.md", "Daily/../Finanzas/x.md", "Daily/x.pdf", "Daily/x.csv", "Otra/Daily/x.md"]) {
      expect(() => parseDailyPath(bad), bad).toThrow();
    }
  });

  it("crea Daily (privada) si no existe y luego crea, sustituye y añade", () => {
    const zen = getChief()!;
    expect(new FileTree().children(null).some((n) => n.name === "Daily")).toBe(false);
    const a = writeDailyFile({ path: "Daily/resumen 2026-10-04", content: "# Hecho\n- Uno", by: zen.id });
    expect(a.created).toBe(true);
    expect(a.path).toBe("Daily/resumen 2026-10-04.md");
    expect(a.node.mime).toContain("text/markdown");
    const daily = folderByPath("Daily");
    expect(daily.private).toBe(true);
    expect(fs.readFileSync(blobPath(a.node.id), "utf8")).toBe("# Hecho\n- Uno");

    const b = writeDailyFile({ path: "daily/RESUMEN 2026-10-04.md", content: "# Nuevo", by: zen.id });
    expect(b.created).toBe(false);
    expect(b.node.id).toBe(a.node.id);
    expect(b.node.name).toBe("resumen 2026-10-04.md");
    expect(fs.readFileSync(blobPath(a.node.id), "utf8")).toBe("# Nuevo");

    const c = writeDailyFile({ path: "Daily/resumen 2026-10-04", content: "Pendiente: ñandú", append: true });
    expect(fs.readFileSync(blobPath(a.node.id), "utf8")).toBe("# Nuevo\n\nPendiente: ñandú");
    expect(c.node.size).toBe(Buffer.byteLength("# Nuevo\n\nPendiente: ñandú"));

    // Subcarpetas: se crean y heredan la privacidad; Daily no se duplica.
    const d = writeDailyFile({ path: "Daily/2026/10/resumen 2026-10-05", content: "x" });
    expect(d.path).toBe("Daily/2026/10/resumen 2026-10-05.md");
    expect(folderByPath("Daily/2026/10").private).toBe(true);
    expect(new FileTree().children(null).filter((n) => nameKey(n.name) === "daily")).toHaveLength(1);
  });

  it("usa la carpeta Daily existente (con su privacidad) y no pisa carpetas", () => {
    const shared = createFolder({ parentId: null, name: "Daily", private: false });
    createFolder({ parentId: shared.id, name: "resumen.md" });
    const r = writeDailyFile({ path: "Daily/resumen 2026-10-04", content: "x" });
    expect(r.node.parentId).toBe(shared.id);
    expect(() => writeDailyFile({ path: "Daily/resumen.md", content: "x" })).toThrow(/es una carpeta/);
    expect(() => writeDailyFile({ path: "Daily/resumen 2026-10-04.md/x", content: "x" })).toThrow(/es un archivo/);
  });

  it("solo Zen tiene archivo_escribir; fuera de Daily falla y no toca nada; queda en Actividad", async () => {
    const zen = getChief()!;
    for (const a of [ana, leo, gwen]) expect(toolsOf(a).some((t) => t.name === "archivo_escribir")).toBe(false);
    expect(buildSystemPrompt(zen, createTask({ agentId: zen.id, kind: "chat", prompt: "x" }))).toContain("archivo_escribir");
    expect(buildSystemPrompt(ana, createTask({ agentId: ana.id, kind: "chat", prompt: "x" }))).not.toContain("archivo_escribir");

    const before = listLiveNodes().length;
    for (const ruta of ["Finanzas/Nóminas/hack.md", "resumen.md", "Daily/../Finanzas/x.md", "Daily/x.pdf"]) {
      const r = await call(zen, "archivo_escribir", { ruta, contenido: "x" });
      expect(r.isError, ruta).toBe(true);
    }
    expect(listLiveNodes().length).toBe(before);

    const ok1 = await call(zen, "archivo_escribir", { ruta: "Daily/resumen 2026-10-04", contenido: "# Resumen\nHecho: todo" });
    expect(ok1.isError).toBeUndefined();
    expect(ok1.content[0].text).toContain("creado «Daily/resumen 2026-10-04.md»");
    expect(readForAgent("todo", "Daily/resumen 2026-10-04.md").text).toContain("Hecho: todo");
    // Al reescribir, la lectura no sirve el texto viejo de la caché.
    await call(zen, "archivo_escribir", { ruta: "Daily/resumen 2026-10-04", contenido: "Versión 2" });
    const read = readForAgent("todo", "Daily/resumen 2026-10-04.md").text;
    expect(read).toContain("Versión 2");
    expect(read).not.toContain("Hecho: todo");
    expect(listActivity().some((a) => a.kind === "archivos" && a.text.includes("ha creado «Daily/resumen 2026-10-04.md»"))).toBe(true);
    expect(listActivity().some((a) => a.kind === "archivos" && a.text.includes("ha actualizado"))).toBe(true);
  });
});
