const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// The fill itself, as the page runs it when it has no worker: web/inpaint.js on `self`.
global.self = global;
require(path.join(__dirname, "../../web/inpaint.js"));
const { inpaint, screentone } = global.TypeRInpaint;

const W = 220;
const H = 180;
let seed = 1;
const random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

// A page of screentone drawn here, so that what is under the hole is known: round dots on a
// grid of `pitch` pixels turned by `angle` degrees, `density(x, y)` of ink (0 to 1), softened
// as a scan is, with some grain.
const tonePage = ({ pitch, angle = 0, density, noise = 0 }) => {
  const c = Math.cos((angle * Math.PI) / 180);
  const s = Math.sin((angle * Math.PI) / 180);
  const spot = (u, v) => (Math.cos(2 * Math.PI * u) + Math.cos(2 * Math.PI * v)) / 2;
  const values = [];
  for (let i = 0; i < 100; i++) for (let j = 0; j < 100; j++) values.push(spot((i + 0.5) / 100, (j + 0.5) / 100));
  values.sort((p, q) => q - p);
  const ink = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let on = 0;
      for (let k = 0; k < 16; k++) {
        const px = x + ((k % 4) + 0.5) / 4 - 0.5;
        const py = y + (Math.floor(k / 4) + 0.5) / 4 - 0.5;
        const u = (px * c + py * s) / pitch;
        const v = (-px * s + py * c) / pitch;
        const d = Math.max(0, Math.min(1, density((Math.round(u) * c - Math.round(v) * s) * pitch, (Math.round(u) * s + Math.round(v) * c) * pitch)));
        if (d > 0 && spot(u, v) > values[Math.min(values.length - 1, Math.floor(d * values.length))]) on++;
      }
      ink[y * W + x] = on / 16;
    }
  }
  // Softened: each pixel with half of its four neighbours
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const at = (dx, dy) => ink[Math.max(0, Math.min(H - 1, y + dy)) * W + Math.max(0, Math.min(W - 1, x + dx))];
      const soft = (at(0, 0) * 2 + at(-1, 0) + at(1, 0) + at(0, -1) + at(0, 1)) / 6;
      const value = 245 - soft * 225 + (random() - 0.5) * noise * 3.4;
      data.set([value, value, value, 255], (y * W + x) * 4);
    }
  }
  return data;
};
// A dark line over the page
const line = (data, x1, y1, x2, y2, thick) => {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x2 - x1;
      const dy = y2 - y1;
      const k = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
      const cover = Math.max(0, Math.min(1, thick / 2 + 0.5 - Math.hypot(x - x1 - k * dx, y - y1 - k * dy)));
      if (!cover) continue;
      const p = (y * W + x) * 4;
      const value = data[p] * (1 - cover) + 15 * cover;
      data.set([value, value, value], p);
    }
  }
};
// Where letters were: three thick strokes across the middle
const letters = () => {
  const mask = new Uint8Array(W * H);
  const strokes = [[-1, -0.6, 1, 0.5, 0.22], [-0.8, 0.6, 0.9, -0.5, 0.18], [0, -0.9, 0.1, 0.9, 0.2]];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = (x - W / 2) / 40;
      const py = (y - H / 2) / 40;
      mask[y * W + x] = strokes.some(([x1, y1, x2, y2, t]) => {
        const dx = x2 - x1;
        const dy = y2 - y1;
        const k = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
        return Math.hypot(px - x1 - k * dx, py - y1 - k * dy) < t;
      }) ? 1 : 0;
    }
  }
  return mask;
};
// The page with its letters painted black, filled; and how far the fill is from the page as it
// was under them (0 the same, in tones of 255)
const fill = (page, mask, options = {}) => {
  const data = Uint8ClampedArray.from(page);
  for (let i = 0; i < W * H; i++) if (mask[i]) data.set([0, 0, 0], i * 4);
  const out = inpaint({ data, width: W, height: H, mask: Uint8Array.from(mask), source: new Uint8Array(W * H).fill(1) }, Object.assign({ adapt: true }, options));
  let sum = 0;
  let count = 0;
  for (let i = 0; i < W * H; i++) {
    if (!mask[i]) {
      assert.deepEqual(Array.from(out.subarray(i * 4, i * 4 + 4)), Array.from(data.subarray(i * 4, i * 4 + 4)), "nothing changes outside the hole");
      continue;
    }
    sum += (out[i * 4] - page[i * 4]) ** 2;
    count++;
  }
  return { out, data, off: Math.sqrt(sum / count) };
};
const stepOf = (step) => Math.hypot(step[0], step[1]);
// A box of the page as a hole
const box = (x1, y1, x2, y2) => {
  const mask = new Uint8Array(W * H);
  for (let y = Math.max(0, y1); y < Math.min(H, y2); y++) mask.fill(1, y * W + Math.max(0, x1), y * W + Math.min(W, x2));
  return mask;
};
// The pixels of the page that `inside` picks, painted plain
const paint = (page, inside, value) => {
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (inside(x, y)) page.set([value, value, value], (y * W + x) * 4);
  return page;
};
// What the screentone finds around the hole, once the hole is painted black as the fill gets it
const foundIn = (page, mask) => {
  const data = Uint8ClampedArray.from(page);
  for (let i = 0; i < W * H; i++) if (mask[i]) data.set([0, 0, 0], i * 4);
  return screentone(data, W, H, mask);
};
// Filled as the patches alone fill it: the screentone kept out of it
const asBefore = (page, mask, name) => {
  assert.equal(foundIn(page, mask), null, `${name}: no screentone drawn`);
  assert.ok(Buffer.from(fill(page, mask).out).equals(Buffer.from(fill(page, mask, { tone: false }).out)), `${name}: the same fill as without screentones`);
};

test("a screentone's grid is measured to a hundredth of a pixel, whatever its step and angle", () => {
  for (const [pitch, angle] of [[6.49, 0], [9.43, 45], [8, 15], [3.3, 0], [14, 45], [12, 71]]) {
    seed = 7;
    const page = tonePage({ pitch, angle, density: () => 0.25 });
    const found = screentone(page, W, H, letters());
    assert.ok(found, `screentone found at ${pitch} px, ${angle}°`);
    assert.ok(Math.abs(stepOf(found.grid.a) - pitch) < 0.02 && Math.abs(stepOf(found.grid.b) - pitch) < 0.02, `step ${stepOf(found.grid.a)} / ${stepOf(found.grid.b)} for ${pitch}`);
    assert.ok(found.whole, "the whole hole is in the screentone");
  }
});

test("the dots are drawn again where they were, flat screentone or gradient, sparse or dense", () => {
  const cases = [
    [{ pitch: 6.49, angle: 0, density: () => 0.2 }, 4],
    [{ pitch: 9.43, angle: 45, density: (x) => 0.1 + (0.5 * x) / W, noise: 4 }, 9],
    [{ pitch: 10, angle: 45, density: () => 0.6 }, 6],
    [{ pitch: 10, angle: 45, density: () => 0.85 }, 5],
    [{ pitch: 7.2, angle: 30, density: (x, y) => 0.05 + 0.65 * Math.min(1, Math.hypot(x - 80, y - 50) / 160), noise: 3 }, 11],
  ];
  cases.forEach(([options, most]) => {
    seed = 11;
    const page = tonePage(options);
    const { off } = fill(page, letters());
    assert.ok(off < most, `${off.toFixed(1)} off the page, ${most} at most (${JSON.stringify(options)})`);
  });
});

test("an outline left around the letters, or their edge, doesn't stop the screentone", () => {
  seed = 3;
  const page = tonePage({ pitch: 7, angle: 45, density: (x) => 0.15 + (0.25 * x) / W });
  const mask = letters();
  const around = Uint8ClampedArray.from(page);
  for (let y = 2; y < H - 2; y++) {
    for (let x = 2; x < W - 2; x++) {
      let near = false;
      for (let dy = -3; dy <= 3 && !near; dy++) for (let dx = -3; dx <= 3; dx++) if (mask[(y + dy) * W + x + dx]) near = true;
      if (near && !mask[y * W + x]) around.set([250, 250, 250], (y * W + x) * 4);
    }
  }
  const out = inpaint({ data: around, width: W, height: H, mask: Uint8Array.from(mask), source: new Uint8Array(W * H).fill(1) }, { adapt: true });
  let sum = 0;
  let count = 0;
  for (let i = 0; i < W * H; i++) {
    if (!mask[i]) continue;
    sum += (out[i * 4] - page[i * 4]) ** 2;
    count++;
  }
  assert.ok(Math.sqrt(sum / count) < 7, `${Math.sqrt(sum / count).toFixed(1)} off the page under the letters`);
});

test("a line that crosses the hole carries on across it, over the screentone", () => {
  seed = 5;
  const page = tonePage({ pitch: 8, angle: 15, density: () => 0.2 });
  line(page, 15, 25, 205, 150, 3);
  const found = screentone(page, W, H, letters());
  assert.ok(found && found.lines, "the line is seen");
  let drawn = 0;
  for (let i = 0; i < found.w * found.h; i++) if (found.hole[i] && found.lines[i * 4 + 3] >= 128) drawn++;
  assert.ok(drawn > 100, `${drawn} pixels of the line drawn across the hole`);
  const { off } = fill(page, letters());
  const patches = fill(page, letters(), { tone: false });
  assert.ok(off < 16 && off < patches.off, `${off.toFixed(1)} off the page with the line drawn, ${patches.off.toFixed(1)} with patches`);
});

test("the same hole is filled the same way, whatever was filled before", () => {
  seed = 5;
  const page = tonePage({ pitch: 8, density: () => 0, noise: 4 });
  line(page, 15, 25, 205, 150, 3);
  const first = fill(page, letters(), { tone: false }).out;
  fill(tonePage({ pitch: 9, angle: 45, density: () => 0.3 }), box(20, 20, 90, 70), { tone: false });
  assert.ok(Buffer.from(fill(page, letters(), { tone: false }).out).equals(Buffer.from(first)));
});

test("paper beside a screentone stays paper: a band, a bubble, with or without an outline", () => {
  for (const margin of [6, 8, 12, 20]) {
    seed = 31;
    const page = paint(tonePage({ pitch: 8, angle: 45, density: () => 0.25, noise: 3 }), (x, y) => Math.abs(y - 90) < 12 + margin, 250);
    const mask = box(40, 78, 180, 102);
    asBefore(page, mask, `a band of paper, ${margin} px around the hole`);
    assert.ok(fill(page, mask).off < 1, "and it is paper");
  }
  for (const outline of [3, 0]) {
    for (const [pitch, density] of [[7, 0.25], [10, 0.15], [5, 0.4]]) {
      seed = 31;
      const page = tonePage({ pitch, angle: 45, density: () => density, noise: 3 });
      const far = (x, y) => Math.hypot((x - 110) / 85, (y - 90) / 62);
      paint(page, (x, y) => far(x, y) < 1, 250);
      if (outline) paint(page, (x, y) => Math.abs(far(x, y) - 1) * 62 < outline / 2, 15);
      asBefore(page, letters(), `a bubble on a screentone of ${pitch} px, outline ${outline}`);
    }
  }
});

test("a hole across the edge of a screentone is never worse than without screentones", () => {
  const pages = {
    "screentone and paper": [() => tonePage({ pitch: 8, angle: 45, density: (x) => (x < 110 ? 0.3 : 0) }), box(70, 65, 150, 115)],
    "screentone, then paper, under letters": [() => tonePage({ pitch: 8, angle: 45, density: (x) => (x < 125 ? 0.3 : 0) }), letters()],
    "a screentone that fades to paper": [() => tonePage({ pitch: 8, angle: 45, density: (x) => Math.max(0, 0.5 - x / 170) }), box(40, 65, 180, 115)],
    "two screentones": [() => tonePage({ pitch: 8, angle: 45, density: (x) => (x < 110 ? 0.15 : 0.5) }), box(70, 65, 150, 115)],
    "two screentones, nearly alike": [() => tonePage({ pitch: 8, angle: 45, density: (x) => (x < 110 ? 0.15 : 0.25) }), box(70, 65, 150, 115)],
    "screentone and black": [() => paint(tonePage({ pitch: 8, angle: 45, density: () => 0.25 }), (x) => x >= 110, 12), box(70, 65, 150, 115)],
  };
  Object.keys(pages).forEach((name) => {
    seed = 31;
    const page = pages[name][0]();
    const { off } = fill(page, pages[name][1]);
    const patches = fill(page, pages[name][1], { tone: false });
    assert.ok(off <= patches.off + 0.5, `${name}: ${off.toFixed(1)} off the page, ${patches.off.toFixed(1)} with patches`);
  });
});

test("a hole mostly in a screentone: the dots where it is sure, patches for the rest", () => {
  seed = 31;
  const page = tonePage({ pitch: 8, angle: 45, density: (x) => (x < 140 ? 0.3 : 0) });
  const mask = box(70, 65, 150, 115);
  const found = foundIn(page, mask);
  assert.ok(found && !found.whole, "a part of the hole only");
  let inTone = 0;
  let wrong = 0;
  for (let i = 0; i < found.w * found.h; i++) {
    if (!found.hole[i] || found.tone[i] <= 0.5) continue;
    inTone++;
    if ((i % found.w) + found.x >= 140) wrong++;
  }
  assert.ok(inTone > 1500 && wrong === 0, `${inTone} pixels of screentone, ${wrong} of them over the paper`);
  const { off } = fill(page, mask);
  const patches = fill(page, mask, { tone: false });
  assert.ok(off < 5 && off <= patches.off, `${off.toFixed(1)} off the page, ${patches.off.toFixed(1)} with patches`);
});

test("a hole at the side or in a corner of the page", () => {
  const holes = { side: box(0, 60, 50, 110), "top left": box(0, 0, 40, 30), "bottom right": box(W - 45, H - 35, W, H), "all along the top": box(0, 0, W, 14) };
  Object.keys(holes).forEach((name) => {
    seed = 31;
    const page = tonePage({ pitch: 6.5, angle: 20, density: () => 0.3 });
    const found = foundIn(page, holes[name]);
    assert.ok(found && found.whole, `${name}: in the screentone`);
    const { off } = fill(page, holes[name]);
    assert.ok(off < 6, `${name}: ${off.toFixed(1)} off the page`);
  });
});

test("a page that is transparent in places", () => {
  seed = 31;
  const page = tonePage({ pitch: 8, angle: 45, density: () => 0.25 });
  for (let y = 0; y < H; y++) for (let x = 150; x < W; x++) page.set([0, 0, 0, 0], (y * W + x) * 4);
  const mask = box(40, 65, 120, 115);
  const { out, off } = fill(page, mask);
  assert.ok(off < 4, `${off.toFixed(1)} off the page beside what is transparent`);
  for (let i = 0; i < W * H; i++) if (mask[i]) assert.equal(out[i * 4 + 3], 255, "the hole is filled opaque");
  // Nothing to read at all: no screentone, and no error
  const empty = new Uint8ClampedArray(W * H * 4);
  assert.equal(screentone(empty, W, H, mask), null);
  assert.equal(inpaint({ data: empty, width: W, height: H, mask: Uint8Array.from(mask), source: new Uint8Array(W * H).fill(1) }, {}).length, empty.length);
});

test("what isn't a screentone is filled as before", () => {
  const pages = {
    paper: () => tonePage({ pitch: 8, density: () => 0, noise: 4 }),
    hatching: () => {
      const page = tonePage({ pitch: 8, density: () => 0 });
      for (let k = -40; k < 80; k++) line(page, k * 6, 0, k * 6 + 70, H, 1.5);
      return page;
    },
    speckle: () => {
      const page = tonePage({ pitch: 8, density: () => 0 });
      for (let i = 0; i < W * H; i++) if (random() < 0.18) page.set([30, 30, 30], i * 4);
      return page;
    },
    twoLines: () => {
      const page = tonePage({ pitch: 8, density: () => 0 });
      line(page, 150, 0, 160, H, 4);
      line(page, 166, 0, 176, H, 4);
      return page;
    },
  };
  Object.keys(pages).forEach((name) => {
    seed = 21;
    assert.equal(screentone(pages[name](), W, H, letters()), null, name);
  });
});
