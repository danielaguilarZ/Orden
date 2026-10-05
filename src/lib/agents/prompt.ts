import { getPersonality } from "../personalities";
import { listAgents } from "../repo/agents";
import type { Agent, Task } from "../types";

export const TIMEZONE = process.env.ORDEN_TZ ?? "Europe/Madrid";

export function nowText(): string {
  return new Date().toLocaleString("es-ES", {
    timeZone: TIMEZONE,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Fecha local AAAA-MM-DD en la zona del usuario. */
export function todayIso(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: TIMEZONE }).format(new Date());
}

/**
 * Secciones que añaden otros módulos (paneles, memoria…).
 * Las estáticas van primero (se reaprovechan en la caché de prompts); las
 * dinámicas (listas que cambian) al final.
 */
export type PromptSection = (agent: Agent, task: Task) => string | null;
const staticSections: PromptSection[] = [];
const dynamicSections: PromptSection[] = [];
export function registerPromptSection(fn: PromptSection, opts: { dynamic?: boolean } = {}) {
  (opts.dynamic ? dynamicSections : staticSections).push(fn);
}

/**
 * Prompt de sistema de un agente: SOLO lo que no cambia entre mensajes
 * (identidad, carácter, normas, guías). Al reanudar una sesión el SDK
 * conserva el prompt de sistema original, así que lo que cambia (equipo,
 * hora, paneles, memoria) va en `buildContext`, dentro de cada mensaje.
 */
export function buildSystemPrompt(agent: Agent, task: Task): string {
  const preset = getPersonality(agent.personality.preset);
  const parts = [
    `Eres ${agent.name}, un agente de Orden: la app de asistente personal del usuario, donde un equipo de agentes le ayuda en todos los ámbitos de su vida.`,
    agent.specialty ? `Tu especialidad: ${agent.specialty}` : "",
    `Tu carácter: ${agent.personality.description || preset.description}`,
    `Cómo hablas: ${agent.personality.voice || preset.voice}`,
    agent.instructions ? `Instrucciones del usuario para ti:\n${agent.instructions}` : "",
    `Normas:
- Habla siempre en español y con tu personalidad, pero ve al grano: respuestas breves y útiles en markdown sencillo.
- Cada llamada al modelo cuesta: no converses por conversar, no repitas lo que ya sabes y no delegues trivialidades.
- Usa la herramienta «estado» al empezar cada paso visible, con 2-6 palabras («Creando el calendario…»). Se ve en el living.
- Si un encargo encaja mejor con la especialidad de otro agente, delega con «delegar» (varios a la vez si son independientes) y recoge todo con «esperar_resultados».
- No inventes datos personales: si te falta algo importante, pregúntalo en tu respuesta final.
- Tu respuesta final es lo que verá quien te hizo el encargo.
- Cada mensaje empieza con un bloque <contexto_actual> generado por la app: es la verdad del momento (equipo, fecha, paneles, memoria) y manda sobre lo que recuerdes de mensajes anteriores. No lo menciones ni lo repitas.`,
  ];
  for (const fn of staticSections) parts.push(fn(agent, task) ?? "");
  return parts.filter(Boolean).join("\n\n");
}

/** Contexto que cambia: se recalcula y se envía con CADA mensaje. */
export function buildContext(agent: Agent, task: Task): string {
  const team = listAgents()
    .filter((a) => a.id !== agent.id)
    .map(
      (a) =>
        `- ${a.name}${a.isChief ? " (jefe)" : ""}: ${a.specialty || "sin especialidad"}${a.admin ? " [admin: puede programar mejoras de la app Orden]" : ""}${a.paused ? " [en pausa]" : ""}`,
    )
    .join("\n");
  const parts = [team ? `Tu equipo ahora mismo:\n${team}` : "Por ahora trabajas solo: no hay más agentes en el equipo."];
  parts.push(`Ahora es ${nowText()} (${TIMEZONE}). Hoy es ${todayIso()}.`);
  for (const fn of dynamicSections) parts.push(fn(agent, task) ?? "");
  return parts.filter(Boolean).join("\n\n");
}

/** Mensaje que recibe el modelo: contexto actual + lo que se pide. */
export function buildUserMessage(agent: Agent, task: Task, recap?: string): string {
  return [
    `<contexto_actual>\n${buildContext(agent, task)}\n</contexto_actual>`,
    recap ? `<conversacion_previa>\n${recap}\n</conversacion_previa>` : "",
    task.prompt,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Mensaje inicial de un encargo delegado. */
export function delegationPrompt(fromName: string, brief: string, context?: string): string {
  return [
    `Encargo de ${fromName}:`,
    brief,
    context ? `\nContexto que te pasa ${fromName}:\n${context}` : "",
    `\nHazlo y responde con el resultado concreto (lo recibirá ${fromName}, no el usuario directamente).`,
  ]
    .filter(Boolean)
    .join("\n");
}
