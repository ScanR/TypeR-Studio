// Keeps the open documents in the browser, saved or not, so that they come back with the
// page: layers, masks, selection, history, tabs and zoom. Each document is one record;
// its pixels are stored apart, each canvas once, as the app never draws on a canvas again
// after filling it. So typing a word rewrites a small record, and no pixels at all.
// The pages of one InDesign file keep its package once between them, and large arrays
// (selections, the package's stories) are kept compressed.

(function () {
  "use strict";

  const PS = window.TypeRPhotoshop;
  const { app, ops } = PS;
  const ACTIVE = "typer.web.activeDocument";
  const WAIT = 400;
  // Bigger arrays (a whole page's selection) are stored apart, like the canvases
  const LARGE_ARRAY = 65536;
  const TAG = "__typerPixels";
  // The files of an InDesign package, kept once for all its open pages ("packages")
  const PACKAGE = "__typerPackage";
  // A package's files smaller than this stay as they are, the others are compressed
  const SMALL_FILE = 1024;

  /* ------------------------------ the database ------------------------------ */

  let opening = null;
  const openDb = () => {
    if (!opening) {
      opening = new Promise((done, fail) => {
        const request = indexedDB.open("typer-web-documents", 2);
        request.onupgradeneeded = (event) => {
          const db = request.result;
          if (event.oldVersion < 1) {
            db.createObjectStore("documents", { keyPath: "uid" });
            db.createObjectStore("pixels", { keyPath: "key" });
          }
          if (event.oldVersion < 2) {
            db.createObjectStore("packages", { keyPath: "key" });
            // The pages using a package: when none is left, it goes
            request.transaction.objectStore("documents").createIndex("package", "package");
          }
        };
        request.onsuccess = () => {
          // A newer version of the app opening in another tab isn't kept waiting
          request.result.onversionchange = () => {
            request.result.close();
            opening = null;
          };
          done(request.result);
        };
        request.onerror = () => {
          opening = null;
          fail(request.error);
        };
      });
    }
    return opening;
  };

  // `name`: one store, handed to `act`, or several, `act` getting the transaction
  const inStore = async (name, mode, act) => {
    const db = await openDb();
    return new Promise((done, fail) => {
      const tx = db.transaction(name, mode);
      const request = act(Array.isArray(name) ? tx : tx.objectStore(name));
      tx.oncomplete = () => done(request && request.result);
      tx.onabort = () => fail(tx.error || new Error("The browser refused to keep this document"));
      tx.onerror = () => fail(tx.error || new Error("The browser refused to keep this document"));
    });
  };
  const pixelsOf = (uid) => IDBKeyRange.bound([uid], [uid, []]);

  // Two tabs keep their own documents: the one that has a document holds its lock, and a
  // new page only takes the documents nobody holds. Reloading hands them over.
  const takeLock = (uid) => new Promise((resolve) => {
    if (!navigator.locks) {
      resolve(() => {});
      return;
    }
    navigator.locks.request(`typer-document-${uid}`, { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve(null);
        return null;
      }
      return new Promise((release) => resolve(release));
    }).catch(() => resolve(null));
  });

  /* --------------------------------- saving --------------------------------- */

  const kept = new Map();
  const newKeep = (uid) => ({ uid, ids: new WeakMap(), next: 1, written: new Set(), content: null, view: "", release: null, package: null });
  const newUid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  // What makes a document differ from its record. Every change makes a new state.
  const contentOf = (doc) => [doc.state, doc.historyIndex, doc.history.length, doc.history[doc.historyIndex], doc.savedId, doc.name, doc.path, doc.stamp, doc.handle, app.docs.indexOf(doc), doc.idml && doc.idml.pkg && doc.idml.pkg.files];
  const viewOf = (doc) => `${doc.view.zoom}:${doc.view.x}:${doc.view.y}`;
  const isKept = (doc) => {
    const keep = kept.get(doc);
    if (!keep || !keep.content) return false;
    const now = contentOf(doc);
    return keep.content.every((item, index) => item === now[index]);
  };

  // A copy of the document where canvases and large arrays are references. Objects shared
  // between states stay shared: the history costs its differences, not 150 copies.
  const packer = (keep, used) => {
    const seen = new Map();
    const pack = (value) => {
      if (typeof value === "function" || typeof value === "symbol") return undefined;
      if (value === null || typeof value !== "object") return value;
      if (seen.has(value)) return seen.get(value);
      let out = value;
      if (value instanceof HTMLCanvasElement || (ArrayBuffer.isView(value) && value.byteLength > LARGE_ARRAY)) {
        if (!keep.ids.has(value)) keep.ids.set(value, keep.next++);
        used.set(keep.ids.get(value), value);
        out = { [TAG]: keep.ids.get(value) };
      } else if (Array.isArray(value)) {
        out = [];
        seen.set(value, out);
        value.forEach((item, index) => { out[index] = pack(item); });
      } else if ([Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        out = {};
        seen.set(value, out);
        Object.keys(value).forEach((key) => {
          const item = pack(value[key]);
          if (item !== undefined) out[key] = item;
        });
      }
      seen.set(value, out);
      return out;
    };
    return pack;
  };

  // A canvas as a PNG, made by session-worker.js: the page hands it a copy of the picture and
  // stays free. Null where that can't be done (no worker, a browser without OffscreenCanvas, a
  // picture it refuses): the page then makes the PNG itself, as it always could.
  let encoder = null;
  let lastJob = 0;
  const jobs = new Map();
  const encodedAway = async (source) => {
    if (encoder === false || typeof Worker !== "function" || typeof OffscreenCanvas !== "function" || typeof createImageBitmap !== "function") return null;
    try {
      if (!encoder) {
        encoder = new Worker("session-worker.js");
        encoder.onmessage = ({ data }) => {
          const job = jobs.get(data.id);
          jobs.delete(data.id);
          if (job) job(data.blob || null);
        };
        // A worker that doesn't start, or stops: what waits on it is made here, as is the rest
        encoder.onerror = () => {
          encoder = false;
          jobs.forEach((job) => job(null));
          jobs.clear();
        };
      }
      const bitmap = await createImageBitmap(source);
      if (!encoder) {
        bitmap.close();
        return null;
      }
      return await new Promise((done) => {
        const id = ++lastJob;
        // A worker that never answers (stopped for want of memory, without a word) must not
        // keep the documents from being stored: after a long wait the page takes over for good
        const late = setTimeout(() => {
          if (!jobs.has(id)) return;
          jobs.delete(id);
          if (encoder) encoder.terminate();
          encoder = false;
          done(null);
        }, 120000);
        jobs.set(id, (blob) => {
          clearTimeout(late);
          done(blob);
        });
        encoder.postMessage({ id, bitmap }, [bitmap]);
      });
    } catch (error) {
      console.warn("TypeR web: storing a picture without the worker", error);
      return null;
    }
  };
  // An array compressed, when the browser can and it is the smaller for it (a selection is
  // mostly the same byte, a story mostly words). Null otherwise: it is kept as it is.
  const deflated = async (source) => {
    if (typeof CompressionStream !== "function") return null;
    try {
      const blob = await new Response(new Blob([source]).stream().pipeThrough(new CompressionStream("deflate"))).blob();
      return blob.size < source.byteLength ? blob : null;
    } catch (error) {
      return null;
    }
  };
  const encoded = async (source) => {
    if (ArrayBuffer.isView(source)) {
      const packed = await deflated(source);
      return packed ? { ctor: source.constructor.name, blob: packed, encoding: "deflate" } : { ctor: source.constructor.name, blob: new Blob([source]) };
    }
    const row = { width: source.width, height: source.height, blob: null };
    if (!source.width || !source.height) return row;
    row.blob = await encodedAway(source) || await new Promise((done, fail) => {
      source.toBlob((blob) => {
        if (blob) done(blob);
        else fail(new Error("A layer's pixels could not be stored"));
      }, "image/png");
    });
    return row;
  };

  // The pages of an .idml share its package, files and all (indesign.js): they are kept once,
  // under a key that changes with them (a save gives the package new files), and each page's
  // record names it. The pages' own part of the package (its name, its frames) stays in them.
  const packageKeys = new WeakMap();
  const storedPackages = new Set();
  const packageKey = (pkg) => {
    if (!packageKeys.has(pkg.files)) packageKeys.set(pkg.files, `${pkg.id}#${pkg.saves || 0}#${newUid()}`);
    return packageKeys.get(pkg.files);
  };
  const sharedIdml = (idml, key) => idml && key ? Object.assign({}, idml, { pkg: Object.assign({}, idml.pkg, { files: { [PACKAGE]: key }, previews: null }) }) : idml;
  const packageRow = async (key, files) => {
    const out = {};
    for (const path of Object.keys(files)) {
      const data = files[path];
      out[path] = ArrayBuffer.isView(data) && data.byteLength > SMALL_FILE ? await encoded(data) : data;
    }
    return { key, files: out };
  };
  // The record, with the package it names, in one go: one is never there without the other.
  // A package another tab let go of in the meantime is written again. `previous`: the package
  // the record named until now, which goes if no page names it any more.
  const putRecord = async (record, files, previous, alive) => {
    const key = record.package;
    for (let attempt = 0; ; attempt++) {
      const row = key && !storedPackages.has(key) ? await packageRow(key, files) : null;
      if (alive && !alive()) return false;
      let gone = false;
      const dropped = [];
      try {
        await inStore(["documents", "packages"], "readwrite", (tx) => {
          const packages = tx.objectStore("packages");
          if (row) packages.put(row);
          else if (key) {
            packages.getKey(key).onsuccess = (event) => {
              if (event.target.result !== undefined) return;
              gone = true;
              tx.abort();
            };
          }
          const put = tx.objectStore("documents").put(record);
          if (previous && previous !== key) put.onsuccess = () => dropUnused(tx, [previous], dropped);
          return put;
        });
        if (key) storedPackages.add(key);
        dropped.forEach((old) => storedPackages.delete(old));
        return true;
      } catch (error) {
        if (!gone || attempt) throw error;
        storedPackages.delete(key);
      }
    }
  };

  const saveDoc = async (doc) => {
    let keep = kept.get(doc);
    if (!keep) {
      keep = newKeep(newUid());
      keep.release = await takeLock(keep.uid);
      kept.set(doc, keep);
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => false);
    }
    const content = contentOf(doc);
    const view = viewOf(doc);
    const used = new Map();
    const pkg = doc.idml && doc.idml.pkg;
    const shared = pkg && pkg.files && typeof pkg.files === "object" ? packageKey(pkg) : null;
    const record = packer(keep, used)({
      uid: keep.uid,
      at: app.docs.indexOf(doc),
      nextId: PS.newId(),
      name: doc.name,
      path: doc.path,
      stamp: doc.stamp,
      handle: doc.handle,
      width: doc.width,
      height: doc.height,
      resolution: doc.resolution,
      psd: doc.psd,
      idml: sharedIdml(doc.idml, shared),
      state: doc.state,
      history: doc.history,
      historyIndex: doc.historyIndex,
      savedId: doc.savedId,
      view: doc.view,
    });
    record.next = keep.next;
    if (shared) record.package = shared;
    // The pixels first: a record never points at something that isn't there
    for (const [number, source] of used) {
      if (keep.written.has(number)) continue;
      const row = await encoded(source);
      if (!app.docs.includes(doc)) return;
      await inStore("pixels", "readwrite", (store) => store.put(Object.assign(row, { key: [keep.uid, number] })));
      keep.written.add(number);
    }
    if (!(await putRecord(record, shared ? pkg.files : null, keep.package, () => app.docs.includes(doc)))) return;
    keep.package = shared;
    keep.content = content;
    keep.view = view;
    const gone = Array.from(keep.written).filter((number) => !used.has(number));
    if (gone.length) {
      await inStore("pixels", "readwrite", (store) => {
        let last = null;
        gone.forEach((number) => { last = store.delete([keep.uid, number]); });
        return last;
      });
      gone.forEach((number) => keep.written.delete(number));
    }
  };

  // Packages no page names any more. `keys`: those to look at (all of them without it). In the
  // same go as what is checked, so a page saved meanwhile in another tab keeps its package.
  const dropUnused = (tx, keys, dropped) => {
    const packages = tx.objectStore("packages");
    const byPackage = tx.objectStore("documents").index("package");
    const check = (key) => {
      byPackage.count(key).onsuccess = (event) => {
        if (event.target.result) return;
        packages.delete(key);
        dropped.push(key);
      };
    };
    if (keys) keys.forEach(check);
    else packages.getAllKeys().onsuccess = (event) => event.target.result.forEach(check);
  };

  const forget = async (uid) => {
    const dropped = [];
    await inStore(["documents", "packages"], "readwrite", (tx) => {
      const documents = tx.objectStore("documents");
      // Only the key of the package it names, not the whole record
      const named = documents.index("package").openKeyCursor();
      let key = null;
      named.onsuccess = () => {
        const cursor = named.result;
        if (cursor && cursor.primaryKey !== uid) {
          cursor.continue();
          return;
        }
        if (cursor) key = cursor.key;
        documents.delete(uid).onsuccess = () => {
          if (key) dropUnused(tx, [key], dropped);
        };
      };
    });
    dropped.forEach((key) => storedPackages.delete(key));
    await inStore("pixels", "readwrite", (store) => store.delete(pixelsOf(uid)));
  };

  const MAX_WAIT = 5000;
  // A page that only comes in front, nothing done to it, isn't kept at once: going through a
  // chapter (Flow, the pager, Page Down held) brings each page in front for a moment, and
  // keeping one is writing its pixels whole. It is kept once it has stayed this long, and is
  // on disk as it is anyway.
  const PASSING = 3000;
  const opened = new WeakMap();
  const passingBy = (doc) => {
    if (kept.has(doc) || doc.historyIndex !== 0 || PS.isDirty(doc)) return 0;
    if (!opened.has(doc)) opened.set(doc, Date.now());
    return Math.max(0, opened.get(doc) + PASSING - Date.now());
  };
  let timer = 0;
  let waitingSince = 0;
  let lastEstimate = 0;
  let sweeping = false;
  let again = false;
  let failing = false;

  // Said once, while there's still room to do something about it
  let warnedLow = false;
  const warnWhenStorageIsLow = async () => {
    if (warnedLow || !navigator.storage || !navigator.storage.estimate || Date.now() - lastEstimate < 60000) return;
    lastEstimate = Date.now();
    const { usage, quota } = await navigator.storage.estimate().catch(() => ({}));
    if (usage && quota && usage / quota > 0.9) {
      warnedLow = true;
      PS.announce("storage-low");
    }
  };

  // `all`: the pages only passing by too (the tab is being left)
  const sweep = async (all) => {
    timer = 0;
    if (sweeping) {
      again = true;
      return;
    }
    sweeping = true;
    waitingSince = 0;
    let later = 0;
    try {
      for (const [doc, keep] of Array.from(kept)) {
        if (app.docs.includes(doc)) continue;
        kept.delete(doc);
        await forget(keep.uid);
        if (keep.release) keep.release();
      }
      // The page on screen first, and a page that doesn't fit leaves its turn to the others
      let refused = null;
      for (const doc of [app.doc, ...app.docs.filter((other) => other !== app.doc)]) {
        if (!doc) continue;
        const keep = kept.get(doc);
        if (isKept(doc) && keep.view === viewOf(doc)) continue;
        const wait = all === true ? 0 : passingBy(doc);
        if (wait) {
          later = Math.max(later, wait);
          continue;
        }
        try {
          await saveDoc(doc);
        } catch (error) {
          refused = refused || error;
        }
      }
      const active = app.doc && kept.get(app.doc);
      if (active) window.localStorage.setItem(ACTIVE, active.uid);
      if (refused) throw refused;
      failing = false;
      warnWhenStorageIsLow();
    } catch (error) {
      console.warn("TypeR web: could not keep the open documents", error);
      if (!failing) PS.announce("documents-not-kept");
      failing = true;
    }
    sweeping = false;
    if (again) {
      again = false;
      schedule();
    } else if (later && !timer) timer = setTimeout(sweep, later + 50);
  };

  // Each change starts the wait over, up to this: work without a pause still gets kept
  function schedule() {
    clearTimeout(timer);
    if (!waitingSince) waitingSince = Date.now();
    timer = setTimeout(sweep, Math.max(0, Math.min(WAIT, waitingSince + MAX_WAIT - Date.now())));
  }
  const flush = () => {
    clearTimeout(timer);
    sweep(true);
  };

  PS.on((type) => {
    if (type === "render" || type === "history" || type === "document" || type === "saved" || type === "selection" || type === "tabs") schedule();
    // Reading a page's pixels back holds the screen for a moment: not in the middle of a zoom
    // or of a scroll, which wait for nothing
    else if (type === "view" && timer) schedule();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });

  /* -------------------------------- restoring ------------------------------- */

  const decoded = async (row) => {
    if (row.ctor) {
      // Without `encoding`, kept as it is: so are those kept before compression came
      const bytes = row.encoding === "deflate" ? await new Response(row.blob.stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer() : await row.blob.arrayBuffer();
      return new window[row.ctor](bytes);
    }
    const canvas = PS.newCanvas(row.width, row.height);
    if (row.blob) {
      const bitmap = await createImageBitmap(row.blob, { colorSpaceConversion: "none" });
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      bitmap.close();
    }
    return canvas;
  };

  // A package's files, read once for all the pages that name it: they share them again
  const packageFiles = (key, shelf) => {
    if (!shelf.has(key)) {
      shelf.set(key, (async () => {
        const row = await inStore("packages", "readonly", (store) => store.get(key));
        if (!row) throw Object.assign(new Error("Some of its pixels are missing"), { missing: true });
        const files = {};
        for (const path of Object.keys(row.files)) {
          const data = row.files[path];
          files[path] = data && data.ctor ? await decoded(data) : data;
        }
        packageKeys.set(files, key);
        storedPackages.add(key);
        return files;
      })());
      // A failed read is tried again by the next page that asks
      shelf.get(key).catch(() => shelf.delete(key));
    }
    return shelf.get(key);
  };

  const unpacked = async (record, keep, shelf) => {
    const rows = await inStore("pixels", "readonly", (store) => store.getAll(pixelsOf(record.uid)));
    const byNumber = new Map(rows.map((row) => [row.key[1], row]));
    const spots = [];
    const seen = new Set();
    const visit = (value) => {
      if (value === null || typeof value !== "object" || ArrayBuffer.isView(value) || seen.has(value)) return;
      seen.add(value);
      Object.keys(value).forEach((key) => {
        const item = value[key];
        if (item && item[TAG] !== undefined) spots.push({ parent: value, key, number: item[TAG] });
        else visit(item);
      });
    };
    visit(record);
    const pkg = record.idml && record.idml.pkg;
    if (pkg && pkg.files && pkg.files[PACKAGE] !== undefined) pkg.files = await packageFiles(pkg.files[PACKAGE], shelf || new Map());
    const numbers = Array.from(new Set(spots.map((spot) => spot.number)));
    const made = new Map();
    // A few at a time: decoding happens away from the page
    for (let at = 0; at < numbers.length; at += 4) {
      await Promise.all(numbers.slice(at, at + 4).map(async (number) => {
        const row = byNumber.get(number);
        if (!row) throw Object.assign(new Error("Some of its pixels are missing"), { missing: true });
        const made_ = await decoded(row);
        made.set(number, made_);
        keep.ids.set(made_, number);
        keep.written.add(number);
      }));
    }
    spots.forEach((spot) => { spot.parent[spot.key] = made.get(spot.number); });
    rows.forEach((row) => { if (!made.has(row.key[1])) keep.written.add(row.key[1]); });
    keep.next = record.next;
  };

  const fontsOf = (record) => {
    const names = new Set();
    record.history.concat({ state: record.state }).forEach((entry) => {
      entry.state.layers.forEach((layer) => {
        if (layer.kind !== "text") return;
        layer.params.layerText.textStyleRange.forEach((range) => names.add(range.textStyle.fontPostScriptName));
      });
    });
    return Array.from(names).filter(Boolean);
  };

  // What another tab still holds stays there. A reloading page has just let go of its
  // documents, which can take a moment.
  const claim = async (uid) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const release = await takeLock(uid);
      if (release) return release;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return null;
  };

  // Pixels whose document never got its record: the page left during the first save
  const cleanLeftovers = async () => {
    const records = await inStore("documents", "readonly", (store) => store.getAllKeys());
    const keys = await inStore("pixels", "readonly", (store) => store.getAllKeys());
    const owners = new Set(keys.map((key) => key[0]).filter((uid) => !records.includes(uid)));
    for (const uid of owners) {
      const release = await takeLock(uid);
      if (!release) continue;
      await inStore("pixels", "readwrite", (store) => store.delete(pixelsOf(uid)));
      release();
    }
    // Packages none of whose pages is kept any more
    const dropped = [];
    await inStore(["documents", "packages"], "readwrite", (tx) => dropUnused(tx, null, dropped));
    dropped.forEach((key) => storedPackages.delete(key));
  };

  // The active document first, so there's something to work on at once. The others join
  // their tabs as they come.
  const restoreAll = async ({ progress, failed, elsewhere }) => {
    let records = [];
    try {
      records = await inStore("documents", "readonly", (store) => store.getAll());
    } catch (error) {
      console.warn("TypeR web: no kept documents", error);
      return;
    }
    records.sort((a, b) => a.at - b.at);
    const place = new Map(records.map((record) => [record.uid, record.at]));
    let active = null;
    try {
      active = window.localStorage.getItem(ACTIVE);
    } catch (error) {
      active = null;
    }
    const wanted = records.find((record) => record.uid === active) || records[0];
    const order = wanted ? [wanted].concat(records.filter((record) => record !== wanted)) : [];
    const rank = new Map();
    const shelf = new Map();
    let first = null;
    let held = false;
    for (const record of order) {
      const release = await claim(record.uid);
      if (!release) {
        held = true;
        continue;
      }
      if (!first) {
        first = record;
        progress(record.name);
      }
      try {
        const keep = newKeep(record.uid);
        keep.release = release;
        await unpacked(record, keep, shelf);
        keep.package = record.package || null;
        await window.TypeRFonts.ready(fontsOf(record));
        const doc = ops.restoreDoc(record, record === first);
        rank.set(doc, place.get(record.uid));
        kept.set(doc, keep);
        app.docs.sort((a, b) => (rank.has(a) ? rank.get(a) : Infinity) - (rank.has(b) ? rank.get(b) : Infinity));
        keep.content = contentOf(doc);
        keep.view = viewOf(doc);
      } catch (error) {
        console.error(error);
        failed(record.name, error);
        release();
        if (error.missing) await forget(record.uid);
      }
      if (record === first) progress(null);
    }
    if (first) schedule();
    if (held) elsewhere();
    await cleanLeftovers().catch((error) => console.warn("TypeR web: could not clean the kept documents", error));
  };

  // The panel starts while they come back: a page it asks for meanwhile waits for them
  // (openFile in photoshop.js)
  let restoring = null;
  const restore = (callbacks) => {
    restoring = restoreAll(callbacks).finally(() => { restoring = null; });
    return restoring;
  };

  window.TypeRSession = { restore, restoring: () => restoring, flush, isKept };
})();
