"use client";

import { useRef, useState } from "react";
import type { AttachmentRef, Message } from "@/lib/types";

/**
 * Piezas compartidas de los adjuntos del chat (chat de cada agente y barra de
 * encargos del living): subida, arrastrar, pegar y su presentación.
 */

export const MAX_ATTACHMENTS = 8;
export const ACCEPT = ".pdf,.csv,.tsv,.xlsx,.png,.jpg,.jpeg,.gif,.webp,.txt,.md";
export const contentUrl = (id: string) => `/api/files/${id}/content`;
export const isImage = (mime: string) => mime.startsWith("image/");

/** Adjunto en preparación (antes de enviar el mensaje). */
export interface Pending {
  key: string;
  name: string;
  state: "subiendo" | "ok" | "error";
  error?: string;
  file?: AttachmentRef;
}

/** Nombres que no dicen nada: «image.png» al pegar o «{GUID}.png» de las capturas de Windows. */
const GENERIC_NAME = /^(image|imagen|captura|screenshot|unnamed)\.\w+$|^\{?[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\}?\.\w+$/i;

export function nameFor(f: File, i: number, now = new Date()): string {
  if (f.name && !GENERIC_NAME.test(f.name)) return f.name;
  const ext = (f.name.split(".").pop() || f.type.split("/")[1] || "png").toLowerCase().replace("jpeg", "jpg");
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `captura-${stamp}${i ? `-${i + 1}` : ""}.${ext}`;
}

/** Adjuntos de un mensaje guardado. */
export const attachmentsOf = (m: Message): AttachmentRef[] => (Array.isArray(m.data.attachments) ? (m.data.attachments as AttachmentRef[]) : []);

/** Subida de adjuntos a Archivos/Adjuntos y su estado hasta el envío. */
export function useAttachments() {
  const [pending, setPending] = useState<Pending[]>([]);
  const [error, setError] = useState("");
  const count = useRef(0);
  count.current = pending.length;

  const uploading = pending.some((p) => p.state === "subiendo");
  const ready = pending.flatMap((p) => (p.state === "ok" && p.file ? [p.file] : []));

  async function attach(files: File[]) {
    if (!files.length) return;
    setError("");
    const room = Math.max(0, MAX_ATTACHMENTS - count.current);
    if (files.length > room) setError(`Como máximo ${MAX_ATTACHMENTS} adjuntos por mensaje.`);
    const batch = files.slice(0, room).map((f, i) => ({ f, key: `${Date.now()}-${i}-${Math.random()}`, name: nameFor(f, i) }));
    if (!batch.length) return;
    count.current += batch.length;
    setPending((p) => [...p, ...batch.map((b) => ({ key: b.key, name: b.name, state: "subiendo" as const }))]);
    await Promise.all(
      batch.map(async ({ f, key, name }) => {
        let patch: Partial<Pending>;
        try {
          const res = await fetch(`/api/chat/attachments?name=${encodeURIComponent(name)}`, {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: f,
          });
          const out = (await res.json().catch(() => ({}))) as AttachmentRef & { error?: string };
          patch = res.ok ? { state: "ok", file: out } : { state: "error", error: out.error ?? `Error ${res.status}` };
        } catch (e) {
          patch = { state: "error", error: (e as Error).message };
        }
        setPending((p) => p.map((x) => (x.key === key ? { ...x, ...patch } : x)));
      }),
    );
  }

  return {
    pending,
    ready,
    uploading,
    error,
    setError,
    attach,
    remove: (key: string) => setPending((l) => l.filter((x) => x.key !== key)),
    clear: () => setPending([]),
  };
}

/** Zona donde se pueden soltar archivos: estado de «arrastrando» y manejadores para el elemento. */
export function useFileDrop(onFiles: (files: File[]) => void) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const hasFiles = (e: React.DragEvent) => [...e.dataTransfer.types].includes("Files");
  return {
    dragging,
    dropProps: {
      onDragEnter: (e: React.DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current++;
        setDragging(true);
      },
      onDragOver: (e: React.DragEvent) => {
        if (hasFiles(e)) e.preventDefault();
      },
      onDragLeave: (e: React.DragEvent) => {
        if (!hasFiles(e)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setDragging(false);
      },
      onDrop: (e: React.DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current = 0;
        setDragging(false);
        onFiles([...e.dataTransfer.files]);
      },
    },
  };
}

/**
 * Pegado de capturas o archivos copiados. Si el portapapeles trae también
 * texto (p. ej. celdas de Excel), manda el texto y no se adjunta nada.
 */
export function onPasteFiles(e: React.ClipboardEvent, attach: (files: File[]) => void) {
  const files = [...e.clipboardData.files];
  if (files.length && !e.clipboardData.types.includes("text/plain")) {
    e.preventDefault();
    attach(files);
  }
}

/** Adjuntos de un mensaje enviado: miniatura si es imagen, ficha si no. */
export function AttachmentList({ items }: { items: AttachmentRef[] }) {
  return (
    <div className="attach-list">
      {items.map((a) =>
        isImage(a.mime) ? (
          <a key={a.id} href={contentUrl(a.id)} target="_blank" rel="noreferrer" title={a.name}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="attach-thumb" src={contentUrl(a.id)} alt={a.name} />
          </a>
        ) : (
          <a key={a.id} className="attach-chip" href={`${contentUrl(a.id)}?download=1`} title={a.name}>
            📎 {a.name}
          </a>
        ),
      )}
    </div>
  );
}

/** Adjuntos preparados, con su estado de subida y una ✕ para quitarlos. */
export function PendingList({ pending, onRemove }: { pending: Pending[]; onRemove: (key: string) => void }) {
  if (!pending.length) return null;
  return (
    <div className="attach-pending">
      {pending.map((p) => (
        <span key={p.key} className={`attach-item ${p.state}`} title={p.error ?? p.name}>
          {p.state === "ok" && p.file && isImage(p.file.mime) ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={contentUrl(p.file.id)} alt="" />
          ) : (
            <span aria-hidden>{p.state === "subiendo" ? "⏳" : p.state === "error" ? "⚠️" : "📎"}</span>
          )}
          <span className="attach-name">{p.state === "error" ? `${p.name}: ${p.error}` : p.name}</span>
          <button type="button" className="attach-x" aria-label={`Quitar ${p.name}`} onClick={() => onRemove(p.key)}>
            ×
          </button>
        </span>
      ))}
    </div>
  );
}
