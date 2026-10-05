import { describe, expect, it } from "vitest";
import { normalizeUsage } from "@/lib/claude/usage";
import { describeWindow, untilText } from "@/lib/claude/usageText";

describe("límites de Claude", () => {
  it("normaliza la respuesta del SDK y descarta lo que no reconoce", () => {
    const u = normalizeUsage({
      subscription_type: "pro",
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 23, resets_at: "2026-10-03T00:50:00Z" },
        seven_day: { utilization: 34, resets_at: "2026-10-05T00:00:00Z" },
        seven_day_opus: null,
        iguana_necktie: { utilization: 0, resets_at: "2026-11-05T00:00:00Z" },
      },
    });
    expect(u.available).toBe(true);
    expect(u.plan).toBe("pro");
    expect(u.windows.map((w) => [w.key, w.percent])).toEqual([
      ["five_hour", 23],
      ["seven_day", 34],
    ]);
  });

  it("sin límites de plan (API key) no está disponible", () => {
    expect(normalizeUsage({ subscription_type: null, rate_limits_available: false, rate_limits: null }).available).toBe(false);
  });

  it("cuenta atrás legible", () => {
    const now = new Date("2026-10-02T20:00:00Z");
    expect(untilText("2026-10-02T20:45:00Z", now)).toBe("en 45 min");
    expect(untilText("2026-10-03T00:50:00Z", now)).toBe("en 4 h 50 min");
    expect(untilText("2026-10-05T00:00:00Z", now)).toBe("en 2 d 4 h");
    expect(untilText("2026-10-01T00:00:00Z", now)).toBe("ya");
    expect(describeWindow({ key: "five_hour", label: "Sesión", percent: 29.4, resetsAt: "2026-10-02T21:00:00Z" }, now)).toBe(
      "29 % · se reinicia en 1 h",
    );
  });
});
