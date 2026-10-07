import { randomUUID } from "node:crypto";
import { createAgent, getChief, updateAgent } from "./repo/agents";
import { createRoom, listRooms } from "./repo/rooms";
import { getPersonality } from "./personalities";
import { buildingLevel, ROOM_TEMPLATES } from "./roomTemplates";
import { DEFAULT_BUILDING, levelOrigin, ROOM_SIZE } from "../living/house";
import { tx } from "./db";

export const ZEN_INSTRUCTIONS = `Eres Zen, el jefe del equipo de asistentes personales de Orden.
Recibes encargos de cualquier ámbito de la vida del usuario (finanzas, tareas, proyectos, agenda, salud, trámites, aprendizaje…).
Decides si los haces tú o si los repartes entre los agentes especialistas, y coordinas el resultado.
Prefieres la claridad y el orden: respuestas breves, documentos bien ordenados y nada de relleno.`;

/** Crea a Zen y su despacho si la casa está vacía. Idempotente. */
export function ensureSeed() {
  if (getChief()) return;
  tx(() => {
    if (getChief()) return;
    const zenRoomId = randomUUID();
    const sereno = getPersonality("sereno");
    const zen = createAgent({
      name: "Zen",
      specialty: "Jefe del equipo: coordina, reparte encargos y ve el conjunto.",
      instructions: ZEN_INSTRUCTIONS,
      model: "sonnet",
      isChief: true,
      personality: { preset: sereno.key, description: sereno.description, voice: sereno.voice },
      appearance: {
        skin: "#e0ac69",
        hair: "#2b2b2b",
        hairStyle: "moño",
        shirt: "#e9e4d4",
        pants: "#3a4a5a",
        shoes: "#2a2a2a",
        accessory: "barba",
      },
      ambient: sereno.ambient,
    });
    if (listRooms().length === 0) {
      const zenTpl = ROOM_TEMPLATES.despacho_zen;
      // En la planta de su zona (la oficina principal), en la esquina de esa planta.
      const level = buildingLevel(DEFAULT_BUILDING);
      const origin = levelOrigin(level);
      createRoom({
        id: zenRoomId,
        name: zenTpl.label,
        kind: zenTpl.kind,
        agentId: zen.id,
        level,
        x: origin.x,
        y: origin.y,
        w: ROOM_SIZE,
        d: ROOM_SIZE,
        style: zenTpl.style,
        furniture: zenTpl.furniture!.map((f) => ({ ...f, id: randomUUID() })),
      });
      updateAgent(zen.id, { roomId: zenRoomId });
    }
  });
}
