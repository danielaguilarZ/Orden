import type { FurnitureItem, RoomStyle } from "./types";
import { DEFAULT_BUILDING } from "../living/house";

/**
 * Plantillas de sala por ámbito. Al crear un agente o un ámbito nuevo se
 * elige la plantilla que mejor encaja y el decorador la amuebla solo.
 * Añadir un ámbito = añadir una entrada con sus palabras clave y muebles.
 */
export interface RoomTemplate {
  kind: string;
  label: string;
  /** Palabras que hacen que una especialidad encaje con esta sala. */
  keywords: string[];
  style: RoomStyle;
  /** Muebles colocados a mano (salas fijas). */
  furniture?: Omit<FurnitureItem, "id">[];
  /** Muebles que coloca el decorador automático («puesto» = escritorio + silla). */
  kinds?: string[];
  /** Edificio al que pertenece la plantilla (por defecto, la casa de Orden). */
  building?: string;
  /** Colores que reciben los muebles de esta sala que no traigan los suyos (por tipo). */
  tints?: Record<string, Record<string, string>>;
}

/**
 * Edificios. Las salas de cada uno solo usan sus plantillas. La base trae solo
 * la casa de Orden; otro edificio = otra entrada aquí y plantillas con su
 * `building` (se une a la casa con una pasarela acristalada).
 */
export const BUILDINGS: Record<string, { label: string; fallback: string; level: number }> = {
  // Cada «edificio» es ahora una zona con planta propia de la torre (`level`).
  orden: { label: "Oficina", fallback: "estudio", level: 1 },
  marketing: { label: "Marketing", fallback: "marketing_abierta", level: 2 },
};

/**
 * Nombres de las plantas de la torre (una torre de oficinas), de abajo
 * arriba. Las que aún no tienen salas se ven como plantas diáfanas.
 */
export const FLOOR_NAMES: Record<number, string> = {
  0: "Vestíbulo",
  1: "Oficina",
  2: "Marketing",
};

/**
 * Nombres de planta que vienen de los datos (las unidades de la organización
 * que trabajan en cada planta). Mandan sobre `FLOOR_NAMES`. Los fija el
 * servidor al preparar el contexto y la web al hidratarse.
 */
let floorNames: Record<number, string> = {};
export function setFloorNames(names: Record<number, string>) {
  floorNames = names;
}

/** Planta en la que se construyen las salas de una zona. */
export function buildingLevel(building: string): number {
  return BUILDINGS[building]?.level ?? 0;
}

/** «Planta 2 · Marketing». */
export function floorLabel(level: number): string {
  const name = floorNames[level] ?? FLOOR_NAMES[level] ?? Object.values(BUILDINGS).find((b) => b.level === level)?.label;
  return level === 0 ? `Planta baja${name ? ` · ${name}` : ""}` : `Planta ${level}${name ? ` · ${name}` : ""}`;
}

export const ROOM_TEMPLATES: Record<string, RoomTemplate> = {
  despacho_zen: {
    kind: "despacho_zen",
    label: "Despacho de Zen",
    keywords: ["jefe", "coordinación"],
    style: { floor: "madera", floorA: "#c49a6c", floorB: "#b68c5f", wall: "#e6dccb", wallTrim: "#6b5440" },
    furniture: [
      { kind: "caligrafia", x: 2, y: 0 },
      { kind: "ventana", x: 5, y: 0 },
      { kind: "ventana", x: 0, y: 2, flip: true },
      { kind: "reloj", x: 8, y: 0 },
      { kind: "bonsai", x: 0, y: 0 },
      { kind: "planta", x: 9, y: 0 },
      { kind: "cojin", x: 3, y: 3 },
      { kind: "mesita", x: 4, y: 3, flip: true },
      { kind: "taza", x: 4, y: 3, z: 10 },
      { kind: "holo_boton", x: 4, y: 4, z: 10 },
      { kind: "estanteria", x: 0, y: 6 },
      { kind: "tatami", x: 3, y: 6 },
      { kind: "cojin", x: 4, y: 7, tint: { $tela: "#6b3a3a" } },
      { kind: "jardin_zen", x: 7, y: 6 },
      { kind: "farol", x: 9, y: 3 },
      { kind: "farol", x: 9, y: 9 },
    ],
  },
  salon: {
    kind: "salon",
    label: "Salón",
    keywords: ["común", "salón", "reuniones"],
    style: { floor: "moqueta", floorA: "#8fa58a", floorB: "#86a081", wall: "#efe3cf", wallTrim: "#7d6650" },
    furniture: [
      { kind: "ventana", x: 2, y: 0 },
      { kind: "cuadro", x: 5, y: 0 },
      { kind: "ventana", x: 7, y: 0 },
      { kind: "cafetera", x: 9, y: 1, flip: true },
      { kind: "planta", x: 9, y: 0 },
      { kind: "alfombra", x: 3, y: 5 },
      { kind: "sofa", x: 2, y: 5 },
      { kind: "mesita", x: 4, y: 5, flip: true },
      { kind: "taza", x: 4, y: 6, z: 10 },
      { kind: "sillon", x: 6, y: 6 },
      { kind: "lampara", x: 2, y: 8 },
      { kind: "planta", x: 9, y: 9 },
    ],
  },
  estudio: {
    kind: "estudio",
    label: "Estudio",
    keywords: [],
    style: { floor: "madera", floorA: "#a97c50", floorB: "#9b7047", wall: "#dfe3e8", wallTrim: "#5d6875" },
    kinds: ["puesto", "ordenador", "ventana", "cuadro", "estanteria", "archivador", "planta", "lampara", "alfombra", "sillon"],
  },
  oficina: {
    // Sala común con puestos: aquí tienen su escritorio asignado los agentes nuevos.
    kind: "oficina",
    label: "Oficina compartida",
    keywords: ["compartid", "coworking"],
    // Estilo actual: microcemento claro, blanco puro y muebles modernos.
    style: { floor: "hormigón", floorA: "#d9d6cf", floorB: "#cfccc4", wall: "#f7f7f5", wallTrim: "#3a3f45" },
    kinds: [
      "puesto_moderno",
      "puesto_moderno",
      "puesto_moderno",
      "puesto_moderno",
      "monitor_doble",
      "portatil",
      "ventana",
      "ventana",
      "videowall",
      "reloj",
      "estanteria_moderna",
      "cafetera",
      "planta_moderna",
      "planta_moderna",
      "lampara_arco",
    ],
    tints: { ventana: { $marco: "#2a2e35" }, reloj: { $esfera: "#ffffff" }, cafetera: { $mueble: "#f3f3f0", $maquina: "#2b2f36" } },
  },
  finanzas: {
    kind: "finanzas",
    label: "Oficina de finanzas",
    keywords: ["finanz", "dinero", "presupuesto", "gasto", "ahorro", "banco", "inversi", "factura", "contab", "econom", "cuenta", "nomina"],
    style: { floor: "baldosa", floorA: "#cfd6cf", floorB: "#b9c3ba", wall: "#e8e6dc", wallTrim: "#46624f" },
    kinds: ["puesto", "calculadora", "ordenador", "hucha", "pizarra", "reloj", "ventana", "archivador", "archivador", "caja_fuerte", "estanteria", "planta", "sillon"],
  },
  biblioteca: {
    kind: "biblioteca",
    label: "Biblioteca",
    keywords: ["aprend", "libro", "lectura", "leer", "curso", "idioma", "estudi", "formacion", "conocimiento", "investig", "escrib"],
    style: { floor: "madera", floorA: "#8a5a3b", floorB: "#7c5034", wall: "#e9dfc9", wallTrim: "#4e3626" },
    kinds: ["puesto", "libros_pila", "lampara_mesa", "estanteria", "estanteria", "estanteria", "mapa", "ventana", "globo", "sillon", "alfombra", "lampara", "planta"],
  },
  cocina: {
    kind: "cocina",
    label: "Cocina",
    keywords: ["cocin", "receta", "comida", "dieta", "nutric", "menu", "compra", "aliment", "super"],
    style: { floor: "baldosa", floorA: "#e9e4d8", floorB: "#c9b99a", wall: "#f3ead6", wallTrim: "#a0522d" },
    kinds: ["nevera", "cocina", "mesa_comedor", "silla", "silla", "ventana", "reloj", "cuadro", "planta", "cafetera"],
  },
  salud: {
    kind: "salud",
    label: "Gimnasio",
    keywords: ["salud", "deporte", "gimnas", "ejercicio", "entren", "habito", "medic", "bienestar", "sueno", "yoga", "correr", "peso"],
    style: { floor: "moqueta", floorA: "#5d7f8f", floorB: "#557686", wall: "#e3eef0", wallTrim: "#2f5d62" },
    kinds: ["cinta", "pesas", "esterilla", "esterilla", "botiquin", "ventana", "reloj", "planta", "planta", "sillon"],
  },
  agenda: {
    kind: "agenda",
    label: "Oficina de agenda",
    keywords: ["agenda", "calendario", "cita", "horario", "planific", "tarea", "organiz", "tiempo", "recordatorio", "evento"],
    style: { floor: "madera", floorA: "#b98a5a", floorB: "#a87b4e", wall: "#e6e1f0", wallTrim: "#5e4b8b" },
    kinds: ["puesto", "ordenador", "calendario_pared", "reloj", "corcho", "archivador", "planta", "alfombra", "sillon"],
  },
  tramites: {
    kind: "tramites",
    label: "Archivo de trámites",
    keywords: ["tramite", "papeleo", "documento", "administra", "burocra", "seguro", "hacienda", "gestion", "renov", "certific", "legal"],
    style: { floor: "baldosa", floorA: "#d8d3c4", floorB: "#c4bda9", wall: "#ece6d6", wallTrim: "#6d5d3f" },
    kinds: ["puesto", "impresora", "corcho", "calendario_pared", "archivador", "archivador", "archivador", "cajas", "cajas", "planta"],
  },
  proyectos: {
    kind: "proyectos",
    label: "Taller de proyectos",
    keywords: ["proyecto", "trabajo", "negocio", "idea", "creativ", "desarroll", "program", "emprend", "startup", "diseno"],
    style: { floor: "mármol", floorA: "#d5d8dc", floorB: "#c3c7cc", wall: "#e8edf2", wallTrim: "#34495e" },
    kinds: ["puesto", "ordenador", "pizarra", "corcho", "mesa_comedor", "silla", "estanteria", "lampara", "planta"],
  },
  viajes: {
    kind: "viajes",
    label: "Agencia de viajes",
    keywords: ["viaje", "vacacion", "turismo", "vuelo", "hotel", "escapada", "ruta"],
    style: { floor: "moqueta", floorA: "#d9b77e", floorB: "#cfac72", wall: "#e8f4f8", wallTrim: "#1f6f8b" },
    kinds: ["puesto", "ordenador", "mapa", "ventana", "globo", "sillon", "cajas", "planta", "alfombra"],
  },
  hogar: {
    kind: "hogar",
    label: "Salita del hogar",
    keywords: ["hogar", "casa", "limpieza", "mantenimiento", "planta", "jardin", "mascota", "familia", "ocio", "pelicula", "serie"],
    style: { floor: "moqueta", floorA: "#a9746e", floorB: "#9f6b65", wall: "#f2e6dc", wallTrim: "#7b4b3a" },
    kinds: ["sofa", "tele", "mesita", "alfombra", "ventana", "cuadro", "planta", "planta", "lampara"],
  },

  // ───────────── Planta de marketing (planta 2 de la torre, se sube en ascensor) ─────────────
  marketing_recepcion: {
    kind: "marketing_recepcion",
    label: "Recepción de marketing",
    keywords: ["recepcion", "vestibulo", "ascensor", "entrada", "hall"],
    building: "marketing",
    style: { floor: "hormigón", floorA: "#d9d6cf", floorB: "#cfccc4", wall: "#dfe6df", wallTrim: "#2f4a3a" },
    kinds: ["ascensor", "sofa_modular", "mesa_centro", "alfombra_moderna", "videowall", "neon", "arte_abstracto", "planta_moderna", "planta_moderna", "lampara_arco", "cafetera"],
    tints: { neon: { $luz: "#ff4fd8" }, cafetera: { $mueble: "#f3f3f0", $maquina: "#2b2f36" } },
  },
  despacho_marketing: {
    kind: "despacho_marketing",
    label: "Despacho de marketing",
    keywords: ["despacho", "redes", "social", "copy", "contenido", "seo", "marca", "anuncio", "campana", "community", "comunicacion", "influencer"],
    building: "marketing",
    style: { floor: "madera", floorA: "#dcc39c", floorB: "#d2b88f", wall: "#f7f7f5", wallTrim: "#3a3f45" },
    kinds: ["puesto_moderno", "monitor_doble", "portatil", "ventana", "arte_abstracto", "panel_listones", "estanteria_moderna", "planta_moderna", "lampara_arco", "alfombra_moderna"],
    tints: { ventana: { $marco: "#2a2e35" } },
  },
  marketing_abierta: {
    kind: "marketing_abierta",
    label: "Sala creativa",
    keywords: ["reunion", "creativ", "brainstorm", "abierta", "coworking", "marketing"],
    building: "marketing",
    style: { floor: "mármol", floorA: "#ecebe7", floorB: "#dcdbd6", wall: "#cfd3d8", wallTrim: "#2a2e35" },
    kinds: ["mesa_comedor", "silla_ergonomica", "silla_ergonomica", "corcho", "videowall", "pizarra", "estanteria_moderna", "planta_moderna", "planta_moderna", "cafetera", "neon"],
    tints: { mesa_comedor: { $madera: "#f3f3f0" }, neon: { $luz: "#ff4fd8" }, cafetera: { $mueble: "#f3f3f0", $maquina: "#2b2f36" } },
  },
  // ───────────── Torre de oficinas (plantas por unidad) ─────────────
  // Plantillas genéricas: no pertenecen a ninguna zona, se piden expresamente
  // al montar una planta (todas las plantas tienen la misma huella de 3×2 salas).
  recepcion_vestibulo: {
    kind: "recepcion_vestibulo",
    label: "Recepción",
    keywords: [],
    building: "torre",
    style: { floor: "mármol", floorA: "#ecebe7", floorB: "#dcdbd6", wall: "#f7f7f5", wallTrim: "#3a3f45" },
    kinds: ["ascensor", "puesto_moderno", "pantalla_led", "sofa_modular", "mesa_centro", "alfombra_moderna", "arte_abstracto", "planta_moderna", "planta_moderna", "lampara_arco"],
    tints: { mesa_centro: { $madera: "#3b2a20" } },
  },
  sala_espera: {
    kind: "sala_espera",
    label: "Sala de espera",
    keywords: [],
    building: "torre",
    style: { floor: "mármol", floorA: "#d5d8dc", floorB: "#c3c7cc", wall: "#e8e6dc", wallTrim: "#46624f" },
    kinds: ["sofa_modular", "sofa_modular", "mesa_centro", "alfombra_moderna", "tele", "ventana", "planta_moderna", "planta_moderna", "lampara_arco", "arte_abstracto"],
  },
  recepcion_planta: {
    kind: "recepcion_planta",
    label: "Recepción de planta",
    keywords: [],
    building: "torre",
    style: { floor: "hormigón", floorA: "#d9d6cf", floorB: "#cfccc4", wall: "#e8edf2", wallTrim: "#34495e" },
    kinds: ["ascensor", "sofa_modular", "mesa_centro", "alfombra_moderna", "arte_abstracto", "planta_moderna", "planta_moderna", "lampara_arco", "reloj"],
  },
  oficina_abierta: {
    kind: "oficina_abierta",
    label: "Oficina abierta",
    keywords: [],
    building: "torre",
    style: { floor: "madera", floorA: "#dcc39c", floorB: "#d2b88f", wall: "#f7f7f5", wallTrim: "#3a3f45" },
    kinds: ["puesto_moderno", "puesto_moderno", "puesto_moderno", "puesto_moderno", "monitor_doble", "portatil", "ventana", "ventana", "estanteria_moderna", "planta_moderna", "reloj"],
    tints: { ventana: { $marco: "#2a2e35" } },
  },
  despacho_responsable: {
    kind: "despacho_responsable",
    label: "Despacho",
    keywords: [],
    building: "torre",
    style: { floor: "madera", floorA: "#8a5a3b", floorB: "#7c5034", wall: "#ece6d6", wallTrim: "#6d5d3f" },
    kinds: ["puesto_moderno", "monitor_doble", "ventana", "ventana", "sofa_modular", "mesa_centro", "estanteria_moderna", "panel_listones", "lampara_arco", "alfombra_moderna", "planta_moderna"],
    tints: { ventana: { $marco: "#2a2e35" } },
  },
  sala_reuniones: {
    kind: "sala_reuniones",
    label: "Sala de reuniones",
    keywords: [],
    building: "torre",
    style: { floor: "moqueta", floorA: "#9a9a9e", floorB: "#8f8f94", wall: "#dfe3e8", wallTrim: "#5d6875" },
    kinds: ["mesa_comedor", "silla_ergonomica", "silla_ergonomica", "silla_ergonomica", "silla_ergonomica", "pantalla_led", "pizarra", "ventana", "planta_moderna", "reloj"],
    tints: { mesa_comedor: { $madera: "#3b2a20" } },
  },
  zona_cafe: {
    kind: "zona_cafe",
    label: "Office",
    keywords: [],
    building: "torre",
    style: { floor: "baldosa", floorA: "#e9e4d8", floorB: "#c9b99a", wall: "#f2efe8", wallTrim: "#8a7f6e" },
    kinds: ["cafetera", "nevera", "mesa_comedor", "silla", "silla", "ventana", "planta_moderna", "corcho", "taza"],
  },
  biblioteca_juridica: {
    kind: "biblioteca_juridica",
    label: "Biblioteca jurídica",
    keywords: [],
    building: "torre",
    style: { floor: "madera", floorA: "#8a5a3b", floorB: "#7c5034", wall: "#e9dfc9", wallTrim: "#4e3626" },
    kinds: ["estanteria", "estanteria", "estanteria", "libros_pila", "puesto", "lampara_mesa", "sillon", "sillon", "archivador", "alfombra", "lampara"],
  },
  sala_pantallas: {
    kind: "sala_pantallas",
    label: "Sala de pantallas",
    keywords: [],
    building: "torre",
    style: { floor: "mármol", floorA: "#4a4d52", floorB: "#414449", wall: "#cfd3d8", wallTrim: "#2a2e35" },
    kinds: ["videowall", "videowall", "pantalla_led", "puesto_moderno", "puesto_moderno", "monitor_doble", "monitor_doble", "cajas", "planta_moderna"],
  },
  estudio_diseno: {
    kind: "estudio_diseno",
    label: "Estudio de diseño",
    keywords: [],
    building: "torre",
    style: { floor: "hormigón", floorA: "#b5b5b0", floorB: "#a8a8a3", wall: "#f7f7f5", wallTrim: "#3a3f45" },
    kinds: ["mesa_comedor", "silla_ergonomica", "silla_ergonomica", "monitor_doble", "corcho", "pizarra", "arte_abstracto", "neon", "estanteria_moderna", "planta_moderna"],
    tints: { mesa_comedor: { $madera: "#f3f3f0" }, neon: { $luz: "#e8b04a" } },
  },
  laboratorio_producto: {
    kind: "laboratorio_producto",
    label: "Laboratorio de producto",
    keywords: [],
    building: "torre",
    style: { floor: "hormigón", floorA: "#d9d6cf", floorB: "#cfccc4", wall: "#e3eef0", wallTrim: "#2f5d62" },
    kinds: ["cinta", "esterilla", "pantalla_led", "puesto_moderno", "monitor_doble", "portatil", "corcho", "planta_moderna"],
  },
  sala_juntas: {
    kind: "sala_juntas",
    label: "Sala de juntas",
    keywords: [],
    building: "torre",
    style: { floor: "madera", floorA: "#8a5a3b", floorB: "#7c5034", wall: "#e6dccb", wallTrim: "#6b5440" },
    kinds: ["mesa_comedor", "silla_ergonomica", "silla_ergonomica", "silla_ergonomica", "silla_ergonomica", "silla_ergonomica", "silla_ergonomica", "videowall", "ventana", "ventana", "planta_moderna"],
    tints: { mesa_comedor: { $madera: "#3b2a20" }, ventana: { $marco: "#2a2e35" } },
  },
  despacho_direccion: {
    kind: "despacho_direccion",
    label: "Despacho de dirección",
    keywords: [],
    building: "torre",
    style: { floor: "madera", floorA: "#8a5a3b", floorB: "#7c5034", wall: "#e9dfc9", wallTrim: "#4e3626" },
    kinds: ["escritorio_moderno", "silla_ergonomica", "monitor_doble", "ventana", "ventana", "ventana", "sofa_modular", "mesa_centro", "estanteria_moderna", "caja_fuerte", "lampara_arco", "alfombra_moderna", "arte_abstracto", "planta_moderna"],
    tints: { ventana: { $marco: "#2a2e35" } },
  },
};

/**
 * Dónde se asignan escritorios a los agentes nuevos, por edificio: plantillas
 * de sala común con puestos (por orden de preferencia), el puesto que se añade
 * si no hay hueco y la plantilla de la oficina que se abre si no hay ninguna.
 */
export const DESK_ROOMS: Record<string, { kinds: string[]; desk: string; office: string }> = {
  orden: { kinds: ["oficina"], desk: "puesto_moderno", office: "oficina" },
};

/** Escritorios de una zona: los suyos o, en las plantas de la torre, la oficina abierta. */
export function deskRoomsFor(building: string): { kinds: string[]; desk: string; office: string } {
  return DESK_ROOMS[building] ?? { kinds: ["oficina_abierta", "oficina"], desk: "puesto_moderno", office: "oficina_abierta" };
}

function normalize(text: string) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

/** Aplica los colores de la plantilla a los muebles que no traen los suyos. */
export function applyTemplateTints<T extends { kind: string; tint?: Record<string, string> }>(items: T[], tpl: RoomTemplate | undefined): T[] {
  if (!tpl?.tints) return items;
  return items.map((it) => (it.tint || !tpl.tints![it.kind] ? it : { ...it, tint: { ...tpl.tints![it.kind] } }));
}

/** Elige la plantilla de sala que mejor encaja con una especialidad o ámbito, dentro de un edificio. */
export function pickRoomTemplate(specialty: string, building = DEFAULT_BUILDING): RoomTemplate {
  const text = normalize(specialty);
  let best: RoomTemplate | null = null;
  let bestScore = 0;
  for (const tpl of Object.values(ROOM_TEMPLATES)) {
    if (!tpl.kinds || (tpl.building ?? DEFAULT_BUILDING) !== building) continue;
    const score = tpl.keywords.filter((k) => text.includes(k)).length;
    if (score > bestScore) {
      best = tpl;
      bestScore = score;
    }
  }
  return best ?? ROOM_TEMPLATES[BUILDINGS[building]?.fallback ?? "estudio"] ?? ROOM_TEMPLATES.estudio;
}
