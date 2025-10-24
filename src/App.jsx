import React, { useEffect, useRef, useState } from "react";
import {
  MapContainer,
  TileLayer,
  ImageOverlay,
  LayersControl,
  useMap,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";
import {
  computeTrackStats,
  classifyActivity,
  deriveClassificationNote,
  centerOfPoints,
  boundsOfPoints,
  buildOverlay,
  parseGPX,
  buildSegments,
  clamp,
  areParamsEqual,
  reverseGeocode,
  keyForLatLon,
} from "./utils.js";

const ACTIVITY_META = {
  running: { label: "Running", emoji: "🏃", className: "running" },
  futbol: { label: "Fútbol", emoji: "⚽", className: "futbol" },
  bici: { label: "Bici", emoji: "🚴", className: "bici" },
};

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

  // NUEVO: Estado para toggle de mapa (global, por simplicidad)
  const [mapType, setMapType] = useState("street");

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

  return (
    <div onDrop={onDrop} onDragOver={onDragOver} style={{ padding: "20px" }}>
      <h1>GPX Heatmap</h1>
      <input type="file" multiple accept=".gpx" onChange={onInputFiles} />
      
      {/* NUEVO: Botón para toggle entre calle y satélite */}
      <button
        onClick={() => setMapType(mapType === "street" ? "satellite" : "street")}
        style={{ margin: "10px 0", padding: "5px 10px" }}
      >
        Cambiar a {mapType === "street" ? "Satélite (Alta Resolución)" : "Calle"}
      </button>

      {sessions.map((session) => (
        <details key={session.id} open>
          <summary style={{ cursor: "pointer" }}>
            {new Date(session.startTime).toLocaleString()} ·{" "}
            {session.place} · {session.fileName} ·{" "}
            <span className={ACTIVITY_META[session.activityType].className}>
              {ACTIVITY_META[session.activityType].emoji}{" "}
              {ACTIVITY_META[session.activityType].label}
            </span>
            {session.activityNote ? ` (${session.activityNote})` : ""}
          </summary>
          <div style={{ margin: "10px 0" }}>
            <label>
              Gamma{" "}
              <input
                type="range"
                min="0.1"
                max="2"
                step="0.1"
                value={session.params.gamma}
                onChange={(e) =>
                  updateParams(session.id, { gamma: parseFloat(e.target.value) })
                }
              />
              <span>{session.params.gamma.toFixed(1)}</span>
            </label>{" "}
            <label>
              Sigma{" "}
              <input
                type="range"
                min="1"
                max="50"
                step="1"
                value={session.params.sigma}
                onChange={(e) =>
                  updateParams(session.id, { sigma: parseFloat(e.target.value) })
                }
              />
              <span>{session.params.sigma.toFixed(0)}</span>
            </label>{" "}
            <label>
              Threshold{" "}
              <input
                type="range"
                min="0"
                max="0.5"
                step="0.01"
                value={session.params.threshold}
                onChange={(e) =>
                  updateParams(session.id, {
                    threshold: parseFloat(e.target.value),
                  })
                }
              />
              <span>{session.params.threshold.toFixed(2)}</span>
            </label>{" "}
            <label>
              Resolución{" "}
              <input
                type="range"
                min="100"
                max="2000"
                step="100"
                value={session.params.res}
                onChange={(e) =>
                  updateParams(session.id, { res: parseFloat(e.target.value) })
                }
              />
              <span>{session.params.res.toFixed(0)}</span>
            </label>
            <br />
            <label>
              Pausa mínima (minutos){" "}
              <input
                type="number"
                min="1"
                max="60"
                value={session.segmentGapMinutes}
                onChange={(e) => updateSegmentGap(session.id, e.target.value)}
                style={{ width: "50px" }}
              />
            </label>{" "}
            <button onClick={() => mergeSegments(session.id)}>
              Unir todos los segmentos
            </button>{" "}
            <select
              value={session.activeSegmentIndex}
              onChange={(e) => setActiveSegment(session.id, e.target.value)}
            >
              {session.segments.map((_, idx) => (
                <option key={idx} value={idx}>
                  Segmento {idx + 1}
                </option>
              ))}
            </select>
            <br />
            <small>
              Distancia: {(session.stats.distanceKm || 0).toFixed(1)} km | Velocidad
              media: {(session.stats.avgSpeedKmh || 0).toFixed(1)} km/h | Velocidad
              máx: {(session.stats.maxSpeedKmh || 0).toFixed(1)} km/h
            </small>
          </div>
          <MapContainer
            center={session.center}
            zoom={15}
            style={{ height: "400px", width: "100%" }}
            bounds={session.bounds}
          >
            {/* MODIFICADO: TileLayer con Esri WorldImagery para satélite de alta resolución */}
            <TileLayer
              url={
                mapType === "satellite"
                  ? "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                  : "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              }
              attribution={
                mapType === "satellite"
                  ? "Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community"
                  : "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors"
              }
              maxZoom={19} // Soporta zoom alto para nitidez
            />
            {session.overlayUrl && (
              <ImageOverlay url={session.overlayUrl} bounds={session.bounds} />
            )}
          </MapContainer>
        </details>
      ))}
    </div>
  );
}