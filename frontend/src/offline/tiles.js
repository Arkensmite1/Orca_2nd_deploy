import L from "leaflet";
import { tileGet, tileKeys, tilePut } from "./store";

const BACKEND = (process.env.REACT_APP_BACKEND_URL || "").replace(/\/+$/, "");
export const TILE_LAYERS = ["street", "seamark"];
export const KIT_ZOOMS = [9, 10, 11, 12, 13];
const NETWORK = {
  street: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
  seamark: "https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png",
};
const EMPTY = "empty";
const ATTRIBUTION = { street: "Tiles © Esri", seamark: "Sea marks © OpenSeaMap" };

const lng2x = (lng, z) => Math.floor(((lng + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

export function tilesForBbox({ south, west, north, east }, zooms = KIT_ZOOMS) {
  const keys = [];
  zooms.forEach((z) => {
    for (let x = lng2x(west, z); x <= lng2x(east, z); x += 1)
      for (let y = lat2y(north, z); y <= lat2y(south, z); y += 1)
        TILE_LAYERS.forEach((layer) => keys.push(`${layer}/${z}/${x}/${y}`));
  });
  return keys;
}

async function fetchTile(key) {
  const res = await fetch(`${BACKEND}/api/tiles/${key}`);
  if (res.status === 204) { await tilePut(key, EMPTY); return 0; }
  if (!res.ok) throw new Error(`tile ${res.status}`);
  const blob = await res.blob();
  await tilePut(key, blob);
  return blob.size;
}

// Downloads missing tiles with limited concurrency; reports progress.
export async function downloadTiles(bbox, onProgress) {
  const all = tilesForBbox(bbox);
  const have = new Set(await tileKeys());
  const todo = all.filter((k) => !have.has(k));
  const stats = { total: all.length, done: all.length - todo.length, failed: 0, bytes: 0 };
  onProgress({ ...stats });
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const key = todo[i++];
      try { stats.bytes += await fetchTile(key); stats.done += 1; } catch { stats.failed += 1; }
      onProgress({ ...stats });
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return stats;
}

// Leaflet layer that renders from IndexedDB first, network second, blank when offline.
const CachedLayer = L.TileLayer.extend({
  createTile(coords, done) {
    const img = document.createElement("img");
    img.alt = "";
    const layer = this.options.cacheLayer;
    const key = `${layer}/${coords.z}/${coords.x}/${coords.y}`;
    tileGet(key).then((blob) => {
      if (blob && blob !== EMPTY) {
        const url = URL.createObjectURL(blob);
        img.onload = () => { URL.revokeObjectURL(url); done(null, img); };
        img.onerror = () => done(new Error("bad cached tile"), img);
        img.src = url;
        img.dataset.source = "cache";
      } else if (!blob && navigator.onLine) {
        img.onload = () => done(null, img);
        img.onerror = () => done(new Error("tile offline"), img);
        img.src = L.Util.template(NETWORK[layer], coords);
        img.dataset.source = "network";
      } else {
        done(null, img);
      }
    }).catch(() => done(null, img));
    return img;
  },
});

export const cachedTileLayer = (layer, opts = {}) => new CachedLayer("", { maxZoom: 18, cacheLayer: layer, attribution: ATTRIBUTION[layer], ...opts });
