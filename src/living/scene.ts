/**
 * Escena del living con PixiJS: casa, muebles y agentes con vida.
 *
 * Toda la «vida» (pasear, sentarse, frases de ambiente) se decide aquí, en el
 * navegador, sin llamar al modelo. Las posiciones aleatorias solo existen en el
 * cliente, así que no hay problemas de hidratación.
 */

import { Application, Container, Graphics, Rectangle, Sprite, Texture, TextureSource, type FederatedPointerEvent } from "pixi.js";
import type { Agent, AgentStatus, Room } from "../lib/types";
import { highlightCells, roomBounds, type DecorGhost } from "./decorMode";
import { doorTiles } from "./decorator";
import { untilText, type ClaudeUsage } from "../lib/claude/usageText";
import { getPersonality } from "../lib/personalities";
import { AVATAR_W, FOOT_X, FOOT_Y, SEAT_Y, POSES, appearanceKey, drawAvatar, type Pose, type View } from "./avatar";
import { FURNITURE, footprint, resolveBoxes } from "./furniture";
import { buildNavGrid, canStep, findPath, freeTilesInRoom, isFree, levelOf, levelOrigin, roomIndexAt, type NavGrid, type PathPoint, type Point } from "./house";
import { currentRoom, isNearDesk, pickSeat } from "./presence";
import { dividerPieces, exteriorPieces, outerWallSides, renderBackground, T } from "./houseRender";
import { project, rasterizeBoxes, type PixelImage, type RasterBox } from "./raster";
import { initialLevel, levelAtX, levelOffset, levelScreenBounds, STOREY_H, towerFootprint, towerLevels, type Footprint } from "./floors";
import { roofBoxes, towerShell } from "./towerRender";
import { floorLabel } from "../lib/roomTemplates";

TextureSource.defaultOptions.scaleMode = "nearest";

const METER_KEY = "orden.contadorClaude";
function readMeterPref(): boolean {
  try {
    return localStorage.getItem(METER_KEY) !== "oculto";
  } catch {
    return true;
  }
}
function writeMeterPref(visible: boolean) {
  try {
    localStorage.setItem(METER_KEY, visible ? "visible" : "oculto");
  } catch {
    // sin almacenamiento: solo dura esta visita
  }
}

/** Una planta de la torre, para el selector del living. */
export interface FloorInfo {
  level: number;
  label: string;
  /** Salas que tiene (0 = planta diáfana). */
  rooms: number;
  /** Agentes que tienen ahí su sitio. */
  agents: number;
}

export interface SceneCallbacks {
  onSelect?: (agentId: string) => void;
  /** Clic en el medidor de límites de Claude. */
  onUsageClick?: () => void;
  /** Cambian las plantas o la que se ve (para el selector de plantas). */
  onFloors?: (state: { level: number; floors: FloorInfo[] }) => void;
}

/** Capas de dibujo de una planta (su raíz va subida `level` pisos). */
interface LevelLayer {
  level: number;
  root: Container;
  /** Forjado y plaza (se ocultan en las plantas fantasma). */
  slab: Container;
  /** Cristal y estructura del fondo, donde no hay muros. */
  back: Container;
  /** Suelos y muros de las salas. */
  bg: Container;
  /** Muebles, tabiques y agentes, ordenados por profundidad. */
  objects: Container;
  /** Muro cortina delantero (se oculta en la planta elegida: corte de maqueta). */
  front: Container;
}

/** Opacidad de las plantas de encima de la elegida (fachada en fantasma). */
const GHOST_ALPHA = 0.28;
/** Opacidad del cristal del muro cortina. */
const CURTAIN_ALPHA = 0.38;

/** Modo «decorar»: lo que la escena avisa a la interfaz. */
export interface DecorHandlers {
  /** Se pulsa un mueble de la sala que se decora (punto en coordenadas del mundo). */
  onItemDown: (id: string, e: { clientX: number; clientY: number; wx: number; wy: number }) => void;
  /** Clic en un hueco (sin arrastrar la cámara): soltar la selección. */
  onEmptyTap: () => void;
}

/** Lo que la escena pinta en el modo «decorar». */
export interface DecorView {
  selectedId: string | null;
  /** Mueble que se está arrastrando (se atenúa en su sitio). */
  liftedId: string | null;
  ghost: DecorGhost | null;
}

const GHOST_OK = 0x8dffa8;
const GHOST_BAD = 0xff7a7a;
const SELECTED_TINT = 0xffe7a8;

const STATUS_LABEL: Record<AgentStatus, string> = {
  idle: "Disponible",
  working: "Trabajando",
  waiting: "Esperando",
  sleeping: "Durmiendo",
  error: "Error",
};

function toTexture(img: PixelImage): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d")!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  const tex = Texture.from(canvas);
  tex.source.scaleMode = "nearest";
  return tex;
}

const avatarCache = new Map<string, Record<string, Texture>>();
function avatarTextures(agent: Agent): Record<string, Texture> {
  const key = appearanceKey(agent.appearance);
  let set = avatarCache.get(key);
  if (!set) {
    set = {};
    for (const pose of POSES) for (const view of ["front", "back"] as View[]) set[`${pose}:${view}`] = toTexture(drawAvatar(agent.appearance, pose, view));
    avatarCache.set(key, set);
  }
  return set;
}

const furnitureCache = new Map<string, { tex: Texture; ox: number; oy: number; img: PixelImage }>();
function furnitureTexture(kind: string, flip?: boolean, tint?: Record<string, string>) {
  const key = `${kind}|${flip ? 1 : 0}|${JSON.stringify(tint ?? {})}`;
  let entry = furnitureCache.get(key);
  if (!entry) {
    const img = rasterizeBoxes(resolveBoxes(kind, flip, tint));
    // Se guarda la imagen para saber qué píxeles son del mueble (pulsar en modo decorar).
    entry = { tex: toTexture(img), ox: img.ox, oy: img.oy, img };
    furnitureCache.set(key, entry);
  }
  return entry;
}

interface Seat {
  /** Id del mueble (para el escritorio asignado de cada agente). */
  id: string;
  tile: Point;
  z: number;
  /** Hacia dónde mira al sentarse: x → derecha-abajo, y → izquierda-abajo. */
  face: "x" | "y";
  depth: number;
  bed: boolean;
  nearDesk: boolean;
  roomId: string;
}

/** Rombo de una baldosa de la casa en el suelo (para la rejilla del modo decorar). */
function tileDiamond(tx: number, ty: number): number[] {
  return [
    [tx, ty],
    [tx + 1, ty],
    [tx + 1, ty + 1],
    [tx, ty + 1],
  ].flatMap(([x, y]) => {
    const p = project(x * T, y * T, 0);
    return [p.sx, p.sy];
  });
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
/** Baldosas que se desplaza en x la franja de una planta en el plano. */
const levelOffsetTiles = (level: number) => levelOrigin(level).x;
/** Lo que tarda un viaje en ascensor entre plantas. */
const ELEVATOR_RIDE_MS = 1600;
const pick =<T>(arr: T[]): T | undefined => (arr.length ? arr[Math.floor(Math.random() * arr.length)] : undefined);

class Actor {
  agent: Agent;
  sprite: Sprite;
  el: HTMLDivElement;
  bubbleEl: HTMLDivElement;
  badgeEl: HTMLDivElement;
  nameEl: HTMLDivElement;
  pos: Point = { x: 0.5, y: 0.5 };
  /** Planta en la que está ahora (se actualiza al moverse; cambia al salir del ascensor). */
  level = 0;
  z = 0;
  path: PathPoint[] = [];
  /** Viaje en ascensor en curso: hasta cuándo va dentro (oculto). */
  rideUntil = 0;
  mode: "stand" | "walk" | "sit" = "stand";
  seat: Seat | null = null;
  mirror = false;
  view: View = "front";
  animT = 0;
  frame = 0;
  waitUntil = 0;
  nextAmbientAt = 0;
  bubbleUntil = 0;
  waveUntil = 0;
  /** Mientras visita a otro agente no decide por su cuenta. */
  holdUntil = 0;
  lastStatusText = "";
  placed = false;
  onArrive: (() => void) | null = null;

  constructor(agent: Agent, overlay: HTMLDivElement) {
    this.agent = agent;
    this.sprite = new Sprite();
    this.sprite.eventMode = "static";
    this.sprite.cursor = "pointer";
    this.el = document.createElement("div");
    this.el.className = "agent-ov";
    this.nameEl = document.createElement("div");
    this.nameEl.className = "agent-name";
    this.badgeEl = document.createElement("div");
    this.badgeEl.className = "agent-badge";
    this.bubbleEl = document.createElement("div");
    this.bubbleEl.className = "agent-bubble";
    this.el.append(this.bubbleEl, this.badgeEl, this.nameEl);
    overlay.appendChild(this.el);
    this.nextAmbientAt = performance.now() + rand(6000, 20000);
    this.refreshLabels();
  }

  refreshLabels() {
    this.nameEl.textContent = this.agent.name;
    const s = this.effectiveStatus();
    this.el.dataset.status = s;
    this.badgeEl.dataset.status = s;
  }

  effectiveStatus(): AgentStatus {
    return this.agent.paused ? "sleeping" : this.agent.status;
  }

  say(text: string, ms = 5000) {
    if (!text) return;
    this.bubbleEl.textContent = text;
    this.bubbleEl.classList.add("show");
    this.bubbleUntil = performance.now() + ms;
  }

  destroy() {
    this.sprite.destroy();
    this.el.remove();
  }
}

export class LivingScene {
  private app: Application;
  private host: HTMLDivElement;
  private overlay: HTMLDivElement;
  private tooltip: HTMLDivElement;
  private world = new Container();
  /** Una capa por planta (de abajo arriba) y la azotea. */
  private layers = new Map<number, LevelLayer>();
  private roofLayer: Container | null = null;
  private footprint: Footprint | null = null;
  /** Planta que se ve (las de encima, en fantasma). */
  private level = 0;
  /** Ya se ha elegido planta al abrir (después manda el usuario). */
  private levelChosen = false;
  private agentsList: Agent[] = [];
  private rooms: Room[] = [];
  private grid: NavGrid | null = null;
  private seats: Seat[] = [];
  private actors = new Map<string, Actor>();
  private zoom = 2;
  private userMoved = false;
  private hovered: Actor | null = null;
  private callbacks: SceneCallbacks;
  private bgBounds = new Rectangle(0, 0, 1, 1);
  /** Muebles ya vistos: los nuevos «caen» en su sitio con una animación. */
  private knownFurniture: Set<string> | null = null;
  private drops: { sprite: Sprite; baseY: number; start: number }[] = [];
  private dropIndex = 0;
  private roomLabel!: HTMLDivElement;
  /** Medidores de límites de Claude colocados en la casa (tarjeta HTML encima del mueble). */
  private meters: { gx: number; gy: number; z: number; level: number; el: HTMLDivElement; sprite: Sprite; holo: boolean }[] = [];
  /** El contador se muestra u oculta con un clic en el mueble (se recuerda en este navegador). */
  private metersVisible = readMeterPref();
  private usage: ClaudeUsage | null = null;
  private meterTextAt = 0;
  private destroyed = false;
  private resizeObs: ResizeObserver;
  /** Rejilla y baldosas resaltadas del modo decorar (entre el suelo y los muebles). */
  private decorLayer = new Container();
  private decorGrid = new Graphics();
  private decorMarks = new Graphics();
  private decorGhost: Sprite | null = null;
  private decor: { roomId: string; handlers: DecorHandlers } | null = null;
  private decorView: DecorView = { selectedId: null, liftedId: null, ghost: null };
  private decorToolbar: HTMLElement | null = null;
  /** Sprites de los muebles por id, con su imagen (para pulsarlos con precisión de píxel). */
  private furnSprites = new Map<string, { sprite: Sprite; img: PixelImage; roomId: string; level: number }>();

  private constructor(app: Application, host: HTMLDivElement, overlay: HTMLDivElement, callbacks: SceneCallbacks) {
    this.app = app;
    this.host = host;
    this.overlay = overlay;
    this.callbacks = callbacks;
    this.tooltip = document.createElement("div");
    this.tooltip.className = "living-tooltip";
    overlay.appendChild(this.tooltip);
    this.roomLabel = document.createElement("div");
    this.roomLabel.className = "room-label";
    overlay.appendChild(this.roomLabel);
    this.decorLayer.addChild(this.decorGrid, this.decorMarks);
    this.decorLayer.visible = false;
    app.stage.addChild(this.world);
    this.setupCamera();
    app.ticker.add((t) => this.tick(t.deltaMS));
    this.resizeObs = new ResizeObserver(() => {
      // El lienzo sigue al hueco (p. ej. al abrir o cerrar la ficha lateral), no solo a la ventana.
      this.app.resize();
      if (!this.userMoved) this.fit();
    });
    this.resizeObs.observe(host);
  }

  static async create(host: HTMLDivElement, overlay: HTMLDivElement, callbacks: SceneCallbacks = {}): Promise<LivingScene> {
    const app = new Application();
    await app.init({
      resizeTo: host,
      // Transparente: el cielo según la hora se pinta detrás, en CSS (ver sky.ts).
      backgroundAlpha: 0,
      antialias: false,
      roundPixels: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      preference: "webgl",
    });
    host.appendChild(app.canvas);
    app.canvas.style.imageRendering = "pixelated";
    return new LivingScene(app, host, overlay, callbacks);
  }

  // ───────────────────────── Cámara ─────────────────────────

  private setupCamera() {
    const stage = this.app.stage;
    stage.eventMode = "static";
    stage.hitArea = this.app.screen;
    let drag: { x: number; y: number; wx: number; wy: number; moved: boolean } | null = null;
    stage.on("pointerdown", (e) => {
      // Decorando, pulsar un mueble de la sala lo coge; en un hueco se mueve la cámara.
      if (this.decor && e.button === 0 && this.decorPointerDown(e)) return;
      drag = { x: e.global.x, y: e.global.y, wx: this.world.x, wy: this.world.y, moved: false };
    });
    stage.on("pointermove", (e) => {
      if (!drag) {
        this.showRoomLabel(e.global.x, e.global.y);
        return;
      }
      const dx = e.global.x - drag.x;
      const dy = e.global.y - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) {
        this.userMoved = true;
        drag.moved = true;
      }
      this.world.position.set(Math.round(drag.wx + dx), Math.round(drag.wy + dy));
    });
    stage.on("pointerup", () => {
      if (drag && !drag.moved) this.decor?.handlers.onEmptyTap();
      drag = null;
    });
    stage.on("pointerupoutside", () => (drag = null));
    this.app.canvas.addEventListener(
      "wheel",
      (ev) => {
        ev.preventDefault();
        const next = Math.max(1, Math.min(5, this.zoom + (ev.deltaY < 0 ? 1 : -1)));
        if (next === this.zoom) return;
        const rect = this.app.canvas.getBoundingClientRect();
        const mx = ev.clientX - rect.left;
        const my = ev.clientY - rect.top;
        const wx = (mx - this.world.x) / this.zoom;
        const wy = (my - this.world.y) / this.zoom;
        this.zoom = next;
        this.world.scale.set(next);
        this.world.position.set(Math.round(mx - wx * next), Math.round(my - wy * next));
        this.userMoved = true;
      },
      { passive: false },
    );
  }

  /** Centra la planta que se ve (con un poco de la de abajo) y elige un zoom entero que quepa. */
  fit() {
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    const b = this.fitBounds();
    const z = Math.max(1, Math.min(4, Math.floor(Math.min((w - 40) / b.width, (h - 60) / b.height))));
    this.zoom = z;
    this.world.scale.set(z);
    this.world.position.set(Math.round(w / 2 - (b.x + b.width / 2) * z), Math.round(h / 2 - (b.y + b.height / 2) * z + 10));
  }

  /**
   * Rectángulo (mundo, sin zoom) que se encuadra: las salas de la planta
   * elegida (o, si está diáfana, toda su huella) y el canto de la de abajo.
   */
  private fitBounds(): Rectangle {
    if (!this.footprint) return this.bgBounds;
    const fp = towerFootprint(this.rooms.filter((r) => levelOf(r) === this.level)) ?? this.footprint;
    const b = levelScreenBounds(fp, this.level);
    return new Rectangle(b.x, b.y, b.width, b.height + (this.level > 0 ? STOREY_H * 0.6 : 0));
  }

  resetView() {
    this.userMoved = false;
    this.fit();
  }

  // ───────────────────────── Plantas ─────────────────────────

  /** Planta que se ve ahora. */
  get currentLevel(): number {
    return this.level;
  }

  /** Plantas de la torre, de abajo arriba (para el selector). */
  floors(): FloorInfo[] {
    const levels = [...this.layers.keys()].sort((a, b) => a - b);
    return levels.map((level) => {
      const rooms = this.rooms.filter((r) => levelOf(r) === level);
      const ids = new Set(rooms.map((r) => r.id));
      const agents = this.agentsList.filter((a) => {
        const r = currentRoom(a, this.rooms);
        return r ? ids.has(r.id) : false;
      }).length;
      return { level, label: floorLabel(level), rooms: rooms.length, agents };
    });
  }

  /**
   * Cambia la planta que se ve. Si el usuario ha movido la cámara, esta sube o
   * baja con la planta (como en un ascensor); si no, se reencuadra.
   */
  setLevel(level: number) {
    const levels = [...this.layers.keys()];
    if (!levels.length) return;
    const next = Math.max(Math.min(...levels), Math.min(Math.max(...levels), Math.round(level)));
    this.levelChosen = true;
    if (next === this.level) return this.notifyFloors();
    const delta = next - this.level;
    this.level = next;
    if (this.userMoved) this.world.position.y = Math.round(this.world.position.y + delta * STOREY_H * this.zoom);
    else this.fit();
    this.applyLevel();
  }

  /** Visibilidad de cada planta: debajo, enteras; la elegida, sin fachada delantera; encima, en fantasma. */
  private applyLevel() {
    for (const L of this.layers.values()) {
      const ghost = L.level > this.level;
      L.root.alpha = ghost ? GHOST_ALPHA : 1;
      L.slab.visible = !ghost;
      L.bg.visible = !ghost;
      L.objects.visible = !ghost;
      L.front.visible = L.level !== this.level;
    }
    const top = Math.max(-1, ...this.layers.keys());
    if (this.roofLayer) this.roofLayer.visible = this.level < top;
    if (this.hovered && this.hovered.level !== this.level) this.setHover(null);
    this.applyDecorInteractivity();
    this.renderMeters();
    this.notifyFloors();
  }

  private notifyFloors() {
    this.callbacks.onFloors?.({ level: this.level, floors: this.floors() });
  }

  /** Planta de una baldosa del plano (por su sala; si no, por su franja). */
  private levelAtTile(tx: number, ty: number): number {
    const room = this.roomAt(tx, ty);
    return room ? levelOf(room) : levelAtX(tx);
  }

  private layerOf(level: number): LevelLayer | undefined {
    return this.layers.get(level);
  }

  private newLayer(level: number): LevelLayer {
    const root = new Container();
    const slab = new Container();
    const back = new Container();
    const bg = new Container();
    const objects = new Container();
    const front = new Container();
    objects.sortableChildren = true;
    root.addChild(slab, back, bg, objects, front);
    const o = levelOffset(level);
    root.position.set(o.x, o.y);
    return { level, root, slab, back, bg, objects, front };
  }

  /** Sprite de unas cajas rasterizadas, colocado en su sitio. */
  private boxSprite(boxes: RasterBox[], opts: { outline?: boolean; alpha?: number } = {}): Sprite | null {
    if (!boxes.length) return null;
    const img = rasterizeBoxes(boxes, { outline: opts.outline ?? true, outlineShade: 0.35 });
    const s = new Sprite(toTexture(img));
    s.position.set(img.ox, img.oy);
    if (opts.alpha !== undefined) s.alpha = opts.alpha;
    return s;
  }

  // ───────────────────────── Mundo ─────────────────────────

  setWorld(rooms: Room[], agents: Agent[]) {
    const roomsChanged = JSON.stringify(rooms) !== JSON.stringify(this.rooms);
    this.agentsList = agents;
    if (roomsChanged) this.buildHouse(rooms);
    this.setAgents(agents);
    // Al abrir: la planta donde está la acción o, si no hay, la de más arriba.
    if (!this.levelChosen && rooms.length) {
      this.levelChosen = true;
      this.level = initialLevel(rooms, agents);
      if (!this.userMoved) this.fit();
      this.applyLevel();
    } else this.notifyFloors();
  }

  private buildHouse(rooms: Room[]) {
    this.rooms = rooms;
    this.grid = buildNavGrid(rooms);
    // Los agentes y la capa de decorar sobreviven: se sueltan antes de rehacer las plantas.
    for (const a of this.actors.values()) a.sprite.parent?.removeChild(a.sprite);
    this.decorLayer.parent?.removeChild(this.decorLayer);
    for (const L of this.layers.values()) L.root.destroy({ children: true });
    this.layers.clear();
    this.roofLayer?.destroy({ children: true });
    this.roofLayer = null;
    for (const m of this.meters) m.el.remove();
    this.meters = [];
    this.furnSprites.clear();
    // La sombra del modo decorar también se rehace (se destruye con el resto).
    this.decorGhost = null;
    this.footprint = towerFootprint(rooms);
    if (!rooms.length || !this.footprint) return;
    const fp = this.footprint;

    // Una capa por planta, de abajo arriba (las de arriba se pintan encima).
    for (const level of towerLevels(rooms)) {
      const L = this.newLayer(level);
      this.layers.set(level, L);
      this.world.addChild(L.root);
      const mine = rooms.filter((r) => levelOf(r) === level);
      const shell = towerShell(fp, level, mine);
      const slab = this.boxSprite(shell.slab);
      if (slab) L.slab.addChild(slab);
      for (const s of [this.boxSprite(shell.backGlass, { outline: false, alpha: CURTAIN_ALPHA }), this.boxSprite(shell.backFrame, { outline: false })]) if (s) L.back.addChild(s);
      for (const s of [this.boxSprite(shell.frontGlass, { outline: false, alpha: CURTAIN_ALPHA }), this.boxSprite(shell.frontFrame, { outline: false })]) if (s) L.front.addChild(s);
      if (!mine.length) continue;
      const bg = renderBackground(mine);
      const bgSprite = new Sprite(toTexture(bg));
      bgSprite.position.set(bg.ox, bg.oy);
      L.bg.addChild(bgSprite);
      for (const piece of dividerPieces(mine)) {
        const img = rasterizeBoxes([piece.box]);
        const s = new Sprite(toTexture(img));
        s.position.set(img.ox, img.oy);
        s.zIndex = piece.depth;
        L.objects.addChild(s);
      }
      // Entre edificios de una misma planta: pasarela acristalada.
      for (const piece of exteriorPieces(mine)) {
        const img = rasterizeBoxes(piece.boxes, { outline: piece.outline ?? true });
        const s = new Sprite(toTexture(img));
        s.position.set(img.ox, img.oy);
        s.zIndex = piece.depth;
        if (piece.alpha !== undefined) s.alpha = piece.alpha;
        L.objects.addChild(s);
      }
    }
    const top = Math.max(...this.layers.keys());
    const roof = new Container();
    const roofSprite = this.boxSprite(roofBoxes(fp, top + 1));
    if (roofSprite) roof.addChild(roofSprite);
    const ro = levelOffset(top + 1);
    roof.position.set(ro.x, ro.y);
    roof.alpha = GHOST_ALPHA;
    this.roofLayer = roof;
    this.world.addChild(roof);
    // Marco de toda la torre (de la plaza a la azotea), por si hiciera falta.
    const lo = levelScreenBounds(fp, 0);
    const hi = levelScreenBounds(fp, top + 1);
    this.bgBounds = new Rectangle(lo.x, hi.y, lo.width, lo.y + lo.height - hi.y);
    if (!this.layers.has(this.level)) this.level = Math.min(top, Math.max(0, this.level));

    this.seats = [];
    // Profundidad de cada baldosa ocupada, para apilar objetos encima.
    const tileDepth = new Map<string, number>();
    const pending: { f: Room["furniture"][number]; room: Room }[] = [];
    for (const room of rooms) {
      const walls = outerWallSides(room, rooms, this.grid?.walkways);
      const sides = { northFree: walls.north, westFree: walls.west };
      for (const f of room.furniture) {
        const def = FURNITURE[f.kind];
        if (!def) continue;
        if (def.onTop) {
          pending.push({ f, room });
          continue;
        }
        const fp = footprint(f.kind, f.flip);
        if (def.wall) {
          // Solo en muros altos; en tabiques bajos no hay pared donde colgarlo.
          const ok = f.flip ? sides.westFree[f.y] : sides.northFree[f.x];
          if (!ok) continue;
        }
        const gx = room.x + f.x;
        const gy = room.y + f.y;
        let depth = gx + fp.w / 2 + gy + fp.d / 2;
        if (def.wall) depth = -2000 + depth;
        else if (def.walkable) depth = -1000 + depth;
        else for (let dy = 0; dy < fp.d; dy++) for (let dx = 0; dx < fp.w; dx++) tileDepth.set(`${gx + dx},${gy + dy}`, depth);
        this.addFurnitureSprite(f, gx, gy, depth, room);
        if (def.seat) {
          const face = f.flip ? (def.seat.face === "x" ? "y" : "x") : def.seat.face === "y" ? "y" : "x";
          const nearDesk = isNearDesk(f, room.furniture);
          this.seats.push({ id: f.id, tile: { x: gx, y: gy }, z: def.seat.z, face, depth, bed: Boolean(def.bed), nearDesk, roomId: room.id });
        }
      }
    }
    for (const { f, room } of pending) {
      const gx = room.x + f.x;
      const gy = room.y + f.y;
      const base = tileDepth.get(`${gx},${gy}`) ?? gx + gy + 1;
      this.addFurnitureSprite(f, gx, gy, base + 0.01, room);
    }
    const all = rooms.flatMap((r) => r.furniture.map((f) => f.id));
    this.knownFurniture = new Set(all);
    this.dropIndex = 0;
    if (this.decor) this.drawDecorGrid();
    this.renderDecor();
    this.applyLevel();
    if (!this.userMoved) this.fit();
  }

  private addFurnitureSprite(f: Room["furniture"][number], gx: number, gy: number, depth: number, room: Room) {
    const layer = this.layerOf(levelOf(room));
    if (!layer) return;
    const { tex, ox, oy, img } = furnitureTexture(f.kind, f.flip, f.tint);
    const p = project(gx * T, gy * T, f.z ?? 0);
    const s = new Sprite(tex);
    s.position.set(p.sx + ox, p.sy + oy);
    s.zIndex = depth;
    layer.objects.addChild(s);
    this.furnSprites.set(f.id, { sprite: s, img, roomId: room.id, level: layer.level });
    if (f.kind === "medidor_claude" || f.kind === "holo_boton") this.addMeter(gx, gy, f, s, layer.level);
    // Mueble nuevo (sala recién creada o redecorada): aparece cayendo, uno tras otro.
    if (this.knownFurniture && !this.knownFurniture.has(f.id)) {
      s.alpha = 0;
      this.drops.push({ sprite: s, baseY: s.y, start: performance.now() + 250 + this.dropIndex++ * 180 });
    }
  }

  private addMeter(gx: number, gy: number, f: Room["furniture"][number], sprite: Sprite, level: number) {
    const holo = f.kind === "holo_boton";
    const el = document.createElement("div");
    el.className = `usage-meter${holo ? " holo" : ""}`;
    el.title = "Límites de Claude · clic para actualizar";
    el.addEventListener("click", () => this.callbacks.onUsageClick?.());
    this.overlay.appendChild(el);
    // El propio mueble es un botón: muestra u oculta el contador.
    sprite.eventMode = "static";
    sprite.cursor = "pointer";
    sprite.on("pointertap", (e) => {
      e.stopPropagation();
      this.metersVisible = !this.metersVisible;
      writeMeterPref(this.metersVisible);
      if (this.metersVisible) this.callbacks.onUsageClick?.();
      this.renderMeters();
    });
    sprite.on("pointerdown", (e) => e.stopPropagation());
    this.meters.push({ gx, gy, z: holo ? (f.z ?? 0) + 18 : 46, level, el, sprite, holo });
    this.renderMeters();
  }

  /** Datos del medidor (llegan por SSE cuando el worker los refresca). */
  setUsage(usage: ClaudeUsage | null) {
    this.usage = usage;
    this.renderMeters();
  }

  private renderMeters() {
    const u = this.usage;
    for (const m of this.meters) {
      // Solo el de la planta que se ve (los de otras plantas flotarían encima).
      m.el.classList.toggle("hidden", !this.metersVisible || m.level !== this.level);
      if (!m.sprite.destroyed) m.sprite.eventMode = this.decor || m.level !== this.level ? "none" : "static";
      m.el.innerHTML = "";
      const head = document.createElement("div");
      head.className = "um-head";
      head.textContent = "Claude";
      m.el.appendChild(head);
      if (!u || !u.available || !u.windows.length) {
        const p = document.createElement("div");
        p.className = "um-empty";
        p.textContent = u?.error ? "Sin datos" : "Leyendo…";
        m.el.appendChild(p);
        continue;
      }
      for (const w of u.windows.filter((x) => x.key === "five_hour" || x.key === "seven_day")) {
        const row = document.createElement("div");
        row.className = `um-row ${w.percent >= 90 ? "bad" : w.percent >= 70 ? "warn" : "ok"}`;
        const label = document.createElement("span");
        label.className = "um-label";
        label.textContent = w.key === "five_hour" ? "5 h" : "Sem.";
        const bar = document.createElement("span");
        bar.className = "um-bar";
        const fill = document.createElement("i");
        fill.style.width = `${w.percent}%`;
        bar.appendChild(fill);
        const pct = document.createElement("span");
        pct.className = "um-pct";
        pct.textContent = `${Math.round(w.percent)}%`;
        const reset = document.createElement("span");
        reset.className = "um-reset";
        reset.textContent = w.resetsAt ? untilText(w.resetsAt).replace(/^en /, "↻ ") : "";
        row.append(label, bar, pct, reset);
        m.el.appendChild(row);
      }
    }
  }

  // ───────────────────────── Modo decorar ─────────────────────────

  /** Entra en el modo decorar de una sala (o sale con null). */
  setDecorMode(roomId: string | null, handlers?: DecorHandlers) {
    this.decor = roomId && handlers ? { roomId, handlers } : null;
    if (!this.decor) this.decorView = { selectedId: null, liftedId: null, ghost: null };
    // Se decora en la planta de la sala: se pasa a ella (sin mover la cámara; focusRoom la encuadra).
    const room = this.decorRoom();
    if (room && levelOf(room) !== this.level && this.layers.has(levelOf(room))) {
      this.level = levelOf(room);
      this.levelChosen = true;
      this.applyLevel();
    }
    this.drawDecorGrid();
    this.renderDecor();
    this.renderMeters();
  }

  /** Capa de la planta en la que se decora (o, si no, la que se ve). */
  private activeLayer(): LevelLayer | undefined {
    const room = this.decorRoom();
    return this.layerOf(room ? levelOf(room) : this.level);
  }

  /** Selección, mueble levantado y sombra (verde si cabe, roja si no). */
  setDecorView(view: DecorView) {
    this.decorView = view;
    this.renderDecor();
  }

  /** Barra flotante (girar, duplicar, quitar) que se coloca encima del mueble elegido. */
  setDecorToolbar(el: HTMLElement | null) {
    this.decorToolbar = el;
  }

  /**
   * Punto bajo unas coordenadas de la ventana, en las coordenadas de `project`
   * de la planta en la que se decora (null si cae fuera del lienzo).
   */
  clientToWorld(clientX: number, clientY: number): { wx: number; wy: number } | null {
    const rect = this.app.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
    const p = (this.activeLayer()?.root ?? this.world).toLocal({ x, y });
    return { wx: p.x, wy: p.y };
  }

  /** Encuadra una sala con el zoom entero más grande que quepa, dejando sitio a los paneles (px). */
  focusRoom(roomId: string, pad: { top?: number; right?: number; bottom?: number; left?: number } = {}) {
    const room = this.rooms.find((r) => r.id === roomId);
    if (!room) return;
    this.app.resize();
    const { top = 0, right = 0, bottom = 0, left = 0 } = pad;
    const w = this.app.screen.width - left - right;
    const h = this.app.screen.height - top - bottom;
    if (w < 80 || h < 80) return;
    // La sala está en la capa de su planta: se suma el desplazamiento de esa capa.
    const o = levelOffset(levelOf(room));
    const rb = roomBounds(room);
    const b = { ...rb, x: rb.x + o.x, y: rb.y + o.y };
    const z = Math.max(1, Math.min(5, Math.floor(Math.min((w - 24) / b.width, (h - 24) / b.height))));
    this.zoom = z;
    this.world.scale.set(z);
    this.world.position.set(Math.round(left + w / 2 - (b.x + b.width / 2) * z), Math.round(top + h / 2 - (b.y + b.height / 2) * z));
    this.userMoved = true;
  }

  /** Pulsación en modo decorar: si cae sobre un mueble de la sala, se avisa y no se mueve la cámara. */
  private decorPointerDown(e: FederatedPointerEvent): boolean {
    const id = this.pickFurniture(e.global.x, e.global.y);
    if (!id || !this.decor) return false;
    const p = (this.activeLayer()?.root ?? this.world).toLocal(e.global);
    this.decor.handlers.onItemDown(id, { clientX: e.clientX, clientY: e.clientY, wx: p.x, wy: p.y });
    return true;
  }

  /** Mueble de la sala que se decora bajo un punto de la pantalla, mirando sus píxeles (el de delante gana). */
  private pickFurniture(gx: number, gy: number): string | null {
    if (!this.decor) return null;
    const p = (this.activeLayer()?.root ?? this.world).toLocal({ x: gx, y: gy });
    let best: { id: string; z: number } | null = null;
    for (const [id, f] of this.furnSprites) {
      if (f.roomId !== this.decor.roomId || f.sprite.destroyed) continue;
      const lx = Math.floor(p.x - f.sprite.x);
      const ly = Math.floor(p.y - f.sprite.y);
      if (lx < 0 || ly < 0 || lx >= f.img.width || ly >= f.img.height) continue;
      if (f.img.data[(ly * f.img.width + lx) * 4 + 3] < 40) continue;
      if (!best || f.sprite.zIndex > best.z) best = { id, z: f.sprite.zIndex };
    }
    return best?.id ?? null;
  }

  private decorRoom(): Room | undefined {
    return this.decor ? this.rooms.find((r) => r.id === this.decor!.roomId) : undefined;
  }

  /** Rejilla de baldosas de la sala y pasos de puerta (que hay que dejar libres). */
  private drawDecorGrid() {
    const g = this.decorGrid;
    g.clear();
    const room = this.decorRoom();
    this.decorLayer.visible = Boolean(room);
    if (!room) return;
    // La rejilla va en la capa de la planta de la sala, entre el suelo y los muebles.
    const layer = this.layerOf(levelOf(room));
    if (layer && this.decorLayer.parent !== layer.root) layer.root.addChildAt(this.decorLayer, layer.root.getChildIndex(layer.objects));
    for (const [x, y] of doorTiles(room.w, room.d)) g.poly(tileDiamond(room.x + x, room.y + y)).fill({ color: 0xe8b04a, alpha: 0.28 });
    for (let i = 0; i <= room.w; i++) {
      const a = project((room.x + i) * T, room.y * T, 0);
      const b = project((room.x + i) * T, (room.y + room.d) * T, 0);
      g.moveTo(a.sx, a.sy).lineTo(b.sx, b.sy);
    }
    for (let j = 0; j <= room.d; j++) {
      const a = project(room.x * T, (room.y + j) * T, 0);
      const b = project((room.x + room.w) * T, (room.y + j) * T, 0);
      g.moveTo(a.sx, a.sy).lineTo(b.sx, b.sy);
    }
    g.stroke({ width: 1, color: 0xffffff, alpha: 0.32, pixelLine: true });
  }

  /** Pinta la selección, el mueble levantado y la sombra; y quita la interacción de agentes y medidores. */
  private renderDecor() {
    const room = this.decorRoom();
    const v = this.decorView;
    for (const [id, f] of this.furnSprites) {
      if (f.sprite.destroyed) continue;
      const mine = Boolean(room) && f.roomId === room!.id;
      f.sprite.tint = mine && id === v.selectedId ? SELECTED_TINT : 0xffffff;
      if (mine && id === v.liftedId) f.sprite.alpha = 0.3;
      else if (f.sprite.alpha === 0.3) f.sprite.alpha = 1;
    }

    const m = this.decorMarks;
    m.clear();
    if (this.decorGhost) {
      this.decorGhost.parent?.removeChild(this.decorGhost);
      this.decorGhost.destroy();
      this.decorGhost = null;
    }
    if (room) {
      const inside = ([x, y]: [number, number]) => x >= 0 && y >= 0 && x < room.w && y < room.d;
      const sel = v.selectedId && !v.liftedId ? room.furniture.find((f) => f.id === v.selectedId) : undefined;
      if (sel) for (const c of highlightCells(sel).filter(inside)) m.poly(tileDiamond(room.x + c[0], room.y + c[1])).fill({ color: 0xe8b04a, alpha: 0.4 });
      const ghost = v.ghost && FURNITURE[v.ghost.kind] ? v.ghost : null;
      if (ghost) {
        const color = ghost.ok ? GHOST_OK : GHOST_BAD;
        for (const c of highlightCells(ghost).filter(inside)) m.poly(tileDiamond(room.x + c[0], room.y + c[1])).fill({ color, alpha: 0.45 });
        const { tex, ox, oy } = furnitureTexture(ghost.kind, ghost.flip, ghost.tint);
        const p = project((room.x + ghost.x) * T, (room.y + ghost.y) * T, ghost.z ?? 0);
        const s = new Sprite(tex);
        s.position.set(p.sx + ox, p.sy + oy);
        s.zIndex = 1e6;
        s.alpha = 0.82;
        s.tint = color;
        s.eventMode = "none";
        this.layerOf(levelOf(room))?.objects.addChild(s);
        this.decorGhost = s;
      }
    }
    this.applyDecorInteractivity();
  }

  /** Decorando, los agentes y los medidores se apartan (semitransparentes y sin clic). Fuera de la planta que se ve, sin clic. */
  private applyDecorInteractivity() {
    const on = Boolean(this.decor);
    for (const meter of this.meters) if (!meter.sprite.destroyed) meter.sprite.eventMode = on || meter.level !== this.level ? "none" : "static";
    for (const a of this.actors.values()) {
      a.sprite.eventMode = on || a.level !== this.level ? "none" : "static";
      a.sprite.alpha = on ? 0.45 : 1;
    }
    if (on) this.setHover(null);
  }

  private placeDecorToolbar() {
    const el = this.decorToolbar;
    if (!el) return;
    const id = this.decor && !this.decorView.liftedId ? this.decorView.selectedId : null;
    const f = id ? this.furnSprites.get(id) : undefined;
    if (!f || f.sprite.destroyed) {
      el.style.visibility = "hidden";
      return;
    }
    const top = (f.sprite.parent ?? this.world).toGlobal({ x: f.sprite.x + f.img.width / 2, y: f.sprite.y });
    el.style.transform = `translate(${Math.round(top.x)}px, ${Math.round(top.y) - 6}px) translate(-50%, -100%)`;
    el.style.visibility = "visible";
  }

  private animateDrops(now: number) {
    if (!this.drops.length) return;
    this.drops = this.drops.filter((d) => {
      if (d.sprite.destroyed) return false;
      const t = (now - d.start) / 380;
      if (t < 0) return true;
      const k = Math.min(1, t);
      const ease = 1 - Math.pow(1 - k, 3);
      d.sprite.alpha = k;
      d.sprite.y = Math.round(d.baseY - 18 * (1 - ease));
      if (k >= 1) d.sprite.y = d.baseY;
      return k < 1;
    });
  }

  /** Nombre de la sala bajo el ratón. */
  private showRoomLabel(gx: number, gy: number) {
    if (this.hovered) {
      this.roomLabel.classList.remove("show");
      return;
    }
    // La planta que se ve primero; si no hay sala ahí, las de debajo (asoman por delante).
    let name: string | null = null;
    for (let level = this.level; level >= 0 && !name; level--) {
      const layer = this.layerOf(level);
      if (!layer) continue;
      const p = layer.root.toLocal({ x: gx, y: gy });
      const X = (2 * p.y + p.x) / 2;
      const Y = (2 * p.y - p.x) / 2;
      const tx = Math.floor(X / T);
      const ty = Math.floor(Y / T);
      const room = this.roomAt(tx, ty);
      if (room && levelOf(room) === level) name = level === this.level ? room.name : `${room.name} · ${floorLabel(level)}`;
      else if (level === this.level && this.grid && roomIndexAt(this.grid, tx, ty) >= this.rooms.length) name = "Pasarela acristalada";
      // Dentro de la huella de la planta que se ve, su forjado tapa las de abajo.
      const fp = this.footprint;
      const lx = tx - levelOffsetTiles(level);
      if (level === this.level && fp && lx >= fp.x0 && lx < fp.x1 && ty >= fp.y0 && ty < fp.y1) break;
    }
    if (!name) {
      this.roomLabel.classList.remove("show");
      return;
    }
    this.roomLabel.textContent = name;
    this.roomLabel.style.transform = `translate(${Math.round(gx + 14)}px, ${Math.round(gy + 14)}px)`;
    this.roomLabel.classList.add("show");
  }

  private setAgents(agents: Agent[]) {
    const ids = new Set(agents.map((a) => a.id));
    for (const [id, actor] of this.actors) {
      if (!ids.has(id)) {
        actor.destroy();
        this.actors.delete(id);
      }
    }
    for (const agent of agents) {
      let actor = this.actors.get(agent.id);
      if (!actor) {
        actor = new Actor(agent, this.overlay);
        (actor.sprite as Sprite & { __actor?: boolean }).__actor = true;
        actor.sprite.on("pointertap", (e) => {
          e.stopPropagation();
          this.callbacks.onSelect?.(agent.id);
        });
        actor.sprite.on("pointerover", () => this.setHover(actor!));
        actor.sprite.on("pointerout", () => this.setHover(null));
        // Su capa (la de su planta) se le asigna en cada fotograma, según dónde esté.
        this.actors.set(agent.id, actor);
        this.place(actor);
        if (agent.isChief) {
          actor.waveUntil = performance.now() + 2200;
          actor.say("¡Bienvenido a Orden!", 4500);
        }
      } else {
        const prevStatus = actor.effectiveStatus();
        const prevRoom = this.homeRoom(actor)?.id;
        actor.agent = agent;
        actor.refreshLabels();
        // Si cambia de estado o de sala (se ha ido a otra), decide ya.
        if (prevStatus !== actor.effectiveStatus() || prevRoom !== this.homeRoom(actor)?.id) actor.waitUntil = 0;
      }
      if (agent.statusText && agent.statusText !== actor.lastStatusText) actor.say(agent.statusText, 7000);
      actor.lastStatusText = agent.statusText;
    }
    if (this.decor) this.applyDecorInteractivity();
  }

  /** Muestra un bocadillo en un agente (por ejemplo, al recibir un mensaje). */
  say(agentId: string, text: string, ms = 5000) {
    this.actors.get(agentId)?.say(text, ms);
  }

  /** Sala en la que está ahora (a la que se ha ido o, si no, la suya). Cualquier sala vale. */
  private homeRoom(actor: Actor): Room | undefined {
    return currentRoom(actor.agent, this.rooms);
  }

  private place(actor: Actor) {
    if (!this.grid) return;
    // Si su sala aún no ha llegado (se crea justo después), espera a ella.
    const visiting = actor.agent.locationRoomId ? this.rooms.find((r) => r.id === actor.agent.locationRoomId) : undefined;
    const room = visiting ?? (actor.agent.roomId ? this.rooms.find((r) => r.id === actor.agent.roomId) : this.homeRoom(actor));
    actor.sprite.visible = Boolean(room);
    if (!room) return;
    const tile = pick(freeTilesInRoom(this.grid, room)) ?? { x: room.x, y: room.y };
    actor.pos = { x: tile.x + 0.5, y: tile.y + 0.5 };
    actor.rideUntil = 0;
    actor.placed = true;
  }

  private setHover(actor: Actor | null) {
    this.hovered = actor;
    if (!actor) {
      this.tooltip.classList.remove("show");
      return;
    }
    const a = actor.agent;
    const s = actor.effectiveStatus();
    this.tooltip.innerHTML = "";
    const title = document.createElement("strong");
    title.textContent = a.name;
    const role = document.createElement("span");
    role.className = "tt-role";
    role.textContent = a.specialty;
    const st = document.createElement("span");
    st.className = `tt-status st-${s}`;
    st.textContent = STATUS_LABEL[s] + (a.statusText ? ` · ${a.statusText}` : "");
    this.tooltip.append(title, role, st);
    this.tooltip.classList.add("show");
  }

  // ───────────────────────── Comportamiento ─────────────────────────

  private seatFor(actor: Actor, wantBed: boolean): Seat | undefined {
    const others = [...this.actors.values()].filter((o) => o !== actor);
    const taken = (s: Seat) => others.some((o) => o.seat === s);
    // Cada uno a su escritorio asignado; las sillas de los demás, solo si no queda otra.
    const reservedIds = new Set(others.map((o) => o.agent.deskSeatId).filter(Boolean));
    return pickSeat(this.seats, this.homeRoom(actor)?.id, taken, wantBed, {
      own: actor.agent.deskSeatId,
      reserved: (s) => reservedIds.has(s.id),
    });
  }

  private walkTo(actor: Actor, goal: Point, onArrive?: () => void): boolean {
    if (!this.grid) return false;
    const start = { x: Math.floor(actor.pos.x), y: Math.floor(actor.pos.y) };
    const path = findPath(this.grid, start, goal);
    if (!path) return false;
    actor.seat = null;
    actor.z = 0;
    actor.rideUntil = 0;
    actor.path = path.slice(1).map((p) => ({ x: p.x + 0.5, y: p.y + 0.5, ...(p.elevator && { elevator: true }) }));
    actor.mode = actor.path.length ? "walk" : "stand";
    actor.onArrive = onArrive ?? null;
    if (!actor.path.length) onArrive?.();
    return true;
  }

  private goSit(actor: Actor, seat: Seat) {
    if (actor.seat === seat && actor.mode === "sit") return;
    const ok = this.walkTo(actor, seat.tile, () => {
      actor.mode = "sit";
      actor.seat = seat;
      actor.z = seat.z;
      actor.pos = { x: seat.tile.x + 0.5, y: seat.tile.y + 0.5 };
      actor.view = "front";
      actor.mirror = seat.face === "y";
    });
    if (ok) actor.seat = seat; // reservado mientras camina
  }

  private decide(actor: Actor, now: number) {
    if (!this.grid) return;
    const status = actor.effectiveStatus();
    const room = this.homeRoom(actor);
    if (!room) return;
    if (status === "working" || status === "sleeping") {
      const seat = this.seatFor(actor, status === "sleeping");
      if (seat) this.goSit(actor, seat);
      else if (roomIndexAt(this.grid, Math.floor(actor.pos.x), Math.floor(actor.pos.y)) !== this.grid.roomIds.indexOf(room.id)) {
        // Sala sin asiento libre: trabaja de pie, pero en esa sala.
        const tile = pick(freeTilesInRoom(this.grid, room));
        if (tile) this.walkTo(actor, tile);
      }
      actor.waitUntil = now + 4000;
      return;
    }
    if (status === "error") {
      if (actor.mode === "walk") actor.path = actor.path.slice(0, 1);
      actor.waitUntil = now + 5000;
      return;
    }
    // Disponible o esperando: pasear tranquilamente.
    const roll = Math.random();
    let targetRoom = room;
    if (status === "idle" && roll < 0.22 && this.rooms.length > 1) targetRoom = pick(this.rooms.filter((r) => r.id !== room.id)) ?? room;
    if (status === "idle" && roll > 0.85) {
      const seat = this.seatFor(actor, false);
      if (seat) {
        this.goSit(actor, seat);
        actor.waitUntil = now + rand(9000, 18000);
        return;
      }
    }
    const tile = pick(freeTilesInRoom(this.grid, targetRoom));
    if (tile) this.walkTo(actor, tile);
    actor.waitUntil = now + rand(status === "waiting" ? 6000 : 3500, status === "waiting" ? 12000 : 9000);
  }

  private tick(dtMs: number) {
    if (this.destroyed) return;
    const now = performance.now();
    const dt = Math.min(dtMs, 100) / 1000;
    this.animateDrops(now);
    this.placeDecorToolbar();
    for (const m of this.meters) {
      const p = project((m.gx + 0.5) * T, (m.gy + 0.5) * T, m.z);
      const g = (this.layerOf(m.level)?.root ?? this.world).toGlobal({ x: p.sx, y: p.sy });
      // Siempre por ENCIMA del mueble, para no tapar el botón.
      m.el.style.transform = `translate(${Math.round(g.x)}px, ${Math.round(g.y) - 6}px) translate(-50%, -100%)`;
      // El holograma palpita (más vivo cuando el contador está a la vista).
      if (m.holo && !m.sprite.destroyed) m.sprite.alpha = (this.metersVisible ? 0.85 : 0.6) + Math.sin(now / 420) * 0.15;
    }
    // La cuenta atrás se refresca cada 30 s (sin pedir datos nuevos).
    if (this.meters.length && now - this.meterTextAt > 30_000) {
      this.meterTextAt = now;
      this.renderMeters();
    }
    for (const actor of this.actors.values()) {
      if (!actor.placed) this.place(actor);
      // Movimiento
      if (actor.mode === "walk" && actor.path.length && actor.path[0].elevator) {
        // Ascensor: entra (desaparece), sube o baja y sale por la otra parada.
        const target = actor.path[0];
        if (!actor.rideUntil) actor.rideUntil = now + ELEVATOR_RIDE_MS;
        else if (now >= actor.rideUntil) {
          actor.rideUntil = 0;
          actor.pos = { x: target.x, y: target.y };
          actor.path[0] = { x: target.x, y: target.y };
        }
      } else if (actor.mode === "walk" && actor.path.length) {
        const target = actor.path[0];
        const dx = target.x - actor.pos.x;
        const dy = target.y - actor.pos.y;
        const dist = Math.hypot(dx, dy);
        const step = 2.4 * dt;
        const sx = dx - dy;
        const sy = dx + dy;
        if (Math.abs(sx) > 0.01) actor.mirror = sx < 0;
        if (Math.abs(sy) > 0.01) actor.view = sy < 0 ? "back" : "front";
        if (dist <= step) {
          actor.pos = { ...target };
          actor.path.shift();
          if (!actor.path.length) {
            actor.mode = "stand";
            const cb = actor.onArrive;
            actor.onArrive = null;
            cb?.();
          }
        } else {
          actor.pos = { x: actor.pos.x + (dx / dist) * step, y: actor.pos.y + (dy / dist) * step };
        }
        actor.animT += dtMs;
        if (actor.animT > 140) {
          actor.animT = 0;
          actor.frame = (actor.frame + 1) % 4;
        }
      } else if (actor.mode !== "walk" && now > actor.waitUntil && now > actor.holdUntil) {
        this.decide(actor, now);
      }

      // Frases de ambiente (sin modelo)
      const status = actor.effectiveStatus();
      if (now > actor.nextAmbientAt) {
        actor.nextAmbientAt = now + rand(25000, 60000);
        if (now > actor.bubbleUntil) {
          const preset = getPersonality(actor.agent.personality.preset);
          const pool = status === "idle" ? (actor.agent.ambient.length ? actor.agent.ambient : preset.ambient) : (preset.status[status] ?? []);
          const phrase = pick(pool);
          if (phrase) actor.say(phrase, 4500);
        }
      }
      if (actor.bubbleUntil && now > actor.bubbleUntil) {
        actor.bubbleUntil = 0;
        actor.bubbleEl.classList.remove("show");
      }

      // Sprite
      const textures = avatarTextures(actor.agent);
      let pose: Pose = "stand";
      if (actor.mode === "walk") pose = actor.frame === 1 ? "walk1" : actor.frame === 3 ? "walk2" : "stand";
      else if (actor.mode === "sit") pose = status === "sleeping" ? "sleep" : "sit";
      else if (now < actor.waveUntil) pose = "wave";
      const view: View = actor.mode === "sit" ? "front" : actor.view;
      actor.sprite.texture = textures[`${pose}:${view}`];
      actor.sprite.pivot.set(FOOT_X, actor.mode === "sit" ? SEAT_Y : FOOT_Y);
      actor.sprite.scale.x = actor.mirror ? -1 : 1;
      const p = project(actor.pos.x * T, actor.pos.y * T, actor.z);
      actor.sprite.position.set(Math.round(p.sx), Math.round(p.sy));
      // Planta en la que está: su sprite va en la capa de esa planta.
      const level = this.levelAtTile(Math.floor(actor.pos.x), Math.floor(actor.pos.y));
      const layer = this.layerOf(level);
      if (layer && actor.sprite.parent !== layer.objects) layer.objects.addChild(actor.sprite);
      if (level !== actor.level) {
        actor.level = level;
        if (this.hovered === actor && level !== this.level) this.setHover(null);
      }
      // Solo se pulsan los agentes de la planta que se ve.
      const clickable = !this.decor && level === this.level ? "static" : "none";
      if (actor.sprite.eventMode !== clickable) actor.sprite.eventMode = clickable;
      const riding = actor.rideUntil > 0;
      // Se ve en su planta y en las de debajo de la que se mira (a través del cristal); el nombre, solo en la que se mira.
      actor.sprite.visible = actor.placed && !riding && Boolean(layer) && level <= this.level;
      actor.el.style.visibility = riding || level !== this.level ? "hidden" : "";
      actor.sprite.zIndex = actor.mode === "sit" && actor.seat ? actor.seat.depth + 0.05 : actor.pos.x + actor.pos.y + 0.02;

      // Capa HTML (nombre, estado, bocadillo) sobre la cabeza
      const head = (layer?.root ?? this.world).toGlobal({ x: p.sx, y: p.sy - (actor.mode === "sit" ? SEAT_Y : FOOT_Y) + 2 });
      actor.el.style.transform = `translate(${Math.round(head.x)}px, ${Math.round(head.y)}px)`;
      actor.el.classList.toggle("hover", this.hovered === actor);
    }
    if (this.hovered) {
      const s = this.hovered.sprite;
      const top = (s.parent ?? this.world).toGlobal({ x: s.x, y: s.y - FOOT_Y });
      this.tooltip.style.transform = `translate(${Math.round(top.x + (AVATAR_W / 2) * this.zoom + 8)}px, ${Math.round(top.y)}px)`;
    }
  }

  /** Baldosa libre más cercana a un agente (para ir a hablarle). */
  private tileNear(target: Actor, exclude: Actor): Point | null {
    if (!this.grid) return null;
    const start = { x: Math.floor(target.pos.x), y: Math.floor(target.pos.y) };
    const occupied = new Set(
      [...this.actors.values()].filter((a) => a !== exclude && a !== target).map((a) => `${Math.floor(a.pos.x)},${Math.floor(a.pos.y)}`),
    );
    const seen = new Set([`${start.x},${start.y}`]);
    const queue = [start];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const d of [
        { x: 1, y: 0 },
        { x: 0, y: 1 },
        { x: -1, y: 0 },
        { x: 0, y: -1 },
      ]) {
        const n = { x: cur.x + d.x, y: cur.y + d.y };
        const key = `${n.x},${n.y}`;
        if (seen.has(key) || !canStep(this.grid, cur, n)) continue;
        seen.add(key);
        if (isFree(this.grid, n.x, n.y)) {
          if (!occupied.has(key)) return n;
          queue.push(n);
        } else if (seen.size < 6) queue.push(n);
      }
    }
    return null;
  }

  /**
   * Un agente va a la sala de otro (delegar o entregar resultados), le dice
   * algo y vuelve a lo suyo.
   */
  visit(fromId: string, toId: string, text?: string) {
    const a = this.actors.get(fromId);
    const b = this.actors.get(toId);
    if (!a || !b || a === b) return;
    const goal = this.tileNear(b, a);
    if (!goal) return;
    a.holdUntil = performance.now() + 60_000;
    const ok = this.walkTo(a, goal, () => {
      a.say(text ?? "…", 4200);
      // Mirar hacia el otro agente.
      const sx = b.pos.x - a.pos.x - (b.pos.y - a.pos.y);
      const sy = b.pos.x - a.pos.x + (b.pos.y - a.pos.y);
      if (Math.abs(sx) > 0.01) a.mirror = sx < 0;
      a.view = sy < 0 ? "back" : "front";
      a.holdUntil = performance.now() + 3800;
      if (b.mode !== "walk") b.waveUntil = performance.now() + 1200;
    });
    if (!ok) a.holdUntil = 0;
  }

  /** ¿Qué sala hay bajo una baldosa? (para futuras interacciones) */
  roomAt(x: number, y: number): Room | undefined {
    if (!this.grid) return undefined;
    const i = roomIndexAt(this.grid, x, y);
    return i >= 0 ? this.rooms[i] : undefined;
  }

  destroy() {
    this.destroyed = true;
    this.resizeObs.disconnect();
    for (const a of this.actors.values()) a.destroy();
    this.actors.clear();
    this.tooltip.remove();
    this.roomLabel.remove();
    for (const m of this.meters) m.el.remove();
    this.app.destroy(true, { children: true });
  }
}
