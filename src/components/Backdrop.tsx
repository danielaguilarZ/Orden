"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Fondo de las ventanas emergentes. Se pinta en <body> con un portal para que
 * ningún contenedor animado (paneles, ficha del agente…) lo recorte o lo
 * desplace: siempre ocupa la pantalla entera.
 */
export function Backdrop({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClick();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClick]);
  if (!mounted) return null;
  return createPortal(
    <div className="modal-backdrop" onClick={onClick}>
      {children}
    </div>,
    document.body,
  );
}
