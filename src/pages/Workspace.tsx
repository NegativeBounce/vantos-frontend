import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import MapView from "../components/MapView";
import { getHealth, getRegions, getPositions, searchArea, type AreaSearchResult } from "../lib/api";
import { useAuth } from "../lib/auth";

const LAYERS = ["AIS (AISStream + Data Docked)", "ADS-B / GNSS interference", "Imagery"];
const REPORT_TYPES = ["Insurance Risk Advisory", "Weekly Maritime Intelligence", "Vessel Captain Advisory"];

export default function Workspace() {
  const { logout } = useAuth();
  const qc = useQueryClient();
  const health = useQuery({ queryKey: ["health"], queryFn: getHealth });
  const regions = useQuery({ queryKey: ["regions"], queryFn: getRegions });
  const positions = useQuery({ queryKey: ["positions"], queryFn: getPositions });

  const [center, setCenter] = useState<{ lng: number; lat: number } | null>(null);
  const [radiusKm, setRadiusKm] = useState(50);
  const [searching, setSearching] = useState(false);
  const [result, setResult] = useState<AreaSearchResult | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [reportType, setReportType] = useState(REPORT_TYPES[0]);
  const [generated, setGenerated] = useState<string | null>(null);

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
        vessels={positions.data?.vessels ?? []}
        selection={center ? { lng: center.lng, lat: center.lat, radiusKm } : null}
        onMapClick={(lng, lat) => setCenter({ lng, lat })}
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
      <div className="absolute left-3 top-14 z-10 w-48 space-y-2 rounded-lg border border-white/10 bg-black/50 p-3 text-xs backdrop-blur">
        <div className="font-medium text-gray-300">Layers</div>
        {LAYERS.map((l) => (
          <label key={l} className="flex items-center gap-2 text-gray-400">
            <input type="checkbox" disabled /> {l}
          </label>
        ))}
        <div className="mt-1 border-t border-white/10 pt-2 text-gray-300">
          Vessels plotted: <span className="font-mono text-sky-400">{positions.data?.count ?? 0}</span>
        </div>
      </div>

      {/* Right context panel */}
      <div className="absolute right-3 top-14 z-10 w-56 rounded-lg border border-white/10 bg-black/50 p-3 text-xs backdrop-blur">
        <div className="font-medium text-gray-300">Regions ({regions.data?.regions?.length ?? 0})</div>
        <ul className="mt-2 space-y-1 text-gray-400">
          {regions.data?.regions?.map((r) => <li key={r.id}>{r.name}</li>)}
        </ul>
      </div>

      {/* Area-search panel */}
      <div className="absolute bottom-4 left-3 z-10 w-64 rounded-lg border border-white/10 bg-black/60 p-3 text-xs backdrop-blur">
        <div className="font-medium text-gray-200">Area search</div>
        {center ? (
          <>
            <div className="mt-1 text-gray-400">
              center {center.lat.toFixed(2)}, {center.lng.toFixed(2)}
            </div>
            <label className="mt-2 block text-gray-400">
              radius: <span className="font-mono text-amber-400">{radiusKm} km</span>
              <input
                type="range"
                min={1}
                max={50}
                value={radiusKm}
                onChange={(e) => setRadiusKm(Number(e.target.value))}
                className="mt-1 w-full"
              />
            </label>
            <div className="mt-2 flex gap-2">
              <button
                onClick={runSearch}
                disabled={searching}
                className="rounded bg-amber-600 px-2 py-1 font-medium text-black hover:bg-amber-500 disabled:opacity-50"
              >
                {searching ? "Searching…" : "Search this area"}
              </button>
              <button onClick={() => setCenter(null)} className="rounded border border-white/10 px-2 py-1 hover:bg-white/10">
                Clear
              </button>
            </div>
          </>
        ) : (
          <p className="mt-1 text-gray-500">Click the map to drop a center, set a radius (≤50 km), then search.</p>
        )}
      </div>

      {/* Report modal */}
      {modalOpen && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/50 p-4">
          <div className="w-96 rounded-xl border border-white/10 bg-[#0f1620] p-5 text-sm">
            <div className="flex items-center justify-between">
              <div className="text-base font-semibold">Generate report</div>
              <button onClick={() => setModalOpen(false)} className="text-gray-400 hover:text-white">
                ✕
              </button>
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
                  <button onClick={() => setModalOpen(false)} className="rounded border border-white/10 px-3 py-1.5 hover:bg-white/10">
                    Close
                  </button>
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
