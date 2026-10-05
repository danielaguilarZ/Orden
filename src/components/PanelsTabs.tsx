import Link from "next/link";

/** Pestañas de la sección Paneles: el tablero y los archivos. */
export function PanelsTabs({ active }: { active: "tablero" | "archivos" }) {
  return (
    <nav className="subtabs">
      <Link href="/paneles" className={active === "tablero" ? "on" : ""}>
        Tablero
      </Link>
      <Link href="/paneles/archivos" className={active === "archivos" ? "on" : ""}>
        Archivos
      </Link>
    </nav>
  );
}
