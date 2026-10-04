/** Hoja de avatares ampliada para revisar el pixel art. Uso: npx tsx scripts/preview-avatars.ts salida.png */
import fs from "node:fs";
import { drawAvatar, POSES, AVATAR_W, AVATAR_H } from "../src/living/avatar";
import { encodePng } from "./png";

const looks = [
  { skin: "#e0ac69", hair: "#2b2b2b", hairStyle: "moño", shirt: "#e9e4d4", pants: "#3a4a5a", shoes: "#2a2a2a", accessory: "barba" },
  { skin: "#f1c27d", hair: "#a0522d", hairStyle: "largo", shirt: "#c0392b", pants: "#2f3640", shoes: "#1e1e1e", accessory: "gafas" },
  { skin: "#8d5524", hair: "#111111", hairStyle: "rizado", shirt: "#27ae60", pants: "#34495e", shoes: "#ffffff", accessory: "auriculares" },
  { skin: "#ffdbac", hair: "#e6c35c", hairStyle: "coleta", shirt: "#8e44ad", pants: "#2c3e50", shoes: "#7f4f24", accessory: "pajarita" },
  { skin: "#c68642", hair: "#6b4226", hairStyle: "corto", shirt: "#2980b9", pants: "#7f8c8d", shoes: "#333333", accessory: "gorro" },
  { skin: "#f1c27d", hair: "#555555", hairStyle: "rapado", shirt: "#f39c12", pants: "#2c3e50", shoes: "#222222", accessory: "ninguno" },
] as const;
const Z = 4;
const cols = POSES.length * 2;
const W = cols * AVATAR_W * Z;
const H = looks.length * AVATAR_H * Z;
const out = new Uint8ClampedArray(W * H * 4);
for (let i = 0; i < W * H; i++) out.set([200, 200, 210, 255], i * 4);
looks.forEach((a, row) => {
  let col = 0;
  for (const pose of POSES) for (const view of ["front", "back"] as const) {
    const img = drawAvatar(a as any, pose, view);
    for (let y = 0; y < AVATAR_H * Z; y++) for (let x = 0; x < AVATAR_W * Z; x++) {
      const si = (Math.floor(y / Z) * AVATAR_W + Math.floor(x / Z)) * 4;
      if (img.data[si + 3] === 0) continue;
      const di = ((row * AVATAR_H * Z + y) * W + col * AVATAR_W * Z + x) * 4;
      out.set(img.data.subarray(si, si + 4), di);
    }
    col++;
  }
});
fs.writeFileSync(process.argv[2] ?? "avatars.png", encodePng(W, H, out));
