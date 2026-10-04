import { registerService, type AgentGrant } from "../registry";
import { ghStatus, parseRepo, RepoApi, resolveTransport } from "./api";
import { SYNC_EVERY_MS, syncGithubStatus } from "./status";
import { githubTools } from "./tools";
import { redact } from "../../secrets";

const LEVEL_TEXT = {
  lectura: "leer código, commits, issues y PRs, buscar y comentar",
  completo: "lo anterior y crear/editar issues, crear ramas, hacer commits y abrir PRs",
};

registerService({
  key: "github",
  label: "GitHub",
  description: "Repositorios de GitHub. Acceso con el GitHub CLI (gh) del PC o con un token fine-grained guardado cifrado.",
  levels: { lectura: `Lectura: ${LEVEL_TEXT.lectura}`, completo: `Completo: ${LEVEL_TEXT.completo}` },
  fields: [{ key: "repo", label: "Repositorio", placeholder: "propietario/nombre" }],
  supportsSecret: true,

  normalizeConfig(input) {
    return { repo: parseRepo(input.repo).full, panel: input.panel !== false };
  },
  defaultName(config) {
    return `GitHub · ${String(config.repo)}`;
  },
  tools: githubTools,
  prompt(grants: AgentGrant[]) {
    return `Conexión con GitHub (acciones reales fuera de Orden, con la cuenta del usuario):
${grants.map((g) => `- Repo ${String(g.connection.config.repo)} · tu permiso: ${g.level} (${LEVEL_TEXT[g.level]}).`).join("\n")}
- Usa las herramientas github_*. Solo puedes trabajar en ${grants.length > 1 ? "esos repos" : "ese repo"}; no hay acceso a otros.
- Lo que publiques (comentarios, issues, PRs) se firma como agente de Orden. Sé breve y concreto.${
      grants.some((g) => g.level === "completo")
        ? "\n- Para cambiar código: github_crear_rama → github_commit (archivos con su contenido completo) → github_crear_pr. Nunca hay commits directos en la rama principal ni fusiones: el usuario revisa y fusiona."
        : ""
    }`;
  },
  async test(c) {
    try {
      const { transport, via } = await resolveTransport(c);
      const info = await new RepoApi(String(c.config.repo), transport).info();
      const gh = via === "gh" ? (await ghStatus()).detail : "Token guardado.";
      const push = info.permissions ? (info.permissions.push ? "con permiso de escritura" : "solo lectura (sin push)") : "";
      return { ok: true, text: `Acceso correcto a ${info.full_name} vía ${via === "gh" ? "gh" : "token"}${push ? `, ${push}` : ""}. ${gh}` };
    } catch (err) {
      return { ok: false, text: redact((err as Error).message) };
    }
  },
  sync: syncGithubStatus,
  syncEveryMs: SYNC_EVERY_MS,
});
