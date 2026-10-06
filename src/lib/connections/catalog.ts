/**
 * Categorías del catálogo y conexiones que vendrán (ficha con qué harán y
 * cómo se conectarán de forma segura). Sin dependencias de servidor (las
 * muestra la interfaz).
 */

export interface ServiceCategory {
  key: string;
  label: string;
}

/** Orden en que se muestran en el catálogo. */
export const CATEGORIES: ServiceCategory[] = [
  { key: "tareas", label: "Tareas y proyectos" },
  { key: "notas", label: "Notas y lectura" },
  { key: "agenda", label: "Agenda" },
  { key: "avisos", label: "Avisos y mensajes" },
  { key: "info", label: "Información" },
  { key: "finanzas", label: "Finanzas" },
  { key: "hogar", label: "Hogar, salud y ocio" },
  { key: "dev", label: "Desarrollo y webs" },
  { key: "auto", label: "Automatización" },
  { key: "correo", label: "Correo y archivos" },
  { key: "otros", label: "Otros" },
];

export interface UpcomingService {
  key: string;
  label: string;
  description: string;
  /** Cómo se conectará (credencial, permisos y límites). */
  plan: string;
  category: string;
}

export const UPCOMING_SERVICES: UpcomingService[] = [
  {
    key: "drive",
    label: "Google Drive / Docs / Sheets",
    description: "Buscar y leer tus documentos y hojas de cálculo para resumirlos o sacar datos.",
    plan: "OAuth de Google (el mismo cliente que Calendar) con drive.readonly y spreadsheets.readonly. Sin escritura. Requiere ampliar la autorización de Google.",
    category: "correo",
  },
  {
    key: "google_tasks",
    label: "Google Tasks",
    description: "Tus listas de tareas de Google.",
    plan: "OAuth de Google (mismo cliente que Calendar) con tasks.readonly. Requiere ampliar la autorización de Google.",
    category: "tareas",
  },
  {
    key: "gmail",
    label: "Gmail",
    description: "Leer correos y preparar borradores de respuesta.",
    plan: "OAuth gmail.readonly + gmail.compose: los agentes dejan borradores; enviar, siempre tú.",
    category: "correo",
  },
  {
    key: "outlook",
    label: "Outlook / Microsoft 365",
    description: "Calendario y correo de Microsoft.",
    plan: "OAuth con PKCE (Microsoft Graph), solo lectura.",
    category: "correo",
  },
  {
    key: "imap",
    label: "Correo (IMAP)",
    description: "Cualquier buzón de correo, solo lectura.",
    plan: "Contraseña de aplicación cifrada. Sin envío.",
    category: "correo",
  },
  {
    key: "banco",
    label: "Bancos (CSV / Open Banking)",
    description: "Tus movimientos para presupuesto y ahorro.",
    plan: "Primero importación de CSV desde Archivos; después Open Banking (PSD2) de solo lectura.",
    category: "finanzas",
  },
  {
    key: "whatsapp",
    label: "WhatsApp (avisos)",
    description: "Avisos a tu número de WhatsApp.",
    plan: "WhatsApp Business Cloud API: requiere cuenta de empresa verificada. Mientras, usa Telegram, ntfy o Pushover.",
    category: "avisos",
  },
  {
    key: "spotify",
    label: "Spotify",
    description: "Qué estás escuchando y tus listas.",
    plan: "OAuth con PKCE (scopes user-read-recently-played y playlist-read-private), solo lectura. Necesita registrar una app en developer.spotify.com.",
    category: "hogar",
  },
  {
    key: "strava",
    label: "Strava",
    description: "Tus entrenamientos recientes y estadísticas.",
    plan: "OAuth (scope activity:read) con renovación automática del token cada 6 h. Necesita registrar una app en strava.com/settings/api.",
    category: "hogar",
  },
];
