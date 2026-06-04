import React, { useMemo, useRef, useState, useCallback } from "react";
import {
  MapContainer, TileLayer, GeoJSON, Marker, Popup, useMap,
  CircleMarker, Polyline, LayerGroup,
} from "react-leaflet";
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
  lat?: number | null;
  lng?: number | null;
  gpslat?: number | null;
  gpslng?: number | null;
  width?: number;
  height?: number;
  alt?: number;
  date_captured?: number;
};

type CocoAnnotation = {
  id: number;
  image_id: number;
  category_id: number;
  bbox?: [number, number, number, number];
  score?: number;
  area?: number;
  iscrowd?: number;
  aiAppId?: string;
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
  info?: {
    sessionId?: string;
    sessionName?: string;
    description?: string;
    date_created?: string;
    [key: string]: unknown;
  };
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
  missionKey?: string;     // spatial cluster key
  poleKey?: string;
  assetId?: string;
  joinDistM?: number;
  joinMethod: "gps" | "manual" | "none";
};

// A spatial cluster of images hovering at the same GPS location = one "mission stop"
type MissionStop = {
  key: string;         // e.g. "stop_0"
  lat: number;
  lon: number;
  images: ImageRecord[];
  aiAppIds: string[];  // unique inspection profiles used
  // computed inventory for this stop
  inventoryCounts: Record<string, number>;   // deduped: max per image per cat
  detectionTotals: Record<string, number>;   // raw sum across all images
  canonicalImageCount: number;               // how many images used for dedup
  // join result
  poleKey?: string;
  assetId?: string;
  joinDistM?: number;
};

type AssetRecord = {
  poleKey: string;
  assetId: string;
  poleLat: number;
  poleLon: number;
  images: ImageRecord[];
  stops: MissionStop[];
  inventoryCounts: Record<string, number>;   // deduped: max per image per cat
  detectionTotals: Record<string, number>;   // raw sum
};

type ManualOverride = { poleKey: string; assetId: string; distM?: number };

// ─── Constants ────────────────────────────────────────────────────────────────

const CDN_BASE = "https://library.unleashlive.com/";
const DEFAULT_TILE = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const MISSION_CLUSTER_RADIUS_M = 25; // images within 25m = same hover stop

// Known Unleash Live Smart Inspect mission profiles
// imagesPerStop = expected number of images captured per pole hover
type MissionProfile = {
  id: string;
  label: string;
  assetType: string;
  widthM: number;
  imagesPerStop: number;
  description?: string;
};

const MISSION_PROFILES: MissionProfile[] = [
  { id: "wide-standoff-4", label: "Wide standoff — 4 Images, dual-angle", assetType: "Distribution Pole", widthM: 10, imagesPerStop: 4, description: "Two positions at wider radius, two gimbal angles per position" },
  { id: "wide-standoff-2", label: "Wide standoff — 2 Images", assetType: "Distribution Pole", widthM: 10, imagesPerStop: 2, description: "Two opposite angled photos from wider radius" },
  { id: "wide-cross-9", label: "Wide cross — 9 Images", assetType: "Distribution Pole", widthM: 8, imagesPerStop: 9, description: "Wide cross pattern (5) plus four lower-corner captures" },
  { id: "wide-cross-5", label: "Wide cross — 5 Images", assetType: "Distribution Pole", widthM: 7, imagesPerStop: 5, description: "Top-down reference plus four corner angled photos" },
  { id: "wide-aligned-3", label: "Wide aligned — 3 Images", assetType: "Distribution Pole", widthM: 50, imagesPerStop: 3, description: "Three-point wide aligned image capture" },
  { id: "tight-standoff-4", label: "Tight standoff — 4 Images, dual-angle", assetType: "Distribution Pole", widthM: 5, imagesPerStop: 4, description: "Two positions tight radius, two gimbal angles per position" },
  { id: "tight-standoff-2", label: "Tight standoff — 2 Images, steep angle", assetType: "Distribution Pole", widthM: 5, imagesPerStop: 2, description: "Two opposite angled photos at tight radius, steeper gimbal" },
  { id: "tight-cross-5", label: "Tight cross — 5 Images", assetType: "Distribution Pole", widthM: 4, imagesPerStop: 5, description: "Top-down plus four corner angled photos at smaller radius" },
  { id: "spot-check-2-no-nadir", label: "Spot check — 2 Images, no nadir", assetType: "Distribution Pole", widthM: 8, imagesPerStop: 2, description: "Two opposite angled photos, no top-down shot" },
  { id: "spot-check-1-nadir", label: "Spot check — 1 Image plus nadir", assetType: "Distribution Pole", widthM: 4, imagesPerStop: 2, description: "One top-down and one back corner photo" },
  { id: "scan-10", label: "10 Images, scan", assetType: "Distribution Pole", widthM: 12, imagesPerStop: 14, description: "Advanced 10-point scanning pattern, multi-altitude" },
  { id: "offset-tight-4", label: "Offset tight — 2+2 Images", assetType: "Distribution Pole", widthM: 8, imagesPerStop: 4, description: "Tight four-point with two 45° offset, nadir, departure" },
  { id: "offset-4", label: "Offset — 2+2 Images", assetType: "Distribution Pole", widthM: 10, imagesPerStop: 4, description: "Standard four-point with two 45° offset, nadir, departure" },
  { id: "grid-9", label: "Grid — 9 Images", assetType: "Distribution Pole", widthM: 23, imagesPerStop: 9, description: "Detailed 9-point grid for comprehensive inspection" },
  { id: "circular-7", label: "Circular — 7 Images", assetType: "Distribution Pole", widthM: 5, imagesPerStop: 7, description: "Circular pattern, center point and 6 surrounding waypoints" },
  { id: "aligned-4", label: "Aligned — 4 Images", assetType: "Distribution Pole", widthM: 10, imagesPerStop: 4, description: "Four-point aligned image capture" },
  { id: "aligned-3-approach", label: "Aligned — 3 Images plus approach", assetType: "Distribution Pole", widthM: 20, imagesPerStop: 3, description: "Three-point aligned plus approach shot" },
  { id: "si-dist-simple", label: "SI-Dist-Simple — 5 Images", assetType: "Distribution Pole", widthM: 10, imagesPerStop: 5 },
  { id: "ir-si-simple", label: "IR-SI-Simple — 10 Images", assetType: "Distribution Pole", widthM: 11, imagesPerStop: 10, description: "New pathing, z value: -1" },
  { id: "4-image-si", label: "4 Image SI", assetType: "Distribution Pole", widthM: 14, imagesPerStop: 4 },
  { id: "rgb-ir-simple-v2", label: "RGB&IR-SI-Simple-v2 — 5 Images", assetType: "Distribution Pole", widthM: 8, imagesPerStop: 5 },
  { id: "custom", label: "Custom / Unknown", assetType: "Any", widthM: 0, imagesPerStop: 0, description: "Manual — set expected images per stop below" },
];

const DefaultIcon = L.icon({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41], iconAnchor: [12, 41],
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

function computeStopInventory(
  stop: Omit<MissionStop, "inventoryCounts" | "detectionTotals" | "canonicalImageCount">,
  expectedImagesPerStop: number | null,
  catMap: Map<number, string>
): Pick<MissionStop, "inventoryCounts" | "detectionTotals" | "canonicalImageCount"> {
  // Sort by timestamp, take first N for canonical set
  const sorted = [...stop.images].sort(
    (a, b) => (a.cocoImage.date_captured ?? 0) - (b.cocoImage.date_captured ?? 0)
  );
  const canonicalN = expectedImagesPerStop && expectedImagesPerStop > 0
    ? Math.min(expectedImagesPerStop, sorted.length)
    : sorted.length;
  const canonical = sorted.slice(0, canonicalN);

  // Build per-image count arrays for each category across canonical images
  const countsByCategory = new Map<string, number[]>();
  const detectionTotals: Record<string, number> = {};

  for (const img of canonical) {
    const perImg: Record<string, number> = {};
    for (const ann of img.annotations) {
      const name = catMap.get(ann.category_id) ?? `cat_${ann.category_id}`;
      perImg[name] = (perImg[name] ?? 0) + 1;
    }
    for (const [name, cnt] of Object.entries(perImg)) {
      if (!countsByCategory.has(name)) countsByCategory.set(name, []);
      countsByCategory.get(name)!.push(cnt);
      detectionTotals[name] = (detectionTotals[name] ?? 0) + cnt;
    }
  }

  // Raw totals from extra images beyond canonical
  for (const img of sorted.slice(canonicalN)) {
    for (const ann of img.annotations) {
      const name = catMap.get(ann.category_id) ?? `cat_${ann.category_id}`;
      detectionTotals[name] = (detectionTotals[name] ?? 0) + 1;
    }
  }

  // Inventory = mode of non-zero counts per category
  // This is the most physically accurate: ignore misses (zeros), take the most
  // common count seen when the component was actually visible = true quantity on pole
  const inventoryCounts: Record<string, number> = {};
  for (const [name, counts] of countsByCategory.entries()) {
    const nonZero = counts.filter(c => c > 0);
    if (!nonZero.length) continue;
    // Calculate mode of non-zero counts
    const freq = new Map<number, number>();
    for (const c of nonZero) freq.set(c, (freq.get(c) ?? 0) + 1);
    let modeVal = nonZero[0], modeFreq = 0;
    for (const [val, f] of freq.entries()) {
      // Prefer higher frequency; on tie, prefer the lower count (conservative)
      if (f > modeFreq || (f === modeFreq && val < modeVal)) {
        modeVal = val; modeFreq = f;
      }
    }
    inventoryCounts[name] = modeVal;
  }

  return { inventoryCounts, detectionTotals, canonicalImageCount: canonicalN };
}
// Simple greedy clustering: iterate images sorted by timestamp, start a new
// cluster when an image is > MISSION_CLUSTER_RADIUS_M from the current centroid.

function clusterIntoStops(images: ImageRecord[]): MissionStop[] {
  const withGps = images.filter(r => r.lat != null && r.lon != null);
  if (!withGps.length) return [];

  // Sort by timestamp (date_captured), fallback to file_name order
  const sorted = [...withGps].sort((a, b) => {
    const ta = a.cocoImage.date_captured ?? 0;
    const tb = b.cocoImage.date_captured ?? 0;
    return ta !== tb ? ta - tb : a.cocoImage.file_name.localeCompare(b.cocoImage.file_name);
  });

  const stops: MissionStop[] = [];

  for (const img of sorted) {
    const lat = img.lat!, lon = img.lon!;

    // Find existing stop within cluster radius
    const existing = stops.find(s => haversineM(s.lat, s.lon, lat, lon) <= MISSION_CLUSTER_RADIUS_M);

    if (existing) {
      existing.images.push(img);
      // Update centroid
      existing.lat = existing.images.reduce((s, r) => s + r.lat!, 0) / existing.images.length;
      existing.lon = existing.images.reduce((s, r) => s + r.lon!, 0) / existing.images.length;
      const appId = img.annotations[0]?.aiAppId;
      if (appId && !existing.aiAppIds.includes(appId)) existing.aiAppIds.push(appId);
    } else {
      const appId = img.annotations[0]?.aiAppId;
      stops.push({
        key: `stop_${stops.length}`,
        lat, lon,
        images: [img],
        aiAppIds: appId ? [appId] : [],
        inventoryCounts: {},
        detectionTotals: {},
        canonicalImageCount: 0,
      });
    }
  }

  return stops;
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

// ─── Image URL ────────────────────────────────────────────────────────────────

function resolveImageUrl(img: CocoImage): string | undefined {
  if (img.s3Path) return CDN_BASE + img.s3Path;
  if (img.coco_url?.startsWith("http")) return img.coco_url;
  if (img.flickr_url?.startsWith("http")) return img.flickr_url;
  return undefined;
}

// ─── Formatting ───────────────────────────────────────────────────────────────

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
    if (points.length === 1) { map.flyTo(points[0], 17, { duration: 0.4 }); return; }
    map.fitBounds(L.latLngBounds(points), { padding: [pad, pad], maxZoom: 19 });
  }, [points, pad, map]);
  return null;
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const MONO = "'IBM Plex Mono', monospace";
const SANS = "'IBM Plex Sans', sans-serif";
const C = { bg: "#f4f6f9", s1: "#ffffff", s2: "#f0f2f5", b1: "#d8dde6", b2: "#c4cad6",
  text: "#1a2332", dim: "#5a6880", muted: "#a0aab8",
  accent: "#00a872", warn: "#d4820a", danger: "#d4002e", info: "#1a6fd4" };

const btnPrimary = (color: string): React.CSSProperties => ({
  fontFamily: MONO, fontSize: 10, letterSpacing: ".08em", textTransform: "uppercase",
  background: color, color: "#000", border: "none", borderRadius: 2,
  padding: "5px 14px", cursor: "pointer", fontWeight: 600,
});
const btnOutline: React.CSSProperties = {
  fontFamily: MONO, fontSize: 10, background: "transparent",
  border: `1px solid ${C.b2}`, color: C.dim, borderRadius: 2, padding: "5px 12px", cursor: "pointer",
};
const monoLabel = (size = 9): React.CSSProperties => ({
  fontFamily: MONO, fontSize: size, color: C.dim,
  textTransform: "uppercase", letterSpacing: ".1em",
});

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [coco, setCoco] = useState<CocoData | null>(null);
  const [polesGeoJson, setPolesGeoJson] = useState<FeatureCollection<Geometry, any> | null>(null);
  const [cocoError, setCocoError] = useState<string | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [maxJoinM, setMaxJoinM] = useState(120);

  // Selection state
  const [selectedPoleKey, setSelectedPoleKey] = useState<string | null>(null);
  const [selectedStopKey, setSelectedStopKey] = useState<string | null>(null);
  const [selectedImage, setSelectedImage] = useState<ImageRecord | null>(null);
  const [selectedUnassigned, setSelectedUnassigned] = useState<ImageRecord | null>(null);

  // Panel state
  const [leftTab, setLeftTab] = useState<"assets" | "stops" | "unassigned">("stops");
  const [manualOverrides, setManualOverrides] = useState<Record<string, ManualOverride>>({});
  const [dedupOff, setDedupOff] = useState<Set<string>>(new Set());
  const [activeProfile, setActiveProfile] = useState<string>("all");
  const [search, setSearch] = useState("");
  // Smart Inspect mission profile selection
  const [selectedMissionProfileId, setSelectedMissionProfileId] = useState<string | null>(null);
  const [customImagesPerStop, setCustomImagesPerStop] = useState<number>(5);

  const cocoRef = useRef<HTMLInputElement>(null);
  const geoRef = useRef<HTMLInputElement>(null);

  // ── Category map ────────────────────────────────────────────────────────────
  const catMap = useMemo(() => {
    if (!coco) return new Map<number, string>();
    const m = new Map<number, string>();
    for (const c of coco.categories) m.set(c.id, c.name);
    if (coco.labelConfigs)
      for (const cfg of Object.values(coco.labelConfigs))
        for (const c of cfg.categories ?? []) if (!m.has(c.id)) m.set(c.id, c.name);
    return m;
  }, [coco]);

  // ── All aiAppIds (inspection profiles) in this COCO ─────────────────────────
  const allProfiles = useMemo(() => {
    if (!coco) return [];
    const ids = new Set<string>();
    for (const ann of coco.annotations) if (ann.aiAppId) ids.add(ann.aiAppId);
    // Also pull from labelConfigs keys
    if (coco.labelConfigs) for (const k of Object.keys(coco.labelConfigs)) ids.add(k);
    return Array.from(ids);
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
    const list: PoleIndexRow[] = raw.map(p => {
      const xy = proj.toXY(p.lat, p.lon); return { ...p, ...xy, nearestDistM: undefined };
    });
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
      const lat = safeNum(img.lat ?? img.gpslat) ?? undefined;
      const lon = safeNum(img.lng ?? img.gpslng) ?? undefined;
      return {
        cocoImage: img, lat, lon,
        imageUrl: resolveImageUrl(img),
        annotations: annsByImage.get(img.id) ?? [],
        joinMethod: "none",
      };
    });
  }, [coco]);

  // ── Filter by active profile ─────────────────────────────────────────────────
  const filteredImageRecords = useMemo(() => {
    if (activeProfile === "all") return imageRecords;
    return imageRecords.map(r => ({
      ...r,
      annotations: r.annotations.filter(a => a.aiAppId === activeProfile),
    })).filter(r => r.annotations.length > 0);
  }, [imageRecords, activeProfile]);

  // ── Mission stops (spatial clusters) ─────────────────────────────────────────
  const missionStops = useMemo(() => clusterIntoStops(filteredImageRecords), [filteredImageRecords]);

  // ── Auto-detect mission profile from stop sizes ───────────────────────────────
  // When a COCO loads, look at the modal stop image count and suggest the best matching profile
  const autoDetectedProfileId = useMemo(() => {
    if (!missionStops.length) return null;
    // Find the most common stop size
    const sizes = missionStops.map(s => s.images.length);
    const freq = new Map<number, number>();
    for (const s of sizes) freq.set(s, (freq.get(s) ?? 0) + 1);
    const modalSize = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!modalSize) return null;
    // Find best matching profile by imagesPerStop
    const match = MISSION_PROFILES.find(p => p.imagesPerStop === modalSize && p.id !== "custom");
    return match?.id ?? null;
  }, [missionStops]);

  // Effective mission profile (user pick > auto-detect > null)
  const effectiveMissionProfile = useMemo(() => {
    const id = selectedMissionProfileId ?? autoDetectedProfileId;
    if (!id) return null;
    return MISSION_PROFILES.find(p => p.id === id) ?? null;
  }, [selectedMissionProfileId, autoDetectedProfileId]);

  const effectiveImagesPerStop = useMemo(() => {
    if (!effectiveMissionProfile) return null;
    if (effectiveMissionProfile.id === "custom") return customImagesPerStop;
    return effectiveMissionProfile.imagesPerStop;
  }, [effectiveMissionProfile, customImagesPerStop]);

  // ── Join stops (and images) to poles ─────────────────────────────────────────
  const joinedStops = useMemo((): MissionStop[] => {
    if (!missionStops.length || !polesIndex?.length || !poleGrid) {
      // Still compute inventory even without poles
      return missionStops.map(stop => ({
        ...stop,
        ...computeStopInventory(stop, effectiveImagesPerStop, catMap),
      }));
    }
    const lat0 = polesIndex.reduce((s, p) => s + p.lat, 0) / polesIndex.length;
    const proj = buildProjector(lat0);

    return missionStops.map(stop => {
      const inventory = computeStopInventory(stop, effectiveImagesPerStop, catMap);
      const xy = proj.toXY(stop.lat, stop.lon);
      let cands = gridCandidates(poleGrid, xy.x, xy.y, Math.max(300, maxJoinM * 6));
      if (!cands.length) cands = polesIndex;
      const scored = cands
        .map(p => ({ p, d: haversineM(stop.lat, stop.lon, p.lat, p.lon) }))
        .sort((a, b) => a.d - b.d);
      const best = scored[0];
      if (!best || best.d > maxJoinM) return { ...stop, ...inventory };
      const updatedImages = stop.images.map(img => ({
        ...img, poleKey: best.p.poleKey, assetId: best.p.assetId,
        joinDistM: haversineM(img.lat!, img.lon!, best.p.lat, best.p.lon),
        joinMethod: "gps" as const,
      }));
      return { ...stop, ...inventory, poleKey: best.p.poleKey, assetId: best.p.assetId, joinDistM: best.d, images: updatedImages };
    });
  }, [missionStops, polesIndex, poleGrid, maxJoinM, effectiveImagesPerStop, catMap]);

  // Apply manual overrides to individual images
  const joinedImages = useMemo((): ImageRecord[] => {
    const all: ImageRecord[] = [];
    for (const stop of joinedStops) all.push(...stop.images);
    // Images with no GPS that aren't in any stop
    for (const img of filteredImageRecords) {
      if (img.lat == null || img.lon == null) {
        const ov = manualOverrides[img.cocoImage.file_name];
        all.push(ov ? { ...img, poleKey: ov.poleKey, assetId: ov.assetId, joinDistM: ov.distM, joinMethod: "manual" } : img);
      }
    }
    return all;
  }, [joinedStops, filteredImageRecords, manualOverrides]);

  // ── Asset aggregation ────────────────────────────────────────────────────────
  const assetsMap = useMemo(() => {
    const map = new Map<string, AssetRecord>();
    if (!polesIndex?.length) return map;
    for (const pole of polesIndex)
      map.set(pole.poleKey, {
        poleKey: pole.poleKey, assetId: pole.assetId,
        poleLat: pole.lat, poleLon: pole.lon,
        images: [], stops: [],
        inventoryCounts: {}, detectionTotals: {},
      });

    for (const stop of joinedStops) {
      if (!stop.poleKey) continue;
      const asset = map.get(stop.poleKey);
      if (!asset) continue;
      asset.stops.push(stop);
      for (const img of stop.images) asset.images.push(img);

      // Asset inventory = max across stops (same component seen from 2 stops = still 1 component)
      for (const [k, v] of Object.entries(stop.inventoryCounts))
        asset.inventoryCounts[k] = Math.max(asset.inventoryCounts[k] ?? 0, v);

      // Raw totals = sum across stops
      for (const [k, v] of Object.entries(stop.detectionTotals))
        asset.detectionTotals[k] = (asset.detectionTotals[k] ?? 0) + v;
    }
    return map;
  }, [polesIndex, joinedStops]);

  const assetsList = useMemo(() => Array.from(assetsMap.values())
    .sort((a, b) => {
      if (b.images.length !== a.images.length) return b.images.length - a.images.length;
      return a.assetId.localeCompare(b.assetId);
    }), [assetsMap]);

  const filteredAssets = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return assetsList;
    return assetsList.filter(a =>
      a.assetId.toLowerCase().includes(q) ||
      Object.keys(a.inventoryCounts).some(k => k.toLowerCase().includes(q)));
  }, [assetsList, search]);

  const unassignedImages = useMemo(() => joinedImages.filter(r => !r.poleKey), [joinedImages]);
  const unassignedStops = useMemo(() => joinedStops.filter(s => !s.poleKey), [joinedStops]);

  const selectedAsset = useMemo(() => selectedPoleKey ? assetsMap.get(selectedPoleKey) ?? null : null, [assetsMap, selectedPoleKey]);
  const selectedStop = useMemo(() => joinedStops.find(s => s.key === selectedStopKey) ?? null, [joinedStops, selectedStopKey]);

  // ── Candidate poles for unassigned stop ─────────────────────────────────────
  const getNearestPoles = useCallback((lat: number, lon: number, k = 3) => {
    if (!polesIndex?.length || !poleGrid) return [];
    const lat0 = polesIndex.reduce((s, p) => s + p.lat, 0) / polesIndex.length;
    const proj = buildProjector(lat0);
    const xy = proj.toXY(lat, lon);
    let cands = gridCandidates(poleGrid, xy.x, xy.y, Math.max(400, maxJoinM * 8));
    if (!cands.length) cands = polesIndex;
    return cands.map(p => ({ ...p, distM: haversineM(lat, lon, p.lat, p.lon) }))
      .sort((a, b) => a.distM - b.distM).slice(0, k);
  }, [polesIndex, poleGrid, maxJoinM]);

  const candidatePoles = useMemo(() => {
    if (selectedStop && !selectedStop.poleKey)
      return getNearestPoles(selectedStop.lat, selectedStop.lon, 3);
    if (selectedUnassigned?.lat && selectedUnassigned?.lon)
      return getNearestPoles(selectedUnassigned.lat, selectedUnassigned.lon, 3);
    return [];
  }, [selectedStop, selectedUnassigned, getNearestPoles]);

  // ── All image GPS points (for "show all" view) ───────────────────────────────
  const allImagePoints = useMemo((): [number, number][] =>
    filteredImageRecords.filter(r => r.lat && r.lon).map(r => [r.lat!, r.lon!]),
    [filteredImageRecords]);

  const allStopPoints = useMemo((): [number, number][] =>
    missionStops.map(s => [s.lat, s.lon]),
    [missionStops]);

  const fitPoints = useMemo((): [number, number][] => {
    if (selectedStop) {
      const pts: [number, number][] = [[selectedStop.lat, selectedStop.lon]];
      for (const p of candidatePoles) pts.push([p.lat, p.lon]);
      return pts;
    }
    if (selectedAsset) return [[selectedAsset.poleLat, selectedAsset.poleLon]];
    if (allStopPoints.length) return allStopPoints;
    return allImagePoints;
  }, [selectedStop, selectedAsset, candidatePoles, allStopPoints, allImagePoints]);

  // ── Stats ────────────────────────────────────────────────────────────────────
  const stats = useMemo(() => ({
    images: coco?.images.length ?? 0,
    annotations: coco?.annotations.length ?? 0,
    stops: missionStops.length,
    stopsMatched: joinedStops.filter(s => !!s.poleKey).length,
    assetsWithImages: assetsList.filter(a => a.images.length > 0).length,
    sessionName: coco?.info?.sessionName,
    profileLabel: effectiveMissionProfile?.label ?? null,
    imagesPerStop: effectiveImagesPerStop,
    autoDetected: !selectedMissionProfileId && !!autoDetectedProfileId,
  }), [coco, missionStops, joinedStops, assetsList, effectiveMissionProfile, effectiveImagesPerStop, selectedMissionProfileId, autoDetectedProfileId]);

  // ── File upload handlers ─────────────────────────────────────────────────────
  const onLoadCoco = async (file: File) => {
    setCocoError(null);
    try {
      const parsed: CocoData = JSON.parse(await file.text());
      if (!Array.isArray(parsed.images) || !Array.isArray(parsed.annotations))
        throw new Error("Missing images or annotations arrays.");
      setCoco(parsed);
      setManualOverrides({});
      setSelectedPoleKey(null); setSelectedStopKey(null);
      setSelectedImage(null); setSelectedUnassigned(null);
      setActiveProfile("all");
      setLeftTab("stops");
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
    setSearch(""); setSelectedPoleKey(null); setSelectedStopKey(null);
    setSelectedImage(null); setSelectedUnassigned(null);
    setManualOverrides({}); setLeftTab("stops"); setDedupOff(new Set());
    setActiveProfile("all"); setSelectedMissionProfileId(null); setCustomImagesPerStop(5);
  };

  const assignStop = (stop: MissionStop, poleKey: string, assetId: string, distM?: number) => {
    // Apply as manual override to all images in the stop
    setManualOverrides(prev => {
      const next = { ...prev };
      for (const img of stop.images) next[img.cocoImage.file_name] = { poleKey, assetId, distM };
      return next;
    });
    setSelectedPoleKey(poleKey);
    setSelectedStopKey(null);
    setLeftTab("assets");
  };

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

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden", background: C.bg, color: C.text, fontFamily: SANS, fontSize: 14 }}>

      {/* ── HEADER ──────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "0 20px", height: 52, background: C.s1, borderBottom: `1px solid ${C.b1}`, flexShrink: 0, zIndex: 50 }}>
        <div style={{ width: 24, height: 24, background: C.accent, clipPath: "polygon(50% 0%,100% 25%,100% 75%,50% 100%,0% 75%,0% 25%)" }} />
        <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 600, letterSpacing: ".1em", textTransform: "uppercase" }}>
          Unleash<span style={{ color: C.accent }}>Live</span>
        </span>
        <span style={{ fontFamily: MONO, fontSize: 10, color: C.muted }}>/ Asset Media Browser</span>

        {/* Session pill */}
        {stats.sessionName && (
          <span style={{ fontFamily: MONO, fontSize: 10, background: "rgba(0,168,114,.1)", color: C.accent, border: `1px solid rgba(0,168,114,.3)`, borderRadius: 2, padding: "2px 9px" }}>
            {stats.sessionName}
          </span>
        )}

        <div style={{ flex: 1 }} />

        {/* Stats */}
        {coco && (
          <div style={{ display: "flex", gap: 14, fontFamily: MONO, fontSize: 10, color: C.dim }}>
            <span>Images <b style={{ color: C.text }}>{stats.images}</b></span>
            <span>Detections <b style={{ color: C.text }}>{stats.annotations}</b></span>
            <span>Stops <b style={{ color: C.text }}>{stats.stops}</b></span>
            {polesGeoJson && <span style={{ color: C.accent }}>Matched <b>{stats.stopsMatched}</b></span>}
            {polesGeoJson && unassignedStops.length > 0 && <span style={{ color: C.warn }}>Unmatched <b>{unassignedStops.length}</b></span>}
          </div>
        )}

        {/* Upload buttons */}
        <div style={{ display: "flex", gap: 6, marginLeft: 12 }}>
          <input ref={cocoRef} type="file" accept=".json" style={{ display: "none" }}
            onChange={e => { const f = e.target.files?.[0]; if (f) onLoadCoco(f); if (cocoRef.current) cocoRef.current.value = ""; }} />
          <button onClick={() => cocoRef.current?.click()} style={btnPrimary(C.accent)}>↑ COCO JSON</button>

          <input ref={geoRef} type="file" accept=".geojson,.json" style={{ display: "none" }}
            onChange={e => { const f = e.target.files?.[0]; if (f) onLoadGeo(f); if (geoRef.current) geoRef.current.value = ""; }} />
          <button onClick={() => geoRef.current?.click()} style={btnPrimary(C.info)}>↑ GeoJSON</button>

          {(coco || polesGeoJson) && <button onClick={clearAll} style={btnOutline}>✕ Clear</button>}
        </div>
      </div>

      {/* Error bar */}
      {(cocoError || geoError) && (
        <div style={{ background: "#fdf0f0", borderBottom: `1px solid ${C.danger}`, padding: "5px 20px", fontFamily: MONO, fontSize: 10, color: C.danger, flexShrink: 0 }}>
          {cocoError && <span>COCO: {cocoError}  </span>}
          {geoError && <span>GeoJSON: {geoError}</span>}
        </div>
      )}

      {/* ── MISSION PROFILE + INSPECT PROFILE BAR ────────────────────────── */}
      {coco && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "6px 20px", background: "#1a2332", flexShrink: 0, flexWrap: "wrap" }}>

          {/* Smart Inspect Mission Profile */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontFamily: MONO, fontSize: 9, color: "#7c8fa8", textTransform: "uppercase", letterSpacing: ".1em", whiteSpace: "nowrap" }}>Mission Profile</span>
            <select
              value={selectedMissionProfileId ?? (autoDetectedProfileId ? `__auto__${autoDetectedProfileId}` : "")}
              onChange={e => {
                const v = e.target.value;
                if (v === "") setSelectedMissionProfileId(null);
                else if (v.startsWith("__auto__")) setSelectedMissionProfileId(null);
                else setSelectedMissionProfileId(v);
              }}
              style={{ fontFamily: MONO, fontSize: 10, background: "#252d3a", border: `1px solid ${selectedMissionProfileId ? C.accent : "#3a4a5c"}`, borderRadius: 2, color: selectedMissionProfileId ? C.accent : "#c5cde8", padding: "4px 8px", outline: "none", maxWidth: 260, cursor: "pointer" }}>
              <option value="">— Select profile —</option>
              {autoDetectedProfileId && !selectedMissionProfileId && (
                <option value={`__auto__${autoDetectedProfileId}`} style={{ color: "#00a872" }}>
                  ✓ Auto: {MISSION_PROFILES.find(p => p.id === autoDetectedProfileId)?.label}
                </option>
              )}
              {MISSION_PROFILES.map(p => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>

            {/* Profile badge */}
            {effectiveMissionProfile && (
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ fontFamily: MONO, fontSize: 9, background: "rgba(0,168,114,.15)", border: "1px solid rgba(0,168,114,.3)", borderRadius: 2, padding: "2px 7px", color: C.accent, whiteSpace: "nowrap" }}>
                  {effectiveMissionProfile.imagesPerStop > 0 ? `${effectiveImagesPerStop} img/stop` : "custom"}
                </span>
                {effectiveMissionProfile.widthM > 0 && (
                  <span style={{ fontFamily: MONO, fontSize: 9, color: "#5a7090" }}>{effectiveMissionProfile.widthM}m radius</span>
                )}
                {autoDetectedProfileId && !selectedMissionProfileId && (
                  <span style={{ fontFamily: MONO, fontSize: 8, color: "#5a7090" }}>auto-detected</span>
                )}
              </div>
            )}

            {/* Custom images per stop input */}
            {effectiveMissionProfile?.id === "custom" && (
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ fontFamily: MONO, fontSize: 9, color: "#7c8fa8" }}>img/stop</span>
                <input type="number" min={1} max={20} value={customImagesPerStop}
                  onChange={e => setCustomImagesPerStop(Math.max(1, +e.target.value))}
                  style={{ width: 44, background: "#252d3a", border: `1px solid ${C.accent}`, borderRadius: 2, color: C.accent, fontFamily: MONO, fontSize: 10, padding: "3px 6px", outline: "none" }} />
              </div>
            )}
          </div>

          <div style={{ width: 1, height: 20, background: "#2a3a4a", flexShrink: 0 }} />

          {/* AI Inspect profile filter */}
          {allProfiles.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontFamily: MONO, fontSize: 9, color: "#7c8fa8", textTransform: "uppercase", letterSpacing: ".1em", whiteSpace: "nowrap" }}>AI Profile</span>
              <div style={{ display: "flex", gap: 3 }}>
                <button onClick={() => setActiveProfile("all")}
                  style={{ fontFamily: MONO, fontSize: 9, padding: "3px 9px", borderRadius: 2, border: `1px solid ${activeProfile === "all" ? C.accent : "#3a4a5c"}`, background: activeProfile === "all" ? "rgba(0,168,114,.15)" : "transparent", color: activeProfile === "all" ? C.accent : "#7c8fa8", cursor: "pointer" }}>
                  All
                </button>
                {allProfiles.map(id => (
                  <button key={id} onClick={() => setActiveProfile(id)}
                    style={{ fontFamily: MONO, fontSize: 9, padding: "3px 9px", borderRadius: 2, border: `1px solid ${activeProfile === id ? C.accent : "#3a4a5c"}`, background: activeProfile === id ? "rgba(0,168,114,.15)" : "transparent", color: activeProfile === id ? C.accent : "#7c8fa8", cursor: "pointer", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {id}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div style={{ flex: 1 }} />

          {/* Max join distance */}
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ fontFamily: MONO, fontSize: 9, color: "#3a4a5c", whiteSpace: "nowrap" }}>Max join</span>
            <input type="number" value={maxJoinM} onChange={e => setMaxJoinM(Math.max(0, +e.target.value))}
              style={{ width: 55, background: "#252d3a", border: "1px solid #3a4a5c", borderRadius: 2, color: "#c5cde8", fontFamily: MONO, fontSize: 10, padding: "3px 6px", outline: "none" }} />
            <span style={{ fontFamily: MONO, fontSize: 9, color: "#3a4a5c" }}>m</span>
          </div>
        </div>
      )}

      {/* ── BODY ─────────────────────────────────────────────────────────────── */}
      {!coco ? (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, color: C.muted }}>
          <div style={{ fontSize: 48, opacity: .3 }}>◈</div>
          <div style={{ fontFamily: MONO, fontSize: 12 }}>Upload a COCO JSON to begin</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => cocoRef.current?.click()} style={btnPrimary(C.accent)}>↑ Upload COCO JSON</button>
            <button onClick={() => geoRef.current?.click()} style={btnPrimary(C.info)}>↑ Upload GeoJSON</button>
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

          {/* ── LEFT PANE ──────────────────────────────────────────────────── */}
          <div style={{ width: 290, flexShrink: 0, background: C.s1, borderRight: `1px solid ${C.b1}`, display: "flex", flexDirection: "column", overflow: "hidden" }}>

            {/* Search */}
            <div style={{ padding: "8px 12px", borderBottom: `1px solid ${C.b1}`, flexShrink: 0 }}>
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search asset ID or class…"
                style={{ width: "100%", background: C.s2, border: `1px solid ${C.b1}`, borderRadius: 2, color: C.text, fontFamily: MONO, fontSize: 11, padding: "5px 8px", outline: "none" }} />
            </div>

            {/* Tabs */}
            <div style={{ display: "flex", borderBottom: `1px solid ${C.b1}`, flexShrink: 0 }}>
              {(["stops", "assets", "unassigned"] as const).map(tab => {
                const label = tab === "stops" ? `Mission Stops (${missionStops.length})`
                  : tab === "assets" ? `Assets (${filteredAssets.length})`
                  : `Unmatched (${unassignedStops.length})`;
                const active = leftTab === tab;
                return (
                  <button key={tab} onClick={() => setLeftTab(tab)}
                    style={{ flex: 1, fontFamily: MONO, fontSize: 9, padding: "7px 4px", background: active ? C.s1 : C.s2, border: "none", borderBottom: active ? `2px solid ${C.accent}` : `2px solid transparent`, color: active ? C.accent : C.dim, cursor: "pointer", fontWeight: active ? 600 : 400, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {label}
                  </button>
                );
              })}
            </div>

            {/* List content */}
            <div style={{ flex: 1, overflowY: "auto" }}>

              {/* ── MISSION STOPS TAB ──────────────────────────────────────── */}
              {leftTab === "stops" && joinedStops.map((stop, idx) => {
                const active = selectedStopKey === stop.key;
                const matched = !!stop.poleKey;
                const imgCount = stop.images.length;
                const compCount = Object.values(stop.inventoryCounts).reduce((s, v) => s + v, 0);
                const faultCount = Object.entries(stop.inventoryCounts).filter(([k]) => k.includes(".")).reduce((s, [, v]) => s + v, 0);
                return (
                  <button key={stop.key}
                    onClick={() => { setSelectedStopKey(stop.key); setSelectedPoleKey(null); setSelectedImage(null); setSelectedUnassigned(null); }}
                    style={{ display: "block", width: "100%", background: active ? "#f0f8f5" : "transparent", border: "none", borderBottom: `1px solid ${C.b1}`, borderLeft: `3px solid ${matched ? C.accent : C.warn}`, padding: "8px 12px", cursor: "pointer", textAlign: "left", color: C.text, transition: "background .1s" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
                      <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 600 }}>
                        Stop {idx + 1}
                        {stop.poleKey && <span style={{ fontWeight: 400, color: C.dim }}> · {stop.assetId}</span>}
                      </span>
                      <span style={{ fontFamily: MONO, fontSize: 9, color: matched ? C.accent : C.warn, background: matched ? "rgba(0,168,114,.1)" : "rgba(212,130,10,.1)", padding: "2px 6px", borderRadius: 2 }}>
                        {matched ? fmtM(stop.joinDistM) : "unmatched"}
                      </span>
                    </div>
                    <div style={{ display: "flex", gap: 10, fontFamily: MONO, fontSize: 9, color: C.dim }}>
                      <span>{imgCount} img</span>
                      <span style={{ color: C.accent }}>{compCount} comp</span>
                      {faultCount > 0 && <span style={{ color: C.warn }}>{faultCount} fault</span>}
                    </div>
                    {stop.aiAppIds.length > 0 && (
                      <div style={{ marginTop: 3, fontFamily: MONO, fontSize: 8, color: C.info, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {stop.aiAppIds.join(", ")}
                      </div>
                    )}
                  </button>
                );
              })}

              {/* ── ASSETS TAB ─────────────────────────────────────────────── */}
              {leftTab === "assets" && filteredAssets.map(a => {
                const invTotal = Object.values(a.inventoryCounts).reduce((s, v) => s + v, 0);
                const faultTotal = Object.entries(a.inventoryCounts).filter(([k]) => k.includes(".")).reduce((s, [, v]) => s + v, 0);
                const active = selectedPoleKey === a.poleKey;
                return (
                  <button key={a.poleKey}
                    onClick={() => { setSelectedPoleKey(a.poleKey); setSelectedStopKey(null); setSelectedImage(null); setSelectedUnassigned(null); }}
                    style={{ display: "block", width: "100%", background: active ? "#f0f8f5" : "transparent", border: "none", borderBottom: `1px solid ${C.b1}`, borderLeft: `3px solid ${a.images.length > 0 ? C.accent : "transparent"}`, padding: "8px 12px", cursor: "pointer", textAlign: "left", color: C.text, transition: "background .1s" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
                      <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 175 }}>{a.assetId}</span>
                      <span style={{ fontFamily: MONO, fontSize: 9, padding: "2px 6px", borderRadius: 2, background: a.images.length ? "rgba(0,168,114,.1)" : C.s2, color: a.images.length ? C.accent : C.muted }}>
                        {a.images.length ? `${a.images.length} img` : "—"}
                      </span>
                    </div>
                    <div style={{ display: "flex", gap: 10, fontFamily: MONO, fontSize: 9, color: C.dim }}>
                      <span>Components <b style={{ color: C.text }}>{invTotal}</b></span>
                      <span>Faults <b style={{ color: faultTotal > 0 ? C.warn : C.text }}>{faultTotal}</b></span>
                    </div>
                  </button>
                );
              })}

              {/* ── UNMATCHED TAB ──────────────────────────────────────────── */}
              {leftTab === "unassigned" && unassignedStops.map((stop, idx) => (
                <button key={stop.key}
                  onClick={() => { setSelectedStopKey(stop.key); setSelectedPoleKey(null); setSelectedImage(null); setSelectedUnassigned(null); setLeftTab("stops"); }}
                  style={{ display: "block", width: "100%", background: selectedStopKey === stop.key ? "#fffaf0" : "transparent", border: "none", borderBottom: `1px solid ${C.b1}`, borderLeft: `3px solid ${C.warn}`, padding: "8px 12px", cursor: "pointer", textAlign: "left", color: C.text }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                    <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 600, color: C.warn }}>Stop {idx + 1}</span>
                    <span style={{ fontFamily: MONO, fontSize: 9, color: C.dim }}>{stop.images.length} images</span>
                  </div>
                  <div style={{ fontFamily: MONO, fontSize: 9, color: C.dim }}>{stop.lat.toFixed(5)}, {stop.lon.toFixed(5)}</div>
                </button>
              ))}

            </div>
          </div>

          {/* ── MAP ─────────────────────────────────────────────────────────── */}
          <div style={{ flex: 1, position: "relative" }}>
            <MapContainer center={fitPoints[0] ?? [-33.86, 151.21]} zoom={fitPoints.length > 1 ? 16 : 17}
              style={{ height: "100%", width: "100%" }} scrollWheelZoom>
              <TileLayer url={DEFAULT_TILE} />

              {fitPoints.length > 0 && <FitBounds points={fitPoints} />}

              {/* Pole markers from GeoJSON */}
              {markerGeoJson && (
                <GeoJSON data={markerGeoJson} pointToLayer={(feature, latlng) => {
                  const m = L.circleMarker(latlng, { radius: 5, weight: 1, opacity: .9, fillOpacity: .6, fillColor: "#1a6fd4", color: "#1a6fd4" } as any);
                  m.on("click", () => {
                    const pk = feature?.properties?._pk as string;
                    if (pk) { setSelectedPoleKey(pk); setSelectedStopKey(null); setLeftTab("assets"); }
                  });
                  return m;
                }} />
              )}

              {/* All mission stop markers */}
              <LayerGroup>
                {joinedStops.map((stop, idx) => {
                  const active = selectedStopKey === stop.key;
                  const matched = !!stop.poleKey;
                  return (
                    <CircleMarker key={stop.key}
                      center={[stop.lat, stop.lon]}
                      radius={active ? 12 : 9}
                      pathOptions={{ color: matched ? C.accent : C.warn, fillColor: matched ? C.accent : C.warn, fillOpacity: active ? .9 : .6, weight: active ? 2 : 1 }}
                      eventHandlers={{ click: () => { setSelectedStopKey(stop.key); setSelectedPoleKey(null); setLeftTab("stops"); } }}>
                      <Popup>
                        <div style={{ fontFamily: MONO, fontSize: 10 }}>
                          <b>Stop {idx + 1}</b> · {stop.images.length} images<br />
                          {matched ? <span style={{ color: C.accent }}>{stop.assetId} · {fmtM(stop.joinDistM)}</span> : <span style={{ color: C.warn }}>Unmatched</span>}<br />
                          {stop.aiAppIds.map(id => <span key={id} style={{ color: C.info, fontSize: 9 }}>{id}</span>)}
                        </div>
                      </Popup>
                    </CircleMarker>
                  );
                })}
              </LayerGroup>

              {/* Individual image dots for selected stop */}
              {selectedStop && selectedStop.images.filter(r => r.lat && r.lon).map(r => (
                <CircleMarker key={r.cocoImage.id} center={[r.lat!, r.lon!]} radius={4}
                  pathOptions={{ color: "#d4002e", fillColor: "#d4002e", fillOpacity: .8, weight: 1 }}
                  eventHandlers={{ click: () => setSelectedImage(r) }}>
                  <Popup><div style={{ fontFamily: MONO, fontSize: 10 }}>{r.cocoImage.file_name}<br />{r.annotations.length} det</div></Popup>
                </CircleMarker>
              ))}

              {/* Selected asset: pole + image dots */}
              {selectedAsset && (
                <>
                  <MapFlyTo lat={selectedAsset.poleLat} lon={selectedAsset.poleLon} zoom={18} />
                  <Marker position={[selectedAsset.poleLat, selectedAsset.poleLon]}>
                    <Popup><div style={{ fontFamily: MONO, fontSize: 11 }}>
                      <b>{selectedAsset.assetId}</b><br />
                      {selectedAsset.stops.length} stops · {selectedAsset.images.length} images
                    </div></Popup>
                  </Marker>
                  {selectedAsset.images.filter(r => r.lat && r.lon).map(r => (
                    <CircleMarker key={r.cocoImage.id} center={[r.lat!, r.lon!]} radius={5}
                      pathOptions={{ color: "#d4002e", fillColor: "#d4002e", fillOpacity: .75, weight: 1 }}
                      eventHandlers={{ click: () => setSelectedImage(r) }}>
                      <Popup><div style={{ fontFamily: MONO, fontSize: 10 }}>{r.cocoImage.file_name}<br />{r.annotations.length} det</div></Popup>
                    </CircleMarker>
                  ))}
                </>
              )}

              {/* Candidate pole lines for unmatched stop */}
              {selectedStop && !selectedStop.poleKey && candidatePoles.map((p, i) => (
                <React.Fragment key={p.poleKey}>
                  <CircleMarker center={[p.lat, p.lon]} radius={7}
                    pathOptions={{ color: i === 0 ? C.info : "#888", fillColor: i === 0 ? C.info : "#888", fillOpacity: .75, weight: 2 }}>
                    <Popup><div style={{ fontFamily: MONO, fontSize: 10 }}><b>{p.assetId}</b><br />{fmtM(p.distM)}</div></Popup>
                  </CircleMarker>
                  <Polyline positions={[[selectedStop.lat, selectedStop.lon], [p.lat, p.lon]]}
                    pathOptions={{ color: i === 0 ? C.info : "#bbb", weight: i === 0 ? 2 : 1, opacity: .7 }} />
                </React.Fragment>
              ))}

            </MapContainer>
          </div>

          {/* ── RIGHT PANE ──────────────────────────────────────────────────── */}
          <div style={{ width: 340, flexShrink: 0, background: C.s1, borderLeft: `1px solid ${C.b1}`, overflow: "hidden", display: "flex", flexDirection: "column" }}>

            {/* ── STOP DETAIL ─────────────────────────────────────────────── */}
            {selectedStop ? (
              <div style={{ flex: 1, overflowY: "auto" }}>
                <div style={{ padding: "12px 14px", borderBottom: `1px solid ${C.b1}`, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div>
                    <div style={monoLabel()}>Mission Stop</div>
                    <div style={{ fontFamily: MONO, fontSize: 14, fontWeight: 700, marginTop: 2 }}>
                      {joinedStops.indexOf(selectedStop) + 1}
                      {selectedStop.poleKey && <span style={{ fontWeight: 400, fontSize: 11, color: C.dim }}> · {selectedStop.assetId}</span>}
                    </div>
                  </div>
                  <button onClick={() => setSelectedStopKey(null)} style={btnOutline}>✕</button>
                </div>

                {/* Stop summary */}
                {(() => {
                  const invTotal = Object.values(selectedStop.inventoryCounts).reduce((s, v) => s + v, 0);
                  const faultTotal = Object.entries(selectedStop.inventoryCounts).filter(([k]) => k.includes(".")).reduce((s, [, v]) => s + v, 0);
                  const rawTotal = Object.values(selectedStop.detectionTotals).reduce((s, v) => s + v, 0);
                  return (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, padding: "10px 12px", borderBottom: `1px solid ${C.b1}` }}>
                      {[
                        ["Images", `${selectedStop.canonicalImageCount}${selectedStop.images.length > selectedStop.canonicalImageCount ? ` of ${selectedStop.images.length}` : ""}`],
                        ["Components", invTotal],
                        ["Faults", faultTotal],
                      ].map(([l, v]) => (
                        <div key={String(l)} style={{ background: C.s2, borderRadius: 3, padding: "6px 8px" }}>
                          <div style={{ ...monoLabel(8), marginBottom: 2 }}>{l}</div>
                          <div style={{ fontFamily: MONO, fontSize: 15, fontWeight: 700, color: l === "Faults" && Number(v) > 0 ? C.warn : C.text }}>{v}</div>
                        </div>
                      ))}
                    </div>
                  );
                })()}

                {/* Profile vs actual image count */}
                {effectiveMissionProfile && (
                  <div style={{ padding: "8px 14px", borderBottom: `1px solid ${C.b1}`, background: (() => {
                    const expected = effectiveImagesPerStop ?? 0;
                    const actual = selectedStop.images.length;
                    if (actual === expected) return "rgba(0,168,114,.05)";
                    if (actual > expected) return "rgba(212,130,10,.05)";
                    return "rgba(212,0,46,.05)";
                  })() }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontFamily: MONO, fontSize: 9, color: C.dim }}>
                        Profile: <b style={{ color: C.text }}>{effectiveMissionProfile.label}</b>
                      </span>
                      {(() => {
                        const expected = effectiveImagesPerStop ?? 0;
                        const actual = selectedStop.images.length;
                        if (actual === expected) return <span style={{ fontFamily: MONO, fontSize: 9, color: C.accent }}>✓ {actual}/{expected} images</span>;
                        if (actual > expected) return <span style={{ fontFamily: MONO, fontSize: 9, color: C.warn }}>⚠ {actual} images ({actual - expected} extra — dedup applied)</span>;
                        return <span style={{ fontFamily: MONO, fontSize: 9, color: C.danger }}>✕ {actual}/{expected} images (incomplete capture)</span>;
                      })()}
                    </div>
                  </div>
                )}

                {/* ── COMPONENT INVENTORY TABLE ───────────────────────── */}
                <div style={{ padding: "10px 14px", borderBottom: `1px solid ${C.b1}` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <span style={monoLabel()}>Asset Profile — Deduped Inventory</span>
                    <span style={{ fontFamily: MONO, fontSize: 9, color: C.muted }}>
                      max/img × {selectedStop.canonicalImageCount} imgs
                    </span>
                  </div>
                  {Object.keys(selectedStop.inventoryCounts).length === 0 ? (
                    <div style={{ fontFamily: MONO, fontSize: 10, color: C.muted }}>No detections</div>
                  ) : (
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <thead>
                        <tr style={{ borderBottom: `1px solid ${C.b1}` }}>
                          <th style={{ ...monoLabel(8), textAlign: "left", padding: "3px 0", fontWeight: 500 }}>Component</th>
                          <th style={{ ...monoLabel(8), textAlign: "right", padding: "3px 0", fontWeight: 500, width: 32 }}>Qty</th>
                          <th style={{ ...monoLabel(8), textAlign: "right", padding: "3px 0", fontWeight: 500, width: 48 }}>Raw</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(selectedStop.inventoryCounts)
                          .sort((a, b) => {
                            // Faults last, then sort by count desc
                            const aF = a[0].includes("."), bF = b[0].includes(".");
                            if (aF !== bF) return aF ? 1 : -1;
                            return b[1] - a[1];
                          })
                          .map(([cat, cnt]) => {
                            const isFault = cat.includes(".");
                            const raw = selectedStop.detectionTotals[cat] ?? cnt;
                            return (
                              <tr key={cat} style={{ borderBottom: `1px solid ${C.s2}` }}>
                                <td style={{ padding: "4px 0", fontFamily: MONO, fontSize: 10, color: isFault ? C.warn : C.text }}>
                                  {isFault
                                    ? <><span style={{ color: C.dim }}>{cat.split(".")[0]}</span><span style={{ color: C.warn }}>{"." + cat.split(".").slice(1).join(".")}</span></>
                                    : cat}
                                </td>
                                <td style={{ padding: "4px 0", textAlign: "right", fontFamily: MONO, fontSize: 12, fontWeight: 700, color: isFault ? C.warn : C.accent, width: 32 }}>{cnt}</td>
                                <td style={{ padding: "4px 0", textAlign: "right", fontFamily: MONO, fontSize: 9, color: C.muted, width: 48 }}>
                                  {raw > cnt ? <span title="Raw total across all images">{raw}</span> : <span style={{ opacity: .3 }}>—</span>}
                                </td>
                              </tr>
                            );
                          })}
                      </tbody>
                    </table>
                  )}
                </div>

                {/* AI Inspect Profiles */}
                {selectedStop.aiAppIds.length > 0 && (
                  <div style={{ padding: "8px 14px", borderBottom: `1px solid ${C.b1}` }}>
                    <div style={{ ...monoLabel(), marginBottom: 5 }}>Inspect Profiles</div>
                    {selectedStop.aiAppIds.map(id => (
                      <div key={id} style={{ fontFamily: MONO, fontSize: 9, color: C.info, background: "rgba(26,111,212,.07)", border: `1px solid rgba(26,111,212,.2)`, borderRadius: 2, padding: "3px 8px", marginBottom: 3, wordBreak: "break-all" }}>{id}</div>
                    ))}
                  </div>
                )}

                {/* Assign panel for unmatched stops */}
                {!selectedStop.poleKey && (
                  <div style={{ padding: "10px 14px", borderBottom: `1px solid ${C.b1}`, background: "rgba(212,130,10,.04)" }}>
                    <div style={{ ...monoLabel(), color: C.warn, marginBottom: 8 }}>⚠ Assign to Pole</div>
                    {candidatePoles.length ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                        {candidatePoles.map((p, i) => (
                          <button key={p.poleKey} onClick={() => assignStop(selectedStop, p.poleKey, p.assetId, p.distM)}
                            style={{ padding: "7px 10px", background: i === 0 ? "rgba(26,111,212,.07)" : C.s2, border: `1px solid ${i === 0 ? C.info : C.b2}`, borderRadius: 3, cursor: "pointer", textAlign: "left", fontFamily: MONO, fontSize: 10, color: i === 0 ? C.info : C.text }}>
                            <b>{p.assetId}</b> <span style={{ color: C.dim }}>· {fmtM(p.distM)}</span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div style={{ fontFamily: MONO, fontSize: 10, color: C.muted }}>No poles found — upload GeoJSON or increase max join distance</div>
                    )}
                  </div>
                )}

                {/* Image thumbnails in this stop */}
                <div style={{ padding: "10px 14px" }}>
                  <div style={{ ...monoLabel(), marginBottom: 8 }}>Images in this stop</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                    {selectedStop.images.map(img => {
                      const topCat = img.annotations[0] ? catMap.get(img.annotations[0].category_id) : undefined;
                      return (
                        <button key={img.cocoImage.id} onClick={() => setSelectedImage(img)}
                          style={{ background: C.s2, border: `1px solid ${C.b1}`, borderRadius: 3, overflow: "hidden", cursor: "pointer", padding: 0, textAlign: "left" }}>
                          <div style={{ width: "100%", aspectRatio: "16/9", background: C.b1, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
                            {img.imageUrl ? <img src={img.imageUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} loading="lazy" onError={e => { e.currentTarget.style.display = "none"; }} />
                              : <span style={{ fontFamily: MONO, fontSize: 9, color: C.muted }}>No URL</span>}
                          </div>
                          <div style={{ padding: "4px 6px" }}>
                            <div style={{ fontFamily: MONO, fontSize: 9, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: C.text }}>{topCat ?? "—"}</div>
                            <div style={{ fontFamily: MONO, fontSize: 8, color: C.dim }}>{img.annotations.length} det</div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

            ) : !selectedAsset ? (
              <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: C.muted, gap: 8 }}>
                <div style={{ fontSize: 32, opacity: .3 }}>◧</div>
                <div style={{ fontFamily: MONO, fontSize: 11 }}>
                  {!coco ? "Upload a COCO JSON" : "Select a mission stop or asset"}
                </div>
              </div>

            ) : (
              /* ── ASSET DETAIL ───────────────────────────────────────────── */
              <div style={{ flex: 1, overflowY: "auto" }}>
                <div style={{ padding: "12px 14px", borderBottom: `1px solid ${C.b1}`, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div>
                    <div style={monoLabel()}>Asset ID</div>
                    <div style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, wordBreak: "break-all", marginTop: 2 }}>{selectedAsset.assetId}</div>
                  </div>
                  <button onClick={() => { setSelectedPoleKey(null); setSelectedImage(null); }} style={btnOutline}>✕</button>
                </div>

                {/* Summary */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, padding: "10px 12px", borderBottom: `1px solid ${C.b1}` }}>
                  {[["Stops", selectedAsset.stops.length], ["Images", selectedAsset.images.length],
                    ["Faults", Object.entries(selectedAsset.inventoryCounts).filter(([k]) => k.includes(".")).reduce((s, [, v]) => s + v, 0)]
                  ].map(([l, v]) => (
                    <div key={String(l)} style={{ background: C.s2, borderRadius: 3, padding: "6px 8px" }}>
                      <div style={{ ...monoLabel(8), marginBottom: 2 }}>{l}</div>
                      <div style={{ fontFamily: MONO, fontSize: 15, fontWeight: 700, color: l === "Faults" && Number(v) > 0 ? C.warn : C.text }}>{v}</div>
                    </div>
                  ))}
                </div>

                {/* Detection inventory + dedup toggle */}
                <div style={{ padding: "10px 14px", borderBottom: `1px solid ${C.b1}` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <span style={monoLabel()}>Detection Inventory</span>
                    <button onClick={() => setDedupOff(prev => { const n = new Set(prev); n.has(selectedAsset.poleKey) ? n.delete(selectedAsset.poleKey) : n.add(selectedAsset.poleKey); return n; })}
                      style={{ fontFamily: MONO, fontSize: 8, padding: "2px 8px", borderRadius: 2, cursor: "pointer", border: `1px solid ${dedupOff.has(selectedAsset.poleKey) ? C.warn : C.accent}`, background: dedupOff.has(selectedAsset.poleKey) ? "rgba(212,130,10,.08)" : "rgba(0,168,114,.08)", color: dedupOff.has(selectedAsset.poleKey) ? C.warn : C.accent }}>
                      {dedupOff.has(selectedAsset.poleKey) ? "⚠ Raw totals" : "✓ Deduped"}
                    </button>
                  </div>
                  <div style={{ fontFamily: MONO, fontSize: 9, color: C.muted, marginBottom: 8 }}>
                    {dedupOff.has(selectedAsset.poleKey) ? "Raw sum across all images — may contain duplicates" : "Max count per image per class — cross-image duplicates removed"}
                  </div>
                  {(() => {
                    const counts = dedupOff.has(selectedAsset.poleKey) ? selectedAsset.detectionTotals : selectedAsset.inventoryCounts;
                    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
                    if (!entries.length) return <div style={{ fontFamily: MONO, fontSize: 10, color: C.muted }}>No detections</div>;
                    return (
                      <table style={{ width: "100%", borderCollapse: "collapse" }}>
                        <tbody>
                          {entries.map(([cat, cnt]) => {
                            const isFault = cat.includes(".");
                            const raw = selectedAsset.detectionTotals[cat];
                            return (
                              <tr key={cat} style={{ borderBottom: `1px solid ${C.s2}` }}>
                                <td style={{ padding: "4px 0", fontFamily: MONO, fontSize: 10, color: isFault ? C.warn : C.text }}>
                                  {isFault ? <><span style={{ color: C.dim }}>{cat.split(".")[0]}</span>.<span>{cat.split(".").slice(1).join(".")}</span></> : cat}
                                </td>
                                <td style={{ padding: "4px 0", textAlign: "right", fontFamily: MONO, fontSize: 11, fontWeight: 700, color: isFault ? C.warn : C.accent, width: 28 }}>{cnt}</td>
                                {!dedupOff.has(selectedAsset.poleKey) && raw > cnt && (
                                  <td style={{ padding: "4px 0 4px 5px", fontFamily: MONO, fontSize: 8, color: C.muted }}>{raw} raw</td>
                                )}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    );
                  })()}
                </div>

                {/* Stops on this asset */}
                <div style={{ padding: "10px 14px", borderBottom: `1px solid ${C.b1}` }}>
                  <div style={{ ...monoLabel(), marginBottom: 6 }}>Mission Stops</div>
                  {selectedAsset.stops.map((stop, idx) => (
                    <button key={stop.key} onClick={() => { setSelectedStopKey(stop.key); }}
                      style={{ display: "block", width: "100%", background: selectedStopKey === stop.key ? "#f0f8f5" : C.s2, border: `1px solid ${C.b1}`, borderRadius: 3, padding: "6px 10px", cursor: "pointer", textAlign: "left", marginBottom: 4 }}>
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 600 }}>Stop {idx + 1}</span>
                        <span style={{ fontFamily: MONO, fontSize: 9, color: C.dim }}>{stop.images.length} img · {fmtM(stop.joinDistM)}</span>
                      </div>
                      <div style={{ fontFamily: MONO, fontSize: 8, color: C.info, marginTop: 2 }}>{stop.aiAppIds.join(", ")}</div>
                    </button>
                  ))}
                </div>

                {/* Image grid */}
                <div style={{ padding: "10px 14px" }}>
                  <div style={{ ...monoLabel(), marginBottom: 8 }}>All Images</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                    {selectedAsset.images.map(img => {
                      const topCat = img.annotations[0] ? catMap.get(img.annotations[0].category_id) : undefined;
                      return (
                        <button key={img.cocoImage.id} onClick={() => setSelectedImage(img)}
                          style={{ background: C.s2, border: `1px solid ${C.b1}`, borderRadius: 3, overflow: "hidden", cursor: "pointer", padding: 0, textAlign: "left" }}>
                          <div style={{ width: "100%", aspectRatio: "16/9", background: C.b1, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
                            {img.imageUrl ? <img src={img.imageUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} loading="lazy" onError={e => { e.currentTarget.style.display = "none"; }} />
                              : <span style={{ fontFamily: MONO, fontSize: 9, color: C.muted }}>No URL</span>}
                          </div>
                          <div style={{ padding: "4px 6px" }}>
                            <div style={{ fontFamily: MONO, fontSize: 9, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{topCat ?? "—"}</div>
                            <div style={{ fontFamily: MONO, fontSize: 8, color: C.dim }}>{img.annotations.length} det · {fmtM(img.joinDistM)}</div>
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

      {/* ── IMAGE MODAL ──────────────────────────────────────────────────────── */}
      {selectedImage && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.75)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => setSelectedImage(null)}>
          <div style={{ background: C.s1, borderRadius: 6, width: "90vw", maxWidth: 920, maxHeight: "90vh", overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: "0 8px 40px rgba(0,0,0,.4)" }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", borderBottom: `1px solid ${C.b1}` }}>
              <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 700 }}>{selectedImage.cocoImage.file_name}</span>
              <button onClick={() => setSelectedImage(null)} style={btnOutline}>✕ Close</button>
            </div>
            <div style={{ display: "flex", flex: 1, overflow: "hidden", minHeight: 0 }}>
              <div style={{ flex: 1, background: "#1a2332", display: "flex", alignItems: "center", justifyContent: "center", minWidth: 0 }}>
                {selectedImage.imageUrl
                  ? <img src={selectedImage.imageUrl} alt="" style={{ maxWidth: "100%", maxHeight: "72vh", objectFit: "contain" }} />
                  : <div style={{ fontFamily: MONO, fontSize: 11, color: C.muted }}>No image URL</div>}
              </div>
              <div style={{ width: 260, flexShrink: 0, overflowY: "auto", padding: 14, borderLeft: `1px solid ${C.b1}` }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 12 }}>
                  {[["Join", fmtM(selectedImage.joinDistM)], ["Method", selectedImage.joinMethod], ["Det", String(selectedImage.annotations.length)]].map(([k, v]) => (
                    <div key={k} style={{ background: C.s2, border: `1px solid ${C.b1}`, borderRadius: 2, padding: "2px 7px", fontFamily: MONO, fontSize: 9, color: C.dim }}>
                      {k}: <b style={{ color: C.text }}>{v}</b>
                    </div>
                  ))}
                </div>
                <div style={{ ...monoLabel(), marginBottom: 8 }}>Detections</div>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <tbody>
                    {selectedImage.annotations.map(ann => {
                      const cat = catMap.get(ann.category_id) ?? `cat_${ann.category_id}`;
                      return (
                        <tr key={ann.id} style={{ borderBottom: `1px solid ${C.s2}` }}>
                          <td style={{ padding: "3px 0", fontFamily: MONO, fontSize: 10, color: cat.includes(".") ? C.warn : C.text }}>{cat}</td>
                          {ann.score != null && <td style={{ padding: "3px 0", textAlign: "right", fontFamily: MONO, fontSize: 9, color: C.muted }}>{Math.round(ann.score * 100)}%</td>}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {selectedImage.imageUrl && (
                  <a href={selectedImage.imageUrl} target="_blank" rel="noreferrer"
                    style={{ display: "block", marginTop: 12, fontFamily: MONO, fontSize: 9, color: C.info, textDecoration: "none" }}>↗ Open full image</a>
                )}
                {selectedImage.lat && (
                  <a href={`https://www.google.com/maps?q=${selectedImage.lat},${selectedImage.lon}`} target="_blank" rel="noreferrer"
                    style={{ display: "block", marginTop: 6, fontFamily: MONO, fontSize: 9, color: C.info, textDecoration: "none" }}>↗ Google Maps</a>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
