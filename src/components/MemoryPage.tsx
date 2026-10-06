"use client";

import { Backdrop } from "./Backdrop";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, onEvent, useStore } from "@/client/store";
import { MEMORY_CATEGORIES } from "@/lib/memory/categories";
import { countByCategory, filterMemory, groupMemory, memoryCategories, type CategoryInfo } from "@/lib/memory/view";
import { plural, relativeDate, summarize } from "@/lib/ui/text";
import type { MemoryEntry, MemoryVersion } from "@/lib/repo/memory";
import { useFresh } from "./ui/hooks";
import { Card, Chip, EmptyState, FilterChips, PageHeader, SearchBox, Section, Toolbar, useToggleSet } from "./ui/kit";

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

const blank = (category = "quien_soy"): Draft => ({ category, title: "", content: "", tags: "" });

/**
 * Pestaña «Memoria»: recuerdos como tarjetas cortas agrupadas por categoría
 * (plegables), con buscador y filtro. El detalle completo se abre al pulsar.
 */
export function MemoryPage() {
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [trash, setTrash] = useState(false);
  const [openId, setOpenId] = useState("");
  const [editing, setEditing] = useState<Draft | null>(null);
  const [history, setHistory] = useState<MemoryEntry | null>(null);
  const [folded, toggleFold] = useToggleSet("orden.memoria.plegadas");
  const agents = useStore((s) => s.agents);
  const fresh = useFresh((entries ?? []).map((e) => `${e.id}:${e.version}`));

  const load = useCallback(() => {
    api<MemoryEntry[]>(`/api/memory${trash ? "?archived=1" : ""}`).then(setEntries);
  }, [trash]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => onEvent((e) => e.type.startsWith("memory.") && load()), [load]);

  const all = useMemo(() => entries ?? [], [entries]);
  const cats = useMemo(() => memoryCategories(all), [all]);
  const counts = useMemo(() => countByCategory(all), [all]);
  const shown = useMemo(() => filterMemory(all, query, category, cats), [all, query, category, cats]);
  const groups = useMemo(() => groupMemory(shown, cats), [shown, cats]);
  const searching = Boolean(query.trim() || category);
  const emptyCats = cats.filter((c) => !counts[c.key] && MEMORY_CATEGORIES.some((m) => m.key === c.key));
  const who = (by: string) => (by === "user" ? "ti" : (agents.find((a) => a.id === by)?.name ?? "un agente"));

  return (
    <div className="board memory">
      <div className="ui-page">
        <PageHeader
          title={trash ? "Olvidados" : "Memoria"}
          count={entries ? all.length : undefined}
          subtitle={trash ? "Recuerdos archivados. Puedes recuperarlos." : "Lo que el equipo sabe de ti. Todos lo consultan y lo amplían."}
        >
          <button
            className={`btn ${trash ? "" : "ghost"}`}
            onClick={() => {
              setTrash((t) => !t);
              setOpenId("");
              setCategory("");
            }}
          >
            {trash ? "← Volver" : "Olvidados"}
          </button>
          {!trash && (
            <button className="btn primary" onClick={() => setEditing(blank())}>
              + Recuerdo
            </button>
          )}
        </PageHeader>

        {all.length > 0 && (
          <Toolbar>
            <SearchBox value={query} onChange={setQuery} placeholder="Buscar en la memoria…" />
            <FilterChips
              label="Filtrar por categoría"
              value={category}
              onChange={(k) => setCategory(k === category ? "" : k)}
              options={[{ key: "", label: "Todas", count: all.length }, ...cats.filter((c) => counts[c.key]).map((c) => ({ key: c.key, label: c.label, icon: c.icon, count: counts[c.key] }))]}
            />
          </Toolbar>
        )}

        {!entries && <p className="muted">Cargando…</p>}

        {entries && all.length === 0 && (
          <EmptyState
            icon={trash ? "🗑️" : "🧠"}
            title={trash ? "No hay nada olvidado" : "La memoria está vacía"}
            action={
              !trash && (
                <button className="btn primary" onClick={() => setEditing(blank())}>
                  Añadir lo básico sobre mí
                </button>
              )
            }
          >
            {trash ? "Lo que olvides aparecerá aquí por si quieres recuperarlo." : "Cuéntale a Zen quién eres o añade un recuerdo: todo el equipo lo tendrá en cuenta."}
          </EmptyState>
        )}

        {all.length > 0 && groups.length === 0 && (
          <EmptyState icon="🔍" title="Nada coincide">
            Prueba con otra palabra o quita el filtro.{" "}
            <button
              className="ui-link"
              onClick={() => {
                setQuery("");
                setCategory("");
              }}
            >
              Ver todo
            </button>
          </EmptyState>
        )}

        {groups.map(({ cat, entries: list }) => {
          const open = searching || !folded.has(cat.key);
          return (
            <Section
              key={cat.key}
              icon={cat.icon}
              title={cat.label}
              count={list.length}
              hint={cat.hint}
              open={open}
              onToggle={searching ? undefined : () => toggleFold(cat.key)}
              actions={
                !trash && (
                  <button className="icon-btn small" title={`Añadir a ${cat.label}`} onClick={() => setEditing(blank(cat.key))}>
                    +
                  </button>
                )
              }
            >
              <div className="ui-cards">
                {list.map((e) => (
                  <MemoryCard
                    key={e.id}
                    e={e}
                    cat={cat}
                    trash={trash}
                    who={who}
                    open={openId === e.id}
                    fresh={fresh.has(`${e.id}:${e.version}`)}
                    onToggle={() => setOpenId(openId === e.id ? "" : e.id)}
                    onEdit={() => setEditing({ id: e.id, category: e.category, title: e.title, content: e.content, tags: e.tags.join(", ") })}
                    onHistory={() => setHistory(e)}
                  />
                ))}
              </div>
            </Section>
          );
        })}

        {!trash && !searching && all.length > 0 && emptyCats.length > 0 && (
          <div className="memory-empty-cats">
            <span className="muted small">Sin recuerdos todavía:</span>
            {emptyCats.map((c) => (
              <button key={c.key} className="ui-filter" title={c.hint} onClick={() => setEditing(blank(c.key))}>
                <span aria-hidden>{c.icon}</span>
                {c.label}
                <span className="ui-filter-count">+</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {editing && <Editor draft={editing} onClose={() => setEditing(null)} />}
      {history && <History entry={history} onClose={() => setHistory(null)} />}
    </div>
  );
}

function MemoryCard({
  e,
  cat,
  trash,
  who,
  open,
  fresh,
  onToggle,
  onEdit,
  onHistory,
}: {
  e: MemoryEntry;
  cat: CategoryInfo;
  trash: boolean;
  who: (by: string) => string;
  open: boolean;
  fresh: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onHistory: () => void;
}) {
  const tags = open ? e.tags : e.tags.slice(0, 3);
  return (
    <Card
      className={fresh ? "fresh" : ""}
      title={e.title}
      summary={summarize(e.content, 110)}
      open={open}
      onToggle={onToggle}
      chips={
        <>
          {tags.map((t) => (
            <Chip key={t}>#{t}</Chip>
          ))}
          {!open && e.tags.length > 3 && <Chip>+{e.tags.length - 3}</Chip>}
        </>
      }
      meta={relativeDate(e.updatedAt)}
      actions={
        trash ? (
          <button className="btn small" onClick={() => api(`/api/memory/${e.id}`, { method: "PATCH", json: { archived: false } })}>
            Recuperar
          </button>
        ) : (
          <>
            <button className="btn small" onClick={onEdit}>
              ✎ Editar
            </button>
            <button className="btn small ghost" onClick={onHistory}>
              ⟲ Historial
            </button>
            <span style={{ flex: 1 }} />
            <button className="btn small ghost" title="Se puede recuperar desde «Olvidados»" onClick={() => api(`/api/memory/${e.id}`, { method: "DELETE" })}>
              Olvidar
            </button>
          </>
        )
      }
    >
      <p className="ui-detail">{e.content}</p>
      <p className="ui-facts">
        {cat.icon} {cat.label} · {e.source === "user" ? "Añadido" : "Guardado"} por {who(e.source)} · {new Date(e.updatedAt).toLocaleString("es-ES", { dateStyle: "medium", timeStyle: "short" })}
        {e.version > 1 && ` · ${plural(e.version, "versión", "versiones")}`}
      </p>
    </Card>
  );
}
