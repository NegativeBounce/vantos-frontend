// Topology A: frontend + backend share one app; call the backend at /api (same origin).
const BASE = import.meta.env.VITE_API_BASE_URL ?? "";
const TOKEN_KEY = "vantos.token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(t: string): void {
  localStorage.setItem(TOKEN_KEY, t);
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("accept", "application/json");
  const token = getToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (res.status === 401) {
    clearToken();
    if (onUnauthorized) onUnauthorized();
    throw new Error("unauthorized");
  }
  return res;
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await authedFetch(path);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await authedFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
  return data as T;
}

// ---- Auth ----
export type AuthUser = { id: string; email: string; name?: string | null; role: string };

export async function login(email: string, password: string): Promise<AuthUser> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = (await res.json().catch(() => ({}))) as { token?: string; user?: AuthUser; error?: string };
  if (!res.ok || !data.token) throw new Error(data?.error || `login failed (${res.status})`);
  setToken(data.token);
  return data.user as AuthUser;
}

export const getMe = () => apiGet<{ status: string; user: AuthUser }>("/api/auth/me");

export type AppUser = { id: string; email: string; name: string | null; role: string; status: string; created_at: string };
export const listUsers = () => apiGet<{ status: string; users: AppUser[] }>("/api/users");
export const createUser = (input: { email: string; name?: string; role: string; password?: string; invite?: boolean }) =>
  apiPost<{ status: string; mode: string; user: AppUser }>("/api/users", input);

// ---- Health / data ----
export type Health = { status: string; env: string; time: string };
export const getHealth = () => apiGet<Health>("/healthz");

export type Region = {
  id: string;
  name: string;
  type: string;
  description: string | null;
  status: string;
  riskLevel: string | null;
  kind: "coverage" | "poi";
  collectAis: boolean;
  collectAdsb: boolean;
  collectAisSatellite: boolean;
  boundingBox: { minLat: number; minLon: number; maxLat: number; maxLon: number } | null;
  center: { lat: number; lon: number } | null;
  lastAisPullAt: string | null;
};
export const getRegions = () => apiGet<{ status: string; regions: Region[] }>("/api/regions");

export async function setRegionCollection(
  id: string,
  input: { collectAis?: boolean; collectAdsb?: boolean; collectAisSatellite?: boolean }
): Promise<{ status: string; region?: Region; error?: string }> {
  const res = await authedFetch(`/api/regions/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = (await res.json().catch(() => ({}))) as { status: string; region?: Region; error?: string };
  if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
  return data;
}

export const pullRegion = (id: string) =>
  apiPost<{ status: string; regionId?: string; note?: string; error?: string }>(`/api/regions/${id}/pull`, {});

export type VesselPosition = {
  mmsi: string | null;
  name: string | null;
  type: string | null;
  latitude: number;
  longitude: number;
  speed: number | null;
  navStatus: string | null;
  dataSource: string | null;
  positionReceived: string | null;
  ingestedAt: string | null;
};
export const getPositions = () =>
  apiGet<{ status: string; count: number; vessels: VesselPosition[] }>("/api/positions?limit=5000");

export type TrackPoint = {
  latitude: number;
  longitude: number;
  speed: number | null;
  heading: number | null;
  positionReceived: string | null;
  ingestedAt: string;
};
export const getVesselTrack = (mmsi: string, hours = 6) =>
  apiGet<{ status: string; mmsi: string; hours: number; count: number; points: TrackPoint[] }>(
    `/api/vessels/${encodeURIComponent(mmsi)}/track?hours=${hours}`
  );

export type GapTier = "terrestrial" | "active" | "confirmed" | "pending" | "unverified";
export type GapVerification = {
  tier: GapTier;
  dataSource: string | null;
  seenAt: string | null;
  ageMin: number | null;
  checkedAt: string;
  note: string;
};
export type AisGap = {
  mmsi: string | null;
  name: string | null;
  type: string | null;
  latitude: number;
  longitude: number;
  lastSpeed: number | null;
  navStatus: string | null;
  region: string | null;
  minutesAgo: number;
  lastSeen: string;
  confidence: "low" | "medium" | "high";
  tier: GapTier;
  verification: GapVerification | null;
};
export type AisGapResult = {
  status: string;
  disclaimer: string;
  satelliteNote?: string;
  gapMinutes: number;
  verify: boolean;
  streamFresh: boolean;
  count: number;
  gaps: AisGap[];
};
export const getAisGaps = (minutes = 30, verify = false) =>
  apiGet<AisGapResult>(`/api/ais-gaps?minutes=${minutes}${verify ? "&verify=1" : ""}`);

// ---- GNSS interference (ADS-B) — per-cell heatmap ----
export type GnssConfidence = "insufficient_data" | "low" | "medium" | "high";
export type GnssSeverityColor = "gray" | "green" | "yellow" | "orange" | "red";
export type GnssCell = {
  regionId: string;
  region: string | null;
  cellId: string;
  polygon: GeoJSON.Polygon;
  severityPct: number;
  severityColor: GnssSeverityColor;
  confidence: GnssConfidence;
  totalObservations: number;
  degradedObservations: number;
  distinctAircraft: number;
  maxCoincident15min: number;
  dropEvents: number;
  updatedAt: string;
};
export type GnssResult = { status: string; disclaimer: string; count: number; cells: GnssCell[] };
export const getGnssInterference = () => apiGet<GnssResult>("/api/gnss-interference");

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
export const getDataSources = () => apiGet<{ status: string; dataSources: DataSource[] }>("/api/data-sources");

// ---- Data Docked usage / credit telemetry ----
export type IngestionRun = {
  id: string;
  endpoint: string;
  status: string;
  records: number;
  credits_estimated: number | null;
  credits_before: number | null;
  credits_after: number | null;
  credits_spent: number | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  region_name: string | null;
};
export type CreditSpendRow = { endpoint: string; runs: number; credits_spent: number; records: number };
export const getIngestionRuns = (limit = 25) =>
  apiGet<{ status: string; runs: IngestionRun[]; summary: CreditSpendRow[] }>(`/api/datadocked/runs?limit=${limit}`);

// ---- Per-vessel enrichment ----
export type VesselEnrichment = {
  status: string;
  mmsi: string;
  curated: Record<string, string | number>;
  detail: unknown;
  creditsSpent: number | null;
  cachedAt: string;
  error?: string;
};
export const enrichVessel = (mmsi: string) =>
  apiGet<VesselEnrichment>(`/api/vessels/${encodeURIComponent(mmsi)}/enrich`);

export type AreaSearchResult = {
  status: string;
  region?: string;
  center?: { latitude: number; longitude: number };
  radiusKm?: number;
  fetched?: number;
  stored?: number;
  error?: string;
};
export const searchArea = (latitude: number, longitude: number, radiusKm: number) =>
  apiPost<AreaSearchResult>("/api/area/search", { latitude, longitude, radiusKm });
