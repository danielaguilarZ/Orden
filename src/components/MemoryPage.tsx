"use client";

import { Backdrop } from "./Backdrop";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, onEvent, useStore } from "@/client/store";
import { MEMORY_CATEGORIES } from "@/lib/memory/categories";
import type { MemoryEntry, MemoryVersion } from "@/lib/repo/memory";
import { useFresh } from "./panels/common";

type Draft = { id?: string; category: string; title: string; content: string; tags: string };

function Editor({ draft, onClose }: { draft: Draft; onClose: () => void }) {
  const [d, setD] = useState(draft);
  const [error, setError] = useState("");
  return (
    <Backdrop onClick={onClose}>
      <form
        className="modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault();
          const payload = { category: d.category, title: d.title, content: d.content, tags: d.tags.split(",").map((t) => t.trim()).filter(Boolean) };
          try {
            if (d.id) await api(`/api/memory/${d.id}`, { method: "PATCH", json: payload });
            else await api("/api/memory", { method: "POST", json: payload });
            onClose();
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <header className="modal-head">
          <h2>{d.id ? "Editar recuerdo" : "Nuevo recuerdo"}</h2>
          <button type="button" className="icon-btn" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="form-col">
          <label>
            Categoría
            <select value={d.category} onChange={(e) => setD({ ...d, category: e.target.value })}>
              {MEMORY_CATEGORIES.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Título
            <input autoFocus value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} placeholder="Cumpleaños de Laura" />
          </label>
          <label>
            Contenido
            <textarea rows={4} value={d.content} onChange={(e) => setD({ ...d, content: e.target.value })} />
          </label>
          <label>
            Etiquetas (separadas por comas)
            <input value={d.tags} onChange={(e) => setD({ ...d, tags: e.target.value })} />
          </label>
        </div>
        {error && <p className="bad-text">{error}</p>}
        <footer className="modal-foot">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary">Guardar</button>
        </footer>
      </form>
    </Backdrop>
  );
}

function History({ entry, onClose }: { entry: MemoryEntry; onClose: () => void }) {
  const [versions, setVersions] = useState<MemoryVersion[] | null>(null);
  const agents = useStore((s) => s.agents);
  useEffect(() => {
    api<MemoryVersion[]>(`/api/memory/${entry.id}/versions`).then(setVersions);
  }, [entry.id, entry.version]);
  const who = (by: string) => (by === "user" ? "Tú" : (agents.find((a) => a.id === by)?.name ?? "Un agente"));
  return (
    <Backdrop onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>Historial de «{entry.title}»</h2>
          <button className="icon-btn" onClick={onClose}>
            ×
          </button>
        </header>
        {versions?.length === 0 && <p className="muted">Sin cambios anteriores.</p>}
        <ul className="versions">
          {versions?.map((v) => (
            <li key={v.id}>
              <div>
                <strong>v{v.version}</strong> · {new Date(v.createdAt).toLocaleString("es-ES")} · {v.reason} · por {who(v.actor)}
                <small className="pre">
                  {v.title}: {v.content}
                </small>
              </div>
              <button
                className="btn small"
                onClick={async () => {
                  await api(`/api/memory/${entry.id}/versions`, { method: "POST", json: { versionId: v.id } });
                  onClose();
                }}
              >
                Restaurar
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Backdrop>
  );
}

export function MemoryPage() {
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MemoryEntry[] | null>(null);
  const [trash, setTrash] = useState(false);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [history, setHistory] = useState<MemoryEntry | null>(null);
  const agents = useStore((s) => s.agents);
  const fresh = useFresh((entries ?? []).map((e) => `${e.id}:${e.version}`));

  const load = useCallback(() => {
    api<MemoryEntry[]>(`/api/memory${trash ? "?archived=1" : ""}`).then(setEntries);
  }, [trash]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => onEvent((e) => e.type.startsWith("memory.") && load()), [load]);

  useEffect(() => {
    if (!query.trim()) {
      setResults(null);
      return;
    }
    const t = setTimeout(() => api<MemoryEntry[]>(`/api/memory?q=${encodeURIComponent(query)}`).then(setResults), 250);
    return () => clearTimeout(t);
  }, [query, entries]);

  const shown = results ?? entries ?? [];
  const byCat = useMemo(() => {
    const m = new Map<string, MemoryEntry[]>();
    for (const e of shown) m.set(e.category, [...(m.get(e.category) ?? []), e]);
    return m;
  }, [shown]);
  const cats = [...MEMORY_CATEGORIES, ...[...byCat.keys()].filter((k) => !MEMORY_CATEGORIES.some((c) => c.key === k)).map((k) => ({ key: k, label: k, hint: "" }))];
  const who = (by: string) => (by === "user" ? "tú" : (agents.find((a) => a.id === by)?.name ?? "un agente"));

  return (
    <div className="board memory">
      <div className="board-bar">
        <h1>Memoria</h1>
        <span className="muted">Tu perfil de vida. Todos los agentes lo consultan y lo amplían.</span>
        <span style={{ flex: 1 }} />
        <input className="memory-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar…" />
        <button className={`btn ${trash ? "" : "ghost"}`} onClick={() => setTrash((t) => !t)}>
          {trash ? "Volver" : "Olvidados"}
        </button>
        {!trash && (
          <button className="btn primary" onClick={() => setEditing({ category: "quien_soy", title: "", content: "", tags: "" })}>
            + Recuerdo
          </button>
        )}
      </div>
      {entries && entries.length === 0 && !trash && (
        <div className="board-empty">
          <p>La memoria está vacía.</p>
          <p className="muted">Añade lo básico sobre ti (o cuéntaselo a Zen) y todo el equipo lo tendrá en cuenta.</p>
        </div>
      )}
      <div className="memory-grid">
        {cats
          .filter((c) => byCat.has(c.key) || (!results && !trash && entries && entries.length > 0))
          .map((c) => (
            <section key={c.key} className="memory-cat">
              <header>
                <h2>{c.label}</h2>
                <span className="muted small">{c.hint}</span>
                {!trash && (
                  <button className="icon-btn small" title="Añadir" onClick={() => setEditing({ category: c.key, title: "", content: "", tags: "" })}>
                    +
                  </button>
                )}
              </header>
              {(byCat.get(c.key) ?? []).map((e) => (
                <article key={e.id} className={`memory-item ${fresh.has(`${e.id}:${e.version}`) ? "fresh" : ""}`}>
                  <div className="memory-item-head">
                    <strong>{e.title}</strong>
                    <span className="memory-actions">
                      {trash ? (
                        <button className="btn small" onClick={() => api(`/api/memory/${e.id}`, { method: "PATCH", json: { archived: false } })}>
                          Recuperar
                        </button>
                      ) : (
                        <>
                          <button
                            className="icon-btn small"
                            title="Editar"
                            onClick={() => setEditing({ id: e.id, category: e.category, title: e.title, content: e.content, tags: e.tags.join(", ") })}
                          >
                            ✎
                          </button>
                          <button className="icon-btn small" title="Historial" onClick={() => setHistory(e)}>
                            ⟲
                          </button>
                          <button className="icon-btn small" title="Olvidar" onClick={() => api(`/api/memory/${e.id}`, { method: "DELETE" })}>
                            ×
                          </button>
                        </>
                      )}
                    </span>
                  </div>
                  <p>{e.content}</p>
                  <footer>
                    {e.tags.map((t) => (
                      <span key={t} className="tag">
                        {t}
                      </span>
                    ))}
                    <span className="muted small">
                      {e.source === "user" ? "Añadido" : "Guardado"} por {who(e.source)} · {new Date(e.updatedAt).toLocaleDateString("es-ES")}
                    </span>
                  </footer>
                </article>
              ))}
            </section>
          ))}
      </div>
      {editing && <Editor draft={editing} onClose={() => setEditing(null)} />}
      {history && <History entry={history} onClose={() => setHistory(null)} />}
    </div>
  );
}
