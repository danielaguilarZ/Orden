import { AppShell } from "@/components/AppShell";
import { ProposalsPage } from "@/components/ProposalsPage";
import { snapshot } from "@/lib/server";

export const dynamic = "force-dynamic";

export default function PropuestasPage() {
  return (
    <AppShell initial={snapshot()} active="propuestas">
      <ProposalsPage />
    </AppShell>
  );
}
