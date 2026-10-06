import { describe, expect, it } from "vitest";
import { addConnection } from "@/lib/connections";
import { getService } from "@/lib/connections/registry";
import { callTool, connect, mockFetch, team, textOf, useConnTestEnv } from "./helpers/conn";

useConnTestEnv();

describe("Divisas (BCE)", () => {
  it("valida códigos", () => {
    expect(() => addConnection("divisas", { base: "EURO" })).toThrow(/3 letras/);
    expect(addConnection("divisas", { destino: "usd, chf" }).config).toEqual({ base: "EUR", destino: ["USD", "CHF"] });
  });

  it("convierte importes y consulta fechas pasadas", async () => {
    connect("divisas", {}, undefined, { agent: team.ana, level: "lectura" });
    const calls = mockFetch(() => ({ amount: 250, base: "EUR", date: "2026-10-02", rates: { USD: 271.9 } }));
    const r = textOf(await callTool(team.ana, "divisas_cambio", { a: ["usd"], cantidad: 250, fecha: "2026-10-02" }));
    expect(r).toBe("Cambio oficial del BCE del 2026-10-02:\n- 250 EUR = 271,9 USD");
    expect(calls[0].url).toBe("https://api.frankfurter.dev/v1/2026-10-02?base=EUR&amount=250&symbols=USD");
    expect((await callTool(team.ana, "divisas_cambio", { fecha: "ayer" })).isError).toBe(true);
  });

  it("prueba con las divisas por defecto", async () => {
    const c = connect("divisas", {}, undefined);
    mockFetch(() => ({ amount: 1, base: "EUR", date: "2026-10-05", rates: { USD: 1.08, GBP: 0.84 } }));
    expect((await getService("divisas").test(c)).text).toContain("- 1 EUR = 0,84 GBP");
  });
});
