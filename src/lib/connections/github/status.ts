import { TIMEZONE } from "../../agents/prompt";
import { RepoApi, type CommitItem, type IssueItem, type PullItem } from "./api";

/**
 * Resumen del repo (herramienta github_resumen): PRs e issues abiertos y
 * últimos commits, consultado en el momento.
 */

const STAMP_PREFIX = "_Consultado:";

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

/** Markdown del resumen (función pura; la marca de hora va en la línea 2). */
export function statusMarkdown(s: RepoSnapshot, at: Date): string {
  const stamp = at.toLocaleString("es-ES", { timeZone: TIMEZONE, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const lines = [`**[${s.repo}](${s.url})** · rama principal \`${s.defaultBranch}\``, `${STAMP_PREFIX} ${stamp}_`, ""];

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

export async function fetchSnapshot(api: RepoApi): Promise<RepoSnapshot> {
  const info = await api.info();
  const [pulls, issues, commits] = await Promise.all([
    api.pulls({ state: "open", limit: 15 }),
    api.issues({ state: "open", limit: 30 }),
    api.commits({ branch: info.default_branch, limit: 8 }),
  ]);
  return { repo: info.full_name, url: info.html_url, defaultBranch: info.default_branch, pulls, issues: issues.filter((i) => !i.pull_request).slice(0, 15), commits };
}
