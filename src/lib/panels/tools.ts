import { z } from "zod";
import { defineTool, fail, ok, registerTools } from "../agents/tools";
import { registerPromptSection } from "../agents/prompt";
import { getAgent } from "../repo/agents";
import { applyPanelOps, archivePanel, createPanel, findPanel, listPanels, renamePanel, replacePanelData } from "../repo/panels";
import { getPanelType, opsGuide, PANEL_TYPES, type OpInput } from "./types";
import { formatsFor } from "./export";
import { savePanelExport } from "../exporter";
import path from "node:path";

/** Pausa entre operaciones para que el usuario vea el panel construirse. */
const STEP_MS = Number(process.env.ORDEN_PANEL_STEP_MS ?? 140);

const opsSchema = z
  .array(z.object({ op: z.string() }).passthrough())
  .describe('Lista de operaciones, p. ej. [{"op":"add_event","title":"Dentista","start":"2026-10-05T10:00"}]');

registerPromptSection(
  () => `Paneles vivos: el usuario ve en tiempo real los paneles que creas y editas (calendario, kanban, lista, tabla, notas, gráfico, hábitos).
- Para crear o cambiar contenido usa panel_crear / panel_editar con operaciones pequeñas: se ven aparecer una a una.
- Antes de editar un panel que no conoces, míralo con panel_ver. Los ids de elementos los genera el sistema (salen en panel_ver).
- Prefiere actualizar un panel existente a crear duplicados.
Tipos y operaciones:
${opsGuide()}`,
);

registerPromptSection(
  () => {
    const panels = listPanels().slice(0, 15);
    if (!panels.length) return "Paneles existentes: ninguno todavía.";
    return `Paneles existentes (id · tipo · título · resumen):\n${panels
      .map((p) => `- ${p.id} · ${p.type} · ${p.title} · ${getPanelType(p.type).summary(p.data as never)}`)
      .join("\n")}`;
  },
  { dynamic: true },
);

registerTools((ctx) => {
  const actor = { by: ctx.agent.id, taskId: ctx.task.id };
  const resolve = (ref: string) => {
    const p = findPanel(ref);
    if (!p || p.archived) throw new Error(`No encuentro el panel «${ref}». Usa paneles para ver la lista.`);
    return p;
  };
  const errText = (e: unknown) => fail((e as Error).message);

  return [
    defineTool("paneles", "Lista los paneles existentes con su id, tipo y resumen.", {}, async () => {
      const panels = listPanels();
      if (!panels.length) return ok("No hay paneles.");
      return ok(
        panels
          .map((p) => `${p.id} · ${p.type} · «${p.title}» · ${getPanelType(p.type).summary(p.data as never)} · de ${getAgent(p.agentId ?? "")?.name ?? "usuario"}`)
          .join("\n"),
      );
    }),
    defineTool("panel_ver", "Devuelve el contenido completo de un panel (JSON).", { panel: z.string().describe("id o título") }, async ({ panel }) => {
      try {
        const p = resolve(panel);
        return ok(JSON.stringify({ id: p.id, tipo: p.type, titulo: p.title, datos: p.data }));
      } catch (e) {
        return errText(e);
      }
    }),
    defineTool(
      "panel_crear",
      "Crea un panel nuevo y, opcionalmente, lo rellena con operaciones (se ven aparecer en vivo).",
      {
        tipo: z.enum(Object.keys(PANEL_TYPES) as [string, ...string[]]),
        titulo: z.string(),
        operaciones: opsSchema.optional(),
      },
      async ({ tipo, titulo, operaciones }) => {
        try {
          const p = createPanel({ type: tipo, title: titulo, agentId: ctx.agent.id, actor });
          ctx.note(`Ha creado el panel «${p.title}» (${getPanelType(tipo).label.toLowerCase()})`, { kind: "panel", panelId: p.id });
          if (!operaciones?.length) return ok(`Panel creado: ${p.id}`);
          const r = await applyPanelOps(p.id, operaciones as OpInput[], actor, { stepDelayMs: STEP_MS });
          return r.error
            ? fail(`Panel ${p.id} creado; se aplicaron ${r.applied} operaciones y falló otra: ${r.error}`)
            : ok(`Panel ${p.id} creado con ${r.applied} operaciones. Resumen: ${getPanelType(tipo).summary(r.panel.data as never)}`);
        } catch (e) {
          return errText(e);
        }
      },
    ),
    defineTool(
      "panel_editar",
      "Aplica operaciones a un panel existente, en orden. Se detiene en la primera que falle.",
      { panel: z.string().describe("id o título"), operaciones: opsSchema },
      async ({ panel, operaciones }) => {
        try {
          const p = resolve(panel);
          const r = await applyPanelOps(p.id, operaciones as OpInput[], actor, { stepDelayMs: STEP_MS });
          if (r.applied) ctx.note(`Ha actualizado «${p.title}» (${r.applied} cambio${r.applied === 1 ? "" : "s"})`, { kind: "panel", panelId: p.id });
          return r.error
            ? fail(`Se aplicaron ${r.applied} operaciones; falló: ${r.error}`)
            : ok(`Hecho (${r.applied}). Resumen: ${getPanelType(p.type).summary(r.panel.data as never)}`);
        } catch (e) {
          return errText(e);
        }
      },
    ),
    defineTool(
      "panel_reemplazar",
      "Sustituye todos los datos de un panel por otros (para reestructurar de golpe). Valida el formato del tipo.",
      { panel: z.string(), datos: z.record(z.string(), z.unknown()) },
      async ({ panel, datos }) => {
        try {
          const p = replacePanelData(resolve(panel).id, datos, actor);
          ctx.note(`Ha reorganizado «${p.title}»`, { kind: "panel", panelId: p.id });
          return ok("Hecho.");
        } catch (e) {
          return errText(e);
        }
      },
    ),
    defineTool("panel_renombrar", "Cambia el título de un panel.", { panel: z.string(), titulo: z.string() }, async ({ panel, titulo }) => {
      try {
        const p = renamePanel(resolve(panel).id, titulo, actor);
        return ok(`Ahora se llama «${p.title}».`);
      } catch (e) {
        return errText(e);
      }
    }),
    defineTool(
      "panel_exportar",
      "Guarda un panel como archivo en la carpeta de exportaciones del usuario (md, csv, xlsx o ics para calendarios).",
      { panel: z.string(), formato: z.enum(["md", "csv", "xlsx", "ics"]) },
      async ({ panel, formato }) => {
        try {
          const p = resolve(panel);
          if (!formatsFor(p.type).includes(formato)) return fail(`Formatos válidos para ${p.type}: ${formatsFor(p.type).join(", ")}.`);
          const file = savePanelExport(p, formato, ctx.agent.id);
          ctx.note(`Ha exportado «${p.title}» a ${path.basename(file)}`, { kind: "export", file });
          return ok(`Guardado en ${file}`);
        } catch (e) {
          return errText(e);
        }
      },
    ),
    defineTool("panel_archivar", "Archiva (borra) un panel. Se puede recuperar desde la papelera.", { panel: z.string() }, async ({ panel }) => {
      try {
        const p = archivePanel(resolve(panel).id, actor);
        ctx.note(`Ha archivado «${p.title}»`, { kind: "panel", panelId: p.id });
        return ok("Archivado.");
      } catch (e) {
        return errText(e);
      }
    }),
  ];
});
