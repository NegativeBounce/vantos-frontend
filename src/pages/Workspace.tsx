import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import MapView, { type PickedVessel } from "../components/MapView";
import Modal from "../components/Modal";
import { getRegions, getPositions, getVesselTrack, getAisGaps, enrichVessel, searchArea, setRegionCollection, type AreaSearchResult } from "../lib/api";

const REPORT_TYPES = ["Insurance Risk Advisory", "Weekly Maritime Intelligence", "Vessel Captain Advisory"];
type Tool = "layers" | "vessels" | "area" | "regions" | "gaps";

export default function Workspace() {
  const qc = useQueryClient();
  const regions = useQuery({ queryKey: ["regions"], queryFn: getRegions });
  const positions = useQuery({ queryKey: ["positions"], queryFn: getPositions, refetchInterval: 20000 });

  const [tool, setTool] = useState<Tool | null>(null);

  // AIS display controls
  const [aisVisible, setAisVisible] = useState(true);
  const [tracksOn, setTracksOn] = useState(false);
  const [boxMode, setBoxMode] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<PickedVessel[]>([]);

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

  // Dark-shipping / AIS-gap indicators (opt-in layer).
  const [gapsOn, setGapsOn] = useState(false);
  const [verifySat, setVerifySat] = useState(false);
  const gaps = useQuery({
    queryKey: ["ais-gaps", verifySat],
    queryFn: () => getAisGaps(30, verifySat),
    enabled: gapsOn,
    refetchInterval: 60000,
  });
  const gapList = gapsOn ? gaps.data?.gaps ?? null : null;
  const confirmedCount = gapList?.filter((g) => g.tier === "confirmed").length ?? 0;

  // Area search
  const [center, setCenter] = useState<{ lng: number; lat: number } | null>(null);
  const [radiusKm, setRadiusKm] = useState(50);
  const [searching, setSearching] = useState(false);
  const [result, setResult] = useState<AreaSearchResult | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportType, setReportType] = useState(REPORT_TYPES[0]);
  const [generated, setGenerated] = useState<string | null>(null);

  const allVessels = positions.data?.vessels ?? [];
  const displayed = useMemo(() => allVessels.filter((v) => !hidden.has(v.mmsi ?? "")), [allVessels, hidden]);
  const regionCount = regions.data?.regions?.length ?? 0;

  function hideVessels(vessels: PickedVessel[]) {
    setHidden((prev) => {
      const next = new Set(prev);
      vessels.forEach((v) => v.mmsi && next.add(v.mmsi));
      return next;
    });
    setSelected([]);
  }
  const clearShown = () => hideVessels(displayed.map((v) => ({ mmsi: v.mmsi, name: v.name })));
  const resetHidden = () => { setHidden(new Set()); setSelected([]); };

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
  ];

  return (
    <div className="relative h-full w-full">
      <MapView
        vessels={displayed}
        selection={center ? { lng: center.lng, lat: center.lat, radiusKm } : null}
        track={trackCoords}
        gaps={gapList}
        onMapClick={(lng, lat) => setCenter({ lng, lat })}
        aisVisible={aisVisible}
        boxSelectMode={boxMode}
        onVesselClick={(v) => { setSelected([v]); setTool("vessels"); }}
        onBoxSelect={(vs) => { setSelected(vs); setTool("vessels"); }}
      />

      {/* Tool tabs */}
      <div className="absolute left-3 top-3 z-20 flex gap-1 rounded-lg border border-white/10 bg-black/60 p-1 text-xs backdrop-blur">
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

      {tool === "layers" && (
        <Modal title="Layers" onClose={() => setTool(null)}>
          <label className="flex items-center gap-2 text-gray-300">
            <input type="checkbox" checked={aisVisible} onChange={(e) => setAisVisible(e.target.checked)} />
            AIS (AISStream + Data Docked)
          </label>
          <label className="mt-2 flex items-center gap-2 text-gray-300">
            <input type="checkbox" checked={tracksOn} onChange={(e) => setTracksOn(e.target.checked)} />
            Tracks <span className="text-[10px] text-gray-500">(select one vessel · last 6h)</span>
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
          <label className="mt-2 flex items-center gap-2 text-gray-500">
            <input type="checkbox" disabled /> ADS-B / GNSS interference <span className="text-[10px]">(soon)</span>
          </label>
          <label className="mt-2 flex items-center gap-2 text-gray-500">
            <input type="checkbox" disabled /> Imagery <span className="text-[10px]">(soon)</span>
          </label>
        </Modal>
      )}

      {tool === "vessels" && (
        <Modal title="Vessels" onClose={() => setTool(null)}>
          <div className="text-gray-300">
            Shown <span className="font-mono text-sky-400">{displayed.length}</span>
            <span className="text-gray-500"> / {allVessels.length}</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button
              onClick={() => setBoxMode((b) => !b)}
              className={`rounded border px-2 py-1 ${boxMode ? "border-sky-400 bg-sky-500/20 text-sky-300" : "border-white/10 hover:bg-white/10"}`}
            >
              {boxMode ? "Box select: ON" : "Box select"}
            </button>
            <button onClick={clearShown} className="rounded border border-white/10 px-2 py-1 hover:bg-white/10">Clear shown</button>
            <button onClick={resetHidden} className="rounded border border-white/10 px-2 py-1 hover:bg-white/10">Reset</button>
          </div>
          {boxMode && <p className="mt-1 text-[10px] text-sky-300/80">Drag a rectangle on the map to select vessels.</p>}

          <div className="mt-3 border-t border-white/10 pt-2">
            <div className="text-gray-300">Selected: <span className="font-mono text-sky-400">{selected.length}</span></div>
            {tracksOn && trackMmsi && (
              <div className="mt-1 text-[11px] text-cyan-300/80">
                {track.isFetching && !track.data ? "Loading track…"
                  : (track.data?.count ?? 0) >= 2 ? `Track: ${track.data?.count} points over ${track.data?.hours}h`
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
                    <button
                      onClick={() => setEnrichMmsi(selected[0].mmsi)}
                      className="w-full rounded bg-sky-600 px-2 py-1 font-medium text-white hover:bg-sky-500"
                    >
                      Enrich (Data Docked)
                    </button>
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
        <Modal title="Area Search" onClose={() => setTool(null)}>
          {center ? (
            <>
              <div className="text-gray-400">center {center.lat.toFixed(2)}, {center.lng.toFixed(2)}</div>
              <label className="mt-2 block text-gray-400">
                radius: <span className="font-mono text-amber-400">{radiusKm} km</span>
                <input type="range" min={1} max={50} value={radiusKm} onChange={(e) => setRadiusKm(Number(e.target.value))} className="mt-1 w-full" />
              </label>
              <div className="mt-2 flex gap-2">
                <button onClick={runSearch} disabled={searching} className="rounded bg-amber-600 px-2 py-1 font-medium text-black hover:bg-amber-500 disabled:opacity-50">
                  {searching ? "Searching…" : "Search this area"}
                </button>
                <button onClick={() => setCenter(null)} className="rounded border border-white/10 px-2 py-1 hover:bg-white/10">Clear</button>
              </div>
            </>
          ) : (
            <p className="text-gray-500">
              {boxMode ? "Box-select is on — turn it off (Vessels tab) to drop a search center." : "Click the map to drop a center, then set a radius (≤50 km) and search."}
            </p>
          )}
        </Modal>
      )}

      {tool === "regions" && (
        <Modal title="Regions — data collection" onClose={() => setTool(null)} width="w-[28rem]">
          <p className="mb-2 text-[11px] text-gray-500">Toggle which sources collect data per region. AIS streams continuously while on; nothing collects until enabled.</p>
          <div className="max-h-72 space-y-1.5 overflow-auto">
            {regions.data?.regions?.map((r) => (
              <div key={r.id} className="flex items-center justify-between rounded border border-white/10 px-2 py-1.5">
                <div className="min-w-0">
                  <div className="truncate text-gray-200">{r.name}</div>
                  <div className="text-[10px] text-gray-500">{r.type}{r.boundingBox ? "" : " · no geofence"}</div>
                </div>
                <div className="flex shrink-0 gap-3 text-[11px]">
                  <label className={`flex items-center gap-1 ${r.boundingBox ? "text-gray-300" : "text-gray-600"}`} title="AISStream terrestrial collection (free, continuous)">
                    <input
                      type="checkbox"
                      checked={r.collectAis}
                      disabled={!r.boundingBox}
                      onChange={async (e) => { await setRegionCollection(r.id, { collectAis: e.target.checked }); qc.invalidateQueries({ queryKey: ["regions"] }); }}
                    />
                    AIS
                  </label>
                  <label className={`flex items-center gap-1 ${r.boundingBox ? "text-gray-300" : "text-gray-600"}`} title="Scheduled Data Docked satellite pull (spends credits; for sparse regions)">
                    <input
                      type="checkbox"
                      checked={r.collectAisSatellite}
                      disabled={!r.boundingBox}
                      onChange={async (e) => { await setRegionCollection(r.id, { collectAisSatellite: e.target.checked }); qc.invalidateQueries({ queryKey: ["regions"] }); }}
                    />
                    Sat
                  </label>
                  <label className="flex items-center gap-1 text-gray-300">
                    <input
                      type="checkbox"
                      checked={r.collectAdsb}
                      onChange={async (e) => { await setRegionCollection(r.id, { collectAdsb: e.target.checked }); qc.invalidateQueries({ queryKey: ["regions"] }); }}
                    />
                    ADS-B
                  </label>
                </div>
              </div>
            ))}
            {regionCount === 0 && <p className="text-gray-500">No regions.</p>}
          </div>
          <p className="mt-2 text-[10px] text-gray-600">
            <strong className="text-gray-500">AIS</strong> = AISStream terrestrial (free, continuous). <strong className="text-gray-500">Sat</strong> = scheduled Data Docked satellite pull every 30&nbsp;min (spends credits — use for sparse regions like Hormuz). <strong className="text-gray-500">ADS-B</strong> wires up with Slice C.
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
