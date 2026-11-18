// The Verification panel (Window > Verification, Alt+Cmd+V): before a chapter goes out, every
// typesetting mistake of the page, or of all the pages (the open ones, and the chapter's pages
// imported but closed), in one list. A row takes you to the
// mistake, many are fixed in one click, and an AI proofreading, with the user's own key, adds
// what a reader would trip on to the same list.
//
//   the checks     verify-rules.js (TypeRVerify, whose header is the contract): the rules, their
//                  defaults, check(doc) and fix(doc, issue). This file only shows what it finds.
//   the store      the rules as the user set them, the scope, the issues ignored on each page
//                  and the consent to send texts to an AI service, in localStorage
//                  (typer.web.verify); all of it lives on for the visit when storage is refused
//   the list       true to the page while the panel is open: an edit, an undo or a fix checks
//                  the pages shown again, a moment after the last change, cancelled when another
//                  change comes. Closed, nothing runs.
//   proofreading   proofread.js (TypeRProofread): the visible texts of the pages, in reading
//                  order, go to OpenAI or Anthropic; what comes back is a row of the list
//                  ("Proofreading") until its text changes or the user clears it
//   Batch Save     says, discreetly, what the last check left on the pages it saves
//                  (batchNote, called by app.js)

(function () {
  "use strict";

  const PS = window.TypeRPhotoshop;
  const A = window.TypeRApp;
  const Rules = window.TypeRVerify;
  const AI = window.TypeRProofread || null;
  if (!PS || !A || !A.actions || !A.verify || !Rules) return;
  const { ops, app } = PS;
  const host = A.verify;
  const { T, fill } = A;
  const Shell = window.TypeRShell || {};
  const $ = (id) => document.getElementById(id);
  const STORE = "typer.web.verify";
  // Pages whose ignored issues are kept: the oldest go first
  const MAX_IGNORED_PAGES = 200;
  // How long after the last change the list is checked again
  const SETTLE = 450;

  const make = (tag, className, parent, text) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    if (parent) parent.appendChild(el);
    return el;
  };
  const button = (className, text, parent, run) => {
    const el = make("button", className, parent, text);
    el.type = "button";
    if (run) el.addEventListener("click", run);
    return el;
  };
  // The engine's words are English and translation keys at once: { text, values }
  const say = (message) => {
    if (!message) return "";
    if (typeof message === "string") return T(message);
    return fill(T(message.text || ""), message.values || {});
  };
  const plural = (count, one, many) => fill(T(count === 1 ? one : many), { count });

  /* --------------------------------- the store --------------------------------- */

  const read = () => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(STORE));
      if (saved && typeof saved === "object") return saved;
    } catch (error) {
      console.warn("TypeR web: could not read the verification settings", error);
    }
    return {};
  };
  const saved = read();
  const store = {
    rules: saved.rules && typeof saved.rules === "object" ? saved.rules : {},
    scope: saved.scope === "all" ? "all" : "page",
    ignored: saved.ignored && typeof saved.ignored === "object" ? saved.ignored : {},
    consent: saved.consent && typeof saved.consent === "object" ? saved.consent : {},
  };
  let keepTimer = 0;
  let warnedStorage = false;
  const keep = () => {
    clearTimeout(keepTimer);
    keepTimer = setTimeout(() => {
      try {
        window.localStorage.setItem(STORE, JSON.stringify(Object.assign({ version: 1 }, store)));
      } catch (error) {
        console.warn("TypeR web: could not keep the verification settings", error);
        if (!warnedStorage) A.toast(T("The verification settings can't be kept on this device: they last until the page is closed."), true);
        warnedStorage = true;
      }
    }, 150);
  };

  // The rules as the user set them, over the engine's defaults: what isn't known any more is
  // left out, what is new comes with its default
  const RULES = Array.isArray(Rules.RULES) ? Rules.RULES : [];
  const ruleOf = (id) => RULES.find((rule) => rule.id === id) || null;
  const rulesConfig = () => {
    const out = {};
    const base = Rules.defaults();
    Object.keys(base).forEach((id) => {
      const mine = store.rules[id] && typeof store.rules[id] === "object" ? store.rules[id] : {};
      out[id] = Object.assign({}, base[id]);
      Object.keys(base[id]).forEach((key) => {
        if (key in mine && typeof mine[key] === typeof base[id][key]) out[id][key] = mine[key];
      });
    });
    return out;
  };
  let config = rulesConfig();
  const ruleOn = (id) => !config[id] || config[id].on !== false;

  // Ignored issues, by page (its path: the same file next time) and by the issue's own id
  const pageKey = (doc) => String(doc.path || doc.name || doc.id);
  const ignoredOf = (doc) => new Set(Array.isArray(store.ignored[pageKey(doc)]) ? store.ignored[pageKey(doc)] : []);
  const setIgnored = (doc, ids) => {
    const key = pageKey(doc);
    delete store.ignored[key];
    if (ids.size) store.ignored[key] = Array.from(ids);
    const keys = Object.keys(store.ignored);
    keys.slice(0, Math.max(0, keys.length - MAX_IGNORED_PAGES)).forEach((old) => delete store.ignored[old]);
    keep();
  };

  /* ------------------------------ categories, severities ------------------------------ */

  const PROOF = "proofreading";
  const CATEGORY_NAMES = { placement: "Placement", shape: "Shape", stroke: "Stroke", text: "Text", consistency: "Consistency", missing: "Missing text", [PROOF]: "Proofreading" };
  const categories = () => {
    const list = (Array.isArray(Rules.CATEGORIES) ? Rules.CATEGORIES : []).slice();
    RULES.forEach((rule) => { if (!list.includes(rule.category)) list.push(rule.category); });
    return list;
  };
  const categoryName = (id) => T(CATEGORY_NAMES[id] || (id ? id[0].toUpperCase() + id.slice(1) : ""));
  const SEVERITY = ["error", "warning", "hint"];
  const SEVERITY_NAMES = { error: "Error", warning: "Warning", hint: "Hint" };
  const KIND_NAMES = { spelling: "Spelling", grammar: "Grammar", punctuation: "Punctuation", meaning: "Meaning", consistency: "Consistency" };
  const kindName = (kind) => T(KIND_NAMES[kind] || kind || "");
  const SVG = (inner) => `<svg viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
  const ICONS = {
    error: SVG('<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/>'),
    warning: SVG('<path d="M10.3 4.2 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z"/><path d="M12 9.5v4M12 17v.01"/>'),
    hint: SVG('<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.5v.01"/>'),
    clean: SVG('<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.8 2.8L16.5 9.5"/>'),
    check: SVG('<path d="M9 11.5 11.5 14 16 9"/><path d="M20 12a8 8 0 1 1-3.1-6.3"/>'),
    twist: SVG('<path d="m9 6 6 6-6 6"/>'),
    page: SVG('<path d="M6 3h9l4 4v14H6Z"/><path d="M14 3v5h5"/>'),
    sparkles: A.ICON.sparkles,
    key: A.ICON.key,
    settings: A.ICON.settings,
    more: A.ICON.more,
    eye: A.ICON.eye,
    close: A.ICON.close,
    redo: A.ICON.redo,
  };
  const severityOf = (issue) => (SEVERITY.includes(issue.severity) ? issue.severity : "hint");
  const PROOF_SEVERITY = { spelling: "warning", grammar: "warning" };

  /* ------------------------------- the pages' layers ------------------------------- */

  const layersOf = (doc) => (doc ? doc.state.layers : []);
  const layerIn = (doc, id) => layersOf(doc).find((layer) => layer.id === id) || null;
  const textOf = (layer) => (layer && layer.kind === "text" ? String(layer.params.layerText.textKey || "") : "");
  // Shown on the page: itself and every folder it is in
  const shownLayer = (layer, byId) => {
    for (let at = layer; at; at = at.group ? byId.get(at.group) : null) if (at.visible === false) return false;
    return true;
  };
  const inSfx = (layer, byId) => Boolean(layer.sfx || (layer.group && byId.get(layer.group) && byId.get(layer.group).sfx));
  const boxOf = (layer, doc) => {
    // A closed page keeps where its texts were when it was read
    if (doc && doc.closed) return layer.box || null;
    try {
      const box = PS.boxOf(layer, doc);
      return box && box.right > box.left && box.bottom > box.top ? box : null;
    } catch (error) {
      return null;
    }
  };
  const readingOrder = () => (host.readingOrder && host.readingOrder() === "ltr" ? "ltr" : "rtl");
  // The visible texts of a page in reading order: rows from the top, each read from the right
  // for manga (TypeR's reading order), from the left otherwise. SFX are left out.
  const textsOf = (doc) => {
    const byId = new Map(layersOf(doc).map((layer) => [layer.id, layer]));
    const items = layersOf(doc)
      .filter((layer) => layer.kind === "text" && textOf(layer).trim() && shownLayer(layer, byId) && !inSfx(layer, byId))
      .map((layer) => ({ layer, box: boxOf(layer, doc) || { left: 0, top: 0, right: 0, bottom: 0 } }))
      .sort((a, b) => a.box.top - b.box.top);
    const rtl = readingOrder() === "rtl";
    const rows = [];
    items.forEach((item) => {
      const row = rows[rows.length - 1];
      const middle = (item.box.top + item.box.bottom) / 2;
      if (row && middle < row.bottom) row.items.push(item);
      else rows.push({ bottom: item.box.bottom, items: [item] });
      if (row && middle < row.bottom) row.bottom = Math.max(row.bottom, Math.min(item.box.bottom, row.bottom + (item.box.bottom - item.box.top) / 2));
    });
    return rows.flatMap((row) => row.items.sort((a, b) => (rtl ? b.box.right - a.box.right : a.box.left - b.box.left))).map((item) => item.layer);
  };
  // A page's text language: the one most of its texts are in
  const languageOf = (docs) => {
    const count = new Map();
    docs.forEach((doc) => textsOf(doc).forEach((layer) => {
      const tag = PS.languageTagOf(layer.params.layerText.textStyleRange[0] ? layer.params.layerText.textStyleRange[0].textStyle : null);
      count.set(tag, (count.get(tag) || 0) + 1);
    }));
    let best = PS.languageTagOf(null);
    let most = 0;
    count.forEach((n, tag) => {
      if (n > most) [best, most] = [tag, n];
    });
    return best;
  };

  /* --------------------------------- the checks --------------------------------- */

  // Each page's last check: { issues, layers (the page's layers it saw), at }. Proofreading's
  // findings, by page: [{ key, layerId, kind, excerpt, suggestion, replacement, explanation, text }]
  const results = new WeakMap();
  const findings = new WeakMap();
  // A check under way: { controller, docs, at }
  let running = null;
  let failure = "";
  let refreshTimer = 0;

  /* --------------------------- the chapter's closed pages --------------------------- */

  // All pages are every page imported (Open Pages…, a folder), not only those in a tab. A page no
  // tab shows stands in the list as itself: read without a tab for its check, its pixels let go
  // at once, only what the list needs kept (its layers' names, its texts and where they were).
  // A click on it opens it through the pager, and its rows follow it there.
  //
  //   stand-in   { closed: true, ref (the chapter's page), id, name, path, width, height,
  //              resolution, state: { layers, activeIds } }: layers as read, light
  //   layer ids  each read of a file gives its layers new ids: the ignored issues and the
  //              proofreading's suggestions of a page are carried from one read to the next,
  //              layer by layer in their order, when the layers are the same
  const standIns = new WeakMap();
  let closedCount = 0;
  const chapterPages = () => {
    try {
      return host.chapterPages ? host.chapterPages() : [];
    } catch (error) {
      return [];
    }
  };
  const standInOf = (entry) => {
    let one = standIns.get(entry.ref);
    if (!one || one.path !== entry.key) {
      one = { closed: true, ref: entry.ref, id: `closed:${++closedCount}`, name: entry.name, path: entry.key, width: 0, height: 0, resolution: 72, state: { layers: [], activeIds: [] } };
      standIns.set(entry.ref, one);
    }
    return one;
  };
  const lightLayer = (layer, doc) => {
    const out = { id: layer.id, kind: layer.kind, name: layer.name, visible: layer.visible, group: layer.group || null, sfx: Boolean(layer.sfx) };
    if (layer.kind === "text") {
      out.params = layer.params;
      out.box = boxOf(layer, doc);
    }
    return out;
  };
  // The same layers, in the same order, read twice: the ids of one read to the other's
  const idPairs = (from, to) => {
    if (!from || !to || !from.length || from.length !== to.length) return null;
    if (from.some((layer, at) => layer.kind !== to[at].kind || layer.name !== to[at].name)) return null;
    return new Map(from.map((layer, at) => [layer.id, to[at].id]));
  };
  // What each page's layers were the last time they were seen: { ownerId, owner (a WeakRef: a
  // page closed since isn't kept for this), layers: [{ id, kind, name }] }
  const known = new Map();
  const carry = (doc) => {
    const key = pageKey(doc);
    const layers = layersOf(doc);
    const was = known.get(key);
    // A closed page read again is another read: its layers have new ids
    const ownerId = doc.closed ? `${doc.id}#${doc.reads || 0}` : doc.id;
    known.set(key, { ownerId, owner: typeof WeakRef === "function" ? new WeakRef(doc) : null, layers: layers.map(({ id, kind, name }) => ({ id, kind, name })) });
    if (!was || was.ownerId === ownerId) return;
    const pairs = idPairs(was.layers, layers);
    if (!pairs) return;
    const ids = Array.isArray(store.ignored[key]) ? store.ignored[key] : [];
    if (ids.length) {
      store.ignored[key] = ids.map((id) => {
        const parts = String(id).split(":");
        if (parts.length > 1 && pairs.has(Number(parts[1]))) parts[1] = String(pairs.get(Number(parts[1])));
        return parts.join(":");
      });
      keep();
    }
    const before = was.owner && was.owner.deref();
    const list = before ? findings.get(before) : null;
    if (!list || !list.length) return;
    findings.delete(before);
    const moved = list.filter((one) => pairs.has(one.layerId)).map((one) => {
      const id = pairs.get(one.layerId);
      return Object.assign(one, { key: String(one.key).replace(/^[^:]*/, String(id)), layerId: id });
    });
    findings.set(doc, (findings.get(doc) || []).concat(moved));
  };
  // A closed page now in a tab: the tab's page takes its place in the list
  const adopt = (ref, doc) => {
    if (!standIns.has(ref)) return;
    standIns.delete(ref);
    carry(doc);
  };
  const adoptOpenPages = () => chapterPages().forEach((entry) => { if (entry.doc) adopt(entry.ref, entry.doc); });
  // Every page: the chapter's in their order, open or not, then the other open pages
  const allPages = () => {
    const inChapter = new Set();
    const out = chapterPages().map((entry) => {
      if (!entry.doc) return standInOf(entry);
      adopt(entry.ref, entry.doc);
      inChapter.add(entry.doc);
      return entry.doc;
    });
    return out.concat(app.docs.filter((doc) => !inChapter.has(doc)));
  };
  // A closed page brought to the front, through the pager: { doc, issue (one of its rows, with
  // the ids of this read) }, or null
  let opening = 0;
  const openClosed = async (one) => {
    let doc = null;
    opening++;
    try {
      doc = await host.openPage(one.ref);
      if (doc) await A.actions.nextPaint();
    } catch (error) {
      console.warn("TypeR web: a page of the chapter couldn't be opened", error);
    } finally {
      opening--;
    }
    if (!doc || !app.docs.includes(doc)) return null;
    const pairs = idPairs(one.state.layers, layersOf(doc));
    adopt(one.ref, doc);
    const move = (id) => (pairs && pairs.has(id) ? pairs.get(id) : id);
    const issue = (old) => {
      const parts = String(old.id).split(":");
      if (parts.length > 1 && /^\d+$/.test(parts[1])) parts[1] = String(move(Number(parts[1])));
      return Object.assign({}, old, { id: parts.join(":"), layerId: old.layerId === null || old.layerId === undefined ? old.layerId : move(old.layerId), layerIds: Array.isArray(old.layerIds) ? old.layerIds.map(move) : undefined });
    };
    return { doc, issue };
  };

  const shownDocs = () => (store.scope === "all" ? allPages() : app.doc ? [app.doc] : []);
  const fresh = (doc) => {
    const result = results.get(doc);
    return Boolean(result && result.layers === doc.state.layers && result.config === config);
  };

  // One page's check. A closed page is read for it, and let go once its issues are known.
  const checkPage = async (doc, signal) => {
    if (!doc.closed) {
      const layers = doc.state.layers;
      const issues = await Rules.check(doc, { rules: config, script: scriptOf(doc), signal });
      if (signal && signal.aborted) return;
      results.set(doc, { issues: Array.isArray(issues) ? issues : [], layers, config, at: Date.now() });
      carry(doc);
      return;
    }
    let page = null;
    try {
      page = await host.readPage(doc.ref);
      if (signal && signal.aborted) return;
      const issues = await Rules.check(page, { rules: config, script: scriptOf(page), signal });
      if (signal && signal.aborted) return;
      const layers = layersOf(page).map((layer) => lightLayer(layer, page));
      Object.assign(doc, { width: page.width, height: page.height, resolution: page.resolution, reads: (doc.reads || 0) + 1 });
      doc.state = { layers, activeIds: [] };
      results.set(doc, { issues: Array.isArray(issues) ? issues : [], layers, config, at: Date.now() });
      carry(doc);
    } finally {
      if (page) ops.dropDetached(page);
    }
  };
  // A page checked if it isn't, for a fix on it: its issue as this check sees it, or null
  const issueNow = async (doc, wanted) => {
    if (!fresh(doc)) {
      try {
        await checkPage(doc);
      } catch (error) {
        console.warn("TypeR web: the page couldn't be checked", error);
      }
    }
    const list = results.get(doc) ? results.get(doc).issues : [];
    return list.find((issue) => issue.id === wanted.id) || list.find((issue) => issue.rule === wanted.rule && issue.layerId === wanted.layerId) || null;
  };

  const checkDocs = async (docs) => {
    if (running) running.controller.abort();
    const controller = new AbortController();
    const run = { controller, docs, at: 0 };
    running = run;
    failure = "";
    render();
    try {
      for (const doc of docs) {
        if (controller.signal.aborted) return;
        if (doc.closed ? standIns.get(doc.ref) !== doc : !app.docs.includes(doc)) continue;
        run.at = docs.indexOf(doc) + 1;
        if (docs.length > 1) renderSummary();
        try {
          await checkPage(doc, controller.signal);
        } catch (error) {
          // A closed page that can't be read: said, and the others checked all the same
          if (!doc.closed || controller.signal.aborted || (error && error.name === "AbortError")) throw error;
          console.warn("TypeR web: a page of the chapter couldn't be read", error);
          results.set(doc, { issues: [], layers: doc.state.layers, config, at: Date.now() });
          failure = fill(T("{name} can't be read: {error}"), { name: doc.name, error: (error && error.message) || error });
        }
        if (controller.signal.aborted) return;
        // A long chapter: each page in the list as soon as it's done
        if (docs.length > 1) render();
      }
    } catch (error) {
      if (controller.signal.aborted || (error && error.name === "AbortError")) return;
      console.error("TypeR web: the verification failed", error);
      failure = T("The check couldn't finish on this page.");
    } finally {
      if (running === run) {
        running = null;
        render();
      }
    }
  };
  const scriptOf = (doc) => {
    try {
      return host.scriptOf(doc);
    } catch (error) {
      console.warn("TypeR web: the script couldn't be read for the verification", error);
      return null;
    }
  };
  // Check now: the pages shown, all of them
  const checkNow = () => checkDocs(shownDocs());
  // The list kept true: the pages shown that changed since their check, a moment after the last
  // change, never while a text is being typed
  const refresh = (soon) => {
    clearTimeout(refreshTimer);
    if (!isOpen()) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = 0;
      if (!isOpen()) return;
      if (A.isEditing()) {
        refresh();
        return;
      }
      const stale = shownDocs().filter((doc) => !fresh(doc));
      if (stale.length) checkDocs(stale);
      else render();
    }, soon ? 60 : SETTLE);
  };

  // What a page shows: its issues still there, not ignored, of the rules still on, and the
  // proofreading's findings whose words are still in their text
  const findingsOf = (doc) => {
    const list = findings.get(doc);
    if (!list) return [];
    const alive = list.filter((one) => {
      const layer = layerIn(doc, one.layerId);
      return layer && (textOf(layer) === one.text || carryOver(one, textOf(layer)));
    });
    if (alive.length !== list.length) findings.set(doc, alive);
    return alive;
  };
  // A finding carried over a change of its text made somewhere else in it (another suggestion
  // accepted, its lines set, a word typed, an undo): its words and its correction where they
  // now are. False when the change touched them: the finding goes.
  function carryOver(one, now) {
    const before = modelOf(one.text).model;
    const after = modelOf(now).model;
    // The texts' characters but their spaces and breaks, and the one part where they changed:
    // [p, end) before, [p, b.length - s) after
    const solid = (text) => {
      const at = [];
      for (let i = 0; i < text.length; i++) if (!/\s/.test(text[i])) at.push(i);
      return at;
    };
    const a = solid(before);
    const b = solid(after);
    let p = 0;
    while (p < a.length && p < b.length && before[a[p]] === after[b[p]]) p++;
    let s = 0;
    while (s < a.length - p && s < b.length - p && before[a[a.length - 1 - s]] === after[b[b.length - 1 - s]]) s++;
    const end = a.length - s;
    const shift = b.length - a.length;
    // Its own part: the words its correction changes, and its excerpt around them
    const excerpt = String(one.excerpt || "");
    const found = [];
    if (excerpt) for (let i = before.indexOf(excerpt); i >= 0; i = before.indexOf(excerpt, i + 1)) found.push(i);
    let from = -1;
    let to = -1;
    let put = "";
    let core = null;
    if (one.replacement) {
      const change = changeOf(before, one.replacement);
      from = change.p;
      to = before.length - change.s;
      put = one.replacement.slice(change.p, one.replacement.length - change.s);
      core = change.core;
    }
    const holding = found.filter((i) => !core || (i <= core[0] && i + excerpt.length >= core[1]));
    if (holding.length !== 1 && from < 0) return false;
    const e0 = holding.length === 1 ? holding[0] : from;
    const e1 = holding.length === 1 ? holding[0] + excerpt.length : to;
    const solidBefore = (i) => {
      let k = 0;
      while (k < a.length && a[k] < i) k++;
      return k;
    };
    // Touched by the change: gone
    const k0 = solidBefore(from < 0 ? e0 : Math.min(e0, from));
    const k1 = solidBefore(from < 0 ? e1 : Math.max(e1, to));
    if (end > p || b.length - s > p) {
      const touched = k1 > k0 ? (end > p ? k0 < end && k1 > p : k0 < p && k1 > p) : end > p ? k0 > p && k0 < end : k0 === p;
      if (touched) return false;
    }
    // A place of the text where it now is: a start kept before the characters that follow it,
    // an end after those that come before it
    const at = (i, isEnd) => {
      const k = solidBefore(i);
      const nk = k < p || (isEnd && k === p) ? k : k + shift;
      if (!isEnd) return Math.max(nk > 0 ? b[nk - 1] + 1 : 0, (nk < b.length ? b[nk] : after.length) - ((k < a.length ? a[k] : before.length) - i));
      return Math.min(nk < b.length ? b[nk] : after.length, (nk > 0 ? b[nk - 1] + 1 : 0) + (i - (k > 0 ? a[k - 1] + 1 : 0)));
    };
    if (from >= 0) {
      const start = at(from, false);
      const replacement = after.slice(0, start) + put + after.slice(Math.max(start, at(to, true)));
      // Already corrected there
      if (replacement.replace(/\s+/g, " ").trim() === after.replace(/\s+/g, " ").trim()) return false;
      one.replacement = replacement;
    }
    // Its words as the model wrote them, unless they're now written otherwise (across a break)
    if (after.split(excerpt).length !== 2) {
      const n0 = at(e0, false);
      one.excerpt = after.slice(n0, Math.max(n0, at(e1, true))) || one.excerpt;
    }
    one.text = now;
    return true;
  }
  const proofIssue = (doc, one) => ({
    id: `proof:${one.key}`,
    rule: PROOF,
    category: PROOF,
    severity: PROOF_SEVERITY[one.kind] || "hint",
    layerId: one.layerId,
    message: { text: one.suggestion ? "{kind}: “{excerpt}” → “{suggestion}”" : "{kind}: “{excerpt}”", values: { kind: kindName(one.kind), excerpt: one.excerpt, suggestion: one.suggestion } },
    excerpt: one.explanation || "",
    rect: null,
    fix: one.replacement ? { label: "Apply" } : null,
    proof: one,
    doc,
  });
  const issuesOf = (doc) => {
    const result = results.get(doc);
    const ignored = ignoredOf(doc);
    const own = result ? result.issues.filter((issue) => ruleOn(issue.rule)) : [];
    return {
      shown: own.filter((issue) => !ignored.has(issue.id)).concat(findingsOf(doc).map((one) => proofIssue(doc, one))),
      ignored: own.filter((issue) => ignored.has(issue.id)),
      checked: Boolean(result),
    };
  };
  // The proofreading's suggestions first: what was just asked for
  const byCategory = (issues) => {
    const own = categories();
    const order = [PROOF].concat(own);
    const groups = new Map();
    issues.forEach((issue) => {
      const id = order.includes(issue.category) ? issue.category : own[own.length - 1] || PROOF;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(issue);
    });
    return order.filter((id) => groups.has(id)).map((id) => ({
      id,
      issues: groups.get(id).sort((a, b) => SEVERITY.indexOf(severityOf(a)) - SEVERITY.indexOf(severityOf(b)) || ((a.rect && a.rect.top) || 0) - ((b.rect && b.rect.top) || 0)),
    }));
  };

  /* --------------------------------- going there --------------------------------- */

  // The place on the page, for a moment: a ring drawn over the page, which follows the view
  const stage = $("stage");
  const mark = make("div", "verify-mark");
  mark.hidden = true;
  if (stage) stage.appendChild(mark);
  let marked = null;
  let markTimer = 0;
  const placeMark = () => {
    if (!marked || marked.doc !== app.doc) {
      mark.hidden = true;
      return;
    }
    const { rect } = marked;
    const [x0, y0] = A.toScreen(rect.left, rect.top);
    const [x1, y1] = A.toScreen(rect.right, rect.bottom);
    const pad = 6;
    Object.assign(mark.style, { left: `${Math.round(x0) - pad}px`, top: `${Math.round(y0) - pad}px`, width: `${Math.max(8, Math.round(x1 - x0)) + pad * 2}px`, height: `${Math.max(8, Math.round(y1 - y0)) + pad * 2}px` });
    mark.hidden = false;
  };
  const showMark = (doc, rect) => {
    clearTimeout(markTimer);
    marked = { doc, rect };
    mark.classList.remove("is-on");
    placeMark();
    // Started again: the ring pulses for each click
    void mark.offsetWidth;
    mark.classList.add("is-on");
    markTimer = setTimeout(() => {
      marked = null;
      mark.hidden = true;
      mark.classList.remove("is-on");
    }, 1800);
  };
  // The spot in view: where it is if it already shows, else in the middle; zoomed out if it
  // doesn't fit, in if it would be too small to see
  const bringIntoView = (doc, rect) => {
    if (!stage || app.doc !== doc) return;
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    if (!width || !height) return;
    const v = doc.view;
    const w = Math.max(1, rect.right - rect.left);
    const h = Math.max(1, rect.bottom - rect.top);
    let zoom = v.zoom;
    const fits = Math.min((width * 0.8) / w, (height * 0.8) / h);
    if (zoom > fits) zoom = fits;
    else if (Math.max(w * zoom, h * zoom) < 36) zoom = Math.min(fits, 1, 120 / Math.max(w, h));
    zoom = Math.max(0.02, Math.min(32, zoom));
    const margin = 24;
    const left = rect.left * zoom + v.x;
    const top = rect.top * zoom + v.y;
    const inside = zoom === v.zoom && left >= margin && top >= margin && left + w * zoom <= width - margin && top + h * zoom <= height - margin;
    if (inside) return;
    v.zoom = zoom;
    v.x = width / 2 - (rect.left + w / 2) * zoom;
    v.y = height / 2 - (rect.top + h / 2) * zoom;
    v.fitted = false;
    A.viewChanged();
  };
  const rectOf = (issue, doc) => {
    const r = issue.rect;
    if (r && [r.left, r.top, r.right, r.bottom].every(Number.isFinite)) return r;
    const ids = idsOf(issue).filter((id) => layerIn(doc, id));
    const boxes = ids.map((id) => boxOf(layerIn(doc, id), doc)).filter(Boolean);
    if (!boxes.length) return null;
    return { left: Math.min(...boxes.map((b) => b.left)), top: Math.min(...boxes.map((b) => b.top)), right: Math.max(...boxes.map((b) => b.right)), bottom: Math.max(...boxes.map((b) => b.bottom)) };
  };
  const idsOf = (issue) => (Array.isArray(issue.layerIds) && issue.layerIds.length ? issue.layerIds : issue.layerId !== null && issue.layerId !== undefined ? [issue.layerId] : []);
  // The page in front, its layer selected, the spot in view and marked
  const bringDoc = (doc) => {
    if (doc.closed) {
      openClosed(doc);
      return false;
    }
    if (!app.docs.includes(doc)) return false;
    if (app.doc !== doc) A.switchDoc(doc);
    return app.doc === doc;
  };
  const goTo = (doc, issue) => {
    if (doc.closed) {
      openClosed(doc).then((opened) => { if (opened) goTo(opened.doc, opened.issue(issue)); });
      return;
    }
    if (!bringDoc(doc)) return;
    const ids = idsOf(issue).filter((id) => layerIn(doc, id));
    const same = ids.length === doc.state.activeIds.length && ids.every((id) => doc.state.activeIds.includes(id));
    if (ids.length && !same) A.actions.selectLayers(ids);
    const rect = rectOf(issue, doc);
    if (!rect) return;
    bringIntoView(doc, rect);
    showMark(doc, rect);
  };

  /* --------------------------------- fixing --------------------------------- */

  const fixOne = (doc, issue) => {
    // On a closed page: the page opens, is checked, and its issue fixed there
    if (doc.closed && !issue.proof) {
      openClosed(doc).then(async (opened) => {
        if (!opened) return;
        const moved = opened.issue(issue);
        const found = await issueNow(opened.doc, moved);
        if (found && found.fix) fixOne(opened.doc, found);
        else {
          A.toast(T("This one can't be fixed in one click any more: have a look at it."));
          goTo(opened.doc, moved);
        }
      });
      return false;
    }
    if (issue.proof) return applyFinding(doc, issue.proof);
    if (!issue.fix || !bringDoc(doc)) return false;
    let done = false;
    try {
      done = Rules.fix(doc, issue) === true;
    } catch (error) {
      console.error("TypeR web: a fix failed", error);
    }
    if (!done) A.toast(T("This one can't be fixed in one click any more: have a look at it."));
    refresh(true);
    return done;
  };
  const fixAll = (doc, issues) => {
    if (doc.closed) {
      openClosed(doc).then(async (opened) => {
        if (!opened) return;
        const now = [];
        for (const issue of issues) {
          // The suggestions came along with the page
          const found = issue.proof ? proofIssue(opened.doc, issue.proof) : await issueNow(opened.doc, opened.issue(issue));
          if (found) now.push(found);
        }
        fixAll(opened.doc, now);
      });
      return;
    }
    const fixable = issues.filter((issue) => issue.fix);
    if (!fixable.length || !bringDoc(doc)) return;
    let count = 0;
    fixable.forEach((issue) => {
      try {
        if (issue.proof ? applyFinding(doc, issue.proof, true) : Rules.fix(doc, issue) === true) count++;
      } catch (error) {
        console.error("TypeR web: a fix failed", error);
      }
    });
    A.toast(count === fixable.length ? plural(count, "1 fixed.", "{count} fixed.") : fill(T("{fixed} of {total} fixed: the others need a look."), { fixed: count, total: fixable.length }));
    refresh(true);
  };
  const ignore = (doc, issue, back) => {
    const ids = ignoredOf(doc);
    if (back) ids.delete(issue.id);
    else ids.add(issue.id);
    setIgnored(doc, ids);
    render();
  };
  const stopRule = (issue) => {
    const rule = ruleOf(issue.rule);
    if (!rule) return;
    store.rules[rule.id] = Object.assign({}, config[rule.id], { on: false });
    config = rulesConfig();
    keep();
    A.toast(fill(T("“{rule}” is no longer checked. It can be turned back on in the verification settings."), { rule: T(rule.title) }), true);
    render();
  };

  /* ---------------------------------- the panel ---------------------------------- */

  const pane = $("pane-verify");
  const body = $("verify");
  const foot = $("verify-foot");
  if (!pane || !body || !foot) return;
  $("head-verify").textContent = T("Verification");

  // Open: shown in the workspace, or the sheet in front in the touch interface
  const isOpen = () => !pane.hidden && pane.getClientRects().length > 0 && (!Shell.touch || pane.classList.contains("is-sheet"));
  let wasOpen = false;
  const opened = () => {
    const now = isOpen();
    if (now === wasOpen) return;
    wasOpen = now;
    if (!now) {
      clearTimeout(refreshTimer);
      if (running) running.controller.abort();
      running = null;
      return;
    }
    // Opened: the pages shown checked at once
    const stale = shownDocs().filter((doc) => !fresh(doc));
    if (stale.length) checkDocs(stale);
    else render();
  };
  new MutationObserver(opened).observe(pane, { attributes: true, attributeFilter: ["hidden", "class", "style"] });

  // The top: Check, the scope, the settings
  const bar = make("div", "verify__bar", body);
  const checkButton = button("btn btn--main btn--small verify__check", "", bar, () => checkNow());
  const scope = make("div", "verify__scope", bar);
  scope.setAttribute("role", "group");
  scope.setAttribute("aria-label", T("What to check"));
  const scopeButtons = [["page", "This page"], ["all", "All open pages"]].map(([value, label]) => {
    const one = button("", T(label), scope, () => {
      if (store.scope === value) return;
      store.scope = value;
      keep();
      const stale = shownDocs().filter((doc) => !fresh(doc));
      if (stale.length) checkDocs(stale);
      else render();
    });
    one.dataset.scope = value;
    return one;
  });
  const settingsButton = button("icon-btn verify__settings", "", bar, () => openSettings());
  settingsButton.innerHTML = ICONS.settings;
  settingsButton.title = T("Verification settings");
  settingsButton.setAttribute("aria-label", settingsButton.title);

  const summary = make("div", "verify__summary", body);
  summary.setAttribute("role", "status");
  const list = make("div", "verify__list", body);
  list.setAttribute("role", "list");
  list.setAttribute("aria-label", T("Verification"));
  // Proofreading: under way, what it cost, what went wrong
  const aiStatus = make("div", "verify__ai", body);
  aiStatus.hidden = true;

  // The foot: Proofread with AI, its settings
  const proofButton = button("btn btn--small verify__proof", "", foot, () => proofread());
  proofButton.innerHTML = ICONS.sparkles;
  make("span", "", proofButton, T("Proofread with AI"));
  const aiKey = button("icon-btn verify__aikey", "", foot, () => openAISettings());
  aiKey.innerHTML = ICONS.key;
  aiKey.title = T("AI proofreading settings");
  aiKey.setAttribute("aria-label", aiKey.title);
  if (!AI) foot.hidden = true;

  // Opened groups: a page or a category folded by the user stays folded
  const folded = new Set();
  let showIgnored = false;
  // The row under the keyboard, found again after the list is drawn again
  let focusKey = "";

  const severityCounts = (issues) => {
    const counts = { error: 0, warning: 0, hint: 0 };
    issues.forEach((issue) => { counts[severityOf(issue)]++; });
    return counts;
  };
  const countsText = (counts) => [
    counts.error ? plural(counts.error, "1 error", "{count} errors") : "",
    counts.warning ? plural(counts.warning, "1 warning", "{count} warnings") : "",
    counts.hint ? plural(counts.hint, "1 hint", "{count} hints") : "",
  ].filter(Boolean).join(" · ");

  const renderSummary = () => {
    const docs = shownDocs();
    checkButton.textContent = T(store.scope === "all" ? "Check all pages" : "Check this page");
    checkButton.disabled = !docs.length;
    scopeButtons.forEach((one) => {
      const on = one.dataset.scope === store.scope;
      one.classList.toggle("is-on", on);
      one.setAttribute("aria-pressed", String(on));
    });
    const pages = store.scope === "all" ? docs.length : allPages().length;
    scopeButtons[1].textContent = pages > 1 ? fill(T("All pages ({count})"), { count: pages }) : T("All open pages");
    // Cut short in a narrow dock: the whole name under the pointer
    scopeButtons.forEach((one) => { one.title = one.textContent; });
    summary.textContent = "";
    summary.className = "verify__summary";
    if (!docs.length) {
      summary.classList.add("is-idle");
      make("span", "", summary, T("Open a page to check it."));
      return;
    }
    if (running) {
      summary.classList.add("is-busy");
      make("span", "verify__spinner", summary);
      make("span", "", summary, running.docs.length > 1 ? fill(T("Checking page {current}/{total}…"), { current: Math.max(1, running.at), total: running.docs.length }) : T("Checking…"));
      return;
    }
    if (failure) {
      summary.classList.add("is-error");
      make("span", "", summary, failure);
      return;
    }
    const all = docs.map(issuesOf);
    if (!all.some((one) => one.checked)) {
      summary.classList.add("is-idle");
      make("span", "", summary, T("Lists every typesetting mistake before you export: texts off the page, outside their bubble, missing, cut…"));
      return;
    }
    const shown = all.flatMap((one) => one.shown);
    const icon = make("span", "verify__sicon", summary);
    if (!shown.length) {
      summary.classList.add("is-clean");
      icon.innerHTML = ICONS.clean;
      const text = make("span", "verify__stext", summary);
      make("strong", "", text, T("Nothing to report"));
      make("span", "verify__sub", text, store.scope === "all" && docs.length > 1 ? fill(T("{count} pages checked."), { count: docs.length }) : T("This page is ready to export."));
      return;
    }
    const counts = severityCounts(shown);
    summary.classList.add(counts.error ? "is-error" : counts.warning ? "is-warning" : "is-hint");
    icon.innerHTML = ICONS[counts.error ? "error" : counts.warning ? "warning" : "hint"];
    const text = make("span", "verify__stext", summary);
    make("strong", "", text, plural(shown.length, "1 thing to look at", "{count} things to look at"));
    make("span", "verify__sub", text, countsText(counts));
  };

  const rowThings = new WeakMap();
  // A row: what is wrong, the text concerned, Fix and Ignore; a click goes there
  const rowOf = (doc, issue, parent, ignoredRow) => {
    const severity = severityOf(issue);
    const row = make("div", `verify__row is-${severity}${ignoredRow ? " is-ignored" : ""}${issue.proof ? " is-proof" : ""}`, parent);
    row.setAttribute("role", "listitem");
    row.tabIndex = -1;
    row.dataset.key = `${doc.id}:${issue.id}`;
    const icon = make("span", "verify__icon", row);
    icon.innerHTML = ICONS[severity];
    icon.title = T(SEVERITY_NAMES[severity]);
    const main = make("div", "verify__main", row);
    const message = make("div", "verify__message", main, say(issue.message));
    message.title = message.textContent;
    if (issue.excerpt) {
      const excerpt = make("div", "verify__excerpt", main, issue.proof ? issue.excerpt : fill(T("“{excerpt}”"), { excerpt: String(issue.excerpt).replace(/[\r\n]+/g, " ") }));
      excerpt.title = excerpt.textContent;
    }
    // A text changed by hand: the line of the script it comes closest to, to compare
    if (issue.data && issue.data.closest) {
      const closest = make("div", "verify__excerpt", main, fill(T("In the script: “{line}”"), { line: String(issue.data.closest).replace(/[\r\n]+/g, " ") }));
      closest.title = closest.textContent;
    }
    const tools = make("div", "verify__tools", main);
    if (ignoredRow) {
      button("verify__link", T("Show again"), tools, (event) => {
        event.stopPropagation();
        ignore(doc, issue, true);
      });
    } else {
      if (issue.fix) {
        const fix = button("btn btn--small verify__fix", T(issue.fix.label), tools, (event) => {
          event.stopPropagation();
          fixOne(doc, issue);
        });
        fix.title = T(issue.fix.label);
      }
      button("verify__link", T(issue.proof ? "Discard" : "Ignore"), tools, (event) => {
        event.stopPropagation();
        if (issue.proof) dismissFinding(doc, issue.proof);
        else ignore(doc, issue);
      });
    }
    const more = button("icon-btn verify__more", "", row, (event) => {
      event.stopPropagation();
      const box = more.getBoundingClientRect();
      rowMenu(doc, issue, ignoredRow, box.left, box.bottom + 2);
    });
    more.innerHTML = ICONS.more;
    more.title = T("More");
    more.setAttribute("aria-label", more.title);
    more.tabIndex = -1;
    // A suggestion of the proofreading: reviewed there, on the page
    row.addEventListener("click", () => {
      focusKey = row.dataset.key;
      list.querySelectorAll(".verify__row.is-on").forEach((one) => one.classList.remove("is-on"));
      row.classList.add("is-on");
      if (issue.proof && !ignoredRow) startReview(doc, issue.proof);
      else goTo(doc, issue);
    });
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      rowMenu(doc, issue, ignoredRow, event.clientX, event.clientY);
    });
    row.addEventListener("focus", () => { focusKey = row.dataset.key; });
    rowThings.set(row, { doc, issue, ignoredRow });
    return row;
  };
  const rowMenu = (doc, issue, ignoredRow, x, y) => {
    const rule = ruleOf(issue.rule);
    A.actions.openContextMenu(x, y, [
      issue.proof ? { label: "Review on the Page", action: () => startReview(doc, issue.proof) } : { label: "Go to It", action: () => goTo(doc, issue) },
      issue.fix && !ignoredRow ? { label: "Fix", title: () => T(issue.fix.label), action: () => fixOne(doc, issue) } : null,
      null,
      issue.proof ? { label: "Discard", action: () => dismissFinding(doc, issue.proof) } : ignoredRow ? { label: "Show Again", action: () => ignore(doc, issue, true) } : { label: "Ignore", action: () => ignore(doc, issue) },
      rule ? { label: "Don't Check This Again", action: () => stopRule(issue) } : null,
    ].filter((item, at, all) => item !== null || (at > 0 && all[at - 1] !== null)));
  };

  const groupHead = (parent, key, title, count, extra) => {
    const head = make("div", "verify__group", parent);
    const open = !folded.has(key);
    const twist = button(`verify__twist${open ? " is-open" : ""}`, "", head, () => {
      if (folded.has(key)) folded.delete(key);
      else folded.add(key);
      render();
    });
    twist.innerHTML = ICONS.twist;
    twist.setAttribute("aria-expanded", String(open));
    make("span", "verify__gname", twist, title);
    make("span", "verify__count", twist, String(count));
    if (extra) extra(head);
    return open;
  };

  const renderPage = (doc, parent, many) => {
    const { shown, ignored } = issuesOf(doc);
    let into = parent;
    if (many) {
      const key = `page:${doc.id}`;
      const section = make("div", "verify__page", parent);
      const head = make("div", "verify__pagehead", section);
      const open = !folded.has(key);
      const twist = button(`verify__twist${open ? " is-open" : ""}`, "", head, () => {
        if (folded.has(key)) folded.delete(key);
        else folded.add(key);
        render();
      });
      twist.innerHTML = ICONS.twist;
      twist.setAttribute("aria-expanded", String(open));
      make("span", "verify__gname", twist, doc.name);
      make("span", "verify__count", twist, String(shown.length));
      if (doc !== app.doc) {
        const go = button("verify__link", T("Show"), head, () => bringDoc(doc));
        go.title = fill(T("Bring “{name}” to the front"), { name: doc.name });
      }
      if (!open) return;
      into = section;
    }
    byCategory(shown).forEach(({ id, issues }) => {
      const key = `cat:${doc.id}:${id}`;
      const fixable = issues.filter((issue) => issue.fix);
      const open = groupHead(into, key, categoryName(id), issues.length, (head) => {
        if (id === PROOF) {
          button("verify__link", T("Clear"), head, () => {
            findings.delete(doc);
            render();
            syncReview();
          }).title = T("Clear the proofreading of this page");
        }
        if (fixable.length > 1) {
          const all = button("verify__link verify__fixall", fill(T(id === PROOF ? "Apply all ({count})" : "Fix all ({count})"), { count: fixable.length }), head, () => fixAll(doc, fixable));
          all.title = fill(T("{category}: fix the {count} that can be fixed in one click"), { category: categoryName(id), count: fixable.length });
        }
      });
      if (!open) return;
      issues.forEach((issue) => rowOf(doc, issue, into, false));
    });
    return ignored;
  };

  const render = () => {
    if (!isOpen()) return;
    const scroll = list.scrollTop;
    const hadFocus = list.contains(document.activeElement);
    renderSummary();
    list.textContent = "";
    const docs = shownDocs();
    const many = store.scope === "all" && docs.length > 1;
    const ignored = [];
    const clean = [];
    docs.forEach((doc) => {
      const { shown, checked } = issuesOf(doc);
      if (many && checked && !shown.length) {
        clean.push(doc);
        renderPage(doc, document.createElement("div"), false).forEach((issue) => ignored.push({ doc, issue }));
        return;
      }
      renderPage(doc, list, many).forEach((issue) => ignored.push({ doc, issue }));
    });
    if (many && clean.length) {
      const line = make("div", "verify__clean", list);
      line.innerHTML = ICONS.clean;
      make("span", "", line, fill(T("Nothing to report on: {pages}"), { pages: clean.map((doc) => doc.name).join(", ") }));
    }
    if (ignored.length) {
      const head = make("div", "verify__group verify__group--ignored", list);
      const twist = button(`verify__twist${showIgnored ? " is-open" : ""}`, "", head, () => {
        showIgnored = !showIgnored;
        render();
      });
      twist.innerHTML = ICONS.twist;
      twist.setAttribute("aria-expanded", String(showIgnored));
      make("span", "verify__gname", twist, T("Ignored"));
      make("span", "verify__count", twist, String(ignored.length));
      if (showIgnored) {
        button("verify__link", T("Show all again"), head, () => {
          docs.forEach((doc) => setIgnored(doc, new Set()));
          render();
        });
        ignored.forEach(({ doc, issue }) => rowOf(doc, issue, list, true));
      }
    }
    // The first row is the one Tab reaches; the arrows go through the others
    const rows = Array.from(list.querySelectorAll(".verify__row"));
    const again = rows.find((row) => row.dataset.key === focusKey);
    (again || rows[0] || { tabIndex: 0 }).tabIndex = 0;
    if (again) again.classList.add("is-on");
    if (hadFocus && again) again.focus({ preventScroll: true });
    list.scrollTop = scroll;
    renderAI();
  };

  // Keys: the arrows go through the rows, Enter goes there, Delete ignores, the menu key
  // (or Shift+F10) opens the row's menu
  list.addEventListener("keydown", (event) => {
    const row = event.target.closest && event.target.closest(".verify__row");
    if (!row || event.target !== row) return;
    const rows = Array.from(list.querySelectorAll(".verify__row"));
    const at = rows.indexOf(row);
    const thing = rowThings.get(row);
    const move = (to) => {
      const next = rows[Math.max(0, Math.min(rows.length - 1, to))];
      if (!next) return;
      rows.forEach((one) => { one.tabIndex = -1; });
      next.tabIndex = 0;
      next.focus();
      focusKey = next.dataset.key;
    };
    let handled = true;
    if (event.key === "ArrowDown") move(at + 1);
    else if (event.key === "ArrowUp") move(at - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(rows.length - 1);
    else if (event.key === "Enter" || event.key === " ") row.click();
    else if ((event.key === "Delete" || event.key === "Backspace") && thing && !thing.ignoredRow) {
      if (thing.issue.proof) dismissFinding(thing.doc, thing.issue.proof);
      else ignore(thing.doc, thing.issue);
    } else if ((event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) && thing) {
      const box = row.getBoundingClientRect();
      rowMenu(thing.doc, thing.issue, thing.ignoredRow, box.left + 24, box.bottom);
    } else handled = false;
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  });

  /* --------------------------------- the settings --------------------------------- */

  // Every rule with what it looks for, a switch each and its options, grouped as in the list
  const openSettings = async () => {
    const draft = rulesConfig();
    const box = make("div", "vset");
    make("p", "modal__hint vset__intro", box, T("What the verification looks for. The rules switched off aren't checked on any page."));
    const controls = [];
    const groups = make("div", "vset__groups", box);
    categories().forEach((category) => {
      const rules = RULES.filter((rule) => rule.category === category);
      if (!rules.length) return;
      make("p", "vset__heading", groups, categoryName(category));
      const card = make("div", "vset__card", groups);
      rules.forEach((rule) => {
        const row = make("div", "vset__rule", card);
        const top = make("label", "vset__top", row);
        const text = make("span", "vset__text", top);
        make("span", "vset__title", text, T(rule.title));
        if (rule.description) make("span", "vset__desc", text, T(rule.description));
        const on = make("input", "vset__switch", top);
        on.type = "checkbox";
        on.checked = draft[rule.id] ? draft[rule.id].on !== false : rule.on !== false;
        const options = make("div", "vset__options", row);
        const optionInputs = (rule.options || []).map((option) => {
          const field = make("label", "vset__option", options);
          make("span", "", field, T(option.label));
          let input;
          if (option.type === "choice") {
            input = make("select", "", field);
            (option.choices || []).forEach(([value, label]) => {
              const one = make("option", "", input, T(label));
              one.value = String(value);
            });
          } else {
            const unit = make("span", "vset__number", field);
            input = make("input", "", unit);
            input.type = "number";
            ["min", "max", "step"].forEach((key) => { if (option[key] !== undefined) input[key] = option[key]; });
            if (option.unit) make("span", "vset__unit", unit, T(option.unit));
          }
          const value = draft[rule.id] && option.key in draft[rule.id] ? draft[rule.id][option.key] : option.default;
          input.value = String(value);
          return { option, input };
        });
        const sync = () => {
          row.classList.toggle("is-off", !on.checked);
          optionInputs.forEach(({ input }) => { input.disabled = !on.checked; });
        };
        on.addEventListener("change", sync);
        sync();
        controls.push({ rule, on, optionInputs, sync });
      });
    });
    const reset = button("btn btn--small vset__reset", T("Back to the defaults"), box, () => {
      const base = Rules.defaults();
      controls.forEach(({ rule, on, optionInputs, sync }) => {
        on.checked = base[rule.id] ? base[rule.id].on !== false : true;
        optionInputs.forEach(({ option, input }) => { input.value = String(base[rule.id] && option.key in base[rule.id] ? base[rule.id][option.key] : option.default); });
        sync();
      });
    });
    reset.title = T("Every rule as it comes, on or off, with its usual values");
    const answer = await A.dialog({ title: T("Verification Settings"), body: box, ok: "OK" });
    if (!answer) return;
    const base = Rules.defaults();
    store.rules = {};
    controls.forEach(({ rule, on, optionInputs }) => {
      const mine = { on: on.checked };
      optionInputs.forEach(({ option, input }) => {
        if (option.type === "choice") {
          const found = (option.choices || []).find(([value]) => String(value) === input.value);
          mine[option.key] = found ? found[0] : option.default;
        } else {
          const n = Number(input.value);
          mine[option.key] = Number.isFinite(n) && input.value !== "" ? Math.max(option.min === undefined ? -Infinity : option.min, Math.min(option.max === undefined ? Infinity : option.max, n)) : option.default;
        }
      });
      // Only what differs from the defaults is kept: a new default then reaches everyone
      const differs = Object.keys(mine).filter((key) => !base[rule.id] || base[rule.id][key] !== mine[key]);
      if (differs.length) store.rules[rule.id] = mine;
    });
    keep();
    config = rulesConfig();
    refresh(true);
  };

  /* --------------------------------- proofreading --------------------------------- */

  let proofing = null;
  // What the last run said: { kind: "done" | "error" | "stopped", text, code, usage, model }
  let aiNote = null;

  const serviceName = (service) => (AI && AI.SERVICES[service] ? AI.SERVICES[service].name : service);
  const tokens = (n) => Number(n || 0).toLocaleString((window.TYPER_I18N && window.TYPER_I18N.lang) || undefined);

  const renderAI = () => {
    if (!AI) return;
    proofButton.disabled = Boolean(proofing) || !shownDocs().length;
    aiStatus.textContent = "";
    aiStatus.className = "verify__ai";
    aiStatus.hidden = !proofing && !aiNote;
    if (proofing) {
      aiStatus.classList.add("is-busy");
      const line = make("div", "verify__ailine", aiStatus);
      make("span", "verify__spinner", line);
      make("span", "verify__aitext", line, proofing.text || fill(T("Proofreading with {service}…"), { service: serviceName(proofing.service) }));
      button("btn btn--small", T("Stop"), line, () => proofing && proofing.controller.abort());
      const meter = make("div", "verify__meter", aiStatus);
      const fillBar = make("span", "", meter);
      if (proofing.fraction === null) meter.classList.add("is-unknown");
      else fillBar.style.width = `${Math.round(proofing.fraction * 100)}%`;
      return;
    }
    if (!aiNote) return;
    aiStatus.classList.add(`is-${aiNote.kind}`);
    const line = make("div", "verify__ailine", aiStatus);
    // Suggestions left to look at: the line itself and its button take you to them
    const left = suggestionCount();
    const said = make(left ? "button" : "span", `verify__aitext${left ? " is-link" : ""}`, line, aiNote.text);
    if (left) {
      said.type = "button";
      said.title = reviewTitle();
      said.addEventListener("click", () => startReview());
      const go = button("btn btn--small btn--main verify__review", T("Review"), line, () => startReview());
      go.title = said.title;
    }
    if (aiNote.kind === "error" && (aiNote.code === "key" || aiNote.code === "model" || aiNote.code === "quota")) button("btn btn--small", T("Open the settings"), line, () => openAISettings());
    else if (aiNote.kind === "error" && (aiNote.code === "network" || aiNote.code === "format")) button("btn btn--small", T("Try again"), line, () => proofread());
    const close = button("icon-btn verify__aiclose", "", line, () => {
      aiNote = null;
      renderAI();
    });
    close.innerHTML = ICONS.close;
    close.title = T("Dismiss");
    close.setAttribute("aria-label", close.title);
    if (aiNote.usage) make("div", "verify__aiusage", aiStatus, aiNote.usage);
  };
  // Edit > Review Proofreading's keys, given in the titles that lead there
  const reviewTitle = () => {
    const keys = host.reviewKeys ? host.reviewKeys() : "";
    return keys ? `${T("Review the suggestions one by one, on the page")} (${keys})` : T("Review the suggestions one by one, on the page");
  };

  // The service's models for the settings: live from the service with the user's key, or the
  // usual ones when it can't be asked
  const AI_KINDS = AI && Array.isArray(AI.KINDS) ? AI.KINDS : [];
  const openAISettings = async () => {
    if (!AI) return false;
    const now = AI.load();
    // The list is asked with the key kept: a key typed is kept for that, and given back on Cancel
    let triedKey = false;
    const keys = Object.assign({}, now.keys);
    const models = Object.assign({}, now.model);
    let service = AI.SERVICES[now.service] ? now.service : Object.keys(AI.SERVICES)[0];
    const box = make("div", "gensettings aiset");
    make("p", "modal__hint aiset__intro", box, T("AI proofreading sends the texts of the page to the service you choose, with your own API key. The service bills your account for it. The other checks never leave this device."));
    const field = (text, control, parent = box) => {
      const label = make("label", "", parent);
      make("span", "", label, text);
      label.appendChild(control);
      return label;
    };
    const serviceSelect = make("select", "");
    Object.keys(AI.SERVICES).forEach((name) => {
      const option = make("option", "", serviceSelect, AI.SERVICES[name].name);
      option.value = name;
    });
    serviceSelect.value = service;
    field(T("Service"), serviceSelect);
    // The key, as Generative Fill's: hidden, shown on demand, a link to get one
    const keyBox = make("span", "gensettings__key");
    const keyInput = make("input", "", keyBox);
    keyInput.type = "password";
    keyInput.autocomplete = "off";
    keyInput.spellcheck = false;
    keyInput.placeholder = T("Paste the key here");
    const eye = button("icon-btn", "", keyBox, () => {
      const hidden = keyInput.type === "password";
      keyInput.type = hidden ? "text" : "password";
      eye.classList.toggle("is-on", hidden);
      eye.setAttribute("aria-pressed", String(hidden));
    });
    eye.innerHTML = ICONS.eye;
    eye.title = T("Show the key");
    eye.setAttribute("aria-label", eye.title);
    eye.setAttribute("aria-pressed", "false");
    const link = make("a", "", keyBox, T("Get a key"));
    link.target = "_blank";
    link.rel = "noopener";
    const keyField = field(T("API key"), keyBox);
    const keyHint = make("p", "modal__hint", box);
    // The model: the list, Refresh, and any other id typed
    const modelBox = make("span", "aiset__model");
    const modelSelect = make("select", "", modelBox);
    const refreshButton = button("icon-btn", "", modelBox, () => loadModels(true));
    refreshButton.innerHTML = ICONS.redo;
    refreshButton.title = T("Load the list again");
    refreshButton.setAttribute("aria-label", refreshButton.title);
    field(T("Model"), modelBox);
    const modelState = make("p", "modal__hint aiset__state", box);
    const otherInput = make("input", "aiset__other");
    otherInput.type = "text";
    otherInput.spellcheck = false;
    otherInput.placeholder = T("Another model's id, if it isn't in the list");
    const otherField = field(T("Other model"), otherInput);
    // What to check, and the names to respect
    const kindsBox = make("span", "aiset__kinds");
    const kindInputs = {};
    AI_KINDS.forEach((kind) => {
      const label = make("label", "aiset__kind", kindsBox);
      const input = make("input", "", label);
      input.type = "checkbox";
      input.checked = !now.kinds || now.kinds[kind] !== false;
      make("span", "", label, kindName(kind));
      kindInputs[kind] = input;
    });
    const kindsRow = make("div", "aiset__row", box);
    make("span", "", kindsRow, T("Look for"));
    kindsRow.appendChild(kindsBox);
    const notes = make("textarea", "aiset__notes");
    notes.rows = 4;
    notes.spellcheck = false;
    notes.value = typeof now.notes === "string" ? now.notes : "";
    notes.placeholder = T("Names, places, attacks… written as the translation writes them, one per line. They're never flagged.");
    const notesRow = make("div", "aiset__row", box);
    make("span", "", notesRow, T("Names and terms to respect"));
    notesRow.appendChild(notes);

    let modelsTurn = 0;
    let modelsController = null;
    const modelValue = () => (otherInput.value.trim() || modelSelect.value);
    const showModels = (listed, chosen) => {
      modelSelect.textContent = "";
      const ids = listed.map((one) => one.id);
      if (chosen && !ids.includes(chosen)) listed = [{ id: chosen, name: chosen }].concat(listed);
      listed.forEach((one) => {
        const option = make("option", "", modelSelect, one.name && one.name !== one.id ? `${one.name} · ${one.id}` : one.id);
        option.value = one.id;
      });
      if (chosen) modelSelect.value = chosen;
    };
    const loadModels = async (force) => {
      const turn = ++modelsTurn;
      if (modelsController) modelsController.abort();
      modelsController = new AbortController();
      const name = serviceName(service);
      const hasKey = Boolean(keyInput.value.trim());
      modelState.className = "modal__hint aiset__state is-busy";
      modelState.textContent = hasKey ? fill(T("Asking {service} for its models…"), { service: name }) : "";
      refreshButton.disabled = true;
      // The key typed is the one asked with: kept first, as the list is read with the key kept
      if (hasKey && keyInput.value.trim() !== (AI.load().keys || {})[service]) {
        AI.save(draftConfig());
        triedKey = true;
      }
      try {
        const answer = await AI.models(service, { force: Boolean(force), signal: modelsController.signal });
        if (turn !== modelsTurn || !box.isConnected) return;
        const chosen = models[service] || (answer.list[0] && answer.list[0].id) || "";
        const other = chosen && !answer.list.some((one) => one.id === chosen);
        showModels(answer.list, other ? null : chosen);
        if (other) otherInput.value = chosen;
        if (!other && !otherInput.value) otherInput.value = "";
        const when = (at) => new Date(at || Date.now()).toLocaleString((window.TYPER_I18N && window.TYPER_I18N.lang) || undefined, { dateStyle: "short", timeStyle: "short" });
        if (answer.live && !answer.error) {
          modelState.className = "modal__hint aiset__state is-live";
          modelState.textContent = fill(T("The models your key can use, from {service} ({time})."), { service: name, time: when(answer.at) });
        } else if (answer.live) {
          modelState.className = "modal__hint aiset__state is-offline";
          modelState.textContent = `${fill(T("The list {service} gave on {time}: it couldn't be asked again."), { service: name, time: when(answer.at) })} ${errorText(answer.error)}`;
        } else {
          modelState.className = "modal__hint aiset__state is-offline";
          modelState.textContent = !hasKey || (answer.error && answer.error.reason === "nokey") ? T("The usual models. Enter your key to see the ones it can use.") : `${T("Offline list: the usual models.")} ${errorText(answer.error)}`;
        }
      } catch (error) {
        if (turn !== modelsTurn || (error && (error.name === "AbortError" || error.code === "aborted"))) return;
        modelState.className = "modal__hint aiset__state is-offline";
        modelState.textContent = `${T("Offline list: the usual models.")} ${errorText(error)}`;
      } finally {
        if (turn === modelsTurn) refreshButton.disabled = false;
      }
    };
    const showService = () => {
      const one = AI.SERVICES[service];
      keyInput.value = keys[service] || "";
      link.href = one.keyUrl;
      keyField.querySelector("span").textContent = fill(T("{service} API key"), { service: one.name });
      keyHint.textContent = fill(T("Kept on this device, and only ever sent to {service}."), { service: one.name });
      otherInput.value = "";
      showModels([], models[service] || "");
      loadModels(false);
    };
    serviceSelect.addEventListener("change", () => {
      keys[service] = keyInput.value.trim();
      models[service] = modelValue();
      service = serviceSelect.value;
      showService();
    });
    keyInput.addEventListener("change", () => {
      keys[service] = keyInput.value.trim();
      loadModels(true);
    });
    modelSelect.addEventListener("change", () => {
      otherInput.value = "";
      models[service] = modelSelect.value;
    });
    otherField.title = T("Any model the service offers, by its id");
    const draftConfig = () => {
      keys[service] = keyInput.value.trim();
      models[service] = modelValue();
      const kinds = {};
      AI_KINDS.forEach((kind) => { kinds[kind] = kindInputs[kind].checked; });
      return Object.assign({}, AI.load(), { service, keys: Object.assign({}, keys), model: Object.assign({}, models), kinds, notes: notes.value });
    };
    showService();
    const answer = await A.dialog({
      title: T("AI Proofreading"),
      body: box,
      ok: T("Save"),
      ready: () => setTimeout(() => {
        if (!keyInput.value) keyInput.focus();
      }, 0),
    });
    if (modelsController) modelsController.abort();
    modelsTurn++;
    if (!answer) {
      if (triedKey) AI.save(now);
      return false;
    }
    if (!AI.save(draftConfig())) A.toast(T("The key couldn't be kept on this device: it works until the page is closed."), true);
    renderAI();
    return true;
  };

  // Said once per service, before its first send: what goes where, and who pays
  const consented = async (service, docs) => {
    if (store.consent[service]) return true;
    const name = serviceName(service);
    const yes = await A.dialog({
      title: T("Proofread with AI"),
      body: fill(T(docs.length > 1 ? "The texts of the {count} open pages will be sent to {service}, with your key. {service} bills your account for it. Nothing else leaves this device." : "The texts of this page will be sent to {service}, with your key. {service} bills your account for it. Nothing else leaves this device."), { count: docs.length, service: name }),
      ok: T("Send"),
    });
    if (!yes) return false;
    store.consent[service] = true;
    keep();
    return true;
  };

  const proofread = async () => {
    if (!AI || proofing) return;
    if (!isOpen()) open();
    const docs = shownDocs();
    if (!docs.length) return;
    if (!AI.ready() && !(await openAISettings())) return;
    if (!AI.ready()) {
      aiNote = { kind: "error", code: "key", text: T("Enter an API key in the AI proofreading settings first.") };
      renderAI();
      return;
    }
    const settings = AI.load();
    if (!(await consented(settings.service, docs))) return;
    // The chapter's closed pages are read for their texts
    const unread = docs.filter((doc) => doc.closed && !fresh(doc));
    if (unread.length) await checkDocs(unread);
    // Each page by a name of its own; each text by its layer
    const names = new Map();
    const pages = docs.map((doc) => {
      let name = doc.name;
      for (let n = 2; Array.from(names.values()).includes(name); n++) name = `${doc.name} (${n})`;
      names.set(doc, name);
      return { doc, name, layers: textsOf(doc) };
    }).filter((page) => page.layers.length);
    if (!pages.length) {
      aiNote = { kind: "error", code: "", text: T(docs.length > 1 ? "There is no text to proofread on these pages." : "There is no text to proofread on this page.") };
      renderAI();
      return;
    }
    // Each text as the module reads it: its line breaks as "\n", which the model keeps
    const sent = pages.map((page) => ({ doc: page.doc, texts: new Map(page.layers.map((layer) => [String(layer.id), { layer, text: textOf(layer) }])) }));
    const controller = new AbortController();
    let found = 0;
    proofing = { controller, service: settings.service, fraction: null, text: "" };
    aiNote = null;
    renderAI();
    // What came back, kept as rows: also what was found before an error stopped the run
    const keepFindings = (list) => {
      let count = 0;
      (list || []).forEach((one) => {
        const page = sent[one.page];
        const entry = page && page.texts.get(String(one.id));
        if (!entry) return;
        const layer = layerIn(page.doc, entry.layer.id);
        if (!layer || textOf(layer) !== entry.text) return;
        const kept = findings.get(page.doc) || [];
        const key = `${layer.id}:${one.kind}:${one.excerpt}:${one.suggestion}`;
        if (kept.some((other) => other.key === key)) return;
        kept.push({ key, layerId: layer.id, kind: one.kind, excerpt: String(one.excerpt || ""), suggestion: String(one.suggestion || ""), replacement: typeof one.replacement === "string" ? one.replacement : "", explanation: String(one.explanation || ""), text: entry.text });
        findings.set(page.doc, kept);
        count++;
      });
      return count;
    };
    const usageText = (usage, model) => {
      const used = ((usage && usage.input) || 0) + ((usage && usage.output) || 0);
      return used ? fill(T("{tokens} tokens used ({input} in, {output} out) with {model}."), { tokens: tokens(used), input: tokens(usage.input), output: tokens(usage.output), model: model || "" }) : "";
    };
    try {
      const answer = await AI.run({
        pages: sent.map((page, at) => ({ name: pages[at].name, texts: Array.from(page.texts, ([id, entry]) => ({ id, text: forModel(entry.text) })) })),
        language: languageOf(pages.map((page) => page.doc)),
        interface: A.setup.lang,
        signal: controller.signal,
        onProgress: (progress) => {
          if (!proofing || proofing.controller !== controller) return;
          proofing.fraction = progress && progress.total ? Math.max(0, Math.min(1, progress.done / progress.total)) : null;
          proofing.text = progress && progress.total > 1 ? fill(T("Proofreading page {current}/{total}…"), { current: Math.min(progress.total, progress.done + 1), total: progress.total }) : "";
          renderAI();
        },
      });
      const count = keepFindings(answer.findings);
      found = count;
      // Pages the model declined or answered unreadably: said, with the first reason
      const skipped = (answer.skipped || []).reduce((all, one) => all + ((one && one.pages && one.pages.length) || 0), 0);
      const first = (answer.skipped || [])[0];
      aiNote = {
        kind: skipped ? "error" : "done",
        code: skipped && first && first.error ? first.error.code : "",
        text: [
          count ? plural(count, "Proofreading: 1 suggestion.", "Proofreading: {count} suggestions.") : T("Proofreading: nothing to correct."),
          skipped ? `${plural(skipped, "1 page wasn't proofread:", "{count} pages weren't proofread:")} ${errorText(first && first.error)}` : "",
        ].filter(Boolean).join(" "),
        usage: usageText(answer.usage, answer.model),
      };
    } catch (error) {
      const partial = error && error.partial;
      const count = partial ? keepFindings(partial.findings) : 0;
      found = count;
      const stopped = controller.signal.aborted || (error && (error.code === "aborted" || error.name === "AbortError"));
      if (!stopped && !(AI.ProofreadError && error instanceof AI.ProofreadError)) console.error("TypeR web: the proofreading failed", error);
      aiNote = {
        kind: stopped ? "stopped" : "error",
        code: stopped ? "" : (error && error.code) || "",
        text: [
          stopped ? T("Proofreading stopped.") : errorText(error),
          count ? plural(count, "1 suggestion found before that.", "{count} suggestions found before that.") : "",
        ].filter(Boolean).join(" "),
        usage: partial ? usageText(partial.usage, partial.model) : "",
      };
    } finally {
      proofing = null;
      render();
      renderAI();
    }
    // Never left wondering where they are: the first one on the page, its card beside it,
    // unless a text or a dialog is in the way (the status line's Review is there for later)
    if (found && !review && !busy() && !(document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName))) startReview();
  };
  // A ProofreadError in the user's words: its sentence is an English key, its values filled
  const errorText = (error) => {
    if (error && AI && AI.ProofreadError && error instanceof AI.ProofreadError) return fill(T(error.message), error.values || {});
    return T("The proofreading didn't go through.");
  };
  // Photoshop's line breaks ("\r") as the model reads and writes them, and back
  const forModel = (text) => text.replace(/\r\n?|\u0003/g, "\n");
  const fromModel = (text, like) => (/\r/.test(like) || !/\n/.test(like) ? text.replace(/\r?\n/g, "\r") : text);
  function applyFinding(doc, one, quiet) {
    if (doc.closed) {
      openClosed(doc).then((opened) => { if (opened) applyFinding(opened.doc, one, quiet); });
      return false;
    }
    if (!bringDoc(doc)) return false;
    findingsOf(doc);
    const layer = layerIn(doc, one.layerId);
    // The whole text with this fix alone, as the model wrote it back
    const next = layer && textOf(layer) === one.text && one.replacement ? fromModel(one.replacement, one.text) : null;
    if (next === null) {
      if (!quiet) A.toast(T("The text has changed since: this suggestion doesn't fit any more."));
      dismissFinding(doc, one);
      return false;
    }
    if (A.isEditing()) A.endEdit();
    ops.setText(layer.id, next);
    dismissFinding(doc, one);
    if (!quiet) refresh(true);
    return true;
  }
  function dismissFinding(doc, one) {
    findings.set(doc, (findings.get(doc) || []).filter((kept) => kept !== one));
    render();
    syncReview();
  }

  /* ------------------------------ reviewing the suggestions ------------------------------ */

  // The proofreading's suggestions one at a time, on the page itself: the text ringed, its faulty
  // words marked where they can be told for sure (else its lines, else nothing but the ring), and
  // a card beside the bubble with the correction, Accept, Edit, Discard, Previous and Next.
  // Accepted, the text is given its shape right there: its lines as before (put back by
  // themselves when the correction moved them), one less, one more, shown on the page under the
  // pointer. The correction and its shape are one undo step; undone, the suggestion comes back.
  //
  //   the keys   while the card shows, never while a text or a field is typed in, nor over a
  //              menu or a dialog: Enter accepts (then goes on; on a suggestion with no
  //              correction, goes on), Cmd+Enter edits the text with the words selected,
  //              Backspace or Delete discards (as in the list), ← and → go back and on, − and +
  //              give a line less or more, R the lines as before, Esc closes
  //   review     { doc, one (the finding), key (its place in the order), step: "finding" |
  //              "shape", editing: { counts } while it's typed by hand, done (the shape step):
  //              { one, layerId, before, after (the text before and after), counts (where its
  //              lines broke before, in letters), token (the history step it shares) } }
  let review = null;
  // The page it started on: the count goes from there
  let reviewFrom = null;
  let turns = 0;
  const KEYS = { accept: "Enter", edit: "Cmd+Enter", discard: "Backspace", previous: "ArrowLeft", next: "ArrowRight", close: "Escape", fewer: "-", more: "=", before: "R", undo: "Cmd+Z" };
  const keyText = (keys) => (A.actions.keyLabel ? A.actions.keyLabel(keys) : keys).replace(/Escape/, "Esc").replace(/Enter/, "↵").replace(/Backspace/, "⌫").replace(/^-$/, "−").replace(/^=$/, "+");
  const nonSpace = (text) => (String(text).match(/\S/g) || []).length;

  // A text as the model read it ("\n" for its breaks), and where each of its characters is in the
  // layer's own text
  const modelOf = (text) => {
    let model = "";
    const at = [];
    for (let i = 0; i < text.length; i++) {
      at.push(i);
      if (text[i] === "\r" && text[i + 1] === "\n") i++;
      model += text[i] === "\r" || text[i] === "\u0003" || text[i] === "\n" ? "\n" : text[i];
    }
    at.push(text.length);
    return { model, at };
  };
  // What a correction changes: the characters (`p` kept before, `s` after; `core`, the same
  // without the spaces at its ends), and the whole words that go and come
  const changeOf = (from, to) => {
    let p = 0;
    while (p < from.length && p < to.length && from[p] === to[p]) p++;
    let s = 0;
    while (s < from.length - p && s < to.length - p && from[from.length - 1 - s] === to[to.length - 1 - s]) s++;
    let start = p;
    while (start > 0 && !/\s/.test(from[start - 1])) start--;
    let end = from.length - s;
    while (end < from.length && !/\s/.test(from[end])) end++;
    const tail = from.length - end;
    let a = p;
    let b = from.length - s;
    while (a < b && /\s/.test(from[a])) a++;
    while (b > a && /\s/.test(from[b - 1])) b--;
    return { p, s, core: [a, b], start, gone: from.slice(start, end), come: to.slice(start, to.length - tail) };
  };
  // Where a finding's words are in its text, [from, to) in the layer's own text, or null when
  // that can't be told for sure: its excerpt found twice and no correction to say which
  const spotOf = (one, text) => {
    const { model, at } = modelOf(text);
    const excerpt = String(one.excerpt || "");
    const found = [];
    if (excerpt) for (let i = model.indexOf(excerpt); i >= 0; i = model.indexOf(excerpt, i + 1)) found.push(i);
    let range = null;
    if (one.replacement) {
      const change = changeOf(model, one.replacement);
      const holding = found.filter((i) => i <= change.core[0] && i + excerpt.length >= change.core[1]);
      if (holding.length === 1) range = [holding[0], holding[0] + excerpt.length];
      else if (change.gone.trim()) range = [change.start, change.start + change.gone.length];
    }
    if (!range && found.length === 1) range = [found[0], found[0] + excerpt.length];
    return range ? [at[range[0]], at[range[1]]] : null;
  };

  // The runs of part of a text, its own styles
  const runsOf = (layer, from, to, hyphen) => {
    const lt = layer.params.layerText;
    const text = String(lt.textKey || "");
    const ranges = lt.textStyleRange || [];
    const styleAt = (i) => {
      for (let k = 0; k < ranges.length; k++) if (i >= ranges[k].from && i < ranges[k].to) return ranges[k].textStyle;
      return ranges.length ? ranges[ranges.length - 1].textStyle : {};
    };
    const runs = [];
    for (let i = from; i < to; i++) {
      const style = styleAt(i);
      const last = runs[runs.length - 1];
      if (last && last.style === style) last.text += text[i];
      else runs.push({ text: text[i], style });
    }
    if (hyphen && runs.length) runs[runs.length - 1] = { text: `${runs[runs.length - 1].text}-`, style: runs[runs.length - 1].style };
    return runs;
  };
  // A text Studio lays out itself: each line's letters, where TypeR draws them
  const drawnMarks = (doc, layer, from, to) => {
    let lines;
    try {
      lines = PS.caretLines(layer, doc);
    } catch (error) {
      return null;
    }
    const text = textOf(layer);
    const boxes = [];
    let covered = 0;
    lines.forEach((line) => {
      const a = Math.max(from, line.start);
      const b = Math.min(to, line.end);
      if (b <= a) return;
      covered += nonSpace(text.slice(a, b));
      boxes.push({ left: line.xs[a - line.start], right: line.xs[b - line.start], top: line.top, bottom: line.bottom });
    });
    // Some of it in lines the box doesn't show: only the ring
    return boxes.length && covered >= nonSpace(text.slice(from, to)) ? boxes : null;
  };
  // A text that still shows Photoshop's pixels: the lines of its ink, with the words the
  // verification fitted to each. In a line whose ink is as wide as TypeR measures its words,
  // the words themselves; else the whole line. Null when the lines aren't known.
  const rasterMarks = (doc, layer, from, to) => {
    const shown = Rules.linesShown ? Rules.linesShown(doc, layer) : null;
    if (!shown || !shown.known || !Array.isArray(shown.lines)) return null;
    const text = textOf(layer);
    const placed = [];
    let at = 0;
    for (const line of shown.lines) {
      if (typeof line.text !== "string" || !line.rect) return null;
      const body = (line.hyphenated ? line.text.replace(/[-\u2010]$/, "") : line.text).trim();
      if (!body) continue;
      const start = text.indexOf(body, at);
      // Each line where the one before ended: else the words are somewhere else
      if (start < 0 || text.slice(at, start).trim()) return null;
      placed.push({ start, end: start + body.length, rect: line.rect, hyphenated: Boolean(line.hyphenated) });
      at = start + body.length;
    }
    const boxes = [];
    let covered = 0;
    placed.forEach((line) => {
      const a = Math.max(from, line.start);
      const b = Math.min(to, line.end);
      if (b <= a) return;
      covered += nonSpace(text.slice(a, b));
      const r = line.rect;
      let box = null;
      try {
        const whole = PS.measureRuns(runsOf(layer, line.start, line.end, line.hyphenated), doc.resolution);
        const ink = whole.inkRight - whole.inkLeft;
        const scale = ink > 0 ? (r.right - r.left) / ink : 0;
        if (scale > 0.94 && scale < 1.06) {
          const x0 = PS.measureRuns(runsOf(layer, line.start, a), doc.resolution).advance - whole.inkLeft;
          const x1 = PS.measureRuns(runsOf(layer, line.start, b), doc.resolution).advance - whole.inkLeft;
          box = { left: r.left + x0 * scale, right: r.left + x1 * scale, top: r.top, bottom: r.bottom };
        }
      } catch (error) {
        box = null;
      }
      boxes.push(box || { left: r.left, right: r.right, top: r.top, bottom: r.bottom, line: true });
    });
    return boxes.length && covered >= nonSpace(text.slice(from, to)) ? boxes : null;
  };
  // Where part of a text is on the page, a box per line, or null: only the whole text then
  const marksOf = (doc, layer, from, to) => {
    if (!layer || !(to > from)) return null;
    const lt = layer.params.layerText;
    const shape = lt.textShape && lt.textShape[0];
    if (layer.rotated || layer.spin || layer.warp || layer.mesh || (shape && shape.orientation === "vertical")) return null;
    return layer.raster ? rasterMarks(doc, layer, from, to) : drawnMarks(doc, layer, from, to);
  };

  // Where the lines of a text break, as the page shows it: the letters before each break
  // (spaces left out) and whether it cuts a word, or null when they aren't known
  const countsOf = (doc, layer) => {
    const shown = Rules.linesShown ? Rules.linesShown(doc, layer) : null;
    if (!shown || !shown.known || shown.overflow || !Array.isArray(shown.lines) || shown.lines.some((line) => typeof line.text !== "string")) return null;
    const out = [];
    let total = 0;
    shown.lines.forEach((line, i) => {
      total += nonSpace(line.hyphenated ? line.text.replace(/[-\u2010]$/, "") : line.text);
      if (i < shown.lines.length - 1) out.push({ count: total, cut: Boolean(line.hyphenated) });
    });
    return out;
  };
  // The breaks it had, carried over the correction, for the text as it is now: { model (its
  // lines as the Line Breaks panel sees them), breaks }, or null
  const linesBefore = (doc, layer, done) => {
    if (!done || !done.counts || !layer) return null;
    let model;
    try {
      model = PS.lineModel(layer, doc);
    } catch (error) {
      return null;
    }
    const change = changeOf(done.before, done.after);
    const kept = nonSpace(done.before.slice(0, change.p));
    const gone = nonSpace(done.before.slice(change.p, done.before.length - change.s));
    const come = nonSpace(done.after.slice(change.p, done.after.length - change.s));
    const chars = model.chars;
    const breaks = [];
    done.counts.forEach(({ count, cut }) => {
      const k = count <= kept ? count : count >= kept + gone ? count - gone + come : kept + come;
      let i = 0;
      for (let seen = 0; i < chars.length && seen < k; i++) if (!/\s/.test(chars[i].ch)) seen++;
      // A line that ended on a whole word still does: what the correction added to it stays
      if (!cut) while (i > 0 && i < chars.length && !/\s/.test(chars[i].ch) && !/[\s-]/.test(chars[i - 1].ch)) i++;
      while (i < chars.length && /\s/.test(chars[i].ch)) i++;
      if (i > 0 && i < chars.length && !breaks.includes(i)) breaks.push(i);
    });
    breaks.sort((a, b) => a - b);
    return { model, breaks };
  };
  const sameBreaks = (a, b) => a.length === b.length && a.every((at, i) => at === b[i]);

  // Every suggestion of the pages in order (the chapter's closed pages too): page by page from
  // the one the review started on, each in reading order
  const reviewItems = () => {
    const out = [];
    const pages = allPages();
    const first = Math.max(0, pages.indexOf(reviewFrom || app.doc));
    pages.forEach((doc, at) => {
      const page = (at - first + pages.length) % pages.length;
      const list = findingsOf(doc);
      if (!list.length) return;
      const order = new Map(textsOf(doc).map((layer, at) => [layer.id, at]));
      list.forEach((one) => {
        const layer = layerIn(doc, one.layerId);
        const spot = layer ? spotOf(one, textOf(layer)) : null;
        out.push({ doc, one, key: [page, order.has(one.layerId) ? order.get(one.layerId) : order.size, spot ? spot[0] : 0, String(one.excerpt)] });
      });
    });
    const compare = (a, b) => {
      for (let i = 0; i < a.length; i++) {
        if (a[i] < b[i]) return -1;
        if (a[i] > b[i]) return 1;
      }
      return 0;
    };
    out.sort((a, b) => compare(a.key, b.key));
    out.compare = compare;
    return out;
  };
  const suggestionCount = () => allPages().reduce((sum, doc) => sum + findingsOf(doc).length, 0);
  // The one after (or before) a place in the order, round to the start
  const itemFrom = (items, key, step) => {
    if (!items.length) return null;
    if (!key) return items[0];
    if (step > 0) return items.find((item) => items.compare(item.key, key) > 0) || items[0];
    for (let i = items.length - 1; i >= 0; i--) if (items.compare(items[i].key, key) < 0) return items[i];
    return items[items.length - 1];
  };

  // The card and the marks, over the page as the ring of a row is
  const card = make("div", "proof-card");
  card.hidden = true;
  card.setAttribute("role", "region");
  card.setAttribute("aria-label", T("Proofreading"));
  card.setAttribute("aria-live", "polite");
  const ring = make("div", "verify-mark proof-ring");
  ring.hidden = true;
  const words = make("div", "proof-words");
  if (stage) [ring, words, card].forEach((el) => stage.appendChild(el));
  // What happens on the card stays there: the page's tools never see it. Its buttons don't
  // take the focus: the keys stay the page's.
  ["pointerdown", "pointermove", "pointerup", "mousedown", "click", "dblclick", "contextmenu", "wheel", "touchstart"].forEach((type) => card.addEventListener(type, (event) => {
    event.stopPropagation();
    if (type === "pointerdown" && event.target.closest && event.target.closest("button")) event.preventDefault();
    if (type === "contextmenu") event.preventDefault();
  }, type === "wheel" || type === "touchstart" ? { passive: true } : false));

  const reviewLayer = () => (review ? layerIn(review.doc, review.step === "shape" ? review.done.layerId : review.one.layerId) : null);
  const busy = () => A.isEditing() || A.actions.modalOpen() || Boolean(document.querySelector("dialog[open], .menu.is-open, .menu__list--context, .search"));

  // A button of the card: its words, its keys beside them and in its title
  const cardButton = (className, label, keys, parent, run) => {
    const el = button(className, "", parent, () => run());
    el.tabIndex = -1;
    make("span", "", el, label);
    if (keys) {
      make("kbd", "", el, keyText(keys));
      el.title = `${label} (${keyText(keys)})`;
    } else el.title = label;
    return el;
  };
  // The text with the correction: what goes struck, what comes beside it
  const showText = (parent, text, change, mark, tag = "mark") => {
    const box = make("div", "proof-card__text", parent);
    if (change) {
      box.appendChild(document.createTextNode(text.slice(0, change.start)));
      if (change.gone) make("del", "", box, change.gone);
      if (change.gone && change.come) box.appendChild(document.createTextNode(" "));
      if (change.come) make("ins", "", box, change.come);
      box.appendChild(document.createTextNode(text.slice(change.start + change.gone.length)));
    } else if (mark) {
      box.appendChild(document.createTextNode(text.slice(0, mark[0])));
      make(tag, "", box, text.slice(mark[0], mark[1]));
      box.appendChild(document.createTextNode(text.slice(mark[1])));
    } else box.textContent = text;
    return box;
  };

  const renderCard = () => {
    card.textContent = "";
    if (!review) return;
    const { doc, step } = review;
    const items = reviewItems();
    const head = make("div", "proof-card__head", card);
    const layer = reviewLayer();
    if (step === "shape") {
      const done = review.done;
      make("span", "proof-card__kind is-done", head, T("Corrected"));
      make("span", "proof-card__count", head, items.length ? plural(items.length, "1 left", "{count} left") : "");
      const close = cardButton("icon-btn proof-card__close", "", KEYS.close, head, closeReview);
      close.innerHTML = ICONS.close;
      close.title = `${T("Close")} (${keyText(KEYS.close)})`;
      close.setAttribute("aria-label", T("Close"));
      // The corrected words as they now read, in the lines the text now has
      const now = modelOf(layer ? textOf(layer) : done.after);
      const at = layer ? doneSpot(layer) : null;
      showText(card, now.model, null, at ? [now.at.indexOf(at[0]), now.at.indexOf(at[1])] : null, "ins").classList.add("is-after");
      if (A.isEditing()) {
        make("p", "proof-card__hint", card, fill(T("Type the correction in the text. {keys}: done."), { keys: `${keyText(KEYS.edit)} · Esc` }));
        return;
      }
      // Its shape: as before, one line less, one line more
      const shapeRow = make("div", "proof-card__shape", card);
      make("span", "proof-card__label", shapeRow, T("Lines"));
      const lines = layer ? lineCount(layer) : 1;
      const most = window.TypeRBreaks && window.TypeRBreaks.maxLines ? window.TypeRBreaks.maxLines() : lines;
      const fewer = cardButton("btn btn--small proof-card__step", "−", null, shapeRow, () => shapeLines(-1));
      fewer.title = `${T("One line less")} (${keyText(KEYS.fewer)})`;
      fewer.setAttribute("aria-label", fewer.title);
      fewer.disabled = lines <= 1;
      make("span", "proof-card__lines", shapeRow, String(lines)).title = plural(lines, "1 line", "{count} lines");
      const more = cardButton("btn btn--small proof-card__step", "+", null, shapeRow, () => shapeLines(1));
      more.title = `${T("One line more")} (${keyText(KEYS.more)})`;
      more.setAttribute("aria-label", more.title);
      more.disabled = lines >= most;
      previewOn(fewer, () => window.TypeRBreaks && window.TypeRBreaks.setLines(lines - 1, { preview: true }));
      previewOn(more, () => window.TypeRBreaks && window.TypeRBreaks.setLines(lines + 1, { preview: true }));
      const plan = layer ? linesBefore(doc, layer, done) : null;
      if (plan) {
        const same = sameBreaks(plan.breaks, plan.model.breaks);
        const before = cardButton(`btn btn--small proof-card__before${same ? " is-on" : ""}`, T("As before"), KEYS.before, shapeRow, () => keepLines());
        before.title = `${T("The lines it had before the correction")} (${keyText(KEYS.before)})`;
        before.setAttribute("aria-pressed", String(same));
        if (!same) previewOn(before, () => ops.previewBreaks(layer.id, plan.model, plan.breaks));
      }
      const actions = make("div", "proof-card__actions", card);
      cardButton("btn btn--small", T("Undo"), KEYS.undo, actions, () => undoCorrection());
      cardButton("btn btn--small", T("Edit text"), KEYS.edit, actions, () => editText());
      make("span", "proof-card__gap", actions);
      cardButton("btn btn--small btn--main", T(items.length ? "Next" : "Done"), KEYS.accept, actions, () => goOn(1));
      return;
    }
    const one = review.one;
    const at = items.findIndex((item) => item.one === one);
    make("span", `proof-card__kind is-${PROOF_SEVERITY[one.kind] || "hint"}`, head, kindName(one.kind));
    make("span", "proof-card__count", head, fill(T("{current} of {total}"), { current: at + 1, total: items.length }));
    if (app.docs.length > 1 && items.some((item) => item.doc !== doc)) make("span", "proof-card__page", head, doc.name).title = doc.name;
    const close = cardButton("icon-btn proof-card__close", "", KEYS.close, head, closeReview);
    close.innerHTML = ICONS.close;
    close.title = `${T("Close")} (${keyText(KEYS.close)})`;
    close.setAttribute("aria-label", T("Close"));
    const text = layer ? textOf(layer) : one.text;
    const model = modelOf(text);
    if (one.replacement) showText(card, model.model, changeOf(model.model, one.replacement), null);
    else {
      const spot = spotOf(one, text);
      showText(card, model.model, null, spot ? [model.at.indexOf(spot[0]), model.at.indexOf(spot[1])] : null);
      if (one.suggestion) make("p", "proof-card__suggestion", card, fill(T("Suggestion: “{suggestion}”"), { suggestion: one.suggestion }));
    }
    if (one.explanation) make("p", "proof-card__why", card, one.explanation);
    if (!one.replacement) make("p", "proof-card__hint", card, T("No correction to apply: edit the text by hand."));
    if (A.isEditing()) {
      make("p", "proof-card__hint is-typing", card, fill(T("Type the correction in the text. {keys}: done."), { keys: `${keyText(KEYS.edit)} · Esc` }));
      return;
    }
    const actions = make("div", "proof-card__actions", card);
    if (one.replacement) cardButton("btn btn--small btn--main", T("Accept"), KEYS.accept, actions, () => accept());
    cardButton(`btn btn--small${one.replacement ? "" : " btn--main"}`, T("Edit text"), KEYS.edit, actions, () => editText());
    cardButton("btn btn--small", T("Discard"), KEYS.discard, actions, () => discard());
    const nav = make("div", "proof-card__nav", card);
    const previous = cardButton("verify__link", T("Previous"), KEYS.previous, nav, () => goOn(-1));
    const next = cardButton("verify__link", T("Next"), KEYS.next, nav, () => goOn(1));
    previous.disabled = next.disabled = items.length < 2;
  };
  // Under the pointer, a button shows on the page what it would do
  const previewOn = (el, show) => {
    el.addEventListener("mouseenter", () => { if (!el.disabled) show(); });
    el.addEventListener("mouseleave", () => ops.previewBreaks(null));
  };
  const lineCount = (layer) => {
    try {
      return PS.lineModel(layer, review.doc).breaks.length + 1;
    } catch (error) {
      return 1;
    }
  };
  // The corrected words in the text as it is now (its lines may have moved), or null
  const doneSpot = (layer) => {
    const done = review && review.done;
    if (!done) return null;
    const after = modelOf(done.after).model;
    const change = changeOf(modelOf(done.before).model, after);
    const come = change.come.trim();
    if (!come) return null;
    const { model: now, at: place } = modelOf(textOf(layer));
    const pattern = new RegExp(come.split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "g");
    const wanted = nonSpace(after.slice(0, change.start));
    let best = null;
    for (let found = pattern.exec(now); found; found = pattern.exec(now)) {
      const off = Math.abs(nonSpace(now.slice(0, found.index)) - wanted);
      if (!best || off < best.off) best = { off, at: [place[found.index], place[found.index + found[0].length]] };
      if (!found[0].length) pattern.lastIndex++;
    }
    return best ? best.at : null;
  };

  // The ring, the words and the card where the text is on the screen; hidden while its page
  // isn't in front
  const place = () => {
    const doc = review && review.doc;
    const layer = reviewLayer();
    const box = layer && app.doc === doc ? boxOf(layer, doc) : null;
    words.textContent = "";
    if (!box || !stage) {
      ring.hidden = true;
      card.hidden = true;
      return;
    }
    const toRect = (r) => {
      const [x0, y0] = A.toScreen(r.left, r.top);
      const [x1, y1] = A.toScreen(r.right, r.bottom);
      return { left: Math.min(x0, x1), top: Math.min(y0, y1), right: Math.max(x0, x1), bottom: Math.max(y0, y1) };
    };
    const r = toRect(box);
    const pad = 6;
    Object.assign(ring.style, { left: `${Math.round(r.left) - pad}px`, top: `${Math.round(r.top) - pad}px`, width: `${Math.max(8, Math.round(r.right - r.left)) + pad * 2}px`, height: `${Math.max(8, Math.round(r.bottom - r.top)) + pad * 2}px` });
    ring.hidden = false;
    ring.classList.toggle("is-done", review.step === "shape");
    // The words, from the layer as it is (kept while it doesn't change)
    if (!review.marks || review.marks.layer !== layer || review.marks.step !== review.step) {
      let boxes = null;
      if (review.step === "shape") {
        const at = doneSpot(layer);
        boxes = at && !layer.raster ? marksOf(doc, layer, at[0], at[1]) : null;
      } else {
        const spot = spotOf(review.one, textOf(layer));
        boxes = spot ? marksOf(doc, layer, spot[0], spot[1]) : null;
      }
      review.marks = { layer, step: review.step, boxes };
    }
    (review.marks.boxes || []).forEach((b) => {
      const s = toRect(b);
      const el = make("div", `proof-word${b.line ? " is-line" : ""}${review.step === "shape" ? " is-done" : ""}`, words);
      const grow = b.line ? 3 : 2;
      Object.assign(el.style, { left: `${Math.round(s.left) - grow}px`, top: `${Math.round(s.top) - grow}px`, width: `${Math.max(4, Math.round(s.right - s.left)) + grow * 2}px`, height: `${Math.max(4, Math.round(s.bottom - s.top)) + grow * 2}px` });
    });
    // The card beside the bubble, never over it: on the side with room for it
    card.hidden = false;
    const W = stage.clientWidth;
    const H = stage.clientHeight;
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    const b = toRect(bubbleOf(doc, layer, box));
    const gap = 12;
    const edge = 8;
    const midY = Math.max(edge, Math.min(H - ch - edge, (b.top + b.bottom) / 2 - ch / 2));
    const midX = Math.max(edge, Math.min(W - cw - edge, (b.left + b.right) / 2 - cw / 2));
    const sides = [
      { x: b.right + gap, y: midY, room: W - b.right },
      { x: b.left - gap - cw, y: midY, room: b.left },
      { x: midX, y: b.bottom + gap, room: H - b.bottom },
      { x: midX, y: b.top - gap - ch, room: b.top },
    ];
    const fits = (side) => side.x >= edge && side.y >= edge && side.x + cw <= W - edge && side.y + ch <= H - edge;
    const side = sides.find(fits) || sides.reduce((best, one) => (one.room > best.room ? one : best), sides[0]);
    card.style.left = `${Math.round(Math.max(edge, Math.min(W - cw - edge, side.x)))}px`;
    card.style.top = `${Math.round(Math.max(edge, Math.min(H - ch - edge, side.y)))}px`;
  };
  // A text's size in page pixels
  const sizeOf = (doc, layer) => {
    const style = layer.params.layerText.textStyleRange[0] ? layer.params.layerText.textStyleRange[0].textStyle : {};
    return Math.max(1, ((style.impliedFontSize || style.size || 14) * (doc.resolution || 72)) / 72);
  };
  // What the card stays off: the bubble around the text, as the checks find it (read once per
  // suggestion), else the text and a letter's height around it
  const bubbleOf = (doc, layer, box) => {
    const around = Math.max(12, sizeOf(doc, layer) * 0.9);
    const near = { left: box.left - around, top: box.top - around, right: box.right + around, bottom: box.bottom + around };
    if (!review.bubble || review.bubble.doc !== doc || review.bubble.id !== layer.id) review.bubble = { doc, id: layer.id, rect: Rules.bubbleShown ? Rules.bubbleShown(doc, layer) : null };
    const found = review.bubble.rect;
    if (!found) return near;
    return { left: Math.min(found.left, box.left), top: Math.min(found.top, box.top), right: Math.max(found.right, box.right), bottom: Math.max(found.bottom, box.bottom) };
  };
  // The text and its card in view: where they are if they already show, else side by side in
  // the middle (one above the other on a narrow screen), zoomed out if they don't fit, in if
  // the text would be too small to read
  const frameReview = () => {
    const doc = review && review.doc;
    const layer = reviewLayer();
    const box = layer && app.doc === doc ? boxOf(layer, doc) : null;
    if (!box || !stage) return;
    const W = stage.clientWidth;
    const H = stage.clientHeight;
    if (!W || !H) return;
    const rect = bubbleOf(doc, layer, box);
    const cw = card.offsetWidth || 300;
    const ch = card.offsetHeight || 180;
    const margin = 16;
    const gap = 12;
    const v = doc.view;
    const w = Math.max(1, rect.right - rect.left);
    const h = Math.max(1, rect.bottom - rect.top);
    const left = rect.left * v.zoom + v.x;
    const top = rect.top * v.zoom + v.y;
    const right = left + w * v.zoom;
    const bottom = top + h * v.zoom;
    const inside = left >= margin && top >= margin && right <= W - margin && bottom <= H - margin;
    const roomBeside = W - right >= cw + gap + margin || left >= cw + gap + margin || H - bottom >= ch + gap + margin || top >= ch + gap + margin;
    // Its letters big enough to read on the screen
    const size = sizeOf(doc, layer);
    const readable = size * v.zoom >= 15;
    if (inside && roomBeside && readable) return;
    const beside = Math.min((W - cw - gap - margin * 2) / w, (H - margin * 2) / h);
    const above = Math.min((W - margin * 2) / w, (H - ch - gap - margin * 2) / h);
    const sideBySide = beside >= above;
    const most = Math.max(0.02, sideBySide ? beside : above);
    const zoom = Math.max(0.02, Math.min(32, most, readable ? v.zoom : Math.max(v.zoom, 20 / size)));
    if (sideBySide) {
      const total = w * zoom + gap + cw;
      v.x = Math.max(margin, (W - total) / 2) - rect.left * zoom;
      v.y = H / 2 - (rect.top + h / 2) * zoom;
    } else {
      const total = h * zoom + gap + ch;
      v.y = Math.max(margin, (H - total) / 2) - rect.top * zoom;
      v.x = W / 2 - (rect.left + w / 2) * zoom;
    }
    v.zoom = zoom;
    v.fitted = false;
    A.viewChanged();
  };
  const showReview = () => {
    renderCard();
    place();
  };

  // A suggestion on the card: its page in front, its layer selected, in view
  const showItem = (item) => {
    if (app.doc) ops.previewBreaks(null);
    if (review && review.step === "shape" && app.doc === review.doc) ops.sealHistory();
    // On a closed page: the page opens, its suggestions come with it
    if (item && item.doc.closed) {
      const { one } = item;
      openClosed(item.doc).then((opened) => {
        const again = opened ? reviewItems().find((each) => each.one === one) : null;
        if (again && !again.doc.closed) showItem(again);
        else closeReview();
      });
      return;
    }
    if (!item || !bringDoc(item.doc)) {
      closeReview();
      return;
    }
    review = { doc: item.doc, one: item.one, key: item.key, step: "finding" };
    const id = item.one.layerId;
    if (layerIn(item.doc, id) && !(item.doc.state.activeIds.length === 1 && item.doc.state.activeIds[0] === id)) A.actions.selectLayers([id]);
    focusKey = `${item.doc.id}:proof:${item.one.key}`;
    renderCard();
    card.hidden = false;
    frameReview();
    place();
    render();
  };
  const startReview = (doc, one) => {
    if (!suggestionCount()) {
      A.toast(T("There is no suggestion to review."));
      return false;
    }
    if (!review) reviewFrom = app.doc;
    const items = reviewItems();
    // Asked again while it's on: where it is
    const now = review ? (review.step === "shape" ? null : review.one) : null;
    let item = one || now ? items.find((each) => each.one === (one || now)) : null;
    if (!item) item = review ? itemFrom(items, review.key, 1) : items[0];
    // The page has to show: the touch interface's sheet goes down
    if (Shell.touch && window.TypeRTouch && isOpen()) window.TypeRTouch.closeSheet();
    showItem(item);
    if (stage) stage.focus({ preventScroll: true });
    return true;
  };
  const closeReview = () => {
    if (!review) return;
    if (app.doc) ops.previewBreaks(null);
    if (review.step === "shape" && app.doc === review.doc) ops.sealHistory();
    review = null;
    reviewFrom = null;
    card.hidden = true;
    ring.hidden = true;
    words.textContent = "";
    render();
    renderAI();
  };
  // The next suggestion (or the one before), the page after when this one has no more; the
  // review ends once there are none
  const goOn = (step) => {
    if (!review) return;
    const item = itemFrom(reviewItems(), review.key, step);
    if (!item) {
      closeReview();
      A.toast(T("Every suggestion has been reviewed."));
      return;
    }
    showItem(item);
  };

  const accept = () => {
    if (!review || review.step !== "finding") return;
    const { doc, one, key } = review;
    if (!one.replacement) {
      editText();
      return;
    }
    findingsOf(doc);
    const layer = layerIn(doc, one.layerId);
    if (!bringDoc(doc) || !layer || textOf(layer) !== one.text) {
      A.toast(T("The text has changed since: this suggestion doesn't fit any more."));
      review = null;
      dismissFinding(doc, one);
      review = { doc, one, key, step: "finding" };
      goOn(1);
      return;
    }
    // Where its lines broke, read before Photoshop's pixels give way to TypeR's layout
    const counts = countsOf(doc, layer);
    const after = fromModel(one.replacement, one.text);
    const token = `gesture:proofreading:${++turns}`;
    if (A.isEditing()) A.endEdit();
    ops.sealHistory();
    review = { doc, one, key, step: "shape", bubble: review.bubble, done: { one, layerId: layer.id, before: one.text, after, counts, token } };
    ops.setText(layer.id, after, token);
    dismissFinding(doc, one);
    // Its lines moved: back as they were, in the same step
    keepLines(true);
    showReview();
    refresh(true);
  };
  // The lines it had before the correction, in the correction's own step
  const keepLines = (quiet) => {
    if (!review || review.step !== "shape") return false;
    const layer = reviewLayer();
    const plan = layer ? linesBefore(review.doc, layer, review.done) : null;
    if (!plan) return false;
    ops.previewBreaks(null);
    if (!sameBreaks(plan.breaks, plan.model.breaks)) {
      if (!quiet) A.warnMissingFont(layer);
      ops.setLineBreaks(layer.id, plan.model, plan.breaks, review.done.token);
    }
    if (!quiet) showReview();
    return true;
  };
  const shapeLines = (step) => {
    if (!review || review.step !== "shape" || !window.TypeRBreaks || !window.TypeRBreaks.setLines) return;
    const layer = reviewLayer();
    if (!layer || !bringDoc(review.doc)) return;
    if (!review.doc.state.activeIds.includes(layer.id)) A.actions.selectLayers([layer.id]);
    ops.previewBreaks(null);
    window.TypeRBreaks.setLines(lineCount(layer) + step, { coalesce: review.done.token });
    showReview();
  };
  const undoCorrection = () => {
    if (!review || !bringDoc(review.doc)) return;
    ops.undo();
  };
  const discard = () => {
    if (!review || review.step !== "finding") return;
    const { doc, one, key } = review;
    review = null;
    dismissFinding(doc, one);
    review = { doc, one, key, step: "finding" };
    goOn(1);
  };
  // The text typed by hand, the suggestion's words selected; what is typed then gets its shape
  // as an accepted correction does
  const editText = () => {
    if (!review || !bringDoc(review.doc)) return;
    const layer = reviewLayer();
    if (!layer) return;
    if (review.step === "finding") review.editing = { counts: countsOf(review.doc, layer) };
    A.beginEdit(layer);
    const spot = review.step === "finding" ? spotOf(review.one, textOf(layer)) : null;
    const editor = document.activeElement;
    if (spot && A.isEditing() && editor && editor.setSelectionRange) editor.setSelectionRange(spot[0], spot[1]);
    showReview();
  };
  // A suggestion taken back into the list (its correction undone)
  const restoreFinding = (doc, one) => {
    const list = findings.get(doc) || [];
    if (!list.includes(one)) findings.set(doc, list.concat(one));
    render();
  };

  // The review kept true to the page: an undo, a text typed, a page closed or switched
  const syncReview = () => {
    // A closed page on its way: the review waits for it
    if (!review || opening) return;
    if (!app.docs.includes(review.doc)) {
      goOn(1);
      return;
    }
    if (app.doc !== review.doc) {
      place();
      return;
    }
    const layer = reviewLayer();
    if (!layer) {
      goOn(1);
      return;
    }
    if (review.step === "shape") {
      const done = review.done;
      if (A.isEditing()) review.typed = true;
      else if (textOf(layer) === done.before) {
        // Undone: the suggestion is back, on the card and in the list
        restoreFinding(review.doc, done.one);
        review = { doc: review.doc, one: done.one, key: review.key, step: "finding" };
      } else if (review.typed) {
        // Typed again after the correction: what was typed is the corrected text
        review.typed = false;
        done.after = textOf(layer);
      }
    } else {
      // Being typed: nothing moves until it's done. Typed from the page itself (a double
      // click), it's this suggestion's edit all the same.
      if (A.isEditing()) {
        if (!review.editing && A.editingId() === layer.id) review.editing = { counts: countsOf(review.doc, layer) };
        showReview();
        return;
      }
      // Carried over a change elsewhere in its text, it stays; its own words changed, it goes
      const kept = findingsOf(review.doc).includes(review.one);
      const changed = textOf(layer) !== review.one.text;
      if (review.editing) {
        if (changed) {
          // Typed by hand: its shape next, as after Accept
          const { doc, one, key, editing } = review;
          review = { doc, one, key, step: "shape", done: { one, layerId: layer.id, before: one.text, after: textOf(layer), counts: editing.counts, token: `gesture:proofreading:${++turns}` } };
          dismissFinding(doc, one);
        } else {
          // Left as it was: the suggestion stays
          review.editing = null;
          restoreFinding(review.doc, review.one);
        }
      } else if (changed || !kept) {
        // Changed, applied or cleared from elsewhere: the next one
        goOn(1);
        return;
      }
    }
    showReview();
  };

  // The keys, before the page's own: only while the card shows, and only those it says
  document.addEventListener("keydown", (event) => {
    if (!review || card.hidden || app.doc !== review.doc || event.defaultPrevented || busy()) return;
    const active = document.activeElement;
    // A field, a panel's list, a row: their own keys
    if (active && active !== document.body && active !== document.documentElement && active !== stage && !card.contains(active) && active.tagName !== "BUTTON") return;
    const command = (event.metaKey || event.ctrlKey) && !event.getModifierState("AltGraph");
    const plain = !command && !event.altKey;
    const key = event.key;
    const shape = review.step === "shape";
    let run = null;
    if (key === "Escape" && plain) run = closeReview;
    else if (key === "Enter" && command && !event.altKey && !event.shiftKey) run = editText;
    // Enter never opens the text: pressed again, it would type over the words selected
    else if (key === "Enter" && plain && !event.shiftKey) run = shape || !review.one.replacement ? () => goOn(1) : accept;
    else if ((key === "Backspace" || key === "Delete") && plain) run = shape ? () => {} : discard;
    else if (key === "ArrowRight" && plain && !event.shiftKey) run = () => goOn(1);
    else if (key === "ArrowLeft" && plain && !event.shiftKey) run = () => goOn(-1);
    else if (shape && plain && key === "-") run = () => shapeLines(-1);
    else if (shape && plain && (key === "=" || key === "+")) run = () => shapeLines(1);
    else if (shape && plain && !event.shiftKey && key.toLowerCase() === "r") run = () => keepLines();
    if (!run) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat || /^Arrow/.test(key)) run();
  }, true);
  if (stage && window.ResizeObserver) new ResizeObserver(() => place()).observe(stage);

  /* ---------------------------------- Batch Save ---------------------------------- */

  // A line for the Batch Save dialog: what the last check left on the pages about to be saved,
  // with a way to see it. Nothing when they're clean or were never checked.
  const batchNote = (docs, closeDialog) => {
    let count = 0;
    let pages = 0;
    docs.forEach((doc) => {
      const left = issuesOf(doc).shown.filter((issue) => !issue.proof && (severityOf(issue) === "error" || severityOf(issue) === "warning")).length;
      count += left;
      if (left) pages++;
    });
    if (!count) return null;
    const line = make("p", "bsave__note verify-batch");
    line.innerHTML = ICONS.warning;
    make("span", "", line, pages > 1 ? fill(T("The last verification found {count} things to look at on {pages} of these pages."), { count, pages }) : plural(count, "The last verification found 1 thing to look at on these pages.", "The last verification found {count} things to look at on these pages."));
    button("verify__link", T("Show them"), line, () => {
      if (closeDialog) closeDialog();
      if (docs.length > 1) store.scope = "all";
      open();
    });
    return line;
  };

  /* ----------------------------------- start ----------------------------------- */

  const open = () => {
    if (Shell.touch && window.TypeRTouch) window.TypeRTouch.openSheet("verify");
    else if (window.TypeRWorkspace && !window.TypeRWorkspace.isVisible("verify")) window.TypeRWorkspace.setVisible("verify", true);
    opened();
  };
  const toggle = () => {
    if (isOpen()) {
      if (Shell.touch && window.TypeRTouch) window.TypeRTouch.closeSheet();
      else if (window.TypeRWorkspace) window.TypeRWorkspace.setVisible("verify", false);
    } else open();
  };
  PS.on((type, detail) => {
    if (type === "document") adoptOpenPages();
    if (type === "view" || type === "document") placeMark();
    if (review) {
      if (type === "view" || (type === "render" && !detail)) place();
      else if (type === "history" || type === "document" || type === "editing") syncReview();
    }
    if (!isOpen()) return;
    if (type === "history") refresh();
    else if (type === "document") refresh(true);
  });
  opened();

  window.TypeRVerification = {
    // app.js: Window > Verification, Edit > Check Typesetting, Edit > Proofread with AI…
    toggle,
    open,
    isOpen,
    check: () => {
      open();
      return checkNow();
    },
    proofread,
    // Edit > Review Proofreading: the suggestions one by one, on the page
    review: () => startReview(),
    get reviewing() {
      return review ? { doc: review.doc, step: review.step, finding: review.step === "shape" ? review.done.one : review.one, editing: Boolean(review.editing) } : null;
    },
    closeReview,
    suggestions: suggestionCount,
    openSettings,
    openAISettings,
    batchNote,
    // For scripts and tests
    get running() {
      return Boolean(running);
    },
    get proofreading() {
      return Boolean(proofing);
    },
    issuesOf: (doc) => issuesOf(doc || app.doc),
    // app.js: the chapter's pages changed (Open Pages…, a folder, a page saved as a PSD)
    pagesChanged: () => {
      if (!isOpen()) return;
      if (store.scope === "all") refresh(true);
      else renderSummary();
    },
    // Suggestions as the proofreading keeps them, on texts of a page: { layerId, kind, excerpt,
    // suggestion, replacement (the whole text with this fix alone, or null), explanation }
    addFindings: (doc, list) => {
      const kept = findings.get(doc) || [];
      (list || []).forEach((one) => {
        const layer = layerIn(doc, one.layerId);
        if (!layer) return;
        kept.push({ key: `${layer.id}:${one.kind}:${one.excerpt}:${one.suggestion}:${kept.length}`, layerId: layer.id, kind: one.kind, excerpt: String(one.excerpt || ""), suggestion: String(one.suggestion || ""), replacement: typeof one.replacement === "string" ? one.replacement : "", explanation: String(one.explanation || ""), text: textOf(layer) });
      });
      findings.set(doc, kept);
      render();
      renderAI();
    },
    goTo,
    fixOne,
    textsOf,
    render,
  };
})();
