import { route } from "@/lib/http";
import { ACTIVE, listTasks } from "@/lib/repo/tasks";

export const dynamic = "force-dynamic";

export const GET = route((req) => {
  const all = new URL(req.url).searchParams.get("all") === "1";
  return listTasks({ statuses: all ? undefined : ACTIVE, limit: 200 }).filter((t) => t.kind !== "ambient");
});
