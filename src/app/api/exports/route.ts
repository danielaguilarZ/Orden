import { z } from "zod";
import { route, body } from "@/lib/http";
import { exportAllPanels, exportDir, openExportDir } from "@/lib/exporter";

export const dynamic = "force-dynamic";

export const GET = route(() => ({ dir: exportDir() }));

/** { action: "all" } exporta todos los paneles; { action: "open" } abre la carpeta. */
export const POST = route(async (req) => {
  const { action } = z.object({ action: z.enum(["all", "open"]) }).parse(await body(req));
  if (action === "open") return { dir: openExportDir() };
  return { dir: exportDir(), files: exportAllPanels() };
});
