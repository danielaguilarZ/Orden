import { z } from "zod";
import { route, body } from "@/lib/http";
import { createMemory, listMemory, searchMemory } from "@/lib/repo/memory";

export const dynamic = "force-dynamic";

/** Lista (o busca con ?q=) el perfil de vida. ?archived=1 para la papelera. */
export const GET = route((req) => {
  const params = new URL(req.url).searchParams;
  const q = params.get("q")?.trim();
  if (q) return searchMemory(q, { limit: 50 });
  return listMemory({ archived: params.get("archived") === "1" });
});

const schema = z.object({
  category: z.string().min(1),
  title: z.string().trim().min(1, "Ponle un título"),
  content: z.string().trim().min(1, "Escribe el contenido"),
  tags: z.array(z.string()).optional(),
});

export const POST = route(async (req) => createMemory(schema.parse(await body(req)), { by: "user" }));
