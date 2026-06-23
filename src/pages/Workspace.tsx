import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import MapView, { type PickedVessel, type ViewportBbox, type FlyTo, type Footprint } from "../components/MapView";
import Modal from "../components/Modal";
import MonitorButton from "../components/MonitorButton";
import { usePersistentState } from "../lib/persist";
import { getRegions, getPositions, getVesselTrack, getAisGaps, getGnssInterference, getAnomalies, runAnomalyAnalysis, clearAnomalies, saveAnalysisSnapshot, getAnalysisSnapshots, getAnalysisSnapshot, deleteAnalysisSnapshot, enrichVessel, getLatestPosition, searchArea, setRegionCollection, pullRegion, createRegion, deleteRegion, getIngestionRuns, getBannedVessels, getVesselPortCalls, getAssociations, fleetFromAssociation, getMonitorGroups, addMonitoredVessel, getRegistryMap, type AreaSearchResult, type Anomaly, type Region, type VesselEnrichment, type VesselPosition, type AssociationDim, type AssociationFilter, type AssociationGroup, type BannedVessel } from "../lib/api";

// Association dimensions for colour/filter/grouping (must match the backend whitelist).
const ASSOC_DIMS: { dim: AssociationDim; label: string }[] = [
  { dim: "owner", label: "Owner" },
  { dim: "manager", label: "Manager" },
  { dim: "flag", label: "Flag" },
  { dim: "type", label: "Vessel type" },
  { dim: "class_society", label: "Classification society" },
  { dim: "nav_status", label: "Status" },
];
const ASSOC_DIM_LABEL: Record<AssociationDim, string> = Object.fromEntries(ASSOC_DIMS.map((d) => [d.dim, d.label] as [string, string])) as Record<AssociationDim, string>;
// Distinct-ish palette for colour-by (top values get a colour; the rest fall back to grey).
const ASSOC_PALETTE = ["#38bdf8", "#f59e0b", "#22c55e", "#ef4444", "#a855f7", "#eab308", "#ec4899", "#14b8a6", "#fb923c", "#60a5fa", "#f472b6", "#4ade80"];
function dimValue(v: VesselPosition, dim: AssociationDim): string {
  const raw =
    dim === "flag" ? v.flag : dim === "type" ? v.type : dim === "owner" ? v.owner
    : dim === "manager" ? v.manager : dim === "class_society" ? v.classSociety : v.navStatus;
  const s = (raw ?? "").trim();
  return s === "" ? "(unknown)" : s;
}

// Extended-enrichment sections (D-64): MoU inspections, port-calls, ban-list status. Field
// names from Data Docked aren't fully verified, so we render whatever scalar fields each
// record carries rather than assuming a fixed shape. Shown below the vessel particulars in
// both enrich panels (selected-vessel + anomaly detail).
function ScalarRows({ rec }: { rec: Record<string, string | number | boolean> }) {
  return (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5">
      {Object.entries(rec).map(([k, v]) => (
        <div key={k} className="flex justify-between gap-2">
          <dt className="text-gray-500">{k}</dt>
          <dd className="truncate text-gray-200" title={String(v)}>{String(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

function EnrichSectionBlock({ title, section }: { title: string; section: VesselEnrichment["mou"] }) {
  if (!section) return null; // call wasn't made (e.g. no credentials)
  return (
    <div className="mt-2 border-t border-white/10 pt-2">
      <div className="mb-1 font-medium text-sky-300">{title}</div>
      {section.error ? (
        <p className="text-amber-400/90">Unavailable: {section.error}</p>
      ) : section.records.length === 0 ? (
        <p className="text-gray-500">No records.</p>
      ) : (
        <div className="space-y-1.5">
          {section.records.slice(0, 25).map((rec, i) => (
            <div key={i} className="rounded bg-white/5 p-1.5">
              <ScalarRows rec={rec} />
            </div>
          ))}
          {section.records.length > 25 && (
            <p className="text-[10px] text-gray-500">+{section.records.length - 25} more not shown</p>
          )}
        </div>
      )}
    </div>
  );
}

// MoU + port-calls + ban status. Rendered after the particulars grid in each enrich panel.
function EnrichExtras({ data }: { data: VesselEnrichment }) {
  const ban = data.banStatus;
  return (
    <>
      {ban && (
        <div className="mt-2 border-t border-white/10 pt-2">
          <div className="mb-1 font-medium text-sky-300">Sanctions / ban-list</div>
          {ban.error ? (
            <p className="text-amber-400/90">Unavailable: {ban.error}</p>
          ) : ban.listed === true ? (
            <p className="font-medium text-red-400">⚠ Listed on Data Docked ban-list</p>
          ) : ban.listed === false ? (
            <p className="text-emerald-400/90">Not on Data Docked ban-list</p>
          ) : (
            <p className="text-gray-400">Status undetermined from the returned data.</p>
          )}
          {ban.records.length > 0 && (
            <div className="mt-1 space-y-1.5">
              {ban.records.slice(0, 10).map((rec, i) => (
                <div key={i} className="rounded bg-red-500/10 p-1.5"><ScalarRows rec={rec} /></div>
              ))}
            </div>
          )}
          <p className="mt-1 text-[10px] text-gray-600">Data Docked determination — corroborate with an authoritative sanctions list before action.</p>
        </div>
      )}
      <EnrichSectionBlock title="MoU inspections / detentions" section={data.mou} />
      <EnrichSectionBlock title="Recent port calls" section={data.portCalls} />
    </>
  );
}

// Overlay-colour palette for custom regions (default first = the baseline green).
const REGION_PALETTE = ["#22c55e", "#38bdf8", "#f59e0b", "#ef4444", "#a855f7", "#eab308", "#ec4899", "#14b8a6"];

// Satellite tiling estimate (mirrors backend defaults: 50km radius, 70km step, max 12 tiles).
// Each tile is a Data Docked get-vessels-by-area call ≈ 10 credits.
const SAT_TILE_STEP_KM = 70;
const SAT_TILE_MAX = 24; // mirror backend SAT_TILE_MAX_TILES — region auto-tiles up to this
const SAT_CREDITS_PER_TILE = 10;
type Bbox = { minLat: number; minLon: number; maxLat: number; maxLon: number };
// Grid that, when over the cap, scales down (preserving aspect) so tiles SPREAD over the
// whole box instead of clustering in the south rows. Mirrors backend tileBbox.
function bboxGrid(bbox: Bbox): { rows: number; cols: number; total: number; capped: boolean } {
  const midLat = (bbox.minLat + bbox.maxLat) / 2;
  const latSpanKm = Math.abs(bbox.maxLat - bbox.minLat) * 111;
  const lonSpanKm = Math.abs(bbox.maxLon - bbox.minLon) * 111 * Math.cos((midLat * Math.PI) / 180);
  let rows = Math.max(1, Math.ceil(latSpanKm / SAT_TILE_STEP_KM));
  let cols = Math.max(1, Math.ceil(lonSpanKm / SAT_TILE_STEP_KM));
  const total = rows * cols;
  let capped = false;
  if (total > SAT_TILE_MAX) {
    capped = true;
    const scale = Math.sqrt(SAT_TILE_MAX / total);
    rows = Math.max(1, Math.round(rows * scale));
    cols = Math.max(1, Math.round(cols * scale));
    while (rows * cols > SAT_TILE_MAX) { if (cols >= rows && cols > 1) cols--; else if (rows > 1) rows--; else break; }
  }
  return { rows, cols, total, capped };
}
function estimateSatTiles(bbox: Bbox): { tiles: number; total: number; capped: boolean } {
  const g = bboxGrid(bbox);
  return { tiles: g.rows * g.cols, total: g.total, capped: g.capped };
}
// Satellite tile centers for the bbox grid (footprint overlay / fallback).
function satTileCenters(bbox: Bbox): { lng: number; lat: number; radiusKm: number }[] {
  const { rows, cols } = bboxGrid(bbox);
  const out: { lng: number; lat: number; radiusKm: number }[] = [];
  for (let r = 0; r < rows; r++) {
    const lat = rows === 1 ? (bbox.minLat + bbox.maxLat) / 2 : bbox.minLat + ((r + 0.5) / rows) * (bbox.maxLat - bbox.minLat);
    for (let c = 0; c < cols; c++) {
      const lng = cols === 1 ? (bbox.minLon + bbox.maxLon) / 2 : bbox.minLon + ((c + 0.5) / cols) * (bbox.maxLon - bbox.minLon);
      out.push({ lng, lat, radiusKm: 50 });
    }
  }
  return out;
}
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
// Tile centers spaced along an operator-drawn path (mirrors backend pathTiles).
function pathTileCenters(path: number[][]): { lng: number; lat: number; radiusKm: number }[] {
  if (!path.length) return [];
  const out = [{ lng: path[0][0], lat: path[0][1], radiusKm: 50 }];
  let acc = 0;
  for (let i = 1; i < path.length && out.length < SAT_TILE_MAX; i++) {
    const lng0 = path[i - 1][0], lat0 = path[i - 1][1], lng1 = path[i][0], lat1 = path[i][1];
    const segKm = haversineKm(lat0, lng0, lat1, lng1);
    if (segKm === 0) continue;
    let d = 0;
    while (acc + (segKm - d) >= SAT_TILE_STEP_KM && out.length < SAT_TILE_MAX) {
      d += SAT_TILE_STEP_KM - acc;
      const t = d / segKm;
      out.push({ lng: lng0 + (lng1 - lng0) * t, lat: lat0 + (lat1 - lat0) * t, radiusKm: 50 });
      acc = 0;
    }
    acc += segKm - d;
  }
  return out;
}

const REPORT_TYPES = ["Insurance Risk Advisory", "Weekly Maritime Intelligence", "Vessel Captain Advisory"];
const CADENCE_OPTIONS = [
  { v: 1440, l: "24h" },
  { v: 360, l: "6h" },
  { v: 180, l: "3h" },
  { v: 60, l: "1h" },
];
// Satellite-pull cadence options (item 2): 1h / 3h / 6h / 12h / 24h.
const SAT_CADENCE_OPTIONS = [
  { v: 60, l: "1h" },
  { v: 180, l: "3h" },
  { v: 360, l: "6h" },
  { v: 720, l: "12h" },
  { v: 1440, l: "24h" },
];
type Tool = "vlayers" | "vessels" | "area" | "regions" | "gaps" | "analysis" | "activity" | "assoc" | "gnss" | "map";
type Domain = "vessel" | "gnss";
const DOMAINS: { key: Domain | "security"; label: string; stub?: boolean }[] = [
  { key: "vessel", label: "Vessel Intelligence" },
  { key: "gnss", label: "GNSS / Signals" },
  { key: "security", label: "Security", stub: true },
];

// Collection-activity labels: map an ingestion endpoint to a friendly source + cost class.
const ENDPOINT_INFO: Record<string, { label: string; paid: boolean }> = {
  "aisstream-snapshot": { label: "AISStream · terrestrial AIS", paid: false },
  "get-vessels-by-area": { label: "Data Docked · satellite AIS", paid: true },
  "get-vessel-info": { label: "Data Docked · enrichment", paid: true },
  "get-vessels-location-bulk-search": { label: "Data Docked · gap verify", paid: true },
  "get-aircraft-by-area": { label: "ADS-B Exchange · GNSS", paid: false },
};
function endpointInfo(endpoint: string): { label: string; paid: boolean } {
  return ENDPOINT_INFO[endpoint] ?? { label: endpoint, paid: false };
}
// Compact "time ago".
function ago(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}
// When a region's next AIS/Sat snapshot is due (last pull + cadence).
function fmtNextPull(lastIso: string | null, cadenceMin: number): string {
  if (!lastIso) return "due now";
  const ms = Date.parse(lastIso) + cadenceMin * 60_000 - Date.now();
  if (ms <= 0) return "due now";
  const h = ms / 3_600_000;
  if (h < 1) return `next ~${Math.max(1, Math.round(ms / 60_000))}m`;
  if (h < 24) return `next ~${Math.round(h)}h`;
  return `next ~${Math.round(h / 24)}d`;
}

// Persistent-analysis durations (minutes; 0 = open-ended until toggled off).
const ANALYSIS_DURATIONS = [
  { v: 60, l: "1h" },
  { v: 360, l: "6h" },
  { v: 1440, l: "24h" },
  { v: 0, l: "Open-ended" },
];

function downloadFile(name: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
type ExportAnomaly = {
  severity: string; type: string; title: string; name: string | null; mmsi: string | null; imo: string | null;
  latitude: number | null; longitude: number | null; occurredAt: string | null; detectedAt: string; description: string;
};
function anomaliesToCsv(rows: ExportAnomaly[]): string {
  const head = ["severity", "type", "title", "name", "mmsi", "imo", "latitude", "longitude", "occurredAt", "detectedAt", "description"];
  const lines = rows.map((r) =>
    [r.severity, r.type, r.title, r.name, r.mmsi, r.imo, r.latitude, r.longitude, r.occurredAt, r.detectedAt, r.description].map(csvCell).join(",")
  );
  return [head.join(","), ...lines].join("\n");
}

const ANOMALY_LABELS: Record<string, string> = {
  impossible_movement: "Impossible movement",
  colocation: "Co-location stack",
  identity_change: "Identity change",
  identity_conflict: "Identity conflict",
  possible_sts: "Possible STS",
  speed_for_type: "Speed vs type",
  nav_speed_mismatch: "Nav/speed mismatch",
  loitering: "Loitering",
};

// Vessels involved in an anomaly — for single-vessel findings it's just the subject; for
// colocation/STS/identity-conflict the evidence carries several MMSIs. Drives the per-vessel
// snap / enrich / monitor actions in the detail view.
type EventVessel = { mmsi: string | null; name: string | null };
function anomalyVessels(a: Anomaly): EventVessel[] {
  const out: EventVessel[] = [];
  const seen = new Set<string>();
  const add = (mmsi: string | null, name: string | null) => {
    if (mmsi) { if (seen.has(mmsi)) return; seen.add(mmsi); }
    else if (!name) return;
    out.push({ mmsi, name });
  };
  if (a.mmsi) add(a.mmsi, a.name);
  const d = a.details as Record<string, unknown> | null;
  if (d) {
    if (Array.isArray(d.mmsis)) for (const m of d.mmsis) add(String(m), null);
    if (typeof d.mmsiA === "string") add(d.mmsiA, null);
    if (typeof d.mmsiB === "string") add(d.mmsiB, null);
  }
  return out;
}

function cadenceLabel(min: number): string {
  return CADENCE_OPTIONS.find((o) => o.v === min)?.l ?? `${Math.round(min / 60)}h`;
}

function fmtAgo(iso: string | null): string {
  if (!iso) return "never pulled";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const h = ms / 3_600_000;
  if (h < 1) return `pulled ${Math.max(1, Math.round(ms / 60_000))}m ago`;
  if (h < 24) return `pulled ${Math.round(h)}h ago`;
  return `pulled ${Math.round(h / 24)}d ago`;
}

export default function Workspace() {
  const qc = useQueryClient();
  const regions = useQuery({ queryKey: ["regions"], queryFn: getRegions });
  // Viewport-based loading: fetch only vessels in the current map view (refetch on pan/zoom).
  const [viewport, setViewport] = useState<ViewportBbox | null>(null);
  const viewportKey = viewport ? `${viewport.minLat},${viewport.minLon},${viewport.maxLat},${viewport.maxLon}` : "global";

  // Durable UI state — persisted across tab/route changes and reload (see lib/persist).
  const [tool, setTool] = usePersistentState<Tool | null>("tool", null);
  const [aisVisible, setAisVisible] = usePersistentState("aisVisible", true);
  const [tracksOn, setTracksOn] = usePersistentState("tracksOn", false);
  const [placesOn, setPlacesOn] = usePersistentState("placesOn", false);
  // Which intelligence domain's tools the rail shows (D-67). Vessel Intelligence default.
  const [domain, setDomain] = usePersistentState<Domain>("domain", "vessel");
  const [boxMode, setBoxMode] = usePersistentState("boxMode", false);
  const [hidden, setHidden] = usePersistentState<string[]>("hidden", []);
  const [clearedAt, setClearedAt] = usePersistentState<number | null>("clearedAt", null);
  const [selected, setSelected] = usePersistentState<PickedVessel[]>("selected", []);
  const [selectedRegionIds, setSelectedRegionIds] = usePersistentState<string[]>("selectedRegionIds", []);

  // Associations: colour the map by a dimension, filter to one value (server-side, global),
  // group the whole DB by a dimension, and build registry fleets from a group. Declared
  // before the positions query because the filter feeds it.
  const [assocColorBy, setAssocColorBy] = usePersistentState<AssociationDim | "">("assocColorBy", "");
  const [assocFilter, setAssocFilter] = usePersistentState<AssociationFilter | null>("assocFilter", null);
  const [assocGroupBy, setAssocGroupBy] = usePersistentState<AssociationDim>("assocGroupBy", "owner");
  const [fleetTarget, setFleetTarget] = useState<string>("new");
  const [fleetMsg, setFleetMsg] = useState<string | null>(null);

  // Vessel positions for the current viewport. Regions you've "shown on map" (selected)
  // also display their stored HISTORIC positions even when collection is off. When an
  // association filter is active we drop the viewport so the whole matching set shows globally.
  const filterKey = assocFilter ? `${assocFilter.dim}=${assocFilter.value}` : "";
  const positions = useQuery({
    queryKey: ["positions", assocFilter ? "filtered" : viewportKey, selectedRegionIds, filterKey],
    queryFn: () => getPositions(assocFilter ? null : viewport, selectedRegionIds, assocFilter),
    refetchInterval: 20000,
  });

  // Transient interaction/operation state — intentionally NOT persisted.
  const [areaPickMode, setAreaPickMode] = useState(false);
  const [pullState, setPullState] = useState<Record<string, string>>({});
  const [footprintRegionId, setFootprintRegionId] = useState<string | null>(null);
  // Footprint-path drawing: click waypoints along a corridor → satellite tiles follow it.
  const [pathMode, setPathMode] = useState(false);
  const [pathRegionId, setPathRegionId] = useState<string | null>(null);
  const [pathVerts, setPathVerts] = useState<[number, number][]>([]);
  const [pathBusy, setPathBusy] = useState(false);

  // Custom-region drawing (transient): drag a box of any size → name + colour → save.
  // The region is one box; the satellite pull auto-tiles it (bounded by the credit cap).
  const [drawBoxMode, setDrawBoxMode] = useState(false);
  const [drawForm, setDrawForm] = useState(false); // box drawn → naming/colour step
  const [drawBox, setDrawBox] = useState<Bbox | null>(null);
  const [newRegionName, setNewRegionName] = useState("");
  const [newRegionColor, setNewRegionColor] = useState(REGION_PALETTE[0]);
  const [savingRegion, setSavingRegion] = useState(false);
  const [drawErr, setDrawErr] = useState<string | null>(null);

  function startDrawRegion() {
    setBoxMode(false);
    setAreaPickMode(false);
    setTool(null);
    setDrawBox(null);
    setDrawForm(false);
    setDrawErr(null);
    setNewRegionName("");
    setNewRegionColor(REGION_PALETTE[0]);
    setDrawBoxMode(true);
  }
  function cancelDrawRegion() {
    setDrawBoxMode(false);
    setDrawForm(false);
    setDrawBox(null);
    setDrawErr(null);
  }
  // Receive a dragged rectangle of any size → name/colour step. The region stays one box;
  // satellite collection auto-tiles it (bounded + costed by the satellite tile cap).
  function handleBoxDrawn(bbox: Bbox) {
    setDrawBox(bbox);
    setDrawBoxMode(false);
    setDrawForm(true);
  }
  // The box as a polygon ring ([[lng,lat], ...]) for the create call + preview rendering.
  const boxRing: [number, number][] | null = drawBox
    ? [[drawBox.minLon, drawBox.minLat], [drawBox.maxLon, drawBox.minLat], [drawBox.maxLon, drawBox.maxLat], [drawBox.minLon, drawBox.maxLat]]
    : null;
  async function saveCustomRegion() {
    if (!boxRing || !newRegionName.trim()) return;
    setSavingRegion(true);
    setDrawErr(null);
    try {
      const res = await createRegion({ name: newRegionName.trim(), color: newRegionColor, polygon: boxRing });
      if (res.status !== "ok" || !res.region) throw new Error(res.error || "could not save region");
      await qc.invalidateQueries({ queryKey: ["regions"] });
      setSelectedRegionIds((prev) => [...prev, res.region!.id]); // show it immediately
      cancelDrawRegion();
    } catch (e) {
      setDrawErr((e as Error).message);
    } finally {
      setSavingRegion(false);
    }
  }
  // Enable/disable the Data Docked satellite supplement, with a credit-cost confirm on
  // enable (tiled coverage means a large region can spend many credits per pull).
  async function setSat(r: Region, checked: boolean) {
    if (checked && r.boundingBox) {
      const est = estimateSatTiles(r.boundingBox);
      if (est.total > 1) {
        const credits = est.tiles * SAT_CREDITS_PER_TILE;
        const msg =
          `Satellite (Data Docked) for "${r.name}" will pull ~${est.tiles} tile${est.tiles === 1 ? "" : "s"} ` +
          `≈ ${credits} credits per pull (and again on its cadence).` +
          (est.capped ? ` This region is large — only ${est.tiles} of ${est.total} tiles are covered; draw a smaller region (or raise SAT_TILE_MAX) for full coverage.` : "") +
          `\n\nEnable satellite collection?`;
        if (!confirm(msg)) return;
      }
    }
    await setRegionCollection(r.id, { collectAisSatellite: checked });
    qc.invalidateQueries({ queryKey: ["regions"] });
  }

  // Footprint-path drawing (D-63): trace the corridor; the satellite tiles follow it.
  function startDefineFootprint(regionId: string) {
    setRegionModalId(null);
    setBoxMode(false);
    setAreaPickMode(false);
    setPathRegionId(regionId);
    setPathVerts([]);
    setFootprintRegionId(regionId); // show the footprint overlay while drawing
    setPathMode(true);
  }
  function cancelPath() {
    setPathMode(false);
    setPathVerts([]);
    setPathRegionId(null);
  }
  async function finishFootprint() {
    if (!pathRegionId || pathVerts.length < 2) return;
    setPathBusy(true);
    try {
      await setRegionCollection(pathRegionId, { footprintPath: pathVerts });
      await qc.invalidateQueries({ queryKey: ["regions"] });
      cancelPath();
    } catch { /* keep drawing on error */ } finally { setPathBusy(false); }
  }
  async function clearFootprint(regionId: string) {
    await setRegionCollection(regionId, { footprintPath: null });
    await qc.invalidateQueries({ queryKey: ["regions"] });
  }

  async function doDeleteRegion(id: string, name: string) {
    if (!confirm(`Delete custom region "${name}"? Its collected positions are kept but lose the region tag.`)) return;
    try {
      await deleteRegion(id);
      setSelectedRegionIds((prev) => prev.filter((x) => x !== id));
      setRegionModalId(null);
      await qc.invalidateQueries({ queryKey: ["regions"] });
    } catch (e) {
      setPullState((s) => ({ ...s, [id]: `error: ${(e as Error).message}` }));
    }
  }

  // Track for the single selected vessel (only when the Tracks layer is on).
  const trackMmsi = selected.length === 1 ? selected[0].mmsi : null;
  const track = useQuery({
    queryKey: ["track", trackMmsi],
    queryFn: () => getVesselTrack(trackMmsi as string),
    enabled: tracksOn && !!trackMmsi,
    refetchInterval: 30000,
  });
  const trackCoords = useMemo<[number, number][] | null>(() => {
    if (!tracksOn || !track.data?.points) return null;
    return track.data.points
      .filter((p) => Number.isFinite(p.longitude) && Number.isFinite(p.latitude))
      .map((p) => [p.longitude, p.latitude] as [number, number]);
  }, [tracksOn, track.data]);

  // Per-vessel Data Docked enrichment (user-triggered — spends credits).
  const [enrichMmsi, setEnrichMmsi] = useState<string | null>(null);
  const enrich = useQuery({
    queryKey: ["enrich", enrichMmsi],
    queryFn: () => enrichVessel(enrichMmsi as string),
    enabled: !!enrichMmsi,
    staleTime: 6 * 60 * 60_000,
  });

  // GNSS interference (ADS-B) layer.
  const [gnssOn, setGnssOn] = usePersistentState("gnssOn", false);
  const gnss = useQuery({ queryKey: ["gnss"], queryFn: getGnssInterference, enabled: gnssOn, refetchInterval: 120000 });
  const gnssCells = useMemo(
    () =>
      gnssOn
        ? (gnss.data?.cells ?? []).map((c) => ({
            polygon: c.polygon,
            region: c.region ?? "",
            cellId: c.cellId,
            severityPct: c.severityPct,
            severityColor: c.severityColor,
            confidence: c.confidence,
            distinctAircraft: c.distinctAircraft,
            dropEvents: c.dropEvents,
          }))
        : null,
    [gnssOn, gnss.data]
  );

  // Banned / sanctioned vessels layer (ban-list ∩ our DB). Port history is fetched on demand
  // when a red dot is clicked (spends credits).
  const [bannedOn, setBannedOn] = usePersistentState("bannedOn", false);
  const banned = useQuery({ queryKey: ["banned"], queryFn: getBannedVessels, enabled: bannedOn, refetchInterval: 120000 });
  const bannedList = useMemo(() => (bannedOn ? banned.data?.vessels ?? [] : []), [bannedOn, banned.data]);
  const [bannedPortMmsi, setBannedPortMmsi] = useState<string | null>(null);
  const [showUnlocated, setShowUnlocated] = useState(false);

  // Monitored / registry vessels layer — colored points (vessel colour → fleet colour → default).
  const [monitoredOn, setMonitoredOn] = usePersistentState("monitoredOn", false);
  const monitoredQ = useQuery({ queryKey: ["registryMap"], queryFn: getRegistryMap, enabled: monitoredOn, refetchInterval: 120000 });
  const monitoredPoints = useMemo(() => (monitoredOn ? monitoredQ.data?.points ?? [] : []), [monitoredOn, monitoredQ.data]);
  const bannedPortsQ = useQuery({
    queryKey: ["bannedPorts", bannedPortMmsi],
    queryFn: () => getVesselPortCalls(bannedPortMmsi as string),
    enabled: !!bannedPortMmsi,
  });
  const bannedPorts = useMemo(
    () =>
      bannedPortMmsi
        ? {
            mmsi: bannedPortMmsi,
            loading: bannedPortsQ.isLoading,
            error: bannedPortsQ.data?.error ?? (bannedPortsQ.isError ? "request failed" : null),
            records: bannedPortsQ.data?.records ?? [],
          }
        : null,
    [bannedPortMmsi, bannedPortsQ.isLoading, bannedPortsQ.isError, bannedPortsQ.data]
  );

  // Dark-shipping / AIS-gap indicators (opt-in layer).
  const [gapsOn, setGapsOn] = usePersistentState("gapsOn", false);
  const [verifySat, setVerifySat] = usePersistentState("verifySat", false);
  const gaps = useQuery({
    queryKey: ["ais-gaps", verifySat],
    queryFn: () => getAisGaps(30, verifySat),
    enabled: gapsOn,
    refetchInterval: 60000,
  });
  const gapList = gapsOn ? gaps.data?.gaps ?? null : null;
  const confirmedCount = gapList?.filter((g) => g.tier === "confirmed").length ?? 0;

  // Imperative map fly-to (snap to a vessel chosen from a list). Bump the key each time.
  const [flyTo, setFlyTo] = useState<FlyTo>(null);
  const flyKeyRef = useRef(0);
  const snapTo = (lng: number, lat: number, zoom?: number) => {
    flyKeyRef.current += 1;
    setFlyTo({ lng, lat, zoom, key: flyKeyRef.current });
  };
  // Snap to a vessel by its latest stored position; fall back to a given coordinate.
  async function snapToVessel(mmsi: string | null, fallbackLat?: number | null, fallbackLon?: number | null) {
    if (mmsi) {
      try {
        const r = await getLatestPosition(mmsi);
        if (r.position) { snapTo(r.position.longitude, r.position.latitude, 11); return; }
      } catch { /* fall through to fallback */ }
    }
    if (fallbackLat != null && fallbackLon != null) snapTo(fallbackLon, fallbackLat, 11);
  }

  // Cross-page snap: the Registry's "Show on map" navigates here with a fly target.
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const st = location.state as { flyMmsi?: string; flyLat?: number; flyLon?: number } | null;
    if (st && (st.flyMmsi || (st.flyLat != null && st.flyLon != null))) {
      void snapToVessel(st.flyMmsi ?? null, st.flyLat ?? null, st.flyLon ?? null);
      window.history.replaceState({}, ""); // consume so it doesn't refire on back/refresh
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);

  // Vessel anomalies / pattern analysis — region-scoped + operator-controlled (D-62).
  const [selectedAnomalyId, setSelectedAnomalyId] = useState<string | null>(null);
  const [anomalyFilter, setAnomalyFilter] = useState<string | null>(null);
  const [analysisRegionIds, setAnalysisRegionIds] = usePersistentState<string[]>("analysisRegionIds", []);
  const [analysisDuration, setAnalysisDuration] = useState<number>(360);
  const [snapshotName, setSnapshotName] = useState("");
  const [analysisBusy, setAnalysisBusy] = useState<string | null>(null);
  const [analysisMsg, setAnalysisMsg] = useState<string | null>(null);
  const [viewingSnapshotId, setViewingSnapshotId] = useState<string | null>(null);
  const scopeIds = analysisRegionIds.length ? analysisRegionIds : undefined;
  const anomalies = useQuery({ queryKey: ["anomalies", analysisRegionIds], queryFn: () => getAnomalies({ regionIds: scopeIds }), refetchInterval: 120000 });
  const snapshots = useQuery({ queryKey: ["anomaly-snapshots"], queryFn: getAnalysisSnapshots, enabled: tool === "analysis" });
  const viewingSnapshot = useQuery({ queryKey: ["anomaly-snapshot", viewingSnapshotId], queryFn: () => getAnalysisSnapshot(viewingSnapshotId as string), enabled: !!viewingSnapshotId });
  const liveAnomalies = anomalies.data?.anomalies ?? [];

  // Collection & activity — fetched only while the Activity tab is open (on-demand).
  const runs = useQuery({ queryKey: ["ingestionRuns", "activity"], queryFn: () => getIngestionRuns(100), enabled: tool === "activity", refetchInterval: 30000 });
  // When viewing a saved snapshot, show its frozen findings; otherwise the live scan.
  const anomalyList = viewingSnapshotId ? viewingSnapshot.data?.snapshot.findings ?? [] : liveAnomalies;
  const shownAnomalies = anomalyFilter ? anomalyList.filter((a) => a.severity === anomalyFilter) : anomalyList;
  const selectedAnomaly = anomalyList.find((a) => a.id === selectedAnomalyId) ?? null;

  async function withAnalysisBusy(key: string, fn: () => Promise<void>, okMsg?: string) {
    setAnalysisBusy(key);
    setAnalysisMsg(null);
    try { await fn(); if (okMsg) setAnalysisMsg(okMsg); }
    catch (e) { setAnalysisMsg(`Error: ${(e as Error).message}`); }
    finally { setAnalysisBusy(null); }
  }
  const runOnce = () => withAnalysisBusy("run", async () => {
    const res = await runAnomalyAnalysis(analysisRegionIds);
    if (res.status !== "ok") throw new Error(res.error || "scan failed");
    await qc.invalidateQueries({ queryKey: ["anomalies"] });
    setAnalysisMsg(`Scan complete — ${res.found ?? 0} findings across ${res.regions ?? 0} region(s).`);
  });
  const startPersistent = () => withAnalysisBusy("start", async () => {
    for (const id of analysisRegionIds) await setRegionCollection(id, { analyze: true, analyzeDurationMinutes: analysisDuration || null });
    await qc.invalidateQueries({ queryKey: ["regions"] });
    await runAnomalyAnalysis(analysisRegionIds);
    await qc.invalidateQueries({ queryKey: ["anomalies"] });
  }, "Persistent analysis started.");
  const stopPersistent = (ids: string[]) => withAnalysisBusy("stop", async () => {
    for (const id of ids) await setRegionCollection(id, { analyze: false });
    await qc.invalidateQueries({ queryKey: ["regions"] });
  }, "Persistent analysis stopped.");
  const doClear = (ids?: string[]) => withAnalysisBusy(ids ? "clear-sel" : "clear-all", async () => {
    await clearAnomalies(ids);
    setSelectedAnomalyId(null);
    await qc.invalidateQueries({ queryKey: ["anomalies"] });
  }, "Records cleared.");
  const doSaveSnapshot = () => withAnalysisBusy("save", async () => {
    const res = await saveAnalysisSnapshot(snapshotName.trim(), scopeIds);
    if (res.status !== "ok") throw new Error(res.error || "save failed");
    setSnapshotName("");
    await qc.invalidateQueries({ queryKey: ["anomaly-snapshots"] });
  }, "Snapshot saved.");
  function exportFindings(format: "csv" | "json") {
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    if (format === "json") downloadFile(`anomalies-${ts}.json`, JSON.stringify(anomalyList, null, 2), "application/json");
    else downloadFile(`anomalies-${ts}.csv`, anomaliesToCsv(anomalyList as unknown as ExportAnomaly[]), "text/csv");
  }
  function toggleAnalysisRegion(id: string) {
    setAnalysisRegionIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  // Area search — center + radius persist; the rest is transient.
  const [center, setCenter] = usePersistentState<{ lng: number; lat: number } | null>("areaCenter", null);
  const [radiusKm, setRadiusKm] = usePersistentState("areaRadiusKm", 50);
  const [searching, setSearching] = useState(false);
  const [result, setResult] = useState<AreaSearchResult | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportType, setReportType] = useState(REPORT_TYPES[0]);
  const [generated, setGenerated] = useState<string | null>(null);

  const allVessels = positions.data?.vessels ?? [];
  // "Clear map" wipes the view: only points pulled AFTER the clear reappear.
  const displayed = useMemo(
    () =>
      allVessels.filter((v) => {
        if (hidden.includes(v.mmsi ?? "")) return false;
        if (clearedAt && v.ingestedAt && Date.parse(v.ingestedAt) <= clearedAt) return false;
        return true;
      }),
    [allVessels, hidden, clearedAt]
  );

  // Colour-by: assign the top distinct values of the chosen dimension a palette colour
  // (rest → grey), build a legend, and stamp each displayed vessel with its colour.
  const assocColoring = useMemo(() => {
    if (!assocColorBy) return { legend: [] as { value: string; color: string; count: number }[], hasOther: false, colorFor: (_v: VesselPosition) => undefined as string | undefined };
    const counts = new Map<string, number>();
    for (const v of displayed) { const k = dimValue(v, assocColorBy); counts.set(k, (counts.get(k) ?? 0) + 1); }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const colorByVal = new Map<string, string>();
    sorted.slice(0, ASSOC_PALETTE.length).forEach(([val], i) => colorByVal.set(val, ASSOC_PALETTE[i]));
    const hasOther = sorted.length > ASSOC_PALETTE.length;
    const legend = [...colorByVal.entries()].map(([value, color]) => ({ value, color, count: counts.get(value) ?? 0 }));
    return { legend, hasOther, colorFor: (v: VesselPosition) => colorByVal.get(dimValue(v, assocColorBy)) ?? (hasOther ? "#6b7280" : undefined) };
  }, [assocColorBy, displayed]);
  const coloredDisplayed = useMemo(
    () => (assocColorBy ? displayed.map((v) => ({ ...v, color: assocColoring.colorFor(v) })) : displayed),
    [displayed, assocColorBy, assocColoring]
  );

  // Whole-DB association groups for the panel + registry fleets for the "add to fleet" target.
  const assoc = useQuery({ queryKey: ["assoc", assocGroupBy], queryFn: () => getAssociations(assocGroupBy), enabled: tool === "assoc" });
  const monitorGroups = useQuery({ queryKey: ["monitorGroups"], queryFn: getMonitorGroups, enabled: tool === "assoc" });
  async function addToFleet(g: AssociationGroup) {
    setFleetMsg(null);
    try {
      const res = await fleetFromAssociation({
        groupId: fleetTarget === "new" ? undefined : fleetTarget,
        by: assocGroupBy,
        value: g.value,
      });
      if (res.status !== "ok") { setFleetMsg(`Error: ${res.error}`); return; }
      setFleetMsg(`Added ${res.added ?? 0} vessel${res.added === 1 ? "" : "s"} to “${res.group?.name}”.`);
      qc.invalidateQueries({ queryKey: ["monitorGroups"] });
    } catch (e) {
      setFleetMsg(`Error: ${(e as Error).message}`);
    }
  }

  // Split the canonical region list: coverage boxes (collected) vs POI labels.
  const allRegions = regions.data?.regions ?? [];
  const activeRegions = useMemo(() => allRegions.filter((r) => r.status === "active"), [allRegions]);
  const coverageRegions = useMemo(() => activeRegions.filter((r) => r.kind !== "poi"), [activeRegions]);
  const analyzingRegions = useMemo(() => coverageRegions.filter((r) => r.analyze), [coverageRegions]);
  const poiRegions = useMemo(() => activeRegions.filter((r) => r.kind === "poi"), [activeRegions]);
  const regionCount = coverageRegions.length;

  // All coverage regions with a bbox → interactive polygons on the map (hover/click);
  // selected ones render green (styling handled in MapView via selectedRegionIds).
  const regionShapes = useMemo(
    () => coverageRegions.filter((r) => r.boundingBox).map((r) => ({ id: r.id, name: r.name, bbox: r.boundingBox!, polygon: r.polygon, color: r.color })),
    [coverageRegions]
  );
  // Region options modal opened by clicking a region on the map.
  const [regionModalId, setRegionModalId] = useState<string | null>(null);
  const regionModalRegion = coverageRegions.find((r) => r.id === regionModalId) ?? null;
  // Collection-footprint overlay: bbox + satellite tiles for the region being inspected.
  const footprintRegion = coverageRegions.find((r) => r.id === footprintRegionId) ?? null;
  const footprint: Footprint = (() => {
    const fr = footprintRegion;
    if (!fr || !fr.boundingBox) return null;
    const drawing = pathMode && pathRegionId === fr.id && pathVerts.length >= 1;
    const savedPath = fr.footprintPath && fr.footprintPath.length >= 1 ? fr.footprintPath : null;
    const path: number[][] | null = drawing ? pathVerts : savedPath;
    const tiles = path ? pathTileCenters(path) : satTileCenters(fr.boundingBox);
    return { bbox: fr.boundingBox, tiles, path };
  })();
  // POI labels (only when the Places layer is on).
  const pois = useMemo(
    () =>
      placesOn
        ? poiRegions.filter((r) => r.center).map((r) => ({ id: r.id, name: r.name, type: r.type, lng: r.center!.lon, lat: r.center!.lat }))
        : null,
    [placesOn, poiRegions]
  );
  function toggleRegionSelect(id: string) {
    setSelectedRegionIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function hideVessels(vessels: PickedVessel[]) {
    setHidden((prev) => {
      const add = vessels.map((v) => v.mmsi).filter((m): m is string => !!m);
      return Array.from(new Set([...prev, ...add]));
    });
    setSelected([]);
  }
  const clearMap = () => { setClearedAt(Date.now()); setSelected([]); };
  const resetHidden = () => { setHidden([]); setClearedAt(null); setSelected([]); };

  async function doPull(id: string) {
    setPullState((s) => ({ ...s, [id]: "starting" }));
    try {
      await pullRegion(id);
      setPullState((s) => ({ ...s, [id]: "pulling" }));
      // The snapshot takes ~3 min; refresh positions + region times once it should be done.
      setTimeout(() => {
        qc.invalidateQueries({ queryKey: ["positions"] });
        qc.invalidateQueries({ queryKey: ["regions"] });
        setPullState((s) => ({ ...s, [id]: "done" }));
      }, 200_000);
    } catch (e) {
      setPullState((s) => ({ ...s, [id]: `error: ${(e as Error).message}` }));
    }
  }

  async function runSearch() {
    if (!center) return;
    setSearching(true);
    setGenerated(null);
    try {
      const res = await searchArea(center.lat, center.lng, radiusKm);
      setResult(res);
      await qc.invalidateQueries({ queryKey: ["positions"] });
      setReportOpen(true);
    } catch (e) {
      setResult({ status: "error", error: (e as Error).message });
      setReportOpen(true);
    } finally {
      setSearching(false);
    }
  }

  // Tools grouped by intelligence domain (D-67). The domain rail picks which set shows;
  // platform tools (Regions/Map/Activity) serve every domain and always show.
  type ToolDef = { key: Tool; label: string; badge?: number };
  const DOMAIN_TOOLS: Record<Domain, ToolDef[]> = {
    vessel: [
      { key: "vlayers", label: "Layers" },
      { key: "vessels", label: "Vessels", badge: displayed.length },
      { key: "area", label: "Area Search" },
      { key: "gaps", label: "AIS Gaps", badge: gapsOn ? gapList?.length ?? 0 : undefined },
      { key: "analysis", label: "Vessel Analysis", badge: anomalyList.length || undefined },
      { key: "assoc", label: "Associations" },
    ],
    gnss: [
      { key: "gnss", label: "Interference" },
    ],
  };
  const PLATFORM_TOOLS: ToolDef[] = [
    { key: "regions", label: "Regions", badge: regionCount },
    { key: "map", label: "Map" },
    { key: "activity", label: "Activity" },
  ];
  const renderToolChip = (t: ToolDef) => (
    <button
      key={t.key}
      onClick={() => setTool(tool === t.key ? null : t.key)}
      className={`rounded px-2.5 py-1 ${tool === t.key ? "bg-sky-500/20 text-sky-300" : "text-gray-300 hover:bg-white/10"}`}
    >
      {t.label}
      {t.badge !== undefined && <span className="ml-1 font-mono text-gray-500">{t.badge}</span>}
    </button>
  );

  return (
    <div className="relative h-full w-full">
      <MapView
        vessels={coloredDisplayed}
        selection={center ? { lng: center.lng, lat: center.lat, radiusKm } : null}
        track={trackCoords}
        gaps={gapList}
        gnss={gnssCells}
        regions={regionShapes}
        selectedRegionIds={selectedRegionIds}
        onRegionClick={(id) => { setRegionModalId(id); setTool(null); }}
        pois={pois}
        onPoiClick={(p) => { setCenter({ lng: p.lng, lat: p.lat }); setRadiusKm(50); setTool("area"); }}
        onMapClick={(lng, lat) => { if (areaPickMode) { setCenter({ lng, lat }); setAreaPickMode(false); } }}
        onViewportChange={setViewport}
        aisVisible={aisVisible}
        boxSelectMode={boxMode}
        pickMode={areaPickMode}
        onVesselClick={(v) => { setSelected([v]); setTool("vessels"); }}
        onBoxSelect={(vs) => { setSelected(vs); setTool("vessels"); }}
        flyTo={flyTo}
        drawBoxMode={drawBoxMode}
        drawVertices={drawForm ? boxRing : null}
        onBoxDrawn={handleBoxDrawn}
        footprint={footprint}
        pathMode={pathMode}
        pathVertices={pathMode ? pathVerts : null}
        onPathPoint={(lng, lat) => setPathVerts((v) => [...v, [lng, lat] as [number, number]])}
        banned={bannedList}
        monitored={monitoredPoints}
        bannedPorts={bannedPorts}
        onBannedClick={(mmsi) => setBannedPortMmsi(mmsi)}
        onMonitorBanned={(v: BannedVessel) => {
          // Banned vessels are added WITHOUT auto-enrich (operator gate) — enrich later in the registry.
          void addMonitoredVessel({
            mmsi: v.mmsi, imo: v.imo, name: v.name, vesselType: v.type, flag: v.flag,
            lastLatitude: v.latitude, lastLongitude: v.longitude, enrich: false,
          }).then(() => { qc.invalidateQueries({ queryKey: ["monitor-groups"] }); qc.invalidateQueries({ queryKey: ["monitored-vessels"] }); }).catch(() => {});
        }}
      />

      {/* Domain rail + grouped tools */}
      <div className="absolute left-3 top-3 z-20 flex max-w-[calc(100%-1.5rem)] flex-col gap-1 rounded-lg border border-white/10 bg-black/60 p-1 text-xs backdrop-blur">
        {/* Intelligence-domain rail */}
        <div className="flex flex-wrap items-center gap-1">
          <span className="px-1 text-[9px] font-semibold uppercase tracking-wider text-gray-500">Domain</span>
          {DOMAINS.map((d) => (
            <button
              key={d.key}
              disabled={d.stub}
              onClick={() => { setDomain(d.key as Domain); setTool(null); }}
              title={d.stub ? "Coming soon" : undefined}
              className={`rounded px-2.5 py-1 ${d.stub ? "cursor-not-allowed text-gray-600" : domain === d.key ? "bg-sky-500/30 font-medium text-sky-200" : "text-gray-300 hover:bg-white/10"}`}
            >
              {d.label}{d.stub && " +"}
            </button>
          ))}
        </div>
        {/* Active domain's tools + platform tools */}
        <div className="flex flex-wrap items-center gap-1 border-t border-white/10 pt-1">
          {DOMAIN_TOOLS[domain].map(renderToolChip)}
          <span className="mx-1 h-4 w-px self-center bg-white/15" />
          {PLATFORM_TOOLS.map(renderToolChip)}
        </div>
      </div>

      {/* Custom-region draw panel (floating) */}
      {(drawBoxMode || drawForm) && (
        <div className="absolute bottom-4 left-1/2 z-30 w-80 -translate-x-1/2 rounded-lg border border-sky-500/30 bg-black/80 p-3 text-xs backdrop-blur">
          {!drawForm ? (
            <>
              <div className="font-medium text-sky-300">Draw a custom region</div>
              <p className="mt-1 text-gray-400">Click and drag a rectangle on the map — any size. It's one region; satellite collection auto-tiles it in the background (cost shown next).</p>
              <div className="mt-2 flex gap-1.5">
                <button onClick={cancelDrawRegion} className="ml-auto rounded border border-white/10 px-2 py-1 hover:bg-white/10">Cancel</button>
              </div>
            </>
          ) : (
            <>
              <div className="font-medium text-sky-300">Name &amp; colour</div>
              <input value={newRegionName} onChange={(e) => setNewRegionName(e.target.value)} autoFocus placeholder="Region name"
                className="mt-2 w-full rounded bg-black/30 px-2 py-1 ring-1 ring-white/10 placeholder:text-gray-600" />
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {REGION_PALETTE.map((c) => (
                  <button key={c} onClick={() => setNewRegionColor(c)} title={c}
                    className={`h-6 w-6 rounded ${newRegionColor === c ? "ring-2 ring-white" : "ring-1 ring-white/20"}`}
                    style={{ backgroundColor: c }} />
                ))}
                <input type="color" value={newRegionColor} onChange={(e) => setNewRegionColor(e.target.value)}
                  className="h-6 w-8 cursor-pointer rounded bg-transparent" title="Custom colour" />
              </div>
              {drawBox && <p className="mt-2 text-[10px] text-gray-500">{(() => { const e = estimateSatTiles(drawBox); return `One region; satellite auto-tiles it into ${e.tiles}${e.capped ? ` of ${e.total}` : ""} cell${e.tiles === 1 ? "" : "s"} ≈ ${e.tiles * SAT_CREDITS_PER_TILE} credits/pull${e.capped ? " (covers part — tighten the box or raise SAT_TILE_MAX_TILES for full coverage)" : ""}. Turn on AIS / Sat in the Regions tab once saved.`; })()}</p>}
              {drawErr && <p className="mt-1 text-amber-400">{drawErr}</p>}
              <div className="mt-2 flex gap-1.5">
                <button onClick={() => { setDrawForm(false); setDrawBox(null); setDrawBoxMode(true); }} className="rounded border border-white/10 px-2 py-1 hover:bg-white/10">↻ Redraw</button>
                <button onClick={saveCustomRegion} disabled={savingRegion || !newRegionName.trim()}
                  className="rounded bg-emerald-600 px-2 py-1 font-medium text-white hover:bg-emerald-500 disabled:opacity-50">{savingRegion ? "Saving…" : "Save region"}</button>
                <button onClick={cancelDrawRegion} className="ml-auto rounded border border-white/10 px-2 py-1 hover:bg-white/10">Cancel</button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Footprint-path draw panel (floating) */}
      {pathMode && (
        <div className="absolute bottom-4 left-1/2 z-30 w-80 -translate-x-1/2 rounded-lg border border-emerald-500/30 bg-black/80 p-3 text-xs backdrop-blur">
          <div className="font-medium text-emerald-300">Define collection footprint</div>
          <p className="mt-1 text-gray-400">Click along the corridor to add waypoints ({pathVerts.length}). Up to {SAT_TILE_MAX} satellite circles are spaced along this line.</p>
          <div className="mt-2 flex gap-1.5">
            <button onClick={() => setPathVerts((v) => v.slice(0, -1))} disabled={!pathVerts.length}
              className="rounded border border-white/10 px-2 py-1 hover:bg-white/10 disabled:opacity-40">Undo</button>
            <button onClick={finishFootprint} disabled={pathVerts.length < 2 || pathBusy}
              className="rounded bg-emerald-600 px-2 py-1 font-medium text-white hover:bg-emerald-500 disabled:opacity-40">{pathBusy ? "Saving…" : `Save footprint (${pathVerts.length})`}</button>
            <button onClick={cancelPath} className="ml-auto rounded border border-white/10 px-2 py-1 hover:bg-white/10">Cancel</button>
          </div>
        </div>
      )}

      {tool === "vlayers" && (
        <Modal title="Vessel layers" onClose={() => setTool(null)}>
          <label className="flex items-center gap-2 text-gray-300">
            <input type="checkbox" checked={aisVisible} onChange={(e) => setAisVisible(e.target.checked)} />
            AIS (AISStream + Data Docked)
          </label>
          <p className="ml-6 text-[10px] text-gray-500">
            <span className="text-sky-400">●</span> fresh · <span className="text-slate-400">●</span> stale (last fix &gt; 6h)
          </p>
          <label className="mt-2 flex items-center gap-2 text-gray-300">
            <input type="checkbox" checked={tracksOn} onChange={(e) => setTracksOn(e.target.checked)} />
            Tracks <span className="text-[10px] text-gray-500">(select one vessel · last 7d)</span>
          </label>
          <label className="mt-2 flex items-center gap-2 text-gray-300">
            <input type="checkbox" checked={gapsOn} onChange={(e) => setGapsOn(e.target.checked)} />
            Dark shipping / AIS gaps <span className="text-[10px] text-amber-400/70">(indicator only)</span>
          </label>
          {gapsOn && (
            <p className="mt-1 rounded bg-amber-500/10 p-1.5 text-[10px] leading-snug text-amber-300/90">
              AIS Gap / Dark Shipping Indicator — not a confirmed dark-vessel detection. See the AIS Gaps tab for the full caveat.
            </p>
          )}
          <label className="mt-2 flex items-center gap-2 text-gray-300">
            <input type="checkbox" checked={monitoredOn} onChange={(e) => setMonitoredOn(e.target.checked)} />
            Monitored (registry) <span className="text-[10px] text-sky-400/70">(colored by vessel / fleet)</span>
          </label>
          {monitoredOn && (
            <p className="ml-6 text-[10px] text-gray-500">{monitoredPoints.length} monitored vessel{monitoredPoints.length === 1 ? "" : "s"} with a position · set colours in the Vessel Registry</p>
          )}
          <label className="mt-2 flex items-center gap-2 text-gray-300">
            <input type="checkbox" checked={bannedOn} onChange={(e) => setBannedOn(e.target.checked)} />
            Banned vessels <span className="text-[10px] text-red-400/70">(Data Docked ban-list ∩ our DB)</span>
          </label>
          {bannedOn && (
            <div className="ml-6 rounded bg-red-500/10 p-1.5 text-[10px] leading-snug text-red-300/90">
              <div>
                {banned.isLoading ? "Loading banned vessels…"
                  : banned.data?.status === "error" ? `Unavailable: ${banned.data?.error}`
                  : <><span className="font-mono">{bannedList.length}</span> banned vessel{bannedList.length === 1 ? "" : "s"} with a stored position · ban-list size <span className="font-mono">{banned.data?.banListSize ?? "—"}</span></>}
              </div>
              <div className="mt-1 text-gray-400">
                <span className="text-red-400">●</span> blinking = active (last fix ≤ 6h) · <span className="text-red-400/40">●</span> dimmed = historic. Click a dot for details + port history (spends credits).
              </div>
              {banned.data?.status === "ok" && (banned.data?.unlocatedTotal ?? 0) > 0 && (
                <div className="mt-1.5 border-t border-white/10 pt-1.5">
                  <button onClick={() => setShowUnlocated((s) => !s)} className="text-left text-gray-300 hover:text-white">
                    {showUnlocated ? "▾" : "▸"} <span className="font-mono">{banned.data?.unlocatedTotal ?? 0}</span> banned vessel{(banned.data?.unlocatedTotal ?? 0) === 1 ? "" : "s"} in our records with no position
                  </button>
                  {showUnlocated && (
                    <ul className="mt-1 max-h-56 space-y-0.5 overflow-y-auto pr-1">
                      {(banned.data?.unlocated ?? []).map((u, i) => (
                        <li key={i} className="flex items-center justify-between gap-2 rounded bg-white/5 px-1.5 py-1">
                          <span className="truncate text-gray-200" title={u.name ?? u.mmsi ?? u.imo ?? ""}>
                            {u.name ?? "(no name)"}
                            <span className="ml-1 font-mono text-[10px] text-gray-500">{u.mmsi ?? u.imo ?? ""}{u.flag ? ` · ${u.flag}` : ""}</span>
                          </span>
                          <span className="shrink-0 rounded bg-amber-500/20 px-1 text-[9px] text-amber-300">no position</span>
                        </li>
                      ))}
                      {(banned.data?.unlocatedTotal ?? 0) > (banned.data?.unlocated?.length ?? 0) && (
                        <li className="px-1.5 py-1 text-[10px] text-gray-500">+{(banned.data?.unlocatedTotal ?? 0) - (banned.data?.unlocated?.length ?? 0)} more not shown</li>
                      )}
                    </ul>
                  )}
                </div>
              )}
              <div className="mt-0.5 text-red-300/80">Data Docked determination — corroborate with an authoritative sanctions list.</div>
            </div>
          )}
        </Modal>
      )}

      {tool === "gnss" && (
        <Modal title="GNSS / Signals" onClose={() => setTool(null)}>
          <label className="flex items-center gap-2 text-gray-300">
            <input type="checkbox" checked={gnssOn} onChange={(e) => setGnssOn(e.target.checked)} />
            ADS-B / GNSS interference <span className="text-[10px] text-orange-400/70">(indicator only)</span>
          </label>
          {gnssOn && (
            <div className="ml-6 rounded bg-orange-500/10 p-1.5 text-[10px] leading-snug text-orange-300/90">
              <div>0.1° cell heatmap of aircraft reporting degraded nav integrity (NIC), 6h window. Enable <strong>ADS-B</strong> on a region (Regions tab) and pull it.</div>
              <div className="mt-1 text-gray-400">
                severity: <span className="text-green-400">●</span>&lt;2% <span className="text-yellow-400">●</span>2–10% <span className="text-orange-400">●</span>10–25% <span className="text-red-400">●</span>≥25% · opacity = confidence.
              </div>
              <div className="mt-0.5 text-orange-300/80">Not a confirmed jamming/spoofing detection.</div>
            </div>
          )}
          <p className="mt-2 text-[10px] text-gray-600">GNSS interference is aircraft-derived (ADS-B), kept as its own domain (not vessel data). Detection tuning is a known follow-up.</p>
        </Modal>
      )}

      {tool === "map" && (
        <Modal title="Map layers" onClose={() => setTool(null)}>
          <label className="flex items-center gap-2 text-gray-300">
            <input type="checkbox" checked={placesOn} onChange={(e) => setPlacesOn(e.target.checked)} />
            Places <span className="text-[10px] text-gray-500">(chokepoints, straits & ports)</span>
          </label>
          <label className="mt-2 flex items-center gap-2 text-gray-500">
            <input type="checkbox" disabled /> Imagery <span className="text-[10px]">(soon)</span>
          </label>
        </Modal>
      )}

      {tool === "assoc" && (
        <Modal title="Associations" onClose={() => setTool(null)}>
          <p className="rounded bg-sky-500/10 p-1.5 text-[11px] leading-snug text-sky-300/90">
            Group, colour &amp; filter vessels by shared attributes. Owner/Manager/Class come from enrichment (un-enriched vessels show as “(unknown)”); flag/type/status come from AIS.
          </p>

          <div className="mt-2">
            <div className="text-[11px] text-gray-400">Colour map by</div>
            <div className="mt-1 flex flex-wrap gap-1">
              <button onClick={() => setAssocColorBy("")} className={`rounded border px-2 py-0.5 text-[11px] ${!assocColorBy ? "border-sky-400 bg-sky-500/20 text-sky-300" : "border-white/10 hover:bg-white/10"}`}>Off</button>
              {ASSOC_DIMS.map((d) => (
                <button key={d.dim} onClick={() => setAssocColorBy(d.dim)} className={`rounded border px-2 py-0.5 text-[11px] ${assocColorBy === d.dim ? "border-sky-400 bg-sky-500/20 text-sky-300" : "border-white/10 hover:bg-white/10"}`}>{d.label}</button>
              ))}
            </div>
            {assocColorBy && (
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px]">
                {assocColoring.legend.map((l) => (
                  <span key={l.value} className="inline-flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-full" style={{ background: l.color }} />
                    <span className="max-w-[140px] truncate text-gray-300" title={l.value}>{l.value}</span>
                    <span className="text-gray-500">{l.count}</span>
                  </span>
                ))}
                {assocColoring.hasOther && (
                  <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full" style={{ background: "#6b7280" }} /><span className="text-gray-400">other</span></span>
                )}
                {!assocColoring.legend.length && <span className="text-gray-500">No vessels in view to colour.</span>}
              </div>
            )}
          </div>

          {assocFilter && (
            <div className="mt-2 flex items-center justify-between gap-2 rounded bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200">
              <span className="truncate">Filtered: {ASSOC_DIM_LABEL[assocFilter.dim]} = <strong>{assocFilter.value}</strong> · whole DB{positions.data?.truncated ? " (capped 20k)" : ""}</span>
              <button onClick={() => setAssocFilter(null)} className="shrink-0 rounded border border-amber-400/40 px-1.5 hover:bg-amber-500/20">Clear</button>
            </div>
          )}

          <div className="mt-3 border-t border-white/10 pt-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-gray-400">Group by</span>
              <select value={assocGroupBy} onChange={(e) => setAssocGroupBy(e.target.value as AssociationDim)} className="rounded border border-white/10 bg-black/40 px-1.5 py-0.5 text-[11px]">
                {ASSOC_DIMS.map((d) => <option key={d.dim} value={d.dim}>{d.label}</option>)}
              </select>
              {assoc.data?.status === "ok" && <span className="text-[10px] text-gray-500">{assoc.data?.distinct} groups · {assoc.data?.total} vessels</span>}
            </div>

            {(assocGroupBy === "owner" || assocGroupBy === "manager" || assocGroupBy === "class_society") && (
              <p className="mt-1 text-[10px] text-amber-300/80">Owner / manager / class come from <span className="text-gray-300">Data Docked enrichment only</span> — "(unknown)" means a vessel hasn't been enriched yet. Enrich vessels or a fleet in the Vessel Registry to populate these.</p>
            )}
            {assocGroupBy === "flag" && (
              <p className="mt-1 text-[10px] text-gray-500">Flag is derived from the MMSI country code (MID) when AIS/enrichment doesn't provide one.</p>
            )}

            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
              <span className="text-gray-400">Add to fleet</span>
              <select value={fleetTarget} onChange={(e) => setFleetTarget(e.target.value)} className="rounded border border-white/10 bg-black/40 px-1.5 py-0.5">
                <option value="new">New fleet (auto-named)</option>
                {(monitorGroups.data?.groups ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </div>
            {fleetMsg && <p className="mt-1 text-[10px] text-emerald-300/90">{fleetMsg}</p>}

            <ul className="mt-1.5 max-h-72 space-y-0.5 overflow-y-auto pr-1">
              {assoc.isLoading ? <li className="text-[11px] text-gray-400">Loading…</li>
                : assoc.data?.status === "error" ? <li className="text-[11px] text-amber-400">Unavailable: {assoc.data?.error}</li>
                : (assoc.data?.groups ?? []).map((g) => (
                  <li key={g.value} className="flex items-center justify-between gap-2 rounded bg-white/5 px-1.5 py-1 text-[11px]">
                    <span className="truncate text-gray-200" title={g.value}>{g.value} <span className="text-gray-500">· {g.count}</span></span>
                    <span className="flex shrink-0 gap-1">
                      <button onClick={() => setAssocFilter({ dim: assocGroupBy, value: g.value })} className="rounded border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-200 hover:bg-sky-500/20">Filter</button>
                      <button onClick={() => addToFleet(g)} className="rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-200 hover:bg-emerald-500/20">→ Fleet</button>
                    </span>
                  </li>
                ))}
            </ul>
            <p className="mt-1 text-[10px] text-gray-600">“→ Fleet” adds that group’s vessels (those with a position) to the chosen fleet in the Vessel Registry. Owner/manager links are single-source — corroborate before acting.</p>
          </div>
        </Modal>
      )}

      {tool === "vessels" && (
        <Modal title="Vessels" onClose={() => setTool(null)}>
          <div className="text-gray-300">
            Shown <span className="font-mono text-sky-400">{displayed.length}</span>
            <span className="text-gray-500"> / {allVessels.length} in view</span>
          </div>
          {positions.data?.truncated && (
            <p className="mt-1 text-[10px] text-amber-300/80">View capped at 20,000 vessels — zoom in to see all in dense areas.</p>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button
              onClick={() => setBoxMode((b) => !b)}
              className={`rounded border px-2 py-1 ${boxMode ? "border-sky-400 bg-sky-500/20 text-sky-300" : "border-white/10 hover:bg-white/10"}`}
            >
              {boxMode ? "Box select: ON" : "Box select"}
            </button>
            <button onClick={clearMap} className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-amber-200 hover:bg-amber-500/20">Clear map</button>
            <button onClick={resetHidden} className="rounded border border-white/10 px-2 py-1 hover:bg-white/10">Reset</button>
          </div>
          {boxMode && <p className="mt-1 text-[10px] text-sky-300/80">Drag a rectangle on the map to select vessels.</p>}
          {clearedAt && <p className="mt-1 text-[10px] text-amber-300/80">Map cleared — only vessels from new pulls will appear. Reset to restore.</p>}

          <div className="mt-3 border-t border-white/10 pt-2">
            <div className="text-gray-300">Selected: <span className="font-mono text-sky-400">{selected.length}</span></div>
            {tracksOn && trackMmsi && (
              <div className="mt-1 text-[11px] text-cyan-300/80">
                {track.isFetching && !track.data ? "Loading track…"
                  : (track.data?.count ?? 0) >= 2 ? `Track: ${track.data?.count} points (last 7d)`
                  : "Track: not enough history yet for this vessel."}
              </div>
            )}
            {tracksOn && selected.length > 1 && (
              <div className="mt-1 text-[11px] text-gray-500">Select a single vessel to see its track.</div>
            )}
            {selected.length > 0 && (
              <>
                <ul className="mt-1 max-h-28 space-y-0.5 overflow-auto text-gray-400">
                  {selected.slice(0, 8).map((v, i) => <li key={(v.mmsi ?? "") + i}>{v.name || v.mmsi || "unknown"}</li>)}
                  {selected.length > 8 && <li className="text-gray-500">+{selected.length - 8} more</li>}
                </ul>
                <div className="mt-2 space-y-1">
                  {selected.length === 1 && selected[0].mmsi && (
                    <>
                      <button
                        onClick={() => setEnrichMmsi(selected[0].mmsi)}
                        className="w-full rounded bg-sky-600 px-2 py-1 font-medium text-white hover:bg-sky-500"
                      >
                        Enrich (Data Docked)
                      </button>
                      <MonitorButton mmsi={selected[0].mmsi} name={selected[0].name} />
                    </>
                  )}
                  <button onClick={() => hideVessels(selected)} className="w-full rounded bg-amber-600 px-2 py-1 font-medium text-black hover:bg-amber-500">
                    Remove from display
                  </button>
                  <button disabled className="w-full rounded border border-white/10 px-2 py-1 text-gray-500">Report on selected (soon)</button>
                </div>

                {selected.length === 1 && enrichMmsi === selected[0].mmsi && (
                  <div className="mt-2 rounded border border-sky-500/20 bg-sky-500/5 p-2 text-[11px]">
                    {enrich.isLoading ? (
                      <p className="text-gray-400">Fetching particulars from Data Docked…</p>
                    ) : enrich.data?.status === "error" || enrich.isError ? (
                      <p className="text-amber-400">Enrichment failed: {enrich.data?.error ?? (enrich.error as Error)?.message}</p>
                    ) : enrich.data ? (
                      <>
                        <div className="mb-1 flex items-center justify-between">
                          <span className="font-medium text-sky-300">Vessel particulars</span>
                          {enrich.data.creditsSpent != null && (
                            <span className="text-[10px] text-gray-500">{enrich.data.creditsSpent} credit{enrich.data.creditsSpent === 1 ? "" : "s"}</span>
                          )}
                        </div>
                        {Object.keys(enrich.data.curated).length === 0 ? (
                          <p className="text-gray-500">No particulars returned for this vessel.</p>
                        ) : (
                          <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                            {Object.entries(enrich.data.curated).map(([k, v]) => (
                              <div key={k} className="flex justify-between gap-2">
                                <dt className="text-gray-500">{k}</dt>
                                <dd className="truncate text-gray-200" title={String(v)}>{String(v)}</dd>
                              </div>
                            ))}
                          </dl>
                        )}
                        <EnrichExtras data={enrich.data} />
                      </>
                    ) : null}
                  </div>
                )}
              </>
            )}
          </div>
        </Modal>
      )}

      {tool === "area" && (
        <Modal title="Area Search" onClose={() => { setTool(null); setAreaPickMode(false); }}>
          <div className="rounded bg-sky-500/10 p-1.5 text-[11px] leading-snug text-sky-300/90">
            Searches <strong>AIS vessels</strong> within a radius (Data Docked). More data sources will be added to area search over time.
          </div>

          <div className="mt-2 flex flex-wrap gap-1.5">
            <button
              onClick={() => { setBoxMode(false); setAreaPickMode((p) => !p); }}
              className={`rounded border px-2 py-1 ${areaPickMode ? "border-sky-400 bg-sky-500/20 text-sky-300" : "border-white/10 hover:bg-white/10"}`}
            >
              {areaPickMode ? "Picking… click the map" : center ? "Re-pick location" : "Pick location on map"}
            </button>
            {center && (
              <button onClick={() => { setCenter(null); setAreaPickMode(false); }} className="rounded border border-white/10 px-2 py-1 hover:bg-white/10">
                Clear
              </button>
            )}
          </div>
          {areaPickMode && <p className="mt-1 text-[10px] text-sky-300/80">Click anywhere on the map to set the search center.</p>}

          {center ? (
            <>
              <div className="mt-2 text-gray-400">center {center.lat.toFixed(2)}, {center.lng.toFixed(2)}</div>
              <label className="mt-2 block text-gray-400">
                radius: <span className="font-mono text-amber-400">{radiusKm} km</span>
                <input type="range" min={1} max={50} value={radiusKm} onChange={(e) => setRadiusKm(Number(e.target.value))} className="mt-1 w-full" />
              </label>
              <button onClick={runSearch} disabled={searching} className="mt-2 w-full rounded bg-amber-600 px-2 py-1 font-medium text-black hover:bg-amber-500 disabled:opacity-50">
                {searching ? "Searching…" : "Search AIS in this area"}
              </button>
            </>
          ) : (
            <p className="mt-2 text-gray-500">No location set. Use <strong>Pick location on map</strong>, then set a radius (≤50 km) and search.</p>
          )}
        </Modal>
      )}

      {tool === "regions" && (
        <Modal title="Regions" onClose={() => setTool(null)} width="w-[30rem]">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[11px] text-gray-500">Click a name to show it on the map (outline + its stored positions, incl. historic); toggle AIS to collect.</p>
            {selectedRegionIds.length > 0 && (
              <button onClick={() => setSelectedRegionIds([])} className="rounded border border-white/10 px-2 py-0.5 text-[10px] hover:bg-white/10">
                Clear ({selectedRegionIds.length})
              </button>
            )}
          </div>
          <button onClick={startDrawRegion} className="mb-2 w-full rounded border border-sky-500/40 bg-sky-500/10 px-2 py-1.5 text-[12px] text-sky-200 hover:bg-sky-500/20">
            + Add custom region <span className="text-[10px] text-sky-300/70">(drag a box on the map)</span>
          </button>
          <p className="mb-2 text-[10px] text-gray-600">Fill gaps in the baseline regions — drag a box over a port, waterway or coastal area; it then behaves like any region (collect, layers, cadence).</p>
          <div className="max-h-72 space-y-1.5 overflow-auto">
            {coverageRegions.map((r) => {
              const sel = selectedRegionIds.includes(r.id);
              const ps = pullState[r.id];
              const pulling = ps === "starting" || ps === "pulling";
              return (
                <div key={r.id} className={`rounded border px-2 py-1.5 ${sel ? "border-emerald-500/50 bg-emerald-500/5" : "border-white/10"}`}>
                  <div className="flex items-center justify-between gap-2">
                    <button onClick={() => toggleRegionSelect(r.id)} className="min-w-0 flex-1 text-left" title="Show/hide on map">
                      <div className="flex items-center gap-1.5">
                        <span className={`inline-block h-2 w-2 shrink-0 rounded-sm ${sel ? "bg-emerald-400" : "bg-white/15"}`} />
                        <span className={`truncate ${sel ? "text-emerald-200" : "text-gray-200"}`}>{r.name}</span>
                      </div>
                      <div className="ml-3.5 truncate text-[10px] text-gray-500">{r.collectAis ? `${fmtAgo(r.lastAisPullAt)} · every ${cadenceLabel(r.aisPullCadenceMinutes)}` : "collection off"}</div>
                    </button>
                    <button
                      onClick={() => doPull(r.id)}
                      disabled={pulling || !r.boundingBox}
                      className="shrink-0 rounded border border-sky-500/40 bg-sky-500/10 px-2 py-1 text-[11px] text-sky-200 hover:bg-sky-500/20 disabled:opacity-40"
                      title="Pull a fresh AIS snapshot for this region now (~3 min)"
                    >
                      {pulling ? "Pulling…" : "Pull now"}
                    </button>
                    {r.isCustom && (
                      <button onClick={() => doDeleteRegion(r.id, r.name)} title="Delete custom region"
                        className="shrink-0 rounded border border-red-500/30 px-1.5 py-1 text-[11px] text-red-300 hover:bg-red-500/10">✕</button>
                    )}
                  </div>
                  <div className="mt-1.5 flex items-center justify-between">
                    <span className="text-[10px] text-gray-600">{ps === "done" ? "snapshot done" : ps?.startsWith("error") ? ps : pulling ? "snapshot started (~3 min)" : ""}</span>
                    <div className="flex shrink-0 gap-3 text-[11px]">
                      <label className={`flex items-center gap-1 ${r.boundingBox ? "text-gray-300" : "text-gray-600"}`} title="AISStream snapshot collection (free; 24h auto-pull when on)">
                        <input
                          type="checkbox"
                          checked={r.collectAis}
                          disabled={!r.boundingBox}
                          onChange={async (e) => { await setRegionCollection(r.id, { collectAis: e.target.checked }); qc.invalidateQueries({ queryKey: ["regions"] }); }}
                        />
                        AIS
                      </label>
                      <label className={`flex items-center gap-1 ${r.boundingBox ? "text-gray-300" : "text-gray-600"}`} title="Data Docked satellite supplement (spends credits; for terrestrial blind spots)">
                        <input
                          type="checkbox"
                          checked={r.collectAisSatellite}
                          disabled={!r.boundingBox}
                          onChange={(e) => setSat(r, e.target.checked)}
                        />
                        Sat
                      </label>
                      <label className="flex items-center gap-1 text-gray-300" title="ADS-B collection wires up with Slice C">
                        <input
                          type="checkbox"
                          checked={r.collectAdsb}
                          onChange={async (e) => { await setRegionCollection(r.id, { collectAdsb: e.target.checked }); qc.invalidateQueries({ queryKey: ["regions"] }); }}
                        />
                        ADS-B
                      </label>
                    </div>
                  </div>
                </div>
              );
            })}
            {regionCount === 0 && <p className="text-gray-500">{regions.isLoading ? "Loading…" : "No regions."}</p>}
          </div>
          <p className="mt-2 text-[10px] text-gray-600">
            <strong className="text-gray-500">AIS</strong> = AISStream snapshot (free); auto-pulls every 24h when on, or hit <strong className="text-gray-500">Pull now</strong>. <strong className="text-gray-500">Sat</strong> = Data Docked satellite supplement (credits; for blind spots). Selected regions draw a green outline; chokepoints &amp; ports are on the <strong className="text-gray-500">Places</strong> layer. <strong className="text-gray-500">ADS-B</strong> wires up with Slice C.
          </p>
        </Modal>
      )}

      {tool === "gaps" && (
        <Modal title="AIS Gaps / Dark Shipping" onClose={() => setTool(null)} width="w-[30rem]">
          <div className="rounded border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] leading-snug text-amber-200/90">
            <strong className="text-amber-300">AIS Gap / Dark Shipping Indicator — not a confirmed dark-vessel detection.</strong>{" "}
            {gaps.data?.disclaimer ??
              "A gap means no satellite position was collected within the expected revisit window; it may result from satellite revisit gaps, the vessel being outside collected tiles, or equipment faults — not necessarily intentional AIS-off behavior."}
          </div>
          <p className="mt-1 text-[10px] text-gray-500">Satellite-only — terrestrial AIS isn't dependable for gaps. Enable per region in the region options (turn on <span className="text-gray-400">Sat</span> + <span className="text-gray-400">Detect AIS gaps</span>).</p>

          <label className="mt-2 flex items-center gap-2 text-gray-300">
            <input type="checkbox" checked={gapsOn} onChange={(e) => setGapsOn(e.target.checked)} />
            Show indicators on map
          </label>
          <label className={`mt-2 flex items-center gap-2 ${gapsOn ? "text-gray-300" : "text-gray-600"}`}>
            <input type="checkbox" checked={verifySat} disabled={!gapsOn} onChange={(e) => setVerifySat(e.target.checked)} />
            Verify via satellite (Data Docked)
          </label>
          {verifySat && (
            <p className="mt-1 rounded bg-sky-500/10 p-1.5 text-[10px] leading-snug text-sky-300/90">
              Re-checks each gap with a fresh Data Docked bulk lookup to separate revisit gaps from genuine
              dark vessels. Spends Data Docked credits (one bulk call per refresh, cached 30&nbsp;min). Vessels
              with a fresh fix are marked active and reappear on the map.
            </p>
          )}

          {!gapsOn ? (
            <p className="mt-2 text-gray-500">Enable the layer to list satellite gaps in regions where the AIS-gap feature is on.</p>
          ) : gaps.isLoading ? (
            <p className="mt-2 text-gray-500">Scanning…</p>
          ) : (gapList?.length ?? 0) === 0 ? (
            <p className="mt-2 text-gray-500">No satellite gaps in gap-enabled regions right now.</p>
          ) : (
            <>
              <div className="mt-2 text-gray-400">
                <span className="font-mono text-amber-400">{gapList?.length}</span> gap{gapList?.length === 1 ? "" : "s"} (≥{gaps.data?.gapMinutes ?? 30} min)
                {verifySat && confirmedCount > 0 && (
                  <span className="ml-2 text-red-300">· <span className="font-mono">{confirmedCount}</span> satellite-confirmed</span>
                )}
              </div>
              <ul className="mt-1 max-h-64 space-y-1 overflow-auto">
                {gapList?.map((g, i) => {
                  const tierStyle =
                    g.tier === "confirmed" ? "bg-red-500/20 text-red-300"
                      : g.tier === "active" ? "bg-emerald-500/20 text-emerald-300"
                      : g.tier === "pending" || g.tier === "unverified" ? "bg-slate-500/20 text-slate-300"
                      : g.confidence === "low" ? "bg-yellow-700/20 text-yellow-600" : "bg-amber-500/20 text-amber-300";
                  const tierLabel =
                    g.tier === "confirmed" ? "confirmed"
                      : g.tier === "active" ? "active"
                      : g.tier === "pending" ? "checking…"
                      : g.tier === "unverified" ? "unverified"
                      : "terrestrial";
                  return (
                    <li key={(g.mmsi ?? "") + i} className="rounded border border-white/10 px-2 py-1.5 text-[11px]">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-gray-200">{g.name || g.mmsi || "unknown"}</div>
                          <div className="text-[10px] text-gray-500">{g.region ?? "—"} · last AIS {g.minutesAgo}m ago</div>
                        </div>
                        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${tierStyle}`}>{tierLabel}</span>
                      </div>
                      {g.verification?.note && <div className="mt-0.5 text-[10px] text-gray-500">{g.verification.note}</div>}
                    </li>
                  );
                })}
              </ul>
              {gaps.data?.satelliteNote && (
                <p className="mt-2 text-[10px] leading-snug text-gray-600">{gaps.data.satelliteNote}</p>
              )}
            </>
          )}
        </Modal>
      )}

      {tool === "analysis" && (
        <Modal title="Vessel Analysis & Anomalies" onClose={() => { setTool(null); setSelectedAnomalyId(null); }} width="w-[34rem]">
          <div className="rounded border border-white/10 bg-white/5 p-2 text-[10px] leading-snug text-gray-400">
            {anomalies.data?.disclaimer ?? "Automated, display-only indicators derived from AIS patterns — not confirmed findings. Corroborate before acting."}
          </div>

          {selectedAnomaly ? (
            <div className="mt-2 text-[12px]">
              <button onClick={() => setSelectedAnomalyId(null)} className="text-[11px] text-sky-300 hover:underline">← back to list</button>
              <div className="mt-1 flex items-center justify-between gap-2">
                <span className="font-medium text-gray-100">{selectedAnomaly.title}</span>
                <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${selectedAnomaly.severity === "high" ? "bg-red-500/20 text-red-300" : selectedAnomaly.severity === "medium" ? "bg-amber-500/20 text-amber-300" : "bg-slate-500/20 text-slate-300"}`}>{selectedAnomaly.severity}</span>
              </div>
              <div className="mt-0.5 text-[10px] text-gray-500">{ANOMALY_LABELS[selectedAnomaly.type] ?? selectedAnomaly.type}</div>
              <p className="mt-2 text-gray-300">{selectedAnomaly.description}</p>
              <dl className="mt-2 grid grid-cols-[7rem_1fr] gap-x-2 gap-y-0.5 text-[11px]">
                <dt className="text-gray-500">Vessel</dt><dd className="text-gray-200">{selectedAnomaly.name || "—"}{selectedAnomaly.mmsi ? ` · MMSI ${selectedAnomaly.mmsi}` : ""}{selectedAnomaly.imo ? ` · IMO ${selectedAnomaly.imo}` : ""}</dd>
                {selectedAnomaly.vesselType && (<><dt className="text-gray-500">Type</dt><dd className="text-gray-200">{selectedAnomaly.vesselType}</dd></>)}
                {selectedAnomaly.latitude != null && (<><dt className="text-gray-500">Location</dt><dd className="text-gray-200">{selectedAnomaly.latitude.toFixed(3)}, {selectedAnomaly.longitude!.toFixed(3)}</dd></>)}
                {selectedAnomaly.occurredAt && (<><dt className="text-gray-500">Occurred</dt><dd className="text-gray-200">{new Date(selectedAnomaly.occurredAt).toLocaleString()}</dd></>)}
                <dt className="text-gray-500">Detected</dt><dd className="text-gray-200">{new Date(selectedAnomaly.detectedAt).toLocaleString()}</dd>
              </dl>
              {selectedAnomaly.details && (
                <div className="mt-2">
                  <div className="text-[10px] uppercase tracking-wide text-gray-500">Evidence</div>
                  <dl className="mt-0.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
                    {Object.entries(selectedAnomaly.details).map(([k, v]) => (
                      <div key={k} className="flex justify-between gap-2">
                        <dt className="text-gray-500">{k}</dt>
                        <dd className="truncate text-gray-300" title={typeof v === "object" ? JSON.stringify(v) : String(v)}>{typeof v === "object" ? JSON.stringify(v) : String(v)}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}

              {(() => {
                const involved = anomalyVessels(selectedAnomaly);
                return (
                  <div className="mt-3 border-t border-white/10 pt-2">
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-[10px] uppercase tracking-wide text-gray-500">
                        Vessel{involved.length === 1 ? "" : "s"} involved{involved.length > 1 ? ` (${involved.length})` : ""}
                      </span>
                      {selectedAnomaly.latitude != null && (
                        <button onClick={() => snapTo(selectedAnomaly.longitude!, selectedAnomaly.latitude!, 11)} className="text-[11px] text-sky-300 hover:underline">
                          ⌖ Event location
                        </button>
                      )}
                    </div>
                    {involved.length === 0 ? (
                      <p className="text-[11px] text-gray-500">No specific vessel attached to this finding.</p>
                    ) : (
                      <ul className="max-h-56 space-y-1 overflow-auto">
                        {involved.map((v, i) => (
                          <li key={(v.mmsi ?? "") + i} className="rounded border border-white/10 px-2 py-1.5">
                            <div className="flex items-center justify-between gap-2">
                              <span className="min-w-0 truncate text-[12px] text-gray-200">
                                {v.name || v.mmsi || "unknown"}
                                {v.mmsi && v.name ? <span className="text-gray-500"> · {v.mmsi}</span> : null}
                              </span>
                              <div className="flex shrink-0 items-center gap-1">
                                <button onClick={() => void snapToVessel(v.mmsi, selectedAnomaly.latitude, selectedAnomaly.longitude)}
                                  className="rounded border border-white/10 px-1.5 py-0.5 text-[10px] hover:bg-white/10" title="Snap the map to this vessel">Map</button>
                                {v.mmsi && (
                                  <button onClick={() => setEnrichMmsi(v.mmsi)}
                                    className="rounded border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-200 hover:bg-sky-500/20" title="Enrich (Data Docked)">Enrich</button>
                                )}
                              </div>
                            </div>
                            <div className="mt-1">
                              <MonitorButton mmsi={v.mmsi} name={v.name} vesselType={selectedAnomaly.vesselType} lat={selectedAnomaly.latitude} lon={selectedAnomaly.longitude} compact />
                            </div>
                            {enrichMmsi === v.mmsi && v.mmsi && (
                              <div className="mt-2 rounded border border-sky-500/20 bg-sky-500/5 p-2 text-[11px]">
                                {enrich.isLoading ? <p className="text-gray-400">Fetching particulars from Data Docked…</p>
                                  : enrich.data?.status === "error" || enrich.isError ? <p className="text-amber-400">Enrichment failed: {enrich.data?.error ?? (enrich.error as Error)?.message}</p>
                                  : enrich.data ? (
                                    <>
                                      <div className="mb-1 flex items-center justify-between">
                                        <span className="font-medium text-sky-300">Vessel particulars</span>
                                        {enrich.data.creditsSpent != null && <span className="text-[10px] text-gray-500">{enrich.data.creditsSpent} credit{enrich.data.creditsSpent === 1 ? "" : "s"}</span>}
                                      </div>
                                      {Object.keys(enrich.data.curated).length === 0 ? <p className="text-gray-500">No particulars returned.</p> : (
                                        <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                                          {Object.entries(enrich.data.curated).map(([k, val]) => (
                                            <div key={k} className="flex justify-between gap-2">
                                              <dt className="text-gray-500">{k}</dt>
                                              <dd className="truncate text-gray-200" title={String(val)}>{String(val)}</dd>
                                            </div>
                                          ))}
                                        </dl>
                                      )}
                                      <EnrichExtras data={enrich.data} />
                                    </>
                                  ) : null}
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })()}
            </div>
          ) : (
            <>
              {viewingSnapshotId ? (
                <div className="mt-2 flex items-center justify-between rounded border border-sky-500/30 bg-sky-500/10 px-2 py-1.5 text-[11px]">
                  <span className="min-w-0 truncate text-sky-200">Snapshot: {viewingSnapshot.data?.snapshot.name ?? "…"} <span className="text-gray-400">({viewingSnapshot.data?.snapshot.regionNames})</span></span>
                  <button onClick={() => { setViewingSnapshotId(null); setSelectedAnomalyId(null); }} className="shrink-0 rounded border border-white/10 px-2 py-0.5 hover:bg-white/10">← Live</button>
                </div>
              ) : (
                <>
                  <div className="mt-2 rounded border border-white/10 p-2">
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-[10px] uppercase tracking-wide text-gray-500">Analyze region(s)</span>
                      <span className="text-[10px] text-gray-500">{analysisRegionIds.length || "none"} selected</span>
                    </div>
                    <div className="max-h-28 space-y-0.5 overflow-auto">
                      {coverageRegions.map((r) => (
                        <label key={r.id} className="flex items-center gap-1.5 text-[11px] text-gray-300">
                          <input type="checkbox" checked={analysisRegionIds.includes(r.id)} onChange={() => toggleAnalysisRegion(r.id)} />
                          <span className="min-w-0 flex-1 truncate">{r.name}</span>
                          {r.analyze && <span className="shrink-0 rounded bg-emerald-500/20 px-1 text-[9px] text-emerald-300">live</span>}
                        </label>
                      ))}
                      {coverageRegions.length === 0 && <p className="text-[11px] text-gray-500">No regions.</p>}
                    </div>
                    {analysisRegionIds.length === 0 && <p className="mt-1 text-[10px] text-amber-300/80">Analysis is opt-in — pick region(s) to analyze.</p>}
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                    <button onClick={runOnce} disabled={!analysisRegionIds.length || analysisBusy !== null}
                      className="rounded bg-sky-600 px-2 py-1 font-medium text-white hover:bg-sky-500 disabled:opacity-40">{analysisBusy === "run" ? "Running…" : "Run once now"}</button>
                    <span className="text-gray-600">·</span>
                    <span className="text-gray-400">Persistent</span>
                    <select value={analysisDuration} onChange={(e) => setAnalysisDuration(Number(e.target.value))}
                      className="rounded bg-black/30 px-1.5 py-1 text-[11px] ring-1 ring-white/10">
                      {ANALYSIS_DURATIONS.map((d) => <option key={d.v} value={d.v}>{d.l}</option>)}
                    </select>
                    <button onClick={startPersistent} disabled={!analysisRegionIds.length || analysisBusy !== null}
                      className="rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-40">{analysisBusy === "start" ? "Starting…" : "Start"}</button>
                  </div>

                  {analyzingRegions.length > 0 && (
                    <div className="mt-2 rounded border border-emerald-500/30 bg-emerald-500/5 p-2 text-[11px]">
                      <div className="flex items-center justify-between">
                        <span className="text-emerald-300">Analyzing {analyzingRegions.length} region(s) as data lands</span>
                        <button onClick={() => stopPersistent(analyzingRegions.map((r) => r.id))} disabled={analysisBusy !== null}
                          className="rounded border border-white/10 px-2 py-0.5 hover:bg-white/10 disabled:opacity-40">Stop all</button>
                      </div>
                      <div className="mt-1 space-y-0.5 text-[10px] text-gray-400">
                        {analyzingRegions.map((r) => (
                          <div key={r.id} className="flex justify-between gap-2">
                            <span className="truncate">{r.name}</span>
                            <span className="shrink-0 text-gray-500">{r.analyzeUntil ? `until ${new Date(r.analyzeUntil).toLocaleTimeString()}` : "open-ended"}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {analysisMsg && <p className="mt-2 text-[11px] text-sky-300/90">{analysisMsg}</p>}

                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                    <button onClick={() => doClear(scopeIds)} disabled={analysisBusy !== null || !liveAnomalies.length}
                      className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-amber-200 hover:bg-amber-500/20 disabled:opacity-40">Clear selected</button>
                    <button onClick={() => { if (confirm("Clear ALL anomaly records?")) doClear(); }} disabled={analysisBusy !== null}
                      className="rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-red-200 hover:bg-red-500/20 disabled:opacity-40">Clear all</button>
                    <button onClick={() => exportFindings("csv")} disabled={!anomalyList.length}
                      className="rounded border border-white/10 px-2 py-1 hover:bg-white/10 disabled:opacity-40">Export CSV</button>
                    <button onClick={() => exportFindings("json")} disabled={!anomalyList.length}
                      className="rounded border border-white/10 px-2 py-1 hover:bg-white/10 disabled:opacity-40">JSON</button>
                  </div>

                  <div className="mt-1.5 flex gap-1.5">
                    <input value={snapshotName} onChange={(e) => setSnapshotName(e.target.value)} placeholder="Snapshot name…"
                      className="min-w-0 flex-1 rounded bg-black/30 px-2 py-1 text-[11px] ring-1 ring-white/10 placeholder:text-gray-600" />
                    <button onClick={doSaveSnapshot} disabled={!snapshotName.trim() || analysisBusy !== null || !liveAnomalies.length}
                      className="rounded bg-emerald-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-500 disabled:opacity-40">{analysisBusy === "save" ? "Saving…" : "Save snapshot"}</button>
                  </div>

                  {(snapshots.data?.snapshots?.length ?? 0) > 0 && (
                    <div className="mt-2 rounded border border-white/10 p-2">
                      <div className="mb-1 text-[10px] uppercase tracking-wide text-gray-500">Saved snapshots</div>
                      <ul className="max-h-24 space-y-0.5 overflow-auto text-[11px]">
                        {(snapshots.data?.snapshots ?? []).map((s) => (
                          <li key={s.id} className="flex items-center justify-between gap-2">
                            <button onClick={() => { setViewingSnapshotId(s.id); setSelectedAnomalyId(null); }} className="min-w-0 flex-1 truncate text-left text-sky-300 hover:underline" title={s.regionNames ?? ""}>
                              {s.name} <span className="text-gray-500">· {s.findingCount} · {new Date(s.createdAt).toLocaleDateString()}</span>
                            </button>
                            <button onClick={async () => { if (confirm(`Delete snapshot "${s.name}"?`)) { await deleteAnalysisSnapshot(s.id); qc.invalidateQueries({ queryKey: ["anomaly-snapshots"] }); } }} className="shrink-0 text-gray-500 hover:text-red-300">✕</button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}

              <div className="mt-3 flex flex-wrap gap-1 text-[10px]">
                {[null, "high", "medium", "low"].map((s) => (
                  <button key={s ?? "all"} onClick={() => setAnomalyFilter(s)}
                    className={`rounded px-2 py-0.5 ${anomalyFilter === s ? "bg-sky-500/20 text-sky-300" : "text-gray-400 hover:bg-white/10"}`}>
                    {s ?? "all"}
                  </button>
                ))}
                <span className="ml-auto text-gray-500">{shownAnomalies.length} finding{shownAnomalies.length === 1 ? "" : "s"}</span>
              </div>
              {anomalies.isLoading && !viewingSnapshotId ? (
                <p className="mt-2 text-gray-500">Scanning…</p>
              ) : shownAnomalies.length === 0 ? (
                <p className="mt-2 text-gray-500">No findings. Pick region(s) above, then <strong>Run once</strong> or <strong>Start</strong> persistent analysis.</p>
              ) : (
                <ul className="mt-2 max-h-80 space-y-1 overflow-auto">
                  {shownAnomalies.map((a) => (
                    <li key={a.id}>
                      <button onClick={() => setSelectedAnomalyId(a.id)} className="w-full rounded border border-white/10 px-2 py-1.5 text-left hover:bg-white/5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-[12px] text-gray-200">{a.title}</span>
                          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${a.severity === "high" ? "bg-red-500/20 text-red-300" : a.severity === "medium" ? "bg-amber-500/20 text-amber-300" : "bg-slate-500/20 text-slate-300"}`}>{a.severity}</span>
                        </div>
                        <div className="truncate text-[10px] text-gray-500">{ANOMALY_LABELS[a.type] ?? a.type} · {a.name || a.mmsi || a.imo || "—"}</div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </Modal>
      )}

      {tool === "activity" && (() => {
        const collecting = coverageRegions.filter((r) => r.collectAis || r.collectAisSatellite || r.collectAdsb);
        const runList = runs.data?.runs ?? [];
        const summary = runs.data?.summary ?? [];
        const credits24h = summary.reduce((s, x) => s + (x.credits_spent || 0), 0);
        const calls24h = summary.reduce((s, x) => s + (x.runs || 0), 0);
        const lastRun = runList[0];
        return (
          <Modal title="Collection & Activity" onClose={() => setTool(null)} width="w-[36rem]">
            <p className="text-[10px] leading-snug text-gray-500">
              Collection is <strong className="text-gray-400">scheduled snapshot pulls</strong>, not a live stream — each region pulls on its own cadence. Nothing is called for a region until you enable a source on it. Every call is logged below.
            </p>

            <div className="mt-2 flex flex-wrap gap-2">
              <div className="rounded border border-white/10 bg-white/5 px-3 py-1.5 text-[11px]">
                <div className="text-gray-500">Regions collecting</div>
                <div className="font-mono text-sky-300">{collecting.length}</div>
              </div>
              <div className="rounded border border-white/10 bg-white/5 px-3 py-1.5 text-[11px]">
                <div className="text-gray-500">Last call</div>
                <div className="font-mono text-gray-200">{lastRun ? ago(lastRun.finished_at ?? lastRun.started_at) : "—"}</div>
              </div>
              <div className="rounded border border-white/10 bg-white/5 px-3 py-1.5 text-[11px]">
                <div className="text-gray-500">Calls · Credits (24h)</div>
                <div className="font-mono text-gray-200">{calls24h} · <span className="text-amber-400">{credits24h} cr</span></div>
              </div>
            </div>

            <div className="mt-3">
              <div className="mb-1 text-[10px] uppercase tracking-wide text-gray-500">Collection status</div>
              {collecting.length === 0 ? (
                <p className="text-[11px] text-gray-500">No regions are collecting. Enable AIS / Sat / ADS-B on a region in the Regions tab.</p>
              ) : (
                <ul className="max-h-40 space-y-1 overflow-auto">
                  {collecting.map((r) => (
                    <li key={r.id} className="rounded border border-white/10 px-2 py-1.5 text-[11px]">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-gray-200">{r.name}</span>
                        <span className="flex shrink-0 gap-1">
                          {r.collectAis && <span className="rounded bg-sky-500/20 px-1.5 text-[10px] text-sky-300">AIS</span>}
                          {r.collectAisSatellite && <span className="rounded bg-emerald-500/20 px-1.5 text-[10px] text-emerald-300">Sat</span>}
                          {r.collectAdsb && <span className="rounded bg-orange-500/20 px-1.5 text-[10px] text-orange-300">ADS-B</span>}
                        </span>
                      </div>
                      <div className="mt-0.5 text-[10px] text-gray-500">
                        {(r.collectAis || r.collectAisSatellite)
                          ? `AIS ${fmtAgo(r.lastAisPullAt)} · ${fmtNextPull(r.lastAisPullAt, r.aisPullCadenceMinutes)} · every ${cadenceLabel(r.aisPullCadenceMinutes)}`
                          : ""}
                        {r.collectAdsb ? `${r.collectAis || r.collectAisSatellite ? " · " : ""}ADS-B every ~10m` : ""}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="mt-3">
              <div className="mb-1 text-[10px] uppercase tracking-wide text-gray-500">Recent calls</div>
              {runs.isLoading ? (
                <p className="text-[11px] text-gray-500">Loading…</p>
              ) : runList.length === 0 ? (
                <p className="text-[11px] text-gray-500">No API calls recorded yet.</p>
              ) : (
                <div className="max-h-56 overflow-auto">
                  <table className="w-full text-left text-[10px]">
                    <thead className="text-gray-500">
                      <tr className="border-b border-white/10">
                        <th className="py-1 pr-2 font-medium">When</th>
                        <th className="py-1 pr-2 font-medium">Source</th>
                        <th className="py-1 pr-2 font-medium">Region</th>
                        <th className="py-1 pr-2 font-medium">Recs</th>
                        <th className="py-1 font-medium">Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {runList.slice(0, 40).map((r) => {
                        const info = endpointInfo(r.endpoint);
                        return (
                          <tr key={r.id} className="border-b border-white/5">
                            <td className="py-1 pr-2 text-gray-400">{ago(r.finished_at ?? r.started_at)}</td>
                            <td className="py-1 pr-2 text-gray-300">{info.label}{r.status !== "success" && r.status !== "running" ? <span className="text-amber-400"> · {r.status}</span> : ""}</td>
                            <td className="py-1 pr-2 text-gray-500">{r.region_name ?? "—"}</td>
                            <td className="py-1 pr-2 text-gray-400">{r.records}</td>
                            <td className="py-1">{info.paid ? <span className="text-amber-400">{r.credits_spent != null ? `${r.credits_spent} cr` : "—"}</span> : <span className="text-gray-600">free</span>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <p className="mt-2 text-[10px] text-gray-600">AISStream &amp; ADS-B are free; Data Docked (satellite AIS, enrichment, gap-verify) spends credits. Set per-region cadence in the Regions tab to control how often AIS pulls.</p>
          </Modal>
        );
      })()}

      {/* Region options — opened by clicking a region on the map */}
      {regionModalRegion && (() => {
        const r = regionModalRegion;
        const sel = selectedRegionIds.includes(r.id);
        const ps = pullState[r.id];
        const pulling = ps === "starting" || ps === "pulling";
        return (
          <Modal title={r.name} onClose={() => setRegionModalId(null)}>
            <div className="text-[11px] text-gray-500">{r.description ?? r.type}</div>
            <div className="mt-0.5 text-[10px] text-gray-500">{r.collectAis ? fmtAgo(r.lastAisPullAt) : "AIS collection off"}</div>

            <button
              onClick={() => navigate(`/dossier/${r.id}`)}
              className="mt-3 w-full rounded border border-sky-500/40 bg-sky-500/10 px-2 py-1.5 text-[12px] text-sky-200 hover:bg-sky-500/20"
            >
              View Region Dossier →
            </button>

            <label className="mt-3 flex items-center gap-2 text-gray-300">
              <input type="checkbox" checked={sel} onChange={() => toggleRegionSelect(r.id)} />
              Show on map <span className="text-[10px] text-gray-500">(outline + stored positions — view historic with collection off)</span>
            </label>
            <label className="mt-2 flex items-center gap-2 text-gray-300">
              <input type="checkbox" checked={footprintRegionId === r.id} onChange={(e) => setFootprintRegionId(e.target.checked ? r.id : null)} />
              Show collection footprint <span className="text-[10px] text-gray-500">(coverage area)</span>
            </label>
            {footprintRegionId === r.id && r.boundingBox && (() => {
              const tiles = r.footprintPath && r.footprintPath.length ? pathTileCenters(r.footprintPath) : satTileCenters(r.boundingBox!);
              return (
                <p className="ml-6 text-[10px] leading-snug text-gray-500">
                  <span className="text-slate-200">▭ box</span> = AIS collection area · <span className="text-emerald-300">◯ green</span> = {tiles.length} satellite tile{tiles.length === 1 ? "" : "s"}{r.footprintPath?.length ? " along your drawn path" : " (auto-grid — define a path to follow the lane)"} (pulled when Sat is on).
                </p>
              );
            })()}
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button onClick={() => startDefineFootprint(r.id)} className="rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-200 hover:bg-emerald-500/20">
                {r.footprintPath?.length ? "Redraw footprint path" : "Define collection footprint"}
              </button>
              {r.footprintPath?.length ? (
                <button onClick={() => clearFootprint(r.id)} className="rounded border border-white/10 px-2 py-1 text-[11px] hover:bg-white/10">Clear path</button>
              ) : null}
            </div>

            <div className="mt-3 border-t border-white/10 pt-2 text-[11px] text-gray-400">Data collection</div>
            <div className="mt-1 flex flex-col gap-1.5 text-[12px]">
              <label className={`flex items-center gap-2 ${r.boundingBox ? "text-gray-300" : "text-gray-600"}`}>
                <input type="checkbox" checked={r.collectAis} disabled={!r.boundingBox}
                  onChange={async (e) => { await setRegionCollection(r.id, { collectAis: e.target.checked }); qc.invalidateQueries({ queryKey: ["regions"] }); }} />
                AIS <span className="text-[10px] text-gray-500">— AISStream snapshot (free; 24h auto-pull)</span>
              </label>
              <label className={`flex items-center gap-2 ${r.boundingBox ? "text-gray-300" : "text-gray-600"}`}>
                <input type="checkbox" checked={r.collectAisSatellite} disabled={!r.boundingBox}
                  onChange={(e) => setSat(r, e.target.checked)} />
                Sat <span className="text-[10px] text-gray-500">— Data Docked satellite supplement (credits)</span>
              </label>
              {r.boundingBox && (() => {
                const est = estimateSatTiles(r.boundingBox!);
                return (
                  <p className="ml-6 text-[10px] text-gray-600">
                    Satellite covers offshore/blind-spot AIS · ~{est.tiles} tile{est.tiles === 1 ? "" : "s"} ≈ {est.tiles * SAT_CREDITS_PER_TILE} credits/pull{est.capped ? ` (region large — ${est.tiles}/${est.total} tiles; draw smaller for full coverage)` : ""}
                  </p>
                );
              })()}
              <label className="flex items-center gap-2 text-gray-300">
                <input type="checkbox" checked={r.collectAdsb}
                  onChange={async (e) => { await setRegionCollection(r.id, { collectAdsb: e.target.checked }); qc.invalidateQueries({ queryKey: ["regions"] }); }} />
                ADS-B <span className="text-[10px] text-gray-500">— GNSS interference (10-min)</span>
              </label>
            </div>

            {/* AIS Gaps / dark-shipping — satellite-only; per-region opt-in + its own Sat cadence (item 2). */}
            {r.collectAisSatellite ? (
              <div className="mt-3 border-t border-white/10 pt-2">
                <label className="flex items-center gap-2 text-[12px] text-gray-300">
                  <input type="checkbox" checked={r.detectAisGaps}
                    onChange={async (e) => { await setRegionCollection(r.id, { detectAisGaps: e.target.checked }); qc.invalidateQueries({ queryKey: ["regions"] }); }} />
                  Detect AIS gaps <span className="text-[10px] text-gray-500">— satellite-only dark-shipping (this region)</span>
                </label>
                <label className="mt-2 flex items-center justify-between text-[12px] text-gray-300">
                  <span>Satellite pull cadence</span>
                  <select
                    value={r.satPullCadenceMinutes}
                    onChange={async (e) => { await setRegionCollection(r.id, { satPullCadenceMinutes: Number(e.target.value) }); qc.invalidateQueries({ queryKey: ["regions"] }); }}
                    className="rounded bg-black/30 px-2 py-1 text-[11px] ring-1 ring-white/10"
                  >
                    {SAT_CADENCE_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
                  </select>
                </label>
                <p className="text-[10px] text-gray-600">How often the satellite pull runs (credits). The gap window scales with this cadence (~1.5×).</p>
              </div>
            ) : (
              <p className="mt-2 text-[10px] text-gray-600">Enable <span className="text-gray-400">Sat</span> to use AIS-gap / dark-shipping detection (satellite-only — terrestrial AIS isn't dependable for gaps).</p>
            )}

            <label className="mt-3 flex items-center justify-between text-[12px] text-gray-300">
              <span>AIS pull cadence</span>
              <select
                value={r.aisPullCadenceMinutes}
                onChange={async (e) => { await setRegionCollection(r.id, { aisPullCadenceMinutes: Number(e.target.value) }); qc.invalidateQueries({ queryKey: ["regions"] }); }}
                className="rounded bg-black/30 px-2 py-1 text-[11px] ring-1 ring-white/10"
              >
                {CADENCE_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
              </select>
            </label>
            <p className="text-[10px] text-gray-600">More frequent = finer tracks &amp; gap detection (and more collection). Default 24h.</p>

            <div className="mt-3 flex items-center gap-2">
              <button onClick={() => doPull(r.id)} disabled={pulling || !r.boundingBox}
                className="rounded border border-sky-500/40 bg-sky-500/10 px-2 py-1 text-[11px] text-sky-200 hover:bg-sky-500/20 disabled:opacity-40"
                title="Pull a fresh snapshot for this region now">
                {pulling ? "Pulling…" : "Pull now"}
              </button>
              <span className="text-[10px] text-gray-600">{ps === "done" ? "snapshot done" : ps?.startsWith("error") ? ps : pulling ? "snapshot started (~3 min)" : ""}</span>
            </div>
            <p className="mt-2 text-[10px] text-gray-600">Same options as the Regions tab. Nothing collects until enabled.</p>
            {r.isCustom && (
              <button onClick={() => doDeleteRegion(r.id, r.name)}
                className="mt-2 rounded border border-red-500/30 px-2 py-1 text-[11px] text-red-300 hover:bg-red-500/10">
                Delete custom region
              </button>
            )}
          </Modal>
        );
      })()}

      {/* Report generation (blocking) */}
      {reportOpen && (
        <Modal title="Generate report" onClose={() => setReportOpen(false)} blocking>
          {result?.error ? (
            <p className="text-amber-400">Search failed: {result.error}</p>
          ) : (
            <>
              <p className="text-gray-400">
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
                <button onClick={() => setReportOpen(false)} className="rounded border border-white/10 px-3 py-1.5 hover:bg-white/10">Close</button>
                <button
                  onClick={() => setGenerated(`Drafting "${reportType}" for this area — the report engine wires in the next slice.`)}
                  className="rounded bg-sky-600 px-3 py-1.5 font-medium hover:bg-sky-500"
                >
                  Generate
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
