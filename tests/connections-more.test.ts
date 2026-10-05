import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, openDb, setDbForTests } from "@/lib/db";
import { ensureSeed } from "@/lib/seed";
import { getChief } from "@/lib/repo/agents";
import { createTask } from "@/lib/repo/tasks";
import { hireAgent } from "@/lib/team";
import { buildTools, type ToolDef } from "@/lib/agents/tools";
import { buildSystemPrompt } from "@/lib/agents/prompt";
import "@/lib/agents/modules";
import { addConnection, listServices } from "@/lib/connections";
import { getService, serviceInfo } from "@/lib/connections/registry";
import { setConnectionSecret, setGrant, getConnection, type Connection } from "@/lib/repo/connections";
import { forecastText, weatherText } from "@/lib/connections/weather";
import { headlines, parseFeed, parseFeedList } from "@/lib/connections/rss";
import { DAILY_LIMIT, resetTelegramLimits, sendNotice } from "@/lib/connections/telegram";
import { blocksToText, pageId, textToBlocks, titleOf } from "@/lib/connections/notion";
import { fetchText } from "@/lib/connections/http";
import { UPCOMING_SERVICES } from "@/lib/connections/catalog";
import type { Agent } from "@/lib/types";

const BOT_TOKEN = "123456789:AAH-abcdefghijklmnopqrstuvwxyz0123456";
const NOTION_TOKEN = "ntn_abcdefghijklmnopqrstuvwxyz0123456789ABCD";

beforeAll(() => {
  process.env.ORDEN_SECRET_KEY = "c".repeat(64);
});
afterAll(() => {
  delete process.env.ORDEN_SECRET_KEY;
});

let zen: Agent;
let ana: Agent;
beforeEach(() => {
  setDbForTests(openDb(":memory:"));
  ensureSeed();
  zen = getChief()!;
  ana = hireAgent({ name: "Ana", specialty: "Noticias y agenda" });
  resetTelegramLimits();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

type Call = { url: string; init?: RequestInit };
function mockFetch(handler: (url: string, init?: RequestInit) => unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const out = await handler(url, init);
      return out instanceof Response ? out : new Response(typeof out === "string" ? out : JSON.stringify(out), { status: 200 });
    }),
  );
  return calls;
}

function toolsOf(agent: Agent): ToolDef[] {
  const task = createTask({ agentId: agent.id, kind: "chat", prompt: "x" });
  return buildTools({ agent, task, signal: new AbortController().signal, note: () => {} });
}
const toolNames = (agent: Agent, prefix: string) =>
  toolsOf(agent)
    .map((t) => t.name)
    .filter((n) => n.startsWith(prefix))
    .sort();
async function call(agent: Agent, name: string, args: Record<string, unknown>) {
  const t = toolsOf(agent).find((x) => x.name === name);
  if (!t) throw new Error(`${agent.name} no tiene ${name}`);
  return (await t.handler(args, {})) as { content: { text: string }[]; isError?: boolean };
}

describe("catálogo", () => {
  it("las cuatro nuevas están disponibles con pasos, y las que vendrán no se solapan", () => {
    const keys = listServices().map((s) => s.key);
    for (const k of ["clima", "rss", "telegram", "notion"]) {
      expect(keys).toContain(k);
      expect(serviceInfo(getService(k)).steps!.length).toBeGreaterThanOrEqual(3);
    }
    for (const u of UPCOMING_SERVICES) expect(keys).not.toContain(u.key);
    expect(serviceInfo(getService("clima")).readOnly).toBe(true);
    expect(serviceInfo(getService("telegram"))).toMatchObject({ supportsSecret: true, secretLabel: "Token del bot" });
  });
});

describe("http seguro", () => {
  it("solo http(s), con límite de tamaño y sin secretos en los errores", async () => {
    await expect(fetchText("file:///etc/passwd")).rejects.toThrow(/http/);
    mockFetch(() => "x".repeat(500));
    await expect(fetchText("https://ejemplo.com/a", {}, { maxBytes: 100 })).rejects.toThrow(/grande/);
    mockFetch(() => new Response(`token malo ${BOT_TOKEN}`, { status: 401 }));
    const err = await fetchText("https://ejemplo.com/b", {}, { secrets: [BOT_TOKEN] }).catch((e: Error) => e.message);
    expect(err).toContain("401");
    expect(err).not.toContain(BOT_TOKEN);
  });
});

describe("Tiempo (clima)", () => {
  const forecast = {
    current: { temperature_2m: 21.4, weather_code: 0, wind_speed_10m: 9.6 },
    daily: { time: ["2026-10-05"], weather_code: [61], temperature_2m_max: [22.2], temperature_2m_min: [11.8], precipitation_probability_max: [40] },
  };

  it("valida el lugar", () => {
    expect(() => addConnection("clima", { lugar: "  " })).toThrow(/ciudad/);
    expect(addConnection("clima", { lugar: "Madrid" }).name).toBe("Tiempo · Madrid");
  });

  it("geocodifica y da la previsión en texto", async () => {
    const calls = mockFetch((url) =>
      url.includes("geocoding") ? { results: [{ name: "Madrid", admin1: "Comunidad de Madrid", country: "España", latitude: 40.4, longitude: -3.7 }] } : forecast,
    );
    const text = await forecastText("Madrid", 1);
    expect(text).toContain("Tiempo en Madrid, Comunidad de Madrid, España");
    expect(text).toContain("Ahora: 21 °C, despejado, viento 10 km/h");
    expect(text).toContain("2026-10-05: lluvia débil, 12–22 °C, lluvia 40 %");
    expect(calls[1].url).toContain("latitude=40.4");
    expect(weatherText(1234)).toBe("código 1234");
  });

  it("con coordenadas no busca el lugar; la herramienta solo existe con permiso", async () => {
    const calls = mockFetch(() => forecast);
    await forecastText("40.42,-3.70", 1);
    expect(calls).toHaveLength(1);
    const c = addConnection("clima", { lugar: "40.42,-3.70" });
    expect(toolNames(ana, "clima")).toEqual([]);
    setGrant(c.id, ana.id, "lectura");
    const r = await call(ana, "clima_prevision", { dias: 1 });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain("Tiempo en 40.42,-3.70");
  });
});

describe("Noticias (RSS)", () => {
  const rss = `<?xml version="1.0"?><rss><channel><title>Diario &amp; Co</title>
    <item><title><![CDATA[Primera <b>noticia</b>]]></title><link>https://d.es/1</link><pubDate>Mon, 05 Oct 2026 08:00:00 GMT</pubDate></item>
    <item><title>Segunda</title><link>https://d.es/2</link><pubDate>Sun, 04 Oct 2026 08:00:00 GMT</pubDate></item>
  </channel></rss>`;
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Blog</title>
    <entry><title>Entrada nueva</title><link href="https://b.es/x"/><updated>2026-10-05T10:00:00Z</updated></entry></feed>`;

  it("lee RSS y Atom", () => {
    const a = parseFeed(rss, "d.es");
    expect(a.title).toBe("Diario & Co");
    expect(a.items[0]).toEqual({ title: "Primera noticia", link: "https://d.es/1", date: "2026-10-05T08:00:00.000Z", source: "Diario & Co" });
    const b = parseFeed(atom, "b.es");
    expect(b.items[0]).toMatchObject({ title: "Entrada nueva", link: "https://b.es/x", source: "Blog" });
  });

  it("valida la lista de fuentes", () => {
    expect(parseFeedList("https://d.es/rss, https://d.es/rss\nhttps://b.es/atom")).toEqual(["https://d.es/rss", "https://b.es/atom"]);
    expect(() => parseFeedList("ftp://x.es/rss")).toThrow(/http/);
    expect(() => parseFeedList("")).toThrow(/al menos/);
    expect(() => parseFeedList(Array.from({ length: 16 }, (_, i) => `https://x.es/${i}`))).toThrow(/Demasiadas/);
  });

  it("titulares de todas las fuentes, del más reciente al más antiguo, y los fallos se avisan", async () => {
    mockFetch((url) => (url.includes("d.es") ? rss : url.includes("b.es") ? atom : new Response("no", { status: 500 })));
    const text = await headlines(["https://d.es/rss", "https://b.es/atom", "https://roto.es/rss"], { max: 2 });
    const lines = text.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toEqual(["- 2026-10-05 · Entrada nueva — Blog", "- 2026-10-05 · Primera noticia — Diario & Co"]);
    expect(text).toContain("No se pudo leer: roto.es");
    const soloBlog = await headlines(["https://d.es/rss", "https://b.es/atom"], { source: "b.es" });
    expect(soloBlog).not.toContain("Diario");
  });
});

describe("Telegram (avisos)", () => {
  function connect(): Connection {
    const c = addConnection("telegram", { chat_id: "987654321" });
    setConnectionSecret(c.id, BOT_TOKEN);
    return getConnection(c.id)!;
  }

  it("valida el chat_id y guarda el token cifrado", () => {
    expect(() => addConnection("telegram", { chat_id: "hola" })).toThrow(/chat_id/);
    const c = connect();
    const stored = (getDb().prepare("SELECT secret FROM connections WHERE id = ?").get(c.id) as { secret: string }).secret;
    expect(stored.startsWith("v1:")).toBe(true);
    expect(stored).not.toContain(BOT_TOKEN);
  });

  it("envía solo al chat configurado y respeta el máximo diario", async () => {
    const calls = mockFetch(() => ({ ok: true, result: {} }));
    const c = connect();
    const at = new Date("2026-10-05T10:00:00Z");
    expect(await sendNotice(c, "Hola", at)).toBe(1);
    expect(JSON.parse(String(calls[0].init!.body))).toEqual({ chat_id: "987654321", text: "Hola", disable_web_page_preview: true });
    for (let i = 2; i <= DAILY_LIMIT; i++) await sendNotice(c, `n${i}`, at);
    await expect(sendNotice(c, "uno más", at)).rejects.toThrow(/máximo diario/);
    expect(await sendNotice(c, "otro día", new Date("2026-10-06T10:00:00Z"))).toBe(1);
    await expect(sendNotice(c, "x".repeat(1001), at)).rejects.toThrow(/largo/);
  });

  it("solo con permiso completo hay herramienta; los errores no muestran el token", async () => {
    const c = connect();
    setGrant(c.id, ana.id, "lectura");
    expect(toolNames(ana, "aviso")).toEqual([]);
    expect(buildSystemPrompt(ana, createTask({ agentId: ana.id, kind: "chat", prompt: "x" }))).toContain("no permite enviar");
    setGrant(c.id, ana.id, "completo");
    mockFetch(() => new Response(JSON.stringify({ ok: false, description: `Unauthorized ${BOT_TOKEN}` }), { status: 401 }));
    const r = await call(ana, "aviso_telegram", { texto: "Prueba" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).not.toContain(BOT_TOKEN);
    const t = await getService("telegram").test(getConnection(c.id)!);
    expect(t.ok).toBe(false);
    expect(t.text).not.toContain(BOT_TOKEN);
  });
});

describe("Notion", () => {
  it("ids, títulos y bloques", () => {
    const id = "0123456789abcdef0123456789abcdef";
    expect(pageId(`https://www.notion.so/Mi-pagina-${id}?pvs=4`)).toBe("01234567-89ab-cdef-0123-456789abcdef");
    expect(() => pageId("nada")).toThrow(/no válido/);
    expect(titleOf({ object: "page", id: "p", properties: { Nombre: { type: "title", title: [{ plain_text: "Viajes" }] } } })).toBe("Viajes");
    const text = blocksToText([
      { id: "1", type: "heading_2", heading_2: { rich_text: [{ plain_text: "Lista" }] } },
      { id: "2", type: "to_do", to_do: { rich_text: [{ plain_text: "Pasaporte" }], checked: true } },
      { id: "3", type: "paragraph", paragraph: { rich_text: [{ plain_text: "Hola" }, { plain_text: " mundo" }] } },
    ]);
    expect(text).toBe("## Lista\n- [x] Pasaporte\nHola mundo");
    expect(textToBlocks("uno\n\ndos")).toHaveLength(2);
    expect(textToBlocks("x".repeat(4500))).toHaveLength(3);
    expect(() => textToBlocks("   ")).toThrow(/texto/);
  });

  it("lectura busca y lee; completo además añade; con su versión de API y sin filtrar el token", async () => {
    const c = addConnection("notion", { espacio: "Personal" });
    setConnectionSecret(c.id, NOTION_TOKEN);
    setGrant(c.id, ana.id, "lectura");
    expect(toolNames(ana, "notion")).toEqual(["notion_buscar", "notion_leer"]);
    const calls = mockFetch((url) =>
      url.endsWith("/search")
        ? { results: [{ object: "page", id: "abc", url: "https://notion.so/abc", properties: { t: { type: "title", title: [{ plain_text: "Viajes" }] } } }] }
        : { results: [] },
    );
    const r = await call(ana, "notion_buscar", { texto: "viajes" });
    expect(r.content[0].text).toContain("«Viajes» · página · id abc");
    const headers = calls[0].init!.headers as Record<string, string>;
    expect(headers["Notion-Version"]).toBe("2022-06-28");
    expect(headers.Authorization).toBe(`Bearer ${NOTION_TOKEN}`);
    expect(r.content[0].text).not.toContain(NOTION_TOKEN);

    setGrant(c.id, ana.id, "completo");
    expect(toolNames(ana, "notion")).toEqual(["notion_anadir", "notion_buscar", "notion_leer"]);
    const add = await call(ana, "notion_anadir", { pagina: "0123456789abcdef0123456789abcdef", texto: "Idea uno\n\nIdea dos" });
    expect(add.content[0].text).toContain("2 párrafos");
    const last = calls.at(-1)!;
    expect(last.init!.method).toBe("PATCH");
    expect(last.url).toContain("/blocks/01234567-89ab-cdef-0123-456789abcdef/children");
  });
});
