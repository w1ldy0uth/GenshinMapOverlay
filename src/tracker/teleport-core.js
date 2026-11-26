// Screen-space waypoint selection on the world map.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TeleportCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const angles = Array.from({ length: 16 }, (_, i) => i * Math.PI / 8);

  function selectedWaypoint({ data, width, height }, diagnostics) {
    const scale = height / 720;
    const panel = width - Math.round(328 * scale);
    const at = (x, y) => 4 * (Math.round(y) * width + Math.round(x));
    const pale = (i) => data[i] >= 185 && data[i + 1] >= 180 && data[i + 2] >= 160;
    const dark = (i) => data[i] < 115 && data[i + 1] < 125 && data[i + 2] < 145;
    const blue = (i) => data[i + 1] >= 85 && data[i + 2] >= 105 && data[i + 2] - data[i] >= 35;
    const statueBlue = (i) => data[i] >= 105 && data[i] <= 195 &&
      data[i + 1] >= 210 && data[i + 2] >= 220 && data[i + 1] - data[i] >= 40;
    for (const x of [panel + 24 * scale, width - 38 * scale]) {
      if (!dark(at(x, 39 * scale)) || !pale(at(x, 460 * scale)) ||
        !pale(at(x, 560 * scale))) return null;
    }
    if (!dark(at(panel + 85 * scale, 666 * scale)) &&
      !dark(at(width - 80 * scale, 666 * scale))) return null;
    if (diagnostics) diagnostics.panels++;

    // A Statue of the Seven uses a cyan orb and a neutral ring.
    const statue = statueBlue(at(panel + 23 * scale, 20 * scale)) &&
      statueBlue(at(panel + 26 * scale, 20 * scale));
    const radii = statue ? [19, 20, 21, 22, 23] : [18, 20, 22, 24];
    const offsets = angles.map((angle) => radii.map((radius) =>
      4 * (Math.round(scale * radius * Math.cos(angle)) +
        width * Math.round(scale * radius * Math.sin(angle)))));
    const ringAt = (i) => data[i] >= 125 && data[i] <= 215 && data[i + 1] >= 155 &&
      data[i + 2] >= 150 && data[i + 1] - data[i] >= 7;
    const statueRingAt = (i) => data[i] >= 175 && data[i + 1] >= 175 && data[i + 2] >= 155 &&
      Math.abs(data[i + 1] - data[i]) <= 28 && Math.abs(data[i + 2] - data[i]) <= 42;
    const edge = Math.ceil(25 * scale);
    const findRing = (covered, statue = false) => {
      const matchesRing = statue ? statueRingAt : ringAt;
      const hit = (center, ray) => matchesRing(center + ray[0]) || matchesRing(center + ray[1]) ||
        matchesRing(center + ray[2]) || matchesRing(center + ray[3]) ||
        (statue && matchesRing(center + ray[4]));
      const candidates = [];
      let bestScore = 0;
      for (let y = edge; y < height - edge; y++) {
        for (let x = edge; x < panel - edge; x++) {
          const center = at(x, y);
          if (statue) {
            if (!statueBlue(at(x - 3 * scale, y - 4 * scale)) ||
              !statueBlue(at(x + 3 * scale, y - 4 * scale))) continue;
          } else if (covered) {
            const axisHits = Number(hit(center, offsets[0])) + Number(hit(center, offsets[4])) +
              Number(hit(center, offsets[8])) + Number(hit(center, offsets[12]));
            if (axisHits < 3) continue;
          } else {
            if (data[center] < 205 || data[center + 1] < 215 || data[center + 2] < 210) continue;
            if (![4, 6, 8].some((dy) => blue(at(x, y - dy * scale)))) continue;
          }
          let score = 0;
          for (const ray of offsets) if (hit(center, ray)) score++;
          bestScore = Math.max(bestScore, score);
          if (score >= (covered || statue ? 13 : 12)) candidates.push({ x, y, score });
        }
      }
      if (diagnostics) diagnostics.bestRing = Math.max(diagnostics.bestRing, bestScore);
      candidates.sort((a, b) => b.score - a.score);
      const best = candidates[0];
      if (best && candidates.some((p) => p.score >= best.score - 1 &&
        Math.hypot(p.x - best.x, p.y - best.y) > edge)) return null;
      return best;
    };
    // Other overlay icons may cover the pin. In that case require the blue
    // waypoint icon in the panel header and stronger evidence of the ring.
    const headerIcon = [19, 22, 25, 28].some((x) =>
      [17, 20, 23, 26].some((y) => blue(at(panel + x * scale, y * scale))));
    if (headerIcon && diagnostics) diagnostics.headers++;
    const best = statue ? findRing(false, true) : findRing(false) || (headerIcon && findRing(true));
    return best ? { x: best.x, y: best.y, mapWidth: panel } : null;
  }

  return { selectedWaypoint };
});
