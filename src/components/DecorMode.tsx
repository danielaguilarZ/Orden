"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api, dropRoom, openDecor, setRoomDraft, setRoomStyleDraft, upsertRoom, useStore } from "@/client/store";
import { dragExisting, dragNew, dragTarget, pushHistory, type DecorDrag, type DecorGhost } from "@/living/decorMode";
import { FURNITURE, resolveBoxes } from "@/living/furniture";
import { applyFinish, currentFloorFinish, currentWallFinish, FLOOR_FINISHES, WALL_FINISHES } from "@/living/finishes";
import { backgroundBoxes } from "@/living/houseRender";
import { buildingOf } from "@/living/house";
import { checkRoomRemoval, joinNames } from "@/living/roomRemoval";
import { rasterizeBoxes } from "@/living/raster";
import {
  autoArrange,
  duplicateItem,
  layoutWarnings,
  moveItem,
  placeNear,
  placeNew,
  removeItem,
  roomContext,
  rotateItem,
  type EditResult,
} from "@/living/roomEditor";
import type { LivingScene } from "@/living/scene";
import { BUILDINGS } from "@/lib/roomTemplates";
import type { FurnitureItem, Room, RoomStyle } from "@/lib/types";

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
function thumb(kind: string): string {
  let url = thumbs.get(kind);
  if (!url && typeof document !== "undefined") {
    url = toDataUrl(rasterizeBoxes(resolveBoxes(kind)));
    thumbs.set(kind, url);
  }
  return url ?? "";
}

const INV_KEY = "orden.inventario";
const readInvOpen = () => {
  try {
    return localStorage.getItem(INV_KEY) !== "plegado";
  } catch {
    return true;
  }
};

/** Márgenes de los paneles para encuadrar la sala (barra arriba, inventario a la derecha). */
const pads = (invOpen: boolean) => ({ top: 70, right: invOpen ? 336 : 56, bottom: 16, left: 16 });

type Tab = "muebles" | "acabados" | "sala";

interface DragState {
  drag: DecorDrag;
  sx: number;
  sy: number;
  moved: boolean;
  last: { x: number; y: number; target: EventTarget | null };
}

interface Preview {
  ghost: DecorGhost;
  result: EditResult;
}

/**
 * Modo «decorar» (estilo Habbo) dentro del propio living: rejilla sobre la
 * sala, muebles que se cogen y se arrastran (sombra verde si cabe, roja si no),
 * barra pequeña encima del elegido (girar, duplicar, quitar) e inventario
 * lateral plegable del que se arrastran muebles nuevos. Trabaja sobre un
 * borrador que el living pinta en directo; nada se guarda hasta «Guardar».
 */
export function DecorMode({ roomId, scene }: { roomId: string; scene: LivingScene | null }) {
  const rooms = useStore((s) => s.rooms);
  const rename = useStore((s) => Boolean(s.roomEdit?.rename));
  const room = rooms.find((r) => r.id === roomId) ?? null;
  if (!room || !scene) return null;
  return <Decor key={room.id} room={room} rooms={rooms} scene={scene} startRenaming={rename} />;
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

function Decor({ room, rooms, scene, startRenaming }: { room: Room; rooms: Room[]; scene: LivingScene; startRenaming: boolean }) {
  const ctx = useMemo(() => roomContext(room, rooms), [room, rooms]);
  const [base, setBase] = useState(room.furniture);
  const [draft, setDraft] = useState<FurnitureItem[]>(room.furniture);
  const [history, setHistory] = useState<FurnitureItem[][]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [lifted, setLifted] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [autoRuns, setAutoRuns] = useState(0);
  const [invOpen, setInvOpen] = useState(readInvOpen);
  const [tab, setTab] = useState<Tab>(startRenaming ? "sala" : "muebles");
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [trash, setTrash] = useState<Room[] | null>(null);
  const [roomMsg, setRoomMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const agents = useStore((s) => s.agents);
  const building = buildingOf(room);
  const siblings = rooms.filter((r) => buildingOf(r) === building);
  const removal = useMemo(() => checkRoomRemoval(room, rooms, agents), [room, rooms, agents]);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);

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
  const warnings = useMemo(() => layoutWarnings(draft, ctx), [draft, ctx]);
  const sel = draft.find((f) => f.id === selected) ?? null;

  // Lo último, para los manejadores del arrastre (viven fuera del ciclo de React).
  const latest = useRef({ draft, ctx, room });
  latest.current = { draft, ctx, room };

  // El living enseña el borrador mientras se decora.
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

  // Entrar en el modo decorar: la escena pinta la rejilla y avisa al pulsar un mueble.
  useEffect(() => {
    scene.setDecorMode(room.id, {
      onItemDown: (id, e) => {
        const it = latest.current.draft.find((f) => f.id === id);
        if (!it) return;
        setSelected(id);
        setMsg(null);
        beginDrag(dragExisting(latest.current.room, it, e.wx, e.wy), e.clientX, e.clientY);
      },
      onEmptyTap: () => setSelected(null),
    });
    scene.focusRoom(room.id, pads(readInvOpen()));
    return () => {
      endDrag();
      scene.setDecorMode(null);
    };
    // Los manejadores leen el estado por referencias: basta con la sala y la escena.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, room.id]);

  useEffect(() => {
    scene.setDecorToolbar(toolbarRef.current);
    return () => scene.setDecorToolbar(null);
  }, [scene]);

  useEffect(() => {
    scene.setDecorView({ selectedId: selected, liftedId: lifted, ghost: preview?.ghost ?? null });
  }, [scene, selected, lifted, preview]);

  // Si el mueble elegido desaparece (deshacer, quitar, recargar), se suelta.
  useEffect(() => {
    if (selected && !draft.some((f) => f.id === selected)) setSelected(null);
  }, [draft, selected]);

  /** Cambia el borrador guardando el paso anterior para «Deshacer». */
  function commit(next: FurnitureItem[]) {
    const prev = latest.current.draft;
    setHistory((h) => pushHistory(h, prev));
    setDraft(next);
  }

  function apply(r: EditResult, ok?: string) {
    if (r.error) {
      setMsg({ text: r.error, bad: true });
      return false;
    }
    commit(r.furniture);
    setMsg(ok ? { text: ok } : null);
    return true;
  }

  // ───────── Arrastre (de la sala o del inventario) ─────────

  function previewAt(x: number, y: number, target: EventTarget | null): Preview | null {
    const d = dragRef.current;
    if (!d) return null;
    // Encima de los paneles no se suelta nada.
    if (target instanceof Element && target.closest(".decor-ui")) return null;
    const w = scene.clientToWorld(x, y);
    if (!w) return null;
    const { draft: items, ctx: c, room: r } = latest.current;
    const t = dragTarget(r, d.drag, w.wx, w.wy);
    if (!t) return null;
    const result = d.drag.id ? moveItem(items, d.drag.id, t.x, t.y, c, t.flip) : placeNew(items, d.drag.kind, t.x, t.y, t.flip, c, d.drag.tint);
    const placed = result.error ? undefined : result.furniture.find((f) => f.id === result.id);
    const z = placed?.z ?? (FURNITURE[d.drag.kind]?.onTop ? 17 : undefined);
    return { ghost: { kind: d.drag.kind, x: t.x, y: t.y, flip: t.flip, ...(d.drag.tint && { tint: d.drag.tint }), ...(z !== undefined && { z }), ok: !result.error }, result };
  }

  /** Solo se repinta si la sombra cambia de casilla, de giro o de color. */
  function showPreview(p: Preview | null) {
    setPreview((cur) => {
      const a = cur?.ghost;
      const b = p?.ghost;
      if (a && b && a.x === b.x && a.y === b.y && a.flip === b.flip && a.ok === b.ok && a.kind === b.kind) return cur;
      return p;
    });
  }

  function onDragMove(e: PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    d.last = { x: e.clientX, y: e.clientY, target: e.target };
    if (!d.moved) {
      if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) < 5) return;
      d.moved = true;
      setLifted(d.drag.id);
      setMsg(null);
    }
    showPreview(previewAt(e.clientX, e.clientY, e.target));
  }

  function onDragUp(e: PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    const p = d.moved ? previewAt(e.clientX, e.clientY, e.target) : null;
    endDrag();
    if (!d.moved) {
      // Clic en el inventario sin arrastrar: se pone solo en el hueco libre más cercano al centro.
      if (!d.drag.id) {
        const { draft: items, ctx: c } = latest.current;
        const r = placeNear(items, d.drag.kind, { x: Math.floor(c.w / 2), y: Math.floor(c.d / 2) }, false, c);
        if (apply(r, `${FURNITURE[d.drag.kind]?.label ?? "Mueble"} colocado en un hueco libre.`)) setSelected(r.id ?? null);
      }
      return;
    }
    if (!p) {
      if (!d.drag.id) setMsg({ text: "Suéltalo dentro de la sala." });
      return;
    }
    if (apply(p.result)) setSelected(p.result.id ?? d.drag.id);
  }

  // Los oyentes de la ventana son siempre las mismas funciones (para poder quitarlos) y llaman a las de este render.
  const impl = useRef({ onDragMove, onDragUp });
  impl.current = { onDragMove, onDragUp };
  const listeners = useMemo(
    () => ({
      move: (e: PointerEvent) => impl.current.onDragMove(e),
      up: (e: PointerEvent) => impl.current.onDragUp(e),
      cancel: () => endDrag(),
    }),
    // endDrag solo usa referencias y setters estables.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  function beginDrag(drag: DecorDrag, x: number, y: number) {
    endDrag();
    dragRef.current = { drag, sx: x, sy: y, moved: false, last: { x, y, target: null } };
    window.addEventListener("pointermove", listeners.move);
    window.addEventListener("pointerup", listeners.up);
    window.addEventListener("pointercancel", listeners.cancel);
  }

  function endDrag() {
    dragRef.current = null;
    window.removeEventListener("pointermove", listeners.move);
    window.removeEventListener("pointerup", listeners.up);
    window.removeEventListener("pointercancel", listeners.cancel);
    setPreview(null);
    setLifted(null);
  }

  // ───────── Acciones ─────────

  function rotate() {
    const d = dragRef.current;
    if (d) {
      // Girar lo que se lleva en la mano (R mientras se arrastra).
      d.drag = { ...d.drag, flip: !d.drag.flip };
      if (d.moved) showPreview(previewAt(d.last.x, d.last.y, d.last.target));
      return;
    }
    if (sel) apply(rotateItem(draft, sel.id, ctx));
  }

  function remove() {
    if (!sel) return;
    commit(removeItem(draft, sel.id));
    setSelected(null);
    setMsg(null);
  }

  function duplicate() {
    if (!sel) return;
    const r = duplicateItem(draft, sel.id, ctx);
    if (apply(r)) setSelected(r.id ?? null);
  }

  function undo() {
    if (!history.length) return;
    setDraft(history[history.length - 1]);
    setHistory((h) => h.slice(0, -1));
    setMsg(null);
  }

  function auto() {
    const r = autoArrange(draft, { ...ctx, seed: `${room.id}${autoRuns || ""}` });
    setAutoRuns((n) => n + 1);
    commit(r.furniture);
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
      setHistory([]);
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
    setHistory([]);
    setFinish({});
    setSelected(null);
    setMsg(null);
  }

  function close() {
    if (dirty && !window.confirm("Hay cambios sin guardar. ¿Salir del modo decorar sin guardarlos?")) return;
    openDecor(null);
  }

  function switchRoom(id: string) {
    if (id === room.id) return;
    if (dirty && !window.confirm("Hay cambios sin guardar. ¿Cambiar de sala sin guardarlos?")) return;
    openDecor(id);
  }

  function toggleInventory() {
    const next = !invOpen;
    setInvOpen(next);
    try {
      localStorage.setItem(INV_KEY, next ? "abierto" : "plegado");
    } catch {
      // sin almacenamiento: solo dura esta visita
    }
  }

  /** Crea una sala vacía y común en este edificio y la abre con el nombre listo para cambiarlo. */
  async function createRoom() {
    if (dirty && !window.confirm("Hay cambios sin guardar. ¿Crear otra sala sin guardarlos?")) return;
    setCreating(true);
    try {
      const created = await api<Room>("/api/rooms", { method: "POST", json: { building } });
      upsertRoom(created);
      openDecor(created.id, { rename: true });
    } catch (e) {
      setRoomMsg({ text: (e as Error).message, bad: true });
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
      openDecor(next ? next.id : null);
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

  // Teclado: R gira, Supr quita, Ctrl+D duplica, Ctrl+Z deshace, Esc suelta.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === "z" || e.key === "Z")) undo();
      else if (mod && (e.key === "d" || e.key === "D")) duplicate();
      else if (mod) return;
      else if (e.key === "r" || e.key === "R") rotate();
      else if (e.key === "Delete" || e.key === "Backspace") remove();
      else if (e.key === "Escape") {
        if (dragRef.current) endDrag();
        else setSelected(null);
        setMsg(null);
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const q = search.trim().toLowerCase();
  const catalog = useMemo(() => Object.entries(FURNITURE).sort((a, b) => a[1].label.localeCompare(b[1].label)), []);
  const shown = q ? catalog.filter(([k, d]) => d.label.toLowerCase().includes(q) || k.includes(q)) : catalog;

  return (
    <div className="decor">
      <div className="decor-ui decor-bar">
        <span className="decor-badge">Decorando</span>
        <select value={room.id} onChange={(e) => switchRoom(e.target.value)} aria-label="Sala">
          {rooms.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <button className="btn ghost small" disabled={!history.length} onClick={undo} title="Deshacer (Ctrl+Z)">
          ↶ Deshacer
        </button>
        <span className={`decor-state small${dirty ? " dirty" : ""}`}>{dirty ? "Sin guardar" : "Guardado"}</span>
        <button className="btn ghost small" disabled={!dirty || saving} onClick={reload}>
          Descartar
        </button>
        <button className="btn primary small" disabled={!dirty || saving} onClick={save}>
          {saving ? "Guardando…" : "Guardar"}
        </button>
        <button className="btn ghost small" onClick={close} title="Salir del modo decorar">
          Salir
        </button>
      </div>

      <div className="decor-msgs">
        {msg && <p className={`decor-ui decor-msg${msg.bad ? " bad" : ""}`}>{msg.text}</p>}
        {changedOutside && (
          <p className="decor-ui decor-msg bad">
            La sala ha cambiado mientras decorabas (quizá un agente la ha decorado).{" "}
            <button className="btn ghost small" onClick={reload}>
              Cargar lo nuevo
            </button>
          </p>
        )}
        {warnings.map((w) => (
          <p key={w} className="decor-ui decor-msg warn">
            ⚠ {w}
          </p>
        ))}
      </div>

      <div ref={toolbarRef} className="decor-ui decor-tools" style={{ visibility: "hidden" }}>
        {sel && (
          <>
            <span className="decor-tools-name">{FURNITURE[sel.kind]?.label ?? sel.kind}</span>
            <button onClick={rotate} title="Girar (R)" aria-label="Girar">
              ⟳
            </button>
            <button onClick={duplicate} title="Duplicar (Ctrl+D)" aria-label="Duplicar">
              ⧉
            </button>
            <button className="bad" onClick={remove} title="Quitar (Supr)" aria-label="Quitar">
              ✕
            </button>
          </>
        )}
      </div>

      <aside className={`decor-ui decor-inv${invOpen ? "" : " closed"}`} aria-label="Inventario">
        <button className="decor-inv-toggle" onClick={toggleInventory} title={invOpen ? "Plegar el inventario" : "Abrir el inventario"}>
          {invOpen ? "›" : "‹ Inventario"}
        </button>
        {invOpen && (
          <>
            <div className="tabs decor-tabs">
              {(
                [
                  ["muebles", "Muebles"],
                  ["acabados", "Suelo y paredes"],
                  ["sala", "Sala"],
                ] as [Tab, string][]
              ).map(([id, label]) => (
                <button key={id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
                  {label}
                </button>
              ))}
            </div>
            <div className="decor-inv-body">
              {tab === "muebles" && (
                <>
                  <p className="muted small re-hint">
                    Arrastra un mueble a la sala (o haz clic y se pone en un hueco libre). En la sala: arrástralos para moverlos; <kbd>R</kbd> girar ·{" "}
                    <kbd>Supr</kbd> quitar · <kbd>Ctrl</kbd>+<kbd>D</kbd> duplicar · <kbd>Ctrl</kbd>+<kbd>Z</kbd> deshacer.
                  </p>
                  <input className="decor-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar mueble…" aria-label="Buscar mueble" />
                  <div className="re-catalog">
                    {shown.map(([k, d]) => (
                      <button
                        key={k}
                        title={d.wall ? `${d.label} (en la pared)` : d.onTop ? `${d.label} (encima de una mesa)` : d.label}
                        onPointerDown={(e) => {
                          if (e.button !== 0) return;
                          e.preventDefault();
                          setSelected(null);
                          setMsg(null);
                          beginDrag(dragNew(k), e.clientX, e.clientY);
                        }}
                      >
                        <img src={thumb(k)} alt="" draggable={false} />
                        <span>{d.label}</span>
                      </button>
                    ))}
                    {!shown.length && <p className="muted small">Nada con «{search}».</p>}
                  </div>
                </>
              )}

              {tab === "acabados" && (
                <>
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
                  {styleDirty && <p className="muted small re-hint">Vista previa en la sala. Pulsa «Guardar» para quedártelo o «Descartar».</p>}
                </>
              )}

              {tab === "sala" && (
                <>
                  <RoomName room={room} startEditing={startRenaming} />
                  <h3 className="re-title">Salas · {BUILDINGS[building]?.label ?? building}</h3>
                  <div className="re-rooms">
                    {siblings.map((r) => (
                      <button key={r.id} className={`re-room${r.id === room.id ? " on" : ""}`} title={r.name} onClick={() => switchRoom(r.id)}>
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
                    <button className="btn ghost small" onClick={auto} title="Deja que el decorador distribuya estos mismos muebles">
                      Recolocar automáticamente
                    </button>
                  </div>
                  <div className="re-room-actions">
                    <button
                      className={`btn danger small${removal.blocked ? " blocked" : ""}`}
                      title={removal.blocked ?? "Mandar esta sala a la papelera (se puede recuperar)"}
                      disabled={deleting}
                      onClick={deleteRoom}
                    >
                      {deleting ? "Borrando…" : "Borrar sala"}
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
                </>
              )}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
