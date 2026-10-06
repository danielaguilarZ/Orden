import { describe, expect, it } from "vitest";
import { addConnection } from "@/lib/connections";
import { getService } from "@/lib/connections/registry";
import { holidaysText } from "@/lib/connections/holidays";
import { checkSites } from "@/lib/connections/uptime";
import { callTool, connect, mockFetch, team, textOf, toolNames, useConnTestEnv } from "./helpers/conn";

useConnTestEnv();

describe("Wikipedia", () => {
  it("busca y resume en el idioma configurado", async () => {
    expect(() => addConnection("wikipedia", { idioma: "español" })).toThrow(/Idioma/);
    connect("wikipedia", { idioma: "es" }, undefined, { agent: team.ana, level: "lectura" });
    expect(toolNames(team.ana, "wikipedia")).toEqual(["wikipedia_buscar", "wikipedia_resumen"]);
    const calls = mockFetch((url) =>
      url.includes("/w/api.php")
        ? { query: { search: [{ title: "Alhambra", snippet: 'La <span class="searchmatch">Alhambra</span> es una ciudad &quot;palatina&quot;' }] } }
        : { title: "Alhambra", description: "monumento de Granada", extract: "La Alhambra es…", content_urls: { desktop: { page: "https://es.wikipedia.org/wiki/Alhambra" } } },
    );
    expect(textOf(await callTool(team.ana, "wikipedia_buscar", { texto: "alhambra" }))).toBe('- Alhambra: La Alhambra es una ciudad "palatina"');
    expect(new URL(calls[0].url).host).toBe("es.wikipedia.org");
    const r = textOf(await callTool(team.ana, "wikipedia_resumen", { titulo: "La Alhambra", idioma: "en" }));
    expect(r).toBe("Alhambra (monumento de Granada)\nLa Alhambra es…\nFuente: https://es.wikipedia.org/wiki/Alhambra");
    expect(calls[1].url).toBe("https://en.wikipedia.org/api/rest_v1/page/summary/La_Alhambra");
  });
});

describe("Festivos", () => {
  const data = [
    { date: "2026-10-12", localName: "Fiesta Nacional de España", name: "National Day", global: true, counties: null },
    { date: "2026-11-09", localName: "Almudena", name: "Almudena", global: false, counties: ["ES-MD"] },
    { date: "2026-09-11", localName: "Diada", name: "Diada", global: false, counties: ["ES-CT"] },
    { date: "2026-12-08", localName: "Inmaculada", name: "Immaculate", global: true, counties: null },
  ];

  it("valida país y región", () => {
    expect(() => addConnection("festivos", { pais: "ESP" })).toThrow(/País/);
    expect(() => addConnection("festivos", { pais: "ES", region: "FR-75" })).toThrow(/Región/);
    expect(addConnection("festivos", { region: "es-md" }).config).toEqual({ pais: "ES", region: "ES-MD" });
  });

  it("nacionales y de la región, desde una fecha", async () => {
    const calls = mockFetch((url) => (url.endsWith("/2026/ES") ? data : []));
    const r = await holidaysText("ES", "ES-MD", { from: "2026-10-05" });
    expect(r).toBe("Festivos de ES (ES-MD) próximos:\n- 2026-10-12 · Fiesta Nacional de España\n- 2026-11-09 · Almudena (regional)\n- 2026-12-08 · Inmaculada");
    expect(calls.map((c) => c.url)).toEqual(["https://date.nager.at/api/v3/PublicHolidays/2026/ES", "https://date.nager.at/api/v3/PublicHolidays/2027/ES"]);
    connect("festivos", { pais: "ES", region: "ES-CT" }, undefined, { agent: team.ana, level: "lectura" });
    const y = textOf(await callTool(team.ana, "festivos", { anio: 2026 }));
    expect(y).toContain("Diada");
    expect(y).not.toContain("Almudena");
  });
});

describe("Monitor de webs", () => {
  it("normaliza direcciones", () => {
    expect(addConnection("monitor_webs", { webs: "miweb.es, https://cliente.com/" }).config).toEqual({ webs: ["https://miweb.es/", "https://cliente.com/"] });
    expect(() => addConnection("monitor_webs", { webs: "" })).toThrow(/al menos/);
    expect(() => addConnection("monitor_webs", { webs: "ftp://x.es" })).toThrow(/http/);
  });

  it("código, tiempo y fallos de red", async () => {
    mockFetch((url) => {
      if (url.includes("caida")) throw new Error("ECONNREFUSED");
      return new Response("x", { status: url.includes("error") ? 503 : 200 });
    });
    const r = await checkSites(["https://ok.es/", "https://error.es/", "https://caida.es/"]);
    expect(r.split("\n")[0]).toBe("1 de 3 webs responden bien; 2 con problemas:");
    expect(r).toMatch(/✅ https:\/\/ok\.es\/ · código 200 · \d+ ms/);
    expect(r).toMatch(/❌ https:\/\/error\.es\/ · código 503/);
    expect(r).toMatch(/❌ https:\/\/caida\.es\/ · ECONNREFUSED/);
  });

  it("herramienta con filtro y prueba", async () => {
    const c = connect("monitor_webs", { webs: "https://a.es, https://b.es" }, undefined, { agent: team.ana, level: "lectura" });
    mockFetch(() => new Response("x", { status: 200 }));
    expect(textOf(await callTool(team.ana, "webs_estado", { filtro: "b.es" }))).toContain("1 de 1 webs responden bien");
    expect((await callTool(team.ana, "webs_estado", { filtro: "zzz" })).isError).toBe(true);
    expect((await getService("monitor_webs").test(c)).text).toContain("2 de 2");
  });
});
