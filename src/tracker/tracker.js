// Unsichtbares Tracker-Fenster: Aufnahme + Bildvergleich, Ergebnis an den Hauptprozess.
// Ablauf (Fluss, Verankern, Drift) in tracker-core.js, Drift-Prüfung im Worker (check-worker.js),
// Spielfigur auf der Minimap (Weltansicht) in minimap-core.js.
/* global MatcherCore, ReferenceBuilder, TrackerCore, MinimapCore, TeleportCore, Hud */
const api = window.trackerApi;
const CAPTURE_WIDTH = 1280;
const FLOW_FPS = 30;
// Abgestimmt mit tools/bench-track.js an einer echten Kartenfahrt (Inazuma, viele Symbole):
// - Maske gegen Spiel-Symbole: lila, graue Ränder, dunkles Meer, breiterer Rand; Grobsuche ohne prior mit alter Maske
// - Worker prüft alle 250 ms, sicherer Treffer (≥ 30 Inlier) korrigiert sofort; ohne Worker wie bisher 1 s
const MASK = { purple: true, erode: 13, gray: 70, sea: 80 };
const CHECK_MS_WORKER = 250;
const CHECK_MS_INLINE = 1000;
// Minimap: Takt in der Weltansicht; Anker nur nach so langer Weltansicht (sonst wäre es eine verschobene Karte)
const MINIMAP_FPS = 15;
const MINIMAP_RECOVERY_FPS = 4;
const ANCHOR_AFTER_MS = 1500;
const TELEPORT_TARGET_MAX_AGE_MS = 1200;
const TELEPORT_ARRIVAL_MS = 5000;
const TELEPORT_SCAN_INTERVAL_MS = 80;
const TELEPORT_EXIT_CONFIRM_MS = 250;

let cv = null;
let settings = null;
let matcher = null;
let core = null;
let checker = null;
let checkSeq = 0;
let reader = null;
let stream = null;
let frameCanvas = null;
let frameCtx = null;
let cornerCanvas = null;
let cornerCtx = null;
let loadingCtx = null;
let minimap = null;
let minimapAnchor = null;
let teleportTarget = null;
let teleportLoading = false;
let teleportNonLoadingSince = null;
let teleportArrivalUntil = 0;
let teleportArrivalStats = null;
let lastTeleportScan = -Infinity;
let teleportSelectionStats = newTeleportSelectionStats();
let minimapShown = false;
let unlockedSince = 0;
let lastSearch = 0;
let locked = false;
let running = false;
let building = false;
// Nur zur Fehlersuche (DevTools): letzte Versuche, Bild beim letzten Verlust
const recent = [];
let lostFrame = null;
let lastLockAt = 0;
let runningSince = 0;
let lastFrameAt = null;
let framesRead = 0;
let mapFrames = 0;
let lastCaptureState = '';
let lastCaptureLog = -Infinity;

// Runs independently of reader.read(), so a blocked read also appears in the log.
setInterval(() => {
  if (!running || !settings?.active || building) {
    lastCaptureState = '';
    return;
  }
  const now = performance.now();
  const frameAge = Math.round(now - (lastFrameAt ?? runningSince));
  const stalled = frameAge > Math.max(3000, settings.searchIntervalMs * 3);
  const state = stalled ? 'stalled' : lastFrameAt === null ? 'starting' : 'receiving';
  if (state === lastCaptureState && now - lastCaptureLog < 30000) return;
  lastCaptureState = state;
  lastCaptureLog = now;
  api.log(`map-capture: state=${state} frames=${framesRead} frameAgeMs=${frameAge} fullFrames=${mapFrames} locked=${core.locked}`);
}, 1000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// key = i18n-Schlüssel, übersetzt wird im Hauptprozess
const status = (phase, key, params = {}, progress = 0) => api.status({ phase, key, params, progress });

async function loadCv() {
  const mod = window.cv;
  if (typeof mod.then === 'function') return mod;
  if (mod.Mat) return mod;
  return new Promise((resolve) => { mod.onRuntimeInitialized = () => resolve(mod); });
}

const tileCanvas = new OffscreenCanvas(256, 256);
const tileCtx = tileCanvas.getContext('2d', { willReadFrequently: true });
const tileCache = new Map();

async function tileRgba(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (tileCache.has(key)) return tileCache.get(key);
  const bytes = await api.tile(z, x, y);
  let rgba = null;
  if (bytes && bytes.length) {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    tileCtx.clearRect(0, 0, 256, 256);
    tileCtx.drawImage(bitmap, 0, 0);
    bitmap.close();
    rgba = new Uint8Array(tileCtx.getImageData(0, 0, 256, 256).data.buffer);
  }
  if (tileCache.size > 300) tileCache.delete(tileCache.keys().next().value);
  tileCache.set(key, rgba);
  return rgba;
}

// ---------- Kachelbild für die Minimap ----------

const tileBitmaps = new Map();

function tileBitmap(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (tileBitmaps.has(key)) return tileBitmaps.get(key);
  const loading = api.tile(z, x, y)
    .then((bytes) => (bytes && bytes.length ? createImageBitmap(new Blob([bytes], { type: 'image/jpeg' })) : null))
    .catch(() => null);
  tileBitmaps.set(key, loading);
  if (tileBitmaps.size > 200) {
    const [oldKey, old] = tileBitmaps.entries().next().value;
    tileBitmaps.delete(oldKey);
    old.then((bmp) => bmp && bmp.close());
  }
  return loading;
}

// size×size um Kartenpunkt cx/cy, scale = Bildpixel je Kartenpixel (z13); Kachelstufe passend zum Maßstab
async function renderRegion(cx, cy, scale, size) {
  const z = Math.min(15, Math.max(11, 13 + Math.ceil(Math.log2(scale) - 0.25)));
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  const tilePx = 256 * 2 ** (13 - z);
  const x0 = cx - size / (2 * scale);
  const y0 = cy - size / (2 * scale);
  const half = 2 ** (z - 1);
  const jobs = [];
  for (let ty = Math.floor(y0 / tilePx); ty <= Math.floor((y0 + size / scale) / tilePx); ty++) {
    for (let tx = Math.floor(x0 / tilePx); tx <= Math.floor((x0 + size / scale) / tilePx); tx++) {
      jobs.push(tileBitmap(z, tx - half, half - ty - 1).then((bmp) => {
        if (bmp) ctx.drawImage(bmp, (tx * tilePx - x0) * scale, (ty * tilePx - y0) * scale, tilePx * scale, tilePx * scale);
      }));
    }
  }
  await Promise.all(jobs);
  return ctx.getImageData(0, 0, size, size);
}

function referenceKey() {
  return `refdb-v1-${settings.tileset.version}-${settings.levels.join('_')}`;
}

// ---------- Drift-Prüfung im Worker ----------
// Ohne Worker (Fehler beim Start) prüft der Kern wie bisher im selben Bild.

function stopChecker() {
  if (checker) {
    checker.worker.terminate();
    for (const waiting of checker.waiting.values()) waiting.reject(new Error('Worker beendet'));
  }
  checker = null;
  if (core) {
    core.o.check = null;
    core.o.checkMs = CHECK_MS_INLINE;
  }
}

function startChecker(bytes, options) {
  stopChecker();
  try {
    const worker = new Worker('check-worker.js');
    const c = { worker, ready: false, waiting: new Map() };
    worker.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === 'ready') {
        c.ready = true;
        if (core && checker === c) {
          core.o.check = checkInWorker;
          core.o.checkMs = CHECK_MS_WORKER;
        }
      } else if (msg.type === 'result') {
        const waiting = c.waiting.get(msg.id);
        c.waiting.delete(msg.id);
        if (waiting) waiting.resolve(msg.res);
      }
    };
    worker.onerror = (event) => {
      api.log(`Prüf-Worker ausgefallen – ${event.message || 'unbekannt'}`);
      if (checker === c) stopChecker();
    };
    const copy = bytes.slice();
    worker.postMessage({ type: 'init', bytes: copy.buffer, options }, [copy.buffer]);
    checker = c;
  } catch (err) {
    api.log(`Prüf-Worker nicht gestartet – ${err.message}`);
  }
}

function checkInWorker(img, prior) {
  return new Promise((resolve, reject) => {
    if (!checker || !checker.ready) {
      reject(new Error('Worker nicht bereit'));
      return;
    }
    const id = ++checkSeq;
    const copy = new Uint8ClampedArray(img.data);
    checker.waiting.set(id, { resolve, reject });
    checker.worker.postMessage({
      type: 'check', id, data: copy.buffer, width: img.width, height: img.height,
      prior: { s: prior.s, tx: prior.tx, ty: prior.ty },
    }, [copy.buffer]);
  });
}

async function prepareReference(force) {
  building = true;
  matcher = null;
  try {
    const key = referenceKey();
    const cached = force ? null : await api.loadReference(key);
    let ref;
    let bytes;
    if (cached && cached.length) {
      bytes = cached;
      ref = MatcherCore.deserializeReference(cached).ref;
    } else {
      status('download', 'status.downloadStart');
      await api.prefetch(settings.levels);
      status('building', 'status.building', { percent: 0 });
      ref = await ReferenceBuilder.build(cv, settings.tileset, settings.levels, tileRgba, null, (done, total) => {
        const p = done / total;
        status('building', 'status.building', { percent: Math.round(p * 100) }, p);
      });
      bytes = MatcherCore.serializeReference(ref, { levels: settings.levels, tileset: settings.tileset.version });
      await api.saveReference(key, bytes);
      tileCache.clear();
    }
    // Stufen 14+ nur fürs Nachführen, hält die Grobsuche schnell
    const coarse = settings.levels.filter((z) => z <= 13);
    const options = { globalLevels: coarse.length ? coarse : null, mask: MASK, globalMask: null };
    matcher = new MatcherCore.Matcher(cv, ref, options);
    if (core) core.reset();
    core = new TrackerCore.TrackerCore(cv, matcher, { exclude: Hud.trackerRects, mask: MASK, trustInliers: 30, checkMs: CHECK_MS_INLINE });
    startChecker(bytes, options);
    if (!minimap) minimap = new MinimapCore.MinimapTracker(cv, renderRegion);
    status('ready', 'status.ready');
  } catch (err) {
    status('error', 'status.buildFailed', { error: err.message });
  } finally {
    building = false;
  }
}

async function startCapture() {
  stopCapture();
  stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 } }, audio: false });
  const track = stream.getVideoTracks()[0];
  track.addEventListener('ended', () => { reader = null; });
  // eslint-disable-next-line no-undef
  const processor = new MediaStreamTrackProcessor({ track, maxBufferSize: 1 });
  reader = processor.readable.getReader();
}

function stopCapture() {
  if (reader) reader.cancel().catch(() => {});
  reader = null;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}

// full: ganzes Bild (1280 breit) für die große Karte; corner: Minimap-Ecke in voller Auflösung, auf 1080p skaliert
async function grabFrame(wantFull, wantCorner, watchLoading) {
  if (!reader) await startCapture();
  const { value: frame, done } = await reader.read();
  if (done || !frame) {
    reader = null;
    return null;
  }
  lastFrameAt = performance.now();
  framesRead++;
  if (watchLoading) {
    const { width, height } = MinimapCore.LOADING_SAMPLE;
    loadingCtx ??= new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
    loadingCtx.drawImage(frame, 0, 0, width, height);
    if (MinimapCore.isLoadingScreen(loadingCtx.getImageData(0, 0, width, height))) {
      frame.close();
      return { loading: true };
    }
  }
  let full = null;
  let corner = null;
  if (wantFull) {
    mapFrames++;
    const width = CAPTURE_WIDTH;
    const height = Math.round((CAPTURE_WIDTH * frame.displayHeight) / frame.displayWidth);
    if (!frameCanvas || frameCanvas.width !== width || frameCanvas.height !== height) {
      frameCanvas = new OffscreenCanvas(width, height);
      frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true });
    }
    frameCtx.drawImage(frame, 0, 0, width, height);
    full = frameCtx.getImageData(0, 0, width, height);
  }
  if (wantCorner) {
    // Genshin skaliert die Oberfläche mit der Höhe
    const c = MinimapCore.GEOMETRY.corner;
    const k = frame.displayHeight / 1080;
    if (!cornerCanvas) {
      cornerCanvas = new OffscreenCanvas(c.w, c.h);
      cornerCtx = cornerCanvas.getContext('2d', { willReadFrequently: true });
      cornerCtx.imageSmoothingQuality = 'high';
    }
    cornerCtx.drawImage(frame, c.x * k, c.y * k, c.w * k, c.h * k, 0, 0, c.w, c.h);
    corner = cornerCtx.getImageData(0, 0, c.w, c.h);
  }
  frame.close();
  return { full, corner };
}

// Spielfigur in Kartenpixeln (z13) und Zoom der Minimap (Bildschirmpixel je Kartenpixel bei 1080p) ans Overlay,
// null = keine Marker auf der Minimap
function reportMinimap(m) {
  const show = !!m && m.ok;
  if (show) api.minimap({ x: m.x, y: m.y, scale: m.scale });
  else if (minimapShown) api.minimap(null);
  minimapShown = show;
}

function rememberTeleportTarget(img, now) {
  if (now - lastTeleportScan < TELEPORT_SCAN_INTERVAL_MS) return;
  lastTeleportScan = now;
  teleportSelectionStats.scans++;
  const point = TeleportCore.selectedWaypoint(img, teleportSelectionStats);
  if (!point) return;
  teleportSelectionStats.rings++;
  // Resolve the target against the visible map. The regular tracking result
  // can still be following features obscured by the newly opened panel.
  const row = point.mapWidth * 4;
  const cropped = new Uint8Array(row * img.height);
  for (let y = 0; y < img.height; y++) {
    const offset = y * img.width * 4;
    cropped.set(img.data.subarray(offset, offset + row), y * row);
  }
  const view = matcher.locate(cropped, point.mapWidth, img.height, null);
  if (!view.ok) {
    teleportSelectionStats.failedMapInliers = Math.max(teleportSelectionStats.failedMapInliers, view.inliers);
    return;
  }
  teleportSelectionStats.mapMatches++;
  const x = (point.x - view.tx) / view.s;
  const y = (point.y - view.ty) / view.s;
  const same = teleportTarget && Math.hypot(x - teleportTarget.x, y - teleportTarget.y) <= 12;
  teleportTarget = { x, y, at: now, confirmed: !!same };
}

function newTeleportSelectionStats() {
  return { scans: 0, panels: 0, headers: 0, rings: 0, bestRing: 0, mapMatches: 0, failedMapInliers: 0 };
}

function clearTeleport() {
  teleportTarget = null;
  teleportLoading = false;
  teleportNonLoadingSince = null;
  teleportArrivalUntil = 0;
  teleportArrivalStats = null;
  teleportSelectionStats = newTeleportSelectionStats();
}

function endTeleportArrival(confirmed) {
  const { samples, bestCorr } = teleportArrivalStats;
  api.log(`minimap: teleport destination ${confirmed ? 'confirmed' : 'not confirmed'} samples=${samples} bestCorr=${bestCorr === null ? 'none' : bestCorr.toFixed(3)}`);
  teleportArrivalUntil = 0;
  teleportArrivalStats = null;
}

function report(res, width, height) {
  const nowLocked = !!res && res.ok;
  if (nowLocked) {
    // relativ zur Bildgröße: bildschirm = (sx * karte + ox) * Breite
    api.view({
      locked: true,
      sx: res.s / width,
      sy: res.s / height,
      ox: res.tx / width,
      oy: res.ty / height,
      inliers: res.inliers,
      ms: res.ms,
      mode: res.mode,
    });
  } else if (locked) {
    // closed: ganz anderes Bild (Karte sicher zu), nicht nur kurz beim Ziehen verloren
    api.view({ locked: false, closed: !!(res && res.scene) });
  }
  locked = nowLocked;
}

async function loop() {
  if (running) return;
  running = true;
  runningSince = performance.now();
  lastFrameAt = null;
  let failures = 0;
  while (settings.active && matcher && !building) {
    const started = performance.now();
    try {
      // große Karte: offen → jedes Bild; sonst alle searchIntervalMs suchen, dazwischen nur die Minimap
      const now = performance.now();
      const recentlyLocked = Date.now() - lastLockAt < 3000;
      const minimapEnabled = settings.minimap !== false && !!minimap;
      const scanAfterMap = minimapEnabled && unlockedSince > 0 && now - unlockedSince < TELEPORT_TARGET_MAX_AGE_MS;
      const searchDue = core.locked || recentlyLocked || scanAfterMap || now - lastSearch >= settings.searchIntervalMs;
      if (teleportTarget && now - teleportTarget.at > TELEPORT_TARGET_MAX_AGE_MS) teleportTarget = null;
      if (teleportArrivalUntil && now >= teleportArrivalUntil) {
        minimap.stop();
        minimapAnchor = null;
        reportMinimap(null);
        endTeleportArrival(false);
      }
      const minimapOn = minimapEnabled && (minimap.active || !!minimapAnchor);
      const watchLoading = minimapEnabled && (minimapOn || teleportTarget || teleportLoading);
      const frame = await grabFrame(searchDue, minimapOn && !core.locked, watchLoading);
      if (!frame) {
        await sleep(200);
        continue;
      }
      if (frame.loading) {
        // An unrecognized frame inside the same loading screen must not consume
        // the saved destination or make the next loading frame reset it again.
        teleportNonLoadingSince = null;
        if (teleportLoading) continue;
        teleportLoading = true;
        api.log(`minimap: waypoint selection ${JSON.stringify(teleportSelectionStats)}`);
        teleportSelectionStats = newTeleportSelectionStats();
        minimap.stop();
        minimapAnchor = teleportTarget?.confirmed ? { x: teleportTarget.x, y: teleportTarget.y } : null;
        teleportTarget = null;
        teleportArrivalUntil = 0;
        teleportArrivalStats = null;
        reportMinimap(null);
        if (core.locked) {
          core.reset();
          lastLockAt = 0;
          unlockedSince = now;
          report({ scene: true });
        }
        api.log('minimap: anchor cleared on loading screen');
        if (minimapAnchor) api.log(`minimap: selected waypoint saved for arrival x=${minimapAnchor.x.toFixed(1)} y=${minimapAnchor.y.toFixed(1)}`);
        else api.log('minimap: no confirmed waypoint at loading');
        continue;
      }
      if (teleportLoading) {
        teleportNonLoadingSince ??= now;
        if (now - teleportNonLoadingSince < TELEPORT_EXIT_CONFIRM_MS) continue;
        teleportLoading = false;
        teleportNonLoadingSince = null;
        if (minimapAnchor) {
          teleportArrivalUntil = now + TELEPORT_ARRIVAL_MS;
          teleportArrivalStats = { samples: 0, bestCorr: null };
        }
      }
      if (frame.full) {
        const img = frame.full;
        lastSearch = now;
        const wasLocked = core.locked;
        const prior = core.prior;
        const res = core.step(img, performance.now());
        if (res.ok && !wasLocked && !scanAfterMap && !recentlyLocked) {
          teleportSelectionStats = newTeleportSelectionStats();
        }
        if (minimapEnabled && (res.ok || wasLocked || recentlyLocked || scanAfterMap || teleportTarget)) {
          rememberTeleportTarget(img, now);
        }
        recent.push({ t: Date.now(), mode: res.mode, ok: res.ok, inliers: res.inliers, pairs: res.pairs, spread: res.spread, s: res.s, ms: res.ms });
        if (recent.length > 240) recent.shift();
        if (res.ok) {
          // Karte frisch geöffnet (vorher Weltansicht) → Mitte = Spielfigur, Anker für die Minimap
          if (!wasLocked && res.mode !== 'local-recovery' && now - unlockedSince > ANCHOR_AFTER_MS && minimap) {
            minimapAnchor = { x: (img.width / 2 - res.tx) / res.s, y: (img.height / 2 - res.ty) / res.s };
            teleportArrivalUntil = 0;
            teleportArrivalStats = null;
            minimap.stop();
          }
          lastLockAt = Date.now();
          report(res, img.width, img.height);
        } else if (!core.locked) {
          if (wasLocked) {
            lostFrame = { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height, lastS: prior.s };
            unlockedSince = now;
            // Karte sicher zu (ganz anderes Bild): nicht noch 3 s im Nachführ-Takt suchen
            if (res.scene) lastLockAt = 0;
          }
          report(res);
        }
      }
      if (core.locked || !minimapOn) {
        reportMinimap(null);
      } else if (frame.corner) {
        if (minimapAnchor) {
          minimap.start(minimapAnchor.x, minimapAnchor.y, now, !!teleportArrivalUntil);
          minimapAnchor = null;
        }
        const pos = await minimap.step(frame.corner, now);
        if (teleportArrivalStats) {
          teleportArrivalStats.samples++;
          if (Number.isFinite(pos.corr) &&
            (teleportArrivalStats.bestCorr === null || pos.corr > teleportArrivalStats.bestCorr)) {
            teleportArrivalStats.bestCorr = pos.corr;
          }
          if (pos.ok) endTeleportArrival(true);
        }
        reportMinimap(pos);
      }
      if (failures) status('ready', 'status.ready');
      failures = 0;
    } catch (err) {
      failures++;
      stopCapture();
      const detail = `${(err && err.name) || 'Fehler'}: ${(err && err.message) || err}`;
      api.log(`Bildschirmaufnahme fehlgeschlagen (Versuch ${failures}) – ${detail}`);
      status('capture-error', 'status.captureFailed', { error: detail });
      await sleep(Math.min(10000, 1000 * failures));
      continue;
    }
    // kurz nach einem Verlust ist die Karte meist noch offen → im Nachführ-Takt suchen; Minimap im eigenen Takt
    const recentlyLocked = Date.now() - lastLockAt < 3000;
    const fps = core.flow.active ? FLOW_FPS : settings.fps;
    let interval = core.locked || recentlyLocked ? 1000 / fps : settings.searchIntervalMs;
    if (settings.minimap !== false && unlockedSince > 0 && started - unlockedSince < TELEPORT_TARGET_MAX_AGE_MS) {
      interval = Math.min(interval, TELEPORT_SCAN_INTERVAL_MS);
    }
    if (!core.locked && minimap && minimap.active && settings.minimap !== false) {
      const minimapFps = minimap.recovering ? MINIMAP_RECOVERY_FPS : MINIMAP_FPS;
      interval = Math.min(interval, 1000 / minimapFps);
    }
    await sleep(Math.max(0, interval - (performance.now() - started)));
  }
  running = false;
  if (!settings.active) {
    stopCapture();
    if (core) core.reset();
    if (minimap) minimap.stop();
    minimapAnchor = null;
    clearTeleport();
    report(null);
    reportMinimap(null);
    if (matcher) status('paused', 'status.paused');
  }
}

async function applySettings(next) {
  const levelsChanged = settings && (next.levels.join() !== settings.levels.join() || next.tileset.version !== settings.tileset.version);
  settings = next;
  // Minimap aus (Tray/Panel) → Verfolgung beenden, Marker weg
  if (settings.minimap === false && minimap) {
    minimap.stop();
    minimapAnchor = null;
    clearTeleport();
    reportMinimap(null);
  }
  if (levelsChanged) await prepareReference(false);
  if (settings.active && matcher) {
    status('ready', 'status.ready');
    loop();
  }
}

api.on('tracker:settings', (next) => applySettings(next));
api.on('tracker:rebuild', async () => {
  await prepareReference(true);
  if (settings.active) loop();
});
api.on('tracker:restart-capture', () => {
  stopCapture();
  if (core) core.reset();
  if (minimap) minimap.stop();
  minimapAnchor = null;
  clearTeleport();
  reportMinimap(null);
});

(async () => {
  status('loading', 'status.loading');
  cv = await loadCv();
  settings = await api.settings();
  await prepareReference(false);
  if (settings.active) loop();
  else if (matcher) status('paused', 'status.paused');
})();
