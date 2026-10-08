import { createConnection, listConnections, setConnectionSecret, updateConnection, type Connection } from "../../repo/connections";
import { getSetting, logActivity, setSetting } from "../../repo/system";
import { decryptSecret, encryptSecret, redact } from "../../secrets";
import { ALL_REPOS } from "./api";

/**
 * «Iniciar sesión con GitHub»: flujo de dispositivo de OAuth (Device Flow).
 * Pensado para una app local: no hay URL de vuelta ni secreto de cliente. Orden
 * pide un código, el usuario lo escribe en github.com/login/device y Orden lo
 * consulta hasta que se autoriza. El token resultante se guarda cifrado en una
 * conexión de cuenta («todos los repositorios») que se usa como token guardado.
 *
 * Hace falta el Client ID de una OAuth App de GitHub con «Enable Device Flow»
 * (es público, no un secreto). Se toma, por orden, de Ajustes (lo pega el
 * usuario una vez), de ORDEN_GITHUB_CLIENT_ID o de DEFAULT_CLIENT_ID (que el
 * proyecto puede fijar para que el botón funcione sin configurar nada).
 */

export const DEFAULT_CLIENT_ID = "";
/** `repo` = leer y escribir en todos los repos a los que accede la cuenta (privados incluidos). */
export const SCOPES = "repo read:user";

const DEVICE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const CLIENT_KEY = "github.clientId";
const PENDING_KEY = "github.login.pendiente";
const TIMEOUT_MS = 30_000;

// ── Red (con lista de destinos permitidos) ────────────────────────────────

export interface LoginRequest {
  method: "GET" | "POST";
  url: string;
  form?: Record<string, string>;
  /** Token de acceso (solo para pedir quién es el usuario). */
  token?: string;
}
export type LoginFetch = (req: LoginRequest) => Promise<unknown>;

/** Solo POST al código y al token de OAuth y GET al perfil del usuario. */
export function assertAllowed(req: LoginRequest) {
  const ok = (req.method === "POST" && (req.url === DEVICE_URL || req.url === TOKEN_URL)) || (req.method === "GET" && req.url === USER_URL);
  if (!ok) throw new Error("Destino de GitHub no permitido para el inicio de sesión.");
}

const realFetch: LoginFetch = async (req) => {
  let res: Response;
  try {
    res = await fetch(req.url, {
      method: req.method,
      headers: {
        Accept: "application/json",
        "User-Agent": "Orden",
        ...(req.token && { Authorization: `Bearer ${req.token}`, "X-GitHub-Api-Version": "2022-11-28" }),
        ...(req.form && { "Content-Type": "application/x-www-form-urlencoded" }),
      },
      body: req.form ? new URLSearchParams(req.form).toString() : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`Sin conexión con GitHub: ${(e as Error).message}`);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text.trim() ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error((data as { message?: string } | null)?.message ?? `GitHub respondió HTTP ${res.status}`);
  return data;
};

let testFetch: LoginFetch | null = null;
/** Para tests: sustituye cualquier acceso real a GitHub. */
export function setLoginFetchForTests(f: LoginFetch | null) {
  testFetch = f;
}

function request<T>(req: LoginRequest): Promise<T> {
  assertAllowed(req);
  return (testFetch ?? realFetch)(req) as Promise<T>;
}

// ── Client ID ─────────────────────────────────────────────────────────────

/** Los Client ID de GitHub son «Iv1.…» (GitHub Apps) o 20 caracteres hexadecimales (OAuth Apps). */
export function parseClientId(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (!/^[A-Za-z0-9._-]{8,60}$/.test(s)) throw new Error("Ese Client ID no es válido: lo encuentras en la página de tu OAuth App de GitHub (p. ej. «Ov23li…» o 20 caracteres).");
  return s;
}

export type ClientSource = "ajustes" | "entorno" | "incluido";

export function githubClientId(): { id: string; source: ClientSource } | null {
  const saved = getSetting<string>(CLIENT_KEY, "");
  if (saved) return { id: saved, source: "ajustes" };
  const env = process.env.ORDEN_GITHUB_CLIENT_ID?.trim();
  if (env) return { id: parseClientId(env), source: "entorno" };
  return DEFAULT_CLIENT_ID ? { id: DEFAULT_CLIENT_ID, source: "incluido" } : null;
}

/** Guarda (o, con null, borra) el Client ID elegido por el usuario. */
export function saveClientId(raw: string | null) {
  setSetting(CLIENT_KEY, raw === null || !String(raw).trim() ? "" : parseClientId(raw));
}

// ── Inicio de sesión en curso ─────────────────────────────────────────────

interface Pending {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  interval: number;
  nextPollAt: number;
}

/** Lo que ve la interfaz de un inicio de sesión en curso (nunca el código de dispositivo). */
export interface PublicPending {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  interval: number;
}

const readPending = (nowMs: number): Pending | null => {
  const p = getSetting<Pending | null>(PENDING_KEY, null);
  return p && p.expiresAt > nowMs ? p : null;
};
const clearPending = () => setSetting(PENDING_KEY, null);
const publicPending = (p: Pending): PublicPending => ({ userCode: p.userCode, verificationUri: p.verificationUri, expiresAt: p.expiresAt, interval: p.interval });

export interface LoginInfo {
  clientConfigured: boolean;
  clientSource: ClientSource | null;
  /** Pista del Client ID (primeros caracteres). */
  clientIdHint: string | null;
  pending: PublicPending | null;
  /** Cuenta ya conectada con el inicio de sesión (nombre de la conexión de cuenta), si la hay. */
  connected: { id: string; name: string } | null;
}

export function loginInfo(nowMs = Date.now()): LoginInfo {
  const client = githubClientId();
  const p = readPending(nowMs);
  const conn = accountConnection();
  return {
    clientConfigured: Boolean(client),
    clientSource: client?.source ?? null,
    clientIdHint: client ? `${client.id.slice(0, 6)}…` : null,
    pending: p ? publicPending(p) : null,
    connected: conn && conn.hasSecret ? { id: conn.id, name: conn.name } : null,
  };
}

/** Pide un código de dispositivo a GitHub y lo deja pendiente de autorizar. */
export async function startLogin(nowMs = Date.now()): Promise<PublicPending> {
  const client = githubClientId();
  if (!client) throw new Error("Falta el Client ID de una OAuth App de GitHub (se pone una sola vez).");
  const r = await request<{ device_code?: string; user_code?: string; verification_uri?: string; expires_in?: number; interval?: number; error?: string; error_description?: string }>({
    method: "POST",
    url: DEVICE_URL,
    form: { client_id: client.id, scope: SCOPES },
  });
  if (r.error === "device_flow_disabled") throw new Error("Esa OAuth App no tiene activado «Enable Device Flow». Actívalo en su página de GitHub y vuelve a probar.");
  if (r.error === "incorrect_client_credentials") throw new Error("GitHub no reconoce ese Client ID. Revísalo en la página de tu OAuth App.");
  if (r.error || !r.device_code || !r.user_code || !r.verification_uri) throw new Error(`GitHub no ha dado el código: ${r.error_description ?? r.error ?? "respuesta inesperada"}.`);
  const interval = Math.max(5, Number(r.interval) || 5);
  const p: Pending = {
    deviceCode: encryptSecret(r.device_code),
    userCode: r.user_code,
    // Solo se abre la página oficial de GitHub, pase lo que pase en la respuesta.
    verificationUri: /^https:\/\/github\.com\//.test(r.verification_uri) ? r.verification_uri : "https://github.com/login/device",
    expiresAt: nowMs + Math.max(60, Number(r.expires_in) || 900) * 1000,
    interval,
    nextPollAt: nowMs + interval * 1000,
  };
  setSetting(PENDING_KEY, p);
  return publicPending(p);
}

export function cancelLogin() {
  clearPending();
}

export type PollResult =
  | { status: "pendiente"; interval: number }
  | { status: "ok"; connectionId: string; account: string }
  | { status: "error"; text: string };

/** Conexión de cuenta («todos los repositorios») de GitHub, si ya existe. */
function accountConnection(): Connection | undefined {
  return listConnections("github").find((c) => c.config.repo === ALL_REPOS);
}

function saveAccountConnection(login: string, token: string): Connection {
  const existing = accountConnection();
  let conn: Connection;
  if (existing) {
    setConnectionSecret(existing.id, token);
    conn = updateConnection(existing.id, { auth: "token", enabled: true, ...(existing.name.startsWith("GitHub · ") && { name: `GitHub · ${login}` }) });
  } else {
    conn = createConnection({ service: "github", name: `GitHub · ${login}`, config: { repo: ALL_REPOS }, auth: "token" });
    setConnectionSecret(conn.id, token);
  }
  logActivity("sistema", `Sesión de GitHub iniciada como ${login} (token guardado cifrado en «${conn.name}»)`);
  return conn;
}

/**
 * Pregunta a GitHub si ya se ha autorizado. La interfaz la llama cada
 * `interval` segundos; si llega antes de tiempo no molesta a GitHub.
 */
export async function pollLogin(nowMs = Date.now()): Promise<PollResult> {
  const client = githubClientId();
  const p = readPending(nowMs);
  if (!client) return { status: "error", text: "Falta el Client ID de la OAuth App." };
  if (!p) {
    clearPending();
    return { status: "error", text: "El código ha caducado o no hay ningún inicio de sesión en curso. Vuelve a pulsar «Iniciar sesión con GitHub»." };
  }
  if (nowMs < p.nextPollAt) return { status: "pendiente", interval: p.interval };

  let deviceCode: string;
  try {
    deviceCode = decryptSecret(p.deviceCode);
  } catch {
    clearPending();
    return { status: "error", text: "No se pudo leer el inicio de sesión guardado. Vuelve a empezar." };
  }

  let token = "";
  try {
    const r = await request<{ access_token?: string; scope?: string; error?: string; error_description?: string; interval?: number }>({
      method: "POST",
      url: TOKEN_URL,
      form: { client_id: client.id, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" },
    });
    if (r.error === "authorization_pending") {
      setSetting(PENDING_KEY, { ...p, nextPollAt: nowMs + p.interval * 1000 });
      return { status: "pendiente", interval: p.interval };
    }
    if (r.error === "slow_down") {
      const interval = Math.max(p.interval + 5, Number(r.interval) || 0);
      setSetting(PENDING_KEY, { ...p, interval, nextPollAt: nowMs + interval * 1000 });
      return { status: "pendiente", interval };
    }
    if (r.error === "access_denied") {
      clearPending();
      return { status: "error", text: "Se ha cancelado la autorización en GitHub." };
    }
    if (r.error === "expired_token") {
      clearPending();
      return { status: "error", text: "El código ha caducado. Vuelve a pulsar «Iniciar sesión con GitHub»." };
    }
    if (r.error || !r.access_token) {
      clearPending();
      return { status: "error", text: `GitHub ha rechazado el inicio de sesión: ${r.error_description ?? r.error ?? "respuesta inesperada"}.` };
    }
    token = r.access_token;
    const me = await request<{ login?: string }>({ method: "GET", url: USER_URL, token });
    if (!me.login) throw new Error("GitHub no ha dicho quién eres.");
    clearPending();
    const conn = saveAccountConnection(me.login, token);
    return { status: "ok", connectionId: conn.id, account: me.login };
  } catch (err) {
    // Fallo de red o de GitHub: se avisa y la interfaz deja de preguntar (el usuario puede volver a empezar).
    return { status: "error", text: redact((err as Error).message, token, deviceCode) };
  }
}
