// Position der Spielfigur aus der Minimap (Weltansicht), für Marker auf der Minimap.
// Minimap-Kreis gegen ein Kachelbild um die letzte Position, normierte Korrelation (Grauwerte).
// - Start an einem Anker: die große Karte öffnet sich auf die Spielfigur zentriert
// - Minimap ist genordet; Zoom je nach Gegend (offene Welt / Stadt) → Stufe mitbestimmen, sonst nur Verschiebung
// - arbeitet in 1080p-Pixeln: der Tracker skaliert die Ecke oben links (GEOMETRY.corner) auf 1080p
// Läuft im Tracker-Fenster und in der Messbank (Node).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MinimapCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Gemessen bei 1080p (testbilder/clips/welt1, welt2): Spielfigur bei (168, 125), Kartenkreis r ≈ 100.
  // Bildschirmpixel je Kartenpixel (z13): offene Welt 1,2, Stadt 3,6; skaliert mit der Bildhöhe
  const GEOMETRY = { cx: 168, cy: 125, radius: 100, scales: [1.2, 3.6], corner: { x: 0, y: 0, w: 420, h: 330 } };
  const LOADING_SAMPLE = { width: 96, height: 54 };

  function isLoadingScreen({ data, width, height }) {
    const pixel = (x, y) => 4 * (Math.floor(y * height) * width + Math.floor(x * width));
    const sample = pixel(0.08, 0.15);
    const light = data[sample] >= 249 && data[sample + 1] >= 249 && data[sample + 2] >= 249;
    const background = light ? [255, 255, 255] : [27, 29, 32];
    // Both loading themes have flat edges, a centered emblem, and a tip below.
    // A plain fade without the emblem and tip does not qualify.
    for (const y of [0.15, 0.35, 0.65, 0.8]) {
      for (const x of [0.08, 0.2, 0.8, 0.92]) {
        const i = pixel(x, y);
        if (background.some((channel, c) => Math.abs(data[i + c] - channel) > 6)) return false;
      }
    }
    const hasForeground = (left, top, right, bottom) => {
      let count = 0;
      for (let y = Math.floor(top * height); y < Math.ceil(bottom * height); y++) {
        for (let x = Math.floor(left * width); x < Math.ceil(right * width); x++) {
          const i = 4 * (y * width + x);
          const foreground = light ? data[i] <= 220 && data[i + 1] <= 225 : data[i] >= 75 && data[i + 1] >= 65;
          if (foreground && ++count >= 6) return true;
        }
      }
      return false;
    };
    return hasForeground(0.44, 0.38, 0.56, 0.56)
      && hasForeground(0.24, 0.76, 0.76, 0.94);
  }

  // - tplRadius: Vergleichskreis innerhalb des Rings, arrowRadius: Pfeil der Spielfigur ausblenden
  // - search: Suchweite je Schritt (px), margin: Vorrat des Kachelbilds rundum (px)
  // - minCorr: darunter unsicher (nichts anzeigen), lostMs: so lange unsicher → seltener weitersuchen
  // - maxJump: größerer Sprung je Schritt gilt als Fehltreffer (px)
  // - zoomCheckEvery: so oft (Schritte) auch die anderen Zoomstufen prüfen, zoomCheckBelow: bei schwächerer Korrelation immer
  // - zoomSwitchCorr/zoomSwitchMargin: Wechsel nur bei so guter Korrelation und so viel Vorsprung
  // - waitRender: auf neues Kachelbild warten statt im Hintergrund (Messbank)
  const DEFAULTS = {
    tplRadius: 86, arrowRadius: 18, search: 24, margin: 160, minCorr: 0.5, lostMs: 3000, maxJump: 40,
    zoomCheckEvery: 8, zoomCheckBelow: 0.8, zoomSwitchCorr: 0.75, zoomSwitchMargin: 0.08,
    holdMs: 350, reacquireMs: 600, motionMaxAgeMs: 900, waitRender: false,
  };

  const MOTION_RADIUS = 8;
  const MOTION_MIN_CORR = 0.75;
  const MOTION_MAX_FRAME_GAP_MS = 220;

  function mapSignal(cv, rgba, width, height) {
    // The camera cone changes brightness. Relative red/blue contrast keeps
    // coastlines and terrain colors useful when it rotates across the minimap.
    const mat = new cv.Mat(height, width, cv.CV_32F);
    const values = mat.data32F;
    for (let i = 0; i < values.length; i++) {
      const r = rgba[i * 4];
      const b = rgba[i * 4 + 2];
      values[i] = (r - b) / (r + b + 8);
    }
    return mat;
  }

  class MinimapTracker {
    // render(cx, cy, scale, size) → Promise<{ data (RGBA), width, height }>: Kachelbild size×size um Kartenpunkt cx/cy
    constructor(cv, render, options) {
      this.cv = cv;
      this.render = render;
      this.o = { ...DEFAULTS, ...(options || {}) };
      const R = this.o.tplRadius;
      this.mask = new cv.Mat(2 * R, 2 * R, cv.CV_8U, new cv.Scalar(0));
      cv.circle(this.mask, new cv.Point(R, R), R - 3, new cv.Scalar(255), -1);
      cv.circle(this.mask, new cv.Point(R, R), this.o.arrowRadius, new cv.Scalar(0), -1);
      const radius = Math.min(48, R - MOTION_RADIUS);
      const offset = R - radius;
      this.motionRect = new cv.Rect(offset, offset, 2 * radius, 2 * radius);
      this.motionSearchRect = new cv.Rect(offset - MOTION_RADIUS, offset - MOTION_RADIUS,
        2 * (radius + MOTION_RADIUS), 2 * (radius + MOTION_RADIUS));
      this.motionMask = this.mask.roi(this.motionRect);
      this.motionFrame = null;
      this.regions = new Map();
      this.rendering = new Map();
      this.pos = null;
      this.scale = null;
      this.lastGood = 0;
      this.recovering = false;
      this.steps = 0;
    }

    get active() {
      return !!this.pos;
    }

    start(x, y, now) {
      this.clearMotion();
      this.pos = { x, y };
      this.lastGood = now;
      this.recovering = false;
      this.fresh = true;
      this.needsConfirmation = true;
      this.confirmSince = null;
    }

    stop() {
      this.clearMotion();
      this.pos = null;
      this.recovering = false;
    }

    clearMotion() {
      if (this.motionFrame) this.motionFrame.delete();
      this.motionFrame = null;
    }

    rememberMotion(tpl, now) {
      this.clearMotion();
      const search = tpl.roi(this.motionSearchRect);
      this.motionFrame = search.clone();
      search.delete();
      this.motionAt = now;
    }

    predictMotion(tpl, now) {
      if (!this.motionFrame || this.needsConfirmation || now - this.motionAt > MOTION_MAX_FRAME_GAP_MS) return null;
      const cv = this.cv;
      const inner = tpl.roi(this.motionRect);
      const out = new cv.Mat();
      try {
        cv.matchTemplate(this.motionFrame, inner, out, cv.TM_CCOEFF_NORMED, this.motionMask);
        const { maxVal, maxLoc } = cv.minMaxLoc(out);
        const dx = maxLoc.x - MOTION_RADIUS;
        const dy = maxLoc.y - MOTION_RADIUS;
        if (!Number.isFinite(maxVal) || maxVal < MOTION_MIN_CORR || Math.hypot(dx, dy) >= MOTION_RADIUS) return null;
        return { x: this.pos.x + dx / this.scale, y: this.pos.y + dy / this.scale };
      } finally {
        inner.delete();
        out.delete();
      }
    }

    // Kachelbild (Grau, float) je Zoomstufe um p, groß genug für Vergleichskreis + Suche + Vorrat.
    // Neu rendern läuft im Hintergrund (erstes Laden der Kacheln dauert bis ~1 s), solange gilt das alte.
    // wait: auf das Rendern warten (Messbank, für wiederholbare Ergebnisse)
    async ensureRegion(p, s, wait) {
      const r = this.regions.get(s);
      const keep = this.o.margin - this.o.search;
      if (r && Math.abs(p.x - r.x) * s < keep && Math.abs(p.y - r.y) * s < keep) return;
      if (!this.rendering.has(s)) {
        const size = 2 * (this.o.tplRadius + this.o.margin);
        const at = { x: p.x, y: p.y };
        this.rendering.set(s, this.render(at.x, at.y, s, size).then((img) => {
          const cv = this.cv;
          const f = mapSignal(cv, img.data, img.width, img.height);
          const old = this.regions.get(s);
          if (old) old.mat.delete();
          this.regions.set(s, { x: at.x, y: at.y, size, mat: f });
        }).finally(() => { this.rendering.delete(s); }));
      }
      if (wait) await this.rendering.get(s);
    }

    // Vergleich bei Zoomstufe s um die letzte Position → { corr, x, y } oder null (Kachelbild fehlt/zu klein)
    match(tpl, s, S, pos = this.pos) {
      const cv = this.cv;
      const R = this.o.tplRadius;
      const reg = this.regions.get(s);
      if (!reg) return null;
      const half = reg.size / 2;
      const px = half + (pos.x - reg.x) * s;
      const py = half + (pos.y - reg.y) * s;
      const x0 = Math.max(0, Math.round(px - R - S));
      const y0 = Math.max(0, Math.round(py - R - S));
      const x1 = Math.min(reg.size, Math.round(px + R + S));
      const y1 = Math.min(reg.size, Math.round(py + R + S));
      if (x1 - x0 <= 2 * R || y1 - y0 <= 2 * R) return null;
      const win = reg.mat.roi(new cv.Rect(x0, y0, x1 - x0, y1 - y0));
      const out = new cv.Mat();
      cv.matchTemplate(win, tpl, out, cv.TM_CCOEFF_NORMED, this.mask);
      const mm = cv.minMaxLoc(out);
      // Sub-Pixel: Parabel durch die Nachbarn der Spitze
      const at = (x, y) => out.floatAt(y, x);
      const { x: mxl, y: myl } = mm.maxLoc;
      let fx = 0;
      let fy = 0;
      if (mxl > 0 && mxl < out.cols - 1) {
        const a = at(mxl - 1, myl), b = at(mxl, myl), c = at(mxl + 1, myl);
        const d = a - 2 * b + c;
        if (d < 0) fx = Math.max(-0.5, Math.min(0.5, (a - c) / (2 * d)));
      }
      if (myl > 0 && myl < out.rows - 1) {
        const a = at(mxl, myl - 1), b = at(mxl, myl), c = at(mxl, myl + 1);
        const d = a - 2 * b + c;
        if (d < 0) fy = Math.max(-0.5, Math.min(0.5, (a - c) / (2 * d)));
      }
      win.delete();
      out.delete();
      // Mitte des Treffers im Kachelbild → Kartenpixel
      return { corr: mm.maxVal, x: reg.x + (x0 + mxl + fx + R - half) / s, y: reg.y + (y0 + myl + fy + R - half) / s };
    }

    // corner = Ecke oben links in 1080p-Pixeln ({ data (RGBA), width, height }), now in ms
    async step(corner, now) {
      if (!this.pos) return { ok: false };
      const cv = this.cv;
      const R = this.o.tplRadius;
      // erster Schritt nach dem Anker: weiter suchen (Figur kann sich beim Schließen der Karte schon bewegt haben)
      const S = this.fresh ? this.o.search * 2 : this.needsConfirmation ? this.o.search
        : Math.min(this.o.search, Math.ceil(4 + (now - this.lastGood) * 0.025));
      // nach Anker/Verlust alle Zoomstufen, sonst die aktuelle und ab und zu die anderen (Stadt betreten/verlassen)
      this.steps++;
      const sure = this.scale && !this.fresh && !this.recovering && this.lastCorr >= this.o.zoomCheckBelow;
      const scales = sure && this.steps % this.o.zoomCheckEvery ? [this.scale] : GEOMETRY.scales;
      await Promise.all(scales.map((s) => this.ensureRegion(this.pos, s, this.o.waitRender)));

      const signal = mapSignal(cv, corner.data, corner.width, corner.height);
      const tpl = signal.roi(new cv.Rect(GEOMETRY.cx - R, GEOMETRY.cy - R, 2 * R, 2 * R));
      signal.delete();
      try {
        return this.locate(tpl, scales, S, now);
      } finally {
        tpl.delete();
      }
    }

    locate(tpl, scales, S, now) {
      const motion = this.predictMotion(tpl, now);
      let best = null;
      let current = null;
      for (const s of scales) {
        const predicted = motion && s === this.scale;
        const m = predicted ? this.match(tpl, s, 10, motion) : this.match(tpl, s, S);
        const correction = predicted && m ? Math.hypot(m.x - motion.x, m.y - motion.y) * s : 0;
        if (correction > 10 || (correction > 5 && m.corr < 0.7)) continue;
        if (!m || !Number.isFinite(m.corr)) continue;
        if (s === this.scale) current = { ...m, s };
        if (!best || m.corr > best.corr) best = { ...m, s };
      }
      if (!best) return this.useMotion(tpl, now, motion, NaN);
      // Zoom nur wechseln, wenn die andere Stufe deutlich besser passt, und das zweimal hintereinander
      // (sonst springt die Figur bei unscharfer Minimap, z. B. 768p, auf einen Zufallstreffer)
      if (this.scale && !this.fresh && best.s !== this.scale) {
        const clear = best.corr >= this.o.zoomSwitchCorr && best.corr - (current ? current.corr : 0) >= this.o.zoomSwitchMargin;
        if (!(clear && this.zoomVote === best.s)) {
          this.zoomVote = clear ? best.s : null;
          if (current) best = current;
          else return this.useMotion(tpl, now, motion, best.corr);
        } else {
          this.zoomVote = null;
        }
      } else {
        this.zoomVote = null;
      }
      this.lastCorr = best.corr;
      const jump = Math.hypot(best.x - this.pos.x, best.y - this.pos.y) * best.s;
      const minCorr = this.fresh ? Math.max(this.o.minCorr, 0.7) : this.o.minCorr;
      if (best.corr < minCorr) return this.useMotion(tpl, now, motion, best.corr);
      if (!this.fresh && best.s === this.scale && jump > this.o.maxJump) return this.unsure(now, best.corr);
      // Isolated matches after an interruption can come from a different, similar-looking area.
      if (this.needsConfirmation) {
        this.confirmSince ??= now;
        if (now - this.confirmSince < this.o.reacquireMs) return { ok: false, corr: best.corr };
        this.needsConfirmation = false;
        this.confirmSince = null;
      }
      this.pos = { x: best.x, y: best.y };
      this.scale = best.s;
      this.lastGood = now;
      this.recovering = false;
      this.fresh = false;
      this.rememberMotion(tpl, now);
      return { ok: true, x: best.x, y: best.y, scale: best.s, corr: best.corr };
    }

    useMotion(tpl, now, motion, corr) {
      if (!motion || now - this.lastGood > this.o.motionMaxAgeMs) return this.unsure(now, corr);
      this.pos = motion;
      this.rememberMotion(tpl, now);
      return { ok: true, ...motion, scale: this.scale, corr };
    }

    unsure(now, corr) {
      this.clearMotion();
      const sinceMatch = now - this.lastGood;
      // Keep the confirmed pose briefly through weak frames. The loading-screen
      // detector stops the tracker immediately when the old pose is invalid.
      if (!this.needsConfirmation && sinceMatch <= this.o.holdMs) {
        return { ok: true, x: this.pos.x, y: this.pos.y, scale: this.scale, corr };
      }
      // Nach einem Menü ist die letzte Position weiterhin ein brauchbarer Suchanker.
      this.recovering = sinceMatch > this.o.lostMs;
      this.needsConfirmation = true;
      this.confirmSince = null;
      return { ok: false, corr, lost: this.recovering };
    }
  }

  return { MinimapTracker, GEOMETRY, DEFAULTS, LOADING_SAMPLE, isLoadingScreen };
});
