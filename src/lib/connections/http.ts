import { redact } from "../secrets";

/**
 * Peticiones HTTP de las conexiones sencillas (Clima, Noticias, Telegram,
 * Notion): solo http(s), con tiempo límite, tamaño máximo y errores sin
 * secretos (el token nunca aparece en un mensaje).
 */

export interface FetchOpts {
  timeoutMs?: number;
  maxBytes?: number;
  /** Secretos que hay que tapar en cualquier mensaje de error. */
  secrets?: (string | null | undefined)[];
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 2_000_000;

async function readLimited(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > max) throw new Error(`Respuesta demasiado grande (${declared} bytes; máx. ${max}).`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > max) throw new Error(`Respuesta demasiado grande (${buf.byteLength} bytes; máx. ${max}).`);
  return new TextDecoder().decode(buf);
}

export async function fetchText(url: string, init: RequestInit = {}, opts: FetchOpts = {}): Promise<string> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("Dirección no válida.");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Solo se admiten direcciones http(s).");
  const secrets = opts.secrets ?? [];
  let res: Response;
  try {
    res = await fetch(u, { ...init, redirect: "follow", signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) });
  } catch (err) {
    throw new Error(redact(`No se pudo conectar con ${u.host}: ${(err as Error).message}`, ...secrets));
  }
  const text = await readLimited(res, opts.maxBytes ?? DEFAULT_MAX_BYTES);
  if (!res.ok) throw new Error(redact(`${u.host} respondió ${res.status}: ${text.slice(0, 300)}`, ...secrets));
  return text;
}

export async function fetchJson<T>(url: string, init: RequestInit = {}, opts: FetchOpts = {}): Promise<T> {
  const text = await fetchText(url, init, opts);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Respuesta no válida de ${new URL(url).host}.`);
  }
}
