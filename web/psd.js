// Opens and saves real PSD files, in the browser, with ag-psd (MIT). A layer the
// user did not touch goes back into the file as it came: same pixels, same mask,
// same effects, same text engine data.

(function () {
  "use strict";

  const Fonts = window.TypeRFonts;
  const PS = () => window.TypeRPhotoshop;

  let loading = null;
  const library = () => {
    if (window.agPsd) return Promise.resolve(window.agPsd);
    if (!loading) {
      loading = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "vendor/ag-psd.js";
        script.onload = () => resolve(window.agPsd);
        script.onerror = () => reject(new Error("The PSD library did not load."));
        document.head.appendChild(script);
      });
    }
    return loading;
  };

  /* ------------------------------ the worker ------------------------------ */

  // psd-worker.js does the long work, so the page stays alive. Without it (a browser that
  // refuses it, a file it can't send back), the same work happens here, as it always did.
  let starting = null;
  let worker = null;
  let lastJob = 0;
  const jobs = new Map();
  const startWorker = () => {
    if (starting) return starting;
    starting = new Promise((resolve) => {
      let candidate;
      const lost = () => {
        worker = null;
        resolve(null);
        jobs.forEach(({ reject }) => reject(Object.assign(new Error("The PSD worker stopped."), { unsent: true })));
        jobs.clear();
      };
      try {
        candidate = new Worker("psd-worker.js");
      } catch (error) {
        resolve(null);
        return;
      }
      const late = setTimeout(lost, 15000);
      candidate.onerror = () => {
        clearTimeout(late);
        lost();
      };
      candidate.onmessage = ({ data }) => {
        if (data.ready) {
          clearTimeout(late);
          worker = candidate;
          resolve(candidate);
          return;
        }
        const job = jobs.get(data.id);
        if (!job) return;
        jobs.delete(data.id);
        if (data.error) job.reject(Object.assign(new Error(data.error), { unsent: Boolean(data.unsent) }));
        else job.resolve(data.result);
      };
    });
    return starting;
  };
  const askWorker = (type, payload, transfer) => new Promise((resolve, reject) => {
    const id = ++lastJob;
    jobs.set(id, { resolve, reject });
    try {
      worker.postMessage({ id, type, payload }, transfer);
    } catch (error) {
      jobs.delete(id);
      reject(Object.assign(error, { unsent: true }));
    }
  });

  // Where each untouched layer's channels are, in the file it was opened from
  const rawParts = new WeakMap();

  // `read`: a canvas whose pixels are read back (a text's, whose edges are blended as soon as
  // the page shows). The processor keeps those: held by the graphics card, each reading waits
  // for the card, a text at a time, while the page opens.
  const canvasOfPixels = (pixels, read) => {
    // From the worker an image comes as its pixels and its size (psd-worker.js): it is made an
    // image again around them, without a copy
    if (pixels.typerImage) pixels = new ImageData(pixels.data, pixels.width, pixels.height);
    const canvas = PS().newCanvas(pixels.width, pixels.height);
    const ctx = canvas.getContext("2d", read ? { willReadFrequently: true } : undefined);
    if (pixels instanceof ImageData) ctx.putImageData(pixels, 0, 0);
    else {
      // 16 and 32 bits per channel: the page works in 8
      const image = ctx.createImageData(pixels.width, pixels.height);
      const from = pixels.data;
      const to = image.data;
      if (from instanceof Float32Array) {
        for (let i = 0; i < from.length; i += 4) {
          to[i] = Math.round(Math.pow(from[i], 1 / 2.2) * 255);
          to[i + 1] = Math.round(Math.pow(from[i + 1], 1 / 2.2) * 255);
          to[i + 2] = Math.round(Math.pow(from[i + 2], 1 / 2.2) * 255);
          to[i + 3] = Math.round(from[i + 3] * 255);
        }
      } else {
        const shift = from instanceof Uint16Array ? 8 : 0;
        for (let i = 0; i < from.length; i++) to[i] = from[i] >>> shift;
      }
      ctx.putImageData(image, 0, 0);
    }
    return canvas;
  };
  const withCanvases = (node, file) => {
    [node, node.mask, node.realMask].forEach((holder) => {
      if (!holder || !holder.imageData) return;
      holder.canvas = canvasOfPixels(holder.imageData, holder === node && Boolean(node.text));
      delete holder.imageData;
    });
    if (node.typerSlices) {
      if (file) rawParts.set(node, Object.assign(node.typerSlices, { channels: node.typerSlices.channels.map((channel) => ({ id: channel.id, compression: channel.compression, part: channel.start === null ? null : file.slice(channel.start, channel.end) })), fromFile: true }));
      delete node.typerSlices;
    }
    (node.children || []).forEach((child) => withCanvases(child, file));
  };

  const decode = async (buffer, file) => {
    const ready = await startWorker();
    if (ready) {
      try {
        const psd = await askWorker("read", { buffer }, file ? [buffer] : []);
        withCanvases(psd, file);
        return psd;
      } catch (error) {
        // A real problem with the file is said; a worker that couldn't finish is replaced below
        if (!error.unsent) throw error;
        if (file) buffer = await file.arrayBuffer();
      }
    }
    const lib = await library();
    await nextFrame();
    return lib.readPsd(new Uint8Array(buffer), { skipCompositeImageData: true, skipThumbnail: true, logMissingFeatures: false });
  };

  // Lets the "working" notice appear before a long, blocking read or write
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

  /* --------------------------- text, PSD to TypeR --------------------------- */

  const JUSTIFY = (value) => {
    if (value === "right") return "right";
    if (value === "center" || value === "justify-center") return "center";
    return "left";
  };

  const ANTI_ALIAS_IN = { none: "antiAliasNone", sharp: "antiAliasSharp", crisp: "antiAliasCrisp", strong: "antiAliasStrong", smooth: "antiAliasSmooth", platform: "antiAliasPlatformGray", platformLCD: "antiAliasPlatformLCD" };
  const ANTI_ALIAS_OUT = Object.keys(ANTI_ALIAS_IN).reduce((out, key) => Object.assign(out, { [ANTI_ALIAS_IN[key]]: key }), {});

  const channel = (value) => Math.max(0, Math.min(255, Math.round(value === undefined ? 0 : value)));

  // A layer style's colour as RGB, whatever the document's mode. In a grayscale document
  // Photoshop gives an amount of ink (0 is white), in CMYK the four inks, and a colour may also
  // come as hue, saturation and brightness, or Lab.
  const rgbFromPsd = (color) => {
    if (!color) return { r: 0, g: 0, b: 0 };
    if (color.r !== undefined) return { r: channel(color.r), g: channel(color.g), b: channel(color.b) };
    if (color.fr !== undefined) return { r: channel(color.fr * 255), g: channel(color.fg * 255), b: channel(color.fb * 255) };
    if (color.c !== undefined) {
      const white = (ink) => 255 * (1 - (ink || 0) / 255) * (1 - (color.k || 0) / 255);
      return { r: channel(white(color.c)), g: channel(white(color.m)), b: channel(white(color.y)) };
    }
    if (color.k !== undefined) {
      const gray = channel(255 - color.k);
      return { r: gray, g: gray, b: gray };
    }
    if (color.h !== undefined) {
      const h = ((color.h % 1) + 1) % 1 * 6;
      const v = color.b || 0;
      const c = v * (color.s || 0);
      const x = c * (1 - Math.abs((h % 2) - 1));
      const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
      return { r: channel((r + v - c) * 255), g: channel((g + v - c) * 255), b: channel((b + v - c) * 255) };
    }
    if (color.l !== undefined) {
      // Lab (D50) to sRGB
      const L = color.l * 100;
      const A = color.a * (color.a < 0 ? 128 : 127);
      const B = color.b * (color.b < 0 ? 128 : 127);
      const fy = (L + 16) / 116;
      const f = (t) => (t > 6 / 29 ? t * t * t : 3 * (6 / 29) * (6 / 29) * (t - 4 / 29));
      const X = 0.9642 * f(fy + A / 500);
      const Y = f(fy);
      const Z = 0.8249 * f(fy - B / 200);
      const gamma = (u) => 255 * (u <= 0.0031308 ? 12.92 * u : 1.055 * Math.pow(u, 1 / 2.4) - 0.055);
      return { r: channel(gamma(3.1339 * X - 1.6169 * Y - 0.4906 * Z)), g: channel(gamma(-0.9785 * X + 1.9160 * Y + 0.0334 * Z)), b: channel(gamma(0.0720 * X - 0.2290 * Y + 1.4057 * Z)) };
    }
    return { r: 0, g: 0, b: 0 };
  };

  /* What Photoshop keeps of a text only in the document's own text block (`Txt2`), not in the
     layer's: its kerning as the Character panel names it (Metrics, Optical, or a number: a
     layer's own data says Metrics for all three) and its Contextual alternates. Found by saving
     one text in each state from Photoshop 2026: in each run's style sheet, key 11 is the
     kerning (0 a number, 1 Metrics, 2 Optical) and key 20 the alternates. */
  // The block's own writing: dictionaries << /key value >>, lists [ ], names, numbers, and
  // strings ( ) in UTF-16 behind a mark. Read into a tree that goes back into the very same
  // bytes, so that what TypeR leaves alone in a block stays as Photoshop wrote it:
  // { d: [[key, node]…] } a dictionary, { l: [node…] } a list, { s: bytes } a string,
  // { r: "word" } a name, a number, true or false
  const blockTree = (bytes) => {
    let at = 0;
    const blank = (c) => c === 32 || c === 10 || c === 13 || c === 9 || c === 0;
    const skip = () => {
      while (at < bytes.length && blank(bytes[at])) at++;
    };
    const word = () => {
      let out = "";
      while (at < bytes.length && !blank(bytes[at]) && bytes[at] !== 0x5d && bytes[at] !== 0x3e) out += String.fromCharCode(bytes[at++]);
      return out;
    };
    const entries = (closed) => {
      const d = [];
      for (;;) {
        skip();
        if (at >= bytes.length) return { d };
        if (closed && bytes[at] === 0x3e && bytes[at + 1] === 0x3e) {
          at += 2;
          return { d };
        }
        if (bytes[at] !== 0x2f) throw new Error("unreadable text block");
        at++;
        const key = word();
        d.push([key, value()]);
      }
    };
    const value = () => {
      skip();
      const c = bytes[at];
      if (c === 0x3c && bytes[at + 1] === 0x3c) {
        at += 2;
        return entries(true);
      }
      if (c === 0x5b) {
        at++;
        const l = [];
        for (;;) {
          skip();
          if (at >= bytes.length) return { l };
          if (bytes[at] === 0x5d) {
            at++;
            return { l };
          }
          l.push(value());
        }
      }
      if (c === 0x28) {
        const from = ++at;
        while (at < bytes.length && bytes[at] !== 0x29) at += bytes[at] === 0x5c ? 2 : 1;
        const s = bytes.subarray(from, Math.min(at, bytes.length));
        at++;
        return { s };
      }
      const r = word();
      if (!r) throw new Error("unreadable text block");
      return { r };
    };
    return entries(false);
  };
  const blockBytes = (tree) => {
    const parts = [];
    const out = (node, top) => {
      if (node.d) {
        if (!top) parts.push("<<");
        node.d.forEach(([key, value]) => {
          parts.push(" /" + key + " ");
          out(value);
        });
        if (!top) parts.push(" >>");
      } else if (node.l) {
        parts.push("[");
        node.l.forEach((value) => {
          parts.push(" ");
          out(value);
        });
        parts.push(" ]");
      } else if (node.s) parts.push("(", node.s, ")");
      else parts.push(node.r);
    };
    out(tree, true);
    const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    parts.forEach((part) => {
      if (typeof part === "string") for (let i = 0; i < part.length; i++) bytes[at++] = part.charCodeAt(i);
      else {
        bytes.set(part, at);
        at += part.length;
      }
    });
    return bytes;
  };
  // A node down a path of dictionary keys and places in lists
  const dig = (node, ...path) => path.reduce((at, step) => {
    if (!at) return undefined;
    if (at.l) return at.l[step];
    const entry = at.d && at.d.find(([key]) => key === String(step));
    return entry && entry[1];
  }, node);
  const listAt = (node, ...path) => (dig(node, ...path) || {}).l || [];
  // A word's value: true, false, a number, or the word itself
  const wordOf = (node) => {
    if (!node || node.r === undefined) return undefined;
    if (node.r === "true") return true;
    if (node.r === "false") return false;
    const number = Number(node.r);
    return Number.isNaN(number) ? node.r : number;
  };
  const stringOf = (node) => {
    if (!node || !node.s) return "";
    const codes = [];
    for (let i = 0; i < node.s.length; i++) {
      if (node.s[i] === 0x5c) i++;
      codes.push(node.s[i]);
    }
    let out = "";
    if (codes[0] === 0xfe && codes[1] === 0xff) for (let i = 2; i + 1 < codes.length; i += 2) out += String.fromCharCode(codes[i] * 256 + codes[i + 1]);
    else codes.forEach((code) => { out += String.fromCharCode(code); });
    return out;
  };
  const blockOf = (psd) => {
    if (!psd || typeof psd.engineData !== "string" || !psd.engineData) return null;
    const binary = atob(psd.engineData);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return blockTree(bytes);
  };
  // Each text of the document, by the number its layer gives it: its characters and, run by
  // run, what the block alone says of them. Empty when the file has no such block (an old
  // Photoshop's) or when it can't be read.
  // The block says a pair's kerning on its first letter, a layer's data and TypeR on its second
  // (the space before a letter): each letter here takes the kerning of the place before it.
  const textBlockOf = (psd) => {
    try {
      const block = blockOf(psd);
      if (!block) return [];
      // A run's sheet only says what differs from the named style it comes from
      const named = listAt(block, "0", "5", "0").map((entry) => dig(entry, "0", "6"));
      return listAt(block, "1", "1").map((entry) => {
        const model = dig(entry, "0");
        const kerning = [];
        const contextual = [];
        listAt(model, "6", "0").forEach((run) => {
          const head = dig(run, "0", "0");
          const sheet = dig(head, "6");
          const parent = named[wordOf(dig(head, "5"))];
          const said = (key) => wordOf(dig(sheet, key) || dig(parent, key));
          const pair = said("11");
          const alternates = said("20");
          for (let i = 0, length = wordOf(dig(run, "1")) || 0; i < length; i++) {
            kerning.push(pair);
            contextual.push(alternates);
          }
        });
        const runs = [];
        contextual.forEach((alternates, at) => {
          const pair = kerning[Math.max(0, at - 1)];
          const last = runs[runs.length - 1];
          if (last && last.kerning === pair && last.contextual === alternates) last.length++;
          else runs.push({ length: 1, kerning: pair, contextual: alternates });
        });
        return { text: stringOf(dig(model, "0")), runs };
      });
    } catch (error) {
      console.warn("TypeR web: could not read the document's text block", error);
      return [];
    }
  };
  const KERNING_IN = { 0: "manual", 2: "opticalKern" };

  // How a character stands in a vertical line, as the file numbers it and as Photoshop names
  // it: upright (1, "withStream": Standard Vertical Roman Alignment), on its side (2,
  // "rotated") or side by side with its neighbours (3, "cross": Tate-Chu-Yoko). Read back
  // from files Photoshop 2026 saved. A horizontal text's number says nothing: it isn't read.
  const DIRECTION_IN = { 2: "rotated", 3: "cross" };
  const DIRECTION_OUT = { rotated: 2, cross: 3 };
  // `vertical`: the style of a vertical text
  const styleFromPsd = (style, scale, resolution, vertical) => {
    const font = (style.font && style.font.name) || "";
    const known = Fonts.get(font);
    const size = ((style.fontSize || 12) * scale * 72) / resolution;
    const color = style.fillColor || { r: 0, g: 0, b: 0 };
    const out = {
      fontPostScriptName: font,
      fontName: known ? known.family : font,
      fontStyleName: known ? known.style : "Regular",
      size,
      impliedFontSize: size,
      autoLeading: style.autoLeading !== false,
      tracking: style.tracking || 0,
      horizontalScale: style.horizontalScale === undefined ? 100 : style.horizontalScale * 100,
      verticalScale: style.verticalScale === undefined ? 100 : style.verticalScale * 100,
      syntheticBold: Boolean(style.fauxBold),
      syntheticItalic: Boolean(style.fauxItalic),
      fontCaps: style.fontCaps === 2 ? "allCaps" : style.fontCaps === 1 ? "smallCaps" : "normal",
      baselineShift: ((style.baselineShift || 0) * scale * 72) / resolution,
      baseline: style.fontBaseline === 2 ? "subScript" : style.fontBaseline === 1 ? "superScript" : "normal",
      underline: style.underline ? "underlineOnLeftInVertical" : "underlineOff",
      strikethrough: style.strikethrough ? "xHeightStrikethroughOn" : "strikethroughOff",
      ligature: style.ligatures !== false,
      altligature: Boolean(style.dLigatures),
      color: { red: channel(color.r), green: channel(color.g), blue: channel(color.b) },
    };
    const language = PS().textLanguageName(style.language);
    if (language) out.textLanguage = language;
    if (vertical && DIRECTION_IN[style.baselineDirection]) out.baselineDirection = DIRECTION_IN[style.baselineDirection];
    if (style.autoKerning === false) out.autoKern = "manual";
    // Kerning set by hand: the space before this letter, in thousandths of an em
    if (style.kerning) out.kerning = style.kerning;
    if (style.leading && style.autoLeading === false) out.leading = (style.leading * scale * 72) / resolution;
    // Extra Bold: Faux Bold with the letters outlined in the text itself (see styleToPsd)
    if (out.syntheticBold && style.strokeFlag && style.outlineWidth > 0) out.extraBold = true;
    return out;
  };

  // Whether an entry of the block is of these very characters: the block ends each text with
  // a return of its own (a text that ends with an empty line has two)
  const blockHas = (entryText, value) => entryText === value + "\r" || entryText === value;
  // The kerning and the Contextual alternates of each run, from the document's text block: a
  // run is cut where they change inside it. Only when the block has this very text: a layer
  // the block doesn't follow keeps what its own data says. True when the block had the text.
  const blockStyles = (ranges, value, block) => {
    if (!block || !block.runs.length || !blockHas(block.text, value)) return false;
    const cuts = [];
    let at = 0;
    block.runs.forEach((run) => {
      cuts.push({ from: at, to: at + run.length, run });
      at += run.length;
    });
    const out = [];
    ranges.forEach((range) => {
      cuts.forEach(({ from, to, run }) => {
        const start = Math.max(range.from, from);
        const end = Math.min(range.to, to);
        if (end <= start) return;
        const textStyle = Object.assign({}, range.textStyle);
        if (KERNING_IN[run.kerning]) textStyle.autoKern = KERNING_IN[run.kerning];
        else if (run.kerning === 1) delete textStyle.autoKern;
        if (typeof run.contextual === "boolean") textStyle.contextualLigatures = run.contextual;
        const last = out[out.length - 1];
        if (last && last.to === start && JSON.stringify(last.textStyle) === JSON.stringify(textStyle)) last.to = end;
        else out.push({ from: start, to: end, textStyle });
      });
    });
    // Every letter still has its style: otherwise the layer's own data stays as it was
    if (out.length && out[0].from === ranges[0].from && out[out.length - 1].to === ranges[ranges.length - 1].to) ranges.splice(0, ranges.length, ...out);
    return true;
  };
  // The texts the document's block spoke for (by their list of runs): TypeR's own list of
  // what a layer can't say (see lettersForSave) is for the others
  const saidByBlock = new WeakSet();

  const isTurned = (transform) => Boolean(transform) && (Math.abs(transform[1]) > 0.001 || Math.abs(transform[2]) > 0.001);

  // `block`: what the document's text block says of this text (see textBlockOf), when it has it
  const paramsFromPsd = (text, doc, block) => {
    const transform = text.transform || [1, 0, 0, 1, 0, 0];
    // The size Photoshop shows: along the frame's side (yx, yy), which a skew leaves alone
    const scale = Math.hypot(transform[2] || 0, transform[3] === undefined ? 1 : transform[3]) || 1;
    const value = String(text.text || "").replace(/\r\n?|\n/g, "\r");
    const base = text.style || {};
    const runs = text.styleRuns && text.styleRuns.length ? text.styleRuns : [{ length: value.length, style: {} }];
    let at = 0;
    const ranges = [];
    const vertical = text.orientation === "vertical";
    runs.forEach((run) => {
      const from = at;
      at = Math.min(value.length, at + (run.length || 0));
      if (at > from) ranges.push({ from, to: at, textStyle: styleFromPsd(Object.assign({}, base, run.style), scale, doc.resolution, vertical) });
    });
    if (!ranges.length) ranges.push({ from: 0, to: value.length, textStyle: styleFromPsd(base, scale, doc.resolution, vertical) });
    if (blockStyles(ranges, value, block)) saidByBlock.add(ranges);
    const alignment = JUSTIFY(text.paragraphStyle && text.paragraphStyle.justification);
    // Paragraph text: its top left and size, in the document's pixels
    const bounds = text.shapeType === "box" && text.boxBounds && text.boxBounds[2] > text.boxBounds[0] ? text.boxBounds : null;
    // Turned, the box's corner isn't straight across from the transform's origin.
    // A vertical text's anchor is the top right of its box, where its first line is.
    const left = bounds ? bounds[vertical ? 2 : 0] : 0;
    const top = bounds ? bounds[1] : 0;
    const originX = (transform[4] || 0) + (isTurned(transform) ? transform[0] * left + transform[2] * top : left * scale);
    const originY = (transform[5] || 0) + (isTurned(transform) ? transform[1] * left + transform[3] * top : top * scale);
    return {
      layerText: {
        textKey: value,
        antiAlias: ANTI_ALIAS_IN[text.antiAlias] || "antiAliasSmooth",
        textClickPoint: { horizontal: (originX / doc.width) * 100, vertical: (originY / doc.height) * 100 },
        textStyleRange: ranges,
        paragraphStyleRange: [{ from: 0, to: value.length, paragraphStyle: Object.assign({ alignment, autoLeadingPercentage: (text.paragraphStyle && text.paragraphStyle.autoLeading) || 1.2 }, text.paragraphStyle && text.paragraphStyle.hanging ? { hangingRoman: true } : {}, bounds && text.paragraphStyle && text.paragraphStyle.autoHyphenate === true ? Object.assign({ hyphenate: true }, hyphenationFromPsd(text.paragraphStyle, scale)) : {}) }],
        textShape: [bounds
          ? { textType: "box", orientation: vertical ? "vertical" : "horizontal", box: { width: (bounds[2] - bounds[0]) * scale, height: (bounds[3] - bounds[1]) * scale, autoHeight: false } }
          : { textType: "point", orientation: vertical ? "vertical" : "horizontal" }],
      },
    };
  };

  // Photoshop's Warp Text, as the file names it and as TypeR does (see TypeRTextWarp): Bend is
  // its `value`, the horizontal and vertical distortions its two `perspective`s
  const envelopeFromPsd = (warp) => (warp && warp.style && warp.style !== "none"
    ? window.TypeRTextWarp.clean({ style: warp.style, bend: warp.value, horizontal: warp.perspective, vertical: warp.perspectiveOther, rotate: warp.rotate })
    : null);
  const envelopeToPsd = (envelope) => ({ style: envelope.style, value: envelope.bend, perspective: envelope.horizontal, perspectiveOther: envelope.vertical, rotate: envelope.rotate });

  // A stroke's Position: Photoshop's names, TypeR's
  const POSITION_IN = { outside: "outer", inside: "inner", center: "center" };
  const POSITION_OUT = { outer: "outside", inner: "inside", center: "center" };

  // A layer style's stroke, drawn around Photoshop's pixels. Two strokes, as TypeR saves a
  // stroke around the stroke: the stroke itself, and a wider one outside, around it
  // The file's own entries TypeR takes in as its stroke (`stroke`) and the stroke around it
  // (`around`), or null. The others (a third, a hidden one, a gradient's or a pattern's) it
  // doesn't draw, and leaves in the file as they are.
  // A stroke with Fill Type Gradient is taken in (a noise gradient drawn black to white, as
  // Gradient Overlay's); the stroke around it is always one colour.
  const strokeFillable = (stroke) => !stroke.fillType || stroke.fillType === "color" || (stroke.fillType === "gradient" && Boolean(stroke.gradient));
  const strokesTakenIn = (effects) => {
    const usable = ((effects && effects.stroke) || []).slice(0, 2)
      .filter((stroke) => stroke && stroke.enabled !== false && strokeFillable(stroke) && stroke.size && stroke.size.value > 0);
    if (!usable.length) return null;
    // Both outside: the narrower one is the stroke. Otherwise, the one inside or centred.
    const [stroke, around] = usable.length < 2 ? usable : usable.slice().sort((a, b) => (strokePositionOf(a) === "outer") - (strokePositionOf(b) === "outer") || a.size.value - b.size.value);
    const edge = PS().strokeOutside({ size: stroke.size.value, position: strokePositionOf(stroke) });
    return { stroke, around: around && around.fillType !== "gradient" && strokePositionOf(around) === "outer" && around.size.value > edge ? around : null, edge };
  };
  const strokePositionOf = (stroke) => POSITION_IN[stroke.position] || "outer";
  const percentOf = (opacity) => (opacity === undefined ? 100 : round(opacity * 100, 2));
  const strokeFromEffects = (effects) => {
    const taken = strokesTakenIn(effects);
    if (!taken) return null;
    const { stroke, around, edge } = taken;
    const rgb = rgbFromPsd;
    const out = { enabled: true, size: stroke.size.value, opacity: percentOf(stroke.opacity), position: strokePositionOf(stroke), color: rgb(stroke.color) };
    // Fill Type Gradient: its gradient, as Gradient Overlay's (the colour stays for Color)
    if (stroke.fillType === "gradient") {
      const g = stroke.gradient;
      const stops = stopsFromPsd(g);
      if (!stroke.color) out.color = { r: stops[0].r, g: stops[0].g, b: stops[0].b };
      out.fill = "gradient";
      out.gradient = { stops, style: g.style || "linear", angle: round(typeof g.angle === "number" ? g.angle : 90, 2), scale: percentOf(g.scale), reverse: Boolean(g.reverse) };
    }
    if (around) {
      out.outer = { size: around.size.value - edge, color: rgb(around.color) };
      // Its own Opacity, kept only when it isn't 100%
      if (percentOf(around.opacity) < 100) out.outer.opacity = percentOf(around.opacity);
    }
    return out;
  };

  // Photoshop's letters with their stroke around them, at the layer's Fill: the part outside
  // under the letters, the part inside over them. Letters that stand on their stroke are
  // blended into its colour, as Photoshop blends them (see textGamma).
  const strokedDisplay = (bitmap, stroke, amount = 1, layer = null) => {
    const engine = PS();
    const outside = engine.strokeOutside(stroke);
    const pad = Math.ceil(engine.strokeReach(stroke)) + 1;
    const canvas = engine.newCanvas(bitmap.width + pad * 2, bitmap.height + pad * 2);
    const ctx = canvas.getContext("2d");
    // Each at its Opacity, laid whole
    if (stroke.outer && stroke.outer.size > 0) engine.ringOf(bitmap, pad, engine.strokeReach(stroke), stroke.outer.color, canvas, engine.strokeAlpha(stroke.outer));
    if (outside > 0) engine.ringOf(bitmap, pad, outside, engine.strokePaint(stroke), canvas, engine.strokeAlpha(stroke));
    if (amount < 1) {
      ctx.globalCompositeOperation = "destination-out";
      ctx.drawImage(bitmap, pad, pad);
      ctx.globalCompositeOperation = "source-over";
    }
    if (amount > 0) {
      ctx.globalAlpha = amount;
      ctx.drawImage(layer && engine.strokeUnder(layer, stroke) ? engine.blendedText(bitmap, engine.lightnessOf(stroke.color)) : bitmap, pad, pad);
      ctx.globalAlpha = 1;
    }
    if (stroke.size > outside) engine.innerRingOf(bitmap, pad, stroke.size - outside, engine.strokePaint(stroke), canvas, engine.strokeAlpha(stroke));
    return { canvas, pad };
  };

  // TypeR used to save a stroked text's pixels with their stroke drawn in, under the same stroke
  // as a layer style: drawn again around them, it came back twice as thick. Photoshop's own
  // pixels are only the letters, in their colours: many opaque pixels in the stroke's colour
  // and in none of the letters' are a stroke drawn in. A stroke of the letters' own colour
  // can't be told apart.
  const strokeDrawnIn = (bitmap, stroke, params) => {
    if (!bitmap || !bitmap.width || !bitmap.height) return false;
    const near = (a, b) => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) < 90;
    const letters = params.layerText.textStyleRange.map(({ textStyle }) => (textStyle.color ? { r: textStyle.color.red, g: textStyle.color.green, b: textStyle.color.blue } : { r: 0, g: 0, b: 0 }));
    const rings = [stroke.color].concat(stroke.outer ? [stroke.outer.color] : []).filter((color) => !letters.some((letter) => near(letter, color)));
    if (!rings.length) return false;
    let data;
    try {
      data = bitmap.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, bitmap.width, bitmap.height).data;
    } catch (error) {
      return false;
    }
    let opaque = 0;
    let ringed = 0;
    const pixel = { r: 0, g: 0, b: 0 };
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 200) continue;
      opaque++;
      pixel.r = data[i];
      pixel.g = data[i + 1];
      pixel.b = data[i + 2];
      if (rings.some((color) => near(pixel, color)) && !letters.some((letter) => near(pixel, letter))) ringed++;
    }
    return opaque > 0 && ringed > opaque * 0.15;
  };

  /* --------------------------- layer effects, both ways --------------------------- */

  // A text's Drop Shadow, Outer Glow, Inner Shadow, Inner Glow, Colour Overlay and Gradient
  // Overlay, as TypeR draws them (see FX_DEFAULTS in photoshop.js). The rest of a layer style
  // (bevel, satin, pattern, contours, noise) stays in the file as it was, and isn't drawn.
  const FX_IN_FILE = { dropShadow: "dropShadow", outerGlow: "outerGlow", innerShadow: "innerShadow", innerGlow: "innerGlow", colorOverlay: "solidFill", gradientOverlay: "gradientOverlay" };
  const FX_LISTS = new Set(["dropShadow", "innerShadow", "solidFill", "gradientOverlay"]);
  const FX_NAMES = Object.keys(FX_IN_FILE);
  const round = (value, places) => Math.round(value * 10 ** places) / 10 ** places;
  const unitValue = (unit) => (unit && typeof unit.value === "number" ? unit.value : typeof unit === "number" ? unit : 0);
  // A blend mode TypeR can't draw is drawn in Normal (and stays in the file while unchanged)
  const fxBlendIn = (mode) => (mode && mode !== "pass through" && PS().BLENDS[mode] ? mode : "normal");
  const fxFirst = (effects, name) => {
    const value = effects[FX_IN_FILE[name]];
    return FX_LISTS.has(FX_IN_FILE[name]) ? (Array.isArray(value) ? value[0] : undefined) : value;
  };

  // Photoshop keeps a gradient's colours and its opacities apart: here they are one list of
  // stops, a stop wherever either had one. Midpoints are taken as halfway.
  const along = (stops, at, read) => {
    if (at <= stops[0].at) return read(stops[0]);
    for (let i = 1; i < stops.length; i++) {
      if (at > stops[i].at) continue;
      const a = stops[i - 1];
      const b = stops[i];
      const f = b.at > a.at ? (at - a.at) / (b.at - a.at) : 1;
      return read(a) + (read(b) - read(a)) * f;
    }
    return read(stops[stops.length - 1]);
  };
  const stopsFromPsd = (gradient) => {
    if (!gradient || gradient.type !== "solid" || !Array.isArray(gradient.colorStops) || !gradient.colorStops.length) return PS().fxDefault("gradientOverlay").stops;
    const place = (location) => round(Math.max(0, Math.min(1, location || 0)), 3);
    const colors = gradient.colorStops.map((stop) => Object.assign({ at: place(stop.location) }, rgbFromPsd(stop.color))).sort((a, b) => a.at - b.at);
    const opacities = (gradient.opacityStops && gradient.opacityStops.length ? gradient.opacityStops : [{ opacity: 1, location: 0 }]).map((stop) => ({ at: place(stop.location), a: stop.opacity === undefined ? 1 : stop.opacity })).sort((a, b) => a.at - b.at);
    const places = Array.from(new Set(colors.concat(opacities).map((stop) => stop.at))).sort((a, b) => a - b);
    return places.map((at) => ({
      at,
      r: Math.round(along(colors, at, (stop) => stop.r)),
      g: Math.round(along(colors, at, (stop) => stop.g)),
      b: Math.round(along(colors, at, (stop) => stop.b)),
      a: round(along(opacities, at, (stop) => stop.a), 3),
    }));
  };

  // The file's effects as TypeR's layer.effects, or undefined when it has none of them.
  // `globalAngle`: the document's Global Light, for an effect that follows it.
  const effectsFromPsd = (effects, globalAngle) => {
    if (!effects) return undefined;
    const scale = effects.scale > 0 ? effects.scale : 1;
    const off = Boolean(effects.disabled);
    const length = (unit) => round(unitValue(unit) * scale, 2);
    const percent = (value) => round((value === undefined ? 1 : value) * 100, 2);
    const angle = (fx) => round(fx.useGlobalLight && typeof globalAngle === "number" ? globalAngle : typeof fx.angle === "number" ? fx.angle : 120, 2);
    const color = (fx) => rgbFromPsd(fx.color || (fx.gradient && fx.gradient.colorStops && fx.gradient.colorStops[0] && fx.gradient.colorStops[0].color) || { r: 255, g: 255, b: 255 });
    const out = {};
    FX_NAMES.forEach((name) => {
      const fx = fxFirst(effects, name);
      if (!fx || typeof fx !== "object") return;
      const common = { enabled: !off && fx.enabled !== false, blend: fxBlendIn(fx.blendMode) };
      if (name === "dropShadow") out[name] = Object.assign(common, { color: color(fx), opacity: percent(fx.opacity), angle: angle(fx), distance: length(fx.distance), spread: round(unitValue(fx.choke), 2), size: length(fx.size) }, fx.layerConceals === false ? { knockout: false } : null);
      else if (name === "outerGlow") out[name] = Object.assign(common, { color: color(fx), opacity: percent(fx.opacity), spread: round(unitValue(fx.choke), 2), size: length(fx.size) });
      else if (name === "innerShadow") out[name] = Object.assign(common, { color: color(fx), opacity: percent(fx.opacity), angle: angle(fx), distance: length(fx.distance), choke: round(unitValue(fx.choke), 2), size: length(fx.size) });
      else if (name === "innerGlow") out[name] = Object.assign(common, { color: color(fx), opacity: percent(fx.opacity), choke: round(unitValue(fx.choke), 2), size: length(fx.size) });
      else if (name === "colorOverlay") out[name] = Object.assign(common, { color: color(fx), opacity: percent(fx.opacity) });
      else out[name] = Object.assign(common, { opacity: percent(fx.opacity), stops: stopsFromPsd(fx.gradient), style: fx.type || "linear", angle: round(typeof fx.angle === "number" ? fx.angle : 90, 2), scale: percent(fx.scale), reverse: Boolean(fx.reverse) });
    });
    // A Pattern Overlay, drawn from the file's own pattern and kept in it as it was
    const pattern = effects.patternOverlay;
    if (pattern && typeof pattern === "object" && pattern.pattern && pattern.pattern.id) {
      out.patternOverlay = { enabled: !off && pattern.enabled !== false, blend: fxBlendIn(pattern.blendMode), opacity: percent(pattern.opacity), scale: percent(pattern.scale), angle: round(typeof pattern.angle === "number" ? pattern.angle : 0, 2), phase: pattern.phase ? { x: pattern.phase.x || 0, y: pattern.phase.y || 0 } : undefined, pattern: { id: pattern.pattern.id, name: pattern.pattern.name } };
    }
    return Object.keys(out).length ? out : undefined;
  };

  // Equal as settings: the same numbers, the same fields (an absent one and an undefined one alike)
  const sameValue = (a, b) => {
    if (a === b) return true;
    if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-6;
    if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = new Set(Object.keys(a).concat(Object.keys(b)));
    for (const key of keys) if (!sameValue(a[key], b[key])) return false;
    return true;
  };

  /* --------------------------- SFX in the file's XMP --------------------------- */

  // Photoshop has nowhere to keep how an SFX was made: its settings go in the file's metadata,
  // which Photoshop keeps, one entry per SFX folder, by its name. The folder and its letters
  // stay ordinary layers that Photoshop edits as it likes.
  const XMP_NS = "http://typer.hayasaku.fr/ns/sfx/1.0/";
  const toBase64 = (text) => {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  };
  const fromBase64 = (text) => new TextDecoder().decode(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)));
  // One entry of the file's metadata, `typer:<key>`: a list, as base64 JSON
  const propertyPattern = (key) => new RegExp(`\\s*typer:${key}="[^"]*"|\\s*<typer:${key}>[^<]*<\\/typer:${key}>`, "g");
  const listOfXmp = (xmp, key) => {
    const found = new RegExp(`typer:${key}(?:="([^"]*)"|>([^<]*)<)`).exec(xmp || "");
    if (!found) return [];
    try {
      const list = JSON.parse(fromBase64((found[1] || found[2] || "").trim()));
      return Array.isArray(list) ? list : [];
    } catch (error) {
      console.warn(`TypeR web: this file's ${key} settings can't be read`, error);
      return [];
    }
  };
  const xmpWithList = (xmp, key, list) => {
    let out = String(xmp || "").replace(propertyPattern(key), "");
    if (!list.length) return xmp ? out : undefined;
    const value = toBase64(JSON.stringify(list));
    if (!/<rdf:Description\b/.test(out)) {
      out = `<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about=""/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
    }
    return out.replace(/<rdf:Description\b([^>]*?)(\/?)>/, (tag, attributes, closed) => {
      const ns = /xmlns:typer=/.test(attributes) ? "" : ` xmlns:typer="${XMP_NS}"`;
      return `<rdf:Description${attributes}${ns} typer:${key}="${value}"${closed}>`;
    });
  };
  const sfxOfXmp = (xmp) => listOfXmp(xmp, "sfx");
  const xmpWithSfx = (xmp, list) => xmpWithList(xmp, "sfx", list);
  // Each saved SFX finds its folder again: by name, in order, else by the letters inside
  const attachSfx = (groups, layers, xmp) => {
    const list = sfxOfXmp(xmp);
    if (!list.length) return;
    const claimed = new Set();
    // The letters are stacked in any order: they are compared as a set
    const sorted = (text) => Array.from(String(text).replace(/\s/g, "")).sort().join("");
    const lettersOf = (group) => sorted(layers.filter((layer) => layer.group === group.id && layer.kind === "text").map((layer) => layer.params.layerText.textKey).join(""));
    list.forEach((entry) => {
      if (!entry || !entry.recipe) return;
      let group = groups.find((item) => !claimed.has(item) && item.name === entry.name);
      if (!group) group = groups.find((item) => !claimed.has(item) && entry.recipe.text && lettersOf(item) === sorted(entry.recipe.text));
      if (!group) return;
      claimed.add(group);
      group.sfx = entry.recipe;
    });
  };

  // A text in perspective is saved as what shows, in pixels, over its text, hidden (see
  // nodesFor). Its surface goes in the metadata, so that it opens as the text it was: one layer,
  // still in perspective, that the Move tool takes by its frame and not by its letters. Left
  // as two layers if Photoshop changed the text, or took the pixels away.
  // A letter reshaped (an SFX's) is saved the same way, its shape (`mesh`) in place of a surface.
  const meshed = (layer) => layer.kind === "text" && !layer.warp && !layer.raster && (PS().meshOk(layer.mesh) || PS().outlineOk(layer.outline));
  // A letter drawn point by point (`outline`) is saved as a shape, as Photoshop's Convert to
  // Shape makes one: its points can be pulled there too. Its frame goes in the metadata, so
  // that what Photoshop changed of its points comes back here.
  const outlined = (layer) => meshed(layer) && PS().outlineOk(layer.outline);
  const warpsForSave = (doc) => doc.state.layers
    .filter((layer) => layer.kind === "text" && (layer.warp || meshed(layer)))
    .map((layer) => {
      // Its Smart Filters too: what shows is saved filtered, as pixels
      const smart = PS().isSmart(layer) ? { filters: layer.filters } : {};
      if (layer.warp) return Object.assign({ name: layer.name, text: layer.params.layerText.textKey, warp: layer.warp }, smart);
      const entry = Object.assign({ name: layer.name, text: layer.params.layerText.textKey }, smart);
      if (PS().meshOk(layer.mesh)) entry.mesh = layer.mesh;
      if (outlined(layer)) Object.assign(entry, { outline: layer.outline, frame: PS().shapeFrameOf(layer, doc) });
      return entry;
    });
  // A shape's paths back into a letter's outline, through the frame it was saved in
  const outlineFromPaths = (vectorMask, frame, ch) => {
    if (!vectorMask || !Array.isArray(vectorMask.paths) || !frame || !Array.isArray(frame.box) || !Array.isArray(frame.anchor)) return null;
    const [left, top, width, height] = frame.box;
    const [ax, ay] = frame.anchor;
    const s = Array.isArray(frame.spin) ? frame.spin : [1, 0, 0, 1];
    const det = s[0] * s[3] - s[1] * s[2];
    if (!(width > 0) || !(height > 0) || !det) return null;
    const uv = (x, y) => {
      const dx = x - ax;
      const dy = y - ay;
      return [round(((s[3] * dx - s[2] * dy) / det - left) / width, 5), round(((-s[1] * dx + s[0] * dy) / det - top) / height, 5)];
    };
    const c = vectorMask.paths.filter((path) => !path.open && Array.isArray(path.knots) && path.knots.length >= 2).map((path) => path.knots.map(({ points, linked }) => {
      const [ix, iy] = uv(points[0], points[1]);
      const [x, y] = uv(points[2], points[3]);
      const [ox, oy] = uv(points[4], points[5]);
      return [x, y, ix, iy, ox, oy, linked ? 1 : 0];
    }));
    const outline = { ch, c };
    return PS().outlineOk(outline) ? outline : null;
  };
  // The perspective zones of a page (see surfacesOf in photoshop.js) go in the metadata too,
  // and the texts taken off them, told by their name and their words
  const surfacesForSave = (doc) => PS().surfacesOf(doc).map(({ corners, unit, wide, found }) => ({ corners, unit, wide, found }));
  const offSurfaceForSave = (doc) => doc.state.layers.filter((layer) => layer.kind === "text" && layer.offSurface).map((layer) => ({ name: layer.name, text: layer.params.layerText.textKey }));
  const surfacesOfXmp = (xmp) => listOfXmp(xmp, "surfaces")
    .filter((zone) => zone && Array.isArray(zone.corners) && zone.corners.length === 4 && zone.corners.every((corner) => Array.isArray(corner) && corner.length === 2 && corner.every(Number.isFinite))
      && Array.isArray(zone.unit) && zone.unit.length === 2 && zone.unit.every((value) => value > 0))
    .map(({ corners, unit, wide, found }) => ({ corners, unit, wide: wide > 0 ? wide : 1, found: { across: Boolean(found && found.across), down: Boolean(found && found.down) } }));
  // The work path of a page (see ops.setWorkPath in photoshop.js), where Photoshop keeps its
  // own and in the same form: it shows in Photoshop's Paths panel, and Photoshop's shows here
  const soundPaths = (paths) => (Array.isArray(paths) ? paths.filter((path) => path && Array.isArray(path.knots) && path.knots.length && path.knots.every((knot) => knot && Array.isArray(knot.points) && knot.points.length === 6 && knot.points.every(Number.isFinite))) : []);
  const workPathOf = (resources) => {
    const paths = soundPaths(resources && resources.workPath && resources.workPath.paths);
    return paths.length ? { paths } : null;
  };
  const attachOffSurface = (layers, xmp) => {
    const taken = new Set();
    listOfXmp(xmp, "offsurface").forEach((entry) => {
      const layer = entry && layers.find((item) => item.kind === "text" && !taken.has(item) && item.name === entry.name && item.params.layerText.textKey === entry.text);
      if (!layer) return;
      layer.offSurface = true;
      taken.add(layer);
    });
  };
  // A text that goes on from a page to the next (across.js): the same layer in both files, and
  // here what says that the two are one text. Found again by its name and its letters, and by
  // where it is when two are alike. `rev` counts its changes: the page saved last has the most.
  const acrossForSave = (doc) => doc.state.layers.filter((layer) => layer.kind === "text" && layer.across).map((layer) => {
    const point = layer.params.layerText.textClickPoint;
    return { name: layer.name, text: layer.params.layerText.textKey, key: layer.across.key, part: layer.across.part, rev: window.TypeRAcross ? window.TypeRAcross.revOf(doc, layer) : layer.across.rev || 0, at: [point.horizontal, point.vertical] };
  });
  const attachAcross = (layers, xmp) => {
    const taken = new Set();
    listOfXmp(xmp, "across").forEach((entry) => {
      if (!entry || typeof entry.key !== "string" || (entry.part !== "top" && entry.part !== "bottom")) return;
      const alike = layers.filter((item) => item.kind === "text" && !taken.has(item) && item.name === entry.name && item.params.layerText.textKey === entry.text);
      if (!alike.length) return;
      const far = (item) => {
        const point = item.params.layerText.textClickPoint;
        return Array.isArray(entry.at) ? Math.hypot(point.horizontal - entry.at[0], point.vertical - entry.at[1]) : 0;
      };
      const layer = alike.reduce((best, item) => (far(item) < far(best) ? item : best));
      layer.across = { key: entry.key, part: entry.part, rev: entry.rev > 0 ? entry.rev : 0 };
      taken.add(layer);
    });
  };
  // What a text layer's own data can't say (see textBlockOf), kept for TypeR itself: a text set
  // in Optical, or with its Contextual alternates off, comes back so from a PSD TypeR wrote.
  // Each entry: the layer's name and text, then for each run its length, its kerning (2 for
  // Optical) and its alternates (0 when off). The file's text block says the same to Photoshop
  // (see textBlockOut) and is believed first; this list speaks for the texts with no entry
  // there (see blockModel).
  const lettersForSave = (doc) => doc.state.layers
    .filter((layer) => layer.kind === "text" && layer.params.layerText.textStyleRange.some((range) => range.textStyle.autoKern === "opticalKern" || range.textStyle.contextualLigatures === false))
    .map((layer) => ({
      name: layer.name,
      text: layer.params.layerText.textKey,
      runs: layer.params.layerText.textStyleRange.map((range) => [range.to - range.from, range.textStyle.autoKern === "opticalKern" ? 2 : 0, range.textStyle.contextualLigatures === false ? 0 : 1]),
    }));
  const attachLetters = (layers, xmp) => {
    const taken = new Set();
    listOfXmp(xmp, "letters").forEach((entry) => {
      if (!entry || !Array.isArray(entry.runs) || typeof entry.text !== "string") return;
      const layer = layers.find((item) => item.kind === "text" && !taken.has(item) && !saidByBlock.has(item.params.layerText.textStyleRange) && item.name === entry.name && item.params.layerText.textKey === entry.text);
      if (!layer) return;
      taken.add(layer);
      const runs = entry.runs.filter((run) => Array.isArray(run) && run[0] > 0).map((run) => ({ length: run[0], kerning: run[1] === 2 ? 2 : undefined, contextual: run[2] === 0 ? false : undefined }));
      blockStyles(layer.params.layerText.textStyleRange, entry.text, { text: entry.text, runs });
    });
  };
  const attachWarps = (layers, xmp) => {
    const list = listOfXmp(xmp, "warps");
    if (!list.length) return;
    const gone = new Set();
    list.forEach((entry) => {
      const surface = Boolean(entry && entry.warp && Array.isArray(entry.warp.corners) && entry.warp.source);
      if (!surface && !(entry && (PS().meshOk(entry.mesh) || PS().outlineOk(entry.outline)))) return;
      const at = layers.findIndex((layer, index) => {
        const shown = layers[index + 1];
        return layer.kind === "text" && !gone.has(layer) && layer.visible === false && layer.name === `${entry.name} (text)` && layer.params.layerText.textKey === entry.text
          && shown && shown.kind !== "text" && shown.kind !== "group" && !gone.has(shown) && shown.name === entry.name && shown.group === layer.group;
      });
      if (at < 0) return;
      const text = layers[at];
      const shown = layers[at + 1];
      // A shape: its points as Photoshop left them, its shape (`mesh`) in them
      let outline = !surface && PS().outlineOk(entry.outline) ? entry.outline : undefined;
      let mesh = surface || !PS().meshOk(entry.mesh) ? undefined : entry.mesh;
      const fromPaths = outline ? outlineFromPaths(shown.vectorMask, entry.frame, outline.ch) : null;
      if (fromPaths) {
        outline = fromPaths;
        mesh = undefined;
      }
      Object.assign(text, { name: shown.name, visible: shown.visible, opacity: shown.opacity, blend: shown.blend, clipping: shown.clipping, locked: shown.locked, locks: shown.locks, color: shown.color, warp: surface ? entry.warp : undefined, mesh, outline, raster: null });
      if (Array.isArray(entry.filters)) text.filters = entry.filters.map((filter) => PS().cleanFilter(filter)).filter(Boolean);
      gone.add(text);
      gone.add(shown);
    });
    const shownLayers = new Set(Array.from(gone).filter((layer) => layer.kind !== "text"));
    for (let i = layers.length - 1; i >= 0; i--) if (shownLayers.has(layers[i])) layers.splice(i, 1);
  };

  /* ----------------------------- smart objects ----------------------------- */

  // A text that is a smart object here (`layer.filters`, see SMART_FILTERS in photoshop.js) is
  // saved as Photoshop keeps one: a smart object layer, whose pixels are the text filtered, and
  // inside the PSD the file it stands for, a PSD of its own that holds the text layer (a double
  // click on the smart object opens it in Photoshop, the text still a text), with the filters
  // as its Smart Filters. Nothing of it goes in the metadata: opening reads the same things
  // back, so a smart object made or changed in Photoshop (its text, its filter's settings)
  // opens as the text it holds too. One that holds anything TypeR can't keep as a text (more
  // than a text layer, a filter it doesn't know, a painted filter mask, a scale or a turn, a
  // layer style of its own) stays the pixel layer it has always been here, and goes back into
  // the file as it came.
  // Each filter as ag-psd names it, both ways (see SMART_FILTERS)
  const SMART_FILTER_OUT = {
    motionBlur: (f) => ({ type: "motion blur", name: "Motion Blur...", filter: { angle: f.angle, distance: { value: f.distance, units: "Pixels" } } }),
  };
  const SMART_FILTER_IN = {
    "motion blur": (item) => ({ type: "motionBlur", angle: item.filter && item.filter.angle, distance: item.filter && item.filter.distance && item.filter.distance.value }),
  };
  const uuid = () => {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 15) | 64;
    b[8] = (b[8] & 63) | 128;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
  // What makes the look of a smart text: while each is still what the file gave, the smart
  // object goes back into the file untouched
  const SMART_LOOK = ["params", "raster", "stroke", "effects", "filters", "fill", "knockout", "envelope", "rotated", "spin", "warp", "mesh", "outline"];
  const smartLook = (layer) => SMART_LOOK.reduce((out, key) => Object.assign(out, { [key]: layer[key] }), { opacity: layer.opacity });
  // (in the document it came with: dragged into another, its file isn't in that one's)
  const smartKept = (layer, doc) => {
    const from = layer.smart && layer.smart.node;
    const files = doc.psd && doc.psd.source && doc.psd.source.linkedFiles;
    if (!from || !from.placedLayer || !Array.isArray(files) || !files.some((file) => file.id === from.placedLayer.id)) return false;
    return SMART_LOOK.every((key) => layer[key] === layer.smart.as[key]) && (layer.smart.inside === 1 || layer.opacity === layer.smart.as.opacity);
  };
  // Any effect of a layer style that is on, whichever (a bevel too)
  const anyEffectOn = (effects) => Boolean(effects) && !effects.disabled && Object.keys(effects).some((key) => {
    const value = effects[key];
    return (Array.isArray(value) ? value : [value]).some((entry) => entry && typeof entry === "object" && entry.enabled === true);
  });
  // How many layers a PSD has, read from its first bytes: a smart object's file is only
  // decoded when it has the one layer a text would be
  const layerCountOf = (bytes) => {
    try {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (view.getUint32(0) !== 0x38425053) return -1;
      const large = view.getUint16(4) === 2;
      let at = 26;
      at += 4 + view.getUint32(at);
      at += 4 + view.getUint32(at);
      at += large ? 16 : 8;
      return Math.abs(view.getInt16(at));
    } catch (error) {
      return -1;
    }
  };
  // Whether a filter mask is white all over (PackBits rows, their lengths first, or raw bytes)
  const allWhite = (part, rows) => {
    const { data, compressionMode } = part;
    if (!data || !(rows > 0)) return false;
    if (compressionMode === 0) return data.every((value) => value === 255);
    if (compressionMode !== 1) return false;
    return [4, 2].some((size) => {
      let at = rows * size;
      if (at > data.length) return false;
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      for (let row = 0; row < rows; row++) {
        const end = at + (size === 2 ? view.getUint16(row * 2) : view.getUint32(row * 4));
        if (end > data.length) return false;
        while (at < end) {
          const n = data[at] > 127 ? data[at] - 256 : data[at];
          at++;
          if (n === -128) continue;
          const count = n < 0 ? 1 : n + 1;
          if (at + count > end) return false;
          for (let i = 0; i < count; i++) if (data[at + i] !== 255) return false;
          at += count;
        }
      }
      return at === data.length;
    });
  };
  // A row of bytes packed as PSD files pack them (PackBits)
  const packBits = (row) => {
    const n = row.length;
    const out = new Uint8Array(n + Math.ceil(n / 128) + 2);
    let o = 0;
    let i = 0;
    while (i < n) {
      let run = 1;
      while (i + run < n && run < 128 && row[i + run] === row[i]) run++;
      if (run > 1) {
        out[o++] = 257 - run;
        out[o++] = row[i];
        i += run;
        continue;
      }
      const start = i;
      i++;
      while (i < n && i - start < 128 && (i + 1 >= n || row[i] !== row[i + 1])) i++;
      out[o++] = i - start - 1;
      out.set(row.subarray(start, i), o);
      o += i - start;
    }
    return out.slice(0, o);
  };
  // What Photoshop keeps of a smart object before its Smart Filters, by the id of its placing
  // (the file's FEid block): the picture unfiltered, over the whole page, its colours (white
  // where there is nothing) then how much of each pixel it covers, and the filters' mask, all
  // white; every row packed, the rows' lengths first, four bytes each. Without it, Photoshop
  // takes the layer's pixels, filtered already, as what to filter when a filter is changed
  // there: the text would be blurred twice. `picture` has its top left at (left, top).
  const filterCacheOf = (id, picture, left, top, doc, colorMode) => {
    const W = doc.width;
    const H = doc.height;
    const pw = picture.width;
    const data = picture.getContext("2d").getImageData(0, 0, pw, picture.height).data;
    const x0 = Math.max(0, left);
    const x1 = Math.min(W, left + pw);
    const y0 = Math.max(0, top);
    const y1 = Math.min(H, top + picture.height);
    const plane = (pick, empty) => {
      const row = new Uint8Array(W).fill(empty);
      const blank = packBits(row);
      const rows = [];
      let total = 0;
      for (let y = 0; y < H; y++) {
        let packed = blank;
        if (pick && y >= y0 && y < y1 && x1 > x0) {
          for (let x = x0, i = ((y - top) * pw + x0 - left) * 4; x < x1; x++, i += 4) row[x] = pick(i);
          packed = packBits(row);
        }
        rows.push(packed);
        total += packed.length;
      }
      const out = new Uint8Array(H * 4 + total);
      const view = new DataView(out.buffer);
      let at = H * 4;
      rows.forEach((packed, y) => {
        view.setUint32(y * 4, packed.length);
        out.set(packed, at);
        at += packed.length;
      });
      return { compressionMode: 1, data: out };
    };
    const channels = new Array(26);
    if (colorMode === 1) channels[0] = plane((i) => (data[i + 3] ? Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) : 255), 255);
    else [0, 1, 2].forEach((c) => { channels[c] = plane((i) => (data[i + 3] ? data[i + c] : 255), 255); });
    channels[25] = plane((i) => data[i + 3], 0);
    return { id, top: 0, left: 0, bottom: H, right: W, depth: 8, channels, extra: Object.assign({ top: 0, left: 0, bottom: H, right: W }, plane(null, 255)) };
  };
  // The text a smart object holds, when TypeR can keep it as one: { text: its layer as the
  // page has it, filters, source: its file's own settings, inside: the opacity it has in
  // there }. Null for any other.
  const smartTextOf = async (node, psd, doc, globalAngle) => {
    const placed = node.placedLayer;
    if (!placed || placed.external || placed.type !== "raster" || node.adjustment || node.text || node.children) return null;
    const filters = [];
    if (placed.filter) {
      if (placed.filter.enabled === false) return null;
      for (const item of placed.filter.list || []) {
        const filter = SMART_FILTER_IN[item.type] && item.enabled !== false && (item.blendMode || "normal") === "normal" && !(item.opacity < 1) ? PS().cleanFilter(SMART_FILTER_IN[item.type](item)) : null;
        if (!filter) return null;
        filters.push(filter);
      }
      // A filter mask painted on hides part of the filters
      const cache = filters.length && placed.filter.maskEnabled !== false ? (psd.filterEffectsMasks || []).find((entry) => entry.id === placed.placed) : null;
      if (cache && cache.extra && !allWhite(cache.extra, cache.extra.bottom - cache.extra.top)) return null;
    }
    // Laid as it is: its corners square, at its own size, on whole pixels
    const t = placed.transform;
    const near = (a, b) => Math.abs(a - b) < 0.01;
    if (!Array.isArray(t) || t.length !== 8 || placed.nonAffineTransform || (placed.warp && placed.warp.style && placed.warp.style !== "none")) return null;
    if (!near(t[0], t[6]) || !near(t[2], t[4]) || !near(t[1], t[3]) || !near(t[5], t[7]) || !near(t[0], Math.round(t[0])) || !near(t[1], Math.round(t[1]))) return null;
    if (placed.comp !== undefined && placed.comp !== -1) return null;
    // Its own Fill or layer style would come after the filters: a text's come before
    if ((node.fillOpacity !== undefined && node.fillOpacity < 1) || anyEffectOn(node.effects)) return null;
    const file = (psd.linkedFiles || []).find((entry) => entry.id === placed.id);
    if (!file || !file.data || layerCountOf(file.data) !== 1) return null;
    let inner;
    try {
      inner = await decode(file.data.slice().buffer, null);
    } catch (error) {
      return null;
    }
    const kids = inner.children || [];
    const text = kids[0];
    if (kids.length !== 1 || !text.text || text.children || text.hidden || text.mask || text.realMask || text.vectorMask || text.placedLayer) return null;
    if (!near(t[2] - t[0], inner.width) || !near(t[7] - t[1], inner.height) || (inner.bitsPerChannel || 8) !== 8 || (inner.colorMode || 3) !== (psd.colorMode || 3)) return null;
    const info = inner.imageResources && inner.imageResources.resolutionInfo;
    if (!near((info && info.horizontalResolution) || 72, doc.resolution)) return null;
    // Effects lit by the Global Light take the angle of the file they are in
    const angle = inner.imageResources && inner.imageResources.globalAngle;
    if (angle !== undefined && angle !== globalAngle && JSON.stringify(text.effects || {}).includes('"useGlobalLight":true')) return null;
    const dx = Math.round(t[0]);
    const dy = Math.round(t[1]);
    const transform = (text.text.transform || [1, 0, 0, 1, 0, 0]).slice();
    transform[4] += dx;
    transform[5] += dy;
    const source = Object.assign({}, inner);
    delete source.children;
    delete source.canvas;
    delete source.imageData;
    return {
      text: Object.assign({}, text, { left: (text.left || 0) + dx, top: (text.top || 0) + dy, right: (text.right || 0) + dx, bottom: (text.bottom || 0) + dy, text: Object.assign({}, text.text, { transform }), linkGroup: node.linkGroup }),
      filters,
      source,
      inside: text.opacity === undefined ? 1 : text.opacity,
    };
  };

  /* ------------------------------- opening ------------------------------- */

  // A layer's masks in a file: Photoshop keeps the user's pixel mask in `realMask` when the
  // layer also has a vector mask, whose drawn shape then sits in `mask`
  const vectorMaskOf = (node) => (node.vectorMask && Array.isArray(node.vectorMask.paths) ? node.vectorMask : null);
  const pixelMaskOf = (node) => {
    if (vectorMaskOf(node) && node.mask && node.mask.fromVectorData) return node.realMask || null;
    return node.mask || null;
  };
  const masksIn = (node, layer) => {
    const pixel = pixelMaskOf(node);
    if (pixel) layer.mask = pixel;
    const vector = vectorMaskOf(node);
    if (vector) {
      layer.vectorMask = vector;
      const drawn = node.mask && node.mask.fromVectorData ? node.mask : null;
      if (drawn && drawn.vectorMaskDensity !== undefined) vector.density = drawn.vectorMaskDensity;
      if (drawn && drawn.vectorMaskFeather !== undefined) vector.feather = drawn.vectorMaskFeather;
    }
  };

  const locksIn = (node) => {
    const p = node.protected;
    if (!p || lockedIn(node) || !(p.transparency || p.composite || p.position)) return undefined;
    return { transparency: Boolean(p.transparency), pixels: Boolean(p.composite), position: Boolean(p.position) };
  };
  const lockedIn = (node) => Boolean(node.protected && (node.protected.all || (node.protected.transparency && node.protected.composite && node.protected.position)));

  const BACKGROUND_NAME = /^(background|arrière-plan|arriere-plan|fondo|fundo|hintergrund|背景|배경)$/i;

  const read = async (buffer, name, file) => {
    const psd = await decode(buffer, file);
    const info = psd.imageResources && psd.imageResources.resolutionInfo;
    const resolution = (info && info.horizontalResolution) || 72;
    const doc = { width: psd.width, height: psd.height, resolution };
    const globalAngle = psd.imageResources && psd.imageResources.globalAngle;
    const engine = PS();
    const layers = [];
    const fontNames = [];
    const textBlock = textBlockOf(psd);
    const notes = { adjustments: 0, depth: psd.bitsPerChannel || 8, colorMode: psd.colorMode };

    const common = (node, parent) => ({
      id: engine.newId(),
      name: node.name || "Layer",
      visible: !node.hidden,
      opacity: node.opacity === undefined ? 1 : node.opacity,
      blend: node.blendMode || "normal",
      group: parent,
      clipping: Boolean(node.clipping),
      // Photoshop's Lock All, its other locks, its colour label, its Fill and its link
      locked: lockedIn(node),
      locks: locksIn(node),
      color: node.layerColor && node.layerColor !== "none" ? node.layerColor : undefined,
      fill: node.fillOpacity > 0 && node.fillOpacity < 1 ? node.fillOpacity : undefined,
      raw: node,
    });

    // The smart objects that hold a text, found before the layers are walked: their files are
    // decoded as the PSD itself is
    const smartTexts = new Map();
    const findSmart = async (children) => {
      for (const node of children || []) {
        if (node.children) await findSmart(node.children);
        else {
          const smart = await smartTextOf(node, psd, doc, globalAngle);
          if (smart) smartTexts.set(node, smart);
        }
      }
    };
    await findSmart(psd.children);

    const groupsRead = [];
    const walk = (children, parent) => {
      (children || []).forEach((node, index) => {
        const smart = smartTexts.get(node);
        if (smart) {
          // The text it holds, read as any text layer, where the smart object puts it; the
          // layer's name, opacity, blend mode, masks and locks are the smart object's
          walk([smart.text], parent);
          const layer = layers[layers.length - 1];
          const outer = common(node, parent);
          Object.assign(layer, { name: outer.name, visible: outer.visible, opacity: outer.opacity * smart.inside, blend: outer.blend, clipping: outer.clipping, locked: outer.locked, locks: outer.locks, color: outer.color, filters: smart.filters });
          delete layer.mask;
          delete layer.vectorMask;
          masksIn(node, layer);
          layer.smart = { node, source: smart.source, inside: smart.inside, as: smartLook(layer) };
          return;
        }
        if (node.children) {
          const group = Object.assign(common(node, parent), { kind: "group", open: node.opened !== false });
          group.blend = node.blendMode || "pass through";
          // A folder's own layer style and mask, as an SFX has them
          const stroke = strokeFromEffects(node.effects);
          if (stroke) group.stroke = stroke;
          // Its shadow, glows and overlays (a Gradient Overlay on an SFX), drawn on all it holds
          const effects = effectsFromPsd(node.effects, globalAngle);
          if (effects) group.effects = effects;
          masksIn(node, group);
          if (node.fillOpacity === 0) group.knockout = true;
          // In Normal, its adjustment layers adjust only what it holds: drawn as one picture
          if (group.blend === "normal" && node.children.some((child) => child.adjustment)) group.isolated = true;
          groupsRead.push(group);
          walk(node.children, group.id);
          layers.push(group);
          return;
        }
        if (node.text) {
          const params = paramsFromPsd(node.text, doc, textBlock[node.text.index]);
          params.layerText.textStyleRange.forEach((range) => fontNames.push(range.textStyle.fontPostScriptName));
          const layer = Object.assign(common(node, parent), { kind: "text", params, stroke: strokeFromEffects(node.effects), raster: null });
          // Its shadow, glows and overlays, drawn around and on Photoshop's own letters
          const effects = effectsFromPsd(node.effects, globalAngle);
          if (effects) layer.effects = effects;
          // Warp Text: kept when the text is edited here
          const envelope = envelopeFromPsd(node.text.warp);
          if (envelope) layer.envelope = envelope;
          // Fill at 0%: only the stroke shows
          if (node.fillOpacity === 0) layer.knockout = true;
          if (node.canvas) {
            layer.raster = { bitmap: node.canvas, left: node.left || 0, top: node.top || 0 };
            // The letters at the layer's Fill, over their stroke
            const amount = engine.fillOf(layer);
            // Shown as they are, and saved again as an edited text: the file comes out right
            if (layer.stroke && amount === 1 && !layer.knockout && strokeDrawnIn(node.canvas, layer.stroke, params)) layer.raster.strokeDrawnIn = true;
            else if (layer.stroke) {
              const { canvas, pad } = strokedDisplay(node.canvas, layer.stroke, amount, layer);
              Object.assign(layer.raster, { display: canvas, displayLeft: -pad, displayTop: -pad });
            } else if (layer.knockout) Object.assign(layer.raster, { display: engine.newCanvas(1, 1), displayLeft: 0, displayTop: 0 });
            else if (amount < 1) {
              const canvas = engine.newCanvas(node.canvas.width, node.canvas.height);
              const c = canvas.getContext("2d");
              c.globalAlpha = amount;
              c.drawImage(node.canvas, 0, 0);
              Object.assign(layer.raster, { display: canvas, displayLeft: 0, displayTop: 0 });
            }
          }
          masksIn(node, layer);
          layer.rotated = isTurned(node.text.transform);
          // Sizes come out of the transform's scale when read: what is left of it is the turn
          if (layer.rotated) {
            const t = node.text.transform;
            const scale = Math.hypot(t[2], t[3]) || 1;
            layer.spin = [t[0] / scale, t[1] / scale, t[2] / scale, t[3] / scale];
          }
          layers.push(layer);
          return;
        }
        const layer = engine.newRaster(node.name || "Layer", Object.assign(common(node, parent), { bitmap: node.canvas || null, left: node.left || 0, top: node.top || 0 }));
        // A pixel or shape layer's layer style (letters made pixels, with a Gradient Overlay):
        // drawn on the page, its pixels left as they are
        const effects = node.adjustment ? undefined : effectsFromPsd(node.effects, globalAngle);
        if (effects) layer.effects = effects;
        // A shape's strokes (an SFX made a shape: two strokes around letters at Fill 0%), drawn
        // around its pixels. They stay in the file as they were.
        const stroke = node.adjustment ? null : strokeFromEffects(node.effects);
        if (stroke) layer.stroke = stroke;
        if (node.fillOpacity === 0 && !node.adjustment) layer.fill = 0;
        masksIn(node, layer);
        if (node.adjustment) {
          layer.adjustment = true;
          // Invert is drawn; the others are only kept
          if (node.adjustment.type !== "invert") notes.adjustments++;
        }
        if (!parent && index === 0 && BACKGROUND_NAME.test(layer.name)) {
          layer.isBackground = true;
          // The Background's own locks are not Lock All
          layer.locked = Boolean(node.protected && node.protected.all);
        }
        layers.push(layer);
      });
    };
    walk(psd.children, null);
    // For the texts the document's text block doesn't speak for: those TypeR wrote without
    // an entry there (see blockModel)
    attachLetters(layers, psd.imageResources && psd.imageResources.xmpMetadata);
    attachWarps(layers, psd.imageResources && psd.imageResources.xmpMetadata);
    attachOffSurface(layers, psd.imageResources && psd.imageResources.xmpMetadata);
    attachAcross(layers, psd.imageResources && psd.imageResources.xmpMetadata);
    // Photoshop's linked layers share a number; one shared by every layer is no link at all
    const shared = new Map();
    layers.forEach((layer) => {
      const link = layer.raw && layer.raw.linkGroup;
      if (link) shared.set(link, (shared.get(link) || 0) + 1);
    });
    layers.forEach((layer) => {
      const link = layer.raw && layer.raw.linkGroup;
      if (link && shared.get(link) > 1 && shared.get(link) < layers.length) layer.link = link;
    });
    attachSfx(groupsRead, layers, psd.imageResources && psd.imageResources.xmpMetadata);

    if (!layers.length && psd.canvas) {
      layers.push(engine.newRaster("Background", { bitmap: psd.canvas, isBackground: true }));
    }

    await Fonts.ready(fontNames);
    const missing = Array.from(new Set(fontNames)).filter((name) => name && Fonts.isMissing(name));

    const source = Object.assign({}, psd);
    delete source.children;
    delete source.canvas;
    delete source.imageData;
    return { width: psd.width, height: psd.height, resolution, layers, psd: { source }, missingFonts: missing, notes, surfaces: surfacesOfXmp(psd.imageResources && psd.imageResources.xmpMetadata), workPath: workPathOf(psd.imageResources) };
  };

  // What FontScanR wants from a file: its text layers, without decoding a single pixel.
  // Timers rather than frames, so that a scan goes on in a tab left in the background.
  const readText = async (buffer) => {
    const lib = await library();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const psd = lib.readPsd(new Uint8Array(buffer), { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true, logMissingFeatures: false });
    const info = psd.imageResources && psd.imageResources.resolutionInfo;
    const doc = { width: psd.width, height: psd.height, resolution: (info && info.horizontalResolution) || 72 };
    const layers = [];
    const textBlock = textBlockOf(psd);
    // Where each one sits, and whether it shows, groups included: TextShapeR's training needs both
    const walk = (children, parentPath, parentVisible) => (children || []).forEach((node) => {
      const name = node.name || "";
      const path = parentPath ? parentPath + " / " + name : name;
      const visible = parentVisible && !node.hidden;
      if (node.children) walk(node.children, path, visible);
      else if (node.text) layers.push({ name, path, visible, params: paramsFromPsd(node.text, doc, textBlock[node.text.index]), stroke: strokeFromEffects(node.effects) });
    });
    walk(psd.children, "", true);
    return { resolution: doc.resolution, layers };
  };

  /* -------------------------------- saving -------------------------------- */

  const JUSTIFY_OUT = { left: "left", right: "right", center: "center" };

  // A paragraph's own hyphenation settings, where they aren't Photoshop's usual ones (words
  // longer than 6 letters, 2 letters on each side, a zone of 36): the zone is a length of the
  // text, as its sizes are
  const hyphenationFromPsd = (paragraph, scale) => Object.assign({},
    paragraph.hyphenatedWordSize && paragraph.hyphenatedWordSize !== 6 ? { hyphenateWordSize: paragraph.hyphenatedWordSize } : {},
    paragraph.preHyphen && paragraph.preHyphen !== 2 ? { hyphenatePreLength: paragraph.preHyphen } : {},
    paragraph.postHyphen && paragraph.postHyphen !== 2 ? { hyphenatePostLength: paragraph.postHyphen } : {},
    typeof paragraph.zone === "number" && paragraph.zone * scale !== 36 ? { hyphenationZone: paragraph.zone * scale } : {});
  // What a text's lines hang on, written as it is set here: Photoshop sets the lines again from
  // these when it updates the text. Left out, Photoshop takes its own (an Auto Leading of 120%).
  const paragraphToPsd = (paragraph) => Object.assign({
    justification: JUSTIFY_OUT[paragraph && paragraph.alignment] || "center",
    autoLeading: (paragraph && paragraph.autoLeadingPercentage) || 1.2,
    // Photoshop hyphenates unless told not to: it would cut words TypeR keeps whole
    autoHyphenate: Boolean(paragraph && paragraph.hyphenate),
  }, paragraph && paragraph.hangingRoman ? { hanging: true } : {}, paragraph && paragraph.hyphenate ? Object.assign({},
    paragraph.hyphenateWordSize ? { hyphenatedWordSize: paragraph.hyphenateWordSize } : {},
    paragraph.hyphenatePreLength ? { preHyphen: paragraph.hyphenatePreLength } : {},
    paragraph.hyphenatePostLength ? { postHyphen: paragraph.hyphenatePostLength } : {},
    paragraph.hyphenationZone !== undefined ? { zone: paragraph.hyphenationZone } : {}) : {});

  // `vertical`: the style of a vertical text, which says how its characters stand
  const styleToPsd = (style, resolution, vertical) => {
    const color = style.color || { red: 0, green: 0, blue: 0 };
    const out = {
      font: { name: style.fontPostScriptName || style.fontName || "ArialMT" },
      fontSize: ((style.impliedFontSize || style.size || 12) * resolution) / 72,
      fillColor: { r: color.red, g: color.green, b: color.blue },
      autoLeading: style.autoLeading !== false,
      tracking: style.tracking || 0,
      horizontalScale: (style.horizontalScale === undefined ? 100 : style.horizontalScale) / 100,
      verticalScale: (style.verticalScale === undefined ? 100 : style.verticalScale) / 100,
      fauxBold: Boolean(style.syntheticBold),
      fauxItalic: Boolean(style.syntheticItalic),
      fontCaps: style.fontCaps === "allCaps" ? 2 : style.fontCaps === "smallCaps" ? 1 : 0,
      baselineShift: ((style.impliedBaselineShift !== undefined ? style.impliedBaselineShift : style.baselineShift) || 0) * (resolution / 72),
      fontBaseline: style.baseline === "subScript" ? 2 : style.baseline === "superScript" ? 1 : 0,
      underline: Boolean(style.underline) && style.underline !== "underlineOff",
      strikethrough: Boolean(style.strikethrough) && style.strikethrough !== "strikethroughOff",
      // As Photoshop writes a pair kerned by hand: on its second letter, without the font's kerning
      autoKerning: style.autoKern !== "manual" && !style.kerning,
      kerning: style.kerning || 0,
      ligatures: style.ligature !== false,
      dLigatures: Boolean(style.altligature),
      language: PS().textLanguageNumber(style.textLanguage),
    };
    if (style.autoLeading === false && style.leading) out.leading = (style.leading * resolution) / 72;
    if (vertical) out.baselineDirection = DIRECTION_OUT[style.baselineDirection] || 1;
    // Extra Bold, which Photoshop has no control for: the characters' own stroke, in their
    // colour, which Photoshop draws (tried in Photoshop 2026) and keeps when the text is edited
    const extra = Boolean(style.syntheticBold && style.extraBold);
    out.strokeFlag = extra;
    // The stroke's width is in 128ths of the size, whatever the size and the resolution: Photoshop
    // draws a width of 8 one sixteenth of the size wide (measured in Photoshop 2026, 16 to 200 px)
    if (extra) Object.assign(out, { strokeColor: out.fillColor, outlineWidth: 128 * PS().EXTRA_BOLD_WIDTH, fillFirst: true });
    return out;
  };

  const textToPsd = (layer, doc) => {
    const lt = layer.params.layerText;
    const value = String(lt.textKey || "").replace(/\r/g, "\n");
    const ranges = lt.textStyleRange || [];
    const paragraph = lt.paragraphStyleRange && lt.paragraphStyleRange[0] && lt.paragraphStyleRange[0].paragraphStyle;
    const shape = lt.textShape && lt.textShape[0];
    const box = shape && shape.textType === "box" && shape.box;
    const spin = (layer.rotated && layer.spin) || [1, 0, 0, 1];
    const vertical = PS().verticalOf(lt);
    const out = {
      text: value,
      transform: [spin[0], spin[1], spin[2], spin[3], (lt.textClickPoint.horizontal / 100) * doc.width, (lt.textClickPoint.vertical / 100) * doc.height],
      antiAlias: ANTI_ALIAS_OUT[lt.antiAlias] || "smooth",
      shapeType: box ? "box" : "point",
      style: styleToPsd(ranges[0] ? ranges[0].textStyle : {}, doc.resolution, vertical),
      paragraphStyle: paragraphToPsd(paragraph),
    };
    if (vertical) {
      // A vertical text, as Photoshop writes its own: a point text has the same anchor, the
      // top of its first line, and a box its top left corner where TypeR keeps its top right.
      // Photoshop always starts at the right of a box: to keep a text centred across its box
      // where it shows, the right of its box comes in to it.
      out.orientation = "vertical";
      if (box) {
        const layout = PS().layoutLayer(layer, doc);
        const shift = layout.relative.shift;
        const width = layout.overflow ? box.width : Math.max(box.autoHeight ? 0 : box.width - shift, layout.contentHeight * 1.08);
        const left = -(layout.overflow ? 0 : shift) - width;
        out.transform[4] += spin[0] * left;
        out.transform[5] += spin[1] * left;
        out.boxBounds = [0, 0, width, box.height];
      }
      // What TypeR sets side by side on its own (two digits, two of ! and ?) is said to
      // Photoshop as its Tate-Chu-Yoko, which it only does where it is told
      const pairs = PS().pairsOfText(lt);
      const styles = [];
      ranges.forEach((range) => {
        for (let at = Math.max(0, range.from); at < Math.min(value.length, range.to); at++) styles[at] = range.textStyle;
      });
      const side = Object.assign({}, { baselineDirection: "cross" });
      const crossed = new Map();
      pairs.forEach(([from, to]) => {
        for (let at = from; at < to; at++) {
          if (!styles[at]) continue;
          if (!crossed.has(styles[at])) crossed.set(styles[at], Object.assign({}, styles[at], side));
          styles[at] = crossed.get(styles[at]);
        }
      });
      const runs = [];
      let complete = styles.length === value.length;
      for (let at = 0; at < value.length; at++) {
        if (!styles[at]) complete = false;
        const last = runs[runs.length - 1];
        if (last && last.textStyle === styles[at]) last.length++;
        else runs.push({ textStyle: styles[at], length: 1 });
      }
      if (complete && runs.length > 1) out.styleRuns = runs.map((run) => ({ length: run.length, style: styleToPsd(run.textStyle, doc.resolution, true) }));
      // A text that is all one pair, "!?" alone: its own style says it
      else if (complete && runs.length === 1) out.style = styleToPsd(runs[0].textStyle, doc.resolution, true);
      if (window.TypeRTextWarp.on(layer.envelope)) out.warp = envelopeToPsd(layer.envelope);
      return out;
    }
    if (box) {
      // A little room, so that Photoshop's own line heights don't hide the last line.
      // Photoshop always starts at the top of a box: to keep a centred text where it shows,
      // the top of its box comes down to it.
      const layout = PS().layoutLayer(layer, doc);
      const shift = layout.relative.shift;
      out.transform[4] += spin[2] * shift;
      out.transform[5] += spin[3] * shift;
      const height = layout.overflow ? box.height : Math.max(box.autoHeight ? 0 : box.height - shift, layout.contentHeight * 1.08);
      out.boxBounds = [0, 0, box.width, height];
    }
    // Warp Text: Photoshop opens it with the same style and values
    if (window.TypeRTextWarp.on(layer.envelope)) out.warp = envelopeToPsd(layer.envelope);
    if (ranges.length > 1) {
      let covered = 0;
      out.styleRuns = ranges.map((range) => {
        const length = Math.max(0, Math.min(value.length, range.to) - range.from);
        covered += length;
        return { length, style: styleToPsd(range.textStyle, doc.resolution) };
      }).filter((run) => run.length);
      if (covered !== value.length) delete out.styleRuns;
    }
    return out;
  };

  /* The document's text block for the file. Photoshop reads a text's kerning as Metrics and its
     Contextual alternates as off unless the block says otherwise (see textBlockOf): each text
     written here gets an entry of its own there, and Photoshop then shows it in Optical or
     with its alternates, and sets it so when it lays the text out again. An entry says
     everything of its text, not only these two: it is written as Photoshop 2026 itself turns a
     layer's data into one (read from files it saved after laying such texts out again), key for
     key, so that nothing else of the text changes. Every text, even one in Metrics with its
     alternates off, which Photoshop would read right without: as it opens the file, Photoshop
     shows a text that has an entry as TypeR drew it, and one without a little heavier, and a
     page's texts should not differ by that. A text an entry can't be written for (see
     blockModel) gets none and its layer says so (its number is -1, as Photoshop writes it):
     Photoshop reads it from its layer, as it always did. */
  // A number as the block writes one that may have decimals: 12.0, .5, 166.66667
  const blockReal = (value) => {
    const number = Math.fround(Number.isFinite(value) ? value : 0);
    let out = number.toFixed(5).replace(/0+$/, "");
    if (out.endsWith(".")) out += "0";
    if (Number(out) === 0) return "0.0";
    return out.replace(/^(-?)0\./, "$1.");
  };
  const blockWhole = (value) => (Number.isInteger(value) ? String(value) : blockReal(value));
  // A string for a block written as text: its characters behind the UTF-16 mark
  const blockQuoted = (text) => "(\uFEFF" + String(text).replace(/[\\()]/g, "\\$&") + ")";
  // A block written as text into its tree. Strings: ( ) around their characters, in UTF-16
  // when they start with the mark, with \ before a parenthesis or a \ of their own.
  const blockFromSource = (source) => {
    const bytes = [];
    for (let i = 0; i < source.length; i++) {
      if (source[i] !== "(") {
        bytes.push(source.charCodeAt(i));
        continue;
      }
      bytes.push(0x28);
      const wide = source[i + 1] === "\uFEFF";
      for (i++; i < source.length && source[i] !== ")"; i++) {
        if (source[i] === "\\") i++;
        const code = source.charCodeAt(i);
        (wide ? [code >> 8, code & 255] : [code]).forEach((byte) => {
          if (byte === 0x28 || byte === 0x29 || byte === 0x5c) bytes.push(0x5c);
          bytes.push(byte);
        });
      }
      bytes.push(0x29);
    }
    return blockTree(Uint8Array.from(bytes));
  };
  const blockNode = (source) => blockFromSource(" /0 " + source).d[0][1];
  // The block of a document whose texts are all read from their layers, as Photoshop 2026
  // writes it, with no text in it yet: its two fonts (the second is the named styles'), its
  // sets for Japanese text, its named styles, its list styles, then the document's settings
  // (the quotes of each language among them) and its two default sheets.
  const BLOCK_FRESH = " /98 << /0 14 >> /0 <<" +
    " /1 << /0 [ << /0 << /99 /CoolTypeFont /0 << /0 (\uFEFFAdobeInvisFont) /2 0 >> >> >> << /0 << /99 /CoolTypeFont /0 << /0 (\uFEFFMyriadPro-Regular) /2 0 >> >> >> ] >>" +
    " /2 << /0 [ << /0 << /0 (\uFEFF) >> >> ] /1 [ << /0 0 >> ] >>" +
    " /3 << /0 [ << /0 << /0 (\uFEFFPhotoshop6MojiKumiSet4) /5 << /0 0 /3 2 >> >> >> << /0 << /0 (\uFEFFPhotoshop6MojiKumiSet3) /5 << /0 0 /3 4 >> >> >> << /0 << /0 (\uFEFFPhotoshop6MojiKumiSet2) /5 << /0 0 /3 3 >> >> >> << /0 << /0 (\uFEFFPhotoshop6MojiKumiSet1) /5 << /0 0 /3 1 >> >> >> << /0 << /0 (\uFEFFYakumonoHankaku) /5 << /0 0 /3 1 >> >> >> << /0 << /0 (\uFEFFGyomatsuYakumonoHankaku) /5 << /0 0 /3 3 >> >> >> << /0 << /0 (\uFEFFGyomatsuYakumonoZenkaku) /5 << /0 0 /3 4 >> >> >> << /0 << /0 (\uFEFFYakumonoZenkaku) /5 << /0 0 /3 2 >> >> >> << /0 << /0 (\uFEFFGyomatsuYakumonoZenkakuOrHankaku) /5 << /0 0 /3 5 >> >> >> ] /1 [ << /0 0 >> << /0 1 >> << /0 2 >> << /0 3 >> << /0 4 >> << /0 5 >> << /0 6 >> << /0 7 >> << /0 8 >> ] >>" +
    " /4 << /0 [ << /0 << /0 (\uFEFFNone) /5 << /0 (\uFEFF) /1 (\uFEFF) /2 (\uFEFF) /3 (\uFEFF) /4 0 >> >> >> << /0 << /0 (\uFEFFPhotoshopKinsokuHard) /5 << /0 (\uFEFF!\\),.:;?]}¢—’”‰℃℉、。々〉》」』】〕ぁぃぅぇぉっゃゅょゎ゛゜ゝゞァィゥェォッャュョヮヵヶ・ーヽヾ！％），．：；？］｝) /1 (\uFEFF\\([{£§‘“〈《「『【〒〔＃＄（＠［｛￥) /2 (\uFEFF—‥…) /3 (\uFEFF、。，．) /4 1 >> >> >> << /0 << /0 (\uFEFFPhotoshopKinsokuSoft) /5 << /0 (\uFEFF’”、。々〉》」』】〕ゝゞ・ヽヾ！），．：；？］｝) /1 (\uFEFF‘“〈《「『【〔（［｛) /2 (\uFEFF—‥…) /3 (\uFEFF、。，．) /4 2 >> >> >> << /0 << /0 (\uFEFFHard) /5 << /0 (\uFEFF!\\),.:;?]}¢—’”‰℃℉、。々〉》」』】〕ぁぃぅぇぉっゃゅょゎ゛゜ゝゞァィゥェォッャュョヮヵヶ・ーヽヾ！％），．：；？］｝) /1 (\uFEFF\\([{£§‘“〈《「『【〒〔＃＄（＠［｛￥) /2 (\uFEFF—‥…) /3 (\uFEFF、。，．) /4 1 >> >> >> << /0 << /0 (\uFEFFSoft) /5 << /0 (\uFEFF’”、。々〉》」』】〕ゝゞ・ヽヾ！），．：；？］｝) /1 (\uFEFF‘“〈《「『【〔（［｛) /2 (\uFEFF—‥…) /3 (\uFEFF、。，．) /4 2 >> >> >> << /0 << /0 (\uFEFFSoft_v2) /5 << /0 (\uFEFF’”、。々〉》」』】〕ゝゞ・ヽヾ！），．：；？］｝〵〟〙〗\\)]}⦆».,) /1 (\uFEFF‘“\\(〔[{〈《「『【⦅〘〖«〝（［｛〳〴) /2 (\uFEFF—‥…―) /3 (\uFEFF、。，．\u3000) /4 3 >> >> >> ] /1 [ << /0 0 >> << /0 1 >> << /0 2 >> << /0 3 >> << /0 4 >> << /0 5 >> ] >>" +
    " /5 << /0 [ << /0 << /0 (\uFEFFNormal RGB) /6 << /0 1 /1 12.0 /2 false /3 false /4 true /5 0.0 /6 1.0 /7 1.0 /8 0 /9 0.0 /10 0.0 /11 1 /12 0 /13 0 /14 0 /15 0 /16 0 /17 0.0 /18 true /19 false /20 false /21 false /22 false /23 false /24 false /25 false /26 false /27 false /28 false /29 false /30 0 /31 false /32 false /33 false /34 false /35 2 /36 0.0 /37 2 /38 0 /39 0 /40 false /41 2 /42 0 /43 << /0 .5 >> /44 2 /45 2 /46 7 /47 0 /48 0 /49 -1.0 /50 -1.0 /51 0 /52 false /53 << /99 /SimplePaint /0 << /0 1 /1 [ 1.0 0.0 0.0 0.0 ] >> >> /54 << /99 /SimplePaint /0 << /0 1 /1 [ 1.0 0.0 0.0 0.0 ] >> >> /55 << /99 /SimpleBlender >> /56 true /57 false /58 true /59 false /60 false /61 0 /62 0 /63 1.0 /64 4.0 /65 0.0 /66 [ ] /67 [ ] /68 0 /69 0 /70 0 /71 4 /72 0.0 /73 0.0 /74 false /75 false /76 false /77 true /78 true /79 << /99 /SimplePaint /0 << /0 1 /1 [ 1.0 1.0 1.0 0.0 ] >> >> /80 false /81 0 /82 3.0 /83 3.0 /84 false /85 0 /86 << /99 /SimpleCustomFeature >> /87 100.0 /88 true /91 8 /92 0.0 /95 << /0 0.0 /1 0 >> /96 true >> >> >> << /0 << /0 (\uFEFFNone) /5 0 /6 << >> >> >> ] /1 [ << /0 0 >> << /0 1 >> ] >>" +
    " /9 << /0 [ << /0 << /0 (\uFEFFkPredefinedNumericListStyleTag) /6 1 >> >> << /0 << /0 (\uFEFFkPredefinedUppercaseAlphaListStyleTag) /6 2 >> >> << /0 << /0 (\uFEFFkPredefinedLowercaseAlphaListStyleTag) /6 3 >> >> << /0 << /0 (\uFEFFkPredefinedUppercaseRomanNumListStyleTag) /6 4 >> >> << /0 << /0 (\uFEFFkPredefinedLowercaseRomanNumListStyleTag) /6 5 >> >> << /0 << /0 (\uFEFFkPredefinedBulletListStyleTag) /6 6 >> >> << /0 << /0 (\uFEFFkPredefinedDashBulletListStyleTag) /6 6 >> >> << /0 << /0 (\uFEFFkPredefinedEmptyCircleBulletListStyleTag) /6 6 >> >> << /0 << /0 (\uFEFFkPredefinedFilledSquareBulletListStyleTag) /6 6 >> >> << /0 << /0 (\uFEFFkPredefinedSingleZeroPrefixNumericListStyleTag) /6 7 >> >> << /0 << /0 (\uFEFFkPredefinedDoubleZeroPrefixNumericListStyleTag) /6 8 >> >> ] /1 [ << /0 0 >> << /0 1 >> << /0 2 >> << /0 3 >> << /0 4 >> << /0 5 >> << /0 6 >> << /0 7 >> << /0 8 >> << /0 9 >> << /0 10 >> ] >>" +
    " /6 << /0 [ << /0 << /0 (\uFEFFNormal RGB) /5 << /0 0 /1 0.0 /2 0.0 /3 0.0 /4 0.0 /5 0.0 /6 1 /7 1.2 /8 0 /9 true /10 6 /11 2 /12 2 /13 0 /14 36.0 /15 true /16 .5 /17 [ .8 1.0 1.33 ] /18 [ 0.0 0.0 0.0 ] /19 [ 1.0 1.0 1.0 ] /20 6 /21 false /22 0 /23 true /24 0 /25 0 /27 /nil /26 false /28 /nil /29 false /30 << >> /31 36.0 /32 << >> /33 0 /34 7 /35 1 /36 /nil /37 0 /38 false /39 0 /40 2 /41 0 /47 false /48 /nil >> >> >> ] /1 [ << /0 0 >> ] >>" +
    " /8 << /0 [ ] >>" +
    " >> /1 <<" +
    " /4 << /0 7 /1 11 /2 0 /3 (\uFEFFPhotoshop) >>" +
    " /0 << /0 << /0 3 /1 [ << /0 (\uFEFF ) /1 (\uFEFF1) >> << /0 (\uFEFF\r) /1 (\uFEFF6) >> << /0 (\uFEFF\t) /1 (\uFEFF0) >> << /0 (\uFEFF\u2029) /1 (\uFEFF5) >> << /0 (\uFEFF\u0003) /1 (\uFEFF5) >> << /0 (\uFEFF\u3000) /1 (\uFEFF1) >> << /0 (\uFEFF\u00ad) /1 (\uFEFF3) >> ] >> /1 0 /2 0 /3 .583 /4 .333 /5 .583 /6 .333 /7 .7 /8 true /9 [ << /0 0 /1 (\uFEFF“) /2 (\uFEFF”) /3 (\uFEFF‘) /4 (\uFEFF’) >> << /0 1 /1 (\uFEFF”) /2 (\uFEFF”) /3 (\uFEFF’) /4 (\uFEFF’) >> << /0 2 /1 (\uFEFF«) /2 (\uFEFF») /3 (\uFEFF‘) /4 (\uFEFF’) >> << /0 3 /1 (\uFEFF«) /2 (\uFEFF») /3 (\uFEFF‘) /4 (\uFEFF’) >> << /0 4 /1 (\uFEFF„) /2 (\uFEFF“) /3 (\uFEFF‚) /4 (\uFEFF‘) >> << /0 5 /1 (\uFEFF„) /2 (\uFEFF“) /3 (\uFEFF‚) /4 (\uFEFF‘) >> << /0 6 /1 (\uFEFF«) /2 (\uFEFF») /3 (\uFEFF‹) /4 (\uFEFF›) >> << /0 7 /1 (\uFEFF“) /2 (\uFEFF”) /3 (\uFEFF‘) /4 (\uFEFF’) >> << /0 8 /1 (\uFEFF«) /2 (\uFEFF») /3 (\uFEFF‘) /4 (\uFEFF’) >> << /0 9 /1 (\uFEFF«) /2 (\uFEFF») /3 (\uFEFF‘) /4 (\uFEFF’) >> << /0 10 /1 (\uFEFF“) /2 (\uFEFF”) /3 (\uFEFF‘) /4 (\uFEFF’) >> << /0 11 /1 (\uFEFF“) /2 (\uFEFF”) /3 (\uFEFF‘) /4 (\uFEFF’) >> << /0 12 /1 (\uFEFF“) /2 (\uFEFF”) /3 (\uFEFF‘) /4 (\uFEFF’) >> << /0 13 /1 (\uFEFF”) /2 (\uFEFF”) /3 (\uFEFF’) /4 (\uFEFF’) >> << /0 14 /1 (\uFEFF“) /2 (\uFEFF”) /3 (\uFEFF‘) /4 (\uFEFF’) >> << /0 15 /1 (\uFEFF“) /2 (\uFEFF”) /3 (\uFEFF‘) /4 (\uFEFF’) >> << /0 16 /1 (\uFEFF”) /2 (\uFEFF”) /3 (\uFEFF’) /4 (\uFEFF’) >> << /0 17 /1 (\uFEFF“) /2 (\uFEFF”) /3 (\uFEFF‘) /4 (\uFEFF’) >> << /0 18 /1 (\uFEFF«) /2 (\uFEFF») /3 (\uFEFF‘) /4 (\uFEFF’) >> << /0 19 /1 (\uFEFF«) /2 (\uFEFF») /3 (\uFEFF‘) /4 (\uFEFF’) >> << /0 20 /1 (\uFEFF„) /2 (\uFEFF“) /3 (\uFEFF‚) /4 (\uFEFF‘) >> << /0 21 /1 (\uFEFF„) /2 (\uFEFF“) /3 (\uFEFF‚) /4 (\uFEFF‘) >> << /0 22 /1 (\uFEFF„) /2 (\uFEFF“) /3 (\uFEFF‚) /4 (\uFEFF‘) >> << /0 23 /1 (\uFEFF„) /2 (\uFEFF”) /3 (\uFEFF‘) /4 (\uFEFF’) >> << /0 24 /1 (\uFEFF„) /2 (\uFEFF”) /3 (\uFEFF‚) /4 (\uFEFF’) >> << /0 25 /1 (\uFEFF«) /2 (\uFEFF») /3 (\uFEFF‹) /4 (\uFEFF›) >> << /0 26 /1 (\uFEFF“) /2 (\uFEFF”) /3 (\uFEFF‘) /4 (\uFEFF’) >> << /0 27 /1 (\uFEFF“) /2 (\uFEFF”) /3 (\uFEFF‘) /4 (\uFEFF’) >> << /0 28 /1 (\uFEFF„) /2 (\uFEFF”) /3 (\uFEFF’) /4 (\uFEFF’) >> << /0 29 /1 (\uFEFF〝) /2 (\uFEFF〞) >> << /0 30 /1 (\uFEFF「) /2 (\uFEFF」) >> << /0 31 /1 (\uFEFF„) /2 (\uFEFF“) /3 (\uFEFF‘) /4 (\uFEFF’) >> << /0 32 /1 (\uFEFF“) /2 (\uFEFF”) /3 (\uFEFF‘) /4 (\uFEFF’) >> << /0 33 /1 (\uFEFF„) /2 (\uFEFF“) /3 (\uFEFF‚) /4 (\uFEFF‘) >> << /0 34 /1 (\uFEFF«) /2 (\uFEFF») /3 (\uFEFF‘) /4 (\uFEFF’) >> << /0 35 /1 (\uFEFF“) /2 (\uFEFF”) /3 (\uFEFF‘) /4 (\uFEFF’) >> << /0 36 /1 (\uFEFF„) /2 (\uFEFF“) /3 (\uFEFF‚) /4 (\uFEFF‘) >> << /0 37 /1 (\uFEFF«) /2 (\uFEFF») /3 (\uFEFF‘) /4 (\uFEFF’) >> << /0 38 /1 (\uFEFF„) /2 (\uFEFF“) /3 (\uFEFF‚) /4 (\uFEFF‘) >> << /0 39 /1 (\uFEFF«) /2 (\uFEFF») /3 (\uFEFF<) /4 (\uFEFF>) >> << /0 40 /1 (\uFEFF„) /2 (\uFEFF“) /3 (\uFEFF‚) /4 (\uFEFF‘) >> << /0 41 /1 (\uFEFF«) /2 (\uFEFF») /3 (\uFEFF<) /4 (\uFEFF>) >> << /0 42 /1 (\uFEFF„) /2 (\uFEFF“) /3 (\uFEFF‚) /4 (\uFEFF‘) >> << /0 43 /1 (\uFEFF“) /2 (\uFEFF”) /3 (\uFEFF‘) /4 (\uFEFF’) >> << /0 44 /1 (\uFEFF«) /2 (\uFEFF») /3 (\uFEFF‹) /4 (\uFEFF›) >> << /0 45 /1 (\uFEFF“) /2 (\uFEFF”) /3 (\uFEFF‘) /4 (\uFEFF’) >> ] /15 << /0 (\uFEFF) >> /16 true /17 0 >>" +
    " /5 [ << /0 0 /1 << /0 7 /1 11 /2 0 /3 (\uFEFFPhotoshop) >> /2 (0010000001001001111011100011100011101100000010000110000000) /3 (01110) /4 [ ] >> ]" +
    " /1 [ ]" +
    " /2 << /0 1 /1 12.0 /2 false /3 false /4 true /5 0.0 /6 1.0 /7 1.0 /8 0 /9 0.0 /10 0.0 /11 1 /12 0 /13 0 /14 0 /15 0 /16 0 /17 0.0 /18 true /19 false /20 false /21 false /22 false /23 false /24 false /25 false /26 false /27 false /28 false /29 false /30 0 /31 false /32 false /33 false /34 false /35 2 /36 0.0 /37 2 /38 0 /39 0 /40 false /41 2 /42 0 /43 << /0 .5 >> /44 2 /45 2 /46 7 /47 0 /48 0 /49 -1.0 /50 -1.0 /51 0 /52 false /53 << /99 /SimplePaint /0 << /0 1 /1 [ 1.0 0.0 0.0 0.0 ] >> >> /54 << /99 /SimplePaint /0 << /0 1 /1 [ 1.0 0.0 0.0 0.0 ] >> >> /55 << /99 /SimpleBlender >> /56 true /57 false /58 true /59 false /60 false /61 0 /62 0 /63 1.0 /64 4.0 /65 0.0 /66 [ ] /67 [ ] /68 0 /69 0 /70 0 /71 4 /72 0.0 /73 0.0 /74 false /75 false /76 false /77 true /78 true /79 << /99 /SimplePaint /0 << /0 1 /1 [ 1.0 1.0 1.0 0.0 ] >> >> /80 false /81 0 /82 3.0 /83 3.0 /84 false /85 0 /86 << /99 /SimpleCustomFeature >> /87 100.0 /88 true /91 8 /92 0.0 /95 << /0 0.0 /1 0 >> /96 true >>" +
    " /3 << /0 0 /1 0.0 /2 0.0 /3 0.0 /4 0.0 /5 0.0 /6 1 /7 1.2 /8 0 /9 true /10 6 /11 2 /12 2 /13 0 /14 36.0 /15 true /16 .5 /17 [ .8 1.0 1.33 ] /18 [ 0.0 0.0 0.0 ] /19 [ 1.0 1.0 1.0 ] /20 6 /21 false /22 0 /23 true /24 0 /25 0 /27 /nil /26 false /28 /nil /29 false /30 << >> /31 36.0 /32 << >> /33 0 /34 7 /35 1 /36 /nil /37 0 /38 false /39 0 /40 2 /41 0 /47 false /48 /nil >>" +
    " >>";
  // What a layer's data says of a run of letters and of a paragraph, as textToPsd and the
  // PSD library write them. Photoshop gives each of these a key in the block; a text with
  // anything else gets no entry (it is read from its layer, as before).
  const BLOCK_STYLE = { fontSize: [1, "real"], fauxBold: [2], fauxItalic: [3], autoLeading: [4], leading: [5, "real"], horizontalScale: [6, "real"], verticalScale: [7, "real"], tracking: [8], baselineShift: [9, "real"], fontCaps: [12], fontBaseline: [13], strikethrough: [15, "flag"], underline: [16, "flag"], ligatures: [18], dLigatures: [19], fillColor: [53, "paint"], strokeColor: [54, "paint"], strokeFlag: [57], fillFirst: [58], outlineWidth: [63, "real"] };
  const BLOCK_STYLE_ALSO = ["font", "autoKerning", "kerning", "language"];
  const BLOCK_PARAGRAPH = { justification: "left", firstLineIndent: 0, startIndent: 0, endIndent: 0, spaceBefore: 0, spaceAfter: 0, autoHyphenate: true, hyphenatedWordSize: 6, preHyphen: 2, postHyphen: 2, consecutiveHyphens: 8, zone: 36, autoLeading: 1.2, leadingType: 0, hanging: false };
  const BLOCK_JUSTIFY = { left: 0, right: 1, center: 2 };
  const BLOCK_TEXT = ["text", "transform", "antiAlias", "shapeType", "style", "paragraphStyle", "boxBounds", "warp", "styleRuns"];
  // The anti-aliasing has a key in an entry too, but for Smooth (seen in the files of three
  // versions of Photoshop for these four)
  const BLOCK_ANTI_ALIAS = { crisp: 1, strong: 2, smooth: 3, sharp: 4 };
  const blockValue = (value, kind) => {
    if (kind === "real") return blockReal(value);
    if (kind === "flag") return value ? "1" : "0";
    if (kind === "paint") return `<< /99 /SimplePaint /0 << /0 1 /1 [ 1.0 ${blockReal(value.r / 255)} ${blockReal(value.g / 255)} ${blockReal(value.b / 255)} ] >> >>`;
    return typeof value === "boolean" ? String(value) : blockWhole(value);
  };
  // A text's entry: its characters, its paragraphs, its runs of letters and the pairs kerned
  // by hand, with `fontAt(name)` the font's place in the block. `said`: what the block alone
  // says, or says its own way, letter by letter (see blockSaysOf). The block says a pair's
  // kerning on its first letter, the layer's data on its second: Photoshop moves both one
  // letter back, a hand kerning's number from the first letter of its run only.
  // Null for a text with something Photoshop's own conversion was not read for.
  const blockModel = (text, said, fontAt) => {
    const smoothing = BLOCK_ANTI_ALIAS[text.antiAlias];
    if (Object.keys(text).some((key) => !BLOCK_TEXT.includes(key)) || (text.shapeType !== "box" && text.shapeType !== "point") || !smoothing) return null;
    const value = String(text.text || "").replace(/\r?\n/g, "\r") + "\r";
    const paragraph = Object.assign({}, BLOCK_PARAGRAPH, text.paragraphStyle);
    if (Object.keys(paragraph).some((key) => !(key in BLOCK_PARAGRAPH)) || BLOCK_JUSTIFY[paragraph.justification] === undefined) return null;
    // The runs as the layer's data has them: each over the text's own style, the last one
    // with the closing return, the text's own style for what they leave
    const base = Object.assign({ kerning: 0, autoKerning: true, fillColor: { r: 0, g: 0, b: 0 } }, text.style);
    const given = text.styleRuns && text.styleRuns.length ? text.styleRuns : [{ length: value.length, style: {} }];
    const styles = [];
    const starts = new Set();
    let left = value.length;
    given.forEach((run, k) => {
      let length = Math.min(run.length, left);
      left -= length;
      if (!length) return;
      if (left === 1 && k === given.length - 1) {
        length++;
        left--;
      }
      starts.add(styles.length);
      const style = Object.assign({}, base, run.style);
      for (let i = 0; i < length; i++) styles.push(style);
    });
    if (left) starts.add(styles.length);
    while (styles.length < value.length) styles.push(base);
    const known = (style) => Object.keys(style).every((key) => {
      if (style[key] === undefined || BLOCK_STYLE_ALSO.includes(key)) return true;
      const entry = BLOCK_STYLE[key];
      return Boolean(entry) && (entry[1] !== "paint" || (style[key].r !== undefined && style[key].a === undefined));
    });
    if (!styles.every(known) || styles.some((style) => !style.font || !style.font.name)) return null;
    const sheet = (at) => {
      const style = styles[at];
      const next = Math.min(at + 1, value.length - 1);
      const pair = styles[next].autoKerning === false ? 0 : said.optical[next] ? 2 : 1;
      const keys = [[0, String(fontAt(style.font.name))]];
      Object.keys(BLOCK_STYLE).forEach((name) => {
        if (style[name] !== undefined) keys.push([BLOCK_STYLE[name][0], blockValue(style[name], BLOCK_STYLE[name][1])]);
      });
      keys.push([11, String(pair)], [14, "0"], [20, String(Boolean(said.alternates[at]))], [38, blockWhole(said.language[at])], [92, "0.0"]);
      return "<< " + keys.sort((a, b) => a[0] - b[0]).map(([key, word]) => `/${key} ${word}`).join(" ") + " >>";
    };
    const runs = [];
    for (let at = 0; at < value.length; at++) {
      const source = sheet(at);
      const last = runs[runs.length - 1];
      if (last && last.source === source) last.length++;
      else runs.push({ source, length: 1 });
    }
    const kerned = [];
    for (let at = 0; at + 1 < value.length; at++) {
      const number = starts.has(at + 1) ? styles[at + 1].kerning || 0 : 0;
      const last = kerned[kerned.length - 1];
      if (!number && last && !last.number) last.length++;
      else kerned.push({ number, length: 1 });
    }
    // The closing return goes with the last stretch that has no number
    if (kerned.length && !kerned[kerned.length - 1].number) kerned[kerned.length - 1].length++;
    else kerned.push({ number: 0, length: 1 });
    const properties = `<< /0 ${BLOCK_JUSTIFY[paragraph.justification]} /1 ${blockReal(paragraph.firstLineIndent)} /2 ${blockReal(paragraph.startIndent)} /3 ${blockReal(paragraph.endIndent)} /4 ${blockReal(paragraph.spaceBefore)} /5 ${blockReal(paragraph.spaceAfter)} /7 ${blockReal(paragraph.autoLeading)} /8 ${blockWhole(paragraph.leadingType)} /9 ${Boolean(paragraph.autoHyphenate)} /10 ${blockWhole(paragraph.hyphenatedWordSize)} /11 ${blockWhole(paragraph.preHyphen)} /12 ${blockWhole(paragraph.postHyphen)} /13 ${blockWhole(paragraph.consecutiveHyphens)} /14 ${blockReal(paragraph.zone)} /17 [ .8 1.0 1.33 ] /18 [ 0.0 0.0 0.0 ] /19 [ 1.0 1.0 1.0 ] /21 ${Boolean(paragraph.hanging)} /23 true /24 0 /25 0 /29 false >>`;
    const paragraphs = value.split("\r").slice(0, -1).map((line) => `<< /0 << /0 << /0 ${blockQuoted("")} /5 ${properties} /6 0 >> >> /1 ${line.length + 1} >>`);
    return "<< /0 " + blockQuoted(value)
      + ` /5 << /0 [ ${paragraphs.join(" ")} ] >>`
      + ` /6 << /0 [ ${runs.map((run) => `<< /0 << /0 << /0 ${blockQuoted("")} /5 0 /6 ${run.source} >> >> /1 ${run.length} >>`).join(" ")} ] >>`
      + (kerned.some((run) => run.number) ? ` /8 << /0 [ ${kerned.map((run) => `<< /0 <<${run.number ? ` /0 ${blockWhole(run.number)}` : ""} >> /1 ${run.length} >>`).join(" ")} ] >>` : "")
      + (smoothing !== BLOCK_ANTI_ALIAS.smooth ? ` /10 << /0 ${smoothing} /2 true >>` : "")
      + " >>";
  };
  // The frame a text is set in: a point, or its box as a path of four sides. `fresh`: as
  // Photoshop writes them since the block's version 14
  const blockFrame = (text, fresh) => {
    const last = fresh ? " /22 .025" : "";
    if (text.shapeType !== "box") return `<< /0 << /2 << /6 [ -1.0 -1.0 ] /11 << /4 -1 /18 -1.0${last} >> >> >> >>`;
    const [left, top, right, bottom] = (text.boxBounds || [0, 0, 0, 0]).map(blockReal);
    const corners = [[left, top], [right, top], [right, bottom], [left, bottom], [left, top]];
    const path = [];
    for (let k = 0; k < 4; k++) path.push(...corners[k], ...corners[k], ...corners[k + 1], ...corners[k + 1]);
    return `<< /0 << /1 << /0 [ ${path.join(" ")} ] >> /2 << /0 1 /6 [ -2.0 -2.0 ] /10 << /0 2 /1 0.0 >> /11 << /4 -2 /18 -2.0${last} >> >> >> >>`;
  };
  // What the block alone says of a text set here, place by place in the text as the file has
  // it (its letters, then the closing return): in Optical, with its Contextual alternates,
  // and its language, which the block numbers its own way (Croatian is 29 in a layer's data
  // and 31 here, where 29 is Chinese: read back from files Photoshop 2026 saved)
  const blockSaysOf = (layer, text) => {
    const lt = layer.params.layerText;
    const length = String(lt.textKey || "").length;
    const ranges = lt.textStyleRange || [];
    const of = (style) => ({ optical: Boolean(style) && style.autoKern === "opticalKern" && !style.kerning, alternates: !style || style.contextualLigatures !== false, language: PS().textLanguageBlockNumber(style && style.textLanguage) });
    const optical = [];
    const alternates = [];
    const language = [];
    // One style for the whole text, as textToPsd writes it when the runs don't cover it
    const whole = text.styleRuns ? null : of(ranges[0] && ranges[0].textStyle);
    for (let at = 0; at < length; at++) {
      const range = whole ? null : ranges.find((item) => at >= item.from && at < item.to);
      const here = whole || of(range && range.textStyle);
      optical.push(here.optical);
      alternates.push(here.alternates);
      language.push(here.language);
    }
    const end = whole || (length ? { optical: optical[length - 1], alternates: alternates[length - 1], language: language[length - 1] } : of(ranges[0] && ranges[0].textStyle));
    optical.push(end.optical);
    alternates.push(end.alternates);
    language.push(end.language);
    return { optical, alternates, language };
  };
  const base64Of = (bytes) => {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  };
  // Puts the file's text block in order, in `root.engineData`. `written`: the text layers
  // TypeR wrote (not Photoshop's own, gone back as they came), each with the layer it is of.
  // - No text written here: the file's block, if it had one, as it was.
  // - A text written here: its entry takes the place of the one it had, or comes last, in
  //   the file's block or in a new one. Nothing else moves: an entry counts on its place.
  // - A text written here that an entry can't be written for (see blockModel): it is
  //   numbered -1; the file's block stays as it was, with the entries of the texts left alone.
  // A text left alone whose entry is not of its own characters (a layer that came from
  // another document) is numbered -1 too.
  // False when the file goes without a block: Photoshop then reads every text from its layer.
  const textBlockOut = (root, written) => {
    const had = typeof root.engineData === "string" && root.engineData ? root.engineData : null;
    if (!written.size) return Boolean(had);
    const nodes = [];
    const collect = (list) => (list || []).forEach((node) => {
      if (node.text) nodes.push(node);
      collect(node.children);
    });
    collect(root.children);
    const unnumbered = (node) => {
      node.text = Object.assign({}, node.text, { index: -1 });
    };
    try {
      const block = had ? blockOf(root) : blockFromSource(BLOCK_FRESH);
      const models = dig(block, "1", "1").l;
      const frames = dig(block, "0", "8", "0").l;
      const fonts = dig(block, "0", "1", "0").l;
      const fresh = wordOf(dig(block, "98", "0")) >= 14;
      const fontAt = (name) => {
        const at = fonts.findIndex((font) => stringOf(dig(font, "0", "0", "0")) === name && !dig(font, "0", "0", "3"));
        if (at >= 0) return at;
        fonts.push(blockNode(`<< /0 << /99 /CoolTypeFont /0 << /0 ${blockQuoted(name)} /2 0 >> >> >>`));
        return fonts.length - 1;
      };
      // The entries the texts left alone still count on
      const kept = new Set();
      nodes.forEach((node) => {
        if (written.has(node)) return;
        const at = node.text.index;
        const own = had && Number.isInteger(at) && at >= 0 && at < models.length && blockHas(stringOf(dig(models[at], "0", "0")), String(node.text.text || "").replace(/\r?\n/g, "\r"));
        if (own) kept.add(at);
        else unnumbered(node);
      });
      const made = [];
      written.forEach((layer, node) => {
        const said = blockSaysOf(layer, node.text);
        const source = blockModel(node.text, said, fontAt);
        if (source) made.push({ node, layer, model: blockNode(source), frame: blockNode(blockFrame(node.text, fresh)) });
        else unnumbered(node);
      });
      // Nothing to add: the file's block as it was, or none
      if (!made.length) {
        if (!had) delete root.engineData;
        return Boolean(had);
      }
      // How many entries use each frame: one of its own is written over, with its entry
      const framed = new Map();
      models.forEach((model) => listAt(model, "1", "0").forEach((frame) => {
        const at = wordOf(dig(frame, "0"));
        framed.set(at, (framed.get(at) || 0) + 1);
      }));
      made.forEach(({ node, layer, model, frame }) => {
        const was = had && layer.raw && layer.raw.text ? layer.raw.text.index : -1;
        let at = models.length;
        let frameAt = frames.length;
        if (Number.isInteger(was) && was >= 0 && was < models.length && !kept.has(was)) {
          at = was;
          const own = listAt(models[was], "1", "0").map((item) => wordOf(dig(item, "0")));
          if (own.length === 1 && Number.isInteger(own[0]) && own[0] >= 0 && own[0] < frames.length && framed.get(own[0]) === 1) frameAt = own[0];
        }
        kept.add(at);
        frames[frameAt] = frame;
        models[at] = { d: [["0", model], ["1", blockNode(`<< /0 [ << /0 ${frameAt} >> ] >>`)]] };
        node.text.index = at;
      });
      root.engineData = base64Of(blockBytes(block));
      return true;
    } catch (error) {
      // As before: without a block, Photoshop reads every text from its layer
      console.warn("TypeR web: could not write the document's text block", error);
      delete root.engineData;
      return false;
    }
  };

  // One stroke for the file, over the file's own entry if it had one: what TypeR doesn't know
  // of it (its blend mode…) stays. Switched off in TypeR, it is kept hidden, as Photoshop does.
  // `gradient`: Fill Type Gradient, TypeR's { stops, style, angle, scale, reverse }; what TypeR
  // doesn't set (Align with Layer, its offset, dither) stays the file's, or Photoshop's defaults
  const strokeToPsd = (stroke, size = stroke.size, color = stroke.color, position = POSITION_OUT[stroke.position] || "outside", opacity = stroke.opacity, entry = null, gradient = null) => {
    const out = Object.assign({}, entry, {
      enabled: stroke.enabled !== false,
      size: { units: "Pixels", value: size },
      position,
      fillType: gradient ? "gradient" : "color",
      opacity: (opacity === undefined ? 100 : opacity) / 100,
      blendMode: (entry && entry.blendMode) || "normal",
    });
    delete out.pattern;
    // The colour stays with a gradient, as Photoshop keeps it, for Fill Type Color
    out.color = { r: color.r, g: color.g, b: color.b };
    if (!gradient) {
      delete out.gradient;
      return out;
    }
    const was = entry && entry.gradient && entry.gradient.type === "solid" ? entry.gradient : null;
    const kept = {};
    ["dither", "interpolationMethod", "align", "offset"].forEach((key) => { if (was && was[key] !== undefined) kept[key] = was[key]; });
    out.gradient = Object.assign({ align: true, dither: false, offset: { x: 0, y: 0 } }, kept, gradientOut(gradient.stops, was), {
      style: gradient.style || "linear",
      angle: gradient.angle === undefined ? 90 : gradient.angle,
      scale: (gradient.scale === undefined ? 100 : gradient.scale) / 100,
      reverse: Boolean(gradient.reverse),
    });
    return out;
  };

  // Photoshop draws the first stroke of a list on top: the stroke around the stroke is a
  // wider one under it, at its own Opacity. `taken`: the file's entries they came from.
  const strokesToPsd = (stroke, taken) => {
    const list = [strokeToPsd(stroke, stroke.size, stroke.color, undefined, stroke.opacity, taken && taken.stroke, stroke.fill === "gradient" && stroke.gradient ? stroke.gradient : null)];
    if (stroke.outer && stroke.outer.size > 0) list.push(strokeToPsd(stroke, PS().strokeReach(stroke), stroke.outer.color, "outside", stroke.outer.opacity === undefined ? 100 : stroke.outer.opacity, taken && taken.around));
    return list;
  };

  // A text's or a folder's stroke into its node. While TypeR's still says what it took in, the
  // file's strokes stay exactly as they were. Else TypeR's go where those it took in were, and
  // the file's others (a third, a hidden one, a gradient's) stay with them: only a stroke
  // taken off in TypeR leaves the file.
  const strokesOut = (node, layer) => {
    const effects = layer.raw && layer.raw.effects;
    const now = layer.stroke && layer.stroke.size > 0 ? layer.stroke : null;
    if (sameValue(strokeFromEffects(effects), now)) return;
    const list = (effects && effects.stroke) || [];
    const taken = strokesTakenIn(effects);
    const mine = taken ? [taken.stroke, taken.around].filter(Boolean) : [];
    const others = list.filter((entry) => !mine.includes(entry));
    const at = mine.length ? Math.min(...mine.map((entry) => list.indexOf(entry))) : 0;
    const strokes = others.slice(0, at).concat(now ? strokesToPsd(now, taken) : [], others.slice(at));
    if (!strokes.length && !(node.effects && node.effects.stroke)) return;
    node.effects = Object.assign({}, node.effects);
    if (strokes.length) node.effects.stroke = strokes;
    else delete node.effects.stroke;
  };

  // What Photoshop's dialog sets in an effect TypeR adds where the file had none
  const LINEAR = { name: "Linear", curve: [{ x: 0, y: 0 }, { x: 255, y: 255 }] };
  const FX_FRESH = {
    dropShadow: { useGlobalLight: false, antialiased: false, contour: LINEAR, noise: 0, layerConceals: true },
    innerShadow: { useGlobalLight: false, antialiased: false, contour: LINEAR, noise: 0 },
    outerGlow: { technique: "softer", range: 0.5, jitter: 0, antialiased: false, contour: LINEAR, noise: 0 },
    innerGlow: { technique: "softer", source: "edge", range: 0.5, jitter: 0, antialiased: false, contour: LINEAR, noise: 0 },
    colorOverlay: {},
    gradientOverlay: { align: true, dither: false, offset: { x: 0, y: 0 } },
  };
  const pixels = (value) => ({ units: "Pixels", value: round(value || 0, 2) });
  const gradientOut = (stops, was) => {
    const sorted = (stops || []).slice().sort((a, b) => a.at - b.at);
    return {
      type: "solid",
      name: (was && was.type === "solid" && was.name) || "Custom",
      // Photoshop's 100% smooths the colours between stops; TypeR mixes them evenly, as 0% does
      smoothness: was && was.type === "solid" && was.smoothness !== undefined ? was.smoothness : 0,
      colorStops: sorted.map((stop) => ({ color: { r: stop.r, g: stop.g, b: stop.b }, location: stop.at, midpoint: 0.5 })),
      opacityStops: sorted.map((stop) => ({ opacity: stop.a === undefined ? 1 : stop.a, location: stop.at, midpoint: 0.5 })),
    };
  };
  // One effect for the file: TypeR's settings over the file's own entry, field by field, so what
  // TypeR doesn't know (contour, noise, a blend mode it can't draw…) stays when unchanged
  const fxEntryOut = (name, ours, theirs, entry, scale) => {
    const out = Object.assign({}, entry || FX_FRESH[name]);
    const changed = (field) => !theirs || !sameValue(ours[field], theirs[field]);
    out.enabled = ours.enabled !== false;
    if (changed("blend")) out.blendMode = ours.blend || "normal";
    if ("color" in fxDefaultsOf(name) && changed("color")) {
      const color = ours.color || { r: 0, g: 0, b: 0 };
      out.color = { r: color.r, g: color.g, b: color.b };
    }
    if (changed("opacity")) out.opacity = (ours.opacity === undefined ? 100 : ours.opacity) / 100;
    if (name === "gradientOverlay") {
      if (changed("stops")) out.gradient = gradientOut(ours.stops, entry && entry.gradient);
      if (changed("style")) out.type = ours.style || "linear";
      if (changed("angle")) out.angle = ours.angle || 0;
      if (changed("scale")) out.scale = (ours.scale === undefined ? 100 : ours.scale) / 100;
      if (changed("reverse")) out.reverse = Boolean(ours.reverse);
      return out;
    }
    if ((name === "dropShadow" || name === "innerShadow") && changed("angle")) {
      out.angle = ours.angle || 0;
      out.useGlobalLight = false;
    }
    if ((name === "dropShadow" || name === "innerShadow") && changed("distance")) out.distance = pixels((ours.distance || 0) / scale);
    // Layer Knocks Out Drop Shadow: on unless TypeR's says off
    if (name === "dropShadow" && changed("knockout")) out.layerConceals = ours.knockout !== false;
    if (name !== "colorOverlay" && changed("size")) out.size = pixels((ours.size || 0) / scale);
    // Spread and choke are percents, which Photoshop keeps in a field of pixels
    const amount = name === "dropShadow" || name === "outerGlow" ? "spread" : "choke";
    if (name !== "colorOverlay" && changed(amount)) out.choke = pixels(ours[amount] || 0);
    return out;
  };
  const fxDefaultsOf = (name) => PS().FX_DEFAULTS[name] || {};
  const globalAngleOf = (doc) => {
    const resources = doc.psd && doc.psd.source && doc.psd.source.imageResources;
    return resources ? resources.globalAngle : undefined;
  };
  // A text's effects into its node. The file's own stay exactly as they were when TypeR's
  // still say the same; else each one TypeR changed is written, one taken off is switched
  // off. Then Photoshop draws them as TypeR does: a mask hides them too, and in another blend
  // mode than Normal, the inner ones blend with the letters first.
  const effectsOut = (node, layer, doc) => {
    const raw = layer.raw && layer.raw.effects;
    const globalAngle = globalAngleOf(doc);
    const was = effectsFromPsd(raw, globalAngle);
    const now = layer.effects && Object.keys(layer.effects).length ? layer.effects : undefined;
    if (sameValue(was, now)) return;
    const effects = Object.assign({}, node.effects);
    const scale = raw && raw.scale > 0 ? raw.scale : 1;
    // Everything was switched off at once: what TypeR switches on comes back alone
    const flip = Boolean(raw && raw.disabled) && FX_NAMES.some((name) => now && now[name] && now[name].enabled !== false);
    if (flip) {
      delete effects.disabled;
      Object.keys(effects).forEach((key) => {
        const value = effects[key];
        if (key === "stroke" || !value || typeof value !== "object") return;
        effects[key] = Array.isArray(value) ? value.map((entry) => Object.assign({}, entry, { enabled: false })) : Object.assign({}, value, { enabled: false });
      });
    }
    FX_NAMES.forEach((name) => {
      const key = FX_IN_FILE[name];
      const list = FX_LISTS.has(key);
      const entries = list && Array.isArray(effects[key]) ? effects[key] : null;
      const entry = list ? entries && entries[0] : effects[key];
      const ours = now && now[name];
      const theirs = was && was[name];
      if (sameValue(ours, theirs)) return;
      // Field by field against what the file had, even when it hid them all: a blend mode TypeR
      // draws as Normal stays the file's own
      let next = null;
      if (ours) next = fxEntryOut(name, ours, theirs, entry, scale);
      else if (entry) next = Object.assign({}, entry, { enabled: false });
      if (!next) return;
      effects[key] = list ? [next].concat(entries ? entries.slice(1) : []) : next;
    });
    node.effects = effects;
    const shown = PS().effectsOn(layer);
    if (!shown) return;
    if ((layer.blend || "normal") !== "normal" && ["innerShadow", "innerGlow", "colorOverlay", "gradientOverlay"].some((name) => shown[name] && shown[name].enabled !== false)) node.blendInteriorElements = true;
    if (layer.mask) node.layerMaskAsGlobalMask = true;
    if (layer.vectorMask) node.vectorMaskAsGlobalMask = true;
  };

  const commonOut = (layer) => {
    const node = Object.assign({}, layer.raw || {});
    delete node.imageData;
    node.name = layer.name;
    node.hidden = layer.visible === false;
    node.opacity = layer.opacity === undefined ? 1 : layer.opacity;
    node.blendMode = layer.blend || (layer.kind === "group" ? "pass through" : "normal");
    if (layer.clipping) node.clipping = true;
    else delete node.clipping;
    // The other locks Photoshop had stay as they were
    if (layer.locked && !lockedIn(node)) node.protected = Object.assign({}, node.protected, { transparency: true, composite: true, position: true, all: true });
    else if (!layer.locked && lockedIn(node) && !(layer.isBackground && !node.protected.all)) node.protected = { transparency: Boolean(layer.locks && layer.locks.transparency), composite: Boolean(layer.locks && layer.locks.pixels), position: Boolean(layer.locks && layer.locks.position) };
    else if (!layer.locked && !lockedIn(node)) {
      const locks = layer.locks || {};
      const had = node.protected || {};
      if (Boolean(locks.transparency) !== Boolean(had.transparency) || Boolean(locks.pixels) !== Boolean(had.composite) || Boolean(locks.position) !== Boolean(had.position)) {
        node.protected = Object.assign({}, had, { transparency: Boolean(locks.transparency), composite: Boolean(locks.pixels), position: Boolean(locks.position), all: false });
      }
    }
    if (layer.color || node.layerColor) node.layerColor = layer.color || "none";
    if (layer.link || node.linkGroup) node.linkGroup = layer.link && layer.link < 65536 ? layer.link : 0;
    // Fill: 0 for a hollow text, written below for its kind
    const amount = PS().fillOf(layer);
    if (amount > 0 && amount < 1) node.fillOpacity = amount;
    else if (amount === 1 && node.fillOpacity !== undefined && node.fillOpacity !== 0) node.fillOpacity = 1;
    else if (amount === 0) node.fillOpacity = 0;
    return node;
  };

  const place = (node, canvas, left, top) => {
    canvas = PS().asCanvas(canvas);
    node.canvas = canvas;
    node.left = left;
    node.top = top;
    node.right = left + canvas.width;
    node.bottom = top + canvas.height;
  };

  // The layer's masks into the node, unless its pixels go back into the file untouched
  const masksOut = (node, layer, doc) => {
    if (node.typerRaw) return node;
    delete node.mask;
    delete node.realMask;
    delete node.vectorMask;
    return Object.assign(node, PS().ops.masksForFile(layer, doc));
  };
  const nodeFor = (layer, doc, flags) => masksOut(nodeBody(layer, doc, flags), layer, doc);
  const nodeBody = (layer, doc, flags) => {
    const engine = PS();
    const node = commonOut(layer);
    if (layer.kind === "group") {
      node.opened = layer.open !== false;
      // An SFX's outline goes around the whole folder, as Photoshop does since CS6
      strokesOut(node, layer);
      // Its shadows, glows and overlays given or changed here, as a text's
      effectsOut(node, layer, doc);
      // Fill at 0%: a hollow text (an SFX's), or one set to 0
      if (layer.knockout || PS().fillOf(layer) === 0) node.fillOpacity = 0;
      else if (node.fillOpacity === 0) node.fillOpacity = 1;
      return node;
    }
    if (layer.kind === "text") {
      if (layer.raster && !layer.raster.strokeDrawnIn && layer.raw && layer.raw.text) {
        // Not edited: Photoshop's own text and pixels, only moved if the user moved it
        const moveX = layer.raster.left - (layer.raw.left || 0);
        const moveY = layer.raster.top - (layer.raw.top || 0);
        place(node, layer.raster.bitmap, layer.raster.left, layer.raster.top);
        if (!moveX && !moveY && layer.raster.bitmap === layer.raw.canvas && (layer.mask || null) === pixelMaskOf(layer.raw) && (layer.vectorMask || null) === vectorMaskOf(layer.raw)) node.typerRaw = rawParts.get(layer.raw);
        if (moveX || moveY) {
          const transform = (layer.raw.text.transform || [1, 0, 0, 1, 0, 0]).slice();
          transform[4] += moveX;
          transform[5] += moveY;
          node.text = Object.assign({}, layer.raw.text, { transform });
        }
        // Its effects changed in TypeR go into the layer's record: its pixels stay the file's
        effectsOut(node, layer, doc);
        return node;
      }
      flags.editedText = true;
      node.text = textToPsd(layer, doc);
      // What the document's text block may have to say of it (see textBlockOut)
      if (flags.written) flags.written.set(node, layer);
      // A text's pixels are only its letters, even a hollow one's, which Photoshop hides at
      // Fill 0%: Photoshop draws the layer style's stroke and effects around them
      // As opaque as the letters cover them (`unblended`): Photoshop blends them itself
      const visual = engine.visualOf(Object.assign({}, layer, { mask: null, vectorMask: null, fill: undefined, knockout: false, stroke: null, effects: undefined, raster: null, filters: undefined, unblended: true }), doc);
      if (visual) place(node, visual.canvas, visual.x, visual.y);
      // Fill at 0%: a hollow text (an SFX's), or one set to 0
      if (layer.knockout || PS().fillOf(layer) === 0) node.fillOpacity = 0;
      else if (node.fillOpacity === 0) node.fillOpacity = 1;
      strokesOut(node, layer);
      effectsOut(node, layer, doc);
      return node;
    }
    const painted = (layer.paint && layer.paint.length) || layer.dx || layer.dy;
    if (painted || !layer.raw) {
      // Its pixels whole, even at Fill 0%: the file says the Fill beside them
      const clean = Object.assign({}, layer, { mask: null, vectorMask: null, fill: undefined, knockout: false, stroke: null, effects: undefined });
      const visual = engine.visualOf(clean, doc);
      if (visual) place(node, visual.canvas, visual.x, visual.y);
      else delete node.canvas;
    } else if (layer.bitmap === (layer.raw.canvas || null) && (layer.left || 0) === (layer.raw.left || 0) && (layer.top || 0) === (layer.raw.top || 0) && (layer.mask || null) === pixelMaskOf(layer.raw) && (layer.vectorMask || null) === vectorMaskOf(layer.raw)) node.typerRaw = rawParts.get(layer.raw);
    // A style given here (the Styles panel): its stroke and effects, as a text's. The file's
    // own stay as they were while TypeR's still say the same.
    if (!layer.adjustment) {
      strokesOut(node, layer);
      effectsOut(node, layer, doc);
      // Fill back from the file's 0%: a hollow shape whose style was cleared here
      if (node.fillOpacity === 0 && PS().fillOf(layer) > 0) node.fillOpacity = PS().fillOf(layer);
    }
    return node;
  };

  // A smart text's layer (see "smart objects" above). Untouched since the file was opened, it
  // goes back as it came, with the file it stands for. Else it is made again: `typerSmart` is
  // the PSD it holds, which `write` encodes and puts in the file's linkedFiles.
  const smartNodeFor = (layer, doc, flags) => {
    const engine = PS();
    const from = layer.smart && layer.smart.node;
    const outerOf = () => {
      const node = commonOut(Object.assign({}, layer, { raw: from || null, fill: undefined, knockout: false }));
      delete node.text;
      return node;
    };
    if (smartKept(layer, doc)) {
      const node = outerOf();
      // Its opacity in its own file stays there
      if (layer.smart.inside !== 1) node.opacity = from.opacity === undefined ? 1 : from.opacity;
      if ((layer.mask || null) === pixelMaskOf(from) && (layer.vectorMask || null) === vectorMaskOf(from)) node.typerRaw = rawParts.get(from);
      return masksOut(node, layer, doc);
    }
    // What it holds: the text alone, with its stroke, its effects and its Fill
    const inside = Object.assign({}, layer, { filters: undefined, smart: undefined, opacity: 1, blend: "normal", clipping: false, visible: true, mask: null, vectorMask: null, locked: false, locks: undefined, color: undefined, link: undefined });
    const contents = engine.flatVisual(engine.smartContents(layer, doc));
    // A text with nothing to show has no picture to be a smart object of
    if (!contents || !contents.canvas || !contents.canvas.width || !contents.canvas.height) return nodeFor(Object.assign({}, layer, { filters: undefined }), doc, flags);
    const left = Math.floor(contents.x);
    const top = Math.floor(contents.y);
    const width = Math.ceil(contents.x + contents.canvas.width) - left;
    const height = Math.ceil(contents.y + contents.canvas.height) - top;
    const composite = engine.newCanvas(width, height);
    composite.getContext("2d").drawImage(contents.canvas, contents.x - left, contents.y - top);
    const innerFlags = { editedText: false };
    const text = nodeFor(inside, doc, innerFlags);
    // In its own file, the text is where the smart object's corner makes it
    if (text.left !== undefined) Object.assign(text, { left: text.left - left, top: text.top - top, right: text.right - left, bottom: text.bottom - top });
    const transform = ((text.text && text.text.transform) || [1, 0, 0, 1, 0, 0]).slice();
    transform[4] -= left;
    transform[5] -= top;
    text.text = Object.assign({}, text.text, { transform });
    const kept = (layer.smart && layer.smart.source) || {};
    const imageResources = Object.assign({}, kept.imageResources, {
      resolutionInfo: { horizontalResolution: doc.resolution, horizontalResolutionUnit: "PPI", widthUnit: "Inches", verticalResolution: doc.resolution, verticalResolutionUnit: "PPI", heightUnit: "Inches" },
    });
    delete imageResources.thumbnail;
    delete imageResources.thumbnailRaw;
    // Effects lit by the Global Light keep the page's angle in there
    const pageResources = doc.psd && doc.psd.source && doc.psd.source.imageResources;
    ["globalAngle", "globalAltitude"].forEach((key) => { if (imageResources[key] === undefined && pageResources && pageResources[key] !== undefined) imageResources[key] = pageResources[key]; });
    const root = Object.assign({}, kept, { width, height, bitsPerChannel: 8, canvas: composite, children: [text], imageResources });
    delete root.linkedFiles;
    delete root.filterEffectsMasks;
    const id = uuid();
    const node = outerOf();
    // Its pixels: the text filtered, without its masks
    const shown = engine.visualOf(Object.assign({}, layer, { mask: null, vectorMask: null }), doc);
    if (shown && shown.canvas && shown.canvas.width) place(node, shown.canvas, Math.round(shown.x), Math.round(shown.y));
    else delete node.canvas;
    const pixels = (value) => ({ value, units: "Pixels" });
    node.placedLayer = {
      id,
      // A new one each time: Photoshop keeps the unfiltered picture by it, and must not find an old one
      placed: uuid(),
      type: "raster",
      pageNumber: 1,
      totalPages: 1,
      frameCount: 1,
      transform: [left, top, left + width, top, left + width, top + height, left, top + height],
      width,
      height,
      resolution: { value: doc.resolution, units: "Density" },
      warp: { style: "none", value: 0, perspective: 0, perspectiveOther: 0, rotate: "horizontal", bounds: { top: pixels(0), left: pixels(0), bottom: pixels(height), right: pixels(width) }, uOrder: 4, vOrder: 4 },
      crop: 1,
      comp: -1,
      compInfo: { compID: -1, originalCompID: -1 },
    };
    const filters = (engine.filtersOn(layer) || []).filter((filter) => SMART_FILTER_OUT[filter.type]);
    if (filters.length) {
      node.placedLayer.filter = {
        enabled: true,
        validAtPosition: true,
        maskEnabled: true,
        maskLinked: false,
        maskExtendWithWhite: true,
        list: filters.map((filter) => Object.assign({ opacity: 1, blendMode: "normal", enabled: true, hasOptions: true, foregroundColor: { r: 0, g: 0, b: 0 }, backgroundColor: { r: 255, g: 255, b: 255 } }, SMART_FILTER_OUT[filter.type](filter))),
      };
    }
    node.typerSmart = {
      root,
      options: { invalidateTextLayers: innerFlags.editedText, trimImageData: true, noBackground: true, logMissingFeatures: false },
      // The picture before the filters, for Photoshop (see filterCacheOf)
      unfiltered: filters.length ? { picture: composite, left, top } : null,
      file: { id, name: `${String(layer.name || "Text").replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").trim().slice(0, 40) || "Text"}.psb`, type: "8BPB", creator: "8BIM", descriptor: { compInfo: { compID: -1, originalCompID: -1 } }, childDocumentID: "", assetModTime: 0, assetLockedState: 0 },
    };
    return masksOut(node, layer, doc);
  };

  // Photoshop's text can't follow a surface. It gets what shows, as pixels, with the text
  // itself below it, hidden: still editable there, and nothing else in the file depends on it.
  const nodesFor = (layer, doc, flags) => {
    if (layer.kind === "text" && PS().isSmart(layer) && !(layer.warp || meshed(layer))) return [smartNodeFor(layer, doc, flags)];
    if (layer.kind !== "text" || !(layer.warp || meshed(layer))) return [nodeFor(layer, doc, flags)];
    const text = nodeFor(Object.assign({}, layer, { warp: null, mesh: null, outline: null }), doc, flags);
    // What shows is drawn through the masks: the copy needs none of its own
    text.name = `${layer.name} (text)`;
    text.hidden = true;
    const shown = { name: layer.name, hidden: layer.visible === false, opacity: layer.opacity === undefined ? 1 : layer.opacity, blendMode: layer.blend || "normal" };
    if (layer.clipping) shown.clipping = true;
    if (outlined(layer) && !PS().maskOn(layer) && !PS().vectorOn(layer) && !PS().filtersOn(layer)) {
      const engine = PS();
      // A shape layer: its paths, its colour, its pixels the letter alone; its stroke and its
      // effects its layer style, as a text's
      const paths = engine.outlineOnPage(layer, doc);
      shown.vectorMask = { paths: paths.map((contour, k) => ({ open: false, fillRule: "non-zero", operation: k ? undefined : "combine", knots: contour.map((p) => ({ linked: Boolean(p[6]), points: [p[2], p[3], p[0], p[1], p[4], p[5]] })) })) };
      const style = layer.params.layerText.textStyleRange[0] && layer.params.layerText.textStyleRange[0].textStyle;
      const color = (style && style.color) || { red: 0, green: 0, blue: 0 };
      shown.vectorFill = { type: "color", color: { r: color.red, g: color.green, b: color.blue } };
      const bare = engine.visualOf(Object.assign({}, layer, { stroke: null, effects: undefined, knockout: false, fill: undefined }), doc);
      if (bare) place(shown, bare.canvas, bare.x, bare.y);
      if (layer.stroke && layer.stroke.size > 0) shown.effects = { stroke: strokesToPsd(layer.stroke) };
      effectsOut(shown, layer, doc);
      const amount = engine.fillOf(layer);
      if (amount < 1) shown.fillOpacity = amount;
      return [text, shown];
    }
    // With its shadow and glows, made part of the pixels
    const visual = PS().flatVisual(PS().visualOf(layer, doc));
    if (visual) place(shown, visual.canvas, visual.x, visual.y);
    return [text, shown];
  };

  // The file's own bytes for an untouched layer. A file changes under a slice when it is saved
  // over, so what was read once from it stays in a Blob of its own.
  const rawChannels = async (parts) => {
    try {
      const channels = [];
      const parted = [];
      for (const { id, compression, part } of parts.channels) {
        const data = part ? new Uint8Array(await part.arrayBuffer()) : undefined;
        channels.push({ id, compression, data });
        parted.push({ id, compression, part: data ? new Blob([data]) : null });
      }
      if (parts.fromFile) {
        parts.channels = parted;
        parts.fromFile = false;
      }
      return channels;
    } catch (error) {
      return null;
    }
  };

  const pixelsForWorker = (holder, transfer, readPixels) => {
    const { canvas } = holder;
    delete holder.canvas;
    if (!canvas || !canvas.width || !canvas.height) return;
    const image = (readPixels && readPixels.get(canvas)) || canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
    if (readPixels) readPixels.delete(canvas);
    holder.imageData = { typerImage: true, width: image.width, height: image.height, data: image.data };
    transfer.push(image.data.buffer);
  };
  // The same tree with arrays of pixels instead of canvases, which can't leave the page
  const nodeForWorker = async (from, transfer, { psb, colorMode, readPixels }) => {
    const node = Object.assign({}, from);
    const parts = node.typerRaw;
    delete node.typerRaw;
    if (node.mask) node.mask = Object.assign({}, node.mask);
    if (node.realMask) node.realMask = Object.assign({}, node.realMask);
    const raw = parts && parts.bitsPerChannel === 8 && parts.colorMode === colorMode && parts.large === psb ? await rawChannels(parts) : null;
    if (raw) {
      raw.forEach(({ data }) => { if (data) transfer.push(data.buffer); });
      node.rawData = { colorMode, bitsPerChannel: 8, large: psb, channels: raw };
      delete node.canvas;
      delete node.imageData;
      if (node.mask) delete node.mask.canvas;
      if (node.realMask) delete node.realMask.canvas;
    } else {
      pixelsForWorker(node, transfer, readPixels);
      if (node.mask) pixelsForWorker(node.mask, transfer, readPixels);
      if (node.realMask) pixelsForWorker(node.realMask, transfer, readPixels);
    }
    if (node.children) {
      const children = [];
      for (const child of node.children) children.push(await nodeForWorker(child, transfer, { psb, colorMode, readPixels }));
      node.children = children;
    }
    return node;
  };
  const thumbnailOf = (composite, width, height) => {
    const scale = 160 / Math.max(width, height);
    const small = PS().newCanvas(Math.max(1, Math.floor(width * scale)), Math.max(1, Math.floor(height * scale)));
    const ctx = small.getContext("2d");
    ctx.scale(scale, scale);
    ctx.drawImage(composite, 0, 0);
    const result = { width: small.width, height: small.height, url: small.toDataURL("image/jpeg", 1) };
    small.width = 0;
    small.height = 0;
    return result;
  };

  // Colour that a greyscale file would lose. A trace too faint to see (a grey mixed in Oklab
  // that rounds apart, an almost clear edge) doesn't count.
  const COLOUR_LEVELS = 3;
  const colourOf = (color) => Boolean(color) && color.r !== undefined && Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b) >= COLOUR_LEVELS;
  const canvasHasColour = (canvas, readPixels) => {
    if (!canvas || !canvas.width || !canvas.height) return false;
    let image = readPixels && readPixels.get(canvas);
    if (!image) {
      image = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
      if (readPixels) readPixels.set(canvas, image);
    }
    const { data } = image;
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (!a) continue;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if ((Math.max(r, g, b) - Math.min(r, g, b)) * a >= COLOUR_LEVELS * 255) return true;
    }
    return false;
  };
  // A layer's pixels as they go into the file, and the colours Photoshop draws itself: the
  // text's, its stroke's. A layer taken back untouched from the file has only its greys.
  const nodesHaveColour = (nodes, readPixels) => nodes.some((node) => {
    const strokes = (node.effects && node.effects.stroke) || [];
    if (strokes.some((stroke) => stroke.enabled !== false && colourOf(stroke.color))) return true;
    // A text's shadow, glows and overlays, in colour
    if (node.effects && !node.effects.disabled && FX_NAMES.some((name) => {
      const value = node.effects[FX_IN_FILE[name]];
      return (Array.isArray(value) ? value : value ? [value] : []).some((fx) => fx && fx.enabled !== false && (colourOf(fx.color) || (fx.gradient && (fx.gradient.colorStops || []).some((stop) => colourOf(stop.color)))));
    })) return true;
    const text = node.text;
    if (text && [text.style, ...(text.styleRuns || []).map((run) => run.style)].some((style) => style && (colourOf(style.fillColor) || colourOf(style.strokeColor)))) return true;
    if (!node.typerRaw && canvasHasColour(node.canvas, readPixels)) return true;
    return Boolean(node.children) && nodesHaveColour(node.children, readPixels);
  });

  // A PSD's tree into its bytes, in the worker when there is one. `composite`: the picture its
  // thumbnail is made of (none for the PSD a smart object holds).
  const encode = async (root, options, composite, readPixels) => {
    if (await startWorker()) {
      try {
        const transfer = [];
        const thumbnail = composite ? thumbnailOf(composite, root.width, root.height) : undefined;
        const psd = await nodeForWorker(root, transfer, { psb: Boolean(options.psb), colorMode: root.colorMode, readPixels });
        return await askWorker("write", { psd, options, thumbnail }, transfer);
      } catch (error) {
        console.warn("TypeR web: saving without the worker", error);
      }
    }
    const lib = await library();
    await nextFrame();
    return lib.writePsdUint8Array(root, Object.assign({ generateThumbnail: Boolean(composite) }, options));
  };

  // A PSB when the file's name says so, or when the page is too large for a PSD
  const write = async (doc, target = doc.name) => {
    await nextFrame();
    const engine = PS();
    const flags = { editedText: false, written: new Map() };
    const children = [];
    const groups = new Map();
    const byId = new Map(doc.state.layers.map((layer) => [layer.id, layer]));
    const parentList = (id) => {
      if (!id || !byId.has(id)) return children;
      return ensureGroup(id).children;
    };
    const ensureGroup = (id) => {
      let node = groups.get(id);
      if (!node) {
        const layer = byId.get(id);
        node = nodeFor(layer, doc, flags);
        node.children = [];
        groups.set(id, node);
        parentList(layer.group).push(node);
      }
      return node;
    };
    doc.state.layers.forEach((layer) => {
      if (layer.kind === "group") ensureGroup(layer.id);
      else parentList(layer.group).push(...nodesFor(layer, doc, flags));
    });

    const composite = engine.newCanvas(doc.width, doc.height);
    const ctx = composite.getContext("2d", { willReadFrequently: true });
    const bottom = doc.state.layers[0];
    if (bottom && bottom.isBackground) {
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, doc.width, doc.height);
    }
    engine.paintDoc(doc, ctx, { keep: true });
    const readPixels = new WeakMap();

    const source = (doc.psd && doc.psd.source) || {};
    const imageResources = Object.assign({}, source.imageResources, {
      resolutionInfo: { horizontalResolution: doc.resolution, horizontalResolutionUnit: "PPI", widthUnit: "Inches", verticalResolution: doc.resolution, verticalResolutionUnit: "PPI", heightUnit: "Inches" },
    });
    delete imageResources.thumbnail;
    delete imageResources.thumbnailRaw;
    // The work path as it is now; the paths Photoshop saved under a name stay as they came
    if (doc.state.workPath) imageResources.workPath = { paths: doc.state.workPath.paths };
    else delete imageResources.workPath;
    const sfx = window.TypeRSFX ? window.TypeRSFX.recipesForSave(doc) : [];
    const xmp = xmpWithList(xmpWithList(xmpWithList(xmpWithList(xmpWithList(xmpWithSfx(imageResources.xmpMetadata, sfx), "warps", warpsForSave(doc)), "surfaces", surfacesForSave(doc)), "offsurface", offSurfaceForSave(doc)), "across", acrossForSave(doc)), "letters", lettersForSave(doc));
    if (xmp === undefined) delete imageResources.xmpMetadata;
    else imageResources.xmpMetadata = xmp;
    const root = Object.assign({}, source, { width: doc.width, height: doc.height, bitsPerChannel: 8, canvas: composite, children, imageResources });
    if (!root.colorMode) root.colorMode = 3;
    // A greyscale file given colour here (a Gradient, a coloured text, a pasted picture…) goes
    // on in RGB, as Photoshop's Image > Mode > RGB Color would: in greyscale it would get only
    // the greys. Its grey profile can't describe RGB: Photoshop takes its own instead.
    if (root.colorMode === 1 && (nodesHaveColour(children, readPixels) || canvasHasColour(composite, readPixels))) {
      root.colorMode = 3;
      delete imageResources.iccProfile;
    }
    // A smart text made here: the PSD it holds, encoded as this one is, joins the files inside
    const smarts = [];
    const findSmarts = (nodes) => nodes.forEach((node) => {
      if (node.typerSmart) smarts.push(node);
      if (node.children) findSmarts(node.children);
    });
    findSmarts(children);
    // The layers' own numbers in the file, as Photoshop gives each: a smart object needs one
    // of its own for Photoshop to take what is kept of it before its filters (it refuses the
    // file otherwise)
    const layerIds = new Map();
    const countIds = (nodes) => nodes.forEach((node) => {
      if (node.id > 0) layerIds.set(node.id, (layerIds.get(node.id) || 0) + 1);
      if (node.children) countIds(node.children);
    });
    countIds(children);
    let lastId = Math.max(0, imageResources.idsSeedNumber || 0, ...layerIds.keys());
    for (const node of smarts) {
      const { root: inner, options: innerOptions, file, unfiltered } = node.typerSmart;
      delete node.typerSmart;
      inner.colorMode = root.colorMode;
      file.data = await encode(inner, innerOptions, null);
      root.linkedFiles = (root.linkedFiles || []).concat(file);
      if (!unfiltered || (root.colorMode !== 3 && root.colorMode !== 1)) continue;
      if (!(node.id > 0) || layerIds.get(node.id) > 1) {
        if (node.id > 0) layerIds.set(node.id, layerIds.get(node.id) - 1);
        node.id = ++lastId;
        if (imageResources.idsSeedNumber !== undefined) imageResources.idsSeedNumber = lastId;
      }
      root.filterEffectsMasks = (root.filterEffectsMasks || []).concat(filterCacheOf(node.placedLayer.placed, unfiltered.picture, unfiltered.left, unfiltered.top, doc, root.colorMode));
    }
    // Photoshop's own keepsake of a smart object before its filters goes with it too
    if (root.filterEffectsMasks) {
      const placed = new Set();
      const findPlaced = (nodes) => nodes.forEach((node) => {
        if (node.placedLayer && node.placedLayer.placed) placed.add(node.placedLayer.placed);
        if (node.children) findPlaced(node.children);
      });
      findPlaced(children);
      root.filterEffectsMasks = root.filterEffectsMasks.filter((entry) => placed.has(entry.id));
      if (!root.filterEffectsMasks.length) delete root.filterEffectsMasks;
    }
    // The file a smart object keeps inside the PSD goes only with a layer that still uses it:
    // Photoshop refuses to open a PSD with one left over, as when a folder of Generative Fill
    // layers was merged here
    if (root.linkedFiles) {
      const used = new Set();
      const findUsed = (nodes) => nodes.forEach((node) => {
        if (node.placedLayer && node.placedLayer.id) used.add(node.placedLayer.id);
        if (node.children) findUsed(node.children);
      });
      findUsed(children);
      root.linkedFiles = root.linkedFiles.filter((file) => used.has(file.id));
      if (!root.linkedFiles.length) delete root.linkedFiles;
    }
    const psb = /\.psb$/i.test(target) || doc.width > 30000 || doc.height > 30000;
    // The document's text block: kept, completed or made for the texts written here that
    // need it; else left out, as the PSD library does for a file whose texts changed
    const block = textBlockOut(root, flags.written);
    const options = { psb, invalidateTextLayers: flags.editedText && !block, trimImageData: true, noBackground: !(bottom && bottom.isBackground), logMissingFeatures: false };
    try {
      return await encode(root, options, composite, readPixels);
    } finally {
      composite.width = 0;
      composite.height = 0;
    }
  };

  window.TypeRPSD = { read, readText, write, library, sfxOfXmp, xmpWithSfx, effectsFromPsd, strokeFromEffects };
})();
