import { createDecipheriv, createCipheriv, createHash } from "node:crypto";
import { inflateSync, unzlibSync } from "fflate";

/**
 * Extracción de texto de PDF sin dependencias (solo fflate para FlateDecode):
 * - Objetos directos y en flujos de objetos (ObjStm), con la última versión ganando.
 * - Fuentes simples (WinAnsi/Differences) y compuestas con ToUnicode.
 * - Posición del texto para reconstruir líneas y columnas (nóminas, extractos).
 * - PDF cifrados con contraseña de usuario vacía (RC4, AES-128 y AES-256), que
 *   es lo habitual en documentos bancarios «protegidos contra cambios».
 * No hace OCR: un PDF escaneado (solo imágenes) no tiene texto que extraer.
 */

// ───────────── Objetos ─────────────

class PdfName {
  constructor(readonly name: string) {}
}
class PdfRef {
  constructor(
    readonly num: number,
    readonly gen: number,
  ) {}
}
class PdfOp {
  constructor(readonly op: string) {}
}
class PdfDict {
  stream?: Uint8Array;
  /** Objeto indirecto al que pertenece el flujo (para descifrarlo) y dónde empieza. */
  num = 0;
  gen = 0;
  streamStart = -1;
  constructor(readonly map: Map<string, PdfObj>) {}
  get(key: string): PdfObj | undefined {
    return this.map.get(key);
  }
}
type PdfObj = number | boolean | null | Uint8Array | PdfName | PdfRef | PdfDict | PdfObj[] | PdfOp;

const isWhite = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
const isDelim = (c: number) => c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;
const hexVal = (c: number) => (c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 0x37 : c >= 0x61 && c <= 0x66 ? c - 0x57 : -1);

const DICT_END = Symbol("dict-end");
const ARRAY_END = Symbol("array-end");
type Token = PdfObj | typeof DICT_END | typeof ARRAY_END | undefined;

/** Lector de objetos PDF sobre bytes (sirve también para flujos de contenido y CMaps). */
class Lexer {
  pos: number;
  constructor(
    readonly d: Uint8Array,
    pos = 0,
  ) {
    this.pos = pos;
  }

  skip() {
    const d = this.d;
    while (this.pos < d.length) {
      const c = d[this.pos];
      if (isWhite(c)) this.pos++;
      else if (c === 0x25) {
        while (this.pos < d.length && d[this.pos] !== 0x0a && d[this.pos] !== 0x0d) this.pos++;
      } else break;
    }
  }

  private literal(): Uint8Array {
    const d = this.d;
    const out: number[] = [];
    let depth = 1;
    this.pos++;
    while (this.pos < d.length) {
      let c = d[this.pos++];
      if (c === 0x5c) {
        c = d[this.pos++];
        if (c === 0x6e) out.push(10);
        else if (c === 0x72) out.push(13);
        else if (c === 0x74) out.push(9);
        else if (c === 0x62) out.push(8);
        else if (c === 0x66) out.push(12);
        else if (c === 0x0d) {
          if (d[this.pos] === 0x0a) this.pos++;
        } else if (c === 0x0a) {
          // continuación de línea
        } else if (c >= 0x30 && c <= 0x37) {
          let v = c - 0x30;
          for (let i = 0; i < 2 && d[this.pos] >= 0x30 && d[this.pos] <= 0x37; i++) v = v * 8 + (d[this.pos++] - 0x30);
          out.push(v & 0xff);
        } else if (c !== undefined) out.push(c);
      } else if (c === 0x28) {
        depth++;
        out.push(c);
      } else if (c === 0x29) {
        if (--depth === 0) break;
        out.push(c);
      } else out.push(c);
    }
    return Uint8Array.from(out);
  }

  private hex(): Uint8Array {
    const d = this.d;
    const out: number[] = [];
    let hi = -1;
    this.pos++;
    while (this.pos < d.length) {
      const c = d[this.pos++];
      if (c === 0x3e) break;
      const v = hexVal(c);
      if (v < 0) continue;
      if (hi < 0) hi = v;
      else {
        out.push(hi * 16 + v);
        hi = -1;
      }
    }
    if (hi >= 0) out.push(hi * 16);
    return Uint8Array.from(out);
  }

  private regular(): string {
    const d = this.d;
    const start = this.pos;
    while (this.pos < d.length && !isWhite(d[this.pos]) && !isDelim(d[this.pos])) this.pos++;
    return Buffer.from(d.subarray(start, this.pos)).toString("latin1");
  }

  token(): Token {
    this.skip();
    const d = this.d;
    if (this.pos >= d.length) return undefined;
    const c = d[this.pos];
    if (c === 0x28) return this.literal();
    if (c === 0x3c) {
      if (d[this.pos + 1] === 0x3c) {
        this.pos += 2;
        return this.dict();
      }
      return this.hex();
    }
    if (c === 0x3e) {
      this.pos += d[this.pos + 1] === 0x3e ? 2 : 1;
      return DICT_END;
    }
    if (c === 0x5b) {
      this.pos++;
      return this.array();
    }
    if (c === 0x5d) {
      this.pos++;
      return ARRAY_END;
    }
    if (c === 0x7b || c === 0x7d || c === 0x29) {
      this.pos++;
      return this.token();
    }
    if (c === 0x2f) {
      this.pos++;
      const raw = this.regular();
      return new PdfName(raw.replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))));
    }
    const word = this.regular();
    if (!word) {
      this.pos++;
      return this.token();
    }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
      const n = Number(word);
      // «num gen R»: referencia indirecta.
      if (/^\d+$/.test(word)) {
        const save = this.pos;
        this.skip();
        const g = this.regular();
        if (/^\d+$/.test(g)) {
          this.skip();
          if (d[this.pos] === 0x52 && (this.pos + 1 >= d.length || isWhite(d[this.pos + 1]) || isDelim(d[this.pos + 1]))) {
            this.pos++;
            return new PdfRef(n, Number(g));
          }
        }
        this.pos = save;
      }
      return n;
    }
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;
    return new PdfOp(word);
  }

  private dict(): PdfDict {
    const map = new Map<string, PdfObj>();
    while (true) {
      const k = this.token();
      if (k === DICT_END || k === undefined) break;
      if (!(k instanceof PdfName)) continue;
      const v = this.token();
      if (v === DICT_END || v === undefined) break;
      if (v === ARRAY_END) continue;
      map.set(k.name, v);
    }
    return new PdfDict(map);
  }

  private array(): PdfObj[] {
    const out: PdfObj[] = [];
    while (true) {
      const t = this.token();
      if (t === ARRAY_END || t === undefined) break;
      if (t === DICT_END) continue;
      out.push(t);
    }
    return out;
  }

  /** Un objeto completo (para leer objetos indirectos). */
  object(): PdfObj | undefined {
    const t = this.token();
    return t === DICT_END || t === ARRAY_END ? undefined : t;
  }
}

// ───────────── Filtros ─────────────

function flate(data: Uint8Array): Uint8Array {
  try {
    return unzlibSync(data);
  } catch {
    try {
      return inflateSync(data.subarray(2));
    } catch {
      return inflateSync(data);
    }
  }
}

function asciiHex(data: Uint8Array): Uint8Array {
  return new Lexer(Uint8Array.from([0x3c, ...data, 0x3e])).token() as Uint8Array;
}

function ascii85(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let group: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    if (c === 0x7e) break; // ~>
    if (isWhite(c)) continue;
    if (c === 0x7a && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    group.push(c - 33);
    if (group.length === 5) {
      let v = 0;
      for (const g of group) v = v * 85 + g;
      out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
      group = [];
    }
  }
  if (group.length) {
    const n = group.length;
    while (group.length < 5) group.push(84);
    let v = 0;
    for (const g of group) v = v * 85 + g;
    const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    out.push(...bytes.slice(0, n - 1));
  }
  return Uint8Array.from(out);
}

/** Deshace el «Predictor» PNG (habitual en flujos de objetos y xref). */
function unpredict(data: Uint8Array, parms: PdfDict | undefined): Uint8Array {
  const predictor = Number(parms?.get("Predictor") ?? 1);
  if (predictor < 10) return data;
  const colors = Number(parms?.get("Colors") ?? 1);
  const bpc = Number(parms?.get("BitsPerComponent") ?? 8);
  const columns = Number(parms?.get("Columns") ?? 1);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  const out = new Uint8Array(Math.floor(data.length / (rowLen + 1)) * rowLen);
  const prev = new Uint8Array(rowLen);
  let o = 0;
  for (let i = 0; i + rowLen < data.length + 1 && o < out.length; i += rowLen + 1) {
    const type = data[i];
    const row = data.subarray(i + 1, i + 1 + rowLen);
    for (let x = 0; x < rowLen; x++) {
      const left = x >= bpp ? out[o + x - bpp] : 0;
      const up = prev[x];
      const ul = x >= bpp ? prev[x - bpp] : 0;
      let v = row[x] ?? 0;
      if (type === 1) v += left;
      else if (type === 2) v += up;
      else if (type === 3) v += (left + up) >> 1;
      else if (type === 4) {
        const p = left + up - ul;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - ul);
        v += pa <= pb && pa <= pc ? left : pb <= pc ? up : ul;
      }
      out[o + x] = v & 255;
    }
    prev.set(out.subarray(o, o + rowLen));
    o += rowLen;
  }
  return out.subarray(0, o);
}

// ───────────── Cifrado (gestor estándar, contraseña de usuario vacía) ─────────────

const PAD = Uint8Array.from([0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a]);

function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = new Uint8Array(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

const md5 = (...parts: Uint8Array[]) => {
  const h = createHash("md5");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};
const sha = (alg: string, ...parts: Uint8Array[]) => {
  const h = createHash(alg);
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};

function aesDecrypt(key: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length < 32 || data.length % 16 !== 0) return new Uint8Array(0);
  const alg = key.length === 32 ? "aes-256-cbc" : "aes-128-cbc";
  const d = createDecipheriv(alg, key, data.subarray(0, 16));
  try {
    return new Uint8Array(Buffer.concat([d.update(data.subarray(16)), d.final()]));
  } catch {
    // Relleno defectuoso: se devuelve lo descifrado sin quitarlo.
    const d2 = createDecipheriv(alg, key, data.subarray(0, 16));
    d2.setAutoPadding(false);
    return new Uint8Array(Buffer.concat([d2.update(data.subarray(16)), d2.final()]));
  }
}

/** Algoritmo 2.B (PDF 2.0, R6). Exportado para los tests. */
export function hash2B(password: Uint8Array, salt: Uint8Array, udata: Uint8Array): Uint8Array {
  let k = sha("sha256", password, salt, udata);
  let e = new Uint8Array([0]);
  for (let i = 0; i < 64 || e[e.length - 1] > i - 32; i++) {
    const unit = new Uint8Array(password.length + k.length + udata.length);
    unit.set(password, 0);
    unit.set(k, password.length);
    unit.set(udata, password.length + k.length);
    const k1 = new Uint8Array(unit.length * 64);
    for (let j = 0; j < 64; j++) k1.set(unit, j * unit.length);
    const c = createCipheriv("aes-128-cbc", k.subarray(0, 16), k.subarray(16, 32));
    c.setAutoPadding(false);
    e = new Uint8Array(Buffer.concat([c.update(k1), c.final()]));
    let sum = 0;
    for (let j = 0; j < 16; j++) sum += e[j];
    k = sha(["sha256", "sha384", "sha512"][sum % 3], e);
  }
  return k.subarray(0, 32);
}

interface Crypt {
  /** Descifra el flujo del objeto num/gen. */
  stream(data: Uint8Array, num: number, gen: number): Uint8Array;
}

function bytesOf(o: PdfObj | undefined): Uint8Array {
  return o instanceof Uint8Array ? o : new Uint8Array(0);
}

/** Prepara el descifrado con la contraseña de usuario vacía; null si hace falta contraseña. */
function setupCrypt(enc: PdfDict, id0: Uint8Array): Crypt | "password" | "unsupported" {
  const filter = enc.get("Filter");
  if (!(filter instanceof PdfName) || filter.name !== "Standard") return "unsupported";
  const v = Number(enc.get("V") ?? 0);
  const r = Number(enc.get("R") ?? 2);
  const O = bytesOf(enc.get("O"));
  const U = bytesOf(enc.get("U"));
  let method: "rc4" | "aes" | "identity" = "rc4";
  let lengthBits = Number(enc.get("Length") ?? 40);
  if (v >= 4) {
    const cf = enc.get("CF");
    const stmf = enc.get("StmF");
    const name = stmf instanceof PdfName ? stmf.name : "Identity";
    if (name === "Identity") method = "identity";
    else {
      const f = cf instanceof PdfDict ? cf.get(name) : undefined;
      const cfm = f instanceof PdfDict ? f.get("CFM") : undefined;
      const cfmName = cfm instanceof PdfName ? cfm.name : "None";
      method = cfmName === "AESV2" || cfmName === "AESV3" ? "aes" : cfmName === "V2" ? "rc4" : "identity";
      const len = f instanceof PdfDict ? Number(f.get("Length") ?? 0) : 0;
      if (len) lengthBits = len <= 32 ? len * 8 : len; // algunos generadores lo ponen en bytes
    }
  }

  if (r >= 5) {
    // AES-256: la clave de archivo va cifrada en UE.
    const pw = new Uint8Array(0);
    const hash = r === 5 ? sha("sha256", pw, U.subarray(32, 40)) : hash2B(pw, U.subarray(32, 40), new Uint8Array(0));
    if (Buffer.compare(Buffer.from(hash), Buffer.from(U.subarray(0, 32))) !== 0) return "password";
    const ik = r === 5 ? sha("sha256", pw, U.subarray(40, 48)) : hash2B(pw, U.subarray(40, 48), new Uint8Array(0));
    const d = createDecipheriv("aes-256-cbc", ik, new Uint8Array(16));
    d.setAutoPadding(false);
    const key = new Uint8Array(Buffer.concat([d.update(bytesOf(enc.get("UE"))), d.final()]));
    return { stream: (data) => (method === "identity" ? data : aesDecrypt(key, data)) };
  }

  const n = r === 2 ? 5 : Math.max(5, Math.min(16, Math.floor(lengthBits / 8)));
  const p = Number(enc.get("P") ?? 0);
  const pBytes = Uint8Array.from([p & 255, (p >> 8) & 255, (p >> 16) & 255, (p >>> 24) & 255]);
  const encMeta = enc.get("EncryptMetadata");
  let key = md5(PAD, O.subarray(0, 32), pBytes, id0, r >= 4 && encMeta === false ? Uint8Array.from([255, 255, 255, 255]) : new Uint8Array(0)).subarray(0, n);
  if (r >= 3) for (let i = 0; i < 50; i++) key = md5(key).subarray(0, n);

  // Comprueba la contraseña de usuario vacía (algoritmos 4 y 5).
  let check: Uint8Array;
  if (r === 2) check = rc4(key, PAD);
  else {
    check = rc4(key, md5(PAD, id0));
    for (let i = 1; i <= 19; i++) check = rc4(key.map((b) => b ^ i), check);
  }
  const len = r === 2 ? 32 : 16;
  if (Buffer.compare(Buffer.from(check.subarray(0, len)), Buffer.from(U.subarray(0, len))) !== 0) return "password";

  return {
    stream(data, num, gen) {
      if (method === "identity") return data;
      const extra = Uint8Array.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255]);
      const objKey = md5(key, extra, method === "aes" ? Uint8Array.from([0x73, 0x41, 0x6c, 0x54]) : new Uint8Array(0)).subarray(0, Math.min(n + 5, 16));
      return method === "aes" ? aesDecrypt(objKey, data) : rc4(objKey, data);
    },
  };
}

// ───────────── Documento ─────────────

interface Entry {
  obj: PdfObj;
  num: number;
  gen: number;
}

class PdfDoc {
  readonly objects = new Map<number, Entry>();
  readonly text: string;
  crypt: Crypt | null = null;
  private decoded = new WeakMap<PdfDict, Uint8Array | null>();

  constructor(readonly data: Uint8Array) {
    this.text = Buffer.from(data).toString("latin1");
    this.scan();
  }

  /** Recorre «N G obj … endobj» saltándose los flujos (para no leer «obj» dentro de datos binarios). */
  private scan() {
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.text))) {
      const num = Number(m[1]);
      const gen = Number(m[2]);
      const lx = new Lexer(this.data, m.index + m[0].length);
      let obj: PdfObj | undefined;
      try {
        obj = lx.object();
      } catch {
        continue;
      }
      if (obj === undefined) continue;
      if (obj instanceof PdfDict) {
        lx.skip();
        if (this.text.startsWith("stream", lx.pos)) {
          let start = lx.pos + 6;
          if (this.data[start] === 0x0d) start++;
          if (this.data[start] === 0x0a) start++;
          const len = obj.get("Length");
          let end = -1;
          if (typeof len === "number" && start + len <= this.data.length && /^\s*endstream/.test(this.text.slice(start + len, start + len + 20))) end = start + len;
          if (end < 0) {
            const e = this.text.indexOf("endstream", start);
            end = e < 0 ? this.data.length : e;
            while (end > start && (this.data[end - 1] === 0x0a || this.data[end - 1] === 0x0d)) end--;
          }
          obj.stream = this.data.subarray(start, end);
          obj.num = num;
          obj.gen = gen;
          obj.streamStart = start;
          re.lastIndex = Math.max(re.lastIndex, end);
        }
      }
      this.objects.set(num, { obj, num, gen });
    }
    // /Length indirecto («/Length 12 0 R»): ahora que todo está cargado, se usa
    // para cortar el flujo exacto (importante en flujos cifrados).
    for (const { obj } of this.objects.values()) {
      if (!(obj instanceof PdfDict) || obj.streamStart < 0 || !(obj.get("Length") instanceof PdfRef)) continue;
      const len = this.num(obj.get("Length"), -1);
      const end = obj.streamStart + len;
      if (len >= 0 && end <= this.data.length && /^\s*endstream/.test(this.text.slice(end, end + 20))) obj.stream = this.data.subarray(obj.streamStart, end);
    }
  }

  get(o: PdfObj | undefined, depth = 0): PdfObj | undefined {
    if (o instanceof PdfRef) {
      if (depth > 20) return undefined;
      return this.get(this.objects.get(o.num)?.obj, depth + 1);
    }
    return o;
  }
  dict(o: PdfObj | undefined): PdfDict | undefined {
    const v = this.get(o);
    return v instanceof PdfDict ? v : undefined;
  }
  array(o: PdfObj | undefined): PdfObj[] {
    const v = this.get(o);
    return Array.isArray(v) ? v : [];
  }
  num(o: PdfObj | undefined, fallback = 0): number {
    const v = this.get(o);
    return typeof v === "number" ? v : fallback;
  }
  name(o: PdfObj | undefined): string | undefined {
    const v = this.get(o);
    return v instanceof PdfName ? v.name : undefined;
  }

  /** Datos de un flujo: descifrado y sin filtros. null si usa un filtro que no sabemos leer. */
  streamData(d: PdfDict): Uint8Array | null {
    if (this.decoded.has(d)) return this.decoded.get(d)!;
    let data: Uint8Array | null = d.stream ?? null;
    if (data && this.crypt && this.name(d.get("Type")) !== "XRef") data = this.crypt.stream(data, d.num, d.gen);
    const filters = this.get(d.get("Filter"));
    const list = (Array.isArray(filters) ? filters : filters ? [filters] : []).map((f) => this.name(f));
    const parmsRaw = this.get(d.get("DecodeParms"));
    const parms = (Array.isArray(parmsRaw) ? parmsRaw : [parmsRaw]).map((p) => this.dict(p));
    try {
      list.forEach((f, i) => {
        if (!data) return;
        if (f === "FlateDecode" || f === "Fl") data = unpredict(flate(data), parms[i]);
        else if (f === "ASCIIHexDecode" || f === "AHx") data = asciiHex(data);
        else if (f === "ASCII85Decode" || f === "A85") data = ascii85(data);
        else data = null; // imágenes (DCT, JBIG2…) u otros: no son texto
      });
    } catch {
      data = null;
    }
    this.decoded.set(d, data);
    return data;
  }

  /** Objetos guardados dentro de flujos de objetos (PDF 1.5+). No pisan los directos. */
  loadObjectStreams() {
    for (const e of [...this.objects.values()]) {
      const d = e.obj;
      if (!(d instanceof PdfDict) || this.name(d.get("Type")) !== "ObjStm") continue;
      const data = this.streamData(d);
      if (!data) continue;
      const n = this.num(d.get("N"));
      const first = this.num(d.get("First"));
      const head = new Lexer(data);
      const pairs: [number, number][] = [];
      for (let i = 0; i < n; i++) {
        const a = head.object();
        const b = head.object();
        if (typeof a !== "number" || typeof b !== "number") break;
        pairs.push([a, b]);
      }
      for (const [num, off] of pairs) {
        if (this.objects.has(num)) continue;
        try {
          const obj = new Lexer(data, first + off).object();
          if (obj !== undefined) this.objects.set(num, { obj, num, gen: 0 });
        } catch {
          // objeto dañado: se ignora
        }
      }
    }
  }

  /** Último valor de una clave del tráiler («/Root 1 0 R», «/Encrypt …», «/ID […]»). */
  trailer(key: string): PdfObj | undefined {
    const re = new RegExp(`/${key}(?![A-Za-z])`, "g");
    let last = -1;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.text))) last = m.index + m[0].length;
    if (last < 0) return undefined;
    return new Lexer(this.data, last).object();
  }

  /** Páginas en orden (siguiendo el árbol /Pages), con los recursos heredados. */
  pages(): { page: PdfDict; resources: PdfDict | undefined }[] {
    const out: { page: PdfDict; resources: PdfDict | undefined }[] = [];
    const seen = new Set<PdfDict>();
    const walk = (node: PdfDict | undefined, res: PdfDict | undefined, depth: number) => {
      if (!node || seen.has(node) || depth > 50) return;
      seen.add(node);
      const r = this.dict(node.get("Resources")) ?? res;
      const kids = node.get("Kids");
      if (this.name(node.get("Type")) === "Page" || (!kids && node.get("Contents") !== undefined)) out.push({ page: node, resources: r });
      else for (const k of this.array(kids)) walk(this.dict(k), r, depth + 1);
    };
    let root = this.dict(this.trailer("Root"));
    if (!root || this.name(root.get("Type")) !== "Catalog") {
      root = [...this.objects.values()].map((e) => e.obj).find((o): o is PdfDict => o instanceof PdfDict && this.name(o.get("Type")) === "Catalog");
    }
    walk(this.dict(root?.get("Pages")), undefined, 0);
    if (!out.length) {
      // Sin catálogo legible: todas las páginas por orden de objeto.
      for (const e of [...this.objects.values()].sort((a, b) => a.num - b.num)) {
        if (e.obj instanceof PdfDict && this.name(e.obj.get("Type")) === "Page") out.push({ page: e.obj, resources: this.dict(e.obj.get("Resources")) });
      }
    }
    return out;
  }
}

// ───────────── Fuentes ─────────────

/** Windows-1252 (WinAnsiEncoding) para 0x80-0x9F; el resto coincide con Latin-1. */
const WIN_ANSI_HIGH: Record<number, string> = {
  0x80: "€", 0x82: "‚", 0x83: "ƒ", 0x84: "„", 0x85: "…", 0x86: "†", 0x87: "‡", 0x88: "ˆ", 0x89: "‰", 0x8a: "Š", 0x8b: "‹", 0x8c: "Œ", 0x8e: "Ž",
  0x91: "‘", 0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—", 0x98: "˜", 0x99: "™", 0x9a: "š", 0x9b: "›", 0x9c: "œ", 0x9e: "ž", 0x9f: "Ÿ",
};
const winAnsi = (code: number) => WIN_ANSI_HIGH[code] ?? (code >= 0x20 ? String.fromCharCode(code) : code === 9 ? " " : "");

/** Nombres de glifo habituales (para /Differences). Las letras sueltas valen tal cual. */
const GLYPHS: Record<string, string> = {
  space: " ", exclam: "!", quotedbl: '"', numbersign: "#", dollar: "$", percent: "%", ampersand: "&", quotesingle: "'", quoteright: "’", quoteleft: "‘",
  parenleft: "(", parenright: ")", asterisk: "*", plus: "+", comma: ",", hyphen: "-", minus: "-", period: ".", slash: "/", colon: ":", semicolon: ";",
  less: "<", equal: "=", greater: ">", question: "?", at: "@", bracketleft: "[", backslash: "\\", bracketright: "]", underscore: "_", braceleft: "{",
  bar: "|", braceright: "}", zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9",
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú",
  agrave: "à", egrave: "è", ograve: "ò", ntilde: "ñ", Ntilde: "Ñ", udieresis: "ü", Udieresis: "Ü", ccedilla: "ç", Ccedilla: "Ç",
  ordfeminine: "ª", ordmasculine: "º", degree: "°", questiondown: "¿", exclamdown: "¡", Euro: "€", euro: "€", endash: "–", emdash: "—",
  bullet: "•", quotedblleft: "“", quotedblright: "”", guillemotleft: "«", guillemotright: "»", periodcentered: "·", ellipsis: "…", fi: "fi", fl: "fl",
  nbspace: " ", sterling: "£", section: "§", copyright: "©", registered: "®", multiply: "×", divide: "÷", acute: "´", dieresis: "¨",
};
function glyphChar(name: string): string {
  if (GLYPHS[name] !== undefined) return GLYPHS[name];
  if (/^[A-Za-z]$/.test(name)) return name;
  const uni = /^uni([0-9A-Fa-f]{4,6})$/.exec(name) ?? /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (uni) return String.fromCodePoint(parseInt(uni[1], 16));
  return "";
}

interface Font {
  /** Trocea los bytes de una cadena en códigos. */
  codes(bytes: Uint8Array): number[];
  /** Texto de un código. */
  text(code: number): string;
  /** Ancho del código en milésimas de em. */
  width(code: number): number;
  oneByte: boolean;
}

function utf16be(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  if (bytes.length === 1) s += String.fromCharCode(bytes[0]);
  return s;
}
function bytesToInt(b: Uint8Array): number {
  let v = 0;
  for (const x of b) v = v * 256 + x;
  return v;
}

/** ToUnicode: bfchar/bfrange y rangos de longitud de código. */
function parseCMap(data: Uint8Array): { map: Map<number, string>; lengths: number[] } {
  const map = new Map<number, string>();
  const lengths = new Set<number>();
  const lx = new Lexer(data);
  const stack: PdfObj[] = [];
  let mode = "";
  let guard = 0;
  while (guard++ < 2_000_000) {
    const t = lx.token();
    if (t === undefined) break;
    if (t === DICT_END || t === ARRAY_END) continue;
    if (t instanceof PdfOp) {
      const op = t.op;
      if (op === "begincodespacerange" || op === "beginbfchar" || op === "beginbfrange") {
        mode = op;
        stack.length = 0;
      } else if (op === "endcodespacerange") {
        for (let i = 0; i + 1 < stack.length; i += 2) if (stack[i] instanceof Uint8Array) lengths.add((stack[i] as Uint8Array).length);
        mode = "";
      } else if (op === "endbfchar") {
        for (let i = 0; i + 1 < stack.length; i += 2) {
          const src = stack[i];
          const dst = stack[i + 1];
          if (src instanceof Uint8Array && dst instanceof Uint8Array) map.set(bytesToInt(src), utf16be(dst));
          else if (src instanceof Uint8Array && dst instanceof PdfName) map.set(bytesToInt(src), glyphChar(dst.name));
        }
        mode = "";
      } else if (op === "endbfrange") {
        for (let i = 0; i + 2 < stack.length; i += 3) {
          const lo = stack[i];
          const hi = stack[i + 1];
          const dst = stack[i + 2];
          if (!(lo instanceof Uint8Array) || !(hi instanceof Uint8Array)) continue;
          const a = bytesToInt(lo);
          const b = Math.min(bytesToInt(hi), a + 65535);
          for (let c = a; c <= b; c++) {
            if (dst instanceof Uint8Array && dst.length) {
              const d = Uint8Array.from(dst);
              d[d.length - 1] += c - a;
              map.set(c, utf16be(d));
            } else if (Array.isArray(dst)) {
              const item = dst[c - a];
              if (item instanceof Uint8Array) map.set(c, utf16be(item));
            }
          }
        }
        mode = "";
      }
      continue;
    }
    if (mode) stack.push(t);
  }
  return { map, lengths: [...lengths].sort((a, b) => a - b) };
}

function loadFont(doc: PdfDoc, fd: PdfDict | undefined): Font {
  const subtype = doc.name(fd?.get("Subtype"));
  const composite = subtype === "Type0";
  let toUni: { map: Map<number, string>; lengths: number[] } | null = null;
  const tu = doc.dict(fd?.get("ToUnicode"));
  if (tu) {
    const data = doc.streamData(tu);
    if (data) toUni = parseCMap(data);
  }

  // Codificación de fuentes simples.
  const diffs = new Map<number, string>();
  const enc = doc.get(fd?.get("Encoding"));
  let base = enc instanceof PdfName ? enc.name : "WinAnsiEncoding";
  if (enc instanceof PdfDict) {
    base = doc.name(enc.get("BaseEncoding")) ?? base;
    let code = 0;
    for (const item of doc.array(enc.get("Differences"))) {
      if (typeof item === "number") code = item;
      else if (item instanceof PdfName) diffs.set(code++, glyphChar(item.name));
    }
  }
  const mac = base === "MacRomanEncoding";

  // Anchos.
  const widths = new Map<number, number>();
  let defaultWidth = composite ? 1000 : 500;
  if (composite) {
    const desc = doc.dict(doc.array(fd?.get("DescendantFonts"))[0]);
    defaultWidth = doc.num(desc?.get("DW"), 1000);
    const w = doc.array(desc?.get("W"));
    for (let i = 0; i < w.length; ) {
      const first = doc.num(w[i]);
      const next = doc.get(w[i + 1]);
      if (Array.isArray(next)) {
        next.forEach((x, j) => widths.set(first + j, doc.num(x)));
        i += 2;
      } else {
        const last = doc.num(next);
        const val = doc.num(w[i + 2]);
        for (let c = first; c <= last && c - first < 65536; c++) widths.set(c, val);
        i += 3;
      }
    }
  } else {
    const firstChar = doc.num(fd?.get("FirstChar"), 0);
    doc.array(fd?.get("Widths")).forEach((x, j) => widths.set(firstChar + j, doc.num(x)));
    const descr = doc.dict(fd?.get("FontDescriptor"));
    const missing = doc.num(descr?.get("MissingWidth"), 0);
    if (missing) defaultWidth = missing;
  }

  const lengths = toUni?.lengths.length ? toUni.lengths : [composite ? 2 : 1];
  return {
    oneByte: !composite,
    codes(bytes) {
      const out: number[] = [];
      for (let i = 0; i < bytes.length; ) {
        // El código más corto que exista en el mapa; si no, la longitud por defecto.
        let len = lengths[lengths.length - 1];
        if (lengths.length > 1 && toUni) {
          for (const l of lengths) {
            if (toUni.map.has(bytesToInt(bytes.subarray(i, i + l)))) {
              len = l;
              break;
            }
          }
        }
        out.push(bytesToInt(bytes.subarray(i, i + len)));
        i += len;
      }
      return out;
    },
    text(code) {
      const u = toUni?.map.get(code);
      if (u !== undefined) return u.replace(/\u0000/g, "");
      if (composite) return "";
      if (diffs.has(code)) return diffs.get(code)!;
      if (mac && code >= 0x80) return Buffer.from([code]).toString("latin1");
      return winAnsi(code);
    },
    width(code) {
      return widths.get(code) ?? defaultWidth;
    },
  };
}

// ───────────── Contenido de página ─────────────

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
function mul(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

interface Run {
  x: number;
  y: number;
  xEnd: number;
  size: number;
  text: string;
}

function contentRuns(doc: PdfDoc, data: Uint8Array, resources: PdfDict | undefined, baseCtm: Matrix, runs: Run[], depth: number, fontCache: Map<PdfDict, Font>) {
  const fontsDict = doc.dict(resources?.get("Font"));
  const xobjects = doc.dict(resources?.get("XObject"));
  const fontFor = (name: string): Font => {
    const fd = doc.dict(fontsDict?.get(name));
    if (!fd) return loadFont(doc, undefined);
    let f = fontCache.get(fd);
    if (!f) fontCache.set(fd, (f = loadFont(doc, fd)));
    return f;
  };

  let ctm = baseCtm;
  const stack: Matrix[] = [];
  let tm: Matrix = IDENTITY;
  let lm: Matrix = IDENTITY;
  let font: Font = loadFont(doc, undefined);
  let fontSize = 1;
  let charSpace = 0;
  let wordSpace = 0;
  let hScale = 1;
  let leading = 0;

  const show = (s: Uint8Array) => {
    const m = mul(tm, ctm);
    const size = Math.abs(fontSize) * Math.hypot(m[2], m[3]) || Math.abs(fontSize);
    let text = "";
    let adv = 0;
    for (const code of font.codes(s)) {
      text += font.text(code);
      const w = (font.width(code) / 1000) * fontSize;
      const ws = font.oneByte && code === 32 ? wordSpace : 0;
      adv += (w + charSpace + ws) * hScale;
    }
    const end = mul([1, 0, 0, 1, adv, 0], m);
    if (text) runs.push({ x: m[4], y: m[5], xEnd: end[4], size, text });
    tm = mul([1, 0, 0, 1, adv, 0], tm);
  };
  const nextLine = () => {
    lm = mul([1, 0, 0, 1, 0, -leading], lm);
    tm = lm;
  };

  const lx = new Lexer(data);
  const ops: PdfObj[] = [];
  let guard = 0;
  while (guard++ < 5_000_000) {
    const t = lx.token();
    if (t === undefined) break;
    if (t === DICT_END || t === ARRAY_END) continue;
    if (!(t instanceof PdfOp)) {
      ops.push(t);
      continue;
    }
    const a = ops.splice(0);
    const n = (i: number) => (typeof a[i] === "number" ? (a[i] as number) : 0);
    switch (t.op) {
      case "q":
        stack.push(ctm);
        break;
      case "Q":
        ctm = stack.pop() ?? baseCtm;
        break;
      case "cm":
        ctm = mul([n(0), n(1), n(2), n(3), n(4), n(5)], ctm);
        break;
      case "BT":
        tm = lm = IDENTITY;
        break;
      case "Tf":
        if (a[0] instanceof PdfName) font = fontFor(a[0].name);
        fontSize = n(1) || 1;
        break;
      case "Tc":
        charSpace = n(0);
        break;
      case "Tw":
        wordSpace = n(0);
        break;
      case "Tz":
        hScale = n(0) / 100;
        break;
      case "TL":
        leading = n(0);
        break;
      case "Td":
        lm = mul([1, 0, 0, 1, n(0), n(1)], lm);
        tm = lm;
        break;
      case "TD":
        leading = -n(1);
        lm = mul([1, 0, 0, 1, n(0), n(1)], lm);
        tm = lm;
        break;
      case "Tm":
        lm = tm = [n(0), n(1), n(2), n(3), n(4), n(5)];
        break;
      case "T*":
        nextLine();
        break;
      case "Tj":
        if (a[0] instanceof Uint8Array) show(a[0]);
        break;
      case "'":
        nextLine();
        if (a[0] instanceof Uint8Array) show(a[0]);
        break;
      case '"':
        wordSpace = n(0);
        charSpace = n(1);
        nextLine();
        if (a[2] instanceof Uint8Array) show(a[2]);
        break;
      case "TJ":
        for (const item of Array.isArray(a[0]) ? a[0] : []) {
          if (item instanceof Uint8Array) show(item);
          // Un hueco grande dentro de TJ (espacio entre palabras) lo detecta layoutRuns por la posición.
          else if (typeof item === "number") tm = mul([1, 0, 0, 1, (-item / 1000) * fontSize * hScale, 0], tm);
        }
        break;
      case "Do": {
        if (depth >= 6 || !(a[0] instanceof PdfName)) break;
        const xo = doc.dict(xobjects?.get(a[0].name));
        if (!xo || doc.name(xo.get("Subtype")) !== "Form") break;
        const sub = doc.streamData(xo);
        if (!sub) break;
        const mtx = doc.array(xo.get("Matrix")).map((v) => doc.num(v));
        const formMatrix: Matrix = mtx.length === 6 ? (mtx as Matrix) : IDENTITY;
        contentRuns(doc, sub, doc.dict(xo.get("Resources")) ?? resources, mul(formMatrix, ctm), runs, depth + 1, fontCache);
        break;
      }
      case "BI": {
        // Imagen en línea (BI … ID datos EI): saltar los datos binarios.
        const m = /\sEI(?=\s|$)/.exec(Buffer.from(data.subarray(lx.pos)).toString("latin1"));
        lx.pos = m ? lx.pos + m.index + m[0].length : data.length;
        break;
      }
    }
  }
}

/** Ordena los trozos de texto por líneas (de arriba abajo) y columnas (de izquierda a derecha). */
export function layoutRuns(runs: Run[]): string {
  if (!runs.length) return "";
  const sorted = runs.slice().sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Run[][] = [];
  for (const r of sorted) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(line[0].y - r.y) <= Math.max(1.5, Math.min(line[0].size, r.size) * 0.45)) line.push(r);
    else lines.push([r]);
  }
  return lines
    .map((line) => {
      line.sort((a, b) => a.x - b.x);
      let s = "";
      let prev: Run | null = null;
      for (const r of line) {
        if (prev) {
          const gap = r.x - prev.xEnd;
          const size = Math.max(prev.size, r.size);
          if (gap > size * 1.5) s = s.trimEnd() + "   ";
          else if (gap > size * 0.2 &&!s.endsWith(" ") && !r.text.startsWith(" ")) s += " ";
        }
        s += r.text;
        prev = r;
      }
      return s.replace(/\s+$/, "");
    })
    .filter((l) => l.trim())
    .join("\n");
}

export interface PdfText {
  pages: string[];
  /** Aviso si no se ha podido leer (cifrado con contraseña, sin texto…). */
  warning?: string;
}

/** Extrae el texto de cada página. Nunca lanza: si algo falla, lo dice en `warning`. */
export function extractPdfText(data: Uint8Array): PdfText {
  let doc: PdfDoc;
  try {
    doc = new PdfDoc(data);
  } catch (err) {
    return { pages: [], warning: `No se ha podido leer el PDF: ${(err as Error).message}` };
  }
  const encRef = doc.trailer("Encrypt");
  if (encRef !== undefined) {
    const enc = doc.dict(encRef);
    const idArr = doc.trailer("ID");
    const id0 = Array.isArray(idArr) && idArr[0] instanceof Uint8Array ? idArr[0] : new Uint8Array(0);
    const crypt = enc ? setupCrypt(enc, id0) : "unsupported";
    if (crypt === "password") return { pages: [], warning: "El PDF está protegido con contraseña: no se puede leer sin ella." };
    if (crypt === "unsupported") return { pages: [], warning: "El PDF usa un cifrado que no se puede leer." };
    doc.crypt = crypt;
  }
  doc.loadObjectStreams();
  const fontCache = new Map<PdfDict, Font>();
  const pages: string[] = [];
  for (const { page, resources } of doc.pages()) {
    try {
      const contents = doc.get(page.get("Contents"));
      const streams = (Array.isArray(contents) ? contents : [contents]).map((c) => doc.dict(c)).filter((d): d is PdfDict => Boolean(d));
      const parts = streams.map((s) => doc.streamData(s)).filter((d): d is Uint8Array => Boolean(d));
      const joined = new Uint8Array(parts.reduce((s, p) => s + p.length + 1, 0));
      let o = 0;
      for (const p of parts) {
        joined.set(p, o);
        o += p.length;
        joined[o++] = 0x0a;
      }
      const runs: Run[] = [];
      contentRuns(doc, joined, resources, IDENTITY, runs, 0, fontCache);
      pages.push(layoutRuns(runs));
    } catch {
      pages.push("");
    }
  }
  if (!pages.length) return { pages, warning: "No se han encontrado páginas en el PDF." };
  if (!pages.some((p) => p.trim())) return { pages, warning: "El PDF no tiene texto (probablemente es un escaneo o una imagen)." };
  return { pages };
}
