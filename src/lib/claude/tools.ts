import { defineTool, ok, registerTools } from "../agents/tools";
import { describeWindow, getUsage } from "./usage";
import { TIMEZONE } from "../agents/prompt";

const localTime = (iso: string) =>
  new Date(iso).toLocaleString("es-ES", { timeZone: TIMEZONE, weekday: "long", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** Los agentes pueden consultar los límites del plan (sin gastar uso). */
registerTools(() => [
  defineTool(
    "limites_claude",
    "Consulta cuánto se ha gastado de los límites del plan de Claude del usuario (ventana de 5 h y semanal) y cuándo se reinician.",
    {},
    async () => {
      const u = await getUsage();
      if (!u.available) return ok(`No hay datos de límites${u.error ? `: ${u.error}` : "."}`);
      const when = new Date(u.fetchedAt).toLocaleTimeString("es-ES", { timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit" });
      return ok(`Plan ${u.plan ?? "?"} (leído a las ${when}):\n${u.windows.map((w) => `- ${w.label}: ${describeWindow(w)}${w.resetsAt ? ` (el ${localTime(w.resetsAt)})` : ""}`).join("\n")}`);
    },
  ),
]);
