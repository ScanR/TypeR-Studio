// Generative Fill's debug mode: what each generation sent, what came back and what was kept, with
// the settings that decide them open to change. For tuning a model's results, not for everyday
// work: opened with Ctrl+Alt+Shift+G (Cmd+Alt+Shift+G on a Mac). This file is only fetched then,
// or at the start when the mode was left on (see index.html, which holds the key). Off, it
// changes nothing; on, every generation follows its settings and is kept here.
(() => {
  "use strict";

  const STORE = "typer.web.generative.debug";
  // As Generative Fill works without it
  const DEFAULTS = { reach: 40, snap: true, least: 0, size: "auto", align: true, histogram: false, prompt: "" };
  const KEPT = 6;
  const STAGES = [
    ["sent", "Sent", "The area of the page the model receives"],
    ["mask", "Mask", "The selection, black where the model may draw (only some models receive it)"],
    ["returned", "Returned", "The model's picture, as it came back"],
    ["aligned", "Aligned", "Laid back on the page, before any tone correction"],
    ["final", "Final", "After the tone corrections"],
    ["kept", "Kept", "What goes on the new layer: the selection only"],
  ];

  const state = { on: false, options: Object.assign({}, DEFAULTS) };
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORE)) || {};
    state.on = saved.on === true;
    const o = saved.options || {};
    if (Number.isFinite(o.reach)) state.options.reach = Math.min(100, Math.max(0, Math.round(o.reach)));
    if (["auto", "1K", "2K"].includes(o.size)) state.options.size = o.size;
    if ([0, 1, 2, 4].includes(o.least)) state.options.least = o.least;
    ["snap", "align", "histogram"].forEach((key) => { if (typeof o[key] === "boolean") state.options[key] = o[key]; });
    if (typeof o.prompt === "string") state.options.prompt = o.prompt;
  } catch (error) {
    // Starts off, with the usual settings
  }
  const keep = () => {
    try {
      window.localStorage.setItem(STORE, JSON.stringify(state));
    } catch (error) {
      // Only for this session then
    }
  };

  const runs = [];
  const bySent = new WeakMap();
  let panel = null;
  let pill = null;
  let viewer = null;

  const el = (tag, props, ...children) => {
    const node = document.createElement(tag);
    Object.assign(node, props || {});
    node.append(...children.filter((child) => child !== null && child !== undefined));
    return node;
  };
  const size = (pair) => (pair ? `${pair[0]} × ${pair[1]}` : "?");
  const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

  const forget = (run) => {
    Object.values(run.stages).forEach((stage) => { if (stage.url) URL.revokeObjectURL(stage.url); });
  };

  // A generation under way: `stage(name, picture)` keeps a copy of a canvas or a bitmap,
  // `facts(values)` what is known about it, `end(result)` how it finished
  const begin = (facts) => {
    if (!state.on) return null;
    const run = {
      id: Date.now(),
      at: new Date(),
      options: Object.assign({}, state.options),
      known: Object.assign({}, facts),
      stages: {},
      result: null,
      stage(name, picture) {
        if (!picture || !picture.width || !picture.height) return;
        const copy = el("canvas", { width: picture.width, height: picture.height });
        copy.getContext("2d").drawImage(picture, 0, 0);
        const stage = { width: picture.width, height: picture.height, url: "", at: Date.now() };
        run.stages[name] = stage;
        if (name === "sent") bySent.set(picture, run);
        copy.toBlob((blob) => {
          if (!blob || !runs.includes(run)) return;
          stage.url = URL.createObjectURL(blob);
          render();
        }, "image/png");
      },
      facts(values) {
        Object.assign(run.known, values);
        render();
      },
      end(result) {
        if (run.result) return;
        run.result = Object.assign({ took: Date.now() - run.id }, result);
        render();
      },
    };
    runs.unshift(run);
    runs.splice(KEPT).forEach(forget);
    render();
    return run;
  };

  /* ------------------------------ the panel ------------------------------ */

  const STYLE = `
    .gendebug { position: fixed; right: 12px; bottom: 12px; z-index: 9000; width: 400px; max-width: calc(100vw - 24px); max-height: calc(100vh - 24px); display: flex; flex-direction: column; background: var(--ui-dark, #2c2a2a); color: var(--text, #e3e4e4); border: 1px solid var(--line, #1f1d1d); border-radius: 8px; box-shadow: 0 8px 30px rgba(0,0,0,.5); font: 12px/1.4 system-ui, sans-serif; }
    .gendebug[hidden], .gendebug-pill[hidden], .gendebug-view[hidden] { display: none; }
    .gendebug__head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--line, #1f1d1d); }
    .gendebug__head b { flex: 1; font-size: 13px; }
    .gendebug__body { overflow: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px; }
    .gendebug label { display: flex; align-items: center; gap: 6px; }
    .gendebug__row { display: flex; align-items: center; gap: 8px; }
    .gendebug__row > span:first-child { flex: 0 0 132px; color: var(--muted, #a5a4a4); }
    .gendebug__row input[type=range] { flex: 1; min-width: 0; }
    .gendebug textarea { width: 100%; box-sizing: border-box; min-height: 74px; resize: vertical; background: var(--ui-darker, #232121); color: inherit; border: 1px solid var(--line, #1f1d1d); border-radius: 4px; padding: 6px; font: inherit; }
    .gendebug select, .gendebug button { background: var(--ui, #3a3838); color: inherit; border: 1px solid var(--line, #1f1d1d); border-radius: 4px; padding: 3px 8px; font: inherit; cursor: pointer; }
    .gendebug__hint { color: var(--muted, #a5a4a4); margin: 0; }
    .gendebug__off { opacity: .45; pointer-events: none; }
    .gendebug__run { border-top: 1px solid var(--line, #1f1d1d); padding-top: 8px; display: flex; flex-direction: column; gap: 6px; }
    .gendebug__run h4 { margin: 0; font-size: 12px; display: flex; gap: 6px; }
    .gendebug__run h4 span { color: var(--muted, #a5a4a4); font-weight: 400; }
    .gendebug__facts { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 1px 10px; }
    .gendebug__facts dt { color: var(--muted, #a5a4a4); }
    .gendebug__facts dd { margin: 0; }
    .gendebug__stages { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
    .gendebug__stage { padding: 0; border: 1px solid var(--line, #1f1d1d); background: var(--ui-darker, #232121); border-radius: 4px; overflow: hidden; cursor: zoom-in; text-align: left; }
    .gendebug__stage img { display: block; width: 100%; height: 84px; object-fit: contain; background: #fff; }
    .gendebug__stage span { display: block; padding: 2px 5px; color: var(--muted, #a5a4a4); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .gendebug details summary { cursor: pointer; color: var(--muted, #a5a4a4); }
    .gendebug pre { margin: 4px 0 0; white-space: pre-wrap; word-break: break-word; font: 11px/1.4 ui-monospace, monospace; }
    .gendebug-pill { position: fixed; left: 12px; bottom: 12px; z-index: 9000; background: var(--warn, #e0a030); color: #000; border: 0; border-radius: 999px; padding: 4px 10px; font: 600 11px system-ui, sans-serif; cursor: pointer; }
    .gendebug-view { position: fixed; inset: 0; z-index: 9001; background: rgba(0,0,0,.88); display: flex; flex-direction: column; color: #e3e4e4; font: 12px/1.4 system-ui, sans-serif; }
    .gendebug-view__bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px 10px; }
    .gendebug-view__bar button, .gendebug-view__bar a { background: #3a3838; color: inherit; border: 1px solid #1f1d1d; border-radius: 4px; padding: 4px 10px; font: inherit; cursor: pointer; text-decoration: none; }
    .gendebug-view__bar button.is-on { background: var(--blue, #288edf); color: #fff; }
    .gendebug-view__bar span { flex: 1; color: #a5a4a4; }
    .gendebug-view__stage { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; padding: 0 10px 10px; }
    .gendebug-view__stage img { max-width: 100%; max-height: 100%; object-fit: contain; background: #fff; image-rendering: auto; }
  `;

  const factsOf = (run) => {
    const k = run.known;
    const out = [];
    if (k.model) out.push(["Model", `${k.model}${k.service ? ` (${k.service})` : ""}`]);
    if (k.selection) out.push(["Selection", size(k.selection)]);
    if (k.area) out.push(["Area read", `${size(k.area)}${k.share ? `, the selection is ${Math.round(k.share * 100)}% of it` : ""}`]);
    if (k.sent) out.push(["Sent", `${size(k.sent)}${k.sizeAsked ? `, ${k.sizeAsked} asked` : ""}${k.ratio ? `, shape ${k.ratio}` : ""}`]);
    const back = run.stages.returned;
    if (back) {
      const sent = run.stages.sent;
      out.push(["Returned", `${back.width} × ${back.height}${k.area ? `, ${Math.round((back.width / k.area[0]) * 100)}% of the page's scale` : ""}${sent ? `, in ${seconds(back.at - sent.at)}` : ""}`]);
    }
    const r = run.result;
    if (r && r.outcome === "done") out.push(["Aligned", r.tried ? `${r.how} (${r.tried})` : "in place"]);
    if (r && r.outcome !== "done") out.push(["Ended", `${r.outcome}${r.message ? `: ${r.message}` : ""}`]);
    if (r) out.push(["Total", seconds(r.took)]);
    const o = run.options;
    out.push(["Settings", `margin ${o.reach}%, ${o.least ? `sent at ${o.least} MP at least, ` : ""}${o.snap ? "standard shape" : "own shape"}, size ${o.size}, ${o.align ? "aligned" : "not aligned"}, ${o.histogram ? "levels matched by histogram" : "levels as they came"}`]);
    return out;
  };

  const view = (run, name) => {
    if (!viewer) {
      viewer = el("div", { className: "gendebug-view", hidden: true });
      document.body.append(viewer);
    }
    const names = STAGES.map(([key]) => key).filter((key) => run.stages[key] && run.stages[key].url);
    if (!names.length) return;
    let shown = names.includes(name) ? name : names[0];
    const close = () => {
      viewer.hidden = true;
      window.removeEventListener("keydown", onKey, true);
    };
    const draw = () => {
      const stage = run.stages[shown];
      const label = STAGES.find(([key]) => key === shown);
      const bar = el("div", { className: "gendebug-view__bar" },
        ...names.map((key) => el("button", { type: "button", className: key === shown ? "is-on" : "", textContent: STAGES.find(([k]) => k === key)[1], onclick: () => { shown = key; draw(); } })),
        el("span", { textContent: `${label[2]}. ${stage.width} × ${stage.height}. Left and Right arrows to compare.` }),
        el("a", { href: stage.url, download: `genfill-${run.id}-${shown}.png`, textContent: "Save PNG" }),
        el("button", { type: "button", textContent: "Close", onclick: close }));
      viewer.replaceChildren(bar, el("div", { className: "gendebug-view__stage", onclick: (event) => { if (event.target === event.currentTarget) close(); } }, el("img", { src: stage.url, alt: label[1] })));
    };
    function onKey(event) {
      if (event.key === "Escape") close();
      else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        shown = names[(names.indexOf(shown) + (event.key === "ArrowRight" ? 1 : names.length - 1)) % names.length];
        draw();
      } else return;
      event.preventDefault();
      event.stopPropagation();
    }
    window.addEventListener("keydown", onKey, true);
    viewer.hidden = false;
    draw();
  };

  const runNode = (run) => {
    const done = run.result;
    const node = el("div", { className: "gendebug__run" },
      el("h4", null, run.at.toLocaleTimeString(), el("span", { textContent: done ? (done.outcome === "done" ? "done" : done.outcome) : "running…" })),
      el("dl", { className: "gendebug__facts" }, ...factsOf(run).flatMap(([name, value]) => [el("dt", { textContent: name }), el("dd", { textContent: value })])));
    const stages = STAGES.filter(([key]) => run.stages[key] && run.stages[key].url);
    if (stages.length) {
      node.append(el("div", { className: "gendebug__stages" }, ...stages.map(([key, label, title]) => el("button", { type: "button", className: "gendebug__stage", title, onclick: () => view(run, key) },
        el("img", { src: run.stages[key].url, alt: label }),
        el("span", { textContent: `${label} ${run.stages[key].width} × ${run.stages[key].height}` })))));
    }
    if (run.known.prompt !== undefined) node.append(el("details", null, el("summary", { textContent: "Prompt sent" }), el("pre", { textContent: run.known.prompt || "(none)" })));
    return node;
  };

  let list = null;
  let settingsBox = null;
  const render = () => {
    if (pill) pill.hidden = !state.on || Boolean(panel && !panel.hidden);
    if (!panel || panel.hidden) return;
    settingsBox.classList.toggle("gendebug__off", !state.on);
    // An open "Prompt sent" stays open across a redraw
    const open = new Set(Array.from(list.querySelectorAll("details[open]")).map((node) => node.closest(".gendebug__run").dataset.run));
    list.replaceChildren(...(runs.length ? runs.map((run) => {
      const node = runNode(run);
      node.dataset.run = String(run.id);
      if (open.has(node.dataset.run)) node.querySelectorAll("details").forEach((d) => { d.open = true; });
      return node;
    }) : [el("p", { className: "gendebug__hint", textContent: state.on ? "Run Generative Fill or Remove Text: each generation shows here." : "Turn it on, then run Generative Fill or Remove Text." })]));
  };

  // Its styles, once
  let styled = false;
  const style = () => {
    if (!styled) document.head.append(el("style", { textContent: STYLE }));
    styled = true;
  };
  const showPill = () => {
    if (pill) return;
    style();
    pill = el("button", { type: "button", className: "gendebug-pill", textContent: "Gen debug on", title: "Generative Fill follows its debug settings: open them", hidden: true, onclick: open });
    document.body.append(pill);
  };

  const build = () => {
    style();
    const o = state.options;
    const on = el("input", { type: "checkbox", checked: state.on });
    on.onchange = () => { state.on = on.checked; keep(); render(); };
    const reachValue = el("span", { textContent: `${o.reach}%` });
    const reach = el("input", { type: "range", min: 0, max: 100, step: 5, value: o.reach });
    reach.oninput = () => { o.reach = Number(reach.value); reachValue.textContent = `${o.reach}%`; keep(); };
    const check = (key, text, title) => {
      const input = el("input", { type: "checkbox", checked: o[key] });
      input.onchange = () => { o[key] = input.checked; keep(); };
      return el("label", { title }, input, text);
    };
    const sizePick = el("select", null, ...[["auto", "Auto (2K)"], ["1K", "1K (about 1 megapixel)"], ["2K", "2K (about 4 megapixels)"]].map(([value, text]) => el("option", { value, textContent: text, selected: o.size === value })));
    sizePick.onchange = () => { o.size = sizePick.value; keep(); };
    const leastPick = el("select", null, ...[[0, "As usual (512 px at least)"], [1, "1 megapixel at least"], [2, "2 megapixels at least"], [4, "4 megapixels at least"]].map(([value, text]) => el("option", { value: String(value), textContent: text, selected: o.least === value })));
    leastPick.onchange = () => { o.least = Number(leastPick.value); keep(); };
    const prompt = el("textarea", { value: o.prompt, placeholder: (window.TypeRGenerative && window.TypeRGenerative.DEFAULT_PROMPT) || "", spellcheck: false });
    prompt.oninput = () => { o.prompt = prompt.value; keep(); };
    const reset = el("button", { type: "button", textContent: "Usual settings" });
    reset.onclick = () => {
      Object.assign(o, DEFAULTS);
      keep();
      panel.remove();
      panel = null;
      open();
    };
    settingsBox = el("div", { className: "gendebug__body", style: "padding:0;overflow:visible" },
      el("div", { className: "gendebug__row", title: "How much of the page is read around the selection, as a share of its longest side. Less: the selection gets more of the model's pixels. More: more art to continue and to align on." }, el("span", { textContent: "Margin around" }), reach, reachValue),
      check("snap", "Grow the area to a standard shape (1:1, 4:3, 16:9…)", "Off: the area keeps the shape the margin gives it. Models that only draw standard shapes may then squeeze or crop it."),
      el("div", { className: "gendebug__row", title: "A small area is enlarged to this size before it is sent, so that the model draws at the size it receives rather than enlarging the picture itself. Never over 2048 pixels a side." }, el("span", { textContent: "Picture sent" }), leastPick),
      el("div", { className: "gendebug__row", title: "The size asked of the models that take one (Firefly Image 5, GPT Image, Gemini)" }, el("span", { textContent: "Output size" }), sizePick),
      check("align", "Align the picture on the page", "Off: the picture is laid as it came, stretched to the area"),
      check("histogram", "Match the picture's levels to the page's (histogram)", "Generative Fill no longer does it: over a screentone it sent the greys to white. Its own 'match tones' setting still applies after."),
      el("div", null, el("p", { className: "gendebug__hint", textContent: "Prompt sent when none is typed (empty: the usual one, shown in grey). A typed prompt is sent as usual." }), prompt),
      el("div", null, reset));
    list = el("div", { style: "display:flex;flex-direction:column;gap:10px" });
    const closeButton = el("button", { type: "button", textContent: "Close", onclick: () => { panel.hidden = true; render(); } });
    panel = el("div", { className: "gendebug" },
      el("div", { className: "gendebug__head" }, el("b", { textContent: "Generative Fill debug" }), el("label", null, on, "On"), closeButton),
      el("div", { className: "gendebug__body" }, settingsBox, list));
    // Typing here is not typing a shortcut of the app
    panel.addEventListener("keydown", (event) => event.stopPropagation());
    document.body.append(panel);
    showPill();
  };

  function open() {
    if (!panel) build();
    panel.hidden = false;
    render();
  }
  const toggle = () => {
    if (panel && !panel.hidden) {
      panel.hidden = true;
      render();
    } else open();
  };

  // Left on: said at each start, so its settings don't pass for Generative Fill's own
  const sayOn = () => {
    if (!state.on) return;
    showPill();
    render();
  };
  if (document.body) sayOn();
  else window.addEventListener("DOMContentLoaded", sayOn);

  window.TypeRGenDebug = {
    DEFAULTS,
    get on() { return state.on; },
    begin,
    // The run a generation belongs to, from the picture sent for it
    runOf: (canvas) => (canvas && bySent.get(canvas)) || null,
    open,
    toggle,
  };
})();
