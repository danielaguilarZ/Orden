import { AppShell } from "@/components/AppShell";
import { FilesPage } from "@/components/FilesPage";
import { snapshot } from "@/lib/server";

export const dynamic = "force-dynamic";

export default function ArchivosPage() {
  return (
    <AppShell initial={snapshot()} active="paneles">
      <FilesPage />
    </AppShell>
  );
}
