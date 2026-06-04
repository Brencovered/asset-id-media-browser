import React, { useMemo, useRef, useState } from "react";
import {
  MapContainer,
  TileLayer,
  GeoJSON,
  Marker,
  Popup,
  useMap,
  CircleMarker,
  Polyline,
} from "react-leaflet";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./App.css";

type DetectionsRow = {
  filename?: string;
  latitude?: number | string;
  longitude?: number | string;
  "capture-time"?: string;
  "annotation-type"?: string;
  "download-url"?: string;
  "view-url"?: string;
  device?: string;
  "image-type"?: string;
  tag?: string;
};

type FlightPhotoEvent = {
  name: string;
  key: string;
  lat: number;
  lon: number;
  time?: number;
  missionKey: string;
};

type WaypointEvent = {
  lat: number;
  lon: number;
  time?: number;
  missionKey: string;
  label?: string;
};

type ImageAgg = {
  filename: string;
  fileKey: string;
  url?: string;
  captureTime?: string;

  lat?: number;
  lon?: number;
  locationSource: "waypoint_anchor" | "flight_log" | "csv_centroid" | "none";

  poleKey?: string;
  assetId?: string;
  joinDistanceM?: number;

  joinMethod?: "waypoint_segment" | "photo_nearest" | "manual_override" | "none";
  joinConfidence?: "high" | "medium" | "low" | "n/a";
  joinReason?:
    | "no_location"
    | "no_poles"
    | "outside_radius"
    | "ambiguous_cluster"
    | "manual"
    | "none";
  joinRadiusUsedM?: number;
  secondBestDistanceM?: number;

  missionKey?: string;
  waypointIndex?: number;

  rows: DetectionsRow[];
  perImageComponentCounts: Record<string, number>;
  perImageFaultCounts: Record<string, number>;
};

type AssetAgg = {
  poleKey: string;
  assetId: string;
  poleLat: number;
  poleLon: number;

  images: ImageAgg[];

  componentInventoryCounts: Record<string, number>;
  faultInventoryCounts: Record<string, number>;

  componentDetectionTotals: Record<string, number>;
  faultDetectionTotals: Record<string, number>;

  avgJoinDistanceM?: number;
};

type PoleIndexRow = {
  poleKey: string;
  lat: number;
  lon: number;
  assetId: string;

  x: number;
  y: number;
  nearestPoleDistanceM?: number;
};

type ManualOverride = {
  fileKey: string;
  filename: string;
  poleKey: string;
  assetId: string;
  distanceM?: number;
  assignedAt: number;
};

const DEFAULT_TILE = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";

const DefaultIcon = L.icon({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
});
L.Marker.prototype.options.icon = DefaultIcon;

function safeNum(x: unknown): number | undefined {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string") {
    const n = Number(x);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function toRad(d: number) {
  return (d * Math.PI) / 180;
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function splitAnnotation(annotationType?: string): { component?: string; fault?: string } {
  const a = (annotationType ?? "").trim();
  if (!a) return {};
  const idx = a.indexOf(".");
  if (idx === -1) return { component: a };
  const component = a.slice(0, idx).trim();
  const fault = a.slice(idx + 1).trim();
  return { component: component || undefined, fault: fault || undefined };
}

function getAssetIdFromFeature(f: Feature<Geometry, any>): string {
  const p = (f.properties ?? {}) as any;

  const plant =
    (typeof p.Plant_ID === "string" && p.Plant_ID.trim()) ||
    (typeof p.PLANT_ID === "string" && p.PLANT_ID.trim());
  if (plant) return plant;

  const name = typeof p.name === "string" ? p.name.trim() : "";
  if (name) return name;

  const label =
    (typeof p.Label === "string" && p.Label.trim()) ||
    (typeof p.LABEL === "string" && p.LABEL.trim());
  if (label) return label;

  const alt =
    (typeof p.assetId === "string" && p.assetId.trim()) ||
    (typeof p.asset_id === "string" && p.asset_id.trim()) ||
    (typeof p.AssetID === "string" && p.AssetID.trim()) ||
    (typeof p.id === "string" && p.id.trim());
  return alt || "Unknown asset";
}

function getPoleLatLon(f: Feature<Geometry, any>): { lat?: number; lon?: number } {
  const p = (f.properties ?? {}) as any;

  const plat = safeNum(p.Latitude ?? p.latitude);
  const plon = safeNum(p.Longitude ?? p.longitude);
  if (plat != null && plon != null) return { lat: plat, lon: plon };

  if (f.geometry?.type === "Point") {
    const coords = f.geometry.coordinates as any;
    if (Array.isArray(coords) && coords.length >= 2) {
      const lon = safeNum(coords[0]);
      const lat = safeNum(coords[1]);
      return { lat, lon };
    }
  }
  return {};
}

function formatCountMap(map: Record<string, number>) {
  return Object.entries(map).sort((a, b) => b[1] - a[1]);
}

function parseCSV(text: string): DetectionsRow[] {
  const rows: string[][] = [];
  let cur = "";
  let inQuotes = false;
  const line: string[] = [];

  const pushCell = () => { line.push(cur); cur = ""; };
  const pushLine = () => { rows.push([...line]); line.length = 0; };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '"' && inQuotes && next === '"') { cur += '"'; i++; continue; }
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === "," && !inQuotes) { pushCell(); continue; }
    if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && next === "\n") i++;
      pushCell();
      if (line.some((c) => (c ?? "").trim() !== "")) pushLine();
      continue;
    }
    cur += ch;
  }
  pushCell();
  if (line.some((c) => (c ?? "").trim() !== "")) pushLine();

  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim());
  const out: DetectionsRow[] = [];

  for (let r = 1; r < rows.length; r++) {
    const obj: any = {};
    for (let c = 0; c < header.length; c++) obj[header[c]] = rows[r][c];
    obj.latitude = safeNum(obj.latitude);
    obj.longitude = safeNum(obj.longitude);
    out.push(obj as DetectionsRow);
  }
  return out;
}

function normaliseName(raw: string): string {
  let s = (raw ?? "").toString().trim();
  if (!s) return "";
  const q = s.indexOf("?");
  if (q >= 0) s = s.slice(0, q);
  s = s.replaceAll("\\", "/");
  const parts = s.split("/");
  s = parts[parts.length - 1] ?? s;
  return s.trim().toLowerCase();
}

function parseTimeToMs(t?: number): number | undefined {
  if (t == null || !Number.isFinite(t)) return undefined;
  if (t < 2_000_000_000) return Math.round(t * 1000);
  return Math.round(t);
}

function parseFlightRecordPhotos(jsonObj: any, missionKey: string): FlightPhotoEvent[] {
  const out: FlightPhotoEvent[] = [];
  const stack: any[] = [jsonObj];

  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (Array.isArray(node)) { for (const x of node) stack.push(x); continue; }
    if (typeof node === "object") {
      const action = (node as any).action;
      const loc = (node as any).loc;
      if (
        action && typeof action === "object" && action.type === "PHOTO_TAKEN" &&
        typeof action.name === "string" && loc && typeof loc === "object"
      ) {
        const lat = safeNum(loc.lat);
        const lon = safeNum(loc.lng);
        if (lat != null && lon != null) {
          const name = action.name.trim();
          out.push({ name, key: normaliseName(name), lat, lon, time: parseTimeToMs(safeNum((node as any).time)), missionKey });
        }
      }
      for (const k of Object.keys(node)) stack.push((node as any)[k]);
    }
  }

  out.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
  return out;
}

function parseWaypoints(jsonObj: any, missionKey: string): WaypointEvent[] {
  const out: WaypointEvent[] = [];
  const stack: any[] = [jsonObj];

  const looksLikeWaypointType = (t: unknown) => {
    const s = (typeof t === "string" ? t : "").toLowerCase();
    if (!s) return false;
    return s.includes("waypoint") || s.includes("wp_") || s.includes("wp") ||
      s.includes("point_reached") || s.includes("point") || s.includes("reached");
  };

  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (Array.isArray(node)) { for (const x of node) stack.push(x); continue; }
    if (typeof node === "object") {
      const action = (node as any).action;
      const isWp = looksLikeWaypointType(action?.type) || looksLikeWaypointType((node as any).type) || looksLikeWaypointType((node as any).eventType);
      if (isWp) {
        const loc = (node as any).loc ?? (node as any).location ?? action?.loc ?? action?.location;
        const lat = safeNum(loc?.lat ?? loc?.latitude ?? (node as any).lat ?? (node as any).latitude);
        const lon = safeNum(loc?.lng ?? loc?.lon ?? loc?.longitude ?? (node as any).lng ?? (node as any).lon ?? (node as any).longitude);
        if (lat != null && lon != null) {
          out.push({ lat, lon, time: parseTimeToMs(safeNum((node as any).time ?? action?.time)), missionKey, label: typeof action?.name === "string" ? action.name : undefined });
        }
      }
      for (const k of Object.keys(node)) stack.push((node as any)[k]);
    }
  }

  out.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
  const dedup: WaypointEvent[] = [];
  for (const w of out) {
    const prev = dedup[dedup.length - 1];
    if (!prev) { dedup.push(w); continue; }
    const sameTime = prev.time != null && w.time != null && Math.abs(prev.time - w.time) <= 1;
    const close = haversineMeters(prev.lat, prev.lon, w.lat, w.lon) < 1.5;
    if (sameTime || close) continue;
    dedup.push(w);
  }
  return dedup;
}

function buildProjector(lat0: number) {
  const metersPerDegLat = 111320;
  const metersPerDegLon = 111320 * Math.cos(toRad(lat0));
  return {
    toXY: (lat: number, lon: number) => ({
      x: lon * metersPerDegLon,
      y: lat * metersPerDegLat,
    }),
  };
}

type GridIndex<T> = {
  cellSizeM: number;
  grid: Map<string, T[]>;
  keyForXY: (x: number, y: number) => { cx: number; cy: number; key: string };
};

function makeGridIndex<T extends { x: number; y: number }>(items: T[], cellSizeM: number): GridIndex<T> {
  const grid = new Map<string, T[]>();
  const keyForXY = (x: number, y: number) => {
    const cx = Math.floor(x / cellSizeM);
    const cy = Math.floor(y / cellSizeM);
    return { cx, cy, key: `${cx},${cy}` };
  };
  for (const it of items) {
    const { key } = keyForXY(it.x, it.y);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key)!.push(it);
  }
  return { cellSizeM, grid, keyForXY };
}

function candidatesInRadius<T extends { x: number; y: number }>(idx: GridIndex<T>, x: number, y: number, radiusM: number): T[] {
  const { cx, cy } = idx.keyForXY(x, y);
  const rCells = Math.ceil(radiusM / idx.cellSizeM);
  const out: T[] = [];
  for (let dx = -rCells; dx <= rCells; dx++) {
    for (let dy = -rCells; dy <= rCells; dy++) {
      const key = `${cx + dx},${cy + dy}`;
      const bucket = idx.grid.get(key);
      if (bucket) out.push(...bucket);
    }
  }
  return out;
}

function adaptiveRadiusM(nearestPoleDistanceM?: number) {
  const d = nearestPoleDistanceM;
  if (d == null || !Number.isFinite(d)) return 25;
  if (d < 20) return 15;
  if (d < 50) return 25;
  return 40;
}

function computeConfidence(d1?: number, d2?: number): "high" | "medium" | "low" | "n/a" {
  if (d1 == null || !Number.isFinite(d1)) return "n/a";
  if (d2 == null || !Number.isFinite(d2) || d2 <= 0) {
    if (d1 < 15) return "high";
    if (d1 < 25) return "medium";
    return "low";
  }
  const ratio = d2 / Math.max(d1, 0.0001);
  if (d1 < 15 && ratio > 1.5) return "high";
  if (d1 < 25 && ratio > 1.2) return "medium";
  return "low";
}

function formatMeters(m?: number) {
  if (m == null || !Number.isFinite(m)) return "n/a";
  if (m < 1000) return `${Math.round(m)}m`;
  return `${(m / 1000).toFixed(2)}km`;
}

function formatSeconds(s?: number) {
  if (s == null || !Number.isFinite(s)) return "n/a";
  if (s < 60) return `${Math.round(s)}s`;
  const mins = Math.floor(s / 60);
  const secs = Math.round(s - mins * 60);
  return `${mins}m ${secs}s`;
}

function MapFlyTo({ lat, lon, zoom }: { lat: number; lon: number; zoom: number }) {
  const map = useMap();
  React.useEffect(() => {
    map.flyTo([lat, lon], zoom, { duration: 0.45 });
  }, [lat, lon, zoom, map]);
  return null;
}

function FitBounds({ points, pad = 40 }: { points: Array<{ lat: number; lon: number }>; pad?: number }) {
  const map = useMap();
  React.useEffect(() => {
    if (!points.length) return;
    const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lon] as [number, number]));
    map.fitBounds(bounds, { padding: [pad, pad] });
  }, [points, pad, map]);
  return null;
}

export default function App() {
  const [csvRows, setCsvRows] = useState<DetectionsRow[]>([]);
  const [polesGeoJson, setPolesGeoJson] = useState<FeatureCollection<Geometry, any> | null>(null);

  const [flightPhotos, setFlightPhotos] = useState<FlightPhotoEvent[]>([]);
  const [waypoints, setWaypoints] = useState<WaypointEvent[]>([]);

  const [csvError, setCsvError] = useState<string | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [flightError, setFlightError] = useState<string | null>(null);

  const [maxJoinDistanceM, setMaxJoinDistanceM] = useState<number>(40);
  const [search, setSearch] = useState<string>("");

  const [selectedPoleKey, setSelectedPoleKey] = useState<string | null>(null);
  const [selectedImage, setSelectedImage] = useState<ImageAgg | null>(null);
  const [selectedUnassigned, setSelectedUnassigned] = useState<ImageAgg | null>(null);
  const [rightTab, setRightTab] = useState<"asset" | "unassigned">("asset");

  const [manualOverrides, setManualOverrides] = useState<Record<string, ManualOverride>>({});

  const csvInputRef = useRef<HTMLInputElement | null>(null);
  const geoInputRef = useRef<HTMLInputElement | null>(null);
  const flightInputRef = useRef<HTMLInputElement | null>(null);

  const polesIndex = useMemo(() => {
    if (!polesGeoJson?.features?.length) return null;

    const raw: { poleKey: string; lat: number; lon: number; assetId: string }[] = [];
    for (let i = 0; i < polesGeoJson.features.length; i++) {
      const f = polesGeoJson.features[i];
      const ll = getPoleLatLon(f);
      if (ll.lat == null || ll.lon == null) continue;
      raw.push({ poleKey: String(i), lat: ll.lat, lon: ll.lon, assetId: getAssetIdFromFeature(f) });
    }
    if (!raw.length) return [];

    const lat0 = raw.reduce((s, p) => s + p.lat, 0) / raw.length;
    const proj = buildProjector(lat0);

    const list: PoleIndexRow[] = raw.map((p) => {
      const xy = proj.toXY(p.lat, p.lon);
      return { ...p, x: xy.x, y: xy.y, nearestPoleDistanceM: undefined };
    });

    const grid = makeGridIndex(list, 50);
    for (const pole of list) {
      const candidates = candidatesInRadius(grid, pole.x, pole.y, 120);
      let best = Infinity;
      for (const other of candidates) {
        if (other.poleKey === pole.poleKey) continue;
        const dx = pole.x - other.x;
        const dy = pole.y - other.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < best) best = d;
      }
      if (Number.isFinite(best) && best !== Infinity) pole.nearestPoleDistanceM = best;
    }

    return list;
  }, [polesGeoJson]);

  const poleGrid = useMemo(() => {
    if (!polesIndex?.length) return null;
    return makeGridIndex(polesIndex, 50);
  }, [polesIndex]);

  const flightIndexByFilename = useMemo(() => {
    const m = new Map<string, FlightPhotoEvent[]>();
    for (const p of flightPhotos) {
      if (!p.key) continue;
      if (!m.has(p.key)) m.set(p.key, []);
      m.get(p.key)!.push(p);
    }
    for (const arr of m.values()) arr.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
    return m;
  }, [flightPhotos]);

  const waypointsByMission = useMemo(() => {
    const m = new Map<string, WaypointEvent[]>();
    for (const w of waypoints) {
      if (!m.has(w.missionKey)) m.set(w.missionKey, []);
      m.get(w.missionKey)!.push(w);
    }
    for (const arr of m.values()) arr.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
    return m;
  }, [waypoints]);

  const imagesAgg = useMemo((): ImageAgg[] => {
    if (!csvRows.length) return [];

    const byFile = new Map<string, DetectionsRow[]>();
    for (const r of csvRows) {
      const fn = (r.filename ?? "").trim();
      if (!fn) continue;
      if (!byFile.has(fn)) byFile.set(fn, []);
      byFile.get(fn)!.push(r);
    }

    const out: ImageAgg[] = [];

    for (const [filename, rows] of byFile.entries()) {
      const url =
        (rows.find((x) => (x["download-url"] ?? "").toString().trim())?.[
          "download-url"
        ] as any) ??
        (rows.find((x) => (x["view-url"] ?? "").toString().trim())?.["view-url"] as any) ??
        undefined;

      const captureTime =
        (rows.find((x) => (x["capture-time"] ?? "").toString().trim())?.[
          "capture-time"
        ] as any) ?? undefined;

      const fileKey = normaliseName(filename);

      const perImageComponentCounts: Record<string, number> = {};
      const perImageFaultCounts: Record<string, number> = {};

      for (const r of rows) {
        const { component, fault } = splitAnnotation(r["annotation-type"]);
        if (component) perImageComponentCounts[component] = (perImageComponentCounts[component] ?? 0) + 1;
        if (component && fault) {
          const key = `${component}: ${fault}`;
          perImageFaultCounts[key] = (perImageFaultCounts[key] ?? 0) + 1;
        }
      }

      let lat: number | undefined;
      let lon: number | undefined;
      let locationSource: ImageAgg["locationSource"] = "none";
      let missionKey: string | undefined;

      const flightCandidates = flightIndexByFilename.get(fileKey);
      if (flightCandidates?.length) {
        let chosen = flightCandidates[0];
        const ct = typeof captureTime === "string" ? new Date(captureTime).getTime() : undefined;
        if (ct != null && Number.isFinite(ct)) {
          let bestAbs = Infinity;
          for (const c of flightCandidates) {
            if (c.time == null) continue;
            const abs = Math.abs(c.time - ct);
            if (abs < bestAbs) { bestAbs = abs; chosen = c; }
          }
        }
        lat = chosen.lat;
        lon = chosen.lon;
        missionKey = chosen.missionKey;
        locationSource = "flight_log";
      } else {
        const lats = rows.map((x) => safeNum(x.latitude)).filter((x): x is number => x != null);
        const lons = rows.map((x) => safeNum(x.longitude)).filter((x): x is number => x != null);
        if (lats.length && lons.length && lats.length === lons.length) {
          lat = lats.reduce((s, v) => s + v, 0) / lats.length;
          lon = lons.reduce((s, v) => s + v, 0) / lons.length;
          locationSource = "csv_centroid";
        }
      }

      out.push({
        filename, fileKey, url,
        captureTime: typeof captureTime === "string" ? captureTime : undefined,
        lat, lon, locationSource,
        joinMethod: "none", joinConfidence: "n/a", joinReason: "none",
        rows, perImageComponentCounts, perImageFaultCounts, missionKey,
      });
    }

    out.sort((a, b) => {
      const ta = a.captureTime ? new Date(a.captureTime).getTime() : 0;
      const tb = b.captureTime ? new Date(b.captureTime).getTime() : 0;
      return tb - ta;
    });

    return out;
  }, [csvRows, flightIndexByFilename]);

  // Returns top K nearest poles using true haversine distances
  const getNearestPoles = useMemo(() => {
    if (!polesIndex?.length || !poleGrid) return null;

    const lat0 = polesIndex.reduce((s, p) => s + p.lat, 0) / polesIndex.length;
    const proj = buildProjector(lat0);

    return (lat: number, lon: number, k = 3) => {
      const xy = proj.toXY(lat, lon);
      const gatherRadius = Math.max(200, maxJoinDistanceM * 6);
      let candidates = candidatesInRadius(poleGrid, xy.x, xy.y, gatherRadius);
      if (!candidates.length) candidates = polesIndex;

      return candidates
        .map((p) => ({ ...p, distanceM: haversineMeters(lat, lon, p.lat, p.lon) }))
        .sort((a, b) => a.distanceM - b.distanceM)
        .slice(0, Math.max(1, k));
    };
  }, [polesIndex, poleGrid, maxJoinDistanceM]);

  const joinedImages = useMemo(() => {
    if (!imagesAgg.length) return imagesAgg;

    if (!polesIndex?.length || !poleGrid) {
      return imagesAgg.map((img) => ({
        ...img,
        poleKey: undefined,
        assetId: undefined,
        joinMethod: "none" as const,
        joinReason: (img.lat == null || img.lon == null ? "no_location" : "no_poles") as any,
        joinConfidence: "n/a" as const,
      }));
    }

    const lat0 = polesIndex.reduce((s, p) => s + p.lat, 0) / polesIndex.length;
    const proj = buildProjector(lat0);
    const hardCap = Math.max(0, maxJoinDistanceM);

    // Waypoint segments
    const segmentsByMission = new Map<string, { idx: number; start: number; end: number; wp: WaypointEvent }[]>();
    for (const [missionKey, wps] of waypointsByMission.entries()) {
      const valid = wps.filter((w) => typeof w.time === "number" && Number.isFinite(w.time));
      if (valid.length < 1) continue;
      const segs: { idx: number; start: number; end: number; wp: WaypointEvent }[] = [];
      for (let i = 0; i < valid.length; i++) {
        const start = valid[i].time as number;
        const end = i + 1 < valid.length ? (valid[i + 1].time as number) : start + 60_000;
        segs.push({ idx: i, start, end, wp: valid[i] });
      }
      segmentsByMission.set(missionKey, segs);
    }

    // Waypoint to pole assignment using haversine distances
    const waypointPoleAssignment = new Map<string, { poleKey?: string; assetId?: string; d1?: number; d2?: number; radius?: number; confidence?: "high" | "medium" | "low" | "n/a" }[]>();

    for (const [missionKey, segs] of segmentsByMission.entries()) {
      const arr: { poleKey?: string; assetId?: string; d1?: number; d2?: number; radius?: number; confidence?: "high" | "medium" | "low" | "n/a" }[] = [];

      for (const seg of segs) {
        const xy = proj.toXY(seg.wp.lat, seg.wp.lon);
        let candidates = candidatesInRadius(poleGrid, xy.x, xy.y, Math.max(200, hardCap * 4));
        if (!candidates.length) candidates = polesIndex;

        const scored = candidates
          .map((pole) => ({ pole, d: haversineMeters(seg.wp.lat, seg.wp.lon, pole.lat, pole.lon) }))
          .sort((a, b) => a.d - b.d);

        const best = scored[0];
        const second = scored[1];

        const localRadius = adaptiveRadiusM(best?.pole.nearestPoleDistanceM);
        const radiusUsed = Math.min(localRadius, hardCap);
        const d1 = best?.d;
        const d2 = second?.d;
        const conf = computeConfidence(d1, d2);

        if (!best || d1 == null || d1 > radiusUsed) {
          arr.push({ poleKey: undefined, assetId: undefined, d1, d2, radius: radiusUsed, confidence: conf });
          continue;
        }

        arr.push({ poleKey: best.pole.poleKey, assetId: best.pole.assetId, d1, d2, radius: radiusUsed, confidence: conf });
      }

      waypointPoleAssignment.set(missionKey, arr);
    }

    const out: ImageAgg[] = [];

    for (const img of imagesAgg) {
      // Manual override always wins
      const ov = manualOverrides[img.fileKey];
      if (ov) {
        out.push({
          ...img,
          poleKey: ov.poleKey,
          assetId: ov.assetId,
          joinMethod: "manual_override",
          joinReason: "manual",
          joinConfidence: "high",
          joinDistanceM: ov.distanceM,
        });
        continue;
      }

      const hasLoc = img.lat != null && img.lon != null;
      const missionKey = img.missionKey;

      let imgTime: number | undefined;
      if (img.captureTime) {
        const t = new Date(img.captureTime).getTime();
        if (Number.isFinite(t)) imgTime = t;
      }
      if (imgTime == null) {
        const flight = flightIndexByFilename.get(img.fileKey)?.[0];
        if (flight?.time != null) imgTime = flight.time;
      }

      const canUseWaypoints =
        missionKey != null && imgTime != null &&
        segmentsByMission.has(missionKey) && waypointPoleAssignment.has(missionKey);

      if (canUseWaypoints) {
        const segs = segmentsByMission.get(missionKey!)!;
        const assignments = waypointPoleAssignment.get(missionKey!)!;

        let segIdx = -1;
        for (let i = 0; i < segs.length; i++) {
          if (imgTime! >= segs[i].start && imgTime! < segs[i].end) { segIdx = i; break; }
        }

        if (segIdx >= 0) {
          const a = assignments[segIdx];
          if (a?.poleKey && a.assetId && a.d1 != null) {
            const wp = segs[segIdx].wp;
            out.push({
              ...img,
              lat: wp.lat, lon: wp.lon, locationSource: "waypoint_anchor",
              poleKey: a.poleKey, assetId: a.assetId,
              joinDistanceM: a.d1, secondBestDistanceM: a.d2, joinRadiusUsedM: a.radius,
              joinMethod: "waypoint_segment", joinConfidence: a.confidence, joinReason: "none",
              waypointIndex: segIdx,
            });
            continue;
          }

          out.push({
            ...img,
            joinMethod: "waypoint_segment", joinConfidence: a?.confidence ?? "n/a",
            joinReason: "outside_radius", joinRadiusUsedM: a?.radius,
            joinDistanceM: a?.d1, secondBestDistanceM: a?.d2, waypointIndex: segIdx,
          });
          continue;
        }
      }

      if (!hasLoc) {
        out.push({ ...img, poleKey: undefined, assetId: undefined, joinMethod: "none", joinReason: "no_location", joinConfidence: "n/a" });
        continue;
      }

      // Photo nearest using haversine
      const xy = proj.toXY(img.lat!, img.lon!);
      let candidates = candidatesInRadius(poleGrid, xy.x, xy.y, Math.max(200, hardCap * 6));
      if (!candidates.length) candidates = polesIndex;

      const scored = candidates
        .map((pole) => ({ pole, d: haversineMeters(img.lat!, img.lon!, pole.lat, pole.lon) }))
        .sort((a, b) => a.d - b.d);

      const best = scored[0];
      const second = scored[1];

      if (!best) {
        out.push({ ...img, poleKey: undefined, assetId: undefined, joinMethod: "photo_nearest", joinReason: "no_poles", joinConfidence: "n/a" });
        continue;
      }

      const localRadius = adaptiveRadiusM(best.pole.nearestPoleDistanceM);
      const radiusUsed = Math.min(localRadius, hardCap);
      const d1 = best.d;
      const d2 = second?.d;
      const conf = computeConfidence(d1, d2);

      if (d1 > radiusUsed) {
        out.push({ ...img, joinMethod: "photo_nearest", joinReason: "outside_radius", joinConfidence: conf, joinRadiusUsedM: radiusUsed, joinDistanceM: d1, secondBestDistanceM: d2 });
        continue;
      }

      const isCluster = (best.pole.nearestPoleDistanceM ?? Infinity) < 25;
      const ambiguous = isCluster && d2 != null && Math.abs(d2 - d1) < 5;

      out.push({
        ...img,
        poleKey: best.pole.poleKey, assetId: best.pole.assetId,
        joinDistanceM: d1, secondBestDistanceM: d2, joinRadiusUsedM: radiusUsed,
        joinMethod: "photo_nearest", joinConfidence: conf,
        joinReason: ambiguous ? "ambiguous_cluster" : "none",
      });
    }

    return out;
  }, [imagesAgg, polesIndex, poleGrid, maxJoinDistanceM, waypointsByMission, flightIndexByFilename, manualOverrides]);

  const assetsAgg = useMemo(() => {
    const map = new Map<string, AssetAgg>();
    if (!polesGeoJson?.features?.length || !polesIndex?.length) return map;

    for (const pole of polesIndex) {
      map.set(pole.poleKey, {
        poleKey: pole.poleKey, assetId: pole.assetId, poleLat: pole.lat, poleLon: pole.lon,
        images: [], componentInventoryCounts: {}, faultInventoryCounts: {},
        componentDetectionTotals: {}, faultDetectionTotals: {},
      });
    }

    for (const img of joinedImages) {
      if (!img.poleKey) continue;
      const asset = map.get(img.poleKey);
      if (!asset) continue;
      asset.images.push(img);
      for (const [k, v] of Object.entries(img.perImageComponentCounts)) {
        asset.componentDetectionTotals[k] = (asset.componentDetectionTotals[k] ?? 0) + v;
        asset.componentInventoryCounts[k] = Math.max(asset.componentInventoryCounts[k] ?? 0, v);
      }
      for (const [k, v] of Object.entries(img.perImageFaultCounts)) {
        asset.faultDetectionTotals[k] = (asset.faultDetectionTotals[k] ?? 0) + v;
        asset.faultInventoryCounts[k] = Math.max(asset.faultInventoryCounts[k] ?? 0, v);
      }
    }

    for (const a of map.values()) {
      const ds = a.images.map((x) => x.joinDistanceM).filter((x): x is number => typeof x === "number");
      if (ds.length) a.avgJoinDistanceM = Number((ds.reduce((s, v) => s + v, 0) / ds.length).toFixed(1));
    }

    return map;
  }, [polesGeoJson, polesIndex, joinedImages]);

  const assetsList = useMemo(() => {
    const arr = Array.from(assetsAgg.values());
    arr.sort((a, b) => {
      const am = a.images.length > 0 ? 1 : 0;
      const bm = b.images.length > 0 ? 1 : 0;
      if (bm !== am) return bm - am;
      if (b.images.length !== a.images.length) return b.images.length - a.images.length;
      return a.assetId.localeCompare(b.assetId);
    });
    return arr;
  }, [assetsAgg]);

  const filteredAssets = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return assetsList;
    return assetsList.filter((a) => {
      if (a.assetId.toLowerCase().includes(q)) return true;
      if (Object.keys(a.componentInventoryCounts).some((k) => k.toLowerCase().includes(q))) return true;
      if (Object.keys(a.faultInventoryCounts).some((k) => k.toLowerCase().includes(q))) return true;
      return false;
    });
  }, [assetsList, search]);

  const selectedAsset = useMemo(() => {
    if (!selectedPoleKey) return null;
    return assetsAgg.get(selectedPoleKey) ?? null;
  }, [assetsAgg, selectedPoleKey]);

  const unassignedImages = useMemo(() => {
    return joinedImages
      .filter((x) => !x.poleKey)
      .slice()
      .sort((a, b) => {
        const ta = a.captureTime ? new Date(a.captureTime).getTime() : 0;
        const tb = b.captureTime ? new Date(b.captureTime).getTime() : 0;
        return tb - ta;
      });
  }, [joinedImages]);

  const stats = useMemo(() => {
    const detectionsLoaded = csvRows.length;
    const uniqueImages = imagesAgg.length;
    const polesLoaded = polesGeoJson?.features?.length ?? 0;
    const polesWithCoords = polesIndex?.length ?? 0;
    const imagesMatched = joinedImages.filter((x) => !!x.poleKey).length;
    const imagesUnmatched = uniqueImages - imagesMatched;
    const polesMatched = Array.from(assetsAgg.values()).filter((a) => a.images.length > 0).length;
    const missionsFound = new Set(flightPhotos.map((p) => p.missionKey)).size;

    const unmatchedByReason = {
      no_location: joinedImages.filter((x) => x.joinReason === "no_location").length,
      no_poles: joinedImages.filter((x) => x.joinReason === "no_poles").length,
      outside_radius: joinedImages.filter((x) => x.joinReason === "outside_radius").length,
      ambiguous_cluster: joinedImages.filter((x) => x.joinReason === "ambiguous_cluster").length,
    };

    let totalDistanceM = 0;
    const byMission = new Map<string, FlightPhotoEvent[]>();
    for (const p of flightPhotos) {
      if (!byMission.has(p.missionKey)) byMission.set(p.missionKey, []);
      byMission.get(p.missionKey)!.push(p);
    }
    for (const arr of byMission.values()) {
      const s = [...arr].sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
      for (let i = 1; i < s.length; i++) totalDistanceM += haversineMeters(s[i - 1].lat, s[i - 1].lon, s[i].lat, s[i].lon);
    }

    let totalMissionSeconds = 0;
    let missionsWithTime = 0;
    for (const arr of byMission.values()) {
      const times = arr.map((p) => p.time).filter((t): t is number => typeof t === "number" && Number.isFinite(t));
      if (times.length < 2) continue;
      times.sort((a, b) => a - b);
      const dur = (times[times.length - 1] - times[0]) / 1000;
      if (dur > 0) { totalMissionSeconds += dur; missionsWithTime += 1; }
    }
    const avgMissionSeconds = missionsWithTime ? totalMissionSeconds / missionsWithTime : undefined;

    let waypointMatched = 0;
    const seenWp = new Set<string>();
    for (const img of joinedImages) {
      if (img.joinMethod === "waypoint_segment" && img.missionKey && typeof img.waypointIndex === "number" && img.poleKey) {
        const k = `${img.missionKey}::${img.waypointIndex}`;
        if (!seenWp.has(k)) { seenWp.add(k); waypointMatched += 1; }
      }
    }
    const avgPoleTopSeconds = waypointMatched && totalMissionSeconds ? totalMissionSeconds / waypointMatched : undefined;

    return {
      detectionsLoaded, uniqueImages, polesLoaded, polesWithCoords,
      imagesMatched, imagesUnmatched, polesMatched, missionsFound,
      flightPhotosFound: flightPhotos.length, waypointsFound: waypoints.length,
      totalDistanceM, avgMissionSeconds, polesInspected: polesMatched,
      polesTotal: polesLoaded, avgPoleTopSeconds, unmatchedByReason,
      manualOverrides: Object.keys(manualOverrides).length,
    };
  }, [csvRows.length, imagesAgg.length, polesGeoJson, polesIndex, joinedImages, assetsAgg, flightPhotos, waypoints, manualOverrides]);

  const mapCenter: [number, number] = useMemo(() => {
    if (selectedUnassigned?.lat != null && selectedUnassigned?.lon != null) return [selectedUnassigned.lat, selectedUnassigned.lon];
    if (selectedAsset) return [selectedAsset.poleLat, selectedAsset.poleLon];
    if (polesIndex?.length) return [polesIndex[0].lat, polesIndex[0].lon];
    return [-33.86, 151.21];
  }, [selectedAsset, polesIndex, selectedUnassigned]);

  const onUploadCSV = async (file: File) => {
    setCsvError(null);
    try {
      const text = await file.text();
      const rows = parseCSV(text);
      if (!rows.length) { setCsvRows([]); setCsvError("CSV parsed but no rows found."); return; }
      setCsvRows(rows);
    } catch (e: any) { setCsvRows([]); setCsvError(e?.message ?? "Failed to parse CSV."); }
  };

  const onUploadGeoJSON = async (file: File) => {
    setGeoError(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed || parsed.type !== "FeatureCollection" || !Array.isArray(parsed.features)) {
        setPolesGeoJson(null); setGeoError("That file does not look like a GeoJSON FeatureCollection."); return;
      }
      setPolesGeoJson(parsed);
    } catch (e: any) { setPolesGeoJson(null); setGeoError(e?.message ?? "Failed to parse GeoJSON."); }
  };

  const onUploadFlightLogs = async (files: FileList) => {
    setFlightError(null);
    try {
      const allPhotos: FlightPhotoEvent[] = [];
      const allWps: WaypointEvent[] = [];
      for (const file of Array.from(files)) {
        const text = await file.text();
        const parsed = JSON.parse(text);
        allPhotos.push(...parseFlightRecordPhotos(parsed, file.name));
        allWps.push(...parseWaypoints(parsed, file.name));
      }
      setFlightPhotos(allPhotos);
      setWaypoints(allWps);
      if (!allPhotos.length) setFlightError("No PHOTO_TAKEN events found in those mission logs.");
      else if (allWps.length === 0) setFlightError("Flight logs loaded. No waypoint-like events found, so matching uses per-photo nearest pole only.");
      else setFlightError(null);
    } catch (e: any) { setFlightPhotos([]); setWaypoints([]); setFlightError(e?.message ?? "Failed to parse flight log JSON."); }
  };

  const clearAll = () => {
    setCsvRows([]); setPolesGeoJson(null); setFlightPhotos([]); setWaypoints([]);
    setSelectedPoleKey(null); setSelectedImage(null); setSelectedUnassigned(null);
    setCsvError(null); setGeoError(null); setFlightError(null);
    setSearch(""); setManualOverrides({}); setRightTab("asset");
  };

  const downloadEnrichedGeoJSON = () => {
    if (!polesGeoJson) return;
    const enriched: FeatureCollection<Geometry, any> = {
      type: "FeatureCollection",
      features: polesGeoJson.features.map((f, idx) => {
        const poleKey = String(idx);
        const agg = assetsAgg.get(poleKey);
        const props = { ...(f.properties ?? {}) } as any;
        if (agg) {
          props._assetId = agg.assetId;
          props._imagesAssociated = agg.images.length;
          props._componentsOnAsset = Object.values(agg.componentInventoryCounts).reduce((s, v) => s + v, 0);
          props._faultsOnAsset = Object.values(agg.faultInventoryCounts).reduce((s, v) => s + v, 0);
          props._avgJoinDistanceM = agg.avgJoinDistanceM ?? null;
          props._componentInventoryBreakdown = agg.componentInventoryCounts;
          props._faultInventoryBreakdown = agg.faultInventoryCounts;
          props._componentDetectionTotals = agg.componentDetectionTotals;
          props._faultDetectionTotals = agg.faultDetectionTotals;
        }
        return { ...f, properties: props };
      }),
    };
    const blob = new Blob([JSON.stringify(enriched, null, 2)], { type: "application/geo+json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "poles_enriched.geojson"; a.click();
    URL.revokeObjectURL(url);
  };

  // Use same coords as polesIndex so map markers match the distance calculations
  const markerGeoJson = useMemo(() => {
    if (!polesGeoJson || !polesIndex?.length) return null;
    return {
      type: "FeatureCollection",
      features: polesIndex.map((p) => ({
        type: "Feature",
        properties: { _poleKey: p.poleKey, _assetId: p.assetId },
        geometry: { type: "Point", coordinates: [p.lon, p.lat] },
      })),
    } as any;
  }, [polesGeoJson, polesIndex]);

  const componentInventoryTotal = selectedAsset
    ? Object.values(selectedAsset.componentInventoryCounts).reduce((s, v) => s + v, 0) : 0;
  const faultInventoryTotal = selectedAsset
    ? Object.values(selectedAsset.faultInventoryCounts).reduce((s, v) => s + v, 0) : 0;

  const candidatePolesForSelectedUnassigned = useMemo(() => {
    if (!selectedUnassigned?.lat || !selectedUnassigned?.lon || !getNearestPoles) return [];
    return getNearestPoles(selectedUnassigned.lat, selectedUnassigned.lon, 3);
  }, [selectedUnassigned, getNearestPoles]);

  const fitPointsForUnassigned = useMemo(() => {
    if (!selectedUnassigned?.lat || !selectedUnassigned?.lon) return [];
    const pts: Array<{ lat: number; lon: number }> = [{ lat: selectedUnassigned.lat, lon: selectedUnassigned.lon }];
    for (const p of candidatePolesForSelectedUnassigned) pts.push({ lat: p.lat, lon: p.lon });
    return pts;
  }, [selectedUnassigned, candidatePolesForSelectedUnassigned]);

  const assignImageToPole = (img: ImageAgg, poleKey: string, assetId: string, distanceM?: number) => {
    setManualOverrides((prev) => ({
      ...prev,
      [img.fileKey]: { fileKey: img.fileKey, filename: img.filename, poleKey, assetId, distanceM, assignedAt: Date.now() },
    }));
    setSelectedPoleKey(poleKey);
    setSelectedImage(null);
    setSelectedUnassigned(null);
    setRightTab("asset");
  };

  const clearOverrideForImage = (img: ImageAgg) => {
    setManualOverrides((prev) => {
      const next = { ...prev };
      delete next[img.fileKey];
      return next;
    });
  };

  return (
    <div className="appShell">
      <header className="appHeader">
        <div className="headerTitleBlock">
          <div className="headerTitle">Asset ID Media Browser</div>
          <div className="headerSub">
            Upload detections CSV, poles GeoJSON, and Autofly mission logs. Images join to poles by location, with manual overrides for hard cases.
          </div>
        </div>

        <div className="headerControls">
          <div className="controlGroup">
            <label className="controlLabel">Max auto-join distance (m)</label>
            <input
              className="controlInput"
              type="number"
              value={maxJoinDistanceM}
              onChange={(e) => setMaxJoinDistanceM(Math.max(0, Number(e.target.value)))}
            />
          </div>

          <div className="controlGroup">
            <label className="controlLabel">Search</label>
            <input
              className="controlInput"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="asset id, component, fault"
            />
          </div>

          <div className="buttonRow">
            <input ref={csvInputRef} type="file" accept=".csv,text/csv" style={{ display: "none" }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void onUploadCSV(f); if (csvInputRef.current) csvInputRef.current.value = ""; }} />
            <button className="btn" onClick={() => csvInputRef.current?.click()}>Upload CSV</button>

            <input ref={geoInputRef} type="file" accept=".geojson,application/geo+json,application/json" style={{ display: "none" }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void onUploadGeoJSON(f); if (geoInputRef.current) geoInputRef.current.value = ""; }} />
            <button className="btn" onClick={() => geoInputRef.current?.click()}>Upload GeoJSON</button>

            <input ref={flightInputRef} type="file" accept=".json,application/json" multiple style={{ display: "none" }}
              onChange={(e) => { const fs = e.target.files; if (fs && fs.length) void onUploadFlightLogs(fs); if (flightInputRef.current) flightInputRef.current.value = ""; }} />
            <button className="btn" onClick={() => flightInputRef.current?.click()}>Upload Mission Logs</button>

            <button className="btn" onClick={downloadEnrichedGeoJSON} disabled={!polesGeoJson}>Download GeoJSON</button>
            <button className="btn secondary" onClick={clearAll}>Clear</button>
          </div>

          <div className="headerStats">
            <span>Detections: <b>{stats.detectionsLoaded}</b></span>
            <span>Unique images: <b>{stats.uniqueImages}</b></span>
            <span>Poles: <b>{stats.polesLoaded}</b> (coords: <b>{stats.polesWithCoords}</b>)</span>
            <span>Images matched: <b>{stats.imagesMatched}</b> (unmatched: <b>{stats.imagesUnmatched}</b>)</span>
            <span>Overrides: <b>{stats.manualOverrides}</b></span>
            <span>Poles inspected: <b>{stats.polesInspected}</b> of <b>{stats.polesTotal}</b></span>
            <span>Missions: <b>{stats.missionsFound}</b></span>
            <span>Photos: <b>{stats.flightPhotosFound}</b> Waypoints: <b>{stats.waypointsFound}</b></span>
            <span>Total distance (est): <b>{formatMeters(stats.totalDistanceM)}</b></span>
            <span>Avg mission (est): <b>{formatSeconds(stats.avgMissionSeconds)}</b></span>
            <span>Avg pole top (est): <b>{formatSeconds(stats.avgPoleTopSeconds)}</b></span>
          </div>

          <div className="headerStats" style={{ marginTop: 6 }}>
            <span>
              Unmatched reasons:
              <b> no loc {stats.unmatchedByReason.no_location}</b>,
              <b> no poles {stats.unmatchedByReason.no_poles}</b>,
              <b> outside radius {stats.unmatchedByReason.outside_radius}</b>,
              <b> ambiguous {stats.unmatchedByReason.ambiguous_cluster}</b>
            </span>
          </div>

          {csvError ? <div className="errorLine">CSV error: {csvError}</div> : null}
          {geoError ? <div className="errorLine">GeoJSON error: {geoError}</div> : null}
          {flightError ? <div className="errorLine">Mission log note: {flightError}</div> : null}
        </div>
      </header>

      <div className="appBody">
        <aside className="leftPane">
          <div className="paneHeader">
            <div className="paneTitle">Assets</div>
            <div className="paneMeta">Showing {filteredAssets.length} of {assetsList.length}</div>
          </div>

          <div className="assetList">
            {filteredAssets.map((a) => {
              const compInvTotal = Object.values(a.componentInventoryCounts).reduce((s, v) => s + v, 0);
              const faultInvTotal = Object.values(a.faultInventoryCounts).reduce((s, v) => s + v, 0);
              return (
                <button
                  key={a.poleKey}
                  className={`assetRow ${selectedPoleKey === a.poleKey ? "selected" : ""}`}
                  onClick={() => { setSelectedPoleKey(a.poleKey); setSelectedImage(null); setSelectedUnassigned(null); setRightTab("asset"); }}
                  title={a.assetId}
                >
                  <div className="assetRowTop">
                    <div className="assetId">{a.assetId}</div>
                    <div className={`pill ${a.images.length ? "pillGood" : ""}`}>
                      {a.images.length ? `${a.images.length} imgs` : "no imgs"}
                    </div>
                  </div>
                  <div className="assetRowBottom">
                    <span>Components <b>{compInvTotal}</b></span>
                    <span>Faults <b>{faultInvTotal}</b></span>
                    <span>Avg join <b>{a.avgJoinDistanceM != null ? `${a.avgJoinDistanceM}m` : "n/a"}</b></span>
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        <main className="mapPane">
          <MapContainer
            center={mapCenter}
            zoom={selectedUnassigned ? 19 : selectedAsset ? 17 : 12}
            style={{ height: "100%", width: "100%" }}
            scrollWheelZoom
          >
            <TileLayer url={DEFAULT_TILE} />

            {markerGeoJson ? (
              <GeoJSON
                data={markerGeoJson}
                pointToLayer={(feature, latlng) => {
                  const marker = L.circleMarker(latlng, { radius: 5, weight: 1, opacity: 0.9, fillOpacity: 0.7 } as any);
                  marker.on("click", () => {
                    const pk = (feature as any)?.properties?._poleKey as string | undefined;
                    if (pk) { setSelectedPoleKey(pk); setSelectedImage(null); setSelectedUnassigned(null); setRightTab("asset"); return; }
                    if (!polesIndex?.length) return;
                    let best: { poleKey: string; d: number } | null = null;
                    for (const p of polesIndex) {
                      const d = haversineMeters(latlng.lat, latlng.lng, p.lat, p.lon);
                      if (!best || d < best.d) best = { poleKey: p.poleKey, d };
                    }
                    if (best) { setSelectedPoleKey(best.poleKey); setSelectedImage(null); setSelectedUnassigned(null); setRightTab("asset"); }
                  });
                  return marker;
                }}
              />
            ) : null}

            {selectedAsset ? (
              <>
                <MapFlyTo lat={selectedAsset.poleLat} lon={selectedAsset.poleLon} zoom={17} />
                <Marker position={[selectedAsset.poleLat, selectedAsset.poleLon]} icon={DefaultIcon}>
                  <Popup>
                    <div className="popupBox">
                      <div className="popupTitle">{selectedAsset.assetId}</div>
                      <div className="popupLine">Lat {selectedAsset.poleLat.toFixed(6)}, Lon {selectedAsset.poleLon.toFixed(6)}</div>
                      <div className="popupLine">Images {selectedAsset.images.length}</div>
                    </div>
                  </Popup>
                </Marker>

                {selectedAsset.images
                  .filter((img) => img.lat != null && img.lon != null)
                  .map((img) => (
                    <CircleMarker
                      key={`imgdot-${img.fileKey}`}
                      center={[img.lat as number, img.lon as number]}
                      radius={6}
                      pathOptions={{ color: "#cc0000", fillColor: "#cc0000", fillOpacity: 0.75, weight: 1 }}
                      eventHandlers={{ click: () => setSelectedImage(img) }}
                    >
                      <Popup>
                        <div className="popupBox">
                          <div className="popupTitle">Image</div>
                          <div className="popupLine">{img.filename}</div>
                          <div className="popupLine">Join {img.joinDistanceM != null ? formatMeters(img.joinDistanceM) : "n/a"}</div>
                          <div className="popupLine">Method {img.joinMethod ?? "none"}</div>
                        </div>
                      </Popup>
                    </CircleMarker>
                  ))}
              </>
            ) : null}

            {selectedUnassigned?.lat != null && selectedUnassigned?.lon != null ? (
              <>
                <FitBounds points={fitPointsForUnassigned} pad={70} />

                <CircleMarker
                  center={[selectedUnassigned.lat, selectedUnassigned.lon]}
                  radius={8}
                  pathOptions={{ color: "#cc0000", fillColor: "#cc0000", fillOpacity: 0.85, weight: 2 }}
                >
                  <Popup>
                    <div className="popupBox">
                      <div className="popupTitle">Unassigned image</div>
                      <div className="popupLine">{selectedUnassigned.filename}</div>
                      <div className="popupLine">Reason {selectedUnassigned.joinReason ?? "n/a"}</div>
                    </div>
                  </Popup>
                </CircleMarker>

                {candidatePolesForSelectedUnassigned.map((p, idx) => (
                  <React.Fragment key={`cand-${p.poleKey}`}>
                    <CircleMarker
                      center={[p.lat, p.lon]}
                      radius={7}
                      pathOptions={{
                        color: idx === 0 ? "#0057ff" : "#666666",
                        fillColor: idx === 0 ? "#0057ff" : "#666666",
                        fillOpacity: 0.8, weight: 2,
                      }}
                    >
                      <Popup>
                        <div className="popupBox">
                          <div className="popupTitle">Candidate pole</div>
                          <div className="popupLine">{p.assetId}</div>
                          <div className="popupLine">Distance {formatMeters(p.distanceM)}</div>
                        </div>
                      </Popup>
                    </CircleMarker>

                    <Polyline
                      positions={[[selectedUnassigned.lat as number, selectedUnassigned.lon as number], [p.lat, p.lon]]}
                      pathOptions={{ color: idx === 0 ? "#0057ff" : "#999999", weight: idx === 0 ? 3 : 2, opacity: 0.75 }}
                    />
                  </React.Fragment>
                ))}
              </>
            ) : null}
          </MapContainer>
        </main>

        <aside className="rightPane">
          <div className="paneHeader" style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button className={`btn ${rightTab === "asset" ? "" : "secondary"}`} onClick={() => setRightTab("asset")}>Asset</button>
            <button className={`btn ${rightTab === "unassigned" ? "" : "secondary"}`} onClick={() => setRightTab("unassigned")}>
              Unassigned ({unassignedImages.length})
            </button>
          </div>

          {rightTab === "unassigned" ? (
            <div className="assetPanel">
              <div className="assetPanelHeader">
                <div>
                  <div className="assetPanelLabel">Unassigned images</div>
                  <div className="muted small">Click an image to zoom to it and show the 3 closest poles. Then assign manually.</div>
                </div>
              </div>

              <div className="thumbGrid">
                {unassignedImages.map((img) => (
                  <button
                    key={`un-${img.fileKey}`}
                    className={`thumbCard ${selectedUnassigned?.fileKey === img.fileKey ? "selected" : ""}`}
                    onClick={() => { setSelectedUnassigned(img); setSelectedPoleKey(null); setSelectedImage(null); }}
                    title={img.filename}
                  >
                    <div className="thumbImgWrap">
                      {img.url ? <img className="thumbImg" src={img.url} alt={img.filename} /> : <div className="thumbNoImg">No URL</div>}
                    </div>
                    <div className="thumbMeta">
                      <div className="thumbTitle">Unassigned</div>
                      <div className="thumbSub">{img.joinReason ?? "n/a"}</div>
                      <div className="thumbSub">GPS {img.lat != null && img.lon != null ? "yes" : "no"} ({img.locationSource})</div>
                    </div>
                  </button>
                ))}
              </div>

              {selectedUnassigned ? (
                <div className="block" style={{ marginTop: 12 }}>
                  <div className="blockTitle">Assign this image</div>
                  <div className="muted small">Distances are true GPS (haversine). Map fits to show all candidates.</div>

                  {selectedUnassigned.lat == null || selectedUnassigned.lon == null ? (
                    <div className="muted">No GPS for this image. Cannot propose poles.</div>
                  ) : !candidatePolesForSelectedUnassigned.length ? (
                    <div className="muted">No poles loaded yet.</div>
                  ) : (
                    <div className="kvList">
                      {candidatePolesForSelectedUnassigned.map((p) => (
                        <button
                          key={`assign-${p.poleKey}`}
                          className="btn"
                          style={{ width: "100%", marginTop: 8 }}
                          onClick={() => assignImageToPole(selectedUnassigned, p.poleKey, p.assetId, p.distanceM)}
                        >
                          Assign to {p.assetId} ({formatMeters(p.distanceM)})
                        </button>
                      ))}
                    </div>
                  )}

                  {manualOverrides[selectedUnassigned.fileKey] ? (
                    <button className="btn secondary" style={{ width: "100%", marginTop: 10 }} onClick={() => clearOverrideForImage(selectedUnassigned)}>
                      Clear override for this image
                    </button>
                  ) : null}

                  {selectedUnassigned.lat != null && selectedUnassigned.lon != null ? (
                    <a className="link" href={`https://www.google.com/maps?q=${selectedUnassigned.lat},${selectedUnassigned.lon}`} target="_blank" rel="noreferrer">
                      Open image location in Google Maps
                    </a>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : !selectedAsset ? (
            <div className="emptyState">
              <div className="emptyTitle">Select an asset</div>
              <div className="emptyText">Click an asset in the left list or click a pole on the map to view components, faults, and images.</div>
            </div>
          ) : (
            <div className="assetPanel">
              <div className="assetPanelHeader">
                <div>
                  <div className="assetPanelLabel">Asset ID</div>
                  <div className="assetPanelId">{selectedAsset.assetId}</div>
                </div>
                <button className="btn secondary" onClick={() => { setSelectedPoleKey(null); setSelectedImage(null); }}>Clear</button>
              </div>

              <div className="summaryCards">
                <div className="card"><div className="cardLabel">Images</div><div className="cardValue">{selectedAsset.images.length}</div></div>
                <div className="card"><div className="cardLabel">Components on asset</div><div className="cardValue">{componentInventoryTotal}</div></div>
                <div className="card"><div className="cardLabel">Faults on asset</div><div className="cardValue">{faultInventoryTotal}</div></div>
                <div className="card">
                  <div className="cardLabel">Avg join</div>
                  <div className="cardValue">{selectedAsset.avgJoinDistanceM != null ? `${selectedAsset.avgJoinDistanceM}m` : "n/a"}</div>
                </div>
              </div>

              <div className="twoCols">
                <div className="block">
                  <div className="blockTitle">Component breakdown</div>
                  <div className="kvList">
                    {formatCountMap(selectedAsset.componentInventoryCounts).length ? (
                      formatCountMap(selectedAsset.componentInventoryCounts).map(([k, v]) => (
                        <div key={k} className="kvRow"><div className="kvKey">{k}</div><div className="kvVal">{v}</div></div>
                      ))
                    ) : <div className="muted">None</div>}
                  </div>
                </div>

                <div className="block">
                  <div className="blockTitle">Fault breakdown</div>
                  <div className="kvList">
                    {formatCountMap(selectedAsset.faultInventoryCounts).length ? (
                      formatCountMap(selectedAsset.faultInventoryCounts).map(([k, v]) => (
                        <div key={k} className="kvRow"><div className="kvKey">{k}</div><div className="kvVal">{v}</div></div>
                      ))
                    ) : <div className="muted">None</div>}
                  </div>
                </div>
              </div>

              <div className="block">
                <div className="blockTitle">Images</div>
                <div className="muted small">Red dots on the map are image locations for this asset. Click a dot or thumbnail to open the image.</div>

                <div className="thumbGrid">
                  {selectedAsset.images.map((img) => {
                    const compTop = formatCountMap(img.perImageComponentCounts)[0]?.[0];
                    const faultTop = formatCountMap(img.perImageFaultCounts)[0]?.[0];
                    return (
                      <button key={img.filename} className="thumbCard" onClick={() => setSelectedImage(img)} title={img.filename}>
                        <div className="thumbImgWrap">
                          {img.url ? <img className="thumbImg" src={img.url} alt={img.filename} /> : <div className="thumbNoImg">No URL</div>}
                        </div>
                        <div className="thumbMeta">
                          <div className="thumbTitle">{compTop ?? "Image"}</div>
                          <div className="thumbSub">{faultTop ? `Fault: ${faultTop.replace(": ", ".")}` : " "}</div>
                          <div className="thumbSub">Join {img.joinDistanceM != null ? formatMeters(img.joinDistanceM) : "n/a"} ({img.locationSource})</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </aside>
      </div>

      {selectedImage ? (
        <div className="modalBackdrop" onClick={() => setSelectedImage(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modalHeader">
              <div className="modalTitle">{selectedImage.filename}</div>
              <button className="btn secondary" onClick={() => setSelectedImage(null)}>Close</button>
            </div>

            <div className="modalBody">
              <div className="modalImgWrap">
                {selectedImage.url ? (
                  <img className="modalImg" src={selectedImage.url} alt={selectedImage.filename} />
                ) : (
                  <div className="thumbNoImg">No URL</div>
                )}
              </div>

              <div className="modalInfo">
                <div className="pillRow">
                  <span className="pill">Source: {selectedImage.locationSource}</span>
                  <span className="pill">Join: {selectedImage.joinDistanceM != null ? formatMeters(selectedImage.joinDistanceM) : "n/a"}</span>
                  <span className="pill">Method: {selectedImage.joinMethod ?? "none"}</span>
                  <span className="pill">Reason: {selectedImage.joinReason ?? "none"}</span>
                  {selectedImage.joinRadiusUsedM != null ? <span className="pill">Radius: {Math.round(selectedImage.joinRadiusUsedM)}m</span> : null}
                  {selectedImage.secondBestDistanceM != null ? <span className="pill">2nd: {Math.round(selectedImage.secondBestDistanceM)}m</span> : null}
                  <span className="pill">Rows: {selectedImage.rows.length}</span>
                </div>

                <div className="twoCols">
                  <div className="block">
                    <div className="blockTitle">Components in this image</div>
                    <div className="kvList">
                      {formatCountMap(selectedImage.perImageComponentCounts).length ? (
                        formatCountMap(selectedImage.perImageComponentCounts).map(([k, v]) => (
                          <div key={k} className="kvRow"><div className="kvKey">{k}</div><div className="kvVal">{v}</div></div>
                        ))
                      ) : <div className="muted">None</div>}
                    </div>
                  </div>

                  <div className="block">
                    <div className="blockTitle">Faults in this image</div>
                    <div className="kvList">
                      {formatCountMap(selectedImage.perImageFaultCounts).length ? (
                        formatCountMap(selectedImage.perImageFaultCounts).map(([k, v]) => (
                          <div key={k} className="kvRow"><div className="kvKey">{k}</div><div className="kvVal">{v}</div></div>
                        ))
                      ) : <div className="muted">None</div>}
                    </div>
                  </div>
                </div>

                {selectedImage.lat != null && selectedImage.lon != null ? (
                  <a className="link" href={`https://www.google.com/maps?q=${selectedImage.lat},${selectedImage.lon}`} target="_blank" rel="noreferrer">
                    Open image location in Google Maps
                  </a>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
