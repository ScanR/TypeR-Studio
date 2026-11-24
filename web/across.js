// A text that goes on from a page to the next: a bubble cut between two pages of a strip, its
// first lines at the bottom of one file and its last at the top of the next. Photoshop has one
// way to set it: the same text layer in both files, one page's height apart, so that each file
// shows its part and the rest falls outside. That is what this keeps, and what the files hold:
// two ordinary text layers, which Photoshop opens and edits as any other.
//
// Here the two are one text. Typed, moved, styled or deleted on either page, the other follows,
// and so do Undo and Redo: each page has its own history, and the other page's goes one step
// back or forth with it when it can, or takes one more step.
//
// A text becomes one of these by being put across the line where two pages meet, in Flow, the
// pages going from top to bottom and touching; or by Text Across Pages, wherever the pages are.
// It stops being one when it no longer reaches the other page: back on its page, the other page
// lets it go; wholly on the other page, that page keeps it. What says the two layers are one
// text is kept in each file's metadata (psd.js), beside the layers themselves.
//
// The page under is the next page of the chapter, centred on this one as Flow lays them out:
// where a text is on it follows from the sizes of the two pages alone, so nothing has to be
// remembered of where Flow showed them. A page that is closed is opened behind the page in front
// when its text changes: the two layers are never left to differ.
//
// Only up and down: two pages side by side are a spread, which Flow joins into one page.

(function () {
  "use strict";

  // How opaque a pixel is for a letter to be there
  const INK = 12;
  // The longest side of what is read to tell whether a text shows on a page
  const READ = 384;
  // The other page is drawn again once the typing has paused this long
  const PAUSE = 220;
  // A text being typed is looked at once no letter has come for this long
  const CALM = 350;
  // How near an edge of its page a text is, in pixels, for its letters to be read: what it shows
  // (a stroke, a glow) reaches further than its letters
  const NEAR = 120;

  // Which of the two layers of a text was changed last, by page: what a page closed without
  // being saved doesn't have. Kept in the file with the text (see psd.js).
  const revs = new WeakMap();
  const revOf = (doc, layer) => {
    const own = revs.get(doc);
    const kept = own ? own.get(layer.across.key) : undefined;
    return kept !== undefined ? kept : layer.across.rev || 0;
  };

  const create = (host) => {
    const { app, PS, ops } = host;
    // What was last seen of each page: its state, and the step of history it was at
    const infos = new WeakMap();
    const infoOf = (doc) => {
      let info = infos.get(doc);
      if (!info) {
        // `unchecked`: the texts to look at once nothing is being typed; `alone`: those kept on
        // their page by hand; `owed`: the texts changed while the other page was closed;
        // `fresh`: those changed since the pages were last made alike
        info = { seen: null, entry: null, known: new Set(), unchecked: new Set(), alone: new Set(), owed: new Map(), fresh: new Set() };
        infos.set(doc, info);
      }
      return info;
    };
    // A layer of a page and the layer it is on the other page, both ways: what tells that the
    // two pages are alike, and which step of the other page's history a step goes with
    const twins = new WeakMap();
    const pair = (a, b) => {
      twins.set(a, b);
      twins.set(b, a);
    };
    const setRev = (doc, key, rev) => {
      if (!revs.has(doc)) revs.set(doc, new Map());
      revs.get(doc).set(key, rev);
    };
    const sharedOf = (doc, key) => doc.state.layers.find((layer) => layer.across && layer.across.key === key) || null;
    // What names a shared text in both files: its own, in any chapter and on any computer
    const newKey = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    const other = (part) => (part === "top" ? "bottom" : "top");
    // The document a text goes on to, by page and by text, as its number: what tells it from
    // another document when neither is a page of the chapter
    const mates = new WeakMap();
    const mate = (doc, key, partner) => {
      if (!mates.has(doc)) mates.set(doc, new Map());
      mates.get(doc).set(key, partner.id);
    };
    // Where the page under starts, on the page above it: centred, as Flow lays them out
    const under = (top, bottom) => [Math.round(top.width / 2) - Math.round(bottom.width / 2), top.height];
    // Where the other page's corner is on this one, for the part of the text this one holds
    const cornerOf = (doc, partner, part) => {
      if (part === "top") return under(doc, partner);
      const [x, y] = under(partner, doc);
      return [-x, -y];
    };
    // The page a text goes on to: { doc, entry, sure }. An open page that holds the text, or
    // the page next to this one. `sure`: a page of the chapter, whose place doesn't change.
    const partnerOf = (doc, key, part) => {
      // The other part of it: a copy of this page's file, open too, holds the same part
      const holder = app.docs.find((one) => one !== doc && !one.idml && (sharedOf(one, key) || {}).across && sharedOf(one, key).across.part === other(part));
      if (holder) {
        mate(doc, key, holder);
        return { doc: holder, entry: null, sure: true };
      }
      const entry = host.neighbour(doc, part === "top" ? 1 : -1);
      if (!entry || (entry.doc && entry.doc.idml)) return null;
      // A document that isn't a page of the chapter has no place of its own: only the one the
      // text was put on, not whichever document comes after once that one is closed
      if (!entry.page && !(mates.has(doc) && mates.get(doc).get(key) === entry.doc.id)) return null;
      return { doc: entry.doc || null, entry, sure: Boolean(entry.page) };
    };
    // What can go on to another page: a plain text, not a letter of an SFX nor a text set on a
    // perspective zone, which belong to their page
    const shareable = (doc, layer) => {
      if (!layer || layer.kind !== "text" || layer.warp || layer.sfx) return false;
      const folder = layer.group && doc.state.layers.find((item) => item.id === layer.group);
      return !(folder && folder.sfx);
    };

    /* ---- where a text shows ---- */

    const scratch = document.createElement("canvas");
    let scratchCtx = null;
    // Whether some of the text's letters are inside a rectangle of its page. Its picture is read
    // small, from a copy: the picture itself stays as the page draws it.
    const inkIn = (layer, doc, left, top, right, bottom) => {
      let visual = null;
      try {
        visual = PS.visualOf(layer, doc);
      } catch (error) {
        return false;
      }
      if (!visual || !visual.canvas || !visual.canvas.width || !visual.canvas.height) return false;
      const x = Math.floor(visual.x);
      const y = Math.floor(visual.y);
      const l = Math.max(left, x);
      const t = Math.max(top, y);
      const r = Math.min(right, x + visual.canvas.width);
      const b = Math.min(bottom, y + visual.canvas.height);
      if (r <= l || b <= t) return false;
      const scale = Math.min(1, READ / Math.max(r - l, b - t));
      const width = Math.max(1, Math.ceil((r - l) * scale));
      const height = Math.max(1, Math.ceil((b - t) * scale));
      if (!scratchCtx) scratchCtx = scratch.getContext("2d", { willReadFrequently: true });
      if (scratch.width < width) scratch.width = width;
      if (scratch.height < height) scratch.height = height;
      scratchCtx.clearRect(0, 0, width, height);
      scratchCtx.drawImage(visual.canvas, l - x, t - y, r - l, b - t, 0, 0, width, height);
      const { data } = scratchCtx.getImageData(0, 0, width, height);
      // Read small, a thin line weighs little: a lower bar then
      const bar = scale < 1 ? Math.max(2, INK * scale) : INK;
      for (let at = 3; at < data.length; at += 4) if (data[at] >= bar) return true;
      return false;
    };
    const onItsPage = (layer, doc) => inkIn(layer, doc, 0, 0, doc.width, doc.height);
    // On the other page, whose corner on this one is known once it is open. Closed, it is taken
    // to be as wide as this one.
    const onOther = (layer, doc, partner, part) => {
      if (!partner) return part === "top" ? inkIn(layer, doc, 0, doc.height, doc.width, doc.height + 1e6) : inkIn(layer, doc, 0, -1e6, doc.width, 0);
      const [x, y] = cornerOf(doc, partner, part);
      return inkIn(layer, doc, x, y, x + partner.width, y + partner.height);
    };

    /* ---- one page made like the other ---- */

    // The text as it is on the other page: the same layer, a page away
    const mirror = (layer, doc, partner, fields) => {
      const { key, part } = layer.across;
      const [x, y] = cornerOf(doc, partner, part);
      return ops.textOn(layer, doc, partner, x, y, Object.assign({ across: { key, part: other(part) }, clipping: false }, fields));
    };
    // What a page is to be given, gathered while the pages are looked at: `items`, by text,
    // { mode: "set" | "remove" | "unlink", layer, from }
    let wants = new Map();
    const want = (target, source, key, item) => {
      if (!wants.has(target)) wants.set(target, { source, items: new Map() });
      wants.get(target).items.set(key, item);
    };
    const sawNow = (doc) => {
      const info = infoOf(doc);
      const entry = doc.history[doc.historyIndex];
      info.seen = doc.state;
      info.entry = entry.id;
      info.known.add(entry.id);
    };
    // The layers of a state but those of these numbers or of these texts
    const rest = (state, ids, keys) => state.layers.filter((layer) => !ids.has(layer.id) && !(layer.across && keys.has(layer.across.key)));
    const sameLayers = (a, b) => a.length === b.length && a.every((layer, at) => layer === b[at]);
    // A step of the page's history, next to the one it is at, that is the page as it should be:
    // every text as wanted, and nothing else changed. The page then goes to that step, as if
    // undone or redone with the other. Undefined when there is none.
    const stepFor = (doc, items) => {
      const keys = new Set(items.keys());
      const ids = new Set();
      doc.state.layers.forEach((layer) => {
        if (layer.across && keys.has(layer.across.key)) ids.add(layer.id);
      });
      items.forEach((item) => {
        if (item.layer) ids.add(item.layer.id);
        if (item.twin) ids.add(item.twin.id);
      });
      const mine = rest(doc.state, ids, keys);
      return [doc.historyIndex - 1, doc.historyIndex + 1].find((index) => {
        const entry = doc.history[index];
        if (!entry) return false;
        const { state } = entry;
        if (Object.keys(doc.state).concat(Object.keys(state)).some((name) => name !== "layers" && name !== "activeIds" && state[name] !== doc.state[name])) return false;
        if (!sameLayers(rest(state, ids, keys), mine)) return false;
        return Array.from(items).every(([key, item]) => {
          const held = state.layers.find((layer) => layer.across && layer.across.key === key) || null;
          if (item.mode === "set") return Boolean(item.twin) && held === item.twin;
          return item.mode === "remove" && !held;
        });
      });
    };
    // A page given what the other says: its text put in, taken away, or left as a text of its own
    const give = (target, { source, items }) => {
      const from = source.history[source.historyIndex];
      const info = infoOf(source);
      const jumped = Boolean(info.jumped);
      if (jumped) {
        const index = stepFor(target, items);
        if (index !== undefined && ops.stepDoc(target, index)) {
          items.forEach((item, key) => {
            if (item.mode === "set") setRev(target, key, revOf(source, item.from));
          });
          sawNow(target);
          return;
        }
      }
      // A font only tried out on the page isn't part of what it is
      const state = target.stylePreview ? target.stylePreview.base : target.state;
      const layers = state.layers.slice();
      items.forEach((item, key) => {
        const at = layers.findIndex((layer) => (layer.across && layer.across.key === key) || (item.layer && layer.id === item.layer.id));
        if (item.mode === "set") {
          // Its own number and folder on this page, kept from one change to the next
          const made = item.twin && jumped ? item.twin : at >= 0 ? Object.assign({}, item.layer, { id: layers[at].id, group: layers[at].group, clipping: layers[at].clipping }) : item.layer;
          if (at >= 0) layers[at] = made;
          else layers.push(made);
          if (item.from) {
            pair(item.from, made);
            setRev(target, key, revOf(source, item.from));
          }
          return;
        }
        if (at < 0) return;
        // Gone from the other page, undone there or deleted: gone from this one too, even when
        // this page's history has no such step to go to. Merged or rasterized there: the text
        // stays, as a text of this page alone.
        if (item.mode === "remove") layers.splice(at, 1);
        else layers[at] = Object.assign({}, layers[at], { across: undefined });
      });
      const activeIds = state.activeIds.filter((id) => layers.some((layer) => layer.id === id));
      // Undone or redone there, the step the other page is now at isn't what was done here
      ops.changeDoc(target, jumped ? "Text Across Pages" : from.name, { layers, activeIds }, { coalesce: jumped ? undefined : from.coalesce || undefined });
      sawNow(target);
    };

    /* ---- a text that starts or stops going on ---- */

    // The page's step just made, with its layers changed: what was done there stays one step
    const amend = (doc, layers) => {
      ops.changeDoc(doc, null, { layers, activeIds: doc.state.activeIds.filter((id) => layers.some((layer) => layer.id === id)) }, { amend: true });
      sawNow(doc);
    };
    const replaced = (doc, layer, next) => doc.state.layers.map((item) => (item === layer ? next : item)).filter(Boolean);
    let said = false;
    const say = (text) => {
      if (said) return;
      said = true;
      host.toast(text);
    };
    const failed = new Set();
    const opening = new Set();
    // A closed page of the chapter a text goes on to: opened behind the page in front, then the
    // pages are looked at again
    const need = (entry) => {
      if (!entry || !entry.page || opening.has(entry.page) || failed.has(entry.page)) return;
      opening.add(entry.page);
      Promise.resolve().then(() => host.open(entry)).catch((error) => {
        failed.add(entry.page);
        console.warn("TypeR web: the page a text goes on to couldn't be opened", error);
        host.toast(host.fill(host.T("{name} can't be opened: the text that continues on it only changed on this page."), { name: entry.name }), true);
      }).then(() => {
        opening.delete(entry.page);
        queue();
      });
    };
    // A text of one page that reaches the page under or above: it goes on there. `how`: false
    // when it does so by itself, between two pages Flow shows one against the other; "asked",
    // by Text Across Pages, wherever Flow shows the pages, as a step of its own; "quiet", the
    // same within the step just made. True when it now does, null while the other page is being
    // opened.
    const share = (doc, layer, how) => {
      const info = infoOf(doc);
      if (!shareable(doc, layer) || layer.across || (!how && info.alone.has(layer.id))) return false;
      // Near the top or the bottom of its page, with a page there: only then are its letters read
      const box = PS.boxOf(layer, doc);
      if (!box) return false;
      const steps = [1, -1].filter((step) => {
        if (step > 0 ? box.bottom < doc.height - NEAR : box.top > NEAR) return false;
        const entry = host.neighbour(doc, step);
        if (!entry || (entry.doc && entry.doc.idml) || (!entry.doc && !entry.page)) return false;
        // A closed page that couldn't be opened: nothing goes on to it, and nothing is read for it
        if (!entry.doc && failed.has(entry.page)) return false;
        return Boolean(how) || host.stacked(doc, entry, step);
      });
      if (!steps.length || !onItsPage(layer, doc)) return false;
      for (const step of steps) {
        const entry = host.neighbour(doc, step);
        const part = step > 0 ? "top" : "bottom";
        if (!onOther(layer, doc, entry.doc, part)) continue;
        if (!entry.doc) {
          need(entry);
          return null;
        }
        const key = newKey();
        mate(doc, key, entry.doc);
        mate(entry.doc, key, doc);
        const next = Object.assign({}, layer, { across: { key, part } });
        info.alone.delete(layer.id);
        info.fresh.add(key);
        if (how === "asked") {
          ops.changeDoc(doc, "Text Across Pages", { layers: replaced(doc, layer, next) });
          sawNow(doc);
        } else amend(doc, replaced(doc, layer, next));
        const rev = Math.max(revOf(doc, next), 0) + 1;
        setRev(doc, key, rev);
        want(entry.doc, doc, key, { mode: "set", layer: mirror(next, doc, entry.doc, { id: PS.newId(), group: null }), from: next });
        const keys = host.keys();
        say(host.fill(host.T("This text continues on {name}: both pages hold it, and changing it on one changes the other."), { name: entry.doc.name }) + (keys && !how ? " " + host.fill(host.T("{keys}: keep it on this page only."), { keys }) : ""));
        return true;
      }
      return false;
    };
    // Both parts of a text on one page, as when two pages are joined into one: one text again,
    // the upper page's
    const oneAgain = (doc) => {
      const tops = new Set(doc.state.layers.filter((layer) => layer.across && layer.across.part === "top").map((layer) => layer.across.key));
      const keys = new Set(doc.state.layers.filter((layer) => layer.across && layer.across.part === "bottom" && tops.has(layer.across.key)).map((layer) => layer.across.key));
      if (!keys.size) return;
      amend(doc, doc.state.layers.filter((layer) => !(layer.across && layer.across.part === "bottom" && keys.has(layer.across.key))).map((layer) => (layer.across && keys.has(layer.across.key) ? Object.assign({}, layer, { across: undefined }) : layer)));
    };
    // A text shared by two pages, once it was changed: still across them, or back on one page.
    // False while the other page isn't open to say.
    const settle = (doc, layer) => {
      const { key, part } = layer.across;
      const found = partnerOf(doc, key, part);
      if (!found || !found.doc) return !found;
      const partner = found.doc;
      const here = onItsPage(layer, doc);
      const there = onOther(layer, doc, partner, part);
      if (here === there) return true;
      const info = infoOf(doc);
      info.fresh.delete(key);
      info.owed.delete(key);
      if (here) {
        // Back on this page alone: the other page lets it go
        amend(doc, replaced(doc, layer, Object.assign({}, layer, { across: undefined })));
        want(partner, doc, key, { mode: "remove" });
        return true;
      }
      // Wholly on the other page: that page keeps it, as a text of its own
      const held = sharedOf(partner, key);
      const made = Object.assign(mirror(layer, doc, partner, held ? { id: held.id, group: held.group } : { id: PS.newId(), group: null }), { across: undefined });
      amend(doc, replaced(doc, layer, null));
      want(partner, doc, key, { mode: "set", layer: made, from: null });
      host.toast(host.fill(host.T("The text is now on {name}."), { name: partner.name }));
      return true;
    };

    /* ---- the pages looked at ---- */

    let queued = false;
    let busy = false;
    let pushedAt = 0;
    let followTimer = 0;
    // While a text is typed, where it is isn't read at every letter: once the typing pauses
    let calm = false;
    let calmTimer = 0;
    const look = () => {
      queued = false;
      if (busy) return;
      busy = true;
      try {
        wants = new Map();
        const docs = app.docs.filter((doc) => !doc.idml && doc.history.length);
        const typing = host.typing() && !calm;
        calm = false;
        clearTimeout(calmTimer);
        docs.forEach((doc) => {
          // A font only tried out isn't a change
          if (doc.stylePreview) return;
          const info = infoOf(doc);
          info.jumped = false;
          if (info.seen === doc.state) return;
          const before = info.seen;
          const entry = doc.history[doc.historyIndex];
          const jumped = Boolean(before) && entry.id !== info.entry && info.known.has(entry.id);
          sawNow(doc);
          // A page of another size: where its texts are on the other page has changed
          const size = `${doc.width} ${doc.height}`;
          const resized = Boolean(before) && info.size !== size;
          info.size = size;
          oneAgain(doc);
          if (!before || (before.layers === doc.state.layers && !resized)) return;
          info.jumped = jumped;
          const was = new Map(before.layers.map((layer) => [layer.id, layer]));
          const wasShared = new Map(before.layers.filter((layer) => layer.across).map((layer) => [layer.across.key, layer]));
          // A copy of a shared text (Duplicate Layer, Paste Layers) is a text of its own, and so
          // is one that is no longer a text
          const holders = new Map();
          const stray = new Set();
          doc.state.layers.forEach((layer) => {
            if (!layer.across) return;
            const { key } = layer.across;
            const first = holders.get(key);
            if (layer.kind !== "text") stray.add(layer);
            else if (!first) holders.set(key, layer);
            else if (was.has(first.id) || !was.has(layer.id)) stray.add(layer);
            else {
              stray.add(first);
              holders.set(key, layer);
            }
          });
          if (!jumped) {
            holders.forEach((layer, key) => {
              if (was.has(layer.id) || wasShared.has(key)) return;
              stray.add(layer);
              holders.delete(key);
            });
          }
          if (stray.size) amend(doc, doc.state.layers.map((layer) => (stray.has(layer) ? Object.assign({}, layer, { across: undefined }) : layer)));
          const now = new Map();
          doc.state.layers.forEach((layer) => {
            if (layer.kind !== "text") return;
            if (!layer.across) {
              if (!jumped && was.get(layer.id) !== layer) info.unchecked.add(layer.id);
              return;
            }
            const { key, part } = layer.across;
            now.set(key, layer);
            if (wasShared.get(key) === layer && !resized) return;
            // Changed here: this page says what the text is
            const found = partnerOf(doc, key, part);
            const twin = found && found.doc ? sharedOf(found.doc, key) : null;
            setRev(doc, key, Math.max(revOf(doc, layer), twin ? revOf(found.doc, twin) : 0) + 1);
            info.fresh.add(key);
            if (found && !found.doc) info.owed.set(key, found.entry);
            if (!jumped) info.unchecked.add(layer.id);
          });
          // A shared text that is gone from this page
          wasShared.forEach((layer, key) => {
            if (now.has(key)) return;
            info.fresh.delete(key);
            const found = partnerOf(doc, key, layer.across.part);
            if (!found) return;
            const kept = doc.state.layers.find((item) => item.id === layer.id);
            // Deleted, it goes from both pages; undone, the other page goes back with this one;
            // merged or rasterized, the other page keeps its part as a text of its own
            const mode = (jumped && !(kept && kept.kind !== "text")) || (!kept && entry.name === "Delete Layer") ? "remove" : "unlink";
            if (found.doc) want(found.doc, doc, key, { mode });
            else if (mode === "remove" && !jumped) {
              info.owed.set(key, found.entry);
              info.gone = (info.gone || []).concat({ key, entry: found.entry });
              need(found.entry);
            }
          });
        });
        // The texts changed, once the typing pauses: across two pages, or no longer
        if (typing && docs.some((doc) => infoOf(doc).unchecked.size)) {
          calmTimer = setTimeout(() => {
            calm = true;
            look();
          }, CALM);
        }
        if (!typing) {
          docs.forEach((doc) => {
            const info = infoOf(doc);
            if (!info.unchecked.size || doc.stylePreview) return;
            const ids = Array.from(info.unchecked);
            info.unchecked.clear();
            ids.forEach((id) => {
              const layer = doc.state.layers.find((item) => item.id === id);
              if (!layer || layer.kind !== "text") return;
              const how = info.quiet && info.quiet.has(id) ? "quiet" : false;
              if (layer.across ? settle(doc, layer) === false : share(doc, layer, how) === null) info.unchecked.add(id);
              else if (how) info.quiet.delete(id);
            });
          });
        }
        // A text deleted while the other page was closed, now that it is open
        docs.forEach((doc) => {
          const info = infoOf(doc);
          if (!info.gone) return;
          info.gone = info.gone.filter(({ key, entry }) => {
            const partner = app.docs.find((one) => one !== doc && sharedOf(one, key)) || null;
            if (!partner && opening.has(entry.page)) return true;
            info.owed.delete(key);
            if (partner) want(partner, doc, key, { mode: "remove" });
            return false;
          });
          if (!info.gone.length) info.gone = null;
        });
        // Every shared text and its other page: alike, or the page changed last gives its own
        const orphans = [];
        docs.forEach((doc) => {
          // A font only tried out: the page is looked at once it is picked or left
          if (doc.stylePreview) return;
          const info = infoOf(doc);
          doc.state.layers.forEach((layer) => {
            if (!layer.across || layer.kind !== "text") return;
            const { key, part } = layer.across;
            const found = partnerOf(doc, key, part);
            if (!found) return;
            const partner = found.doc;
            if (!partner) {
              if (info.owed.has(key)) need(found.entry);
              return;
            }
            if (wants.has(doc) && wants.get(doc).items.has(key)) return;
            const twin = sharedOf(partner, key);
            const given = () => {
              const held = twins.get(layer);
              want(partner, doc, key, { mode: "set", layer: mirror(layer, doc, partner, twin ? null : { id: held ? held.id : PS.newId(), group: null }), twin: held || null, from: layer });
              info.fresh.delete(key);
              info.owed.delete(key);
            };
            if (!twin) {
              if (info.fresh.has(key) || info.owed.has(key)) given();
              else if (found.sure && !(wants.has(partner) && wants.get(partner).items.has(key))) orphans.push([doc, layer]);
              return;
            }
            if (twins.get(layer) === twin) {
              info.fresh.delete(key);
              info.owed.delete(key);
              return;
            }
            const mine = revOf(doc, layer);
            const theirs = revOf(partner, twin);
            if (mine > theirs) given();
            else if (mine === theirs) pair(layer, twin);
          });
        });
        // The other page doesn't have it (closed without being saved, or changed elsewhere):
        // a text of this page alone
        const alone = new Map();
        orphans.forEach(([doc, layer]) => alone.set(doc, (alone.get(doc) || new Set()).add(layer)));
        alone.forEach((layers, doc) => amend(doc, doc.state.layers.map((layer) => (layers.has(layer) ? Object.assign({}, layer, { across: undefined }) : layer))));
        const given = wants;
        wants = new Map();
        given.forEach((list, target) => {
          if (app.docs.includes(target)) give(target, list);
        });
        if (given.size) {
          pushedAt = Date.now();
          clearTimeout(followTimer);
          followTimer = setTimeout(() => host.schedule(), PAUSE + 20);
          host.schedule();
        }
      } catch (error) {
        console.warn("TypeR web: a text across two pages couldn't follow", error);
      } finally {
        busy = false;
      }
    };
    function queue() {
      if (queued) return;
      queued = true;
      queueMicrotask(look);
    }
    PS.on((type) => {
      if (type === "history" || type === "document" || type === "editing" || type === "undo" || type === "redo") queue();
    });

    /* ---- Text Across Pages ---- */

    const activeTexts = () => {
      const doc = app.doc;
      return doc ? doc.state.layers.filter((layer) => layer.kind === "text" && doc.state.activeIds.includes(layer.id)) : [];
    };
    // Whether the texts chosen go on to another page
    const on = () => {
      const texts = activeTexts();
      return texts.length > 0 && texts.every((layer) => layer.across);
    };
    // Text Across Pages: the texts chosen go on to the page they reach; chosen again, they stay
    // on this page alone
    const toggle = () => {
      const doc = app.doc;
      const texts = activeTexts();
      if (!doc || !texts.length) return;
      // What was just done is looked at first
      look();
      const info = infoOf(doc);
      wants = new Map();
      if (on()) {
        const kept = activeTexts();
        const set = new Set(kept);
        // The other page lets them go: now, or once it is open
        kept.forEach((layer) => {
          const { key, part } = layer.across;
          info.alone.add(layer.id);
          info.fresh.delete(key);
          info.owed.delete(key);
          const found = partnerOf(doc, key, part);
          if (found && found.doc) want(found.doc, doc, key, { mode: "remove" });
          else if (found && found.entry && found.entry.page) {
            info.gone = (info.gone || []).concat({ key, entry: found.entry });
            need(found.entry);
          }
        });
        ops.changeDoc(doc, "Text Across Pages", { layers: doc.state.layers.map((layer) => (set.has(layer) ? Object.assign({}, layer, { across: undefined }) : layer)) });
        sawNow(doc);
        info.jumped = false;
        const given = wants;
        wants = new Map();
        given.forEach((list, target) => give(target, list));
        if (given.size) host.schedule();
        host.toast(host.T(kept.length > 1 ? "These texts stay on this page only." : "This text stays on this page only."));
        return;
      }
      let waits = false;
      let made = 0;
      activeTexts().filter((layer) => !layer.across).forEach((layer) => {
        const now = doc.state.layers.find((item) => item.id === layer.id);
        // One step for all of them, as the other page has one
        const done = share(doc, now, made ? "quiet" : "asked");
        if (done === null) {
          waits = true;
          info.alone.delete(now.id);
          info.forced = (info.forced || new Set()).add(now.id);
        } else if (done) made += 1;
      });
      const given = wants;
      wants = new Map();
      given.forEach((list, target) => give(target, list));
      if (given.size) host.schedule();
      if (!made && !waits) host.toast(host.T("Put the text over the top or the bottom edge of its page first: it then continues on the page above or below."), true);
    };
    // The texts asked for by hand while their other page was closed: once it is open
    PS.on((type) => {
      if (type !== "document") return;
      queueMicrotask(() => {
        app.docs.forEach((doc) => {
          const info = infos.get(doc);
          if (!info || !info.forced || busy) return;
          const ids = Array.from(info.forced);
          wants = new Map();
          let made = false;
          ids.forEach((id) => {
            const layer = doc.state.layers.find((item) => item.id === id);
            const done = layer ? share(doc, layer, made ? "quiet" : "asked") : false;
            if (done !== null) info.forced.delete(id);
            if (done) made = true;
          });
          const given = wants;
          wants = new Map();
          given.forEach((list, target) => give(target, list));
          if (given.size) host.schedule();
        });
      });
    });

    return {
      toggle,
      on,
      // Whether Text Across Pages has something to act on
      can: () => activeTexts().some((layer) => layer.across || shareable(app.doc, layer)),
      // A page whose picture Flow draws again although the page in front is being worked on: the
      // other page of a text being typed, once the typing pauses
      follows: (doc) => {
        if (!app.doc || doc === app.doc || Date.now() - pushedAt < PAUSE) return false;
        return app.doc.state.layers.some((layer) => layer.across && sharedOf(doc, layer.across.key));
      },
      // A page's texts looked at again, wherever Flow shows the pages: those over its top or its
      // bottom edge go on, on the page there, within the step that made the page (two pages
      // just cut from one long page)
      check: (doc) => {
        if (!doc || !app.docs.includes(doc)) return;
        const info = infoOf(doc);
        info.quiet = info.quiet || new Set();
        doc.state.layers.forEach((layer) => {
          if (layer.kind !== "text" || layer.across) return;
          info.unchecked.add(layer.id);
          info.quiet.add(layer.id);
        });
        queue();
      },
      // The open pages a page shares a text with
      partners: (doc) => (doc ? app.docs.filter((one) => one !== doc && doc.state.layers.some((layer) => layer.across && sharedOf(one, layer.across.key))) : []),
      // For tests: the pages looked at now
      look,
      // The pages a document's shared texts go on to, by text: for tests and the demos
      state: (doc = app.doc) => (doc ? doc.state.layers.filter((layer) => layer.across).map((layer) => {
        const found = partnerOf(doc, layer.across.key, layer.across.part);
        return { id: layer.id, key: layer.across.key, part: layer.across.part, rev: revOf(doc, layer), partner: found && found.doc ? found.doc.name : found && found.entry ? found.entry.name : null, open: Boolean(found && found.doc) };
      }) : []),
    };
  };

  window.TypeRAcross = { create, revOf };
})();
