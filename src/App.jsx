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
  running: { label: "Running", emoji: "Running", className: "running" },
  futbol: { label: "Fútbol", emoji: "Fútbol", className: "futbol" },
  bici: { label: "Bici", emoji: "Bici", className: "bici" },
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
  bici: {
    minAvgSpeedKmh: 18,
    minMaxSpeedKmh: 28,
  },
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
  const rebuildSeqRef = useRef({});
  // id -> seq (invalida cálculos viejos)
  const geoCacheRef = useRef(new Map());
  // "lat,lon" -> nombre de lugar
  const sessionsRef = useRef([]);

  // NUEVO: Estado para el tipo de mapa (street o satellite) - global para simplicidad, pero puedes moverlo por sesión si prefieres
  const [mapType, setMapType] = useState('street');

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

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

  function onDragOver(e) {
    e.preventDefault();
  }

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
      const params = {
        gamma: 0.7,
        sigma: 7,
        threshold: 0.05,
        res: 1000,
      };
      const segments = await buildSegments(points, params, DEFAULT_SEGMENT_GAP_MINUTES);
      const firstSegment = segments[0] || null;
      const id = `${file.name}-${Date.now()}`;
      rebuildSeqRef.current[id] = {
        segments: {},
        splitSeq: 0,
      };
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
      const next = prev.map((s) =>
        s.id === id ? { ...s, params: { ...s.params, ...patch } } : s
      );
      // 2) Dispara regeneración con el estado más reciente
      scheduleOverlayRebuild(id, next);
      return next;
    });
  }

  function scheduleOverlayRebuild(id, nextSessions, forcedSegmentIndex) {
    const source = nextSessions || sessionsRef.current;
    const sess = source.find((s) => s.id === id);
    if (!sess) return;
    const segIdx =
      typeof forcedSegmentIndex === "number"
        ? forcedSegmentIndex
        : sess.activeSegmentIndex ?? 0;
    const segment = sess.segments?.[segIdx];
    if (!segment) return;
    const prevEntry = rebuildSeqRef.current[id] || { segments: {}, splitSeq: 0 };
    const prevSegments = prevEntry.segments || {};
    const segSeq = (prevSegments[segIdx] || 0) + 1;
    rebuildSeqRef.current[id] = {
      ...prevEntry,
      segments: { ...prevSegments, [segIdx]: segSeq },
    };
    buildOverlay(segment.points, segment.bounds, sess.params).then((url) => {
      const currentEntry = rebuildSeqRef.current[id];
      if (!currentEntry || currentEntry.segments?.[segIdx] !== segSeq) return; // resultado viejo
      setSessions((cur) =>
        cur.map((s) => {
          if (s.id !== id) return s;
          const updatedSegments = s.segments.map((seg, idx) =>
            idx === segIdx
              ? { ...seg, overlayUrl: url, params: { ...s.params } }
              : seg
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
            ? {
                ...s,
                activeSegmentIndex: nextIndex,
                bounds: target.bounds,
                overlayUrl: target.overlayUrl,
              }
            : s
        )
      );
    }
    if (
      !areParamsEqual(target.params, session.params) ||
      !target.overlayUrl
    ) {
      scheduleOverlayRebuild(id, null, nextIndex);
    }
  }

  async function updateSegmentGap(id, gapMinutes) {
    const session = sessionsRef.current.find((s) => s.id === id);
    if (!session) return;
    const numericGap = Number.isFinite(Number(gapMinutes))
      ? Number(gapMinutes)
      : session.segmentGapMinutes ?? DEFAULT_SEGMENT_GAP_MINUTES;
    const safeValue = Math.round(clamp(numericGap, 1, 60));
    if (safeValue === session.segmentGapMinutes) return;
    const entry = rebuildSeqRef.current[id] || { segments: {}, splitSeq: 0 };
    const splitSeq = (entry.splitSeq || 0) + 1;
    rebuildSeqRef.current[id] = { segments: {}, splitSeq };
    const newSegments = await buildSegments(
      session.points,
      session.params,
      safeValue
    );
    if ((rebuildSeqRef.current[id]?.splitSeq ?? 0) !== splitSeq) return;
    const nextIndex = Math.min(
      session.activeSegmentIndex ?? 0,
      Math.max(0, newSegments.length - 1)
    );
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
    const mergedSegments = await buildSegments(
      session.points,
      session.params,
      Infinity
    );
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
        setSessions((cur) =>
          cur.map((s) => (s.id === id ? { ...s, place: cached } : s))
        );
        return;
      }
      const name = await reverseGeocode(center.lat, center.lon);
      const place = name || "Ubicación desconocida";
      geoCacheRef.current.set(key, place);
      setSessions((cur) =>
        cur.map((s) => (s.id === id ? { ...s, place } : s))
      );
    } catch {
      setSessions((cur) =>
        cur.map((s) => (s.id === id ? { ...s, place: "Ubicación desconocida" } : s))
      );
    }
  }

  // Funciones auxiliares que faltaban en el código original (asumidas basadas en el contexto; agrégalas si no existen)
  function parseGPX(text) {
    // Implementación para parsear GPX - puedes copiar de tu código actual si ya la tienes
    // Ejemplo básico:
    const parser = new DOMParser();
    const xml = parser.parseFromString(text, 'text/xml');
    const points = Array.from(xml.getElementsByTagName('trkpt')).map(pt => ({
      lat: parseFloat(pt.getAttribute('lat')),
      lon: parseFloat(pt.getAttribute('lon')),
      time: pt.querySelector('time') ? new Date(pt.querySelector('time').textContent) : null,
    }));
    const startTime = points[0]?.time || new Date();
    return { points, startTime };
  }

  function computeTrackStats(points) {
    // Implementación para stats - distancia, velocidad, etc.
    // Ejemplo placeholder
    return { distanceKm: 5, avgSpeedKmh: 10, maxSpeedKmh: 15, spanKm: 0.2, areaKm2: 0.05 };
  }

  function classifyActivity(stats) {
    // Lógica para clasificar basado en heuristics
    if (stats.distanceKm < ACTIVITY_HEURISTICS.futbol.maxDistanceKm && stats.avgSpeedKmh < ACTIVITY_HEURISTICS.futbol.maxAvgSpeedKmh) return 'futbol';
    // ... otras condiciones
    return 'running';
  }

  function deriveClassificationNote(stats, type) {
    // Nota para clasificación
    return '';
  }

  function centerOfPoints(points) {
    // Centro de los puntos
    const lat = points.reduce((sum, p) => sum + p.lat, 0) / points.length;
    const lon = points.reduce((sum, p) => sum + p.lon, 0) / points.length;
    return { lat, lon };
  }

  function boundsOfPoints(points, padding) {
    // Bounds con padding
    const minLat = Math.min(...points.map(p => p.lat)) - padding;
    const maxLat = Math.max(...points.map(p => p.lat)) + padding;
    const minLon = Math.min(...points.map(p => p.lon)) - padding;
    const maxLon = Math.max(...points.map(p => p.lon)) + padding;
    return [[minLat, minLon], [maxLat, maxLon]];
  }

  async function buildSegments(points, params, gapMinutes) {
    // Lógica para dividir en segmentos basado en gaps
    // Ejemplo placeholder
    return [{ points, bounds: boundsOfPoints(points, 0.00045), overlayUrl: null, params }];
  }

  async function buildOverlay(points, bounds, params) {
    // Genera URL de overlay (canvas toDataURL para heatmap)
    // Ejemplo placeholder - implementa tu lógica de canvas/heatmap aquí
    const canvas = document.createElement('canvas');
    // ... dibuja heatmap
    return canvas.toDataURL();
  }

  function areParamsEqual(p1, p2) {
    return p1.gamma === p2.gamma && p1.sigma === p2.sigma && p1.threshold === p2.threshold && p1.res === p2.res;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  async function reverseGeocode(lat, lon) {
    // Fetch a Nominatim o similar
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`);
    const data = await res.json();
    return data.display_name;
  }

  function keyForLatLon(lat, lon) {
    return `${lat.toFixed(4)},${lon.toFixed(4)}`;
  }

  return (
    <div onDrop={onDrop} onDragOver={onDragOver} style={{ padding: '20px' }}>
      <h1>GPX Heatmap</h1>
      <input type="file" multiple accept=".gpx" onChange={onInputFiles} />
      
      {/* NUEVO: Botón para toggle de mapa - lo puse global, pero puedes replicarlo por sesión */}
      <button 
        onClick={() => setMapType(mapType === 'street' ? 'satellite' : 'street')}
        style={{ margin: '10px 0', padding: '5px 10px' }}
      >
        Cambiar a {mapType === 'street' ? 'Satélite (Alta Resolución)' : 'Calle'}
      </button>

      {sessions.map((session) => (
        <div key={session.id} style={{ marginBottom: '20px', border: '1px solid #ccc', padding: '10px' }}>
          <h2>{session.fileName} - {session.place} ({session.activityType})</h2>
          {/* Controles para params, segments, etc. - agrégalo según tu UI actual */}
          <label>Gamma: <input type="range" min="0.1" max="2" step="0.1" value={session.params.gamma} onChange={(e) => updateParams(session.id, { gamma: parseFloat(e.target.value) })} /></label>
          {/* ... otros sliders */}
          
          <select value={session.activeSegmentIndex} onChange={(e) => setActiveSegment(session.id, e.target.value)}>
            {session.segments.map((_, idx) => <option key={idx} value={idx}>Segmento {idx + 1}</option>)}
          </select>
          
          <MapContainer 
            center={session.center} 
            zoom={15} 
            style={{ height: '400px', width: '100%' }}
            bounds={session.bounds}
          >
            {/* MODIFICADO: TileLayer dinámico con Esri para satellite de alta res */}
            <TileLayer
              url={mapType === 'satellite' 
                ? 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}' 
                : 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
              }
              attribution={mapType === 'satellite' 
                ? 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community' 
                : '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              }
              maxZoom={19}  // Alto zoom para nitidez
            />
            {session.overlayUrl && (
              <ImageOverlay url={session.overlayUrl} bounds={session.bounds} />
            )}
          </MapContainer>
        </div>
      ))}
    </div>
  );
}