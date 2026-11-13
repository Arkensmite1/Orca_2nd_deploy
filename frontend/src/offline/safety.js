import { distanceToPolygonEdgeKm, distanceToPolylineKm, fmtDuration, fmtKm, haversineKm, nearest, pointInPolygon } from "./geo";
import { currentHour, forecastStatus, returnEstimate } from "./forecast";

const alert = (id, level, title, detail) => ({ id, level, title, detail });

// Pure on-device evaluation: no network, no guessing a position.
export function evaluateSafety({ fix, gpsState, datasets, forecast, limits, battery, online, now }) {
  const alerts = [];
  const out = { alerts, harbor: null, deviationKm: null, geofence: null, hazards: [], conditions: null, ret: null, travelMin: null };
  const pos = fix ? [fix.lat, fix.lng] : null;

  if (!pos) alerts.push(alert("gps", "WARNING", gpsState === "DENIED" ? "Location permission denied" : "No GPS fix",
    "Position-based checks are paused. ORCA will not guess where you are."));
  if (battery && battery.level <= 0.2 && !battery.charging)
    alerts.push(alert("battery", battery.level <= 0.1 ? "CRITICAL" : "WARNING", `Battery ${Math.round(battery.level * 100)}%`,
      "GPS switched to low-power mode. Conserve the phone for emergency use."));
  if (!datasets) alerts.push(alert("nokit", "WARNING", "Trip kit not downloaded", "Harbors, hazards and boundaries are not on this device."));

  const speed = fix?.speedKmh && fix.speedKmh > 3 ? fix.speedKmh : limits.cruiseKmh;

  if (pos && datasets) {
    const h = nearest(pos, datasets.harbors);
    out.travelMin = (h.distanceKm / speed) * 60;
    out.harbor = { ...h, etaMin: out.travelMin };

    out.deviationKm = distanceToPolylineKm(pos, datasets.route.points);
    if (out.deviationKm > limits.deviationKm)
      alerts.push(alert("deviation", out.deviationKm > limits.deviationKm * 2 ? "CRITICAL" : "WARNING", "Off planned route",
        `${fmtKm(out.deviationKm)} from "${datasets.route.name}" (limit ${fmtKm(limits.deviationKm)}).`));

    const zones = (datasets.restricted || []).map((z) => ({ ...z, inside: pointInPolygon(pos, z.polygon), edgeKm: distanceToPolygonEdgeKm(pos, z.polygon) }));
    const inside = zones.find((z) => z.inside);
    const closest = zones.reduce((a, b) => (!a || b.edgeKm < a.edgeKm ? b : a), null);
    out.geofence = inside ? { ...inside, state: "INSIDE" } : closest && { ...closest, state: closest.edgeKm < limits.geofenceBufferKm ? "NEAR" : "CLEAR" };
    if (inside) alerts.push(alert(`gf-in-${inside.id}`, "CRITICAL", "Inside restricted zone", `${inside.name}. Leave the boundary now.`));
    else if (out.geofence?.state === "NEAR")
      alerts.push(alert(`gf-near-${closest.id}`, "WARNING", "Approaching restricted zone", `${fmtKm(closest.edgeKm)} from ${closest.name}.`));

    out.hazards = (datasets.hazards || []).map((z) => ({ ...z, distanceKm: haversineKm(pos, [z.lat, z.lng]) - z.radius_km }))
      .filter((z) => z.distanceKm < 0.5);
    out.hazards.forEach((z) => alerts.push(alert(`hz-${z.id}`, z.distanceKm <= 0 ? "CRITICAL" : "WARNING", "Hazard nearby",
      `${z.name} — ${z.distanceKm <= 0 ? "you are inside the hazard area" : fmtKm(z.distanceKm) + " away"}.`)));
  }

  const fcStatus = forecastStatus(forecast, now);
  if (fcStatus.state === "EXPIRED") alerts.push(alert("fc-expired", "WARNING", "Forecast expired", "Saved forecast is too old to trust. Refresh when you have signal."));
  else if (fcStatus.state === "STALE") alerts.push(alert("fc-stale", "INFO", "Forecast getting old", `Saved ${Math.round(fcStatus.ageH)}h ago.`));
  const hour = currentHour(forecast, now);
  out.conditions = hour && { ...hour, status: fcStatus };
  if (hour && fcStatus.state !== "EXPIRED") {
    if (hour.wind_kmh > limits.maxWind) alerts.push(alert("wind", "CRITICAL", "Wind above vessel limit", `${Math.round(hour.wind_kmh)} km/h forecast now (limit ${limits.maxWind}).`));
    if (hour.wave_m > limits.maxWave) alerts.push(alert("wave", "CRITICAL", "Waves above vessel limit", `${hour.wave_m.toFixed(1)} m forecast now (limit ${limits.maxWave} m).`));
  }

  out.ret = returnEstimate(forecast, limits, out.travelMin ?? 0, now);
  if (out.ret.overdue && out.ret.returnBy)
    alerts.push(alert("return", "CRITICAL", "Past your return time", `${out.ret.reason}. Head to ${out.harbor?.name || "the nearest harbor"} now${out.travelMin ? ` (~${fmtDuration(out.travelMin)})` : ""}.`));

  if (!online) alerts.push(alert("offline", "INFO", "No internet connection", "Local checks keep running. SOS messages will wait in the outbox."));
  return out;
}
