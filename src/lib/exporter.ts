import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { exportPanel, fileSlug, formatsFor, type ExportFormat } from "./panels/export";
import { getPanel, listPanels, type Panel } from "./repo/panels";
import { logActivity } from "./repo/system";

/** Carpeta local de exportaciones (ORDEN_EXPORT_DIR o ./exportaciones). */
export function exportDir(): string {
  const dir = path.resolve(process.env.ORDEN_EXPORT_DIR ?? path.join(process.cwd(), "exportaciones"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Guarda un panel en la carpeta y devuelve la ruta del archivo. */
export function savePanelExport(panelOrId: Panel | string, format: ExportFormat, by = "user"): string {
  const panel = typeof panelOrId === "string" ? getPanel(panelOrId) : panelOrId;
  if (!panel) throw new Error("No existe ese panel.");
  const { body } = exportPanel(panel, format, { id: panel.id });
  const file = path.join(/*turbopackIgnore: true*/ exportDir(), `${fileSlug(panel.title)}.${format}`);
  fs.writeFileSync(file, body);
  logActivity("exportacion", `Exportado «${panel.title}» a ${path.basename(file)}`, by === "user" ? null : by, { panelId: panel.id, file });
  return file;
}

/** Formato «natural» de cada tipo además del Markdown. */
const MAIN: Record<string, ExportFormat> = { calendario: "ics", tabla: "xlsx", grafico: "xlsx", habitos: "xlsx", kanban: "csv", lista: "csv" };

/** Exporta todos los paneles: .md y su formato de datos principal. */
export function exportAllPanels(): string[] {
  const files: string[] = [];
  for (const p of listPanels()) {
    files.push(savePanelExport(p, "md"));
    const main = MAIN[p.type];
    if (main && formatsFor(p.type).includes(main)) files.push(savePanelExport(p, main));
  }
  return files;
}

/** Abre la carpeta de exportaciones en el explorador del sistema. */
export function openExportDir() {
  const dir = exportDir();
  const cmd = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  spawn(cmd, [dir], { detached: true, stdio: "ignore" }).unref();
  return dir;
}
