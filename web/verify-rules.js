/* TypeR Studio: Verification, the rules. What a typesetter checks on a page before exporting it:
   text against the edge of its bubble or off its centre, badly shaped lines, text over the art
   that nothing makes readable, spaces and punctuation, fonts and sizes that stand out, script
   lines that never made it onto the page. No interface here: verify.js shows what check() finds
   and calls fix(). Every string a typesetter reads is English and is its own translation key.

   window.TypeRVerify = {
     CATEGORIES,  // ["placement", "shape", "stroke", "text", "consistency", "missing"], display order
     RULES,       // [{ id, category, severity: "error" | "warning" | "hint", title, description, on,
                  //    options?: [{ key, label, type: "number" | "choice", default, min?, max?, step?,
                  //    unit?, choices?: [[value, label]] }] }]
     defaults(),  // { [ruleId]: { on, ...option values } }
     check(doc, { rules, script, signal }),  // Promise<Issue[]>. rules: as defaults(), missing ids
                  // take the defaults; script: this page's script lines, tags stripped, or null;
                  // yields on big pages, rejects with an AbortError when `signal` aborts
     fix(doc, issue),  // true once applied as one undo step (the page is shown first); false when
                  // it no longer applies
     linesShown(doc, layer),  // the lines the page shows of a text: { known, overflow, lines:
                  // [{ text (null when unknown), hyphenated, rect? (page pixels, on Photoshop's
                  // pixels) }] }, or null when they can't be told apart
     bubbleShown(doc, layer),  // the rectangle of the bubble around a text (page pixels), or null
   };
   Issue = { id (rule:layer:detail, the same on every run), rule, category, severity, layerId | null,
     layerIds? (every layer concerned), message: { text, values? } (text: a key, {name} filled from
     values), excerpt, rect: { left, top, right, bottom } (page pixels) | null, fix: null | { label },
     data (per rule: bubble, x/y where Centre puts the text, closest script line…) } */
(() => {
  "use strict";

  const PS = () => window.TypeRPhotoshop;

  const CATEGORIES = ["placement", "shape", "stroke", "text", "consistency", "missing"];

  // Display order inside each category is the order here
  const RULES = [
    // Placement
    { id: "bubble-edge", category: "placement", severity: "warning", title: "Text against the edge of its bubble", description: "Text that touches the outline of its bubble, or comes closer to it than the space you set, looks cramped. Leave about a letter's width around the text, or make it a little smaller.", on: true,
      options: [{ key: "margin", label: "Minimum space around the text", type: "number", default: 20, min: 0, max: 100, step: 5, unit: "% of the text size" }] },
    { id: "bubble-spill", category: "placement", severity: "error", title: "Text going out of its bubble", description: "Part of the text lies over the outline of its bubble, or past it into the art or the next bubble.", on: true },
    { id: "bubble-centre", category: "placement", severity: "warning", title: "Text off centre in its bubble", description: "The text is away from where Centre would put it. A bubble cut by the edge of its frame is centred on the part that shows.", on: true,
      options: [{ key: "tolerance", label: "Tolerance", type: "number", default: 10, min: 2, max: 30, step: 1, unit: "% of the bubble's size" }] },
    { id: "text-overflow", category: "placement", severity: "error", title: "Text cut off by its text box", description: "The text doesn't fit in its text box: its last lines aren't shown, and won't be exported.", on: true },
    // Shape
    { id: "lone-word", category: "shape", severity: "hint", title: "One word alone on the last line", description: "A short last line holding a single word leaves the text lopsided. Move a word down from the line above with Line Breaks.", on: true },
    { id: "lone-punctuation", category: "shape", severity: "warning", title: "Punctuation alone on a line", description: "A punctuation mark sits on a line of its own, away from the word it belongs to.", on: true },
    { id: "last-line-longest", category: "shape", severity: "hint", title: "Last line longer than the others", description: "In a round bubble the text should be widest in the middle. Here the last line is clearly the longest.", on: false },
    { id: "hourglass", category: "shape", severity: "hint", title: "Hourglass shape", description: "A line in the middle of the text is much shorter than the lines above and below it.", on: true },
    { id: "hyphen-start", category: "shape", severity: "warning", title: "Line starting with a hyphen", description: "When a word is cut, its hyphen goes at the end of the first line, never at the start of the next one.", on: true },
    { id: "short-word-cut", category: "shape", severity: "warning", title: "Short word cut in two", description: "A word of four letters or fewer is cut across two lines. Keep it whole.", on: true },
    { id: "many-cuts", category: "shape", severity: "warning", title: "Several words cut in one text", description: "More than one word of the same text is cut across lines. One cut at most reads well.", on: true },
    // Stroke
    { id: "no-stroke", category: "stroke", severity: "warning", title: "Text over the art without a stroke", description: "This text isn't in a bubble: it lies over the drawing, with no stroke and no glow to keep it readable.", on: true },
    { id: "low-contrast", category: "stroke", severity: "warning", title: "Text colour close to the background", description: "The text's colour is too close to the colours behind it to be read easily. Change its colour, or give it a stroke.", on: true },
    // Text
    { id: "double-space", category: "text", severity: "warning", title: "Double spaces", description: "Two spaces in a row between words.", on: true },
    { id: "edge-space", category: "text", severity: "warning", title: "Spaces at the start or end of a line", description: "A space at the start of a line pushes it off centre; one at the end is useless.", on: true },
    { id: "space-before-punctuation", category: "text", severity: "warning", title: "Space before punctuation", description: "A space before a comma or a period, and in English before ! ? : ; as well. In a text set to French, the space before ! ? : ; is expected and isn't reported.", on: true },
    { id: "bad-ellipsis", category: "text", severity: "warning", title: "Ellipsis with two dots, or more than three", description: "An ellipsis has three dots: “..” and “....” are typos.", on: true },
    { id: "mixed-ellipsis", category: "text", severity: "hint", title: "“…” and “...” on the same page", description: "The page writes its ellipses both as one character “…” and as three dots “...”. Pick one.", on: true },
    { id: "exclamation-order", category: "text", severity: "hint", title: "“?!” or “!?”", description: "The two marks in the order your team doesn't use.", on: true,
      options: [{ key: "order", label: "The team writes", type: "choice", default: "?!", choices: [["?!", "?!"], ["!?", "!?"]] }] },
    { id: "many-marks", category: "text", severity: "warning", title: "More than three ! or ?", description: "Four or more ! or ? in a row. Three at most.", on: true },
    { id: "final-punctuation", category: "text", severity: "hint", title: "No punctuation at the end", description: "A text in a bubble that ends without punctuation. SFX, single words, captions in a box and texts made only of punctuation are left out.", on: true },
    { id: "empty-text", category: "text", severity: "error", title: "Empty text layer", description: "A text layer with nothing in it.", on: true },
    { id: "duplicate-text", category: "text", severity: "warning", title: "Same text twice", description: "The same text is on the page twice: often a line pasted two times.", on: true },
    { id: "lower-case", category: "text", severity: "warning", title: "Lower case on a page in capitals", description: "The page's texts are written in capitals, but this one has lower-case letters. Fonts that only have capitals are left out.", on: true },
    { id: "other-script", category: "text", severity: "warning", title: "Characters from another script", description: "Japanese, Chinese or Korean characters left in a page translated into a language written in Latin letters.", on: true },
    // Consistency
    { id: "size-outlier", category: "consistency", severity: "hint", title: "Text size far from the others", description: "This text is much larger or smaller than the other texts in the same font on this page. Texts made only of punctuation, often set larger on purpose, are left out.", on: true,
      options: [{ key: "difference", label: "Largest difference", type: "number", default: 100, min: 10, max: 300, step: 10, unit: "%" }] },
    { id: "lone-font", category: "consistency", severity: "hint", title: "Font used only once", description: "Only this text uses its font, while the rest of the page shares a few.", on: false },
    { id: "missing-font", category: "consistency", severity: "error", title: "Missing font", description: "This text's font isn't on this computer, so it's drawn with another font. Install the font, or choose another one.", on: true },
    { id: "no-anti-aliasing", category: "consistency", severity: "warning", title: "Anti-aliasing set to None", description: "With no anti-aliasing the letters' edges come out jagged.", on: true },
    { id: "faux-style", category: "consistency", severity: "hint", title: "Faux Bold or Faux Italic", description: "The text uses Faux Bold or Faux Italic instead of the font's own bold or italic.", on: false },
    { id: "text-scale", category: "consistency", severity: "warning", title: "Squeezed or stretched text", description: "The letters are scaled horizontally or vertically past the limit you set: they look distorted.", on: true,
      options: [{ key: "limit", label: "Largest change", type: "number", default: 15, min: 1, max: 50, step: 1, unit: "%" }] },
    { id: "hidden-text", category: "consistency", severity: "warning", title: "Hidden text layer", description: "A hidden text layer won't show on the exported page.", on: true },
    { id: "off-page", category: "consistency", severity: "warning", title: "Text outside the page", description: "The text is cut by the edge of the page, or lies entirely outside it.", on: true },
    // Missing
    { id: "script-line-missing", category: "missing", severity: "warning", title: "Script line not on the page", description: "A line of this page's script is on no text layer.", on: true },
    { id: "not-in-script", category: "missing", severity: "hint", title: "Text not in the script", description: "This text matches no line of the script: it was probably changed by hand. The closest line is shown.", on: true },
  ];
  const RULE = new Map(RULES.map((rule) => [rule.id, rule]));

  const defaults = () => {
    const out = {};
    RULES.forEach((rule) => {
      const entry = { on: rule.on };
      (rule.options || []).forEach((option) => { entry[option.key] = option.default; });
      out[rule.id] = entry;
    });
    return out;
  };
  // The settings of each rule: what the caller gave, the defaults for the rest
  const settingsOf = (given) => {
    const base = defaults();
    Object.keys(base).forEach((id) => {
      const mine = given && given[id];
      if (!mine || typeof mine !== "object") return;
      if (typeof mine.on === "boolean") base[id].on = mine.on;
      (RULE.get(id).options || []).forEach((option) => {
        const value = mine[option.key];
        if (option.type === "number" && Number.isFinite(Number(value))) base[id][option.key] = Math.max(option.min ?? -Infinity, Math.min(option.max ?? Infinity, Number(value)));
        else if (option.type === "choice" && option.choices.some(([v]) => v === value)) base[id][option.key] = value;
      });
    });
    return base;
  };

  /* ------------------------------- small helpers ------------------------------ */

  const rectOf = (left, top, right, bottom) => ({ left, top, right, bottom });
  const plainRect = (r) => (r ? rectOf(r.left, r.top, r.right, r.bottom) : null);
  const sizePt = (style) => style.impliedFontSize || style.size || 14;
  const sizePx = (style, doc) => (sizePt(style) * (doc.resolution || 72)) / 72;
  const round1 = (v) => Math.round(v * 10) / 10;
  const short = (s, n = 48) => {
    const flat = String(s || "").replace(/[\r\n]+/g, " / ").replace(/\s+/g, " ").trim();
    return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
  };
  // A bit of text around an index, for the excerpt
  const around = (text, from, to) => {
    const a = Math.max(0, from - 14);
    const b = Math.min(text.length, to + 14);
    return (a > 0 ? "…" : "") + text.slice(a, b).replace(/[\r\n]+/g, " / ") + (b < text.length ? "…" : "");
  };
  const hash = (s) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return (h >>> 0).toString(36);
  };
  const abortError = () => {
    try {
      return new DOMException("Verification stopped", "AbortError");
    } catch (error) {
      const e = new Error("Verification stopped");
      e.name = "AbortError";
      return e;
    }
  };

  const LETTER = /\p{L}/u;
  const CASED_LOWER = /\p{Ll}/u;
  const SPACE = "[ \\u00A0\\u202F\\u2009]";
  // Japanese, Chinese and Korean: Han, kana, Hangul, and their corner brackets
  const OTHER_SCRIPT = /[\u3040-\u309F\u30A0-\u30FA\u30FD-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F\u300C-\u300F\uFF66-\uFF9F]/u;
  const OTHER_SCRIPT_ALL = new RegExp(OTHER_SCRIPT.source, "gu");

  const styleOf = (layer) => {
    const ranges = layer.params.layerText.textStyleRange || [];
    return (ranges[0] && ranges[0].textStyle) || {};
  };
  const stylesOf = (layer) => (layer.params.layerText.textStyleRange || []).map((range) => range.textStyle).filter(Boolean);
  const isFrench = (layer) => /^fr/i.test(PS().languageTagOf(styleOf(layer)) || "");
  const fontName = (style) => [style.fontName, style.fontStyleName].filter(Boolean).join(" ") || style.fontPostScriptName || "?";

  // The same text, as the script and the page can both write it: case, spaces, line breaks,
  // hyphens and dashes (a word cut at a line's end), quotes and ellipses left out of it
  const keyOf = (s) => String(s || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/[\u2018\u2019\u201A\u201B`\u00B4]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u00AB\u00BB]/g, "\"")
    .replace(/\u2026/g, "...")
    .replace(/[-\u2010-\u2015\u2212]/g, "")
    .replace(/\s+/g, "");
  // How alike two keys are, 0 to 1: their pairs of letters in common
  const likeness = (a, b) => {
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    const pairs = new Map();
    for (let i = 0; i < a.length - 1; i++) {
      const p = a.slice(i, i + 2);
      pairs.set(p, (pairs.get(p) || 0) + 1);
    }
    let common = 0;
    for (let i = 0; i < b.length - 1; i++) {
      const p = b.slice(i, i + 2);
      const n = pairs.get(p);
      if (n) {
        common++;
        pairs.set(p, n - 1);
      }
    }
    return (2 * common) / (a.length + b.length - 2);
  };

  /* --------------------------------- the page --------------------------------- */

  // A sound effect lettered with the Type tool rather than the SFX tool: one letter per text
  // layer ("C", "l", "i", "n", "g", each turned its own way), or one word turned or bent. It is
  // art, not dialogue: the dialogue rules leave it alone, as they leave SFX-tool layers.
  // Texts made only of punctuation ("!", "…?") are dialogue.
  const letteredSfx = (layer, text) => {
    const bare = text.replace(/[\s​-‍⁠﻿]/g, "");
    if (!LETTER.test(bare)) return false;
    if (Array.from(bare).length === 1) return true;
    const turned = Boolean(layer.rotated || layer.spin || layer.warp);
    return turned && !/\s/.test(text.trim());
  };

  // The texts of a document, with what the rules ask of each
  const textsOf = (doc) => {
    const ps = PS();
    const byId = new Map(doc.state.layers.map((layer) => [layer.id, layer]));
    const ancestors = (layer) => {
      const out = [];
      for (let id = layer.group, guard = 0; id && guard < 64; guard++) {
        const parent = byId.get(id);
        if (!parent) break;
        out.push(parent);
        id = parent.group;
      }
      return out;
    };
    const out = [];
    doc.state.layers.forEach((layer, index) => {
      if (layer.kind !== "text" || !layer.params || !layer.params.layerText) return;
      const parents = ancestors(layer);
      const style = styleOf(layer);
      const text = String(layer.params.layerText.textKey || "");
      let box = null;
      try {
        box = ps.boxOf(layer, doc);
      } catch (error) {
        box = null;
      }
      out.push({
        layer,
        id: layer.id,
        index,
        text,
        style,
        sizePx: sizePx(style, doc),
        sfx: Boolean(layer.sfxPart || parents.some((parent) => parent.sfx) || letteredSfx(layer, text)),
        hidden: layer.visible === false,
        parentHidden: parents.some((parent) => parent.visible === false),
        styledParent: parents.some((parent) => Boolean(parent.stroke) || Boolean(ps.effectsOn(parent))),
        box: box && Number.isFinite(box.left) ? box : null,
        rect: box && Number.isFinite(box.left) && box.right > box.left ? plainRect(box) : null,
      });
    });
    return out;
  };

  /* ---------------------------------- bubbles --------------------------------- */

  // The bubble around each text, found as Align finds it: the Magic Wand at tolerance 20 on the
  // page and the clean layer (never the texts), from the text's middle, then from just around
  // it. Every flood is kept on one page-sized map of stamps, so a bubble two texts share is
  // read once, and a flood that runs into the art stops early.
  const BUBBLE_TOLERANCE = 20;
  const MIN_BUBBLE_AREA = 200;
  const makeFlooder = (doc, data) => {
    const w = doc.width;
    const h = doc.height;
    let stamps = new Uint16Array(w * h);
    let next = 1;
    const regions = [null];
    const stack = new Int32Array(Math.max(1024, Math.min(w * h, 1 << 22)));
    const flood = (x, y, cap) => {
      const sx = Math.max(0, Math.min(w - 1, Math.round(x)));
      const sy = Math.max(0, Math.min(h - 1, Math.round(y)));
      const seed = sy * w + sx;
      const known = stamps[seed];
      if (known) return regions[known];
      if (next >= 65535) {
        stamps.fill(0);
        regions.length = 1;
        next = 1;
      }
      const stamp = next++;
      const i0 = seed * 4;
      const r0 = data[i0];
      const g0 = data[i0 + 1];
      const b0 = data[i0 + 2];
      const similar = (p) => {
        const i = p * 4;
        return Math.abs(data[i] - r0) <= BUBBLE_TOLERANCE && Math.abs(data[i + 1] - g0) <= BUBBLE_TOLERANCE && Math.abs(data[i + 2] - b0) <= BUBBLE_TOLERANCE;
      };
      let left = sx;
      let right = sx;
      let top = sy;
      let bottom = sy;
      let area = 0;
      let aborted = false;
      let sp = 0;
      stack[sp++] = seed;
      stamps[seed] = stamp;
      // Scanline flood, 4-connected as the wand's
      while (sp && !aborted) {
        const p = stack[--sp];
        const py = (p / w) | 0;
        let x0 = p - py * w;
        let x1 = x0;
        const row = py * w;
        while (x0 > 0 && !stamps[row + x0 - 1] && similar(row + x0 - 1)) stamps[row + --x0] = stamp;
        while (x1 < w - 1 && !stamps[row + x1 + 1] && similar(row + x1 + 1)) stamps[row + ++x1] = stamp;
        area += x1 - x0 + 1;
        if (x0 < left) left = x0;
        if (x1 > right) right = x1;
        if (py < top) top = py;
        if (py > bottom) bottom = py;
        if (area > cap) {
          aborted = true;
          break;
        }
        for (let dy = -1; dy <= 1; dy += 2) {
          const ny = py + dy;
          if (ny < 0 || ny >= h) continue;
          const nrow = ny * w;
          for (let nx = x0; nx <= x1; nx++) {
            const q = nrow + nx;
            if (stamps[q] || !similar(q)) continue;
            stamps[q] = stamp;
            if (sp >= stack.length) {
              aborted = true;
              break;
            }
            stack[sp++] = q;
          }
        }
      }
      const region = { stamp, left, top, right: right + 1, bottom: bottom + 1, area, aborted, colour: [r0, g0, b0] };
      regions[stamp] = region;
      return region;
    };
    const maskOf = (region) => {
      const bw = region.right - region.left;
      const bh = region.bottom - region.top;
      const mask = new Uint8Array(bw * bh);
      for (let y = 0; y < bh; y++) {
        const row = (region.top + y) * w + region.left;
        for (let x = 0; x < bw; x++) if (stamps[row + x] === region.stamp) mask[y * bw + x] = 1;
      }
      return mask;
    };
    return { flood, maskOf, release: () => { stamps = null; } };
  };

  // Squared distance to the nearest 0 of `inside` (Felzenszwalb and Huttenlocher), for each 1
  const distanceMap = (inside, w, h) => {
    const INF = 1e20;
    const n = Math.max(w, h);
    const f = new Float64Array(n);
    const d = new Float64Array(n);
    const v = new Int32Array(n);
    const z = new Float64Array(n + 1);
    const out = new Float64Array(w * h);
    const pass = (length) => {
      let k = 0;
      v[0] = 0;
      z[0] = -INF;
      z[1] = INF;
      for (let q = 1; q < length; q++) {
        let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        while (s <= z[k]) {
          k--;
          s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        }
        k++;
        v[k] = q;
        z[k] = s;
        z[k + 1] = INF;
      }
      k = 0;
      for (let q = 0; q < length; q++) {
        while (z[k + 1] < q) k++;
        d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
      }
    };
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) f[y] = inside[y * w + x] ? INF : 0;
      pass(h);
      for (let y = 0; y < h; y++) out[y * w + x] = d[y];
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) f[x] = out[y * w + x];
      pass(w);
      for (let x = 0; x < w; x++) out[y * w + x] = d[x];
    }
    return out;
  };

  // The region with its holes filled (leftover letters, a drawing inside the bubble), on a box
  // one pixel larger all round, whose border is outside
  const filledOf = (mask, bw, bh) => {
    const W = bw + 2;
    const H = bh + 2;
    const outside = new Uint8Array(W * H);
    const at = (x, y) => (x >= 1 && y >= 1 && x <= bw && y <= bh ? mask[(y - 1) * bw + x - 1] : 0);
    const stack = [0];
    outside[0] = 1;
    while (stack.length) {
      const p = stack.pop();
      const x = p % W;
      const y = (p - x) / W;
      const visit = (nx, ny) => {
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) return;
        const q = ny * W + nx;
        if (outside[q] || at(nx, ny)) return;
        outside[q] = 1;
        stack.push(q);
      };
      visit(x - 1, y);
      visit(x + 1, y);
      visit(x, y - 1);
      visit(x, y + 1);
    }
    const filled = new Uint8Array(W * H);
    for (let i = 0; i < filled.length; i++) filled[i] = outside[i] ? 0 : 1;
    return { filled, W, H };
  };

  // The point the panel's Centre and Smart Paste aim at in a single bubble (bodyCentre in
  // TypeR's geometry): the bubble opened by 14% of its short side, which cuts its tail off,
  // then the centroid of what stays, on a grid of at most 160 cells a side
  const BODY_GRID = 160;
  const BODY_OPEN = 0.14;
  const bodyCentre = (filled, W, H, left, top) => {
    const step = Math.max(1, Math.max(W - 2, H - 2) / BODY_GRID);
    const gw = Math.ceil(W / step);
    const gh = Math.ceil(H / step);
    const inside = new Uint8Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) {
      const y = Math.min(H - 1, Math.floor((gy + 0.5) * step));
      for (let gx = 0; gx < gw; gx++) {
        const x = Math.min(W - 1, Math.floor((gx + 0.5) * step));
        inside[gy * gw + gx] = filled[y * W + x];
      }
    }
    const depth = distanceMap(inside, gw, gh);
    const shortSide = Math.min(W - 2, H - 2) / step;
    let radius = Math.min(Math.floor(shortSide / 2 - 1), Math.max(2, Math.round(shortSide * BODY_OPEN)));
    let reach = null;
    const outsideCore = new Uint8Array(gw * gh);
    for (; radius >= 1 && !reach; radius = Math.floor(radius / 2)) {
      const r2 = radius * radius;
      let any = false;
      for (let i = 0; i < outsideCore.length; i++) {
        outsideCore[i] = depth[i] > r2 ? 0 : 1;
        if (!outsideCore[i]) any = true;
      }
      if (any) reach = { map: distanceMap(outsideCore, gw, gh), r2 };
    }
    if (!reach) return null;
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        if (reach.map[gy * gw + gx] > reach.r2) continue;
        sx += gx + 0.5;
        sy += gy + 0.5;
        n++;
      }
    }
    if (!n) return null;
    // Grid cell centres back to page pixels; the filled box starts one pixel before `left`
    return { x: left - 1 + (sx / n) * step, y: top - 1 + (sy / n) * step };
  };

  // A text's letters, without its stroke or effects: their pixels on the page
  const inkOf = (entry, doc) => {
    if (entry.ink !== undefined) return entry.ink;
    entry.ink = readInk(entry, doc);
    return entry.ink;
  };
  const readInk = (entry, doc) => {
    const ps = PS();
    const raster = entry.layer.raster;
    // Opened from a PSD: Photoshop's own letters, as the page shows them. Where an older TypeR
    // drew the stroke into them, TypeR's own letters.
    const bare = Object.assign({}, entry.layer, { stroke: null, effects: undefined, knockout: false, fill: undefined, visible: true }, raster ? { raster: raster.strokeDrawnIn ? null : { bitmap: raster.bitmap, left: raster.left, top: raster.top } } : {});
    let visual = null;
    try {
      visual = ps.visualOf(bare, doc);
    } catch (error) {
      visual = null;
    }
    if (!visual || !visual.canvas || !visual.canvas.width || !visual.canvas.height) return null;
    const cw = visual.canvas.width;
    const ch = visual.canvas.height;
    let pixels;
    try {
      pixels = visual.canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, cw, ch).data;
    } catch (error) {
      return null;
    }
    const xs = [];
    const ys = [];
    const vx = Math.round(visual.x);
    const vy = Math.round(visual.y);
    let left = Infinity;
    let right = -Infinity;
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        if (pixels[(y * cw + x) * 4 + 3] >= 128) {
          xs.push(vx + x);
          ys.push(vy + y);
          if (x < left) left = x;
          if (x > right) right = x;
        }
      }
    }
    // `rect`: around the letters themselves, for what the placement rules point at
    return xs.length ? { xs, ys, rect: rectOf(vx + left, ys[0], vx + right + 1, ys[ys.length - 1] + 1) } : null;
  };

  // A text and its bubble: how much of its ink lies in it, how close it comes to the edge,
  // where Centre would put it. Null when the text isn't in a bubble. `across`: the text lies
  // over two bubbles side by side (the lobes of a double bubble, with their join drawn).
  const bubbleOf = (entry, ctx) => {
    const { doc, flooder } = ctx;
    const box = entry.box;
    if (!box || box.width <= 0 || box.height <= 0) return null;
    const page = doc.width * doc.height;
    const cap = Math.min(page * 0.45, Math.max(250000, box.width * box.height * 30));
    const margin = Math.max(4, Math.round(entry.sizePx * 0.6));
    // Where Align's wand probes: the text's middle, then just above, below, left and right
    const points = [[box.xMid, box.yMid], [box.xMid, box.top - margin], [box.xMid, box.bottom + margin], [box.left - margin, box.yMid], [box.right + margin, box.yMid]];
    const found = [];
    let middle = null;
    points.forEach(([x, y], k) => {
      if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return;
      const region = flooder.flood(x, y, cap);
      if (!region || region.aborted) return;
      const bw = region.right - region.left;
      const bh = region.bottom - region.top;
      if (bw * bh < MIN_BUBBLE_AREA || bw * bh > page * 0.45) return;
      if (region.right <= box.left || region.left >= box.right || region.bottom <= box.top || region.top >= box.bottom) return;
      if (!found.includes(region)) found.push(region);
      if (k === 0) middle = region;
    });
    if (!found.length) return null;
    const ink = inkOf(entry, doc);
    if (!ink) return null;
    // Each region the probes found, its holes filled, and how much of the ink it holds
    const read = found.map((region) => {
      const bw = region.right - region.left;
      const bh = region.bottom - region.top;
      const mask = flooder.maskOf(region);
      const { filled, W, H } = filledOf(mask, bw, bh);
      let inside = 0;
      const insideAt = [];
      for (let i = 0; i < ink.xs.length; i++) {
        const lx = ink.xs[i] - region.left + 1;
        const ly = ink.ys[i] - region.top + 1;
        if (lx >= 0 && ly >= 0 && lx < W && ly < H && filled[ly * W + lx]) {
          inside++;
          insideAt.push(ly * W + lx);
        }
      }
      let area = 0;
      for (let i = 0; i < filled.length; i++) area += filled[i];
      return { region, bw, bh, mask, filled, W, H, inside, insideAt, area, share: inside / ink.xs.length, line: region.area < area * 0.5 };
    }).filter((item) => !item.line);
    // A bubble's outline, or a line of the drawing, holds what it surrounds: never a bubble
    if (!read.length) return null;
    read.sort((p, q) => q.share - p.share || p.bw * p.bh - q.bw * q.bh);
    const top = read[0];
    const boxArea = box.width * box.height;
    // Mostly elsewhere: a patch of the art the text happens to sit on, not its bubble. Its
    // middle in a bubble as large as the text, that it goes out of: still its bubble.
    // A flat area of the drawing many times the text's size (a sky, a wall) is no bubble either
    if (top.region.area > boxArea * 50) return null;
    const own = top.share >= 0.6 || (top.region === middle && top.share >= 0.35 && top.bw * top.bh >= boxArea * 0.6);
    if (!own) {
      const alike = (p, q) => p.region.colour.every((c, k) => Math.abs(c - q.region.colour[k]) <= BUBBLE_TOLERANCE);
      const second = read.find((item) => item !== top && item.share >= 0.15 && alike(item, top));
      if (top.share >= 0.15 && second && top.share + second.share >= 0.7) {
        const r = top.region;
        const o = second.region;
        return { across: true, rect: rectOf(Math.min(r.left, o.left), Math.min(r.top, o.top), Math.max(r.right, o.right), Math.max(r.bottom, o.bottom)), share: top.share + second.share };
      }
      return null;
    }
    const { region: best, bw, bh, mask, filled, W, H, inside, insideAt, share, area } = top;
    // `boxy`: a rectangle, a caption's box
    const boxy = area >= bw * bh * 0.93;
    const depth = distanceMap(filled, W, H);
    let nearest = Infinity;
    insideAt.forEach((p) => { if (depth[p] < nearest) nearest = depth[p]; });
    // `rough`: not a bubble's inside but a panel the wand ran into, through the gaps between
    // the lines of a burst bubble: where its edge and its middle are says nothing about the
    // text. Seen as a region with much drawing inside it, or, in a region many times the
    // text's size, as one whose body around the text holds little of it: the body is the
    // region opened by half the depth the text sits at, which cuts the gaps and passages
    // narrower than that, and a bubble's tail.
    let rough = best.area < area * 0.8;
    if (!rough && area > boxArea * 8 && insideAt.length) {
      let seed = insideAt[0];
      insideAt.forEach((p) => { if (depth[p] > depth[seed]) seed = p; });
      const r2 = Math.max(9, depth[seed] / 4);
      const core = new Uint8Array(W * H);
      const stack = [seed];
      core[seed] = 1;
      while (stack.length) {
        const p = stack.pop();
        const x = p % W;
        if (x > 0 && !core[p - 1] && depth[p - 1] > r2) stack.push(p - 1), (core[p - 1] = 1);
        if (x < W - 1 && !core[p + 1] && depth[p + 1] > r2) stack.push(p + 1), (core[p + 1] = 1);
        if (p >= W && !core[p - W] && depth[p - W] > r2) stack.push(p - W), (core[p - W] = 1);
        if (p + W < W * H && !core[p + W] && depth[p + W] > r2) stack.push(p + W), (core[p + W] = 1);
      }
      for (let i = 0; i < core.length; i++) core[i] = core[i] ? 0 : 1;
      const reach = distanceMap(core, W, H);
      let kept = 0;
      for (let i = 0; i < filled.length; i++) if (filled[i] && reach[i] <= r2) kept++;
      rough = kept < area * 0.6;
    }
    // Texts whose middles are in the same region: a double bubble, or two texts sharing one
    const shared = ctx.entries.some((other) => other !== entry && other.box && !other.sfx && !other.hidden && !other.parentHidden && other.box.xMid >= best.left && other.box.xMid < best.right && other.box.yMid >= best.top && other.box.yMid < best.bottom && filled[(Math.floor(other.box.yMid) - best.top + 1) * W + (Math.floor(other.box.xMid) - best.left + 1)]);
    let targets = null;
    if (!shared) {
      targets = [];
      const body = bodyCentre(filled, W, H, best.left, best.top);
      if (body) targets.push(body);
      try {
        const opened = PS().openedSelectionBounds({ bounds: { left: best.left, top: best.top, right: best.right, bottom: best.bottom, width: bw, height: bh, xMid: (best.left + best.right) / 2, yMid: (best.top + best.bottom) / 2 }, mask: { data: mask, width: bw, height: bh, left: best.left, top: best.top } }, null);
        if (opened && Number.isFinite(opened.xMid)) targets.push({ x: opened.xMid, y: opened.yMid, classic: true });
      } catch (error) {
        // Align's own point is only a second opinion
      }
    }
    return { region: best, rect: rectOf(best.left, best.top, best.right, best.bottom), inkCount: ink.xs.length, outside: ink.xs.length - inside, share, nearest: Math.sqrt(nearest), shared, targets, colour: best.colour, rough, boxy };
  };

  /* --------------------------------- lines ---------------------------------- */

  // Which lines end with a hyphen that cuts a word, and that word
  const markCuts = (lines, layer) => {
    lines.forEach((line, i) => {
      const nextLine = lines[i + 1];
      if (!nextLine) return;
      const body = line.text.replace(/\s+$/, "");
      if (!/[-\u2010]$/.test(body)) return;
      const left = (/(\p{L}+)[-\u2010]$/u.exec(body) || [])[1] || "";
      const right = (/^\s*(\p{L}+)/u.exec(nextLine.text) || [])[1] || "";
      if (!left || !right) return;
      const cut = line.hyphenated || !PS().realHyphen(left, right, layer.source, layer.params.layerText.textKey, layer.cuts);
      if (cut) line.cut = { left, right, word: left + right };
    });
    return lines;
  };

  // The lines as TypeR sets them: their text, the width of their ink, and what doesn't fit
  // in the text box
  const linesOf = (entry, doc) => {
    const ps = PS();
    let layout;
    try {
      layout = ps.layoutLayer(entry.layer, doc);
    } catch (error) {
      return null;
    }
    const lines = layout.lines.filter((line) => line.runs && line.runs.length).map((line) => ({
      text: line.runs.map((run) => run.text).join(""),
      width: Math.max(0, (line.m.inkRight || 0) - (line.m.inkLeft || 0)),
      hyphenated: Boolean(line.runs.hyphenated),
    }));
    // Every line of the text, those the box shows first
    const rows = (layout.relative && layout.relative.wrapped) || [];
    const hidden = layout.overflow ? rows.slice(layout.lines.length).map((runs) => runs.map((run) => run.text).join("")).join(" ") : "";
    return { lines: markCuts(lines, entry.layer), overflow: Boolean(layout.overflow), hidden, frame: layout.frame, known: true };
  };

  // The lines of Photoshop's own pixels, for a text opened from a PSD and not edited since:
  // the rows of its ink, each line's left and right. Accents and a line of dots join the line
  // they belong to. Null when they can't be told apart: a turned, bent or vertical text, or
  // lines that touch.
  const shownLinesOf = (entry, doc) => {
    const layer = entry.layer;
    const raster = layer.raster;
    const lt = layer.params.layerText;
    const shape = lt.textShape && lt.textShape[0];
    if (!raster || !raster.bitmap || layer.rotated || layer.spin || layer.warp || (shape && shape.orientation === "vertical")) return null;
    const bitmap = raster.bitmap;
    const w = bitmap.width;
    const h = bitmap.height;
    if (!w || !h) return null;
    let alpha;
    try {
      alpha = bitmap.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    } catch (error) {
      return null;
    }
    const size = Math.max(1, ...stylesOf(layer).map((style) => sizePx(style, doc)));
    const base = styleOf(layer);
    const paragraph = ((lt.paragraphStyleRange || [])[0] || { paragraphStyle: {} }).paragraphStyle || {};
    const lead = base.autoLeading === false && base.leading > 0 ? sizePx({ size: base.leading }, doc) : size * (paragraph.autoLeadingPercentage || 1.2);
    // The ink of each row
    const counts = new Int32Array(h);
    for (let y = 0; y < h; y++) {
      let n = 0;
      for (let x = 0, p = y * w * 4 + 3; x < w; x++, p += 4) if (alpha[p] >= 128) n++;
      counts[y] = n;
    }
    const found = [];
    let band = null;
    for (let y = 0; y < h; y++) {
      if (counts[y]) {
        if (!band) found.push((band = { top: y, bottom: y + 1 }));
        else band.bottom = y + 1;
      } else band = null;
    }
    // Lines joined by an accent or a comma that reaches the next one: cut at their thinnest rows
    const bands = [];
    found.forEach((b) => {
      const k = Math.max(1, Math.floor((b.bottom - b.top - size * 0.75) / lead + 0.35) + 1);
      let top = b.top;
      for (let j = 1; j < k; j++) {
        const expected = b.top + ((b.bottom - b.top) * j) / k;
        let cut = -1;
        for (let y = Math.max(top + 1, Math.round(expected - lead * 0.3)); y <= Math.min(b.bottom - 2, Math.round(expected + lead * 0.3)); y++) if (cut < 0 || counts[y] < counts[cut]) cut = y;
        if (cut < 0) break;
        bands.push({ top, bottom: cut });
        top = cut + 1;
      }
      bands.push({ top, bottom: b.bottom });
    });
    const tall = (b) => b.bottom - b.top >= size * 0.4;
    let lines = bands.filter(tall).map((b) => ({ top: b.top, bottom: b.bottom }));
    if (!lines.length) {
      // Only small marks: one line of dots, or nothing that can be read
      if (bands[bands.length - 1].bottom - bands[0].top > size * 1.2) return null;
      lines = [{ top: bands[0].top, bottom: bands[bands.length - 1].bottom }];
    } else {
      bands.filter((b) => !tall(b)).forEach((b) => {
        const gap = (line) => Math.max(line.top - b.bottom, b.top - line.bottom, 0);
        const nearest = lines.reduce((best, line) => (gap(line) < gap(best) ? line : best), lines[0]);
        if (gap(nearest) <= size * 0.35) {
          nearest.top = Math.min(nearest.top, b.top);
          nearest.bottom = Math.max(nearest.bottom, b.bottom);
        } else lines.push({ top: b.top, bottom: b.bottom });
      });
      lines.sort((a, b) => a.top - b.top);
    }
    // Two lines whose letters touch read as one band: then the lines aren't known
    if (lines.some((line) => line.bottom - line.top > size * 1.6)) return null;
    return lines.map((line) => {
      let left = w;
      let right = -1;
      for (let y = line.top; y < line.bottom; y++) {
        for (let x = 0, p = y * w * 4 + 3; x < left; x++, p += 4) if (alpha[p] >= 128) left = x;
        for (let x = w - 1, p = (y * w + w - 1) * 4 + 3; x > right; x--, p -= 4) if (alpha[p] >= 128) right = x;
      }
      return { width: Math.max(0, right - left + 1), rect: rectOf(raster.left + left, raster.top + line.top, raster.left + right + 1, raster.top + line.bottom) };
    });
  };

  // How far a line set by TypeR may be from the same line in Photoshop's pixels
  const lineSlack = (entry, width) => Math.max(3, entry.sizePx * 0.2, width * 0.04);

  // The words of a text, fitted to the lines Photoshop's pixels show: where each line breaks
  // (at a space, after a hyphen, or at a syllable with a hyphen added), found as the breaks
  // whose lines are as wide as the ink of the page's lines. `scale`: Photoshop's letters over
  // TypeR's, when the font TypeR has isn't quite the one the PSD was set with. The whole
  // text, or, when it doesn't fit, the start of it with the rest cut off by its box (`next`:
  // how wide the last line would be with one more word). Null when nothing fits.
  const fitWords = (entry, doc, shown, scale = 1) => {
    const ps = PS();
    const layer = entry.layer;
    const lt = layer.params.layerText;
    const text = String(lt.textKey || "");
    const ranges = lt.textStyleRange || [];
    const styleAt = (i) => {
      for (let k = 0; k < ranges.length; k++) if (i >= ranges[k].from && i < ranges[k].to) return ranges[k].textStyle;
      return ranges.length ? ranges[ranges.length - 1].textStyle : {};
    };
    const paragraph = ((lt.paragraphStyleRange || [])[0] || { paragraphStyle: {} }).paragraphStyle || {};
    const Hyphenation = window.TypeRHyphenation;
    const tag = (/^[a-z]{2}/i.exec(ps.languageTagOf(styleOf(layer)) || "") || [""])[0].toLowerCase();
    const language = paragraph.hyphenate === true && Hyphenation && Hyphenation.LANGUAGES.includes(tag) && Hyphenation.isLoaded(tag) ? tag : null;
    const wordSize = paragraph.hyphenateWordSize || 6;
    const pre = paragraph.hyphenatePreLength || 2;
    const post = paragraph.hyphenatePostLength || 2;
    // Each paragraph's places where a line may end ({ end, start, hyphen }), its first start
    // and its last end included
    const paragraphs = [];
    let at = 0;
    text.split(/(\r\n|[\r\n])/).forEach((part, k) => {
      if (k % 2) {
        at += part.length;
        return;
      }
      let a = at;
      let b = at + part.length;
      at = b;
      while (a < b && /\s/.test(text[a])) a++;
      while (b > a && /\s/.test(text[b - 1])) b--;
      if (a >= b) return;
      const stops = [{ end: a, start: a }];
      for (let i = a + 1; i < b; i++) {
        const ch = text[i];
        if (ch === " " || ch === "\t") {
          let j = i;
          while (j < b && (text[j] === " " || text[j] === "\t")) j++;
          stops.push({ end: i, start: j, before: !/[\p{L}\p{N}]/u.test(text.slice(j, (/^\S*/.exec(text.slice(j)) || [""])[0].length + j)) });
          i = j - 1;
        } else if ((ch === "-" || ch === "\u2010") && LETTER.test(text[i - 1]) && LETTER.test(text[i + 1] || "")) stops.push({ end: i + 1, start: i + 1 });
      }
      if (language) {
        const re = /\p{L}[\p{L}'\u2019]*/gu;
        const body = text.slice(a, b);
        let m;
        while ((m = re.exec(body))) {
          const word = m[0];
          if (word.length < wordSize) continue;
          Hyphenation.breakPoints(word, language).forEach((point) => {
            if (point < pre || word.length - point < post) return;
            const cut = a + m.index + point;
            stops.push({ end: cut, start: cut, hyphen: true });
          });
        }
      }
      stops.sort((p, q) => p.end - q.end || p.start - q.start);
      stops.push({ end: b, start: b, last: true });
      paragraphs.push(stops);
    });
    if (!paragraphs.length) return null;
    const n = shown.length;
    const widest = Math.max(...shown.map((line) => line.width));
    const measured = new Map();
    const widthOf = (from, to, hyphen) => {
      const key = `${from}:${to}:${hyphen ? 1 : 0}`;
      if (measured.has(key)) return measured.get(key);
      const runs = [];
      for (let i = from; i < to; i++) {
        const style = styleAt(i);
        const last = runs[runs.length - 1];
        if (last && last.style === style) last.text += text[i];
        else runs.push({ text: text[i], style });
      }
      if (hyphen && runs.length) runs[runs.length - 1] = { text: runs[runs.length - 1].text + "-", style: runs[runs.length - 1].style };
      let width = Infinity;
      try {
        const m = ps.measureRuns(runs, doc.resolution);
        width = Math.max(0, m.inkRight - m.inkLeft) * scale;
      } catch (error) {
        width = Infinity;
      }
      measured.set(key, width);
      return width;
    };
    // best[p][s][k]: the lowest cost of k lines that end at stop s of paragraph p
    // (s = 0: the paragraph not started yet, the lines before it all set)
    const best = paragraphs.map((stops) => stops.map(() => new Array(n + 1).fill(Infinity)));
    const from = paragraphs.map((stops) => stops.map(() => new Array(n + 1).fill(null)));
    best[0][0][0] = 0;
    for (let p = 0; p < paragraphs.length; p++) {
      const stops = paragraphs[p];
      if (p > 0) {
        // A paragraph starts where the one before ended
        const before = best[p - 1][paragraphs[p - 1].length - 1];
        for (let k = 0; k <= n; k++) best[p][0][k] = before[k];
      }
      for (let s = 0; s < stops.length - 1; s++) {
        for (let k = 0; k < n; k++) {
          const cost = best[p][s][k];
          if (!Number.isFinite(cost)) continue;
          const target = shown[k].width;
          const slack = lineSlack(entry, target);
          for (let e = s + 1; e < stops.length; e++) {
            if (stops[e].end <= stops[s].start) continue;
            const width = widthOf(stops[s].start, stops[e].end, stops[e].hyphen);
            if (width > widest + slack * 2) break;
            const error = Math.abs(width - target);
            if (error > slack) continue;
            // A cut at a syllable, or a line breaking before a mark, only when nothing else fits
            const next = cost + (error / slack) ** 2 + (stops[e].hyphen ? 0.5 : 0) + (stops[e].before ? 0.5 : 0);
            if (next < best[p][e][k + 1]) {
              best[p][e][k + 1] = next;
              from[p][e][k + 1] = s;
            }
          }
        }
      }
    }
    const linesTo = (p, e, k) => {
      const out = [];
      for (; k > 0; k--) {
        while (e === 0 && p > 0) {
          p--;
          e = paragraphs[p].length - 1;
        }
        const s = from[p][e][k];
        const stops = paragraphs[p];
        out.unshift({ text: text.slice(stops[s].start, stops[e].end) + (stops[e].hyphen ? "-" : ""), hyphenated: Boolean(stops[e].hyphen) });
        e = s;
      }
      return out;
    };
    const place = (lines) => markCuts(lines.map((line, i) => Object.assign(line, { width: shown[i].width, rect: shown[i].rect })), layer);
    const lastP = paragraphs.length - 1;
    const lastS = paragraphs[lastP].length - 1;
    if (Number.isFinite(best[lastP][lastS][n])) return { lines: place(linesTo(lastP, lastS, n)), overflow: false, hidden: "", known: true };
    // The start of the text fits, the rest is cut off by the box
    let found = null;
    paragraphs.forEach((stops, p) => stops.forEach((stop, e) => {
      if (e === 0 || (p === lastP && e === lastS)) return;
      const cost = best[p][e][n];
      if (Number.isFinite(cost) && (!found || cost < found.cost)) found = { p, e, cost };
    }));
    if (!found) return null;
    const stops = paragraphs[found.p];
    const stop = stops[found.e];
    const lines = linesTo(found.p, found.e, n);
    // The last line with the next word on it: past the box's width, or across a line break
    let next = Infinity;
    if (found.e < stops.length - 1) {
      const s = from[found.p][found.e][n];
      let e = found.e + 1;
      while (e < stops.length - 1 && stops[e].hyphen) e++;
      next = widthOf(stops[s].start, stops[e].end, stops[e].hyphen);
    }
    return { lines: place(lines), overflow: true, hidden: text.slice(stop.hyphen ? stop.end : stop.start).trim(), next, known: true };
  };
  // Photoshop's letters over TypeR's, the whole text against the ink of every line: about 1
  // when TypeR has the font the PSD was set with
  const scaleOf = (entry, doc, shown) => {
    const ps = PS();
    const lt = entry.layer.params.layerText;
    const style = styleOf(entry.layer);
    const paragraphs = String(lt.textKey || "").split(/\r\n|[\r\n]/).map((part) => part.trim()).filter(Boolean);
    let own = 0;
    let space = 0;
    try {
      paragraphs.forEach((part) => {
        const m = ps.measureRuns([{ text: part, style }], doc.resolution);
        own += Math.max(0, m.inkRight - m.inkLeft);
      });
      space = ps.measureRuns([{ text: " ", style }], doc.resolution).advance;
    } catch (error) {
      return 1;
    }
    const theirs = shown.reduce((sum, line) => sum + line.width, 0) + Math.max(0, shown.length - paragraphs.length) * space;
    return own > 0 && theirs > 0 ? theirs / own : 1;
  };

  // The lines the page shows. A text set by TypeR: its own layout. A text that still shows
  // Photoshop's pixels: TypeR's layout when it matches them line for line, else its words
  // fitted to them; their text unknown when nothing fits (only their widths are known then)
  const shapeOf = (entry, doc) => {
    const drawn = linesOf(entry, doc);
    if (!entry.layer.raster) return drawn;
    const shown = shownLinesOf(entry, doc);
    if (!shown) return null;
    if (drawn && drawn.lines.length === shown.length && drawn.lines.every((line, i) => Math.abs(line.width - shown[i].width) <= lineSlack(entry, shown[i].width))) {
      drawn.lines.forEach((line, i) => Object.assign(line, { width: shown[i].width, rect: shown[i].rect }));
      return drawn;
    }
    const unknown = { lines: shown.map((line) => ({ text: null, width: line.width, rect: line.rect })), overflow: false, hidden: "", known: false };
    const fitted = fitWords(entry, doc, shown);
    if (fitted && !fitted.overflow) return fitted;
    // TypeR's font draws wider or narrower than Photoshop's: fitted again at their ratio, and
    // nothing said to be cut off, which such a ratio can't tell
    const scale = scaleOf(entry, doc, shown);
    if (Math.abs(scale - 1) > 0.06) {
      const again = fitWords(entry, doc, shown, scale);
      return again && !again.overflow ? again : unknown;
    }
    if (!fitted) return unknown;
    // Cut off by its box: only when one more line would have gone past the box's bottom,
    // and the next word wouldn't have fitted on the last line
    const frame = drawn && drawn.frame;
    const lead = entry.sizePx * 1.2;
    if (!frame || frame.bottom - shown[shown.length - 1].rect.bottom > lead || fitted.next <= frame.right - frame.left) return unknown;
    return fitted;
  };

  // What a box cuts off matters when it holds a letter, or more than one mark: a stray
  // character left after the text isn't missed
  const hiddenMatters = (hidden) => LETTER.test(hidden) || hidden.replace(/\s/g, "").length >= 2;

  /* ------------------------------- text edits -------------------------------- */

  // Each finds what's wrong in a text: [{ from, to, insert }], none when it's right
  const EDITS = {
    "double-space": (text) => {
      const out = [];
      const re = new RegExp(`(?<=[^\\s])${SPACE}{2,}(?=[^\\s])`, "gu");
      let m;
      while ((m = re.exec(text))) out.push({ from: m.index + 1, to: m.index + m[0].length, insert: "" });
      return out;
    },
    "edge-space": (text) => {
      const out = [];
      let start = 0;
      text.split(/(\r\n|[\r\n])/).forEach((part, k) => {
        if (k % 2) {
          start += part.length;
          return;
        }
        const lead = new RegExp(`^${SPACE}+`, "u").exec(part);
        const trail = new RegExp(`${SPACE}+$`, "u").exec(part);
        if (lead && lead[0].length === part.length) out.push({ from: start, to: start + part.length, insert: "" });
        else {
          if (lead) out.push({ from: start, to: start + lead[0].length, insert: "" });
          if (trail) out.push({ from: start + trail.index, to: start + part.length, insert: "" });
        }
        start += part.length;
      });
      return out;
    },
    "space-before-punctuation": (text, layer) => {
      const out = [];
      // French writes a space before ! ? : ; (and inside « »): only , and . are wrong there
      const marks = isFrench(layer) ? "[,.]" : "[,.!?:;]";
      const re = new RegExp(`(?<=[\\p{L}\\p{N}'\u2019"\u201D)\\]])${SPACE}+(?=${marks})`, "gu");
      let m;
      while ((m = re.exec(text))) {
        const after = text.slice(m.index + m[0].length);
        // An ellipsis after a space is a style ("Well ...right"), not a typo
        if (/^\.\./.test(after)) continue;
        // ".5", ",50": a number
        if (/^[.,]\d/.test(after)) continue;
        out.push({ from: m.index, to: m.index + m[0].length, insert: "" });
      }
      return out;
    },
    "bad-ellipsis": (text, layer, ctx) => {
      const out = [];
      const form = (ctx && ctx.ellipsis) || "...";
      const re = /\.{2,}/g;
      let m;
      while ((m = re.exec(text))) {
        if (m[0].length === 3) continue;
        // "?.." and "!..": the same typo
        out.push({ from: m.index, to: m.index + m[0].length, insert: form });
      }
      return out;
    },
    "mixed-ellipsis": (text, layer, ctx) => {
      const out = [];
      const want = ctx && ctx.ellipsis;
      if (!want) return out;
      const re = want === "\u2026" ? /(?<!\.)\.\.\.(?!\.)/g : /\u2026/g;
      let m;
      while ((m = re.exec(text))) out.push({ from: m.index, to: m.index + m[0].length, insert: want });
      return out;
    },
    "exclamation-order": (text, layer, ctx) => {
      const out = [];
      const want = (ctx && ctx.order) || "?!";
      const wrong = want === "?!" ? "!?" : "?!";
      const re = /[!?]+/g;
      let m;
      while ((m = re.exec(text))) if (m[0] === wrong) out.push({ from: m.index, to: m.index + 2, insert: want });
      return out;
    },
    "lower-case": (text, layer) => {
      const out = [];
      const tag = PS().languageTagOf(styleOf(layer)) || undefined;
      Array.from(text).reduce((at, ch) => {
        if (CASED_LOWER.test(ch)) {
          let up = ch;
          try {
            up = ch.toLocaleUpperCase(tag);
          } catch (error) {
            up = ch.toUpperCase();
          }
          if (up !== ch) out.push({ from: at, to: at + ch.length, insert: up });
        }
        return at + ch.length;
      }, 0);
      return out;
    },
  };

  // The layer with these edits made: each letter keeps its own style and paragraph, inserted
  // letters take those of the letter they replace (or the one before)
  const editedLayer = (layer, edits) => {
    const lt = layer.params.layerText;
    const text = String(lt.textKey || "");
    const styleRanges = lt.textStyleRange || [];
    const paraRanges = lt.paragraphStyleRange || [];
    const at = (ranges, i, field) => {
      const found = ranges.find((range) => i >= range.from && i < range.to) || ranges[ranges.length - 1];
      return found ? found[field] : null;
    };
    const chars = [];
    const styles = [];
    const paras = [];
    const keep = (from, to) => {
      for (let i = from; i < to; i++) {
        chars.push(text[i]);
        styles.push(at(styleRanges, i, "textStyle"));
        paras.push(at(paraRanges, i, "paragraphStyle"));
      }
    };
    let cursor = 0;
    edits.slice().sort((a, b) => a.from - b.from).forEach((edit) => {
      if (edit.from < cursor) return;
      keep(cursor, edit.from);
      const source = edit.from < text.length ? edit.from : Math.max(0, edit.from - 1);
      for (const ch of edit.insert) {
        for (let k = 0; k < ch.length; k++) {
          chars.push(ch[k]);
          styles.push(at(styleRanges, source, "textStyle"));
          paras.push(at(paraRanges, source, "paragraphStyle"));
        }
      }
      cursor = edit.to;
    });
    keep(cursor, text.length);
    const rangesOf = (list, field) => {
      const out = [];
      list.forEach((item, i) => {
        const last = out[out.length - 1];
        if (last && last[field] === item) last.to = i + 1;
        else out.push({ from: i, to: i + 1, [field]: item });
      });
      return out;
    };
    const after = chars.join("");
    const params = JSON.parse(JSON.stringify(layer.params));
    params.layerText.textKey = after;
    if (styleRanges.length) {
      const ranges = rangesOf(styles, "textStyle");
      params.layerText.textStyleRange = JSON.parse(JSON.stringify(ranges.length ? ranges : [{ from: 0, to: after.length, textStyle: styleRanges[0].textStyle }]));
    }
    if (paraRanges.length) {
      const ranges = rangesOf(paras, "paragraphStyle");
      params.layerText.paragraphStyleRange = JSON.parse(JSON.stringify(ranges.length ? ranges : [{ from: 0, to: after.length, paragraphStyle: paraRanges[0].paragraphStyle }]));
    }
    const autoName = text.replace(/[\r\n]+/g, " ").substring(0, 60);
    const name = layer.name === autoName ? after.replace(/[\r\n]+/g, " ").substring(0, 60) || layer.name : layer.name;
    return Object.assign({}, layer, { params, raster: null, name });
  };

  /* ---------------------------------- check ---------------------------------- */

  // Whether a font draws its lower case as capitals: then lower case on a page in capitals
  // looks the same
  const capsOnly = new Map();
  const capitalsOnly = (style) => {
    const key = style.fontPostScriptName || style.fontName || "";
    if (capsOnly.has(key)) return capsOnly.get(key);
    let same = false;
    try {
      const canvas = document.createElement("canvas");
      const c = canvas.getContext("2d");
      c.font = PS().cssFont(Object.assign({}, style, { syntheticBold: false, syntheticItalic: false }), 100);
      const lower = c.measureText("abcdefghijklmnopqrstuvwxyz").width;
      const upper = c.measureText("ABCDEFGHIJKLMNOPQRSTUVWXYZ").width;
      same = Math.abs(lower - upper) <= upper * 0.005;
    } catch (error) {
      same = false;
    }
    capsOnly.set(key, same);
    return same;
  };

  const luminance = (r, g, b) => {
    const lin = (c) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };

  const textColourOf = (layer) => {
    const fx = layer.effects;
    if (fx && fx.gradientOverlay && fx.gradientOverlay.enabled !== false) return null;
    if (fx && fx.colorOverlay && fx.colorOverlay.enabled !== false && (fx.colorOverlay.opacity ?? 100) >= 50) {
      const c = fx.colorOverlay.color || {};
      return [c.r || 0, c.g || 0, c.b || 0];
    }
    const c = styleOf(layer).color || {};
    return [c.red || 0, c.green || 0, c.blue || 0];
  };
  // A stroke, or a glow (a shadow with no distance is one), makes text readable on anything
  const readableAid = (entry) => {
    const layer = entry.layer;
    if (layer.stroke && layer.stroke.enabled !== false && layer.stroke.size > 0) return true;
    if (entry.styledParent) return true;
    const fx = layer.effects;
    const shown = (effect) => Boolean(effect) && effect.enabled !== false && (effect.opacity ?? 100) > 0;
    if (fx && shown(fx.outerGlow) && (fx.outerGlow.size || 0) > 0) return true;
    if (fx && shown(fx.dropShadow) && (fx.dropShadow.size || 0) > 0) return true;
    return false;
  };

  const check = async (doc, { rules, script, signal } = {}) => {
    if (!doc || !doc.state) return [];
    const ps = PS();
    const settings = settingsOf(rules);
    const on = (id) => settings[id] && settings[id].on;
    const issues = [];
    const add = (ruleId, entry, detail, text, values, more = {}) => {
      const rule = RULE.get(ruleId);
      const issue = {
        id: `${ruleId}:${entry ? entry.id : "page"}${detail ? ":" + detail : ""}`,
        rule: ruleId,
        category: rule.category,
        severity: more.severity || rule.severity,
        layerId: entry ? entry.id : null,
        message: values ? { text, values } : { text },
        excerpt: more.excerpt !== undefined ? more.excerpt : entry ? short(entry.text) : "",
        rect: more.rect !== undefined ? more.rect : entry ? entry.rect : null,
        fix: more.fix ? { label: more.fix } : null,
        data: more.data || {},
      };
      if (more.layerIds) issue.layerIds = more.layerIds;
      issues.push(issue);
    };
    const stopIfAsked = () => {
      if (signal && signal.aborted) throw abortError();
    };
    let lastYield = performance.now();
    const breathe = async () => {
      stopIfAsked();
      if (performance.now() - lastYield < 12) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
      lastYield = performance.now();
      stopIfAsked();
    };
    stopIfAsked();

    const entries = textsOf(doc);
    const shown = entries.filter((entry) => !entry.hidden && !entry.parentHidden);
    const dialogue = shown.filter((entry) => !entry.sfx);

    // Fonts: each asked for once, so that a missing one is known as missing
    const fontNames = new Set();
    shown.forEach((entry) => stylesOf(entry.layer).forEach((style) => { if (style.fontPostScriptName) fontNames.add(style.fontPostScriptName); }));
    const Fonts = window.TypeRFonts;
    if (Fonts && fontNames.size && on("missing-font")) {
      await Promise.race([Promise.all(Array.from(fontNames).map((name) => Promise.resolve(Fonts.ensure(name)).catch(() => false))), new Promise((resolve) => setTimeout(resolve, 2000))]);
      stopIfAsked();
    }

    // The page's own habits, for the fixes and the page-wide rules
    let dots = 0;
    let ellipses = 0;
    dialogue.forEach((entry) => {
      dots += (entry.text.match(/(?<!\.)\.\.\.(?!\.)/g) || []).length;
      ellipses += (entry.text.match(/\u2026/g) || []).length;
    });
    const textCtx = { ellipsis: ellipses > dots ? "…" : "...", order: settings["exclamation-order"].order };

    // Hidden layers first: they are left out of everything else
    // A hidden copy of a text shown at the same place is a backup kept on purpose
    const overlap = (a, b) => {
      if (!a.box || !b.box) return 0;
      const w = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
      const h = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
      if (w <= 0 || h <= 0) return 0;
      return (w * h) / Math.min(a.box.width * a.box.height, b.box.width * b.box.height);
    };
    const backup = (entry) => {
      const key = keyOf(entry.text);
      return shown.some((other) => overlap(entry, other) >= 0.5 && likeness(key, keyOf(other.text)) >= 0.6);
    };
    entries.forEach((entry) => {
      if (entry.sfx || entry.parentHidden || !entry.hidden) return;
      if (on("hidden-text") && entry.text.trim() && !backup(entry)) add("hidden-text", entry, "", "This text layer is hidden", null, { fix: "Show the layer" });
    });

    // Bubbles need the page as the wand reads it: once per check
    const needsPage = on("bubble-edge") || on("bubble-spill") || on("bubble-centre") || on("no-stroke") || on("low-contrast") || on("final-punctuation") || on("lone-word") || on("last-line-longest") || on("hourglass");
    let data = null;
    let flooder = null;
    // A page that isn't the one shown keeps no copy of its pixels after the check
    const sampledBefore = Boolean(doc.sampleCache);
    if (needsPage && dialogue.length) {
      data = ps.sampleData(doc, true);
      flooder = makeFlooder(doc, data);
      await breathe();
    }
    const pageCtx = { doc, flooder, entries };

    for (const entry of shown) {
      const layer = entry.layer;
      const lt = layer.params.layerText;
      if (on("missing-font") && Fonts && Fonts.isMissing) {
        const missing = Array.from(new Set(stylesOf(layer).filter((style) => style.fontPostScriptName && Fonts.isMissing(style.fontPostScriptName)).map(fontName)));
        if (missing.length) add("missing-font", entry, "", "Missing font: {font}", { font: missing.join(", ") }, { data: { fonts: missing } });
      }
      if (entry.sfx) continue;
      const text = entry.text;
      const blank = !text.replace(/[\s\u200B-\u200D\u2060\uFEFF]/g, "");
      if (blank) {
        if (on("empty-text")) add("empty-text", entry, "", "This text layer is empty", null, { excerpt: layer.name || "", fix: "Delete the layer", rect: entry.rect || pointRect(layer, doc) });
        continue;
      }

      // Text
      [["double-space", "Two spaces in a row"], ["edge-space", "Space at the start or end of a line"], ["space-before-punctuation", "Space before a punctuation mark"]].forEach(([id, message]) => {
        if (!on(id)) return;
        const found = EDITS[id](text, layer, textCtx);
        if (found.length) add(id, entry, "", message, null, { excerpt: around(text, found[0].from, found[0].to), fix: id === "double-space" ? "Remove the extra spaces" : "Remove the spaces", data: { count: found.length } });
      });
      if (on("bad-ellipsis")) {
        const found = EDITS["bad-ellipsis"](text, layer, textCtx);
        if (found.length) {
          const first = text.slice(found[0].from, found[0].to);
          add("bad-ellipsis", entry, "", first.length === 2 ? "Two dots: an ellipsis has three" : "More than three dots in an ellipsis", null, { excerpt: around(text, found[0].from, found[0].to), fix: "Use three dots", data: { count: found.length } });
        }
      }
      if (on("exclamation-order")) {
        const found = EDITS["exclamation-order"](text, layer, textCtx);
        if (found.length) add("exclamation-order", entry, "", "“{found}” where the team writes “{wanted}”", { found: textCtx.order === "?!" ? "!?" : "?!", wanted: textCtx.order }, { excerpt: around(text, found[0].from, found[0].to), fix: "Swap the marks", data: { wanted: textCtx.order } });
      }
      if (on("many-marks")) {
        const m = /[!?]{4,}/.exec(text);
        if (m) add("many-marks", entry, "", "More than three ! or ? in a row", null, { excerpt: around(text, m.index, m.index + m[0].length) });
      }

      // Consistency, of the text itself
      if (on("no-anti-aliasing") && lt.antiAlias === "antiAliasNone") add("no-anti-aliasing", entry, "", "Anti-aliasing is set to None", null, { fix: "Smooth the letters" });
      if (on("faux-style")) {
        const styles = stylesOf(layer);
        const bold = styles.some((style) => style.syntheticBold);
        const italic = styles.some((style) => style.syntheticItalic);
        if (bold || italic) add("faux-style", entry, "", bold && italic ? "Faux Bold and Faux Italic are on" : bold ? "Faux Bold is on" : "Faux Italic is on");
      }
      if (on("text-scale")) {
        const limit = settings["text-scale"].limit;
        let worst = 100;
        stylesOf(layer).forEach((style) => {
          [style.horizontalScale, style.verticalScale].forEach((value) => {
            const v = Number(value);
            if (Number.isFinite(v) && v > 0 && Math.abs(v - 100) > Math.abs(worst - 100)) worst = v;
          });
        });
        if (Math.abs(worst - 100) > limit + 1e-9) add("text-scale", entry, "", worst < 100 ? "Text squeezed to {scale}%" : "Text stretched to {scale}%", { scale: round1(worst) }, { data: { scale: worst } });
      }
      if (on("off-page") && entry.box && entry.box.right > entry.box.left) {
        const b = entry.box;
        const slack = 2;
        const outside = b.right <= 0 || b.bottom <= 0 || b.left >= doc.width || b.top >= doc.height;
        if (outside) add("off-page", entry, "out", "This text is outside the page", null, { severity: "error", rect: rectOf(Math.max(0, Math.min(doc.width - 1, b.left)), Math.max(0, Math.min(doc.height - 1, b.top)), Math.max(1, Math.min(doc.width, b.right)), Math.max(1, Math.min(doc.height, b.bottom))) });
        else if (b.left < -slack || b.top < -slack || b.right > doc.width + slack || b.bottom > doc.height + slack) add("off-page", entry, "cut", "This text is cut by the edge of the page");
      }

      // Lines
      const shape = shapeOf(entry, doc);
      if (shape) {
        if (on("text-overflow") && shape.overflow && hiddenMatters(shape.hidden)) add("text-overflow", entry, "", "Part of this text doesn't fit in its text box and isn't shown", null, { data: { hidden: shape.hidden } });
        const lines = shape.lines;
        entry.lines = lines;
        entry.linesKnown = shape.known;
      }
      // What the lines say needs their text: unknown on a text whose pixels no fit explains
      if (shape && shape.known) {
        const lines = shape.lines;
        if (on("hyphen-start")) {
          const bad = lines.find((line, i) => i > 0 && /^\s*[-\u2010]\p{L}/u.test(line.text));
          if (bad) add("hyphen-start", entry, "", "A line starts with a hyphen", null, { excerpt: short(bad.text) });
        }
        const cuts = lines.filter((line) => line.cut);
        if (on("short-word-cut")) {
          const cut = cuts.find((line) => line.cut.word.length <= 4);
          if (cut) add("short-word-cut", entry, "", "A short word is cut across two lines: {word}", { word: `${cut.cut.left}-${cut.cut.right}` }, { excerpt: `${cut.cut.left}- / ${cut.cut.right}` });
        }
        if (on("many-cuts") && cuts.length > 1) add("many-cuts", entry, "", "{count} words of this text are cut across lines", { count: cuts.length }, { excerpt: cuts.map((line) => `${line.cut.left}-${line.cut.right}`).join(", ") });
        if (on("lone-punctuation") && lines.length > 1) {
          const alone = lines.find((line) => line.text.trim() && /^[\s\p{P}\p{S}]+$/u.test(line.text) && !LETTER.test(line.text));
          if (alone) add("lone-punctuation", entry, "", "A punctuation mark is alone on a line", null, { excerpt: short(alone.text) });
        }
      }
      await breathe();
    }

    // Bubbles and what's behind the texts
    // The page's usual text size: what "a letter's width" means for a text made only of
    // punctuation, which is often set much larger on purpose
    const usualSize = (() => {
      const sizes = dialogue.filter((entry) => LETTER.test(entry.text)).map((entry) => entry.sizePx).sort((a, b) => a - b);
      return sizes.length ? sizes[Math.floor(sizes.length / 2)] : null;
    })();
    if (flooder) {
      for (const entry of dialogue) {
        if (!entry.box || !entry.text.trim()) continue;
        // A text with a stroke or a glow is set over the art on purpose (a sign, a caption, an
        // SFX): it isn't checked against a bubble
        const aided = readableAid(entry);
        let bubble = null;
        try {
          bubble = aided ? null : bubbleOf(entry, pageCtx);
        } catch (error) {
          bubble = null;
        }
        entry.bubble = bubble;
        const marksOnly = !LETTER.test(entry.text) && !/\p{N}/u.test(entry.text);
        const size = marksOnly && usualSize ? Math.min(entry.sizePx, usualSize) : entry.sizePx;
        // Where the letters are: Photoshop's pixels can be a little larger than their ink
        const ink = entry.ink || null;
        const inkRect = ink && ink.rect ? ink.rect : entry.rect;
        const middle = entry.layer.raster && ink && ink.rect ? { x: (ink.rect.left + ink.rect.right) / 2, y: (ink.rect.top + ink.rect.bottom) / 2 } : { x: entry.box.xMid, y: entry.box.yMid };
        if (bubble && bubble.across) {
          if (on("bubble-spill")) add("bubble-spill", entry, "", "This text crosses the join between two bubbles", null, { rect: inkRect, data: { bubble: bubble.rect, share: bubble.share } });
        } else if (bubble) {
          const spill = bubble.outside > Math.max(6, bubble.inkCount * 0.01);
          if (spill && on("bubble-spill")) add("bubble-spill", entry, "", "This text goes past the edge of its bubble", null, { rect: inkRect, data: { bubble: bubble.rect, share: bubble.share } });
          else if (on("bubble-edge") && !bubble.rough) {
            const room = (settings["bubble-edge"].margin / 100) * size;
            if (bubble.outside > 0 || bubble.nearest <= 1.5) add("bubble-edge", entry, "", "This text touches the edge of its bubble", null, { rect: inkRect, data: { bubble: bubble.rect, space: 0, over: bubble.outside, nearest: round1(bubble.nearest) } });
            else if (bubble.nearest < room) add("bubble-edge", entry, "", "This text is very close to the edge of its bubble", null, { rect: inkRect, data: { bubble: bubble.rect, space: round1(bubble.nearest) } });
          }
          if (on("bubble-centre") && !spill && !bubble.rough && bubble.targets && bubble.targets.length && !entry.layer.warp) {
            const r = bubble.region;
            const tol = settings["bubble-centre"].tolerance / 100;
            const tolX = Math.max(3, size * 0.25, (r.right - r.left) * tol);
            const tolY = Math.max(3, size * 0.25, (r.bottom - r.top) * tol);
            const off = Math.min(...bubble.targets.map((t) => Math.max(Math.abs(middle.x - t.x) / tolX, Math.abs(middle.y - t.y) / tolY)));
            if (off > 1) {
              const target = bubble.targets[0];
              add("bubble-centre", entry, "", "This text is off centre in its bubble", null, { rect: inkRect, fix: "Centre in its bubble", data: { bubble: bubble.rect, x: round1(target.x + entry.box.xMid - middle.x), y: round1(target.y + entry.box.yMid - middle.y), dx: round1(target.x - middle.x), dy: round1(target.y - middle.y) } });
            }
          }
        }
        const inBubble = Boolean(bubble && bubble.share >= 0.9);
        if (bubble && bubble.across) entry.bubble = bubble = null;
        if (!inBubble && on("no-stroke") && !aided && busyBehind(entry, doc, data)) add("no-stroke", entry, "", "This text is over the art with no stroke or glow");
        if (on("low-contrast") && !aided) {
          const close = closeColours(entry, doc, data);
          if (close) add("low-contrast", entry, "", "This text's colour is too close to what is behind it", null, { data: { share: round1(close * 100) } });
        }
        // Shape, for texts in a bubble set centred
        const lines = entry.lines;
        const known = entry.linesKnown;
        const centred = ((entry.layer.params.layerText.paragraphStyleRange || [])[0] || { paragraphStyle: {} }).paragraphStyle.alignment;
        if (bubble && lines && lines.length >= 2 && (!centred || centred === "center")) {
          const widths = lines.map((line) => line.width);
          const last = lines[lines.length - 1];
          const words = entry.text.trim().split(/\s+/).length;
          if (on("lone-word") && known && words >= 4 && !/\s/.test(last.text.trim()) && LETTER.test(last.text) && last.width < 0.4 * widths[widths.length - 2]) add("lone-word", entry, "", "Only one word on the last line", null, { excerpt: short(last.text) });
          if (lines.length >= 3) {
            // Clearly: 40% longer than every line above, and by more than two letters
            const above = Math.max(...widths.slice(0, -1));
            if (on("last-line-longest") && last.width > above * 1.4 && last.width - above > size * 2) add("last-line-longest", entry, "", "The last line is longer than every line above it", null, { excerpt: known ? short(last.text) : short(entry.text) });
            if (on("hourglass")) {
              // Clearly shorter: under 60% of the shorter of its two neighbours
              const pinch = lines.findIndex((line, i) => i > 0 && i < lines.length - 1 && line.width < 0.6 * Math.min(widths[i - 1], widths[i + 1]));
              if (pinch > 0) add("hourglass", entry, "", "A line in the middle is much shorter than the lines around it", null, { excerpt: known ? short(lines[pinch].text) : short(entry.text) });
            }
          }
        }
        // A single word ("Cling", "Hein") is an exclamation or a sound; a caption's box (a place,
        // a title) needs no full stop either
        if (on("final-punctuation") && bubble && !bubble.boxy && LETTER.test(entry.text) && /\s/.test(entry.text.trim())) {
          const end = entry.text.replace(/[\s\u200B-\u200D\u2060\uFEFF]+$/u, "");
          if (!/[.!?\u2026~\u266A\u266B\u2665\u2661\u2764*,;:)\]}\u00BB\u00AB"\u201D\u2019'\u300D\u300F\-\u2010-\u2015\u30FB\u3002\uFF01\uFF1F]$/u.test(end) && !/\d$/.test(end)) add("final-punctuation", entry, "", "No punctuation at the end of the text", null, { excerpt: short(end.slice(-30)) });
        }
        await breathe();
      }
      flooder.release();
      if (!sampledBefore && ps.app.doc !== doc) {
        doc.sampleCache = null;
        doc.sampleKey = null;
      }
    }

    // Page-wide
    const written = dialogue.filter((entry) => entry.text.trim());
    if (on("mixed-ellipsis") && dots && ellipses) {
      written.forEach((entry) => {
        const found = EDITS["mixed-ellipsis"](entry.text, entry.layer, textCtx);
        if (found.length) add("mixed-ellipsis", entry, "", "This page mixes “…” and “...”: this text uses {form}", { form: textCtx.ellipsis === "…" ? "..." : "…" }, { excerpt: around(entry.text, found[0].from, found[0].to), fix: "Use the page's ellipsis", data: { want: textCtx.ellipsis } });
      });
    }
    if (on("duplicate-text")) {
      const groups = new Map();
      written.forEach((entry) => {
        const key = keyOf(entry.text);
        if (key.length < 2) return;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(entry);
      });
      groups.forEach((group, key) => {
        if (group.length < 2) return;
        const overlap = (a, b) => a.box && b.box && Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left) > 0 && Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top) > 0;
        const piled = group.some((a, i) => group.some((b, j) => j > i && overlap(a, b)));
        if (!piled && key.length < 20) return;
        const top = group[group.length - 1];
        const ids = group.map((entry) => entry.id);
        add("duplicate-text", top, ids.slice().sort().join("-"), "The same text is on the page {count} times", { count: group.length }, { layerIds: ids, data: { layerIds: ids } });
      });
    }
    if (on("lower-case")) {
      const cased = written.filter((entry) => (entry.text.match(/\p{Lu}|\p{Ll}/gu) || []).length >= 3 && entry.style.fontCaps !== "allCaps" && !capitalsOnly(entry.style));
      const lower = cased.filter((entry) => CASED_LOWER.test(entry.text));
      const upper = cased.length - lower.length;
      if (upper >= 3 && upper >= lower.length * 3) {
        lower.forEach((entry) => {
          const m = /\p{Ll}+/u.exec(entry.text);
          add("lower-case", entry, "", "Lower-case letters on a page written in capitals", null, { excerpt: around(entry.text, m.index, m.index + m[0].length), fix: "Change to capitals" });
        });
      }
    }
    if (on("other-script")) {
      let latin = 0;
      let other = 0;
      written.forEach((entry) => {
        latin += (entry.text.match(/[A-Za-z\u00C0-\u024F\u0400-\u04FF]/g) || []).length;
        other += (entry.text.match(OTHER_SCRIPT_ALL) || []).length;
      });
      if (latin > other * 2) {
        written.forEach((entry) => {
          const m = OTHER_SCRIPT.exec(entry.text);
          if (m) add("other-script", entry, "", "Characters from another script: {chars}", { chars: (entry.text.match(OTHER_SCRIPT_ALL) || []).slice(0, 8).join("") }, { excerpt: around(entry.text, m.index, m.index + m[0].length) });
        });
      }
    }
    if (on("size-outlier") || on("lone-font")) {
      const byFont = new Map();
      // Texts made only of punctuation ("!!!", "…?") are often set larger on purpose
      written.filter((entry) => LETTER.test(entry.text) || /\p{N}/u.test(entry.text)).forEach((entry) => {
        const key = entry.style.fontPostScriptName || entry.style.fontName || "";
        if (!byFont.has(key)) byFont.set(key, []);
        byFont.get(key).push(entry);
      });
      if (on("size-outlier")) {
        const limit = 1 + settings["size-outlier"].difference / 100;
        byFont.forEach((group) => {
          if (group.length < 4) return;
          const sizes = group.map((entry) => sizePt(entry.style)).sort((a, b) => a - b);
          const mid = sizes.length % 2 ? sizes[(sizes.length - 1) / 2] : (sizes[sizes.length / 2 - 1] + sizes[sizes.length / 2]) / 2;
          group.forEach((entry) => {
            const size = sizePt(entry.style);
            if (size > mid * limit || size < mid / limit) add("size-outlier", entry, "", "Text size {size} pt, while the other texts in {font} are about {usual} pt", { size: round1(size), font: fontName(entry.style), usual: round1(mid) }, { data: { size, usual: mid } });
          });
        });
      }
      if (on("lone-font") && written.length >= 5) {
        const shared = Array.from(byFont.values()).filter((group) => group.length > 1);
        const alone = Array.from(byFont.values()).filter((group) => group.length === 1);
        // Only in a bubble: over the art, a font of its own is an SFX or a sign
        if (shared.length && shared.length <= 3 && alone.length && alone.length <= 2) alone.forEach(([entry]) => { if (entry.bubble) add("lone-font", entry, "", "The only text in {font} on this page", { font: fontName(entry.style) }); });
      }
    }

    // The script
    const lines = Array.isArray(script) ? script.map((line) => String(line || "")).filter((line) => keyOf(line).length) : null;
    if (lines && lines.length && (on("script-line-missing") || on("not-in-script"))) {
      const keys = lines.map(keyOf);
      const texts = written.map((entry) => ({ entry, key: keyOf(entry.text) })).filter((item) => item.key);
      if (on("script-line-missing")) {
        keys.forEach((key, i) => {
          if (texts.some((item) => item.key.includes(key))) return;
          // A line split over several texts: those it holds cover most of it
          const parts = texts.filter((item) => item.key.length >= 3 && key.includes(item.key)).reduce((sum, item) => sum + item.key.length, 0);
          if (parts >= key.length * 0.8) return;
          add("script-line-missing", null, hash(key), "This script line is on no text of the page", null, { excerpt: short(lines[i], 80), rect: null, data: { line: lines[i], index: i } });
        });
      }
      if (on("not-in-script")) {
        texts.forEach((item) => {
          if (keys.some((key) => key.includes(item.key) || (item.key.length >= 3 && item.key.includes(key)))) return;
          let best = -1;
          let bestScore = 0;
          keys.forEach((key, i) => {
            const score = likeness(item.key, key);
            if (score > bestScore) {
              bestScore = score;
              best = i;
            }
          });
          add("not-in-script", item.entry, "", "This text matches no line of the script", null, { data: best >= 0 ? { closest: lines[best], index: best, likeness: Math.round(bestScore * 100) / 100 } : {} });
        });
      }
    }
    stopIfAsked();
    const order = new Map(RULES.map((rule, i) => [rule.id, i]));
    return issues.sort((a, b) => order.get(a.rule) - order.get(b.rule));
  };

  // A text with no ink: where it was clicked
  const pointRect = (layer, doc) => {
    const p = layer.params.layerText.textClickPoint;
    if (!p) return null;
    const x = (p.horizontal / 100) * doc.width;
    const y = (p.vertical / 100) * doc.height;
    return rectOf(x - 10, y - 10, x + 10, y + 10);
  };

  // Is the page behind a text drawing (lines, screentone), rather than a plain colour? The
  // share of pixels around and under its letters where the page changes sharply.
  const busyBehind = (entry, doc, data) => {
    if (!data) return false;
    const pad = Math.round(entry.sizePx * 0.3);
    const x0 = Math.max(0, Math.floor(entry.box.left - pad));
    const y0 = Math.max(0, Math.floor(entry.box.top - pad));
    const x1 = Math.min(doc.width - 1, Math.ceil(entry.box.right + pad));
    const y1 = Math.min(doc.height - 1, Math.ceil(entry.box.bottom + pad));
    if (x1 - x0 < 4 || y1 - y0 < 4) return false;
    const w = doc.width;
    const step = (x1 - x0) * (y1 - y0) > 400000 ? 2 : 1;
    let edges = 0;
    let count = 0;
    const lum = (p) => data[p * 4] * 0.299 + data[p * 4 + 1] * 0.587 + data[p * 4 + 2] * 0.114;
    for (let y = y0; y < y1; y += step) {
      for (let x = x0; x < x1; x += step) {
        const p = y * w + x;
        const l = lum(p);
        if (Math.abs(l - lum(p + 1)) > 48 || Math.abs(l - lum(p + w)) > 48) edges++;
        count++;
      }
    }
    return count > 0 && edges / count > 0.04;
  };

  // The share of what lies right under the letters whose colour is too close to the text's
  // (contrast ratio under 1.6), when that's a third of it or more; else 0
  const closeColours = (entry, doc, data) => {
    if (!data) return 0;
    const colour = textColourOf(entry.layer);
    if (!colour) return 0;
    const ink = inkOf(entry, doc);
    if (!ink || ink.xs.length < 20) return 0;
    const lt = luminance(colour[0], colour[1], colour[2]);
    const memo = new Map();
    let close = 0;
    let count = 0;
    const stride = ink.xs.length > 40000 ? Math.ceil(ink.xs.length / 40000) : 1;
    for (let i = 0; i < ink.xs.length; i += stride) {
      const x = ink.xs[i];
      const y = ink.ys[i];
      if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) continue;
      const p = (y * doc.width + x) * 4;
      const key = (data[p] << 16) | (data[p + 1] << 8) | data[p + 2];
      let lb = memo.get(key);
      if (lb === undefined) {
        lb = luminance(data[p], data[p + 1], data[p + 2]);
        memo.set(key, lb);
      }
      const ratio = (Math.max(lt, lb) + 0.05) / (Math.min(lt, lb) + 0.05);
      if (ratio < 1.6) close++;
      count++;
    }
    const share = count ? close / count : 0;
    return share >= 0.33 ? share : 0;
  };

  /* ----------------------------------- fix ----------------------------------- */

  const TEXT_FIXES = new Set(["double-space", "edge-space", "space-before-punctuation", "bad-ellipsis", "mixed-ellipsis", "exclamation-order", "lower-case"]);

  const fix = (doc, issue) => {
    const ps = PS();
    if (!doc || !issue || !issue.fix || !doc.state) return false;
    if (!ps.app.docs.includes(doc)) return false;
    const layer = issue.layerId != null ? doc.state.layers.find((item) => item.id === issue.layerId) : null;
    if (!layer) return false;
    const rule = issue.rule;
    if (ps.app.doc !== doc) ps.setActiveDoc(doc);
    if (ps.app.doc !== doc) return false;
    const ops = ps.ops;
    if (TEXT_FIXES.has(rule)) {
      if (layer.kind !== "text" || ps.lockOf(layer, "pixels") || layer.locked) return false;
      const text = String(layer.params.layerText.textKey || "");
      const ctx = { order: (issue.data && issue.data.wanted) || "?!" };
      if (rule === "mixed-ellipsis") ctx.ellipsis = issue.data && issue.data.want;
      if (rule === "bad-ellipsis") {
        // The page's own way of writing an ellipsis
        let dots = 0;
        let ellipses = 0;
        doc.state.layers.forEach((item) => {
          if (item.kind !== "text") return;
          const t = String(item.params.layerText.textKey || "");
          dots += (t.match(/(?<!\.)\.\.\.(?!\.)/g) || []).length;
          ellipses += (t.match(/\u2026/g) || []).length;
        });
        ctx.ellipsis = ellipses > dots ? "…" : "...";
      }
      const edits = EDITS[rule](text, layer, ctx);
      if (!edits.length) return false;
      const next = editedLayer(layer, edits);
      if (next.params.layerText.textKey === text) return false;
      ops.setLayers(doc.state.layers.map((item) => (item.id === layer.id ? next : item)), "Edit Type");
      return true;
    }
    if (rule === "bubble-centre") {
      if (layer.warp || layer.locked || ps.lockOf(layer, "position")) return false;
      const x = Number(issue.data && issue.data.x);
      const y = Number(issue.data && issue.data.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
      const box = ps.boxOf(layer, doc);
      if (Math.abs(box.xMid - x) < 0.5 && Math.abs(box.yMid - y) < 0.5) return false;
      const moved = ps.centredOn(layer, doc, x, y);
      if (moved === layer) return false;
      ops.setLayers(doc.state.layers.map((item) => (item.id === layer.id ? moved : item)), "TyperTools Align");
      return true;
    }
    if (rule === "hidden-text") {
      if (layer.visible !== false) return false;
      ops.setLayerProps(layer.id, { visible: true }, "Show Layer");
      return true;
    }
    if (rule === "empty-text") {
      if (layer.kind !== "text" || layer.locked) return false;
      if (String(layer.params.layerText.textKey || "").replace(/[\s\u200B-\u200D\u2060\uFEFF]/g, "")) return false;
      const layers = doc.state.layers.filter((item) => item.id !== layer.id);
      const activeIds = doc.state.activeIds.filter((id) => id !== layer.id);
      ops.setLayers(layers, "Delete Layer", { activeIds });
      return true;
    }
    if (rule === "no-anti-aliasing") {
      if (layer.kind !== "text" || layer.params.layerText.antiAlias !== "antiAliasNone" || layer.locked) return false;
      ops.setTextAntiAlias([layer.id], "antiAliasSmooth");
      return true;
    }
    return false;
  };

  // The lines a text shows on the page, for the proofreading review (verify.js): Photoshop's
  // pixels with the words each holds, or TypeR's own layout
  const linesShown = (doc, layer) => {
    if (!doc || !layer || layer.kind !== "text" || !layer.params || !layer.params.layerText) return null;
    const style = styleOf(layer);
    try {
      return shapeOf({ layer, id: layer.id, text: String(layer.params.layerText.textKey || ""), style, sizePx: sizePx(style, doc) }, doc);
    } catch (error) {
      return null;
    }
  };

  // The bubble around a text, found as the checks find it, for the review's card to stay off
  // it: its rectangle in page pixels, or null when the text isn't in one
  const bubbleShown = (doc, layer) => {
    try {
      const entries = textsOf(doc);
      const entry = entries.find((one) => one.id === layer.id);
      if (!entry || !entry.box) return null;
      const found = bubbleOf(entry, { doc, flooder: makeFlooder(doc, PS().sampleData(doc, true)), entries });
      return found && !found.rough ? found.rect : null;
    } catch (error) {
      return null;
    }
  };

  window.TypeRVerify = { CATEGORIES, RULES, defaults, check, fix, linesShown, bubbleShown };
})();
