import fs from "node:fs";
import path from "node:path";

/** Carga .env y .env.local en procesos fuera de Next (worker, scripts). */
export function loadEnv() {
  for (const file of [".env.local", ".env"]) {
    const p = path.join(process.cwd(), file);
    if (fs.existsSync(p)) process.loadEnvFile(p);
  }
}
