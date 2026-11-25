// Auto Perspective's guide: every shortcut on one card, each shown by a small looping drawing,
// and a practice of eight steps on a page of its own, a board seen from the side, each step
// passed by doing it (tool-guide.js). The practice is offered once, the first time the tool is
// picked; Help → Auto Perspective Guide and the ? of the options bar bring both back.

(function () {
  "use strict";

  const PS = window.TypeRPhotoshop;
  const Guide = window.TypeRToolGuide;
  const P = window.TypeRPerspective;
  if (!PS || !Guide || !P) return;
  const { app, ops } = PS;
  const Tool = () => window.TypeRPerspectiveTool;
  const App = () => window.TypeRApp;
  const T = (text) => (App() ? App().T(text) : text);
  const { ease, lerp, phase, between, n1 } = Guide;

  /* --------------------------- the small drawings --------------------------- */

  // A board seen from the side, 110 × 44, its near edge on the left
  const BOARD = [[30, 5], [92, 11], [91, 36], [31, 41]];
  const FLAT = [[30, 5], [92, 5], [92, 41], [30, 41]];
  const WORD = "MENU";
  const pts = (list) => list.map(([x, y]) => `${n1(x)},${n1(y)}`).join(" ");
  const at = (corners, u, v) => P.onQuad(P.squareTo(corners), u, v) || corners[0];
  const mix = (a, b, t) => a + (b - a) * t;

  // The word's letters on a surface: between u0 and u1 along it, its middle at v, h of its
  // height above and below. Each letter: where, how large, how turned, how narrow.
  const letters = (corners, [u0, u1, v, h]) => WORD.split("").map((ch, i) => {
    const u = u0 + ((i + 0.5) * (u1 - u0)) / WORD.length;
    const [x, y] = at(corners, u, v);
    const top = at(corners, u, v - h);
    const bottom = at(corners, u, v + h);
    const left = at(corners, u - (u1 - u0) / WORD.length / 2, v);
    const right = at(corners, u + (u1 - u0) / WORD.length / 2, v);
    const size = Math.hypot(bottom[0] - top[0], bottom[1] - top[1]);
    const width = Math.hypot(right[0] - left[0], right[1] - left[1]);
    return { ch, x, y, size, r: (Math.atan2(right[1] - left[1], right[0] - left[0]) * 180) / Math.PI, sx: Math.max(0.4, Math.min(1.6, width / (size * 0.58))) };
  });
  // Halfway between two layouts of the word
  const between2 = (a, b, t) => a.map((l, i) => ({ ch: l.ch, x: mix(l.x, b[i].x, t), y: mix(l.y, b[i].y, t), size: mix(l.size, b[i].size, t), r: mix(l.r, b[i].r, t), sx: mix(l.sx, b[i].sx, t) }));
  // The word's frame on its surface, and its handles
  const frameOf = (corners, [u0, u1, v, h]) => [at(corners, u0, v - h), at(corners, u1, v - h), at(corners, u1, v + h), at(corners, u0, v + h)];
  const handlesOf = (quad) => {
    const middle = (a, b) => lerp(a, b, 0.5);
    return quad.concat([middle(quad[0], quad[1]), middle(quad[1], quad[2]), middle(quad[2], quad[3]), middle(quad[3], quad[0])]);
  };
  // A zone: its grid, its outline, and its handles when it is the one chosen
  const zoneSvg = (corners, chosen) => {
    let d = "";
    for (let i = 1; i < 6; i++) d += `M${pts([at(corners, i / 6, 0)])}L${pts([at(corners, i / 6, 1)])}`;
    for (let i = 1; i < 4; i++) d += `M${pts([at(corners, 0, i / 4)])}L${pts([at(corners, 1, i / 4)])}`;
    let out = `<path d="${d.replace(/,/g, " ")}" class="pgd__grid"/><polygon points="${pts(corners)}" class="pgd__zone"/>`;
    if (chosen) {
      [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]].forEach(([u, v]) => {
        const [x, y] = at(corners, u, v);
        out += `<circle cx="${n1(x)}" cy="${n1(y)}" r="1.8" class="sfxg__knob"/>`;
      });
      corners.forEach(([x, y]) => { out += `<rect x="${n1(x - 2.2)}" y="${n1(y - 2.2)}" width="4.4" height="4.4" class="sfxg__end"/>`; });
    }
    return out;
  };
  const drawScene = (scene) => {
    let out = `<polygon points="${pts(BOARD)}" class="pgd__board"/>`;
    for (let i = 1; i < 4; i++) out += `<line x1="${n1(at(BOARD, 0.06, i / 4)[0])}" y1="${n1(at(BOARD, 0.06, i / 4)[1])}" x2="${n1(at(BOARD, 0.94, i / 4)[0])}" y2="${n1(at(BOARD, 0.94, i / 4)[1])}" class="pgd__rule"/>`;
    if (scene.zone) out += zoneSvg(scene.zone, scene.chosen);
    if (scene.drawn) {
      const [[x0, y0], [x1, y1]] = scene.drawn;
      out += `<rect x="${n1(Math.min(x0, x1))}" y="${n1(Math.min(y0, y1))}" width="${n1(Math.abs(x1 - x0))}" height="${n1(Math.abs(y1 - y0))}" class="sfxg__guide"/>`;
    }
    if (scene.row) out += `<polyline points="${pts(scene.row)}" class="sfxg__guide"/>`;
    (scene.L || []).forEach((l) => {
      out += `<text transform="translate(${n1(l.x)} ${n1(l.y)}) rotate(${n1(l.r)}) scale(${Math.round(l.sx * 100) / 100} 1)" font-size="${n1(l.size)}" class="pgd__letter">${l.ch}</text>`;
    });
    if (scene.frame) {
      out += `<polygon points="${pts(scene.frame)}" class="sfxg__box"/>`;
      handlesOf(scene.frame).forEach(([x, y]) => { out += `<rect x="${n1(x - 1.6)}" y="${n1(y - 1.6)}" width="3.2" height="3.2" class="sfxg__end"/>`; });
    }
    if (scene.key) out += `<text x="104" y="40" class="pgd__key">${scene.key}</text>`;
    out += Guide.pointer(scene.ptr, scene.press);
    return out;
  };

  // Where the word is on the board, [u0, u1, v, h]; and typed flat, over the same middle
  const ON = [0.22, 0.72, 0.42, 0.13];
  const placed = (spot) => letters(BOARD, spot);
  const flatWord = (cx = 61, cy = 22, size = 1) => letters(FLAT, [(cx - 30 - 22 * size) / 62, (cx - 30 + 22 * size) / 62, (cy - 5) / 36, 0.16 * size]);
  const shift = (spot, du) => [spot[0] + du, spot[1] + du, spot[2], spot[3]];
  const grow = (spot, k, fromMiddle) => {
    const [u0, u1, v, h] = spot;
    if (fromMiddle) {
      const c = (u0 + u1) / 2;
      return [c - ((u1 - u0) / 2) * k, c + ((u1 - u0) / 2) * k, v, h * k];
    }
    // From the opposite corner, the top left one
    return [u0, u0 + (u1 - u0) * k, v - h + h * k, h * k];
  };
  const middleOf = (spot) => at(BOARD, (spot[0] + spot[1]) / 2, spot[2]);

  const DEMOS = {
    "zone-drag": (u) => {
      const from = [26, 3];
      const to = [96, 43];
      const p = ease((u - 0.1) / 0.4);
      const end = lerp(from, to, p);
      const made = u >= 0.52 && u < 0.92;
      const t = made ? ease((u - 0.52) / 0.12) : 0;
      return { drawn: u > 0.1 && u < 0.52 ? [from, end] : null, zone: made ? BOARD : null, L: between2(flatWord(), placed(ON), t), ptr: u < 0.52 ? end : to, press: between(u, 0.08, 0.52) };
    },
    "zone-click": (u) => ({ zone: BOARD, chosen: u > 0.2 && u < 0.92, L: placed(ON), ptr: at(BOARD, 0.8, 0.8), press: between(u, 0.1, 0.18) }),
    "zone-corner": (u) => {
      const p = phase(u);
      const corner = [BOARD[2][0] + 5 * p, BOARD[2][1] + 5 * p];
      const zone = [BOARD[0], BOARD[1], corner, BOARD[3]];
      return { zone, chosen: true, L: letters(zone, ON), ptr: corner, press: p > 0 };
    },
    "zone-side": (u) => {
      const p = phase(u);
      const reach = 1 + 0.22 * p;
      const zone = [at(BOARD, 0, 0), at(BOARD, reach, 0), at(BOARD, reach, 1), at(BOARD, 0, 1)];
      return { zone, chosen: true, L: placed(ON), ptr: at(BOARD, reach, 0.5), press: p > 0 };
    },
    "zone-delete": (u) => {
      const gone = u > 0.35 && u < 0.92;
      return { zone: gone ? null : BOARD, chosen: !gone, L: between2(placed(ON), flatWord(), gone ? ease((u - 0.35) / 0.12) : 0), key: u > 0.25 && u < 0.4 ? "⌫" : "" };
    },
    "zone-esc": (u) => ({ zone: BOARD, chosen: phase(u) < 0.5, L: placed(ON) }),
    "text-pick": (u) => {
      const picked = u > 0.18 && u < 0.92;
      const spot = ON;
      return { zone: BOARD, L: placed(spot), frame: picked ? frameOf(BOARD, spot) : null, ptr: middleOf(spot), press: between(u, 0.1, 0.18) };
    },
    "text-in": (u) => {
      // A flat word outside the board, dragged in: it lies on the board once its middle is in
      const p = ease((u - 0.1) / 0.45);
      const start = [14, 26];
      const goal = middleOf(ON);
      const [cx, cy] = lerp(start, goal, p);
      const flat = flatWord(cx, cy, 0.42);
      const t = u > 0.42 && u < 0.92 ? ease((u - 0.42) / 0.12) : 0;
      return { zone: BOARD, L: between2(flat, placed(ON), t), ptr: [cx, cy], press: between(u, 0.08, 0.55) };
    },
    "text-drag": (u) => {
      const p = phase(u);
      const spot = shift([0.08, 0.58, 0.5, 0.15], 0.34 * p);
      return { zone: BOARD, L: placed(spot), frame: frameOf(BOARD, spot), ptr: middleOf(spot), press: p > 0 };
    },
    "text-shift": (u) => {
      const p = phase(u);
      const spot = shift([0.08, 0.58, 0.5, 0.15], 0.34 * p);
      const [x, y] = middleOf(spot);
      const row = [at(BOARD, 0.02, 0.5), at(BOARD, 0.98, 0.5)];
      return { zone: BOARD, row, L: placed(spot), frame: frameOf(BOARD, spot), ptr: [x, y + 4 * Math.sin(p * Math.PI)], press: p > 0 };
    },
    "text-corner": (u) => {
      const p = phase(u);
      const spot = grow(ON, 1 + 0.35 * p, false);
      return { zone: BOARD, L: placed(spot), frame: frameOf(BOARD, spot), ptr: at(BOARD, spot[1], spot[2] + spot[3]), press: p > 0 };
    },
    "text-side": (u) => {
      const p = phase(u);
      const spot = [ON[0], ON[1] + 0.2 * p, ON[2], ON[3]];
      const placedL = placed(spot);
      return { zone: BOARD, L: placedL, frame: frameOf(BOARD, spot), ptr: at(BOARD, spot[1], spot[2]), press: p > 0 };
    },
    "text-off": (u) => {
      const p = phase(u);
      return { zone: BOARD, L: between2(placed(ON), flatWord(), p), key: between(u, 0.06, 0.2) || between(u, 0.7, 0.82) ? "↵" : "" };
    },
  };
  const SCENES = {};
  Object.keys(DEMOS).forEach((name) => { SCENES[name] = (u) => drawScene(DEMOS[name](u)); });

  /* --------------------------------- the card --------------------------------- */

  const GROUPS = [
    ["Make a zone", "With Auto Perspective (A), on the page", [
      [["drag"], "Over a board, a wall, a sign: TypeR finds its perspective", "zone-drag"],
      [["click"], "On a zone: its corners and sides show", "zone-click"],
      [["click"], "On a text: picks it", "text-pick"],
    ]],
    ["The zone", "Once its handles show", [
      [["drag"], "A corner: the perspective by hand, where TypeR finds too little (Shift: straight)", "zone-corner"],
      [["drag"], "The ● of a side: the zone goes further, in the same perspective", "zone-side"],
      [["Backspace"], "Removes the zone: its texts are flat again", "zone-delete"],
      [["Esc"], "Lets the zone go", "zone-esc"],
    ]],
    ["A text on the zone", "Typed, pasted or moved into it, a text lies on the surface", [
      [["drag"], "Into the zone: the text lies on it", "text-in"],
      [["drag"], "Slides it on the surface: smaller as it goes away", "text-drag"],
      [["Shift", "drag"], "Along the lines of the zone, or straight across them", "text-shift"],
      [["drag"], "A corner of its frame: bigger or smaller (Alt: from its middle)", "text-corner"],
      [["drag"], "A side of its frame: wider or taller", "text-side"],
      [["Enter", "/", "Alt", "click"], "Off the zone: the text stays as typed. Again: back on it", "text-off"],
    ]],
  ];

  /* ------------------------------- the practice ------------------------------- */

  // The practice page: a wall, and a board on it seen from the side
  const PAGE = [1400, 900];
  const PAGE_BOARD = [[540, 150], [1180, 290], [1176, 650], [546, 820]];
  const onBoard = (u, v) => at(PAGE_BOARD, u, v);
  // The frame around the board, and two spots of it: where the word is not, and the ruled lines
  const FRAME_OUT = [onBoard(-0.03, -0.04), onBoard(1.03, -0.04), onBoard(1.03, 1.04), onBoard(-0.03, 1.04)];
  const EMPTY = onBoard(0.72, 0.78);

  const STEPS = [
    { text: "Drag over the board, from one corner of its frame to the other: TypeR finds its perspective, and the word on it lies on the board.", demo: "zone-drag", mark: () => ({ kind: "points", at: [FRAME_OUT[0], FRAME_OUT[2]] }), done: (d) => d.mode === "zone" && (d.found.across || d.found.down) },
    { text: "Click the word to pick it, then drag it: it slides on the board, smaller as it goes away. With {Shift}, along the board's lines.", demo: "text-drag", mark: (id) => ({ kind: "text", id }), done: (d) => d.mode === "text" },
    { text: "Drag a corner of its frame: the word gets bigger or smaller, on the board. With {Alt}, from its middle.", demo: "text-corner", mark: (id) => ({ kind: "textCorner", id }), done: (d) => d.mode === "frame" },
    { text: "Press {Enter}: the word leaves the board and stays as it was typed.", demo: "text-off", mark: (id) => ({ kind: "text", id }), done: (d) => d.mode === "follow" && !d.on },
    { text: "Press {Enter} again, or {Alt} + click on the word: back on the board.", demo: "text-off", mark: (id) => ({ kind: "text", id }), done: (d) => d.mode === "follow" && d.on },
    { text: "Click the board away from the word: the corners of the zone show. Drag one: the perspective changes, and the word follows. That's how to set it by hand where TypeR finds too little.", demo: "zone-corner", mark: () => ({ kind: "corner", at: [EMPTY] }), done: (d) => d.mode === "corner" },
    { text: "Drag the ● in the middle of a side: the zone goes further, in the same perspective.", demo: "zone-side", mark: () => ({ kind: "side", at: [EMPTY] }), done: (d) => d.mode === "side" },
    { text: "Last one: take the Type tool ({T}), click on the board and type a word, then {Esc}. It lies on the board as you type.", demo: "text-in", mark: () => ({ kind: "points", at: [onBoard(0.45, 0.72)] }), done: (d) => d.mode === "typed" },
  ];

  const practicePage = () => {
    const [w, h] = PAGE;
    const canvas = PS.newCanvas(w, h);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    // The panel: a wall and its floor
    ctx.fillStyle = "#d9d9d9";
    ctx.fillRect(40, 40, w - 80, h - 80);
    ctx.fillStyle = "#bdbdbd";
    ctx.fillRect(40, 720, w - 80, h - 760);
    ctx.lineWidth = 6;
    ctx.strokeStyle = "#111111";
    ctx.strokeRect(40, 40, w - 80, h - 80);
    const quad = (u0, v0, u1, v1) => {
      ctx.beginPath();
      [onBoard(u0, v0), onBoard(u1, v0), onBoard(u1, v1), onBoard(u0, v1)].forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
    };
    // Its frame, the board, and the lines ruled across it
    quad(-0.03, -0.04, 1.03, 1.04);
    ctx.fillStyle = "#6b5138";
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.stroke();
    quad(0, 0, 1, 1);
    ctx.fillStyle = "#f3efe4";
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = "rgba(60, 60, 60, 0.45)";
    ctx.lineWidth = 2;
    for (let i = 2; i < 9; i++) {
      const [a, b] = [onBoard(0.05, i / 9), onBoard(0.95, i / 9)];
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }
    return canvas;
  };

  // The word typed flat on the board, as on a page not yet given its perspective: dark, large,
  // in the font the next text gets
  const addWord = () => {
    const keep = { size: app.textDefaults.size, fg: app.fg };
    const [x, y] = onBoard(0.5, 0.3);
    app.textDefaults.size = 76;
    app.fg = { r: 28, g: 28, b: 28 };
    try {
      return ops.newText(x, y + 27, WORD);
    } finally {
      app.textDefaults.size = keep.size;
      app.fg = keep.fg;
    }
  };

  window.TypeRPerspectiveGuide = Guide.make({
    tool: "perspective",
    store: "typer.web.perspective.guide",
    title: "Auto Perspective Guide",
    intro: () => T("Every shortcut of Auto Perspective (A). Its options bar also has Width %, for letters wider or narrower, Detect again and Reset. Undo works as everywhere: Cmd + Z."),
    practiceLabel: "Practice (2 min)",
    groups: GROUPS,
    scenes: SCENES,
    steps: STEPS,
    doneText: "You know Auto Perspective. Every shortcut stays in Help → Auto Perspective Guide, and behind the ? of the options bar.",
    offerTitle: "New: Auto Perspective",
    offerBody: "Learn it in 2 minutes, on a page of its own? Eight short steps, each passed by doing it.",
    start: async () => {
      const name = `${T("Perspective practice")}.psd`;
      const doc = ops.imageDocument(practicePage(), name, `new://perspective-practice-${PS.newId()}`);
      const page = doc || app.doc;
      const word = addWord();
      ops.clearActiveLayers();
      App().setTool("perspective");
      const before = new Set(page ? page.state.layers.map((layer) => layer.id) : []);
      const wordId = word ? word.id : null;
      // A text typed on the board, once its typing is done: the last step
      const typed = (tell) => () => {
        if (!page || app.doc !== page) return;
        const editing = App().editingId();
        const made = page.state.layers.some((layer) => layer.kind === "text" && !before.has(layer.id) && layer.id !== editing && layer.warp && layer.warp.auto && layer.params.layerText.textKey.trim());
        if (made) tell({ mode: "typed" });
      };
      return {
        page,
        onGesture: (listener) => {
          const stopTool = Tool().onGesture(listener);
          const stopPage = PS.on(typed(listener));
          return () => {
            stopTool();
            stopPage();
          };
        },
        setMark: (mark) => { if (Tool()) Tool().setMark(typeof mark === "function" ? mark(wordId) : mark); },
      };
    },
  });
})();
