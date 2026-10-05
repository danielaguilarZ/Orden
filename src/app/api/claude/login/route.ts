import { NextResponse } from "next/server";
import { forbidden, isLocalRequest } from "@/lib/localhost";
import { cancelLogin, loginSnapshot, startLogin, submitLoginCode } from "@/lib/claude/login";

export const dynamic = "force-dynamic";

/** Progreso del inicio de sesión en curso. */
export async function GET(req: Request) {
  if (!isLocalRequest(req)) return forbidden();
  return NextResponse.json(loginSnapshot());
}

/** { action: "start" | "code" | "cancel", code? } — solo desde localhost. */
export async function POST(req: Request) {
  if (!isLocalRequest(req)) return forbidden();
  const body = (await req.json().catch(() => ({}))) as { action?: string; code?: string };
  try {
    switch (body.action) {
      case "start":
        return NextResponse.json(startLogin());
      case "code":
        if (!body.code?.trim()) return NextResponse.json({ error: "Falta el código." }, { status: 400 });
        return NextResponse.json(submitLoginCode(body.code));
      case "cancel":
        return NextResponse.json(cancelLogin());
      default:
        return NextResponse.json({ error: "Acción desconocida." }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 409 });
  }
}
