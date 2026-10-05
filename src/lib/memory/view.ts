/**
 * Presentación de la pestaña Memoria: iconos, filtro y agrupación por
 * categoría. Lógica pura (sin servidor ni React) para poder probarla.
 */

import { MEMORY_CATEGORIES } from "./categories";
import { matches } from "../ui/text";

export interface MemoryLike {
  category: string;
  title: string;
  content: string;
  tags: string[];
  updatedAt: string;
}

export interface CategoryInfo {
  key: string;
  label: string;
  hint: string;
  icon: string;
}

const ICONS: Record<string, string> = {
  quien_soy: "🪪",
  objetivos: "🎯",
  preferencias: "⭐",
  personas: "👥",
  rutinas: "🔁",
  proyectos: "📂",
  decisiones: "⚖️",
  otros: "📌",
};

/** Icono de una categoría (las inventadas por los agentes llevan uno genérico). */
export const categoryIcon = (key: string) => ICONS[key] ?? "🗂️";

/** Categorías conocidas y, al final, las que aparezcan en los datos sin estar en la lista. */
export function memoryCategories(entries: MemoryLike[]): CategoryInfo[] {
  const known = MEMORY_CATEGORIES.map((c) => ({ ...c, icon: categoryIcon(c.key) }));
  const extra = [...new Set(entries.map((e) => e.category))]
    .filter((k) => !MEMORY_CATEGORIES.some((c) => c.key === k))
    .sort()
    .map((k) => ({ key: k, label: k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()), hint: "", icon: categoryIcon(k) }));
  return [...known, ...extra];
}

/** Filtra por texto (título, contenido, etiquetas y categoría; sin tildes) y por categoría. */
export function filterMemory<T extends MemoryLike>(entries: T[], query: string, category = "", cats: CategoryInfo[] = memoryCategories(entries)): T[] {
  const label = (k: string) => cats.find((c) => c.key === k)?.label ?? k;
  return entries.filter(
    (e) => (!category || e.category === category) && matches(`${e.title} ${e.content} ${e.tags.join(" ")} ${label(e.category)}`, query),
  );
}

/** Grupos por categoría (en el orden de `cats`), lo más reciente primero. Solo los que tienen algo. */
export function groupMemory<T extends MemoryLike>(entries: T[], cats: CategoryInfo[] = memoryCategories(entries)): { cat: CategoryInfo; entries: T[] }[] {
  return cats
    .map((cat) => ({ cat, entries: entries.filter((e) => e.category === cat.key).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }))
    .filter((g) => g.entries.length > 0);
}

/** Cuántos recuerdos hay por categoría. */
export function countByCategory(entries: MemoryLike[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of entries) out[e.category] = (out[e.category] ?? 0) + 1;
  return out;
}
