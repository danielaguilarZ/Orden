import { describe, expect, it } from "vitest";
import { mixHex, phaseAt, phaseProgress, skyAt, skyCssVars } from "@/living/sky";

/** Fecha local a una hora concreta (el cielo usa la hora local del navegador). */
const at = (h: number, m = 0) => new Date(2026, 9, 2, h, m);

describe("cielo del living", () => {
  it("elige la fase según la hora", () => {
    expect(phaseAt(5 * 60 + 59)).toBe("noche");
    expect(phaseAt(6 * 60)).toBe("amanecer");
    expect(phaseAt(9 * 60)).toBe("dia");
    expect(phaseAt(17 * 60 + 59)).toBe("dia");
    expect(phaseAt(18 * 60)).toBe("atardecer");
    expect(phaseAt(21 * 60)).toBe("noche");
    expect(phaseAt(0)).toBe("noche");
  });

  it("calcula el avance dentro de la fase, también cruzando medianoche", () => {
    expect(phaseProgress(6 * 60)).toBe(0);
    expect(phaseProgress(7 * 60 + 30)).toBeCloseTo(0.5);
    expect(phaseProgress(21 * 60)).toBe(0);
    expect(phaseProgress(1 * 60 + 30)).toBeCloseTo(0.5); // 21:00–06:00 → mitad a la 01:30
    expect(phaseProgress(5 * 60 + 59)).toBeGreaterThan(0.99);
  });

  it("la intensidad es máxima en el centro de la fase y baja en los bordes", () => {
    expect(skyAt(at(13, 30)).intensity).toBe(1);
    expect(skyAt(at(7, 30)).intensity).toBe(1);
    expect(skyAt(at(19, 30)).intensity).toBe(1);
    expect(skyAt(at(1, 30)).intensity).toBe(1);
    expect(skyAt(at(9, 0)).intensity).toBe(0);
    expect(skyAt(at(10, 0)).intensity).toBeLessThan(skyAt(at(12, 0)).intensity);
  });

  it("solo hay estrellas de noche y en las transiciones", () => {
    expect(skyAt(at(13)).stars).toBe(0);
    expect(skyAt(at(1, 30)).stars).toBe(1);
    expect(skyAt(at(6, 0)).stars).toBeGreaterThan(skyAt(at(8, 30)).stars);
  });

  it("el sol sube hasta el mediodía y la luna sale de noche", () => {
    const morning = skyAt(at(7));
    const noon = skyAt(at(13, 30));
    expect(noon.glowY).toBeLessThan(morning.glowY); // más arriba = menor «top»
    expect(skyAt(at(23)).glow).toBe("#dfe6ff");
  });

  it("interpola colores entre fotogramas clave", () => {
    expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mixHex("#102030", "#102030", 0.3)).toBe("#102030");
    expect(skyAt(at(0)).top).toBe("#070814");
    expect(skyAt(at(13, 30)).top).toBe("#4f9be6");
  });

  it("genera las variables CSS", () => {
    const vars = skyCssVars(skyAt(at(13, 30)));
    expect(vars["--sky-top"]).toBe("#4f9be6");
    expect(vars["--sky-glow-x"]).toMatch(/%$/);
    expect(Object.keys(vars)).toHaveLength(7);
  });
});
