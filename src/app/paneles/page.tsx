import { AppShell } from "@/components/AppShell";
import { PanelsBoard } from "@/components/PanelsBoard";
import { snapshot } from "@/lib/server";
import "../panels-simple.css";

export const dynamic = "force-dynamic";

export default function PanelesPage() {
  return (
    <AppShell initial={snapshot()} active="paneles">
      <PanelsBoard />
    </AppShell>
  );
}
