#!/usr/bin/env node
// Drives the Verification panel (web/verify.js) in the real app, headless, as a typesetter would:
// opens it from the menu and by its keys, checks a page, goes to a mistake, fixes it, undoes,
// ignores, switches a rule off, checks the open pages, the settings, and AI proofreading with
// OpenAI's and Anthropic's addresses answered here (page.route), then the review of its
// suggestions on the page: started by itself, the card, Accept, Discard, Previous, Next and Esc
// by their keys and their buttons, the shape after a correction, undo, the pages switched, no
// key taken while a text is typed. Screenshots in the dark and the light theme go to
// /tmp/verify-ui (or the folder given). Exits non-zero on failure.
//
//   node scripts/verify-ui-check.js [screenshots folder]
//
// Also boots the app once without verify-rules.js and once without proofread.js: no console error.
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require(path.join(__dirname, "..", "desktop", "node_modules", "playwright-core"));

const ROOT = path.join(__dirname, "..");
const SHOTS = process.argv[2] || "/tmp/verify-ui";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
fs.mkdirSync(SHOTS, { recursive: true });

let failures = 0;
let passes = 0;
const ok = (condition, label) => {
  if (condition) passes += 1;
  else {
    failures += 1;
    console.log(`  FAIL ${label}`);
  }
};
const section = (name) => console.log(`- ${name}`);

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json", ".wasm": "application/wasm" };
// The repo as the site serves it; `missing` answers 404 for one file
const serve = (missing) => new Promise((resolve) => {
  const server = http.createServer((request, response) => {
    const url = decodeURIComponent(new URL(request.url, "http://x").pathname);
    let file = path.join(ROOT, url);
    if (!file.startsWith(ROOT)) return response.writeHead(403).end();
    if (url.endsWith("/")) file = path.join(file, "index.html");
    if (missing && url === missing) return response.writeHead(404).end();
    fs.readFile(file, (error, data) => {
      if (error) return response.writeHead(404).end();
      response.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
      response.end(data);
    });
  });
  server.listen(0, "127.0.0.1", () => resolve(server));
});

const boot = async (browser, server, { width = 1440, height = 900 } = {}) => {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  // No service worker: every file as it is on disk
  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, "serviceWorker", { get: () => undefined });
    } catch (error) {}
  });
  const page = await context.newPage();
  const errors = [];
  // The text mask service's health ping, refused from a local address, isn't the app's error
  // and what the AI services' addresses answer here on purpose (a refused key, no credit…) is theirs
  page.on("console", (message) => {
    const from = (message.location() && message.location().url) || "";
    if (message.type() === "error" && !/temizle|\/health|api\.anthropic\.com|api\.openai\.com/.test(from) && !/temizle|Failed to load resource: net::ERR_FAILED/.test(message.text())) errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error && error.stack || error)));
  await page.goto(`http://127.0.0.1:${server.address().port}/web/?lang=en`);
  // The setup assistant, What's New and the beta notice wait for an answer before the app is up
  for (let tries = 0; tries < 300; tries++) {
    if (await page.evaluate(() => Boolean(window.TypeRApp && window.TypeRApp.booted))) break;
    const skip = await page.$("dialog.onboard[open] .onboard__skip");
    if (skip) await skip.click().catch(() => {});
    else await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach((one) => { const yes = one.querySelector(".modal__foot .btn--main, .wn__close, [data-close]"); if (yes) yes.click(); else one.close(); }));
    await page.waitForTimeout(100);
  }
  if (!(await page.evaluate(() => Boolean(window.TypeRApp && window.TypeRApp.booted)))) throw new Error(`The app didn't boot: ${errors.join(" | ")}`);
  await page.waitForTimeout(300);
  return { context, page, errors };
};

// A page with mistakes: 2000 × 3000, a white background, texts with a double space, an empty
// text, a text off the page, and a spelling mistake for the proofreading
const makePage = (page, name, texts) => page.evaluate(({ name, texts }) => {
  const { ops, app } = window.TypeRPhotoshop;
  ops.newDocument({ name, width: 2000, height: 3000, resolution: 72, background: "#ffffff" });
  // A bubble around each text that has one: a white ellipse, its black outline
  const bitmap = document.createElement("canvas");
  bitmap.width = 2000;
  bitmap.height = 3000;
  const c = bitmap.getContext("2d");
  c.fillStyle = "#fff";
  c.strokeStyle = "#000";
  c.lineWidth = 6;
  texts.forEach(([x, y, , w, h, bubble]) => {
    if (!bubble) return;
    c.beginPath();
    c.ellipse(x + (w || 600) / 2, y + (h || 300) / 2, (w || 600) * 0.75, (h || 300) * 0.8, 0, 0, Math.PI * 2);
    c.fill();
    c.stroke();
  });
  ops.newLayer("Bubbles", undefined, { bitmap });
  const ids = texts.map(([x, y, text, w, h]) => ops.newText(x, y, text, { width: w || 600, height: h || 300 }).id);
  return { id: app.doc.id, ids };
}, { name, texts });

const state = (page) => page.evaluate(() => {
  const V = window.TypeRVerification;
  const { app } = window.TypeRPhotoshop;
  const shown = V && app.doc ? V.issuesOf(app.doc) : null;
  return {
    open: Boolean(V && V.isOpen()),
    running: Boolean(V && V.running),
    rows: document.querySelectorAll("#verify .verify__row:not(.is-ignored)").length,
    ignoredRows: document.querySelectorAll("#verify .verify__row.is-ignored").length,
    summary: (document.querySelector("#verify .verify__summary") || {}).textContent || "",
    rules: shown ? shown.shown.map((issue) => issue.rule) : [],
    active: app.doc ? app.doc.state.activeIds.slice() : [],
    view: app.doc ? Object.assign({}, app.doc.view) : null,
    doc: app.doc ? app.doc.name : "",
  };
});
const settle = async (page) => {
  await page.waitForTimeout(80);
  await page.waitForFunction(() => window.TypeRVerification && !window.TypeRVerification.running, null, { timeout: 20000 });
  await page.waitForTimeout(700);
  await page.waitForFunction(() => window.TypeRVerification && !window.TypeRVerification.running, null, { timeout: 20000 });
};
const clickMenu = async (page, menu, item) => {
  await page.click(`.menu__button:text-is("${menu}")`);
  await page.click(`.menu__list .menu__item:has-text("${item}")`);
};
const rowOf = (page, rule) => page.$(`#verify .verify__row[data-key$=":${rule}"], #verify .verify__row[data-key*=":${rule}:"]`);

const layerText = (page, id) => page.evaluate((id) => {
  for (const doc of window.TypeRPhotoshop.app.docs) {
    const layer = doc.state.layers.find((one) => one.id === id);
    if (layer) return layer.params.layerText.textKey;
  }
  return null;
}, id);
const ai = (page) => page.evaluate(() => {
  const box = document.querySelector("#verify .verify__ai");
  return { hidden: !box || box.hidden, text: box ? box.textContent : "", className: box ? box.className : "", buttons: box ? Array.from(box.querySelectorAll("button")).map((one) => one.textContent).filter(Boolean) : [] };
});
const modalOpen = (page) => page.evaluate(() => document.getElementById("modal").open);
// The review of the suggestions: where it is, what its card says, where its marks are
const reviewOf = (page) => page.evaluate(() => {
  const V = window.TypeRVerification;
  const r = V.reviewing;
  const card = document.querySelector(".proof-card");
  const box = (el) => (el && !el.hidden ? (({ left, top, right, bottom }) => ({ left, top, right, bottom }))(el.getBoundingClientRect()) : null);
  return {
    on: Boolean(r),
    step: r ? r.step : "",
    doc: r ? r.doc.name : "",
    excerpt: r ? r.finding.excerpt : "",
    editing: r ? r.editing : false,
    shown: Boolean(card && !card.hidden),
    text: card && !card.hidden ? card.textContent : "",
    gone: card ? Array.from(card.querySelectorAll(".proof-card__text del")).map((el) => el.textContent) : [],
    come: card ? Array.from(card.querySelectorAll(".proof-card__text ins")).map((el) => el.textContent) : [],
    buttons: card ? Array.from(card.querySelectorAll("button")).map((el) => el.textContent) : [],
    card: box(card),
    ring: box(document.querySelector(".proof-ring")),
    words: Array.from(document.querySelectorAll(".proof-word")).map((el) => Object.assign(box(el), { line: el.classList.contains("is-line"), done: el.classList.contains("is-done") })),
    count: V.suggestions(),
    doc_: window.TypeRPhotoshop.app.doc ? window.TypeRPhotoshop.app.doc.name : "",
  };
});
const cardButton = (page, label) => page.click(`.proof-card button:has(span:text-is("${label}"))`);
const overlaps = (a, b) => Boolean(a && b) && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const historyOf = (page) => page.evaluate(() => { const doc = window.TypeRPhotoshop.app.doc; return { index: doc.historyIndex, names: doc.history.slice(0, doc.historyIndex + 1).map((one) => one.name) }; });
const linesOfText = (page, id) => page.evaluate((id) => {
  const { app, lineModel } = window.TypeRPhotoshop;
  const layer = app.doc.state.layers.find((one) => one.id === id);
  return layer ? lineModel(layer, app.doc).breaks.length + 1 : 0;
}, id);
const modalOk = (page) => page.click("#modal .modal__foot .btn--main");
const modalCancel = (page) => page.click("#modal .modal__foot .btn:not(.btn--main)");
const proofDone = (page) => page.waitForFunction(() => !window.TypeRVerification.proofreading, null, { timeout: 30000 });
const shot = async (page, name, element) => {
  const file = path.join(SHOTS, `${name}.png`);
  if (element) await (await page.$(element)).screenshot({ path: file });
  else await page.screenshot({ path: file });
  return file;
};

// Anthropic and OpenAI, as their APIs answer: each test sets what they say next
const json = (body, status = 200) => ({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
const ANTHROPIC_MODELS = { data: [{ type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5", capabilities: { structured_outputs: { supported: true } }, max_tokens: 64000 }, { type: "model", id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5", capabilities: { structured_outputs: { supported: true } }, max_tokens: 64000 }], has_more: false, first_id: "claude-opus-5-5", last_id: "claude-sonnet-5-5" };
const OPENAI_MODELS = { object: "list", data: [{ id: "gpt-6-astra", object: "model", created: 1790000000, owned_by: "openai" }, { id: "gpt-6-luna", object: "model", created: 1790000000, owned_by: "openai" }, { id: "text-embedding-4", object: "model", created: 1780000000, owned_by: "openai" }] };
// The mistakes the "model" finds: "teh" wherever it is
const findingsFor = (user) => {
  const out = [];
  JSON.parse(user).pages.forEach((page) => page.texts.forEach((one) => {
    if (one.text.includes("teh")) out.push({ ref: one.ref, kind: "spelling", excerpt: "teh", suggestion: "the", replacement: one.text.replace("teh", "the"), explanation: "“teh” is a typo for “the”." });
  }));
  return { findings: out };
};
const services = {
  anthropic: { models: () => json(ANTHROPIC_MODELS), messages: (body) => json({ id: "msg_1", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: JSON.stringify(findingsFor(body.messages[0].content)) }], stop_reason: "end_turn", usage: { input_tokens: 1234, output_tokens: 56 } }) },
  openai: { models: () => json(OPENAI_MODELS), responses: (body) => json({ id: "resp_1", object: "response", status: "completed", model: body.model, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(findingsFor(body.input)) }] }], usage: { input_tokens: 900, output_tokens: 40 } }) },
};
const calls = [];

(async () => {
  const server = await serve();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const { context, page, errors } = await boot(browser, server);
    await page.evaluate(() => { try { ["typer.web.verify", "typer.web.proofread", "typer.web.proofread.models"].forEach((key) => localStorage.removeItem(key)); } catch (error) {} });
    await context.route("https://api.anthropic.com/**", async (route) => {
      const request = route.request();
      calls.push({ url: request.url(), headers: request.headers() });
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST" } });
      const url = new URL(request.url());
      const answer = url.pathname.startsWith("/v1/models") ? services.anthropic.models() : await services.anthropic.messages(JSON.parse(request.postData() || "{}"));
      if (answer === "abort") return route.abort("failed");
      return route.fulfill(answer);
    });
    await context.route("https://api.openai.com/**", async (route) => {
      const request = route.request();
      calls.push({ url: request.url(), headers: request.headers() });
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST" } });
      const url = new URL(request.url());
      const answer = url.pathname.startsWith("/v1/models") ? services.openai.models() : await services.openai.responses(JSON.parse(request.postData() || "{}"));
      if (answer === "abort") return route.abort("failed");
      return route.fulfill(answer);
    });
    // Room for the panel: the Character and Line Breaks panels put away
    await page.evaluate(() => { window.TypeRWorkspace.setVisible("character", false); window.TypeRWorkspace.setVisible("breaks", false); });

    section("nothing runs at startup");
    ok(await page.evaluate(() => Boolean(window.TypeRVerification) && !window.TypeRVerification.isOpen() && !window.TypeRVerification.running), "the panel is there, closed and idle");

    const first = await makePage(page, "page-012.psd", [
      [700, 500, "Hello  there, how are you?", 600, 300, true],
      [1200, 1200, "I didn't see teh car coming at all, it was so fast!", 600, 300, true],
      [1900, 2900, "Off the page, this one."],
      [500, 2000, "Another line... ok.", 600, 300, true],
    ]);

    section("open from Window > Verification");
    await clickMenu(page, "Window", "Verification");
    await settle(page);
    let now = await state(page);
    ok(now.open, "Window > Verification opens the panel");
    ok(now.rows > 0, `the check lists rows (${now.rows})`);
    ok(now.rules.includes("double-space"), "the double space is found");
    ok(now.rules.includes("off-page"), "the text off the page is found");
    ok(/to look at/.test(now.summary), `the summary counts them: "${now.summary.trim()}"`);
    await shot(page, "dark-page");

    section("closed by Alt+Cmd+V, opened again");
    await page.focus("#stage");
    await page.keyboard.press("Alt+Meta+KeyV");
    await page.waitForTimeout(200);
    ok(!(await state(page)).open, "the shortcut closes it");
    await page.keyboard.press("Alt+Meta+KeyV");
    await settle(page);
    ok((await state(page)).open, "the shortcut opens it");

    section("a row takes you there");
    await page.evaluate(() => { const { app } = window.TypeRPhotoshop; app.doc.view.zoom = 2; app.doc.view.x = 0; app.doc.view.y = 0; window.TypeRApp.viewChanged(); });
    const before = (await state(page)).view;
    await (await rowOf(page, "off-page")).click();
    await page.waitForTimeout(150);
    now = await state(page);
    ok(now.active.length === 1 && now.active[0] === first.ids[2], "the layer is selected");
    ok(now.view.x !== before.x || now.view.y !== before.y || now.view.zoom !== before.zoom, "the view moved");
    ok(await page.evaluate(() => !document.querySelector(".verify-mark").hidden), "the place is marked");
    ok(await page.evaluate(() => { const box = document.querySelector(".verify-mark").getBoundingClientRect(); const stage = document.getElementById("stage").getBoundingClientRect(); return box.right > stage.left && box.left < stage.right && box.bottom > stage.top && box.top < stage.bottom; }), "the mark is on screen");
    await shot(page, "dark-goto");

    section("the keyboard: arrows, Enter goes there");
    await page.focus("#verify .verify__row[tabindex='0']");
    await page.keyboard.press("ArrowDown");
    const focused = await page.evaluate(() => document.activeElement && document.activeElement.dataset.key);
    ok(Boolean(focused), "ArrowDown moves to the next row");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(100);
    now = await state(page);
    const wantedLayer = await page.evaluate((key) => { const issue = window.TypeRVerification.issuesOf().shown.find((one) => key.endsWith(`:${one.id}`)); return issue ? issue.layerId : null; }, focused);
    ok(wantedLayer === null || now.active.includes(wantedLayer), "Enter selects its layer");

    section("fix in one click, undo brings it back");
    await (await (await rowOf(page, "double-space")).$(".verify__fix")).click();
    await settle(page);
    ok(!(await layerText(page, first.ids[0])).includes("  "), "the double space is gone from the text");
    ok(!(await state(page)).rules.includes("double-space"), "its row is gone");
    await page.focus("#stage");
    await page.keyboard.press("Meta+KeyZ");
    await settle(page);
    ok((await layerText(page, first.ids[0])).includes("  "), "Cmd+Z puts the double space back");
    ok((await state(page)).rules.includes("double-space"), "and its row comes back");

    section("ignore, shown struck under Ignored, shown again");
    await (await (await rowOf(page, "double-space")).$(".verify__link")).click();
    await page.waitForTimeout(100);
    now = await state(page);
    ok(!now.rules.includes("double-space"), "ignored, it leaves the list");
    ok(await page.evaluate(() => /Ignored/.test((document.querySelector("#verify .verify__group--ignored") || {}).textContent || "")), "an Ignored group counts it");
    ok(await page.evaluate(() => { const kept = JSON.parse(localStorage.getItem("typer.web.verify") || "{}"); return Object.values(kept.ignored || {}).some((ids) => ids.some((id) => id.startsWith("double-space"))); }) || (await page.waitForTimeout(300), await page.evaluate(() => { const kept = JSON.parse(localStorage.getItem("typer.web.verify") || "{}"); return Object.values(kept.ignored || {}).some((ids) => ids.some((id) => id.startsWith("double-space"))); })), "remembered for that page");
    await page.click("#verify .verify__group--ignored .verify__twist");
    now = await state(page);
    ok(now.ignoredRows === 1, "opened, the ignored row shows");
    await shot(page, "dark-ignored", "#pane-verify");
    await page.click("#verify .verify__row.is-ignored .verify__link");
    ok((await state(page)).rules.includes("double-space"), "Show again brings it back");

    section("Don't check this again, then back on in the settings");
    await (await (await rowOf(page, "off-page")).$(".verify__more")).click();
    await page.click(".menu__list--context .menu__item:has-text(\"Don't Check This Again\")");
    await page.waitForTimeout(100);
    ok(!(await state(page)).rules.includes("off-page"), "the rule's rows are gone");
    await page.click("#verify .verify__settings");
    await page.waitForSelector("#modal .vset");
    ok(await page.evaluate(() => document.querySelectorAll("#modal .vset__rule").length > 20), "the settings list every rule");
    await shot(page, "dark-settings", "#modal");
    const offSwitch = await page.$("#modal .vset__rule:has(.vset__title:text-is('Text outside the page')) .vset__switch");
    ok(!(await offSwitch.isChecked()), "the rule switched off shows off");
    const marginInput = (value) => page.evaluate((value) => {
      const row = Array.from(document.querySelectorAll("#modal .vset__rule")).find((one) => one.querySelector(".vset__title").textContent === "Text against the edge of its bubble");
      const input = row.querySelector("input[type=number]");
      if (value !== undefined) input.value = value;
      return input.value;
    }, value);
    await marginInput("40");
    await page.click("#modal .vset__reset");
    ok(await offSwitch.isChecked(), "Back to the defaults turns it on again");
    const margin = await marginInput();
    const wanted = await page.evaluate(() => String(window.TypeRVerify.defaults()["bubble-edge"].margin));
    ok(margin === wanted, `and gives the options their defaults (${margin})`);
    await page.click("#modal .vset__rule:has(.vset__title:text-is('Double spaces')) .vset__top");
    await modalOk(page);
    await settle(page);
    now = await state(page);
    ok(now.rules.includes("off-page") && !now.rules.includes("double-space"), "OK applies them: off-page back, double spaces off");
    await page.click("#verify .verify__settings");
    await page.click("#modal .vset__reset");
    await modalOk(page);
    await settle(page);
    ok((await state(page)).rules.includes("double-space"), "defaults again");

    section("two pages: this page, all open pages");
    await makePage(page, "page-013.psd", [[600, 600, "Second  page here.", 600, 300, true], [600, 1600, "All good on this one.", 600, 300, true]]);
    await settle(page);
    now = await state(page);
    ok(now.doc === "page-013.psd" && now.rules.includes("double-space"), "a new page in front is checked by itself");
    await page.click("#verify .verify__scope button[data-scope='all']");
    await settle(page);
    ok(await page.evaluate(() => document.querySelectorAll("#verify .verify__page").length === 2), "all open pages: a section each");
    await shot(page, "dark-all-pages", "#pane-verify");
    const otherRow = await page.$("#verify .verify__page:has(.verify__gname:text-is('page-012.psd')) .verify__row .verify__message");
    await otherRow.click();
    await page.waitForTimeout(150);
    ok((await state(page)).doc === "page-012.psd", "a row of another page brings that page to the front");

    section("Batch Save says what the check left");
    await clickMenu(page, "File", "Batch Save…");
    await page.waitForSelector("#modal .bsave");
    ok(await page.evaluate(() => Boolean(document.querySelector("#modal .verify-batch")) && !document.querySelector("#modal .verify-batch").hidden), "a line in Batch Save");
    await shot(page, "dark-batch", "#modal");
    await page.click("#modal .verify-batch .verify__link");
    await page.waitForTimeout(150);
    ok(!(await modalOpen(page)) && (await state(page)).open, "Show them closes the dialog, the panel shows");
    await page.click("#verify .verify__scope button[data-scope='page']");
    await settle(page);

    section("AI proofreading: first use opens its settings");
    await page.click("#pane-verify .verify__proof");
    await page.waitForSelector("#modal .aiset");
    ok(await page.$eval("#modal .aiset__state", (el) => /usual models/.test(el.textContent)), "no key: the usual models, said");
    await page.selectOption("#modal .aiset select", "anthropic");
    await page.fill("#modal .gensettings__key input", "sk-ant-test");
    await page.dispatchEvent("#modal .gensettings__key input", "change");
    await page.waitForFunction(() => document.querySelector("#modal .aiset__state.is-live"));
    ok(await page.$eval("#modal .aiset__model select", (select) => Array.from(select.options).some((one) => one.value === "claude-sonnet-5-5")), "the list comes live from Anthropic");
    ok(calls.some((one) => /api\.anthropic\.com\/v1\/models/.test(one.url) && one.headers["x-api-key"] === "sk-ant-test"), "asked with the key, from Anthropic only");
    await page.click("#modal .gensettings__key .icon-btn");
    ok(await page.$eval("#modal .gensettings__key input", (input) => input.type === "text"), "the eye shows the key");
    await shot(page, "dark-ai-settings", "#modal");
    // OpenAI refuses the key: the list is the offline one, said so
    await page.selectOption("#modal .aiset select", "openai");
    services.openai.models = () => json({ error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key", param: null } }, 401);
    await page.fill("#modal .gensettings__key input", "sk-bad");
    await page.dispatchEvent("#modal .gensettings__key input", "change");
    await page.waitForFunction(() => /did not accept/.test((document.querySelector("#modal .aiset__state") || {}).textContent || ""));
    ok(await page.$eval("#modal .aiset__state", (el) => el.classList.contains("is-offline") && /Offline list/.test(el.textContent)), "a refused key: the offline list, and why");
    await shot(page, "dark-ai-offline", "#modal");
    services.openai.models = () => json(OPENAI_MODELS);
    await page.fill("#modal .gensettings__key input", "sk-openai-good");
    await page.dispatchEvent("#modal .gensettings__key input", "change");
    await page.waitForFunction(() => document.querySelector("#modal .aiset__state.is-live"));
    ok(await page.$eval("#modal .aiset__model select", (select) => !Array.from(select.options).some((one) => /embedding/.test(one.value))), "OpenAI's list keeps the text models");
    await page.fill("#modal .aiset__other", "gpt-6-custom-id");
    await page.selectOption("#modal .aiset select", "anthropic");
    await modalOk(page);
    // The consent, once
    await page.waitForSelector("#modal .modal__body p");
    ok(await page.$eval("#modal .modal__body", (el) => /Anthropic/.test(el.textContent) && /bills/.test(el.textContent)), "before the first send: where the texts go, who bills");
    await shot(page, "dark-consent", "#modal");
    await modalOk(page);
    await proofDone(page);
    let said = await ai(page);
    ok(/1 suggestion/.test(said.text) && /tokens/.test(said.text), `the run says what it found and used: "${said.text}"`);
    ok(await page.evaluate(() => document.querySelectorAll("#verify .verify__row.is-proof").length === 1), "the finding is a row under Proofreading");
    ok(await page.evaluate(() => /PROOFREADING|Proofreading/i.test(document.querySelector("#verify").textContent)), "in its own category");
    ok(await page.evaluate(() => { const first = document.querySelector("#verify .verify__group .verify__gname"); return Boolean(first) && /proofreading/i.test(first.textContent); }), "the proofreading group comes first in the list");
    await shot(page, "dark-proofread", "#pane-verify");

    section("the review: it starts by itself on the suggestion, on the page");
    let seen = await reviewOf(page);
    ok(seen.on && seen.step === "finding" && seen.shown, "the run ends on the suggestion's card, beside its text");
    ok(/Spelling/.test(seen.text) && /1 of 1/.test(seen.text), `the card says the kind and where it is: "${seen.text.slice(0, 40)}"`);
    ok(seen.gone.join() === "teh" && seen.come.join() === "the", `the faulty word struck, the correction beside it (${seen.gone} → ${seen.come})`);
    ok(/typo/.test(seen.text), "and why");
    ok(seen.buttons.some((one) => /Accept/.test(one)) && seen.buttons.some((one) => /Edit text/.test(one)) && seen.buttons.some((one) => /Discard/.test(one)), `its buttons: ${seen.buttons.filter(Boolean).join(" | ")}`);
    ok(await page.evaluate(() => Array.from(document.querySelectorAll(".proof-card button kbd")).length >= 4), "each with its keys");
    ok(seen.ring && seen.words.length === 1 && !seen.words[0].line, "the text ringed, the faulty word marked");
    ok(seen.words.length && seen.words[0].left >= seen.ring.left && seen.words[0].right <= seen.ring.right && seen.words[0].top >= seen.ring.top - 1 && seen.words[0].bottom <= seen.ring.bottom + 1, "the mark inside the ring");
    ok(!overlaps(seen.card, seen.ring), "the card never covers the text");
    {
      // The word marked is "teh": where TypeR draws those letters
      const where = await page.evaluate((id) => {
        const { app, caretLines } = window.TypeRPhotoshop;
        const doc = app.doc;
        const layer = doc.state.layers.find((one) => one.id === id);
        const at = layer.params.layerText.textKey.indexOf("teh");
        const line = caretLines(layer, doc).find((one) => at >= one.start && at < one.end);
        const [x0] = window.TypeRApp.toScreen(line.xs[at - line.start], 0);
        const [x1] = window.TypeRApp.toScreen(line.xs[at + 3 - line.start], 0);
        const stage = document.getElementById("stage").getBoundingClientRect();
        return { left: stage.left + x0, right: stage.left + x1 };
      }, first.ids[1]);
      ok(Math.abs(seen.words[0].left + 2 - where.left) < 3 && Math.abs(seen.words[0].right - 2 - where.right) < 3, `the mark is on "teh" (${Math.round(seen.words[0].left)}–${Math.round(seen.words[0].right)} for ${Math.round(where.left)}–${Math.round(where.right)})`);
    }
    said = await ai(page);
    ok(said.buttons.includes("Review"), "the status line has a Review button");
    await shot(page, "dark-review-auto");
    await page.keyboard.press("Escape");
    seen = await reviewOf(page);
    ok(!seen.on && !seen.shown && !(await page.evaluate(() => !document.querySelector(".proof-ring").hidden)), "Esc closes the review, its ring and its card");
    await page.click("#verify .verify__ai .verify__aitext");
    ok((await reviewOf(page)).on, "the status line itself starts it again");
    await page.keyboard.press("Escape");
    await page.click("#verify .verify__ai button:text-is('Review')");
    ok((await reviewOf(page)).on, "and its Review button");
    await page.keyboard.press("Escape");
    await page.click("#verify .verify__row.is-proof .verify__message");
    seen = await reviewOf(page);
    ok(seen.on && seen.excerpt === "teh", "a row of the list starts it on its suggestion");
    await page.keyboard.press("Escape");
    const typo = first.ids[1];
    await page.click("#verify .verify__row.is-proof .verify__fix");
    await page.waitForTimeout(200);
    ok((await layerText(page, typo)) === "I didn't see the car coming at all, it was so fast!", "Apply writes the correction");
    ok(await page.evaluate(() => document.querySelectorAll("#verify .verify__row.is-proof").length === 0), "and its row goes");
    await page.focus("#stage");
    await page.keyboard.press("Meta+KeyZ");
    await page.waitForTimeout(200);
    ok((await layerText(page, typo)).includes("teh"), "Cmd+Z takes it back");
    const anthropicSent = calls.filter((one) => /\/v1\/messages/.test(one.url)).length;
    ok(anthropicSent === 1 && !calls.some((one) => /openai/.test(one.url) && one.headers.authorization === "Bearer sk-ant-test"), "the Anthropic key only went to Anthropic");

    section("AI proofreading: each error, in the user's words, with the way out");
    const errorsToTry = [
      ["key", () => json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, 401), /did not accept the API key/, "Open the settings"],
      ["quota", () => json({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } }, 400), /no credit left/, "Open the settings"],
      ["model", () => json({ type: "error", error: { type: "not_found_error", message: "model: claude-opus-5-5" } }, 404), /does not offer the model/, "Open the settings"],
      ["network", () => "abort", /could not be reached/, "Try again"],
      ["refused", (body) => json({ id: "m", type: "message", role: "assistant", model: body.model, content: [], stop_reason: "refusal", usage: { input_tokens: 10, output_tokens: 0 } }), /declined/, null],
    ];
    for (const [code, answer, words, way] of errorsToTry) {
      services.anthropic.messages = answer;
      await page.click("#pane-verify .verify__proof");
      await proofDone(page);
      said = await ai(page);
      ok(words.test(said.text) && /is-error/.test(said.className), `${code}: "${said.text}"`);
      if (way) ok(said.buttons.includes(way), `${code}: ${way}`);
      if (code === "key") {
        await shot(page, "dark-ai-error", "#pane-verify");
        await page.click(`#verify .verify__ai button:text-is("Open the settings")`);
        await page.waitForSelector("#modal .aiset");
        ok(true, "the way out opens the settings");
        await modalCancel(page);
      }
    }
    // Stopped while it runs
    services.anthropic.messages = () => new Promise((resolve) => setTimeout(() => resolve(json({ content: [], stop_reason: "end_turn", usage: {} })), 4000));
    await page.click("#pane-verify .verify__proof");
    await page.waitForSelector("#verify .verify__ai.is-busy");
    await shot(page, "dark-ai-busy", "#pane-verify");
    await page.click(`#verify .verify__ai button:text-is("Stop")`);
    await proofDone(page);
    ok(/stopped/i.test((await ai(page)).text), "Stop ends it, and says so");
    // OpenAI, its Responses API
    services.anthropic.messages = services.openai.responses;
    await page.evaluate(() => { const P = window.TypeRProofread; P.save(Object.assign(P.load(), { service: "openai", model: Object.assign(P.load().model, { openai: "gpt-6-astra" }) })); });
    await page.click("#pane-verify .verify__proof");
    await page.waitForSelector("#modal .modal__body p");
    ok(await page.$eval("#modal .modal__body", (el) => /OpenAI/.test(el.textContent)), "a new service: asked once again");
    await modalOk(page);
    await proofDone(page);
    ok(/1 suggestion/.test((await ai(page)).text) && calls.some((one) => /api\.openai\.com\/v1\/responses/.test(one.url) && one.headers.authorization === "Bearer sk-openai-good"), "OpenAI proofreads with its own key");
    ok(await page.evaluate(() => document.querySelectorAll("#verify .verify__row.is-proof").length === 1), "its finding in the list");

    section("the list stays true: an edit, typing");
    await page.evaluate((id) => { window.TypeRPhotoshop.ops.selectLayer(id); window.TypeRPhotoshop.ops.setText(id, "I didn't see the car."); }, typo);
    await settle(page);
    ok(await page.evaluate(() => document.querySelectorAll("#verify .verify__row.is-proof").length === 0), "the finding goes when its text changes");

    section("the script: the page's own lines, cleaned as the panel pastes them");
    const lines = await page.evaluate(() => {
      const { app } = window.TypeRPhotoshop;
      const doc = app.docs.find((one) => one.name === "page-012.psd");
      const frame = document.querySelector("#dock-typer iframe").contentWindow;
      const where = window.TypeRKit.activeStoragePath();
      const storage = JSON.parse((frame.__typerWeb && frame.__typerWeb.getFile(where)) || window.TypeRKit.read(where) || "{}");
      storage.tabs = [{ id: "verify-test", name: "Chapter", text: "Page 11\nNot this one.\n**Page 12**\nHello  there, how are you?\n## a note to skip\n//: A line never typeset. [sfx]\n\nPage 13\nNor this one." }];
      storage.currentTabId = "verify-test";
      storage.ignoreTags = ["[sfx]"];
      if (frame.__typerWeb) frame.__typerWeb.setFile(where, JSON.stringify(storage));
      return { mine: window.TypeRApp.verify.scriptOf(doc), none: window.TypeRApp.verify.scriptOf(app.docs.find((one) => one.name === "page-040.psd") || { name: "cover.psd", path: "x" }) };
    });
    ok(JSON.stringify(lines.mine) === JSON.stringify(["Hello  there, how are you?", "A line never typeset."]), `page 12's lines: ${JSON.stringify(lines.mine)}`);
    ok(lines.none === null, "a page the script has no heading for: null");
    await page.evaluate(() => window.TypeRPhotoshop.setActiveDoc(window.TypeRPhotoshop.app.docs.find((one) => one.name === "page-012.psd")));
    await page.click("#verify .verify__scope button[data-scope='page']");
    await page.evaluate(() => window.TypeRVerification.check());
    ok((await state(page)).rules.includes("script-line-missing"), "the line never typeset is reported");

    section("Edit > Search finds it");
    await page.focus("#stage");
    await page.keyboard.press("Meta+KeyF");
    await page.keyboard.type("proofread");
    await page.waitForTimeout(150);
    ok(await page.evaluate(() => /Proofread with AI/.test((document.querySelector(".search") || {}).textContent || "")), "Proofread with AI… in the search");
    await page.keyboard.press("Escape");

    section("a 2000 × 3000 page with 40 texts doesn't freeze the page");
    await makePage(page, "page-040.psd", Array.from({ length: 40 }, (_, at) => [100 + (at % 5) * 380, 100 + Math.floor(at / 5) * 360, `Line number ${at} of the  page, some words here...`, 320, 220, true]));
    await settle(page);
    const timing = await page.evaluate(async () => {
      const long = [];
      const observer = new PerformanceObserver((list) => list.getEntries().forEach((one) => long.push(one.duration)));
      observer.observe({ entryTypes: ["longtask"] });
      let frames = 0;
      let last = performance.now();
      let worst = 0;
      let counting = true;
      const tick = () => {
        const t = performance.now();
        worst = Math.max(worst, t - last);
        last = t;
        frames++;
        if (counting) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      const start = performance.now();
      await window.TypeRVerification.check();
      const took = performance.now() - start;
      counting = false;
      await new Promise((resolve) => setTimeout(resolve, 50));
      observer.disconnect();
      return { took, frames, worst, longest: long.length ? Math.max(...long) : 0, count: window.TypeRVerification.issuesOf().shown.length };
    });
    console.log(`  check of 40 texts: ${Math.round(timing.took)} ms, ${timing.count} issues, longest task ${Math.round(timing.longest)} ms, longest frame gap ${Math.round(timing.worst)} ms`);
    ok(timing.longest < 250 && timing.worst < 300, "no long freeze while it checks");
    await shot(page, "dark-many", "#pane-verify");
    const fixAll = await page.$("#verify .verify__group:has(.verify__gname:text-is('Text')) .verify__fixall");
    ok(Boolean(fixAll), "Fix all for the texts' mistakes");
    if (fixAll) {
      await fixAll.click();
      await settle(page);
      ok(!(await state(page)).rules.includes("double-space"), "Fix all takes every double space away");
    }

    section("Cancel in the AI settings keeps the key that was there");
    await page.click("#pane-verify .verify__aikey");
    await page.waitForSelector("#modal .aiset");
    await page.selectOption("#modal .aiset select", "anthropic");
    await page.fill("#modal .gensettings__key input", "sk-typed-then-cancelled");
    await page.dispatchEvent("#modal .gensettings__key input", "change");
    await page.waitForFunction(() => document.querySelector("#modal .aiset__state.is-live, #modal .aiset__state.is-offline"));
    await modalCancel(page);
    ok(await page.evaluate(() => window.TypeRProofread.load().keys.anthropic === "sk-ant-test"), "the key typed then cancelled isn't kept");

    section("the review: the keys, the buttons, two pages");
    await page.evaluate(() => window.TypeRVerification.closeReview());
    const r1 = await makePage(page, "page-090.psd", [
      [300, 400, "I didn't see teh car coming at all, it was so fast!", 600, 300, true],
      [1100, 500, "We're going to the the market tomorrow morning.", 600, 300, true],
      [700, 1600, "Their going home now, before night falls on us all.", 600, 300, true],
    ]);
    const r2 = await makePage(page, "page-091.psd", [[700, 800, "This sentense is on the next page.", 600, 300, true]]);
    const findingsSet = await page.evaluate(({ r1, r2 }) => {
      const { app } = window.TypeRPhotoshop;
      const V = window.TypeRVerification;
      const p1 = app.docs.find((doc) => doc.name === "page-090.psd");
      const p2 = app.docs.find((doc) => doc.name === "page-091.psd");
      V.addFindings(p1, [
        { layerId: r1.ids[2], kind: "meaning", excerpt: "Their", suggestion: "They're", replacement: null, explanation: "“Their” should probably be “They're”." },
        { layerId: r1.ids[1], kind: "grammar", excerpt: "the the", suggestion: "the", replacement: "We're going to the market tomorrow morning.", explanation: "A word written twice." },
        { layerId: r1.ids[0], kind: "spelling", excerpt: "teh", suggestion: "the", replacement: "I didn't see the car coming at all, it was so fast!", explanation: "A typo." },
      ]);
      V.addFindings(p2, [{ layerId: r2.ids[0], kind: "spelling", excerpt: "sentense", suggestion: "sentence", replacement: "This sentence is on the next page.", explanation: "A typo." }]);
      window.TypeRPhotoshop.setActiveDoc(p1);
      return V.suggestions();
    }, { r1, r2 });
    ok(findingsSet >= 4, `four suggestions on two pages (${findingsSet})`);
    ok(await page.evaluate(() => { const item = window.TypeRApp.MENUS.find(([name]) => name === "Edit")[1].find((one) => one && one.label === "Review Proofreading"); return Boolean(item) && item.keys === "Alt+Cmd+P" && item.enabled(); }), "Edit > Review Proofreading (Alt+Cmd+P), on");
    await page.focus("#stage");
    await page.keyboard.press("Alt+Meta+KeyP");
    await page.waitForTimeout(150);
    seen = await reviewOf(page);
    ok(seen.on && seen.doc === "page-090.psd" && seen.excerpt === "teh", `Alt+Cmd+P starts on this page's first text in reading order (${seen.excerpt})`);
    ok(/1 of 4/.test(seen.text), `counted from this page: "${(/\d+ of \d+/.exec(seen.text) || [""])[0]}"`);
    await shot(page, "dark-review-card");
    await page.keyboard.press("ArrowRight");
    seen = await reviewOf(page);
    ok(seen.excerpt === "the the" && /2 of 4/.test(seen.text), `→ goes on (${seen.excerpt})`);
    await page.keyboard.press("ArrowLeft");
    ok((await reviewOf(page)).excerpt === "teh", "← goes back");
    await cardButton(page, "Next");
    ok((await reviewOf(page)).excerpt === "the the", "Next, the button");
    await cardButton(page, "Previous");
    ok((await reviewOf(page)).excerpt === "teh", "Previous, the button");

    section("the review: Accept, the shape, undo");
    const stepsBefore = await historyOf(page);
    const linesAtFirst = await linesOfText(page, r1.ids[0]);
    await page.keyboard.press("Enter");
    seen = await reviewOf(page);
    ok((await layerText(page, r1.ids[0])) === "I didn't see the car coming at all, it was so fast!", "Enter accepts: the text is corrected");
    ok(seen.step === "shape" && /Corrected/.test(seen.text) && seen.count === findingsSet - 1, `then its shape, the suggestion gone from the list (${seen.count} left)`);
    ok(seen.come.join() === "the" && seen.words.length >= 1 && seen.words.every((one) => one.done), "the corrected word shown, on the card and on the page");
    ok(seen.buttons.some((one) => /As before/.test(one)) && seen.buttons.some((one) => /Undo/.test(one)), `the shape's buttons: ${seen.buttons.filter(Boolean).join(" | ")}`);
    await shot(page, "dark-review-shape");
    await page.keyboard.press("Equal");
    const more = await linesOfText(page, r1.ids[0]);
    ok(more === linesAtFirst + 1, `+ gives a line more (${linesAtFirst} → ${more})`);
    await page.keyboard.press("Minus");
    await page.keyboard.press("Minus");
    const fewer = await linesOfText(page, r1.ids[0]);
    ok(fewer === linesAtFirst - 1, `− a line less (${fewer})`);
    await page.mouse.move(5, 5);
    await page.hover(".proof-card button[title^='One line more']");
    ok(await page.evaluate(() => Boolean(window.TypeRPhotoshop.app.doc.preview)), "a shape's button shows it on the page under the pointer");
    await page.mouse.move(5, 5);
    ok(await page.evaluate(() => !window.TypeRPhotoshop.app.doc.preview), "and takes it back when the pointer leaves");
    await page.keyboard.press("KeyR");
    ok((await linesOfText(page, r1.ids[0])) === linesAtFirst, "R: the lines as before");
    const stepsAfter = await historyOf(page);
    ok(stepsAfter.index === stepsBefore.index + 1, `the correction and its shape are one undo step (${stepsAfter.names.slice(stepsBefore.index + 1).join(", ")})`);
    await page.keyboard.press("Meta+KeyZ");
    await page.waitForTimeout(100);
    seen = await reviewOf(page);
    ok((await layerText(page, r1.ids[0])).includes("teh"), "Cmd+Z: the text as it was");
    ok(seen.step === "finding" && seen.excerpt === "teh" && seen.count === findingsSet, "and the suggestion back, on the card and in the list");
    await cardButton(page, "Accept");
    ok((await reviewOf(page)).step === "shape", "Accept, the button");
    await cardButton(page, "Undo");
    ok((await reviewOf(page)).step === "finding" && (await layerText(page, r1.ids[0])).includes("teh"), "Undo, the button");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    seen = await reviewOf(page);
    ok(seen.step === "finding" && seen.excerpt === "the the", "Enter after the shape goes on to the next one");

    section("the review: Discard, a meaning problem, typing");
    await page.keyboard.press("Backspace");
    seen = await reviewOf(page);
    ok((await layerText(page, r1.ids[1])).includes("the the") && seen.excerpt === "Their" && seen.count === findingsSet - 2, "Backspace discards: the text untouched, the next one shown");
    ok(!seen.buttons.some((one) => /^Accept/.test(one)) && seen.buttons.some((one) => /Edit text/.test(one)), "a meaning problem: no Accept, Edit text instead");
    ok(seen.words.length === 1, "its word marked");
    await page.keyboard.press("Meta+Enter");
    await page.waitForTimeout(100);
    seen = await reviewOf(page);
    const typing = await page.evaluate(() => { const el = document.activeElement; return { editing: window.TypeRApp.isEditing(), selected: el && el.value ? el.value.slice(el.selectionStart, el.selectionEnd) : "" }; });
    ok(typing.editing && typing.selected === "Their", `Cmd+Enter edits the text, its words selected ("${typing.selected}")`);
    ok(seen.on && seen.shown && /done/.test(seen.text), "the card stays, saying how to finish");
    await page.keyboard.type("They're");
    for (const key of ["ArrowRight", "ArrowLeft", "Backspace", "Minus", "KeyR", "Enter"]) await page.keyboard.press(key);
    seen = await reviewOf(page);
    const typed = await page.evaluate(() => document.activeElement && document.activeElement.value);
    ok(seen.step === "finding" && seen.excerpt === "Their" && /^They'r/.test(typed), `no key taken while the text is typed ("${typed.slice(0, 12)}…")`);
    await page.evaluate(() => { const el = document.activeElement; el.value = "They're going home now, before night falls on us all."; el.dispatchEvent(new Event("input", { bubbles: true })); });
    await page.keyboard.press("Meta+Enter");
    await page.waitForTimeout(100);
    seen = await reviewOf(page);
    ok(!(await page.evaluate(() => window.TypeRApp.isEditing())) && seen.step === "shape", "done typing: its shape, as after Accept");
    await page.keyboard.press("Enter");
    seen = await reviewOf(page);
    ok(seen.doc === "page-091.psd" && seen.doc_ === "page-091.psd" && seen.excerpt === "sentense", "the last one of a page: Next brings the next page with suggestions");

    section("the review: the pages switched, a field");
    await page.evaluate(() => window.TypeRPhotoshop.setActiveDoc(window.TypeRPhotoshop.app.docs.find((doc) => doc.name === "page-090.psd")));
    await page.waitForTimeout(100);
    seen = await reviewOf(page);
    ok(seen.on && !seen.shown && !seen.ring && !seen.words.length, "another page in front: the card and the marks hide");
    await page.focus("#stage");
    await page.keyboard.press("Enter");
    ok((await layerText(page, r2.ids[0])).includes("sentense"), "and its keys do nothing there");
    await page.evaluate(() => window.TypeRPhotoshop.setActiveDoc(window.TypeRPhotoshop.app.docs.find((doc) => doc.name === "page-091.psd")));
    await page.waitForTimeout(100);
    seen = await reviewOf(page);
    ok(seen.shown && seen.ring, "back in front: they show again");
    await page.evaluate(() => { window.TypeRPhotoshop.app.doc.view.zoom *= 1.5; window.TypeRApp.viewChanged(); });
    const moved = await reviewOf(page);
    ok(moved.ring.right - moved.ring.left > seen.ring.right - seen.ring.left && !overlaps(moved.card, moved.ring), "zoomed: the ring follows, the card stays beside");
    await page.evaluate(() => { const input = document.createElement("input"); input.id = "review-field"; document.body.appendChild(input); input.focus(); });
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Enter");
    ok((await reviewOf(page)).excerpt === "sentense" && (await layerText(page, r2.ids[0])).includes("sentense"), "a field typed in keeps its keys");
    await page.evaluate(() => document.getElementById("review-field").remove());
    await page.focus("#stage");
    await page.keyboard.press("Enter");
    ok((await layerText(page, r2.ids[0])) === "This sentence is on the next page.", "on the page again, Enter accepts");
    seen = await reviewOf(page);
    ok(seen.buttons.some((one) => /Done/.test(one)), "the last one: Done");
    await cardButton(page, "Done");
    seen = await reviewOf(page);
    ok(!seen.on && !seen.shown && seen.count === 0, "Done ends the review");
    ok(await page.evaluate(() => { const item = window.TypeRApp.MENUS.find(([name]) => name === "Edit")[1].find((one) => one && one.label === "Review Proofreading"); return !item.enabled(); }), "nothing left: Edit > Review Proofreading is off");

    section("the review: two suggestions on one text");
    const both = await makePage(page, "page-092.psd", [[700, 800, "I can't beleive you did that\ron you're own!", 600, 300, true]]);
    await page.evaluate((id) => {
      const { app } = window.TypeRPhotoshop;
      const text = "I can't beleive you did that\non you're own!";
      window.TypeRVerification.addFindings(app.doc, [
        { layerId: id, kind: "spelling", excerpt: "beleive", suggestion: "believe", replacement: text.replace("beleive", "believe"), explanation: "A typo." },
        { layerId: id, kind: "grammar", excerpt: "you're own", suggestion: "your own", replacement: text.replace("you're own", "your own"), explanation: "“Your”, not “you are”." },
      ]);
      window.TypeRVerification.review();
    }, both.ids[0]);
    await page.focus("#stage");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Equal");
    seen = await reviewOf(page);
    ok(seen.count === 1, "accepting one keeps the other suggestion of the same text, its lines changed too");
    await page.keyboard.press("Enter");
    seen = await reviewOf(page);
    ok(seen.excerpt.replace(/\s+/g, " ") === "you're own" && seen.gone.join() === "you're" && seen.come.join() === "your", `the other one, on the text as it now is (${JSON.stringify(seen.excerpt)}: ${seen.gone} → ${seen.come})`);
    await page.keyboard.press("Enter");
    const twice = (await layerText(page, both.ids[0])).replace(/\s+/g, " ");
    ok(twice === "I can't believe you did that on your own!", `both corrections in the text: "${twice}"`);
    await page.keyboard.press("Escape");

    section("closed, nothing runs");
    await page.evaluate(() => window.TypeRWorkspace.setVisible("verify", false));
    await page.evaluate(() => { const { app, ops } = window.TypeRPhotoshop; const text = app.doc.state.layers.find((one) => one.kind === "text"); ops.setText(text.id, "Changed  again"); });
    await page.waitForTimeout(800);
    ok(!(await page.evaluate(() => window.TypeRVerification.running)), "an edit with the panel closed starts no check");
    await page.evaluate(() => window.TypeRWorkspace.setVisible("verify", true));
    await settle(page);

    section("the light theme");
    const light = await page.evaluate(async () => {
      const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name);
      return css("--ui");
    });
    await clickMenu(page, "Edit", "Settings…");
    await page.waitForSelector("#modal.modal--settings");
    const appearance = await page.$("#modal .settings__nav button:has-text('Appearance')");
    if (appearance) await appearance.click();
    const tile = await page.$("#modal .themes button:has-text('Light+'), #modal .themes [data-theme='editor-light'], #modal .themes label:has-text('Light+')");
    if (tile) await tile.click();
    await modalOk(page);
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light", null, { timeout: 15000 }).catch(() => {});
    ok(await page.evaluate(() => document.documentElement.dataset.theme === "light"), `the light theme is on (was ${light.trim()})`);
    await page.click("#verify .verify__scope button[data-scope='all']");
    await settle(page);
    await shot(page, "light-page");
    await shot(page, "light-panel", "#pane-verify");
    await page.click("#verify .verify__settings");
    await page.waitForSelector("#modal .vset");
    await shot(page, "light-settings", "#modal");
    await modalCancel(page);
    await page.click("#pane-verify .verify__aikey");
    await page.waitForSelector("#modal .aiset__state.is-live, #modal .aiset__state.is-offline");
    await shot(page, "light-ai-settings", "#modal");
    await modalCancel(page);
    // The review's card and marks in the light theme
    const lightPage = await makePage(page, "page-095.psd", [[700, 600, "Nobody beleives me when I say it.", 600, 300, true]]);
    await page.evaluate((id) => {
      const { app } = window.TypeRPhotoshop;
      window.TypeRVerification.addFindings(app.doc, [{ layerId: id, kind: "spelling", excerpt: "beleives", suggestion: "believes", replacement: "Nobody believes me when I say it.", explanation: "“Believe” is spelt with “ie”." }]);
      window.TypeRVerification.review();
    }, lightPage.ids[0]);
    await page.waitForTimeout(150);
    ok((await reviewOf(page)).shown, "the light theme: the card shows");
    await shot(page, "light-review-card");
    await page.focus("#stage");
    await page.keyboard.press("Enter");
    await shot(page, "light-review-shape");
    await page.keyboard.press("Escape");

    console.log(errors.length ? `  console errors:\n    ${errors.join("\n    ")}` : "  no console error");
    ok(!errors.length, "no console error");
    await context.close();

    section("long words: French-length strings, a narrow dock");
    {
      const LONG = {
        "Check this page": "Vérifier cette page", "Check all pages": "Vérifier toutes les pages", "This page": "Cette page", "All open pages": "Toutes les pages ouvertes", "All open pages ({count})": "Toutes les pages ouvertes ({count})",
        "{count} things to look at": "{count} points à vérifier", "Proofread with AI": "Relecture par IA", "Ignore": "Ignorer", "Fix all ({count})": "Tout corriger ({count})",
        "Text outside the page": "Texte en dehors de la page", "The text is cut by the edge of the page, or lies entirely outside it.": "Le texte est coupé par le bord de la page, ou se trouve entièrement en dehors.",
      };
      const fr = await browser.newContext({ viewport: { width: 1280, height: 860 } });
      await fr.route("**/web/strings/verify/fr.js", (route) => route.fulfill({ status: 200, contentType: "text/javascript", body: `window.TYPER_WEB_STRINGS = window.TYPER_WEB_STRINGS || {}; window.TYPER_WEB_STRINGS.fr = Object.assign(window.TYPER_WEB_STRINGS.fr || {}, ${JSON.stringify(LONG)});` }));
      const p2 = await fr.newPage();
      const frErrors = [];
      p2.on("pageerror", (error) => frErrors.push(String(error)));
      await p2.goto(`http://127.0.0.1:${server.address().port}/web/?lang=fr`);
      for (let tries = 0; tries < 300 && !(await p2.evaluate(() => Boolean(window.TypeRApp && window.TypeRApp.booted))); tries++) {
        const skip = await p2.$("dialog.onboard[open] .onboard__skip");
        if (skip) await skip.click().catch(() => {});
        else await p2.evaluate(() => document.querySelectorAll("dialog[open]").forEach((one) => { const yes = one.querySelector(".modal__foot .btn--main"); if (yes) yes.click(); else one.close(); }));
        await p2.waitForTimeout(100);
      }
      await p2.evaluate(() => { window.TypeRWorkspace.setVisible("character", false); window.TypeRWorkspace.setVisible("breaks", false); });
      await makePage(p2, "chapitre-03-page-012.psd", [[700, 500, "Bonjour  à tous, c'est un texte bien plus long que les autres pour voir comment la ligne se coupe", 600, 300, true], [1900, 2900, "Hors de la page."], [600, 1600, "Une ligne.."]]);
      await makePage(p2, "chapitre-03-page-013.psd", [[600, 600, "Deuxième  page.", 600, 300, true]]);
      await p2.evaluate(() => window.TypeRVerification.open());
      await p2.click("#verify .verify__scope button[data-scope='all']");
      await settle(p2);
      await shot(p2, "dark-french", "#pane-verify");
      const overflow = await p2.evaluate(() => {
        const pane = document.getElementById("pane-verify");
        return Array.from(pane.querySelectorAll(".verify__bar, .verify__summary, .verify__row, .verify__group, .verify__pagehead, .verify__foot")).some((el) => el.scrollWidth > el.clientWidth + 1);
      });
      ok(!overflow, "nothing runs past the panel's width in French");
      ok(!frErrors.length, `no page error in French ${frErrors.join(" ")}`);
      await fr.close();
    }

    section("the touch interface");
    {
      const touch = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: false });
      const p3 = await touch.newPage();
      const touchErrors = [];
      p3.on("pageerror", (error) => touchErrors.push(String(error)));
      await p3.goto(`http://127.0.0.1:${server.address().port}/web/?lang=en&ui=tablet`);
      for (let tries = 0; tries < 300 && !(await p3.evaluate(() => Boolean(window.TypeRApp && window.TypeRApp.booted))); tries++) {
        const skip = await p3.$("dialog.onboard[open] .onboard__skip");
        if (skip) await skip.click().catch(() => {});
        else await p3.evaluate(() => document.querySelectorAll("dialog[open]").forEach((one) => { const yes = one.querySelector(".modal__foot .btn--main"); if (yes) yes.click(); else one.close(); }));
        await p3.waitForTimeout(100);
      }
      await makePage(p3, "page-001.psd", [[700, 500, "Hello  there.", 600, 300, true]]);
      await p3.waitForTimeout(300);
      ok(await p3.evaluate(() => !window.TypeRVerification.isOpen()), "touch: closed until asked");
      await p3.evaluate(() => window.TypeRVerification.open());
      await settle(p3);
      ok(await p3.evaluate(() => window.TypeRVerification.isOpen() && document.querySelectorAll("#verify .verify__row").length > 0), "touch: the sheet opens and lists the page");
      await shot(p3, "touch-sheet");
      // The review: the sheet goes down for the page to show, the card's buttons take a tap
      const typo = await p3.evaluate(() => {
        const { app, ops } = window.TypeRPhotoshop;
        const id = ops.newText(500, 1400, "Tap teh button.", { width: 600, height: 300 }).id;
        window.TypeRVerification.addFindings(app.doc, [{ layerId: id, kind: "spelling", excerpt: "teh", suggestion: "the", replacement: "Tap the button.", explanation: "A typo." }]);
        return id;
      });
      await p3.evaluate(() => window.TypeRVerification.review());
      await p3.waitForTimeout(300);
      const touchSeen = await reviewOf(p3);
      ok(touchSeen.shown && !(await p3.evaluate(() => window.TypeRVerification.isOpen())), "touch: the review shows its card, the sheet down");
      await shot(p3, "touch-review");
      await p3.tap(".proof-card button:has(span:text-is('Accept'))");
      await p3.waitForTimeout(150);
      ok((await layerText(p3, typo)) === "Tap the button." && (await reviewOf(p3)).step === "shape", "touch: Accept takes a tap");
      await p3.tap(".proof-card button:has(span:text-is('Done'))");
      await p3.waitForTimeout(150);
      ok(!(await reviewOf(p3)).on, "touch: Done ends it");
      ok(!touchErrors.length, `touch: no page error ${touchErrors.join(" ")}`);
      await touch.close();
    }
  } catch (error) {
    // Where it stopped, to look at
    await Promise.all(browser.contexts().flatMap((one) => one.pages()).map((one, at) => one.screenshot({ path: path.join(SHOTS, `failed-${at}.png`) }).catch(() => {})));
    throw error;
  } finally {
    await browser.close();
    server.close();
  }

  section("the app boots without either module");
  for (const missing of ["/web/verify-rules.js", "/web/proofread.js"]) {
    const alone = await serve(missing);
    const b = await chromium.launch({ executablePath: CHROME, headless: true });
    try {
      const { page, errors } = await boot(b, alone);
      const left = errors.filter((text) => !/status of 404/.test(text));
      ok(!left.length, `without ${missing}: no console error ${left.join(" | ")}`);
      const shown = await page.evaluate(() => ({ menu: window.TypeRApp.MENUS.find(([name]) => name === "Window")[1].some((item) => item && item.label === "Verification"), panel: Boolean(window.TypeRVerification), foot: !document.getElementById("verify-foot").hidden }));
      if (missing.includes("verify-rules")) ok(!shown.menu && !shown.panel, "without the rules: no Verification menu, no panel");
      else {
        ok(shown.menu && shown.panel && !shown.foot, "without proofreading: the panel, no AI button");
        await page.evaluate(() => window.TypeRPhotoshop.ops.newDocument({ name: "x.psd", width: 400, height: 400, resolution: 72, background: "#fff" }));
        await page.evaluate(() => window.TypeRVerification.check());
        ok(await page.evaluate(() => /Nothing to report/.test(document.querySelector("#verify .verify__summary").textContent)), "an empty page: Nothing to report");
        await shot(page, "dark-clean", "#pane-verify");
      }
    } finally {
      await b.close();
      alone.close();
    }
  }

  console.log(`${passes} passed, ${failures} failed`);
  console.log(`screenshots: ${SHOTS}`);
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
