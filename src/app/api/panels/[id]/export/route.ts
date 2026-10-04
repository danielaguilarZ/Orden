import { z } from "zod";
import { route, body, type IdCtx } from "@/lib/http";
import { getPanel } from "@/lib/repo/panels";
import { exportPanel, fileSlug } from "@/lib/panels/export";
import { savePanelExport } from "@/lib/exporter";

export const dynamic = "force-dynamic";

const format = z.enum(["md", "csv", "xlsx", "ics"]);

/** Descarga directa: ?format=md|csv|xlsx|ics */
export const GET = route<IdCtx>(async (req, { params }) => {
  const panel = getPanel((await params).id);
  if (!panel) throw new Error("No existe ese panel.");
  const f = format.parse(new URL(req.url).searchParams.get("format"));
  const { body: content, mime } = exportPanel(panel, f, { id: panel.id });
  const name = `${fileSlug(panel.title)}.${f}`;
  return new Response(typeof content === "string" ? content : Buffer.from(content), {
    headers: { "Content-Type": mime, "Content-Disposition": `attachment; filename="${name}"` },
  });
});

/** Guarda en la carpeta local de exportaciones { format }. */
export const POST = route<IdCtx>(async (req, { params }) => {
  const { format: f } = z.object({ format }).parse(await body(req));
  return { file: savePanelExport((await params).id, f) };
});
