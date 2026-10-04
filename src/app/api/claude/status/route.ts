import { NextResponse } from "next/server";
import { forbidden, isLocalRequest } from "@/lib/localhost";
import { getClaudeStatus } from "@/lib/claude/auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isLocalRequest(req)) return forbidden();
  const force = new URL(req.url).searchParams.get("force") === "1";
  return NextResponse.json(await getClaudeStatus(force));
}
