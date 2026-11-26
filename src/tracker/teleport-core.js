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
    for (const x of [panel + 24 * scale, width - 38 * scale]) {
      if (!dark(at(x, 39 * scale)) || !pale(at(x, 460 * scale)) ||
        !pale(at(x, 560 * scale))) return null;
    }
    if (!dark(at(panel + 85 * scale, 666 * scale)) &&
      !dark(at(width - 80 * scale, 666 * scale))) return null;
    if (diagnostics) diagnostics.panels++;

    const offsets = angles.map((angle) => [19, 20.5, 22].map((radius) =>
      4 * (Math.round(scale * radius * Math.cos(angle)) +
        width * Math.round(scale * radius * Math.sin(angle)))));
    const ringAt = (i) => data[i] >= 135 && data[i] <= 205 && data[i + 1] >= 165 &&
      data[i + 2] >= 160 && data[i + 1] - data[i] >= 8;
    const hit = (center, ray) => ringAt(center + ray[0]) || ringAt(center + ray[1]) || ringAt(center + ray[2]);
    const edge = Math.ceil(24 * scale);
    const findRing = (covered) => {
      const candidates = [];
      for (let y = edge; y < height - edge; y++) {
        for (let x = edge; x < panel - edge; x++) {
          const center = at(x, y);
          if (covered) {
            if (!hit(center, offsets[0]) || !hit(center, offsets[4]) ||
              !hit(center, offsets[8]) || !hit(center, offsets[12])) continue;
          } else {
            if (data[center] < 205 || data[center + 1] < 215 || data[center + 2] < 210) continue;
            if (![4, 6, 8].some((dy) => blue(at(x, y - dy * scale)))) continue;
          }
          let score = 0;
          for (const ray of offsets) if (hit(center, ray)) score++;
          if (score >= (covered ? 14 : 12)) candidates.push({ x, y, score });
        }
      }
      candidates.sort((a, b) => b.score - a.score);
      const best = candidates[0];
      if (best && candidates.some((p) => p.score >= best.score - 1 &&
        Math.hypot(p.x - best.x, p.y - best.y) > edge)) return null;
      return best;
    };
    // Other overlay icons may cover the pin. In that case require the blue
    // waypoint icon in the panel header and stronger evidence of the ring.
    const best = findRing(false) || (blue(at(panel + 23 * scale, 20 * scale)) && findRing(true));
    return best ? { x: best.x, y: best.y, mapWidth: panel } : null;
  }

  return { selectedWaypoint };
});
