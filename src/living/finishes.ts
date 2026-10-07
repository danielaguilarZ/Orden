/**
 * Catálogo de acabados de sala: suelos y paredes elegibles por sala (desde el
 * editor de sala o con la herramienta `sala_suelo_paredes` de los agentes).
 *
 * El estilo de cada sala ya se guarda como JSON (`rooms.style`), así que un
 * acabado solo fija sus colores y su patrón: no hace falta tocar la base de
 * datos para añadir más. Los acabados que coinciden con las plantillas
 * (`roomTemplates.ts`) se reconocen solos como «el actual».
 */

import type { RoomStyle } from "../lib/types";

export interface FloorFinish {
  id: string;
  label: string;
  floor: RoomStyle["floor"];
  floorA: string;
  floorB: string;
}

export interface WallFinish {
  id: string;
  label: string;
  /** Color del muro. */
  wall: string;
  /** Remate: zócalo, canto superior y tabiques bajos. */
  wallTrim: string;
}

export const FLOOR_FINISHES: FloorFinish[] = [
  { id: "roble", label: "Roble claro", floor: "madera", floorA: "#c49a6c", floorB: "#b68c5f" },
  { id: "haya", label: "Haya", floor: "madera", floorA: "#b98a5a", floorB: "#a87b4e" },
  { id: "cerezo", label: "Cerezo", floor: "madera", floorA: "#a97c50", floorB: "#9b7047" },
  { id: "arce", label: "Arce", floor: "madera", floorA: "#b08a62", floorB: "#a27d57" },
  { id: "nogal", label: "Nogal", floor: "madera", floorA: "#8a5a3b", floorB: "#7c5034" },
  { id: "pino", label: "Pino", floor: "madera", floorA: "#d9b98a", floorB: "#cdab7a" },
  { id: "baldosa_crema", label: "Baldosa crema", floor: "baldosa", floorA: "#e9e4d8", floorB: "#c9b99a" },
  { id: "baldosa_salvia", label: "Baldosa salvia", floor: "baldosa", floorA: "#cfd6cf", floorB: "#b9c3ba" },
  { id: "baldosa_piedra", label: "Baldosa piedra", floor: "baldosa", floorA: "#d8d3c4", floorB: "#c4bda9" },
  { id: "barro", label: "Barro cocido", floor: "baldosa", floorA: "#c47a55", floorB: "#b06a48" },
  { id: "marmol_blanco", label: "Mármol blanco", floor: "mármol", floorA: "#ecebe7", floorB: "#dcdbd6" },
  { id: "marmol_gris", label: "Mármol gris", floor: "mármol", floorA: "#d5d8dc", floorB: "#c3c7cc" },
  { id: "moqueta_verde", label: "Moqueta verde", floor: "moqueta", floorA: "#8fa58a", floorB: "#86a081" },
  { id: "moqueta_azul", label: "Moqueta azul", floor: "moqueta", floorA: "#5d7f8f", floorB: "#557686" },
  { id: "moqueta_arena", label: "Moqueta arena", floor: "moqueta", floorA: "#d9b77e", floorB: "#cfac72" },
  { id: "moqueta_granate", label: "Moqueta granate", floor: "moqueta", floorA: "#a9746e", floorB: "#9f6b65" },
  { id: "moqueta_gris", label: "Moqueta gris", floor: "moqueta", floorA: "#9a9a9e", floorB: "#8f8f94" },
  { id: "tatami", label: "Tatami", floor: "tatami", floorA: "#c9c27d", floorB: "#bdb672" },
  { id: "hormigon", label: "Hormigón gris", floor: "hormigón", floorA: "#b5b5b0", floorB: "#a8a8a3" },
  { id: "microcemento", label: "Microcemento claro", floor: "hormigón", floorA: "#d9d6cf", floorB: "#cfccc4" },
  { id: "roble_nordico", label: "Roble nórdico", floor: "madera", floorA: "#dcc39c", floorB: "#d2b88f" },
  { id: "porcelanico_negro", label: "Porcelánico negro", floor: "mármol", floorA: "#4a4d52", floorB: "#414449" },
];

export const WALL_FINISHES: WallFinish[] = [
  { id: "crema", label: "Crema", wall: "#efe3cf", wallTrim: "#7d6650" },
  { id: "lino", label: "Lino y nogal", wall: "#e6dccb", wallTrim: "#6b5440" },
  { id: "blanco_roto", label: "Blanco roto", wall: "#f2efe8", wallTrim: "#8a7f6e" },
  { id: "piedra", label: "Piedra", wall: "#d9d2c3", wallTrim: "#8a7f6e" },
  { id: "gris_perla", label: "Gris perla", wall: "#dfe3e8", wallTrim: "#5d6875" },
  { id: "gris_pizarra", label: "Gris pizarra", wall: "#e4e2da", wallTrim: "#4f5b66" },
  { id: "azul_niebla", label: "Azul niebla", wall: "#e3eef0", wallTrim: "#2f5d62" },
  { id: "azul_mar", label: "Azul mar", wall: "#e8f4f8", wallTrim: "#1f6f8b" },
  { id: "salvia", label: "Verde salvia", wall: "#e8e6dc", wallTrim: "#46624f" },
  { id: "lavanda", label: "Lavanda", wall: "#e6e1f0", wallTrim: "#5e4b8b" },
  { id: "rosa_palo", label: "Rosa palo", wall: "#f2e6dc", wallTrim: "#7b4b3a" },
  { id: "teja", label: "Arena y teja", wall: "#f3ead6", wallTrim: "#a0522d" },
  { id: "biblioteca", label: "Marfil y caoba", wall: "#e9dfc9", wallTrim: "#4e3626" },
  { id: "ocre", label: "Ocre", wall: "#ece6d6", wallTrim: "#6d5d3f" },
  { id: "azul_noche", label: "Azul noche", wall: "#e8edf2", wallTrim: "#34495e" },
  { id: "blanco_puro", label: "Blanco puro", wall: "#f7f7f5", wallTrim: "#3a3f45" },
  { id: "grafito", label: "Grafito", wall: "#cfd3d8", wallTrim: "#2a2e35" },
  { id: "verde_bosque", label: "Verde bosque", wall: "#dfe6df", wallTrim: "#2f4a3a" },
];

function normalize(text: string) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[\s_-]+/g, " ")
    .trim();
}

/**
 * Busca un acabado por id o por nombre (sin tildes ni mayúsculas; «moqueta azul» = «moqueta_azul»).
 * Un trozo del nombre vale solo si no es ambiguo («granate» sí; «moqueta» no).
 */
function findIn<T extends { id: string; label: string }>(list: T[], ref: string): T | undefined {
  const n = normalize(ref);
  if (!n) return undefined;
  const exact = list.find((f) => normalize(f.id) === n || normalize(f.label) === n);
  if (exact) return exact;
  const partial = list.filter((f) => normalize(f.label).includes(n));
  return partial.length === 1 ? partial[0] : undefined;
}

export const findFloorFinish = (ref: string) => findIn(FLOOR_FINISHES, ref);
export const findWallFinish = (ref: string) => findIn(WALL_FINISHES, ref);

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Acabado de suelo que lleva ahora la sala (null si es uno a medida). */
export function currentFloorFinish(style: RoomStyle): FloorFinish | null {
  return FLOOR_FINISHES.find((f) => f.floor === style.floor && same(f.floorA, style.floorA) && same(f.floorB, style.floorB)) ?? null;
}

/** Acabado de pared que lleva ahora la sala (null si es uno a medida). */
export function currentWallFinish(style: RoomStyle): WallFinish | null {
  return WALL_FINISHES.find((w) => same(w.wall, style.wall) && same(w.wallTrim, style.wallTrim)) ?? null;
}

/** Estilo de sala con el suelo y/o la pared elegidos (lo que no se indica, se queda). */
export function applyFinish(style: RoomStyle, pick: { floor?: FloorFinish | null; wall?: WallFinish | null }): RoomStyle {
  const next = { ...style };
  if (pick.floor) Object.assign(next, { floor: pick.floor.floor, floorA: pick.floor.floorA, floorB: pick.floor.floorB });
  if (pick.wall) Object.assign(next, { wall: pick.wall.wall, wallTrim: pick.wall.wallTrim });
  return next;
}

/** «roble (roble claro), nogal (nogal)…» para el prompt de los agentes. */
export function describeFinishes(list: { id: string; label: string }[]): string {
  return list.map((f) => (normalize(f.id) === normalize(f.label) ? f.id : `${f.id} (${f.label.toLowerCase()})`)).join(", ");
}
