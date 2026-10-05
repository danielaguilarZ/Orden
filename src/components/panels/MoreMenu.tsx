"use client";

import { useEffect, useRef, useState } from "react";

export interface MenuItem {
  label: string;
  onClick: () => void;
  /** Acción destructiva (se pinta en rojo). */
  danger?: boolean;
  disabled?: boolean;
}

/**
 * Botón con menú desplegable para las acciones secundarias: así la tarjeta o
 * la cabecera solo enseñan la acción principal. El menú es `fixed` para que
 * no lo recorte el `overflow` de la tarjeta.
 */
export function MoreMenu({ items, label = "⋯", title = "Más opciones", className = "icon-btn small" }: { items: MenuItem[]; label?: string; title?: string; className?: string }) {
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pos) return;
    const close = (e: Event) => {
      if (e.type === "keydown" && (e as KeyboardEvent).key !== "Escape") return;
      if (e.type === "mousedown" && (menu.current?.contains(e.target as Node) || btn.current?.contains(e.target as Node))) return;
      setPos(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [pos]);

  const toggle = () => {
    if (pos) return setPos(null);
    const r = btn.current!.getBoundingClientRect();
    setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
  };

  return (
    <>
      <button ref={btn} type="button" className={className} title={title} aria-haspopup="menu" aria-expanded={Boolean(pos)} onClick={toggle}>
        {label}
      </button>
      {pos && (
        <div ref={menu} className="more-menu" role="menu" style={{ top: pos.top, right: pos.right }}>
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className={it.danger ? "danger" : ""}
              disabled={it.disabled}
              onClick={() => {
                setPos(null);
                it.onClick();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
