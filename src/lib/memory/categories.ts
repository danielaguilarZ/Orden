/** Categorías del perfil de vida (se pueden añadir más: es solo texto). */
export const MEMORY_CATEGORIES: { key: string; label: string; hint: string }[] = [
  { key: "quien_soy", label: "Quién soy", hint: "Nombre, edad, dónde vive, a qué se dedica…" },
  { key: "objetivos", label: "Objetivos", hint: "Metas a corto y largo plazo" },
  { key: "preferencias", label: "Preferencias", hint: "Gustos, cómo le gusta que le hablen, horarios…" },
  { key: "personas", label: "Personas importantes", hint: "Familia, amistades, trabajo, cumpleaños…" },
  { key: "rutinas", label: "Rutinas", hint: "Hábitos y horarios habituales" },
  { key: "proyectos", label: "Proyectos abiertos", hint: "Lo que tiene entre manos" },
  { key: "decisiones", label: "Decisiones tomadas", hint: "Qué se decidió y por qué" },
  { key: "otros", label: "Otros", hint: "Cualquier otra cosa útil" },
];
