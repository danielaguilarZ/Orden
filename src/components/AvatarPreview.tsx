"use client";

import { useEffect, useRef } from "react";
import { drawAvatar, type Pose, type View } from "@/living/avatar";
import type { Appearance } from "@/lib/types";

/** Retrato pixel art del agente (mismo dibujo que en el living). */
export function AvatarPreview({ appearance, scale = 4, pose = "stand", view = "front" }: { appearance: Appearance; scale?: number; pose?: Pose; view?: View }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const img = drawAvatar(appearance, pose, view);
    canvas.width = img.width;
    canvas.height = img.height;
    canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  }, [appearance, pose, view]);
  return <canvas ref={ref} className="avatar-preview" style={{ width: 26 * scale, height: 46 * scale }} />;
}
