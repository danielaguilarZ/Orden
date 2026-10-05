"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, onEvent, useStore } from "@/client/store";
import type { FileNode } from "@/lib/files/repo";
import { Backdrop } from "./Backdrop";
import { PanelsTabs } from "./PanelsTabs";

/**
 * Archivos: árbol de carpetas a la izquierda y el contenido de la carpeta
 * abierta a la derecha. Se sube con el botón o arrastrando archivos (a la
 * lista o a una carpeta del árbol) y se mueve arrastrando filas al árbol.
 */

interface Data {
  nodes: FileNode[];
  fullAccess: string[];
  maxBytes: number;
  extensions: string[];
}
type TrashItem = FileNode & { path: string; items: number };
type Modal =
  | { type: "carpeta" }
  | { type: "renombrar"; node: FileNode }
  | { type: "mover"; node: FileNode }
  | { type: "ver"; node: FileNode }
  | { type: "papelera" }
  | { type: "permisos" };
interface Upload {
  key: string;
  name: string;
  state: "subiendo" | "ok" | "error";
  error?: string;
}

const DRAG_TYPE = "application/x-orden-archivo";
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const PDF = /\.pdf$/i;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toLocaleString("es-ES", { maximumFractionDigits: 1 })} KB`;
  return `${(n / 1024 / 1024).toLocaleString("es-ES", { maximumFractionDigits: 1 })} MB`;
}
const formatDate = (iso: string) => new Date(iso).toLocaleString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
function iconOf(n: FileNode): string {
  if (n.kind === "carpeta") return n.private ? "🔒" : "📁";
  if (PDF.test(n.name)) return "📕";
  if (IMAGE.test(n.name)) return "🖼️";
  if (/\.(csv|tsv|xlsx)$/i.test(n.name)) return "📊";
  return "📄";
}

export function FilesPage() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [current, setCurrent] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState<Modal | null>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dropping, setDropping] = useState(false);
  const [sort, setSort] = useState<{ key: "nombre" | "tamaño" | "fecha"; asc: boolean }>({ key: "nombre", asc: true });
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(() => api<Data>("/api/files").then(setData, (e: Error) => setError(e.message)), []);
  useEffect(() => {
    load();
    return onEvent((e) => {
      if (e.type === "files.updated") load();
    });
  }, [load]);

  const byId = useMemo(() => new Map((data?.nodes ?? []).map((n) => [n.id, n])), [data]);
  const childrenOf = useCallback((id: string | null) => (data?.nodes ?? []).filter((n) => n.parentId === id), [data]);
  // Si la carpeta abierta desaparece (borrada, otra pestaña…), volver a la raíz.
  const folder = current ? (byId.get(current) ?? null) : null;
  useEffect(() => {
    if (data && current && !byId.has(current)) setCurrent(null);
  }, [data, current, byId]);

  const crumbs = useMemo(() => {
    const out: FileNode[] = [];
    let n = folder;
    while (n) {
      out.unshift(n);
      n = n.parentId ? (byId.get(n.parentId) ?? null) : null;
    }
    return out;
  }, [folder, byId]);
  const privateHere = crumbs.some((c) => c.private);

  const items = useMemo(() => {
    const list = childrenOf(current);
    const dir = sort.asc ? 1 : -1;
    return list.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "carpeta" ? -1 : 1;
      if (sort.key === "tamaño") return (a.size - b.size) * dir;
      if (sort.key === "fecha") return a.updatedAt.localeCompare(b.updatedAt) * dir;
      return a.name.localeCompare(b.name, "es", { numeric: true }) * dir;
    });
  }, [childrenOf, current, sort]);

  const run = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const openFolder = (id: string | null) => {
    setCurrent(id);
    if (id) {
      const next = new Set(open);
      let n = byId.get(id);
      while (n) {
        next.add(n.id);
        n = n.parentId ? byId.get(n.parentId) : undefined;
      }
      setOpen(next);
    }
  };

  const upload = async (files: File[], folderId: string | null) => {
    if (!data || !files.length) return;
    setError("");
    const batch = files.map((f, i) => ({ key: `${Date.now()}-${i}-${f.name}`, name: f.name, state: "subiendo" as const }));
    setUploads((u) => [...batch, ...u].slice(0, 30));
    for (const [i, f] of files.entries()) {
      const key = batch[i].key;
      const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
      let err = "";
      if (!data.extensions.includes(ext)) err = `Tipo no admitido (.${ext}).`;
      else if (f.size > data.maxBytes) err = `Supera el límite de ${formatBytes(data.maxBytes)}.`;
      else {
        try {
          const res = await fetch(`/api/files/upload?folder=${encodeURIComponent(folderId ?? "")}&name=${encodeURIComponent(f.name)}`, {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: f,
          });
          if (!res.ok) err = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Error ${res.status}`;
        } catch (e) {
          err = (e as Error).message;
        }
      }
      setUploads((u) => u.map((x) => (x.key === key ? { ...x, state: err ? "error" : "ok", error: err || undefined } : x)));
    }
    load();
  };

  /** Una carpeta (o la raíz) acepta archivos del PC y filas arrastradas desde la lista. */
  const dropProps = (folderId: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      const types = [...e.dataTransfer.types];
      if (!types.includes("Files") && !types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.stopPropagation();
      (e.currentTarget as HTMLElement).classList.add("drop-on");
    },
    onDragLeave: (e: React.DragEvent) => (e.currentTarget as HTMLElement).classList.remove("drop-on"),
    onDrop: (e: React.DragEvent) => {
      (e.currentTarget as HTMLElement).classList.remove("drop-on");
      const moved = e.dataTransfer.getData(DRAG_TYPE);
      if (!moved && !e.dataTransfer.files.length) return;
      e.preventDefault();
      e.stopPropagation();
      setDropping(false);
      if (moved) {
        if (moved !== folderId) run(() => api(`/api/files/${moved}`, { method: "PATCH", json: { parentId: folderId } }));
      } else upload([...e.dataTransfer.files], folderId);
    },
  });

  const dragRow = (n: FileNode) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData(DRAG_TYPE, n.id);
      e.dataTransfer.effectAllowed = "move";
    },
  });

  const remove = (n: FileNode) =>
    confirm(`¿Mandar «${n.name}» a la papelera?${n.kind === "carpeta" ? " Se va con todo lo que tiene dentro." : ""}`) &&
    run(() => api(`/api/files/${n.id}`, { method: "DELETE" }));

  const tree = (parentId: string | null, depth: number): React.ReactNode => (
    <ul className="files-tree-list">
      {childrenOf(parentId)
        .filter((n) => n.kind === "carpeta")
        .sort((a, b) => a.name.localeCompare(b.name, "es", { numeric: true }))
        .map((f) => {
          const hasKids = childrenOf(f.id).some((k) => k.kind === "carpeta");
          const isOpen = open.has(f.id);
          return (
            <li key={f.id}>
              <div className={`files-tree-item ${current === f.id ? "on" : ""}`} style={{ paddingLeft: 6 + depth * 14 }} {...dropProps(f.id)} {...dragRow(f)}>
                <button
                  className="files-caret"
                  aria-label={isOpen ? "Cerrar" : "Abrir"}
                  style={{ visibility: hasKids ? "visible" : "hidden" }}
                  onClick={() => {
                    const next = new Set(open);
                    if (isOpen) next.delete(f.id);
                    else next.add(f.id);
                    setOpen(next);
                  }}
                >
                  {isOpen ? "▾" : "▸"}
                </button>
                <button className="files-tree-name" onClick={() => openFolder(f.id)} title={f.private ? "Privada: solo la ven los agentes con acceso a todo" : "Compartida con todos los agentes"}>
                  <span aria-hidden>{iconOf(f)}</span> {f.name}
                </button>
              </div>
              {isOpen && hasKids && tree(f.id, depth + 1)}
            </li>
          );
        })}
    </ul>
  );

  return (
    <div className="board files">
      <div className="board-bar">
        <h1>Paneles</h1>
        <PanelsTabs active="archivos" />
        <span className="muted">Tus documentos, en carpetas. Los agentes con permiso pueden leerlos.</span>
        <span style={{ flex: 1 }} />
        <button className="btn ghost" onClick={() => setModal({ type: "permisos" })}>
          Permisos
        </button>
        <button className="btn ghost" onClick={() => setModal({ type: "papelera" })}>
          Papelera
        </button>
      </div>
      {error && <p className="bad-text">{error}</p>}
      {!data ? (
        <p className="muted">Cargando…</p>
      ) : (
        <div className="files-layout">
          <aside className="files-tree">
            <div className={`files-tree-item root ${current === null ? "on" : ""}`} {...dropProps(null)}>
              <button className="files-tree-name" onClick={() => openFolder(null)}>
                <span aria-hidden>🗂️</span> Archivos
              </button>
            </div>
            {tree(null, 0)}
          </aside>

          <section
            className="files-main"
            onDragEnter={(e) => [...e.dataTransfer.types].includes("Files") && setDropping(true)}
          >
            <div className="files-bar">
              <nav className="files-crumbs">
                <button onClick={() => openFolder(null)}>Archivos</button>
                {crumbs.map((c) => (
                  <span key={c.id}>
                    {" › "}
                    <button onClick={() => openFolder(c.id)}>{c.name}</button>
                  </span>
                ))}
                {folder && (
                  <span className={`tag ${privateHere ? "gold" : ""}`} title={privateHere ? "Solo la ven los agentes con acceso a todo" : "La ven todos los agentes"}>
                    {privateHere ? "Privada" : "Compartida"}
                  </span>
                )}
              </nav>
              <span style={{ flex: 1 }} />
              {folder && (
                <>
                  <label className="conn-toggle small" title="Privada: solo la ven Zen y los agentes con acceso a todo. Lo que cuelga de una carpeta privada también es privado.">
                    <input type="checkbox" checked={folder.private} onChange={(e) => run(() => api(`/api/files/${folder.id}`, { method: "PATCH", json: { private: e.target.checked } }))} />
                    Privada
                  </label>
                  <button className="btn small ghost" onClick={() => setModal({ type: "renombrar", node: folder })}>
                    Renombrar
                  </button>
                  <button className="btn small ghost" onClick={() => setModal({ type: "mover", node: folder })}>
                    Mover
                  </button>
                  <button className="btn small ghost danger" onClick={() => remove(folder)}>
                    Borrar
                  </button>
                </>
              )}
              <button className="btn small" onClick={() => setModal({ type: "carpeta" })}>
                + Carpeta
              </button>
              <button className="btn small primary" onClick={() => fileInput.current?.click()}>
                Subir archivos
              </button>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                accept={data.extensions.map((e) => `.${e}`).join(",")}
                onChange={(e) => {
                  upload([...(e.target.files ?? [])], current);
                  e.target.value = "";
                }}
              />
            </div>

            {uploads.length > 0 && (
              <div className="files-uploads">
                {uploads.map((u) => (
                  <span key={u.key} className={`files-upload ${u.state}`} title={u.error}>
                    {u.state === "subiendo" ? <span className="spinner" /> : u.state === "ok" ? "✓" : "✕"} {u.name}
                    {u.error && <small> · {u.error}</small>}
                  </span>
                ))}
                {uploads.every((u) => u.state !== "subiendo") && (
                  <button className="icon-btn small" title="Limpiar" onClick={() => setUploads([])}>
                    ×
                  </button>
                )}
              </div>
            )}

            {items.length === 0 ? (
              <div className="files-empty">
                <p>Esta carpeta está vacía.</p>
                <p className="muted small">
                  Arrastra aquí tus archivos o pulsa «Subir archivos». Se admiten {data.extensions.map((e) => `.${e}`).join(", ")} de hasta {formatBytes(data.maxBytes)}.
                </p>
              </div>
            ) : (
              <table className="files-table">
                <thead>
                  <tr>
                    {(["nombre", "tamaño", "fecha"] as const).map((k) => (
                      <th key={k} className={k === "nombre" ? "" : "num"}>
                        <button onClick={() => setSort({ key: k, asc: sort.key === k ? !sort.asc : k === "nombre" })}>
                          {k === "fecha" ? "Modificado" : k[0].toUpperCase() + k.slice(1)}
                          {sort.key === k ? (sort.asc ? " ▲" : " ▼") : ""}
                        </button>
                      </th>
                    ))}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {items.map((n) => (
                    <tr key={n.id} {...dragRow(n)} {...(n.kind === "carpeta" ? dropProps(n.id) : {})}>
                      <td>
                        <button
                          className="files-name"
                          onClick={() => (n.kind === "carpeta" ? openFolder(n.id) : setModal({ type: "ver", node: n }))}
                          title={n.kind === "carpeta" ? "Abrir" : "Ver"}
                        >
                          <span aria-hidden>{iconOf(n)}</span> {n.name}
                        </button>
                      </td>
                      <td className="num muted">{n.kind === "carpeta" ? `${childrenOf(n.id).length} elem.` : formatBytes(n.size)}</td>
                      <td className="num muted">{formatDate(n.updatedAt)}</td>
                      <td className="files-actions">
                        {n.kind === "archivo" && (
                          <>
                            <button className="icon-btn small" title="Ver" onClick={() => setModal({ type: "ver", node: n })}>
                              👁
                            </button>
                            <a className="icon-btn small" title="Descargar" href={`/api/files/${n.id}/content?download=1`}>
                              ⤓
                            </a>
                          </>
                        )}
                        <button className="icon-btn small" title="Renombrar" onClick={() => setModal({ type: "renombrar", node: n })}>
                          ✎
                        </button>
                        <button className="icon-btn small" title="Mover" onClick={() => setModal({ type: "mover", node: n })}>
                          ↦
                        </button>
                        <button className="icon-btn small" title="A la papelera" onClick={() => remove(n)}>
                          🗑
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {dropping && (
              <div
                className="files-drop"
                onDragLeave={(e) => e.currentTarget === e.target && setDropping(false)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  setDropping(false);
                  upload([...e.dataTransfer.files], current);
                }}
              >
                Suelta para subir a «{folder?.name ?? "Archivos"}»
              </div>
            )}
          </section>
        </div>
      )}

      {modal?.type === "carpeta" && (
        <NameModal
          title={`Nueva carpeta en «${folder?.name ?? "Archivos"}»`}
          initial=""
          hint={folder ? `Será ${privateHere ? "privada" : "compartida"}, como su carpeta.` : "Las carpetas de primer nivel empiezan privadas."}
          onClose={() => setModal(null)}
          onSave={(name) => run(() => api("/api/files", { method: "POST", json: { action: "carpeta", parentId: current, name } }))}
        />
      )}
      {modal?.type === "renombrar" && (
        <NameModal
          title="Renombrar"
          initial={modal.node.name}
          onClose={() => setModal(null)}
          onSave={(name) => run(() => api(`/api/files/${modal.node.id}`, { method: "PATCH", json: { name } }))}
        />
      )}
      {modal?.type === "mover" && data && (
        <MoveModal node={modal.node} nodes={data.nodes} onClose={() => setModal(null)} onMove={(parentId) => run(() => api(`/api/files/${modal.node.id}`, { method: "PATCH", json: { parentId } }))} />
      )}
      {modal?.type === "ver" && <Preview node={modal.node} onClose={() => setModal(null)} />}
      {modal?.type === "papelera" && <TrashModal onClose={() => setModal(null)} />}
      {modal?.type === "permisos" && data && <AccessModal fullAccess={data.fullAccess} onClose={() => setModal(null)} onChange={load} />}
    </div>
  );
}

function NameModal({ title, initial, hint, onClose, onSave }: { title: string; initial: string; hint?: string; onClose: () => void; onSave: (name: string) => Promise<unknown> }) {
  const [name, setName] = useState(initial);
  return (
    <Backdrop onClick={onClose}>
      <form
        className="modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          await onSave(name);
          onClose();
        }}
      >
        <header className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose}>
            ×
          </button>
        </header>
        <label className="form-col">
          Nombre
          <input autoFocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </label>
        {hint && <p className="muted small">{hint}</p>}
        <footer className="modal-foot">
          <button className="btn primary" disabled={!name.trim()}>
            Guardar
          </button>
        </footer>
      </form>
    </Backdrop>
  );
}

function MoveModal({ node, nodes, onClose, onMove }: { node: FileNode; nodes: FileNode[]; onClose: () => void; onMove: (parentId: string | null) => Promise<unknown> }) {
  // Carpetas destino: todas menos ella misma y lo que cuelga de ella.
  const options = useMemo(() => {
    const out: { id: string | null; label: string }[] = [{ id: null, label: "Archivos (raíz)" }];
    const walk = (parentId: string | null, depth: number) => {
      for (const f of nodes.filter((n) => n.parentId === parentId && n.kind === "carpeta").sort((a, b) => a.name.localeCompare(b.name, "es"))) {
        if (f.id === node.id) continue;
        out.push({ id: f.id, label: `${"  ".repeat(depth + 1)}${f.private ? "🔒" : "📁"} ${f.name}` });
        walk(f.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [nodes, node.id]);
  const [target, setTarget] = useState<string>(node.parentId ?? "");
  return (
    <Backdrop onClick={onClose}>
      <form
        className="modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault();
          await onMove(target || null);
          onClose();
        }}
      >
        <header className="modal-head">
          <h2>Mover «{node.name}»</h2>
          <button type="button" className="icon-btn" onClick={onClose}>
            ×
          </button>
        </header>
        <label className="form-col">
          A la carpeta
          <select value={target} onChange={(e) => setTarget(e.target.value)} size={Math.min(12, options.length)} className="files-move-select">
            {options.map((o) => (
              <option key={o.id ?? "raiz"} value={o.id ?? ""}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <p className="muted small">También puedes arrastrar cualquier fila a una carpeta del árbol.</p>
        <footer className="modal-foot">
          <button className="btn primary" disabled={(target || null) === node.parentId}>
            Mover
          </button>
        </footer>
      </form>
    </Backdrop>
  );
}

function Preview({ node, onClose }: { node: FileNode; onClose: () => void }) {
  const visual = PDF.test(node.name) || IMAGE.test(node.name);
  const [mode, setMode] = useState<"vista" | "texto">(visual ? "vista" : "texto");
  const [text, setText] = useState<{ text: string; label: string; detail: string; warning?: string; truncated?: boolean } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (mode !== "texto" || text) return;
    api<typeof text>(`/api/files/${node.id}/text`).then(setText, (e: Error) => setError(e.message));
  }, [mode, node.id, text]);
  const src = `/api/files/${node.id}/content`;
  return (
    <Backdrop onClick={onClose}>
      <div className="modal files-preview" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2 title={node.name}>{node.name}</h2>
          <div className="row">
            {PDF.test(node.name) && (
              <button className="btn small ghost" onClick={() => setMode(mode === "vista" ? "texto" : "vista")} title="Lo que leen los agentes">
                {mode === "vista" ? "Texto extraído" : "Ver PDF"}
              </button>
            )}
            <a className="btn small" href={`${src}?download=1`}>
              Descargar
            </a>
            <button className="icon-btn" onClick={onClose}>
              ×
            </button>
          </div>
        </header>
        {mode === "vista" && PDF.test(node.name) && <iframe className="files-frame" src={src} title={node.name} />}
        {mode === "vista" && IMAGE.test(node.name) && (
          <div className="files-image">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt={node.name} />
          </div>
        )}
        {mode === "texto" && (
          <>
            {error && <p className="bad-text">{error}</p>}
            {!text && !error && <p className="muted">Leyendo…</p>}
            {text && (
              <>
                <p className="muted small">
                  {text.label}
                  {text.detail ? ` · ${text.detail}` : ""} · así lo leen los agentes
                  {text.truncated ? " · (vista recortada)" : ""}
                </p>
                {text.warning && <p className="bad-text small">{text.warning}</p>}
                <pre className="files-text">{text.text || "(sin texto)"}</pre>
              </>
            )}
          </>
        )}
      </div>
    </Backdrop>
  );
}

function TrashModal({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const load = useCallback(() => api<{ items: TrashItem[] }>("/api/files?trash=1").then((r) => setItems(r.items)), []);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <Backdrop onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>Papelera de archivos</h2>
          <button className="icon-btn" onClick={onClose}>
            ×
          </button>
        </header>
        {items?.length === 0 && <p className="muted">Vacía.</p>}
        <ul className="versions">
          {items?.map((n) => (
            <li key={n.id}>
              <div>
                <strong>
                  {iconOf(n)} {n.name}
                </strong>
                <small>
                  {n.path} · {n.kind === "carpeta" ? `${n.items} elem. dentro` : formatBytes(n.size)} · borrado {formatDate(n.trashedAt!)}
                </small>
              </div>
              <div className="row">
                <button className="btn small" onClick={() => api(`/api/files/${n.id}`, { method: "POST", json: { action: "recuperar" } }).then(load)}>
                  Recuperar
                </button>
                <button className="btn danger small" onClick={() => confirm(`¿Borrar «${n.name}» para siempre?`) && api(`/api/files/${n.id}?forever=1`, { method: "DELETE" }).then(load)}>
                  Borrar
                </button>
              </div>
            </li>
          ))}
        </ul>
        {Boolean(items?.length) && (
          <footer className="modal-foot">
            <button
              className="btn danger"
              onClick={() => confirm("¿Vaciar la papelera? Se borra todo para siempre.") && api("/api/files", { method: "POST", json: { action: "vaciar_papelera" } }).then(load)}
            >
              Vaciar papelera
            </button>
          </footer>
        )}
      </div>
    </Backdrop>
  );
}

function AccessModal({ fullAccess, onClose, onChange }: { fullAccess: string[]; onClose: () => void; onChange: () => void }) {
  const agents = useStore((s) => s.agents);
  const [error, setError] = useState("");
  const toggle = async (agentId: string, todo: boolean) => {
    setError("");
    try {
      await api("/api/files", { method: "POST", json: { action: "acceso", agentId, todo } });
      onChange();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Backdrop onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>Permisos de archivos</h2>
          <button className="icon-btn" onClick={onClose}>
            ×
          </button>
        </header>
        <p className="muted small">
          Los agentes solo pueden <strong>leer</strong> (listar, buscar y leer el contenido). Con «acceso a todo» ven también las carpetas privadas; el resto
          solo ve las carpetas compartidas. Las carpetas nuevas de primer nivel empiezan privadas.
        </p>
        {error && <p className="bad-text">{error}</p>}
        <table className="conn-grants">
          <tbody>
            {agents.map((a) => (
              <tr key={a.id}>
                <td>
                  <strong>{a.name}</strong> <span className="muted small">{a.specialty}</span>
                </td>
                <td>
                  <label className="conn-toggle">
                    <input type="checkbox" checked={a.isChief || fullAccess.includes(a.id)} disabled={a.isChief} onChange={(e) => toggle(a.id, e.target.checked)} />
                    {a.isChief ? "Todo (jefe)" : "Acceso a todo"}
                  </label>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Backdrop>
  );
}
