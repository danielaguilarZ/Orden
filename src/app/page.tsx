import { AppShell } from "@/components/AppShell";
import { LivingView } from "@/components/LivingView";
import { snapshot } from "@/lib/server";

export const dynamic = "force-dynamic";

export default function Home() {
  const initial = snapshot();
  return (
    <AppShell initial={initial} active="living">
      <LivingView />
    </AppShell>
  );
}
