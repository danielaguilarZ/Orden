/**
 * Genera un PNG del living sin navegador (útil para revisar sprites).
 * Uso: npx tsx scripts/preview-living.ts salida.png
 *      npx tsx scripts/preview-living.ts salida.png --edificios   (casa de Orden + un segundo edificio y pasarela)
 */
import fs from "node:fs";
import { encodePng } from "./png";
import { applyTemplateTints, ROOM_TEMPLATES } from "../src/lib/roomTemplates";
import type { Room } from "../src/lib/types";
import { renderBackground, dividerPieces, exteriorPieces, outerWallSides } from "../src/living/houseRender";
import { decorate } from "../src/living/decorator";
import { nextRoomPosition, slotOrder } from "../src/living/house";
import { rasterizeBoxes, type PixelImage, project } from "../src/living/raster";
import { FURNITURE, footprint, resolveBoxes } from "../src/living/furniture";
import { drawAvatar, FOOT_X, FOOT_Y, POSES } from "../src/living/avatar";

const S = 10;
const BUILDINGS = process.argv.includes("--edificios");
const rooms: Room[] = [];
const mk = (k: string, x: number, y: number, building?: string): Room => {
  const t = ROOM_TEMPLATES[k];
  return { id: `${k}-${rooms.length}`, name: t.label, kind: t.kind, agentId: null, building, x, y, w: S, d: S, style: t.style, furniture: [], createdAt: "", updatedAt: "" };
};
if (BUILDINGS) {
  // Casa: despacho, salón y dos estudios; al lado, un segundo edificio de ejemplo.
  for (const [k, x, y] of [["despacho_zen", 0, 0], ["salon", S, 0], ["estudio", 0, S], ["estudio", S, S]] as const) rooms.push(mk(k, x, y));
  for (const k of ["oficina", "proyectos"]) {
    const p = nextRoomPosition(rooms, "anexo");
    rooms.push(mk(k, p.x, p.y, "anexo"));
  }
} else {
  // Todas las plantillas: las fijas tal cual y las demás con el decorador automático.
  const keys = Object.keys(ROOM_TEMPLATES);
  const slots = slotOrder(keys.length);
  keys.forEach((k, i) => rooms.push(mk(k, slots[i].x * S, slots[i].y * S, ROOM_TEMPLATES[k].building)));
}
for (const room of rooms) {
  const t = ROOM_TEMPLATES[room.kind];
  if (t.kinds && !(BUILDINGS && t.furniture)) {
    const sides = outerWallSides(room, rooms);
    const r = decorate([], t.kinds, { w: S, d: S, northWall: sides.north, westWall: sides.west, seed: room.id });
    room.furniture = applyTemplateTints(r.furniture, t);
    if (r.skipped.length) console.log(room.kind, "sin sitio para:", r.skipped.join(", "));
  } else room.furniture = applyTemplateTints((t.furniture ?? []).map((f, j) => ({ ...f, id: `${room.id}-${j}` })), t);
}
const AVATARS = process.argv.includes("--avatares");

const bg = renderBackground(rooms);
const pad = 40;
const W = bg.width + pad * 2;
const H = bg.height + pad * 2;
const out = new Uint8ClampedArray(W * H * 4);
for (let i = 0; i < W * H; i++) { out[i * 4] = 29; out[i * 4 + 1] = 27; out[i * 4 + 2] = 42; out[i * 4 + 3] = 255; }
const originX = -bg.ox + pad;
const originY = -bg.oy + pad;
function blit(img: PixelImage, sx: number, sy: number, mirror = false, alpha = 1) {
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      const si = (y * img.width + (mirror ? img.width - 1 - x : x)) * 4;
      if (img.data[si + 3] === 0) continue;
      const dx = Math.round(sx + x + originX);
      const dy = Math.round(sy + y + originY);
      if (dx < 0 || dy < 0 || dx >= W || dy >= H) continue;
      const di = (dy * W + dx) * 4;
      if (alpha >= 1) out.set(img.data.subarray(si, si + 4), di);
      else for (let k = 0; k < 3; k++) out[di + k] = Math.round(out[di + k] * (1 - alpha) + img.data[si + k] * alpha);
    }
}
blit(bg, bg.ox, bg.oy);

type Item = { depth: number; draw: () => void };
const items: Item[] = [];
for (const d of dividerPieces(rooms)) {
  const img = rasterizeBoxes([d.box]);
  items.push({ depth: d.depth, draw: () => blit(img, img.ox, img.oy) });
}
for (const piece of exteriorPieces(rooms)) {
  const img = rasterizeBoxes(piece.boxes, { outline: piece.outline ?? true });
  items.push({ depth: piece.depth, draw: () => blit(img, img.ox, img.oy, false, piece.alpha ?? 1) });
}
for (const r of rooms) for (const f of r.furniture) {
  const def = FURNITURE[f.kind];
  if (def.wall) {
    const sides = outerWallSides(r, rooms);
    if (!(f.flip ? sides.west[f.y] : sides.north[f.x])) continue;
  }
  const img = rasterizeBoxes(resolveBoxes(f.kind, f.flip, f.tint));
  const fp = footprint(f.kind, f.flip);
  const X = (r.x + f.x) * 16, Y = (r.y + f.y) * 16;
  const p = project(X, Y, f.z ?? 0);
  const depth = def.wall ? -100 : r.x + f.x + fp.w / 2 + r.y + f.y + fp.d / 2 + (def.onTop ? 2 : 0) + (def.walkable ? -50 : 0);
  items.push({ depth, draw: () => blit(img, p.sx + img.ox, p.sy + img.oy) });
}
const looks = [
  { skin: "#e0ac69", hair: "#2b2b2b", hairStyle: "moño", shirt: "#e9e4d4", pants: "#3a4a5a", shoes: "#2a2a2a", accessory: "barba" },
  { skin: "#f1c27d", hair: "#a0522d", hairStyle: "largo", shirt: "#c0392b", pants: "#2f3640", shoes: "#1e1e1e", accessory: "gafas" },
  { skin: "#8d5524", hair: "#111111", hairStyle: "rizado", shirt: "#27ae60", pants: "#34495e", shoes: "#ffffff", accessory: "auriculares" },
  { skin: "#ffdbac", hair: "#e6c35c", hairStyle: "coleta", shirt: "#8e44ad", pants: "#2c3e50", shoes: "#7f4f24", accessory: "pajarita" },
] as const;
if (AVATARS) looks.forEach((a, k) => {
  POSES.forEach((pose, i) => {
    for (const view of ["front", "back"] as const) {
      const img = drawAvatar(a as any, pose, view);
      const tx = 12 + i * 1.2 + (view === "back" ? 0.6 : 0), ty = 1.5 + k * 2.2;
      const p = project(tx * 16, ty * 16, 0);
      items.push({ depth: tx + ty + 0.6, draw: () => blit(img, p.sx - FOOT_X, p.sy - FOOT_Y, k % 2 === 1) });
    }
  });
});
items.sort((a, b) => a.depth - b.depth).forEach((i) => i.draw());

// Escalado ×2
const Z = 2;
const big = new Uint8ClampedArray(W * Z * H * Z * 4);
for (let y = 0; y < H * Z; y++) for (let x = 0; x < W * Z; x++) {
  const si = (Math.floor(y / Z) * W + Math.floor(x / Z)) * 4;
  big.set(out.subarray(si, si + 4), (y * W * Z + x) * 4);
}
fs.writeFileSync(process.argv[2] ?? "preview.png", encodePng(W * Z, H * Z, big));
console.log("ok", W * Z, H * Z);
