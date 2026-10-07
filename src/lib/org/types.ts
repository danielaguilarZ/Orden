import type { ModelChoice } from "../types";

/** Tipos de la organización: unidades, puestos y cartera de trabajo. */

export type UnitKind = "direccion" | "departamento" | "empresa" | "personal";

export const UNIT_KINDS: UnitKind[] = ["direccion", "departamento", "empresa", "personal"];

export const UNIT_KIND_LABEL: Record<UnitKind, string> = {
  direccion: "Dirección",
  departamento: "Departamento (da servicio a todo el grupo)",
  empresa: "Empresa",
  personal: "Ámbito personal",
};

export interface Unit {
  id: string;
  name: string;
  kind: UnitKind;
  /** A qué se dedica: lo que necesita saber cualquier agente que trabaje para ella. */
  summary: string;
  /** Objetivos actuales: guían lo que el equipo se propone hacer por su cuenta. */
  goals: string;
  /** Zona del living (su planta); null si aún no tiene. */
  building: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRole {
  agentId: string;
  unitId: string | null;
  /** Cargo: «Abogada mercantil», «Responsable de producto»… */
  role: string;
  /** Funciones del puesto: de qué se ocupa sin que nadie se lo pida. */
  duties: string;
  /** Dirige su unidad: reparte trabajo a su equipo. */
  lead: boolean;
  /** No vuelve a planificar antes de esta fecha (se quedó sin ideas útiles). */
  planAfter: string | null;
}

export type BacklogStatus = "pendiente" | "en_curso" | "hecha" | "descartada";
export type BacklogSource = "usuario" | "agente" | "jefe" | "rutina";

export interface BacklogItem {
  id: string;
  agentId: string;
  unitId: string | null;
  title: string;
  detail: string;
  /** 1 alta, 2 media, 3 baja. */
  priority: 1 | 2 | 3;
  model: ModelChoice | null;
  status: BacklogStatus;
  source: BacklogSource;
  /** Agente que la propuso (null = el usuario). */
  createdBy: string | null;
  taskId: string | null;
  attempts: number;
  result: string;
  createdAt: string;
  updatedAt: string;
  doneAt: string | null;
}
