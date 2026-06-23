import { Fragment, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import PageShell, { Placeholder } from "../components/PageShell";
import {
  getMonitorGroups, createMonitorGroup, updateMonitorGroup, deleteMonitorGroup,
  getMonitoredVessels, updateMonitoredVessel, removeMonitoredVessel,
  addMonitoredVessel, searchRegistryVessels, enrichRegistry, bulkRemoveRegistry,
  setVesselMonitor, setGroupMonitor, enrichVessel,
  type VesselMatch, type MonitoredVessel,
} from "../lib/api";

type Scope = { kind: "all" } | { kind: "unassigned" } | { kind: "group"; id: string; name: string };

const MONITOR_OPTIONS = [
  { v: 0, l: "Off" }, { v: 60, l: "1h" }, { v: 180, l: "3h" },
  { v: 360, l: "6h" }, { v: 720, l: "12h" }, { v: 1440, l: "24h" },
];
function cadenceLabel(m: number): string { return MONITOR_OPTIONS.find((o) => o.v === m)?.l ?? "Off"; }

// Inline enriched detail ("all rows returned once enriched") — fetched on expand.
function EnrichedDetail({ mmsi }: { mmsi: string }) {
  const q = useQuery({ queryKey: ["enrich", mmsi], queryFn: () => enrichVessel(mmsi) });
  if (q.isLoading) return <div className="p-2 text-[11px] text-gray-500">Loading enrichment…</div>;
  if (q.data?.status !== "ok") return <div className="p-2 text-[11px] text-amber-400">No enrichment: {q.data?.error ?? "unavailable"}</div>;
  const e = q.data;
  const curated = Object.entries(e.curated ?? {}).filter(([, v]) => v !== null && v !== "");
  return (
    <div className="space-y-2 bg-black/20 p-3 text-[11px]">
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 sm:grid-cols-3">
        {curated.map(([k, v]) => (
          <div key={k} className="flex flex-col"><span className="text-gray-500">{k}</span><span className="truncate text-gray-200" title={String(v)}>{String(v)}</span></div>
        ))}
      </div>
      <div className="flex flex-wrap gap-3 border-t border-white/10 pt-1.5 text-gray-400">
        <span>MoU records: <span className="text-gray-200">{e.mou?.records?.length ?? 0}</span></span>
        <span>Port calls: <span className="text-gray-200">{e.portCalls?.records?.length ?? 0}</span></span>
        <span>Ban status: <span className={e.banStatus?.listed ? "text-red-300" : "text-gray-200"}>{e.banStatus?.listed === true ? "LISTED" : e.banStatus?.listed === false ? "not listed" : "—"}</span></span>
        {e.cachedAt && <span className="text-gray-600">enriched {new Date(e.cachedAt).toLocaleString()}</span>}
      </div>
      <p className="text-[10px] italic text-gray-600">Single-source (Data Docked). Ban status is one list — corroborate before acting.</p>
    </div>
  );
}

function asIdentifier(raw: string): { mmsi?: string; imo?: string } {
  const d = raw.replace(/\D/g, "");
  if (d.length === 7) return { imo: d };
  return { mmsi: d || raw };
}

export default function RegistryPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [scope, setScope] = useState<Scope>({ kind: "all" });
  const [newGroup, setNewGroup] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // Add form
  const [addMode, setAddMode] = useState<"id" | "name">("id");
  const [addInput, setAddInput] = useState("");
  const [matches, setMatches] = useState<VesselMatch[] | null>(null);
  const [adding, setAdding] = useState(false);
  // Selection + expansion
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);

  const groups = useQuery({ queryKey: ["monitor-groups"], queryFn: getMonitorGroups });
  const vessels = useQuery({
    queryKey: ["monitored-vessels", scope],
    queryFn: () =>
      getMonitoredVessels(scope.kind === "group" ? { groupId: scope.id } : scope.kind === "unassigned" ? { unassigned: true } : undefined),
  });

  const groupList = groups.data?.groups ?? [];
  const vesselList = vessels.data?.vessels ?? [];

  function refresh() {
    qc.invalidateQueries({ queryKey: ["monitor-groups"] });
    qc.invalidateQueries({ queryKey: ["monitored-vessels"] });
  }
  async function run(fn: () => Promise<unknown>) {
    setErr(null);
    try { await fn(); refresh(); } catch (e) { setErr((e as Error).message); }
  }
  function flash(m: string) { setMsg(m); setTimeout(() => setMsg(null), 4000); }

  async function addGroup() {
    const name = newGroup.trim();
    if (!name) return;
    const res = await createMonitorGroup({ name });
    if (res.status !== "ok") { setErr(res.error ?? "could not create group"); return; }
    setNewGroup(""); qc.invalidateQueries({ queryKey: ["monitor-groups"] });
  }

  const targetGroupId = scope.kind === "group" ? scope.id : undefined;

  async function addById() {
    const raw = addInput.trim();
    if (!raw) return;
    setAdding(true); setErr(null);
    try {
      const res = await addMonitoredVessel({ ...asIdentifier(raw), groupId: targetGroupId ?? null, enrich: true });
      if (res.status !== "ok") setErr(res.error ?? "could not add");
      else { setAddInput(""); flash(`Added ${res.vessel?.name || res.vessel?.mmsi || raw}${res.enriched ? " · enriched" : " · enrich pending"}`); refresh(); }
    } finally { setAdding(false); }
  }
  async function searchByName() {
    const raw = addInput.trim();
    if (raw.length < 2) return;
    setErr(null);
    try { const res = await searchRegistryVessels(raw); setMatches(res.matches ?? []); }
    catch (e) { setErr((e as Error).message); }
  }
  async function addMatch(m: VesselMatch) {
    setAdding(true);
    try {
      const res = await addMonitoredVessel({ mmsi: m.mmsi, imo: m.imo, name: m.name, vesselType: m.type, flag: m.flag, groupId: targetGroupId ?? null, enrich: true });
      if (res.status === "ok") { flash(`Added ${m.name || m.mmsi}${res.enriched ? " · enriched" : ""}`); refresh(); }
      else setErr(res.error ?? "could not add");
    } finally { setAdding(false); }
  }

  function toggleSel(id: string) {
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  const selCount = selected.size;

  async function enrichSelected() {
    if (!selCount) return;
    if (!confirm(`Enrich ${selCount} selected vessel(s)? That is ~${selCount} Data Docked API call(s).`)) return;
    const res = await enrichRegistry({ ids: [...selected] });
    flash(res.note ?? `Enriching ${res.count ?? selCount}…`);
    setSelected(new Set());
  }
  async function enrichGroup() {
    if (scope.kind !== "group") return;
    const n = vesselList.length;
    if (!confirm(`Enrich the whole "${scope.name}" fleet (${n} vessel(s))? That is ~${n} Data Docked API call(s).`)) return;
    const res = await enrichRegistry({ groupId: scope.id });
    flash(res.note ?? `Enriching ${res.count ?? n}…`);
  }
  async function removeSelected() {
    if (!selCount) return;
    if (!confirm(`Remove ${selCount} selected vessel(s) from the registry?`)) return;
    await run(() => bulkRemoveRegistry({ ids: [...selected] }));
    setSelected(new Set());
  }
  async function removeGroupVessels() {
    if (scope.kind !== "group") return;
    if (!confirm(`Remove ALL ${vesselList.length} vessel(s) in "${scope.name}" from the registry? (The group stays.)`)) return;
    await run(() => bulkRemoveRegistry({ groupId: scope.id }));
    setSelected(new Set());
  }
  async function monitorGroup(minutes: number) {
    if (scope.kind !== "group") return;
    await run(() => setGroupMonitor(scope.id, minutes));
    flash(`Group monitor set to ${cadenceLabel(minutes)}`);
  }

  function showOnMap(mmsi: string | null, lat: number | null, lon: number | null) {
    navigate("/", { state: { flyMmsi: mmsi ?? undefined, flyLat: lat ?? undefined, flyLon: lon ?? undefined } });
  }

  const scopeLabel = scope.kind === "all" ? "All monitored vessels" : scope.kind === "unassigned" ? "Unassigned" : scope.name;

  return (
    <PageShell title="Vessel Registry" subtitle="A curated watchlist. Add vessels by MMSI/IMO or name (auto-enriched on add), organise into fleets, and monitor on a cadence.">
      {err && <div className="mb-3 rounded border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-300">{err}</div>}
      {msg && <div className="mb-3 rounded border border-emerald-500/30 bg-emerald-500/10 p-2 text-xs text-emerald-300">{msg}</div>}

      {/* Add vessel */}
      <div className="mb-4 rounded-lg border border-white/10 bg-black/30 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded ring-1 ring-white/10">
            <button onClick={() => { setAddMode("id"); setMatches(null); }} className={`px-2 py-1 text-xs ${addMode === "id" ? "bg-sky-500/20 text-sky-300" : "text-gray-400"}`}>MMSI / IMO</button>
            <button onClick={() => { setAddMode("name"); setMatches(null); }} className={`px-2 py-1 text-xs ${addMode === "name" ? "bg-sky-500/20 text-sky-300" : "text-gray-400"}`}>Name</button>
          </div>
          <input
            value={addInput} onChange={(e) => setAddInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") (addMode === "id" ? addById() : searchByName()); }}
            placeholder={addMode === "id" ? "MMSI (9 digits) or IMO (7 digits)" : "Vessel name…"}
            className="min-w-0 flex-1 rounded bg-black/30 px-2 py-1 text-sm ring-1 ring-white/10 placeholder:text-gray-600"
          />
          <button onClick={() => (addMode === "id" ? addById() : searchByName())} disabled={adding}
            className="rounded bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
            {adding ? "…" : addMode === "id" ? "Add + enrich" : "Search"}
          </button>
          {targetGroupId && <span className="text-[10px] text-gray-500">→ adds to "{scope.kind === "group" ? scope.name : ""}"</span>}
        </div>
        {addMode === "name" && matches !== null && (
          <div className="mt-2 max-h-44 overflow-auto rounded border border-white/10">
            {matches.length === 0 ? (
              <p className="p-2 text-[11px] text-gray-500">No collected vessels match. (Name search covers vessels we've already collected; otherwise add by MMSI/IMO.)</p>
            ) : matches.map((m, i) => (
              <div key={(m.mmsi ?? "") + i} className="flex items-center justify-between gap-2 border-b border-white/5 px-2 py-1 text-[11px] last:border-0">
                <span className="min-w-0 truncate text-gray-200">{m.name || "—"} <span className="text-gray-500">· {m.mmsi || m.imo} · {m.type || "?"} · {m.flag || "?"}</span></span>
                <button onClick={() => addMatch(m)} disabled={adding} className="shrink-0 rounded bg-emerald-600 px-2 py-0.5 text-[10px] text-white hover:bg-emerald-500 disabled:opacity-50">Add + enrich</button>
              </div>
            ))}
          </div>
        )}
        <p className="mt-1 text-[10px] text-gray-600">Adding a single vessel auto-enriches it (1 API call). Fleet/ban-list adds do not auto-enrich — enrich them explicitly below.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-[16rem_1fr]">
        {/* Group sidebar */}
        <section className="rounded-lg border border-white/10 bg-black/30 p-3">
          <h2 className="mb-2 text-sm font-medium text-gray-200">Groups</h2>
          <ul className="space-y-0.5 text-sm">
            <li><button onClick={() => setScope({ kind: "all" })} className={`w-full rounded px-2 py-1 text-left ${scope.kind === "all" ? "bg-sky-500/20 text-sky-300" : "text-gray-300 hover:bg-white/10"}`}>All vessels</button></li>
            <li><button onClick={() => setScope({ kind: "unassigned" })} className={`w-full rounded px-2 py-1 text-left ${scope.kind === "unassigned" ? "bg-sky-500/20 text-sky-300" : "text-gray-300 hover:bg-white/10"}`}>Unassigned</button></li>
            <li className="my-1 border-t border-white/10" />
            {groupList.map((g) => (
              <li key={g.id}>
                {renaming === g.id ? (
                  <div className="flex gap-1 p-1">
                    <input value={renameVal} onChange={(e) => setRenameVal(e.target.value)} autoFocus className="min-w-0 flex-1 rounded bg-black/30 px-1.5 py-0.5 text-xs ring-1 ring-white/10" />
                    <button onClick={() => run(() => updateMonitorGroup(g.id, { name: renameVal.trim() })).then(() => setRenaming(null))} className="rounded bg-sky-600 px-1.5 text-xs text-white">Save</button>
                    <button onClick={() => setRenaming(null)} className="rounded border border-white/10 px-1.5 text-xs">✕</button>
                  </div>
                ) : (
                  <div className={`group flex items-center rounded ${scope.kind === "group" && scope.id === g.id ? "bg-sky-500/20" : "hover:bg-white/10"}`}>
                    <button onClick={() => setScope({ kind: "group", id: g.id, name: g.name })} className={`min-w-0 flex-1 truncate px-2 py-1 text-left ${scope.kind === "group" && scope.id === g.id ? "text-sky-300" : "text-gray-300"}`}>
                      {g.name} <span className="text-gray-500">{g.vesselCount}</span>
                    </button>
                    <button onClick={() => { setRenaming(g.id); setRenameVal(g.name); }} title="Rename" className="px-1 text-xs text-gray-500 opacity-0 group-hover:opacity-100 hover:text-gray-200">✎</button>
                    <button onClick={() => { if (confirm(`Delete group "${g.name}"? Its vessels become Unassigned.`)) run(() => deleteMonitorGroup(g.id)); }} title="Delete group" className="px-1 pr-2 text-xs text-gray-500 opacity-0 group-hover:opacity-100 hover:text-red-300">🗑</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <div className="mt-3 flex gap-1">
            <input value={newGroup} onChange={(e) => setNewGroup(e.target.value)} placeholder="New group" onKeyDown={(e) => { if (e.key === "Enter") addGroup(); }} className="min-w-0 flex-1 rounded bg-black/30 px-2 py-1 text-xs ring-1 ring-white/10 placeholder:text-gray-600" />
            <button onClick={addGroup} className="rounded bg-emerald-600 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-500">Add</button>
          </div>
        </section>

        {/* Vessel table */}
        <section className="rounded-lg border border-white/10 bg-black/30 p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-medium text-gray-200">{scopeLabel} <span className="text-gray-500">· {vesselList.length}</span></h2>
            <div className="flex flex-wrap items-center gap-1.5">
              {scope.kind === "group" && (
                <>
                  <label className="flex items-center gap-1 text-[11px] text-gray-400">Monitor fleet
                    <select defaultValue="" onChange={(e) => { if (e.target.value !== "") monitorGroup(Number(e.target.value)); }} className="rounded bg-black/30 px-1.5 py-0.5 text-[11px] ring-1 ring-white/10">
                      <option value="" disabled>set…</option>
                      {MONITOR_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
                    </select>
                  </label>
                  <button onClick={enrichGroup} className="rounded border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[11px] text-sky-200 hover:bg-sky-500/20">Enrich fleet ({vesselList.length})</button>
                  <button onClick={removeGroupVessels} className="rounded border border-red-500/30 px-2 py-0.5 text-[11px] text-red-300 hover:bg-red-500/10">Remove all</button>
                </>
              )}
              {selCount > 0 && (
                <>
                  <span className="text-[11px] text-gray-400">{selCount} selected</span>
                  <button onClick={enrichSelected} className="rounded border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[11px] text-sky-200 hover:bg-sky-500/20">Enrich ({selCount})</button>
                  <button onClick={removeSelected} className="rounded border border-red-500/30 px-2 py-0.5 text-[11px] text-red-300 hover:bg-red-500/10">Remove ({selCount})</button>
                </>
              )}
            </div>
          </div>

          {vessels.isLoading ? (
            <Placeholder>Loading…</Placeholder>
          ) : vesselList.length === 0 ? (
            <Placeholder>No vessels here yet. Add by MMSI/IMO or name above, or from the map via <strong className="text-emerald-400">+ Monitor</strong>.</Placeholder>
          ) : (
            <div className="overflow-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-gray-500">
                  <tr className="border-b border-white/10">
                    <th className="w-6 py-1.5" />
                    <th className="py-1.5 pr-2 font-medium">Vessel</th>
                    <th className="py-1.5 pr-2 font-medium">MMSI</th>
                    <th className="py-1.5 pr-2 font-medium">Type</th>
                    <th className="py-1.5 pr-2 font-medium">Flag</th>
                    <th className="py-1.5 pr-2 font-medium">Enriched</th>
                    <th className="py-1.5 pr-2 font-medium">Monitor</th>
                    <th className="py-1.5 pr-2 font-medium">Group</th>
                    <th className="py-1.5 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {vesselList.map((v: MonitoredVessel) => (
                    <Fragment key={v.id}>
                      <tr className="border-b border-white/5 align-top">
                        <td className="py-1.5"><input type="checkbox" checked={selected.has(v.id)} onChange={() => toggleSel(v.id)} /></td>
                        <td className="py-1.5 pr-2 text-gray-200">
                          <button onClick={() => setExpanded(expanded === v.id ? null : (v.mmsi ?? v.id))} className="text-left hover:text-sky-300" title="Show enriched data">
                            {v.name || "—"} {v.mmsi && <span className="text-gray-600">{expanded === (v.mmsi ?? v.id) ? "▾" : "▸"}</span>}
                          </button>
                          {v.imo ? <div className="text-[10px] text-gray-500">IMO {v.imo}</div> : null}
                        </td>
                        <td className="py-1.5 pr-2 font-mono text-gray-300">{v.mmsi || "—"}</td>
                        <td className="py-1.5 pr-2 text-gray-400">{v.vesselType || "—"}</td>
                        <td className="py-1.5 pr-2 text-gray-400">{v.flag || "—"}</td>
                        <td className="py-1.5 pr-2">{v.enrichedAt ? <span className="text-emerald-400" title={new Date(v.enrichedAt).toLocaleString()}>✓</span> : <span className="text-gray-600">—</span>}</td>
                        <td className="py-1.5 pr-2">
                          <select value={v.monitorCadenceMinutes} onChange={(e) => run(() => setVesselMonitor(v.id, Number(e.target.value)))} className={`rounded bg-black/30 px-1.5 py-0.5 text-[11px] ring-1 ring-white/10 ${v.monitorCadenceMinutes > 0 ? "text-emerald-300" : "text-gray-400"}`}>
                            {MONITOR_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
                          </select>
                        </td>
                        <td className="py-1.5 pr-2">
                          <select value={v.groupId ?? ""} onChange={(e) => run(() => updateMonitoredVessel(v.id, { groupId: e.target.value || null }))} className="rounded bg-black/30 px-1.5 py-0.5 text-[11px] ring-1 ring-white/10">
                            <option value="">Unassigned</option>
                            {groupList.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                          </select>
                        </td>
                        <td className="py-1.5">
                          <div className="flex gap-1">
                            <button onClick={() => showOnMap(v.mmsi, v.lastLatitude, v.lastLongitude)} className="rounded border border-white/10 px-1.5 py-0.5 text-[10px] hover:bg-white/10" title="Show on map">Map</button>
                            <button onClick={() => { if (confirm(`Remove ${v.name || v.mmsi || "this vessel"}?`)) run(() => removeMonitoredVessel(v.id)); }} className="rounded border border-red-500/30 px-1.5 py-0.5 text-[10px] text-red-300 hover:bg-red-500/10" title="Remove">Remove</button>
                          </div>
                        </td>
                      </tr>
                      {expanded === (v.mmsi ?? v.id) && v.mmsi && (
                        <tr><td colSpan={9} className="p-0"><EnrichedDetail mmsi={v.mmsi} /></td></tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <p className="mt-4 text-[11px] text-gray-600">
        Monitoring refreshes a vessel's position on its cadence (Data Docked — credits). Auto-enrich applies to single adds and map picks; fleet and ban-list additions are enriched only when you choose to. Vessels are keyed by MMSI.
      </p>
    </PageShell>
  );
}
