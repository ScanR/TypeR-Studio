// Reads the style kits TypeR exports from Photoshop: a .json, or a .zip holding that
// .json next to a fonts/ folder. Their styles join TypeR's storage in this browser,
// following what TypeR itself does when it imports them (new ids, the folders kept).

(function () {
  "use strict";

  const FONT_FILE = /\.(ttf|otf|ttc|otc|woff2?)$/i;
  const MAX_ENTRY = 256 * 1024 * 1024;
  const MAX_TOTAL = 2 * 1024 * 1024 * 1024;
  const MAX_ENTRIES = 5000;
  const ROOT = "/typer";
  const SEED_EDITED = 1761800000000;

  /* ------------------------------- the archive ------------------------------ */

  const inflate = (bytes) => new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer();

  const zipEntries = (buffer) => {
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    let end = -1;
    for (let at = buffer.byteLength - 22; at >= Math.max(0, buffer.byteLength - 22 - 65535); at--) {
      if (view.getUint32(at, true) === 0x06054b50) {
        end = at;
        break;
      }
    }
    if (end < 0) throw new Error("not a zip file");
    const count = view.getUint16(end + 10, true);
    if (count > MAX_ENTRIES) throw new Error("too many files in the archive");
    const names = new TextDecoder();
    const entries = [];
    let total = 0;
    let at = view.getUint32(end + 16, true);
    for (let i = 0; i < count; i++) {
      if (view.getUint32(at, true) !== 0x02014b50) throw new Error("damaged zip file");
      const nameLength = view.getUint16(at + 28, true);
      const entry = {
        method: view.getUint16(at + 10, true),
        packed: view.getUint32(at + 20, true),
        size: view.getUint32(at + 24, true),
        local: view.getUint32(at + 42, true),
        name: names.decode(bytes.subarray(at + 46, at + 46 + nameLength)),
      };
      at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
      total += entry.size;
      if (entry.size > MAX_ENTRY || total > MAX_TOTAL) throw new Error("the archive is too large");
      if (!entry.name.endsWith("/")) entries.push(entry);
    }
    return {
      entries,
      read(entry) {
        const start = entry.local + 30 + view.getUint16(entry.local + 26, true) + view.getUint16(entry.local + 28, true);
        const data = bytes.subarray(start, start + entry.packed);
        if (entry.method === 0) return Promise.resolve(data.slice().buffer);
        if (entry.method === 8) return inflate(data);
        return Promise.reject(new Error("unsupported compression"));
      },
    };
  };

  const deflate = (bytes) => new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer().then((buffer) => new Uint8Array(buffer));

  const CRC_TABLE = Int32Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc32 = (bytes) => {
    let crc = -1;
    for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xff];
    return (crc ^ -1) >>> 0;
  };

  // The same archive TypeR writes in Photoshop: { name, data } entries, as a Blob
  const writeArchive = async (entries) => {
    const parts = [];
    const central = [];
    let offset = 0;
    const now = new Date();
    const time = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
    const day = (Math.max(now.getFullYear() - 1980, 0) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    for (const entry of entries) {
      const name = new TextEncoder().encode(entry.name);
      const crc = crc32(entry.data);
      // A file that must stay as it is, as an .idml's mimetype
      let packed = entry.store ? entry.data : await deflate(entry.data);
      const method = !entry.store && packed.length < entry.data.length ? 8 : 0;
      if (!method) packed = entry.data;
      const fields = (view, at) => {
        view.setUint16(at, 20, true);
        view.setUint16(at + 2, 0x0800, true); // UTF-8 file names
        view.setUint16(at + 4, method, true);
        view.setUint16(at + 6, time, true);
        view.setUint16(at + 8, day, true);
        view.setUint32(at + 10, crc, true);
        view.setUint32(at + 14, packed.length, true);
        view.setUint32(at + 18, entry.data.length, true);
        view.setUint16(at + 22, name.length, true);
      };
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      fields(local, 4);
      const header = new DataView(new ArrayBuffer(46));
      header.setUint32(0, 0x02014b50, true);
      header.setUint16(4, 20, true);
      fields(header, 6);
      header.setUint32(42, offset, true);
      central.push(header, name);
      parts.push(local, name, packed);
      offset += 30 + name.length + packed.length;
    }
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, central.reduce((size, part) => size + part.byteLength, 0), true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end]);
  };

  const baseName = (name) => name.split(/[\\/]/).pop();

  // { json: [{ name, text }], fonts: [{ name, buffer }] }
  const readArchive = async (file) => {
    if (/\.json$/i.test(file.name)) return { json: [{ name: file.name, text: await file.text() }], fonts: [] };
    const zip = zipEntries(await file.arrayBuffer());
    const json = [];
    const fonts = [];
    for (const entry of zip.entries) {
      const name = baseName(entry.name);
      // Finder adds these when it makes a zip
      if (entry.name.indexOf("__MACOSX/") === 0 || name.indexOf("._") === 0) continue;
      if (/\.json$/i.test(name)) json.push({ name, text: new TextDecoder().decode(await zip.read(entry)) });
      else if (FONT_FILE.test(name)) fonts.push({ name, buffer: await zip.read(entry) });
    }
    return { json, fonts };
  };

  /* -------------------------------- the styles ------------------------------ */

  const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const check = (condition) => {
    if (!condition) throw new Error("invalid style file");
  };
  const checkTree = (value, depth) => {
    check(depth < 60);
    if (!value || typeof value !== "object") return;
    Object.keys(value).forEach((key) => {
      check(key !== "__proto__" && key !== "prototype" && key !== "constructor");
      checkTree(value[key], depth + 1);
    });
  };
  const validate = (data) => {
    check(isObject(data));
    checkTree(data, 0);
    ["folders", "styles", "exportedStyles"].forEach((field) => {
      if (data[field] !== undefined) check(Array.isArray(data[field]));
    });
    check(data.styles || data.exportedStyles);
    (data.styles || data.exportedStyles).forEach((style) => {
      check(isObject(style) && typeof style.name === "string");
      if (style.textProps !== undefined) check(isObject(style.textProps));
      if (style.prefixes !== undefined) check(Array.isArray(style.prefixes));
    });
    (data.folders || []).forEach((folder) => check(isObject(folder) && typeof folder.name === "string"));
    return data;
  };

  const STYLE_FIELDS = ["name", "textType", "textProps", "prefixes", "prefixColor", "prefixesDisabled", "stroke", "sizePresets", "autoSizeByPageWidth", "sizePresetDefaultIndex", "sizePresetMinWidths", "punctuationOnlyScale", "bubbleType"];
  const SETTING_FIELDS = ["ignoreLinePrefixes", "ignoreTags", "autoClosePSD", "currentFolderTagPriority", "pastePointText", "smartPaste", "pasteOnClick", "smartPasteAutoClean", "smartPasteDistribute", "smartPasteMinScale", "smartPasteHyphenation", "readingOrder", "refontRules"];

  const newId = () => Math.random().toString(36).substring(2, 8);

  const copyStyle = (style, folder, stamp) => {
    const out = { id: newId(), folder, edited: stamp, textType: "inherit", prefixes: [] };
    STYLE_FIELDS.forEach((field) => {
      if (style[field] !== undefined) out[field] = style[field];
    });
    giveTypeUnit(out);
    return out;
  };

  // The style window can't open a style that doesn't name its unit
  const giveTypeUnit = (style) => {
    if (!style.textProps || style.textProps.typeUnit) return false;
    style.textProps.typeUnit = "pixelsUnit";
    return true;
  };

  // Earlier versions started with a practice folder: it goes, unless it was edited
  const dropPracticeStyles = (storage) => {
    const kept = (storage.styles || []).filter((style) => !(String(style.id).indexOf("demo-") === 0 && style.edited === SEED_EDITED));
    if (kept.length === (storage.styles || []).length) return;
    storage.styles = kept;
    if (!kept.some((style) => style.folder === "demo-folder")) {
      storage.folders = (storage.folders || []).filter((folder) => folder.id !== "demo-folder");
      storage.openFolders = (storage.openFolders || []).filter((id) => id !== "demo-folder");
    }
  };

  const mergeInto = (storage, data, stats) => {
    storage.folders = storage.folders || [];
    storage.styles = storage.styles || [];
    storage.openFolders = storage.openFolders || [];
    const stamp = Date.now();
    const roots = storage.folders.filter((folder) => !folder.parentId).length;
    const added = [];
    if (data.exportedStyles) {
      const id = newId();
      storage.folders.push({ id, name: data.name || "TypeR", parentId: null, order: roots });
      storage.openFolders.push(id);
      data.exportedStyles.forEach((style) => added.push(copyStyle(style, id, stamp)));
      stats.folders += 1;
    } else {
      const ids = {};
      (data.folders || []).forEach((folder) => { ids[folder.id] = newId(); });
      (data.folders || []).forEach((folder) => {
        const parentId = folder.parentId && ids[folder.parentId] ? ids[folder.parentId] : null;
        const order = typeof folder.order === "number" ? folder.order : undefined;
        storage.folders.push({ id: ids[folder.id], name: folder.name, parentId, order: parentId ? order : roots + (order || 0) });
        storage.openFolders.push(ids[folder.id]);
      });
      const styleIds = {};
      data.styles.forEach((style) => {
        const copy = copyStyle(style, style.folder ? ids[style.folder] || null : null, stamp);
        styleIds[style.id] = copy.id;
        added.push(copy);
      });
      stats.folders += (data.folders || []).length;
      // A profile exported with its settings brings them along
      if (data.includesSettings === true) {
        SETTING_FIELDS.forEach((field) => {
          if (data[field] !== undefined) storage[field] = data[field];
        });
        if (styleIds[data.defaultStyleId]) storage.defaultStyleId = styleIds[data.defaultStyleId];
      }
    }
    storage.styles = storage.styles.concat(added);
    stats.styles += added.length;
    added.forEach((style) => {
      const ranges = style.textProps && style.textProps.layerText && style.textProps.layerText.textStyleRange;
      const ps = ranges && ranges[0] && ranges[0].textStyle && ranges[0].textStyle.fontPostScriptName;
      if (ps) stats.fonts.add(ps);
    });
    if (added.length && !storage.styles.some((style) => style.id === storage.currentStyleId)) storage.currentStyleId = added[0].id;
  };

  /* ------------------------- TypeR's files in the browser -------------------- */

  // TypeR's storage files: the default profile, the list of profiles, one file per
  // other profile. The database is what lasts (it survives a crash and has room);
  // localStorage is a second copy. Whichever is newer wins at start.
  //
  // They hold all that a user set up, the styles, the settings and the scripts, so:
  // - a file that could not be read is never taken for a file that isn't there, and nothing
  //   is written over it (`unread`);
  // - earlier copies of each file stay in the database (`copies`): one a day, and what a file
  //   was before it lost most of its length at once. A file that can't be read comes back from
  //   them, and the app offers them when the styles and scripts come back empty (app.js);
  // - what another tab writes is read here as it is written, so that a tab left open never
  //   writes what it read hours ago over it (`elsewhere`).
  const memory = new Map();
  const copies = new Map();
  const unread = new Set();
  const report = { unread: false, restored: [], damaged: [] };
  // A profile's picture for the Custom image theme sits beside its storage file, as a data URL
  const isPicture = (path) => /^\/typer\/storage(_profile_[^.]+)?_background$/.test(String(path));
  const keeps = (path) => isPicture(path) || /^\/typer\/storage(_profiles|_profile_[^.]+)?$/.test(String(path));
  // A storage file, whose text is TypeR's settings
  const isStorage = (path) => !isPicture(path) && /^\/typer\/storage(_profile_.+)?$/.test(String(path));
  // The files watched over below (read as JSON, copied, heard from another tab): not a picture
  const guards = (path) => keeps(path) && !isPicture(path);
  const keyFor = (path) => (path === `${ROOT}/storage` ? "typer.web.storage" : `typer.web.file:${path}`);
  const timeKey = (path) => `typer.web.time:${path}`;
  // The rows of the database that are earlier copies: "copy:<slot>:<path>"
  const COPY = /^copy:(\d+):(.*)$/;
  const COPIES = 3;
  const A_DAY = 20 * 3600 * 1000;
  // Set once the database holds one of these files: a database that doesn't answer is then
  // known to hold something
  const IN_DATABASE = "typer.web.inDatabase";
  const OPEN_WAIT = 5000;
  const reads = (text) => {
    try {
      return isObject(JSON.parse(text));
    } catch (error) {
      return false;
    }
  };
  // The newest first; the database's when both are as new
  const newestFirst = (a, b) => b.time - a.time || b.from - a.from;

  // One change to the database's files, once more on a new connection when the browser closed
  // the one kept (fonts.js). True once it is written.
  const inFiles = async (act) => {
    const run = (db) => new Promise((done) => {
      const tx = db.transaction("files", "readwrite");
      act(tx.objectStore("files"));
      tx.oncomplete = () => done(true);
      tx.onerror = () => done(false);
      tx.onabort = () => done(false);
    });
    const db = await window.TypeRFonts.openStore().catch(() => null);
    if (!db) return false;
    return run(db).catch(() => window.TypeRFonts.openStore(true).then(run)).catch(() => false);
  };
  // Null: the database didn't answer
  const fromFiles = (db, ask) => new Promise((done) => {
    try {
      const request = ask(db.transaction("files").objectStore("files"));
      request.onsuccess = () => done(request.result === undefined ? false : request.result);
      request.onerror = () => done(null);
    } catch (error) {
      done(null);
    }
  });

  // What a storage file holds of a user's work: how many styles, how many scripts with text
  const contentOf = (text) => {
    try {
      const storage = JSON.parse(text);
      const tabs = Array.isArray(storage.tabs) ? storage.tabs : [{ text: storage.text }];
      return { styles: Array.isArray(storage.styles) ? storage.styles.length : 0, scripts: tabs.filter((tab) => tab && String(tab.text || "").trim()).length };
    } catch (error) {
      return null;
    }
  };

  // An earlier copy of a file, in the place of the oldest one
  const setAside = (path, entry) => {
    const list = copies.get(path) || [];
    if (list.some((one) => one.text === entry.text)) return;
    let slot = 0;
    while (slot < COPIES && list.some((one) => one.slot === slot)) slot++;
    if (slot === COPIES) slot = list[list.length - 1].slot;
    const copy = { slot, text: entry.text, time: entry.time, made: Date.now() };
    copies.set(path, [copy].concat(list.filter((one) => one.slot !== slot)));
    inFiles((store) => store.put({ path: `copy:${slot}:${path}`, text: copy.text, time: copy.time, made: copy.made }));
  };
  const dropCopies = (path) => {
    const list = copies.get(path) || [];
    copies.delete(path);
    if (list.length) inFiles((store) => list.forEach((one) => store.delete(`copy:${one.slot}:${path}`)));
  };

  const loadFiles = async () => {
    const found = new Map();
    const offer = (path, text, time, from) => found.set(path, (found.get(path) || []).concat({ text, time: Number(time) || 0, from }));
    let inDatabase = false;
    try {
      Object.keys(window.localStorage).forEach((key) => {
        let path = null;
        if (key === "typer.web.storage") path = `${ROOT}/storage`;
        else if (key.indexOf("typer.web.file:") === 0) path = key.slice("typer.web.file:".length);
        if (path) offer(path, window.localStorage.getItem(key), window.localStorage.getItem(timeKey(path)), 0);
      });
      inDatabase = window.localStorage.getItem(IN_DATABASE) === "1";
    } catch (error) {
      console.warn("TypeR web: localStorage is not available", error);
    }
    // A database that never answers doesn't hold the app at its start
    const db = await Promise.race([window.TypeRFonts.openStore(), new Promise((done, fail) => setTimeout(() => fail(new Error("the database doesn't answer")), OPEN_WAIT))]).catch(() => null);
    const rows = db ? await fromFiles(db, (store) => store.getAll()) : null;
    (rows || []).forEach((row) => {
      const copy = COPY.exec(row.path);
      if (copy) copies.set(copy[2], (copies.get(copy[2]) || []).concat({ slot: Number(copy[1]), text: row.text, time: row.time, made: row.made || row.time }));
      else offer(row.path, row.text, row.time, 1);
    });
    copies.forEach((list) => list.sort((a, b) => b.made - a.made));
    // The database holds files and didn't give them: one that isn't in localStorage either is
    // there, unread. TypeR starts without it and nothing is kept in its place (keep).
    if (!rows && inDatabase) {
      [`${ROOT}/storage`, `${ROOT}/storage_profiles`].forEach((path) => { if (!found.has(path)) unread.add(path); });
      report.unread = unread.size > 0;
    }
    const back = [];
    found.forEach((list, path) => {
      list.sort(newestFirst);
      const good = guards(path) ? list.find((one) => reads(one.text)) : list[0];
      if (good) {
        memory.set(path, { text: good.text, time: good.time });
        return;
      }
      // Neither can be read: the newest earlier copy that can. What couldn't be read is put
      // aside in its turn rather than thrown away.
      const copy = (copies.get(path) || []).find((one) => reads(one.text));
      setAside(path, list[0]);
      if (copy) back.push({ path, text: copy.text, time: copy.time });
      else report.damaged.push(path);
    });
    for (const one of back) {
      await keep(one.path, one.text);
      report.restored.push({ path: one.path, time: one.time });
    }
    cleanPracticeStyles();
    repairTypeUnits();
    // One copy a day of each file, of what it holds as the day's work starts. Not of a file
    // that came back empty: the copies are what the app is about to offer.
    const lost = emptied();
    memory.forEach((entry, path) => {
      const last = (copies.get(path) || [])[0];
      if (guards(path) && rows && !(lost && lost.path === path) && (!last || Date.now() - last.made > A_DAY)) setAside(path, entry);
    });
  };

  // Styles taken from a layer here before the host named the unit
  const repairTypeUnits = () => {
    memory.forEach((entry, path) => {
      if (!isStorage(path)) return;
      try {
        const storage = JSON.parse(entry.text);
        if ((storage.styles || []).filter(giveTypeUnit).length) keep(path, JSON.stringify(storage));
      } catch (error) {
        console.warn("TypeR web: could not repair a storage file", error);
      }
    });
  };

  const cleanPracticeStyles = () => {
    memory.forEach((entry, path) => {
      if (!isStorage(path) || entry.text.indexOf('"demo-') < 0) return;
      try {
        const storage = JSON.parse(entry.text);
        dropPracticeStyles(storage);
        if (storage.currentStyleId && !storage.styles.some((style) => style.id === storage.currentStyleId)) storage.currentStyleId = storage.styles[0] ? storage.styles[0].id : null;
        keep(path, JSON.stringify(storage));
      } catch (error) {
        console.warn("TypeR web: could not clean a storage file", error);
      }
    });
  };

  const read = (path) => (memory.has(path) ? memory.get(path).text : null);
  const storedPaths = () => Array.from(memory.keys());

  // The browser may clear what a site keeps when the disk fills up, unless the site asked to
  // keep it for good. Asked once the user has done something here, at the first thing kept
  // after that: a browser that asks its user (Firefox) then asks about work that exists.
  let askedToStay = false;
  const askToStay = () => {
    if (askedToStay || !navigator.storage || !navigator.storage.persist || (navigator.userActivation && !navigator.userActivation.hasBeenActive)) return;
    askedToStay = true;
    navigator.storage.persist().catch(() => false);
  };

  let markedInDatabase = false;
  const keep = async (path, text) => {
    // Said once, at start (app.js)
    if (unread.has(path)) return false;
    const before = memory.get(path);
    // Later than what it replaces, whatever the clock says
    const time = Math.max(Date.now(), before ? before.time + 1 : 0);
    memory.set(path, { text, time });
    // Most of a file gone at once (all the styles, a whole script): what it was stays
    if (before && guards(path) && before.text.length - text.length > 1500 && text.length < before.text.length * 0.6) setAside(path, before);
    let stores = 0;
    // A picture would fill localStorage's few megabytes, which the settings need: it is kept
    // only in the database
    if (!isPicture(path)) try {
      // The time first: a page killed between the two leaves the earlier text under the later
      // time, and the database's row of that time, when it was written, wins over it at start
      window.localStorage.setItem(timeKey(path), String(time));
      window.localStorage.setItem(keyFor(path), text);
      stores++;
    } catch (error) {
      console.warn("TypeR web: localStorage is full", error);
      // No earlier text stays here to be taken for the file on a day the database doesn't answer
      try {
        window.localStorage.removeItem(keyFor(path));
        window.localStorage.removeItem(timeKey(path));
      } catch (again) {
        console.warn("TypeR web: localStorage is not available", again);
      }
    }
    if (await inFiles((store) => store.put({ path, text, time }))) {
      stores++;
      if (!markedInDatabase) {
        try {
          window.localStorage.setItem(IN_DATABASE, "1");
          markedInDatabase = true;
        } catch (error) {
          console.warn("TypeR web: localStorage is full", error);
        }
      }
    }
    if (!stores && window.TypeRPhotoshop) window.TypeRPhotoshop.warnStorage();
    if (stores) {
      tell(path);
      askToStay();
    }
    return stores > 0;
  };

  // Deleted for good, its earlier copies too: TypeR's own reset of everything
  const forget = async (path) => {
    if (unread.has(path)) return;
    memory.delete(path);
    try {
      window.localStorage.removeItem(keyFor(path));
      window.localStorage.removeItem(timeKey(path));
    } catch (error) {
      console.warn("TypeR web: localStorage is not available", error);
    }
    dropCopies(path);
    await inFiles((store) => store.delete(path));
    tell(path);
  };

  // The styles and the scripts came back empty, and an earlier copy had some: what the app
  // offers to bring back at start. Null when nothing is missing.
  const emptied = () => {
    const path = activeStoragePath();
    const now = memory.has(path) ? contentOf(memory.get(path).text) : { styles: 0, scripts: 0 };
    if (!now || now.styles || now.scripts) return null;
    for (const copy of copies.get(path) || []) {
      const had = contentOf(copy.text);
      if (had && (had.styles || had.scripts)) return Object.assign({ path, text: copy.text, time: copy.time }, had);
    }
    return null;
  };
  const bringBack = (lost) => keep(lost.path, lost.text);

  /* ---- the same files in another tab ---- */

  // Two tabs of the app, or the installed app beside a tab, keep the same files, and each
  // writes a file whole, from what it read at its start. A tab is told what the others write
  // (their message, or localStorage changing under it for a tab that runs an earlier version),
  // reads it, and counts it: the panel started before that count holds the past, and no longer
  // writes (bridge.js) until the app has started it again (app.js).
  // Not in the tab being used for more than a moment: there the user's own work is the present,
  // and what another tab writes behind their back (a panel that finishes starting) isn't.
  const SETTLED = 2000;
  let elsewhere = 0;
  let inFrontSince = 0;
  const inFront = () => document.visibilityState === "visible" && document.hasFocus();
  const watchFront = () => { inFrontSince = inFront() ? inFrontSince || Date.now() : 0; };
  ["focus", "blur", "pageshow"].forEach((name) => window.addEventListener(name, watchFront));
  document.addEventListener("visibilitychange", watchFront);
  watchFront();
  let channel = null;
  try {
    channel = new BroadcastChannel("typer-web-files");
  } catch (error) {
    channel = null;
  }
  const tell = (path) => {
    try {
      if (channel) channel.postMessage({ path });
    } catch (error) {
      console.warn("TypeR web: the other tabs weren't told", error);
    }
  };
  // True when the file here is no longer what this tab held
  const readAgain = async (path) => {
    const list = [];
    try {
      const text = window.localStorage.getItem(keyFor(path));
      if (text !== null) list.push({ text, time: Number(window.localStorage.getItem(timeKey(path))) || 0, from: 0 });
    } catch (error) {
      console.warn("TypeR web: localStorage is not available", error);
    }
    const db = await window.TypeRFonts.openStore().catch(() => null);
    const row = db ? await fromFiles(db, (store) => store.get(path)) : null;
    if (row) list.push({ text: row.text, time: row.time, from: 1 });
    // Not known: this tab keeps what it has
    else if (row === null && !list.length) return false;
    const known = memory.get(path);
    const newest = list.sort(newestFirst).find((one) => reads(one.text));
    if (!list.length) return memory.delete(path);
    if (!newest || (known && (known.time >= newest.time || known.text === newest.text))) return false;
    memory.set(path, { text: newest.text, time: newest.time });
    return true;
  };
  const hearing = new Map();
  const hear = (path) => {
    if (!guards(path) || unread.has(path)) return;
    clearTimeout(hearing.get(path));
    hearing.set(path, setTimeout(async () => {
      hearing.delete(path);
      watchFront();
      if ((inFront() && Date.now() - inFrontSince > SETTLED) || !(await readAgain(path))) return;
      elsewhere++;
      window.dispatchEvent(new Event("typer-storage-elsewhere"));
    }, 60));
  };
  if (channel) channel.onmessage = (event) => { if (event.data && typeof event.data.path === "string") hear(event.data.path); };
  window.addEventListener("storage", (event) => {
    const key = String(event.key || "");
    if (key === "typer.web.storage") hear(`${ROOT}/storage`);
    else if (key.indexOf("typer.web.file:") === 0) hear(key.slice("typer.web.file:".length));
  });

  // What TypeR starts from; a user who imports their styles first skips the tutorial
  const freshStorage = (firstTime) => ({ notFirstTime: !firstTime, whatsNewSeen: "3.0", checkUpdates: false, autoUpdate: false, textShapeRPerformanceTipShown: true });

  // A phone starts ready to work: a tap on a bubble pastes, and the text fits it, which takes
  // a style. Typing out a style's settings is no way to start on a phone.
  const freshTouchStorage = (name) => Object.assign(freshStorage(false), {
    pasteOnClick: true,
    currentStyleId: "starter",
    styles: [{
      id: "starter",
      name,
      folder: null,
      textType: "inherit",
      prefixes: [],
      edited: Date.now(),
      textProps: { typeUnit: "pixelsUnit", layerText: { antiAlias: "antiAliasSmooth", textStyleRange: [{ from: 0, to: 1, textStyle: { fontPostScriptName: "WildjessNormal", fontName: "Wildjess", fontStyleName: "Normal", size: 32, autoLeading: true, color: { red: 0, green: 0, blue: 0 } } }], paragraphStyleRange: [{ from: 0, to: 1, paragraphStyle: { alignment: "center" } }] } },
    }],
  });

  const activeStoragePath = () => {
    let active = "default";
    try {
      const registry = JSON.parse(read(`${ROOT}/storage_profiles`) || "{}");
      if (registry.activeProfileId && /^[a-z0-9][a-z0-9_-]{0,79}$/i.test(registry.activeProfileId)) active = registry.activeProfileId;
    } catch (error) {
      active = "default";
    }
    return active === "default" ? `${ROOT}/storage` : `${ROOT}/storage_profile_${active}`;
  };

  window.TypeRKit = { readArchive, writeArchive, zipEntries, validate, mergeInto, keeps, loadFiles, read, keep, forget, storedPaths, activeStoragePath, freshStorage, freshTouchStorage, ROOT, report: () => report, emptied, bringBack, dropCopies, elsewhere: () => elsewhere, inFront };
})();
