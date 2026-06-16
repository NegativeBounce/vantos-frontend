import { useEffect, useRef } from "react";
import mapboxgl from "mapbox-gl";
import type { VesselPosition } from "../lib/api";

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN ?? "";

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

export type Selection = { lng: number; lat: number; radiusKm: number } | null;
export type PickedVessel = { mmsi: string | null; name: string | null };

// Persist the map view across tab switches (module-level survives unmount within the session).
type View = { center: [number, number]; zoom: number; bearing: number; pitch: number };
let savedView: View | null = null;

const VESSEL_LAYERS = ["clusters", "cluster-count", "vessels-circle"];

function toVesselGeoJSON(vessels: VesselPosition[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: vessels
      .filter((v) => Number.isFinite(v.latitude) && Number.isFinite(v.longitude))
      .map((v) => ({
        type: "Feature",
        properties: { mmsi: v.mmsi, name: v.name, type: v.type, dataSource: v.dataSource },
        geometry: { type: "Point", coordinates: [v.longitude, v.latitude] },
      })),
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

export default function MapView({
  vessels,
  selection,
  onMapClick,
  aisVisible,
  boxSelectMode,
  onVesselClick,
  onBoxSelect,
}: {
  vessels: VesselPosition[];
  selection: Selection;
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
  const boxModeRef = useRef(boxSelectMode);
  useEffect(() => { onMapClickRef.current = onMapClick; }, [onMapClick]);
  useEffect(() => { onVesselClickRef.current = onVesselClick; }, [onVesselClick]);
  useEffect(() => { onBoxSelectRef.current = onBoxSelect; }, [onBoxSelect]);
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
        paint: { "circle-radius": 5, "circle-color": "#38bdf8", "circle-stroke-color": "#0b0f14", "circle-stroke-width": 1 },
      });

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
