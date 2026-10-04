import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { forbidden, isLocalRequest } from "./localhost";
import { boot } from "./server";

type Handler<C> = (req: Request, ctx: C) => Promise<unknown> | unknown;

/** Envuelve una ruta: solo localhost, BD lista y errores como JSON en español. */
export function route<C = unknown>(fn: Handler<C>) {
  return async (req: Request, ctx: C) => {
    if (!isLocalRequest(req)) return forbidden();
    try {
      boot();
      const out = await fn(req, ctx);
      return out instanceof Response ? out : NextResponse.json(out ?? { ok: true });
    } catch (err) {
      if (err instanceof ZodError) {
        return NextResponse.json({ error: err.issues.map((i) => i.message).join(". ") }, { status: 400 });
      }
      return NextResponse.json({ error: (err as Error).message }, { status: 400 });
    }
  };
}

export async function body<T = Record<string, unknown>>(req: Request): Promise<T> {
  return (await req.json().catch(() => ({}))) as T;
}

export type IdCtx = { params: Promise<{ id: string }> };
