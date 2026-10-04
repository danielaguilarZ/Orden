/**
 * Avatares pixel art generados por código a partir de la apariencia del
 * agente. Dibujos originales: cabeza grande, cuerpo pequeño, vista 3/4.
 *
 * Se dibuja mirando a la derecha; el render espeja para mirar a la izquierda.
 */

import type { Appearance } from "../lib/types";
import { addOutline, hexToRgb, shade, type PixelImage, type RGB } from "./raster";

export const AVATAR_W = 26;
export const AVATAR_H = 46;
/** Punto de apoyo (pies) dentro del lienzo. */
export const FOOT_X = 13;
export const FOOT_Y = 43;
/** Punto de apoyo al estar sentado (cadera). */
export const SEAT_Y = 34;

export type Pose = "stand" | "walk1" | "walk2" | "sit" | "sleep" | "wave";
export type View = "front" | "back";

class Canvas {
  data = new Uint8ClampedArray(AVATAR_W * AVATAR_H * 4);
  set(x: number, y: number, c: RGB) {
    if (x < 0 || y < 0 || x >= AVATAR_W || y >= AVATAR_H) return;
    const i = (y * AVATAR_W + x) * 4;
    this.data[i] = c[0];
    this.data[i + 1] = c[1];
    this.data[i + 2] = c[2];
    this.data[i + 3] = 255;
  }
  rect(x: number, y: number, w: number, h: number, c: RGB) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, c);
  }
  clear(x: number, y: number) {
    if (x < 0 || y < 0 || x >= AVATAR_W || y >= AVATAR_H) return;
    this.data[(y * AVATAR_W + x) * 4 + 3] = 0;
  }
}

interface Palette {
  skin: RGB;
  skinD: RGB;
  hair: RGB;
  hairD: RGB;
  hairL: RGB;
  shirt: RGB;
  shirtD: RGB;
  shirtL: RGB;
  pants: RGB;
  pantsD: RGB;
  shoes: RGB;
  eye: RGB;
  white: RGB;
}

function palette(a: Appearance): Palette {
  const skin = hexToRgb(a.skin);
  const hair = hexToRgb(a.hair);
  const shirt = hexToRgb(a.shirt);
  const pants = hexToRgb(a.pants);
  return {
    skin,
    skinD: shade(skin, 0.82),
    hair,
    hairD: shade(hair, 0.75),
    hairL: shade(hair, 1.25),
    shirt,
    shirtD: shade(shirt, 0.8),
    shirtL: shade(shirt, 1.15),
    pants,
    pantsD: shade(pants, 0.78),
    shoes: hexToRgb(a.shoes),
    eye: [27, 27, 34],
    white: [250, 250, 250],
  };
}

// Desplazamiento vertical de la parte superior cuando está sentado.
const SIT_DY = 0;

function head(c: Canvas, p: Palette, view: View, dy: number) {
  const top = 7 + dy;
  // Cabeza 12×13 con esquinas redondeadas
  c.rect(7, top, 12, 13, p.skin);
  c.clear(7, top);
  c.clear(18, top);
  c.clear(7, top + 12);
  c.clear(18, top + 12);
  // Sombra de la mandíbula
  c.rect(8, top + 12, 10, 1, p.skinD);
  if (view === "front") {
    c.rect(9, top + 6, 1, 3, p.skinD); // oreja
  } else {
    c.rect(16, top + 6, 1, 3, p.skinD);
  }
  // Cuello
  c.rect(12, top + 13, 3, 1, p.skinD);
}

function face(c: Canvas, p: Palette, dy: number, closed: boolean) {
  const top = 7 + dy;
  if (closed) {
    c.rect(12, top + 7, 2, 1, p.eye);
    c.rect(16, top + 7, 2, 1, p.eye);
  } else {
    c.rect(13, top + 6, 1, 2, p.eye);
    c.rect(16, top + 6, 1, 2, p.eye);
    c.set(13, top + 6, [70, 70, 90]);
  }
  c.rect(14, top + 10, 2, 1, p.skinD); // boca
  c.set(17, top + 9, shade(p.skin, 0.93)); // mejilla
}

function hairFront(c: Canvas, p: Palette, a: Appearance, dy: number) {
  const top = 7 + dy;
  const style = a.hairStyle;
  if (style === "rapado") {
    c.rect(8, top - 1, 10, 2, p.hair);
    c.rect(7, top + 1, 3, 4, p.hair);
    return;
  }
  const big = style === "rizado";
  const x0 = big ? 6 : 7;
  const x1 = big ? 20 : 19;
  // Casquete
  c.rect(x0, top - 2, x1 - x0, 5, p.hair);
  c.clear(x0, top - 2);
  c.clear(x1 - 1, top - 2);
  c.rect(x0 + 2, top - 2, x1 - x0 - 5, 1, p.hairL);
  // Flequillo hacia la frente (mira a la derecha)
  c.rect(11, top + 3, 7, 1, p.hair);
  c.set(17, top + 3, p.hairD);
  c.set(12, top + 4, p.hair);
  // Lateral y nuca (lado izquierdo = parte de atrás)
  c.rect(x0, top + 3, 3, 6, p.hair);
  c.rect(x0, top + 8, 2, 2, p.hairD);
  if (big) {
    for (let x = x0; x < x1; x += 2) c.set(x, top - 3, p.hair);
    c.rect(x0 - 1, top + 2, 1, 7, p.hair);
    c.rect(x1, top + 1, 1, 4, p.hair);
  }
  if (style === "largo") {
    c.rect(6, top + 3, 4, 15, p.hair);
    c.rect(6, top + 15, 3, 3, p.hairD);
  }
  if (style === "moño") {
    c.rect(10, top - 6, 5, 4, p.hair);
    c.clear(10, top - 6);
    c.clear(14, top - 6);
    c.rect(11, top - 6, 2, 1, p.hairL);
    c.rect(10, top - 2, 5, 1, p.hairD);
  }
  if (style === "coleta") {
    c.rect(4, top + 3, 3, 9, p.hair);
    c.rect(5, top + 11, 2, 2, p.hairD);
    c.rect(6, top + 3, 1, 1, [200, 60, 60]);
  }
}

function hairBack(c: Canvas, p: Palette, a: Appearance, dy: number) {
  const top = 7 + dy;
  const style = a.hairStyle;
  if (style === "rapado") {
    c.rect(7, top - 1, 12, 8, p.hairD);
    c.clear(7, top - 1);
    c.clear(18, top - 1);
    return;
  }
  const big = style === "rizado";
  const x0 = big ? 6 : 7;
  const x1 = big ? 20 : 19;
  c.rect(x0, top - 2, x1 - x0, 12, p.hair);
  c.clear(x0, top - 2);
  c.clear(x1 - 1, top - 2);
  c.rect(x0 + 2, top - 2, x1 - x0 - 5, 1, p.hairL);
  if (style !== "largo") c.rect(x0 + 1, top + 8, x1 - x0 - 2, 2, p.hairD);
  if (big) for (let x = x0; x < x1; x += 2) c.set(x, top - 3, p.hair);
  if (style === "largo") c.rect(7, top + 10, 12, 8, p.hair);
  if (style === "moño") {
    c.rect(10, top - 6, 6, 5, p.hair);
    c.clear(10, top - 6);
    c.clear(15, top - 6);
  }
  if (style === "coleta") {
    c.rect(11, top + 9, 4, 9, p.hair);
    c.rect(12, top + 16, 2, 2, p.hairD);
    c.rect(11, top + 8, 4, 1, [200, 60, 60]);
  }
}

function accessoryFront(c: Canvas, p: Palette, a: Appearance, dy: number) {
  const top = 7 + dy;
  const dark: RGB = [40, 40, 48];
  switch (a.accessory) {
    case "gafas":
      c.rect(11, top + 5, 8, 1, dark);
      c.rect(12, top + 8, 3, 1, dark);
      c.rect(15, top + 8, 3, 1, dark);
      c.set(12, top + 6, dark);
      c.set(12, top + 7, dark);
      c.set(18, top + 6, dark);
      c.set(18, top + 7, dark);
      break;
    case "barba":
      c.rect(10, top + 9, 9, 4, p.hair);
      c.rect(10, top + 7, 1, 2, p.hair);
      c.rect(14, top + 10, 2, 1, p.hairD);
      c.clear(18, top + 12);
      c.rect(11, top + 13, 6, 1, p.hairD);
      break;
    case "auriculares":
      c.rect(9, top - 3, 8, 1, dark);
      c.rect(8, top + 4, 3, 5, [192, 57, 43]);
      c.rect(9, top - 2, 1, 6, dark);
      break;
    case "gorro":
      c.rect(7, top - 4, 12, 6, [211, 84, 0]);
      c.rect(7, top + 1, 14, 1, shade([211, 84, 0], 0.8));
      c.rect(9, top - 4, 7, 1, shade([211, 84, 0], 1.2));
      c.clear(7, top - 4);
      c.clear(18, top - 4);
      break;
    case "pajarita":
      c.rect(11, top + 14, 5, 2, [192, 57, 43]);
      c.set(13, top + 14, [140, 30, 30]);
      c.set(13, top + 15, [140, 30, 30]);
      break;
  }
}

function accessoryBack(c: Canvas, p: Palette, a: Appearance, dy: number) {
  const top = 7 + dy;
  if (a.accessory === "auriculares") {
    c.rect(8, top - 3, 10, 1, [40, 40, 48]);
    c.rect(16, top + 4, 3, 5, [192, 57, 43]);
  }
  if (a.accessory === "gorro") {
    c.rect(7, top - 4, 12, 7, [211, 84, 0]);
    c.clear(7, top - 4);
    c.clear(18, top - 4);
  }
}

function torso(c: Canvas, p: Palette, view: View, dy: number, armSwing: number, wave: boolean) {
  const top = 21 + dy;
  c.rect(8, top, 11, 10, p.shirt);
  c.rect(8, top, 2, 10, p.shirtD);
  c.rect(17, top + 1, 1, 8, p.shirtL);
  if (view === "front") {
    c.rect(13, top, 2, 2, p.skin); // escote
    c.set(13, top + 2, p.skinD);
  }
  c.rect(8, top + 9, 11, 1, p.shirtD);
  // Brazo trasero
  c.rect(6, top + 1 - armSwing, 2, 8, p.shirtD);
  c.rect(6, top + 9 - armSwing, 2, 2, p.skinD);
  // Brazo delantero
  if (wave) {
    c.rect(19, top - 5, 2, 7, p.shirt);
    c.rect(19, top - 7, 2, 2, p.skin);
    c.rect(19, top + 2, 1, 1, p.shirtD);
  } else {
    c.rect(19, top + 1 + armSwing, 2, 8, p.shirt);
    c.rect(19, top + 9 + armSwing, 2, 2, p.skin);
  }
}

function legsStand(c: Canvas, p: Palette, stride: number) {
  // Cadera
  c.rect(9, 31, 9, 2, p.pants);
  // Pierna trasera / delantera con zancada
  const back = 9 - stride;
  const front = 13 + stride;
  c.rect(back, 33, 3, 8, p.pantsD);
  c.rect(front, 33, 3, 8, p.pants);
  c.rect(back - 1, 41, 4, 2, shade(p.shoes, 0.85));
  c.rect(front, 41, 5, 2, p.shoes);
  c.set(front + 4, 41, shade(p.shoes, 1.3));
}

function legsSit(c: Canvas, p: Palette) {
  c.rect(9, 31, 10, 3, p.pants);
  c.rect(18, 31, 3, 3, p.pants);
  c.rect(10, 33, 8, 1, p.pantsD);
  c.rect(18, 34, 3, 5, p.pantsD);
  c.rect(18, 39, 5, 2, p.shoes);
}

export function drawAvatar(a: Appearance, pose: Pose, view: View): PixelImage {
  const c = new Canvas();
  const p = palette(a);
  const sitting = pose === "sit" || pose === "sleep";
  const stride = pose === "walk1" ? 1 : pose === "walk2" ? -1 : 0;
  const bob = stride !== 0 ? 1 : 0;
  const dy = (sitting ? SIT_DY : 0) + bob;

  if (sitting) legsSit(c, p);
  else legsStand(c, p, stride);
  torso(c, p, view, dy, stride, pose === "wave");
  head(c, p, view, dy);
  if (view === "front") {
    face(c, p, dy, pose === "sleep");
    hairFront(c, p, a, dy);
    accessoryFront(c, p, a, dy);
  } else {
    hairBack(c, p, a, dy);
    accessoryBack(c, p, a, dy);
  }
  const img: PixelImage = { width: AVATAR_W, height: AVATAR_H, data: c.data, ox: 0, oy: 0 };
  addOutline(img, 0.35);
  return img;
}

export const POSES: Pose[] = ["stand", "walk1", "walk2", "sit", "sleep", "wave"];

export function appearanceKey(a: Appearance): string {
  return [a.skin, a.hair, a.hairStyle, a.shirt, a.pants, a.shoes, a.accessory].join("|");
}
