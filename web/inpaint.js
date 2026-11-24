// TypeR: Content-Aware Fill. The selection is painted over with what surrounds it, from the
// same family of methods as Photoshop's (Wexler's coarse-to-fine synthesis, matched with
// PatchMatch), with a few things of its own: a patch is compared on its structure as much as
// on its tones, so lines and screentone carry on straight; the source can be read in a mirror;
// what every patch votes for is weighed by how well it matched; and the result's tones are
// bent at the end to meet the edge of the hole, as Photoshop's Colour Adaptation, except that
// the bending stops at lines, so that a mismatched stroke can't bleed into the fill.
//
// And one thing that isn't patches at all: where the hole is in a screentone with dots that
// can be told apart, the screentone is measured (its grid, its tone, its dot) and drawn again
// on the page's own grid, with the lines that cross it. See "screentones" below.
//
// Runs in a worker (new Worker("inpaint.js")), so the page stays alive, and loads as a plain
// script too, for a browser that refuses workers: window.TypeRInpaint.inpaint does the same.

"use strict";

(function (root) {
  const HALF = 3;
  const PATCH = HALF * 2 + 1;
  // The coarsest level still shows the hole this long: a stroke crossing it has to be seen there
  // to be carried on, and a stroke is only seen while it is thicker than a pixel
  const COARSEST = 40;
  // How much a difference of gradient counts, against a difference of tone
  const STRUCTURE = 0.6;
  // Colour adaptation never bends by more than this, nor where the page has a line
  const ADAPT_MAX = 32;
  const ADAPT_EDGE = 20;

  let seed = 0x9e3779b9;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };

  /* ------------------------------ the pyramid ------------------------------ */

  // A level: tones in rgb, 3 floats a pixel; hole: 1 where there is something to fill; known:
  // 1 where a patch may be read from (neither hole, transparent nor kept out of the sampling)
  const makeLevel = (w, h) => ({ w, h, rgb: new Float32Array(w * h * 3), hole: new Uint8Array(w * h), known: new Uint8Array(w * h) });

  const finestLevel = (data, w, h, mask, source) => {
    const L = makeLevel(w, h);
    const { rgb, hole, known } = L;
    for (let i = 0, n = w * h; i < n; i++) {
      rgb[i * 3] = data[i * 4];
      rgb[i * 3 + 1] = data[i * 4 + 1];
      rgb[i * 3 + 2] = data[i * 4 + 2];
      if (mask[i]) hole[i] = 1;
      else if (source[i] && data[i * 4 + 3] >= 128) known[i] = 1;
    }
    return L;
  };

  // Half the size, through a [1 3 3 1] filter: a screentone that the coarse level can't show
  // has to come out as its plain grey, not as a moiré the finer levels would then follow. A
  // coarse pixel is a hole if any of its four is, and its tone is the mean of the rest.
  const TAPS = [1, 3, 3, 1];
  const coarser = (F) => {
    const w = Math.ceil(F.w / 2);
    const h = Math.ceil(F.h / 2);
    const C = makeLevel(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        let anyHole = 0;
        let anyKnown = 0;
        for (let dy = -1; dy <= 2; dy++) {
          const fy = y * 2 + dy;
          if (fy < 0 || fy >= F.h) continue;
          for (let dx = -1; dx <= 2; dx++) {
            const fx = x * 2 + dx;
            if (fx < 0 || fx >= F.w) continue;
            const i = fy * F.w + fx;
            const central = dy >= 0 && dy <= 1 && dx >= 0 && dx <= 1;
            if (F.hole[i]) {
              if (central) anyHole = 1;
              continue;
            }
            if (central && F.known[i]) anyKnown = 1;
            const t = TAPS[dy + 1] * TAPS[dx + 1];
            r += F.rgb[i * 3] * t;
            g += F.rgb[i * 3 + 1] * t;
            b += F.rgb[i * 3 + 2] * t;
            n += t;
          }
        }
        const i = y * w + x;
        if (n) {
          C.rgb[i * 3] = r / n;
          C.rgb[i * 3 + 1] = g / n;
          C.rgb[i * 3 + 2] = b / n;
        }
        C.hole[i] = anyHole;
        C.known[i] = anyHole ? 0 : anyKnown;
      }
    }
    return C;
  };

  const holeBox = (L) => {
    let left = L.w;
    let top = L.h;
    let right = -1;
    let bottom = -1;
    for (let y = 0; y < L.h; y++) {
      for (let x = 0; x < L.w; x++) {
        if (!L.hole[y * L.w + x]) continue;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
    return right < 0 ? null : { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1 };
  };

  // 1 within `r` pixels (Chebyshev) of a set pixel
  const dilate = (src, w, h, r) => {
    const mid = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (!src[row + x]) continue;
        const x0 = Math.max(0, x - r);
        const x1 = Math.min(w - 1, x + r);
        for (let k = x0; k <= x1; k++) mid[row + k] = 1;
      }
    }
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!mid[y * w + x]) continue;
        const y0 = Math.max(0, y - r);
        const y1 = Math.min(h - 1, y + r);
        for (let k = y0; k <= y1; k++) out[k * w + x] = 1;
      }
    }
    return out;
  };

  // What the level needs before matching: the centres of the patches to match (every pixel
  // of the hole and those within a patch of it: the fill has to agree with its edge), and the
  // centres a patch may be read from (a whole patch of known pixels, `half` each way)
  const prepare = (L, half) => {
    const { w, h, hole, known } = L;
    const near = dilate(hole, w, h, half);
    const band = [];
    for (let y = half; y < h - half; y++) {
      for (let x = half; x < w - half; x++) if (near[y * w + x]) band.push(y * w + x);
    }
    L.band = Int32Array.from(band);
    // Count of unknown pixels in any box, from a summed-area table
    const W = w + 1;
    const sum = new Int32Array(W * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += known[y * w + x] ? 0 : 1;
        sum[(y + 1) * W + x + 1] = sum[y * W + x + 1] + row;
      }
    }
    const ok = new Uint8Array(w * h);
    const okList = [];
    const side = half * 2 + 1;
    for (let y = half; y < h - half; y++) {
      for (let x = half; x < w - half; x++) {
        const x0 = x - half;
        const y0 = y - half;
        const unknown = sum[(y0 + side) * W + x0 + side] - sum[y0 * W + x0 + side] - sum[(y0 + side) * W + x0] + sum[y0 * W + x0];
        if (unknown === 0) {
          ok[y * w + x] = 1;
          okList.push(y * w + x);
        }
      }
    }
    L.ok = ok;
    L.okList = Int32Array.from(okList);
    L.half = half;
    L.nnX = new Int32Array(w * h).fill(-1);
    L.nnY = new Int32Array(w * h);
    L.nnM = new Uint8Array(w * h);
    L.nnD = new Float32Array(w * h).fill(Infinity);
    L.gx = new Float32Array(w * h);
    L.gy = new Float32Array(w * h);
    L.luma = new Float32Array(w * h);
    // How far each pixel is to be trusted: the page's own, wholly; the fill, as much as what
    // it was made from. Trust spreads inwards from the edge of the hole, round after round.
    L.conf = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) L.conf[i] = known[i] ? 1 : 0.05;
  };

  const gradients = (L, box) => {
    const { w, h, rgb, gx, gy, luma } = L;
    const bx0 = box ? Math.max(0, box.left) : 0;
    const by0 = box ? Math.max(0, box.top) : 0;
    const bx1 = box ? Math.min(w - 1, box.right) : w - 1;
    const by1 = box ? Math.min(h - 1, box.bottom) : h - 1;
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        const i = y * w + x;
        luma[i] = 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
      }
    }
    for (let y = Math.max(0, by0 - 1); y <= Math.min(h - 1, by1 + 1); y++) {
      const up = Math.max(0, y - 1) * w;
      const down = Math.min(h - 1, y + 1) * w;
      const row = y * w;
      for (let x = Math.max(0, bx0 - 1); x <= Math.min(w - 1, bx1 + 1); x++) {
        gx[row + x] = (luma[row + Math.min(w - 1, x + 1)] - luma[row + Math.max(0, x - 1)]) * 0.5;
        gy[row + x] = (luma[down + x] - luma[up + x]) * 0.5;
      }
    }
  };

  // The coarsest level starts from a smooth guess: the hole's edge, diffused inwards
  const diffuse = (L) => {
    const { w, h, rgb, hole } = L;
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    const near = dilate(hole, w, h, 1);
    for (let i = 0, count = w * h; i < count; i++) {
      if (!near[i] || hole[i]) continue;
      r += rgb[i * 3];
      g += rgb[i * 3 + 1];
      b += rgb[i * 3 + 2];
      n++;
    }
    if (!n) return;
    const list = [];
    for (let i = 0, count = w * h; i < count; i++) {
      if (!hole[i]) continue;
      list.push(i);
      rgb[i * 3] = r / n;
      rgb[i * 3 + 1] = g / n;
      rgb[i * 3 + 2] = b / n;
    }
    const next = new Float32Array(rgb.length);
    for (let round = 0; round < 120; round++) {
      let moved = 0;
      for (let k = 0; k < list.length; k++) {
        const i = list[k];
        const x = i % w;
        const y = (i - x) / w;
        const l = x > 0 ? i - 1 : i;
        const rr = x < w - 1 ? i + 1 : i;
        const u = y > 0 ? i - w : i;
        const d = y < h - 1 ? i + w : i;
        for (let c = 0; c < 3; c++) {
          const value = (rgb[l * 3 + c] + rgb[rr * 3 + c] + rgb[u * 3 + c] + rgb[d * 3 + c]) * 0.25;
          moved = Math.max(moved, Math.abs(value - rgb[i * 3 + c]));
          next[i * 3 + c] = value;
        }
      }
      for (let k = 0; k < list.length; k++) {
        const i = list[k];
        rgb[i * 3] = next[i * 3];
        rgb[i * 3 + 1] = next[i * 3 + 1];
        rgb[i * 3 + 2] = next[i * 3 + 2];
      }
      if (moved < 0.1) break;
    }
  };

  // Then the hole is filled from its edge inwards, a patch at a time, where a line enters it
  // first (Criminisi 2004): a lone stroke crossing the hole carries on across, instead of
  // fading into whatever surrounds it. At every level, not only the coarsest: a patch is
  // chosen next to where its neighbours were read, so a screentone keeps its exact step,
  // which the coarser level, too coarse to see the dots, couldn't tell. The matching rounds
  // then make the whole agree.
  const SEED_CANDIDATES = 30000;
  const SEED_RANDOM = 256;
  const structureFirst = (L) => {
    const { w, h, rgb, hole, half, ok, okList, conf } = L;
    if (!okList.length) return;
    const side = half * 2 + 1;
    const filled = new Uint8Array(w * h);
    const confidence = new Float32Array(w * h);
    const from = new Int32Array(w * h).fill(-1);
    let left = 0;
    for (let i = 0, n = w * h; i < n; i++) {
      if (hole[i]) left++;
      else {
        filled[i] = 1;
        confidence[i] = 1;
      }
    }
    gradients(L);
    const { gx, gy } = L;
    const box = holeBox(L);
    const x0 = Math.max(half, box.left - 1);
    const x1 = Math.min(w - half - 1, box.right + 1);
    const y0 = Math.max(half, box.top - 1);
    const y1 = Math.min(h - half - 1, box.bottom + 1);
    // Only the filled pixels count. What the coarser level guessed for the rest is blurred,
    // and pixel for pixel it would favour the flattest patch over the right one.
    const patchDistance = (tx, ty, qx, qy, cutoff) => {
      let d = 0;
      for (let dy = -half; dy <= half; dy++) {
        let ti = (ty + dy) * w + tx - half;
        let qi = (qy + dy) * w + qx - half;
        for (let k = 0; k < side; k++, ti++, qi++) {
          if (!filled[ti]) continue;
          const t3 = ti * 3;
          const q3 = qi * 3;
          let e = rgb[t3] - rgb[q3];
          let p = e * e;
          e = rgb[t3 + 1] - rgb[q3 + 1];
          p += e * e;
          e = rgb[t3 + 2] - rgb[q3 + 2];
          p += e * e;
          // A gradient at the front is half guesswork: it only counts a pixel away from it
          if (filled[ti - 1] && filled[ti + 1] && filled[ti - w] && filled[ti + w]) {
            e = gx[ti] - gx[qi];
            p += STRUCTURE * e * e;
            e = gy[ti] - gy[qi];
            p += STRUCTURE * e * e;
          }
          d += p;
        }
        if (d >= cutoff) return d;
      }
      return d;
    };
    const exhaustive = okList.length <= SEED_CANDIDATES;
    let bestQ = -1;
    let bestD = Infinity;
    const consider = (qx, qy) => {
      if (qx < half || qy < half || qx >= w - half || qy >= h - half) return;
      const q = qy * w + qx;
      if (!ok[q]) return;
      const d = patchDistance(tx, ty, qx, qy, bestD);
      if (d < bestD) {
        bestD = d;
        bestQ = q;
      }
    };
    let tx = 0;
    let ty = 0;
    // The front: unfilled pixels touching filled ones, as patch centres inside the picture.
    // Its priority: how sure the patch is, times how strong the line entering it across the
    // front. Kept up to date around each patch laid, instead of read again all over.
    const priority = new Float32Array(w * h).fill(-1);
    const front = [];
    const assess = (x, y) => {
      const i = y * w + x;
      if (filled[i]) {
        priority[i] = -1;
        return;
      }
      const nx = (filled[i + 1] ? 1 : 0) - (filled[i - 1] ? 1 : 0);
      const ny = (filled[i + w] ? 1 : 0) - (filled[i - w] ? 1 : 0);
      if (!nx && !ny && !filled[i - w - 1] && !filled[i - w + 1] && !filled[i + w - 1] && !filled[i + w + 1]) {
        priority[i] = -1;
        return;
      }
      let sure = 0;
      let strongest = 0;
      let isoX = 0;
      let isoY = 0;
      for (let dy = -half; dy <= half; dy++) {
        for (let dx = -half; dx <= half; dx++) {
          const j = (y + dy) * w + x + dx;
          sure += confidence[j];
          if (!filled[j]) continue;
          const mag = gx[j] * gx[j] + gy[j] * gy[j];
          if (mag > strongest) {
            strongest = mag;
            isoX = -gy[j];
            isoY = gx[j];
          }
        }
      }
      sure /= side * side;
      const norm = Math.hypot(nx, ny) || 1;
      const data = Math.abs(isoX * nx + isoY * ny) / norm / 255 + 0.001;
      if (priority[i] < 0) front.push(i);
      priority[i] = sure * data;
      L.sureAt[i] = sure;
    };
    L.sureAt = new Float32Array(w * h);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) assess(x, y);
    }
    while (left > 0) {
      let best = -1;
      let bestPriority = -1;
      let kept = 0;
      for (let k = 0; k < front.length; k++) {
        const i = front[k];
        if (priority[i] < 0) continue;
        front[kept++] = i;
        if (priority[i] > bestPriority) {
          bestPriority = priority[i];
          best = i;
        }
      }
      front.length = kept;
      const bestSure = best >= 0 ? L.sureAt[best] : 0;
      if (best < 0) break;
      tx = best % w;
      ty = (best - tx) / w;
      bestQ = -1;
      bestD = Infinity;
      // Next to where the neighbours were read first: all else equal, the texture goes on
      // from where it came
      for (let dy = -half; dy <= half; dy++) {
        for (let dx = -half; dx <= half; dx++) {
          const j = (ty + dy) * w + tx + dx;
          if (from[j] < 0) continue;
          const sx = from[j] % w;
          consider(sx - dx, (from[j] - sx) / w - dy);
        }
      }
      if (exhaustive) {
        for (let k = 0; k < okList.length; k++) {
          const q = okList[k];
          const qx = q % w;
          consider(qx, (q - qx) / w);
        }
      } else {
        // Where the coarser level read, then at random
        if (L.nnX[best] >= 0) {
          consider(L.nnX[best], L.nnY[best]);
          for (let r = 4; r >= 1; r = r >> 1) {
            for (let k = 0; k < 4; k++) consider(L.nnX[best] + Math.round((random() * 2 - 1) * r), L.nnY[best] + Math.round((random() * 2 - 1) * r));
          }
        }
        for (let k = 0; k < SEED_RANDOM; k++) {
          const q = okList[Math.floor(random() * okList.length)];
          const qx = q % w;
          consider(qx, (q - qx) / w);
        }
      }
      if (bestQ < 0) break;
      const qx = bestQ % w;
      const qy = (bestQ - qx) / w;
      const sure = bestSure;
      for (let dy = -half; dy <= half; dy++) {
        for (let dx = -half; dx <= half; dx++) {
          const i = (ty + dy) * w + tx + dx;
          if (filled[i]) continue;
          const s = (qy + dy) * w + qx + dx;
          rgb[i * 3] = rgb[s * 3];
          rgb[i * 3 + 1] = rgb[s * 3 + 1];
          rgb[i * 3 + 2] = rgb[s * 3 + 2];
          filled[i] = 1;
          confidence[i] = sure;
          from[i] = s;
          left--;
        }
      }
      // Hole pixels at the very border of the picture can't be patch centres: they come last
      if (left > 0) {
        let anyInside = false;
        for (let y = y0; y <= y1 && !anyInside; y++) {
          for (let x = x0; x <= x1; x++) if (!filled[y * w + x]) { anyInside = true; break; }
        }
        if (!anyInside) break;
      }
      gradients(L, { left: tx - half, top: ty - half, right: tx + half, bottom: ty + half });
      for (let y = Math.max(y0, ty - half * 2 - 1); y <= Math.min(y1, ty + half * 2 + 1); y++) {
        for (let x = Math.max(x0, tx - half * 2 - 1); x <= Math.min(x1, tx + half * 2 + 1); x++) assess(x, y);
      }
    }
    // The matching starts from where the seed read each pixel: a first vote from matches
    // made at random would undo the seed's lines
    for (let i = 0, n = w * h; i < n; i++) {
      if (hole[i]) conf[i] = Math.max(0.05, confidence[i]);
      const s = from[i];
      if (s < 0 || !ok[s]) continue;
      const sx = s % w;
      L.nnX[i] = sx;
      L.nnY[i] = (s - sx) / w;
      L.nnM[i] = 0;
    }
  };

  const seedHole = (L) => {
    diffuse(L);
    structureFirst(L);
  };

  /* ------------------------------- matching ------------------------------- */

  // How unlike the patch around the target is to the one around the source, read mirrored
  // when m is set. Stops counting past `cutoff`: a worse candidate needn't be measured whole.
  const distance = (L, tx, ty, qx, qy, m, cutoff) => {
    const { w, rgb, gx, gy, half, conf } = L;
    const side = half * 2 + 1;
    const sign = m ? -1 : 1;
    let d = 0;
    for (let dy = -half; dy <= half; dy++) {
      let ti = (ty + dy) * w + tx - half;
      let qi = (qy + dy) * w + qx - sign * half;
      for (let k = 0; k < side; k++) {
        const t3 = ti * 3;
        const q3 = qi * 3;
        let e = rgb[t3] - rgb[q3];
        let p = e * e;
        e = rgb[t3 + 1] - rgb[q3 + 1];
        p += e * e;
        e = rgb[t3 + 2] - rgb[q3 + 2];
        p += e * e;
        e = gx[ti] - sign * gx[qi];
        p += STRUCTURE * e * e;
        e = gy[ti] - gy[qi];
        p += STRUCTURE * e * e;
        d += p * conf[ti];
        ti++;
        qi += sign;
      }
      if (d >= cutoff) return d;
    }
    return d;
  };

  // A candidate found at random has to be clearly better to replace the current match; one
  // handed over by a neighbour only has to be as good. Where everything matches alike (a
  // texture too fine for the level, a flat tone), the matches then stay coherent, patch after
  // patch, instead of scattering: the finer levels inherit a field they can refine.
  const RANDOM_MARGIN = 0.97;
  const tryCandidate = (L, t, tx, ty, qx, qy, m, loose) => {
    if (qx < L.half || qy < L.half || qx >= L.w - L.half || qy >= L.h - L.half) return;
    const q = qy * L.w + qx;
    if (!L.ok[q]) return;
    if (L.nnX[t] === qx && L.nnY[t] === qy && L.nnM[t] === m) return;
    const limit = loose ? L.nnD[t] : L.nnD[t] * RANDOM_MARGIN;
    const d = distance(L, tx, ty, qx, qy, m, limit);
    if (d < limit || (loose && d === limit && d < Infinity)) {
      L.nnX[t] = qx;
      L.nnY[t] = qy;
      L.nnM[t] = m;
      L.nnD[t] = d;
    }
  };

  const randomCandidate = (L, t, tx, ty, mirror) => {
    const q = L.okList[Math.floor(random() * L.okList.length)];
    const qx = q % L.w;
    tryCandidate(L, t, tx, ty, qx, (q - qx) / L.w, mirror && random() < 0.5 ? 1 : 0);
  };

  // Every centre of the band gets a match, at random when it has none
  const ensureMatches = (L, mirror) => {
    const { band, w } = L;
    for (let k = 0; k < band.length; k++) {
      const t = band[k];
      const tx = t % w;
      const ty = (t - tx) / w;
      if (L.nnX[t] >= 0) {
        L.nnD[t] = distance(L, tx, ty, L.nnX[t], L.nnY[t], L.nnM[t], Infinity);
        continue;
      }
      L.nnD[t] = Infinity;
      for (let tries = 0; tries < 3 && L.nnX[t] < 0; tries++) randomCandidate(L, t, tx, ty, mirror);
    }
  };

  // One pass of PatchMatch: each centre tries its neighbours' matches shifted by one, then a
  // few at random around its own, closer and closer
  const patchMatch = (L, iteration, radius, mirror) => {
    const { band, w } = L;
    const forward = iteration % 2 === 0;
    for (let n = 0; n < band.length; n++) {
      const t = band[forward ? n : band.length - 1 - n];
      const tx = t % w;
      const ty = (t - tx) / w;
      const step = forward ? 1 : -1;
      // From the neighbour before, along the row
      const a = t - step;
      if (L.nnX[a] >= 0) tryCandidate(L, t, tx, ty, L.nnX[a] + (L.nnM[a] ? -step : step), L.nnY[a], L.nnM[a], true);
      // From the neighbour before, along the column
      const b = t - step * w;
      if (b >= 0 && b < L.nnX.length && L.nnX[b] >= 0) tryCandidate(L, t, tx, ty, L.nnX[b], L.nnY[b] + step, L.nnM[b], true);
      if (L.nnX[t] < 0) {
        randomCandidate(L, t, tx, ty, mirror);
        if (L.nnX[t] < 0) continue;
      }
      const bx = L.nnX[t];
      const by = L.nnY[t];
      const bm = L.nnM[t];
      for (let r = radius; r >= 1; r = Math.floor(r / 2)) {
        const qx = bx + Math.round((random() * 2 - 1) * r);
        const qy = by + Math.round((random() * 2 - 1) * r);
        tryCandidate(L, t, tx, ty, qx, qy, mirror && random() < 0.5 ? 1 - bm : bm);
      }
    }
  };

  // Every patch of the band lays its match over the pixels it covers; a pixel of the hole
  // becomes the mean of what it got, the better matches weighing more. Returns what the
  // known pixels got too: colour adaptation compares it to what they are.
  const vote = (L, sharpness) => {
    const { band, w, rgb, hole, nnX, nnY, nnM, nnD, half, conf } = L;
    const area = (half * 2 + 1) * (half * 2 + 1);
    // How far each patch is trusted: the mean trust of what it covers. A distance was weighed
    // the same way, so it is read against the patch's trust to compare patches fairly.
    const trust = new Float32Array(band.length);
    let mean = 0;
    let count = 0;
    for (let k = 0; k < band.length; k++) {
      const t = band[k];
      if (nnX[t] < 0) continue;
      const tx = t % w;
      const ty = (t - tx) / w;
      let sum = 0;
      for (let dy = -half; dy <= half; dy++) {
        const row = (ty + dy) * w + tx - half;
        for (let i = 0; i < half * 2 + 1; i++) sum += conf[row + i];
      }
      trust[k] = sum / area;
      mean += nnD[t] / trust[k];
      count++;
    }
    if (!count) return null;
    const sigma2 = Math.max(1, (mean / count) * sharpness);
    const acc = new Float32Array(w * L.h * 3);
    const weight = new Float32Array(w * L.h);
    const sure = new Float32Array(w * L.h);
    for (let k = 0; k < band.length; k++) {
      const t = band[k];
      if (nnX[t] < 0) continue;
      const wgt = Math.max(1e-6, Math.exp(-nnD[t] / trust[k] / sigma2)) * trust[k];
      const tx = t % w;
      const ty = (t - tx) / w;
      const sign = nnM[t] ? -1 : 1;
      for (let dy = -half; dy <= half; dy++) {
        let p = (ty + dy) * w + tx - half;
        let s = (nnY[t] + dy) * w + nnX[t] - sign * half;
        for (let i = -half; i <= half; i++) {
          acc[p * 3] += wgt * rgb[s * 3];
          acc[p * 3 + 1] += wgt * rgb[s * 3 + 1];
          acc[p * 3 + 2] += wgt * rgb[s * 3 + 2];
          weight[p] += wgt;
          sure[p] += wgt * trust[k];
          p++;
          s += sign;
        }
      }
    }
    for (let i = 0, n = w * L.h; i < n; i++) {
      if (!hole[i] || !weight[i]) continue;
      rgb[i * 3] = acc[i * 3] / weight[i];
      rgb[i * 3 + 1] = acc[i * 3 + 1] / weight[i];
      rgb[i * 3 + 2] = acc[i * 3 + 2] / weight[i];
      conf[i] = Math.min(1, sure[i] / weight[i]);
    }
    return { acc, weight };
  };

  // The finer level takes the coarser's result for its hole, and starts its matches from
  // the coarser's, doubled
  const refine = (C, F) => {
    const { w, h, rgb, hole } = F;
    for (let y = 0; y < h; y++) {
      const sy = Math.max(0, Math.min(C.h - 1, (y + 0.5) / 2 - 0.5));
      const y0 = Math.floor(sy);
      const y1 = Math.min(C.h - 1, y0 + 1);
      const fy = sy - y0;
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!hole[i]) continue;
        const sx = Math.max(0, Math.min(C.w - 1, (x + 0.5) / 2 - 0.5));
        const x0 = Math.floor(sx);
        const x1 = Math.min(C.w - 1, x0 + 1);
        const fx = sx - x0;
        for (let c = 0; c < 3; c++) {
          const top = C.rgb[(y0 * C.w + x0) * 3 + c] * (1 - fx) + C.rgb[(y0 * C.w + x1) * 3 + c] * fx;
          const bottom = C.rgb[(y1 * C.w + x0) * 3 + c] * (1 - fx) + C.rgb[(y1 * C.w + x1) * 3 + c] * fx;
          rgb[i * 3 + c] = top * (1 - fy) + bottom * fy;
        }
        F.conf[i] = C.conf[(y >> 1) * C.w + (x >> 1)] * 0.5;
      }
    }
    const { band } = F;
    for (let k = 0; k < band.length; k++) {
      const t = band[k];
      const tx = t % w;
      const ty = (t - tx) / w;
      const parent = (ty >> 1) * C.w + (tx >> 1);
      if (C.nnX[parent] < 0) continue;
      const m = C.nnM[parent];
      const qx = C.nnX[parent] * 2 + (m ? 1 - (tx & 1) : tx & 1);
      const qy = C.nnY[parent] * 2 + (ty & 1);
      if (qx < F.half || qy < F.half || qx >= w - F.half || qy >= h - F.half || !F.ok[qy * w + qx]) continue;
      F.nnX[t] = qx;
      F.nnY[t] = qy;
      F.nnM[t] = m;
    }
  };

  /* --------------------------- colour adaptation --------------------------- */

  // What the fill got at the known pixels along the hole's edge, against what they are: the
  // difference, spread smoothly over the hole, bends the fill to meet its edge. Not across
  // a line: where the page has an edge, the difference is a misplaced stroke, not a tone.
  const adaptColours = (levels, votes) => {
    const F = levels[0];
    const { w, h, rgb, hole, gx, gy } = F;
    const ring = new Uint8Array(w * h);
    const value = new Float32Array(w * h * 3);
    let any = false;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (hole[i] || !votes.weight[i]) continue;
        const edge = (x > 0 && hole[i - 1]) || (x < w - 1 && hole[i + 1]) || (y > 0 && hole[i - w]) || (y < h - 1 && hole[i + w]);
        if (!edge) continue;
        ring[i] = 1;
        any = true;
        if (Math.abs(gx[i]) + Math.abs(gy[i]) > ADAPT_EDGE) continue;
        for (let c = 0; c < 3; c++) value[i * 3 + c] = Math.max(-ADAPT_MAX, Math.min(ADAPT_MAX, rgb[i * 3 + c] - votes.acc[i * 3 + c] / votes.weight[i]));
      }
    }
    if (!any) return;
    // The same problem at every level of the pyramid, solved coarse to fine
    const grids = [{ w, h, hole, ring, value, delta: new Float32Array(w * h * 3) }];
    for (let k = 1; k < levels.length; k++) {
      const fine = grids[k - 1];
      const L = levels[k];
      const coarse = { w: L.w, h: L.h, hole: L.hole, ring: new Uint8Array(L.w * L.h), value: new Float32Array(L.w * L.h * 3), delta: new Float32Array(L.w * L.h * 3) };
      for (let y = 0; y < L.h; y++) {
        for (let x = 0; x < L.w; x++) {
          const i = y * L.w + x;
          if (L.hole[i]) continue;
          let n = 0;
          for (let dy = 0; dy < 2; dy++) {
            for (let dx = 0; dx < 2; dx++) {
              const fx = x * 2 + dx;
              const fy = y * 2 + dy;
              if (fx >= fine.w || fy >= fine.h) continue;
              const j = fy * fine.w + fx;
              if (!fine.ring[j]) continue;
              n++;
              for (let c = 0; c < 3; c++) coarse.value[i * 3 + c] += fine.value[j * 3 + c];
            }
          }
          if (!n) continue;
          coarse.ring[i] = 1;
          for (let c = 0; c < 3; c++) coarse.value[i * 3 + c] /= n;
        }
      }
      grids.push(coarse);
    }
    const relax = (G, rounds) => {
      const list = [];
      for (let i = 0, n = G.w * G.h; i < n; i++) if (G.hole[i]) list.push(i);
      const at = (i) => (G.ring[i] ? G.value : G.hole[i] ? G.delta : null);
      for (let round = 0; round < rounds; round++) {
        for (let k = 0; k < list.length; k++) {
          const i = list[k];
          const x = i % G.w;
          const y = (i - x) / G.w;
          for (let c = 0; c < 3; c++) {
            let sum = 0;
            let n = 0;
            const take = (j) => {
              const from = at(j);
              if (!from) return;
              sum += from[j * 3 + c];
              n++;
            };
            if (x > 0) take(i - 1);
            if (x < G.w - 1) take(i + 1);
            if (y > 0) take(i - G.w);
            if (y < G.h - 1) take(i + G.w);
            if (n) G.delta[i * 3 + c] = sum / n;
          }
        }
      }
    };
    for (let k = grids.length - 1; k >= 0; k--) {
      const G = grids[k];
      if (k < grids.length - 1) {
        const C = grids[k + 1];
        for (let y = 0; y < G.h; y++) {
          for (let x = 0; x < G.w; x++) {
            const i = y * G.w + x;
            if (!G.hole[i]) continue;
            const j = (y >> 1) * C.w + (x >> 1);
            const from = C.ring[j] ? C.value : C.delta;
            G.delta[i * 3] = from[j * 3];
            G.delta[i * 3 + 1] = from[j * 3 + 1];
            G.delta[i * 3 + 2] = from[j * 3 + 2];
          }
        }
      }
      relax(G, k === grids.length - 1 ? 200 : 24);
    }
    const delta = grids[0].delta;
    for (let i = 0, n = w * h; i < n; i++) {
      if (!hole[i]) continue;
      rgb[i * 3] = Math.max(0, Math.min(255, rgb[i * 3] + delta[i * 3]));
      rgb[i * 3 + 1] = Math.max(0, Math.min(255, rgb[i * 3 + 1] + delta[i * 3 + 1]));
      rgb[i * 3 + 2] = Math.max(0, Math.min(255, rgb[i * 3 + 2] + delta[i * 3 + 2]));
    }
  };

  /* ------------------------------ screentones ------------------------------ */

  // A screentone is one dot repeated on a grid, its size following the tone. Around a hole in
  // one, all it is made of can be measured on the page: the grid (its two steps: where the
  // picture looks like itself again), the tone (the mean over a dot's cell) and the dot itself
  // (what a pixel is worth, by where it sits in its cell and by the tone there). The hole then
  // takes the tone of its edges, carried inwards, and the dots that go with it, drawn on the
  // page's very grid: no seam, no dot out of step, and a gradient carries on. Patches copied
  // from around, as the rest of this file does, can't promise any of that.
  //
  // How far around the hole the screentone is read, and the longest step between two dots
  const TONE_REACH = 48;
  const TONE_LAG = 26;
  // What tells a screentone: its dots stand out by this much (in tones, 0 to 255), and the dot
  // learnt from the page explains the page that well
  const TONE_CONTRAST = 9;
  const TONE_NOISE = 7;
  const TONE_FIT = 0.3;
  // And the page varies there by this much of what the dot would make it vary, at least; by
  // less than that much, it is plain: paper, or a flat black
  const TONE_SEEN = 0.35;
  const TONE_BARE = 0.12;
  // Where the hole's edges disagree, screentone here and something else there: how much of
  // what they say has to say screentone, for a pixel of the hole to be drawn as one
  const TONE_SURE = 0.9;
  // The edges disagree when this much of them, against what is screentone, is something else
  const TONE_MIXED = 0.05;
  // Then the screentone is drawn only if it is this much of the hole, at least
  const TONE_SHARE = 0.3;
  // A screentone's tone doesn't differ by more than this from the tone a little further around
  const TONE_BUMP = 28;
  // Two screentones side by side: their tones differ by more than this within a dot or two
  const TONE_EDGE = 18;
  // A tone carried over is settled once no pixel moves by this much, 0 to 255
  const TONE_SETTLED = 0.05;
  // The tones the dot is learnt at: one every so many, 0 to 255
  const TONE_STEP = 8;
  const TONE_NODES = Math.floor(255 / TONE_STEP) + 2;

  // The sum over a square of `r` pixels each way, three times over: nearly a round blur (or
  // `passes` times: once, the square itself). Past the edges there is nothing: divide by the
  // same blur of the weights for a mean.
  const blurred = (src, w, h, r, passes = 3) => {
    const a = Float32Array.from(src);
    if (r < 1) return a;
    const b = new Float32Array(w * h);
    const scale = 1 / (2 * r + 1);
    for (let pass = 0; pass < passes; pass++) {
      for (let y = 0; y < h; y++) {
        const row = y * w;
        let sum = 0;
        for (let x = 0; x <= r && x < w; x++) sum += a[row + x];
        for (let x = 0; x < w; x++) {
          b[row + x] = sum * scale;
          if (x + r + 1 < w) sum += a[row + x + r + 1];
          if (x - r >= 0) sum -= a[row + x - r];
        }
      }
      for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let y = 0; y <= r && y < h; y++) sum += b[y * w + x];
        for (let y = 0; y < h; y++) {
          a[y * w + x] = sum * scale;
          if (y + r + 1 < h) sum += b[(y + r + 1) * w + x];
          if (y - r >= 0) sum -= b[(y - r) * w + x];
        }
      }
    }
    return a;
  };
  // The mean of `value` around each pixel, over those where `weight` is set. Too few of them
  // around (less than `enough` of the blur) and `into` is left alone, `have` at 0.
  const meanAround = (value, weight, w, h, r, enough, into, have, passes) => {
    const n = w * h;
    const product = new Float32Array(n);
    for (let i = 0; i < n; i++) if (weight[i]) product[i] = value[i];
    const top = blurred(product, w, h, r, passes);
    const under = blurred(weight, w, h, r, passes);
    for (let i = 0; i < n; i++) {
      if (under[i] >= enough) {
        into[i] = top[i] / under[i];
        if (have) have[i] = 1;
      } else if (have) have[i] = 0;
    }
  };

  // `value` where `fixed` is 0 becomes what the fixed values around lead to: each pixel the
  // mean of its four neighbours, so a slope carries on across. Coarse first, then finer.
  // Nothing goes through the pixels of `wall`, if given: each side of it keeps to itself.
  // Done once no pixel moves by `settled` any more. Where only the pixels of `only` are wanted,
  // the others keep the coarse answer, which is all those need of them.
  const carried = (value, fixed, w, h, wall, settled, only) => {
    const n = w * h;
    let count = 0;
    for (let i = 0; i < n; i++) if (!fixed[i] && !(wall && wall[i])) count++;
    if (!count) return;
    const open = new Int32Array(count);
    count = 0;
    for (let i = 0; i < n; i++) if (!fixed[i] && !(wall && wall[i])) open[count++] = i;
    if (w > 3 || h > 3) {
      const cw = (w + 1) >> 1;
      const ch = (h + 1) >> 1;
      const cv = new Float32Array(cw * ch);
      const cf = new Uint8Array(cw * ch);
      const cn = new Uint8Array(cw * ch);
      // A wall stays one however coarse: thicker, but never open
      const cwall = wall ? new Uint8Array(cw * ch) : null;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          const j = (y >> 1) * cw + (x >> 1);
          if (wall && wall[i]) cwall[j] = 1;
          else if (fixed[i]) {
            cv[j] += value[i];
            cn[j]++;
          }
        }
      }
      for (let j = 0; j < cw * ch; j++) {
        if (!cn[j] || (cwall && cwall[j])) continue;
        cv[j] /= cn[j];
        cf[j] = 1;
      }
      carried(cv, cf, cw, ch, cwall, settled);
      for (let k = 0; k < open.length; k++) {
        const i = open[k];
        const x = i % w;
        const j = (((i - x) / w) >> 1) * cw + (x >> 1);
        if (!cwall || !cwall[j]) value[i] = cv[j];
      }
    } else {
      let sum = 0;
      let count = 0;
      for (let i = 0; i < n; i++) {
        if (!fixed[i] || (wall && wall[i])) continue;
        sum += value[i];
        count++;
      }
      for (let k = 0; k < open.length; k++) value[open[k]] = count ? sum / count : 0;
    }
    // Along a wall the coarser answer is missing: more rounds there to bring it from beside
    const rounds = wall ? 96 : 24;
    const list = only ? open.filter((i) => only[i]) : open;
    for (let round = 0; round < rounds; round++) {
      let most = 0;
      for (let k = 0; k < list.length; k++) {
        const i = round & 1 ? list[list.length - 1 - k] : list[k];
        const x = i % w;
        let sum = 0;
        let count = 0;
        if (x > 0 && !(wall && wall[i - 1])) {
          sum += value[i - 1];
          count++;
        }
        if (x < w - 1 && !(wall && wall[i + 1])) {
          sum += value[i + 1];
          count++;
        }
        if (i >= w && !(wall && wall[i - w])) {
          sum += value[i - w];
          count++;
        }
        if (i < n - w && !(wall && wall[i + w])) {
          sum += value[i + w];
          count++;
        }
        if (!count) continue;
        const move = 1.5 * (sum / count - value[i]);
        value[i] += move;
        if (move > most) most = move;
        else if (-move > most) most = -move;
      }
      if (most < settled) break;
    }
  };

  // The grid of the dots among the pixels of `list`: its two steps [ax, ay] and [bx, by], in
  // pixels, to a few hundredths. From where the picture, moved, falls on itself again: the
  // nearest such move, and the nearest in another direction, then each made finer on its
  // multiples (ten steps further, an error shows ten times as much). null if nothing repeats,
  // false if what does is lines and not dots.
  // Each pixel is read against the tone within `around` pixels of it: a gradient isn't a
  // repeat, nor are the letters and shapes larger than that.
  const gridOf = (gray, use, w, h, list, around) => {
    const flat = new Float32Array(w * h);
    meanAround(gray, use, w, h, around, 1e-3, flat, null);
    let spread = 0;
    for (let k = 0; k < list.length; k++) spread += (gray[list[k]] - flat[list[k]]) ** 2;
    if (spread / list.length < 60) return null;
    // Each pixel against the tone around it, and one pixel in so many: enough to find a repeat
    const every = Math.max(1, Math.round(list.length / 9000));
    const picked = new Int32Array(Math.ceil(list.length / every));
    const column = new Int32Array(picked.length);
    const stand = new Float32Array(w * h);
    for (let k = 0; k < list.length; k++) stand[list[k]] = gray[list[k]] - flat[list[k]];
    for (let k = 0; k < picked.length; k++) {
      picked[k] = list[k * every];
      column[k] = picked[k] % w;
    }
    // How alike the picture is to itself moved by (dx, dy), 1 the same, among one in `stride`
    // of the pixels picked
    const alike = (dx, dy, stride) => {
      let product = 0;
      let own = 0;
      let pairs = 0;
      const move = dy * w + dx;
      const last = w * h - move;
      const from = Math.max(0, -dx);
      const to = Math.min(w, w - dx);
      for (let k = 0; k < picked.length; k += stride) {
        const i = picked[k];
        if (column[k] < from || column[k] >= to || i >= last || !use[i + move]) continue;
        const a = stand[i];
        product += a * stand[i + move];
        own += a * a;
        pairs++;
      }
      return pairs * stride >= 150 && own > 0 ? product / own : -1;
    };
    const seen = new Map();
    const like = (dx, dy) => {
      if (dy < 0 || (dy === 0 && dx < 0)) {
        dx = -dx;
        dy = -dy;
      }
      const key = dy * 4096 + dx + 2048;
      let value = seen.get(key);
      if (value !== undefined) return value;
      value = alike(dx, dy, 1);
      seen.set(key, value);
      return value;
    };
    // The same for a move between pixels, each pixel read between its four neighbours
    const likeAt = (fx, fy) => {
      if (fy < 0) {
        fx = -fx;
        fy = -fy;
      }
      const dx = Math.floor(fx);
      const dy = Math.floor(fy);
      const tx = fx - dx;
      const ty = fy - dy;
      let product = 0;
      let own = 0;
      let other = 0;
      let pairs = 0;
      const move = dy * w + dx;
      const last = w * h - move - w - 1;
      const from = Math.max(0, -dx);
      const to = Math.min(w, w - dx - 1);
      for (let k = 0; k < picked.length; k++) {
        const i = picked[k];
        if (column[k] < from || column[k] >= to || i >= last) continue;
        const j = i + move;
        if (!use[j] || !use[j + 1] || !use[j + w] || !use[j + w + 1]) continue;
        const a = stand[i];
        const b = (stand[j] * (1 - tx) + stand[j + 1] * tx) * (1 - ty) + (stand[j + w] * (1 - tx) + stand[j + w + 1] * tx) * ty;
        product += a * b;
        own += a * a;
        other += b * b;
        pairs++;
      }
      // Against what both are worth: reading between pixels softens, and would make every
      // whole number of pixels look a better step than the true one beside it
      return pairs >= 150 && own > 0 && other > 0 ? product / Math.sqrt(own * other) : -1;
    };
    const peaks = [];
    let best = 0;
    for (let dy = 0; dy <= TONE_LAG; dy++) {
      for (let dx = -TONE_LAG; dx <= TONE_LAG; dx++) {
        if ((dy === 0 && dx <= 0) || dx * dx + dy * dy < 6 || dx * dx + dy * dy > TONE_LAG * TONE_LAG) continue;
        // A glance first, at one pixel in four: most moves show nothing alike, and a page
        // without a screentone is known for one sooner
        if (picked.length >= 2400 && alike(dx, dy, 4) < 0.1) continue;
        const value = like(dx, dy);
        if (value < 0.2) continue;
        let top = true;
        for (let ey = -1; ey <= 1 && top; ey++) {
          for (let ex = -1; ex <= 1; ex++) {
            if ((ex || ey) && like(dx + ex, dy + ey) > value) {
              top = false;
              break;
            }
          }
        }
        if (!top) continue;
        // The same again, after something else on the way: dots, with paper between them. A
        // line is the same a step further along itself too, but all along the way.
        let dip = 1;
        [0.35, 0.5, 0.65].forEach((t) => {
          dip = Math.min(dip, like(Math.round(dx * t), Math.round(dy * t)));
        });
        if (dip > value - 0.3) continue;
        peaks.push({ dx, dy, value, length: Math.hypot(dx, dy) });
        if (value > best) best = value;
      }
    }
    const strong = peaks.filter((peak) => peak.value > 0.45 * best).sort((p, q) => p.length - q.length);
    const first = strong[0];
    if (!first) return null;
    const second = strong.find((peak) => Math.abs(first.dx * peak.dy - first.dy * peak.dx) > 0.5 * first.length * peak.length);
    if (!second) return null;
    // Between two pixels: the top of the parabola through the peak and its neighbours
    const exact = (dx, dy) => {
      const c = like(dx, dy);
      const along = (before, after) => {
        const bend = before - 2 * c + after;
        return bend < 0 ? Math.max(-0.5, Math.min(0.5, (before - after) / (2 * bend))) : 0;
      };
      return [dx + along(like(dx - 1, dy), like(dx + 1, dy)), dy + along(like(dx, dy - 1), like(dx, dy + 1))];
    };
    // Counted: a screentone repeats step after step, two lines side by side only once
    let steps = 0;
    const finer = (step) => {
      let out = step;
      let before = 0;
      steps = 0;
      for (let k = 2; k < 64; k++) {
        const tx = Math.round(out[0] * k);
        const ty = Math.round(out[1] * k);
        // Each multiple further than the last, or the repeat was lost on the way
        const reach = Math.hypot(tx, ty);
        if (reach > 72 || reach <= before) break;
        before = reach;
        let bx = tx;
        let by = ty;
        let top = -2;
        for (let ey = -1; ey <= 1; ey++) {
          for (let ex = -1; ex <= 1; ex++) {
            const value = like(tx + ex, ty + ey);
            if (value > top) {
              top = value;
              bx = tx + ex;
              by = ty + ey;
            }
          }
        }
        if (top < 0.15) break;
        const at = exact(bx, by);
        out = [at[0] / k, at[1] / k];
        steps++;
      }
      return out;
    };
    // Now that the step is known, each pixel against the tone over a dot's cell around it:
    // letters, lines and shadows, larger than a dot, weigh little in what follows
    const near = Math.max(1, Math.round(0.6 * Math.max(first.length, second.length)));
    if (near < around) {
      meanAround(gray, use, w, h, near, 1e-3, flat, null);
      for (let k = 0; k < list.length; k++) stand[list[k]] = gray[list[k]] - flat[list[k]];
      seen.clear();
    }
    let a = finer(exact(first.dx, first.dy));
    if (steps < Math.min(2, Math.floor(72 / first.length) - 1)) return null;
    let b = finer(exact(second.dx, second.dy));
    if (steps < Math.min(2, Math.floor(72 / second.length) - 1)) return null;
    // Every dot, not one in two or three: a step of 6.5 pixels shows better at 13 than at 6
    // or at 7. So the places between the dots found are tried too, and the two shortest
    // steps kept.
    for (let round = 0; round < 2; round++) {
      const least = 0.5 * Math.min(likeAt(a[0], a[1]), likeAt(b[0], b[1]));
      if (!(least > 0)) return null;
      const found = [a, b];
      for (let k = 2; k <= 3; k++) {
        for (let m = -k; m <= k; m++) {
          for (let o = 0; o <= k; o++) {
            if ((m % k === 0 && o % k === 0) || (o === 0 && m < 0)) continue;
            const step = [(m * a[0] + o * b[0]) / k, (m * a[1] + o * b[1]) / k];
            if (step[0] * step[0] + step[1] * step[1] < 6) continue;
            // Alike there more than a pixel away on any side: a dot, not the way everything
            // is like itself a little way off
            const value = likeAt(step[0], step[1]);
            if (value > least && value >= likeAt(step[0] - 1, step[1]) && value >= likeAt(step[0] + 1, step[1]) && value >= likeAt(step[0], step[1] - 1) && value >= likeAt(step[0], step[1] + 1)) found.push(step);
          }
        }
      }
      if (found.length === 2) break;
      found.sort((p, q) => Math.hypot(p[0], p[1]) - Math.hypot(q[0], q[1]));
      const other = found.find((step) => Math.abs(found[0][0] * step[1] - found[0][1] * step[0]) > 0.5 * Math.hypot(found[0][0], found[0][1]) * Math.hypot(step[0], step[1]));
      if (!other) return null;
      a = found[0];
      b = other;
    }
    // Dots: half a step from one there is paper, and not half as alike; halfway between
    // four of them neither. Lines side by side are alike all along themselves. (Hatching
    // repeats along two steps as well, but it is the same all along a third.)
    const la = likeAt(a[0], a[1]);
    const lb = likeAt(b[0], b[1]);
    const least = 0.5 * Math.min(la, lb);
    if (!(least > 0.1)) return null;
    // (false: no need to look again otherwise, lines are lines however they are read.)
    if (likeAt(a[0] / 2, a[1] / 2) > 0.5 * la || likeAt(b[0] / 2, b[1] / 2) > 0.5 * lb) return false;
    if (likeAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) > least || likeAt((a[0] - b[0]) / 2, (a[1] - b[1]) / 2) > least) return false;
    // To a few hundredths of a pixel: the dots two, four, eight steps away are looked for
    // where the step says, and say in turn what the step is
    const sharper = (step, alike) => {
      let out = step;
      let far = 1;
      for (let k = 2; Math.hypot(out[0] * k, out[1] * k) <= 64; k *= 2) {
        let x = out[0] * k;
        let y = out[1] * k;
        let top = likeAt(x, y);
        for (const move of [0.5, 0.25, 0.1]) {
          for (let tries = 0; tries < 8; tries++) {
            let better = null;
            [[move, 0], [-move, 0], [0, move], [0, -move]].forEach(([mx, my]) => {
              const value = likeAt(x + mx, y + my);
              if (value > top) {
                top = value;
                better = [x + mx, y + my];
              }
            });
            if (!better) break;
            [x, y] = better;
          }
        }
        // Lost on the way: no further
        if (top < 0.5 * alike || Math.hypot(x - out[0] * k, y - out[1] * k) > 2) break;
        out = [x / k, y / k];
        far = k;
      }
      return { step: out, far };
    };
    const one = sharper(a, la);
    const two = sharper(b, lb);
    // A screentone's grid is square, nearly always. Where one step could be followed further
    // than the other (a strip of screentone, narrow one way), and the other is close to that
    // one turned a quarter, it is that one turned a quarter.
    if (one.far !== two.far) {
      const sure = one.far > two.far ? one : two;
      const other = sure === one ? two : one;
      const turned = [-sure.step[1], sure.step[0]];
      if (turned[0] * other.step[0] + turned[1] * other.step[1] < 0) {
        turned[0] = -turned[0];
        turned[1] = -turned[1];
      }
      if (Math.hypot(turned[0] - other.step[0], turned[1] - other.step[1]) < 0.06 * Math.hypot(turned[0], turned[1])) other.step = turned;
    }
    return { a: one.step, b: two.step };
  };

  // The screentone around the hole of `mask`, or null if there is none: what to paint in the
  // hole (`rgb`, over the box `x`, `y`, `w`, `h` of the region), where (`tone`: 1 in the
  // screentone, 0 out of it, as the hole's edges say; `whole` if all of the hole is), and the
  // lines over the screentone that cross the hole (`lines`, RGBA to paint over it, or null).
  // Also `hole`, the mask over the box, and `grid`, the two steps of the dots.
  // Where the hole's edges are of two minds (screentone on one side, paper, a flat black or
  // another screentone on the other), only what is surely screentone is kept, or nothing: the
  // patches do better at an edge that no line draws.
  const screentone = (data, width, height, mask) => {
    let left = width;
    let top = height;
    let right = -1;
    let bottom = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!mask[y * width + x]) continue;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
    if (right < 0) return null;
    const x0 = Math.max(0, left - TONE_REACH);
    const y0 = Math.max(0, top - TONE_REACH);
    const w = Math.min(width, right + TONE_REACH + 1) - x0;
    const h = Math.min(height, bottom + TONE_REACH + 1) - y0;
    const n = w * h;
    const gray = new Float32Array(n);
    const hole = new Uint8Array(n);
    const known = new Float32Array(n);
    // How far from the hole, in steps along the rows and columns
    const far = new Uint16Array(n).fill(65535);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const p = (y + y0) * width + x + x0;
        gray[i] = data[p * 4] * 0.299 + data[p * 4 + 1] * 0.587 + data[p * 4 + 2] * 0.114;
        if (mask[p]) {
          hole[i] = 1;
          far[i] = 0;
        } else if (data[p * 4 + 3] >= 128) known[i] = 1;
      }
    }
    for (let i = 0; i < n; i++) {
      const x = i % w;
      if (x > 0 && far[i - 1] + 1 < far[i]) far[i] = far[i - 1] + 1;
      if (i >= w && far[i - w] + 1 < far[i]) far[i] = far[i - w] + 1;
    }
    for (let i = n - 1; i >= 0; i--) {
      const x = i % w;
      if (x < w - 1 && far[i + 1] + 1 < far[i]) far[i] = far[i + 1] + 1;
      if (i < n - w && far[i + w] + 1 < far[i]) far[i] = far[i + w] + 1;
    }
    // What is read: the pixels of the page within reach of the hole
    const use = new Float32Array(n);
    const around = [];
    for (let i = 0; i < n; i++) {
      if (!known[i] || far[i] > TONE_REACH) continue;
      use[i] = 1;
      around.push(i);
    }
    if (around.length < 300) return null;
    // Fine dots first, read closely: among letters and lines, a wider look sees little else
    let grid = gridOf(gray, use, w, h, around, 3);
    if (grid === null) grid = gridOf(gray, use, w, h, around, 6);
    if (!grid) return null;
    const la = Math.hypot(grid.a[0], grid.a[1]);
    const lb = Math.hypot(grid.b[0], grid.b[1]);
    const area = Math.abs(grid.a[0] * grid.b[1] - grid.a[1] * grid.b[0]);
    if (area < 4 || area < 0.4 * la * lb) return null;
    // A screentone's dots are as far apart one way as the other, in squares or, seldom, in
    // triangles. Anything else that repeats (lettering, bricks, a row of windows) isn't one.
    const lean = Math.abs(grid.a[0] * grid.b[0] + grid.a[1] * grid.b[1]) / (la * lb);
    if (Math.max(la, lb) > 1.2 * Math.min(la, lb) || (lean > 0.2 && Math.abs(lean - 0.5) > 0.12)) return null;
    const pitch = Math.max(la, lb);
    const r = Math.max(1, Math.round(0.6 * pitch));
    // Where a pixel sits in its cell, 0 to 1 along each step of the grid: u = U·(x, y, 1)
    const cross = grid.a[0] * grid.b[1] - grid.a[1] * grid.b[0];
    const U = [grid.b[1] / cross, -grid.b[0] / cross, 0];
    const V = [-grid.a[1] / cross, grid.a[0] / cross, 0];
    const cu = new Float32Array(n);
    const cv = new Float32Array(n);
    const place = () => {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const u = U[0] * x + U[1] * y + U[2];
          const v = V[0] * x + V[1] * y + V[2];
          cu[y * w + x] = u - Math.floor(u);
          cv[y * w + x] = v - Math.floor(v);
        }
      }
    };
    // The tone at each pixel: the mean over the dots around it, among the pixels of `member`.
    // Beside the hole, or a line, some are missing, and a mean without them leans to one side
    // (lighter, if what is missing is a dot): there, as in the hole, the tone is that of the
    // pixels further off, carried over (into the hole too, once it is the hole's turn).
    const level = new Float32Array(n);
    const levelled = new Uint8Array(n);
    const member = new Float32Array(use);
    const patched = new Float32Array(n);
    const levels = (drawn, inHole) => {
      if (drawn) {
        // A pixel left out (a dot that a letter touches, a line) is counted as what the
        // screentone would be there: a mean without it would lean to one side, lighter if
        // what is missing is a dot. Screentone has to be most of what is around all the same.
        for (let k = 0; k < around.length; k++) {
          const i = around[k];
          patched[i] = member[i] ? gray[i] : model[i * 3] * 0.299 + model[i * 3 + 1] * 0.587 + model[i * 3 + 2] * 0.114;
        }
        meanAround(patched, use, w, h, r, 0.9, level, levelled);
        const share = blurred(member, w, h, r);
        for (let i = 0; i < n; i++) if (share[i] < 0.7) levelled[i] = 0;
      } else meanAround(gray, member, w, h, r, 0.9, level, levelled);
      let any = false;
      for (let i = 0; i < n; i++) {
        if (levelled[i]) any = true;
        else level[i] = 0;
      }
      if (any) carried(level, levelled, w, h, null, TONE_SETTLED, inHole ? null : use);
      return any;
    };
    // The grid, made exact: the dots of the page are followed all over (which way each lot of
    // them is off the grid, from the wave they draw along each step), and the grid is moved,
    // turned and stretched to go through them. An error of a hundredth of a pixel a dot is a
    // quarter of a dot off across a wide hole in a fine screentone.
    const lock = () => {
      const every = Math.max(1, Math.round(pitch / 3));
      // Only where screentone is all around: at its edge, half a dot is missing from the
      // measure, and pulls it to one side
      const whole = blurred(member, w, h, r);
      const parts = [new Float32Array(n), new Float32Array(n), new Float32Array(n), new Float32Array(n)];
      for (let k = 0; k < around.length; k++) {
        const i = around[k];
        if (!member[i]) continue;
        const d = gray[i] - level[i];
        parts[0][i] = d * Math.cos(2 * Math.PI * cu[i]);
        parts[1][i] = -d * Math.sin(2 * Math.PI * cu[i]);
        parts[2][i] = d * Math.cos(2 * Math.PI * cv[i]);
        parts[3][i] = -d * Math.sin(2 * Math.PI * cv[i]);
      }
      const waves = parts.map((part) => blurred(part, w, h, r));
      [U, V].forEach((axis, which) => {
        const re = waves[which * 2];
        const im = waves[which * 2 + 1];
        let sr = 0;
        let si = 0;
        for (let k = 0; k < around.length; k++) {
          if (whole[around[k]] < 0.98) continue;
          sr += re[around[k]];
          si += im[around[k]];
        }
        const mean = Math.atan2(si, sr);
        // The plane c0 + c1 x + c2 y nearest to how far off the dots are, each lot counted
        // for how clear its wave is
        const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
        const t = [0, 0, 0];
        let read = 0;
        let left1 = w;
        let right1 = 0;
        let top1 = h;
        let bottom1 = 0;
        for (let y = 0; y < h; y += every) {
          for (let x = 0; x < w; x += every) {
            const i = y * w + x;
            if (!member[i] || whole[i] < 0.98) continue;
            const weight = re[i] * re[i] + im[i] * im[i];
            if (!weight) continue;
            read++;
            if (x < left1) left1 = x;
            if (x > right1) right1 = x;
            if (y < top1) top1 = y;
            if (y > bottom1) bottom1 = y;
            let off = (Math.atan2(im[i], re[i]) - mean) / (2 * Math.PI);
            off -= Math.round(off);
            const row = [1, x - w / 2, y - h / 2];
            for (let p = 0; p < 3; p++) {
              t[p] += weight * row[p] * off;
              for (let q = 0; q < 3; q++) m[p * 3 + q] += weight * row[p] * row[q];
            }
          }
        }
        // Too little to go by (a narrow strip of screentone): the grid stays as found
        if (read < 60 || right1 - left1 < 8 * pitch || bottom1 - top1 < 8 * pitch) return;
        const d = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
        if (!(Math.abs(d) > 1e-9)) return;
        const c0 = (t[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (t[1] * m[8] - m[5] * t[2]) + m[2] * (t[1] * m[7] - m[4] * t[2])) / d;
        const c1 = (m[0] * (t[1] * m[8] - m[5] * t[2]) - t[0] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * t[2] - t[1] * m[6])) / d;
        const c2 = (m[0] * (m[4] * t[2] - t[1] * m[7]) - m[1] * (m[3] * t[2] - t[1] * m[6]) + t[0] * (m[3] * m[7] - m[4] * m[6])) / d;
        // Never by more than the measure could be wrong
        if (Math.abs(c1) * (right1 - left1) > 0.4 || Math.abs(c2) * (bottom1 - top1) > 0.4) return;
        axis[0] += c1;
        axis[1] += c2;
        axis[2] += c0 - c1 * (w / 2) - c2 * (h / 2);
      });
      place();
    };
    // The dot: the mean colour of the pixels, by tone and by place in the cell. As fine as
    // the pixels there are to learn it from allow, from half a pixel to a sixth.
    let ku = 0;
    let kv = 0;
    let cell = 0;
    let dot = null;
    let held = null;
    const model = new Float32Array(n * 3);
    const contrast = new Float32Array(TONE_NODES);
    const learn = () => {
      const met = new Float32Array(TONE_NODES);
      let pixels = 0;
      for (let k = 0; k < around.length; k++) {
        const i = around[k];
        if (!member[i]) continue;
        met[Math.round(level[i] / TONE_STEP)]++;
        pixels++;
      }
      let nodes = 0;
      for (let node = 0; node < TONE_NODES; node++) if (met[node] > pixels / 200) nodes++;
      const fine = Math.max(2, Math.min(6, Math.sqrt(pixels / (3 * Math.max(1, nodes) * area))));
      ku = Math.max(4, Math.min(96, Math.round(la * fine)));
      kv = Math.max(4, Math.min(96, Math.round(lb * fine)));
      cell = ku * kv;
      dot = new Float32Array(TONE_NODES * cell * 3);
      held = new Float32Array(TONE_NODES * cell);
      for (let k = 0; k < around.length; k++) {
        const i = around[k];
        if (!member[i]) continue;
        const p = (((i - (i % w)) / w + y0) * width + (i % w) + x0) * 4;
        const at = Math.max(0, Math.min(TONE_NODES - 1.001, level[i] / TONE_STEP));
        const node = Math.floor(at);
        const part = at - node;
        const where = Math.min(ku - 1, Math.floor(cu[i] * ku)) * kv + Math.min(kv - 1, Math.floor(cv[i] * kv));
        for (let side = 0; side < 2; side++) {
          const weight = side ? part : 1 - part;
          if (weight <= 0) continue;
          const q = (node + side) * cell + where;
          held[q] += weight;
          dot[q * 3] += weight * data[p];
          dot[q * 3 + 1] += weight * data[p + 1];
          dot[q * 3 + 2] += weight * data[p + 2];
        }
      }
      // A place of the cell no pixel fell on takes after its neighbours; a tone met too little
      // to tell its dot, after the nearest tones that did
      const full = new Uint8Array(TONE_NODES);
      const sums = new Float32Array(cell * 4);
      for (let node = 0; node < TONE_NODES; node++) {
        const base = node * cell;
        let total = 0;
        for (let q = 0; q < cell; q++) total += held[base + q];
        if (total < Math.max(24, cell * 0.5)) continue;
        full[node] = 1;
        for (let round = 0; round < 96; round++) {
          let empty = 0;
          sums.fill(0);
          for (let q = 0; q < cell; q++) {
            if (held[base + q] >= 0.5) continue;
            empty++;
            const iu = (q - (q % kv)) / kv;
            const iv = q % kv;
            for (let du = -1; du <= 1; du++) {
              for (let dv = -1; dv <= 1; dv++) {
                const o = base + ((iu + du + ku) % ku) * kv + ((iv + dv + kv) % kv);
                if (held[o] < 0.5) continue;
                sums[q * 4] += dot[o * 3];
                sums[q * 4 + 1] += dot[o * 3 + 1];
                sums[q * 4 + 2] += dot[o * 3 + 2];
                sums[q * 4 + 3] += held[o];
              }
            }
          }
          if (!empty) break;
          for (let q = 0; q < cell; q++) {
            if (!sums[q * 4 + 3]) continue;
            const o = base + q;
            // As one pixel's worth, however many its neighbours hold
            held[o] = 1;
            dot[o * 3] = sums[q * 4] / sums[q * 4 + 3];
            dot[o * 3 + 1] = sums[q * 4 + 1] / sums[q * 4 + 3];
            dot[o * 3 + 2] = sums[q * 4 + 2] / sums[q * 4 + 3];
          }
        }
        for (let q = 0; q < cell; q++) {
          const o = base + q;
          const over = held[o] || 1;
          dot[o * 3] /= over;
          dot[o * 3 + 1] /= over;
          dot[o * 3 + 2] /= over;
        }
      }
      if (!full.some(Boolean)) return false;
      for (let node = 0; node < TONE_NODES; node++) {
        if (full[node]) continue;
        let below = node - 1;
        while (below >= 0 && !full[below]) below--;
        let above = node + 1;
        while (above < TONE_NODES && !full[above]) above++;
        const part = below < 0 ? 1 : above >= TONE_NODES ? 0 : (node - below) / (above - below);
        const from = Math.max(0, below) * cell * 3;
        const to = Math.min(TONE_NODES - 1, above) * cell * 3;
        for (let q = 0; q < cell * 3; q++) dot[node * cell * 3 + q] = (below < 0 ? 0 : dot[from + q] * (1 - part)) + (above >= TONE_NODES ? 0 : dot[to + q] * part);
      }
      // How much the dot stands out at each tone: what tells dots from a plain grey, or
      // from the slope between two plain tones, which the same table would also learn
      for (let node = 0; node < TONE_NODES; node++) {
        let sum = 0;
        let squares = 0;
        for (let q = 0; q < cell; q++) {
          const o = (node * cell + q) * 3;
          const value = dot[o] * 0.299 + dot[o + 1] * 0.587 + dot[o + 2] * 0.114;
          sum += value;
          squares += value * value;
        }
        contrast[node] = Math.max(0, squares / cell - (sum / cell) ** 2);
      }
      return true;
    };
    // The colour of the pixel `i` in a screentone of tone `tone`, into model
    const draw = (i, tone) => {
      const at = Math.max(0, Math.min(TONE_NODES - 1.001, tone / TONE_STEP));
      const node = Math.floor(at);
      const part = at - node;
      const fu = cu[i] * ku - 0.5;
      const fv = cv[i] * kv - 0.5;
      const iu = Math.floor(fu);
      const iv = Math.floor(fv);
      const tu = fu - iu;
      const tv = fv - iv;
      const u0 = ((iu % ku) + ku) % ku;
      const u1 = (u0 + 1) % ku;
      const v0 = ((iv % kv) + kv) % kv;
      const v1 = (v0 + 1) % kv;
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let side = 0; side < 2; side++) {
          const base = (node + side) * cell;
          const value = (dot[(base + u0 * kv + v0) * 3 + c] * (1 - tv) + dot[(base + u0 * kv + v1) * 3 + c] * tv) * (1 - tu) + (dot[(base + u1 * kv + v0) * 3 + c] * (1 - tv) + dot[(base + u1 * kv + v1) * 3 + c] * tv) * tu;
          sum += value * (side ? part : 1 - part);
        }
        model[i * 3 + c] = sum;
      }
    };
    const grayOf = (i) => model[i * 3] * 0.299 + model[i * 3 + 1] * 0.587 + model[i * 3 + 2] * 0.114;
    // What is screentone among the pixels around: where the dot stands out, and tells the page.
    // Twice: the dot is first learnt from everything around, lines and letters included, then
    // from what proved to be screentone alone.
    const off = new Float32Array(n);
    const stand = new Float32Array(n);
    const miss = new Float32Array(n);
    const have = new Uint8Array(n);
    place();
    const wider = new Float32Array(n);
    const bump = new Uint8Array(n);
    // How much the page itself varies over the dot's cell around each pixel. Paper beside a
    // screentone is what the screentone is between two dots, pixel by pixel: but nothing
    // stands out on it, where the dots of that tone would.
    const spread = new Float32Array(n);
    {
      const mean = new Float32Array(n);
      const squares = new Float32Array(n);
      for (let k = 0; k < around.length; k++) squares[around[k]] = gray[around[k]] * gray[around[k]];
      const half = Math.max(1, Math.round(pitch / 2));
      meanAround(gray, use, w, h, half, 0.3, mean, null, 1);
      meanAround(squares, use, w, h, half, 0.3, spread, null, 1);
      for (let k = 0; k < around.length; k++) spread[around[k]] = Math.max(0, spread[around[k]] - mean[around[k]] ** 2);
    }
    const standAt = (tone) => {
      const at = Math.max(0, Math.min(TONE_NODES - 1.001, tone / TONE_STEP));
      const node = Math.floor(at);
      return contrast[node] * (1 - at + node) + contrast[node + 1] * (at - node);
    };
    for (let pass = 0; pass < 2; pass++) {
      if (!levels(pass > 0)) return null;
      // A screentone's tone changes gently. Darker or lighter than a little further around:
      // a line over it, which pulls the tone its way and would pass for a denser screentone.
      meanAround(gray, member, w, h, Math.round(2 * pitch), 0.3, wider, bump);
      for (let k = 0; k < around.length; k++) {
        const i = around[k];
        bump[i] = bump[i] && Math.abs(level[i] - wider[i]) > TONE_BUMP ? 1 : 0;
      }
      // Once what is screentone is known: anything else would pull the grid its own way
      if (pass) {
        lock();
        lock();
      }
      if (!learn()) return null;
      for (let k = 0; k < around.length; k++) {
        const i = around[k];
        draw(i, level[i]);
        const drawn = grayOf(i);
        off[i] = (gray[i] - drawn) ** 2;
        // How much the dot of that tone stands out, over its cell
        stand[i] = standAt(level[i]);
      }
      // Looked at closely the second time: the screentone's edge is where its last dots are
      const close = pass ? Math.max(1, Math.round(0.3 * pitch)) : r;
      meanAround(off, use, w, h, close, 0.3, miss, have);
      let within = 0;
      let total = 0;
      let count = 0;
      member.fill(0);
      for (let k = 0; k < around.length; k++) {
        const i = around[k];
        if (!have[i] || bump[i] || stand[i] < TONE_CONTRAST * TONE_CONTRAST || miss[i] > TONE_FIT * stand[i] + TONE_NOISE * TONE_NOISE || spread[i] < TONE_SEEN * stand[i]) continue;
        member[i] = 1;
        count++;
        within += off[i];
        total += stand[i];
      }
      if (count < 200 || within > (pass ? 0.2 : 0.4) * total) return null;
    }
    if (!levels(true, true)) return null;
    // Ink and paper: the darkest and lightest the screentone gets
    const tones = [];
    const pick = Math.max(1, Math.round(around.length / 4000));
    for (let k = 0; k < around.length; k += pick) if (member[around[k]]) tones.push(gray[around[k]]);
    tones.sort((p, q) => p - q);
    const ink = tones[Math.floor(tones.length * 0.02)] || 0;
    const paper = tones[Math.floor(tones.length * 0.98)] || 255;
    const dark = (ink + paper) / 2;
    // What isn't screentone, pixel by pixel: far from what the screentone would be there, by a
    // good part of its range (paper where a dot is due, ink between two dots). The dark ones
    // may be lines over the screentone: those that cross the hole carry on across it.
    const odd = new Uint8Array(n);
    const extra = new Uint8Array(n);
    for (let k = 0; k < around.length; k++) {
      const i = around[k];
      if (member[i]) continue;
      draw(i, level[i]);
      const gap = grayOf(i) - gray[i];
      if (Math.abs(gap) <= 0.35 * (paper - ink)) continue;
      odd[i] = 1;
      if (gap > 0 && gray[i] < dark) extra[i] = 1;
    }
    // And what is plain where the screentone would show its dots: paper, a flat black
    const bare = new Uint8Array(n);
    for (let k = 0; k < around.length; k++) {
      const i = around[k];
      if (member[i]) continue;
      const due = standAt(level[i]);
      if (due >= TONE_CONTRAST * TONE_CONTRAST && spread[i] < TONE_BARE * due) bare[i] = 1;
    }
    const band = Math.max(3, Math.min(8, Math.round(0.75 * pitch)));
    const lines = toneLines({ w, h, gray, hole, use, far, extra, dark, pitch, at: (i) => (((i - (i % w)) / w + y0) * width + (i % w) + x0) * 4 }, data);
    const wall = lines ? lines.wall : null;
    // A line that carries on across the hole has been dealt with: neither it nor its soft
    // edge says anything
    const lined = wall ? dilate(wall, w, h, 2) : null;
    // Two screentones side by side at the hole, and no line between them that crosses it:
    // their edge may run anywhere in the hole, and a tone carried from both would fade from
    // one to the other. The patches do better there.
    {
      const span = Math.max(2, Math.round(2 * pitch));
      let steps = 0;
      for (let k = 0; k < around.length; k++) {
        const i = around[k];
        if (!levelled[i] || far[i] > band + 3 * r) continue;
        const x = i % w;
        for (const move of [x + span < w ? span : 0, i + span * w < n ? span * w : 0]) {
          if (!move || !levelled[i + move] || Math.abs(level[i + move] - level[i]) <= TONE_EDGE) continue;
          let cut = false;
          for (let j = i; j <= i + move && lined; j += move / span) if (lined[j]) cut = true;
          if (!cut) steps++;
        }
      }
      if (steps >= 12) return null;
    }
    // Where the hole is in the screentone, from what its edges are: screentone, or not. The
    // last pixels before the hole have no say unless they are screentone: an outline left
    // around letters, the soft edge of a stroke, shouldn't stop the screentone from going
    // under them. Unless they belong to something that comes from further off: a thick
    // stroke, a black shape going under the letters. Nor have those that only stand too
    // close to something else to be told. What is plain (`bare`) says no as what is odd does.
    const fixed = new Uint8Array(n);
    const inTone = new Float32Array(n);
    let edges = 0;
    for (let i = 0; i < n; i++) {
      if (member[i]) {
        inTone[i] = 1;
        fixed[i] = 1;
        if (far[i] <= band + 3 * r) edges++;
      } else fixed[i] = (odd[i] || bare[i]) && far[i] > band && !(lined && lined[i]) ? 1 : 0;
    }
    const long = Math.max(10, Math.round(1.5 * pitch));
    const tried = new Uint8Array(n);
    for (let s = 0; s < n; s++) {
      if (!(odd[s] || bare[s]) || tried[s] || far[s] > band) continue;
      const piece = [s];
      tried[s] = 1;
      let reach = 0;
      let joined = false;
      for (let k = 0; k < piece.length; k++) {
        const i = piece[k];
        const px = i % w;
        if (far[i] > reach) reach = far[i];
        if (lined && lined[i]) joined = true;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const qx = px + dx;
            const j = i + dy * w + dx;
            if (qx < 0 || qx >= w || j < 0 || j >= n || tried[j] || !(odd[j] || bare[j])) continue;
            tried[j] = 1;
            piece.push(j);
          }
        }
      }
      // A line that carries on across the hole has been dealt with
      if (reach >= long && !joined) for (let k = 0; k < piece.length; k++) fixed[piece[k]] = 1;
    }
    // A screentone has to come up to the hole somewhere
    if (edges < 12) return null;
    carried(inTone, fixed, w, h, wall, TONE_SETTLED / 255);
    // Between screentone and something else, the edge may run anywhere: only what is well
    // inside the screentone is drawn, and the patches find the edge
    let against = 0;
    for (let i = 0; i < n; i++) if (fixed[i] && !member[i] && far[i] <= band + 3 * r) against++;
    const mixed = against > TONE_MIXED * edges;
    if (mixed) {
      // Nor are the last pixels before the hole taken for an outline left around letters any
      // more: a narrow margin of paper has its say
      for (let i = 0; i < n; i++) {
        if (!member[i]) inTone[i] = 0;
        if (use[i] && !member[i] && far[i] > 2 && !(lined && lined[i])) fixed[i] = 1;
      }
      carried(inTone, fixed, w, h, wall, TONE_SETTLED / 255);
    }
    for (let i = 0; i < n; i++) if (hole[i]) inTone[i] = inTone[i] > (mixed ? TONE_SURE : 0.5) ? 1 : 0;
    let inside = 0;
    let holes = 0;
    for (let i = 0; i < n; i++) {
      if (!hole[i]) continue;
      holes++;
      if (inTone[i]) inside++;
    }
    // A corner of the hole in the screentone isn't worth a seam with the rest
    if (!inside || (mixed && inside < TONE_SHARE * holes)) return null;
    // The tone in the hole: that of the screentone around, carried in, each side of a line
    // that crosses the hole taking after its own side
    if (wall) carried(level, levelled, w, h, wall, TONE_SETTLED);
    // Under a line, what is on its darker side: it only shows through the line's soft edge
    if (wall) {
      for (let i = 0; i < n; i++) {
        if (!wall[i] || !hole[i]) continue;
        const x = i % w;
        let best = -1;
        [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w].forEach((j) => {
          if (j < 0 || j >= n || wall[j]) return;
          if (best < 0 || level[j] < level[best]) best = j;
        });
        if (best < 0) continue;
        level[i] = level[best];
        inTone[i] = inTone[best];
      }
    }
    const rgb = new Uint8ClampedArray(n * 3);
    inside = 0;
    for (let i = 0; i < n; i++) {
      if (!hole[i]) continue;
      draw(i, level[i]);
      rgb[i * 3] = model[i * 3];
      rgb[i * 3 + 1] = model[i * 3 + 1];
      rgb[i * 3 + 2] = model[i * 3 + 2];
      if (inTone[i] > 0.5) inside++;
    }
    if (!inside) return null;
    const turn = U[0] * V[1] - U[1] * V[0];
    return { x: x0, y: y0, w, h, rgb, tone: inTone, hole, lines: lines ? lines.over : null, grid: { a: [V[1] / turn, -V[0] / turn], b: [-U[1] / turn, U[0] / turn] }, whole: inside === holes };
  };

  // The lines drawn over a screentone that go into the hole, carried on across it: each one
  // that comes up to the hole is joined to the one that leaves it in its line, or nearly (a
  // curve bends on the way), in its own thickness and ink. One that meets no other stops at
  // the hole. Returns null without such a line, else `over`, what to paint over the hole (RGBA
  // over the box), and `wall`, 1 on the pixels of those lines, around the hole and across it.
  const toneLines = ({ w, h, gray, hole, use, far, extra, dark, pitch, at }, data) => {
    const n = w * h;
    const long = Math.max(10, Math.round(1.5 * pitch));
    const seen = new Uint8Array(n);
    const ends = [];
    // A line runs over dots, which cut it into pieces: what is dark on the page within a
    // dot of those pieces holds them together
    const beside = dilate(extra, w, h, Math.max(2, Math.min(6, Math.ceil(0.45 * pitch))));
    // The pixels of `own` within `radius` of (tx, ty), as a line: its middle (mx, my), which
    // way it goes towards (tx, ty), how far along (`last` from the middle, `span` in all),
    // how thick, and whether it is one (`line`)
    const stretchOf = (own, tx, ty, radius) => {
      const stretch = [];
      let mx = 0;
      let my = 0;
      for (let k = 0; k < own.length; k++) {
        const x = own[k] % w;
        const y = (own[k] - x) / w;
        if ((x - tx) ** 2 + (y - ty) ** 2 > radius * radius) continue;
        stretch.push(own[k]);
        mx += x;
        my += y;
      }
      if (stretch.length < 8) return null;
      mx /= stretch.length;
      my /= stretch.length;
      let xx = 0;
      let xy = 0;
      let yy = 0;
      for (let k = 0; k < stretch.length; k++) {
        const x = (stretch[k] % w) - mx;
        const y = Math.floor(stretch[k] / w) - my;
        xx += x * x;
        xy += x * y;
        yy += y * y;
      }
      const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
      let dx = Math.cos(angle);
      let dy = Math.sin(angle);
      if ((tx - mx) * dx + (ty - my) * dy < 0) {
        dx = -dx;
        dy = -dy;
      }
      const along = xx * dx * dx + 2 * xy * dx * dy + yy * dy * dy;
      const across = xx + yy - along;
      const place = (i) => ((i % w) - mx) * dx + (Math.floor(i / w) - my) * dy;
      let first = Infinity;
      let last = -Infinity;
      for (let k = 0; k < stretch.length; k++) {
        const where = place(stretch[k]);
        if (where < first) first = where;
        if (where > last) last = where;
      }
      // How many pixels across, at each pixel along. Where it runs over a dot, the dot hides
      // some, and never adds any: its thickness is that of its thicker places, the thickest
      // for a thick one, which the dots eat into all along.
      const slices = new Float32Array(Math.floor(last - first) + 1);
      for (let k = 0; k < stretch.length; k++) slices[Math.floor(place(stretch[k]) - first)]++;
      const thick = Array.from(slices).filter(Boolean).sort((p, q) => p - q);
      const thin = thick[Math.floor(thick.length * 0.8)] || 1;
      const width = thin < 6 ? thin : thick[Math.floor(thick.length * 0.9)];
      const span = last - first;
      // A line: long for its thickness, straight on that stretch
      return { stretch, mx, my, dx, dy, last, width, span, line: span >= 8 && span >= 2.5 * width && across <= 0.12 * along };
    };
    for (let s = 0; s < n; s++) {
      if (!extra[s] || seen[s]) continue;
      const piece = [s];
      const own = [];
      seen[s] = 1;
      for (let k = 0; k < piece.length && piece.length < 60000; k++) {
        const i = piece[k];
        const px = i % w;
        if (extra[i]) own.push(i);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const qx = px + dx;
            const j = i + dy * w + dx;
            if (qx < 0 || qx >= w || j < 0 || j >= n || seen[j] || hole[j] || !use[j]) continue;
            if (!extra[j] && !(gray[j] < dark && beside[j])) continue;
            seen[j] = 1;
            piece.push(j);
          }
        }
      }
      let reach = 0;
      const tips = [];
      for (let k = 0; k < own.length; k++) {
        if (far[own[k]] > reach) reach = far[own[k]];
        if (far[own[k]] <= 3) tips.push(own[k]);
      }
      if (!tips.length || tips.length > 4000) continue;
      // Each place where it comes up to the hole
      const group = new Int32Array(tips.length).fill(-1);
      let groups = 0;
      for (let t = 0; t < tips.length; t++) {
        if (group[t] >= 0) continue;
        const queue = [t];
        group[t] = groups;
        for (let k = 0; k < queue.length; k++) {
          const ax = tips[queue[k]] % w;
          const ay = (tips[queue[k]] - ax) / w;
          for (let o = 0; o < tips.length; o++) {
            if (group[o] >= 0) continue;
            const ox = tips[o] % w;
            if (Math.abs(ox - ax) > 3 || Math.abs((tips[o] - ox) / w - ay) > 3) continue;
            group[o] = groups;
            queue.push(o);
          }
        }
        groups++;
      }
      // From further off than what is left of a letter around a hole a little short of it,
      // or going from one part of the hole to another: a line seen between two letters
      if (reach < long && groups < 2) continue;
      for (let g = 0; g < groups; g++) {
        let tx = 0;
        let ty = 0;
        let count = 0;
        for (let t = 0; t < tips.length; t++) {
          if (group[t] !== g) continue;
          tx += tips[t] % w;
          ty += Math.floor(tips[t] / w);
          count++;
        }
        tx /= count;
        ty /= count;
        // Its last stretch before the hole: which way it goes, how thick, how dark. A
        // longer stretch for a thick one, to tell which way it goes; not past where a
        // curve stops looking straight.
        let best = null;
        let had = 0;
        for (let radius = 22; radius <= 88; radius *= 2) {
          const found = stretchOf(own, tx, ty, radius);
          if (!found || found.stretch.length === had) break;
          had = found.stretch.length;
          if (found.line) best = found;
          else if (best) break;
          if (best && radius >= 4 * best.width) break;
        }
        if (!best || best.width > 40) continue;
        const { stretch, mx, my, dx, dy, last, width, span } = best;
        const tones = stretch.map((i) => gray[i]).sort((p, q) => p - q);
        const core = tones[tones.length >> 1];
        const rgb = [0, 0, 0];
        let cored = 0;
        for (let k = 0; k < stretch.length; k++) {
          if (gray[stretch[k]] > core) continue;
          const p = at(stretch[k]);
          rgb[0] += data[p];
          rgb[1] += data[p + 1];
          rgb[2] += data[p + 2];
          cored++;
        }
        // A long stretch tells where the line goes (`sure`); a sliver seen between two letters,
        // hardly. Where it meets the hole: the middle of its last pixels for a thick one, surer
        // than its direction; for a thin one, cut by the dots it runs over, the end of its line
        const thin = width < 6;
        ends.push({ x: thin ? mx + dx * last : tx, y: thin ? my + dy * last : ty, dx, dy, width, rgb: rgb.map((value) => value / cored), stretch, sure: span >= Math.max(16, 3 * width) });
      }
    }
    if (ends.length < 2) return null;
    // Two ends are one line if each heads for the other, and what joins them stays in the hole
    const curve = (a, b, t) => {
      const reach = Math.hypot(b.x - a.x, b.y - a.y);
      // Nearly in line: straight, not the wave that two measures a hair apart would draw
      if (a.straight && a.straight === b.straight) return [a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t];
      const h00 = 2 * t * t * t - 3 * t * t + 1;
      const h10 = t * t * t - 2 * t * t + t;
      const h01 = -2 * t * t * t + 3 * t * t;
      const h11 = t * t * t - t * t;
      return [h00 * a.x + h10 * a.dx * reach + h01 * b.x - h11 * b.dx * reach, h00 * a.y + h10 * a.dy * reach + h01 * b.y - h11 * b.dy * reach];
    };
    // A line may go over the slivers of itself seen on the way
    const slivers = new Uint8Array(n);
    ends.forEach((end) => {
      if (!end.sure) end.stretch.forEach((p) => (slivers[p] = 1));
    });
    const under = dilate(slivers, w, h, 3);
    const pairs = [];
    for (let i = 0; i < ends.length; i++) {
      for (let j = i + 1; j < ends.length; j++) {
        const a = ends[i];
        const b = ends[j];
        const reach = Math.hypot(b.x - a.x, b.y - a.y);
        if (reach < 3 || Math.max(a.width, b.width) > 2.2 * Math.min(a.width, b.width)) continue;
        const bendA = Math.acos(Math.max(-1, Math.min(1, (a.dx * (b.x - a.x) + a.dy * (b.y - a.y)) / reach)));
        const bendB = Math.acos(Math.max(-1, Math.min(1, (b.dx * (a.x - b.x) + b.dy * (a.y - b.y)) / reach)));
        if (bendA > 0.45 || bendB > 0.45 || bendA + bendB > 0.7) continue;
        let within = 0;
        const steps = Math.max(4, Math.ceil(reach));
        for (let k = 0; k <= steps; k++) {
          const [x, y] = curve(a, b, k / steps);
          const qx = Math.round(x);
          const qy = Math.round(y);
          if (qx >= 0 && qy >= 0 && qx < w && qy < h && (far[qy * w + qx] <= 4 || (a.sure && b.sure && under[qy * w + qx]))) within++;
        }
        if (within < 0.9 * (steps + 1)) continue;
        // Two sure ends first, then the rest
        pairs.push({ i, j, cost: bendA + bendB + reach / 2000 + (a.sure && b.sure ? 0 : 10), straight: bendA < 0.12 && bendB < 0.12 });
      }
    }
    pairs.sort((p, q) => p.cost - q.cost);
    const taken = new Uint8Array(ends.length);
    const over = new Uint8ClampedArray(n * 4);
    const wall = new Uint8Array(n);
    // Within a few pixels of a line already drawn
    const near = new Uint8Array(n);
    let drawn = false;
    // A stroke along point(t), t from 0 to 1, from the thickness and ink of `a` to those of `b`
    const stroke = (point, length, a, b) => {
      drawn = true;
      const steps = Math.ceil(length * 2) + 1;
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const [x, y] = point(t);
        const half = (a.width * (1 - t) + b.width * t) / 2;
        const span = Math.ceil(half + 1);
        for (let qy = Math.round(y) - span; qy <= Math.round(y) + span; qy++) {
          for (let qx = Math.round(x) - span; qx <= Math.round(x) + span; qx++) {
            if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
            const alpha = Math.max(0, Math.min(1, half + 0.5 - Math.hypot(qx - x, qy - y))) * 255;
            if (alpha >= 128) wall[qy * w + qx] = 1;
            near[qy * w + qx] = 1;
            if (!hole[qy * w + qx]) continue;
            const o = (qy * w + qx) * 4;
            if (alpha <= over[o + 3]) continue;
            over[o] = a.rgb[0] * (1 - t) + b.rgb[0] * t;
            over[o + 1] = a.rgb[1] * (1 - t) + b.rgb[1] * t;
            over[o + 2] = a.rgb[2] * (1 - t) + b.rgb[2] * t;
            over[o + 3] = alpha;
          }
        }
      }
    };
    pairs.forEach(({ i, j, straight }) => {
      if (taken[i] || taken[j]) return;
      // A sliver the line already drawn goes over is that line
      for (const k of [i, j]) {
        const qx = Math.round(ends[k].x);
        const qy = Math.round(ends[k].y);
        if (!ends[k].sure && qx >= 0 && qy >= 0 && qx < w && qy < h && near[qy * w + qx]) taken[k] = 1;
      }
      if (taken[i] || taken[j]) return;
      taken[i] = 1;
      taken[j] = 1;
      const a = ends[i];
      const b = ends[j];
      a.stretch.forEach((p) => (wall[p] = 1));
      b.stretch.forEach((p) => (wall[p] = 1));
      a.straight = b.straight = straight ? `${i},${j}` : "";
      stroke((t) => curve(a, b, t), Math.hypot(b.x - a.x, b.y - a.y), a, b);
    });
    // What is left goes straight on, as far as it leads somewhere in the hole: two lines
    // that meet there at an angle (a corner, a fork) are drawn up to where they meet
    const inside = (x, y) => {
      const qx = Math.round(x);
      const qy = Math.round(y);
      return qx >= 0 && qy >= 0 && qx < w && qy < h && far[qy * w + qx] <= 4;
    };
    const stays = (end, length) => {
      for (let gone = 0; gone <= length; gone += 2) if (!inside(end.x + end.dx * gone, end.y + end.dy * gone)) return false;
      return true;
    };
    const meets = [];
    for (let i = 0; i < ends.length; i++) {
      for (let j = i + 1; j < ends.length; j++) {
        const a = ends[i];
        const b = ends[j];
        if (taken[i] || taken[j] || !a.sure || !b.sure) continue;
        const cross = a.dx * b.dy - a.dy * b.dx;
        if (Math.abs(cross) < 0.3) continue;
        const sa = ((b.x - a.x) * b.dy - (b.y - a.y) * b.dx) / cross;
        const sb = ((b.x - a.x) * a.dy - (b.y - a.y) * a.dx) / cross;
        if (sa < 2 || sb < 2 || sa > 300 || sb > 300 || !stays(a, sa) || !stays(b, sb)) continue;
        meets.push({ i, j, sa, sb, cost: sa + sb });
      }
    }
    meets.sort((p, q) => p.cost - q.cost);
    const along = (end, length) => {
      end.stretch.forEach((p) => (wall[p] = 1));
      stroke((t) => [end.x + end.dx * length * t, end.y + end.dy * length * t], length, end, end);
    };
    meets.forEach(({ i, j, sa, sb }) => {
      if (taken[i] || taken[j]) return;
      taken[i] = 1;
      taken[j] = 1;
      along(ends[i], sa);
      along(ends[j], sb);
    });
    // And a line that runs into one already drawn (a branch) is drawn up to it
    ends.forEach((end, k) => {
      if (taken[k] || !end.sure) return;
      for (let gone = end.width + 2; gone < 300; gone += 0.5) {
        const x = end.x + end.dx * gone;
        const y = end.y + end.dy * gone;
        if (!inside(x, y)) return;
        if (!wall[Math.round(y) * w + Math.round(x)]) continue;
        taken[k] = 1;
        along(end, gone);
        return;
      }
    });
    return drawn ? { over, wall } : null;
  };

  // The screentone `tone` goes over the fill `out` wherever the hole is in it, and the lines
  // that cross the hole over both
  const toneOver = (tone, out, width) => {
    const { x, y, w, h, rgb, hole, lines } = tone;
    for (let i = 0, n = w * h; i < n; i++) {
      if (!hole[i]) continue;
      const p = (((i - (i % w)) / w + y) * width + (i % w) + x) * 4;
      if (tone.tone[i] > 0.5) {
        out[p] = rgb[i * 3];
        out[p + 1] = rgb[i * 3 + 1];
        out[p + 2] = rgb[i * 3 + 2];
        out[p + 3] = 255;
      }
      const alpha = lines ? lines[i * 4 + 3] / 255 : 0;
      if (!alpha) continue;
      for (let c = 0; c < 3; c++) out[p + c] = out[p + c] * (1 - alpha) + lines[i * 4 + c] * alpha;
    }
  };

  /* --------------------------------- whole --------------------------------- */

  // data: RGBA of a region of the page, mask: 1 where to fill, source: 1 where the fill may
  // read from. Returns RGBA of the region, the hole filled and opaque. progress gets 0 to 1.
  const inpaint = ({ data, width, height, mask, source }, options = {}, progress) => {
    const out = new Uint8ClampedArray(data.length);
    out.set(data);
    // The same fill for the same hole, whatever was filled before
    seed = 0x9e3779b9;
    const mirror = Boolean(options.mirror);
    // In a screentone and nothing else, the dots are drawn again and that is all.
    // options.tone: false, to fill with patches whatever the hole is in.
    const tone = options.tone === false ? null : screentone(data, width, height, mask);
    if (tone && tone.whole) {
      toneOver(tone, out, width);
      return out;
    }
    // In part: the screentone is drawn first, and the rest of the hole is filled with that
    // in sight, as if the page had always had it
    if (tone) {
      data = Uint8ClampedArray.from(data);
      mask = Uint8Array.from(mask);
      source = Uint8Array.from(source);
      toneOver(tone, data, width);
      for (let i = 0, n = tone.w * tone.h; i < n; i++) {
        if (!tone.hole[i] || tone.tone[i] <= 0.5) continue;
        const p = (((i - (i % tone.w)) / tone.w + tone.y) * width + (i % tone.w) + tone.x);
        mask[p] = 0;
        source[p] = 0;
      }
      out.set(data);
    }
    const levels = [finestLevel(data, width, height, mask, source)];
    while (levels.length < 8) {
      const last = levels[levels.length - 1];
      const box = holeBox(last);
      if (!box || Math.max(box.width, box.height) <= COARSEST || Math.min(box.width, box.height) <= 3 || Math.min(last.w, last.h) <= PATCH * 2) break;
      levels.push(coarser(last));
    }
    if (!holeBox(levels[0])) return out;
    // Else over the fill, where the hole is in the screentone
    const toned = (filled) => {
      if (tone) toneOver(tone, filled, width);
      return filled;
    };
    // A patch of known pixels is a must: a level without any takes smaller ones
    levels.forEach((L) => {
      for (let half = HALF; half >= 1; half--) {
        prepare(L, half);
        if (L.okList.length) break;
      }
    });
    if (!levels.some((L) => L.okList.length)) {
      seedHole(levels[0]);
      return toned(finish(levels[0], out));
    }
    const rounds = levels.map((L, k) => (k === levels.length - 1 ? 10 : k === 0 ? 3 : 4));
    const total = levels.reduce((sum, L, k) => sum + L.band.length * rounds[k], 0) || 1;
    let done = 0;
    let votes = null;
    for (let k = levels.length - 1; k >= 0; k--) {
      const L = levels[k];
      if (k === levels.length - 1) seedHole(L);
      else {
        refine(levels[k + 1], L);
        structureFirst(L);
      }
      if (!L.okList.length) {
        done += L.band.length * rounds[k];
        continue;
      }
      gradients(L);
      ensureMatches(L, mirror);
      const radius = k === levels.length - 1 ? Math.max(L.w, L.h) : 24;
      for (let round = 0; round < rounds[k]; round++) {
        // The first vote of a level waits for the matches to settle: the level's start
        // (the seed, or the coarser level's result) is worth more than a hasty vote
        const passes = round ? 2 : k === levels.length - 1 ? 6 : 4;
        for (let pass = 0; pass < passes; pass++) patchMatch(L, pass, radius, mirror);
        const last = round === rounds[k] - 1;
        votes = vote(L, last && k === 0 ? 0.25 : 0.5);
        gradients(L);
        done += L.band.length;
        if (progress) progress(Math.min(0.99, done / total));
      }
    }
    if (options.adapt !== false && votes && levels[0].okList.length) adaptColours(levels, votes);
    return toned(finish(levels[0], out));
  };

  const finish = (L, out) => {
    for (let i = 0, n = L.w * L.h; i < n; i++) {
      if (!L.hole[i]) continue;
      out[i * 4] = L.rgb[i * 3];
      out[i * 4 + 1] = L.rgb[i * 3 + 1];
      out[i * 4 + 2] = L.rgb[i * 3 + 2];
      out[i * 4 + 3] = 255;
    }
    return out;
  };

  root.TypeRInpaint = { inpaint, screentone };

  // As a worker: one job at a time, with its progress
  if (typeof WorkerGlobalScope !== "undefined" && root instanceof WorkerGlobalScope) {
    root.onmessage = ({ data }) => {
      const { id, payload, options } = data;
      let lastTold = 0;
      try {
        const result = inpaint(payload, options, (fraction) => {
          const now = Date.now();
          if (now - lastTold < 80) return;
          lastTold = now;
          root.postMessage({ id, progress: fraction });
        });
        root.postMessage({ id, result }, [result.buffer]);
      } catch (error) {
        root.postMessage({ id, error: String((error && error.message) || error) });
      }
    };
    root.postMessage({ ready: true });
  }
})(typeof self !== "undefined" ? self : window);
