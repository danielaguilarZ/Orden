import { z } from "zod";
import { route, body, type IdCtx } from "@/lib/http";
import {
  applyPanelOps,
  archivePanel,
  deletePanelForever,
  getPanel,
  renamePanel,
  replacePanelData,
  setPanelLayout,
} from "@/lib/repo/panels";
import type { OpInput } from "@/lib/panels/types";

export const dynamic = "force-dynamic";

const USER = { by: "user" };

export const GET = route<IdCtx>(async (_req, { params }) => {
  const panel = getPanel((await params).id);
  if (!panel) throw new Error("No existe ese panel.");
  return panel;
});

const patchSchema = z.object({
  ops: z.array(z.object({ op: z.string() }).passthrough()).optional(),
  title: z.string().optional(),
  data: z.unknown().optional(),
  layout: z.object({ order: z.number().optional(), size: z.enum(["normal", "ancho", "alto", "grande"]).optional() }).optional(),
});

/** Edición manual: mismas operaciones que usan los agentes. */
export const PATCH = route<IdCtx>(async (req, { params }) => {
  const { id } = await params;
  const input = patchSchema.parse(await body(req));
  let panel = getPanel(id);
  if (!panel) throw new Error("No existe ese panel.");
  if (input.title !== undefined) panel = renamePanel(id, input.title, USER);
  if (input.data !== undefined) panel = replacePanelData(id, input.data, USER);
  if (input.ops?.length) {
    const r = await applyPanelOps(id, input.ops as OpInput[], USER);
    if (r.error) throw new Error(r.error);
    panel = r.panel;
  }
  if (input.layout) panel = setPanelLayout(id, input.layout);
  return panel;
});

/** Archiva (papelera). Con ?forever=1 y ya archivado, lo borra del todo. */
export const DELETE = route<IdCtx>(async (req, { params }) => {
  const { id } = await params;
  const panel = getPanel(id);
  if (!panel) throw new Error("No existe ese panel.");
  if (new URL(req.url).searchParams.get("forever") === "1" && panel.archived) {
    deletePanelForever(id);
    return { ok: true };
  }
  return archivePanel(id, USER);
});
