import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openDb, getDb, setDbForTests } from "@/lib/db";
import { ensureSeed } from "@/lib/seed";
import { getChief } from "@/lib/repo/agents";
import { createTask } from "@/lib/repo/tasks";
import { hireAgent } from "@/lib/team";
import { buildTools, type ToolDef } from "@/lib/agents/tools";
import { buildSystemPrompt } from "@/lib/agents/prompt";
import { redact } from "@/lib/secrets";
import { getConnection, listConnections, setGrant, updateConnection } from "@/lib/repo/connections";
import { addConnection, connectionView } from "@/lib/connections";
import { getService, serviceInfo } from "@/lib/connections/registry";
import { setTransportForTests } from "@/lib/connections/github/api";
import { GOOGLE_CALENDAR } from "@/lib/connections/google";
import {
  accessToken,
  assertAllowed,
  CALENDAR_API,
  disconnect,
  finishAuth,
  oauthState,
  parseClientInput,
  redirectUriFor,
  saveClient,
  SCOPE,
  setGoogleFetchForTests,
  startAuth,
  type GoogleRequest,
} from "@/lib/connections/google/api";
import { plainText } from "@/lib/connections/google/sync";
import { addDays, dateToLocal, localToDate } from "@/lib/connections/google/time";
import { listActivity } from "@/lib/repo/system";
import "@/lib/agents/modules";
import type { Agent } from "@/lib/types";

const TZ = "Europe/Madrid";
const CLIENT_ID = "1234-abc.apps.googleusercontent.com";
const CLIENT_SECRET = "GOCSPX-secretodeprueba1234";
const REFRESH = "1//refresh-token-de-prueba-abcdefghij";

beforeAll(() => {
  process.env.ORDEN_SECRET_KEY = "b".repeat(64);
});
afterAll(() => {
  delete process.env.ORDEN_SECRET_KEY;
  setGoogleFetchForTests(null);
  setTransportForTests(null);
});

/** Google de mentira: registra las llamadas y devuelve eventos según el calendario. */
let calls: GoogleRequest[] = [];
let grantedScope = SCOPE;
let events: Record<string, unknown[]> = {};
function fakeGoogle() {
  calls = [];
  grantedScope = SCOPE;
  events = {
    primary: [
      { id: "ev1", summary: "Dentista", location: "Clínica", start: { dateTime: "2026-10-05T08:00:00Z" }, end: { dateTime: "2026-10-05T09:00:00Z" } },
      { id: "ev2", summary: "Vacaciones", start: { date: "2026-10-10" }, end: { date: "2026-10-13" }, description: "<b>Playa</b><br>y sol &amp; mar" },
      { id: "ev3", status: "cancelled", start: { date: "2026-10-06" } },
    ],
  };
  setGoogleFetchForTests(async (req) => {
    assertAllowed(req);
    calls.push(req);
    if (req.url === "https://oauth2.googleapis.com/token") {
      if (req.form?.grant_type === "authorization_code") return { access_token: "ya29.acceso-inicial-abcdefghijklmnopqrstuv", expires_in: 3600, refresh_token: REFRESH, scope: grantedScope };
      return { access_token: "ya29.acceso-renovado-abcdefghijklmnopqrstuv", expires_in: 3600 };
    }
    if (req.url === "https://oauth2.googleapis.com/revoke") return {};
    if (req.url === `${CALENDAR_API}/calendars/primary`) return { id: "usuario@example.com" };
    if (req.url.startsWith(`${CALENDAR_API}/users/me/calendarList`)) return { items: [{ id: "usuario@example.com", summary: "Usuario", primary: true }] };
    const m = req.url.match(/\/calendars\/([^/]+)\/events\?/);
    if (m) return { items: events[decodeURIComponent(m[1])] ?? [] };
    throw new Error(`Ruta no prevista en el test: ${req.method} ${req.url}`);
  });
}

let marta: Agent, ana: Agent, sara: Agent;

beforeEach(() => {
  setDbForTests(openDb(":memory:"));
  ensureSeed();
  marta = hireAgent({ name: "Marta", specialty: "Coordinadora de proyectos" });
  ana = hireAgent({ name: "Ana", specialty: "Finanzas personales" });
  sara = hireAgent({ name: "Sara", specialty: "Marketing" });
  setTransportForTests(async () => {
    throw new Error("Sin GitHub en este test");
  });
  fakeGoogle();
});

const google = () => listConnections("google_calendar")[0];

/** Conexión de Google Calendar: lectura para Zen, Marta y Ana. */
function connectGoogle() {
  const c = addConnection(GOOGLE_CALENDAR, { calendars: ["primary"] });
  for (const a of [getChief()!, marta, ana]) setGrant(c.id, a.id, "lectura");
  return getConnection(c.id)!;
}

async function authorize() {
  const c = google();
  saveClient(c.id, CLIENT_ID, CLIENT_SECRET);
  const url = new URL(startAuth(c, redirectUriFor("127.0.0.1:3000")));
  await finishAuth(url.searchParams.get("state")!, "codigo-de-google");
  return getConnection(c.id)!;
}

function toolsOf(agent: Agent): ToolDef[] {
  const task = createTask({ agentId: agent.id, kind: "chat", prompt: "x" });
  return buildTools({ agent, task, signal: new AbortController().signal, note: () => {} });
}
const googleNames = (agent: Agent) =>
  toolsOf(agent)
    .map((t) => t.name)
    .filter((n) => n.startsWith("google_"))
    .sort();
async function call(agent: Agent, name: string, args: Record<string, unknown>) {
  const t = toolsOf(agent).find((x) => x.name === name);
  if (!t) throw new Error(`${agent.name} no tiene ${name}`);
  return (await t.handler(args, {})) as { content: { text: string }[]; isError?: boolean };
}

describe("zona horaria", () => {
  it("hora local ↔ instante, con cambio de hora", () => {
    expect(localToDate("2026-10-05T10:00", TZ).toISOString()).toBe("2026-10-05T08:00:00.000Z"); // CEST +2
    expect(localToDate("2026-12-01", TZ).toISOString()).toBe("2026-11-30T23:00:00.000Z"); // CET +1
    expect(localToDate("2026-10-26", TZ).toISOString()).toBe("2026-10-25T23:00:00.000Z"); // tras el cambio del 25/10
    expect(dateToLocal(new Date("2026-10-05T08:00:00Z"), TZ)).toBe("2026-10-05T10:00");
    expect(dateToLocal(new Date("2026-10-25T01:30:00Z"), TZ)).toBe("2026-10-25T02:30");
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
  });
});

describe("texto de los eventos", () => {
  it("descripción HTML → texto plano", () => {
    expect(plainText("<p>Hola<br/>Ana &amp; Leo</p>")).toBe("Hola\nAna & Leo");
    expect(plainText("   ")).toBeUndefined();
  });
});

describe("conexión y permisos", () => {
  it("no hay conexión de serie; al crearla queda en solo lectura y sin panel", () => {
    expect(listConnections("google_calendar")).toHaveLength(0);
    connectGoogle();
    const all = listConnections("google_calendar");
    expect(all).toHaveLength(1);
    const c = all[0];
    expect(c.grants).toEqual({ [getChief()!.id]: "lectura", [marta.id]: "lectura", [ana.id]: "lectura" });
    expect(c.statusPanelId).toBeNull();
    expect(c.config).toEqual({ calendars: ["primary"] });
    expect(serviceInfo(getService("google_calendar"))).toMatchObject({ readOnly: true, authKind: "oauth", supportsSecret: false });
    expect("sync" in getService("google_calendar")).toBe(false);
  });

  it("herramientas solo para quien tiene permiso (y nunca de escritura)", () => {
    connectGoogle();
    const names = ["google_calendario_calendarios", "google_calendario_eventos"];
    expect(googleNames(getChief()!)).toEqual(names);
    expect(googleNames(marta)).toEqual(names);
    expect(googleNames(ana)).toEqual(names);
    expect(googleNames(sara)).toEqual([]);
    setGrant(google().id, ana.id, null);
    expect(googleNames(ana)).toEqual([]);
    const task = createTask({ agentId: marta.id, kind: "chat", prompt: "x" });
    expect(buildSystemPrompt(marta, task)).toContain("Google Calendar (solo lectura");
    expect(buildSystemPrompt(marta, task)).toContain("AÚN SIN AUTORIZAR");
  });
});

describe("OAuth", () => {
  beforeEach(() => connectGoogle());

  it("acepta el JSON de Google Cloud y valida las credenciales", () => {
    expect(parseClientInput(JSON.stringify({ installed: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET } }))).toEqual({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    expect(() => parseClientInput("no-es-un-id", "x")).toThrow(/apps.googleusercontent.com/);
    expect(() => parseClientInput(CLIENT_ID, "")).toThrow(/secret/);
    expect(() => redirectUriFor("evil.com")).toThrow();
    expect(redirectUriFor("localhost:3000")).toBe("http://localhost:3000/api/connections/google/callback");
  });

  it("pide solo calendar.readonly con PKCE y guarda los tokens cifrados", async () => {
    const c = google();
    expect(() => startAuth(c, "http://127.0.0.1:3000/x")).toThrow(/Client ID/);
    saveClient(c.id, CLIENT_ID, CLIENT_SECRET);
    const url = new URL(startAuth(c, redirectUriFor("127.0.0.1:3000")));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/calendar.readonly");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");

    await finishAuth(url.searchParams.get("state")!, "codigo");
    const tokenCall = calls.find((x) => x.form?.grant_type === "authorization_code")!;
    expect(tokenCall.form!.code_verifier).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    const raw = (getDb().prepare("SELECT secret FROM connections WHERE id = ?").get(c.id) as { secret: string }).secret;
    for (const s of [REFRESH, CLIENT_SECRET, "ya29."]) expect(raw).not.toContain(s);
    expect(oauthState(c.id)).toEqual({ clientConfigured: true, clientIdHint: "1234-abc.app…", authorized: true, account: "usuario@example.com" });
    const view = JSON.stringify(connectionView(getConnection(c.id)!));
    for (const s of [REFRESH, CLIENT_SECRET, "ya29."]) expect(view).not.toContain(s);

    // El «state» es de un solo uso.
    await expect(finishAuth(url.searchParams.get("state")!, "codigo")).rejects.toThrow(/caducado/);
  });

  it("rechaza la autorización si no se concede el permiso de calendario", async () => {
    grantedScope = "openid";
    await expect(authorize()).rejects.toThrow(/lectura del calendario/);
    expect(oauthState(google().id).authorized).toBe(false);
  });

  it("renueva el token caducado y desconecta revocando en Google", async () => {
    const c = await authorize();
    const t = await accessToken(c.id, Date.now() + 2 * 3600_000);
    expect(t.token).toContain("acceso-renovado");
    expect(calls.some((x) => x.form?.grant_type === "refresh_token" && x.form.refresh_token === REFRESH)).toBe(true);
    await disconnect(c.id);
    expect(calls.some((x) => x.url.endsWith("/revoke"))).toBe(true);
    expect(oauthState(c.id)).toMatchObject({ clientConfigured: true, authorized: false });
  });

  it("candado de solo lectura y limpieza de tokens en errores", () => {
    expect(() => assertAllowed({ method: "POST", url: `${CALENDAR_API}/calendars/primary/events` })).toThrow(/solo lectura/);
    expect(() => assertAllowed({ method: "GET", url: "https://evil.example.com/" })).toThrow(/no permitido/);
    expect(redact("token ya29.a0AfH6SMBabcdefghijklmnopqrstuvwxyz y 1//0gabcdefghijklmnopqrstuvwxyz y GOCSPX-abcdefghijkl")).toBe("token *** y *** y ***");
  });
});

describe("herramientas", () => {
  beforeEach(() => connectGoogle());

  it("sin autorizar, la herramienta lo explica", async () => {
    const r = await call(marta, "google_calendario_eventos", { desde: "2026-10-05" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/Autorizar con Google|credenciales/);
  });

  it("lista eventos por rango en hora local y deja constancia en Actividad", async () => {
    await authorize();
    calls = [];
    const r = await call(ana, "google_calendario_eventos", { desde: "2026-10-05", hasta: "2026-10-11" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("2 evento(s) del 2026-10-05 al 2026-10-11");
    expect(r.content[0].text).toContain("10:00–11:00 · Dentista · Clínica");
    expect(r.content[0].text).toContain("todo el día · Vacaciones");
    const ev = new URL(calls.find((x) => x.url.includes("/events?"))!.url);
    expect(ev.searchParams.get("timeMin")).toBe("2026-10-04T22:00:00.000Z");
    expect(ev.searchParams.get("timeMax")).toBe("2026-10-11T22:00:00.000Z");
    expect(ev.searchParams.get("singleEvents")).toBe("true");
    expect(calls.every((x) => x.method === "GET")).toBe(true);
    expect(listActivity({ kind: "conexion" })[0].text).toContain("Ana en Google Calendar: leídos 2 evento(s)");

    expect((await call(ana, "google_calendario_eventos", { desde: "2026-10-05", hasta: "2026-01-01" })).isError).toBe(true);
    expect((await call(ana, "google_calendario_eventos", { desde: "2026-01-01", hasta: "2026-12-31" })).content[0].text).toMatch(/demasiado largo/);
  });

  it("no hay volcado a paneles: el prompt manda consultar la agenda cuando haga falta", async () => {
    await authorize();
    const task = createTask({ agentId: marta.id, kind: "chat", prompt: "x" });
    const prompt = buildSystemPrompt(marta, task);
    expect(prompt).not.toContain("google_calendario_volcar");
    expect(prompt).not.toContain("panel de calendario");
    expect(prompt).toContain("google_calendario_eventos(desde, hasta) para consultar la agenda");
    await expect(call(getChief()!, "google_calendario_volcar", {})).rejects.toThrow(/no tiene/);
    // La configuración antigua (con «panel») se limpia al guardarla de nuevo.
    expect(getService(GOOGLE_CALENDAR).normalizeConfig({ calendars: "primary", panel: true })).toEqual({ calendars: ["primary"] });
  });
});
