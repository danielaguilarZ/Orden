import { NextResponse } from "next/server";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function hostname(hostHeader: string | null): string {
  if (!hostHeader) return "";
  if (hostHeader.startsWith("[")) return hostHeader.slice(0, hostHeader.indexOf("]") + 1);
  return hostHeader.split(":")[0];
}

/**
 * Comprueba que la petición viene del propio PC: el Host debe ser local
 * (evita DNS rebinding) y, si hay Origin, también. El servidor además
 * escucha solo en 127.0.0.1.
 */
export function isLocalRequest(req: Request): boolean {
  const host = hostname(req.headers.get("host"));
  if (!LOCAL_HOSTS.has(host)) return false;
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd && !fwd.split(",").every((ip) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip.trim()))) return false;
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      if (!LOCAL_HOSTS.has(new URL(origin).hostname)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function forbidden() {
  return NextResponse.json({ error: "Solo se permite desde este ordenador (localhost)." }, { status: 403 });
}
