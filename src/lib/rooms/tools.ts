import { z } from "zod";
import { defineTool, fail, ok, registerTools } from "../agents/tools";
import { registerPromptSection } from "../agents/prompt";
import { getAgent, listAgents, setAgentLocation } from "../repo/agents";
import { listRooms, updateRoom } from "../repo/rooms";
import { buildRoom, describeRooms, moveFurniture, placeFurnitureAt, redecorateRoom, setRoomFinish, type PlaceResult } from "../rooms";
import { describeRoomLayout, itemName, shortIds } from "../../living/roomMap";
import { roomContext } from "../../living/roomEditor";
import { FURNITURE } from "../../living/furniture";
import { describeFinishes, FLOOR_FINISHES, WALL_FINISHES } from "../../living/finishes";
import { DESK_SETS } from "../../living/decorator";
import { currentRoom, findRoomByRef } from "../../living/presence";
import { BUILDINGS } from "../roomTemplates";

const CATALOG = Object.entries(FURNITURE)
  .map(([k, d]) => `${k} (${d.label.toLowerCase()})`)
  .join(", ");

registerPromptSection(
  () => `Salas de la casa: todas son de todos. Cada sala tiene un dueño de referencia (o es común), pero cualquier agente puede estar, trabajar y decorar en cualquiera.
- Tu sitio por defecto es tu sala o, si no tienes, tu escritorio asignado en una sala común.
- sala_ir te lleva a otra sala (se ve en el living); sala_decorar, sala_suelo_paredes, sala_renombrar y sala_crear sirven para cualquier sala.
- Si no indicas sala, se usa aquella en la que estás.
- Para ver la disposición exacta (plano con coordenadas, id de cada mueble, puertas, huecos libres y avisos) usa sala_ver. Para colocar con precisión: sala_mover_mueble (x, y, girado o junto_a) y sala_decorar con x, y o junto_a. Antes de reordenar una sala, mírala con sala_ver; al terminar, revisa sus avisos.`,
);

registerPromptSection(
  (agent) => {
    const me = getAgent(agent.id) ?? agent;
    return describeRooms(listRooms(), listAgents(), me);
  },
  { dynamic: true },
);

registerTools((ctx) => {
  /** Sala pedida o, si no se indica, la sala en la que está el agente ahora. */
  const findRoom = (ref?: string) => {
    const rooms = listRooms();
    if (!ref?.trim()) return currentRoom(getAgent(ctx.agent.id) ?? ctx.agent, rooms);
    return findRoomByRef(rooms, ref);
  };
  /** Sin sala: avisa si la pedida está en la papelera (borrada) y lista las que hay. */
  const notFound = (ref?: string) => {
    const gone = ref?.trim() ? findRoomByRef(listRooms({ archived: true }), ref) : undefined;
    const list = `Salas: ${listRooms()
      .map((r) => `«${r.name}»`)
      .join(", ")}.`;
    return fail(gone ? `La sala «${gone.name}» se ha borrado (está en la papelera; solo el usuario puede recuperarla). ${list}` : `No encuentro esa sala. ${list}`);
  };

  /** Texto de resultado de una colocación: qué quedó dónde y avisos de coherencia. */
  const placedText = (verb: string, r: PlaceResult) => {
    const ids = shortIds(r.room.furniture);
    const what = r.items.map((it) => `${itemName(it, ids)} en (${it.x},${it.y})${it.flip ? " girado" : ""}`).join(" y ");
    return `${verb} ${what} en «${r.room.name}».${r.warnings.length ? `\nAvisos:\n${r.warnings.map((w) => `- ${w}`).join("\n")}` : " Sin avisos."}`;
  };
  const coord = z.number().int().min(0).max(63);

  return [
    defineTool(
      "sala_ver",
      "Plano detallado de una sala: tamaño, puertas y pasarelas (a qué sala llevan), quién está, mapa ASCII, cada mueble con su id, posición (x,y), ancho×fondo, giro y hacia dónde mira, lo que hay encima de cada mesa, huecos libres y avisos (puertas tapadas, sillas sin mesa delante, solapes…). x crece hacia la derecha (columnas) e y hacia abajo (filas).",
      { sala: z.string().optional().describe("Nombre de la sala (por defecto, en la que estás)") },
      async ({ sala }) => {
        const room = findRoom(sala);
        if (!room) return notFound(sala);
        const rooms = listRooms();
        return ok(describeRoomLayout(room, rooms, listAgents(), roomContext(room, rooms)));
      },
    ),
    defineTool(
      "sala_mover_mueble",
      "Mueve y/o gira un mueble concreto de cualquier sala (mismas reglas que el editor de sala: no se sale, no se solapa, no tapa puertas). Indica x,y (esquina superior izquierda de su huella), girado, o junto_a (id de otro mueble: la silla se pone mirando a la mesa, lo pequeño encima de la mesa, el escritorio delante de la silla; el resto, pegado). Lo que lleva encima viaja con él. Adornos de pared: muro norte con y=0, muro oeste con x=0 (girado). Si no cabe, no cambia nada y te dice con qué choca y huecos válidos cercanos. Ids y coordenadas en sala_ver.",
      {
        mueble: z.string().describe("Id del mueble (el corto de sala_ver vale)"),
        sala: z.string().optional().describe("Nombre de la sala (por defecto, en la que estás)"),
        x: coord.optional(),
        y: coord.optional(),
        girado: z.boolean().optional().describe("true = girado 90° (intercambia ancho y fondo; los asientos pasan de mirar a +x a mirar a +y)"),
        junto_a: z.string().optional().describe("Id de otro mueble junto al que ponerlo (en lugar de x,y)"),
      },
      async ({ mueble, sala, x, y, girado, junto_a }) => {
        const room = findRoom(sala);
        if (!room) return notFound(sala);
        try {
          const r = moveFurniture(room.id, mueble, { x, y, flip: girado, near: junto_a });
          ctx.note(`Ha recolocado muebles en «${room.name}»`, { kind: "room", roomId: room.id });
          return ok(placedText("Movido:", r));
        } catch (e) {
          return fail((e as Error).message);
        }
      },
    ),
    defineTool(
      "sala_decorar",
      `Añade o quita muebles de cualquier sala (la tuya, la de otro agente o una común). Sin posición, los nuevos se colocan solos en un hueco libre sin mover los que ya hay; con x,y (y girado) o junto_a (id de otro mueble) se coloca UNO solo justo ahí, comprobando choques. «puesto» = silla + escritorio y «puesto_moderno» = silla ergonómica + escritorio moderno (con x,y: la silla en x,y y el escritorio a su derecha; girado, debajo). quitar admite tipos (quita uno) o ids concretos de sala_ver. Muebles: ${CATALOG}.`,
      {
        anadir: z.array(z.string()).optional(),
        quitar: z.array(z.string()).optional().describe("Tipos de mueble o ids (de sala_ver)"),
        sala: z.string().optional().describe("Nombre de la sala (por defecto, en la que estás)"),
        x: coord.optional().describe("Solo con un único mueble en anadir"),
        y: coord.optional().describe("Solo con un único mueble en anadir"),
        girado: z.boolean().optional(),
        junto_a: z.string().optional().describe("Id de un mueble junto al que poner el nuevo (solo con un único mueble en anadir)"),
      },
      async ({ anadir, quitar, sala, x, y, girado, junto_a }) => {
        const room = findRoom(sala);
        if (!room) return notFound(sala);
        const unknown = (anadir ?? []).filter((k) => !DESK_SETS[k] && !FURNITURE[k]);
        if (unknown.length) return fail(`No conozco: ${unknown.join(", ")}.`);
        const positioned = x !== undefined || y !== undefined || girado !== undefined || Boolean(junto_a?.trim());
        if (positioned) {
          if (anadir?.length !== 1) return fail("Con x, y, girado o junto_a, anadir debe llevar un único mueble (haz una llamada por mueble).");
          // Primero se quita (así se puede sustituir un mueble en su mismo sitio).
          const removed = quitar?.length ? redecorateRoom(room.id, { remove: quitar }).removed : [];
          const done = removed.length ? `Quitado: ${removed.join(", ")}. ` : "";
          if (removed.length) ctx.note(`Ha redecorado «${room.name}»`, { kind: "room", roomId: room.id });
          try {
            const r = placeFurnitureAt(room.id, anadir[0], { x, y, flip: girado, near: junto_a?.trim() || undefined });
            if (!removed.length) ctx.note(`Ha redecorado «${room.name}»`, { kind: "room", roomId: room.id });
            return ok(`${done}${placedText("Colocado:", r)}`);
          } catch (e) {
            return fail(`${done}${(e as Error).message}`);
          }
        }
        const r = redecorateRoom(room.id, { add: anadir, remove: quitar });
        ctx.note(`Ha redecorado «${room.name}»`, { kind: "room", roomId: room.id });
        return ok(
          [
            r.placed.length && `Colocado: ${r.placed.join(", ")}.`,
            r.removed.length && `Quitado: ${r.removed.join(", ")}.`,
            r.skipped.length && `Sin sitio para: ${r.skipped.join(", ")}.`,
          ]
            .filter(Boolean)
            .join(" ") || "Sin cambios.",
        );
      },
    ),
    defineTool(
      "sala_suelo_paredes",
      `Cambia el suelo y/o las paredes de cualquier sala con acabados del catálogo (por id o nombre). Lo que no indiques se queda igual. Suelos: ${describeFinishes(FLOOR_FINISHES)}. Paredes: ${describeFinishes(WALL_FINISHES)}.`,
      {
        sala: z.string().optional().describe("Nombre de la sala (por defecto, en la que estás)"),
        suelo: z.string().optional().describe("Acabado de suelo, p. ej. «nogal» o «moqueta azul»"),
        pared: z.string().optional().describe("Acabado de pared, p. ej. «salvia» o «azul_noche»"),
      },
      async ({ sala, suelo, pared }) => {
        const room = findRoom(sala);
        if (!room) return notFound(sala);
        try {
          const r = setRoomFinish(room.id, { suelo, pared });
          const what = [r.floor && `suelo «${r.floor.label}»`, r.wall && `paredes «${r.wall.label}»`].filter(Boolean).join(" y ");
          ctx.note(`Ha cambiado ${what} de «${room.name}»`, { kind: "room", roomId: room.id });
          return ok(`«${room.name}»: ${what}.`);
        } catch (e) {
          return fail((e as Error).message);
        }
      },
    ),
    defineTool(
      "sala_ir",
      "Vas a otra sala de la casa (cualquiera) y te quedas ahí, también trabajando, hasta que vuelvas. Sin sala, vuelves a tu sitio (tu sala o la de tu escritorio).",
      { sala: z.string().optional().describe("Nombre de la sala; vacío para volver a tu sitio") },
      async ({ sala }) => {
        if (!sala?.trim()) {
          setAgentLocation(ctx.agent.id, null);
          const home = currentRoom({ roomId: ctx.agent.roomId, locationRoomId: null }, listRooms());
          return ok(home ? `Has vuelto a «${home.name}».` : "Has vuelto a tu sitio.");
        }
        const room = findRoomByRef(listRooms(), sala);
        if (!room) return notFound(sala);
        // Ir a la propia sala es lo mismo que volver: no se guarda ubicación.
        setAgentLocation(ctx.agent.id, room.id === ctx.agent.roomId ? null : room.id);
        ctx.note(`Se ha ido a «${room.name}»`, { kind: "room", roomId: room.id });
        return ok(`Ahora estás en «${room.name}».`);
      },
    ),
    defineTool(
      "sala_renombrar",
      "Cambia el nombre de cualquier sala.",
      { sala: z.string().optional().describe("Sala a renombrar (por defecto, en la que estás)"), nombre: z.string().trim().min(1) },
      async ({ sala, nombre }) => {
        const room = findRoom(sala);
        if (!room) return notFound(sala);
        updateRoom(room.id, { name: nombre });
        ctx.note(`Ha renombrado «${room.name}» a «${nombre}»`, { kind: "room", roomId: room.id });
        return ok(`Sala renombrada a «${nombre}».`);
      },
    ),
    defineTool(
      "sala_crear",
      "Crea una sala común para un ámbito nuevo (sin dueño) en la casa de Orden. Se amuebla sola según el ámbito.",
      {
        nombre: z.string(),
        ambito: z.string().describe("p. ej. «cocina y recetas», «viajes», «salud», «diseño web»"),
      },
      async ({ nombre, ambito }) => {
        const room = buildRoom({ name: nombre, domain: `${ambito} ${nombre}` });
        ctx.note(`Ha creado la sala «${room.name}»`, { kind: "room", roomId: room.id });
        return ok(`Sala «${room.name}» creada (${room.kind}, ${BUILDINGS[room.building ?? "orden"]?.label ?? room.building}).`);
      },
    ),
  ];
});
