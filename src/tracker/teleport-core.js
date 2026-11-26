// Screen-space waypoint selection on the world map.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TeleportCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const angles = Array.from({ length: 16 }, (_, i) => i * Math.PI / 8);

  function selectedWaypoint({ data, width, height }) {
    const scale = height / 720;
    const panel = width - Math.round(328 * scale);
    const at = (x, y) => 4 * (Math.round(y) * width + Math.round(x));
    const pale = (i) => data[i] >= 185 && data[i + 1] >= 180 && data[i + 2] >= 160;
    const dark = (i) => data[i] < 115 && data[i + 1] < 125 && data[i + 2] < 145;
    for (const x of [panel + 24 * scale, width - 38 * scale]) {
      if (!dark(at(x, 39 * scale)) || !pale(at(x, 460 * scale)) ||
        !pale(at(x, 560 * scale))) return null;
    }
    if (!dark(at(panel + 85 * scale, 666 * scale)) &&
      !dark(at(width - 80 * scale, 666 * scale))) return null;

    const offsets = angles.map((angle) => [19, 20.5, 22].map((radius) => [
      Math.round(scale * radius * Math.cos(angle)),
      Math.round(scale * radius * Math.sin(angle)),
    ]));
    const edge = Math.ceil(24 * scale);
    let best = null;
    for (let y = edge; y < height - edge; y++) {
      for (let x = edge; x < panel - edge; x++) {
        const center = at(x, y);
        if (data[center] < 205 || data[center + 1] < 215 || data[center + 2] < 210) continue;
        if (![4, 6, 8].some((dy) => {
          const i = at(x, y - dy * scale);
          return data[i + 1] >= 85 && data[i + 2] >= 105 && data[i + 2] - data[i] >= 35;
        })) continue;
        let score = 0;
        for (const ray of offsets) {
          if (ray.some(([dx, dy]) => {
            const i = at(x + dx, y + dy);
            return data[i] >= 135 && data[i] <= 205 && data[i + 1] >= 165 &&
              data[i + 2] >= 160 && data[i + 1] - data[i] >= 8;
          })) score++;
        }
        if (score >= 12 && (!best || score > best.score)) best = { x, y, score };
      }
    }
    return best ? { x: best.x, y: best.y, mapWidth: panel } : null;
  }

  return { selectedWaypoint };
});
