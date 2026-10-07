import { entranceTiles, FURNITURE, footprint } from "./furniture";
import type { Room } from "../lib/types";

/**
 * Plano de la casa: salas en una cuadrícula de huecos, puertas entre salas
 * vecinas, rejilla de navegación y búsqueda de caminos (A*).
 * Lógica pura, sin dependencias de render, para poder testearla.
 */

export const ROOM_SIZE = 10;
export const DOOR_WIDTH = 2;
/** Edificio por defecto: la casa de Orden. */
export const DEFAULT_BUILDING = "orden";
/** Baldosas de separación entre dos edificios (las salva una pasarela acristalada). */
export const BUILDING_GAP = 6;

export interface Point {
  x: number;
  y: number;
}

type Area = Pick<Room, "x" | "y" | "w" | "d">;

/** Edificio de una sala (las antiguas, sin dato, son de la casa de Orden). */
export function buildingOf(room: Pick<Room, "building">): string {
  return room.building || DEFAULT_BUILDING;
}

function overlaps(a: Area, b: Area, margin = 0): boolean {
  return a.x < b.x + b.w + margin && a.x + a.w > b.x - margin && a.y < b.y + b.d + margin && a.y + a.d > b.y - margin;
}

/** Huecos en orden de crecimiento «cuadrado»: (0,0) (1,0) (0,1) (1,1) (2,0)… */
export function slotOrder(count: number): Point[] {
  const out: Point[] = [];
  for (let ring = 0; out.length < count; ring++) {
    for (let y = 0; y < ring && out.length < count; y++) out.push({ x: ring, y });
    for (let x = 0; x <= ring && out.length < count; x++) out.push({ x, y: ring });
  }
  return out;
}

/**
 * Primera posición libre para una sala nueva (en baldosas) dentro de su
 * edificio. Cada edificio crece en cuadrado desde su esquina; uno nuevo
 * empieza a la derecha de todo lo construido, dejando `BUILDING_GAP` de hueco.
 * Nunca se pega a otro edificio: entre ellos siempre queda ese hueco.
 */
export function nextRoomPosition(rooms: (Area & Pick<Room, "building">)[], building = DEFAULT_BUILDING): Point {
  const mine = rooms.filter((r) => buildingOf(r) === building);
  const others = rooms.filter((r) => buildingOf(r) !== building);
  let origin: Point = { x: 0, y: 0 };
  if (mine.length) origin = { x: Math.min(...mine.map((r) => r.x)), y: Math.min(...mine.map((r) => r.y)) };
  else if (others.length) origin = { x: Math.max(...others.map((r) => r.x + r.w)) + BUILDING_GAP, y: Math.min(...others.map((r) => r.y)) };
  for (const slot of slotOrder(400)) {
    const cand = { x: origin.x + slot.x * ROOM_SIZE, y: origin.y + slot.y * ROOM_SIZE, w: ROOM_SIZE, d: ROOM_SIZE };
    if (rooms.some((r) => overlaps(cand, r))) continue;
    if (others.some((r) => overlaps(cand, r, BUILDING_GAP))) continue;
    return { x: cand.x, y: cand.y };
  }
  throw new Error("La casa está llena");
}

/** ¿Cabe una sala aquí sin pisar otra ni pegarse a otro edificio? */
export function roomFits(rooms: (Area & Pick<Room, "building">)[], cand: Area & Pick<Room, "building">): boolean {
  const b = buildingOf(cand);
  return !rooms.some((r) => overlaps(cand, r, buildingOf(r) === b ? 0 : BUILDING_GAP));
}

/** ¿Todas estas salas se comunican por puertas? (búsqueda en anchura desde la primera). */
export function roomsConnected(rooms: Room[]): boolean {
  if (rooms.length < 2) return true;
  const doors = computeDoors(rooms);
  const seen = new Set([rooms[0].id]);
  const queue = [rooms[0].id];
  while (queue.length) {
    const id = queue.shift()!;
    for (const d of doors) {
      const other = d.rooms[0] === id ? d.rooms[1] : d.rooms[1] === id ? d.rooms[0] : null;
      if (other && !seen.has(other)) {
        seen.add(other);
        queue.push(other);
      }
    }
  }
  return seen.size === rooms.length;
}

/** Pasarela acristalada elevada entre dos edificios: una franja de baldosas transitables. */
export interface Walkway extends Area {
  id: string;
  /** 'x' = va de oeste a este; 'y' = de norte a sur. */
  axis: "x" | "y";
  /** [sala de salida (oeste/norte), sala de llegada (este/sur)]. */
  rooms: [string, string];
}

/** Edificios en orden de aparición (el primero es la casa de Orden). */
function buildingOrder(rooms: Pick<Room, "building">[]): string[] {
  const order: string[] = [];
  for (const r of rooms) if (!order.includes(buildingOf(r))) order.push(buildingOf(r));
  return order;
}

// ───────────── Ascensor entre plantas ─────────────
// Un edificio que tiene ascensor (y la casa de Orden también) no se une con
// pasarela: se sube en ascensor. Se entra por la baldosa de delante de las
// puertas de un ascensor y se sale por la de delante del otro.

/** Mueble que hace de ascensor. */
export const ELEVATOR_KIND = "ascensor";

/** Parada de ascensor: baldosa (de la casa) delante de sus puertas. */
export interface ElevatorStop extends Point {
  roomId: string;
  building: string;
}

/** Une la parada de la casa de Orden con la de otro edificio. */
export interface ElevatorLink {
  id: string;
  stops: [ElevatorStop, ElevatorStop];
}

/** ¿Ocupa esa baldosa (relativa a la sala) un mueble que no se pisa? */
function occupied(room: Room, x: number, y: number): boolean {
  return room.furniture.some((f) => {
    const def = FURNITURE[f.kind];
    if (!def || def.walkable || def.wall || def.onTop) return false;
    const fp = footprint(f.kind, f.flip);
    return x >= f.x && x < f.x + fp.w && y >= f.y && y < f.y + fp.d;
  });
}

/**
 * Parada del primer ascensor de un edificio: la primera baldosa libre delante
 * de sus puertas (sin girar, las puertas miran al sur; girado, al este).
 */
export function elevatorStop(rooms: Room[], building: string): ElevatorStop | null {
  for (const room of rooms) {
    if (buildingOf(room) !== building) continue;
    for (const f of room.furniture) {
      if (f.kind !== ELEVATOR_KIND) continue;
      const free = entranceTiles(f).find((p) => p.x >= 0 && p.y >= 0 && p.x < room.w && p.y < room.d && !occupied(room, p.x, p.y));
      if (free) return { x: room.x + free.x, y: room.y + free.y, roomId: room.id, building };
    }
  }
  return null;
}

/** Ascensores que unen cada edificio con la casa de Orden (si ambos tienen uno). */
export function computeElevators(rooms: Room[]): ElevatorLink[] {
  const order = buildingOrder(rooms);
  if (order.length < 2) return [];
  const base = elevatorStop(rooms, order[0]);
  if (!base) return [];
  const out: ElevatorLink[] = [];
  for (const b of order.slice(1)) {
    const stop = elevatorStop(rooms, b);
    if (stop) out.push({ id: `ascensor:${b}`, stops: [base, stop] });
  }
  return out;
}

/**
 * Pasarelas que unen cada edificio con el primero (la casa de Orden): la más
 * corta entre dos salas enfrentadas, alineada con sus puertas centrales y sin
 * atravesar ninguna sala. Los edificios unidos por ascensor no llevan pasarela.
 */
export function computeWalkways(rooms: Room[]): Walkway[] {
  const order = buildingOrder(rooms);
  if (order.length < 2) return [];
  const base = rooms.filter((r) => buildingOf(r) === order[0]);
  const byElevator = new Set(computeElevators(rooms).map((l) => l.stops[1].building));
  const out: Walkway[] = [];
  for (const b of order.slice(1)) {
    if (byElevator.has(b)) continue;
    let best: Walkway | null = null;
    const id = `pasarela:${b}`;
    const consider = (cand: Walkway) => {
      if (rooms.some((r) => overlaps(cand, r))) return;
      const len = cand.w * cand.d;
      if (!best || len < best.w * best.d) best = cand;
    };
    for (const a of base)
      for (const c of rooms.filter((r) => buildingOf(r) === b))
        for (const [lo, hi] of [
          [a, c],
          [c, a],
        ]) {
          const row = lo.y + Math.floor((lo.d - DOOR_WIDTH) / 2);
          if (lo.x + lo.w < hi.x && row === hi.y + Math.floor((hi.d - DOOR_WIDTH) / 2))
            consider({ id, axis: "x", x: lo.x + lo.w, y: row, w: hi.x - lo.x - lo.w, d: DOOR_WIDTH, rooms: [lo.id, hi.id] });
          const col = lo.x + Math.floor((lo.w - DOOR_WIDTH) / 2);
          if (lo.y + lo.d < hi.y && col === hi.x + Math.floor((hi.w - DOOR_WIDTH) / 2))
            consider({ id, axis: "y", x: col, y: lo.y + lo.d, w: DOOR_WIDTH, d: hi.y - lo.y - lo.d, rooms: [lo.id, hi.id] });
        }
    if (best) out.push(best);
  }
  return out;
}

/** Las dos entradas de una pasarela (una en cada extremo). */
export function walkwayDoors(w: Walkway): Door[] {
  if (w.axis === "x")
    return [
      { axis: "x", at: w.x, from: w.y, to: w.y + w.d, rooms: [w.rooms[0], w.id] },
      { axis: "x", at: w.x + w.w, from: w.y, to: w.y + w.d, rooms: [w.id, w.rooms[1]] },
    ];
  return [
    { axis: "y", at: w.y, from: w.x, to: w.x + w.w, rooms: [w.rooms[0], w.id] },
    { axis: "y", at: w.y + w.d, from: w.x, to: w.x + w.w, rooms: [w.id, w.rooms[1]] },
  ];
}

export interface Door {
  /** Lado de la frontera: 'x' = frontera vertical en x (paso de x-1 a x). */
  axis: "x" | "y";
  /** Coordenada de la frontera. */
  at: number;
  /** Baldosas de la puerta a lo largo de la frontera. */
  from: number;
  to: number;
  rooms: [string, string];
}

/** Puertas en el centro de cada frontera compartida entre dos salas del mismo edificio. */
export function computeDoors(rooms: Room[]): Door[] {
  const doors: Door[] = [];
  for (const a of rooms) {
    for (const b of rooms) {
      if (a.id === b.id || buildingOf(a) !== buildingOf(b)) continue;
      // b a la derecha de a (frontera vertical en x = b.x)
      if (a.x + a.w === b.x) {
        const lo = Math.max(a.y, b.y);
        const hi = Math.min(a.y + a.d, b.y + b.d);
        if (hi - lo >= DOOR_WIDTH) {
          const mid = Math.floor((lo + hi - DOOR_WIDTH) / 2);
          doors.push({ axis: "x", at: b.x, from: mid, to: mid + DOOR_WIDTH, rooms: [a.id, b.id] });
        }
      }
      // b debajo de a (frontera horizontal en y = b.y)
      if (a.y + a.d === b.y) {
        const lo = Math.max(a.x, b.x);
        const hi = Math.min(a.x + a.w, b.x + b.w);
        if (hi - lo >= DOOR_WIDTH) {
          const mid = Math.floor((lo + hi - DOOR_WIDTH) / 2);
          doors.push({ axis: "y", at: b.y, from: mid, to: mid + DOOR_WIDTH, rooms: [a.id, b.id] });
        }
      }
    }
  }
  return doors;
}

export interface NavGrid {
  minX: number;
  minY: number;
  width: number;
  height: number;
  /** Índice de zona por baldosa (-1 = fuera): primero las salas y después las pasarelas. */
  room: Int16Array;
  /** Baldosa ocupada por un mueble. */
  blocked: Uint8Array;
  /** Ids de las zonas: salas (mismo orden que `rooms`) y pasarelas. */
  roomIds: string[];
  doors: Door[];
  walkways: Walkway[];
  /** Ascensores entre edificios (saltos entre dos baldosas lejanas). */
  elevators: ElevatorLink[];
}

export function buildNavGrid(rooms: Room[]): NavGrid {
  if (rooms.length === 0) {
    return { minX: 0, minY: 0, width: 0, height: 0, room: new Int16Array(0), blocked: new Uint8Array(0), roomIds: [], doors: [], walkways: [], elevators: [] };
  }
  const walkways = computeWalkways(rooms);
  const areas: Area[] = [...rooms, ...walkways];
  const minX = Math.min(...areas.map((r) => r.x));
  const minY = Math.min(...areas.map((r) => r.y));
  const maxX = Math.max(...areas.map((r) => r.x + r.w));
  const maxY = Math.max(...areas.map((r) => r.y + r.d));
  const width = maxX - minX;
  const height = maxY - minY;
  const room = new Int16Array(width * height).fill(-1);
  const blocked = new Uint8Array(width * height);
  walkways.forEach((w, k) => {
    for (let y = w.y; y < w.y + w.d; y++) for (let x = w.x; x < w.x + w.w; x++) room[(y - minY) * width + (x - minX)] = rooms.length + k;
  });
  rooms.forEach((r, i) => {
    for (let y = r.y; y < r.y + r.d; y++) for (let x = r.x; x < r.x + r.w; x++) room[(y - minY) * width + (x - minX)] = i;
    for (const f of r.furniture) {
      const def = FURNITURE[f.kind];
      if (!def || def.walkable || def.wall || def.onTop) continue;
      const fp = footprint(f.kind, f.flip);
      for (let dy = 0; dy < fp.d; dy++)
        for (let dx = 0; dx < fp.w; dx++) {
          const gx = r.x + f.x + dx - minX;
          const gy = r.y + f.y + dy - minY;
          if (gx >= 0 && gy >= 0 && gx < width && gy < height) blocked[gy * width + gx] = 1;
        }
    }
  });
  return {
    minX,
    minY,
    width,
    height,
    room,
    blocked,
    roomIds: [...rooms.map((r) => r.id), ...walkways.map((w) => w.id)],
    doors: [...computeDoors(rooms), ...walkways.flatMap(walkwayDoors)],
    walkways,
    elevators: computeElevators(rooms),
  };
}

/** Coste de un viaje en ascensor (en pasos): lo bastante para no usarlo de atajo dentro de un edificio. */
const ELEVATOR_COST = 4;

/** Paradas a las que se llega en ascensor desde esta baldosa. */
function elevatorExits(g: NavGrid, x: number, y: number): Point[] {
  const out: Point[] = [];
  for (const l of g.elevators ?? []) {
    const [a, b] = l.stops;
    if (a.x === x && a.y === y) out.push(b);
    else if (b.x === x && b.y === y) out.push(a);
  }
  return out;
}

/** Punto de un camino; `elevator` = se llega a él en ascensor (salto, no se camina). */
export interface PathPoint extends Point {
  elevator?: boolean;
}

function idx(g: NavGrid, x: number, y: number) {
  return (y - g.minY) * g.width + (x - g.minX);
}

export function inGrid(g: NavGrid, x: number, y: number): boolean {
  return x >= g.minX && y >= g.minY && x < g.minX + g.width && y < g.minY + g.height && g.room[idx(g, x, y)] >= 0;
}

export function roomIndexAt(g: NavGrid, x: number, y: number): number {
  return inGrid(g, x, y) ? g.room[idx(g, x, y)] : -1;
}

/** Baldosa transitable (dentro de una sala y sin mueble). */
export function isFree(g: NavGrid, x: number, y: number, allow?: Point): boolean {
  if (allow && allow.x === x && allow.y === y) return inGrid(g, x, y);
  return inGrid(g, x, y) && g.blocked[idx(g, x, y)] === 0;
}

/** ¿Se puede pasar entre dos baldosas vecinas ortogonales? (paredes y puertas) */
export function canStep(g: NavGrid, a: Point, b: Point): boolean {
  const ra = roomIndexAt(g, a.x, a.y);
  const rb = roomIndexAt(g, b.x, b.y);
  if (ra < 0 || rb < 0) return false;
  if (ra === rb) return true;
  if (a.x !== b.x && a.y === b.y) {
    const at = Math.max(a.x, b.x);
    return g.doors.some((d) => d.axis === "x" && d.at === at && a.y >= d.from && a.y < d.to);
  }
  if (a.y !== b.y && a.x === b.x) {
    const at = Math.max(a.y, b.y);
    return g.doors.some((d) => d.axis === "y" && d.at === at && a.x >= d.from && a.x < d.to);
  }
  return false;
}

const DIRS = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
  { x: 1, y: 1 },
  { x: 1, y: -1 },
  { x: -1, y: 1 },
  { x: -1, y: -1 },
];

/**
 * A* en 8 direcciones sin cortar esquinas. `goal` puede estar ocupado
 * (p. ej. una silla): se permite como destino final. Entre edificios unidos
 * por ascensor, el camino salta de una parada a la otra (punto con `elevator`).
 */
export function findPath(g: NavGrid, start: Point, goal: Point): PathPoint[] | null {
  if (!inGrid(g, start.x, start.y) || !inGrid(g, goal.x, goal.y)) return null;
  if (start.x === goal.x && start.y === goal.y) return [start];
  const N = g.width * g.height;
  const gScore = new Float64Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const viaElevator = new Uint8Array(N);
  const closed = new Uint8Array(N);
  const open: { i: number; f: number }[] = [];
  const octile = (x: number, y: number, to: Point) => {
    const dx = Math.abs(x - to.x);
    const dy = Math.abs(y - to.y);
    return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
  };
  // Heurística admisible también con ascensores: el mínimo entre ir directo o pasar por uno.
  const jumps = (g.elevators ?? []).flatMap((l) => [
    [l.stops[0], l.stops[1]],
    [l.stops[1], l.stops[0]],
  ]);
  const h = (x: number, y: number) =>
    Math.min(octile(x, y, goal), ...jumps.map(([from, to]) => octile(x, y, from) + ELEVATOR_COST + octile(to.x, to.y, goal)));
  const si = idx(g, start.x, start.y);
  gScore[si] = 0;
  open.push({ i: si, f: h(start.x, start.y) });
  const gi = idx(g, goal.x, goal.y);

  while (open.length) {
    let best = 0;
    for (let k = 1; k < open.length; k++) if (open[k].f < open[best].f) best = k;
    const { i } = open.splice(best, 1)[0];
    if (closed[i]) continue;
    if (i === gi) break;
    closed[i] = 1;
    const cx = (i % g.width) + g.minX;
    const cy = Math.floor(i / g.width) + g.minY;
    for (const d of DIRS) {
      const nx = cx + d.x;
      const ny = cy + d.y;
      if (!isFree(g, nx, ny, goal)) continue;
      const diagonal = d.x !== 0 && d.y !== 0;
      if (diagonal) {
        // Sin atajos por esquinas: ambas ortogonales deben ser libres y del mismo cuarto.
        const ox = { x: nx, y: cy };
        const oy = { x: cx, y: ny };
        if (!isFree(g, ox.x, ox.y) || !isFree(g, oy.x, oy.y)) continue;
        if (!canStep(g, { x: cx, y: cy }, ox) || !canStep(g, ox, { x: nx, y: ny })) continue;
        if (!canStep(g, { x: cx, y: cy }, oy) || !canStep(g, oy, { x: nx, y: ny })) continue;
      } else if (!canStep(g, { x: cx, y: cy }, { x: nx, y: ny })) continue;
      const ni = idx(g, nx, ny);
      if (closed[ni]) continue;
      const cost = gScore[i] + (diagonal ? Math.SQRT2 : 1);
      if (cost < gScore[ni]) {
        gScore[ni] = cost;
        came[ni] = i;
        viaElevator[ni] = 0;
        open.push({ i: ni, f: cost + h(nx, ny) });
      }
    }
    for (const exit of elevatorExits(g, cx, cy)) {
      if (!isFree(g, exit.x, exit.y, goal)) continue;
      const ni = idx(g, exit.x, exit.y);
      if (closed[ni]) continue;
      const cost = gScore[i] + ELEVATOR_COST;
      if (cost < gScore[ni]) {
        gScore[ni] = cost;
        came[ni] = i;
        viaElevator[ni] = 1;
        open.push({ i: ni, f: cost + h(exit.x, exit.y) });
      }
    }
  }
  if (came[gi] < 0) return null;
  const path: PathPoint[] = [];
  for (let i = gi; i >= 0; i = came[i]) {
    const p: PathPoint = { x: (i % g.width) + g.minX, y: Math.floor(i / g.width) + g.minY };
    if (viaElevator[i]) p.elevator = true;
    path.push(p);
    if (i === si) break;
  }
  return path.reverse();
}

/** Baldosas libres de una sala (para pasear). */
export function freeTilesInRoom(g: NavGrid, room: Room): Point[] {
  const out: Point[] = [];
  for (let y = room.y; y < room.y + room.d; y++)
    for (let x = room.x; x < room.x + room.w; x++) if (isFree(g, x, y)) out.push({ x, y });
  return out;
}
