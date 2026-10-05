import { redirect } from "next/navigation";

/** La antigua pestaña «Propuestas» / «Acción humana» ahora es «Decisiones». */
export default function PropuestasPage() {
  redirect("/decisiones");
}
