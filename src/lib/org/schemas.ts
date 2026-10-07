import { z } from "zod";
import { UNIT_KINDS } from "./types";

/** Validación de lo que llega de la web para la organización. */

const kind = z.enum(UNIT_KINDS as [string, ...string[]]);
const model = z.enum(["haiku", "sonnet", "opus"]);

export const unitSchema = z.object({
  name: z.string().trim().min(2, "Ponle nombre").max(60),
  kind: kind.default("empresa"),
  summary: z.string().trim().max(2000).default(""),
  goals: z.string().trim().max(2000).default(""),
  building: z.string().trim().max(60).nullable().optional(),
});

export const unitPatchSchema = unitSchema.partial();

export const roleSchema = z.object({
  unitId: z.string().nullable().optional(),
  role: z.string().trim().max(80).optional(),
  duties: z.string().trim().max(2000).optional(),
  lead: z.boolean().optional(),
});

export const itemSchema = z.object({
  title: z.string().trim().min(3, "Escribe la tarea").max(140),
  detail: z.string().trim().max(4000).default(""),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
  model: model.nullable().optional(),
  unitId: z.string().nullable().optional(),
});

export const itemPatchSchema = itemSchema.partial().extend({
  status: z.enum(["pendiente", "hecha", "descartada"]).optional(),
});

export const autopilotSchema = z.object({
  enabled: z.boolean().optional(),
  weeklyMax: z.number().int().min(5).max(100).optional(),
  sessionMax: z.number().int().min(5).max(100).optional(),
  maxParallel: z.number().int().min(1).max(5).optional(),
});
