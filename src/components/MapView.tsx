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

  // Latest callbacks/flags via refs so the once-initialized handlers stay current.
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
    if (savedView) fittedRef.current = true; // don't auto-fit if we're restoring a view
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
      map.addSource("vessels", { type: "geojson", data: EMPTY });
      map.addLayer({
        id: "vessels-circle",
        type: "circle",
        source: "vessels",
        paint: { "circle-radius": 5, "circle-color": "#38bdf8", "circle-stroke-color": "#0b0f14", "circle-stroke-width": 1 },
      });
      map.on("click", "vessels-circle", (e) => {
        if (boxModeRef.current) return;
        const f = e.features?.[0];
        if (!f) return;
        const p = f.properties as { mmsi?: string; name?: string };
        onVesselClickRef.current({ mmsi: p.mmsi ?? null, name: p.name ?? null });
      });
      map.on("mouseenter", "vessels-circle", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "vessels-circle", () => (map.getCanvas().style.cursor = ""));
      map.on("click", (e) => {
        if (boxModeRef.current) return;
        const hit = map.queryRenderedFeatures(e.point, { layers: ["vessels-circle"] });
        if (hit.length) return;
        onMapClickRef.current(e.lngLat.lng, e.lngLat.lat);
      });
    });

    // Box-select: drag a rectangle while in box mode → vessels inside.
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
        boxEl.style.cssText =
          "position:absolute;background:rgba(56,189,248,0.12);border:1px solid #38bdf8;pointer-events:none;z-index:5;";
        canvas.appendChild(boxEl);
      }
      const minX = Math.min(startPt.x, cur.x);
      const minY = Math.min(startPt.y, cur.y);
      boxEl.style.left = `${minX}px`;
      boxEl.style.top = `${minY}px`;
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
      const bbox: [mapboxgl.PointLike, mapboxgl.PointLike] = [start, cur];
      const feats = map.queryRenderedFeatures(bbox, { layers: ["vessels-circle"] });
      const seen = new Set<string>();
      const out: PickedVessel[] = [];
      feats.forEach((f) => {
        const p = f.properties as { mmsi?: string; name?: string };
        const key = String(p.mmsi ?? Math.random());
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ mmsi: p.mmsi ?? null, name: p.name ?? null });
        }
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

  // Vessel data + one-time fit.
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
        if (!bounds.isEmpty()) {
          map.fitBounds(bounds, { padding: 80, maxZoom: 8, duration: 0 });
          fittedRef.current = true;
        }
      }
    };
    if (map.getSource("vessels")) apply();
    else map.once("load", apply);
  }, [vessels]);

  // Selection circle.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource("selection") as mapboxgl.GeoJSONSource | undefined;
      if (!src) return;
      src.setData(
        selection
          ? { type: "FeatureCollection", features: [circleFeature(selection.lng, selection.lat, selection.radiusKm)] }
          : EMPTY
      );
    };
    if (map.getSource("selection")) apply();
    else map.once("load", apply);
  }, [selection]);

  // AIS layer visibility.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      if (map.getLayer("vessels-circle")) {
        map.setLayoutProperty("vessels-circle", "visibility", aisVisible ? "visible" : "none");
      }
    };
    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
  }, [aisVisible]);

  // Box-select mode cursor.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.getCanvas().style.cursor = boxSelectMode ? "crosshair" : "";
  }, [boxSelectMode]);

  return <div ref={containerRef} className="absolute inset-0" style={{ minHeight: "100%" }} />;
}
