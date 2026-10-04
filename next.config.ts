import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // El SDK de Claude lanza un binario nativo: que Next no intente empaquetarlo.
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk"],
  devIndicators: false,
  // El supervisor compila las actualizaciones en otra carpeta y luego la cambia por .next.
  distDir: process.env.ORDEN_DIST_DIR ?? ".next",
  // En la copia de un agente admin la raíz es el proyecto principal (allí está node_modules).
  turbopack: { root: process.env.ORDEN_TURBOPACK_ROOT ?? process.cwd() },
};

export default nextConfig;
