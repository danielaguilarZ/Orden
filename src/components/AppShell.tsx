"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { connect, hydrate, refreshClaude, useStore } from "@/client/store";
import type { Snapshot } from "@/lib/server";
import { TAB_LABEL } from "@/lib/decisions/labels";
import { ConnectClaudeDialog } from "./ConnectClaudeDialog";

const NAV = [
  { key: "living", href: "/", label: "Living" },
  { key: "archivos", href: "/archivos", label: "Archivos" },
  { key: "memoria", href: "/memoria", label: "Memoria" },
  { key: "actividad", href: "/actividad", label: "Actividad" },
  { key: "conexiones", href: "/conexiones", label: "Conexiones" },
  // «Decisiones» (antes «Propuestas» / «Acción humana»; /propuestas redirige aquí).
  { key: "decisiones", href: "/decisiones", label: TAB_LABEL },
];

export function AppShell({ initial, active, children }: { initial: Snapshot; active: string; children: React.ReactNode }) {
  const hydrated = useRef(false);
  if (!hydrated.current) {
    hydrate(initial);
    hydrated.current = true;
  }
  useEffect(() => {
    connect();
    refreshClaude();
    const t = setInterval(() => refreshClaude(), 60_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="shell">
      <header className="topbar">
        <Link href="/" className="brand">
          <span className="brand-mark" aria-hidden />
          Orden
        </Link>
        <nav className="nav">
          {NAV.map((n) => (
            <Link key={n.key} href={n.href} className={n.key === active ? "active" : ""}>
              {n.label}
              {n.key === "decisiones" && <PendingBadge />}
            </Link>
          ))}
        </nav>
        <div className="pills">
          <WorkerPill />
          <ClaudePill />
        </div>
      </header>
      <RestartBanner />
      <main className="main">{children}</main>
    </div>
  );
}

/** Número de decisiones pendientes junto a la pestaña. */
function PendingBadge() {
  const n = useStore((s) => s.decisionsPending);
  if (!n) return null;
  return (
    <span className="nav-badge" title={`${n} decisi${n === 1 ? "ón pendiente" : "ones pendientes"}`}>
      {n}
    </span>
  );
}

function WorkerPill() {
  const worker = useStore((s) => s.worker);
  const live = useStore((s) => s.live);
  // Evita diferencias servidor/cliente: el «ahora» solo se evalúa tras montar.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const alive = mounted && Boolean(worker?.alive);
  const title = !mounted
    ? "Comprobando…"
    : alive
      ? `Último latido: ${new Date(worker!.at).toLocaleTimeString("es-ES")}`
      : worker
        ? `Sin latido desde ${new Date(worker.at).toLocaleTimeString("es-ES")}. Arranca con npm run dev.`
        : "El worker no ha arrancado nunca. Arranca con npm run dev.";
  return (
    <span className={`pill ${!mounted ? "" : alive ? "ok" : "bad"}`} title={title}>
      <span className="dot" />
      <span className="pill-label">Worker {!mounted ? "…" : alive ? "activo" : "parado"}</span>
      {mounted && !live && <span className="pill-note">· sin tiempo real</span>}
    </span>
  );
}

function ClaudePill() {
  const claude = useStore((s) => s.claude);
  const [open, setOpen] = useState(false);
  const label = !claude
    ? "Claude…"
    : claude.connected
      ? `Claude conectado${claude.plan ? ` · ${claude.plan.toUpperCase()}` : ""}`
      : "Claude desconectado";
  return (
    <>
      <button
        className={`pill ${!claude ? "" : claude.connected ? "ok" : "bad"}`}
        title={claude?.email ? `${claude.email} · modo ${claude.mode}` : (claude?.error ?? "")}
        onClick={() => setOpen(true)}
      >
        <span className="dot" />
        <span className="pill-label">{label}</span>
        {claude && !claude.connected && <span className="pill-cta">Conectar</span>}
      </button>
      {open && <ConnectClaudeDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function RestartBanner() {
  const restarting = useStore((s) => s.restarting);
  if (!restarting) return null;
  return (
    <div className="restart-banner">
      <span className="spinner" /> Orden se está actualizando ({restarting}). La página se recargará sola en cuanto esté lista.
    </div>
  );
}
