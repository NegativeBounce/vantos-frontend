import { useEffect, useRef } from "react";
import mapboxgl from "mapbox-gl";
import type { VesselPosition } from "../lib/api";

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN ?? "";

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

export type Selection = { lng: number; lat: number; radiusKm: number } | null;

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

// Equirectangular-approx circle polygon (good enough at <=50km).
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
}: {
  vessels: VesselPosition[];
  selection: Selection;
  onMapClick: (lng: number, lat: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const fittedRef = useRef(false);
  const onClickRef = useRef(onMapClick);
  useEffect(() => {
    onClickRef.current = onMapClick;
  }, [onMapClick]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/dark-v11",
      center: [43.4, 12.6],
      zoom: 5,
    });
    map.addControl(new mapboxgl.NavigationControl(), "top-right");
    map.on("load", () => {
      map.resize();
      // Selection circle (under vessels).
      map.addSource("selection", { type: "geojson", data: EMPTY });
      map.addLayer({ id: "selection-fill", type: "fill", source: "selection", paint: { "fill-color": "#f59e0b", "fill-opacity": 0.12 } });
      map.addLayer({ id: "selection-outline", type: "line", source: "selection", paint: { "line-color": "#f59e0b", "line-width": 2 } });
      // Vessels.
      map.addSource("vessels", { type: "geojson", data: EMPTY });
      map.addLayer({
        id: "vessels-circle",
        type: "circle",
        source: "vessels",
        paint: { "circle-radius": 5, "circle-color": "#38bdf8", "circle-stroke-color": "#0b0f14", "circle-stroke-width": 1 },
      });
      map.on("click", "vessels-circle", (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const p = f.properties as { mmsi?: string; name?: string; dataSource?: string };
        const coords = (f.geometry as GeoJSON.Point).coordinates as [number, number];
        new mapboxgl.Popup()
          .setLngLat(coords)
          .setHTML(`<div style="color:#111;font:12px sans-serif"><b>${p.name || p.mmsi || "Vessel"}</b><br/>MMSI ${p.mmsi || "—"}${p.dataSource ? `<br/>${p.dataSource}` : ""}</div>`)
          .addTo(map);
      });
      map.on("mouseenter", "vessels-circle", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "vessels-circle", () => (map.getCanvas().style.cursor = ""));
      // Click empty map = drop a selection center (ignore clicks on a vessel).
      map.on("click", (e) => {
        const hit = map.queryRenderedFeatures(e.point, { layers: ["vessels-circle"] });
        if (hit.length) return;
        onClickRef.current(e.lngLat.lng, e.lngLat.lat);
      });
    });
    const resizeTimer = setTimeout(() => map.resize(), 300);
    mapRef.current = map;
    return () => {
      clearTimeout(resizeTimer);
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

  return <div ref={containerRef} className="absolute inset-0" style={{ minHeight: "100%" }} />;
}
