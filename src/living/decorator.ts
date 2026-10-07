/**
 * Decorador automático de salas. Recibe una lista de muebles («puesto» =
 * escritorio + silla) y los coloca con reglas sencillas:
 * - adornos de pared en los muros altos disponibles, repartidos;
 * - muebles altos arrimados a las paredes del fondo;
 * - objetos pequeños encima de mesas;
 * - nunca tapa las puertas y siempre deja la sala transitable.
 *
 * Es determinista (semilla = id de la sala) para que no cambie al recargar.
 */

import { entranceTiles, FURNITURE, footprint } from "./furniture";
import type { FurnitureItem } from "../lib/types";

export interface DecorContext {
  w: number;
  d: number;
  /** Baldosas del borde norte / oeste con muro alto (donde se puede colgar algo). */
  northWall: boolean[];
  westWall: boolean[];
  seed: string;
}

export interface DecorResult {
  furniture: FurnitureItem[];
  placed: string[];
  skipped: string[];
}

function rng(seed: string) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

let counter = 0;
const newId = () => `f${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Baldosas donde puede abrirse una puerta (centro de cada lado). */
export function doorTiles(w: number, d: number): [number, number][] {
  const mx = Math.floor((w - 2) / 2);
  const my = Math.floor((d - 2) / 2);
  return [
    [mx, 0],
    [mx + 1, 0],
    [mx, d - 1],
    [mx + 1, d - 1],
    [0, my],
    [0, my + 1],
    [w - 1, my],
    [w - 1, my + 1],
  ];
}

class Layout {
  blocked: boolean[];
  seats: [number, number][] = [];
  northUsed: boolean[];
  westUsed: boolean[];
  rugs: boolean[];
  tops = new Set<string>();
  door = new Set<string>();

  constructor(
    public ctx: DecorContext,
    public items: FurnitureItem[],
  ) {
    const { w, d } = ctx;
    this.blocked = new Array(w * d).fill(false);
    this.rugs = new Array(w * d).fill(false);
    this.northUsed = new Array(w).fill(false);
    this.westUsed = new Array(d).fill(false);
    for (const [x, y] of doorTiles(w, d)) this.door.add(`${x},${y}`);
    for (const it of items) this.mark(it);
  }

  idx(x: number, y: number) {
    return y * this.ctx.w + x;
  }

  mark(it: FurnitureItem) {
    const def = FURNITURE[it.kind];
    if (!def) return;
    const fp = footprint(it.kind, it.flip);
    if (def.wall) {
      const used = it.flip ? this.westUsed : this.northUsed;
      const start = it.flip ? it.y : it.x;
      for (let i = start - 1; i < start + (it.flip ? fp.d : fp.w) + 1; i++) if (i >= 0 && i < used.length) used[i] = true;
      return;
    }
    if (def.onTop) {
      this.tops.add(`${it.x},${it.y}`);
      return;
    }
    for (let dy = 0; dy < fp.d; dy++)
      for (let dx = 0; dx < fp.w; dx++) {
        const x = it.x + dx;
        const y = it.y + dy;
        if (x < 0 || y < 0 || x >= this.ctx.w || y >= this.ctx.d) continue;
        if (def.walkable) this.rugs[this.idx(x, y)] = true;
        else this.blocked[this.idx(x, y)] = true;
      }
    if (def.seat) this.seats.push([it.x, it.y]);
    // La entrada (de un ascensor) queda libre, como un paso de puerta.
    for (const p of entranceTiles(it)) this.door.add(`${p.x},${p.y}`);
  }

  fits(x: number, y: number, fw: number, fd: number, walkable: boolean) {
    if (x < 0 || y < 0 || x + fw > this.ctx.w || y + fd > this.ctx.d) return false;
    for (let dy = 0; dy < fd; dy++)
      for (let dx = 0; dx < fw; dx++) {
        const i = this.idx(x + dx, y + dy);
        if (walkable ? this.rugs[i] : this.blocked[i] || this.door.has(`${x + dx},${y + dy}`)) return false;
      }
    return true;
  }

  /** Todo lo libre está conectado, las puertas libres y cada asiento accesible. */
  connected(extra: { x: number; y: number; fw: number; fd: number; seat?: boolean }[]): boolean {
    const { w, d } = this.ctx;
    const blocked = this.blocked.slice();
    for (const e of extra) for (let dy = 0; dy < e.fd; dy++) for (let dx = 0; dx < e.fw; dx++) blocked[this.idx(e.x + dx, e.y + dy)] = true;
    const free: number[] = [];
    for (let i = 0; i < blocked.length; i++) if (!blocked[i]) free.push(i);
    if (!free.length) return false;
    const seen = new Set([free[0]]);
    const queue = [free[0]];
    while (queue.length) {
      const i = queue.pop()!;
      const x = i % w;
      const y = Math.floor(i / w);
      for (const [nx, ny] of [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ]) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= d) continue;
        const j = this.idx(nx, ny);
        if (!blocked[j] && !seen.has(j)) {
          seen.add(j);
          queue.push(j);
        }
      }
    }
    if (seen.size !== free.length) return false;
    const seats = [...this.seats, ...extra.filter((e) => e.seat).map((e) => [e.x, e.y] as [number, number])];
    return seats.every(([sx, sy]) =>
      [
        [sx + 1, sy],
        [sx - 1, sy],
        [sx, sy + 1],
        [sx, sy - 1],
      ].some(([nx, ny]) => nx >= 0 && ny >= 0 && nx < w && ny < d && !blocked[this.idx(nx, ny)]),
    );
  }
}

function placeWall(L: Layout, kind: string): FurnitureItem | null {
  const def = FURNITURE[kind];
  const options: FurnitureItem[] = [];
  const tryWall = (flip: boolean) => {
    const avail = flip ? L.ctx.westWall : L.ctx.northWall;
    const used = flip ? L.westUsed : L.northUsed;
    const span = flip ? def.w : def.w; // la pieza ocupa def.w baldosas a lo largo del muro
    for (let i = 1; i + span <= avail.length - 1; i++) {
      let ok = true;
      for (let k = i; k < i + span; k++) if (!avail[k] || used[k]) ok = false;
      if (ok) options.push(flip ? { id: newId(), kind, x: 0, y: i, flip: true } : { id: newId(), kind, x: i, y: 0 });
    }
  };
  const northFree = L.northUsed.filter((u, i) => !u && L.ctx.northWall[i]).length;
  const westFree = L.westUsed.filter((u, i) => !u && L.ctx.westWall[i]).length;
  if (northFree >= westFree) {
    tryWall(false);
    tryWall(true);
  } else {
    tryWall(true);
    tryWall(false);
  }
  return options[0] ?? null;
}

function placeOnTop(L: Layout, kind: string): FurnitureItem | null {
  for (const it of L.items) {
    const def = FURNITURE[it.kind];
    if (!def?.desk) continue;
    const fp = footprint(it.kind, it.flip);
    for (let dy = 0; dy < fp.d; dy++)
      for (let dx = 0; dx < fp.w; dx++) {
        const key = `${it.x + dx},${it.y + dy}`;
        if (!L.tops.has(key)) return { id: newId(), kind, x: it.x + dx, y: it.y + dy, z: def.surface ?? 17 };
      }
  }
  return null;
}

/** Puestos de trabajo: nombre → [silla, escritorio]. */
export const DESK_SETS: Record<string, [string, string]> = {
  puesto: ["silla", "escritorio"],
  puesto_moderno: ["silla_ergonomica", "escritorio_moderno"],
};

function placeDeskSet(L: Layout, rand: () => number, [chair, desk]: [string, string]): FurnitureItem[] | null {
  const xs = [3, 2, 4, 5, 6, 1];
  const ys = [2, 3, 1, 5, 6, 4];
  const cands: [number, number][] = [];
  for (const y of ys) for (const x of xs) cands.push([x, y]);
  // Un poco de variedad entre salas, pero empezando por las mejores posiciones.
  const start = Math.floor(rand() * 3);
  for (const [cx, cy] of [...cands.slice(start), ...cands.slice(0, start)]) {
    if (!L.fits(cx, cy, 1, 1, false) || !L.fits(cx + 1, cy, 1, 2, false)) continue;
    const parts = [
      { x: cx, y: cy, fw: 1, fd: 1, seat: true },
      { x: cx + 1, y: cy, fw: 1, fd: 2 },
    ];
    if (!L.connected(parts)) continue;
    return [
      { id: newId(), kind: chair, x: cx, y: cy },
      { id: newId(), kind: desk, x: cx + 1, y: cy, flip: true },
    ];
  }
  return null;
}

function placeFloor(L: Layout, kind: string, rand: () => number): FurnitureItem | null {
  const def = FURNITURE[kind];
  const { w, d } = L.ctx;
  const cands: { x: number; y: number; flip: boolean; score: number }[] = [];
  for (const flip of [false, true]) {
    const fp = footprint(kind, flip);
    for (let y = 0; y + fp.d <= d; y++)
      for (let x = 0; x + fp.w <= w; x++) {
        if (!L.fits(x, y, fp.w, fp.d, Boolean(def.walkable))) continue;
        let score = rand() * 0.8;
        const back = x === 0 || y === 0;
        if (def.entrance) {
          // De espaldas al muro y con la entrada dentro de la sala y sin tapar.
          const facing = flip ? x === 0 : y === 0;
          const front = entranceTiles({ kind, x, y, flip });
          if (!facing || front.some((p) => p.x >= w || p.y >= d || !L.fits(p.x, p.y, 1, 1, false))) continue;
          score += 6;
        }
        // Frente hacia la sala: en la pared oeste sin espejar, en la norte espejado.
        if (x === 0 && !flip) score += 2;
        if (y === 0 && flip) score += 2;
        if (def.tall) score += back ? 4 : -3;
        else if (def.walkable) score += 3 - (Math.abs(x + fp.w / 2 - w / 2) + Math.abs(y + fp.d / 2 - d / 2)) / 2;
        else score += back ? 1 : x + fp.w === w || y + fp.d === d ? 0.8 : 0;
        if (def.seat && !def.bed) score += 0.5;
        cands.push({ x, y, flip, score });
      }
  }
  cands.sort((a, b) => b.score - a.score);
  for (const c of cands) {
    const fp = footprint(kind, c.flip);
    if (!def.walkable && !L.connected([{ x: c.x, y: c.y, fw: fp.w, fd: fp.d, seat: Boolean(def.seat) }])) continue;
    return { id: newId(), kind, x: c.x, y: c.y, ...(c.flip && { flip: true }) };
  }
  return null;
}

/**
 * Añade muebles a una sala. «puesto» = silla + escritorio. Lo que ya hay
 * (también lo colocado a mano) no se mueve: lo nuevo va a un hueco libre.
 */
export function decorate(existing: FurnitureItem[], kinds: string[], ctx: DecorContext): DecorResult {
  const rand = rng(ctx.seed + existing.length);
  const items = existing.slice();
  const L = new Layout(ctx, items);
  const placed: string[] = [];
  const skipped: string[] = [];
  // Orden: puestos y muebles grandes primero, adornos y objetos encima al final.
  const order = (k: string) => (DESK_SETS[k] ? 0 : FURNITURE[k]?.tall ? 1 : FURNITURE[k]?.walkable ? 3 : FURNITURE[k]?.wall ? 4 : FURNITURE[k]?.onTop ? 5 : 2);
  for (const kind of [...kinds].sort((a, b) => order(a) - order(b))) {
    let added: FurnitureItem[] | null = null;
    if (DESK_SETS[kind]) added = placeDeskSet(L, rand, DESK_SETS[kind]);
    else {
      const def = FURNITURE[kind];
      if (!def) {
        skipped.push(kind);
        continue;
      }
      const one = def.wall ? placeWall(L, kind) : def.onTop ? placeOnTop(L, kind) : placeFloor(L, kind, rand);
      added = one ? [one] : null;
    }
    if (!added) {
      skipped.push(kind);
      continue;
    }
    for (const it of added) {
      items.push(it);
      L.mark(it);
    }
    placed.push(kind);
  }
  return { furniture: items, placed, skipped };
}

/**
 * Quita muebles por tipo (uno de cada). Prefiere los colocados automáticamente:
 * lo que el usuario ha puesto a mano es lo último que se quita.
 */
export function removeKinds(existing: FurnitureItem[], kinds: string[]): { furniture: FurnitureItem[]; removed: string[] } {
  const items = existing.slice();
  const removed: string[] = [];
  for (const k of kinds) {
    const auto = items.findIndex((it) => it.kind === k && !it.manual);
    const i = auto >= 0 ? auto : items.findIndex((it) => it.kind === k);
    if (i >= 0) {
      items.splice(i, 1);
      removed.push(k);
    }
  }
  return { furniture: items, removed };
}
