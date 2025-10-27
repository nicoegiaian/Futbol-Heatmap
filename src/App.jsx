import React, { useEffect, useRef, useState } from "react";
import { parseString } from "xml2js";
import { promisify } from "util";
import { renderToStaticMarkup } from "react-dom/server";
import L, { LatLngBounds } from "leaflet";
import {
  MapContainer,
  TileLayer,
  ImageOverlay,
  useMap,
  LayersControl,
} from "react-leaflet";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import "leaflet/dist/leaflet.css";

const parseXML = promisify(parseString);

// --- Funciones de Utilidad (sin cambios) ---

function parseGPX(xmlText) {
  let points = [];
  let startTime = null;
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlText, "text/xml");
  const trackpoints = xmlDoc.getElementsByTagName("trkpt");

  for (let i = 0; i < trackpoints.length; i++) {
    const pt = trackpoints[i];
    const lat = parseFloat(pt.getAttribute("lat"));
    const lon = parseFloat(pt.getAttribute("lon"));
    const timeElem = pt.getElementsByTagName("time")[0];
    const time = timeElem ? timeElem.textContent : null;

    if (!startTime && time) {
      startTime = new Date(time);
    }

    if (!isNaN(lat) && !isNaN(lon) && time) {
      points.push({ lat, lon, time });
    }
  }
  return { points, startTime };
}

function haversineDistance(coords1, coords2) {
  const [lat1, lon1] = coords1;
  const [lat2, lon2] = coords2;
  const R = 6371; // Radio de la Tierra en km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function processGpxPoints(points) {
  if (points.length < 2) return [];
  const processed = [];
  const startTime = new Date(points[0].time).getTime();

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const time = new Date(p.time).getTime();
    const elapsedSeconds = (time - startTime) / 1000;

    if (i === 0) {
      processed.push({ ...p, elapsedSeconds, speed: 0 });
      continue;
    }

    const pPrev = points[i - 1];
    const timePrev = new Date(pPrev.time).getTime();
    const dist = haversineDistance([pPrev.lat, pPrev.lon], [p.lat, p.lon]); // km
    const timeDiffHours = (time - timePrev) / (1000 * 60 * 60); // horas

    let speed = 0;
    if (timeDiffHours > 0) {
      speed = dist / timeDiffHours; // km/h
    }

    processed.push({ ...p, elapsedSeconds, speed: isNaN(speed) ? 0 : speed });
  }
  return processed;
}

function centerOfPoints(points) {
  if (!points || points.length === 0) return [0, 0];
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  return [(Math.min(...lats) + Math.max(...lats)) / 2, (Math.min(...lons) + Math.max(...lons)) / 2];
}

function boundsOfPoints(points) {
  if (!points || points.length === 0) return [[0, 0], [0, 0]];
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  return [[Math.min(...lats), Math.min(...lons)], [Math.max(...lats), Math.max(...lons)]];
}

const placeNameCache = {};
async function reverseGeocode(lat, lon) {
  const cacheKey = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  if (placeNameCache[cacheKey]) {
    return placeNameCache[cacheKey];
  }
  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=16`
    );
    const data = await response.json();
    const name = data.display_name.split(",")[0] || data.display_name; // Try to get the main name
    placeNameCache[cacheKey] = name;
    return name;
  } catch (error) {
    console.error("Reverse geocoding failed:", error);
    return "Ubicación desconocida";
  }
}

async function buildOverlay(points, bounds, params) {
  if (typeof window === "undefined" || points.length === 0) return null; // Avoid running on server or with no points

  const { HeatmapOverlay } = await import("leaflet-heatmap/leaflet-heatmap.js");

  const mapDiv = document.createElement("div");
  mapDiv.style.width = "800px";
  mapDiv.style.height = "600px";
  mapDiv.style.position = "absolute";
  mapDiv.style.left = "-9999px"; // Hide it off-screen
  document.body.appendChild(mapDiv);

  const map = L.map(mapDiv).fitBounds(bounds);
  const heatmapLayer = new HeatmapOverlay({
    radius: params.radius / 100, // example conversion, adjust as needed
    maxOpacity: params.maxOpacity / 100,
    scaleRadius: true,
    useLocalExtrema: false,
    latField: "lat",
    lngField: "lng",
    valueField: "value",
    gradient: {
      '.1': 'blue', '.2': 'lime', '.4': 'yellow', '.6': 'orange', '.8': 'red'
    },
    blur: params.blur / 100,
    // Adjust max based on density - simple heuristic, can be improved
    max: points.length / 500, // example scaling
  });

  const data = points.map((p) => ({
    lat: p.lat,
    lng: p.lon,
    value: 1, // Simple count, could be velocity, HR, etc.
  }));

  heatmapLayer.setData({ data: data });
  map.addLayer(heatmapLayer);

  // Capture the heatmap canvas as a Data URL
  return new Promise((resolve) => {
    // Wait a brief moment for Leaflet/Heatmap.js to render
    setTimeout(() => {
      const canvas = mapDiv.querySelector(".leaflet-heatmap-layer");
      if (canvas) {
        resolve(canvas.toDataURL());
      } else {
        resolve(null);
      }
      map.remove(); // Clean up Leaflet instance
      document.body.removeChild(mapDiv); // Clean up DOM element
    }, 100); // Adjust delay if needed
  });
}

// --- Componentes React ---

function Style() {
  return (
    <style>{`
      :root {
        --bg: #f8f9fa; --fg: #212529; --line: #dee2e6; --muted: #6c757d;
        --card-bg: #fff; --card-shadow: rgba(0,0,0,0.05);
        --primary: #0d6efd; --secondary: #6c757d;
      }
      body { margin: 0; background: var(--bg); color: var(--fg); font-family: sans-serif; padding: 20px;}
      .app { display: flex; flex-direction: column; gap: 20px; max-width: 900px; margin: auto; }
      .dropzone { border: 2px dashed var(--line); padding: 40px; text-align: center; border-radius: 16px; background: var(--card-bg); cursor: pointer; transition: background .2s;}
      .dropzone:hover { background: #e9ecef;}
      .dropzone p { margin: 0; color: var(--muted); }
      .card { border-radius: 16px; background: var(--card-bg); box-shadow: 0 4px 16px var(--card-shadow); border: 1px solid var(--line); }
      .session { overflow: hidden; }
      .session summary { padding: 16px 20px; font-weight: bold; cursor: pointer; display: flex; justify-content: space-between; align-items: center; }
      .session summary small { font-weight: normal; color: var(--muted); }
      .session__content { display: grid; grid-template-columns: 200px 1fr; gap: 20px; padding: 0 20px 20px; }
      .controls { display: flex; flex-direction: column; gap: 12px; }
      .control { font-size: 14px; }
      .control__row { display: flex; justify-content: space-between; margin-bottom: 4px;}
      .control__label { color: var(--muted); }
      .control__value { font-weight: bold; }
      .slider { width: 100%; }
      .mapWrap { border-radius: 12px; overflow: hidden; border: 1px solid var(--line); height: 420px; }
      .btn { padding: 8px 16px; border-radius: 8px; border: 1px solid var(--secondary); background: var(--secondary); color: white; cursor: pointer; font-size: 14px; }
      .btn--secondary { background: none; color: var(--secondary); }
      .help { font-size: 12px; color: var(--muted; margin-top: auto; }
      .modal__overlay{
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0, 0, 0, 0.5); z-index: 1000;
        display: flex; align-items: center; justify-content: center; padding: 16px;
      }
      .modal__content{
        background: #fff; border-radius: 16px; padding: 20px;
        max-width: 900px; width: 100%; max-height: 90vh; overflow-y: auto;
      }
      .modal__header{
        display: flex; justify-content: space-between; align-items: center;
        border-bottom: 1px solid var(--line); padding-bottom: 12px;
      }
      .modal__title{ margin: 0; font-size: 18px; }
      .modal__close{
        background: none; border: none; font-size: 28px; cursor: pointer;
        line-height: 1; padding: 0 4px; color: var(--muted);
      }
      .modal__body{ padding-top: 16px; }
      .empty-state { text-align: center; padding: 50px; color: var(--muted); }
      .recharts-cartesian-axis-tick-value tspan { font-size: 12px; }
      .recharts-label { font-size: 13px; }
      .recharts-legend-item-text { font-size: 13px; }
      .leaflet-control-layers-base label span { font-size: 14px; }
      .leaflet-control-layers-overlays label span { font-size: 14px; }
    `}</style>
  );
}

function EmptyState() {
  return <div className="card empty-state">Arrastra un archivo GPX aquí</div>;
}

function FitBoundsOnLoad({ bounds }) {
  const map = useMap();
  useEffect(() => {
    if (bounds) {
      map.fitBounds(bounds);
    }
  }, [bounds, map]);
  return null;
}

function LeafletMap({ bounds, overlayUrl }) {
  return (
    <MapContainer bounds={bounds} scrollWheelZoom style={{ height: 420, width: "100%" }} maxZoom={22}>
      <FitBoundsOnLoad bounds={bounds} />
      <LayersControl position="topright">
        <LayersControl.BaseLayer name="Mapa (OSM)">
          <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="© OpenStreetMap" maxZoom={22} />
        </LayersControl.BaseLayer>
        <LayersControl.BaseLayer checked name="Satélite (Esri)">
          <TileLayer
            url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
            attribution="Tiles © Esri"
            maxZoom={22}
          />
        </LayersControl.BaseLayer>
        <LayersControl.Overlay checked name="Líneas y Referencias (Híbrido)">
          <TileLayer
            url="https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"
            attribution="Labels © Esri"
            maxZoom={22}
          />
        </LayersControl.Overlay>
      </LayersControl>
      {overlayUrl && <ImageOverlay url={overlayUrl} bounds={bounds} opacity={1} />}
    </MapContainer>
  );
}

function ControlNumber({ label, value, min, max, step, onChange }) {
  return (
    <div className="control">
      <div className="control__row">
        <span className="control__label">{label}</span>
        <span className="control__value">{value}</span>
      </div>
      <input
        type="range"
        min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="slider"
      />
    </div>
  );
}

function SessionBlock({ session, onChangeParams, onAnalyzeClick, onSelectSegment }) {
  const { id, fileName, startTime, place, bounds, params, overlayUrl, segments, selectedSegmentIdx } = session;

  const handleParamChange = (paramName, value) => {
    onChangeParams(id, { ...params, [paramName]: value });
  };

  const formatDate = (date) => date ? date.toLocaleString("es-AR") : "N/A";

  return (
    <details open className="card session">
      <summary>
        {fileName} <small>{place} - {formatDate(startTime)}</small>
      </summary>
      <div className="session__content">
        <div className="controls">
          {segments && segments.length > 1 && (
            <div className="control">
              <div className="control__row">
                <span className="control__label">Ver Segmento</span>
              </div>
              <select
                value={selectedSegmentIdx}
                onChange={(e) => onSelectSegment(id, e.target.value)}
                style={{width: '100%', padding: '8px', marginTop: '6px', borderRadius: '8px'}}
              >
                {segments.map((seg, idx) => (
                  <option key={seg.label} value={idx}>
                    {seg.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <ControlNumber label="Radius" value={params.radius} min={1} max={100} step={1} onChange={v => handleParamChange('radius', v)} />
          <ControlNumber label="Max Opacity" value={params.maxOpacity} min={0} max={100} step={1} onChange={v => handleParamChange('maxOpacity', v)} />
          <ControlNumber label="Blur" value={params.blur} min={0} max={100} step={1} onChange={v => handleParamChange('blur', v)} />
          {/* Botón para abrir el modal de análisis */}
          <button
            className="btn btn--secondary"
            style={{marginTop: 10}}
            onClick={() => onAnalyzeClick(session)}
          >
            Analizar Actividad
          </button>
          <p className="help">Ajusta los parámetros para regenerar el heatmap.</p>
        </div>
        <div className="mapWrap">
          {bounds && <LeafletMap bounds={bounds} overlayUrl={overlayUrl} />}
        </div>
      </div>
    </details>
  );
}

// --- MODAL DE ANÁLISIS (SIMPLIFICADO) ---
function AnalysisModal({ session, onClose }) {
  // Formateadores para el gráfico (sin cambios)
  const formatXAxis = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };
  const formatTooltip = (value) => `${value.toFixed(1)} km/h`;

  return (
    <div className="modal__overlay" onClick={onClose}>
      <div className="modal__content" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <h3 className="modal__title">Análisis de Velocidad</h3>
          <button className="modal__close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal__body">
          <p>Gráfico de velocidad (km/h) vs. Tiempo.</p>
          {session.processedPoints && session.processedPoints.length > 0 ? (
            <div style={{ width: '100%', height: 300, marginTop: 20 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={session.processedPoints}
                  margin={{ top: 5, right: 20, left: -20, bottom: 20 }} // Más margen abajo para label
                >
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis
                    dataKey="elapsedSeconds"
                    tickFormatter={formatXAxis}
                    label={{ value: "Tiempo (min:seg)", position: 'insideBottom', offset: -15 }}
                  />
                  <YAxis
                    label={{ value: 'Velocidad (km/h)', angle: -90, position: 'insideLeft' }}
                  />
                  <Tooltip
                    labelFormatter={formatXAxis}
                    formatter={formatTooltip}
                  />
                  <Legend verticalAlign="top" height={36}/>
                  <Line
                    type="monotone"
                    dataKey="speed"
                    name="Velocidad"
                    stroke="#8884d8"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p>No hay datos procesados para mostrar el gráfico.</p>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Componente Principal App ---

export default function App() {
  const [sessions, setSessions] = useState([]);
  const [modalSession, setModalSession] = useState(null); // Estado para controlar qué sesión mostrar en el modal
  const rebuildSeqRef = useRef({});

  // --- Handlers de Drag & Drop (sin cambios) ---
  const onDrop = (e) => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    if (files.length) {
      handleFiles(Array.from(files));
    }
  };
  const onDragOver = (e) => {
    e.preventDefault();
  };
  const handleFileInput = (e) => {
    const files = e.target.files;
    if (files.length) {
      handleFiles(Array.from(files));
    }
  };

  // --- Función para procesar archivos (modificada para segmentos iniciales) ---
  async function handleFiles(files) {
    for (const file of files) {
      if (!file.name.toLowerCase().endsWith(".gpx")) continue;
      const text = await file.text();
      const parsed = parseGPX(text);
      if (!parsed.points.length) continue;

      const processedPoints = processGpxPoints(parsed.points);
      // Incluir puntos procesados solo si son válidos
      const validProcessedPoints = processedPoints.length > 0 ? processedPoints : null;

      const { points, startTime } = parsed;
      const center = centerOfPoints(points);
      const boundsArray = boundsOfPoints(points);
      const bounds = L.latLngBounds(boundsArray[0], boundsArray[1]);
      const initialParams = { radius: 20, maxOpacity: 50, blur: 30 };

      // Segmento inicial: siempre incluir la actividad completa
      const initialSegments = [{ label: "Actividad Completa", startIdx: 0, endIdx: points.length }];

      const id = `${file.name}-${Date.now()}`;
      setSessions((prev) => [
        {
          id,
          fileName: file.name,
          startTime,
          center,
          bounds,
          params: initialParams,
          points,
          processedPoints: validProcessedPoints, // Guardar puntos procesados si existen
          overlayUrl: null, // Inicia sin overlay
          place: "Buscando lugar…",
          segments: initialSegments, // Guardar segmentos iniciales
          selectedSegmentIdx: 0, // Por defecto, mostrar completo
        },
        ...prev,
      ]);

      // Iniciar generación de overlay y búsqueda de lugar
      scheduleOverlayRebuild(id, [{ id, points, bounds, params: initialParams, segments: initialSegments, selectedSegmentIdx: 0 }]);
      resolvePlaceName(id, center);
    }
  }

  // --- Funciones de Actualización (con manejo de segmentos) ---
  function scheduleOverlayRebuild(id, nextSessions) {
    const sess = nextSessions.find((s) => s.id === id);
    if (!sess) return;
    const seq = (rebuildSeqRef.current[id] || 0) + 1;
    rebuildSeqRef.current[id] = seq;

    // Obtener el segmento actual y cortar los puntos
    const segment = sess.segments[sess.selectedSegmentIdx];
    // Asegurarse de que el segmento es válido antes de cortar
    const pointsForHeatmap = (segment && segment.endIdx > segment.startIdx)
                             ? sess.points.slice(segment.startIdx, segment.endIdx)
                             : sess.points; // Usar todos si el segmento no es válido

    if (pointsForHeatmap.length === 0) {
      console.warn(`Segmento ${segment?.label} no tiene puntos para ${id}, mostrando mapa vacío.`);
      setSessions((cur) => cur.map((s) => (s.id === id ? { ...s, overlayUrl: null } : s)));
      return; // No intentar generar overlay vacío
    }

    buildOverlay(pointsForHeatmap, sess.bounds, sess.params).then((url) => {
      if (rebuildSeqRef.current[id] !== seq) return; // resultado viejo
      setSessions((cur) => cur.map((s) => (s.id === id ? { ...s, overlayUrl: url } : s)));
    });
  }

  function updateParams(id, newParams) {
    setSessions((prev) => {
      const next = prev.map((s) =>
        s.id === id ? { ...s, params: newParams } : s
      );
      scheduleOverlayRebuild(id, next); // Regenerar overlay con nuevos parámetros
      return next;
    });
  }

  // Función para resolver nombre de lugar (sin cambios)
  async function resolvePlaceName(id, center) {
      const name = await reverseGeocode(center[0], center[1]);
      setSessions(cur => cur.map(s => s.id === id ? { ...s, place: name } : s));
  }

  // --- NUEVO Handler para seleccionar segmento ---
  function selectSegment(id, segmentIndex) {
    setSessions((prev) => {
      // Primero encontrar el estado actual para pasar a scheduleOverlayRebuild
      const currentSessions = prev.map((s) =>
        (s.id === id ? { ...s, selectedSegmentIdx: parseInt(segmentIndex, 10) } : s)
      );
      // Disparar la regeneración ANTES de devolver el nuevo estado
      scheduleOverlayRebuild(id, currentSessions);
      return currentSessions; // Devolver el estado actualizado
    });
  }

  return (
    <div className="app" onDrop={onDrop} onDragOver={onDragOver}>
      <Style />
      {/* Input oculto para seleccionar archivos */}
      <input type="file" id="fileInput" multiple accept=".gpx" onChange={handleFileInput} style={{ display: 'none' }} />
      {/* Botón visible que activa el input */}
      <button className="btn" onClick={() => document.getElementById('fileInput').click()} style={{maxWidth: '200px', margin: 'auto'}}>
        Seleccionar GPX
      </button>

      {/* Dropzone (opcional) */}
      <div className="dropzone" onClick={() => document.getElementById('fileInput').click()}>
        <p>o arrastra archivos GPX aquí</p>
      </div>

      {sessions.length === 0 && <EmptyState />}

      {sessions.map((s) => (
        <SessionBlock
          key={s.id}
          session={s}
          onChangeParams={updateParams}
          onAnalyzeClick={setModalSession} // Pasa la función para abrir el modal
          onSelectSegment={selectSegment} // Pasa la función para cambiar segmento
        />
      ))}

      {/* Renderizar el modal si modalSession tiene datos */}
      {modalSession && (
        <AnalysisModal
          session={modalSession}
          onClose={() => setModalSession(null)} // Pasa la función para cerrar
        />
      )}
    </div>
  );
}