#!/usr/bin/env node
// Are the Verification's words translated? Finds every English string of the feature that a
// typesetter can read (web/verify-rules.js, web/proofread.js, web/verify.js and the feature's
// lines in web/app.js and web/touch.js), then, for each web/strings/verify/<lang>.js there is,
// lists the keys it lacks, the keys it has that the code no longer uses, and the translations
// whose {placeholders} differ from their key's. A key the app-wide web/strings/<lang>.js (or the
// SFX and guide files, loaded into the same table) already translates needs no repeating.
//
//   node scripts/verify-strings-check.js              the code, read as text (a second)
//   node scripts/verify-strings-check.js --runtime    also drives the app headless (Chrome)
//   node scripts/verify-strings-check.js --list       prints every key found, and where
//   node scripts/verify-strings-check.js --json       the result as JSON
//
// Exits 1 when a language lacks a key, keeps an unused one, breaks a placeholder, or when the
// code holds an English sentence the check can't place (see "Unplaced" below).
//
// How the keys are found. The files are tokenized (strings, templates and their ${} parts,
// regular expressions, comments), not run, and no list of keys is written here:
//   - T("…") and TL("key", "…"): every string literal of the first argument, a ternary's two
//     sides included, but not a string compared (=== "all") or used as a property name.
//   - T(TABLE[x]): every string value of the object or array literal TABLE of the same file
//     (CATEGORY_NAMES, SEVERITY_NAMES, KIND_NAMES).
//   - T(name) where `name` is destructured from `[[…], […]].map/forEach(([a, name]) => …)` on an
//     array literal: that column of the literal (the scope buttons).
//   - Helpers that hand a parameter to T (plural(count, one, many), say(message)…), found by
//     reading their bodies: the string literals passed at those parameters' places.
//   - `label:` and `title:` properties (menu items, the dock's title, Fix's "Apply"), and the
//     `text:` of a `message: { … }` object (the proofreading's rows).
//   - verify-rules.js: the RULES table's title, description, option label, unit and choice
//     labels; the message (4th argument) and `fix` (6th argument's property) of every add(…)
//     call, an identifier there followed back to its array literal as above. The script checks
//     that add() still takes (ruleId, entry, detail, text, values, more) and makes
//     `{ label: more.fix }`, and fails otherwise, so a changed signature can't go unseen.
//   - proofread.js: the values of its MESSAGES table (ProofreadError's sentences).
//   - app.js and touch.js: only the lines that name the feature (TypeRVerif…, TypeRProofread,
//     Verification(), VERIFY_ITEMS, pane-verify), with the T(), label: and title: rules above.
// Then a sweep: every other string literal of verify.js and verify-rules.js that reads like a
// sentence or a word of the interface is "unplaced" unless the app-wide file already has it or
// it is in NOT_SHOWN below (an undo step's name, an error's internal message). Unplaced makes
// the check fail: a new way of showing a string has to be taught to this script, or the
// string listed as not shown.
//
// With --runtime the app runs in French in Chrome (desktop/node_modules/playwright-core), the
// strings table wrapped to record every key asked from verify.js, verify-rules.js or
// proofread.js (by the call stack) while the panel is opened, a page with
// mistakes checked, a row's menu, both settings dialogs, the proofreading consent and the
// Batch Save note shown. A key asked there that the static pass missed and that no strings file
// has is reported as missing too, marked (runtime).
//
// What it cannot see: a key built at run time (concatenated, or from a variable the rules above
// don't follow) unless --runtime happens to show it; strings of app.js/touch.js on lines that
// don't name the feature; text set by CSS (content:) or in index.html's markup; the AI prompt
// and the models' names in proofread.js, which aren't interface. Unused keys are judged against
// what the static pass (and --runtime, when given) found.
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const WEB = path.join(ROOT, "web");
const ARGS = process.argv.slice(2);
const RUNTIME = ARGS.includes("--runtime");
const LIST = ARGS.includes("--list");
const JSON_OUT = ARGS.includes("--json");

// Literals of verify.js and verify-rules.js that read like words but are never shown
const NOT_SHOWN = new Set([
  "Verification stopped", // the AbortError's own message, never displayed
  "OK", // the settings dialog's button: the same word in the languages TypeR speaks
  // The review's keys: shown as the keyboard's own symbols (↵, ⌘, ⌫), Escape as "Esc" on every
  // keyboard, as the app shows the keys of its menus
  "Enter", "Cmd+Enter", "Backspace", "Escape", "Cmd+Z", "Esc",
  "dialog[open], .menu.is-open, .menu__list--context, .search", // what's open over the page, a selector
]);

/* -------------------------------- tokenizer -------------------------------- */

const KEYWORDS_BEFORE_REGEX = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
const PUNCT = ["===", "!==", "**=", "...", "<<=", ">>=", ">>>", "&&=", "||=", "??=", "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<", ">>", "**"];

const unescape = (body) => body.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r\n|[\s\S])/g, (all, e) => {
  if (e[0] === "u" && e[1] === "{") return String.fromCodePoint(parseInt(e.slice(2, -1), 16));
  if (e[0] === "u" && e.length === 5) return String.fromCharCode(parseInt(e.slice(1), 16));
  if (e[0] === "x" && e.length === 3) return String.fromCharCode(parseInt(e.slice(1), 16));
  return { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", 0: "\0", "\n": "", "\r\n": "" }[e] ?? e;
});

const tokenize = (src) => {
  const tokens = [];
  const braces = []; // "{" or "${" for each open brace
  let i = 0;
  let line = 1;
  const push = (type, value, start, extra) => tokens.push(Object.assign({ type, value, line, start }, extra));
  const regexAllowed = () => {
    const prev = tokens[tokens.length - 1];
    if (!prev) return true;
    if (prev.type === "num" || prev.type === "str" || prev.type === "tpl" || prev.type === "regex") return false;
    if (prev.type === "ident") return KEYWORDS_BEFORE_REGEX.has(prev.value);
    return ![")", "]", "}"].includes(prev.value);
  };
  // A template from i (just after ` or after the } closing a ${…}): its raw text up to ` or ${
  const templatePart = () => {
    let text = "";
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") {
        text += src.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === "`") {
        i++;
        return { text, end: true };
      }
      if (c === "$" && src[i + 1] === "{") {
        i += 2;
        braces.push("${");
        return { text, end: false };
      }
      if (c === "\n") line++;
      text += c;
      i++;
    }
    return { text, end: true };
  };
  while (i < src.length) {
    const c = src[i];
    const start = i;
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      line += (src.slice(i, stop).match(/\n/g) || []).length;
      i = stop;
      continue;
    }
    if (c === "\"" || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      push("str", unescape(src.slice(i + 1, j)), start);
      i = j + 1;
      continue;
    }
    if (c === "`") {
      i++;
      const part = templatePart();
      push("tpl", unescape(part.text), start, { open: !part.end });
      continue;
    }
    if (c === "}" && braces.length && braces[braces.length - 1] === "${") {
      braces.pop();
      i++;
      const part = templatePart();
      push("tpl", unescape(part.text), start, { cont: true, open: !part.end });
      continue;
    }
    if (c === "/" && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        const d = src[j];
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) break;
        else if (d === "\n") break;
        j++;
      }
      j++;
      while (j < src.length && /[a-z]/i.test(src[j])) j++;
      push("regex", src.slice(i, j), start);
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1]))) {
      const m = /^(0[xXoObB][0-9a-fA-F_]+n?|[0-9_]*\.?[0-9_]*(?:[eE][+-]?[0-9]+)?n?)/.exec(src.slice(i));
      push("num", m[0], start);
      i += Math.max(1, m[0].length);
      continue;
    }
    if (/[\p{L}_$\\]/u.test(c)) {
      const m = /^[\p{L}\p{N}_$‌‍]+/u.exec(src.slice(i));
      push("ident", m[0], start);
      i += m[0].length;
      continue;
    }
    if (c === "{") braces.push("{");
    if (c === "}") braces.pop();
    const p = PUNCT.find((one) => src.startsWith(one, i)) || c;
    push("punc", p, start);
    i += p.length;
  }
  // Pairs: for each opening ( [ { and ${ its closing token, and back
  const pair = new Array(tokens.length).fill(-1);
  const stack = [];
  tokens.forEach((t, k) => {
    const opens = t.type === "punc" && ["(", "[", "{"].includes(t.value);
    const opensTpl = t.type === "tpl" && t.open;
    if (t.type === "tpl" && t.cont) {
      const at = stack.pop();
      if (at !== undefined) {
        pair[at] = k;
        pair[k] = at;
      }
    } else if (t.type === "punc" && [")", "]", "}"].includes(t.value)) {
      const at = stack.pop();
      if (at !== undefined) {
        pair[at] = k;
        pair[k] = at;
      }
    }
    if (opens || opensTpl) stack.push(k);
  });
  return { tokens, pair };
};

/* ------------------------------ reading tokens ------------------------------ */

const COMPARE = new Set(["===", "!==", "==", "!="]);
const is = (t, value) => t && t.type === "punc" && t.value === value;
const isId = (t, value) => t && t.type === "ident" && (value === undefined || t.value === value);

// The top-level comma-separated parts of [from, to)
const split = (code, from, to) => {
  const { tokens, pair } = code;
  const parts = [];
  let start = from;
  for (let k = from; k < to; k++) {
    const t = tokens[k];
    if ((t.type === "punc" && ["(", "[", "{"].includes(t.value)) || (t.type === "tpl" && t.open)) {
      if (pair[k] > k) k = pair[k] - (tokens[pair[k]].type === "tpl" && tokens[pair[k]].open ? 1 : 0);
      // A template with several ${} parts: walk each
      continue;
    }
    if (is(t, ",")) {
      parts.push([start, k]);
      start = k + 1;
    }
  }
  if (start < to) parts.push([start, to]);
  return parts;
};
// The arguments of the call whose "(" is at k
const argsAt = (code, k) => split(code, k + 1, code.pair[k]);

// A string literal in [from, to) used as a value: not compared, not a property name, not the
// left side of `in`, not inside a nested call's arguments unless `deep`
const valueStrings = (code, from, to) => {
  const { tokens } = code;
  const out = [];
  for (let k = from; k < to; k++) {
    const t = tokens[k];
    if (t.type !== "str") continue;
    const prev = tokens[k - 1];
    const next = tokens[k + 1];
    if ((prev && prev.type === "punc" && COMPARE.has(prev.value)) || (next && next.type === "punc" && COMPARE.has(next.value))) continue;
    if (is(next, ":") && (is(prev, "{") || is(prev, ","))) continue;
    if (isId(next, "in")) continue;
    // An argument of a call inside: includes("x"), get("x")
    let inCall = false;
    for (let j = k - 1; j >= from; j--) {
      if (is(tokens[j], "(") && code.pair[j] > k && j > from && (isId(tokens[j - 1]) || is(tokens[j - 1], "]")) && !isId(tokens[j - 1], "T") && !isId(tokens[j - 1], "TL")) {
        inCall = true;
        break;
      }
    }
    if (inCall) continue;
    out.push({ text: t.value, line: t.line });
  }
  return out;
};

// `const NAME = <literal>` in the file: the token index of its { or [
const literalOf = (code, name) => {
  const { tokens } = code;
  for (let k = 0; k < tokens.length - 3; k++) {
    if ((isId(tokens[k], "const") || isId(tokens[k], "let") || isId(tokens[k], "var")) && isId(tokens[k + 1], name) && is(tokens[k + 2], "=") && (is(tokens[k + 3], "{") || is(tokens[k + 3], "["))) return k + 3;
  }
  return -1;
};
// Every string value of an object or array literal (nested ones too), property names left out
const literalValues = (code, open) => valueStrings(code, open + 1, code.pair[open]).concat(
  // valueStrings skips strings inside calls; a table has none, but nested arrays/objects count
  [],
);

// For `name` destructured as `([a, name]) =>` in `[ … ].map(` / `.forEach(`: that column
const destructuredColumn = (code, at, name) => {
  const { tokens, pair } = code;
  for (let k = at; k >= 0; k--) {
    if (!is(tokens[k], "=>")) continue;
    // ( [ a , name ] ) =>
    const close = k - 1;
    if (!is(tokens[close], ")")) continue;
    const open = pair[close];
    if (open < 0 || !is(tokens[open + 1], "[")) continue;
    const arrClose = pair[open + 1];
    const names = split(code, open + 2, arrClose).map(([a]) => (isId(tokens[a]) ? tokens[a].value : null));
    const column = names.indexOf(name);
    if (column < 0) continue;
    // The function's body must reach `at`
    const bodyStart = k + 1;
    const bodyEnd = is(tokens[bodyStart], "{") ? pair[bodyStart] : null;
    if (bodyEnd !== null && bodyEnd < at) continue;
    // ...].map( or ...].forEach( before the parameter list
    const callOpen = open - 1;
    if (!is(tokens[callOpen], "(") || !isId(tokens[callOpen - 1]) || !["map", "forEach", "flatMap", "filter", "find", "some"].includes(tokens[callOpen - 1].value) || !is(tokens[callOpen - 2], ".")) return null;
    const arrayEnd = callOpen - 3;
    if (!is(tokens[arrayEnd], "]")) return null;
    const arrayStart = pair[arrayEnd];
    const out = [];
    split(code, arrayStart + 1, arrayEnd).forEach(([a, b]) => {
      if (!is(tokens[a], "[")) return;
      const cells = split(code, a + 1, pair[a]);
      const cell = cells[column];
      if (cell) out.push(...valueStrings(code, cell[0], cell[1]));
    });
    return out;
  }
  return null;
};

// The values an expression can take: `c ? a : b` gives those of a and b, `a || b` and `a ?? b`
// those of a and b; anything else is one leaf, [from, to)
const leaves = (code, from, to) => {
  const { tokens, pair } = code;
  const top = (k) => k;
  let question = -1;
  let colon = -1;
  let depth = 0;
  const ors = [];
  for (let k = from; k < to; k++) {
    const t = tokens[k];
    if ((t.type === "punc" && ["(", "[", "{"].includes(t.value)) || (t.type === "tpl" && t.open)) {
      if (pair[k] > k) {
        k = pair[k] - (tokens[pair[k]].type === "tpl" && tokens[pair[k]].open ? 1 : 0);
        continue;
      }
    }
    if (is(t, "?")) {
      if (question < 0) question = k;
      else depth++;
    } else if (is(t, ":") && question >= 0) {
      if (depth) depth--;
      else if (colon < 0) colon = k;
    } else if (question < 0 && (is(t, "||") || is(t, "??"))) ors.push(k);
  }
  if (question >= 0 && colon > question) return leaves(code, question + 1, colon).concat(leaves(code, colon + 1, to));
  if (ors.length) {
    const out = [];
    let start = from;
    ors.concat([to]).forEach((k) => {
      out.push(...leaves(code, start, k));
      start = k + 1;
    });
    return out;
  }
  // (a) is a
  if (is(tokens[from], "(") && pair[from] === to - 1) return leaves(code, from + 1, to - 1);
  return top(from) < to ? [[from, to]] : [];
};

// A key-taking call's first argument: each value it can take is a string (a key), TABLE[x] (the
// table's strings), a name destructured from an array literal (that column), or else computed
const keysOfArgument = (code, [from, to], found, dynamic, helpers) => {
  const { tokens } = code;
  leaves(code, from, to).forEach(([a, b]) => {
    const first = tokens[a];
    const text = () => code.src.slice(first.start, tokens[b - 1].start + String(tokens[b - 1].value).length + 2).replace(/\s+/g, " ").slice(0, 80);
    if (b - a === 1 && first.type === "str") return found([{ text: first.value, line: first.line }]);
    if (isId(first) && is(tokens[a + 1], "[") && code.pair[a + 1] === b - 1) {
      const at = literalOf(code, first.value);
      if (at >= 0) return found(literalValues(code, at));
      return dynamic(`:${first.line} ${text()}`);
    }
    if (b - a === 1 && isId(first)) {
      const column = destructuredColumn(code, a, first.value);
      if (column) return found(column);
      // A helper's own parameter: its callers are read instead
      if (helpers && helpers.some((h) => h.params.includes(first.value) && a > h.body[0] && a < h.body[1])) return;
      return dynamic(`:${first.line} ${text()}`);
    }
    // rule.title, issue.fix.label, error.message…: read where those are made (RULES, add(), MESSAGES)
    if (isId(first) && tokens.slice(a, b).every((t) => isId(t) || is(t, "."))) return;
    if (first.type === "tpl" || tokens.slice(a, b).some((t) => t.type === "str" || t.type === "tpl")) return dynamic(`:${first.line} ${text()}`);
    if (b - a === 1 && first.type !== "ident") return;
    dynamic(`:${first.line} ${text()}`);
  });
};

// Helpers that hand one of their parameters to T: { name: [parameter positions] }
const keyHelpers = (code) => {
  const { tokens, pair } = code;
  const out = Object.create(null);
  for (let k = 0; k < tokens.length - 4; k++) {
    if (!isId(tokens[k], "const") || !isId(tokens[k + 1]) || !is(tokens[k + 2], "=") || !is(tokens[k + 3], "(")) continue;
    const name = tokens[k + 1].value;
    const close = pair[k + 3];
    if (!is(tokens[close + 1], "=>")) continue;
    const params = split(code, k + 4, close).map(([a]) => (isId(tokens[a]) ? tokens[a].value : null));
    const bodyStart = close + 2;
    const bodyEnd = is(tokens[bodyStart], "{") ? pair[bodyStart] : (() => {
      let j = bodyStart;
      while (j < tokens.length && !is(tokens[j], ";")) j = pair[j] > j ? pair[j] + 1 : j + 1;
      return j;
    })();
    const positions = new Set();
    for (let j = bodyStart; j < bodyEnd; j++) {
      if (!(isId(tokens[j], "T") && is(tokens[j + 1], "(") && !is(tokens[j - 1], "."))) continue;
      const [first] = argsAt(code, j + 1);
      if (!first) continue;
      leaves(code, first[0], first[1]).forEach(([a, b]) => {
        const t = tokens[a];
        // the parameter itself, or TABLE[parameter] (kindName): a key either way
        const at = isId(t) ? params.indexOf(t.value) : -1;
        if (at >= 0 && b - a === 1) positions.add(at);
      });
    }
    if (positions.size && name !== "T" && name !== "TL") out[name] = { positions: Array.from(positions), params, body: [bodyStart, bodyEnd] };
  }
  return out;
};

/* ------------------------------- the extraction ------------------------------- */

const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const load = (file) => {
  const src = read(file);
  return Object.assign({ file, src }, tokenize(src));
};

const keys = new Map(); // key -> Set of "file:line"
const dynamic = [];
const problems = [];
const add = (file) => (list) => list.forEach(({ text, line }) => {
  if (!/\p{L}/u.test(text)) return;
  if (!keys.has(text)) keys.set(text, new Set());
  keys.get(text).add(`${file}:${line}`);
});

// The T(), TL(), helper, label:/title:/message.text rules, on the tokens whose line passes `keep`
const uiRules = (code, keep = () => true) => {
  const { tokens, pair } = code;
  const found = add(code.file);
  const helpers = keyHelpers(code);
  const claimed = new Set();
  const claim = (list) => {
    list.forEach((one) => claimed.add(`${one.line}\u0000${one.text}`));
    found(list);
  };
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (!keep(t.line)) continue;
    const call = isId(t) && is(tokens[k + 1], "(") && !is(tokens[k - 1], ".");
    if (call && (t.value === "T" || t.value === "TL")) {
      const [first] = argsAt(code, k + 1);
      if (first) keysOfArgument(code, first, claim, (what) => dynamic.push(`${code.file}${what}`), Object.values(helpers));
      continue;
    }
    if (call && helpers[t.value]) {
      const args = argsAt(code, k + 1);
      helpers[t.value].positions.forEach((at) => { if (args[at]) claim(valueStrings(code, args[at][0], args[at][1])); });
      continue;
    }
    // label: "…", title: "…" in an object literal
    if ((isId(t, "label") || isId(t, "title")) && is(tokens[k + 1], ":") && (is(tokens[k - 1], "{") || is(tokens[k - 1], ","))) {
      let end = k + 2;
      while (end < tokens.length && !is(tokens[end], ",") && !is(tokens[end], "}")) end = pair[end] > end ? pair[end] + 1 : end + 1;
      claim(valueStrings(code, k + 2, end));
      continue;
    }
    // message: { text: … } and message: cond ? { text: … } : { text: … }
    if (isId(t, "message") && is(tokens[k + 1], ":")) {
      let end = k + 2;
      while (end < tokens.length && !is(tokens[end], ",") && !is(tokens[end], "}")) end = pair[end] > end ? pair[end] + 1 : end + 1;
      for (let j = k + 2; j < end; j++) {
        if (isId(tokens[j], "text") && is(tokens[j + 1], ":")) {
          let stop = j + 2;
          while (stop < end && !(is(tokens[stop], ",") || is(tokens[stop], "}"))) stop = pair[stop] > stop ? pair[stop] + 1 : stop + 1;
          claim(valueStrings(code, j + 2, stop));
        }
      }
    }
  }
  return claimed;
};

const rulesFile = load("web/verify-rules.js");
const proofFile = load("web/proofread.js");
const panelFile = load("web/verify.js");
const appFile = load("web/app.js");
const touchFile = load("web/touch.js");

// verify-rules.js: the RULES table
const rulesClaimed = new Set();
{
  const code = rulesFile;
  const { tokens, pair } = code;
  const found = (list) => {
    list.forEach((one) => rulesClaimed.add(`${one.line}\u0000${one.text}`));
    add(code.file)(list);
  };
  const at = literalOf(code, "RULES");
  if (at < 0) problems.push("verify-rules.js: no `const RULES = [` table any more: teach this check where the rules are");
  else {
    for (let k = at; k < pair[at]; k++) {
      const t = tokens[k];
      if (["title", "description", "label", "unit"].some((name) => isId(t, name)) && is(tokens[k + 1], ":")) {
        let end = k + 2;
        while (!is(tokens[end], ",") && !is(tokens[end], "}")) end = pair[end] > end ? pair[end] + 1 : end + 1;
        found(valueStrings(code, k + 2, end));
      }
      if (isId(t, "choices") && is(tokens[k + 1], ":") && is(tokens[k + 2], "[")) {
        split(code, k + 3, pair[k + 2]).forEach(([a]) => {
          if (!is(tokens[a], "[")) return;
          const cells = split(code, a + 1, pair[a]);
          if (cells[1]) found(valueStrings(code, cells[1][0], cells[1][1]));
        });
      }
    }
  }
  // add(ruleId, entry, detail, text, values, more): its definition, then each call
  let def = -1;
  for (let k = 0; k < tokens.length - 3; k++) if (isId(tokens[k], "const") && isId(tokens[k + 1], "add") && is(tokens[k + 2], "=") && is(tokens[k + 3], "(")) def = k + 3;
  const params = def >= 0 ? split(code, def + 1, pair[def]).map(([a]) => (isId(tokens[a]) ? tokens[a].value : "?")) : [];
  const body = def >= 0 ? code.src.slice(tokens[def].start, tokens[Math.min(tokens.length - 1, pair[pair[def] + 2] || def)].start) : "";
  if (params.join(",") !== "ruleId,entry,detail,text,values,more" || !/message:\s*values\s*\?\s*\{\s*text,\s*values\s*\}\s*:\s*\{\s*text\s*\}/.test(body) || !/fix:\s*more\.fix\s*\?\s*\{\s*label:\s*more\.fix\s*\}/.test(body)) {
    problems.push(`verify-rules.js: add() is now (${params.join(", ")}) or builds its message or fix another way: teach this check where an issue's message and fix label are`);
  }
  for (let k = 0; k < tokens.length; k++) {
    if (!(isId(tokens[k], "add") && is(tokens[k + 1], "(") && !is(tokens[k - 1], ".") && k !== def - 3 && !isId(tokens[k - 1], "const"))) continue;
    const args = argsAt(code, k + 1);
    if (args[3]) keysOfArgument(code, args[3], found, (what) => dynamic.push(`${code.file}${what}`));
    if (args[5] && is(tokens[args[5][0]], "{")) {
      const open = args[5][0];
      for (let j = open + 1; j < pair[open]; j++) {
        if (isId(tokens[j], "fix") && is(tokens[j + 1], ":") && (is(tokens[j - 1], "{") || is(tokens[j - 1], ","))) {
          let end = j + 2;
          while (!is(tokens[end], ",") && !is(tokens[end], "}")) end = pair[end] > end ? pair[end] + 1 : end + 1;
          keysOfArgument(code, [j + 2, end], found, (what) => dynamic.push(`${code.file}${what}`));
        }
      }
    }
  }
  uiRules(code).forEach((one) => rulesClaimed.add(one));
}

// proofread.js: MESSAGES
{
  const at = literalOf(proofFile, "MESSAGES");
  if (at < 0) problems.push("proofread.js: no `const MESSAGES = {` table any more: teach this check where ProofreadError's sentences are");
  else add(proofFile.file)(literalValues(proofFile, at));
  if (!/super\(MESSAGES\[/.test(proofFile.src)) problems.push("proofread.js: ProofreadError no longer takes its sentence from MESSAGES: teach this check where it does");
  uiRules(proofFile);
}

// verify.js: everything
const panelClaimed = uiRules(panelFile);

// app.js and touch.js: the feature's lines only
const FEATURE_LINE = /TypeRVerif|TypeRProofread|Verification\(\)|VERIFY_ITEMS|pane-verify/;
[appFile, touchFile].forEach((code) => {
  const lines = code.src.split("\n");
  uiRules(code, (line) => FEATURE_LINE.test(lines[line - 1] || ""));
});

/* ---------------------------------- the strings files ---------------------------------- */

const tableOf = (files) => {
  const window = {};
  const sandbox = { window };
  vm.createContext(sandbox);
  files.forEach((file) => {
    if (fs.existsSync(file)) vm.runInContext(fs.readFileSync(file, "utf8"), sandbox, { filename: file });
  });
  return window.TYPER_WEB_STRINGS || {};
};
const ownKeys = (file, lang) => {
  const table = tableOf([file]);
  return (table && table[lang]) || {};
};

/* ------------------------------------ the sweep ------------------------------------ */

const LANGS = fs.existsSync(path.join(WEB, "strings", "verify")) ? fs.readdirSync(path.join(WEB, "strings", "verify")).filter((f) => /^[a-z]{2}(-[A-Za-z]+)?\.js$/.test(f)).map((f) => f.replace(/\.js$/, "")).sort() : [];
// What the app-wide files hold, in any language that has them: a key known there needs no repeating
const appWide = (lang) => tableOf(["", "sfx", "guide"].map((dir) => path.join(WEB, "strings", dir, `${lang}.js`)))[lang] || {};
const frWide = appWide("fr");

// Literals that read like interface words: a sentence, a capitalised word, a placeholder
const looksShown = (raw) => {
  const s = raw.trim();
  if (!/\p{L}/u.test(s)) return false;
  if (s === "use strict") return false;
  if (/^[a-z0-9_ -]+$/.test(s)) return false; // all lower case, no punctuation: class names, ids, events
  if (/^[<#.\[]|^https?:|^\w+:\/\//.test(s)) return false; // markup, selectors, links
  if (/^[a-z0-9_-]+(?:\s+[a-z0-9_-]+)*$/.test(s) && /__|--|-|^[a-z0-9]+$/.test(s)) return false; // class names, ids, words of code
  if (/^[a-z][a-zA-Z0-9]*$/.test(s)) return false; // identifiers
  if (/^[A-Z][a-z]+[A-Z]\w*$/.test(s)) return false; // AbortError, ArrowDown
  if (/^[A-Z0-9_]+$/.test(s)) return false; // CONSTANTS
  if (/^(TypeR web|TypeR):/.test(s)) return false; // console messages
  if (/^[\w.]+$/.test(s) && /\./.test(s)) return false; // typer.web.verify
  return /\s/.test(s) || /^[A-Z]/.test(s) || /\{\w+\}/.test(s);
};
const unplaced = [];
const sweep = (code, claimed) => {
  const { tokens } = code;
  tokens.forEach((t, k) => {
    if (t.type !== "str" || !looksShown(t.value)) return;
    if (claimed.has(`${t.line}\u0000${t.value}`) || keys.has(t.value)) return;
    if (NOT_SHOWN.has(t.value)) return;
    // console.*( … ), new Error( … ), new DOMException( … ), compared, property names
    let callee = null;
    for (let j = k - 1; j >= 0 && j > k - 400; j--) {
      if (is(tokens[j], "(") && code.pair[j] > k) {
        callee = tokens[j - 1];
        const before = tokens[j - 3];
        if (callee && is(tokens[j - 2], ".") && isId(before, "console")) return;
        if (isId(callee) && ["Error", "DOMException", "TypeError"].includes(callee.value)) return;
        break;
      }
    }
    if (COMPARE.has((tokens[k - 1] || {}).value) || COMPARE.has((tokens[k + 1] || {}).value)) return;
    if (is(tokens[k + 1], ":") && (is(tokens[k - 1], "{") || is(tokens[k - 1], ","))) return;
    if (frWide[t.value] != null) return;
    unplaced.push(`${code.file}:${t.line} ${JSON.stringify(t.value)}`);
  });
};
sweep(panelFile, panelClaimed);
sweep(rulesFile, rulesClaimed);
// Templates whose fixed text reads like a sentence: never a key (T() takes plain strings)
[panelFile, rulesFile].forEach((code) => code.tokens.forEach((t) => {
  if (t.type === "tpl" && /[A-Za-z]{3,} [a-z]{2,} [a-z]{2,}/.test(t.value) && !/^\s*</.test(t.value)) unplaced.push(`${code.file}:${t.line} template ${JSON.stringify(t.value)}`);
}));

/* ----------------------------------- the runtime ----------------------------------- */

const runtimeKeys = new Map(); // key -> where it was asked

const runRuntime = async () => {
  const http = require("http");
  const { chromium } = require(path.join(ROOT, "desktop", "node_modules", "playwright-core"));
  const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json", ".wasm": "application/wasm" };
  const server = await new Promise((resolve) => {
    const s = http.createServer((request, response) => {
      const url = decodeURIComponent(new URL(request.url, "http://x").pathname);
      let file = path.join(ROOT, url);
      if (!file.startsWith(ROOT)) return response.writeHead(403).end();
      if (url.endsWith("/")) file = path.join(file, "index.html");
      fs.readFile(file, (error, data) => {
        if (error) return response.writeHead(404).end();
        response.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
        response.end(data);
      });
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    await context.addInitScript(() => {
      try {
        Object.defineProperty(navigator, "serviceWorker", { get: () => undefined });
      } catch (error) {}
      // The French table, wrapped: every key the feature's files ask for is noted
      window.__asked = new Map();
      window.__recording = "";
      let fr = null;
      const wrap = (table) => new Proxy(table, {
        get(target, key) {
          // Asked by the feature's own files: its call stack goes through them
          if (typeof key === "string" && window.__recording && !window.__asked.has(key) && /\/(verify|verify-rules|proofread)\.js/.test(new Error().stack || "")) window.__asked.set(key, window.__recording);
          return target[key];
        },
      });
      const all = {};
      Object.defineProperty(all, "fr", { enumerable: true, configurable: true, get: () => fr, set: (value) => { fr = value && value.__isProxy ? value : wrap(value); } });
      window.TYPER_WEB_STRINGS = all;
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${server.address().port}/web/?lang=fr`);
    for (let tries = 0; tries < 300; tries++) {
      if (await page.evaluate(() => Boolean(window.TypeRApp && window.TypeRApp.booted))) break;
      const skip = await page.$("dialog.onboard[open] .onboard__skip");
      if (skip) await skip.click().catch(() => {});
      else await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach((one) => { const yes = one.querySelector(".modal__foot .btn--main, .wn__close, [data-close]"); if (yes) yes.click(); else one.close(); }));
      await page.waitForTimeout(100);
    }
    if (!(await page.evaluate(() => Boolean(window.TypeRApp && window.TypeRApp.booted)))) throw new Error(`the app didn't boot: ${errors.join(" | ")}`);
    const step = (name) => page.evaluate((name) => { window.__recording = name; }, name);
    const settle = async () => {
      await page.waitForTimeout(150);
      await page.waitForFunction(() => window.TypeRVerification && !window.TypeRVerification.running, null, { timeout: 30000 });
      await page.waitForTimeout(600);
      await page.waitForFunction(() => window.TypeRVerification && !window.TypeRVerification.running, null, { timeout: 30000 });
    };
    const closeDialogs = () => page.evaluate(() => document.querySelectorAll("dialog[open]").forEach((one) => { const no = one.querySelector(".modal__foot .btn:not(.btn--main)"); if (no) no.click(); else one.close(); }));
    // The panel, on no page, then on a page with mistakes
    await step("panel, no page");
    await page.evaluate(() => window.TypeRVerification.open());
    await page.waitForTimeout(300);
    await step("page with mistakes");
    await page.evaluate(() => {
      const { ops } = window.TypeRPhotoshop;
      ops.newDocument({ name: "page 1", width: 1600, height: 2400, resolution: 72, background: "#ffffff" });
      const bitmap = document.createElement("canvas");
      bitmap.width = 1600;
      bitmap.height = 2400;
      const c = bitmap.getContext("2d");
      c.fillStyle = "#fff";
      c.strokeStyle = "#000";
      c.lineWidth = 6;
      c.beginPath();
      c.ellipse(500, 400, 380, 260, 0, 0, Math.PI * 2);
      c.fill();
      c.stroke();
      ops.newLayer("Bubbles", undefined, { bitmap });
      [[300, 300, "Hello  there .. who are you!?"], [200, 1200, "NOT IN THE SCRIPT at all"], [1500, 2350, "Off the page text"], [300, 1800, "   "], [600, 900, "WHAT????"]].forEach(([x, y, text]) => ops.newText(x, y, text, { width: 400, height: 200 }));
    });
    await settle();
    await step("page with mistakes, all pages");
    await page.evaluate(() => {
      window.TypeRPhotoshop.ops.newDocument({ name: "page 2", width: 800, height: 1200, resolution: 72, background: "#ffffff" });
      window.TypeRPhotoshop.ops.newText(100, 100, "Two  spaces", { width: 400, height: 200 });
    });
    await page.click("#verify .verify__scope button[data-scope=all]").catch(() => {});
    await settle();
    await step("row menu");
    const row = await page.$("#verify .verify__row");
    if (row) {
      await row.click({ button: "right" }).catch(() => {});
      await page.waitForTimeout(200);
      await page.keyboard.press("Escape");
    }
    await step("rule settings");
    const settings = page.evaluate(() => window.TypeRVerification.openSettings());
    await page.waitForTimeout(500);
    await closeDialogs();
    await settings.catch(() => {});
    await step("AI settings");
    const ai = page.evaluate(() => window.TypeRVerification.openAISettings());
    await page.waitForTimeout(800);
    await closeDialogs();
    await ai.catch(() => {});
    await step("proofreading without a key");
    await page.evaluate(() => { try { localStorage.setItem("typer.web.proofread", JSON.stringify({ service: "openai", keys: { openai: "sk-test", anthropic: "" } })); } catch (error) {} });
    const proof = page.evaluate(() => window.TypeRVerification.proofread());
    await page.waitForTimeout(600);
    await closeDialogs();
    await proof.catch(() => {});
    await step("Batch Save");
    await page.evaluate(() => {
      const note = window.TypeRVerification.batchNote(window.TypeRPhotoshop.app.docs, null);
      if (note) document.body.appendChild(note);
    });
    await step("");
    const asked = await page.evaluate(() => Array.from(window.__asked.entries()));
    asked.forEach(([key, where]) => runtimeKeys.set(key, where));
    if (errors.length) problems.push(`runtime: the page reported errors: ${errors.slice(0, 3).join(" | ")}`);
  } finally {
    await browser.close();
    server.close();
  }
};

/* ------------------------------------ the report ------------------------------------ */

const main = async () => {
  if (RUNTIME) {
    try {
      await runRuntime();
    } catch (error) {
      problems.push(`runtime pass failed: ${error.message}`);
    }
  }
  // Keys asked at run time that the static pass didn't find, and that a feature string could be:
  // not already in an app-wide file, words with letters
  const runtimeOnly = [];
  runtimeKeys.forEach((where, key) => {
    if (keys.has(key) || !/\p{L}/u.test(key) || /^__|^(then|toJSON|constructor)$/.test(key)) return;
    if (frWide[key] != null) return;
    runtimeOnly.push({ key, where });
  });
  const needed = new Set(keys.keys());
  runtimeOnly.forEach(({ key }) => needed.add(key));

  const report = { keys: keys.size, runtimeOnly: runtimeOnly.length, unplaced, dynamic, problems: problems.slice(), languages: {} };
  let failed = problems.length > 0 || unplaced.length > 0;
  LANGS.forEach((lang) => {
    const own = ownKeys(path.join(WEB, "strings", "verify", `${lang}.js`), lang);
    const wide = appWide(lang);
    const missing = [];
    needed.forEach((key) => {
      if (own[key] != null || wide[key] != null) return;
      missing.push(key);
    });
    const unused = Object.keys(own).filter((key) => !needed.has(key));
    const elsewhere = Object.keys(own).filter((key) => needed.has(key) && wide[key] != null);
    const placeholders = Object.keys(own).filter((key) => {
      const a = (key.match(/\{\w+\}/g) || []).sort().join();
      const b = (String(own[key]).match(/\{\w+\}/g) || []).sort().join();
      const uniq = (s) => Array.from(new Set(s.split(","))).join();
      return uniq(a) !== uniq(b);
    });
    report.languages[lang] = { translated: Object.keys(own).length, missing, unused, alsoAppWide: elsewhere, placeholders };
    if (missing.length || unused.length || placeholders.length) failed = true;
  });

  if (JSON_OUT) {
    console.log(JSON.stringify(Object.assign(report, { list: Array.from(keys, ([key, where]) => ({ key, where: Array.from(where) })) }), null, 2));
    process.exit(failed ? 1 : 0);
  }
  if (LIST) {
    Array.from(keys.keys()).sort().forEach((key) => console.log(`${JSON.stringify(key)}  ${Array.from(keys.get(key)).join(", ")}`));
    runtimeOnly.forEach(({ key, where }) => console.log(`${JSON.stringify(key)}  (runtime: ${where})`));
    console.log("");
  }
  const inFr = Array.from(keys.keys()).filter((key) => frWide[key] != null).length;
  console.log(`Verification strings: ${keys.size} keys found in the code (${inFr} already in the app-wide French file)${RUNTIME ? `, ${runtimeKeys.size} keys asked at run time, ${runtimeOnly.length} of them unknown to the static pass` : ""}.`);
  if (runtimeOnly.length) {
    console.log("Asked at run time only (counted as needed):");
    runtimeOnly.forEach(({ key, where }) => console.log(`  ${JSON.stringify(key)}  (${where})`));
  }
  if (dynamic.length) {
    console.log(`Keys computed at run time (${dynamic.length}), not followed statically${RUNTIME ? "" : "; --runtime sees those it can show"}:`);
    dynamic.forEach((one) => console.log(`  ${one}`));
  }
  if (unplaced.length) {
    console.log(`FAIL Unplaced (${unplaced.length}): English in the code this check can't tie to a translation. Teach the script how it is shown, or add it to NOT_SHOWN:`);
    unplaced.forEach((one) => console.log(`  ${one}`));
  }
  problems.forEach((one) => console.log(`FAIL ${one}`));
  if (!LANGS.length) console.log("No web/strings/verify/<lang>.js yet.");
  LANGS.forEach((lang) => {
    const r = report.languages[lang];
    const bad = r.missing.length || r.unused.length || r.placeholders.length;
    console.log(`${bad ? "FAIL" : "ok  "} ${lang}: ${r.translated} translated here, ${r.missing.length} missing, ${r.unused.length} unused, ${r.placeholders.length} with other placeholders${r.alsoAppWide.length ? `, ${r.alsoAppWide.length} also in the app-wide file` : ""}`);
    r.missing.forEach((key) => console.log(`    missing: ${JSON.stringify(key)}${keys.has(key) ? `  (${Array.from(keys.get(key))[0]})` : "  (runtime)"}`));
    r.unused.forEach((key) => console.log(`    unused: ${JSON.stringify(key)}`));
    r.placeholders.forEach((key) => console.log(`    placeholders differ: ${JSON.stringify(key)}`));
    r.alsoAppWide.forEach((key) => console.log(`    also app-wide (the verify file wins): ${JSON.stringify(key)}`));
  });
  process.exit(failed ? 1 : 0);
};
main();
