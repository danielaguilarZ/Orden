import { route, body, type IdCtx } from "@/lib/http";
import { deleteUnit, updateUnit } from "@/lib/org/repo";
import { unitPatchSchema } from "@/lib/org/schemas";
import type { UnitKind } from "@/lib/org/types";

export const dynamic = "force-dynamic";

export const PATCH = route<IdCtx>(async (req, { params }) => {
  const { id } = await params;
  const { kind, ...rest } = unitPatchSchema.parse(await body(req));
  return updateUnit(id, { ...rest, ...(kind && { kind: kind as UnitKind }) });
});

export const DELETE = route<IdCtx>(async (_req, { params }) => {
  const { id } = await params;
  deleteUnit(id);
  return { ok: true };
});
