import { useEffect, useRef } from "react";
import mapboxgl from "mapbox-gl";
import type { VesselPosition, AisGap } from "../lib/api";

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN ?? "";

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

export type Selection = { lng: number; lat: number; radiusKm: number } | null;
export type PickedVessel = { mmsi: string | null; name: string | null };
export type RegionPoly = {
  id: string;
  name: string;
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number };
  polygon?: number[][] | null; // custom regions: exact outer ring [[lng,lat], ...]
  color?: string | null;       // custom overlay colour (hex); null → default green
};
export type Poi = { id: string; name: string; type: string; lng: number; lat: number };
export type ViewportBbox = { minLat: number; minLon: number; maxLat: number; maxLon: number };
// Imperative fly-to request: bump `key` to trigger an easeTo to (lng,lat). Used to snap
// the map to a vessel chosen from a list (anomaly evidence, registry).
export type FlyTo = { lng: number; lat: number; zoom?: number; key: number } | null;
// A region's actual collection footprint: the bounding box (terrestrial/AIS collection
// unit) + the satellite tile circles (Data Docked get-vessels-by-area, when Sat is on).
export type Footprint = {
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number };
  tiles: { lng: number; lat: number; radiusKm: number }[];
  path?: number[][] | null; // operator-drawn corridor the tiles follow
} | null;

export type GnssCellView = {
  polygon: GeoJSON.Polygon;
  region: string;
  cellId: string;
  severityPct: number;
  severityColor: string;
  confidence: string;
  distinctAircraft: number;
  dropEvents: number;
};

// Persist the map view across tab switches (module var) AND reload (localStorage).
type View = { center: [number, number]; zoom: number; bearing: number; pitch: number };
const VIEW_KEY = "vantos.ws.mapView";
let savedView: View | null = null;
function loadView(): View | null {
  if (savedView) return savedView;
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    if (raw) savedView = JSON.parse(raw) as View;
  } catch { /* ignore */ }
  return savedView;
}
function persistView(v: View): void {
  savedView = v;
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(v)); } catch { /* ignore */ }
}

const VESSEL_LAYERS = ["clusters", "cluster-count", "vessels-circle"];

// A point is "stale" once its last AIS fix is older than this (24h pull cadence → it
// ages through the day). Stale points stay visible but in a muted colour.
const STALE_AFTER_MS = 6 * 60 * 60_000;

function toVesselGeoJSON(vessels: VesselPosition[]): GeoJSON.FeatureCollection {
  const now = Date.now();
  return {
    type: "FeatureCollection",
    features: vessels
      .filter((v) => Number.isFinite(v.latitude) && Number.isFinite(v.longitude))
      .map((v) => {
        const ts = v.ingestedAt ? Date.parse(v.ingestedAt) : NaN;
        const stale = Number.isFinite(ts) ? now - ts > STALE_AFTER_MS : false;
        return {
          type: "Feature",
          properties: { mmsi: v.mmsi, name: v.name, type: v.type, dataSource: v.dataSource, stale },
          geometry: { type: "Point", coordinates: [v.longitude, v.latitude] },
        };
      }),
  };
}

function circleFeature(lng: number, lat: number, radiusKm: number): GeoJSON.Feature {
  const points = 64;
  const dLat = radiusKm / 110.574;
  const dLng = radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180));
  const ring: [number, number][] = [];
  for (let i = 0; i <= points; i++) {
    const t = (i / points) * 2 * Math.PI;
    ring.push([lng + dLng * Math.cos(t), lat + dLat * Math.sin(t)]);
  }
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } };
}

function trackData(track: [number, number][] | null): GeoJSON.FeatureCollection {
  if (!track || track.length < 2) return EMPTY;
  const features: GeoJSON.Feature[] = [
    { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: track } },
    // Endpoints: start (older, hollow) and current (latest, filled).
    { type: "Feature", properties: { kind: "start" }, geometry: { type: "Point", coordinates: track[0] } },
    { type: "Feature", properties: { kind: "end" }, geometry: { type: "Point", coordinates: track[track.length - 1] } },
  ];
  return { type: "FeatureCollection", features };
}

const DEFAULT_REGION_COLOR = "#22c55e";

function regionsData(regions: RegionPoly[] | null, selectedIds: string[]): GeoJSON.FeatureCollection {
  if (!regions || !regions.length) return EMPTY;
  const sel = new Set(selectedIds);
  return {
    type: "FeatureCollection",
    features: regions.map((p) => {
      // Custom regions render their exact drawn polygon; baseline regions render the bbox rect.
      let ring: [number, number][];
      if (p.polygon && p.polygon.length >= 3) {
        ring = p.polygon.map((c) => [c[0], c[1]] as [number, number]);
        const first = ring[0], last = ring[ring.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first); // close the ring
      } else {
        const { minLat, minLon, maxLat, maxLon } = p.bbox;
        ring = [[minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat]];
      }
      return {
        type: "Feature",
        properties: { rid: p.id, name: p.name, selected: sel.has(p.id), color: p.color || DEFAULT_REGION_COLOR },
        geometry: { type: "Polygon", coordinates: [ring] },
      };
    }),
  };
}

// A region's collection footprint: the bbox rectangle (AIS collection unit) + the
// satellite tile circles (what Data Docked actually pulls). Lets the operator see whether
// a drawn region covers the traffic before committing.
function footprintData(fp: Footprint): GeoJSON.FeatureCollection {
  if (!fp) return EMPTY;
  const { minLat, minLon, maxLat, maxLon } = fp.bbox;
  const features: GeoJSON.Feature[] = [
    {
      type: "Feature",
      properties: { kind: "bbox" },
      geometry: { type: "Polygon", coordinates: [[[minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat]]] },
    },
  ];
  for (const t of fp.tiles) features.push({ ...circleFeature(t.lng, t.lat, t.radiusKm), properties: { kind: "tile" } });
  if (fp.path && fp.path.length >= 2) {
    features.push({ type: "Feature", properties: { kind: "path" }, geometry: { type: "LineString", coordinates: fp.path as [number, number][] } });
  }
  return { type: "FeatureCollection", features };
}

// In-progress footprint path (operator drawing the corridor): a line through the waypoints
// + a dot per waypoint.
function pathData(verts: [number, number][] | null): GeoJSON.FeatureCollection {
  if (!verts || !verts.length) return EMPTY;
  const features: GeoJSON.Feature[] = [];
  if (verts.length >= 2) features.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: verts } });
  verts.forEach((v) => features.push({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: v } }));
  return { type: "FeatureCollection", features };
}

// In-progress drawn polygon (custom region): a line through the vertices, a fill once
// there are ≥3, and a dot per vertex.
function drawData(verts: [number, number][] | null): GeoJSON.FeatureCollection {
  if (!verts || !verts.length) return EMPTY;
  const features: GeoJSON.Feature[] = [];
  if (verts.length >= 3) {
    features.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[...verts, verts[0]]] } });
  }
  if (verts.length >= 2) {
    features.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: verts } });
  }
  verts.forEach((v, i) => features.push({ type: "Feature", properties: { idx: i }, geometry: { type: "Point", coordinates: v } }));
  return { type: "FeatureCollection", features };
}

function poisData(pois: Poi[] | null): GeoJSON.FeatureCollection {
  if (!pois || !pois.length) return EMPTY;
  return {
    type: "FeatureCollection",
    features: pois
      .filter((p) => Number.isFinite(p.lng) && Number.isFinite(p.lat))
      .map((p) => ({
        type: "Feature",
        properties: { id: p.id, name: p.name, type: p.type },
        geometry: { type: "Point", coordinates: [p.lng, p.lat] },
      })),
  };
}

// GPSJAM severity colours; opacity carries confidence (multiplicative display).
const GNSS_FILL: Record<string, string> = { red: "#ef4444", orange: "#f97316", yellow: "#eab308", green: "#22c55e", gray: "#6b7280" };
const GNSS_OPACITY: Record<string, number> = { high: 0.5, medium: 0.36, low: 0.22, insufficient_data: 0.08 };

function gnssData(cells: GnssCellView[] | null): GeoJSON.FeatureCollection {
  if (!cells || !cells.length) return EMPTY;
  return {
    type: "FeatureCollection",
    features: cells.map((c) => ({
      type: "Feature",
      properties: {
        region: c.region,
        severityPct: c.severityPct,
        severityColor: c.severityColor,
        confidence: c.confidence,
        distinctAircraft: c.distinctAircraft,
        dropEvents: c.dropEvents,
        fill: GNSS_FILL[c.severityColor] ?? "#6b7280",
        opacity: GNSS_OPACITY[c.confidence] ?? 0.1,
      },
      geometry: c.polygon,
    })),
  };
}

function gapsData(gaps: AisGap[] | null): GeoJSON.FeatureCollection {
  if (!gaps || !gaps.length) return EMPTY;
  return {
    type: "FeatureCollection",
    features: gaps
      .filter((g) => Number.isFinite(g.latitude) && Number.isFinite(g.longitude))
      .map((g) => ({
        type: "Feature",
        properties: { mmsi: g.mmsi, name: g.name, confidence: g.confidence, minutesAgo: g.minutesAgo, tier: g.tier },
        geometry: { type: "Point", coordinates: [g.longitude, g.latitude] },
      })),
  };
}

export default function MapView({
  vessels,
  selection,
  track,
  gaps,
  gnss,
  regions,
  selectedRegionIds,
  onRegionClick,
  pois,
  onPoiClick,
  onMapClick,
  onViewportChange,
  aisVisible,
  boxSelectMode,
  pickMode,
  onVesselClick,
  onBoxSelect,
  flyTo,
  drawBoxMode = false,
  drawVertices = null,
  onBoxDrawn,
  footprint = null,
  pathMode = false,
  pathVertices = null,
  onPathPoint,
}: {
  vessels: VesselPosition[];
  selection: Selection;
  track: [number, number][] | null;
  gaps: AisGap[] | null;
  gnss: GnssCellView[] | null;
  regions: RegionPoly[] | null;
  selectedRegionIds: string[];
  onRegionClick: (id: string) => void;
  pois: Poi[] | null;
  onPoiClick: (poi: Poi) => void;
  onMapClick: (lng: number, lat: number) => void;
  onViewportChange: (b: ViewportBbox | null) => void;
  aisVisible: boolean;
  boxSelectMode: boolean;
  pickMode: boolean;
  onVesselClick: (v: PickedVessel) => void;
  onBoxSelect: (vessels: PickedVessel[]) => void;
  flyTo?: FlyTo;
  drawBoxMode?: boolean;
  drawVertices?: [number, number][] | null;
  onBoxDrawn?: (bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number }) => void;
  footprint?: Footprint;
  pathMode?: boolean;
  pathVertices?: [number, number][] | null;
  onPathPoint?: (lng: number, lat: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const fittedRef = useRef(false);
  const onMapClickRef = useRef(onMapClick);
  const onVesselClickRef = useRef(onVesselClick);
  const onBoxSelectRef = useRef(onBoxSelect);
  const onPoiClickRef = useRef(onPoiClick);
  const onViewportChangeRef = useRef(onViewportChange);
  const onRegionClickRef = useRef(onRegionClick);
  const boxModeRef = useRef(boxSelectMode);
  const pickModeRef = useRef(pickMode);
  const drawBoxModeRef = useRef(drawBoxMode);
  const onBoxDrawnRef = useRef(onBoxDrawn);
  const pathModeRef = useRef(pathMode);
  const onPathPointRef = useRef(onPathPoint);
  const fittedRegionsRef = useRef<string>("");
  const lastFlyKeyRef = useRef<number>(0);
  useEffect(() => { onMapClickRef.current = onMapClick; }, [onMapClick]);
  useEffect(() => { onVesselClickRef.current = onVesselClick; }, [onVesselClick]);
  useEffect(() => { onBoxSelectRef.current = onBoxSelect; }, [onBoxSelect]);
  useEffect(() => { onPoiClickRef.current = onPoiClick; }, [onPoiClick]);
  useEffect(() => { onViewportChangeRef.current = onViewportChange; }, [onViewportChange]);
  useEffect(() => { onRegionClickRef.current = onRegionClick; }, [onRegionClick]);
  useEffect(() => { boxModeRef.current = boxSelectMode; }, [boxSelectMode]);
  useEffect(() => { pickModeRef.current = pickMode; }, [pickMode]);
  useEffect(() => { drawBoxModeRef.current = drawBoxMode; }, [drawBoxMode]);
  useEffect(() => { onBoxDrawnRef.current = onBoxDrawn; }, [onBoxDrawn]);
  useEffect(() => { pathModeRef.current = pathMode; }, [pathMode]);
  useEffect(() => { onPathPointRef.current = onPathPoint; }, [onPathPoint]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const view = loadView();
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/dark-v11",
      center: view?.center ?? [43.4, 12.6],
      zoom: view?.zoom ?? 5,
      bearing: view?.bearing ?? 0,
      pitch: view?.pitch ?? 0,
    });
    if (view) fittedRef.current = true;
    map.addControl(new mapboxgl.NavigationControl(), "top-right");
    // Emit the current viewport (outward-rounded to 0.1° to bound refetch churn) so the
    // backend returns only in-view vessels. World-spanning view → null (global, capped).
    const emitViewport = () => {
      const b = map.getBounds();
      if (!b) return;
      const west = b.getWest(), east = b.getEast(), south = b.getSouth(), north = b.getNorth();
      if (east - west >= 359 || west > east) { onViewportChangeRef.current(null); return; }
      const fl = (n: number) => Math.floor(n * 10) / 10;
      const cl = (n: number) => Math.ceil(n * 10) / 10;
      onViewportChangeRef.current({
        minLat: Math.max(-90, fl(south)), minLon: Math.max(-180, fl(west)),
        maxLat: Math.min(90, cl(north)), maxLon: Math.min(180, cl(east)),
      });
    };
    map.on("moveend", () => {
      const c = map.getCenter();
      persistView({ center: [c.lng, c.lat], zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() });
      emitViewport();
    });
    map.on("load", emitViewport);

    map.on("load", () => {
      map.resize();
      map.addSource("selection", { type: "geojson", data: EMPTY });
      map.addLayer({ id: "selection-fill", type: "fill", source: "selection", paint: { "fill-color": "#f59e0b", "fill-opacity": 0.12 } });
      map.addLayer({ id: "selection-outline", type: "line", source: "selection", paint: { "line-color": "#f59e0b", "line-width": 2 } });

      // All coverage regions — interactive (hover/click). Selected = green fill + dotted
      // border + label; unselected = invisible fill but still hoverable/clickable; hovered
      // = faint highlight. `promoteId: rid` lets feature-state track hover by region id.
      map.addSource("regions", { type: "geojson", data: EMPTY, promoteId: "rid" });
      map.addLayer({
        id: "regions-fill",
        type: "fill",
        source: "regions",
        paint: {
          "fill-color": ["coalesce", ["get", "color"], "#22c55e"],
          "fill-opacity": [
            "case",
            ["get", "selected"], 0.14,
            ["boolean", ["feature-state", "hover"], false], 0.08,
            0,
          ],
        },
      });
      map.addLayer({
        id: "regions-outline",
        type: "line",
        source: "regions",
        paint: {
          "line-color": ["coalesce", ["get", "color"], "#22c55e"],
          "line-dasharray": [2, 2],
          "line-opacity": 0.9,
          "line-width": [
            "case",
            ["get", "selected"], 1.2,
            ["boolean", ["feature-state", "hover"], false], 0.8,
            0,
          ],
        },
      });
      map.addLayer({
        id: "regions-label",
        type: "symbol",
        source: "regions",
        filter: ["get", "selected"],
        layout: { "text-field": ["get", "name"], "text-size": 11, "text-offset": [0, 0.3], "symbol-placement": "point" },
        paint: { "text-color": "#86efac", "text-halo-color": "#0b0f14", "text-halo-width": 1.2 },
      });
      // Hover → name + click hint; click → region options modal. Suppressed in pick/box mode.
      const regionPopup = new mapboxgl.Popup({ closeButton: false, offset: 8, className: "vantos-popup" });
      let hoveredRid: string | null = null;
      const clearRegionHover = () => {
        if (hoveredRid !== null) map.setFeatureState({ source: "regions", id: hoveredRid }, { hover: false });
        hoveredRid = null;
        regionPopup.remove();
      };
      map.on("mousemove", "regions-fill", (e) => {
        if (pickModeRef.current || boxModeRef.current || drawBoxModeRef.current || pathModeRef.current) return;
        const f = e.features?.[0];
        if (!f) return;
        const p = f.properties as { rid?: string; name?: string };
        const rid = p.rid ?? null;
        if (hoveredRid !== rid) {
          if (hoveredRid !== null) map.setFeatureState({ source: "regions", id: hoveredRid }, { hover: false });
          hoveredRid = rid;
          if (rid !== null) map.setFeatureState({ source: "regions", id: rid }, { hover: true });
        }
        map.getCanvas().style.cursor = "pointer";
        regionPopup
          .setLngLat(e.lngLat)
          .setHTML(`<div style="font:12px system-ui;color:#e5e7eb"><div style="font-weight:600">${p.name ?? "Region"}</div><div style="color:#9ca3af">Click for region options</div></div>`)
          .addTo(map);
      });
      map.on("mouseleave", "regions-fill", () => {
        clearRegionHover();
        map.getCanvas().style.cursor = boxModeRef.current || pickModeRef.current ? "crosshair" : "";
      });
      map.on("click", "regions-fill", (e) => {
        if (pickModeRef.current || boxModeRef.current || drawBoxModeRef.current || pathModeRef.current) return;
        // Let a more specific feature own the click if one is here.
        const hit = map.queryRenderedFeatures(e.point, { layers: ["clusters", "vessels-circle", "gaps-dot", "gnss-fill", "pois-dot"] });
        if (hit.length) return;
        const f = e.features?.[0];
        if (!f) return;
        const rid = (f.properties as { rid?: string }).rid;
        if (rid) onRegionClickRef.current(rid);
      });

      // GNSS interference (ADS-B) — 0.1° cell heatmap; severity colour × confidence opacity.
      map.addSource("gnss", { type: "geojson", data: EMPTY });
      map.addLayer({
        id: "gnss-fill",
        type: "fill",
        source: "gnss",
        paint: { "fill-color": ["get", "fill"], "fill-opacity": ["get", "opacity"] },
      });
      map.addLayer({
        id: "gnss-outline",
        type: "line",
        source: "gnss",
        paint: { "line-color": ["get", "fill"], "line-width": 0.5, "line-opacity": 0.5 },
      });
      const gnssPopup = new mapboxgl.Popup({ closeButton: false, offset: 8, className: "vantos-popup" });
      map.on("click", "gnss-fill", (e) => {
        if (drawBoxModeRef.current || pathModeRef.current) return;
        const f = e.features?.[0];
        if (!f) return;
        const p = f.properties as { region?: string; severityPct?: number; severityColor?: string; confidence?: string; distinctAircraft?: number; dropEvents?: number };
        gnssPopup
          .setLngLat(e.lngLat)
          .setHTML(
            `<div style="font:12px system-ui;color:#e5e7eb;max-width:240px">
               <div style="color:#f97316;font-weight:600">Aircraft-derived GNSS interference</div>
               <div>${p.region ?? ""} · ${p.severityPct}% degraded · ${(p.confidence ?? "").replace("_", " ")}</div>
               <div style="color:#9ca3af">${p.distinctAircraft} aircraft · ${p.dropEvents} drop events (6h)</div>
               <div style="color:#9ca3af;margin-top:3px">Indicator only — not a confirmed jamming/spoofing detection.</div>
             </div>`
          )
          .addTo(map);
      });
      map.on("mouseenter", "gnss-fill", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "gnss-fill", () => (map.getCanvas().style.cursor = boxModeRef.current || pickModeRef.current ? "crosshair" : ""));

      // Track (selected vessel movement history) — sits beneath vessel markers.
      map.addSource("track", { type: "geojson", data: EMPTY });
      map.addLayer({
        id: "track-line-glow",
        type: "line",
        source: "track",
        filter: ["==", ["geometry-type"], "LineString"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#22d3ee", "line-width": 7, "line-opacity": 0.18, "line-blur": 3 },
      });
      map.addLayer({
        id: "track-line",
        type: "line",
        source: "track",
        filter: ["==", ["geometry-type"], "LineString"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#22d3ee", "line-width": 2.5, "line-opacity": 0.9 },
      });
      map.addLayer({
        id: "track-start",
        type: "circle",
        source: "track",
        filter: ["==", ["get", "kind"], "start"],
        paint: { "circle-radius": 5, "circle-color": "#0b0f14", "circle-stroke-color": "#22d3ee", "circle-stroke-width": 2 },
      });
      map.addLayer({
        id: "track-end",
        type: "circle",
        source: "track",
        filter: ["==", ["get", "kind"], "end"],
        paint: { "circle-radius": 6, "circle-color": "#22d3ee", "circle-stroke-color": "#0b0f14", "circle-stroke-width": 2 },
      });

      // Clustered vessel source.
      map.addSource("vessels", { type: "geojson", data: EMPTY, cluster: true, clusterRadius: 50, clusterMaxZoom: 13 });
      map.addLayer({
        id: "clusters",
        type: "circle",
        source: "vessels",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": ["step", ["get", "point_count"], "#0ea5e9", 50, "#38bdf8", 250, "#7dd3fc"],
          "circle-radius": ["step", ["get", "point_count"], 12, 50, 16, 250, 22],
          "circle-opacity": 0.85,
        },
      });
      map.addLayer({
        id: "cluster-count",
        type: "symbol",
        source: "vessels",
        filter: ["has", "point_count"],
        layout: { "text-field": ["get", "point_count_abbreviated"], "text-size": 11 },
        paint: { "text-color": "#06283d" },
      });
      map.addLayer({
        id: "vessels-circle",
        type: "circle",
        source: "vessels",
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-radius": 5,
          // Fresh = cyan; stale (last fix > 6h) = muted slate.
          "circle-color": ["case", ["get", "stale"], "#64748b", "#38bdf8"],
          "circle-opacity": ["case", ["get", "stale"], 0.6, 1],
          "circle-stroke-color": "#0b0f14",
          "circle-stroke-width": 1,
        },
      });

      // AIS-gap / dark-shipping last-known-position markers (amber, above vessels).
      map.addSource("gaps", { type: "geojson", data: EMPTY });
      // Color by tier when verified (confirmed=red, active=emerald, pending/unverified=gray),
      // else by terrestrial-gap confidence (amber family).
      const gapColor: mapboxgl.ExpressionSpecification = [
        "match", ["get", "tier"],
        "confirmed", "#ef4444",
        "active", "#10b981",
        "pending", "#64748b",
        "unverified", "#64748b",
        // 'terrestrial' (unverified) → grade by confidence
        ["match", ["get", "confidence"], "high", "#f59e0b", "medium", "#f59e0b", "#a16207"],
      ];
      map.addLayer({
        id: "gaps-halo",
        type: "circle",
        source: "gaps",
        paint: { "circle-radius": 11, "circle-color": gapColor, "circle-opacity": 0.18 },
      });
      map.addLayer({
        id: "gaps-dot",
        type: "circle",
        source: "gaps",
        paint: { "circle-radius": 5, "circle-color": gapColor, "circle-stroke-color": "#0b0f14", "circle-stroke-width": 1.5 },
      });
      const gapPopup = new mapboxgl.Popup({ closeButton: false, offset: 12, className: "vantos-popup" });
      map.on("click", "gaps-dot", (e) => {
        if (drawBoxModeRef.current || pathModeRef.current) return;
        const f = e.features?.[0];
        if (!f) return;
        const p = f.properties as { mmsi?: string; name?: string; confidence?: string; minutesAgo?: number; tier?: string };
        const c = (f.geometry as GeoJSON.Point).coordinates as [number, number];
        const tier = p.tier ?? "terrestrial";
        const heading =
          tier === "confirmed" ? "Confirmed AIS gap (satellite-corroborated)"
          : tier === "active" ? "AIS active — seen on satellite"
          : tier === "pending" || tier === "unverified" ? "AIS gap — verification pending"
          : "Terrestrial AIS gap — not a confirmed detection";
        const color = tier === "confirmed" ? "#ef4444" : tier === "active" ? "#10b981" : "#f59e0b";
        gapPopup
          .setLngLat(c)
          .setHTML(
            `<div style="font:12px system-ui;color:#e5e7eb">
               <div style="color:${color};font-weight:600">${heading}</div>
               <div>${p.name || p.mmsi || "unknown"}</div>
               <div style="color:#9ca3af">last AIS ${p.minutesAgo}m ago · ${p.confidence} confidence</div>
             </div>`
          )
          .addTo(map);
      });
      map.on("mouseenter", "gaps-dot", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "gaps-dot", () => (map.getCanvas().style.cursor = boxModeRef.current || pickModeRef.current ? "crosshair" : ""));

      // POI labels (chokepoints / straits / ports) — clickable, no collection.
      map.addSource("pois", { type: "geojson", data: EMPTY });
      map.addLayer({
        id: "pois-dot",
        type: "circle",
        source: "pois",
        paint: { "circle-radius": 4, "circle-color": "#e2e8f0", "circle-stroke-color": "#0b0f14", "circle-stroke-width": 1.5 },
      });
      map.addLayer({
        id: "pois-label",
        type: "symbol",
        source: "pois",
        minzoom: 3.5,
        layout: { "text-field": ["get", "name"], "text-size": 10, "text-offset": [0, 1], "text-anchor": "top", "text-optional": true },
        paint: { "text-color": "#cbd5e1", "text-halo-color": "#0b0f14", "text-halo-width": 1.2 },
      });
      map.on("click", "pois-dot", (e) => {
        if (boxModeRef.current || drawBoxModeRef.current || pathModeRef.current) return;
        const f = e.features?.[0];
        if (!f) return;
        const p = f.properties as { id?: string; name?: string; type?: string };
        const c = (f.geometry as GeoJSON.Point).coordinates as [number, number];
        onPoiClickRef.current({ id: p.id ?? "", name: p.name ?? "", type: p.type ?? "", lng: c[0], lat: c[1] });
      });
      map.on("mouseenter", "pois-dot", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "pois-dot", () => (map.getCanvas().style.cursor = boxModeRef.current || pickModeRef.current ? "crosshair" : ""));

      // Click a cluster → zoom in.
      map.on("click", "clusters", (e) => {
        if (drawBoxModeRef.current || pathModeRef.current) return;
        const f = map.queryRenderedFeatures(e.point, { layers: ["clusters"] })[0];
        if (!f) return;
        const clusterId = (f.properties as { cluster_id: number }).cluster_id;
        const src = map.getSource("vessels") as mapboxgl.GeoJSONSource;
        // mapbox-gl v3 returns a Promise; @types/mapbox-gl still types the old callback form.
        const getZoom = src.getClusterExpansionZoom as unknown as (id: number) => Promise<number>;
        getZoom(clusterId).then((zoom: number) => {
          map.easeTo({ center: (f.geometry as GeoJSON.Point).coordinates as [number, number], zoom });
        }).catch(() => undefined);
      });
      // Click a single vessel → select.
      map.on("click", "vessels-circle", (e) => {
        if (boxModeRef.current || drawBoxModeRef.current || pathModeRef.current) return;
        const f = e.features?.[0];
        if (!f) return;
        const p = f.properties as { mmsi?: string; name?: string };
        onVesselClickRef.current({ mmsi: p.mmsi ?? null, name: p.name ?? null });
      });
      for (const lyr of ["clusters", "vessels-circle"]) {
        map.on("mouseenter", lyr, () => (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", lyr, () => (map.getCanvas().style.cursor = boxModeRef.current || pickModeRef.current ? "crosshair" : ""));
      }
      // Collection footprint (bbox + satellite tile circles) for the inspected region.
      map.addSource("footprint", { type: "geojson", data: EMPTY });
      map.addLayer({
        id: "footprint-tiles", type: "line", source: "footprint",
        filter: ["==", ["get", "kind"], "tile"],
        paint: { "line-color": "#34d399", "line-width": 1, "line-dasharray": [2, 2], "line-opacity": 0.8 },
      });
      map.addLayer({
        id: "footprint-bbox", type: "line", source: "footprint",
        filter: ["==", ["get", "kind"], "bbox"],
        paint: { "line-color": "#f8fafc", "line-width": 1.5, "line-dasharray": [4, 3], "line-opacity": 0.7 },
      });
      map.addLayer({
        id: "footprint-path", type: "line", source: "footprint",
        filter: ["==", ["get", "kind"], "path"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#34d399", "line-width": 2, "line-opacity": 0.9 },
      });

      // In-progress footprint path (operator drawing the corridor).
      map.addSource("path", { type: "geojson", data: EMPTY });
      map.addLayer({
        id: "path-line", type: "line", source: "path",
        filter: ["==", ["geometry-type"], "LineString"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#38bdf8", "line-width": 2 },
      });
      map.addLayer({
        id: "path-verts", type: "circle", source: "path",
        filter: ["==", ["geometry-type"], "Point"],
        paint: { "circle-radius": 4, "circle-color": "#0b0f14", "circle-stroke-color": "#38bdf8", "circle-stroke-width": 2 },
      });

      // In-progress custom-region polygon (drawn vertices live in Workspace state).
      map.addSource("draw", { type: "geojson", data: EMPTY });
      map.addLayer({
        id: "draw-fill", type: "fill", source: "draw",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "fill-color": "#38bdf8", "fill-opacity": 0.15 },
      });
      map.addLayer({
        id: "draw-line", type: "line", source: "draw",
        filter: ["==", ["geometry-type"], "LineString"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#38bdf8", "line-width": 2 },
      });
      map.addLayer({
        id: "draw-verts", type: "circle", source: "draw",
        filter: ["==", ["geometry-type"], "Point"],
        paint: { "circle-radius": 4, "circle-color": "#0b0f14", "circle-stroke-color": "#38bdf8", "circle-stroke-width": 2 },
      });

      // Click empty map → in draw mode add a polygon vertex; otherwise drop a search center.
      map.on("click", (e) => {
        if (pathModeRef.current) { onPathPointRef.current?.(e.lngLat.lng, e.lngLat.lat); return; }
        if (drawBoxModeRef.current || pathModeRef.current) return; // box drawing is handled by the drag handler
        if (boxModeRef.current) return;
        const hit = map.queryRenderedFeatures(e.point, { layers: ["clusters", "vessels-circle"] });
        if (hit.length) return;
        onMapClickRef.current(e.lngLat.lng, e.lngLat.lat);
      });
    });

    // Box-select (drag a rectangle in box mode) → unclustered vessels inside.
    const canvas = map.getCanvasContainer();
    let boxEl: HTMLDivElement | null = null;
    let startPt: mapboxgl.Point | null = null;
    const pos = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      return new mapboxgl.Point(e.clientX - rect.left, e.clientY - rect.top);
    };
    const onMove = (e: MouseEvent) => {
      if (!startPt) return;
      const cur = pos(e);
      if (!boxEl) {
        boxEl = document.createElement("div");
        boxEl.style.cssText = "position:absolute;background:rgba(56,189,248,0.12);border:1px solid #38bdf8;pointer-events:none;z-index:5;";
        canvas.appendChild(boxEl);
      }
      boxEl.style.left = `${Math.min(startPt.x, cur.x)}px`;
      boxEl.style.top = `${Math.min(startPt.y, cur.y)}px`;
      boxEl.style.width = `${Math.abs(cur.x - startPt.x)}px`;
      boxEl.style.height = `${Math.abs(cur.y - startPt.y)}px`;
    };
    const onUp = (e: MouseEvent) => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      const cur = pos(e);
      if (boxEl) { boxEl.remove(); boxEl = null; }
      map.dragPan.enable();
      const start = startPt;
      startPt = null;
      if (!start) return;
      // Region box-draw: convert the dragged rectangle to a geographic bbox.
      if (drawBoxModeRef.current) {
        if (Math.abs(cur.x - start.x) < 6 || Math.abs(cur.y - start.y) < 6) return; // ignore tiny drags
        const a = map.unproject(start), b = map.unproject(cur);
        onBoxDrawnRef.current?.({
          minLat: Math.min(a.lat, b.lat), maxLat: Math.max(a.lat, b.lat),
          minLon: Math.min(a.lng, b.lng), maxLon: Math.max(a.lng, b.lng),
        });
        return;
      }
      const feats = map.queryRenderedFeatures([start, cur], { layers: ["vessels-circle"] });
      const seen = new Set<string>();
      const out: PickedVessel[] = [];
      feats.forEach((f) => {
        const p = f.properties as { mmsi?: string; name?: string };
        const key = String(p.mmsi ?? Math.random());
        if (!seen.has(key)) { seen.add(key); out.push({ mmsi: p.mmsi ?? null, name: p.name ?? null }); }
      });
      if (out.length) onBoxSelectRef.current(out);
    };
    const onDown = (e: MouseEvent) => {
      if (!(boxModeRef.current || drawBoxModeRef.current) || e.button !== 0) return;
      e.preventDefault();
      map.dragPan.disable();
      startPt = pos(e);
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    };
    canvas.addEventListener("mousedown", onDown);

    const resizeTimer = setTimeout(() => map.resize(), 300);
    mapRef.current = map;
    return () => {
      clearTimeout(resizeTimer);
      canvas.removeEventListener("mousedown", onDown);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource("vessels") as mapboxgl.GeoJSONSource | undefined;
      if (src) src.setData(toVesselGeoJSON(vessels));
      if (!fittedRef.current && vessels.length) {
        const bounds = new mapboxgl.LngLatBounds();
        vessels.forEach((v) => {
          if (Number.isFinite(v.latitude) && Number.isFinite(v.longitude)) bounds.extend([v.longitude, v.latitude]);
        });
        if (!bounds.isEmpty()) { map.fitBounds(bounds, { padding: 80, maxZoom: 8, duration: 0 }); fittedRef.current = true; }
      }
    };
    if (map.getSource("vessels")) apply();
    else map.once("load", apply);
  }, [vessels]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource("selection") as mapboxgl.GeoJSONSource | undefined;
      if (!src) return;
      src.setData(selection ? { type: "FeatureCollection", features: [circleFeature(selection.lng, selection.lat, selection.radiusKm)] } : EMPTY);
    };
    if (map.getSource("selection")) apply();
    else map.once("load", apply);
  }, [selection]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource("track") as mapboxgl.GeoJSONSource | undefined;
      if (src) src.setData(trackData(track));
    };
    if (map.getSource("track")) apply();
    else map.once("load", apply);
  }, [track]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource("gaps") as mapboxgl.GeoJSONSource | undefined;
      if (src) src.setData(gapsData(gaps));
    };
    if (map.getSource("gaps")) apply();
    else map.once("load", apply);
  }, [gaps]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource("gnss") as mapboxgl.GeoJSONSource | undefined;
      if (src) src.setData(gnssData(gnss));
    };
    if (map.getSource("gnss")) apply();
    else map.once("load", apply);
  }, [gnss]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource("regions") as mapboxgl.GeoJSONSource | undefined;
      if (src) src.setData(regionsData(regions, selectedRegionIds));
      // Fly/fit to the selection when the set of selected regions changes.
      const selected = (regions ?? []).filter((r) => selectedRegionIds.includes(r.id));
      const sig = selected.map((p) => p.id).sort().join(",");
      if (sig && sig !== fittedRegionsRef.current) {
        const b = new mapboxgl.LngLatBounds();
        selected.forEach((p) => {
          b.extend([p.bbox.minLon, p.bbox.minLat]);
          b.extend([p.bbox.maxLon, p.bbox.maxLat]);
        });
        if (!b.isEmpty()) map.fitBounds(b, { padding: 60, maxZoom: 7, duration: 600 });
      }
      fittedRegionsRef.current = sig;
    };
    if (map.getSource("regions")) apply();
    else map.once("load", apply);
  }, [regions, selectedRegionIds]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource("pois") as mapboxgl.GeoJSONSource | undefined;
      if (src) src.setData(poisData(pois));
    };
    if (map.getSource("pois")) apply();
    else map.once("load", apply);
  }, [pois]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      for (const lyr of VESSEL_LAYERS) {
        if (map.getLayer(lyr)) map.setLayoutProperty(lyr, "visibility", aisVisible ? "visible" : "none");
      }
    };
    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
  }, [aisVisible]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource("draw") as mapboxgl.GeoJSONSource | undefined;
      if (src) src.setData(drawData(drawVertices));
    };
    if (map.getSource("draw")) apply();
    else map.once("load", apply);
  }, [drawVertices]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource("footprint") as mapboxgl.GeoJSONSource | undefined;
      if (src) src.setData(footprintData(footprint));
    };
    if (map.getSource("footprint")) apply();
    else map.once("load", apply);
  }, [footprint]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource("path") as mapboxgl.GeoJSONSource | undefined;
      if (src) src.setData(pathData(pathVertices));
    };
    if (map.getSource("path")) apply();
    else map.once("load", apply);
  }, [pathVertices]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.getCanvas().style.cursor = boxSelectMode || pickMode || drawBoxMode || pathMode ? "crosshair" : "";
  }, [boxSelectMode, pickMode, drawBoxMode, pathMode]);

  // Snap to a vessel chosen from a list. Bumping flyTo.key re-triggers the ease.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !flyTo || flyTo.key === lastFlyKeyRef.current) return;
    lastFlyKeyRef.current = flyTo.key;
    fittedRef.current = true; // an explicit fly overrides the initial auto-fit-to-vessels
    const go = () => map.easeTo({ center: [flyTo.lng, flyTo.lat], zoom: flyTo.zoom ?? Math.max(map.getZoom(), 9), duration: 800 });
    if (map.isStyleLoaded()) go();
    else map.once("load", go);
  }, [flyTo]);

  return <div ref={containerRef} className="absolute inset-0" style={{ minHeight: "100%" }} />;
}
