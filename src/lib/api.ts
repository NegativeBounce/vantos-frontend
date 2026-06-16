// Topology A: the frontend and backend share one App Platform app, so we call the
// backend at /api (same origin). VITE_API_BASE_URL can override for separate-app setups.
const BASE = import.meta.env.VITE_API_BASE_URL ?? "";

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export type Health = { status: string; env: string; time: string };
export const getHealth = () => apiGet<Health>("/healthz");

export type Region = {
  id: string;
  name: string;
  type: string;
  riskLevel: string | null;
  boundingBox: { minLat: number; minLon: number; maxLat: number; maxLon: number } | null;
};
export const getRegions = () => apiGet<{ status: string; regions: Region[] }>("/api/regions");

export type VesselPosition = {
  mmsi: string | null;
  name: string | null;
  type: string | null;
  latitude: number;
  longitude: number;
  speed: number | null;
  navStatus: string | null;
  dataSource: string | null;
};
export const getPositions = () =>
  apiGet<{ status: string; count: number; vessels: VesselPosition[] }>("/api/positions");

export type DataSource = {
  id: string;
  provider: string;
  name: string;
  baseUrl: string | null;
  authType: string;
  status: string;
  keyHint: string | null;
  updatedAt: string;
};
export const getDataSources = () =>
  apiGet<{ status: string; dataSources: DataSource[] }>("/api/data-sources");

export type AreaSearchResult = {
  status: string;
  region?: string;
  center?: { latitude: number; longitude: number };
  radiusKm?: number;
  fetched?: number;
  stored?: number;
  error?: string;
};
export async function searchArea(latitude: number, longitude: number, radiusKm: number): Promise<AreaSearchResult> {
  const res = await fetch(`${BASE}/api/area/search`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ latitude, longitude, radiusKm }),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as AreaSearchResult;
}
