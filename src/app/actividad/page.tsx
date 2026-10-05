import { AppShell } from "@/components/AppShell";
import { ActivityPage } from "@/components/ActivityPage";
import { snapshot } from "@/lib/server";

export const dynamic = "force-dynamic";

export default function ActividadPage() {
  return (
    <AppShell initial={snapshot()} active="actividad">
      <ActivityPage />
    </AppShell>
  );
}
