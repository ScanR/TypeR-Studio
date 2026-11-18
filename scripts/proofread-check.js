#!/usr/bin/env node
// Checks web/proofread.js without a key and without the network: the file runs in a small fake
// window whose fetch answers as OpenAI's and Anthropic's APIs document. Exits non-zero on failure.
//
//   node scripts/proofread-check.js
//
// Shapes faked here, and where they come from:
// - Anthropic Messages (request, content blocks, stop_reason, usage) and anthropic-version
//   2026-10-21: the claude-api skill, curl/examples.md; output_config.format json_schema:
//   https://platform.claude.com/docs/en/build-with-claude/structured-outputs
// - Anthropic Models list (data, has_more, last_id, after_id, capabilities.structured_outputs,
//   lifecycle, display_name, max_tokens): https://platform.claude.com/docs/en/api/models/list
// - Anthropic errors ({ type: "error", error: { type, message } }, 401/402/404/429/529, credit
//   balance as a 400): the claude-api skill, shared/error-codes.md
// - OpenAI Models list ({ object: "list", data: [{ id, created, owned_by }] }):
//   https://developers.openai.com/api/reference/resources/models/methods/list
// - OpenAI Responses (instructions, input, max_output_tokens, store, text.format json_schema;
//   output[] message/output_text/refusal, status, incomplete_details.reason, usage):
//   https://developers.openai.com/api/reference/resources/responses/methods/create
// - OpenAI Chat Completions (response_format json_schema, max_completion_tokens, choices[].message
//   .refusal, finish_reason, usage): https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
// - OpenAI errors ({ error: { message, type, param, code } }, insufficient_quota, unsupported_parameter):
//   https://developers.openai.com/api/docs/guides/error-codes and the 400 body reported in
//   https://github.com/home-assistant/core/issues/137039
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "web", "proofread.js"), "utf8");

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

// A fresh page: its own storage, its own fetch
const page = ({ refuseStorage = false } = {}) => {
  const store = new Map();
  const localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => {
      if (refuseStorage) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      store.set(key, String(value));
    },
    removeItem: (key) => store.delete(key),
  };
  const calls = [];
  let handler = () => { throw new TypeError("Failed to fetch"); };
  const fetch = async (url, init = {}) => {
    const signal = init.signal;
    if (signal && signal.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    const call = { url: String(url), method: init.method || "GET", headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const answer = await handler(call, signal);
    if (signal && signal.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    return answer;
  };
  const context = { console: { log: console.log, info() {}, warn() {}, error: console.error }, fetch, setTimeout, clearTimeout, DOMException, Intl, JSON, Math, Date, Promise, Map, Set, Error, TypeError, RegExp, Number, String, Object, Array };
  context.window = context;
  context.window.localStorage = localStorage;
  vm.createContext(context);
  vm.runInContext(SOURCE, context, { filename: "web/proofread.js" });
  return { P: context.TypeRProofread, store, calls, set handler(fn) { handler = fn; } };
};

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: Object.assign({ "content-type": "application/json" }, headers) });
const anthropicError = (status, type, message, headers) => json(status, { type: "error", error: { type, message }, request_id: "req_test" }, headers);
const openaiError = (status, type, code, message, param = null, headers) => json(status, { error: { message, type, param, code } }, headers);

// Anthropic: a Messages answer whose text is `text`
const claudeMessage = (text, { stop = "end_turn", input = 100, output = 50, model = "claude-opus-5-5" } = {}) => json(200, {
  id: "msg_test", type: "message", role: "assistant", model,
  content: stop === "refusal" ? [] : [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text }],
  stop_reason: stop, stop_sequence: null, stop_details: stop === "refusal" ? { type: "refusal", category: null, explanation: null } : null,
  usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
});
// OpenAI: a Responses answer
const gptResponse = (text, { status = "completed", reason = null, refusal = null, input = 120, output = 60, model = "gpt-6-astra" } = {}) => json(200, {
  id: "resp_test", object: "response", status, model,
  incomplete_details: reason ? { reason } : null, error: null,
  output: [
    { id: "rs_1", type: "reasoning", summary: [] },
    { id: "msg_1", type: "message", role: "assistant", status: "completed", content: refusal ? [{ type: "refusal", refusal }] : text == null ? [] : [{ type: "output_text", text, annotations: [] }] },
  ],
  usage: { input_tokens: input, input_tokens_details: { cached_tokens: 0 }, output_tokens: output, output_tokens_details: { reasoning_tokens: 10 }, total_tokens: input + output },
});
const gptChat = (content, { finish = "stop", refusal = null } = {}) => json(200, {
  id: "chatcmpl_test", object: "chat.completion", model: "gpt-3.5-turbo",
  choices: [{ index: 0, message: { role: "assistant", content, refusal }, finish_reason: finish }],
  usage: { prompt_tokens: 80, completion_tokens: 30, total_tokens: 110 },
});

// What the model was sent: the texts by ref
const sentTexts = (call) => {
  const user = call.body.messages ? call.body.messages[call.body.messages.length - 1].content : call.body.input;
  const data = JSON.parse(user);
  const refs = {};
  data.pages.forEach((one) => one.texts.forEach((t) => { refs[t.text.split("\n")[0].slice(0, 12)] = t.ref; refs[t.ref] = t.text; }));
  return { data, refs };
};
const refOf = (call, start) => {
  const { data } = sentTexts(call);
  for (const one of data.pages) for (const t of one.texts) if (t.text.startsWith(start)) return t.ref;
  return null;
};

const withKey = (P, service, extra = {}) => {
  const config = P.load();
  config.service = service;
  config.keys[service] = `${service}-test-key`;
  Object.assign(config, extra);
  P.save(config);
};

const PAGES = [
  { name: "001.png", texts: [
    { id: "a1", text: "WHAT ARE YOU\nDOING HERE?!" },
    { id: "a2", text: "Je suis allé\nau marché hier, et j'ai\nacheté des pomes." },
    { id: "a3", text: "N-nooooon…" },
  ] },
  { name: "002.png", texts: [{ id: "b1", text: "Tu crois que\nKenji-san\nviendra ?" }] },
  { name: "003.png", texts: [] },
  { name: "004.png", texts: [{ id: "d1", text: "Kenji-sama est en retard." }] },
];

const main = async () => {
  /* ------------------------------------------------------------------ */
  section("settings: defaults, save, load, refused storage");
  {
    const { P, store } = page();
    const config = P.load();
    ok(config.service === "anthropic" && config.keys.openai === "" && config.keys.anthropic === "", "defaults: service and empty keys");
    ok(P.KINDS.join() === "spelling,grammar,punctuation,meaning,consistency" && P.KINDS.every((k) => config.kinds[k] === true), "defaults: every kind on");
    ok(typeof config.model.openai === "string" && typeof config.model.anthropic === "string" && config.notes === "", "defaults: a model per service, no notes");
    ok(P.SERVICES.openai.name === "OpenAI" && /^https:/.test(P.SERVICES.anthropic.keyUrl), "SERVICES names and key pages");
    ok(P.ready() === false, "not ready without a key");
    config.keys.openai = "  sk-x  ";
    config.service = "openai";
    config.model.openai = "my-custom/model-1";
    config.kinds.meaning = false;
    config.notes = "Kenji-san, never Kenji-sama";
    ok(P.save(config) === true, "save returns true");
    ok(store.has("typer.web.proofread"), "kept under typer.web.proofread");
    const back = P.load();
    ok(back.keys.openai === "sk-x" && back.model.openai === "my-custom/model-1" && back.kinds.meaning === false && back.notes === "Kenji-san, never Kenji-sama", "load gives back what was saved, key trimmed, typed model kept");
    ok(P.ready() === true, "ready with a key for the chosen service");
    back.service = "anthropic";
    P.save(back);
    ok(P.ready() === false, "not ready when the chosen service has no key");
  }
  {
    const { P } = page({ refuseStorage: true });
    const config = P.load();
    config.keys.anthropic = "sk-ant";
    ok(P.save(config) === false, "save returns false when the device refuses");
    ok(P.load().keys.anthropic === "sk-ant" && P.ready() === true, "refused storage: settings still work until the page closes");
  }

  /* ------------------------------------------------------------------ */
  section("OpenAI models: listing, filtering, order, names, cache, force, offline, bad key");
  {
    const t = page();
    const { P } = t;
    withKey(P, "openai");
    const ids = [
      ["gpt-6-astra", 1790000000], ["gpt-6-luna", 1790000000], ["gpt-6.1-sol", 1795000000], ["gpt-6.1-terra", 1795000000],
      ["gpt-5", 1754000000], ["gpt-5-mini", 1754000000], ["gpt-5-nano", 1754000000], ["gpt-5-pro", 1759000000], ["gpt-5-2025-08-07", 1754000000],
      ["gpt-4o", 1715000000], ["gpt-4o-2024-08-06", 1722000000], ["gpt-4o-mini", 1721000000], ["o3", 1744000000], ["o4-mini", 1744000000],
      ["chatgpt-4o-latest", 1723000000], ["gpt-3.5-turbo", 1677000000], ["gpt-3.5-turbo-1106", 1698000000],
      ["text-embedding-3-large", 1705000000], ["whisper-1", 1677000000], ["tts-1-hd", 1699000000], ["dall-e-3", 1698000000],
      ["gpt-image-1", 1745000000], ["omni-moderation-latest", 1731000000], ["gpt-realtime", 1756000000], ["gpt-4o-audio-preview", 1727000000],
      ["gpt-4o-mini-transcribe", 1742000000], ["gpt-4o-search-preview", 1741000000], ["gpt-5-codex", 1757000000], ["gpt-3.5-turbo-instruct", 1692000000],
      ["babbage-002", 1692000000], ["sora-2", 1759000000], ["computer-use-preview", 1741000000], ["o4-mini-deep-research", 1750000000],
      ["ft:gpt-4o-mini-2024-07-18:acme::abc123", 1730000000],
    ];
    t.handler = (call) => json(200, { object: "list", data: ids.map(([id, created]) => ({ id, object: "model", created, owned_by: "openai" })) });
    const first = await P.models("openai");
    const got = first.list.map((m) => m.id);
    ok(first.live === true && first.at > 0, "live list with its date");
    ok(t.calls.length === 1 && t.calls[0].url === "https://api.openai.com/v1/models" && t.calls[0].headers.Authorization === "Bearer openai-test-key", "GET /v1/models with the Bearer key");
    const dropped = ["text-embedding-3-large", "whisper-1", "tts-1-hd", "dall-e-3", "gpt-image-1", "omni-moderation-latest", "gpt-realtime", "gpt-4o-audio-preview", "gpt-4o-mini-transcribe", "gpt-4o-search-preview", "gpt-5-codex", "gpt-3.5-turbo-instruct", "babbage-002", "sora-2", "computer-use-preview", "o4-mini-deep-research"];
    ok(dropped.every((id) => !got.includes(id)), "embeddings, audio, image, moderation, realtime, search, codex, instruct… dropped");
    ok(!got.includes("gpt-5-2025-08-07") && !got.includes("gpt-4o-2024-08-06") && !got.includes("gpt-3.5-turbo-1106"), "dated snapshots hidden behind their alias");
    ok(["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-astra", "gpt-6-luna", "gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-5-pro", "o3", "o4-mini", "gpt-4o", "gpt-4o-mini", "chatgpt-4o-latest", "gpt-3.5-turbo"].every((id) => got.includes(id)), "chat models kept");
    ok(got.indexOf("gpt-6.1-sol") < got.indexOf("gpt-6-astra") && got.indexOf("gpt-6-astra") < got.indexOf("gpt-5") && got.indexOf("gpt-5") < got.indexOf("gpt-4o") && got.indexOf("gpt-4o") < got.indexOf("gpt-3.5-turbo"), "newest first");
    ok(got.indexOf("gpt-5-pro") < got.indexOf("gpt-5") && got.indexOf("gpt-5") < got.indexOf("gpt-5-mini") && got.indexOf("gpt-5-mini") < got.indexOf("gpt-5-nano"), "in a family: pro, then the model, mini, nano");
    ok(got[got.length - 1].startsWith("ft:"), "fine-tuned models last");
    const name = (id) => first.list.find((m) => m.id === id).name;
    ok(name("gpt-6.1-sol") === "GPT-6.1 Sol" && name("gpt-5-mini") === "GPT-5 mini" && name("gpt-4o") === "GPT-4o" && name("o4-mini") === "o4-mini" && name("chatgpt-4o-latest") === "ChatGPT-4o latest" && name("gpt-3.5-turbo") === "GPT-3.5 Turbo", "readable names");
    console.log(`  order: ${got.slice(0, 8).join(", ")}, …`);

    await P.models("openai");
    ok(t.calls.length === 1, "kept: a second ask doesn't call");
    await P.models("openai", { force: true });
    ok(t.calls.length === 2, "force asks again");
    const kept = JSON.parse(t.store.get("typer.web.proofread.models"));
    kept.openai.at = Date.now() - 2 * 864e5;
    t.store.set("typer.web.proofread.models", JSON.stringify(kept));
    await P.models("openai");
    ok(t.calls.length === 3, "a list older than a day is asked again");
    ok(!t.store.get("typer.web.proofread.models").includes("openai-test-key"), "the key itself is not kept with the list");
    const config = P.load();
    config.keys.openai = "another-key";
    P.save(config);
    await P.models("openai");
    ok(t.calls.length === 4, "another key: asked again");

    t.handler = () => { throw new TypeError("Failed to fetch"); };
    const offlineKept = await P.models("openai", { force: true });
    ok(offlineKept.live === true && offlineKept.list.length === got.length && offlineKept.error && offlineKept.error.code === "network", "offline with a kept list: the kept list, with the error");
  }
  {
    const t = page();
    withKey(t.P, "openai");
    t.handler = () => { throw new TypeError("Failed to fetch"); };
    const offline = await t.P.models("openai");
    ok(offline.live === false && offline.list.length >= 2 && offline.list.every((m) => m.id && m.name) && offline.error.code === "network", "offline, nothing kept: built-in list, live false");
    t.handler = () => openaiError(401, "invalid_request_error", "invalid_api_key", "Incorrect API key provided: sk-xx***xx.");
    const bad = await t.P.models("openai", { force: true });
    ok(bad.live === false && bad.error.code === "key", "bad key: built-in list, error key");
    t.handler = () => json(200, { object: "list", data: [{ id: "text-embedding-3-small", object: "model", created: 1, owned_by: "openai" }] });
    const empty = await t.P.models("openai", { force: true });
    ok(empty.live === false && empty.list.length >= 2, "no text model for this key: built-in list");
    const none = page();
    const noKey = await none.P.models("anthropic");
    ok(none.calls.length === 0 && noKey.live === false && noKey.error.code === "key", "no key: nothing asked, built-in list");
  }

  /* ------------------------------------------------------------------ */
  section("Anthropic models: pages, headers, capabilities, deprecated last");
  {
    const t = page();
    withKey(t.P, "anthropic");
    const model = (id, display, { structured = true, lifecycle = "active", max = 128000 } = {}) => ({
      type: "model", id, display_name: display, created_at: "2026-09-21T00:00:00Z", lifecycle, line: null, max_input_tokens: 1000000, max_tokens: max, deprecated_at: null, retires_at: null,
      capabilities: { structured_outputs: { supported: structured }, image_input: { supported: true }, thinking: { supported: true, types: {} } },
    });
    t.handler = (call) => {
      if (!/after_id=/.test(call.url)) return json(200, { data: [model("claude-opus-5-5", "Claude Opus 5.5"), model("claude-sonnet-4-5", "Claude Sonnet 4.5", { lifecycle: "deprecated" })], has_more: true, first_id: "claude-opus-5-5", last_id: "claude-sonnet-4-5" });
      return json(200, { data: [model("claude-haiku-5-5", "Claude Haiku 5.5"), model("claude-old-1", "Claude Old 1", { structured: false, max: 8192 })], has_more: false, first_id: "claude-haiku-5-5", last_id: "claude-old-1" });
    };
    const answer = await t.P.models("anthropic");
    const h = t.calls[0].headers;
    ok(t.calls.length === 2 && /\/v1\/models\?limit=1000$/.test(t.calls[0].url) && /after_id=claude-sonnet-4-5/.test(t.calls[1].url), "two pages, following last_id");
    ok(h["x-api-key"] === "anthropic-test-key" && h["anthropic-version"] === "2026-10-21" && h["anthropic-dangerous-direct-browser-access"] === "true", "x-api-key, anthropic-version, browser access header");
    ok(answer.list.map((m) => m.id).join() === "claude-opus-5-5,claude-haiku-5-5,claude-old-1,claude-sonnet-4-5", "service order kept, deprecated last");
    ok(answer.list[0].name === "Claude Opus 5.5" && answer.list[2].structured === false && answer.list[3].deprecated === true, "display names, structured support and deprecation read");
  }
  {
    const t = page({ refuseStorage: true });
    withKey(t.P, "anthropic");
    t.handler = () => json(200, { data: [{ type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5", lifecycle: "active", capabilities: null }], has_more: false });
    await t.P.models("anthropic");
    await t.P.models("anthropic");
    ok(t.calls.length === 1, "refused storage: the list is still kept while the page is open");
  }

  /* ------------------------------------------------------------------ */
  section("Anthropic run: structured output, batching, progress, checks on findings");
  {
    const t = page();
    withKey(t.P, "anthropic", { notes: "Kenji-san: always -san." });
    const long = "x".repeat(1800);
    const pages = PAGES.concat([
      { name: "005.png", texts: [{ id: "e1", text: `Long page one ${long}` }] },
      { name: "006.png", texts: [{ id: "f1", text: `Long page two ${long}` }] },
    ]);
    t.handler = (call) => {
      const r = (start) => refOf(call, start);
      const findings = [];
      if (r("Je suis")) {
        findings.push(
          // good, line breaks lost in the replacement: rebuilt from the text
          { ref: r("Je suis"), kind: "spelling", excerpt: "pomes", suggestion: "pommes", replacement: "Je suis allé au marché hier, et j'ai acheté des pommes.", explanation: "Spelling." },
          // same again: dropped as a duplicate
          { ref: r("Je suis"), kind: "spelling", excerpt: "pomes", suggestion: "pommes", replacement: null, explanation: "Again." },
          // unknown ref
          { ref: "T99", kind: "spelling", excerpt: "x", suggestion: "y", replacement: null, explanation: "Unknown." },
          // excerpt not in the text
          { ref: r("WHAT ARE"), kind: "grammar", excerpt: "WHERE ARE YOU", suggestion: "WHAT ARE YOU", replacement: null, explanation: "Invented." },
          // replacement identical to the text
          { ref: r("N-noo"), kind: "spelling", excerpt: "N-nooooon", suggestion: "N-nooooon", replacement: "N-nooooon…", explanation: "No change." },
          // excerpt across a line break, written with a space: found as it is in the text
          { ref: r("Je suis"), kind: "grammar", excerpt: "j'ai acheté", suggestion: "j'ai acheté", replacement: "Je suis allé\nau marché hier, et j'ai\nacheté des pommes.", explanation: "Line-break excerpt." },
        );
      }
      if (r("Kenji-sama")) findings.push({ ref: r("Kenji-sama"), kind: "consistency", excerpt: "Kenji-sama", suggestion: "Kenji-san", replacement: "Kenji-san est en retard.", explanation: "Elsewhere Kenji-san." });
      return claudeMessage(JSON.stringify({ findings }), { input: 1000, output: 200 });
    };
    const progress = [];
    const result = await t.P.run({ pages, language: "fr", interface: "fr", onProgress: (p) => progress.push(`${p.done}/${p.total}`) });
    ok(t.calls.length === 2, `two batches for six pages (${t.calls.length})`);
    const body = t.calls[0].body;
    ok(t.calls[0].url === "https://api.anthropic.com/v1/messages" && t.calls[0].headers["anthropic-dangerous-direct-browser-access"] === "true" && t.calls[0].headers["anthropic-version"] === "2026-10-21", "POST /v1/messages with the browser and version headers");
    ok(body.output_config && body.output_config.format.type === "json_schema" && body.output_config.format.schema.properties.findings && !("output_format" in body), "output_config.format json_schema, not output_format");
    ok(!("temperature" in body) && !("top_p" in body) && !("top_k" in body) && !("thinking" in body) && !("fallbacks" in body), "no sampling, thinking or fallback settings");
    ok(body.messages.length === 1 && body.messages[0].role === "user" && body.max_tokens > 0, "one user message, no prefill");
    ok(/French/.test(body.system) && /Kenji-san: always -san\./.test(body.system) && /ALL CAPS/.test(body.system), "system prompt: text language, notes, comic rules");
    const sent = sentTexts(t.calls[0]).data;
    ok(sent.language === "fr" && sent.pages.map((p) => p.page).join() === "1,2,4,5" && sent.pages[0].texts[1].text.includes("\n"), "texts sent in reading order with their line breaks; empty pages not sent");
    ok(!JSON.stringify(t.calls[0].body).includes("image"), "no picture sent");
    ok(progress.join(" ") === "0/6 5/6 6/6", `progress ${progress.join(" ")}`);
    const f = result.findings;
    ok(f.length === 3, `three findings kept (${f.length})`);
    const pomme = f.find((x) => x.excerpt === "pomes");
    ok(pomme && pomme.page === 0 && pomme.id === "a2" && pomme.kind === "spelling" && pomme.suggestion === "pommes" && pomme.replacement === "Je suis allé\nau marché hier, et j'ai\nacheté des pommes.", "replacement rebuilt with the text's line breaks");
    const across = f.find((x) => x.explanation === "Line-break excerpt.");
    ok(across && across.excerpt === "j'ai\nacheté", "an excerpt is given back exactly as it is in the text");
    const kenji = f.find((x) => x.kind === "consistency");
    ok(kenji && kenji.page === 3 && kenji.id === "d1", "page is the index in pages, id the text's id");
    ok(f.indexOf(pomme) < f.indexOf(kenji), "findings in reading order");
    ok(result.usage.input === 2000 && result.usage.output === 400 && result.model === "claude-opus-5-5" && result.skipped.length === 0, "usage summed over batches, model named");
  }

  section("Anthropic run: a model without structured outputs, a model typed by hand");
  {
    const t = page();
    withKey(t.P, "anthropic");
    t.handler = () => json(200, { data: [{ type: "model", id: "claude-old-1", display_name: "Claude Old 1", lifecycle: "active", max_tokens: 8192, capabilities: { structured_outputs: { supported: false } } }], has_more: false });
    await t.P.models("anthropic");
    t.handler = (call) => claudeMessage("Here is what I found:\n```json\n" + JSON.stringify({ findings: [{ ref: refOf(call, "Je suis"), kind: "spelling", excerpt: "pomes", suggestion: "pommes", explanation: "Spelling." }] }).replace("}]}", "},]}") + "\n```");
    const result = await t.P.run({ pages: PAGES, language: "fr", model: "claude-old-1" });
    const body = t.calls[1].body;
    ok(!body.output_config && /Answer with one JSON object/.test(body.system), "no output_config, a JSON instruction instead");
    ok(body.max_tokens === 8192, "max_tokens within the model's own limit");
    ok(result.findings.length === 1 && result.findings[0].replacement === "Je suis allé\nau marché hier, et j'ai\nacheté des pommes.", "fenced JSON with a trailing comma read; missing replacement filled from the fix");
  }
  {
    const t = page();
    withKey(t.P, "anthropic");
    let n = 0;
    t.handler = (call) => {
      n += 1;
      if (call.body.output_config) return anthropicError(400, "invalid_request_error", "output_config.format: structured outputs are not supported for this model");
      return claudeMessage('{"findings":[]}');
    };
    const result = await t.P.run({ pages: PAGES, language: "fr", model: "my-typed-model-id" });
    ok(n === 2 && t.calls[0].body.model === "my-typed-model-id" && !t.calls[1].body.output_config && result.findings.length === 0, "typed model: tried with structured output, then again without");
    await t.P.run({ pages: PAGES, language: "fr", model: "my-typed-model-id" });
    ok(n === 3, "remembered for the session");
  }

  /* ------------------------------------------------------------------ */
  section("OpenAI run: Responses with structured output, old models, endpoint and parameter fallbacks");
  {
    const t = page();
    withKey(t.P, "openai");
    t.handler = (call) => gptResponse(JSON.stringify({ findings: [{ ref: refOf(call, "Je suis"), kind: "spelling", excerpt: "pomes", suggestion: "pommes", replacement: "Je suis allé\nau marché hier, et j'ai\nacheté des pommes.", explanation: "Faute d'orthographe." }] }));
    const result = await t.P.run({ pages: PAGES, language: "fr", interface: "fr" });
    const call = t.calls[0];
    ok(call.url === "https://api.openai.com/v1/responses" && call.headers.Authorization === "Bearer openai-test-key", "POST /v1/responses with the Bearer key");
    ok(call.body.text.format.type === "json_schema" && call.body.text.format.strict === true && call.body.text.format.name === "proofreading", "text.format json_schema, strict");
    const schemaOk = (node) => node.type !== "object" || (node.additionalProperties === false && Object.keys(node.properties).every((k) => node.required.includes(k)) && Object.values(node.properties).every((p) => schemaOk(p.items || p)));
    ok(schemaOk(call.body.text.format.schema), "schema: every property required, no additional properties (strict mode's rules)");
    ok(call.body.max_output_tokens > 0 && call.body.store === false && !("temperature" in call.body) && !("max_tokens" in call.body), "max_output_tokens, store false, no temperature");
    ok(typeof call.body.instructions === "string" && /in French/.test(call.body.instructions), "explanations asked in the interface language");
    ok(result.findings.length === 1 && result.usage.input === 120 && result.usage.output === 60 && result.model === "gpt-6-astra", "finding, usage and model");
  }
  {
    const t = page();
    withKey(t.P, "openai");
    t.handler = (call) => gptResponse("Sure! " + JSON.stringify({ findings: [{ ref: refOf(call, "Kenji-sama"), kind: "consistency", excerpt: "Kenji-sama", suggestion: "Kenji-san", replacement: null, explanation: "x" }] }) + " Hope it helps.");
    const result = await t.P.run({ pages: PAGES, language: "fr", model: "gpt-3.5-turbo" });
    ok(!t.calls[0].body.text && /Answer with one JSON object/.test(t.calls[0].body.instructions), "older model: no json_schema, JSON instruction");
    ok(result.findings.length === 1 && result.findings[0].replacement === null, "JSON found inside words; explicit null replacement kept null");
  }
  {
    const t = page();
    withKey(t.P, "openai");
    t.handler = (call) => {
      if (/responses/.test(call.url)) return openaiError(400, "invalid_request_error", null, "This model is only supported in v1/chat/completions.", "model");
      return gptChat(JSON.stringify({ findings: [] }));
    };
    const result = await t.P.run({ pages: PAGES, language: "fr", model: "legacy-chat-model" });
    const chat = t.calls[1];
    ok(chat.url === "https://api.openai.com/v1/chat/completions" && chat.body.response_format.type === "json_schema" && chat.body.response_format.json_schema.strict === true && chat.body.max_completion_tokens > 0 && !("max_tokens" in chat.body), "Chat Completions with response_format and max_completion_tokens");
    ok(chat.body.messages[0].role === "system" && chat.body.messages[1].role === "user" && result.usage.input === 80, "system then user; chat usage read");
  }
  {
    const t = page();
    withKey(t.P, "openai");
    t.handler = (call) => {
      if (call.body.max_output_tokens > 4096) return openaiError(400, "invalid_request_error", "integer_above_max_value", "Invalid 'max_output_tokens': integer above maximum value. Expected a value <= 4096, but got 16000 instead.", "max_output_tokens");
      if (call.body.store === false) return openaiError(400, "invalid_request_error", "unsupported_parameter", "Unsupported parameter: 'store' is not supported with this model.", "store");
      return gptResponse('{"findings":[]}');
    };
    await t.P.run({ pages: PAGES, language: "fr", model: "small-model" });
    ok(t.calls.length === 3 && t.calls[1].body.max_output_tokens === 4096 && !("store" in t.calls[2].body), "a too-large output allowance lowered, an unsupported parameter dropped, each retried once");
  }

  /* ------------------------------------------------------------------ */
  section("errors: each code, both services");
  const errorCase = async (service, label, respond, code, reason, { model } = {}) => {
    const t = page();
    withKey(t.P, service);
    t.handler = respond;
    try {
      await t.P.run({ pages: PAGES, language: "fr", model });
      ok(false, `${service} ${label}: should fail`);
      return null;
    } catch (error) {
      const right = error instanceof t.P.ProofreadError && error.code === code && (!reason || error.reason === reason);
      ok(right, `${service} ${label}: ${code}${reason ? `/${reason}` : ""} (got ${error && error.code}/${error && error.reason}: ${error && error.message})`);
      ok(typeof error.message === "string" && !/\{(?!service|model|detail)/.test(error.message) && error.text && !/\{service\}|\{model\}/.test(error.text) && error.values.service, `${service} ${label}: English key with values, filled text`);
      return { error, t };
    }
  };
  await errorCase("anthropic", "401", () => anthropicError(401, "authentication_error", "invalid x-api-key"), "key");
  await errorCase("openai", "401", () => openaiError(401, "invalid_request_error", "invalid_api_key", "Incorrect API key provided."), "key");
  await errorCase("anthropic", "credit balance", () => anthropicError(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."), "quota", "billing");
  await errorCase("anthropic", "402", () => anthropicError(402, "billing_error", "Billing problem."), "quota", "billing");
  await errorCase("openai", "insufficient_quota", () => openaiError(429, "insufficient_quota", "insufficient_quota", "You exceeded your current quota, please check your plan and billing details."), "quota", "billing");
  {
    const r = await errorCase("anthropic", "rate limit kept up", () => anthropicError(429, "rate_limit_error", "This request would exceed the rate limit for your organization.", { "retry-after": "0" }), "quota", "rate");
    ok(r && r.t.calls.length === 4, "rate limit: waited out three times as Retry-After says, then reported");
  }
  {
    const t = page();
    withKey(t.P, "openai");
    let n = 0;
    t.handler = () => (++n === 1 ? openaiError(429, "requests", "rate_limit_exceeded", "Rate limit reached for gpt-6-astra on requests per min (RPM).", null, { "retry-after": "0" }) : gptResponse('{"findings":[]}'));
    const result = await t.P.run({ pages: PAGES, language: "fr" });
    ok(n === 2 && result.findings.length === 0, "rate limit once: waited, then answered");
  }
  {
    const t = page();
    withKey(t.P, "anthropic");
    t.handler = () => anthropicError(429, "rate_limit_error", "This request would exceed the rate limit for your organization.");
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 200);
    const started = Date.now();
    try {
      await t.P.run({ pages: PAGES, language: "fr", signal: stop.signal });
      ok(false, "rate limit without Retry-After: should be stopped");
    } catch (error) {
      ok(error.code === "aborted" && t.calls.length === 1 && Date.now() - started < 1000, "rate limit without Retry-After: waits (not at once), and a stop ends the wait");
    }
  }
  await errorCase("anthropic", "unknown model", () => anthropicError(404, "not_found_error", "model: claude-nope"), "model", null, { model: "claude-nope" });
  {
    const r = await errorCase("openai", "unknown model", () => openaiError(404, "invalid_request_error", "model_not_found", "The model `gpt-nope` does not exist or you do not have access to it."), "model", null, { model: "gpt-nope" });
    ok(r && r.error.text === "OpenAI does not offer the model gpt-nope to this key. Choose another model.", `filled text: ${r && r.error.text}`);
  }
  await errorCase("anthropic", "refusal", () => claudeMessage("", { stop: "refusal" }), "refused");
  await errorCase("openai", "refusal", () => gptResponse(null, { refusal: "I can't help with that." }), "refused");
  await errorCase("openai", "content filter", () => gptResponse(null, { status: "incomplete", reason: "content_filter" }), "refused");
  await errorCase("anthropic", "offline", () => { throw new TypeError("Failed to fetch"); }, "network", "network");
  {
    const r = await errorCase("anthropic", "overloaded", () => anthropicError(529, "overloaded_error", "Overloaded", { "retry-after": "0" }), "network", "busy");
    ok(r && r.t.calls.length === 3, "overloaded: asked again twice");
  }
  await errorCase("openai", "500", () => openaiError(500, "server_error", null, "The server had an error.", null, { "retry-after": "0" }), "network", "busy");
  await errorCase("anthropic", "unreadable", () => claudeMessage("I could not do it, sorry."), "format", "format");
  await errorCase("openai", "unreadable", () => gptResponse("no json here"), "format", "format");
  await errorCase("anthropic", "cut off", () => claudeMessage('{"findings":[{"ref":"T1"', { stop: "max_tokens" }), "format", "truncated");
  await errorCase("openai", "cut off", () => gptResponse('{"findings":[', { status: "incomplete", reason: "max_output_tokens" }), "format", "truncated");
  await errorCase("openai", "other 400", () => openaiError(400, "invalid_request_error", "invalid_value", "Something else is wrong.", "input"), "format", "request");
  {
    const t = page();
    try {
      await t.P.run({ pages: PAGES, language: "fr" });
      ok(false, "no key: should fail");
    } catch (error) {
      ok(error.code === "key" && t.calls.length === 0, "no key: code key, nothing sent");
    }
  }

  /* ------------------------------------------------------------------ */
  section("long chapters: a cut-off batch split, a refused batch skipped, a stop mid-run");
  const chapter = Array.from({ length: 30 }, (_, i) => ({ name: `${i + 1}.png`, texts: [{ id: `t${i}`, text: `Page ${i + 1} : il est allé${"e".repeat(150)}` }] }));
  {
    const t = page();
    withKey(t.P, "anthropic");
    t.handler = (call) => {
      const pages = sentTexts(call).data.pages;
      if (pages.length > 3) return claudeMessage('{"findings":[', { stop: "max_tokens" });
      return claudeMessage(JSON.stringify({ findings: pages.map((p) => ({ ref: p.texts[0].ref, kind: "spelling", excerpt: "allé", suggestion: "allée", replacement: null, explanation: "x" })) }));
    };
    const progress = [];
    const result = await t.P.run({ pages: chapter, language: "fr", onProgress: (p) => progress.push(p.done) });
    ok(result.findings.length === 30 && result.skipped.length === 0, `cut-off batches asked again in halves: every page answered (${result.findings.length})`);
    ok(progress[progress.length - 1] === 30 && progress.every((d, i) => i === 0 || d >= progress[i - 1]), "progress only moves forward, ends at the total");
    ok(result.findings.every((f, i) => f.page === i), "findings in page order");
  }
  {
    const t = page();
    withKey(t.P, "openai");
    let n = 0;
    t.handler = (call) => {
      n += 1;
      if (n === 2) return gptResponse(null, { refusal: "No." });
      const pages = sentTexts(call).data.pages;
      return gptResponse(JSON.stringify({ findings: [{ ref: pages[0].texts[0].ref, kind: "spelling", excerpt: "allé", suggestion: "allée", replacement: null, explanation: "x" }] }));
    };
    const result = await t.P.run({ pages: chapter, language: "fr" });
    ok(n >= 3 && result.skipped.length === 1 && result.skipped[0].error.code === "refused" && result.skipped[0].pages.length > 0, "a refused batch is reported in skipped");
    ok(result.findings.length === n - 1, "the other batches' findings are kept");
  }
  {
    const t = page();
    withKey(t.P, "anthropic");
    const stop = new AbortController();
    let n = 0;
    t.handler = (call, signal) => {
      n += 1;
      if (n === 2) {
        setTimeout(() => stop.abort(), 5);
        return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError"))));
      }
      const pages = sentTexts(call).data.pages;
      return claudeMessage(JSON.stringify({ findings: [{ ref: pages[0].texts[0].ref, kind: "spelling", excerpt: "allé", suggestion: "allée", replacement: null, explanation: "x" }] }));
    };
    try {
      await t.P.run({ pages: chapter, language: "fr", signal: stop.signal });
      ok(false, "abort: should fail");
    } catch (error) {
      ok(error.code === "aborted", `abort mid-run: aborted (${error.code})`);
      ok(error.partial && error.partial.findings.length === 1 && error.partial.done > 0 && error.partial.done < 30, "abort: the first batch's findings kept in partial");
      ok(n === 2, "abort: nothing asked after the stop");
    }
  }
  {
    const t = page();
    withKey(t.P, "anthropic");
    let n = 0;
    t.handler = (call) => {
      n += 1;
      if (n === 2) return anthropicError(401, "authentication_error", "invalid x-api-key");
      return claudeMessage(JSON.stringify({ findings: [{ ref: sentTexts(call).data.pages[0].texts[0].ref, kind: "spelling", excerpt: "allé", suggestion: "allée", replacement: null, explanation: "x" }] }));
    };
    try {
      await t.P.run({ pages: chapter, language: "fr" });
      ok(false, "key lost mid-run: should fail");
    } catch (error) {
      ok(error.code === "key" && error.partial.findings.length === 1 && n === 2, "an error that stops the run keeps the findings already found");
    }
  }

  section("kinds turned off, interface language, nothing to check");
  {
    const t = page();
    withKey(t.P, "anthropic");
    const config = t.P.load();
    config.kinds.grammar = false;
    config.kinds.meaning = false;
    t.P.save(config);
    t.handler = (call) => claudeMessage(JSON.stringify({ findings: [
      { ref: refOf(call, "Je suis"), kind: "grammar", excerpt: "allé", suggestion: "allée", replacement: null, explanation: "x" },
      { ref: refOf(call, "Je suis"), kind: "Spelling", excerpt: "pomes", suggestion: "pommes", replacement: null, explanation: "x" },
    ] }));
    const result = await t.P.run({ pages: PAGES, language: "en-US", interface: "ja" });
    const system = t.calls[0].body.system;
    ok(!/^- grammar:/m.test(system) && !/^- meaning:/m.test(system) && /^- spelling:/m.test(system), "only the kinds turned on are asked");
    ok(/in American English/.test(system) && /in Japanese saying/.test(system), "texts' language and interface language named");
    ok(result.findings.length === 1 && result.findings[0].kind === "spelling", "a finding of a kind turned off is dropped; kind read regardless of case");
    const none = await t.P.run({ pages: [{ name: "x", texts: [] }], language: "fr" });
    ok(none.findings.length === 0 && t.calls.length === 1, "pages without text: nothing sent");
  }

  console.log(`\n${passes} checks passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
