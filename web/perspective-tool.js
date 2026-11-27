// The Perspective tool (A): a drag over a surface drawn on the page, a board, a wall, a sign,
// makes it a perspective zone. perspective.js reads the surface there; the zone keeps it (see
// surfacesOf in photoshop.js), and every text in the zone lies on it from then on, as what was
// written there: the ones already there, the ones typed, pasted or moved there later. They stay
// texts. This is the tool around the zones: the drag that draws one, its corners, which set the
// perspective by hand where the page says too little, its sides, the texts' own frames, and
// the switch that takes a text off its zone.
(function () {
  "use strict";

  const PS = window.TypeRPhotoshop;
  const Perspective = window.TypeRPerspective;
  if (!PS || !Perspective) return;
  const { app, ops } = PS;
  const App = () => window.TypeRApp;
  const T = (text) => (window.TypeRApp ? window.TypeRApp.T(text) : text);
  const SVGNS = "http://www.w3.org/2000/svg";
  const $ = (id) => document.getElementById(id);
  const touch = () => Boolean(window.TypeRShell && window.TypeRShell.touch);
  const toast = (text, bad) => { if (App()) App().toast(T(text), bad); };

  // What was just done, for the tool's guide (perspective-guide.js): { mode, … }
  const listeners = new Set();
  const tell = (detail) => listeners.forEach((listener) => {
    try {
      listener(detail);
    } catch (error) {
      console.warn("TypeR Perspective: a listener failed", error);
    }
  });
  const onGesture = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  /* ------------------------------ the zones ------------------------------ */

  // The zone whose handles show: { doc, id }
  let chosen = null;
  // The rectangle being dragged: { from, to }, on the page
  let drawing = null;

  // How far the eye is taken to be: about a page's width, as a panel is drawn
  const focalOf = (doc) => 0.8 * Math.min(doc.width, 0.7 * doc.height);
  const zones = () => (app.doc ? PS.surfacesOf(app.doc) : []);
  const chosenZone = () => (chosen && chosen.doc === app.doc ? zones().find((zone) => zone.id === chosen.id) || null : null);
  const choose = (zone) => { chosen = zone ? { doc: app.doc, id: zone.id } : null; };
  const selectedTexts = () => (App() ? App().activeTexts() : []);
  // The one text whose frame shows: selected alone, and in perspective
  const framed = () => {
    const texts = app.doc && app.doc.state.activeIds.length === 1 ? selectedTexts() : [];
    return texts.length === 1 && texts[0].warp ? texts[0] : null;
  };
  const zoneOf = (layer) => PS.surfaceAt(app.doc, PS.placeOnSurface(layer, app.doc));
  const follows = (layer) => Boolean(layer.warp && layer.warp.auto);
  // Which way a text's lines run, and whether they run down the page (vertical writing)
  const leanOf = (layer) => (layer ? PS.turnOf(layer) : 0);
  const verticalOf = (layer) => Boolean(layer && PS.verticalOf(layer.params.layerText));

  const inQuad = (corners, [x, y]) => {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const [ax, ay] = corners[i];
      const [bx, by] = corners[(i + 1) % 4];
      const side = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
      if (side && sign && Math.sign(side) !== sign) return false;
      if (side) sign = Math.sign(side);
    }
    return true;
  };
  const middleOf = (corners) => Perspective.onQuad(Perspective.squareTo(corners), 0.5, 0.5) || corners[0];
  // The rectangle of the page a zone was drawn on: through the middles of its sides
  const rectOf = (corners) => {
    const m = Perspective.squareTo(corners);
    const at = (u, v) => Perspective.onQuad(m, u, v) || corners[0];
    const [top, right, bottom, left] = [at(0.5, 0), at(1, 0.5), at(0.5, 1), at(0, 0.5)];
    const xs = [left[0], right[0], top[0], bottom[0]];
    const ys = [left[1], right[1], top[1], bottom[1]];
    return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
  };
  const boundsOf = (corners) => ({ left: Math.min(...corners.map((c) => c[0])), top: Math.min(...corners.map((c) => c[1])), right: Math.max(...corners.map((c) => c[0])), bottom: Math.max(...corners.map((c) => c[1])) });

  // The surface a rectangle of the page shows: { plane: { across, down, lean }, found }, or
  // null. Read on the page as it was drawn first, where the writing to replace still is, then
  // as it shows. `layer`: a text of the zone, which says how the writing runs there.
  const read = (rect, layer) => {
    const doc = app.doc;
    const grey = doc && ops.surfaceGrey(rect);
    if (!grey || grey.width < 24 || grey.height < 24) return null;
    const lean = leanOf(layer);
    const vertical = verticalOf(layer);
    const worth = (result) => (result ? (result.found.across ? 2 : 0) + (result.found.down ? 1 : 0) : -1);
    const detect = (options) => {
      let result = grey.under ? Perspective.detect(grey.under, grey.width, grey.height, options) : null;
      if (worth(result) < 3) {
        const shown = Perspective.detect(grey.shown, grey.width, grey.height, options);
        if (worth(shown) > worth(result)) result = shown;
      }
      return result;
    };
    // Vertical writing runs down its columns: they are what its rows are elsewhere
    const rows = vertical ? lean + Math.PI / 2 : lean;
    const first = detect({ lean: rows });
    let [along, over] = first ? [first.across, first.down] : [null, null];
    let found = first ? [first.found.across, first.found.down] : [false, false];
    // What rows didn't show, columns may: writing that runs the other way, as on a manga page
    if (!found[0] || !found[1]) {
      const second = detect({ lean: rows + Math.PI / 2 });
      const apart = (a, b) => {
        const [cx, cy] = [grey.width / 2, grey.height / 2];
        const turn = Math.abs(Math.atan2((a[0] - cx * a[2]) * (b[1] - cy * b[2]) - (a[1] - cy * a[2]) * (b[0] - cx * b[2]), (a[0] - cx * a[2]) * (b[0] - cx * b[2]) + (a[1] - cy * a[2]) * (b[1] - cy * b[2])));
        return Math.min(turn, Math.PI - turn) > 0.45;
      };
      if (second) {
        if (!along) [along, over] = [second.down, second.across];
        if (!found[1] && second.found.across && apart(along, second.across)) {
          over = second.across;
          found[1] = true;
        }
        if (!found[0] && second.found.down && apart(second.down, over)) {
          along = second.down;
          found[0] = true;
        }
      }
    }
    if (!along) return null;
    const onPage = (v) => [v[0] + grey.left * v[2], v[1] + grey.top * v[2], v[2]];
    if (vertical) {
      [along, over] = [over, along];
      found = [found[1], found[0]];
    }
    return { plane: { across: onPage(along), down: onPage(over), lean }, found: { across: found[0], down: found[1] } };
  };

  // A surface that faces the reader, its lines level and its uprights straight: what is
  // written on it is as it is typed
  const facing = (plane) => {
    const flat = (v, angle) => {
      const length = Math.hypot(v[0], v[1]) || 1;
      const turn = Math.abs(Math.atan2(v[1] * Math.cos(angle) - v[0] * Math.sin(angle), v[0] * Math.cos(angle) + v[1] * Math.sin(angle)));
      // Parallel lines, to a point further than a hundred pages away
      return Math.min(turn, Math.PI - turn) < 0.004 && Math.abs(v[2] / length) < 1e-6;
    };
    return flat(plane.across, plane.lean) && flat(plane.down, plane.lean + Math.PI / 2);
  };
  const NOTHING = "No perspective found here: drag the corners of the zone onto the surface.";
  // The zone a rectangle of the page shows, as its corners and what was found of it. With
  // nothing found, the rectangle itself: its corners are then dragged onto the surface.
  const zoneIn = (rect, layer, reach = rect) => {
    const here = read(reach, layer);
    const corners = here && !facing(here.plane) ? Perspective.zoneOn(here.plane, rect, here.plane.lean) : null;
    if (corners) return { corners, found: here.found };
    return { corners: [[rect.left, rect.top], [rect.right, rect.top], [rect.right, rect.bottom], [rect.left, rect.bottom]], found: { across: false, down: false } };
  };
  // A zone drawn: it takes the place of the one it was drawn over
  const makeZone = (rect) => {
    const doc = app.doc;
    const centre = [(rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2];
    const within = ([x, y]) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    const texts = selectedTexts().filter((layer) => within(PS.placeOnSurface(layer, doc)));
    const { corners, found } = zoneIn(rect, texts.length === 1 ? texts[0] : null);
    const replaced = zones().filter((zone) => inQuad(zone.corners, centre) || within(middleOf(zone.corners))).map((zone) => zone.id);
    const id = ops.addSurface({ corners, unit: Perspective.unitOf(corners, focalOf(doc), 1), found }, replaced);
    chosen = { doc, id };
    // The zone is what is selected now: its handles show
    if (doc.state.activeIds.length) ops.clearActiveLayers();
    if (!found.across && !found.down) toast(NOTHING);
    tell({ mode: "zone", found });
    return id;
  };
  // The page read again where the zone is: what dragging its corners made of it is undone
  const again = () => {
    const zone = chosenZone();
    if (!zone) return;
    const doc = app.doc;
    const { corners, found } = zoneIn(rectOf(zone.corners), null, boundsOf(zone.corners));
    if (!found.across && !found.down) {
      toast(NOTHING, true);
      return;
    }
    ops.setSurface(zone.id, { corners, unit: Perspective.unitOf(corners, focalOf(doc), Perspective.sizeOn(zone.corners, zone.unit, focalOf(doc))), found });
  };
  // The zone with no perspective: the rectangle it was drawn on, its corners to drag onto the
  // surface by hand where what was found is wrong. Its texts stay as large in its middle.
  const flatCorners = (zone) => {
    const r = rectOf(zone.corners);
    return [[r.left, r.top], [r.right, r.top], [r.right, r.bottom], [r.left, r.bottom]];
  };
  const flat = (zone) => flatCorners(zone).every(([x, y], i) => Math.hypot(x - zone.corners[i][0], y - zone.corners[i][1]) < 0.5);
  const reset = () => {
    const zone = chosenZone();
    if (!zone || flat(zone)) return;
    const focal = focalOf(app.doc);
    const corners = flatCorners(zone);
    ops.setSurface(zone.id, { corners, unit: Perspective.unitOf(corners, focal, Perspective.sizeOn(zone.corners, zone.unit, focal)), found: { across: false, down: false } });
  };
  // These texts follow their zone, or stop: all of them on when one of them doesn't
  const toggleFollow = (texts, on = !texts.filter(zoneOf).every(follows)) => {
    if (!texts.some(zoneOf)) {
      toast("This text is in no perspective zone: drag over the surface it sits on.");
      return;
    }
    if (ops.setSurfaceFollow(texts.map((layer) => layer.id), on)) tell({ mode: "follow", on });
  };
  const removeZone = (zone) => {
    ops.removeSurface(zone.id);
    chosen = null;
    tell({ mode: "remove" });
  };

  /* ------------------------------ what shows ------------------------------ */

  let group = null;
  const overlay = () => {
    if (group && group.isConnected) return group;
    const over = $("over");
    if (!over) return null;
    group = document.createElementNS(SVGNS, "g");
    group.id = "over-perspective";
    over.appendChild(group);
    return group;
  };
  const svg = (tag, attributes, parent) => {
    const el = document.createElementNS(SVGNS, tag);
    Object.keys(attributes).forEach((key) => el.setAttribute(key, attributes[key]));
    parent.appendChild(el);
    return el;
  };
  const spot = ([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`;
  // A zone's surface as a grid: lines evenly spread on the surface, about eight along its
  // longer side, so that they close up where it goes away
  const gridPath = (zone, at) => {
    const cell = Math.max(zone.unit[0] / (zone.wide || 1), zone.unit[1]) / 8;
    const count = (length) => Math.max(2, Math.min(24, Math.round(length / cell)));
    const across = count(zone.unit[0] / (zone.wide || 1));
    const down = count(zone.unit[1]);
    let d = "";
    const line = (a, b) => { d += `M${spot(a).replace(",", " ")}L${spot(b).replace(",", " ")}`; };
    for (let i = 1; i < across; i++) line(at(i / across, 0), at(i / across, 1));
    for (let i = 1; i < down; i++) line(at(0, i / down), at(1, i / down));
    return d;
  };
  const TEXT_HANDLES = [["nw", 0, 0], ["n", 0.5, 0], ["ne", 1, 0], ["e", 1, 0.5], ["se", 1, 1], ["s", 0.5, 1], ["sw", 0, 1], ["w", 0, 0.5]];
  const ZONE_CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const ZONE_SIDES = [["n", 0.5, 0], ["e", 1, 0.5], ["s", 0.5, 1], ["w", 0, 0.5]];
  let handles = [];
  // What the guide points at, a ring around it: { kind, id, at }. "points": the points `at` of
  // the page; "text": the text `id`; "textCorner": a corner of its frame; "corner", "side": a
  // handle of the zone, or the points `at` while its handles don't show
  let mark = null;
  const setMark = (value) => {
    mark = value || null;
    drawOverlay();
  };
  const drawMark = (g) => {
    if (!mark || !app.doc || app.tool !== "perspective" || !App()) return;
    const doc = app.doc;
    const layer = mark.id && doc.state.layers.find((item) => item.id === mark.id);
    const textMiddle = () => (layer ? [App().toScreen(...PS.placeOnSurface(layer, doc))] : []);
    const points = () => (mark.at || []).map(([x, y]) => App().toScreen(x, y));
    const handle = (test) => handles.find(test);
    let spots = [];
    if (mark.kind === "points") spots = points();
    else if (mark.kind === "text") spots = textMiddle();
    else if (mark.kind === "textCorner") {
      const corner = layer && framed() === layer && handle((item) => item.mode === "se");
      spots = corner ? [[corner.x, corner.y]] : textMiddle();
    } else if (mark.kind === "corner" || mark.kind === "side") {
      const found = mark.kind === "corner" ? handle((item) => item.mode === "corner" && item.index === 2) : handle((item) => item.mode === "side" && item.side === "e");
      spots = found ? [[found.x, found.y]] : points();
    }
    spots.forEach(([x, y]) => svg("circle", { cx: x, cy: y, r: 14, class: "sfx-mark" }, g));
  };
  const drawOverlay = () => {
    const g = overlay();
    if (!g) return;
    drawZones(g);
    drawMark(g);
  };
  const drawZones = (g) => {
    g.textContent = "";
    handles = [];
    const doc = app.doc;
    if (!doc || app.tool !== "perspective" || !App()) return;
    const screen = (x, y) => App().toScreen(x, y);
    const size = touch() ? 13 : 7;
    const square = (x, y) => svg("rect", { class: "handle", x: Math.round(x - size / 2) + 0.5, y: Math.round(y - size / 2) + 0.5, width: size, height: size }, g);
    const layer = framed();
    const current = chosenZone();
    zones().forEach((zone) => {
      const m = Perspective.squareTo(zone.corners);
      const at = (u, v) => {
        const p = Perspective.onQuad(m, u, v) || zone.corners[0];
        return screen(p[0], p[1]);
      };
      svg("path", { class: "persp-grid", d: gridPath(zone, at) }, g);
      svg("polygon", { class: zone === current ? "persp-zone is-chosen" : "persp-zone", points: ZONE_CORNERS.map(([u, v]) => spot(at(u, v))).join(" ") }, g);
      if (zone !== current || layer || drawing) return;
      // Its corners set the perspective, its sides how far the zone goes
      ZONE_SIDES.forEach(([side, u, v]) => {
        const [x, y] = at(u, v);
        svg("circle", { class: "handle handle--bend", cx: x, cy: y, r: touch() ? 8 : 4.5 }, g);
        handles.push({ mode: "side", side, x, y });
      });
      ZONE_CORNERS.forEach(([u, v], index) => {
        const [x, y] = at(u, v);
        square(x, y);
        handles.push({ mode: "corner", index, x, y });
      });
    });
    if (drawing) {
      const [x0, y0] = screen(Math.min(drawing.from[0], drawing.to[0]), Math.min(drawing.from[1], drawing.to[1]));
      const [x1, y1] = screen(Math.max(drawing.from[0], drawing.to[0]), Math.max(drawing.from[1], drawing.to[1]));
      svg("rect", { class: "persp-zone persp-zone--drawn", x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, g);
      return;
    }
    // The selected texts that are plain ones show too, by their box
    selectedTexts().filter((text) => !text.warp).forEach((text) => {
      const f = text.rotated ? PS.boxOf(text, doc) : PS.frameOf(text, doc);
      svg("polygon", { class: "warp-edge", points: [[f.left, f.top], [f.right, f.top], [f.right, f.bottom], [f.left, f.bottom]].map(([x, y]) => spot(screen(x, y))).join(" ") }, g);
    });
    if (!layer) return;
    const m = Perspective.squareTo(layer.warp.corners);
    const at = (u, v) => {
      const p = Perspective.onQuad(m, u, v) || layer.warp.corners[0];
      return screen(p[0], p[1]);
    };
    svg("polygon", { class: "warp-edge", points: ZONE_CORNERS.map(([u, v]) => spot(at(u, v))).join(" ") }, g);
    // A frame too thin on the screen keeps its corners only: the text itself can still be taken
    const [a, b, , d] = ZONE_CORNERS.map(([u, v]) => at(u, v));
    const thin = Math.min(Math.hypot(b[0] - a[0], b[1] - a[1]), Math.hypot(d[0] - a[0], d[1] - a[1])) < 4 * size;
    TEXT_HANDLES.forEach(([kind, u, v]) => {
      if (thin && (u === 0.5 || v === 0.5)) return;
      const [x, y] = at(u, v);
      square(x, y);
      handles.push({ mode: kind, x, y, u, v });
    });
  };

  /* ------------------------------ the pointer ------------------------------ */

  const stagePoint = (event) => {
    const rect = $("stage").getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  };
  // The text under a point: one in perspective by its surface, not by the box around it,
  // which a text that goes away fills only in part
  const textAt = (point) => {
    const doc = app.doc;
    const top = doc && ops.hitLayer(point[0], point[1], true);
    if (!top || top.kind !== "text") return null;
    if (!top.warp || inQuad(top.warp.corners, point)) return top;
    const byId = new Map(doc.state.layers.map((layer) => [layer.id, layer]));
    const shown = (layer) => {
      for (let item = layer; item; item = byId.get(item.group)) if (item.visible === false) return false;
      return true;
    };
    for (let i = doc.state.layers.length - 1; i >= 0; i--) {
      const layer = doc.state.layers[i];
      if (layer.kind !== "text" || layer === top || !shown(layer)) continue;
      if (layer.warp) {
        if (inQuad(layer.warp.corners, point)) return layer;
        continue;
      }
      const f = layer.rotated ? PS.boxOf(layer, doc) : PS.frameOf(layer, doc);
      if (point[0] >= f.left && point[0] <= f.right && point[1] >= f.top && point[1] <= f.bottom) return layer;
    }
    return null;
  };
  // What a press would take: a handle, of the text's frame or of the zone, or a selected text
  const hit = (event, point) => {
    const [x, y] = stagePoint(event);
    const reach = event.pointerType === "touch" ? 16 : 7;
    const handle = handles.find((item) => Math.abs(item.x - x) <= reach && Math.abs(item.y - y) <= reach);
    if (handle) return handle;
    const layer = textAt(point);
    return layer && app.doc.state.activeIds.includes(layer.id) ? { mode: "text", layer } : null;
  };
  const CURSOR = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", text: "move", corner: "move" };
  const hover = (event, point) => {
    const over = hit(event, point);
    $("stage").style.cursor = !over ? (textAt(point) ? "pointer" : "crosshair") : over.mode === "side" ? CURSOR[over.side] : CURSOR[over.mode];
  };
  let gestures = 0;
  const down = (event, point, base) => {
    if (event.button !== 0 || !app.doc) return null;
    const over = hit(event, point);
    const token = `gesture:perspective:${++gestures}`;
    if (!over) return Object.assign(base, { kind: "perspective", mode: "draw" });
    if (over.mode === "corner" || over.mode === "side") {
      const zone = chosenZone();
      return Object.assign(base, { kind: "perspective", mode: over.mode, index: over.index, side: over.side, zone, matrix: Perspective.squareTo(zone.corners), token });
    }
    if (over.mode === "text") {
      // Along its zone with Shift: the zone's own lines
      const zone = follows(over.layer) ? zoneOf(over.layer) : null;
      return Object.assign(base, { kind: "perspective", mode: "text", layerId: over.layer.id, zone, matrix: zone && Perspective.squareTo(zone.corners), applied: [0, 0], token });
    }
    const layer = framed();
    return Object.assign(base, { kind: "perspective", mode: over.mode, u: over.u, v: over.v, layer, matrix: Perspective.squareTo(layer.warp.corners), token });
  };
  // The text's frame after a drag on one of its handles, in parts of the frame it had:
  // [u0, v0, u1, v1]
  const frameAfter = (current, point, event) => {
    const from = Perspective.fromQuad(current.matrix, current.start[0], current.start[1]);
    const to = Perspective.fromQuad(current.matrix, point[0], point[1]);
    if (!from || !to) return null;
    const du = to[0] - from[0];
    const dv = to[1] - from[1];
    const { u, v } = current;
    const corner = u !== 0.5 && v !== 0.5;
    // From the opposite side, or from the middle with Alt
    const fixU = event.altKey ? 0.5 : 1 - u;
    const fixV = event.altKey ? 0.5 : 1 - v;
    let ku = u === 0.5 ? 1 : (u + du - fixU) / (u - fixU);
    let kv = v === 0.5 ? 1 : (v + dv - fixV) / (v - fixV);
    // A corner keeps the shape, unless Shift is held: as far along its diagonal as the
    // pointer went, measured on the text's own rectangle
    if (corner && !event.shiftKey) {
      const { source } = current.layer.warp;
      const x = (u - fixU) * source.width;
      const y = (v - fixV) * source.height;
      const k = ((x + du * source.width) * x + (y + dv * source.height) * y) / (x * x + y * y);
      ku = k;
      kv = k;
    }
    ku = Math.max(0.05, ku);
    kv = Math.max(0.05, kv);
    return [fixU + (0 - fixU) * ku, fixV + (0 - fixV) * kv, fixU + (1 - fixU) * ku, fixV + (1 - fixV) * kv];
  };
  // A frame well before the line its surface vanishes on
  const inFront = (m, [u0, v0, u1, v1]) => [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].every(([u, v]) => m[6] * u + m[7] * v + 1 > 0.2);
  const cornersOf = (m, [u0, v0, u1, v1]) => [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map(([u, v]) => Perspective.onQuad(m, u, v));
  // Four corners that still go round the right way, none folded in
  const sound = (corners) => corners.every((corner, i) => {
    const [ax, ay] = corner;
    const [bx, by] = corners[(i + 1) % 4];
    const [cx, cy] = corners[(i + 2) % 4];
    return (bx - ax) * (cy - by) - (by - ay) * (cx - bx) > 64;
  });
  const move = (current, event, point) => {
    const doc = app.doc;
    if (current.mode === "draw") {
      drawing = { from: current.start, to: point };
      drawOverlay();
      return;
    }
    if (current.mode === "text") {
      let to = point;
      if (event.shiftKey && current.matrix) {
        // Along the zone's lines, or straight across them
        const a = Perspective.fromQuad(current.matrix, current.start[0], current.start[1]);
        const b = Perspective.fromQuad(current.matrix, point[0], point[1]);
        const [ux, uy] = current.zone.unit;
        const held = a && b && (Math.abs(b[0] - a[0]) * ux > Math.abs(b[1] - a[1]) * uy ? Perspective.onQuad(current.matrix, b[0], a[1]) : Perspective.onQuad(current.matrix, a[0], b[1]));
        if (held) to = held;
      } else if (event.shiftKey) to = Math.abs(point[0] - current.start[0]) > Math.abs(point[1] - current.start[1]) ? [point[0], current.start[1]] : [current.start[0], point[1]];
      const wanted = [Math.round(to[0] - current.start[0]), Math.round(to[1] - current.start[1])];
      const step = [wanted[0] - current.applied[0], wanted[1] - current.applied[1]];
      if (!step[0] && !step[1]) return;
      current.applied = wanted;
      ops.moveLayers([current.layerId], step[0], step[1], current.token);
      return;
    }
    if (current.mode === "corner") {
      const { zone } = current;
      const moved = [point[0], point[1]];
      const start = zone.corners[current.index];
      if (event.shiftKey) {
        if (Math.abs(moved[0] - start[0]) > Math.abs(moved[1] - start[1])) moved[1] = start[1];
        else moved[0] = start[0];
      }
      const corners = zone.corners.map((corner, index) => (index === current.index ? moved : corner));
      if (!sound(corners)) return;
      // What is written there stays as large in the middle of the zone, and as wide for its
      // height as the zone had it
      const focal = focalOf(doc);
      const size = Perspective.sizeOn(zone.corners, zone.unit, focal);
      const unit = Perspective.unitOf(corners, focal, size);
      unit[0] *= zone.unit[0] / Perspective.unitOf(zone.corners, focal, size)[0];
      ops.setSurface(zone.id, { corners, unit }, current.token);
      return;
    }
    if (current.mode === "side") {
      // A side slides along the surface: the zone goes further, in the same perspective
      const { zone, matrix } = current;
      const from = Perspective.fromQuad(matrix, current.start[0], current.start[1]);
      const to = Perspective.fromQuad(matrix, point[0], point[1]);
      if (!from || !to) return;
      const frame = [0, 0, 1, 1];
      if (current.side === "w") frame[0] = Math.min(0.95, to[0] - from[0]);
      if (current.side === "n") frame[1] = Math.min(0.95, to[1] - from[1]);
      if (current.side === "e") frame[2] = Math.max(0.05, 1 + to[0] - from[0]);
      if (current.side === "s") frame[3] = Math.max(0.05, 1 + to[1] - from[1]);
      const corners = cornersOf(matrix, frame);
      if (!inFront(matrix, frame) || !corners.every(Boolean) || !sound(corners)) return;
      ops.setSurface(zone.id, { corners, unit: [zone.unit[0] * (frame[2] - frame[0]), zone.unit[1] * (frame[3] - frame[1])] }, current.token);
      return;
    }
    // A handle of the text's own frame: larger, smaller or stretched, on its surface
    const frame = frameAfter(current, point, event);
    if (!frame || !inFront(current.matrix, frame)) return;
    const corners = cornersOf(current.matrix, frame);
    if (!corners.every(Boolean)) return;
    const { warp } = current.layer;
    const ku = frame[2] - frame[0];
    const kv = frame[3] - frame[1];
    const next = Object.assign({}, warp, { corners, bendTop: [warp.bendTop[0] * ku, warp.bendTop[1] * kv], bendBottom: [warp.bendBottom[0] * ku, warp.bendBottom[1] * kv] });
    if (warp.auto) next.auto = [warp.auto[0] * ku, warp.auto[1] * kv];
    ops.setTextWarp(current.layer, next, current.token);
  };
  const up = (current, event, point, cancelled) => {
    const doc = app.doc;
    if (current.mode === "draw") {
      const drawn = drawing;
      drawing = null;
      if (!cancelled && drawn && current.moved && Math.abs(drawn.to[0] - drawn.from[0]) >= 24 && Math.abs(drawn.to[1] - drawn.from[1]) >= 24) {
        makeZone({ left: Math.min(drawn.from[0], drawn.to[0]), top: Math.min(drawn.from[1], drawn.to[1]), right: Math.max(drawn.from[0], drawn.to[0]), bottom: Math.max(drawn.from[1], drawn.to[1]) });
      } else if (!cancelled && !current.moved) {
        // A click: the text there, else the zone there
        const layer = textAt(point);
        if (layer) {
          if (!(doc.state.activeIds.length === 1 && doc.state.activeIds[0] === layer.id)) ops.selectLayer(layer.id);
          if (event.altKey) toggleFollow([layer]);
          tell({ mode: "pick", id: layer.id });
        } else {
          choose(PS.surfaceAt(doc, point));
          if (doc.state.activeIds.length) ops.clearActiveLayers();
          tell({ mode: "choose", zone: Boolean(chosenZone()) });
        }
      }
    } else if (current.mode === "text" && !current.moved && !cancelled && event.altKey) {
      const layer = doc.state.layers.find((item) => item.id === current.layerId);
      if (layer) toggleFollow([layer]);
    } else if (current.moved && !cancelled) {
      // A text slid on its zone, a corner or a side of the zone, a handle of the text's frame
      tell(current.mode === "text" || current.mode === "corner" || current.mode === "side" ? { mode: current.mode, shift: event.shiftKey } : { mode: "frame", handle: current.mode, alt: event.altKey });
    }
    drawOverlay();
    if (App()) App().renderOptions();
  };

  /* ------------------------------ the options bar ------------------------------ */

  const button = (label, run) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "btn btn--small";
    el.textContent = T(label);
    el.addEventListener("click", run);
    return el;
  };
  const said = (bar, text) => {
    const hint = document.createElement("span");
    hint.style.color = "var(--muted)";
    hint.textContent = text;
    bar.appendChild(hint);
  };
  const HELP = '<circle cx="8" cy="8" r="6.5"/><path d="M6.1 6.2a2 2 0 0 1 3.9.6c0 1.3-2 2-2 2"/><path d="M8 11.3h.01"/>';
  // The ? at the end of the bar: the tool's guide
  const helpButton = (bar) => {
    const Guide = window.TypeRPerspectiveGuide;
    if (!Guide || touch()) return;
    const node = document.createElement("button");
    node.type = "button";
    node.className = "icon-btn";
    node.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${HELP}</svg>`;
    node.title = T("Auto Perspective guide: every shortcut, and a 2-minute practice");
    node.setAttribute("aria-label", node.title);
    node.addEventListener("click", () => Guide.show());
    bar.appendChild(node);
  };
  const options = (bar) => {
    barOf(bar);
    helpButton(bar);
  };
  const barOf = (bar) => {
    const texts = selectedTexts();
    const zone = chosenZone();
    if (texts.length) {
      const inZone = texts.filter(zoneOf);
      const layer = texts.length === 1 ? texts[0] : null;
      if (inZone.length) {
        const follow = App().checkbox(T("Follows the perspective zone"), inZone.every(follows), (on) => {
          toggleFollow(selectedTexts(), on);
          App().renderOptions();
        });
        follow.title = T("Off: the text stays as typed, in the zone (Enter).");
        follow.querySelector("input").indeterminate = inZone.some(follows) && !inZone.every(follows);
        bar.appendChild(follow);
      } else said(bar, T("This text is in no perspective zone: drag over the surface it sits on."));
      if (!layer || !layer.warp) return;
      const group = document.createElement("span");
      group.className = "obar__group";
      group.style.gap = "4px";
      group.appendChild(button("Adjust corners", () => {
        const current = framed();
        if (current) App().enterSurface(current);
      }));
      if (!inZone.length) {
        group.appendChild(button("Remove", () => {
          const current = framed();
          if (current) ops.removeTextWarp(current.id);
          App().renderOptions();
        }));
      }
      bar.appendChild(group);
      return;
    }
    if (!zone) {
      said(bar, zones().length ? T("Click a zone or a text to change it, or drag over another surface.") : T("Drag over a surface: the texts there take its perspective."));
      return;
    }
    // What the page showed of the surface, said as it is: the rest is the zone's corners
    said(bar, zone.found.across && zone.found.down
      ? T("Surface found: its lines and its uprights.")
      : zone.found.across
        ? T("Surface found: its lines only, the uprights stay straight.")
        : zone.found.down
          ? T("Surface found: its uprights only, the lines stay level.")
          : T("Drag the corners of the zone onto the surface."));
    // How wide the letters are on the surface: what no page says of one that goes away
    bar.appendChild(App().scrubbed(T("Width %"), App().numberInput(Math.round((zone.wide || 1) * 100), 25, 400, (value) => {
      const current = chosenZone();
      if (current) ops.setSurface(current.id, { wide: Math.max(25, Math.min(400, Number(value) || 100)) / 100 }, "perspective-wide");
    })));
    const group = document.createElement("span");
    group.className = "obar__group";
    group.style.gap = "4px";
    group.appendChild(button("Detect again", () => {
      again();
      App().renderOptions();
    }));
    const flatten = button("Reset", () => {
      reset();
      App().renderOptions();
    });
    flatten.title = T("No perspective: the zone is a plain rectangle again, its corners to drag onto the surface yourself.");
    flatten.disabled = flat(zone);
    group.appendChild(flatten);
    group.appendChild(button("Remove", () => {
      const current = chosenZone();
      if (current) removeZone(current);
      App().renderOptions();
    }));
    bar.appendChild(group);
  };

  /* ------------------------------ the rest of the app ------------------------------ */

  const toolChosen = (tool) => {
    const stage = $("stage");
    if (stage && tool === "perspective") stage.style.cursor = "crosshair";
    if (tool !== "perspective") drawing = null;
    // The only zone of the page is the one to change
    if (tool === "perspective" && !chosenZone() && zones().length === 1 && !selectedTexts().length) choose(zones()[0]);
    drawOverlay();
    if (tool === "perspective" && window.TypeRPerspectiveGuide) window.TypeRPerspectiveGuide.toolChosen();
  };

  PS.on((type) => {
    if (type === "document" && chosen && !app.docs.includes(chosen.doc)) chosen = null;
    if (type === "render" || type === "view" || type === "document" || type === "history" || type === "active") drawOverlay();
  });

  // Enter puts the selected texts on their zone, or takes them off it. Delete removes the
  // zone whose handles show; Escape lets go of it. All before the app sees them.
  window.addEventListener("keydown", (event) => {
    if (app.tool !== "perspective" || !app.doc || event.target.closest("input, textarea, select, [contenteditable]")) return;
    if (document.querySelector(".modal[open], dialog[open]") || event.metaKey || event.ctrlKey || event.altKey) return;
    const texts = selectedTexts();
    const zone = chosenZone();
    if (event.key === "Enter" && texts.some(zoneOf)) toggleFollow(texts);
    else if ((event.key === "Delete" || event.key === "Backspace") && zone && !app.doc.state.activeIds.length) removeZone(zone); else if (event.key === "Escape" && (zone || drawing) && !texts.length) {
      chosen = null;
      drawing = null;
    } else return;
    event.preventDefault();
    event.stopPropagation();
    drawOverlay();
    if (App()) App().renderOptions();
  }, true);

  window.TypeRPerspectiveTool = {
    down,
    move,
    up,
    hover,
    options,
    toolChosen,
    drawOverlay,
    // For the guide (perspective-guide.js): what is done, and a ring around what to do
    onGesture,
    setMark,
    // For tests and the demos: the surface a rectangle shows, a zone drawn, the one chosen
    read,
    makeZone,
    chosen: chosenZone,
  };
})();
