// What Chinese and Japanese text needs that Latin text doesn't: where a line may break when
// there are no spaces between the words, and which way each character stands in a vertical
// text. Korean is written with spaces and breaks at them, as any text here.

(function () {
  "use strict";

  /* ------------------------------ line breaks ------------------------------ */

  // The characters a line can break before or after with nothing between them: ideographs,
  // kana, bopomofo, and the punctuation and full-width forms set with them
  const WIDE = /[⺀-⿟　-ㄯ㆐-䶿一-鿿豈-﫿︰-﹯！-ﾟ￠-￦\u{1B000}-\u{1B16F}\u{20000}-\u{3FFFF}]/u;
  // What never starts a line (closing brackets, stops, small kana, the long vowel mark…) and
  // what never ends one (opening brackets, a currency sign before its number): Photoshop's own
  // strict set (Kinsoku Shori: JIS Strict), with the Chinese marks it leaves out
  const NO_START = new Set(Array.from("、。，．・：；？！ー―’”）〕］｝〉》」』】〗〙〛ヽヾゝゞ々〻ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ゛゜ﾞﾟ?!)]},.:;℃℉¢％‰°′″〜～·‧%-/\"'"));
  const NO_END = new Set(Array.from("‘“（〔［｛〈《「『【〖〘〚([{￥＄£＠§〒＃$#\"'"));
  // Written twice in a row, they make one mark: never one at the end of a line and one at the
  // start of the next
  const PAIRED = new Set(Array.from("—―…‥"));
  // The stops and closing marks a line may end on whatever follows, and the opening marks one
  // may start on whatever comes before, when the words they close or open are Chinese or
  // Japanese: a Latin word or a number set in the middle of the sentence ("书，OK吗？"). The
  // same marks in a Latin text ("Oui！？Non") stay with their words.
  const ENDS_ANY = new Set(Array.from("、。，．：；？！）〕］｝〉》」』】〗〙〛”’"));
  const STARTS_ANY = new Set(Array.from("（〔［｛〈《「『【〖〘〚“‘"));
  // Full-width digits and Latin letters: the letters of a number or a word, not marks. A line
  // breaks between one of them and an ideograph, never between two.
  const WIDE_WORD = /[０-９Ａ-Ｚａ-ｚ]/;
  const has = (text) => WIDE.test(text);
  const wide = (ch) => Boolean(ch) && WIDE.test(ch);
  const gap = (ch) => ch === " " || ch === "\t" || ch === "\r" || ch === "\n";
  // The letters among them: ideographs, kana and bopomofo. A line breaks next to one of
  // these, or between two marks of such a text (a full stop and the bracket that follows).
  // Not next to a full-width mark alone: the "～" of "Yay～♪" in a Latin text stays with
  // its word, as it always did.
  const LETTER = /[\u2E80-\u2FDF\u3005-\u3007\u3021-\u3029\u3038-\u303B\u3041-\u3096\u309D-\u309F\u30A1-\u30FA\u30FD-\u30FF\u3105-\u312F\u31A0-\u31BF\u31F0-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF66-\uFF9D\u{1B000}-\u{1B16F}\u{20000}-\u{3FFFF}]/u;
  // The marks Chinese shares with Latin text: quotes, dashes, ellipses
  const SHARED_MARKS = new Set(Array.from("“”‘’—―…‥·"));
  const mark = (ch) => (WIDE.test(ch) && !LETTER.test(ch) && !WIDE_WORD.test(ch)) || SHARED_MARKS.has(ch);
  // What is carried by the character before it: an accent, a voicing mark, a variation selector
  const CARRIED = /^\p{M}/u;
  // Whether a line can end between these two characters with nothing added
  const breaksBetween = (before, after) => {
    if (!before || !after || gap(before) || gap(after) || CARRIED.test(after)) return false;
    if (!LETTER.test(before) && !LETTER.test(after) && !(mark(before) && mark(after) && (wide(before) || wide(after)))) return false;
    if (NO_START.has(after) || NO_END.has(before)) return false;
    if (before === after && PAIRED.has(after)) return false;
    return true;
  };
  // The places inside a text where a line can break without a space: null when it has none
  const breaksOf = (text) => {
    // Only a text with an ideograph or a kana in it: full-width marks alone, in a Latin text,
    // break nothing
    if (!LETTER.test(text)) return null;
    const breaks = new Set();
    const characters = Array.from(text);
    // The letter the marks before a place close, and the one the marks after it open: the
    // nearest character that is no mark, none across a space
    const closed = [];
    const opened = [];
    let letter = "";
    characters.forEach((ch, i) => {
      closed[i] = letter;
      if (!mark(ch)) letter = gap(ch) ? "" : ch;
    });
    letter = "";
    for (let i = characters.length - 1; i >= 0; i--) {
      if (!mark(characters[i])) letter = gap(characters[i]) ? "" : characters[i];
      opened[i] = letter;
    }
    let before = "";
    let at = 0;
    characters.forEach((ch, i) => {
      if (at > 0) {
        if (breaksBetween(before, ch)) breaks.add(at);
        else if (!gap(before) && !gap(ch) && !CARRIED.test(ch) && !NO_START.has(ch) && !NO_END.has(before) &&
          // A full-width mark is the sentence's own; a curly quote may be a Latin word's, and
          // goes by the letters it holds
          ((ENDS_ANY.has(before) && (wide(before) || LETTER.test(closed[i]))) || (STARTS_ANY.has(ch) && (wide(ch) || LETTER.test(opened[i]))))) breaks.add(at);
      }
      before = ch;
      at += ch.length;
    });
    return breaks.size ? breaks : null;
  };

  /* --------------------------- vertical orientation --------------------------- */

  // Unicode's Vertical_Orientation (UAX #50, Unicode 18): the characters that stand upright
  // in a vertical line, the ones a font draws another way there and that stay upright
  // without it (a comma, a small kana), and the ones that are turned without it (a bracket,
  // the long vowel mark). Every other character lies on its side, as Latin letters do.
  const rangesOf = (source) => source.split(" ").map((part) => {
    const [from, to] = part.split("-").map((hex) => parseInt(hex, 16));
    return [from, to === undefined ? from : to];
  });
  const UPRIGHT = rangesOf("a7 a9 ae b1 bc-be d7 f7 2ea-2eb 1100-11ff 1401-167f 18b0-18ff 2016 2020-2021 2030-2031 203b-203c 2042 2047-2049 2051 2065 20dd-20e0 20e2-20e4 2100-2101 2103-2109 210f 2113-2114 2116-2117 211e-2123 2125 2127 2129 212e 2135-213f 2145-214a 214c-214d 214f-2189 218c-218f 221e 2234-2235 2300-2307 230c-231f 2324-2328 232b 237d-239a 23be-23cd 23cf 23d1-23db 23e2-2422 2424-24ff 25a0-2619 2620-2767 2776-2793 2b12-2b2f 2b50-2b59 2b97 2bb8-2bd1 2bd3-2beb 2bf0-2bff 2e50-2e51 2e80-3000 3003-3007 3012-3013 3020-302f 3031-3040 3042 3044 3046 3048 304a-3062 3064-3082 3084 3086 3088-308d 308f-3094 3097-309a 309d-309f 30a2 30a4 30a6 30a8 30aa-30c2 30c4-30e2 30e4 30e6 30e8-30ed 30ef-30f4 30f7-30fb 30fd-3126 3128-31b3 31b8-31ba 31bc-31ef 3200-32fe 3358-337a 3380-a4cf a960-a97f ac00-d7ff e000-faff fe10-fe1f fe30-fe48 fe53-fe57 fe5f-fe62 fe67-fe6f ff02-ff07 ff0a-ff0b ff0f-ff19 ff20-ff3a ff3c ff3e ff40-ff5a ffe0-ffe2 ffe4-ffe7 fff0-fff8 fffc-fffd 10980-1099f 11580-115ff 11a00-11abf 13000-1467f 16fe0-191df 1aff0-1b131 1b133-1b14f 1b153-1b154 1b156-1b163 1b169-1b2ff 1cec0-1cedc 1cee0-1cef0 1cefe-1cfcf 1d000-1d1ff 1d250-1d281 1d2e0-1d37f 1d800-1daaf 1f000-1f1ff 1f202-1f7ff 1f900-1faff 20000-2fffd 30000-3fffd f0000-ffffd 100000-10fffd");
  const UPRIGHT_ELSE = rangesOf("3001-3002 3041 3043 3045 3047 3049 3063 3083 3085 3087 308e 3095-3096 309b-309c 30a1 30a3 30a5 30a7 30a9 30c3 30e3 30e5 30e7 30ee 30f5-30f6 3127 31b4-31b7 31bb 31f0-31ff 32ff-3357 337b-337f fe50-fe52 ff01 ff0c ff0e ff1f 1b132 1b150-1b152 1b155 1b164-1b168 1f200-1f201");
  const TURNED_ELSE = rangesOf("2018-2019 201c-201d 2329-232a 3008-3011 3014-301f 3030 30a0 30fc fe59-fe5e ff08-ff09 ff1a-ff1b ff3b ff3d ff3f ff5b-ff60 ffe3");
  const within = (ranges, code) => {
    let low = 0;
    let high = ranges.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (code < ranges[mid][0]) high = mid - 1;
      else if (code > ranges[mid][1]) low = mid + 1;
      else return true;
    }
    return false;
  };
  // "U", "Tu", "Tr" or "R"
  const orientationOf = (ch) => {
    const code = ch.codePointAt(0);
    if (code < 0xa7) return "R";
    if (within(UPRIGHT, code)) return "U";
    if (within(TURNED_ELSE, code)) return "Tr";
    if (within(UPRIGHT_ELSE, code)) return "Tu";
    return "R";
  };

  /* ---------------------- side by side in a vertical line ---------------------- */

  // Two digits, or two of ! and ?, are set side by side in a vertical line (Photoshop's
  // Tate-Chu-Yoko), as every Chinese and Japanese page sets them: "12" and "!?" each take
  // the room of one character. Only a pair that stands alone: "2026" and "3.5" stay as they
  // are. The pairs of a text, each [start, end).
  const RUNS = /[0-9]+|[!?]+/g;
  const pairsOf = (text) => {
    if (!/[0-9!?]{2}/.test(text)) return null;
    const pairs = [];
    for (const match of text.matchAll(RUNS)) {
      if (match[0].length !== 2) continue;
      const at = match.index;
      if (/[0-9]/.test(match[0])) {
        // Part of a longer number, a word, a time or a price: left as it is
        const after = text[at + 2] || "";
        if (/[A-Za-z.,:%/-]/.test(text[at - 1] || "")) continue;
        if (/[A-Za-z%/-]/.test(after) || (/[.,:]/.test(after) && /[0-9]/.test(text[at + 3] || ""))) continue;
      }
      pairs.push([at, at + 2]);
    }
    return pairs.length ? pairs : null;
  };

  window.TypeRCJK = { has, wide, breaksBetween, breaksOf, orientationOf, pairsOf, NO_START, NO_END };
})();
