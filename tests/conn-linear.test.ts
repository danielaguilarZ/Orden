import { describe, expect, it } from "vitest";
import { getService } from "@/lib/connections/registry";
import { issueLine, linearLimit } from "@/lib/connections/linear";
import { callTool, connect, headersOf, jsonBody, mockFetch, team, textOf, toolNames, useConnTestEnv } from "./helpers/conn";

const KEY = "lin_api_0123456789abcdefghijklmnopqrstuvwxyzABCD";
useConnTestEnv(() => linearLimit.reset());

const issue = { identifier: "ENG-7", title: "Arreglar login", url: "https://linear.app/x/issue/ENG-7", priority: 2, dueDate: "2026-10-09", state: { name: "In Progress" }, assignee: { name: "Dani" } };

function linear(_url: string, init?: RequestInit) {
  const { query } = JSON.parse(String(init?.body)) as { query: string };
  if (query.includes("assignedIssues")) return { data: { viewer: { name: "Dani", assignedIssues: { nodes: [issue] } } } };
  if (query.includes("issueCreate")) return { data: { issueCreate: { success: true, issue: { ...issue, identifier: "ENG-8", title: "Nuevo" } } } };
  if (query.includes("commentCreate")) return { data: { commentCreate: { success: true } } };
  if (query.includes("teams")) return { data: { teams: { nodes: [{ id: "t-uuid", key: "ENG", name: "Ingeniería" }] } } };
  if (query.includes("issues(")) return { data: { issues: { nodes: [] } } };
  if (query.includes("organization")) return { data: { viewer: { name: "Dani", organization: { name: "Acme" } } } };
  return { errors: [{ message: "consulta desconocida" }] };
}

describe("Linear", () => {
  it("formatea issues", () => {
    expect(issueLine(issue)).toBe("- ENG-7 Arreglar login · In Progress · alta · vence 2026-10-09 · para Dani · https://linear.app/x/issue/ENG-7");
  });

  it("lectura: mis issues, búsqueda y equipos; la clave va tal cual en Authorization", async () => {
    connect("linear", {}, KEY, { agent: team.ana, level: "lectura" });
    expect(toolNames(team.ana, "linear")).toEqual(["linear_buscar", "linear_equipos", "linear_mis_issues"]);
    const calls = mockFetch(linear);
    expect(textOf(await callTool(team.ana, "linear_mis_issues"))).toContain("1 issue(s) abiertos asignados a Dani");
    expect(headersOf(calls[0]).get("authorization")).toBe(KEY);
    expect(jsonBody(calls[0]).variables).toEqual({ n: 25 });
    expect(textOf(await callTool(team.ana, "linear_buscar", { texto: "pago" }))).toBe("Ningún issue con «pago».");
    expect(textOf(await callTool(team.ana, "linear_equipos"))).toBe("- ENG · Ingeniería");
  });

  it("completo: crea en un equipo por clave y comenta por identificador", async () => {
    connect("linear", {}, KEY, { agent: team.ana, level: "completo" });
    const calls = mockFetch(linear);
    const r = await callTool(team.ana, "linear_crear_issue", { equipo: "eng", titulo: "Nuevo", prioridad: 1 });
    expect(textOf(r)).toContain("Issue creado: - ENG-8 Nuevo");
    expect(jsonBody(calls.at(-1)!).variables).toEqual({ input: { teamId: "t-uuid", title: "Nuevo", priority: 1 } });
    const bad = await callTool(team.ana, "linear_crear_issue", { equipo: "XYZ", titulo: "x" });
    expect(textOf(bad)).toContain("Equipos: ENG (Ingeniería)");
    expect(textOf(await callTool(team.ana, "linear_comentar", { issue: "ENG-7", texto: "Revisado" }))).toBe("Comentario añadido a ENG-7.");
    expect((await callTool(team.ana, "linear_comentar", { issue: "ENG 7; drop", texto: "x" })).isError).toBe(true);
  });

  it("errores de GraphQL y prueba, sin la clave", async () => {
    const c = connect("linear", {}, KEY, { agent: team.ana, level: "lectura" });
    mockFetch(() => ({ errors: [{ message: `Authentication required ${KEY}` }] }));
    const r = await callTool(team.ana, "linear_equipos");
    expect(r.isError).toBe(true);
    expect(textOf(r)).not.toContain(KEY);
    mockFetch(linear);
    expect((await getService("linear").test(c)).text).toBe("Linear conectado como Dani (Acme).");
  });
});
