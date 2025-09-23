import React, { useEffect, useRef, useState } from "react";
import { MapContainer, TileLayer, ImageOverlay, LayersControl, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";

/**
 * GPX Heatmap Web (client‑side only)
 * - Sube .gpx y genera heatmap como ImageOverlay georreferenciado (invariante al zoom)
 * - Parámetros en vivo: gamma, sigma, threshold
 * - Varias sesiones apiladas (cada archivo es una fila colapsable)
 * - Encabezado: fecha/hora · nombre del lugar · archivo
 *
 * Notas técnicas:
 * - Evita carreras al regenerar overlays con un "sequence per session".
 * - `formatDateTime` robusto (sin crashear por fechas inválidas).
 * - Tests DEV activables con `?devtests=1` (sin `import.meta.env`).
 */

const ACTIVITY_META = {
  running: { label: "Running", emoji: "🏃", className: "running" },
  futbol: { label: "Fútbol", emoji: "⚽", className: "futbol" },
  bici: { label: "Bici", emoji: "🚴", className: "bici" },
};

// Heurísticas base para clasificar actividades según el patrón de movimiento.
// Se documenta explícitamente para poder afinarlas o exponerlas en sliders a futuro.
const ACTIVITY_HEURISTICS = {
  futbol: { maxDistanceKm: 5, maxSpanKm: 0.2 },
  bici: { minAvgSpeedKmh: 18, minMaxSpeedKmh: 28 },
  running: { maxAvgSpeedKmh: 12, maxSpanKm: 0.3 },
};

export default function App() {
  const [sessions, setSessions] = useState([]);
  const rebuildSeqRef = useRef({}); // id -> seq (invalida cálculos viejos)
  const geoCacheRef = useRef(new Map()); // "lat,lon" -> nombre de lugar

  function onInputFiles(e) {
    const files = Array.from(e.target.files || []);
    if (files.length) handleFiles(files);
    e.target.value = ""; // permitir re‑subir el mismo archivo
  }

  function onDrop(e) {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length) handleFiles(files);
  }

  function onDragOver(e) { e.preventDefault(); }

  async function handleFiles(files) {
    for (const file of files) {
      if (!file.name.toLowerCase().endsWith(".gpx")) continue;
      const text = await file.text();
      const parsed = parseGPX(text);
      if (!parsed.points.length) continue;

      const { points, startTime } = parsed;
      const stats = computeTrackStats(points);
      const activityType = classifyActivity(stats);
      const activityNote = deriveClassificationNote(stats, activityType);
      const center = centerOfPoints(points);
      const bounds = boundsOfPoints(points, 0.00045);

      const params = { gamma: 0.7, sigma: 7, threshold: 0.05, res: 1000 };
      const overlayUrl = await buildOverlay(points, bounds, params);

      const id = `${file.name}-${Date.now()}`;
      setSessions((prev) => [
        {
          id,
          fileName: file.name,
          startTime,
          center,
          bounds,
          params,
          points,
          overlayUrl,
          place: "Buscando lugar…",
          stats,
          activityType,
          activityNote,
        },
        ...prev,
      ]);

      // Resolver nombre del lugar (asincrónico, con cache por coord)
      resolvePlaceName(id, center);
    }
  }

  function updateParams(id, patch) {
    // 1) Actualiza parámetros para feedback inmediato
    setSessions((prev) => {
      const next = prev.map((s) => (s.id === id ? { ...s, params: { ...s.params, ...patch } } : s));
      // 2) Dispara regeneración con el estado más reciente
      scheduleOverlayRebuild(id, next);
      return next;
    });
  }

  function scheduleOverlayRebuild(id, nextSessions) {
    const sess = nextSessions.find((s) => s.id === id);
    if (!sess) return;
    const seq = (rebuildSeqRef.current[id] || 0) + 1;
    rebuildSeqRef.current[id] = seq;
    buildOverlay(sess.points, sess.bounds, sess.params).then((url) => {
      if (rebuildSeqRef.current[id] !== seq) return; // resultado viejo
      setSessions((cur) => cur.map((s) => (s.id === id ? { ...s, overlayUrl: url } : s)));
    });
  }

  async function resolvePlaceName(id, center) {
    try {
      const key = keyForLatLon(center.lat, center.lon);
      const cached = geoCacheRef.current.get(key);
      if (cached) {
        setSessions((cur) => cur.map((s) => (s.id === id ? { ...s, place: cached } : s)));
        return;
      }
      const name = await reverseGeocode(center.lat, center.lon);
      const place = name || "Ubicación desconocida";
      geoCacheRef.current.set(key, place);
      setSessions((cur) => cur.map((s) => (s.id === id ? { ...s, place } : s)));
    } catch {
      setSessions((cur) => cur.map((s) => (s.id === id ? { ...s, place: "Ubicación desconocida" } : s)));
    }
  }

  return (
    <div className="app" onDrop={onDrop} onDragOver={onDragOver}>
      <Style />

      <header className="app__header">
        <div className="app__header__inner">
          <h1 className="app__title">GPX Heatmap ⚽</h1>
          <label className="btn" title="Subir uno o varios .gpx">
            <input type="file" accept=".gpx" multiple className="hidden-input" onChange={onInputFiles} />
            Subir GPX
          </label>
        </div>
      </header>

      <main className="app__main">
        <div className="uploader">
          <div className="uploader__left">
            <p className="uploader__title">Arrastrá y soltá tus archivos .gpx aquí</p>
            <p className="uploader__hint">o usá el botón "Subir GPX". Cada archivo se agrega como una nueva fila abajo.</p>
          </div>
          <div className="uploader__right">
            <label className="btn btn--secondary">
              <input type="file" accept=".gpx" multiple className="hidden-input" onChange={onInputFiles} />
              Agregar más GPX
            </label>
          </div>
        </div>

        {sessions.length === 0 && <EmptyState />}

        <div className="sessionList">
          {sessions.map((s) => (
            <SessionBlock key={s.id} session={s} onChangeParams={updateParams} />
          ))}
        </div>
      </main>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="card card--dashed">
      <p className="empty__title">Subí un archivo <strong>.gpx</strong> para generar tu mapa de calor.</p>
      <p className="empty__hint">El mapa se renderiza localmente en tu navegador (sin subir datos a servidores).</p>
    </div>
  );
}

function SessionBlock({ session, onChangeParams }) {
  const { id, fileName, startTime, place, bounds, params, overlayUrl, stats, activityType, activityNote } = session;
  const title = `${formatDateTime(startTime)} · ${place || "Ubicación desconocida"} · ${fileName}`;
  const activityMeta = ACTIVITY_META[activityType] || { label: "Actividad", emoji: "❓", className: "unknown" };

  return (
    <details open className="card session">
      <summary className="session__summary">
        <div className="session__summaryLeft">
          <span className="session__title">{title}</span>
          <span className={`session__activityTag session__activityTag--${activityMeta.className}`}>
            <span className="session__activityIcon" aria-hidden>{activityMeta.emoji}</span>
            <span>{activityMeta.label}</span>
          </span>
        </div>
        <span className="session__chev">▼</span>
      </summary>

      <div className="session__content">
        <div className="controls">
          <div className={`activityCard activityCard--${activityMeta.className}`}>
            <div className="activityCard__header">Actividad estimada</div>
            <div className="activityCard__value">{activityMeta.emoji} {activityMeta.label}</div>
            {activityNote && <p className="activityCard__note">{activityNote}</p>}
            {stats && (
              <dl className="activityCard__metrics">
                <div>
                  <dt>Distancia total</dt>
                  <dd>{formatKilometers(stats.totalDistanceKm)}</dd>
                </div>
                <div>
                  <dt>Duración</dt>
                  <dd>{formatDuration(stats.totalDurationSec)}</dd>
                </div>
                <div>
                  <dt>Velocidad media</dt>
                  <dd>{formatSpeed(stats.avgSpeedKmh)}</dd>
                </div>
                <div>
                  <dt>Velocidad máx.</dt>
                  <dd>{formatSpeed(stats.maxSpeedKmh)}</dd>
                </div>
                <div>
                  <dt>Área recorrida</dt>
                  <dd>{formatSpan(stats.bboxWidthKm, stats.bboxHeightKm)}</dd>
                </div>
              </dl>
            )}
          </div>
          <ControlNumber label="Gamma" help="<1 realza intensos, >1 suaviza" min={0.3} max={1.8} step={0.05} value={params.gamma} onChange={(v) => onChangeParams(id, { gamma: v })} />
          <ControlNumber label="Sigma" help="Suavizado (px de la grilla)" min={2} max={30} step={1} value={params.sigma} onChange={(v) => onChangeParams(id, { sigma: v })} />
          <ControlNumber label="Threshold" help="Umbral mínimo visible" min={0} max={0.2} step={0.005} value={params.threshold} onChange={(v) => onChangeParams(id, { threshold: v })} />
          <ControlNumber label="Resolución" help="Ancho del raster (px)" min={400} max={1600} step={100} value={params.res} onChange={(v) => onChangeParams(id, { res: Math.round(v) })} />
          <p className="help">Consejo: si movés mucho los parámetros, subí la resolución para un borde más suave.</p>
        </div>
        <div className="mapWrap">
          <LeafletMap bounds={bounds} overlayUrl={overlayUrl} />
        </div>
      </div>
    </details>
  );
}

function ControlNumber({ label, help, value, onChange, min, max, step }) {
  return (
    <div className="control">
      <div className="control__row">
        <span className="control__label">{label}</span>
        <span className="control__value">{typeof value === "number" ? value.toFixed(3) : value}</span>
      </div>
      {help && <div className="control__help">{help}</div>}
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} className="slider" />
    </div>
  );
}

function LeafletMap({ bounds, overlayUrl }) {
  return (
    <MapContainer bounds={bounds} scrollWheelZoom style={{ height: 420, width: "100%" }} maxZoom={22}>
      <FitBoundsOnLoad bounds={bounds} />
      <LayersControl position="topright">
        <LayersControl.BaseLayer checked name="Mapa (OSM)">
          <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="© OpenStreetMap" maxZoom={22} />
        </LayersControl.BaseLayer>
        <LayersControl.BaseLayer name="Satélite (Esri)">
          <TileLayer url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}" attribution="Tiles © Esri" maxZoom={22} />
        </LayersControl.BaseLayer>
      </LayersControl>
      {overlayUrl && <ImageOverlay url={overlayUrl} bounds={bounds} opacity={1} />}
    </MapContainer>
  );
}

function FitBoundsOnLoad({ bounds }) {
  const map = useMap();
  useEffect(() => { if (bounds) map.fitBounds(bounds, { padding: [20, 20] }); }, [map, bounds]);
  return null;
}

// ===== GPX parsing & processing =====

const NOMINATIM_ENDPOINT = "https://nominatim.openstreetmap.org/reverse";
function keyForLatLon(lat, lon) { return `${lat.toFixed(5)},${lon.toFixed(5)}`; }

async function reverseGeocode(lat, lon) {
  const url = new URL(NOMINATIM_ENDPOINT);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lon));
  url.searchParams.set("zoom", "16");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("namedetails", "1");
  url.searchParams.set("accept-language", "es");
  const res = await fetch(url.toString(), { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("geocoding failed");
  const json = await res.json();
  return extractPlaceName(json) || json.display_name || null;
}

function extractPlaceName(json) {
  if (!json) return null;
  const name = json.name || json.namedetails?.name || null;
  const a = json.address || {};
  const primary = a.stadium || a.pitch || a.leisure || a.amenity || a.sports_centre || a.park;
  const locality = a.neighbourhood || a.suburb || a.village || a.town || a.city || a.municipality;
  const road = a.road || a.pedestrian || a.footway;
  return primary || name || (locality && road ? `${road}, ${locality}` : (locality || road || null));
}

function parseGPX(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const pts = Array.from(doc.getElementsByTagName("trkpt"))
    .map((el) => ({
      lat: parseFloat(el.getAttribute("lat") || "0"),
      lon: parseFloat(el.getAttribute("lon") || "0"),
      time: el.getElementsByTagName("time")[0]?.textContent || null,
    }))
    .filter((p) => isFinite(p.lat) && isFinite(p.lon));

  const startTime = pts.find((p) => p.time)?.time || doc.getElementsByTagName("time")[0]?.textContent || null;
  return { points: pts, startTime };
}

function computeTrackStats(points) {
  if (!points.length) {
    return {
      totalDistanceKm: 0,
      totalDurationSec: 0,
      avgSpeedKmh: 0,
      maxSpeedKmh: 0,
      bboxWidthKm: 0,
      bboxHeightKm: 0,
      bboxMaxSpanKm: 0,
      bboxDiagonalKm: 0,
      pointCount: 0,
    };
  }

  let totalDistanceKm = 0;
  let maxSpeedKmh = 0;
  let prevPoint = null;
  let prevTime = null;
  const timeSamples = [];

  let minLat = Infinity;
  let minLon = Infinity;
  let maxLat = -Infinity;
  let maxLon = -Infinity;

  for (const point of points) {
    const timeValue = point.time ? Date.parse(point.time) : NaN;
    if (Number.isFinite(timeValue)) {
      timeSamples.push(timeValue);
    }

    if (prevPoint) {
      const segmentKm = haversineDistance(prevPoint.lat, prevPoint.lon, point.lat, point.lon);
      totalDistanceKm += segmentKm;

      if (Number.isFinite(timeValue) && Number.isFinite(prevTime)) {
        const dtHours = (timeValue - prevTime) / 3_600_000;
        if (dtHours > 0) {
          const speed = segmentKm / dtHours;
          if (speed > maxSpeedKmh) maxSpeedKmh = speed;
        }
      }
    }

    prevPoint = point;
    prevTime = timeValue;

    if (point.lat < minLat) minLat = point.lat;
    if (point.lat > maxLat) maxLat = point.lat;
    if (point.lon < minLon) minLon = point.lon;
    if (point.lon > maxLon) maxLon = point.lon;
  }

  let totalDurationSec = 0;
  if (timeSamples.length >= 2) {
    const sorted = timeSamples.sort((a, b) => a - b);
    totalDurationSec = Math.max(0, (sorted[sorted.length - 1] - sorted[0]) / 1000);
  }

  const avgSpeedKmh = totalDurationSec > 0 ? (totalDistanceKm / (totalDurationSec / 3600)) : 0;

  const midLat = (minLat + maxLat) / 2;
  const midLon = (minLon + maxLon) / 2;
  const bboxWidthKm = haversineDistance(midLat, minLon, midLat, maxLon);
  const bboxHeightKm = haversineDistance(minLat, midLon, maxLat, midLon);
  const bboxDiagonalKm = haversineDistance(minLat, minLon, maxLat, maxLon);
  const bboxMaxSpanKm = Math.max(bboxWidthKm, bboxHeightKm);

  return {
    totalDistanceKm,
    totalDurationSec,
    avgSpeedKmh,
    maxSpeedKmh,
    bboxWidthKm,
    bboxHeightKm,
    bboxMaxSpanKm,
    bboxDiagonalKm,
    pointCount: points.length,
  };
}

/**
 * Clasifica la actividad con heurísticas simples:
 * - Fútbol: desplazamiento compacto (bounding box pequeño) y distancia corta.
 * - Bici: velocidades altas sostenidas o picos máximos elevados.
 * - Running: ritmos moderados con recorridos acotados.
 * En caso de duda, se cae en "running" como valor seguro para evitar falsos positivos.
 */
function classifyActivity(stats) {
  const span = stats.bboxMaxSpanKm;

  if (
    stats.totalDistanceKm <= ACTIVITY_HEURISTICS.futbol.maxDistanceKm &&
    span <= ACTIVITY_HEURISTICS.futbol.maxSpanKm
  ) {
    return "futbol";
  }

  if (
    stats.avgSpeedKmh >= ACTIVITY_HEURISTICS.bici.minAvgSpeedKmh ||
    stats.maxSpeedKmh >= ACTIVITY_HEURISTICS.bici.minMaxSpeedKmh
  ) {
    return "bici";
  }

  if (
    stats.avgSpeedKmh <= ACTIVITY_HEURISTICS.running.maxAvgSpeedKmh &&
    span <= ACTIVITY_HEURISTICS.running.maxSpanKm
  ) {
    return "running";
  }

  return "running";
}

// Etiqueta auxiliar para dejar constancia cuando los datos quedan cerca de los umbrales.
function deriveClassificationNote(stats, activityType) {
  const span = stats.bboxMaxSpanKm;
  if (
    activityType === "futbol" &&
    (stats.totalDistanceKm > ACTIVITY_HEURISTICS.futbol.maxDistanceKm * 0.85 ||
      span > ACTIVITY_HEURISTICS.futbol.maxSpanKm * 0.85)
  ) {
    return "Campo reducido detectado; podría ser fútbol u otra práctica corta.";
  }

  if (
    activityType === "bici" &&
    stats.avgSpeedKmh < ACTIVITY_HEURISTICS.bici.minAvgSpeedKmh &&
    stats.maxSpeedKmh < ACTIVITY_HEURISTICS.bici.minMaxSpeedKmh * 1.1
  ) {
    return "Velocidades al límite del umbral; revisar si es ciclismo suave o running rápido.";
  }

  if (
    activityType === "running" &&
    (stats.avgSpeedKmh > ACTIVITY_HEURISTICS.running.maxAvgSpeedKmh || span > ACTIVITY_HEURISTICS.running.maxSpanKm)
  ) {
    return "Sin clasificar con certeza (se muestra como running por defecto).";
  }

  return null;
}

function centerOfPoints(points) {
  const lat = points.reduce((a, p) => a + p.lat, 0) / points.length;
  const lon = points.reduce((a, p) => a + p.lon, 0) / points.length;
  return { lat, lon };
}

function boundsOfPoints(points, pad = 0) {
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  return [ [minLat - pad, minLon - pad], [maxLat + pad, maxLon + pad] ];
}

async function buildOverlay(points, bounds, params) {
  const [[minLat, minLon], [maxLat, maxLon]] = bounds;
  const W = params.res || 1000;
  const aspect = (maxLat - minLat) / (maxLon - minLon + 1e-12);
  const H = Math.max(10, Math.round(W * aspect));

  const grid = new Float32Array(W * H);
  const invDX = 1 / (maxLon - minLon + 1e-12);
  const invDY = 1 / (maxLat - minLat + 1e-12);
  for (const p of points) {
    const x = Math.floor(((p.lon - minLon) * invDX) * W);
    const y = Math.floor(((p.lat - minLat) * invDY) * H);
    if (x >= 0 && x < W && y >= 0 && y < H) {
      const yy = H - 1 - y; // norte arriba
      grid[yy * W + x] += 1;
    }
  }

  const { kernel, radius } = gaussianKernel1D(params.sigma || 7);
  const tmp = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const rowOff = y * W;
    for (let x = 0; x < W; x++) {
      let acc = 0; for (let k = -radius; k <= radius; k++) { const xx = clamp(x + k, 0, W - 1); acc += grid[rowOff + xx] * kernel[k + radius]; }
      tmp[rowOff + x] = acc;
    }
  }
  const smooth = new Float32Array(W * H);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      let acc = 0; for (let k = -radius; k <= radius; k++) { const yy = clamp(y + k, 0, H - 1); acc += tmp[yy * W + x] * kernel[k + radius]; }
      smooth[y * W + x] = acc;
    }
  }

  const p99 = percentileSampled(smooth, 0.99);
  const invP = 1 / (p99 + 1e-9);
  const gamma = params.gamma || 0.7;
  const threshold = params.threshold ?? 0.05;

  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(W, H);
  const data = img.data;

  for (let i = 0; i < smooth.length; i++) {
    let v = smooth[i] * invP; v = v < 0 ? 0 : v > 1 ? 1 : v; v = Math.pow(v, gamma);
    if (v <= threshold) { data[i * 4 + 3] = 0; continue; }
    const t = (v - threshold) / (1 - threshold);
    const { r, g, b } = redYellowGreenGradient(t);
    const alpha = 0.25 + 0.65 * t;
    data[i * 4 + 0] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = Math.round(alpha * 255);
  }

  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}

function gaussianKernel1D(sigma) {
  const s = Math.max(0.1, sigma);
  const radius = Math.max(1, Math.round(s * 3));
  const size = radius * 2 + 1;
  const kernel = new Float32Array(size);
  const inv = 1 / (2 * s * s);
  let sum = 0; for (let i = -radius; i <= radius; i++) { const v = Math.exp(-(i * i) * inv); kernel[i + radius] = v; sum += v; }
  for (let i = 0; i < size; i++) kernel[i] /= sum;
  return { kernel, radius };
}

function percentileSampled(arr, p) {
  const n = arr.length; const step = Math.max(1, Math.floor(n / 15000));
  const sample = []; for (let i = 0; i < n; i += step) sample.push(arr[i]);
  sample.sort((a, b) => a - b);
  const idx = Math.min(sample.length - 1, Math.max(0, Math.floor(p * (sample.length - 1))));
  return sample[idx] || 0;
}

function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
function hexToRgb(hex) { const h = hex.replace("#", ""); return { r: parseInt(h.slice(0,2),16), g: parseInt(h.slice(2,4),16), b: parseInt(h.slice(4,6),16) }; }
function lerp(a, b, t) { return a + (b - a) * t; }
function mix(c1, c2, t) { return { r: Math.round(lerp(c1.r, c2.r, t)), g: Math.round(lerp(c1.g, c2.g, t)), b: Math.round(lerp(c1.b, c2.b, t)) }; }

const EARTH_RADIUS_KM = 6371;

function haversineDistance(lat1, lon1, lat2, lon2) {
  const toRad = (v) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

function formatKilometers(km) {
  if (!Number.isFinite(km) || km <= 0) return "—";
  return `${km.toFixed(km < 10 ? 2 : 1)} km`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.round(seconds % 60);
  const parts = [];
  if (hrs) parts.push(`${hrs}h`);
  if (mins) parts.push(`${mins}m`);
  if (!hrs && !mins) parts.push(`${secs}s`);
  return parts.join(" ") || `${secs}s`;
}

function formatSpeed(kmh) {
  if (!Number.isFinite(kmh) || kmh <= 0) return "—";
  return `${kmh.toFixed(1)} km/h`;
}

function formatSpan(widthKm, heightKm) {
  if (!Number.isFinite(widthKm) || !Number.isFinite(heightKm) || (widthKm <= 0 && heightKm <= 0)) return "—";
  return `${widthKm.toFixed(2)} × ${heightKm.toFixed(2)} km`;
}

const C_GREEN = hexToRgb("#00A000");
const C_YELLOW = hexToRgb("#FFFF00");
const C_ORANGE = hexToRgb("#FFA500");
const C_RED = hexToRgb("#FF0000");

function redYellowGreenGradient(t) {
  const x = clamp(t, 0, 1);
  if (x <= 0.5) return mix(C_GREEN, C_YELLOW, x / 0.5);
  if (x <= 0.8) return mix(C_YELLOW, C_ORANGE, (x - 0.5) / 0.3);
  return mix(C_ORANGE, C_RED, (x - 0.8) / 0.2);
}

function formatDateTime(iso) {
  try {
    if (iso === null || typeof iso === "undefined" || (typeof iso === "string" && iso.trim() === "")) return "—";
    const d = new Date(iso);
    if (isNaN(d.getTime())) throw new Error("Invalid date");
    return d.toLocaleString();
  } catch { return typeof iso === "string" ? iso : "—"; }
}

// DEV tests activables con ?devtests=1
(function maybeRunDevTests() {
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get("devtests") === "1") runDevTests();
  } catch (err) {
    void err;
  }
})();

function runDevTests() {
  // formatDateTime
  const cases = [
    { in: "2024-08-01T12:34:56Z", expect: "valid" },
    { in: "not-a-date", expect: "fallback" },
    { in: null, expect: "fallback" },
    { in: undefined, expect: "fallback" },
    { in: "2025-02-30T10:00:00Z", expect: "fallback" },
    { in: 1690900000000, expect: "valid" },
    { in: "2024/08/01 12:34:56", expect: "valid" },
    { in: "", expect: "fallback" },
    { in: "   ", expect: "fallback" },
    { in: "1690900000000", expect: "valid" },
  ];
  const results = cases.map((c) => { const out = formatDateTime(c.in); const ok = c.expect === "valid" ? !!out && out !== "Invalid Date" : out !== "Invalid Date"; return { input: c.in, output: out, ok }; });
  // extractPlaceName
  const placeCases = [
    { json: { address: { stadium: "Estadio Municipal" } }, expect: "Estadio Municipal" },
    { json: { name: "Cancha 5" }, expect: "Cancha 5" },
    { json: { address: { road: "Av. Siempre Viva", city: "Springfield" } }, expect: "Av. Siempre Viva, Springfield" },
    { json: { address: { suburb: "Palermo" } }, expect: "Palermo" },
    { json: null, expect: null },
  ];
    const placeRes = placeCases.map((c) => ({ input: c.json, output: extractPlaceName(c.json), ok: extractPlaceName(c.json) === c.expect }));
    console.table(results);
    console.table(placeRes);
  }

function Style() {
  return (
    <style>{`
      :root { --bg:#f7f7f8; --fg:#111; --muted:#666; --line:#e5e7eb; --brand:#111; --card:#fff; }
      *{box-sizing:border-box} body,html,#root{height:100%}
      .app{min-height:100%; background:var(--bg); color:var(--fg);}
      .app__header{position:sticky; top:0; z-index:10; background:#ffffffcc; backdrop-filter:saturate(1.2) blur(4px); border-bottom:1px solid var(--line)}
      .app__header__inner{max-width:1080px; margin:0 auto; padding:12px 16px; display:flex; align-items:center; justify-content:space-between}
      .app__title{font-size:18px; font-weight:600}
      .btn{display:inline-flex; align-items:center; gap:8px; padding:10px 14px; border-radius:12px; background:var(--brand); color:#fff; cursor:pointer; border:1px solid #000;}
      .btn--secondary{background:#fff; color:#111; border-color:var(--line)}
      .hidden-input{display:none}
      .app__main{max-width:1080px; margin:0 auto; padding:16px}
      .uploader{display:flex; align-items:center; justify-content:space-between; background:var(--card); border:1px dashed var(--line); padding:14px; border-radius:16px;}
      .uploader__title{margin:0; font-weight:600}
      .uploader__hint{margin:4px 0 0; color:var(--muted); font-size:12px}
      .card{background:var(--card); border:1px solid var(--line); border-radius:16px;}
      .card--dashed{border-style:dashed; padding:24px; text-align:center}
      .empty__title{margin:0 0 6px; font-size:16px}
      .empty__hint{margin:0; color:var(--muted); font-size:13px}
      .sessionList{display:flex; flex-direction:column; gap:12px; margin-top:12px}
      .session__summary{display:flex; align-items:center; justify-content:space-between; cursor:pointer; padding:12px 14px; gap:8px}
      .session__summaryLeft{display:flex; flex-wrap:wrap; align-items:center; gap:8px; min-width:0}
      .session__title{font-weight:600; font-size:14px}
      .session__activityTag{display:inline-flex; align-items:center; gap:4px; padding:2px 8px; border-radius:999px; font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:0.03em}
      .session__activityIcon{font-size:14px}
      .session__activityTag--running{background:#e0f2fe; color:#0369a1}
      .session__activityTag--futbol{background:#ecfccb; color:#3f6212}
      .session__activityTag--bici{background:#fce7f3; color:#a21caf}
      .session__activityTag--unknown{background:#e5e7eb; color:#374151}
      .session__chev{color:var(--muted)}
      .session__content{display:grid; grid-template-columns: 1fr 1.2fr; gap:12px; padding:12px;}
      @media (max-width:900px){ .session__content{grid-template-columns:1fr} }
      .controls{display:flex; flex-direction:column; gap:10px}
      .activityCard{border:1px solid var(--line); border-radius:12px; padding:12px; background:#fafafa; display:flex; flex-direction:column; gap:8px}
      .activityCard__header{font-size:12px; text-transform:uppercase; letter-spacing:0.08em; color:var(--muted); margin:0}
      .activityCard__value{font-weight:700; font-size:18px}
      .activityCard--running{background:linear-gradient(135deg, #e0f2fe 0%, #ffffff 60%)}
      .activityCard--futbol{background:linear-gradient(135deg, #ecfccb 0%, #ffffff 60%)}
      .activityCard--bici{background:linear-gradient(135deg, #fce7f3 0%, #ffffff 60%)}
      .activityCard--unknown{background:#f5f5f5}
      .activityCard__note{margin:0; font-size:12px; color:#7f1d1d}
      .activityCard__metrics{margin:0; display:grid; gap:6px}
      .activityCard__metrics div{display:flex; justify-content:space-between; font-size:12px; color:#374151}
      .activityCard__metrics dt{margin:0; font-weight:600}
      .activityCard__metrics dd{margin:0; font-variant-numeric:tabular-nums}
      .control{border:1px solid var(--line); border-radius:12px; padding:10px}
      .control__row{display:flex; justify-content:space-between; align-items:center; margin-bottom:4px}
      .control__label{font-weight:600}
      .control__value{color:var(--muted); font-size:12px}
      .control__help{color:var(--muted); font-size:12px; margin-bottom:6px}
      .slider{width:100%}
      .help{color:var(--muted); font-size:12px}
      .mapWrap{border:1px solid var(--line); border-radius:12px; overflow:hidden}
    `}</style>
  );
}
