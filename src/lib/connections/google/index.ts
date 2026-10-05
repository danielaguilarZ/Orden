import { registerService, type AgentGrant } from "../registry";
import { redact } from "../../secrets";
import { CalendarReader, oauthState, readGoogleSecret, safeCalendarId } from "./api";
import { calendarsOf, SYNC_EVERY_MS, syncGoogleCalendar, WINDOW_FUTURE_DAYS, WINDOW_PAST_DAYS } from "./sync";
import { googleCalendarTools } from "./tools";

export const GOOGLE_CALENDAR = "google_calendar";
const READ_TEXT = "ver los eventos y calendarios y volcarlos a un panel de Orden. Nunca escribe en Google";

registerService({
  key: GOOGLE_CALENDAR,
  label: "Google Calendar",
  description: "Calendarios de Google en solo lectura (OAuth, permiso calendar.readonly). Credenciales y tokens guardados cifrados.",
  levels: { lectura: `Lectura: ${READ_TEXT}.`, completo: "No disponible: este servicio es solo de lectura." },
  fields: [{ key: "calendars", label: "Calendarios (ids separados por comas)", placeholder: "primary" }],
  supportsSecret: false,
  authKind: "oauth",
  readOnly: true,

  normalizeConfig(input) {
    const raw = Array.isArray(input.calendars) ? input.calendars : String(input.calendars ?? "").split(",");
    const calendars = [...new Set(raw.map((x) => String(x).trim()).filter(Boolean).map(safeCalendarId))].slice(0, 10);
    return { calendars: calendars.length ? calendars : ["primary"], panel: input.panel !== false };
  },
  defaultName() {
    return "Google Calendar";
  },
  tools: googleCalendarTools,
  prompt(grants: AgentGrant[]) {
    const c = grants[0].connection;
    const ready = Boolean(readGoogleSecret(c.id)?.refreshToken);
    return `Conexión con Google Calendar (solo lectura, cuenta del usuario${ready ? "" : "; AÚN SIN AUTORIZAR: si falla, avisa de que hay que pulsar «Autorizar con Google» en Conexiones"}):
- Calendarios conectados: ${calendarsOf(c).join(", ")}. Tu permiso: lectura (${READ_TEXT}).
- google_calendario_eventos(desde, hasta) para consultar la agenda; google_calendario_volcar para copiarla al panel de calendario (sin duplicar, por id de Google). Las fechas van en hora local.
- No puedes crear, cambiar ni borrar eventos en Google. Si te lo piden, dilo y, como mucho, apúntalo en un panel de Orden.`;
  },
  async test(c) {
    try {
      const s = readGoogleSecret(c.id);
      if (!s) return { ok: false, text: "Faltan el Client ID y el Client secret de Google Cloud." };
      if (!s.refreshToken) return { ok: false, text: "Credenciales guardadas, pero falta pulsar «Autorizar con Google»." };
      const list = await new CalendarReader(c.id).calendars();
      const ids = new Set(list.map((x) => x.id));
      const missing = calendarsOf(c).filter((id) => id !== "primary" && !ids.has(id));
      return {
        ok: missing.length === 0,
        text: `Acceso de lectura correcto${s.account ? ` como ${s.account}` : ""}: ${list.length} calendario(s) visibles.${missing.length ? ` No encuentro: ${missing.join(", ")}.` : ""}`,
      };
    } catch (err) {
      return { ok: false, text: redact((err as Error).message) };
    }
  },
  sync: syncGoogleCalendar,
  syncEveryMs: SYNC_EVERY_MS,
  oauthState: (c) => oauthState(c.id),
});

export { WINDOW_FUTURE_DAYS, WINDOW_PAST_DAYS };
