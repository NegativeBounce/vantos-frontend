import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getMonitorGroups, addMonitoredVessel, createMonitorGroup } from "../lib/api";

// Add a vessel to the Vessel Registry watchlist, optionally into a group. Reused wherever
// a vessel is shown (anomaly evidence, selected vessel). Self-contained UI + state.
export default function MonitorButton({
  mmsi, imo = null, name = null, vesselType = null, flag = null, lat = null, lon = null, compact = false,
}: {
  mmsi: string | null;
  imo?: string | null;
  name?: string | null;
  vesselType?: string | null;
  flag?: string | null;
  lat?: number | null;
  lon?: number | null;
  compact?: boolean;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [groupId, setGroupId] = useState<string>("");
  const [newGroup, setNewGroup] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const groups = useQuery({ queryKey: ["monitor-groups"], queryFn: getMonitorGroups, enabled: open });

  if (!mmsi && !imo) return null;

  async function add() {
    setBusy(true);
    setErr(null);
    try {
      let gid: string | null = groupId || null;
      if (newGroup.trim()) {
        const res = await createMonitorGroup({ name: newGroup.trim() });
        if (res.status !== "ok" || !res.group) throw new Error(res.error || "could not create group");
        gid = res.group.id;
      }
      const res = await addMonitoredVessel({
        mmsi, imo, name, vesselType, flag, groupId: gid,
        lastLatitude: lat, lastLongitude: lon,
      });
      if (res.status !== "ok") throw new Error(res.error || "could not add to registry");
      setDone(true);
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["monitor-groups"] });
      qc.invalidateQueries({ queryKey: ["monitored-vessels"] });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return <span className={`text-[11px] text-emerald-400 ${compact ? "" : "block"}`}>✓ Monitoring</span>;
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className={`rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20 ${compact ? "px-1.5 py-0.5 text-[10px]" : "w-full px-2 py-1 text-[12px] font-medium"}`}
        title="Add this vessel to the Vessel Registry watchlist"
      >
        + Monitor
      </button>
    );
  }

  return (
    <div className="rounded border border-emerald-500/30 bg-emerald-500/5 p-2 text-[11px]">
      <div className="mb-1 text-emerald-300">Add to registry</div>
      <select
        value={groupId}
        onChange={(e) => setGroupId(e.target.value)}
        className="w-full rounded bg-black/30 px-2 py-1 text-[11px] ring-1 ring-white/10"
      >
        <option value="">Unassigned</option>
        {(groups.data?.groups ?? []).map((g) => (
          <option key={g.id} value={g.id}>{g.name}</option>
        ))}
      </select>
      <input
        value={newGroup}
        onChange={(e) => setNewGroup(e.target.value)}
        placeholder="…or new group name"
        className="mt-1 w-full rounded bg-black/30 px-2 py-1 text-[11px] ring-1 ring-white/10 placeholder:text-gray-600"
      />
      {err && <p className="mt-1 text-amber-400">{err}</p>}
      <div className="mt-1.5 flex gap-1.5">
        <button onClick={add} disabled={busy} className="flex-1 rounded bg-emerald-600 px-2 py-1 font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
          {busy ? "Adding…" : "Add"}
        </button>
        <button onClick={() => { setOpen(false); setErr(null); }} className="rounded border border-white/10 px-2 py-1 hover:bg-white/10">
          Cancel
        </button>
      </div>
    </div>
  );
}
