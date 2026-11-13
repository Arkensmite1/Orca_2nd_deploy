import { sosAll, sosPut } from "./store";

const BACKEND = (process.env.REACT_APP_BACKEND_URL || "").replace(/\/+$/, "");

export const SOS_STATUS = {
  QUEUED: "QUEUED",            // stored on this device only
  TRANSMITTED: "TRANSMITTED",  // sent, waiting for the server receipt
  ACKNOWLEDGED: "ACKNOWLEDGED" // server confirmed receipt
};

const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  }));

export async function createSos({ type, people, details, vesselId, vesselName, fix }) {
  const item = {
    emergency_id: uuid(),
    vessel_id: vesselId,
    vessel_name: vesselName,
    type,
    people,
    details: details || "",
    lat: fix?.lat ?? null,
    lng: fix?.lng ?? null,
    accuracy_m: fix?.accuracy ?? null,
    position_fixed_at: fix?.at ?? null,
    captured_at: new Date().toISOString(),
    status: SOS_STATUS.QUEUED,
    attempts: 0,
    next_retry_at: 0,
    last_error: null,
  };
  await sosPut(item);
  return item;
}

const backoffMs = (attempts) => Math.min(5000 * 2 ** (attempts - 1), 5 * 60000);

async function transmit(item) {
  const sending = { ...item, status: SOS_STATUS.TRANSMITTED, attempts: item.attempts + 1, last_attempt_at: new Date().toISOString() };
  await sosPut(sending);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const { status, attempts, next_retry_at, last_error, last_attempt_at, ack, ...packet } = sending;
    const res = await fetch(`${BACKEND}/api/sos/transmit`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...packet, attempt: attempts }), signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`server ${res.status}`);
    const ackBody = await res.json();
    const done = { ...sending, status: SOS_STATUS.ACKNOWLEDGED, ack: ackBody, last_error: null };
    await sosPut(done);
    return done;
  } catch (e) {
    const failed = { ...sending, status: SOS_STATUS.QUEUED, last_error: e.name === "AbortError" ? "timeout" : e.message,
      next_retry_at: Date.now() + backoffMs(sending.attempts) };
    await sosPut(failed);
    return failed;
  } finally {
    clearTimeout(timer);
  }
}

let flushing = false;
// Sends every unacknowledged SOS whose retry time has come. TRANSMITTED items left over from a closed app are resent; the server dedupes.
export async function flushOutbox({ force = false } = {}) {
  if (flushing || !navigator.onLine) return sosAll();
  flushing = true;
  try {
    const pending = (await sosAll()).filter((x) => x.status !== SOS_STATUS.ACKNOWLEDGED && (force || x.next_retry_at <= Date.now()));
    for (const item of pending) await transmit(item);
  } finally {
    flushing = false;
  }
  return sosAll();
}
