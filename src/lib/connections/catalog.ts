/**
 * Conexiones que vendrán: ficha con qué harán y cómo se conectarán de forma
 * segura. Sin dependencias de servidor (las muestra la interfaz).
 */

export interface UpcomingService {
  key: string;
  label: string;
  description: string;
  /** Cómo se conectará (credencial, permisos y límites). */
  plan: string;
}

export const UPCOMING_SERVICES: UpcomingService[] = [
  {
    key: "tareas",
    label: "Tareas (Todoist)",
    description: "Ver tus tareas de hoy y crear nuevas desde cualquier agente.",
    plan: "Token personal cifrado. Lectura por defecto; crear o completar tareas solo con permiso completo.",
  },
  {
    key: "drive",
    label: "Google Drive / Docs",
    description: "Buscar y leer tus documentos para resumirlos o sacar datos.",
    plan: "OAuth de Google (el mismo cliente que Calendar) con permiso drive.readonly. Sin escritura.",
  },
  {
    key: "gmail",
    label: "Gmail",
    description: "Leer correos y preparar borradores de respuesta.",
    plan: "OAuth gmail.readonly + gmail.compose: los agentes dejan borradores; enviar, siempre tú.",
  },
  {
    key: "outlook",
    label: "Outlook / Microsoft 365",
    description: "Calendario y correo de Microsoft.",
    plan: "OAuth con PKCE (Microsoft Graph), solo lectura.",
  },
  {
    key: "imap",
    label: "Correo (IMAP)",
    description: "Cualquier buzón de correo, solo lectura.",
    plan: "Contraseña de aplicación cifrada. Sin envío.",
  },
  {
    key: "homeassistant",
    label: "Home Assistant",
    description: "Estado de la casa (temperatura, luces, sensores) y acciones concretas.",
    plan: "Token de larga duración cifrado y lista blanca de acciones permitidas.",
  },
  {
    key: "banco",
    label: "Bancos (CSV / Open Banking)",
    description: "Tus movimientos para presupuesto y ahorro.",
    plan: "Primero importación de CSV desde Archivos; después Open Banking (PSD2) de solo lectura.",
  },
  {
    key: "whatsapp",
    label: "WhatsApp (avisos)",
    description: "Avisos a tu número de WhatsApp.",
    plan: "WhatsApp Business Cloud API: requiere cuenta de empresa verificada. Mientras, usa Telegram.",
  },
  {
    key: "spotify",
    label: "Spotify",
    description: "Qué estás escuchando y tus listas.",
    plan: "OAuth con PKCE, solo lectura.",
  },
];
