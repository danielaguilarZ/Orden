import { NextResponse } from "next/server";
import { forbidden, isLocalRequest } from "@/lib/localhost";
import { snapshot } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isLocalRequest(req)) return forbidden();
  return NextResponse.json(snapshot());
}
