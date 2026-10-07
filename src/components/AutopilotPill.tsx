"use client";

import { useState } from "react";
import { api } from "@/client/store";
import { useOrg } from "@/client/org";
import type { AutopilotSettings } from "@/lib/org/budget";

/** Indicador del piloto automático en la barra superior, con sus ajustes. */
export function AutopilotPill() {
  const [org] = useOrg();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  if (!org) return null;
  const { settings, verdict } = org.autopilot;
  // El piloto deja siempre un hueco del worker para el usuario.
  const workerMax = org.autopilot.workerMax ?? 3;
  const effective = Math.max(1, Math.min(settings.maxParallel, workerMax - 1));
  const working = org.backlog.filter((i) => i.status === "en_curso").length;
  const tone = !settings.enabled ? "" : verdict.allowed ? "ok" : "warn";
  const label = !settings.enabled ? "Piloto apagado" : verdict.allowed ? `Piloto · ${working} en marcha` : "Piloto en pausa";

  const save = (patch: Partial<AutopilotSettings>) => {
    setError("");
    api("/api/org/autopilot", { method: "PATCH", json: patch }).catch((e) => setError(e.message));
  };

  return (
    <span className="autopilot">
      <button className={`pill ${tone}`} title={verdict.reason} onClick={() => setOpen((o) => !o)}>
        <span className="dot" />
        <span className="pill-label">{label}</span>
      </button>
      {open && (
        <div className="autopilot-pop" role="dialog" aria-label="Piloto automático">
          <label className="switch-row">
            <span>
              <strong>Piloto automático</strong>
              <span className="muted small">El equipo trabaja por su cuenta con su cartera. Tus encargos siempre van primero.</span>
            </span>
            <span className="switch">
              <input type="checkbox" checked={settings.enabled} onChange={(e) => save({ enabled: e.target.checked })} />
              <span />
            </span>
          </label>
          <p className={`small ${verdict.allowed ? "ok-text" : "muted"}`}>{verdict.reason}</p>
          <div className="autopilot-grid">
            <label>
              Tope semanal
              <span className="row">
                <input type="number" min={5} max={100} defaultValue={settings.weeklyMax} onBlur={(e) => save({ weeklyMax: Number(e.target.value) })} /> %
              </span>
              <span className="hint">Repartido por días{verdict.weeklyAllowance !== null ? `: hoy hasta el ${verdict.weeklyAllowance} %` : ""}.</span>
            </label>
            <label>
              Tope por sesión (5 h)
              <span className="row">
                <input type="number" min={5} max={100} defaultValue={settings.sessionMax} onBlur={(e) => save({ sessionMax: Number(e.target.value) })} /> %
              </span>
              <span className="hint">El resto queda para ti.</span>
            </label>
            <label>
              A la vez
              <span className="row">
                <input type="number" min={1} max={5} defaultValue={settings.maxParallel} onBlur={(e) => save({ maxParallel: Number(e.target.value) })} /> encargos
              </span>
              <span className="hint">
                {effective < settings.maxParallel
                  ? `Ahora van ${effective}: el worker admite ${workerMax} a la vez y uno queda para ti. Sube ORDEN_MAX_CONCURRENCY en .env (p. ej. a ${settings.maxParallel + 1}) y reinicia.`
                  : "Siempre queda un hueco libre para ti."}
              </span>
            </label>
          </div>
          {error && <p className="bad-text small">{error}</p>}
        </div>
      )}
    </span>
  );
}
