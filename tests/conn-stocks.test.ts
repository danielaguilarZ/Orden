import { describe, expect, it } from "vitest";
import { addConnection } from "@/lib/connections";
import { quoteLine } from "@/lib/connections/stocks";
import { callTool, connect, mockFetch, team, textOf, toolNames, useConnTestEnv } from "./helpers/conn";

useConnTestEnv();

const chart = (symbol: string, price: number, prev: number) => ({
  chart: { result: [{ meta: { symbol, currency: "EUR", regularMarketPrice: price, chartPreviousClose: prev, regularMarketTime: 1791216000, shortName: symbol === "SAN.MC" ? "Banco Santander" : undefined } }], error: null },
});

describe("Bolsa (Yahoo Finance)", () => {
  it("valida símbolos", () => {
    expect(() => addConnection("bolsa", { simbolos: "SAN.MC, ../x" })).toThrow(/no válido/);
    expect(addConnection("bolsa", { simbolos: "san.mc, ^ibex" }).config).toEqual({ simbolos: ["SAN.MC", "^IBEX"] });
  });

  it("formatea la cotización con variación", () => {
    expect(quoteLine(chart("SAN.MC", 5.5, 5).chart.result[0].meta)).toBe("- SAN.MC (Banco Santander): 5,5 EUR · +10.00 % vs. cierre anterior · 2026-10-05 16:00 UTC");
  });

  it("varios símbolos; los que fallan se avisan sin parar el resto", async () => {
    connect("bolsa", { simbolos: "SAN.MC, NOEXISTE" }, undefined, { agent: team.ana, level: "lectura" });
    expect(toolNames(team.ana, "bolsa")).toEqual(["bolsa_buscar", "bolsa_cotizacion"]);
    const calls = mockFetch((url) => (url.includes("SAN.MC") ? chart("SAN.MC", 5.5, 5) : new Response(JSON.stringify({ chart: { result: null, error: { description: "No data found" } } }), { status: 404 })));
    const r = textOf(await callTool(team.ana, "bolsa_cotizacion"));
    expect(r).toContain("- SAN.MC (Banco Santander): 5,5 EUR");
    expect(r).toContain("- NOEXISTE:");
    expect(calls[0].url).toBe("https://query1.finance.yahoo.com/v8/finance/chart/SAN.MC?range=5d&interval=1d");
    mockFetch(() => ({ quotes: [{ symbol: "ITX.MC", longname: "Industria de Diseño Textil", exchDisp: "Madrid", quoteType: "EQUITY" }] }));
    expect(textOf(await callTool(team.ana, "bolsa_buscar", { texto: "inditex" }))).toBe("- ITX.MC · Industria de Diseño Textil · Madrid · EQUITY");
  });
});
