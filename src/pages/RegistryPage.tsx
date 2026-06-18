import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import PageShell, { Placeholder } from "../components/PageShell";
import {
  getMonitorGroups, createMonitorGroup, updateMonitorGroup, deleteMonitorGroup,
  getMonitoredVessels, updateMonitoredVessel, removeMonitoredVessel,
} from "../lib/api";

type Scope = { kind: "all" } | { kind: "unassigned" } | { kind: "group"; id: string; name: string };

export default function RegistryPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [scope, setScope] = useState<Scope>({ kind: "all" });
  const [newGroup, setNewGroup] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const groups = useQuery({ queryKey: ["monitor-groups"], queryFn: getMonitorGroups });
  const vessels = useQuery({
    queryKey: ["monitored-vessels", scope],
    queryFn: () =>
      getMonitoredVessels(
        scope.kind === "group" ? { groupId: scope.id } : scope.kind === "unassigned" ? { unassigned: true } : undefined
      ),
  });

  const groupList = groups.data?.groups ?? [];
  const vesselList = vessels.data?.vessels ?? [];

  async function run(fn: () => Promise<unknown>) {
    setErr(null);
    try {
      await fn();
      qc.invalidateQueries({ queryKey: ["monitor-groups"] });
      qc.invalidateQueries({ queryKey: ["monitored-vessels"] });
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function addGroup() {
    const name = newGroup.trim();
    if (!name) return;
    const res = await createMonitorGroup({ name });
    if (res.status !== "ok") { setErr(res.error ?? "could not create group"); return; }
    setNewGroup("");
    qc.invalidateQueries({ queryKey: ["monitor-groups"] });
  }

  function showOnMap(mmsi: string | null, lat: number | null, lon: number | null) {
    navigate("/", { state: { flyMmsi: mmsi ?? undefined, flyLat: lat ?? undefined, flyLon: lon ?? undefined } });
  }

  const scopeLabel =
    scope.kind === "all" ? "All monitored vessels" : scope.kind === "unassigned" ? "Unassigned" : scope.name;

  return (
    <PageShell
      title="Vessel Registry"
      subtitle="A curated watchlist of vessels to keep monitoring. Organise them into groups — by company/fleet, type of activity, or however you investigate."
    >
      {err && <div className="mb-3 rounded border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-300">{err}</div>}
      <div className="grid gap-4 md:grid-cols-[16rem_1fr]">
        {/* Group sidebar */}
        <section className="rounded-lg border border-white/10 bg-black/30 p-3">
          <h2 className="mb-2 text-sm font-medium text-gray-200">Groups</h2>
          <ul className="space-y-0.5 text-sm">
            <li>
              <button onClick={() => setScope({ kind: "all" })}
                className={`w-full rounded px-2 py-1 text-left ${scope.kind === "all" ? "bg-sky-500/20 text-sky-300" : "text-gray-300 hover:bg-white/10"}`}>
                All vessels
              </button>
            </li>
            <li>
              <button onClick={() => setScope({ kind: "unassigned" })}
                className={`w-full rounded px-2 py-1 text-left ${scope.kind === "unassigned" ? "bg-sky-500/20 text-sky-300" : "text-gray-300 hover:bg-white/10"}`}>
                Unassigned
              </button>
            </li>
            <li className="my-1 border-t border-white/10" />
            {groupList.map((g) => (
              <li key={g.id}>
                {renaming === g.id ? (
                  <div className="flex gap-1 p-1">
                    <input value={renameVal} onChange={(e) => setRenameVal(e.target.value)} autoFocus
                      className="min-w-0 flex-1 rounded bg-black/30 px-1.5 py-0.5 text-xs ring-1 ring-white/10" />
                    <button onClick={() => run(() => updateMonitorGroup(g.id, { name: renameVal.trim() })).then(() => setRenaming(null))}
                      className="rounded bg-sky-600 px-1.5 text-xs text-white">Save</button>
                    <button onClick={() => setRenaming(null)} className="rounded border border-white/10 px-1.5 text-xs">✕</button>
                  </div>
                ) : (
                  <div className={`group flex items-center rounded ${scope.kind === "group" && scope.id === g.id ? "bg-sky-500/20" : "hover:bg-white/10"}`}>
                    <button onClick={() => setScope({ kind: "group", id: g.id, name: g.name })}
                      className={`min-w-0 flex-1 truncate px-2 py-1 text-left ${scope.kind === "group" && scope.id === g.id ? "text-sky-300" : "text-gray-300"}`}>
                      {g.name} <span className="text-gray-500">{g.vesselCount}</span>
                    </button>
                    <button onClick={() => { setRenaming(g.id); setRenameVal(g.name); }} title="Rename"
                      className="px-1 text-xs text-gray-500 opacity-0 group-hover:opacity-100 hover:text-gray-200">✎</button>
                    <button onClick={() => { if (confirm(`Delete group "${g.name}"? Its vessels become Unassigned.`)) run(() => deleteMonitorGroup(g.id)); }}
                      title="Delete group" className="px-1 pr-2 text-xs text-gray-500 opacity-0 group-hover:opacity-100 hover:text-red-300">🗑</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <div className="mt-3 flex gap-1">
            <input value={newGroup} onChange={(e) => setNewGroup(e.target.value)} placeholder="New group"
              onKeyDown={(e) => { if (e.key === "Enter") addGroup(); }}
              className="min-w-0 flex-1 rounded bg-black/30 px-2 py-1 text-xs ring-1 ring-white/10 placeholder:text-gray-600" />
            <button onClick={addGroup} className="rounded bg-emerald-600 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-500">Add</button>
          </div>
        </section>

        {/* Vessel table */}
        <section className="rounded-lg border border-white/10 bg-black/30 p-3">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-medium text-gray-200">{scopeLabel} <span className="text-gray-500">· {vesselList.length}</span></h2>
          </div>

          {vessels.isLoading ? (
            <Placeholder>Loading…</Placeholder>
          ) : vesselList.length === 0 ? (
            <Placeholder>
              No vessels here yet. Add vessels to the registry from the map — open a vessel or an anomaly finding and use <strong className="text-emerald-400">+ Monitor</strong>.
            </Placeholder>
          ) : (
            <div className="overflow-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-gray-500">
                  <tr className="border-b border-white/10">
                    <th className="py-1.5 pr-2 font-medium">Vessel</th>
                    <th className="py-1.5 pr-2 font-medium">MMSI</th>
                    <th className="py-1.5 pr-2 font-medium">Type</th>
                    <th className="py-1.5 pr-2 font-medium">Flag</th>
                    <th className="py-1.5 pr-2 font-medium">Group</th>
                    <th className="py-1.5 pr-2 font-medium">Notes</th>
                    <th className="py-1.5 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {vesselList.map((v) => (
                    <tr key={v.id} className="border-b border-white/5 align-top">
                      <td className="py-1.5 pr-2 text-gray-200">{v.name || "—"}{v.imo ? <div className="text-[10px] text-gray-500">IMO {v.imo}</div> : null}</td>
                      <td className="py-1.5 pr-2 font-mono text-gray-300">{v.mmsi || "—"}</td>
                      <td className="py-1.5 pr-2 text-gray-400">{v.vesselType || "—"}</td>
                      <td className="py-1.5 pr-2 text-gray-400">{v.flag || "—"}</td>
                      <td className="py-1.5 pr-2">
                        <select
                          value={v.groupId ?? ""}
                          onChange={(e) => run(() => updateMonitoredVessel(v.id, { groupId: e.target.value || null }))}
                          className="rounded bg-black/30 px-1.5 py-0.5 text-[11px] ring-1 ring-white/10"
                        >
                          <option value="">Unassigned</option>
                          {groupList.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                        </select>
                      </td>
                      <td className="py-1.5 pr-2">
                        <input
                          defaultValue={v.notes ?? ""}
                          placeholder="add note…"
                          onBlur={(e) => { if ((e.target.value || null) !== (v.notes ?? null)) run(() => updateMonitoredVessel(v.id, { notes: e.target.value })); }}
                          className="w-32 rounded bg-black/20 px-1.5 py-0.5 text-[11px] ring-1 ring-white/5 placeholder:text-gray-600 focus:ring-white/20"
                        />
                      </td>
                      <td className="py-1.5">
                        <div className="flex gap-1">
                          <button onClick={() => showOnMap(v.mmsi, v.lastLatitude, v.lastLongitude)}
                            className="rounded border border-white/10 px-1.5 py-0.5 text-[10px] hover:bg-white/10" title="Show on map">Map</button>
                          <button onClick={() => { if (confirm(`Remove ${v.name || v.mmsi || "this vessel"} from the registry?`)) run(() => removeMonitoredVessel(v.id)); }}
                            className="rounded border border-red-500/30 px-1.5 py-0.5 text-[10px] text-red-300 hover:bg-red-500/10" title="Remove">Remove</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <p className="mt-4 text-[11px] text-gray-600">
        The registry is a display/organisation aid — it does not change what is collected or trigger any automated action.
        Vessels are keyed by MMSI; re-adding an MMSI moves it to the chosen group.
      </p>
    </PageShell>
  );
}
