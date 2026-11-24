// Flow: every page of the chapter laid out on one large surface, to wander over, where Solo
// shows one page at a time. app.js draws the page in front as it always does, and its view is
// still the only one there is: the surface is placed from it, each page at its distance from
// the page in front. So every tool works as in Solo, on the page in front.
//
// The other pages are small pictures of themselves, never a page's worth of pixels each: only
// the pages on screen have one, at the size they show, made from the file (flow-worker.js) or
// from the document when it is open. The page in the middle of the screen comes in front once
// the view rests, and so does a page clicked: the script and the pager follow.
//
// The pages lay themselves out (right to left, left to right or top to bottom), and a page
// dragged by its name goes wherever it is put, until the pages are tidied up. Put against the
// side of another page, level with it, it becomes one page with it: a spread (the app's part).
//
// Pages are picked as files in a folder (a click on a name, Cmd or Shift with it, or the Move
// tool drawn between the pages): they move together, and the app saves or closes them together.

(function () {
  "use strict";

  // The longest side of a page's picture: the first that covers what the screen shows of it
  const SIZES = [256, 512, 1024, 2048];
  // All the pictures together, in pixels (4 bytes each): past it, those off screen go first
  const BUDGET = 24e6;
  // How long a picture is kept once its page has left the screen: then a small one stays in
  // its place, enough for the page seen from afar, and that one goes later
  const KEPT = 20000;
  const BASE = 512;
  const KEPT_SMALL = 300000;
  // All the small pictures together, in pixels
  const BUDGET_SMALL = 8e6;
  // The view hasn't moved for this long: it rests, and the pictures are made sharper
  const STILL = 150;
  // The view has rested this long: the page in the middle comes in front
  const REST = 320;
  // The page names above the pages, and the room they need
  const LABEL = 11;
  // How near, on screen, a page being moved clings to another
  const CLING = 6;
  const GUIDE = "#ff4bd8";
  // A page this much wider than tall is two pages already, a spread: it goes alone
  const WIDE = 1.1;
  // Two by two, the white margin of a page says on which side its binding is when it is this
  // much wider than the other side's, in parts of the page's width; it counts no more than
  // CAPPED, and the pages go together the way at least SURE of what the margins say agrees with
  const MARGIN = 0.01;
  const CAPPED = 0.06;
  const SURE = 0.75;

  const create = (host) => {
    const { app, PS, ops } = host;
    let slots = [];
    const byKey = new Map();
    let stale = true;
    // The page in front as it was last drawn: what a page that comes in front is placed from
    let last = null;
    // The page Flow itself is bringing in front (its key)
    let pending = null;
    // The page under the middle of the screen when the view last rested
    let centre = null;
    let quiet = true;
    let restTimer = 0;
    // Where the surface was when last drawn, and when it was last seen to move
    let drawn = null;
    let movedAt = -Infinity;
    let stillTimer = 0;
    // The pages as they lie on one another: those put somewhere by hand over the others, the
    // last one moved on top
    let stack = [];
    let raises = 0;
    // The page being moved by its name
    let drag = null;
    // The pages picked (their keys), as files in a folder: a click on a name picks that page,
    // Cmd+click (Ctrl+click on Windows) adds or takes one away, Shift+click picks every page
    // from the last one clicked, and the Move tool drawn over the space between the pages picks
    // the pages it touches. The pages picked move together by any of their names; Save, Close
    // and Delete go for all of them (app.js). A press elsewhere on the surface, or a key that
    // isn't theirs, lets them go; a press in a menu or a panel doesn't, so that it can act on them.
    const picked = new Set();
    // The page Shift+click picks from
    let anchor = null;
    // The rectangle being drawn over the surface to pick pages
    let band = null;
    const forget = () => {
      if (!picked.size) return;
      picked.clear();
      host.schedule();
    };
    // Picked again: the app may say once what can be done with several pages
    const pickedNow = () => {
      host.schedule();
      if (host.picked) host.picked(picked.size);
    };
    // Cmd on a Mac, Ctrl elsewhere: on a Mac, Ctrl+click is the click of the menu
    const toggles = (event) => (host.mac ? event.metaKey : event.ctrlKey);
    // The pages two by two: whether the first page goes alone (1) or with the next (0), as
    // their margins say (`found`, null until they say it), or as shifted by hand for these pages
    // (`chosen`). The app's own (`shift` of its options) when neither says.
    let pairing = { pages: "", found: null, foundFor: null, chosen: null, reading: false, round: 0 };

    /* ---- the pages and where they are ---- */

    const drop = (slot) => {
      const { picture } = slot;
      slot.picture = null;
      slot.long = 0;
      slot.shot = null;
      if (!picture) return;
      if (picture.close) picture.close();
      else picture.width = picture.height = 0;
    };
    const pairsOn = () => {
      const { pairs, direction } = host.options();
      return Boolean(pairs) && direction !== "down";
    };
    // Two by two, the page a page faces, while they still touch: { side, facing }, the side of
    // the page it is on. Null alone, apart or moved away. `on`: whether the pages go two by
    // two, when it is already known (every page of a drawing).
    const touching = (slot, on = pairsOn()) => {
      const facing = on ? slot.facing : null;
      if (!facing || facing.y !== slot.y) return null;
      if (facing.x === slot.x + slot.w) return { side: "right", facing };
      if (facing.x + facing.w === slot.x) return { side: "left", facing };
      return null;
    };
    const shiftNow = () => {
      if (pairing.chosen !== null) return pairing.chosen;
      if (pairing.found !== null) return pairing.found;
      return host.options().shift ? 1 : 0;
    };
    // The pages two by two, in their order: [first, second] for two pages that face each other,
    // either missing at the start or the end of a run (its place is kept empty, as in a book),
    // and [page] for a spread, which goes alone. `shift` 1: the first page goes alone. After a
    // spread, the next page starts a pair again.
    const pairsOf = (list, shift) => {
      const units = [];
      let first = null;
      let second = shift === 1;
      list.forEach((slot) => {
        if (slot.w > slot.h * WIDE) {
          if (first) units.push([first, null]);
          units.push([slot]);
          first = null;
          second = false;
          return;
        }
        if (!second) {
          first = slot;
          second = true;
          return;
        }
        units.push([first, slot]);
        first = null;
        second = false;
      });
      if (first) units.push([first, null]);
      return units;
    };
    // Which way of pairing the pages their margins agree with: 0, 1, or null when they don't
    // say. A page put on the right of its pair has its binding on its left, so its white margin
    // there; the one on the left the other way round.
    const decide = (list, direction) => {
      const said = list.filter((slot) => slot.margins && Math.abs(slot.margins[0] - slot.margins[1]) >= MARGIN);
      if (said.length < 2) return null;
      const scores = [0, 1].map((shift) => {
        let agree = 0;
        let disagree = 0;
        pairsOf(list, shift).forEach((unit) => {
          if (unit.length === 1) return;
          unit.forEach((slot, at) => {
            if (!slot || !slot.margins) return;
            const lean = slot.margins[0] - slot.margins[1];
            if (Math.abs(lean) < MARGIN) return;
            // On the right of its pair: first from right to left, second from left to right
            const onRight = (at === 0) === (direction === "rtl");
            const weight = Math.min(Math.abs(lean), CAPPED);
            if (lean > 0 === onRight) agree += weight;
            else disagree += weight;
          });
        });
        return { agree, disagree };
      });
      const best = scores[1].agree > scores[0].agree ? 1 : 0;
      const { agree, disagree } = scores[best];
      return agree >= MARGIN * 2 && agree >= (agree + disagree) * SURE ? best : null;
    };
    // The margins of every page, read once, one page after the other, behind the pictures on
    // screen: then the pages go together as they say
    const examine = () => {
      const pages = slots.map((slot) => slot.key).join("\n");
      if (pairing.reading || pairing.pages === pages) return;
      pairing.pages = pages;
      pairing.reading = true;
      const { round } = pairing;
      const list = slots.slice();
      let stopped = false;
      const read = async () => {
        for (const slot of list) {
          if (pairing.round !== round) return;
          // No longer two by two: the pages left are read when they are again
          if (!pairsOn()) {
            stopped = true;
            return;
          }
          if (slot.margins !== undefined || !slot.page || byKey.get(slot.key) !== slot) continue;
          try {
            const file = await host.fileOf(slot.page);
            slot.margins = (await ask("margins", file)).margins || null;
          } catch (error) {
            slot.margins = null;
          }
        }
      };
      read().then(() => {
        if (pairing.round !== round) return;
        pairing.reading = false;
        // Pages came or went meanwhile: they are read in turn
        if (stopped || slots.map((slot) => slot.key).join("\n") !== pages) pairing.pages = "";
        pairing.foundFor = null;
        stale = true;
        quiet = true;
        host.schedule();
      });
    };
    // Where the pages go by themselves
    const arrange = () => {
      const { direction, gap, perRow } = host.options();
      slots.forEach((slot) => {
        slot.facing = null;
      });
      if (pairsOn()) {
        examine();
        // What the margins say depends on the way the pages go
        if (!pairing.reading && pairing.foundFor !== direction) {
          pairing.found = decide(slots, direction);
          pairing.foundFor = direction;
        }
        arrangePairs(direction, gap, perRow);
        return;
      }
      if (direction === "down") {
        let y = 0;
        slots.forEach((slot) => {
          slot.x = -Math.round(slot.w / 2);
          slot.y = y;
          y += slot.h + gap;
        });
        return;
      }
      const per = perRow > 0 ? perRow : Math.max(1, slots.length);
      let y = 0;
      for (let from = 0; from < slots.length; from += per) {
        const row = slots.slice(from, from + per);
        let x = 0;
        row.forEach((slot) => {
          if (direction === "rtl") {
            x -= slot.w;
            slot.x = x;
            x -= gap;
          } else {
            slot.x = x;
            x += slot.w + gap;
          }
          slot.y = y;
        });
        y += row.reduce((most, slot) => Math.max(most, slot.h), 0) + gap;
      }
    };
    // Two by two, touching, each pair as a page of its own; a row of `perRow` pages holds half
    // as many pairs
    const arrangePairs = (direction, gap, perRow) => {
      const units = pairsOf(slots, shiftNow());
      const per = perRow > 0 ? Math.max(1, Math.ceil(perRow / 2)) : Math.max(1, units.length);
      let y = 0;
      for (let from = 0; from < units.length; from += per) {
        const row = units.slice(from, from + per);
        let x = 0;
        let tallest = 0;
        row.forEach((unit) => {
          const [first, second] = unit;
          const [left, right] = unit.length === 1 ? [first, null] : direction === "rtl" ? [second, first] : [first, second];
          // A page missing from its pair leaves its place, as wide as the other
          const leftW = left ? left.w : right.w;
          const width = unit.length === 1 ? first.w : leftW + (right ? right.w : left.w);
          const at = direction === "rtl" ? x - width : x;
          if (left) left.x = at;
          if (right) right.x = at + leftW;
          if (left && right) {
            left.facing = right;
            right.facing = left;
          }
          unit.forEach((slot) => {
            if (!slot) return;
            slot.y = y;
            tallest = Math.max(tallest, slot.h);
          });
          x = direction === "rtl" ? at - gap : at + width + gap;
        });
        y += tallest + gap;
      }
    };
    // A page put somewhere by hand stays there, and leaves its place among the others empty:
    // moving one page moves no other
    const layout = () => {
      arrange();
      slots.forEach((slot) => {
        if (!slot.place) return;
        slot.x = slot.place[0];
        slot.y = slot.place[1];
      });
      stack = slots.slice().sort((a, b) => a.raised - b.raised);
    };
    const sync = () => {
      stale = false;
      const kept = new Set();
      slots = host.entries().map((entry) => {
        let slot = byKey.get(entry.key);
        if (!slot) {
          slot = { key: entry.key, w: 0, h: 0, x: 0, y: 0, sized: false, measured: false, picture: null, long: 0, shot: null, failed: 0, seenAt: 0, shown: false, box: null, place: null, raised: 0, title: null };
          byKey.set(entry.key, slot);
        }
        slot.name = entry.name;
        slot.doc = entry.doc;
        slot.page = entry.page;
        if (entry.doc) {
          slot.w = entry.doc.width;
          slot.h = entry.doc.height;
          slot.sized = true;
        }
        kept.add(entry.key);
        return slot;
      });
      byKey.forEach((slot, key) => {
        if (kept.has(key)) return;
        drop(slot);
        byKey.delete(key);
        picked.delete(key);
      });
      // A page not read yet is taken to be as large as the others, until its file says
      const known = (app.doc && slots.find((slot) => slot.doc === app.doc)) || slots.find((slot) => slot.sized);
      slots.forEach((slot) => {
        if (slot.sized) return;
        slot.w = known ? known.w : 1600;
        slot.h = known ? known.h : 2400;
        measure(slot);
      });
      layout();
    };
    const ensure = () => {
      const front = app.doc && slots.find((slot) => slot.doc === app.doc);
      if (stale || !front || front.w !== app.doc.width || front.h !== app.doc.height) sync();
    };
    const frontSlot = () => (app.doc ? slots.find((slot) => slot.doc === app.doc) || null : null);
    // Where the surface is on screen: its zoom and where its origin falls
    const world = () => {
      const slot = frontSlot();
      if (!slot) return null;
      const v = app.doc.view;
      return { slot, zoom: v.zoom, x: v.x - slot.x * v.zoom, y: v.y - slot.y * v.zoom };
    };
    const boxOf = (slot, w) => ({ x: w.x + slot.x * w.zoom, y: w.y + slot.y * w.zoom, width: slot.w * w.zoom, height: slot.h * w.zoom });
    const inside = (box, x, y) => x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height;
    // The page at a point of the screen: the one in front, or the one lying over the others
    const slotAt = (x, y, w) => {
      if (inside(boxOf(w.slot, w), x, y)) return w.slot;
      for (let at = stack.length - 1; at >= 0; at--) if (inside(boxOf(stack[at], w), x, y)) return stack[at];
      return null;
    };
    // The page whose name is at a point of the screen, as it was last drawn
    const titleAt = (x, y) => {
      for (let at = stack.length - 1; at >= 0; at--) if (stack[at].shown && stack[at].title && inside(stack[at].title, x, y)) return stack[at];
      return null;
    };

    /* ---- the pictures ---- */

    let worker = null;
    let noWorker = false;
    let asked = 0;
    const jobs = new Map();
    const ask = (what, file, longest) => new Promise((resolve, reject) => {
      if (noWorker) {
        reject(new Error("No worker"));
        return;
      }
      if (!worker) {
        try {
          worker = new Worker("flow-worker.js");
        } catch (error) {
          noWorker = true;
          reject(error);
          return;
        }
        worker.onmessage = ({ data }) => {
          const job = jobs.get(data.id);
          if (!job) return;
          jobs.delete(data.id);
          if (data.error) job.reject(new Error(data.error));
          else job.resolve(data);
        };
        worker.onerror = () => {
          noWorker = true;
          worker = null;
          jobs.forEach((job) => job.reject(new Error("The worker stopped")));
          jobs.clear();
        };
      }
      const id = ++asked;
      jobs.set(id, { resolve, reject });
      worker.postMessage({ id, ask: what, file, longest });
    });

    // A page's size, from the first bytes of its file: the surface is right before a page is seen
    const measure = (slot) => {
      if (slot.measured || !slot.page) return;
      slot.measured = true;
      ask("size", slot.page.file).then(({ size }) => {
        if (!size || slot.sized || byKey.get(slot.key) !== slot) return;
        slot.w = size[0];
        slot.h = size[1];
        slot.sized = true;
        stale = true;
        host.schedule();
      }).catch(() => {});
    };

    const small = (source, width, height, longest) => {
      const scale = Math.min(1, longest / Math.max(width, height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
      return canvas;
    };
    const setPicture = (slot, picture) => {
      drop(slot);
      slot.picture = picture;
      slot.long = Math.max(picture.width, picture.height);
      slot.shot = slot.doc ? slot.doc.state : null;
      slot.failed = 0;
    };
    // An open document's picture: from `composite` when the app has the page drawn already, or
    // drawn here, on a canvas let go at once
    const shoot = (slot, doc, composite, longest) => {
      let source = composite;
      let scratch = null;
      if (!source) {
        if (!PS.canvasFits(doc.width, doc.height)) return;
        scratch = document.createElement("canvas");
        scratch.width = doc.width;
        scratch.height = doc.height;
        PS.paintDoc(doc, scratch.getContext("2d"), {});
        source = scratch;
      }
      setPicture(slot, small(source, doc.width, doc.height, longest));
      if (scratch) scratch.width = scratch.height = 1;
    };
    // A file the worker can't picture (a PSD without Photoshop's own picture): read as to open
    // it, drawn, and let go
    const readWhole = async (file, longest) => {
      if (/\.ps[db]$/i.test(file.name)) {
        const doc = await ops.readDetached(file, file.name);
        try {
          const scratch = document.createElement("canvas");
          scratch.width = doc.width;
          scratch.height = doc.height;
          PS.paintDoc(doc, scratch.getContext("2d"), {});
          const picture = small(scratch, doc.width, doc.height, longest);
          scratch.width = scratch.height = 1;
          return { width: doc.width, height: doc.height, bitmap: picture };
        } finally {
          ops.dropDetached(doc);
        }
      }
      const full = await createImageBitmap(file);
      const picture = small(full, full.width, full.height, longest);
      const made = { width: full.width, height: full.height, bitmap: picture };
      full.close();
      return made;
    };
    const load = async (slot, longest) => {
      if (slot.doc) {
        shoot(slot, slot.doc, null, longest);
        return;
      }
      const file = await host.fileOf(slot.page);
      let made = null;
      try {
        made = await ask("picture", file, longest);
      } catch (error) {
        made = { whole: true };
      }
      if (made.whole) made = await readWhole(file, longest);
      // Opened, closed or gone meanwhile
      if (byKey.get(slot.key) !== slot || slot.doc) {
        if (made.bitmap.close) made.bitmap.close();
        return;
      }
      setPicture(slot, made.bitmap);
      if (made.width !== slot.w || made.height !== slot.h || !slot.sized) {
        slot.w = made.width;
        slot.h = made.height;
        slot.sized = true;
        stale = true;
      }
    };
    // The size a page's picture should have at this zoom, or 0 when the one it has will do.
    // While the view moves (`moving`), the one it has does until it shows twice too small: a
    // zoom goes through every size, and each picture made on the way is a file read for a
    // picture shown a few frames. An open document is only drawn again once the view rests.
    const wanted = (slot, zoom, moving) => {
      const natural = Math.max(slot.w, slot.h);
      const needed = Math.min(natural, natural * zoom * host.dpr(), SIZES[SIZES.length - 1]);
      const old = slot.doc && slot.shot !== slot.doc.state;
      if (slot.picture && (moving ? Boolean(slot.doc) || slot.long * 2 >= needed : !old && slot.long * 1.25 >= needed)) return 0;
      return SIZES.find((size) => size >= needed) || SIZES[SIZES.length - 1];
    };
    // A page's picture made small, from the picture itself: the page then comes back on screen
    // at once, without its file being read again. False when it is small already.
    const shrink = (slot) => {
      const { picture } = slot;
      if (!picture || slot.long <= BASE * 1.5) return false;
      const made = small(picture, picture.width, picture.height, BASE);
      if (picture.close) picture.close();
      else picture.width = picture.height = 0;
      slot.picture = made;
      slot.long = Math.max(made.width, made.height);
      return true;
    };
    const pixelsOf = (slot) => slot.picture.width * slot.picture.height;
    const isSmall = (slot) => slot.long <= BASE * 1.5;
    // Off screen for a while, or too many at once: the pictures seen longest ago are made
    // small, and the small ones go when there are too many of them. The two are counted apart:
    // a few pages seen close fill the budget by themselves, and the small pictures of all the
    // others would go each time, to be made again from their files at the next look from afar.
    const trim = () => {
      const now = performance.now();
      let total = 0;
      let little = 0;
      const held = slots.filter((slot) => slot.picture);
      held.forEach((slot) => {
        const away = slot.shown ? 0 : now - slot.seenAt;
        if (away > KEPT_SMALL) {
          drop(slot);
          return;
        }
        if (away > KEPT) shrink(slot);
        if (isSmall(slot)) little += pixelsOf(slot);
        else total += pixelsOf(slot);
      });
      if (total <= BUDGET && little <= BUDGET_SMALL) return;
      const away = held.filter((slot) => slot.picture && !slot.shown).sort((a, b) => a.seenAt - b.seenAt);
      away.forEach((slot) => {
        if (total <= BUDGET || isSmall(slot)) return;
        total -= pixelsOf(slot);
        shrink(slot);
        little += pixelsOf(slot);
      });
      away.forEach((slot) => {
        if (little <= BUDGET_SMALL || !isSmall(slot)) return;
        little -= pixelsOf(slot);
        drop(slot);
      });
    };
    setInterval(() => {
      if (slots.some((slot) => slot.picture)) trim();
    }, 5000);

    // One picture at a time, the page nearest the middle of the screen first, and a page with
    // nothing to show before one that only needs a sharper picture
    let loading = false;
    const pump = () => {
      if (loading || !host.on()) return;
      const w = world();
      if (!w) return;
      const [stageW, stageH] = host.stage();
      const moving = performance.now() - movedAt < STILL;
      // Asked only when a page needs it: this runs at every frame
      let busy = null;
      let best = null;
      let bestRank = Infinity;
      let bestSize = 0;
      slots.forEach((slot) => {
        if (slot === w.slot || !slot.shown || slot.failed > 2) return;
        if (!slot.doc && !slot.page) return;
        const size = wanted(slot, w.zoom, moving);
        if (!size) return;
        // Drawing a document takes the app a moment: not while something is being done, but for
        // the page a text being typed goes on to, which shows its part of it
        if (slot.doc) {
          if (busy === null) busy = Boolean(host.busy());
          if (busy && !(host.follows && host.follows(slot.doc))) return;
        }
        const box = slot.box;
        const rank = (slot.picture ? 1e7 : 0) + Math.hypot(box.x + box.width / 2 - stageW / 2, box.y + box.height / 2 - stageH / 2);
        if (rank >= bestRank) return;
        best = slot;
        bestRank = rank;
        bestSize = size;
      });
      if (!best) return;
      loading = true;
      load(best, bestSize).catch((error) => {
        best.failed += 1;
        console.warn("TypeR web: a page of Flow couldn't be shown", error);
      }).then(() => {
        loading = false;
        trim();
        host.schedule();
      });
    };

    /* ---- drawing ---- */

    // The dark line around a page, but on the side it faces another page (`open`)
    const frame = (ctx, x, y, width, height, open) => {
      ctx.strokeStyle = "#111";
      ctx.lineWidth = 1;
      if (!open) {
        ctx.strokeRect(x - 0.5, y - 0.5, width + 1, height + 1);
        return;
      }
      const left = x - 0.5;
      const top = y - 0.5;
      const right = x + width + 0.5;
      const bottom = y + height + 0.5;
      ctx.beginPath();
      if (open === "right") {
        ctx.moveTo(right, top);
        ctx.lineTo(left, top);
        ctx.lineTo(left, bottom);
        ctx.lineTo(right, bottom);
      } else {
        ctx.moveTo(left, top);
        ctx.lineTo(right, top);
        ctx.lineTo(right, bottom);
        ctx.lineTo(left, bottom);
      }
      ctx.stroke();
    };
    // Under the page in front: every other page on screen. False when Flow shows nothing.
    const drawUnder = (ctx) => {
      if (!host.on() || !app.doc) {
        if (!app.doc) last = null;
        return false;
      }
      ensure();
      const w = world();
      if (!w) return false;
      const v = app.doc.view;
      last = { key: w.slot.key, doc: app.doc, zoom: v.zoom, x: v.x, y: v.y, wx: w.slot.x, wy: w.slot.y };
      const [stageW, stageH] = host.stage();
      // What is drawn: the stage, and under the panels that float over it
      const [areaL, areaT, areaR, areaB] = host.area ? host.area() : [0, 0, stageW, stageH];
      const colors = host.colors();
      const now = performance.now();
      const pairs = pairsOn();
      // The surface moved since it was last drawn: the sharper pictures wait until it rests
      if (!drawn || Math.abs(drawn.x - w.x) > 0.01 || Math.abs(drawn.y - w.y) > 0.01 || Math.abs(drawn.zoom - w.zoom) > drawn.zoom * 1e-9) {
        if (drawn) {
          movedAt = now;
          clearTimeout(stillTimer);
          stillTimer = setTimeout(pump, STILL + 20);
        }
        drawn = { x: w.x, y: w.y, zoom: w.zoom };
      }
      stack.forEach((slot) => {
        const box = boxOf(slot, w);
        slot.box = box;
        slot.title = null;
        // The names above the pages are part of what is on screen
        slot.shown = box.x < areaR && box.y - LABEL - 8 < areaB && box.x + box.width > areaL && box.y + box.height > areaT;
        if (!slot.shown) return;
        slot.seenAt = now;
        if (slot === w.slot) return;
        let x = Math.round(box.x);
        const y = Math.round(box.y);
        let { width } = box;
        // Two pages facing each other meet on a whole pixel, without a line between them; the
        // page in front, drawn by the app over this one, covers a pixel of it
        const seam = touching(slot, pairs);
        if (seam) {
          let right = Math.round(box.x + box.width);
          if (seam.facing === w.slot) {
            if (seam.side === "left") x -= 1;
            else right += 1;
          }
          width = right - x;
        }
        ctx.fillStyle = slot.picture ? "#fff" : colors.blank;
        ctx.fillRect(x, y, width, box.height);
        if (slot.picture) ctx.drawImage(slot.picture, x, y, width, box.height);
        frame(ctx, x, y, width, box.height, seam && seam.side);
      });
      pump();
      return true;
    };
    // How wide each name is, written in the names' font: a chapter seen from afar has all its
    // names cut short, a letter at a time, at every frame
    const widths = new Map();
    let widthsFor = null;
    // Over the pages: their names, and a line around the page in front. A name is also what a
    // page is moved by; the name of a page with changes not saved yet has a colour of its own.
    const drawOver = (ctx) => {
      const w = world();
      if (!w) return;
      const colors = host.colors();
      ctx.font = `${LABEL}px ${colors.font}`;
      // The colours are read again now and then, the font with them: the widths too
      if (widthsFor !== colors || widths.size > 4000) {
        widths.clear();
        widthsFor = colors;
      }
      const widthOf = (text) => {
        let width = widths.get(text);
        if (width === undefined) {
          width = ctx.measureText(text).width;
          widths.set(text, width);
        }
        return width;
      };
      ctx.textBaseline = "alphabetic";
      const shown = stack.filter((slot) => slot.shown && slot.box);
      // The names of the pages lying over the others first: a name isn't written over another
      const named = [];
      const firsts = (slot) => (slot === w.slot ? 2 : drag && drag.slot === slot ? 1 : 0);
      shown.slice().reverse().sort((a, b) => firsts(b) - firsts(a)).forEach((slot) => {
        const { box } = slot;
        const x = Math.round(box.x);
        const y = Math.round(box.y);
        const front = slot === w.slot;
        const held = Boolean(drag) && drag.moved && drag.group.includes(slot);
        // A page picked has a line around it too, as the one in front
        const chosen = picked.has(slot.key);
        if (front || held || chosen) {
          ctx.strokeStyle = colors.accent;
          ctx.lineWidth = front ? 2 : 1;
          const out = front ? 2 : 1;
          // Two by two, the line goes around the page in front and the one facing it, as one
          // spread, while they still touch: no line between them
          const seam = front ? touching(slot) : null;
          if (seam) {
            const other = boxOf(seam.facing, w);
            const left = Math.round(Math.min(box.x, other.x));
            const top = Math.round(Math.min(box.y, other.y));
            const right = Math.round(Math.max(box.x + box.width, other.x + other.width));
            const bottom = Math.round(Math.max(box.y + box.height, other.y + other.height));
            ctx.strokeRect(left - out, top - out, right - left + out * 2, bottom - top + out * 2);
          } else ctx.strokeRect(x - out, y - out, box.width + out * 2, box.height + out * 2);
        }
        if (box.width < 36) return;
        const unsaved = Boolean(slot.doc) && PS.isDirty(slot.doc);
        // An open page's own name: a page saved as a PSD isn't the JPEG it was
        const title = slot.doc ? slot.doc.name : slot.name;
        const whole = slot.key === pending ? host.opening(title) : title + (unsaved ? " *" : "");
        const fitted = (room) => {
          let name = whole;
          if (widthOf(name) > room) {
            while (name.length > 1 && widthOf(name + "…") > room) name = name.slice(0, -1);
            name += "…";
          }
          return [name, Math.ceil(widthOf(name))];
        };
        const free = (rect) => !named.some((other) => other.x < rect.x + rect.width + 6 && other.x + other.width + 6 > rect.x && other.y < rect.y + rect.height && other.y + other.height > rect.y);
        // A name stands above its page. Where another page is, it goes on the page itself, in
        // its corner, so that the page can still be taken by it; not on the page in front, which
        // is the one worked on.
        let [name, width] = fitted(box.width);
        const top = y - LABEL - 8;
        const above = held || !shown.some((other) => other !== slot && other.box.x < x + width && other.box.x + other.box.width > x && other.box.y < y - 2 && other.box.y + other.box.height > top);
        if (above) {
          const rect = { x, y: top, width, height: LABEL + 8 };
          if (!free(rect)) return;
          named.push(rect);
          slot.title = { x: x - 4, y: top - 2, width: Math.max(width, 28) + 8, height: LABEL + 9 };
          if (chosen) {
            ctx.fillStyle = colors.accent;
            ctx.fillRect(x - 4, top - 1, width + 8, LABEL + 7);
            ctx.fillStyle = "#fff";
          } else ctx.fillStyle = unsaved ? colors.unsaved : front ? colors.accent : colors.muted;
          ctx.fillText(name, x, y - 7);
          return;
        }
        if (front || box.width < 60 || box.height < 40) return;
        [name, width] = fitted(box.width - 20);
        const rect = { x: x + 4, y: y + 4, width: width + 12, height: LABEL + 8 };
        if (!free(rect)) return;
        named.push(rect);
        slot.title = rect;
        ctx.fillStyle = chosen ? colors.accent : "rgba(24, 24, 24, 0.82)";
        ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
        ctx.fillStyle = chosen ? "#fff" : unsaved ? colors.unsaved : "#d6d6d6";
        ctx.fillText(name, rect.x + 6, rect.y + LABEL + 2);
      });
      // Held against the side of a page: one line around the two, and what letting go does
      if (drag && drag.join && drag.slot.box && drag.join.other.box) {
        const a = drag.slot.box;
        const b = drag.join.other.box;
        const left = Math.round(Math.min(a.x, b.x));
        const top = Math.round(Math.min(a.y, b.y));
        const right = Math.round(Math.max(a.x + a.width, b.x + b.width));
        const bottom = Math.round(Math.max(a.y + a.height, b.y + b.height));
        ctx.strokeStyle = colors.accent;
        ctx.lineWidth = 3;
        ctx.strokeRect(left - 2.5, top - 2.5, right - left + 5, bottom - top + 5);
        const text = host.joinHint();
        ctx.font = `600 12px ${colors.font}`;
        const width = Math.ceil(ctx.measureText(text).width) + 20;
        const x = Math.round((left + right - width) / 2);
        const y = top + 12;
        ctx.fillStyle = colors.accent;
        ctx.fillRect(x, y, width, 24);
        ctx.fillStyle = "#fff";
        ctx.fillText(text, x + 10, y + 16);
      }
      // The rectangle that picks pages, as it is drawn
      if (band && band.moved) {
        const left = Math.round(Math.min(band.from[0], band.to[0]));
        const top = Math.round(Math.min(band.from[1], band.to[1]));
        const width = Math.round(Math.abs(band.to[0] - band.from[0]));
        const height = Math.round(Math.abs(band.to[1] - band.from[1]));
        ctx.save();
        ctx.globalAlpha = 0.12;
        ctx.fillStyle = colors.accent;
        ctx.fillRect(left, top, width, height);
        ctx.restore();
        ctx.strokeStyle = colors.accent;
        ctx.lineWidth = 1;
        ctx.strokeRect(left + 0.5, top + 0.5, width, height);
      }
      if (!drag || !drag.guides.length) return;
      ctx.strokeStyle = GUIDE;
      ctx.lineWidth = 1;
      ctx.beginPath();
      drag.guides.forEach(([x1, y1, x2, y2]) => {
        ctx.moveTo(Math.round(w.x + x1 * w.zoom) + 0.5, Math.round(w.y + y1 * w.zoom) + 0.5);
        ctx.lineTo(Math.round(w.x + x2 * w.zoom) + 0.5, Math.round(w.y + y2 * w.zoom) + 0.5);
      });
      ctx.stroke();
    };

    /* ---- the page in front ---- */

    const bring = (slot) => {
      if (pending || slot.doc === app.doc) return;
      pending = slot.key;
      host.schedule();
      Promise.resolve().then(() => host.activate({ doc: slot.doc, page: slot.page })).catch((error) => {
        console.warn("TypeR web: a page of Flow couldn't come in front", error);
      }).then(() => {
        pending = null;
        quiet = true;
        host.schedule();
        rested();
      });
    };
    // The page in front was just left: its picture is what the screen showed of it. `composite`
    // holds it drawn, if the app still has it.
    const left = (doc, composite) => {
      if (!host.on() || !doc) return;
      const slot = slots.find((one) => one.doc === doc);
      if (!slot) return;
      const open = app.docs.includes(doc);
      let unsaved = false;
      try {
        unsaved = PS.isDirty(doc);
      } catch (error) {
        unsaved = true;
      }
      // Closed without its changes: the file says what the page is
      if (!open && (unsaved || !composite)) {
        drop(slot);
        return;
      }
      const zoom = last ? last.zoom : 1;
      const natural = Math.max(doc.width, doc.height);
      const needed = Math.min(natural, natural * zoom * host.dpr(), SIZES[SIZES.length - 1]);
      shoot(slot, doc, composite, SIZES.find((size) => size >= needed) || SIZES[SIZES.length - 1]);
      if (!open) slot.shot = null;
    };
    // A page came in front: it is placed on the surface where it stands. Brought by Flow, the
    // surface doesn't move; brought from elsewhere (a tab, the pager, Page Down, a file opened),
    // it takes the place of the page that was in front, and the surface slides. False when there
    // is nothing to place it from: the app then shows it as in Solo.
    const entered = (doc) => {
      stale = true;
      if (!host.on() || !doc) {
        if (!doc) last = null;
        return false;
      }
      sync();
      const slot = slots.find((one) => one.doc === doc);
      if (!slot || !last) return false;
      const v = doc.view;
      if (last.doc !== doc) {
        v.zoom = last.zoom;
        const stays = pending === slot.key;
        v.x = last.x + (stays ? (slot.x - last.wx) * last.zoom : 0);
        v.y = last.y + (stays ? (slot.y - last.wy) * last.zoom : 0);
        quiet = true;
      }
      v.fitted = false;
      v.seen = true;
      last = { key: slot.key, doc, zoom: v.zoom, x: v.x, y: v.y, wx: slot.x, wy: slot.y };
      return true;
    };

    // The view rested: the page under the middle of the screen comes in front, when it has
    // changed and is large enough on screen to be the one worked on
    const rested = () => {
      clearTimeout(restTimer);
      if (!host.on() || !app.doc) return;
      restTimer = setTimeout(() => {
        if (!host.on() || !app.doc) return;
        if (pending || drag || band || host.busy()) {
          rested();
          return;
        }
        ensure();
        const w = world();
        if (!w) return;
        const [stageW, stageH] = host.stage();
        const slot = slotAt(stageW / 2, stageH / 2, w);
        const key = slot ? slot.key : null;
        const changed = key !== centre;
        centre = key;
        if (quiet) {
          quiet = false;
          return;
        }
        if (!changed || !slot || slot === w.slot) return;
        if (slot.w * w.zoom < stageW * 0.3 && slot.h * w.zoom < stageH * 0.3) return;
        bring(slot);
      }, REST);
    };

    /* ---- a page moved by hand ---- */

    // A page put at a place of the surface. The page in front stays the one the view is told
    // from: the view goes with it, and the other pages don't move on screen.
    const put = (slot, x, y, place) => {
      const from = [slot.x, slot.y];
      slot.place = place;
      if (place) {
        slot.x = x;
        slot.y = y;
      } else layout();
      if (slot.doc && slot.doc === app.doc) {
        const v = app.doc.view;
        v.x += (slot.x - from[0]) * v.zoom;
        v.y += (slot.y - from[1]) * v.zoom;
        v.fitted = false;
        host.viewChanged();
      } else host.schedule();
    };
    // What can be joined in a spread: a page with a size, that isn't an InDesign document
    const joinable = (slot) => slot.sized && !(slot.doc && slot.doc.idml) && (slot.doc || slot.page);
    // A page being moved clings to the pages on screen: its sides and its middle to theirs, or
    // beside one of them, at the space between two pages. The lines say what it is level with.
    // `apart`: the pages moved with it, which it doesn't cling to.
    const cling = (slot, x, y, zoom, apart = new Set([slot])) => {
      const reach = CLING / zoom;
      const { gap } = host.options();
      let bestX = null;
      let bestY = null;
      slots.forEach((other) => {
        if (apart.has(other) || !other.shown) return;
        const tryX = (to, line) => {
          const far = Math.abs(to - x);
          if (far <= reach && (!bestX || far < bestX.far)) bestX = { far, to, line, other };
        };
        const tryY = (to, line) => {
          const far = Math.abs(to - y);
          if (far <= reach && (!bestY || far < bestY.far)) bestY = { far, to, line, other };
        };
        tryX(other.x, other.x);
        tryX(other.x + other.w - slot.w, other.x + other.w);
        tryX(other.x + (other.w - slot.w) / 2, other.x + other.w / 2);
        tryY(other.y, other.y);
        tryY(other.y + other.h - slot.h, other.y + other.h);
        tryY(other.y + (other.h - slot.h) / 2, other.y + other.h / 2);
        // Beside a page of its row, above or below a page of its column
        if (y < other.y + other.h && y + slot.h > other.y) {
          tryX(other.x + other.w + gap, null);
          tryX(other.x - gap - slot.w, null);
          // Against its side: the two become a spread
          if (apart.size === 1 && joinable(slot) && joinable(other)) {
            tryX(other.x + other.w, null);
            tryX(other.x - slot.w, null);
          }
        }
        if (x < other.x + other.w && x + slot.w > other.x) {
          tryY(other.y + other.h + gap, null);
          tryY(other.y - gap - slot.h, null);
        }
      });
      const at = [bestX ? bestX.to : x, bestY ? bestY.to : y];
      // Against the side of a page and level with it: let go there, the two are joined. Not
      // where a third page lies: the page was only passing over it.
      const beside = joinable(slot) && apart.size === 1 ? slots.find((other) => other !== slot && other.shown && joinable(other) && at[1] === other.y && (at[0] === other.x + other.w || at[0] + slot.w === other.x)) : null;
      const over = beside && slots.some((other) => other !== slot && other !== beside && other.shown && other.x < at[0] + slot.w && other.x + other.w > at[0] && other.y < at[1] + slot.h && other.y + other.h > at[1]);
      if (beside && !over) return { at, guides: [], join: { other: beside, side: at[0] < beside.x ? "left" : "right" } };
      const guides = [];
      if (bestX && bestX.line !== null) guides.push([bestX.line, Math.min(at[1], bestX.other.y), bestX.line, Math.max(at[1] + slot.h, bestX.other.y + bestX.other.h)]);
      if (bestY && bestY.line !== null) guides.push([Math.min(at[0], bestY.other.x), bestY.line, Math.max(at[0] + slot.w, bestY.other.x + bestY.other.w), bestY.line]);
      return { at, guides };
    };
    // A page held by its name follows the pointer until it is let go, and the other pages
    // picked with it go along; Escape puts them back. A press that didn't move picks the page
    // alone and brings it in front. `event` is the press, at (x, y) of the stage.
    const hold = (slot, x, y, event) => {
      const w = world();
      const offX = event.clientX - x;
      const offY = event.clientY - y;
      // The pages picked with it, in the order they lie on one another
      const group = picked.has(slot.key) && picked.size > 1 ? stack.filter((one) => picked.has(one.key)) : [slot];
      const starts = new Map(group.map((one) => [one, { was: one.place, from: [one.x, one.y] }]));
      const held = { slot, group, id: event.pointerId, moved: false, guides: [], join: null, was: slot.place, from: [slot.x, slot.y], grip: [(x - w.x) / w.zoom - slot.x, (y - w.y) / w.zoom - slot.y] };
      drag = held;
      host.cursor("held");
      try {
        event.target.setPointerCapture(event.pointerId);
      } catch (error) {
        // The pointer is followed on the window all the same
      }
      const move = (e) => {
        if (e.pointerId !== held.id) return;
        e.stopPropagation();
        const sx = e.clientX - offX;
        const sy = e.clientY - offY;
        if (!held.moved) {
          if (Math.hypot(sx - x, sy - y) < 4) return;
          held.moved = true;
          group.forEach((one) => {
            one.raised = ++raises;
          });
          stack = slots.slice().sort((a, b) => a.raised - b.raised);
        }
        const now = world();
        if (!now) return;
        let at = [sx / now.zoom - now.x / now.zoom - held.grip[0], sy / now.zoom - now.y / now.zoom - held.grip[1]];
        held.guides = [];
        held.join = null;
        // Ctrl, as for the layers: the page goes exactly where the pointer takes it
        if (!e.ctrlKey) ({ at, guides: held.guides, join: held.join = null } = cling(slot, at[0], at[1], now.zoom, new Set(group)));
        const dx = Math.round(at[0]) - held.from[0];
        const dy = Math.round(at[1]) - held.from[1];
        group.forEach((one) => {
          const { from } = starts.get(one);
          put(one, from[0] + dx, from[1] + dy, [from[0] + dx, from[1] + dy]);
        });
      };
      const done = (back) => {
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", up, true);
        window.removeEventListener("pointercancel", up, true);
        window.removeEventListener("keydown", key, true);
        drag = null;
        host.cursor(null);
        // Where the pages are has changed, not the page worked on
        quiet = true;
        // A click on the name, without moving the page, picks it alone: Delete then closes it
        if (!back && !held.moved) {
          picked.clear();
          picked.add(slot.key);
          anchor = slot.key;
          pickedNow();
        }
        if (back && held.moved) {
          group.forEach((one) => {
            const start = starts.get(one);
            put(one, start.from[0], start.from[1], start.was);
          });
        } else if (!held.moved && slot.doc !== app.doc) bring(slot);
        else if (held.moved && held.join) join(held);
        host.schedule();
        rested();
      };
      const up = (e) => {
        if (e.pointerId !== held.id) return;
        e.stopPropagation();
        done(e.type === "pointercancel");
      };
      const key = (e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        done(true);
      };
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", up, true);
      window.addEventListener("pointercancel", up, true);
      window.addEventListener("keydown", key, true);
    };
    // The page let go against another: the app makes one page of the two, which stands where
    // they stood. If it can't, the page goes back where it came from.
    const join = (held) => {
      const { slot } = held;
      const { other, side } = held.join;
      const w = world();
      if (!w || pending) return;
      const corner = [Math.min(slot.x, other.x), other.y];
      const onScreen = [w.x + corner[0] * w.zoom, w.y + corner[1] * w.zoom, w.zoom];
      const placed = Boolean(other.place);
      const entry = (one) => ({ key: one.key, name: one.name, doc: one.doc, page: one.page });
      pending = "join";
      Promise.resolve().then(() => host.join({ moved: entry(slot), onto: entry(other), side })).catch((error) => {
        console.warn("TypeR web: two pages of Flow couldn't be joined", error);
        return null;
      }).then((key) => {
        pending = null;
        quiet = true;
        if (!key) {
          if (byKey.get(slot.key) === slot) put(slot, held.from[0], held.from[1], held.was);
          host.schedule();
          return;
        }
        sync();
        const made = byKey.get(key);
        if (made && placed) {
          made.place = corner;
          made.raised = ++raises;
          layout();
        }
        if (made && made.doc && made.doc === app.doc) {
          const v = app.doc.view;
          v.zoom = onScreen[2];
          v.x = onScreen[0];
          v.y = onScreen[1];
          v.fitted = false;
          v.seen = true;
        }
        host.viewChanged();
        rested();
      });
    };
    // Every page back where the pages go by themselves: the page in front stays where it is,
    // the others come around it
    const tidy = () => {
      slots.forEach((slot) => {
        slot.place = null;
        slot.raised = 0;
      });
      raises = 0;
      stale = true;
      quiet = true;
      host.schedule();
    };

    /* ---- the pages picked ---- */

    // Cmd+click adds the page or takes it away; Shift+click picks every page from the last one
    // clicked (or the one in front) to this one, in the order of the pages
    const pickWith = (slot, range) => {
      if (range) {
        const from = (anchor && byKey.get(anchor)) || frontSlot() || slot;
        const a = slots.indexOf(from);
        const b = slots.indexOf(slot);
        slots.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((one) => picked.add(one.key));
      } else {
        if (picked.has(slot.key)) picked.delete(slot.key);
        else picked.add(slot.key);
        anchor = slot.key;
      }
      pickedNow();
    };
    // The Move tool drawn over the space between the pages: a rectangle that picks the pages it
    // touches, added to those picked already with Shift or Cmd. A click there, without drawing,
    // is the Move tool's own click beside every layer.
    const stretch = (x, y, event) => {
      const offX = event.clientX - x;
      const offY = event.clientY - y;
      const adds = event.shiftKey || toggles(event);
      const held = { id: event.pointerId, from: [x, y], to: [x, y], moved: false, base: adds ? new Set(picked) : new Set() };
      band = held;
      try {
        event.target.setPointerCapture(event.pointerId);
      } catch (error) {
        // The pointer is followed on the window all the same
      }
      const move = (e) => {
        if (e.pointerId !== held.id) return;
        e.stopPropagation();
        held.to = [e.clientX - offX, e.clientY - offY];
        if (!held.moved && Math.hypot(held.to[0] - x, held.to[1] - y) < 4) return;
        held.moved = true;
        const w = world();
        if (!w) return;
        const left = Math.min(held.from[0], held.to[0]);
        const right = Math.max(held.from[0], held.to[0]);
        const top = Math.min(held.from[1], held.to[1]);
        const bottom = Math.max(held.from[1], held.to[1]);
        picked.clear();
        held.base.forEach((key) => picked.add(key));
        slots.forEach((slot) => {
          const box = boxOf(slot, w);
          if (box.x < right && box.x + box.width > left && box.y < bottom && box.y + box.height > top) picked.add(slot.key);
        });
        host.schedule();
      };
      const done = (back) => {
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", up, true);
        window.removeEventListener("pointercancel", up, true);
        window.removeEventListener("keydown", key, true);
        band = null;
        if (back) {
          picked.clear();
          held.base.forEach((one) => picked.add(one));
          host.schedule();
        } else if (held.moved) pickedNow();
        else if (!adds && host.beside) host.beside();
        else host.schedule();
        rested();
      };
      const up = (e) => {
        if (e.pointerId !== held.id) return;
        e.stopPropagation();
        done(e.type === "pointercancel");
      };
      const key = (e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        done(true);
      };
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", up, true);
      window.addEventListener("pointercancel", up, true);
      window.addEventListener("keydown", key, true);
    };
    // A press on the surface lets the pages picked go, unless it picks more of them or holds
    // one of them by its name. A press elsewhere (a menu, a panel) keeps them, for what it does
    // to them. A right click on the name of a page not picked picks that page alone, for its menu.
    window.addEventListener("pointerdown", (event) => {
      if (!host.on() || drag || band) return;
      const at = host.at(event);
      if (!at) return;
      const named = pending ? null : titleAt(at[0], at[1]);
      if (named && picked.has(named.key)) return;
      // Ctrl+click on a Mac is a right click
      if (named && (event.button === 2 || (host.mac && event.ctrlKey))) {
        picked.clear();
        picked.add(named.key);
        anchor = named.key;
        host.schedule();
        return;
      }
      if (event.button === 0 && (event.shiftKey || toggles(event))) return;
      forget();
    }, true);

    // A press on a page's name holds the page, to move it, with the other pages picked. A press
    // on a page that isn't in front brings it in front, and does nothing else; with Shift or Cmd,
    // on its name or on it, it picks it instead. The Move tool pressed beside every page draws
    // the rectangle that picks pages.
    const press = (x, y, event) => {
      if (!host.on() || !app.doc || drag || band) return false;
      ensure();
      const w = world();
      if (!w) return false;
      const named = pending || !event ? null : titleAt(x, y);
      const picks = Boolean(event) && (event.shiftKey || toggles(event));
      if (named) {
        // Ctrl+click on a Mac: the page's menu comes, for the pages picked
        if (host.mac && event.ctrlKey) return true;
        if (picks) pickWith(named, event.shiftKey);
        else hold(named, x, y, event);
        return true;
      }
      const slot = slotAt(x, y, w);
      if (!slot && event && !pending && host.bands()) {
        stretch(x, y, event);
        return true;
      }
      if (!slot || slot === w.slot) return false;
      if (picks) pickWith(slot, event.shiftKey);
      else bring(slot);
      return true;
    };
    // The page whose name is at this point of the stage, for its menu: { name, doc, page }
    const nameAt = (x, y) => {
      if (!host.on() || !app.doc || drag || band || pending) return null;
      ensure();
      if (!world()) return null;
      const slot = titleAt(x, y);
      return slot ? { name: slot.name, doc: slot.doc || null, page: slot.page || null } : null;
    };
    // The pointer is over the name of a page: it can be taken
    const hover = (x, y) => {
      if (drag || band) return;
      host.cursor(x !== null && host.on() && app.doc && !pending && titleAt(x, y) ? "name" : null);
    };

    // Every page on screen at once
    const fitAll = () => {
      if (!host.on() || !app.doc) return;
      ensure();
      const w = world();
      if (!w) return;
      const [stageW, stageH] = host.stage();
      const left_ = Math.min(...slots.map((slot) => slot.x));
      const top = Math.min(...slots.map((slot) => slot.y));
      const width = Math.max(...slots.map((slot) => slot.x + slot.w)) - left_;
      const height = Math.max(...slots.map((slot) => slot.y + slot.h)) - top;
      const margin = Math.min(stageW, stageH) < 500 ? 12 : 32;
      const above = LABEL + 10;
      const zoom = Math.max(0.02, Math.min(32, (stageW - margin * 2) / width, (stageH - margin * 2 - above) / height));
      const v = app.doc.view;
      v.zoom = zoom;
      v.x = (stageW - width * zoom) / 2 + (w.slot.x - left_) * zoom;
      v.y = above + (stageH - above - height * zoom) / 2 + (w.slot.y - top) * zoom;
      v.fitted = false;
      quiet = true;
      host.viewChanged();
    };

    // Flow turned on or off, or laid out another way
    const changed = () => {
      stale = true;
      quiet = true;
      if (!host.on()) {
        // The places the pages were put at are kept for when Flow comes back
        slots.forEach(drop);
        picked.clear();
        last = null;
        centre = null;
        drawn = null;
        clearTimeout(restTimer);
        clearTimeout(stillTimer);
      }
      host.schedule();
    };

    return {
      drawUnder,
      drawOver,
      left,
      entered,
      rested,
      press,
      nameAt,
      hover,
      fitAll,
      changed,
      tidy,
      // The line around the page in front, which the app draws: open on the side it faces
      // another page, two by two
      frameFront: (ctx, x, y, width, height) => {
        const slot = host.on() && app.doc ? frontSlot() : null;
        const seam = slot ? touching(slot) : null;
        frame(ctx, x, y, width, height, seam && seam.side);
      },
      // The pages two by two shifted by one page: the first goes alone, or with the next. What
      // they now are (0 or 1), kept for these pages until others are given.
      shiftPairs: () => {
        pairing.chosen = shiftNow() ? 0 : 1;
        stale = true;
        quiet = true;
        host.schedule();
        return pairing.chosen;
      },
      // Whether a page was put somewhere by hand
      moved: () => slots.some((slot) => slot.place),
      // The page lying right under an open page (`step` 1) or right above it (-1), against it
      // and centred on it, as the pages go from top to bottom without a space: { doc, page }, or
      // null. A text put across the line where they meet goes on from one to the other.
      stackedOn: (doc, step) => {
        if (!host.on() || !app.doc || !doc) return null;
        ensure();
        const slot = slots.find((one) => one.doc === doc);
        if (!slot) return null;
        const found = slots.find((one) => {
          if (one === slot || !one.sized) return false;
          const [top, bottom] = step > 0 ? [slot, one] : [one, slot];
          return bottom.y === top.y + top.h && bottom.x - top.x === Math.round(top.w / 2) - Math.round(bottom.w / 2);
        });
        return found ? { doc: found.doc || null, page: found.page || null } : null;
      },
      // The pages picked, in the order of the pages, while Flow is on: [{ name, doc, page }]
      // (no doc for a page that isn't open)
      picked: () => (host.on() && picked.size ? slots.filter((slot) => picked.has(slot.key)).map((slot) => ({ name: slot.name, doc: slot.doc || null, page: slot.page || null })) : []),
      // Every page picked
      pickAll: () => {
        if (!host.on() || !app.doc) return;
        ensure();
        slots.forEach((slot) => picked.add(slot.key));
        pickedNow();
      },
      forget,
      // The pages changed: the tabs put in another order, or, `other`, another chapter given or
      // this one closed. Another chapter's pages may bear the same names: nothing is kept.
      pagesChanged: (other) => {
        if (other) {
          slots.forEach(drop);
          slots = [];
          stack = [];
          byKey.clear();
          picked.clear();
          raises = 0;
          pairing = { pages: "", found: null, foundFor: null, chosen: null, reading: false, round: pairing.round + 1 };
        }
        stale = true;
        host.schedule();
      },
      // For tests and the demos: what Flow holds
      state: () => ({ pending, centre, picked: Array.from(picked), pairs: pairsOn() ? { shift: shiftNow(), found: pairing.found, chosen: pairing.chosen, reading: pairing.reading } : null, pages: slots.map((slot) => ({ key: slot.key, name: slot.name, open: Boolean(slot.doc), front: slot.doc === app.doc, x: slot.x, y: slot.y, width: slot.w, height: slot.h, shown: slot.shown, placed: Boolean(slot.place), title: slot.title, picture: slot.picture ? [slot.picture.width, slot.picture.height] : null, margins: slot.margins || null })) }),
    };
  };

  window.TypeRFlow = { create };
})();
