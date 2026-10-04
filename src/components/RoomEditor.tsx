"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api, dropRoom, openRoomEditor, setRoomDraft, setRoomStyleDraft, upsertRoom, useStore } from "@/client/store";
import { doorTiles } from "@/living/decorator";
import { FURNITURE, footprint, resolveBoxes } from "@/living/furniture";
import { applyFinish, currentFloorFinish, currentWallFinish, FLOOR_FINISHES, WALL_FINISHES } from "@/living/finishes";
import { backgroundBoxes } from "@/living/houseRender";
import { buildingOf } from "@/living/house";
import { checkRoomRemoval, joinNames } from "@/living/roomRemoval";
import { BUILDINGS } from "@/lib/roomTemplates";
import { rasterizeBoxes } from "@/living/raster";
import { autoArrange, dropTarget, layoutWarnings, moveItem, placeNew, removeItem, roomContext, rotateItem, type EditResult } from "@/living/roomEditor";
import type { FurnitureItem, Room, RoomStyle } from "@/lib/types";

/** Tamaño de una baldosa en el editor y grosor de las franjas de muro. */
const CELL = 34;
const WALL = 18;

const thumbs = new Map<string, string>();

function toDataUrl(img: ReturnType<typeof rasterizeBoxes>): string {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, img.width);
  canvas.height = Math.max(1, img.height);
  canvas.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(img.data), canvas.width, canvas.height), 0, 0);
  return canvas.toDataURL();
}

/** Vista previa de un suelo y unas paredes: una esquina de sala de 3×3 baldosas pintada como en el living. */
function finishThumb(style: RoomStyle): string {
  const key = `acabado|${JSON.stringify(style)}`;
  let url = thumbs.get(key);
  if (!url && typeof document !== "undefined") {
    const corner: Room = { id: "muestra", name: "", kind: "", agentId: null, x: 0, y: 0, w: 3, d: 3, style, furniture: [], createdAt: "", updatedAt: "" };
    url = toDataUrl(rasterizeBoxes(backgroundBoxes([corner]), { outline: true, outlineShade: 0.35 }));
    thumbs.set(key, url);
  }
  return url ?? "";
}
/** Miniatura del mueble tal y como se ve en el living. */
function thumb(kind: string, flip?: boolean, tint?: Record<string, string>): string {
  const key = `${kind}|${flip ? 1 : 0}|${JSON.stringify(tint ?? {})}`;
  let url = thumbs.get(key);
  if (!url && typeof document !== "undefined") {
    url = toDataUrl(rasterizeBoxes(resolveBoxes(kind, flip, tint)));
    thumbs.set(key, url);
  }
  return url ?? "";
}

/** Caja (en píxeles del editor) que ocupa un mueble en la rejilla. */
function boxOf(it: Pick<FurnitureItem, "kind" | "x" | "y" | "flip">) {
  const def = FURNITURE[it.kind];
  if (def?.wall) {
    const span = def.w * CELL;
    return it.flip ? { left: 0, top: WALL + it.y * CELL, width: WALL, height: span } : { left: WALL + it.x * CELL, top: 0, width: span, height: WALL };
  }
  if (def?.onTop) return { left: WALL + it.x * CELL + 6, top: WALL + it.y * CELL + 6, width: CELL - 12, height: CELL - 12 };
  const fp = footprint(it.kind, it.flip);
  return { left: WALL + it.x * CELL, top: WALL + it.y * CELL, width: fp.w * CELL, height: fp.d * CELL };
}

const layerOf = (kind: string) => (FURNITURE[kind]?.walkable ? 1 : FURNITURE[kind]?.onTop ? 3 : 2);

interface Drag {
  id: string;
  kind: string;
  flip: boolean;
  offX: number;
  offY: number;
  sx: number;
  sy: number;
  moved: boolean;
}

/**
 * Editor de sala: el usuario decide dónde va cada mueble. Trabaja sobre un
 * borrador que el living pinta en directo; nada se guarda hasta «Guardar».
 */
export function RoomEditor({ roomId }: { roomId: string }) {
  const rooms = useStore((s) => s.rooms);
  const rename = useStore((s) => Boolean(s.roomEdit?.rename));
  const room = rooms.find((r) => r.id === roomId) ?? null;
  if (!room) return null;
  return <Editor key={room.id} room={room} rooms={rooms} startRenaming={rename} />;
}

/** Nombre de la sala: clic para cambiarlo en línea (Intro guarda, Esc cancela). */
function RoomName({ room, startEditing }: { room: Room; startEditing: boolean }) {
  const [editing, setEditing] = useState(startEditing);
  const [value, setValue] = useState(room.name);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  async function commit() {
    const name = value.trim();
    setEditing(false);
    if (!name || name === room.name) {
      setValue(room.name);
      return;
    }
    try {
      await api(`/api/rooms/${room.id}`, { method: "PATCH", json: { name } });
      setError(null);
    } catch (e) {
      setValue(room.name);
      setError((e as Error).message);
    }
  }

  return (
    <div className="re-name">
      {editing ? (
        <input
          ref={inputRef}
          value={value}
          maxLength={60}
          aria-label="Nombre de la sala"
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            else if (e.key === "Escape") {
              setValue(room.name);
              setEditing(false);
            }
          }}
        />
      ) : (
        <button
          className="re-name-text"
          title="Cambiar el nombre"
          onClick={() => {
            setValue(room.name);
            setEditing(true);
          }}
        >
          {room.name} ✎
        </button>
      )}
      {error && <span className="re-msg bad small">{error}</span>}
    </div>
  );
}

function Editor({ room, rooms, startRenaming }: { room: Room; rooms: Room[]; startRenaming: boolean }) {
  const ctx = useMemo(() => roomContext(room, rooms), [room, rooms]);
  const [base, setBase] = useState(room.furniture);
  const [draft, setDraft] = useState<FurnitureItem[]>(room.furniture);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [trash, setTrash] = useState<Room[] | null>(null);
  const [roomMsg, setRoomMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const agents = useStore((s) => s.agents);
  const building = buildingOf(room);
  const siblings = rooms.filter((r) => buildingOf(r) === building);
  const removal = useMemo(() => checkRoomRemoval(room, rooms, agents), [room, rooms, agents]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tool, setTool] = useState<{ kind: string; flip: boolean } | null>(null);
  const [hover, setHover] = useState<{ cx: number; cy: number } | null>(null);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [autoRuns, setAutoRuns] = useState(0);
  const gridRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);

  // Suelo y paredes elegidos y aún sin guardar (ids del catálogo de acabados).
  const [finish, setFinish] = useState<{ suelo?: string; pared?: string }>({});
  const floorNow = currentFloorFinish(room.style);
  const wallNow = currentWallFinish(room.style);
  const pickedFloor = FLOOR_FINISHES.find((f) => f.id === finish.suelo && f.id !== floorNow?.id) ?? null;
  const pickedWall = WALL_FINISHES.find((w) => w.id === finish.pared && w.id !== wallNow?.id) ?? null;
  const styleDirty = Boolean(pickedFloor || pickedWall);
  const draftStyle = useMemo(() => applyFinish(room.style, { floor: pickedFloor, wall: pickedWall }), [room.style, pickedFloor, pickedWall]);

  const furnitureDirty = JSON.stringify(draft) !== JSON.stringify(base);
  const dirty = furnitureDirty || styleDirty;
  // Solo cuentan los muebles: renombrar la sala no pisa el borrador.
  const changedOutside = JSON.stringify(room.furniture) !== JSON.stringify(base);
  const doors = useMemo(() => new Set(doorTiles(room.w, room.d).map(([x, y]) => `${x},${y}`)), [room.w, room.d]);
  const warnings = useMemo(() => layoutWarnings(draft, ctx), [draft, ctx]);
  const sel = draft.find((f) => f.id === selected) ?? null;

  // El living enseña el borrador mientras se edita.
  useEffect(() => {
    setRoomDraft(furnitureDirty ? draft : null);
  }, [draft, furnitureDirty]);
  useEffect(() => {
    setRoomStyleDraft(styleDirty ? draftStyle : null);
  }, [draftStyle, styleDirty]);
  useEffect(
    () => () => {
      setRoomDraft(null);
      setRoomStyleDraft(null);
    },
    [],
  );

  function apply(r: EditResult, ok?: string) {
    if (r.error) {
      setMsg({ text: r.error, bad: true });
      return false;
    }
    setDraft(r.furniture);
    setMsg(ok ? { text: ok } : null);
    return true;
  }

  function rotate() {
    if (tool) setTool({ ...tool, flip: !tool.flip });
    else if (sel) apply(rotateItem(draft, sel.id, ctx));
  }

  function remove() {
    if (!sel) return;
    setDraft(removeItem(draft, sel.id));
    setSelected(null);
    setMsg(null);
  }

  function auto() {
    const r = autoArrange(draft, { ...ctx, seed: `${room.id}${autoRuns || ""}` });
    setAutoRuns((n) => n + 1);
    setDraft(r.furniture);
    setSelected(null);
    setMsg(r.skipped.length ? { text: `No caben al recolocar: ${r.skipped.map((k) => FURNITURE[k]?.label.toLowerCase() ?? k).join(", ")}.`, bad: true } : { text: "Recolocado automáticamente. Guarda para quedártelo." });
  }

  async function save() {
    setSaving(true);
    try {
      // Solo se mandan los muebles si cambiaron: así cambiar el suelo no pisa lo que haya decorado un agente.
      const json = {
        ...(furnitureDirty && { furniture: draft }),
        ...(styleDirty && { finish: { suelo: pickedFloor?.id, pared: pickedWall?.id } }),
      };
      const saved = await api<Room>(`/api/rooms/${room.id}`, { method: "PATCH", json });
      upsertRoom(saved);
      if (furnitureDirty) {
        setBase(saved.furniture);
        setDraft(saved.furniture);
      }
      setFinish({});
      setMsg({ text: "Guardado." });
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
    } finally {
      setSaving(false);
    }
  }

  function reload() {
    setBase(room.furniture);
    setDraft(room.furniture);
    setFinish({});
    setSelected(null);
    setMsg(null);
  }

  /** Crea una sala vacía y común en este edificio y la abre con el nombre listo para cambiarlo. */
  async function createRoom() {
    if (dirty && !window.confirm("Hay cambios sin guardar. ¿Crear otra sala sin guardarlos?")) return;
    setCreating(true);
    try {
      const created = await api<Room>("/api/rooms", { method: "POST", json: { building } });
      upsertRoom(created);
      openRoomEditor(created.id, { rename: true });
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
      setCreating(false);
    }
  }

  /**
   * Manda la sala a la papelera tras confirmarlo. Si no se puede (última del
   * edificio, sala propia de un agente, dejaría salas sin paso) solo avisa.
   * A quien tenga aquí su escritorio se le asigna otro puesto libre.
   */
  async function deleteRoom() {
    if (removal.blocked) {
      setRoomMsg({ text: `No se puede borrar: ${removal.blocked}`, bad: true });
      return;
    }
    const n = removal.relocate.length;
    const lines = [
      `¿Borrar la sala «${room.name}»? Irá a la papelera y podrás recuperarla desde aquí.`,
      n ? `${joinNames(removal.relocate.map((a) => a.name))} tiene${n > 1 ? "n" : ""} aquí su escritorio: se le${n > 1 ? "s" : ""} asignará otro puesto libre en otra sala común.` : "",
      removal.visitors.length ? `${joinNames(removal.visitors.map((a) => a.name))} volverá${removal.visitors.length > 1 ? "n" : ""} a su sitio.` : "",
      dirty ? "Se perderán los cambios sin guardar." : "",
    ];
    if (!window.confirm(lines.filter(Boolean).join("\n\n"))) return;
    setDeleting(true);
    try {
      await api(`/api/rooms/${room.id}${n ? "?relocate=1" : ""}`, { method: "DELETE" });
      const next = siblings.find((r) => r.id !== room.id);
      if (next) openRoomEditor(next.id);
      dropRoom(room.id);
    } catch (e) {
      setRoomMsg({ text: (e as Error).message, bad: true });
      setDeleting(false);
    }
  }

  async function loadTrash() {
    try {
      const all = await api<Room[]>("/api/rooms?archived=1");
      setTrash(all.filter((r) => buildingOf(r) === building));
    } catch (e) {
      setRoomMsg({ text: (e as Error).message, bad: true });
    }
  }

  async function restore(r: Room) {
    try {
      const restored = await api<Room>(`/api/rooms/${r.id}`, { method: "PATCH", json: { restore: true } });
      upsertRoom(restored);
      setRoomMsg({ text: `«${restored.name}» recuperada.` });
      await loadTrash();
    } catch (e) {
      setRoomMsg({ text: (e as Error).message, bad: true });
    }
  }

  async function purge(r: Room) {
    if (!window.confirm(`¿Borrar «${r.name}» para siempre? Esto no se puede deshacer.`)) return;
    try {
      await api(`/api/rooms/${r.id}?forever=1`, { method: "DELETE" });
      setRoomMsg({ text: `«${r.name}» borrada para siempre.` });
      await loadTrash();
    } catch (e) {
      setRoomMsg({ text: (e as Error).message, bad: true });
    }
  }

  function close() {
    if (dirty && !window.confirm("Hay cambios sin guardar. ¿Salir sin guardarlos?")) return;
    openRoomEditor(null);
  }

  function switchRoom(id: string) {
    if (dirty && !window.confirm("Hay cambios sin guardar. ¿Cambiar de sala sin guardarlos?")) return;
    openRoomEditor(id);
  }

  // Teclado: R gira, Supr quita, Esc suelta.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
      if (e.key === "r" || e.key === "R") rotate();
      else if (e.key === "Delete" || e.key === "Backspace") remove();
      else if (e.key === "Escape") {
        setTool(null);
        setSelected(null);
        setMsg(null);
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /** Casilla bajo el puntero (x = -1: muro oeste; y = -1: muro norte). */
  function cellAt(clientX: number, clientY: number) {
    const rect = gridRef.current!.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    if (px < 0 || py < 0 || px >= WALL + room.w * CELL || py >= WALL + room.d * CELL) return null;
    return { cx: px < WALL ? -1 : Math.floor((px - WALL) / CELL), cy: py < WALL ? -1 : Math.floor((py - WALL) / CELL) };
  }

  /** Qué pasaría al soltar en la casilla actual (para la sombra y para aplicar). */
  const preview = useMemo(() => {
    if (!hover) return null;
    if (drag?.moved) {
      const t = dropTarget(drag.kind, hover.cx - drag.offX, hover.cy - drag.offY, drag.flip);
      if (!t) return null;
      return { ...t, kind: drag.kind, result: moveItem(draft, drag.id, t.x, t.y, ctx, t.flip) };
    }
    if (tool) {
      const t = dropTarget(tool.kind, hover.cx, hover.cy, tool.flip);
      if (!t) return null;
      return { ...t, kind: tool.kind, result: placeNew(draft, tool.kind, t.x, t.y, t.flip, ctx) };
    }
    if (sel && !drag) {
      const t = dropTarget(sel.kind, hover.cx, hover.cy, Boolean(sel.flip));
      if (!t || (t.x === sel.x && t.y === sel.y)) return null;
      return { ...t, kind: sel.kind, result: moveItem(draft, sel.id, t.x, t.y, ctx, t.flip) };
    }
    return null;
  }, [hover, drag, tool, sel, draft, ctx]);

  function onItemDown(e: React.PointerEvent, it: FurnitureItem) {
    if (tool || e.button !== 0) return;
    e.stopPropagation();
    const c = cellAt(e.clientX, e.clientY);
    const floor = !FURNITURE[it.kind]?.wall && !FURNITURE[it.kind]?.onTop;
    const d: Drag = {
      id: it.id,
      kind: it.kind,
      flip: Boolean(it.flip),
      offX: floor && c ? c.cx - it.x : 0,
      offY: floor && c ? c.cy - it.y : 0,
      sx: e.clientX,
      sy: e.clientY,
      moved: false,
    };
    dragRef.current = d;
    setDrag(d);
    setSelected(it.id);
    setMsg(null);
    gridRef.current?.setPointerCapture(e.pointerId);
  }

  function onMove(e: React.PointerEvent) {
    const c = cellAt(e.clientX, e.clientY);
    setHover((h) => (h?.cx === c?.cx && h?.cy === c?.cy ? h : c));
    const d = dragRef.current;
    if (d && !d.moved && Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 4) {
      d.moved = true;
      setDrag({ ...d });
    }
  }

  function onUp(e: React.PointerEvent) {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (d) {
      if (d.moved && preview) apply(preview.result);
      return;
    }
    const c = cellAt(e.clientX, e.clientY);
    if (!c) return;
    if (tool) {
      if (preview && apply(preview.result)) {
        setSelected(preview.result.id ?? null);
        // Con Mayús se siguen colocando más del mismo.
        if (!e.shiftKey) setTool(null);
      }
      return;
    }
    if (sel) {
      if (preview) apply(preview.result);
      else setSelected(null);
    }
  }

  const catalog = useMemo(() => Object.entries(FURNITURE).sort((a, b) => a[1].label.localeCompare(b[1].label)), []);

  return (
    <aside className="drawer room-editor">
      <header className="drawer-head">
        <div className="drawer-title">
          <h2>Editar sala</h2>
          <select value={room.id} onChange={(e) => switchRoom(e.target.value)} aria-label="Sala">
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </div>
        <button className="btn ghost small" onClick={close} aria-label="Cerrar">
          ✕
        </button>
      </header>
      <div className="drawer-scroll">
        <RoomName room={room} startEditing={startRenaming} />
        <h3 className="re-title">Salas · {BUILDINGS[building]?.label ?? building}</h3>
        <div className="re-rooms">
          {siblings.map((r) => (
            <button key={r.id} className={`re-room${r.id === room.id ? " on" : ""}`} title={r.name} onClick={() => r.id !== room.id && switchRoom(r.id)}>
              <span
                className="re-room-swatch"
                style={{ background: `repeating-conic-gradient(${r.style.floorA} 0 25%, ${r.style.floorB} 0 50%) 0 0 / 10px 10px`, ["--swatch-wall" as string]: r.style.wallTrim }}
              />
              <span>{r.name}</span>
            </button>
          ))}
          <button
            className="re-room add"
            title={`Crear una sala vacía en ${BUILDINGS[building]?.label ?? "este edificio"}`}
            aria-label="Crear sala nueva"
            disabled={creating}
            onClick={createRoom}
          >
            +
          </button>
        </div>
        <div className="re-room-actions">
          <button
            className={`btn danger small${removal.blocked ? " blocked" : ""}`}
            title={removal.blocked ?? "Mandar esta sala a la papelera (se puede recuperar)"}
            disabled={deleting}
            onClick={deleteRoom}
          >
            {deleting ? "Borrando…" : "🗑 Borrar sala"}
          </button>
          <button className="btn ghost small" onClick={() => (trash ? setTrash(null) : loadTrash())}>
            Papelera{trash ? ` (${trash.length})` : ""}
          </button>
        </div>
        {roomMsg && <p className={`re-msg small re-hint${roomMsg.bad ? " bad" : ""}`}>{roomMsg.text}</p>}
        {trash &&
          (trash.length ? (
            <ul className="re-trash">
              {trash.map((r) => (
                <li key={r.id}>
                  <span title={r.name}>{r.name}</span>
                  <button className="btn ghost small" onClick={() => restore(r)}>
                    Recuperar
                  </button>
                  <button className="btn ghost small" onClick={() => purge(r)} title="Borrar para siempre">
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small re-hint">No hay salas de {BUILDINGS[building]?.label ?? "este edificio"} en la papelera.</p>
          ))}
        <p className="muted small re-hint">
          Arrastra un mueble para moverlo, o selecciónalo y haz clic en otra casilla. Del catálogo: elige uno y haz clic donde quieras
          (Mayús para poner varios). <kbd>R</kbd> girar · <kbd>Supr</kbd> quitar · <kbd>Esc</kbd> soltar.
        </p>
        {changedOutside && (
          <p className="re-msg bad small">
            La sala ha cambiado mientras editabas (quizá un agente la ha decorado).{" "}
            <button className="btn ghost small" onClick={reload}>
              Cargar lo nuevo
            </button>
          </p>
        )}

        <div className="re-stage">
          <div
            ref={gridRef}
            className={`re-grid${tool ? " placing" : ""}${drag?.moved ? " dragging" : ""}`}
            style={{ width: WALL + room.w * CELL, height: WALL + room.d * CELL }}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerLeave={() => !dragRef.current && setHover(null)}
          >
            {Array.from({ length: room.w }, (_, x) => (
              <div key={`n${x}`} className={`re-wall${ctx.northWall[x] ? "" : " off"}`} style={{ left: WALL + x * CELL, top: 0, width: CELL, height: WALL }} />
            ))}
            {Array.from({ length: room.d }, (_, y) => (
              <div key={`w${y}`} className={`re-wall${ctx.westWall[y] ? "" : " off"}`} style={{ left: 0, top: WALL + y * CELL, width: WALL, height: CELL }} />
            ))}
            {Array.from({ length: room.w * room.d }, (_, i) => {
              const x = i % room.w;
              const y = Math.floor(i / room.w);
              return (
                <div
                  key={i}
                  className={`re-cell${(x + y) % 2 ? " alt" : ""}${doors.has(`${x},${y}`) ? " door" : ""}`}
                  style={{ left: WALL + x * CELL, top: WALL + y * CELL, width: CELL, height: CELL }}
                  title={doors.has(`${x},${y}`) ? "Paso de puerta: déjalo libre" : undefined}
                />
              );
            })}
            {draft.map((it) => {
              const def = FURNITURE[it.kind];
              if (!def) return null;
              const hidden = drag?.moved && drag.id === it.id;
              return (
                <div
                  key={it.id}
                  className={`re-item l${layerOf(it.kind)}${it.id === selected ? " sel" : ""}${it.manual ? " manual" : ""}${hidden ? " lifted" : ""}`}
                  style={{ ...boxOf(it), zIndex: layerOf(it.kind) + (it.id === selected ? 3 : 0) }}
                  title={`${def.label}${it.manual ? " · colocado a mano" : ""}`}
                  onPointerDown={(e) => onItemDown(e, it)}
                >
                  <img src={thumb(it.kind, it.flip, it.tint)} alt={def.label} draggable={false} />
                </div>
              );
            })}
            {preview && (
              <div className={`re-ghost${preview.result.error ? " bad" : ""}`} style={boxOf(preview)} title={preview.result.error}>
                <img src={thumb(preview.kind, preview.flip)} alt="" draggable={false} />
              </div>
            )}
          </div>
          <div className="re-axes muted small">
            <span>↖ fondo izquierdo (oeste)</span>
            <span>fondo derecho (norte) ↗</span>
          </div>
        </div>

        <div className="re-bar">
          {tool ? (
            <>
              <span className="re-sel">
                Colocando: <b>{FURNITURE[tool.kind].label}</b>
              </span>
              <button className="btn ghost small" onClick={rotate} title="Girar (R)">
                ⟳ Girar
              </button>
              <button className="btn ghost small" onClick={() => setTool(null)}>
                Cancelar
              </button>
            </>
          ) : sel ? (
            <>
              <span className="re-sel">
                <b>{FURNITURE[sel.kind]?.label}</b> ({sel.x + 1}, {sel.y + 1})
              </span>
              <button className="btn ghost small" onClick={rotate} title="Girar (R)">
                ⟳ Girar
              </button>
              <button className="btn danger small" onClick={remove} title="Quitar (Supr)">
                Quitar
              </button>
            </>
          ) : (
            <span className="muted small">Nada seleccionado.</span>
          )}
        </div>
        {msg && <p className={`re-msg small${msg.bad ? " bad" : ""}`}>{msg.text}</p>}
        {warnings.map((w) => (
          <p key={w} className="re-msg warn small">
            ⚠ {w}
          </p>
        ))}

        <h3 className="re-title">Suelo</h3>
        <div className="re-catalog re-finishes">
          {FLOOR_FINISHES.map((f) => {
            const on = (pickedFloor ?? floorNow)?.id === f.id;
            return (
              <button
                key={f.id}
                className={on ? "on" : ""}
                title={`${f.label}${floorNow?.id === f.id ? " · el actual" : ""}`}
                onClick={() => setFinish((s) => ({ ...s, suelo: f.id }))}
              >
                <img src={finishThumb(applyFinish(draftStyle, { floor: f }))} alt="" draggable={false} />
                <span>{f.label}</span>
              </button>
            );
          })}
        </div>
        <h3 className="re-title">Paredes</h3>
        <div className="re-catalog re-finishes">
          {WALL_FINISHES.map((w) => {
            const on = (pickedWall ?? wallNow)?.id === w.id;
            return (
              <button
                key={w.id}
                className={on ? "on" : ""}
                title={`${w.label}${wallNow?.id === w.id ? " · la actual" : ""}`}
                onClick={() => setFinish((s) => ({ ...s, pared: w.id }))}
              >
                <img src={finishThumb(applyFinish(draftStyle, { wall: w }))} alt="" draggable={false} />
                <span>{w.label}</span>
              </button>
            );
          })}
        </div>
        {styleDirty && <p className="muted small re-hint">Vista previa en el living. Pulsa «Guardar» para quedártelo o «Descartar».</p>}

        <h3 className="re-title">Catálogo</h3>
        <div className="re-catalog">
          {catalog.map(([k, d]) => (
            <button
              key={k}
              className={tool?.kind === k ? "on" : ""}
              title={d.wall ? `${d.label} (en la pared)` : d.onTop ? `${d.label} (encima de una mesa)` : d.label}
              onClick={() => {
                setSelected(null);
                setMsg(null);
                setTool(tool?.kind === k ? null : { kind: k, flip: false });
              }}
            >
              <img src={thumb(k)} alt="" draggable={false} />
              <span>{d.label}</span>
            </button>
          ))}
        </div>
      </div>
      <footer className="re-foot">
        <button className="btn ghost small" onClick={auto} title="Deja que el decorador distribuya estos mismos muebles">
          Recolocar automáticamente
        </button>
        <span className="re-spacer" />
        <button className="btn ghost small" disabled={!dirty || saving} onClick={reload}>
          Descartar
        </button>
        <button className="btn primary small" disabled={!dirty || saving} onClick={save}>
          {saving ? "Guardando…" : "Guardar"}
        </button>
      </footer>
    </aside>
  );
}
