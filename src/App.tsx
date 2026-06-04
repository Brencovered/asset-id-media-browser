import React, { useMemo, useRef, useState, useCallback } from "react";
import { MapContainer, TileLayer, GeoJSON, Marker, Popup, useMap, CircleMarker, Polyline } from "react-leaflet";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// ─── Types ────────────────────────────────────────────────────────────────────

type CocoImage = {
  id: number;
  file_name: string;
  coco_url?: string;
  flickr_url?: string;
  s3Path?: string;
  gpslat?: number | null;
  gpslng?: number | null;
  width?: number;
  height?: number;
};

type CocoAnnotation = {
  id: number;
  image_id: number;
  category_id: number;
  bbox?: [number, number, number, number];
  score?: number;
  area?: number;
  iscrowd?: number;
};

type CocoCategory = {
  id: number;
  name: string;
  supercategory?: string;
};

type CocoData = {
  images: CocoImage[];
  annotations: CocoAnnotation[];
  categories: CocoCategory[];
  labelConfigs?: Record<string, { categories?: CocoCategory[] }>;
  info?: Record<string, unknown>;
};

type PoleIndexRow = {
  poleKey: string;
  assetId: string;
  lat: number;
  lon: number;
  x: number;
  y: number;
  nearestDistM?: number;
};

type ImageRecord = {
  cocoImage: CocoImage;
  lat?: number;
  lon?: number;
  imageUrl?: string;
  annotations: CocoAnnotation[];
  // join result
  poleKey?: string;
  assetId?: string;
  joinDistM?: number;
  joinMethod: "gps" | "manual" | "none";
};

type AssetRecord = {
  poleKey: string;
  assetId: string;
  poleLat: number;
  poleLon: number;
  images: ImageRecord[];
  // deduplicated detection inventory (max-per-image per category)
  inventoryCounts: Record<string, number>;
  // raw totals summed across all images
  detectionTotals: Record<string, number>;
};

type ManualOverride = { poleKey: string; assetId: string; distM?: number };

// ─── Constants ────────────────────────────────────────────────────────────────

const CDN_BASE = "https://library.unleashlive.com/";
const DEFAULT_TILE = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";

const DefaultIcon = L.icon({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
});
L.Marker.prototype.options.icon = DefaultIcon;

// ─── Geo helpers ──────────────────────────────────────────────────────────────

function toRad(d: number) { return (d * Math.PI) / 180; }

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function buildProjector(lat0: number) {
  const mLat = 111320, mLon = 111320 * Math.cos(toRad(lat0));
  return { toXY: (lat: number, lon: number) => ({ x: lon * mLon, y: lat * mLat }) };
}

type GridIdx<T> = { cellM: number; grid: Map<string, T[]>; key: (x: number, y: number) => string };

function makeGrid<T extends { x: number; y: number }>(items: T[], cellM: number): GridIdx<T> {
  const grid = new Map<string, T[]>();
  const key = (x: number, y: number) => `${Math.floor(x / cellM)},${Math.floor(y / cellM)}`;
  for (const it of items) { const k = key(it.x, it.y); if (!grid.has(k)) grid.set(k, []); grid.get(k)!.push(it); }
  return { cellM, grid, key };
}

function gridCandidates<T extends { x: number; y: number }>(idx: GridIdx<T>, x: number, y: number, r: number): T[] {
  const cx = Math.floor(x / idx.cellM), cy = Math.floor(y / idx.cellM);
  const cells = Math.ceil(r / idx.cellM);
  const out: T[] = [];
  for (let dx = -cells; dx <= cells; dx++)
    for (let dy = -cells; dy <= cells; dy++) {
      const b = idx.grid.get(`${cx + dx},${cy + dy}`);
      if (b) out.push(...b);
    }
  return out;
}

// ─── GeoJSON helpers ──────────────────────────────────────────────────────────

function getAssetId(f: Feature<Geometry, any>): string {
  const p = f.properties ?? {} as any;
  return p.Plant_ID?.trim() || p.PLANT_ID?.trim() || p.name?.trim() ||
    p.Label?.trim() || p.LABEL?.trim() || p.assetId?.trim() || p.id?.trim() || "Unknown";
}

function getPoleLL(f: Feature<Geometry, any>): { lat?: number; lon?: number } {
  const p = f.properties ?? {} as any;
  const lat = +p.Latitude || +p.latitude || NaN;
  const lon = +p.Longitude || +p.longitude || NaN;
  if (isFinite(lat) && isFinite(lon)) return { lat, lon };
  if (f.geometry?.type === "Point") {
    const c = (f.geometry as any).coordinates;
    if (Array.isArray(c) && c.length >= 2 && isFinite(c[0]) && isFinite(c[1]))
      return { lat: c[1], lon: c[0] };
  }
  return {};
}

// ─── Image URL resolution ─────────────────────────────────────────────────────

function resolveImageUrl(img: CocoImage): string | undefined {
  if (img.coco_url && img.coco_url.startsWith("http")) return img.coco_url;
  if (img.flickr_url && img.flickr_url.startsWith("http")) return img.flickr_url;
  if (img.s3Path) return CDN_BASE + img.s3Path;
  return undefined;
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function fmtM(m?: number) {
  if (m == null || !isFinite(m)) return "n/a";
  return m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(2)}km`;
}

function safeNum(x: unknown): number | undefined {
  if (typeof x === "number" && isFinite(x)) return x;
  if (typeof x === "string") { const n = Number(x); if (isFinite(n)) return n; }
  return undefined;
}

// ─── Map helpers ──────────────────────────────────────────────────────────────

function MapFlyTo({ lat, lon, zoom }: { lat: number; lon: number; zoom: number }) {
  const map = useMap();
  React.useEffect(() => { map.flyTo([lat, lon], zoom, { duration: 0.4 }); }, [lat, lon, zoom, map]);
  return null;
}

function FitBounds({ points, pad = 60 }: { points: [number, number][]; pad?: number }) {
  const map = useMap();
  React.useEffect(() => {
    if (!points.length) return;
    map.fitBounds(L.latLngBounds(points), { padding: [pad, pad] });
  }, [points, pad, map]);
  return null;
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [coco, setCoco] = useState<CocoData | null>(null);
  const [polesGeoJson, setPolesGeoJson] = useState<FeatureCollection<Geometry, any> | null>(null);
  const [cocoError, setCocoError] = useState<string | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [maxJoinM, setMaxJoinM] = useState(60);
  const [search, setSearch] = useState("");
  const [selectedPoleKey, setSelectedPoleKey] = useState<string | null>(null);
  const [selectedImage, setSelectedImage] = useState<ImageRecord | null>(null);
  const [manualOverrides, setManualOverrides] = useState<Record<string, ManualOverride>>({});
  const [rightTab, setRightTab] = useState<"asset" | "unassigned">("asset");
  const [selectedUnassigned, setSelectedUnassigned] = useState<ImageRecord | null>(null);
  // dedup toggle per asset — key = poleKey
  const [dedupOff, setDedupOff] = useState<Set<string>>(new Set());

  const cocoRef = useRef<HTMLInputElement>(null);
  const geoRef = useRef<HTMLInputElement>(null);

  // ── Category map ────────────────────────────────────────────────────────────
  const catMap = useMemo(() => {
    if (!coco) return new Map<number, string>();
    const m = new Map<number, string>();
    for (const c of coco.categories) m.set(c.id, c.name);
    // also look in labelConfigs
    if (coco.labelConfigs) {
      for (const cfg of Object.values(coco.labelConfigs)) {
        for (const c of cfg.categories ?? []) if (!m.has(c.id)) m.set(c.id, c.name);
      }
    }
    return m;
  }, [coco]);

  // ── Poles index ─────────────────────────────────────────────────────────────
  const polesIndex = useMemo((): PoleIndexRow[] | null => {
    if (!polesGeoJson?.features?.length) return null;
    const raw: { poleKey: string; assetId: string; lat: number; lon: number }[] = [];
    polesGeoJson.features.forEach((f, i) => {
      const ll = getPoleLL(f);
      if (ll.lat != null && ll.lon != null)
        raw.push({ poleKey: String(i), assetId: getAssetId(f), lat: ll.lat, lon: ll.lon });
    });
    if (!raw.length) return [];
    const lat0 = raw.reduce((s, p) => s + p.lat, 0) / raw.length;
    const proj = buildProjector(lat0);
    const list: PoleIndexRow[] = raw.map(p => { const xy = proj.toXY(p.lat, p.lon); return { ...p, ...xy, nearestDistM: undefined }; });
    // density signal
    const g = makeGrid(list, 50);
    for (const pole of list) {
      const cands = gridCandidates(g, pole.x, pole.y, 120).filter(c => c.poleKey !== pole.poleKey);
      const best = cands.reduce((b, c) => { const d = Math.hypot(pole.x - c.x, pole.y - c.y); return d < b ? d : b; }, Infinity);
      if (isFinite(best)) pole.nearestDistM = best;
    }
    return list;
  }, [polesGeoJson]);

  const poleGrid = useMemo(() => polesIndex?.length ? makeGrid(polesIndex, 50) : null, [polesIndex]);

  // ── Image records from COCO ──────────────────────────────────────────────────
  const imageRecords = useMemo((): ImageRecord[] => {
    if (!coco) return [];
    const annsByImage = new Map<number, CocoAnnotation[]>();
    for (const ann of coco.annotations) {
      if (!annsByImage.has(ann.image_id)) annsByImage.set(ann.image_id, []);
      annsByImage.get(ann.image_id)!.push(ann);
    }
    return coco.images.map(img => {
      const lat = safeNum(img.gpslat) ?? undefined;
      const lon = safeNum(img.gpslng) ?? undefined;
      return {
        cocoImage: img,
        lat, lon,
        imageUrl: resolveImageUrl(img),
        annotations: annsByImage.get(img.id) ?? [],
        joinMethod: "none",
      };
    });
  }, [coco]);

  // ── Join images to poles ────────────────────────────────────────────────────
  const joinedImages = useMemo((): ImageRecord[] => {
    if (!imageRecords.length) return [];
    if (!polesIndex?.length || !poleGrid) {
      return imageRecords.map(r => ({ ...r, poleKey: undefined, assetId: undefined, joinMethod: "none" as const }));
    }

    const lat0 = polesIndex.reduce((s, p) => s + p.lat, 0) / polesIndex.length;
    const proj = buildProjector(lat0);

    return imageRecords.map(r => {
      // Manual override wins
      const ov = manualOverrides[r.cocoImage.file_name];
      if (ov) return { ...r, poleKey: ov.poleKey, assetId: ov.assetId, joinDistM: ov.distM, joinMethod: "manual" as const };

      if (r.lat == null || r.lon == null) return { ...r, joinMethod: "none" as const };

      const xy = proj.toXY(r.lat, r.lon);
      let cands = gridCandidates(poleGrid, xy.x, xy.y, Math.max(300, maxJoinM * 6));
      if (!cands.length) cands = polesIndex;

      const scored = cands
        .map(p => ({ p, d: haversineM(r.lat!, r.lon!, p.lat, p.lon) }))
        .sort((a, b) => a.d - b.d);

      const best = scored[0];
      if (!best || best.d > maxJoinM) return { ...r, joinMethod: "none" as const, joinDistM: best?.d };

      return { ...r, poleKey: best.p.poleKey, assetId: best.p.assetId, joinDistM: best.d, joinMethod: "gps" as const };
    });
  }, [imageRecords, polesIndex, poleGrid, maxJoinM, manualOverrides]);

  // ── Asset aggregation ───────────────────────────────────────────────────────
  const assetsMap = useMemo(() => {
    const map = new Map<string, AssetRecord>();
    if (!polesIndex?.length) return map;

    for (const pole of polesIndex) {
      map.set(pole.poleKey, {
        poleKey: pole.poleKey,
        assetId: pole.assetId,
        poleLat: pole.lat,
        poleLon: pole.lon,
        images: [],
        inventoryCounts: {},
        detectionTotals: {},
      });
    }

    for (const img of joinedImages) {
      if (!img.poleKey) continue;
      const asset = map.get(img.poleKey);
      if (!asset) continue;
      asset.images.push(img);

      // per-image category counts
      const perImg: Record<string, number> = {};
      for (const ann of img.annotations) {
        const name = catMap.get(ann.category_id) ?? `cat_${ann.category_id}`;
        perImg[name] = (perImg[name] ?? 0) + 1;
        asset.detectionTotals[name] = (asset.detectionTotals[name] ?? 0) + 1;
      }
      // inventory = max seen in any single image
      for (const [k, v] of Object.entries(perImg)) {
        asset.inventoryCounts[k] = Math.max(asset.inventoryCounts[k] ?? 0, v);
      }
    }

    return map;
  }, [polesIndex, joinedImages, catMap]);

  const assetsList = useMemo(() => {
    const arr = Array.from(assetsMap.values()).sort((a, b) => {
      const am = a.images.length > 0 ? 1 : 0, bm = b.images.length > 0 ? 1 : 0;
      if (bm !== am) return bm - am;
      if (b.images.length !== a.images.length) return b.images.length - a.images.length;
      return a.assetId.localeCompare(b.assetId);
    });
    return arr;
  }, [assetsMap]);

  const filteredAssets = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return assetsList;
    return assetsList.filter(a =>
      a.assetId.toLowerCase().includes(q) ||
      Object.keys(a.inventoryCounts).some(k => k.toLowerCase().includes(q))
    );
  }, [assetsList, search]);

  const selectedAsset = useMemo(() => selectedPoleKey ? assetsMap.get(selectedPoleKey) ?? null : null, [assetsMap, selectedPoleKey]);

  const unassignedImages = useMemo(() => joinedImages.filter(r => !r.poleKey), [joinedImages]);

  // ── Nearest poles for an image (for unassigned panel) ───────────────────────
  const getNearestPoles = useCallback((lat: number, lon: number, k = 3) => {
    if (!polesIndex?.length || !poleGrid) return [];
    const lat0 = polesIndex.reduce((s, p) => s + p.lat, 0) / polesIndex.length;
    const proj = buildProjector(lat0);
    const xy = proj.toXY(lat, lon);
    let cands = gridCandidates(poleGrid, xy.x, xy.y, Math.max(300, maxJoinM * 8));
    if (!cands.length) cands = polesIndex;
    return cands
      .map(p => ({ ...p, distM: haversineM(lat, lon, p.lat, p.lon) }))
      .sort((a, b) => a.distM - b.distM)
      .slice(0, k);
  }, [polesIndex, poleGrid, maxJoinM]);

  const candidatePoles = useMemo(() => {
    if (!selectedUnassigned?.lat || !selectedUnassigned?.lon) return [];
    return getNearestPoles(selectedUnassigned.lat, selectedUnassigned.lon, 3);
  }, [selectedUnassigned, getNearestPoles]);

  const fitPoints = useMemo((): [number, number][] => {
    if (!selectedUnassigned?.lat || !selectedUnassigned?.lon) return [];
    const pts: [number, number][] = [[selectedUnassigned.lat, selectedUnassigned.lon]];
    for (const p of candidatePoles) pts.push([p.lat, p.lon]);
    return pts;
  }, [selectedUnassigned, candidatePoles]);

  // ── Stats ────────────────────────────────────────────────────────────────────
  const stats = useMemo(() => ({
    images: coco?.images.length ?? 0,
    annotations: coco?.annotations.length ?? 0,
    poles: polesGeoJson?.features.length ?? 0,
    matched: joinedImages.filter(r => !!r.poleKey).length,
    unmatched: joinedImages.filter(r => !r.poleKey).length,
    assetsWithImages: assetsList.filter(a => a.images.length > 0).length,
    overrides: Object.keys(manualOverrides).length,
  }), [coco, polesGeoJson, joinedImages, assetsList, manualOverrides]);

  const mapCenter = useMemo((): [number, number] => {
    if (selectedUnassigned?.lat && selectedUnassigned?.lon) return [selectedUnassigned.lat, selectedUnassigned.lon];
    if (selectedAsset) return [selectedAsset.poleLat, selectedAsset.poleLon];
    if (polesIndex?.length) return [polesIndex[0].lat, polesIndex[0].lon];
    return [-33.86, 151.21];
  }, [selectedAsset, selectedUnassigned, polesIndex]);

  // ── Marker GeoJSON (using polesIndex coords so map == join calc) ─────────────
  const markerGeoJson = useMemo(() => {
    if (!polesIndex?.length) return null;
    return {
      type: "FeatureCollection",
      features: polesIndex.map(p => ({
        type: "Feature",
        properties: { _pk: p.poleKey, _id: p.assetId },
        geometry: { type: "Point", coordinates: [p.lon, p.lat] },
      })),
    } as any;
  }, [polesIndex]);

  // ── File upload handlers ─────────────────────────────────────────────────────
  const onLoadCoco = async (file: File) => {
    setCocoError(null);
    try {
      const text = await file.text();
      const parsed: CocoData = JSON.parse(text);
      if (!Array.isArray(parsed.images) || !Array.isArray(parsed.annotations))
        throw new Error("Not a valid COCO JSON — missing images or annotations arrays.");
      setCoco(parsed);
      setManualOverrides({});
    } catch (e: any) { setCocoError(e?.message ?? "Failed to parse COCO JSON."); }
  };

  const onLoadGeo = async (file: File) => {
    setGeoError(null);
    try {
      const parsed = JSON.parse(await file.text());
      if (parsed.type !== "FeatureCollection" || !Array.isArray(parsed.features))
        throw new Error("Not a valid GeoJSON FeatureCollection.");
      setPolesGeoJson(parsed);
    } catch (e: any) { setGeoError(e?.message ?? "Failed to parse GeoJSON."); }
  };

  const clearAll = () => {
    setCoco(null); setPolesGeoJson(null); setCocoError(null); setGeoError(null);
    setSearch(""); setSelectedPoleKey(null); setSelectedImage(null);
    setSelectedUnassigned(null); setManualOverrides({}); setRightTab("asset");
    setDedupOff(new Set());
  };

  const assignImage = (img: ImageRecord, poleKey: string, assetId: string, distM?: number) => {
    setManualOverrides(prev => ({ ...prev, [img.cocoImage.file_name]: { poleKey, assetId, distM } }));
    setSelectedPoleKey(poleKey);
    setSelectedUnassigned(null);
    setSelectedImage(null);
    setRightTab("asset");
  };

  const clearOverride = (img: ImageRecord) => {
    setManualOverrides(prev => { const n = { ...prev }; delete n[img.cocoImage.file_name]; return n; });
  };

  const toggleDedup = (poleKey: string) => {
    setDedupOff(prev => {
      const next = new Set(prev);
      next.has(poleKey) ? next.delete(poleKey) : next.add(poleKey);
      return next;
    });
  };

  // ─── Styles (inline CSS vars matching annotation tool design language) ────────
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden", background: "#f4f6f9", color: "#1a2332", fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 14 }}>

      {/* ── HEADER ─────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "0 20px", height: 52, background: "#fff", borderBottom: "1px solid #d8dde6", flexShrink: 0, zIndex: 50 }}>
        <div style={{ width: 24, height: 24, background: "#00a872", clipPath: "polygon(50% 0%,100% 25%,100% 75%,50% 100%,0% 75%,0% 25%)" }} />
        <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 12, fontWeight: 600, letterSpacing: ".1em", textTransform: "uppercase" }}>
          Unleash<span style={{ color: "#00a872" }}>Live</span>
        </span>
        <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: "#a0aab8", marginLeft: 2 }}>/ Asset Media Browser</span>
        <div style={{ flex: 1 }} />

        {/* Stats row */}
        {(coco || polesGeoJson) && (
          <div style={{ display: "flex", gap: 16, fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: "#5a6880" }}>
            {coco && <span>Images <b style={{ color: "#1a2332" }}>{stats.images}</b></span>}
            {coco && <span>Detections <b style={{ color: "#1a2332" }}>{stats.annotations}</b></span>}
            {polesGeoJson && <span>Poles <b style={{ color: "#1a2332" }}>{stats.poles}</b></span>}
            {coco && polesGeoJson && <span style={{ color: "#00a872" }}>Matched <b>{stats.matched}</b></span>}
            {coco && polesGeoJson && <span style={{ color: "#d4820a" }}>Unmatched <b>{stats.unmatched}</b></span>}
            {stats.overrides > 0 && <span style={{ color: "#1a6fd4" }}>Overrides <b>{stats.overrides}</b></span>}
          </div>
        )}

        <div style={{ display: "flex", gap: 6, marginLeft: 12 }}>
          {/* COCO upload */}
          <input ref={cocoRef} type="file" accept=".json" style={{ display: "none" }}
            onChange={e => { const f = e.target.files?.[0]; if (f) onLoadCoco(f); if (cocoRef.current) cocoRef.current.value = ""; }} />
          <button onClick={() => cocoRef.current?.click()} style={btnStyle("#00a872")}>
            ↑ COCO JSON
          </button>

          {/* GeoJSON upload */}
          <input ref={geoRef} type="file" accept=".geojson,.json" style={{ display: "none" }}
            onChange={e => { const f = e.target.files?.[0]; if (f) onLoadGeo(f); if (geoRef.current) geoRef.current.value = ""; }} />
          <button onClick={() => geoRef.current?.click()} style={btnStyle("#1a6fd4")}>
            ↑ GeoJSON
          </button>

          {(coco || polesGeoJson) && (
            <button onClick={clearAll} style={btnOutlineStyle}>✕ Clear</button>
          )}
        </div>
      </div>

      {/* Error bar */}
      {(cocoError || geoError) && (
        <div style={{ background: "#fdf0f0", borderBottom: "1px solid #d4002e", padding: "6px 20px", fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: "#d4002e", flexShrink: 0 }}>
          {cocoError && <span>COCO: {cocoError}  </span>}
          {geoError && <span>GeoJSON: {geoError}</span>}
        </div>
      )}

      {/* ── BODY ───────────────────────────────────────────────────────────── */}
      {!coco && !polesGeoJson ? (
        // Empty state
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, color: "#a0aab8" }}>
          <div style={{ fontSize: 48, opacity: .3 }}>◈</div>
          <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 12 }}>Upload a COCO JSON and poles GeoJSON to begin</div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button onClick={() => cocoRef.current?.click()} style={btnStyle("#00a872")}>↑ Upload COCO JSON</button>
            <button onClick={() => geoRef.current?.click()} style={btnStyle("#1a6fd4")}>↑ Upload GeoJSON</button>
          </div>
          {/* Config row */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: "#5a6880" }}>
            <span>Max join distance</span>
            <input type="number" value={maxJoinM} onChange={e => setMaxJoinM(Math.max(0, +e.target.value))}
              style={{ width: 70, background: "#f0f2f5", border: "1px solid #d8dde6", borderRadius: 2, color: "#1a2332", fontFamily: "inherit", fontSize: 11, padding: "4px 8px", outline: "none" }} />
            <span>m</span>
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

          {/* ── LEFT PANE: Asset list ─────────────────────────────────────── */}
          <div style={{ width: 280, flexShrink: 0, background: "#fff", borderRight: "1px solid #d8dde6", display: "flex", flexDirection: "column", overflow: "hidden" }}>

            {/* Controls */}
            <div style={{ padding: "10px 14px", borderBottom: "1px solid #e8ebf0", flexShrink: 0 }}>
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search asset ID or class…"
                style={{ width: "100%", background: "#f0f2f5", border: "1px solid #d8dde6", borderRadius: 2, color: "#1a2332", fontFamily: "'IBM Plex Mono',monospace", fontSize: 11, padding: "6px 9px", outline: "none" }} />
              <div style={{ display: "flex", gap: 4, marginTop: 6, fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, color: "#5a6880" }}>
                <span>Max join</span>
                <input type="number" value={maxJoinM} onChange={e => setMaxJoinM(Math.max(0, +e.target.value))}
                  style={{ width: 54, background: "#f0f2f5", border: "1px solid #d8dde6", borderRadius: 2, color: "#1a2332", fontFamily: "inherit", fontSize: 9, padding: "2px 5px", outline: "none" }} />
                <span>m</span>
              </div>
            </div>

            {/* Asset / Unassigned tabs */}
            <div style={{ display: "flex", borderBottom: "1px solid #d8dde6", flexShrink: 0 }}>
              <button onClick={() => setRightTab("asset")} style={tabStyle(rightTab === "asset")}>
                Assets ({filteredAssets.length})
              </button>
              <button onClick={() => { setRightTab("unassigned"); setSelectedPoleKey(null); setSelectedImage(null); }} style={tabStyle(rightTab === "unassigned")}>
                Unassigned ({unassignedImages.length})
              </button>
            </div>

            {/* List */}
            <div style={{ flex: 1, overflowY: "auto" }}>
              {rightTab === "asset" ? filteredAssets.map(a => {
                const invTotal = Object.values(a.inventoryCounts).reduce((s, v) => s + v, 0);
                const faultTotal = Object.entries(a.inventoryCounts)
                  .filter(([k]) => k.includes("."))
                  .reduce((s, [, v]) => s + v, 0);
                return (
                  <button key={a.poleKey}
                    onClick={() => { setSelectedPoleKey(a.poleKey); setSelectedImage(null); setSelectedUnassigned(null); setRightTab("asset"); }}
                    style={{ ...assetRowStyle, borderLeft: selectedPoleKey === a.poleKey ? "3px solid #00a872" : "3px solid transparent", background: selectedPoleKey === a.poleKey ? "#f0f8f5" : "transparent" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
                      <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 11, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 170 }}>{a.assetId}</span>
                      <span style={{ ...pillStyle, background: a.images.length ? "rgba(0,168,114,.1)" : "#f0f2f5", color: a.images.length ? "#00a872" : "#a0aab8" }}>
                        {a.images.length ? `${a.images.length} img` : "—"}
                      </span>
                    </div>
                    <div style={{ display: "flex", gap: 10, fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, color: "#5a6880" }}>
                      <span>Components <b style={{ color: "#1a2332" }}>{invTotal}</b></span>
                      <span>Faults <b style={{ color: faultTotal > 0 ? "#d4820a" : "#1a2332" }}>{faultTotal}</b></span>
                    </div>
                  </button>
                );
              }) : unassignedImages.map(img => {
                const topCat = img.annotations[0] ? catMap.get(img.annotations[0].category_id) : undefined;
                return (
                  <button key={img.cocoImage.id}
                    onClick={() => { setSelectedUnassigned(img); setSelectedPoleKey(null); setSelectedImage(null); }}
                    style={{ ...assetRowStyle, borderLeft: selectedUnassigned?.cocoImage.id === img.cocoImage.id ? "3px solid #d4820a" : "3px solid transparent", background: selectedUnassigned?.cocoImage.id === img.cocoImage.id ? "#fffaf0" : "transparent" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
                      <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 180 }}>{img.cocoImage.file_name}</span>
                      <span style={{ ...pillStyle, background: img.lat ? "rgba(26,111,212,.1)" : "#f0f2f5", color: img.lat ? "#1a6fd4" : "#a0aab8" }}>
                        {img.lat ? "GPS" : "no GPS"}
                      </span>
                    </div>
                    <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, color: "#5a6880" }}>
                      {img.annotations.length} detections {topCat ? `· ${topCat}` : ""}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* ── MAP ──────────────────────────────────────────────────────── */}
          <div style={{ flex: 1, position: "relative" }}>
            <MapContainer center={mapCenter} zoom={selectedAsset || selectedUnassigned ? 17 : 12}
              style={{ height: "100%", width: "100%" }} scrollWheelZoom>
              <TileLayer url={DEFAULT_TILE} />

              {markerGeoJson && (
                <GeoJSON data={markerGeoJson} pointToLayer={(feature, latlng) => {
                  const m = L.circleMarker(latlng, { radius: 5, weight: 1, opacity: .9, fillOpacity: .7 } as any);
                  m.on("click", () => {
                    const pk = feature?.properties?._pk as string;
                    if (pk) { setSelectedPoleKey(pk); setSelectedImage(null); setSelectedUnassigned(null); setRightTab("asset"); }
                  });
                  return m;
                }} />
              )}

              {/* Selected asset: pole marker + red image dots */}
              {selectedAsset && (
                <>
                  <MapFlyTo lat={selectedAsset.poleLat} lon={selectedAsset.poleLon} zoom={17} />
                  <Marker position={[selectedAsset.poleLat, selectedAsset.poleLon]}>
                    <Popup><div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 11 }}>
                      <b>{selectedAsset.assetId}</b><br />
                      {selectedAsset.images.length} images · {Object.values(selectedAsset.inventoryCounts).reduce((s, v) => s + v, 0)} components
                    </div></Popup>
                  </Marker>
                  {selectedAsset.images.filter(r => r.lat && r.lon).map(r => (
                    <CircleMarker key={r.cocoImage.id} center={[r.lat!, r.lon!]} radius={6}
                      pathOptions={{ color: "#d4002e", fillColor: "#d4002e", fillOpacity: .75, weight: 1 }}
                      eventHandlers={{ click: () => setSelectedImage(r) }}>
                      <Popup><div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10 }}>
                        {r.cocoImage.file_name}<br />{r.annotations.length} detections · {fmtM(r.joinDistM)}
                      </div></Popup>
                    </CircleMarker>
                  ))}
                </>
              )}

              {/* Unassigned image + candidate poles */}
              {selectedUnassigned?.lat && selectedUnassigned?.lon && (
                <>
                  <FitBounds points={fitPoints} />
                  <CircleMarker center={[selectedUnassigned.lat, selectedUnassigned.lon]} radius={8}
                    pathOptions={{ color: "#d4820a", fillColor: "#d4820a", fillOpacity: .85, weight: 2 }}>
                    <Popup><div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10 }}>
                      Unassigned: {selectedUnassigned.cocoImage.file_name}
                    </div></Popup>
                  </CircleMarker>
                  {candidatePoles.map((p, i) => (
                    <React.Fragment key={p.poleKey}>
                      <CircleMarker center={[p.lat, p.lon]} radius={7}
                        pathOptions={{ color: i === 0 ? "#1a6fd4" : "#888", fillColor: i === 0 ? "#1a6fd4" : "#888", fillOpacity: .75, weight: 2 }}>
                        <Popup><div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10 }}>
                          {p.assetId}<br />{fmtM(p.distM)}
                        </div></Popup>
                      </CircleMarker>
                      <Polyline positions={[[selectedUnassigned.lat!, selectedUnassigned.lon!], [p.lat, p.lon]]}
                        pathOptions={{ color: i === 0 ? "#1a6fd4" : "#bbb", weight: i === 0 ? 2 : 1, opacity: .7 }} />
                    </React.Fragment>
                  ))}
                </>
              )}
            </MapContainer>
          </div>

          {/* ── RIGHT PANE: Detail ─────────────────────────────────────────── */}
          <div style={{ width: 340, flexShrink: 0, background: "#fff", borderLeft: "1px solid #d8dde6", overflow: "hidden", display: "flex", flexDirection: "column" }}>

            {/* Unassigned detail */}
            {rightTab === "unassigned" && selectedUnassigned ? (
              <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
                <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, color: "#5a6880", textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 6 }}>Unassigned Image</div>
                <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 11, fontWeight: 600, marginBottom: 12, wordBreak: "break-all" }}>{selectedUnassigned.cocoImage.file_name}</div>

                {selectedUnassigned.imageUrl && (
                  <div style={{ marginBottom: 12 }}>
                    <img src={selectedUnassigned.imageUrl} alt="" style={{ width: "100%", borderRadius: 3, display: "block" }}
                      onError={e => (e.currentTarget.style.display = "none")} />
                  </div>
                )}

                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
                  <span style={tagStyle}>{selectedUnassigned.annotations.length} detections</span>
                  <span style={{ ...tagStyle, color: selectedUnassigned.lat ? "#1a6fd4" : "#a0aab8" }}>
                    {selectedUnassigned.lat ? `GPS ${selectedUnassigned.lat?.toFixed(5)}, ${selectedUnassigned.lon?.toFixed(5)}` : "No GPS"}
                  </span>
                  {selectedUnassigned.joinDistM && <span style={tagStyle}>Nearest {fmtM(selectedUnassigned.joinDistM)}</span>}
                </div>

                {/* Assign buttons */}
                <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, color: "#5a6880", textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 8 }}>Assign to Pole</div>
                {!selectedUnassigned.lat ? (
                  <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: "#a0aab8" }}>No GPS — cannot suggest poles</div>
                ) : candidatePoles.length ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {candidatePoles.map((p, i) => (
                      <button key={p.poleKey} onClick={() => assignImage(selectedUnassigned, p.poleKey, p.assetId, p.distM)}
                        style={{ padding: "8px 12px", background: i === 0 ? "rgba(26,111,212,.07)" : "#f0f2f5", border: `1px solid ${i === 0 ? "#1a6fd4" : "#d8dde6"}`, borderRadius: 3, cursor: "pointer", textAlign: "left", fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: i === 0 ? "#1a6fd4" : "#1a2332" }}>
                        <b>{p.assetId}</b> <span style={{ color: "#5a6880" }}>· {fmtM(p.distM)}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: "#a0aab8" }}>No poles found — try increasing max join distance</div>
                )}

                {manualOverrides[selectedUnassigned.cocoImage.file_name] && (
                  <button onClick={() => clearOverride(selectedUnassigned)} style={{ marginTop: 10, width: "100%", padding: "6px", background: "rgba(212,0,46,.06)", border: "1px solid #d4002e", borderRadius: 2, color: "#d4002e", fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, cursor: "pointer" }}>
                    ✕ Clear Override
                  </button>
                )}

                {selectedUnassigned.lat && (
                  <a href={`https://www.google.com/maps?q=${selectedUnassigned.lat},${selectedUnassigned.lon}`}
                    target="_blank" rel="noreferrer"
                    style={{ display: "block", marginTop: 10, fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, color: "#1a6fd4", textDecoration: "none" }}>
                    ↗ Open in Google Maps
                  </a>
                )}
              </div>

            ) : !selectedAsset ? (
              <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#a0aab8", gap: 8 }}>
                <div style={{ fontSize: 32, opacity: .3 }}>◧</div>
                <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 11 }}>
                  {!coco ? "Upload a COCO JSON to begin" : !polesGeoJson ? "Upload a GeoJSON to join to poles" : "Select an asset or unassigned image"}
                </div>
              </div>

            ) : (
              /* ── Asset detail ──────────────────────────────────────────── */
              <div style={{ flex: 1, overflowY: "auto" }}>

                {/* Header */}
                <div style={{ padding: "12px 16px", borderBottom: "1px solid #e8ebf0", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div>
                    <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, color: "#5a6880", textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 3 }}>Asset ID</div>
                    <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 13, fontWeight: 700, wordBreak: "break-all" }}>{selectedAsset.assetId}</div>
                  </div>
                  <button onClick={() => { setSelectedPoleKey(null); setSelectedImage(null); }} style={btnOutlineStyle}>✕</button>
                </div>

                {/* Summary cards */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, padding: "10px 14px", borderBottom: "1px solid #e8ebf0" }}>
                  {[["Images", selectedAsset.images.length, "#1a2332"],
                  ["Components", Object.values(selectedAsset.inventoryCounts).reduce((s, v) => s + v, 0), "#1a2332"],
                  ["Faults", Object.entries(selectedAsset.inventoryCounts).filter(([k]) => k.includes(".")).reduce((s, [, v]) => s + v, 0), "#d4820a"],
                  ].map(([label, val, col]) => (
                    <div key={String(label)} style={{ background: "#f4f6f9", borderRadius: 3, padding: "8px 10px" }}>
                      <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 8, color: "#5a6880", textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 2 }}>{label}</div>
                      <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 18, fontWeight: 700, color: String(col) }}>{val}</div>
                    </div>
                  ))}
                </div>

                {/* Detection inventory with dedup toggle */}
                <div style={{ padding: "10px 14px", borderBottom: "1px solid #e8ebf0" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, color: "#5a6880", textTransform: "uppercase", letterSpacing: ".1em" }}>
                      Detection Inventory
                    </span>
                    <button onClick={() => toggleDedup(selectedAsset.poleKey)}
                      style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 8, padding: "2px 8px", background: dedupOff.has(selectedAsset.poleKey) ? "rgba(212,130,10,.1)" : "rgba(0,168,114,.1)", border: `1px solid ${dedupOff.has(selectedAsset.poleKey) ? "#d4820a" : "#00a872"}`, borderRadius: 2, cursor: "pointer", color: dedupOff.has(selectedAsset.poleKey) ? "#d4820a" : "#00a872" }}>
                      {dedupOff.has(selectedAsset.poleKey) ? "⚠ Duplication ON" : "✓ Deduplication ON"}
                    </button>
                  </div>
                  <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, color: "#a0aab8", marginBottom: 8 }}>
                    {dedupOff.has(selectedAsset.poleKey)
                      ? "Showing raw totals summed across all images (may include duplicates)"
                      : "Inventory = max count seen in any single image — removes cross-image duplicates"}
                  </div>

                  {/* Category table */}
                  {(() => {
                    const counts = dedupOff.has(selectedAsset.poleKey)
                      ? selectedAsset.detectionTotals
                      : selectedAsset.inventoryCounts;
                    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
                    if (!entries.length) return <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: "#a0aab8" }}>No detections</div>;
                    return (
                      <table style={{ width: "100%", borderCollapse: "collapse" }}>
                        <tbody>
                          {entries.map(([cat, cnt]) => {
                            const isFault = cat.includes(".");
                            const [component, condition] = cat.split(".");
                            return (
                              <tr key={cat} style={{ borderBottom: "1px solid #f0f2f5" }}>
                                <td style={{ padding: "4px 0", fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: "#1a2332" }}>
                                  {isFault ? <><span style={{ color: "#5a6880" }}>{component}</span><span style={{ color: "#d4820a" }}>.{condition}</span></> : cat}
                                </td>
                                <td style={{ padding: "4px 0", textAlign: "right", fontFamily: "'IBM Plex Mono',monospace", fontSize: 11, fontWeight: 700, color: isFault ? "#d4820a" : "#00a872", width: 32 }}>
                                  {cnt}
                                </td>
                                {!dedupOff.has(selectedAsset.poleKey) && selectedAsset.detectionTotals[cat] > cnt && (
                                  <td style={{ padding: "4px 0 4px 6px", fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, color: "#a0aab8", whiteSpace: "nowrap" }}>
                                    ({selectedAsset.detectionTotals[cat]} raw)
                                  </td>
                                )}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    );
                  })()}
                </div>

                {/* Images grid */}
                <div style={{ padding: "10px 14px" }}>
                  <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, color: "#5a6880", textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 6 }}>
                    Images · Red dots on map are clickable
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    {selectedAsset.images.map(img => {
                      const topAnn = img.annotations[0];
                      const topCat = topAnn ? catMap.get(topAnn.category_id) : undefined;
                      return (
                        <button key={img.cocoImage.id} onClick={() => setSelectedImage(img)}
                          style={{ background: "#f4f6f9", border: "1px solid #e8ebf0", borderRadius: 3, overflow: "hidden", cursor: "pointer", textAlign: "left", padding: 0, transition: "border-color .1s" }}>
                          <div style={{ width: "100%", aspectRatio: "16/9", background: "#e8ebf0", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
                            {img.imageUrl ? (
                              <img src={img.imageUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} loading="lazy"
                                onError={e => { e.currentTarget.style.display = "none"; }} />
                            ) : (
                              <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, color: "#a0aab8" }}>No URL</span>
                            )}
                          </div>
                          <div style={{ padding: "5px 7px" }}>
                            <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#1a2332" }}>
                              {topCat ?? "Image"}
                            </div>
                            <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 8, color: "#5a6880" }}>
                              {img.annotations.length} det · {fmtM(img.joinDistM)} · {img.joinMethod}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── IMAGE MODAL ─────────────────────────────────────────────────────── */}
      {selectedImage && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.7)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => setSelectedImage(null)}>
          <div style={{ background: "#fff", borderRadius: 6, width: "90vw", maxWidth: 900, maxHeight: "90vh", overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: "0 8px 40px rgba(0,0,0,.4)" }}
            onClick={e => e.stopPropagation()}>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", borderBottom: "1px solid #e8ebf0" }}>
              <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 11, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 700 }}>
                {selectedImage.cocoImage.file_name}
              </span>
              <button onClick={() => setSelectedImage(null)} style={btnOutlineStyle}>✕ Close</button>
            </div>

            <div style={{ display: "flex", flex: 1, overflow: "hidden", minHeight: 0 }}>
              {/* Image */}
              <div style={{ flex: 1, background: "#1a2332", display: "flex", alignItems: "center", justifyContent: "center", minWidth: 0 }}>
                {selectedImage.imageUrl ? (
                  <img src={selectedImage.imageUrl} alt="" style={{ maxWidth: "100%", maxHeight: "72vh", objectFit: "contain" }} />
                ) : (
                  <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 11, color: "#a0aab8" }}>No image URL</div>
                )}
              </div>

              {/* Info panel */}
              <div style={{ width: 260, flexShrink: 0, overflowY: "auto", padding: 16, borderLeft: "1px solid #e8ebf0" }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 12 }}>
                  {[
                    ["Source", selectedImage.joinMethod],
                    ["Join", fmtM(selectedImage.joinDistM)],
                    ["Detections", String(selectedImage.annotations.length)],
                    ...(selectedImage.lat ? [["GPS", `${selectedImage.lat?.toFixed(4)},${selectedImage.lon?.toFixed(4)}`]] : []),
                  ].map(([k, v]) => (
                    <div key={k} style={{ background: "#f4f6f9", border: "1px solid #e8ebf0", borderRadius: 2, padding: "3px 8px", fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, color: "#5a6880" }}>
                      {k}: <b style={{ color: "#1a2332" }}>{v}</b>
                    </div>
                  ))}
                </div>

                <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, color: "#5a6880", textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 8 }}>Detections in this image</div>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <tbody>
                    {selectedImage.annotations.map(ann => {
                      const cat = catMap.get(ann.category_id) ?? `cat_${ann.category_id}`;
                      const score = ann.score != null ? `${Math.round(ann.score * 100)}%` : "";
                      return (
                        <tr key={ann.id} style={{ borderBottom: "1px solid #f0f2f5" }}>
                          <td style={{ padding: "4px 0", fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, color: cat.includes(".") ? "#d4820a" : "#1a2332" }}>{cat}</td>
                          {score && <td style={{ padding: "4px 0", textAlign: "right", fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, color: "#a0aab8" }}>{score}</td>}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                {selectedImage.imageUrl && (
                  <a href={selectedImage.imageUrl} target="_blank" rel="noreferrer"
                    style={{ display: "block", marginTop: 12, fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, color: "#1a6fd4", textDecoration: "none" }}>
                    ↗ Open full image
                  </a>
                )}
                {selectedImage.lat && (
                  <a href={`https://www.google.com/maps?q=${selectedImage.lat},${selectedImage.lon}`} target="_blank" rel="noreferrer"
                    style={{ display: "block", marginTop: 6, fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, color: "#1a6fd4", textDecoration: "none" }}>
                    ↗ Open in Google Maps
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Mini style helpers ───────────────────────────────────────────────────────

function btnStyle(color: string): React.CSSProperties {
  return { fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, letterSpacing: ".08em", textTransform: "uppercase", background: color, color: "#000", border: "none", borderRadius: 2, padding: "5px 14px", cursor: "pointer", fontWeight: 600 };
}
const btnOutlineStyle: React.CSSProperties = { fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, background: "transparent", border: "1px solid #d8dde6", color: "#5a6880", borderRadius: 2, padding: "5px 12px", cursor: "pointer" };
const pillStyle: React.CSSProperties = { fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, padding: "2px 7px", borderRadius: 2, whiteSpace: "nowrap" };
const tagStyle: React.CSSProperties = { fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, padding: "2px 8px", borderRadius: 2, background: "#f0f2f5", border: "1px solid #e8ebf0", color: "#5a6880" };
const assetRowStyle: React.CSSProperties = { display: "block", width: "100%", background: "transparent", border: "none", borderBottom: "1px solid #f0f2f5", padding: "8px 12px", cursor: "pointer", textAlign: "left", color: "#1a2332", transition: "background .1s" };
function tabStyle(active: boolean): React.CSSProperties {
  return { flex: 1, fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, padding: "7px", background: active ? "#fff" : "#f4f6f9", border: "none", borderBottom: active ? "2px solid #00a872" : "2px solid transparent", color: active ? "#00a872" : "#5a6880", cursor: "pointer", fontWeight: active ? 600 : 400, transition: "all .1s" };
}
