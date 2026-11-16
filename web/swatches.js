// Photoshop's Swatches panel (Window > Swatches): the colours kept, each a click away.
//
//   the swatches  { hex, name } each, the list the Color Picker shows too (app.js keeps it,
//                 typer.web.swatches); the view (thumbnails or list) in typer.web.swatches.view
//   a click       makes it the foreground colour, and so the colour of the selected text layers
//                 (or of the letters selected while typing), one step of history, as the
//                 foreground swatch of the toolbar does. Alt+click (or Ctrl/Cmd+click, as in
//                 Photoshop) makes it the background colour.
//   arranging     + adds the foreground colour; a swatch is dragged to another place, or onto
//                 the bin; double-click or F2 names it; right-click renames or deletes it
//   files         Photoshop's .aco and Adobe's .ase are read (Import Swatches…, Replace
//                 Swatches…, or File > Open and a drop); Export Swatches… writes an .aco, with
//                 the names, that Photoshop loads

(function () {
  "use strict";

  const PS = window.TypeRPhotoshop;
  const A = window.TypeRApp;
  if (!PS || !A || !A.actions || !A.swatches) return;
  const { app } = PS;
  const host = A.actions;
  const store = A.swatches;
  const { T, fill } = A;
  const Shell = window.TypeRShell || {};
  const $ = (id) => document.getElementById(id);
  const STORE_VIEW = "typer.web.swatches.view";

  const make = (tag, className, parent, text) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    if (parent) parent.appendChild(el);
    return el;
  };
  const byte = (value) => Math.max(0, Math.min(255, Math.round(value)));
  const toHex = (r, g, b) => `#${[r, g, b].map((value) => byte(value).toString(16).padStart(2, "0")).join("")}`;
  const fromHex = (hex) => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) });

  /* ------------------------------ colours from files ------------------------------ */

  // CMYK by the plain formula, as the Color Picker shows it (Photoshop's goes through a profile)
  const fromCmyk = (c, m, y, k) => toHex(255 * (1 - c) * (1 - k), 255 * (1 - m) * (1 - k), 255 * (1 - y) * (1 - k));
  const fromHsb = (h, s, v) => {
    const at = (n) => {
      const k = (n + h / 60) % 6;
      return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    };
    return toHex(at(5) * 255, at(3) * 255, at(1) * 255);
  };
  // Photoshop's Lab is D50: to XYZ, adapted to D65 (Bradford), then sRGB
  const fromLab = (l, a, b) => {
    const fy = (l + 16) / 116;
    const fx = fy + a / 500;
    const fz = fy - b / 200;
    const f = (t) => (t > 6 / 29 ? t * t * t : 3 * (6 / 29) * (6 / 29) * (t - 4 / 29));
    const x = 0.9642 * f(fx);
    const y = f(fy);
    const z = 0.8251 * f(fz);
    const x65 = 0.9555766 * x - 0.0230393 * y + 0.0631636 * z;
    const y65 = -0.0282895 * x + 1.0099416 * y + 0.0210077 * z;
    const z65 = 0.0122982 * x - 0.020483 * y + 1.3299098 * z;
    const gamma = (v) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(0, v), 1 / 2.4) - 0.055);
    return toHex(gamma(3.2404542 * x65 - 1.5371385 * y65 - 0.4985314 * z65), gamma(-0.969266 * x65 + 1.8760108 * y65 + 0.041556 * z65), gamma(0.0556434 * x65 - 0.2040259 * y65 + 1.0572252 * z65));
  };

  // Photoshop's .aco: a first part with the colours, then (since Photoshop 6) the same colours
  // with their names. Each colour is a colour space and four 16-bit numbers.
  const fromAco = (bytes) => {
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = 0;
    const u16 = () => {
      if (at + 2 > bytes.length) throw new Error(T("the file ends too soon"));
      const value = data.getUint16(at);
      at += 2;
      return value;
    };
    let skipped = 0;
    const colorAt = () => {
      const space = u16();
      const w = u16();
      const x = u16();
      const y = u16();
      u16();
      if (space === 0) return toHex(w / 257, x / 257, y / 257);
      if (space === 1) return fromHsb((w / 65536) * 360, x / 65535, y / 65535);
      // 0 is full ink, as Photoshop writes it
      if (space === 2) return fromCmyk(1 - w / 65535, 1 - x / 65535, 1 - y / 65535, 1 - data.getUint16(at - 2) / 65535);
      if (space === 7) return fromLab(w / 100, data.getInt16(at - 6) / 100, data.getInt16(at - 4) / 100);
      // Grey as Photoshop's K: 10000 is black
      if (space === 8) return toHex(...Array(3).fill(255 * (1 - Math.min(10000, w) / 10000)));
      skipped++;
      return null;
    };
    const readPart = (named) => {
      const version = u16();
      if (version !== (named ? 2 : 1)) throw new Error(T("this isn't a swatches file"));
      const count = u16();
      const out = [];
      for (let i = 0; i < count; i++) {
        const hex = colorAt();
        let name = "";
        if (named) {
          if (at + 4 > bytes.length) throw new Error(T("the file ends too soon"));
          const length = data.getUint32(at);
          at += 4;
          const chars = [];
          for (let c = 0; c < length; c++) chars.push(u16());
          name = String.fromCharCode(...chars.filter(Boolean)).trim();
        }
        if (hex) out.push({ hex, name });
      }
      return out;
    };
    // A file of only the second part is read too
    const first = data.byteLength >= 2 ? data.getUint16(0) : 0;
    if (first === 2) return { swatches: readPart(true), skipped };
    const plain = readPart(false);
    if (at + 4 <= bytes.length && data.getUint16(at) === 2) {
      const before = { at, skipped };
      try {
        skipped = 0;
        return { swatches: readPart(true), skipped };
      } catch (error) {
        // The names are broken: the colours still are what they are
        ({ at, skipped } = before);
      }
    }
    return { swatches: plain, skipped };
  };

  // Adobe Swatch Exchange (.ase): blocks of colours, by name, in groups (laid flat here)
  const fromAse = (bytes) => {
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (String.fromCharCode(...bytes.subarray(0, 4)) !== "ASEF") throw new Error(T("this isn't a swatches file"));
    const count = data.getUint32(8);
    const out = [];
    let skipped = 0;
    let at = 12;
    for (let i = 0; i < count && at + 6 <= bytes.length; i++) {
      const type = data.getUint16(at);
      const length = data.getUint32(at + 2);
      const start = at + 6;
      at = start + length;
      if (type !== 1 || at > bytes.length) continue;
      let p = start;
      const chars = data.getUint16(p);
      p += 2;
      const name = [];
      for (let c = 0; c < chars; c++, p += 2) name.push(data.getUint16(p));
      const model = String.fromCharCode(...bytes.subarray(p, p + 4));
      p += 4;
      const f = (n) => data.getFloat32(p + n * 4);
      let hex = null;
      if (model === "RGB ") hex = toHex(f(0) * 255, f(1) * 255, f(2) * 255);
      else if (model === "CMYK") hex = fromCmyk(f(0), f(1), f(2), f(3));
      // Lightness as a fraction of 100
      else if (model === "LAB ") hex = fromLab(f(0) <= 1 ? f(0) * 100 : f(0), f(1), f(2));
      else if (model === "Gray") hex = toHex(f(0) * 255, f(0) * 255, f(0) * 255);
      if (hex) out.push({ hex, name: String.fromCharCode(...name.filter(Boolean)).trim() });
      else skipped++;
    }
    return { swatches: out, skipped };
  };

  // Both parts, so that any Photoshop reads it, and every name kept
  const acoOf = (list) => {
    const size = 4 + list.length * 10 + 4 + list.reduce((total, swatch) => total + 10 + 4 + (swatch.name.length + 1) * 2, 0);
    const out = new DataView(new ArrayBuffer(size));
    let at = 0;
    const u16 = (value) => {
      out.setUint16(at, value);
      at += 2;
    };
    [false, true].forEach((named) => {
      u16(named ? 2 : 1);
      u16(list.length);
      list.forEach((swatch) => {
        const c = fromHex(swatch.hex);
        u16(0);
        u16(c.r * 257);
        u16(c.g * 257);
        u16(c.b * 257);
        u16(0);
        if (!named) return;
        out.setUint32(at, swatch.name.length + 1);
        at += 4;
        for (let i = 0; i < swatch.name.length; i++) u16(swatch.name.charCodeAt(i));
        u16(0);
      });
    });
    return new Uint8Array(out.buffer);
  };

  /* ---------------------------------- the list ---------------------------------- */

  let swatches = store.read();
  // The swatch chosen (the last clicked), by its place, for Rename, Delete and the keys
  let chosen = -1;
  let view = "small";
  try {
    const kept = window.localStorage.getItem(STORE_VIEW);
    if (["small", "large", "list"].includes(kept)) view = kept;
  } catch (error) {
    // The thumbnails, then
  }
  let writing = false;
  const changed = () => {
    writing = true;
    swatches = store.write(swatches);
    writing = false;
    if (chosen >= swatches.length) chosen = swatches.length - 1;
    render();
  };
  // The Color Picker's Add to Swatches
  window.addEventListener("typer-swatches", () => {
    if (writing) return;
    swatches = store.read();
    if (chosen >= swatches.length) chosen = swatches.length - 1;
    render();
  });

  const labelOf = (swatch) => (swatch.name ? `${swatch.name} (${swatch.hex.toUpperCase()})` : swatch.hex.toUpperCase());

  // The foreground colour, given to the selected text as the toolbar's swatch gives it; or the
  // background colour
  const use = (swatch, background) => {
    if (!swatch) return;
    const c = fromHex(swatch.hex);
    if (background) app.bg = c;
    else app.fg = c;
    host.showColors();
    if (background) return;
    // Text already of that colour gets no step of history
    const same = (style) => style.color && style.color.red === c.r && style.color.green === c.g && style.color.blue === c.b;
    const texts = A.activeTexts();
    if (!A.isEditing() && texts.every((layer) => layer.params.layerText.textStyleRange.every((run) => same(run.textStyle)))) return;
    A.applyTextPatch({ color: { red: c.r, green: c.g, blue: c.b } });
  };
  const forBackground = (event) => event.altKey || event.metaKey || event.ctrlKey;

  // + : the foreground colour, at the end, as Photoshop adds it; one already there is chosen
  const addForeground = () => {
    const hex = toHex(app.fg.r, app.fg.g, app.fg.b);
    const there = swatches.findIndex((swatch) => swatch.hex === hex);
    if (there < 0) {
      if (swatches.length >= store.max) {
        A.toast(T("The Swatches panel is full: delete a swatch first."), true);
        return;
      }
      swatches.push({ hex, name: "" });
    }
    chosen = there < 0 ? swatches.length - 1 : there;
    changed();
    requestAnimationFrame(() => focusChosen(false));
  };
  const renameSwatch = async (at = chosen) => {
    const swatch = swatches[at];
    if (!swatch) return;
    const values = await A.dialog({ title: T("Swatch Name"), ok: "OK", fields: [{ id: "name", label: T("Name"), value: swatch.name || swatch.hex.toUpperCase() }] });
    if (!values) return;
    const name = values.name.trim().slice(0, 120);
    swatch.name = name.toLowerCase() === swatch.hex || name.toUpperCase() === swatch.hex.toUpperCase() ? "" : name;
    chosen = at;
    changed();
    requestAnimationFrame(() => focusChosen(false));
  };
  const deleteSwatch = async (at = chosen, ask = true) => {
    const swatch = swatches[at];
    if (!swatch) return;
    if (ask && !(await A.dialog({ title: T("Delete Swatch"), body: fill(T("Delete the swatch “{name}”?"), { name: labelOf(swatch) }), ok: T("Delete") }))) return;
    swatches.splice(at, 1);
    chosen = Math.min(at, swatches.length - 1);
    changed();
    requestAnimationFrame(() => focusChosen(false));
  };
  // Dropped before the swatch at `to` (the list's length: at the end)
  const moveSwatch = (from, to) => {
    const [swatch] = swatches.splice(from, 1);
    const at = to > from ? to - 1 : to;
    swatches.splice(at, 0, swatch);
    chosen = at;
    changed();
  };
  const setView = (next) => {
    view = next;
    try {
      window.localStorage.setItem(STORE_VIEW, view);
    } catch (error) {
      // Kept for this visit only
    }
    render();
  };

  /* ---------------------------------- the files ---------------------------------- */

  // Reads an .aco or an .ase into the panel, after the swatches there, or in their place
  const loadFile = async (file, replace = false) => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const isAse = /\.ase$/i.test(file.name) || String.fromCharCode(...bytes.subarray(0, 4)) === "ASEF";
      const read = isAse ? fromAse(bytes) : fromAco(bytes);
      const before = replace ? [] : swatches;
      const seen = new Set(before.map((swatch) => `${swatch.hex} ${swatch.name}`));
      const fresh = read.swatches.filter((swatch) => {
        const key = `${swatch.hex} ${swatch.name}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const room = Math.max(0, store.max - before.length);
      swatches = before.concat(fresh.slice(0, room));
      chosen = swatches.length ? Math.min(before.length, swatches.length - 1) : -1;
      changed();
      const said = [fill(T("Imported from {name}: {count} swatches."), { name: file.name, count: Math.min(fresh.length, room) })];
      if (fresh.length > room) said.push(fill(T("The panel is full: {count} were left out."), { count: fresh.length - room }));
      if (read.skipped) said.push(fill(T("{count} colours in a colour space TypeR doesn't read were left out."), { count: read.skipped }));
      A.toast(said.join(" "), fresh.length > room || read.skipped > 0);
      if (window.TypeRWorkspace && !window.TypeRWorkspace.isVisible("swatches") && !Shell.touch) window.TypeRWorkspace.setVisible("swatches", true);
      return { added: Math.min(fresh.length, room), skipped: read.skipped };
    } catch (error) {
      console.warn("TypeR web: a swatches file can't be read", error);
      A.toast(fill(T("{name} can't be read: {error}"), { name: file.name, error: error.message || error }), true);
      return { added: 0, error: String(error.message || error) };
    }
  };
  const pickFiles = (replace) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".aco,.ase";
    input.multiple = !replace;
    input.addEventListener("change", async () => {
      const files = Array.from(input.files);
      for (let i = 0; i < files.length; i++) await loadFile(files[i], replace && i === 0);
    });
    input.click();
  };
  const exportSwatches = async () => {
    if (!swatches.length) return;
    const blob = new Blob([acoOf(swatches)], { type: "application/octet-stream" });
    const name = `${T("TypeR Swatches").replace(/[\\/:*?"<>|]+/g, "-")}.aco`;
    try {
      const file = new File([blob], name, { type: blob.type });
      if (Shell.touch && navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
        return;
      }
      if (window.showSaveFilePicker) {
        const handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: T("Photoshop Swatches"), accept: { "application/octet-stream": [".aco"] } }] });
        await host.writeTo(handle, blob);
        A.toast(fill(T("Saved {name}."), { name: handle.name }));
      } else {
        host.download(blob, name);
        A.toast(fill(T("Downloaded {name}."), { name }));
      }
    } catch (error) {
      if (error.name !== "AbortError") A.toast(fill(T("Could not save: {error}"), { error: error.message || error }), true);
    }
  };

  /* ---------------------------------- the panel ---------------------------------- */

  const pane = $("pane-swatches");
  const list = $("swatch-list");
  const foot = $("swatch-list-foot");
  if (!pane || !list || !foot) return;
  const SVG = (inner) => `<svg viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
  const ICONS = {
    add: SVG('<path d="M7 4h7l4 4v12H7Z"/><path d="M12.5 10v6M9.5 13h6"/>'),
    trash: A.ICON.trash,
    menu: A.ICON.more,
  };
  const HINT = () => T("Click: foreground colour, and the selected text. Alt+click: background colour.");

  const itemsOf = () => Array.from(list.querySelectorAll(".swatch-list__item"));
  const render = () => {
    const scroll = list.scrollTop;
    list.textContent = "";
    list.className = `swatch-list swatch-list--${view}`;
    swatches.forEach((swatch, at) => {
      const item = make("button", "swatch-list__item", list);
      item.type = "button";
      item.setAttribute("role", "option");
      item.tabIndex = -1;
      item.dataset.at = String(at);
      const on = at === chosen;
      item.classList.toggle("is-on", on);
      item.setAttribute("aria-selected", String(on));
      item.title = `${labelOf(swatch)}\n${HINT()}`;
      item.setAttribute("aria-label", labelOf(swatch));
      make("span", "swatch-list__chip", item).style.background = swatch.hex;
      if (view === "list") make("span", "swatch-list__name", item, swatch.name || swatch.hex.toUpperCase());
    });
    if (!swatches.length) make("p", "swatch-list__empty", list, T("No swatches yet. Click + to keep the foreground colour here."));
    const items = itemsOf();
    const focusable = items[chosen] || items[0];
    if (focusable) focusable.tabIndex = 0;
    list.scrollTop = scroll;
    renderFoot();
  };
  const focusChosen = (andScroll = true) => {
    const items = itemsOf();
    const item = items[chosen] || items[0];
    if (!item) return;
    items.forEach((one) => { one.tabIndex = one === item ? 0 : -1; });
    if (pane.contains(document.activeElement) || andScroll) item.scrollIntoView({ block: "nearest" });
    if (pane.contains(document.activeElement)) item.focus({ preventScroll: true });
  };
  const choose = (at) => {
    chosen = at;
    itemsOf().forEach((item, index) => {
      item.classList.toggle("is-on", index === at);
      item.setAttribute("aria-selected", String(index === at));
      item.tabIndex = index === at ? 0 : -1;
    });
    renderFoot();
  };
  const indexOf = (item) => (item ? Number(item.dataset.at) : -1);

  // While typing, a click on a swatch leaves the letters selected and the caret where it is
  list.addEventListener("mousedown", (event) => {
    if (A.isEditing() && event.target.closest(".swatch-list__item")) event.preventDefault();
  });

  // Dragged (past a few pixels), a swatch goes before the one it is let go on (after it, past
  // its middle), to the end on the free space, or away on the bin
  let dragged = false;
  list.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.pointerType === "touch") return;
    const source = event.target.closest(".swatch-list__item");
    if (!source) return;
    const from = indexOf(source);
    const swatch = swatches[from];
    const x0 = event.clientX;
    const y0 = event.clientY;
    let ghost = null;
    let target = null;
    const mark = (next) => {
      if (target && target.el) target.el.classList.remove("is-drop", "is-drop-before", "is-drop-after");
      target = next;
      if (target && target.el) target.el.classList.add(target.mark);
    };
    const targetAt = (x, y) => {
      const under = document.elementFromPoint(x, y);
      if (!under) return null;
      const bin = under.closest(".swatch-list__delete");
      if (bin && foot.contains(bin)) return { el: bin, mark: "is-drop", remove: true };
      if (!list.contains(under)) return null;
      const item = under.closest(".swatch-list__item");
      if (!item) return { el: null, to: swatches.length };
      const at = indexOf(item);
      const box = item.getBoundingClientRect();
      const rtl = getComputedStyle(list).direction === "rtl";
      const after = view === "list" ? y > box.top + box.height / 2 : (x > box.left + box.width / 2) !== rtl;
      return { el: item, mark: after ? "is-drop-after" : "is-drop-before", to: after ? at + 1 : at };
    };
    const move = (e) => {
      if (!ghost) {
        if (Math.hypot(e.clientX - x0, e.clientY - y0) < 5) return;
        ghost = make("div", "layer-ghost", document.body);
        make("i", "swatch-list__chip", ghost).style.background = swatch.hex;
        ghost.append(swatch.name || swatch.hex.toUpperCase());
        document.body.classList.add("is-dragging-tool");
      }
      ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 112}px)`;
      mark(targetAt(e.clientX, e.clientY));
    };
    const end = (e) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (!ghost) return;
      ghost.remove();
      document.body.classList.remove("is-dragging-tool");
      const at = target;
      mark(null);
      dragged = true;
      setTimeout(() => { dragged = false; }, 0);
      if (!at || e.type === "pointercancel") return;
      if (at.remove) deleteSwatch(from, false);
      else if (at.to !== from && at.to !== from + 1) moveSwatch(from, at.to);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  });

  list.addEventListener("click", (event) => {
    if (dragged) return;
    const item = event.target.closest(".swatch-list__item");
    if (!item) return;
    const at = indexOf(item);
    choose(at);
    use(swatches[at], forBackground(event));
  });
  list.addEventListener("dblclick", (event) => {
    const item = event.target.closest(".swatch-list__item");
    if (item) renameSwatch(indexOf(item));
  });
  list.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const item = event.target.closest(".swatch-list__item");
    const at = item ? indexOf(item) : -1;
    if (item) choose(at);
    const add = { label: "Create new swatch", action: addForeground };
    host.openContextMenu(event.clientX, event.clientY, item ? [
      { label: "Rename Swatch…", action: () => renameSwatch(at) },
      { label: "Delete Swatch", action: () => deleteSwatch(at, false) },
      null,
      add,
    ] : [add]);
  });
  // The keys of a grid: arrows move (up and down by a row), Enter or Space gives the colour
  // (with Alt, as the background), Delete removes it, F2 names it
  list.addEventListener("keydown", (event) => {
    if (host.isText(event.target)) return;
    const items = itemsOf();
    const at = items.indexOf(document.activeElement);
    if (at < 0) return;
    const across = view === "list" ? 1 : Math.max(1, Math.round(list.clientWidth / Math.max(1, items[0].offsetWidth + 2)));
    const go = (to) => {
      const next = Math.max(0, Math.min(items.length - 1, to));
      choose(next);
      items[next].focus();
      items[next].scrollIntoView({ block: "nearest" });
    };
    const rtl = getComputedStyle(list).direction === "rtl" && (event.key === "ArrowRight" || event.key === "ArrowLeft");
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: across, ArrowUp: -across }[event.key];
    if (step && !event.ctrlKey && !event.metaKey) go(at + (rtl ? -step : step));
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(items.length - 1);
    else if (event.key === "Enter" || event.key === " ") {
      choose(at);
      use(swatches[at], forBackground(event));
    } else if (event.key === "Delete" || event.key === "Backspace") deleteSwatch(at);
    else if (event.key === "F2") renameSwatch(at);
    else return;
    event.preventDefault();
    event.stopPropagation();
  });
  list.setAttribute("aria-label", T("Swatches"));

  // The panel's menu, then Create new swatch and Delete swatch, as in Photoshop
  const footButtons = {};
  const footButton = (name, icon, title, run) => {
    const button = make("button", `icon-btn swatch-list__${name}`, foot);
    button.type = "button";
    button.innerHTML = ICONS[icon];
    button.title = title;
    button.setAttribute("aria-label", title);
    button.addEventListener("click", run);
    footButtons[name] = button;
    return button;
  };
  const openMenu = (x, y, above) => {
    const has = () => Boolean(swatches[chosen]);
    host.openContextMenu(x, y, [
      { label: "Create new swatch", action: addForeground },
      { label: "Rename Swatch…", enabled: has, action: () => renameSwatch() },
      { label: "Delete Swatch", enabled: has, action: () => deleteSwatch() },
      null,
      { label: "Small Thumbnail", check: () => view === "small", action: () => setView("small") },
      { label: "Large Thumbnail", check: () => view === "large", action: () => setView("large") },
      { label: "Large List", check: () => view === "list", action: () => setView("list") },
      null,
      { label: "Import Swatches…", action: () => pickFiles(false) },
      { label: "Replace Swatches…", action: () => pickFiles(true) },
      { label: "Export Swatches…", enabled: () => swatches.length > 0, action: exportSwatches },
    ]);
    const opened = document.querySelector(".menu__list--context");
    if (opened && above) opened.style.top = `${Math.max(8, y - opened.offsetHeight)}px`;
  };
  const menuButton = footButton("menu", "menu", T("Swatches panel menu"), () => {
    const box = menuButton.getBoundingClientRect();
    openMenu(box.left, box.top - 4, true);
  });
  menuButton.setAttribute("aria-haspopup", "menu");
  make("span", "styles__grow", foot);
  footButton("add", "add", T("Create new swatch"), addForeground);
  footButton("delete", "trash", T("Delete Swatch"), () => deleteSwatch());
  const renderFoot = () => {
    footButtons.delete.disabled = !swatches[chosen];
  };

  $("head-swatches").textContent = T("Swatches");
  render();

  window.TypeRSwatches = {
    // app.js: an .aco or .ase opened or dropped
    loadFile,
    // For scripts and tests
    get swatches() {
      return swatches;
    },
    use: (at, background) => use(swatches[at], background),
    add: addForeground,
    move: moveSwatch,
    remove: (at) => deleteSwatch(at, false),
    fromAco,
    fromAse,
    acoOf,
  };
})();
