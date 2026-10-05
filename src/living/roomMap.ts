/**
 * Visión espacial de una sala para los agentes: plano en texto (mapa ASCII),
 * coordenadas de cada mueble, puertas y pasarelas, huecos libres, avisos de
 * coherencia y búsqueda de sitio «junto a» otro mueble.
 *
 * Lógica pura (sin BD ni Pixi): la usan las herramientas `sala_ver`,
 * `sala_mover_mueble` y `sala_decorar`. Mismas reglas que el editor de sala
 * (`roomEditor.ts`): x crece hacia la derecha del plano (columnas) e y hacia
 * abajo (filas); (x, y) es la esquina superior izquierda de la huella.
 */

import { DESK_SETS, doorTiles } from "./decorator";
import { FURNITURE, footprint } from "./furniture";
import { buildingOf, computeDoors, computeWalkways, walkwayDoors } from "./house";
import { cellsOf, checkItem, layoutWarnings, surfaceAt, topsOf, wallSpan, type EditContext } from "./roomEditor";
import { currentRoom, roomOwnerLabel } from "./presence";
import type { Agent, FurnitureItem, Room } from "../lib/types";

// ───────────── Ids cortos ─────────────

/** Id corto de cada mueble: el final de su id (4 caracteres o más, hasta que no se repita en la sala). */
export function shortIds(items: Pick<FurnitureItem, "id">[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const it of items) {
    let n = Math.min(4, it.id.length);
    while (n < it.id.length && items.some((o) => o.id !== it.id && o.id.endsWith(it.id.slice(-n)))) n++;
    out.set(it.id, it.id.slice(-n));
  }
  return out;
}

/** Busca un mueble por id completo o por id corto (final del id). Error si no está o es ambiguo. */
export function findItemRef(items: FurnitureItem[], ref: string): { item?: FurnitureItem; error?: string } {
  const r = ref.trim().replace(/^\[|\]$/g, "").replace(/^id\s+/i, "");
  if (!r) return { error: "Indica el id del mueble (sale en sala_ver)." };
  const exact = items.find((it) => it.id === r);
  if (exact) return { item: exact };
  const low = r.toLowerCase();
  const matches = items.filter((it) => it.id.toLowerCase().endsWith(low));
  if (matches.length === 1) return { item: matches[0] };
  if (matches.length > 1) return { error: `El id «${r}» es ambiguo: usa el id que muestra sala_ver.` };
  return { error: `No hay ningún mueble con id «${r}» en esta sala. Mira los ids con sala_ver.` };
}

const label = (kind: string) => FURNITURE[kind]?.label ?? kind;

/** Nombre corto para mensajes: «Silla [3f9a]». */
export function itemName(it: FurnitureItem, ids?: Map<string, string>): string {
  return `${label(it.kind)} [${ids?.get(it.id) ?? it.id.slice(-4)}]`;
}

// ───────────── Puertas y pasarelas ─────────────

export type Side = "norte" | "sur" | "oeste" | "este";

export interface Opening {
  side: Side;
  /** Baldosas de la puerta a lo largo de su lado (coordenadas de la sala, `to` excluido). */
  from: number;
  to: number;
  /** Sala a la que lleva y si es la entrada de una pasarela entre edificios. */
  toRoom: string;
  walkway: boolean;
}

/** Puertas reales de una sala (a otras salas del edificio y a pasarelas acristaladas). */
export function roomOpenings(room: Room, rooms: Room[]): Opening[] {
  const walkways = computeWalkways(rooms);
  const doors = [...computeDoors(rooms), ...walkways.flatMap(walkwayDoors)];
  const out: Opening[] = [];
  for (const d of doors) {
    if (!d.rooms.includes(room.id)) continue;
    const otherId = d.rooms[0] === room.id ? d.rooms[1] : d.rooms[0];
    const ww = walkways.find((w) => w.id === otherId);
    const farId = ww ? (ww.rooms[0] === room.id ? ww.rooms[1] : ww.rooms[0]) : otherId;
    const toRoom = rooms.find((r) => r.id === farId)?.name ?? "?";
    let side: Side | null = null;
    let base = 0;
    if (d.axis === "x" && d.at === room.x) [side, base] = ["oeste", room.y];
    else if (d.axis === "x" && d.at === room.x + room.w) [side, base] = ["este", room.y];
    else if (d.axis === "y" && d.at === room.y) [side, base] = ["norte", room.x];
    else if (d.axis === "y" && d.at === room.y + room.d) [side, base] = ["sur", room.x];
    if (!side) continue;
    out.push({ side, from: d.from - base, to: d.to - base, toRoom, walkway: Boolean(ww) });
  }
  const order: Side[] = ["norte", "oeste", "este", "sur"];
  return out.sort((a, b) => order.indexOf(a.side) - order.indexOf(b.side) || a.from - b.from);
}

// ───────────── Huecos libres ─────────────

/** Baldosas donde cabe un mueble de suelo: sin otro mueble (las alfombras se pueden cubrir) y fuera del paso de las puertas. */
export function placeableGrid(items: FurnitureItem[], ctx: Pick<EditContext, "w" | "d">): boolean[] {
  const { w, d } = ctx;
  const free = new Array(w * d).fill(true);
  for (const [x, y] of doorTiles(w, d)) free[y * w + x] = false;
  for (const it of items) {
    if (FURNITURE[it.kind]?.walkable) continue;
    for (const [x, y] of cellsOf(it)) if (x >= 0 && y >= 0 && x < w && y < d) free[y * w + x] = false;
  }
  return free;
}

export interface FreeZone {
  x: number;
  y: number;
  w: number;
  d: number;
}

/** Huecos rectangulares libres más grandes (sin solaparse entre sí), de mayor a menor. */
export function freeZones(items: FurnitureItem[], ctx: Pick<EditContext, "w" | "d">, max = 5, minArea = 2): FreeZone[] {
  const { w, d } = ctx;
  const free = placeableGrid(items, ctx);
  const out: FreeZone[] = [];
  while (out.length < max) {
    // Sumas acumuladas para comprobar cada rectángulo en O(1).
    const S = new Array((w + 1) * (d + 1)).fill(0);
    for (let y = 0; y < d; y++)
      for (let x = 0; x < w; x++) S[(y + 1) * (w + 1) + x + 1] = (free[y * w + x] ? 1 : 0) + S[y * (w + 1) + x + 1] + S[(y + 1) * (w + 1) + x] - S[y * (w + 1) + x];
    const sum = (x0: number, y0: number, x1: number, y1: number) => S[y1 * (w + 1) + x1] - S[y0 * (w + 1) + x1] - S[y1 * (w + 1) + x0] + S[y0 * (w + 1) + x0];
    let best: FreeZone | null = null;
    for (let y0 = 0; y0 < d; y0++)
      for (let x0 = 0; x0 < w; x0++)
        for (let y1 = y0 + 1; y1 <= d; y1++)
          for (let x1 = x0 + 1; x1 <= w; x1++) {
            const area = (x1 - x0) * (y1 - y0);
            if (area <= (best ? best.w * best.d : 0) || sum(x0, y0, x1, y1) !== area) continue;
            best = { x: x0, y: y0, w: x1 - x0, d: y1 - y0 };
          }
    if (!best || best.w * best.d < minArea) break;
    out.push(best);
    for (let y = best.y; y < best.y + best.d; y++) for (let x = best.x; x < best.x + best.w; x++) free[y * w + x] = false;
  }
  return out;
}

// ───────────── Coherencia ─────────────

const CHAIRS = new Set(Object.values(DESK_SETS).map(([chair]) => chair));
const DESKS = new Set(Object.values(DESK_SETS).map(([, desk]) => desk));

/** Hacia dónde mira un asiento: +x sin girar y +y girado (según su definición). */
export function seatFacing(it: Pick<FurnitureItem, "kind" | "flip">): "+x" | "+y" | null {
  const seat = FURNITURE[it.kind]?.seat;
  if (!seat) return null;
  const base = seat.face.endsWith("y") ? "y" : "x";
  const axis = it.flip ? (base === "x" ? "y" : "x") : base;
  return axis === "x" ? "+x" : "+y";
}

/** Baldosa que tiene delante un asiento. */
function frontTile(it: FurnitureItem): [number, number] | null {
  const f = seatFacing(it);
  if (!f) return null;
  return f === "+x" ? [it.x + 1, it.y] : [it.x, it.y + 1];
}

const deskAt = (items: FurnitureItem[], x: number, y: number) =>
  items.find((o) => FURNITURE[o.kind]?.desk && !FURNITURE[o.kind]?.onTop && cellsOf(o).some(([cx, cy]) => cx === x && cy === y));

/**
 * Avisos de coherencia (no bloquean): los del editor (puertas tapadas,
 * rincones, asientos encerrados), sillas sin mesa delante, escritorios sin
 * silla, objetos flotando, adornos sin muro y solapes heredados.
 */
export function coherenceWarnings(items: FurnitureItem[], ctx: EditContext, name: (it: FurnitureItem) => string = (it) => itemName(it)): string[] {
  const out = layoutWarnings(items, ctx);
  for (const it of items) {
    const def = FURNITURE[it.kind];
    if (!def) continue;
    if (CHAIRS.has(it.kind)) {
      const front = frontTile(it)!;
      if (!deskAt(items, front[0], front[1])) {
        const near = [
          [it.x + 1, it.y],
          [it.x - 1, it.y],
          [it.x, it.y + 1],
          [it.x, it.y - 1],
        ]
          .map(([x, y]) => deskAt(items, x, y))
          .find(Boolean);
        out.push(
          near
            ? `${name(it)} está junto a ${name(near)} pero no mira hacia ella (sin girar mira a +x; girada, a +y): muévela a su izquierda o, girada, encima.`
            : `${name(it)} no tiene ninguna mesa delante.`,
        );
      }
    }
    if (DESKS.has(it.kind)) {
      const cells = new Set(cellsOf(it).map(([x, y]) => `${x},${y}`));
      const chair = items.some((o) => FURNITURE[o.kind]?.seat && cells.has((frontTile(o) ?? []).join(",")));
      if (!chair) out.push(`${name(it)} no tiene ninguna silla delante.`);
    }
    if (def.onTop && !surfaceAt(items, it.x, it.y)) out.push(`${name(it)} está flotando: no hay mesa debajo.`);
    if (def.wall) {
      const { side, from, to } = wallSpan(it);
      const avail = side === "n" ? ctx.northWall : ctx.westWall;
      for (let i = from; i < to; i++)
        if (!avail[i]) {
          out.push(`${name(it)} no se ve: ahí no hay muro alto.`);
          break;
        }
    }
  }
  // Solapes que vengan de antes (el editor y las herramientas ya no los permiten).
  const floor = items.filter((it) => FURNITURE[it.kind] && !FURNITURE[it.kind].wall && !FURNITURE[it.kind].onTop);
  for (let i = 0; i < floor.length; i++)
    for (let j = i + 1; j < floor.length; j++) {
      const a = floor[i];
      const b = floor[j];
      if (Boolean(FURNITURE[a.kind].walkable) !== Boolean(FURNITURE[b.kind].walkable)) continue;
      const cells = new Set(cellsOf(a).map(([x, y]) => `${x},${y}`));
      if (cellsOf(b).some(([x, y]) => cells.has(`${x},${y}`))) out.push(`${name(a)} y ${name(b)} se solapan.`);
    }
  return out;
}

/** Muebles con los que choca `item` (para dar el id en el aviso). */
export function conflictsOf(others: FurnitureItem[], item: FurnitureItem): FurnitureItem[] {
  const def = FURNITURE[item.kind];
  if (!def) return [];
  if (def.wall) {
    const s = wallSpan(item);
    return others.filter((o) => {
      if (!FURNITURE[o.kind]?.wall) return false;
      const t = wallSpan(o);
      return t.side === s.side && t.from < s.to && s.from < t.to;
    });
  }
  if (def.onTop) return others.filter((o) => FURNITURE[o.kind]?.onTop && o.x === item.x && o.y === item.y);
  const keys = new Set(cellsOf(item).map(([x, y]) => `${x},${y}`));
  return others.filter((o) => {
    const od = FURNITURE[o.kind];
    if (!od || od.wall || od.onTop || Boolean(od.walkable) !== Boolean(def.walkable)) return false;
    return cellsOf(o).some(([x, y]) => keys.has(`${x},${y}`));
  });
}

/** Motivo de rechazo con detalle: con quién choca (id y posición) o cómo se cuelga en la pared. */
export function explainRejection(others: FurnitureItem[], item: FurnitureItem, ctx: EditContext, ids?: Map<string, string>): string | null {
  const error = checkItem(others, item, ctx);
  if (!error) return null;
  const hits = conflictsOf(others, item);
  if (hits.length) return `Choca con ${hits.map((h) => `${itemName(h, ids)} en (${h.x},${h.y})`).join(", ")}.`;
  if (FURNITURE[item.kind]?.wall) return `${error} (muro norte: y=0 sin girar; muro oeste: x=0 girado; solo donde el plano marca «#»).`;
  if (/puerta/.test(error)) return `${error} (las baldosas «:» del centro de cada lado son paso de puerta).`;
  return error;
}

// ───────────── Sitio «junto a» otro mueble ─────────────

export interface Spot {
  x: number;
  y: number;
  flip: boolean;
}

/**
 * Posiciones candidatas para poner un mueble de tipo `kind` junto a `target`,
 * de mejor a peor (sin validar: el que llama prueba cada una):
 * - objeto pequeño + superficie → encima;
 * - silla/asiento + mesa → mirando a la mesa (a su izquierda o, girado, encima);
 * - mesa + asiento → delante del asiento;
 * - el resto → pegado a su huella (lo más cerca primero).
 */
export function spotsNear(kind: string, target: FurnitureItem, ctx: Pick<EditContext, "w" | "d">): Spot[] {
  const def = FURNITURE[kind];
  const tdef = FURNITURE[target.kind];
  if (!def || !tdef) return [];
  const out: Spot[] = [];
  const seen = new Set<string>();
  const add = (s: Spot) => {
    const k = `${s.x},${s.y},${s.flip}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(s);
    }
  };
  const tcells = cellsOf(target);
  const tfp = footprint(target.kind, target.flip);

  if (def.onTop) {
    if (tdef.surface && !tdef.onTop && !tdef.wall) for (const [x, y] of tcells) add({ x, y, flip: false });
    return out;
  }
  if (def.wall) {
    // A lo largo de los muros, empezando por lo más cerca del objetivo.
    const cands: (Spot & { dist: number })[] = [];
    for (let x = 0; x < ctx.w; x++) cands.push({ x, y: 0, flip: false, dist: Math.abs(x - target.x) + target.y });
    for (let y = 0; y < ctx.d; y++) cands.push({ x: 0, y, flip: true, dist: Math.abs(y - target.y) + target.x });
    return cands.sort((a, b) => a.dist - b.dist).map(({ x, y, flip }) => ({ x, y, flip }));
  }
  if (def.seat && tdef.desk && !tdef.onTop) {
    // Sin girar mira a +x (a la izquierda de la mesa); girado mira a +y (encima de ella).
    const sf = seatFacing({ kind, flip: false });
    for (let dy = 0; dy < tfp.d; dy++) add({ x: target.x - 1, y: target.y + dy, flip: sf !== "+x" });
    for (let dx = 0; dx < tfp.w; dx++) add({ x: target.x + dx, y: target.y - 1, flip: sf === "+x" });
  }
  if (def.desk && tdef.seat) {
    const front = frontTile(target)!;
    for (const flip of [true, false]) {
      const fp = footprint(kind, flip);
      for (let dy = 0; dy < fp.d; dy++) for (let dx = 0; dx < fp.w; dx++) add({ x: front[0] - dx, y: front[1] - dy, flip });
    }
  }
  // Pegado a la huella del objetivo: por distancia entre huellas y después entre centros.
  const generic: (Spot & { gap: number; dist: number })[] = [];
  for (const flip of [false, true]) {
    const fp = footprint(kind, flip);
    for (let y = 0; y + fp.d <= ctx.d; y++)
      for (let x = 0; x + fp.w <= ctx.w; x++) {
        const gx = Math.max(target.x - (x + fp.w), x - (target.x + tfp.w), -1);
        const gy = Math.max(target.y - (y + fp.d), y - (target.y + tfp.d), -1);
        if (gx < 0 && gy < 0) continue; // se solapa con el objetivo
        const gap = Math.max(gx, gy, 0);
        const dist = Math.abs(x + fp.w / 2 - (target.x + tfp.w / 2)) + Math.abs(y + fp.d / 2 - (target.y + tfp.d / 2));
        generic.push({ x, y, flip, gap, dist });
      }
  }
  generic.sort((a, b) => a.gap - b.gap || a.dist - b.dist || Number(a.flip) - Number(b.flip));
  for (const g of generic) add({ x: g.x, y: g.y, flip: g.flip });
  return out;
}

/** Posiciones válidas más cercanas a (x, y) para un mueble (para sugerir alternativas). */
export function nearestValid(others: FurnitureItem[], base: Omit<FurnitureItem, "x" | "y">, x: number, y: number, ctx: EditContext, max = 3): [number, number][] {
  const out: [number, number][] = [];
  const cands: [number, number][] = [];
  for (let cy = 0; cy < ctx.d; cy++) for (let cx = 0; cx < ctx.w; cx++) cands.push([cx, cy]);
  cands.sort((a, b) => Math.abs(a[0] - x) + Math.abs(a[1] - y) - (Math.abs(b[0] - x) + Math.abs(b[1] - y)));
  for (const [cx, cy] of cands) {
    if (checkItem(others, { ...base, x: cx, y: cy } as FurnitureItem, ctx)) continue;
    out.push([cx, cy]);
    if (out.length >= max) break;
  }
  return out;
}

// ───────────── Plano en texto ─────────────

const FLOOR_MARKS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789$%&*?!";
const WALL_MARKS = "abcdefghijklmnopqrstuvwxyz";

export interface RoomMap {
  /** Líneas del plano (con cabecera de columnas). */
  lines: string[];
  /** Letra de cada mueble de suelo o de pared (los objetos encima no tienen). */
  marks: Map<string, string>;
}

/**
 * Plano ASCII de la sala. Borde superior = muro norte, izquierdo = muro oeste
 * (los únicos donde se cuelgan adornos), inferior = sur y derecho = este.
 */
export function renderRoomMap(room: Pick<Room, "w" | "d">, items: FurnitureItem[], ctx: EditContext, openings: Opening[] = []): RoomMap {
  const { w, d } = room;
  const marks = new Map<string, string>();
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  let fi = 0;
  let wi = 0;
  for (const it of sorted) {
    const def = FURNITURE[it.kind];
    if (!def || def.onTop) continue;
    if (def.wall) marks.set(it.id, WALL_MARKS[wi++ % WALL_MARKS.length]);
    else marks.set(it.id, FLOOR_MARKS[fi++ % FLOOR_MARKS.length]);
  }
  const cell: string[][] = Array.from({ length: d }, () => new Array(w).fill("."));
  for (const [x, y] of doorTiles(w, d)) cell[y][x] = ":";
  // Primero las alfombras y después lo demás (que queda encima).
  for (const walkable of [true, false])
    for (const it of sorted) {
      const def = FURNITURE[it.kind];
      if (!def || def.wall || def.onTop || Boolean(def.walkable) !== walkable) continue;
      for (const [x, y] of cellsOf(it)) if (x >= 0 && y >= 0 && x < w && y < d) cell[y][x] = walkable ? "~" : marks.get(it.id)!;
    }
  const doorMark = (side: Side, i: number) => {
    const o = openings.find((op) => op.side === side && i >= op.from && i < op.to);
    return o ? (o.walkway ? "≈" : "=") : null;
  };
  const north: string[] = Array.from({ length: w }, (_, x) => doorMark("norte", x) ?? (ctx.northWall[x] ? "#" : "-"));
  const west: string[] = Array.from({ length: d }, (_, y) => doorMark("oeste", y) ?? (ctx.westWall[y] ? "#" : "-"));
  for (const it of sorted) {
    if (!FURNITURE[it.kind]?.wall) continue;
    const { side, from, to } = wallSpan(it);
    const line = side === "n" ? north : west;
    for (let i = from; i < to; i++) if (i >= 0 && i < line.length) line[i] = marks.get(it.id)!;
  }
  const south = Array.from({ length: w }, (_, x) => doorMark("sur", x) ?? "-");
  const east = Array.from({ length: d }, (_, y) => doorMark("este", y) ?? "-");
  const pad = String(Math.max(d - 1, 0)).length;
  const sp = " ".repeat(pad);
  const lines = [
    `${sp}   ${Array.from({ length: w }, (_, x) => x % 10).join(" ")}`,
    `${sp} + ${north.join(" ")} +`,
    ...cell.map((row, y) => `${String(y).padStart(pad)} ${west[y]} ${row.join(" ")} ${east[y]}`),
    `${sp} + ${south.join(" ")} +`,
  ];
  return { lines, marks };
}

// ───────────── Descripción completa (sala_ver) ─────────────

function describeItem(it: FurnitureItem): string {
  const def = FURNITURE[it.kind];
  const fp = footprint(it.kind, it.flip);
  if (def?.wall) {
    const { side, from, to } = wallSpan(it);
    return side === "n" ? `muro norte, x=${from}${to - 1 > from ? `–${to - 1}` : ""} (y=0)` : `muro oeste, y=${from}${to - 1 > from ? `–${to - 1}` : ""} (x=0, girado)`;
  }
  const parts = [`(${it.x},${it.y})`, `${fp.w}×${fp.d}`];
  if (it.flip) parts.push("girado");
  const face = seatFacing(it);
  if (face) parts.push(`asiento, mira a ${face}`);
  if (def?.walkable) parts.push("alfombra, se pisa");
  return parts.join(" · ");
}

/**
 * Ficha espacial de una sala para un agente: tamaño, puertas, quién está,
 * plano ASCII con leyenda, muebles con id y coordenadas, huecos libres y avisos.
 */
export function describeRoomLayout(room: Room, rooms: Room[], agents: Agent[], ctx: EditContext): string {
  const items = room.furniture;
  const ids = shortIds(items);
  const openings = roomOpenings(room, rooms);
  const { lines, marks } = renderRoomMap(room, items, ctx, openings);
  const building = buildingOf(room);
  const name = (it: FurnitureItem) => `${label(it.kind)}${marks.get(it.id) ? ` ${marks.get(it.id)}` : ""} [${ids.get(it.id)}]`;

  const out: string[] = [];
  out.push(`Sala «${room.name}» (${roomOwnerLabel(room, agents)} · edificio ${building}) · ${room.w}×${room.d} baldosas: x de 0 a ${room.w - 1} (→), y de 0 a ${room.d - 1} (↓).`);
  out.push(
    `Puertas: ${
      openings.length
        ? openings.map((o) => `${o.side} ${o.side === "norte" || o.side === "sur" ? "x" : "y"}=${o.from}–${o.to - 1} → ${o.walkway ? "pasarela acristalada hasta " : ""}«${o.toRoom}»`).join("; ")
        : "ninguna (sala aislada)"
    }.`,
  );
  const inside = agents.filter((a) => currentRoom(a, rooms)?.id === room.id).map((a) => a.name);
  const seats = agents.filter((a) => a.deskSeatId && items.some((f) => f.id === a.deskSeatId));
  out.push(`Aquí ahora: ${inside.length ? inside.join(", ") : "nadie"} (los agentes caminan y se sientan; su posición exacta cambia).`);
  if (seats.length) out.push(`Puestos asignados: ${seats.map((a) => `${name(items.find((f) => f.id === a.deskSeatId)!)} → ${a.name}`).join(", ")}.`);

  out.push("", "Plano:", ...lines);
  out.push(
    "Leyenda: MAYÚSCULA/número = mueble de suelo · minúscula = adorno colgado · . libre · ~ alfombra (se pisa; admite muebles encima) · : paso de puerta (sin muebles) · # muro alto (norte y oeste: se puede colgar) · - sin muro alto / cerrado · = puerta · ≈ entrada de la pasarela.",
  );

  out.push("", "Muebles (x,y = esquina superior izquierda; ancho×fondo en baldosas; usa el id entre corchetes):");
  const floorAndWall = [...items].filter((it) => !FURNITURE[it.kind]?.onTop).sort((a, b) => (marks.get(a.id) ?? "").localeCompare(marks.get(b.id) ?? ""));
  const shown = new Set<string>();
  for (const it of floorAndWall) {
    out.push(`- ${name(it)}: ${describeItem(it)}${seats.find((a) => a.deskSeatId === it.id) ? ` · puesto de ${seats.find((a) => a.deskSeatId === it.id)!.name}` : ""}`);
    for (const top of topsOf(items, it)) {
      out.push(`    · encima: ${label(top.kind)} [${ids.get(top.id)}] en (${top.x},${top.y})`);
      shown.add(top.id);
    }
  }
  for (const it of items.filter((f) => FURNITURE[f.kind]?.onTop && !shown.has(f.id))) out.push(`- ${name(it)}: (${it.x},${it.y}) · sin mesa debajo`);
  for (const it of items.filter((f) => !FURNITURE[f.kind])) out.push(`- ${it.kind} [${ids.get(it.id)}]: mueble desconocido en (${it.x},${it.y})`);
  if (!items.length) out.push("- ninguno");

  const zones = freeZones(items, ctx);
  const freeCount = placeableGrid(items, ctx).filter(Boolean).length;
  out.push(
    "",
    `Suelo libre para muebles: ${freeCount} de ${room.w * room.d} baldosas.${zones.length ? ` Huecos más grandes (x,y ancho×fondo): ${zones.map((z) => `(${z.x},${z.y}) ${z.w}×${z.d}`).join(", ")}.` : ""}`,
  );
  const warnings = coherenceWarnings(items, ctx, name);
  out.push(warnings.length ? `Avisos:\n${warnings.map((w) => `- ${w}`).join("\n")}` : "Sin avisos: todo accesible y coherente.");
  return out.join("\n");
}
