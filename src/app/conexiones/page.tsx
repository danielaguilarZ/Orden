import { AppShell } from "@/components/AppShell";
import { ConnectionsPage } from "@/components/ConnectionsPage";
import { snapshot } from "@/lib/server";
import "../connections-catalog.css";
// Estilos del menú «⋯» (MoreMenu) que usan las filas de conexión.
import "../panels-simple.css";

export const dynamic = "force-dynamic";

export default function ConexionesPage() {
  return (
    <AppShell initial={snapshot()} active="conexiones">
      <ConnectionsPage />
    </AppShell>
  );
}
