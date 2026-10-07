"use client";

import { useCallback, useEffect, useState } from "react";
import { api, onEvent } from "@/client/store";
import { MODEL_LABEL, PRIORITY_LABEL, useOrg } from "@/client/org";
import type { Agent, ModelChoice } from "@/lib/types";
import type { AgentRole, BacklogItem } from "@/lib/org/types";
import { Card, Chip, EmptyState, SectionHeader } from "./ui/kit";

const STATUS: Record<BacklogItem["status"], { label: string; tone?: "ok" | "info" | "off" }> = {
  en_curso: { label: "En marcha", tone: "info" },
  pendiente: { label: "Pendiente" },
  hecha: { label: "Hecha", tone: "ok" },
  descartada: { label: "Descartada", tone: "off" },
};

/** Pestaña «Puesto»: cargo, funciones y cartera de trabajo del agente. */
export function PuestoTab({ agent }: { agent: Agent }) {
  const [org] = useOrg();
  const [data, setData] = useState<{ role: AgentRole; backlog: BacklogItem[] } | null>(null);
  const [openId, setOpenId] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(() => api<{ role: AgentRole; backlog: BacklogItem[] }>(`/api/agents/${agent.id}/role`).then(setData), [agent.id]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => onEvent((e) => (e.type.startsWith("backlog.") || e.type.startsWith("role.")) && load()), [load]);

  const act = (p: Promise<unknown>) => p.catch((e: Error) => setError(e.message));
  if (!data || !org) return <div className="drawer-scroll muted center">Cargando…</div>;
  const open = data.backlog.filter((i) => i.status === "en_curso" || i.status === "pendiente");
  const done = data.backlog.filter((i) => i.status === "hecha" || i.status === "descartada").slice(0, 10);

  return (
    <div className="drawer-scroll puesto">
      <RoleForm key={`${agent.id}:${data.role.unitId}:${data.role.role}`} agent={agent} role={data.role} units={org.units} onError={setError} />

      <SectionHeader
        icon="🗂️"
        title="Cartera"
        count={open.length}
        hint={org.autopilot.settings.enabled ? "La trabaja solo con el piloto automático" : "Piloto automático apagado"}
        actions={
          <button className="btn primary small" onClick={() => setAdding(true)}>
            + Tarea
          </button>
        }
      />
      {adding && <ItemForm agent={agent} onClose={() => setAdding(false)} onError={setError} />}
      {open.length === 0 && !adding && (
        <EmptyState icon="🧭" title="Sin trabajo pendiente">
          {data.role.role || data.role.duties
            ? `Con el piloto automático, ${agent.name} planificará su siguiente trabajo según su puesto.`
            : `Dale un puesto a ${agent.name} para que trabaje por su cuenta.`}
        </EmptyState>
      )}
      <div className="ui-stack">
        {[...open, ...done].map((i) => {
          const isOpen = openId === i.id;
          const s = STATUS[i.status];
          const unit = i.unitId ? org.units.find((u) => u.id === i.unitId)?.name : null;
          return (
            <Card
              key={i.id}
              tone={i.status === "descartada" ? "off" : undefined}
              title={i.title}
              open={isOpen}
              onToggle={() => setOpenId(isOpen ? "" : i.id)}
              chips={
                <>
                  <Chip tone={s.tone}>{s.label}</Chip>
                  {i.status === "pendiente" && i.priority === 1 && <Chip tone="warn">Prioridad alta</Chip>}
                  {unit && <Chip>{unit}</Chip>}
                </>
              }
              actions={
                i.status === "pendiente" ? (
                  <>
                    <button className="btn small" onClick={() => act(api(`/api/backlog/${i.id}`, { method: "PATCH", json: { status: "hecha" } }))}>
                      ✓ Hecha
                    </button>
                    <button className="btn small ghost" onClick={() => act(api(`/api/backlog/${i.id}`, { method: "PATCH", json: { status: "descartada" } }))}>
                      Descartar
                    </button>
                    <span style={{ flex: 1 }} />
                    <button className="btn small ghost" onClick={() => confirm(`¿Eliminar «${i.title}»?`) && act(api(`/api/backlog/${i.id}`, { method: "DELETE" }))}>
                      Eliminar
                    </button>
                  </>
                ) : undefined
              }
            >
              {i.detail && <p className="ui-detail">{i.detail}</p>}
              {i.result && <p className="ui-detail result">↳ {i.result}</p>}
              <p className="ui-facts">
                {PRIORITY_LABEL[i.priority]} · {i.model ? MODEL_LABEL[i.model] : `modelo de ${agent.name}`} · {i.source === "usuario" ? "la pediste tú" : i.source === "jefe" ? "asignada por su responsable" : "iniciativa propia"}
                {i.attempts > 0 ? ` · ${i.attempts} intento(s) fallido(s)` : ""}
              </p>
            </Card>
          );
        })}
      </div>
      {error && <p className="bad-text small" style={{ padding: "0 16px" }}>{error}</p>}
    </div>
  );
}

function RoleForm({ agent, role, units, onError }: { agent: Agent; role: AgentRole; units: { id: string; name: string }[]; onError: (m: string) => void }) {
  const [unitId, setUnitId] = useState(role.unitId ?? "");
  const [cargo, setCargo] = useState(role.role);
  const [duties, setDuties] = useState(role.duties);
  const [lead, setLead] = useState(role.lead);
  const [saved, setSaved] = useState(false);
  const dirty = unitId !== (role.unitId ?? "") || cargo !== role.role || duties !== role.duties || lead !== role.lead;
  const save = () =>
    api(`/api/agents/${agent.id}/role`, { method: "PATCH", json: { unitId: unitId || null, role: cargo, duties, lead } })
      .then(() => setSaved(true))
      .catch((e: Error) => onError(e.message));
  return (
    <form
      className="role-form"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div className="row">
        <label>
          Unidad
          <select value={unitId} onChange={(e) => setUnitId(e.target.value)}>
            <option value="">— Sin unidad —</option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Cargo
          <input value={cargo} onChange={(e) => setCargo(e.target.value)} placeholder="Abogada mercantil" maxLength={80} />
        </label>
      </div>
      <label>
        Funciones
        <textarea value={duties} onChange={(e) => setDuties(e.target.value)} rows={4} placeholder="De qué se ocupa sin que nadie se lo pida: revisar contratos nuevos, vigilar plazos…" />
      </label>
      <div className="row">
        <label className="check">
          <input type="checkbox" checked={lead} onChange={(e) => setLead(e.target.checked)} /> Dirige su unidad (reparte trabajo a su equipo)
        </label>
        <button className="btn primary small" disabled={!dirty}>
          {saved && !dirty ? "Guardado" : "Guardar puesto"}
        </button>
      </div>
    </form>
  );
}

function ItemForm({ agent, onClose, onError }: { agent: Agent; onClose: () => void; onError: (m: string) => void }) {
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [priority, setPriority] = useState<1 | 2 | 3>(2);
  const [model, setModel] = useState<ModelChoice | "">("");
  return (
    <form
      className="item-form"
      onSubmit={(e) => {
        e.preventDefault();
        api(`/api/agents/${agent.id}/backlog`, { method: "POST", json: { title, detail, priority, model: model || null } })
          .then(onClose)
          .catch((err: Error) => onError(err.message));
      }}
    >
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Qué hay que hacer" autoFocus required minLength={3} maxLength={140} />
      <textarea value={detail} onChange={(e) => setDetail(e.target.value)} rows={3} placeholder="Detalles: con qué datos y qué entregable esperas" />
      <div className="row">
        <select value={priority} onChange={(e) => setPriority(Number(e.target.value) as 1 | 2 | 3)}>
          <option value={1}>Prioridad alta</option>
          <option value={2}>Prioridad media</option>
          <option value={3}>Prioridad baja</option>
        </select>
        <select value={model} onChange={(e) => setModel(e.target.value as ModelChoice | "")}>
          <option value="">Modelo de {agent.name}</option>
          <option value="haiku">Haiku (mecánico)</option>
          <option value="sonnet">Sonnet (normal)</option>
          <option value="opus">Opus (estratégico)</option>
        </select>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn small ghost" onClick={onClose}>
          Cancelar
        </button>
        <button className="btn primary small">Añadir</button>
      </div>
    </form>
  );
}
