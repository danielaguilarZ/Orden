"use client";

import { useCallback, useEffect, useState } from "react";
import { api, onEvent, useStore } from "@/client/store";
import type { ServiceInfo } from "@/lib/connections/registry";
import { UPCOMING_SERVICES } from "@/lib/connections/catalog";
import { catalogItems, categoryCounts, connectionStatus, grantCount, groupCatalog, serviceIcon, type CatalogFilter, type CatalogItem, type ConnView } from "@/lib/connections/view";
import type { AuthMode, GrantLevel } from "@/lib/repo/connections";
import { useMounted } from "./panels/common";
import { MoreMenu, type MenuItem } from "./panels/MoreMenu";
import { FilterChips, SearchBox } from "./ui/kit";

interface Data {
  services: ServiceInfo[];
  connections: ConnView[];
}

/** Valor de configuración como texto (las listas, separadas por comas). */
const fieldText = (v: unknown) => (Array.isArray(v) ? v.join(", ") : String(v ?? ""));

const AUTH_LABEL: Record<AuthMode, string> = {
  auto: "Automático (gh o token)",
  gh: "Solo GitHub CLI (gh)",
  token: "Solo token",
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
        <span className="muted">Servicios que pueden usar los agentes.</span>
      </div>
      {error && <p className="bad-text">{error}</p>}
      {notice && <p className={`conn-result ${notice.ok ? "ok-text" : "bad-text"}`}>{notice.text}</p>}
      {!data && !error && <p className="muted">Cargando…</p>}
      {data && (
        <>
          <h3 className="conn-section">Activas{data.connections.length > 0 && <span className="conn-count">{data.connections.length}</span>}</h3>
          {data.connections.length === 0 ? (
            <p className="muted small">Ninguna todavía. Añade una abajo.</p>
          ) : (
            <div className="conn-list">
              {data.connections.map((c) => (
                <ConnectionRow key={c.id} conn={c} service={data.services.find((s) => s.key === c.service)} onChange={load} />
              ))}
            </div>
          )}
          <AddConnection services={data.services} onAdded={load} />
        </>
      )}
    </div>
  );
}

/** Fila compacta: icono, nombre, estado y una acción; lo demás, plegado o en «⋯». */
function ConnectionRow({ conn, service, onChange }: { conn: ConnView; service?: ServiceInfo; onChange: () => void }) {
  const [open, setOpen] = useState<"" | "ajustes" | "permisos">("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState("");
  const oauth = service?.authKind === "oauth";
  const status = connectionStatus(conn, service);
  const granted = grantCount(conn);
  const syncs = oauth || conn.service === "github" || Boolean(service?.syncs);
  const toggle = (k: "ajustes" | "permisos") => setOpen(open === k ? "" : k);

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

  // Acción principal: lo que haga falta para que funcione; si ya funciona, probarla.
  const primary =
    status.needsSetup ? (
      <button className="btn small primary" onClick={() => setOpen("ajustes")}>
        Configurar
      </button>
    ) : oauth && conn.enabled && !conn.oauth?.authorized ? (
      <button className="btn small primary" disabled={busy !== ""} onClick={() => action("autorizar")}>
        {busy === "autorizar" ? "Abriendo…" : "Autorizar"}
      </button>
    ) : (
      <button className="btn small" disabled={busy !== ""} onClick={() => action("probar")}>
        {busy === "probar" ? "Probando…" : "Probar"}
      </button>
    );

  const menu: MenuItem[] = [
    { label: open === "ajustes" ? "Ocultar ajustes" : "Ajustes", onClick: () => toggle("ajustes") },
    { label: open === "permisos" ? "Ocultar permisos" : "Permisos de agentes", onClick: () => toggle("permisos") },
    ...(status.needsSetup || (oauth && !conn.oauth?.authorized) ? [{ label: "Probar conexión", onClick: () => action("probar"), disabled: busy !== "" }] : []),
    ...(syncs ? [{ label: oauth ? "Volcar ahora" : "Actualizar ahora", onClick: () => action("actualizar"), disabled: busy !== "" || (oauth && !conn.oauth?.authorized) }] : []),
    ...(oauth && conn.oauth?.authorized ? [{ label: "Volver a autorizar", onClick: () => action("autorizar"), disabled: busy !== "" }] : []),
    { label: conn.enabled ? "Pausar" : "Activar", onClick: () => patch({ enabled: !conn.enabled }) },
    ...(oauth && conn.oauth?.authorized ? [{ label: "Desconectar Google", onClick: () => action("desconectar"), danger: true }] : []),
    { label: "Eliminar", onClick: remove, danger: true },
  ];

  return (
    <section className={`conn-item ${conn.enabled ? "" : "off"} ${open ? "open" : ""}`}>
      <div className="conn-line">
        <span className="conn-logo" aria-hidden>
          {serviceIcon(conn.service, service?.label, service?.icon)}
        </span>
        <button type="button" className="conn-name" aria-expanded={open === "ajustes"} onClick={() => toggle("ajustes")} title={service?.description}>
          <strong>{conn.name}</strong>
          {service && service.label !== conn.name && <small className="muted">{service.label}</small>}
        </button>
        <span className={`conn-status ${status.tone}`} title={conn.lastError ?? undefined}>
          <span className="dot" />
          {busy ? <span className="spinner" /> : status.label}
        </span>
        <button type="button" className={`conn-chip ${open === "permisos" ? "on" : ""}`} aria-expanded={open === "permisos"} onClick={() => toggle("permisos")} title="Permisos de agentes">
          👥 {granted}
        </button>
        {primary}
        <MoreMenu items={menu} />
      </div>
      {result && <p className={`conn-result small ${result.ok ? "ok-text" : "bad-text"}`}>{result.text}</p>}
      {open === "ajustes" && <ConnectionSettings conn={conn} service={service} busy={busy} showSteps={status.needsSetup} patch={patch} action={action} />}
      {open === "permisos" && <ConnectionGrants conn={conn} service={service} patch={patch} />}
    </section>
  );
}

function ConnectionSettings({
  conn,
  service,
  busy,
  showSteps,
  patch,
  action,
}: {
  conn: ConnView;
  service?: ServiceInfo;
  busy: string;
  /** Falta configurarla: los pasos salen desplegados. */
  showSteps: boolean;
  patch: (b: Record<string, unknown>) => Promise<void>;
  action: (a: "probar" | "actualizar" | "autorizar" | "desconectar") => Promise<void>;
}) {
  const mounted = useMounted();
  const [token, setToken] = useState("");
  const [client, setClient] = useState({ clientId: "", clientSecret: "" });
  const [config, setConfig] = useState<Record<string, string>>(() => Object.fromEntries((service?.fields ?? []).map((f) => [f.key, fieldText(conn.config[f.key])])));
  const oauth = service?.authKind === "oauth";
  const hasPanel = oauth || conn.service === "github" || Boolean(service?.panelLabel);
  const dirty = (service?.fields ?? []).some((f) => config[f.key] !== fieldText(conn.config[f.key]));
  const lastSync = conn.lastSyncAt && mounted ? new Date(conn.lastSyncAt).toLocaleString("es-ES") : "nunca";

  return (
    <div className="conn-body">
      {service?.description && <p className="muted small conn-desc">{service.description}</p>}
      {Boolean(service?.steps?.length) && (
        <details className="conn-steps" open={showSteps}>
          <summary>Cómo conectarla</summary>
          <ol>
            {service!.steps!.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </details>
      )}

      {(service?.fields ?? []).map((f) => (
        <label key={f.key} className="conn-field">
          <span>{f.label}</span>
          <input value={config[f.key] ?? ""} placeholder={f.placeholder} onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })} />
        </label>
      ))}
      {dirty && (
        <div className="conn-row">
          <button className="btn small primary" onClick={() => patch({ config })}>
            Guardar
          </button>
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
              <button className="btn small primary" disabled={busy !== "" || !conn.oauth.clientConfigured} onClick={() => action("autorizar")}>
                {busy === "autorizar" ? "Abriendo Google…" : conn.oauth.authorized ? "Volver a autorizar" : "Autorizar con Google"}
              </button>
            </span>
          </div>
          <p className="muted small" title="En Google Cloud: activa la Google Calendar API y crea un cliente OAuth de tipo «Aplicación de escritorio».">
            Solo lectura (<em>calendar.readonly</em>): Orden no puede cambiar eventos.
          </p>
        </>
      )}

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
              title={conn.service === "github" ? "Token fine-grained limitado al repo: Contents, Issues y Pull requests (lectura y escritura) y Metadata (lectura)." : undefined}
              placeholder={conn.hasSecret ? "Sustituir…" : (service.secretPlaceholder ?? "github_pat_…")}
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

      {hasPanel && (
        <div className="conn-field">
          <span>{service?.panelLabel ?? (oauth ? "Panel «Calendario»" : "Panel «Estado del repo»")}</span>
          <span className="conn-token">
            <label
              className="conn-toggle"
              title={oauth || service?.panelLabel ? "Cada 30 min, sin duplicar y sin gastar uso de Claude" : "Cada 10 min, sin gastar uso de Claude"}
            >
              <input type="checkbox" checked={conn.config.panel !== false} onChange={(e) => patch({ config: { panel: e.target.checked } })} /> Al día
            </label>
            <span className="muted small">
              Última: {lastSync}
              {conn.lastError && <span className="bad-text"> · {conn.lastError}</span>}
            </span>
          </span>
        </div>
      )}
      {!hasPanel && conn.lastError && <p className="bad-text small">{conn.lastError}</p>}
    </div>
  );
}

function ConnectionGrants({ conn, service, patch }: { conn: ConnView; service?: ServiceInfo; patch: (b: Record<string, unknown>) => Promise<void> }) {
  const agents = useStore((s) => s.agents);
  return (
    <div className="conn-body">
      <div className="conn-grants">
        {agents.map((a) => (
          <label key={a.id} className={`conn-grant ${conn.grants[a.id] ? "on" : ""}`}>
            <span>{a.name}</span>
            <select value={conn.grants[a.id] ?? ""} onChange={(e) => patch({ grants: { [a.id]: (e.target.value || null) as GrantLevel | null } })}>
              <option value="">Sin acceso</option>
              <option value="lectura">Lectura</option>
              {!service?.readOnly && <option value="completo">Completo</option>}
            </select>
          </label>
        ))}
      </div>
      {service && (
        <details className="conn-steps">
          <summary>Qué permite cada nivel</summary>
          <ul className="muted small conn-levels">
            <li>{service.levels.lectura}</li>
            {!service.readOnly && <li>{service.levels.completo}</li>}
          </ul>
        </details>
      )}
    </div>
  );
}

const FILTERS: { key: CatalogFilter; label: string }[] = [
  { key: "todas", label: "Todas" },
  { key: "disponibles", label: "Disponibles" },
  { key: "proximamente", label: "Próximamente" },
];

/** Catálogo compacto con buscador: las disponibles se eligen y se añaden; las que vendrán, solo se ven. */
function AddConnection({ services, onAdded }: { services: ServiceInfo[]; onAdded: () => void }) {
  const [service, setService] = useState("");
  const [config, setConfig] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CatalogFilter>("todas");
  const [category, setCategory] = useState("todas");
  const s = services.find((x) => x.key === service);
  // Los contadores de categoría respetan el buscador y el tipo, no la propia categoría.
  const base = catalogItems(services, UPCOMING_SERVICES, query, filter);
  const items = category === "todas" ? base : base.filter((it) => it.category === category);
  const groups = groupCatalog(items);
  const pick = (x: CatalogItem) =>
    x.available ? (
      <button
        key={x.key}
        type="button"
        className={`conn-pick ${service === x.key ? "on" : ""}`}
        title={x.description}
        onClick={() => {
          setService(service === x.key ? "" : x.key);
          setConfig({});
          setError("");
        }}
      >
        <span className="conn-pick-icon" aria-hidden>
          {x.icon}
        </span>
        <strong>{x.label}</strong>
        <span className="tag">{x.tag}</span>
      </button>
    ) : (
      <div key={x.key} className="conn-pick soon" title={`${x.description}\n${x.plan ?? ""}`}>
        <span className="conn-pick-icon" aria-hidden>
          {x.icon}
        </span>
        <strong>{x.label}</strong>
        <span className="tag">{x.tag}</span>
      </div>
    );

  return (
    <section className="conn-add">
      <div className="conn-add-bar">
        <h3 className="conn-section">Añadir conexión</h3>
        <span style={{ flex: 1 }} />
        <FilterChips label="Tipo" options={FILTERS} value={filter} onChange={(k) => setFilter(k as CatalogFilter)} />
        <SearchBox value={query} onChange={setQuery} placeholder="Buscar servicio…" />
      </div>
      <div className="conn-cats">
        <FilterChips
          label="Categoría"
          options={[{ key: "todas", label: "Todas", count: base.length }, ...categoryCounts(base).map((c) => ({ key: c.key, label: c.label, icon: c.icon, count: c.count }))]}
          value={category}
          onChange={setCategory}
        />
      </div>
      {groups.map((g) => (
        <div key={g.key} className="conn-group">
          {category === "todas" && (
            <h4 className="conn-group-title">
              <span aria-hidden>{g.icon}</span> {g.label} <span className="muted">{g.items.length}</span>
            </h4>
          )}
          <div className="conn-catalog">{g.items.map(pick)}</div>
        </div>
      ))}
      {items.length === 0 && <p className="muted small">Nada coincide.</p>}
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
          <p className="muted small conn-desc">{s.description}</p>
          {Boolean(s.steps?.length) && (
            <details className="conn-steps">
              <summary>Cómo conectarla</summary>
              <ol>
                {s.steps!.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </details>
          )}
          <div className="conn-row">
            {s.fields.map((f) => (
              <input key={f.key} aria-label={f.label} value={config[f.key] ?? ""} placeholder={f.placeholder ?? f.label} onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })} />
            ))}
            <button className="btn small primary">Añadir</button>
          </div>
          {error && <p className="bad-text small">{error}</p>}
        </form>
      )}
    </section>
  );
}
