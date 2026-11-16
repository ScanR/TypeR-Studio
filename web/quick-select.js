// The Quick Selection Tool (W, pressed once more on the Magic Wand), as in Photoshop: paint over
// an area with a round brush and the selection grows, as the brush goes, to the edges of what is
// under it. A bubble's line or a panel's border stops it, a screentone doesn't break it into
// dots. The first stroke makes a new selection and the next ones add to it; Alt takes away.
//
// This file is what the person sees and does: the stroke, the options bar, the brush's size.
// What the stroke selects is worked out in quick-select-worker.js, away from the page, so the
// brush never waits: while it is drawn, each answer shows the selection so far, and a stroke
// that got ahead is answered for all its points at once. One step of history per stroke.
(function () {
  "use strict";

  const PS = window.TypeRPhotoshop;
  if (!PS) return;
  const { app, ops } = PS;
  const App = () => window.TypeRApp;
  const T = (text) => (window.TypeRApp ? window.TypeRApp.T(text) : text);

  /* ------------------------------ settings ------------------------------ */

  // Its own brush size, as in Photoshop: the one that selects a bubble isn't the one that
  // paints. All layers by default: the page is rarely the active layer while typesetting.
  const STORE = "typer.web.quickSelect";
  const prefs = (() => {
    const out = { size: 30, all: true, enhance: true };
    try {
      Object.assign(out, JSON.parse(window.localStorage.getItem(STORE)) || {});
    } catch (error) {
      // Defaults
    }
    out.size = Math.max(1, Math.min(2000, Math.round(Number(out.size)) || 30));
    return out;
  })();
  const keepPrefs = () => {
    try {
      window.localStorage.setItem(STORE, JSON.stringify(prefs));
    } catch (error) {
      // Only a preference
    }
  };
  // New, then Add once a stroke has selected something, as in Photoshop
  let mode = "new";

  /* ------------------------------ the worker ------------------------------ */

  let worker = null;
  let broken = false;
  let lastJob = 0;
  const jobs = new Map();
  // The page the worker has: sent again only when its pixels changed
  let sentKey = "";
  const stopWorker = (error) => {
    jobs.forEach((job) => job.reject(error));
    jobs.clear();
    if (worker) worker.terminate();
    worker = null;
    sentKey = "";
  };
  const startWorker = () => {
    if (worker || broken) return Boolean(worker);
    try {
      worker = new Worker("quick-select-worker.js");
    } catch (error) {
      console.warn("TypeR web: the Quick Selection Tool's worker didn't start", error);
      broken = true;
      return false;
    }
    worker.onerror = (event) => stopWorker(new Error((event && event.message) || "The Quick Selection Tool's worker stopped."));
    worker.onmessage = ({ data }) => {
      const job = jobs.get(data.id);
      if (!job) return;
      jobs.delete(data.id);
      if (data.error) job.reject(new Error(data.error));
      else job.resolve(data.result);
    };
    return true;
  };
  const ask = (type, payload, transfer) => new Promise((resolve, reject) => {
    if (!startWorker()) {
      reject(new Error("No worker."));
      return;
    }
    const id = ++lastJob;
    jobs.set(id, { resolve, reject });
    worker.postMessage({ id, type, payload }, transfer || []);
  });
  // Gives the worker the page as the tool reads it, unless it has it already. Returns its key.
  const sendPage = () => {
    const source = ops.quickSelectSource(prefs.all);
    if (!source || !startWorker()) return "";
    if (source.key === sentKey) return sentKey;
    sentKey = source.key;
    // The worker keeps its own copy: this one stays the Magic Wand's
    const copy = new Uint8ClampedArray(source.data);
    ask("page", { key: source.key, width: source.width, height: source.height, data: copy.buffer }, [copy.buffer]).catch((error) => {
      console.warn("TypeR web: the Quick Selection Tool couldn't read the page", error);
      sentKey = "";
    });
    return sentKey;
  };

  /* ------------------------------ a stroke ------------------------------ */

  let strokes = 0;
  // A stroke begins from the selection the one before it left: each waits for the last answer
  // of the previous one
  let settled = Promise.resolve();

  // Answers come one at a time: while one is awaited the brush goes on, and the next question
  // is asked with every point there is by then
  const pump = async (stroke) => {
    if (stroke.busy) return;
    stroke.busy = true;
    await stroke.after;
    if (!stroke.begun) {
      stroke.begun = true;
      stroke.before = stroke.doc.state.selection;
      stroke.base = stroke.how === "new" ? null : stroke.before;
    }
    while (!stroke.over) {
      const final = stroke.ended;
      const sent = stroke.points.length;
      if (!final && sent === stroke.shown) break;
      if (stroke.cancelled || app.doc !== stroke.doc) {
        stroke.over = true;
        break;
      }
      let result = null;
      try {
        result = await ask("select", { key: stroke.key, points: Float32Array.from(stroke.points), size: stroke.size, enhance: stroke.enhance, final });
      } catch (error) {
        console.warn("TypeR web: the Quick Selection Tool", error);
        stroke.over = true;
        break;
      }
      if (stroke.cancelled || app.doc !== stroke.doc) {
        stroke.over = true;
        break;
      }
      // The worker was started again, or has another page: this one, then the same question
      if (result && result.stale) {
        if (stroke.resent) {
          stroke.over = true;
          break;
        }
        stroke.resent = true;
        sentKey = "";
        stroke.key = sendPage();
        continue;
      }
      stroke.shown = sent;
      const selection = ops.quickSelection(result, stroke.how, stroke.base, stroke.token, final);
      stroke.applied = true;
      if (final) {
        stroke.over = true;
        // The next stroke adds to this one
        if (selection && stroke.how === "new" && mode === "new") {
          mode = "add";
          if (app.tool === "quickSelect") App().renderOptions();
        }
      }
    }
    stroke.busy = false;
    if (stroke.over) stroke.done();
  };

  // Shift adds and Alt takes away, whatever the options bar says
  const down = (event, point, base) => {
    const doc = app.doc;
    if (!doc || doc.state.quickMask) return null;
    const how = event.altKey ? "subtract" : event.shiftKey ? "add" : mode;
    // Nothing to take away from
    if (how === "subtract" && !doc.state.selection) return null;
    const stroke = Object.assign(base, {
      kind: "quickSelect",
      doc,
      how,
      size: prefs.size,
      enhance: prefs.enhance,
      points: [point[0], point[1]],
      shown: 0,
      token: `gesture:quick:${++strokes}`,
      key: sendPage(),
      after: settled,
    });
    if (!stroke.key) return null;
    settled = new Promise((resolve) => {
      stroke.done = resolve;
    });
    pump(stroke);
    return stroke;
  };
  const move = (stroke, event, toDoc) => {
    const events = event.getCoalescedEvents ? event.getCoalescedEvents() : [];
    (events.length ? events : [event]).forEach((item) => {
      const [x, y] = toDoc(item);
      const n = stroke.points.length;
      // Not a point per pixel: what the brush covers is what counts
      if (Math.hypot(x - stroke.points[n - 2], y - stroke.points[n - 1]) < Math.max(1, stroke.size / 16)) return;
      stroke.points.push(x, y);
    });
    pump(stroke);
  };
  // The selection goes back to what it was before the stroke
  const cancel = (stroke) => {
    if (stroke.over || stroke.cancelled) return;
    stroke.cancelled = true;
    stroke.ended = true;
    if (stroke.applied && app.doc === stroke.doc) ops.quickSelection(null, "add", stroke.before, stroke.token, true);
    pump(stroke);
  };
  const up = (stroke, cancelled) => {
    if (cancelled) {
      cancel(stroke);
      return;
    }
    stroke.ended = true;
    pump(stroke);
  };

  /* ------------------------------ the brush ------------------------------ */

  const size = () => prefs.size;
  const setSize = (value) => {
    prefs.size = Math.max(1, Math.min(2000, Math.round(value) || 1));
    keepPrefs();
    // The ring under the pointer follows at once
    const ring = document.getElementById("brush-ring");
    if (ring && !ring.hasAttribute("hidden") && app.tool === "quickSelect") ring.setAttribute("r", Math.max(1, (prefs.size / 2) * App().view().zoom));
  };
  // [ and ]
  const scale = (factor) => setSize(Math.max(1, prefs.size * factor) + (factor > 1 && prefs.size < 4 ? 1 : 0));

  /* ------------------------------ the options bar ------------------------------ */

  const options = (bar) => {
    const mac = App().setup.IS_MAC;
    const modes = document.createElement("span");
    modes.className = "obar__group";
    [["new", "modeNew", T("New selection")], ["add", "modeAdd", `${T("Add to selection")} (${mac ? "⇧" : "Shift"})`], ["subtract", "modeSub", `${T("Subtract from selection")} (${mac ? "⌥" : "Alt"})`]].forEach(([value, icon, title]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "icon-btn" + (mode === value ? " is-on" : "");
      button.innerHTML = App().ICON[icon];
      button.title = title;
      button.setAttribute("aria-label", title);
      button.setAttribute("aria-pressed", String(mode === value));
      button.addEventListener("click", () => {
        mode = value;
        App().renderOptions();
      });
      modes.appendChild(button);
    });
    bar.appendChild(modes);
    bar.appendChild(App().scrubbed(T("Size"), App().numberInput(prefs.size, 1, 2000, (value) => setSize(value))));
    bar.appendChild(App().checkbox(T("Sample all layers"), prefs.all, (on) => {
      prefs.all = on;
      keepPrefs();
    }));
    bar.appendChild(App().checkbox(T("Auto-Enhance"), prefs.enhance, (on) => {
      prefs.enhance = on;
      keepPrefs();
    }));
  };

  // The tool is taken: the worker gets the page ready before the first stroke
  const toolChosen = (tool) => {
    if (tool === "quickSelect" && app.doc) sendPage();
  };

  window.TypeRQuickSelect = { down, move, up, cancel, options, size, scale, toolChosen };
})();
