import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dbPath } from "./db";

/**
 * Cifrado de credenciales (tokens de servicios externos) con AES-256-GCM.
 * La clave sale de `ORDEN_SECRET_KEY` (32 bytes en hex o base64) o, si no,
 * de `secreto.key` junto a la base de datos (dentro de data/, fuera de git),
 * creada al vuelo con permisos solo para el usuario. Así el token nunca está
 * en claro en la BD, en el repo ni en los registros.
 */

const PREFIX = "v1:";

function keyFile() {
  return path.join(path.dirname(dbPath()), "secreto.key");
}

function parseKey(raw: string): Buffer | null {
  const s = raw.trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return Buffer.from(s, "hex");
  const b = Buffer.from(s, "base64");
  return b.length === 32 ? b : null;
}

function getKey(): Buffer {
  const env = process.env.ORDEN_SECRET_KEY;
  if (env) {
    const k = parseKey(env);
    if (!k) throw new Error("ORDEN_SECRET_KEY debe tener 32 bytes (64 caracteres hex o base64).");
    return k;
  }
  const file = keyFile();
  if (fs.existsSync(file)) {
    const k = parseKey(fs.readFileSync(file, "utf8"));
    if (!k) throw new Error(`La clave de ${file} no es válida.`);
    return k;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const k = randomBytes(32);
  // «wx»: si otro proceso la creó a la vez, se usa la suya.
  try {
    fs.writeFileSync(file, k.toString("hex"), { mode: 0o600, flag: "wx" });
    return k;
  } catch {
    return getKey();
  }
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}

export function decryptSecret(stored: string): string {
  if (!stored.startsWith(PREFIX)) throw new Error("Secreto con formato desconocido.");
  const raw = Buffer.from(stored.slice(PREFIX.length), "base64");
  const decipher = createDecipheriv("aes-256-gcm", getKey(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

/** Pista para la interfaz: nunca el secreto, solo sus 4 últimos caracteres. */
export function secretHint(plain: string): string {
  return plain.length > 8 ? `…${plain.slice(-4)}` : "…";
}

/** Quita un secreto de cualquier texto (mensajes de error, salidas de comandos). */
export function redact(text: string, ...secrets: (string | null | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join("***");
  // Por si acaso: formatos conocidos de tokens de GitHub, Google (acceso, renovación y secreto de cliente),
  // bots de Telegram e integraciones de Notion.
  return out
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "***")
    .replace(/\bya29\.[A-Za-z0-9._-]{20,}/g, "***")
    .replace(/(^|[^A-Za-z0-9])1\/\/[A-Za-z0-9._-]{20,}/g, "$1***")
    .replace(/\bGOCSPX-[A-Za-z0-9_-]{10,}/g, "***")
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{30,}/g, "***")
    .replace(/\b(secret_|ntn_)[A-Za-z0-9]{30,}/g, "***");
}
