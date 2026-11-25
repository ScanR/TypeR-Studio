// The Pen (A): Photoshop's, for what a typesetter or a cleaner does with it. It draws the
// page's work path: an exact outline around a bubble, a panel or a piece of art, which then
// becomes a selection (Cmd+Enter), is filled, is stroked with the Brush (a bubble's line, a
// speed line) or becomes a layer's vector mask.
//
//   the path    one work path a page, as Photoshop has one: ops.setWorkPath in photoshop.js
//               keeps it in the history, psd.js in the file, where Photoshop keeps its own.
//               { paths: [{ open, knots: [{ linked, points: [inX, inY, x, y, outX, outY] }] }] }
//               in the page's pixels: the form of a vector mask's paths, for whatever reads
//               one later.
//   drawing     click: a corner point. Drag: a smooth point and its two handles (Alt: the one
//               ahead only; Space: move the point). Shift: 45°. Click the first point: close.
//               A click on a segment adds a point, on a point removes it (Auto Add/Delete).
//               Alt on a point or a handle converts it, Cmd held moves points and handles.
//   afterwards  a path made into a selection or a mask rests: it stays, drawn lighter, and
//               the next path takes its place; a click on it takes it up again.
(function () {
  "use strict";

  const PS = window.TypeRPhotoshop;
  if (!PS) return;
  const { app, ops } = PS;
  const App = () => window.TypeRApp;
  const T = (text) => (window.TypeRApp ? window.TypeRApp.T(text) : text);
  const SVGNS = "http://www.w3.org/2000/svg";
  const $ = (id) => document.getElementById(id);
  const touch = () => Boolean(window.TypeRShell && window.TypeRShell.touch);
  const IS_MAC = /mac/i.test(navigator.platform || "");
  const toast = (text, bad) => { if (App()) App().toast(T(text), bad); };
  const command = (event) => (IS_MAC ? event.metaKey : event.ctrlKey);

  /* ------------------------------ what is kept ------------------------------ */

  const STORE = "typer.web.pen";
  const settings = { antiAlias: true, feather: 0, auto: true };
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORE));
    if (saved && typeof saved === "object") {
      if (saved.antiAlias === false) settings.antiAlias = false;
      if (saved.auto === false) settings.auto = false;
      if (saved.feather > 0 && saved.feather <= 250) settings.feather = saved.feather;
    }
  } catch (error) {
    // The defaults, then
  }
  const keep = () => {
    try {
      window.localStorage.setItem(STORE, JSON.stringify(settings));
    } catch (error) {
      // Asked again next time, nothing else
    }
  };

  /* ------------------------------ the geometry ------------------------------ */

  const far = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const knotAt = (p) => ({ linked: false, points: [p[0], p[1], p[0], p[1], p[0], p[1]] });
  const comingOf = (knot) => [knot.points[0], knot.points[1]];
  const anchorOf = (knot) => [knot.points[2], knot.points[3]];
  const goingOf = (knot) => [knot.points[4], knot.points[5]];
  const knotOf = (coming, anchor, going, linked) => ({ linked: Boolean(linked), points: [coming[0], coming[1], anchor[0], anchor[1], going[0], going[1]] });
  const movedKnot = (knot, dx, dy) => Object.assign({}, knot, { points: knot.points.map((value, i) => value + (i % 2 ? dy : dx)) });
  // The same point met from the other end of its subpath
  const turnedKnot = (knot) => knotOf(goingOf(knot), anchorOf(knot), comingOf(knot), knot.linked);
  const turnedSub = (sub) => Object.assign({}, sub, { knots: sub.knots.map(turnedKnot).reverse() });
  const segmentsOf = (sub) => (sub.knots.length < 2 ? 0 : sub.open ? sub.knots.length - 1 : sub.knots.length);
  // A segment as the four points of its curve
  const curveOf = (sub, index) => {
    const a = sub.knots[index];
    const b = sub.knots[(index + 1) % sub.knots.length];
    return [anchorOf(a), goingOf(a), comingOf(b), anchorOf(b)];
  };
  const straight = (c) => far(c[0], c[1]) < 1e-6 && far(c[2], c[3]) < 1e-6;
  const onCurve = (c, t) => {
    const a = lerp(c[0], c[1], t);
    const b = lerp(c[1], c[2], t);
    const d = lerp(c[2], c[3], t);
    return lerp(lerp(a, b, t), lerp(b, d, t), t);
  };
  // The two curves a curve is made of, either side of `t`: together they draw the same line
  const splitCurve = (c, t) => {
    const a = lerp(c[0], c[1], t);
    const b = lerp(c[1], c[2], t);
    const d = lerp(c[2], c[3], t);
    const ab = lerp(a, b, t);
    const bd = lerp(b, d, t);
    const mid = lerp(ab, bd, t);
    return [[c[0], a, ab, mid], [mid, bd, d, c[3]]];
  };
  // A curve as points close enough to it that no one sees the corners
  const flatten = (c, tolerance, out, depth = 0) => {
    const dx = c[3][0] - c[0][0];
    const dy = c[3][1] - c[0][1];
    const chord = dx * dx + dy * dy;
    const off = chord < 1e-9
      ? far(c[1], c[0]) + far(c[2], c[0])
      : (Math.abs((c[1][0] - c[3][0]) * dy - (c[1][1] - c[3][1]) * dx) + Math.abs((c[2][0] - c[3][0]) * dy - (c[2][1] - c[3][1]) * dx)) / Math.sqrt(chord);
    if (off <= tolerance || depth > 14) {
      out.push(c[3]);
      return;
    }
    const [first, second] = splitCurve(c, 0.5);
    flatten(first, tolerance, out, depth + 1);
    flatten(second, tolerance, out, depth + 1);
  };
  // With Shift, by steps of 45° from `from`
  const aimed = (from, to, shift) => {
    if (!shift) return to;
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    const length = Math.hypot(dx, dy) * Math.cos(Math.atan2(dy, dx) - angle);
    return [from[0] + length * Math.cos(angle), from[1] + length * Math.sin(angle)];
  };
  // A handle on the other side of its point, in line with `handle`, as long as it was
  const facing = (anchor, handle, other) => {
    const length = far(other, anchor);
    const reach = far(handle, anchor);
    if (length < 1e-6 || reach < 1e-6) return other;
    return [anchor[0] - ((handle[0] - anchor[0]) / reach) * length, anchor[1] - ((handle[1] - anchor[1]) / reach) * length];
  };

  /* ------------------------------ the path ------------------------------ */

  // The subpath going on, the next click its next point: { doc, sub, flip, head }. `flip`: it
  // goes on from its first point, and is turned round when the next point is kept. `head`:
  // where its other end is, which tells its way round again after an undo.
  let drawing = null;
  // The one just closed: an undo opens it again, and it goes on
  let resumable = null;
  // The points picked: [{ sub, knot }]
  let picked = [];
  // The paths at rest, by their page: { path, step }, the step of the history that put it there
  const resting = new WeakMap();
  // The pointer over the page, for the segment to come: { point, shift }
  let pointer = null;
  let lastEvent = null;
  let pressed = null;
  let boxed = null;
  let spaceHeld = false;
  let mine = false;
  let gestures = 0;

  const pathOf = (doc = app.doc) => (doc && doc.state.workPath) || null;
  const subsOf = (doc = app.doc) => {
    const path = pathOf(doc);
    return path ? path.paths : [];
  };
  const isResting = (doc = app.doc) => {
    const path = pathOf(doc);
    const kept = doc && resting.get(doc);
    return Boolean(path) && Boolean(kept) && kept.path === path;
  };
  const rest = () => {
    const doc = app.doc;
    const path = pathOf();
    if (path) resting.set(doc, { path, step: doc.history[doc.historyIndex] });
    drawing = null;
    resumable = null;
    picked = [];
  };
  const wake = () => {
    if (app.doc) resting.delete(app.doc);
  };
  const isPicked = (sub, knot) => picked.some((item) => item.sub === sub && item.knot === knot);
  const withSub = (subs, index, sub) => subs.map((item, i) => (i === index ? sub : item));
  const withKnot = (sub, index, knot) => Object.assign({}, sub, { knots: sub.knots.map((item, i) => (i === index ? knot : item)) });
  const withKnots = (subs, change) => subs.map((sub, s) => {
    let changed = false;
    const knots = sub.knots.map((knot, k) => {
      const next = change(knot, s, k);
      if (next !== knot) changed = true;
      return next;
    });
    return changed ? Object.assign({}, sub, { knots }) : sub;
  });
  // The subpath going on, its last point the one the next segment starts from
  const drawnSub = () => {
    const sub = drawing && drawing.doc === app.doc ? subsOf()[drawing.sub] : null;
    if (!sub) return null;
    return drawing.flip ? turnedSub(sub) : sub;
  };
  // Where its two ends are in the subpath as it is kept
  const endIndex = () => (drawing.flip ? 0 : subsOf()[drawing.sub].knots.length - 1);
  const startIndex = () => (drawing.flip ? subsOf()[drawing.sub].knots.length - 1 : 0);
  const draw = (doc, sub, flip) => {
    const kept = subsOf(doc)[sub];
    drawing = { doc, sub, flip: Boolean(flip), head: anchorOf(kept.knots[flip ? kept.knots.length - 1 : 0]) };
    resumable = null;
  };

  // `turned`: the subpath going on was kept the way it is drawn, its first point first
  const commit = (paths, name, token, turned) => {
    let list = paths;
    // Photoshop's Exclude Overlapping Shapes: a subpath drawn inside another is a hole in it
    if (list.length && !list[0].operation) list = [Object.assign({}, list[0], { operation: "exclude" })].concat(list.slice(1));
    mine = true;
    try {
      ops.setWorkPath(list.length ? { paths: list } : null, name, token);
    } finally {
      mine = false;
    }
    if (drawing) {
      const kept = subsOf()[drawing.sub];
      if (!kept || !kept.open || drawing.doc !== app.doc) drawing = null;
      else {
        if (turned) drawing.flip = false;
        drawing.head = anchorOf(kept.knots[drawing.flip ? kept.knots.length - 1 : 0]);
      }
    }
    refresh();
  };
  // The subpath going on, with these points: kept the way it is drawn
  const commitDrawn = (knots, name, token, fields) => {
    const subs = subsOf();
    const sub = Object.assign({}, subs[drawing.sub], { knots }, fields);
    commit(withSub(subs, drawing.sub, sub), name, token, true);
  };
  // After an undo, a redo or another page: what was going on, if it still can
  const settle = () => {
    const doc = app.doc;
    const subs = subsOf(doc);
    const close = (a, b) => far(a, b) < 1e-3;
    if (drawing) {
      const sub = drawing.doc === doc ? subs[drawing.sub] : null;
      if (!sub || !sub.open) drawing = null;
      else if (close(anchorOf(sub.knots[0]), drawing.head)) drawing.flip = false;
      else if (close(anchorOf(sub.knots[sub.knots.length - 1]), drawing.head)) drawing.flip = true;
      else drawing = null;
    }
    if (!drawing && resumable && app.tool === "pen") {
      const sub = resumable.doc === doc ? subs[resumable.sub] : null;
      if (sub && sub.open && close(anchorOf(sub.knots[0]), resumable.head)) drawing = { doc, sub: resumable.sub, flip: false, head: resumable.head };
    }
    picked = picked.filter((item) => subs[item.sub] && subs[item.sub].knots[item.knot]);
    // Back before what put the path at rest (its selection undone): it is as it was then
    const kept = doc && resting.get(doc);
    if (kept) {
      const at = doc.history.indexOf(kept.step);
      if (at < 0 || at > doc.historyIndex) resting.delete(doc);
    }
  };

  /* ------------------------------ what shows ------------------------------ */

  let group = null;
  let band = null;
  const overlay = () => {
    if (group && group.isConnected) return group;
    const over = $("over");
    if (!over) return null;
    group = document.createElementNS(SVGNS, "g");
    group.id = "over-pen";
    over.appendChild(group);
    return group;
  };
  const svg = (tag, attributes, parent) => {
    const el = document.createElementNS(SVGNS, tag);
    Object.keys(attributes).forEach((key) => el.setAttribute(key, attributes[key]));
    parent.appendChild(el);
    return el;
  };
  const screen = (p) => App().toScreen(p[0], p[1]);
  const spot = (p) => {
    const [x, y] = screen(p);
    return `${Math.round(x * 100) / 100} ${Math.round(y * 100) / 100}`;
  };
  const lineOf = (subs) => {
    let d = "";
    subs.forEach((sub) => {
      if (!sub.knots.length) return;
      d += `M${spot(anchorOf(sub.knots[0]))}`;
      const count = segmentsOf(sub);
      for (let i = 0; i < count; i++) {
        const c = curveOf(sub, i);
        d += straight(c) ? `L${spot(c[3])}` : `C${spot(c[1])} ${spot(c[2])} ${spot(c[3])}`;
      }
      if (!sub.open && count) d += "Z";
    });
    return d;
  };
  // The handles that show, and can be taken: those of the points picked and of the point the
  // path goes on from, and the ones facing them across their segments
  const shownHandles = () => {
    const subs = subsOf();
    const out = [];
    const seen = new Set();
    const add = (s, k, side) => {
      const sub = subs[s];
      const knot = sub && sub.knots[k];
      if (!knot || seen.has(`${s}:${k}:${side}`)) return;
      const anchor = anchorOf(knot);
      const at = side === "in" ? comingOf(knot) : goingOf(knot);
      if (far(anchor, at) < 1e-6) return;
      seen.add(`${s}:${k}:${side}`);
      out.push({ sub: s, knot: k, side, anchor, at });
    };
    const around = (s, k) => {
      const sub = subs[s];
      if (!sub) return;
      const n = sub.knots.length;
      add(s, k, "in");
      add(s, k, "out");
      if (k + 1 < n || !sub.open) add(s, (k + 1) % n, "in");
      if (k > 0 || !sub.open) add(s, (k - 1 + n) % n, "out");
    };
    picked.forEach((item) => around(item.sub, item.knot));
    if (drawing && drawnSub()) {
      add(drawing.sub, endIndex(), "in");
      add(drawing.sub, endIndex(), "out");
    }
    return out;
  };
  const knotSize = () => (touch() ? 9 : 5);
  const squares = (points, size) => points.map((p) => {
    const [x, y] = screen(p);
    return `M${Math.round(x - size / 2) + 0.5} ${Math.round(y - size / 2) + 0.5}h${size}v${size}h${-size}Z`;
  }).join("");
  // The segment to come, from the last point to the pointer
  const bandOf = () => {
    const sub = !pressed && pointer ? drawnSub() : null;
    if (!sub) return "";
    const last = sub.knots[sub.knots.length - 1];
    const to = aimed(anchorOf(last), pointer.point, pointer.shift);
    return `M${spot(anchorOf(last))}C${spot(goingOf(last))} ${spot(to)} ${spot(to)}`;
  };
  const showBand = () => {
    if (band && band.isConnected) band.setAttribute("d", bandOf());
  };
  let queued = 0;
  const show = () => {
    queued = 0;
    const g = overlay();
    if (!g) return;
    const doc = app.doc;
    const path = app.tool === "pen" && doc && App() ? pathOf(doc) : null;
    band = null;
    if (!path) {
      // Nothing to draw costs nothing
      if (g.firstChild) g.textContent = "";
      return;
    }
    g.textContent = "";
    const subs = path.paths;
    const d = lineOf(subs);
    const idle = isResting(doc);
    // At rest, a light line alone: what was made of the path is what there is to look at
    if (idle) {
      svg("path", { class: "pen-line is-rest", d }, g);
      return;
    }
    svg("path", { class: "pen-line pen-line--shade", d }, g);
    svg("path", { class: "pen-line", d }, g);
    band = svg("path", { class: "pen-band", d: bandOf() }, g);
    const end = drawing && drawnSub() ? endIndex() : -1;
    const plain = [];
    const chosen = [];
    subs.forEach((sub, s) => sub.knots.forEach((knot, k) => ((drawing && s === drawing.sub && k === end) || isPicked(s, k) ? chosen : plain).push(anchorOf(knot))));
    const handles = shownHandles();
    if (handles.length) svg("path", { class: "pen-arm", d: handles.map((handle) => `M${spot(handle.anchor)}L${spot(handle.at)}`).join("") }, g);
    const size = knotSize();
    if (plain.length) svg("path", { class: "pen-knot", d: squares(plain, size) }, g);
    if (chosen.length) svg("path", { class: "pen-knot is-picked", d: squares(chosen, size) }, g);
    handles.forEach((handle) => {
      const [x, y] = screen(handle.at);
      svg("circle", { class: "pen-handle", cx: x, cy: y, r: touch() ? 5 : 3 }, g);
    });
    if (boxed) {
      const [x0, y0] = screen([Math.min(boxed.from[0], boxed.to[0]), Math.min(boxed.from[1], boxed.to[1])]);
      const [x1, y1] = screen([Math.max(boxed.from[0], boxed.to[0]), Math.max(boxed.from[1], boxed.to[1])]);
      svg("rect", { class: "pen-box", x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, g);
    }
  };
  const showSoon = () => {
    if (!queued) queued = requestAnimationFrame(show);
  };
  // The options bar follows what there is to do with the path
  let optionsKey = "";
  const optionsSignature = () => {
    const doc = app.doc;
    return [doc ? doc.id : "", Boolean(pathOf()), isResting(), Boolean(drawing), savedPaths().length].join("|");
  };
  const refresh = () => {
    show();
    if (app.tool === "pen" && App() && optionsSignature() !== optionsKey) App().renderOptions();
  };

  /* ------------------------------ under the pointer ------------------------------ */

  const stagePoint = (event) => {
    const rect = $("stage").getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  };
  const reachOf = (event) => (event.pointerType === "touch" ? 18 : event.pointerType === "pen" || touch() ? 11 : 7);
  // What is under the pointer: a handle (when `handles`), a point, or a segment and where on it
  const hitAt = (event, handles) => {
    const doc = app.doc;
    const subs = subsOf(doc);
    if (!subs.length || !App()) return null;
    const at = stagePoint(event);
    const reach = reachOf(event);
    let found = null;
    let best = reach;
    if (handles && !isResting(doc)) {
      shownHandles().forEach((handle) => {
        const distance = far(screen(handle.at), at);
        if (distance <= best) {
          best = distance;
          found = { kind: "handle", sub: handle.sub, knot: handle.knot, side: handle.side };
        }
      });
      if (found) return found;
    }
    subs.forEach((sub, s) => sub.knots.forEach((knot, k) => {
      const distance = far(screen(anchorOf(knot)), at);
      if (distance <= best) {
        best = distance;
        found = { kind: "knot", sub: s, knot: k };
      }
    }));
    if (found) return found;
    const zoom = doc.view.zoom || 1;
    const page = [(at[0] - doc.view.x) / zoom, (at[1] - doc.view.y) / zoom];
    const near = (reach * 0.8) / zoom;
    best = near;
    subs.forEach((sub, s) => {
      const count = segmentsOf(sub);
      for (let i = 0; i < count; i++) {
        const c = curveOf(sub, i);
        if (page[0] < Math.min(c[0][0], c[1][0], c[2][0], c[3][0]) - near || page[0] > Math.max(c[0][0], c[1][0], c[2][0], c[3][0]) + near) continue;
        if (page[1] < Math.min(c[0][1], c[1][1], c[2][1], c[3][1]) - near || page[1] > Math.max(c[0][1], c[1][1], c[2][1], c[3][1]) + near) continue;
        // The nearest of a few points along it, then closer and closer around that one
        const STEPS = 24;
        let t = 0;
        let nearest = Infinity;
        for (let n = 0; n <= STEPS; n++) {
          const distance = far(onCurve(c, n / STEPS), page);
          if (distance < nearest) {
            nearest = distance;
            t = n / STEPS;
          }
        }
        let low = Math.max(0, t - 1 / STEPS);
        let high = Math.min(1, t + 1 / STEPS);
        for (let n = 0; n < 16; n++) {
          const a = low + (high - low) / 3;
          const b = high - (high - low) / 3;
          if (far(onCurve(c, a), page) < far(onCurve(c, b), page)) high = b;
          else low = a;
        }
        t = (low + high) / 2;
        const distance = far(onCurve(c, t), page);
        // Not on its ends: those are its points
        if (distance <= best && t > 0.001 && t < 0.999) {
          best = distance;
          found = { kind: "segment", sub: s, index: i, t };
        }
      }
    });
    return found;
  };
  // What a press there would do
  const planOf = (event) => {
    const doc = app.doc;
    const subs = subsOf(doc);
    const cmd = command(event);
    // The touch interface has no Cmd nor Alt under a finger: there a press on a point or on a
    // handle holds it, to drag it, and only a tap removes the point
    const finger = touch();
    const at = hitAt(event, cmd || event.altKey || finger);
    if (isResting(doc)) {
      if (at && !cmd) return { mode: "wake", at };
      if (!at && !cmd) return { mode: "start" };
    }
    if (cmd) {
      if (!at) return { mode: "box" };
      if (at.kind === "handle") return { mode: "handle", at };
      if (at.kind === "knot") return { mode: "knots", at };
      return { mode: event.altKey || event.shiftKey || straight(curveOf(subs[at.sub], at.index)) ? "knots" : "bend", at };
    }
    const going = drawing && drawnSub() ? subs[drawing.sub] : null;
    if (event.altKey && at && at.kind === "handle") return { mode: "handle", at, breaks: true };
    if (finger && at && at.kind === "handle") return { mode: "handle", at };
    if (event.altKey && at && at.kind === "knot") return { mode: going && at.sub === drawing.sub && at.knot === endIndex() ? "end" : "convert", at };
    if (at && at.kind === "knot") {
      const sub = subs[at.sub];
      const isEnd = sub.open && (at.knot === 0 || at.knot === sub.knots.length - 1);
      if (going && at.sub === drawing.sub) {
        if (at.knot === endIndex()) return { mode: "end", at };
        if (at.knot === startIndex() && sub.knots.length > 1) return { mode: "close", at };
      } else if (going && isEnd) return { mode: "join", at };
      else if (!going && isEnd) return { mode: "resume", at };
      if (finger) return { mode: "knots", at, tapDeletes: settings.auto };
      if (settings.auto && !event.shiftKey) return { mode: "delete", at };
    }
    if (at && at.kind === "segment" && settings.auto && !event.shiftKey) return { mode: "add", at };
    return { mode: going ? "place" : "start" };
  };

  // The pointers: Photoshop's pen, and beside it the sign of what the click will do
  const cursorOf = (sign) => {
    const marks = { plus: "M17 13v8M13 17h8", minus: "M13 17h8", close: "M17 13.500a3.500 3.500 0 1 0 .01 0", join: "M13.500 17h2M18.500 17h2M13 15v4M21 15v4", new: "M14 14l6 6M20 14l-6 6", turn: "M13 19l4-5 4 5" };
    const nib = "M1.500 1.500 4.300 10.600 8.200 13 13 8.200 10.600 4.300ZM1.500 1.500 7.300 7.300";
    const body = "M8.200 13 10.800 15.600 15.600 10.800 13 8.200";
    const mark = marks[sign] ? `<path d='${marks[sign]}' stroke='%23fff' stroke-width='3.500'/><path d='${marks[sign]}' stroke='%23000' stroke-width='1.500'/>` : "";
    const picture = `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke-linecap='round' stroke-linejoin='round'><path d='${nib}${body}' stroke='%23fff' stroke-width='3'/><path d='${nib}' fill='%23fff' stroke='%23000' stroke-width='1.200'/><path d='${body}' fill='%23000' stroke='%23000' stroke-width='1.200'/><circle cx='7.800' cy='7.800' r='1' fill='%23000'/>${mark}</svg>`;
    return `url("data:image/svg+xml,${picture.replace(/</g, "%3C").replace(/>/g, "%3E").replace(/ /g, "%20")}") 1 1, crosshair`;
  };
  const CURSORS = {};
  const CURSOR_SIGN = { start: "new", place: "", add: "plus", delete: "minus", close: "close", join: "join", resume: "join", end: "turn", convert: "turn", wake: "" };
  const cursorFor = (plan) => {
    if (plan.tapDeletes) return cursorFor({ mode: "delete" });
    if (plan.mode === "box" || plan.mode === "knots" || plan.mode === "bend" || plan.mode === "handle") return plan.breaks ? "crosshair" : "default";
    if (plan.mode === "wake") return "pointer";
    const sign = CURSOR_SIGN[plan.mode] || "";
    if (!CURSORS[sign]) CURSORS[sign] = cursorOf(sign);
    return CURSORS[sign];
  };

  /* ------------------------------ the pointer ------------------------------ */

  const hover = (event, point) => {
    lastEvent = { clientX: event.clientX, clientY: event.clientY, pointerType: event.pointerType, shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey };
    pointer = { point, shift: event.shiftKey };
    // A press the app took back (two fingers come to zoom) is over
    pressed = null;
    boxed = null;
    const stage = $("stage");
    if (stage) stage.style.cursor = cursorFor(planOf(event));
    showBand();
  };
  // A key pressed or let go changes what the click will do, and the pointer says it
  const hoverAgain = (event) => {
    if (!lastEvent || pressed || app.tool !== "pen" || !app.doc || !App()) return;
    const again = Object.assign({}, lastEvent, { shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey });
    const rect = $("stage").getBoundingClientRect();
    const v = app.doc.view;
    hover(again, [(again.clientX - rect.left - v.x) / v.zoom, (again.clientY - rect.top - v.y) / v.zoom]);
  };

  const removeKnot = (subs, s, k) => {
    const sub = subs[s];
    const knots = sub.knots.filter((knot, i) => i !== k);
    if (!knots.length) return subs.filter((item, i) => i !== s);
    // An end taken off an open subpath leaves its new end as it was; one point alone is open
    return withSub(subs, s, Object.assign({}, sub, { knots, open: sub.open || knots.length < 2 }));
  };
  const down = (event, point, base) => {
    if (event.button !== 0 || !app.doc) return null;
    // On a Mac, Ctrl + click is the right click: the path's menu, not a point
    if (IS_MAC && event.ctrlKey) return null;
    const doc = app.doc;
    const plan = planOf(event);
    const { at } = plan;
    // Whatever is done next, the path closed before it stays closed
    resumable = null;
    const token = `gesture:pen:${++gestures}`;
    const subs = subsOf(doc);
    const make = (fields) => {
      pressed = Object.assign(base, { kind: "pen", token, mode: plan.mode }, fields);
      showBand();
      return pressed;
    };
    if (plan.mode === "wake") {
      wake();
      refresh();
      return make({ mode: "none" });
    }
    if (plan.mode === "box") return make({ add: event.shiftKey, before: picked.slice() });
    if (isResting(doc) && at) wake();
    if (plan.mode === "handle") {
      if (!isPicked(at.sub, at.knot) && !(drawing && at.sub === drawing.sub)) picked = picked.concat([{ sub: at.sub, knot: at.knot }]);
      return make({ sub: at.sub, knot: at.knot, side: at.side, breaks: Boolean(plan.breaks), from: subs });
    }
    if (plan.mode === "knots" || plan.mode === "bend") {
      const sub = subs[at.sub];
      const all = sub.knots.map((knot, k) => ({ sub: at.sub, knot: k }));
      const ends = at.kind === "knot" ? [{ sub: at.sub, knot: at.knot }] : [{ sub: at.sub, knot: at.index }, { sub: at.sub, knot: (at.index + 1) % sub.knots.length }];
      // Alt: the whole subpath. Shift: with the ones picked, or without when it was one of them.
      if (event.altKey) picked = picked.filter((item) => item.sub !== at.sub).concat(all);
      else if (event.shiftKey && at.kind === "knot" && isPicked(at.sub, at.knot)) picked = picked.filter((item) => !(item.sub === at.sub && item.knot === at.knot));
      else if (event.shiftKey) picked = picked.concat(ends.filter((item) => !isPicked(item.sub, item.knot)));
      else if (!ends.every((item) => isPicked(item.sub, item.knot))) picked = ends;
      show();
      return make({ sub: at.sub, index: at.index, t: at.t, from: subs, name: "Drag Anchor Point", tapDeletes: plan.tapDeletes ? at : null });
    }
    if (plan.mode === "convert" || plan.mode === "end") {
      if (plan.mode === "convert") picked = [{ sub: at.sub, knot: at.knot }];
      show();
      return make({ sub: at.sub, knot: at.knot, from: subs });
    }
    if (plan.mode === "close") {
      const sub = drawnSub();
      const index = drawing.sub;
      resumable = { doc, sub: index, head: anchorOf(sub.knots[0]) };
      const kept = resumable;
      commitDrawn(sub.knots, "Close Path", token, { open: false });
      drawing = null;
      resumable = kept;
      picked = [{ sub: index, knot: 0 }];
      refresh();
      return make({ sub: index, knot: 0, from: subsOf(doc) });
    }
    if (plan.mode === "join") {
      // The two subpaths become one, which stops there
      const sub = drawnSub();
      const other = subs[at.sub];
      const added = at.knot === 0 ? other.knots : turnedSub(other).knots;
      const joined = Object.assign({}, subs[drawing.sub], { knots: sub.knots.concat(added) });
      const paths = withSub(subs, drawing.sub, joined).filter((item, i) => i !== at.sub);
      const index = drawing.sub - (at.sub < drawing.sub ? 1 : 0);
      drawing = null;
      picked = [{ sub: index, knot: sub.knots.length }];
      commit(paths, "New Anchor Point", token);
      return make({ mode: "close", sub: index, knot: sub.knots.length, from: subsOf(doc) });
    }
    if (plan.mode === "resume") {
      picked = [];
      draw(doc, at.sub, at.knot === 0 && subs[at.sub].knots.length > 1);
      refresh();
      return make({ mode: "end", sub: at.sub, knot: at.knot, from: subs, resumed: true });
    }
    if (plan.mode === "delete") {
      const paths = removeKnot(subs, at.sub, at.knot);
      if (drawing && paths.length < subs.length) drawing = at.sub === drawing.sub ? null : Object.assign(drawing, { sub: drawing.sub - (at.sub < drawing.sub ? 1 : 0) });
      picked = [];
      commit(paths, "Delete Anchor Point", token);
      return make({ mode: "none" });
    }
    if (plan.mode === "add") {
      const sub = subs[at.sub];
      const c = curveOf(sub, at.index);
      const [first, second] = splitCurve(c, at.t);
      const n = sub.knots.length;
      const a = sub.knots[at.index];
      const b = sub.knots[(at.index + 1) % n];
      const flat = straight(c);
      const knots = sub.knots.slice();
      knots[at.index] = knotOf(comingOf(a), anchorOf(a), first[1], a.linked && !flat);
      knots[(at.index + 1) % n] = knotOf(second[2], anchorOf(b), goingOf(b), b.linked && !flat);
      knots.splice(at.index + 1, 0, flat ? knotAt(first[3]) : knotOf(first[2], first[3], second[1], true));
      picked = [{ sub: at.sub, knot: at.index + 1 }];
      commit(withSub(subs, at.sub, Object.assign({}, sub, { knots })), "Add Anchor Point", token);
      // Dragged on, the new point follows
      return make({ mode: "knots", sub: at.sub, from: subsOf(doc), name: "Add Anchor Point" });
    }
    // A new point: the path's next, or the first of a new subpath
    picked = [];
    if (plan.mode === "place") {
      const sub = drawnSub();
      const origin = aimed(anchorOf(sub.knots[sub.knots.length - 1]), point, event.shiftKey);
      commitDrawn(sub.knots.concat([knotAt(origin)]), "New Anchor Point", token);
      return make({ sub: drawing.sub, knot: sub.knots.length, origin, d: [0, 0], prev: point });
    }
    // A path at rest gives way to the new one
    const before = isResting(doc) ? [] : subs;
    const paths = before.concat([{ open: true, fillRule: "even-odd", knots: [knotAt(point)] }]);
    drawing = { doc, sub: paths.length - 1, flip: false, head: point };
    resumable = null;
    commit(paths, before.length ? "New Anchor Point" : "New Work Path", token);
    return make({ mode: "place", sub: paths.length - 1, knot: 0, origin: point, d: [0, 0], prev: point });
  };

  const move = (current, event, point) => {
    const doc = app.doc;
    if (current.mode === "none" || !doc) return;
    if (current.mode === "box") {
      boxed = { from: current.start, to: point };
      const left = Math.min(current.start[0], point[0]);
      const right = Math.max(current.start[0], point[0]);
      const top = Math.min(current.start[1], point[1]);
      const bottom = Math.max(current.start[1], point[1]);
      const inside = [];
      subsOf(doc).forEach((sub, s) => sub.knots.forEach((knot, k) => {
        const [x, y] = anchorOf(knot);
        if (x >= left && x <= right && y >= top && y <= bottom) inside.push({ sub: s, knot: k });
      }));
      picked = current.add ? current.before.concat(inside.filter((item) => !current.before.some((one) => one.sub === item.sub && one.knot === item.knot))) : inside;
      show();
      return;
    }
    if (current.mode === "place") {
      // Space moves the point itself, as in Photoshop; Alt leaves the handle behind where it is
      if (spaceHeld) current.origin = [current.origin[0] + point[0] - current.prev[0], current.origin[1] + point[1] - current.prev[1]];
      else {
        const to = aimed(current.origin, point, event.shiftKey);
        current.d = [to[0] - current.origin[0], to[1] - current.origin[1]];
      }
      current.prev = point;
      const { origin, d } = current;
      if (!event.altKey || !current.behind) current.behind = [-d[0], -d[1]];
      const knot = knotOf([origin[0] + current.behind[0], origin[1] + current.behind[1]], origin, [origin[0] + d[0], origin[1] + d[1]], !event.altKey);
      const sub = subsOf(doc)[current.sub];
      if (!sub || !sub.knots[current.knot]) return;
      commit(withSub(subsOf(doc), current.sub, withKnot(sub, current.knot, knot)), current.knot ? "New Anchor Point" : subsOf(doc).length > 1 ? "New Anchor Point" : "New Work Path", current.token);
      return;
    }
    const from = current.from;
    if (current.mode === "close") {
      // The handle that comes into the point the path closes on; the one that leaves it stays
      // in line with it, as long as it was, unless Alt is held
      const was = from[current.sub].knots[current.knot];
      const anchor = anchorOf(was);
      const to = aimed(anchor, point, event.shiftKey);
      const coming = [2 * anchor[0] - to[0], 2 * anchor[1] - to[1]];
      const going = event.altKey ? goingOf(was) : facing(anchor, coming, goingOf(was));
      commit(withSub(from, current.sub, withKnot(from[current.sub], current.knot, knotOf(coming, anchor, going, !event.altKey))), "Close Path", current.token);
      return;
    }
    if (current.mode === "convert") {
      const was = from[current.sub].knots[current.knot];
      const anchor = anchorOf(was);
      const to = aimed(anchor, point, event.shiftKey);
      commit(withSub(from, current.sub, withKnot(from[current.sub], current.knot, knotOf([2 * anchor[0] - to[0], 2 * anchor[1] - to[1]], anchor, to, true))), "Convert Point", current.token);
      return;
    }
    if (current.mode === "end") {
      // The handle the path leaves its last point by, pulled again
      const flip = Boolean(drawing && drawing.sub === current.sub && drawing.flip);
      const was = from[current.sub].knots[current.knot];
      const anchor = anchorOf(was);
      const to = aimed(anchor, point, event.shiftKey);
      const behind = flip ? goingOf(was) : comingOf(was);
      const kept = was.linked && !event.altKey ? facing(anchor, to, behind) : behind;
      const knot = flip ? knotOf(to, anchor, kept, was.linked && !event.altKey) : knotOf(kept, anchor, to, was.linked && !event.altKey);
      commit(withSub(from, current.sub, withKnot(from[current.sub], current.knot, knot)), "Convert Point", current.token);
      return;
    }
    if (current.mode === "handle") {
      const was = from[current.sub].knots[current.knot];
      const anchor = anchorOf(was);
      const to = aimed(anchor, point, event.shiftKey);
      const breaks = current.breaks || event.altKey || !was.linked;
      const other = current.side === "in" ? goingOf(was) : comingOf(was);
      const kept = breaks ? other : facing(anchor, to, other);
      const knot = current.side === "in" ? knotOf(to, anchor, kept, !breaks) : knotOf(kept, anchor, to, !breaks);
      commit(withSub(from, current.sub, withKnot(from[current.sub], current.knot, knot)), "Drag Control Point", current.token);
      return;
    }
    if (current.mode === "knots") {
      const to = aimed(current.start, point, event.shiftKey);
      const dx = to[0] - current.start[0];
      const dy = to[1] - current.start[1];
      commit(withKnots(from, (knot, s, k) => (isPicked(s, k) ? movedKnot(knot, dx, dy) : knot)), current.name, current.token);
      return;
    }
    if (current.mode === "bend") {
      // The curve goes through the pointer where it was taken: its two handles share the way
      const sub = from[current.sub];
      const n = sub.knots.length;
      const t = Math.max(0.05, Math.min(0.95, current.t));
      const k = 1 / (3 * (1 - t) * t * ((1 - t) * (1 - t) + t * t));
      const dx = point[0] - current.start[0];
      const dy = point[1] - current.start[1];
      const a = sub.knots[current.index];
      const b = sub.knots[(current.index + 1) % n];
      const going = [goingOf(a)[0] + dx * k * (1 - t), goingOf(a)[1] + dy * k * (1 - t)];
      const coming = [comingOf(b)[0] + dx * k * t, comingOf(b)[1] + dy * k * t];
      const knots = sub.knots.slice();
      knots[current.index] = knotOf(a.linked ? facing(anchorOf(a), going, comingOf(a)) : comingOf(a), anchorOf(a), going, a.linked);
      knots[(current.index + 1) % n] = knotOf(coming, anchorOf(b), b.linked ? facing(anchorOf(b), coming, goingOf(b)) : goingOf(b), b.linked);
      commit(withSub(from, current.sub, Object.assign({}, sub, { knots })), "Drag Segment", current.token);
    }
  };

  const up = (current, event, point, cancelled) => {
    pressed = null;
    const doc = app.doc;
    if (current.mode === "box") {
      boxed = null;
      // Cmd + click beside the path: it stops there, as in Photoshop, and lets go of its points
      if (!current.moved && !cancelled) {
        drawing = null;
        resumable = null;
        if (!current.add) picked = [];
      }
    } else if (current.tapDeletes && !current.moved && !cancelled && doc) {
      // A finger's tap on a point, which a drag would have moved
      const subs = subsOf(doc);
      const paths = removeKnot(subs, current.tapDeletes.sub, current.tapDeletes.knot);
      if (drawing && paths.length < subs.length) drawing = current.tapDeletes.sub === drawing.sub ? null : Object.assign(drawing, { sub: drawing.sub - (current.tapDeletes.sub < drawing.sub ? 1 : 0) });
      picked = [];
      commit(paths, "Delete Anchor Point", current.token);
    } else if (!current.moved && !cancelled && doc && (current.mode === "convert" || (current.mode === "end" && !current.resumed))) {
      // A click: the point is a corner again, or the path leaves its last point straight
      const subs = subsOf(doc);
      const was = subs[current.sub] && subs[current.sub].knots[current.knot];
      if (was) {
        const anchor = anchorOf(was);
        const flip = Boolean(drawing && drawing.sub === current.sub && drawing.flip);
        const knot = current.mode === "convert" ? knotAt(anchor) : flip ? knotOf(anchor, anchor, goingOf(was), false) : knotOf(comingOf(was), anchor, anchor, false);
        if (knot.points.some((value, i) => value !== was.points[i])) commit(withSub(subs, current.sub, withKnot(subs[current.sub], current.knot, knot)), "Convert Point", current.token);
      }
    }
    if (event && event.clientX !== undefined && !cancelled) pointer = { point, shift: event.shiftKey };
    refresh();
    hoverAgain(event || {});
  };

  /* ------------------------------ what a path becomes ------------------------------ */

  const hasPath = () => Boolean(pathOf());
  // Make Selection (Cmd+Enter; with Shift it adds to the selection, with Alt it takes away,
  // with both it keeps what the two share, as in Photoshop)
  const makeSelection = (mode = "new") => {
    if (!hasPath()) return false;
    const made = ops.selectPath(mode, { antiAlias: settings.antiAlias, feather: settings.feather });
    if (!made) {
      toast("This path encloses nothing yet: give it at least three points, or a curve.", true);
      return false;
    }
    rest();
    refresh();
    return true;
  };
  const fillPath = () => {
    if (!hasPath() || App().pixelsOnly()) return false;
    const { r, g, b } = app.fg;
    if (!ops.fillPath({ red: r, green: g, blue: b }, { antiAlias: settings.antiAlias, feather: settings.feather })) {
      toast("This path encloses nothing yet: give it at least three points, or a curve.", true);
      return false;
    }
    rest();
    refresh();
    return true;
  };
  // Stroke Path: the Brush goes along the path, as it is set (its size, its hardness, its
  // colour, or the brush chosen in the library), on what the Brush would paint on
  const strokePath = () => {
    const doc = app.doc;
    if (!hasPath()) return false;
    const target = App().paintTarget();
    if (!target) return false;
    const before = doc.historyIndex;
    const tolerance = 0.1;
    let drawn = false;
    subsOf(doc).forEach((sub) => {
      if (!sub.knots.length) return;
      const points = [anchorOf(sub.knots[0])];
      const count = segmentsOf(sub);
      for (let i = 0; i < count; i++) flatten(curveOf(sub, i), tolerance, points);
      if (!ops.beginStroke(target.id, App().strokeFields("brush"))) return;
      points.forEach(([x, y]) => ops.extendStroke(x, y));
      ops.endStroke();
      drawn = true;
    });
    if (!drawn) return false;
    ops.joinSteps(before, "Stroke Path");
    rest();
    refresh();
    return true;
  };
  // Layer > Vector Mask > Current Path
  const canMask = () => hasPath() && Boolean(App()) && App().actions.activeLayers().some((layer) => ops.canHaveMask(layer) && !layer.vectorMask);
  const maskFromPath = () => {
    if (!hasPath()) return false;
    if (!ops.addVectorMask("path")) {
      toast("Select a layer with no vector mask first: the path becomes its vector mask.", true);
      return false;
    }
    rest();
    refresh();
    return true;
  };
  const deletePath = () => {
    if (!hasPath()) return false;
    drawing = null;
    resumable = null;
    picked = [];
    commit([], "Delete Path");
    return true;
  };
  // The paths Photoshop saved in the file under a name: one of them can become the work path
  const savedPaths = () => {
    const doc = app.doc;
    const resources = doc && doc.psd && doc.psd.source && doc.psd.source.imageResources;
    const saved = resources && Array.isArray(resources.savedPaths) ? resources.savedPaths : [];
    return saved.filter((path) => path && Array.isArray(path.paths) && path.paths.some((sub) => sub && Array.isArray(sub.knots) && sub.knots.length));
  };
  const loadSaved = (saved) => {
    drawing = null;
    resumable = null;
    picked = [];
    wake();
    commit(saved.paths.filter((sub) => sub && Array.isArray(sub.knots) && sub.knots.length).map((sub) => Object.assign({}, sub, { knots: sub.knots.map((knot) => Object.assign({}, knot, { points: knot.points.slice() })) })), "Load Path");
  };

  /* ------------------------------ the options bar ------------------------------ */

  const keysText = (text) => (IS_MAC ? text : text.replace(/Cmd/g, "Ctrl"));
  const button = (label, title, run, main) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = main ? "btn btn--small btn--main" : "btn btn--small";
    el.textContent = T(label);
    if (title) el.title = keysText(T(title));
    el.addEventListener("click", (event) => {
      run(event);
      el.blur();
    });
    return el;
  };
  const options = (bar) => {
    optionsKey = optionsSignature();
    const there = hasPath();
    const saved = savedPaths();
    if (saved.length) {
      // Photoshop's Paths panel, as a list: its named paths, each a click away
      const pick = document.createElement("select");
      const first = document.createElement("option");
      first.value = "";
      first.textContent = T("Work Path");
      pick.appendChild(first);
      saved.forEach((path, index) => {
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = path.name || `${T("Path")} ${index + 1}`;
        pick.appendChild(option);
      });
      pick.title = T("The paths saved in this file by Photoshop: choose one to make it the work path.");
      pick.addEventListener("change", () => {
        const chosen = saved[Number(pick.value)];
        pick.value = "";
        pick.blur();
        if (chosen) loadSaved(chosen);
      });
      bar.appendChild(pick);
    }
    if (!there) {
      const hint = document.createElement("span");
      hint.className = "obar__hint";
      hint.textContent = T("Click to place points, drag for a curve. Click the first point to close the path.");
      bar.appendChild(hint);
    } else {
      const group = document.createElement("span");
      group.className = "obar__group";
      group.style.gap = "4px";
      if (drawing) {
        group.appendChild(button("Done", "End the path where it is (Enter or Esc). It stays open.", () => {
          drawing = null;
          refresh();
        }));
      }
      group.appendChild(button("Selection", "Make Selection (Cmd+Enter). With Shift: add to the selection. With Alt: subtract from it.", (event) => makeSelection(event.shiftKey && event.altKey ? "intersect" : event.shiftKey ? "add" : event.altKey ? "subtract" : "new"), true));
      group.appendChild(button("Fill", "Fill Path with the foreground colour, on the active pixel layer.", fillPath));
      group.appendChild(button("Stroke", "Stroke Path with the Brush as it is set: its size, its hardness and the foreground colour.", strokePath));
      const mask = button("Mask", "The path becomes the vector mask of the active layer (Layer > Vector Mask > Current Path).", maskFromPath);
      mask.disabled = !canMask();
      group.appendChild(mask);
      bar.appendChild(group);
    }
    bar.appendChild(App().scrubbed(T("Feather"), App().numberInput(settings.feather, 0, 250, (value) => {
      settings.feather = Math.max(0, Math.min(250, Number(value) || 0));
      keep();
    })));
    bar.appendChild(App().checkbox(T("Anti-alias"), settings.antiAlias, (on) => {
      settings.antiAlias = on;
      keep();
      document.activeElement.blur();
    }));
    const auto = App().checkbox(T("Auto Add/Delete"), settings.auto, (on) => {
      settings.auto = on;
      keep();
      document.activeElement.blur();
    });
    auto.title = T("A click on a segment adds a point, a click on a point removes it. Shift: not this time.");
    bar.appendChild(auto);
    // The Brush's size, for Stroke Path, without leaving the Pen
    bar.appendChild(App().scrubbed(T("Brush Size"), App().numberInput(app.brush.size, 1, 2000, (value) => {
      app.brush.size = Math.max(1, Math.min(2000, Math.round(Number(value) || 1)));
    })));
    if (there) bar.appendChild(button("Delete Path", "", deletePath));
  };

  // A right click with the Pen: what the path can become, as on a path in Photoshop
  const contextMenu = (event) => {
    if (!hasPath() || !App()) return false;
    const at = hitAt(event, false);
    const subs = subsOf();
    const items = ["Make Selection", { label: "Add to Selection", enabled: () => Boolean(app.doc.state.selection), action: () => makeSelection("add") }, { label: "Subtract from Selection", enabled: () => Boolean(app.doc.state.selection), action: () => makeSelection("subtract") }, null, "Fill Path", "Stroke Path", { label: "Vector Mask from Path", enabled: canMask, action: maskFromPath }, null];
    if (at && at.kind === "knot") {
      items.push({ label: "Delete Anchor Point", action: () => {
        wake();
        const paths = removeKnot(subs, at.sub, at.knot);
        drawing = null;
        picked = [];
        commit(paths, "Delete Anchor Point");
      } });
    }
    const open = subs.findIndex((sub) => sub.open && sub.knots.length > 2);
    if (open >= 0) {
      items.push({ label: "Close Path", action: () => {
        wake();
        drawing = null;
        commit(subsOf().map((sub) => (sub.open && sub.knots.length > 2 ? Object.assign({}, sub, { open: false }) : sub)), "Close Path");
      } });
    }
    items.push("Delete Path");
    App().actions.openContextMenu(event.clientX, event.clientY, items);
    return true;
  };

  /* ------------------------------ the rest of the app ------------------------------ */

  const toolChosen = (tool) => {
    if (tool !== "pen") {
      drawing = null;
      resumable = null;
      pointer = null;
      pressed = null;
      boxed = null;
    } else {
      const stage = $("stage");
      if (stage) stage.style.cursor = cursorFor({ mode: hasPath() && !isResting() ? "place" : "start" });
    }
    show();
  };

  PS.on((type) => {
    if (type === "history" || type === "document") {
      if (mine) return;
      settle();
      if (app.tool === "pen") refresh();
      return;
    }
    if (app.tool !== "pen" && !(group && group.firstChild)) return;
    // The view moves the path with the page at once; the rest once a frame is enough
    if (type === "view") show();
    else if (type === "render") showSoon();
  });

  // The keys of a path, before the app sees them: Enter and Esc end the path being drawn,
  // Backspace removes its last point (or the points picked, or the path), the arrows move the
  // points picked, and Enter with Cmd and Shift or Alt adds the path to the selection or takes
  // it away from it. Cmd+Enter alone is Edit > Path > Make Selection's.
  const nudge = (dx, dy) => {
    commit(withKnots(subsOf(), (knot, s, k) => (isPicked(s, k) ? movedKnot(knot, dx, dy) : knot)), "Nudge Anchor Point", "pen-nudge");
  };
  window.addEventListener("keydown", (event) => {
    if (event.code === "Space" && pressed && pressed.mode === "place") {
      spaceHeld = true;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (app.tool !== "pen" || !app.doc || !App()) return;
    if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable]")) return;
    if (App().isEditing() || document.querySelector(".modal[open], dialog[open], .menu.is-open, .menu__list--context")) return;
    const cmd = event.metaKey || event.ctrlKey;
    const path = pathOf();
    const live = Boolean(path) && !isResting();
    let done = false;
    if (event.key === "Enter" && cmd && (event.shiftKey || event.altKey) && path) {
      makeSelection(event.shiftKey && event.altKey ? "intersect" : event.shiftKey ? "add" : "subtract");
      done = true;
    } else if ((event.key === "Enter" || event.key === "Escape") && !cmd && !event.altKey && live) {
      if (drawing) drawing = null;
      else if (picked.length && event.key === "Escape") picked = [];
      else rest();
      done = true;
    } else if ((event.key === "Backspace" || event.key === "Delete") && !cmd && !event.altKey && !event.shiftKey && live && !pressed) {
      const subs = subsOf();
      if (drawing && drawnSub()) {
        // The last point goes, and the path goes on from the one before
        const at = endIndex();
        const paths = removeKnot(subs, drawing.sub, at);
        if (paths.length < subs.length) drawing = null;
        picked = [];
        commit(paths, "Delete Anchor Point");
      } else if (picked.length) {
        // From the last to the first, so that each keeps its place until its turn
        let paths = subs;
        const gone = new Set();
        picked.slice().sort((a, b) => b.sub - a.sub || b.knot - a.knot).forEach((item) => {
          if (gone.has(item.sub)) return;
          const before = paths.length;
          paths = removeKnot(paths, item.sub, item.knot);
          if (paths.length < before) gone.add(item.sub);
        });
        picked = [];
        commit(paths, "Delete Anchor Point");
      } else deletePath();
      done = true;
    } else if (/^Arrow/.test(event.key) && !cmd && !event.altKey && live && picked.length) {
      const step = event.shiftKey ? 10 : 1;
      nudge(event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0, event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0);
      done = true;
    }
    if (done) {
      event.preventDefault();
      event.stopPropagation();
      // The panel hears of the whole key, as for the app's own shortcuts: Shift and Cmd alone
      // are one of TypeR's
      PS.setKeys({ meta: event.metaKey, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, key: PS.keyName(event) });
      refresh();
      hoverAgain(event);
    } else if (event.key === "Shift" || event.key === "Alt" || event.key === "Meta" || event.key === "Control") hoverAgain(event);
  }, true);
  window.addEventListener("keyup", (event) => {
    if (event.code === "Space") spaceHeld = false;
    if (app.tool === "pen" && (event.key === "Shift" || event.key === "Alt" || event.key === "Meta" || event.key === "Control")) hoverAgain(event);
  }, true);

  window.TypeRPen = {
    down,
    move,
    up,
    hover,
    options,
    toolChosen,
    contextMenu,
    // The menus' commands
    hasPath,
    makeSelection,
    fillPath,
    strokePath,
    canMask,
    maskFromPath,
    deletePath,
    // For tests: what is going on
    state: () => ({ drawing: drawing ? { sub: drawing.sub, flip: drawing.flip } : null, picked: picked.slice(), resting: isResting() }),
  };
})();
