import { useQuery } from "@tanstack/react-query";
import MapView from "../components/MapView";
import { getHealth, getRegions, getPositions } from "../lib/api";
import { useAuth } from "../lib/auth";

const LAYERS = ["AIS (AISStream + Data Docked)", "ADS-B / GNSS interference", "Imagery"];

export default function Workspace() {
  const { logout } = useAuth();
  const health = useQuery({ queryKey: ["health"], queryFn: getHealth });
  const regions = useQuery({ queryKey: ["regions"], queryFn: getRegions });
  const positions = useQuery({ queryKey: ["positions"], queryFn: getPositions });

  return (
    <div className="relative h-screen w-screen overflow-hidden">
      <MapView vessels={positions.data?.vessels ?? []} />

      {/* Top bar */}
      <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between bg-black/40 px-4 py-2 backdrop-blur">
        <div className="text-sm font-semibold">VantosEdge</div>
        <div className="flex items-center gap-3 text-xs">
          <span className={health.data?.status === "ok" ? "text-emerald-400" : "text-gray-400"}>
            backend: {health.isLoading ? "…" : (health.data?.status ?? "unreachable")}
          </span>
          <button
            onClick={logout}
            className="rounded border border-white/10 px-2 py-1 hover:bg-white/10"
          >
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
        <p className="pt-1 text-[10px] text-gray-500">Toggles + live AIS/ADS-B wire in upcoming slices.</p>
      </div>

      {/* Right context panel */}
      <div className="absolute right-3 top-14 z-10 w-56 rounded-lg border border-white/10 bg-black/50 p-3 text-xs backdrop-blur">
        <div className="font-medium text-gray-300">
          Regions ({regions.data?.regions?.length ?? 0})
        </div>
        <ul className="mt-2 space-y-1 text-gray-400">
          {regions.data?.regions?.map((r) => (
            <li key={r.id}>{r.name}</li>
          ))}
          {regions.isError && <li className="text-amber-400">backend unreachable</li>}
        </ul>
      </div>
    </div>
  );
}
