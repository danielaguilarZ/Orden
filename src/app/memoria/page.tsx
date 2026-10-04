import { AppShell } from "@/components/AppShell";
import { MemoryPage } from "@/components/MemoryPage";
import { snapshot } from "@/lib/server";

export const dynamic = "force-dynamic";

export default function MemoriaPage() {
  return (
    <AppShell initial={snapshot()} active="memoria">
      <MemoryPage />
    </AppShell>
  );
}
