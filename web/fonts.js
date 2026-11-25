// The fonts of the Web Version. Four faces ship with the page. Fonts installed
// on the computer are reached by name through local(), and font files the user
// loads are kept in the browser (IndexedDB). Nothing is uploaded anywhere.

(function () {
  "use strict";

  const BUILTIN = [
    { name: "Wildjess Normal", postScriptName: "WildjessNormal", family: "Wildjess", style: "Normal", weight: 400, italic: false, file: "wildjess-normal" },
    { name: "Wildjess Italic", postScriptName: "WildjessItalic", family: "Wildjess", style: "Italic", weight: 400, italic: true, file: "wildjess-italic" },
    { name: "Wildjess BoldItalic", postScriptName: "WildjessBoldItalic", family: "Wildjess", style: "BoldItalic", weight: 700, italic: true, file: "wildjess-bolditalic" },
    { name: "Bangers", postScriptName: "Bangers-Regular", family: "Bangers", style: "Regular", weight: 400, italic: false, file: "bangers-400" },
  ];

  const fonts = new Map(); // PostScript name -> font
  const normalize = (value) => String(value || "").toLowerCase().replace(/[\s\-_.,]+/g, "");
  const missing = new Set();
  const pending = new Map();
  const listeners = new Set();
  let generation = 0;
  // Counts each change of the Map itself, even between two changed(): what is computed from
  // it below (the names index, resolve's answers, the list) is never behind it
  let version = 0;
  const put = (ps, font) => {
    fonts.set(ps, font);
    version++;
  };
  const drop = (ps) => {
    fonts.delete(ps);
    version++;
  };

  BUILTIN.forEach((font) => put(font.postScriptName, Object.assign({ source: "builtin", css: font.family, ready: true }, font)));

  const changed = () => {
    generation++;
    listeners.forEach((listener) => listener());
  };

  const cssNameOf = (ps) => "TR-" + String(ps).replace(/[^\w-]/g, "_");
  const quote = (name) => `"${String(name).replace(/["\\]/g, "")}"`;

  // A font found on the computer by its PostScript name alone has no family of its own: it's
  // filed under that name (guessed), until a text style or the computer's list of fonts says
  // which family and style it is. Without that, the Font style list can't find it in its family.
  const realName = (family, ps) => Boolean(family) && family !== ps;
  const nameFont = (ps, family, style) => {
    const known = fonts.get(ps);
    if (!known || !known.guessed || !realName(family, ps)) return false;
    put(ps, Object.assign({}, known, { family, style: style || "Regular", guessed: false }));
    return true;
  };

  // A font known by name but not loaded yet: the browser looks it up on the computer.
  // family and style: what a text style calls it, when it says.
  const ensure = (ps, fullName, family, style) => {
    if (!ps) return Promise.resolve(false);
    const known = fonts.get(ps);
    if (known && known.ready) {
      if (nameFont(ps, family, style)) changed();
      return Promise.resolve(true);
    }
    if (sameFont(ps)) return Promise.resolve(true);
    if (pending.has(ps)) return pending.get(ps);
    const stored = known && known.source === "file" ? known : storedFont(ps, fullName);
    if (stored) return loadStored(stored.postScriptName);
    if (missing.has(ps)) return Promise.resolve(false);
    const names = [ps, fullName, known && known.name].filter(Boolean);
    const css = cssNameOf(ps);
    const src = names.map((name) => `local(${quote(name)})`).join(", ");
    const face = new FontFace(css, src);
    const promise = face.load().then(() => {
      document.fonts.add(face);
      const named = realName(family, ps);
      put(ps, Object.assign({ name: fullName || ps, postScriptName: ps, family: named ? family : ps, style: (named && style) || "Regular", guessed: !named && !known, source: "local", weight: 400, italic: false }, known, { css, src, ready: true }));
      missing.delete(ps);
      pending.delete(ps);
      changed();
      return true;
    }, () => {
      missing.add(ps);
      pending.delete(ps);
      changed();
      return false;
    });
    pending.set(ps, promise);
    return promise;
  };

  // The fonts by their names, as TypeR matches them (spelling differences aside), and by
  // their exact family and style. A text is looked up for each run drawn, and the computer
  // can have thousands of fonts: the index is built once per change of the Map, not per look-up
  let index = null;
  let indexVersion = -1;
  const indexOf = () => {
    if (index && indexVersion === version) return index;
    const ready = { ps: new Map(), name: new Map(), familyStyle: new Map(), family: new Map(), exact: new Map() };
    const stored = { ps: new Map(), name: new Map(), familyStyle: new Map() };
    const order = new Map();
    const add = (map, key, font) => {
      if (key && !map.has(key)) map.set(key, font);
    };
    let at = 0;
    for (const font of fonts.values()) {
      order.set(font, at++);
      const into = font.ready ? ready : font.source === "file" ? stored : null;
      if (!into) continue;
      add(into.ps, normalize(font.postScriptName), font);
      add(into.name, normalize(font.name), font);
      add(into.familyStyle, normalize(`${font.family}${font.style}`), font);
      if (!font.ready) continue;
      if (!ready.family.has(font.family)) ready.family.set(font.family, font);
      const exact = `${font.family}\u0000${font.style}`;
      if (!ready.exact.has(exact)) ready.exact.set(exact, font);
    }
    index = { ready, stored, order };
    indexVersion = version;
    return index;
  };
  // The first font added that matches by one of its names
  const firstNamed = (maps, ps, family, style) => {
    const wanted = normalize(ps);
    const full = normalize(`${family || ""}${style || ""}`);
    const { order } = indexOf();
    let best = null;
    const consider = (font) => {
      if (font && (!best || order.get(font) < order.get(best))) best = font;
    };
    if (wanted) consider(maps.ps.get(wanted));
    if (full) {
      consider(maps.name.get(full));
      consider(maps.familyStyle.get(full));
    }
    return best;
  };

  // A file kept in this browser, known by its name until it's needed
  const storedFont = (ps, family, style) => firstNamed(indexOf().stored, ps, family, style);
  const loadStored = (ps) => {
    if (pending.has(ps)) return pending.get(ps);
    const promise = (async () => {
      const db = await openStore();
      const row = await new Promise((done, fail) => {
        const request = db.transaction(STORE).objectStore(STORE).get(ps);
        request.onsuccess = () => done(request.result);
        request.onerror = () => fail(request.error);
      });
      if (!row) throw new Error("This font's file is gone");
      await addBuffer(row.buffer.slice(0), row.name);
      return true;
    })().catch((error) => {
      console.warn("TypeR web: could not load a kept font", ps, error);
      drop(ps);
      missing.add(ps);
      return false;
    }).then((loaded) => {
      pending.delete(ps);
      changed();
      return loaded;
    });
    pending.set(ps, promise);
    return promise;
  };

  // The same font under a slightly different spelling, as TypeR matches them
  const sameFont = (ps, family, style) => firstNamed(indexOf().ready, ps, family, style);

  // What to draw a text style with, right now. An unknown font starts loading and
  // the page is drawn again when it arrives. The answer for a font that isn't there is
  // kept until the fonts change: it's asked for each run drawn, and the loading it
  // starts is only started once.
  const resolved = new Map();
  let resolvedVersion = -1;
  const resolve = (textStyle) => {
    const ps = textStyle.fontPostScriptName;
    const known = ps && fonts.get(ps);
    if (known && known.ready) {
      // Loaded by its name alone (a style's text, before it was drawn): its text style knows
      // its family. Said after the drawing, which the change starts again.
      if (known.guessed && nameFont(ps, textStyle.fontName, textStyle.fontStyleName)) {
        queueMicrotask(changed);
        return fonts.get(ps);
      }
      return known;
    }
    if (resolvedVersion !== version) {
      resolved.clear();
      resolvedVersion = version;
    }
    const key = `${ps || ""}\u0000${textStyle.fontName || ""}\u0000${textStyle.fontStyleName || ""}`;
    const kept = resolved.get(key);
    if (kept) return kept;
    let found = sameFont(ps, textStyle.fontName, textStyle.fontStyleName);
    if (!found) {
      const stored = storedFont(ps, textStyle.fontName, textStyle.fontStyleName);
      if (stored) loadStored(stored.postScriptName);
      else if (ps) ensure(ps, textStyle.fontName, textStyle.fontName, textStyle.fontStyleName);
      const { ready } = indexOf();
      const name = textStyle.fontName || "";
      const byName = textStyle.fontStyleName ? ready.exact.get(`${name}\u0000${textStyle.fontStyleName}`) : ready.family.get(name);
      found = byName || { css: "Wildjess", weight: 400, italic: false, fallback: true };
    }
    resolved.set(key, found);
    return found;
  };

  // Photoshop's OpenType switches, where a canvas has no switch for a font's features: such
  // text is drawn with a twin of its font, made for it.
  // - With Standard ligatures off, Photoshop turns off the font's whole "liga" feature, and with
  //   it the letter variants some lettering fonts keep there (a doubled letter drawn another way).
  // - With Contextual alternates off, its "calt" feature: the capital I a comic font draws with
  //   crossbars only where it stands alone comes out with them everywhere.
  // - With them on, Photoshop keeps the feature whatever the tracking, where the browser drops it
  //   as soon as the letters are spaced (tracking, Faux Bold): the twin has the feature filed
  //   under another name, one the browser always applies. That twin is made from the font's
  //   file: a font reached by its name alone, before the computer's fonts are listed, and the
  //   fonts that ship with the page (none has the feature) go without.
  // Until a twin is there, the font itself is used, and the page is drawn again after.
  const twins = new Map(); // a twin's CSS name -> true once it is there, null while it loads, false if it can't
  const sourceOf = (font) => {
    if (font.source === "builtin") return `url("../assets/fonts/${font.file}.woff2")`;
    if (font.source === "file") return font.url ? `url(${quote(font.url)})` : null;
    return font.src || null;
  };
  const twinOf = (font, suffix, source, features) => {
    const css = `${font.css}--${suffix}`;
    if (twins.has(css)) return twins.get(css) ? css : null;
    if (!source) {
      twins.set(css, false);
      return null;
    }
    twins.set(css, null);
    const descriptors = { featureSettings: features };
    if (font.source === "builtin") Object.assign(descriptors, { weight: String(font.weight), style: font.italic ? "italic" : "normal" });
    const face = new FontFace(css, source, descriptors);
    face.load().then(() => {
      document.fonts.add(face);
      twins.set(css, true);
      changed();
    }, (error) => {
      console.warn("TypeR web: could not make a font's twin", css, error);
      twins.set(css, false);
    });
    return null;
  };

  // A font's file, when it can be read here: a font file kept in the browser, or an installed
  // font once the computer's fonts are listed
  const bytesOf = (font) => {
    if (font.source === "file") return font.url ? fetch(font.url).then((response) => response.arrayBuffer()) : null;
    const ps = font.postScriptName;
    const entry = font.source === "local" ? installedData.get(ps) : null;
    if (!entry || typeof entry.blob !== "function") return null;
    // A collection holds several fonts: this one is found by its name
    return entry.blob().then((blob) => blob.arrayBuffer()).then((buffer) => splitCollection(buffer).find((part) => {
      try {
        return readNames(part).ps === ps;
      } catch (error) {
        return false;
      }
    }) || buffer);
  };
  // The sum a font file keeps of each of its tables, and of itself
  const sumOf = (data, from, length) => {
    let sum = 0;
    for (let at = from; at < from + length; at += 4) {
      let word = 0;
      for (let k = 0; k < 4; k++) word = word * 256 + (at + k < from + length && at + k < data.byteLength ? data.getUint8(at + k) : 0);
      sum = (sum + word) >>> 0;
    }
    return sum;
  };
  // Tags the browser applies to every text, spaced or not, in the order they are tried
  const KEPT_TAGS = ["rclt", "rlig", "ccmp", "locl"];
  // Whether a font file has contextual alternates (`calt`) and, when it has, a copy of the
  // file where they are filed under a tag the browser never drops (`kept`; null when every
  // such tag is taken)
  const readAlternates = (buffer) => {
    const data = new DataView(buffer);
    const tag = (at) => String.fromCharCode(data.getUint8(at), data.getUint8(at + 1), data.getUint8(at + 2), data.getUint8(at + 3));
    const count = data.getUint16(4);
    let entry = -1;
    for (let i = 0; i < count; i++) if (tag(12 + i * 16) === "GSUB") entry = 12 + i * 16;
    if (entry < 0) return { calt: false, kept: null };
    const gsub = data.getUint32(entry + 8);
    const list = gsub + data.getUint16(gsub + 6);
    const records = [];
    const taken = new Set();
    for (let i = 0; i < data.getUint16(list); i++) {
      const at = list + 2 + i * 6;
      if (tag(at) === "calt") records.push(at);
      else taken.add(tag(at));
    }
    if (!records.length) return { calt: false, kept: null };
    const free = KEPT_TAGS.find((name) => !taken.has(name));
    if (!free) return { calt: true, kept: null };
    const kept = buffer.slice(0);
    const out = new DataView(kept);
    records.forEach((at) => {
      for (let k = 0; k < 4; k++) out.setUint8(at + k, free.charCodeAt(k));
    });
    // The file's sums follow, as a font file's reader may check them
    out.setUint32(entry + 4, sumOf(out, gsub, out.getUint32(entry + 12)));
    for (let i = 0; i < count; i++) {
      if (tag(12 + i * 16) !== "head") continue;
      const head = out.getUint32(12 + i * 16 + 8);
      out.setUint32(head + 8, 0);
      out.setUint32(12 + i * 16 + 4, sumOf(out, head, out.getUint32(12 + i * 16 + 12)));
      out.setUint32(head + 8, (0xb1b0afba - sumOf(out, 0, out.byteLength)) >>> 0);
    }
    return { calt: true, kept };
  };
  const NO_ALTERNATES = { calt: false, kept: null };
  const alternates = new Map(); // PostScript name -> what readAlternates found, null while the file is read
  // undefined when the font's file can't be read here
  const alternatesOf = (font) => {
    if (font.source === "builtin") return NO_ALTERNATES;
    const ps = font.postScriptName;
    if (alternates.has(ps)) return alternates.get(ps);
    const bytes = bytesOf(font);
    if (!bytes) return undefined;
    alternates.set(ps, null);
    bytes.then(readAlternates).catch((error) => {
      console.warn("TypeR web: could not read a font's contextual alternates", ps, error);
      // Not known: it may have some, and no twin keeps them
      return { calt: true, kept: null };
    }).then((found) => {
      alternates.set(ps, found);
      changed();
    });
    return null;
  };

  // The CSS name of the twin a text is drawn with, or null for the font itself. `ligatures` and
  // `contextual`: Standard ligatures and Contextual alternates, as the text's style has them;
  // `spaced`: its letters are set apart (the browser then drops the alternates by itself).
  const variantOf = (font, ligatures, contextual, spaced) => {
    if (!font || !font.ready || !font.postScriptName) return null;
    const plain = ligatures ? null : twinOf(font, "noliga", sourceOf(font), '"liga" 0');
    // The browser does as asked already
    if (contextual !== spaced) return plain;
    const found = alternatesOf(font);
    if (contextual) return (found && found.kept && twinOf(font, ligatures ? "calt" : "noliga-calt", found.kept, ligatures ? "normal" : '"liga" 0')) || plain;
    if (found && !found.calt) return plain;
    return twinOf(font, ligatures ? "nocalt" : "noliga-nocalt", sourceOf(font), ligatures ? '"calt" 0' : '"liga" 0, "calt" 0') || plain;
  };

  const isMissing = (ps) => Boolean(ps) && missing.has(ps) && !(fonts.get(ps) && fonts.get(ps).ready) && !sameFont(ps);

  const ready = (names) => Promise.all(Array.from(new Set(names)).filter(Boolean).map((ps) => ensure(ps)));

  const builtinsLoaded = () => Promise.all(BUILTIN.map((font) => document.fonts.load(`${font.italic ? "italic " : ""}${font.weight} 32px "${font.family}"`))).catch(() => []);

  // Sorted once per change of the fonts: the menus ask for it often
  let listed = null;
  let listedVersion = -1;
  const list = () => {
    if (!listed || listedVersion !== version) {
      listed = Array.from(fonts.values()).filter((font) => font.source !== "local" || font.listed !== false).sort((a, b) => a.family.localeCompare(b.family) || a.style.localeCompare(b.style));
      listedVersion = version;
    }
    return listed;
  };

  /* --------------------------- a font's own measures --------------------------- */

  // Photoshop bends a warped text over its bounds, which it measures with two numbers of the
  // font's file: the height of its capitals (OS/2 sCapHeight) and how low its lowest letter
  // goes (the font's bounding box: CFF FontBBox, else head yMin). In parts of the size: `cap`
  // (null when the file doesn't say: Photoshop then measures a capital) and `bottom`.
  // Photoshop also kerns a line's last letter with the return that ends it, as with a space:
  // `spaceKerns` is the `kern` table's pairs with a space, by letter (null without that table:
  // the browser's own kerning says).
  const readMeasures = (buffer) => {
    const data = new DataView(buffer);
    const tables = {};
    const count = data.getUint16(4);
    for (let i = 0; i < count; i++) {
      const at = 12 + i * 16;
      tables[String.fromCharCode(data.getUint8(at), data.getUint8(at + 1), data.getUint8(at + 2), data.getUint8(at + 3))] = data.getUint32(at + 8);
    }
    if (tables.head === undefined) return null;
    const em = data.getUint16(tables.head + 18);
    if (!em) return null;
    let lowest = data.getInt16(tables.head + 38);
    const box = tables["CFF "] === undefined ? null : cffBox(data, tables["CFF "]);
    if (box) lowest = box[1];
    const os2 = tables["OS/2"];
    const cap = os2 !== undefined && data.getUint16(os2) >= 2 ? data.getInt16(os2 + 88) : 0;
    let spaceKerns = null;
    try {
      spaceKerns = tables.kern === undefined || tables.cmap === undefined ? null : kernsWithSpace(data, tables.cmap, tables.kern, em);
    } catch (error) {
      spaceKerns = null;
    }
    return { cap: cap > 0 ? cap / em : null, bottom: -lowest / em, spaceKerns };
  };
  // The pairs of a `kern` table (format 0) whose second letter is the space: letter -> kerning,
  // in parts of the size. Letters are found through the Unicode `cmap` (format 4).
  const kernsWithSpace = (data, cmap, kern, em) => {
    let sub = -1;
    for (let i = 0; i < data.getUint16(cmap + 2); i++) {
      const platform = data.getUint16(cmap + 4 + i * 8);
      const at = cmap + data.getUint32(cmap + 8 + i * 8);
      if ((platform === 3 || platform === 0) && data.getUint16(at) === 4) sub = at;
    }
    if (sub < 0) return null;
    const segments = data.getUint16(sub + 6) / 2;
    const ends = sub + 14;
    const starts = ends + segments * 2 + 2;
    const deltas = starts + segments * 2;
    const ranges = deltas + segments * 2;
    // Each glyph's first letter
    const letters = new Map();
    for (let i = 0; i < segments; i++) {
      const start = data.getUint16(starts + i * 2);
      const end = Math.min(data.getUint16(ends + i * 2), 0xfffe);
      const delta = data.getInt16(deltas + i * 2);
      const range = data.getUint16(ranges + i * 2);
      for (let code = start; code <= end; code++) {
        let glyph = (code + delta) & 0xffff;
        if (range) {
          glyph = data.getUint16(ranges + i * 2 + range + (code - start) * 2);
          if (glyph) glyph = (glyph + delta) & 0xffff;
        }
        if (glyph && !letters.has(glyph)) letters.set(glyph, code);
      }
    }
    let space = 0;
    letters.forEach((code, glyph) => {
      if (code === 32) space = glyph;
    });
    const out = new Map();
    if (!space) return out;
    let at = kern + 4;
    for (let t = 0; t < data.getUint16(kern + 2); t++) {
      const length = data.getUint16(at + 2);
      const coverage = data.getUint16(at + 4);
      // Horizontal kerning, in pairs
      if (coverage >> 8 === 0 && (coverage & 1) && !(coverage & 4)) {
        const pairs = data.getUint16(at + 6);
        for (let n = 0; n < pairs; n++) {
          const pair = at + 14 + n * 6;
          if (data.getUint16(pair + 2) !== space) continue;
          const code = letters.get(data.getUint16(pair));
          if (code !== undefined) out.set(String.fromCharCode(code), data.getInt16(pair + 4) / em);
        }
      }
      if (!length) break;
      at += length;
    }
    return out;
  };
  // FontBBox in a CFF table's Top DICT: [left, bottom, right, top]
  const cffBox = (data, start) => {
    const index = (at) => {
      const count = data.getUint16(at);
      if (!count) return { end: at + 2, items: [] };
      const size = data.getUint8(at + 2);
      const offsets = [];
      for (let i = 0; i <= count; i++) {
        let value = 0;
        for (let k = 0; k < size; k++) value = value * 256 + data.getUint8(at + 3 + i * size + k);
        offsets.push(value);
      }
      const base = at + 3 + (count + 1) * size - 1;
      return { end: base + offsets[count], items: offsets.slice(0, -1).map((offset, i) => [base + offset, base + offsets[i + 1]]) };
    };
    const top = index(index(start + data.getUint8(start + 2)).end).items[0];
    if (!top) return null;
    const stack = [];
    let p = top[0];
    while (p < top[1]) {
      const b = data.getUint8(p++);
      if (b <= 21) {
        if (b === 12) p++;
        else if (b === 5) return stack.length >= 4 ? stack.slice(-4) : null;
        stack.length = 0;
      } else if (b === 28) {
        stack.push(data.getInt16(p));
        p += 2;
      } else if (b === 29) {
        stack.push(data.getInt32(p));
        p += 4;
      } else if (b === 30) {
        let text = "";
        for (let done = false; !done && p < top[1];) {
          const pair = data.getUint8(p++);
          [pair >> 4, pair & 15].forEach((n) => {
            if (done) return;
            if (n === 15) done = true;
            else text += n < 10 ? n : n === 10 ? "." : n === 11 ? "E" : n === 12 ? "E-" : n === 14 ? "-" : "";
          });
        }
        stack.push(parseFloat(text));
      } else if (b >= 32 && b <= 246) stack.push(b - 139);
      else if (b >= 247 && b <= 250) stack.push((b - 247) * 256 + data.getUint8(p++) + 108);
      else if (b >= 251 && b <= 254) stack.push(-(b - 251) * 256 - data.getUint8(p++) - 108);
    }
    return null;
  };
  // The fonts that ship with the page are compressed: their measures, read from the files
  const measures = new Map([["WildjessNormal", { cap: null, bottom: 0.237 }], ["WildjessItalic", { cap: 0.771, bottom: 0.241 }], ["WildjessBoldItalic", { cap: null, bottom: 0.255 }], ["Bangers-Regular", { cap: 0.721, bottom: 0.356 }]]);
  const installedData = new Map(); // PostScript name -> what the computer lists of an installed font
  // A font's measures, or null while they aren't known: a font file's are read as it loads, an
  // installed font's from its file once the computer's fonts are listed (the page is drawn
  // again when they arrive). Reached by name alone, an installed font keeps its file to itself.
  const measuresOf = (font) => {
    const ps = font && font.postScriptName;
    if (!ps) return null;
    if (measures.has(ps)) return measures.get(ps);
    const entry = font.source === "local" ? installedData.get(ps) : null;
    if (!entry || typeof entry.blob !== "function") return null;
    measures.set(ps, null);
    entry.blob().then((blob) => blob.arrayBuffer()).then((buffer) => {
      // A collection holds several fonts: this one is found by its name
      const piece = splitCollection(buffer).find((part) => {
        try {
          return readNames(part).ps === ps;
        } catch (error) {
          return false;
        }
      });
      const found = readMeasures(piece || buffer);
      if (!found) return;
      measures.set(ps, found);
      changed();
    }).catch(() => null);
    return null;
  };

  /* ---------------------- fonts installed on the computer ---------------------- */

  const canListInstalled = () => typeof window.queryLocalFonts === "function";

  // Only news is told: listing the same fonts again changes nothing
  const addInstalled = (entries, first) => {
    let added = 0;
    entries.forEach((entry) => {
      const ps = entry.postscriptName;
      if (!ps) return;
      installedData.set(ps, entry);
      const known = fonts.get(ps);
      if (known) {
        // Loaded by its name before the list was read: it takes the family and style the
        // computer gives it, and stays loaded
        if (known.source === "local" && entry.family && (known.family !== entry.family || known.style !== (entry.style || "Regular") || known.guessed)) {
          put(ps, Object.assign({}, known, { name: entry.fullName || known.name, family: entry.family, style: entry.style || "Regular", guessed: false }));
          added++;
        }
        return;
      }
      put(ps, { name: entry.fullName || ps, postScriptName: ps, family: entry.family || ps, style: entry.style || "Regular", source: "local", css: cssNameOf(ps), weight: 400, italic: false, ready: false });
      added++;
    });
    if (added || first) changed();
  };

  let installedListed = false;
  const useInstalled = async () => {
    if (!canListInstalled()) return 0;
    const entries = await window.queryLocalFonts();
    const first = !installedListed;
    installedListed = true;
    addInstalled(entries, first);
    return entries.length;
  };

  /* ------------------------- font files, kept in the browser ------------------------- */

  // The name table of a TrueType or OpenType file
  const readNames = (buffer) => {
    const data = new DataView(buffer);
    const tag = (at) => String.fromCharCode(data.getUint8(at), data.getUint8(at + 1), data.getUint8(at + 2), data.getUint8(at + 3));
    const count = data.getUint16(4);
    for (let i = 0; i < count; i++) {
      const at = 12 + i * 16;
      if (tag(at) !== "name") continue;
      const table = data.getUint32(at + 8);
      const records = data.getUint16(table + 2);
      const strings = table + data.getUint16(table + 4);
      const out = {};
      for (let r = 0; r < records; r++) {
        const entry = table + 6 + r * 12;
        const platform = data.getUint16(entry);
        const id = data.getUint16(entry + 6);
        const length = data.getUint16(entry + 8);
        const offset = strings + data.getUint16(entry + 10);
        if (![1, 2, 4, 6, 16, 17].includes(id)) continue;
        let text = "";
        if (platform === 1) {
          for (let c = 0; c < length; c++) text += String.fromCharCode(data.getUint8(offset + c));
        } else {
          for (let c = 0; c + 1 < length; c += 2) text += String.fromCharCode(data.getUint16(offset + c));
        }
        if (!out[id] || platform === 3) out[id] = text;
      }
      return { family: out[16] || out[1], style: out[17] || out[2], full: out[4], ps: out[6] };
    }
    return {};
  };

  // The browser's database: font files here, TypeR's own files in kit.js
  const STORE = "fonts";
  let opening = null;
  // `again`: the one kept turned out closed, a new one is opened
  const openStore = (again) => {
    if (again) opening = null;
    if (!opening) {
      const mine = new Promise((done, fail) => {
        const request = indexedDB.open("typer-web", 2);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "ps" });
          if (!db.objectStoreNames.contains("files")) db.createObjectStore("files", { keyPath: "path" });
        };
        request.onsuccess = () => {
          const db = request.result;
          // Closed by the browser (its data cleared, a disk error), or wanted newer by another
          // tab: the next call opens it again
          const drop = () => { if (opening === mine) opening = null; };
          db.onclose = drop;
          db.onversionchange = () => {
            db.close();
            drop();
          };
          done(db);
        };
        request.onerror = () => fail(request.error);
      });
      opening = mine;
      mine.catch(() => { if (opening === mine) opening = null; });
    }
    return opening;
  };

  // A .ttc holds several fonts: each one becomes a font file of its own
  const splitCollection = (buffer) => {
    const data = new DataView(buffer);
    if (data.getUint32(0) !== 0x74746366) return [buffer]; // 'ttcf'
    const out = [];
    const count = Math.min(data.getUint32(8), 64);
    for (let i = 0; i < count; i++) {
      const base = data.getUint32(12 + i * 4);
      const tables = data.getUint16(base + 4);
      let size = 12 + tables * 16;
      for (let t = 0; t < tables; t++) size += (data.getUint32(base + 12 + t * 16 + 12) + 3) & ~3;
      const piece = new Uint8Array(size);
      const target = new DataView(piece.buffer);
      piece.set(new Uint8Array(buffer, base, 12 + tables * 16), 0);
      let at = 12 + tables * 16;
      for (let t = 0; t < tables; t++) {
        const record = base + 12 + t * 16;
        const length = data.getUint32(record + 12);
        piece.set(new Uint8Array(buffer, data.getUint32(record + 8), length), at);
        target.setUint32(12 + t * 16 + 8, at);
        at += (length + 3) & ~3;
      }
      out.push(piece.buffer);
    }
    return out;
  };

  const addBuffer = async (buffer, fallbackName) => {
    let names = {};
    try {
      names = readNames(buffer);
    } catch (error) {
      names = {};
    }
    const base = String(fallbackName || "Font").replace(/\.[^.]+$/, "");
    const ps = names.ps || base.replace(/\s+/g, "");
    const css = cssNameOf(ps);
    const face = new FontFace(css, buffer);
    await face.load();
    document.fonts.add(face);
    try {
      measures.set(ps, readMeasures(buffer));
    } catch (error) {
      measures.set(ps, null);
    }
    const font = { name: names.full || base, postScriptName: ps, family: names.family || base, style: names.style || "Regular", source: "file", css, weight: 400, italic: false, ready: true, size: buffer.byteLength, url: URL.createObjectURL(new Blob([buffer])) };
    put(ps, font);
    missing.delete(ps);
    return font;
  };

  // Files or { name, buffer }. A font that can't be read doesn't stop the others.
  const addFiles = async (files) => {
    const added = [];
    const failed = [];
    const notKept = [];
    const db = await openStore().catch(() => null);
    for (const file of Array.from(files)) {
      const buffer = file.buffer || await file.arrayBuffer();
      let pieces;
      try {
        pieces = splitCollection(buffer);
      } catch (error) {
        failed.push(file.name);
        continue;
      }
      for (const piece of pieces) {
        try {
          const font = await addBuffer(piece.slice(0), file.name);
          added.push(font);
          if (db) {
            const kept = await new Promise((done) => {
              const tx = db.transaction(STORE, "readwrite");
              tx.objectStore(STORE).put({ ps: font.postScriptName, name: file.name, buffer: piece });
              tx.oncomplete = () => done(true);
              tx.onerror = () => done(false);
              tx.onabort = () => done(false);
            });
            if (kept) await keepInfo(infoOf(font, file.name));
            else notKept.push(file.name);
          }
        } catch (error) {
          failed.push(file.name);
        }
      }
    }
    if (added.length && navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => false);
    changed();
    if (!db) notKept.push(...added.map((font) => font.name));
    return { added, failed, notKept };
  };

  const removeFile = async (ps) => {
    const font = fonts.get(ps);
    if (font && font.url) URL.revokeObjectURL(font.url);
    drop(ps);
    const db = await openStore().catch(() => null);
    if (db) await new Promise((done) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(ps);
      tx.oncomplete = done;
      tx.onerror = done;
    });
    await inInfo("readwrite", (store) => store.delete(ps)).catch(() => null);
    changed();
  };

  // What a kept font is called, apart from its file: starting the page reads this short list,
  // and a file only when a text or the font menu needs it.
  let infoDb = null;
  const openInfo = () => {
    if (!infoDb) {
      infoDb = new Promise((done, fail) => {
        const request = indexedDB.open("typer-web-font-info", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("info", { keyPath: "ps" });
        request.onsuccess = () => done(request.result);
        request.onerror = () => fail(request.error);
      });
    }
    return infoDb;
  };
  const inInfo = async (mode, act) => {
    const db = await openInfo();
    return new Promise((done, fail) => {
      const tx = db.transaction("info", mode);
      const request = act(tx.objectStore("info"));
      tx.oncomplete = () => done(request.result);
      tx.onerror = () => fail(tx.error);
      tx.onabort = () => fail(tx.error);
    });
  };
  const infoOf = (font, fileName) => ({ ps: font.postScriptName, file: fileName, name: font.name, family: font.family, style: font.style, size: font.size });
  const keepInfo = (info) => inInfo("readwrite", (store) => store.put(info)).catch(() => null);
  const listStored = (info) => {
    if (fonts.has(info.ps)) return;
    put(info.ps, { name: info.name, postScriptName: info.ps, family: info.family, style: info.style, source: "file", css: cssNameOf(info.ps), weight: 400, italic: false, ready: false, size: info.size, file: info.file });
  };

  // Font files loaded in an earlier session, and the installed fonts if already allowed
  const restore = async () => {
    const db = await openStore().catch(() => null);
    if (db) {
      const inFiles = (act) => new Promise((done, fail) => {
        const request = act(db.transaction(STORE).objectStore(STORE));
        request.onsuccess = () => done(request.result);
        request.onerror = () => fail(request.error);
      });
      const keys = await inFiles((store) => store.getAllKeys()).catch(() => []);
      const infos = await inInfo("readonly", (store) => store.getAll()).catch(() => null);
      const known = new Map((infos || []).map((info) => [info.ps, info]));
      for (const key of keys) {
        let info = known.get(key);
        // A file kept before this list existed is read once to get its names
        if (!info) {
          const row = await inFiles((store) => store.get(key)).catch(() => null);
          if (!row) continue;
          let names = {};
          try {
            names = readNames(row.buffer);
          } catch (error) {
            names = {};
          }
          const base = String(row.name || key).replace(/\.[^.]+$/, "");
          info = { ps: key, file: row.name, name: names.full || base, family: names.family || base, style: names.style || "Regular", size: row.buffer.byteLength };
          keepInfo(info);
        }
        listStored(info);
      }
    }
    if (canListInstalled() && navigator.permissions) {
      const status = await navigator.permissions.query({ name: "local-fonts" }).catch(() => null);
      if (status && status.state === "granted") await useInstalled().catch(() => 0);
    }
    changed();
  };

  window.TypeRFonts = {
    BUILTIN,
    get generation() { return generation; },
    openStore,
    get: (ps) => fonts.get(ps),
    list,
    resolve,
    measuresOf,
    variantOf,
    ensure,
    ready,
    isMissing,
    builtinsLoaded,
    canListInstalled,
    useInstalled,
    installedListed: () => installedListed,
    addFiles,
    removeFile,
    loadedFiles: () => Array.from(fonts.values()).filter((font) => font.source === "file").sort((a, b) => a.name.localeCompare(b.name)),
    restore,
    // Draws the text again, for what changes its layout besides a font (hyphenation patterns)
    refresh: () => changed(),
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // The file behind a name, for the panel's previews
    urlOf(name) {
      for (const font of fonts.values()) {
        if (font.postScriptName !== name && font.name !== name && `${font.family} ${font.style}` !== name) continue;
        if (font.url) return font.url;
        // Not read yet: this starts it, and onChange says when it's there
        if (font.source === "file") loadStored(font.postScriptName);
      }
      return null;
    },
  };
})();
