import { z } from "zod";
import { defineTool, fail, ok, registerTools } from "../agents/tools";
import { registerPromptSection } from "../agents/prompt";
import { archiveMemory, listMemory, searchMemory, upsertMemory, type MemoryEntry } from "../repo/memory";
import { MEMORY_CATEGORIES } from "./categories";

const CATS = MEMORY_CATEGORIES.map((c) => c.key) as [string, ...string[]];

const line = (e: MemoryEntry) => `- [${e.id.slice(0, 8)}] (${e.category}) ${e.title}: ${e.content.replace(/\s+/g, " ").slice(0, 280)}`;

/** Lo básico de «quién soy»: siempre presente, pero recortado. */
function profileBasics(): string {
  const items = listMemory({ category: "quien_soy" }).slice(0, 8);
  if (!items.length) return "";
  let text = items.map((e) => `${e.title}: ${e.content.replace(/\s+/g, " ")}`).join(" · ");
  if (text.length > 600) text = text.slice(0, 599) + "…";
  return text;
}

registerPromptSection(
  () => `Memoria compartida («perfil de vida» del usuario, común a todo el equipo):
- Antes de un encargo personal, busca lo relevante con memoria_buscar (no adivines lo que puedes consultar).
- Cuando descubras algo duradero y útil (datos personales, preferencias, personas, rutinas, proyectos, decisiones), guárdalo con memoria_guardar: breve, concreto y en la categoría adecuada. No guardes lo efímero ni lo que ya esté.
- Categorías: ${MEMORY_CATEGORIES.map((c) => `${c.key} (${c.label.toLowerCase()})`).join(", ")}.`,
);

/** Recuperación automática: lo más relevante para ESTE encargo (sin cargarlo todo). */
registerPromptSection(
  (_agent, task) => {
    const basics = profileBasics();
    const hits = searchMemory(`${task.title} ${task.prompt}`, { limit: 6 }).filter((e) => e.category !== "quien_soy" || !basics);
    const parts: string[] = [];
    if (basics) parts.push(`Sobre el usuario: ${basics}`);
    if (hits.length) parts.push(`Recuerdos que pueden servir para este encargo (id corto entre corchetes):\n${hits.map(line).join("\n")}`);
    return parts.length ? parts.join("\n\n") : "La memoria compartida aún no tiene nada relevante para esto.";
  },
  { dynamic: true },
);

registerTools((ctx) => {
  const actor = { by: ctx.agent.id, taskId: ctx.task.id };
  const resolveId = (short: string) => {
    const all = [...listMemory(), ...listMemory({ archived: true })];
    return all.find((e) => e.id === short || e.id.startsWith(short))?.id;
  };
  return [
    defineTool(
      "memoria_buscar",
      "Busca en la memoria compartida lo relacionado con un tema (búsqueda por palabras, sin tildes).",
      { consulta: z.string(), categoria: z.enum(CATS).optional(), limite: z.number().int().min(1).max(20).optional() },
      async ({ consulta, categoria, limite }) => {
        const hits = searchMemory(consulta, { category: categoria, limit: limite ?? 8 });
        const extra = categoria && !hits.length ? listMemory({ category: categoria }).slice(0, limite ?? 8) : [];
        const list = hits.length ? hits : extra;
        return ok(list.length ? list.map(line).join("\n") : "No hay nada guardado sobre eso.");
      },
    ),
    defineTool(
      "memoria_guardar",
      "Guarda o actualiza un recuerdo duradero. Si ya existe uno con el mismo título en la categoría (o pasas su id), se actualiza.",
      {
        categoria: z.enum(CATS),
        titulo: z.string().describe("Corto, p. ej. «Nombre», «Cumpleaños de Laura», «Presupuesto mensual»"),
        contenido: z.string(),
        etiquetas: z.array(z.string()).optional(),
        id: z.string().optional().describe("id (o id corto) para actualizar uno concreto"),
      },
      async ({ categoria, titulo, contenido, etiquetas, id }) => {
        try {
          const fullId = id ? resolveId(id) : undefined;
          if (id && !fullId) return fail(`No encuentro el recuerdo ${id}.`);
          const { entry, created } = upsertMemory({ id: fullId, category: categoria, title: titulo, content: contenido, tags: etiquetas }, actor);
          ctx.note(`${created ? "Ha guardado" : "Ha actualizado"} en la memoria: ${entry.title}`, { kind: "memory", memoryId: entry.id });
          return ok(`${created ? "Guardado" : "Actualizado"} [${entry.id.slice(0, 8)}].`);
        } catch (e) {
          return fail((e as Error).message);
        }
      },
    ),
    defineTool("memoria_olvidar", "Olvida (archiva) un recuerdo que ya no es cierto. Se puede recuperar.", { id: z.string() }, async ({ id }) => {
      const fullId = resolveId(id);
      if (!fullId) return fail(`No encuentro el recuerdo ${id}.`);
      const e = archiveMemory(fullId, actor);
      ctx.note(`Ha olvidado: ${e.title}`, { kind: "memory", memoryId: e.id });
      return ok("Olvidado.");
    }),
  ];
});
