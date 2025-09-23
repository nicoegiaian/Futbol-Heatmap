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
  futbol: {
    maxDistanceKm: 9,
    maxAvgSpeedKmh: 11,
    maxSpanKm: 0.35,
    compactSpanKm: 0.28,
    maxAreaKm2: 0.08,
  },
  bici: { minAvgSpeedKmh: 18, minMaxSpeedKmh: 28 },
  running: {
    minDistanceKm: 3,
    maxSpanKm: 3,
    minAvgSpeedKmh: 7,
    maxAvgSpeedKmh: 16,
  },

};

const DEFAULT_SEGMENT_GAP_MINUTES = 5;
const INACTIVITY_SPEED_THRESHOLD_KMH = 1;

export default function App() {
  const [sessions, setSessions] = useState([]);
  const rebuildSeqRef = useRef({}); // id -> seq (invalida cálculos viejos)
  const geoCacheRef = useRef(new Map()); // "lat,lon" -> nombre de lugar
  const sessionsRef = useRef([]);
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);

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
      const overallBounds = boundsOfPoints(points, 0.00045);

      const params = { gamma: 0.7, sigma: 7, threshold: 0.05, res: 1000 };
      const segments = await buildSegments(points, params, DEFAULT_SEGMENT_GAP_MINUTES);
      const firstSegment = segments[0] || null;

      const id = `${file.name}-${Date.now()}`;
      rebuildSeqRef.current[id] = { segments: {}, splitSeq: 0 };
      setSessions((prev) => [
        {
          id,
          fileName: file.name,
          startTime,
          center,
          bounds: firstSegment?.bounds || overallBounds,
          params,
          points,
          overlayUrl: firstSegment?.overlayUrl || null,
          place: "Buscando lugar…",
          stats,
          activityType,
          activityNote,
          segments,
          activeSegmentIndex: 0,
          segmentGapMinutes: DEFAULT_SEGMENT_GAP_MINUTES,
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

  function scheduleOverlayRebuild(id, nextSessions, forcedSegmentIndex) {
    const source = nextSessions || sessionsRef.current;
    const sess = source.find((s) => s.id === id);
    if (!sess) return;
    const segIdx = typeof forcedSegmentIndex === "number" ? forcedSegmentIndex : (sess.activeSegmentIndex ?? 0);
    const segment = sess.segments?.[segIdx];
    if (!segment) return;

    const prevEntry = rebuildSeqRef.current[id] || { segments: {}, splitSeq: 0 };
    const prevSegments = prevEntry.segments || {};
    const segSeq = (prevSegments[segIdx] || 0) + 1;
    rebuildSeqRef.current[id] = { ...prevEntry, segments: { ...prevSegments, [segIdx]: segSeq } };

    buildOverlay(segment.points, segment.bounds, sess.params).then((url) => {
      const currentEntry = rebuildSeqRef.current[id];
      if (!currentEntry || currentEntry.segments?.[segIdx] !== segSeq) return; // resultado viejo
      setSessions((cur) =>
        cur.map((s) => {
          if (s.id !== id) return s;
          const updatedSegments = s.segments.map((seg, idx) =>
            idx === segIdx ? { ...seg, overlayUrl: url, params: { ...s.params } } : seg
          );
          const patch = { segments: updatedSegments };
          if (segIdx === s.activeSegmentIndex) {
            patch.overlayUrl = url;
            patch.bounds = updatedSegments[segIdx].bounds;
          }
          return { ...s, ...patch };
        })
      );
    });
  }

  function setActiveSegment(id, index) {
    const session = sessionsRef.current.find((s) => s.id === id);
    if (!session) return;
    const segCount = session.segments?.length || 0;
    if (segCount === 0) return;
    const nextIndex = clamp(Number(index), 0, Math.max(0, segCount - 1));
    const target = session.segments[nextIndex];
    if (!target) return;
    if (
      session.activeSegmentIndex !== nextIndex ||
      session.bounds !== target.bounds ||
      session.overlayUrl !== target.overlayUrl
    ) {
      setSessions((prev) =>
        prev.map((s) =>
          s.id === id
            ? { ...s, activeSegmentIndex: nextIndex, bounds: target.bounds, overlayUrl: target.overlayUrl }
            : s
        )
      );
    }
    if (!areParamsEqual(target.params, session.params) || !target.overlayUrl) {
      scheduleOverlayRebuild(id, null, nextIndex);
    }
  }

  async function updateSegmentGap(id, gapMinutes) {
    const session = sessionsRef.current.find((s) => s.id === id);
    if (!session) return;
    const numericGap = Number.isFinite(Number(gapMinutes)) ? Number(gapMinutes) : (session.segmentGapMinutes ?? DEFAULT_SEGMENT_GAP_MINUTES);
    const safeValue = Math.round(clamp(numericGap, 1, 60));
    if (safeValue === session.segmentGapMinutes) return;
    const entry = rebuildSeqRef.current[id] || { segments: {}, splitSeq: 0 };
    const splitSeq = (entry.splitSeq || 0) + 1;
    rebuildSeqRef.current[id] = { segments: {}, splitSeq };
    const newSegments = await buildSegments(session.points, session.params, safeValue);
    if ((rebuildSeqRef.current[id]?.splitSeq ?? 0) !== splitSeq) return;
    const nextIndex = Math.min(session.activeSegmentIndex ?? 0, Math.max(0, newSegments.length - 1));
    const activeSegment = newSegments[nextIndex] || null;
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== id) return s;
        return {
          ...s,
          segmentGapMinutes: safeValue,
          segments: newSegments,
          activeSegmentIndex: nextIndex,
          bounds: activeSegment?.bounds || s.bounds,
          overlayUrl: activeSegment?.overlayUrl || null,
        };
      })
    );
  }

  async function mergeSegments(id) {
    const session = sessionsRef.current.find((s) => s.id === id);
    if (!session) return;
    const entry = rebuildSeqRef.current[id] || { segments: {}, splitSeq: 0 };
    const splitSeq = (entry.splitSeq || 0) + 1;
    rebuildSeqRef.current[id] = { segments: {}, splitSeq };
    const mergedSegments = await buildSegments(session.points, session.params, Infinity);
    if ((rebuildSeqRef.current[id]?.splitSeq ?? 0) !== splitSeq) return;
    const activeSegment = mergedSegments[0] || null;
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== id) return s;
        return {
          ...s,
          segments: mergedSegments,
          activeSegmentIndex: 0,
          bounds: activeSegment?.bounds || s.bounds,
          overlayUrl: activeSegment?.overlayUrl || null,
        };
      })
    );
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
            <SessionBlock
              key={s.id}
              session={s}
              onChangeParams={updateParams}
              onSelectSegment={setActiveSegment}
              onChangeGap={updateSegmentGap}
              onMergeSegments={mergeSegments}
            />
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

function SessionBlock({ session, onChangeParams, onSelectSegment, onChangeGap, onMergeSegments }) {
  const {
    id,
    fileName,
    startTime,
    place,
    bounds,
    params,
    overlayUrl,
    stats,
    activityType,
    activityNote,
    segments = [],
    activeSegmentIndex = 0,
    segmentGapMinutes = DEFAULT_SEGMENT_GAP_MINUTES,
  } = session;
  const title = `${formatDateTime(startTime)} · ${place || "Ubicación desconocida"} · ${fileName}`;
  const activityMeta = ACTIVITY_META[activityType] || { label: "Actividad", emoji: "❓", className: "unknown" };
  const segmentCount = segments.length || 0;
  const activeSegment = segments[activeSegmentIndex] || segments[0] || null;
  const mapBounds = activeSegment?.bounds || bounds;
  const mapOverlayUrl = activeSegment?.overlayUrl || overlayUrl;
  const segmentLabel = segmentCount > 1 ? `${segmentCount} segmentos detectados` : "Sin cortes detectados";

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
          <div className="segmentSelector">
            <div className="segmentSelector__info">
              <div className="segmentSelector__label">Segmentos</div>
              <div className="segmentSelector__meta">{segmentLabel}</div>
            </div>
            {segmentCount > 1 ? (
              <select
                className="segmentSelector__select"
                value={activeSegmentIndex}
                onChange={(e) => onSelectSegment(id, Number(e.target.value))}
              >
                {segments.map((_, idx) => (
                  <option key={idx} value={idx}>{`${idx + 1}ª parte`}</option>
                ))}
              </select>
            ) : (
              <span className="segmentSelector__single">Recorrido completo</span>
            )}
            <button
              type="button"
              className="segmentSelector__merge"
              onClick={() => onMergeSegments(id)}
              disabled={segmentCount <= 1}
              title={segmentCount <= 1 ? "No hay cortes que fusionar" : "Combina todos los tramos en uno solo"}
            >
              Fusionar segmentos
            </button>
          </div>
          <ControlNumber
            label="Corte (min inactivo)"
            help="Umbral para detectar cortes largos sin actividad."
            min={1}
            max={60}
            step={1}
            value={segmentGapMinutes}
            onChange={(v) => onChangeGap(id, Math.round(v))}
          />
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
                  <dd>{formatSpan(stats.trimmedWidthKm || stats.bboxWidthKm, stats.trimmedHeightKm || stats.bboxHeightKm)}</dd>

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
          <LeafletMap bounds={mapBounds} overlayUrl={mapOverlayUrl} />
        </div>
      </div>
    </details>
  );
}

function ControlNumber({ label, help, value, onChange, min, max, step }) {
  const decimals = typeof step === "number" ? (step >= 1 ? 0 : step >= 0.1 ? 1 : 3) : 3;
  const displayValue = typeof value === "number" ? value.toFixed(decimals) : value;
  return (
    <div className="control">
      <div className="control__row">
        <span className="control__label">{label}</span>
        <span className="control__value">{displayValue}</span>
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

function splitTrack(points, gapMinutes = DEFAULT_SEGMENT_GAP_MINUTES) {
  if (!Array.isArray(points) || points.length === 0) return [];
  const normalizedGap = Number.isFinite(gapMinutes) && gapMinutes > 0 ? gapMinutes : Infinity;
  const inactivitySeconds = normalizedGap * 60;
  const segments = [];

  let segmentStartIdx = 0;
  let inactivityStartIdx = null;
  let inactivityAccumSec = 0;
  let inactivityQualified = false;

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];

    const prevTime = prev.time ? Date.parse(prev.time) : NaN;
    const currTime = curr.time ? Date.parse(curr.time) : NaN;
    const hasTime = Number.isFinite(prevTime) && Number.isFinite(currTime);
    const deltaSec = hasTime ? (currTime - prevTime) / 1000 : NaN;

    if (!hasTime || !Number.isFinite(deltaSec) || deltaSec <= 0) {
      if (deltaSec < 0 && i > segmentStartIdx) {
        const seg = points.slice(segmentStartIdx, i);
        if (seg.length) segments.push(seg);
        segmentStartIdx = i;
      }
      inactivityStartIdx = null;
      inactivityAccumSec = 0;
      inactivityQualified = false;
      continue;
    }

    const distanceKm = haversineDistance(prev.lat, prev.lon, curr.lat, curr.lon);
    const deltaHours = deltaSec / 3600;
    const speedKmh = deltaHours > 0 ? distanceKm / deltaHours : Infinity;
    const isInactiveStep = speedKmh <= INACTIVITY_SPEED_THRESHOLD_KMH;

    if (isInactiveStep) {
      if (inactivityStartIdx === null) {
        inactivityStartIdx = i - 1;
        inactivityAccumSec = deltaSec;
      } else {
        inactivityAccumSec += deltaSec;
      }
      if (!inactivityQualified && inactivityAccumSec >= inactivitySeconds) {
        inactivityQualified = true;
      }
    } else {
      if (inactivityQualified && inactivityStartIdx !== null) {
        const breakStart = inactivityStartIdx;
        const breakEnd = i;
        if (breakStart > segmentStartIdx) {
          const seg = points.slice(segmentStartIdx, breakStart + 1);
          if (seg.length) segments.push(seg);
        }
        segmentStartIdx = breakEnd;
      }
      inactivityStartIdx = null;
      inactivityAccumSec = 0;
      inactivityQualified = false;
    }
  }

  if (inactivityQualified && inactivityStartIdx !== null) {
    if (inactivityStartIdx > segmentStartIdx) {
      const seg = points.slice(segmentStartIdx, inactivityStartIdx + 1);
      if (seg.length) segments.push(seg);
    }
  } else if (segmentStartIdx < points.length) {
    const seg = points.slice(segmentStartIdx);
    if (seg.length) segments.push(seg);
  }

  return segments.length ? segments : [points];
}

async function buildSegments(points, params, gapMinutes) {
  const groups = splitTrack(points, gapMinutes);
  if (!groups.length) return [];
  const segments = await Promise.all(
    groups.map(async (segmentPoints) => {
      const segBounds = boundsOfPoints(segmentPoints, 0.00045);
      const overlayUrl = await buildOverlay(segmentPoints, segBounds, params);
      return {
        points: segmentPoints,
        bounds: segBounds,
        overlayUrl,
        params: { ...params },
      };
    })
  );
  return segments;
}

function areParamsEqual(a, b) {
  if (!a || !b) return false;
  const keys = ["gamma", "sigma", "threshold", "res"];
  return keys.every((key) => (a[key] ?? null) === (b[key] ?? null));
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
      bboxAreaKm2: 0,
      trimmedWidthKm: 0,
      trimmedHeightKm: 0,
      trimmedMaxSpanKm: 0,
      trimmedAreaKm2: 0,

      pointCount: 0,
    };
  }

  let totalDistanceKm = 0;
  let maxSpeedKmh = 0;
  let prevPoint = null;
  let prevTime = null;
  const timeSamples = [];
  const latSamples = [];
  const lonSamples = [];


  let minLat = Infinity;
  let minLon = Infinity;
  let maxLat = -Infinity;
  let maxLon = -Infinity;

  for (const point of points) {
    const timeValue = point.time ? Date.parse(point.time) : NaN;
    if (Number.isFinite(timeValue)) {
      timeSamples.push(timeValue);
    }

    latSamples.push(point.lat);
    lonSamples.push(point.lon);


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
  const bboxAreaKm2 = bboxWidthKm * bboxHeightKm;

  let trimmedWidthKm = bboxWidthKm;
  let trimmedHeightKm = bboxHeightKm;
  let trimmedMaxSpanKm = bboxMaxSpanKm;
  let trimmedAreaKm2 = bboxAreaKm2;

  if (latSamples.length >= 5 && lonSamples.length >= 5) {
    const sortedLat = [...latSamples].sort((a, b) => a - b);
    const sortedLon = [...lonSamples].sort((a, b) => a - b);
    const latLo = quantile(sortedLat, 0.02);
    const latHi = quantile(sortedLat, 0.98);
    const lonLo = quantile(sortedLon, 0.02);
    const lonHi = quantile(sortedLon, 0.98);
    const trimMidLat = (latLo + latHi) / 2;
    const trimMidLon = (lonLo + lonHi) / 2;
    trimmedWidthKm = haversineDistance(trimMidLat, lonLo, trimMidLat, lonHi);
    trimmedHeightKm = haversineDistance(latLo, trimMidLon, latHi, trimMidLon);
    trimmedMaxSpanKm = Math.max(trimmedWidthKm, trimmedHeightKm);
    trimmedAreaKm2 = trimmedWidthKm * trimmedHeightKm;
  }


  return {
    totalDistanceKm,
    totalDurationSec,
    avgSpeedKmh,
    maxSpeedKmh,
    bboxWidthKm,
    bboxHeightKm,
    bboxMaxSpanKm,
    bboxDiagonalKm,
    bboxAreaKm2,
    trimmedWidthKm,
    trimmedHeightKm,
    trimmedMaxSpanKm,
    trimmedAreaKm2,

    pointCount: points.length,
  };
}

/**
 * Clasifica la actividad ponderando múltiples indicios en lugar de usar un único corte.
 * Cada disciplina suma puntos según distancia, área cubierta y velocidades típicas.
 * Se elige la puntuación más alta, privilegiando Fútbol sobre Running en empates
 * para no degradar partidos compactos como "running".
 */
function classifyActivity(stats) {
  const { futbol, bici, running } = ACTIVITY_HEURISTICS;
  const span = stats.trimmedMaxSpanKm || stats.bboxMaxSpanKm;
  const area = stats.trimmedAreaKm2 || stats.bboxAreaKm2;

  const scores = { futbol: 0, running: 0, bici: 0 };

  // Bici: velocidades altas o picos importantes.
  if (stats.avgSpeedKmh >= bici.minAvgSpeedKmh) scores.bici += 3;
  if (stats.maxSpeedKmh >= bici.minMaxSpeedKmh) scores.bici += 2;
  if (stats.totalDistanceKm >= running.minDistanceKm * 4) scores.bici += 1; // recorridos largos

  // Fútbol: área compacta, distancias cortas y velocidades contenidas.
  if (span <= futbol.maxSpanKm) scores.futbol += 1;
  if (span <= futbol.compactSpanKm) scores.futbol += 2;
  if (area <= futbol.maxAreaKm2) scores.futbol += 2;
  if (stats.totalDistanceKm <= futbol.maxDistanceKm) scores.futbol += 2;
  if (stats.avgSpeedKmh <= futbol.maxAvgSpeedKmh) scores.futbol += 2;

  // Running: distancias medias y ritmos moderados.
  if (stats.totalDistanceKm >= running.minDistanceKm) scores.running += 1;
  if (span <= running.maxSpanKm) scores.running += 1;
  if (stats.avgSpeedKmh >= running.minAvgSpeedKmh && stats.avgSpeedKmh <= running.maxAvgSpeedKmh) {
    scores.running += 2;
  } else if (stats.avgSpeedKmh > running.maxAvgSpeedKmh) {
    scores.bici += 1;
  } else {
    scores.futbol += 1;
  }

  const ordered = Object.entries(scores).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    const priority = { bici: 3, futbol: 2, running: 1 };
    return priority[b[0]] - priority[a[0]];
  });

  const [bestType, bestScore] = ordered[0];
  return bestScore <= 0 ? "running" : bestType;

}

// Etiqueta auxiliar para dejar constancia cuando los datos quedan cerca de los umbrales.
function deriveClassificationNote(stats, activityType) {
  const { futbol, bici, running } = ACTIVITY_HEURISTICS;
  const span = stats.trimmedMaxSpanKm || stats.bboxMaxSpanKm;
  const area = stats.trimmedAreaKm2 || stats.bboxAreaKm2;

  if (activityType === "futbol") {
    const nearDistance = stats.totalDistanceKm > futbol.maxDistanceKm * 0.95;
    const nearSpan = span > futbol.compactSpanKm * 1.1;
    const nearArea = area > futbol.maxAreaKm2 * 1.15;
    if (nearDistance || nearSpan || nearArea) {
      return "Partido compacto detectado, aunque roza los límites típicos de una cancha.";
    }

  }

  if (
    activityType === "bici" &&
    stats.avgSpeedKmh < bici.minAvgSpeedKmh * 1.05 &&
    stats.maxSpeedKmh < bici.minMaxSpeedKmh * 1.05
  ) {
    return "Velocidades justas para bici; revisá si fue running rápido o un tramo en bajada.";
  }

  if (activityType === "running") {
    if (span <= futbol.maxSpanKm * 1.1 && stats.avgSpeedKmh <= running.minAvgSpeedKmh * 0.95) {
      return "Área y ritmos chicos: podrías etiquetarlo como fútbol recreativo si corresponde.";
    }
    if (stats.avgSpeedKmh >= bici.minAvgSpeedKmh * 0.95) {
      return "Ritmo muy alto; si era bici suave, ajustá los umbrales.";
    }

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

function quantile(sortedValues, q) {
  if (!sortedValues.length) return NaN;
  const clampedQ = clamp(q, 0, 1);
  const pos = (sortedValues.length - 1) * clampedQ;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sortedValues[Math.min(base + 1, sortedValues.length - 1)];
  const current = sortedValues[base];
  return current + (next - current) * rest;
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
      @media (max-width:900px){
        .session__content{grid-template-columns:1fr}
        .segmentSelector{flex-direction:column; align-items:stretch;}
        .segmentSelector__merge{width:100%;}
      }
      .controls{display:flex; flex-direction:column; gap:10px}
      .segmentSelector{display:flex; flex-wrap:wrap; align-items:center; gap:8px; border:1px solid var(--line); border-radius:12px; padding:10px; background:#fff;}
      .segmentSelector__info{flex:1 1 160px; display:flex; flex-direction:column; gap:2px;}
      .segmentSelector__label{font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.08em; color:var(--muted);}
      .segmentSelector__meta{font-size:12px; color:var(--muted);}
      .segmentSelector__select{flex:1 1 150px; border:1px solid var(--line); border-radius:8px; padding:6px 10px; background:#fff; font-size:13px;}
      .segmentSelector__single{font-size:13px; color:var(--muted);}
      .segmentSelector__merge{flex:0 0 auto; display:inline-flex; align-items:center; justify-content:center; gap:4px; padding:6px 12px; border-radius:10px; border:1px solid var(--line); background:#fff; color:var(--fg); cursor:pointer; font-size:12px; font-weight:500;}
      .segmentSelector__merge:hover{background:#f4f4f5;}
      .segmentSelector__merge:disabled{cursor:default; opacity:0.6; background:#fafafa;}
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
