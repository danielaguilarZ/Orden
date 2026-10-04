import { execFile } from "node:child_process";
import { authMode, claudeBinaryPath, claudeEnv, type AuthMode } from "./binary";

export interface ClaudeStatus {
  mode: AuthMode;
  installed: boolean;
  connected: boolean;
  email?: string;
  plan?: string;
  method?: string;
  error?: string;
  checkedAt: string;
}

const cache = globalThis as unknown as { __ordenClaudeStatus?: { at: number; value: ClaudeStatus } };
const TTL_MS = 30_000;

/** Ejecuta `claude auth status` con el binario del SDK. */
export async function getClaudeStatus(force = false): Promise<ClaudeStatus> {
  const cached = cache.__ordenClaudeStatus;
  if (!force && cached && Date.now() - cached.at < TTL_MS) return cached.value;
  const value = await readStatus();
  cache.__ordenClaudeStatus = { at: Date.now(), value };
  return value;
}

export function invalidateClaudeStatus() {
  delete cache.__ordenClaudeStatus;
}

async function readStatus(): Promise<ClaudeStatus> {
  const mode = authMode();
  const checkedAt = new Date().toISOString();
  if (mode === "apikey") {
    const has = Boolean(process.env.ANTHROPIC_API_KEY);
    return {
      mode,
      installed: true,
      connected: has,
      method: "api key",
      error: has ? undefined : "Falta ANTHROPIC_API_KEY en el entorno.",
      checkedAt,
    };
  }
  const bin = claudeBinaryPath();
  if (!bin) {
    return {
      mode,
      installed: false,
      connected: false,
      error: "No encuentro el binario de Claude Code del SDK. Ejecuta npm install.",
      checkedAt,
    };
  }
  return new Promise((resolve) => {
    execFile(bin, ["auth", "status"], { env: claudeEnv() as NodeJS.ProcessEnv, timeout: 20_000, windowsHide: true }, (err, stdout) => {
      try {
        const data = JSON.parse(stdout) as { loggedIn?: boolean; email?: string; subscriptionType?: string; authMethod?: string };
        resolve({
          mode,
          installed: true,
          connected: Boolean(data.loggedIn),
          email: data.email,
          plan: data.subscriptionType,
          method: data.authMethod,
          checkedAt,
        });
      } catch {
        resolve({
          mode,
          installed: true,
          connected: false,
          error: err ? `claude auth status falló: ${err.message}` : "Respuesta inesperada de claude auth status.",
          checkedAt,
        });
      }
    });
  });
}
