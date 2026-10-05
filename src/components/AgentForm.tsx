"use client";

import { Backdrop } from "./Backdrop";
import { useState } from "react";
import { api } from "@/client/store";
import { PERSONALITIES } from "@/lib/personalities";
import type { Agent, Appearance, ModelChoice } from "@/lib/types";
import { AvatarPreview } from "./AvatarPreview";

const SKINS = ["#ffdbac", "#f1c27d", "#e0ac69", "#c68642", "#8d5524", "#5c3a21"];
const HAIRS = ["#2b2b2b", "#3b2a20", "#6b4226", "#a0522d", "#e6c35c", "#b0b0b0", "#c0392b", "#5b7fb5"];
const CLOTHES = ["#c0392b", "#e67e22", "#f1c40f", "#27ae60", "#16a085", "#2980b9", "#8e44ad", "#e9e4d4", "#34495e", "#2f3640"];
const SHOES = ["#1e1e1e", "#5d4037", "#ffffff", "#c0392b"];
const STYLES: Appearance["hairStyle"][] = ["corto", "largo", "moño", "rapado", "rizado", "coleta"];
const ACCESSORIES: Appearance["accessory"][] = ["ninguno", "gafas", "barba", "auriculares", "gorro", "pajarita"];

const MODELS: { key: ModelChoice; label: string; hint: string }[] = [
  { key: "haiku", label: "Haiku", hint: "Rápido y ligero. Ideal para tareas sencillas." },
  { key: "sonnet", label: "Sonnet", hint: "Equilibrado. Bueno para coordinar y razonar." },
  { key: "opus", label: "Opus", hint: "Máxima capacidad para lo más complejo." },
];

const pick = <T,>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)];

function randomAppearance(): Appearance {
  return {
    skin: pick(SKINS),
    hair: pick(HAIRS),
    hairStyle: pick(STYLES),
    shirt: pick(CLOTHES),
    pants: pick(["#2f3640", "#34495e", "#5d4037", "#7f8c8d", "#1f3a5f"]),
    shoes: pick(SHOES),
    accessory: pick(ACCESSORIES),
  };
}

function Swatches({ value, options, onChange }: { value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <div className="swatches">
      {options.map((c) => (
        <button
          type="button"
          key={c}
          className={`swatch ${c === value ? "on" : ""}`}
          style={{ background: c }}
          onClick={() => onChange(c)}
          aria-label={c}
        />
      ))}
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="swatch-custom" title="Otro color" />
    </div>
  );
}

/** Crear o editar un agente: datos, carácter y aspecto. */
export function AgentForm({ agent, onClose, onSaved }: { agent?: Agent; onClose: () => void; onSaved?: (a: Agent) => void }) {
  const [name, setName] = useState(agent?.name ?? "");
  const [specialty, setSpecialty] = useState(agent?.specialty ?? "");
  const [instructions, setInstructions] = useState(agent?.instructions ?? "");
  const [model, setModel] = useState<ModelChoice>(agent?.model ?? "haiku");
  const [preset, setPreset] = useState(agent?.personality.preset ?? "entusiasta");
  const [description, setDescription] = useState(agent?.personality.description ?? "");
  const [voice, setVoice] = useState(agent?.personality.voice ?? "");
  const [admin, setAdmin] = useState(agent?.admin ?? false);
  const [look, setLook] = useState<Appearance>(() => agent?.appearance ?? randomAppearance());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const presetInfo = PERSONALITIES.find((p) => p.key === preset)!;
  const set = (patch: Partial<Appearance>) => setLook((l) => ({ ...l, ...patch }));

  async function save() {
    setSaving(true);
    setError("");
    try {
      const payload = { name, specialty, instructions, model, personality: { preset, description, voice }, appearance: look };
      let saved = agent
        ? await api<Agent>(`/api/agents/${agent.id}`, { method: "PATCH", json: { ...payload, admin } })
        : await api<Agent>("/api/agents", { method: "POST", json: payload });
      // El rol admin solo se activa editando (nunca al crear desde un agente).
      if (!agent && admin) saved = await api<Agent>(`/api/agents/${saved.id}`, { method: "PATCH", json: { admin: true } });
      onSaved?.(saved);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Backdrop onClick={onClose}>
      <form
        className="modal wide"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <header className="modal-head">
          <h2>{agent ? `Editar a ${agent.name}` : "Añadir agente"}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Cerrar">
            ×
          </button>
        </header>
        <div className="form-grid">
          <div className="form-col">
            <label>
              Nombre
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ana" disabled={agent?.isChief} required />
            </label>
            <label>
              Especialidad o ámbito
              <input
                value={specialty}
                onChange={(e) => setSpecialty(e.target.value)}
                placeholder="Finanzas personales: presupuesto, gastos y ahorro"
              />
              <span className="hint">Decide en qué le delegará Zen.</span>
            </label>
            <label>
              Instrucciones
              <textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                rows={4}
                placeholder="Cómo quieres que trabaje, qué debe tener en cuenta…"
              />
            </label>
            <fieldset className="models">
              <legend>Modelo</legend>
              {MODELS.map((m) => (
                <label key={m.key} className={`model-opt ${model === m.key ? "on" : ""}`}>
                  <input type="radio" name="model" checked={model === m.key} onChange={() => setModel(m.key)} />
                  <strong>{m.label}</strong>
                  <span>{m.hint}</span>
                </label>
              ))}
            </fieldset>
            <label>
              Personalidad
              <select value={preset} onChange={(e) => setPreset(e.target.value)}>
                {PERSONALITIES.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </select>
              <span className="hint">{presetInfo.description}</span>
            </label>
            {!agent?.isChief && (
              <label className={`admin-opt ${admin ? "on" : ""}`}>
                <span className="row">
                  <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} />
                  <strong>Rol admin: puede programar mejoras de Orden</strong>
                </span>
                <span className="hint">
                  Trabaja en una copia aparte del código (rama propia) con herramientas para leer, editar y pasar tests. Nunca toca la app en
                  marcha: sus cambios te llegan como propuesta y tú decides si se aplican (se validan, se fusionan y Orden se reinicia). Mejor
                  con Opus o Sonnet.
                </span>
              </label>
            )}
            <details className="custom-personality" open={Boolean(description || voice)}>
              <summary>Carácter a medida (opcional)</summary>
              <label>
                Descripción del carácter
                <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder={presetInfo.description} />
              </label>
              <label>
                Forma de hablar
                <input value={voice} onChange={(e) => setVoice(e.target.value)} placeholder={presetInfo.voice} />
              </label>
              <span className="hint">Si lo personalizas, se generan una sola vez frases de ambiente propias (con Haiku).</span>
            </details>
          </div>
          <div className="form-col look">
            <div className="look-preview">
              <AvatarPreview appearance={look} scale={4} />
              <AvatarPreview appearance={look} scale={4} view="back" />
            </div>
            <button type="button" className="btn ghost small" onClick={() => setLook(randomAppearance())}>
              Aspecto aleatorio
            </button>
            <div className="look-field">
              <span>Piel</span>
              <Swatches value={look.skin} options={SKINS} onChange={(skin) => set({ skin })} />
            </div>
            <div className="look-field">
              <span>Pelo</span>
              <Swatches value={look.hair} options={HAIRS} onChange={(hair) => set({ hair })} />
              <div className="seg">
                {STYLES.map((s) => (
                  <button type="button" key={s} className={look.hairStyle === s ? "on" : ""} onClick={() => set({ hairStyle: s })}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
            <div className="look-field">
              <span>Camiseta</span>
              <Swatches value={look.shirt} options={CLOTHES} onChange={(shirt) => set({ shirt })} />
            </div>
            <div className="look-field">
              <span>Pantalón</span>
              <Swatches value={look.pants} options={CLOTHES} onChange={(pants) => set({ pants })} />
            </div>
            <div className="look-field">
              <span>Zapatos</span>
              <Swatches value={look.shoes} options={SHOES} onChange={(shoes) => set({ shoes })} />
            </div>
            <div className="look-field">
              <span>Complemento</span>
              <div className="seg">
                {ACCESSORIES.map((a) => (
                  <button type="button" key={a} className={look.accessory === a ? "on" : ""} onClick={() => set({ accessory: a })}>
                    {a}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
        {error && <p className="bad-text">{error}</p>}
        <footer className="modal-foot">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" disabled={saving || !name.trim()}>
            {saving ? "Guardando…" : agent ? "Guardar cambios" : "Añadir al equipo"}
          </button>
        </footer>
      </form>
    </Backdrop>
  );
}
