import fs from "node:fs";
import path from "node:path";

/**
 * Ruta del binario de Claude Code que trae el SDK
 * (`@anthropic-ai/claude-agent-sdk-<plataforma>-<arch>`).
 *
 * Se resuelve desde process.cwd() y no con require.resolve, porque dentro del
 * bundle de Next.js require.resolve no apunta a node_modules.
 */
export function claudeBinaryPath(): string | null {
  const platform = process.platform;
  const arch = process.arch;
  const exe = platform === "win32" ? "claude.exe" : "claude";
  const base = path.join(process.cwd(), "node_modules", "@anthropic-ai");
  const candidates = [
    path.join(base, `claude-agent-sdk-${platform}-${arch}`, exe),
    // Linux con musl publica un paquete aparte.
    path.join(base, `claude-agent-sdk-${platform}-${arch}-musl`, exe),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

export type AuthMode = "subscription" | "apikey";

export function authMode(): AuthMode {
  return process.env.ORDEN_AUTH_MODE === "apikey" ? "apikey" : "subscription";
}

/**
 * Entorno para lanzar Claude. En modo suscripción se quita ANTHROPIC_API_KEY
 * para que use la sesión local de Claude Code y no cobre por API.
 */
export function claudeEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  if (authMode() === "subscription") {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "orden/0.1.0";
  return { ...env, ...extra };
}
