import { useEffect, useState } from "react";

// useState that survives component unmount (tab/route changes) AND page reload by
// backing the value with localStorage. Use for durable UI state (layer toggles,
// selections, filters) — NOT for transient/in-flight operation state.
//
// Governance: persistence is a first-class requirement — see
// docs/architecture/ux-persistence-rule_VantosEdge_2026-06-17.md.
export function usePersistentState<T>(key: string, initial: T) {
  const fullKey = `vantos.ws.${key}`;
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(fullKey);
      return raw != null ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(fullKey, JSON.stringify(value));
    } catch {
      /* ignore quota / serialization errors */
    }
  }, [fullKey, value]);
  return [value, setValue] as const;
}
