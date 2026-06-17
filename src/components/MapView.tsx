import { useEffect, useRef } from "react";
import mapboxgl from "mapbox-gl";
import type { VesselPosition, AisGap } from "../lib/api";

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN ?? "";

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

export type Selection = { lng: number; lat: number; radiusKm: number } | null;
export type PickedVessel = { mmsi: string | null; name: string | null };
export type RegionPoly = { id: string; name: string; bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number } };
export type Poi = { id: string; name: string; type: string; lng: number; lat: number };
export type GnssPoint = { lng: number; lat: number; region: string; fraction: number; confidence: string; observed: number; degraded: number };

// Persist the map view across tab switches (module-level survives unmount within the session).
type View = { center: [number, number]; zoom: number; bearing: number; pitch: number };
let savedView: View | null = null;

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

function regionPolysData(polys: RegionPoly[] | null): GeoJSON.FeatureCollection {
  if (!polys || !polys.length) return EMPTY;
  return {
    type: "FeatureCollection",
    features: polys.map((p) => {
      const { minLat, minLon, maxLat, maxLon } = p.bbox;
      const ring: [number, number][] = [
        [minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat],
      ];
      return { type: "Feature", properties: { id: p.id, name: p.name }, geometry: { type: "Polygon", coordinates: [ring] } };
    }),
  };
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

function gnssData(items: GnssPoint[] | null): GeoJSON.FeatureCollection {
  if (!items || !items.length) return EMPTY;
  return {
    type: "FeatureCollection",
    features: items
      .filter((g) => Number.isFinite(g.lng) && Number.isFinite(g.lat) && (g.confidence === "low" || g.confidence === "medium" || g.confidence === "high"))
      .map((g) => ({
        type: "Feature",
        properties: { region: g.region, fraction: g.fraction, confidence: g.confidence, observed: g.observed, degraded: g.degraded },
        geometry: { type: "Point", coordinates: [g.lng, g.lat] },
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
  regionPolys,
  pois,
  onPoiClick,
  onMapClick,
  aisVisible,
  boxSelectMode,
  onVesselClick,
  onBoxSelect,
}: {
  vessels: VesselPosition[];
  selection: Selection;
  track: [number, number][] | null;
  gaps: AisGap[] | null;
  gnss: GnssPoint[] | null;
  regionPolys: RegionPoly[] | null;
  pois: Poi[] | null;
  onPoiClick: (poi: Poi) => void;
  onMapClick: (lng: number, lat: number) => void;
  aisVisible: boolean;
  boxSelectMode: boolean;
  onVesselClick: (v: PickedVessel) => void;
  onBoxSelect: (vessels: PickedVessel[]) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const fittedRef = useRef(false);
  const onMapClickRef = useRef(onMapClick);
  const onVesselClickRef = useRef(onVesselClick);
  const onBoxSelectRef = useRef(onBoxSelect);
  const onPoiClickRef = useRef(onPoiClick);
  const boxModeRef = useRef(boxSelectMode);
  const fittedRegionsRef = useRef<string>("");
  useEffect(() => { onMapClickRef.current = onMapClick; }, [onMapClick]);
  useEffect(() => { onVesselClickRef.current = onVesselClick; }, [onVesselClick]);
  useEffect(() => { onBoxSelectRef.current = onBoxSelect; }, [onBoxSelect]);
  useEffect(() => { onPoiClickRef.current = onPoiClick; }, [onPoiClick]);
  useEffect(() => { boxModeRef.current = boxSelectMode; }, [boxSelectMode]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/dark-v11",
      center: savedView?.center ?? [43.4, 12.6],
      zoom: savedView?.zoom ?? 5,
      bearing: savedView?.bearing ?? 0,
      pitch: savedView?.pitch ?? 0,
    });
    if (savedView) fittedRef.current = true;
    map.addControl(new mapboxgl.NavigationControl(), "top-right");
    map.on("moveend", () => {
      const c = map.getCenter();
      savedView = { center: [c.lng, c.lat], zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
    });

    map.on("load", () => {
      map.resize();
      map.addSource("selection", { type: "geojson", data: EMPTY });
      map.addLayer({ id: "selection-fill", type: "fill", source: "selection", paint: { "fill-color": "#f59e0b", "fill-opacity": 0.12 } });
      map.addLayer({ id: "selection-outline", type: "line", source: "selection", paint: { "line-color": "#f59e0b", "line-width": 2 } });

      // Selected coverage regions — semi-transparent green fill + thin dotted border.
      map.addSource("regions", { type: "geojson", data: EMPTY });
      map.addLayer({ id: "regions-fill", type: "fill", source: "regions", paint: { "fill-color": "#22c55e", "fill-opacity": 0.12 } });
      map.addLayer({
        id: "regions-outline",
        type: "line",
        source: "regions",
        paint: { "line-color": "#22c55e", "line-width": 1.2, "line-dasharray": [2, 2], "line-opacity": 0.9 },
      });
      map.addLayer({
        id: "regions-label",
        type: "symbol",
        source: "regions",
        layout: { "text-field": ["get", "name"], "text-size": 11, "text-offset": [0, 0.3], "symbol-placement": "point" },
        paint: { "text-color": "#86efac", "text-halo-color": "#0b0f14", "text-halo-width": 1.2 },
      });

      // GNSS interference indicators (ADS-B) — area overlay at the region center.
      const gnssColor: mapboxgl.ExpressionSpecification = ["match", ["get", "confidence"], "high", "#ef4444", "medium", "#f97316", "#eab308"];
      map.addSource("gnss", { type: "geojson", data: EMPTY });
      map.addLayer({
        id: "gnss-halo",
        type: "circle",
        source: "gnss",
        paint: { "circle-radius": 26, "circle-color": gnssColor, "circle-opacity": 0.16, "circle-stroke-color": gnssColor, "circle-stroke-width": 1.5, "circle-stroke-opacity": 0.6 },
      });
      map.addLayer({
        id: "gnss-label",
        type: "symbol",
        source: "gnss",
        layout: { "text-field": ["concat", "GNSS · ", ["get", "region"]], "text-size": 10, "text-offset": [0, 2.2] },
        paint: { "text-color": "#fca5a5", "text-halo-color": "#0b0f14", "text-halo-width": 1.2 },
      });
      const gnssPopup = new mapboxgl.Popup({ closeButton: false, offset: 14, className: "vantos-popup" });
      map.on("click", "gnss-halo", (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const p = f.properties as { region?: string; fraction?: number; confidence?: string; observed?: number; degraded?: number };
        const c = (f.geometry as GeoJSON.Point).coordinates as [number, number];
        gnssPopup
          .setLngLat(c)
          .setHTML(
            `<div style="font:12px system-ui;color:#e5e7eb;max-width:230px">
               <div style="color:#f97316;font-weight:600">Possible GNSS interference</div>
               <div>${p.region ?? ""} · ${Math.round((p.fraction ?? 0) * 100)}% degraded (${p.degraded}/${p.observed} aircraft) · ${p.confidence}</div>
               <div style="color:#9ca3af;margin-top:3px">Indicator only — not a confirmed jamming/spoofing detection.</div>
             </div>`
          )
          .addTo(map);
      });
      map.on("mouseenter", "gnss-halo", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "gnss-halo", () => (map.getCanvas().style.cursor = boxModeRef.current ? "crosshair" : ""));

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
      map.on("mouseleave", "gaps-dot", () => (map.getCanvas().style.cursor = boxModeRef.current ? "crosshair" : ""));

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
        if (boxModeRef.current) return;
        const f = e.features?.[0];
        if (!f) return;
        const p = f.properties as { id?: string; name?: string; type?: string };
        const c = (f.geometry as GeoJSON.Point).coordinates as [number, number];
        onPoiClickRef.current({ id: p.id ?? "", name: p.name ?? "", type: p.type ?? "", lng: c[0], lat: c[1] });
      });
      map.on("mouseenter", "pois-dot", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "pois-dot", () => (map.getCanvas().style.cursor = boxModeRef.current ? "crosshair" : ""));

      // Click a cluster → zoom in.
      map.on("click", "clusters", (e) => {
        const f = map.queryRenderedFeatures(e.point, { layers: ["clusters"] })[0];
        if (!f) return;
        const clusterId = (f.properties as { cluster_id: number }).cluster_id;
        const src = map.getSource("vessels") as mapboxgl.GeoJSONSource;
        src.getClusterExpansionZoom(clusterId).then((zoom) => {
          map.easeTo({ center: (f.geometry as GeoJSON.Point).coordinates as [number, number], zoom });
        }).catch(() => undefined);
      });
      // Click a single vessel → select.
      map.on("click", "vessels-circle", (e) => {
        if (boxModeRef.current) return;
        const f = e.features?.[0];
        if (!f) return;
        const p = f.properties as { mmsi?: string; name?: string };
        onVesselClickRef.current({ mmsi: p.mmsi ?? null, name: p.name ?? null });
      });
      for (const lyr of ["clusters", "vessels-circle"]) {
        map.on("mouseenter", lyr, () => (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", lyr, () => (map.getCanvas().style.cursor = boxModeRef.current ? "crosshair" : ""));
      }
      // Click empty map → drop a search center.
      map.on("click", (e) => {
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
      if (!boxModeRef.current || e.button !== 0) return;
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
      if (src) src.setData(regionPolysData(regionPolys));
      // Fly/fit to the selection when the set of selected regions changes.
      const sig = (regionPolys ?? []).map((p) => p.id).sort().join(",");
      if (sig && sig !== fittedRegionsRef.current && regionPolys && regionPolys.length) {
        const b = new mapboxgl.LngLatBounds();
        regionPolys.forEach((p) => {
          b.extend([p.bbox.minLon, p.bbox.minLat]);
          b.extend([p.bbox.maxLon, p.bbox.maxLat]);
        });
        if (!b.isEmpty()) map.fitBounds(b, { padding: 60, maxZoom: 7, duration: 600 });
      }
      fittedRegionsRef.current = sig;
    };
    if (map.getSource("regions")) apply();
    else map.once("load", apply);
  }, [regionPolys]);

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
    map.getCanvas().style.cursor = boxSelectMode ? "crosshair" : "";
  }, [boxSelectMode]);

  return <div ref={containerRef} className="absolute inset-0" style={{ minHeight: "100%" }} />;
}
