import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import MapView, { type PickedVessel } from "../components/MapView";
import { getHealth, getRegions, getPositions, searchArea, type AreaSearchResult } from "../lib/api";
import { useAuth } from "../lib/auth";

const REPORT_TYPES = ["Insurance Risk Advisory", "Weekly Maritime Intelligence", "Vessel Captain Advisory"];

export default function Workspace() {
  const { logout } = useAuth();
  const qc = useQueryClient();
  const health = useQuery({ queryKey: ["health"], queryFn: getHealth });
  const regions = useQuery({ queryKey: ["regions"], queryFn: getRegions });
  const positions = useQuery({ queryKey: ["positions"], queryFn: getPositions });

  // AIS display controls
  const [aisVisible, setAisVisible] = useState(true);
  const [boxMode, setBoxMode] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<PickedVessel[]>([]);

  // Area search
  const [center, setCenter] = useState<{ lng: number; lat: number } | null>(null);
  const [radiusKm, setRadiusKm] = useState(50);
  const [searching, setSearching] = useState(false);
  const [result, setResult] = useState<AreaSearchResult | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [reportType, setReportType] = useState(REPORT_TYPES[0]);
  const [generated, setGenerated] = useState<string | null>(null);

  const allVessels = positions.data?.vessels ?? [];
  const displayed = useMemo(
    () => allVessels.filter((v) => !hidden.has(v.mmsi ?? "")),
    [allVessels, hidden]
  );

  function hideVessels(vessels: PickedVessel[]) {
    setHidden((prev) => {
      const next = new Set(prev);
      vessels.forEach((v) => v.mmsi && next.add(v.mmsi));
      return next;
    });
    setSelected([]);
  }
  const clearShown = () => hideVessels(displayed.map((v) => ({ mmsi: v.mmsi, name: v.name })));
  const resetHidden = () => { setHidden(new Set()); setSelected([]); };

  async function runSearch() {
    if (!center) return;
    setSearching(true);
    setGenerated(null);
    try {
      const res = await searchArea(center.lat, center.lng, radiusKm);
      setResult(res);
      await qc.invalidateQueries({ queryKey: ["positions"] });
      setModalOpen(true);
    } catch (e) {
      setResult({ status: "error", error: (e as Error).message });
      setModalOpen(true);
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="relative h-screen w-screen overflow-hidden">
      <MapView
        vessels={displayed}
        selection={center ? { lng: center.lng, lat: center.lat, radiusKm } : null}
        onMapClick={(lng, lat) => setCenter({ lng, lat })}
        aisVisible={aisVisible}
        boxSelectMode={boxMode}
        onVesselClick={(v) => setSelected([v])}
        onBoxSelect={(vs) => setSelected(vs)}
      />

      {/* Top bar */}
      <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between bg-black/40 px-4 py-2 backdrop-blur">
        <div className="text-sm font-semibold">VantosEdge</div>
        <div className="flex items-center gap-3 text-xs">
          <span className={health.data?.status === "ok" ? "text-emerald-400" : "text-gray-400"}>
            backend: {health.isLoading ? "…" : (health.data?.status ?? "unreachable")}
          </span>
          <button onClick={logout} className="rounded border border-white/10 px-2 py-1 hover:bg-white/10">
            Sign out
          </button>
        </div>
      </div>

      {/* Left layer rail */}
      <div className="absolute left-3 top-14 z-10 w-56 space-y-2 rounded-lg border border-white/10 bg-black/50 p-3 text-xs backdrop-blur">
        <div className="font-medium text-gray-300">Layers</div>
        <label className="flex items-center gap-2 text-gray-300">
          <input type="checkbox" checked={aisVisible} onChange={(e) => setAisVisible(e.target.checked)} />
          AIS (AISStream + Data Docked)
        </label>
        <label className="flex items-center gap-2 text-gray-500">
          <input type="checkbox" disabled /> ADS-B / GNSS interference
        </label>
        <label className="flex items-center gap-2 text-gray-500">
          <input type="checkbox" disabled /> Imagery
        </label>

        <div className="mt-1 border-t border-white/10 pt-2 text-gray-300">
          Vessels shown: <span className="font-mono text-sky-400">{displayed.length}</span>
          <span className="text-gray-500"> / {allVessels.length}</span>
        </div>
        <div className="flex flex-wrap gap-1.5 pt-1">
          <button
            onClick={() => setBoxMode((b) => !b)}
            className={`rounded border px-2 py-1 ${boxMode ? "border-sky-400 bg-sky-500/20 text-sky-300" : "border-white/10 hover:bg-white/10"}`}
          >
            {boxMode ? "Box select: ON" : "Box select"}
          </button>
          <button onClick={clearShown} className="rounded border border-white/10 px-2 py-1 hover:bg-white/10">
            Clear shown
          </button>
          <button onClick={resetHidden} className="rounded border border-white/10 px-2 py-1 hover:bg-white/10">
            Reset
          </button>
        </div>
        {boxMode && <p className="text-[10px] text-sky-300/80">Drag a rectangle to select vessels.</p>}
      </div>

      {/* Right context panel */}
      <div className="absolute right-3 top-14 z-10 w-56 rounded-lg border border-white/10 bg-black/50 p-3 text-xs backdrop-blur">
        <div className="font-medium text-gray-300">Regions ({regions.data?.regions?.length ?? 0})</div>
        <ul className="mt-2 space-y-1 text-gray-400">
          {regions.data?.regions?.map((r) => <li key={r.id}>{r.name}</li>)}
        </ul>
      </div>

      {/* Selection actions panel */}
      {selected.length > 0 && (
        <div className="absolute right-3 top-44 z-10 w-56 rounded-lg border border-sky-400/40 bg-black/70 p-3 text-xs backdrop-blur">
          <div className="flex items-center justify-between">
            <span className="font-medium text-sky-300">Selected: {selected.length}</span>
            <button onClick={() => setSelected([])} className="text-gray-400 hover:text-white">✕</button>
          </div>
          <ul className="mt-1 max-h-24 space-y-0.5 overflow-auto text-gray-400">
            {selected.slice(0, 6).map((v, i) => (
              <li key={(v.mmsi ?? "") + i}>{v.name || v.mmsi || "unknown"}</li>
            ))}
            {selected.length > 6 && <li className="text-gray-500">+{selected.length - 6} more</li>}
          </ul>
          <div className="mt-2 space-y-1">
            <button
              onClick={() => hideVessels(selected)}
              className="w-full rounded bg-amber-600 px-2 py-1 font-medium text-black hover:bg-amber-500"
            >
              Remove from display
            </button>
            <button disabled className="w-full rounded border border-white/10 px-2 py-1 text-gray-500" title="Coming in a later slice">
              Report on selected (soon)
            </button>
          </div>
        </div>
      )}

      {/* Area-search panel */}
      <div className="absolute bottom-4 left-3 z-10 w-64 rounded-lg border border-white/10 bg-black/60 p-3 text-xs backdrop-blur">
        <div className="font-medium text-gray-200">Area search</div>
        {center ? (
          <>
            <div className="mt-1 text-gray-400">center {center.lat.toFixed(2)}, {center.lng.toFixed(2)}</div>
            <label className="mt-2 block text-gray-400">
              radius: <span className="font-mono text-amber-400">{radiusKm} km</span>
              <input type="range" min={1} max={50} value={radiusKm} onChange={(e) => setRadiusKm(Number(e.target.value))} className="mt-1 w-full" />
            </label>
            <div className="mt-2 flex gap-2">
              <button onClick={runSearch} disabled={searching} className="rounded bg-amber-600 px-2 py-1 font-medium text-black hover:bg-amber-500 disabled:opacity-50">
                {searching ? "Searching…" : "Search this area"}
              </button>
              <button onClick={() => setCenter(null)} className="rounded border border-white/10 px-2 py-1 hover:bg-white/10">Clear</button>
            </div>
          </>
        ) : (
          <p className="mt-1 text-gray-500">
            {boxMode ? "Box-select is on — turn it off to drop a search center." : "Click the map to drop a center, set a radius (≤50 km), then search."}
          </p>
        )}
      </div>

      {/* Report modal */}
      {modalOpen && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/50 p-4">
          <div className="w-96 rounded-xl border border-white/10 bg-[#0f1620] p-5 text-sm">
            <div className="flex items-center justify-between">
              <div className="text-base font-semibold">Generate report</div>
              <button onClick={() => setModalOpen(false)} className="text-gray-400 hover:text-white">✕</button>
            </div>
            {result?.error ? (
              <p className="mt-3 text-amber-400">Search failed: {result.error}</p>
            ) : (
              <>
                <p className="mt-2 text-gray-400">
                  Center {result?.center?.latitude}, {result?.center?.longitude} · {result?.radiusKm} km ·{" "}
                  <span className="text-sky-400">{result?.stored ?? 0}</span> vessels found.
                </p>
                <div className="mt-3 space-y-1">
                  {REPORT_TYPES.map((rt) => (
                    <label key={rt} className="flex items-center gap-2 text-gray-300">
                      <input type="radio" name="rt" checked={reportType === rt} onChange={() => setReportType(rt)} /> {rt}
                    </label>
                  ))}
                </div>
                {generated && <p className="mt-3 rounded bg-white/5 p-2 text-emerald-400">{generated}</p>}
                <div className="mt-4 flex justify-end gap-2">
                  <button onClick={() => setModalOpen(false)} className="rounded border border-white/10 px-3 py-1.5 hover:bg-white/10">Close</button>
                  <button
                    onClick={() => setGenerated(`Drafting "${reportType}" for this area — the report engine wires in the next slice.`)}
                    className="rounded bg-sky-600 px-3 py-1.5 font-medium hover:bg-sky-500"
                  >
                    Generate
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
