import { useEffect, useRef } from "react";
import mapboxgl from "mapbox-gl";
import type { VesselPosition } from "../lib/api";

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN ?? "";

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

function toGeoJSON(vessels: VesselPosition[]): GeoJSON.FeatureCollection {
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

export default function MapView({ vessels }: { vessels: VesselPosition[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);

  // Create the map once.
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
      if (!map.getSource("vessels")) {
        map.addSource("vessels", { type: "geojson", data: EMPTY });
        map.addLayer({
          id: "vessels-circle",
          type: "circle",
          source: "vessels",
          paint: {
            "circle-radius": 5,
            "circle-color": "#38bdf8",
            "circle-stroke-color": "#0b0f14",
            "circle-stroke-width": 1,
          },
        });
        map.on("click", "vessels-circle", (e) => {
          const f = e.features?.[0];
          if (!f) return;
          const p = f.properties as { mmsi?: string; name?: string; dataSource?: string };
          const coords = (f.geometry as GeoJSON.Point).coordinates as [number, number];
          new mapboxgl.Popup()
            .setLngLat(coords)
            .setHTML(
              `<div style="color:#111;font:12px sans-serif"><b>${p.name || p.mmsi || "Vessel"}</b><br/>MMSI ${p.mmsi || "—"}${p.dataSource ? `<br/>${p.dataSource}` : ""}</div>`
            )
            .addTo(map);
        });
        map.on("mouseenter", "vessels-circle", () => (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", "vessels-circle", () => (map.getCanvas().style.cursor = ""));
      }
    });
    const resizeTimer = setTimeout(() => map.resize(), 300);
    mapRef.current = map;
    return () => {
      clearTimeout(resizeTimer);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Push vessel data into the source whenever it changes (and once the style is ready).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource("vessels") as mapboxgl.GeoJSONSource | undefined;
      if (src) src.setData(toGeoJSON(vessels));
    };
    if (map.getSource("vessels")) apply();
    else map.once("load", apply);
  }, [vessels]);

  return <div ref={containerRef} className="absolute inset-0" style={{ minHeight: "100%" }} />;
}
