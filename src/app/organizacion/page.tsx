import { AppShell } from "@/components/AppShell";
import { OrgPage } from "@/components/OrgPage";
import { snapshot } from "@/lib/server";

export const dynamic = "force-dynamic";

export default function OrganizacionPage() {
  return (
    <AppShell initial={snapshot()} active="organizacion">
      <OrgPage />
    </AppShell>
  );
}
