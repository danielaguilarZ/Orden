"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/client/store";
import type { LoginInfo, PollResult, PublicPending } from "@/lib/connections/github/login";

const LOGIN_URL = "/api/connections/github/login";

/** Dónde se crea la OAuth App de la que sale el Client ID (una sola vez). */
const NEW_APP_URL = "https://github.com/settings/applications/new";

/**
 * «Iniciar sesión con GitHub»: un botón que da a los agentes acceso a todos
 * los repositorios de tu cuenta. GitHub enseña un código, lo escribes en su
 * página y Orden se entera solo (flujo de dispositivo). Si falta el Client ID
 * de la OAuth App, lo pide una sola vez.
 */
export function GithubLogin({ onDone }: { onDone: (connectionId: string, account: string) => void }) {
  const [info, setInfo] = useState<LoginInfo | null>(null);
  const [pending, setPending] = useState<PublicPending | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [clientId, setClientId] = useState("");
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const i = await api<LoginInfo>(LOGIN_URL);
      setInfo(i);
      setPending(i.pending);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Mientras hay un código en curso, pregunta a Orden (y este a GitHub) cada `interval` segundos.
  const code = pending?.userCode;
  useEffect(() => {
    if (!pending) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const r = await api<PollResult>(LOGIN_URL, { method: "POST", json: { accion: "comprobar" } });
        if (stop) return;
        if (r.status === "pendiente") timer = setTimeout(tick, r.interval * 1000);
        else if (r.status === "ok") {
          setPending(null);
          load();
          onDone(r.connectionId, r.account);
        } else {
          setPending(null);
          setError(r.text);
        }
      } catch (e) {
        if (!stop) {
          setPending(null);
          setError((e as Error).message);
        }
      }
    };
    timer = setTimeout(tick, pending.interval * 1000);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
    // Solo se reinicia cuando cambia el código, no con cada actualización de `pending`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  const run = async (fn: () => Promise<void>) => {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const start = () =>
    run(async () => {
      const r = await api<{ pending: PublicPending; info: LoginInfo }>(LOGIN_URL, { method: "POST", json: { accion: "iniciar" } });
      setInfo(r.info);
      setPending(r.pending);
      setCopied(false);
      // Puede que el navegador bloquee la ventana (no viene de un clic directo): hay enlace debajo.
      window.open(r.pending.verificationUri, "_blank", "noopener");
    });

  const cancel = () =>
    run(async () => {
      await api(LOGIN_URL, { method: "POST", json: { accion: "cancelar" } });
      setPending(null);
    });

  const saveClient = () =>
    run(async () => {
      setInfo(await api<LoginInfo>(LOGIN_URL, { method: "POST", json: { accion: "cliente", clientId } }));
      setClientId("");
      setEditing(false);
    });

  const copy = async () => {
    if (!pending) return;
    try {
      await navigator.clipboard.writeText(pending.userCode);
      setCopied(true);
    } catch {
      /* sin portapapeles: el código se ve en pantalla */
    }
  };

  const needsClient = info && (!info.clientConfigured || editing);

  return (
    <div className="gh-login">
      {info?.connected && !pending && (
        <p className="small ok-text">
          Sesión iniciada: <strong>{info.connected.name}</strong>
        </p>
      )}

      {!pending && info?.clientConfigured && (
        <>
          <button type="button" className="btn primary gh-login-btn" disabled={busy} onClick={start}>
            {busy ? "Conectando…" : info.connected ? "Volver a iniciar sesión con GitHub" : "Iniciar sesión con GitHub"}
          </button>
          <p className="muted small">
            Da acceso a <strong>todos tus repositorios</strong> (públicos y privados, lectura y escritura). Luego eliges qué agente lo usa y con qué nivel; los cambios de código
            siempre van por rama y pull request, nunca a la rama principal.
          </p>
        </>
      )}

      {pending && (
        <div className="gh-code">
          <p>
            1. Copia este código:{" "}
            <strong className="gh-code-value" data-testid="gh-code">
              {pending.userCode}
            </strong>{" "}
            <button type="button" className="btn small ghost" onClick={copy}>
              {copied ? "Copiado" : "Copiar"}
            </button>
          </p>
          <p>
            2. Pégalo en{" "}
            <a href={pending.verificationUri} target="_blank" rel="noreferrer">
              github.com/login/device
            </a>{" "}
            e inicia sesión y autoriza a Orden.
          </p>
          <p className="muted small">
            <span className="spinner" /> Esperando a que autorices… (el código caduca en unos 15 minutos){" "}
            <button type="button" className="btn small ghost" disabled={busy} onClick={cancel}>
              Cancelar
            </button>
          </p>
        </div>
      )}

      {needsClient && (
        <div className="gh-client">
          {!info.clientConfigured && (
            <p className="small">
              Para activar el botón hace falta una <strong>OAuth App de GitHub</strong> (se crea una sola vez, un minuto):
            </p>
          )}
          <ol className="muted small gh-steps">
            <li>
              Entra en{" "}
              <a href={NEW_APP_URL} target="_blank" rel="noreferrer">
                github.com/settings/applications/new
              </a>
              .
            </li>
            <li>
              Nombre «Orden»; en <em>Homepage URL</em> y <em>Authorization callback URL</em> pon <code>http://127.0.0.1:3000</code>.
            </li>
            <li>
              Marca <strong>Enable Device Flow</strong> y pulsa «Register application».
            </li>
            <li>Copia el <strong>Client ID</strong> (no hace falta el secreto) y pégalo aquí.</li>
          </ol>
          <form
            className="conn-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (clientId.trim()) saveClient();
            }}
          >
            <input autoComplete="off" value={clientId} placeholder="Client ID de la OAuth App" onChange={(e) => setClientId(e.target.value)} />
            <button className="btn small" disabled={busy || !clientId.trim()}>
              Guardar
            </button>
            {info.clientConfigured && (
              <button type="button" className="btn small ghost" onClick={() => setEditing(false)}>
                Cancelar
              </button>
            )}
          </form>
        </div>
      )}

      {info?.clientConfigured && !editing && !pending && info.clientSource === "ajustes" && (
        <p className="muted small">
          Client ID guardado {info.clientIdHint}{" "}
          <button type="button" className="btn small ghost" onClick={() => setEditing(true)}>
            Cambiar
          </button>
        </p>
      )}

      {error && <p className="bad-text small">{error}</p>}
    </div>
  );
}
