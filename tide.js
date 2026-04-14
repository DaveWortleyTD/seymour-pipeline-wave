// Seymour Pipeline Wave — Tide Predictor
// Fetches hi/lo tide predictions from DFO IWLS for Second Narrows (5dd30650e0fdc4b9b4be6c2d).
// The wave is a river standing wave over a pipeline; it forms when the tide drops below 3.0m,
// reducing tidal backwater in the Seymour River estuary. River flow from the Seymour dam is the
// primary condition — always check the Metro Vancouver gauge before heading out.

const STATION_ID        = '5cebf1e43d0f4a073c4bc434'; // Calamity Point (DFO IWLS) — closest station with tide predictions
const TIDE_LOCATION_LAT = 49.316;
const TIDE_LOCATION_LNG = -123.016;  // pipeline wave site, below Mt Seymour Pkwy bridge
const THRESHOLD_M       = 3.0;       // tide must drop below this (m) for wave to form

const WAVE_QUALITY = [
  { maxM: 1.5, label: 'Prime',    css: 'tide-large',  description: 'Lowest backwater — best tidal conditions when river is running' },
  { maxM: 2.5, label: 'Good',     css: 'tide-medium', description: 'Reduced tidal backwater — good conditions' },
  { maxM: 3.0, label: 'Marginal', css: 'tide-small',  description: 'Marginal — wave needs high river flow to form' },
];

function waveQuality(lowM) {
  return WAVE_QUALITY.find(q => lowM < q.maxM) || null;
}

// Cosine interpolation: time when tide crosses threshold going DOWN (ebb: high → low)
function ebbCrossing(highTime, highM, lowTime, lowM, threshold) {
  if (highM <= threshold) return highTime;   // already below at start of ebb
  if (lowM  >= threshold) return null;        // never crosses below threshold
  const cosArg = (2 * threshold - highM - lowM) / (highM - lowM);
  const theta  = Math.acos(Math.max(-1, Math.min(1, cosArg)));
  return new Date(highTime.getTime() + (theta / Math.PI) * (lowTime - highTime));
}

// Cosine interpolation: time when tide crosses threshold going UP (flood: low → high)
function floodCrossing(lowTime, lowM, highTime, highM, threshold) {
  if (highM <= threshold) return highTime;   // never rises above threshold
  if (lowM  >= threshold) return null;        // already above at start of flood
  const cosArg = (highM + lowM - 2 * threshold) / (highM - lowM);
  const phi    = Math.acos(Math.max(-1, Math.min(1, cosArg)));
  return new Date(lowTime.getTime() + (phi / Math.PI) * (highTime - lowTime));
}

async function fetchHeightEvents(year, month) {
  const start    = new Date(year, month - 1, 1);
  const fromDate = new Date(start.getTime() - 2 * 24 * 60 * 60 * 1000);
  const toDate   = new Date(year, month, 3);

  const fmt = d => d.toISOString().replace('.000', '');
  const url = `https://api-iwls.dfo-mpo.gc.ca/api/v1/stations/${STATION_ID}/data` +
              `?time-series-code=wlp-hilo` +
              `&from=${fmt(fromDate)}&to=${fmt(toDate)}`;

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`DFO API error: ${resp.status}`);
  const json = await resp.json();
  if (!json || json.length === 0) throw new Error('No tide data returned for Second Narrows station');

  const events = json.map(e => ({ time: new Date(e.eventDate), value: parseFloat(e.value), type: null }));
  events.forEach((e, i) => {
    const neighbours = [
      i > 0                 ? events[i - 1].value : null,
      i < events.length - 1 ? events[i + 1].value : null,
    ].filter(v => v !== null);
    e.type = neighbours.every(n => e.value > n) ? 'high' : 'low';
  });

  return events;
}

function toPacificDateStr(date) {
  return date.toLocaleDateString('en-CA', { timeZone: 'Etc/GMT+7' });
}

async function computeSessions(year, month) {
  const events   = await fetchHeightEvents(year, month);
  const sessions = [];

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.type !== 'low' || ev.value >= THRESHOLD_M) continue;

    const quality = waveQuality(ev.value);
    if (!quality) continue;

    const prevHigh = [...events.slice(0, i)].reverse().find(e => e.type === 'high');
    const nextHigh = events.slice(i + 1).find(e => e.type === 'high');

    const windowStart = prevHigh
      ? (ebbCrossing(prevHigh.time, prevHigh.value, ev.time, ev.value, THRESHOLD_M) || prevHigh.time)
      : ev.time;
    const windowEnd = nextHigh
      ? (floodCrossing(ev.time, ev.value, nextHigh.time, nextHigh.value, THRESHOLD_M) || nextHigh.time)
      : ev.time;

    const dateStr = toPacificDateStr(ev.time);
    const [py, pm] = dateStr.split('-').map(Number);
    if (py !== year || pm !== month) continue;

    const [sunrise, sunset] = solarEvents(TIDE_LOCATION_LAT, TIDE_LOCATION_LNG, dateStr);

    sessions.push({
      dateStr,
      peakTime:  ev.time,
      peakM:     Math.round(ev.value * 100) / 100,
      quality,
      windowStart,
      windowEnd,
      highTideM: prevHigh ? Math.round(prevHigh.value * 100) / 100 : null,
      nextHighM: nextHigh ? Math.round(nextHigh.value * 100) / 100 : null,
      sunrise,
      sunset,
    });
  }

  return sessions.sort((a, b) => a.peakTime - b.peakTime);
}

// ── NOAA solar calculation ─────────────────────────────────────────────────
function solarEvents(lat, lng, dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const jd = julianDay(y, m, d);
  const t  = (jd - 2451545.0) / 36525.0;

  const l0 = ((280.46646 + t * (36000.76983 + t * 0.0003032)) % 360 + 360) % 360;
  const mAnomaly = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const mRad     = mAnomaly * Math.PI / 180;
  const c = Math.sin(mRad) * (1.914602 - t * (0.004817 + 0.000014 * t))
          + Math.sin(2 * mRad) * (0.019993 - 0.000101 * t)
          + Math.sin(3 * mRad) * 0.000289;
  const sunLon = l0 + c;
  const omega  = 125.04 - 1934.136 * t;
  const lambda = sunLon - 0.00569 - 0.00478 * Math.sin(omega * Math.PI / 180);

  const epsilon0 = 23.0 + (26.0 + (21.448 - t * (46.8150 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const epsilon  = epsilon0 + 0.00256 * Math.cos(omega * Math.PI / 180);

  const sinDec = Math.sin(epsilon * Math.PI / 180) * Math.sin(lambda * Math.PI / 180);
  const dec    = Math.asin(sinDec);

  const tanEps2 = Math.tan((epsilon / 2) * Math.PI / 180);
  const y2      = tanEps2 * tanEps2;
  const l0Rad   = l0 * Math.PI / 180;
  const eot     = 4 * (180 / Math.PI) * (
    y2 * Math.sin(2 * l0Rad)
    - 2 * 0.016708634 * Math.sin(mRad)
    + 4 * 0.016708634 * y2 * Math.sin(mRad) * Math.cos(2 * l0Rad)
    - 0.5 * y2 * y2 * Math.sin(4 * l0Rad)
    - 1.25 * 0.016708634 * 0.016708634 * Math.sin(2 * mRad)
  );

  const latRad = lat * Math.PI / 180;
  let cosHA = (Math.cos(90.833 * Math.PI / 180) / (Math.cos(latRad) * Math.cos(dec)))
              - Math.tan(latRad) * Math.tan(dec);
  cosHA = Math.max(-1, Math.min(1, cosHA));
  const haDeg = Math.acos(cosHA) * 180 / Math.PI;

  const tzOffsetMin = 420; // BC permanent UTC-7 since 2026
  const solarNoon   = 720 - 4 * lng - eot - tzOffsetMin;
  const sunriseMin  = solarNoon - 4 * haDeg;
  const sunsetMin   = solarNoon + 4 * haDeg;

  const midnightUTC = new Date(`${dateStr}T00:00:00Z`);
  const tzOffsetMs  = tzOffsetMin * 60 * 1000;
  const midnightPac = new Date(midnightUTC.getTime() + tzOffsetMs);

  const sunrise = new Date(midnightPac.getTime() + sunriseMin * 60 * 1000);
  const sunset  = new Date(midnightPac.getTime() + sunsetMin  * 60 * 1000);
  return [sunrise, sunset].sort((a, b) => a - b);
}

function julianDay(y, m, d) {
  if (m <= 2) { y -= 1; m += 12; }
  const A = Math.floor(y / 100);
  const B = 2 - A + Math.floor(A / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + B - 1524.5;
}

function isNightSession(s) {
  if (!s.sunrise || !s.sunset) return false;
  return s.peakTime > new Date(s.sunset.getTime()  + 45 * 60 * 1000) ||
         s.peakTime < new Date(s.sunrise.getTime() + 60 * 60 * 1000);
}

export { computeSessions, waveQuality, isNightSession, WAVE_QUALITY };
