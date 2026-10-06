import { describe, expect, it } from "vitest";
import { getService } from "@/lib/connections/registry";
import { durationMs, expandDays, icsUrl, occurrences, parseIcs } from "@/lib/connections/ics";
import { callTool, connect, mockFetch, team, textOf, toolNames, useConnTestEnv } from "./helpers/conn";

const URL_ICS = "https://outlook.office365.com/owa/calendar/abc/SECRETO123456/calendar.ics";
useConnTestEnv();

const ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Madrid",
  "BEGIN:STANDARD",
  "DTSTART:19701025T030000",
  "END:STANDARD",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "UID:dentista-1",
  "SUMMARY:Dentista\\, revisión",
  "DTSTART;TZID=Europe/Madrid:20261007T100000",
  "DTEND;TZID=Europe/Madrid:20261007T110000",
  "LOCATION:Calle Mayor 1",
  "DESCRIPTION:Llevar\\ninforme",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:gym",
  "SUMMARY:Gimnasio",
  "DTSTART:20261005T170000Z",
  "DURATION:PT1H30M",
  "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4",
  "EXDATE:20261007T170000Z",
  "BEGIN:VALARM",
  "TRIGGER:-PT15M",
  "SUMMARY:No es un evento",
  "END:VALARM",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:gym",
  "RECURRENCE-ID:20261012T170000Z",
  "SUMMARY:Gimnasio (cambiado)",
  "DTSTART:20261012T180000Z",
  "DTEND:20261012T190000Z",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:viaje",
  "SUMMARY:Viaje a Lis",
  " boa",
  "DTSTART;VALUE=DATE:20261009",
  "DTEND;VALUE=DATE:20261012",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:cancelado",
  "SUMMARY:Cancelado",
  "STATUS:CANCELLED",
  "DTSTART:20261008T080000Z",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("formato iCal", () => {
  it("lee eventos, desdobla líneas, quita escapes e ignora alarmas", () => {
    const ev = parseIcs(ICS);
    expect(ev).toHaveLength(5);
    expect(ev[0]).toMatchObject({ uid: "dentista-1", summary: "Dentista, revisión", location: "Calle Mayor 1", description: "Llevar\ninforme" });
    expect(ev[3].summary).toBe("Viaje a Lisboa");
    expect(() => parseIcs("<html>")).toThrow(/iCal/);
    expect(durationMs("PT1H30M")).toBe(5_400_000);
    expect(durationMs("P1W")).toBe(7 * 86_400_000);
  });

  it("repeticiones: semanal con días, mensual por ordinal, anual y límites", () => {
    expect(expandDays("2026-10-05", "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4", "2027-01-01", () => true)).toEqual(["2026-10-05", "2026-10-07", "2026-10-12", "2026-10-14"]);
    expect(expandDays("2026-10-01", "FREQ=MONTHLY;BYDAY=-1FR", "2026-12-31", () => true)).toEqual(["2026-10-30", "2026-11-27", "2026-12-25"]);
    expect(expandDays("2026-01-31", "FREQ=MONTHLY", "2026-05-31", () => true)).toEqual(["2026-01-31", "2026-03-31", "2026-05-31"]);
    expect(expandDays("2024-02-29", "FREQ=YEARLY", "2029-01-01", () => true)).toEqual(["2024-02-29", "2028-02-29"]);
    expect(expandDays("2026-10-01", "FREQ=DAILY;INTERVAL=2", "2026-10-07", () => true)).toEqual(["2026-10-01", "2026-10-03", "2026-10-05", "2026-10-07"]);
    expect(expandDays("2026-10-01", "FREQ=DAILY", "2026-12-01", (d) => d <= "2026-10-03")).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
  });

  it("ocurrencias en hora de Madrid: zonas, EXDATE, RECURRENCE-ID, todo el día y cancelados", () => {
    const list = occurrences(parseIcs(ICS), "2026-10-05", "2026-10-20", "Europe/Madrid");
    expect(list.map((o) => `${o.start}|${o.end ?? ""}|${o.title}`)).toEqual([
      "2026-10-05T19:00|2026-10-05T20:30|Gimnasio",
      "2026-10-07T10:00|2026-10-07T11:00|Dentista, revisión",
      "2026-10-09|2026-10-11|Viaje a Lisboa",
      "2026-10-12T20:00|2026-10-12T21:00|Gimnasio (cambiado)",
      "2026-10-14T19:00|2026-10-14T20:30|Gimnasio",
    ]);
  });

  it("webcal y solo http(s)", () => {
    expect(icsUrl("webcal://p01.icloud.com/x.ics")).toBe("https://p01.icloud.com/x.ics");
    expect(() => icsUrl("file:///c:/x.ics")).toThrow(/http/);
  });
});

describe("conexión iCal", () => {
  it("herramienta de lectura con rango y texto; la dirección no sale en errores", async () => {
    connect("ics", { nombre: "Trabajo" }, URL_ICS, { agent: team.ana, level: "lectura" });
    expect(toolNames(team.ana, "ics")).toEqual(["ics_eventos"]);
    mockFetch(() => ICS);
    const r = textOf(await callTool(team.ana, "ics_eventos", { desde: "2026-10-05", hasta: "2026-10-08", texto: "dentista" }));
    expect(r).toBe("1 evento(s) en «Trabajo» del 2026-10-05 al 2026-10-08:\n- 2026-10-07 10:00 → 2026-10-07 11:00 · Dentista, revisión · Calle Mayor 1");
    expect((await callTool(team.ana, "ics_eventos", { desde: "2026-01-01", hasta: "2026-12-31" })).isError).toBe(true);
    mockFetch(() => new Response(`not found ${URL_ICS}`, { status: 404 }));
    const bad = await callTool(team.ana, "ics_eventos", { desde: "2026-10-05", hasta: "2026-10-06" });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).not.toContain("SECRETO123456");
  });

  it("no vuelca a ningún panel: solo se consulta y la configuración ya no lleva «panel»", () => {
    const s = getService("ics");
    expect("sync" in s).toBe(false);
    expect(s.normalizeConfig({ nombre: "Trabajo", panel: true })).toEqual({ nombre: "Trabajo" });
  });

  it("prueba la conexión", async () => {
    const c = connect("ics", { nombre: "Trabajo" }, URL_ICS);
    mockFetch(() => ICS);
    expect((await getService("ics").test(c)).text).toContain("Calendario leído: 5 evento(s) en el archivo");
  });
});
