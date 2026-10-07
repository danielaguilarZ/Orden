import type { Metadata } from "next";
import { Inter, Pixelify_Sans } from "next/font/google";
import "./globals.css";
import "./team.css";
import "./base.css";
import "./memory.css";
import "./routines.css";
import "./connections.css";
import "./files.css";
import "./decisions.css";
import "./ui-kit.css";
import "./org.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-body" });
const pixel = Pixelify_Sans({ subsets: ["latin"], variable: "--font-pixel" });

export const metadata: Metadata = {
  title: "Orden",
  description: "Tu asistente personal: un equipo de agentes que viven en un living isométrico.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={`${inter.variable} ${pixel.variable}`}>
      <body>{children}</body>
    </html>
  );
}
