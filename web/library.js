// The Library panel (Window > Library): brushes and materials brought in from Clip Studio Paint,
// kept from one session to the next.
//
//   importing   Import… in the panel, or the files dropped on it or on the page: brushes (.sut),
//               documents of materials (.clip), and .zip or .7z archives of them, packs of
//               packs too.
//               They are read in a worker (csp-worker.js, csp.js), a brush or a material at a
//               time: the panel fills as they come.
//   a brush     kept as its own file, with a stroke of it as its thumbnail; its pictures are
//               read when it is chosen. A click chooses it and takes the Brush (B): the Brush
//               then paints with it (brush-engine.js, photoshop.js's beginPreset), at the size
//               and with the colours of the Brush. "Round Brush", first in the list, is TypeR's
//               own again. Its size, opacity and the scale of its paper are kept with it.
//   a material  a picture (a bubble, a sky) or a pattern that tiles (a screentone), kept as a
//               PNG. A double-click, a drag onto the page or Place puts it on a new layer: a
//               picture at the size it had on its own page, brought to this one's (Free
//               Transform follows, to size it); a pattern over the selection, or the page.
//   the store   IndexedDB "typer-web-library": brushes and materials (what the panel lists),
//               files and pictures (the bytes, read when needed).

(function () {
  "use strict";

  const PS = window.TypeRPhotoshop;
  const A = window.TypeRApp;
  if (!PS || !A) return;
  const { ops, app } = PS;
  const { T, fill } = A;
  const Shell = window.TypeRShell || {};
  const $ = (id) => document.getElementById(id);
  const pane = $("pane-library");
  if (!pane) return;
  const STORE = "typer.web.library";
  const ACCEPT = ".sut,.clip,.zip,.7z";
  const KINDS = /\.(sut|clip|zip|7z)$/i;

  const make = (tag, className, parent, text) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    if (parent) parent.appendChild(el);
    return el;
  };
  const newId = () => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const SVG = (paths) => `<svg viewBox="0 0 16 16" aria-hidden="true">${paths}</svg>`;
  const ICONS = {
    import: SVG('<path d="M8 2.500v7.500M5 7l3 3 3-3M3 12.500h10"/>'),
    trash: SVG('<path d="M3 4.500h10M6.500 4.500v-2h3v2M4.500 4.500l.500 9h6l.500-9"/>'),
    place: SVG('<rect x="2.500" y="2.500" width="11" height="11" rx="1"/><path d="M8 5.500v5M5.500 8h5"/>'),
    arrow: SVG('<path d="M4 6l4 4 4-4"/>'),
  };

  /* --------------------------------- the store --------------------------------- */

  let dbPromise = null;
  const db = () => {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open("typer-web-library", 1);
        request.onupgradeneeded = () => {
          ["brushes", "files", "materials", "pictures"].forEach((name) => {
            if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: "id" });
          });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return dbPromise;
  };
  const tx = async (stores, mode, run) => {
    const base = await db();
    return new Promise((resolve, reject) => {
      const t = base.transaction(stores, mode);
      let result;
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
      result = run(t);
    });
  };
  const all = async (store) => {
    let request;
    await tx([store], "readonly", (t) => {
      request = t.objectStore(store).getAll();
    });
    return request.result || [];
  };
  const one = async (store, id) => {
    let request;
    await tx([store], "readonly", (t) => {
      request = t.objectStore(store).get(id);
    });
    return request.result || null;
  };
  const put = (store, record) => tx([store], "readwrite", (t) => {
    t.objectStore(store).put(record);
  });

  const prefs = { tab: "brushes", closed: {} };
  try {
    Object.assign(prefs, JSON.parse(window.localStorage.getItem(STORE) || "{}"));
  } catch (error) {
    // The panel opens as it does the first time
  }
  const keepPrefs = () => {
    try {
      window.localStorage.setItem(STORE, JSON.stringify({ tab: prefs.tab, closed: prefs.closed }));
    } catch (error) {
      // Not kept, nothing else
    }
  };

  /* --------------------------------- the worker --------------------------------- */

  let worker = null;
  const waiting = new Map();
  let calls = 0;
  const ask = (message, transfer, each) => new Promise((resolve, reject) => {
    if (!worker) {
      worker = new Worker("csp-worker.js");
      worker.onmessage = (event) => {
        const call = waiting.get(event.data.id);
        if (call) call(event.data);
      };
      worker.onerror = (event) => {
        waiting.forEach((call) => call({ type: "error", detail: event.message || "worker" }));
      };
    }
    const id = ++calls;
    waiting.set(id, (data) => {
      if (data.type === "done" || data.type === "loaded") {
        waiting.delete(id);
        resolve(data);
      } else if (data.type === "error") {
        waiting.delete(id);
        reject(new Error(data.detail || "error"));
      } else if (each) each(data);
    });
    worker.postMessage(Object.assign({ id }, message), transfer || []);
  });

  /* --------------------------------- what is kept --------------------------------- */

  const lib = { brushes: [], materials: [], ready: false };
  const urls = new Map();
  const urlOf = (record) => {
    if (!record.thumb) return "";
    let url = urls.get(record.id);
    if (!url) {
      url = URL.createObjectURL(record.thumb);
      urls.set(record.id, url);
    }
    return url;
  };
  const forget = (id) => {
    if (urls.has(id)) URL.revokeObjectURL(urls.get(id));
    urls.delete(id);
  };
  const byOrder = (a, b) => (a.order || 0) - (b.order || 0);

  /* --------------------------------- brushes --------------------------------- */

  // The brush the Brush paints with: { record, brush } once its pictures are read, or null
  // for TypeR's own round brush
  let chosen = null;
  let choosing = 0;
  // The round brush's size, given back when a brush of the library is let go
  let roundSize = null;
  const loaded = new Map();
  const KEEP_LOADED = 3;
  const brushOf = async (record) => {
    if (loaded.has(record.id)) {
      const brush = loaded.get(record.id);
      loaded.delete(record.id);
      loaded.set(record.id, brush);
      return brush;
    }
    const file = await one("files", record.fileId);
    if (!file) throw new Error("file");
    const { brush } = await ask({ op: "load", file: file.bytes, index: record.index || 0 }, file.bytes instanceof ArrayBuffer ? [file.bytes] : []);
    loaded.set(record.id, brush);
    while (loaded.size > KEEP_LOADED) loaded.delete(loaded.keys().next().value);
    return brush;
  };
  const clampSize = (value) => Math.max(1, Math.min(2000, Math.round(value) || 1));
  const keepBrush = (record) => put("brushes", record).catch(() => {});
  const choose = async (record) => {
    const turn = ++choosing;
    if (!record) {
      if (chosen && roundSize) app.brush.size = roundSize;
      roundSize = null;
      chosen = null;
      render();
      A.setTool("brush");
      A.renderOptions();
      return;
    }
    let brush;
    try {
      brush = await brushOf(record);
    } catch (error) {
      A.toast(fill(T("{name} can't be read."), { name: record.name }), true);
      return;
    }
    if (turn !== choosing) return;
    if (!chosen) roundSize = app.brush.size;
    chosen = { record, brush };
    app.brush.size = clampSize(record.mySize || record.size);
    render();
    A.setTool("brush");
    A.renderOptions();
    if (brush.notes && brush.notes.length && !record.told) {
      record.told = true;
      keepBrush(record);
      A.toast(T("This brush uses settings TypeR doesn't draw yet: it may look different from Clip Studio Paint."), true);
    }
  };
  const rgbOf = (color) => {
    if (Array.isArray(color)) return color;
    if (color && color.red !== undefined) return [color.red, color.green, color.blue];
    if (color && color.r !== undefined) return [color.r, color.g, color.b];
    return [0, 0, 0];
  };
  // What a stroke of the Brush takes when a brush of the library is chosen (see app.js's
  // strokeFields): null with the round brush
  const preset = () => {
    if (!chosen) return null;
    const { record, brush } = chosen;
    const size = clampSize(app.brush.size);
    if (record.mySize !== size) {
      record.mySize = size;
      keepBrush(record);
    }
    // A paper's scale is its own: the same brush at another scale of its pattern
    let used = brush;
    const scale = record.paperScale || 100;
    if (brush.texture && scale !== 100) {
      if (!chosen.scaled || chosen.scaledAt !== scale) {
        chosen.scaled = { settings: brush.settings, tips: brush.tips, texture: Object.assign({}, brush.texture, { scale: (brush.texture.scale || 1) * (scale / 100) }) };
        chosen.scaledAt = scale;
      }
      used = chosen.scaled;
    }
    return { brush: used, size, opacity: (record.myOpacity === undefined ? Math.round(brush.settings.opacity * 100) : record.myOpacity) / 100 };
  };

  /* --------------------------------- materials --------------------------------- */

  let picked = null;
  const MAX_PATTERN = 6000 * 6000;
  // A picture's share of its own page, brought to this one: a bubble drawn for a page 6000
  // pixels wide comes a quarter of its size on one 1500 wide
  const pageScale = (material, doc) => {
    if (!(material.pageWidth > 0 && material.pageHeight > 0)) return 1;
    return Math.min(1, Math.max(doc.width / material.pageWidth, doc.height / material.pageHeight));
  };
  const place = async (material, at) => {
    const doc = app.doc;
    if (!doc) {
      A.toast(T("Open a page first."));
      return;
    }
    const kept = await one("pictures", material.id);
    if (!kept) {
      A.toast(fill(T("{name} can't be read."), { name: material.name }), true);
      return;
    }
    A.working(fill(T("Placing {name}…"), { name: material.name }));
    try {
      const scale = pageScale(material, doc) * ((material.myScale || 100) / 100);
      const w = Math.max(1, Math.round(material.width * scale));
      const h = Math.max(1, Math.round(material.height * scale));
      const picture = await createImageBitmap(kept.png, { resizeWidth: w, resizeHeight: h, resizeQuality: "high" });
      if (material.tiling) {
        // A pattern: over the selection, or the page, from the page's corner so that two
        // fills of it meet
        const selection = doc.state.selection;
        const b = selection ? selection.bounds : { left: 0, top: 0, right: doc.width, bottom: doc.height };
        const left = Math.max(0, Math.floor(b.left));
        const top = Math.max(0, Math.floor(b.top));
        const right = Math.min(doc.width, Math.ceil(b.right));
        const bottom = Math.min(doc.height, Math.ceil(b.bottom));
        if (right <= left || bottom <= top || (right - left) * (bottom - top) > MAX_PATTERN) {
          picture.close();
          A.toast(T("This area is too large for a pattern."), true);
          return;
        }
        const bitmap = PS.newCanvas(right - left, bottom - top);
        const ctx = bitmap.getContext("2d");
        ctx.translate(-left, -top);
        ctx.fillStyle = ctx.createPattern(picture, "repeat");
        ctx.fillRect(left, top, right - left, bottom - top);
        if (selection) {
          const clip = PS.clipOf(selection, 0, 0);
          ctx.globalCompositeOperation = "destination-in";
          if (clip.canvas) ctx.drawImage(clip.canvas, clip.x, clip.y);
          else ctx.fillRect(clip.x, clip.y, clip.width, clip.height);
        }
        picture.close();
        ops.newLayer(material.name, undefined, { bitmap, left, top });
      } else {
        const bitmap = PS.newCanvas(w, h);
        bitmap.getContext("2d").drawImage(picture, 0, 0);
        picture.close();
        const v = A.view();
        const stage = $("stage") ? $("stage").getBoundingClientRect() : null;
        // Where it was dropped, else the middle of what the window shows of the page
        const centre = at || (stage && v ? [Math.max(0, Math.min(doc.width, (stage.width / 2 - v.x) / v.zoom)), Math.max(0, Math.min(doc.height, (stage.height / 2 - v.y) / v.zoom))] : [doc.width / 2, doc.height / 2]);
        ops.newLayer(material.name, undefined, { bitmap, left: Math.round(centre[0] - w / 2), top: Math.round(centre[1] - h / 2) });
        // Sized right away, as a placed picture is in Photoshop
        const transform = (A.MENUS || []).flatMap(([, items]) => items).find((item) => item && item.label === "Free Transform");
        if (transform && (!transform.enabled || transform.enabled())) transform.action();
      }
    } catch (error) {
      console.error(error);
      A.toast(fill(T("{name} can't be read."), { name: material.name }), true);
    } finally {
      A.working(null);
    }
  };

  /* --------------------------------- importing --------------------------------- */

  let importing = false;
  const importFiles = async (list) => {
    const files = Array.from(list || []).map((entry) => entry.file || entry).filter((file) => file && KINDS.test(file.name));
    if (!files.length) return false;
    if (importing) {
      A.toast(T("An import is already running."));
      return true;
    }
    importing = true;
    show();
    const task = A.actions.background(T("Importing…"));
    const counts = { brushes: 0, materials: 0, skipped: [] };
    let order = Date.now();
    let fileId = null;
    let pending = Promise.resolve();
    const later = (run) => {
      pending = pending.then(run).catch((error) => console.error(error));
    };
    try {
      const payload = [];
      for (const file of files) payload.push({ name: file.name, bytes: await file.arrayBuffer() });
      await ask({ op: "import", files: payload }, payload.map((item) => item.bytes), (data) => {
        if (data.type === "progress") task.say(fill(T("Importing {name}…"), { name: data.name }));
        else if (data.type === "skipped") counts.skipped.push(data);
        else if (data.type === "brush") {
          if (data.file) {
            fileId = newId();
            const bytes = data.file;
            const id = fileId;
            later(() => put("files", { id, bytes }));
          }
          const record = { id: newId(), name: data.name, group: data.group || "", fileId, index: data.index, size: data.size, erase: data.erase, textured: data.textured, notes: data.notes, thumb: data.thumb, order: order++ };
          lib.brushes.push(record);
          counts.brushes++;
          later(() => put("brushes", record));
          renderSoon();
        } else if (data.type === "material") {
          const record = { id: newId(), name: data.name, group: data.group || "", width: data.width, height: data.height, pageWidth: data.pageWidth, pageHeight: data.pageHeight, tiling: data.tiling, thumb: data.thumb, order: order++ };
          lib.materials.push(record);
          counts.materials++;
          const png = data.png;
          later(() => put("pictures", { id: record.id, png }));
          later(() => put("materials", record));
          renderSoon();
        }
      });
      await pending;
    } catch (error) {
      console.error(error);
      A.toast(T("The import stopped: a file couldn't be read."), true);
    }
    importing = false;
    task.done();
    render();
    const parts = [];
    if (counts.brushes) parts.push(fill(T(counts.brushes === 1 ? "{n} brush" : "{n} brushes"), { n: counts.brushes }));
    if (counts.materials) parts.push(fill(T(counts.materials === 1 ? "{n} material" : "{n} materials"), { n: counts.materials }));
    const layers = counts.skipped.filter((item) => item.why === "layers").reduce((sum, item) => sum + (item.count || 0), 0);
    const unread = counts.skipped.filter((item) => item.why === "unread" || item.why === "kind");
    const lines = [];
    if (parts.length) lines.push(fill(T("Imported: {what}."), { what: parts.join(", ") }));
    else lines.push(T("Nothing to import was found in these files."));
    if (layers) lines.push(fill(T(layers === 1 ? "{n} layer TypeR can't draw was left out." : "{n} layers TypeR can't draw were left out."), { n: layers }));
    if (unread.length) lines.push(fill(T("{name} can't be read."), { name: unread[0].name }));
    A.toast(lines.join(" "), lines.length > 1);
    if (counts.materials && !counts.brushes && prefs.tab !== "materials") setTab("materials");
    else if (counts.brushes && !counts.materials && prefs.tab !== "brushes") setTab("brushes");
    return true;
  };

  /* --------------------------------- the panel --------------------------------- */

  const head = $("head-library");
  if (head) head.textContent = T("Library");
  const tabs = make("div", "library__tabs", pane);
  tabs.setAttribute("role", "tablist");
  const tabButtons = {};
  [["brushes", "Brushes"], ["materials", "Materials"]].forEach(([id, label]) => {
    const button = make("button", "library__tab", tabs);
    button.type = "button";
    button.setAttribute("role", "tab");
    button.addEventListener("click", () => setTab(id));
    tabButtons[id] = { button, label };
  });
  const list = make("div", "library", pane);
  list.setAttribute("role", "listbox");
  const foot = make("div", "layers__foot library__foot", pane);
  const input = make("input", "", pane);
  input.type = "file";
  input.accept = ACCEPT;
  input.multiple = true;
  input.hidden = true;
  input.addEventListener("change", () => {
    importFiles(input.files);
    input.value = "";
  });
  const footButton = (icon, label, action) => {
    const button = make("button", "icon-btn", foot);
    button.type = "button";
    button.innerHTML = ICONS[icon];
    button.title = T(label);
    button.setAttribute("aria-label", T(label));
    button.addEventListener("click", action);
    return button;
  };
  const importButton = footButton("import", "Import Brushes and Materials…", () => input.click());
  const placeButton = footButton("place", "Place on the Page", () => {
    if (picked) place(picked);
  });
  const scaleBox = make("label", "library__scale", foot);
  make("span", "", scaleBox, T("Scale"));
  const scaleInput = make("input", "", scaleBox);
  scaleInput.type = "number";
  scaleInput.min = 5;
  scaleInput.max = 800;
  scaleInput.step = 5;
  make("span", "", scaleBox, "%");
  scaleInput.addEventListener("change", () => {
    if (!picked) return;
    picked.myScale = Math.max(5, Math.min(800, Math.round(Number(scaleInput.value)) || 100));
    scaleInput.value = picked.myScale;
    put("materials", picked).catch(() => {});
  });
  make("span", "library__grow", foot);
  const trashButton = footButton("trash", "Delete", () => removePicked());

  const setTab = (id) => {
    prefs.tab = id;
    keepPrefs();
    render();
  };
  const groupsOf = (records) => {
    const groups = new Map();
    records.slice().sort(byOrder).forEach((record) => {
      const name = record.group || "";
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(record);
    });
    return groups;
  };
  const remove = async (records) => {
    if (!records.length) return;
    const brushes = records.filter((record) => lib.brushes.includes(record));
    const materials = records.filter((record) => lib.materials.includes(record));
    lib.brushes = lib.brushes.filter((record) => !brushes.includes(record));
    lib.materials = lib.materials.filter((record) => !materials.includes(record));
    if (chosen && brushes.includes(chosen.record)) choose(null);
    if (picked && materials.includes(picked)) picked = null;
    records.forEach((record) => forget(record.id));
    // A brush's file goes when no brush of the library is read from it any more
    const files = new Set(brushes.map((record) => record.fileId).filter((id) => id && !lib.brushes.some((record) => record.fileId === id)));
    await tx(["brushes", "files", "materials", "pictures"], "readwrite", (t) => {
      brushes.forEach((record) => t.objectStore("brushes").delete(record.id));
      files.forEach((id) => t.objectStore("files").delete(id));
      materials.forEach((record) => {
        t.objectStore("materials").delete(record.id);
        t.objectStore("pictures").delete(record.id);
      });
    }).catch((error) => console.error(error));
    render();
  };
  const removePicked = () => {
    if (prefs.tab === "brushes" && chosen) remove([chosen.record]);
    else if (prefs.tab === "materials" && picked) remove([picked]);
  };
  const menuFor = (event, items) => {
    if (Shell.touch) return;
    event.preventDefault();
    A.actions.openContextMenu(event.clientX, event.clientY, items);
  };

  const brushRow = (record, parent) => {
    const row = make("button", "library__brush", parent);
    row.type = "button";
    row.setAttribute("role", "option");
    const on = record ? Boolean(chosen && chosen.record === record) : !chosen;
    row.classList.toggle("is-on", on);
    row.setAttribute("aria-selected", on ? "true" : "false");
    const thumb = make("span", "library__stroke", row);
    if (record && record.thumb) {
      const img = make("img", "", thumb);
      img.alt = "";
      img.draggable = false;
      img.src = urlOf(record);
    } else thumb.classList.add("library__stroke--round");
    make("span", "library__name", row, record ? record.name : T("Round Brush"));
    row.title = record ? record.name : T("Round Brush");
    row.addEventListener("click", () => choose(record));
    if (record) row.addEventListener("contextmenu", (event) => menuFor(event, [{ label: "Delete", action: () => remove([record]) }]));
    return row;
  };
  const materialTile = (record, parent) => {
    const tile = make("button", "library__tile", parent);
    tile.type = "button";
    tile.setAttribute("role", "option");
    tile.classList.toggle("is-on", picked === record);
    tile.classList.toggle("is-pattern", Boolean(record.tiling));
    tile.title = `${record.name} (${record.width} × ${record.height} px)`;
    const img = make("img", "", tile);
    img.alt = record.name;
    img.src = urlOf(record);
    tile.draggable = true;
    tile.addEventListener("dragstart", (event) => {
      dragged = record;
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData("text/plain", record.name);
    });
    tile.addEventListener("dragend", () => {
      dragged = null;
    });
    tile.addEventListener("click", () => {
      picked = record;
      render();
    });
    tile.addEventListener("dblclick", () => place(record));
    tile.addEventListener("contextmenu", (event) => menuFor(event, [{ label: "Place on the Page", action: () => place(record) }, null, { label: "Delete", action: () => remove([record]) }]));
    return tile;
  };
  let dragged = null;
  const groupHead = (name, records, parent) => {
    const key = `${prefs.tab}:${name}`;
    const open = !prefs.closed[key];
    const headEl = make("button", "library__ghead", parent);
    headEl.type = "button";
    headEl.setAttribute("aria-expanded", open ? "true" : "false");
    const arrow = make("span", "library__arrow", headEl);
    arrow.innerHTML = ICONS.arrow;
    make("span", "library__gname", headEl, name);
    make("span", "library__gcount", headEl, String(records.length));
    headEl.title = name;
    headEl.addEventListener("click", () => {
      if (open) prefs.closed[key] = true;
      else delete prefs.closed[key];
      keepPrefs();
      render();
    });
    headEl.addEventListener("contextmenu", (event) => menuFor(event, [{ label: "Delete Group", action: () => remove(records) }]));
    return open;
  };
  const render = () => {
    renderTimer = 0;
    Object.keys(tabButtons).forEach((id) => {
      const { button, label } = tabButtons[id];
      const count = lib[id].length;
      button.textContent = count ? `${T(label)} (${count})` : T(label);
      button.classList.toggle("is-on", prefs.tab === id);
      button.setAttribute("aria-selected", prefs.tab === id ? "true" : "false");
    });
    const at = list.scrollTop;
    list.textContent = "";
    const brushes = prefs.tab === "brushes";
    list.classList.toggle("library--materials", !brushes);
    const records = brushes ? lib.brushes : lib.materials;
    if (brushes) brushRow(null, list);
    if (!records.length && lib.ready) {
      const empty = make("div", "library__empty", list);
      make("p", "", empty, T(brushes ? "Bring in your Clip Studio Paint brushes (.sut), alone or in a .zip: they paint with the Brush (B)." : "Bring in Clip Studio Paint materials (.clip), alone or in a .zip: bubbles, pictures and screentones to place on the page."));
      const button = make("button", "btn", empty, T("Import…"));
      button.type = "button";
      button.addEventListener("click", () => input.click());
    }
    groupsOf(records).forEach((items, name) => {
      const open = name ? groupHead(name, items, list) : true;
      if (!open) return;
      const body = make("div", brushes ? "library__body" : "library__body library__grid", list);
      items.forEach((record) => (brushes ? brushRow(record, body) : materialTile(record, body)));
    });
    list.scrollTop = at;
    placeButton.hidden = brushes;
    placeButton.disabled = !picked;
    scaleBox.hidden = brushes || !picked;
    if (picked) scaleInput.value = picked.myScale || 100;
    trashButton.disabled = brushes ? !chosen : !picked;
    importButton.disabled = importing;
  };
  let renderTimer = 0;
  const renderSoon = () => {
    if (!renderTimer) renderTimer = setTimeout(render, 120);
  };
  const Workspace = () => window.TypeRWorkspace;
  // The panel brought out: on a touch screen it is a sheet, opened from More (touch.js)
  const show = () => {
    ensureLoaded();
    if (Shell.touch) return;
    const workspace = Workspace();
    if (workspace && workspace.isVisible && !workspace.isVisible("library") && workspace.toggle) workspace.toggle("library");
  };

  // Files dropped on the panel are imported; on the page, a material dragged from the panel is
  // placed where it is let go
  pane.addEventListener("dragover", (event) => {
    if (!Array.from(event.dataTransfer.types || []).includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    pane.classList.add("is-drop");
  });
  pane.addEventListener("dragleave", () => pane.classList.remove("is-drop"));
  pane.addEventListener("drop", (event) => {
    pane.classList.remove("is-drop");
    if (!event.dataTransfer.files || !event.dataTransfer.files.length) return;
    event.preventDefault();
    event.stopPropagation();
    if (Array.from(event.dataTransfer.files).some((file) => KINDS.test(file.name))) importFiles(event.dataTransfer.files);
    else A.toast(T("Nothing to import was found in these files."));
  });
  const stage = $("stage");
  if (stage) {
    stage.addEventListener("dragover", (event) => {
      if (!dragged) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    });
    stage.addEventListener("drop", (event) => {
      if (!dragged) return;
      event.preventDefault();
      const material = dragged;
      dragged = null;
      place(material, material.tiling ? null : A.toDoc(event));
    });
  }

  /* --------------------------------- the options bar --------------------------------- */

  // The Brush's options with a brush of the library: its name (a click shows the panel), its
  // opacity, and the scale of its paper when it has one. Its size is the Brush's.
  const options = (bar) => {
    if (app.tool !== "brush") return;
    const name = make("button", "obar__preset", null, chosen ? chosen.record.name : T("Round Brush"));
    name.type = "button";
    name.title = T("Library");
    name.addEventListener("click", () => {
      if (prefs.tab !== "brushes") setTab("brushes");
      show();
    });
    bar.insertBefore(name, bar.firstChild);
    if (!chosen) return;
    const { record, brush } = chosen;
    const number = (value, min, max, set) => A.numberInput(value, min, max, (next) => {
      set(Math.max(min, Math.min(max, Math.round(next) || min)));
      keepBrush(record);
    });
    const labelled = (text, control) => {
      const label = make("label", "obar__field");
      make("span", "", label, text);
      label.appendChild(control);
      return label;
    };
    bar.appendChild(labelled(T("Opacity"), number(record.myOpacity === undefined ? Math.round(brush.settings.opacity * 100) : record.myOpacity, 1, 100, (value) => {
      record.myOpacity = value;
    })));
    if (brush.texture) {
      bar.appendChild(labelled(T("Pattern scale"), number(record.paperScale || 100, 5, 800, (value) => {
        record.paperScale = value;
      })));
    }
  };

  window.TypeRLibrary = {
    preset,
    rgbOf,
    options,
    importFiles,
    // Whether a file is one the library takes (app.js's openFiles sends it here)
    takes: (name) => KINDS.test(name || ""),
    pick: () => input.click(),
    show,
    chosen: () => (chosen ? chosen.record : null),
    choose,
  };

  let loadingLib = null;
  const ensureLoaded = () => {
    if (loadingLib) return loadingLib;
    loadingLib = Promise.all([all("brushes"), all("materials")]).then(([brushes, materials]) => {
      lib.brushes = brushes.concat(lib.brushes);
      lib.materials = materials.concat(lib.materials);
      lib.ready = true;
      render();
    }).catch((error) => {
      console.error(error);
      lib.ready = true;
      render();
    });
    return loadingLib;
  };
  const scheduleLoad = () => {
    if (loadingLib) return;
    if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(() => ensureLoaded(), { timeout: 2500 });
    else setTimeout(ensureLoaded, 800);
  };
  if (pane.offsetParent !== null) ensureLoaded();
  else if (A.booted) scheduleLoad();
  else window.addEventListener("typer-booted", scheduleLoad, { once: true });
  render();
})();
