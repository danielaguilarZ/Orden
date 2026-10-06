import { redirect } from "next/navigation";

/** Archivos ya es una sección propia: la dirección antigua lleva allí. */
export default function PanelesArchivosPage() {
  redirect("/archivos");
}
