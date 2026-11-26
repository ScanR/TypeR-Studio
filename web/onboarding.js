// The setup assistant: on a first start, the choices that matter, one at a time, each one
// skippable. Help → Setup Assistant… brings it back. What changes the panel's files (styles, the
// tutorial) is handed back to app.js as a plan, since those files change only while the panel
// isn't running. The rest is kept as soon as a step is left with Next.

(function () {
  "use strict";

  const STORE = "typer.web.onboarding";
  const App = () => window.TypeRApp;
  const T = (text) => App().T(text);
  const fill = (text, values) => App().fill(text, values);
  // TypeR Studio as an app, on a computer or on a phone: not the web version in a browser
  const INSTALLED = Boolean(window.TypeRDesktop || window.TypeRMobile);
  // A phone or a tablet: no Photoshop beside the app, no mouse, and the menus are in the More sheet
  const touch = () => window.TypeRShell.touch;
  const inMore = (item) => `${T("More")} → ${item}`;
  // Where an item of the Help menu is, as the menu bar says it
  const menu = (item) => {
    const place = `${T("Help")} → ${T(item).replace(/…$/, "")}`;
    return touch() ? inMore(place) : place;
  };

  const read = (key) => {
    try {
      return window.localStorage.getItem(key);
    } catch (error) {
      return undefined;
    }
  };
  const write = (value) => {
    try {
      if (value === null) window.localStorage.removeItem(STORE);
      else window.localStorage.setItem(STORE, value);
    } catch (error) {
      // Without storage it comes back next time, nothing else
    }
  };

  // Due for someone new, or someone it was talking to when the language changed. Someone who
  // used TypeR before it existed has the panel's files, or settings of their own.
  const due = () => {
    const state = read(STORE);
    if (state === undefined || state === "done") return false;
    if (state) return true;
    const Kit = window.TypeRKit;
    const known = Kit.storedPaths().some((path) => Kit.keeps(path))
      || read("typer.web.settings") !== null
      || (window.TypeRStudio && read(window.TypeRStudio.OFFERED) !== null)
      // The apps mark the beta as said for everyone (desktop.js, mobile.js)
      || (!INSTALLED && read("typer.web.betaNotice") !== null);
    if (known) write("done");
    return !known;
  };

  const el = (tag, className, parent, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    if (parent) parent.appendChild(node);
    return node;
  };
  const button = (text, className, parent, action) => {
    const node = el("button", className, parent, text);
    node.type = "button";
    if (action) node.addEventListener("click", action);
    return node;
  };
  const select = (list, value) => {
    const node = document.createElement("select");
    list.forEach(([key, text]) => {
      const option = el("option", null, node, text);
      option.value = key;
    });
    node.value = value;
    return node;
  };
  const field = (parent, text, control, hint) => {
    const label = el("label", "onboard__field", parent);
    el("span", null, label, text);
    label.appendChild(control);
    if (hint) el("small", null, parent, hint).className = "onboard__fieldhint";
    return label;
  };

  // Cards to pick one of: [{ id, title, text, extra(words) }]. `onPick` follows the choice;
  // `pick` makes one from outside.
  const choices = (parent, list, value, onPick) => {
    const box = el("div", "onboard__choices", parent);
    box.setAttribute("role", "radiogroup");
    const cards = list.map((item) => {
      const card = el("div", "onboard__choice", box);
      card.setAttribute("role", "radio");
      card.tabIndex = -1;
      el("span", "onboard__dot", card);
      const words = el("div", "onboard__words", card);
      el("strong", null, words, item.title);
      if (item.text) el("p", null, words, item.text);
      if (item.extra) item.extra(words);
      card.addEventListener("click", (event) => {
        // A field inside the card picks it without losing what is typed
        pick(item.id, !event.target.closest("input, a, button, select"));
      });
      return { item, card };
    });
    const pick = (id, focus) => {
      value = id;
      cards.forEach(({ item, card }) => {
        const on = item.id === id;
        card.classList.toggle("is-on", on);
        card.setAttribute("aria-checked", String(on));
        card.tabIndex = on ? 0 : -1;
        if (on && focus) card.focus();
      });
      onPick(id);
    };
    box.addEventListener("keydown", (event) => {
      if (event.target.closest("input, a, button, select")) return;
      const at = cards.findIndex(({ item }) => item.id === value);
      const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
      if (step) {
        event.preventDefault();
        pick(cards[(at + step + cards.length) % cards.length].item.id, true);
      } else if (event.key === " ") {
        event.preventDefault();
        pick(cards[Math.max(0, at)].item.id, true);
      }
    });
    pick(list.some((item) => item.id === value) ? value : list[0].id, false);
    return { box, pick };
  };

  // A bubble's text selected with the Move tool, with or without its frame and handles: on top
  // of a card's words
  const example = (controls) => (words) => {
    const handles = controls
      ? [[74, 47], [110, 47], [146, 47], [146, 61], [146, 75], [110, 75], [74, 75], [74, 61]]
        .map(([x, y]) => `<rect class="onboard__ex-handle" x="${x - 3}" y="${y - 3}" width="6" height="6"/>`).join("")
      : "";
    // Controls: the arrows that turn it, past a corner. Without: the pointer that drags it.
    const cursor = controls
      ? '<g class="onboard__ex-cursor" transform="translate(155 38)"><path class="onboard__ex-halo" d="M-9 -1A10 10 0 0 1 1 9"/><path d="M-9 -1A10 10 0 0 1 1 9"/><path class="onboard__ex-head" d="M-13 -1L-8 -5.5V3.5ZM1 13L-3.5 8H5.5Z"/></g>'
      : '<path class="onboard__ex-pointer" d="M122 60v15l4-3.5 2.5 5.5 2.2-1-2.5-5.5h5.3z"/>';
    words.insertAdjacentHTML("afterbegin", `<svg class="onboard__example" viewBox="0 0 220 112" aria-hidden="true">
      <rect class="onboard__ex-page" width="220" height="112"/>
      <path class="onboard__ex-bubble" d="M110 24c33 0 58 16 58 37s-25 37-58 37c-7 0-14-1-20-2l-22 12 9-17c-12-7-25-17-25-30 0-21 25-37 58-37z"/>
      <text class="onboard__ex-text" x="110" y="67" text-anchor="middle">TypeR!</text>
      ${controls ? '<rect class="onboard__ex-frame" x="74" y="47" width="72" height="28"/>' : ""}${handles}${cursor}
    </svg>`);
  };

  // A chapter's pages as each workspace shows them: one page under its tabs (Solo), or all of
  // them on one surface in the order they are read (Flow: `rtl`, `ltr` or `down`)
  const workspacePicture = (way) => {
    const sheet = (x, y, w, h, number, on) => `<rect class="onboard__ex-sheet${on ? " is-on" : ""}" x="${x}" y="${y}" width="${w}" height="${h}"/><text class="onboard__ex-number" x="${x + w / 2}" y="${y + h / 2 + 5}" text-anchor="middle">${number}</text>`;
    let inner = "";
    if (way === "solo") {
      inner = [8, 50, 92].map((x, at) => `<rect class="onboard__ex-tab${at ? "" : " is-on"}" x="${x}" y="7" width="38" height="10" rx="2"/>`).join("") + sheet(82, 26, 56, 78, 1, true);
    } else if (way === "down") {
      // One under the other with nothing between, as a manhwa's strips are read
      inner = [70, 42, 14].map((y, at) => sheet(74, y, 72, 28, 3 - at, at === 2)).join("");
    } else {
      const places = [166, 118, 70, 22];
      if (way === "ltr") places.reverse();
      inner = places.map((x, at) => sheet(x, 28, 40, 58, at + 1, at === 0)).join("");
    }
    return `<rect class="onboard__ex-page" width="220" height="112"/>${inner}`;
  };
  const workspaceExample = (way) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "onboard__example");
    svg.setAttribute("viewBox", "0 0 220 112");
    svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = workspacePicture(way);
    return svg;
  };

  // Solo or Flow, as two pictures to pick from: here and in Settings. `more` adds to the Flow
  // card (the way its pages go); show() draws its pages another way.
  const workspaceChoice = (parent, value, way, onPick, more) => {
    const flowPicture = workspaceExample(way);
    const cards = choices(parent, [
      { id: "solo", title: T("Solo mode"), text: T("One page at a time, as in Photoshop. The other pages wait in the tabs."), extra: (words) => words.prepend(workspaceExample("solo")) },
      {
        id: "flow",
        title: T("Flow mode"),
        text: T("Every page of the chapter on one surface, side by side. Move over it freely: the page in the middle of the screen is the one you work on, and the script follows it."),
        extra: (words) => {
          words.prepend(flowPicture);
          if (more) more(words);
        },
      },
    ], value, onPick);
    cards.box.classList.add("onboard__choices--row");
    return { box: cards.box, pick: cards.pick, show: (next) => { flowPicture.innerHTML = workspacePicture(next); } };
  };

  // A bubble with the lines of a paste in it, as bars: made smaller to fit (`shrink`), kept at
  // the style's size and past its edge (`keep`), or in a plain box over it (`classic`)
  const pasteExample = (way) => (words) => {
    const LINES = {
      shrink: [[44, 44], [54, 52], [64, 36]].map(([y, w]) => [y, w, 6]),
      keep: [[34, 116], [50, 140], [66, 120]].map(([y, w]) => [y, w, 12]),
      classic: [[30, 96], [46, 96], [62, 96], [78, 52]].map(([y, w]) => [y, w, 10]),
    };
    const bars = LINES[way].map(([y, w, h]) => `<rect class="onboard__ex-line" x="${110 - w / 2}" y="${y}" width="${w}" height="${h}" rx="${h / 2}"/>`).join("");
    const frame = way === "classic" ? '<rect class="onboard__ex-box" x="58" y="24" width="104" height="70"/>' : "";
    words.insertAdjacentHTML("afterbegin", `<svg class="onboard__example" viewBox="0 0 220 112" aria-hidden="true">
      <rect class="onboard__ex-page" width="220" height="112"/>
      <path class="onboard__ex-bubble" d="M110 18c33 0 58 18 58 40s-25 40-58 40c-7 0-14-1-20-2l-22 12 9-17c-12-7-25-19-25-33 0-22 25-40 58-40z"/>
      ${bars}${frame}
    </svg>`);
  };

  // The panel's Smart paste settings: from TypeR for Photoshop's files when they are to be
  // taken, else from those here. The smallest size is a share of the style's, 0.5 to 1.
  const MIN_SCALE = 0.75;
  const pasteSettingsOf = (state) => {
    const Kit = window.TypeRKit;
    const text = state.styles === "photoshop" && state.photoshop ? state.photoshop.files[`${Kit.ROOT}/storage`] : Kit.read(Kit.activeStoragePath());
    let storage = null;
    try {
      storage = JSON.parse(text || "null");
    } catch (error) {
      storage = null;
    }
    const scale = Number(storage && storage.smartPasteMinScale);
    return {
      on: !storage || storage.smartPaste !== false,
      min: Number.isFinite(scale) && scale > 0 ? Math.round(Math.min(1, Math.max(0.5, scale)) * 100) / 100 : MIN_SCALE,
      // The kind of text a paste makes: paragraph text unless asked otherwise, as in the panel
      point: Boolean(storage && storage.pastePointText),
    };
  };

  // The same line in a bubble as point text and as paragraph text, words typed at its end,
  // as a short film played over and over. Both start as Smart Paste leaves them: lines fitted
  // to the bubble, a return between them. The point text's last line gets longer, past the
  // bubble, until a click before the new sentence and Enter break it there. The paragraph
  // text, in a box as wide as its longest line, breaks it by itself at the box's edge. Both
  // end in the bubble. In English, as What's New's demos.
  const DEMO_LINES = ["Wait… so it was him", "all along?"];
  const DEMO_MORE = " I can’t believe it!";
  const SIZE = 12;
  const LEADING = 14;
  const BUBBLE = { x: 110, y: 58, rx: 92, ry: 50 };
  const REST = [206, 128];
  const textKindDemo = () => {
    const NS = "http://www.w3.org/2000/svg";
    const measure = document.createElement("canvas").getContext("2d");
    const width = (line) => {
      measure.font = `400 ${SIZE}px Wildjess, sans-serif`;
      return measure.measureText(line).width;
    };
    // Lines of no more than `room`, broken between words, a return always breaking
    const wrap = (value, room) => value.split("\n").flatMap((part) => {
      const lines = [];
      part.split(/ +/).filter(Boolean).forEach((word) => {
        const last = lines.length ? `${lines[lines.length - 1]} ${word}` : null;
        if (last !== null && width(last) <= room) lines[lines.length - 1] = last;
        else lines.push(word);
      });
      return lines.length ? lines : [""];
    });
    // Placed so that the three lines it ends with are in the middle of the bubble
    const FROM = BUBBLE.y - LEADING + 4;
    const lineY = (at) => FROM + at * LEADING;
    const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const film = (point) => {
      const svg = document.createElementNS(NS, "svg");
      svg.setAttribute("class", "onboard__example onboard__film");
      svg.setAttribute("viewBox", "0 0 220 124");
      svg.setAttribute("aria-hidden", "true");
      // The mouse and the Enter key, there all along, moved and lit as the film goes
      svg.innerHTML = `<rect class="onboard__ex-page" width="220" height="124"/>
        <path class="onboard__ex-bubble" d="M94 107.2A${BUBBLE.rx} ${BUBBLE.ry} 0 1 0 71.1 103.3L56 121z"/>
        <g class="onboard__film-ink"></g>
        ${point ? `<g class="onboard__ex-key"><rect x="166" y="100" width="46" height="18" rx="3"/><text x="189" y="113" text-anchor="middle">Enter ↵</text></g>
        <g class="onboard__ex-mouse"><circle class="onboard__ex-click" r="7"/><path class="onboard__ex-pointer" d="M0 0v15l4-3.5 2.5 5.5 2.2-1-2.5-5.5h5.3z"/></g>` : ""}`;
      return { svg, ink: svg.querySelector(".onboard__film-ink"), mouse: svg.querySelector(".onboard__ex-mouse") };
    };
    const films = { point: film(true), paragraph: film(false) };
    let box = 0;
    const fit = () => { box = Math.ceil(Math.max(...DEMO_LINES.map(width))) + 2; };
    // What the film shows now: the words typed, whether the point text's line is broken
    // yet, and where the caret is (`end`, `break`, or none)
    const shot = { typed: "", broken: false, caret: "end" };
    const pointLines = () => {
      const lines = DEMO_LINES.slice();
      const more = shot.typed;
      if (shot.broken) lines.push(more.trim());
      else lines[lines.length - 1] += more;
      return lines;
    };
    const ink = (lines, frame, caret) => {
      const words = lines.map((line, at) => `<tspan x="${BUBBLE.x}" y="${lineY(at)}">${escape(line) || " "}</tspan>`).join("");
      const mark = caret ? `<rect class="onboard__ex-caret" x="${caret[0]}" y="${caret[1] - SIZE + 2}" width="1.2" height="${SIZE}"/>` : "";
      return `${frame}<text class="onboard__ex-text onboard__ex-text--small" text-anchor="middle">${words}</text>${mark}`;
    };
    const endOf = (lines) => [BUBBLE.x + width(lines[lines.length - 1]) / 2 + 1.5, lineY(lines.length - 1)];
    // Just before the new sentence, on the long line: where the click goes
    const breakAt = () => {
      const lines = pointLines();
      const line = lines[lines.length - 1];
      const before = DEMO_LINES[DEMO_LINES.length - 1];
      return [BUBBLE.x - width(line) / 2 + width(`${before} `) - 1, lineY(lines.length - 1)];
    };
    const draw = () => {
      const point = pointLines();
      const startOfLast = [BUBBLE.x - width(point[point.length - 1]) / 2 - 2, lineY(point.length - 1)];
      const caret = { end: endOf(point), break: breakAt(), start: startOfLast }[shot.caret];
      films.point.ink.innerHTML = ink(point, "", caret);
      // The paragraph keeps the returns of the paste: only its last line gets longer
      const paragraph = wrap(DEMO_LINES.join("\n") + shot.typed, box);
      const frame = `<rect class="onboard__ex-box" x="${BUBBLE.x - box / 2 - 2}" y="${FROM - SIZE + 1}" width="${box + 4}" height="${paragraph.length * LEADING + 3}"/>`;
      films.paragraph.ink.innerHTML = ink(paragraph, frame, shot.caret ? endOf(paragraph) : null);
    };
    const mouse = (where, shown) => {
      films.point.mouse.style.transform = `translate(${where[0]}px, ${where[1]}px)`;
      films.point.mouse.classList.toggle("is-shown", shown);
    };
    const both = (name, on) => Object.values(films).forEach((one) => one.svg.classList.toggle(name, on));
    fit();
    let timer = 0;
    let alive = true;
    const later = (ms, next) => {
      timer = setTimeout(() => { if (alive) next(); }, ms);
    };
    // The film: the lines as pasted, the words typed one letter at a time, the click and
    // Enter in the point text, a pause on the result, and from the start again
    const play = () => {
      Object.assign(shot, { typed: "", broken: false, caret: "end" });
      mouse(REST, false);
      draw();
      both("is-fading", false);
      let at = 0;
      const type = () => {
        at += 1;
        shot.typed = DEMO_MORE.slice(0, at);
        draw();
        if (at < DEMO_MORE.length) later(65, type);
        else later(700, aim);
      };
      const aim = () => {
        const [x, y] = breakAt();
        mouse([x + 1, y - 5], true);
        later(800, click);
      };
      const click = () => {
        films.point.svg.classList.add("is-clicking");
        shot.caret = "break";
        draw();
        later(450, enter);
      };
      const enter = () => {
        films.point.svg.classList.remove("is-clicking");
        films.point.svg.classList.add("is-pressed");
        later(180, () => {
          shot.broken = true;
          shot.caret = "start";
          draw();
          later(350, () => {
            films.point.svg.classList.remove("is-pressed");
            mouse(REST, false);
            // The result alone, without the caret
            shot.caret = null;
            draw();
            later(2600, () => {
              both("is-fading", true);
              later(400, play);
            });
          });
        });
      };
      later(1300, type);
    };
    const still = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Without motion: how each one ends
    const end = () => {
      Object.assign(shot, { typed: DEMO_MORE, broken: true, caret: null });
      draw();
    };
    if (still) end();
    else play();
    // Measured again once the lettering's font is there
    if (document.fonts && document.fonts.load) document.fonts.load(`400 ${SIZE}px Wildjess`).then(() => { fit(); draw(); }, () => {});
    return {
      point: (words) => words.prepend(films.point.svg),
      paragraph: (words) => words.prepend(films.paragraph.svg),
      stop: () => {
        alive = false;
        clearTimeout(timer);
      },
    };
  };

  /* -------------------------------- the steps -------------------------------- */

  // Each step: { id, when(), title, build(pane, state) → { leave() } }. `leave` keeps what was
  // chosen; it may return false to stop there (the language reloads the page).
  const STEPS = [
    {
      id: "welcome",
      when: () => true,
      title: () => (INSTALLED ? T("Welcome to TypeR Studio") : T("Welcome to TypeR Studio for Web")),
      build(pane, state) {
        const setup = App().setup;
        el("p", "onboard__lead", pane, T("A few choices to get started. Everything can be changed later in Settings."));
        const interfaceLanguage = select(Object.keys(setup.LANGUAGES).map((code) => [code, setup.LANGUAGES[code]]), setup.lang);
        field(pane, T("Interface language"), interfaceLanguage);
        const PS = window.TypeRPhotoshop;
        const textLanguage = select(PS.TEXT_LANGUAGES.map(([name, , own]) => [name, own]), setup.preferences().textLanguage);
        field(pane, T("Language of new text"), textLanguage, T("Used to hyphenate and check the spelling of the text you place."));
        // Chosen by the interface's language until picked here
        const textAtStart = textLanguage.value;
        if (!INSTALLED && !state.again) {
          const beta = el("p", "onboard__note", pane, `${T("The web version of TypeR is still in beta, so some bugs can happen. If you run into one, you can report it on the Discord server.")} `);
          const link = el("a", null, beta, T("Open Discord"));
          link.href = setup.DISCORD;
          link.target = "_blank";
          link.rel = "noopener";
        }
        return {
          leave: () => {
            if (textLanguage.value !== textAtStart) setup.setPreferences({ textLanguage: textLanguage.value });
            if (interfaceLanguage.value === setup.lang) return true;
            // The page comes back in that language, at the next step
            write(JSON.stringify({ resume: "styles", again: state.again }));
            const url = new URL(window.location.href);
            url.searchParams.set("lang", interfaceLanguage.value);
            window.location.href = url.href;
            return false;
          },
        };
      },
    },
    {
      id: "styles",
      when: () => true,
      title: () => T("Your styles"),
      build(pane, state) {
        el("p", "onboard__lead", pane, T("Start from the TypeR styles you already have, or from nothing."));
        const list = [];
        if (state.photoshop) {
          list.push({
            id: "photoshop",
            title: T("Import my TypeR styles from Photoshop"),
            text: T("TypeR for Photoshop is installed on this computer: its styles, folders, settings and shortcuts come along. The plugin keeps its own copy."),
            extra: (words) => {
              if (state.photoshop.styles) el("p", "onboard__meta", words, fill(T("Styles found: {count}"), { count: state.photoshop.styles }));
              // Its files take the place of those here, whole
              if (state.photoshop.replaces) el("p", "onboard__meta onboard__warn", words, T("Replaces the styles and settings you have here now."));
            },
          });
        }
        const input = document.createElement("input");
        input.type = "file";
        // A phone's picker greys out what it doesn't know: no filter there (touch.js)
        if (!touch()) input.accept = ".zip,.json,application/zip,application/json";
        input.multiple = true;
        input.hidden = true;
        pane.appendChild(input);
        let cards = null;
        list.push({
          id: "kit",
          // Found on the computer, Photoshop's styles have their own card: this one is any kit
          // On a phone the file comes from a computer, where TypeR's styles were made
          title: state.photoshop ? T("Import a style kit (.zip)") : touch() ? T("Import my TypeR styles") : T("Import my TypeR styles from Photoshop"),
          text: state.photoshop
            ? T("A file exported from TypeR, in Photoshop or here, with its fonts.")
            : touch()
              ? T("A style file exported from TypeR on a computer, with its fonts. Send it to this device, then choose it here.")
              : T("In Photoshop, open the gear at the bottom of the TypeR panel, then the Data tab and “Export styles or settings”. Choose that file here."),
          extra: (words) => {
            const row = el("div", "onboard__row", words);
            button(T("Choose a File…"), "btn btn--small", row, () => input.click());
            const names = el("span", "onboard__meta", row);
            const show = () => { names.textContent = state.kits ? state.kits.map((file) => file.name).join(", ") : ""; };
            input.addEventListener("change", () => {
              if (input.files.length) state.kits = Array.from(input.files);
              input.value = "";
              show();
              if (state.kits) cards.pick("kit", false);
            });
            show();
            if (touch() && !state.photoshop) el("p", "onboard__meta", words, T("On the computer: the gear at the bottom of the TypeR panel, then the Data tab and “Export styles or settings”."));
          },
        });
        // Run again, with styles already made: nothing is taken away
        list.push(state.ownStyles
          ? { id: "fresh", title: T("Keep my styles"), text: T("Your current styles and settings stay as they are.") }
          : { id: "fresh", title: T("Start fresh"), text: touch() ? fill(T("A “{name}” style is ready to use. Make your own as you go, in Styles."), { name: T("Dialogue") }) : T("Make your styles as you go, in the TypeR panel.") });
        let choice = state.styles || (state.photoshop && !state.photoshop.replaces ? "photoshop" : "fresh");
        cards = choices(pane, list, choice, (id) => { choice = id; });
        return {
          leave: () => {
            // A kit without its file is no choice
            state.styles = choice === "kit" && !state.kits ? "fresh" : choice;
            return true;
          },
        };
      },
    },
    {
      id: "workspace",
      // Not on a touch screen, whose pages are in its top bar
      when: () => Boolean(App().setup.flow),
      title: () => T("Page display"),
      build(pane) {
        const setup = App().setup;
        el("p", "onboard__lead", pane, T("Choose how the pages of a chapter are shown."));
        const was = setup.preferences();
        let mode = was.workspace;
        const direction = select(setup.flow.directions.map(([id, name]) => [id, T(name)]), was.flowDirection);
        direction.setAttribute("aria-label", T("Pages in Flow"));
        const cards = workspaceChoice(pane, mode, was.flowDirection, (id) => { mode = id; }, (words) => el("div", "onboard__row onboard__row--tight", words).appendChild(direction));
        direction.addEventListener("change", () => {
          cards.show(direction.value);
          if (mode !== "flow") cards.pick("flow", false);
        });
        const keys = setup.shortcut("Flow Mode");
        el("p", "onboard__meta", pane, fill(T("You can switch at any time with {menu}."), { menu: `${T("View")} → ${T("Flow Mode")}${keys ? ` (${keys})` : ""}` }));
        return {
          leave: () => {
            setup.setPreferences({ workspace: mode, flowDirection: direction.value });
            return true;
          },
        };
      },
    },
    {
      id: "wheel",
      // Fingers have no wheel
      when: () => !window.TypeRShell.touch,
      title: () => T("Navigation mode"),
      build(pane) {
        const setup = App().setup;
        el("p", "onboard__lead", pane, T("Pick what the wheel does, then try it on the page below."));
        let way = setup.preferences().wheel;
        const HINTS = {
          pan: T("The wheel scrolls up and down. Alt + wheel zooms, Ctrl or Cmd + wheel scrolls sideways. On a trackpad, two fingers scroll and a pinch zooms."),
          zoom: T("The wheel zooms. Alt + wheel scrolls up and down, Shift + wheel sideways. On a trackpad, two fingers zoom too, and so does a pinch."),
          auto: T("A mouse's wheel zooms. Alt + wheel scrolls up and down, Shift + wheel sideways. On a trackpad, two fingers scroll and a pinch zooms."),
        };
        const list = [{ id: "pan", title: T("Like Photoshop") }, { id: "zoom", title: T("Wheel zooms, wheel click moves") }];
        if (!setup.IS_MAC) list.push({ id: "auto", title: T("Mouse zooms, trackpad scrolls") });
        const hint = el("p", "onboard__meta");
        choices(pane, list, way, (id) => {
          way = id;
          hint.textContent = HINTS[id];
        }).box.classList.add("onboard__choices--row");
        pane.appendChild(hint);
        // The practice page, moved as the workspace moves a page
        const pad = el("div", "onboard__pad", pane);
        pad.tabIndex = 0;
        pad.setAttribute("aria-label", T("Try the wheel here, alone or with Alt, Shift, Ctrl or Cmd."));
        const page = el("img", "onboard__page", pad);
        page.src = "panel/assets/typer-practice-page.png";
        page.alt = "";
        page.draggable = false;
        const said = el("span", "onboard__said", pad);
        const tip = el("span", "onboard__tip", pad, T("Try the wheel here, alone or with Alt, Shift, Ctrl or Cmd."));
        const reset = button(T("Reset"), "btn btn--small onboard__reset", pad);
        const view = { x: 0, y: 0, zoom: 1 };
        const percent = new Intl.NumberFormat(setup.lang, { style: "percent" });
        const fit = () => {
          const box = pad.getBoundingClientRect();
          const natural = page.naturalWidth || 1200;
          view.zoom = (box.width * 0.9) / natural;
          view.x = (box.width - natural * view.zoom) / 2;
          view.y = 12;
          draw();
        };
        const draw = () => { page.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`; };
        page.addEventListener("load", fit);
        reset.addEventListener("click", fit);
        requestAnimationFrame(() => { if (page.complete) fit(); });
        let saidTimer = 0;
        const say = (text) => {
          said.textContent = text;
          said.hidden = false;
          clearTimeout(saidTimer);
          saidTimer = setTimeout(() => { said.hidden = true; }, 700);
        };
        said.hidden = true;
        pad.addEventListener("wheel", (event) => {
          event.preventDefault();
          tip.hidden = true;
          const move = setup.wheelGesture(event, way);
          if (move.pan) {
            view.x += move.pan[0];
            view.y += move.pan[1];
            say(move.pan[1] ? T("Scrolls") : T("Scrolls sideways"));
          } else {
            const box = pad.getBoundingClientRect();
            const px = event.clientX - box.left;
            const py = event.clientY - box.top;
            const zoom = Math.max(0.1, Math.min(4, view.zoom * Math.exp(-move.zoom)));
            view.x = px - ((px - view.x) * zoom) / view.zoom;
            view.y = py - ((py - view.y) * zoom) / view.zoom;
            view.zoom = zoom;
            say(`${T("Zooms")} · ${percent.format(zoom)}`);
          }
          draw();
        }, { passive: false });
        // Holding the wheel down drags the page, as in the workspace
        let drag = null;
        pad.addEventListener("pointerdown", (event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          tip.hidden = true;
          drag = { id: event.pointerId, x: event.clientX - view.x, y: event.clientY - view.y };
          pad.setPointerCapture(event.pointerId);
          pad.classList.add("is-panning");
        });
        pad.addEventListener("pointermove", (event) => {
          if (!drag || event.pointerId !== drag.id) return;
          view.x = event.clientX - drag.x;
          view.y = event.clientY - drag.y;
          draw();
        });
        const drop = (event) => {
          if (!drag || event.pointerId !== drag.id) return;
          drag = null;
          pad.classList.remove("is-panning");
        };
        pad.addEventListener("pointerup", drop);
        pad.addEventListener("pointercancel", drop);
        // Keeps the browser from starting its own scrolling on a wheel click
        pad.addEventListener("mousedown", (event) => { if (event.button === 1) event.preventDefault(); });
        pad.addEventListener("auxclick", (event) => { if (event.button === 1) event.preventDefault(); });
        return {
          leave: () => {
            setup.setPreferences({ wheel: way });
            return true;
          },
        };
      },
    },
    {
      id: "transform",
      // On a touch screen the handles are always there
      when: () => !window.TypeRShell.touch,
      title: () => T("Transform Controls"),
      build(pane) {
        const setup = App().setup;
        el("p", "onboard__lead", pane, T("With the Move tool, a frame with handles can appear around the text or image you select."));
        let on = setup.preferences().transformControls;
        const keys = setup.shortcut("Free Transform");
        const menu = `${T("Edit")} → ${T("Free Transform")}${keys ? ` (${keys})` : ""}`;
        choices(pane, [
          { id: "on", title: T("With Transform Controls"), text: T("Drag a handle to resize it, or just outside a corner to rotate it."), extra: example(true) },
          { id: "off", title: T("Without Transform Controls"), text: fill(T("Nothing covers the lettering: drag to move it. {menu} still resizes and rotates it."), { menu }), extra: example(false) },
        ], on ? "on" : "off", (id) => { on = id === "on"; }).box.classList.add("onboard__choices--row");
        el("p", "onboard__meta", pane, fill(T("You can change this at any time with the “{name}” box, in the Move tool's options."), { name: T("Show Transform Controls") }));
        return {
          leave: () => {
            setup.setPreferences({ transformControls: on });
            return true;
          },
        };
      },
    },
    {
      id: "paste",
      when: () => true,
      title: () => T("Smart Paste"),
      build(pane, state) {
        el("p", "onboard__lead", pane, T("When you paste a line into a bubble, TypeR sets it to the bubble's shape. Choose what happens to your style's size."));
        const was = pasteSettingsOf(state);
        const wasWay = !was.on ? "classic" : was.min >= 1 ? "keep" : "shrink";
        let way = wasWay;
        const smallest = document.createElement("input");
        smallest.type = "number";
        smallest.min = "50";
        smallest.max = "100";
        smallest.step = "5";
        smallest.value = String(Math.round((was.min < 1 ? was.min : MIN_SCALE) * 100));
        smallest.className = "onboard__percent";
        smallest.setAttribute("aria-label", T("No smaller than"));
        const percent = () => {
          const value = Math.round(Number(smallest.value));
          return Number.isFinite(value) ? Math.min(100, Math.max(50, value)) : Math.round(MIN_SCALE * 100);
        };
        const cards = choices(pane, [
          {
            id: "shrink",
            title: T("Fit the bubble"),
            text: T("The text keeps your style's size when it fits, and gets smaller in a small bubble."),
            extra: (words) => {
              pasteExample("shrink")(words);
              const row = el("div", "onboard__row onboard__row--tight", words);
              el("span", "onboard__meta", row, T("No smaller than"));
              row.appendChild(smallest);
              el("span", "onboard__meta", row, "%");
            },
          },
          { id: "keep", title: T("Keep the style's size"), text: T("The lines still follow the bubble's shape, but the text never gets smaller: it can go past the edge of a small bubble."), extra: pasteExample("keep") },
          { id: "classic", title: T("Classic paste"), text: T("The text goes in at your style's size, without following the bubble's shape."), extra: pasteExample("classic") },
        ], way, (id) => { way = id; });
        cards.box.classList.add("onboard__choices--row");
        smallest.addEventListener("input", () => { if (way !== "shrink") cards.pick("shrink", false); });
        smallest.addEventListener("change", () => { smallest.value = String(percent()); });
        el("p", "onboard__meta", pane, touch()
          ? fill(T("You can change this at any time in {menu}, under “{name}”."), { menu: inMore(T("TypeR Settings")), name: T("Smart Paste") })
          : fill(T("You can change this at any time in the settings of the TypeR panel (the gear at its bottom), under “{name}”."), { name: T("Smart Paste") }));
        return {
          leave: () => {
            const min = way === "keep" ? 1 : way === "shrink" ? percent() / 100 : was.min;
            // Only what was changed here: what came with the styles stays otherwise
            const changed = way !== wasWay || (way === "shrink" && min !== was.min);
            state.paste = changed ? (way === "classic" ? { smartPaste: false } : { smartPaste: true, smartPasteMinScale: min }) : null;
            return true;
          },
        };
      },
    },
    {
      id: "textKind",
      when: () => true,
      title: () => T("Point or paragraph text"),
      build(pane, state) {
        el("p", "onboard__lead", pane, T("TypeR can paste your lines as point text or as paragraph text. Both look the same at first. The difference shows when words are added:"));
        const was = pasteSettingsOf(state).point;
        let point = was;
        const demo = textKindDemo();
        // What each one is good and bad at, a sign before each so that the colour isn't needed
        const sides = (good, bad) => (words) => {
          const list = el("ul", "onboard__sides", words);
          good.forEach((text) => el("li", "is-good", list, text));
          bad.forEach((text) => el("li", "is-bad", list, text));
        };
        const both = (picture, more) => (words) => {
          picture(words);
          more(words);
        };
        choices(pane, [
          {
            id: "point",
            title: T("Point text"),
            text: T("Each line stays as it is. You choose where it breaks: click, then press Enter."),
            extra: both(demo.point, sides(
              [T("You choose where each line breaks"), T("Lines never move on their own")],
              [T("No hyphenation")],
            )),
          },
          {
            id: "paragraph",
            title: T("Paragraph text"),
            text: T("The text sits in a box: a line too long breaks by itself at its edge, and the box grows."),
            extra: both(demo.paragraph, sides(
              [T("Long lines go to the next line by themselves"), T("Allows hyphenation")],
              [T("A line can break in the wrong spot, leaving one word alone")],
            )),
          },
        ], point ? "point" : "paragraph", (id) => { point = id === "point"; }).box.classList.add("onboard__choices--row");
        // The default chosen here first, then what to do with a text already on a page
        const where = { tab: T("Insertion"), name: T("Type of pasted text layer"), menu: inMore(T("TypeR Settings")) };
        const later = touch()
          ? fill(T("You can change this default at any time in {menu}, under {tab} → “{name}”."), where)
          : fill(T("You can change this default at any time in the TypeR panel settings (the gear at its bottom), under {tab} → “{name}”."), where);
        const toPoint = `${T("Layer")} → ${T("Convert to Point Text")}`;
        const convert = fill(T("To convert text already on a page, use {toPoint} or {toParagraph}."), { toPoint: touch() ? inMore(toPoint) : toPoint, toParagraph: T("Convert to Paragraph Text") });
        el("p", "onboard__meta", pane, `${later} ${convert}`);
        return {
          leave: () => {
            // Only when changed here: what came with the styles stays otherwise
            state.textKind = point !== was ? { pastePointText: point } : null;
            return true;
          },
          gone: demo.stop,
        };
      },
    },
    {
      id: "fonts",
      // The app sees the computer's fonts from the start; a browser asks first
      when: () => !window.TypeRDesktop && !window.TypeRFonts.installedListed(),
      title: () => T("Your fonts"),
      build(pane) {
        const Fonts = window.TypeRFonts;
        const canList = Fonts.canListInstalled();
        // A phone lists no font of its own: the fonts come in from Font FindeR or as files, and
        // stay with TypeR (the app's Fonts window, here)
        if (touch() && !canList) {
          el("p", "onboard__lead", pane, T("Add the fonts you letter with. TypeR keeps them for next time."));
          const fonts = App().setup.fontsBox();
          pane.appendChild(fonts.body);
          el("p", "onboard__meta", pane, `${T("Fonts that come with a style kit are added with it.")} ${fill(T("More fonts can be added at any time in {menu}."), { menu: inMore(T("Fonts")) })}`);
          return { leave: () => true, gone: fonts.stop };
        }
        el("p", "onboard__lead", pane, canList
          ? T("TypeR can use the fonts installed on this computer. The browser asks for your permission once.")
          : T("This browser can't list your fonts: load their files instead (Chrome and Edge can)."));
        const row = el("div", "onboard__row", pane);
        const said = el("p", "onboard__meta", pane);
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".ttf,.otf,.woff,.woff2,.ttc";
        input.multiple = true;
        input.hidden = true;
        pane.appendChild(input);
        const ask = button(canList ? T("Use Installed Fonts…") : T("Load Font Files…"), "btn btn--main", row, async () => {
          if (!canList) {
            input.click();
            return;
          }
          try {
            const count = await Fonts.useInstalled();
            said.textContent = fill(T("{count} installed fonts available."), { count });
            ask.disabled = true;
          } catch (error) {
            said.textContent = T("The browser refused access to your fonts.");
          }
        });
        input.addEventListener("change", async () => {
          const files = Array.from(input.files);
          input.value = "";
          if (!files.length) return;
          const result = await Fonts.addFiles(files);
          said.textContent = fill(T("{count} font(s) loaded."), { count: result.added.length });
        });
        el("p", "onboard__meta", pane, T("Fonts that come with a style kit are added with it."));
        return { leave: () => true };
      },
    },
    {
      id: "generative",
      when: () => Boolean(window.TypeRGenerative),
      title: () => T("Generative Fill"),
      build(pane) {
        const Gen = window.TypeRGenerative;
        const setup = App().setup;
        const saved = Gen.load();
        el("p", "onboard__lead", pane, T("Generative Fill redraws a selection: to clear a page of its lettering, or to fill what's missing. Pick what draws it."));
        const keys = {};
        const cheapest = (service) => Gen.modelsOf(saved, service).map(([id]) => Gen.priceOf(saved, service, id)).filter((one) => one && one.unit === "image" && one.usd > 0).reduce((low, one) => Math.min(low, one.usd), Infinity);
        const keyed = (service) => (words) => {
          const one = Gen.SERVICES[service];
          const models = el("p", "onboard__meta", words, one.models.map(([, name]) => name).join(", "));
          const low = cheapest(service);
          if (Number.isFinite(low)) models.textContent += ` · ${fill(T("From {price} per picture."), { price: setup.money(low) })}`;
          const row = el("div", "onboard__row", words);
          const input = el("input", null, row);
          input.type = "password";
          input.autocomplete = "off";
          input.spellcheck = false;
          input.placeholder = T("Paste the key here");
          input.value = saved.keys[service] || "";
          input.setAttribute("aria-label", `${one.name}: ${T("Paste the key here")}`);
          keys[service] = input;
          const link = el("a", null, row, T("Get a key"));
          link.href = one.keyUrl;
          link.target = "_blank";
          link.rel = "noopener";
        };
        // On this device: LaMa Manga, and in the desktop app FLUX too, picked in a list. What the
        // model is follows the pick; FLUX's size and whether it runs here come from the app.
        const locals = {};
        const localModel = (service) => (words) => {
          const models = Gen.modelsOf(saved, service);
          const about = el("p", null, words);
          let select = null;
          let turn = 0;
          const describe = () => {
            const model = select ? select.value : models[0][0];
            const name = (models.find(([id]) => id === model) || [model, model])[1];
            const mine = ++turn;
            if (!Gen.isFlux(model)) {
              about.textContent = T("LaMa Manga, without a key. It downloads once (234 MB) the first time it's used, then works offline. It takes no prompt: it redraws the selection from what surrounds it.");
              return;
            }
            about.textContent = "";
            Gen.localStatus().catch(() => null).then((now) => {
              if (mine !== turn) return;
              const here = now && now.models && now.models[model];
              if (now && !now.available) about.textContent = setup.cantRunText(now, name);
              else {
                about.textContent = fill(T("{model}, without a key. It downloads once ({size}) the first time it's used, then works offline. It follows your prompt if you write one; without one, it takes the text out."), { model: name, size: setup.sizeText(here ? (here.installed ? here.size : here.download) : 6e9) });
                if (here && here.installed) about.textContent += ` ${T("Already downloaded on this device.")}`;
                about.textContent += ` ${T("It needs a powerful computer: at least 16 GB of memory, and a good graphics card or a recent Mac. A fill then takes about a minute; without them, much longer.")}`;
              }
            });
          };
          if (models.length > 1) {
            const row = el("div", "onboard__row", words);
            select = el("select", null, row);
            select.setAttribute("aria-label", T("Model"));
            models.forEach(([id, text]) => {
              const option = el("option", null, select, text);
              option.value = id;
            });
            select.value = Gen.modelOf(saved, service);
            // The room each one takes on the disk, and whether it's already there
            Promise.all([Gen.localStatus().catch(() => null), Gen.localReady().catch(() => false)]).then(([now, lama]) => {
              Array.from(select.options).forEach((option) => {
                const flux = Gen.isFlux(option.value);
                const here = flux ? now && now.models && now.models[option.value] : { size: Gen.LAMA_SIZE, installed: lama };
                if (here && here.size) option.textContent += ` · ${setup.sizeText(here.size)}${here.installed ? ` · ${T("Downloaded")}` : ""}`;
              });
            });
            select.addEventListener("change", () => {
              describe();
              cards.pick(service, false);
            });
            locals[service] = select;
          }
          // The list first, then what the model picked is
          words.appendChild(about);
          describe();
        };
        // Free and ready without a key comes first
        const services = Object.keys(Gen.SERVICES).sort((a, b) => Number(Gen.isLocal(b)) - Number(Gen.isLocal(a)));
        const adobeAccount = (words) => {
          const status = el("p", "onboard__meta", words, T("Connect your Adobe account to use Firefly."));
          const button = el("button", "btn btn--small", words, T("Connect to Adobe"));
          button.type = "button";
          if (Gen.adobeStatus) {
            Gen.adobeStatus().then((info) => {
              if (info && info.connected) {
                status.textContent = T("Connected to Adobe Firefly");
                button.hidden = true;
              }
            }).catch(() => {});
          }
          button.addEventListener("click", async (event) => {
            event.preventDefault();
            button.disabled = true;
            try {
              const result = await Gen.adobeConnect();
              if (result?.ok) {
                status.textContent = T("Connected to Adobe Firefly");
                button.hidden = true;
              } else status.textContent = T("Adobe connection could not be completed. Try again.");
            } catch { status.textContent = T("Adobe connection could not be completed. Try again."); }
            finally { button.disabled = false; }
          });
        };
        const list = services.map((service) => (Gen.SERVICES[service].account
          ? { id: service, title: Gen.SERVICES[service].name, text: T("Uses your Adobe plan's generative credits. Photoshop can stay closed. Experimental connection to Firefly web."), extra: adobeAccount }
          : Gen.isLocal(service)
          ? { id: service, title: `${setup.serviceName(service)} · ${T("Free of charge")}`, extra: localModel(service) }
          : { id: service, title: Gen.SERVICES[service].name, text: fill(T("Follows a prompt. Your key stays on this device and goes only to {service}, which bills you."), { service: Gen.SERVICES[service].name }), extra: keyed(service) }));
        list.push({ id: "later", title: T("Later"), text: T("Generative Fill asks for it the first time you use it.") });
        let choice = Gen.ready(saved) ? saved.service : "later";
        const cards = choices(pane, list, choice, (id) => {
          choice = id;
          if (keys[id] && !keys[id].value) setTimeout(() => keys[id].focus());
        });
        return {
          leave: () => {
            const now = Gen.load();
            Object.keys(keys).forEach((service) => { now.keys[service] = keys[service].value.trim(); });
            if (locals[choice]) now.models[choice] = locals[choice].value;
            if (choice !== "later") now.service = choice;
            if (!Gen.save(now)) App().toast(setup.keyNotKeptText(), true);
            return true;
          },
        };
      },
    },
    {
      id: "ready",
      when: () => true,
      title: () => T("You're all set"),
      build(pane, state) {
        const later = fill(T("Everything can be changed later in Settings, and this assistant comes back from {menu}."), { menu: menu("Setup Assistant…") });
        // Fingers: what they do on the page, then a page to try them on
        if (touch()) {
          el("p", "onboard__lead", pane, T("On the page, your fingers do the work:"));
          const gestures = el("ul", "onboard__gestures", pane);
          [["tap", T("Tap a bubble: the line of the script goes in.")], ["zoom", T("Two fingers: zoom and move the page.")], ["undo", T("Tap with two fingers to undo, with three to redo.")]].forEach(([icon, text]) => {
            const item = el("li", null, gestures);
            item.innerHTML = App().ICON[icon];
            el("span", null, item, text);
          });
          let start = state.again ? "work" : "practice";
          choices(pane, [
            { id: "practice", title: T("Try it on a practice page"), text: T("A page of empty bubbles and a short script, to paste your first lines.") },
            { id: "work", title: T("Start working"), text: T("Open a page or a chapter from your files.") },
          ], start, (id) => { start = id; });
          el("p", "onboard__meta", pane, later);
          return {
            leave: () => {
              state.practice = start === "practice";
              return true;
            },
          };
        }
        el("p", "onboard__lead", pane, T("How would you like to start?"));
        let choice = state.again ? "start" : "tour";
        choices(pane, [
          { id: "tour", title: T("Take the tutorial"), text: window.TypeRGuide ? T("Short lessons on a practice chapter, in the real workspace: finding your way, cleaning, the script, styles and typesetting.") : T("TypeR walks you through a practice page: load a script, pick a style, then click a bubble to place its line.") },
          { id: "start", title: T("Start working"), text: fill(T("The tutorial stays in {menu}."), { menu: menu("TypeR Tutorial") }) },
        ], choice, (id) => { choice = id; });
        el("p", "onboard__meta", pane, later);
        return {
          leave: () => {
            state.tour = choice === "tour";
            return true;
          },
        };
      },
    },
  ];

  /* ------------------------------- the dialog -------------------------------- */

  let running = null;

  // Resolves with what is left to do: { photoshop, kits, paste, tour, practice }, or null if nothing
  const run = ({ again = false } = {}) => {
    if (running) return running;
    running = (async () => {
      let resume = null;
      try {
        resume = JSON.parse(read(STORE) || "null");
      } catch (error) {
        resume = null;
      }
      const state = { again: Boolean(again || (resume && resume.again)), photoshop: null, kits: null, styles: null, paste: null, textKind: null, tour: false, practice: false };
      // In the app, the plugin's settings are found on the computer and offered even over styles
      // made here (saying so); on the web, its export is imported instead
      if (window.TypeRStudio) state.photoshop = await window.TypeRStudio.findPhotoshopSettings({ overOwn: true }).catch(() => null);
      const Kit = window.TypeRKit;
      state.ownStyles = Kit.storedPaths().some((path) => {
        try {
          return Kit.keeps(path) && (JSON.parse(Kit.read(path)).styles || []).length > 0;
        } catch (error) {
          return false;
        }
      });
      if (!state.again) App().setup.betaSeen();
      const steps = STEPS.filter((step) => step.when(state));
      let at = resume && resume.resume ? Math.max(0, steps.findIndex((step) => step.id === resume.resume)) : 0;
      if (!state.again) write(JSON.stringify({ resume: steps[at].id }));

      const modal = el("dialog", "modal onboard", document.body);
      if (App().setup.lang === "ar") modal.dir = "rtl";
      const head = el("div", "onboard__head", modal);
      const progress = el("div", "onboard__progress", head);
      const count = el("span", "onboard__count", head);
      const skip = button(T("Skip"), "onboard__skip", head);
      const title = el("h2", "onboard__title", modal);
      const pane = el("div", "onboard__pane", modal);
      const foot = el("div", "modal__foot onboard__foot", modal);
      const back = button(T("Back"), "btn", foot);
      const next = button(T("Next"), "btn btn--main", foot);
      steps.forEach(() => el("span", null, progress));
      let current = null;

      const finish = (completed) => {
        if (current && current.gone) current.gone();
        write("done");
        modal.close();
        modal.remove();
        // Skipped on a first start: where to find it, and the tutorial, when wanted
        if (!completed && !state.again) App().toast(fill(T("You'll find this assistant again in {setup}, and the tutorial in {tour}."), { setup: menu("Setup Assistant…"), tour: menu("TypeR Tutorial") }), true);
        const plan = {
          photoshop: state.styles === "photoshop" ? state.photoshop : null,
          kits: state.kits,
          // The panel's Smart paste settings and the kind of text it makes, when changed here
          paste: state.paste || state.textKind ? Object.assign({}, state.paste, state.textKind) : null,
          tour: completed && state.tour,
          // A touch screen's first page: the practice one (touch.js)
          practice: Boolean(completed && state.practice),
        };
        if (state.styles === "fresh" && window.TypeRStudio) {
          try {
            window.localStorage.setItem(window.TypeRStudio.OFFERED, "declined");
          } catch (error) {
            // Asked again next time, nothing else
          }
        }
        return plan;
      };

      return new Promise((resolve) => {
        const show = () => {
          const step = steps[at];
          if (current && current.gone) current.gone();
          pane.textContent = "";
          title.textContent = step.title();
          count.textContent = fill(T("Step {step} of {count}"), { step: at + 1, count: steps.length });
          Array.from(progress.children).forEach((dot, n) => {
            dot.classList.toggle("is-done", n < at);
            dot.classList.toggle("is-on", n === at);
          });
          back.hidden = at === 0;
          next.textContent = at === steps.length - 1 ? T("Get Started") : T("Next");
          skip.hidden = at === steps.length - 1;
          current = step.build(pane, state);
          if (!state.again) write(JSON.stringify({ resume: step.id }));
          const first = pane.querySelector(".onboard__choice.is-on") || pane.querySelector("select, input:not([hidden]), button");
          // In the phone app a focused list opens and a focused field brings the keyboard up
          const quiet = window.TypeRMobile && first && /^(SELECT|INPUT)$/.test(first.tagName);
          ((!quiet && first) || next).focus();
        };
        next.addEventListener("click", () => {
          if (current.leave() === false) return;
          if (at === steps.length - 1) {
            resolve(finish(true));
            return;
          }
          at += 1;
          show();
        });
        back.addEventListener("click", () => {
          at = Math.max(0, at - 1);
          show();
        });
        skip.addEventListener("click", () => resolve(finish(false)));
        // Escape would end it by mistake: Skip says what it does
        modal.addEventListener("cancel", (event) => event.preventDefault());
        // Enter goes on, except where it means something else
        modal.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" || event.isComposing || !event.target.closest(".onboard__choice, input")) return;
          event.preventDefault();
          next.click();
        });
        modal.showModal();
        show();
      });
    })().finally(() => {
      running = null;
    });
    return running;
  };

  window.TypeROnboarding = { due, run, workspaceChoice };
})();
