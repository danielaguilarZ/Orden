import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dbPath, getDb, now, tx } from "../db";
import { emit } from "../events";
import { getAgent } from "../repo/agents";
import { getSetting, setSetting } from "../repo/system";
import type { Agent } from "../types";
import { checkContent, cleanName, extensionOf, FILE_TYPES, isInside, isUuid, nameKey, splitVirtualPath, uniqueName } from "./rules";

/**
 * Archivos: árbol de carpetas y archivos en SQLite (`file_nodes`) y el
 * contenido en disco, con el id como nombre de fichero. Los nombres que ve el
 * usuario nunca tocan el sistema de archivos, así que renombrar o mover es
 * solo actualizar la BD y no hay forma de escribir fuera de la carpeta raíz.
 */

export type FileNodeKind = "carpeta" | "archivo";

export interface FileNode {
  id: string;
  parentId: string | null;
  kind: FileNodeKind;
  name: string;
  size: number;
  mime: string;
  /** Solo carpetas: privada = solo agentes con acceso a todo. */
  private: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  trashedAt: string | null;
}

interface Row {
  id: string;
  parent_id: string | null;
  kind: string;
  name: string;
  size: number;
  mime: string;
  private: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  trashed_at: string | null;
}

const toNode = (r: Row): FileNode => ({
  id: r.id,
  parentId: r.parent_id,
  kind: r.kind === "carpeta" ? "carpeta" : "archivo",
  name: r.name,
  size: r.size,
  mime: r.mime,
  private: r.private === 1,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  trashedAt: r.trashed_at,
});

// ───────────── Disco ─────────────

/** Carpeta raíz de Archivos: ORDEN_FILES_DIR o «archivos» junto a la BD (dentro de data/). */
export function filesRoot(): string {
  return path.resolve(process.env.ORDEN_FILES_DIR ?? path.join(path.dirname(dbPath()), "archivos"));
}

/** Ruta en disco del contenido de un archivo. Solo ids UUID y siempre dentro de la raíz. */
export function blobPath(id: string): string {
  if (!isUuid(id)) throw new Error("Identificador de archivo no válido.");
  const root = filesRoot();
  const file = path.join(/*turbopackIgnore: true*/ root, "blobs", id.toLowerCase());
  if (!isInside(root, file)) throw new Error("Ruta fuera de la carpeta de archivos.");
  return file;
}

export function readFileData(id: string): Buffer {
  const node = getNode(id);
  if (!node || node.kind !== "archivo") throw new Error("Ese archivo no existe.");
  return fs.readFileSync(blobPath(id));
}

// ───────────── Lectura del árbol ─────────────

function allNodes(): FileNode[] {
  return (getDb().prepare("SELECT * FROM file_nodes ORDER BY kind DESC, name COLLATE NOCASE").all() as unknown as Row[]).map(toNode);
}

export function getNode(id: string): FileNode | null {
  const row = getDb().prepare("SELECT * FROM file_nodes WHERE id = ?").get(id) as unknown as Row | undefined;
  return row ? toNode(row) : null;
}

/** Índice del árbol para recorrer antepasados sin ir a la BD en bucle. */
export class FileTree {
  readonly nodes: FileNode[];
  readonly byId: Map<string, FileNode>;
  constructor(nodes = allNodes()) {
    this.nodes = nodes;
    this.byId = new Map(nodes.map((n) => [n.id, n]));
  }
  /** Antepasados de un nodo, del padre hacia la raíz. */
  ancestors(node: FileNode): FileNode[] {
    const out: FileNode[] = [];
    const seen = new Set<string>([node.id]);
    let p = node.parentId ? this.byId.get(node.parentId) : undefined;
    while (p && !seen.has(p.id)) {
      out.push(p);
      seen.add(p.id);
      p = p.parentId ? this.byId.get(p.parentId) : undefined;
    }
    return out;
  }
  /** En uso: ni él ni ningún antepasado está en la papelera. */
  isLive(node: FileNode): boolean {
    return !node.trashedAt && this.ancestors(node).every((a) => !a.trashedAt);
  }
  live(): FileNode[] {
    return this.nodes.filter((n) => this.isLive(n));
  }
  children(parentId: string | null): FileNode[] {
    return this.nodes.filter((n) => n.parentId === parentId && !n.trashedAt);
  }
  /** Él y todo lo que cuelga de él. */
  subtree(id: string): FileNode[] {
    const out: FileNode[] = [];
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      const n = this.byId.get(cur);
      if (!n) continue;
      out.push(n);
      for (const c of this.nodes) if (c.parentId === cur) stack.push(c.id);
    }
    return out;
  }
  /** «Finanzas/Nóminas/nomina.pdf». */
  pathOf(node: FileNode): string {
    return [...this.ancestors(node).reverse(), node].map((n) => n.name).join("/");
  }
  /** Carpeta privada él o alguno de sus antepasados. */
  isPrivate(node: FileNode): boolean {
    return [node, ...this.ancestors(node)].some((n) => n.kind === "carpeta" && n.private);
  }
}

export function pathOf(id: string): string {
  const t = new FileTree();
  const n = t.byId.get(id);
  return n ? t.pathOf(n) : "";
}

export function listLiveNodes(): FileNode[] {
  return new FileTree().live();
}

/** Lo que hay en la papelera (solo lo de arriba: lo que cuelga va con ello). */
export function listTrash(): (FileNode & { path: string; items: number })[] {
  const t = new FileTree();
  return t.nodes
    .filter((n) => n.trashedAt && t.ancestors(n).every((a) => !a.trashedAt))
    .map((n) => ({ ...n, path: t.pathOf(n), items: t.subtree(n.id).length - 1 }))
    .sort((a, b) => b.trashedAt!.localeCompare(a.trashedAt!));
}

// ───────────── Cambios ─────────────

function changed(data: Record<string, unknown> = {}) {
  emit("files.updated", data);
}

function liveFolder(t: FileTree, id: string | null): FileNode | null {
  if (id === null) return null;
  const f = t.byId.get(id);
  if (!f || f.kind !== "carpeta" || !t.isLive(f)) throw new Error("Esa carpeta no existe.");
  return f;
}

function siblingTaken(t: FileTree, parentId: string | null, exceptId?: string) {
  const keys = new Set(t.children(parentId).filter((n) => n.id !== exceptId).map((n) => nameKey(n.name)));
  return (key: string) => keys.has(key);
}

function assertFree(t: FileTree, parentId: string | null, name: string, exceptId?: string) {
  if (siblingTaken(t, parentId, exceptId)(nameKey(name))) throw new Error(`Ya hay algo llamado «${name}» en esa carpeta.`);
}

/** Crea una carpeta. Privacidad: la que se diga, si no la del padre, y en la raíz privada (por seguridad). */
export function createFolder(input: { parentId: string | null; name: string; private?: boolean; by?: string | null }): FileNode {
  return tx(() => {
    const t = new FileTree();
    const parent = liveFolder(t, input.parentId);
    const name = cleanName(input.name);
    assertFree(t, input.parentId, name);
    const id = randomUUID();
    const ts = now();
    const priv = input.private ?? (parent ? parent.private : true);
    getDb()
      .prepare("INSERT INTO file_nodes (id, parent_id, kind, name, private, created_by, created_at, updated_at) VALUES (?, ?, 'carpeta', ?, ?, ?, ?, ?)")
      .run(id, input.parentId, name, priv ? 1 : 0, input.by ?? null, ts, ts);
    changed({ id });
    return getNode(id)!;
  });
}

/**
 * Guarda un archivo subido: valida tipo, firma y tamaño; si el nombre ya
 * existe en la carpeta lo numera («nomina (2).pdf»). Escritura atómica.
 */
export function saveFile(input: { parentId: string | null; name: string; data: Uint8Array; by?: string | null }): FileNode {
  const name = cleanName(path.basename(String(input.name ?? "").replace(/\\/g, "/")));
  const type = checkContent(name, input.data);
  const id = randomUUID();
  const file = blobPath(id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.subiendo`;
  fs.writeFileSync(tmp, input.data);
  try {
    return tx(() => {
      const t = new FileTree();
      liveFolder(t, input.parentId);
      const finalName = uniqueName(name, siblingTaken(t, input.parentId));
      fs.renameSync(tmp, file);
      const ts = now();
      getDb()
        .prepare("INSERT INTO file_nodes (id, parent_id, kind, name, size, mime, private, created_by, created_at, updated_at) VALUES (?, ?, 'archivo', ?, ?, ?, 0, ?, ?, ?)")
        .run(id, input.parentId, finalName, input.data.length, type.mime, input.by ?? null, ts, ts);
      changed({ id });
      return getNode(id)!;
    });
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    fs.rmSync(file, { force: true });
    throw err;
  }
}

export function renameNode(id: string, rawName: string): FileNode {
  return tx(() => {
    const t = new FileTree();
    const node = t.byId.get(id);
    if (!node || !t.isLive(node)) throw new Error("No existe.");
    const name = cleanName(rawName);
    if (node.kind === "archivo" && extensionOf(name) !== extensionOf(node.name)) {
      throw new Error("No se puede cambiar la extensión de un archivo.");
    }
    assertFree(t, node.parentId, name, id);
    getDb().prepare("UPDATE file_nodes SET name = ?, updated_at = ? WHERE id = ?").run(name, now(), id);
    changed({ id });
    return getNode(id)!;
  });
}

/** Mueve a otra carpeta (null = raíz). No se puede meter una carpeta dentro de sí misma. */
export function moveNode(id: string, parentId: string | null): FileNode {
  return tx(() => {
    const t = new FileTree();
    const node = t.byId.get(id);
    if (!node || !t.isLive(node)) throw new Error("No existe.");
    const target = liveFolder(t, parentId);
    if (target && (target.id === id || t.ancestors(target).some((a) => a.id === id))) {
      throw new Error("No se puede mover una carpeta dentro de sí misma.");
    }
    if (node.parentId === parentId) return node;
    assertFree(t, parentId, node.name, id);
    getDb().prepare("UPDATE file_nodes SET parent_id = ?, updated_at = ? WHERE id = ?").run(parentId, now(), id);
    changed({ id });
    return getNode(id)!;
  });
}

export function setFolderPrivate(id: string, priv: boolean): FileNode {
  const node = getNode(id);
  if (!node || node.kind !== "carpeta") throw new Error("Solo las carpetas pueden ser privadas o compartidas.");
  getDb().prepare("UPDATE file_nodes SET private = ?, updated_at = ? WHERE id = ?").run(priv ? 1 : 0, now(), id);
  changed({ id });
  return getNode(id)!;
}

/** A la papelera (lo que cuelga de una carpeta va con ella). */
export function trashNode(id: string): FileNode {
  const t = new FileTree();
  const node = t.byId.get(id);
  if (!node || !t.isLive(node)) throw new Error("No existe.");
  getDb().prepare("UPDATE file_nodes SET trashed_at = ? WHERE id = ?").run(now(), id);
  changed({ id });
  return getNode(id)!;
}

/** Recupera de la papelera: a su carpeta si sigue en uso; si no, a la raíz. Renombra si choca. */
export function restoreNode(id: string): FileNode {
  return tx(() => {
    const t = new FileTree();
    const node = t.byId.get(id);
    if (!node?.trashedAt) throw new Error("Eso no está en la papelera.");
    const parent = node.parentId ? t.byId.get(node.parentId) : undefined;
    const parentId = parent && t.isLive(parent) ? parent.id : null;
    const name = uniqueName(node.name, siblingTaken(t, parentId, id));
    getDb().prepare("UPDATE file_nodes SET trashed_at = NULL, parent_id = ?, name = ?, updated_at = ? WHERE id = ?").run(parentId, name, now(), id);
    changed({ id });
    return getNode(id)!;
  });
}

/** Borra para siempre algo de la papelera (y su contenido en disco). */
export function purgeNode(id: string) {
  const t = new FileTree();
  const node = t.byId.get(id);
  if (!node) throw new Error("No existe.");
  if (t.isLive(node)) throw new Error("Primero hay que mandarlo a la papelera.");
  const sub = t.subtree(id);
  getDb().prepare("DELETE FROM file_nodes WHERE id = ?").run(id); // ON DELETE CASCADE con lo de dentro
  for (const n of sub) if (n.kind === "archivo") fs.rmSync(blobPath(n.id), { force: true });
  changed({ id, deleted: true });
}

export function emptyTrash(): number {
  const items = listTrash();
  for (const n of items) purgeNode(n.id);
  return items.length;
}

// ───────────── Permisos de los agentes ─────────────

/** «todo»: también carpetas privadas. «compartido»: solo carpetas compartidas. */
export type FileAccess = "todo" | "compartido";

export function fileAccessOf(agent: Agent): FileAccess {
  if (agent.isChief) return "todo";
  const row = getDb().prepare("SELECT level FROM file_access WHERE agent_id = ?").get(agent.id) as { level: string } | undefined;
  return row?.level === "todo" ? "todo" : "compartido";
}

/** Ids de los agentes con acceso a todo (sin contar al jefe, que lo tiene siempre). */
export function listFullAccess(): string[] {
  return (getDb().prepare("SELECT agent_id FROM file_access WHERE level = 'todo'").all() as { agent_id: string }[]).map((r) => r.agent_id);
}

export function setFileAccess(agentId: string, level: "todo" | null) {
  const agent = getAgent(agentId);
  if (!agent) throw new Error("Ese agente no existe.");
  if (agent.isChief && !level) throw new Error(`${agent.name} es el jefe: siempre tiene acceso a todo.`);
  if (level) getDb().prepare("INSERT INTO file_access (agent_id, level) VALUES (?, ?) ON CONFLICT(agent_id) DO UPDATE SET level = excluded.level").run(agentId, level);
  else getDb().prepare("DELETE FROM file_access WHERE agent_id = ?").run(agentId);
  changed({ access: agentId });
}

/**
 * ¿Puede verlo este agente? Con acceso a todo, sí. Si no, solo lo que esté
 * dentro de carpetas compartidas (ni privadas ni en la raíz).
 */
export function visibleTo(t: FileTree, access: FileAccess, node: FileNode): boolean {
  if (!t.isLive(node)) return false;
  if (access === "todo") return true;
  if (node.kind === "archivo" && !node.parentId) return false;
  return !t.isPrivate(node);
}

/** ¿Hay alguna carpeta compartida? (si no, los agentes sin acceso a todo no necesitan herramientas). */
export function hasSharedFolders(): boolean {
  const t = new FileTree();
  return t.nodes.some((n) => n.kind === "carpeta" && visibleTo(t, "compartido", n));
}

/**
 * Busca por ruta («Finanzas/Nóminas/nomina.pdf»), por id o por id corto (8
 * caracteres), solo entre lo que el agente puede ver. Sin distinguir
 * mayúsculas ni tildes. Ruta vacía = raíz (null).
 */
export function resolveForAgent(t: FileTree, access: FileAccess, ref: string): FileNode | null {
  const raw = String(ref ?? "").trim();
  const byId = /^[0-9a-f-]{8,36}$/i.test(raw) ? t.nodes.find((n) => n.id === raw.toLowerCase() || (raw.length === 8 && n.id.startsWith(raw.toLowerCase()))) : undefined;
  if (byId) return visibleTo(t, access, byId) ? byId : null;
  const parts = splitVirtualPath(raw);
  if (!parts.length) return null;
  let parentId: string | null = null;
  let cur: FileNode | null = null;
  for (const part of parts) {
    const key = nameKey(part);
    cur = t.children(parentId).find((n) => nameKey(n.name) === key) ?? null;
    if (!cur) return null;
    parentId = cur.id;
  }
  return cur && visibleTo(t, access, cur) ? cur : null;
}

// ───────────── Escritura de agentes (solo «Daily») ─────────────

/** Única carpeta (de primer nivel) en la que un agente puede escribir. */
export const DAILY_FOLDER = "Daily";
/** Extensiones que un agente puede escribir: solo texto. */
export const WRITABLE_EXTENSIONS = ["md", "txt"];

/**
 * Interpreta la ruta de escritura de un agente: tiene que empezar por
 * «Daily/» y acabar en un archivo de texto. Sin extensión se añade «.md»
 * («Daily/resumen 2026-10-04» → «resumen 2026-10-04.md»).
 */
export function parseDailyPath(raw: string): { folders: string[]; name: string } {
  const parts = splitVirtualPath(raw);
  if (parts.length < 2 || nameKey(parts[0]) !== nameKey(DAILY_FOLDER)) {
    throw new Error(`Solo puedes escribir dentro de la carpeta «${DAILY_FOLDER}» (p. ej. «${DAILY_FOLDER}/resumen 2026-10-04.md»).`);
  }
  const folders = parts.slice(1, -1).map(cleanName);
  let name = cleanName(parts[parts.length - 1]);
  if (!FILE_TYPES[extensionOf(name)]) name = cleanName(`${name}.md`);
  if (!WRITABLE_EXTENSIONS.includes(extensionOf(name))) {
    throw new Error(`Solo se pueden escribir archivos de texto (${WRITABLE_EXTENSIONS.map((e) => `.${e}`).join(", ")}).`);
  }
  return { folders, name };
}

/** Sustituye el contenido de un archivo existente (escritura atómica: temporal + renombrar). */
export function updateFileContent(id: string, data: Uint8Array): FileNode {
  const t = new FileTree();
  const node = t.byId.get(id);
  if (!node || node.kind !== "archivo" || !t.isLive(node)) throw new Error("Ese archivo no existe.");
  const type = checkContent(node.name, data);
  const file = blobPath(id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.escribiendo`;
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  getDb().prepare("UPDATE file_nodes SET size = ?, mime = ?, updated_at = ? WHERE id = ?").run(data.length, type.mime, now(), id);
  changed({ id });
  return getNode(id)!;
}

/** Carpeta hija en uso con ese nombre; la crea si no existe. Si hay un archivo con ese nombre, error. */
function ensureChildFolder(parentId: string | null, name: string, by: string | null): FileNode {
  const t = new FileTree();
  const hit = t.children(parentId).find((n) => nameKey(n.name) === nameKey(name));
  if (hit && hit.kind !== "carpeta") throw new Error(`«${t.pathOf(hit)}» es un archivo, no una carpeta.`);
  return hit ?? createFolder({ parentId, name, by });
}

/**
 * Crea o actualiza un archivo de texto dentro de «Daily» (y subcarpetas),
 * creando las carpetas que falten (Daily nace privada, como toda carpeta de
 * primer nivel). Nunca borra, mueve ni renombra. Con `append`, añade al final.
 */
export function writeDailyFile(input: { path: string; content: string; append?: boolean; by?: string | null }): {
  node: FileNode;
  path: string;
  created: boolean;
} {
  const { folders, name } = parseDailyPath(input.path);
  const by = input.by ?? null;
  let folder = ensureChildFolder(null, DAILY_FOLDER, by);
  for (const f of folders) folder = ensureChildFolder(folder.id, f, by);
  const t = new FileTree();
  const existing = t.children(folder.id).find((n) => nameKey(n.name) === nameKey(name));
  if (existing && existing.kind !== "archivo") throw new Error(`«${t.pathOf(existing)}» es una carpeta.`);
  let node: FileNode;
  if (existing) {
    const prev = input.append ? readFileData(existing.id).toString("utf8") : "";
    const text = input.append && prev ? `${prev.replace(/\s+$/, "")}\n\n${input.content}` : input.content;
    node = updateFileContent(existing.id, Buffer.from(text, "utf8"));
  } else {
    node = saveFile({ parentId: folder.id, name, data: Buffer.from(input.content, "utf8"), by });
  }
  return { node, path: new FileTree().pathOf(node), created: !existing };
}

// ───────────── Carpetas iniciales ─────────────

const SEED_KEY = "archivos.iniciales";

/** Una sola vez: Finanzas (privada) con Nóminas y Extractos bancarios. */
export function ensureFilesSeed() {
  if (getSetting(SEED_KEY, false)) return;
  tx(() => {
    if (getSetting(SEED_KEY, false)) return;
    setSetting(SEED_KEY, true);
    const t = new FileTree();
    let fin = t.children(null).find((n) => n.kind === "carpeta" && nameKey(n.name) === "finanzas");
    if (!fin) fin = createFolder({ parentId: null, name: "Finanzas", private: true, by: "sistema" });
    const t2 = new FileTree();
    for (const name of ["Nóminas", "Extractos bancarios"]) {
      if (!t2.children(fin.id).some((n) => nameKey(n.name) === nameKey(name))) createFolder({ parentId: fin.id, name, by: "sistema" });
    }
  });
}
