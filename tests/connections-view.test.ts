import { describe, expect, it } from "vitest";
import { catalogItems, connectionSections, connectionStatus, grantCount, serviceMonogram, type ConnView } from "@/lib/connections/view";
import { UPCOMING_SERVICES } from "@/lib/connections/catalog";
import type { ServiceInfo } from "@/lib/connections/registry";

const svc = (over: Partial<ServiceInfo> = {}): ServiceInfo => ({
  key: "notion",
  label: "Notion",
  description: "Páginas compartidas",
  levels: { lectura: "Leer", completo: "Escribir" },
  fields: [],
  supportsSecret: true,
  ...over,
});

const conn = (over: Partial<ConnView> = {}): ConnView => ({
  id: "c1",
  service: "notion",
  name: "Notion",
  config: {},
  auth: "auto",
  hasSecret: true,
  enabled: true,
  statusPanelId: null,
  lastSyncAt: null,
  lastError: null,
  grants: {},
  createdAt: "",
  updatedAt: "",
  secretHint: null,
  oauth: null,
  ...over,
});

describe("connectionStatus", () => {
  it("pausada si está desactivada, aunque tenga errores", () => {
    expect(connectionStatus(conn({ enabled: false, lastError: "x" }), svc())).toMatchObject({ tone: "off", label: "Pausada" });
  });
  it("pide el token si el servicio lo necesita y no está", () => {
    expect(connectionStatus(conn({ hasSecret: false }), svc({ secretLabel: "Token de integración" }))).toEqual({ tone: "warn", label: "Falta el token de integración", needsSetup: true });
  });
  it("GitHub con gh no necesita token; con modo «token», sí", () => {
    const gh = svc({ key: "github", label: "GitHub" });
    expect(connectionStatus(conn({ service: "github", hasSecret: false, auth: "auto" }), gh).tone).toBe("ok");
    expect(connectionStatus(conn({ service: "github", hasSecret: false, auth: "token" }), gh).needsSetup).toBe(true);
  });
  it("OAuth: primero el cliente, luego la autorización", () => {
    const g = svc({ key: "google_calendar", authKind: "oauth", supportsSecret: false, readOnly: true });
    const base = { service: "google_calendar", hasSecret: false };
    expect(connectionStatus(conn({ ...base, oauth: { clientConfigured: false, clientIdHint: null, authorized: false, account: null } }), g)).toMatchObject({ label: "Falta configurar", needsSetup: true });
    expect(connectionStatus(conn({ ...base, oauth: { clientConfigured: true, clientIdHint: "…abc", authorized: false, account: null } }), g)).toMatchObject({ label: "Sin autorizar", needsSetup: false });
    expect(connectionStatus(conn({ ...base, oauth: { clientConfigured: true, clientIdHint: "…abc", authorized: true, account: "yo@x" } }), g).tone).toBe("ok");
  });
  it("con error, en rojo", () => {
    expect(connectionStatus(conn({ lastError: "401" }), svc()).tone).toBe("bad");
  });
});

describe("serviceMonogram y grantCount", () => {
  it("monograma sin emojis: iniciales, mayúscula interior o primera letra", () => {
    expect(serviceMonogram("github", "GitHub")).toBe("GH");
    expect(serviceMonogram("google_calendar", "Google Calendar")).toBe("GC");
    expect(serviceMonogram("clima", "Tiempo (clima)")).toBe("TC");
    expect(serviceMonogram("drive", "Google Drive / Docs / Sheets")).toBe("GD");
    expect(serviceMonogram("x", "Zapier")).toBe("Z");
    expect(serviceMonogram("sin_nombre")).toBe("S");
  });
  it("cuenta agentes con permiso", () => {
    expect(grantCount({ grants: { a: "lectura", b: "completo" } })).toBe(2);
    expect(grantCount({ grants: {} })).toBe(0);
  });
});

describe("catalogItems", () => {
  const services = [svc(), svc({ key: "clima", label: "Tiempo (clima)", description: "Previsión", supportsSecret: false })];
  it("disponibles primero y luego las que vendrán", () => {
    const all = catalogItems(services, UPCOMING_SERVICES);
    expect(all).toHaveLength(2 + UPCOMING_SERVICES.length);
    expect(all.slice(0, 2).every((i) => i.available)).toBe(true);
    expect(all[1].tag).toBe("Sin claves");
  });
  it("filtra por tipo", () => {
    expect(catalogItems(services, UPCOMING_SERVICES, "", "disponibles").map((i) => i.key)).toEqual(["notion", "clima"]);
    expect(catalogItems(services, UPCOMING_SERVICES, "", "proximamente").every((i) => !i.available)).toBe(true);
  });
  it("busca sin tildes ni mayúsculas, también en la descripción", () => {
    expect(catalogItems(services, UPCOMING_SERVICES, "PREVISION").map((i) => i.key)).toEqual(["clima"]);
    expect(catalogItems(services, UPCOMING_SERVICES, "gmail", "disponibles")).toEqual([]);
  });
});

describe("connectionSections", () => {
  const services = [
    svc(),
    svc({ key: "clima", label: "Tiempo (clima)", description: "Previsión", supportsSecret: false }),
    svc({ key: "github", label: "GitHub", description: "Repos", category: "dev" }),
  ];
  const conns = [conn({ id: "b", name: "Zeta", service: "notion" }), conn({ id: "a", name: "Alfa", service: "github", hasSecret: false, auth: "token" })];

  it("activas arriba (por nombre, con estado), disponibles con su recuento y próximamente aparte", () => {
    const s = connectionSections(services, conns, UPCOMING_SERVICES);
    expect(s.activas.map((a) => a.conn.name)).toEqual(["Alfa", "Zeta"]);
    expect(s.activas.map((a) => a.status.tone)).toEqual(["warn", "ok"]);
    expect(s.activas[0].monogram).toBe("GH");
    expect(s.disponibles.every((d) => d.available)).toBe(true);
    expect(s.disponibles.find((d) => d.key === "notion")!.connected).toBe(1);
    expect(s.disponibles.find((d) => d.key === "clima")!.connected).toBe(0);
    expect(s.proximamente).toHaveLength(UPCOMING_SERVICES.length);
    expect(s.proximamente.every((p) => !p.available && p.tag === "Próximamente")).toBe(true);
  });

  it("disponibles y próximamente, por categoría y nombre", () => {
    const s = connectionSections(services, [], UPCOMING_SERVICES);
    // notas (Notion) → info (Tiempo) → dev (GitHub), según el orden de CATEGORIES.
    expect(s.disponibles.map((d) => d.key)).toEqual(["notion", "clima", "github"]);
    expect(s.proximamente[0].key).toBe("google_tasks");
  });

  it("el buscador filtra las tres secciones (sin tildes)", () => {
    const s = connectionSections(services, conns, UPCOMING_SERVICES, "zeta");
    expect(s.activas.map((a) => a.conn.id)).toEqual(["b"]);
    expect(s.disponibles).toEqual([]);
    const t = connectionSections(services, conns, UPCOMING_SERVICES, "PREVISIÓN");
    expect(t.activas).toEqual([]);
    expect(t.disponibles.map((d) => d.key)).toEqual(["clima"]);
  });
});
