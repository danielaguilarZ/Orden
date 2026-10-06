/**
 * Worker de Orden: proceso independiente que ejecuta encargos y rutinas en
 * segundo plano para que la web nunca se bloquee. Escribe un latido cada 10 s.
 */
import { getDb } from "../src/lib/db";
import { pruneEvents } from "../src/lib/events";
import { beat, logActivity } from "../src/lib/repo/system";
import { ensureSeed } from "../src/lib/seed";
import { claimNextTask, countRunning, failOrphanedTasks, getTask } from "../src/lib/repo/tasks";
import { listAgents, setAgentStatus } from "../src/lib/repo/agents";
import { runTask } from "../src/lib/agents/runner";
import "../src/lib/agents/modules";
import { tickRoutines } from "../src/lib/routines/runner";
import { refreshUsage } from "../src/lib/claude/usage";
import { ensureFilesSeed } from "../src/lib/files/repo";
import { dispatchAnswered } from "../src/lib/decisions/repo";

const HEARTBEAT_MS = 10_000;
const TICK_MS = 400;
const ROUTINE_TICK_MS = 15_000;
const USAGE_EVERY_MS = 5 * 60_000;

/** Límites de Claude: periódicamente y poco después de cada encargo (no gasta uso). */
let usageTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleUsage(delayMs = 15_000) {
  if (usageTimer) clearTimeout(usageTimer);
  usageTimer = setTimeout(() => {
    refreshUsage()
      .then((u) => u.error && log("Límites de Claude:", u.error))
      .catch((err) => log("Límites de Claude:", err));
  }, delayMs);
}
const MAX = Math.max(1, Number(process.env.ORDEN_MAX_CONCURRENCY ?? 3));
const startedAt = new Date().toISOString();
const running = new Map<string, AbortController>();

function log(...args: unknown[]) {
  console.log(`[worker ${new Date().toLocaleTimeString("es-ES")}]`, ...args);
}

function heartbeat() {
  try {
    beat("worker", { pid: process.pid, startedAt, running: running.size });
  } catch (err) {
    log("No pude escribir el latido:", err);
  }
}

let ticking = false;
function tick() {
  if (ticking) return;
  ticking = true;
  try {
    // Cancelaciones pedidas desde la web.
    for (const [id, ac] of running) if (getTask(id)?.cancelRequested && !ac.signal.aborted) ac.abort();
    // Arranca encargos mientras haya hueco (los que esperan a otros no cuentan).
    while (countRunning() < MAX) {
      const task = claimNextTask();
      if (!task) break;
      const ac = new AbortController();
      running.set(task.id, ac);
      log(`▶ ${task.kind} · ${task.title.slice(0, 60)}`);
      runTask(task, { abort: ac })
        .then((t) => log(`■ ${t.status} · ${t.title.slice(0, 60)}${t.error ? ` · ${t.error}` : ""}`))
        .catch((err) => log("Fallo inesperado:", err))
        .finally(() => {
          running.delete(task.id);
          scheduleUsage();
        });
    }
  } catch (err) {
    log("Error en el planificador:", err);
  } finally {
    ticking = false;
  }
}

function main() {
  getDb();
  ensureSeed();
  try {
    ensureFilesSeed();
  } catch (err) {
    log("Archivos iniciales:", err);
  }
  const orphans = failOrphanedTasks("Interrumpido: el worker se reinició.");
  for (const a of listAgents()) if (a.status !== "idle") setAgentStatus(a.id, "idle", "");
  if (orphans.length) log(`${orphans.length} encargo(s) interrumpidos marcados como error.`);
  heartbeat();
  logActivity("sistema", "Worker arrancado");
  log(`Arrancado (pid ${process.pid}, hasta ${MAX} encargos a la vez).`);

  const routines = () => {
    try {
      for (const t of tickRoutines()) log(`⏰ ${t.title}`);
    } catch (err) {
      log("Error en las rutinas:", err);
    }
    // Respuestas a decisiones que aún no han llegado a su agente (la web ya avisa al responder; esto es la red).
    try {
      for (const d of dispatchAnswered()) log(`✅ Respuesta enviada: ${d.title.slice(0, 60)}`);
    } catch (err) {
      log("Error en las decisiones:", err);
    }
  };
  routines();
  scheduleUsage(1000);

  const timers = [
    setInterval(() => scheduleUsage(0), USAGE_EVERY_MS),
    setInterval(heartbeat, HEARTBEAT_MS),
    setInterval(tick, TICK_MS),
    setInterval(routines, ROUTINE_TICK_MS),
    setInterval(() => pruneEvents(), 10 * 60_000),
  ];

  const stop = () => {
    log("Parando…");
    timers.forEach(clearInterval);
    for (const ac of running.values()) ac.abort();
    setTimeout(() => process.exit(0), 300);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main();
