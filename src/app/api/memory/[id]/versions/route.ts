import { z } from "zod";
import { route, body, type IdCtx } from "@/lib/http";
import { listMemoryVersions, restoreMemoryVersion } from "@/lib/repo/memory";

export const dynamic = "force-dynamic";

export const GET = route<IdCtx>(async (_req, { params }) => listMemoryVersions((await params).id));

export const POST = route<IdCtx>(async (req, { params }) => {
  const { versionId } = z.object({ versionId: z.number() }).parse(await body(req));
  return restoreMemoryVersion((await params).id, versionId, { by: "user" });
});
