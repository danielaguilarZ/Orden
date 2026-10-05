import { registerTools } from "../agents/tools";
import { registerPromptSection } from "../agents/prompt";
import { listAgents } from "../repo/agents";
import { grantsForAgent, listConnections } from "../repo/connections";
import { getService, type AgentGrant } from "./registry";
import "./services";

/**
 * Conexiones para los agentes:
 * - Herramientas: cada agente solo recibe las de los servicios a los que
 *   tiene acceso, y solo las de su nivel.
 * - Prompt: cada agente sabe qué tiene conectado; todos saben quién puede usar qué.
 */

function agentGrantsByService(agentId: string) {
  const by = new Map<string, AgentGrant[]>();
  for (const g of grantsForAgent(agentId)) {
    const list = by.get(g.connection.service) ?? [];
    list.push(g);
    by.set(g.connection.service, list);
  }
  return by;
}

registerTools((ctx) => {
  if (ctx.task.kind === "ambient") return [];
  return [...agentGrantsByService(ctx.agent.id)].flatMap(([service, grants]) => getService(service).tools(ctx, grants));
});

registerPromptSection((agent) => {
  const parts = [...agentGrantsByService(agent.id)].map(([service, grants]) => getService(service).prompt(grants));
  return parts.length ? parts.join("\n\n") : null;
});

/** Para el que reparte trabajo: quién puede usar cada conexión. */
registerPromptSection(
  (agent) => {
    const conns = listConnections().filter((c) => c.enabled);
    if (!conns.length) return null;
    const agents = listAgents();
    const lines = conns.map((c) => {
      const who = Object.entries(c.grants)
        .filter(([id]) => id !== agent.id)
        .map(([id, level]) => `${agents.find((a) => a.id === id)?.name ?? "?"} (${level})`);
      return `- ${c.name}: ${who.length ? who.join(", ") : "nadie más"}`;
    });
    return `Conexiones externas y quién puede usarlas (delega en ellos lo que lo necesite):\n${lines.join("\n")}`;
  },
  { dynamic: true },
);
