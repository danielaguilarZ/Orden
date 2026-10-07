import { parseRepo, type Transport } from "./api";

/**
 * Alcance de una conexión de GitHub. Además de un repo concreto, puede cubrir
 * varios de una vez:
 * - «propietario/nombre»: ese repo.
 * - «propietario/*»: todos los de ese usuario u organización.
 * - «*»: todos los repos a los que llega la cuenta (propios, de organizaciones
 *   y en los que colabora).
 * El permiso real lo pone siempre GitHub: con un alcance amplio, el agente
 * solo llega a lo que la cuenta del usuario ya puede ver o escribir.
 */

export const ALL = "*";

/** Normaliza lo que escribe el usuario: repo, «propietario/*» o «*». */
export function parseScope(value: unknown): string {
  const s = String(value ?? "")
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\/+$/, "");
  if (s === ALL || /^todos?(\s+mis\s+repos)?$/i.test(s)) return ALL;
  const owner = s.match(/^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/\*$/);
  if (owner) return `${owner[1]}/*`;
  try {
    return parseRepo(s).full;
  } catch {
    throw new Error("El repo debe ser «propietario/nombre», «propietario/*» (todos los de ese usuario u organización) o «*» (todos tus repos).");
  }
}

export function isWildcard(scope: string): boolean {
  return scope === ALL || scope.endsWith("/*");
}

/** ¿Entra este repo («propietario/nombre») en el alcance? */
export function inScope(scope: string, repo: string): boolean {
  const full = repo.toLowerCase();
  const sc = scope.toLowerCase();
  if (sc === ALL) return true;
  if (sc.endsWith("/*")) return full.split("/")[0] === sc.slice(0, -2);
  return full === sc;
}

/** «todos tus repos», «los repos de acme», «acme/web». */
export function scopeLabel(scope: string): string {
  if (scope === ALL) return "todos tus repos";
  if (scope.endsWith("/*")) return `todos los repos de ${scope.slice(0, -2)}`;
  return scope;
}

export interface RepoListItem {
  full_name: string;
  private: boolean;
  archived: boolean;
  description: string | null;
  pushed_at: string | null;
  permissions?: { push?: boolean; admin?: boolean };
}

const MAX_PAGES = 5;

/** Repos visibles para la cuenta dentro del alcance (los más recientes primero, hasta 500). */
export async function listScopeRepos(transport: Transport, scope: string): Promise<RepoListItem[]> {
  if (!isWildcard(scope)) return [];
  const out: RepoListItem[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = (await transport({ method: "GET", path: `/user/repos?per_page=100&sort=pushed&page=${page}` })) as RepoListItem[];
    out.push(...batch.filter((r) => inScope(scope, r.full_name)));
    if (batch.length < 100) break;
  }
  return out;
}
