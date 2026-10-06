import { describe, expect, it } from "vitest";
import { addConnection } from "@/lib/connections";
import { getService } from "@/lib/connections/registry";
import { callTool, connect, headersOf, mockFetch, team, textOf, toolNames, useConnTestEnv } from "./helpers/conn";

useConnTestEnv();

function gecko(url: string) {
  const u = new URL(url);
  if (u.pathname.endsWith("/search")) {
    const q = u.searchParams.get("query");
    if (q === "eth") return { coins: [{ id: "ethereum-wormhole", symbol: "ETH", name: "Wormhole ETH", market_cap_rank: 900 }, { id: "ethereum", symbol: "ETH", name: "Ethereum", market_cap_rank: 2 }] };
    return { coins: [] };
  }
  return { bitcoin: { eur: 61234.5, eur_24h_change: -1.234 }, ethereum: { eur: 2345.678, eur_24h_change: 2 } };
}

describe("Criptomonedas (CoinGecko)", () => {
  it("valida la configuración", () => {
    expect(() => addConnection("cripto", { divisa: "euros!" })).toThrow(/Divisa/);
    expect(addConnection("cripto", {}).config).toEqual({ monedas: ["bitcoin", "ethereum"], divisa: "eur" });
  });

  it("precios por id o símbolo (el de mayor capitalización), sin clave", async () => {
    connect("cripto", { monedas: "bitcoin" }, undefined, { agent: team.ana, level: "lectura" });
    expect(toolNames(team.ana, "cripto")).toEqual(["cripto_buscar", "cripto_precios"]);
    const calls = mockFetch(gecko);
    const r = textOf(await callTool(team.ana, "cripto_precios", { monedas: ["bitcoin", "eth"] }));
    expect(r).toContain("- bitcoin: 61.234,5 EUR (-1.23 % en 24 h)");
    // En español, los números de 4 cifras van sin separador de miles.
    expect(r).toContain("- ethereum: 2345,68 EUR (+2.00 % en 24 h)");
    const priceCall = calls.find((c) => c.url.includes("/simple/price"))!;
    expect(new URL(priceCall.url).searchParams.get("ids")).toBe("bitcoin,ethereum");
    expect(headersOf(priceCall).get("x-cg-demo-api-key")).toBeNull();
  });

  it("con clave demo la manda en la cabecera; la prueba usa las monedas por defecto", async () => {
    const c = connect("cripto", {}, "CG-abcdefghijklmnopqrstuvw");
    const calls = mockFetch(gecko);
    expect((await getService("cripto").test(c)).text).toContain("Precios (CoinGecko, EUR)");
    expect(headersOf(calls[0]).get("x-cg-demo-api-key")).toBe("CG-abcdefghijklmnopqrstuvw");
  });
});
