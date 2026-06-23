import { useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import PageShell, { Placeholder } from "../components/PageShell";
import { usePersistentState } from "../lib/persist";
import {
  getRegions, getRegionDossier, saveDossierSnapshot, getDossierSnapshots, deleteDossierSnapshot,
  type DossierSection, type DossierStatus, type DossierConfidence,
} from "../lib/api";

const WINDOWS = [1, 7, 14, 30];

const STATUS_STYLE: Record<DossierStatus, { label: string; cls: string }> = {
  ok: { label: "data", cls: "bg-emerald-500/15 text-emerald-300" },
  stale: { label: "stale", cls: "bg-amber-500/15 text-amber-300" },
  no_data: { label: "no data", cls: "bg-white/10 text-gray-400" },
  not_enabled: { label: "not enabled", cls: "bg-white/5 text-gray-500" },
  error: { label: "error", cls: "bg-red-500/15 text-red-300" },
};
function confidenceStyle(c: DossierConfidence): string {
  switch (c) {
    case "high": return "bg-emerald-500/15 text-emerald-300";
    case "medium": return "bg-amber-500/15 text-amber-300";
    case "low": return "bg-orange-500/15 text-orange-300";
    case "indeterminate": return "bg-white/10 text-gray-400";
    default: return "hidden";
  }
}
function severityDot(sev?: string): string {
  return sev === "high" ? "bg-red-400" : sev === "medium" ? "bg-amber-400" : "bg-gray-400";
}

function SectionCard({ s }: { s: DossierSection }) {
  const st = STATUS_STYLE[s.status];
  const summaryEntries = Object.entries(s.summary ?? {});
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{s.title}</h3>
        <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${st.cls}`}>{st.label}</span>
        {s.confidence && (
          <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${confidenceStyle(s.confidence)}`}>
            {s.confidence}
          </span>
        )}
      </div>
      <p className="mt-1 text-[11px] text-gray-500">
        {s.provenance.sources.join(", ")}
        {s.provenance.asOf ? ` · as of ${new Date(s.provenance.asOf).toLocaleString()}` : ""}
      </p>

      {summaryEntries.length > 0 && (
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
          {summaryEntries.map(([k, v]) => (
            <div key={k} className="flex flex-col">
              <dt className="text-gray-500">{k}</dt>
              <dd className="truncate text-gray-200" title={String(v)}>{String(v)}</dd>
            </div>
          ))}
        </dl>
      )}

      {s.items.length > 0 && (
        <ul className="mt-3 divide-y divide-white/5 text-xs">
          {s.items.map((it, i) => (
            <li key={i} className="flex items-start gap-2 py-1.5">
              <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${severityDot(it.severity)}`} />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-gray-200">{it.link ? <a className="underline hover:text-sky-300" href={it.link} target="_blank" rel="noreferrer">{it.title}</a> : it.title}</span>
                  {it.confidence && <span className={`rounded px-1 text-[9px] uppercase ${confidenceStyle(it.confidence)}`}>{it.confidence}</span>}
                </div>
                {it.detail && <div className="text-gray-500">{it.detail}</div>}
                <div className="text-[10px] text-gray-600">
                  {it.source}{it.occurredAt ? ` · ${new Date(it.occurredAt).toLocaleString()}` : ""}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {s.status === "ok" && s.items.length === 0 && summaryEntries.length === 0 && (
        <p className="mt-3 text-xs text-gray-500">No notable items.</p>
      )}
      {(s.status === "no_data" || s.status === "not_enabled") && (
        <Placeholder>{s.disclaimer ?? "No data."}</Placeholder>
      )}
      {s.disclaimer && s.status !== "no_data" && s.status !== "not_enabled" && (
        <p className="mt-3 text-[10px] italic text-gray-600">{s.disclaimer}</p>
      )}
    </div>
  );
}

export default function RegionDossierPage() {
  const { regionId: paramId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [windowDays, setWindowDays] = usePersistentState<number>("dossierWindow", 7);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  const regionsQ = useQuery({ queryKey: ["regions"], queryFn: getRegions });
  const coverageRegions = useMemo(
    () => (regionsQ.data?.regions ?? []).filter((r) => r.kind === "coverage").sort((a, b) => a.name.localeCompare(b.name)),
    [regionsQ.data]
  );
  const regionId = paramId ?? "";

  const dossierQ = useQuery({
    queryKey: ["dossier", regionId, windowDays],
    queryFn: () => getRegionDossier(regionId, windowDays),
    enabled: !!regionId,
  });
  const snapsQ = useQuery({
    queryKey: ["dossierSnaps", regionId],
    queryFn: () => getDossierSnapshots(regionId),
    enabled: !!regionId,
  });

  const dossier = dossierQ.data?.dossier;

  function exportJson() {
    if (!dossier) return;
    const blob = new Blob([JSON.stringify(dossier, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `dossier_${dossier.regionName.replace(/\s+/g, "-")}_${windowDays}d.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  async function snapshot() {
    if (!regionId) return;
    const label = window.prompt("Snapshot label", `${dossier?.regionName ?? "Region"} — ${new Date().toLocaleDateString()}`);
    if (!label) return;
    try {
      await saveDossierSnapshot(regionId, label, windowDays);
      setSavedMsg("Snapshot saved.");
      qc.invalidateQueries({ queryKey: ["dossierSnaps", regionId] });
      setTimeout(() => setSavedMsg(null), 2500);
    } catch (e) {
      setSavedMsg(`Save failed: ${(e as Error).message}`);
    }
  }
  async function removeSnap(id: string) {
    await deleteDossierSnapshot(id).catch(() => {});
    qc.invalidateQueries({ queryKey: ["dossierSnaps", regionId] });
  }

  return (
    <PageShell title="Region Dossier" subtitle="Per-region intelligence across all domains, with confidence, provenance, and explicit no-data states.">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-xs text-gray-400">
          Region
          <select
            value={regionId}
            onChange={(e) => navigate(e.target.value ? `/dossier/${e.target.value}` : "/dossier")}
            className="mt-1 rounded border border-white/10 bg-black/40 px-2 py-1 text-sm text-gray-200"
          >
            <option value="">Select a region…</option>
            {coverageRegions.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-xs text-gray-400">
          Window
          <select
            value={windowDays}
            onChange={(e) => setWindowDays(Number(e.target.value))}
            className="mt-1 rounded border border-white/10 bg-black/40 px-2 py-1 text-sm text-gray-200"
          >
            {WINDOWS.map((d) => <option key={d} value={d}>{d} day{d > 1 ? "s" : ""}</option>)}
          </select>
        </label>
        {regionId && (
          <div className="flex items-center gap-2">
            <button onClick={snapshot} className="rounded border border-white/10 px-2.5 py-1.5 text-xs hover:bg-white/10">Save snapshot</button>
            <button onClick={exportJson} disabled={!dossier} className="rounded border border-white/10 px-2.5 py-1.5 text-xs hover:bg-white/10 disabled:opacity-40">Export JSON</button>
          </div>
        )}
        {savedMsg && <span className="text-xs text-emerald-300">{savedMsg}</span>}
      </div>

      {!regionId && <div className="mt-6"><Placeholder>Select a region to view its dossier.</Placeholder></div>}

      {regionId && dossierQ.isLoading && <p className="mt-6 text-sm text-gray-400">Building dossier…</p>}
      {regionId && dossierQ.data?.status === "error" && (
        <p className="mt-6 text-sm text-red-300">Error: {dossierQ.data.error}</p>
      )}

      {dossier && (
        <>
          <p className="mt-5 text-xs text-gray-500">
            {dossier.regionName} · generated {new Date(dossier.generatedAt).toLocaleString()} · {dossier.windowDays}-day window
          </p>
          <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
            {dossier.sections.map((s) => <SectionCard key={s.key} s={s} />)}
          </div>
        </>
      )}

      {regionId && (snapsQ.data?.snapshots?.length ?? 0) > 0 && (
        <div className="mt-8">
          <h2 className="text-sm font-semibold">Saved snapshots</h2>
          <ul className="mt-2 divide-y divide-white/5 text-xs">
            {snapsQ.data!.snapshots.map((s) => (
              <li key={s.id} className="flex items-center justify-between py-1.5">
                <span className="text-gray-300">{s.label} <span className="text-gray-600">· {s.windowDays}d · {new Date(s.createdAt).toLocaleString()}</span></span>
                <button onClick={() => removeSnap(s.id)} className="text-gray-500 hover:text-red-300">remove</button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </PageShell>
  );
}
