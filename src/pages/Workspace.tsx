import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import MapView, { type PickedVessel, type ViewportBbox, type FlyTo, type Footprint } from "../components/MapView";
import Modal from "../components/Modal";
import MonitorButton from "../components/MonitorButton";
import { usePersistentState } from "../lib/persist";
import { getRegions, getPositions, getVesselTrack, getAisGaps, getGnssInterference, getAnomalies, enrichVessel, getLatestPosition, searchArea, setRegionCollection, pullRegion, createRegion, deleteRegion, getIngestionRuns, type AreaSearchResult, type Anomaly, type Region } from "../lib/api";

// Overlay-colour palette for custom regions (default first = the baseline green).
const REGION_PALETTE = ["#22c55e", "#38bdf8", "#f59e0b", "#ef4444", "#a855f7", "#eab308", "#ec4899", "#14b8a6"];

// Satellite tiling estimate (mirrors backend defaults: 50km radius, 70km step, max 12 tiles).
// Each tile is a Data Docked get-vessels-by-area call ≈ 10 credits.
const SAT_TILE_STEP_KM = 70;
const SAT_TILE_MAX = 12;
const SAT_CREDITS_PER_TILE = 10;
// Max custom-region box span per axis (km). Keeps satellite tiling within the credit cap
// (≈3 tiles/axis at the 70 km step). Cover a larger area with several boxes.
const MAX_REGION_SPAN_KM = 210;
type Bbox = { minLat: number; minLon: number; maxLat: number; maxLon: number };
function satGrid(bbox: Bbox): { rows: number; cols: number } {
  const midLat = (bbox.minLat + bbox.maxLat) / 2;
  const latSpanKm = Math.abs(bbox.maxLat - bbox.minLat) * 111;
  const lonSpanKm = Math.abs(bbox.maxLon - bbox.minLon) * 111 * Math.cos((midLat * Math.PI) / 180);
  return {
    rows: Math.max(1, Math.ceil(latSpanKm / SAT_TILE_STEP_KM)),
    cols: Math.max(1, Math.ceil(lonSpanKm / SAT_TILE_STEP_KM)),
  };
}
function estimateSatTiles(bbox: Bbox): { tiles: number; total: number; capped: boolean } {
  const { rows, cols } = satGrid(bbox);
  const total = rows * cols;
  return { tiles: Math.min(total, SAT_TILE_MAX), total, capped: total > SAT_TILE_MAX };
}
// Actual satellite tile centers (mirrors backend tileBbox) — for the footprint overlay.
function satTileCenters(bbox: Bbox): { lng: number; lat: number; radiusKm: number }[] {
  const { rows, cols } = satGrid(bbox);
  const out: { lng: number; lat: number; radiusKm: number }[] = [];
  for (let r = 0; r < rows; r++) {
    const lat = rows === 1 ? (bbox.minLat + bbox.maxLat) / 2 : bbox.minLat + ((r + 0.5) / rows) * (bbox.maxLat - bbox.minLat);
    for (let c = 0; c < cols; c++) {
      const lng = cols === 1 ? (bbox.minLon + bbox.maxLon) / 2 : bbox.minLon + ((c + 0.5) / cols) * (bbox.maxLon - bbox.minLon);
      out.push({ lng, lat, radiusKm: 50 });
      if (out.length >= SAT_TILE_MAX) return out;
    }
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
type Tool = "layers" | "vessels" | "area" | "regions" | "gaps" | "analysis" | "activity";

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
  const positions = useQuery({ queryKey: ["positions", viewportKey], queryFn: () => getPositions(viewport), refetchInterval: 20000 });

  // Durable UI state — persisted across tab/route changes and reload (see lib/persist).
  const [tool, setTool] = usePersistentState<Tool | null>("tool", null);
  const [aisVisible, setAisVisible] = usePersistentState("aisVisible", true);
  const [tracksOn, setTracksOn] = usePersistentState("tracksOn", false);
  const [placesOn, setPlacesOn] = usePersistentState("placesOn", false);
  const [boxMode, setBoxMode] = usePersistentState("boxMode", false);
  const [hidden, setHidden] = usePersistentState<string[]>("hidden", []);
  const [clearedAt, setClearedAt] = usePersistentState<number | null>("clearedAt", null);
  const [selected, setSelected] = usePersistentState<PickedVessel[]>("selected", []);
  const [selectedRegionIds, setSelectedRegionIds] = usePersistentState<string[]>("selectedRegionIds", []);

  // Transient interaction/operation state — intentionally NOT persisted.
  const [areaPickMode, setAreaPickMode] = useState(false);
  const [pullState, setPullState] = useState<Record<string, string>>({});
  const [footprintRegionId, setFootprintRegionId] = useState<string | null>(null);

  // Custom-region drawing (transient): drag a box → name + colour → save. The box is
  // capped at MAX_REGION_SPAN_KM/axis so satellite tiling stays within the credit cap.
  const [drawBoxMode, setDrawBoxMode] = useState(false);
  const [drawForm, setDrawForm] = useState(false); // box drawn → naming/colour step
  const [drawBox, setDrawBox] = useState<Bbox | null>(null);
  const [boxClamped, setBoxClamped] = useState(false);
  const [newRegionName, setNewRegionName] = useState("");
  const [newRegionColor, setNewRegionColor] = useState(REGION_PALETTE[0]);
  const [savingRegion, setSavingRegion] = useState(false);
  const [drawErr, setDrawErr] = useState<string | null>(null);

  function startDrawRegion() {
    setBoxMode(false);
    setAreaPickMode(false);
    setTool(null);
    setDrawBox(null);
    setBoxClamped(false);
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
    setBoxClamped(false);
    setDrawErr(null);
  }
  // Receive a dragged rectangle; clamp each axis to the max span (keeps satellite tiling
  // bounded) then advance to the name/colour step.
  function handleBoxDrawn(bbox: Bbox) {
    let { minLat, minLon, maxLat, maxLon } = bbox;
    const midLat = (minLat + maxLat) / 2;
    const latSpanKm = (maxLat - minLat) * 111;
    const lonSpanKm = (maxLon - minLon) * 111 * Math.cos((midLat * Math.PI) / 180);
    let clamped = false;
    if (latSpanKm > MAX_REGION_SPAN_KM) { const d = MAX_REGION_SPAN_KM / 111; maxLat = minLat + d; clamped = true; }
    if (lonSpanKm > MAX_REGION_SPAN_KM) { const d = MAX_REGION_SPAN_KM / (111 * Math.cos((midLat * Math.PI) / 180)); maxLon = minLon + d; clamped = true; }
    setDrawBox({ minLat, minLon, maxLat, maxLon });
    setBoxClamped(clamped);
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
  useEffect(() => {
    const st = location.state as { flyMmsi?: string; flyLat?: number; flyLon?: number } | null;
    if (st && (st.flyMmsi || (st.flyLat != null && st.flyLon != null))) {
      void snapToVessel(st.flyMmsi ?? null, st.flyLat ?? null, st.flyLon ?? null);
      window.history.replaceState({}, ""); // consume so it doesn't refire on back/refresh
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);

  // Vessel anomalies / pattern analysis (scanned server-side; always polled for the badge).
  const [selectedAnomalyId, setSelectedAnomalyId] = useState<string | null>(null);
  const [anomalyFilter, setAnomalyFilter] = useState<string | null>(null);
  const anomalies = useQuery({ queryKey: ["anomalies"], queryFn: () => getAnomalies(), refetchInterval: 120000 });
  const anomalyList = anomalies.data?.anomalies ?? [];

  // Collection & activity — fetched only while the Activity tab is open (on-demand).
  const runs = useQuery({ queryKey: ["ingestionRuns", "activity"], queryFn: () => getIngestionRuns(100), enabled: tool === "activity", refetchInterval: 30000 });
  const shownAnomalies = anomalyFilter ? anomalyList.filter((a) => a.severity === anomalyFilter) : anomalyList;
  const selectedAnomaly = anomalyList.find((a) => a.id === selectedAnomalyId) ?? null;

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

  // Split the canonical region list: coverage boxes (collected) vs POI labels.
  const allRegions = regions.data?.regions ?? [];
  const activeRegions = useMemo(() => allRegions.filter((r) => r.status === "active"), [allRegions]);
  const coverageRegions = useMemo(() => activeRegions.filter((r) => r.kind !== "poi"), [activeRegions]);
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
  const footprint: Footprint = footprintRegion?.boundingBox
    ? { bbox: footprintRegion.boundingBox, tiles: satTileCenters(footprintRegion.boundingBox) }
    : null;
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

  const TOOLS: { key: Tool; label: string; badge?: number }[] = [
    { key: "layers", label: "Layers" },
    { key: "vessels", label: "Vessels", badge: displayed.length },
    { key: "area", label: "Area Search" },
    { key: "regions", label: "Regions", badge: regionCount },
    { key: "gaps", label: "AIS Gaps", badge: gapsOn ? gapList?.length ?? 0 : undefined },
    { key: "analysis", label: "Vessel Analysis", badge: anomalyList.length || undefined },
    { key: "activity", label: "Activity" },
  ];

  return (
    <div className="relative h-full w-full">
      <MapView
        vessels={displayed}
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
      />

      {/* Tool tabs */}
      <div className="absolute left-3 top-3 z-20 flex max-w-[calc(100%-1.5rem)] flex-wrap gap-1 rounded-lg border border-white/10 bg-black/60 p-1 text-xs backdrop-blur">
        {TOOLS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTool(tool === t.key ? null : t.key)}
            className={`rounded px-2.5 py-1 ${tool === t.key ? "bg-sky-500/20 text-sky-300" : "text-gray-300 hover:bg-white/10"}`}
          >
            {t.label}
            {t.badge !== undefined && <span className="ml-1 font-mono text-gray-500">{t.badge}</span>}
          </button>
        ))}
      </div>

      {/* Custom-region draw panel (floating) */}
      {(drawBoxMode || drawForm) && (
        <div className="absolute bottom-4 left-1/2 z-30 w-80 -translate-x-1/2 rounded-lg border border-sky-500/30 bg-black/80 p-3 text-xs backdrop-blur">
          {!drawForm ? (
            <>
              <div className="font-medium text-sky-300">Draw a custom region</div>
              <p className="mt-1 text-gray-400">Click and drag a rectangle on the map to set the region area. Max {MAX_REGION_SPAN_KM} km per side — draw several to cover more.</p>
              <div className="mt-2 flex gap-1.5">
                <button onClick={cancelDrawRegion} className="ml-auto rounded border border-white/10 px-2 py-1 hover:bg-white/10">Cancel</button>
              </div>
            </>
          ) : (
            <>
              <div className="font-medium text-sky-300">Name &amp; colour</div>
              {boxClamped && <p className="mt-1 text-[10px] text-amber-300/90">Box was capped to the {MAX_REGION_SPAN_KM} km max — add more regions to cover a wider area.</p>}
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
              {drawBox && <p className="mt-2 text-[10px] text-gray-500">{(() => { const e = estimateSatTiles(drawBox); return `Satellite would tile this into ${e.tiles} cell${e.tiles === 1 ? "" : "s"} ≈ ${e.tiles * SAT_CREDITS_PER_TILE} credits/pull. Turn on AIS / Sat in the Regions tab once saved.`; })()}</p>}
              {drawErr && <p className="mt-1 text-amber-400">{drawErr}</p>}
              <div className="mt-2 flex gap-1.5">
                <button onClick={() => { setDrawForm(false); setDrawBox(null); setBoxClamped(false); setDrawBoxMode(true); }} className="rounded border border-white/10 px-2 py-1 hover:bg-white/10">↻ Redraw</button>
                <button onClick={saveCustomRegion} disabled={savingRegion || !newRegionName.trim()}
                  className="rounded bg-emerald-600 px-2 py-1 font-medium text-white hover:bg-emerald-500 disabled:opacity-50">{savingRegion ? "Saving…" : "Save region"}</button>
                <button onClick={cancelDrawRegion} className="ml-auto rounded border border-white/10 px-2 py-1 hover:bg-white/10">Cancel</button>
              </div>
            </>
          )}
        </div>
      )}

      {tool === "layers" && (
        <Modal title="Layers" onClose={() => setTool(null)}>
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
            <input type="checkbox" checked={placesOn} onChange={(e) => setPlacesOn(e.target.checked)} />
            Places <span className="text-[10px] text-gray-500">(chokepoints, straits & ports)</span>
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
          <label className="mt-2 flex items-center gap-2 text-gray-500">
            <input type="checkbox" disabled /> Imagery <span className="text-[10px]">(soon)</span>
          </label>
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
            <p className="text-[11px] text-gray-500">Click a name to highlight it on the map; toggle AIS to collect.</p>
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
              "An AIS gap means no AIS position was received within the window; it may result from terrestrial coverage limits, equipment faults, or feed interruptions — not necessarily intentional AIS-off behavior."}
          </div>

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
              Bounces each terrestrial gap off Data Docked satellite to separate coverage gaps from genuine
              dark vessels. Spends Data Docked credits (one bulk call per refresh, cached 30&nbsp;min). Vessels
              seen on satellite are marked active and reappear on the map.
            </p>
          )}

          {!gapsOn ? (
            <p className="mt-2 text-gray-500">Enable the layer to scan AIS-collecting regions for vessels not seen in &gt;30 min (within 24h).</p>
          ) : gaps.isLoading ? (
            <p className="mt-2 text-gray-500">Scanning…</p>
          ) : (gapList?.length ?? 0) === 0 ? (
            <p className="mt-2 text-gray-500">No AIS gaps in collecting regions right now.</p>
          ) : (
            <>
              {gaps.data && !gaps.data.streamFresh && (
                <p className="mt-2 text-[10px] text-amber-400/80">Feed appears stale — all indicators down-rated to low confidence.</p>
              )}
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
              <div className="mt-2 flex flex-wrap gap-1 text-[10px]">
                {[null, "high", "medium", "low"].map((s) => (
                  <button key={s ?? "all"} onClick={() => setAnomalyFilter(s)}
                    className={`rounded px-2 py-0.5 ${anomalyFilter === s ? "bg-sky-500/20 text-sky-300" : "text-gray-400 hover:bg-white/10"}`}>
                    {s ?? "all"}
                  </button>
                ))}
                <span className="ml-auto text-gray-500">{shownAnomalies.length} finding{shownAnomalies.length === 1 ? "" : "s"}</span>
              </div>
              {anomalies.isLoading ? (
                <p className="mt-2 text-gray-500">Scanning…</p>
              ) : shownAnomalies.length === 0 ? (
                <p className="mt-2 text-gray-500">No anomalies detected yet. The analysis scan runs about every 20 minutes over recent AIS history.</p>
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

            <label className="mt-3 flex items-center gap-2 text-gray-300">
              <input type="checkbox" checked={sel} onChange={() => toggleRegionSelect(r.id)} />
              Show on map <span className="text-[10px] text-gray-500">(green outline)</span>
            </label>
            <label className="mt-2 flex items-center gap-2 text-gray-300">
              <input type="checkbox" checked={footprintRegionId === r.id} onChange={(e) => setFootprintRegionId(e.target.checked ? r.id : null)} />
              Show collection footprint <span className="text-[10px] text-gray-500">(coverage area)</span>
            </label>
            {footprintRegionId === r.id && r.boundingBox && (
              <p className="ml-6 text-[10px] leading-snug text-gray-500">
                <span className="text-slate-200">▭ white dashed</span> = AIS collection box · <span className="text-emerald-300">◯ green dashed</span> = {satTileCenters(r.boundingBox!).length} satellite tile{satTileCenters(r.boundingBox!).length === 1 ? "" : "s"} (pulled when Sat is on). Redraw so the footprint straddles the traffic lane.
              </p>
            )}

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
