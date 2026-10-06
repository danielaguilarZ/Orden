"use client";

import { useEffect, useRef, useState } from "react";

/** true tras montar en el cliente (evita diferencias servidor/cliente con fechas y «ahora»). */
export function useMounted() {
  const [m, setM] = useState(false);
  useEffect(() => setM(true), []);
  return m;
}

/** Ids que han aparecido después de montar (para resaltarlos al llegar). */
export function useFresh(ids: string[]): Set<string> {
  const known = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const key = ids.join("|");
  useEffect(() => {
    if (!known.current) {
      known.current = new Set(ids);
      return;
    }
    const added = ids.filter((id) => !known.current!.has(id));
    ids.forEach((id) => known.current!.add(id));
    if (!added.length) return;
    setFresh((f) => new Set([...f, ...added]));
    const t = setTimeout(() => setFresh((f) => new Set([...f].filter((id) => !added.includes(id)))), 1600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return fresh;
}
