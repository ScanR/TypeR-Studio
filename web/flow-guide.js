// Flow's guide, and Text Across Pages': every gesture on one card, each shown by a small looping
// drawing, and a practice of eight steps on two pages of its own, one under the other with a
// bubble cut between them, each step passed by doing it (tool-guide.js). The practice is offered
// once, the first time Flow is turned on; Help → Flow Guide brings both back.

(function () {
  "use strict";

  const PS = window.TypeRPhotoshop;
  const Guide = window.TypeRToolGuide;
  if (!PS || !Guide) return;
  const { app, ops } = PS;
  const App = () => window.TypeRApp;
  const T = (text) => (App() ? App().T(text) : text);
  const { ease, lerp, phase, between, n1 } = Guide;

  /* --------------------------- the small drawings --------------------------- */

  // A page: [x, y, w, h], in front or not, its name's bar above it when it is dragged by it
  const pageSvg = ([x, y, w, h], front, named) => {
    let out = `<rect x="${n1(x)}" y="${n1(y)}" width="${n1(w)}" height="${n1(h)}" class="fgd__page${front ? " fgd__page--front" : ""}"/>`;
    if (named) out += `<rect x="${n1(x)}" y="${n1(y - 3)}" width="${n1(Math.min(w, 12))}" height="2" class="fgd__name"/>`;
    return out;
  };
  // Each drawing clips with a name of its own: one name in two drawings would clip both alike
  let clips = 0;
  const drawScene = (scene) => {
    let out = "";
    (scene.pages || []).forEach((page, i) => { out += pageSvg(page, scene.front === i, scene.named === i); });
    if (scene.seam) out += `<line x1="${n1(scene.seam[0])}" y1="${n1(scene.seam[1])}" x2="${n1(scene.seam[2])}" y2="${n1(scene.seam[1])}" class="fgd__seam"/>`;
    // A bubble, and its text, with what of them each page shows: clipped to the pages
    if (scene.bubble || scene.word || scene.bubbles || scene.words) {
      const clip = (scene.clip || scene.pages || []).map(([x, y, w, h]) => `<rect x="${n1(x)}" y="${n1(y)}" width="${n1(w)}" height="${n1(h)}"/>`).join("");
      clips = (clips + 1) % 1e6;
      out += `<clipPath id="fgd-clip-${clips}">${clip}</clipPath><g clip-path="url(#fgd-clip-${clips})">`;
      (scene.bubbles || [scene.bubble]).filter(Boolean).forEach(([cx, cy]) => { out += `<ellipse cx="${n1(cx)}" cy="${n1(cy)}" rx="16" ry="8" class="sfxg__bubble"/>`; });
      (scene.words || [scene.word]).filter(Boolean).forEach(([text, x, y]) => { out += `<text x="${n1(x)}" y="${n1(y)}" class="fgd__word">${text}</text>`; });
      out += "</g>";
    }
    if (scene.key) out += `<text x="106" y="41" class="pgd__key" style="text-anchor:end">${scene.key}</text>`;
    out += Guide.pointer(scene.ptr, scene.press);
    return out;
  };

  // Three pages side by side, and three one under the other
  const ROW = [[14, 8, 24, 32], [43, 8, 24, 32], [72, 8, 24, 32]];
  const column = (dy) => [0, 1, 2].map((i) => [43, 3 + i * 30 + dy, 24, 30]);
  // Two pages one under the other, touching, and a bubble cut between them
  const TOP = [35, 1, 40, 21];
  const BOTTOM = [35, 22, 40, 21];
  const SEAM = [33, 22, 77];
  const isMac = /mac/i.test(navigator.platform || "");
  const keys = (...list) => list.map((key) => Guide.capOf(key)).join(isMac ? "" : "+");

  const DEMOS = {
    "flow-on": (u) => {
      const p = u < 0.35 || u >= 0.92 ? 0 : ease((u - 0.35) / 0.2);
      const pages = ROW.map((page, i) => (i === 1 ? page : [lerp([43, 8], page, p)[0], 8, 24, 32]));
      return { pages: p ? pages : [ROW[1]], front: p ? 1 : 0, key: between(u, 0.25, 0.45) ? keys("Shift", "F") : "" };
    },
    "flow-wander": (u) => {
      const p = phase(u);
      const pages = column(-30 * p);
      // The page in the middle of the drawing comes in front once the view rests
      const front = p > 0.95 ? 1 : p < 0.05 ? 0 : -1;
      return { pages, front, ptr: [62, 30 - 14 * p], press: p > 0 && p < 1 };
    },
    "flow-click": (u) => ({ pages: ROW, front: u > 0.45 && u < 0.92 ? 0 : 1, ptr: lerp([60, 40], [26, 24], ease((u - 0.1) / 0.3)), press: between(u, 0.38, 0.45) }),
    "flow-keys": (u) => {
      const step = u < 0.3 ? 1 : u < 0.6 ? 0 : 1;
      return { pages: ROW, front: step, key: between(u, 0.25, 0.35) ? "PageDown" : between(u, 0.55, 0.65) ? "PageUp" : "" };
    },
    "flow-fit": (u) => {
      const p = phase(u);
      const scale = 2.6 - 1.6 * p;
      const pages = ROW.map(([x, y, w, h]) => [55 + (x - 55) * scale, 24 + (y - 24) * scale, w * scale, h * scale]);
      return { pages, front: 1, key: between(u, 0.06, 0.2) ? keys("Shift", "Cmd", "0") : "" };
    },
    "flow-pairs": (u) => {
      const p = phase(u);
      const singles = [[4, 10, 22, 30], [30, 10, 22, 30], [58, 10, 22, 30], [84, 10, 22, 30]];
      const pairs = [[6, 10, 22, 30], [28, 10, 22, 30], [60, 10, 22, 30], [82, 10, 22, 30]];
      return { pages: singles.map((page, i) => [page[0] + (pairs[i][0] - page[0]) * p, 10, 22, 30]), front: 1, key: between(u, 0.06, 0.2) ? keys("Shift", "D") : "" };
    },
    "flow-long": (u) => {
      // Page 2, dragged by its name, under page 1: one long page
      const p = ease((u - 0.1) / 0.4);
      const joined = u >= 0.55 && u < 0.92;
      const from = [70, 6];
      const to = [43, 23];
      const [x, y] = lerp(from, to, p);
      if (joined) return { pages: [[43, 4, 24, 38]], front: 0, ptr: [to[0] + 4, to[1] - 2] };
      return { pages: [[43, 4, 24, 19], [x, y, 24, 19]], front: 0, named: 1, ptr: [x + 4, y - 2], press: between(u, 0.08, 0.52) };
    },
    "flow-spread": (u) => {
      const p = ease((u - 0.1) / 0.4);
      const joined = u >= 0.55 && u < 0.92;
      const [x] = lerp([78, 10], [55, 10], p);
      if (joined) return { pages: [[31, 10, 48, 30]], front: 0, ptr: [59, 8] };
      return { pages: [[31, 10, 24, 30], [x, 10, 24, 30]], front: 0, named: 1, ptr: [x + 4, 8], press: between(u, 0.08, 0.52) };
    },
    "across-drag": (u) => {
      // The text dragged into the bubble, across the line: page 2 shows its part
      const p = ease((u - 0.1) / 0.4);
      const y = 9 + 13 * p;
      const linked = u >= 0.55 && u < 0.92;
      return { pages: [TOP, BOTTOM], front: linked ? -1 : 0, seam: SEAM, bubble: [55, 22], word: ["WAIT!", 55, y], clip: linked ? [TOP, BOTTOM] : [TOP], ptr: [57, y + 2], press: between(u, 0.08, 0.52) };
    },
    "across-key": (u) => {
      // Two pages apart: the part beyond page 1's bottom shows on page 2 once asked
      const a = [16, 1, 34, 30];
      const b = [60, 13, 34, 30];
      const on = u >= 0.4 && u < 0.92;
      const words = [["WAIT!", 33, 31]].concat(on ? [["WAIT!", 77, 13]] : []);
      const bubbles = [[33, 31]].concat(on ? [[77, 13]] : []);
      return { pages: [a, b], front: 0, bubbles, words, key: between(u, 0.3, 0.5) ? keys("Shift", "T") : "" };
    },
    "across-type": (u) => {
      const text = "WAIT FOR ME!";
      const count = Math.max(4, Math.min(text.length, Math.floor(4 + (text.length - 4) * ease((u - 0.15) / 0.55))));
      return { pages: [TOP, BOTTOM], front: 1, seam: SEAM, bubble: [55, 22], word: [text.slice(0, count), 55, 22] };
    },
    "across-back": (u) => {
      const p = ease((u - 0.1) / 0.4);
      const y = 22 - 12 * p;
      const alone = u >= 0.55 && u < 0.92;
      return { pages: [TOP, BOTTOM], front: 0, seam: SEAM, bubble: [55, 22], word: ["WAIT!", 55, y], clip: alone ? [TOP] : [TOP, BOTTOM], ptr: [57, y + 2], press: between(u, 0.08, 0.52) };
    },
  };
  const SCENES = {};
  Object.keys(DEMOS).forEach((name) => { SCENES[name] = (u) => drawScene(DEMOS[name](u)); });

  /* --------------------------------- the card --------------------------------- */

  const GROUPS = [
    ["Flow", "Every page of the chapter on one surface", [
      [["Shift", "F"], "Flow mode on or off: every page on one surface, or one at a time (Solo)", "flow-on"],
      [["Space", "drag"], "Moves over the pages: once the view rests, the page in the middle of the screen comes in front", "flow-wander"],
      [["click"], "On a page: it comes in front, and the script follows it", "flow-click"],
      [["PageDown", "/", "PageUp"], "The next or the previous page", "flow-keys"],
      [["Shift", "Cmd", "0"], "Fit All Pages", "flow-fit"],
      [["Shift", "D"], "Pages Two by Two, as a printed manga", "flow-pairs"],
    ]],
    ["A page, dragged by its name", "Page display, in the options bar, lays them out again: Tidy Up Pages", [
      [["drag"], "Against another's top or bottom: the two become one long page, as the strips of a manhwa", "flow-long"],
      [["drag"], "Against its side, level with it: one page, a spread", "flow-spread"],
    ]],
    ["Text Across Pages", "A bubble cut between two pages", [
      [["drag"], "A text across the line where two pages meet, top to bottom: it goes on to the next page", "across-drag"],
      [["Shift", "T"], "The same, wherever the pages are. Again: on this page only", "across-key"],
      [["dblclick"], "Typed, moved or styled on either page: the other follows", "across-type"],
      [["drag"], "Wholly back on one page: the other lets it go", "across-back"],
    ]],
  ];

  /* ------------------------------- the practice ------------------------------- */

  // Two pages one under the other, and a bubble cut between them: its top at the bottom of
  // page 1, its bottom at the top of page 2. The text waits on page 1, above the bubble.
  const PAGE = [800, 900];
  const BUBBLE = { x: 400, rx: 250, ry: 150 };
  const START = [400, 690];
  const pageOne = () => drawPage([40, 40, 720, 560], PAGE[1]);
  const pageTwo = () => drawPage([40, 200, 720, 660], 0);
  function drawPage(panel, bubbleY) {
    const [w, h] = PAGE;
    const canvas = PS.newCanvas(w, h);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#e6e6e6";
    ctx.fillRect(...panel);
    ctx.lineWidth = 6;
    ctx.strokeStyle = "#111111";
    ctx.strokeRect(...panel);
    ctx.beginPath();
    ctx.ellipse(BUBBLE.x, bubbleY, BUBBLE.rx, BUBBLE.ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.stroke();
    return canvas;
  }
  const addText = () => {
    const keep = { size: app.textDefaults.size, fg: app.fg };
    app.textDefaults.size = 52;
    app.fg = { r: 28, g: 28, b: 28 };
    try {
      return ops.newText(START[0], START[1], T("Wait for me!"));
    } finally {
      app.textDefaults.size = keep.size;
      app.fg = keep.fg;
    }
  };

  // Where the pages are: a spot of page 1 or 2 on the screen, while Flow shows them one under the
  // other, or while that page is the one shown
  let pages = [];
  const onScreen = (index, x, y) => {
    const front = pages.indexOf(app.doc);
    if (front < 0 || !App()) return null;
    if (front !== index && !App().flow()) return null;
    const stage = document.getElementById("stage").getBoundingClientRect();
    const [sx, sy] = App().toScreen(x, y + (index - front) * PAGE[1]);
    return [stage.left + sx, stage.top + sy];
  };
  // The view moved for a spot of a page to be in the middle of the screen, at the same zoom
  const centreOn = (index, x, y) => {
    const doc = app.doc;
    const front = pages.indexOf(doc);
    if (front < 0 || !App()) return;
    const stage = document.getElementById("stage");
    const { view } = doc;
    view.x = stage.clientWidth / 2 - x * view.zoom;
    view.y = stage.clientHeight / 2 - (y + (index - front) * PAGE[1]) * view.zoom;
    view.fitted = false;
    App().viewChanged();
  };
  // The middle of what the screen shows of a page
  const seenMiddle = (index) => {
    const a = onScreen(index, 0, 0);
    const b = onScreen(index, PAGE[0], PAGE[1]);
    if (!a || !b) return null;
    const stage = document.getElementById("stage").getBoundingClientRect();
    const top = Math.max(a[1], stage.top);
    const bottom = Math.min(b[1], stage.bottom);
    return bottom - top > 20 ? [(a[0] + b[0]) / 2, (top + bottom) / 2] : null;
  };
  // The practice's text, on page 1, and what both pages say of it
  const textOf = (doc) => (doc ? doc.state.layers.find((layer) => layer.kind === "text") : null);
  const boxOf = (doc) => {
    const layer = textOf(doc);
    if (!layer) return null;
    try {
      const visual = PS.visualOf(layer, doc);
      return visual && visual.canvas ? { x: visual.x, y: visual.y, w: visual.canvas.width, h: visual.canvas.height } : null;
    } catch (error) {
      return null;
    }
  };
  const middleOf = (doc) => {
    const box = boxOf(doc);
    return box ? [box.x + box.w / 2, box.y + box.h / 2, box.y + box.h] : null;
  };
  // A spot to press the text on page 1 to move it: on its letters there, away from the
  // handles of its box, at its corners and in the middle of its sides
  const grip = () => {
    const box = boxOf(pages[0]);
    if (!box) return null;
    const bottom = Math.min(box.y + box.h, PAGE[1]);
    return onScreen(0, box.x + box.w * 0.3, (box.y + bottom) / 2);
  };
  let startText = "";
  const stateOf = () => {
    const [one, two] = pages;
    const linked = [one, two].map(textOf).filter((layer) => layer && layer.across);
    const words = linked.map((layer) => layer.params.layerText.textKey);
    const editing = Boolean(App() && App().isEditing());
    const middle = middleOf(one);
    return {
      mode: "state",
      flow: Boolean(App() && App().flow()),
      front: pages.indexOf(app.doc) + 1,
      across: linked.length,
      edited: !editing && linked.length === 2 && words[0] === words[1] && words[0] !== startText,
      onFirst: Boolean(middle) && middle[2] <= PAGE[1],
    };
  };

  const STEPS = [
    { text: "Press {Shift}{F}: Flow mode. The two practice pages are now on one surface, one under the other.", demo: "flow-on", mark: null, done: (d) => d.flow },
    { text: "Scroll down to page 2, or drag with {Space} held: once the view rests, the page in the middle of the screen comes in front.", demo: "flow-wander", mark: () => [seenMiddle(1)], done: (d) => d.flow && d.front === 2 },
    { text: "Click page 1: it comes in front, as it would to work on it.", demo: "flow-click", mark: () => [seenMiddle(0)], done: (d) => d.front === 1 },
    { text: "With the Move tool ({V}), drag the text down into the bubble, across the line where the pages meet: it goes on to page 2 by itself.", demo: "across-drag", mark: () => [grip(), onScreen(0, BUBBLE.x, PAGE[1])], done: (d) => d.across > 0, enter: () => centreOn(0, PAGE[0] / 2, 790) },
    { text: "Double-click the text where it is on page 2, change a word, then press {Esc}: page 1 follows.", demo: "across-type", mark: () => { const m = middleOf(pages[1]); return [m && onScreen(1, m[0], Math.max(20, m[1]))]; }, done: (d) => d.edited, enter: () => centreOn(0, PAGE[0] / 2, 860) },
    { text: "Press {Shift}{T}, the text picked: it stays on its page only, and the other page lets it go.", demo: "across-key", mark: null, done: (d) => d.across === 0 },
    { text: "Press {Shift}{T} again: it goes on to the other page again. That works wherever the pages are, even apart.", demo: "across-key", mark: null, done: (d) => d.across > 0 },
    { text: "Last one: drag the text back up, wholly on page 1: page 2 lets it go.", demo: "across-back", mark: () => [grip(), onScreen(0, START[0], START[1])], done: (d) => d.across === 0 && d.onFirst, enter: () => {
      if (pages[0] && app.doc !== pages[0] && app.docs.includes(pages[0])) App().switchDoc(pages[0]);
      centreOn(0, PAGE[0] / 2, 790);
    } },
  ];

  window.TypeRFlowGuide = Guide.make({
    tool: null,
    ready: () => Boolean(App() && App().flow()),
    store: "typer.web.flow.guide",
    title: "Flow Guide",
    intro: () => T("Every gesture of Flow mode (Shift+F) and Text Across Pages (Shift+T). Page display, in the options bar, sets which way the pages go: right to left, left to right, or top to bottom for a manhwa. Undo works as everywhere: Cmd + Z, on each page."),
    practiceLabel: "Practice (2 min)",
    groups: GROUPS,
    scenes: SCENES,
    steps: STEPS,
    doneText: "You know Flow and Text Across Pages. Every gesture stays in Help → Flow Guide.",
    offerTitle: "New: Flow mode",
    offerBody: "Learn it in 2 minutes, on two pages of its own, with a bubble cut between them? Eight short steps, each passed by doing it.",
    start: async () => {
      const before = App().flowSettings();
      // Solo to start with, the pages top to bottom and touching: put back as they were after
      App().setWorkspace("solo", true);
      App().setFlowLayout({ direction: "down", gap: 0 });
      const name = T("Flow practice");
      const one = ops.imageDocument(pageOne(), `${name} 1.psd`, `new://flow-practice-1-${PS.newId()}`) || app.doc;
      const text = addText();
      startText = text ? text.params.layerText.textKey : "";
      ops.clearActiveLayers();
      const two = ops.imageDocument(pageTwo(), `${name} 2.psd`, `new://flow-practice-2-${PS.newId()}`) || app.doc;
      pages = [one, two];
      App().switchDoc(one);
      App().setTool("move");
      let stopRings = null;
      return {
        page: one,
        others: [two],
        onGesture: (listener) => {
          let last = "";
          const look = () => {
            const state = stateOf();
            const key = JSON.stringify(state);
            if (key === last) return;
            last = key;
            listener(state);
          };
          const stopPage = PS.on(() => queueMicrotask(look));
          // The page in front changes once the view rests, without a step of history
          const timer = setInterval(look, 300);
          return () => {
            stopPage();
            clearInterval(timer);
          };
        },
        setMark: (mark) => {
          if (stopRings) stopRings();
          stopRings = mark ? Guide.rings(() => (typeof mark === "function" ? mark() : mark)) : null;
        },
        restore: () => {
          App().setFlowLayout({ direction: "down", gap: before.gapDown });
          App().setFlowLayout({ direction: before.direction });
          App().setWorkspace(before.workspace, true);
          pages = [];
        },
      };
    },
  });
})();
