// A tool's guide: every shortcut on one card, each shown by a small looping drawing, and a
// practice of a few steps on a page of its own, each step passed by doing it. The practice is
// offered once, the first time the tool is picked (a panel offers it in itself: see offer);
// the Help menu and the ? of the options bar bring both back. Each tool says what is its own (sfx-guide.js,
// perspective-guide.js, breaks-guide.js): its drawings, its shortcuts, its steps and its
// practice page. This is the rest.

(function () {
  "use strict";

  const PS = window.TypeRPhotoshop;
  const { app } = PS;
  const App = () => window.TypeRApp;
  const T = (text) => (App() ? App().T(text) : text);
  const IS_MAC = /mac/i.test(navigator.platform || "");
  const SVGNS = "http://www.w3.org/2000/svg";
  const STILL = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const el = (tag, className, parent, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    if (parent) parent.appendChild(node);
    return node;
  };

  /* ------------------------------- the keys ------------------------------- */

  // A key as this computer names it; the mouse's part in words
  const MOUSE = { click: "click", drag: "drag", dblclick: "double-click", rclick: "right-click", hover: "hover" };
  const capOf = (token) => {
    if (token === "Cmd") return IS_MAC ? "⌘" : "Ctrl";
    if (token === "Alt") return IS_MAC ? "⌥" : "Alt";
    if (token === "Shift") return IS_MAC ? "⇧" : T("Shift");
    if (token === "Backspace") return IS_MAC ? "⌫" : T("Backspace");
    if (token === "Enter") return IS_MAC ? "↩" : T("Enter");
    if (token === "Esc") return T("Esc");
    if (token === "Space") return T("Space");
    if (token === "PageDown") return T("Page Down");
    if (token === "PageUp") return T("Page Up");
    return token;
  };
  // ["Alt", "drag"]: Alt + drag. "/" between two keys: either one.
  const capsInto = (parent, keys) => {
    keys.forEach((token, index) => {
      if (token === "/") {
        el("span", "sfxg__or", parent, "/");
        return;
      }
      if (index && keys[index - 1] !== "/") el("span", "sfxg__plus", parent, "+");
      if (MOUSE[token]) el("span", "sfxg__mouse", parent, T(MOUSE[token]));
      else el("kbd", "sk__cap", parent, capOf(token));
    });
    return parent;
  };
  const keysText = (keys) => keys.map((token, index) => (token === "/" ? " / " : (index && keys[index - 1] !== "/" ? " + " : "") + (MOUSE[token] ? T(MOUSE[token]) : capOf(token)))).join("");
  // "Hold {Shift} and drag": the keys drawn in the sentence
  const sentence = (parent, text) => {
    String(text).split(/(\{[^{}\s]+\})/).forEach((part) => {
      const key = /^\{([^{}\s]+)\}$/.exec(part);
      if (key) el("kbd", "sk__cap", parent, capOf(key[1]));
      else if (part) parent.appendChild(document.createTextNode(part));
    });
    return parent;
  };

  /* --------------------------- the small drawings --------------------------- */

  // Each drawing is 110 × 44, drawn again and again: a scene is a function of u, 0 → 1 in each
  // loop, that gives the drawing's SVG
  const W = 110;
  const H = 44;
  const ease = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  // 0 for a moment, up to 1, 1 for a moment, back to 0
  const phase = (u) => (u < 0.12 ? 0 : u < 0.55 ? ease((u - 0.12) / 0.43) : u < 0.8 ? 1 : 1 - ease((u - 0.8) / 0.2));
  const notches = (p, n) => Math.round(p * n) / n;
  const between = (u, a, b) => u >= a && u < b;
  const n1 = (value) => Math.round(value * 10) / 10;
  // The pointer, pressed or not
  const pointer = (at, press) => {
    if (!at) return "";
    const [x, y] = at;
    let out = "";
    if (press) out += `<circle cx="${n1(x)}" cy="${n1(y)}" r="4.5" class="sfxg__press"/>`;
    return `${out}<path d="M${n1(x)} ${n1(y)}l0 10.5 2.6-2.4 2.3 4.8 1.8-.9-2.3-4.7 3.6-.3z" class="sfxg__ptr"/>`;
  };

  // One loop of frames for every drawing on screen; none when there is none
  const LOOP = 2600;
  const live = new Map();
  let frame = 0;
  let lastDrawn = 0;
  const tick = (now) => {
    frame = 0;
    live.forEach((scene, node) => { if (!node.isConnected) live.delete(node); });
    if (!live.size) return;
    if (now - lastDrawn > 33) {
      lastDrawn = now;
      const u = (now % LOOP) / LOOP;
      live.forEach((scene, node) => { node.innerHTML = scene(u); });
    }
    frame = requestAnimationFrame(tick);
  };
  const demo = (parent, scene, className) => {
    const node = document.createElementNS(SVGNS, "svg");
    node.setAttribute("viewBox", `0 0 ${W} ${H}`);
    node.setAttribute("class", `sfxg__demo${className ? ` ${className}` : ""}`);
    node.setAttribute("aria-hidden", "true");
    node.innerHTML = scene(0.6);
    parent.appendChild(node);
    if (!STILL) {
      live.set(node, scene);
      if (!frame) frame = requestAnimationFrame(tick);
    }
    return node;
  };

  /* ------------------------------- the practice ------------------------------- */

  // One practice at a time, whichever tool's
  let coach = null;
  const endPractice = () => {
    if (!coach) return;
    const { card, stop, watch, run } = coach;
    coach = null;
    stop();
    clearInterval(watch);
    card.remove();
    window.removeEventListener("resize", placeCard);
    if (run.setMark) run.setMark(null);
    if (run.restore) run.restore();
  };
  const placeCard = () => {
    if (!coach) return;
    const stage = document.getElementById("stage");
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    coach.card.style.left = `${Math.round(rect.left + 12)}px`;
    coach.card.style.bottom = `${Math.round(window.innerHeight - rect.bottom + 12)}px`;
  };
  // Buttons of the card never keep the keys from the page
  const cardButton = (parent, label, action, main) => {
    const node = el("button", `btn${main ? " btn--main" : ""}`, parent, label);
    node.type = "button";
    node.addEventListener("pointerdown", (event) => event.preventDefault());
    node.addEventListener("click", () => {
      node.blur();
      action();
    });
    return node;
  };
  // Rings that pulse over spots of the screen, wherever no tool draws them: `spots()` gives
  // their places, [x, y] in the window, again at each frame. Only those over the page's stage
  // show. Returns what stops them.
  const rings = (spots) => {
    const nodes = [];
    let frame = 0;
    const draw = () => {
      const stage = document.getElementById("stage");
      const box = stage ? stage.getBoundingClientRect() : null;
      const list = box ? (spots() || []).filter((spot) => spot && spot[0] >= box.left && spot[0] <= box.right && spot[1] >= box.top && spot[1] <= box.bottom) : [];
      list.forEach(([x, y], index) => {
        if (!nodes[index]) nodes[index] = el("div", "tg-ring", document.body);
        nodes[index].hidden = false;
        nodes[index].style.left = `${x}px`;
        nodes[index].style.top = `${y}px`;
      });
      nodes.slice(list.length).forEach((node) => { node.hidden = true; });
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      nodes.forEach((node) => node.remove());
    };
  };

  // A page the practice made: nothing to save until the practice changes it
  const unchanged = (page) => {
    if (page && page.history && page.history[page.historyIndex]) page.savedId = page.history[page.historyIndex].id;
  };

  /* --------------------------------- a guide --------------------------------- */

  // spec: {
  //   tool, store: the tool and where the guide remembers it was offered, seen or done;
  //   title, intro(), groups: the card, [title, about, [[keys, label, scene], …]], …;
  //   scenes: { name: (u) => svg }; steps: [{ text, demo, mark, done(detail), enter() }, …];
  //   ready(): whether the offer still has its place when it comes (by default, the tool
  //     still picked);
  //   start(): makes the practice page, the tool ready on it, and resolves to
  //     { page, others, onGesture(listener) → stop, setMark(mark), restore() }, `others` the
  //     practice's other pages, if it has more than one;
  //   doneText, offerTitle, offerBody, practiceLabel
  // }
  const make = (spec) => {
    const remembered = () => {
      try {
        return window.localStorage.getItem(spec.store) || "";
      } catch (error) {
        return "";
      }
    };
    const remember = (value) => {
      try {
        window.localStorage.setItem(spec.store, value);
      } catch (error) {
        // Private window: the offer may come again, nothing else
      }
    };
    const scene = (name) => spec.scenes[name];

    // Every shortcut as one line, for the Keyboard Shortcuts window
    const rows = () => spec.groups.flatMap(([group, , items]) => items.map(([keys, label]) => ({ keys, text: keysText(keys), label: `${T(label)} (${T(group)})` })));

    const show = async () => {
      if (!App()) return;
      const body = el("div", "sfxg");
      const top = el("div", "sfxg__top", body);
      el("p", "sfxg__intro", top, spec.intro().replace(/Cmd/g, IS_MAC ? "Cmd" : "Ctrl"));
      const grid = el("div", "sfxg__grid", body);
      spec.groups.forEach(([title, about, items]) => {
        const box = el("section", "sfxg__group", grid);
        el("h3", "sfxg__title", box, T(title));
        el("p", "sfxg__about", box, T(about));
        items.forEach(([keys, label, name]) => {
          const row = el("div", "sfxg__row", box);
          demo(row, scene(name));
          const text = el("div", "sfxg__text", row);
          capsInto(el("div", "sfxg__keys", text), keys);
          el("div", "sfxg__label", text, T(label));
        });
      });
      const pending = App().dialog({
        title: T(spec.title),
        body,
        cancel: false,
        also: T(spec.practiceLabel),
        ok: T("Close"),
      });
      // Open by now: wider than a question
      const modal = body.closest("dialog");
      if (modal) modal.classList.add("modal--sfxguide");
      const answer = await pending;
      if (answer && answer.also) practise();
    };

    const practise = async () => {
      if (!App()) return;
      endPractice();
      remember("seen");
      const run = await spec.start();
      const { page } = run;
      const pages = [page].concat(run.others || []);
      pages.forEach(unchanged);
      App().renderOptions();
      const STEPS = spec.steps;

      const card = el("div", "sfxg-coach");
      card.setAttribute("role", "status");
      const head = el("div", "sfxg-coach__head", card);
      const count = el("span", "sfxg-coach__count", head);
      const bar = el("div", "sfxg-coach__bar", head);
      const fillBar = el("span", "", bar);
      const text = el("p", "sfxg-coach__text", card);
      const art = el("div", "sfxg-coach__art", card);
      const foot = el("div", "sfxg-coach__foot", card);
      document.body.appendChild(card);
      let at = 0;
      let passing = false;
      let timer = 0;
      // Back one step, from a step or from the last card
      const back = () => {
        if (at <= 0) return;
        clearTimeout(timer);
        passing = false;
        at--;
        render();
      };
      const backButton = () => {
        if (at > 0) cardButton(foot, T("Back"), back).classList.add("sfxg-coach__back");
      };
      const render = () => {
        const step = STEPS[at];
        count.textContent = App().fill(T("Step {n} of {total}"), { n: at + 1, total: STEPS.length });
        fillBar.style.width = `${(at / STEPS.length) * 100}%`;
        text.textContent = "";
        sentence(text, T(step.text));
        art.textContent = "";
        demo(art, scene(step.demo), "sfxg__demo--big");
        foot.textContent = "";
        backButton();
        cardButton(foot, T("Skip this step"), next);
        cardButton(foot, T("Quit"), endPractice);
        card.classList.remove("is-passed");
        run.setMark(step.mark);
        // What a step shows first, if it has to: the view brought where it happens
        if (step.enter) step.enter();
      };
      const finish = () => {
        run.setMark(null);
        remember("done");
        fillBar.style.width = "100%";
        count.textContent = T("Done!");
        text.textContent = T(spec.doneText);
        art.textContent = "";
        foot.textContent = "";
        backButton();
        cardButton(foot, T(pages.length > 1 ? "Keep the pages" : "Keep the page"), endPractice);
        cardButton(foot, T(pages.length > 1 ? "Close the practice pages" : "Close the practice page"), async () => {
          for (const one of pages.filter((item) => app.docs.includes(item))) {
            unchanged(one);
            await App().closeDoc(one);
          }
          endPractice();
        }, true);
      };
      function next() {
        clearTimeout(timer);
        passing = false;
        at++;
        if (at >= STEPS.length) finish();
        else render();
      }
      const stop = run.onGesture((detail) => {
        if (passing || at >= STEPS.length) return;
        const d = Object.assign({ ways: [] }, detail);
        if (!STEPS[at].done(d)) return;
        passing = true;
        card.classList.add("is-passed");
        count.textContent = T("Well done!");
        timer = setTimeout(next, 900);
      });
      // The practice ends with its page
      const watch = setInterval(() => {
        if (coach && page && !app.docs.includes(page)) endPractice();
      }, 500);
      coach = { card, stop, watch, run };
      window.addEventListener("resize", placeCard);
      placeCard();
      render();
    };

    // The first time the tool is picked, once: the practice is offered, never pushed
    const ready = spec.ready || (() => app.tool === spec.tool);
    let offered = false;
    const toolChosen = () => {
      if (offered || coach || window.TypeRShell.touch || remembered()) return;
      offered = true;
      setTimeout(async () => {
        if (!ready() || coach || !App() || document.querySelector("dialog[open]")) {
          offered = false;
          return;
        }
        remember("offered");
        const answer = await App().dialog({
          title: T(spec.offerTitle),
          body: T(spec.offerBody),
          cancel: T("Not now"),
          also: T("See the shortcuts"),
          ok: T("Start the practice"),
        });
        if (!answer) return;
        if (answer.also) show();
        else practise();
      }, 350);
    };

    // For a panel, which shows its offer in itself, without a dialog: its words, whether it is
    // still to be made, and its answer "not now", for good
    const offer = {
      title: () => T(spec.offerTitle),
      body: () => T(spec.offerBody),
      pending: () => !remembered() && !coach,
      decline: () => remember("offered"),
    };

    return { show, practise, toolChosen, offer, rows, capsInto, endPractice };
  };

  window.TypeRToolGuide = { make, rings, el, capOf, capsInto, keysText, sentence, demo, pointer, ease, lerp, phase, notches, between, n1, W, H, endPractice };
})();
