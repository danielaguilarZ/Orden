/**
 * Escena del living con PixiJS: casa, muebles y agentes con vida.
 *
 * Toda la «vida» (pasear, sentarse, frases de ambiente) se decide aquí, en el
 * navegador, sin llamar al modelo. Las posiciones aleatorias solo existen en el
 * cliente, así que no hay problemas de hidratación.
 */

import { Application, Container, Rectangle, Sprite, Texture, TextureSource } from "pixi.js";
import type { Agent, AgentStatus, Room } from "../lib/types";
import { untilText, type ClaudeUsage } from "../lib/claude/usageText";
import { getPersonality } from "../lib/personalities";
import { AVATAR_W, FOOT_X, FOOT_Y, SEAT_Y, POSES, appearanceKey, drawAvatar, type Pose, type View } from "./avatar";
import { FURNITURE, footprint, resolveBoxes } from "./furniture";
import { buildNavGrid, canStep, findPath, freeTilesInRoom, isFree, roomIndexAt, type NavGrid, type Point } from "./house";
import { currentRoom, isNearDesk, pickSeat } from "./presence";
import { dividerPieces, exteriorPieces, outerWallSides, renderBackground, T } from "./houseRender";
import { project, rasterizeBoxes, type PixelImage } from "./raster";

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

export interface SceneCallbacks {
  onSelect?: (agentId: string) => void;
  /** Clic en el medidor de límites de Claude. */
  onUsageClick?: () => void;
}

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

const furnitureCache = new Map<string, { tex: Texture; ox: number; oy: number }>();
function furnitureTexture(kind: string, flip?: boolean, tint?: Record<string, string>) {
  const key = `${kind}|${flip ? 1 : 0}|${JSON.stringify(tint ?? {})}`;
  let entry = furnitureCache.get(key);
  if (!entry) {
    const img = rasterizeBoxes(resolveBoxes(kind, flip, tint));
    entry = { tex: toTexture(img), ox: img.ox, oy: img.oy };
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

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(arr: T[]): T | undefined => (arr.length ? arr[Math.floor(Math.random() * arr.length)] : undefined);

class Actor {
  agent: Agent;
  sprite: Sprite;
  el: HTMLDivElement;
  bubbleEl: HTMLDivElement;
  badgeEl: HTMLDivElement;
  nameEl: HTMLDivElement;
  pos: Point = { x: 0.5, y: 0.5 };
  z = 0;
  path: Point[] = [];
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
  private bgLayer = new Container();
  private objects = new Container();
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
  private meters: { gx: number; gy: number; z: number; el: HTMLDivElement; sprite: Sprite; holo: boolean }[] = [];
  /** El contador se muestra u oculta con un clic en el mueble (se recuerda en este navegador). */
  private metersVisible = readMeterPref();
  private usage: ClaudeUsage | null = null;
  private meterTextAt = 0;
  private destroyed = false;
  private resizeObs: ResizeObserver;

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
    this.objects.sortableChildren = true;
    this.world.addChild(this.bgLayer, this.objects);
    app.stage.addChild(this.world);
    this.setupCamera();
    app.ticker.add((t) => this.tick(t.deltaMS));
    this.resizeObs = new ResizeObserver(() => {
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
    let drag: { x: number; y: number; wx: number; wy: number } | null = null;
    stage.on("pointerdown", (e) => {
      drag = { x: e.global.x, y: e.global.y, wx: this.world.x, wy: this.world.y };
    });
    stage.on("pointermove", (e) => {
      if (!drag) {
        this.showRoomLabel(e.global.x, e.global.y);
        return;
      }
      const dx = e.global.x - drag.x;
      const dy = e.global.y - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) this.userMoved = true;
      this.world.position.set(Math.round(drag.wx + dx), Math.round(drag.wy + dy));
    });
    const end = () => (drag = null);
    stage.on("pointerup", end);
    stage.on("pointerupoutside", end);
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

  /** Centra la casa y elige un zoom entero que quepa. */
  fit() {
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    const b = this.bgBounds;
    const z = Math.max(1, Math.min(4, Math.floor(Math.min((w - 40) / b.width, (h - 60) / b.height))));
    this.zoom = z;
    this.world.scale.set(z);
    this.world.position.set(Math.round(w / 2 - (b.x + b.width / 2) * z), Math.round(h / 2 - (b.y + b.height / 2) * z + 10));
  }

  resetView() {
    this.userMoved = false;
    this.fit();
  }

  // ───────────────────────── Mundo ─────────────────────────

  setWorld(rooms: Room[], agents: Agent[]) {
    const roomsChanged = JSON.stringify(rooms) !== JSON.stringify(this.rooms);
    if (roomsChanged) this.buildHouse(rooms);
    this.setAgents(agents);
  }

  private buildHouse(rooms: Room[]) {
    this.rooms = rooms;
    this.grid = buildNavGrid(rooms);
    this.bgLayer.removeChildren().forEach((c) => c.destroy());
    for (const m of this.meters) m.el.remove();
    this.meters = [];
    for (const child of [...this.objects.children]) {
      if (!(child as Sprite & { __actor?: boolean }).__actor) {
        this.objects.removeChild(child);
        child.destroy();
      }
    }
    if (!rooms.length) return;

    const bg = renderBackground(rooms);
    const bgSprite = new Sprite(toTexture(bg));
    bgSprite.position.set(bg.ox, bg.oy);
    this.bgLayer.addChild(bgSprite);
    this.bgBounds = new Rectangle(bg.ox, bg.oy, bg.width, bg.height);

    for (const piece of dividerPieces(rooms)) {
      const img = rasterizeBoxes([piece.box]);
      const s = new Sprite(toTexture(img));
      s.position.set(img.ox, img.oy);
      s.zIndex = piece.depth;
      this.objects.addChild(s);
    }
    // Entre edificios: pasarela acristalada (estructura opaca y cristales translúcidos).
    for (const piece of exteriorPieces(rooms)) {
      const img = rasterizeBoxes(piece.boxes, { outline: piece.outline ?? true });
      const s = new Sprite(toTexture(img));
      s.position.set(img.ox, img.oy);
      s.zIndex = piece.depth;
      if (piece.alpha !== undefined) s.alpha = piece.alpha;
      this.objects.addChild(s);
    }

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
        this.addFurnitureSprite(f, gx, gy, depth);
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
      this.addFurnitureSprite(f, gx, gy, base + 0.01);
    }
    const all = rooms.flatMap((r) => r.furniture.map((f) => f.id));
    this.knownFurniture = new Set(all);
    this.dropIndex = 0;
    if (!this.userMoved) this.fit();
  }

  private addFurnitureSprite(f: Room["furniture"][number], gx: number, gy: number, depth: number) {
    const { tex, ox, oy } = furnitureTexture(f.kind, f.flip, f.tint);
    const p = project(gx * T, gy * T, f.z ?? 0);
    const s = new Sprite(tex);
    s.position.set(p.sx + ox, p.sy + oy);
    s.zIndex = depth;
    this.objects.addChild(s);
    if (f.kind === "medidor_claude" || f.kind === "holo_boton") this.addMeter(gx, gy, f, s);
    // Mueble nuevo (sala recién creada o redecorada): aparece cayendo, uno tras otro.
    if (this.knownFurniture && !this.knownFurniture.has(f.id)) {
      s.alpha = 0;
      this.drops.push({ sprite: s, baseY: s.y, start: performance.now() + 250 + this.dropIndex++ * 180 });
    }
  }

  private addMeter(gx: number, gy: number, f: Room["furniture"][number], sprite: Sprite) {
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
    this.meters.push({ gx, gy, z: holo ? (f.z ?? 0) + 18 : 46, el, sprite, holo });
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
      m.el.classList.toggle("hidden", !this.metersVisible);
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
    const p = this.world.toLocal({ x: gx, y: gy });
    const X = (2 * p.y + p.x) / 2;
    const Y = (2 * p.y - p.x) / 2;
    const tx = Math.floor(X / T);
    const ty = Math.floor(Y / T);
    const zone = this.grid ? roomIndexAt(this.grid, tx, ty) : -1;
    const name = this.roomAt(tx, ty)?.name ?? (zone >= this.rooms.length ? "Pasarela acristalada" : null);
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
        this.objects.addChild(actor.sprite);
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
    actor.path = path.slice(1).map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 }));
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
    for (const m of this.meters) {
      const p = project((m.gx + 0.5) * T, (m.gy + 0.5) * T, m.z);
      const g = this.world.toGlobal({ x: p.sx, y: p.sy });
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
      if (actor.mode === "walk" && actor.path.length) {
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
      actor.sprite.zIndex = actor.mode === "sit" && actor.seat ? actor.seat.depth + 0.05 : actor.pos.x + actor.pos.y + 0.02;

      // Capa HTML (nombre, estado, bocadillo) sobre la cabeza
      const head = this.world.toGlobal({ x: p.sx, y: p.sy - (actor.mode === "sit" ? SEAT_Y : FOOT_Y) + 2 });
      actor.el.style.transform = `translate(${Math.round(head.x)}px, ${Math.round(head.y)}px)`;
      actor.el.classList.toggle("hover", this.hovered === actor);
    }
    if (this.hovered) {
      const s = this.hovered.sprite;
      const top = this.world.toGlobal({ x: s.x, y: s.y - FOOT_Y });
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
