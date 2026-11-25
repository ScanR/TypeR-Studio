// The Line Breaks panel's guide: every gesture on one card, each shown by a small looping
// drawing (the panel's lines on the left, the bubble they make on the right), and a practice
// of nine steps on a page of its own, each passed by doing it (tool-guide.js). The panel offers
// the practice in itself, once, the first time it shows a text (breaks.js); Help → Line Breaks
// Guide and the panel's help bring both back.

(function () {
  "use strict";

  const PS = window.TypeRPhotoshop;
  const Guide = window.TypeRToolGuide;
  if (!PS || !Guide) return;
  const { app, ops } = PS;
  const Breaks = () => window.TypeRBreaks;
  const App = () => window.TypeRApp;
  const T = (text) => (App() ? App().T(text) : text);
  const { ease, lerp, between, n1, capOf } = Guide;

  /* --------------------------- the small drawings --------------------------- */

  // The panel's lines, in letters of one width so that a spot between two of them is known:
  // a line is { t, cut }, cut when it ends inside a word (its ↵ then has the hyphen)
  const CW = 3.12;
  const LH = 6.5;
  const CX = 31;
  const MID = 27;
  const L = (text) => text.split("|").map((t) => ({ t: t.replace(/~$/, ""), cut: /~$/.test(t) }));
  const rowY = (lines, i) => MID + (i - (lines.length - 1) / 2) * LH;
  const startX = (line) => CX - (line.t.length * CW) / 2;
  const colX = (lines, i, col) => startX(lines[i]) + col * CW;
  const markOf = (lines, i) => [startX(lines[i]) + lines[i].t.length * CW + 0.8 + (lines[i].cut ? 3 : 2.2), rowY(lines, i)];
  // Line i broken before its letter col; line i joined to the next
  const split = (lines, i, col) => {
    const t = lines[i].t;
    const before = t[col - 1];
    const out = lines.slice();
    out.splice(i, 1, { t: t.slice(0, col).replace(/ $/, ""), cut: before !== " " && before !== "-" }, { t: t.slice(col), cut: lines[i].cut });
    return out;
  };
  const join = (lines, i) => {
    const out = lines.slice();
    out.splice(i, 2, { t: lines[i].cut ? lines[i].t + lines[i + 1].t : `${lines[i].t} ${lines[i + 1].t}`, cut: lines[i + 1].cut });
    return out;
  };

  const drawScene = (scene) => {
    const { lines } = scene;
    const tool = (name, x, text) => `<text x="${x}" y="8"${scene.tool === name ? ' class="is-on"' : ""}>${text}</text>`;
    let out = '<rect x="2" y="3" width="58" height="38" rx="1.5" class="lbg__panel"/>';
    out += `<g class="lbg__tools">${tool("fewer", 8, "−")}<text x="14" y="8">${lines.length}</text>${tool("more", 20, "+")}${tool("balance", 27, "≡")}</g>`;
    out += '<line x1="2" y1="12" x2="60" y2="12" stroke="#ddd" stroke-width="0.5"/>';
    lines.forEach((line, i) => {
      const y = rowY(lines, i);
      if (line.t) out += `<text x="${n1(startX(line))}" y="${n1(y)}" textLength="${n1(line.t.length * CW)}" lengthAdjust="spacingAndGlyphs" class="lbg__line">${line.t}</text>`;
      if (i === lines.length - 1) return;
      const [x] = markOf(lines, i);
      const w = line.cut ? 6 : 4.4;
      out += `<rect x="${n1(x - w / 2)}" y="${n1(y - 2.3)}" width="${w}" height="4.6" rx="0.8" class="lbg__mark${line.cut ? " lbg__mark--cut" : ""}"/><text x="${n1(x)}" y="${n1(y)}" class="lbg__marktext">${line.cut ? "-↵" : "↵"}</text>`;
    });
    if (scene.caret) {
      const [i, col] = scene.caret;
      const x = colX(lines, i, col);
      const y = rowY(lines, i);
      out += `<line x1="${n1(x)}" y1="${n1(y - 3)}" x2="${n1(x)}" y2="${n1(y + 3)}" class="lbg__caret"/>`;
    }
    // The bubble: what the page shows, the break being tried included
    const shown = scene.bubble || lines;
    const longest = Math.max(...shown.map((line) => line.t.length + (line.cut ? 1 : 0)));
    const size = Math.min(7.2, 38 / (longest * 0.46));
    out += '<ellipse cx="85.5" cy="22" rx="22.5" ry="19" class="sfxg__bubble"/>';
    shown.forEach((line, i) => {
      out += `<text x="85.5" y="${n1(22 + (i - (shown.length - 1) / 2) * size * 1.05)}" font-size="${n1(size)}" class="lbg__word">${line.t}${line.cut ? "-" : ""}</text>`;
    });
    if (scene.key) out += `<text x="107" y="41" class="lbg__key">${scene.key}</text>`;
    out += Guide.pointer(scene.ptr, scene.press);
    return out;
  };

  const BASE = L("LET'S GO|HOME TOGETHER");
  const FROM = [CX, 46];
  const keyOf = (last) => [capOf("Alt"), capOf("Cmd"), last].join(/mac/i.test(navigator.platform || "") ? "" : "+");

  // The pointer comes to a spot, shows what a click would do there, clicks, and it's done
  const clickScene = ({ base, target, after, caret, preview, key }) => (u) => {
    const p = ease((u - 0.05) / 0.28);
    const done = u >= 0.45 && u < 0.92;
    const near = p > 0.85 && !done;
    return { lines: done ? after : base, caret: near ? caret : null, bubble: near && preview ? after : null, ptr: lerp(FROM, target, p), press: between(u, 0.36, 0.45), key: key && between(u, 0.28, 0.5) ? key : "" };
  };
  const breakAt = (base, i, col, key) => clickScene({ base, target: [colX(base, i, col), rowY(base, i) + 1], after: split(base, i, col), caret: [i, col], preview: true, key });
  const THREE = L("LET'S GO|HOME|TOGETHER");

  const DEMOS = {
    hover: (u) => {
      // Along "HOME TOGETHER": between the words, and at TO-GETH-ER's syllables
      const stops = [5, 7, 11];
      const line = BASE[1];
      const p = ease((u - 0.08) / 0.75);
      const x = startX(line) - 2 + p * (line.t.length * CW + 4);
      const active = u >= 0.08 && u < 0.9;
      const col = stops.reduce((best, stop) => (Math.abs(colX(BASE, 1, stop) - x) < Math.abs(colX(BASE, 1, best) - x) ? stop : best), stops[0]);
      return { lines: BASE, caret: active ? [1, col] : null, bubble: active ? split(BASE, 1, col) : null, ptr: [x, rowY(BASE, 1) + 1] };
    },
    "click-gap": breakAt(BASE, 1, 5),
    "click-word": breakAt(BASE, 1, 7),
    "alt-click": breakAt(BASE, 1, 8, capOf("Alt")),
    join: clickScene({ base: THREE, target: markOf(THREE, 1), after: join(THREE, 1), preview: true }),
    rclick: clickScene({ base: THREE, target: [colX(THREE, 2, 1.5), rowY(THREE, 2) + 1], after: join(THREE, 1) }),
    "drag-mark": (u) => {
      const base = L("LET'S GO HOME|TOGETHER");
      const after = split(join(base, 0), 0, 9);
      const mark = markOf(base, 0);
      const target = [colX(base, 0, 9), rowY(base, 0) + 1];
      const p = ease((u - 0.3) / 0.3);
      const done = u >= 0.66 && u < 0.92;
      const near = p > 0.8 && !done;
      const ptr = u < 0.3 ? lerp(FROM, mark, ease((u - 0.04) / 0.22)) : lerp(mark, target, p);
      return { lines: done ? after : base, caret: near ? [0, 9] : null, bubble: near ? after : null, ptr, press: between(u, 0.27, 0.66) };
    },
    fewer: (u) => {
      const on = between(u, 0.3, 0.5);
      return { lines: u >= 0.4 && u < 0.92 ? BASE : L("LET'S|GO HOME|TOGETHER"), tool: on ? "fewer" : "", key: on ? keyOf("-") : "" };
    },
    more: (u) => {
      const on = between(u, 0.3, 0.5);
      return { lines: u >= 0.4 && u < 0.92 ? L("LET'S|GO HOME|TOGETHER") : BASE, tool: on ? "more" : "", key: on ? keyOf("=") : "" };
    },
    balance: (u) => {
      const scene = clickScene({ base: L("LET'S|GO HOME TOGETHER"), target: [27, 8.5], after: BASE })(u);
      scene.tool = between(u, 0.36, 0.45) ? "balance" : "";
      return scene;
    },
  };
  const SCENES = {};
  Object.keys(DEMOS).forEach((name) => { SCENES[name] = (u) => drawScene(DEMOS[name](u)); });

  /* --------------------------------- the card --------------------------------- */

  const GROUPS = [
    ["In the panel's text", "The Line Breaks panel (Window menu), a text picked on the page", [
      [["hover"], "Over the text: the page shows the break before any click", "hover"],
      [["click"], "Between two words: the line breaks there", "click-gap"],
      [["click"], "Inside a word: at a syllable, with its hyphen", "click-word"],
      [["Alt", "click"], "Anywhere, between any two letters", "alt-click"],
    ]],
    ["A break", "Its ↵, at the end of the line", [
      [["click"], "Joins the two lines again", "join"],
      [["drag"], "Moves the break, shown on the page as you drag", "drag-mark"],
      [["rclick"], "On the first word of a line: joins it to the one above", "rclick"],
    ]],
    ["The whole text", "From the top of the panel, or the keys with the panel closed", [
      [["Alt", "Cmd", "-"], "One line less, balanced", "fewer"],
      [["Alt", "Cmd", "="], "One line more, balanced", "more"],
      [["click"], "Balance (≡): as many lines, fuller in the middle, as a bubble is", "balance"],
    ]],
  ];

  /* ------------------------------- the practice ------------------------------- */

  const STEPS = [
    { text: "In the Line Breaks panel, move the pointer over the text: the page shows where the line would break, before any click.", demo: "hover", mark: { kind: "lines" }, done: (d) => d.mode === "hover" },
    { text: "Click between two words: the line breaks there.", demo: "click-gap", mark: { kind: "gap" }, done: (d) => d.mode === "break" && !d.cut },
    { text: "Click inside a long word: it breaks at a syllable, and gets its hyphen.", demo: "click-word", mark: { kind: "syllable" }, done: (d) => d.mode === "break" && d.cut && !d.alt },
    { text: "Click a ↵ at the end of a line: the two lines are joined again.", demo: "join", mark: { kind: "mark" }, done: (d) => d.mode === "join" && !d.right },
    { text: "Drag a ↵ to another spot: the break moves, and the page shows it as you drag.", demo: "drag-mark", mark: { kind: "mark" }, done: (d) => d.mode === "move" },
    { text: "Hold {Alt} and click between any two letters: the line breaks right there, syllable or not.", demo: "alt-click", mark: { kind: "letters" }, done: (d) => d.mode === "break" && d.alt && d.cut },
    { text: "Right-click the first word of a line: it joins the line above.", demo: "rclick", mark: { kind: "lineStart" }, done: (d) => d.mode === "join" && d.right },
    { text: "One line less: {Alt}{Cmd}{-}, or the − at the top of the panel. One line more: {Alt}{Cmd}{=}, or the +. Either way, the lines are balanced.", demo: "fewer", mark: { kind: "button", ids: ["breaks-fewer", "breaks-more"] }, done: (d) => d.mode === "fewer" || d.mode === "more" },
    { text: "Last one: click Balance (≡), at the top of the panel: as many lines, fuller in the middle, as a bubble is.", demo: "balance", mark: { kind: "button", ids: ["breaks-balance"] }, done: (d) => d.mode === "balance" },
  ];

  // The practice page: a panel, and a large bubble in it
  const PAGE = [1200, 800];
  const BUBBLE = { x: 600, y: 390, rx: 400, ry: 250 };
  const practicePage = () => {
    const [w, h] = PAGE;
    const canvas = PS.newCanvas(w, h);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#e6e6e6";
    ctx.fillRect(40, 40, w - 80, h - 80);
    ctx.lineWidth = 6;
    ctx.strokeStyle = "#111111";
    ctx.strokeRect(40, 40, w - 80, h - 80);
    // The bubble and its tail as one outline: stroked twice as thick, then filled
    const shape = () => {
      ctx.beginPath();
      ctx.ellipse(BUBBLE.x, BUBBLE.y, BUBBLE.rx, BUBBLE.ry, 0, 0, Math.PI * 2);
      ctx.moveTo(470, 600);
      ctx.lineTo(380, 735);
      ctx.lineTo(560, 615);
    };
    shape();
    ctx.lineWidth = 12;
    ctx.lineJoin = "round";
    ctx.stroke();
    shape();
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    return canvas;
  };

  // The text in the bubble, on three lines a typesetter would change: dark, large, in the
  // font the next text gets
  const addText = () => {
    const keep = { size: app.textDefaults.size, fg: app.fg };
    app.textDefaults.size = 46;
    app.fg = { r: 28, g: 28, b: 28 };
    try {
      return ops.newText(BUBBLE.x, BUBBLE.y - 40, T("We never thought\rwe'd make it back home\rtogether, after all this time."));
    } finally {
      app.textDefaults.size = keep.size;
      app.fg = keep.fg;
    }
  };

  window.TypeRBreaksGuide = Guide.make({
    tool: null,
    store: "typer.web.breaks.guide",
    title: "Line Breaks Guide",
    intro: () => T("Every gesture of the Line Breaks panel (Window menu): it shows the lines of the picked text, and the page follows what you do there. Its menu sets the hyphenation language, which Auto finds in the text. Undo works as everywhere: Cmd + Z."),
    practiceLabel: "Practice (2 min)",
    groups: GROUPS,
    scenes: SCENES,
    steps: STEPS,
    doneText: "You know Line Breaks. Every gesture stays in Help → Line Breaks Guide, and under the panel's ?.",
    offerTitle: "Line Breaks in 2 minutes",
    offerBody: "Learn the panel on a page of its own? Nine short steps, each passed by doing it.",
    start: async () => {
      const name = `${T("Line Breaks practice")}.psd`;
      const doc = ops.imageDocument(practicePage(), name, `new://breaks-practice-${PS.newId()}`);
      const page = doc || app.doc;
      addText();
      App().setTool("move");
      if (!Breaks().open) Breaks().toggle();
      return {
        page,
        onGesture: (listener) => Breaks().onGesture(listener),
        setMark: (mark) => Breaks().setMark(mark),
      };
    },
  });
})();
