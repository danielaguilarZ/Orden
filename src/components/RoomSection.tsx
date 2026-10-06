"use client";

import { useState } from "react";
import { api, openDecor, useStore } from "@/client/store";
import { FURNITURE } from "@/living/furniture";
import { currentRoom, furnitureSummary, roomOwnerLabel, roomRelation } from "@/living/presence";
import type { Agent } from "@/lib/types";

/**
 * Salas desde la ficha del agente: dónde está (puede ir a cualquiera) y
 * decorar cualquier sala, no solo la suya. Por defecto, la sala en la que está.
 */
export function RoomSection({ agent }: { agent: Agent }) {
  const rooms = useStore((s) => s.rooms);
  const agents = useStore((s) => s.agents);
  const [chosen, setChosen] = useState<string | null>(null);
  const [kind, setKind] = useState("planta");
  const [msg, setMsg] = useState("");
  const here = currentRoom(agent, rooms);
  const room = rooms.find((r) => r.id === chosen) ?? here;
  if (!room) return null;
  const relation = { propia: "la suya", escritorio: "su escritorio" };
  const label = (r: (typeof rooms)[number]) => {
    const rel = roomRelation(r, agent);
    return `${r.name} (${rel === "propia" ? relation.propia : rel ? `${roomOwnerLabel(r, agents)}, ${relation.escritorio}` : roomOwnerLabel(r, agents)})`;
  };

  async function add() {
    setMsg("");
    const r = await api<{ skipped: string[] }>(`/api/rooms/${room!.id}`, { method: "PATCH", json: { add: [kind] } }).catch((e) => ({ skipped: [], error: e.message }));
    setMsg(r.skipped.length ? "No queda sitio para eso." : "");
  }

  function moveTo(roomId: string) {
    setMsg("");
    api(`/api/agents/${agent.id}`, { method: "PATCH", json: { locationRoomId: roomId === agent.roomId ? null : roomId } }).catch((e) => setMsg(e.message));
  }

  return (
    <section className="room-section">
      <h3>Salas</h3>
      <div className="row">
        <label className="small" title="Puede estar y trabajar en cualquier sala">
          Está en{" "}
          <select value={here?.id ?? ""} onChange={(e) => moveTo(e.target.value)}>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {label(r)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="row">
        <label className="small" title="Cualquiera puede decorar cualquier sala">
          Decorar{" "}
          <select value={room.id} onChange={(e) => setChosen(e.target.value)}>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {label(r)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="muted small">{furnitureSummary(room.furniture) || "Vacía"}</p>
      <div className="row">
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          {Object.entries(FURNITURE)
            .sort((a, b) => a[1].label.localeCompare(b[1].label))
            .map(([k, d]) => (
              <option key={k} value={k}>
                {d.label}
              </option>
            ))}
        </select>
        <button className="btn small" onClick={add}>
          Añadir
        </button>
        <button
          className="btn ghost small"
          title="Vaciar y volver a amueblar según su ámbito"
          onClick={() => {
            if (room.furniture.some((f) => f.manual) && !window.confirm("Se perderá lo que has colocado a mano. ¿Reamueblar la sala?")) return;
            api(`/api/rooms/${room.id}`, { method: "PATCH", json: { refurnish: true } }).catch((e) => setMsg(e.message));
          }}
        >
          Reamueblar
        </button>
      </div>
      <div className="row">
        <button className="btn small" title="Modo decorar en la propia sala: arrastrar, girar, duplicar y quitar" onClick={() => openDecor(room.id)}>
          Decorar a mano
        </button>
      </div>
      <p className="muted small">Lo nuevo se coloca solo en un hueco libre, sin mover lo que ya está.</p>
      {msg && <p className="warn-text small">{msg}</p>}
    </section>
  );
}
