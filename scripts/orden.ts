/**
 * Supervisor de Orden: arranca la web y el worker, los mantiene vivos y
 * atiende las peticiones de reinicio (por ejemplo, al aplicar cambios de
 * código de un agente admin).
 *
 *   node --import tsx scripts/orden.ts dev     (desarrollo, con recarga)
 *   node --import tsx scripts/orden.ts start   (producción)
 *
 * - Si la web o el worker se caen, se relanzan (con espera creciente si
 *   fallan una y otra vez). Si la web deja de responder, se reinicia.
 * - Solo puede haber un Orden en marcha a la vez (data/orden.pid).
 * - Todo queda también en data/logs/orden.log.
 * - En producción, una actualización se compila en una carpeta aparte
 *   (.next-a / .next-b) mientras la app sigue funcionando; solo si compila
 *   bien se cambia de versión. Si falla, todo sigue como estaba.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../src/lib/env";

loadEnv();

const mode = process.argv[2] === "start" ? "prod" : "dev";
// La carpeta del proyecto es la del script (así funciona aunque se arranque desde otro sitio).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const dataDir = path.dirname(path.resolve(process.env.ORDEN_DB_PATH ?? path.join(root, "data", "orden.db")));
const restartFlag = path.join(dataDir, ".restart");
const pidFile = path.join(dataDir, "orden.pid");
const logDir = path.join(dataDir, "logs");
const logFile = path.join(logDir, "orden.log");
const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
const PORT = 3000;

fs.mkdirSync(logDir, { recursive: true });

// ───────────────────────── Log ─────────────────────────

const COLORS: Record<string, string> = { web: "36", worker: "35", build: "33", orden: "32" };
const ANSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g;
let logSize = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;

function writeLog(line: string) {
  try {
    if (logSize > 5 * 1024 * 1024) {
      fs.renameSync(logFile, path.join(logDir, "orden.1.log"));
      logSize = 0;
    }
    const text = `${new Date().toISOString()} ${line.replace(ANSI, "")}\n`;
    fs.appendFileSync(logFile, text);
    logSize += text.length;
  } catch {
    // el log nunca debe tumbar al supervisor
  }
}

function out(name: string, text: string) {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      process.stdout.write(`\x1b[${COLORS[name] ?? "37"}m[${name}]\x1b[0m ${line}\n`);
    } catch {
      // sin consola (arranque oculto)
    }
    writeLog(`[${name}] ${line}`);
  }
}

// ───────────────────────── Una sola instancia ─────────────────────────

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function takeLock() {
  try {
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    if (pid && pid !== process.pid && alive(pid)) {
      out("orden", `Orden ya está en marcha (proceso ${pid}). No arranco otro.`);
      process.exit(0);
    }
  } catch {
    // sin fichero: nadie más en marcha
  }
  fs.writeFileSync(pidFile, String(process.pid));
}

function releaseLock() {
  try {
    if (Number(fs.readFileSync(pidFile, "utf8")) === process.pid) fs.rmSync(pidFile, { force: true });
  } catch {
    // nada
  }
}

// ───────────────────────── Procesos hijos ─────────────────────────

interface Service {
  name: "web" | "worker";
  child: ChildProcess | null;
  /** Lo hemos parado nosotros: no es una caída. */
  expectedExit: boolean;
  crashes: number[];
  start: () => void;
}

let stopping = false;
let restarting = false;

function killTree(child: ChildProcess | null) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else child.kill("SIGTERM");
}

function stopService(s: Service) {
  s.expectedExit = true;
  killTree(s.child);
  s.child = null;
}

function launch(s: Service, args: string[], env: Record<string, string> = {}) {
  s.expectedExit = false;
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ORDEN_MODE: mode, FORCE_COLOR: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  s.child = child;
  child.stdout!.on("data", (d) => out(s.name, String(d)));
  child.stderr!.on("data", (d) => out(s.name, String(d)));
  child.on("exit", (code) => {
    if (s.child !== child) return; // ya sustituido
    s.child = null;
    if (stopping || s.expectedExit) return;
    // Caída inesperada: relanzar con espera creciente si se repite.
    const now = Date.now();
    s.crashes = s.crashes.filter((t) => now - t < 5 * 60_000).concat(now);
    const delay = Math.min(60_000, 1000 * 2 ** (s.crashes.length - 1));
    out("orden", `${s.name} se ha caído (código ${code}). Lo relanzo en ${Math.round(delay / 1000)} s.`);
    setTimeout(() => {
      if (!stopping && !s.child) s.start();
    }, delay);
  });
}

/** Compilación activa (producción): la más reciente de .next, .next-a y .next-b. */
function currentSlot(): string {
  let best = ".next";
  let bestTime = -1;
  for (const slot of [".next", ".next-a", ".next-b"]) {
    try {
      const t = fs.statSync(path.join(root, slot, "BUILD_ID")).mtimeMs;
      if (t > bestTime) {
        best = slot;
        bestTime = t;
      }
    } catch {
      // esa carpeta no tiene compilación
    }
  }
  return best;
}

function build(slot: string): boolean {
  out("build", `Compilando en ${slot}…`);
  const r = spawnSync(process.execPath, [nextBin, "build"], {
    cwd: root,
    env: { ...process.env, ORDEN_DIST_DIR: slot, FORCE_COLOR: "0" },
    encoding: "utf8",
    windowsHide: true,
  });
  out("build", (r.stdout ?? "") + (r.stderr ?? ""));
  return r.status === 0;
}

const web: Service = {
  name: "web",
  child: null,
  expectedExit: false,
  crashes: [],
  start: () => {
    const args = mode === "dev" ? [nextBin, "dev", "-H", "127.0.0.1", "-p", String(PORT)] : [nextBin, "start", "-H", "127.0.0.1", "-p", String(PORT)];
    launch(web, args, mode === "prod" ? { ORDEN_DIST_DIR: currentSlot() } : {});
    webStartedAt = Date.now();
  },
};

const worker: Service = {
  name: "worker",
  child: null,
  expectedExit: false,
  crashes: [],
  start: () => launch(worker, mode === "dev" ? ["--watch", "--import", "tsx", "worker/index.ts"] : ["--import", "tsx", "worker/index.ts"]),
};

// ───────────────────────── Salud de la web ─────────────────────────

let webStartedAt = 0;
let failedChecks = 0;

async function checkWeb() {
  if (stopping || restarting || !web.child || Date.now() - webStartedAt < 60_000) return;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/claude/usage`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    failedChecks = 0;
  } catch (err) {
    failedChecks++;
    out("orden", `La web no responde (${failedChecks}/3): ${(err as Error).message}`);
    if (failedChecks >= 3) {
      failedChecks = 0;
      out("orden", "Reinicio la web.");
      stopService(web);
      setTimeout(() => web.start(), 1000);
    }
  }
}

// ───────────────────────── Reinicio pedido ─────────────────────────

async function restart(reason: string) {
  if (restarting) return;
  restarting = true;
  out("orden", `Reinicio pedido: ${reason}`);
  try {
    if (mode === "prod") {
      const active = currentSlot();
      const next = active === ".next-a" ? ".next-b" : ".next-a";
      fs.rmSync(path.join(root, next), { recursive: true, force: true });
      if (!build(next)) {
        out("orden", "La compilación falló: Orden sigue con la versión anterior.");
        return;
      }
      stopService(web);
      stopService(worker);
      await new Promise((r) => setTimeout(r, 800));
      worker.start();
      web.start();
      // La versión anterior ya no hace falta.
      setTimeout(() => {
        if (active !== ".next") fs.rmSync(path.join(root, active), { recursive: true, force: true });
      }, 5000);
    } else {
      // En desarrollo Next recarga solo; el worker se reinicia para cargar todo de cero.
      stopService(worker);
      await new Promise((r) => setTimeout(r, 500));
      worker.start();
    }
    out("orden", "Reinicio completado.");
  } finally {
    restarting = false;
  }
}

// ───────────────────────── Arranque ─────────────────────────

function main() {
  takeLock();
  out("orden", `Arrancando en modo ${mode === "dev" ? "desarrollo" : "producción"} (proceso ${process.pid})…`);
  if (mode === "prod" && !fs.existsSync(path.join(root, currentSlot(), "BUILD_ID"))) {
    if (!build(".next-a")) {
      out("orden", "No se pudo compilar. Revisa los errores de arriba.");
      releaseLock();
      process.exit(1);
    }
  }
  fs.rmSync(restartFlag, { force: true });
  worker.start();
  web.start();

  setInterval(() => {
    if (!fs.existsSync(restartFlag) || restarting) return;
    let reason = "petición";
    try {
      reason = JSON.parse(fs.readFileSync(restartFlag, "utf8")).reason ?? reason;
    } catch {
      // fichero vacío
    }
    fs.rmSync(restartFlag, { force: true });
    void restart(reason);
  }, 2000);
  setInterval(() => void checkWeb(), 30_000);

  const stop = () => {
    if (stopping) return;
    stopping = true;
    out("orden", "Parando Orden…");
    stopService(web);
    stopService(worker);
    releaseLock();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("SIGBREAK", stop);
  process.on("exit", releaseLock);
  // Un error del propio supervisor se apunta pero no lo tumba.
  process.on("uncaughtException", (err) => out("orden", `Error del supervisor: ${err.stack ?? err}`));
  process.on("unhandledRejection", (err) => out("orden", `Error del supervisor: ${String(err)}`));
}

main();
