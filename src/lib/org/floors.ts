import { listRooms } from "../repo/rooms";
import { setFloorNames } from "../roomTemplates";
import { buildingOf, levelOf } from "../../living/house";
import { listUnits } from "./repo";

/**
 * Nombre de cada planta según las unidades que trabajan en ella (su zona del
 * living). Las plantas sin unidad conservan su nombre fijo (p. ej. Vestíbulo).
 */
export function unitFloorNames(): Record<number, string> {
  const rooms = listRooms();
  const names: Record<number, string> = {};
  for (const u of listUnits()) {
    const room = u.building ? rooms.find((r) => buildingOf(r) === u.building) : null;
    if (!room) continue;
    const level = levelOf(room);
    names[level] = names[level] ? `${names[level]} · ${u.name}` : u.name;
  }
  return names;
}

/** Fija los nombres de planta para este proceso y los devuelve (para la web). */
export function syncFloorNames(): Record<number, string> {
  const names = unitFloorNames();
  setFloorNames(names);
  return names;
}
