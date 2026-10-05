"use client";

/**
 * Sistema común de presentación: cabecera de página y de sección, tarjeta
 * plegable, chip, filtros, buscador y estado vacío. Mismo lenguaje visual en
 * todas las pestañas: títulos claros, bloques cortos y detalle bajo demanda.
 * Estilos en src/app/ui-kit.css (prefijo `ui-`).
 */

import { useEffect, useState, type ReactNode } from "react";

/** Cabecera de página: título, contador, una línea de subtítulo y acciones a la derecha. */
export function PageHeader({ title, count, subtitle, children }: { title: string; count?: ReactNode; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <header className="ui-page-head">
      <div className="ui-page-title">
        <h1>
          {title}
          {count !== undefined && count !== null && <span className="ui-count">{count}</span>}
        </h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {children && <div className="ui-page-actions">{children}</div>}
    </header>
  );
}

/** Barra de herramientas bajo la cabecera (buscador, filtros…). */
export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="ui-toolbar">{children}</div>;
}

/**
 * Cabecera de sección con icono y contador. Con `onToggle` se pliega/despliega
 * al pulsar el título.
 */
export function SectionHeader({
  icon,
  title,
  count,
  hint,
  open,
  onToggle,
  actions,
}: {
  icon?: ReactNode;
  title: ReactNode;
  count?: number;
  hint?: ReactNode;
  open?: boolean;
  onToggle?: () => void;
  actions?: ReactNode;
}) {
  const inner = (
    <>
      {onToggle && <span className={`ui-caret${open ? " open" : ""}`} aria-hidden />}
      {icon && <span className="ui-section-icon" aria-hidden>{icon}</span>}
      <span className="ui-section-title">{title}</span>
      {count !== undefined && <span className="ui-count">{count}</span>}
      {hint && <span className="ui-section-hint">{hint}</span>}
    </>
  );
  return (
    <div className="ui-section-head">
      {onToggle ? (
        <button type="button" className="ui-section-toggle" aria-expanded={open} onClick={onToggle}>
          {inner}
        </button>
      ) : (
        <div className="ui-section-toggle static">{inner}</div>
      )}
      {actions && <span className="ui-section-actions">{actions}</span>}
    </div>
  );
}

/** Sección plegable (cabecera + contenido). El estado plegado se puede controlar desde fuera. */
export function Section({
  open,
  onToggle,
  children,
  className = "",
  ...head
}: Parameters<typeof SectionHeader>[0] & { children: ReactNode; className?: string }) {
  return (
    <section className={`ui-section ${className}`}>
      <SectionHeader open={open} onToggle={onToggle} {...head} />
      {(open ?? true) && <div className="ui-section-body">{children}</div>}
    </section>
  );
}

export type Tone = "ok" | "warn" | "bad" | "info" | "accent" | "off";

/** Etiqueta corta (estado, tipo, etiqueta de usuario). */
export function Chip({ children, tone, icon, title }: { children: ReactNode; tone?: Tone; icon?: ReactNode; title?: string }) {
  return (
    <span className={`ui-chip${tone ? ` tone-${tone}` : ""}`} title={title}>
      {icon && <span aria-hidden>{icon}</span>}
      {children}
    </span>
  );
}

export interface FilterOption {
  key: string;
  label: string;
  icon?: ReactNode;
  count?: number;
}

/** Filtros en forma de chips (uno activo). */
export function FilterChips({ options, value, onChange, label }: { options: FilterOption[]; value: string; onChange: (key: string) => void; label?: string }) {
  return (
    <div className="ui-filters" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.key} type="button" className={`ui-filter${value === o.key ? " on" : ""}`} aria-pressed={value === o.key} onClick={() => onChange(o.key)}>
          {o.icon && <span aria-hidden>{o.icon}</span>}
          {o.label}
          {o.count !== undefined && <span className="ui-filter-count">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Buscador con lupa y botón para limpiar. */
export function SearchBox({ value, onChange, placeholder = "Buscar…" }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="ui-search">
      <span aria-hidden>⌕</span>
      <input type="search" value={value} placeholder={placeholder} aria-label={placeholder} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.key === "Escape" && onChange("")} />
      {value && (
        <button type="button" className="ui-search-clear" aria-label="Limpiar búsqueda" onClick={() => onChange("")}>
          ×
        </button>
      )}
    </label>
  );
}

/** Estado vacío amable: icono, una frase y, si hay, una acción. */
export function EmptyState({ icon = "✨", title, children, action }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="ui-empty">
      <span className="ui-empty-icon" aria-hidden>
        {icon}
      </span>
      <strong>{title}</strong>
      {children && <p>{children}</p>}
      {action && <div className="ui-empty-action">{action}</div>}
    </div>
  );
}

/**
 * Tarjeta corta: título, una línea de resumen y una fila de chips/meta. Al
 * pulsarla se despliega el detalle (`children`) y sus acciones. `side` queda
 * siempre visible a la derecha (p. ej. un interruptor).
 */
export function Card({
  title,
  summary,
  chips,
  meta,
  open,
  onToggle,
  side,
  actions,
  children,
  tone,
  className = "",
}: {
  title: ReactNode;
  summary?: ReactNode;
  chips?: ReactNode;
  meta?: ReactNode;
  open?: boolean;
  onToggle?: () => void;
  side?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  const head = (
    <>
      <span className="ui-card-title">{title}</span>
      {summary && !open && <span className="ui-card-summary">{summary}</span>}
      {(chips || meta) && (
        <span className="ui-card-meta">
          {chips}
          {meta && <span className="ui-card-meta-text">{meta}</span>}
        </span>
      )}
    </>
  );
  return (
    <article className={`ui-card${open ? " open" : ""}${tone ? ` tone-${tone}` : ""}${onToggle ? " clickable" : ""} ${className}`}>
      <div className="ui-card-row">
        {onToggle ? (
          <button type="button" className="ui-card-head" aria-expanded={open} onClick={onToggle}>
            {head}
          </button>
        ) : (
          <div className="ui-card-head">{head}</div>
        )}
        {side && <div className="ui-card-side">{side}</div>}
      </div>
      {open && (children || actions) && (
        <div className="ui-card-body">
          {children}
          {actions && <footer className="ui-card-actions">{actions}</footer>}
        </div>
      )}
    </article>
  );
}

/** Conjunto de claves abiertas/plegadas, recordado en el navegador. */
export function useToggleSet(storageKey?: string): [Set<string>, (key: string) => void] {
  const [set, setSet] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!storageKey) return;
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) setSet(new Set(JSON.parse(raw) as string[]));
    } catch {
      // Sin almacenamiento: se queda en memoria.
    }
  }, [storageKey]);
  const toggle = (key: string) =>
    setSet((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      if (storageKey) {
        try {
          localStorage.setItem(storageKey, JSON.stringify([...next]));
        } catch {
          // Ignorado.
        }
      }
      return next;
    });
  return [set, toggle];
}
