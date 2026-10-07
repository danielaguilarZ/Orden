import { registerService, type AgentGrant } from "../registry";
import { ghStatus, RepoApi, resolveTransport } from "./api";
import { isWildcard, listScopeRepos, parseScope, scopeLabel } from "./scope";
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
  fields: [
    {
      key: "repo",
      label: "Repositorio",
      placeholder: "propietario/nombre · propietario/* · *",
      presets: [{ label: "Todos mis repos", value: "*" }],
      hint: "Pon * para dar acceso a todos tus repos de una vez (propios, de organizaciones y en los que colaboras), o propietario/* para todos los de un usuario u organización. GitHub sigue poniendo el límite: solo llega a lo que tu cuenta ya puede ver o escribir.",
    },
  ],
  supportsSecret: true,

  normalizeConfig(input) {
    return { repo: parseScope(input.repo) };
  },
  defaultName(config) {
    const scope = String(config.repo);
    return `GitHub · ${isWildcard(scope) ? scopeLabel(scope).replace(/^todos tus repos$/, "todos mis repos") : scope}`;
  },
  tools: githubTools,
  prompt(grants: AgentGrant[]) {
    return `Conexión con GitHub (acciones reales fuera de Orden, con la cuenta del usuario):
${grants.map((g) => `- ${isWildcard(String(g.connection.config.repo)) ? `Acceso a ${scopeLabel(String(g.connection.config.repo))}` : `Repo ${String(g.connection.config.repo)}`} · tu permiso: ${g.level} (${LEVEL_TEXT[g.level]}).`).join("\n")}
- Usa las herramientas github_*. Solo puedes trabajar en ${grants.length > 1 || grants.some((g) => isWildcard(String(g.connection.config.repo))) ? "esos repos" : "ese repo"}; no hay acceso a otros.${grants.some((g) => isWildcard(String(g.connection.config.repo))) ? "\n- Con acceso a varios repos, github_repos te dice cuáles hay; indica siempre el repo («propietario/nombre»)." : ""}
- Lo que publiques (comentarios, issues, PRs) se firma como agente de Orden. Sé breve y concreto.${
      grants.some((g) => g.level === "completo")
        ? "\n- Para cambiar código: github_crear_rama → github_commit (archivos con su contenido completo) → github_crear_pr. Nunca hay commits directos en la rama principal ni fusiones: el usuario revisa y fusiona."
        : ""
    }`;
  },
  async test(c) {
    try {
      const { transport, via } = await resolveTransport(c);
      const gh = via === "gh" ? (await ghStatus()).detail : "Token guardado.";
      const scope = String(c.config.repo);
      if (isWildcard(scope)) {
        const list = await listScopeRepos(transport, scope);
        if (!list.length) return { ok: false, text: `La cuenta no ve ningún repo en «${scope}». ${gh}` };
        const writable = list.filter((r) => r.permissions?.push).length;
        return { ok: true, text: `Acceso correcto a ${list.length} repo(s) (${scopeLabel(scope)}), ${writable} con permiso de escritura, vía ${via === "gh" ? "gh" : "token"}. ${gh}` };
      }
      const info = await new RepoApi(scope, transport).info();
      const push = info.permissions ? (info.permissions.push ? "con permiso de escritura" : "solo lectura (sin push)") : "";
      return { ok: true, text: `Acceso correcto a ${info.full_name} vía ${via === "gh" ? "gh" : "token"}${push ? `, ${push}` : ""}. ${gh}` };
    } catch (err) {
      return { ok: false, text: redact((err as Error).message) };
    }
  },
});
