/**
 * Alternativa por terminal al botón «Conectar con Claude».
 *   npm run claude:status  → estado de la sesión
 *   npm run claude:login   → inicia sesión con tu cuenta de Claude
 */
import { spawn } from "node:child_process";
import { loadEnv } from "../src/lib/env";
import { claudeBinaryPath, claudeEnv } from "../src/lib/claude/binary";
import { getClaudeStatus } from "../src/lib/claude/auth";

loadEnv();
const cmd = process.argv[2];

async function main() {
  if (cmd === "status") {
    const s = await getClaudeStatus(true);
    if (s.connected) console.log(`✔ Claude conectado: ${s.email ?? ""} ${s.plan ? `(plan ${s.plan})` : ""} · modo ${s.mode}`);
    else console.log(`✘ Claude desconectado. ${s.error ?? "Ejecuta npm run claude:login."}`);
    process.exit(s.connected ? 0 : 1);
  }
  if (cmd === "login") {
    const bin = claudeBinaryPath();
    if (!bin) {
      console.error("No encuentro el binario de Claude Code del SDK. Ejecuta npm install.");
      process.exit(1);
    }
    const child = spawn(bin, ["auth", "login", "--claudeai"], { stdio: "inherit", env: claudeEnv() as NodeJS.ProcessEnv });
    child.on("close", (code) => process.exit(code ?? 0));
    return;
  }
  console.log("Uso: tsx scripts/claude-cli.ts <status|login>");
}

main();
