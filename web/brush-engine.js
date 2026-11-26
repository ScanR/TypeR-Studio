// The brushes of the library, drawn: a stroke of a brush made of pictures (its tips), as Clip
// Studio Paint's sub tools are, with what moves along the stroke (pressure, speed, chance), a
// ribbon or a spray of its tips, a paper texture, and a start and an end that taper.
// Nothing here touches the page: a stroke is a picture of its own, in tiles of floats, which
// photoshop.js lays on the layer (see beginPreset there). It runs in tests as it does in the app.
//
//   a brush     { settings, tips, texture }: see brushOf in csp.js for the settings; a tip is a
//               picture { width, height, alpha, gray?, rgb? }, the texture one too, with its own
//               settings beside it.
//   a stroke    begin(brush, { color, sub, size, opacity, seed }), then add(x, y, pressure,
//               time…) for each point of the pointer and end(). Each gives back the rectangle
//               of the page it changed. read(left, top, width, height, out) gives its pixels:
//               r, g, b (0 to 255, straight) and a (0 to 1), four floats each.
//   the tips    with alpha alone, a tip paints the colour; with grey, black is the colour and
//               white the second one (`sub`: the background colour); with rgb, its own.
//   along it    dabs a gap apart, each with its own size, flow, thickness, angle and tip; or,
//               a ribbon: the tip laid along the stroke as a band, its top where the stroke
//               starts (a tip that follows the line points the same way: undisturbed when the
//               stroke goes down the page); or a spray: at each step, tips thrown within the
//               brush's size.
//   in a stroke dabs build up by their flow; the opacity is the most the stroke reaches.
//   the end     a taper at the end (or one given in percent) needs the stroke's length: the
//               stroke is drawn again from its points when it ends. What chance decides comes
//               from a seed, so that it is drawn the same.

(function (root, factory) {
  const made = factory();
  if (typeof module === "object" && module.exports) module.exports = made;
  else root.TypeRBrushEngine = made;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const TILE = 64;
  const KEY = 32768;
  const clamp = (value, low, high) => (value < low ? low : value > high ? high : value);
  const mulberry = (seed) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  /* --------------------------------- what moves a setting --------------------------------- */

  // A curve through its points as Clip Studio draws it: the first and the last are reached,
  // the others pull it (a quadratic spline). Read from a table of 257 values.
  const CURVE_STEPS = 256;
  const curveTable = (points) => {
    const table = new Float32Array(CURVE_STEPS + 1);
    const p = points.slice().sort((a, b) => a[0] - b[0]);
    const samples = [];
    if (p.length === 2) samples.push(p[0], p[1]);
    else {
      const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      for (let i = 1; i < p.length - 1; i++) {
        const from = i === 1 ? p[0] : mid(p[i - 1], p[i]);
        const to = i === p.length - 2 ? p[i + 1] : mid(p[i], p[i + 1]);
        for (let k = 0; k <= 24; k++) {
          const t = k / 24;
          const u = 1 - t;
          samples.push([u * u * from[0] + 2 * u * t * p[i][0] + t * t * to[0], u * u * from[1] + 2 * u * t * p[i][1] + t * t * to[1]]);
        }
      }
    }
    let k = 0;
    for (let i = 0; i <= CURVE_STEPS; i++) {
      const x = i / CURVE_STEPS;
      while (k < samples.length - 2 && samples[k + 1][0] < x) k++;
      const a = samples[k];
      const b = samples[k + 1];
      const f = b[0] > a[0] ? clamp((x - a[0]) / (b[0] - a[0]), 0, 1) : x >= b[0] ? 1 : 0;
      table[i] = clamp(a[1] + (b[1] - a[1]) * f, 0, 1);
    }
    return table;
  };
  const along = (table, x) => table[Math.round(clamp(x, 0, 1) * CURVE_STEPS)];
  const LINE = curveTable([[0, 0], [1, 1]]);
  const FALL = curveTable([[0, 1], [1, 0]]);
  // One setting's movers, made ready: (pen) => a share of its value, 0 to 1
  const mover = (effector) => {
    if (!effector) return null;
    const parts = [];
    const input = (name, read, fallback) => {
      const item = effector[name];
      if (!item) return;
      const table = item.curve ? curveTable(item.curve) : fallback;
      const min = item.min;
      // What the pointer doesn't say (a mouse has no tilt) moves nothing
      parts.push((pen) => {
        const value = read(pen);
        return value === null ? 1 : min + (1 - min) * along(table, value);
      });
    };
    input("pressure", (pen) => pen.pressure, LINE);
    input("tilt", (pen) => pen.tilt, LINE);
    input("velocity", (pen) => pen.speed, FALL);
    if (effector.random) {
      const min = effector.random.min;
      parts.push((pen) => 1 - (1 - min) * pen.random());
    }
    if (!parts.length) return null;
    return (pen) => {
      let value = 1;
      for (let i = 0; i < parts.length; i++) value *= parts[i](pen);
      return value;
    };
  };

  /* --------------------------------- tips --------------------------------- */

  // A tip at every size down to a few pixels, each half the one before: a small dab reads
  // the one nearest its own size. Kept as bytes: a tip can be thousands of pixels long.
  const levelsOf = (picture) => {
    const levels = [];
    let { width, height } = picture;
    let alpha = picture.alpha;
    // Grey (how much of the second colour) and rgb, both weighed by the alpha they go with
    let gray = picture.gray ? Uint8Array.from(picture.gray, (value, i) => Math.round((value * alpha[i]) / 255)) : null;
    let rgb = picture.rgb ? Uint8Array.from(picture.rgb, (value, i) => Math.round((value * alpha[(i / 3) | 0]) / 255)) : null;
    for (;;) {
      levels.push({ width, height, alpha, gray, rgb });
      if (width <= 2 || height <= 2) break;
      const w = width >> 1;
      const h = height >> 1;
      const fromWidth = width;
      const half = (plane, n) => {
        if (!plane) return null;
        const out = new Uint8Array(w * h * n);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            for (let c = 0; c < n; c++) {
              const at = (y * 2 * fromWidth + x * 2) * n + c;
              out[(y * w + x) * n + c] = (plane[at] + plane[at + n] + plane[at + fromWidth * n] + plane[at + fromWidth * n + n] + 2) >> 2;
            }
          }
        }
        return out;
      };
      alpha = half(alpha, 1);
      gray = half(gray, 1);
      rgb = half(rgb, 3);
      width = w;
      height = h;
    }
    return levels;
  };
  // A round tip, drawn rather than read: full to its hardness, then falling along a cosine
  const ROUND = { round: true };

  const prepared = new WeakMap();
  const prepare = (brush) => {
    let made = prepared.get(brush);
    if (made) return made;
    const s = brush.settings;
    const tips = (brush.tips || []).filter((tip) => tip && tip.alpha && tip.width > 0 && tip.height > 0).map((tip) => ({ width: tip.width, height: tip.height, levels: levelsOf(tip), gray: Boolean(tip.gray), rgb: Boolean(tip.rgb) }));
    made = {
      tips: tips.length ? tips : [ROUND],
      mode: tips.some((tip) => tip.rgb) ? "rgb" : tips.some((tip) => tip.gray) ? "gray" : "alpha",
      move: {},
      texture: null,
    };
    Object.keys(s.dyn || {}).forEach((name) => {
      made.move[name] = mover(s.dyn[name]);
    });
    const paper = brush.texture;
    if (paper && paper.alpha && paper.width > 0) {
      // How much paint the paper takes, 0 to 1: all of it where its picture is black, none
      // where it is white or empty. A screentone brush is that: a round tip, and the tone as
      // its paper.
      const light = new Float32Array(paper.width * paper.height);
      for (let i = 0; i < light.length; i++) {
        let lum = paper.rgb ? (0.299 * paper.rgb[i * 3] + 0.587 * paper.rgb[i * 3 + 1] + 0.114 * paper.rgb[i * 3 + 2]) / 255 : paper.gray ? paper.gray[i] / 255 : 0;
        lum = clamp(lum + (paper.brightness || 0), 0, 1);
        lum = clamp(0.5 + (lum - 0.5) * (1 + (paper.contrast || 0)), 0, 1);
        let v = (1 - lum) * (paper.alpha[i] / 255);
        if (paper.emphasize) v = clamp(0.5 + (v - 0.5) * 2, 0, 1);
        light[i] = paper.invert ? 1 - v : v;
      }
      const turn = ((paper.rotate || 0) * Math.PI) / 180;
      made.texture = { light, width: paper.width, height: paper.height, scale: paper.scale || 1, cos: Math.cos(turn), sin: Math.sin(turn), density: paper.density, mode: paper.mode, perDab: Boolean(paper.perDab) };
    }
    prepared.set(brush, made);
    return made;
  };
  // How much of the paint the paper takes at a point of the page, 0 to 1
  const paperAt = (texture, x, y, density) => {
    const u = (x * texture.cos + y * texture.sin) / texture.scale;
    const v = (-x * texture.sin + y * texture.cos) / texture.scale;
    const w = texture.width;
    const h = texture.height;
    let tx = Math.floor(u) % w;
    let ty = Math.floor(v) % h;
    if (tx < 0) tx += w;
    if (ty < 0) ty += h;
    return 1 - density * (1 - texture.light[ty * w + tx]);
  };
  // The paper on a pixel's paint `a`, by the texture's mode
  const papered = (texture, a, x, y, density) => {
    const pass = paperAt(texture, x, y, density);
    switch (texture.mode) {
      case "subtract":
      case "outline": return Math.max(0, a - (1 - pass));
      case "compare": return Math.min(a, pass);
      default: return a * pass;
    }
  };

  /* --------------------------------- a stroke --------------------------------- */

  const begin = (brush, options = {}) => {
    const s = brush.settings;
    const ready = prepare(brush);
    const mode = ready.mode;
    const scale = options.size > 0 ? options.size / s.size : 1;
    const baseSize = s.size * scale;
    const opacity = options.opacity === undefined ? s.opacity : options.opacity;
    const color = options.color || [0, 0, 0];
    const sub = options.sub || [255, 255, 255];
    const seed = options.seed === undefined ? (Math.random() * 4294967296) >>> 0 : options.seed;
    const hard = s.antialias === 0;
    const perDabPaper = ready.texture && ready.texture.perDab;
    const lineTurned = Boolean(s.angleBy && s.angleBy.line);
    const needsDirection = s.ribbon || lineTurned || Boolean(s.spray && (s.spray.angleBy.line || s.spray.angleBy.spray));
    const taper = s.taper || null;
    // Drawn once more at the end when how it ends changes how it is drawn all along
    const redrawn = Boolean(taper && (taper.out > 0 || taper.type === 1));

    let tiles = new Map();
    let bounds = null;
    let random = mulberry(seed);
    const inputs = [];

    const tileAt = (tx, ty) => {
      const key = (ty + 16384) * KEY + tx + 16384;
      let tile = tiles.get(key);
      if (!tile) {
        tile = { a: new Float32Array(TILE * TILE), m: mode === "gray" ? new Float32Array(TILE * TILE) : null, c: mode === "rgb" ? new Float32Array(TILE * TILE * 3) : null };
        tiles.set(key, tile);
      }
      return tile;
    };
    const grow = (box, left, top, right, bottom) => {
      if (!box) return { left, top, right, bottom };
      if (left < box.left) box.left = left;
      if (top < box.top) box.top = top;
      if (right > box.right) box.right = right;
      if (bottom > box.bottom) box.bottom = bottom;
      return box;
    };
    let dirty = null;
    // A watercolor edge is read from around each pixel: what changes reaches that far
    const rim = s.edge ? Math.max(1, Math.round(s.edge.width * scale)) : 0;
    const touched = (left, top, right, bottom) => {
      dirty = grow(dirty, left - rim, top - rim, right + rim, bottom + rim);
      bounds = grow(bounds, left - rim, top - rim, right + rim, bottom + rim);
    };
    // The stroke's paint alone over a rectangle, one float a pixel
    const paintOver = (left, top, width, height) => {
      const out = new Float32Array(width * height);
      for (let ty = Math.floor(top / TILE); ty * TILE < top + height; ty++) {
        for (let tx = Math.floor(left / TILE); tx * TILE < left + width; tx++) {
          const tile = tiles.get((ty + 16384) * KEY + tx + 16384);
          if (!tile) continue;
          const x0 = Math.max(left, tx * TILE);
          const x1 = Math.min(left + width, (tx + 1) * TILE);
          for (let py = Math.max(top, ty * TILE); py < Math.min(top + height, (ty + 1) * TILE); py++) {
            const from = (py - ty * TILE) * TILE + (x0 - tx * TILE);
            out.set(tile.a.subarray(from, from + x1 - x0), (py - top) * width + (x0 - left));
          }
        }
      }
      return out;
    };
    // How much darker the stroke is along its edge, as ink pools at the rim of a wash: where
    // the paint is denser than it is on average around, 0 to 1 a pixel
    const edgeOver = (left, top, width, height) => {
      const w = width + rim * 2;
      const h = height + rim * 2;
      const a = paintOver(left - rim, top - rim, w, h);
      const across = new Float32Array(w * h);
      const norm = 1 / (rim * 2 + 1);
      for (let y = 0; y < h; y++) {
        let sum = 0;
        for (let x = 0; x < Math.min(w, rim * 2 + 1); x++) sum += a[y * w + x];
        for (let x = rim; x < w - rim; x++) {
          across[y * w + x] = sum * norm;
          if (x + rim + 1 < w) sum += a[y * w + x + rim + 1] - a[y * w + x - rim];
        }
      }
      const out = new Float32Array(width * height);
      for (let x = rim; x < w - rim; x++) {
        let sum = 0;
        for (let y = 0; y < Math.min(h, rim * 2 + 1); y++) sum += across[y * w + x];
        for (let y = rim; y < h - rim; y++) {
          const here = a[y * w + x];
          out[(y - rim) * width + (x - rim)] = here > 0 ? clamp((here - sum * norm) * 2.5, 0, 1) : 0;
          if (y + rim + 1 < h) sum += across[(y + rim + 1) * w + x] - across[(y - rim) * w + x];
        }
      }
      return out;
    };

    // One pixel takes a dab's paint: `d` how much, `g` its share of the second colour (or its
    // red), with `g2`, `g3` green and blue
    const lay = (tile, i, d, g, g2, g3) => {
      const a = tile.a[i];
      if (s.darken) {
        if (d <= a) return;
        tile.a[i] = d;
        if (tile.m) tile.m[i] = g * d;
        else if (tile.c) {
          tile.c[i * 3] = g * d;
          tile.c[i * 3 + 1] = g2 * d;
          tile.c[i * 3 + 2] = g3 * d;
        }
        return;
      }
      tile.a[i] = a + (1 - a) * d;
      if (tile.m) tile.m[i] = tile.m[i] * (1 - d) + g * d;
      else if (tile.c) {
        const k = i * 3;
        tile.c[k] = tile.c[k] * (1 - d) + g * d;
        tile.c[k + 1] = tile.c[k + 1] * (1 - d) + g2 * d;
        tile.c[k + 2] = tile.c[k + 2] * (1 - d) + g3 * d;
      }
    };
    // What was read of a tip at a point: its alpha, and its share of the second colour (or its
    // red, with green and blue in g2 and g3)
    const sample = { a: 0, g: 0, g2: 0, g3: 0 };
    // A tip's level for a dab `across` pixels wide: the smallest one still as large. Without
    // anti-aliasing a pixel is one pixel of the tip, read from a level twice as fine: averaged
    // down, the small marks of a tip would all fall under the half that makes a pixel.
    const levelFor = (tip, across) => {
      const wanted = hard ? across * 2 : across;
      let n = 0;
      while (n < tip.levels.length - 1 && tip.levels[n + 1].width >= wanted) n++;
      return tip.levels[n];
    };
    const readNearest = (level, x, y) => {
      const px = Math.round(x);
      const py = Math.round(y);
      if (px < 0 || py < 0 || px >= level.width || py >= level.height) {
        sample.a = 0;
        return;
      }
      const i = py * level.width + px;
      const a = level.alpha[i];
      sample.a = a / 255;
      if (!(a > 0)) return;
      if (level.gray) sample.g = level.gray[i] / a;
      else if (level.rgb) {
        sample.g = (level.rgb[i * 3] / a) * 255;
        sample.g2 = (level.rgb[i * 3 + 1] / a) * 255;
        sample.g3 = (level.rgb[i * 3 + 2] / a) * 255;
      } else sample.g = 0;
    };
    // A level read between its pixels: its alpha in `sample.a`, and what goes with it
    const readSmooth = (level, x, y) => {
      const w = level.width;
      const h = level.height;
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const fx = x - x0;
      const fy = y - y0;
      const xa = x0 < 0 ? -1 : x0 >= w ? -1 : x0;
      const xb = x0 + 1 < 0 ? -1 : x0 + 1 >= w ? -1 : x0 + 1;
      const ya = y0 < 0 || y0 >= h ? -1 : y0;
      const yb = y0 + 1 < 0 || y0 + 1 >= h ? -1 : y0 + 1;
      const w00 = xa < 0 || ya < 0 ? 0 : (1 - fx) * (1 - fy);
      const w10 = xb < 0 || ya < 0 ? 0 : fx * (1 - fy);
      const w01 = xa < 0 || yb < 0 ? 0 : (1 - fx) * fy;
      const w11 = xb < 0 || yb < 0 ? 0 : fx * fy;
      const i00 = ya * w + xa;
      const i10 = ya * w + xb;
      const i01 = yb * w + xa;
      const i11 = yb * w + xb;
      const plane = level.alpha;
      const a = (w00 ? plane[i00] * w00 : 0) + (w10 ? plane[i10] * w10 : 0) + (w01 ? plane[i01] * w01 : 0) + (w11 ? plane[i11] * w11 : 0);
      sample.a = a / 255;
      if (!(a > 0)) return;
      if (level.gray) {
        const g = level.gray;
        sample.g = ((w00 ? g[i00] * w00 : 0) + (w10 ? g[i10] * w10 : 0) + (w01 ? g[i01] * w01 : 0) + (w11 ? g[i11] * w11 : 0)) / a;
      } else if (level.rgb) {
        const c = level.rgb;
        for (let k = 0; k < 3; k++) {
          const value = (((w00 ? c[i00 * 3 + k] * w00 : 0) + (w10 ? c[i10 * 3 + k] * w10 : 0) + (w01 ? c[i01 * 3 + k] * w01 : 0) + (w11 ? c[i11 * 3 + k] * w11 : 0)) / a) * 255;
          if (k === 0) sample.g = value;
          else if (k === 1) sample.g2 = value;
          else sample.g3 = value;
        }
      } else sample.g = 0;
    };

    const readLevel = hard ? readNearest : readSmooth;

    // One dab: a tip `w` by `h` pixels centred on (cx, cy), turned by `turn`, at strength
    // `flow`; `density`: the paper's, when it is laid dab by dab
    const dab = (tip, cx, cy, w, h, turn, flow, flipX, flipY, density) => {
      if (!(w > 0 && h > 0 && flow > 0)) return;
      const cos = Math.cos(turn);
      const sin = Math.sin(turn);
      const hw = w / 2;
      const hh = h / 2;
      const ex = Math.abs(hw * cos) + Math.abs(hh * sin) + 1;
      const ey = Math.abs(hw * sin) + Math.abs(hh * cos) + 1;
      const left = Math.floor(cx - ex);
      const top = Math.floor(cy - ey);
      const right = Math.ceil(cx + ex);
      const bottom = Math.ceil(cy + ey);
      const round = tip === ROUND;
      const level = round ? null : levelFor(tip, w);
      const sx = round ? 0 : level.width / w;
      const sy = round ? 0 : level.height / h;
      // A round tip's edge: one pixel wide when hard, else from its hardness out
      const radius = Math.min(hw, hh);
      const inner = s.hardness;
      // Thinner than a pixel, a dab is as much lighter
      const thin = Math.min(1, w) * Math.min(1, h);
      const rw = Math.max(hw, 0.5);
      const rh = Math.max(hh, 0.5);
      const invRw = 1 / rw;
      const invRh = 1 / rh;
      const maxR = 1 + 0.5 / radius;
      const maxR2 = maxR * maxR;
      const edgeScale = Math.max(radius, 0.5);
      const invSoft = inner < 1 ? Math.PI / (1 - inner) : 0;
      const texture = perDabPaper ? ready.texture : null;
      for (let ty = Math.floor(top / TILE); ty * TILE < bottom; ty++) {
        for (let tx = Math.floor(left / TILE); tx * TILE < right; tx++) {
          let tile = null;
          const y0 = Math.max(top, ty * TILE);
          const y1 = Math.min(bottom, (ty + 1) * TILE);
          const x0 = Math.max(left, tx * TILE);
          const x1 = Math.min(right, (tx + 1) * TILE);
          const dx0 = x0 + 0.5 - cx;
          for (let py = y0; py < y1; py++) {
            const dy = py + 0.5 - cy;
            let baseU = dx0 * cos + dy * sin;
            let baseV = -dx0 * sin + dy * cos;
            for (let px = x0; px < x1; px++, baseU += cos, baseV -= sin) {
              let u = baseU;
              let v = baseV;
              let d;
              if (round) {
                const ru = u * invRw;
                const rv = v * invRh;
                const r2 = ru * ru + rv * rv;
                if (r2 >= maxR2) continue;
                const r = Math.sqrt(r2);
                if (inner >= 1 || hard) d = clamp((1 - r) * edgeScale + 0.5, 0, 1);
                else d = r <= inner ? 1 : r >= 1 ? 0 : (Math.cos((r - inner) * invSoft) + 1) / 2;
                d *= thin;
                sample.g = 0;
              } else {
                if (flipX) u = -u;
                if (flipY) v = -v;
                readLevel(level, (u + hw) * sx - 0.5, (v + hh) * sy - 0.5);
                d = sample.a;
              }
              if (hard) d = d >= 0.5 ? 1 : 0;
              if (!(d > 0)) continue;
              d *= flow;
              if (texture) d = papered(texture, d, px + 0.5, py + 0.5, density);
              if (!(d > 0)) continue;
              if (!tile) tile = tileAt(tx, ty);
              lay(tile, (py - ty * TILE) * TILE + (px - tx * TILE), d, sample.g, sample.g2, sample.g3);
            }
          }
        }
      }
      touched(left, top, right, bottom);
    };

    // A piece of ribbon between two cuts across the stroke. A cut: { x, y, nx, ny (its normal,
    // to the right of where the stroke goes), half (half the ribbon's width), u (how far along
    // the tip, in tips) }.
    const band = (tip, from, to, flow, density, quarter) => {
      const reach = Math.max(from.half, to.half) + 1;
      const left = Math.floor(Math.min(from.x, to.x) - reach);
      const top = Math.floor(Math.min(from.y, to.y) - reach);
      const right = Math.ceil(Math.max(from.x, to.x) + reach);
      const bottom = Math.ceil(Math.max(from.y, to.y) + reach);
      const round = tip === ROUND;
      const across = (from.half + to.half);
      // Turned a quarter, the tip's height is what goes across the stroke
      const level = round ? null : levelFor(tip, quarter & 1 ? (across * tip.width) / tip.height : across);
      const texture = perDabPaper ? ready.texture : null;
      for (let ty = Math.floor(top / TILE); ty * TILE < bottom; ty++) {
        for (let tx = Math.floor(left / TILE); tx * TILE < right; tx++) {
          let tile = null;
          const y0 = Math.max(top, ty * TILE);
          const y1 = Math.min(bottom, (ty + 1) * TILE);
          const x0 = Math.max(left, tx * TILE);
          const x1 = Math.min(right, (tx + 1) * TILE);
          for (let py = y0; py < y1; py++) {
            for (let px = x0; px < x1; px++) {
              const x = px + 0.5;
              const y = py + 0.5;
              // Past the first cut and before the second: which side of each the pixel is on
              const a = (x - from.x) * from.ny - (y - from.y) * from.nx;
              const b = (x - to.x) * to.ny - (y - to.y) * to.nx;
              if (a < 0 || b >= 0) continue;
              const t = a / (a - b);
              const cx = from.x + (to.x - from.x) * t;
              const cy = from.y + (to.y - from.y) * t;
              const half = from.half + (to.half - from.half) * t;
              let nx = from.nx + (to.nx - from.nx) * t;
              let ny = from.ny + (to.ny - from.ny) * t;
              const length = Math.sqrt(nx * nx + ny * ny) || 1;
              nx /= length;
              ny /= length;
              const side = (x - cx) * nx + (y - cy) * ny;
              if (side < -half - 0.5 || side > half + 0.5) continue;
              let d;
              if (round) {
                d = clamp(half - Math.abs(side) + 0.5, 0, 1);
                sample.g = 0;
              } else {
                // `on`: how far along the tip, `over`: how far across, from the left of the way
                const on = from.u + (to.u - from.u) * t;
                const over = (side + half) / (2 * half);
                const tx = quarter === 0 ? 1 - over : quarter === 1 ? on : quarter === 2 ? over : 1 - on;
                const ty = quarter === 0 ? on : quarter === 1 ? over : quarter === 2 ? 1 - on : 1 - over;
                // Along the stroke the tip is followed by itself or the next one: no edge there
                if (quarter & 1) readLevel(level, clamp(tx * level.width - 0.5, 0, level.width - 1), ty * level.height - 0.5);
                else readLevel(level, tx * level.width - 0.5, clamp(ty * level.height - 0.5, 0, level.height - 1));
                d = sample.a;
              }
              if (hard) d = d >= 0.5 ? 1 : 0;
              if (!(d > 0)) continue;
              d *= flow;
              if (texture) d = papered(texture, d, x, y, density);
              if (!(d > 0)) continue;
              if (!tile) tile = tileAt(tx, ty);
              lay(tile, (py - ty * TILE) * TILE + (px - tx * TILE), d, sample.g, sample.g2, sample.g3);
            }
          }
        }
      }
      touched(left, top, right, bottom);
    };

    /* ---- the pen along the path ---- */

    // What a setting is worth at this point of the stroke: its movers, then the taper
    const pen = { pressure: 1, tilt: null, speed: 0, random: () => random(), at: 0 };
    let total = 0;
    const tapered = (name, value) => {
      if (!taper || taper.targets[name] === undefined) return value;
      const min = taper.targets[name];
      let k = 1;
      if (taper.type === 2) {
        // A fade: from the start down to the least, and it stays there
        if (taper.out > 0) k = 1 - clamp(pen.at / (taper.out * scale), 0, 1);
      } else {
        const start = taper.type === 1 ? taper.inRatio * total : taper.in * scale;
        const end = taper.type === 1 ? taper.outRatio * total : taper.out * scale;
        if (start > 0 && pen.at < start) k = Math.min(k, pen.at / start);
        if (end > 0 && total > 0 && total - pen.at < end) k = Math.min(k, Math.max(0, total - pen.at) / end);
      }
      return value * (min + (1 - min) * k);
    };
    const worth = (name, value) => {
      const move = ready.move[name];
      return tapered(name, move ? value * move(pen) : value);
    };

    const TURN = Math.PI / 180;
    const tipCount = ready.tips.length;
    let dabs = 0;
    let order = null;
    let spent = false;
    const nextTip = () => {
      const n = tipCount;
      const i = dabs++;
      if (n === 1) {
        // Once only: one dab and no more
        if ((s.tipOrder === 4 || s.tipOrder === 5) && i > 0) spent = true;
        return ready.tips[0];
      }
      switch (s.tipOrder) {
        case 1: {
          const k = i % (2 * n - 2);
          return ready.tips[k < n ? k : 2 * n - 2 - k];
        }
        case 2: return ready.tips[Math.min(i, n - 1)];
        case 3: return ready.tips[Math.floor(random() * n) % n];
        case 4:
          if (i >= n) spent = true;
          return ready.tips[Math.min(i, n - 1)];
        case 5:
          if (!order) {
            order = ready.tips.map((tip, index) => index);
            for (let k = n - 1; k > 0; k--) {
              const j = Math.floor(random() * (k + 1));
              [order[k], order[j]] = [order[j], order[k]];
            }
          }
          if (i >= n) spent = true;
          return ready.tips[order[Math.min(i, n - 1)]];
        default: return ready.tips[i % n];
      }
    };
    const flipped = (kind) => kind === 1 || (kind === 2 && random() < 0.5);
    // The box a tip fills when the brush is `size` wide: its longer side is the size
    const boxOf = (tip, size) => {
      if (tip === ROUND) return [size, size];
      const longer = Math.max(tip.width, tip.height);
      return [(size * tip.width) / longer, (size * tip.height) / longer];
    };
    // The dab (or the spray of them) of one step along the stroke; `direction`: where the
    // stroke goes, in radians
    const plot = (x, y, direction) => {
      if (spent) return;
      const size = Math.max(s.atLeast1 ? 1 : 0.05, worth("size", baseSize));
      const flow = clamp(worth("flow", s.flow) * (ready.move.opacity ? ready.move.opacity(pen) : 1), 0, 1);
      const thickness = worth("thickness", s.thickness);
      const density = ready.texture ? clamp(worth("texture", ready.texture.density), 0, 1) : 0;
      const turned = (base, by, strength) => {
        let turn = base * TURN;
        if (by.line) turn += direction - Math.PI / 2;
        if (by.random) turn += (random() * 2 - 1) * Math.PI * (strength === undefined ? by.random : strength);
        return turn;
      };
      const one = (cx, cy, across, turn) => {
        const tip = nextTip();
        if (spent && dabs > tipCount) return;
        let [w, h] = boxOf(tip, across);
        if (s.thicknessAlong) w *= thickness;
        else h *= thickness;
        dab(tip, cx, cy, w, h, turn, flow, flipped(s.flipH), flipped(s.flipV), density);
      };
      if (!s.spray) {
        one(x, y, size, turned(s.angle, s.angleBy));
        return size;
      }
      const spray = s.spray;
      const grain = Math.max(0.5, worth("spraySize", spray.linked ? size : spray.size * scale));
      const count = Math.max(1, Math.round(worth("sprayDensity", spray.density)));
      // Toward the centre or toward the rim, by how the distances are drawn
      const power = spray.bias >= 0 ? 0.5 + spray.bias * 1.5 : 0.5 / (1 - spray.bias * 3);
      for (let i = 0; i < count; i++) {
        const far = Math.pow(random(), power) * (size / 2);
        const where = random() * Math.PI * 2;
        const cx = x + Math.cos(where) * far;
        const cy = y + Math.sin(where) * far;
        let turn = spray.angle * TURN;
        if (spray.angleBy.line || spray.angleBy.spray) turn += direction - Math.PI / 2;
        if (spray.angleBy.center) turn += where - Math.PI / 2;
        if (spray.angleBy.random) turn += (random() * 2 - 1) * Math.PI * spray.angleBy.random;
        one(cx, cy, grain, turn);
      }
      return size;
    };

    // The path: the pointer's points, steadied, walked a gap at a time
    let last = null;
    let steady = null;
    let rest = 0;
    let started = false;
    let heading = 0;
    let cut = null;
    let ribbonU = 0;
    let ribbonTip = null;
    let step = 0;
    const stepOf = (size) => Math.max(0.3, worth("gap", s.gap) * size);
    // A ribbon's tip turned by quarters: 0 its top where the stroke starts, 1 its left there…
    const quarter = ((Math.round((s.angle || 0) / 90) % 4) + 4) % 4;
    // Thickness makes the tip narrower or wider along one of its own sides: which of the
    // ribbon's that is, its width or its length, turns with the tip
    const thickAcross = Boolean(s.thicknessAlong) === !(quarter & 1);
    const ribbonCut = (x, y, direction) => {
      const size = Math.max(0.5, worth("size", baseSize));
      const half = (size * (thickAcross ? worth("thickness", s.thickness) : 1)) / 2;
      return { x, y, nx: -Math.sin(direction), ny: Math.cos(direction), half, u: ribbonU };
    };
    const walk = (to) => {
      if (!last) {
        last = to;
        pen.pressure = to.pressure;
        pen.tilt = to.tilt;
        pen.speed = 0;
        pen.at = 0;
        if (!needsDirection) {
          plot(to.x, to.y, 0);
          started = true;
        }
        return;
      }
      const dx = to.x - last.x;
      const dy = to.y - last.y;
      const length = Math.hypot(dx, dy);
      if (!(length > 0)) return;
      const direction = Math.atan2(dy, dx);
      // The heading turns with the path, not at once: a corner doesn't flip a tip over
      if (!started) heading = direction;
      else {
        let turn = direction - heading;
        while (turn > Math.PI) turn -= Math.PI * 2;
        while (turn < -Math.PI) turn += Math.PI * 2;
        heading += turn * Math.min(1, length / Math.max(2, baseSize * 0.25));
      }
      const elapsed = Math.max(1, to.time - last.time);
      const speed = clamp(length / elapsed / 3, 0, 1);
      const at0 = pen.at;
      const setPen = (t) => {
        pen.pressure = last.pressure + (to.pressure - last.pressure) * t;
        pen.tilt = last.tilt === null || to.tilt === null ? null : last.tilt + (to.tilt - last.tilt) * t;
        pen.speed += (speed - pen.speed) * 0.2;
        pen.at = at0 + length * t;
      };
      if (s.ribbon) {
        // Cuts every few pixels, each a little further along the tip
        const stride = clamp(baseSize / 8, 1, 4);
        if (!started) {
          setPen(0);
          ribbonTip = nextTip();
          cut = ribbonCut(last.x, last.y, heading);
          started = true;
        }
        // `rest`: how far the last cut is behind the start of this piece of path
        let done = -rest;
        for (;;) {
          const tip = ribbonTip;
          const ratio = tip === ROUND ? 1 : quarter & 1 ? tip.width / tip.height : tip.height / tip.width;
          // A tip's length along the stroke, at the size the pen has here
          const tipLength = Math.max(0.5, Math.max(0.5, worth("size", baseSize)) * ratio * (thickAcross ? 1 : s.thickness));
          // The next cut: a stride on, or sooner where the tip ends
          const toEnd = (1 - ribbonU) * tipLength;
          const move = Math.min(stride, Math.max(0.05, toEnd));
          if (done + move > length) break;
          done += move;
          setPen(clamp(done / length, 0, 1));
          ribbonU = toEnd <= stride ? 1 : ribbonU + move / tipLength;
          const next = ribbonCut(last.x + dx * (done / length), last.y + dy * (done / length), heading);
          const flow = clamp(worth("flow", s.flow), 0, 1);
          const density = ready.texture ? clamp(worth("texture", ready.texture.density), 0, 1) : 0;
          if (!spent) band(tip, cut, next, flow, density, quarter);
          cut = next;
          if (ribbonU >= 1) {
            ribbonU = 0;
            cut = Object.assign({}, next, { u: 0 });
            ribbonTip = nextTip();
            if (spent) ribbonTip = tip;
          }
        }
        rest = length - done;
      } else {
        if (!started) {
          setPen(0);
          const size = plot(last.x, last.y, heading);
          rest = 0;
          started = true;
          step = stepOf(size || baseSize);
        }
        if (!step) step = stepOf(baseSize);
        let at = step - rest;
        while (at <= length) {
          const t = at / length;
          setPen(t);
          const size = plot(last.x + dx * t, last.y + dy * t, heading);
          step = stepOf(size || baseSize);
          at += step;
        }
        rest = length - (at - step);
      }
      pen.at = at0 + length;
      last = to;
    };
    // The pointer steadied: the pen follows it a little behind, the more the steadier
    const pull = 1 / (1 + (s.stabilize || 0) * 0.12);
    const feed = (point, flush) => {
      if (!steady || pull >= 1) {
        steady = Object.assign({}, point);
        walk(steady);
        return;
      }
      const reach = flush ? 1 : pull;
      steady = { x: steady.x + (point.x - steady.x) * reach, y: steady.y + (point.y - steady.y) * reach, pressure: steady.pressure + (point.pressure - steady.pressure) * reach, tilt: point.tilt, time: point.time };
      walk(steady);
    };
    const reset = () => {
      tiles = new Map();
      random = mulberry(seed);
      last = null;
      steady = null;
      rest = 0;
      started = false;
      heading = 0;
      cut = null;
      ribbonU = 0;
      ribbonTip = null;
      dabs = 0;
      order = null;
      spent = false;
      step = 0;
      pen.at = 0;
      pen.speed = 0;
    };
    // The whole stroke again from its points, its length known
    const redraw = () => {
      const before = bounds;
      reset();
      total = measure();
      bounds = null;
      inputs.forEach((point, index) => feed(point, index === inputs.length - 1));
      finish();
      bounds = before && bounds ? grow(Object.assign({}, before), bounds.left, bounds.top, bounds.right, bounds.bottom) : before || bounds;
      dirty = bounds ? Object.assign({}, bounds) : null;
    };
    // How long the steadied pen's path is
    const measure = () => {
      let from = null;
      let at = 0;
      let point = null;
      inputs.forEach((input, index) => {
        const reach = !point || pull >= 1 || index === inputs.length - 1 ? 1 : pull;
        point = point ? { x: point.x + (input.x - point.x) * reach, y: point.y + (input.y - point.y) * reach } : { x: input.x, y: input.y };
        if (from) at += Math.hypot(point.x - from.x, point.y - from.y);
        from = point;
      });
      return at;
    };
    // A stroke that never moved: its one dab, heading right
    const finish = () => {
      if (!started && last) {
        if (s.ribbon) {
          const tip = nextTip();
          const half = baseSize / 2;
          band(tip, { x: last.x - half, y: last.y, nx: 0, ny: 1, half, u: 0 }, { x: last.x + half, y: last.y, nx: 0, ny: 1, half, u: 1 }, clamp(s.flow, 0, 1), ready.texture ? ready.texture.density : 0, quarter);
        } else plot(last.x, last.y, 0);
        started = true;
      }
    };
    const taken = () => {
      const box = dirty;
      dirty = null;
      return box;
    };

    return {
      brush,
      get bounds() {
        return bounds;
      },
      // `tilt`: 0 upright to 1 lying flat, or null when the pointer doesn't say
      add(x, y, pressure = 1, time = 0, tilt = null) {
        const point = { x, y, pressure: clamp(pressure, 0, 1), tilt: tilt === null || tilt === undefined ? null : clamp(tilt, 0, 1), time };
        inputs.push(point);
        feed(point, false);
        return taken();
      },
      end() {
        if (redrawn && inputs.length) redraw();
        else {
          if (steady && inputs.length && pull < 1) feed(inputs[inputs.length - 1], true);
          finish();
        }
        return taken();
      },
      // The stroke's pixels over a rectangle of the page: r, g, b (0 to 255) and a (0 to 1);
      // `plain`: without the stroke's opacity
      read(left, top, width, height, out, plain) {
        const texture = ready.texture && !ready.texture.perDab ? ready.texture : null;
        const edge = s.edge && !plain && bounds ? edgeOver(left, top, width, height) : null;
        out.fill(0, 0, width * height * 4);
        for (let ty = Math.floor(top / TILE); ty * TILE < top + height; ty++) {
          for (let tx = Math.floor(left / TILE); tx * TILE < left + width; tx++) {
            const tile = tiles.get((ty + 16384) * KEY + tx + 16384);
            if (!tile) continue;
            const y0 = Math.max(top, ty * TILE);
            const y1 = Math.min(top + height, (ty + 1) * TILE);
            const x0 = Math.max(left, tx * TILE);
            const x1 = Math.min(left + width, (tx + 1) * TILE);
            for (let py = y0; py < y1; py++) {
              let i = (py - ty * TILE) * TILE + (x0 - tx * TILE);
              let o = ((py - top) * width + (x0 - left)) * 4;
              for (let px = x0; px < x1; px++, i++, o += 4) {
                let a = tile.a[i];
                if (!(a > 0)) continue;
                if (tile.m) {
                  const share = clamp(tile.m[i] / a, 0, 1);
                  out[o] = color[0] + (sub[0] - color[0]) * share;
                  out[o + 1] = color[1] + (sub[1] - color[1]) * share;
                  out[o + 2] = color[2] + (sub[2] - color[2]) * share;
                } else if (tile.c) {
                  out[o] = tile.c[i * 3] / a;
                  out[o + 1] = tile.c[i * 3 + 1] / a;
                  out[o + 2] = tile.c[i * 3 + 2] / a;
                } else {
                  out[o] = color[0];
                  out[o + 1] = color[1];
                  out[o + 2] = color[2];
                }
                if (texture) a = papered(texture, a, px + 0.5, py + 0.5, texture.density);
                if (hard) a = a >= 0.5 ? 1 : 0;
                if (edge) {
                  // The rim takes the stroke toward opaque, and its colour toward black
                  const more = edge[(py - top) * width + (px - left)] * a;
                  const dark = 1 - more * s.edge.darkness;
                  out[o] *= dark;
                  out[o + 1] *= dark;
                  out[o + 2] *= dark;
                  const base = a * opacity;
                  out[o + 3] = base + (1 - base) * more * s.edge.opacity;
                } else out[o + 3] = plain ? a : a * opacity;
              }
            }
          }
        }
        return out;
      },
    };
  };

  return { begin, prepare, curveTable, TILE };
});
