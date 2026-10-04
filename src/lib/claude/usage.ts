import path from "node:path";
import fs from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { authMode, claudeBinaryPath, claudeEnv } from "./binary";
import { getSetting, setSetting } from "../repo/system";
import { emit } from "../events";
import type { ClaudeUsage, UsageWindow } from "./usageText";
export * from "./usageText";

/**
 * Límites del plan de Claude (ventana de 5 h, semana…). Se leen con una
 * petición de control del SDK que NO llama al modelo: no gasta uso.
 *
 * Ojo: el SDK marca este método como experimental; si cambia o desaparece,
 * el medidor muestra «no disponible» en vez de romper nada.
 */

const SETTING = "claude_usage";

const LABELS: Record<string, string> = {
  five_hour: "Sesión (5 h)",
  seven_day: "Semana",
  seven_day_opus: "Semana · Opus",
  seven_day_sonnet: "Semana · Sonnet",
};

interface RawWindow {
  utilization: number | null;
  resets_at: string | null;
}

/** Convierte la respuesta del SDK en algo estable para la app. */
export function normalizeUsage(raw: { subscription_type?: string | null; rate_limits_available?: boolean; rate_limits?: Record<string, unknown> | null }): Omit<ClaudeUsage, "fetchedAt"> {
  const limits = (raw.rate_limits ?? {}) as Record<string, RawWindow | null | undefined>;
  const windows: UsageWindow[] = [];
  for (const key of Object.keys(LABELS)) {
    const w = limits[key];
    if (!w || typeof w.utilization !== "number") continue;
    windows.push({ key, label: LABELS[key], percent: Math.max(0, Math.min(100, w.utilization)), resetsAt: w.resets_at ?? null });
  }
  return {
    available: Boolean(raw.rate_limits_available) && windows.length > 0,
    plan: raw.subscription_type ?? null,
    windows,
  };
}

export function getStoredUsage(): ClaudeUsage | null {
  return getSetting<ClaudeUsage | null>(SETTING, null);
}

let inFlight: Promise<ClaudeUsage> | null = null;

/** Pide los límites al binario de Claude (≈1 s) y los guarda. */
export function refreshUsage(): Promise<ClaudeUsage> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const fetchedAt = new Date().toISOString();
    let usage: ClaudeUsage;
    if (authMode() === "apikey") {
      usage = { available: false, plan: null, windows: [], fetchedAt, error: "Con API key no hay límites de plan: se paga por uso." };
    } else {
      try {
        usage = { ...(await readFromSdk()), fetchedAt };
      } catch (err) {
        const prev = getStoredUsage();
        usage = { ...(prev ?? { available: false, plan: null, windows: [] }), fetchedAt: prev?.fetchedAt ?? fetchedAt, error: (err as Error).message };
      }
    }
    setSetting(SETTING, usage);
    emit("usage.updated", usage);
    return usage;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Devuelve lo guardado si es reciente; si no, lo refresca. */
export async function getUsage(maxAgeMs = 5 * 60_000): Promise<ClaudeUsage> {
  const stored = getStoredUsage();
  if (stored && !stored.error && Date.now() - Date.parse(stored.fetchedAt) < maxAgeMs) return stored;
  return refreshUsage();
}

async function readFromSdk(): Promise<Omit<ClaudeUsage, "fetchedAt">> {
  const cwd = path.join(path.dirname(process.env.ORDEN_DB_PATH ?? path.join(process.cwd(), "data", "orden.db")), "agentes");
  fs.mkdirSync(cwd, { recursive: true });
  let release!: () => void;
  const idle = new Promise<void>((r) => (release = r));
  // Una «conversación» que nunca envía mensajes: solo sirve para la petición de control.
  async function* noMessages() {
    await idle;
  }
  const abort = new AbortController();
  const q = query({
    prompt: noMessages() as never,
    options: {
      model: "haiku",
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      settings: { disableClaudeAiConnectors: true },
      persistSession: false,
      cwd,
      abortController: abort,
      pathToClaudeCodeExecutable: claudeBinaryPath() ?? undefined,
      env: claudeEnv(),
    },
  });
  const method = (q as unknown as Record<string, unknown>).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET as
    | ((o: { skipBehaviors: boolean }) => Promise<Parameters<typeof normalizeUsage>[0]>)
    | undefined;
  try {
    if (typeof method !== "function") throw new Error("Esta versión del SDK no permite leer los límites.");
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("Claude no respondió a tiempo.")), 20_000));
    const raw = await Promise.race([method.call(q, { skipBehaviors: true }), timeout]);
    return normalizeUsage(raw);
  } finally {
    release();
    abort.abort();
    try {
      q.close();
    } catch {
      // ya cerrado
    }
  }
}

