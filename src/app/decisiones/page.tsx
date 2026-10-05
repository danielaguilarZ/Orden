import { AppShell } from "@/components/AppShell";
import { DecisionsPage } from "@/components/DecisionsPage";
import { snapshot } from "@/lib/server";

export const dynamic = "force-dynamic";

export default function DecisionesPage() {
  return (
    <AppShell initial={snapshot()} active="decisiones">
      <DecisionsPage />
    </AppShell>
  );
}
