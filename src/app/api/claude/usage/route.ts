import { route } from "@/lib/http";
import { getStoredUsage, refreshUsage } from "@/lib/claude/usage";

export const dynamic = "force-dynamic";

/** Últimos límites leídos (los refresca el worker cada pocos minutos). */
export const GET = route(() => getStoredUsage());

/** Leerlos ahora (no gasta uso: no llama al modelo). */
export const POST = route(() => refreshUsage());
