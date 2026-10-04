"use client";

import { habitStreak, type HabitsData, type Habit } from "@/lib/panels/types";
import { AddInput, InlineText, isoDate, SERIES_COLORS, useFresh, useMounted, type PanelViewProps } from "./common";

const DOW = ["D", "L", "M", "X", "J", "V", "S"];

function isDone(h: Habit, v: boolean | number | undefined) {
  return typeof v === "number" ? (h.goal ? v >= h.goal : v > 0) : Boolean(v);
}

export function HabitsView({ panel, run, compact }: PanelViewProps<HabitsData>) {
  const mounted = useMounted();
  const fresh = useFresh(panel.data.habits.map((h) => h.id));
  if (!mounted) return <div className="habits skeleton" />;
  const n = compact ? 7 : 14;
  const days = Array.from({ length: n }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (n - 1 - i));
    return d;
  });
  const today = isoDate(new Date());

  return (
    <div className="habits">
      <table>
        <thead>
          <tr>
            <th />
            {days.map((d) => (
              <th key={isoDate(d)} className={isoDate(d) === today ? "today" : ""}>
                <span>{DOW[d.getDay()]}</span>
                {d.getDate()}
              </th>
            ))}
            <th title="Racha actual">Racha</th>
          </tr>
        </thead>
        <tbody>
          {panel.data.habits.map((h, hi) => {
            const color = h.color ?? SERIES_COLORS[hi % SERIES_COLORS.length];
            return (
              <tr key={h.id} className={fresh.has(h.id) ? "fresh" : ""}>
                <th className="habit-name">
                  <InlineText value={h.name} onSave={(name) => run([{ op: "update_habit", id: h.id, name }])} />
                  {h.goal && (
                    <small>
                      meta {h.goal} {h.unit}
                    </small>
                  )}
                </th>
                {days.map((d) => {
                  const key = isoDate(d);
                  const v = h.log[key];
                  const done = isDone(h, v);
                  return (
                    <td key={key}>
                      <button
                        className={`habit-cell ${done ? "on" : typeof v === "number" && v > 0 ? "partial" : ""}`}
                        style={{ "--hc": color } as React.CSSProperties}
                        title={`${key}${typeof v === "number" ? `: ${v} ${h.unit ?? ""}` : ""}`}
                        onClick={() => {
                          if (h.goal) {
                            const raw = prompt(`${h.name} · ${key}: ¿cuánto? (meta ${h.goal} ${h.unit ?? ""})`, typeof v === "number" ? String(v) : "");
                            if (raw === null) return;
                            run([{ op: "log", id: h.id, date: key, value: Number(raw.replace(",", ".")) || 0 }]);
                          } else run([{ op: "log", id: h.id, date: key, value: !done }]);
                        }}
                      >
                        {typeof v === "number" && v > 0 && !done ? v : ""}
                      </button>
                    </td>
                  );
                })}
                <td className="streak">{habitStreak(h, today)}🔥</td>
                {!compact && (
                  <td>
                    <button className="icon-btn small" onClick={() => confirm(`¿Quitar «${h.name}»?`) && run([{ op: "remove_habit", id: h.id }])}>
                      ×
                    </button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {!compact && <AddInput placeholder="+ Hábito" onAdd={(name) => run([{ op: "add_habit", name }])} />}
    </div>
  );
}
