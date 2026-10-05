"use client";

import { useCallback, useEffect, useState } from "react";
import { api, onEvent, useStore } from "@/client/store";
import type { OAuthState, ServiceInfo } from "@/lib/connections/registry";
import { UPCOMING_SERVICES } from "@/lib/connections/catalog";
import type { AuthMode, GrantLevel, PublicConnection } from "@/lib/repo/connections";
import { useMounted } from "./panels/common";

type ConnView = PublicConnection & { oauth: OAuthState | null };

interface Data {
  services: ServiceInfo[];
  connections: ConnView[];
}

/** Valor de configuración como texto (las listas, separadas por comas). */
const fieldText = (v: unknown) => (Array.isArray(v) ? v.join(", ") : String(v ?? ""));

const AUTH_LABEL: Record<AuthMode, string> = {
  auto: "Automático: gh si está disponible; si no, el token",
  gh: "Solo GitHub CLI (gh)",
  token: "Solo token guardado",
};

/** Conexiones con servicios externos (GitHub…) y permisos de cada agente. */
export function ConnectionsPage() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(() => api<Data>("/api/connections").then(setData, (e: Error) => setError(e.message)), []);

  useEffect(() => {
    // Vuelta de la autorización de Google (?google=ok|error&msg=…).
    const q = new URLSearchParams(window.location.search);
    const g = q.get("google");
    if (g) {
      setNotice({ ok: g === "ok", text: q.get("msg") ?? "" });
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  useEffect(() => {
    load();
    return onEvent((e) => {
      if (e.type === "connection.updated" || e.type.startsWith("agent.")) load();
    });
  }, [load]);

  return (
    <div className="board connections">
      <div className="board-bar">
        <h1>Conexiones</h1>
        <span className="muted">Servicios externos que pueden usar los agentes, y con qué permiso.</span>
      </div>
      {error && <p className="bad-text">{error}</p>}
      {notice && <p className={`conn-result ${notice.ok ? "ok-text" : "bad-text"}`}>{notice.text}</p>}
      {!data && !error && <p className="muted">Cargando…</p>}
      {data && (
        <>
          {data.connections.length === 0 && <p className="muted">Todavía no hay conexiones. Elige una abajo: cada ficha explica cómo conectarla.</p>}
          {data.connections.map((c) => (
            <ConnectionCard key={c.id} conn={c} service={data.services.find((s) => s.key === c.service)} onChange={load} />
          ))}
          <AddConnection services={data.services} onAdded={load} />
        </>
      )}
    </div>
  );
}

function ConnectionCard({ conn, service, onChange }: { conn: ConnView; service?: ServiceInfo; onChange: () => void }) {
  const agents = useStore((s) => s.agents);
  const mounted = useMounted();
  const [token, setToken] = useState("");
  const [client, setClient] = useState({ clientId: "", clientSecret: "" });
  const [config, setConfig] = useState<Record<string, string>>(() => Object.fromEntries((service?.fields ?? []).map((f) => [f.key, fieldText(conn.config[f.key])])));
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState("");
  const oauth = service?.authKind === "oauth";

  const patch = async (b: Record<string, unknown>) => {
    setResult(null);
    try {
      await api(`/api/connections/${conn.id}`, { method: "PATCH", json: b });
      onChange();
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    }
  };
  const action = async (accion: "probar" | "actualizar" | "autorizar" | "desconectar") => {
    if (accion === "desconectar" && !confirm("¿Retirar la autorización de Google? Los agentes dejarán de ver el calendario.")) return;
    setBusy(accion);
    setResult(null);
    try {
      const r = await api<{ ok: boolean; text?: string; url?: string }>(`/api/connections/${conn.id}`, { method: "POST", json: { accion } });
      // Autorizar: se va a Google y vuelve sola a esta página.
      if (r.url) {
        window.location.assign(r.url);
        return;
      }
      setResult({ ok: r.ok, text: r.text ?? "" });
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    } finally {
      setBusy("");
      onChange();
    }
  };
  const remove = async () => {
    if (!confirm(`¿Eliminar la conexión «${conn.name}»? Los agentes perderán el acceso.`)) return;
    await api(`/api/connections/${conn.id}`, { method: "DELETE" });
    onChange();
  };

  const dirty = (service?.fields ?? []).some((f) => config[f.key] !== fieldText(conn.config[f.key]));

  return (
    <section className={`conn-card ${conn.enabled ? "" : "off"}`}>
      <header className="conn-head">
        <span className="conn-logo" aria-hidden>
          {service?.label.slice(0, 2) ?? "?"}
        </span>
        <div>
          <h2>{conn.name}</h2>
          <span className="muted small">{service?.description}</span>
        </div>
        <span style={{ flex: 1 }} />
        <label className="conn-toggle">
          <input type="checkbox" checked={conn.enabled} onChange={(e) => patch({ enabled: e.target.checked })} /> Activa
        </label>
        <button className="btn ghost small danger" onClick={remove}>
          Eliminar
        </button>
      </header>
      {Boolean(service?.steps?.length) && (
        <details className="conn-steps" open={Boolean(service?.supportsSecret && !conn.hasSecret)}>
          <summary>Cómo conectarla</summary>
          <ol>
            {service!.steps!.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </details>
      )}

      <div className="conn-grid">
        <div className="conn-block">
          <h3>Configuración</h3>
          {(service?.fields ?? []).map((f) => (
            <label key={f.key} className="conn-field">
              <span>{f.label}</span>
              <input value={config[f.key] ?? ""} placeholder={f.placeholder} onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })} />
            </label>
          ))}
          {dirty && (
            <button className="btn small primary" onClick={() => patch({ config })}>
              Guardar
            </button>
          )}

          {oauth && conn.oauth && (
            <>
              <h3>Acceso (OAuth, solo lectura)</h3>
              <div className="conn-field">
                <span>Cliente OAuth</span>
                {conn.oauth.clientConfigured ? <span className="tag gold">Guardado (cifrado) {conn.oauth.clientIdHint}</span> : <span className="muted small">Ninguno</span>}
              </div>
              <form
                className="conn-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!client.clientId.trim()) return;
                  patch({ oauthClient: client }).then(() => setClient({ clientId: "", clientSecret: "" }));
                }}
              >
                <input autoComplete="off" value={client.clientId} placeholder="Client ID (…apps.googleusercontent.com) o pega el JSON" onChange={(e) => setClient({ ...client, clientId: e.target.value })} />
                <input type="password" autoComplete="off" value={client.clientSecret} placeholder="Client secret" onChange={(e) => setClient({ ...client, clientSecret: e.target.value })} />
                <button className="btn small" disabled={!client.clientId.trim()}>
                  Guardar credenciales
                </button>
              </form>
              <div className="conn-field">
                <span>Cuenta</span>
                {conn.oauth.authorized ? (
                  <span className="conn-token">
                    <span className="tag gold">Autorizada{conn.oauth.account ? ` · ${conn.oauth.account}` : ""}</span>
                    <button className="btn ghost small" disabled={busy !== ""} onClick={() => action("desconectar")}>
                      Desconectar
                    </button>
                  </span>
                ) : (
                  <span className="muted small">Sin autorizar</span>
                )}
              </div>
              <div className="conn-row">
                <button className="btn small primary" disabled={busy !== "" || !conn.oauth.clientConfigured} onClick={() => action("autorizar")}>
                  {busy === "autorizar" ? "Abriendo Google…" : conn.oauth.authorized ? "Volver a autorizar" : "Autorizar con Google"}
                </button>
              </div>
              <p className="muted small">
                En Google Cloud: activa la <em>Google Calendar API</em>, crea un cliente OAuth de tipo <em>Aplicación de escritorio</em> y pega aquí su Client ID y secret (o el
                JSON descargado). Solo se pide el permiso <em>calendar.readonly</em>: Orden no puede crear, cambiar ni borrar eventos.
              </p>
            </>
          )}

          {!oauth && conn.service === "github" && (
            <>
              <h3>Acceso</h3>
              <label className="conn-field">
                <span>Cómo entra</span>
                <select value={conn.auth} onChange={(e) => patch({ auth: e.target.value })}>
                  {(Object.keys(AUTH_LABEL) as AuthMode[]).map((k) => (
                    <option key={k} value={k}>
                      {AUTH_LABEL[k]}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          {service?.supportsSecret && (
            <>
              <div className="conn-field">
                <span>{service.secretLabel ?? "Token"}</span>
                {conn.hasSecret ? (
                  <span className="conn-token">
                    <span className="tag gold">Guardado (cifrado) {conn.secretHint}</span>
                    <button className="btn ghost small" onClick={() => patch({ token: null })}>
                      Borrar
                    </button>
                  </span>
                ) : (
                  <span className="muted small">Ninguno</span>
                )}
              </div>
              <form
                className="conn-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!token.trim()) return;
                  patch({ token }).then(() => setToken(""));
                }}
              >
                <input
                  type="password"
                  autoComplete="off"
                  value={token}
                  placeholder={conn.hasSecret ? "Sustituir…" : (service.secretPlaceholder ?? "github_pat_…")}
                  onChange={(e) => setToken(e.target.value)}
                />
                <button className="btn small" disabled={!token.trim()}>
                  Guardar (cifrado)
                </button>
              </form>
              {conn.service === "github" && (
                <p className="muted small">
                  Token fine-grained limitado a este repo con permisos <em>Contents</em>, <em>Issues</em> y <em>Pull requests</em> en lectura y escritura (y <em>Metadata</em> en
                  lectura). Se guarda cifrado y nunca se muestra entero.
                </p>
              )}
            </>
          )}
          <div className="conn-row">
            <button className="btn small" disabled={busy !== ""} onClick={() => action("probar")}>
              {busy === "probar" ? "Probando…" : "Probar conexión"}
            </button>
          </div>
        </div>

        <div className="conn-block">
          <h3>Permisos por agente</h3>
          <table className="conn-grants">
            <tbody>
              {agents.map((a) => (
                <tr key={a.id}>
                  <td>{a.name}</td>
                  <td>
                    <select
                      value={conn.grants[a.id] ?? ""}
                      onChange={(e) => patch({ grants: { [a.id]: (e.target.value || null) as GrantLevel | null } })}
                    >
                      <option value="">Sin acceso</option>
                      <option value="lectura">Lectura</option>
                      {!service?.readOnly && <option value="completo">Completo</option>}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {service && (
            <ul className="muted small conn-levels">
              <li>{service.levels.lectura}</li>
              {!service.readOnly && <li>{service.levels.completo}</li>}
            </ul>
          )}

          {oauth && (
            <>
              <h3>Volcado al panel «Calendario»</h3>
              <label className="conn-toggle">
                <input type="checkbox" checked={conn.config.panel !== false} onChange={(e) => patch({ config: { panel: e.target.checked } })} /> Volcar cada 30 min (de hace 7
                días a dentro de 60), sin duplicar y sin gastar uso de Claude
              </label>
              <p className="small muted">
                Último volcado: {conn.lastSyncAt && mounted ? new Date(conn.lastSyncAt).toLocaleString("es-ES") : "nunca"}
                {conn.lastError && <span className="bad-text"> · {conn.lastError}</span>}
              </p>
              <button className="btn small" disabled={busy !== "" || !conn.oauth?.authorized} onClick={() => action("actualizar")}>
                {busy === "actualizar" ? "Volcando…" : "Volcar ahora"}
              </button>
            </>
          )}

          {conn.service === "github" && (
            <>
              <h3>Panel «Estado del repo»</h3>
              <label className="conn-toggle">
                <input type="checkbox" checked={conn.config.panel !== false} onChange={(e) => patch({ config: { panel: e.target.checked } })} /> Mantenerlo al día (cada 10
                min, sin gastar uso de Claude)
              </label>
              <p className="small muted">
                Última comprobación: {conn.lastSyncAt && mounted ? new Date(conn.lastSyncAt).toLocaleString("es-ES") : "nunca"}
                {conn.lastError && <span className="bad-text"> · {conn.lastError}</span>}
              </p>
              <button className="btn small" disabled={busy !== ""} onClick={() => action("actualizar")}>
                {busy === "actualizar" ? "Actualizando…" : "Actualizar ahora"}
              </button>
            </>
          )}
        </div>
      </div>
      {result && <p className={`conn-result ${result.ok ? "ok-text" : "bad-text"}`}>{result.text}</p>}
    </section>
  );
}

/** Catálogo: las disponibles se eligen y se añaden; las que vendrán muestran su ficha. */
function AddConnection({ services, onAdded }: { services: ServiceInfo[]; onAdded: () => void }) {
  const [service, setService] = useState("");
  const [config, setConfig] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const s = services.find((x) => x.key === service);
  return (
    <section className="conn-card conn-add">
      <h3>Añadir conexión</h3>
      <div className="conn-catalog">
        {services.map((x) => (
          <button
            key={x.key}
            type="button"
            className={`conn-pick ${service === x.key ? "on" : ""}`}
            onClick={() => {
              setService(service === x.key ? "" : x.key);
              setConfig({});
              setError("");
            }}
          >
            <strong>{x.label}</strong>
            <small>{x.description}</small>
            <span className="tag">{x.readOnly ? "Solo lectura" : x.authKind === "oauth" ? "OAuth" : x.supportsSecret ? "Token cifrado" : "Sin credenciales"}</span>
          </button>
        ))}
        {UPCOMING_SERVICES.map((x) => (
          <div key={x.key} className="conn-pick soon" title={x.plan}>
            <strong>{x.label}</strong>
            <small>{x.description}</small>
            <small className="conn-plan">{x.plan}</small>
            <span className="tag">Próximamente</span>
          </div>
        ))}
      </div>
      {s && (
        <form
          className="conn-add-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setError("");
            try {
              await api("/api/connections", { method: "POST", json: { service, config } });
              setConfig({});
              setService("");
              onAdded();
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        >
          {Boolean(s.steps?.length) && (
            <ol className="conn-steps-list">
              {s.steps!.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          )}
          <div className="conn-row">
            {s.fields.map((f) => (
              <input key={f.key} aria-label={f.label} value={config[f.key] ?? ""} placeholder={f.placeholder ?? f.label} onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })} />
            ))}
            <button className="btn small primary">Añadir {s.label}</button>
          </div>
          {error && <p className="bad-text small">{error}</p>}
        </form>
      )}
    </section>
  );
}
