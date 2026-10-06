import { redirect } from "next/navigation";

/** Los paneles se quitaron de Orden (sus datos siguen en la base de datos): queda Archivos. */
export default function PanelesPage() {
  redirect("/archivos");
}
