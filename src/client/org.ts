"use client";

import { useCallback, useEffect, useState } from "react";
import { api, onEvent } from "./store";
import type { AutopilotSettings, BudgetVerdict } from "@/lib/org/budget";
import type { AgentRole, BacklogItem, Unit } from "@/lib/org/types";

export interface OrgState {
  units: Unit[];
  roles: AgentRole[];
  backlog: BacklogItem[];
  autopilot: { settings: AutopilotSettings; verdict: BudgetVerdict };
}

const ORG_EVENTS = ["unit.", "role.", "backlog.", "autopilot.", "usage."];

/** Organigrama, carteras abiertas y piloto automático; se refresca con los eventos en directo. */
export function useOrg(): [OrgState | null, () => void] {
  const [org, setOrg] = useState<OrgState | null>(null);
  const load = useCallback(() => {
    api<OrgState>("/api/org")
      .then(setOrg)
      .catch(() => {});
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => onEvent((e) => ORG_EVENTS.some((p) => e.type.startsWith(p)) && load()), [load]);
  return [org, load];
}

export const PRIORITY_LABEL: Record<number, string> = { 1: "Alta", 2: "Media", 3: "Baja" };
export const MODEL_LABEL: Record<string, string> = { haiku: "Haiku", sonnet: "Sonnet", opus: "Opus" };
