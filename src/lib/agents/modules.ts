/**
 * Registra todas las herramientas y secciones de prompt de los agentes.
 * Cada módulo nuevo (memoria, archivos…) se importa aquí.
 */
import "./tools";
import "../memory/tools";
import "../routines/tools";
import "../rooms/tools";
import "../claude/tools";
import "../dev/admin";
import "../connections/agents";
import "../files/tools";
import "../decisions/tools";
