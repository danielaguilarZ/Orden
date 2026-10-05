import { AppShell } from "@/components/AppShell";
import { ConnectionsPage } from "@/components/ConnectionsPage";
import { snapshot } from "@/lib/server";
import "../connections-catalog.css";

export const dynamic = "force-dynamic";

export default function ConexionesPage() {
  return (
    <AppShell initial={snapshot()} active="conexiones">
      <ConnectionsPage />
    </AppShell>
  );
}
