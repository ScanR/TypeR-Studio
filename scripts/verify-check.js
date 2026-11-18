#!/usr/bin/env node
// Checks Verification's rules (web/verify-rules.js) in the real app, headless: for each rule a
// page that must trigger it and a clean one that must not, every fix applied, checked again
// and undone in one step, and a realistic clean page that must report nothing at all. Pages
// saved as PSD and opened again check the texts that show their saved pixels, as a PSD from
// Photoshop shows Photoshop's, whose lines TypeR's own layout may break elsewhere.
//
//   node scripts/verify-check.js            exits 1 when a check fails
//   node scripts/verify-check.js --verbose  prints every issue found
//
// Needs Google Chrome and desktop/node_modules/playwright-core.
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const VERBOSE = process.argv.includes("--verbose");
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const { chromium } = require(path.join(ROOT, "desktop/node_modules/playwright-core"));

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf", ".wasm": "application/wasm", ".webmanifest": "application/manifest+json", ".mp4": "video/mp4" };

const serve = () => new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
    let file = path.join(ROOT, url);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    fs.readFile(file, (error, body) => {
      if (error) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(body);
    });
  });
  server.listen(0, "127.0.0.1", () => resolve(server));
});

/* ------------------------------ in the page ------------------------------ */

// Builds test pages with the app's own operations
const LIB = String.raw`
window.__vt = (() => {
  const PS = window.TypeRPhotoshop;
  const ops = PS.ops;
  let count = 0;
  const lib = {
    page(spec = {}) {
      // A page of the app's own practice chapter (guide.js): screentone, speed lines, bubbles
      // with tails, a caption on a gradient
      if (spec.practice) return ops.imageDocument(window.TypeRGuide.drawPage(spec.practice), "practice " + spec.practice).id;
      const doc = ops.newDocument({ name: "verify " + ++count, width: spec.width || 1000, height: spec.height || 1400, resolution: 72, background: "#ffffff" });
      const c = document.createElement("canvas");
      c.width = doc.width;
      c.height = doc.height;
      const g = c.getContext("2d");
      (spec.hatch || []).forEach(([x, y, w, h]) => {
        // Drawn art: crossed lines and a few blobs, as a busy background
        g.save();
        g.beginPath();
        g.rect(x, y, w, h);
        g.clip();
        g.fillStyle = "#d8d8d8";
        g.fillRect(x, y, w, h);
        g.strokeStyle = "#222";
        g.lineWidth = 2;
        for (let k = -h; k < w; k += 9) {
          g.beginPath();
          g.moveTo(x + k, y);
          g.lineTo(x + k + h, y + h);
          g.stroke();
        }
        for (let k = 0; k < w + h; k += 23) {
          g.beginPath();
          g.moveTo(x + k, y);
          g.lineTo(x + k - h, y + h);
          g.stroke();
        }
        g.restore();
      });
      (spec.rects || []).forEach(([x, y, w, h, fill]) => {
        g.fillStyle = fill;
        g.fillRect(x, y, w, h);
      });
      (spec.panels || []).forEach(([x, y, w, h]) => {
        g.strokeStyle = "#000";
        g.lineWidth = 5;
        g.strokeRect(x, y, w, h);
      });
      // A double bubble: two lobes in one outline, their join drawn across
      (spec.doubles || []).forEach(({ lobes, join }) => {
        g.lineWidth = 4;
        g.strokeStyle = "#000";
        lobes.forEach((b) => {
          g.beginPath();
          g.ellipse(b.x, b.y, b.rx, b.ry, 0, 0, Math.PI * 2);
          g.stroke();
        });
        g.fillStyle = "#fff";
        lobes.forEach((b) => {
          g.beginPath();
          g.ellipse(b.x, b.y, b.rx - 2, b.ry - 2, 0, 0, Math.PI * 2);
          g.fill();
        });
        if (join) {
          g.beginPath();
          g.moveTo(...join[0]);
          g.lineTo(...join[1]);
          g.stroke();
        }
      });
      // A burst bubble made of speed lines: rays from around an open middle out to the panel's
      // border, with no outline, the panel showing between them
      (spec.bursts || []).forEach((b) => {
        g.save();
        g.beginPath();
        g.rect(...b.clip);
        g.clip();
        g.strokeStyle = "#000";
        g.lineWidth = 3;
        for (let k = 0; k < b.rays; k++) {
          const a = (k / b.rays) * Math.PI * 2;
          g.beginPath();
          g.moveTo(b.x + Math.cos(a) * b.r, b.y + Math.sin(a) * b.r);
          g.lineTo(b.x + Math.cos(a) * 3000, b.y + Math.sin(a) * 3000);
          g.stroke();
        }
        g.restore();
      });
      (spec.bubbles || []).forEach((b) => {
        g.save();
        if (b.clip) {
          g.beginPath();
          g.rect(...b.clip);
          g.clip();
        }
        g.beginPath();
        g.ellipse(b.x, b.y, b.rx, b.ry, 0, 0, Math.PI * 2);
        if (b.tail) {
          g.moveTo(b.x - 18, b.y + b.ry - 6);
          g.lineTo(b.tail[0], b.tail[1]);
          g.lineTo(b.x + 18, b.y + b.ry - 6);
        }
        g.fillStyle = b.fill || "#fff";
        g.fill();
        g.lineWidth = b.line || 4;
        g.strokeStyle = b.stroke || "#000";
        g.stroke();
        if (b.tail) {
          g.beginPath();
          g.ellipse(b.x, b.y, b.rx - 2, b.ry - 2, 0, 0, Math.PI * 2);
          g.fillStyle = b.fill || "#fff";
          g.fill();
        }
        g.restore();
        if (b.join) {
          g.strokeStyle = "#000";
          g.lineWidth = 4;
          g.beginPath();
          g.moveTo(...b.join[0]);
          g.lineTo(...b.join[1]);
          g.stroke();
        }
      });
      if ((spec.hatch || []).length || (spec.bubbles || []).length || (spec.doubles || []).length || (spec.rects || []).length || (spec.panels || []).length || (spec.bursts || []).length) ops.newLayer("Art", undefined, { bitmap: c });
      return doc.id;
    },
    // A text, centred on (x, y) or by the app's own Align ("align")
    text(spec) {
      const doc = PS.app.doc;
      const layer = ops.newText(spec.x, spec.y, spec.text, spec.box || undefined);
      const id = layer.id;
      const style = Object.assign({ size: spec.size || 22 }, spec.style || {});
      if (spec.font) Object.assign(style, { fontPostScriptName: spec.font, fontName: spec.family || spec.font, fontStyleName: spec.fontStyle || "Regular" });
      if (spec.color) style.color = { red: spec.color[0], green: spec.color[1], blue: spec.color[2] };
      if (spec.lang) style.textLanguage = spec.lang;
      ops.setTextStyle([id], style);
      if (spec.stroke) ops.setTextStroke([id], Object.assign({ enabled: true, size: 4, position: "outside", color: { red: 255, green: 255, blue: 255 }, opacity: 100 }, spec.stroke));
      if (spec.antiAlias) ops.setTextAntiAlias([id], spec.antiAlias);
      const now = () => PS.app.doc.state.layers.find((item) => item.id === id);
      if (spec.align) {
        ops.selectLayer(id);
        ops.deselect && PS.app.doc.state.selection && ops.deselect();
        const error = PS.host.alignTextLayerToSelection({});
        if (error) throw new Error("Align failed: " + error);
      } else if (!spec.box) {
        const moved = PS.centredOn(now(), doc, spec.x, spec.y);
        ops.setLayers(doc.state.layers.map((item) => (item.id === id ? moved : item)), "Move");
      }
      if (spec.layer) ops.setLayers(doc.state.layers.map((item) => (item.id === id ? Object.assign({}, item, spec.layer, { raster: null }) : item)), "Props");
      if (spec.hidden) ops.toggleLayer(id);
      return id;
    },
    // The page saved as a PSD and opened again: its texts show their saved pixels until edited.
    // changes: for a text, by its words, another size for its text box, kept with those
    // pixels, as when TypeR breaks a PSD's paragraph elsewhere than Photoshop did
    async reopen(changes = {}) {
      const before = PS.app.doc;
      const bytes = await window.TypeRPSD.write(before, "verify.psd");
      lib.close();
      await window.TypeRApp.openFiles([new File([bytes], "verify reopened " + ++count + ".psd")]);
      document.querySelectorAll("dialog[open]").forEach((d) => d.close());
      const doc = PS.app.doc;
      if (!doc || doc === before) throw new Error("the saved PSD did not open");
      const texts = doc.state.layers.filter((l) => l.kind === "text");
      const layers = doc.state.layers.map((l) => {
        const change = l.kind === "text" && changes[l.params.layerText.textKey];
        if (!change) return l;
        const params = JSON.parse(JSON.stringify(l.params));
        params.layerText.textShape[0].box = Object.assign({}, params.layerText.textShape[0].box, change);
        return Object.assign({}, l, { params });
      });
      ops.setLayers(layers, "Props");
      return { texts: texts.length, shown: texts.filter((l) => l.raster).length };
    },
    async run(rules, script) {
      const t = performance.now();
      const issues = await window.TypeRVerify.check(PS.app.doc, { rules, script });
      return { ms: performance.now() - t, issues };
    },
    async fix(issueId, rules, script) {
      const doc = PS.app.doc;
      const before = doc.historyIndex;
      const issues = await window.TypeRVerify.check(doc, { rules, script });
      const issue = issues.find((item) => item.id === issueId);
      if (!issue) return { error: "issue not found" };
      const ok = window.TypeRVerify.fix(doc, issue);
      const steps = doc.historyIndex - before;
      const after = await window.TypeRVerify.check(doc, { rules, script });
      const again = window.TypeRVerify.fix(doc, issue);
      const stepsAgain = doc.historyIndex - before;
      ops.undo();
      const undone = await window.TypeRVerify.check(doc, { rules, script });
      return { ok, steps, again, stepsAgain, still: after.some((item) => item.id === issueId), back: undone.some((item) => item.id === issueId), texts: doc.state.layers.filter((l) => l.kind === "text").map((l) => l.params.layerText.textKey) };
    },
    close() {
      const doc = PS.app.doc;
      if (doc) {
        doc.savedId = doc.state && doc.historyIndex;
        ops.closeDoc(doc);
      }
    },
  };
  return lib;
})();
`;

/* --------------------------------- tests --------------------------------- */

const results = [];
const pass = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail && (!ok || VERBOSE) ? "  " + detail : ""}`);
};

const ALL_ON = (page) => page.evaluate(() => {
  const all = window.TypeRVerify.defaults();
  Object.keys(all).forEach((id) => { all[id].on = true; });
  return all;
});

const main = async () => {
  const server = await serve();
  const port = server.address().port;
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  try {
    await page.goto(`http://127.0.0.1:${port}/web/`);
    // The app waits on its first-start dialogs before it says it's booted: skipped as they come
    const start = Date.now();
    while (!(await page.evaluate(() => Boolean(window.TypeRApp && window.TypeRApp.booted)))) {
      if (Date.now() - start > 45000) throw new Error("the app did not boot");
      const skip = await page.$("dialog.onboard .onboard__skip");
      if (skip) await skip.click().catch(() => {});
      await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach((d) => { if (!d.matches(".onboard")) d.close(); }));
      await page.waitForTimeout(300);
    }
    if (!(await page.evaluate(() => Boolean(window.TypeRVerify)))) await page.addScriptTag({ url: `/web/verify-rules.js?v=${Date.now()}` });
    await page.addScriptTag({ content: LIB });
    await page.evaluate(() => window.TypeRFonts && window.TypeRFonts.builtinsLoaded && window.TypeRFonts.builtinsLoaded());

    const contract = await page.evaluate(() => {
      const V = window.TypeRVerify;
      const d = V.defaults();
      return { categories: V.CATEGORIES, rules: V.RULES.map((r) => ({ id: r.id, category: r.category, severity: r.severity, on: r.on, options: r.options || [] })), defaults: d };
    });
    pass("contract: every rule has a category, a severity, defaults", contract.rules.every((r) => contract.categories.includes(r.category) && ["error", "warning", "hint"].includes(r.severity) && contract.defaults[r.id] && contract.defaults[r.id].on === r.on && r.options.every((o) => contract.defaults[r.id][o.key] === o.default)));
    const all = await ALL_ON(page);
    const ruleIds = contract.rules.map((r) => r.id);
    const seen = new Map(ruleIds.map((id) => [id, { fired: false, clean: false }]));

    const build = (spec) => page.evaluate(async (s) => {
      window.__vt.page(s.page || {});
      const ids = {};
      for (const t of s.texts || []) ids[t.name || t.text] = window.__vt.text(t);
      if (s.reopen) return window.__vt.reopen(s.reopen);
      return ids;
    }, spec);
    const run = (rules, script) => page.evaluate(([r, s]) => window.__vt.run(r, s), [rules || null, script || null]);
    const close = () => page.evaluate(() => window.__vt.close());
    const show = (issues) => issues.map((i) => `${i.rule}(${i.message.text.replace(/\{(\w+)\}/g, (m, k) => (i.message.values || {})[k])} | ${i.excerpt})`).join("; ");

    // `fires`: rules that must report on this page (with every rule on); `quiet`: rules that
    // must not. `fix`: a rule whose fix is applied, checked, then undone.
    const scenario = async (name, spec, { fires = [], quiet = [], fix = [], rules, script, only } = {}) => {
      const ids = await build(spec);
      const { issues, ms } = await run(rules === undefined ? all : rules, script);
      if (VERBOSE) console.log(`     ${name}: ${ms.toFixed(0)} ms, ${show(issues)}`);
      fires.forEach((rule) => {
        const ok = issues.some((i) => i.rule === rule);
        if (ok && seen.has(rule)) seen.get(rule).fired = true;
        pass(`${name}: reports ${rule}`, ok, show(issues));
      });
      quiet.forEach((rule) => {
        const ok = !issues.some((i) => i.rule === rule);
        if (ok && seen.has(rule)) seen.get(rule).clean = true;
        pass(`${name}: no ${rule}`, ok, show(issues.filter((i) => i.rule === rule)));
      });
      if (only) {
        const extra = issues.filter((i) => !only.includes(i.rule));
        pass(`${name}: nothing else`, !extra.length, show(extra));
      }
      for (const rule of fix) {
        const issue = issues.find((i) => i.rule === rule && i.fix);
        if (!issue) {
          pass(`${name}: fix ${rule}`, false, "no fixable issue");
          continue;
        }
        const r = await page.evaluate(([id, rr, sc]) => window.__vt.fix(id, rr, sc), [issue.id, rules === undefined ? all : rules, script || null]);
        pass(`${name}: fix ${rule} (${issue.fix.label}) is one step and clears it`, r.ok === true && r.steps === 1 && !r.still, JSON.stringify(r));
        pass(`${name}: fix ${rule} refuses once done`, r.again === false && r.stepsAgain === 1, JSON.stringify(r));
        pass(`${name}: undo brings ${rule} back`, r.back === true, JSON.stringify(r));
      }
      await close();
      return { ids, issues, ms };
    };

    const BUBBLE = (x, y, rx, ry, more) => Object.assign({ x, y, rx, ry }, more || {});

    /* ---------- the false-positive bar: a realistic, clean page ---------- */
    const clean = {
      page: {
        width: 1200, height: 1800,
        hatch: [[0, 0, 1200, 600], [0, 620, 590, 560], [610, 620, 590, 560], [0, 1200, 1200, 600]],
        panels: [[0, 0, 1200, 600], [0, 620, 590, 560], [610, 620, 590, 560], [0, 1200, 1200, 600]],
        bubbles: [
          BUBBLE(300, 250, 200, 140, { tail: [380, 450] }),
          BUBBLE(860, 300, 230, 160),
          BUBBLE(290, 880, 220, 150),
          BUBBLE(900, 900, 210, 170),
          BUBBLE(260, 1450, 200, 150),
          // Cut by the panel's border at the bottom of the page
          BUBBLE(900, 1760, 220, 170, { clip: [0, 1200, 1200, 600] }),
        ],
      },
      texts: [
        { text: "HEY! WHERE ARE\rYOU GOING WITH\rMY BAG?!", x: 300, y: 250, size: 26, align: true },
        { text: "I TOLD YOU\rALREADY... I'M\rLEAVING THIS\rTOWN TONIGHT.", x: 860, y: 300, size: 26, align: true },
        { text: "THEN TAKE\rME WITH YOU,\rPLEASE!", x: 290, y: 880, size: 26, align: true },
        { text: "YOU DON'T KNOW\rWHAT YOU'RE\rASKING FOR.", x: 900, y: 900, size: 26, align: true },
        { text: "I DON'T\rCARE!", x: 260, y: 1450, size: 30, align: true },
        { text: "FINE...\rGET IN THE CAR.", x: 900, y: 1690, size: 26, align: true },
        // An SFX over the art, with its stroke
        { text: "VROOM", x: 600, y: 1500, size: 70, font: "Bangers-Regular", family: "Bangers", stroke: { size: 6 } },
      ],
    };
    const cleanScript = ["Hey! Where are you going with my bag?!", "I told you already... I'm leaving this town tonight.", "Then take me with you, please!", "You don't know what you're asking for.", "I don't care!", "Fine... get in the car.", "VROOM"];
    {
      const r = await scenario("clean page, defaults", clean, { rules: null, script: cleanScript, only: [] });
      pass(`clean page checks in under a second (${r.ms.toFixed(0)} ms)`, r.ms < 1000);
    }
    {
      // Every rule on, the off-by-default ones too
      const r = await scenario("clean page, every rule on", clean, { script: cleanScript, only: [] });
      if (!r.issues.length) ruleIds.forEach((id) => { seen.get(id).clean = true; });
    }
    // The same page, centred by the app's own Align (classic) and by an exact centring on the
    // bubble's middle: both must count as centred
    await scenario("clean page, French", {
      page: { bubbles: [BUBBLE(500, 400, 230, 160), BUBBLE(500, 900, 230, 160)] },
      texts: [
        { text: "QUOI ?! TU PARS\rDÉJÀ ? ATTENDS :\rJE VIENS !", x: 500, y: 400, size: 24, lang: "standardFrenchLanguage", align: true },
        { text: "NON… PAS\rCETTE FOIS ;\rDÉSOLÉ.", x: 500, y: 900, size: 24, lang: "standardFrenchLanguage" },
      ],
    }, { only: [] });

    // The practice chapter, typeset as a careful typesetter would: Align in each bubble
    {
      const practice = {
        page: { practice: 1 },
        texts: [
          { text: "HEY, WAIT\rFOR ME!", x: 250, y: 235, size: 26, align: true },
          { text: "WHERE ARE YOU\rGOING SO EARLY\rIN THE MORNING?", x: 770, y: 345, size: 30, align: true },
          { text: "THE NEXT MORNING...", x: 310, y: 790, size: 28 },
          { text: "WHAT?!", x: 890, y: 965, size: 44, align: true },
          { text: "I'M MOVING TO\rTHE CITY.", x: 800, y: 1460, size: 30, align: true },
          { text: "TOKYO", x: 380, y: 1450, size: 40, stroke: { size: 5 } },
        ],
      };
      const script = ["Hey, wait for me!", "Where are you going so early in the morning?", "The next morning...", "What?!", "I'm moving to the city.", "Tokyo"];
      await scenario("practice page 1, typeset cleanly, defaults", practice, { rules: null, script, only: [] });
      await scenario("practice page 1, typeset cleanly, every rule on", practice, { script, only: [] });
      await scenario("practice page 3, typeset cleanly", {
        page: { practice: 3 },
        texts: [
          { text: "IT WAS A\rQUIET MORNING.", x: 600, y: 560, size: 32, align: true },
          { text: "THE END", x: 600, y: 1350, size: 60, stroke: { size: 6 } },
        ],
      }, { script: ["It was a quiet morning.", "The end"], only: [] });
    }

    /* ------------------------------ placement ------------------------------ */
    await scenario("text against the edge", {
      page: { bubbles: [BUBBLE(300, 300, 150, 90), BUBBLE(700, 300, 200, 140)] },
      texts: [
        { text: "THIS LINE IS FAR TOO\rWIDE FOR SUCH A\rSMALL BUBBLE.", x: 300, y: 300, size: 23 },
        { text: "THIS ONE\rFITS WELL.", x: 700, y: 300, size: 24 },
      ],
    }, { fires: ["bubble-edge"] });
    await scenario("text with room", { page: { bubbles: [BUBBLE(500, 300, 200, 140)] }, texts: [{ text: "THIS ONE\rFITS WELL.", x: 500, y: 300, size: 24 }] }, { quiet: ["bubble-edge", "bubble-spill", "bubble-centre"] });
    await scenario("text out of its bubble", {
      page: { bubbles: [BUBBLE(400, 300, 140, 80)] },
      texts: [{ text: "THIS LINE IS MUCH TOO LONG FOR IT.", x: 400, y: 300, size: 26 }],
    }, { fires: ["bubble-spill"] });
    await scenario("text across the join of a double bubble", {
      page: { doubles: [{ lobes: [BUBBLE(380, 300, 160, 110), BUBBLE(600, 330, 160, 110)], join: [[490, 215], [490, 415]] }] },
      texts: [{ text: "ACROSS\rTHE JOIN.", x: 490, y: 310, size: 26 }],
    }, { fires: ["bubble-spill"] });
    await scenario("a double bubble, one text in each lobe", {
      page: { doubles: [{ lobes: [BUBBLE(380, 300, 160, 110), BUBBLE(600, 330, 160, 110)], join: [[490, 215], [490, 415]] }] },
      texts: [{ text: "ON THE\rLEFT.", x: 400, y: 300, size: 24, align: true }, { text: "ON THE\rRIGHT.", x: 580, y: 330, size: 24, align: true }],
    }, { quiet: ["bubble-spill", "bubble-edge", "bubble-centre"] });
    await scenario("a double bubble without a drawn join", {
      page: { doubles: [{ lobes: [BUBBLE(330, 300, 160, 110), BUBBLE(640, 330, 160, 110)] }] },
      texts: [{ text: "ON THE\rLEFT.", x: 330, y: 300, size: 24 }, { text: "ON THE\rRIGHT.", x: 640, y: 330, size: 24 }],
    }, { quiet: ["bubble-spill", "bubble-edge", "bubble-centre"] });
    await scenario("text off centre", {
      page: { bubbles: [BUBBLE(500, 400, 230, 160)] },
      texts: [{ text: "I'M NOT\rIN THE\rMIDDLE.", x: 430, y: 360, size: 26 }],
    }, { fires: ["bubble-centre"], fix: ["bubble-centre"] });
    await scenario("text off centre, fixed then checked again", {
      page: { bubbles: [BUBBLE(500, 400, 230, 160, { tail: [620, 640] })] },
      texts: [{ text: "AND NOW?", x: 520, y: 420, size: 26, align: true }],
    }, { quiet: ["bubble-centre"] });
    await scenario("bubble cut by the panel's border", {
      page: { panels: [[0, 0, 1000, 600]], bubbles: [BUBBLE(500, 30, 260, 170, { clip: [0, 0, 1000, 600] })] },
      texts: [{ text: "CENTRED ON\rWHAT SHOWS.", x: 500, y: 100, size: 26, align: true }],
    }, { quiet: ["bubble-centre", "bubble-edge", "bubble-spill"] });
    await scenario("text box too small", {
      page: {},
      texts: [{ text: "THIS TEXT IS FAR TOO LONG TO FIT IN SUCH A SMALL BOX, ITS LAST LINES ARE CUT OFF.", x: 100, y: 100, size: 24, box: { width: 200, height: 60 } }],
    }, { fires: ["text-overflow"] });
    await scenario("text box large enough", {
      page: {},
      texts: [{ text: "THIS ONE FITS.", x: 100, y: 100, size: 24, box: { width: 300, height: 200 } }],
    }, { quiet: ["text-overflow"] });

    /* -------------------------------- shape -------------------------------- */
    const inBubble = (text, size = 24) => ({ page: { bubbles: [BUBBLE(500, 400, 300, 200)] }, texts: [{ text, x: 500, y: 400, size }] });
    await scenario("one word alone on the last line", inBubble("I REALLY DON'T THINK\rTHAT IS A GOOD IDEA\rNO."), { fires: ["lone-word"] });
    await scenario("a short last line of two words", inBubble("I REALLY DON'T\rTHINK THAT'S A\rGOOD IDEA."), { quiet: ["lone-word", "last-line-longest", "hourglass"] });
    await scenario("punctuation alone", inBubble("WHAT DID YOU SAY\r?!"), { fires: ["lone-punctuation"] });
    await scenario("punctuation with its word", inBubble("WHAT DID\rYOU SAY?!"), { quiet: ["lone-punctuation"] });
    await scenario("last line longest", inBubble("HEY,\rYOU THERE,\rCOME BACK HERE RIGHT NOW!"), { fires: ["last-line-longest"] });
    await scenario("last line longest, off by default", inBubble("HEY,\rYOU THERE,\rCOME BACK HERE RIGHT NOW!"), { rules: null, quiet: ["last-line-longest"] });
    await scenario("hourglass", inBubble("I REALLY WANT TO\rGO\rBACK HOME TONIGHT."), { fires: ["hourglass"] });
    await scenario("a middle line a little shorter", inBubble("TU\rNE TE\rSENS\rPAS\rBIEN ?"), { quiet: ["hourglass"] });
    await scenario("diamond shape", inBubble("I REALLY\rWANT TO GO BACK\rHOME TONIGHT."), { quiet: ["hourglass", "last-line-longest", "lone-word"] });
    await scenario("line starting with a hyphen", inBubble("THIS IS INCRED\r-IBLE, ISN'T IT?"), { fires: ["hyphen-start"] });
    await scenario("short word cut", inBubble("I WANT TO GO HO-\rME NOW."), { fires: ["short-word-cut"] });
    await scenario("long word cut once", inBubble("THIS IS INCRED-\rIBLE, ISN'T IT?"), { quiet: ["short-word-cut", "many-cuts", "hyphen-start"] });
    await scenario("compound word at a line's end", inBubble("SHE'S MY SISTER-\rIN-LAW, YOU KNOW."), { quiet: ["short-word-cut", "many-cuts"] });
    await scenario("two words cut", inBubble("THIS IS INCRED-\rIBLE AND FANTAS-\rTIC, ISN'T IT?"), { fires: ["many-cuts"] });

    /* -------------------------------- stroke -------------------------------- */
    const art = { hatch: [[0, 0, 1000, 800]] };
    await scenario("text over the art without a stroke", { page: art, texts: [{ text: "SOMEWHERE IN TOKYO.", x: 500, y: 300, size: 30 }] }, { fires: ["no-stroke"] });
    await scenario("text over the art with a stroke", { page: art, texts: [{ text: "SOMEWHERE IN TOKYO.", x: 500, y: 300, size: 30, stroke: { size: 5 } }] }, { quiet: ["no-stroke", "low-contrast"] });
    await scenario("text on a plain background", { page: { rects: [[0, 0, 1000, 800, "#ccd8ff"]] }, texts: [{ text: "THE NEXT DAY.", x: 500, y: 300, size: 30 }] }, { quiet: ["no-stroke", "low-contrast"] });
    await scenario("grey text on a grey bubble", {
      page: { bubbles: [BUBBLE(500, 300, 220, 140, { fill: "#7a7a7a" })] },
      texts: [{ text: "CAN YOU\rREAD ME?", x: 500, y: 300, size: 28, color: [110, 110, 110] }],
    }, { fires: ["low-contrast"] });
    await scenario("white text on a black bubble", {
      page: { bubbles: [BUBBLE(500, 300, 220, 140, { fill: "#000", stroke: "#fff" })] },
      texts: [{ text: "I CAN\rREAD THIS.", x: 500, y: 300, size: 28, color: [255, 255, 255] }],
    }, { quiet: ["low-contrast", "no-stroke", "bubble-edge", "bubble-centre"] });

    /* --------------------------------- text --------------------------------- */
    await scenario("double space", inBubble("HELLO  THERE,\rMY FRIEND."), { fires: ["double-space"], fix: ["double-space"] });
    await scenario("spaces at the ends of lines", inBubble(" HELLO THERE, \rMY FRIEND."), { fires: ["edge-space"], fix: ["edge-space"] });
    await scenario("space before ! in English", { page: { bubbles: [BUBBLE(500, 400, 300, 200)] }, texts: [{ text: "HELLO THERE !\rHOW ARE YOU ?", x: 500, y: 400, size: 24, lang: "englishLanguage" }] }, { fires: ["space-before-punctuation"], fix: ["space-before-punctuation"] });
    await scenario("space before ! in French", { page: { bubbles: [BUBBLE(500, 400, 300, 200)] }, texts: [{ text: "SALUT !\rÇA VA ?", x: 500, y: 400, size: 24, lang: "standardFrenchLanguage" }] }, { quiet: ["space-before-punctuation"] });
    await scenario("space before a comma in French", { page: { bubbles: [BUBBLE(500, 400, 300, 200)] }, texts: [{ text: "SALUT , TOI !", x: 500, y: 400, size: 24, lang: "standardFrenchLanguage" }] }, { fires: ["space-before-punctuation"] });
    await scenario("ellipsis after a space is a style", inBubble("WELL ...\rI GUESS."), { quiet: ["space-before-punctuation", "bad-ellipsis"] });
    await scenario("two dots", inBubble("WAIT.. WHAT\rDID YOU SAY?"), { fires: ["bad-ellipsis"], fix: ["bad-ellipsis"] });
    await scenario("four dots", inBubble("WAIT.... WHAT?"), { fires: ["bad-ellipsis"] });
    await scenario("mixed ellipses", {
      page: { bubbles: [BUBBLE(250, 300, 200, 130), BUBBLE(750, 300, 200, 130), BUBBLE(500, 800, 200, 130)] },
      texts: [{ text: "WELL...\rI DON'T KNOW.", x: 250, y: 300 }, { text: "MAYBE...\rTOMORROW.", x: 750, y: 300 }, { text: "OR NEVER…", x: 500, y: 800 }],
    }, { fires: ["mixed-ellipsis"], fix: ["mixed-ellipsis"] });
    await scenario("one kind of ellipsis", {
      page: { bubbles: [BUBBLE(250, 300, 200, 130), BUBBLE(750, 300, 200, 130)] },
      texts: [{ text: "WELL...\rI DON'T KNOW.", x: 250, y: 300 }, { text: "MAYBE...\rTOMORROW.", x: 750, y: 300 }],
    }, { quiet: ["mixed-ellipsis", "bad-ellipsis"] });
    await scenario("!? where the team writes ?!", inBubble("WHAT!?"), { fires: ["exclamation-order"], fix: ["exclamation-order"] });
    await scenario("?! where the team writes ?!", inBubble("WHAT?!"), { quiet: ["exclamation-order", "many-marks"] });
    {
      const rules = await page.evaluate(() => {
        const r = window.TypeRVerify.defaults();
        r["exclamation-order"].order = "!?";
        return r;
      });
      await scenario("!? where the team writes !?", inBubble("WHAT!?"), { rules, quiet: ["exclamation-order"] });
      await scenario("?! where the team writes !?", inBubble("WHAT?!"), { rules, fires: ["exclamation-order"] });
    }
    await scenario("four marks", inBubble("WHAT?!?!"), { fires: ["many-marks"] });
    await scenario("three marks", inBubble("WHAT?!?"), { quiet: ["many-marks"] });
    await scenario("no final punctuation", inBubble("I'M GOING\rHOME NOW"), { fires: ["final-punctuation"] });
    await scenario("final punctuation", inBubble("I'M GOING\rHOME NOW!"), { quiet: ["final-punctuation"] });
    await scenario("SFX without punctuation", { page: art, texts: [{ text: "BOOM", x: 500, y: 300, size: 60, stroke: { size: 5 } }] }, { quiet: ["final-punctuation"] });
    await scenario("one word without punctuation", inBubble("CLING"), { quiet: ["final-punctuation"] });
    await scenario("a caption's box without punctuation", {
      page: { hatch: [[0, 0, 1000, 800]], rects: [[300, 200, 400, 150, "#fff"]], panels: [[300, 200, 400, 150]] },
      texts: [{ text: "IN THE COURTYARD\rOF THE INN", x: 500, y: 275, size: 26 }],
    }, { quiet: ["final-punctuation"] });
    await scenario("empty text layer", { page: { bubbles: [BUBBLE(500, 400, 300, 200)] }, texts: [{ text: "", x: 500, y: 400 }, { text: "HI.", x: 500, y: 400 }] }, { fires: ["empty-text"], fix: ["empty-text"] });
    await scenario("the same text twice", {
      page: { bubbles: [BUBBLE(250, 300, 200, 130), BUBBLE(750, 300, 200, 130)] },
      texts: [{ text: "I'LL NEVER FORGIVE\rYOU FOR THIS!", x: 250, y: 300 }, { text: "I'LL NEVER FORGIVE\rYOU FOR THIS!", x: 750, y: 300 }],
    }, { fires: ["duplicate-text"] });
    await scenario("the same short reply twice", {
      page: { bubbles: [BUBBLE(250, 300, 200, 130), BUBBLE(750, 300, 200, 130)] },
      texts: [{ text: "NO.", x: 250, y: 300 }, { text: "NO.", x: 750, y: 300 }],
    }, { quiet: ["duplicate-text"] });
    const capsPage = (odd) => ({
      page: { bubbles: [BUBBLE(250, 300, 200, 130), BUBBLE(750, 300, 200, 130), BUBBLE(250, 800, 200, 130), BUBBLE(750, 800, 200, 130)] },
      texts: [{ text: "WHERE ARE\rYOU GOING?", x: 250, y: 300, font: "Bangers-Regular", family: "Bangers" }, { text: "HOME,\rOF COURSE.", x: 750, y: 300, font: "Bangers-Regular", family: "Bangers" }, { text: "WAIT FOR\rME, THEN!", x: 250, y: 800, font: "Bangers-Regular", family: "Bangers" }, { text: odd, x: 750, y: 800, font: "Bangers-Regular", family: "Bangers" }],
    });
    const bangersCaps = await page.evaluate(() => {
      const c = document.createElement("canvas").getContext("2d");
      c.font = window.TypeRPhotoshop.cssFont({ fontPostScriptName: "Bangers-Regular", fontName: "Bangers" }, 100);
      const upper = c.measureText("ABCDEFGHIJKLMNOPQRSTUVWXYZ").width;
      return Math.abs(c.measureText("abcdefghijklmnopqrstuvwxyz").width - upper) <= upper * 0.005;
    });
    pass("Bangers draws its lower case as capitals", bangersCaps);
    // Wildjess, the app's own font, has lower-case letters; Bangers only capitals
    const capsFont = { font: "WildjessNormal", family: "Wildjess", fontStyle: "Normal" };
    const withFont = (spec) => Object.assign({}, spec, { texts: spec.texts.map((t) => Object.assign({}, t, capsFont)) });
    await scenario("lower case on a page in capitals", withFont(capsPage("fine, fine.\rlet's go.")), { fires: ["lower-case"], fix: ["lower-case"] });
    await scenario("all capitals", withFont(capsPage("FINE, FINE.\rLET'S GO.")), { quiet: ["lower-case"] });
    await scenario("a capitals-only font", { page: capsPage("x").page, texts: capsPage("fine, fine.\rlet's go.").texts }, { quiet: ["lower-case"] });
    await scenario("Japanese left in the text", inBubble("HELLO 世界。\rHOW ARE YOU?"), { fires: ["other-script"] });
    await scenario("only Latin letters", inBubble("HÉLLO, ÇA VA?\rTRÈS BIEN."), { quiet: ["other-script"] });

    /* ----------------------------- consistency ----------------------------- */
    const fiveBubbles = (sizes, more = {}) => ({
      page: { bubbles: [BUBBLE(250, 250, 220, 150), BUBBLE(750, 250, 220, 150), BUBBLE(250, 650, 220, 150), BUBBLE(750, 650, 220, 150), BUBBLE(500, 1050, 260, 170)] },
      texts: sizes.map((size, i) => Object.assign({ text: ["THIS IS\rTHE FIRST.", "AND THE\rSECOND.", "THEN THE\rTHIRD ONE.", "THE FOURTH\rONE.", "AND THE\rLAST ONE."][i], x: [250, 750, 250, 750, 500][i], y: [250, 250, 650, 650, 1050][i], size }, (more[i] || {}))),
    });
    await scenario("one text much larger", fiveBubbles([22, 22, 23, 22, 48]), { fires: ["size-outlier"] });
    await scenario("a shout larger than the rest", fiveBubbles([22, 24, 21, 22, 36]), { quiet: ["size-outlier"] });
    await scenario("one text in its own font", fiveBubbles([22, 22, 22, 22, 22], { 4: { font: "Bangers-Regular", family: "Bangers" } }), { fires: ["lone-font"] });
    await scenario("every text in the same font", fiveBubbles([22, 22, 22, 22, 22]), { quiet: ["lone-font"] });
    await scenario("font on this computer", inBubble("WHICH FONT\rIS THIS?"), { quiet: ["missing-font"] });
    await scenario("missing font", { page: { bubbles: [BUBBLE(500, 400, 300, 200)] }, texts: [{ text: "WHICH FONT\rIS THIS?", x: 500, y: 400, font: "NoSuchFontAtAll-Regular", family: "No Such Font" }] }, { fires: ["missing-font"] });
    await scenario("anti-aliasing None", { page: { bubbles: [BUBBLE(500, 400, 300, 200)] }, texts: [{ text: "JAGGED\rEDGES.", x: 500, y: 400, antiAlias: "antiAliasNone" }] }, { fires: ["no-anti-aliasing"], fix: ["no-anti-aliasing"] });
    await scenario("anti-aliasing Smooth", inBubble("SMOOTH\rEDGES."), { quiet: ["no-anti-aliasing"] });
    await scenario("Faux Bold", { page: { bubbles: [BUBBLE(500, 400, 300, 200)] }, texts: [{ text: "FAUX\rBOLD!", x: 500, y: 400, style: { syntheticBold: true } }] }, { fires: ["faux-style"] });
    await scenario("faux styles off by default", { page: { bubbles: [BUBBLE(500, 400, 300, 200)] }, texts: [{ text: "FAUX\rBOLD!", x: 500, y: 400, style: { syntheticBold: true } }] }, { rules: null, quiet: ["faux-style"] });
    await scenario("text squeezed", { page: { bubbles: [BUBBLE(500, 400, 300, 200)] }, texts: [{ text: "SQUEEZED\rTEXT.", x: 500, y: 400, style: { horizontalScale: 70 } }] }, { fires: ["text-scale"] });
    await scenario("text squeezed a little", { page: { bubbles: [BUBBLE(500, 400, 300, 200)] }, texts: [{ text: "SQUEEZED\rTEXT.", x: 500, y: 400, style: { horizontalScale: 95 } }] }, { quiet: ["text-scale"] });
    await scenario("hidden text", { page: { bubbles: [BUBBLE(500, 400, 300, 200)] }, texts: [{ text: "NOBODY\rSEES ME.", x: 500, y: 400, hidden: true }] }, { fires: ["hidden-text"], fix: ["hidden-text"] });
    await scenario("a hidden copy of a text shown at the same place", {
      page: { bubbles: [BUBBLE(500, 400, 300, 200)] },
      texts: [{ name: "backup", text: "NOBODY\rSEES ME.", x: 500, y: 400, hidden: true }, { text: "NOBODY\rSEES ME.", x: 500, y: 400 }],
    }, { quiet: ["hidden-text"] });
    await scenario("punctuation set larger on purpose", fiveBubbles([22, 22, 23, 22, 60], { 4: { text: "!!!" } }), { quiet: ["size-outlier"] });
    await scenario("text outside the page", { page: {}, texts: [{ text: "GONE.", x: -300, y: 300 }, { text: "HALF OUT OF THE PAGE.", x: 30, y: 600 }] }, { fires: ["off-page"] });
    await scenario("text on the page", { page: {}, texts: [{ text: "ON THE PAGE.", x: 500, y: 600 }] }, { quiet: ["off-page", "hidden-text"] });

    /* ------------------------------- missing -------------------------------- */
    const scriptPage = {
      page: { bubbles: [BUBBLE(250, 300, 200, 130), BUBBLE(750, 300, 200, 130)] },
      texts: [{ text: "WHERE DID YOU\rPUT THE KEYS?", x: 250, y: 300 }, { text: "ON THE TA-\rBLE, I THINK.", x: 750, y: 300 }],
    };
    await scenario("every script line on the page", scriptPage, { script: ["Where did you put the keys?", "On the table, I think."], quiet: ["script-line-missing", "not-in-script"] });
    await scenario("a script line missing", scriptPage, { script: ["Where did you put the keys?", "On the table, I think.", "Thanks, see you tonight!"], fires: ["script-line-missing"] });
    {
      const r = await scenario("a text changed by hand", scriptPage, { script: ["Where did you put the car keys?", "On the table, I think."], fires: ["not-in-script"] });
      const issue = r.issues.find((i) => i.rule === "not-in-script");
      pass("a text changed by hand: the closest line is given", Boolean(issue && issue.data && issue.data.closest === "Where did you put the car keys?"), JSON.stringify(issue && issue.data));
    }
    await scenario("no script", scriptPage, { quiet: ["script-line-missing", "not-in-script"] });

    /* ---------------------- lettering that isn't dialogue ---------------------- */
    {
      // An SFX lettered one letter per text layer, each turned, in one bubble; and one word turned
      const turn = (deg) => {
        const a = (deg * Math.PI) / 180;
        return { rotated: true, spin: [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a)] };
      };
      await scenario("an SFX lettered one letter per layer, in a bubble", {
        page: { bubbles: [BUBBLE(400, 400, 110, 150), BUBBLE(750, 400, 120, 90)] },
        texts: [
          { text: "B", x: 360, y: 300, size: 70, layer: turn(-15) },
          { text: "O", x: 400, y: 380, size: 64, layer: turn(10) },
          { text: "M", x: 440, y: 470, size: 80, layer: turn(25) },
          { text: "CLING", x: 750, y: 400, size: 50, layer: turn(-20) },
        ],
      }, { rules: null, only: [] });
    }
    // A burst bubble open on its panel: the wand runs out between its rays
    await scenario("a burst bubble open on its panel", {
      page: { width: 1000, height: 1400, hatch: [[0, 420, 1000, 980], [600, 0, 400, 420]], panels: [[0, 0, 600, 420]], bursts: [{ x: 150, y: 140, r: 80, rays: 16, clip: [0, 0, 600, 420] }] },
      texts: [{ text: "THEY'RE\rHUGE!!", x: 150, y: 140, size: 30 }],
    }, { quiet: ["bubble-centre", "bubble-edge", "bubble-spill"] });

    /* ------------------ texts showing a PSD's saved pixels ------------------ */
    {
      const box = (x, y, width, height) => ({ x, y, box: { width, height } });
      const page = { bubbles: [BUBBLE(500, 400, 300, 200), BUBBLE(500, 1000, 300, 200)] };
      // TypeR's layout cut off by a box that's too small for it, its pixels whole
      const r = await scenario("PSD reopened, laid out shorter than its pixels", {
        page,
        texts: [Object.assign({ text: "WHAT ARE YOU DOING HERE AT THIS HOUR, ALL ALONE?", size: 24 }, box(370, 340, 260, 160))],
        reopen: { "WHAT ARE YOU DOING HERE AT THIS HOUR, ALL ALONE?": { height: 40 } },
      }, { quiet: ["text-overflow", "hourglass", "lone-word", "many-cuts", "short-word-cut", "hyphen-start"] });
      pass("PSD reopened: its texts show their saved pixels", r.ids && r.ids.texts === 1 && r.ids.shown === 1, JSON.stringify(r.ids));
      // TypeR's layout breaks the lines elsewhere, and cuts words the pixels don't cut
      await scenario("PSD reopened, laid out narrower than its pixels", {
        page,
        texts: [Object.assign({ text: "I ABSOLUTELY REFUSE TO ACCOMPANY YOU THERE.", size: 24 }, box(360, 330, 280, 160))],
        reopen: { "I ABSOLUTELY REFUSE TO ACCOMPANY YOU THERE.": { width: 90 } },
      }, { quiet: ["text-overflow", "hourglass", "lone-word", "many-cuts", "short-word-cut", "hyphen-start", "lone-punctuation"] });
      // What the pixels show is what is judged: an hourglass in them, laid out otherwise by TypeR
      await scenario("PSD reopened, an hourglass in its pixels", {
        page,
        texts: [Object.assign({ text: "I REALLY WANT TO\rGO\rBACK HOME TONIGHT.", size: 24 }, box(320, 320, 360, 160))],
        reopen: { "I REALLY WANT TO\rGO\rBACK HOME TONIGHT.": { width: 130 } },
      }, { fires: ["hourglass"] });
      await scenario("PSD reopened, two words cut in its pixels", {
        page,
        texts: [Object.assign({ text: "THIS IS INCRED-\rIBLE AND FANTAS-\rTIC, ISN'T IT?", size: 24 }, box(320, 320, 360, 160))],
        reopen: { "THIS IS INCRED-\rIBLE AND FANTAS-\rTIC, ISN'T IT?": { width: 120 } },
      }, { fires: ["many-cuts"] });
      // Cut off in the pixels too: the page lacks those words
      await scenario("PSD reopened, cut off by its box", {
        page: {},
        texts: [Object.assign({ text: "THIS TEXT IS FAR TOO LONG TO FIT IN SUCH A SMALL BOX, ITS LAST LINES ARE CUT OFF.", size: 24 }, box(100, 100, 200, 60))],
        reopen: {},
      }, { fires: ["text-overflow"] });
      // A stray character after the text, cut off by the box: nothing a reader misses
      await scenario("PSD reopened, a stray character cut off", {
        page: {},
        texts: [Object.assign({ text: "END OF\rCHAPTER 104\r0", size: 24 }, box(100, 100, 220, 62))],
        reopen: {},
      }, { quiet: ["text-overflow"] });
      // A clean page, saved and opened again: still nothing to report
      await scenario("clean page, saved as PSD and opened again", Object.assign({}, clean, { reopen: {} }), { rules: null, only: [] });
    }

    /* ------------------------------- the rest -------------------------------- */
    // A fix on a page that isn't the one shown: it is shown, and fixed
    {
      const r = await page.evaluate(async () => {
        const PS = window.TypeRPhotoshop;
        window.__vt.page({ bubbles: [{ x: 500, y: 400, rx: 300, ry: 200 }] });
        window.__vt.text({ text: "HELLO  THERE.", x: 500, y: 400 });
        const first = PS.app.doc;
        window.__vt.page({});
        const second = PS.app.doc;
        const issues = await window.TypeRVerify.check(first, {});
        const issue = issues.find((i) => i.rule === "double-space");
        const steps = first.historyIndex;
        const ok = window.TypeRVerify.fix(first, issue);
        const text = first.state.layers.find((l) => l.kind === "text").params.layerText.textKey;
        const out = { ok, active: PS.app.doc === first, steps: first.historyIndex - steps, text, kept: Boolean(issue) };
        PS.ops.closeDoc(second);
        if (PS.app.doc !== first) PS.setActiveDoc(first);
        PS.ops.closeDoc(first);
        return out;
      });
      pass("a fix on another open page shows that page and fixes it", r.ok && r.active && r.steps === 1 && r.text === "HELLO THERE.", JSON.stringify(r));
    }
    // Ids stay the same from one run to the next
    {
      await build({ page: { bubbles: [BUBBLE(500, 400, 300, 200)] }, texts: [{ text: "HELLO  THERE !", x: 450, y: 380 }] });
      const a = await run(all);
      const b = await run(all);
      pass("issue ids are stable", JSON.stringify(a.issues.map((i) => i.id)) === JSON.stringify(b.issues.map((i) => i.id)) && a.issues.length > 0, a.issues.map((i) => i.id).join(", "));
      pass("every issue has its fields", a.issues.every((i) => i.id && i.rule && i.category && i.severity && i.message && typeof i.message.text === "string" && "excerpt" in i && "rect" in i && "fix" in i && "data" in i));
      await close();
    }
    // Stopping a check
    {
      await build(clean);
      const r = await page.evaluate(async () => {
        const c = new AbortController();
        const p = window.TypeRVerify.check(window.TypeRPhotoshop.app.doc, { signal: c.signal });
        c.abort();
        try {
          await p;
          return "finished";
        } catch (error) {
          return error.name;
        }
      });
      pass("a check stops with an AbortError", r === "AbortError", r);
      await close();
    }
    // A webtoon strip: long, many texts
    {
      const bubbles = [];
      const texts = [];
      for (let k = 0; k < 40; k++) {
        const y = 300 + k * 480;
        bubbles.push(BUBBLE(k % 2 ? 520 : 300, y, 190, 130));
        texts.push({ text: "THIS IS\rLINE NUMBER " + (k + 1) + "\rOF THE STRIP.", x: k % 2 ? 520 : 300, y, size: 24, align: true });
      }
      const ids = await build({ page: { width: 800, height: 20000, hatch: [[0, 0, 800, 20000]], bubbles }, texts });
      const first = await run(null);
      const again = await run(null);
      pass(`webtoon strip 800x20000, 40 texts: ${first.ms.toFixed(0)} ms (again ${again.ms.toFixed(0)} ms), ${first.issues.length} issues`, first.ms < 3000 && first.issues.length === 0, show(first.issues));
      await close();
      void ids;
    }
    {
      const bubbles = [];
      const texts = [];
      for (let k = 0; k < 42; k++) {
        const x = 170 + (k % 6) * 330;
        const y = 180 + Math.floor(k / 6) * 400;
        bubbles.push(BUBBLE(x, y, 150, 110));
        texts.push({ text: "LINE " + (k + 1) + ",\rWELL PLACED.", x, y, size: 22, align: true });
      }
      await build({ page: { width: 2000, height: 3000, hatch: [[0, 0, 2000, 3000]], bubbles }, texts });
      const r = await run(null);
      pass(`2000x3000 page, 42 texts: ${r.ms.toFixed(0)} ms, ${r.issues.length} issues`, r.ms < 1500 && r.issues.length === 0, show(r.issues));
      await close();
    }

    // Each rule: seen reporting and seen quiet
    ruleIds.forEach((id) => {
      const s = seen.get(id);
      pass(`rule ${id}: triggered and stayed quiet where it should`, s.fired && s.clean, JSON.stringify(s));
    });
    pass("no error in the page", !errors.length, errors.join(" | "));
  } finally {
    await browser.close();
    server.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `, ${failed.length} failed:` : ""}`);
  failed.forEach((r) => console.log(`  FAIL ${r.name}  ${r.detail || ""}`));
  process.exit(failed.length ? 1 : 0);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
