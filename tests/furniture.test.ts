import { describe, expect, it } from "vitest";
import { decorate, DESK_SETS } from "@/living/decorator";
import { FURNITURE, resolveBoxes, TILE_UNITS } from "@/living/furniture";
import { findFloorFinish, findWallFinish } from "@/living/finishes";
import { ROOM_TEMPLATES } from "@/lib/roomTemplates";

const open = (n = 10) => new Array(n).fill(true);
const ctx = (seed = "s") => ({ w: 10, d: 10, northWall: open(), westWall: open(), seed });

const MODERNOS = [
  "escritorio_moderno",
  "silla_ergonomica",
  "sofa_modular",
  "mesa_centro",
  "monitor_doble",
  "portatil",
  "videowall",
  "pantalla_led",
  "panel_listones",
  "arte_abstracto",
  "neon",
  "planta_moderna",
  "lampara_arco",
  "estanteria_moderna",
  "alfombra_moderna",
];

describe("catálogo de muebles", () => {
  it("todos los colores se resuelven (ningún tinte sin definir)", () => {
    for (const kind of Object.keys(FURNITURE)) {
      for (const flip of [false, true]) {
        for (const b of resolveBoxes(kind, flip)) {
          expect(b.c, `${kind}: ${b.c}`).toMatch(/^#[0-9a-f]{3,6}$/i);
          expect(b.c.toLowerCase(), kind).not.toBe("#ff00ff");
          if (b.top) expect(b.top.toLowerCase(), kind).not.toBe("#ff00ff");
        }
      }
    }
  });

  it("los muebles modernos existen y no se salen de su huella", () => {
    for (const kind of MODERNOS) {
      const def = FURNITURE[kind];
      expect(def, kind).toBeDefined();
      for (const b of def.boxes) {
        expect(b.x, kind).toBeGreaterThanOrEqual(0);
        expect(b.y, kind).toBeGreaterThanOrEqual(0);
        expect(b.x + b.w, kind).toBeLessThanOrEqual(def.w * TILE_UNITS);
        expect(b.y + b.d, kind).toBeLessThanOrEqual(def.d * TILE_UNITS);
        expect(b.z + b.h, kind).toBeLessThanOrEqual(48);
      }
    }
  });

  it("«puesto_moderno» = silla ergonómica + escritorio moderno, con el monitor encima", () => {
    expect(DESK_SETS.puesto_moderno).toEqual(["silla_ergonomica", "escritorio_moderno"]);
    const { furniture, skipped } = decorate([], ["puesto_moderno", "monitor_doble", "portatil"], ctx());
    expect(skipped).toEqual([]);
    const desk = furniture.find((f) => f.kind === "escritorio_moderno")!;
    const chair = furniture.find((f) => f.kind === "silla_ergonomica")!;
    expect(chair.x).toBe(desk.x - 1);
    const tops = furniture.filter((f) => FURNITURE[f.kind].onTop);
    expect(tops).toHaveLength(2);
    for (const t of tops) expect(t.z).toBe(FURNITURE.escritorio_moderno.surface);
  });

  it("la oficina compartida es moderna y se amuebla entera", () => {
    const tpl = ROOM_TEMPLATES.oficina;
    expect(tpl.kinds).toContain("puesto_moderno");
    const { skipped } = decorate([], tpl.kinds!, ctx("oficina"));
    expect(skipped).toEqual([]);
  });
});

describe("acabados modernos", () => {
  it("se encuentran por id o nombre", () => {
    expect(findFloorFinish("microcemento")?.floor).toBe("hormigón");
    expect(findFloorFinish("roble nórdico")?.id).toBe("roble_nordico");
    expect(findFloorFinish("porcelanico negro")?.id).toBe("porcelanico_negro");
    expect(findWallFinish("grafito")?.id).toBe("grafito");
    expect(findWallFinish("Blanco puro")?.id).toBe("blanco_puro");
    expect(findWallFinish("verde bosque")?.id).toBe("verde_bosque");
  });
});
