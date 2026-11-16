// The Quick Selection Tool's work, away from the page (quick-select.js asks, this answers): from
// the brush's stroke, the area of the picture it belongs to, up to the edges around it.
//
// It is one minimum cut (Boykov & Jolly, ICCV 2001) over the pixels around the stroke. What the
// brush covered is selected, whatever is under it. Beyond it, every selected pixel costs a little,
// a little more the further it is from the stroke, and so does every pair of neighbours the
// outline passes between: a lot when the two look alike, next to nothing across an edge. The
// selection that costs the least runs to the lines around the stroke and stops there, and a
// bigger area is only taken by a bigger brush or a longer stroke, as in Photoshop.
//
// Two things are done for a manga page:
// - it is first cut on a small copy of the page, where a screentone is one grey and a line is
//   still a line, and neighbours only count as different when they still are once that copy is
//   smoothed: dots and hatching don't stop the selection, and it isn't made of dots;
// - then only a thin band around that outline is cut again on the real pixels (Lombaert et al.,
//   "A Multilevel Banded Graph Cuts Method", ICCV 2005), where the small copy saw an edge: the
//   outline follows the line to the pixel, on a page of any size.
//
// The cut itself is a FIFO push-relabel (Goldberg & Tarjan, JACM 1988) with the distances
// counted again from the unselected side now and then: the many small costs of the pixels are
// what the stroke's flow drains into, and pushing it there beats looking for paths one by one.

"use strict";

/* ================================ the model ================================ */

// Fitted to Photoshop's own selections, for a page worked on at half its size (at full size
// under 512 × 512 pixels): what a selected pixel costs, how much more per pixel away from the
// stroke, and what a pair of neighbours costs to part, from FLOOR across an edge to 1 + FLOOR
const AREA = 0.004079;
const FAR = 0.002651;
const FAR_POWER = 0.98885;
const FLOOR = 0.018847;
const SIGMA = 0.04845;
const SHARPNESS = 1.98549;
// The brush selects a little more than its disc
const GROW = 1.69371;
const GROW_PER_RADIUS = 0.103003;

// The small copy has this many pixels at most: what a stroke is cut on while it is drawn
const SMALL = 450000;
// Around the small copy's outline, how many of its pixels each way are cut again
const BAND = 2;
// While the stroke is drawn, the band is only cut again when it is this small: more waits for
// the end of the stroke
const LIVE_BAND = 120000;
// More than this many real pixels in the band, and it is cut on a page half the size
const MOST_BAND = 2500000;
// A real edge counts at most this many times what the small copy made of it
const EDGE_GAIN = 2;

// Colours are told apart by their distance, red, green and blue from 0 to 1: √3 at most
const STEPS = 4096;
const PER_STEP = (STEPS - 1) / Math.sqrt(3);
const WEIGHT = new Float32Array(STEPS);
for (let i = 0; i < STEPS; i++) WEIGHT[i] = FLOOR + 1 / (1 + Math.pow(i / PER_STEP / SIGMA, SHARPNESS));
const weightOf = (difference) => WEIGHT[Math.min(STEPS - 1, (difference * PER_STEP) | 0)];

// The eight neighbours, each one's opposite four places further: the first four are the ones
// that come after a pixel, the links made from it
const DX = [1, 1, 0, -1, -1, -1, 0, 1];
const DY = [0, 1, 1, 1, 0, -1, -1, -1];
const LENGTH = [1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2];

/* ============================== the minimum cut ============================== */

// Big arrays kept from one stroke's step to the next
const kept = {};
const buffer = (name, Type, length) => {
  if (!kept[name] || kept[name].length < length || kept[name].length > length * 4 + 1024) kept[name] = new Type(length);
  return kept[name];
};

const INFINITE = 0x7fffffff;
const EPSILON = 1e-5;

// `count` pixels, each with up to eight links: `head[i * 8 + k]` is the neighbour (-1: none) and
// `room[i * 8 + k]` what can still flow to it. `excess` is what flows in from the selected side
// and `drain` what a pixel takes for itself, its cost. Returns a byte per pixel: 1 when it ends
// up selected.
const minCut = (count, head, room, drain, excess) => {
  const far = buffer("far", Int32Array, count);
  const next = buffer("next", Uint8Array, count);
  const queued = buffer("queued", Uint8Array, count).fill(0, 0, count);
  const queue = buffer("queue", Int32Array, count + 1);
  const walk = buffer("walk", Int32Array, count);
  const size = count + 1;
  // How far each pixel is from one that can still take some, through links with room left
  const measure = () => {
    far.fill(INFINITE, 0, count);
    next.fill(0, 0, count);
    let tail = 0;
    for (let i = 0; i < count; i++) {
      if (drain[i] > EPSILON) {
        far[i] = 1;
        walk[tail++] = i;
      }
    }
    for (let at = 0; at < tail; at++) {
      const i = walk[at];
      const beyond = far[i] + 1;
      const base = i * 8;
      for (let k = 0; k < 8; k++) {
        const j = head[base + k];
        if (j >= 0 && far[j] === INFINITE && room[j * 8 + ((k + 4) & 7)] > EPSILON) {
          far[j] = beyond;
          walk[tail++] = j;
        }
      }
    }
  };
  measure();
  let first = 0;
  let last = 0;
  for (let i = 0; i < count; i++) {
    if (excess[i] > EPSILON && far[i] !== INFINITE) {
      queued[i] = 1;
      queue[last++] = i;
    }
  }
  let work = 0;
  const often = count * 17;
  while (first !== last) {
    const i = queue[first];
    first = first + 1 === size ? 0 : first + 1;
    queued[i] = 0;
    const base = i * 8;
    let have = excess[i];
    while (have > EPSILON) {
      const level = far[i];
      if (level === INFINITE) break;
      if (level === 1 && drain[i] > EPSILON) {
        const taken = Math.min(have, drain[i]);
        drain[i] -= taken;
        have -= taken;
        if (have <= EPSILON) break;
      }
      let k = next[i];
      for (; k < 8; k++) {
        const j = head[base + k];
        work++;
        if (j < 0 || room[base + k] <= EPSILON || far[j] !== level - 1) continue;
        const sent = Math.min(have, room[base + k]);
        room[base + k] -= sent;
        room[j * 8 + ((k + 4) & 7)] += sent;
        have -= sent;
        excess[j] += sent;
        if (!queued[j]) {
          queued[j] = 1;
          queue[last] = j;
          last = last + 1 === size ? 0 : last + 1;
        }
        if (have <= EPSILON) break;
      }
      next[i] = k;
      if (have <= EPSILON) break;
      // Nowhere lower to send it: this pixel is further than it was thought to be
      let low = drain[i] > EPSILON ? 0 : INFINITE;
      for (k = 0; k < 8; k++) {
        const j = head[base + k];
        if (j >= 0 && room[base + k] > EPSILON && far[j] < low) low = far[j];
      }
      work += 8;
      far[i] = low === INFINITE ? INFINITE : low + 1;
      next[i] = 0;
    }
    excess[i] = have;
    if (work >= often) {
      measure();
      work = 0;
    }
  }
  // What is left over could go nowhere: it stays selected, with all it can still reach
  const side = new Uint8Array(count);
  let tail = 0;
  for (let i = 0; i < count; i++) {
    if (excess[i] > EPSILON) {
      side[i] = 1;
      walk[tail++] = i;
    }
  }
  for (let at = 0; at < tail; at++) {
    const base = walk[at] * 8;
    for (let k = 0; k < 8; k++) {
      const j = head[base + k];
      if (j >= 0 && !side[j] && room[base + k] > EPSILON) {
        side[j] = 1;
        walk[tail++] = j;
      }
    }
  }
  return side;
};

/* ============================== the small copy ============================== */

// `data`: the page's pixels, four bytes each. The small copy is `step` times smaller, each of
// its pixels the average of the ones it stands for.
const prepare = (data, width, height) => {
  // Photoshop's own working size: half the page's, or the page itself when it is small
  const base = width * height <= 512 * 512 ? 1 : 2;
  const step = Math.max(1, Math.ceil(Math.sqrt((width * height) / SMALL) / base)) * base;
  const cw = Math.ceil(width / step);
  const ch = Math.ceil(height / step);
  const small = new Float32Array(cw * ch * 3);
  for (let cy = 0; cy < ch; cy++) {
    const y1 = Math.min(height, (cy + 1) * step);
    for (let cx = 0; cx < cw; cx++) {
      const x1 = Math.min(width, (cx + 1) * step);
      let r = 0;
      let g = 0;
      let b = 0;
      for (let y = cy * step; y < y1; y++) {
        let at = (y * width + cx * step) * 4;
        for (let x = cx * step; x < x1; x++, at += 4) {
          r += data[at];
          g += data[at + 1];
          b += data[at + 2];
        }
      }
      const share = 1 / (255 * (y1 - cy * step) * (x1 - cx * step));
      const o = (cy * cw + cx) * 3;
      small[o] = r * share;
      small[o + 1] = g * share;
      small[o + 2] = b * share;
    }
  }
  // The same, smoothed: a screentone the small copy didn't quite average out is flat there
  const across = new Float32Array(small.length);
  const smooth = new Float32Array(small.length);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const o = (y * cw + x) * 3;
      const before = x > 0 ? o - 3 : o;
      const after = x < cw - 1 ? o + 3 : o;
      for (let c = 0; c < 3; c++) across[o + c] = (small[before + c] + 2 * small[o + c] + small[after + c]) / 4;
    }
  }
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const o = (y * cw + x) * 3;
      const before = y > 0 ? o - cw * 3 : o;
      const after = y < ch - 1 ? o + cw * 3 : o;
      for (let c = 0; c < 3; c++) smooth[o + c] = (across[before + c] + 2 * across[o + c] + across[after + c]) / 4;
    }
  }
  // How different each pixel is from the four neighbours that come after it: as the small copy
  // has them, unless smoothing shows it was only a texture (a clean edge is halved by it)
  const apart = new Float32Array(cw * ch * 4);
  const edge = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const i = y * cw + x;
      for (let k = 0; k < 4; k++) {
        const nx = x + DX[k];
        const ny = y + DY[k];
        if (nx < 0 || nx >= cw || ny >= ch) continue;
        const j = ny * cw + nx;
        const a = i * 3;
        const b = j * 3;
        const sharp = Math.hypot(small[a] - small[b], small[a + 1] - small[b + 1], small[a + 2] - small[b + 2]);
        const soft = Math.hypot(smooth[a] - smooth[b], smooth[a + 1] - smooth[b + 1], smooth[a + 2] - smooth[b + 2]);
        const d = Math.min(sharp, 2 * soft);
        apart[i * 4 + k] = d;
        if (d > edge[i]) edge[i] = d;
        if (d > edge[j]) edge[j] = d;
      }
    }
  }
  return { data, width, height, base, step, cw, ch, apart, edge };
};

/* ================================ the stroke ================================ */

// Marks, in a `w` × `h` grid whose first pixel is at (`left`, `top`), the pixels whose centre is
// within `radius` of the stroke, and the one under each of its points
const stamp = (mask, w, h, left, top, points, radius) => {
  const count = points.length / 2;
  let any = false;
  for (let n = 0; n < count; n++) {
    const ax = points[n * 2] - left;
    const ay = points[n * 2 + 1] - top;
    const bx = n + 1 < count ? points[n * 2 + 2] - left : ax;
    const by = n + 1 < count ? points[n * 2 + 3] - top : ay;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - radius));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - radius));
    const x1 = Math.min(w, Math.ceil(Math.max(ax, bx) + radius));
    const y1 = Math.min(h, Math.ceil(Math.max(ay, by) + radius));
    const dx = bx - ax;
    const dy = by - ay;
    const length = dx * dx + dy * dy;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const px = x + 0.5 - ax;
        const py = y + 0.5 - ay;
        const along = length > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / length)) : 0;
        const qx = px - along * dx;
        const qy = py - along * dy;
        if (qx * qx + qy * qy <= radius * radius) {
          mask[y * w + x] = 1;
          any = true;
        }
      }
    }
    const ox = Math.floor(ax);
    const oy = Math.floor(ay);
    if (ox >= 0 && oy >= 0 && ox < w && oy < h) {
      mask[oy * w + ox] = 1;
      any = true;
    }
  }
  return any;
};

// The stroke's points `scale` times smaller
const scaled = (points, scale) => {
  const out = new Float32Array(points.length);
  for (let i = 0; i < points.length; i++) out[i] = points[i] / scale;
  return out;
};

/* ========================= the cut on the small copy ========================= */

// One window of the small copy, from (`x0`, `y0`), `ww` × `wh`: the selection in it, and how far
// each of its pixels is from the stroke. Null when the stroke isn't in it.
const cutWindow = (page, points, radius, x0, y0, ww, wh) => {
  const { cw, apart, step, base } = page;
  const count = ww * wh;
  const seeds = new Uint8Array(count);
  if (!stamp(seeds, ww, wh, x0, y0, points, radius)) return null;
  // How far from the stroke, two passes over the window (1 for a side, √2 for a corner)
  const away = new Float32Array(count).fill(1e9);
  for (let i = 0; i < count; i++) if (seeds[i]) away[i] = 0;
  for (let y = 0; y < wh; y++) {
    for (let x = 0; x < ww; x++) {
      const i = y * ww + x;
      let d = away[i];
      if (x > 0 && away[i - 1] + 1 < d) d = away[i - 1] + 1;
      if (y > 0) {
        if (away[i - ww] + 1 < d) d = away[i - ww] + 1;
        if (x > 0 && away[i - ww - 1] + Math.SQRT2 < d) d = away[i - ww - 1] + Math.SQRT2;
        if (x < ww - 1 && away[i - ww + 1] + Math.SQRT2 < d) d = away[i - ww + 1] + Math.SQRT2;
      }
      away[i] = d;
    }
  }
  for (let y = wh - 1; y >= 0; y--) {
    for (let x = ww - 1; x >= 0; x--) {
      const i = y * ww + x;
      let d = away[i];
      if (x < ww - 1 && away[i + 1] + 1 < d) d = away[i + 1] + 1;
      if (y < wh - 1) {
        if (away[i + ww] + 1 < d) d = away[i + ww] + 1;
        if (x > 0 && away[i + ww - 1] + Math.SQRT2 < d) d = away[i + ww - 1] + Math.SQRT2;
        if (x < ww - 1 && away[i + ww + 1] + Math.SQRT2 < d) d = away[i + ww + 1] + Math.SQRT2;
      }
      away[i] = d;
    }
  }
  // The costs are Photoshop's, counted in its working pixels: one of the small copy's stands
  // for `ratio` × `ratio` of them, and its side for `ratio` of theirs
  const ratio = step / base;
  const head = buffer("head", Int32Array, count * 8).fill(-1, 0, count * 8);
  const room = buffer("room", Float32Array, count * 8).fill(0, 0, count * 8);
  const drain = buffer("drain", Float32Array, count);
  const excess = buffer("excess", Float64Array, count).fill(0, 0, count);
  for (let i = 0; i < count; i++) drain[i] = seeds[i] ? 0 : ratio * ratio * AREA * (1 + FAR * Math.pow(away[i] * ratio, FAR_POWER));
  for (let y = 0; y < wh; y++) {
    for (let x = 0; x < ww; x++) {
      const i = y * ww + x;
      const from = ((y0 + y) * cw + x0 + x) * 4;
      for (let k = 0; k < 4; k++) {
        const nx = x + DX[k];
        const ny = y + DY[k];
        if (nx < 0 || nx >= ww || ny >= wh) continue;
        const j = ny * ww + nx;
        if (seeds[i] && seeds[j]) continue;
        const weight = (weightOf(apart[from + k]) * ratio) / LENGTH[k];
        if (seeds[i]) excess[j] += weight;
        else if (seeds[j]) excess[i] += weight;
        else {
          head[i * 8 + k] = j;
          room[i * 8 + k] = weight;
          head[j * 8 + k + 4] = i;
          room[j * 8 + k + 4] = weight;
        }
      }
    }
  }
  const chosen = minCut(count, head, room, drain, excess);
  for (let i = 0; i < count; i++) if (seeds[i]) chosen[i] = 1;
  return { x0, y0, ww, wh, chosen, away };
};

// The selection on the small copy: in a window around the stroke, a bigger one for as long as
// the selection runs into a side of it that isn't the page's
const cutSmall = (page, points, radius) => {
  const { cw, ch, step } = page;
  const small = scaled(points, step);
  const reach = radius / step;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (let i = 0; i < small.length; i += 2) {
    left = Math.min(left, small[i] - reach);
    right = Math.max(right, small[i] + reach);
    top = Math.min(top, small[i + 1] - reach);
    bottom = Math.max(bottom, small[i + 1] + reach);
  }
  left = Math.max(0, Math.floor(left));
  top = Math.max(0, Math.floor(top));
  right = Math.min(cw, Math.ceil(right) + 1);
  bottom = Math.min(ch, Math.ceil(bottom) + 1);
  if (left >= right || top >= bottom) return null;
  let margin = Math.max(48, Math.ceil(reach * 2));
  for (;;) {
    const x0 = Math.max(0, left - margin);
    const y0 = Math.max(0, top - margin);
    const x1 = Math.min(cw, right + margin);
    const y1 = Math.min(ch, bottom + margin);
    const ww = x1 - x0;
    const wh = y1 - y0;
    const cut = cutWindow(page, small, reach, x0, y0, ww, wh);
    if (!cut) return null;
    const { chosen } = cut;
    let touches = false;
    for (let x = 0; x < ww && !touches; x++) touches = (y0 > 0 && chosen[x] === 1) || (y1 < ch && chosen[(wh - 1) * ww + x] === 1);
    for (let y = 0; y < wh && !touches; y++) touches = (x0 > 0 && chosen[y * ww] === 1) || (x1 < cw && chosen[y * ww + ww - 1] === 1);
    if (!touches) return cut;
    margin *= 2;
  }
};

/* ====================== the band, on the page's own pixels ====================== */

// Around the small copy's outline, the pixels of the page (`fine` = 1), or of the page at half
// its size (`fine` = 2), are cut again. Null when there are more than `most` of them.
const cutBand = (page, cut, points, radius, fine, most) => {
  const { data, width, height, step, base, cw, edge } = page;
  const { x0, y0, ww, wh, chosen, away } = cut;
  const per = step / fine;
  const fw = Math.ceil(width / fine);
  const fh = Math.ceil(height / fine);
  // The small copy's pixels with one of the other side within BAND of them
  const band = new Int32Array(ww * wh).fill(-1);
  const cells = [];
  for (let y = 0; y < wh; y++) {
    for (let x = 0; x < ww; x++) {
      const i = y * ww + x;
      const mine = chosen[i];
      let mixed = false;
      for (let dy = -BAND; dy <= BAND && !mixed; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= wh) continue;
        for (let dx = -BAND; dx <= BAND; dx++) {
          const nx = x + dx;
          if (nx >= 0 && nx < ww && chosen[ny * ww + nx] !== mine) {
            mixed = true;
            break;
          }
        }
      }
      if (mixed) {
        band[i] = cells.length;
        cells.push(i);
      }
    }
  }
  const count = cells.length * per * per;
  if (count > most) return null;
  // What the brush covered, to the pixel
  const strokes = scaled(points, fine);
  const reach = radius / fine;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (let i = 0; i < strokes.length; i += 2) {
    left = Math.min(left, strokes[i] - reach);
    right = Math.max(right, strokes[i] + reach);
    top = Math.min(top, strokes[i + 1] - reach);
    bottom = Math.max(bottom, strokes[i + 1] + reach);
  }
  left = Math.max(0, Math.floor(left));
  top = Math.max(0, Math.floor(top));
  const bw = Math.max(0, Math.min(fw, Math.ceil(right) + 1) - left);
  const bh = Math.max(0, Math.min(fh, Math.ceil(bottom) + 1) - top);
  const brushed = new Uint8Array(bw * bh);
  stamp(brushed, bw, bh, left, top, strokes, reach);
  const foot = { mask: brushed, left, top, width: bw, height: bh };
  if (!count) return { fine, per, band, cells, side: new Uint8Array(0), foot };

  const head = buffer("head", Int32Array, count * 8).fill(-1, 0, count * 8);
  const room = buffer("room", Float32Array, count * 8).fill(0, 0, count * 8);
  const drain = buffer("drain", Float32Array, count).fill(0, 0, count);
  const excess = buffer("excess", Float64Array, count).fill(0, 0, count);
  const ratio = fine / base;
  const colour = [0, 0, 0];
  // A pixel of the page at this size: itself, or the average of the four it stands for
  const read = (fx, fy) => {
    if (fine === 1) {
      const at = (fy * width + fx) * 4;
      colour[0] = data[at];
      colour[1] = data[at + 1];
      colour[2] = data[at + 2];
      return;
    }
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let y = fy * fine; y < Math.min(height, (fy + 1) * fine); y++) {
      for (let x = fx * fine; x < Math.min(width, (fx + 1) * fine); x++) {
        const at = (y * width + x) * 4;
        r += data[at];
        g += data[at + 1];
        b += data[at + 2];
        n++;
      }
    }
    colour[0] = r / n;
    colour[1] = g / n;
    colour[2] = b / n;
  };
  const SELECTED = -1;
  const LEFT_OUT = -2;
  for (let c = 0; c < cells.length; c++) {
    const cell = cells[c];
    const cx = x0 + (cell % ww);
    const cy = y0 + ((cell / ww) | 0);
    const cost = ratio * ratio * AREA * (1 + FAR * Math.pow((away[cell] * step) / base, FAR_POWER));
    const edgeHere = edge[cy * cw + cx];
    for (let ly = 0; ly < per; ly++) {
      const fy = cy * per + ly;
      if (fy >= fh) break;
      for (let lx = 0; lx < per; lx++) {
        const fx = cx * per + lx;
        if (fx >= fw) break;
        const bx = fx - left;
        const by = fy - top;
        const p = bx >= 0 && by >= 0 && bx < bw && by < bh && brushed[by * bw + bx] ? SELECTED : (c * per + ly) * per + lx;
        if (p >= 0) drain[p] += cost;
        read(fx, fy);
        const r = colour[0];
        const g = colour[1];
        const b = colour[2];
        for (let k = 0; k < 8; k++) {
          const qx = fx + DX[k];
          const qy = fy + DY[k];
          if (qx < 0 || qy < 0 || qx >= fw || qy >= fh) continue;
          // Where the neighbour stands: in the band (its link is made from the first of the
          // two), or settled by the small copy
          const qcx = (qx / per) | 0;
          const qcy = (qy / per) | 0;
          const wx = qcx - x0;
          const wy = qcy - y0;
          const inside = wx >= 0 && wy >= 0 && wx < ww && wy < wh;
          const qc = inside ? band[wy * ww + wx] : -1;
          if (k >= 4 && qc >= 0) continue;
          const qbx = qx - left;
          const qby = qy - top;
          let q;
          if (qbx >= 0 && qby >= 0 && qbx < bw && qby < bh && brushed[qby * bw + qbx]) q = SELECTED;
          else if (qc >= 0) q = (qc * per + (qy - qcy * per)) * per + (qx - qcx * per);
          else q = inside && chosen[wy * ww + wx] ? SELECTED : LEFT_OUT;
          if (p < 0 && q < 0) continue;
          read(qx, qy);
          const sharp = Math.hypot(r - colour[0], g - colour[1], b - colour[2]) / 255;
          // An edge only where the small copy saw one: the dots of a screentone are none
          const seen = EDGE_GAIN * Math.max(edgeHere, edge[qcy * cw + qcx]);
          const weight = (weightOf(Math.min(sharp, seen)) * ratio) / LENGTH[k];
          if (p >= 0 && q >= 0) {
            head[p * 8 + k] = q;
            room[p * 8 + k] = weight;
            head[q * 8 + k + 4] = p;
            room[q * 8 + k + 4] = weight;
          } else if (p >= 0) {
            if (q === SELECTED) excess[p] += weight;
            else drain[p] += weight;
          } else excess[q] += weight;
        }
      }
    }
  }
  return { fine, per, band, cells, side: minCut(count, head, room, drain, excess), foot };
};

/* ============================ the selection, as pixels ============================ */

// A byte per pixel of the page, in the box the selection fills. `band` null: the small copy's
// selection as it is.
const pixelsOf = (page, cut, band) => {
  const { width, height, step } = page;
  const { x0, y0, ww, wh, chosen } = cut;
  let left = ww;
  let top = wh;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < wh; y++) {
    for (let x = 0; x < ww; x++) {
      if (!chosen[y * ww + x] && !(band && band.band[y * ww + x] >= 0)) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (right < 0) return null;
  let bx0 = (x0 + left) * step;
  let by0 = (y0 + top) * step;
  let bx1 = Math.min(width, (x0 + right + 1) * step);
  let by1 = Math.min(height, (y0 + bottom + 1) * step);
  if (band) {
    const { foot, fine } = band;
    bx0 = Math.min(bx0, foot.left * fine);
    by0 = Math.min(by0, foot.top * fine);
    bx1 = Math.max(bx1, Math.min(width, (foot.left + foot.width) * fine));
    by1 = Math.max(by1, Math.min(height, (foot.top + foot.height) * fine));
  }
  const bw = bx1 - bx0;
  const bh = by1 - by0;
  const mask = new Uint8Array(bw * bh);
  const block = (x, y, size, value) => {
    const xa = Math.max(bx0, x);
    const xb = Math.min(bx1, x + size);
    const yb = Math.min(by1, y + size);
    for (let yy = Math.max(by0, y); yy < yb; yy++) mask.fill(value, (yy - by0) * bw + xa - bx0, (yy - by0) * bw + xb - bx0);
  };
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const i = y * ww + x;
      if (chosen[i] && !(band && band.band[i] >= 0)) block((x0 + x) * step, (y0 + y) * step, step, 1);
    }
  }
  if (band) {
    const { fine, per, cells, side, foot } = band;
    for (let c = 0; c < cells.length; c++) {
      const cx = x0 + (cells[c] % ww);
      const cy = y0 + ((cells[c] / ww) | 0);
      for (let ly = 0; ly < per; ly++) {
        for (let lx = 0; lx < per; lx++) if (side[(c * per + ly) * per + lx]) block((cx * per + lx) * fine, (cy * per + ly) * fine, fine, 1);
      }
    }
    for (let y = 0; y < foot.height; y++) {
      for (let x = 0; x < foot.width; x++) if (foot.mask[y * foot.width + x]) block((foot.left + x) * fine, (foot.top + y) * fine, fine, 1);
    }
  }
  return { left: bx0, top: by0, width: bw, height: bh, mask };
};

// The stroke: `points` (x, y, x, y… on the page), the brush's `size`. `final`: the stroke is
// over, the outline is cut on the page's pixels however long it takes. `enhance`: on the page's
// own pixels, not on Photoshop's half-size ones.
const select = (page, { points, size, final, enhance }) => {
  const half = Math.max(1, size) / 2;
  // Points too close to tell apart are one
  const apartAtLeast = Math.max(0.5, half / 16);
  const thinned = [points[0], points[1]];
  for (let i = 2; i < points.length; i += 2) {
    const last = i + 2 >= points.length;
    if (last || Math.hypot(points[i] - thinned[thinned.length - 2], points[i + 1] - thinned[thinned.length - 1]) >= apartAtLeast) thinned.push(points[i], points[i + 1]);
  }
  const stroke = Float32Array.from(thinned);
  const radius = Math.max(half, page.base / 2) + (GROW + (GROW_PER_RADIUS * half) / page.base) * page.base;
  const cut = cutSmall(page, stroke, radius);
  if (!cut) return null;
  let band = null;
  const fine = enhance ? 1 : page.base;
  if (page.step > fine) band = cutBand(page, cut, stroke, radius, fine, final ? MOST_BAND : LIVE_BAND);
  if (!band && final && page.step > page.base && fine < page.base) band = cutBand(page, cut, stroke, radius, page.base, MOST_BAND);
  const out = pixelsOf(page, cut, band);
  if (out) out.rough = !band && page.step > fine;
  return out;
};

/* ================================ the worker ================================ */

if (typeof module !== "undefined" && module.exports) {
  module.exports = { prepare, select, minCut };
} else {
  // One page at a time: the one the last stroke was on, kept until its pixels change
  let page = null;
  let pageKey = "";
  self.onmessage = ({ data }) => {
    const { id, type, payload } = data;
    try {
      if (type === "page") {
        page = prepare(new Uint8ClampedArray(payload.data), payload.width, payload.height);
        pageKey = payload.key;
        self.postMessage({ id, result: true });
      } else if (type === "select") {
        if (!page || pageKey !== payload.key) {
          self.postMessage({ id, result: { stale: true } });
          return;
        }
        const result = select(page, payload);
        self.postMessage({ id, result }, result ? [result.mask.buffer] : []);
      }
    } catch (error) {
      self.postMessage({ id, error: String((error && error.message) || error) });
    }
  };
  self.postMessage({ ready: true });
}
