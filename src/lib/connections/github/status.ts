import { TIMEZONE } from "../../agents/prompt";
import { createPanel, getPanel, replacePanelData, type Actor } from "../../repo/panels";
import { listConnections, markSync, updateConnection, type Connection } from "../../repo/connections";
import { logActivity } from "../../repo/system";
import { redact } from "../../secrets";
import { RepoApi, resolveTransport, type CommitItem, type IssueItem, type PullItem } from "./api";

/**
 * Panel vivo «Estado del repo»: PRs e issues abiertos y últimos commits.
 * Lo actualiza el worker cada 10 minutos sin llamar al modelo (no gasta uso)
 * y solo guarda una versión nueva si algo ha cambiado.
 */

export const SYNC_EVERY_MS = 10 * 60_000;
export const SYSTEM_ACTOR: Actor = { by: "sistema" };
const STAMP_PREFIX = "_Actualizado:";

export interface RepoSnapshot {
  repo: string;
  url: string;
  defaultBranch: string;
  pulls: PullItem[];
  issues: IssueItem[];
  commits: CommitItem[];
}

/** Texto seguro dentro de un enlace markdown. */
const linkText = (s: string) => s.replace(/[[\]\n\r|]/g, " ").replace(/\s+/g, " ").trim();
const day = (iso: string) => new Date(iso).toLocaleDateString("es-ES", { timeZone: TIMEZONE, day: "numeric", month: "short" });
const labelsOf = (i: IssueItem) => i.labels.map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean);

/** Markdown del panel (función pura; la marca de hora va en la línea 2). */
export function statusMarkdown(s: RepoSnapshot, at: Date): string {
  const stamp = at.toLocaleString("es-ES", { timeZone: TIMEZONE, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const lines = [`**[${s.repo}](${s.url})** · rama principal \`${s.defaultBranch}\``, `${STAMP_PREFIX} ${stamp} · se comprueba cada ${SYNC_EVERY_MS / 60_000} min_`, ""];

  lines.push(`### Pull requests abiertos (${s.pulls.length})`);
  if (!s.pulls.length) lines.push("Ninguno.");
  for (const p of s.pulls) {
    lines.push(`- [#${p.number} ${linkText(p.title)}](${p.html_url})${p.draft ? " · _borrador_" : ""} — ${p.user?.login ?? "?"} · \`${p.head.ref}\` → \`${p.base.ref}\` · ${day(p.updated_at)}`);
  }
  lines.push("");

  const issues = s.issues.filter((i) => !i.pull_request);
  lines.push(`### Issues abiertos (${issues.length})`);
  if (!issues.length) lines.push("Ninguno.");
  for (const i of issues) {
    const labels = labelsOf(i);
    lines.push(`- [#${i.number} ${linkText(i.title)}](${i.html_url})${labels.length ? ` · ${labels.map((l) => `\`${linkText(l)}\``).join(" ")}` : ""} — ${i.user?.login ?? "?"} · ${day(i.updated_at)}`);
  }
  lines.push("");

  lines.push(`### Últimos commits en \`${s.defaultBranch}\``);
  if (!s.commits.length) lines.push("Ninguno.");
  for (const c of s.commits) {
    const msg = linkText(c.commit.message.split("\n")[0]).slice(0, 90);
    lines.push(`- [\`${c.sha.slice(0, 7)}\`](${c.html_url}) ${msg} — ${c.author?.login ?? c.commit.author?.name ?? "?"} · ${c.commit.author?.date ? day(c.commit.author.date) : ""}`);
  }
  return lines.join("\n");
}

/** Contenido sin la marca de hora, para saber si algo ha cambiado de verdad. */
export function withoutStamp(md: string): string {
  return md
    .split("\n")
    .filter((l) => !l.startsWith(STAMP_PREFIX))
    .join("\n");
}

export async function fetchSnapshot(api: RepoApi): Promise<RepoSnapshot> {
  const info = await api.info();
  const [pulls, issues, commits] = await Promise.all([
    api.pulls({ state: "open", limit: 15 }),
    api.issues({ state: "open", limit: 30 }),
    api.commits({ branch: info.default_branch, limit: 8 }),
  ]);
  return { repo: info.full_name, url: info.html_url, defaultBranch: info.default_branch, pulls, issues: issues.filter((i) => !i.pull_request).slice(0, 15), commits };
}

function panelTitle(c: Connection) {
  const others = listConnections("github").filter((x) => x.id !== c.id && x.enabled);
  return others.length ? `Estado del repo · ${String(c.config.repo)}` : "Estado del repo";
}

/**
 * Actualiza (o crea) el panel de una conexión de GitHub.
 * Si el usuario lo mandó a la papelera, se respeta: se desactiva el panel.
 */
export async function syncGithubStatus(c: Connection, at = new Date()): Promise<void> {
  if (c.config.panel === false) return;
  try {
    const { transport } = await resolveTransport(c);
    const api = new RepoApi(String(c.config.repo), transport);
    const md = statusMarkdown(await fetchSnapshot(api), at);
    const panel = c.statusPanelId ? getPanel(c.statusPanelId) : null;
    if (panel?.archived) {
      updateConnection(c.id, { config: { ...c.config, panel: false } });
      logActivity("sistema", `El panel «${panel.title}» está en la papelera: deja de actualizarse (actívalo de nuevo en Conexiones).`);
    } else if (!panel) {
      const created = createPanel({ type: "notas", title: panelTitle(c), data: { markdown: md }, actor: SYSTEM_ACTOR, layout: { size: "ancho" } });
      updateConnection(c.id, { statusPanelId: created.id });
    } else {
      const prev = String((panel.data as { markdown?: string }).markdown ?? "");
      if (withoutStamp(prev) !== withoutStamp(md)) replacePanelData(panel.id, { markdown: md }, SYSTEM_ACTOR);
    }
    markSync(c.id, null, at);
  } catch (err) {
    const msg = redact((err as Error).message);
    if (msg !== c.lastError) logActivity("error", `Conexión «${c.name}»: ${msg}`);
    markSync(c.id, msg, at);
    throw new Error(msg);
  }
}
