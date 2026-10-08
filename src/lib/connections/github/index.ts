import { registerService, type AgentGrant } from "../registry";
import { AccountApi, ALL_REPOS, ghStatus, isAllRepos, parseRepo, RepoApi, resolveTransport } from "./api";
import { githubTools } from "./tools";
import { redact } from "../../secrets";

const LEVEL_TEXT = {
  lectura: "leer código, commits, issues y PRs, buscar y comentar",
  completo: "lo anterior y crear/editar issues, crear ramas, hacer commits y abrir PRs",
};

registerService({
  key: "github",
  label: "GitHub",
  description:
    "Repositorios de GitHub. Inicia sesión con tu cuenta (un botón) para dar acceso a todos tus repos, o conecta un repo con el GitHub CLI (gh) del PC o con un token guardado cifrado.",
  levels: { lectura: `Lectura: ${LEVEL_TEXT.lectura}`, completo: `Completo: ${LEVEL_TEXT.completo}` },
  fields: [{ key: "repo", label: "Repositorio", placeholder: "propietario/nombre, o * para todos los de la cuenta" }],
  supportsSecret: true,

  normalizeConfig(input) {
    return { repo: isAllRepos(input.repo) ? ALL_REPOS : parseRepo(input.repo).full };
  },
  defaultName(config) {
    return config.repo === ALL_REPOS ? "GitHub · todos los repositorios" : `GitHub · ${String(config.repo)}`;
  },
  tools: githubTools,
  prompt(grants: AgentGrant[]) {
    const all = grants.some((g) => g.connection.config.repo === ALL_REPOS);
    return `Conexión con GitHub (acciones reales fuera de Orden, con la cuenta del usuario):
${grants
  .map((g) =>
    g.connection.config.repo === ALL_REPOS
      ? `- Todos los repos de la cuenta · tu permiso: ${g.level} (${LEVEL_TEXT[g.level]}).`
      : `- Repo ${String(g.connection.config.repo)} · tu permiso: ${g.level} (${LEVEL_TEXT[g.level]}).`,
  )
  .join("\n")}
- Usa las herramientas github_*. ${
      all
        ? "En cada una indica el repo («propietario/nombre»); si no sabes cuál, lista los de la cuenta con github_repos. Toca solo los repos que el usuario te pida."
        : `Solo puedes trabajar en ${grants.length > 1 ? "esos repos" : "ese repo"}; no hay acceso a otros.`
    }
- Lo que publiques (comentarios, issues, PRs) se firma como agente de Orden. Sé breve y concreto.${
      grants.some((g) => g.level === "completo")
        ? "\n- Para cambiar código: github_crear_rama → github_commit (archivos con su contenido completo) → github_crear_pr. Nunca hay commits directos en la rama principal ni fusiones: el usuario revisa y fusiona."
        : ""
    }`;
  },
  async test(c) {
    try {
      const { transport, via } = await resolveTransport(c);
      if (c.config.repo === ALL_REPOS) {
        const [me, repos] = await Promise.all([new AccountApi(transport).me(), new AccountApi(transport).repos(100)]);
        const writable = repos.filter((r) => r.permissions?.push).length;
        return { ok: true, text: `Acceso correcto como ${me.login} vía ${via === "gh" ? "gh" : "token"}: ${repos.length}${repos.length === 100 ? "+" : ""} repositorio(s) visibles, ${writable} con permiso de escritura.` };
      }
      const info = await new RepoApi(String(c.config.repo), transport).info();
      const gh = via === "gh" ? (await ghStatus()).detail : "Token guardado.";
      const push = info.permissions ? (info.permissions.push ? "con permiso de escritura" : "solo lectura (sin push)") : "";
      return { ok: true, text: `Acceso correcto a ${info.full_name} vía ${via === "gh" ? "gh" : "token"}${push ? `, ${push}` : ""}. ${gh}` };
    } catch (err) {
      return { ok: false, text: redact((err as Error).message) };
    }
  },
});
