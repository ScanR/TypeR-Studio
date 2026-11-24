// Flow's pictures of the pages that aren't open (flow.js): a page's size read from the first
// bytes of its file, and a small picture of it, made here so that the app never waits and
// never holds a page's worth of pixels for a page that is only looked at.
//
// A PSD gives its own picture, the one Photoshop keeps at the end of the file: only that part
// is read, and it is made smaller while it is read. A file without one (saved without Maximize
// Compatibility), or in a mode this doesn't read, answers `whole`: the app then reads the file
// as it would to open it.
//
// For the pages shown two by two, how far the drawing stands from each side of a page.

"use strict";

const PSD = 0x38425053;
const view = async (file, from, to) => new DataView(await file.slice(from, to).arrayBuffer());

// Where a PSD's parts are, read a few bytes at a time
const psdParts = async (file) => {
  const head = await view(file, 0, 30);
  if (head.byteLength < 30 || head.getUint32(0) !== PSD) return null;
  const big = head.getUint16(4) === 2;
  const parts = { big, channels: head.getUint16(12), height: head.getUint32(14), width: head.getUint32(18), depth: head.getUint16(22), mode: head.getUint16(24) };
  parts.resources = 26 + 4 + head.getUint32(26);
  parts.resourcesSize = (await view(file, parts.resources, parts.resources + 4)).getUint32(0);
  const layers = parts.resources + 4 + parts.resourcesSize;
  const size = await view(file, layers, layers + (big ? 8 : 4));
  parts.image = layers + (big ? 8 : 4) + (big ? size.getUint32(0) * 4294967296 + size.getUint32(4) : size.getUint32(0));
  return parts;
};

// Photoshop says in the file whether its picture is the page (resource 1057, its fifth byte)
const psdHasPicture = async (file, parts) => {
  const data = new Uint8Array(await file.slice(parts.resources + 4, parts.resources + 4 + parts.resourcesSize).arrayBuffer());
  const bytes = new DataView(data.buffer);
  let at = 0;
  while (at + 12 <= data.length) {
    const id = bytes.getUint16(at + 4);
    const name = data[at + 6] + 1;
    at += 6 + name + (name % 2);
    const size = bytes.getUint32(at);
    if (id === 1057) return size < 5 || data[at + 4 + 4] !== 0;
    at += 4 + size + (size % 2);
  }
  return true;
};

// The size of a picture, from the start of its file: [width, height], or null
const sizeOf = async (file) => {
  const name = file.name || "";
  if (/\.ps[db]$/i.test(name)) {
    const head = await view(file, 0, 26);
    return head.byteLength >= 26 && head.getUint32(0) === PSD ? [head.getUint32(18), head.getUint32(14)] : null;
  }
  const head = await view(file, 0, 32);
  if (head.byteLength < 32) return null;
  if (head.getUint32(0) === 0x89504e47) return [head.getUint32(16), head.getUint32(20)];
  // WebP: its three kinds each say it their own way
  if (head.getUint32(0) === 0x52494646 && head.getUint32(8) === 0x57454250) {
    const kind = head.getUint32(12);
    if (kind === 0x56503858) return [1 + head.getUint16(24, true) + (head.getUint8(26) << 16), 1 + head.getUint16(27, true) + (head.getUint8(29) << 16)];
    if (kind === 0x5650384c) {
      const bits = head.getUint32(21, true);
      return [1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff)];
    }
    if (kind === 0x56503820) return [head.getUint16(26, true) & 0x3fff, head.getUint16(28, true) & 0x3fff];
    return null;
  }
  // JPEG: the frame's size comes after whatever the camera or the scanner wrote first
  if (head.getUint16(0) !== 0xffd8) return null;
  const data = await view(file, 0, Math.min(file.size, 1 << 20));
  let at = 2;
  while (at + 9 < data.byteLength) {
    if (data.getUint8(at) !== 0xff) return null;
    const marker = data.getUint8(at + 1);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return [data.getUint16(at + 7), data.getUint16(at + 5)];
    at += 2 + data.getUint16(at + 2);
  }
  return null;
};

// A PSD's own picture, each `step` pixels of it made one as it is read: the whole page never
// exists here in full
const psdPicture = async (file, parts, longest) => {
  const { big, channels, width, height, depth, mode } = parts;
  // Greyscale, RGB or CMYK, 8 or 16 bits: every page of a manga. The rest is read whole.
  const used = mode === 1 ? 1 : mode === 3 ? 3 : mode === 4 ? 4 : 0;
  if (!used || channels < used || (depth !== 8 && depth !== 16) || !width || !height) return null;
  const data = new Uint8Array(await file.slice(parts.image).arrayBuffer());
  if (data.length < 2) return null;
  const packed = (data[0] << 8) | data[1];
  if (packed !== 0 && packed !== 1) return null;
  const sample = depth / 8;
  const rowBytes = width * sample;
  const step = Math.max(1, Math.floor(Math.max(width, height) / longest));
  const outW = Math.max(1, Math.floor(width / step));
  const outH = Math.max(1, Math.floor(height / step));
  // Where each channel's rows start
  const counts = new DataView(data.buffer, data.byteOffset + 2);
  const countSize = big ? 4 : 2;
  const countOf = (row) => (big ? counts.getUint32(row * 4) : counts.getUint16(row * 2));
  let at = 2 + (packed ? channels * height * countSize : 0);
  const row = new Uint8Array(rowBytes);
  const size = data.length;
  const sums = [];
  // A black and white page kept in colours has the same bytes three times: read once
  const starts = [];
  const twin = (channel, from, to) => {
    const first = starts[0];
    if (!channel || to - from !== first[1] - first[0] || to > size) return false;
    if (packed) {
      const rows = height * countSize;
      const mine = 2 + channel * rows;
      for (let i = 0; i < rows; i++) if (data[2 + i] !== data[mine + i]) return false;
    }
    for (let a = first[0], b = from; b < to; a++, b++) if (data[a] !== data[b]) return false;
    return true;
  };
  for (let channel = 0; channel < used; channel++) {
    let to = at;
    if (!packed) to += rowBytes * height;
    else for (let y = 0; y < height; y++) to += countOf(channel * height + y);
    starts.push([at, to]);
    if (twin(channel, at, to)) {
      sums.push(sums[0]);
      at = to;
      continue;
    }
    const sum = new Uint32Array(outW * outH);
    let next = at;
    for (let y = 0; y < height; y++) {
      const from = next;
      next += packed ? countOf(channel * height + y) : rowBytes;
      if (y >= outH * step) continue;
      const base = Math.floor(y / step) * outW;
      if (packed && sample === 1) {
        // PackBits: a count, then that many bytes as they are, or one byte that many times.
        // A page's screentones are millions of short runs: each goes straight into the sums
        // it falls in, without the row being written out first.
        const end = base + outW;
        let read = from;
        let filled = 0;
        let cell = base;
        let room = step;
        // `length` bytes of one value; past the row's last sum, they aren't counted
        const same = (value, length) => {
          while (length > 0 && cell < end) {
            const take = length < room ? length : room;
            sum[cell] += value * take;
            length -= take;
            room -= take;
            if (!room) {
              cell++;
              room = step;
            }
          }
        };
        while (read < next && filled < rowBytes) {
          const count = data[read++];
          if (count < 128) {
            const length = Math.min(count + 1, rowBytes - filled);
            const stop = Math.min(read + length, size);
            let at = read;
            while (at < stop && cell < end) {
              const upTo = stop - at < room ? stop : at + room;
              room -= upTo - at;
              let total = 0;
              for (; at < upTo; at++) total += data[at];
              sum[cell] += total;
              if (!room) {
                cell++;
                room = step;
              }
            }
            // A file cut short: what is missing counts for nothing
            if (read + length > size) same(0, read + length - Math.max(read, size));
            read += count + 1;
            filled += length;
          } else if (count > 128) {
            const length = Math.min(257 - count, rowBytes - filled);
            same(data[read++], length);
            filled += length;
          }
        }
        if (filled < rowBytes) same(255, rowBytes - filled);
        continue;
      }
      // Not packed, or 16 bits (its first byte of two is the one read)
      let line = row;
      if (!packed) line = data.subarray(from, from + rowBytes);
      else {
        let read = from;
        let filled = 0;
        while (read < next && filled < rowBytes) {
          const count = data[read++];
          if (count < 128) {
            const length = Math.min(count + 1, rowBytes - filled);
            row.set(data.subarray(read, read + length), filled);
            read += count + 1;
            filled += length;
          } else if (count > 128) {
            const length = Math.min(257 - count, rowBytes - filled);
            row.fill(data[read++], filled, filled + length);
            filled += length;
          }
        }
        if (filled < rowBytes) row.fill(255, filled);
      }
      for (let x = 0, p = 0; x < outW; x++) {
        let total = 0;
        for (let k = 0; k < step; k++, p += sample) total += line[p];
        sum[base + x] += total;
      }
    }
    sums.push(sum);
    at = next;
  }
  const area = step * step;
  const pixels = new Uint8ClampedArray(outW * outH * 4);
  for (let i = 0, p = 0; i < outW * outH; i++, p += 4) {
    if (used === 1) pixels[p] = pixels[p + 1] = pixels[p + 2] = sums[0][i] / area;
    else if (used === 3) {
      pixels[p] = sums[0][i] / area;
      pixels[p + 1] = sums[1][i] / area;
      pixels[p + 2] = sums[2][i] / area;
    } else {
      // CMYK is kept upside down: 255 is no ink
      const black = sums[3][i] / area / 255;
      pixels[p] = (sums[0][i] / area) * black;
      pixels[p + 1] = (sums[1][i] / area) * black;
      pixels[p + 2] = (sums[2][i] / area) * black;
    }
    pixels[p + 3] = 255;
  }
  const image = new ImageData(pixels, outW, outH);
  // Through a canvas, the picture is held by the graphics card, as a PNG's or a JPEG's is:
  // made from the pixels alone it stays in memory, and several large ones drawn at every
  // frame of a zoom are sent to the card again and again, which holds the zoom up
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(outW, outH);
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.putImageData(image, 0, 0);
      return canvas.transferToImageBitmap();
    }
  }
  return createImageBitmap(image);
};

// A PNG, a JPEG or a WebP, made smaller
const imagePicture = async (file, longest) => {
  const full = await createImageBitmap(file);
  const { width, height } = full;
  const scale = Math.min(1, longest / Math.max(width, height));
  if (scale === 1) return { width, height, bitmap: full };
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));
  let bitmap;
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(outW, outH);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(full, 0, 0, outW, outH);
    bitmap = canvas.transferToImageBitmap();
  } else bitmap = await createImageBitmap(full, { resizeWidth: outW, resizeHeight: outH, resizeQuality: "high" });
  full.close();
  return { width, height, bitmap };
};

const picture = async (file, longest) => {
  if (!/\.ps[db]$/i.test(file.name || "")) return imagePicture(file, longest);
  const parts = await psdParts(file);
  if (!parts) throw new Error("Not a PSD");
  const { width, height } = parts;
  if (!(await psdHasPicture(file, parts))) return { width, height, whole: true };
  const bitmap = await psdPicture(file, parts, longest);
  return bitmap ? { width, height, bitmap } : { width, height, whole: true };
};

// How far the drawing stands from each side of a page, left and right, in parts of its width:
// a printed manga's page has a white margin on the side of the binding, where the drawing of
// the outer side runs to the edge, so the pages that face each other can be told (flow.js).
// Null when the page's picture can't be read here.
const INK = 160;
const marginsOf = async (file) => {
  const made = await picture(file, 512);
  const { bitmap } = made;
  if (!bitmap || typeof OffscreenCanvas !== "function") {
    if (bitmap) bitmap.close();
    return null;
  }
  const w = bitmap.width;
  const h = bitmap.height;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    return null;
  }
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const { data } = ctx.getImageData(0, 0, w, h);
  // The top and the bottom left out: a page number or a line of the magazine there says nothing
  const top = Math.floor(h * 0.04);
  const bottom = Math.ceil(h * 0.96);
  const ink = new Uint32Array(w);
  for (let y = top; y < bottom; y++) {
    for (let x = 0, p = y * w * 4; x < w; x++, p += 4) {
      if (data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114 < INK) ink[x]++;
    }
  }
  // A column is drawn on when ink covers a little of it, more than a speck or a page number
  const drawn = (bottom - top) * 0.02;
  let left = 0;
  while (left < w && ink[left] <= drawn) left++;
  let right = 0;
  while (right < w && ink[w - 1 - right] <= drawn) right++;
  return left >= w ? null : [left / w, right / w];
};

self.onmessage = async ({ data }) => {
  const { id, ask, file, longest } = data;
  try {
    if (ask === "size") self.postMessage({ id, size: await sizeOf(file) });
    else if (ask === "margins") self.postMessage({ id, margins: await marginsOf(file) });
    else {
      const made = await picture(file, longest);
      self.postMessage(Object.assign({ id }, made), made.bitmap ? [made.bitmap] : []);
    }
  } catch (error) {
    self.postMessage({ id, error: String((error && error.message) || error) });
  }
};
self.postMessage({ ready: true });
