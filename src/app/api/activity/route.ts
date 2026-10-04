import { route } from "@/lib/http";
import { listActivity } from "@/lib/repo/system";

export const dynamic = "force-dynamic";

export const GET = route((req) => {
  const p = new URL(req.url).searchParams;
  return listActivity({
    agentId: p.get("agentId") ?? undefined,
    kind: p.get("kind") ?? undefined,
    before: p.get("before") ? Number(p.get("before")) : undefined,
    limit: 100,
  });
});
