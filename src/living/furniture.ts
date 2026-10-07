/**
 * Catálogo de muebles originales. Cada mueble se describe como un conjunto de
 * cajas en coordenadas del mundo (1 baldosa = 16 unidades en x/y; z en
 * píxeles) y se rasteriza en pixel art con sombreado por caras.
 *
 * Es datos puros: lo usan el living (render) y la lógica de la casa (huella).
 */

export interface Box {
  x: number;
  y: number;
  z: number;
  w: number;
  d: number;
  h: number;
  /** Color base o clave de tinte ("$madera"). */
  c: string;
  /** Color de la cara superior, si difiere. */
  top?: string;
}

export interface FurnitureDef {
  label: string;
  /** Huella en baldosas (ancho en x, fondo en y). */
  w: number;
  d: number;
  /** Se puede pisar (alfombras). */
  walkable?: boolean;
  /** Asiento: el agente se sienta encima mirando hacia `face`. */
  seat?: { face: "x" | "y" | "-x" | "-y"; z: number };
  /** Cama o cojín para dormir. */
  bed?: boolean;
  /** Superficie de trabajo (escritorio). */
  desk?: boolean;
  /** Altura de la superficie (para poner objetos encima). */
  surface?: number;
  /** Adorno de pared: se dibuja en la pared norte (y=0) o oeste (x=0). */
  wall?: boolean;
  /** Objeto pequeño que va encima de otro (z del item = altura de la superficie). */
  onTop?: boolean;
  /** Mueble alto: el decorador lo arrima a las paredes del fondo. */
  tall?: boolean;
  /**
   * Se entra por delante (ascensor): sin girar, por el sur; girado, por el
   * este. El decorador lo pone de espaldas al muro y deja libre esa franja.
   */
  entrance?: boolean;
  /** Colores por defecto de las claves de tinte. */
  tints?: Record<string, string>;
  boxes: Box[];
}

const T = 16;

function books(x: number, y: number, z: number, n: number, axis: "x" | "y", colors: string[]): Box[] {
  const out: Box[] = [];
  let off = 0;
  for (let i = 0; i < n; i++) {
    const thick = 2 + (i % 2);
    const h = 7 + ((i * 5) % 4);
    const c = colors[i % colors.length];
    out.push(axis === "x" ? { x: x + off, y, z, w: thick, d: 6, h, c } : { x, y: y + off, z, w: 6, d: thick, h, c });
    off += thick;
  }
  return out;
}

const BOOK_COLORS = ["#a33a3a", "#3a6ea3", "#d9a441", "#4f8a4f", "#7a4fa3", "#c96f3a", "#2f5f6f"];

export const FURNITURE: Record<string, FurnitureDef> = {
  escritorio: {
    label: "Escritorio",
    w: 2,
    d: 1,
    desk: true,
    surface: 17,
    tints: { $tablero: "#8b5a35", $patas: "#5e3b22" },
    boxes: [
      { x: 1, y: 2, z: 0, w: 2, d: 2, h: 14, c: "$patas" },
      { x: 29, y: 2, z: 0, w: 2, d: 2, h: 14, c: "$patas" },
      { x: 1, y: 12, z: 0, w: 2, d: 2, h: 14, c: "$patas" },
      { x: 29, y: 12, z: 0, w: 2, d: 2, h: 14, c: "$patas" },
      { x: 18, y: 3, z: 4, w: 11, d: 10, h: 10, c: "$patas" },
      { x: 0, y: 1, z: 14, w: 32, d: 14, h: 3, c: "$tablero" },
    ],
  },
  silla: {
    label: "Silla",
    w: 1,
    d: 1,
    seat: { face: "x", z: 9 },
    tints: { $asiento: "#c0392b", $patas: "#3d3d3d" },
    boxes: [
      { x: 7, y: 7, z: 0, w: 2, d: 2, h: 7, c: "$patas" },
      { x: 3, y: 4, z: 7, w: 10, d: 9, h: 3, c: "$asiento" },
      { x: 2, y: 3, z: 7, w: 2, d: 11, h: 14, c: "$asiento" },
    ],
  },
  sillon: {
    label: "Sillón",
    w: 1,
    d: 1,
    seat: { face: "x", z: 8 },
    tints: { $tela: "#5b7f95" },
    boxes: [
      { x: 1, y: 1, z: 0, w: 14, d: 14, h: 8, c: "$tela" },
      { x: 1, y: 1, z: 8, w: 4, d: 14, h: 10, c: "$tela" },
      { x: 5, y: 1, z: 8, w: 10, d: 3, h: 6, c: "$tela" },
      { x: 5, y: 12, z: 8, w: 10, d: 3, h: 6, c: "$tela" },
    ],
  },
  sofa: {
    label: "Sofá",
    w: 1,
    d: 2,
    seat: { face: "x", z: 8 },
    tints: { $tela: "#8e5a9b" },
    boxes: [
      { x: 1, y: 1, z: 0, w: 14, d: 30, h: 8, c: "$tela" },
      { x: 1, y: 1, z: 8, w: 4, d: 30, h: 10, c: "$tela" },
      { x: 5, y: 1, z: 8, w: 10, d: 3, h: 5, c: "$tela" },
      { x: 5, y: 28, z: 8, w: 10, d: 3, h: 5, c: "$tela" },
    ],
  },
  estanteria: {
    label: "Estantería",
    w: 1,
    d: 2,
    tints: { $madera: "#6b4226" },
    boxes: [
      { x: 0, y: 0, z: 0, w: 7, d: 32, h: 2, c: "$madera" },
      { x: 0, y: 0, z: 14, w: 7, d: 32, h: 2, c: "$madera" },
      { x: 0, y: 0, z: 28, w: 7, d: 32, h: 2, c: "$madera" },
      { x: 0, y: 0, z: 42, w: 7, d: 32, h: 2, c: "$madera" },
      { x: 0, y: 0, z: 0, w: 1, d: 32, h: 44, c: "$madera" },
      { x: 0, y: 0, z: 0, w: 7, d: 1, h: 44, c: "$madera" },
      { x: 0, y: 31, z: 0, w: 7, d: 1, h: 44, c: "$madera" },
      ...books(1, 1, 2, 12, "y", BOOK_COLORS),
      ...books(1, 2, 16, 11, "y", BOOK_COLORS.slice(2).concat(BOOK_COLORS)),
      ...books(1, 3, 30, 10, "y", BOOK_COLORS.slice(4).concat(BOOK_COLORS)),
    ],
  },
  planta: {
    label: "Planta",
    w: 1,
    d: 1,
    tints: { $maceta: "#c4693d", $hoja: "#3f8f4a" },
    boxes: [
      { x: 4, y: 4, z: 0, w: 8, d: 8, h: 8, c: "$maceta" },
      { x: 5, y: 5, z: 8, w: 6, d: 6, h: 1, c: "#4a3020" },
      { x: 7, y: 7, z: 8, w: 2, d: 2, h: 8, c: "#5b4025" },
      { x: 3, y: 4, z: 14, w: 10, d: 8, h: 6, c: "$hoja" },
      { x: 4, y: 3, z: 18, w: 8, d: 10, h: 6, c: "$hoja" },
      { x: 5, y: 5, z: 23, w: 6, d: 6, h: 5, c: "$hoja" },
      { x: 6, y: 6, z: 27, w: 4, d: 4, h: 3, c: "#5fb36a" },
    ],
  },
  bonsai: {
    label: "Bonsái",
    w: 1,
    d: 1,
    tints: { $mesa: "#3b2a20", $hoja: "#4c9a52" },
    boxes: [
      { x: 2, y: 2, z: 0, w: 12, d: 12, h: 2, c: "$mesa" },
      { x: 3, y: 3, z: 2, w: 2, d: 2, h: 8, c: "$mesa" },
      { x: 11, y: 11, z: 2, w: 2, d: 2, h: 8, c: "$mesa" },
      { x: 3, y: 11, z: 2, w: 2, d: 2, h: 8, c: "$mesa" },
      { x: 11, y: 3, z: 2, w: 2, d: 2, h: 8, c: "$mesa" },
      { x: 2, y: 2, z: 10, w: 12, d: 12, h: 2, c: "$mesa" },
      { x: 5, y: 5, z: 12, w: 6, d: 6, h: 3, c: "#2f5f6f" },
      { x: 7, y: 7, z: 15, w: 2, d: 2, h: 5, c: "#5b4025" },
      { x: 8, y: 6, z: 19, w: 4, d: 2, h: 2, c: "#5b4025" },
      { x: 4, y: 5, z: 19, w: 6, d: 6, h: 4, c: "$hoja" },
      { x: 9, y: 4, z: 21, w: 5, d: 5, h: 3, c: "$hoja" },
      { x: 6, y: 7, z: 23, w: 4, d: 4, h: 2, c: "#6cbf73" },
    ],
  },
  alfombra: {
    label: "Alfombra",
    w: 3,
    d: 2,
    walkable: true,
    tints: { $borde: "#7b2d26", $centro: "#c8553d" },
    boxes: [
      { x: 2, y: 2, z: 0, w: 44, d: 28, h: 1, c: "$borde" },
      { x: 5, y: 5, z: 1, w: 38, d: 22, h: 0.01, c: "$centro" },
    ],
  },
  tatami: {
    label: "Tatami",
    w: 3,
    d: 3,
    walkable: true,
    tints: { $paja: "#c9c47c", $borde: "#3e5a3a" },
    boxes: [
      { x: 1, y: 1, z: 0, w: 46, d: 46, h: 1, c: "$borde" },
      { x: 3, y: 3, z: 1, w: 42, d: 20, h: 0.01, c: "$paja" },
      { x: 3, y: 25, z: 1, w: 42, d: 20, h: 0.01, c: "$paja" },
    ],
  },
  cojin: {
    label: "Cojín de meditación",
    w: 1,
    d: 1,
    seat: { face: "x", z: 5 },
    bed: true,
    tints: { $tela: "#2e4a62" },
    boxes: [
      { x: 2, y: 2, z: 0, w: 12, d: 12, h: 3, c: "$tela" },
      { x: 3, y: 3, z: 3, w: 10, d: 10, h: 2, c: "#3d6282" },
    ],
  },
  jardin_zen: {
    label: "Jardín zen",
    w: 2,
    d: 2,
    tints: { $marco: "#4a3426", $arena: "#e8dcc0" },
    boxes: [
      { x: 1, y: 1, z: 0, w: 30, d: 30, h: 5, c: "$marco" },
      { x: 3, y: 3, z: 5, w: 26, d: 26, h: 0.01, c: "$arena", top: "$arena" },
      { x: 3, y: 9, z: 5, w: 26, d: 1, h: 0.02, c: "#d2c4a3" },
      { x: 3, y: 15, z: 5, w: 26, d: 1, h: 0.02, c: "#d2c4a3" },
      { x: 3, y: 21, z: 5, w: 26, d: 1, h: 0.02, c: "#d2c4a3" },
      { x: 8, y: 7, z: 5, w: 5, d: 4, h: 4, c: "#7d7d7d" },
      { x: 19, y: 17, z: 5, w: 6, d: 5, h: 5, c: "#6a6a6a" },
      { x: 21, y: 6, z: 5, w: 3, d: 3, h: 2, c: "#8d8d8d" },
    ],
  },
  lampara: {
    label: "Lámpara de pie",
    w: 1,
    d: 1,
    tints: { $pantalla: "#f2d27a", $pie: "#2f2f2f" },
    boxes: [
      { x: 5, y: 5, z: 0, w: 6, d: 6, h: 2, c: "$pie" },
      { x: 7, y: 7, z: 2, w: 2, d: 2, h: 30, c: "$pie" },
      { x: 3, y: 3, z: 30, w: 10, d: 10, h: 10, c: "$pantalla", top: "#fff3c4" },
    ],
  },
  farol: {
    label: "Farol de papel",
    w: 1,
    d: 1,
    tints: { $papel: "#f6ead0", $madera: "#3b2a20" },
    boxes: [
      { x: 4, y: 4, z: 0, w: 8, d: 8, h: 2, c: "$madera" },
      { x: 5, y: 5, z: 2, w: 6, d: 6, h: 16, c: "$papel", top: "#fffbe8" },
      { x: 4, y: 4, z: 18, w: 8, d: 8, h: 2, c: "$madera" },
    ],
  },
  ordenador: {
    onTop: true,
    label: "Ordenador",
    w: 1,
    d: 1,
    tints: { $carcasa: "#d9d9d9", $pantalla: "#3fa7d6" },
    boxes: [
      { x: 6, y: 5, z: 0, w: 4, d: 4, h: 2, c: "$carcasa" },
      { x: 7, y: 6, z: 2, w: 2, d: 2, h: 4, c: "$carcasa" },
      { x: 3, y: 2, z: 5, w: 4, d: 12, h: 10, c: "$carcasa" },
      { x: 7, y: 3, z: 6, w: 0.6, d: 10, h: 8, c: "$pantalla" },
      { x: 9, y: 3, z: 0, w: 5, d: 10, h: 1, c: "#3a3a3a" },
    ],
  },
  calculadora: {
    onTop: true,
    label: "Calculadora",
    w: 1,
    d: 1,
    tints: { $cuerpo: "#2d2d2d" },
    boxes: [
      { x: 4, y: 4, z: 0, w: 8, d: 6, h: 2, c: "$cuerpo" },
      { x: 4, y: 4, z: 2, w: 3, d: 6, h: 0.01, c: "#9bc59d" },
      { x: 8, y: 5, z: 2, w: 3, d: 4, h: 0.01, c: "#e0e0e0" },
    ],
  },
  taza: {
    onTop: true,
    label: "Taza de té",
    w: 1,
    d: 1,
    tints: { $taza: "#f0ebe3" },
    boxes: [
      { x: 6, y: 6, z: 0, w: 4, d: 4, h: 4, c: "$taza", top: "#7a9a3a" },
      { x: 10, y: 7, z: 1, w: 1, d: 2, h: 2, c: "$taza" },
    ],
  },
  mesita: {
    label: "Mesita baja",
    w: 2,
    d: 1,
    desk: true,
    surface: 10,
    tints: { $madera: "#6b4226" },
    boxes: [
      { x: 2, y: 2, z: 0, w: 3, d: 3, h: 7, c: "$madera" },
      { x: 27, y: 2, z: 0, w: 3, d: 3, h: 7, c: "$madera" },
      { x: 2, y: 11, z: 0, w: 3, d: 3, h: 7, c: "$madera" },
      { x: 27, y: 11, z: 0, w: 3, d: 3, h: 7, c: "$madera" },
      { x: 1, y: 1, z: 7, w: 30, d: 14, h: 3, c: "$madera" },
    ],
  },
  cafetera: {
    label: "Mueble con cafetera",
    w: 1,
    d: 1,
    tints: { $mueble: "#e3ded4", $maquina: "#b33a3a" },
    boxes: [
      { x: 0, y: 1, z: 0, w: 14, d: 14, h: 18, c: "$mueble" },
      { x: 2, y: 4, z: 18, w: 7, d: 8, h: 11, c: "$maquina" },
      { x: 9, y: 6, z: 18, w: 3, d: 3, h: 3, c: "#f5f5f5", top: "#4a2c1a" },
    ],
  },
  archivador: {
    label: "Archivador",
    w: 1,
    d: 1,
    tints: { $metal: "#8796a5" },
    boxes: [
      { x: 0, y: 2, z: 0, w: 12, d: 12, h: 30, c: "$metal" },
      { x: 12, y: 5, z: 22, w: 0.6, d: 6, h: 2, c: "#3d4752" },
      { x: 12, y: 5, z: 12, w: 0.6, d: 6, h: 2, c: "#3d4752" },
      { x: 12, y: 5, z: 3, w: 0.6, d: 6, h: 2, c: "#3d4752" },
    ],
  },
  pizarra: {
    label: "Pizarra",
    w: 2,
    d: 1,
    wall: true,
    tints: { $marco: "#7a6a58", $fondo: "#f4f4f0" },
    boxes: [
      { x: 2, y: 0, z: 20, w: 28, d: 2, h: 22, c: "$marco" },
      { x: 3, y: 2, z: 21, w: 26, d: 0.5, h: 20, c: "$fondo" },
      { x: 6, y: 2.5, z: 34, w: 12, d: 0.3, h: 1, c: "#3a6ea3" },
      { x: 6, y: 2.5, z: 30, w: 16, d: 0.3, h: 1, c: "#a33a3a" },
      { x: 6, y: 2.5, z: 26, w: 9, d: 0.3, h: 1, c: "#4f8a4f" },
    ],
  },
  ventana: {
    label: "Ventana",
    w: 2,
    d: 1,
    wall: true,
    tints: { $marco: "#f2efe8", $cielo: "#9fd3f0" },
    boxes: [
      { x: 3, y: 0, z: 18, w: 26, d: 2, h: 28, c: "$marco" },
      { x: 5, y: 2, z: 20, w: 10, d: 0.5, h: 24, c: "$cielo" },
      { x: 17, y: 2, z: 20, w: 10, d: 0.5, h: 24, c: "$cielo" },
      { x: 5, y: 2.5, z: 36, w: 4, d: 0.3, h: 6, c: "#d4eefb" },
      { x: 2, y: 0, z: 16, w: 28, d: 4, h: 2, c: "$marco" },
    ],
  },
  cuadro: {
    label: "Cuadro",
    w: 1,
    d: 1,
    wall: true,
    tints: { $marco: "#3b2a20", $lienzo: "#e9e2cf" },
    boxes: [
      { x: 2, y: 0, z: 26, w: 12, d: 1.5, h: 14, c: "$marco" },
      { x: 3, y: 1.5, z: 27, w: 10, d: 0.5, h: 12, c: "$lienzo" },
      { x: 5, y: 2, z: 29, w: 6, d: 0.2, h: 6, c: "#c0392b" },
    ],
  },
  reloj: {
    label: "Reloj",
    w: 1,
    d: 1,
    wall: true,
    tints: { $esfera: "#f8f5ec" },
    boxes: [
      { x: 4, y: 0, z: 32, w: 8, d: 1.5, h: 8, c: "#3b2a20" },
      { x: 5, y: 1.5, z: 33, w: 6, d: 0.5, h: 6, c: "$esfera" },
      { x: 8, y: 2, z: 36, w: 1, d: 0.2, h: 3, c: "#222" },
    ],
  },
  caligrafia: {
    label: "Caligrafía",
    w: 1,
    d: 1,
    wall: true,
    tints: { $papel: "#f3ecd8" },
    boxes: [
      { x: 4, y: 0, z: 14, w: 8, d: 1, h: 32, c: "$papel" },
      { x: 3, y: 0, z: 45, w: 10, d: 1.5, h: 1.5, c: "#3b2a20" },
      { x: 6, y: 1, z: 36, w: 4, d: 0.2, h: 5, c: "#1d1d1d" },
      { x: 7, y: 1, z: 26, w: 2, d: 0.2, h: 7, c: "#1d1d1d" },
      { x: 6, y: 1, z: 20, w: 3, d: 0.2, h: 3, c: "#b03a2e" },
    ],
  },
};

// ───────────── Muebles por ámbito (fase 6) ─────────────

const BOX = "#c49a6c";

Object.assign(FURNITURE, {
  nevera: {
    label: "Nevera",
    w: 1,
    d: 1,
    tall: true,
    tints: { $cuerpo: "#e8eef0" },
    boxes: [
      { x: 1, y: 2, z: 0, w: 13, d: 12, h: 40, c: "$cuerpo" },
      { x: 14, y: 3, z: 26, w: 0.5, d: 10, h: 1, c: "#9aa7ad" },
      { x: 14, y: 4, z: 13, w: 0.8, d: 1.2, h: 9, c: "#8a959a" },
      { x: 14, y: 4, z: 29, w: 0.8, d: 1.2, h: 7, c: "#8a959a" },
    ],
  },
  cocina: {
    label: "Cocina y fregadero",
    w: 1,
    d: 2,
    tall: true,
    tints: { $mueble: "#d9cbb0", $encimera: "#5b5b5b" },
    boxes: [
      { x: 0, y: 0, z: 0, w: 14, d: 32, h: 18, c: "$mueble", top: "$encimera" },
      { x: 2, y: 2, z: 18, w: 4, d: 4, h: 0.6, c: "#222" },
      { x: 8, y: 2, z: 18, w: 4, d: 4, h: 0.6, c: "#222" },
      { x: 2, y: 8, z: 18, w: 4, d: 4, h: 0.6, c: "#222" },
      { x: 8, y: 8, z: 18, w: 4, d: 4, h: 0.6, c: "#222" },
      { x: 14, y: 2, z: 3, w: 0.6, d: 11, h: 11, c: "#2d2d2d" },
      { x: 2, y: 18, z: 17.6, w: 10, d: 11, h: 0.6, c: "#9fb4c0" },
      { x: 1, y: 22, z: 18, w: 2, d: 2, h: 8, c: "#b0b0b0" },
      { x: 3, y: 22, z: 24, w: 4, d: 2, h: 1.5, c: "#b0b0b0" },
      { x: 14, y: 18, z: 4, w: 0.6, d: 12, h: 10, c: "#c5b596" },
      { x: 0, y: 0, z: 34, w: 8, d: 32, h: 14, c: "$mueble" },
    ],
  },
  mesa_comedor: {
    label: "Mesa",
    w: 2,
    d: 2,
    desk: true,
    surface: 17,
    tints: { $madera: "#a0703c" },
    boxes: [
      { x: 4, y: 4, z: 0, w: 2, d: 2, h: 14, c: "$madera" },
      { x: 26, y: 4, z: 0, w: 2, d: 2, h: 14, c: "$madera" },
      { x: 4, y: 26, z: 0, w: 2, d: 2, h: 14, c: "$madera" },
      { x: 26, y: 26, z: 0, w: 2, d: 2, h: 14, c: "$madera" },
      { x: 2, y: 2, z: 14, w: 28, d: 28, h: 3, c: "$madera" },
    ],
  },
  pesas: {
    label: "Pesas",
    w: 1,
    d: 1,
    tints: { $rack: "#3d3d3d" },
    boxes: [
      { x: 2, y: 3, z: 0, w: 12, d: 10, h: 3, c: "$rack" },
      { x: 2, y: 3, z: 3, w: 2, d: 10, h: 12, c: "$rack" },
      { x: 3, y: 4, z: 3, w: 9, d: 3, h: 3, c: "#c0392b" },
      { x: 3, y: 9, z: 3, w: 9, d: 3, h: 3, c: "#2980b9" },
      { x: 3, y: 4, z: 9, w: 9, d: 3, h: 3, c: "#f39c12" },
      { x: 3, y: 9, z: 9, w: 9, d: 3, h: 3, c: "#27ae60" },
    ],
  },
  cinta: {
    label: "Cinta de correr",
    w: 1,
    d: 2,
    tints: { $base: "#3a3a3a" },
    boxes: [
      { x: 2, y: 2, z: 0, w: 12, d: 29, h: 5, c: "$base", top: "#1f1f1f" },
      { x: 3, y: 2, z: 5, w: 2, d: 2, h: 20, c: "#8c8c8c" },
      { x: 11, y: 2, z: 5, w: 2, d: 2, h: 20, c: "#8c8c8c" },
      { x: 2, y: 1, z: 24, w: 12, d: 5, h: 4, c: "#2c3e50", top: "#5dade2" },
    ],
  },
  esterilla: {
    label: "Esterilla",
    w: 1,
    d: 2,
    walkable: true,
    tints: { $tela: "#7fb069" },
    boxes: [{ x: 3, y: 1, z: 0, w: 10, d: 30, h: 1, c: "$tela" }],
  },
  corcho: {
    label: "Tablón de corcho",
    w: 2,
    d: 1,
    wall: true,
    boxes: [
      { x: 2, y: 0, z: 20, w: 28, d: 2, h: 22, c: "#8b5a2b" },
      { x: 3, y: 2, z: 21, w: 26, d: 0.5, h: 20, c: "#c89f6a" },
      { x: 5, y: 2.5, z: 32, w: 6, d: 0.3, h: 6, c: "#f7dc6f" },
      { x: 13, y: 2.5, z: 30, w: 6, d: 0.3, h: 8, c: "#f5b7b1" },
      { x: 21, y: 2.5, z: 33, w: 5, d: 0.3, h: 5, c: "#aed6f1" },
      { x: 8, y: 2.5, z: 23, w: 7, d: 0.3, h: 6, c: "#ffffff" },
      { x: 19, y: 2.5, z: 23, w: 6, d: 0.3, h: 6, c: "#abebc6" },
    ],
  },
  calendario_pared: {
    label: "Calendario de pared",
    w: 1,
    d: 1,
    wall: true,
    boxes: [
      { x: 3, y: 0, z: 20, w: 10, d: 1, h: 20, c: "#f8f8f4" },
      { x: 3, y: 0, z: 36, w: 10, d: 1.2, h: 4, c: "#c0392b" },
      ...[0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => ({ x: 4.5 + c * 3, y: 1.1, z: 23 + r * 4, w: 2, d: 0.2, h: 2, c: r === 1 && c === 1 ? "#c0392b" : "#7f8c8d" }))),
    ],
  },
  mapa: {
    label: "Mapa",
    w: 2,
    d: 1,
    wall: true,
    boxes: [
      { x: 2, y: 0, z: 22, w: 28, d: 1.5, h: 20, c: "#e8e0c8" },
      { x: 3, y: 1.5, z: 23, w: 26, d: 0.4, h: 18, c: "#7fb3d5" },
      { x: 5, y: 1.9, z: 30, w: 7, d: 0.3, h: 8, c: "#8fbf6f" },
      { x: 14, y: 1.9, z: 26, w: 5, d: 0.3, h: 12, c: "#8fbf6f" },
      { x: 21, y: 1.9, z: 31, w: 6, d: 0.3, h: 6, c: "#c9b26b" },
    ],
  },
  globo: {
    label: "Globo terráqueo",
    w: 1,
    d: 1,
    boxes: [
      { x: 5, y: 5, z: 0, w: 6, d: 6, h: 2, c: "#6b4226" },
      { x: 7.5, y: 7.5, z: 2, w: 1, d: 1, h: 10, c: "#6b4226" },
      { x: 5, y: 5, z: 12, w: 6, d: 6, h: 9, c: "#4a90c2" },
      { x: 4, y: 6, z: 14, w: 8, d: 4, h: 5, c: "#4a90c2" },
      { x: 6, y: 4, z: 14, w: 4, d: 8, h: 5, c: "#4a90c2" },
      { x: 9, y: 6, z: 16, w: 3, d: 3, h: 3, c: "#6aa84f" },
      { x: 5, y: 9, z: 14, w: 3, d: 3, h: 4, c: "#6aa84f" },
    ],
  },
  impresora: {
    label: "Impresora",
    w: 1,
    d: 1,
    onTop: true,
    boxes: [
      { x: 2, y: 3, z: 0, w: 12, d: 10, h: 6, c: "#e0e0e0" },
      { x: 4, y: 4, z: 6, w: 8, d: 8, h: 1, c: "#ffffff" },
      { x: 12, y: 5, z: 3, w: 1, d: 6, h: 1, c: "#333" },
    ],
  },
  caja_fuerte: {
    label: "Caja fuerte",
    w: 1,
    d: 1,
    boxes: [
      { x: 2, y: 2, z: 0, w: 12, d: 12, h: 15, c: "#4a4f55" },
      { x: 14, y: 4, z: 4, w: 0.6, d: 8, h: 8, c: "#5d636a" },
      { x: 14.4, y: 6.5, z: 6.5, w: 0.6, d: 3, h: 3, c: "#d4ac0d" },
    ],
  },
  hucha: {
    label: "Hucha",
    w: 1,
    d: 1,
    onTop: true,
    tints: { $rosa: "#f4a6b8" },
    boxes: [
      { x: 5, y: 5, z: 1, w: 7, d: 5, h: 5, c: "$rosa" },
      { x: 12, y: 6, z: 2, w: 1.5, d: 3, h: 2.5, c: "#e88aa1" },
      { x: 9, y: 5, z: 6, w: 1.5, d: 1.5, h: 1.5, c: "$rosa" },
      { x: 9, y: 8.5, z: 6, w: 1.5, d: 1.5, h: 1.5, c: "$rosa" },
      { x: 6, y: 5, z: 0, w: 1.5, d: 1.5, h: 1, c: "$rosa" },
      { x: 10, y: 8.5, z: 0, w: 1.5, d: 1.5, h: 1, c: "$rosa" },
    ],
  },
  tele: {
    label: "Televisión",
    w: 1,
    d: 2,
    tall: true,
    boxes: [
      { x: 1, y: 3, z: 0, w: 11, d: 26, h: 10, c: "#5a3d2b" },
      { x: 5, y: 2, z: 10, w: 2, d: 28, h: 18, c: "#1c1c1c" },
      { x: 7, y: 3, z: 11, w: 0.5, d: 26, h: 16, c: "#2b4f6f" },
      { x: 7.2, y: 5, z: 21, w: 0.3, d: 8, h: 4, c: "#5d8fb8" },
    ],
  },
  botiquin: {
    label: "Botiquín",
    w: 1,
    d: 1,
    wall: true,
    boxes: [
      { x: 4, y: 0, z: 24, w: 9, d: 3, h: 10, c: "#f4f4f4" },
      { x: 7.5, y: 3, z: 26, w: 2, d: 0.3, h: 6, c: "#d32f2f" },
      { x: 5.5, y: 3, z: 28, w: 6, d: 0.3, h: 2, c: "#d32f2f" },
    ],
  },
  cajas: {
    label: "Cajas",
    w: 1,
    d: 1,
    boxes: [
      { x: 1, y: 2, z: 0, w: 12, d: 11, h: 9, c: BOX },
      { x: 3, y: 3, z: 9, w: 9, d: 9, h: 8, c: "#b88a5c" },
      { x: 6.5, y: 3, z: 17, w: 2, d: 9, h: 0.4, c: "#d9c19a" },
    ],
  },
  lampara_mesa: {
    label: "Lámpara de mesa",
    w: 1,
    d: 1,
    onTop: true,
    boxes: [
      { x: 6, y: 6, z: 0, w: 4, d: 4, h: 1, c: "#333" },
      { x: 7.5, y: 7.5, z: 1, w: 1, d: 1, h: 7, c: "#333" },
      { x: 5, y: 5, z: 8, w: 6, d: 6, h: 5, c: "#f2d27a", top: "#fff3c4" },
    ],
  },
  libros_pila: {
    label: "Libros",
    w: 1,
    d: 1,
    onTop: true,
    boxes: [
      { x: 3, y: 4, z: 0, w: 9, d: 7, h: 2, c: "#a33a3a" },
      { x: 4, y: 4, z: 2, w: 8, d: 6, h: 2, c: "#3a6ea3" },
      { x: 3, y: 5, z: 4, w: 8, d: 6, h: 2, c: "#d9a441" },
    ],
  },
  medidor_claude: {
    label: "Medidor de límites de Claude",
    w: 1,
    d: 1,
    tall: true,
    tints: { $cuerpo: "#2b3442", $acento: "#e8b04a" },
    boxes: [
      { x: 2, y: 3, z: 0, w: 11, d: 10, h: 4, c: "#1d232c" },
      { x: 3, y: 4, z: 4, w: 9, d: 8, h: 30, c: "$cuerpo" },
      { x: 12, y: 5, z: 12, w: 0.6, d: 6, h: 19, c: "#0f1820" },
      { x: 12.6, y: 6, z: 27, w: 0.3, d: 4, h: 1.5, c: "#5ccf8a" },
      { x: 12.6, y: 6, z: 23, w: 0.3, d: 3, h: 1.5, c: "#f0b84a" },
      { x: 12.6, y: 6, z: 19, w: 0.3, d: 2, h: 1.5, c: "#6ba8ef" },
      { x: 12.6, y: 6, z: 14, w: 0.3, d: 1, h: 1, c: "$acento" },
      { x: 12.6, y: 8, z: 14, w: 0.3, d: 1, h: 1, c: "#3d4b5c" },
      { x: 12, y: 5, z: 6, w: 0.6, d: 6, h: 4, c: "#3d4b5c" },
      { x: 6, y: 7, z: 34, w: 2, d: 2, h: 6, c: "#3d4b5c" },
      { x: 5.5, y: 6.5, z: 40, w: 3, d: 3, h: 3, c: "$acento", top: "#ffd98a" },
    ],
  },
  holo_boton: {
    label: "Botón holograma (límites de Claude)",
    w: 1,
    d: 1,
    onTop: true,
    tints: { $luz: "#7fe8ff" },
    boxes: [
      { x: 4.5, y: 4.5, z: 0, w: 7, d: 7, h: 1.5, c: "#2b3442", top: "#3d4b5c" },
      { x: 6, y: 6, z: 1.5, w: 4, d: 4, h: 1, c: "#3aa7c9", top: "#c8f6ff" },
      { x: 7.5, y: 7.5, z: 2.5, w: 1, d: 1, h: 5, c: "$luz" },
      { x: 4, y: 7.6, z: 7.5, w: 8, d: 0.8, h: 7, c: "$luz", top: "#d9fbff" },
      { x: 5, y: 8.4, z: 12, w: 4, d: 0.2, h: 1, c: "#e9fdff" },
      { x: 5, y: 8.4, z: 10, w: 6, d: 0.2, h: 1, c: "#e9fdff" },
      { x: 5, y: 8.4, z: 8.5, w: 3, d: 0.2, h: 0.8, c: "#ffd98a" },
    ],
  },
} satisfies Record<string, FurnitureDef>);

// ───────────── Muebles modernos ─────────────
// Líneas finas, blanco y negro mate, roble claro y pantallas: para oficinas
// y salas con aire contemporáneo (sala de mercados, estudio, salón actual).

const NEGRO = "#1f2226";
const MALLA = "#2b2f36";
const LATON = "#c9a227";
const VERDE_UP = "#5ccf8a";
const ROJO_DOWN = "#ef5b5b";
const AMBAR = "#f0b84a";
const AZUL_DATO = "#6ba8ef";

/** Barras verticales de un gráfico pintadas sobre una pantalla que mira a +x. */
function bars(x: number, y0: number, z: number, heights: number[], step = 2.5): Box[] {
  return heights.map((h, i) => ({ x, y: y0 + i * step, z, w: 0.2, d: 1.4, h: Math.abs(h), c: h >= 0 ? VERDE_UP : ROJO_DOWN }));
}

/** Escalones de una línea de cotización sobre una pantalla de pared (y = 0). */
function stepLine(x0: number, y: number, z0: number, deltas: number[], c: string): Box[] {
  let z = z0;
  return deltas.map((dz, i) => {
    z += dz;
    return { x: x0 + i * 2.5, y, z, w: 2.6, d: 0.3, h: 0.9, c };
  });
}

Object.assign(FURNITURE, {
  escritorio_moderno: {
    label: "Escritorio moderno",
    w: 2,
    d: 1,
    desk: true,
    surface: 16,
    tints: { $tablero: "#f3f3f0", $patas: NEGRO },
    boxes: [
      { x: 1, y: 1, z: 0, w: 2, d: 14, h: 1.5, c: "$patas" },
      { x: 1, y: 1, z: 1.5, w: 2, d: 2, h: 12.5, c: "$patas" },
      { x: 1, y: 13, z: 1.5, w: 2, d: 2, h: 12.5, c: "$patas" },
      { x: 29, y: 1, z: 0, w: 2, d: 14, h: 1.5, c: "$patas" },
      { x: 29, y: 1, z: 1.5, w: 2, d: 2, h: 12.5, c: "$patas" },
      { x: 29, y: 13, z: 1.5, w: 2, d: 2, h: 12.5, c: "$patas" },
      { x: 3, y: 2, z: 12, w: 26, d: 1, h: 2, c: "$patas" },
      { x: 0, y: 0.5, z: 14, w: 32, d: 15, h: 2, c: "$tablero" },
    ],
  },
  silla_ergonomica: {
    label: "Silla ergonómica",
    w: 1,
    d: 1,
    seat: { face: "x", z: 10 },
    tints: { $malla: MALLA, $base: "#9aa3ad" },
    boxes: [
      { x: 3, y: 7, z: 0, w: 10, d: 2, h: 1.5, c: "$base" },
      { x: 7, y: 3, z: 0, w: 2, d: 10, h: 1.5, c: "$base" },
      { x: 7, y: 7, z: 1.5, w: 2, d: 2, h: 7, c: "$base" },
      { x: 3, y: 3, z: 8.5, w: 10, d: 10, h: 2.5, c: "$malla" },
      { x: 5, y: 2.5, z: 11, w: 1, d: 1, h: 3, c: NEGRO },
      { x: 5, y: 12.5, z: 11, w: 1, d: 1, h: 3, c: NEGRO },
      { x: 4.5, y: 2.5, z: 14, w: 6, d: 1, h: 1, c: NEGRO },
      { x: 4.5, y: 12.5, z: 14, w: 6, d: 1, h: 1, c: NEGRO },
      { x: 2, y: 3.5, z: 11, w: 2, d: 9, h: 13, c: "$malla" },
      { x: 2, y: 5, z: 24, w: 2, d: 6, h: 3, c: "$malla" },
    ],
  },
  sofa_modular: {
    label: "Sofá modular",
    w: 1,
    d: 2,
    tall: true,
    seat: { face: "x", z: 9 },
    tints: { $tela: "#9ea3a8", $cojin: "#b3b8bd", $acento: "#e0a458" },
    boxes: [
      { x: 2, y: 2, z: 0, w: 2, d: 2, h: 2, c: NEGRO },
      { x: 12, y: 2, z: 0, w: 2, d: 2, h: 2, c: NEGRO },
      { x: 2, y: 28, z: 0, w: 2, d: 2, h: 2, c: NEGRO },
      { x: 12, y: 28, z: 0, w: 2, d: 2, h: 2, c: NEGRO },
      { x: 1, y: 1, z: 2, w: 14, d: 30, h: 5, c: "$tela" },
      { x: 1, y: 1, z: 7, w: 4, d: 30, h: 9, c: "$tela" },
      { x: 5, y: 1, z: 7, w: 10, d: 2, h: 4, c: "$tela" },
      { x: 5, y: 29, z: 7, w: 10, d: 2, h: 4, c: "$tela" },
      { x: 5, y: 3, z: 7, w: 10, d: 12.8, h: 2, c: "$cojin" },
      { x: 5, y: 16.2, z: 7, w: 10, d: 12.8, h: 2, c: "$cojin" },
      { x: 5, y: 4, z: 9, w: 2, d: 5, h: 5, c: "$acento" },
    ],
  },
  mesa_centro: {
    label: "Mesa de centro",
    w: 2,
    d: 1,
    desk: true,
    surface: 8,
    tints: { $tablero: "#d9c3a0", $patas: NEGRO },
    boxes: [
      { x: 3, y: 2, z: 0, w: 1.5, d: 1.5, h: 6, c: "$patas" },
      { x: 27.5, y: 2, z: 0, w: 1.5, d: 1.5, h: 6, c: "$patas" },
      { x: 3, y: 12.5, z: 0, w: 1.5, d: 1.5, h: 6, c: "$patas" },
      { x: 27.5, y: 12.5, z: 0, w: 1.5, d: 1.5, h: 6, c: "$patas" },
      { x: 3, y: 3, z: 2, w: 26, d: 10, h: 1, c: "$patas" },
      { x: 1, y: 1, z: 6, w: 30, d: 14, h: 2, c: "$tablero" },
    ],
  },
  monitor_doble: {
    onTop: true,
    label: "Monitor doble",
    w: 1,
    d: 1,
    tints: { $marco: "#16181c", $pantalla: "#1d2f45" },
    boxes: [
      { x: 3, y: 6, z: 0, w: 4, d: 4, h: 1, c: "$marco" },
      { x: 4.5, y: 7.5, z: 1, w: 1, d: 1, h: 5, c: "$marco" },
      { x: 5, y: 0.5, z: 5, w: 1, d: 7.3, h: 7, c: "$marco" },
      { x: 6, y: 1, z: 5.5, w: 0.4, d: 6.3, h: 6, c: "$pantalla" },
      { x: 5, y: 8.2, z: 5, w: 1, d: 7.3, h: 7, c: "$marco" },
      { x: 6, y: 8.7, z: 5.5, w: 0.4, d: 6.3, h: 6, c: "$pantalla" },
      { x: 6.4, y: 1.8, z: 7, w: 0.2, d: 2, h: 0.6, c: VERDE_UP },
      { x: 6.4, y: 3.5, z: 8.2, w: 0.2, d: 2, h: 0.6, c: VERDE_UP },
      { x: 6.4, y: 5.2, z: 9.6, w: 0.2, d: 1.6, h: 0.6, c: VERDE_UP },
      ...bars(6.4, 9.3, 6.2, [3, -2, 4, -1.5], 1.5),
      { x: 9, y: 3, z: 0, w: 4, d: 10, h: 0.8, c: "#2a2d33" },
      { x: 9.5, y: 13.5, z: 0, w: 2.5, d: 1.8, h: 0.8, c: "#2a2d33" },
    ],
  },
  portatil: {
    onTop: true,
    label: "Portátil",
    w: 1,
    d: 1,
    tints: { $carcasa: "#c7ccd1", $pantalla: "#3b6ea8" },
    boxes: [
      { x: 5, y: 3, z: 0, w: 7, d: 10, h: 0.8, c: "$carcasa" },
      { x: 4, y: 3, z: 0.8, w: 1, d: 10, h: 7, c: "$carcasa" },
      { x: 5, y: 3.5, z: 1.5, w: 0.3, d: 9, h: 5.5, c: "$pantalla" },
      { x: 6.5, y: 4, z: 0.8, w: 4, d: 8, h: 0.1, c: "#3a3f47" },
    ],
  },
  videowall: {
    label: "Videowall",
    w: 2,
    d: 1,
    wall: true,
    tints: { $marco: "#111317", $pantalla: "#14243a" },
    boxes: [
      { x: 1, y: 0, z: 12, w: 30, d: 1.5, h: 34, c: "$marco" },
      { x: 1.5, y: 1.5, z: 12.5, w: 14.25, d: 0.4, h: 16.25, c: "$pantalla" },
      { x: 16.25, y: 1.5, z: 12.5, w: 14.25, d: 0.4, h: 16.25, c: "$pantalla" },
      { x: 1.5, y: 1.5, z: 29.25, w: 14.25, d: 0.4, h: 16.25, c: "$pantalla" },
      { x: 16.25, y: 1.5, z: 29.25, w: 14.25, d: 0.4, h: 16.25, c: "$pantalla" },
      // Arriba a la izquierda: cifra grande y variación.
      { x: 3, y: 1.9, z: 40, w: 9, d: 0.3, h: 3, c: "#e9f1fb" },
      { x: 3, y: 1.9, z: 35.5, w: 5, d: 0.3, h: 2, c: VERDE_UP },
      { x: 3, y: 1.9, z: 31.5, w: 11, d: 0.3, h: 1, c: "#2c4566" },
      // Arriba a la derecha: velas.
      ...[
        [18, 33, 6, VERDE_UP],
        [20.5, 35, 5, ROJO_DOWN],
        [23, 32, 8, VERDE_UP],
        [25.5, 36, 4, ROJO_DOWN],
        [28, 34, 8, VERDE_UP],
      ].map(([x, z, h, c]) => ({ x: x as number, y: 1.9, z: z as number, w: 1.2, d: 0.3, h: h as number, c: c as string })),
      // Abajo a la izquierda: línea de cotización.
      ...stepLine(2.5, 1.9, 14, [1, 2, -1, 3, 1, 2], VERDE_UP),
      // Abajo a la derecha: ranking de barras.
      { x: 18, y: 1.9, z: 24.5, w: 10, d: 0.3, h: 1, c: AMBAR },
      { x: 18, y: 1.9, z: 21.5, w: 7, d: 0.3, h: 1, c: AZUL_DATO },
      { x: 18, y: 1.9, z: 18.5, w: 9, d: 0.3, h: 1, c: VERDE_UP },
      { x: 18, y: 1.9, z: 15.5, w: 5, d: 0.3, h: 1, c: ROJO_DOWN },
    ],
  },
  pantalla_led: {
    label: "Pantalla LED",
    w: 1,
    d: 2,
    tall: true,
    tints: { $marco: "#111317", $pantalla: "#14243a" },
    boxes: [
      { x: 3, y: 4, z: 0, w: 8, d: 2, h: 1, c: NEGRO },
      { x: 3, y: 26, z: 0, w: 8, d: 2, h: 1, c: NEGRO },
      { x: 6, y: 4.5, z: 1, w: 1.5, d: 1, h: 12, c: NEGRO },
      { x: 6, y: 26.5, z: 1, w: 1.5, d: 1, h: 12, c: NEGRO },
      { x: 5.5, y: 1, z: 12, w: 2, d: 30, h: 24, c: "$marco" },
      { x: 7.5, y: 1.7, z: 12.7, w: 0.4, d: 28.6, h: 22.6, c: "$pantalla" },
      { x: 7.9, y: 2, z: 13.2, w: 0.2, d: 28, h: 1.5, c: "#0b1420" },
      ...bars(7.9, 4, 15.5, [6, 9, -7, 12, 10, -5]),
      { x: 7.9, y: 20, z: 30, w: 0.2, d: 9, h: 1, c: AMBAR },
      { x: 7.9, y: 20, z: 27, w: 0.2, d: 6, h: 1, c: AZUL_DATO },
      { x: 7.9, y: 20, z: 24, w: 0.2, d: 8, h: 1, c: VERDE_UP },
      { x: 7.9, y: 20, z: 21, w: 0.2, d: 4, h: 1, c: ROJO_DOWN },
    ],
  },
  panel_listones: {
    label: "Panel de listones",
    w: 2,
    d: 1,
    wall: true,
    tints: { $madera: "#c99a66", $fondo: "#2b2a28" },
    boxes: [
      { x: 1, y: 0, z: 6, w: 30, d: 0.8, h: 40, c: "$fondo" },
      ...Array.from({ length: 12 }, (_, i) => ({ x: 2 + i * 2.4, y: 0.8, z: 6, w: 1.4, d: 1, h: 40, c: "$madera" })),
    ],
  },
  arte_abstracto: {
    label: "Arte abstracto",
    w: 2,
    d: 1,
    wall: true,
    tints: { $lienzo: "#f4f1ea" },
    boxes: [
      { x: 3, y: 0, z: 22, w: 26, d: 1, h: 20, c: NEGRO },
      { x: 3.5, y: 1, z: 22.5, w: 25, d: 0.4, h: 19, c: "$lienzo" },
      { x: 5, y: 1.4, z: 28, w: 8, d: 0.2, h: 11, c: "#e07a5f" },
      { x: 14, y: 1.4, z: 24, w: 7, d: 0.2, h: 7, c: "#3d405b" },
      { x: 19, y: 1.4, z: 31, w: 7, d: 0.2, h: 8, c: "#81b29a" },
      { x: 12, y: 1.4, z: 34, w: 4, d: 0.2, h: 4, c: "#f2cc8f" },
    ],
  },
  neon: {
    label: "Neón",
    w: 1,
    d: 1,
    wall: true,
    tints: { $luz: "#4ff0ff" },
    boxes: [
      // Una flecha de tendencia al alza en tubo de neón.
      { x: 2, y: 0.5, z: 27, w: 3, d: 0.8, h: 1.2, c: "$luz" },
      { x: 4, y: 0.5, z: 27, w: 1.2, d: 0.8, h: 4, c: "$luz" },
      { x: 4, y: 0.5, z: 30.8, w: 3, d: 0.8, h: 1.2, c: "$luz" },
      { x: 6.8, y: 0.5, z: 29, w: 1.2, d: 0.8, h: 3, c: "$luz" },
      { x: 6.8, y: 0.5, z: 29, w: 3, d: 0.8, h: 1.2, c: "$luz" },
      { x: 8.6, y: 0.5, z: 29, w: 1.2, d: 0.8, h: 7, c: "$luz" },
      { x: 8.6, y: 0.5, z: 35.8, w: 4, d: 0.8, h: 1.2, c: "$luz" },
      { x: 11, y: 0.5, z: 37, w: 3, d: 0.8, h: 1.2, c: "$luz" },
      { x: 12.6, y: 0.5, z: 33.5, w: 1.2, d: 0.8, h: 4.7, c: "$luz" },
    ],
  },
  planta_moderna: {
    label: "Planta moderna",
    w: 1,
    d: 1,
    tints: { $maceta: "#f1f1ee", $hoja: "#2f7d4a" },
    boxes: [
      { x: 4, y: 4, z: 0, w: 8, d: 8, h: 12, c: "$maceta" },
      { x: 5, y: 5, z: 12, w: 6, d: 6, h: 0.5, c: "#3b2a20" },
      { x: 7.5, y: 7.5, z: 12, w: 1, d: 1, h: 18, c: "#3f6b3a" },
      { x: 3, y: 3, z: 18, w: 5, d: 4, h: 2, c: "$hoja" },
      { x: 2, y: 7, z: 22, w: 7, d: 5, h: 2, c: "$hoja" },
      { x: 8, y: 3, z: 26, w: 6, d: 6, h: 2, c: "$hoja" },
      { x: 5, y: 9, z: 29, w: 6, d: 5, h: 2, c: "#3f9a5c" },
      { x: 6, y: 4, z: 33, w: 5, d: 5, h: 2, c: "#3f9a5c" },
    ],
  },
  lampara_arco: {
    label: "Lámpara de arco",
    w: 1,
    d: 1,
    tints: { $metal: LATON, $pantalla: NEGRO },
    boxes: [
      { x: 3, y: 3, z: 0, w: 8, d: 10, h: 3, c: "#e9e8e4" },
      { x: 4, y: 7, z: 3, w: 1.5, d: 1.5, h: 38, c: "$metal" },
      { x: 4, y: 7, z: 41, w: 10, d: 1.5, h: 1.5, c: "$metal" },
      { x: 12.5, y: 7, z: 36, w: 1.5, d: 1.5, h: 5, c: "$metal" },
      { x: 10, y: 4.75, z: 31, w: 6, d: 6, h: 5, c: "$pantalla", top: MALLA },
      { x: 11.5, y: 6.25, z: 30.4, w: 3, d: 3, h: 0.6, c: "#fff3c4" },
    ],
  },
  estanteria_moderna: {
    label: "Estantería moderna",
    w: 1,
    d: 2,
    tall: true,
    tints: { $madera: "#d9c3a0", $metal: NEGRO },
    boxes: [
      { x: 0, y: 0, z: 0, w: 7, d: 1, h: 46, c: "$metal" },
      { x: 0, y: 31, z: 0, w: 7, d: 1, h: 46, c: "$metal" },
      ...[0, 15, 30, 44].map((z) => ({ x: 0, y: 0, z, w: 7, d: 32, h: 1.5, c: "$madera" })),
      { x: 2, y: 4, z: 1.5, w: 3, d: 3, h: 7, c: "#e07a5f" },
      { x: 1, y: 20, z: 1.5, w: 5, d: 7, h: 3, c: "#3d405b" },
      ...books(1, 3, 16.5, 5, "y", [MALLA, "#e9e8e4", "#81b29a"]),
      { x: 2, y: 24, z: 16.5, w: 3, d: 3, h: 3, c: LATON },
      { x: 2, y: 6, z: 31.5, w: 3, d: 3, h: 3, c: "#f1f1ee" },
      { x: 1.5, y: 5.5, z: 34.5, w: 4, d: 4, h: 4, c: "#3f9a5c" },
      { x: 1, y: 21, z: 31.5, w: 5, d: 6, h: 5, c: "#e9e8e4" },
    ],
  },
  ascensor: {
    // Puertas de acero contra el muro del fondo; se entra por la baldosa de
    // delante (sin girar, al sur; girado, al este). Une plantas/edificios.
    label: "Ascensor",
    w: 2,
    d: 1,
    tall: true,
    entrance: true,
    tints: { $marco: "#2a2e35", $puerta: "#b9c0c8" },
    boxes: [
      { x: 0, y: 0, z: 0, w: 32, d: 4, h: 46, c: "$marco" },
      { x: 2, y: 4, z: 0, w: 2, d: 2, h: 40, c: "$marco" },
      { x: 28, y: 4, z: 0, w: 2, d: 2, h: 40, c: "$marco" },
      { x: 2, y: 4, z: 36, w: 28, d: 2, h: 4, c: "$marco" },
      { x: 4, y: 4, z: 0, w: 11.8, d: 1, h: 36, c: "$puerta" },
      { x: 16.2, y: 4, z: 0, w: 11.8, d: 1, h: 36, c: "$puerta" },
      { x: 15.8, y: 4.6, z: 0, w: 0.4, d: 0.6, h: 36, c: "#6b7480" },
      { x: 2, y: 4, z: 0, w: 28, d: 7, h: 0.3, c: "#8a929c" },
      { x: 11, y: 6, z: 41, w: 10, d: 0.4, h: 3.5, c: "#111317" },
      { x: 12.5, y: 6.4, z: 42, w: 3, d: 0.2, h: 1.5, c: AMBAR },
      { x: 17, y: 6.4, z: 42, w: 2, d: 0.2, h: 1.5, c: VERDE_UP },
      { x: 30.2, y: 4, z: 15, w: 1.6, d: 1.2, h: 7, c: "#111317" },
      { x: 30.6, y: 5.2, z: 19, w: 0.8, d: 0.3, h: 1.2, c: "#7fe8ff" },
      { x: 30.6, y: 5.2, z: 16.5, w: 0.8, d: 0.3, h: 1.2, c: "#7fe8ff" },
    ],
  },
  alfombra_moderna: {
    label: "Alfombra moderna",
    w: 3,
    d: 2,
    walkable: true,
    tints: { $base: "#d8d4cc" },
    boxes: [
      { x: 2, y: 2, z: 0, w: 44, d: 28, h: 1, c: "$base" },
      { x: 6, y: 6, z: 1, w: 14, d: 20, h: 0.01, c: "#3d405b" },
      { x: 20, y: 6, z: 1, w: 10, d: 10, h: 0.01, c: "#e07a5f" },
      { x: 30, y: 16, z: 1, w: 12, d: 10, h: 0.01, c: "#81b29a" },
    ],
  },
} satisfies Record<string, FurnitureDef>);

for (const k of ["estanteria", "archivador", "cafetera", "sofa"]) FURNITURE[k].tall = true;

export const TILE_UNITS = T;

/** Huella en baldosas teniendo en cuenta el espejado (intercambia ejes). */
export function footprint(kind: string, flip?: boolean): { w: number; d: number } {
  const def = FURNITURE[kind];
  if (!def) return { w: 1, d: 1 };
  return flip ? { w: def.d, d: def.w } : { w: def.w, d: def.d };
}

/** Baldosas (relativas a la sala) por las que se entra a un mueble con `entrance`: la franja de delante. */
export function entranceTiles(it: { kind: string; x: number; y: number; flip?: boolean }): { x: number; y: number }[] {
  if (!FURNITURE[it.kind]?.entrance) return [];
  const fp = footprint(it.kind, it.flip);
  return it.flip
    ? Array.from({ length: fp.d }, (_, j) => ({ x: it.x + fp.w, y: it.y + j }))
    : Array.from({ length: fp.w }, (_, i) => ({ x: it.x + i, y: it.y + fp.d }));
}

/** Cajas listas para pintar: tintes resueltos y espejado aplicado. */
export function resolveBoxes(kind: string, flip?: boolean, tint?: Record<string, string>): Box[] {
  const def = FURNITURE[kind];
  if (!def) return [];
  const colors = { ...def.tints, ...tint };
  const resolve = (c: string) => (c.startsWith("$") ? (colors[c] ?? "#ff00ff") : c);
  return def.boxes.map((b) => {
    const box = { ...b, c: resolve(b.c), top: b.top ? resolve(b.top) : undefined };
    return flip ? { ...box, x: b.y, y: b.x, w: b.d, d: b.w } : box;
  });
}
