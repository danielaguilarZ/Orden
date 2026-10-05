import { z } from "zod";
import { route, body, type IdCtx } from "@/lib/http";
import { listVersions, restoreVersion } from "@/lib/repo/panels";

export const dynamic = "force-dynamic";

export const GET = route<IdCtx>(async (_req, { params }) => listVersions((await params).id));

/** Restaura una versión anterior { versionId }. */
export const POST = route<IdCtx>(async (req, { params }) => {
  const { versionId } = z.object({ versionId: z.number() }).parse(await body(req));
  return restoreVersion((await params).id, versionId, { by: "user" });
});
