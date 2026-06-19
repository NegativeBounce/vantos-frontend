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
  polygon: number[][] | null;
  color: string | null;
  isCustom: boolean;
  analyze: boolean;
  analyzeUntil: string | null;
  footprintPath: number[][] | null;
  lastAisPullAt: string | null;
  aisPullCadenceMinutes: number;
};
export const getRegions = () => apiGet<{ status: string; regions: Region[] }>("/api/regions");

// Create a custom, operator-drawn coverage region from a polygon ring ([[lng,lat], ...]).
export const createRegion = (input: { name: string; description?: string; color?: string; polygon: number[][]; collectAis?: boolean }) =>
  apiPost<{ status: string; region?: Region; error?: string }>("/api/regions", input);

export async function deleteRegion(id: string): Promise<{ status: string; error?: string }> {
  const res = await authedFetch(`/api/regions/${id}`, { method: "DELETE" });
  const data = (await res.json().catch(() => ({}))) as { status: string; error?: string };
  if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
  return data;
}

export async function setRegionCollection(
  id: string,
  input: { collectAis?: boolean; collectAdsb?: boolean; collectAisSatellite?: boolean; aisPullCadenceMinutes?: number; analyze?: boolean; analyzeDurationMinutes?: number | null; footprintPath?: number[][] | null }
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
export type Bbox = { minLat: number; minLon: number; maxLat: number; maxLon: number };
export const getPositions = (bbox?: Bbox | null) => {
  const q = new URLSearchParams({ limit: "20000" });
  if (bbox) {
    q.set("minLat", String(bbox.minLat));
    q.set("minLon", String(bbox.minLon));
    q.set("maxLat", String(bbox.maxLat));
    q.set("maxLon", String(bbox.maxLon));
  }
  return apiGet<{ status: string; count: number; truncated: boolean; vessels: VesselPosition[] }>(`/api/positions?${q.toString()}`);
};

export type TrackPoint = {
  latitude: number;
  longitude: number;
  speed: number | null;
  heading: number | null;
  positionReceived: string | null;
  ingestedAt: string;
};
export const getVesselTrack = (mmsi: string, hours = 168) =>
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
  source: string;
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

// ---- Vessel anomalies / pattern analysis ----
export type AnomalySeverity = "low" | "medium" | "high";
export type Anomaly = {
  id: string;
  type: string;
  severity: AnomalySeverity;
  mmsi: string | null;
  imo: string | null;
  name: string | null;
  vesselType: string | null;
  regionId: string | null;
  latitude: number | null;
  longitude: number | null;
  occurredAt: string | null;
  title: string;
  description: string;
  details: Record<string, unknown> | null;
  detectedAt: string;
};
export type AnomalyResult = {
  status: string;
  disclaimer: string;
  counts: { severity: string; n: number }[];
  count: number;
  anomalies: Anomaly[];
};
// limit 0 (the default) = no cap; the operator sees every open finding.
export const getAnomalies = (opts?: { type?: string; severity?: string; limit?: number; regionIds?: string[] }) => {
  const q = new URLSearchParams();
  if (opts?.type) q.set("type", opts.type);
  if (opts?.severity) q.set("severity", opts.severity);
  if (opts?.regionIds && opts.regionIds.length) q.set("regionIds", opts.regionIds.join(","));
  q.set("limit", String(opts?.limit ?? 0));
  return apiGet<AnomalyResult>(`/api/anomalies?${q.toString()}`);
};

// Region-scoped analysis controls (D-62).
export const runAnomalyAnalysis = (regionIds: string[]) =>
  apiPost<{ status: string; found?: number; inserted?: number; regions?: number; error?: string }>("/api/anomalies/run", { regionIds });

export async function clearAnomalies(regionIds?: string[]): Promise<{ status: string; cleared?: number; error?: string }> {
  const q = regionIds && regionIds.length ? `?regionIds=${encodeURIComponent(regionIds.join(","))}` : "";
  const res = await authedFetch(`/api/anomalies${q}`, { method: "DELETE" });
  const data = (await res.json().catch(() => ({}))) as { status: string; cleared?: number; error?: string };
  if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
  return data;
}

export type AnalysisSnapshotMeta = {
  id: string;
  name: string;
  regionIds: string[] | null;
  regionNames: string | null;
  counts: { severity: string; n: number }[];
  findingCount: number;
  createdAt: string;
};
export type AnalysisSnapshot = AnalysisSnapshotMeta & { findings: Anomaly[] };

export const saveAnalysisSnapshot = (name: string, regionIds?: string[]) =>
  apiPost<{ status: string; id?: string; findingCount?: number; error?: string }>("/api/anomalies/snapshots", { name, regionIds });
export const getAnalysisSnapshots = () =>
  apiGet<{ status: string; snapshots: AnalysisSnapshotMeta[] }>("/api/anomalies/snapshots");
export const getAnalysisSnapshot = (id: string) =>
  apiGet<{ status: string; snapshot: AnalysisSnapshot }>(`/api/anomalies/snapshots/${id}`);
export async function deleteAnalysisSnapshot(id: string): Promise<{ status: string; error?: string }> {
  const res = await authedFetch(`/api/anomalies/snapshots/${id}`, { method: "DELETE" });
  const data = (await res.json().catch(() => ({}))) as { status: string; error?: string };
  if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
  return data;
}

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

// ---- Latest position (snap-to-map for a vessel from a list) ----
export type LatestPosition = {
  latitude: number;
  longitude: number;
  speed: number | null;
  heading: number | null;
  navStatus: string | null;
  dataSource: string | null;
  positionReceived: string | null;
  ingestedAt: string | null;
  name: string | null;
  type: string | null;
  imo: string | null;
  flag: string | null;
};
export const getLatestPosition = (mmsi: string) =>
  apiGet<{ status: string; mmsi: string; position: LatestPosition | null; error?: string }>(
    `/api/vessels/${encodeURIComponent(mmsi)}/latest`
  );

// ---- Vessel Registry (monitored vessels + groups) ----
export type MonitorGroup = {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  createdAt: string;
  vesselCount: number;
};
export type MonitoredVessel = {
  id: string;
  groupId: string | null;
  groupName: string | null;
  mmsi: string | null;
  imo: string | null;
  name: string | null;
  vesselType: string | null;
  flag: string | null;
  notes: string | null;
  lastLatitude: number | null;
  lastLongitude: number | null;
  addedAt: string;
  updatedAt: string;
};

export const getMonitorGroups = () => apiGet<{ status: string; groups: MonitorGroup[] }>("/api/registry/groups");
export const createMonitorGroup = (input: { name: string; description?: string; color?: string }) =>
  apiPost<{ status: string; group?: MonitorGroup; error?: string }>("/api/registry/groups", input);

export async function updateMonitorGroup(id: string, input: { name?: string; description?: string | null; color?: string | null }) {
  const res = await authedFetch(`/api/registry/groups/${id}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
  const data = (await res.json().catch(() => ({}))) as { status: string; group?: MonitorGroup; error?: string };
  if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
  return data;
}
export async function deleteMonitorGroup(id: string) {
  const res = await authedFetch(`/api/registry/groups/${id}`, { method: "DELETE" });
  const data = (await res.json().catch(() => ({}))) as { status: string; error?: string };
  if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
  return data;
}

export const getMonitoredVessels = (opts?: { groupId?: string; unassigned?: boolean }) => {
  const q = new URLSearchParams();
  if (opts?.groupId) q.set("groupId", opts.groupId);
  if (opts?.unassigned) q.set("unassigned", "1");
  return apiGet<{ status: string; vessels: MonitoredVessel[] }>(`/api/registry/vessels?${q.toString()}`);
};
export const addMonitoredVessel = (input: {
  mmsi?: string | null; imo?: string | null; name?: string | null; vesselType?: string | null;
  flag?: string | null; groupId?: string | null; notes?: string | null;
  lastLatitude?: number | null; lastLongitude?: number | null;
}) => apiPost<{ status: string; vessel?: MonitoredVessel; error?: string }>("/api/registry/vessels", input);

export async function updateMonitoredVessel(id: string, input: { groupId?: string | null; notes?: string | null }) {
  const res = await authedFetch(`/api/registry/vessels/${id}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
  const data = (await res.json().catch(() => ({}))) as { status: string; vessel?: MonitoredVessel; error?: string };
  if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
  return data;
}
export async function removeMonitoredVessel(id: string) {
  const res = await authedFetch(`/api/registry/vessels/${id}`, { method: "DELETE" });
  const data = (await res.json().catch(() => ({}))) as { status: string; error?: string };
  if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
  return data;
}
