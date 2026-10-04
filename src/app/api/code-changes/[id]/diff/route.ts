import { route, type IdCtx } from "@/lib/http";
import { changeDiff } from "@/lib/dev/workspace";

export const dynamic = "force-dynamic";

export const GET = route<IdCtx>(async (_req, { params }) => ({ diff: await changeDiff((await params).id) }));
