import { describe, expect, it } from "vitest";
import { addConnection } from "@/lib/connections";
import { getService } from "@/lib/connections/registry";
import { trelloLimit } from "@/lib/connections/trello";
import { callTool, connect, headersOf, jsonBody, mockFetch, team, textOf, toolNames, useConnTestEnv } from "./helpers/conn";

const KEY = "0123456789abcdef0123456789abcdef";
const TOKEN = "ATTA0123456789abcdef0123456789abcdef0123456789abcdef";
useConnTestEnv(() => trelloLimit.reset());

const B = "aaaaaaaaaaaaaaaaaaaaaaaa";
const L1 = "bbbbbbbbbbbbbbbbbbbbbbbb";
const L2 = "cccccccccccccccccccccccc";
const K1 = "dddddddddddddddddddddddd";

function trello(url: string, init?: RequestInit) {
  const path = new URL(url).pathname;
  if (path === "/1/members/me/boards") return [{ id: B, name: "Mudanza", url: "https://trello.com/b/x" }];
  if (path === "/1/members/me") return { username: "dani", fullName: "Daniel" };
  if (path.endsWith("/lists")) return [{ id: L1, name: "Por hacer" }, { id: L2, name: "Hecho" }];
  if (path.endsWith("/cards") && path.startsWith("/1/boards")) return [{ id: K1, name: "Cajas", idList: L1, due: "2026-10-10T10:00:00.000Z", labels: [{ name: "Urgente" }] }];
  if (path === "/1/search") return { cards: [{ id: K1, name: "Cajas" }] };
  if (path === "/1/cards" && init?.method === "POST") return { id: "eeeeeeeeeeeeeeeeeeeeeeee", name: "Llamar al casero", url: "https://trello.com/c/y" };
  if (path.endsWith("/actions/comments")) return { id: "act" };
  return new Response("no", { status: 404 });
}

describe("Trello", () => {
  it("valida la clave de API", () => {
    expect(() => addConnection("trello", { api_key: "corta" })).toThrow(/32 caracteres/);
    expect(addConnection("trello", { api_key: KEY }).name).toBe("Trello");
  });

  it("lectura: tableros, tablero por nombre y búsqueda; credenciales en la cabecera, no en la URL", async () => {
    connect("trello", { api_key: KEY }, TOKEN, { agent: team.ana, level: "lectura" });
    expect(toolNames(team.ana, "trello")).toEqual(["trello_buscar", "trello_tablero", "trello_tableros"]);
    const calls = mockFetch(trello);
    expect(textOf(await callTool(team.ana, "trello_tableros"))).toContain(`- Mudanza · id ${B}`);
    const board = textOf(await callTool(team.ana, "trello_tablero", { tablero: "mudanza" }));
    expect(board).toContain("## Por hacer (1)");
    expect(board).toContain(`- Cajas · vence 2026-10-10 · [Urgente] · id ${K1}`);
    expect(board).toContain("## Hecho (0)");
    const onlyDone = textOf(await callTool(team.ana, "trello_tablero", { tablero: "Mudanza", lista: "hecho" }));
    expect(onlyDone).not.toContain("Por hacer");
    expect(textOf(await callTool(team.ana, "trello_buscar", { texto: "cajas" }))).toContain("Cajas");
    for (const c of calls) {
      expect(c.url).not.toContain(TOKEN);
      expect(headersOf(c).get("authorization")).toBe(`OAuth oauth_consumer_key="${KEY}", oauth_token="${TOKEN}"`);
    }
    const missing = await callTool(team.ana, "trello_tablero", { tablero: "Otro" });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("Tableros: Mudanza");
  });

  it("completo: crea tarjetas en una lista por nombre y comenta", async () => {
    connect("trello", { api_key: KEY }, TOKEN, { agent: team.ana, level: "completo" });
    expect(toolNames(team.ana, "trello")).toContain("trello_crear_tarjeta");
    const calls = mockFetch(trello);
    const r = await callTool(team.ana, "trello_crear_tarjeta", { tablero: "Mudanza", lista: "por hacer", titulo: "Llamar al casero", vence: "2026-10-12" });
    expect(textOf(r)).toContain("Tarjeta creada: Llamar al casero");
    const post = calls.find((c) => c.init?.method === "POST")!;
    expect(jsonBody(post)).toMatchObject({ idList: L1, name: "Llamar al casero", pos: "bottom", due: "2026-10-12T00:00:00.000Z" });
    expect(textOf(await callTool(team.ana, "trello_comentar", { tarjeta: K1, texto: "Hecho" }))).toBe("Comentario añadido.");
    expect((await callTool(team.ana, "trello_comentar", { tarjeta: "../x", texto: "x" })).isError).toBe(true);
  });

  it("prueba la conexión sin mostrar el token", async () => {
    const c = connect("trello", { api_key: KEY }, TOKEN);
    mockFetch(trello);
    expect((await getService("trello").test(c)).text).toBe("Trello conectado como Daniel: 1 tablero(s) abiertos.");
    mockFetch(() => new Response(`invalid token ${TOKEN}`, { status: 401 }));
    const t = await getService("trello").test(c);
    expect(t.ok).toBe(false);
    expect(t.text).not.toContain(TOKEN);
  });
});
