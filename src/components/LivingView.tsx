"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api, onEvent, openDecor, useStore } from "@/client/store";
import type { FloorInfo, LivingScene } from "@/living/scene";
import { currentRoom } from "@/living/presence";
import { skyAt, skyCssVars, type Sky } from "@/living/sky";
import { AgentDrawer, STATUS_LABEL } from "./AgentDrawer";
import { AgentForm } from "./AgentForm";
import { AvatarPreview } from "./AvatarPreview";
import { DecorMode } from "./DecorMode";

/**
 * Selector de plantas de la torre (como el panel de un ascensor): subir, bajar
 * o ir directo a una planta. Arriba, la más alta.
 */
function FloorPicker({ level, floors, disabled, onPick }: { level: number; floors: FloorInfo[]; disabled: boolean; onPick: (level: number) => void }) {
  const levels = floors.map((f) => f.level);
  const min = Math.min(...levels);
  const max = Math.max(...levels);
  return (
    <nav className="floor-picker" aria-label="Plantas">
      <button className="btn ghost small" disabled={disabled || level >= max} onClick={() => onPick(level + 1)} title="Subir una planta">
        ▲
      </button>
      <ol>
        {[...floors].reverse().map((f) => (
          <li key={f.level}>
            <button
              className={f.level === level ? "on" : ""}
              disabled={disabled}
              onClick={() => onPick(f.level)}
              title={f.rooms ? `${f.rooms} sala${f.rooms === 1 ? "" : "s"}` : "Planta diáfana (aún sin salas)"}
            >
              <span className="fp-num">{f.level === 0 ? "B" : f.level}</span>
              <span className="fp-name">{f.label.replace(/^Planta (baja|\d+) · /, "")}</span>
              {f.agents > 0 && <span className="fp-count">{f.agents}</span>}
            </button>
          </li>
        ))}
      </ol>
      <button className="btn ghost small" disabled={disabled || level <= min} onClick={() => onPick(level - 1)} title="Bajar una planta">
        ▼
      </button>
    </nav>
  );
}

/** Living isométrico. PixiJS solo se carga en el navegador. */
export function LivingView() {
  const hostRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<LivingScene | null>(null);
  const agents = useStore((s) => s.agents);
  const rooms = useStore((s) => s.rooms);
  const usage = useStore((s) => s.usage);
  const roomEdit = useStore((s) => s.roomEdit);
  const [selected, setSelected] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [adding, setAdding] = useState(false);
  const [order, setOrder] = useState("");
  const [sending, setSending] = useState(false);
  const chief = agents.find((a) => a.isChief);
  // Plantas de la torre y la que se ve (las manda la escena).
  const [floorState, setFloorState] = useState<{ level: number; floors: FloorInfo[] }>({ level: 0, floors: [] });
  // El cielo solo se calcula en el navegador (hora local) y se refresca cada minuto.
  const [sky, setSky] = useState<Sky | null>(null);

  useEffect(() => {
    const update = () => setSky(skyAt(new Date()));
    update();
    const timer = window.setInterval(update, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let scene: LivingScene | null = null;
    import("@/living/scene").then(async ({ LivingScene }) => {
      if (cancelled || !hostRef.current || !overlayRef.current) return;
      scene = await LivingScene.create(hostRef.current, overlayRef.current, {
        onSelect: setSelected,
        onUsageClick: () => api("/api/claude/usage", { method: "POST" }).catch(() => {}),
        onFloors: setFloorState,
      });
      if (cancelled) {
        scene.destroy();
        return;
      }
      sceneRef.current = scene;
      (window as unknown as { __ordenScene?: LivingScene }).__ordenScene = scene; // depuración
      setReady(true);
    });
    return () => {
      cancelled = true;
      scene?.destroy();
      sceneRef.current = null;
    };
  }, []);

  // En el modo decorar, el living pinta el borrador (aún sin guardar).
  const shownRooms = useMemo(
    () =>
      roomEdit?.furniture || roomEdit?.style
        ? rooms.map((r) =>
            r.id === roomEdit.roomId ? { ...r, ...(roomEdit.furniture && { furniture: roomEdit.furniture }), ...(roomEdit.style && { style: roomEdit.style }) } : r,
          )
        : rooms,
    [rooms, roomEdit],
  );

  useEffect(() => {
    if (ready) sceneRef.current?.setWorld(shownRooms, agents);
  }, [ready, shownRooms, agents]);

  useEffect(() => {
    if (ready) sceneRef.current?.setUsage(usage);
  }, [ready, usage]);

  // Delegaciones y entregas: el agente camina hasta la sala del otro.
  useEffect(
    () =>
      onEvent((e) => {
        if (e.type !== "agent.visit") return;
        const p = e.payload as { fromId: string; toId: string; text?: string };
        sceneRef.current?.visit(p.fromId, p.toId, p.text);
      }),
    [],
  );

  async function sendOrder() {
    if (!chief || !order.trim()) return;
    setSending(true);
    try {
      await api(`/api/agents/${chief.id}/chat`, { method: "POST", json: { text: order.trim() } });
      setOrder("");
      setSelected(chief.id);
    } finally {
      setSending(false);
    }
  }

  const agent = agents.find((a) => a.id === selected) ?? null;
  const decorating = Boolean(roomEdit);

  return (
    <div className="living">
      <div
        className={`living-stage${decorating ? " decorating" : ""}`}
        data-sky={sky?.phase}
        style={sky ? (skyCssVars(sky) as React.CSSProperties) : undefined}
      >
        <div className="living-sky" aria-hidden>
          <div className="sky-stars" />
          <div className="sky-glow" />
        </div>
        <div ref={hostRef} className="living-canvas" />
        <div ref={overlayRef} className="living-overlay" />
        {!ready && <div className="living-loading">Abriendo la casa…</div>}
        {roomEdit && <DecorMode roomId={roomEdit.roomId} scene={ready ? sceneRef.current : null} />}

        <section className="roster">
          <header>
            <span>Equipo</span>
            <button className="btn primary small" onClick={() => setAdding(true)}>
              + Añadir agente
            </button>
          </header>
          <ul>
            {agents.map((a) => {
              const s = a.paused ? "sleeping" : a.status;
              return (
                <li key={a.id}>
                  <button className={selected === a.id ? "on" : ""} onClick={() => setSelected(a.id)}>
                    <AvatarPreview appearance={a.appearance} scale={1} />
                    <span className="roster-name">
                      <span>
                        {a.name} {a.admin && <span className="tag admin">admin</span>}
                      </span>
                      <small>{a.statusText || STATUS_LABEL[s]}</small>
                    </span>
                    <span className="roster-dot" data-status={s} />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        {floorState.floors.length > 1 && (
          <FloorPicker
            level={floorState.level}
            floors={floorState.floors}
            disabled={decorating}
            onPick={(level) => sceneRef.current?.setLevel(level)}
          />
        )}

        <form
          className="command-bar"
          onSubmit={(e) => {
            e.preventDefault();
            sendOrder();
          }}
        >
          <input value={order} onChange={(e) => setOrder(e.target.value)} placeholder={`Encárgale algo a ${chief?.name ?? "Zen"}…`} />
          <button className="btn primary" disabled={!order.trim() || sending}>
            Encargar
          </button>
        </form>

        <div className="living-hud">
          <button className="btn ghost small" onClick={() => sceneRef.current?.resetView()}>
            Centrar vista
          </button>
          {!roomEdit && rooms.length > 0 && (
            <button
              className="btn ghost small"
              title="Modo decorar: arrastra los muebles en la propia sala"
              onClick={() => openDecor((agent ? currentRoom(agent, rooms) : undefined)?.id ?? rooms[0].id)}
            >
              Decorar
            </button>
          )}
          {sky && (
            <span className="hud-hint sky-chip" title={`Intensidad ${Math.round(sky.intensity * 100)} %`}>
              {sky.label}
            </span>
          )}
        </div>
        <ul className="legend">
          <li data-status="working">Trabajando</li>
          <li data-status="waiting">Esperando</li>
          <li data-status="sleeping">Durmiendo</li>
          <li data-status="error">Error</li>
        </ul>
      </div>
      {!roomEdit && agent && <AgentDrawer agent={agent} onClose={() => setSelected(null)} />}
      {adding && <AgentForm onClose={() => setAdding(false)} onSaved={(a) => setSelected(a.id)} />}
    </div>
  );
}
