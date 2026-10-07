"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ConnField } from "./ConnField";
import { api, onEvent, useStore } from "@/client/store";
import type { ServiceInfo } from "@/lib/connections/registry";
import { UPCOMING_SERVICES } from "@/lib/connections/catalog";
import { categoryLabel, connectionSections, connectionStatus, grantCount, serviceCategory, serviceMonogram, type CatalogItem, type ConnView, type StatusTone } from "@/lib/connections/view";
import type { AuthMode, GrantLevel } from "@/lib/repo/connections";
import { Backdrop } from "./Backdrop";
import { SearchBox } from "./ui/kit";

type Accion = "probar" | "autorizar" | "desconectar";

interface Data {
  services: ServiceInfo[];
  connections: ConnView[];
}

/** Qué ventana está abierta: una conexión, un servicio para añadir o uno que vendrá. */
type Abierta = { tipo: "conexion"; id: string } | { tipo: "nueva"; key: string } | { tipo: "pronto"; key: string };

/** Valor de configuración como texto (las listas, separadas por comas). */
const fieldText = (v: unknown) => (Array.isArray(v) ? v.join(", ") : String(v ?? ""));

const AUTH_LABEL: Record<AuthMode, string> = {
  auto: "Automático (gh o token)",
  gh: "Solo GitHub CLI (gh)",
  token: "Solo token",
};

const GITHUB_TOKEN_HINT = "Token fine-grained limitado al repo: Contents, Issues y Pull requests (lectura y escritura) y Metadata (lectura).";

/**
 * Conexiones con servicios externos: tarjetas del mismo tamaño en tres
 * secciones (activas, disponibles y próximamente). Al pulsar una tarjeta se
 * abre su ventana con todo lo que necesita (campos, credenciales y permisos).
 */
export function ConnectionsPage() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [query, setQuery] = useState("");
  const [abierta, setAbierta] = useState<Abierta | null>(null);
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

  const sections = useMemo(() => (data ? connectionSections(data.services, data.connections, UPCOMING_SERVICES, query) : null), [data, query]);
  const close = useCallback(() => setAbierta(null), []);

  const conn = abierta?.tipo === "conexion" ? data?.connections.find((c) => c.id === abierta.id) : undefined;
  const nueva = abierta?.tipo === "nueva" ? data?.services.find((s) => s.key === abierta.key) : undefined;
  const pronto = abierta?.tipo === "pronto" ? sections?.proximamente.find((u) => u.key === abierta.key) : undefined;

  return (
    <div className="board connections">
      <div className="board-bar">
        <h1>Conexiones</h1>
        <span className="muted">Servicios que pueden usar los agentes.</span>
        <span style={{ flex: 1 }} />
        <SearchBox value={query} onChange={setQuery} placeholder="Buscar servicio…" />
      </div>
      {error && <p className="bad-text">{error}</p>}
      {notice && <p className={`conn-notice ${notice.ok ? "ok-text" : "bad-text"}`}>{notice.text}</p>}
      {!data && !error && <p className="muted">Cargando…</p>}
      {sections && (
        <>
          <ConnSection title="Activas" count={sections.activas.length} empty={query ? "Ninguna activa coincide." : "Ninguna todavía: elige una de las disponibles."}>
            {sections.activas.map((a) => (
              <ConnCard
                key={a.conn.id}
                tone={a.status.tone}
                monogram={a.monogram}
                title={a.conn.name}
                subtitle={a.service && a.service.label !== a.conn.name ? a.service.label : categoryLabel(serviceCategory(a.conn.service, a.service?.category))}
                description={a.service?.description}
                onClick={() => setAbierta({ tipo: "conexion", id: a.conn.id })}
                foot={
                  <>
                    <span className={`conn-status ${a.status.tone}`} title={a.conn.lastError ?? undefined}>
                      <span className="dot" />
                      {a.status.label}
                    </span>
                    <span className="muted">{agentsText(grantCount(a.conn))}</span>
                  </>
                }
              />
            ))}
          </ConnSection>

          <ConnSection title="Disponibles" count={sections.disponibles.length} empty="Nada coincide.">
            {sections.disponibles.map((it) => (
              <ConnCard
                key={it.key}
                monogram={it.monogram}
                title={it.label}
                subtitle={categoryLabel(it.category)}
                description={it.description}
                onClick={() => setAbierta({ tipo: "nueva", key: it.key })}
                foot={
                  <>
                    <span className="tag">{it.tag}</span>
                    {it.connected > 0 && <span className="muted">{it.connected === 1 ? "1 activa" : `${it.connected} activas`}</span>}
                  </>
                }
              />
            ))}
          </ConnSection>

          <ConnSection title="Próximamente" count={sections.proximamente.length} empty="Nada coincide." soon>
            {sections.proximamente.map((it) => (
              <ConnCard
                key={it.key}
                soon
                monogram={it.monogram}
                title={it.label}
                subtitle={categoryLabel(it.category)}
                description={it.description}
                onClick={() => setAbierta({ tipo: "pronto", key: it.key })}
                foot={<span className="tag">Próximamente</span>}
              />
            ))}
          </ConnSection>
        </>
      )}

      {conn && <ConnectionModal key={conn.id} conn={conn} service={data?.services.find((s) => s.key === conn.service)} onClose={close} onChange={load} />}
      {nueva && (
        <AddModal
          service={nueva}
          onClose={close}
          onAdded={async (id) => {
            await load();
            setAbierta({ tipo: "conexion", id });
          }}
        />
      )}
      {pronto && <UpcomingModal item={pronto} onClose={close} />}
    </div>
  );
}

const agentsText = (n: number) => (n === 0 ? "Sin agentes" : n === 1 ? "1 agente" : `${n} agentes`);

/** Sección de la pestaña: título, contador y cuadrícula uniforme de tarjetas. */
function ConnSection({ title, count, empty, soon, children }: { title: string; count: number; empty: string; soon?: boolean; children: ReactNode }) {
  return (
    <section className={`conn-block${soon ? " soon" : ""}`}>
      <h3 className="conn-section">
        {title}
        <span className="conn-count">{count}</span>
      </h3>
      {count === 0 ? <p className="muted small">{empty}</p> : <div className="conn-grid">{children}</div>}
    </section>
  );
}

/** Tarjeta de tamaño fijo: monograma, nombre, subtítulo, dos líneas de descripción y pie. */
function ConnCard({
  monogram,
  title,
  subtitle,
  description,
  foot,
  tone,
  soon,
  onClick,
}: {
  monogram: string;
  title: string;
  subtitle?: string;
  description?: string;
  foot: ReactNode;
  /** Solo las activas: contorno según su estado (verde si funciona). */
  tone?: StatusTone;
  soon?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className={`conn-card${tone ? ` active tone-${tone}` : ""}${soon ? " soon" : ""}`} onClick={onClick} title={description}>
      <span className="conn-card-head">
        <span className="conn-mono" aria-hidden>
          {monogram}
        </span>
        <span className="conn-card-title">
          <strong>{title}</strong>
          {subtitle && <small>{subtitle}</small>}
        </span>
      </span>
      <span className="conn-card-desc">{description}</span>
      <span className="conn-card-foot">{foot}</span>
    </button>
  );
}

/** Ventana común de la pestaña: cabecera con monograma y botón de cerrar. */
function ConnModal({ monogram, title, subtitle, side, onClose, children, foot }: { monogram: string; title: string; subtitle?: ReactNode; side?: ReactNode; onClose: () => void; children: ReactNode; foot: ReactNode }) {
  return (
    <Backdrop onClick={onClose}>
      <div className="modal conn-modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header className="modal-head conn-modal-head">
          <span className="conn-mono big" aria-hidden>
            {monogram}
          </span>
          <div className="conn-modal-title">
            <h2>{title}</h2>
            {subtitle && <small className="muted">{subtitle}</small>}
          </div>
          {side}
          <button type="button" className="icon-btn" aria-label="Cerrar" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="conn-modal-body">{children}</div>
        <footer className="modal-foot conn-modal-foot">{foot}</footer>
      </div>
    </Backdrop>
  );
}

/** Pasos para conectarla (desplegados si aún falta configurarla). */
function Steps({ steps, open }: { steps?: string[]; open?: boolean }) {
  if (!steps?.length) return null;
  return (
    <details className="conn-steps" open={open}>
      <summary>Cómo conectarla</summary>
      <ol>
        {steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
    </details>
  );
}

/** Ventana de una conexión activa: nombre, configuración, credenciales, permisos y acciones. */
function ConnectionModal({ conn, service, onClose, onChange }: { conn: ConnView; service?: ServiceInfo; onClose: () => void; onChange: () => void }) {
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState("");
  const oauth = service?.authKind === "oauth";
  const status = connectionStatus(conn, service);

  const patch = async (b: Record<string, unknown>) => {
    setResult(null);
    try {
      await api(`/api/connections/${conn.id}`, { method: "PATCH", json: b });
      onChange();
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    }
  };
  const action = async (accion: Accion) => {
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
    try {
      await api(`/api/connections/${conn.id}`, { method: "DELETE" });
      onClose();
      onChange();
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    }
  };

  return (
    <ConnModal
      monogram={serviceMonogram(conn.service, service?.label ?? conn.name)}
      title={conn.name}
      subtitle={service && service.label !== conn.name ? service.label : undefined}
      side={
        <span className={`conn-status ${status.tone}`} title={conn.lastError ?? undefined}>
          <span className="dot" />
          {busy ? <span className="spinner" /> : status.label}
        </span>
      }
      onClose={onClose}
      foot={
        <>
          <button type="button" className="btn ghost danger" onClick={remove}>
            Eliminar
          </button>
          <span style={{ flex: 1 }} />
          {oauth && conn.oauth?.authorized && (
            <button type="button" className="btn ghost danger" disabled={busy !== ""} onClick={() => action("desconectar")}>
              Desconectar Google
            </button>
          )}
          <button type="button" className="btn ghost" onClick={() => patch({ enabled: !conn.enabled })}>
            {conn.enabled ? "Pausar" : "Activar"}
          </button>
          <button type="button" className="btn primary" disabled={busy !== ""} onClick={() => action("probar")}>
            {busy === "probar" ? "Probando…" : "Probar conexión"}
          </button>
        </>
      }
    >
      {result && <p className={`conn-result small ${result.ok ? "ok-text" : "bad-text"}`}>{result.text}</p>}
      {service?.description && <p className="muted small conn-desc">{service.description}</p>}
      <Steps steps={service?.steps} open={status.needsSetup} />

      <div className="conn-modal-section">
        <h3>Configuración</h3>
        <NameField conn={conn} patch={patch} />
        <ConfigFields conn={conn} service={service} patch={patch} />
      </div>

      {(service?.supportsSecret || oauth || conn.service === "github") && (
        <div className="conn-modal-section">
          <h3>Acceso</h3>
          <Credentials conn={conn} service={service} busy={busy} patch={patch} action={action} />
        </div>
      )}

      <div className="conn-modal-section">
        <h3>
          Permisos de los agentes <span className="muted">{agentsText(grantCount(conn))}</span>
        </h3>
        <Grants conn={conn} service={service} patch={patch} />
      </div>

      {conn.lastError && <p className="bad-text small">Último error: {conn.lastError}</p>}
    </ConnModal>
  );
}

/** Nombre de la conexión: se guarda al salir del campo o con Intro. */
function NameField({ conn, patch }: { conn: ConnView; patch: (b: Record<string, unknown>) => Promise<void> }) {
  const [name, setName] = useState(conn.name);
  const commit = () => {
    const n = name.trim();
    if (!n) setName(conn.name);
    else if (n !== conn.name) patch({ name: n });
  };
  return (
    <label className="conn-field">
      <span>Nombre</span>
      <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
    </label>
  );
}

/** Campos propios del servicio (URL, repo, temas…), con «Guardar» si hay cambios. */
function ConfigFields({ conn, service, patch }: { conn: ConnView; service?: ServiceInfo; patch: (b: Record<string, unknown>) => Promise<void> }) {
  const fields = service?.fields ?? [];
  const [config, setConfig] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.key, fieldText(conn.config[f.key])])));
  const dirty = fields.some((f) => config[f.key] !== fieldText(conn.config[f.key]));
  if (fields.length === 0) return null;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty) patch({ config });
      }}
    >
      {fields.map((f) => (
        <ConnField key={f.key} field={f} value={config[f.key] ?? ""} onChange={(v) => setConfig({ ...config, [f.key]: v })} />
      ))}
      {dirty && (
        <div className="conn-row end">
          <button type="button" className="btn small ghost" onClick={() => setConfig(Object.fromEntries(fields.map((f) => [f.key, fieldText(conn.config[f.key])])))}>
            Descartar
          </button>
          <button className="btn small primary">Guardar cambios</button>
        </div>
      )}
    </form>
  );
}

/** Credenciales: modo de acceso (GitHub), token cifrado o cliente OAuth y autorización (Google). */
function Credentials({
  conn,
  service,
  busy,
  patch,
  action,
}: {
  conn: ConnView;
  service?: ServiceInfo;
  busy: string;
  patch: (b: Record<string, unknown>) => Promise<void>;
  action: (a: Accion) => Promise<void>;
}) {
  const [token, setToken] = useState("");
  const [client, setClient] = useState({ clientId: "", clientSecret: "" });
  const oauth = service?.authKind === "oauth";

  return (
    <>
      {!oauth && conn.service === "github" && (
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
      )}

      {service?.supportsSecret && (
        <div className="conn-field">
          <span>
            {service.secretLabel ?? "Token"}
            {service.secretOptional && <small className="muted"> (opcional)</small>}
          </span>
          <form
            className="conn-token"
            onSubmit={(e) => {
              e.preventDefault();
              if (!token.trim()) return;
              patch({ token }).then(() => setToken(""));
            }}
          >
            {conn.hasSecret && <span className="tag gold">Guardado {conn.secretHint}</span>}
            <input
              type="password"
              autoComplete="off"
              value={token}
              title={conn.service === "github" ? GITHUB_TOKEN_HINT : undefined}
              placeholder={conn.hasSecret ? "Sustituir…" : (service.secretPlaceholder ?? "Pega aquí la credencial")}
              onChange={(e) => setToken(e.target.value)}
            />
            <button className="btn small" disabled={!token.trim()}>
              Guardar
            </button>
            {conn.hasSecret && (
              <button type="button" className="btn ghost small danger" onClick={() => patch({ token: null })}>
                Borrar
              </button>
            )}
          </form>
        </div>
      )}

      {oauth && conn.oauth && (
        <>
          <div className="conn-field">
            <span>Cliente OAuth</span>
            {conn.oauth.clientConfigured ? <span className="tag gold">Guardado {conn.oauth.clientIdHint}</span> : <span className="muted small">Ninguno</span>}
          </div>
          <form
            className="conn-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (!client.clientId.trim()) return;
              patch({ oauthClient: client }).then(() => setClient({ clientId: "", clientSecret: "" }));
            }}
          >
            <input autoComplete="off" value={client.clientId} placeholder="Client ID o JSON" onChange={(e) => setClient({ ...client, clientId: e.target.value })} />
            <input type="password" autoComplete="off" value={client.clientSecret} placeholder="Client secret" onChange={(e) => setClient({ ...client, clientSecret: e.target.value })} />
            <button className="btn small" disabled={!client.clientId.trim()}>
              Guardar
            </button>
          </form>
          <div className="conn-field">
            <span>Cuenta</span>
            <span className="conn-token">
              {conn.oauth.authorized ? <span className="tag gold">Autorizada{conn.oauth.account ? ` · ${conn.oauth.account}` : ""}</span> : <span className="muted small">Sin autorizar</span>}
              <button type="button" className="btn small primary" disabled={busy !== "" || !conn.oauth.clientConfigured} onClick={() => action("autorizar")}>
                {busy === "autorizar" ? "Abriendo Google…" : conn.oauth.authorized ? "Volver a autorizar" : "Autorizar con Google"}
              </button>
            </span>
          </div>
          <p className="muted small" title="En Google Cloud: activa la Google Calendar API y crea un cliente OAuth de tipo «Aplicación de escritorio».">
            Solo lectura (<em>calendar.readonly</em>): Orden no puede cambiar eventos.
          </p>
        </>
      )}
    </>
  );
}

/** Los textos de nivel ya traen «Lectura: …»; aquí el nombre va en negrita, así que se quita del texto. */
const bareLevel = (text: string) => text.replace(/^(lectura|completo|admin):\s*/i, "");

/** Nivel de acceso de cada agente y qué permite cada nivel. */
function Grants({ conn, service, patch }: { conn: ConnView; service?: ServiceInfo; patch: (b: Record<string, unknown>) => Promise<void> }) {
  const agents = useStore((s) => s.agents);
  return (
    <>
      <div className="conn-grants">
        {agents.map((a) => (
          <label key={a.id} className={`conn-grant ${conn.grants[a.id] ? "on" : ""}`}>
            <span>{a.name}</span>
            <select value={conn.grants[a.id] ?? ""} onChange={(e) => patch({ grants: { [a.id]: (e.target.value || null) as GrantLevel | null } })}>
              <option value="">Sin acceso</option>
              <option value="lectura">Lectura</option>
              {!service?.readOnly && <option value="completo">Completo</option>}
              {service?.levels.admin && <option value="admin">Admin</option>}
            </select>
          </label>
        ))}
      </div>
      {service && (
        <ul className="muted small conn-levels">
          <li>
            <strong>Lectura:</strong> {bareLevel(service.levels.lectura)}
          </li>
          {!service.readOnly && (
            <li>
              <strong>Completo:</strong> {bareLevel(service.levels.completo)}
            </li>
          )}
          {service.levels.admin && (
            <li>
              <strong>Admin:</strong> {bareLevel(service.levels.admin)}
            </li>
          )}
        </ul>
      )}
    </>
  );
}

/**
 * Ventana para añadir un servicio: sus campos y, si los usa, la credencial o
 * el cliente OAuth. Al conectarla se abre su ventana para dar permisos.
 */
function AddModal({ service, onClose, onAdded }: { service: ServiceInfo; onClose: () => void; onAdded: (id: string) => Promise<void> }) {
  const [config, setConfig] = useState<Record<string, string>>({});
  const [token, setToken] = useState("");
  const [client, setClient] = useState({ clientId: "", clientSecret: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const oauth = service.authKind === "oauth";

  const submit = async () => {
    setError("");
    setBusy(true);
    try {
      const conn = await api<ConnView>("/api/connections", { method: "POST", json: { service: service.key, config } });
      // La credencial va aparte (cifrada); si falla, la conexión ya existe y se completa en su ventana.
      if (service.supportsSecret && token.trim()) await api(`/api/connections/${conn.id}`, { method: "PATCH", json: { token } });
      if (oauth && client.clientId.trim()) await api(`/api/connections/${conn.id}`, { method: "PATCH", json: { oauthClient: client } });
      await onAdded(conn.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConnModal
      monogram={serviceMonogram(service.key, service.label)}
      title={service.label}
      subtitle={categoryLabel(serviceCategory(service.key, service.category))}
      onClose={onClose}
      foot={
        <>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" form="conn-add-form" className="btn primary" disabled={busy}>
            {busy ? "Conectando…" : "Conectar"}
          </button>
        </>
      }
    >
      <p className="muted small conn-desc">{service.description}</p>
      <Steps steps={service.steps} open />
      <form
        id="conn-add-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {(service.fields.length > 0 || service.supportsSecret || oauth) && (
          <div className="conn-modal-section">
            <h3>Datos de la conexión</h3>
            {service.fields.map((f) => (
              <ConnField key={f.key} field={f} value={config[f.key] ?? ""} onChange={(v) => setConfig({ ...config, [f.key]: v })} />
            ))}
            {service.supportsSecret && (
              <label className="conn-field">
                <span>
                  {service.secretLabel ?? "Token"}
                  {(service.secretOptional || service.key === "github") && <small className="muted"> (opcional)</small>}
                </span>
                <input
                  type="password"
                  autoComplete="off"
                  value={token}
                  title={service.key === "github" ? `${GITHUB_TOKEN_HINT} Sin token, usa la sesión de GitHub CLI (gh).` : undefined}
                  placeholder={service.secretPlaceholder ?? "Pega aquí la credencial"}
                  onChange={(e) => setToken(e.target.value)}
                />
              </label>
            )}
            {oauth && (
              <>
                <label className="conn-field">
                  <span>Client ID o JSON</span>
                  <input autoComplete="off" value={client.clientId} onChange={(e) => setClient({ ...client, clientId: e.target.value })} />
                </label>
                <label className="conn-field">
                  <span>Client secret</span>
                  <input type="password" autoComplete="off" value={client.clientSecret} onChange={(e) => setClient({ ...client, clientSecret: e.target.value })} />
                </label>
              </>
            )}
          </div>
        )}
        <p className="muted small">Se guarda cifrado. Después podrás probarla y decidir qué agentes la usan.</p>
      </form>
      {error && <p className="bad-text small">{error}</p>}
    </ConnModal>
  );
}

/** Ventana informativa de un servicio que vendrá: qué hará y cómo se conectará. */
function UpcomingModal({ item, onClose }: { item: CatalogItem; onClose: () => void }) {
  return (
    <ConnModal
      monogram={item.monogram}
      title={item.label}
      subtitle={`${categoryLabel(item.category)} · Próximamente`}
      onClose={onClose}
      foot={
        <button type="button" className="btn" onClick={onClose}>
          Cerrar
        </button>
      }
    >
      <p className="conn-desc">{item.description}</p>
      {item.plan && (
        <div className="conn-modal-section">
          <h3>Cómo se conectará</h3>
          <p className="muted small">{item.plan}</p>
        </div>
      )}
    </ConnModal>
  );
}
