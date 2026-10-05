/**
 * Orden como servicio de Windows (tarea programada al iniciar sesión).
 *
 *   npm run servicio:instalar   → arranca solo al iniciar sesión, sin ventana,
 *                                 y Windows lo vuelve a levantar si se cae
 *                                 (lo comprueba cada 2 minutos)
 *   npm run servicio:quitar     → lo desinstala (y lo para)
 *   npm run servicio:estado     → ¿está instalado y en marcha?
 *   npm run servicio:arrancar / servicio:parar
 *
 * Se ejecuta como tu usuario (sin permisos de administrador). El registro
 * queda en data/logs/orden.log.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../src/lib/env";

loadEnv();

const TASK = "Orden";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Mismo puerto que el supervisor (scripts/orden.ts): PORT del entorno o .env, si no 3000.
const PORT = Number(process.env.PORT) || 3000;
const URL_WEB = `http://localhost:${PORT}`;
const node = process.execPath;
const conhost = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "conhost.exe");

function ps(script: string): { ok: boolean; out: string } {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

function instalar() {
  if (process.platform !== "win32") {
    console.log("Este instalador es para Windows. En macOS/Linux usa launchd o systemd con: node --import tsx scripts/orden.ts start");
    process.exit(1);
  }
  // conhost --headless: el proceso corre sin ventana pero Windows sigue vigilándolo.
  const args = `--headless ${JSON.stringify(node)} --import tsx scripts/orden.ts start`;
  const script = `
$ErrorActionPreference = 'Stop'
$action = New-ScheduledTaskAction -Execute ${q(conhost)} -Argument ${q(args)} -WorkingDirectory ${q(root)}
$logon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\\$env:USERNAME"
# Vigilancia: cada 2 minutos intenta arrancarlo. Si ya está en marcha no pasa
# nada (una sola instancia); si se había caído, vuelve.
$watch = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 2)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable \`
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName ${q(TASK)} -Description 'Orden: asistente personal con agentes (web en ${URL_WEB})' \`
  -Action $action -Trigger @($logon, $watch) -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName ${q(TASK)}
`;
  const r = ps(script);
  if (!r.ok) {
    console.error("No se pudo instalar la tarea:\n" + r.out);
    process.exit(1);
  }
  console.log("✔ Orden instalado: arrancará solo al iniciar sesión y se relanzará si se cae.");
  console.log(`  Ya se está iniciando en segundo plano. Ábrelo en ${URL_WEB} (la primera vez puede tardar si tiene que compilar).`);
  console.log(`  Registro: ${path.join(root, "data", "logs", "orden.log")}`);
}

function quitar() {
  parar();
  const r = ps(`Unregister-ScheduledTask -TaskName ${q(TASK)} -Confirm:$false`);
  console.log(r.ok ? "✔ Tarea «Orden» eliminada. Ya no arrancará sola." : `No estaba instalada (${r.out.split("\n")[0]}).`);
}

/** PID del supervisor según data/orden.pid, si está vivo. */
function supervisorPid(): number | null {
  try {
    const pid = Number(fs.readFileSync(path.join(root, "data", "orden.pid"), "utf8"));
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function parar() {
  ps(`Stop-ScheduledTask -TaskName ${q(TASK)} -ErrorAction SilentlyContinue`);
  const pid = supervisorPid();
  if (pid) {
    // Mata el supervisor y todo lo que cuelga de él (web y worker).
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    console.log(`✔ Orden parado (proceso ${pid}).`);
  } else console.log("Orden no estaba en marcha.");
}

function arrancar() {
  const r = ps(`Start-ScheduledTask -TaskName ${q(TASK)}`);
  console.log(r.ok ? `✔ Iniciando Orden en segundo plano (${URL_WEB}).` : `No está instalado como servicio. Usa npm run servicio:instalar.\n${r.out}`);
}

async function estado() {
  const r = ps(`$t = Get-ScheduledTask -TaskName ${q(TASK)} -ErrorAction SilentlyContinue; if ($t) { $i = $t | Get-ScheduledTaskInfo; "$($t.State)|$($i.LastRunTime)|$($i.LastTaskResult)" }`);
  if (!r.out) console.log("Servicio: no instalado (npm run servicio:instalar).");
  else {
    const [state, last, result] = r.out.split("|");
    console.log(`Servicio: instalado · estado ${state} · última ejecución ${last} · resultado ${result}`);
  }
  const pid = supervisorPid();
  console.log(pid ? `Supervisor: en marcha (proceso ${pid})` : "Supervisor: parado");
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/claude/usage`, { signal: AbortSignal.timeout(5000) });
    console.log(`Web: responde (HTTP ${res.status}) en ${URL_WEB}`);
  } catch {
    console.log("Web: no responde");
  }
}

const cmd = process.argv[2];
const actions: Record<string, () => unknown> = { instalar, quitar, parar, arrancar, estado };
if (!actions[cmd]) {
  console.log("Uso: tsx scripts/servicio.ts <instalar|quitar|estado|arrancar|parar>");
  process.exit(1);
}
await actions[cmd]();
