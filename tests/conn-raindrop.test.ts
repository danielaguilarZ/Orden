import { describe, expect, it } from "vitest";
import { getService } from "@/lib/connections/registry";
import { raindropLimit } from "@/lib/connections/raindrop";
import { callTool, connect, headersOf, jsonBody, mockFetch, team, textOf, toolNames, useConnTestEnv } from "./helpers/conn";

const TOKEN = "0a1b2c3d-4e5f-6789-abcd-ef0123456789";
useConnTestEnv(() => raindropLimit.reset());

describe("Raindrop.io", () => {
  it("lectura: busca y lista colecciones", async () => {
    connect("raindrop", {}, TOKEN, { agent: team.ana, level: "lectura" });
    expect(toolNames(team.ana, "marcadores")).toEqual(["marcadores_buscar", "marcadores_colecciones"]);
    const calls = mockFetch((url) =>
      url.includes("/raindrops/")
        ? { items: [{ _id: 1, title: "Guía de Next.js", link: "https://n.js/g", tags: ["dev"], created: "2026-10-01T10:00:00Z", excerpt: "Todo sobre" }] }
        : url.endsWith("/collections")
          ? { items: [{ _id: 10, title: "Lecturas", count: 3 }] }
          : { items: [{ _id: 11, title: "Dev", count: 1 }] },
    );
    expect(textOf(await callTool(team.ana, "marcadores_buscar", { texto: "next" }))).toBe("- Guía de Next.js · #dev · 2026-10-01\n  https://n.js/g\n  Todo sobre");
    expect(calls[0].url).toBe("https://api.raindrop.io/rest/v1/raindrops/0?perpage=20&sort=-created&search=next");
    expect(headersOf(calls[0]).get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(textOf(await callTool(team.ana, "marcadores_colecciones"))).toBe("- Lecturas · id 10 · 3 marcadores\n- Dev · id 11 · 1 marcadores");
  });

  it("completo: guarda con etiquetas y colección", async () => {
    connect("raindrop", {}, TOKEN, { agent: team.ana, level: "completo" });
    const calls = mockFetch(() => ({ result: true, item: { _id: 5, title: "Artículo", link: "https://a.es" } }));
    expect(textOf(await callTool(team.ana, "marcadores_guardar", { enlace: "https://a.es", etiquetas: ["leer"], coleccion: 10 }))).toBe("Guardado: Artículo · id 5");
    expect(jsonBody(calls[0])).toEqual({ link: "https://a.es", pleaseParse: {}, tags: ["leer"], collection: { $id: 10 } });
  });

  it("prueba sin mostrar el token", async () => {
    const c = connect("raindrop", {}, TOKEN);
    mockFetch(() => ({ user: { fullName: "Daniel" } }));
    expect((await getService("raindrop").test(c)).text).toBe("Raindrop conectado como Daniel.");
    mockFetch(() => new Response(`bad ${TOKEN}`, { status: 401 }));
    expect((await getService("raindrop").test(c)).text).not.toContain(TOKEN);
  });
});
