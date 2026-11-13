import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { kvGet, kvSet, sosAll, tileCount } from "./store";
import { downloadTiles, tilesForBbox } from "./tiles";
import { createSos, flushOutbox } from "./sosOutbox";
import { evaluateSafety } from "./safety";
import { toast } from "../components/ui/sonner";

const BACKEND = (process.env.REACT_APP_BACKEND_URL || "").replace(/\/+$/, "");
const Ctx = createContext(null);
const QUIET_ALERTS = new Set(["gps", "nokit", "offline", "fc-stale"]);
export const DEFAULT_LIMITS = { deviationKm: 1.5, maxWind: 30, maxWave: 1.5, cruiseKmh: 12, geofenceBufferKm: 2 };

// A dataset bundle is only usable if every structure the safety engine reads is present.
export function validDatasets(d) {
  return !!d && Array.isArray(d.harbors) && Array.isArray(d.restricted) && Array.isArray(d.hazards)
    && !!d.route && Array.isArray(d.route.points) && !!d.bbox && Array.isArray(d.center);
}

async function getJson(path) {
  const res = await fetch(`${BACKEND}${path}`);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true); const off = () => setOnline(false);
    window.addEventListener("online", on); window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);
  return online;
}

function useBattery() {
  const [battery, setBattery] = useState(null);
  useEffect(() => {
    if (!navigator.getBattery) return undefined;
    let bat; const sync = () => setBattery({ level: bat.level, charging: bat.charging });
    navigator.getBattery().then((b) => { bat = b; sync(); b.addEventListener("levelchange", sync); b.addEventListener("chargingchange", sync); });
    return () => { if (bat) { bat.removeEventListener("levelchange", sync); bat.removeEventListener("chargingchange", sync); } };
  }, []);
  return battery;
}

function useGps(lowPower) {
  const [gps, setGps] = useState({ state: navigator.geolocation ? "ACQUIRING" : "UNSUPPORTED", fix: null });
  const [lastKnown, setLastKnown] = useState(null);
  const savedAt = useRef(0);
  useEffect(() => { kvGet("lastFix").then((f) => f && setLastKnown(f)); }, []);
  useEffect(() => {
    if (!navigator.geolocation) return undefined;
    const id = navigator.geolocation.watchPosition((pos) => {
      const c = pos.coords;
      const fix = { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy, speedKmh: c.speed != null ? c.speed * 3.6 : null,
        heading: c.heading, at: new Date(pos.timestamp).toISOString() };
      setGps({ state: "ACTIVE", fix });
      setLastKnown(fix);
      if (Date.now() - savedAt.current > 15000) { savedAt.current = Date.now(); kvSet("lastFix", fix); }
    }, (err) => setGps((g) => ({ state: err.code === 1 ? "DENIED" : "UNAVAILABLE", fix: null, prev: g.fix })),
    { enableHighAccuracy: !lowPower, maximumAge: lowPower ? 60000 : 5000, timeout: 20000 });
    return () => navigator.geolocation.clearWatch(id);
  }, [lowPower]);
  return { gps, lastKnown };
}

export function OfflineProvider({ children }) {
  const online = useOnline();
  const battery = useBattery();
  const lowPower = !!battery && battery.level <= 0.2 && !battery.charging;
  const { gps, lastKnown } = useGps(lowPower);
  const [datasets, setDatasets] = useState(null);
  const [forecast, setForecast] = useState(null);
  const [kit, setKit] = useState(null);
  const [limits, setLimitsState] = useState(DEFAULT_LIMITS);
  const [vesselId, setVesselId] = useState(null);
  const [outbox, setOutbox] = useState([]);
  const [progress, setProgress] = useState(null);
  const [storage, setStorage] = useState(null);
  const [swReady, setSwReady] = useState(false);
  const [now, setNow] = useState(Date.now());

  const refreshStorage = useCallback(async () => {
    const est = navigator.storage?.estimate ? await navigator.storage.estimate() : null;
    const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
    setStorage({ usage: est?.usage, quota: est?.quota, persisted, tiles: await tileCount() });
  }, []);

  useEffect(() => {
    (async () => {
      const [d, f, k, l, v] = await Promise.all([kvGet("datasets"), kvGet("forecast"), kvGet("kit"), kvGet("limits"), kvGet("vesselId")]);
      if (validDatasets(d)) setDatasets(d); if (f) setForecast(f); if (k) setKit(k); if (l) setLimitsState({ ...DEFAULT_LIMITS, ...l });
      const id = v || `ORCA-${Math.random().toString(16).slice(2, 8).toUpperCase()}`;
      if (!v) kvSet("vesselId", id);
      setVesselId(id);
      setOutbox(await sosAll());
      refreshStorage();
    })();
    navigator.serviceWorker?.ready.then(() => setSwReady(true));
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, [refreshStorage]);

  const flush = useCallback(async (force) => setOutbox(await flushOutbox({ force })), []);

  // Retry loop: on reconnect, on tab focus, and every 10 s while anything is unacknowledged.
  useEffect(() => {
    if (online) flush(true);
    const onVis = () => document.visibilityState === "visible" && flush(false);
    document.addEventListener("visibilitychange", onVis);
    const t = setInterval(() => flush(false), 10000);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
  }, [online, flush]);

  const setLimits = useCallback((patch) => setLimitsState((cur) => { const next = { ...cur, ...patch }; kvSet("limits", next); return next; }), []);

  const refreshForecast = useCallback(async (center) => {
    const [lat, lng] = center || datasets?.center || [16.99, 73.22];
    const fc = await getJson(`/api/forecast/marine?lat=${lat}&lng=${lng}`);
    await kvSet("forecast", fc); setForecast(fc);
    return fc;
  }, [datasets]);

  const downloadKit = useCallback(async () => {
    if (!navigator.onLine) { toast.error("No connection — download the trip kit before leaving harbour"); return null; }
    if (navigator.storage?.persist) await navigator.storage.persist();
    setProgress({ phase: "Safety data", done: 0, total: 0, failed: 0, bytes: 0 });
    try {
      const d = await getJson("/api/offline/safety-data");
      if (!validDatasets(d)) throw new Error("Unexpected safety-data response from server");
      const ds = { ...d, saved_at: new Date().toISOString() };
      await kvSet("datasets", ds); setDatasets(ds);
      setProgress((p) => ({ ...p, phase: "Forecast" }));
      const inArea = gps.fix && gps.fix.lat >= d.bbox.south && gps.fix.lat <= d.bbox.north && gps.fix.lng >= d.bbox.west && gps.fix.lng <= d.bbox.east;
      await refreshForecast(inArea ? [gps.fix.lat, gps.fix.lng] : d.center);
      const stats = await downloadTiles(d.bbox, (s) => setProgress({ phase: "Map tiles", ...s }));
      const k = { area: d.area, bbox: d.bbox, tiles: stats.done, total: stats.total, failed: stats.failed, saved_at: new Date().toISOString(), dataVersion: d.version };
      await kvSet("kit", k); setKit(k);
      fetch(`${BACKEND}/api/offline/cache`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ area: d.area, layers: ["Map tiles", "Sea marks", "Coastline", "Hazards", "Safe harbors", "Restricted areas", "Forecast"] }) }).catch(() => {});
      if (stats.failed) toast.warning(`Trip kit saved with ${stats.failed} missing map tiles — retry while online`);
      else toast.success("Trip kit saved on this device");
      return k;
    } catch (e) {
      toast.error("Trip kit download failed", { description: "Check the connection and try again." });
      return null;
    } finally {
      setProgress(null); refreshStorage();
    }
  }, [gps.fix, refreshForecast, refreshStorage]);

  const queueSos = useCallback(async ({ type, people = 1, details, vesselName }) => {
    const fix = gps.fix || (lastKnown ? { ...lastKnown, stale: true } : null);
    const item = await createSos({ type, people, details, vesselId, vesselName, fix });
    setOutbox(await sosAll());
    flush(true);
    return item;
  }, [gps.fix, lastKnown, vesselId, flush]);

  const safety = useMemo(() => evaluateSafety({ fix: gps.fix, gpsState: gps.state, datasets, forecast, limits, battery, online, now }),
    [gps.fix, gps.state, datasets, forecast, limits, battery, online, now]);

  // Surface newly raised alerts once.
  const seen = useRef(new Set());
  useEffect(() => {
    safety.alerts.forEach((a) => {
      if (seen.current.has(a.id)) return;
      seen.current.add(a.id);
      if (QUIET_ALERTS.has(a.id)) return;
      if (a.level === "CRITICAL") { toast.error(a.title, { description: a.detail }); navigator.vibrate?.([300, 150, 300]); }
      else if (a.level === "WARNING") toast.warning(a.title, { description: a.detail });
    });
    const ids = new Set(safety.alerts.map((a) => a.id));
    seen.current.forEach((id) => { if (!ids.has(id)) seen.current.delete(id); });
  }, [safety.alerts]);

  const kitTileTarget = datasets ? tilesForBbox(datasets.bbox).length : null;

  const value = useMemo(() => ({
    online, battery, lowPower, gps, lastKnown, datasets, forecast, kit, kitTileTarget, limits, setLimits, vesselId,
    outbox, flush, queueSos, downloadKit, refreshForecast, progress, storage, swReady, safety,
  }), [online, battery, lowPower, gps, lastKnown, datasets, forecast, kit, kitTileTarget, limits, setLimits, vesselId,
    outbox, flush, queueSos, downloadKit, refreshForecast, progress, storage, swReady, safety]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useOffline() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useOffline must be used inside OfflineProvider");
  return ctx;
}
