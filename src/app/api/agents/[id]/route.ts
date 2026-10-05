import { route, body, type IdCtx } from "@/lib/http";
import { editAgent, fireAgent, type AgentEdit } from "@/lib/team";

export const dynamic = "force-dynamic";

export const PATCH = route<IdCtx>(async (req, { params }) => {
  const { id } = await params;
  return editAgent(id, await body<AgentEdit>(req));
});

export const DELETE = route<IdCtx>(async (_req, { params }) => {
  const { id } = await params;
  fireAgent(id);
  return { ok: true };
});
