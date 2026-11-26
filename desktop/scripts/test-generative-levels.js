const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Exercise the actual editor operation, without duplicating its implementation.
const source = fs.readFileSync(path.join(__dirname, "../../web/photoshop.js"), "utf8");
const matchLevels = vm.runInNewContext(source.slice(source.indexOf("  const matchLevels ="), source.indexOf("  const matchTones =")) + "; matchLevels;");
const pixels = fn => {
  const data = new Uint8ClampedArray(4096);
  for (let p = 0; p < 1024; p++) data.set([...fn(p), 255], p * 4);
  return data;
};
const hole = pixels(p => [0, 0, 0]);
for (let p = 0; p < 1024; p++) hole[p * 4 + 3] = p < 64 ? 255 : 0;

test("unchanged monochrome artwork is not turned gray after generation", () => {
  for (const pattern of [() => [255, 255, 255], () => [128, 128, 128], p => p % 4 ? [255, 255, 255] : [0, 0, 0], p => [p % 256, p % 256, p % 256]]) {
    const page = pixels(pattern);
    const result = page.slice();
    matchLevels(result, page, hole);
    assert.deepEqual(result, page);
  }
});

test("matching flat surroundings preserves details reconstructed inside the selection", () => {
  const page = pixels(() => [255, 255, 255]);
  const result = page.slice();
  for (let p = 0; p < 64; p++) result.set([p * 4, p * 4, p * 4, 255], p * 4);
  const expected = result.slice();
  matchLevels(result, page, hole);
  assert.deepEqual(result, expected);
});

test("real exposure shifts are corrected without flattening the selected drawing", () => {
  const page = pixels(p => p % 2 ? [200, 180, 160] : [20, 40, 60]);
  const result = pixels(p => p % 2 ? [220, 190, 165] : [40, 50, 65]);
  result.set([130, 120, 115, 127], 0);
  matchLevels(result, page, hole);
  assert.deepEqual(Array.from(result.subarray(0, 4)), [110, 110, 110, 127]);
  assert.deepEqual(result.subarray(256), page.subarray(256));
});

test("insufficient surrounding pixels leave the model result unchanged", () => {
  const page = pixels(() => [255, 255, 255]);
  const result = pixels(() => [200, 200, 200]);
  const allSelected = pixels(() => [0, 0, 0]);
  const expected = result.slice();
  matchLevels(result, page, allSelected);
  assert.deepEqual(result, expected);
});

const restoreDetail = vm.runInNewContext(source.slice(source.indexOf("  const restoreDetail ="), source.indexOf("  /* -------------------------- Content-Aware Fill")) + "; restoreDetail;");
// A 64 × 64 area, the hole a 32 × 32 square in its middle; a dot every other pixel
const W = 64;
const area = (fn) => {
  const data = new Uint8ClampedArray(W * W * 4);
  for (let p = 0; p < W * W; p++) data.set([...fn(p % W, Math.floor(p / W)), 255], p * 4);
  return data;
};
const square = area((x, y) => [0, 0, 0]);
for (let p = 0; p < W * W; p++) square[p * 4 + 3] = p % W >= 16 && p % W < 48 && p >= 16 * W && p < 48 * W ? 255 : 0;
const inHole = (p) => square[p * 4 + 3] > 0;
const spreadIn = (data) => {
  let lo = 255, hi = 0;
  for (let p = 0; p < W * W; p++) if (inHole(p) && p % W > 20 && p % W < 44 && p > 20 * W && p < 44 * W) { lo = Math.min(lo, data[p * 4]); hi = Math.max(hi, data[p * 4]); }
  return hi - lo;
};

test("a screentone's dots softened by the model get their contrast back", () => {
  const dot = (x, y) => (x + y) % 2 === 0;
  const page = area((x, y) => (dot(x, y) ? [0, 0, 0] : [255, 255, 255]));
  const picture = area((x, y) => (dot(x, y) ? [110, 110, 110] : [190, 190, 190]));
  restoreDetail(picture, page, square, W, W);
  assert.ok(spreadIn(picture) >= 150, `spread ${spreadIn(picture)}`);
  // Outside the hole, nothing moves
  assert.deepEqual([picture[0], picture[1], picture[2]], [110, 110, 110]);
});

test("a flat inside, like a balloon's, and an inside already as sharp as the page stay as they are", () => {
  const dot = (x, y) => (x + y) % 2 === 0;
  const page = area((x, y) => (dot(x, y) ? [0, 0, 0] : [255, 255, 255]));
  const flat = area((x, y) => (inHole(y * W + x) ? [250, 250, 250] : dot(x, y) ? [0, 0, 0] : [255, 255, 255]));
  const before = flat.slice();
  restoreDetail(flat, page, square, W, W);
  assert.deepEqual(flat, before);
  const sharp = page.slice();
  restoreDetail(sharp, page, square, W, W);
  assert.deepEqual(sharp, page);
});
