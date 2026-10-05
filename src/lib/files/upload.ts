import { formatBytes } from "./rules";

/** Lee el cuerpo de una petición sin pasar de `max` bytes (si se pasa, corta y lanza un error). */
export async function readBodyLimited(req: Request, max: number): Promise<Uint8Array> {
  if (!req.body) throw new Error("No ha llegado ningún archivo.");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new Error(`El archivo supera el límite de ${formatBytes(max)}.`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
