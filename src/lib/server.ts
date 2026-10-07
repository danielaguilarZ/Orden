import { ensureSeed } from "./seed";
import { syncFloorNames } from "./org/floors";
import { listAgents } from "./repo/agents";
import { listRooms } from "./repo/rooms";
import { getHeartbeat } from "./repo/system";
import { lastEventId } from "./events";
import { getStoredUsage } from "./claude/usage";
import { ensureFilesSeed } from "./files/repo";
import { countPending } from "./decisions/repo";

/** Arranque perezoso en el servidor: BD migrada y casa sembrada. */
let booted = false;
export function boot() {
  if (booted) return;
  ensureSeed();
  ensureFilesSeed();
  booted = true;
}

export function systemStatus() {
  return { worker: getHeartbeat("worker"), now: new Date().toISOString() };
}

export function snapshot() {
  boot();
  return {
    floorNames: syncFloorNames(),
    agents: listAgents(),
    rooms: listRooms(),
    usage: getStoredUsage(),
    system: systemStatus(),
    decisionsPending: countPending(),
    lastEventId: lastEventId(),
  };
}

export type Snapshot = ReturnType<typeof snapshot>;
