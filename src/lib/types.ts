/** Tipos de dominio compartidos por la web, el worker y el living. */

export type AgentStatus = "idle" | "working" | "waiting" | "sleeping" | "error";

export type ModelChoice = "haiku" | "sonnet" | "opus";

export interface Appearance {
  skin: string;
  hair: string;
  hairStyle: "corto" | "largo" | "moño" | "rapado" | "rizado" | "coleta";
  shirt: string;
  pants: string;
  shoes: string;
  accessory: "ninguno" | "gafas" | "barba" | "auriculares" | "gorro" | "pajarita";
}

export interface Personality {
  /** Clave de una personalidad predefinida (ver personalities.ts). */
  preset: string;
  /** Descripción libre del carácter, se añade al prompt. */
  description: string;
  /** Cómo habla: registro, muletillas, emojis… */
  voice: string;
}

export interface Agent {
  id: string;
  name: string;
  specialty: string;
  instructions: string;
  model: ModelChoice;
  personality: Personality;
  appearance: Appearance;
  /** Frases de ambiente: se muestran en bocadillos sin llamar al modelo. */
  ambient: string[];
  isChief: boolean;
  /** Puede modificar el código de Orden (en una copia aparte; el usuario aprueba). */
  admin: boolean;
  paused: boolean;
  status: AgentStatus;
  statusText: string;
  /**
   * Su sitio de referencia: su sala propia (agentes antiguos) o la sala común
   * donde tiene su escritorio asignado. Sin exclusividad: todas las salas son de todos.
   */
  roomId: string | null;
  /** Silla de su escritorio asignado (un mueble de la sala `roomId`); null si no tiene. */
  deskSeatId: string | null;
  /** Sala en la que está ahora (null = la suya). Puede ser cualquiera. */
  locationRoomId: string | null;
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FurnitureItem {
  id: string;
  /** Clave del catálogo de muebles (living/furniture.ts). */
  kind: string;
  /** Posición en baldosas, relativa a la esquina de la sala. */
  x: number;
  y: number;
  /** Elevación en píxeles (objetos encima de una mesa). */
  z?: number;
  /** Espejado horizontal (mirar hacia el otro lado). */
  flip?: boolean;
  /** Colores alternativos para personalizar el mueble. */
  tint?: Record<string, string>;
  /** Colocado a mano en el editor de sala (el decorador nunca mueve lo que ya está). */
  manual?: boolean;
}

export interface RoomStyle {
  floor: "madera" | "baldosa" | "moqueta" | "tatami" | "mármol" | "hormigón";
  floorA: string;
  floorB: string;
  wall: string;
  wallTrim: string;
}

export interface Room {
  id: string;
  name: string;
  /** Tema de la sala: despacho, finanzas, biblioteca, cocina… */
  kind: string;
  agentId: string | null;
  /** Zona (planta temática) a la que pertenece: «orden» (la oficina principal, por defecto) u otra de `BUILDINGS`. */
  building?: string;
  /**
   * Planta de la torre (0 = planta baja). Cada planta ocupa su propia franja
   * del plano: x incluye `level × LEVEL_STRIDE` (ver living/house.ts) y al
   * dibujarla se sube la altura de un piso (living/floors.ts).
   */
  level?: number;
  /** Posición y tamaño en baldosas dentro de la casa (plano lógico, con la franja de su planta). */
  x: number;
  y: number;
  w: number;
  d: number;
  style: RoomStyle;
  furniture: FurnitureItem[];
  /** Fecha en que se mandó a la papelera (solo en las salas archivadas). */
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrdenEvent<T = unknown> {
  id: number;
  type: string;
  payload: T;
  createdAt: string;
}

/** Quién hace un cambio guardado con historial: el usuario, el sistema o un agente dentro de un encargo. */
export interface Actor {
  by: string; // "user", "sistema" o id del agente
  taskId?: string | null;
}

export interface HeartbeatInfo {
  name: string;
  at: string;
  alive: boolean;
  info: Record<string, unknown>;
}

/** auto: trabajo que el piloto automático saca de la cartera del agente. */
export type TaskKind = "chat" | "delegation" | "routine" | "ambient" | "auto";
export type TaskStatus = "queued" | "running" | "waiting" | "done" | "error" | "cancelled";

export interface Task {
  id: string;
  agentId: string;
  parentId: string | null;
  conversationId: string | null;
  kind: TaskKind;
  title: string;
  prompt: string;
  status: TaskStatus;
  cancelRequested: boolean;
  result: string | null;
  error: string | null;
  /** 'user', 'routine:<id>' o el id del agente que lo encargó. */
  createdBy: string;
  data: Record<string, unknown>;
  /** Totales del mensaje `result` del SDK (nunca sumas parciales). */
  usage: TaskUsage | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface TaskUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  turns: number;
  durationMs: number;
}

export interface Conversation {
  id: string;
  agentId: string;
  title: string;
  sessionId: string | null;
  /** Huella del prompt de sistema con el que empezó la sesión. */
  promptHash: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export type MessageRole = "user" | "agent" | "tool" | "system";

export interface Message {
  id: string;
  conversationId: string;
  agentId: string | null;
  role: MessageRole;
  content: string;
  taskId: string | null;
  data: Record<string, unknown>;
  createdAt: string;
}
