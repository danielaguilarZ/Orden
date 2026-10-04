import { route, type IdCtx } from "@/lib/http";
import { archivePanel } from "@/lib/repo/panels";

export const dynamic = "force-dynamic";

/** Saca un panel de la papelera. */
export const POST = route<IdCtx>(async (_req, { params }) => archivePanel((await params).id, { by: "user" }, false));
