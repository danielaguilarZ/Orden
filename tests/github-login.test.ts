import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, openDb, setDbForTests } from "@/lib/db";
import { ensureSeed } from "@/lib/seed";
import { hireAgent } from "@/lib/team";
import { createTask } from "@/lib/repo/tasks";
import { buildTools, type ToolDef } from "@/lib/agents/tools";
import { buildSystemPrompt } from "@/lib/agents/prompt";
import { addConnection } from "@/lib/connections";
import { getService } from "@/lib/connections/registry";
import { getConnectionSecret, grantsForAgent, listConnections, setConnectionSecret, setGrant } from "@/lib/repo/connections";
import { ALL_REPOS, isAllRepos, setTransportForTests, type GhRequest } from "@/lib/connections/github/api";
import {
  assertAllowed,
  cancelLogin,
  loginInfo,
  parseClientId,
  pollLogin,
  saveClientId,
  setLoginFetchForTests,
  startLogin,
  type LoginRequest,
} from "@/lib/connections/github/login";
import "@/lib/agents/modules";
import type { Agent } from "@/lib/types";

const CLIENT = "Ov23liABCDEFGH123456";
const TOKEN = "gho_tokenDeEjemplo1234567890abcdefghijkl";
const T0 = 1_800_000_000_000;

beforeAll(() => {
  process.env.ORDEN_SECRET_KEY = "b".repeat(64);
});
afterAll(() => {
  delete process.env.ORDEN_SECRET_KEY;
  delete process.env.ORDEN_GITHUB_CLIENT_ID;
  setLoginFetchForTests(null);
  setTransportForTests(null);
});

let ana: Agent;
let sent: LoginRequest[] = [];
/** Respuestas que dará el «GitHub» de mentira a cada paso del flujo. */
let tokenReplies: Record<string, unknown>[] = [];
let deviceReply: Record<string, unknown> = {};

function fakeLogin() {
  sent = [];
  deviceReply = { device_code: "DEVICE-SECRETO-123", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 };
  tokenReplies = [];
  setLoginFetchForTests(async (req) => {
    sent.push(req);
    if (req.url.endsWith("/login/device/code")) return deviceReply;
    if (req.url.endsWith("/login/oauth/access_token")) return tokenReplies.shift() ?? { error: "authorization_pending" };
    if (req.url === "https://api.github.com/user") return { login: "mi-usuario" };
    throw new Error(`Ruta no prevista: ${req.url}`);
  });
}

beforeEach(() => {
  delete process.env.ORDEN_GITHUB_CLIENT_ID;
  setDbForTests(openDb(":memory:"));
  ensureSeed();
  ana = hireAgent({ name: "Ana", specialty: "Desarrolladora backend" });
  fakeLogin();
});

describe("Client ID", () => {
  it("sin Client ID no se puede iniciar y la interfaz lo sabe", async () => {
    expect(loginInfo()).toMatchObject({ clientConfigured: false, clientSource: null, pending: null, connected: null });
    await expect(startLogin(T0)).rejects.toThrow(/Client ID/);
    expect(sent).toHaveLength(0);
  });

  it("se toma de Ajustes y, si no, del entorno", () => {
    process.env.ORDEN_GITHUB_CLIENT_ID = "Ov23liDELENTORNO123";
    expect(loginInfo()).toMatchObject({ clientConfigured: true, clientSource: "entorno" });
    saveClientId(CLIENT);
    expect(loginInfo()).toMatchObject({ clientConfigured: true, clientSource: "ajustes", clientIdHint: "Ov23li…" });
    saveClientId(null);
    expect(loginInfo().clientSource).toBe("entorno");
  });

  it("valida el formato", () => {
    expect(parseClientId(`  ${CLIENT} `)).toBe(CLIENT);
    expect(() => parseClientId("corto")).toThrow(/no es válido/);
    expect(() => parseClientId("con espacios dentro 123")).toThrow(/no es válido/);
    expect(() => saveClientId("<script>")).toThrow(/no es válido/);
  });
});

describe("flujo de dispositivo", () => {
  beforeEach(() => saveClientId(CLIENT));

  it("pide el código con el Client ID y los permisos de repo y no enseña el código de dispositivo", async () => {
    const p = await startLogin(T0);
    expect(p).toEqual({ userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", expiresAt: T0 + 900_000, interval: 5 });
    expect(sent[0]).toMatchObject({ method: "POST", url: "https://github.com/login/device/code", form: { client_id: CLIENT, scope: "repo read:user" } });
    const stored = getDb().prepare("SELECT value FROM settings WHERE key = 'github.login.pendiente'").get() as { value: string };
    expect(stored.value).not.toContain("DEVICE-SECRETO-123");
    expect(JSON.stringify(loginInfo(T0 + 1000))).not.toContain("DEVICE-SECRETO");
    expect(loginInfo(T0 + 1000).pending?.userCode).toBe("ABCD-1234");
  });

  it("no abre nada que no sea github.com", async () => {
    deviceReply = { ...deviceReply, verification_uri: "https://phishing.example/login" };
    expect((await startLogin(T0)).verificationUri).toBe("https://github.com/login/device");
  });

  it("explica los errores típicos de la OAuth App", async () => {
    deviceReply = { error: "device_flow_disabled" };
    await expect(startLogin(T0)).rejects.toThrow(/Enable Device Flow/);
    deviceReply = { error: "incorrect_client_credentials" };
    await expect(startLogin(T0)).rejects.toThrow(/no reconoce ese Client ID/);
  });

  it("mientras no se autoriza, sigue pendiente y no molesta a GitHub antes de tiempo", async () => {
    await startLogin(T0);
    sent = [];
    expect(await pollLogin(T0 + 1000)).toEqual({ status: "pendiente", interval: 5 });
    expect(sent).toHaveLength(0); // aún no tocaba preguntar
    expect(await pollLogin(T0 + 6000)).toEqual({ status: "pendiente", interval: 5 });
    expect(sent).toHaveLength(1);
    expect(sent[0].form).toMatchObject({ client_id: CLIENT, device_code: "DEVICE-SECRETO-123", grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
  });

  it("si GitHub pide ir más despacio, sube el intervalo", async () => {
    await startLogin(T0);
    tokenReplies = [{ error: "slow_down", interval: 10 }];
    expect(await pollLogin(T0 + 6000)).toEqual({ status: "pendiente", interval: 10 });
    expect(loginInfo(T0 + 7000).pending?.interval).toBe(10);
  });

  it("al autorizar crea la conexión de cuenta con el token cifrado", async () => {
    await startLogin(T0);
    tokenReplies = [{ access_token: TOKEN, scope: "repo,read:user", token_type: "bearer" }];
    const r = await pollLogin(T0 + 6000);
    expect(r).toMatchObject({ status: "ok", account: "mi-usuario" });
    const conns = listConnections("github");
    expect(conns).toHaveLength(1);
    expect(conns[0]).toMatchObject({ name: "GitHub · mi-usuario", auth: "token", enabled: true, config: { repo: ALL_REPOS } });
    expect(r.status === "ok" && r.connectionId).toBe(conns[0].id);
    expect(getConnectionSecret(conns[0].id)).toBe(TOKEN);
    const raw = getDb().prepare("SELECT secret FROM connections WHERE id = ?").get(conns[0].id) as { secret: string };
    expect(raw.secret).not.toContain(TOKEN);
    expect(sent.at(-1)).toMatchObject({ method: "GET", url: "https://api.github.com/user", token: TOKEN });
    // Ya no queda nada pendiente y la interfaz ve la cuenta conectada (sin token).
    expect(loginInfo(T0 + 7000)).toMatchObject({ pending: null, connected: { id: conns[0].id, name: "GitHub · mi-usuario" } });
    expect(JSON.stringify(loginInfo(T0 + 7000))).not.toContain(TOKEN);
  });

  it("volver a iniciar sesión renueva el token de la misma conexión (sin duplicarla ni quitar permisos)", async () => {
    await startLogin(T0);
    tokenReplies = [{ access_token: TOKEN }];
    const first = await pollLogin(T0 + 6000);
    const id = first.status === "ok" ? first.connectionId : "";
    setGrant(id, ana.id, "lectura");
    await startLogin(T0 + 100_000);
    tokenReplies = [{ access_token: "gho_otroTokenNuevo9876543210zyxwvutsrqponm" }];
    const second = await pollLogin(T0 + 110_000);
    expect(second).toMatchObject({ status: "ok", connectionId: id });
    expect(listConnections("github")).toHaveLength(1);
    expect(getConnectionSecret(id)).toBe("gho_otroTokenNuevo9876543210zyxwvutsrqponm");
    expect(grantsForAgent(ana.id, "github")[0].level).toBe("lectura");
  });

  it("denegado, caducado o cancelado: error claro y se limpia", async () => {
    await startLogin(T0);
    tokenReplies = [{ error: "access_denied" }];
    expect(await pollLogin(T0 + 6000)).toMatchObject({ status: "error", text: expect.stringMatching(/cancelado/) });
    expect(loginInfo(T0 + 7000).pending).toBeNull();

    await startLogin(T0);
    tokenReplies = [{ error: "expired_token" }];
    expect(await pollLogin(T0 + 6000)).toMatchObject({ status: "error", text: expect.stringMatching(/caducado/) });

    await startLogin(T0);
    expect(await pollLogin(T0 + 901_000)).toMatchObject({ status: "error", text: expect.stringMatching(/caducado/) });

    await startLogin(T0);
    cancelLogin();
    expect(await pollLogin(T0 + 6000)).toMatchObject({ status: "error" });
    expect(listConnections("github")).toHaveLength(0);
  });

  it("los errores no dejan ver el token", async () => {
    await startLogin(T0);
    tokenReplies = [{ access_token: TOKEN }];
    setLoginFetchForTests(async (req) => {
      if (req.url.endsWith("/access_token")) return { access_token: TOKEN };
      throw new Error(`fallo con ${TOKEN}`);
    });
    const r = await pollLogin(T0 + 6000);
    expect(r.status).toBe("error");
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(listConnections("github")).toHaveLength(0);
  });

  it("solo se puede hablar con los destinos de OAuth y el perfil", () => {
    expect(() => assertAllowed({ method: "POST", url: "https://github.com/login/device/code" })).not.toThrow();
    expect(() => assertAllowed({ method: "GET", url: "https://api.github.com/user" })).not.toThrow();
    expect(() => assertAllowed({ method: "POST", url: "https://api.github.com/user/repos" })).toThrow(/no permitido/);
    expect(() => assertAllowed({ method: "GET", url: "https://evil.example/" })).toThrow(/no permitido/);
  });
});

describe("conexión de cuenta («todos los repositorios»)", () => {
  let calls: GhRequest[] = [];
  beforeEach(() => {
    calls = [];
    setTransportForTests(async (req) => {
      calls.push(req);
      const p = req.path;
      if (p === "/user") return { login: "mi-usuario" };
      if (p.startsWith("/user/repos?"))
        return [
          { full_name: "mi-usuario/orden", private: true, default_branch: "main", description: "La app", pushed_at: "2026-10-07T10:00:00Z", permissions: { push: true } },
          { full_name: "amigo/proyecto", private: false, default_branch: "dev", description: null, pushed_at: null, permissions: { push: false }, fork: true },
        ];
      if (p === "/repos/amigo/proyecto") return { full_name: "amigo/proyecto", default_branch: "dev", html_url: "https://github.com/amigo/proyecto", private: false, open_issues_count: 0 };
      if (p.startsWith("/repos/amigo/proyecto/pulls?")) return [];
      if (p.startsWith("/repos/amigo/proyecto/issues?")) return [];
      if (p.startsWith("/repos/amigo/proyecto/commits?")) return [];
      if (p === "/repos/amigo/proyecto/issues" && req.method === "POST") return { number: 4, html_url: "https://github.com/amigo/proyecto/issues/4" };
      throw new Error(`Ruta no prevista: ${req.method} ${p}`);
    });
  });

  const toolsOf = (agent: Agent): ToolDef[] => buildTools({ agent, task: createTask({ agentId: agent.id, kind: "chat", prompt: "x" }), signal: new AbortController().signal, note: () => {} });
  const names = (agent: Agent) => toolsOf(agent).map((t) => t.name).filter((n) => n.startsWith("github_")).sort();
  const call = async (agent: Agent, name: string, args: Record<string, unknown>) => {
    const t = toolsOf(agent).find((x) => x.name === name);
    if (!t) throw new Error(`no hay ${name}`);
    return (await t.handler(args, {})) as { content: { text: string }[]; isError?: boolean };
  };

  function account(level: "lectura" | "completo") {
    const c = addConnection("github", { repo: "*" });
    setConnectionSecret(c.id, TOKEN);
    getDb().prepare("UPDATE connections SET auth = 'token' WHERE id = ?").run(c.id);
    setGrant(c.id, ana.id, level);
    return c;
  }

  it("«*», «todos» y «todos los repositorios» significan todos", () => {
    for (const v of ["*", "todos", "Todos los repositorios", "all"]) expect(isAllRepos(v)).toBe(true);
    for (const v of ["mi-usuario/web", "", "todosmisrepos"]) expect(isAllRepos(v)).toBe(false);
    const c = addConnection("github", { repo: "todos los repos" });
    expect(c).toMatchObject({ name: "GitHub · todos los repositorios", config: { repo: "*" } });
    expect(() => addConnection("github", { repo: "*" })).toThrow(/ya existe/);
  });

  it("los repos concretos siguen validándose igual", () => {
    expect(() => addConnection("github", { repo: "no es un repo" })).toThrow(/propietario\/nombre/);
  });

  it("con lectura, el agente ve el parámetro repo y github_repos, pero no escribe", async () => {
    account("lectura");
    expect(names(ana)).toContain("github_repos");
    expect(names(ana)).not.toContain("github_crear_issue");
    const resumen = toolsOf(ana).find((t) => t.name === "github_resumen")!;
    expect((resumen as unknown as { inputSchema: Record<string, unknown> }).inputSchema).toHaveProperty("repo");
    const list = await call(ana, "github_repos", {});
    expect(list.content[0].text).toContain("mi-usuario/orden · privado, escritura · rama main");
    expect(list.content[0].text).toContain("amigo/proyecto · público, solo lectura, fork · rama dev");
  });

  it("lee el repo que indique y pide que lo indique", async () => {
    account("lectura");
    const ok = await call(ana, "github_resumen", { repo: "amigo/proyecto" });
    expect(ok.isError).toBeFalsy();
    expect(ok.content[0].text).toContain("amigo/proyecto");
    expect(calls.some((c) => c.path === "/repos/amigo/proyecto")).toBe(true);
    const sinRepo = await call(ana, "github_resumen", {});
    expect(sinRepo.isError).toBe(true);
    expect(sinRepo.content[0].text).toContain("github_repos");
    const malo = await call(ana, "github_resumen", { repo: "../../etc" });
    expect(malo.isError).toBe(true);
    expect(calls.every((c) => !c.path.includes(".."))).toBe(true);
  });

  it("con permiso completo puede crear issues en cualquier repo de la cuenta", async () => {
    account("completo");
    expect(names(ana)).toContain("github_crear_issue");
    const r = await call(ana, "github_crear_issue", { repo: "amigo/proyecto", titulo: "Fallo" });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain("issues/4");
  });

  it("un repo concreto con permiso completo no se mezcla con una cuenta de solo lectura", async () => {
    const solo = addConnection("github", { repo: "amigo/proyecto" });
    setGrant(solo.id, ana.id, "completo");
    account("lectura");
    // Escribir en «amigo/proyecto» lo permite su conexión concreta; en otro repo, no.
    const okRepo = await call(ana, "github_crear_issue", { repo: "amigo/proyecto", titulo: "Fallo" });
    expect(okRepo.isError).toBeFalsy();
    const otro = await call(ana, "github_crear_issue", { repo: "mi-usuario/orden", titulo: "Otro" });
    expect(otro.isError).toBe(true);
    expect(otro.content[0].text).toContain("permiso de escritura");
  });

  it("el prompt lo explica", () => {
    account("lectura");
    const prompt = buildSystemPrompt(ana, createTask({ agentId: ana.id, kind: "chat", prompt: "x" }));
    expect(prompt).toContain("Todos los repos de la cuenta");
    expect(prompt).toContain("github_repos");
  });

  it("«Probar conexión» dice quién es y cuántos repos ve", async () => {
    const c = account("lectura");
    const r = await getService("github").test(listConnections("github").find((x) => x.id === c.id)!);
    expect(r.ok).toBe(true);
    expect(r.text).toContain("mi-usuario");
    expect(r.text).toContain("2 repositorio(s)");
    expect(r.text).toContain("1 con permiso de escritura");
  });
});
