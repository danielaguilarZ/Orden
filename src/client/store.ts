"use client";

import { useSyncExternalStore } from "react";
import type { Agent, AgentStatus, FurnitureItem, HeartbeatInfo, OrdenEvent, Room, RoomStyle } from "@/lib/types";
import type { ClaudeStatus } from "@/lib/claude/auth";
import type { Panel } from "@/lib/repo/panels";
import type { ClaudeUsage } from "@/lib/claude/usageText";

/**
 * Estado del cliente: se inicializa con la instantánea del servidor y se
 * mantiene al día con los eventos SSE.
 */
export interface ClientState {
  agents: Agent[];
  rooms: Room[];
  panels: Panel[];
  usage: ClaudeUsage | null;
  /** Decisiones pendientes de responder (contador de la pestaña). */
  decisionsPending: number;
  /** Último panel que tocó un agente (para el panel en vivo del living). */
  livePanel: { panelId: string; agentId: string; at: number } | null;
  worker: HeartbeatInfo | null;
  claude: ClaudeStatus | null;
  live: boolean;
  /** Orden se está reiniciando para cargar cambios de código. */
  restarting: string | null;
  lastEventId: number;
  /** Editor de sala abierto: sala y borrador de muebles y de suelo/paredes (se ven en el living antes de guardar). */
  roomEdit: { roomId: string; furniture: FurnitureItem[] | null; style?: RoomStyle | null; rename?: boolean } | null;
}

type Listener = () => void;
type EventHandler = (e: OrdenEvent) => void;

let state: ClientState = { agents: [], rooms: [], panels: [], usage: null, decisionsPending: 0, livePanel: null, worker: null, claude: null, live: false, restarting: null, lastEventId: 0, roomEdit: null };
const listeners = new Set<Listener>();
const eventHandlers = new Set<EventHandler>();

function set(patch: Partial<ClientState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function getState() {
  return state;
}

export function useStore<T>(selector: (s: ClientState) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => selector(state),
    () => selector(state),
  );
}

/** Suscribirse a todos los eventos en bruto (para paneles, chat…). */
export function onEvent(handler: EventHandler): () => void {
  eventHandlers.add(handler);
  return () => {
    eventHandlers.delete(handler);
  };
}

export function hydrate(init: {
  agents: Agent[];
  rooms: Room[];
  panels: Panel[];
  usage: ClaudeUsage | null;
  system: { worker: HeartbeatInfo | null };
  decisionsPending?: number;
  lastEventId: number;
}) {
  if (state.lastEventId > init.lastEventId) return;
  set({
    agents: init.agents,
    rooms: init.rooms,
    panels: init.panels,
    usage: init.usage,
    worker: init.system.worker,
    decisionsPending: init.decisionsPending ?? 0,
    lastEventId: init.lastEventId,
  });
}

function sortPanels(list: Panel[]) {
  return list.slice().sort((a, b) => (a.layout.order ?? 1e9) - (b.layout.order ?? 1e9) || b.updatedAt.localeCompare(a.updatedAt));
}

/** Cambio local inmediato de un panel (la confirmación llega por SSE). */
export function patchPanelLocal(panel: Panel) {
  set({ panels: sortPanels(upsert(state.panels, panel)) });
}

export function closeLivePanel() {
  set({ livePanel: null });
}

/** Abre el editor de una sala (o lo cierra con null). `rename`: empieza editando el nombre. */
export function openRoomEditor(roomId: string | null, opts: { rename?: boolean } = {}) {
  set({ roomEdit: roomId ? { roomId, furniture: null, ...(opts.rename && { rename: true }) } : null });
}

/** Mete o actualiza una sala sin esperar al evento (p. ej. recién creada). */
export function upsertRoom(room: Room) {
  set({ rooms: upsert(state.rooms, room) });
}

/** Quita una sala sin esperar al evento (p. ej. recién borrada). */
export function dropRoom(id: string) {
  set({ rooms: state.rooms.filter((r) => r.id !== id) });
}

/** Borrador del editor de sala: el living lo pinta en lugar de los muebles guardados. */
export function setRoomDraft(furniture: FurnitureItem[] | null) {
  if (state.roomEdit) set({ roomEdit: { ...state.roomEdit, furniture } });
}

/** Borrador de suelo y paredes: vista previa en el living antes de guardar. */
export function setRoomStyleDraft(style: RoomStyle | null) {
  if (state.roomEdit) set({ roomEdit: { ...state.roomEdit, style } });
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  const copy = list.slice();
  copy[i] = item;
  return copy;
}

function apply(e: OrdenEvent) {
  const p = e.payload as Record<string, unknown>;
  switch (e.type) {
    case "agent.created":
    case "agent.updated":
      set({ agents: upsert(state.agents, p as unknown as Agent) });
      break;
    case "agent.status":
      set({
        agents: state.agents.map((a) =>
          a.id === p.id ? { ...a, status: p.status as AgentStatus, statusText: String(p.statusText ?? "") } : a,
        ),
      });
      break;
    case "agent.deleted":
      set({ agents: state.agents.filter((a) => a.id !== p.id) });
      break;
    case "room.created":
    case "room.updated":
      set({ rooms: upsert(state.rooms, p as unknown as Room) });
      break;
    case "panel.created":
    case "panel.updated":
    case "panel.layout": {
      const panel = (p as { panel: Panel }).panel;
      const actor = (p as { actor?: { by: string } }).actor;
      set({
        panels: panel.archived ? state.panels.filter((x) => x.id !== panel.id) : sortPanels(upsert(state.panels, panel)),
        // Las actualizaciones automáticas («sistema», p. ej. Conexiones) no abren la ventana flotante.
        ...(actor && actor.by !== "user" && actor.by !== "sistema" && { livePanel: { panelId: panel.id, agentId: actor.by, at: Date.now() } }),
      });
      break;
    }
    case "panel.archived":
      set({ panels: state.panels.filter((x) => x.id !== (p as { panel: Panel }).panel.id) });
      break;
    case "panel.deleted":
      set({ panels: state.panels.filter((x) => x.id !== p.id) });
      break;
    case "panel.reordered": {
      const ids = p.ids as string[];
      set({ panels: sortPanels(state.panels.map((x) => ({ ...x, layout: { ...x.layout, order: ids.indexOf(x.id) < 0 ? 1e6 : ids.indexOf(x.id) } }))) });
      break;
    }
    case "system.restarting":
      set({ restarting: String(p.reason ?? "Actualización") });
      break;
    case "usage.updated":
      set({ usage: p as unknown as ClaudeUsage });
      break;
    case "decision.created":
    case "decision.updated":
      if (typeof p.pending === "number") set({ decisionsPending: p.pending });
      break;
    case "room.deleted":
      set({ rooms: state.rooms.filter((r) => r.id !== p.id), ...(state.roomEdit?.roomId === p.id && { roomEdit: null }) });
      break;
  }
  eventHandlers.forEach((h) => h(e));
}

let source: EventSource | null = null;

export function connect() {
  if (source) return;
  source = new EventSource(`/api/events?after=${state.lastEventId}`);
  source.onopen = () => {
    // Si veníamos de un reinicio, recargar trae la versión nueva de la interfaz.
    if (state.restarting) window.location.reload();
    set({ live: true });
  };
  source.onerror = () => set({ live: false });
  source.onmessage = (msg) => {
    const e = JSON.parse(msg.data) as OrdenEvent;
    if (e.id <= state.lastEventId) return;
    state = { ...state, lastEventId: e.id };
    apply(e);
  };
  source.addEventListener("system", (msg) => {
    const data = JSON.parse((msg as MessageEvent).data) as { worker: HeartbeatInfo | null };
    set({ worker: data.worker, live: true });
  });
}

export async function refreshClaude(force = false) {
  try {
    const res = await fetch(`/api/claude/status${force ? "?force=1" : ""}`);
    set({ claude: (await res.json()) as ClaudeStatus });
  } catch {
    // sin conexión con el servidor local
  }
}

export async function api<T = unknown>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Error ${res.status}`);
  return data as T;
}
