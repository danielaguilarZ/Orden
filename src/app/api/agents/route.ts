import { route, body } from "@/lib/http";
import { listAgents } from "@/lib/repo/agents";
import { hireAgent, type AgentInput } from "@/lib/team";

export const dynamic = "force-dynamic";

export const GET = route(() => listAgents());

export const POST = route(async (req) => hireAgent(await body<AgentInput>(req)));
