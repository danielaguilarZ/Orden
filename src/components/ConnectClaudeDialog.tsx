"use client";

import { Backdrop } from "./Backdrop";
import { useEffect, useState } from "react";
import { api, refreshClaude, useStore } from "@/client/store";
import type { LoginSnapshot } from "@/lib/claude/login";

/** Diálogo «Conectar con Claude»: lanza `claude auth login` en el servidor local. */
export function ConnectClaudeDialog({ onClose }: { onClose: () => void }) {
  const claude = useStore((s) => s.claude);
  const [login, setLogin] = useState<LoginSnapshot | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const running = login?.state === "running" || login?.state === "waiting_code";

  useEffect(() => {
    api<LoginSnapshot>("/api/claude/login").then(setLogin).catch(() => {});
  }, []);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(async () => {
      const snap = await api<LoginSnapshot>("/api/claude/login").catch(() => null);
      if (!snap) return;
      setLogin(snap);
      if (snap.state === "success") refreshClaude(true);
    }, 1000);
    return () => clearInterval(t);
  }, [running]);

  async function act(action: "start" | "code" | "cancel") {
    setError("");
    try {
      const snap = await api<LoginSnapshot>("/api/claude/login", { method: "POST", json: { action, code } });
      setLogin(snap);
      if (action === "code") setCode("");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Backdrop onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Conectar con Claude">
        <header className="modal-head">
          <h2>Conexión con Claude</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Cerrar">
            ×
          </button>
        </header>

        <div className="claude-status">
          {claude?.connected ? (
            <p className="ok-text">
              Conectado como <strong>{claude.email}</strong>
              {claude.plan && <> · plan {claude.plan}</>} · modo {claude.mode === "subscription" ? "suscripción" : "API key"}
            </p>
          ) : (
            <p className="bad-text">{claude?.error ?? "No hay sesión de Claude activa en este PC."}</p>
          )}
          <button className="btn ghost small" onClick={() => refreshClaude(true)}>
            Comprobar de nuevo
          </button>
        </div>

        {claude?.mode === "apikey" ? (
          <p className="muted">
            Estás en modo API key (<code>ORDEN_AUTH_MODE=apikey</code>). Configura <code>ANTHROPIC_API_KEY</code> en <code>.env</code>.
          </p>
        ) : (
          <>
            <p className="muted">
              Inicia sesión con tu cuenta de Claude (Pro/Max). Se abrirá el navegador para autorizar; si no se abre, usa el enlace.
            </p>
            {!running && (
              <button className="btn primary" onClick={() => act("start")}>
                {claude?.connected ? "Volver a conectar" : "Conectar con Claude"}
              </button>
            )}
            {running && (
              <div className="login-progress">
                <p>
                  <span className="spinner" /> Esperando la autorización…
                </p>
                {login?.url && (
                  <a className="btn ghost" href={login.url} target="_blank" rel="noreferrer">
                    Abrir el enlace de autorización
                  </a>
                )}
                <form
                  className="code-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    act("code");
                  }}
                >
                  <input
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder={login?.state === "waiting_code" ? "Pega aquí el código" : "Código (si te lo pide)"}
                  />
                  <button className="btn" disabled={!code.trim()}>
                    Enviar código
                  </button>
                </form>
                <button className="btn ghost small" onClick={() => act("cancel")}>
                  Cancelar
                </button>
              </div>
            )}
            {login?.state === "success" && <p className="ok-text">¡Listo! Sesión iniciada.</p>}
            {login?.state === "error" && <p className="bad-text">{login.error}</p>}
            {login?.output && (
              <details className="login-log">
                <summary>Salida del proceso</summary>
                <pre>{login.output}</pre>
              </details>
            )}
          </>
        )}
        {error && <p className="bad-text">{error}</p>}
        <p className="muted small">
          Alternativa por terminal: <code>npm run claude:login</code> · <code>npm run claude:status</code>
        </p>
      </div>
    </Backdrop>
  );
}
