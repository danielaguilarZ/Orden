/**
 * Rasterizador isométrico de pixel art.
 *
 * Proyección 2:1 (1 baldosa = 16 unidades = 32×16 px):
 *   sx = X − Y,  sy = (X + Y) / 2 − Z
 * Cada píxel se muestrea en su centro, se invierte la proyección sobre las
 * tres caras visibles de cada caja (arriba, +x, +y) y un z-buffer
 * (profundidad = X + Y + Z) decide qué se ve. Después se añade un contorno
 * oscuro de 1 px, al estilo de los juegos isométricos clásicos.
 */

import type { Box } from "./furniture";

export type RGB = [number, number, number];

export interface RasterBox extends Box {
  /** Patrón de la cara superior (suelos). Devuelve el color en (X, Y). */
  topFn?: (X: number, Y: number) => RGB;
}

export interface PixelImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  /** Posición de la esquina superior izquierda en coordenadas de pantalla (sx, sy). */
  ox: number;
  oy: number;
}

export function hexToRgb(hex: string): RGB {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function shade([r, g, b]: RGB, f: number): RGB {
  if (f >= 1) {
    const t = f - 1;
    return [r + (255 - r) * t, g + (255 - g) * t, b + (255 - b) * t].map(Math.round) as RGB;
  }
  return [r * f, g * f, b * f].map(Math.round) as RGB;
}

export function rgbToHex([r, g, b]: RGB): string {
  return "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("");
}

const TOP = 1.1;
const LEFT = 0.88; // cara +y (se ve a la izquierda)
const RIGHT = 0.7; // cara +x (se ve a la derecha)

export function project(X: number, Y: number, Z: number): { sx: number; sy: number } {
  return { sx: X - Y, sy: (X + Y) / 2 - Z };
}

export interface RasterOptions {
  outline?: boolean;
  /** Factor de oscurecimiento del contorno. */
  outlineShade?: number;
}

export function rasterizeBoxes(boxes: RasterBox[], opts: RasterOptions = {}): PixelImage {
  const outline = opts.outline ?? true;
  const pad = outline ? 1 : 0;
  let minSx = Infinity,
    minSy = Infinity,
    maxSx = -Infinity,
    maxSy = -Infinity;
  const bounds = boxes.map((b) => {
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const X of [b.x, b.x + b.w])
      for (const Y of [b.y, b.y + b.d])
        for (const Z of [b.z, b.z + b.h]) {
          const p = project(X, Y, Z);
          x0 = Math.min(x0, p.sx);
          x1 = Math.max(x1, p.sx);
          y0 = Math.min(y0, p.sy);
          y1 = Math.max(y1, p.sy);
        }
    minSx = Math.min(minSx, x0);
    maxSx = Math.max(maxSx, x1);
    minSy = Math.min(minSy, y0);
    maxSy = Math.max(maxSy, y1);
    return { x0, y0, x1, y1 };
  });
  if (!boxes.length) return { width: 1, height: 1, data: new Uint8ClampedArray(4), ox: 0, oy: 0 };

  const ox = Math.floor(minSx) - pad;
  const oy = Math.floor(minSy) - pad;
  const width = Math.ceil(maxSx) + pad - ox;
  const height = Math.ceil(maxSy) + pad - oy;
  const data = new Uint8ClampedArray(width * height * 4);
  const depth = new Float32Array(width * height).fill(-Infinity);

  const colors = boxes.map((b) => {
    const base = hexToRgb(b.c);
    return { top: b.top ? hexToRgb(b.top) : shade(base, TOP), left: shade(base, LEFT), right: shade(base, RIGHT) };
  });

  const put = (i: number, d: number, c: RGB) => {
    if (d <= depth[i]) return;
    depth[i] = d;
    data[i * 4] = c[0];
    data[i * 4 + 1] = c[1];
    data[i * 4 + 2] = c[2];
    data[i * 4 + 3] = 255;
  };

  boxes.forEach((b, k) => {
    const bb = bounds[k];
    const px0 = Math.max(0, Math.floor(bb.x0) - ox);
    const px1 = Math.min(width, Math.ceil(bb.x1) - ox + 1);
    const py0 = Math.max(0, Math.floor(bb.y0) - oy);
    const py1 = Math.min(height, Math.ceil(bb.y1) - oy + 1);
    const x1 = b.x + b.w;
    const y1 = b.y + b.d;
    const z1 = b.z + b.h;
    const col = colors[k];
    for (let py = py0; py < py1; py++) {
      const sy = oy + py + 0.5;
      for (let px = px0; px < px1; px++) {
        const sx = ox + px + 0.5;
        const i = py * width + px;
        // Cara superior (Z = z1)
        {
          const s = 2 * (sy + z1);
          const X = (s + sx) / 2;
          const Y = (s - sx) / 2;
          if (X >= b.x && X < x1 && Y >= b.y && Y < y1) put(i, X + Y + z1, b.topFn ? b.topFn(X, Y) : col.top);
        }
        // Cara +x (X = x1)
        {
          const Y = x1 - sx;
          const Z = (x1 + Y) / 2 - sy;
          if (Y >= b.y && Y < y1 && Z >= b.z && Z < z1) put(i, x1 + Y + Z, col.right);
        }
        // Cara +y (Y = y1)
        {
          const X = sx + y1;
          const Z = (X + y1) / 2 - sy;
          if (X >= b.x && X < x1 && Z >= b.z && Z < z1) put(i, X + y1 + Z, col.left);
        }
      }
    }
  });

  if (outline) addOutline({ width, height, data, ox, oy }, opts.outlineShade ?? 0.4);
  return { width, height, data, ox, oy };
}

/** Contorno de 1 px alrededor de la silueta, con el color vecino oscurecido. */
export function addOutline(img: PixelImage, f = 0.4) {
  const { width, height, data } = img;
  const src = new Uint8ClampedArray(data);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (src[i + 3] !== 0) continue;
      let n = -1;
      for (const [dx, dy] of [
        [0, 1],
        [0, -1],
        [1, 0],
        [-1, 0],
      ]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = (ny * width + nx) * 4;
        if (src[j + 3] !== 0) {
          n = j;
          break;
        }
      }
      if (n < 0) continue;
      data[i] = src[n] * f;
      data[i + 1] = src[n + 1] * f;
      data[i + 2] = src[n + 2] * f;
      data[i + 3] = 255;
    }
}

/** Ruido determinista por coordenadas (sin Math.random). */
export function hash2(x: number, y: number): number {
  let h = (Math.floor(x) * 374761393 + Math.floor(y) * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
