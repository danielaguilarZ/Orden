"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { AttachmentRef } from "@/lib/files/attachments";
import { UPLOAD_ACCEPT, UPLOAD_EXTENSIONS } from "@/lib/files/accept";

/**
 * Adjuntos del chat y de las decisiones: arrastrar y soltar, pegar (⌘V) o el
 * clip. Cada archivo se sube al momento a la carpeta compartida «Adjuntos» y
 * el mensaje lleva solo sus ids.
 */

export const MAX_ATTACHMENTS = 10;

interface Pending {
  key: string;
  name: string;
  size: number;
  status: "subiendo" | "listo" | "error";
  ref?: AttachmentRef;
  error?: string;
  /** Vista previa local de las imágenes. */
  preview?: string;
}

const ext = (name: string) => (name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "");

/** Las capturas pegadas llegan como «image.png»: mejor un nombre con fecha. */
function niceName(file: File): string {
  if (!/^image\.(png|jpe?g|gif|webp)$/i.test(file.name)) return file.name;
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `captura ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}.${ext(file.name)}`;
}

export function useAttachments() {
  const [items, setItems] = useState<Pending[]>([]);
  const previews = useRef<string[]>([]);
  useEffect(() => () => previews.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const update = (key: string, patch: Partial<Pending>) => setItems((list) => list.map((p) => (p.key === key ? { ...p, ...patch } : p)));

  // Cuántos hay ahora (para el límite), sin depender del estado dentro de add.
  const count = useRef(0);
  useEffect(() => {
    count.current = items.length;
  }, [items.length]);

  const upload = (p: Pending, file: File) =>
    fetch(`/api/attachments?name=${encodeURIComponent(p.name)}`, { method: "POST", body: file, headers: { "Content-Type": "application/octet-stream" } })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((body as { error?: string }).error ?? `Error ${res.status}`);
        update(p.key, { status: "listo", ref: body as AttachmentRef });
      })
      .catch((err: Error) => update(p.key, { status: "error", error: err.message }));

  const add = useCallback((files: File[] | FileList) => {
    const list = [...files].slice(0, Math.max(0, MAX_ATTACHMENTS - count.current));
    count.current += list.length;
    const fresh = list.map((file) => {
      const name = niceName(file);
      const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
      if (preview) previews.current.push(preview);
      const bad = !UPLOAD_EXTENSIONS.includes(ext(name));
      const p: Pending = {
        key: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name,
        size: file.size,
        status: bad ? "error" : "subiendo",
        error: bad ? `Tipo no admitido (.${ext(name) || "?"})` : undefined,
        preview,
      };
      return { p, file };
    });
    setItems((current) => [...current, ...fresh.map((f) => f.p)]);
    for (const { p, file } of fresh) if (p.status === "subiendo") upload(p, file);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const remove = (key: string) => setItems((list) => list.filter((p) => p.key !== key));
  const clear = () => setItems([]);
  /** Pegar con ⌘V: si el portapapeles trae archivos (una captura), se adjuntan. */
  const onPaste = (e: React.ClipboardEvent) => {
    const files = [...e.clipboardData.files];
    if (!files.length) return;
    e.preventDefault();
    add(files);
  };
  return {
    items,
    add,
    remove,
    clear,
    onPaste,
    uploading: items.some((p) => p.status === "subiendo"),
    ids: items.filter((p) => p.status === "listo" && p.ref).map((p) => p.ref!.id),
  };
}

/** Zona en la que se pueden soltar archivos (muestra un aviso al arrastrar encima). Admite los atributos de un div. */
export function DropZone({
  onFiles,
  className = "",
  children,
  label = "Suelta para adjuntar",
  disabled = false,
  ...rest
}: Omit<React.HTMLAttributes<HTMLDivElement>, "onDrop"> & { onFiles: (files: FileList) => void; children: ReactNode; label?: string; disabled?: boolean; "data-sky"?: string }) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const hasFiles = (e: React.DragEvent) => !disabled && [...e.dataTransfer.types].includes("Files");
  return (
    <div
      {...rest}
      className={`dropzone ${className}${over ? " over" : ""}`}
      onDragEnter={(e) => {
        if (!hasFiles(e)) return;
        depth.current++;
        setOver(true);
      }}
      onDragOver={(e) => {
        if (hasFiles(e)) e.preventDefault();
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setOver(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        onFiles(e.dataTransfer.files);
      }}
    >
      {children}
      {over && <div className="dropzone-overlay">📎 {label}</div>}
    </div>
  );
}

/** Botón del clip: abre el selector de archivos. */
export function AttachButton({ onFiles, disabled }: { onFiles: (files: FileList) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className="btn ghost small attach-btn" title="Adjuntar archivos (también puedes arrastrarlos o pegar una captura con ⌘V)" disabled={disabled} onClick={() => input.current?.click()}>
        📎
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept={UPLOAD_ACCEPT}
        onChange={(e) => {
          if (e.target.files?.length) onFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </>
  );
}

const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Adjuntos pendientes de enviar, con su estado. */
export function AttachmentTray({ items, onRemove }: { items: Pending[]; onRemove: (key: string) => void }) {
  if (!items.length) return null;
  return (
    <ul className="attach-tray">
      {items.map((p) => (
        <li key={p.key} className={`attach-chip s-${p.status}`} title={p.error ?? p.name}>
          {p.preview ? <img src={p.preview} alt="" /> : <span className="attach-ext">{ext(p.name).toUpperCase() || "?"}</span>}
          <span className="attach-name">{p.name}</span>
          <span className="attach-meta">{p.status === "subiendo" ? "subiendo…" : p.status === "error" ? p.error : kb(p.size)}</span>
          <button type="button" aria-label={`Quitar ${p.name}`} onClick={() => onRemove(p.key)}>
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Adjuntos ya enviados en un mensaje: miniaturas de las imágenes y enlace a cada archivo. */
export function MessageAttachments({ refs }: { refs: AttachmentRef[] }) {
  if (!refs?.length) return null;
  return (
    <div className="msg-attachments">
      {refs.map((r) =>
        r.mime.startsWith("image/") ? (
          <a key={r.id} href={`/api/files/${r.id}/content`} target="_blank" rel="noreferrer" title={r.path}>
            <img src={`/api/files/${r.id}/content`} alt={r.name} loading="lazy" />
          </a>
        ) : (
          <a key={r.id} className="attach-chip s-listo" href={`/api/files/${r.id}/content`} target="_blank" rel="noreferrer" title={r.path}>
            <span className="attach-ext">{ext(r.name).toUpperCase()}</span>
            <span className="attach-name">{r.name}</span>
            <span className="attach-meta">{kb(r.size)}</span>
          </a>
        ),
      )}
    </div>
  );
}
