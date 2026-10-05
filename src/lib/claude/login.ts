import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { claudeBinaryPath, claudeEnv } from "./binary";
import { invalidateClaudeStatus } from "./auth";

/**
 * Gestiona un `claude auth login --claudeai` lanzado desde la web.
 * Sigue su salida, extrae el enlace de autorización y, si el CLI pide un
 * código, permite enviárselo por stdin.
 */

export type LoginState = "idle" | "running" | "waiting_code" | "success" | "error" | "cancelled";

export interface LoginSnapshot {
  state: LoginState;
  url?: string;
  output: string;
  error?: string;
  startedAt?: string;
}

interface LoginSession {
  child: ChildProcessWithoutNullStreams | null;
  snap: LoginSnapshot;
}

const g = globalThis as unknown as { __ordenLogin?: LoginSession };

function session(): LoginSession {
  if (!g.__ordenLogin) g.__ordenLogin = { child: null, snap: { state: "idle", output: "" } };
  return g.__ordenLogin;
}

// Quita secuencias ANSI de color y movimiento de cursor.
const ANSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
const URL_RE = /https:\/\/[^\s"'<>]+/g;
const CODE_PROMPT = /(paste|pega|enter|introduce).{0,40}code|code.{0,20}(here|aquí)/i;

export function loginSnapshot(): LoginSnapshot {
  return { ...session().snap };
}

export function startLogin(): LoginSnapshot {
  const s = session();
  if (s.child && (s.snap.state === "running" || s.snap.state === "waiting_code")) return loginSnapshot();
  const bin = claudeBinaryPath();
  if (!bin) {
    s.snap = { state: "error", output: "", error: "No encuentro el binario de Claude Code del SDK." };
    return loginSnapshot();
  }
  s.snap = { state: "running", output: "", startedAt: new Date().toISOString() };
  const child = spawn(bin, ["auth", "login", "--claudeai"], {
    env: claudeEnv() as NodeJS.ProcessEnv,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  s.child = child;

  const onData = (buf: Buffer) => {
    const text = buf.toString("utf8").replace(ANSI, "");
    s.snap.output = (s.snap.output + text).slice(-8000);
    const urls = s.snap.output.match(URL_RE);
    if (urls) {
      // El enlace bueno es el de autorización OAuth; si no, el último.
      s.snap.url = urls.find((u) => /oauth|authorize/i.test(u)) ?? urls[urls.length - 1];
    }
    if (CODE_PROMPT.test(text) && s.snap.state === "running") s.snap.state = "waiting_code";
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("error", (err) => {
    s.snap.state = "error";
    s.snap.error = err.message;
    s.child = null;
  });
  child.on("close", (code) => {
    if (s.snap.state !== "cancelled") {
      if (code === 0) s.snap.state = "success";
      else {
        s.snap.state = "error";
        s.snap.error = s.snap.error ?? `El inicio de sesión terminó con código ${code}.`;
      }
    }
    s.child = null;
    invalidateClaudeStatus();
  });
  return loginSnapshot();
}

export function submitLoginCode(code: string): LoginSnapshot {
  const s = session();
  if (!s.child) throw new Error("No hay ningún inicio de sesión en curso.");
  s.child.stdin.write(code.trim() + "\n");
  s.snap.state = "running";
  return loginSnapshot();
}

export function cancelLogin(): LoginSnapshot {
  const s = session();
  if (s.child) {
    s.snap.state = "cancelled";
    s.child.kill();
    s.child = null;
  }
  return loginSnapshot();
}
