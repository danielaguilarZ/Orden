"use client";

import { useState } from "react";
import type { ChartData } from "@/lib/panels/types";
import { SERIES_COLORS, type PanelViewProps } from "./common";

const W = 560;
const H = 260;
const PAD = { l: 48, r: 12, t: 12, b: 34 };

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

const fmt = (v: number, unit?: string) => `${new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2 }).format(v)}${unit ? ` ${unit}` : ""}`;

interface Tip {
  x: number;
  y: number;
  title: string;
  rows: { name: string; value: number; color: string }[];
}

function Tooltip({ tip, unit }: { tip: Tip; unit?: string }) {
  return (
    <div className="chart-tip" style={{ left: `${(tip.x / W) * 100}%`, top: `${(tip.y / H) * 100}%` }}>
      <strong>{tip.title}</strong>
      {tip.rows.map((r) => (
        <span key={r.name}>
          <i style={{ background: r.color }} /> {r.name}: {fmt(r.value, unit)}
        </span>
      ))}
    </div>
  );
}

function Cartesian({ data, setTip }: { data: ChartData; setTip: (t: Tip | null) => void }) {
  const { labels, series, kind } = data;
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values)));
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const y = (v: number) => PAD.t + ih - (Math.max(0, v) / max) * ih;
  const band = iw / Math.max(1, labels.length);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const color = (i: number) => series[i].color ?? SERIES_COLORS[i % SERIES_COLORS.length];
  const tipAt = (li: number, x: number) =>
    setTip({ x, y: PAD.t + 10, title: labels[li], rows: series.map((s, si) => ({ name: s.name, value: s.values[li] ?? 0, color: color(si) })) });

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" onMouseLeave={() => setTip(null)}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} className="grid" />
          <text x={PAD.l - 6} y={y(t) + 4} className="axis" textAnchor="end">
            {fmt(t)}
          </text>
        </g>
      ))}
      {labels.map((l, i) => (
        <text key={i} x={PAD.l + band * (i + 0.5)} y={H - 12} className="axis" textAnchor="middle">
          {l.length > 10 ? l.slice(0, 9) + "…" : l}
        </text>
      ))}
      {kind === "barras" &&
        labels.map((_, li) => {
          const groupW = Math.min(band * 0.75, 28 * series.length + 2 * (series.length - 1));
          const bw = Math.max(2, (groupW - 2 * (series.length - 1)) / Math.max(1, series.length));
          const x0 = PAD.l + band * li + (band - groupW) / 2;
          return series.map((s, si) => {
            const v = s.values[li] ?? 0;
            const top = y(v);
            const h = PAD.t + ih - top;
            const x = x0 + si * (bw + 2);
            const r = Math.min(4, bw / 2, h);
            return (
              <path
                key={`${li}-${si}`}
                d={`M${x},${PAD.t + ih} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${PAD.t + ih} Z`}
                fill={color(si)}
              />
            );
          });
        })}
      {(kind === "lineas" || kind === "area") &&
        series.map((s, si) => {
          const pts = labels.map((_, li) => [PAD.l + band * (li + 0.5), y(s.values[li] ?? 0)] as const);
          const line = pts.map(([px, py], i) => `${i ? "L" : "M"}${px},${py}`).join(" ");
          return (
            <g key={si}>
              {kind === "area" && pts.length > 1 && (
                <path d={`${line} L${pts[pts.length - 1][0]},${PAD.t + ih} L${pts[0][0]},${PAD.t + ih} Z`} fill={color(si)} opacity={0.18} />
              )}
              <path d={line} fill="none" stroke={color(si)} strokeWidth={2} strokeLinejoin="round" />
              {pts.map(([px, py], i) => (
                <circle key={i} cx={px} cy={py} r={4} fill={color(si)} stroke="var(--panel)" strokeWidth={2} />
              ))}
            </g>
          );
        })}
      {/* Zonas de hover más grandes que las marcas */}
      {labels.map((_, li) => (
        <rect key={li} x={PAD.l + band * li} y={PAD.t} width={band} height={ih} fill="transparent" onMouseEnter={() => tipAt(li, PAD.l + band * (li + 0.5))} />
      ))}
      <line x1={PAD.l} x2={W - PAD.r} y1={PAD.t + ih} y2={PAD.t + ih} className="baseline" />
    </svg>
  );
}

function Pie({ data, setTip }: { data: ChartData; setTip: (t: Tip | null) => void }) {
  const values = data.series[0]?.values ?? [];
  const total = values.reduce((a, b) => a + Math.max(0, b), 0) || 1;
  const cx = W / 2;
  const cy = H / 2;
  const R = H / 2 - 14;
  const r0 = R * 0.58;
  let a = -Math.PI / 2;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" onMouseLeave={() => setTip(null)}>
      {values.map((v, i) => {
        const ang = (Math.max(0, v) / total) * Math.PI * 2;
        const a1 = a;
        const a2 = a + ang;
        a = a2;
        const large = ang > Math.PI ? 1 : 0;
        const p = (rad: number, ang2: number) => `${cx + rad * Math.cos(ang2)},${cy + rad * Math.sin(ang2)}`;
        const color = SERIES_COLORS[i % SERIES_COLORS.length];
        const mid = (a1 + a2) / 2;
        return (
          <path
            key={i}
            d={`M${p(R, a1)} A${R},${R} 0 ${large} 1 ${p(R, a2)} L${p(r0, a2)} A${r0},${r0} 0 ${large} 0 ${p(r0, a1)} Z`}
            fill={color}
            stroke="var(--panel)"
            strokeWidth={2}
            onMouseEnter={() =>
              setTip({
                x: cx + R * 0.8 * Math.cos(mid),
                y: cy + R * 0.8 * Math.sin(mid),
                title: data.labels[i] ?? "",
                rows: [{ name: `${Math.round((v / total) * 100)} %`, value: v, color }],
              })
            }
          />
        );
      })}
      <text x={cx} y={cy + 6} textAnchor="middle" className="pie-total">
        {fmt(total, data.unit)}
      </text>
    </svg>
  );
}

function DataEditor({ data, onSave, onClose }: { data: ChartData; onSave: (d: Partial<ChartData>) => void; onClose: () => void }) {
  const [labels, setLabels] = useState(data.labels);
  const [series, setSeries] = useState(data.series.length ? data.series : [{ name: "Serie 1", values: [] }]);
  const setVal = (si: number, li: number, v: string) =>
    setSeries((s) => s.map((x, i) => (i === si ? { ...x, values: labels.map((_, j) => (j === li ? Number(v.replace(",", ".")) || 0 : x.values[j] ?? 0)) } : x)));
  return (
    <div className="chart-editor">
      <table>
        <thead>
          <tr>
            <th>Etiqueta</th>
            {series.map((s, si) => (
              <th key={si}>
                <input value={s.name} onChange={(e) => setSeries((all) => all.map((x, i) => (i === si ? { ...x, name: e.target.value } : x)))} />
              </th>
            ))}
            <th>
              <button className="btn ghost small" onClick={() => setSeries((s) => [...s, { name: `Serie ${s.length + 1}`, values: labels.map(() => 0) }])}>
                + Serie
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          {labels.map((l, li) => (
            <tr key={li}>
              <td>
                <input value={l} onChange={(e) => setLabels((all) => all.map((x, i) => (i === li ? e.target.value : x)))} />
              </td>
              {series.map((s, si) => (
                <td key={si}>
                  <input inputMode="decimal" defaultValue={s.values[li] ?? 0} onChange={(e) => setVal(si, li, e.target.value)} />
                </td>
              ))}
              <td>
                <button
                  className="icon-btn small"
                  onClick={() => {
                    setLabels((all) => all.filter((_, i) => i !== li));
                    setSeries((all) => all.map((x) => ({ ...x, values: x.values.filter((_, i) => i !== li) })));
                  }}
                >
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <button className="btn ghost small" onClick={() => setLabels((l) => [...l, `Punto ${l.length + 1}`])}>
          + Punto
        </button>
        <span style={{ flex: 1 }} />
        <button className="btn ghost small" onClick={onClose}>
          Cancelar
        </button>
        <button className="btn primary small" onClick={() => onSave({ labels, series: series.map((s) => ({ ...s, values: labels.map((_, i) => s.values[i] ?? 0) })) })}>
          Guardar
        </button>
      </div>
    </div>
  );
}

export function ChartView({ panel, run, compact }: PanelViewProps<ChartData>) {
  const data = panel.data;
  const [tip, setTip] = useState<Tip | null>(null);
  const [editing, setEditing] = useState(false);
  const empty = !data.labels.length || !data.series.length;

  return (
    <div className="pchart">
      {!compact && (
        <div className="row">
          <div className="seg">
            {(["barras", "lineas", "area", "tarta"] as const).map((k) => (
              <button key={k} className={data.kind === k ? "on" : ""} onClick={() => run([{ op: "set_chart", kind: k }])}>
                {k === "lineas" ? "líneas" : k === "area" ? "área" : k}
              </button>
            ))}
          </div>
          <span style={{ flex: 1 }} />
          <button className="btn ghost small" onClick={() => setEditing((e) => !e)}>
            {editing ? "Ver gráfico" : "Editar datos"}
          </button>
        </div>
      )}
      {editing ? (
        <DataEditor
          data={data}
          onClose={() => setEditing(false)}
          onSave={(d) => {
            run([{ op: "set_chart", ...d }]);
            setEditing(false);
          }}
        />
      ) : empty ? (
        <p className="muted">Sin datos todavía.</p>
      ) : (
        <div className="chart-wrap">
          {data.kind === "tarta" ? <Pie data={data} setTip={setTip} /> : <Cartesian data={data} setTip={setTip} />}
          {tip && <Tooltip tip={tip} unit={data.unit} />}
          {(data.series.length > 1 || data.kind === "tarta") && (
            <ul className="chart-legend">
              {(data.kind === "tarta" ? data.labels.map((l, i) => ({ name: l, color: SERIES_COLORS[i % SERIES_COLORS.length] })) : data.series.map((s, i) => ({ name: s.name, color: s.color ?? SERIES_COLORS[i % SERIES_COLORS.length] }))).map((s) => (
                <li key={s.name}>
                  <i style={{ background: s.color }} />
                  {s.name}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
