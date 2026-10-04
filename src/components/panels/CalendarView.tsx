"use client";

import { Backdrop } from "../Backdrop";
import { useMemo, useState } from "react";
import type { CalendarData, CalendarEvent } from "@/lib/panels/types";
import { isoDate, parseLocal, useFresh, useMounted, type PanelViewProps } from "./common";

const DAYS = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"];
const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

function startOfWeek(d: Date) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
const time = (s: string) => (s.includes("T") ? s.split("T")[1] : "");
const eventDay = (e: CalendarEvent) => e.start.slice(0, 10);

function sortEvents(list: CalendarEvent[]) {
  return list.slice().sort((a, b) => (a.allDay === b.allDay ? a.start.localeCompare(b.start) : a.allDay ? -1 : 1));
}

function EventEditor({ event, onSave, onDelete, onClose }: { event: Partial<CalendarEvent>; onSave: (e: Partial<CalendarEvent>) => void; onDelete?: () => void; onClose: () => void }) {
  const [title, setTitle] = useState(event.title ?? "");
  const [date, setDate] = useState(event.start?.slice(0, 10) ?? "");
  const [allDay, setAllDay] = useState(event.allDay ?? !event.start?.includes("T"));
  const [start, setStart] = useState(time(event.start ?? "") || "09:00");
  const [end, setEnd] = useState(time(event.end ?? "") || "");
  const [location, setLocation] = useState(event.location ?? "");
  const [notes, setNotes] = useState(event.notes ?? "");
  return (
    <Backdrop onClick={onClose}>
      <form
        className="modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          onSave({
            title,
            allDay,
            start: allDay ? date : `${date}T${start}`,
            end: allDay || !end ? undefined : `${date}T${end}`,
            location: location || undefined,
            notes: notes || undefined,
          });
        }}
      >
        <header className="modal-head">
          <h2>{event.id ? "Editar evento" : "Nuevo evento"}</h2>
          <button type="button" className="icon-btn" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="form-col">
          <label>
            Título
            <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} required />
          </label>
          <div className="row">
            <label>
              Día
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
            </label>
            <label className="check">
              <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} /> Todo el día
            </label>
          </div>
          {!allDay && (
            <div className="row">
              <label>
                Empieza
                <input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
              </label>
              <label>
                Termina
                <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
              </label>
            </div>
          )}
          <label>
            Lugar
            <input value={location} onChange={(e) => setLocation(e.target.value)} />
          </label>
          <label>
            Notas
            <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
        </div>
        <footer className="modal-foot">
          {onDelete && (
            <button type="button" className="btn danger" onClick={onDelete} style={{ marginRight: "auto" }}>
              Borrar
            </button>
          )}
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary">Guardar</button>
        </footer>
      </form>
    </Backdrop>
  );
}

export function CalendarView({ panel, run, compact }: PanelViewProps<CalendarData>) {
  const mounted = useMounted();
  const data = panel.data;
  const [view, setView] = useState<CalendarData["view"] | null>(null);
  const [focus, setFocus] = useState<Date | null>(null);
  const [editing, setEditing] = useState<Partial<CalendarEvent> | null>(null);
  const fresh = useFresh(data.events.map((e) => e.id));
  const currentView = view ?? data.view ?? "semana";

  // La fecha de hoy solo existe en el cliente (evita desajustes de hidratación).
  const today = mounted ? isoDate(new Date()) : "";
  // Sin fecha elegida: hoy, salvo que no haya nada esta semana; entonces el
  // próximo evento (o el último), para no enseñar una semana vacía.
  const autoAnchor = (() => {
    if (!mounted) return null;
    const now = new Date();
    if (!data.events.length) return now;
    const ws = isoDate(startOfWeek(now));
    const we = isoDate(addDays(startOfWeek(now), 6));
    if (data.events.some((e) => eventDay(e) >= ws && eventDay(e) <= we)) return now;
    const sorted = data.events.map(eventDay).sort();
    const next = sorted.find((d) => d >= isoDate(now)) ?? sorted[sorted.length - 1];
    return parseLocal(next);
  })();
  const anchor = focus ?? (data.focus ? parseLocal(data.focus) : autoAnchor);

  const byDay = useMemo(() => {
    const m = new Map<string, CalendarEvent[]>();
    for (const e of data.events) {
      const k = eventDay(e);
      m.set(k, [...(m.get(k) ?? []), e]);
    }
    return m;
  }, [data.events]);

  if (!anchor) return <div className="cal skeleton" />;

  const shift = (dir: number) => {
    const d = new Date(anchor);
    if (currentView === "mes") d.setMonth(d.getMonth() + dir);
    else d.setDate(d.getDate() + 7 * dir);
    setFocus(d);
  };

  const chip = (e: CalendarEvent) => (
    <button key={e.id} className={`cal-event ${fresh.has(e.id) ? "fresh" : ""} ${e.allDay ? "all-day" : ""}`} onClick={() => setEditing(e)} title={e.notes ?? e.title}>
      {!e.allDay && <span className="cal-time">{time(e.start)}</span>}
      <span className="cal-title">{e.title}</span>
      {e.location && !compact && <span className="cal-loc">{e.location}</span>}
    </button>
  );

  let body: React.ReactNode;
  let label = "";
  if (currentView === "mes") {
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const start = startOfWeek(first);
    label = `${MONTHS[anchor.getMonth()]} ${anchor.getFullYear()}`;
    body = (
      <div className="cal-month">
        {DAYS.map((d) => (
          <div key={d} className="cal-dow">
            {d}
          </div>
        ))}
        {Array.from({ length: 42 }, (_, i) => {
          const day = addDays(start, i);
          const key = isoDate(day);
          const evs = sortEvents(byDay.get(key) ?? []);
          return (
            <div key={key} className={`cal-cell ${day.getMonth() !== anchor.getMonth() ? "out" : ""} ${key === today ? "today" : ""}`} onDoubleClick={() => setEditing({ start: key, allDay: true })}>
              <span className="cal-num">{day.getDate()}</span>
              {evs.slice(0, 3).map(chip)}
              {evs.length > 3 && <span className="cal-more">+{evs.length - 3}</span>}
            </div>
          );
        })}
      </div>
    );
  } else if (currentView === "agenda") {
    const days = [...byDay.keys()].filter((k) => k >= (today || "0")).sort();
    label = "Próximos eventos";
    body = (
      <div className="cal-agenda">
        {days.length === 0 && <p className="muted">No hay eventos próximos.</p>}
        {days.map((k) => (
          <div key={k} className="cal-agenda-day">
            <h4>
              {DAYS[(parseLocal(k).getDay() + 6) % 7]} {parseLocal(k).getDate()} de {MONTHS[parseLocal(k).getMonth()]}
            </h4>
            {sortEvents(byDay.get(k)!).map(chip)}
          </div>
        ))}
      </div>
    );
  } else {
    const start = startOfWeek(anchor);
    const end = addDays(start, 6);
    label = `${start.getDate()} ${MONTHS[start.getMonth()].slice(0, 3)} – ${end.getDate()} ${MONTHS[end.getMonth()].slice(0, 3)} ${end.getFullYear()}`;
    body = (
      <div className="cal-week">
        {Array.from({ length: 7 }, (_, i) => {
          const day = addDays(start, i);
          const key = isoDate(day);
          return (
            <div key={key} className={`cal-day ${key === today ? "today" : ""}`}>
              <header>
                <span>{DAYS[i]}</span>
                <strong>{day.getDate()}</strong>
                <button className="cal-add" onClick={() => setEditing({ start: key, allDay: false })} title="Añadir evento">
                  +
                </button>
              </header>
              <div className="cal-day-events">{sortEvents(byDay.get(key) ?? []).map(chip)}</div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className={`cal ${compact ? "compact" : ""}`}>
      <div className="cal-bar">
        <div className="seg">
          {(["semana", "mes", "agenda"] as const).map((v) => (
            <button key={v} className={currentView === v ? "on" : ""} onClick={() => setView(v)}>
              {v}
            </button>
          ))}
        </div>
        {currentView !== "agenda" && (
          <div className="cal-nav">
            <button className="icon-btn" onClick={() => shift(-1)} aria-label="Anterior">
              ‹
            </button>
            <button className="btn ghost small" onClick={() => setFocus(new Date())}>
              Hoy
            </button>
            <button className="icon-btn" onClick={() => shift(1)} aria-label="Siguiente">
              ›
            </button>
          </div>
        )}
        <span className="cal-label">{label}</span>
      </div>
      {body}
      {editing && (
        <EventEditor
          event={editing}
          onClose={() => setEditing(null)}
          onDelete={editing.id ? () => (run([{ op: "remove_event", id: editing.id! }]), setEditing(null)) : undefined}
          onSave={(e) => {
            run([editing.id ? { op: "update_event", id: editing.id, ...e } : { op: "add_event", ...e }]);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}
