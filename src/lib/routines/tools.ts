import { z } from "zod";
import { defineTool, fail, ok, registerTools } from "../agents/tools";
import { registerPromptSection } from "../agents/prompt";
import { findAgentByName, getAgent } from "../repo/agents";
import { createRoutine, deleteRoutine, listRoutines, updateRoutine } from "../repo/routines";
import { describeSchedule, scheduleSchema } from "./schedule";

registerPromptSection(
  () =>
    "Rutinas: si el usuario pide algo periódico («cada mañana…», «todos los lunes…», «el día 1 de cada mes…»), créalo con rutina_crear en vez de hacerlo una sola vez.",
);

registerTools((ctx) => {
  const fmt = (r: ReturnType<typeof listRoutines>[number]) =>
    `${r.id.slice(0, 8)} · ${getAgent(r.agentId)?.name ?? "?"} · «${r.name}» · ${describeSchedule(r.schedule)}${r.enabled ? "" : " (pausada)"}`;
  return [
    defineTool("rutinas", "Lista las rutinas programadas del equipo.", {}, async () => {
      const all = listRoutines();
      return ok(all.length ? all.map(fmt).join("\n") : "No hay rutinas.");
    }),
    defineTool(
      "rutina_crear",
      'Programa una tarea periódica. cuando: {"tipo":"diaria","hora":"08:00"} | {"tipo":"laborables","hora":"HH:MM"} | {"tipo":"semanal","dias":[1..7 (1=lunes)],"hora":"HH:MM"} | {"tipo":"mensual","dia":1..31 o -1 (último),"hora":"HH:MM"} | {"tipo":"intervalo","minutos":N} | {"tipo":"una_vez","cuando":"AAAA-MM-DDTHH:MM"}.',
      {
        nombre: z.string(),
        que_hacer: z.string().describe("Instrucciones completas para cada ejecución"),
        cuando: scheduleSchema,
        agente: z.string().optional().describe("Quién la ejecuta (por defecto, tú). Solo el jefe puede asignarla a otro."),
      },
      async ({ nombre, que_hacer, cuando, agente }) => {
        let target = ctx.agent;
        if (agente && agente.toLowerCase() !== ctx.agent.name.toLowerCase()) {
          if (!ctx.agent.isChief) return fail("Solo Zen puede programar rutinas para otros agentes.");
          const found = findAgentByName(agente);
          if (!found) return fail(`No hay ningún agente llamado «${agente}».`);
          target = found;
        }
        try {
          const r = createRoutine({ agentId: target.id, name: nombre, prompt: que_hacer, schedule: cuando }, ctx.agent.id);
          ctx.note(`Ha programado la rutina «${r.name}» (${describeSchedule(r.schedule)}) para ${target.name}`, { kind: "routine", routineId: r.id });
          return ok(`Rutina creada: ${fmt(r)}. Próxima: ${r.nextRunAt}`);
        } catch (e) {
          return fail((e as Error).message);
        }
      },
    ),
    defineTool(
      "rutina_cambiar",
      "Activa, pausa o cambia una rutina (por id corto).",
      { id: z.string(), activa: z.boolean().optional(), que_hacer: z.string().optional(), cuando: scheduleSchema.optional() },
      async ({ id, activa, que_hacer, cuando }) => {
        const r = listRoutines().find((x) => x.id.startsWith(id));
        if (!r) return fail("No encuentro esa rutina.");
        if (r.agentId !== ctx.agent.id && !ctx.agent.isChief) return fail("Esa rutina no es tuya.");
        const u = updateRoutine(r.id, { enabled: activa, prompt: que_hacer, schedule: cuando });
        return ok(`Hecho: ${fmt(u)}`);
      },
    ),
    defineTool("rutina_borrar", "Elimina una rutina (por id corto).", { id: z.string() }, async ({ id }) => {
      const r = listRoutines().find((x) => x.id.startsWith(id));
      if (!r) return fail("No encuentro esa rutina.");
      if (r.agentId !== ctx.agent.id && !ctx.agent.isChief) return fail("Esa rutina no es tuya.");
      deleteRoutine(r.id);
      ctx.note(`Ha eliminado la rutina «${r.name}»`, { kind: "routine" });
      return ok("Eliminada.");
    }),
  ];
});
