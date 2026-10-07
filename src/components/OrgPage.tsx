"use client";

import { useState } from "react";
import { api, useStore } from "@/client/store";
import { useOrg } from "@/client/org";
import { UNIT_KINDS, UNIT_KIND_LABEL, type Unit, type UnitKind } from "@/lib/org/types";
import type { Agent } from "@/lib/types";
import { AvatarPreview } from "./AvatarPreview";
import { AgentDrawer } from "./AgentDrawer";
import { Chip, EmptyState, PageHeader, Section } from "./ui/kit";

const KIND_SHORT: Record<UnitKind, string> = { direccion: "Dirección", departamento: "Departamento", empresa: "Empresa", personal: "Personal" };

/** Organigrama: unidades, quién trabaja en cada una y en qué está. */
export function OrgPage() {
  const agents = useStore((s) => s.agents);
  const [org] = useOrg();
  const [editing, setEditing] = useState<Partial<Unit> | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  if (!org) return <div className="board org-page muted center">Cargando…</div>;

  const roleOf = (a: Agent) => org.roles.find((r) => r.agentId === a.id);
  const membersOf = (unitId: string | null) => agents.filter((a) => (roleOf(a)?.unitId ?? null) === unitId);
  const unassigned = membersOf(null);
  const selectedAgent = agents.find((a) => a.id === selected);
  const { settings, verdict } = org.autopilot;

  return (
    <div className="board org-page">
      <div className="ui-page">
        <PageHeader
          title="Organización"
          count={org.units.length}
          subtitle={`${settings.enabled ? (verdict.allowed ? "🤖 Piloto automático trabajando" : `🤖 Piloto en pausa: ${verdict.reason}`) : "🤖 Piloto automático apagado (actívalo arriba a la derecha)"}`}
        >
          <button className="btn primary" onClick={() => setEditing({ kind: "empresa" })}>
            + Unidad
          </button>
        </PageHeader>

        {editing && <UnitForm draft={editing} onClose={() => setEditing(null)} />}

        {org.units.length === 0 && !editing && (
          <EmptyState icon="🏢" title="Aún no hay organización">
            Crea la dirección, los departamentos que dan servicio a todo el grupo y una unidad por empresa. Después, en la pestaña «Puesto» de cada agente, dile dónde trabaja y de qué se ocupa.
          </EmptyState>
        )}

        <div className="org-units">
          {org.units.map((u) => {
            const members = membersOf(u.id);
            return (
              <Section
                key={u.id}
                icon={u.kind === "direccion" ? "🏛️" : u.kind === "departamento" ? "🧩" : u.kind === "personal" ? "🏠" : "🏢"}
                title={u.name}
                count={members.length}
                hint={KIND_SHORT[u.kind]}
                actions={
                  <button className="btn small ghost" onClick={() => setEditing(u)}>
                    ✎ Editar
                  </button>
                }
              >
                {u.summary && <p className="ui-detail">{u.summary}</p>}
                {u.goals && (
                  <p className="ui-detail">
                    <strong>Objetivos:</strong> {u.goals}
                  </p>
                )}
                <MemberList agents={members} org={org} onPick={setSelected} />
              </Section>
            );
          })}
          {unassigned.length > 0 && org.units.length > 0 && (
            <Section icon="❔" title="Sin unidad" count={unassigned.length} hint="No trabajan solos hasta que tengan puesto">
              <MemberList agents={unassigned} org={org} onPick={setSelected} />
            </Section>
          )}
        </div>
      </div>
      {selectedAgent && <AgentDrawer agent={selectedAgent} onClose={() => setSelected(null)} />}
    </div>
  );
}

function MemberList({ agents, org, onPick }: { agents: Agent[]; org: NonNullable<ReturnType<typeof useOrg>[0]>; onPick: (id: string) => void }) {
  if (!agents.length) return <p className="muted small">Nadie trabaja aquí todavía.</p>;
  return (
    <ul className="org-members">
      {agents.map((a) => {
        const role = org.roles.find((r) => r.agentId === a.id);
        const items = org.backlog.filter((i) => i.agentId === a.id);
        const now = items.find((i) => i.status === "en_curso");
        const pending = items.filter((i) => i.status === "pendiente").length;
        return (
          <li key={a.id}>
            <button className="org-member" onClick={() => onPick(a.id)}>
              <AvatarPreview appearance={a.appearance} scale={2} />
              <span className="org-member-text">
                <strong>
                  {a.name} {role?.lead && <Chip tone="accent">Dirige</Chip>}
                </strong>
                <span className="muted small">{role?.role || a.specialty || "Sin cargo"}</span>
                <span className="small">{now ? `▶ ${now.title}` : a.status === "working" ? `▶ ${a.statusText || "Trabajando"}` : pending ? `${pending} tarea(s) en cartera` : "Sin trabajo pendiente"}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function UnitForm({ draft, onClose }: { draft: Partial<Unit>; onClose: () => void }) {
  const [name, setName] = useState(draft.name ?? "");
  const [kind, setKind] = useState<UnitKind>(draft.kind ?? "empresa");
  const [summary, setSummary] = useState(draft.summary ?? "");
  const [goals, setGoals] = useState(draft.goals ?? "");
  const [error, setError] = useState("");
  const save = () => {
    const json = { name, kind, summary, goals };
    (draft.id ? api(`/api/org/units/${draft.id}`, { method: "PATCH", json }) : api("/api/org", { method: "POST", json })).then(onClose).catch((e: Error) => setError(e.message));
  };
  return (
    <form
      className="unit-form ui-card open"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div className="row">
        <label>
          Nombre
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Mi empresa" required minLength={2} maxLength={60} autoFocus />
        </label>
        <label>
          Tipo
          <select value={kind} onChange={(e) => setKind(e.target.value as UnitKind)}>
            {UNIT_KINDS.map((k) => (
              <option key={k} value={k}>
                {UNIT_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        A qué se dedica
        <textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={3} placeholder="Lo que necesita saber cualquier agente que trabaje para esta unidad" />
      </label>
      <label>
        Objetivos actuales
        <textarea value={goals} onChange={(e) => setGoals(e.target.value)} rows={2} placeholder="Guían lo que el equipo se propone hacer por su cuenta" />
      </label>
      {error && <p className="bad-text small">{error}</p>}
      <div className="row">
        {draft.id && (
          <button type="button" className="btn small ghost" onClick={() => confirm(`¿Borrar la unidad «${draft.name}»? Sus agentes quedan sin unidad.`) && api(`/api/org/units/${draft.id}`, { method: "DELETE" }).then(onClose)}>
            Borrar
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button type="button" className="btn ghost" onClick={onClose}>
          Cancelar
        </button>
        <button className="btn primary">{draft.id ? "Guardar" : "Crear unidad"}</button>
      </div>
    </form>
  );
}
