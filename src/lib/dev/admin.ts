import { registerPromptSection } from "../agents/prompt";
import type { Agent } from "../types";

/** Herramientas integradas de Claude Code que recibe un agente admin. */
export const ADMIN_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep", "Bash"];

/**
 * Permisos: lectura libre; escritura SOLO dentro de su copia (cwd); terminal
 * limitada a comprobar el proyecto. Todo lo demás se deniega sin preguntar.
 */
export const ADMIN_ALLOWED = [
  "Read",
  "Glob",
  "Grep",
  "Edit(./**)",
  "Write(./**)",
  "Bash(npm test:*)",
  "Bash(npm run typecheck:*)",
  "Bash(npm run build:*)",
  "Bash(npx tsc:*)",
  "Bash(npx vitest:*)",
  "Bash(npm install:*)",
  "Bash(npm ls:*)",
  "Bash(git status:*)",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(ls:*)",
];

export function isAdminTask(agent: Agent, kind: string) {
  return agent.admin && kind !== "ambient";
}

registerPromptSection((agent) =>
  agent.admin
    ? `Rol admin: puedes modificar el código de la propia app Orden.
- Tu directorio actual es TU COPIA del proyecto (rama propia). La app en marcha no se toca: tus cambios quedan como propuesta y el usuario la aplica con un botón (entonces se valida, se fusiona y Orden se reinicia sola). Tú no puedes reiniciar nada.
- Empieza leyendo README.md (arquitectura y carpetas). Stack: Next.js 16 + React 19, PixiJS 8 (living), SQLite con node:sqlite, worker en worker/, tests con Vitest en tests/.
- Sigue el estilo existente: TypeScript estricto, textos y comentarios en español, cambios pequeños y coherentes. Migraciones nuevas: siempre una versión nueva al final de src/lib/db/migrations.ts, nunca editar las existentes.
- Añade o actualiza tests de la lógica que cambies. Antes de terminar ejecuta \`npm run typecheck\` y \`npm test\` y arregla lo que falle.
- No uses git para confirmar ni cambiar de rama: la app lo hace al aplicar.
- En tu respuesta final: qué has cambiado (archivos y por qué), cómo probarlo y cualquier riesgo. Si el encargo no necesita código, no toques archivos.`
    : null,
);
