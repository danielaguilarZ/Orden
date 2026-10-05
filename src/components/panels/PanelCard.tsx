"use client";

import { Backdrop } from "../Backdrop";
import { useEffect, useState } from "react";
import { api, useStore } from "@/client/store";
import { TYPE_INFO, typeName } from "@/lib/panels/templates";
import type { Panel, PanelVersion } from "@/lib/repo/panels";
import { InlineText, usePanelOps } from "./common";
import { formatsFor } from "@/lib/panels/export";
import { MoreMenu } from "./MoreMenu";
import { CalendarView } from "./CalendarView";
import { KanbanView } from "./KanbanView";
import { ListView } from "./ListView";
import { TableView } from "./TableView";
import { NotesView } from "./NotesView";
import { ChartView } from "./ChartView";
import { HabitsView } from "./HabitsView";

export const PANEL_ICONS: Record<string, string> = Object.fromEntries(Object.entries(TYPE_INFO).map(([k, v]) => [k, v.icon]));

/** Vista del contenido según el tipo. Añadir un tipo = añadir su vista aquí. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const VIEWS: Record<string, React.ComponentType<any>> = {
  calendario: CalendarView,
  kanban: KanbanView,
  lista: ListView,
  tabla: TableView,
  notas: NotesView,
  grafico: ChartView,
  habitos: HabitsView,
};

export function PanelBody({ panel, compact }: { panel: Panel; compact?: boolean }) {
  const { run, error } = usePanelOps(panel);
  const View = VIEWS[panel.type];
  return (
    <>
      {View ? <View panel={panel} run={run} compact={compact} /> : <pre>{JSON.stringify(panel.data, null, 2)}</pre>}
      {error && <p className="bad-text small">{error}</p>}
    </>
  );
}

function History({ panel, onClose }: { panel: Panel; onClose: () => void }) {
  const [versions, setVersions] = useState<PanelVersion[] | null>(null);
  const agents = useStore((s) => s.agents);
  useEffect(() => {
    api<PanelVersion[]>(`/api/panels/${panel.id}/versions`).then(setVersions);
  }, [panel.id, panel.version]);
  const who = (by: string) => (by === "user" ? "Tú" : by === "sistema" ? "Orden (automático)" : (agents.find((a) => a.id === by)?.name ?? "Un agente"));
  return (
    <Backdrop onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>Historial de «{panel.title}»</h2>
          <button className="icon-btn" onClick={onClose}>
            ×
          </button>
        </header>
        <p className="muted small">Cada fila es el estado ANTES de un cambio. Restaurar también se puede deshacer.</p>
        {!versions && <p className="muted">Cargando…</p>}
        {versions?.length === 0 && <p className="muted">Aún no hay versiones anteriores.</p>}
        <ul className="versions">
          {versions?.map((v) => (
            <li key={v.id}>
              <div>
                <strong>v{v.version}</strong> · {new Date(v.createdAt).toLocaleString("es-ES")}
                <small>
                  {v.reason} · por {who(v.actor)}
                </small>
              </div>
              <button
                className="btn small"
                onClick={async () => {
                  await api(`/api/panels/${panel.id}/versions`, { method: "POST", json: { versionId: v.id } });
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

function Ask({ panel, onClose }: { panel: Panel; onClose: () => void }) {
  const agents = useStore((s) => s.agents);
  const [agentId, setAgentId] = useState(panel.agentId ?? agents.find((a) => a.isChief)?.id ?? "");
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  return (
    <Backdrop onClick={onClose}>
      <form
        className="modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api(`/api/panels/${panel.id}/ask`, { method: "POST", json: { agentId, text } });
            setSent(true);
            setTimeout(onClose, 900);
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <header className="modal-head">
          <h2>Pedir cambios en «{panel.title}»</h2>
          <button type="button" className="icon-btn" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="form-col">
          <label>
            Agente
            <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} — {a.specialty}
                </option>
              ))}
            </select>
          </label>
          <label>
            ¿Qué quieres cambiar?
            <textarea autoFocus rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Mueve el dentista al jueves y añade la compra el sábado" />
          </label>
        </div>
        {error && <p className="bad-text">{error}</p>}
        <footer className="modal-foot">
          {sent && <span className="ok-text">Encargo enviado</span>}
          <button className="btn primary" disabled={!text.trim() || sent}>
            Encargar
          </button>
        </footer>
      </form>
    </Backdrop>
  );
}

const FORMAT_LABEL: Record<string, string> = { md: "Markdown (.md)", csv: "CSV (.csv)", xlsx: "Excel (.xlsx)", ics: "Calendario (.ics)" };

function ExportMenu({ panel, onClose }: { panel: Panel; onClose: () => void }) {
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  return (
    <Backdrop onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>Exportar «{panel.title}»</h2>
          <button className="icon-btn" onClick={onClose}>
            ×
          </button>
        </header>
        <ul className="versions">
          {formatsFor(panel.type).map((f) => (
            <li key={f}>
              <strong>{FORMAT_LABEL[f]}</strong>
              <div className="row">
                <a className="btn ghost small" href={`/api/panels/${panel.id}/export?format=${f}`} download>
                  Descargar
                </a>
                <button
                  className="btn small"
                  onClick={() =>
                    api<{ file: string }>(`/api/panels/${panel.id}/export`, { method: "POST", json: { format: f } })
                      .then((r) => setSaved(r.file))
                      .catch((e) => setError(e.message))
                  }
                >
                  Guardar en la carpeta
                </button>
              </div>
            </li>
          ))}
        </ul>
        {saved && (
          <p className="ok-text small">
            Guardado en <code>{saved}</code>{" "}
            <button className="btn ghost small" onClick={() => api("/api/exports", { method: "POST", json: { action: "open" } })}>
              Abrir carpeta
            </button>
          </p>
        )}
        {error && <p className="bad-text small">{error}</p>}
      </div>
    </Backdrop>
  );
}

const SIZES: NonNullable<Panel["layout"]["size"]>[] = ["normal", "ancho", "grande"];
const SIZE_LABEL: Record<NonNullable<Panel["layout"]["size"]>, string> = { normal: "normal", ancho: "ancho", alto: "alto", grande: "toda la fila" };

export function PanelCard({
  panel,
  compact,
  onExpand,
  dragHandle,
}: {
  panel: Panel;
  compact?: boolean;
  onExpand?: () => void;
  dragHandle?: React.HTMLAttributes<HTMLElement>;
}) {
  const agents = useStore((s) => s.agents);
  const [modal, setModal] = useState<"history" | "ask" | "export" | null>(null);
  const owner = agents.find((a) => a.id === panel.agentId);
  const busy = owner && owner.status === "working";
  const size = panel.layout.size ?? "normal";
  const nextSize = SIZES[(SIZES.indexOf(size) + 1) % SIZES.length];

  return (
    <article className={`panel-card size-${size} ${busy ? "busy" : ""}`} data-type={panel.type}>
      <header className="panel-head" {...dragHandle}>
        <span className="panel-icon">{PANEL_ICONS[panel.type] ?? "▢"}</span>
        <InlineText
          value={panel.title}
          className="panel-title"
          onSave={(title) => api(`/api/panels/${panel.id}`, { method: "PATCH", json: { title } })}
        />
        <span className="panel-meta">
          {typeName(panel.type)}
          {owner && ` · ${owner.name}`}
          {busy && <span className="live-dot" title={`${owner!.name} está trabajando`} />}
        </span>
        <div className="panel-actions">
          <button className="btn ghost small" onClick={() => setModal("ask")} title="Pide a un agente que lo cambie por ti">
            Pedir cambios
          </button>
          {!compact && (
            <MoreMenu
              items={[
                { label: "Exportar o descargar…", onClick: () => setModal("export") },
                { label: "Ver historial de cambios", onClick: () => setModal("history") },
                {
                  label: `Tamaño: ${SIZE_LABEL[size]} → ${SIZE_LABEL[nextSize]}`,
                  onClick: () => api(`/api/panels/${panel.id}`, { method: "PATCH", json: { layout: { size: nextSize } } }),
                },
                {
                  label: "Mover a la papelera",
                  danger: true,
                  onClick: () => confirm(`¿Mover «${panel.title}» a la papelera? Podrás recuperarlo.`) && api(`/api/panels/${panel.id}`, { method: "DELETE" }),
                },
              ]}
            />
          )}
          {onExpand && (
            <button className="icon-btn small" title="Abrir en grande" onClick={onExpand}>
              ↗
            </button>
          )}
        </div>
      </header>
      <div className="panel-body">
        <PanelBody panel={panel} compact={compact} />
      </div>
      {modal === "history" && <History panel={panel} onClose={() => setModal(null)} />}
      {modal === "ask" && <Ask panel={panel} onClose={() => setModal(null)} />}
      {modal === "export" && <ExportMenu panel={panel} onClose={() => setModal(null)} />}
    </article>
  );
}
