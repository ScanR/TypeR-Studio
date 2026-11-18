// The workspace, arranged as you like: each panel can be dragged by its title bar into a
// column, beside one as a column of its own, or out of them, where it floats and resizes. As
// in Photoshop, there can be any number of columns on either side of the page, panels dropped on
// another's title bar share it as tabs, a double-click on a title bar shrinks the group to it, and
// the double arrow at the top of a column folds it into a strip of icons, each opening its panel
// beside the strip. The panels never change place in the page's HTML, they only get coordinates:
// moving TypeR's iframe in the HTML would reload it.
// Phones and tablets have their own arrangement (touch.js): here, every panel just stays ready.

(function () {
  "use strict";

  const PS = window.TypeRPhotoshop;
  const $ = (id) => document.getElementById(id);
  const STORE = "typer.web.layout";
  const SPLIT = 4;
  const TOOLS = 42;
  const HEAD = 26;
  // The bar at the top of a column, with its double arrow
  const BAR = 14;
  // A column folded into icons, and each of its icons
  const ICONS = 36;
  const ICON = 30;
  const MIN_DOCS = 320;
  const ELEMENTS = { tools: "tools", typer: "dock-typer", layers: "pane-layers", character: "pane-character", sfx: "pane-sfx", breaks: "breaks", history: "pane-history", actions: "pane-actions", styles: "pane-styles", verify: "pane-verify" };
  const PANELS = ["typer", "layers", "character", "sfx", "breaks", "history", "actions", "styles", "verify"];
  const SIDE = ["layers", "character", "sfx", "breaks", "history", "actions", "styles", "verify"];
  const SIDES = ["left", "right"];
  const MIN = { tools: [42, 42], typer: [280, 260], layers: [170, 90], character: [210, 130], sfx: [230, 160], breaks: [210, 120], history: [150, 80], actions: [190, 110], styles: [150, 90], verify: [200, 140] };
  const HEIGHTS = { typer: 600, layers: 290, character: 240, sfx: 420, breaks: 290, history: 180, actions: 260, styles: 220, verify: 320 };
  // How far a drop that makes a new column reaches into what lies on either side of the line:
  // only a sliver of a column, so the rest of it still stacks or floats, more of the page,
  // which is easier to aim at
  const EDGE = 24;
  const PAGE_EDGE = 48;
  // The narrowest a column gets when the window has no room left at all
  const SLIVER = 48;
  const Shell = window.TypeRShell;
  const work = $("work");
  const docs = work.querySelector(".docs");
  const element = (id) => $(ELEMENTS[id]);
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const sum = (list) => list.reduce((total, value) => total + value, 0);

  /* ------------------------------- the arrangement ------------------------------ */

  // A group is one place holding one panel or several as tabs: { tabs, active, h, min }, `h` its
  // height (a share of its column when docked), `min` when shrunk to its title bar. A floating
  // group also has x, y and w.
  const makeGroup = (tabs, h) => ({ tabs, active: tabs[0], h, min: false });

  // The columns stand on either side of the page, each side listed from left to right: `left`
  // from the window's edge to the page, `right` from the page to the window's edge. A column is
  // known by its id, so that a floating panel can go back to it. `icons` when folded into icons;
  // its width is then the one it opens again with.
  const fresh = () => {
    const single = (id) => makeGroup([id], HEIGHTS[id]);
    return {
      version: 3,
      tools: "left",
      toolsAt: null,
      docks: {
        left: [],
        right: [
          { id: "middle", width: 360, icons: false, groups: [single("typer")] },
          { id: "right", width: 250, icons: false, groups: [single("layers"), single("character"), single("sfx"), single("breaks"), makeGroup(["history", "actions"], 220), single("styles"), single("verify")] },
        ],
      },
      // The SFX panel comes with the SFX tool; History, Actions, Styles and Verification wait to be asked for
      hidden: { history: true, sfx: true, actions: true, styles: true, verify: true },
      floats: [],
      // Where each panel was docked last: { column, side, at, before, width, with }
      dockOf: {},
      sideShown: null,
    };
  };

  const allColumns = (from) => from.docks.left.concat(from.docks.right);
  const newColumnId = (from) => {
    let last = 0;
    allColumns(from).forEach((column) => {
      const number = /^c(\d+)$/.exec(column.id || "");
      if (number) last = Math.max(last, Number(number[1]));
    });
    return `c${last + 1}`;
  };

  const record = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
  const size = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback);
  const isRect = (rect) => Boolean(rect) && ["x", "y", "w", "h"].every((key) => Number.isFinite(rect[key]));

  // The first workspaces had three columns: `left` beside the page, `middle` and `right` at the
  // window's right edge. They keep those names as ids, so what the panels remember still holds.
  const fromVersion1 = (saved) => {
    const old = saved.columns;
    if (!old || typeof old !== "object") throw new Error("Not a workspace");
    const column = (name, width) => ({ id: name, width: (old[name] && old[name].width) || width, panels: (old[name] && old[name].panels) || [] });
    const left = column("left", 250);
    const middle = column("middle", 360);
    const right = column("right", 250);
    const dockOf = {};
    const was = saved.dockOf && typeof saved.dockOf === "object" ? saved.dockOf : {};
    Object.keys(was).forEach((id) => {
      if (was[id] === "left") dockOf[id] = { column: "left", side: "left", at: 0, width: left.width };
      if (was[id] === "middle") dockOf[id] = { column: "middle", side: "right", at: 0, width: middle.width };
      if (was[id] === "right") dockOf[id] = { column: "right", side: "right", at: 1, width: right.width };
    });
    return Object.assign({}, saved, { version: 2, docks: { left: [left], right: [middle, right] }, dockOf });
  };

  // Before tab groups, each panel stood alone, in its column or floating
  const fromVersion2 = (saved) => {
    const docks = saved.docks;
    if (!docks || !SIDES.every((side) => Array.isArray(docks[side]))) throw new Error("Not a workspace");
    const heights = record(saved.heights);
    const single = (id) => makeGroup([id], size(heights[id], HEIGHTS[id] || 250));
    const columns = (side) => docks[side].map((column) => {
      if (!column || !Array.isArray(column.panels)) throw new Error("Not a workspace");
      return { id: column.id, width: column.width, groups: column.panels.map(single) };
    });
    const floating = record(saved.floating);
    const order = (Array.isArray(saved.order) ? saved.order : []).filter((id) => floating[id]);
    Object.keys(floating).forEach((id) => { if (!order.includes(id)) order.push(id); });
    const floats = order.filter((id) => id !== "tools" && isRect(floating[id])).map((id) => Object.assign(single(id), floating[id]));
    return Object.assign({}, saved, { version: 3, docks: { left: columns("left"), right: columns("right") }, floats, toolsAt: floating.tools });
  };

  // Whatever a saved file says, every panel ends up in exactly one place, and no column is empty
  const normalize = (saved) => {
    const base = fresh();
    const out = {
      version: 3,
      tools: ["left", "right", "top", "bottom", "float"].includes(saved.tools) ? saved.tools : base.tools,
      toolsAt: isRect(saved.toolsAt) ? { x: saved.toolsAt.x, y: saved.toolsAt.y, w: size(saved.toolsAt.w, TOOLS), h: size(saved.toolsAt.h, TOOLS) } : null,
      docks: { left: [], right: [] },
      hidden: {},
      floats: [],
      dockOf: {},
      sideShown: Array.isArray(saved.sideShown) ? saved.sideShown.filter((id) => SIDE.includes(id)) : null,
    };
    if (out.tools === "float" && !out.toolsAt) out.tools = base.tools;
    if (out.tools !== "float") out.toolsAt = null;
    const hidden = record(saved.hidden);
    PANELS.forEach((id) => { if (hidden[id]) out.hidden[id] = true; });

    const seen = new Set();
    const group = (raw) => {
      if (!raw || !Array.isArray(raw.tabs)) return null;
      const tabs = raw.tabs.filter((id) => PANELS.includes(id) && !seen.has(id));
      if (!tabs.length) return null;
      tabs.forEach((id) => seen.add(id));
      return { tabs, active: tabs.includes(raw.active) ? raw.active : tabs[0], h: size(raw.h, HEIGHTS[tabs[0]]), min: raw.min === true };
    };
    (Array.isArray(saved.floats) ? saved.floats : []).forEach((raw) => {
      if (!isRect(raw)) return;
      const floating = group(raw);
      if (!floating) return;
      const least = Math.max(...floating.tabs.map((id) => MIN[id][0]));
      out.floats.push(Object.assign(floating, { x: raw.x, y: raw.y, w: size(raw.w, least) }));
    });
    // A file this broken is no use: the caller starts afresh
    const docks = saved.docks;
    if (!docks || !SIDES.every((side) => Array.isArray(docks[side]))) throw new Error("Not a workspace");
    const ids = new Set();
    SIDES.forEach((side) => {
      docks[side].forEach((column) => {
        if (!column || !Array.isArray(column.groups)) throw new Error("Not a workspace");
        const groups = column.groups.map(group).filter(Boolean);
        if (!groups.length) return;
        const id = typeof column.id === "string" && column.id && !ids.has(column.id) ? column.id : "";
        ids.add(id);
        out.docks[side].push({ id, width: size(column.width, 250), icons: column.icons === true, groups });
      });
    });
    allColumns(out).forEach((column) => { if (!column.id) column.id = newColumnId(out); });
    PANELS.forEach((id) => {
      if (seen.has(id)) return;
      // A panel this layout never had goes to the column at the far right; the SFX one waits
      // for its tool, the Actions, Styles and Verification ones to be asked for (Window menu)
      if (id === "sfx" || id === "actions" || id === "styles" || id === "verify") out.hidden[id] = true;
      const right = out.docks.right;
      const single = makeGroup([id], HEIGHTS[id]);
      if (right.length) right[right.length - 1].groups.push(single);
      else right.push({ id: newColumnId(out), width: 250, icons: false, groups: [single] });
    });
    const dockOf = record(saved.dockOf);
    Object.keys(dockOf).forEach((id) => {
      const spot = dockOf[id];
      if (!PANELS.includes(id) || !spot || typeof spot.column !== "string" || !SIDES.includes(spot.side)) return;
      out.dockOf[id] = {
        column: spot.column,
        side: spot.side,
        at: Number.isInteger(spot.at) && spot.at >= 0 ? spot.at : 0,
        before: PANELS.includes(spot.before) ? spot.before : null,
        width: size(spot.width, 250),
        with: PANELS.includes(spot.with) ? spot.with : null,
      };
    });
    return out;
  };

  const load = () => {
    try {
      let saved = JSON.parse(window.localStorage.getItem(STORE));
      if (!saved || typeof saved !== "object") return fresh();
      if (saved.version === 1) saved = fromVersion1(saved);
      if (saved.version === 2) saved = fromVersion2(saved);
      if (saved.version !== 3) return fresh();
      return normalize(saved);
    } catch (error) {
      return fresh();
    }
  };

  let layout = load();
  const save = () => {
    try {
      window.localStorage.setItem(STORE, JSON.stringify(layout));
    } catch (error) {
      console.warn("TypeR web: could not keep the workspace", error);
    }
  };

  /* ------------------------------ finding a panel ------------------------------ */

  // The group shown beside its column of icons, and a tab being dragged out of its group: the
  // group goes on without it meanwhile
  let flyout = null;
  let pulled = null;
  // The tools hidden with Tab: back with the next Tab or a reload, never kept out of sight
  let toolsOff = false;

  const isOpen = (id) => !layout.hidden[id];
  const tabsOf = (group) => group.tabs.filter((id) => isOpen(id) && id !== pulled);
  const frontOf = (group) => {
    const tabs = tabsOf(group);
    return tabs.includes(group.active) ? group.active : tabs[0];
  };
  const shownIn = (column) => column.groups.filter((group) => tabsOf(group).length);
  const findColumn = (id) => allColumns(layout).find((column) => column.id === id);
  // { group, column, side } for a docked panel, { group, column: null } for a floating one
  const locate = (id) => {
    for (const side of SIDES) {
      for (const column of layout.docks[side]) {
        const group = column.groups.find((item) => item.tabs.includes(id));
        if (group) return { group, column, side };
      }
    }
    const group = layout.floats.find((item) => item.tabs.includes(id));
    return group ? { group, column: null, side: null } : null;
  };
  const widest = (group) => Math.max(0, ...tabsOf(group).map((id) => MIN[id][0]));
  const tallest = (group) => Math.max(0, ...tabsOf(group).map((id) => MIN[id][1]));
  const activate = (group, id) => {
    if (group.active === id) return;
    group.back = group.active;
    group.active = id;
  };

  /* --------------------------------- drawing it --------------------------------- */

  let T = (text) => text;
  let geometry = { columns: {}, seams: [], loose: [], docs: null, width: 0, height: 0 };
  const POSITION = ["left", "top", "width", "height", "zIndex"];
  const place = (el, x, y, w, h) => {
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
    el.style.width = `${Math.round(w)}px`;
    el.style.height = `${Math.round(h)}px`;
  };

  // Everything that follows a drag runs on the window: the splitters are drawn again as they move
  const dragging = (event, onMove, onEnd) => {
    work.classList.add("is-arranging");
    event.preventDefault();
    const stop = (next) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      work.classList.remove("is-arranging");
      if (onEnd) onEnd(next);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  // The splitters, the columns' bars and their icons are made again each time
  const addPart = (tag, className, x, y, w, h) => {
    const part = document.createElement(tag);
    part.className = `ws-part ${className}`;
    place(part, x, y, w, h);
    work.appendChild(part);
    return part;
  };
  const addSplit = (kind, x, y, w, h, onDown) => {
    const split = addPart("div", `ws-split ws-split--${kind}`, x, y, w, h);
    if (onDown) split.addEventListener("pointerdown", onDown);
    else split.classList.add("is-fixed");
  };

  const ICON_PATHS = {
    typer: '<path d="M3 3.500h10M8 3.500V13M6 13h4"/>',
    layers: '<path d="M8 2.500l5.500 3-5.500 3-5.500-3z"/><path d="M2.500 8.500l5.500 3 5.500-3"/><path d="M2.500 11.500l5.500 3 5.500-3"/>',
    character: '<path d="M2.500 13.500L6.500 3h1l4 10.500"/><path d="M4.200 9.500h5.600"/><path d="M12 13.500h2"/>',
    sfx: '<path d="M9.500 1.500L4 9h4l-1.500 5.500L12 7H8z"/>',
    breaks: '<path d="M2.500 3.500h11M2.500 7h8.500a2 2 0 0 1 0 4H6"/><path d="M7.500 9.500L6 11l1.500 1.500"/>',
    history: '<path d="M2.500 3.500h11M2.500 7h5M2.500 10.500h5"/><path d="M13.500 9.500a3 3 0 1 1-1-2.200"/><path d="M12.700 5.600v1.900h-1.900"/>',
    actions: '<path d="M5 3l8 5-8 5z"/>',
    styles: '<rect x="2.500" y="2.500" width="11" height="11" rx="1"/><path d="M2.500 13.500l11-11"/>',
    verify: '<circle cx="8" cy="8" r="5.500"/><path d="M5.500 8.200l1.800 1.800 3.300-3.600"/>',
  };
  const svg = (paths) => `<svg viewBox="0 0 16 16" aria-hidden="true">${paths}</svg>`;
  // Toward the page or toward the window's edge
  const ARROWS = { left: svg('<path d="M8 4L4 8l4 4M12.500 4L8.500 8l4 4"/>'), right: svg('<path d="M3.500 4l4 4-4 4M8 4l4 4-4 4"/>') };

  const titleOf = (id) => {
    const head = element(id).querySelector(".dock__head");
    const title = head && head.firstElementChild;
    return (title && title.textContent.trim()) || id;
  };

  // A group of several panels shows their names as tabs, in its front panel's title bar
  const drawTabs = (group, el) => {
    const head = el.querySelector(".dock__head");
    const bar = head && head.querySelector(".ws-tabs");
    if (!bar) return;
    const tabs = tabsOf(group);
    const front = frontOf(group);
    const many = tabs.length > 1;
    head.classList.toggle("is-tabbed", many);
    const sign = many ? `${tabs.map((id) => `${id}:${titleOf(id)}`).join("|")}>${front}` : "";
    if (bar.dataset.sign === sign) return;
    bar.dataset.sign = sign;
    bar.textContent = "";
    if (!many) return;
    tabs.forEach((id) => {
      const tab = document.createElement("div");
      tab.className = "ws-tab";
      tab.classList.toggle("is-active", id === front);
      tab.dataset.panel = id;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(id === front));
      tab.tabIndex = id === front ? 0 : -1;
      const label = document.createElement("span");
      label.className = "ws-tab__label";
      label.textContent = titleOf(id);
      const close = document.createElement("button");
      close.type = "button";
      close.className = "tab__close";
      close.textContent = "×";
      close.title = T("Close");
      close.setAttribute("aria-label", `${T("Close")} ${titleOf(id)}`);
      close.addEventListener("click", () => setVisible(id, false));
      tab.append(label, close);
      bar.appendChild(tab);
    });
  };

  const setIcons = (column, on) => {
    column.icons = on;
    if (flyout && column.groups.includes(flyout)) flyout = null;
    apply();
    save();
  };

  // The bar over a column folds it into icons: its double arrow points to the window's edge
  const addBar = (column, side, x, y, w) => {
    const bar = addPart("div", "ws-bar", x, y, w, BAR);
    bar.dataset.side = side;
    const fold = document.createElement("button");
    fold.type = "button";
    fold.className = "ws-bar__fold";
    fold.innerHTML = ARROWS[side];
    fold.title = T("Collapse to Icons");
    fold.setAttribute("aria-label", fold.title);
    fold.addEventListener("click", () => setIcons(column, true));
    bar.appendChild(fold);
    bar.addEventListener("dblclick", (event) => {
      if (!event.target.closest("button")) setIcons(column, true);
    });
  };

  // A folded column: one icon per panel, by groups, each opening its panel beside the strip
  const addStrip = (column, side, x, top, height, parts) => {
    const strip = addPart("div", "ws-strip", x, top, ICONS, height);
    strip.dataset.side = side;
    const unfold = document.createElement("button");
    unfold.type = "button";
    unfold.className = "ws-strip__unfold";
    unfold.innerHTML = ARROWS[side === "right" ? "left" : "right"];
    unfold.title = T("Expand Panels");
    unfold.setAttribute("aria-label", unfold.title);
    unfold.addEventListener("click", () => setIcons(column, false));
    strip.appendChild(unfold);
    let y = BAR + 3;
    shownIn(column).forEach((group) => {
      const tabs = tabsOf(group);
      const h = tabs.length * ICON + 4;
      const block = document.createElement("div");
      block.className = "ws-strip__group";
      block.style.top = `${y}px`;
      block.style.height = `${h}px`;
      tabs.forEach((id) => {
        const on = flyout === group && frontOf(group) === id;
        const icon = document.createElement("button");
        icon.type = "button";
        icon.className = "ws-icon";
        icon.classList.toggle("is-on", on);
        icon.innerHTML = svg(ICON_PATHS[id]);
        icon.title = titleOf(id);
        icon.setAttribute("aria-label", icon.title);
        icon.setAttribute("aria-pressed", String(on));
        icon.addEventListener("click", () => {
          if (on) flyout = null;
          else {
            activate(group, id);
            flyout = group;
          }
          apply();
          save();
        });
        block.appendChild(icon);
      });
      strip.appendChild(block);
      parts.push({ group, y: top + y, h, join: h });
      y += h + 4;
    });
  };

  // A column's splitter is on its side facing the page: left of the page, it widens to the
  // right; right of it, to the left
  const widthSplit = (id, sign) => (event) => {
    const start = event.clientX;
    const column = findColumn(id);
    const from = geometry.columns[id].w;
    const least = Math.max(...shownIn(column).map(widest));
    dragging(event, (next) => {
      column.width = clamp(from + sign * (next.clientX - start), least, 900);
      apply();
    }, save);
  };

  const heightSplit = (id, above, below) => (event) => {
    const start = event.clientY;
    geometry.columns[id].parts.forEach((part) => { if (!part.group.min) part.group.h = part.h; });
    const a = above.h;
    const b = below.h;
    dragging(event, (next) => {
      const moved = clamp(next.clientY - start, tallest(above) - a, b - tallest(below));
      above.h = a + moved;
      below.h = b - moved;
      apply();
    }, save);
  };

  // The groups of a column, one under the other, below its bar. A group shrunk to its title bar
  // keeps only that; the others share the rest.
  const stack = (column, x, w, top, height, plan, parts) => {
    const groups = shownIn(column);
    const open = groups.filter((group) => !group.min);
    const room = Math.max(0, height - BAR - SPLIT * (groups.length - 1) - HEAD * (groups.length - open.length));
    const total = sum(open.map((group) => group.h)) || 1;
    let left = room;
    let given = 0;
    let y = top + BAR;
    groups.forEach((group, index) => {
      let h = HEAD;
      if (!group.min) {
        given += 1;
        h = given === open.length ? left : Math.max(0, Math.round((group.h / total) * room));
        left -= h;
      }
      plan.push({ group, x, y, w, h, how: "docked" });
      parts.push({ group, y, h, join: HEAD });
      y += h;
      const next = groups[index + 1];
      if (next) {
        addSplit("h", x, y, w, SPLIT, !group.min && !next.min ? heightSplit(column.id, group, next) : null);
        y += SPLIT;
      }
    });
  };

  // Between two sets of widths, the one that fills `room`
  const between = (high, low, room) => {
    const span = sum(high) - sum(low);
    const share = span > 0 ? clamp((room - sum(low)) / span, 0, 1) : 0;
    return high.map((width, index) => low[index] + (width - low[index]) * share);
  };

  // Columns give way before the page does, from the gentlest to the hardest: first what each
  // column has beyond what its panels need, then down to a sliver. Only then does the page go
  // below its own minimum, and at last the slivers themselves, so nothing leaves the window.
  // A column of icons keeps its width.
  const fit = (columns, across) => {
    const splits = SPLIT * columns.length;
    const wanted = columns.map((column) => (column.icons ? ICONS : column.width));
    const floors = columns.map((column, index) => (column.icons ? ICONS : Math.min(wanted[index], Math.max(...shownIn(column).map(widest)))));
    const slivers = floors.map((width, index) => (columns[index].icons ? ICONS : Math.min(width, SLIVER)));
    const room = across - splits - MIN_DOCS;
    let widths = slivers;
    if (sum(wanted) <= room) widths = wanted;
    else if (sum(floors) <= room) widths = between(wanted, floors, room);
    else if (sum(slivers) <= room) widths = between(floors, slivers, room);
    else if (sum(slivers) > across - splits) widths = between(slivers, slivers.map(() => 0), Math.max(0, across - splits));
    return widths.map(Math.round);
  };

  // The lines where a dropped panel makes a new column: between two neighbours (the window's
  // edge, a column, the page), each line with how far it reaches into them
  const seamsOf = (blocks, docsIndex) => {
    const reach = (block) => {
      if (block.kind === "edge") return block.x1 - block.x0;
      if (block.kind === "docs") return Math.min(PAGE_EDGE, block.x1 - block.x0);
      return Math.min(EDGE, (block.x1 - block.x0) / 4);
    };
    const seams = [];
    for (let index = 0; index < blocks.length - 1; index++) {
      const a = blocks[index];
      const b = blocks[index + 1];
      seams.push({
        side: index < docsIndex ? "left" : "right",
        before: b.kind === "column" ? b.id : null,
        x: (a.x1 + b.x0) / 2,
        x0: a.x1 - reach(a),
        x1: b.x0 + reach(b),
      });
    }
    return seams;
  };

  // A panel being dragged: drawing the workspace again leaves it where the pointer has it
  let moving = null;

  const apply = () => {
    const touch = Shell.touch;
    work.classList.toggle("is-custom", !touch);
    work.querySelectorAll(".ws-part").forEach((part) => part.remove());
    if (touch) {
      PANELS.forEach((id) => {
        const el = element(id);
        el.hidden = false;
        el.classList.remove("is-flyout", "is-min");
        const head = el.querySelector(".dock__head");
        if (head) head.classList.remove("is-tabbed");
      });
      Object.keys(ELEMENTS).map(element).concat(docs).forEach((el) => {
        POSITION.forEach((key) => { el.style[key] = ""; });
        el.classList.remove("is-floating");
      });
      element("tools").hidden = false;
      PS.announce("workspace");
      return;
    }
    const W = work.clientWidth;
    const H = work.clientHeight;
    geometry = { columns: {}, seams: [], loose: [], docs: null, width: W, height: H };

    let from = 0;
    let to = W;
    let top = 0;
    let bottom = H;
    const tools = element("tools");
    // Out of sight with Tab, as in Photoshop: the page takes its room
    const toolsAt = toolsOff ? null : layout.tools;
    tools.hidden = toolsOff;
    tools.dataset.place = layout.tools;
    tools.classList.toggle("is-floating", layout.tools === "float");
    // At the top or the bottom, the tools lie in a row across the whole window
    tools.setAttribute("aria-orientation", layout.tools === "top" || layout.tools === "bottom" ? "horizontal" : "vertical");
    tools.style.zIndex = "";
    if (toolsAt === "left") {
      place(tools, 0, 0, TOOLS, H);
      from = TOOLS;
    } else if (toolsAt === "right") {
      place(tools, W - TOOLS, 0, TOOLS, H);
      to = W - TOOLS;
    } else if (toolsAt === "top") {
      place(tools, 0, 0, W, TOOLS);
      top = TOOLS;
    } else if (toolsAt === "bottom") {
      place(tools, 0, H - TOOLS, W, TOOLS);
      bottom = H - TOOLS;
    }
    const tall = bottom - top;
    geometry.top = top;
    geometry.bottom = bottom;

    if (flyout) {
      const where = locate(frontOf(flyout) || "");
      if (!where || !where.column || !where.column.icons) flyout = null;
    }
    // Where each group shows, decided before any panel is shown or hidden: a panel hidden and
    // shown again in between would lose its scroll
    const plan = [];
    const lay = (column, side, x, w) => {
      const parts = [];
      if (column.icons) addStrip(column, side, x, top, tall, parts);
      else {
        addBar(column, side, x, top, w);
        stack(column, x, w, top, tall, plan, parts);
      }
      geometry.columns[column.id] = { id: column.id, x, w, icons: column.icons, parts, top, bottom };
      const open = parts.find((part) => part.group === flyout);
      if (!open) return;
      const fw = Math.round(clamp(column.width, widest(flyout), Math.max(widest(flyout), W - ICONS - 8)));
      const fh = Math.round(clamp(flyout.h, Math.min(tallest(flyout), tall), tall));
      const fx = clamp(side === "right" ? x - fw - 2 : x + ICONS + 2, 0, Math.max(0, W - fw));
      plan.push({ group: flyout, x: fx, y: clamp(open.y - 3, top, bottom - fh), w: fw, h: fh, how: "flyout", side, z: 30 });
    };

    const lefts = layout.docks.left.filter((column) => shownIn(column).length);
    const rights = layout.docks.right.filter((column) => shownIn(column).length);
    const widths = fit(lefts.concat(rights), to - from);
    const blocks = [{ kind: "edge", x0: 0, x1: from }];
    let x = from;
    lefts.forEach((column, index) => {
      const w = widths[index];
      lay(column, "left", x, w);
      addSplit("v", x + w, top, SPLIT, tall, column.icons ? null : widthSplit(column.id, 1));
      blocks.push({ kind: "column", id: column.id, x0: x, x1: x + w });
      x += w + SPLIT;
    });
    const docsFrom = x;
    const placed = [];
    x = to;
    for (let index = rights.length - 1; index >= 0; index--) {
      const column = rights[index];
      const w = widths[lefts.length + index];
      lay(column, "right", x - w, w);
      addSplit("v", x - w - SPLIT, top, SPLIT, tall, column.icons ? null : widthSplit(column.id, -1));
      placed.unshift({ kind: "column", id: column.id, x0: x - w, x1: x });
      x -= w + SPLIT;
    }
    const docsTo = Math.max(docsFrom, x);
    place(docs, docsFrom, top, docsTo - docsFrom, tall);
    const docsIndex = blocks.length;
    blocks.push({ kind: "docs", x0: docsFrom, x1: docsTo }, ...placed, { kind: "edge", x0: to, x1: W });
    geometry.seams = seamsOf(blocks, docsIndex);
    geometry.docs = { x: docsFrom, w: docsTo - docsFrom };
    geometry.from = from;
    geometry.to = to;

    layout.floats.forEach((group, index) => {
      if (!tabsOf(group).length) return;
      const w = Math.min(group.w, W);
      const h = group.min ? HEAD : Math.min(group.h, H);
      plan.push({ group, x: clamp(group.x, 80 - w, W - 80), y: clamp(group.y, 0, H - HEAD), w, h, how: "float", z: 12 + index });
    });
    if (toolsAt === "float") {
      const rect = layout.toolsAt;
      const w = Math.min(rect.w, W);
      const h = Math.min(rect.h, H);
      tools.style.zIndex = 12 + layout.floats.length;
      place(tools, clamp(rect.x, 80 - w, W - 80), clamp(rect.y, 0, H - HEAD), w, h);
    }

    const shown = new Set(plan.map((spot) => frontOf(spot.group)));
    PANELS.forEach((id) => {
      const el = element(id);
      if (el !== moving) el.hidden = !shown.has(id);
    });
    plan.forEach((spot) => {
      const el = element(frontOf(spot.group));
      if (el === moving) return;
      el.classList.toggle("is-floating", spot.how !== "docked");
      el.classList.toggle("is-flyout", spot.how === "flyout");
      el.classList.toggle("is-min", spot.group.min && spot.how !== "flyout");
      el.dataset.from = spot.side || "";
      el.style.zIndex = spot.z || "";
      place(el, spot.x, spot.y, spot.w, spot.h);
      drawTabs(spot.group, el);
    });
    // What floats, the topmost first, takes a drop before the columns under it
    geometry.loose = plan.filter((spot) => spot.how !== "docked").sort((a, b) => b.z - a.z);

    PANELS.forEach((id) => {
      const button = element(id).querySelector(".dock__float");
      if (!button) return;
      const where = locate(id);
      const floating = Boolean(where) && !where.column;
      button.classList.toggle("is-on", floating);
      button.title = T(floating ? "Dock" : "Detach");
      button.setAttribute("aria-label", button.title);
    });
    PS.announce("workspace");
  };

  /* ------------------------------- moving a panel ------------------------------- */

  const hintBox = document.createElement("div");
  hintBox.className = "ws-hint";
  hintBox.hidden = true;

  // Out of its column, a panel remembers where it was, to go back there when docked again: its
  // place, and the panel it shared a group with
  const remember = (id, where, group) => {
    if (!where || !where.column) return;
    const list = layout.docks[where.side];
    const groups = where.column.groups;
    const next = groups[groups.indexOf(where.group) + 1];
    const mate = group ? group.tabs.find((tab) => tab !== id) : null;
    layout.dockOf[id] = { column: where.column.id, side: where.side, at: list.indexOf(where.column), before: next ? next.tabs[0] : null, width: where.column.width, with: mate || null };
  };

  // A whole group out of where it is
  const lift = (group) => {
    const where = locate(group.tabs[0]);
    if (!where) return;
    if (where.column) {
      group.tabs.forEach((id) => remember(id, where, null));
      where.column.groups.splice(where.column.groups.indexOf(where.group), 1);
    } else layout.floats.splice(layout.floats.indexOf(group), 1);
    delete group.x;
    delete group.y;
    delete group.w;
  };

  // One tab out of its group, which stays where it is: a new group of its own
  const pullOut = (id) => {
    const where = locate(id);
    const group = where.group;
    remember(id, where, group);
    group.tabs.splice(group.tabs.indexOf(id), 1);
    if (group.active === id) group.active = group.back && group.tabs.includes(group.back) ? group.back : group.tabs[0];
    return makeGroup([id], group.h);
  };

  // A column lasts as long as it holds a panel, even a hidden one: it comes back with it
  const tidy = () => {
    SIDES.forEach((side) => {
      layout.docks[side].forEach((column) => { column.groups = column.groups.filter((group) => group.tabs.length); });
      layout.docks[side] = layout.docks[side].filter((column) => column.groups.length);
    });
    layout.floats = layout.floats.filter((group) => group.tabs.length);
  };

  const addColumn = (side, at, group, width) => {
    const list = layout.docks[side];
    list.splice(clamp(at, 0, list.length), 0, { id: newColumnId(layout), width: clamp(Math.round(width), widest(group), 900), icons: false, groups: [group] });
  };

  const insertInto = (column, group, before) => {
    const at = before ? column.groups.indexOf(before) : -1;
    column.groups.splice(at < 0 ? column.groups.length : at, 0, group);
  };

  const join = (into, group, before) => {
    const at = before ? into.tabs.indexOf(before) : -1;
    into.tabs.splice(at < 0 ? into.tabs.length : at, 0, ...group.tabs);
    activate(into, group.active);
  };

  // Back where it was docked: with the panel it was a tab of, if that one is still docked, else
  // in its column if it's still there, else a column of its own at the same place, as wide as
  // that one was
  const dockBack = (group) => {
    const spot = [group.active].concat(group.tabs).map((id) => layout.dockOf[id]).find(Boolean);
    const mate = spot && spot.with && !group.tabs.includes(spot.with) ? locate(spot.with) : null;
    const column = spot && findColumn(spot.column);
    const right = layout.docks.right;
    if (mate && mate.column) join(mate.group, group, null);
    else if (column) {
      const next = spot.before ? locate(spot.before) : null;
      insertInto(column, group, next && next.column === column ? next.group : null);
    } else if (spot) addColumn(spot.side, spot.at, group, spot.width);
    else if (right.length) right[right.length - 1].groups.push(group);
    else addColumn("right", 0, group, 250);
  };

  const raise = (group) => {
    const list = layout.floats;
    const at = list.indexOf(group);
    if (at < 0 || at === list.length - 1) return;
    list.splice(at, 1);
    list.push(group);
  };

  // Dropped on a group's title bar, a panel becomes one of its tabs: before the tab under the
  // pointer, or after the last
  const joinTarget = (group, rect, x) => {
    const area = work.getBoundingClientRect();
    const head = element(frontOf(group)).querySelector(".dock__head");
    // A panel alone has its name for a tab
    const tabs = head.classList.contains("is-tabbed") ? Array.from(head.querySelectorAll(".ws-tab")) : [head.firstElementChild];
    const under = tabs.find((tab) => {
      const box = tab.getBoundingClientRect();
      return x < box.left - area.left + box.width / 2;
    });
    const before = under ? under.dataset.panel || frontOf(group) : null;
    return { join: group, before, rect, into: true };
  };

  // Where a dropped panel would go: on a group's title bar, between two groups of a column, or
  // at the edge of a column, of the page or of the window, where it makes a new column. Anywhere
  // else it floats, even over a panel.
  const dropTarget = (id, whole, x, y) => {
    const H = geometry.height;
    const W = geometry.width;
    if (id === "tools") {
      if (x < 56) return { tools: "left", rect: { x: 0, y: 0, w: TOOLS, h: H } };
      if (x > W - 56) return { tools: "right", rect: { x: W - TOOLS, y: 0, w: TOOLS, h: H } };
      if (y < 40) return { tools: "top", rect: { x: 0, y: 0, w: W, h: TOOLS } };
      if (y > H - 40) return { tools: "bottom", rect: { x: 0, y: H - TOOLS, w: W, h: TOOLS } };
      return null;
    }
    const top = geometry.top || 0;
    const bottom = geometry.bottom || H;
    // A whole group never lands on itself
    const own = whole ? locate(id).group : null;
    for (const spot of geometry.loose) {
      if (spot.group === own || x < spot.x || x > spot.x + spot.w || y < spot.y || y > spot.y + spot.h) continue;
      if (y <= spot.y + HEAD) return joinTarget(spot.group, { x: spot.x, y: spot.y, w: spot.w, h: spot.h }, x);
      return null;
    }
    for (const column of Object.values(geometry.columns)) {
      if (x < column.x || x > column.x + column.w) continue;
      const parts = column.parts.filter((part) => part.group !== own);
      // The column it holds alone: it stays there
      if (!parts.length) return { column: column.id, before: null, rect: { x: column.x, y: top, w: column.w, h: bottom - top } };
      const line = (at, before) => ({ column: column.id, before, rect: { x: column.x, y: clamp(at - 3, top, bottom - 6), w: column.w, h: 6 } });
      // Between two groups first, then on a title bar, then below the last group
      const [above, below] = column.icons ? [5, 3] : [14, 6];
      for (const part of parts) {
        const at = part === parts[0] ? part.y : part.y - SPLIT / 2;
        if (y >= at - above && y < at + below) return line(at, part.group);
      }
      for (const part of parts) {
        if (y >= part.y && y < part.y + part.join + (column.icons ? 0 : 10)) return joinTarget(part.group, { x: column.x, y: part.y, w: column.w, h: part.h }, x);
      }
      const last = parts[parts.length - 1];
      const end = Math.min(last.y + last.h, column.bottom - 30);
      if (y >= end) return line(Math.min(last.y + last.h + SPLIT / 2, bottom - 3), null);
    }
    const seam = geometry.seams.find((item) => x >= item.x0 && x <= item.x1);
    if (seam) return { side: seam.side, before: seam.before, rect: { x: clamp(seam.x - 3, geometry.from, geometry.to - 6), y: top, w: 6, h: bottom - top } };
    return null;
  };

  const settle = (id, whole, target, rect) => {
    if (id === "tools") {
      if (target) {
        layout.tools = target.tools;
        layout.toolsAt = null;
      } else {
        // Out of its strip it's only as tall as its tools
        if (layout.tools !== "float") {
          element("tools").style.height = "auto";
          rect.h = Math.min(rect.h, element("tools").offsetHeight);
        }
        layout.tools = "float";
        layout.toolsAt = rect;
      }
      return;
    }
    const where = locate(id);
    const wasFloating = !where.column;
    let group;
    if (whole) {
      group = where.group;
      lift(group);
    } else group = pullOut(id);
    if (!target) {
      // Out of a column: small enough for its bottom edge to be within reach
      const most = Math.round(geometry.height * 0.8);
      const h = group.min ? Math.min(group.h, most) : rect.h;
      Object.assign(group, { x: rect.x, y: rect.y, w: rect.w, h: whole && wasFloating ? h : Math.min(h, most) });
      layout.floats.push(group);
    } else if (target.join) {
      join(target.join, group, target.before);
    } else if (target.side) {
      // Its own column could be the one it's dropped beside: that one goes only after
      const list = layout.docks[target.side];
      const at = target.before ? list.findIndex((column) => column.id === target.before) : -1;
      addColumn(target.side, at < 0 ? list.length : at, group, rect.w);
    } else {
      insertInto(findColumn(target.column), group, target.before);
    }
    tidy();
  };

  const startMove = (id, whole, event, onClick) => {
    if (Shell.touch || event.button !== 0) return;
    const el = element(id);
    const box = el.getBoundingClientRect();
    const area = work.getBoundingClientRect();
    let grabX = event.clientX - box.left;
    let grabY = event.clientY - box.top;
    const startX = event.clientX;
    const startY = event.clientY;
    let lifted = false;
    let target = null;
    dragging(event, (next) => {
      if (!lifted) {
        if (Math.hypot(next.clientX - startX, next.clientY - startY) < 4) return;
        lifted = true;
        moving = el;
        el.classList.add("is-moving");
        el.style.zIndex = 40;
        // A tab pulled out: the rest of its group stays, its other panel in front
        if (!whole) {
          pulled = id;
          apply();
          el.querySelector(".dock__head").classList.remove("is-tabbed");
        }
        // Out of a row, the tools stand upright again, held by their grip
        if (id === "tools" && (layout.tools === "top" || layout.tools === "bottom")) {
          el.dataset.place = "float";
          el.setAttribute("aria-orientation", "vertical");
          el.style.width = `${TOOLS}px`;
          el.style.height = "auto";
          grabX = TOOLS / 2;
          grabY = 5;
        }
      }
      el.style.left = `${next.clientX - area.left - grabX}px`;
      el.style.top = `${clamp(next.clientY - area.top - grabY, 0, area.height - HEAD)}px`;
      target = dropTarget(id, whole, next.clientX - area.left, next.clientY - area.top);
      hintBox.hidden = !target;
      hintBox.classList.toggle("is-into", Boolean(target && target.into));
      if (target) place(hintBox, target.rect.x, target.rect.y, target.rect.w, target.rect.h);
    }, () => {
      hintBox.hidden = true;
      el.classList.remove("is-moving");
      pulled = null;
      moving = null;
      if (lifted) settle(id, whole, target, { x: parseFloat(el.style.left), y: parseFloat(el.style.top), w: el.offsetWidth, h: el.offsetHeight });
      else if (onClick) onClick();
      apply();
      save();
    });
  };

  const EDGES = ["n", "e", "s", "w", "ne", "se", "sw", "nw"];
  // A floating group, the tools out of their strip, or a panel open beside its icons: that one
  // keeps the width and the height it's given for the next time
  const startResize = (id, edge, event) => {
    let rect;
    let keep;
    if (id === "tools") {
      if (layout.tools !== "float") return;
      rect = Object.assign({}, layout.toolsAt);
      keep = (out) => { layout.toolsAt = out; };
    } else {
      const where = locate(id);
      if (!where) return;
      const group = where.group;
      if (!where.column) {
        rect = { x: group.x, y: group.y, w: group.w, h: group.h };
        keep = (out) => Object.assign(group, out);
      } else if (flyout === group) {
        const el = element(id);
        rect = { x: 0, y: 0, w: el.offsetWidth, h: el.offsetHeight };
        keep = (out) => {
          where.column.width = Math.min(out.w, 900);
          group.h = out.h;
        };
      } else return;
    }
    const startX = event.clientX;
    const startY = event.clientY;
    const [minW, minH] = MIN[id];
    dragging(event, (next) => {
      const dx = next.clientX - startX;
      const dy = next.clientY - startY;
      const out = Object.assign({}, rect);
      if (edge.includes("e")) out.w = Math.max(minW, rect.w + dx);
      if (edge.includes("s")) out.h = Math.max(minH, rect.h + dy);
      if (edge.includes("w")) {
        out.w = Math.max(minW, rect.w - dx);
        out.x = rect.x + rect.w - out.w;
      }
      if (edge.includes("n")) {
        out.h = Math.max(minH, rect.h - dy);
        out.y = rect.y + rect.h - out.h;
      }
      keep(out);
      apply();
    }, save);
  };

  /* ------------------------------- what the app asks ------------------------------ */

  // The Detach button floats the whole group, and docks it back
  const toggleFloat = (id) => {
    const where = locate(id);
    if (!where) return;
    const group = where.group;
    if (!where.column) {
      lift(group);
      dockBack(group);
    } else {
      const box = element(frontOf(group) || id).getBoundingClientRect();
      const area = work.getBoundingClientRect();
      lift(group);
      tidy();
      const w = Math.max(box.width, frontOf(group) === "breaks" ? 340 : 0);
      const h = group.min ? Math.min(group.h, Math.round(area.height * 0.8)) : Math.min(box.height, Math.round(area.height * 0.8));
      Object.assign(group, { x: clamp(box.left - area.left - 24, 0, area.width - w - 8), y: clamp(box.top - area.top + 24, 0, area.height - h - 8), w, h });
      layout.floats.push(group);
    }
    if (flyout === group) flyout = null;
    apply();
    save();
  };

  // Open and in front of its group: a column of icons or a group shrunk to its title bar
  // still counts it, as Photoshop's Window menu does
  const isVisible = (id) => {
    if (!isOpen(id)) return false;
    const where = locate(id);
    return Boolean(where) && frontOf(where.group) === id;
  };
  // Seen whole, right now
  const inView = (id) => {
    if (!isVisible(id)) return false;
    const where = locate(id);
    return !where.group.min && !(where.column && where.column.icons && flyout !== where.group);
  };

  const setVisible = (id, shown) => {
    layout.hidden[id] = !shown;
    const where = locate(id);
    if (where) {
      const group = where.group;
      if (shown) {
        activate(group, id);
        group.min = false;
      } else if (group.active === id && group.back && group.back !== id && group.tabs.includes(group.back)) group.active = group.back;
    }
    if (flyout && !tabsOf(flyout).length) flyout = null;
    apply();
    save();
  };

  // The Window menu: a panel out of sight comes to the front, beside its icons if they're all
  // its column shows
  const toggle = (id) => {
    if (inView(id)) return setVisible(id, false);
    const where = locate(id);
    if (where && where.column && where.column.icons) {
      layout.hidden[id] = false;
      activate(where.group, id);
      flyout = where.group;
      apply();
      save();
      return;
    }
    setVisible(id, true);
  };

  // All the panels but TypeR at once, and back to what was shown
  const sideVisible = () => SIDE.some(isVisible);
  const toggleSide = () => {
    if (sideVisible()) {
      layout.sideShown = SIDE.filter(isOpen);
      SIDE.forEach((id) => { layout.hidden[id] = true; });
    } else {
      (layout.sideShown || ["layers", "character", "breaks"]).forEach((id) => { layout.hidden[id] = false; });
    }
    if (flyout && !tabsOf(flyout).length) flyout = null;
    apply();
    save();
  };

  const toolsVisible = () => !toolsOff;
  const setTools = (shown) => {
    if (toolsOff === !shown) return;
    toolsOff = !shown;
    apply();
  };

  const reset = () => {
    layout = fresh();
    flyout = null;
    try {
      window.localStorage.removeItem(STORE);
    } catch (error) {
      console.warn("TypeR web: could not reset the workspace", error);
    }
    apply();
  };

  const closeFlyout = () => {
    if (!flyout) return;
    flyout = null;
    apply();
  };

  const FLOAT_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.500" y="2.500" width="8" height="8"/><path d="M2.500 5.500v8h8"/></svg>';

  const init = (translate) => {
    T = translate;
    work.appendChild(hintBox);
    // Two presses on the same title bar, close together: the group shrinks to it, or opens again
    let pressed = { group: null, at: 0 };
    PANELS.forEach((id) => {
      const el = element(id);
      const head = el.querySelector(".dock__head");
      const tabs = document.createElement("div");
      tabs.className = "ws-tabs";
      tabs.setAttribute("role", "tablist");
      head.insertBefore(tabs, head.firstElementChild.nextSibling);
      const actions = document.createElement("span");
      actions.className = "dock__actions";
      const float = document.createElement("button");
      float.type = "button";
      float.className = "dock__float";
      float.innerHTML = FLOAT_ICON;
      float.addEventListener("click", () => toggleFloat(id));
      const close = document.createElement("button");
      close.type = "button";
      close.className = "tab__close";
      close.textContent = "×";
      close.title = T("Close");
      close.setAttribute("aria-label", T("Close"));
      close.addEventListener("click", () => setVisible(id, false));
      actions.append(float, close);
      head.appendChild(actions);
      head.addEventListener("pointerdown", (event) => {
        if (Shell.touch || event.button !== 0 || event.target.closest("button, select, input")) return;
        const where = locate(id);
        if (!where) return;
        const group = where.group;
        const now = event.timeStamp;
        const twice = pressed.group === group && now - pressed.at < 450;
        pressed = { group: twice ? null : group, at: now };
        if (twice && flyout !== group) {
          event.preventDefault();
          group.min = !group.min;
          apply();
          save();
          return;
        }
        // Pressing a tab brings its panel to the front, as in Photoshop; dragging it takes it
        // out of the group, dragging the rest of the bar takes the whole group
        const tab = event.target.closest(".ws-tab");
        if (tab && tab.dataset.panel !== frontOf(group)) {
          activate(group, tab.dataset.panel);
          apply();
          save();
        }
        const opened = () => {
          if (!group.min) return raise(group);
          // A group shrunk to its title bar opens again with a click
          group.min = false;
          pressed = { group: null, at: 0 };
        };
        if (tab) startMove(tab.dataset.panel, false, event, opened);
        else startMove(id, true, event, opened);
      });
      head.addEventListener("keydown", (event) => {
        const tab = event.target.closest(".ws-tab");
        if (!tab || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        setVisible(tab.dataset.panel, true);
      });
    });
    const tools = element("tools");
    const grip = document.createElement("div");
    grip.className = "tools__grip";
    tools.insertBefore(grip, tools.firstChild);
    grip.addEventListener("pointerdown", (event) => startMove("tools", true, event, null));
    Object.keys(ELEMENTS).forEach((id) => {
      const el = element(id);
      EDGES.forEach((edge) => {
        const handle = document.createElement("div");
        handle.className = `ws-grip ws-grip--${edge}`;
        handle.addEventListener("pointerdown", (event) => {
          if (el.classList.contains("is-floating")) startResize(id, edge, event);
        });
        el.appendChild(handle);
      });
      if (id === "tools") return;
      // A floating group comes over the others when clicked
      el.addEventListener("pointerdown", () => {
        const where = locate(id);
        if (!where || where.column || layout.floats[layout.floats.length - 1] === where.group) return;
        raise(where.group);
        layout.floats.forEach((group, index) => { element(frontOf(group) || group.tabs[0]).style.zIndex = 12 + index; });
      }, true);
    });
    // A panel open beside its icons closes with a click anywhere else in the workspace, or Escape
    document.addEventListener("pointerdown", (event) => {
      if (!flyout || !work.contains(event.target) || event.target.closest(".ws-strip")) return;
      if (element(frontOf(flyout)).contains(event.target)) return;
      closeFlyout();
    }, true);
    window.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !flyout || document.querySelector("dialog[open]")) return;
      event.preventDefault();
      event.stopPropagation();
      closeFlyout();
    }, true);
    let waiting = 0;
    new ResizeObserver(() => {
      cancelAnimationFrame(waiting);
      waiting = requestAnimationFrame(apply);
    }).observe(work);
    Shell.onChange(apply);
    apply();
  };

  window.TypeRWorkspace = { init, apply, isVisible, toggle, setVisible, sideVisible, toggleSide, toolsVisible, setTools, toggleFloat, reset };
})();
