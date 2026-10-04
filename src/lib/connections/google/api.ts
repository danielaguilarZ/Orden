import { createHash, randomBytes } from "node:crypto";
import { getConnection, getConnectionSecret, setConnectionSecret, type Connection } from "../../repo/connections";
import { getSetting, setSetting } from "../../repo/system";
import { decryptSecret, encryptSecret, redact } from "../../secrets";

/**
 * Google Calendar en SOLO LECTURA.
 * - OAuth 2.0 con PKCE y el único scope `calendar.readonly`. Las credenciales
 *   del cliente OAuth (de Google Cloud) y los tokens se guardan cifrados en
 *   la conexión (`connections.secret`, como el token de GitHub).
 * - Toda llamada pasa por `request`, que solo deja salir GET hacia la API de
 *   Calendar y POST hacia el token/revocación de OAuth: no hay forma de
 *   escribir en el calendario desde Orden.
 */

export const SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
export const CALLBACK_PATH = "/api/connections/google/callback";
const TIMEOUT_MS = 30_000;
const PENDING_KEY = "google.oauth.pendiente";
const PENDING_TTL_MS = 15 * 60_000;

export class GoogleError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// ── Transporte (con candado de solo lectura) ──────────────────────────────

export interface GoogleRequest {
  method: "GET" | "POST";
  url: string;
  /** Token de acceso (Authorization: Bearer). */
  token?: string;
  /** Cuerpo application/x-www-form-urlencoded (solo OAuth). */
  form?: Record<string, string>;
}
export type GoogleFetch = (req: GoogleRequest) => Promise<unknown>;

/** Solo GET a Calendar y POST a token/revocación. Lo demás, fuera. */
export function assertAllowed(req: GoogleRequest) {
  if (req.url.startsWith(`${CALENDAR_API}/`)) {
    if (req.method !== "GET") throw new Error("Google Calendar está conectado en solo lectura: no se permite escribir.");
    return;
  }
  if (req.url === TOKEN_URL || req.url === REVOKE_URL) {
    if (req.method !== "POST") throw new Error("Petición de OAuth no válida.");
    return;
  }
  throw new Error("Destino de Google no permitido.");
}

const realFetch: GoogleFetch = async (req) => {
  let res: Response;
  try {
    res = await fetch(req.url, {
      method: req.method,
      headers: {
        Accept: "application/json",
        "User-Agent": "Orden",
        ...(req.token && { Authorization: `Bearer ${req.token}` }),
        ...(req.form && { "Content-Type": "application/x-www-form-urlencoded" }),
      },
      body: req.form ? new URLSearchParams(req.form).toString() : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new GoogleError(0, `Sin conexión con Google: ${(e as Error).message}`);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text.trim() ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const d = data as { error?: string | { message?: string }; error_description?: string } | null;
    const msg = d?.error_description ?? (typeof d?.error === "object" ? d.error.message : d?.error) ?? `HTTP ${res.status}`;
    throw new GoogleError(res.status, String(msg));
  }
  return data;
};

let testFetch: GoogleFetch | null = null;
/** Para tests: sustituye cualquier acceso real a Google. */
export function setGoogleFetchForTests(f: GoogleFetch | null) {
  testFetch = f;
}

async function request<T>(req: GoogleRequest): Promise<T> {
  assertAllowed(req);
  return (await (testFetch ?? realFetch)(req)) as T;
}

// ── Credenciales guardadas (cifradas) ─────────────────────────────────────

export interface GoogleSecret {
  clientId: string;
  clientSecret: string;
  refreshToken?: string;
  accessToken?: string;
  /** ms epoch */
  expiresAt?: number;
  scope?: string;
  /** Cuenta autorizada (id del calendario principal = correo). */
  account?: string;
}

export function readGoogleSecret(connectionId: string): GoogleSecret | null {
  const raw = getConnectionSecret(connectionId);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as GoogleSecret;
    return typeof s.clientId === "string" && typeof s.clientSecret === "string" ? s : null;
  } catch {
    return null;
  }
}

function writeGoogleSecret(connectionId: string, s: GoogleSecret | null) {
  // La fecha al final: la «pista» que calcula publicConnection no deja ver nada secreto.
  setConnectionSecret(connectionId, s ? JSON.stringify({ ...s, savedAt: new Date().toISOString() }) : null);
}

const secretsOf = (s: GoogleSecret | null) => [s?.clientSecret, s?.refreshToken, s?.accessToken];
export const clean = (msg: string, s: GoogleSecret | null) => redact(msg, ...secretsOf(s));

/**
 * Acepta el client ID y el secreto por separado o el JSON que descarga
 * Google Cloud («client_secret_….json», tipo installed o web).
 */
export function parseClientInput(clientId: string, clientSecret?: string): { clientId: string; clientSecret: string } {
  let id = clientId.trim();
  let secret = (clientSecret ?? "").trim();
  if (id.startsWith("{")) {
    let j: Record<string, { client_id?: string; client_secret?: string }>;
    try {
      j = JSON.parse(id);
    } catch {
      throw new Error("El JSON de credenciales no es válido.");
    }
    const c = j.installed ?? j.web;
    id = String(c?.client_id ?? "").trim();
    secret = String(c?.client_secret ?? "").trim();
  }
  if (!/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(id)) throw new Error("El Client ID debe terminar en «.apps.googleusercontent.com».");
  if (!secret || secret.length < 8 || /\s/.test(secret)) throw new Error("Falta el Client secret (o no es válido).");
  return { clientId: id, clientSecret: secret };
}

/** Guarda el cliente OAuth. Si cambia de cliente, se borra la autorización anterior. */
export function saveClient(connectionId: string, clientId: string, clientSecret?: string) {
  const input = parseClientInput(clientId, clientSecret);
  const prev = readGoogleSecret(connectionId);
  const keep = prev && prev.clientId === input.clientId ? { refreshToken: prev.refreshToken, accessToken: prev.accessToken, expiresAt: prev.expiresAt, scope: prev.scope, account: prev.account } : {};
  writeGoogleSecret(connectionId, { ...input, ...keep });
}

/** Estado para la interfaz (sin secretos). */
export function oauthState(connectionId: string) {
  const s = readGoogleSecret(connectionId);
  return {
    clientConfigured: Boolean(s),
    clientIdHint: s ? `${s.clientId.slice(0, 12)}…` : null,
    authorized: Boolean(s?.refreshToken),
    account: s?.account ?? null,
  };
}

// ── Flujo OAuth (PKCE) ────────────────────────────────────────────────────

interface Pending {
  connectionId: string;
  verifier: string; // cifrado
  redirectUri: string;
  at: number;
}

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function pendingAll(nowMs: number): Record<string, Pending> {
  const all = getSetting<Record<string, Pending>>(PENDING_KEY, {});
  return Object.fromEntries(Object.entries(all).filter(([, p]) => nowMs - p.at < PENDING_TTL_MS));
}

/** URL de vuelta: siempre al propio PC (127.0.0.1 o localhost), nunca a otro sitio. */
export function redirectUriFor(host: string | null): string {
  const h = (host ?? "").trim();
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/.test(h)) throw new Error("La autorización solo se puede iniciar desde este ordenador.");
  return `http://${h}${CALLBACK_PATH}`;
}

/** Prepara la autorización y devuelve la URL de Google a la que ir. */
export function startAuth(connection: Connection, redirectUri: string, nowMs = Date.now()): string {
  const s = readGoogleSecret(connection.id);
  if (!s) throw new Error("Primero guarda el Client ID y el Client secret de Google Cloud.");
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  setSetting(PENDING_KEY, { ...pendingAll(nowMs), [state]: { connectionId: connection.id, verifier: encryptSecret(verifier), redirectUri, at: nowMs } });
  const q = new URLSearchParams({
    client_id: s.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${AUTH_URL}?${q.toString()}`;
}

interface TokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

/** Vuelta de Google: cambia el código por tokens y los guarda cifrados. */
export async function finishAuth(state: string, code: string, nowMs = Date.now()): Promise<Connection> {
  const all = pendingAll(nowMs);
  const p = all[state];
  if (!p) throw new Error("La autorización ha caducado o no es válida. Vuelve a pulsar «Autorizar con Google».");
  delete all[state];
  setSetting(PENDING_KEY, all);
  const c = getConnection(p.connectionId);
  const s = c && readGoogleSecret(c.id);
  if (!c || !s) throw new Error("Esa conexión ya no existe o no tiene credenciales.");
  try {
    const t = await request<TokenResponse>({
      method: "POST",
      url: TOKEN_URL,
      form: { grant_type: "authorization_code", code, client_id: s.clientId, client_secret: s.clientSecret, redirect_uri: p.redirectUri, code_verifier: decryptSecret(p.verifier) },
    });
    const scopes = (t.scope ?? "").split(/\s+/);
    if (!scopes.includes(SCOPE)) throw new Error("No se concedió el permiso de lectura del calendario. Vuelve a autorizar y marca la casilla de Google Calendar.");
    if (!t.refresh_token && !s.refreshToken) throw new Error("Google no ha devuelto un token de renovación. Quita el acceso de Orden en tu cuenta de Google y vuelve a autorizar.");
    const next: GoogleSecret = {
      ...s,
      accessToken: t.access_token,
      expiresAt: nowMs + (t.expires_in ?? 3600) * 1000,
      refreshToken: t.refresh_token ?? s.refreshToken,
      scope: t.scope,
    };
    // Cuenta autorizada: el id del calendario principal es el correo.
    try {
      const primary = await request<{ id?: string }>({ method: "GET", url: `${CALENDAR_API}/calendars/primary`, token: t.access_token });
      next.account = primary.id;
    } catch {
      next.account = undefined;
    }
    writeGoogleSecret(c.id, next);
    return getConnection(c.id)!;
  } catch (err) {
    throw new Error(clean((err as Error).message, s));
  }
}

/** Token de acceso válido (lo renueva si caduca en menos de 1 min). */
export async function accessToken(connectionId: string, nowMs = Date.now()): Promise<{ token: string; secret: GoogleSecret }> {
  const s = readGoogleSecret(connectionId);
  if (!s) throw new Error("Faltan las credenciales OAuth de Google. Configúralas en Conexiones.");
  if (!s.refreshToken) throw new Error("Google Calendar no está autorizado. Pulsa «Autorizar con Google» en Conexiones.");
  if (s.accessToken && s.expiresAt && s.expiresAt - 60_000 > nowMs) return { token: s.accessToken, secret: s };
  try {
    const t = await request<TokenResponse>({
      method: "POST",
      url: TOKEN_URL,
      form: { grant_type: "refresh_token", refresh_token: s.refreshToken, client_id: s.clientId, client_secret: s.clientSecret },
    });
    const next: GoogleSecret = { ...s, accessToken: t.access_token, expiresAt: nowMs + (t.expires_in ?? 3600) * 1000, refreshToken: t.refresh_token ?? s.refreshToken };
    writeGoogleSecret(connectionId, next);
    return { token: t.access_token, secret: next };
  } catch (err) {
    const msg = (err as Error).message;
    if (/invalid_grant|expired|revoked/i.test(msg))
      throw new Error("La autorización de Google ha caducado o se ha revocado. Pulsa «Autorizar con Google» en Conexiones.");
    throw new Error(clean(msg, s));
  }
}

/** Quita la autorización (y la revoca en Google si se puede). Mantiene el cliente OAuth. */
export async function disconnect(connectionId: string): Promise<void> {
  const s = readGoogleSecret(connectionId);
  if (!s) return;
  if (s.refreshToken) {
    try {
      await request({ method: "POST", url: REVOKE_URL, form: { token: s.refreshToken } });
    } catch {
      // Si Google no responde, se borra igualmente de aquí.
    }
  }
  writeGoogleSecret(connectionId, { clientId: s.clientId, clientSecret: s.clientSecret });
}

// ── Lectura del calendario ────────────────────────────────────────────────

export interface GDateTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}
export interface GEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  start: GDateTime;
  end?: GDateTime;
}
export interface GCalendar {
  id: string;
  summary?: string;
  primary?: boolean;
  accessRole?: string;
}

/** Id de calendario de Google (correo, «primary», …@group.calendar.google.com, festivos con «#»). */
export function safeCalendarId(value: unknown): string {
  const s = String(value ?? "").trim();
  if (!/^[A-Za-z0-9._@#+-]{1,250}$/.test(s) || s.includes("..")) throw new Error(`Calendario no válido: «${s}».`);
  return s;
}

const MAX_EVENTS = 1000;

/** Cliente de lectura atado a una conexión. */
export class CalendarReader {
  constructor(private connectionId: string) {}

  private async get<T>(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    const { token, secret } = await accessToken(this.connectionId);
    const q = new URLSearchParams(Object.entries(params).filter((e): e is [string, string | number | boolean] => e[1] !== undefined && e[1] !== "").map(([k, v]) => [k, String(v)]));
    try {
      return await request<T>({ method: "GET", url: `${CALENDAR_API}${path}${q.size ? `?${q}` : ""}`, token });
    } catch (err) {
      throw new Error(clean((err as Error).message, secret));
    }
  }

  async calendars(): Promise<GCalendar[]> {
    const r = await this.get<{ items?: GCalendar[] }>("/users/me/calendarList", { minAccessRole: "reader", maxResults: 250 });
    return r.items ?? [];
  }

  /** Eventos (recurrentes ya expandidos) entre dos instantes. */
  async events(calendarId: string, timeMin: Date, timeMax: Date, opts: { q?: string; max?: number } = {}): Promise<GEvent[]> {
    const id = safeCalendarId(calendarId);
    const max = Math.min(opts.max ?? MAX_EVENTS, MAX_EVENTS);
    const out: GEvent[] = [];
    let pageToken: string | undefined;
    do {
      const r = await this.get<{ items?: GEvent[]; nextPageToken?: string }>(`/calendars/${encodeURIComponent(id)}/events`, {
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
        showDeleted: false,
        maxResults: 250,
        q: opts.q?.trim() || undefined,
        pageToken,
      });
      out.push(...(r.items ?? []).filter((e) => e.status !== "cancelled"));
      pageToken = r.nextPageToken;
    } while (pageToken && out.length < max);
    return out.slice(0, max);
  }
}
