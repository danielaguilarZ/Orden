/**
 * Punto de entrada del worker. Carga .env antes que nada y luego arranca.
 *
 * Nota: en desarrollo se usa `node --watch --import tsx` y no `tsx watch`,
 * porque con `tsx watch` bajo `concurrently` la carga del SDK se queda colgada.
 */
import { loadEnv } from "../src/lib/env";
loadEnv();
await import("./main");
