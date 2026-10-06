import { describe, expect, it } from "vitest";
import { getService } from "@/lib/connections/registry";
import { readwiseLimit } from "@/lib/connections/readwise";
import { callTool, connect, headersOf, jsonBody, mockFetch, team, textOf, toolNames, useConnTestEnv } from "./helpers/conn";

const TOKEN = "rw0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH";
useConnTestEnv(() => readwiseLimit.reset());

const exportData = {
  results: [
    { title: "Hábitos atómicos", author: "James Clear", highlights: [{ text: "Somos lo que hacemos repetidamente.", note: "Para el resumen" }, { text: "Otra frase" }] },
    { title: "Artículo vacío", highlights: [] },
  ],
};

describe("Readwise", () => {
  it("lectura: subrayados por libro y lista de Reader; token en la cabecera", async () => {
    connect("readwise", {}, TOKEN, { agent: team.ana, level: "lectura" });
    expect(toolNames(team.ana, "readwise")).toEqual(["readwise_reader", "readwise_subrayados"]);
    const calls = mockFetch((url) => (url.includes("/v2/export/") ? exportData : { results: [{ title: "Ensayo", author: "Ana", category: "article", reading_progress: 0.5, source_url: "https://x.es/a" }] }));
    const r = textOf(await callTool(team.ana, "readwise_subrayados", { texto: "repetidamente" }));
    expect(r).toBe("## Hábitos atómicos — James Clear\n- «Somos lo que hacemos repetidamente.»\n  Nota: Para el resumen");
    expect(headersOf(calls[0]).get("authorization")).toBe(`Token ${TOKEN}`);
    expect(calls[0].url).toContain("updatedAfter=");
    expect(textOf(await callTool(team.ana, "readwise_reader", {}))).toBe("- Ensayo — Ana · article · leído 50 %\n  https://x.es/a");
    expect(calls.at(-1)!.url).toBe("https://readwise.io/api/v3/list/?location=later");
  });

  it("completo: guarda enlaces en Reader y valida el enlace", async () => {
    connect("readwise", {}, TOKEN, { agent: team.ana, level: "completo" });
    const calls = mockFetch(() => ({ id: "d1", url: "https://read.readwise.io/read/d1" }));
    expect(textOf(await callTool(team.ana, "readwise_guardar", { enlace: "https://x.es/b", etiquetas: ["ia"] }))).toBe("Guardado en Reader: https://read.readwise.io/read/d1");
    expect(jsonBody(calls[0])).toEqual({ url: "https://x.es/b", location: "later", saved_using: "Orden", tags: ["ia"] });
    expect((await callTool(team.ana, "readwise_guardar", { enlace: "javascript:x" })).isError).toBe(true);
  });

  it("prueba: 204 = válido; 401 sin mostrar el token", async () => {
    const c = connect("readwise", {}, TOKEN);
    mockFetch(() => null);
    expect((await getService("readwise").test(c)).text).toBe("Token de Readwise válido.");
    mockFetch(() => new Response(`Invalid token ${TOKEN}`, { status: 401 }));
    const t = await getService("readwise").test(c);
    expect(t.ok).toBe(false);
    expect(t.text).not.toContain(TOKEN);
  });
});
