// The engine of TypeR: Web Version, a small Photoshop. The real TypeR panel
// runs in an iframe (web/panel, a copy of TypeR's own build) and calls this file
// exactly like it calls Photoshop through ExtendScript: same function names, same
// JSON. The smart paste engine itself runs inside the panel, untouched. What lives
// here is what Photoshop does for it: documents, real layers, selections, a Magic
// Wand, a work path, text measuring, painting and a history.

(function () {
  "use strict";

  const EVENT_SET = 1936028772; // 'setd'
  const EVENT_SELECT = 1936483188; // 'slct'
  const EVENT_MOVE = 1836021349; // 'move'
  const EVENT_HISTORY = 1751737445; // any other event: the panel checks the history
  const EXTENSION_ID = "com.typer.web";

  const Fonts = window.TypeRFonts;
  const FONTS = Fonts.BUILTIN;
  const MAX_HISTORY = 150;

  const measureCanvas = document.createElement("canvas");
  const measureCtx = measureCanvas.getContext("2d");

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const rectFrom = (left, top, right, bottom) => ({
    left, top, right, bottom,
    width: right - left,
    height: bottom - top,
    xMid: (left + right) / 2,
    yMid: (top + bottom) / 2,
  });

  /* ============================== text ============================== */

  // Photoshop's Faux Bold sets each letter 0.027 of the size wider, the last one of a line too
  // (measured in Photoshop 2026, in 3 fonts at 16 and 40 px)
  const FAUX_BOLD_SPACING = 0.027;
  // The space set between a run's letters, besides their kerning, in parts of the size
  const spacingOf = (textStyle) => (textStyle.tracking || 0) / 1000 + (textStyle.syntheticBold ? FAUX_BOLD_SPACING : 0);

  // `upright`: for a character that stands upright in a vertical text (see uprightGlyph)
  const cssFont = (textStyle, sizePx, upright) => {
    const font = Fonts.resolve(textStyle);
    const italic = font.italic || textStyle.syntheticItalic;
    // Faux Bold keeps the font's own face, as Photoshop does: its letters are outlined (see
    // boldWidthOf), where weight 700 would take the family's Bold face or the browser's bold
    const weight = font.weight;
    // Standard ligatures off, or Contextual alternates as the style has them: a twin of the font
    // (see variantOf in fonts.js)
    const family = (upright ? Fonts.verticalOf(font) : Fonts.variantOf(font, textStyle.ligature !== false, textStyle.contextualLigatures !== false, spacingOf(textStyle) !== 0)) || font.css;
    return `${italic ? "italic " : ""}${weight} ${sizePx}px "${family}", "Wildjess", sans-serif`;
  };

  // With Strong it outlines the font's own letters in their colour, as much of the size wide
  // (half of it outside them), whatever the font and its weight. So does Smooth from 26 px up,
  // about a pixel wide whatever the size: 1.2 px at 100 px in each of 60 fonts, where the
  // browser's own bold draws 3.1 (measured in Photoshop 2026 on text made in Photoshop: 3 fonts
  // from 10 to 100 px in each anti-aliasing method, Arial and Wildjess from 8 to 150 px).
  const FAUX_BOLD_WIDTH = 0.027;
  const FAUX_BOLD_SMOOTH_FROM = 26;
  const FAUX_BOLD_SMOOTH_WIDTH = 1.15;
  // Everywhere else (Crisp, Sharp and None at any size, Smooth below 26 px) Faux Bold is no
  // outline: each letter is drawn again to its right and below, by quarters of a pixel. Its left
  // and top edges stay where the Regular's are, its right edge goes a quarter further at 12, 21,
  // 30 and 39 px (0.25 px from 8 to 11 px, 0.5 from 12 to 20, 2.75 at 100), its bottom edge at
  // 25, 37.5, 50 px (0.25 px up to 24 px, 2 at 100). Measured in Photoshop 2026 on the edges of
  // an "I" from 8 to 150 px in Arial and Wildjess; against the outline all round, the letters
  // come 2 to 4 times closer to Photoshop's pixels in 6 fonts from 9 to 100 px.
  const fauxBoldRight = (sizePx) => Math.max(1, Math.round(sizePx / 9 + 1 / 6)) / 4;
  const fauxBoldDown = (sizePx) => Math.max(1, Math.floor(sizePx / 12.5)) / 4;
  // Extra Bold, TypeR's own, over Faux Bold: the letters outlined in their own colour, this much
  // of the size wide (half of it outside them), as the PSD keeps it in the text itself (its
  // characters' stroke, which Photoshop draws but has no control for). The letters keep their
  // places: Photoshop's outline makes them no wider. A wider outline replaces Faux Bold's own,
  // it isn't added to it (measured in Photoshop 2026): about twice as bold.
  const EXTRA_BOLD_WIDTH = 0.06;
  const extraBoldOf = (textStyle) => Boolean(textStyle && textStyle.syntheticBold && textStyle.extraBold);
  // How wide the outline that makes a run bold is, in the run's own pixels: 0 for a plain run
  const boldWidthOf = (textStyle, sizePx, antiAlias) => {
    if (!textStyle.syntheticBold) return 0;
    if (extraBoldOf(textStyle)) return EXTRA_BOLD_WIDTH * sizePx;
    if (antiAlias === "antiAliasStrong") return FAUX_BOLD_WIDTH * sizePx;
    const smooth = antiAlias !== "antiAliasCrisp" && antiAlias !== "antiAliasSharp" && antiAlias !== "antiAliasNone";
    return smooth && sizePx >= FAUX_BOLD_SMOOTH_FROM ? FAUX_BOLD_SMOOTH_WIDTH : 0;
  };
  // How a run is made heavier than its font's letters: `around`, an outline that wide in the
  // run's own pixels (Faux Bold's or Extra Bold's), `page`, one that wide in the page's pixels
  // (the anti-aliasing method's, see emboldenOf), `right` and `down`, the letters drawn again
  // that far, in the page's pixels (Faux Bold outside Strong)
  const weightOf = (textStyle, sizePx, antiAlias) => {
    const around = boldWidthOf(textStyle, sizePx, antiAlias);
    // Under Extra Bold's outline Strong adds half as much (measured in Photoshop 2026)
    const page = emboldenOf(antiAlias, textStyle, sizePx) * (extraBoldOf(textStyle) ? 1 : 2);
    const smeared = textStyle.syntheticBold && !around;
    return { around, page, right: smeared ? fauxBoldRight(sizePx) : 0, down: smeared ? fauxBoldDown(sizePx) : 0 };
  };
  const setRunFont = (ctx, textStyle, sizePx, upright) => {
    ctx.font = cssFont(textStyle, sizePx, upright);
    // An upright character of a vertical text takes its spacing below it, not inside it
    const spacing = upright ? 0 : spacingOf(textStyle);
    if ("letterSpacing" in ctx) ctx.letterSpacing = spacing ? `${spacing * sizePx}px` : "0px";
    if ("fontKerning" in ctx) ctx.fontKerning = textStyle.autoKern === "manual" ? "none" : "normal";
    if ("fontVariantCaps" in ctx) ctx.fontVariantCaps = textStyle.fontCaps === "smallCaps" ? "small-caps" : "normal";
    if ("lang" in ctx) ctx.lang = languageTagOf(textStyle);
  };

  const sizePxOf = (textStyle, resolution) => ((textStyle.impliedFontSize || textStyle.size || 14) * resolution) / 72;

  // Photoshop's text languages: the name a layer gives them, the number a PSD file gives
  // them (both read back from Photoshop) and how the language writes itself. A file numbers
  // a text's language twice, in the layer's own data and in the document's text block (see
  // textBlockOut in psd.js), which Photoshop believes first: the fourth is the block's
  // number where it isn't the layer's.
  const TEXT_LANGUAGES = [
    ["englishLanguage", 0, "English (US)"], ["ukenglishLanguage", 14, "English (UK)"], ["standardFrenchLanguage", 2, "Français"], ["canadianFrenchLanguage", 3, "Français (Canada)"],
    ["spanishLanguage", 12, "Español"], ["italianLanguage", 7, "Italiano"], ["germanLanguageReformed1996", 4, "Deutsch"], ["oldGermanLanguage", 5, "Deutsch (1901)"], ["swissGermanLanguageOldRules", 6, "Deutsch (Schweiz)"],
    ["standardPortugueseLanguage", 10, "Português"], ["brazilianPortugueseLanguage", 11, "Português (Brasil)"], ["kdutchLanguageOldRules", 15, "Nederlands"], ["catalanLanguage", 17, "Català"],
    ["danishLanguage", 16, "Dansk"], ["swedishLanguage", 13, "Svenska"], ["bokmalNorwegianLanguage", 8, "Norsk bokmål"], ["nynorskNorwegianLanguage", 9, "Norsk nynorsk"], ["finnishLanguage", 1, "Suomi"], ["icelandicLanguage", 27, "Íslenska"],
    ["polishLanguage", 23, "Polski"], ["czechLanguage", 22, "Čeština"], ["slovakLanguage", 36, "Slovenčina", 38], ["hungarianLanguage", 28, "Magyar"], ["romanianLanguage", 24, "Română"], ["croatianLanguage", 29, "Hrvatski", 31], ["slovenianLanguage", 31, "Slovenščina", 33],
    ["lithuanianLanguage", 34, "Lietuvių", 36], ["latvianLanguage", 35, "Latviešu", 37], ["turkishLanguage", 26, "Türkçe"], ["greekLanguage", 25, "Ελληνικά"], ["russianLanguage", 18, "Русский"], ["ukranianLanguage", 19, "Українська"], ["bulgarianLanguage", 20, "Български"], ["serbianLanguage", 21, "Српски"],
    ["arabicLanguage", 37, "العربية", 39], ["hebrewLanguage", 30, "עברית", 32],
  ];
  const INTERFACE_TEXT_LANGUAGE = { fr: "standardFrenchLanguage", es: "spanishLanguage", it: "italianLanguage", de: "germanLanguageReformed1996", pt: "brazilianPortugueseLanguage", ru: "russianLanguage", uk: "ukranianLanguage", pl: "polishLanguage", nl: "kdutchLanguageOldRules", tr: "turkishLanguage", ar: "arabicLanguage" };
  const DEFAULT_TEXT_LANGUAGE = INTERFACE_TEXT_LANGUAGE[window.TYPER_I18N.lang] || "englishLanguage";
  // Other names Photoshop gives the same languages, in styles made by the plugin
  // The same languages as the browser names them. A font made for several languages draws some
  // letters its own way in one of them, as a Turkish i that keeps its dot in a capitals-only
  // font: the text's language tells it which.
  const LANGUAGE_TAGS = {
    englishLanguage: "en-US", ukenglishLanguage: "en-GB", standardFrenchLanguage: "fr", canadianFrenchLanguage: "fr-CA", spanishLanguage: "es", italianLanguage: "it",
    germanLanguageReformed1996: "de", oldGermanLanguage: "de", swissGermanLanguageOldRules: "de-CH", standardGermanLanguage: "de", swissGermanLanguage: "de-CH",
    standardPortugueseLanguage: "pt-PT", brazilianPortugueseLanguage: "pt-BR", kdutchLanguageOldRules: "nl", dutchLanguage: "nl", catalanLanguage: "ca", danishLanguage: "da",
    swedishLanguage: "sv", bokmalNorwegianLanguage: "nb", nynorskNorwegianLanguage: "nn", finnishLanguage: "fi", icelandicLanguage: "is", polishLanguage: "pl", czechLanguage: "cs",
    slovakLanguage: "sk", hungarianLanguage: "hu", romanianLanguage: "ro", croatianLanguage: "hr", slovenianLanguage: "sl", lithuanianLanguage: "lt", latvianLanguage: "lv",
    turkishLanguage: "tr", greekLanguage: "el", russianLanguage: "ru", ukranianLanguage: "uk", bulgarianLanguage: "bg", serbianLanguage: "sr", arabicLanguage: "ar", hebrewLanguage: "he",
  };
  // A text with no language is in the language of new text, as the Character panel shows it
  // and as it is saved: drawn, put in capitals and hyphenated the same way everywhere
  const languageOf = (textStyle) => (textStyle && textStyle.textLanguage) || app.textDefaults.language;
  const languageTagOf = (textStyle) => LANGUAGE_TAGS[languageOf(textStyle)] || "en";
  const TEXT_LANGUAGE_NUMBERS = TEXT_LANGUAGES.reduce((numbers, [name, number]) => Object.assign(numbers, { [name]: number }), { standardGermanLanguage: 4, swissGermanLanguage: 6, dutchLanguage: 15 });
  const textLanguageNumber = (name) => {
    const number = TEXT_LANGUAGE_NUMBERS[name];
    return number === undefined ? TEXT_LANGUAGE_NUMBERS[app.textDefaults.language] : number;
  };
  const textLanguageName = (number) => {
    const language = TEXT_LANGUAGES.find((item) => item[1] === number);
    return language ? language[0] : undefined;
  };
  // The block has a number of its own for the three names the layer's data folds into others
  const TEXT_LANGUAGE_BLOCK_NUMBERS = TEXT_LANGUAGES.reduce((numbers, [name, number, , block]) => Object.assign(numbers, { [name]: block === undefined ? number : block }), { standardGermanLanguage: 42, swissGermanLanguage: 44, dutchLanguage: 43 });
  const textLanguageBlockNumber = (name) => {
    const number = TEXT_LANGUAGE_BLOCK_NUMBERS[name];
    return number === undefined ? TEXT_LANGUAGE_BLOCK_NUMBERS[app.textDefaults.language] : number;
  };

  // A zero-width non-joiner between two letters also stops ligatures, where the browser can't
  // turn a font's off (see variantOf in fonts.js), and leaves their kerning alone.
  // It doesn't stop the letter variants a font keeps with its ligatures. Other scripts need
  // their letters joined.
  // All Caps follows the text language, as in Photoshop: in Turkish, i becomes İ, not I
  const CASE_LOCALES = { turkishLanguage: "tr" };
  const shownText = ({ text, style }) => {
    const locale = CASE_LOCALES[languageOf(style)];
    const cased = style.fontCaps === "allCaps" ? (locale ? text.toLocaleUpperCase(locale) : text.toUpperCase()) : text;
    return style.ligature === false ? cased.replace(/(\p{Script=Latin})(?=\p{Script=Latin})/gu, "$1‌") : cased;
  };

  // A letter with the marks it carries (a Thai consonant with its vowel and its tone mark, an
  // "e" with a combining accent, an emoji made of several) is one letter to the reader: it is
  // measured, kerned, cut and stepped over whole, or the marks would be set as letters of their
  // own, off their base. Most texts have none: they aren't looked into.
  const HAS_CLUSTERS = /[\p{M}‍ำຳ]|[\u{10000}-\u{10FFFF}]/u;
  // What never stands without the letter before it: a mark, or the second half of an emoji
  const CARRIED = /[\p{M}ำຳ\uDC00-\uDFFF]/u;
  const segmenters = new Map();
  const segmenterOf = (granularity, locale) => {
    const key = granularity + "|" + (locale || "");
    if (!segmenters.has(key)) {
      let made = null;
      try {
        made = window.Intl && Intl.Segmenter ? new Intl.Segmenter(locale, { granularity }) : null;
      } catch (error) {
        made = null;
      }
      segmenters.set(key, made);
    }
    return segmenters.get(key);
  };
  const lettersOf = (text) => {
    const segmenter = HAS_CLUSTERS.test(text) ? segmenterOf("grapheme") : null;
    return segmenter ? Array.from(segmenter.segment(text), (part) => part.segment) : Array.from(text);
  };
  // Where a text can be cut between two letters: every index of a plain text (null), else the
  // start of each letter and the text's end
  const letterStartsOf = (text) => {
    if (!HAS_CLUSTERS.test(text)) return null;
    const starts = new Set([text.length]);
    let at = 0;
    lettersOf(text).forEach((letter) => {
      starts.add(at);
      at += letter.length;
    });
    return starts;
  };

  // Thai, Lao, Khmer and Burmese put no space between the words of a sentence: a line breaks
  // between two words, which only a dictionary tells apart (the browser's own, the one that
  // wraps a web page in these languages). No hyphen is added there. Photoshop's Latin
  // composers know none of this; its World-Ready ones break these scripts the same way.
  const UNSPACED_SCRIPTS = [["th", /\p{Script=Thai}/u], ["lo", /\p{Script=Lao}/u], ["km", /\p{Script=Khmer}/u], ["my", /\p{Script=Myanmar}/u]];
  const UNSPACED = /[\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
  // What never starts a line: the repetition and abbreviation signs and the marks that end a
  // sentence, which stay with the word before them
  const UNSPACED_NO_START = /[ฯๆ๚๛ຯໆ។-៚၊။]/;
  const unspaced = (ch) => Boolean(ch) && UNSPACED.test(ch);
  // Chinese and Japanese put none either, and a line breaks between any two of their
  // characters, but never before a mark that closes or after one that opens (see cjk.js)
  const CJK = window.TypeRCJK;
  const breaksUnspaced = (before, after) => unspaced(before) && unspaced(after) && !UNSPACED_NO_START.test(after[0]);
  // Whether a line can end between these two letters with nothing added: both of a script
  // written without spaces
  const breaksBare = (before, after) => breaksUnspaced(before, after) || CJK.breaksBetween(before, after);
  // The places inside a text where a line can break without a space: null when it has none
  const softBreaksOf = (text) => {
    const wide = CJK.breaksOf(text);
    const starts = wide || UNSPACED.test(text) ? letterStartsOf(text) : null;
    // Never inside a letter and the marks it carries
    if (wide && starts) wide.forEach((at) => { if (!starts.has(at)) wide.delete(at); });
    const script = UNSPACED.test(text) && UNSPACED_SCRIPTS.find((item) => item[1].test(text));
    const segmenter = script ? segmenterOf("word", script[0]) : null;
    if (!segmenter) return wide && wide.size ? wide : null;
    const breaks = wide || new Set();
    for (const part of segmenter.segment(text)) {
      const at = part.index;
      if (at > 0 && (!starts || starts.has(at)) && breaksUnspaced(String.fromCodePoint(text.codePointAt(at - 1)), String.fromCodePoint(text.codePointAt(at)))) breaks.add(at);
    }
    return breaks.size ? breaks : null;
  };
  // Where a double-click's word ends in such a text: at the words a dictionary finds in
  // Chinese and Japanese, where a line could break between any two characters
  const wordCutsOf = (text) => {
    if (!CJK.has(text)) return softBreaksOf(text);
    const segmenter = segmenterOf("word", /[\u3040-\u30FF]/.test(text) ? "ja" : "zh");
    if (!segmenter) return softBreaksOf(text);
    const cuts = new Set();
    for (const part of segmenter.segment(text)) if (part.index > 0) cuts.add(part.index);
    return cuts.size ? cuts : null;
  };

  // A vertical text, as Photoshop's Vertical Type: its lines run from top to bottom and follow
  // each other from right to left. It is set as a horizontal text is, each line with its
  // letters along x and its baseline at a y, then turned a quarter clockwise around its anchor:
  // what was the top of a line faces right. Its Chinese and Japanese characters, and by default
  // its Latin letters too, are then stood upright again, each in its own square. Measured in
  // Photoshop 2026 (PingFang SC, Songti SC and Arial at 40 px): a line set this way lands on
  // Photoshop's to the pixel, its first baseline as far from the right edge of a box as a
  // horizontal one is from the top.
  const verticalOf = (lt) => Boolean(lt && lt.textShape && lt.textShape[0] && lt.textShape[0].orientation === "vertical");
  // A run of a line, of the same kind as `like` (a vertical text's runs say so)
  const runOf = (text, style, like) => (like && like.vertical ? { text, style, vertical: true } : { text, style });

  // textKey -> lines, each with its runs (a run: text and the style of its range)
  const splitLines = (layerText) => {
    const text = layerText.textKey || "";
    const ranges = layerText.textStyleRange || [];
    const styleAt = (index) => {
      for (let i = 0; i < ranges.length; i++) {
        if (index >= ranges[i].from && index < ranges[i].to) return ranges[i].textStyle;
      }
      return ranges.length ? ranges[ranges.length - 1].textStyle : {};
    };
    const lines = [];
    let current = [];
    let run = null;
    const like = verticalOf(layerText) ? { vertical: true } : null;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "\r" || ch === "\n") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        lines.push(current);
        current = [];
        run = null;
        continue;
      }
      const style = styleAt(i);
      // A mark styled apart from the letter that carries it (kerning set by hand before a Thai
      // letter goes on its consonant alone) is drawn with it, in the letter's style
      if (run && (run.style === style || CARRIED.test(ch))) run.text += ch;
      else {
        run = runOf(ch, style, like);
        current.push(run);
      }
    }
    lines.push(current);
    return lines;
  };

  // Kerning set by hand between two letters is kept, as Photoshop keeps it, on the second one:
  // the space before it, in thousandths of an em. That pair loses the font's own kerning.
  const kernBefore = (style, size) => (style.kerning ? (style.kerning / 1000) * size : 0);
  // Two runs whose letters are drawn alike: the font kerns the pair where they meet
  const sameLetters = (a, b, resolution) => cssFont(a, 10) === cssFont(b, 10) && sizePxOf(a, resolution) === sizePxOf(b, resolution) && (a.horizontalScale || 100) === (b.horizontalScale || 100) && a.fontCaps === b.fontCaps && languageOf(a) === languageOf(b);
  // Photoshop's default tab stops: every 36 of its text units from the start of the line, pixels
  // of the page whatever its resolution (measured at 72 and 300 ppi)
  const TAB_STOP = 36;

  // How a character stands upright in a vertical line, in parts of the size: `w` its width,
  // `left`, `right`, `rise` and `fall` how far its ink goes from its origin, `base` how far
  // below the top of its square its baseline is, `dx` and `dy` where it is moved to. With
  // `turn`, it lies on its side instead, as a Latin letter of a rotated run does.
  // - The square is one size high, whatever the font: Photoshop sets Arial's letters 1 em
  //   apart too. The baseline is where the font's own squares put it: the middle of the ink
  //   of a few full ideographs, which every Chinese and Japanese font has, gives the middle
  //   of the square (0.86 of the size below its top in PingFang SC, 0.80 in Songti SC, 0.88
  //   in Hiragino Sans: as Photoshop sets them, to a quarter of a pixel at 40 px). A font
  //   without ideographs has its capitals half way up the square, as Photoshop sets them.
  // - The font draws the character its vertical way (see verticalOf in fonts.js). A font
  //   that has no such form, or a character the browser takes from another font, gets what
  //   Unicode says of it (see cjk.js): a bracket, a long vowel mark, a dash or an ellipsis
  //   is turned, a comma or a full stop that sits in the bottom left of its square goes to
  //   the top right.
  const FULL_IDEOGRAPHS = "\u7B2C\u916C\u58A8\u9F0E\u91CF\u610F";
  const MOVED_UPRIGHT = new Set(Array.from("\u3001\u3002\uFF0C\uFF0E"));
  const TURNED_DASHES = new Set(Array.from("\u2014\u2015\u2026\u2025"));
  const uprightBases = new Map();
  // `wide`: for a Chinese or Japanese character, which the browser may take from another font
  const uprightBaseOf = (textStyle, wide) => {
    const css = cssFont(textStyle, INK_SIZE);
    const key = Fonts.generation + "|" + css + "|" + (wide ? 1 : 0);
    if (!uprightBases.has(key)) {
      if (uprightBases.size > 500) uprightBases.clear();
      const own = ownGlyph(textStyle, FULL_IDEOGRAPHS[0]);
      let base;
      if (own || wide) {
        measureCtx.font = css;
        const m = measureCtx.measureText(FULL_IDEOGRAPHS);
        const high = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
        base = high > INK_SIZE * 0.5 ? 0.5 + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2 / INK_SIZE : 0.88;
      } else base = boundsSharesOf(textStyle).rise;
      uprightBases.set(key, { base });
    }
    return uprightBases.get(key);
  };
  const uprightGlyphs = new Map();
  const uprightGlyph = (textStyle, shown) => {
    const upright = cssFont(textStyle, INK_SIZE, true);
    const key = Fonts.generation + "|" + upright + "|" + languageTagOf(textStyle) + "|" + (textStyle.fontCaps === "smallCaps" ? 1 : 0) + "|" + shown;
    let glyph = uprightGlyphs.get(key);
    if (!glyph) {
      if (uprightGlyphs.size > 20000) uprightGlyphs.clear();
      const first = String.fromCodePoint(shown.codePointAt(0));
      const single = first.length === shown.length || lettersOf(shown).length === 1;
      const wide = CJK.wide(first);
      const { base } = uprightBaseOf(textStyle, wide);
      const measure = (isUpright) => {
        setRunFont(measureCtx, textStyle, INK_SIZE, isUpright);
        if (!isUpright && "letterSpacing" in measureCtx) measureCtx.letterSpacing = "0px";
        measureCtx.textAlign = "left";
        return measureCtx.measureText(shown);
      };
      const m = measure(true);
      glyph = { w: m.width / INK_SIZE, left: m.actualBoundingBoxLeft / INK_SIZE, right: m.actualBoundingBoxRight / INK_SIZE, rise: m.actualBoundingBoxAscent / INK_SIZE, fall: m.actualBoundingBoxDescent / INK_SIZE, base, dx: 0, dy: 0, turn: false };
      const way = single ? CJK.orientationOf(first) : "U";
      if (single && (way !== "U" || TURNED_DASHES.has(first))) {
        // Whether the font drew it another way for a vertical line
        const plain = upright === cssFont(textStyle, INK_SIZE) ? m : measure(false);
        const formed = plain !== m && ["actualBoundingBoxLeft", "actualBoundingBoxRight", "actualBoundingBoxAscent", "actualBoundingBoxDescent"].some((side) => Math.abs(plain[side] - m[side]) > INK_SIZE * 0.002);
        if (!formed && (way === "Tr" || TURNED_DASHES.has(first))) {
          glyph.turn = true;
          // A dash or an ellipsis drawn for a horizontal line sits on the baseline or above
          // it: turned, it goes to the middle of the line (`lift`, how far up from where it is)
          if (TURNED_DASHES.has(first)) glyph.lift = base - 0.5 - (plain.actualBoundingBoxAscent - plain.actualBoundingBoxDescent) / 2 / INK_SIZE;
        }
        else if (!formed && MOVED_UPRIGHT.has(first) && glyph.w > 0) {
          // The middle of its ink, in its square: from the bottom left to the top right
          const cx = (glyph.right - glyph.left) / 2 / glyph.w;
          const cy = base + (glyph.fall - glyph.rise) / 2;
          if (cx < 0.4 && cy > 0.6) {
            glyph.dx = (1 - 2 * cx) * glyph.w;
            glyph.dy = 1 - 2 * cy;
          }
        }
      }
      uprightGlyphs.set(key, glyph);
    }
    return glyph;
  };
  // The letters, digits and punctuation of a run set to Photoshop's "rotated" (Standard
  // Vertical Roman Alignment off) lie on their side: Latin, Greek, Cyrillic and the like.
  // Not the full-width forms, nor the dashes and ellipses of a Chinese font, which
  // Photoshop 2026 leaves as they are in such a run.
  const liesRotated = (ch) => ch.codePointAt(0) < 0x2000 && CJK.orientationOf(ch) === "R";
  // A run of a vertical line in pieces: `side`, a stretch that lies on its side, set as in a
  // horizontal line (a space, as in Photoshop, takes its own width); `pair`, characters set
  // side by side in one square (Photoshop's Tate-Chu-Yoko: a run set to "cross", or a pair
  // found by pairsOf in cjk.js); else one upright character.
  const columnPieces = (run) => {
    const { text, style } = run;
    if (style.baselineDirection === "cross" && !/[\t]/.test(text)) return [{ text, pair: true }];
    const rotated = style.baselineDirection === "rotated";
    const pairs = rotated ? null : CJK.pairsOf(text);
    const pieces = [];
    let side = "";
    const flush = () => {
      if (side) pieces.push({ text: side, side: true });
      side = "";
    };
    let at = 0;
    let pair = pairs ? 0 : -1;
    const letters = lettersOf(text);
    for (let k = 0; k < letters.length; k++) {
      const ch = letters[k];
      if (pair >= 0 && pair < pairs.length && pairs[pair][0] === at && k + 1 < letters.length) {
        flush();
        pieces.push({ text: text.slice(pairs[pair][0], pairs[pair][1]), pair: true });
        at = pairs[pair][1];
        pair++;
        k++;
        continue;
      }
      if (ch === "\t") {
        flush();
        pieces.push({ text: ch });
      } else if (ch === " " || ch === "\u00A0" || (rotated && liesRotated(ch))) side += ch;
      else {
        const glyph = uprightGlyph(style, shownText({ text: ch, style }));
        if (glyph.turn && !glyph.lift) side += ch;
        else {
          flush();
          pieces.push(glyph.turn ? { text: ch, side: true, lift: glyph.lift } : { text: ch });
        }
      }
      at += ch.length;
    }
    flush();
    return pieces;
  };
  // Where a vertical text sets characters side by side on its own (the pairs columnPieces
  // finds): the stretches of its text, each [from, to), for a file to say so as Photoshop does
  const pairsOfText = (lt) => {
    const out = [];
    if (!verticalOf(lt)) return out;
    const breaks = String(lt.textKey || "").split(/(\r\n|[\r\n])/);
    let index = 0;
    splitLines(lt).forEach((runs, k) => {
      runs.forEach((run) => {
        if (run.style.baselineDirection !== "cross" && run.style.baselineDirection !== "rotated") {
          let offset = 0;
          columnPieces(run).forEach((piece) => {
            if (piece.pair) out.push([index + offset, index + offset + piece.text.length]);
            offset += piece.text.length;
          });
        }
        index += run.text.length;
      });
      index += (breaks[k * 2 + 1] || "").length;
    });
    return out;
  };
  // A vertical line, measured along it as a horizontal one is: `advance` is how long it is,
  // `ascent` and `descent` how far its ink goes to its right and to its left on the page
  // `stops`: filled with how far along the line the caret is after each character of its
  // text (inside characters set side by side, where they start)
  const measureColumn = (runs, resolution, stops) => {
    let index = 0;
    if (stops) stops[0] = 0;
    const stopAt = (from, to, inside, end) => {
      if (!stops) return;
      for (let k = from + 1; k < to; k++) stops[k] = inside;
      stops[to] = end;
    };
    let advance = 0;
    let ascent = -Infinity;
    let descent = -Infinity;
    let inkLeft = Infinity;
    let inkRight = -Infinity;
    let fontAscent = 0;
    let fontDescent = 0;
    const placed = [];
    runs.forEach((run) => {
      const size = sizePxOf(run.style, resolution);
      const scaleX = (run.style.horizontalScale || 100) / 100;
      const scaleY = (run.style.verticalScale || 100) / 100;
      const shift = ((run.style.impliedBaselineShift !== undefined ? run.style.impliedBaselineShift : run.style.baselineShift) || 0) * (resolution / 72);
      const spacing = spacingOf(run.style) * size;
      const kern = kernBefore(run.style, size);
      if (kern && (placed.length || advance)) advance += kern;
      columnPieces(run).forEach((piece) => {
        const from = index;
        index += piece.text.length;
        if (piece.text === "\t") {
          advance = (Math.floor(advance / TAB_STOP + 1e-6) + 1) * TAB_STOP;
          stopAt(from, index, advance, advance);
          return;
        }
        const shown = shownText({ text: piece.text, style: run.style });
        if (piece.side) {
          setRunFont(measureCtx, run.style, size);
          measureCtx.textAlign = "left";
          const m = measureCtx.measureText(shown);
          if (stops) {
            let at = 0;
            lettersOf(piece.text).forEach((letter) => {
              at += letter.length;
              stopAt(from + at - letter.length, from + at, advance, advance + measureCtx.measureText(shownText({ text: piece.text.slice(0, at), style: run.style })).width * scaleX);
            });
          }
          const lifted = shift + (piece.lift || 0) * size;
          placed.push({ run, shown, x: advance, size, scaleX, scaleY, shift: lifted });
          inkLeft = Math.min(inkLeft, advance - m.actualBoundingBoxLeft * scaleX);
          inkRight = Math.max(inkRight, advance + m.actualBoundingBoxRight * scaleX);
          advance += m.width * scaleX;
          ascent = Math.max(ascent, m.actualBoundingBoxAscent * scaleY + lifted);
          descent = Math.max(descent, m.actualBoundingBoxDescent * scaleY - lifted);
          const axis = (uprightBaseOf(run.style, false).base - 0.5) * size;
          fontAscent = Math.max(fontAscent, axis + size * 0.5);
          fontDescent = Math.max(fontDescent, size * 0.5 - axis);
          return;
        }
        const glyph = uprightGlyph(run.style, shown);
        // How far above the line's baseline the middle of the square is
        const axis = (glyph.base - 0.5) * size;
        placed.push({ run, shown, x: advance, size, scaleX, scaleY, shift, upright: glyph });
        inkLeft = Math.min(inkLeft, advance + (glyph.base + glyph.dy - glyph.rise) * size * scaleY);
        inkRight = Math.max(inkRight, advance + (glyph.base + glyph.dy + glyph.fall) * size * scaleY);
        ascent = Math.max(ascent, shift + axis + (glyph.dx + glyph.right - glyph.w / 2) * size * scaleX);
        descent = Math.max(descent, (glyph.w / 2 + glyph.left - glyph.dx) * size * scaleX - shift - axis);
        fontAscent = Math.max(fontAscent, axis + size * scaleX * 0.5);
        fontDescent = Math.max(fontDescent, size * scaleX * 0.5 - axis);
        stopAt(from, index, advance, advance + size * scaleY + spacing);
        advance += size * scaleY + spacing;
      });
    });
    if (!placed.length) return { advance, ascent: 0, descent: 0, inkLeft: 0, inkRight: 0, fontAscent, fontDescent, placed };
    return { advance, ascent, descent, inkLeft, inkRight, fontAscent, fontDescent, placed };
  };

  const measureRuns = (runs, resolution) => {
    if (runs.length && runs[0].vertical) return measureColumn(runs, resolution);
    let advance = 0;
    let ascent = 0;
    let descent = 0;
    let inkLeft = Infinity;
    let inkRight = -Infinity;
    let fontAscent = 0;
    let fontDescent = 0;
    const placed = [];
    runs.forEach((run, index) => {
      const size = sizePxOf(run.style, resolution);
      setRunFont(measureCtx, run.style, size);
      measureCtx.textAlign = "left";
      const scaleX = (run.style.horizontalScale || 100) / 100;
      const scaleY = (run.style.verticalScale || 100) / 100;
      const shift = ((run.style.impliedBaselineShift !== undefined ? run.style.impliedBaselineShift : run.style.baselineShift) || 0) * (resolution / 72);
      // Drawn apart, the letter kerned by hand and the one after it would lose the font's kerning
      // of their pair: it is added back
      const before = runs[index - 1];
      if (before && before.style.kerning && !run.style.kerning && run.style.autoKern !== "manual" && before.text && run.text && sameLetters(before.style, run.style, resolution)) {
        const left = shownText({ text: before.text.slice(-1), style: run.style });
        const right = shownText({ text: run.text[0], style: run.style });
        advance += (measureCtx.measureText(left + right).width - measureCtx.measureText(left).width - measureCtx.measureText(right).width) * scaleX;
      }
      // Each letter kerned by hand is drawn on its own, after its space (none at a line's start).
      // A tab draws nothing: what follows it starts at the next stop.
      const kern = kernBefore(run.style, size);
      (kern ? lettersOf(run.text) : run.text.includes("\t") ? run.text.split(/(\t)/).filter(Boolean) : [run.text]).forEach((text) => {
        if (kern && (placed.length || advance)) advance += kern;
        if (text === "\t") {
          advance = (Math.floor(advance / TAB_STOP + 1e-6) + 1) * TAB_STOP;
          return;
        }
        const shown = shownText({ text, style: run.style });
        const m = measureCtx.measureText(shown);
        placed.push({ run, shown, x: advance, size, scaleX, scaleY, shift });
        inkLeft = Math.min(inkLeft, advance - m.actualBoundingBoxLeft * scaleX);
        inkRight = Math.max(inkRight, advance + m.actualBoundingBoxRight * scaleX);
        advance += m.width * scaleX;
        ascent = Math.max(ascent, m.actualBoundingBoxAscent * scaleY + shift);
        descent = Math.max(descent, m.actualBoundingBoxDescent * scaleY - shift);
        fontAscent = Math.max(fontAscent, (m.fontBoundingBoxAscent || m.actualBoundingBoxAscent) * scaleY);
        fontDescent = Math.max(fontDescent, (m.fontBoundingBoxDescent || m.actualBoundingBoxDescent) * scaleY);
      });
    });
    if (!runs.length) return { advance: 0, ascent: 0, descent: 0, inkLeft: 0, inkRight: 0, fontAscent: 0, fontDescent: 0, placed };
    return { advance, ascent, descent, inkLeft, inkRight, fontAscent, fontDescent, placed };
  };
  // The tracking after a line's last letter, which Photoshop leaves out of the line's width,
  // both to fit it and to align it: n letters take n - 1 trackings (measured in Photoshop 2026)
  const trailingTracking = (m) => {
    const last = m.placed[m.placed.length - 1];
    return last && last.run.style.tracking ? (last.run.style.tracking / 1000) * last.size * (last.upright ? 1 : last.scaleX) : 0;
  };

  // Paragraph text: the size of its box is in the shape, its top left in the click point
  const boxShape = (lt) => {
    const shape = lt.textShape && lt.textShape[0];
    return shape && shape.textType === "box" && shape.box ? shape : null;
  };

  const sliceRuns = (runs, from, to) => {
    const out = [];
    let at = 0;
    runs.forEach((run) => {
      const start = Math.max(from, at);
      const end = Math.min(to, at + run.text.length);
      if (end > start) out.push(runOf(run.text.slice(start - at, end - at), run.style, run));
      at += run.text.length;
    });
    return out;
  };

  // Auto hyphenation, as Photoshop's Hyphenate option of a paragraph: the patterns of the
  // text's language, loaded on first use (the page is drawn again once they are there)
  const HYPHEN_LANGUAGES = {
    englishLanguage: "en", ukenglishLanguage: "en", standardFrenchLanguage: "fr", canadianFrenchLanguage: "fr",
    germanLanguageReformed1996: "de", standardGermanLanguage: "de", oldGermanLanguage: "de", swissGermanLanguage: "de", swissGermanLanguageOldRules: "de",
    spanishLanguage: "es", italianLanguage: "it", standardPortugueseLanguage: "pt", brazilianPortugueseLanguage: "pt",
    russianLanguage: "ru", turkishLanguage: "tr", ukranianLanguage: "uk", polishLanguage: "pl",
  };
  // Each language's patterns while they load, then true once they are there or can't be
  const hyphenLoads = new Map();
  const loadHyphenation = (language) => {
    if (!hyphenLoads.has(language)) {
      hyphenLoads.set(language, window.TypeRHyphenation.load(language).then(() => Fonts.refresh && Fonts.refresh(), () => {}).then(() => {
        hyphenLoads.set(language, true);
      }));
    }
    const loading = hyphenLoads.get(language);
    return loading === true ? null : loading;
  };
  const hyphenLanguage = (style) => {
    const Hyphenation = window.TypeRHyphenation;
    const language = Hyphenation && HYPHEN_LANGUAGES[languageOf(style)];
    if (!language) return null;
    if (Hyphenation.isLoaded(language)) return language;
    loadHyphenation(language);
    return null;
  };
  // Photoshop's defaults, as it writes them and as they are saved: 2 letters at least on each
  // side, and no cut when the line would stop less than 36 short of the box without one. Its
  // word size of 6 cuts the words of paragraph text from 7 letters on (see wrapRuns).
  const hyphenRulesOf = (paragraph) => (paragraph && paragraph.hyphenate === true ? {
    wordSize: paragraph.hyphenateWordSize || 6,
    pre: paragraph.hyphenatePreLength || 2,
    post: paragraph.hyphenatePostLength || 2,
    capitalized: paragraph.hyphenateCapitalized !== false,
    zone: paragraph.hyphenationZone === undefined ? 36 : paragraph.hyphenationZone,
  } : null);

  // What Photoshop leaves out of a word's length when it asks whether the word is long enough
  // to be cut: the punctuation before and after it, but not an opening bracket before it
  const UNCOUNTED_BEFORE = /^[^\p{L}\p{M}\p{N}([{_/#&+=%¿¡]+/u;
  const UNCOUNTED_AFTER = /[^\p{L}\p{M}\p{N}_/#&+=%¿¡]+$/u;
  // Photoshop's French dictionary has no cut in these before their apostrophe: "jusqu'ici"
  // and "presqu'île" stay whole where the patterns give "jus-qu'ici", but "lors-qu'il" is cut
  const UNCUT_ELISIONS = /^(?:jus|pres|quel|puis|quoi)qu$/iu;

  // One line of a paragraph into lines that fit, where Photoshop breaks them (measured in
  // Photoshop 2026, on texts saved from here): the PSD says the text and its box, not its
  // lines, and Photoshop sets them again when the file is updated or the text edited there.
  // - A line breaks at its spaces only: a word with hyphens ("Orbia-san") stays whole, and a
  //   "?" after a space can start a line.
  // - A line fits by the width it is set at: without the spaces that end it, nor the tracking
  //   after its last letter, and with Roman Hanging Punctuation (`hanging`) without the
  //   punctuation that hangs out of the box.
  // - With Hyphenate on, a word that doesn't fit is cut with a hyphen at the last syllable that
  //   does: only a word longer than the word size, never next to its own hyphens or
  //   apostrophes, and not when the line without it already stops within the zone.
  // - A word wider than the box alone is cut at a syllable, or else between two letters.
  // - Thai, Lao, Khmer and Burmese, written without spaces, also break between two words
  //   (see softBreaksOf), with no hyphen.
  // - A letter is never cut from the marks it carries (see lettersOf).
  const wrapRuns = (runs, width, resolution, hyphenRules, hanging) => {
    const text = runs.map((run) => run.text).join("");
    const isGap = (ch) => ch === " " || ch === "\t";
    const soft = softBreaksOf(text);
    const starts = letterStartsOf(text);
    // The end of the letter that starts at `at`
    const letterEnd = (at) => {
      let end = at + 1;
      while (starts && end < text.length && !starts.has(end)) end++;
      return end;
    };
    const setWidth = (lineRuns) => {
      const m = measureRuns(lineRuns, resolution);
      const advance = m.advance - trailingTracking(m);
      if (!hanging) return advance;
      const [hangLeft, hangRight] = hangsOf(m);
      return advance - hangLeft - hangRight;
    };
    const fits = (from, to) => setWidth(sliceRuns(runs, from, to)) <= width;
    // Between two letters of a word, nothing hangs, and the letter that ends the line keeps
    // the kerning it has with the next one
    const fitsInside = (from, to) => measureRuns(sliceRuns(runs, from, to + 1), resolution).advance - measureRuns(sliceRuns(runs, to, to + 1), resolution).advance - trailingTracking(measureRuns(sliceRuns(runs, to - 1, to), resolution)) <= width;
    const withHyphen = (from, to) => {
      const out = sliceRuns(runs, from, to);
      const last = out[out.length - 1];
      if (last) out[out.length - 1] = runOf(last.text + "-", last.style, last);
      // The hyphen is drawn, but isn't in the text
      out.hyphenated = true;
      return out;
    };
    const lines = [];
    const pushLine = (from, to) => {
      let end = to;
      while (end > from && isGap(text[end - 1])) end--;
      const line = sliceRuns(runs, from, end);
      // No space was there to leave out: the next line follows this one's last letter
      if (end === to && to < text.length) line.bare = true;
      lines.push(line);
    };
    const lettersIn = (from, to) => (text.slice(from, to).match(/[\p{L}\p{N}]/gu) || []).length;
    // Where the word around `at`, which ends at `end`, can be cut with a hyphen so that the
    // line from `lineStart` fits, the latest such place; -1 when none
    const hyphenCut = (lineStart, at, end) => {
      if (!hyphenRules) return -1;
      let start = at;
      while (start > 0 && !isGap(text[start - 1])) start--;
      const word = text.slice(start, end);
      const counted = word.replace(UNCOUNTED_BEFORE, "").replace(UNCOUNTED_AFTER, "");
      if (Array.from(counted).length <= hyphenRules.wordSize) return -1;
      if (!hyphenRules.capitalized && /^\p{Lu}/u.test(counted)) return -1;
      // Each run of letters has its own syllables: none is cut next to a hyphen or an
      // apostrophe of the word ("aujourd'hui" cuts at "au-", not at "aujour-")
      const cuts = [];
      for (const part of word.matchAll(/[\p{L}\p{M}]+/gu)) {
        const from = start + part.index;
        const style = sliceRuns(runs, from, from + 1)[0];
        const language = hyphenLanguage(style && style.style);
        if (language === "fr" && UNCUT_ELISIONS.test(part[0]) && /^['’]/.test(text.slice(from + part[0].length))) continue;
        if (language) window.TypeRHyphenation.patternCuts(part[0], language).forEach((point) => cuts.push(from + point));
      }
      cuts.sort((a, b) => b - a);
      for (const cut of cuts) {
        if (cut <= lineStart || cut <= at || lettersIn(start, cut) < hyphenRules.pre || lettersIn(cut, end) < hyphenRules.post) continue;
        if (setWidth(withHyphen(lineStart, cut)) <= width) return cut;
      }
      return -1;
    };
    let lineStart = 0;
    let i = 0;
    while (i < text.length) {
      let end = i;
      while (end < text.length && !isGap(text[end]) && !(soft && end > i && soft.has(end))) end++;
      if (end > lineStart && !fits(lineStart, end)) {
        if (i > lineStart) {
          // The line has words already: this one is cut when the line would stop too short
          // without it, and goes whole to the next line otherwise
          let head = i;
          while (head > lineStart && isGap(text[head - 1])) head--;
          const cut = hyphenRules && width - setWidth(sliceRuns(runs, lineStart, head)) >= hyphenRules.zone ? hyphenCut(lineStart, i, end) : -1;
          if (cut > 0) lines.push(withHyphen(lineStart, cut));
          else pushLine(lineStart, i);
          lineStart = cut > 0 ? cut : i;
          i = lineStart;
          continue;
        }
        // The word starts the line and is wider than the box
        if (letterEnd(lineStart) < end) {
          let cut = hyphenCut(lineStart, i, end);
          if (cut > 0) lines.push(withHyphen(lineStart, cut));
          else {
            cut = letterEnd(lineStart);
            while (letterEnd(cut) < end && fitsInside(lineStart, letterEnd(cut))) cut = letterEnd(cut);
            pushLine(lineStart, cut);
          }
          lineStart = cut;
          i = cut;
          continue;
        }
      }
      i = end;
      while (isGap(text[i])) i++;
    }
    pushLine(lineStart, text.length);
    return lines;
  };

  // Photoshop's Roman Hanging Punctuation puts these outside the margins, wholly or by half
  const HANG_FULL = new Set([".", ",", "-", "\u2010", "'", "\"", "\u2018", "\u2019", "\u201C", "\u201D", "\u00AB", "\u00BB"]);
  const HANG_HALF = new Set(["*", "~", "\u2026", "\u2013", "\u2014", ":", ";"]);
  const hangShare = (ch) => (HANG_FULL.has(ch) ? 1 : HANG_HALF.has(ch) ? 0.5 : 0);
  // How far a line's first and last characters hang out
  const hangsOf = (m) => {
    const ends = [];
    [m.placed[0], m.placed[m.placed.length - 1]].forEach((item, end) => {
      const ch = item && (end ? item.shown.slice(-1) : item.shown[0]);
      const share = ch ? hangShare(ch) : 0;
      if (!share) return ends.push(0);
      setRunFont(measureCtx, item.run.style, item.size);
      ends.push(measureCtx.measureText(ch).width * item.scaleX * share);
    });
    return ends;
  };

  // Whether a font draws a character itself, or the browser takes it from another font:
  // the character comes out the same width whichever font follows it
  const glyphsSeen = new Map();
  const ownGlyph = (textStyle, ch) => {
    const css = Fonts.resolve(textStyle).css;
    const key = Fonts.generation + "|" + css + "|" + ch;
    if (!glyphsSeen.has(key)) {
      const widthWith = (next) => {
        measureCtx.font = `100px "${css}", ${next}`;
        return measureCtx.measureText(ch).width;
      };
      glyphsSeen.set(key, widthWith("monospace") === widthWith("serif"));
    }
    return glyphsSeen.get(key);
  };
  // How high a letter rises above the baseline, as a share of the size. Read on the letter
  // drawn at 1024 px, which the browser draws from its outline the same on every system:
  // what it measures instead comes out up to 1.5% higher on Windows, rounded up to pixels.
  const INK_SIZE = 1024;
  const inkTops = new Map();
  const inkTopOf = (textStyle, ch) => {
    const key = Fonts.generation + "|" + cssFont(textStyle, INK_SIZE) + "|" + languageTagOf(textStyle) + "|" + ch;
    if (!inkTops.has(key)) {
      setRunFont(measureCtx, textStyle, INK_SIZE);
      const m = measureCtx.measureText(ch);
      const left = Math.ceil(m.actualBoundingBoxLeft) + 8;
      const baseline = Math.ceil(m.actualBoundingBoxAscent) + 8;
      const canvas = newCanvas(left + Math.ceil(m.actualBoundingBoxRight) + 8, baseline + 8);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      setRunFont(ctx, textStyle, INK_SIZE);
      ctx.textBaseline = "alphabetic";
      ctx.fillText(ch, left, baseline);
      const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let top = baseline;
      for (let y = 0, found = false; y < baseline && !found; y++) {
        let most = 0;
        for (let i = y * canvas.width * 4 + 3; i < (y + 1) * canvas.width * 4; i += 4) most = Math.max(most, px[i]);
        // The first row with ink, less what that row's edge leaves uncovered
        if (most) {
          top = y + 1 - most / 255;
          found = true;
        }
      }
      inkTops.set(key, (baseline - top) / INK_SIZE);
    }
    return inkTops.get(key);
  };

  // How wide a font's upright strokes are, as a share of the size: read half way up its "l",
  // "I", "H" and "n" drawn at 1024 px, where the stroke stands alone. 0.094 in Arial and
  // Wildjess, 0.125 in Sakana, 0.143 in Komika Title.
  const stemWidths = new Map();
  const stemWidthOf = (textStyle) => {
    const key = Fonts.generation + "|" + cssFont(textStyle, INK_SIZE);
    if (!stemWidths.has(key)) {
      const canvas = newCanvas(INK_SIZE * 2, Math.round(INK_SIZE * 1.5));
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const widths = [];
      ["l", "I", "H", "n"].forEach((ch) => {
        if (!ownGlyph(textStyle, ch)) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.font = cssFont(textStyle, INK_SIZE);
        ctx.textBaseline = "alphabetic";
        ctx.fillText(ch, INK_SIZE / 2, INK_SIZE);
        const rise = inkTopOf(textStyle, ch) * INK_SIZE;
        // The first stroke met on three rows around the middle of the letter
        [0.4, 0.5, 0.6].forEach((share) => {
          const row = ctx.getImageData(0, Math.round(INK_SIZE - rise * share), canvas.width, 1).data;
          let run = 0;
          for (let x = 0; x < canvas.width; x++) {
            const a = row[x * 4 + 3] / 255;
            if (a > 0) run += a;
            else if (run) break;
          }
          if (run > 0) widths.push(run / INK_SIZE);
        });
      });
      widths.sort((a, b) => a - b);
      // No letter of its own to read: Adobe's own guess for a font that doesn't say
      stemWidths.set(key, widths.length ? widths[widths.length >> 1] : 0.075);
    }
    return stemWidths.get(key);
  };

  // Where a line of a paragraph can end: after each of its words and, with Hyphenate, at the
  // syllables wrapRuns cuts at, whatever the word's length: to read lines set elsewhere
  const lineStops = (runs, hyphenRules) => {
    const text = runs.map((run) => run.text).join("");
    const isGap = (ch) => ch === " " || ch === "\t";
    const lettersIn = (from, to) => (text.slice(from, to).match(/[\p{L}\p{N}]/gu) || []).length;
    const stops = [];
    let i = 0;
    while (i < text.length) {
      let end = i;
      while (end < text.length && !isGap(text[end])) end++;
      if (hyphenRules && end > i) {
        for (const part of text.slice(i, end).matchAll(/[\p{L}\p{M}]+/gu)) {
          const from = i + part.index;
          const style = sliceRuns(runs, from, from + 1)[0];
          const language = hyphenLanguage(style && style.style);
          if (!language || (language === "fr" && UNCUT_ELISIONS.test(part[0]) && /^['’]/.test(text.slice(from + part[0].length)))) continue;
          window.TypeRHyphenation.patternCuts(part[0], language).forEach((point) => {
            const cut = from + point;
            if (lettersIn(i, cut) >= hyphenRules.pre && lettersIn(cut, end) >= hyphenRules.post) stops.push({ end: cut, next: cut, hyphen: true });
          });
        }
      }
      let next = end;
      while (next < text.length && isGap(text[next])) next++;
      if (end > i) stops.push({ end, next, last: next >= text.length });
      i = next > i ? next : i + 1;
    }
    return stops.sort((a, b) => a.end - b.end);
  };
  // A line that ends on a word cut there: the hyphen is drawn, but isn't in the text
  const hyphenated = (runs) => {
    const out = runs.slice();
    const last = out[out.length - 1];
    if (last) out[out.length - 1] = runOf(last.text + "-", last.style, last);
    out.hyphenated = true;
    return out;
  };

  // A paragraph's lines where TypeR breaks them: the hard ones, each wrapped in its box
  const wrappedLines = (lt, resolution) => {
    const shape = boxShape(lt);
    const paragraph = (lt.paragraphStyleRange && lt.paragraphStyleRange[0] && lt.paragraphStyleRange[0].paragraphStyle) || {};
    const lines = splitLines(lt);
    if (!shape) return lines;
    const wrapped = [];
    // `fit`: how much wider than its box Photoshop let this text's lines be (see fitOf).
    // A vertical text's lines are as long as its box is high.
    const width = (verticalOf(lt) ? shape.box.height : shape.box.width) * (shape.box.fit || 1);
    lines.forEach((runs) => {
      if (runs.length) wrapped.push(...wrapRuns(runs, width, resolution, hyphenRulesOf(paragraph), Boolean(paragraph.hangingRoman)));
      else wrapped.push(runs);
    });
    return wrapped;
  };
  // Lines put in place: where each goes and the box of their ink
  const placedLines = (lt, resolution, lines) => {
    const shape = boxShape(lt);
    const antiAlias = lt.antiAlias || "antiAliasSmooth";
    const paragraph = (lt.paragraphStyleRange && lt.paragraphStyleRange[0] && lt.paragraphStyleRange[0].paragraphStyle) || {};
    const align = paragraph.alignment || "center";
    // A vertical text is set as a horizontal one, then turned (see verticalOf): its box the
    // other way round, its lines as long as the box is high
    const vertical = verticalOf(lt);
    const frame = !shape ? null : vertical ? Object.assign({}, shape.box, { width: shape.box.height, height: shape.box.width }) : shape.box;
    // Photoshop's first baseline in a box is its Ascent: as low as the top of the font's
    // "d". Measured on 730 lines of real PSDs: 0.86 of the size in Sakana, 0.75 in
    // Victory Speech, where a fixed 0.75 put Sakana's lines 2 px too high
    const firstRuns = lines[0] && lines[0].length ? lines[0] : null;
    const firstStyle = firstRuns ? firstRuns[0].style : (lt.textStyleRange && lt.textStyleRange[0] && lt.textStyleRange[0].textStyle) || {};
    const firstSize = sizePxOf(firstStyle, resolution);
    // Vertical scale stretches the letters, not this
    const ascent = ownGlyph(firstStyle, "d") ? inkTopOf(firstStyle, "d") * firstSize : 0;
    // A font of capitals only has no "d" of its own: 0.75 is what Photoshop comes close to
    const firstOffset = ascent > 0 ? ascent : firstSize * 0.75;
    // What a line is left out of a fixed box by (see below): the height of the font's capitals
    const capitals = ownGlyph(firstStyle, "E") ? inkTopOf(firstStyle, "E") * firstSize : firstOffset;
    let baseline = 0;
    const out = [];
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    let overflow = false;
    let contentBottom = 0;
    lines.forEach((runs, index) => {
      const m = measureRuns(runs, resolution);
      let lead = 0;
      runs.forEach((run) => {
        const size = sizePxOf(run.style, resolution);
        lead = Math.max(lead, run.style.autoLeading === false && run.style.leading > 0 ? (run.style.leading * resolution) / 72 : size * (paragraph.autoLeadingPercentage || 1.2));
      });
      if (!runs.length) {
        const base = (lt.textStyleRange && lt.textStyleRange[0] && lt.textStyleRange[0].textStyle) || {};
        lead = out.length ? out[out.length - 1].lead : sizePxOf(base, resolution) * (paragraph.autoLeadingPercentage || 1.2);
      }
      if (index > 0) baseline += lead;
      else if (frame) baseline = firstOffset;
      // A vertical point text has the middle of its first line on its anchor, as Photoshop's
      else if (vertical) baseline = (uprightBaseOf(firstStyle, CJK.has(firstRuns ? firstRuns[0].text : "")).base - 0.5) * firstSize;
      contentBottom = baseline + Math.max(m.fontDescent, lead * 0.2);
      // As in Photoshop, a line that doesn't fit in a fixed box isn't drawn: one whose baseline
      // falls below the box, whatever its letters, descenders or not. Photoshop counts the
      // first baseline from the top of the box by the height of the font's capitals, not by its
      // "d": a third line shows from a box 2 leadings and 0.87 of the size high in Sakana, 0.73
      // in Victory Speech Lower, 0.77 in CC Ask For Mercy and Komika Title, 0.81 in Wildjess,
      // 0.71 in Arial, 0.75 in Augie, 0.65 in Amiri, where their "E" rises 0.88, 0.74, 0.78,
      // 0.77, 0.80, 0.72, 0.76 and 0.65 (measured in Photoshop 2026 by 0.02 of the size, at 16
      // and 30 px, the same with "Hdpg" as with "HdE"). 0.075 of the size was wanted below the
      // baseline before, which is Augie's gap between the two: in Sakana that hid the last line
      // of 5 real texts that Photoshop shows.
      if (frame && !frame.autoHeight && index > 0 && baseline - firstOffset + capitals > frame.height) {
        overflow = true;
        return;
      }
      // As in Photoshop, the spaces that end a line are left out of its width: in "Un \rcygne ?",
      // centred, "Un" is centred on its letters (measured on real PSDs)
      const lineText = runs.map((run) => run.text).join("");
      const spaces = /[ \t]*$/.exec(lineText)[0].length;
      const shown = spaces ? measureRuns(sliceRuns(runs, 0, lineText.length - spaces), resolution) : m;
      // Roman Hanging Punctuation: what hangs is left out of the line's width. In a box only:
      // Photoshop sets a point text as if it were off (measured in Photoshop 2026)
      const [hangLeft, hangRight] = paragraph.hangingRoman && frame ? hangsOf(shown) : [0, 0];
      const set = shown.advance - trailingTracking(shown) - hangLeft - hangRight;
      let x;
      if (frame) x = align === "left" ? 0 : align === "right" ? frame.width - set : (frame.width - set) / 2;
      else x = align === "left" ? 0 : align === "right" ? -set : -set / 2;
      x -= hangLeft;
      // In a box, what comes before a line's last tab stays on the left, as in Photoshop: only
      // what follows it is centred or set right, and the tab takes up the room
      let line = { runs, m, x, baseline, lead };
      const lastTab = frame && align !== "left" ? lineText.lastIndexOf("\t", lineText.length - spaces - 1) : -1;
      if (lastTab >= 0) {
        const from = measureRuns(sliceRuns(runs, 0, lastTab + 1), resolution).advance - 1e-6;
        const placed = m.placed.map((item) => (item.x >= from ? Object.assign({}, item, { x: item.x + x }) : item));
        line = { runs, m: Object.assign({}, m, { placed, inkRight: m.inkRight + x }), x: 0, baseline, lead, tabShift: { from: lastTab + 1, dx: x } };
      }
      out.push(line);
      if (runs.length) {
        // Faux Bold drawn again to the right and below (see weightOf) reaches that much
        // further, as the layer's bounds do in Photoshop: a text put back on Photoshop's
        // pixels, or centred in a bubble, is set by this box
        let boldRight = 0;
        let boldDown = 0;
        m.placed.forEach((item) => {
          if (!item.run.style.syntheticBold) return;
          const weight = weightOf(item.run.style, item.size, antiAlias);
          boldRight = Math.max(boldRight, weight.right);
          boldDown = Math.max(boldDown, weight.down);
        });
        // In a vertical text the page's right is above the line, and its bottom along it
        left = Math.min(left, line.x + line.m.inkLeft);
        right = Math.max(right, line.x + line.m.inkRight + (vertical ? boldDown : boldRight));
        top = Math.min(top, baseline - m.ascent - (vertical ? boldRight : 0));
        bottom = Math.max(bottom, baseline + m.descent + (vertical ? 0 : boldDown));
      }
    });
    const hasInk = isFinite(left);
    if (!hasInk) {
      left = right = 0;
      top = bottom = 0;
    }
    // Centred in its box: what shows, or the line an empty text starts on. Text that
    // doesn't fit stays at the top, where Photoshop cuts it.
    let shift = 0;
    if (frame && frame.verticalAlign === "center" && !frame.autoHeight && !overflow) {
      const height = hasInk ? bottom - top : contentBottom;
      shift = Math.max(0, (frame.height - height) / 2 - top);
      out.forEach((line) => { line.baseline += shift; });
      top += shift;
      bottom += shift;
    }
    const box = rectFrom(left, top, right, bottom);
    const set = frame ? { width: frame.width, height: frame.autoHeight ? contentBottom : frame.height } : null;
    const layout = { lines: out, box, frame: set, overflow, contentHeight: contentBottom, firstOffset, shift, wrapped: lines };
    // Turned: `box` and `frame` are where the text shows around its anchor, a box's top
    // right corner. `straight` keeps them as the lines were set, and `lines` stay so: they
    // are turned when they are drawn (see drawLines) and where the caret goes (see caretLines).
    if (vertical) Object.assign(layout, { vertical: true, straight: { box, frame: set }, box: rectFrom(-bottom, left, -top, right), frame: set ? { width: set.height, height: set.width } : null });
    return layout;
  };

  // Where each line goes and the box of its ink, measured once per text and style.
  // Everything here is relative to the layer's anchor: moving a layer costs nothing.
  const layoutCache = new Map();
  // The same text object asks again on every frame: answered without writing its key out
  const layoutByText = new WeakMap();
  const relativeLayout = (lt, resolution) => {
    const shape = boxShape(lt);
    const box = shape && shape.box;
    const known = layoutByText.get(lt);
    // The anti-aliasing method too: the box of a Faux Bold's ink depends on it
    const antiAlias = lt.antiAlias || "antiAliasSmooth";
    const vertical = verticalOf(lt);
    if (known && known.generation === Fonts.generation && known.resolution === resolution && known.textKey === lt.textKey && known.ranges === lt.textStyleRange && known.paragraphs === lt.paragraphStyleRange && known.box === box && known.antiAlias === antiAlias && known.vertical === vertical) return known.layout;
    const key = Fonts.generation + "|" + resolution + "|" + JSON.stringify([lt.textKey, lt.textStyleRange, lt.paragraphStyleRange, box, antiAlias]) + (vertical ? "|vertical" : "");
    const remember = (layout) => {
      layoutByText.set(lt, { generation: Fonts.generation, resolution, textKey: lt.textKey, ranges: lt.textStyleRange, paragraphs: lt.paragraphStyleRange, box, antiAlias, vertical, layout });
      return layout;
    };
    const cached = layoutCache.get(key);
    if (cached) return remember(cached);
    if (layoutCache.size > 4000) layoutCache.clear();
    const result = placedLines(lt, resolution, wrappedLines(lt, resolution));
    layoutCache.set(key, result);
    return remember(result);
  };

  const anchorOf = (lt, doc) => [(lt.textClickPoint.horizontal / 100) * doc.width, (lt.textClickPoint.vertical / 100) * doc.height];

  const layoutLayer = (layer, doc) => {
    const lt = layer.params.layerText;
    const relative = relativeLayout(lt, doc.resolution);
    const [ax, ay] = anchorOf(lt, doc);
    const b = relative.box;
    const layout = {
      relative,
      anchor: [ax, ay],
      lines: relative.lines.map((line) => Object.assign({}, line, { x: line.x + ax, baseline: line.baseline + ay })),
      box: rectFrom(b.left + ax, b.top + ay, b.right + ax, b.bottom + ay),
      frame: relative.frame ? rectFrom(ax, ay, ax + relative.frame.width, ay + relative.frame.height) : null,
      overflow: relative.overflow,
      contentHeight: relative.contentHeight,
    };
    if (!relative.vertical) return layout;
    // A vertical text: `box` and `frame` where it shows, the frame's top right on the anchor.
    // `lines` are as they were set, around the anchor: a quarter turn around it puts them on
    // the page. `straight`: the box and the frame those lines were set in.
    const s = relative.straight;
    return Object.assign(layout, {
      vertical: true,
      frame: relative.frame ? rectFrom(ax - relative.frame.width, ay, ax, ay + relative.frame.height) : null,
      straight: { box: rectFrom(s.box.left + ax, s.box.top + ay, s.box.right + ax, s.box.bottom + ay), frame: s.frame ? rectFrom(ax, ay, ax + s.frame.width, ay + s.frame.height) : null },
    });
  };
  // The quarter turn that puts a vertical text's lines on the page, as a text's own turn is
  // written (see spinOf): what runs along a line goes down, what is above it goes right
  const QUARTER = [0, 1, -1, 0];
  // From a text's lines as they are set to the page, around its anchor: its own turn, after
  // the quarter turn of a vertical text. Null for a straight horizontal text.
  const layTurnOf = (layer) => {
    const own = spinOf(layer);
    if (!verticalOf(layer.params.layerText)) return own;
    return own ? [own[2], own[3], -own[0], -own[1]] : QUARTER;
  };

  // A paragraph opened from a PSD shows Photoshop's own pixels, and the file says its text
  // and its box, not its lines. Where a line fits by a hair in Photoshop and not here, TypeR
  // would break them elsewhere: the lines are then read back from the pixels, each row of
  // ink as wide as the piece of text it holds, so that the caret, the selection and the
  // hidden characters go where Photoshop put the letters.
  // `layout`: the lines as Photoshop set them, placed (none: they are TypeR's own too), and
  // `lines`, their runs. Null when the pixels don't tell: a turned text, its stroke drawn
  // in, letters of several sizes, or no way of breaking the text that gives these rows.
  const SAME_LINES = { layout: null, lines: null };
  const pixelLines = new WeakMap();
  const photoshopLines = (layer, doc) => {
    const raster = layer.raster;
    if (!raster || !raster.bitmap || !raster.bitmap.width || !raster.bitmap.height) return null;
    const lt = layer.params.layerText;
    const shape = boxShape(lt);
    // A point text only breaks where it is told to
    if (!shape) return SAME_LINES;
    if (shape.orientation === "vertical" || raster.strokeDrawnIn || layer.rotated || layer.warp || layer.envelope) return null;
    const relative = relativeLayout(lt, doc.resolution);
    const [ax, ay] = anchorOf(lt, doc);
    const dx = Math.round((raster.left - ax) * 100) / 100;
    const dy = Math.round((raster.top - ay) * 100) / 100;
    const known = pixelLines.get(raster.bitmap);
    if (known && known.relative === relative && known.dx === dx && known.dy === dy) return known.read;
    const read = readPixelLines(lt, relative, raster.bitmap, dx, dy, doc.resolution);
    pixelLines.set(raster.bitmap, { relative, dx, dy, read });
    return read;
  };
  // `dx`, `dy`: where the pixels are from the text's anchor
  const readPixelLines = (lt, relative, bitmap, dx, dy, resolution) => {
    if (relative.overflow || relative.shift || !relative.lines.length) return null;
    const paragraph = (lt.paragraphStyleRange && lt.paragraphStyleRange[0] && lt.paragraphStyleRange[0].paragraphStyle) || {};
    const styles = (lt.textStyleRange || []).map((range) => range.textStyle);
    if (!styles.length) return null;
    // The rows are told apart by their leading, and read where every letter has ink: one
    // size and one leading for the whole text
    const size = sizePxOf(styles[0], resolution);
    const leadOf = (style) => (style.autoLeading === false && style.leading > 0 ? (style.leading * resolution) / 72 : sizePxOf(style, resolution) * (paragraph.autoLeadingPercentage || 1.2));
    const lead = leadOf(styles[0]);
    const even = (style) => Math.abs(sizePxOf(style, resolution) - size) < 0.01 && Math.abs(leadOf(style) - lead) < 0.01 && (style.verticalScale || 100) === (styles[0].verticalScale || 100) && !style.baselineShift && !style.impliedBaselineShift;
    if (!(size > 0) || !(lead >= size * 0.7) || !styles.every(even)) return null;
    const { width, height } = bitmap;
    let source = bitmap;
    if (!source.getContext) {
      source = newCanvas(width, height);
      source.getContext("2d").drawImage(bitmap, 0, 0);
    }
    const data = source.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, width, height).data;
    const scaleY = (styles[0].verticalScale || 100) / 100;
    const first = relative.lines[0].baseline;
    // A row's ink, from the middle of its capitals down to its baseline: accents and
    // descenders, which reach into the rows next to it, are left out
    const rows = [];
    for (let k = 0; ; k++) {
      const top = Math.max(0, Math.ceil(first + k * lead - size * scaleY * 0.7 - dy));
      const bottom = Math.min(height - 1, Math.floor(first + k * lead + size * scaleY * 0.05 - dy));
      if (top >= height) break;
      let left = Infinity;
      let right = -Infinity;
      for (let y = top; y <= bottom; y++) {
        for (let x = 0; x < width && x < left; x++) {
          if (data[(y * width + x) * 4 + 3] > 24) left = x;
        }
        for (let x = width - 1; x >= 0 && x > right; x--) {
          if (data[(y * width + x) * 4 + 3] > 24) right = x;
        }
      }
      rows.push(right >= left ? { left: left + dx, right: right + 1 + dx } : null);
    }
    while (rows.length && !rows[rows.length - 1]) rows.pop();
    if (!rows.length) return null;
    const widthOf = (k) => (rows[k] ? rows[k].right - rows[k].left : 0);
    const tolerance = Math.max(3, size * 0.3);
    const textOf = (runs) => runs.map((run) => run.text).join("");
    const inkOf = (runs) => {
      if (!runs.length) return 0;
      const m = measureRuns(runs, resolution);
      return isFinite(m.inkLeft) ? m.inkRight - m.inkLeft : 0;
    };
    // TypeR's own lines give these rows: nothing to read
    const own = relative.wrapped;
    if (own.length === rows.length && own.every((runs, k) => Math.abs(inkOf(sliceRuns(runs, 0, textOf(runs).replace(/[ \t]+$/, "").length)) - widthOf(k)) <= tolerance)) return SAME_LINES;
    // Where each paragraph can break: after a word, or inside one with a hyphen where Hyphenate
    // would cut it
    const hyphenRules = hyphenRulesOf(paragraph);
    const paragraphs = splitLines(lt).map((runs) => ({ runs, stops: lineStops(runs, hyphenRules) }));
    // The breaks whose lines are the closest to the rows' widths. A line may be further from
    // its row than TypeR's own lines are let to be: Photoshop kerns some pairs of letters
    // that the browser doesn't ("tront" comes out 8 px narrower at 16 px in Sakana), and the
    // other lines tell the breaks apart.
    const reach = Math.max(tolerance, size * 0.6);
    const widths = new Map();
    const lineOf = (p, from, stop) => {
      const runs = sliceRuns(paragraphs[p].runs, from, stop.end);
      return stop.hyphen ? hyphenated(runs) : runs;
    };
    const lineWidth = (p, from, stop) => {
      const key = p + ":" + from + ":" + stop.end + (stop.hyphen ? "-" : "");
      if (!widths.has(key)) widths.set(key, inkOf(lineOf(p, from, stop)));
      return widths.get(key);
    };
    const solved = new Map();
    const solve = (p, from, k) => {
      if (p === paragraphs.length) return k >= rows.length ? { cost: 0, line: null, rest: null } : null;
      const key = p + ":" + from + ":" + k;
      if (solved.has(key)) return solved.get(key);
      let best = null;
      const { runs, stops } = paragraphs[p];
      if (!stops.length) {
        // An empty paragraph: a row with nothing on it
        const rest = widthOf(k) <= reach ? solve(p + 1, 0, k + 1) : null;
        if (rest) best = { cost: rest.cost + widthOf(k), line: runs, rest };
      }
      for (const stop of stops) {
        if (stop.end <= from) continue;
        const wide = lineWidth(p, from, stop);
        if (wide > widthOf(k) + reach + size) break;
        const off = Math.abs(wide - widthOf(k));
        if (off > reach) continue;
        const rest = stop.last ? solve(p + 1, 0, k + 1) : solve(p, stop.next, k + 1);
        if (rest && (!best || off + rest.cost < best.cost)) best = { cost: off + rest.cost, line: lineOf(p, from, stop), rest };
      }
      solved.set(key, best);
      return best;
    };
    const found = solve(0, 0, 0);
    if (!found) return null;
    const lines = [];
    for (let step = found; step && step.line; step = step.rest) lines.push(step.line);
    if (lines.length === own.length && lines.every((runs, k) => textOf(runs) === textOf(own[k]).replace(/[ \t]+$/, "") || textOf(runs) === textOf(own[k]))) return SAME_LINES;
    const layout = placedLines(lt, resolution, lines);
    // Each line where its ink is in the pixels: Photoshop's letters are a little narrower or
    // wider than the browser's
    layout.lines.forEach((line, k) => {
      if (!rows[k] || !line.runs.length || line.tabShift || !isFinite(line.m.inkLeft)) return;
      const move = (rows[k].left + rows[k].right) / 2 - (line.x + (line.m.inkLeft + line.m.inkRight) / 2);
      if (Math.abs(move) <= reach) line.x += move;
    });
    return { layout, lines };
  };
  // How much wider (or narrower) than its box Photoshop's lines say the text may be: the
  // smallest change of width that makes TypeR break them as Photoshop did. With it, a text
  // typed in keeps Photoshop's lines. 0 when none does, or when none is needed.
  const fitOf = (layer, doc) => {
    const read = photoshopLines(layer, doc);
    if (!read || !read.lines) return 0;
    const lt = layer.params.layerText;
    const shape = boxShape(lt);
    const textOf = (runs) => runs.map((run) => run.text).join("");
    for (const fit of [1.005, 0.995, 1.01, 0.99, 1.015, 0.985, 1.02, 0.98, 1.03, 0.97]) {
      const lines = wrappedLines(Object.assign({}, lt, { textShape: [Object.assign({}, shape, { box: Object.assign({}, shape.box, { fit }) })] }), doc.resolution);
      if (lines.length === read.lines.length && lines.every((runs, k) => textOf(runs) === textOf(read.lines[k]))) return fit;
    }
    return 0;
  };

  // Where the caret can go in a text, line by line as the canvas sets them: the part of the
  // text each line holds, and the x after each of its letters. The editor's own lines don't
  // break or measure the same, so its caret and selection are drawn from these.
  const caretCache = new WeakMap();
  const caretLines = (layer, doc) => {
    const lt = layer.params.layerText;
    // On Photoshop's pixels, the lines Photoshop set
    const read = photoshopLines(layer, doc);
    const relative = (read && read.layout) || relativeLayout(lt, doc.resolution);
    let rel = caretCache.get(relative);
    if (!rel) {
      const text = lt.textKey || "";
      const base = (lt.textStyleRange && lt.textStyleRange[0] && lt.textStyleRange[0].textStyle) || {};
      const size = sizePxOf(base, doc.resolution);
      const shown = new Map(relative.lines.map((line) => [line.runs, line]));
      rel = [];
      let w = 0;
      let lineStart = 0;
      // Indices are the text's own, as the editor holds it: "\r\n" is one break of two letters
      text.split(/(\r\n|[\r\n])/).forEach((hard, part) => {
        if (part % 2) {
          lineStart += hard.length;
          return;
        }
        const lineEnd = lineStart + hard.length;
        let at = lineStart;
        do {
          const runs = relative.wrapped[w++];
          if (!runs) break;
          const drawn = runs.map((run) => run.text).join("");
          const piece = runs.hyphenated ? drawn.slice(0, -1) : drawn;
          const found = piece ? text.indexOf(piece, at) : -1;
          const start = found >= at && found <= lineEnd ? found : at;
          const end = Math.min(lineEnd, start + piece.length);
          at = end;
          while (at < lineEnd && text[at] === " ") at++;
          const line = shown.get(runs);
          // A line that doesn't fit in its box isn't drawn: the caret has nowhere to go there
          if (!line) continue;
          const xs = [line.x];
          // What follows a line's last tab in a box may be moved along (see relativeLayout)
          const moved = (k) => (line.tabShift && k >= line.tabShift.from ? line.tabShift.dx : 0);
          // Inside a letter and its marks the caret has no place of its own: it stays before them
          const starts = letterStartsOf(piece);
          // A vertical line is measured whole: what stands side by side in it depends on what
          // is around (the "20" of "2026" is no pair)
          const stops = runs.length && runs[0].vertical ? [] : null;
          if (stops) measureColumn(runs, doc.resolution, stops);
          for (let k = 1; k <= end - start; k++) xs.push(starts && !starts.has(k) ? xs[k - 1] : line.x + (stops ? stops[Math.min(k, stops.length - 1)] : measureRuns(sliceRuns(runs, 0, k), doc.resolution).advance) + moved(k));
          const ascent = line.m.fontAscent || size * 0.8;
          const descent = line.m.fontDescent || size * 0.2;
          rel.push({ start, end, xs, baseline: line.baseline, top: line.baseline - ascent, bottom: line.baseline + descent, size });
        } while (at < lineEnd);
        lineStart = lineEnd;
      });
      caretCache.set(relative, rel);
    }
    const [ax, ay] = anchorOf(lt, doc);
    return rel.map((line) => Object.assign({}, line, { xs: line.xs.map((x) => x + ax), baseline: line.baseline + ay, top: line.top + ay, bottom: line.bottom + ay }));
  };

  /* ------------------------------ text on a surface ----------------------------- */

  // A text in perspective, or around a can or a page, stays a text: `warp` says where its
  // rectangle (`source`, around its anchor) lands on the page. The four corners give the
  // perspective. The bends push the middle of the top and bottom edges, which turns them
  // into curves. `wrap` is the angle the text covers on a cylinder: the letters get
  // narrower towards its sides. At 0 the formulas below are a plain curve on a flat plane.
  const surfaceOf = (warp) => {
    const [a, b, c, d] = warp.corners;
    const dx1 = b[0] - c[0];
    const dx2 = d[0] - c[0];
    const sx = a[0] - b[0] + c[0] - d[0];
    const dy1 = b[1] - c[1];
    const dy2 = d[1] - c[1];
    const sy = a[1] - b[1] + c[1] - d[1];
    const den = dx1 * dy2 - dx2 * dy1;
    const g = den ? (sx * dy2 - dx2 * sy) / den : 0;
    const h = den ? (dx1 * sy - sx * dy1) / den : 0;
    const a11 = b[0] - a[0] + g * b[0];
    const a12 = d[0] - a[0] + h * d[0];
    const a21 = b[1] - a[1] + g * b[1];
    const a22 = d[1] - a[1] + h * d[1];
    const wrap = ((warp.wrap || 0) * Math.PI) / 180;
    const flat = (x, v) => {
      const w = Math.max(0.001, g * x + h * v + 1);
      return [(a11 * x + a12 * v + a[0]) / w, (a21 * x + a22 * v + a[1]) / w];
    };
    const at = (u, v) => {
      let x = u;
      let bump = 4 * u * (1 - u);
      if (wrap > 0.001) {
        const theta = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, (2 * u - 1) * wrap));
        x = (Math.sin(theta) / Math.sin(wrap) + 1) / 2;
        bump = (Math.cos(theta) - Math.cos(wrap)) / (1 - Math.cos(wrap));
      }
      const p = flat(x, v);
      return [p[0] + ((1 - v) * warp.bendTop[0] + v * warp.bendBottom[0]) * bump, p[1] + ((1 - v) * warp.bendTop[1] + v * warp.bendBottom[1]) * bump];
    };
    return { at, flat };
  };

  const boundsOfPoints = (points) => {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    points.forEach(([x, y]) => {
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    });
    return rectFrom(left, top, right, bottom);
  };

  // The edge of a part of the surface, in parts of the text's rectangle
  const surfaceEdge = (warp, u0, v0, u1, v1) => {
    const { at } = surfaceOf(warp);
    const points = [];
    for (let i = 0; i <= 24; i++) {
      const u = u0 + ((u1 - u0) * i) / 24;
      points.push(at(u, v0), at(u, v1));
    }
    for (let i = 1; i < 8; i++) {
      const v = v0 + ((v1 - v0) * i) / 8;
      points.push(at(u0, v), at(u1, v));
    }
    return points;
  };

  // A text the Perspective tool can lay on a surface: not Warp Text's, whose shape Photoshop
  // keeps, nor a letter of an SFX, which takes its shape from the SFX
  const surfaceFits = (layer, doc) => {
    if (!layer || layer.kind !== "text" || layer.sfx || layer.mesh || layer.outline || (window.TypeRTextWarp && window.TypeRTextWarp.on(layer.envelope))) return false;
    const parent = layer.group && doc.state.layers.find((item) => item.id === layer.group);
    return !(parent && parent.sfx);
  };

  /* ------------------------------ perspective zones ----------------------------- */

  // A zone of the page that is a surface seen in perspective, as the Perspective tool draws
  // one over a board, a wall, a sign: `corners`, its four corners on the page, give the
  // perspective; `unit`, how many pixels of text it is wide and tall, gives the size of what
  // is written on it, which `wide` makes wider or narrower. `found` says what the page showed
  // of it. The texts whose middle is in a zone lie on its surface: each has a `warp` marked
  // `auto`, [across, down], its own size there, laid again whenever the text or the zone
  // changes (see commitState). A text the user took off the surface says `offSurface`.
  const NO_SURFACES = [];
  const surfacesOf = (state) => state.surfaces || NO_SURFACES;
  // The zone a point of the page is in: the last one drawn, where two overlap
  const surfaceAt = (surfaces, [x, y]) => {
    for (let i = surfaces.length - 1; i >= 0; i--) if (insidePolygon(surfaces[i].corners, x, y, 0)) return surfaces[i];
    return null;
  };
  const surfaceUnit = (zone) => [zone.unit[0] / (zone.wide || 1), zone.unit[1]];
  // A zone that faces the reader, at the size things are typed: a text on it is as it was
  const flatSurface = (zone) => {
    const m = window.TypeRPerspective.squareTo(zone.corners);
    const [ux, uy] = surfaceUnit(zone);
    const near = (value, wanted) => Math.abs(value - wanted) <= 1e-4 * Math.max(1, Math.abs(wanted));
    return Math.abs(m[6]) < 1e-7 && Math.abs(m[7]) < 1e-7 && near(m[1] / uy, 0) && near(m[3] / ux, 0) && near(m[0], ux) && near(m[4], uy);
  };
  // Where a text is, for the zones: the middle of its surface, or of its frame
  const placeOnSurface = (layer, doc) => {
    if (layer.warp) {
      const middle = window.TypeRPerspective.onQuad(window.TypeRPerspective.squareTo(layer.warp.corners), 0.5, 0.5);
      if (middle) return middle;
    }
    return middleOfText(layer, doc);
  };
  // A text laid on a zone, or null where the surface turns away under it. One already there
  // keeps its anchor in place, so that what is typed grows from it as its alignment says;
  // one that comes in keeps its middle where it shows, and lands along the surface.
  const laidOn = (layer, zone, doc) => {
    const P = window.TypeRPerspective;
    const plain = Object.assign({}, layer, { raster: null, warp: null, rotated: false, spin: null });
    const f = frameOf(plain, doc);
    const [ax, ay] = anchorOf(layer.params.layerText, doc);
    const width = Math.max(1, f.width);
    const height = Math.max(1, f.height);
    const source = { left: f.left - ax, top: f.top - ay, width, height };
    const m = P.squareTo(zone.corners);
    const [ux, uy] = surfaceUnit(zone);
    let auto;
    let u0;
    let v0;
    if (layer.warp && layer.warp.auto) {
      auto = layer.warp.auto;
      const was = layer.warp.source;
      const anchor = P.onQuad(P.squareTo(layer.warp.corners), -was.left / was.width, -was.top / was.height);
      const at = anchor && P.fromQuad(m, anchor[0], anchor[1]);
      if (!at) return null;
      u0 = at[0] + (source.left * auto[0]) / ux;
      v0 = at[1] + (source.top * auto[1]) / uy;
    } else {
      const spin = spinOf(layer);
      auto = spin ? [Math.hypot(spin[0], spin[1]), Math.hypot(spin[2], spin[3])] : [1, 1];
      const middle = placeOnSurface(layer, doc);
      const at = P.fromQuad(m, middle[0], middle[1]);
      if (!at) return null;
      u0 = at[0] - (width * auto[0]) / ux / 2;
      v0 = at[1] - (height * auto[1]) / uy / 2;
    }
    const u1 = u0 + (width * auto[0]) / ux;
    const v1 = v0 + (height * auto[1]) / uy;
    const frame = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
    // Well before the line the surface vanishes on
    if (!frame.every(([u, v]) => m[6] * u + m[7] * v + 1 > 0.2)) return null;
    return Object.assign(plain, { warp: { source, corners: frame.map(([u, v]) => P.onQuad(m, u, v)), bendTop: [0, 0], bendBottom: [0, 0], wrap: 0, auto } });
  };
  // A text taken off its surface: a plain text again, its middle where the surface had it
  const liftedOff = (layer, doc) => {
    const [x, y] = placeOnSurface(layer, doc);
    const plain = Object.assign({}, layer, { warp: null, raster: null });
    const now = middleOfText(plain, doc);
    return shifted(plain, x - now[0], y - now[1], doc);
  };
  const sameSurface = (a, b) => Boolean(a && b) && a.auto[0] === b.auto[0] && a.auto[1] === b.auto[1]
    && ["left", "top", "width", "height"].every((key) => Math.abs(a.source[key] - b.source[key]) < 1e-6)
    && a.corners.every((corner, i) => Math.abs(corner[0] - b.corners[i][0]) < 0.005 && Math.abs(corner[1] - b.corners[i][1]) < 0.005);
  // The layers of a step, each text that changed in it laid on the zone it is now in, or taken
  // off the one it left; every text, when the zones changed. null when nothing is to change.
  const settleSurfaces = (doc, before) => {
    const state = doc.state;
    const zones = surfacesOf(state);
    const all = zones !== surfacesOf(before);
    if ((!zones.length && !all) || (!all && state.layers === before.layers) || !window.TypeRPerspective) return null;
    const old = new Map(before.layers.map((layer) => [layer.id, layer]));
    const turned = zones.filter((zone) => !flatSurface(zone));
    let changed = false;
    const layers = state.layers.map((layer) => {
      if (layer.kind !== "text" || (layer.warp && !layer.warp.auto)) return layer;
      const same = old.get(layer.id) === layer;
      // A zone that changes leaves a locked text where it is
      if (same && (!all || lockOf(layer, "position"))) return layer;
      if (!layer.warp && (layer.offSurface || !surfaceFits(layer, doc))) return layer;
      const zone = layer.offSurface ? null : surfaceAt(turned, placeOnSurface(layer, doc));
      let next = null;
      if (zone) {
        next = laidOn(layer, zone, doc);
        if (!next || sameSurface(layer.warp, next.warp)) return layer;
      } else if (layer.warp) next = liftedOff(layer, doc);
      if (!next) return layer;
      changed = true;
      return next;
    });
    return changed ? layers : null;
  };
  // The zones of a page that moved by (ox, oy), or whose size changed
  const surfacesShifted = (doc, ox, oy) => (surfacesOf(doc.state).length ? { surfaces: surfacesOf(doc.state).map((zone) => Object.assign({}, zone, { corners: zone.corners.map(([x, y]) => [x + ox, y + oy]) })) } : null);
  const surfacesScaled = (doc, sx, sy) => (surfacesOf(doc.state).length ? { surfaces: surfacesOf(doc.state).map((zone) => Object.assign({}, zone, { corners: zone.corners.map(([x, y]) => [x * sx, y * sy]), unit: [zone.unit[0] * sx, zone.unit[1] * sy] })) } : null);

  /* ------------------------------ a letter reshaped ----------------------------- */

  // A letter given a shape of its own (an SFX's, as Photoshop's Convert to Shape would let a
  // letterer pull it): `mesh` is a grid of n × n points laid over the letter's box, each moved
  // by `p` = [across, down], in parts of the box's width and height. Between the points the
  // letter follows them smoothly; past the box's edges, as at the edge, so its stroke goes
  // with it. The text stays a text: turned, resized, retyped, it keeps that shape.
  const meshOk = (mesh) => Boolean(mesh) && Number.isInteger(mesh.n) && mesh.n >= 2 && mesh.n <= 8 && Array.isArray(mesh.p) && mesh.p.length === mesh.n * mesh.n && mesh.p.every((d) => Array.isArray(d) && Number.isFinite(d[0]) && Number.isFinite(d[1]));
  // Or given an outline of its own (`outline`), its anchor points pulled one by one: `c`, the
  // paths of TypeROutline, in parts of the letter's box, drawn in place of its letters; `ch`,
  // the letter it was made from. A shape (`mesh`) on top of it bends it further.
  const validOutlines = new WeakMap();
  const outlineOk = (outline) => {
    if (!outline || typeof outline !== "object" || !window.TypeROutline) return false;
    let ok = validOutlines.get(outline);
    if (ok === undefined) {
      ok = window.TypeROutline.valid(outline);
      validOutlines.set(outline, ok);
    }
    return ok;
  };
  const meshOn = (layer) => Boolean(layer && layer.kind === "text" && !layer.warp && !layer.raster && (meshOk(layer.mesh) || outlineOk(layer.outline)));
  // Catmull-Rom through the values at 0, 1/(n-1)… 1, going on straight past both ends
  const catmull = (values, t) => {
    const n = values.length;
    const x = Math.max(0, Math.min(1, t)) * (n - 1);
    const i = Math.min(Math.floor(x), n - 2);
    const s = x - i;
    const at = (k) => (k < 0 ? 2 * values[0] - values[1] : k >= n ? 2 * values[n - 1] - values[n - 2] : values[k]);
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    return 0.5 * (2 * p1 + (p2 - p0) * s + (2 * p0 - 5 * p1 + 4 * p2 - p3) * s * s + (3 * p1 - p0 - 3 * p2 + p3) * s * s * s);
  };
  // How far the point at (u, v) of the box moves, in parts of the box
  const meshShift = (mesh) => {
    const { n, p } = mesh;
    const rowsX = [];
    const rowsY = [];
    for (let j = 0; j < n; j++) {
      rowsX.push(p.slice(j * n, j * n + n).map((d) => d[0]));
      rowsY.push(p.slice(j * n, j * n + n).map((d) => d[1]));
    }
    const across = new Array(n);
    const down = new Array(n);
    return (u, v) => {
      for (let j = 0; j < n; j++) {
        across[j] = catmull(rowsX[j], u);
        down[j] = catmull(rowsY[j], u);
      }
      return [catmull(across, v), catmull(down, v)];
    };
  };
  // From the text's own frame (around its anchor) to where it lands, anchor aside: reshaped,
  // then turned as the text is
  const meshMapOf = (layer, box) => {
    const shift = meshOk(layer.mesh) ? meshShift(layer.mesh) : () => [0, 0];
    const spin = (layer.rotated && layer.spin) || [1, 0, 0, 1];
    const w = box.width || 1;
    const h = box.height || 1;
    return (x, y) => {
      const [du, dv] = shift((x - box.left) / w, (y - box.top) / h);
      const X = x + du * w;
      const Y = y + dv * h;
      return [spin[0] * X + spin[2] * Y, spin[1] * X + spin[3] * Y];
    };
  };
  // The edge of a reshaped letter's box, on the page, going round
  const meshOutline = (layer, doc, steps = 12) => {
    const b = relativeLayout(layer.params.layerText, doc.resolution).box;
    const map = meshMapOf(layer, b);
    const [ax, ay] = anchorOf(layer.params.layerText, doc);
    const out = [];
    const edge = (x0, y0, x1, y1) => {
      for (let i = 0; i < steps; i++) {
        const [x, y] = map(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
        out.push([ax + x, ay + y]);
      }
    };
    edge(b.left, b.top, b.right, b.top);
    edge(b.right, b.top, b.right, b.bottom);
    edge(b.right, b.bottom, b.left, b.bottom);
    edge(b.left, b.bottom, b.left, b.top);
    return out;
  };
  // A letter's outline on the page, in its own frame (anchor aside) or on the page
  const outlineOnPage = (layer, doc, onPage = true) => {
    const b = relativeLayout(layer.params.layerText, doc.resolution).box;
    const map = meshMapOf(layer, b);
    const [ax, ay] = onPage ? anchorOf(layer.params.layerText, doc) : [0, 0];
    return window.TypeROutline.mapped(layer.outline.c, (u, v) => {
      const [x, y] = map(b.left + u * b.width, b.top + v * b.height);
      return [ax + x, ay + y];
    });
  };
  // Where a letter's outline sits, to find it again from a shape Photoshop changed: its box (in
  // its own frame), its anchor on the page, its turn
  const shapeFrameOf = (layer, doc) => {
    const b = relativeLayout(layer.params.layerText, doc.resolution).box;
    return { box: [b.left, b.top, b.width, b.height], anchor: anchorOf(layer.params.layerText, doc), spin: (layer.rotated && layer.spin) || null };
  };
  // All of it, the inside too, which a point pulled far can take past the edges
  const meshBounds = (layer, doc) => {
    if (outlineOk(layer.outline)) {
      const { left, top, right, bottom } = window.TypeROutline.boundsOf(outlineOnPage(layer, doc));
      return rectFrom(left, top, right, bottom);
    }
    const b = relativeLayout(layer.params.layerText, doc.resolution).box;
    const map = meshMapOf(layer, b);
    const [ax, ay] = anchorOf(layer.params.layerText, doc);
    const points = [];
    for (let j = 0; j <= 8; j++) for (let i = 0; i <= 8; i++) {
      const [x, y] = map(b.left + (b.width * i) / 8, b.top + (b.height * j) / 8);
      points.push([ax + x, ay + y]);
    }
    return boundsOfPoints(points);
  };
  const insidePolygon = (polygon, x, y, slack) => {
    let inside = false;
    let near = Infinity;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [xi, yi] = polygon[i];
      const [xj, yj] = polygon[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      const dx = xj - xi;
      const dy = yj - yi;
      const t = Math.max(0, Math.min(1, ((x - xi) * dx + (y - yi) * dy) / (dx * dx + dy * dy || 1)));
      near = Math.min(near, Math.hypot(xi + dx * t - x, yi + dy * t - y));
    }
    return inside || near <= slack;
  };

  /* --------------------------------- a text warped -------------------------------- */

  // Photoshop's Warp Text: `envelope` is the warp ({ style, bend, horizontal, vertical, rotate },
  // see TypeRTextWarp), its letters drawn where the warp's surface puts them. It stays a text,
  // and Photoshop opens it with the same warp. Not to be mistaken for `warp`, a text in
  // perspective, which Photoshop has no text for.
  const envelopeOn = (layer) => Boolean(layer && layer.kind === "text" && !layer.warp && !layer.raster && window.TypeRTextWarp.on(layer.envelope) && !meshOn(layer));
  // How far a font's letters go in the bounds Photoshop gives a text, in parts of the size:
  // above the baseline, half the size and half the height of its capitals; below it, as low as
  // the lowest of all its letters (measured on Photoshop 2026 with 16 fonts). Read from the
  // font's file; a font whose file can't be read is measured on what it draws, which misses
  // a letter that goes lower than these.
  const LOW_LETTERS = "gjpqyQJ()[]{}|/_,;@$çÇ";
  const boundsShares = new Map();
  const boundsSharesOf = (textStyle) => {
    const font = Fonts.resolve(textStyle);
    const key = Fonts.generation + "|" + cssFont(textStyle, INK_SIZE);
    let shares = boundsShares.get(key);
    if (!shares) {
      const measures = Fonts.measuresOf(font);
      let cap = measures && measures.cap;
      if (!cap) cap = ownGlyph(textStyle, "H") ? inkTopOf(textStyle, "H") : 0.7;
      let fall = measures ? measures.bottom : 0;
      if (!measures) {
        const low = Array.from(LOW_LETTERS).filter((ch) => ownGlyph(textStyle, ch)).join("") || "g";
        setRunFont(measureCtx, textStyle, INK_SIZE);
        fall = measureCtx.measureText(low).actualBoundingBoxDescent / INK_SIZE;
      }
      shares = { rise: 0.5 + cap / 2, fall };
      if (boundsShares.size > 500) boundsShares.clear();
      boundsShares.set(key, shares);
    }
    return shares;
  };
  // Photoshop kerns the last letter of a line with the return that ends it, as it would with a
  // space (a line ending in Arial's L ends 0.037 of the size sooner). In parts
  // of the size: from the font's `kern` table when its file is read, else as the browser kerns.
  const endKerns = new Map();
  const endKernOf = (textStyle, ch) => {
    if (!ch || ch === " " || textStyle.autoKern === "manual") return 0;
    const measures = Fonts.measuresOf(Fonts.resolve(textStyle));
    if (measures && measures.spaceKerns) return measures.spaceKerns.get(ch) || 0;
    const key = Fonts.generation + "|" + cssFont(textStyle, INK_SIZE) + "|" + ch;
    if (!endKerns.has(key)) {
      if (endKerns.size > 2000) endKerns.clear();
      const style = Object.assign({}, textStyle, { tracking: 0 });
      setRunFont(measureCtx, style, INK_SIZE);
      const width = (text) => measureCtx.measureText(text).width;
      endKerns.set(key, (width(ch + " ") - width(ch) - width(" ")) / INK_SIZE);
    }
    return endKerns.get(key);
  };
  // The bounds Photoshop bends, around the text's anchor and before its turn: each line from
  // its start to its end (to its ink, where a letter sticks out), as high and as low as its
  // fonts go. A paragraph's box counts too, as it is saved (see textToPsd in psd.js).
  const warpBoundsOf = (layer, doc) => {
    const lt = layer.params.layerText;
    const relative = relativeLayout(lt, doc.resolution);
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    relative.lines.forEach((line) => {
      if (!line.m.placed.length) return;
      const last = line.m.placed[line.m.placed.length - 1];
      const end = line.m.advance + endKernOf(last.run.style, Array.from(last.shown).pop()) * last.size * last.scaleX;
      left = Math.min(left, line.x, line.x + line.m.inkLeft);
      right = Math.max(right, line.x + end, line.x + line.m.inkRight);
      line.m.placed.forEach((item) => {
        if (item.upright) {
          // An upright character of a vertical text: its square (Photoshop's bounds of a
          // vertical line are 1 em wide, measured in Photoshop 2026)
          const axis = line.baseline - item.shift - (item.upright.base - 0.5) * item.size;
          top = Math.min(top, axis - item.size * item.scaleX * 0.5);
          bottom = Math.max(bottom, axis + item.size * item.scaleX * 0.5);
          return;
        }
        const { rise, fall } = boundsSharesOf(item.run.style);
        top = Math.min(top, line.baseline - item.shift - rise * item.size * item.scaleY);
        bottom = Math.max(bottom, line.baseline - item.shift + fall * item.size * item.scaleY);
      });
    });
    if (!isFinite(left)) left = top = right = bottom = 0;
    const shape = boxShape(lt);
    if (shape) {
      // As the lines were set: a vertical text's box the other way round
      const wide = relative.vertical ? shape.box.height : shape.box.width;
      const high = relative.vertical ? shape.box.width : shape.box.height;
      const height = relative.overflow ? high : Math.max(shape.box.autoHeight ? 0 : high - relative.shift, relative.contentHeight * 1.08);
      left = Math.min(left, 0);
      right = Math.max(right, wide);
      top = Math.min(top, relative.shift);
      bottom = Math.max(bottom, relative.shift + height);
    }
    // Where it shows around the anchor, as the rest of a vertical text's layout
    return relative.vertical ? rectFrom(-bottom, left, -top, right) : rectFrom(left, top, right, bottom);
  };
  // From the text's own frame (around its anchor) to where it lands, anchor aside: warped, then
  // turned as the text is
  const envelopeMapOf = (layer, doc) => {
    const warped = window.TypeRTextWarp.mapOf(layer.envelope, warpBoundsOf(layer, doc));
    const spin = (layer.rotated && layer.spin) || [1, 0, 0, 1];
    return (x, y) => {
      const [X, Y] = warped(x, y);
      return [spin[0] * X + spin[2] * Y, spin[1] * X + spin[3] * Y];
    };
  };
  // What shows of it on the page: where the box of its ink lands
  const envelopeBounds = (layer, doc) => {
    const b = relativeLayout(layer.params.layerText, doc.resolution).box;
    const map = envelopeMapOf(layer, doc);
    const [ax, ay] = anchorOf(layer.params.layerText, doc);
    const points = [];
    for (let j = 0; j <= 12; j++) for (let i = 0; i <= 24; i++) {
      const [x, y] = map(b.left + (b.width * i) / 24, b.top + (b.height * j) / 12);
      points.push([ax + x, ay + y]);
    }
    return boundsOfPoints(points);
  };

  // A text turned in Photoshop stays turned when it's edited, around its anchor
  const spinOf = (layer) => (layer.rotated && layer.spin && !layer.warp ? layer.spin : null);
  // A spin whose sides aren't square any more: a skewed text (Free Transform, or Photoshop's)
  const skewedSpin = (m) => Boolean(m) && Math.abs(m[0] * m[2] + m[1] * m[3]) > 1e-6 * Math.hypot(m[0], m[1]) * Math.hypot(m[2], m[3]);
  // Turned only, or grown as much both ways: a stroke drawn through it stays as wide all round
  const evenSpin = (m) => !skewedSpin(m) && Math.abs(Math.hypot(m[0], m[1]) - Math.hypot(m[2], m[3])) < 1e-6 * Math.hypot(m[2], m[3]);
  // The size of a text's last run, as grownText takes it
  const lastSize = (layer) => {
    const ranges = layer.params.layerText.textStyleRange;
    const style = ranges.length ? ranges[ranges.length - 1].textStyle : null;
    return style ? style.impliedFontSize || style.size || 14 : 0;
  };
  const spunBounds = (box, [a, b, c, d]) => {
    const xs = [];
    const ys = [];
    [[box.left, box.top], [box.right, box.top], [box.left, box.bottom], [box.right, box.bottom]].forEach(([x, y]) => {
      xs.push(a * x + c * y);
      ys.push(b * x + d * y);
    });
    return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
  };

  // A text layer read from a PSD shows Photoshop's own pixels until its text changes
  const boxOf = (layer, doc) => {
    if (layer.kind === "text") {
      if (layer.raster) return rectFrom(layer.raster.left, layer.raster.top, layer.raster.left + layer.raster.bitmap.width, layer.raster.top + layer.raster.bitmap.height);
      if (layer.warp) {
        const { source } = layer.warp;
        const b = relativeLayout(layer.params.layerText, doc.resolution).box;
        return boundsOfPoints(surfaceEdge(layer.warp, (b.left - source.left) / source.width, (b.top - source.top) / source.height, (b.right - source.left) / source.width, (b.bottom - source.top) / source.height));
      }
      if (meshOn(layer)) return meshBounds(layer, doc);
      if (envelopeOn(layer)) return envelopeBounds(layer, doc);
      const layout = layoutLayer(layer, doc);
      if (!spinOf(layer)) return layout.box;
      const { minX, minY, maxX, maxY } = spunBounds(layout.relative.box, spinOf(layer));
      return rectFrom(layout.anchor[0] + minX, layout.anchor[1] + minY, layout.anchor[0] + maxX, layout.anchor[1] + maxY);
    }
    const visual = visualOf(layer, doc);
    if (!visual) return rectFrom(0, 0, 0, 0);
    return rectFrom(visual.x, visual.y, visual.x + visual.canvas.width, visual.y + visual.canvas.height);
  };

  const rgbCss = (color) => (color ? `rgb(${color.red},${color.green},${color.blue})` : "#000");

  // Photoshop's Fill: how much of a layer's own pixels show, its stroke left whole. 0 is the
  // hollow text of an SFX (`knockout`); a value between, `fill`.
  const fillOf = (layer) => (!layer ? 1 : layer.knockout ? 0 : layer.fill === undefined ? 1 : Math.max(0, Math.min(1, layer.fill)));

  // A text layer's effects, as Photoshop's layer style: `layer.effects`, one of each at most,
  // drawn only when `enabled`. Opacities, spread and choke in percent, sizes and distances in
  // pixels, angles in degrees as Photoshop's (where the light comes from), blends by the
  // names of BLENDS. A gradient's stops are the Gradient tool's: { at, r, g, b, a }.
  const FX_ORDER = ["dropShadow", "outerGlow", "innerShadow", "innerGlow", "colorOverlay", "gradientOverlay"];
  const FX_DEFAULTS = {
    dropShadow: { enabled: true, blend: "normal", color: { r: 0, g: 0, b: 0 }, opacity: 75, angle: 120, distance: 5, spread: 0, size: 5 },
    outerGlow: { enabled: true, blend: "normal", color: { r: 255, g: 255, b: 255 }, opacity: 100, spread: 0, size: 8 },
    innerShadow: { enabled: true, blend: "normal", color: { r: 0, g: 0, b: 0 }, opacity: 75, angle: 120, distance: 5, choke: 0, size: 5 },
    innerGlow: { enabled: true, blend: "normal", color: { r: 255, g: 255, b: 255 }, opacity: 75, choke: 0, size: 5 },
    colorOverlay: { enabled: true, blend: "normal", color: { r: 255, g: 0, b: 0 }, opacity: 100 },
    gradientOverlay: { enabled: true, blend: "normal", opacity: 100, stops: [{ at: 0, r: 0, g: 0, b: 0, a: 1 }, { at: 1, r: 255, g: 255, b: 255, a: 1 }], style: "linear", angle: 90, scale: 100, reverse: false },
  };
  const fxDefault = (name) => JSON.parse(JSON.stringify(FX_DEFAULTS[name]));
  // The effects of a layer that are drawn, or null. A text's are TypeR's to edit; a pixel
  // layer's or a folder's come from its file (an SFX made in Photoshop) and are only drawn.
  const FX_KINDS = new Set(["text", "raster", "group"]);
  // Drawn too, from a file, though not edited here: a Pattern Overlay, the file's own pattern
  const FX_DRAWN = FX_ORDER.concat("patternOverlay");
  const effectsOn = (layer) => {
    const effects = layer && FX_KINDS.has(layer.kind) && !layer.adjustment && layer.effects;
    if (!effects) return null;
    return FX_DRAWN.some((name) => effects[name] && effects[name].enabled !== false) ? effects : null;
  };
  // A file's patterns, by their id: RGBA, as the file has them. Taken from the open documents'
  // files, so that a document opened again from the session still finds its own.
  const patternPictures = new Map();
  const patternOf = (id) => {
    if (!id) return null;
    if (patternPictures.has(id)) return patternPictures.get(id);
    for (const doc of app.docs) {
      const list = doc.psd && doc.psd.source && doc.psd.source.patterns;
      const found = Array.isArray(list) && list.find((item) => item && item.id === id && item.data && item.bounds);
      if (found) {
        const picture = { w: found.bounds.w, h: found.bounds.h, data: found.data };
        patternPictures.set(id, picture);
        return picture;
      }
    }
    return null;
  };
  // A stroke's Position, as Photoshop's: outside the letters (TypeR's and Photoshop's default),
  // inside them, or centred on their edge. How much of it lies outside them:
  const strokeOutside = (stroke) => (!stroke ? 0 : stroke.position === "inner" ? 0 : stroke.position === "center" ? stroke.size / 2 : stroke.size);
  // How far a stroke reaches past the letters: its part outside them, plus the stroke around it
  // if any, which goes around its outer edge
  const strokeReach = (stroke) => (stroke ? strokeOutside(stroke) + (stroke.outer && stroke.outer.size > 0 ? stroke.outer.size : 0) : 0);
  // A stroke's Opacity, the stroke's or the stroke around it's (`stroke.outer`), 0 to 1. As in
  // Photoshop, each is laid as one shape at that much: where letters overlap, it isn't darker.
  const strokeAlpha = (stroke) => (!stroke || stroke.opacity === undefined ? 1 : Math.max(0, Math.min(1, stroke.opacity / 100)));
  const strokeFaded = (stroke) => Boolean(stroke) && (strokeAlpha(stroke) < 1 || Boolean(stroke.outer && stroke.outer.size > 0 && strokeAlpha(stroke.outer) < 1));

  const drawLines = (ctx, lines, stroke, layer) => {
    const paragraph = layer.params.layerText.paragraphStyleRange && layer.params.layerText.paragraphStyleRange[0];
    const antiAlias = layer.params.layerText.antiAlias || "antiAliasSmooth";
    const direction = paragraph && paragraph.paragraphStyle && paragraph.paragraphStyle.directionType;
    // A vertical text's lines are set as a horizontal one's: turned here, a quarter clockwise
    // around the text's anchor (see verticalOf)
    const vertical = verticalOf(layer.params.layerText);
    ctx.save();
    if (vertical) ctx.rotate(Math.PI / 2);
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    if ("direction" in ctx) ctx.direction = direction === "dirRightToLeft" ? "rtl" : "ltr";
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    // One run at its own width, height and baseline shift, as Photoshop draws it
    const place = (g, line, item, draw) => {
      const glyph = item.upright;
      setRunFont(g, item.run.style, item.size, Boolean(glyph));
      g.save();
      if (glyph) {
        // Stood upright again in its square: its origin as far along the line as its baseline
        // is below the top of the square, and half its width from the middle of the line
        g.translate(line.x + item.x + (glyph.base + glyph.dy) * item.size * item.scaleY, line.baseline - item.shift - (glyph.base - 0.5) * item.size + (glyph.w / 2 - glyph.dx) * item.size * item.scaleX);
        g.rotate(-Math.PI / 2);
      } else g.translate(line.x + item.x, line.baseline - item.shift);
      g.scale(item.scaleX, item.scaleY);
      draw();
      g.restore();
    };
    // Where a run's letters are drawn, in its own units: once, or for a Faux Bold drawn again
    // to the right and below, at the corners of that reach, and half way across when the font's
    // strokes are too thin to fill the gap between two copies. The anti-aliasing method's own
    // outline (Sharp's) then goes into the reach, half of it on every side: no outline to draw.
    const copiesOf = (weight, item) => {
      if (!weight.right && !weight.down) return [[0, 0]];
      const left = -weight.page / 2 / item.scaleX;
      const right = (weight.right + weight.page / 2) / item.scaleX;
      const top = -weight.page / 2 / item.scaleY;
      const bottom = (weight.down + weight.page / 2) / item.scaleY;
      const across = weight.right + weight.page > 0.35 * stemWidthOf(item.run.style) * item.size ? [left, (left + right) / 2, right] : [left, right];
      // A run that lies on its side in a vertical text has the page's bottom along it and the
      // page's right above it
      if (vertical && !item.upright) return across.map((x) => [(top * item.scaleY) / item.scaleX, (-x * item.scaleX) / item.scaleY]).concat(across.map((x) => [(bottom * item.scaleY) / item.scaleX, (-x * item.scaleX) / item.scaleY]));
      return across.map((x) => [x, top]).concat(across.map((x) => [x, bottom]));
    };
    // The outline a run's letters are given, in its own units, which its width and height scale
    const outlineOf = (weight, item) => (weight.right || weight.down ? 0 : weight.around + weight.page / Math.max(item.scaleX, item.scaleY));
    // Every letter's outline, `reach` pixels each side of it. Letters outlined to be heavier
    // end half their own outline further out: a stroke outside them reaches that much further,
    // the part of a stroke `inside` them that much less.
    const outline = (g, color, reach, inside) => {
      g.strokeStyle = colorCss(color);
      lines.forEach((line) => {
        line.m.placed.forEach((item) => {
          place(g, line, item, () => {
            const weight = weightOf(item.run.style, item.size, antiAlias);
            const bold = outlineOf(weight, item);
            g.lineWidth = Math.max(0.1, reach * 2 + (inside ? -bold : bold));
            const copies = copiesOf(weight, item);
            g.strokeText(item.shown, ...copies[0]);
            if (copies.length > 1) g.strokeText(item.shown, ...copies[copies.length - 1]);
          });
        });
      });
    };
    // A canvas the size of this one, with its transform, to draw a part apart
    const apart = () => {
      const g = newCanvas(ctx.canvas.width, ctx.canvas.height).getContext("2d");
      g.setTransform(ctx.getTransform());
      g.textBaseline = ctx.textBaseline;
      g.textAlign = ctx.textAlign;
      if ("direction" in g) g.direction = ctx.direction;
      g.lineJoin = "round";
      g.miterLimit = 2;
      return g;
    };
    const letters = (g, hollow) => lines.forEach((line) => {
      line.m.placed.forEach((item) => {
        place(g, line, item, () => {
          g.fillStyle = hollow ? "#000" : rgbCss(item.run.style.color);
          // Faux Bold, Extra Bold and the anti-aliasing method's own weight, as Photoshop
          // draws them (see weightOf)
          const weight = weightOf(item.run.style, item.size, antiAlias);
          const copies = copiesOf(weight, item);
          copies.forEach(([x, y]) => g.fillText(item.shown, x, y));
          const bold = outlineOf(weight, item);
          if (bold) {
            g.strokeStyle = g.fillStyle;
            g.lineWidth = bold;
            // Photoshop's outline has sharp corners
            g.lineJoin = weight.around ? "miter" : "round";
            g.miterLimit = weight.around ? 4 : 2;
            g.strokeText(item.shown, 0, 0);
          }
        });
      });
    });
    // A stroke with Fill Type Gradient: its gradient spans the letters' bounds (drawn apart once
    // to measure them), in the canvas's pixels
    let shapeApart = null;
    const lettersApart = () => {
      if (!shapeApart) {
        shapeApart = apart();
        letters(shapeApart, true);
      }
      return shapeApart.canvas;
    };
    const canvasScale = () => {
      const m = ctx.getTransform();
      return Math.hypot(m.a, m.b) || 1;
    };
    const BLACK = { r: 0, g: 0, b: 0 };
    // A stroke below 100%, or painted with a gradient: all its letters' outlines drawn apart,
    // then laid on at that much
    const ringAt = (color, reach, alpha) => {
      const painted = Boolean(color && color.gradient) && Boolean(ctx.canvas && ctx.canvas.width && ctx.canvas.height);
      if (!painted && (alpha >= 1 || !(ctx.canvas && ctx.canvas.width && ctx.canvas.height))) {
        outline(ctx, color && color.gradient ? BLACK : color, reach);
        return;
      }
      const g = apart();
      outline(g, painted ? BLACK : color, reach);
      if (painted) paintIn(g, color, lettersApart(), 0, canvasScale());
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = alpha;
      ctx.drawImage(g.canvas, 0, 0);
      ctx.restore();
    };
    // The stroke's part outside the letters is drawn under them, its part inside over them
    const outside = strokeOutside(stroke);
    const inside = stroke ? stroke.size - outside : 0;
    // The stroke around the stroke first, as wide as both, then the stroke over it
    if (stroke && stroke.outer && stroke.outer.size > 0) ringAt(stroke.outer.color, strokeReach(stroke), strokeAlpha(stroke.outer));
    if (outside > 0) ringAt(strokePaint(stroke), outside, strokeAlpha(stroke));
    // Photoshop's Fill: the letters at that much, their stroke whole. At 0% (a hollow text)
    // the letters let the page through the stroke.
    const fill = fillOf(layer);
    if (fill < 1 && stroke) {
      ctx.globalCompositeOperation = "destination-out";
      letters(ctx, true);
      ctx.globalCompositeOperation = "source-over";
    }
    if (fill > 0) {
      ctx.globalAlpha = fill;
      letters(ctx, false);
      ctx.globalAlpha = 1;
    }
    // The part inside: the outline, kept where the letters are, over them. Canvas can't clip
    // to text: the outline and the letters are drawn apart, with the same transform, the
    // letters cut the outline all at once, and it is laid on.
    if (inside > 0 && ctx.canvas && ctx.canvas.width && ctx.canvas.height) {
      const ring = apart();
      const painted = strokeIsGradient(stroke);
      outline(ring, painted ? BLACK : stroke.color, Math.max(0.05, inside), true);
      const shape = lettersApart();
      ring.setTransform(1, 0, 0, 1, 0, 0);
      ring.globalCompositeOperation = "destination-in";
      ring.drawImage(shape, 0, 0);
      if (painted) paintIn(ring, strokePaint(stroke), shape, 0, canvasScale());
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = strokeAlpha(stroke);
      ctx.drawImage(ring.canvas, 0, 0);
    }
    ctx.restore();
  };

  // Vector drawing, at any scale (the site's pictures use it)
  const drawTextLayer = (ctx, layer, doc) => {
    const layout = layoutLayer(layer, doc);
    const stroke = layer.stroke && layer.stroke.enabled && layer.stroke.size > 0 ? layer.stroke : null;
    if (layout.vertical) {
      // Turned around its anchor (see drawLines)
      ctx.save();
      ctx.translate(layout.anchor[0], layout.anchor[1]);
      drawLines(ctx, layout.relative.lines, stroke, layer);
      ctx.restore();
    } else drawLines(ctx, layout.lines, stroke, layer);
    return layout.box;
  };

  // The paragraph box of a text: its own wrapping box, or where one starts if converted from
  // point text (top at anchor - firstOffset so the first baseline stays where it is)
  const textBoxOf = (layer, doc) => {
    if (layer.kind !== "text" || layer.rotated || meshOn(layer)) return boxOf(layer, doc);
    if (layer.warp) return boundsOfPoints(surfaceEdge(layer.warp, 0, 0, 1, 1));
    const layout = layoutLayer(layer, doc);
    if (layout.frame) return layout.frame;
    if (layer.raster) return boxOf(layer, doc);
    const b = layout.box;
    if (layout.vertical) return rectFrom(Math.min(b.left, firstEdgeOf(layout) - 1), b.top, firstEdgeOf(layout), b.bottom);
    return rectFrom(b.left, layout.anchor[1] - layout.relative.firstOffset, b.right, Math.max(b.bottom, layout.anchor[1] - layout.relative.firstOffset + 1));
  };
  // Where the right edge of a vertical point text's box would be: as far right of its first
  // baseline as the first baseline of a box is from its edge
  const firstEdgeOf = (layout) => {
    const first = layout.relative.lines[0];
    return layout.anchor[0] - (first ? first.baseline : 0) + layout.relative.firstOffset;
  };

  // The selection frame around a text's content, as Photoshop's transform controls draw it:
  // tightly around the letters (whether point text or paragraph text), falling back on the
  // paragraph box or the first line while the text is still empty
  const frameOf = (layer, doc) => {
    if (layer.kind !== "text" || layer.rotated || meshOn(layer)) return boxOf(layer, doc);
    if (layer.warp) return boundsOfPoints(surfaceEdge(layer.warp, 0, 0, 1, 1));
    if (layer.raster) return boxOf(layer, doc);
    const layout = layoutLayer(layer, doc);
    const b = layout.box;
    if (b.right > b.left || b.bottom > b.top) return b;
    if (layout.frame) return layout.frame;
    if (layout.vertical) return rectFrom(Math.min(b.left, firstEdgeOf(layout) - 1), b.top, firstEdgeOf(layout), b.bottom);
    return rectFrom(b.left, layout.anchor[1] - layout.relative.firstOffset, b.right, Math.max(b.bottom, layout.anchor[1] - layout.relative.firstOffset + 1));
  };

  // How far a text is turned, in radians: 0 for a straight one. One in perspective, as far
  // as the top edge of its surface.
  const turnOf = (layer) => {
    if (layer.warp) {
      const [a, b] = layer.warp.corners;
      return Math.atan2(b[1] - a[1], b[0] - a[0]);
    }
    const spin = spinOf(layer);
    return spin ? Math.atan2(spin[1], spin[0]) : 0;
  };
  // A text's frame as it shows: the box its handles sit on, turned with it around its anchor.
  // The corners go clockwise from the top left.
  const turnedFrame = (layer, doc) => {
    const f = frameOf(Object.assign({}, layer, { rotated: false, spin: null, raster: null, mesh: null, outline: null }), doc);
    const spin = spinOf(layer) || [1, 0, 0, 1];
    const [ax, ay] = anchorOf(layer.params.layerText, doc);
    const at = (x, y) => [ax + spin[0] * (x - ax) + spin[2] * (y - ay), ay + spin[1] * (x - ax) + spin[3] * (y - ay)];
    return {
      corners: [at(f.left, f.top), at(f.right, f.top), at(f.right, f.bottom), at(f.left, f.bottom)],
      center: at(f.left + f.width / 2, f.top + f.height / 2),
      angle: turnOf(layer),
      width: f.width,
      height: f.height,
    };
  };

  /* ========================== outlines, wand ========================= */

  // Follows the cracks between selected and unselected pixels: closed rings
  const traceMask = (mask, w, h, offsetX, offsetY) => {
    const stride = w + 1;
    // The cracks leaving each corner: 1 right, 2 down, 4 left, 8 up. Two leave a corner only
    // where the selection touches itself (a saddle): then left or up (the crack of the pixel
    // met first) comes before right or down.
    const edges = new Uint8Array(stride * (h + 1));
    for (let y = 0; y < h; y++) {
      const row = y * w;
      const corner = y * stride;
      const first = y === 0;
      const last = y === h - 1;
      for (let x = 0; x < w; x++) {
        if (!mask[row + x]) continue;
        // A run of selected pixels: a crack up its left side, one down its right side, and
        // one over or under each pixel that has none selected above or below
        const from = x;
        while (x < w && mask[row + x]) x++;
        edges[corner + stride + from] |= 8;
        edges[corner + x] |= 2;
        for (let k = from; k < x; k++) {
          if (first || !mask[row + k - w]) edges[corner + k] |= 1;
          if (last || !mask[row + k + w]) edges[corner + stride + k + 1] |= 4;
        }
      }
    }
    const step = (at, bit) => (bit === 1 ? at + 1 : bit === 2 ? at + stride : bit === 4 ? at - 1 : at - stride);
    const rings = [];
    for (let start = 0; start < edges.length; start++) {
      while (edges[start]) {
        const ring = [];
        let at = start;
        let previous = -1;
        do {
          const x = at % stride;
          const y = (at - x) / stride;
          ring.push([x + offsetX, y + offsetY]);
          const bits = edges[at];
          const saddle = bits & (bits - 1);
          const a = saddle ? bits & 12 : bits;
          let to = step(at, a);
          if (saddle && previous !== -1) {
            // A saddle: keep turning the same way so rings stay simple
            const dx = x - (previous % stride);
            const dy = y - (previous - (previous % stride)) / stride;
            const ax = (to % stride) - x;
            const ay = (to - (to % stride)) / stride - y;
            const cross = dx * ay - dy * ax;
            if (cross < 0) {
              to = step(at, bits & 3);
              edges[at] = a;
            } else edges[at] = bits & 3;
          } else if (saddle) edges[at] = bits & 3;
          else edges[at] = 0;
          previous = at;
          at = to;
        } while (at !== start && edges[at]);
        if (ring.length >= 4) rings.push(ring);
      }
    }
    return rings;
  };

  const ringArea = (ring) => {
    let sum = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    return Math.abs(sum) / 2;
  };

  const perpendicular = (p, a, b) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = dx * dx + dy * dy;
    if (!length) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    return Math.abs(dx * (a[1] - p[1]) - dy * (a[0] - p[0])) / Math.sqrt(length);
  };

  const simplifyOpen = (points, tolerance) => {
    if (points.length < 3) return points.slice();
    const keep = new Uint8Array(points.length);
    keep[0] = keep[points.length - 1] = 1;
    const stack = [[0, points.length - 1]];
    while (stack.length) {
      const [first, last] = stack.pop();
      let worst = 0;
      let at = -1;
      for (let i = first + 1; i < last; i++) {
        const d = perpendicular(points[i], points[first], points[last]);
        if (d > worst) {
          worst = d;
          at = i;
        }
      }
      if (worst > tolerance && at > 0) {
        keep[at] = 1;
        stack.push([first, at], [at, last]);
      }
    }
    return points.filter((_, i) => keep[i]);
  };

  // Photoshop's "make work path" with a 2 px tolerance, as straight segments
  const simplifyRing = (ring, tolerance) => {
    let far = 0;
    let best = -1;
    for (let i = 1; i < ring.length; i++) {
      const d = (ring[i][0] - ring[0][0]) ** 2 + (ring[i][1] - ring[0][1]) ** 2;
      if (d > best) {
        best = d;
        far = i;
      }
    }
    const a = simplifyOpen(ring.slice(0, far + 1), tolerance);
    const b = simplifyOpen(ring.slice(far).concat([ring[0]]), tolerance);
    return a.slice(0, -1).concat(b.slice(0, -1));
  };

  const ringsToPath = (rings) => {
    const px = (value) => ({ _unit: "pixelsUnit", _value: value });
    return {
      pathContents: {
        pathComponents: [{
          subpathListKey: rings.map((ring) => ({
            closedSubpath: true,
            points: ring.map((p) => ({ anchor: { horizontal: px(p[0]), vertical: px(p[1]) } })),
          })),
        }],
      },
    };
  };

  /* ============================== painting ============================= */

  const NONE = [];
  const newCanvas = (width, height) => {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(width));
    canvas.height = Math.max(1, Math.ceil(height));
    return canvas;
  };
  // A pixel layer's picture as a canvas, whatever it came as (an ImageBitmap, an <img>, pixels):
  // one user's had become something else, and every look at its pixels failed. Said once, with
  // what it was, so that the anonymous error reports tell where it came from.
  const asCanvases = new WeakMap();
  let toldOdd = false;
  const asCanvas = (picture) => {
    if (!picture || typeof picture !== "object" || typeof picture.getContext === "function") return picture;
    let canvas = asCanvases.get(picture);
    if (canvas) return canvas;
    if (!toldOdd) {
      toldOdd = true;
      if (window.TypeRStats) window.TypeRStats.error(new Error(`A layer picture is a ${Object.prototype.toString.call(picture)}`));
    }
    canvas = newCanvas(picture.width || 1, picture.height || 1);
    const ctx = canvas.getContext("2d");
    try {
      if (picture.data && picture.data.length === canvas.width * canvas.height * 4) ctx.putImageData(picture instanceof ImageData ? picture : new ImageData(new Uint8ClampedArray(picture.data), canvas.width, canvas.height), 0, 0);
      else ctx.drawImage(picture, 0, 0);
    } catch (error) {
      // Nothing that can be drawn: an empty layer
    }
    asCanvases.set(picture, canvas);
    return canvas;
  };
  // A canvas larger than the graphics card's largest texture (16384 pixels, 8192 on some
  // cards: a webtoon strip) is drawn by the processor. A small canvas the card holds, drawn on
  // it, is read back from the card every time: some 40 ms a dab on a slow laptop. Drawn often
  // on such a canvas, a picture is copied once into one the processor holds, as its pixels: a
  // canvas drawn into it would still be read back from the card.
  let gpuSide = 0;
  const offCard = (canvas) => {
    if (!gpuSide) {
      try {
        const gl = document.createElement("canvas").getContext("webgl");
        gpuSide = gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : 0;
        const lose = gl && gl.getExtension("WEBGL_lose_context");
        if (lose) lose.loseContext();
      } catch (error) {
        gpuSide = 0;
      }
      if (!gpuSide) gpuSide = 8192;
    }
    return Math.max(canvas.width, canvas.height) > gpuSide;
  };
  const offCardCopy = (picture) => {
    const canvas = newCanvas(picture.width, picture.height);
    canvas.getContext("2d", { willReadFrequently: true }).putImageData(picture.getContext("2d").getImageData(0, 0, picture.width, picture.height), 0, 0);
    return canvas;
  };
  const colorCss = (color) => {
    if (!color) return "#000";
    if (color.red !== undefined) return `rgb(${color.red},${color.green},${color.blue})`;
    return `rgb(${color.r},${color.g},${color.b})`;
  };

  const tracePolygon = (ctx, polygon) => {
    ctx.beginPath();
    polygon.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
  };

  const traceStroke = (ctx, op, points) => {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = op.size;
    ctx.beginPath();
    points.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    if (points.length === 1) ctx.lineTo(points[0][0] + 0.01, points[0][1]);
  };

  // A selection as an alpha picture, in the document's coordinates
  // A rectangle is four numbers: a whole page selected costs nothing to paint through
  const clipOf = (selection, dx, dy) => {
    const b = selection.bounds;
    if (selection.source === "rectangle" && !selection.mask) return { x: b.left - dx, y: b.top - dy, width: b.width, height: b.height };
    return { canvas: selectionCanvas(selection), x: b.left - dx, y: b.top - dy };
  };
  const selectionCanvases = new WeakMap();
  const selectionCanvas = (selection) => {
    let canvas = selectionCanvases.get(selection);
    if (canvas) return canvas;
    const b = selection.bounds;
    canvas = newCanvas(b.width, b.height);
    const ctx = canvas.getContext("2d");
    if (selection.mask) {
      const m = selection.mask;
      const image = ctx.createImageData(m.width, m.height);
      // A selection made from a path has a soft edge (`alpha`, 0 to 255 a pixel): what is
      // filled, cleared or painted through it gets it. Its outline is where it is half selected.
      if (m.alpha) for (let i = 0; i < m.alpha.length; i++) image.data[i * 4 + 3] = m.alpha[i];
      else {
        for (let i = 0; i < m.data.length; i++) {
          if (m.data[i]) image.data[i * 4 + 3] = 255;
        }
      }
      ctx.putImageData(image, 0, 0);
    } else {
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    selectionCanvases.set(selection, canvas);
    return canvas;
  };

  // A soft brush can't be a line: it's stamped along the way, every tenth of its size, and the
  // stamps build up as in Photoshop. The spacing carries over from one segment to the next.
  const softStrokes = new WeakMap();
  const softStroke = (ctx, op, points) => {
    let state = softStrokes.get(op);
    if (!state) {
      const radius = op.size / 2;
      const side = Math.ceil(op.size) + 2;
      const dab = newCanvas(side, side);
      const c = dab.getContext("2d");
      const fade = c.createRadialGradient(side / 2, side / 2, radius * (op.hardness / 100), side / 2, side / 2, radius);
      for (let i = 0; i <= 8; i++) fade.addColorStop(i / 8, `rgba(0,0,0,${(Math.cos((i / 8) * Math.PI) + 1) / 2})`);
      c.fillStyle = fade;
      c.fillRect(0, 0, side, side);
      if (!op.erase) {
        c.globalCompositeOperation = "source-in";
        c.fillStyle = colorCss(op.color);
        c.fillRect(0, 0, side, side);
      }
      state = { dab: offCard(ctx.canvas) ? offCardCopy(dab) : dab, side, spacing: Math.max(1, op.size / 10), rest: 0 };
      softStrokes.set(op, state);
    }
    const stamp = (x, y) => ctx.drawImage(state.dab, x - state.side / 2, y - state.side / 2);
    if (points.length === 1) {
      state.rest = 0;
      stamp(points[0][0], points[0][1]);
      return;
    }
    const [a, b] = points;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let at = state.spacing - state.rest;
    while (at <= length) {
      stamp(a[0] + ((b[0] - a[0]) * at) / length, a[1] + ((b[1] - a[1]) * at) / length);
      at += state.spacing;
    }
    state.rest = length - (at - state.spacing);
  };
  const paintStroke = (ctx, op, points) => {
    if (op.hardness < 100) softStroke(ctx, op, points);
    else {
      traceStroke(ctx, op, points);
      ctx.stroke();
    }
  };

  /* ---- gradients ---- */

  // The Gradient tool's colours, mixed as Photoshop's methods mix them: Classic in the file's
  // own values, Linear in light, Perceptual in Oklab, where halfway looks halfway to the eye
  const toLight = (v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const fromLight = (v) => 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(Math.max(0, v), 1 / 2.4) - 0.055);
  const toOklab = ([r, g, b]) => {
    const [R, G, B] = [toLight(r), toLight(g), toLight(b)];
    const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
    const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
    const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
  };
  const fromOklab = ([L, a, b]) => {
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [fromLight(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), fromLight(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), fromLight(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)];
  };
  const GRADIENT_METHODS = {
    classic: [(c) => c, (c) => c],
    linear: [(c) => c.map(toLight), (c) => c.map(fromLight)],
    perceptual: [toOklab, fromOklab],
  };
  // Red, green, blue (0 to 255) and alpha (0 to 1) along the gradient, in 1024 steps.
  // `stops`: { at (0 to 1), r, g, b, a }.
  const GRADIENT_STEPS = 1024;
  const gradientTable = (stops, method) => {
    const [into, back] = GRADIENT_METHODS[method] || GRADIENT_METHODS.perceptual;
    const list = stops.slice().sort((a, b) => a.at - b.at).map((stop) => ({ at: stop.at, c: into([stop.r, stop.g, stop.b]), a: stop.a === undefined ? 1 : stop.a }));
    const table = new Float32Array((GRADIENT_STEPS + 1) * 4);
    let k = 0;
    for (let i = 0; i <= GRADIENT_STEPS; i++) {
      const t = i / GRADIENT_STEPS;
      while (k < list.length - 2 && t > list[k + 1].at) k++;
      const s0 = list[k];
      const s1 = list[Math.min(k + 1, list.length - 1)];
      const f = s1.at > s0.at ? Math.max(0, Math.min(1, (t - s0.at) / (s1.at - s0.at))) : t >= s1.at ? 1 : 0;
      const mixed = back([0, 1, 2].map((n) => s0.c[n] + (s1.c[n] - s0.c[n]) * f));
      table[i * 4] = Math.max(0, Math.min(255, mixed[0]));
      table[i * 4 + 1] = Math.max(0, Math.min(255, mixed[1]));
      table[i * 4 + 2] = Math.max(0, Math.min(255, mixed[2]));
      table[i * 4 + 3] = s0.a + (s1.a - s0.a) * f;
    }
    return table;
  };
  // Where a point of the page falls along the gradient, 0 at its start and 1 at its end.
  // Linear runs from the start to the end; the others are centred on the start.
  const gradientPlace = (spec) => {
    const [sx, sy] = spec.start;
    const dx = spec.end[0] - sx;
    const dy = spec.end[1] - sy;
    const length2 = dx * dx + dy * dy || 1;
    const length = Math.sqrt(length2);
    const turn = Math.atan2(dy, dx);
    switch (spec.type) {
      case "radial": return (x, y) => Math.hypot(x - sx, y - sy) / length;
      case "reflected": return (x, y) => Math.abs((x - sx) * dx + (y - sy) * dy) / length2;
      case "diamond": return (x, y) => (Math.abs((x - sx) * dx + (y - sy) * dy) + Math.abs((y - sy) * dx - (x - sx) * dy)) / length2;
      case "angle": return (x, y) => {
        const t = (turn - Math.atan2(y - sy, x - sx)) / (Math.PI * 2);
        return t - Math.floor(t);
      };
      default: return (x, y) => ((x - sx) * dx + (y - sy) * dy) / length2;
    }
  };
  // The gradient over `box` (page pixels), `scale` times its size. Dithered: half a level of
  // noise hides the bands a long, soft gradient shows in 8 bits. `gray`: for a mask, its grey
  // in the alpha of `canvas` and how much it covers in the alpha of `cover`.
  const renderGradient = (spec, box, scale = 1, gray = false) => {
    const w = Math.max(1, Math.round(box.width * scale));
    const h = Math.max(1, Math.round(box.height * scale));
    const table = gradientTable(spec.stops, spec.method);
    const place = gradientPlace(spec);
    const opacity = spec.opacity === undefined ? 1 : spec.opacity;
    const dither = spec.dither !== false;
    const image = new ImageData(w, h);
    const px = image.data;
    const covered = gray ? new ImageData(w, h) : null;
    const grays = gray ? new Float32Array(GRADIENT_STEPS + 1) : null;
    if (gray) for (let i = 0; i <= GRADIENT_STEPS; i++) grays[i] = 0.299 * table[i * 4] + 0.587 * table[i * 4 + 1] + 0.114 * table[i * 4 + 2];
    for (let y = 0; y < h; y++) {
      const py = box.top + (y + 0.5) / scale;
      for (let x = 0; x < w; x++) {
        let t = place(box.left + (x + 0.5) / scale, py);
        if (!(t > 0)) t = 0;
        else if (t > 1) t = 1;
        if (spec.reverse) t = 1 - t;
        const i = Math.round(t * GRADIENT_STEPS);
        const n = dither ? (52.9829189 * ((0.06711056 * x + 0.00583715 * y) % 1)) % 1 - 0.5 : 0;
        const a = table[i * 4 + 3] * opacity;
        const o = (y * w + x) * 4;
        if (gray) {
          px[o + 3] = grays[i] * a + n;
          covered.data[o + 3] = a * 255 + n;
        } else {
          px[o] = table[i * 4] + n;
          px[o + 1] = table[i * 4 + 1] + n;
          px[o + 2] = table[i * 4 + 2] + n;
          px[o + 3] = a * 255 + n;
        }
      }
    }
    const toCanvas = (data) => {
      const canvas = newCanvas(w, h);
      canvas.getContext("2d").putImageData(data, 0, 0);
      return canvas;
    };
    return gray ? { canvas: toCanvas(image), cover: toCanvas(covered) } : { canvas: toCanvas(image) };
  };
  // A gradient's picture over its box (drawn smaller while it was dragged), cut by its clip
  const gradientShape = (op, picture) => {
    if (!op.clip && picture.width === op.width && picture.height === op.height) return picture;
    const shape = newCanvas(op.width, op.height);
    const c = shape.getContext("2d");
    c.imageSmoothingQuality = "high";
    c.drawImage(picture, 0, 0, op.width, op.height);
    if (op.clip) {
      c.globalCompositeOperation = "destination-in";
      c.translate(-op.x, -op.y);
      if (op.clip.canvas) c.drawImage(op.clip.canvas, op.clip.x, op.clip.y);
      else c.fillRect(op.clip.x, op.clip.y, op.clip.width, op.clip.height);
    }
    return shape;
  };

  // What part of a layer a piece of stroke can touch, in whole pixels
  const strokeBox = (points, size) => {
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const left = Math.floor(Math.min(...xs) - size);
    const top = Math.floor(Math.min(...ys) - size);
    return { left, top, width: Math.ceil(Math.max(...xs) + size - left + 2), height: Math.ceil(Math.max(...ys) + size - top + 2) };
  };
  // A Clone Stamp stroke over `box`: where it passed, filled with the source, pixel for pixel
  const clonedPixels = (op, box, drawCoverage) => {
    const shape = newCanvas(box.width, box.height);
    const c = shape.getContext("2d");
    c.translate(-box.left, -box.top);
    drawCoverage(c);
    if (op.clip) {
      c.globalCompositeOperation = "destination-in";
      if (op.clip.canvas) c.drawImage(op.clip.canvas, op.clip.x, op.clip.y);
      else c.fillRect(op.clip.x, op.clip.y, op.clip.width, op.clip.height);
    }
    c.globalCompositeOperation = "source-in";
    c.drawImage(op.source.canvas, op.source.x, op.source.y);
    return shape;
  };
  // A stroke lays its source on the layer once. Segment by segment, each one over the last, a
  // half-transparent source would turn opaque: every segment starts again from the layer as it
  // was, with all the stroke so far.
  const cloneSegment = (entry, live, points) => {
    const { op } = live;
    if (!live.base) {
      live.base = newCanvas(entry.canvas.width, entry.canvas.height);
      live.base.getContext("2d").drawImage(entry.canvas, 0, 0);
      live.coverage = newCanvas(entry.canvas.width, entry.canvas.height);
      const c = live.coverage.getContext("2d");
      c.translate(-entry.cx0, -entry.cy0);
      c.strokeStyle = "#000";
    }
    paintStroke(live.coverage.getContext("2d"), op, points);
    const box = strokeBox(points, op.size);
    const pixels = clonedPixels(op, box, (c) => c.drawImage(live.coverage, entry.cx0, entry.cy0));
    entry.ctx.clearRect(box.left, box.top, box.width, box.height);
    entry.ctx.drawImage(live.base, box.left - entry.cx0, box.top - entry.cy0, box.width, box.height, box.left, box.top, box.width, box.height);
    entry.ctx.globalCompositeOperation = op.atop ? "source-atop" : "source-over";
    entry.ctx.drawImage(pixels, box.left, box.top);
    entry.ctx.globalCompositeOperation = "source-over";
  };

  // One painted thing on a layer, in the layer's own coordinates
  const drawOp = (ctx, op, points) => {
    ctx.save();
    // On a layer whose transparent pixels are locked, paint goes only where there are pixels
    const over = op.atop ? "source-atop" : "source-over";
    ctx.globalCompositeOperation = over;
    if (op.t === "poly") {
      const xs = op.polygon.map((p) => p[0]);
      const ys = op.polygon.map((p) => p[1]);
      const left = Math.floor(Math.min(...xs)) - 2;
      const top = Math.floor(Math.min(...ys)) - 2;
      const shape = newCanvas(Math.max(...xs) - left + 4, Math.max(...ys) - top + 4);
      const c = shape.getContext("2d");
      c.translate(-left, -top);
      tracePolygon(c, op.polygon);
      c.fillStyle = colorCss(op.color);
      c.fill();
      if (op.inset > 0) {
        c.globalCompositeOperation = "destination-out";
        c.lineWidth = op.inset * 2;
        c.lineJoin = "round";
        c.stroke();
      }
      ctx.drawImage(shape, left, top);
    } else if (op.t === "image") {
      ctx.drawImage(op.canvas, op.x, op.y);
    } else if (op.t === "gradient") {
      ctx.drawImage(gradientShape(op, op.canvas), op.x, op.y);
    } else if (op.t === "stroke" && op.source) {
      const box = strokeBox(op.points, op.size);
      const pixels = clonedPixels(op, box, (c) => {
        c.strokeStyle = "#000";
        op.points.forEach((point, index) => paintStroke(c, op, index ? [op.points[index - 1], point] : [point]));
      });
      ctx.drawImage(pixels, box.left, box.top);
    } else if (op.t === "stroke" && !points) {
      // Redrawn the way it was painted, segment by segment: its edges come out the same
      op.points.forEach((point, index) => drawOp(ctx, op, index ? [op.points[index - 1], point] : [point]));
    } else if (op.t === "stroke") {
      const list = points;
      if (op.clip) {
        const { left, top, width, height } = strokeBox(list, op.size);
        const shape = newCanvas(width, height);
        const c = shape.getContext("2d");
        c.translate(-left, -top);
        c.strokeStyle = "#000";
        paintStroke(c, op, list);
        c.globalCompositeOperation = "destination-in";
        if (op.clip.canvas) c.drawImage(op.clip.canvas, op.clip.x, op.clip.y);
        else c.fillRect(op.clip.x, op.clip.y, op.clip.width, op.clip.height);
        c.setTransform(1, 0, 0, 1, 0, 0);
        if (!op.erase) {
          c.globalCompositeOperation = "source-in";
          c.fillStyle = colorCss(op.color);
          c.fillRect(0, 0, shape.width, shape.height);
        }
        ctx.globalCompositeOperation = op.erase ? "destination-out" : over;
        ctx.drawImage(shape, left, top);
      } else {
        ctx.globalCompositeOperation = op.erase ? "destination-out" : over;
        ctx.strokeStyle = op.erase ? "#000" : colorCss(op.color);
        paintStroke(ctx, op, list);
      }
    } else if (op.t === "pixels") {
      // What a stroke of the Smudge, Blur or Sharpen tool left, in place of what was there
      ctx.globalCompositeOperation = "source-over";
      op.pieces.forEach((piece) => {
        ctx.clearRect(piece.x, piece.y, piece.canvas.width, piece.canvas.height);
        ctx.drawImage(piece.canvas, piece.x, piece.y);
      });
    } else if (op.t === "patch") {
      // Pixels made elsewhere (a Content-Aware Fill), laid within the selection they filled
      const shape = newCanvas(op.source.canvas.width, op.source.canvas.height);
      const c = shape.getContext("2d");
      c.drawImage(op.source.canvas, 0, 0);
      if (op.clip) {
        c.globalCompositeOperation = "destination-in";
        c.translate(-op.source.x, -op.source.y);
        if (op.clip.canvas) c.drawImage(op.clip.canvas, op.clip.x, op.clip.y);
        else c.fillRect(op.clip.x, op.clip.y, op.clip.width, op.clip.height);
      }
      ctx.drawImage(shape, op.source.x, op.source.y);
    } else if (op.t === "fill" && !op.clip.canvas) {
      ctx.globalCompositeOperation = op.erase ? "destination-out" : over;
      ctx.fillStyle = op.erase ? "#000" : colorCss(op.color);
      ctx.fillRect(op.clip.x, op.clip.y, op.clip.width, op.clip.height);
    } else if (op.t === "fill") {
      if (op.erase) {
        ctx.globalCompositeOperation = "destination-out";
        ctx.drawImage(op.clip.canvas, op.clip.x, op.clip.y);
      } else {
        const shape = newCanvas(op.clip.canvas.width, op.clip.canvas.height);
        const c = shape.getContext("2d");
        c.drawImage(op.clip.canvas, 0, 0);
        c.globalCompositeOperation = "source-in";
        c.fillStyle = colorCss(op.color);
        c.fillRect(0, 0, shape.width, shape.height);
        ctx.drawImage(shape, op.clip.x, op.clip.y);
      }
    }
    ctx.restore();
  };

  // Layer masks read from a PSD hold their value in the colour channels: as alpha, a canvas
  // can cut a picture with them. Kept by picture, which a moved mask still shares.
  const maskAlphas = new WeakMap();
  const maskAlpha = (mask) => {
    const source = mask.canvas;
    let canvas = maskAlphas.get(source);
    if (canvas) return canvas;
    canvas = newCanvas(source.width, source.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(source, 0, 0);
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < image.data.length; i += 4) image.data[i + 3] = image.data[i];
    ctx.putImageData(image, 0, 0);
    maskAlphas.set(source, canvas);
    return canvas;
  };

  // What a pixel layer looks like: its picture, what was painted on it, its mask.
  // A painted layer keeps one canvas and only draws what is new.
  // Rebuilt from the layer when needed again, so what isn't on screen can go: the oldest pages
  // first when the budget is spent, and all of a page when it closes.
  const RASTER_BUDGET = 512 * 1024 * 1024;
  const rasterCache = new Map();
  let rasterBytes = 0;
  const releaseCanvas = (canvas) => {
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  };
  const releaseVisual = (visual) => {
    if (!visual) return;
    releaseCanvas(visual.canvas);
    if (visual.under) visual.under.forEach((item) => releaseCanvas(item.canvas));
  };
  const forgetRaster = (id, entry) => {
    rasterBytes -= entry.bytes;
    rasterCache.delete(id);
    releaseCanvas(entry.canvas);
    entry.marks.forEach((mark) => releaseCanvas(mark.canvas));
    entry.marks.length = 0;
  };
  const keepRasterInBudget = () => {
    for (const [id, entry] of rasterCache) {
      if (rasterBytes <= RASTER_BUDGET) return;
      if (!app.doc || entry.docId !== app.doc.id) forgetRaster(id, entry);
    }
    if (rasterBytes <= RASTER_BUDGET || !app.doc) return;
    // The page on screen alone is over the budget: first the layers it no longer has (undone,
    // deleted: drawn again if they come back), then the pictures undo starts from
    const present = new Set(app.doc.state.layers.map((layer) => layer.id));
    for (const [id, entry] of rasterCache) {
      if (rasterBytes <= RASTER_BUDGET) return;
      if (!present.has(id)) forgetRaster(id, entry);
    }
    for (const entry of rasterCache.values()) {
      if (rasterBytes <= RASTER_BUDGET) return;
      while (entry.marks.length) {
        const gone = entry.marks.shift();
        const bytes = gone.canvas.width * gone.canvas.height * 4;
        releaseCanvas(gone.canvas);
        entry.bytes -= bytes;
        rasterBytes -= bytes;
      }
    }
  };
  const releaseScratch = () => {
    releaseCanvas(scratch);
    releaseCanvas(scratchShape);
    releaseCanvas(scratchRing);
    scratch = scratchShape = scratchRing = null;
  };
  const forgetDocPixels = (doc) => {
    if (!doc) return;
    for (const [id, entry] of rasterCache) {
      if (entry.docId === doc.id) forgetRaster(id, entry);
    }
    for (const [id, entry] of maskCache) {
      if (entry.docId === doc.id) {
        maskCache.delete(id);
        releaseMask(entry, true);
      }
    }
    for (const [id, entry] of maskedVisuals) {
      if (entry.docId === doc.id) {
        maskedVisuals.delete(id);
        releaseVisual(entry.visual);
      }
    }
    for (const [id, entry] of groupVisuals) {
      if (entry.docId === doc.id) {
        groupVisuals.delete(id);
        releaseVisual(entry.visual);
      }
    }
    const textPrefix = objectKey(doc) + "|";
    for (const [key, item] of drawnTexts) {
      if (key.startsWith(textPrefix)) {
        forgetRough(item);
        drawnTexts.delete(key);
      }
    }
    doc.sampleCache = null;
    doc.sampleKey = null;
  };
  // What a stroke changed on a canvas kept from one frame to the next, from one `version` to the
  // next (a rectangle of the canvas): what is made from it (its Fill, its mask's cut, its
  // effects) is brought up to date there only, not over a page 20000 pixels tall at every dab.
  // `touchedSince` gives null when it can't tell (the canvas changed some other way meanwhile).
  const touchLogs = new WeakMap();
  const touched = (canvas, from, to, rect) => {
    let log = touchLogs.get(canvas);
    if (!log || log.version !== from) {
      log = { base: from, version: from, steps: [] };
      touchLogs.set(canvas, log);
    }
    log.steps.push({ to, rect });
    log.version = to;
    if (log.steps.length > 512) log.base = log.steps.splice(0, 256).pop().to;
  };
  const touchedSince = (canvas, from, to) => {
    const log = touchLogs.get(canvas);
    if (from === to) return { left: 0, top: 0, right: 0, bottom: 0 };
    if (!log || log.version !== to || from < log.base || from > to) return null;
    let area = null;
    for (let i = log.steps.length - 1; i >= 0 && log.steps[i].to > from; i--) area = unionOf(area, log.steps[i].rect);
    return area;
  };
  const unionOf = (a, b) => (!a || emptyRect(a) ? b : !b || emptyRect(b) ? a : { left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) });
  // A rectangle of whole pixels inside a canvas
  const withinCanvas = (rect, canvas) => ({ left: Math.max(0, Math.floor(rect.left)), top: Math.max(0, Math.floor(rect.top)), right: Math.min(canvas.width, Math.ceil(rect.right)), bottom: Math.min(canvas.height, Math.ceil(rect.bottom)) });
  const emptyRect = (rect) => rect.right <= rect.left || rect.bottom <= rect.top;
  // A canvas drawn to and from `like` as cheaply as can be: held where `like` is (see offCard)
  const canvasLike = (like, width, height) => {
    const canvas = newCanvas(width, height);
    if (offCard(like)) canvas.getContext("2d", { willReadFrequently: true });
    return canvas;
  };

  // A picture of the layer every so many strokes, the last two: undoing replays a few of them
  const MARK_EVERY = 16;
  const markRaster = (entry, ops) => {
    if (entry.marks.some((item) => item.count === ops.length)) return;
    const canvas = newCanvas(entry.canvas.width, entry.canvas.height);
    canvas.getContext("2d").drawImage(entry.canvas, 0, 0);
    entry.marks.push({ canvas, ops, count: ops.length, bitmap: entry.bitmap, cx0: entry.cx0, cy0: entry.cy0 });
    let change = canvas.width * canvas.height * 4;
    if (entry.marks.length > 2) {
      const gone = entry.marks.shift();
      change -= gone.canvas.width * gone.canvas.height * 4;
      releaseCanvas(gone.canvas);
    }
    entry.bytes += change;
    rasterBytes += change;
    keepRasterInBudget();
  };
  const rasterEntry = (layer, doc) => {
    const paint = layer.paint || NONE;
    const dx = layer.dx || 0;
    const dy = layer.dy || 0;
    const left = layer.left || 0;
    const top = layer.top || 0;
    let entry = rasterCache.get(layer.id);
    const covers = entry && entry.cx0 <= Math.min(0, -dx) && entry.cy0 <= Math.min(0, -dy) && entry.cx1 >= Math.max(doc.width, doc.width - dx) && entry.cy1 >= Math.max(doc.height, doc.height - dy);
    const usable = entry && covers && entry.bitmap === layer.bitmap && entry.paint.length <= paint.length && entry.paint.every((op, i) => op === paint[i]);
    if (!usable) {
      const w = layer.bitmap ? layer.bitmap.width : 0;
      const h = layer.bitmap ? layer.bitmap.height : 0;
      const cx0 = Math.min(0, -dx, layer.bitmap ? left : 0);
      const cy0 = Math.min(0, -dy, layer.bitmap ? top : 0);
      const cx1 = Math.max(doc.width, doc.width - dx, left + w);
      const cy1 = Math.max(doc.height, doc.height - dy, top + h);
      const canvas = newCanvas(cx1 - cx0, cy1 - cy0);
      const ctx = canvas.getContext("2d");
      // Undo starts from the nearest picture saved along the way, not from the first stroke
      const mark = entry && entry.marks.filter((item) => item.bitmap === layer.bitmap && item.count <= paint.length && item.cx0 === cx0 && item.cy0 === cy0 && item.canvas.width === canvas.width && item.canvas.height === canvas.height && item.ops.every((op, i) => op === paint[i])).pop();
      if (mark) ctx.drawImage(mark.canvas, 0, 0);
      ctx.translate(-cx0, -cy0);
      if (layer.bitmap && !mark) ctx.drawImage(asCanvas(layer.bitmap), left, top);
      const previous = rasterCache.get(layer.id);
      if (previous) forgetRaster(layer.id, previous);
      const marks = entry ? entry.marks.filter((item) => item.bitmap === layer.bitmap && item.count <= paint.length && item.ops.every((op, i) => op === paint[i])) : [];
      entry = { canvas, ctx, cx0, cy0, cx1, cy1, bitmap: layer.bitmap, paint: mark ? paint.slice(0, mark.count) : NONE, version: 0, docId: doc.id, marks, bytes: canvas.width * canvas.height * 4 * (1 + marks.length) };
      rasterCache.set(layer.id, entry);
      rasterBytes += entry.bytes;
      keepRasterInBudget();
    }
    if (entry.paint.length < paint.length) {
      for (let i = entry.paint.length; i < paint.length; i++) {
        drawOp(entry.ctx, paint[i]);
        if ((i + 1) % MARK_EVERY === 0) markRaster(entry, paint.slice(0, i + 1));
      }
      entry.paint = paint;
      entry.version++;
    }
    return entry;
  };

  // Its mask is laid on it by visualOf, as on any layer. `version` tells a canvas painted on in
  // place from the one it was.
  const rasterVisual = (layer, doc) => {
    const paint = layer.paint || NONE;
    const dx = layer.dx || 0;
    const dy = layer.dy || 0;
    const live = doc.liveStroke && doc.liveStroke.layerId === layer.id && !doc.liveStroke.target;
    if (!paint.length && !live) {
      return layer.bitmap ? { canvas: asCanvas(layer.bitmap), x: (layer.left || 0) + dx, y: (layer.top || 0) + dy } : null;
    }
    const entry = rasterEntry(layer, doc);
    return { canvas: entry.canvas, x: entry.cx0 + dx, y: entry.cy0 + dy, version: entry.version };
  };

  /* ---- the Smudge, Blur and Sharpen tools ---- */

  // These tools read the pixels they paint over, each dab what the dab before it left, so they
  // can't be drawn again from the points of their stroke as the Brush is. A stroke works on a
  // copy of the pixels in the processor's memory, in tiles read from the layer (or from the page,
  // Sample All Layers) the first time the stroke reaches them: premultiplied, so that transparent
  // pixels carry no colour and nothing smears dark into them, and as floats, so that a light
  // touch still builds up. Each move writes back only the part of the layer it changed, and the
  // stroke ends as one step of history: the pixels it changed (a "pixels" paint step).
  // How they mix follows photocraft's retouching tools (github.com/storytold/photocraft, MIT or
  // Apache-2.0; the logic, not its code): the Smudge lays down the colour it carries, at Strength,
  // then picks up what it passed over, keeping Strength of what it had; the Blur mixes in a blur
  // of each dab, the Sharpen an unsharp mask held within the range of each pixel's neighbours,
  // so that it makes no halos.
  const RT_TILE = 128;
  const RT_ROW = RT_TILE * 4;
  const RT_KEY = 65536;
  // The Smudge's dabs, a twentieth of the brush apart: further, what it carries would show its
  // steps; closer, a large brush would lag
  const SMUDGE_SPACING = 0.05;

  // A brush's coverage over a square of `side` pixels centred on a pixel corner, falling as the
  // Brush's soft edge does (see softStroke): full out to its hardness, then along a cosine
  const dabCoverage = (size, hardness, side) => {
    const out = new Float32Array(side * side);
    const r = size / 2;
    const inner = r * hardness / 100;
    const hard = hardness >= 100 || r - inner < 0.5;
    const c = side / 2;
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        const d = Math.sqrt((x + 0.5 - c) ** 2 + (y + 0.5 - c) ** 2);
        out[y * side + x] = hard ? Math.max(0, Math.min(1, r - d + 0.5)) : d <= inner ? 1 : d >= r ? 0 : (Math.cos(((d - inner) / (r - inner)) * Math.PI) + 1) / 2;
      }
    }
    return out;
  };
  const rtBuffer = (rt, name, length) => {
    if (!rt[name] || rt[name].length < length) rt[name] = new Float32Array(length);
    return rt[name];
  };

  // The pixels of a rectangle of the page, as bytes (RGBA, straight): what the stroke works on
  // (with `all`, the page as it shows, without its texts), or with `target` the layer itself
  const rtRead = (rt, left, top, width, height, target) => {
    const doc = rt.doc;
    if (rt.gray) {
      const entry = maskEntry(maskHolder(doc, rt.target, rt.layerId), doc);
      const data = entry.ctx.getImageData(left - rt.ox - entry.x0, top - rt.oy - entry.y0, width, height).data;
      // A mask holds its grey as alpha: worked on as an opaque grey picture
      for (let i = 0; i < data.length; i += 4) {
        data[i] = data[i + 1] = data[i + 2] = data[i + 3];
        data[i + 3] = 255;
      }
      return data;
    }
    if (rt.all && !target) {
      const canvas = newCanvas(width, height);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      paintDoc(doc, ctx, { x: -left, y: -top, rect: { left, top, right: left + width, bottom: top + height }, skip: (item) => item.kind === "text" });
      return ctx.getImageData(0, 0, width, height).data;
    }
    const entry = rasterEntry(doc.state.layers.find((item) => item.id === rt.layerId), doc);
    return entry.ctx.getImageData(left - rt.ox - entry.cx0, top - rt.oy - entry.cy0, width, height).data;
  };
  // The tiles a rectangle of the page needs, those still missing read in one go
  const rtEnsure = (rt, left, top, right, bottom) => {
    const doc = rt.doc;
    let mx0 = Infinity;
    let my0 = Infinity;
    let mx1 = -1;
    let my1 = -1;
    for (let ty = Math.floor(top / RT_TILE); ty * RT_TILE < bottom; ty++) {
      for (let tx = Math.floor(left / RT_TILE); tx * RT_TILE < right; tx++) {
        if (rt.tiles.has(ty * RT_KEY + tx)) continue;
        mx0 = Math.min(mx0, tx);
        my0 = Math.min(my0, ty);
        mx1 = Math.max(mx1, tx);
        my1 = Math.max(my1, ty);
      }
    }
    if (mx1 < 0) return;
    const rl = mx0 * RT_TILE;
    const rtop = my0 * RT_TILE;
    const w = Math.min(doc.width, (mx1 + 1) * RT_TILE) - rl;
    const h = Math.min(doc.height, (my1 + 1) * RT_TILE) - rtop;
    const data = rtRead(rt, rl, rtop, w, h, false);
    const orig = rt.all ? rtRead(rt, rl, rtop, w, h, true) : null;
    for (let ty = my0; ty <= my1; ty++) {
      for (let tx = mx0; tx <= mx1; tx++) {
        const key = ty * RT_KEY + tx;
        if (rt.tiles.has(key)) continue;
        const tile = { px: new Float32Array(RT_TILE * RT_ROW), orig: orig ? new Uint8ClampedArray(RT_TILE * RT_ROW) : null, touched: orig ? new Uint8Array(RT_TILE * RT_TILE) : null, dirty: false };
        const x0 = tx * RT_TILE;
        const y0 = ty * RT_TILE;
        const tw = Math.min(RT_TILE, doc.width - x0);
        const th = Math.min(RT_TILE, doc.height - y0);
        const px = tile.px;
        for (let y = 0; y < th; y++) {
          const from = ((y0 - rtop + y) * w + (x0 - rl)) * 4;
          for (let x = 0, s = from, d = y * RT_ROW; x < tw; x++, s += 4, d += 4) {
            const a = data[s + 3];
            const f = a / 255;
            px[d] = data[s] * f;
            px[d + 1] = data[s + 1] * f;
            px[d + 2] = data[s + 2] * f;
            px[d + 3] = a;
          }
          if (orig) tile.orig.set(orig.subarray(from, from + tw * 4), y * RT_ROW);
        }
        rt.tiles.set(key, tile);
      }
    }
  };
  // Pixels (4 floats each, `width` a row) copied out of the tiles, or `back` into them
  const rtCopy = (rt, buf, left, top, width, height, back) => {
    const right = left + width;
    const bottom = top + height;
    for (let ty = Math.floor(top / RT_TILE); ty * RT_TILE < bottom; ty++) {
      for (let tx = Math.floor(left / RT_TILE); tx * RT_TILE < right; tx++) {
        const tile = rt.tiles.get(ty * RT_KEY + tx);
        const x0 = Math.max(left, tx * RT_TILE);
        const n = (Math.min(right, (tx + 1) * RT_TILE) - x0) * 4;
        if (back) tile.dirty = true;
        for (let y = Math.max(top, ty * RT_TILE); y < Math.min(bottom, (ty + 1) * RT_TILE); y++) {
          const t = (y - ty * RT_TILE) * RT_ROW + (x0 - tx * RT_TILE) * 4;
          const b = ((y - top) * width + (x0 - left)) * 4;
          if (back) tile.px.set(buf.subarray(b, b + n), t);
          else buf.set(tile.px.subarray(t, t + n), b);
        }
      }
    }
  };
  // Each pixel's share of a dab (`table`, over the dab's square from x0, y0) within the
  // selection, in `rt.kw`, `width` a row. False when the dab changes nothing.
  const rtWeights = (rt, table, x0, y0, left, top, width, height) => {
    const { side, sel, kw } = rt;
    let any = false;
    for (let y = 0; y < height; y++) {
      const py = top + y;
      let c = (py - y0) * side + (left - x0);
      let o = y * width;
      if (!sel) {
        for (let x = 0; x < width; x++, o++, c++) {
          kw[o] = table[c];
          if (table[c] > 0) any = true;
        }
      } else if (sel.mask) {
        const m = sel.mask;
        const my = py - sel.top;
        const row = my >= 0 && my < m.height ? my * m.width : -1;
        for (let x = 0; x < width; x++, o++, c++) {
          const mx = left + x - sel.left;
          kw[o] = row >= 0 && mx >= 0 && mx < m.width && m.data[row + mx] ? table[c] : 0;
          if (kw[o] > 0) any = true;
        }
      } else {
        const inRow = py + 0.5 > sel.top && py + 0.5 < sel.bottom;
        for (let x = 0; x < width; x++, o++, c++) {
          const px = left + x + 0.5;
          kw[o] = inRow && px > sel.left && px < sel.right ? table[c] : 0;
          if (kw[o] > 0) any = true;
        }
      }
    }
    return any;
  };
  // Sampling all layers, the target takes the page's pixels where a dab passed
  const rtTouch = (rt, left, top, width, height) => {
    const kw = rt.kw;
    for (let y = 0; y < height; y++) {
      const py = top + y;
      const ty = Math.floor(py / RT_TILE);
      const row = (py - ty * RT_TILE) * RT_TILE;
      let tile = null;
      let tx = -1;
      for (let x = 0; x < width; x++) {
        if (!(kw[y * width + x] > 0)) continue;
        const px = left + x;
        if (Math.floor(px / RT_TILE) !== tx) {
          tx = Math.floor(px / RT_TILE);
          tile = rt.tiles.get(ty * RT_KEY + tx);
        }
        tile.touched[row + px - tx * RT_TILE] = 1;
      }
    }
  };

  // The Smudge: lay down what it carries, then pick up what is there
  const smudgeDab = (rt, x0, y0, left, top, width, height) => {
    rtEnsure(rt, left, top, left + width, top + height);
    const L = rtBuffer(rt, "buf", width * height * 4);
    rtCopy(rt, L, left, top, width, height, false);
    const side = rt.side;
    let carry = rt.carry;
    if (!carry) {
      // What it starts with: the pixels under its first dab, or Finger Painting's colour
      carry = rt.carry = new Float32Array(side * side * 4);
      for (let qy = 0; qy < side; qy++) {
        const y = Math.min(height - 1, Math.max(0, y0 + qy - top));
        for (let qx = 0; qx < side; qx++) {
          const s = (y * width + Math.min(width - 1, Math.max(0, x0 + qx - left))) * 4;
          carry.set(rt.finger || L.subarray(s, s + 4), (qy * side + qx) * 4);
        }
      }
    }
    const any = rtWeights(rt, rt.lay, x0, y0, left, top, width, height);
    const { kw, keep, lock } = rt;
    const take = 1 - keep;
    for (let y = 0; y < height; y++) {
      let q = ((top + y - y0) * side + (left - x0)) * 4;
      for (let x = 0, i = y * width * 4, o = y * width; x < width; x++, q += 4, i += 4, o++) {
        let r = L[i];
        let g = L[i + 1];
        let b = L[i + 2];
        let a = L[i + 3];
        const k = kw[o];
        if (k > 0) {
          r += (carry[q] - r) * k;
          g += (carry[q + 1] - g) * k;
          b += (carry[q + 2] - b) * k;
          const na = a + (carry[q + 3] - a) * k;
          // Transparent pixels locked: the colour changes, not how much there is
          if (!lock) a = na;
          else if (na > 0) {
            const f = a / na;
            r *= f;
            g *= f;
            b *= f;
          } else r = g = b = 0;
          L[i] = r;
          L[i + 1] = g;
          L[i + 2] = b;
          L[i + 3] = a;
        }
        carry[q] = carry[q] * keep + r * take;
        carry[q + 1] = carry[q + 1] * keep + g * take;
        carry[q + 2] = carry[q + 2] * keep + b * take;
        carry[q + 3] = carry[q + 3] * keep + a * take;
      }
    }
    if (!any) return false;
    rtCopy(rt, L, left, top, width, height, true);
    if (rt.all) rtTouch(rt, left, top, width, height);
    return true;
  };
  // A box blur of radius r along the rows or the columns of a w × h picture, its edges held
  const boxBlur = (src, dst, w, h, r, rows) => {
    const n = rows ? w : h;
    const lines = rows ? h : w;
    const step = rows ? 4 : w * 4;
    const across = rows ? w * 4 : 4;
    const norm = 1 / (2 * r + 1);
    for (let line = 0; line < lines; line++) {
      const base = line * across;
      for (let c = 0; c < 4; c++) {
        const at = base + c;
        let sum = src[at] * r;
        for (let k = 0; k <= r; k++) sum += src[at + Math.min(n - 1, k) * step];
        for (let k = 0; k < n; k++) {
          dst[at + k * step] = sum * norm;
          sum += src[at + Math.min(n - 1, k + r + 1) * step] - src[at + Math.max(0, k - r) * step];
        }
      }
    }
  };
  // The Blur and the Sharpen: each dab mixes in a blur of what is under it, or takes it away
  const focusDab = (rt, x0, y0, left, top, width, height) => {
    const any = rtWeights(rt, rt.lay, x0, y0, left, top, width, height);
    if (!any) return false;
    const { doc, halo, kw, lock } = rt;
    const gl = Math.max(0, left - halo);
    const gt = Math.max(0, top - halo);
    const gw = Math.min(doc.width, left + width + halo) - gl;
    const gh = Math.min(doc.height, top + height + halo) - gt;
    rtEnsure(rt, gl, gt, gl + gw, gt + gh);
    const n = gw * gh * 4;
    const L = rtBuffer(rt, "buf", n);
    rtCopy(rt, L, gl, gt, gw, gh, false);
    const B = rtBuffer(rt, "blurred", n);
    const T = rtBuffer(rt, "tmp", n);
    B.set(L.subarray(0, n));
    // Two box blurs one after the other: close enough to a Gaussian, at a fraction of its cost
    for (let pass = 0; pass < 2; pass++) {
      boxBlur(B, T, gw, gh, rt.radius, true);
      boxBlur(T, B, gw, gh, rt.radius, false);
    }
    const out = rtBuffer(rt, "out", width * height * 4);
    const sharpen = rt.tool === "sharpen";
    // The Sharpen compares straight colours: those of the dab and around it, worked out once.
    // Transparent pixels have none, and are left out (NaN is never lower or higher).
    const S = sharpen ? rtBuffer(rt, "straight", n) : null;
    if (sharpen) {
      for (let i = 0; i < n; i += 4) {
        const a = L[i + 3];
        const f = a > 0 ? 1 / a : NaN;
        S[i] = L[i] * f;
        S[i + 1] = L[i + 1] * f;
        S[i + 2] = L[i + 2] * f;
      }
    }
    for (let y = 0; y < height; y++) {
      for (let x = 0, o = y * width, p = o * 4, g = ((top + y - gt) * gw + (left - gl)) * 4; x < width; x++, o++, p += 4, g += 4) {
        let r = L[g];
        let gr = L[g + 1];
        let b = L[g + 2];
        let a = L[g + 3];
        const k = kw[o];
        if (k > 0 && !sharpen) {
          r += (B[g] - r) * k;
          gr += (B[g + 1] - gr) * k;
          b += (B[g + 2] - b) * k;
          const na = a + (B[g + 3] - a) * k;
          if (!lock) a = na;
          else if (na > 0) {
            const f = a / na;
            r *= f;
            gr *= f;
            b *= f;
          } else r = gr = b = 0;
        } else if (k > 0 && a > 0) {
          // In straight colours, each channel pushed away from its blur, but no further than
          // its neighbours go: an edge gets crisper without a light or dark ring along it
          const ba = B[g + 3];
          const cy = top + y - gt;
          const cx = left + x - gl;
          const y0n = cy > 0 ? cy - 1 : 0;
          const y1n = cy < gh - 1 ? cy + 1 : gh - 1;
          const x0n = cx > 0 ? cx - 1 : 0;
          const x1n = cx < gw - 1 ? cx + 1 : gw - 1;
          for (let c = 0; c < 3; c++) {
            const v = S[g + c];
            let lo = v;
            let hi = v;
            for (let ny = y0n; ny <= y1n; ny++) {
              for (let nx = x0n, ni = (ny * gw + nx) * 4 + c; nx <= x1n; nx++, ni += 4) {
                const nv = S[ni];
                if (nv < lo) lo = nv;
                else if (nv > hi) hi = nv;
              }
            }
            const soft = ba > 0 ? B[g + c] / ba : v;
            const sharp = Math.min(hi, Math.max(lo, v + (v - soft)));
            out[p + c] = (v + (sharp - v) * k) * a;
          }
          out[p + 3] = a;
          continue;
        }
        out[p] = r;
        out[p + 1] = gr;
        out[p + 2] = b;
        out[p + 3] = a;
      }
    }
    rtCopy(rt, out, left, top, width, height, true);
    if (rt.all) rtTouch(rt, left, top, width, height);
    return true;
  };

  // A rectangle of the stroke's pixels as the target takes them, straight: on a mask, the grey as
  // its alpha; sampling all layers, the page's pixels where the stroke passed, the target's own
  // elsewhere
  const rtImage = (rt, left, top, width, height) => {
    const image = new ImageData(width, height);
    const out = image.data;
    for (let ty = Math.floor(top / RT_TILE); ty * RT_TILE < top + height; ty++) {
      for (let tx = Math.floor(left / RT_TILE); tx * RT_TILE < left + width; tx++) {
        const tile = rt.tiles.get(ty * RT_KEY + tx);
        const x0 = Math.max(left, tx * RT_TILE);
        const x1 = Math.min(left + width, (tx + 1) * RT_TILE);
        for (let y = Math.max(top, ty * RT_TILE); y < Math.min(top + height, (ty + 1) * RT_TILE); y++) {
          const row = (y - ty * RT_TILE) * RT_TILE - tx * RT_TILE;
          for (let x = x0, i = ((y - top) * width + (x0 - left)) * 4; x < x1; x++, i += 4) {
            const t = (row + x) * 4;
            const px = tile.px;
            if (tile.touched && !tile.touched[row + x]) {
              out[i] = tile.orig[t];
              out[i + 1] = tile.orig[t + 1];
              out[i + 2] = tile.orig[t + 2];
              out[i + 3] = tile.orig[t + 3];
              continue;
            }
            if (rt.gray) {
              out[i + 3] = px[t];
              continue;
            }
            const a = px[t + 3];
            if (!(a > 0)) continue;
            const f = 255 / a;
            out[i] = px[t] * f;
            out[i + 1] = px[t + 1] * f;
            out[i + 2] = px[t + 2] * f;
            out[i + 3] = rt.lock && tile.orig ? tile.orig[t + 3] : a;
          }
        }
      }
    }
    return image;
  };
  // The canvas the stroke shows on: the layer's, or its mask's
  const rtEntry = (rt) => {
    const doc = rt.doc;
    if (rt.gray) {
      const holder = maskHolder(doc, rt.target, rt.layerId);
      if (!holder) return null;
      const entry = maskEntry(holder, doc);
      return { entry, x0: entry.x0, y0: entry.y0 };
    }
    const layer = doc.state.layers.find((item) => item.id === rt.layerId);
    if (!layer) return null;
    const entry = rasterEntry(layer, doc);
    return { entry, x0: entry.cx0, y0: entry.cy0 };
  };
  // What the dabs of a move changed, onto that canvas and the screen
  const rtShow = (rt, live, area) => {
    const found = rtEntry(rt);
    if (!found) return;
    const { entry } = found;
    // Between the dabs of a long move, a corner of the box they span may not be read yet
    rtEnsure(rt, area.left, area.top, area.right, area.bottom);
    const image = rtImage(rt, area.left, area.top, area.right - area.left, area.bottom - area.top);
    const x = area.left - rt.ox - found.x0;
    const y = area.top - rt.oy - found.y0;
    entry.ctx.putImageData(image, x, y);
    entry.version++;
    touched(entry.canvas, entry.version - 1, entry.version, { left: x, top: y, right: x + image.width, bottom: y + image.height });
    live.box = unionOf(live.box, area);
    emit("render", pageRect(rt.doc, area.left, area.top, area.right, area.bottom));
  };

  // `fields.retouch`: { tool: "smudge", "blur" or "sharpen", strength (0 to 1), finger (the
  // colour Finger Painting starts with), sampleAll }. On the mask or the Quick Mask
  // `fields.target`, the pixel layer `layerId`, or with none on TypeR Clean, read from the page
  // as Sample All Layers does (made for the stroke if there is none: it stays if the stroke
  // changes something), as the Spot Healing Brush does.
  const beginRetouch = (doc, layerId, fields) => {
    const { tool, strength, finger, sampleAll } = fields.retouch;
    const size = Math.max(1, Number(fields.size) || 1);
    const rt = { doc, tool, layerId, target: fields.target || null, tiles: new Map(), carry: null, last: null, rest: 0, before: null };
    const live = { retouch: rt, box: null };
    if (rt.target) {
      const holder = maskHolder(doc, rt.target, layerId);
      if (!holder) return false;
      if (holder.locked) {
        emit("layer-locked");
        return false;
      }
      const [ox, oy] = maskOrigin(holder);
      Object.assign(rt, { gray: true, ox, oy });
      Object.assign(live, { layerId, holderId: holder.id, target: rt.target, dx: ox, dy: oy });
      rt.entry = maskEntry(holder, doc);
    } else {
      let layer = layerId ? doc.state.layers.find((item) => item.id === layerId && item.kind === "raster" && !item.adjustment) : doc.state.layers.find((item) => item.clean);
      if (layerId && !layer) return false;
      if (layer && lockOf(layer, "pixels")) {
        emit("layer-locked");
        return false;
      }
      if (!layer) {
        layer = newRaster("TypeR Clean", { clean: true });
        rt.before = doc.state;
        const layers = doc.state.layers.slice();
        layers.splice(underTexts(layers), 0, layer);
        doc.state = Object.assign({}, doc.state, { layers });
      }
      Object.assign(rt, { layerId: layer.id, ox: layer.dx || 0, oy: layer.dy || 0, all: Boolean(sampleAll || !layerId), lock: lockOf(layer, "transparency") });
      Object.assign(live, { layerId: layer.id, dx: rt.ox, dy: rt.oy });
      rt.entry = rasterEntry(layer, doc);
      visualBoxes.delete(layer);
    }
    const selection = doc.state.selection;
    if (selection) {
      const b = selection.bounds;
      rt.sel = selection.mask ? { mask: selection.mask, left: Math.round(b.left), top: Math.round(b.top) } : { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
    }
    const s = Math.max(0.01, Math.min(1, Number(strength) || 0));
    const half = Math.ceil(size / 2) + 1;
    rt.half = half;
    rt.side = half * 2;
    rt.kw = new Float32Array(rt.side * rt.side);
    const cover = dabCoverage(size, Math.max(0, Math.min(100, Number(fields.hardness) || 0)), rt.side);
    const smudge = tool === "smudge";
    rt.spacing = Math.max(1, smudge ? size * SMUDGE_SPACING : size / 4);
    // Strength is what a dab every quarter of the brush does, whatever the spacing: a pass of
    // the Blur blurs as much with a small brush as a large one, the Smudge carries as far
    const f = smudge ? Math.min(1, rt.spacing / Math.max(1, size / 4)) : Math.min(1, rt.spacing / size);
    rt.keep = Math.pow(s, f);
    rt.lay = new Float32Array(cover.length);
    for (let i = 0; i < cover.length; i++) rt.lay[i] = 1 - Math.pow(1 - cover[i] * s, f);
    // The Blur's reach grows with the brush, within a few pixels; the Sharpen looks close by
    const sigma = tool === "blur" ? Math.max(1.5, Math.min(5, size * 0.06)) : 1;
    rt.radius = Math.max(1, Math.round((Math.sqrt(6 * sigma * sigma + 1) - 1) / 2));
    rt.halo = rt.radius * 2 + 1;
    if (finger && smudge) {
      const gray = grayOf(finger);
      rt.finger = rt.gray ? [gray, gray, gray, 255] : [finger.r, finger.g, finger.b, 255];
    }
    doc.liveStroke = live;
    return true;
  };
  const extendRetouch = (live, x, y) => {
    const rt = live.retouch;
    const dabs = [];
    if (!rt.last) dabs.push([x, y]);
    else {
      const [x0, y0] = rt.last;
      const length = Math.hypot(x - x0, y - y0);
      let at = rt.spacing - rt.rest;
      while (at <= length) {
        dabs.push([x0 + ((x - x0) * at) / length, y0 + ((y - y0) * at) / length]);
        at += rt.spacing;
      }
      rt.rest = length - (at - rt.spacing);
    }
    rt.last = [x, y];
    let area = null;
    dabs.forEach(([cx, cy]) => {
      const x0 = Math.round(cx) - rt.half;
      const y0 = Math.round(cy) - rt.half;
      const left = Math.max(0, x0);
      const top = Math.max(0, y0);
      const right = Math.min(rt.doc.width, x0 + rt.side);
      const bottom = Math.min(rt.doc.height, y0 + rt.side);
      if (right <= left || bottom <= top) return;
      const changed = rt.tool === "smudge" ? smudgeDab(rt, x0, y0, left, top, right - left, bottom - top) : focusDab(rt, x0, y0, left, top, right - left, bottom - top);
      if (changed) area = unionOf(area, { left, top, right, bottom });
    });
    if (area) rtShow(rt, live, area);
  };
  const RETOUCH_NAMES = { smudge: "Smudge Tool", blur: "Blur Tool", sharpen: "Sharpen Tool" };
  // The tiles the stroke changed, side by side in a row as one picture each: one step of history
  const endRetouch = (doc, live) => {
    const rt = live.retouch;
    const pieces = [];
    let run = null;
    const piece = () => {
      if (!run) return;
      const left = run.from * RT_TILE;
      const top = run.ty * RT_TILE;
      const width = Math.min(doc.width, (run.to + 1) * RT_TILE) - left;
      const height = Math.min(doc.height, top + RT_TILE) - top;
      const canvas = newCanvas(width, height);
      canvas.getContext("2d").putImageData(rtImage(rt, left, top, width, height), 0, 0);
      pieces.push({ canvas, x: left - rt.ox, y: top - rt.oy });
      run = null;
    };
    Array.from(rt.tiles.keys()).filter((key) => rt.tiles.get(key).dirty).sort((a, b) => a - b).forEach((key) => {
      const tx = key % RT_KEY;
      const ty = Math.floor(key / RT_KEY);
      if (run && run.ty === ty && run.to === tx - 1) run.to = tx;
      else {
        piece();
        run = { ty, from: tx, to: tx };
      }
    });
    piece();
    rt.tiles.clear();
    if (!pieces.length) {
      // Nothing changed: TypeR Clean, if made for the stroke, goes again
      if (rt.before) {
        doc.state = rt.before;
        if (rasterCache.get(rt.layerId)) forgetRaster(rt.layerId, rasterCache.get(rt.layerId));
      }
      emit("render");
      return;
    }
    const op = { t: "pixels", pieces };
    const name = RETOUCH_NAMES[rt.tool];
    if (rt.gray) {
      const holder = maskHolder(doc, rt.target, rt.layerId);
      if (!holder) return;
      const paint = (holder.mask.paint || NONE).concat([op]);
      const entry = maskCache.get(holder.id);
      // Drawn again from its steps if its canvas was made anew meanwhile
      if (entry === rt.entry) entry.paint = paint;
      else if (entry) maskCache.delete(holder.id);
      const mask = Object.assign({}, holder.mask, { paint });
      if (rt.target === "quick") commitState(doc, name, { quickMask: mask }, undefined, strokeEnd(doc, holder, live));
      else commitState(doc, name, { layers: replaceLayer(doc, holder, { mask }) }, undefined, strokeEnd(doc, holder, live));
      return;
    }
    const layer = doc.state.layers.find((item) => item.id === rt.layerId);
    if (!layer) return;
    const paint = (layer.paint || NONE).concat([op]);
    const entry = rasterCache.get(layer.id);
    if (entry === rt.entry) {
      entry.paint = paint;
      if (paint.length % MARK_EVERY === 0) markRaster(entry, paint);
    } else if (entry) forgetRaster(layer.id, entry);
    if (effectsOn(layer)) settleEffects(doc, layer.id);
    commitState(doc, name, { layers: replaceLayer(doc, layer, { paint }) }, undefined, strokeEnd(doc, layer, live));
  };

  /* ---- the brushes of the library ---- */

  // A brush of the library (a Clip Studio sub tool, see csp.js) is drawn by brush-engine.js as a
  // picture of its own, the stroke so far; here it is laid on what the layer held before the
  // stroke, read in tiles the first time the stroke reaches them, by the brush's blending mode.
  // Chance has a part in most of these brushes, so a stroke is not drawn again from its points:
  // it ends, as the retouching tools' do, as the pixels it changed (a "pixels" paint step).
  // `fields.preset`: { brush, size, opacity, color, sub (the colours as [r, g, b]) }; on a mask
  // `fields.target`, in `fields.gray`.
  const PT_TILE = 128;
  const PT_KEY = 65536;
  // Photoshop's blending modes, one channel at a time: what is there (b) and what is painted
  // (s), 0 to 1
  const PT_BLENDS = {
    multiply: (b, s) => b * s,
    screen: (b, s) => b + s - b * s,
    overlay: (b, s) => (b <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s)),
    darken: (b, s) => Math.min(b, s),
    lighten: (b, s) => Math.max(b, s),
    "color dodge": (b, s) => (b <= 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s))),
    "color burn": (b, s) => (b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s)),
    "linear dodge": (b, s) => Math.min(1, b + s),
    "linear burn": (b, s) => Math.max(0, b + s - 1),
    subtract: (b, s) => Math.max(0, b - s),
    "hard light": (b, s) => (s <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s)),
    difference: (b, s) => Math.abs(b - s),
    exclusion: (b, s) => b + s - 2 * b * s,
  };
  const beginPreset = (doc, layerId, fields) => {
    const Engine = window.TypeRBrushEngine;
    const { brush, size, opacity, color, sub } = fields.preset;
    if (!Engine || !brush) return false;
    const pt = { doc, layerId, target: fields.target || null, tiles: new Map(), blend: brush.settings.blend || "normal" };
    const live = { preset: pt, box: null };
    if (pt.target) {
      const holder = maskHolder(doc, pt.target, layerId);
      if (!holder) return false;
      if (holder.locked) {
        emit("layer-locked");
        return false;
      }
      const [ox, oy] = maskOrigin(holder);
      Object.assign(pt, { gray: Math.max(0, Math.min(255, Number(fields.gray) || 0)), masked: true, ox, oy });
      Object.assign(live, { layerId, holderId: holder.id, target: pt.target, dx: ox, dy: oy });
      pt.entry = maskEntry(holder, doc);
    } else {
      const layer = doc.state.layers.find((item) => item.id === layerId && item.kind === "raster" && !item.adjustment);
      if (!layer) return false;
      if (lockOf(layer, "pixels")) {
        emit("layer-locked");
        return false;
      }
      Object.assign(pt, { ox: layer.dx || 0, oy: layer.dy || 0, lock: lockOf(layer, "transparency") });
      Object.assign(live, { layerId: layer.id, dx: pt.ox, dy: pt.oy });
      pt.entry = rasterEntry(layer, doc);
      visualBoxes.delete(layer);
    }
    const selection = doc.state.selection;
    if (selection) {
      const b = selection.bounds;
      pt.sel = selection.mask ? { mask: selection.mask, left: Math.round(b.left), top: Math.round(b.top) } : { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
    }
    pt.opacity = opacity === undefined ? brush.settings.opacity : opacity;
    pt.stroke = Engine.begin(brush, { size, opacity: pt.opacity, color, sub });
    doc.liveStroke = live;
    return true;
  };
  // The canvas the stroke shows on, and where the page's corner is on it
  const ptEntry = (pt) => {
    const doc = pt.doc;
    if (pt.masked) {
      const holder = maskHolder(doc, pt.target, pt.layerId);
      if (!holder) return null;
      const entry = maskEntry(holder, doc);
      return { entry, x0: entry.x0, y0: entry.y0 };
    }
    const layer = doc.state.layers.find((item) => item.id === pt.layerId);
    if (!layer) return null;
    const entry = rasterEntry(layer, doc);
    return { entry, x0: entry.cx0, y0: entry.cy0 };
  };
  // What the layer held before the stroke, over the tiles a rectangle of the page needs
  const ptEnsure = (pt, found, left, top, right, bottom) => {
    const doc = pt.doc;
    for (let ty = Math.floor(top / PT_TILE); ty * PT_TILE < bottom; ty++) {
      for (let tx = Math.floor(left / PT_TILE); tx * PT_TILE < right; tx++) {
        const key = ty * PT_KEY + tx;
        if (pt.tiles.has(key)) continue;
        const x0 = tx * PT_TILE;
        const y0 = ty * PT_TILE;
        const w = Math.min(PT_TILE, doc.width - x0);
        const h = Math.min(PT_TILE, doc.height - y0);
        pt.tiles.set(key, { data: found.entry.ctx.getImageData(x0 - pt.ox - found.x0, y0 - pt.oy - found.y0, w, h).data, width: w });
      }
    }
  };
  // How much of the stroke a pixel of the page takes: all of it, or none outside the selection
  const ptSelected = (sel, px, py) => {
    if (!sel) return true;
    if (sel.mask) {
      const mx = px - sel.left;
      const my = py - sel.top;
      return mx >= 0 && my >= 0 && mx < sel.mask.width && my < sel.mask.height && sel.mask.data[my * sel.mask.width + mx] > 0;
    }
    return px + 0.5 > sel.left && px + 0.5 < sel.right && py + 0.5 > sel.top && py + 0.5 < sel.bottom;
  };
  // A rectangle of the page as the stroke leaves it: what was there and the stroke over it
  const ptImage = (pt, left, top, width, height) => {
    const image = new ImageData(width, height);
    const out = image.data;
    const n = width * height * 4;
    if (!pt.buffer || pt.buffer.length < n) pt.buffer = new Float32Array(n);
    // In place of what is there, a stroke is read without its opacity: it is how much is replaced
    const replace = pt.blend === "replace";
    const paint = pt.stroke.read(left, top, width, height, pt.buffer, replace);
    const mix = PT_BLENDS[pt.blend] || null;
    const { sel, opacity } = pt;
    for (let y = 0; y < height; y++) {
      const py = top + y;
      const ty = Math.floor(py / PT_TILE);
      for (let x = 0; x < width; x++) {
        const px = left + x;
        const tx = Math.floor(px / PT_TILE);
        const tile = pt.tiles.get(ty * PT_KEY + tx);
        const t = ((py - ty * PT_TILE) * tile.width + (px - tx * PT_TILE)) * 4;
        const o = (y * width + x) * 4;
        const d = tile.data;
        let a = paint[o + 3];
        if (!(a > 0) || !ptSelected(sel, px, py)) {
          out[o] = d[t];
          out[o + 1] = d[t + 1];
          out[o + 2] = d[t + 2];
          out[o + 3] = d[t + 3];
          continue;
        }
        if (pt.masked) {
          // A mask keeps its grey as alpha: the stroke brings it toward the grey painted
          const to = pt.blend === "erase" ? 255 - pt.gray : pt.gray;
          out[o + 3] = d[t + 3] + (to - d[t + 3]) * (replace ? a * opacity : a);
          continue;
        }
        const da = d[t + 3] / 255;
        let r = paint[o];
        let g = paint[o + 1];
        let b = paint[o + 2];
        if (pt.blend === "erase") {
          out[o] = d[t];
          out[o + 1] = d[t + 1];
          out[o + 2] = d[t + 2];
          out[o + 3] = pt.lock ? d[t + 3] : d[t + 3] * (1 - a);
          continue;
        }
        if (pt.lock) {
          // Transparent pixels locked: the colour changes, not how much there is
          out[o] = d[t] + (r - d[t]) * a;
          out[o + 1] = d[t + 1] + (g - d[t + 1]) * a;
          out[o + 2] = d[t + 2] + (b - d[t + 2]) * a;
          out[o + 3] = d[t + 3];
          continue;
        }
        if (pt.blend === "compare") {
          // The denser of the two stays (how dark, and how much of it): strokes of a screentone
          // that cross don't build up, and on white paper the stroke is all there is
          const there = da * (1 - (0.299 * d[t] + 0.587 * d[t + 1] + 0.114 * d[t + 2]) / 255);
          if (a * (1 - (0.299 * r + 0.587 * g + 0.114 * b) / 255) <= there && a <= da) {
            out[o] = d[t];
            out[o + 1] = d[t + 1];
            out[o + 2] = d[t + 2];
            out[o + 3] = d[t + 3];
            continue;
          }
        } else if (replace && da <= opacity * 1.001) {
          // In place of what is there: a marker's strokes don't build up where they cross
          const sa = opacity * a;
          const keep = da * (1 - a);
          const total = sa + keep;
          out[o] = total > 0 ? (r * sa + d[t] * keep) / total : 0;
          out[o + 1] = total > 0 ? (g * sa + d[t + 1] * keep) / total : 0;
          out[o + 2] = total > 0 ? (b * sa + d[t + 2] * keep) / total : 0;
          out[o + 3] = total * 255;
          continue;
        } else if (replace) {
          // Over something more opaque than the marker, it is laid on it: nothing is taken away
          a *= opacity;
        }
        if (mix && da > 0) {
          r = (1 - da) * r + da * 255 * mix(d[t] / 255, r / 255);
          g = (1 - da) * g + da * 255 * mix(d[t + 1] / 255, g / 255);
          b = (1 - da) * b + da * 255 * mix(d[t + 2] / 255, b / 255);
        }
        const keep = da * (1 - a);
        const total = a + keep;
        out[o] = (r * a + d[t] * keep) / total;
        out[o + 1] = (g * a + d[t + 1] * keep) / total;
        out[o + 2] = (b * a + d[t + 2] * keep) / total;
        out[o + 3] = total * 255;
      }
    }
    return image;
  };
  // What a move of the pen changed (a rectangle of the page, from the engine), onto the canvas
  // and the screen
  const ptShow = (pt, live, rect) => {
    if (!rect) return;
    const doc = pt.doc;
    const area = { left: Math.max(0, Math.floor(rect.left)), top: Math.max(0, Math.floor(rect.top)), right: Math.min(doc.width, Math.ceil(rect.right)), bottom: Math.min(doc.height, Math.ceil(rect.bottom)) };
    if (area.right <= area.left || area.bottom <= area.top) return;
    const found = ptEntry(pt);
    if (!found) return;
    const { entry } = found;
    ptEnsure(pt, found, area.left, area.top, area.right, area.bottom);
    const image = ptImage(pt, area.left, area.top, area.right - area.left, area.bottom - area.top);
    const x = area.left - pt.ox - found.x0;
    const y = area.top - pt.oy - found.y0;
    entry.ctx.putImageData(image, x, y);
    entry.version++;
    touched(entry.canvas, entry.version - 1, entry.version, { left: x, top: y, right: x + image.width, bottom: y + image.height });
    live.box = unionOf(live.box, area);
    emit("render", pageRect(doc, area.left, area.top, area.right, area.bottom));
  };
  const extendPreset = (live, x, y, pen) => {
    const pt = live.preset;
    ptShow(pt, live, pt.stroke.add(x, y, pen && pen.pressure > 0 ? pen.pressure : 1, pen && pen.time ? pen.time : performance.now(), pen && pen.tilt ? pen.tilt : null));
  };
  // The stroke's end (which may draw it all again: see brush-engine.js), then one step of
  // history: the tiles it reached, row by row, as the layer's pixels there
  const endPreset = (doc, live) => {
    const pt = live.preset;
    ptShow(pt, live, pt.stroke.end());
    const box = live.box;
    const found = box ? ptEntry(pt) : null;
    const pieces = [];
    if (found) {
      const keys = Array.from(pt.tiles.keys()).sort((a, b) => a - b);
      let run = null;
      const piece = () => {
        if (!run) return;
        const left = Math.max(box.left, run.from * PT_TILE);
        const top = Math.max(box.top, run.ty * PT_TILE);
        const right = Math.min(box.right, (run.to + 1) * PT_TILE);
        const bottom = Math.min(box.bottom, (run.ty + 1) * PT_TILE);
        run = null;
        if (right <= left || bottom <= top) return;
        const canvas = newCanvas(right - left, bottom - top);
        canvas.getContext("2d").putImageData(found.entry.ctx.getImageData(left - pt.ox - found.x0, top - pt.oy - found.y0, right - left, bottom - top), 0, 0);
        pieces.push({ canvas, x: left - pt.ox, y: top - pt.oy });
      };
      keys.forEach((key) => {
        const tx = key % PT_KEY;
        const ty = Math.floor(key / PT_KEY);
        if (run && run.ty === ty && run.to === tx - 1) run.to = tx;
        else {
          piece();
          run = { ty, from: tx, to: tx };
        }
      });
      piece();
    }
    pt.tiles.clear();
    pt.buffer = null;
    if (!pieces.length) {
      emit("render");
      return;
    }
    const op = { t: "pixels", pieces };
    const name = pt.blend === "erase" ? "Eraser" : "Brush";
    if (pt.masked) {
      const holder = maskHolder(doc, pt.target, pt.layerId);
      if (!holder) return;
      const paint = (holder.mask.paint || NONE).concat([op]);
      const entry = maskCache.get(holder.id);
      if (entry === pt.entry) entry.paint = paint;
      else if (entry) maskCache.delete(holder.id);
      const mask = Object.assign({}, holder.mask, { paint });
      if (pt.target === "quick") commitState(doc, "Quick Mask", { quickMask: mask }, undefined, strokeEnd(doc, holder, live));
      else commitState(doc, name, { layers: replaceLayer(doc, holder, { mask }) }, undefined, strokeEnd(doc, holder, live));
      return;
    }
    const layer = doc.state.layers.find((item) => item.id === pt.layerId);
    if (!layer) return;
    const paint = (layer.paint || NONE).concat([op]);
    const entry = rasterCache.get(layer.id);
    if (entry === pt.entry) {
      entry.paint = paint;
      if (paint.length % MARK_EVERY === 0) markRaster(entry, paint);
    } else if (entry) forgetRaster(layer.id, entry);
    if (effectsOn(layer)) settleEffects(doc, layer.id);
    commitState(doc, name, { layers: replaceLayer(doc, layer, { paint }) }, undefined, strokeEnd(doc, layer, live));
  };

  // Photoshop's anti-aliasing methods. In all of them a pixel of a text layer is as opaque as
  // the share of it the letters cover, which is what the browser draws from their outlines:
  // Smooth and Crisp draw the outline itself, Strong draws it 0.145 px further out on every
  // side, None keeps a pixel on or off at half (measured in Photoshop 2026 on text made in
  // Photoshop, against the area of the outlines: 3 fonts from 10 to 100 px in each method;
  // Strong within 0.01 px of the pixels of 240 text layers lettered in Photoshop 25).
  const EMBOLDEN = { antiAliasStrong: 0.145 };
  // Sharp draws small letters further out too, by how wide the font's upright strokes come out
  // in pixels, as Adobe's own font rasteriser darkens stems: 0.275 px in all while they are
  // 1 to 1.67 px wide, less and less up to 2.33 px and nothing beyond, more below 1 px. So
  // Arial and Wildjess get it up to 24 px and Komika Title up to 15, and in a font that says
  // how wide its strokes are (CC Ask For Mercy, 0.127 of the size) Photoshop's steps fall at
  // 13 and 18 px, where that curve puts them. Here the strokes are measured (see stemWidthOf),
  // and the letters given 0.8 of it: over 9 fonts from 9 to 32 px in Photoshop 2026, Sharp's
  // ink is then off by 3.8% in the mean, from 8.6% without (-16% to -2% for Victory Speech
  // Lower at 14.5 px). Sharp also fits the letters' height to the pixels, and with Crisp sets
  // large letters on whole pixels: that isn't done here.
  const SHARP_DARKENING = 0.8;
  const stemDarkening = (stemPx) => (stemPx <= 0.5 ? 0.4 : stemPx <= 1 ? 0.4 - (stemPx - 0.5) * 0.25 : stemPx <= 1.667 ? 0.275 : stemPx < 2.333 ? (0.275 * (2.333 - stemPx)) / 0.666 : 0);
  // How far out the method draws a run's letters, on every side, in the page's pixels. Without
  // a run: what is the same for every run (Strong's)
  const emboldenOf = (mode, textStyle, sizePx) => {
    if (mode === "antiAliasSharp") return textStyle ? (SHARP_DARKENING * stemDarkening(stemWidthOf(textStyle) * sizePx)) / 2 : 0;
    return EMBOLDEN[mode] || 0;
  };
  // Photoshop then blends a text's letters into the page through a gamma (Blend Text Colors
  // Using Gamma, on as Photoshop comes): black text is lighter than its coverage, white text
  // on black bolder. How much depends on each user's Colour Settings. A pixel black letters
  // half cover is 36% black with Photoshop's own settings (sRGB, gamma 1.45: 13 of 42 pages
  // lettered in Photoshop 25 and CC 2019, from their pixels and their flattened picture), 40%
  // in Photoshop 2026 on a Mac set to Monitor Color, 42% on 20 of those pages, and 50%, a plain
  // blend, with the setting off (3 pages). This is the middle of the three where it is on, 39%:
  // each channel is (a·F^p + (1 − a)·B^p)^(1/p) for letters of colour F covering `a` of a pixel
  // of the page B, the shape measured in Photoshop 2026 with 7 colours on 6 backdrops. The
  // canvas blends plainly, so each pixel is given the opacity that blends plainly into the same
  // colour. Exact for black letters on any page; other colours are taken to stand on white
  // when dark and on black when light, unless they stand on their stroke: over a layer style's
  // stroke outside them Photoshop blends the letters the same way, into the stroke's colour
  // (black on a red stroke is 39.7% black where half covered, as on white; a real page's black
  // letters on their white stroke follow the page's own curve). The stroke's own edges it
  // blends plainly.
  // The layer's Opacity and Fill go through the same blend, each channel
  // (o·F^p + (1 − o)·B^p)^(1/p): black letters at 50% are 40% black on white, on grey, on any
  // page (measured in Photoshop 2026, 6 colours on 5 backdrops at 75, 50 and 25%, and Fill at
  // 50%). The canvas lays the layer's opacity on plainly afterwards, so the letters are given
  // what it leaves to reach that. Black and near-black letters only, whose blend is the same on
  // any page: a colour's depends on the page under it (red at 50% is lighter than plainly
  // blended on white, darker on black), and keeps the plain opacity.
  const TEXT_GAMMA = 1.4;
  const FADED_UP_TO = 40;
  const textGammaTables = new Map();
  // [how light the letters are, 0 to 255][coverage, 0 to 255] -> opacity. `page`: how light
  // what the letters stand on is, 0 to 255, where it is known; `opacity`: the layer's own
  const textGamma = (page, opacity = 1) => {
    const key = `${page === undefined ? "" : page}|${opacity}`;
    let table = textGammaTables.get(key);
    if (table) return table;
    if (textGammaTables.size > 16) textGammaTables.clear();
    table = new Uint8Array(256 * 256);
    const b = page === undefined ? 0 : page / 255;
    for (let level = 0; level < 256; level++) {
      const f = level / 255;
      const light = Math.max(0, Math.min(1, (f - 0.35) / 0.3));
      const mix = light * light * (3 - 2 * light);
      // The opacity that blends plainly into what Photoshop's blend gives letters covering `a`
      const blend = (a) => {
        if (page !== undefined) return Math.abs(f - b) < 0.02 ? a : ((a * f ** TEXT_GAMMA + (1 - a) * b ** TEXT_GAMMA) ** (1 / TEXT_GAMMA) - b) / (f - b);
        const onWhite = f < 1 ? (1 - (a * f ** TEXT_GAMMA + (1 - a)) ** (1 / TEXT_GAMMA)) / (1 - f) : a;
        const onBlack = a ** (1 / TEXT_GAMMA);
        return onWhite * (1 - mix) + onBlack * mix;
      };
      const faded = opacity < 1 && level <= FADED_UP_TO;
      if (faded) table.faded = true;
      for (let i = 0; i < 256; i++) {
        const a = i / 255;
        table[level * 256 + i] = Math.round(Math.max(0, Math.min(1, faded ? blend(a * opacity) / opacity : blend(a))) * 255);
      }
    }
    textGammaTables.set(key, table);
    return table;
  };
  // `gamma`: the table that blends the letters' edges (see textGamma), none for edges that
  // meet a stroke drawn with them
  const antiAliasPixels = (px, mode, gamma) => {
    if (mode === "antiAliasNone") {
      for (let i = 3; i < px.length; i += 4) px[i] = px[i] >= 128 ? 255 : 0;
      return;
    }
    if (!gamma) return;
    // A layer below 100% has its covered pixels blended too
    const whole = gamma.faded ? 256 : 255;
    for (let i = 3; i < px.length; i += 4) {
      const a = px[i];
      if (a === 0 || a === whole) continue;
      px[i] = gamma[(((px[i - 3] * 77 + px[i - 2] * 150 + px[i - 1] * 29) >> 8) << 8) + a];
    }
  };
  // `unblended`: a text's pixels for a PSD file, which keeps them as opaque as the letters cover
  // them and blends them itself. Nor are letters with Extra Bold's outline, a stroke too.
  // `opacity`: the layer's, for a text drawn alone (see textGamma)
  const blendedEdges = (layer, stroke, opacity = 1) => (!stroke && !layer.unblended && !layer.params.layerText.textStyleRange.some((range) => extraBoldOf(range.textStyle)) ? textGamma(undefined, opacity) : null);
  // How light a colour is, 0 to 255, as the tables count it
  const lightnessOf = (color) => (color ? (color.r * 77 + color.g * 150 + color.b * 29) >> 8 : 0);
  // The stroke a text's letters stand on, whose colour they are blended into: all of it
  // outside them, whole, in one colour, under letters at their full Fill
  const strokeUnder = (layer, stroke) => Boolean(stroke) && !layer.unblended && stroke.size > 0 && strokeOutside(stroke) >= stroke.size && strokeAlpha(stroke) >= 1 && !strokeIsGradient(stroke) && Boolean(stroke.color) && fillOf(layer) === 1 && !layer.params.layerText.textStyleRange.some((range) => extraBoldOf(range.textStyle));
  // The colour of a text's letters when they all have the same, as { r, g, b }
  const oneColourOf = (layer) => {
    const colours = layer.params.layerText.textStyleRange.map(({ textStyle }) => (textStyle.color ? [Math.round(textStyle.color.red), Math.round(textStyle.color.green), Math.round(textStyle.color.blue)] : [0, 0, 0]));
    if (!colours.length || colours.some((colour) => colour.some((value, j) => value !== colours[0][j]))) return null;
    return { r: colours[0][0], g: colours[0][1], b: colours[0][2] };
  };
  // A text's pixels read from a file, blended the same way: into the page, or into the stroke
  // they stand on (`page`, how light it is)
  const blendedTexts = new WeakMap();
  const blendedText = (bitmap, page, opacity = 1) => {
    const key = `${page === undefined ? "" : page}|${opacity}`;
    let kept = blendedTexts.get(bitmap);
    if (!kept || kept.key !== key) {
      const canvas = newCanvas(Math.max(1, bitmap.width), Math.max(1, bitmap.height));
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0);
      applyAntiAlias(canvas, ctx, "", textGamma(page, opacity));
      kept = { key, canvas };
      blendedTexts.set(bitmap, kept);
    }
    return kept.canvas;
  };
  // `band`: the rows to go through, [first, end), instead of the whole canvas
  const applyAntiAlias = (canvas, ctx, mode, gamma, band) => {
    if (mode !== "antiAliasNone" && !gamma) return;
    const top = band ? band[0] : 0;
    const image = ctx.getImageData(0, top, canvas.width, band ? band[1] - band[0] : canvas.height);
    antiAliasPixels(image.data, mode, gamma);
    ctx.putImageData(image, 0, top);
  };

  // Below 256 px the browser asks the system for each letter, and Windows draws them heavier
  // than the Mac. Above, it draws them from their outlines itself, the same everywhere: the
  // text is drawn that large, then brought back down. By a power of two it comes down
  // exactly, through the halved copies the browser keeps of a picture it shrinks.
  const OUTLINE_SIZE = 260;
  const outlineScale = (lines, matrixScale) => {
    let smallest = Infinity;
    lines.forEach((line) => line.m.placed.forEach((item) => { smallest = Math.min(smallest, item.size * Math.min(item.scaleX, item.scaleY)); }));
    smallest *= matrixScale;
    if (!(smallest > 0 && smallest < Infinity)) return 1;
    let k = 1;
    while (k < 64 && smallest * k < OUTLINE_SIZE) k *= 2;
    return k;
  };
  // Draws on the canvas what draw() traces, with `transform` from the text to the canvas,
  // tile by tile to keep the large copy within a few dozen megabytes
  const TILE_PIXELS = 16 * 1024 * 1024;
  // The tiles a canvas is drawn by, in its own pixels: none when it is drawn at its own size
  const tileSize = (canvas, k) => {
    if (k === 1) return [0, 0];
    const tileW = Math.min(canvas.width, Math.floor(16384 / k));
    return [tileW, Math.max(1, Math.min(canvas.height, Math.floor(TILE_PIXELS / (tileW * k * k))))];
  };
  // `bands`: the only rows to draw, each [first, end), the rest of the canvas left as it is
  // (see keptRows). They are drawn by the same tiles as the whole canvas would be: where a
  // tile starts changes its letters' edges by a hair, and a row must come out the same
  // either way.
  const drawFromOutlines = (canvas, ctx, transform, k, draw, bands) => {
    const [a, b, c, d, e, f] = transform;
    const inBands = () => {
      ctx.beginPath();
      bands.forEach(([from, to]) => ctx.rect(0, from, canvas.width, to - from));
      ctx.clip();
    };
    if (k === 1) {
      // In bands for a quick draw only: cut by a band, a letter's edge isn't quite the same
      ctx.save();
      if (bands) inBands();
      ctx.setTransform(a, b, c, d, e, f);
      draw(ctx);
      ctx.restore();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      return;
    }
    const [tileW, tileH] = tileSize(canvas, k);
    const tile = newCanvas(tileW * k, tileH * k);
    const g = tile.getContext("2d", { willReadFrequently: true });
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (bands) inBands();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "medium";
    for (let y0 = 0; y0 < canvas.height; y0 += tileH) {
      if (bands && !bands.some(([from, to]) => from < y0 + tileH && to > y0)) continue;
      for (let x0 = 0; x0 < canvas.width; x0 += tileW) {
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(0, 0, tile.width, tile.height);
        g.setTransform(a * k, b * k, c * k, d * k, (e - x0) * k, (f - y0) * k);
        draw(g);
        ctx.drawImage(tile, x0, y0, tileW, tileH);
      }
    }
    ctx.restore();
  };

  // Letters drawn on their stroke, all in one colour: where they part cover a pixel of it the
  // canvas mixed the two colours plainly, and the pixel is given Photoshop's blend of them
  // instead, each channel (see textGamma). Only pixels the stroke fills, whose colour lies
  // between the two.
  const blendOnStroke = (canvas, ctx, letters, stroke, band) => {
    const from = [stroke.r, stroke.g, stroke.b];
    const to = [letters.r, letters.g, letters.b];
    // Read on the channel where the two colours are furthest apart
    const c = [0, 1, 2].reduce((best, j) => (Math.abs(to[j] - from[j]) > Math.abs(to[best] - from[best]) ? j : best), 0);
    const span = to[c] - from[c];
    if (Math.abs(span) < 48) return;
    const tables = [0, 1, 2].map((j) => {
      const table = new Uint8Array(256);
      for (let i = 0; i < 256; i++) table[i] = Math.round(((i / 255) * (to[j] / 255) ** TEXT_GAMMA + (1 - i / 255) * (from[j] / 255) ** TEXT_GAMMA) ** (1 / TEXT_GAMMA) * 255);
      return table;
    });
    const top = band ? band[0] : 0;
    const image = ctx.getImageData(0, top, canvas.width, band ? band[1] - band[0] : canvas.height);
    const px = image.data;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] !== 255) continue;
      const a = (px[i + c] - from[c]) / span;
      if (!(a > 0.004 && a < 0.996)) continue;
      if (Math.abs(px[i] - from[0] - a * (to[0] - from[0])) > 3 || Math.abs(px[i + 1] - from[1] - a * (to[1] - from[1])) > 3 || Math.abs(px[i + 2] - from[2] - a * (to[2] - from[2])) > 3) continue;
      const at = Math.round(a * 255);
      px[i] = tables[0][at];
      px[i + 1] = tables[1][at];
      px[i + 2] = tables[2][at];
    }
    ctx.putImageData(image, 0, top);
  };
  // A text's lines on a canvas, through `transform`, then the anti-aliasing and the blend of
  // the letters' edges: into the page, or into the stroke they stand on.
  // `bands`: the only rows to draw (see keptRows)
  const drawText = (canvas, ctx, transform, k, lines, stroke, layer, antiAlias, opacity, bands) => {
    drawFromOutlines(canvas, ctx, transform, k, (g) => drawLines(g, lines, stroke, layer), bands);
    // One colour of letters on one stroke: two strokes, or letters of several colours, can't be
    // told apart from their pixels
    const letters = antiAlias !== "antiAliasNone" && strokeUnder(layer, stroke) && !(stroke.outer && stroke.outer.size > 0) ? oneColourOf(layer) : null;
    (bands || [undefined]).forEach((band) => {
      applyAntiAlias(canvas, ctx, antiAlias, blendedEdges(layer, stroke, opacity), band);
      if (letters) blendOnStroke(canvas, ctx, letters, stroke.color, band);
    });
  };

  // Typing in a long text changes a line or two of it: the rows of the others are kept from
  // the text as it was last drawn, and only the rest is drawn again. Drawing a paragraph of
  // 30 lines whole, at 16 times its size, took a third of a second for each letter typed.
  // A line is kept where nothing of it has changed: its letters, their styles, its place, the
  // canvas's own and the tiles that draw it. A line that only moved is drawn again, even by
  // whole pixels: its letters' edges change by a hair with where it stands. The text then
  // comes out the same, to the pixel, as if drawn whole.
  const DRAWN_BUDGET = 48 * 1024 * 1024;
  const drawnTexts = new Map();
  const styleKeys = new WeakMap();
  const styleKeyOf = (style) => {
    let key = styleKeys.get(style);
    if (!key) {
      key = JSON.stringify(style);
      styleKeys.set(style, key);
    }
    return key;
  };
  // Each line that shows, on a canvas whose top is at `y`: what it draws, where, and the rows
  // its ink can reach, as far as the canvas itself allows around the text (`pad`)
  const drawnLines = (lines, y, pad, height, antiAlias) => {
    const out = [];
    lines.forEach((line) => {
      if (!line.m.placed.length) return;
      let boldDown = 0;
      const what = line.m.placed.map((item) => {
        if (item.run.style.syntheticBold) boldDown = Math.max(boldDown, weightOf(item.run.style, item.size, antiAlias).down);
        return [item.shown, item.x, item.size, item.scaleX, item.scaleY, item.shift, styleKeyOf(item.run.style)];
      });
      const from = Math.max(0, Math.floor(line.baseline - y - line.m.ascent - pad));
      const to = Math.min(height, Math.ceil(line.baseline - y + line.m.descent + boldDown + pad));
      if (to > from) out.push({ key: JSON.stringify(what), x: line.x, baseline: line.baseline, from, to });
    });
    return out;
  };
  // The rows of a new canvas that an earlier one, at the same place, has already (`copies`)
  // and the rows to draw (`bands`), each [first, end). Null when there is nothing to keep.
  // `rough`: rows of the earlier canvas not to keep, whatever they hold.
  const keptRows = (earlier, lines, height, rough) => {
    const byKey = new Map();
    earlier.lines.forEach((line, index) => {
      if (!byKey.has(line.key)) byKey.set(line.key, []);
      byKey.get(line.key).push(index);
    });
    // On each row: 1 where a line shows, 2 where one has changed, here or in the earlier canvas
    const rows = new Uint8Array(height);
    const mark = (from, to, value) => {
      for (let r = from; r < Math.min(to, height); r++) rows[r] |= value;
    };
    const taken = new Set();
    lines.forEach((line) => {
      const match = (byKey.get(line.key) || []).find((index) => {
        const old = earlier.lines[index];
        return !taken.has(index) && old.x === line.x && old.baseline === line.baseline && old.from === line.from && old.to === line.to;
      });
      if (match !== undefined) taken.add(match);
      mark(line.from, line.to, match === undefined ? 3 : 1);
    });
    if (!taken.size) return null;
    earlier.lines.forEach((old, index) => {
      if (!taken.has(index)) mark(old.from, old.to, 2);
    });
    (rough || NONE).forEach(([from, to]) => mark(from, to, 2));
    const copies = [];
    const bands = [];
    for (let r = 0; r < height; r++) {
      if (!(rows[r] & 1)) continue;
      const list = rows[r] === 1 && r < earlier.height ? copies : bands;
      const last = list[list.length - 1];
      if (last && last[1] === r) last[1] = r + 1;
      else list.push([r, r + 1]);
    }
    return copies.length ? { copies, bands } : null;
  };

  // A letter typed that adds a line to a long text moves the lines after it, all of them in
  // a box centred from top to bottom: half a second of drawing for 30 lines, in the middle of
  // a word. Such a letter is drawn quickly instead, at an eighth of the size the letters are
  // drawn at otherwise, close enough to tell no difference while typing; the rows drawn that
  // way are drawn again as they should be once the typing pauses, a few at a time so that a
  // letter typed meanwhile isn't kept waiting. Only what is typed on the page is ever drawn
  // quickly, and only the screen shows it: the edit ending, or the page being read for
  // anything else (a file, a copy, a selection), finishes the drawing first.
  // More tiles than this to draw for a letter typed (a row of them is a line or two): drawn
  // quickly, which takes about as long as two tiles whatever there is to draw
  const QUICK_TILES = 2;
  // How long after the last letter the rows drawn quickly are drawn again, and for how long
  // at a time
  const REFINE_PAUSE = 300;
  const REFINE_SLICE = 8;
  // Above 0 while a text may be drawn quickly (a letter typed), and while one drawn quickly
  // may show (the screen)
  let quickTexts = 0;
  let roughShown = 0;
  let refineTimer = 0;
  let refining = null;
  // Row ranges from a row-by-row mask
  const rangesOf = (mask) => {
    const out = [];
    for (let r = 0; r < mask.length; r++) {
      if (!mask[r]) continue;
      const last = out[out.length - 1];
      if (last && last[1] === r) last[1] = r + 1;
      else out.push([r, r + 1]);
    }
    return out;
  };
  // A text drawn quickly whose drawing is dropped: it isn't shown again as it is
  const forgetRough = (drawn) => {
    const a = drawn.again;
    if (a && a.forLayout.get(a.entryKey) === a.entry) a.forLayout.delete(a.entryKey);
  };
  // The page shows a text again, where it is
  const showAgain = (doc, id) => {
    if (app.doc !== doc) return;
    const layer = doc.state.layers.find((item) => item.id === id);
    const styled = !layer || (layer.group && styledParentOf(layer, new Map(doc.state.layers.map((item) => [item.id, item])), doc.state.layers));
    roughShown++;
    const bounds = styled ? null : visualBounds(layer, doc);
    roughShown--;
    emit("render", bounds ? unionRect(doc, bounds, bounds) : undefined);
  };
  // The rows of one text drawn quickly, drawn as they should be: those of one row of tiles
  // at each call, then the text as a new canvas in place of the quick one. True once done.
  const refineStep = () => {
    if (!refining) {
      const found = Array.from(drawnTexts).find(([, drawn]) => drawn.rough.length && drawn.again);
      if (!found) return true;
      const [id, drawn] = found;
      const [, tileH] = tileSize(drawn.canvas, drawn.again.k);
      const canvas = newCanvas(drawn.canvas.width, drawn.canvas.height);
      const todo = [];
      for (let y0 = 0; y0 < canvas.height; y0 += tileH) {
        const within = drawn.rough.filter(([from, to]) => from < y0 + tileH && to > y0).map(([from, to]) => [Math.max(from, y0), Math.min(to, y0 + tileH)]);
        if (within.length) todo.push(within);
      }
      refining = { id, drawn, canvas, ctx: canvas.getContext("2d", { willReadFrequently: true }), todo };
    }
    const { id, drawn, canvas, ctx, todo } = refining;
    const a = drawn.again;
    // Typed in since, or its page closed: nothing to finish
    if (drawnTexts.get(id) !== drawn || !app.docs.includes(a.doc)) {
      if (drawnTexts.get(id) === drawn) {
        forgetRough(drawn);
        drawnTexts.delete(id);
      }
      refining = null;
      return false;
    }
    if (todo.length) {
      try {
        drawText(canvas, ctx, [1, 0, 0, 1, -a.entry.x, -a.entry.y], a.k, a.relative.lines, a.stroke, a.layer, a.antiAlias, a.opacity, todo.shift());
      } catch (error) {
        // No memory for it, say: the quick drawing goes, and the text is drawn whole when next shown
        console.warn("TypeR web: text not drawn again", error);
        forgetRough(drawn);
        drawnTexts.delete(id);
        refining = null;
      }
      return false;
    }
    // The rows that were right already
    const mask = new Uint8Array(canvas.height).fill(1);
    drawn.rough.forEach(([from, to]) => mask.fill(0, from, to));
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    rangesOf(mask).forEach(([from, to]) => ctx.drawImage(drawn.canvas, 0, from, canvas.width, to - from, 0, from, canvas.width, to - from));
    ctx.restore();
    if (a.forLayout.get(a.entryKey) === a.entry) keepText(a.forLayout, a.entryKey, { canvas, x: a.entry.x, y: a.entry.y });
    drawnTexts.set(id, { how: drawn.how, canvas, lines: drawn.lines, height: drawn.height, bytes: drawn.bytes, rough: NONE, again: null });
    refining = null;
    showAgain(a.doc, a.layer.id);
    return false;
  };
  const refineSome = () => {
    refineTimer = 0;
    const start = performance.now();
    let done = false;
    try {
      while (!done && performance.now() - start < REFINE_SLICE) done = refineStep();
    } finally {
      if (!done) refineTimer = setTimeout(refineSome, 0);
    }
  };
  const refineLater = () => {
    clearTimeout(refineTimer);
    refineTimer = setTimeout(refineSome, REFINE_PAUSE);
  };
  // Every text drawn quickly, drawn as it should be, now
  const settleTexts = () => {
    clearTimeout(refineTimer);
    refineTimer = 0;
    while (!refineStep());
  };

  // A straight text drawn on its canvas (`entry`, top left at its x and y): whole, or from
  // what it was
  const drawTextFrom = (entry, ctx, pad, relative, stroke, layer, doc, antiAlias, opacity, entryKey, forLayout) => {
    const { canvas, x, y } = entry;
    const k = outlineScale(relative.lines, 1);
    const draw = (bands, scale) => drawText(canvas, ctx, [1, 0, 0, 1, -x, -y], scale || k, relative.lines, stroke, layer, antiAlias, opacity, bands);
    // Drawn whole each time: letters large enough to be drawn at their own size, which is
    // quick, and whose edges a band would cut otherwise; a gradient, which spans all the
    // letters; and a stroke inside the letters or below 100%, drawn apart on canvases that
    // don't give the same pixels twice
    const apart = stroke && (strokeIsGradient(stroke) || Boolean(stroke.outer && stroke.outer.color && stroke.outer.color.gradient) || strokeOutside(stroke) < stroke.size || strokeAlpha(stroke) < 1 || Boolean(stroke.outer && strokeAlpha(stroke.outer) < 1));
    // A bubble's text is a tile or two: drawing a band of it is drawing it all
    const tiles = tileSize(canvas, k);
    const across = k === 1 ? 1 : Math.ceil(canvas.width / tiles[0]);
    // A vertical text too: its lines are columns, which no row of the canvas keeps apart
    if (k === 1 || apart || !layer.id || relative.vertical || across * Math.ceil(canvas.height / tiles[1]) < 3) {
      draw();
      return;
    }
    const paragraph = layer.params.layerText.paragraphStyleRange && layer.params.layerText.paragraphStyleRange[0];
    // All that the pixels of a line depend on, besides the line itself
    const how = JSON.stringify([entryKey, x, y, k, tiles, Fonts.generation, fillOf(layer), paragraph && paragraph.paragraphStyle && paragraph.paragraphStyle.directionType, layer.params.layerText.textStyleRange.some((range) => extraBoldOf(range.textStyle)), oneColourOf(layer)]);
    const lines = drawnLines(relative.lines, y, pad, canvas.height, antiAlias);
    const id = objectKey(doc) + "|" + layer.id + "|" + entryKey;
    const earlier = drawnTexts.get(id);
    const quick = quickTexts > 0;
    // Rows drawn quickly are only kept by a drawing that may be quick itself
    const rows = earlier && earlier.how === how && earlier.canvas !== canvas ? keptRows(earlier, lines, canvas.height, quick ? null : earlier.rough) : null;
    const bands = rows ? rows.bands : [[0, canvas.height]];
    let cost = 0;
    for (let y0 = 0; y0 < canvas.height; y0 += tiles[1]) {
      if (bands.some(([from, to]) => from < y0 + tiles[1] && to > y0)) cost += across;
    }
    const roughly = quick && cost > QUICK_TILES;
    if (rows) {
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      const width = Math.min(canvas.width, earlier.canvas.width);
      rows.copies.forEach(([from, to]) => ctx.drawImage(earlier.canvas, 0, from, width, to - from, 0, from, width, to - from));
      ctx.restore();
    }
    if (bands.length) draw(rows || roughly ? bands : undefined, roughly ? Math.max(1, k >> 3) : k);
    // The rows that aren't as they should be: those drawn quickly now, and those kept that were
    const mask = new Uint8Array(canvas.height);
    if (roughly) bands.forEach(([from, to]) => mask.fill(1, from, to));
    if (rows && quick) {
      earlier.rough.forEach(([from, to]) => rows.copies.forEach(([first, end]) => {
        if (Math.min(to, end) > Math.max(from, first)) mask.fill(1, Math.max(from, first), Math.min(to, end));
      }));
    }
    const rough = rangesOf(mask);
    if (earlier && earlier.rough.length) forgetRough(earlier);
    if (rough.length) entry.rough = true;
    drawnTexts.delete(id);
    drawnTexts.set(id, { how, canvas, lines, height: canvas.height, bytes: canvas.width * canvas.height * 4, rough, again: rough.length ? { entry, k, relative, stroke, layer, doc, antiAlias, opacity, entryKey, forLayout } : null });
    if (rough.length) refineLater();
    let bytes = 0;
    drawnTexts.forEach((item) => { bytes += item.bytes; });
    for (const [key, item] of drawnTexts) {
      if (bytes <= DRAWN_BUDGET || drawnTexts.size <= 1) break;
      forgetRough(item);
      drawnTexts.delete(key);
      bytes -= item.bytes;
    }
  };

  // A picture laid on a grid of points, triangle by triangle: `pixels` (sw × sh) spread over
  // `cols` × `rows` cells, the cell corners where destX and destY put them in `out` (W × H)
  const layMesh = (out, W, H, pixels, sw, sh, destX, destY, cols, rows) => {
    const triangle = (x0, y0, s0, t0, x1, y1, s1, t1, x2, y2, s2, t2) => {
      const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
      if (Math.abs(area) < 1e-6) return;
      const inv = 1 / area;
      const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
      const maxY = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));
      const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
      const maxX = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
      const stepA = (y1 - y2) * inv;
      const stepB = (y2 - y0) * inv;
      for (let y = minY; y <= maxY; y++) {
        const py = y + 0.5;
        const px = minX + 0.5;
        let wa = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) * inv;
        let wb = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) * inv;
        for (let x = minX; x <= maxX; x++, wa += stepA, wb += stepB) {
          const wc = 1 - wa - wb;
          if (wa < -1e-4 || wb < -1e-4 || wc < -1e-4) continue;
          const sx = wa * s0 + wb * s1 + wc * s2 - 0.5;
          const sy = wa * t0 + wb * t1 + wc * t2 - 0.5;
          const ix = Math.floor(sx);
          const iy = Math.floor(sy);
          if (ix < 0 || iy < 0 || ix + 1 >= sw || iy + 1 >= sh) continue;
          const a00 = (iy * sw + ix) * 4;
          const a10 = a00 + 4;
          const a01 = a00 + sw * 4;
          const a11 = a01 + 4;
          if (!(pixels[a00 + 3] | pixels[a10 + 3] | pixels[a01 + 3] | pixels[a11 + 3])) continue;
          const fx = sx - ix;
          const fy = sy - iy;
          // Weighed by alpha: a transparent pixel has no colour to give
          const w00 = (1 - fx) * (1 - fy) * pixels[a00 + 3];
          const w10 = fx * (1 - fy) * pixels[a10 + 3];
          const w01 = (1 - fx) * fy * pixels[a01 + 3];
          const w11 = fx * fy * pixels[a11 + 3];
          const sum = w00 + w10 + w01 + w11;
          if (sum <= 0) continue;
          const to = (y * W + x) * 4;
          out[to] = (w00 * pixels[a00] + w10 * pixels[a10] + w01 * pixels[a01] + w11 * pixels[a11]) / sum;
          out[to + 1] = (w00 * pixels[a00 + 1] + w10 * pixels[a10 + 1] + w01 * pixels[a01 + 1] + w11 * pixels[a11 + 1]) / sum;
          out[to + 2] = (w00 * pixels[a00 + 2] + w10 * pixels[a10 + 2] + w01 * pixels[a01 + 2] + w11 * pixels[a11 + 2]) / sum;
          out[to + 3] = sum;
        }
      }
    };
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i00 = r * (cols + 1) + c;
        const i10 = i00 + 1;
        const i01 = i00 + cols + 1;
        const i11 = i01 + 1;
        const s0 = (c / cols) * sw;
        const s1 = ((c + 1) / cols) * sw;
        const t0 = (r / rows) * sh;
        const t1 = ((r + 1) / rows) * sh;
        triangle(destX(i00), destY(i00), s0, t0, destX(i10), destY(i10), s1, t0, destX(i11), destY(i11), s1, t1);
        triangle(destX(i00), destY(i00), s0, t0, destX(i11), destY(i11), s1, t1, destX(i01), destY(i01), s0, t1);
      }
    }
  };

  const textBitmaps = new WeakMap();
  // The text drawn again at the size it lands at, so it stays sharp, then laid on the surface
  // triangle by triangle, at twice the resolution for clean edges. Canvas can't do this:
  // it only knows parallelograms. `quick`, while the surface is dragged: at the page's own
  // resolution, four times less work, and drawn again finely once the drag stops.
  const warpedBitmap = (layer, doc, relative, stroke, antiAlias, quick = false) => {
    const { warp } = layer;
    const { at } = surfaceOf(warp);
    const [p0, p1, p2, p3] = warp.corners;
    const length = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
    const across = Math.max(length(p0, p1), length(p3, p2));
    const down = Math.max(length(p0, p3), length(p1, p2));
    let largest = 0;
    relative.lines.forEach((line) => line.m.placed.forEach((item) => { largest = Math.max(largest, item.size); }));
    const pad = Math.ceil(6 + largest * 0.2 + strokeReach(stroke) * 1.5);
    const b = relative.box;
    const sourceW = b.width + pad * 2;
    const sourceH = b.height + pad * 2;
    const scale = Math.min(4096 / sourceW, 4096 / sourceH, Math.max(0.5, 2 * Math.max(across / warp.source.width, down / warp.source.height)));
    const source = newCanvas(sourceW * scale, sourceH * scale);
    const sourceCtx = source.getContext("2d", { willReadFrequently: true });
    sourceCtx.scale(scale, scale);
    sourceCtx.translate(pad - b.left, pad - b.top);
    drawLines(sourceCtx, relative.lines, stroke, layer);
    const pixels = sourceCtx.getImageData(0, 0, source.width, source.height).data;
    const sw = source.width;
    const sh = source.height;

    const cols = Math.max(8, Math.min(120, Math.ceil(across / 8)));
    const rows = Math.max(4, Math.min(60, Math.ceil(down / 8)));
    const mesh = new Float64Array((cols + 1) * (rows + 1) * 2);
    let at_ = 0;
    for (let r = 0; r <= rows; r++) {
      for (let c = 0; c <= cols; c++) {
        const x = b.left - pad + (sourceW * c) / cols;
        const y = b.top - pad + (sourceH * r) / rows;
        const point = at((x - warp.source.left) / warp.source.width, (y - warp.source.top) / warp.source.height);
        mesh[at_++] = point[0];
        mesh[at_++] = point[1];
      }
    }
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (let i = 0; i < mesh.length; i += 2) {
      left = Math.min(left, mesh[i]);
      right = Math.max(right, mesh[i]);
      top = Math.min(top, mesh[i + 1]);
      bottom = Math.max(bottom, mesh[i + 1]);
    }
    // Only what can show on the page
    left = Math.floor(Math.max(left, -64)) - 1;
    top = Math.floor(Math.max(top, -64)) - 1;
    right = Math.ceil(Math.min(right, doc.width + 64)) + 1;
    bottom = Math.ceil(Math.min(bottom, doc.height + 64)) + 1;
    const width = Math.max(1, right - left);
    const height = Math.max(1, bottom - top);
    const over = quick || width * height > 6000000 ? 1 : 2;
    const W = width * over;
    const H = height * over;
    const big = new ImageData(W, H);
    const out = big.data;

    layMesh(out, W, H, pixels, sw, sh, (i) => (mesh[i * 2] - left) * over, (i) => (mesh[i * 2 + 1] - top) * over, cols, rows);
    const canvas = newCanvas(width, height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (quick) {
      // The anti-aliasing on the pixels before they're put down: no reading them back
      antiAliasPixels(out, antiAlias, blendedEdges(layer, stroke));
      ctx.putImageData(big, 0, 0);
      return { canvas, x: left, y: top, quick: true };
    }
    if (over === 1) ctx.putImageData(big, 0, 0);
    else {
      const large = newCanvas(W, H);
      large.getContext("2d").putImageData(big, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(large, 0, 0, width, height);
    }
    applyAntiAlias(canvas, ctx, antiAlias, blendedEdges(layer, stroke));
    return { canvas, x: left, y: top };
  };

  // A letter's stroke around what shows of it (`letters`, at left, top), as drawLines draws it:
  // the stroke around the stroke, the stroke's part outside, the letters at their Fill, the
  // stroke's part inside over them
  const strokedLetters = (letters, left, top, layer, stroke) => {
    const fill = fillOf(layer);
    if (!stroke && fill === 1) return { canvas: letters, x: left, y: top };
    const canvas = newCanvas(letters.width, letters.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const bolder = emboldenOf(layer.params.layerText.antiAlias || "antiAliasSmooth");
    if (stroke && stroke.outer && stroke.outer.size > 0) ringOf(letters, 0, strokeReach(stroke) + bolder, stroke.outer.color, canvas, strokeAlpha(stroke.outer));
    const outside = strokeOutside(stroke);
    if (outside > 0) ringOf(letters, 0, outside + bolder, strokePaint(stroke), canvas, strokeAlpha(stroke));
    if (fill < 1 && stroke) {
      ctx.globalCompositeOperation = "destination-out";
      ctx.drawImage(letters, 0, 0);
      ctx.globalCompositeOperation = "source-over";
    }
    if (fill > 0) {
      ctx.globalAlpha = fill;
      ctx.drawImage(letters, 0, 0);
      ctx.globalAlpha = 1;
    }
    const inside = stroke ? stroke.size - outside : 0;
    if (inside > 0) innerRingOf(letters, 0, inside, strokePaint(stroke), canvas, strokeAlpha(stroke));
    return { canvas, x: left, y: top };
  };
  // A letter drawn from its own outline (see `outline`), in its colour, then its stroke around
  // it. Around the text's anchor, as the plain text's picture.
  const outlinedBitmap = (layer, doc, relative, stroke, antiAlias) => {
    const outline = outlineOnPage(layer, doc, false);
    const { left: l, top: t, right: r, bottom: b } = window.TypeROutline.boundsOf(outline);
    if (!(r >= l && b >= t)) return { canvas: newCanvas(1, 1), x: 0, y: 0 };
    const reach = Math.ceil(strokeReach(stroke) + 2);
    const left = Math.floor(l) - reach;
    const top = Math.floor(t) - reach;
    const width = Math.max(1, Math.ceil(r) + reach - left);
    const height = Math.max(1, Math.ceil(b) + reach - top);
    const letters = newCanvas(width, height);
    const ctx = letters.getContext("2d", { willReadFrequently: true });
    const style = layer.params.layerText.textStyleRange[0] && layer.params.layerText.textStyleRange[0].textStyle;
    ctx.fillStyle = rgbCss(style && style.color);
    ctx.beginPath();
    window.TypeROutline.toPath(ctx, outline, (x, y) => [x - left, y - top]);
    ctx.fill("nonzero");
    applyAntiAlias(letters, ctx, antiAlias, blendedEdges(layer, stroke));
    return strokedLetters(letters, left, top, layer, stroke);
  };

  // A reshaped letter: its letters alone drawn large and laid on the grid, then its stroke
  // drawn around what shows, so the stroke keeps its width wherever the letter is pulled.
  // Around the text's anchor, as the plain text's picture.
  // `through`: another map than the letter's own shape (a warped text's, see envelopeMapOf)
  const meshedBitmap = (layer, doc, relative, stroke, antiAlias, through) => {
    const b = relative.box;
    const map = through || meshMapOf(layer, b);
    let largest = 0;
    relative.lines.forEach((line) => line.m.placed.forEach((item) => { largest = Math.max(largest, item.size); }));
    const pad = Math.ceil(4 + largest * 0.1);
    const sourceW = b.width + pad * 2;
    const sourceH = b.height + pad * 2;
    const cols = Math.max(8, Math.min(96, Math.ceil(sourceW / 5)));
    const rows = Math.max(8, Math.min(96, Math.ceil(sourceH / 5)));
    const mesh = new Float64Array((cols + 1) * (rows + 1) * 2);
    let at = 0;
    for (let r = 0; r <= rows; r++) {
      for (let c = 0; c <= cols; c++) {
        const point = map(b.left - pad + (sourceW * c) / cols, b.top - pad + (sourceH * r) / rows);
        mesh[at++] = point[0];
        mesh[at++] = point[1];
      }
    }
    // Drawn as large as the most the shape stretches it, twice over, so that it stays sharp
    let stretch = 1;
    const cellW = sourceW / cols;
    const cellH = sourceH / rows;
    for (let r = 0; r <= rows; r++) {
      for (let c = 0; c <= cols; c++) {
        const i = (r * (cols + 1) + c) * 2;
        if (c < cols) stretch = Math.max(stretch, Math.hypot(mesh[i + 2] - mesh[i], mesh[i + 3] - mesh[i + 1]) / cellW);
        if (r < rows) stretch = Math.max(stretch, Math.hypot(mesh[i + (cols + 1) * 2] - mesh[i], mesh[i + (cols + 1) * 2 + 1] - mesh[i + 1]) / cellH);
      }
    }
    const scale = Math.min(4096 / sourceW, 4096 / sourceH, 2 * Math.min(stretch, 6));
    const source = newCanvas(Math.max(1, Math.ceil(sourceW * scale)), Math.max(1, Math.ceil(sourceH * scale)));
    const sourceCtx = source.getContext("2d", { willReadFrequently: true });
    sourceCtx.scale(scale, scale);
    sourceCtx.translate(pad - b.left, pad - b.top);
    // The letters whole, whatever their Fill: the stroke is drawn around them
    drawLines(sourceCtx, relative.lines, null, Object.assign({}, layer, { knockout: false, fill: undefined }));
    const pixels = sourceCtx.getImageData(0, 0, source.width, source.height).data;
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (let i = 0; i < mesh.length; i += 2) {
      left = Math.min(left, mesh[i]);
      right = Math.max(right, mesh[i]);
      top = Math.min(top, mesh[i + 1]);
      bottom = Math.max(bottom, mesh[i + 1]);
    }
    const reach = Math.ceil(strokeReach(stroke) + 2);
    left = Math.floor(left) - reach;
    top = Math.floor(top) - reach;
    const width = Math.max(1, Math.ceil(right) + reach - left);
    const height = Math.max(1, Math.ceil(bottom) + reach - top);
    const over = width * height > 4000000 ? 1 : 2;
    const W = width * over;
    const H = height * over;
    const big = new ImageData(W, H);
    layMesh(big.data, W, H, pixels, source.width, source.height, (i) => (mesh[i * 2] - left) * over, (i) => (mesh[i * 2 + 1] - top) * over, cols, rows);
    const letters = newCanvas(width, height);
    const lettersCtx = letters.getContext("2d", { willReadFrequently: true });
    if (over === 1) lettersCtx.putImageData(big, 0, 0);
    else {
      const large = newCanvas(W, H);
      large.getContext("2d").putImageData(big, 0, 0);
      lettersCtx.imageSmoothingEnabled = true;
      lettersCtx.imageSmoothingQuality = "high";
      lettersCtx.drawImage(large, 0, 0, width, height);
    }
    applyAntiAlias(letters, lettersCtx, antiAlias, blendedEdges(layer, stroke));
    return strokedLetters(letters, left, top, layer, stroke);
  };

  // A surface being dragged asks for a new picture at every step: the second one on is drawn
  // quickly, and the one the drag stops on is drawn again finely a moment later, in its place
  const WARP_STEP_GAP = 250;
  const WARP_SETTLE = 120;
  let warpLast = null;
  let warpRefine = 0;
  // A text with effects draws two pictures at each step (with its stroke, its letters alone):
  // the latest quick one of each is drawn again, and of a plain text only its latest one
  let warpPending = [];
  const warpQuickly = (forLayout, key) => {
    const now = Date.now();
    const quick = Boolean(warpLast && warpLast.forLayout === forLayout && warpLast.key !== key && now - warpLast.time < WARP_STEP_GAP);
    warpLast = { forLayout, key, time: now };
    return quick;
  };
  const refineWarpLater = (layer, doc, relative, stroke, antiAlias, forLayout, key, variant) => {
    clearTimeout(warpRefine);
    warpPending = warpPending.filter((item) => item.forLayout === forLayout && item.variant !== variant);
    warpPending.push({ layer, doc, relative, stroke, antiAlias, forLayout, key, variant });
    warpRefine = setTimeout(() => {
      warpRefine = 0;
      const pending = warpPending;
      warpPending = [];
      let drawn = null;
      pending.forEach(({ layer, doc, relative, stroke, antiAlias, forLayout, key }) => {
        const shown = forLayout.get(key);
        if (!shown || !shown.quick) return;
        keepText(forLayout, key, warpedBitmap(layer, doc, relative, stroke, antiAlias));
        if (app.doc === doc) drawn = doc;
      });
      if (drawn) emit("render");
    }, WARP_SETTLE);
  };

  // A drag draws hundreds of sizes of a text: only the latest bitmaps stay, whatever their number
  const TEXT_BUDGET = 128 * 1024 * 1024;
  const textKept = [];
  let textBytes = 0;
  const keepText = (forLayout, key, entry) => {
    forLayout.set(key, entry);
    const bytes = entry.canvas.width * entry.canvas.height * 4;
    textKept.push({ forLayout, key, entry, bytes });
    textBytes += bytes;
    while (textBytes > TEXT_BUDGET && textKept.length > 1) {
      const oldest = textKept.shift();
      textBytes -= oldest.bytes;
      if (oldest.forLayout.get(oldest.key) === oldest.entry) oldest.forLayout.delete(oldest.key);
    }
  };

  // An object's settings as a short key: the same object, the same key. Shapes and outlines
  // are replaced when they change, never changed in place.
  const objectKeys = new WeakMap();
  let objectCount = 0;
  const objectKey = (value) => {
    if (!value || typeof value !== "object") return "-";
    let key = objectKeys.get(value);
    if (!key) {
      key = "o" + ++objectCount;
      objectKeys.set(value, key);
    }
    return key;
  };

  // A letter's outline traced from what it draws (see TypeROutline): `ch` and the paths, in
  // parts of its box. Drawn large, so that its curves are found finely.
  const TRACE_SIZE = 480;
  const traceText = (layer, doc, options = {}) => {
    const T = window.TypeROutline;
    if (!T || layer.kind !== "text") return null;
    const relative = relativeLayout(layer.params.layerText, doc.resolution);
    const b = relative.box;
    if (!(b.width > 0 && b.height > 0)) return null;
    const scale = TRACE_SIZE / Math.max(b.width, b.height);
    const pad = 6;
    const width = Math.ceil(b.width * scale) + pad * 2;
    const height = Math.ceil(b.height * scale) + pad * 2;
    const canvas = newCanvas(width, height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.setTransform(scale, 0, 0, scale, pad - b.left * scale, pad - b.top * scale);
    drawLines(ctx, relative.lines, null, Object.assign({}, layer, { knockout: false, fill: undefined, stroke: null }));
    const data = ctx.getImageData(0, 0, width, height).data;
    const alpha = new Uint8Array(width * height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3];
    const contours = T.trace(alpha, width, height, Object.assign({ tolerance: 1.1, reach: 8, angle: 0.75, speck: 6 }, options));
    if (!contours.length) return null;
    const w = b.width * scale;
    const h = b.height * scale;
    const round = (value) => Math.round(value * 100000) / 100000;
    return { ch: layer.params.layerText.textKey, c: T.mapped(contours, (x, y) => [round((x - pad) / w), round((y - pad) / h)]) };
  };

  const mixedTexts = new WeakMap();
  const fadedTexts = new WeakMap();
  // `opacity`: the layer's own, for a text drawn alone, which is blended with it (see textGamma)
  const textVisual = (layer, doc, opacity = 1) => {
    // Photoshop's own letters, as opaque as they cover: blended as it blends them, unless
    // they are shown with their stroke
    if (layer.raster) return { canvas: layer.raster.display || (layer.raster.strokeDrawnIn || layer.unblended ? layer.raster.bitmap : blendedText(layer.raster.bitmap, undefined, opacity)), x: layer.raster.displayLeft !== undefined ? layer.raster.left + layer.raster.displayLeft : layer.raster.left, y: layer.raster.displayTop !== undefined ? layer.raster.top + layer.raster.displayTop : layer.raster.top };
    // Fill between 0 and 100 %: the hollow text, then its letters at that much. Mixed after
    // the anti-aliasing, which would bend a faded edge.
    const amount = fillOf(layer);
    if (amount > 0 && amount < 1) {
      const hollow = textVisual(Object.assign({}, layer, { knockout: true, fill: undefined }), doc);
      // Without a stroke under them, the letters' Fill is blended as the layer's opacity is
      const bare = !(layer.stroke && layer.stroke.enabled && layer.stroke.size > 0);
      const solid = textVisual(Object.assign({}, layer, { knockout: false, fill: undefined, stroke: null }), doc, bare ? opacity * amount : 1);
      const kept = mixedTexts.get(solid.canvas);
      if (kept && kept.hollow === hollow.canvas && kept.amount === amount && kept.dx === solid.x - hollow.x && kept.dy === solid.y - hollow.y) return { canvas: kept.canvas, x: Math.min(hollow.x, solid.x), y: Math.min(hollow.y, solid.y) };
      const x = Math.min(hollow.x, solid.x);
      const y = Math.min(hollow.y, solid.y);
      const canvas = newCanvas(Math.max(hollow.x + hollow.canvas.width, solid.x + solid.canvas.width) - x, Math.max(hollow.y + hollow.canvas.height, solid.y + solid.canvas.height) - y);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(hollow.canvas, hollow.x - x, hollow.y - y);
      ctx.globalAlpha = amount;
      ctx.drawImage(solid.canvas, solid.x - x, solid.y - y);
      mixedTexts.set(solid.canvas, { hollow: hollow.canvas, amount, dx: solid.x - hollow.x, dy: solid.y - hollow.y, canvas });
      return { canvas, x, y };
    }
    // A stroke below 100%, as Photoshop lays it: over the letters, at that much, the stroke
    // around the stroke under it at its own. The letters, the text with the stroke around the
    // stroke alone and the text with its stroke alone are each drawn whole, then mixed after
    // the anti-aliasing, which would bend a faded stroke.
    const faded = layer.stroke && layer.stroke.enabled && layer.stroke.size > 0 ? layer.stroke : null;
    if (strokeFaded(faded)) {
      const whole = (stroke) => textVisual(Object.assign({}, layer, { stroke }), doc);
      const parts = [];
      if (amount > 0) parts.push({ visual: whole(null), alpha: 1 });
      if (faded.outer && faded.outer.size > 0) parts.push({ visual: whole({ enabled: true, size: strokeReach(faded), position: "outer", color: faded.outer.color }), alpha: strokeAlpha(faded.outer) });
      parts.push({ visual: whole(Object.assign({}, faded, { opacity: 100, outer: undefined })), alpha: strokeAlpha(faded) });
      const own = parts[parts.length - 1].visual;
      const kept = fadedTexts.get(own.canvas);
      if (kept && kept.parts.length === parts.length && kept.parts.every((part, i) => part.canvas === parts[i].visual.canvas && part.x === parts[i].visual.x && part.y === parts[i].visual.y && part.alpha === parts[i].alpha)) return { canvas: kept.canvas, x: kept.x, y: kept.y };
      const x = Math.min(...parts.map((part) => part.visual.x));
      const y = Math.min(...parts.map((part) => part.visual.y));
      const canvas = newCanvas(Math.max(...parts.map((part) => part.visual.x + part.visual.canvas.width)) - x, Math.max(...parts.map((part) => part.visual.y + part.visual.canvas.height)) - y);
      const ctx = canvas.getContext("2d");
      parts.forEach((part) => {
        ctx.globalAlpha = part.alpha;
        ctx.drawImage(part.visual.canvas, part.visual.x - x, part.visual.y - y);
      });
      fadedTexts.set(own.canvas, { parts: parts.map((part) => ({ canvas: part.visual.canvas, x: part.visual.x, y: part.visual.y, alpha: part.alpha })), canvas, x, y });
      return { canvas, x, y };
    }
    const layout = layoutLayer(layer, doc);
    const relative = layout.relative;
    const stroke = layer.stroke && layer.stroke.enabled && layer.stroke.size > 0 ? layer.stroke : null;
    const antiAlias = layer.params.layerText.antiAlias || "antiAliasSmooth";
    // Hollow at Fill 0%, whether an SFX's (`knockout`) or set to 0
    const strokeKey = (stroke ? strokeKeyOf(stroke) : "") + "|" + antiAlias + (fillOf(layer) === 0 ? "|hollow" : "") + (layer.unblended ? "|unblended" : "") + (opacity < 1 && !stroke ? "|" + opacity : "");
    let forLayout = textBitmaps.get(relative);
    if (!forLayout) {
      forLayout = new Map();
      textBitmaps.set(relative, forLayout);
    }
    if (layer.warp) {
      const warpKey = strokeKey + "|" + JSON.stringify(layer.warp);
      // A drag draws hundreds of these: only the latest ones are worth keeping
      if (!forLayout.has(warpKey) && forLayout.size > 6) forLayout.clear();
      if (!forLayout.has(warpKey)) {
        const quick = warpQuickly(forLayout, warpKey);
        keepText(forLayout, warpKey, warpedBitmap(layer, doc, relative, stroke, antiAlias, quick));
        if (quick) refineWarpLater(layer, doc, relative, stroke, antiAlias, forLayout, warpKey, strokeKey);
      }
      return forLayout.get(warpKey);
    }
    if (meshOn(layer)) {
      const outlined = outlineOk(layer.outline);
      const style = layer.params.layerText.textStyleRange[0] && layer.params.layerText.textStyleRange[0].textStyle;
      const meshKey = strokeKey + "|mesh|" + (layer.rotated && layer.spin ? layer.spin.join(",") : "") + "|" + fillOf(layer) + "|" + objectKey(layer.mesh) + "|" + objectKey(outlined ? layer.outline : null) + (outlined ? "|" + rgbCss(style && style.color) : "");
      // A shape being pulled draws one at every step: only the latest ones are worth keeping
      if (!forLayout.has(meshKey) && forLayout.size > 6) forLayout.clear();
      if (!forLayout.has(meshKey)) keepText(forLayout, meshKey, outlined ? outlinedBitmap(layer, doc, relative, stroke, antiAlias) : meshedBitmap(layer, doc, relative, stroke, antiAlias));
      const entry = forLayout.get(meshKey);
      return { canvas: entry.canvas, x: Math.round(layout.anchor[0]) + entry.x, y: Math.round(layout.anchor[1]) + entry.y };
    }
    if (envelopeOn(layer)) {
      // Warped as Photoshop's Warp Text: the letters laid on its surface, their stroke around
      // what shows, as a layer style's goes around the warped letters
      const envelopeKey = strokeKey + "|envelope|" + window.TypeRTextWarp.keyOf(layer.envelope) + "|" + (layer.rotated && layer.spin ? layer.spin.join(",") : "") + "|" + fillOf(layer);
      // A slider of the dialog draws one at every step: only the latest ones are worth keeping
      if (!forLayout.has(envelopeKey) && forLayout.size > 6) forLayout.clear();
      if (!forLayout.has(envelopeKey)) keepText(forLayout, envelopeKey, meshedBitmap(layer, doc, relative, stroke, antiAlias, envelopeMapOf(layer, doc)));
      const entry = forLayout.get(envelopeKey);
      return { canvas: entry.canvas, x: Math.round(layout.anchor[0]) + entry.x, y: Math.round(layout.anchor[1]) + entry.y };
    }
    const spin = spinOf(layer);
    const entryKey = spin ? strokeKey + "|" + spin.join(",") : strokeKey;
    let entry = forLayout.get(entryKey);
    // Drawn quickly while it was typed (see drawTextFrom): only the screen shows it so
    if (entry && entry.rough && !quickTexts && !roughShown) {
      settleTexts();
      entry = forLayout.get(entryKey);
      if (entry && entry.rough) {
        forLayout.delete(entryKey);
        entry = undefined;
      }
    }
    if (!entry) {
      let largest = 0;
      relative.lines.forEach((line) => line.m.placed.forEach((item) => { largest = Math.max(largest, item.size); }));
      const pad = Math.ceil(6 + largest * 0.2 + strokeReach(stroke) * 1.5);
      const b = relative.box;
      if (spin && stroke && !evenSpin(spin)) {
        // Skewed or stretched: the letters drawn through it, then their stroke around what
        // shows, as Photoshop lays a stroke after the transform: as wide all round
        const reach = Math.ceil(strokeReach(stroke) + 2);
        const { minX, minY, maxX, maxY } = spunBounds({ left: b.left - pad, top: b.top - pad, right: b.right + pad, bottom: b.bottom + pad }, spin);
        const x = Math.floor(minX) - reach;
        const y = Math.floor(minY) - reach;
        const letters = newCanvas(Math.ceil(maxX) + reach - x, Math.ceil(maxY) + reach - y);
        const ctx = letters.getContext("2d", { willReadFrequently: true });
        const k = outlineScale(relative.lines, Math.min(Math.hypot(spin[0], spin[1]), Math.hypot(spin[2], spin[3])));
        drawFromOutlines(letters, ctx, [spin[0], spin[1], spin[2], spin[3], -x, -y], k, (g) => drawLines(g, relative.lines, null, Object.assign({}, layer, { knockout: false, fill: undefined })));
        applyAntiAlias(letters, ctx, antiAlias, blendedEdges(layer, stroke));
        entry = strokedLetters(letters, x, y, layer, stroke);
      } else if (spin) {
        const { minX, minY, maxX, maxY } = spunBounds({ left: b.left - pad, top: b.top - pad, right: b.right + pad, bottom: b.bottom + pad }, spin);
        const canvas = newCanvas(Math.ceil(maxX - minX), Math.ceil(maxY - minY));
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        const x = Math.floor(minX);
        const y = Math.floor(minY);
        const k = outlineScale(relative.lines, Math.min(Math.hypot(spin[0], spin[1]), Math.hypot(spin[2], spin[3])));
        drawText(canvas, ctx, [spin[0], spin[1], spin[2], spin[3], -x, -y], k, relative.lines, stroke, layer, antiAlias, opacity);
        entry = { canvas, x, y };
      } else {
        // On whole pixels, as the turned text above: a picture laid between two pixels is
        // resampled, which blurs every letter by half a pixel
        const x = Math.floor(b.left - pad);
        const y = Math.floor(b.top - pad);
        const canvas = newCanvas(Math.ceil(b.right + pad) - x, Math.ceil(b.bottom + pad) - y);
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        entry = { canvas, x, y };
        drawTextFrom(entry, ctx, pad, relative, stroke, layer, doc, antiAlias, opacity, entryKey, forLayout);
      }
      keepText(forLayout, entryKey, entry);
    }
    return { canvas: entry.canvas, x: Math.round(layout.anchor[0]) + entry.x, y: Math.round(layout.anchor[1]) + entry.y };
  };

  /* ============================ layer effects ============================ */

  // A text's layer style as Photoshop draws it (see FX_DEFAULTS). Under the layer, each in its
  // own blend mode: Drop Shadow, then Outer Glow, then the stroke and the letters at their
  // Fill. On the letters only, each in its own blend mode: Gradient Overlay, Colour Overlay,
  // Inner Glow, Inner Shadow. Fill fades the letters, never the effects; the layer's opacity
  // fades everything. Every effect is worked out from how much of each pixel the letters
  // cover, without their stroke, colour coming last. The maths follow photocraft's (an open
  // editor whose effects were fitted against Photoshop's own files): spread and choke grow
  // the shape, the size blurs it with two box blurs, which match Photoshop better than a
  // Gaussian, and a glow's range is Photoshop's 50%.
  const FX_MAX_SIZE = 250;
  const FX_MAX_BLUR = 512;
  const FX_MAX_DISTANCE = 2000;
  const FX_INSIDE = ["patternOverlay", "gradientOverlay", "colorOverlay", "innerGlow", "innerShadow"];
  const fxNumber = (value, low, high, fallback) => (Number.isFinite(value) ? Math.max(low, Math.min(high, value)) : fallback);
  // An effect that shows: on, and above 0%
  const fxShown = (effect) => Boolean(effect) && effect.enabled !== false && fxNumber(effect.opacity, 0, 100, 100) > 0;
  const fxBlendOf = (effect) => BLENDS[effect.blend] || "source-over";
  // A shadow or a glow drawn around the letters
  const outerEffectsOn = (layer) => Boolean(effectsOn(layer) && (fxShown(layer.effects.dropShadow) || fxShown(layer.effects.outerGlow)));
  // The effects that go on the letters only, kept as one object per layer style
  const insideKept = new WeakMap();
  const insideEffects = (effects) => {
    if (!effects) return effects;
    if (insideKept.has(effects)) return insideKept.get(effects);
    const out = {};
    FX_INSIDE.forEach((name) => { if (effects[name]) out[name] = effects[name]; });
    const kept = Object.keys(out).length ? out : undefined;
    insideKept.set(effects, kept);
    return kept;
  };
  const fxKeys = new WeakMap();
  const fxKeyOf = (effects) => {
    let key = fxKeys.get(effects);
    if (key === undefined) {
      key = JSON.stringify(effects);
      fxKeys.set(effects, key);
    }
    return key;
  };
  // Where the light comes from, as Photoshop's angle: at 120° the shadow falls right and down
  const fxOffset = (effect) => {
    const angle = (fxNumber(effect.angle, -36000, 36000, 120) * Math.PI) / 180;
    const distance = fxNumber(effect.distance, 0, FX_MAX_DISTANCE, 0);
    // Halves round away from 0, as Photoshop's: cos 120° × 5 is 2.4999… in floating point, and
    // is 3 there; cos 60° × 5 is -3
    const snap = (value) => {
      const even = Math.round(value * 1e6) / 1e6;
      return Math.sign(even) * Math.round(Math.abs(even));
    };
    return [snap(-Math.cos(angle) * distance), snap(Math.sin(angle) * distance)];
  };
  const fxSize = (effect) => fxNumber(effect.size, 0, FX_MAX_SIZE, 0);

  // `from` moved by dx, dy into `to`, W × H. What comes in from past the edge is empty, or, for
  // the inner effects (`invert`: they start from where the letters aren't), full.
  const fxShift = (from, to, W, H, dx, dy, invert) => {
    const outside = invert ? 1 : 0;
    const x0 = Math.min(W, Math.max(0, dx));
    const x1 = Math.max(x0, Math.min(W, W + dx));
    for (let y = 0; y < H; y++) {
      const row = y * W;
      const sy = y - dy;
      if (sy < 0 || sy >= H || x1 <= x0) {
        to.fill(outside, row, row + W);
        continue;
      }
      to.fill(outside, row, row + x0);
      to.fill(outside, row + x1, row + W);
      const at = sy * W - dx;
      if (invert) for (let x = x0; x < x1; x++) to[row + x] = 1 - from[at + x];
      else to.set(from.subarray(at + x0, at + x1), row + x0);
    }
  };

  // Spread and choke: the shape grown by r pixels, from how far each pixel's centre is from its
  // edge (a 5 × 5 chamfer: steps of 1, √2 and √5). A pixel the shape covers by `a` has its edge
  // 0.5 - a from its centre, as Photoshop measures it: the grown edge keeps the letters' own
  // anti-aliasing instead of growing every faint pixel into a whole one.
  const FX_R2 = Math.SQRT2;
  const FX_R5 = Math.sqrt(5);
  const fxGrow = (map, W, H, r, dist) => {
    if (r <= 0) return;
    for (let i = 0; i < map.length; i++) dist[i] = map[i] > 0 ? 0.5 - map[i] : 1e6;
    for (let y = 0; y < H; y++) {
      for (let x = 0, i = y * W; x < W; x++, i++) {
        let d = dist[i];
        if (d <= 0) continue;
        let n;
        if (x > 0 && (n = dist[i - 1] + 1) < d) d = n;
        if (y > 0) {
          const up = i - W;
          if ((n = dist[up] + 1) < d) d = n;
          if (x > 0 && (n = dist[up - 1] + FX_R2) < d) d = n;
          if (x < W - 1 && (n = dist[up + 1] + FX_R2) < d) d = n;
          if (x > 1 && (n = dist[up - 2] + FX_R5) < d) d = n;
          if (x < W - 2 && (n = dist[up + 2] + FX_R5) < d) d = n;
          if (y > 1) {
            if (x > 0 && (n = dist[up - W - 1] + FX_R5) < d) d = n;
            if (x < W - 1 && (n = dist[up - W + 1] + FX_R5) < d) d = n;
          }
        }
        dist[i] = d;
      }
    }
    for (let y = H - 1; y >= 0; y--) {
      for (let x = W - 1, i = y * W + W - 1; x >= 0; x--, i--) {
        let d = dist[i];
        if (d <= 0) continue;
        let n;
        if (x < W - 1 && (n = dist[i + 1] + 1) < d) d = n;
        if (y < H - 1) {
          const down = i + W;
          if ((n = dist[down] + 1) < d) d = n;
          if (x < W - 1 && (n = dist[down + 1] + FX_R2) < d) d = n;
          if (x > 0 && (n = dist[down - 1] + FX_R2) < d) d = n;
          if (x < W - 2 && (n = dist[down + 2] + FX_R5) < d) d = n;
          if (x > 1 && (n = dist[down - 2] + FX_R5) < d) d = n;
          if (y < H - 2) {
            if (x < W - 1 && (n = dist[down + W + 1] + FX_R5) < d) d = n;
            if (x > 0 && (n = dist[down + W - 1] + FX_R5) < d) d = n;
          }
        }
        dist[i] = d;
      }
    }
    for (let i = 0; i < map.length; i++) {
      const v = r + 0.5 - dist[i];
      map[i] = v <= 0 ? 0 : v >= 1 ? 1 : v;
    }
  };

  // One box blur of width w along a line of n values, from `src` into `dst`. A width that isn't
  // whole counts the two outermost pixels for the fraction. The ends carry on past the line.
  const fxBox = (src, dst, n, w) => {
    const h = Math.floor((w - 1) / 2);
    const f = (w - 1 - 2 * h) / 2;
    const scale = 1 / w;
    const last = n - 1;
    let sum = 0;
    for (let i = -h; i <= h; i++) sum += src[i < 0 ? 0 : i > last ? last : i];
    for (let x = 0; x < n; x++) {
      const l = x - h - 1;
      const r = x + h + 1;
      const vr = src[r > last ? last : r];
      dst[x] = (sum + f * (src[l < 0 ? 0 : l] + vr)) * scale;
      const gone = x - h;
      sum += vr - src[gone < 0 ? 0 : gone > last ? last : gone];
    }
  };
  // The size: two box blurs one after the other (a tent), across then down
  const fxBlur = (map, W, H, w) => {
    if (!(w > 1)) return;
    const n = Math.max(W, H);
    const a = new Float32Array(n);
    const b = new Float32Array(n);
    for (let y = 0; y < H; y++) {
      const row = y * W;
      a.set(map.subarray(row, row + W));
      fxBox(a, b, W, w);
      fxBox(b, a, W, w);
      map.set(a.subarray(0, W), row);
    }
    for (let x = 0; x < W; x++) {
      for (let y = 0, i = x; y < H; y++, i += W) a[y] = map[i];
      fxBox(a, b, H, w);
      fxBox(b, a, H, w);
      for (let y = 0, i = x; y < H; y++, i += W) map[i] = a[y];
    }
  };

  // A colour at `a` (0 to 1) over a pixel of an ImageData, as Normal lays it
  const fxOver = (px, o, r, g, b, a) => {
    const below = px[o + 3] / 255;
    if (below <= 0) {
      px[o] = r;
      px[o + 1] = g;
      px[o + 2] = b;
      px[o + 3] = a * 255;
      return;
    }
    const keep = below * (1 - a);
    const out = a + keep;
    px[o] = (r * a + px[o] * keep) / out;
    px[o + 1] = (g * a + px[o + 1] * keep) / out;
    px[o + 2] = (b * a + px[o + 2] * keep) / out;
    px[o + 3] = out * 255;
  };
  // An effect's colour over `px` (w × h), as much as `map` says (read from ox, oy in a map W
  // wide; no map: everywhere) times the opacity. `only`: the letters, for an effect that stays
  // on them, painted where they touch a pixel at all (how much they cover comes after).
  // `ranged`: a glow, at full strength from half of it on.
  const fxPaint = (px, w, h, map, W, ox, oy, only, ranged, opacity, color) => {
    const r = fxNumber(color && color.r, 0, 255, 0);
    const g = fxNumber(color && color.g, 0, 255, 0);
    const b = fxNumber(color && color.b, 0, 255, 0);
    for (let y = 0; y < h; y++) {
      let m = (y + oy) * W + ox;
      let o = y * w * 4;
      for (let x = 0; x < w; x++, m++, o += 4) {
        if (only && !(only[m] > 0)) continue;
        let v = map ? map[m] : 1;
        if (ranged) v = v >= 0.5 ? 1 : v * 2;
        v *= opacity;
        if (v > 0.0005) fxOver(px, o, r, g, b, v > 1 ? 1 : v);
      }
    }
  };
  // A layer style's gradient (Gradient Overlay's, a stroke's with Fill Type Gradient) across
  // `box`: its table of colours, and where along it each pixel (x, y) is, 0 to 1
  const fxRamp = (effect, box) => {
    const stops = Array.isArray(effect.stops) && effect.stops.length ? effect.stops : FX_DEFAULTS.gradientOverlay.stops;
    const table = gradientTable(stops, "classic");
    const scale = fxNumber(effect.scale, 10, 150, 100) / 100;
    const turn = (fxNumber(effect.angle, -36000, 36000, 90) * Math.PI) / 180;
    const c = Math.cos(turn);
    const s = Math.sin(turn);
    const bw = box.right - box.left;
    const bh = box.bottom - box.top;
    const cx = (box.left + box.right) / 2;
    const cy = (box.top + box.bottom) / 2;
    // Linear and reflected: as long as the line through the centre at that angle inside the
    // bounds. Radial and diamond: half the bounds' extent along that angle.
    const chord = Math.max(1, Math.min(Math.abs(c) > 1e-6 ? bw / Math.abs(c) : Infinity, Math.abs(s) > 1e-6 ? bh / Math.abs(s) : Infinity) * scale);
    const half = Math.max(0.5, (Math.hypot(c * bw, s * bh) * scale) / 2);
    const style = effect.style || "linear";
    const reverse = Boolean(effect.reverse);
    const at = (x, y) => {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const along = dx * c - dy * s;
      let t;
      if (style === "radial") t = Math.hypot(dx, dy) / half;
      else if (style === "diamond") t = (Math.abs(along) + Math.abs(dx * s + dy * c)) / half;
      else if (style === "reflected") t = Math.abs(along / (chord / 2));
      else if (style === "angle") {
        t = (turn - Math.atan2(-dy, dx)) / (Math.PI * 2);
        t -= Math.floor(t);
      } else t = along / chord + 0.5;
      if (!(t > 0)) t = 0;
      else if (t > 1) t = 1;
      return reverse ? 1 - t : t;
    };
    return { table, at };
  };
  // The gradient as a picture w × h, across `box`: what a stroke with Fill Type Gradient is
  // painted with
  const fxRampPicture = (w, h, effect, box) => {
    const { table, at } = fxRamp(effect, box);
    const canvas = newCanvas(w, h);
    const g = canvas.getContext("2d");
    const image = g.createImageData(w, h);
    const px = image.data;
    for (let y = 0, o = 0; y < h; y++) {
      for (let x = 0; x < w; x++, o += 4) {
        const i = Math.round(at(x, y) * GRADIENT_STEPS) * 4;
        px[o] = table[i];
        px[o + 1] = table[i + 1];
        px[o + 2] = table[i + 2];
        px[o + 3] = Math.round(table[i + 3] * 255);
      }
    }
    g.putImageData(image, 0, 0);
    return canvas;
  };
  // Gradient Overlay over the letters (w × h, at ox, oy in the map), spanning their own bounds
  const fxGradient = (px, w, h, shape, W, ox, oy, effect, box) => {
    const { table, at } = fxRamp(effect, box);
    const opacity = fxNumber(effect.opacity, 0, 100, 100) / 100;
    for (let y = 0; y < h; y++) {
      let m = (y + oy) * W + ox;
      let o = y * w * 4;
      for (let x = 0; x < w; x++, m++, o += 4) {
        if (!(shape[m] > 0)) continue;
        const i = Math.round(at(x, y) * GRADIENT_STEPS) * 4;
        const a = opacity * table[i + 3];
        if (a > 0.0005) fxOver(px, o, table[i], table[i + 1], table[i + 2], a > 1 ? 1 : a);
      }
    }
  };

  // Pattern Overlay over the letters (w × h, at ox, oy in the map): the pattern repeated from
  // their top left, moved by its phase, at its scale and angle. `fx`, `fy`: where these letters
  // are in the layer's, for a part of them.
  const fxPattern = (px, w, h, shape, W, ox, oy, effect, fx = 0, fy = 0) => {
    const pattern = patternOf(effect.pattern && effect.pattern.id);
    if (!pattern || !pattern.w || !pattern.h) return;
    const opacity = fxNumber(effect.opacity, 0, 100, 100) / 100;
    const scale = fxNumber(effect.scale, 1, 1000, 100) / 100;
    const turn = (fxNumber(effect.angle, -360, 360, 0) * Math.PI) / 180;
    const c = Math.cos(turn) / scale;
    const s = Math.sin(turn) / scale;
    const phaseX = (effect.phase && Number(effect.phase.x)) || 0;
    const phaseY = (effect.phase && Number(effect.phase.y)) || 0;
    const { w: pw, h: ph } = pattern;
    const data = patternFiltered(pattern, scale);
    const at = (u, v) => (((v % ph) + ph) % ph * pw + (((u % pw) + pw) % pw)) * 4;
    for (let y = 0; y < h; y++) {
      let m = (y + oy) * W + ox;
      let o = y * w * 4;
      const dy = y + fy + 0.5 - phaseY;
      for (let x = 0; x < w; x++, m++, o += 4) {
        if (!(shape[m] > 0)) continue;
        const dx = x + fx + 0.5 - phaseX;
        // Between the pattern's pixels, as Photoshop resamples it
        const fu = dx * c + dy * s - 0.5;
        const fv = dy * c - dx * s - 0.5;
        const u = Math.floor(fu);
        const v = Math.floor(fv);
        const tu = fu - u;
        const tv = fv - v;
        const i00 = at(u, v);
        const i10 = at(u + 1, v);
        const i01 = at(u, v + 1);
        const i11 = at(u + 1, v + 1);
        const mix = (k) => (data[i00 + k] * (1 - tu) + data[i10 + k] * tu) * (1 - tv) + (data[i01 + k] * (1 - tu) + data[i11 + k] * tu) * tv;
        const a = (opacity * mix(3)) / 255;
        if (a > 0.0005) fxOver(px, o, mix(0), mix(1), mix(2), a);
      }
    }
  };
  // A pattern drawn smaller is first softened as much, round its edges, so that its dots don't
  // come out coarser than they are
  const patternSoftened = new WeakMap();
  const patternFiltered = (pattern, scale) => {
    const r = scale < 1 ? Math.min(8, Math.floor(0.5 / scale)) : 0;
    if (!r) return pattern.data;
    let kept = patternSoftened.get(pattern);
    if (!kept) {
      kept = new Map();
      patternSoftened.set(pattern, kept);
    }
    if (kept.has(r)) return kept.get(r);
    const { w, h, data } = pattern;
    const pass = (from, dx, dy) => {
      const to = new Float32Array(w * h * 4);
      const n = 2 * r + 1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const o = (y * w + x) * 4;
          for (let k = -r; k <= r; k++) {
            const sx = (((x + k * dx) % w) + w) % w;
            const sy = (((y + k * dy) % h) + h) % h;
            const i = (sy * w + sx) * 4;
            to[o] += from[i] / n;
            to[o + 1] += from[i + 1] / n;
            to[o + 2] += from[i + 2] / n;
            to[o + 3] += from[i + 3] / n;
          }
        }
      }
      return to;
    };
    const out = pass(pass(data, 1, 0), 0, 1);
    kept.set(r, out);
    return out;
  };

  // The effects' pictures for letters drawn in `letters`, with the layer as it shows (stroke,
  // letters at their Fill) in `base` at bx, by from them. One picture holding all when the
  // layer and what goes under it blend in Normal (the layer's opacity then fades them as one,
  // as in Photoshop); else the layer with its inner effects, and what goes under it apart, in
  // its own blend mode. Places are from the letters' top left. Null when there are no letters.
  // `part`: the letters are a part of a layer's, at part.x, part.y in them, whose bounds are
  // part.box (in the part's own pixels), for the Gradient and Pattern Overlays to line up
  const buildEffects = (effects, letters, base, bx, by, fill, normal, part) => {
    const sw = letters.width;
    const sh = letters.height;
    const alpha = letters.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, sw, sh).data;
    const box = { left: sw, top: sh, right: 0, bottom: 0 };
    for (let y = 0, o = 3; y < sh; y++) {
      for (let x = 0; x < sw; x++, o += 4) {
        if (!alpha[o]) continue;
        if (x < box.left) box.left = x;
        if (x >= box.right) box.right = x + 1;
        if (y < box.top) box.top = y;
        if (y >= box.bottom) box.bottom = y + 1;
      }
    }
    if (box.right <= box.left) return null;
    const shown = (name) => (fxShown(effects[name]) ? effects[name] : null);
    const shadow = shown("dropShadow");
    const glow = shown("outerGlow");
    const innerShadow = shown("innerShadow");
    const innerGlow = shown("innerGlow");
    const overlay = shown("colorOverlay");
    const gradient = shown("gradientOverlay");
    const pattern = shown("patternOverlay");
    // Room around the letters for what reaches past them
    const shadowAt = shadow ? fxOffset(shadow) : [0, 0];
    const innerAt = innerShadow ? fxOffset(innerShadow) : [0, 0];
    let mL = 0;
    let mR = 0;
    let mT = 0;
    let mB = 0;
    const room = (effect, dx, dy) => {
      const reach = Math.ceil(fxSize(effect)) + 2;
      mL = Math.max(mL, reach + Math.max(0, -dx));
      mR = Math.max(mR, reach + Math.max(0, dx));
      mT = Math.max(mT, reach + Math.max(0, -dy));
      mB = Math.max(mB, reach + Math.max(0, dy));
    };
    if (shadow) room(shadow, shadowAt[0], shadowAt[1]);
    if (glow) room(glow, 0, 0);
    if (innerShadow) room(innerShadow, 0, 0);
    if (innerGlow) room(innerGlow, 0, 0);
    const W = sw + mL + mR;
    const H = sh + mT + mB;
    const N = W * H;
    const shape = new Float32Array(N);
    for (let y = 0, o = 3; y < sh; y++) {
      for (let x = 0, m = (y + mT) * W + mL; x < sw; x++, m++, o += 4) shape[m] = alpha[o] / 255;
    }
    const work = shadow || glow || innerShadow || innerGlow ? new Float32Array(N) : null;
    let dist = null;
    // Shift, grow, blur: the effect's own shape in `work`
    const spread = (effect, amount, dx, dy, invert) => {
      const size = fxSize(effect);
      const s = fxNumber(amount, 0, 100, 0) / 100;
      fxShift(shape, work, W, H, dx, dy, invert);
      const grow = Math.round(size * s);
      if (grow > 0) {
        if (!dist) dist = new Float32Array(N);
        fxGrow(work, W, H, grow, dist);
      }
      fxBlur(work, W, H, Math.min(FX_MAX_BLUR, size - grow));
    };
    // Under the layer. The letters knock it out: in Normal, as much as they let the page
    // through; in another mode, entirely.
    const outside = [];
    const merged = !shadow || !glow || (fxBlendOf(shadow) === "source-over" && fxBlendOf(glow) === "source-over");
    const around = (effect, amount, dx, dy, ranged) => {
      spread(effect, amount, dx, dy, false);
      // Layer Knocks Out Drop Shadow off (`knockout: false`): the shadow stays whole under them
      const keep = effect.knockout === false ? 0 : normal ? 1 - fill : 1;
      for (let i = 0; i < N; i++) {
        let v = work[i];
        if (ranged) v = v >= 0.5 ? 1 : v * 2;
        work[i] = v * (1 - shape[i] * keep);
      }
      if (!outside.length || !merged) outside.push({ image: new ImageData(W, H), blend: fxBlendOf(effect) });
      fxPaint(outside[outside.length - 1].image.data, W, H, work, W, 0, 0, null, false, fxNumber(effect.opacity, 0, 100, 100) / 100, effect.color);
    };
    if (shadow) around(shadow, shadow.spread, shadowAt[0], shadowAt[1], false);
    if (glow) around(glow, glow.spread, 0, 0, true);
    // On the letters, bottom to top; those in Normal one after the other on the same picture
    const inside = [];
    const onLetters = (effect) => {
      const blend = fxBlendOf(effect);
      const last = inside[inside.length - 1];
      if (last && last.blend === "source-over" && blend === "source-over") return last.image.data;
      const image = new ImageData(sw, sh);
      inside.push({ image, blend });
      return image.data;
    };
    if (pattern) fxPattern(onLetters(pattern), sw, sh, shape, W, mL, mT, pattern, part ? part.x : 0, part ? part.y : 0);
    if (gradient) fxGradient(onLetters(gradient), sw, sh, shape, W, mL, mT, gradient, part ? part.box : box);
    if (overlay) fxPaint(onLetters(overlay), sw, sh, null, W, mL, mT, shape, false, fxNumber(overlay.opacity, 0, 100, 100) / 100, overlay.color);
    if (innerGlow) {
      spread(innerGlow, innerGlow.choke, 0, 0, true);
      fxPaint(onLetters(innerGlow), sw, sh, work, W, mL, mT, shape, true, fxNumber(innerGlow.opacity, 0, 100, 100) / 100, innerGlow.color);
    }
    if (innerShadow) {
      spread(innerShadow, innerShadow.choke, innerAt[0], innerAt[1], true);
      fxPaint(onLetters(innerShadow), sw, sh, work, W, mL, mT, shape, false, fxNumber(innerShadow.opacity, 0, 100, 100) / 100, innerShadow.color);
    }
    // One picture, or the layer and what goes under it
    const together = normal && outside.length > 0 && outside.every((item) => item.blend === "source-over");
    let left = Math.min(0, bx);
    let top = Math.min(0, by);
    let right = Math.max(sw, bx + base.width);
    let bottom = Math.max(sh, by + base.height);
    if (together) {
      left = Math.min(left, -mL);
      top = Math.min(top, -mT);
      right = Math.max(right, sw + mR);
      bottom = Math.max(bottom, sh + mB);
    }
    const canvas = newCanvas(right - left, bottom - top);
    const ctx = canvas.getContext("2d");
    if (together) outside.forEach(({ image }) => {
      const picture = newCanvas(W, H);
      picture.getContext("2d").putImageData(image, 0, 0);
      ctx.drawImage(picture, -mL - left, -mT - top);
    });
    ctx.drawImage(base, bx - left, by - top);
    if (inside.length) {
      // The inner effects as Photoshop lays them: on the letters' own colours at their Fill,
      // as if each pixel the letters touch were whole, then cut to how much they cover it. A
      // pixel half covered gets half of the result, not half of each effect over half of the
      // letters, which would leave its edge thicker than the letters.
      const own = new ImageData(sw, sh);
      const o4 = own.data;
      for (let o = 0; o < o4.length; o += 4) {
        if (!alpha[o + 3]) continue;
        o4[o] = alpha[o];
        o4[o + 1] = alpha[o + 1];
        o4[o + 2] = alpha[o + 2];
        o4[o + 3] = fill * 255;
      }
      const letters = newCanvas(sw, sh);
      const l = letters.getContext("2d", { willReadFrequently: true });
      l.putImageData(own, 0, 0);
      const picture = newCanvas(sw, sh);
      const p = picture.getContext("2d");
      inside.forEach(({ image, blend }) => {
        p.putImageData(image, 0, 0);
        l.globalCompositeOperation = blend;
        l.drawImage(picture, 0, 0);
      });
      const done = l.getImageData(0, 0, sw, sh).data;
      // In place of the letters: what is under them (their stroke, their shadow) stays
      const region = ctx.getImageData(-left, -top, sw, sh);
      const px = region.data;
      for (let o = 0; o < px.length; o += 4) {
        const a = alpha[o + 3] / 255;
        if (!a) continue;
        const lettersA = a * fill;
        const shownA = px[o + 3] / 255;
        let belowA = 0;
        let r = 0;
        let g = 0;
        let b = 0;
        if (lettersA < 0.999) {
          const k = 1 / (1 - lettersA);
          belowA = Math.max(0, (shownA - lettersA) * k);
          r = Math.max(0, (px[o] * shownA - alpha[o] * lettersA) * k);
          g = Math.max(0, (px[o + 1] * shownA - alpha[o + 1] * lettersA) * k);
          b = Math.max(0, (px[o + 2] * shownA - alpha[o + 2] * lettersA) * k);
        }
        const topA = (done[o + 3] / 255) * a;
        const outA = topA + belowA * (1 - topA);
        if (outA <= 0) {
          px[o + 3] = 0;
          continue;
        }
        px[o] = (done[o] * topA + r * (1 - topA)) / outA;
        px[o + 1] = (done[o + 1] * topA + g * (1 - topA)) / outA;
        px[o + 2] = (done[o + 2] * topA + b * (1 - topA)) / outA;
        px[o + 3] = outA * 255;
      }
      ctx.putImageData(region, -left, -top);
    }
    const under = together ? null : outside.map(({ image, blend }) => {
      const picture = newCanvas(W, H);
      picture.getContext("2d").putImageData(image, 0, 0);
      return { canvas: picture, dx: -mL, dy: -mT, blend };
    });
    return { canvas, dx: left, dy: top, under: under && under.length ? under : null, box };
  };

  // A text with its effects. Built once for its letters and settings: moving it, its opacity,
  // scrolling and zooming build nothing again. Kept by letters, then by layer: copies of a text
  // share their letters, each with its own effects, and identical ones share the picture.
  const fxBuilt = new WeakMap();
  const FX_KEPT_LAYERS = 64;
  const styledTextVisual = (layer, doc) => {
    const base = textVisual(layer, doc);
    const effects = layer.effects;
    if (!base || !FX_DRAWN.some((name) => fxShown(effects[name]))) return base;
    const shape = textVisual(Object.assign(withoutStroke(layer), { fill: undefined, knockout: false, effects: undefined }), doc);
    if (!shape || !shape.canvas.width || !shape.canvas.height) return base;
    const fill = fillOf(layer);
    // The blend mode the list shows while hovered: the picture it gives once picked
    const blend = doc.blendPreview && doc.blendPreview.ids.has(layer.id) ? doc.blendPreview.blend : layer.blend;
    const normal = (BLENDS[blend] || "source-over") === "source-over";
    const bx = base.x - shape.x;
    const by = base.y - shape.y;
    const key = [fxKeyOf(effects), fill, normal, identity(base.canvas), bx, by].join("|");
    let kept = fxBuilt.get(shape.canvas);
    if (!kept) {
      kept = new Map();
      fxBuilt.set(shape.canvas, kept);
    }
    // A slider dragged builds one at each step: a layer keeps only its latest
    let entry = kept.get(layer.id);
    if (!entry || entry.key !== key) {
      entry = null;
      kept.forEach((other) => { if (!entry && other.key === key) entry = other; });
      if (!entry) entry = { key, built: buildEffects(effects, shape.canvas, base.canvas, bx, by, fill, normal) };
      kept.delete(layer.id);
      kept.set(layer.id, entry);
      if (kept.size > FX_KEPT_LAYERS) kept.delete(kept.keys().next().value);
    }
    const built = entry.built;
    if (!built) return base;
    const visual = { canvas: built.canvas, x: shape.x + built.dx, y: shape.y + built.dy };
    if (built.under) visual.under = built.under.map((item) => ({ canvas: item.canvas, x: shape.x + item.dx, y: shape.y + item.dy, blend: item.blend }));
    return visual;
  };

  // A pixel layer's effects, from its file (an SFX's letters made pixels or a shape, with a
  // Gradient Overlay): its pixels are the letters, at its Fill. Only what the page shows has
  // them: what reads or changes the layer's pixels (visualOf) takes them without.
  // A pixel layer's stroke, a Photoshop shape's most often (the letters of an SFX made a shape,
  // Fill at 0% and two strokes around them): drawn around its pixels as a text's, the part
  // outside under them, the part inside over them. Kept by picture; while a brush paints on the
  // layer, drawn again only around the paint, so that its effects can follow there too.
  const rasterStrokeOf = (layer) => (layer.kind === "raster" && !layer.adjustment && layer.stroke && layer.stroke.enabled && layer.stroke.size > 0 ? layer.stroke : null);
  // The layers Layer Style edits: texts, pixel layers (an adjustment layer has none) and
  // folders, whose style goes on all they hold at once (see groupVisual)
  const styleable = (layer) => layer.kind === "text" || layer.kind === "group" || (layer.kind === "raster" && !layer.adjustment);
  const strokedRasters = new WeakMap();
  let strokedVersion = 0;
  // `bitmap` with its stroke, laid at `pad` in `canvas`
  const drawStroked = (bitmap, pad, stroke, fill, canvas) => {
    const ctx = canvas.getContext("2d");
    const outside = strokeOutside(stroke);
    if (stroke.outer && stroke.outer.size > 0) ringOf(bitmap, pad, strokeReach(stroke), stroke.outer.color, canvas, strokeAlpha(stroke.outer));
    if (outside > 0) ringOf(bitmap, pad, outside, strokePaint(stroke), canvas, strokeAlpha(stroke));
    if (fill < 1) {
      ctx.globalCompositeOperation = "destination-out";
      ctx.drawImage(bitmap, pad, pad);
      ctx.globalCompositeOperation = "source-over";
    }
    if (fill > 0) {
      ctx.globalAlpha = fill;
      ctx.drawImage(bitmap, pad, pad);
      ctx.globalAlpha = 1;
    }
    if (stroke.size > outside) innerRingOf(bitmap, pad, stroke.size - outside, strokePaint(stroke), canvas, strokeAlpha(stroke));
  };
  // The stroked picture made again only around what was painted since: what changed, grown by
  // the stroke's reach, from the pixels around it. False when it can't be done (a gradient's
  // stroke spans the whole shape).
  const patchStroked = (kept, bitmap, stroke, fill, version) => {
    if (strokeIsGradient(stroke)) return false;
    const since = touchedSince(bitmap, kept.version, version);
    if (!since) return false;
    const pad = kept.pad;
    // How far paint changes the picture around it: the stroke's reach outside, or its part
    // inside the shape (an Inside stroke reaches nowhere outside, and all its size inside)
    const far = Math.max(pad, Math.ceil(stroke.size - strokeOutside(stroke)) + 2);
    const out = emptyRect(since) ? since : withinCanvas({ left: since.left + pad - far, top: since.top + pad - far, right: since.right + pad + far, bottom: since.bottom + pad + far }, kept.canvas);
    if (!emptyRect(out)) {
      // The pixels the changed part depends on, in the layer's pixels
      // (twice as far: the cut's own edges would pass for the shape's, and draw a stroke there)
      const from = withinCanvas({ left: since.left - far * 2, top: since.top - far * 2, right: since.right + far * 2, bottom: since.bottom + far * 2 }, bitmap);
      const w = from.right - from.left;
      const h = from.bottom - from.top;
      const part = canvasLike(bitmap, w, h);
      part.getContext("2d").drawImage(bitmap, from.left, from.top, w, h, 0, 0, w, h);
      const made = newCanvas(w + pad * 2, h + pad * 2);
      drawStroked(part, pad, stroke, fill, made);
      // A pixel of `made` is the stroked picture's at from.left, from.top further
      const c = kept.canvas.getContext("2d");
      c.clearRect(out.left, out.top, out.right - out.left, out.bottom - out.top);
      c.drawImage(made, out.left - from.left, out.top - from.top, out.right - out.left, out.bottom - out.top, out.left, out.top, out.right - out.left, out.bottom - out.top);
    }
    const next = ++strokedVersion;
    touched(kept.canvas, kept.changes, next, out);
    Object.assign(kept, { version, changes: next });
    return true;
  };
  const strokedRaster = (shape, stroke, fill) => {
    if (!shape || !shape.canvas.width || !shape.canvas.height) return shape;
    const fixed = [strokeKeyOf(stroke), fill].join("|");
    const version = shape.version || 0;
    const bitmap = shape.canvas;
    let kept = strokedRasters.get(bitmap);
    const same = kept && kept.fixed === fixed && kept.canvas.width === bitmap.width + kept.pad * 2 && kept.canvas.height === bitmap.height + kept.pad * 2;
    if (!same || (kept.version !== version && !patchStroked(kept, bitmap, stroke, fill, version))) {
      const pad = Math.ceil(strokeReach(stroke)) + 2;
      const canvas = newCanvas(bitmap.width + pad * 2, bitmap.height + pad * 2);
      drawStroked(bitmap, pad, stroke, fill, canvas);
      kept = { fixed, version, canvas, pad, changes: ++strokedVersion };
      strokedRasters.set(bitmap, kept);
    }
    // Its own version: the picture changes in place while a brush paints on the layer
    return { canvas: kept.canvas, x: shape.x - kept.pad, y: shape.y - kept.pad, version: kept.changes };
  };
  // How far from a pixel of the letters their effects reach, and draw what they show from
  const fxReach = (effects) => {
    let reach = 0;
    ["dropShadow", "outerGlow", "innerShadow", "innerGlow"].forEach((name) => {
      const effect = effects[name];
      if (!fxShown(effect)) return;
      const [dx, dy] = name === "dropShadow" || name === "innerShadow" ? fxOffset(effect) : [0, 0];
      reach = Math.max(reach, Math.ceil(fxSize(effect)) + 2 + Math.max(Math.abs(dx), Math.abs(dy)));
    });
    return reach;
  };
  // A pixel layer's effects made again only around what was painted since they were made, in
  // the pictures kept (entry.built), which change in place. False when it can't be done.
  const patchEffects = (entry, effects, shape, fill, normal) => {
    const since = touchedSince(shape.canvas, entry.version, shape.version || 0);
    const built = entry.built;
    const pictures = [built].concat(built.under || NONE);
    if (!since) return false;
    const from = entry.changes || 0;
    let made = null;
    let out = null;
    let inside = null;
    if (!emptyRect(since)) {
      // What can change, and what that depends on, in the letters' pixels
      const reach = fxReach(effects);
      out = { left: since.left - reach, top: since.top - reach, right: since.right + reach, bottom: since.bottom + reach };
      inside = withinCanvas({ left: out.left - reach, top: out.top - reach, right: out.right + reach, bottom: out.bottom + reach }, shape.canvas);
      const w = inside.right - inside.left;
      const h = inside.bottom - inside.top;
      const crop = (canvas) => {
        const part = canvasLike(canvas, w, h);
        part.getContext("2d").drawImage(canvas, inside.left, inside.top, w, h, 0, 0, w, h);
        return part;
      };
      entry.box = unionOf(entry.box, since);
      const box = { left: entry.box.left - inside.left, top: entry.box.top - inside.top, right: entry.box.right - inside.left, bottom: entry.box.bottom - inside.top };
      made = buildEffects(effects, crop(shape.canvas), crop(fadedVisual(shape, fill).canvas), 0, 0, fill, normal, { x: inside.left, y: inside.top, box });
      if (made && (made.under || NONE).length !== pictures.length - 1) return false;
    }
    const parts = made ? [made].concat(made.under || NONE) : NONE;
    pictures.forEach((picture, i) => {
      // `dx`, `dy`: where a picture's top left is in the letters' pixels
      const to = picture.canvas;
      const area = out ? withinCanvas({ left: out.left - picture.dx, top: out.top - picture.dy, right: out.right - picture.dx, bottom: out.bottom - picture.dy }, to) : out;
      if (area && !emptyRect(area)) {
        const c = to.getContext("2d");
        c.clearRect(area.left, area.top, area.right - area.left, area.bottom - area.top);
        const part = parts[i];
        if (part) {
          // The part's picture, in the kept one's pixels
          const px = inside.left + part.dx - picture.dx;
          const py = inside.top + part.dy - picture.dy;
          const left = Math.max(area.left, px);
          const top = Math.max(area.top, py);
          const right = Math.min(area.right, px + part.canvas.width);
          const bottom = Math.min(area.bottom, py + part.canvas.height);
          if (right > left && bottom > top) c.drawImage(part.canvas, left - px, top - py, right - left, bottom - top, left, top, right - left, bottom - top);
        }
      }
      touched(to, from, from + 1, area || { left: 0, top: 0, right: 0, bottom: 0 });
    });
    entry.version = shape.version || 0;
    entry.changes = from + 1;
    return true;
  };
  // A stroke ended on a layer with effects: the page on screen keeps them as they were while it
  // painted, made again whole a moment later, once nothing else is painted on it meanwhile
  // (made whole at once for anything else: a file saved, a picture exported). By layer id.
  let paintingScreen = false;
  const settling = new Map();
  const settleEffects = (doc, layerId) => {
    clearTimeout(settling.get(layerId));
    settling.set(layerId, setTimeout(() => {
      settling.delete(layerId);
      if (app.doc === doc) emit("render");
    }, 400));
  };
  // A stroked one is a shape most often: its masks (a vector mask, the shape's own outline) cut
  // its pixels first, and the stroke goes around what they leave
  const styledRasterVisual = (layer, doc) => {
    const stroke = rasterStrokeOf(layer);
    const shape = stroke ? strokedRaster(applyMasks(rasterVisual(layer, doc), layer, doc), stroke, fillOf(layer)) : rasterVisual(layer, doc);
    const effects = effectsOn(layer);
    const fill = stroke ? 1 : fillOf(layer);
    if (!shape || !effects || !shape.canvas.width || !shape.canvas.height) return fadedVisual(shape, fill);
    const blend = doc.blendPreview && doc.blendPreview.ids.has(layer.id) ? doc.blendPreview.blend : layer.blend;
    const normal = (BLENDS[blend] || "source-over") === "source-over";
    const fixed = [fxKeyOf(effects), fill, normal].join("|");
    const key = fixed + "|" + (shape.version || 0);
    let kept = fxBuilt.get(shape.canvas);
    if (!kept) {
      kept = new Map();
      fxBuilt.set(shape.canvas, kept);
    }
    let entry = kept.get(layer.id);
    // While a stroke paints on it, its effects are made again only around the paint, on every
    // frame: as they will be, but for a Gradient Overlay that spans the layer's bounds as they
    // were, and blurs added up in another order. The stroke ended, they are made whole again
    // (see settleEffects).
    const painting = ((doc.liveStroke && doc.liveStroke.layerId === layer.id && !doc.liveStroke.target) || (paintingScreen && settling.has(layer.id)));
    if (painting && entry && entry.key !== key && entry.fixed === fixed && entry.built && patchEffects(entry, effects, shape, fill, normal)) {
      entry.key = key;
      entry.rough = true;
    }
    if (!entry || entry.key !== key || (entry.rough && !painting)) {
      const built = buildEffects(effects, shape.canvas, fadedVisual(shape, fill).canvas, 0, 0, fill, normal);
      entry = { key, fixed, version: shape.version || 0, built, box: built && built.box };
      kept.set(layer.id, entry);
      if (kept.size > FX_KEPT_LAYERS) kept.delete(kept.keys().next().value);
    }
    const built = entry.built;
    if (!built) return fadedVisual(shape, fill);
    // Its own version: the pictures change in place while a stroke paints on it
    const visual = { canvas: built.canvas, x: shape.x + built.dx, y: shape.y + built.dy, version: entry.changes || 0 };
    if (built.under) visual.under = built.under.map((item) => ({ canvas: item.canvas, x: shape.x + item.dx, y: shape.y + item.dy, blend: item.blend }));
    return visual;
  };

  // What a visual covers on the page, what goes under it included
  const visualRect = (visual) => {
    let left = visual.x;
    let top = visual.y;
    let right = visual.x + visual.canvas.width;
    let bottom = visual.y + visual.canvas.height;
    (visual.under || NONE).forEach((item) => {
      left = Math.min(left, item.x);
      top = Math.min(top, item.y);
      right = Math.max(right, item.x + item.canvas.width);
      bottom = Math.max(bottom, item.y + item.canvas.height);
    });
    return { left, top, right, bottom };
  };
  // What goes under a layer (its shadow, its glow), each in its own blend mode, moved by ox, oy.
  // Faded with a half-transparent layer, it is cut where the layer is, so as not to show
  // through it.
  const underCuts = new WeakMap();
  const underCut = (item, visual) => {
    const dx = visual.x - item.x;
    const dy = visual.y - item.y;
    const kept = underCuts.get(item.canvas);
    // A pixel layer's effects are brought up to date in place as it is painted on
    const version = visual.version || 0;
    if (kept && kept.main === visual.canvas && kept.version === version && kept.dx === dx && kept.dy === dy) return kept.canvas;
    const canvas = newCanvas(item.canvas.width, item.canvas.height);
    const c = canvas.getContext("2d");
    c.drawImage(item.canvas, 0, 0);
    c.globalCompositeOperation = "destination-out";
    c.drawImage(visual.canvas, dx, dy);
    underCuts.set(item.canvas, { main: visual.canvas, version, dx, dy, canvas });
    return canvas;
  };
  // `clip`: for a clipped text, the base's shape ({ canvas, x, y }, where `target` has it), which
  // its shadow and glow stay inside, whatever their blend mode
  const confinedTo = (picture, x, y, clip) => {
    const canvas = newCanvas(picture.width, picture.height);
    const c = canvas.getContext("2d");
    c.drawImage(picture, 0, 0);
    c.globalCompositeOperation = "destination-in";
    c.drawImage(clip.canvas, clip.x - x, clip.y - y);
    return canvas;
  };
  const drawUnder = (target, visual, ox, oy, alpha, matrix, clip) => {
    target.save();
    if (matrix) {
      target.transform(...matrix);
      target.imageSmoothingQuality = "high";
    }
    target.globalAlpha = alpha;
    visual.under.forEach((item) => {
      const picture = alpha < 1 ? underCut(item, visual) : item.canvas;
      target.globalCompositeOperation = item.blend;
      target.drawImage(clip ? confinedTo(picture, item.x + ox, item.y + oy, clip) : picture, item.x + ox, item.y + oy);
    });
    target.restore();
  };
  // One picture of a visual, what goes under it included, as a pixel layer keeps it
  const flatVisual = (visual) => {
    if (!visual || !visual.under) return visual;
    const { left, top, right, bottom } = visualRect(visual);
    const canvas = newCanvas(right - left, bottom - top);
    const ctx = canvas.getContext("2d");
    drawUnder(ctx, visual, -left, -top, 1);
    ctx.drawImage(visual.canvas, visual.x - left, visual.y - top);
    return { canvas, x: left, y: top };
  };

  /* ================================ masks ================================ */

  // A layer mask shows a layer where it is white and hides it where it is black, as in
  // Photoshop. It is kept as the file has it: grey in `canvas` (or no picture at all), with its
  // top left at `left`, `top` and `defaultColor` all round it, `disabled`, `userMaskDensity`
  // and `userMaskFeather`. What is painted on it since is in `paint`, in its own coordinates,
  // so that moving it moves the strokes too. `unlinked`: it stays put when the layer moves.
  // A vector mask (`layer.vectorMask`) is Photoshop's own, paths in page pixels.
  const maskOn = (layer) => Boolean(layer && layer.mask && !layer.mask.disabled);
  const vectorOn = (layer) => Boolean(layer && layer.vectorMask && !layer.vectorMask.disable && Array.isArray(layer.vectorMask.paths));
  // A pixel layer carries its masks along when it moves by dx, dy
  const maskShift = (layer) => (layer.kind === "raster" ? [layer.dx || 0, layer.dy || 0] : [0, 0]);
  const maskOrigin = (layer, mask = layer.mask) => {
    const [sx, sy] = maskShift(layer);
    return [(mask.left || 0) + sx, (mask.top || 0) + sy];
  };
  // A grey as Photoshop paints it on a mask, from a colour
  const grayOf = (color) => {
    if (!color) return 0;
    const r = color.red !== undefined ? color.red : color.r;
    const g = color.green !== undefined ? color.green : color.g;
    const b = color.blue !== undefined ? color.blue : color.b;
    return Math.max(0, Math.min(255, Math.round(0.299 * r + 0.587 * g + 0.114 * b)));
  };

  // A stroke or a fill on a mask, held as alpha: where it passes, the alpha goes towards the
  // grey it paints, as far as the brush covers. Nothing is ever just erased from a mask.
  const maskDrawOp = (ctx, op, points) => {
    let shape = null;
    let x = 0;
    let y = 0;
    if (op.t === "stroke") {
      if (!points) {
        op.points.forEach((point, index) => maskDrawOp(ctx, op, index ? [op.points[index - 1], point] : [point]));
        return;
      }
      const box = strokeBox(points, op.size);
      shape = newCanvas(box.width, box.height);
      const c = shape.getContext("2d");
      c.translate(-box.left, -box.top);
      c.strokeStyle = "#000";
      paintStroke(c, op, points);
      if (op.clip) {
        c.globalCompositeOperation = "destination-in";
        if (op.clip.canvas) c.drawImage(op.clip.canvas, op.clip.x, op.clip.y);
        else c.fillRect(op.clip.x, op.clip.y, op.clip.width, op.clip.height);
      }
      x = box.left;
      y = box.top;
    } else if (op.t === "gradient") {
      // As far as it covers, the mask goes towards the gradient's grey
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      ctx.drawImage(gradientShape(op, op.cover), op.x, op.y);
      ctx.globalCompositeOperation = "lighter";
      ctx.drawImage(gradientShape(op, op.canvas), op.x, op.y);
      ctx.restore();
      return;
    } else if (op.t === "fill" && op.clip && op.clip.canvas) {
      shape = op.clip.canvas;
      x = op.clip.x;
      y = op.clip.y;
    } else if (op.t === "fill") {
      ctx.save();
      const r = op.clip;
      const rect = r ? [r.x, r.y, r.width, r.height] : null;
      if (!rect) ctx.setTransform(1, 0, 0, 1, 0, 0);
      const area = rect || [0, 0, ctx.canvas.width, ctx.canvas.height];
      ctx.clearRect(...area);
      ctx.globalAlpha = op.gray / 255;
      ctx.fillStyle = "#000";
      ctx.fillRect(...area);
      ctx.restore();
      return;
    } else if (op.t === "pixels") {
      // The Smudge, Blur or Sharpen tool on a mask: its grey as alpha, in place of what was there
      ctx.save();
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      op.pieces.forEach((piece) => {
        ctx.clearRect(piece.x, piece.y, piece.canvas.width, piece.canvas.height);
        ctx.drawImage(piece.canvas, piece.x, piece.y);
      });
      ctx.restore();
      return;
    } else return;
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(shape, x, y);
    if (op.gray > 0) {
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = op.gray / 255;
      ctx.drawImage(shape, x, y);
    }
    ctx.restore();
  };

  // Something that holds a mask: a layer, or the Quick Mask (a page's own, at 0, 0)
  const maskHolder = (doc, target, layerId) => {
    if (target === "quick") return doc.state.quickMask ? { id: `quick:${doc.id}`, kind: "quick", mask: doc.state.quickMask } : null;
    const layer = doc.state.layers.find((item) => item.id === layerId);
    return layer && layer.mask ? layer : null;
  };

  // The part of a mask a stroke or a fill can touch, in the mask's own pixels: { left, top,
  // right, bottom }, or null when it can be anywhere
  const maskOpReaches = new WeakMap();
  const maskOpReach = (op) => {
    if (maskOpReaches.has(op)) return maskOpReaches.get(op);
    let reach = null;
    const sized = (x, y, width, height) => ({ left: Math.floor(x) - 1, top: Math.floor(y) - 1, right: Math.ceil(x + width) + 1, bottom: Math.ceil(y + height) + 1 });
    const clipped = (clip) => (clip.canvas ? sized(clip.x, clip.y, clip.canvas.width, clip.canvas.height) : sized(clip.x, clip.y, clip.width, clip.height));
    if (op.t === "stroke" && op.points.length) {
      // Each piece is drawn on a box of its own (see strokeBox): none goes past this
      const far = (op.size || 1) + 4;
      reach = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
      op.points.forEach(([x, y]) => {
        reach.left = Math.min(reach.left, Math.floor(x - far));
        reach.top = Math.min(reach.top, Math.floor(y - far));
        reach.right = Math.max(reach.right, Math.ceil(x + far));
        reach.bottom = Math.max(reach.bottom, Math.ceil(y + far));
      });
    } else if (op.t === "gradient") reach = sized(op.x, op.y, op.width, op.height);
    else if (op.t === "fill" && op.clip) reach = clipped(op.clip);
    else if (op.t === "pixels") op.pieces.forEach((piece) => { reach = unionOf(reach, sized(piece.x, piece.y, piece.canvas.width, piece.canvas.height)); });
    maskOpReaches.set(op, reach);
    return reach;
  };

  // Undo of a stroke on a mask starts from the nearest picture saved along the way, as a painted
  // layer's does (see markRaster), not from the first stroke: every MARK_EVERY steps, the part
  // of the mask its strokes reach so far. For a letter's mask that is the letter, not the page.
  const MASK_MARKS_BYTES = 24 * 1024 * 1024;
  const maskMarkFits = (mark, entry) => mark.whole || (mark.x0 === entry.x0 && mark.y0 === entry.y0 && mark.x1 === entry.x1 && mark.y1 === entry.y1);
  const markMask = (entry, paint, count) => {
    if (entry.marks.some((mark) => mark.count === count && mark.ops[count - 1] === paint[count - 1] && maskMarkFits(mark, entry))) return;
    let area = null;
    for (let i = 0; i < count; i++) {
      const reach = maskOpReach(paint[i]);
      if (!reach) return;
      area = unionOf(area, reach);
    }
    if (!area) return;
    const part = { left: Math.max(area.left, entry.x0), top: Math.max(area.top, entry.y0), right: Math.min(area.right, entry.x1), bottom: Math.min(area.bottom, entry.y1) };
    if (emptyRect(part)) return;
    const [w, h] = [part.right - part.left, part.bottom - part.top];
    const canvas = newCanvas(w, h);
    canvas.getContext("2d").drawImage(entry.canvas, part.left - entry.x0, part.top - entry.y0, w, h, 0, 0, w, h);
    // `whole`: none of it was cut by the canvas, so it holds for the mask wherever it moves
    const whole = part.left === area.left && part.top === area.top && part.right === area.right && part.bottom === area.bottom;
    entry.marks.push({ ops: paint.slice(0, count), count, canvas, left: part.left, top: part.top, whole, x0: entry.x0, y0: entry.y0, x1: entry.x1, y1: entry.y1 });
    let bytes = entry.marks.reduce((sum, mark) => sum + mark.canvas.width * mark.canvas.height * 4, 0);
    while (bytes > MASK_MARKS_BYTES && entry.marks.length > 1) {
      const gone = entry.marks.shift();
      bytes -= gone.canvas.width * gone.canvas.height * 4;
      releaseCanvas(gone.canvas);
    }
  };
  // The canvas as it was at a mark: only where the steps made since reach
  const backToMark = (entry, mask, mark) => {
    let area = null;
    let all = false;
    for (let i = mark.count; i < entry.paint.length && !all; i++) {
      const reach = maskOpReach(entry.paint[i]);
      if (reach) area = unionOf(area, reach);
      else all = true;
    }
    const box = all ? { left: entry.x0, top: entry.y0, right: entry.x1, bottom: entry.y1 } : area && { left: Math.max(area.left, entry.x0), top: Math.max(area.top, entry.y0), right: Math.min(area.right, entry.x1), bottom: Math.min(area.bottom, entry.y1) };
    if (box && !emptyRect(box)) {
      const { ctx } = entry;
      const [w, h] = [box.right - box.left, box.bottom - box.top];
      ctx.save();
      ctx.beginPath();
      ctx.rect(box.left, box.top, w, h);
      ctx.clip();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "#000";
      ctx.clearRect(box.left, box.top, w, h);
      if (entry.defaultColor) ctx.fillRect(box.left, box.top, w, h);
      if (entry.base) {
        ctx.clearRect(0, 0, entry.base.width, entry.base.height);
        ctx.drawImage(maskAlpha(mask), 0, 0);
      }
      ctx.clearRect(mark.left, mark.top, mark.canvas.width, mark.canvas.height);
      ctx.drawImage(mark.canvas, mark.left, mark.top);
      ctx.restore();
    }
    entry.paint = mark.ops;
    entry.version++;
  };
  const releaseMask = (entry, marks) => {
    releaseCanvas(entry.canvas);
    if (marks) entry.marks.forEach((mark) => releaseCanvas(mark.canvas));
  };

  // A painted mask keeps one canvas of alpha, over the page and its picture, and only draws
  // what is new, as a painted layer does. It moves with its layer: what it had drawn is kept,
  // and only the part of the page it didn't cover is drawn from its strokes.
  const maskCache = new Map();
  const maskEntry = (holder, doc) => {
    const mask = holder.mask;
    const paint = mask.paint || NONE;
    const [ox, oy] = maskOrigin(holder);
    const base = mask.canvas || null;
    let entry = maskCache.get(holder.id);
    const live = Boolean(doc.liveStroke && doc.liveStroke.target && doc.liveStroke.holderId === holder.id);
    const x0 = Math.floor(Math.min(-ox, base ? 0 : Infinity));
    const y0 = Math.floor(Math.min(-oy, base ? 0 : Infinity));
    const x1 = Math.ceil(Math.max(doc.width - ox, base ? base.width : -Infinity));
    const y1 = Math.ceil(Math.max(doc.height - oy, base ? base.height : -Infinity));
    const covers = entry && entry.x0 <= x0 && entry.y0 <= y0 && entry.x1 >= x1 && entry.y1 >= y1;
    // The same mask: its picture and its colour all round, whatever was painted since
    const kin = Boolean(entry && entry.docId === doc.id && entry.base === base && entry.defaultColor === Boolean(mask.defaultColor));
    const drawn = () => entry.paint.length <= paint.length && entry.paint.every((op, i) => op === paint[i]);
    // Steps undone: back to the last mark they all come after
    if (kin && !live && !drawn()) {
      let mark = null;
      entry.marks.forEach((item) => {
        if (item.count <= paint.length && (!mark || item.count > mark.count) && maskMarkFits(item, entry) && item.ops.every((op, i) => op === paint[i] && op === entry.paint[i])) mark = item;
      });
      if (mark) backToMark(entry, mask, mark);
    }
    const same = kin && drawn();
    if (!same || !covers) {
      const canvas = newCanvas(x1 - x0, y1 - y0);
      const ctx = canvas.getContext("2d");
      if (mask.defaultColor) ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.translate(-x0, -y0);
      if (base) {
        ctx.clearRect(0, 0, base.width, base.height);
        ctx.drawImage(maskAlpha(mask), 0, 0);
      }
      // What the canvas before and this one both hold, in the mask's pixels
      const held = same ? { left: Math.max(entry.x0, x0), top: Math.max(entry.y0, y0), right: Math.min(entry.x1, x1), bottom: Math.min(entry.y1, y1) } : null;
      let done = NONE;
      if (held && !emptyRect(held)) {
        const [w, h] = [held.right - held.left, held.bottom - held.top];
        ctx.clearRect(held.left, held.top, w, h);
        ctx.drawImage(entry.canvas, held.left - entry.x0, held.top - entry.y0, w, h, held.left, held.top, w, h);
        // All round it, the strokes that reach there, in their order
        done = entry.paint;
        [
          { left: x0, top: y0, right: x1, bottom: held.top },
          { left: x0, top: held.bottom, right: x1, bottom: y1 },
          { left: x0, top: held.top, right: held.left, bottom: held.bottom },
          { left: held.right, top: held.top, right: x1, bottom: held.bottom },
        ].forEach((strip) => {
          if (emptyRect(strip)) return;
          const reaching = done.filter((op) => {
            const reach = maskOpReach(op);
            return !reach || (reach.left < strip.right && reach.right > strip.left && reach.top < strip.bottom && reach.bottom > strip.top);
          });
          if (!reaching.length) return;
          ctx.save();
          ctx.beginPath();
          ctx.rect(strip.left, strip.top, strip.right - strip.left, strip.bottom - strip.top);
          ctx.clip();
          reaching.forEach((op) => maskDrawOp(ctx, op));
          ctx.restore();
        });
      }
      const replaced = entry;
      entry = { canvas, ctx, x0, y0, x1, y1, base, defaultColor: Boolean(mask.defaultColor), paint: done, version: done.length ? replaced.version + 1 : 0, docId: doc.id, marks: kin ? replaced.marks : [] };
      if (replaced) releaseMask(replaced, !kin);
      maskCache.set(holder.id, entry);
      if (maskCache.size > 24) {
        const oldestKey = maskCache.keys().next().value;
        const oldest = maskCache.get(oldestKey);
        maskCache.delete(oldestKey);
        if (oldest) releaseMask(oldest, true);
      }
    }
    if (entry.paint.length < paint.length) {
      for (let i = entry.paint.length; i < paint.length; i++) {
        maskDrawOp(entry.ctx, paint[i]);
        if ((i + 1) % MARK_EVERY === 0 && !live) markMask(entry, paint, i + 1);
      }
      entry.paint = paint;
      entry.version++;
    } else if (!live && paint.length && paint.length % MARK_EVERY === 0) markMask(entry, paint, paint.length);
    return entry;
  };

  // A Gaussian blur of `sigma` px on an alpha picture: the canvas's own filter where the
  // browser has one, three box blurs otherwise
  const canFilter = (() => {
    try {
      return typeof document.createElement("canvas").getContext("2d").filter === "string";
    } catch (error) {
      return false;
    }
  })();
  const blurAlpha = (canvas, sigma) => {
    const out = newCanvas(canvas.width, canvas.height);
    const ctx = out.getContext("2d", { willReadFrequently: !canFilter });
    if (canFilter) {
      ctx.filter = `blur(${sigma}px)`;
      ctx.drawImage(canvas, 0, 0);
      ctx.filter = "none";
      return out;
    }
    ctx.drawImage(canvas, 0, 0);
    const w = out.width;
    const h = out.height;
    const image = ctx.getImageData(0, 0, w, h);
    let a = new Float32Array(w * h);
    for (let i = 0; i < a.length; i++) a[i] = image.data[i * 4 + 3];
    let b = new Float32Array(w * h);
    const r = Math.max(1, Math.round(Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2));
    const pass = (from, to, horizontal) => {
      const n = horizontal ? w : h;
      const lines = horizontal ? h : w;
      for (let line = 0; line < lines; line++) {
        const at = (k) => (horizontal ? line * w + k : k * w + line);
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += from[at(Math.max(0, Math.min(n - 1, k)))];
        for (let k = 0; k < n; k++) {
          to[at(k)] = sum / (2 * r + 1);
          sum += from[at(Math.min(n - 1, k + r + 1))] - from[at(Math.max(0, k - r))];
        }
      }
    };
    for (let i = 0; i < 3; i++) {
      pass(a, b, true);
      pass(b, a, false);
    }
    for (let i = 0; i < a.length; i++) {
      image.data[i * 4] = image.data[i * 4 + 1] = image.data[i * 4 + 2] = 0;
      image.data[i * 4 + 3] = Math.round(a[i]);
    }
    ctx.putImageData(image, 0, 0);
    b = null;
    a = null;
    return out;
  };

  // Density and Feather (Properties > Masks): black lets 100 - density % through, and the
  // edges blur by the feather's width. `outside` is what the mask is all round its picture.
  const softened = new WeakMap();
  const softenedMask = (picture, density, feather) => {
    if (density >= 1 && !(feather > 0)) return picture;
    const key = [picture.version || 0, picture.x, picture.y, picture.outside, density, feather].join(",");
    const kept = softened.get(picture.canvas || softened);
    if (kept && kept.key === key) return kept.picture;
    const outside = 1 - density * (1 - picture.outside);
    let result;
    if (!picture.canvas) result = { canvas: null, x: 0, y: 0, outside };
    else {
      const pad = feather > 0 ? Math.ceil(feather * 3) + 2 : 0;
      const canvas = newCanvas(picture.canvas.width + pad * 2, picture.canvas.height + pad * 2);
      const c = canvas.getContext("2d");
      c.globalAlpha = 1 - density;
      c.fillRect(0, 0, canvas.width, canvas.height);
      c.globalAlpha = 1;
      if (pad) {
        // The edge of the picture blurs into what is round it, not into nothing
        const ring = newCanvas(canvas.width, canvas.height);
        const r = ring.getContext("2d");
        r.globalAlpha = picture.outside;
        r.fillRect(0, 0, ring.width, ring.height);
        r.globalAlpha = 1;
        r.clearRect(pad, pad, picture.canvas.width, picture.canvas.height);
        r.drawImage(picture.canvas, pad, pad);
        c.drawImage(ring, 0, 0);
      } else c.drawImage(picture.canvas, 0, 0);
      result = { canvas: feather > 0 ? blurAlpha(canvas, feather) : canvas, x: picture.x - pad, y: picture.y - pad, outside };
    }
    softened.set(picture.canvas || softened, { key, picture: result });
    return result;
  };

  // A pixel mask as alpha on the page: { canvas, x, y, outside, version }
  const maskPicture = (holder, doc, raw) => {
    const mask = holder.mask;
    const [ox, oy] = maskOrigin(holder);
    const live = doc.liveStroke && doc.liveStroke.target && doc.liveStroke.holderId === holder.id;
    let picture;
    if ((mask.paint && mask.paint.length) || live) {
      const entry = maskEntry(holder, doc);
      picture = { canvas: entry.canvas, x: ox + entry.x0, y: oy + entry.y0, outside: mask.defaultColor ? 1 : 0, version: entry.version };
    } else if (mask.canvas && mask.canvas.width && mask.canvas.height) picture = { canvas: maskAlpha(mask), x: ox, y: oy, outside: mask.defaultColor ? 1 : 0, version: 0 };
    else picture = { canvas: null, x: 0, y: 0, outside: mask.defaultColor ? 1 : 0, version: 0 };
    if (raw) return picture;
    const density = mask.userMaskDensity === undefined ? 1 : mask.userMaskDensity;
    return softenedMask(picture, density, mask.userMaskFeather || 0);
  };

  // A vector mask's paths, each a Bézier outline. Components follow one another as Photoshop's
  // path operations: combine, subtract, intersect, exclude.
  const tracePaths = (target, paths, dx, dy) => {
    paths.forEach((path) => {
      const knots = path.knots || [];
      if (!knots.length) return;
      const point = (k, i) => [k.points[i] + dx, k.points[i + 1] + dy];
      target.moveTo(...point(knots[0], 2));
      for (let i = 1; i <= knots.length; i++) {
        if (i === knots.length && path.open) break;
        const a = knots[i - 1];
        const b = knots[i % knots.length];
        target.bezierCurveTo(...point(a, 4), ...point(b, 0), ...point(b, 2));
      }
      if (!path.open) target.closePath();
    });
  };
  const vectorComponents = (vm) => {
    const out = [];
    (vm.paths || []).forEach((path) => {
      if (path.operation || !out.length) out.push({ operation: path.operation || "combine", paths: [path] });
      else out[out.length - 1].paths.push(path);
    });
    return out;
  };
  const vectorBounds = (vm, dx, dy) => {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    (vm.paths || []).forEach((path) => (path.knots || []).forEach((knot) => {
      for (let i = 0; i < 6; i += 2) {
        left = Math.min(left, knot.points[i] + dx);
        right = Math.max(right, knot.points[i] + dx);
        top = Math.min(top, knot.points[i + 1] + dy);
        bottom = Math.max(bottom, knot.points[i + 1] + dy);
      }
    }));
    return left > right ? null : { left: Math.floor(left) - 2, top: Math.floor(top) - 2, right: Math.ceil(right) + 2, bottom: Math.ceil(bottom) + 2 };
  };
  const vectorPictures = new WeakMap();
  const vectorPicture = (layer) => {
    const vm = layer.vectorMask;
    const [dx, dy] = maskShift(layer);
    const kept = vectorPictures.get(vm);
    if (kept && kept.dx === dx && kept.dy === dy) return kept.picture;
    // What the paths make far from them: the page is all there at the start, or nothing
    let outside = vm.fillStartsWithAllPixels ? 1 : 0;
    const parts = vectorComponents(vm);
    parts.forEach(({ operation }) => { if (operation === "intersect") outside = 0; });
    const box = vectorBounds(vm, dx, dy);
    let picture;
    if (!box) picture = { canvas: null, x: 0, y: 0, outside: vm.invert ? 1 - outside : outside, version: 0 };
    else {
      const canvas = newCanvas(box.right - box.left, box.bottom - box.top);
      const c = canvas.getContext("2d");
      if (vm.fillStartsWithAllPixels) c.fillRect(0, 0, canvas.width, canvas.height);
      parts.forEach(({ operation, paths }) => {
        const shape = new Path2D();
        tracePaths(shape, paths, dx - box.left, dy - box.top);
        const rule = paths[0].fillRule === "non-zero" ? "nonzero" : "evenodd";
        c.globalCompositeOperation = operation === "subtract" ? "destination-out" : operation === "intersect" ? "destination-in" : operation === "exclude" ? "xor" : "source-over";
        c.fill(shape, rule);
      });
      if (vm.invert) {
        c.globalCompositeOperation = "xor";
        c.fillRect(0, 0, canvas.width, canvas.height);
      }
      picture = { canvas, x: box.left, y: box.top, outside: vm.invert ? 1 - outside : outside, version: 0 };
    }
    const density = vm.density === undefined ? 1 : vm.density;
    picture = softenedMask(picture, density, vm.feather || 0);
    vectorPictures.set(vm, { dx, dy, picture });
    return picture;
  };

  // The work path's shape (see ops.setWorkPath) as an alpha picture of the page, { canvas, x,
  // y }, or null when it covers nothing of it. A subpath left open is closed by a straight
  // line, as Photoshop fills it. `antiAlias`: its edge as much there as the path covers each
  // pixel, else on or off at half. `feather`: blurred that many pixels.
  const pathAlpha = (doc, path, antiAlias, feather) => {
    const box = vectorBounds(path, 0, 0);
    if (!box) return null;
    const pad = feather > 0 ? Math.ceil(feather * 3) : 0;
    const left = Math.max(0, box.left - pad);
    const top = Math.max(0, box.top - pad);
    const right = Math.min(doc.width, box.right + pad);
    const bottom = Math.min(doc.height, box.bottom + pad);
    if (right - left < 1 || bottom - top < 1) return null;
    const canvas = newCanvas(right - left, bottom - top);
    const c = canvas.getContext("2d", { willReadFrequently: true });
    vectorComponents(path).forEach(({ operation, paths }) => {
      const shape = new Path2D();
      tracePaths(shape, paths, -left, -top);
      c.globalCompositeOperation = operation === "subtract" ? "destination-out" : operation === "intersect" ? "destination-in" : operation === "exclude" ? "xor" : "source-over";
      c.fill(shape, paths[0].fillRule === "non-zero" ? "nonzero" : "evenodd");
    });
    if (!antiAlias) {
      const image = c.getImageData(0, 0, canvas.width, canvas.height);
      for (let i = 3; i < image.data.length; i += 4) image.data[i] = image.data[i] > 127 ? 255 : 0;
      c.putImageData(image, 0, 0);
    }
    return { canvas: feather > 0 ? blurAlpha(canvas, feather) : canvas, x: left, y: top };
  };
  // A selection from an alpha picture of the page: selected where it is half there or more,
  // and its soft edge kept beside (see selectionCanvas). null when nothing is.
  const softSelection = (picture) => {
    const { width, height } = picture.canvas;
    const px = picture.canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, width, height).data;
    let left = width;
    let top = -1;
    let right = -1;
    let bottom = -1;
    let any = false;
    let soft = false;
    for (let y = 0; y < height; y++) {
      const row = y * width * 4 + 3;
      for (let x = 0; x < width; x++) {
        const a = px[row + x * 4];
        if (!a) continue;
        if (a > 127) any = true;
        if (a < 255) soft = true;
        if (x < left) left = x;
        if (x > right) right = x;
        if (top < 0) top = y;
        bottom = y;
      }
    }
    if (!any) return null;
    const boxW = right - left + 1;
    const boxH = bottom - top + 1;
    const mask = new Uint8Array(boxW * boxH);
    const alpha = new Uint8Array(boxW * boxH);
    for (let y = 0; y < boxH; y++) {
      const row = ((top + y) * width + left) * 4 + 3;
      for (let x = 0; x < boxW; x++) {
        const a = px[row + x * 4];
        alpha[y * boxW + x] = a;
        if (a > 127) mask[y * boxW + x] = 1;
      }
    }
    const selection = makeSelection({ source: "mask", mask, boxW, boxH, left: picture.x + left, top: picture.y + top });
    if (soft) selection.mask.alpha = alpha;
    return selection;
  };

  // A layer with a mask that stays put when the layer moves
  const looseMasks = (layer) => Boolean((maskOn(layer) && layer.mask.unlinked) || (vectorOn(layer) && layer.vectorMask.notLink));
  // Cuts a picture that sits at (x, y) of the page with a mask. `area`: only that rectangle of
  // it, the rest left as it is.
  const cutWith = (ctx, width, height, x, y, picture, area) => {
    if (picture.outside >= 1 && !picture.canvas) return;
    const left = area ? area.left : 0;
    const top = area ? area.top : 0;
    const w = area ? area.right - area.left : width;
    const h = area ? area.bottom - area.top : height;
    const alpha = area ? canvasLike(ctx.canvas, w, h) : newCanvas(width, height);
    const a = alpha.getContext("2d");
    if (picture.outside > 0) {
      a.globalAlpha = picture.outside;
      a.fillRect(0, 0, w, h);
      a.globalAlpha = 1;
    }
    if (picture.canvas) {
      a.clearRect(picture.x - x - left, picture.y - y - top, picture.canvas.width, picture.canvas.height);
      a.drawImage(picture.canvas, picture.x - x - left, picture.y - y - top);
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (area) {
      ctx.beginPath();
      ctx.rect(left, top, w, h);
      ctx.clip();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(alpha, left, top);
    ctx.restore();
  };
  // A stroke's settings written out once per settings object, not on every frame
  const strokeKeys = new WeakMap();
  const strokeKeyOf = (stroke) => {
    let key = strokeKeys.get(stroke);
    if (key === undefined) {
      key = JSON.stringify(stroke);
      strokeKeys.set(stroke, key);
    }
    return key;
  };
  // `bare`: without what painting on the mask changes, its version
  const masksKey = (layer, doc, bare) => {
    const parts = [];
    if (maskOn(layer)) {
      const p = maskPicture(layer, doc);
      parts.push("m", identity(p.canvas || NONE), p.x, p.y, p.outside, bare ? "" : p.version || 0);
    }
    if (vectorOn(layer)) {
      const p = vectorPicture(layer);
      parts.push("v", identity(p.canvas || NONE), p.x, p.y, p.outside);
    }
    return parts.join(",");
  };
  // What a layer shows through its masks. The last pictures are kept, keyed by what made them.
  const maskedVisuals = new Map();
  const applyMasks = (visual, layer, doc) => {
    if (!visual || !visual.canvas || (!maskOn(layer) && !vectorOn(layer))) return visual;
    const version = visual.version || 0;
    const key = [identity(visual.canvas), version, visual.x, visual.y, masksKey(layer, doc)].join("|");
    const kept = maskedVisuals.get(layer.id);
    if (kept && kept.key === key) return kept.visual;
    const items = [visual].concat(visual.under || NONE);
    // The same pictures in the same places, painted on since, or their mask: cut again there
    const fixed = items.map((item) => [identity(item.canvas), item.x, item.y].join(",")).join(";") + "|" + masksKey(layer, doc, true);
    const mask = maskOn(layer) ? maskPicture(layer, doc) : null;
    if (kept && kept.fixed === fixed) {
      let area = mask && mask.canvas ? touchedSince(mask.canvas, kept.maskVersion, mask.version || 0) : { left: 0, top: 0, right: 0, bottom: 0 };
      if (area) area = { left: area.left + mask.x, top: area.top + mask.y, right: area.right + mask.x, bottom: area.bottom + mask.y };
      items.forEach((item) => {
        const since = area && touchedSince(item.canvas, kept.version, version);
        area = since && unionOf(area, { left: since.left + item.x, top: since.top + item.y, right: since.right + item.x, bottom: since.bottom + item.y });
      });
      if (area) {
        // Its own version, which a change of the mask alone moves on too
        const from = kept.visual.version || 0;
        [kept.visual].concat(kept.visual.under || NONE).forEach((out, i) => {
          const item = items[i];
          const part = withinCanvas({ left: area.left - item.x, top: area.top - item.y, right: area.right - item.x, bottom: area.bottom - item.y }, item.canvas);
          if (!emptyRect(part)) {
            const ctx = out.canvas.getContext("2d");
            const [x, y, w, h] = [part.left, part.top, part.right - part.left, part.bottom - part.top];
            ctx.clearRect(x, y, w, h);
            ctx.drawImage(item.canvas, x, y, w, h, x, y, w, h);
            if (mask) cutWith(ctx, w, h, item.x, item.y, mask, part);
            if (vectorOn(layer)) cutWith(ctx, w, h, item.x, item.y, vectorPicture(layer), part);
          }
          touched(out.canvas, from, from + 1, part);
        });
        Object.assign(kept, { key, version, maskVersion: mask ? mask.version || 0 : 0 });
        kept.visual = Object.assign({}, kept.visual, { version: from + 1 });
        return kept.visual;
      }
    }
    // A text's shadow and glow are hidden by its masks too, as Photoshop's "Layer Mask Hides
    // Effects": they come from the whole letters
    const cut = (picture, x, y) => {
      const canvas = newCanvas(picture.width, picture.height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(picture, 0, 0);
      if (maskOn(layer)) cutWith(ctx, canvas.width, canvas.height, x, y, maskPicture(layer, doc));
      if (vectorOn(layer)) cutWith(ctx, canvas.width, canvas.height, x, y, vectorPicture(layer));
      return canvas;
    };
    const masked = { canvas: cut(visual.canvas, visual.x, visual.y), x: visual.x, y: visual.y };
    if (visual.under) masked.under = visual.under.map((item) => Object.assign({}, item, { canvas: cut(item.canvas, item.x, item.y) }));
    maskedVisuals.delete(layer.id);
    maskedVisuals.set(layer.id, { key, fixed, version, maskVersion: mask ? mask.version || 0 : 0, visual: masked, docId: doc.id });
    if (maskedVisuals.size > 32) {
      const oldestKey = maskedVisuals.keys().next().value;
      maskedVisuals.delete(oldestKey);
    }
    return masked;
  };

  // A mask's alpha over a part of the page, as a canvas of the part's size
  const maskOverPage = (picture, left, top, width, height) => {
    const canvas = newCanvas(width, height);
    const c = canvas.getContext("2d");
    if (picture.outside > 0) {
      c.globalAlpha = picture.outside;
      c.fillRect(0, 0, width, height);
      c.globalAlpha = 1;
    }
    if (picture.canvas) {
      c.clearRect(picture.x - left, picture.y - top, picture.canvas.width, picture.canvas.height);
      c.drawImage(picture.canvas, picture.x - left, picture.y - top);
    }
    return canvas;
  };
  // Grey, as the Layers panel and Alt + click show a mask: white where it shows the layer
  const maskAsGray = (alpha) => {
    const canvas = newCanvas(alpha.width, alpha.height);
    const c = canvas.getContext("2d");
    c.drawImage(alpha, 0, 0);
    c.globalCompositeOperation = "source-in";
    c.fillStyle = "#fff";
    c.fillRect(0, 0, canvas.width, canvas.height);
    c.globalCompositeOperation = "destination-over";
    c.fillStyle = "#000";
    c.fillRect(0, 0, canvas.width, canvas.height);
    return canvas;
  };
  // The grey picture a PSD keeps of a mask, cut to where it differs from its colour all round
  const maskForFile = (picture, defaultColor) => {
    if (!picture.canvas) return null;
    const { width, height } = picture.canvas;
    const data = picture.canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, width, height).data;
    const around = defaultColor ? 255 : 0;
    let x0 = width;
    let y0 = height;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] === around) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) return null;
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const canvas = newCanvas(w, h);
    const c = canvas.getContext("2d");
    const image = c.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = data[((y + y0) * width + x + x0) * 4 + 3];
        const i = (y * w + x) * 4;
        image.data[i] = image.data[i + 1] = image.data[i + 2] = v;
        image.data[i + 3] = 255;
      }
    }
    c.putImageData(image, 0, 0);
    return { canvas, left: picture.x + x0, top: picture.y + y0 };
  };
  // A mask with everything painted on it made part of its picture, on the page at (0, 0) of a
  // layer that hasn't moved. Undo keeps the old one.
  const settledMask = (layer, doc) => {
    const mask = layer.mask;
    if (!mask) return null;
    const [sx, sy] = maskShift(layer);
    const picture = maskPicture(layer, doc, true);
    const file = maskForFile(picture, mask.defaultColor);
    const out = Object.assign({}, mask, { paint: NONE, canvas: file ? file.canvas : null, left: file ? file.left - sx : 0, top: file ? file.top - sy : 0 });
    out.right = out.left + (file ? file.canvas.width : 0);
    out.bottom = out.top + (file ? file.canvas.height : 0);
    return out;
  };
  // The same, in page coordinates: for a pixel layer whose pictures start again at dx = dy = 0
  const pageMask = (layer, doc) => {
    if (!layer.mask) return null;
    const m = layer.mask.paint && layer.mask.paint.length ? settledMask(layer, doc) : layer.mask;
    const [sx, sy] = maskShift(layer);
    if (!sx && !sy) return m;
    return Object.assign({}, m, { left: (m.left || 0) + sx, top: (m.top || 0) + sy, right: (m.right || 0) + sx, bottom: (m.bottom || 0) + sy });
  };
  // A vector mask with each point of its paths moved by `f`
  const mappedVector = (vm, f) => Object.assign({}, vm, {
    paths: (vm.paths || []).map((path) => Object.assign({}, path, {
      knots: (path.knots || []).map((knot) => {
        const points = knot.points.slice();
        for (let i = 0; i < 6; i += 2) [points[i], points[i + 1]] = f(points[i], points[i + 1]);
        return Object.assign({}, knot, { points });
      }),
    })),
  });
  const shiftedVector = (vm, dx, dy) => (dx || dy ? mappedVector(vm, (x, y) => [x + dx, y + dy]) : vm);
  // A layer's masks moved by dx, dy with it, or with the whole page (`all`): unlinked, a mask
  // stays where it is when only its layer moves
  const movedMasks = (layer, dx, dy, all) => {
    const out = {};
    const raster = layer.kind === "raster";
    const mask = layer.mask;
    if (mask && (raster ? !all && mask.unlinked : all || !mask.unlinked)) {
      const k = raster ? -1 : 1;
      out.mask = Object.assign({}, mask, { left: (mask.left || 0) + dx * k, top: (mask.top || 0) + dy * k, right: (mask.right || 0) + dx * k, bottom: (mask.bottom || 0) + dy * k });
    }
    const vm = layer.vectorMask;
    if (vm && (raster ? !all && vm.notLink : all || !vm.notLink)) out.vectorMask = raster ? shiftedVector(vm, -dx, -dy) : shiftedVector(vm, dx, dy);
    return out;
  };
  // Both masks at a new size of the page, for a layer drawn again at dx = dy = 0
  const scaledMasks = (layer, doc, sx, sy) => {
    const out = {};
    if (layer.mask) {
      const m = pageMask(layer, doc);
      if (m.canvas) {
        const p = scaledPixels(m.canvas, m.left || 0, m.top || 0, sx, sy);
        out.mask = Object.assign({}, m, { canvas: p.canvas, left: p.left, top: p.top, right: p.left + p.canvas.width, bottom: p.top + p.canvas.height });
      } else out.mask = Object.assign({}, m, { left: 0, top: 0 });
    }
    if (layer.vectorMask) {
      const [ax, ay] = maskShift(layer);
      out.vectorMask = mappedVector(layer.vectorMask, (x, y) => [(x + ax) * sx, (y + ay) * sy]);
    }
    return out;
  };

  /* ============================ smart filters ============================ */

  // A text Photoshop would keep as a smart object: `layer.filters`, its Smart Filters. A list
  // (empty: a smart object with no filter yet), applied in order to the text drawn whole, its
  // letters with their stroke and their effects, as the smart object holds them, before the
  // layer's masks, its opacity and its blend mode. The text stays a text here, edited, styled,
  // warped and moved as any other, and the filters are drawn again from it; psd.js writes it as
  // Photoshop would, a smart object holding the text with these as its Smart Filters, and reads
  // one back. Each filter is { type, ...its settings }: "motionBlur" has { angle, distance }.
  // Another blur joins by its entry here (Gaussian Blur: { radius }, blurred by blurVariance's),
  // and by its name in psd.js (SMART_FILTER_OUT).
  const SMART_FILTERS = {
    motionBlur: {
      clean: (f) => (Number(f.distance) >= 1 ? { type: "motionBlur", angle: Math.max(-360, Math.min(360, Math.round(Number(f.angle) || 0))), distance: Math.max(1, Math.min(MOTION_MAX, Math.round(Number(f.distance)))) } : null),
      blur: (f) => motionKernel(f.angle, f.distance),
    },
  };
  // The step of history each one makes, Photoshop's name for it
  const SMART_FILTER_NAMES = { motionBlur: "Motion Blur" };
  const cleanFilter = (filter) => (filter && SMART_FILTERS[filter.type] ? SMART_FILTERS[filter.type].clean(filter) : null);
  const isSmart = (layer) => Boolean(layer && layer.kind === "text" && Array.isArray(layer.filters));
  const filtersOn = (layer) => (isSmart(layer) && layer.filters.some((filter) => SMART_FILTERS[filter.type]) ? layer.filters.filter((filter) => SMART_FILTERS[filter.type]) : null);
  // What the smart object holds: the text with its stroke and effects, alone on nothing (its
  // effects blend with nothing under them, and its blend mode is the smart object's)
  const smartContents = (layer, doc) => {
    const inside = Object.assign({}, layer, { id: `${layer.id}|inside`, blend: "normal", filters: undefined, mask: null, vectorMask: null });
    return inside.effects ? styledTextVisual(inside, doc) : textVisual(inside, doc);
  };
  // A picture blurred as Photoshop blurs a smart object: as a pixel layer's (see blurRegions),
  // grown as far as the blur reaches, within the page and the picture
  const blurredVisual = (visual, how, doc) => {
    const rect = visualRect(visual);
    const vis = { left: Math.floor(rect.left), top: Math.floor(rect.top), right: Math.ceil(rect.right), bottom: Math.ceil(rect.bottom) };
    const whole = unionOf(vis, { left: 0, top: 0, right: doc.width, bottom: doc.height });
    const out = blurClip(blurGrow(vis, how.reach), whole);
    const read = blurClip(blurGrow(out, how.reach), whole);
    if (emptyRect(out) || !canvasFits(read.right - read.left, read.bottom - read.top)) return visual;
    const canvas = newCanvas(read.right - read.left, read.bottom - read.top);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (visual.under) drawUnder(ctx, visual, -read.left, -read.top, 1);
    ctx.drawImage(visual.canvas, visual.x - read.left, visual.y - read.top);
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const local = { left: out.left - read.left, top: out.top - read.top, right: out.right - read.left, bottom: out.bottom - read.top };
    blurImage(image, how, local, null, false, false);
    const result = newCanvas(out.right - out.left, out.bottom - out.top);
    result.getContext("2d").putImageData(image, -local.left, -local.top, local.left, local.top, local.right - local.left, local.bottom - local.top);
    return { canvas: result, x: out.left, y: out.top };
  };
  // Kept by the picture filtered, a few places of it (copies of a text share their letters)
  const filteredVisuals = new WeakMap();
  const filterKeys = new WeakMap();
  const filterKeyOf = (filters) => {
    let key = filterKeys.get(filters);
    if (key === undefined) {
      key = JSON.stringify(filters);
      filterKeys.set(filters, key);
    }
    return key;
  };
  const filteredVisual = (visual, filters, doc) => {
    if (!visual || !visual.canvas || !visual.canvas.width || !visual.canvas.height) return visual;
    const key = [filterKeyOf(filters), visual.x, visual.y, visual.version || 0, doc.width, doc.height].concat((visual.under || NONE).map((item) => [identity(item.canvas), item.x, item.y, item.blend].join(","))).join("|");
    let kept = filteredVisuals.get(visual.canvas);
    if (!kept) {
      kept = new Map();
      filteredVisuals.set(visual.canvas, kept);
    }
    if (!kept.has(key)) {
      if (kept.size >= 4) kept.delete(kept.keys().next().value);
      kept.set(key, filters.reduce((picture, filter) => blurredVisual(picture, SMART_FILTERS[filter.type].blur(filter), doc), visual));
    }
    return kept.get(key);
  };

  const visualOf = (layer, doc) => {
    const filters = layer.kind === "text" ? filtersOn(layer) : null;
    const visual = filters ? filteredVisual(smartContents(layer, doc), filters, doc) : layer.kind === "text" ? (layer.effects ? styledTextVisual(layer, doc) : textVisual(layer, doc, layer.unblended || layer.opacity === undefined ? 1 : layer.opacity)) : layer.kind === "raster" ? fadedVisual(rasterVisual(layer, doc), fillOf(layer)) : null;
    return applyMasks(visual, layer, doc);
  };
  // A layer as the page shows it: a pixel layer with its effects too
  const pageVisualOf = (layer, doc) => {
    if (layer.kind === "raster" && rasterStrokeOf(layer)) return styledRasterVisual(layer, doc);
    return layer.kind === "raster" && effectsOn(layer) ? applyMasks(styledRasterVisual(layer, doc), layer, doc) : visualOf(layer, doc);
  };
  // A pixel layer's own pixels have no stroke: its Fill fades them, kept by picture
  const faded = new WeakMap();
  const fadedVisual = (visual, fill) => {
    if (!visual || fill >= 1) return visual;
    const kept = faded.get(visual.canvas);
    const version = visual.version || 0;
    // Painted on since: faded again where the paint went
    const since = kept && kept.fill === fill && kept.version !== version ? touchedSince(visual.canvas, kept.version, version) : null;
    if (since) {
      if (!emptyRect(since)) {
        const c = kept.canvas.getContext("2d");
        const [x, y, w, h] = [since.left, since.top, since.right - since.left, since.bottom - since.top];
        c.clearRect(x, y, w, h);
        c.globalAlpha = fill;
        c.drawImage(visual.canvas, x, y, w, h, x, y, w, h);
        c.globalAlpha = 1;
      }
      touched(kept.canvas, kept.version, version, since);
      kept.version = version;
    }
    if (kept && kept.version === version && kept.fill === fill) return Object.assign({}, visual, { canvas: kept.canvas });
    const canvas = newCanvas(visual.canvas.width, visual.canvas.height);
    const ctx = canvas.getContext("2d");
    ctx.globalAlpha = fill;
    ctx.drawImage(visual.canvas, 0, 0);
    faded.set(visual.canvas, { version: visual.version || 0, fill, canvas });
    return Object.assign({}, visual, { canvas });
  };

  const BLENDS = { normal: "source-over", "pass through": "source-over", dissolve: "source-over", multiply: "multiply", screen: "screen", overlay: "overlay", darken: "darken", lighten: "lighten", "color dodge": "color-dodge", "color burn": "color-burn", "linear dodge": "lighter", "hard light": "hard-light", "soft light": "soft-light", difference: "difference", exclusion: "exclusion", hue: "hue", saturation: "saturation", color: "color", luminosity: "luminosity" };

  // A text's lines as they show, for TextShapeR to learn from: a point text's own returns, a
  // paragraph's lines as its box sets them (Photoshop turns it into point text for this), once
  // its fonts are in, since they decide where its lines end
  const linesReady = (layers) => Fonts.ready(layers.flatMap(({ params }) => params.layerText.textStyleRange.map((range) => range.textStyle.fontPostScriptName)));
  const shownLines = (lt, resolution) => {
    if (!boxShape(lt)) return lt.textKey || "";
    return relativeLayout(lt, resolution).wrapped.map((runs) => runs.map((run) => run.text).join("").replace(/\s+$/, "")).join("\r");
  };

  // A layer is shown only if all its folders are, and takes their opacity
  const chainOf = (layer, byId) => {
    let opacity = 1;
    for (let id = layer.group; id; ) {
      const parent = byId.get(id);
      if (!parent) break;
      if (parent.visible === false) return { visible: false, opacity: 0 };
      opacity *= parent.opacity === undefined ? 1 : parent.opacity;
      id = parent.group;
    }
    return { visible: layer.visible !== false, opacity };
  };

  // Clipping masks: a layer marked `clipping` shows only where the layer under it in the same
  // folder shows (its base), as do the clipped layers between them. A folder can be a base,
  // and is then drawn as one picture; a folder itself is never clipped here. A clipped layer
  // with nothing under it in its folder is drawn as any other, as Photoshop would release it.
  const clipInfos = new WeakMap();
  const clippingOf = (layers) => {
    let info = clipInfos.get(layers);
    if (info) return info;
    info = { clipped: new Set(), bases: new Set(), baseOf: new Map() };
    for (let i = 1; i < layers.length; i++) {
      const layer = layers[i];
      const below = layers[i - 1];
      if (!layer.clipping || layer.kind === "group" || (below.group || null) !== (layer.group || null)) continue;
      const base = info.clipped.has(below.id) ? info.baseOf.get(below.id) : below;
      info.clipped.add(layer.id);
      info.baseOf.set(layer.id, base);
      if (base.kind === "group") info.bases.add(base.id);
    }
    clipInfos.set(layers, info);
    return info;
  };

  // A folder with a layer style of its own, as an SFX gets: its stroke goes around everything
  // inside it at once, so letters that overlap make one shape. Such a folder is drawn as one
  // picture, its layers first, then its stroke, its Fill at 0% and its masks. So is a folder
  // that is a clipping base.
  const groupStroke = (layer) => (layer.stroke && layer.stroke.enabled && layer.stroke.size > 0 ? layer.stroke : null);
  // A folder in a blend mode of its own is drawn as one picture too, then blended as a whole
  // (Lighten on a folder of letters). In Normal, so is one whose adjustment layers apply to
  // what it holds alone (`isolated`, from the file).
  const ownBlend = (layer) => Boolean(layer.blend) && layer.blend !== "pass through" && (layer.blend !== "normal" || Boolean(layer.isolated));
  const isStyledGroup = (layer, layers) => layer.kind === "group" && Boolean(groupStroke(layer) || effectsOn(layer) || fillOf(layer) < 1 || maskOn(layer) || vectorOn(layer) || ownBlend(layer) || (layers && clippingOf(layers).bases.has(layer.id)));
  // Photoshop's Invert adjustment layer: the colours of what is under it turned over, through
  // its masks, at its opacity. Its other adjustments aren't drawn.
  const invertOf = (layer) => Boolean(layer && layer.adjustment && layer.raw && layer.raw.adjustment && layer.raw.adjustment.type === "invert");
  // On `ctx`, whose pixel (ox + x, oy + y) is the page's (x, y), over the page's rectangle
  const invertOn = (ctx, ox, oy, left, top, width, height, layer, doc, alpha) => {
    left = Math.floor(left);
    top = Math.floor(top);
    width = Math.ceil(width);
    height = Math.ceil(height);
    if (width <= 0 || height <= 0 || alpha <= 0) return;
    const data = ctx.getImageData(ox + left, oy + top, width, height);
    const d = data.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = 255 - d[i];
      d[i + 1] = 255 - d[i + 1];
      d[i + 2] = 255 - d[i + 2];
    }
    const turned = newCanvas(width, height);
    const t = turned.getContext("2d");
    t.putImageData(data, 0, 0);
    if (maskOn(layer)) cutWith(t, width, height, left, top, maskPicture(layer, doc));
    if (vectorOn(layer)) cutWith(t, width, height, left, top, vectorPicture(layer));
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = "source-atop";
    ctx.drawImage(turned, ox + left, oy + top);
    ctx.restore();
  };
  // The outermost styled folder a layer is in, if any
  const styledParentOf = (layer, byId, layers) => {
    let found = null;
    for (let id = layer.group; id; ) {
      const parent = byId.get(id);
      if (!parent) break;
      if (isStyledGroup(parent, layers)) found = parent;
      id = parent.group;
    }
    return found;
  };
  // The nearest one: a styled folder in a styled folder is drawn as one picture in it
  const nearestStyledOf = (layer, byId, layers) => {
    for (let id = layer.group; id; ) {
      const parent = byId.get(id);
      if (!parent) break;
      if (isStyledGroup(parent, layers)) return parent;
      id = parent.group;
    }
    return null;
  };
  // A shape grown by `size` pixels all round, onto `c`
  const spread = (c, source, pad, size) => {
    const steps = Math.min(48, Math.max(12, Math.round(size * 4)));
    // The inner circle fills what a small dot would leave open inside the outer one
    for (const r of size > 3 ? [size, size / 2] : [size]) {
      for (let i = 0; i < steps; i++) {
        const angle = (i / steps) * Math.PI * 2;
        c.drawImage(source, pad + Math.cos(angle) * r, pad + Math.sin(angle) * r);
      }
    }
  };
  // The box of what shows in a picture (alpha above 0), or null when nothing does
  const alphaBounds = (canvas) => {
    if (!canvas || !canvas.width || !canvas.height) return null;
    let data;
    try {
      data = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
    } catch (error) {
      return null;
    }
    const w = canvas.width;
    let left = w;
    let top = canvas.height;
    let right = -1;
    let bottom = -1;
    for (let y = 0, i = 3; y < canvas.height; y++) {
      for (let x = 0; x < w; x++, i += 4) {
        if (!data[i]) continue;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        bottom = y;
      }
    }
    return right < 0 ? null : { left, top, right: right + 1, bottom: bottom + 1 };
  };
  // What a stroke is painted with: its colour, or with Fill Type Gradient its gradient, which
  // spans the stroke's own bounds as Photoshop's Align with Layer does: the letters' bounds
  // grown by the stroke's part outside them (measured in Photoshop 2026)
  const strokePaint = (stroke) => (stroke && stroke.fill === "gradient" && stroke.gradient ? { gradient: stroke.gradient, grow: strokeOutside(stroke) } : stroke.color);
  const strokeIsGradient = (stroke) => Boolean(stroke && stroke.fill === "gradient" && stroke.gradient);
  // What is drawn in `c` painted with `paint` (a colour, or a stroke's gradient across `shape`,
  // laid at `pad`, grown by the stroke's part outside it); `scale`: the canvas's pixels per
  // pixel of the page
  const paintIn = (c, paint, shape, pad = 0, scale = 1) => {
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = "source-in";
    if (paint && paint.gradient) {
      const b = alphaBounds(shape);
      const grow = (paint.grow || 0) * scale;
      if (b) c.drawImage(fxRampPicture(c.canvas.width, c.canvas.height, Object.assign({}, paint.gradient, { opacity: 100 }), { left: b.left + pad - grow, top: b.top + pad - grow, right: b.right + pad + grow, bottom: b.bottom + pad + grow }), 0, 0);
    } else {
      c.fillStyle = colorCss(paint);
      c.fillRect(0, 0, c.canvas.width, c.canvas.height);
    }
    c.restore();
  };
  // A ring laid on `into` whole, at `alpha`: a stroke's Opacity
  const layRing = (into, ring, alpha = 1) => {
    const g = into.getContext("2d");
    if (alpha >= 1) {
      g.drawImage(ring, 0, 0);
      return;
    }
    g.save();
    g.globalAlpha *= alpha;
    g.drawImage(ring, 0, 0);
    g.restore();
  };
  // Grows a shape by `size` pixels all round, in `color`: the same rings as a PSD's strokes
  const ringOf = (source, pad, size, color, into, alpha = 1) => {
    const ring = newCanvas(into.width, into.height);
    const c = ring.getContext("2d");
    spread(c, source, pad, size);
    paintIn(c, color, source, pad);
    layRing(into, ring, alpha);
  };
  // A stroke inside a shape, `size` pixels in from its edge, in `color`, over it: what is
  // around the shape, grown, then kept where the shape is. `source` is laid at `pad` in `into`.
  const innerRingOf = (source, pad, size, color, into, alpha = 1) => {
    const around = newCanvas(into.width, into.height);
    const a = around.getContext("2d");
    a.fillRect(0, 0, around.width, around.height);
    a.globalCompositeOperation = "destination-out";
    a.drawImage(source, pad, pad);
    const ring = newCanvas(into.width, into.height);
    const c = ring.getContext("2d");
    spread(c, around, 0, size);
    c.globalCompositeOperation = "destination-in";
    c.drawImage(source, pad, pad);
    paintIn(c, color, source, pad);
    layRing(into, ring, alpha);
  };
  // A base with its clipped layers on it, as one picture of the base's size. A clipped layer
  // in Normal mode lands on the base's pixels only; in another mode it blends, then what went
  // past the base is cut off.
  const withClipped = (base, clips) => {
    const canvas = newCanvas(base.canvas.width, base.canvas.height);
    const c = canvas.getContext("2d");
    c.drawImage(base.canvas, 0, 0);
    let shape = null;
    clips.forEach(({ visual, alpha, blend }) => {
      if (visual.under) drawUnder(c, visual, -base.x, -base.y, alpha, null, { canvas: base.canvas, x: 0, y: 0 });
      c.globalAlpha = alpha;
      if (blend === "source-over") {
        c.globalCompositeOperation = "source-atop";
        c.drawImage(visual.canvas, visual.x - base.x, visual.y - base.y);
        return;
      }
      if (!shape) {
        shape = newCanvas(canvas.width, canvas.height);
        shape.getContext("2d").drawImage(base.canvas, 0, 0);
      }
      c.globalCompositeOperation = blend;
      c.drawImage(visual.canvas, visual.x - base.x, visual.y - base.y);
      c.globalAlpha = 1;
      c.globalCompositeOperation = "destination-in";
      c.drawImage(shape, 0, 0);
    });
    return { canvas, x: base.x, y: base.y };
  };
  // A text opened from a PSD shows Photoshop's own pixels, its lines where Photoshop broke
  // them, and its caret and selection go on those lines (see photoshopLines). Where they
  // can't be read from the pixels, a text typed on the page shows as TypeR sets it instead:
  // its caret and selection are drawn on TypeR's lines.
  const typedTexts = new WeakMap();
  const asTyped = (layer, doc) => {
    const typed = app.typed;
    if (!typed || typed.doc !== doc || typed.id !== layer.id || !layer.raster || photoshopLines(layer, doc)) return layer;
    if (!typedTexts.has(layer)) typedTexts.set(layer, Object.assign({}, layer, { raster: null }));
    return typedTexts.get(layer);
  };
  // What the page shows in a layer's place
  const onPage = (layer, doc) => {
    if (doc.preview && doc.preview.id === layer.id) return doc.preview;
    // A font only tried out (ops.previewTextStyle): shown, never part of the page's state
    const tried = doc.stylePreview;
    return (tried && tried.state === doc.state && tried.layers.get(layer.id)) || asTyped(layer, doc);
  };
  const groupVisuals = new Map();
  // `still`: the folder moves as a whole, so its picture is the one it has at rest
  // `skip`: layers to leave out (the Magic Wand reads the page without its text)
  const groupVisual = (group, doc, still, skip) => {
    const layers = doc.orderPreview || doc.state.layers;
    const blendOf = (layer) => BLENDS[doc.blendPreview && doc.blendPreview.ids.has(layer.id) ? doc.blendPreview.blend : layer.blend] || "source-over";
    const byId = new Map(layers.map((layer) => [layer.id, layer]));
    const members = familyOf(layers, group.id);
    const clip = clippingOf(layers);
    const live = !still && doc.live ? doc.live : null;
    const parts = [];
    const partOf = new Map();
    // Its visibility inside the folder: the folder's own opacity is applied to the whole
    const inside = (layer) => {
      let visible = layer.visible !== false;
      let opacity = layer.opacity === undefined ? 1 : layer.opacity;
      for (let id = layer.group; id && id !== group.id; ) {
        const parent = byId.get(id);
        if (!parent) break;
        if (parent.visible === false) visible = false;
        opacity *= parent.opacity === undefined ? 1 : parent.opacity;
        id = parent.group;
      }
      return { visible, opacity };
    };
    // `bare`: without its stroke, shadow and glow, for what is clipped to it to land on its letters
    const shown = (layer, bare) => {
      const moving = live && live.ids.has(layer.id);
      const loose = moving && looseMasks(layer);
      const source = loose ? shifted(layer, Math.round(live.dx), Math.round(live.dy), doc) : onPage(layer, doc);
      const visual = pageVisualOf(bare ? withoutStroke(source) : source, doc);
      if (!visual || !visual.canvas || !visual.canvas.width) return null;
      const dx = moving && !loose ? Math.round(live.dx) : 0;
      const dy = moving && !loose ? Math.round(live.dy) : 0;
      const out = { canvas: visual.canvas, x: visual.x + dx, y: visual.y + dy, key: identity(visual.canvas) + "." + (visual.version || 0) };
      if (visual.under) out.under = visual.under.map((item) => Object.assign({}, item, { x: item.x + dx, y: item.y + dy }));
      return out;
    };
    layers.forEach((layer) => {
      if (layer.id === group.id || !members.has(layer.id)) return;
      const styled = nearestStyledOf(layer, byId, layers);
      if (layer.kind === "group") {
        if (styled === group && isStyledGroup(layer, layers) && chainOf(layer, byId).visible && inside(layer).visible) {
          const visual = groupVisual(layer, doc, still, skip);
          if (visual) {
            const part = { visual, alpha: layer.opacity === undefined ? 1 : layer.opacity, blend: blendOf(layer), key: "g" + layer.id + "." + identity(visual.canvas), clips: [] };
            parts.push(part);
            partOf.set(layer.id, part);
          }
        }
        return;
      }
      if (styled !== group || (skip && skip(layer))) return;
      const { visible, opacity } = inside(layer);
      if (!visible) return;
      if (invertOf(layer)) {
        if (!clip.clipped.has(layer.id)) parts.push({ invert: layer, alpha: opacity, key: "i" + layer.id + "." + masksKey(layer, doc), clips: [] });
        return;
      }
      const visual = shown(layer);
      if (!visual) return;
      const blend = blendOf(layer);
      if (clip.clipped.has(layer.id)) {
        const base = partOf.get(clip.baseOf.get(layer.id).id);
        if (base) base.clips.push({ visual, alpha: layer.opacity === undefined ? 1 : layer.opacity, blend });
        return;
      }
      const part = { visual, alpha: opacity, blend, key: visual.key, clips: [], layer };
      parts.push(part);
      partOf.set(layer.id, part);
    });
    // What only adjusts what is under it, at the bottom, adjusts nothing
    while (parts.length && parts[0].invert) parts.shift();
    if (!parts.length) return null;
    // A folder in Pass Through with a style (a stroke around its letters): its layers in a
    // blend mode of their own blend with the page, as in Photoshop, not with the folder alone.
    // They go over its picture, drawn after it (`over`); the stroke goes around them too.
    const passing = blendOf(group) === "source-over" && (group.blend || "pass through") === "pass through";
    const stroke = groupStroke(group);
    const effects = effectsOn(group);
    const groupNormal = blendOf(group) === "source-over";
    const key = parts.map((part) => (part.invert ? [part.key, part.alpha].join(",") : [part.key, part.visual.x, part.visual.y, part.alpha, part.blend, part.clips.map((item) => [item.visual.key, item.visual.x, item.visual.y, item.alpha, item.blend].join(":")).join("/")].join(","))).join(";") + "|" + (stroke ? strokeKeyOf(stroke) : "") + "|" + fillOf(group) + "|" + masksKey(group, doc) + "|" + (effects ? fxKeyOf(effects) + groupNormal : "");
    // Kept apart without its stroke, shadow and glow: a gradient clipped to an SFX asks for both
    const keptId = stroke || outerEffectsOn(group) ? group.id : `${group.id}:bare`;
    const kept = skip ? null : groupVisuals.get(keptId);
    if (kept && kept.key === key) return kept.visual;
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    parts.forEach(({ visual }) => {
      if (!visual) return;
      const area = visualRect(visual);
      left = Math.min(left, area.left);
      top = Math.min(top, area.top);
      right = Math.max(right, area.right);
      bottom = Math.max(bottom, area.bottom);
    });
    const pad = Math.ceil(strokeReach(stroke)) + 2;
    const fill = newCanvas(right - left + pad * 2, bottom - top + pad * 2);
    const f = fill.getContext("2d", { willReadFrequently: parts.some((part) => part.invert) });
    const over = [];
    let shape = null;
    parts.forEach(({ visual, alpha, blend, clips, layer, invert }) => {
      if (invert) {
        invertOn(f, pad - left, pad - top, left - pad, top - pad, fill.width, fill.height, invert, doc, alpha);
        return;
      }
      if (passing && blend !== "source-over") {
        over.push({ visual: clips.length ? withClipped(visual, clips) : visual, alpha, blend });
        return;
      }
      let drawn = visual;
      // As on the page: a text's stroke, shadow and glow stay whole around its letters, and
      // what is clipped to it lands on the letters
      const ringed = layer && ((layer.kind === "text" && layer.stroke && layer.stroke.enabled && layer.stroke.size > 0) || outerEffectsOn(layer));
      const bare = clips.length && ringed ? shown(layer, true) : null;
      if (bare) {
        const glued = withClipped(bare, clips);
        const x = Math.min(visual.x, glued.x);
        const y = Math.min(visual.y, glued.y);
        const canvas = newCanvas(Math.max(visual.x + visual.canvas.width, glued.x + glued.canvas.width) - x, Math.max(visual.y + visual.canvas.height, glued.y + glued.canvas.height) - y);
        const g = canvas.getContext("2d");
        g.drawImage(visual.canvas, visual.x - x, visual.y - y);
        g.drawImage(glued.canvas, glued.x - x, glued.y - y);
        drawn = { canvas, x, y };
      } else if (clips.length) drawn = withClipped(visual, clips);
      if (visual.under) drawUnder(f, visual, pad - left, pad - top, alpha);
      f.globalAlpha = alpha;
      f.globalCompositeOperation = blend;
      f.drawImage(drawn.canvas, drawn.x - left + pad, drawn.y - top + pad);
      // What a folder in it passes over the page lands on this folder's own, or goes on
      // over the page if this one passes too
      (visual.over || NONE).forEach((item) => {
        if (passing) {
          over.push({ visual: item, alpha: alpha * item.alpha, blend: item.blend });
          return;
        }
        f.globalAlpha = alpha * item.alpha;
        f.globalCompositeOperation = item.blend;
        f.drawImage(item.canvas, item.x - left + pad, item.y - top + pad);
      });
    });
    f.globalAlpha = 1;
    f.globalCompositeOperation = "source-over";
    // The stroke goes around what passes over the page as well
    if (over.length && stroke) {
      shape = newCanvas(fill.width, fill.height);
      const g = shape.getContext("2d");
      g.drawImage(fill, 0, 0);
      over.forEach(({ visual }) => g.drawImage(visual.canvas, visual.x - left + pad, visual.y - top + pad));
    }
    let out = fill;
    const amount = fillOf(group);
    if (stroke || amount < 1) {
      out = newCanvas(fill.width, fill.height);
      const o = out.getContext("2d");
      if (stroke) {
        if (stroke.outer && stroke.outer.size > 0) ringOf(shape || fill, 0, strokeReach(stroke), stroke.outer.color, out, strokeAlpha(stroke.outer));
        if (strokeOutside(stroke) > 0) ringOf(shape || fill, 0, strokeOutside(stroke), strokePaint(stroke), out, strokeAlpha(stroke));
        // Only outside all of it: what passes over the page doesn't cover the inside
        if (shape) {
          o.globalCompositeOperation = "destination-out";
          o.drawImage(shape, 0, 0);
          o.globalCompositeOperation = "source-over";
        }
      }
      // Fill: what the folder holds at that much over its stroke, which stays whole
      if (amount < 1 && stroke) {
        o.globalCompositeOperation = "destination-out";
        o.drawImage(fill, 0, 0);
        o.globalCompositeOperation = "source-over";
      }
      if (amount > 0) {
        o.globalAlpha = amount;
        o.drawImage(fill, 0, 0);
        o.globalAlpha = 1;
      }
      // Its part inside, over what the folder holds
      if (stroke && stroke.size > strokeOutside(stroke)) innerRingOf(fill, 0, stroke.size - strokeOutside(stroke), strokePaint(stroke), out, strokeAlpha(stroke));
    }
    // Its layer style from the file, as Photoshop draws a folder's: on all it holds at once,
    // a Gradient Overlay across the whole SFX, its letters hollow or not
    let x = left - pad;
    let y = top - pad;
    let under = null;
    if (effects) {
      const built = buildEffects(effects, fill, out, 0, 0, amount, groupNormal);
      if (built) {
        out = built.canvas;
        x += built.dx;
        y += built.dy;
        if (built.under) under = built.under.map((item) => ({ canvas: item.canvas, x: left - pad + item.dx, y: top - pad + item.dy, blend: item.blend }));
      }
    }
    const o = out.getContext("2d");
    if (maskOn(group)) cutWith(o, out.width, out.height, x, y, maskPicture(group, doc));
    if (vectorOn(group)) cutWith(o, out.width, out.height, x, y, vectorPicture(group));
    const visual = { canvas: out, x, y };
    if (under) visual.under = under;
    if (over.length) {
      visual.over = over.map((item) => ({ canvas: item.visual.canvas, x: item.visual.x, y: item.visual.y, alpha: item.alpha, blend: item.blend }));
      // Through the folder's own masks too
      if (maskOn(group) || vectorOn(group)) visual.over = visual.over.map((item) => {
        const canvas = newCanvas(item.canvas.width, item.canvas.height);
        const c = canvas.getContext("2d");
        c.drawImage(item.canvas, 0, 0);
        if (maskOn(group)) cutWith(c, canvas.width, canvas.height, item.x, item.y, maskPicture(group, doc));
        if (vectorOn(group)) cutWith(c, canvas.width, canvas.height, item.x, item.y, vectorPicture(group));
        return Object.assign({}, item, { canvas });
      });
    }
    if (skip) return visual;
    if (groupVisuals.size > 200) {
      groupVisuals.forEach((entry) => releaseVisual(entry.visual));
      groupVisuals.clear();
    }
    groupVisuals.set(keptId, { key, visual, docId: doc.id });
    return visual;
  };

  // On screen only: a mask shown alone in grey (Alt + click on it), or in red over the page
  // (\), and the Quick Mask in red where the selection isn't
  const MASK_RED = "rgb(255,0,0)";
  const drawMaskViews = (doc, ctx, rect) => {
    const area = rect ? { left: Math.max(0, Math.floor(rect.left)), top: Math.max(0, Math.floor(rect.top)), right: Math.min(doc.width, Math.ceil(rect.right)), bottom: Math.min(doc.height, Math.ceil(rect.bottom)) } : { left: 0, top: 0, right: doc.width, bottom: doc.height };
    const width = area.right - area.left;
    const height = area.bottom - area.top;
    if (width <= 0 || height <= 0) return;
    const red = (picture) => {
      const alpha = maskOverPage(picture, area.left, area.top, width, height);
      const tint = newCanvas(width, height);
      const t = tint.getContext("2d");
      t.fillStyle = MASK_RED;
      t.fillRect(0, 0, width, height);
      t.globalCompositeOperation = "destination-out";
      t.drawImage(alpha, 0, 0);
      ctx.globalAlpha = 0.5;
      ctx.globalCompositeOperation = "source-over";
      ctx.drawImage(tint, area.left, area.top);
      ctx.globalAlpha = 1;
    };
    // Shown while its mask stays the one the brushes work on
    const target = ops.maskTarget(doc);
    const view = doc.maskView && target && target.id === doc.maskView.id && target.part === doc.maskView.part ? doc.maskView : null;
    const layer = view && target.layer;
    if (layer && (view.part === "vector" ? layer.vectorMask : layer.mask)) {
      const picture = view.part === "vector" ? vectorPicture(Object.assign({}, layer, { vectorMask: Object.assign({}, layer.vectorMask, { disable: false }) })) : maskPicture(layer, doc, true);
      if (view.mode === "alone") {
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
        ctx.drawImage(maskAsGray(maskOverPage(picture, area.left, area.top, width, height)), area.left, area.top);
      } else red(picture);
    }
    const quick = maskHolder(doc, "quick");
    if (quick) red(maskPicture(quick, doc, true));
  };

  // On screen only: a layer that isn't one yet, such as the Bubble Reshaper's bubble being
  // shaped. It goes in place of the layer it `replaces`, or under the layer `before`.
  const withExtra = (doc) => {
    const { layer, before, replaces } = doc.extra;
    const list = doc.state.layers.slice();
    let at = replaces ? list.findIndex((item) => item.id === replaces) : -1;
    if (at >= 0) list.splice(at, 1);
    else at = before ? list.findIndex((item) => item.id === before) : -1;
    list.splice(at < 0 ? list.length : at, 0, layer);
    return list;
  };

  let scratch = null;
  let scratchShape = null;
  let scratchRing = null;
  // Where a layer's picture last went: during a stroke, the layers away from it cost nothing
  const visualBoxes = new WeakMap();
  // `rect` redoes only that part of a canvas that already shows this document: what a drag
  // changes on a page 10000 pixels tall is small, and the rest of the page costs nothing.
  // `screen`: the canvas the user sees, with the mask views on it.
  // A base without its stroke, for what is clipped to it to go on its letters alone. A text
  // opened from a PSD shows Photoshop's own pixels, the stroke drawn around them: its letters
  // alone are those pixels. Where an older TypeR drew the stroke into them, TypeR draws the
  // letters again.
  // Its shadow and glow go too: what is clipped lands on the letters and their inner effects.
  const withoutStroke = (layer) => {
    const raster = layer.kind === "text" ? layer.raster : null;
    const effects = insideEffects(layer.effects);
    if (!raster) return Object.assign({}, layer, { stroke: null, effects });
    if (raster.strokeDrawnIn) return Object.assign({}, layer, { stroke: null, effects, raster: null });
    return Object.assign({}, layer, { stroke: null, effects, raster: { bitmap: raster.bitmap, left: raster.left, top: raster.top } });
  };
  // The screen may show a text as it was quickly drawn while typed (see drawTextFrom):
  // anything else gets it as it should be
  const paintDoc = (doc, ctx, options = {}) => {
    if (!options.screen) {
      settleTexts();
      paintPage(doc, ctx, options);
      return;
    }
    roughShown++;
    try {
      paintPage(doc, ctx, options);
    } finally {
      roughShown--;
    }
  };
  const paintPage = (doc, ctx, options) => {
    // On screen, layers being dragged in the panel show where they would land
    const layers = options.screen && doc.orderPreview ? doc.orderPreview : options.screen && doc.extra ? withExtra(doc) : doc.state.layers;
    const blendOf = (layer) => BLENDS[doc.blendPreview && doc.blendPreview.ids.has(layer.id) ? doc.blendPreview.blend : layer.blend] || "source-over";
    const byId = new Map(layers.map((layer) => [layer.id, layer]));
    const live = doc.live;
    const rect = options.rect || null;
    const clip = clippingOf(layers);
    // `extra.underTo`: where the shadow and glow go instead, at `extra.underAlpha` (a clipping
    // base's, against the page). `extra.clip`: the base's shape, for a clipped layer's.
    const place = (layer, target, alpha, blend, extra) => {
      // A layer whose mask isn't linked moves under its mask, which stays
      const moving = live && live.ids.has(layer.id);
      const loose = moving && looseMasks(layer);
      const shown = loose ? shifted(layer, Math.round(live.dx), Math.round(live.dy), doc) : onPage(layer, doc);
      const still = rect && shown === layer && !moving && !(doc.liveTransform && doc.liveTransform.ids.has(layer.id));
      if (still) {
        const known = visualBoxes.get(layer);
        if (known && (known.x >= rect.right || known.y >= rect.bottom || known.x + known.width <= rect.left || known.y + known.height <= rect.top)) return;
      }
      const visual = pageVisualOf(shown, doc);
      if (!visual || !visual.canvas || !visual.canvas.width) return;
      // A text's shadow and glow reach past its letters
      const area = visual.under ? visualRect(visual) : null;
      if (shown === layer) visualBoxes.set(layer, area ? { x: area.left, y: area.top, width: area.right - area.left, height: area.bottom - area.top } : { x: visual.x, y: visual.y, width: visual.canvas.width, height: visual.canvas.height });
      let { x, y } = visual;
      if (moving && !loose) {
        x += Math.round(live.dx);
        y += Math.round(live.dy);
      }
      const turning = doc.liveTransform && doc.liveTransform.ids.has(layer.id) ? doc.liveTransform.matrix : null;
      if (area) {
        const ox = x - visual.x;
        const oy = y - visual.y;
        if (rect && !turning && (area.left + ox >= rect.right || area.top + oy >= rect.bottom || area.right + ox <= rect.left || area.bottom + oy <= rect.top)) return;
        if (extra && extra.underTo) drawUnder(extra.underTo, visual, ox, oy, extra.underAlpha, turning);
        else drawUnder(target, visual, ox, oy, alpha, turning, extra && extra.clip ? { canvas: extra.clip(), x: 0, y: 0 } : null);
      } else if (rect && !turning && (x >= rect.right || y >= rect.bottom || x + visual.canvas.width <= rect.left || y + visual.canvas.height <= rect.top)) return;
      target.globalAlpha = alpha;
      target.globalCompositeOperation = blend;
      if (!turning) {
        // Its part in the rectangle alone, when the layer is laid as it is: faded or blended, a
        // part of a picture doesn't round as the whole picture does, and the page would differ
        // by a level from the same page drawn whole. Except during a stroke, whose every frame
        // would send a whole canvas being painted to the graphics card: the end of the stroke
        // draws where it passed again.
        if (rect && (doc.liveStroke || (alpha === 1 && blend === "source-over")) && Number.isInteger(x) && Number.isInteger(y)) {
          const left = Math.max(x, rect.left);
          const top = Math.max(y, rect.top);
          const width = Math.min(x + visual.canvas.width, rect.right) - left;
          const height = Math.min(y + visual.canvas.height, rect.bottom) - top;
          if (width > 0 && height > 0) target.drawImage(visual.canvas, left - x, top - y, width, height, left, top, width, height);
        } else target.drawImage(visual.canvas, x, y);
        return;
      }
      target.save();
      target.transform(...turning);
      target.imageSmoothingQuality = "high";
      target.drawImage(visual.canvas, x, y);
      target.restore();
    };
    // A styled folder, drawn as one picture
    const placeGroup = (layer, target, alpha, blend, extra) => {
      // Moved whole, it keeps its picture: the stroke isn't drawn again at every step
      const family = Array.from(familyOf(layers, layer.id)).filter((id) => byId.get(id).kind !== "group");
      const whole = (set) => set && family.length && family.every((id) => set.has(id));
      const moving = whole(live && live.ids);
      const turning = whole(doc.liveTransform && doc.liveTransform.ids);
      const visual = groupVisual(layer, doc, moving, options.skip);
      if (!visual) return;
      const x = visual.x + (moving ? Math.round(live.dx) : 0);
      const y = visual.y + (moving ? Math.round(live.dy) : 0);
      // Its shadow and glow, in their own blend mode
      if (visual.under) {
        const matrix = turning ? doc.liveTransform.matrix : null;
        if (extra && extra.underTo) drawUnder(extra.underTo, visual, x - visual.x, y - visual.y, extra.underAlpha, matrix);
        else drawUnder(target, visual, x - visual.x, y - visual.y, alpha, matrix);
      }
      if (rect && !turning && (x >= rect.right || y >= rect.bottom || x + visual.canvas.width <= rect.left || y + visual.canvas.height <= rect.top)) return;
      target.globalAlpha = alpha;
      target.globalCompositeOperation = blend;
      if (turning) {
        target.save();
        target.transform(...doc.liveTransform.matrix);
        target.drawImage(visual.canvas, x, y);
        target.restore();
      } else target.drawImage(visual.canvas, x, y);
      // What it holds in a blend mode of its own, onto the page
      (visual.over || NONE).forEach((item) => {
        target.save();
        if (turning) target.transform(...doc.liveTransform.matrix);
        target.globalAlpha = alpha * item.alpha;
        target.globalCompositeOperation = item.blend;
        target.drawImage(item.canvas, item.x + x - visual.x, item.y + y - visual.y);
        target.restore();
      });
    };
    paintingScreen = Boolean(options.screen);
    if (options.screen) {
      if (looseOn(doc)) doc.looseShown = true;
      else if (!rect) doc.looseShown = false;
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, options.x || 0, options.y || 0);
    if (rect) {
      ctx.beginPath();
      ctx.rect(rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top);
      ctx.clip();
      if (!options.keep) ctx.clearRect(rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top);
    } else if (!options.keep) ctx.clearRect(0, 0, doc.width, doc.height);
    const anyStyled = layers.some((layer) => isStyledGroup(layer, layers));
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      const styledTop = anyStyled && layer.kind === "group" && isStyledGroup(layer, layers) && !styledParentOf(layer, byId, layers);
      if (!styledTop) {
        if (layer.kind === "group" || clip.clipped.has(layer.id)) continue;
        if (options.skip && options.skip(layer)) continue;
        if (anyStyled && styledParentOf(layer, byId, layers)) continue;
      }
      const chain = chainOf(layer, byId);
      if (!chain.visible) continue;
      const alpha = (layer.opacity === undefined ? 1 : layer.opacity) * chain.opacity;
      const blend = blendOf(layer);
      if (invertOf(layer)) {
        const area = rect || { left: 0, top: 0, right: doc.width, bottom: doc.height };
        invertOn(ctx, options.x || 0, options.y || 0, area.left, area.top, area.right - area.left, area.bottom - area.top, layer, doc, alpha);
        continue;
      }
      // A base with a stroke keeps it, as in Photoshop: what is clipped to it (a gradient on a
      // text or an SFX) goes on its letters, and the stroke stays around them in its colour. So
      // do a text's shadow and glow, under them.
      const ringed = layer.kind === "text" ? Boolean(layer.stroke && layer.stroke.enabled && layer.stroke.size > 0) || outerEffectsOn(layer) : layer.kind === "raster" ? Boolean(rasterStrokeOf(layer)) || outerEffectsOn(layer) : styledTop && Boolean(groupStroke(layer) || outerEffectsOn(layer));
      const drawBase = (target, a, b, which = layer, extra) => (styledTop ? placeGroup(which, target, a, b, extra) : place(which, target, a, b, extra));
      const clipped = [];
      for (let j = i + 1; j < layers.length && clip.clipped.has(layers[j].id) && clip.baseOf.get(layers[j].id) === layer; j++) {
        if (!(options.skip && options.skip(layers[j])) && chainOf(layers[j], byId).visible) clipped.push(layers[j]);
      }
      if (!clipped.length) {
        drawBase(ctx, alpha, blend);
        continue;
      }
      if (rect && !styledTop) {
        const baseMoving = live && live.ids.has(layer.id);
        const baseTurning = doc.liveTransform && doc.liveTransform.ids.has(layer.id);
        if (!baseMoving && !baseTurning && onPage(layer, doc) === layer) {
          const known = visualBoxes.get(layer);
          if (known && (known.x >= rect.right || known.y >= rect.bottom || known.x + known.width <= rect.left || known.y + known.height <= rect.top)) continue;
        }
      }
      const rx = rect ? Math.max(0, Math.floor(rect.left)) : 0;
      const ry = rect ? Math.max(0, Math.floor(rect.top)) : 0;
      const rw = rect ? Math.min(doc.width, Math.ceil(rect.right)) - rx : doc.width;
      const rh = rect ? Math.min(doc.height, Math.ceil(rect.bottom)) - ry : doc.height;
      if (rw <= 0 || rh <= 0) continue;
      if (!scratch || scratch.width !== doc.width || scratch.height !== doc.height) {
        releaseCanvas(scratch);
        scratch = newCanvas(doc.width, doc.height);
      }
      const c = scratch.getContext("2d");
      c.globalAlpha = 1;
      c.globalCompositeOperation = "source-over";
      c.clearRect(rx, ry, rw, rh);
      drawBase(c, 1, "source-over", ringed ? withoutStroke(layer) : layer);
      let shaped = false;
      // The base's shape, taken once something needs it
      const baseShape = () => {
        if (!shaped) {
          if (!scratchShape || scratchShape.width !== doc.width || scratchShape.height !== doc.height) {
            releaseCanvas(scratchShape);
            scratchShape = newCanvas(doc.width, doc.height);
          }
          const s = scratchShape.getContext("2d");
          s.globalAlpha = 1;
          s.globalCompositeOperation = "source-over";
          s.clearRect(rx, ry, rw, rh);
          s.drawImage(scratch, rx, ry, rw, rh, rx, ry, rw, rh);
          shaped = true;
        }
        return scratchShape;
      };
      clipped.forEach((item) => {
        const itemAlpha = item.opacity === undefined ? 1 : item.opacity;
        const itemBlend = blendOf(item);
        // A clipped text's shadow and glow stay inside the base too, in their own blend mode
        if (itemBlend === "source-over") {
          place(item, c, itemAlpha, "source-atop", { clip: baseShape });
          return;
        }
        // Another mode blends over the base, then what went past its pixels is cut off
        baseShape();
        place(item, c, itemAlpha, itemBlend, { clip: baseShape });
        c.globalAlpha = 1;
        c.globalCompositeOperation = "destination-in";
        c.drawImage(scratchShape, rx, ry, rw, rh, rx, ry, rw, rh);
      });
      let composed = scratch;
      if (ringed) {
        // The base with its stroke, and its letters with what is clipped to them over it
        if (!scratchRing || scratchRing.width !== doc.width || scratchRing.height !== doc.height) {
          releaseCanvas(scratchRing);
          scratchRing = newCanvas(doc.width, doc.height);
        }
        const r = scratchRing.getContext("2d");
        r.globalAlpha = 1;
        r.globalCompositeOperation = "source-over";
        r.clearRect(rx, ry, rw, rh);
        // Its shadow and glow straight onto the page, in their own blend mode
        drawBase(r, 1, "source-over", layer, { underTo: ctx, underAlpha: alpha });
        r.globalAlpha = 1;
        r.globalCompositeOperation = "source-over";
        r.drawImage(scratch, rx, ry, rw, rh, rx, ry, rw, rh);
        composed = scratchRing;
      }
      ctx.globalAlpha = alpha;
      ctx.globalCompositeOperation = blend;
      ctx.drawImage(composed, rx, ry, rw, rh, rx, ry, rw, rh);
    }
    if (options.screen) {
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      drawMaskViews(doc, ctx, rect);
    }
    ctx.restore();
    paintingScreen = false;
  };

  /* ===================== a picture's resolution, in ppi ===================== */

  // What Photoshop finds in a PNG, a JPEG or a WebP: the size in points of a text depends on
  // it. Without it, 72 ppi, as in Photoshop.
  // A PNG says it in pixels per metre: 300 ppi comes back as 299.9994
  const sensiblePpi = (ppi) => {
    if (!Number.isFinite(ppi) || ppi < 1 || ppi > 10000) return null;
    return Math.abs(ppi - Math.round(ppi)) < 0.05 ? Math.round(ppi) : Math.round(ppi * 100) / 100;
  };
  const ppiOfTiff = (bytes) => {
    if (bytes.length < 8) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const little = bytes[0] === 0x49;
    if (!little && bytes[0] !== 0x4d) return null;
    const u16 = (at) => view.getUint16(at, little);
    const u32 = (at) => view.getUint32(at, little);
    const ifd = u32(4);
    if (ifd + 2 > bytes.length) return null;
    let x = null;
    let unit = 2;
    for (let i = 0, count = u16(ifd); i < count; i++) {
      const at = ifd + 2 + i * 12;
      if (at + 12 > bytes.length) break;
      const tag = u16(at);
      if (tag === 0x011a) {
        const value = u32(at + 8);
        if (value + 8 <= bytes.length && u32(value + 4)) x = u32(value) / u32(value + 4);
      } else if (tag === 0x0128) unit = u16(at + 8);
    }
    if (x === null || unit === 1) return null;
    return sensiblePpi(unit === 3 ? x * 2.54 : x);
  };
  const ppiOfXmp = (text) => {
    const field = (name) => {
      const found = text.match(new RegExp(`tiff:${name}\\s*=\\s*"([^"]+)"`)) || text.match(new RegExp(`<tiff:${name}>([^<]+)<`));
      return found ? found[1].trim() : null;
    };
    const x = field("XResolution");
    if (!x) return null;
    const [top, bottom = "1"] = x.split("/");
    const ppi = Number(top) / Number(bottom);
    return sensiblePpi(field("ResolutionUnit") === "3" ? ppi * 2.54 : ppi);
  };
  const latin1 = (bytes) => {
    let out = "";
    for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return out;
  };
  const ppiOfPng = (bytes) => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let exif = null;
    let xmp = null;
    for (let at = 8; at + 8 <= bytes.length; ) {
      const length = view.getUint32(at);
      const type = latin1(bytes.subarray(at + 4, at + 8));
      const data = bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + length));
      // Pixels per metre
      if (type === "pHYs" && data.length >= 9 && data[8] === 1) return sensiblePpi(new DataView(data.buffer, data.byteOffset, 9).getUint32(0) * 0.0254);
      if (type === "eXIf") exif = data;
      if (type === "iTXt" && latin1(data.subarray(0, 18)) === "XML:com.adobe.xmp\0") xmp = data;
      if (type === "IEND") break;
      at += 12 + length;
    }
    return (exif && ppiOfTiff(exif)) || (xmp && ppiOfXmp(latin1(xmp))) || null;
  };
  const ppiOfJpeg = (bytes) => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let photoshop = null;
    let exif = null;
    let xmp = null;
    let jfif = null;
    for (let at = 2; at + 4 <= bytes.length; ) {
      if (bytes[at] !== 0xff) break;
      const marker = bytes[at + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        at += 2;
        continue;
      }
      // The image data starts: everything worth reading came before
      if (marker === 0xda || marker === 0xd9) break;
      const length = view.getUint16(at + 2);
      const data = bytes.subarray(at + 4, Math.min(bytes.length, at + 2 + length));
      const head = latin1(data.subarray(0, 29));
      if (marker === 0xe0 && head.startsWith("JFIF\0") && data.length >= 12 && (data[7] === 1 || data[7] === 2)) {
        const density = (data[8] << 8) | data[9];
        jfif = sensiblePpi(data[7] === 2 ? density * 2.54 : density);
      } else if (marker === 0xe1 && head.startsWith("Exif\0")) exif = ppiOfTiff(data.subarray(6));
      else if (marker === 0xe1 && head.startsWith("http://ns.adobe.com/xap/1.0/\0")) xmp = ppiOfXmp(latin1(data));
      else if (marker === 0xed && head.startsWith("Photoshop 3.0\0")) {
        // The 8BIM resources, ResolutionInfo (1005) among them, in 16.16 fixed point
        const res = new DataView(data.buffer, data.byteOffset, data.byteLength);
        for (let i = 14; i + 12 <= data.length; ) {
          if (latin1(data.subarray(i, i + 4)) !== "8BIM") break;
          const id = res.getUint16(i + 4);
          const nameLength = data[i + 6];
          const start = i + 6 + ((nameLength + 2) & ~1);
          if (start + 4 > data.length) break;
          const size = res.getUint32(start);
          if (id === 0x03ed && size >= 8 && start + 12 <= data.length) photoshop = sensiblePpi(res.getUint32(start + 4) / 65536);
          i = start + 4 + size + (size & 1);
        }
      }
      at += 2 + length;
    }
    return photoshop || exif || xmp || jfif || null;
  };
  const ppiOfWebp = (bytes) => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let xmp = null;
    for (let at = 12; at + 8 <= bytes.length; ) {
      const type = latin1(bytes.subarray(at, at + 4));
      const length = view.getUint32(at + 4, true);
      const data = bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + length));
      if (type === "EXIF") {
        const ppi = ppiOfTiff(latin1(data.subarray(0, 6)) === "Exif\0\0" ? data.subarray(6) : data);
        if (ppi) return ppi;
      }
      if (type === "XMP ") xmp = ppiOfXmp(latin1(data));
      at += 8 + length + (length & 1);
    }
    return xmp;
  };
  const imageResolution = async (blob) => {
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return ppiOfPng(bytes);
      if (bytes[0] === 0xff && bytes[1] === 0xd8) return ppiOfJpeg(bytes);
      if (latin1(bytes.subarray(0, 4)) === "RIFF" && latin1(bytes.subarray(8, 12)) === "WEBP") return ppiOfWebp(bytes);
    } catch (error) {
      console.warn("Could not read the resolution", error);
    }
    return null;
  };

  // A PNG or a JPEG from canvas.toBlob, which says nothing of the resolution, made to say it
  const PNG_CRC = Int32Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const pngCrc = (bytes) => {
    let crc = -1;
    for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ PNG_CRC[(crc ^ bytes[i]) & 0xff];
    return (crc ^ -1) >>> 0;
  };
  const withResolution = async (blob, ppi) => {
    if (!blob || !(ppi > 0)) return blob;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes[0] === 0x89 && bytes[1] === 0x50) {
      const ppm = Math.round(ppi / 0.0254);
      const chunk = new Uint8Array(21);
      const view = new DataView(chunk.buffer);
      view.setUint32(0, 9);
      chunk.set([0x70, 0x48, 0x59, 0x73], 4);
      view.setUint32(8, ppm);
      view.setUint32(12, ppm);
      chunk[16] = 1;
      view.setUint32(17, pngCrc(chunk.subarray(4, 17)));
      // Right after the header, which is always 8 + 25 bytes
      const parts = [];
      let at = 33;
      parts.push(bytes.subarray(0, 33), chunk);
      const source = new DataView(bytes.buffer);
      while (at + 8 <= bytes.length) {
        const length = source.getUint32(at);
        const end = at + 12 + length;
        if (latin1(bytes.subarray(at + 4, at + 8)) !== "pHYs") parts.push(bytes.subarray(at, end));
        at = end;
      }
      return new Blob(parts, { type: blob.type });
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      const density = Math.min(65535, Math.round(ppi));
      if (bytes[2] === 0xff && bytes[3] === 0xe0 && latin1(bytes.subarray(6, 11)) === "JFIF\0") {
        const out = bytes.slice();
        out[13] = 1;
        out.set([density >> 8, density & 255, density >> 8, density & 255], 14);
        return new Blob([out], { type: blob.type });
      }
      const app0 = Uint8Array.from([0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 1, density >> 8, density & 255, density >> 8, density & 255, 0, 0]);
      return new Blob([bytes.subarray(0, 2), app0, bytes.subarray(2)], { type: blob.type });
    }
    return blob;
  };

  /* ============================ documents ============================ */

  let nextId = 100;
  const newId = () => nextId++;

  const newRaster = (name, fields) => Object.assign({ id: newId(), kind: "raster", name, visible: true, opacity: 1, blend: "normal", bitmap: null, left: 0, top: 0, dx: 0, dy: 0, paint: NONE, group: null }, fields);

  const createDoc = ({ name, path, width, height, resolution, layers, handle, psd, stamp, idml, surfaces, workPath }) => {
    const doc = {
      id: newId(),
      name,
      path,
      stamp: stamp || null,
      handle: handle || null,
      width,
      height,
      resolution: resolution || 72,
      psd: psd || null,
      // A page of an InDesign file: the file's package, shared by its pages (indesign.js)
      idml: idml || null,
      sampleCache: null,
      sampleKey: "",
      state: { layers: layers || [], selection: null, lastSelection: null, activeIds: [] },
      history: [],
      historyIndex: -1,
      savedId: null,
      view: { zoom: 1, x: 0, y: 0, fitted: true },
    };
    // The perspective zones its file kept
    if (surfaces && surfaces.length) doc.state.surfaces = surfaces.map((zone) => Object.assign({}, zone, { id: newId() }));
    // Its work path (see ops.setWorkPath)
    if (workPath && Array.isArray(workPath.paths) && workPath.paths.length) doc.state.workPath = { paths: workPath.paths };
    const top = doc.state.layers[doc.state.layers.length - 1];
    if (top) doc.state.activeIds = [top.id];
    pushHistory(doc, "Open");
    doc.savedId = doc.history[0].id;
    return doc;
  };

  const sizeOf = (doc) => ({ width: doc.width, height: doc.height, resolution: doc.resolution });

  const pushHistory = (doc, name, coalesce) => {
    doc.history.length = doc.historyIndex + 1;
    doc.history.push({ id: newId(), name, state: doc.state, size: sizeOf(doc), coalesce: coalesce || null, time: Date.now() });
    if (doc.history.length > MAX_HISTORY) doc.history.shift();
    doc.historyIndex = doc.history.length - 1;
    const before = doc.history[doc.historyIndex - 1];
    if (before && (before.state.layers !== doc.state.layers || before.state.selection !== doc.state.selection)) trimHistory(doc);
  };

  // Steps are cheap, as they share what didn't change, unless each brings pixels of its own: a
  // merge, a transform, a big selection. Past this budget the oldest steps go, as in Photoshop.
  const HISTORY_BUDGET = 256 * 1024 * 1024;
  const MIN_STEPS = 10;
  const pixelsOfLayer = (layer, found) => {
    [layer.bitmap, layer.raster && layer.raster.bitmap, layer.raster && layer.raster.display, layer.mask && layer.mask.canvas].forEach((canvas) => { if (canvas) found.add(canvas); });
    const collectOps = (list) => (list || NONE).forEach((op) => {
      if (op.clip && op.clip.canvas) found.add(op.clip.canvas);
      if (op.source && op.source.canvas) found.add(op.source.canvas);
      if (op.canvas) found.add(op.canvas);
      if (op.pieces) op.pieces.forEach((piece) => found.add(piece.canvas));
    });
    collectOps(layer.paint);
    if (layer.mask) collectOps(layer.mask.paint);
  };
  const pixelsOfState = (state, found, seen) => {
    state.layers.forEach((layer) => {
      if (seen.has(layer)) return;
      seen.add(layer);
      pixelsOfLayer(layer, found);
    });
    if (state.selection && state.selection.mask) {
      if (state.selection.mask.data) found.add(state.selection.mask.data);
      if (state.selection.mask.alpha) found.add(state.selection.mask.alpha);
    }
    if (state.lastSelection && state.lastSelection.mask) {
      if (state.lastSelection.mask.data) found.add(state.lastSelection.mask.data);
      if (state.lastSelection.mask.alpha) found.add(state.lastSelection.mask.alpha);
    }
  };
  const bytesOf = (item) => (ArrayBuffer.isView(item) ? item.byteLength : item.width * item.height * 4);
  const historyOnlyBytes = (doc) => {
    const now = new Set();
    pixelsOfState(doc.state, now, new Set());
    const held = new Set();
    const seen = new Set();
    doc.history.forEach((entry) => pixelsOfState(entry.state, held, seen));
    let bytes = 0;
    held.forEach((item) => { if (!now.has(item)) bytes += bytesOf(item); });
    return bytes;
  };
  const trimHistory = (doc) => {
    while (doc.history.length > MIN_STEPS && historyOnlyBytes(doc) > HISTORY_BUDGET) {
      doc.history.shift();
      doc.historyIndex--;
    }
  };

  const isDirty = (doc) => doc.history[doc.historyIndex].id !== doc.savedId;

  const fileStamp = (file) => `${file.size}:${file.lastModified}`;

  // The file on disk behind a file the panel picked (bridge.js): Save writes over it. Told
  // by name, size and date, since the panel's input may hand on a copy of the File
  const fileHandles = new Map();
  const handleKey = (file) => `${file.name}|${fileStamp(file)}`;

  // Browsers limit a canvas's size and don't say so: past it, it stays blank. iPhones and
  // iPads stop at about 16.7 million pixels. A pixel in its far corner tells.
  const fitting = new Map();
  const canvasFits = (width, height) => {
    const key = `${width}x${height}`;
    if (!fitting.has(key)) {
      const canvas = document.createElement("canvas");
      let fits = false;
      try {
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.width === width && canvas.height === height && canvas.getContext("2d", { willReadFrequently: true });
        if (ctx) {
          ctx.fillRect(width - 1, height - 1, 1, 1);
          fits = ctx.getImageData(width - 1, height - 1, 1, 1).data[3] === 255;
        }
      } catch (error) {
        fits = false;
      }
      canvas.width = 0;
      canvas.height = 0;
      fitting.set(key, fits);
    }
    return fitting.get(key);
  };
  const refuseIfTooLarge = (width, height) => {
    if (!canvasFits(width, height)) throw Object.assign(new Error(`The page is too large for this browser: ${width} x ${height}`), { tooLarge: { width, height } });
  };

  const identities = new WeakMap();
  let lastIdentity = 0;
  const identity = (object) => {
    if (!object) return 0;
    if (!identities.has(object)) identities.set(object, ++lastIdentity);
    return identities.get(object);
  };

  // What the Magic Wand reads: the pixel layers on white, never the text. `ownChoice`: the
  // tool asking has its own Sample All Layers (the Quick Selection Tool), `everyLayer` says it all.
  const sampleData = (doc, everyLayer, ownChoice) => {
    const onlyActive = !everyLayer && (ownChoice || !app.sampleAll) && activeRaster(doc);
    // Pixels are never drawn on again once made: the same objects are the same picture
    const key = doc.state.layers.filter((layer) => layer.kind !== "text").map((layer) => [layer.id, layer.visible, layer.opacity, layer.blend, layer.group, layer.clipping, layer.dx, layer.dy, layer.left, layer.top, identity(layer.bitmap), identity(layer.mask), identity(layer.vectorMask), identity((layer.paint || NONE)[(layer.paint || NONE).length - 1]), (layer.paint || NONE).length].join(",")).join(";") + "|" + (onlyActive ? onlyActive.id : "all");
    if (doc.sampleCache && doc.sampleKey === key) return doc.sampleCache;
    const canvas = newCanvas(doc.width, doc.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, doc.width, doc.height);
    paintDoc(doc, ctx, { keep: true, skip: (layer) => layer.kind === "text" || (onlyActive && layer.id !== onlyActive.id) });
    doc.sampleCache = ctx.getImageData(0, 0, doc.width, doc.height).data;
    doc.sampleKey = key;
    return doc.sampleCache;
  };

  const activeRaster = (doc) => {
    const id = doc.state.activeIds[doc.state.activeIds.length - 1];
    return doc.state.layers.find((layer) => layer.id === id && layer.kind === "raster") || null;
  };

  // The pixels a click takes, as the Magic Wand finds them: the ones `similar` to the clicked
  // one, joined to it, or anywhere on the page when not contiguous. A byte per pixel, and the box
  // they fill (right < 0 when none).
  const floodMarks = (w, h, sx, sy, similar, contiguous) => {
    const seen = new Uint8Array(w * h);
    let left = w;
    let right = -1;
    let top = h;
    let bottom = -1;
    if (!contiguous) {
      for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
          if (!similar(py * w + px)) continue;
          seen[py * w + px] = 1;
          if (px < left) left = px;
          if (px > right) right = px;
          if (py < top) top = py;
          if (py > bottom) bottom = py;
        }
      }
      return { seen, left, top, right, bottom };
    }
    const stack = [sx, sy];
    while (stack.length) {
      const py = stack.pop();
      let px = stack.pop();
      while (px >= 0 && !seen[py * w + px] && similar(py * w + px)) px--;
      px++;
      let up = false;
      let down = false;
      for (; px < w; px++) {
        const index = py * w + px;
        if (seen[index] || !similar(index)) break;
        seen[index] = 1;
        if (px < left) left = px;
        if (px > right) right = px;
        if (py < top) top = py;
        if (py > bottom) bottom = py;
        if (py > 0) {
          const above = index - w;
          if (!seen[above] && similar(above)) {
            if (!up) {
              stack.push(px, py - 1);
              up = true;
            }
          } else up = false;
        }
        if (py < h - 1) {
          const below = index + w;
          if (!seen[below] && similar(below)) {
            if (!down) {
              stack.push(px, py + 1);
              down = true;
            }
          } else down = false;
        }
      }
    }
    return { seen, left, top, right, bottom };
  };

  // Flood fill from a click, as the Magic Wand: within the tolerance of the
  // clicked pixel, on the page and the clean layer (never on the text layers,
  // so a bubble can be clicked again after it got its text)
  const floodSelect = (doc, x, y, tolerance) => {
    const data = sampleData(doc);
    const w = doc.width;
    const h = doc.height;
    const sx = Math.max(0, Math.min(w - 1, Math.round(x)));
    const sy = Math.max(0, Math.min(h - 1, Math.round(y)));
    const start = (sy * w + sx) * 4;
    const r0 = data[start];
    const g0 = data[start + 1];
    const b0 = data[start + 2];
    const similar = (p) => {
      const i = p * 4;
      return Math.abs(data[i] - r0) <= tolerance && Math.abs(data[i + 1] - g0) <= tolerance && Math.abs(data[i + 2] - b0) <= tolerance;
    };
    const { seen, left, top, right, bottom } = floodMarks(w, h, sx, sy, similar, app.contiguous !== false);
    const boxW = right - left + 1;
    const boxH = bottom - top + 1;
    const mask = new Uint8Array(boxW * boxH);
    for (let yy = 0; yy < boxH; yy++) {
      for (let xx = 0; xx < boxW; xx++) mask[yy * boxW + xx] = seen[(top + yy) * w + left + xx];
    }
    return makeSelection({ source: "wand", mask, boxW, boxH, left, top });
  };

  // A bubble, or what's around it? The page's margins and gutters run to its edges, and a panel's
  // background holds what's drawn on it: the bubbles, black or white inside, even those touching
  // the panel's border, and the faces. A bubble only holds its letters, small strokes around
  // small counters, and the white around it runs out of its box. Shares of the page.
  const BUBBLE_AT_EDGE = 0.08;
  const BUBBLE_MOST = 0.15;
  const BUBBLE_HOLE = 0.004;
  const BUBBLE_INNER_WHITE = 0.0015;
  const looksLikeBubble = (doc, selection) => {
    if (!selection.mask) return true;
    const { data: mask, width: w, height: h, left, top } = selection.mask;
    const page = doc.width * doc.height;
    let area = 0;
    for (let i = 0; i < mask.length; i++) area += mask[i];
    if (!area) return true;
    if (area > page * BUBBLE_MOST) return false;
    const atEdge = left <= 0 || top <= 0 || left + w >= doc.width || top + h >= doc.height;
    if (atEdge && area > page * BUBBLE_AT_EDGE) return false;
    const data = sampleData(doc);
    const white = new Uint8Array(w * h);
    for (let i = 0; i < white.length; i++) {
      if (mask[i]) continue;
      const p = ((top + Math.floor(i / w)) * doc.width + left + (i % w)) * 4;
      white[i] = data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114 >= 200 ? 1 : 0;
    }
    // Each patch of what isn't the region, inside its box: how big, and whether it reaches the
    // box's sides (so goes on outside it). `within` says which pixels make up a patch.
    const seen = new Uint8Array(w * h);
    const stack = [];
    const patch = (start, within) => {
      let size = 0;
      let open = false;
      seen[start] = 1;
      stack.push(start);
      while (stack.length) {
        const i = stack.pop();
        size++;
        const x = i % w;
        if (x === 0 || x === w - 1 || i < w || i >= w * (h - 1)) open = true;
        const next = (j) => {
          if (!seen[j] && within(j)) {
            seen[j] = 1;
            stack.push(j);
          }
        };
        if (x > 0) next(i - 1);
        if (x < w - 1) next(i + 1);
        if (i >= w) next(i - w);
        if (i < w * (h - 1)) next(i + w);
      }
      return { size, open };
    };
    // Holes, whatever their colour: a black bubble on a panel's background
    const outside = (i) => !mask[i];
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] || seen[i]) continue;
      const hole = patch(i, outside);
      if (!hole.open && hole.size > page * BUBBLE_HOLE) return false;
    }
    // White patches held inside the box: a bubble, or a face, on the background tapped
    seen.fill(0);
    const isWhite = (i) => white[i] === 1;
    for (let i = 0; i < mask.length; i++) {
      if (!white[i] || seen[i]) continue;
      const inner = patch(i, isWhite);
      if (!inner.open && inner.size > page * BUBBLE_INNER_WHITE) return false;
    }
    return true;
  };

  /* -------------------------------- Color Range ------------------------------- */

  // Select > Color Range, judged as Photoshop judges it (as photocraft measured it against its
  // masks): how much each pixel belongs, 0 to 255. What belongs half or more is selected, which
  // is also where Photoshop draws its marching ants.
  const LINEAR = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  const labF = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  // CIE Lab (D50), on Photoshop's 8-bit Lab grid: L in steps of 1/2.55, a and b whole
  const labOf = (r, g, b) => {
    const lr = LINEAR[r];
    const lg = LINEAR[g];
    const lb = LINEAR[b];
    const fx = labF((0.4360747 * lr + 0.3850649 * lg + 0.1430804 * lb) / 0.96422);
    const fy = labF(0.2225045 * lr + 0.7168786 * lg + 0.0606169 * lb);
    const fz = labF((0.0139322 * lr + 0.0971045 * lg + 0.7141733 * lb) / 0.82521);
    return [Math.round((116 * fy - 16) * 2.55) / 2.55, Math.round(500 * (fx - fy)), Math.round(200 * (fy - fz))];
  };
  const byte = (v) => Math.max(0, Math.min(255, Math.round(v)));

  // Sampled Colors: the Lab box the eyedropper's colours span. "Add to Sample" grows it;
  // "Subtract from Sample" reshapes it the way Photoshop does, an axis at a time: inside, the
  // nearer edge comes onto the colour; just outside, the edge steps in, by a fifth of the
  // fuzziness's width at a time. Further than Photoshop: the colour taken away is kept, and it
  // and the colours near it are left out, even when the box still spans them (red and blue
  // sampled, then blue taken away).
  const labRange = {
    point(rgb) {
      const lab = labOf(byte(rgb[0]), byte(rgb[1]), byte(rgb[2]));
      return { lo: lab.slice(), hi: lab.slice() };
    },
    add(range, rgb) {
      if (!range) return labRange.point(rgb);
      const lab = labOf(byte(rgb[0]), byte(rgb[1]), byte(rgb[2]));
      const minus = (range.minus || []).filter((m) => Math.max(Math.abs(m[0] - lab[0]) * 2.55, Math.abs(m[1] - lab[1]), Math.abs(m[2] - lab[2])) >= 1);
      return { lo: range.lo.map((v, k) => Math.min(v, lab[k])), hi: range.hi.map((v, k) => Math.max(v, lab[k])), minus };
    },
    subtract(range, rgb, fuzziness) {
      if (!range) return range;
      const lab = labOf(byte(rgb[0]), byte(rgb[1]), byte(rgb[2]));
      const fz = Math.max(0, Number(fuzziness) || 0);
      const lo = range.lo.slice();
      const hi = range.hi.slice();
      lab.forEach((m, k) => {
        if (m > lo[k] && m < hi[k]) {
          if (m - lo[k] < hi[k] - m) lo[k] = m;
          else hi[k] = m;
          return;
        }
        const q = (k === 0 ? fz / 2.55 : (fz * 256) / 255 / 3) / 5;
        if (q <= 0) return;
        const n = Math.floor((m <= lo[k] ? lo[k] - m : m - hi[k]) / q) + 1;
        if (n > 5) return;
        if (m <= lo[k]) lo[k] = Math.min(m + n * q, hi[k]);
        else hi[k] = Math.max(m - n * q, lo[k]);
      });
      return { lo, hi, minus: (range.minus || []).concat([lab]) };
    },
  };

  const RANGE_HUES = { reds: 0, yellows: 60, greens: 120, cyans: 180, blues: 240, magentas: 300 };
  const RANGE_TONES = { shadows: [0, 65], midtones: [105, 150], highlights: [190, 255] };
  // How much a colour belongs, 0 to 255, for the dialog's settings
  const rangeJudge = ({ mode, fuzziness, range }) => {
    const fuzz = Math.max(0, Number(fuzziness) || 0);
    if (mode === "sampled") {
      if (!range) return () => 0;
      const { lo, hi } = range;
      const outside = (v, l, h) => Math.max(l - v, v - h, 0);
      // a and b one step above the samples count half a unit more, one below half a unit less
      const ab = (v, l, h) => (v > h ? v - h + 0.5 : v < l ? Math.max(0, l - v - 0.5) : 0);
      const width = (fuzz * 256) / 255;
      // How much `lab` belongs to the box from `l` to `h`, 0 to 1
      const belongs = (lab, l, h) => {
        if (!(fuzz > 0)) return Math.max(outside(lab[0], l[0], h[0]) * 2.55, outside(lab[1], l[1], h[1]), outside(lab[2], l[2], h[2])) < 0.5 ? 1 : 0;
        // Hue counts three times as much as lightness; the farthest axis decides
        const t = Math.max(outside(lab[0], l[0], h[0]) * 2.55, 3 * ab(lab[1], l[1], h[1]), 3 * ab(lab[2], l[2], h[2])) / width;
        return t <= 0.5 ? 1 - 2 * t * t : t < 1 ? 2 * (1 - t) * (1 - t) : 0;
      };
      const minus = range.minus || [];
      return (r, g, b) => {
        const lab = labOf(r, g, b);
        let v = belongs(lab, lo, hi);
        for (let n = 0; v > 0 && n < minus.length; n++) v *= 1 - belongs(lab, minus[n], minus[n]);
        return Math.min(255, Math.floor(v * 256));
      };
    }
    if (mode in RANGE_HUES) {
      // Full at the family's hue, none 60° away, times the colour's strength: greys never,
      // dull colours partly. Dark colours weigh a little more, as in Photoshop.
      const center = RANGE_HUES[mode];
      return (r, g, b) => {
        const max = Math.max(r, g, b);
        const span = max - Math.min(r, g, b);
        if (!span) return 0;
        let h = max === r ? ((g - b) / span + 6) % 6 : max === g ? (b - r) / span + 2 : (r - g) / span + 4;
        h = Math.abs(h * 60 - center) % 360;
        h = Math.min(h, 360 - h);
        return byte(Math.max(0, 1 - h / 60) * (span / 255) * (2 - max / 255) * 255);
      };
    }
    if (mode in RANGE_TONES) {
      const [lo, hi] = RANGE_TONES[mode];
      const ramp = Math.max(1e-3, fuzz);
      return (r, g, b) => {
        const l = 0.299 * r + 0.587 * g + 0.114 * b;
        return byte((1 - Math.max(lo - l, l - hi, 0) / ramp) * 255);
      };
    }
    if (mode === "skin") {
      // Skin of every complexion lies in an ellipse of the YCbCr chroma plane (Chai & Ngan),
      // from pale to deep; fuzziness 100 fades out over one radius. Near-black and near-white,
      // whose colour is only noise, are left out.
      const angle = (-40 * Math.PI) / 180;
      const sin = Math.sin(angle);
      const cos = Math.cos(angle);
      const ramp = Math.max(1e-3, fuzz / 100);
      return (r, g, b) => {
        const y = 0.299 * r + 0.587 * g + 0.114 * b;
        const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b - 104;
        const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b - 158;
        const d = Math.hypot((cos * cb + sin * cr) / 22, (cos * cr - sin * cb) / 14);
        const chroma = Math.max(0, Math.min(1, 1 - (d - 1) / ramp));
        return byte(chroma * Math.max(0, Math.min(1, (y - 25) / 30)) * Math.max(0, Math.min(1, (250 - y) / 20)) * 255);
      };
    }
    return () => 0;
  };

  // Each pixel's share, 0 to 255, of `data` (RGBA, `w` × `h`), `scale` times the page's size.
  // `localized`: only near where the colours were picked (Localized Color Clusters), fading
  // out at that many page pixels from the nearest.
  // A page has few colours of its own: each is judged once, in a memo over every colour kept
  // from one call to the next (32 MB, allocated once). Only the colours met are wiped after,
  // or the whole when there were too many to list.
  let rangeMemo = null;
  // Kept between the previews of one dialog (32 MB), let go once it's been quiet a while
  let rangeMemoTimer = 0;
  const rangeCoverage = (data, w, h, settings, scale = 1) => {
    const judge = rangeJudge(settings);
    const memo = w * h > 1 << 18 ? rangeMemo || (rangeMemo = new Uint16Array(1 << 24)) : null;
    if (memo) {
      clearTimeout(rangeMemoTimer);
      rangeMemoTimer = setTimeout(() => { rangeMemo = null; }, 20000);
    }
    const touched = memo ? new Uint32Array(1 << 16) : null;
    let met = 0;
    const out = new Uint8Array(w * h);
    const points = settings.mode === "sampled" && settings.localized > 0 ? (settings.points || []).map(([x, y]) => [x * scale, y * scale]) : [];
    const radius = Math.max(1, (settings.localized || 0) * scale);
    try {
      for (let y = 0, p = 0; y < h; y++) {
        for (let x = 0; x < w; x++, p++) {
          const i = p * 4;
          if (!data[i + 3]) continue;
          let k;
          if (memo) {
            const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
            k = memo[key];
            if (k) k -= 1;
            else {
              k = judge(data[i], data[i + 1], data[i + 2]);
              memo[key] = k + 1;
              if (met < touched.length) touched[met] = key;
              met++;
            }
          } else k = judge(data[i], data[i + 1], data[i + 2]);
          if (k && points.length) {
            let near = 0;
            for (let n = 0; n < points.length; n++) near = Math.max(near, 1 - Math.hypot(x - points[n][0], y - points[n][1]) / radius);
            k = Math.round(k * Math.max(0, near));
          }
          out[p] = settings.invert ? 255 - k : k;
        }
      }
    } catch (error) {
      // Judged halfway: the memo can't be trusted any more
      rangeMemo = null;
      throw error;
    }
    if (met > (touched ? touched.length : 0)) memo.fill(0);
    else for (let n = 0; n < met; n++) memo[touched[n]] = 0;
    return out;
  };

  /* ------------------------------ double bubbles ----------------------------- */

  // A double (or chained) bubble, one selected text per lobe, as TypeR's panel does it in
  // Photoshop. The wand looks for bubbles on the page and the clean layer, whatever the Magic
  // Wand's own settings.
  const BUBBLE_TOLERANCE = 20;
  const MIN_BUBBLE_AREA = 200;
  const bubbleAt = (doc, x, y) => {
    const data = sampleData(doc, true);
    const w = doc.width;
    const h = doc.height;
    const sx = Math.max(0, Math.min(w - 1, Math.round(x)));
    const sy = Math.max(0, Math.min(h - 1, Math.round(y)));
    const start = (sy * w + sx) * 4;
    const [r0, g0, b0] = [data[start], data[start + 1], data[start + 2]];
    const similar = (p) => {
      const i = p * 4;
      return Math.abs(data[i] - r0) <= BUBBLE_TOLERANCE && Math.abs(data[i + 1] - g0) <= BUBBLE_TOLERANCE && Math.abs(data[i + 2] - b0) <= BUBBLE_TOLERANCE;
    };
    const { seen, left, top, right, bottom } = floodMarks(w, h, sx, sy, similar, true);
    if (right < 0) return null;
    return { seen, w, bounds: rectFrom(left, top, right + 1, bottom + 1) };
  };
  const holds = (rect, x, y) => x >= rect.left - 1 && x <= rect.right + 1 && y >= rect.top - 1 && y <= rect.bottom + 1;
  // A bubble is neither a speck nor most of the page
  const usableBubble = (rect, doc) => Boolean(rect) && rect.width * rect.height >= MIN_BUBBLE_AREA && rect.width * rect.height <= doc.width * doc.height * 0.45;
  // The bubble around a text: the wand from its centre, then from just around it when the
  // centre falls on a letter of the page. `best` reaches no other text, `loose` may.
  const probeBubble = (doc, box, sizePixels, others) => {
    const margin = Math.max(4, Math.round((Number.isFinite(sizePixels) ? sizePixels : 20) * 0.6));
    const points = [[box.xMid, box.yMid], [box.xMid, box.top - margin], [box.xMid, box.bottom + margin], [box.left - margin, box.yMid], [box.right + margin, box.yMid]];
    const found = { best: null, loose: null };
    const smaller = (current, next) => (!current || next.bounds.width * next.bounds.height < current.bounds.width * current.bounds.height ? next : current);
    points.forEach(([x, y]) => {
      if (found.best && found.best.whole) return;
      const region = bubbleAt(doc, x, y);
      if (!region || !usableBubble(region.bounds, doc) || !holds(region.bounds, box.xMid, box.yMid)) return;
      // Most of the text sits inside it, not beside it
      const b = region.bounds;
      if (Math.min(b.right, box.right) - Math.max(b.left, box.left) < box.width * 0.5 || Math.min(b.bottom, box.bottom) - Math.max(b.top, box.top) < box.height * 0.5) return;
      region.whole = x === box.xMid && y === box.yMid;
      found.loose = smaller(found.loose, region);
      if (!others.some((other) => holds(region.bounds, other.xMid, other.yMid))) found.best = smaller(found.best, region);
    });
    return found;
  };
  // A region bubbleAt found, as a selection: its mask and its outline, traced as the Magic Wand's
  const regionSelection = (region) => {
    const { seen, w, bounds } = region;
    const boxW = bounds.right - bounds.left;
    const boxH = bounds.bottom - bounds.top;
    const mask = new Uint8Array(boxW * boxH);
    for (let y = 0; y < boxH; y++) {
      for (let x = 0; x < boxW; x++) mask[y * boxW + x] = seen[(bounds.top + y) * w + bounds.left + x];
    }
    return makeSelection({ source: "wand", mask, boxW, boxH, left: bounds.left, top: bounds.top });
  };
  // Where Align centres a text in a single bubble, as TypeR's Legacy host finds it
  // (_getAdaptiveOpenedSelectionBounds, and openedBounds in the smart paste's engine, which aims
  // there): the selection, the boxes in `holes` filled in, contracted then expanded by 10% of its
  // short side (4 px at least, half of it less a pixel at most), which cuts a tail off. A radius
  // that leaves less than 200 px² is halved. The bounds of what stays, or the selection's own.
  const OPEN_RATIO = 0.1;
  const MIN_OPEN_RADIUS = 4;
  const openedSelectionBounds = (selection, holes) => {
    const b = selection.bounds;
    const shortest = Math.min(b.width, b.height);
    const most = Math.floor(shortest / 2 - 1);
    let radius = most > 0 ? Math.min(most, Math.max(MIN_OPEN_RADIUS, Math.round(shortest * OPEN_RATIO))) : 0;
    const m = selection.mask;
    if (!radius || !m) return b;
    const data = holes && holes.length ? Uint8Array.from(m.data) : m.data;
    // A box fills the pixels whose centre it holds, inside the selection's bounds
    (holes || []).forEach((hole) => {
      const x0 = Math.max(0, Math.ceil(hole.left - m.left - 0.5));
      const x1 = Math.min(m.width - 1, Math.floor(hole.right - m.left - 0.5));
      const y0 = Math.max(0, Math.ceil(hole.top - m.top - 0.5));
      const y1 = Math.min(m.height - 1, Math.floor(hole.bottom - m.top - 0.5));
      for (let y = y0; y <= y1; y++) data.fill(1, y * m.width + x0, y * m.width + x1 + 1);
    });
    // The selected runs of each row, in page pixels
    const rows = [];
    for (let y = 0; y < m.height; y++) {
      const runs = [];
      for (let x = 0, i = y * m.width; x < m.width; x++, i++) {
        if (!data[i]) continue;
        const from = x;
        while (x + 1 < m.width && data[i + 1]) { x++; i++; }
        runs.push([m.left + from, m.left + x]);
      }
      rows.push(runs);
    }
    // The pixels that keep every pixel within the radius selected (a disc): their bounds
    const contracted = (r) => {
      const reach = [];
      for (let dy = 0; dy <= r; dy++) reach.push(Math.floor(Math.sqrt(r * r - dy * dy)));
      let left = Infinity;
      let right = -Infinity;
      let top = Infinity;
      let bottom = -Infinity;
      for (let y = r; y < rows.length - r; y++) {
        let available = rows[y].map((run) => [run[0] + reach[0], run[1] - reach[0]]).filter((run) => run[0] <= run[1]);
        for (let dy = 1; dy <= r && available.length; dy++) {
          for (let side = -1; side <= 1 && available.length; side += 2) {
            const source = rows[y + side * dy];
            const shrink = reach[dy];
            const next = [];
            let ai = 0;
            let si = 0;
            while (ai < available.length && si < source.length) {
              const low = Math.max(available[ai][0], source[si][0] + shrink);
              const high = Math.min(available[ai][1], source[si][1] - shrink);
              if (low <= high) next.push([low, high]);
              if (available[ai][1] < source[si][1] - shrink) ai++;
              else si++;
            }
            available = next;
          }
        }
        if (!available.length) continue;
        left = Math.min(left, available[0][0]);
        right = Math.max(right, available[available.length - 1][1]);
        top = Math.min(top, m.top + y);
        bottom = Math.max(bottom, m.top + y);
      }
      return Number.isFinite(left) ? { left, top, right, bottom } : null;
    };
    while (radius >= 1) {
      const core = contracted(radius);
      // Bounds are pixel edges: right and bottom past the last pixel
      if (core && core.right + 1 - core.left > 1 && core.bottom + 1 - core.top > 1) {
        const opened = rectFrom(Math.max(core.left - radius, b.left), Math.max(core.top - radius, b.top), Math.min(core.right + 1 + radius, b.right), Math.min(core.bottom + 1 + radius, b.bottom));
        if (opened.width * opened.height >= MIN_BUBBLE_AREA) return opened;
      }
      radius = Math.floor(radius / 2);
    }
    return b;
  };
  // The texts' order along an axis, when they don't overlap on it
  const separatedOrder = (boxes, lo, hi) => {
    const order = boxes.map((box, index) => ({ box, index, sum: box[lo] + box[hi] })).sort((a, b) => a.sum - b.sum);
    return order.every((entry, k) => !k || entry.box[lo] >= order[k - 1].box[hi]) ? order : null;
  };
  const cutLimits = (rect, count, order, lo, hi, loValue, hiValue) => {
    const limits = Array.from({ length: count }, () => [rect[lo], rect[hi]]);
    for (let k = 1; k < order.length; k++) {
      const cut = (loValue(order[k - 1]) + hiValue(order[k])) / 2;
      limits[order[k - 1].index][1] = cut;
      limits[order[k].index][0] = cut;
    }
    return limits;
  };
  // Cuts a merged bubble into one part per text, only along the axes where the texts are apart,
  // in the middle of the gap between them. Overlapping texts are cut between their centres, on
  // the axis they are furthest apart. Parts come back in the order of `boxes`.
  const splitBubble = (rect, boxes) => {
    const byX = separatedOrder(boxes, "left", "right");
    const byY = separatedOrder(boxes, "top", "bottom");
    if (!byX && !byY) {
      const xs = boxes.map((box) => box.xMid);
      const ys = boxes.map((box) => box.yMid);
      const horizontal = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys);
      const mid = horizontal ? "xMid" : "yMid";
      const order = boxes.map((box, index) => ({ box, index, centre: box[mid] })).sort((a, b) => a.centre - b.centre);
      const centre = (entry) => entry.centre;
      const limits = horizontal ? cutLimits(rect, boxes.length, order, "left", "right", centre, centre) : cutLimits(rect, boxes.length, order, "top", "bottom", centre, centre);
      return boxes.map((box, i) => (horizontal ? rectFrom(limits[i][0], rect.top, limits[i][1], rect.bottom) : rectFrom(rect.left, limits[i][0], rect.right, limits[i][1])));
    }
    const xs = byX && cutLimits(rect, boxes.length, byX, "left", "right", (entry) => entry.box.right, (entry) => entry.box.left);
    const ys = byY && cutLimits(rect, boxes.length, byY, "top", "bottom", (entry) => entry.box.bottom, (entry) => entry.box.top);
    return boxes.map((box, i) => rectFrom(xs ? xs[i][0] : rect.left, ys ? ys[i][0] : rect.top, xs ? xs[i][1] : rect.right, ys ? ys[i][1] : rect.bottom));
  };
  // A round lobe is narrower than the merged shape across the cut: the bubble's own pixels
  // inside the cut give its real extent
  const tightLobe = (region, lobe, box, doc) => {
    const x0 = Math.max(0, Math.floor(lobe.left));
    const y0 = Math.max(0, Math.floor(lobe.top));
    const x1 = Math.min(doc.width, Math.ceil(lobe.right));
    const y1 = Math.min(doc.height, Math.ceil(lobe.bottom));
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (let y = y0; y < y1; y++) {
      const row = y * region.w;
      for (let x = x0; x < x1; x++) {
        if (!region.seen[row + x]) continue;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
    if (right < left) return null;
    const tight = rectFrom(left, top, right + 1, bottom + 1);
    return usableBubble(tight, doc) && holds(tight, box.xMid, box.yMid) ? tight : null;
  };
  // Where each text goes, in their order, or an error code for the panel
  const doubleBubbleRects = (doc, layers) => {
    const items = layers.map((layer) => ({ layer, box: boxOf(layer, doc), sizePixels: sizePxOf(layer.params.layerText.textStyleRange[0].textStyle, doc.resolution) }));
    if (items.some((item) => !item.box || item.box.width <= 0 || item.box.height <= 0)) return "doubleBubbleEmpty";
    const boxes = items.map((item) => item.box);
    const selection = doc.state.selection && doc.state.selection.bounds;
    // A selection holding every text's centre is the whole bubble
    if (selection && usableBubble(selection, doc) && boxes.every((box) => holds(selection, box.xMid, box.yMid))) return splitBubble(selection, boxes);
    const probes = items.map((item, i) => probeBubble(doc, item.box, item.sizePixels, boxes.filter((_, j) => j !== i)));
    if (probes.every((found) => found.best)) return probes.map((found) => found.best.bounds);
    // The lobes are one shape: the bubble found around all the texts, cut between them
    const candidates = probes.map((found) => found.loose).filter(Boolean);
    const whole = candidates.find((region) => boxes.every((box) => holds(region.bounds, box.xMid, box.yMid)));
    if (!whole) return "doubleBubbleNotFound";
    return splitBubble(whole.bounds, boxes).map((lobe, i) => tightLobe(whole, lobe, boxes[i], doc) || lobe);
  };

  /* ------------------------ the room around a text being moved ----------------------- */

  // For each pixel, the square of how far the nearest pixel of `from` is (huge when there is none)
  const FAR = 1e20;
  const squaredDistances = (from, w, h) => {
    const out = new Float32Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = from[i] ? 0 : FAR;
    const size = Math.max(w, h);
    const f = new Float64Array(size);
    const v = new Int32Array(size);
    const z = new Float64Array(size + 1);
    // Along a line of pixels, the lower envelope of the parabolas the pixels before left
    const pass = (offset, step, n) => {
      for (let q = 0; q < n; q++) f[q] = out[offset + q * step];
      let k = 0;
      v[0] = 0;
      z[0] = -Infinity;
      z[1] = Infinity;
      for (let q = 1; q < n; q++) {
        let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        while (s <= z[k]) {
          k--;
          s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        }
        k++;
        v[k] = q;
        z[k] = s;
        z[k + 1] = Infinity;
      }
      k = 0;
      for (let q = 0; q < n; q++) {
        while (z[k + 1] < q) k++;
        out[offset + q * step] = (q - v[k]) * (q - v[k]) + f[v[k]];
      }
    };
    for (let x = 0; x < w; x++) pass(x, w, h);
    for (let y = 0; y < h; y++) pass(y * w, 1, w);
    return out;
  };

  // The bubble under a point, as the move tool measures a text against it: what the wand takes
  // there, in a box a pixel wider all around. `filled` has the holes its lettering leaves filled
  // in, `depth` says how far each of its pixels is from the wall (squared), and `body` is the
  // same opened by `radius`, as Align does: neither a tail nor the spikes of a shout are part of
  // it. Kept until the page's pixels change: a drag asks for it again at every step.
  const ROOM_MOST = 0.3;
  const ROOM_OWN = 0.5;
  let roomKept = null;
  let othersKept = null;
  const bubbleBodyAt = (doc, x, y) => {
    const data = sampleData(doc, true);
    const px = Math.max(0, Math.min(doc.width - 1, Math.floor(x)));
    const py = Math.max(0, Math.min(doc.height - 1, Math.floor(y)));
    if (roomKept && roomKept.data === data && roomKept.seen[py * doc.width + px]) return roomKept.bubble;
    const region = bubbleAt(doc, px, py);
    roomKept = { data, seen: region ? region.seen : new Uint8Array(0), bubble: null };
    if (!region) return null;
    const b = region.bounds;
    if (b.width * b.height < MIN_BUBBLE_AREA || b.width * b.height > doc.width * doc.height * ROOM_MOST) return null;
    const w = b.width + 2;
    const h = b.height + 2;
    const left = b.left - 1;
    const top = b.top - 1;
    // What can be reached from the box's sides without crossing the bubble is outside it
    const outside = new Uint8Array(w * h);
    const inside = (i) => {
      const ix = i % w;
      const iy = (i - ix) / w;
      return ix > 0 && iy > 0 && ix < w - 1 && iy < h - 1 && region.seen[(top + iy) * region.w + left + ix] === 1;
    };
    const stack = [0];
    outside[0] = 1;
    while (stack.length) {
      const i = stack.pop();
      const ix = i % w;
      const reach = (j) => {
        if (outside[j] || inside(j)) return;
        outside[j] = 1;
        stack.push(j);
      };
      if (ix > 0) reach(i - 1);
      if (ix < w - 1) reach(i + 1);
      if (i >= w) reach(i - w);
      if (i < w * (h - 1)) reach(i + w);
    }
    const filled = new Uint8Array(w * h);
    let area = 0;
    let own = 0;
    for (let i = 0; i < filled.length; i++) {
      if (outside[i]) continue;
      filled[i] = 1;
      area++;
      if (inside(i)) own++;
    }
    // Mostly holes: the lines of a drawing, with what they go around, not a bubble
    if (own < area * ROOM_OWN) return null;
    const depth = squaredDistances(outside, w, h);
    const shortest = Math.min(b.width, b.height);
    const most = Math.floor(shortest / 2 - 1);
    let radius = most > 0 ? Math.min(most, Math.max(MIN_OPEN_RADIUS, Math.round(shortest * OPEN_RATIO))) : 0;
    let body = filled;
    for (; radius >= 1; radius = Math.floor(radius / 2)) {
      const core = new Uint8Array(w * h);
      let any = false;
      for (let i = 0; i < core.length; i++) {
        if (depth[i] > radius * radius) {
          core[i] = 1;
          any = true;
        }
      }
      if (!any) continue;
      const reach = squaredDistances(core, w, h);
      body = new Uint8Array(w * h);
      for (let i = 0; i < body.length; i++) body[i] = filled[i] && reach[i] <= radius * radius ? 1 : 0;
      break;
    }
    roomKept.bubble = { left, top, width: w, height: h, filled, body, depth, radius: Math.max(0, radius), peaks: new Int32Array(w * h), apart: new Map() };
    return roomKept.bubble;
  };

  // The lobes of a bubble: from any of its pixels, going up to where the wall is furthest leads
  // to the middle of the lobe it's in. `peakOf` is that place (found once for each pixel met on
  // the way), and two of them are `apart` when they aren't the middle of one same lobe: between
  // them the bubble gets narrow, and the second one's lobe is big enough to be one.
  const peakOf = (bubble, start) => {
    const { peaks, depth, width, height } = bubble;
    const path = [];
    let i = start;
    while (!peaks[i]) {
      path.push(i);
      const x = i % width;
      let best = i;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const j = i + dy * width + dx;
          if (x + dx < 0 || x + dx >= width || j < 0 || j >= width * height) continue;
          if (depth[j] > depth[best]) best = j;
        }
      }
      if (best === i) {
        peaks[i] = i + 1;
        break;
      }
      i = best;
    }
    const peak = peaks[i];
    path.forEach((step) => { peaks[step] = peak; });
    return peak - 1;
  };
  const lobesApart = (bubble, home, other) => {
    if (home === other) return false;
    const key = home * bubble.peaks.length + other;
    if (bubble.apart.has(key)) return bubble.apart.get(key);
    const { depth, width } = bubble;
    const here = Math.sqrt(depth[home]);
    const there = Math.sqrt(depth[other]);
    let apart = false;
    if (there >= here * NECK_LOBE) {
      const x0 = home % width;
      const y0 = (home - x0) / width;
      const x1 = other % width;
      const y1 = (other - x1) / width;
      const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
      const least = NECK_DIP * NECK_DIP * Math.min(depth[home], depth[other]);
      for (let n = 1; n < steps && !apart; n++) {
        apart = depth[Math.round(y0 + ((y1 - y0) * n) / steps) * width + Math.round(x0 + ((x1 - x0) * n) / steps)] <= least;
      }
    }
    bubble.apart.set(key, apart);
    return apart;
  };

  // How far a text's box is from its bubble's wall, straight out from the middle of each of its
  // sides: [{ side, from, to, gap }], page pixels, for the sides where that says something.
  //  - A tail, or a spike: the wall is where the bubble's body ends, not its tip.
  //  - A double bubble: towards its other lobe, nothing. Going there the bubble gets narrow, then
  //    wide again: how far its wall is, from the text's middle on, falls then rises (NECK_DIP of
  //    what it was, into a lobe NECK_LOBE of this one at least; less is the bump of a cloud). Or
  //    the line ends up in the other lobe without going through the narrow part, when the two
  //    are side by side at an angle (see lobesApart).
  //  - Another text on the way: nothing either, the room that side isn't this text's alone.
  const NECK_DIP = 0.85;
  const NECK_LOBE = 1 / 3;
  const SIDES = [["top", 0, -1], ["bottom", 0, 1], ["left", -1, 0], ["right", 1, 0]];
  const roomAround = (doc, box, others) => {
    const bubble = bubbleBodyAt(doc, box.xMid, box.yMid);
    if (!bubble) return [];
    const cx = Math.floor(box.xMid);
    const cy = Math.floor(box.yMid);
    const edges = { top: Math.round(box.top), bottom: Math.round(box.bottom), left: Math.round(box.left), right: Math.round(box.right) };
    const at = (x, y) => {
      const ix = x - bubble.left;
      const iy = y - bubble.top;
      return ix < 0 || iy < 0 || ix >= bubble.width || iy >= bubble.height ? -1 : iy * bubble.width + ix;
    };
    const rooms = [];
    const middle = at(cx, cy);
    const home = middle >= 0 && bubble.filled[middle] ? peakOf(bubble, middle) : -1;
    SIDES.forEach(([side, ux, uy]) => {
      // The first pixel past the box that side, and how many steps from the middle it is
      const start = ux ? (ux < 0 ? cx - (edges.left - 1) : edges.right - cx) : uy < 0 ? cy - (edges.top - 1) : edges.bottom - cy;
      let peak = 0;
      let valley = 0;
      let neck = false;
      let bodyEnd = -1;
      let wall = -1;
      for (let step = 0; ; step++) {
        const i = at(cx + ux * step, cy + uy * step);
        if (i < 0 || !bubble.filled[i]) {
          wall = step;
          break;
        }
        if (step >= start && bodyEnd < 0 && !bubble.body[i]) bodyEnd = step;
        const deep = Math.sqrt(bubble.depth[i]);
        if (deep > peak) {
          peak = deep;
          valley = deep;
        } else if (deep < valley) valley = deep;
        else if (valley <= NECK_DIP * Math.min(peak, deep) && deep >= peak * NECK_LOBE) neck = true;
        if (!neck && step >= start && home >= 0 && lobesApart(bubble, home, peakOf(bubble, i))) neck = true;
      }
      // The text goes past the bubble that side, or what's there is another lobe
      if (wall < start || neck) return;
      // What goes on past the body is a tail when it's longer than it is wide halfway (the wall
      // is then where the body ends), and a bump of the outline otherwise
      let end = wall;
      if (bodyEnd >= 0 && wall - bodyEnd >= 3) {
        const half = (bodyEnd + wall) >> 1;
        let across = 1;
        for (let side = -1; side <= 1; side += 2) {
          for (let n = 1; ; n++) {
            const i = at(cx + ux * half + uy * side * n, cy + uy * half + ux * side * n);
            if (i < 0 || !bubble.filled[i]) break;
            across++;
          }
        }
        if (wall - bodyEnd >= across) end = bodyEnd;
      }
      if (end <= start && end !== wall) return;
      const gap = end - start;
      const from = ux ? [ux < 0 ? edges.left : edges.right, cy + 0.5] : [cx + 0.5, uy < 0 ? edges.top : edges.bottom];
      const to = [from[0] + ux * gap, from[1] + uy * gap];
      const x0 = Math.min(from[0], to[0]);
      const x1 = Math.max(from[0], to[0]);
      const y0 = Math.min(from[1], to[1]);
      const y1 = Math.max(from[1], to[1]);
      if (others.some((other) => other.left <= x1 && other.right >= x0 && other.top <= y1 && other.bottom >= y0)) return;
      rooms.push({ side, from, to, gap });
    });
    return rooms;
  };

  // What the Magic Eraser reads without Sample All Layers: the active layer's own pixels,
  // transparent where it has none
  const layerPixels = (doc, layer) => {
    const canvas = newCanvas(doc.width, doc.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const visual = visualOf(layer, doc);
    if (visual) ctx.drawImage(visual.canvas, visual.x, visual.y);
    return ctx.getImageData(0, 0, doc.width, doc.height).data;
  };

  // The Magic Eraser's region from a click: an alpha mask on the page, with a pixel of soft edge
  // when anti-aliased (an edge pixel takes the mean of its 3×3, inside pixels at least half,
  // outside ones at most half, as photocraft does it). Colours are compared with their alpha,
  // and every fully transparent pixel is alike, whatever colour it hides.
  const magicRegion = (doc, layer, x, y) => {
    const w = doc.width;
    const h = doc.height;
    const sx = Math.floor(x);
    const sy = Math.floor(y);
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) return null;
    const data = app.magicSampleAll ? sampleData(doc, true) : layerPixels(doc, layer);
    const tolerance = app.magicTolerance;
    const start = (sy * w + sx) * 4;
    const seed = [data[start], data[start + 1], data[start + 2], data[start + 3]];
    const similar = (p) => {
      const i = p * 4;
      if (seed[3] === 0 && data[i + 3] === 0) return true;
      return Math.abs(data[i] - seed[0]) <= tolerance && Math.abs(data[i + 1] - seed[1]) <= tolerance && Math.abs(data[i + 2] - seed[2]) <= tolerance && Math.abs(data[i + 3] - seed[3]) <= tolerance;
    };
    const { seen, left, top, right, bottom } = floodMarks(w, h, sx, sy, similar, app.magicContiguous !== false);
    if (right < 0) return null;
    const soft = app.magicAntiAlias !== false;
    const pad = soft ? 1 : 0;
    const x0 = Math.max(0, left - pad);
    const y0 = Math.max(0, top - pad);
    const x1 = Math.min(w, right + 1 + pad);
    const y1 = Math.min(h, bottom + 1 + pad);
    const canvas = newCanvas(x1 - x0, y1 - y0);
    const ctx = canvas.getContext("2d");
    const image = ctx.createImageData(canvas.width, canvas.height);
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const v = seen[py * w + px];
        let alpha = v ? 255 : 0;
        if (soft) {
          let sum = 0;
          let edge = false;
          for (let ny = py - 1; ny <= py + 1; ny++) {
            for (let nx = px - 1; nx <= px + 1; nx++) {
              const n = nx < 0 || ny < 0 || nx >= w || ny >= h ? v : seen[ny * w + nx];
              if (n !== v) edge = true;
              sum += n;
            }
          }
          if (edge) alpha = Math.round((v ? 0.5 + sum / 18 : sum / 18) * 255);
        }
        image.data[((py - y0) * canvas.width + (px - x0)) * 4 + 3] = alpha;
      }
    }
    ctx.putImageData(image, 0, 0);
    // Only inside the selection, if there is one
    const selection = doc.state.selection;
    if (selection) {
      ctx.globalCompositeOperation = "destination-in";
      ctx.drawImage(selectionCanvas(selection), selection.bounds.left - x0, selection.bounds.top - y0);
    }
    return { canvas, x: x0, y: y0 };
  };

  const makeSelection = ({ source, mask, boxW, boxH, left, top, polygon, rect, trigger }) => {
    if (rect) {
      return {
        source: "rectangle",
        bounds: rectFrom(rect.left, rect.top, rect.right, rect.bottom),
        rings: [[[rect.left, rect.top], [rect.right, rect.top], [rect.right, rect.bottom], [rect.left, rect.bottom]]],
        mask: null,
        trigger,
      };
    }
    let rings = traceMask(mask, boxW, boxH, left, top)
      .filter((ring) => ringArea(ring) >= 9)
      .map((ring) => simplifyRing(ring, 1.1))
      .filter((ring) => ring.length >= 3);
    // Photoshop refuses too heavy a work path, and a selection of screentone
    // would be one: keep its largest outlines
    if (rings.length > 300) rings = rings.sort((a, b) => ringArea(b) - ringArea(a)).slice(0, 300);
    let sum = 0;
    rings.forEach((ring) => { sum += ring.length; });
    if (sum > 3800) {
      rings = rings.map((ring) => (ring.length > 60 ? simplifyRing(ring, 2.2) : ring));
    }
    return {
      source,
      bounds: rectFrom(left, top, left + boxW, top + boxH),
      rings,
      mask: { data: mask, width: boxW, height: boxH, left, top },
      polygon: polygon || null,
      trigger,
    };
  };

  const polygonSelection = (doc, points, trigger) => {
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const left = Math.max(0, Math.floor(Math.min(...xs)));
    const top = Math.max(0, Math.floor(Math.min(...ys)));
    const right = Math.min(doc.width, Math.ceil(Math.max(...xs)));
    const bottom = Math.min(doc.height, Math.ceil(Math.max(...ys)));
    const boxW = right - left;
    const boxH = bottom - top;
    if (boxW < 2 || boxH < 2) return null;
    const c = document.createElement("canvas");
    c.width = boxW;
    c.height = boxH;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    points.forEach((p, i) => (i ? ctx.lineTo(p[0] - left, p[1] - top) : ctx.moveTo(p[0] - left, p[1] - top)));
    ctx.closePath();
    ctx.fill();
    const px = ctx.getImageData(0, 0, boxW, boxH).data;
    const mask = new Uint8Array(boxW * boxH);
    for (let i = 0; i < mask.length; i++) mask[i] = px[i * 4 + 3] > 127 ? 1 : 0;
    return makeSelection({ source: "lasso", mask, boxW, boxH, left, top, polygon: points, trigger });
  };

  const ellipseSelection = (doc, left, top, right, bottom, trigger) => {
    const x0 = Math.max(0, Math.floor(left));
    const y0 = Math.max(0, Math.floor(top));
    const x1 = Math.min(doc.width, Math.ceil(right));
    const y1 = Math.min(doc.height, Math.ceil(bottom));
    const boxW = x1 - x0;
    const boxH = y1 - y0;
    if (boxW < 2 || boxH < 2) return null;
    const c = newCanvas(boxW, boxH);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.beginPath();
    ctx.ellipse((left + right) / 2 - x0, (top + bottom) / 2 - y0, (right - left) / 2, (bottom - top) / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    const px = ctx.getImageData(0, 0, boxW, boxH).data;
    const mask = new Uint8Array(boxW * boxH);
    for (let i = 0; i < mask.length; i++) mask[i] = px[i * 4 + 3] > 127 ? 1 : 0;
    const selection = makeSelection({ source: "ellipse", mask, boxW, boxH, left: x0, top: y0, trigger });
    selection.ellipse = { left: x0, top: y0, right: x1, bottom: y1 };
    return selection;
  };

  // A selection from the pixels marked in `buf`, a `bw` × `bh` box of the page from (`x0`,
  // `y0`): cut down to what is marked (the box itself when it is all used)
  const fromBoxMask = (buf, x0, y0, bw, bh, source) => {
    let left = bw;
    let top = -1;
    let right = -1;
    let bottom = -1;
    for (let y = 0; y < bh; y++) {
      const row = y * bw;
      let x = 0;
      while (x < bw && !buf[row + x]) x++;
      if (x === bw) continue;
      let end = bw - 1;
      while (!buf[row + end]) end--;
      if (x < left) left = x;
      if (end > right) right = end;
      if (top < 0) top = y;
      bottom = y;
    }
    if (right < 0) return null;
    const boxW = right - left + 1;
    const boxH = bottom - top + 1;
    let mask = buf;
    if (boxW !== bw || boxH !== bh) {
      mask = new Uint8Array(boxW * boxH);
      for (let y = 0; y < boxH; y++) {
        const row = (top + y) * bw + left;
        mask.set(buf.subarray(row, row + boxW), y * boxW);
      }
    }
    return makeSelection({ source: source || "mixed", mask, boxW, boxH, left: x0 + left, top: y0 + top });
  };
  const fromFullMask = (doc, full, source) => fromBoxMask(full, 0, 0, doc.width, doc.height, source);

  // The page pixels a selection can cover: its mask's box, or the whole pixels its rectangle
  // reaches, on the page
  const selectionBox = (doc, selection) => {
    const b = selection.bounds;
    const m = selection.mask;
    const left = Math.max(0, m ? m.left : Math.floor(b.left));
    const top = Math.max(0, m ? m.top : Math.floor(b.top));
    const right = Math.max(left, Math.min(doc.width, m ? m.left + m.width : Math.ceil(b.right)));
    const bottom = Math.max(top, Math.min(doc.height, m ? m.top + m.height : Math.ceil(b.bottom)));
    return { left, top, right, bottom };
  };
  // Marks `value` where a selection covers `buf`, a box of the page `bw` wide from (`x0`, `y0`)
  const paintSelection = (doc, selection, buf, x0, y0, bw, value) => {
    const box = selectionBox(doc, selection);
    const left = Math.max(box.left, x0);
    const right = Math.min(box.right, x0 + bw);
    const top = Math.max(box.top, y0);
    const bottom = Math.min(box.bottom, y0 + buf.length / bw);
    const m = selection.mask;
    for (let y = top; y < bottom; y++) {
      const at = (y - y0) * bw - x0;
      if (!m) {
        buf.fill(value, at + left, at + right);
        continue;
      }
      const row = (y - m.top) * m.width - m.left;
      for (let x = left; x < right; x++) if (m.data[row + x]) buf[at + x] = value;
    }
  };
  const boxMaskOf = (doc, selection, box) => {
    const buf = new Uint8Array((box.right - box.left) * (box.bottom - box.top));
    paintSelection(doc, selection, buf, box.left, box.top, box.right - box.left, 1);
    return buf;
  };

  const fullMaskOf = (doc, selection) => {
    const full = new Uint8Array(doc.width * doc.height);
    paintSelection(doc, selection, full, 0, 0, doc.width, 1);
    return full;
  };

  // Shift adds, Alt takes away, both keep what the two have in common. Only the part of the
  // page the result can reach is looked at: the two boxes together, the first, or their overlap.
  const combineSelections = (doc, current, incoming, mode) => {
    const a = selectionBox(doc, current);
    const b = selectionBox(doc, incoming);
    const box = mode === "add"
      ? { left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) }
      : mode === "subtract" ? a
        : { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
    const bw = box.right - box.left;
    const bh = box.bottom - box.top;
    if (bw <= 0 || bh <= 0) return null;
    const out = boxMaskOf(doc, current, box);
    if (mode === "add") paintSelection(doc, incoming, out, box.left, box.top, bw, 1);
    else if (mode === "subtract") paintSelection(doc, incoming, out, box.left, box.top, bw, 0);
    else {
      const other = boxMaskOf(doc, incoming, box);
      for (let i = 0; i < out.length; i++) out[i] &= other[i];
    }
    return fromBoxMask(out, box.left, box.top, bw, bh);
  };

  const invertSelection = (doc, selection) => {
    const full = new Uint8Array(doc.width * doc.height).fill(1);
    paintSelection(doc, selection, full, 0, 0, doc.width, 0);
    return fromFullMask(doc, full);
  };

  // Drawn around the selection only: what it grows into lies within the radius of it
  const growSelection = (doc, selection, radius) => {
    const b = selection.bounds;
    const margin = Math.ceil(Math.abs(radius)) + 2;
    const x0 = Math.max(0, Math.floor(b.left) - margin);
    const y0 = Math.max(0, Math.floor(b.top) - margin);
    const bw = Math.min(doc.width, Math.ceil(b.right) + margin) - x0;
    const bh = Math.min(doc.height, Math.ceil(b.bottom) + margin) - y0;
    if (bw <= 0 || bh <= 0) return null;
    const c = newCanvas(bw, bh);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.translate(-x0, -y0);
    const path = new Path2D();
    selection.rings.forEach((ring) => {
      ring.forEach((p, i) => (i ? path.lineTo(p[0], p[1]) : path.moveTo(p[0], p[1])));
      path.closePath();
    });
    ctx.fill(path, "evenodd");
    ctx.lineWidth = Math.abs(radius) * 2;
    ctx.lineJoin = "round";
    if (radius < 0) ctx.globalCompositeOperation = "destination-out";
    ctx.stroke(path);
    const px = ctx.getImageData(0, 0, bw, bh).data;
    const full = new Uint8Array(bw * bh);
    for (let i = 0; i < full.length; i++) full[i] = px[i * 4 + 3] > 127 ? 1 : 0;
    return fromBoxMask(full, x0, y0, bw, bh);
  };

  const translateSelection = (selection, dx, dy) => {
    const b = selection.bounds;
    const moved = Object.assign({}, selection, {
      bounds: rectFrom(b.left + dx, b.top + dy, b.right + dx, b.bottom + dy),
      rings: selection.rings.map((ring) => ring.map((p) => [p[0] + dx, p[1] + dy])),
      trigger: undefined,
      moved: true,
    });
    if (selection.mask) moved.mask = Object.assign({}, selection.mask, { left: selection.mask.left + dx, top: selection.mask.top + dy });
    return moved;
  };

  const selectionContains = (selection, x, y) => {
    const b = selection.bounds;
    if (x < b.left || y < b.top || x >= b.right || y >= b.bottom) return false;
    if (!selection.mask) return true;
    const m = selection.mask;
    return Boolean(m.data[(Math.floor(y) - m.top) * m.width + Math.floor(x) - m.left]);
  };

  const rectMaskIterate = (selection, visit) => {
    const b = selection.bounds;
    if (selection.mask) {
      const m = selection.mask;
      for (let y = 0; y < m.height; y++) {
        for (let x = 0; x < m.width; x++) if (m.data[y * m.width + x]) visit(m.left + x, m.top + y);
      }
      return;
    }
    for (let y = Math.max(0, Math.floor(b.top)); y < b.bottom; y++) {
      for (let x = Math.max(0, Math.floor(b.left)); x < b.right; x++) visit(x, y);
    }
  };

  const selectionHistograms = (doc, selection) => {
    const data = sampleData(doc);
    const hist = [new Array(256).fill(0), new Array(256).fill(0), new Array(256).fill(0)];
    rectMaskIterate(selection, (x, y) => {
      if (x >= doc.width || y >= doc.height) return;
      const i = (y * doc.width + x) * 4;
      hist[0][data[i]]++;
      hist[1][data[i + 1]]++;
      hist[2][data[i + 2]]++;
    });
    return hist;
  };

  /* ============ the Bubble Cleaner: a bubble's text off, in its own colours ============ */

  // A bubble is a plain area that wraps its lettering: the letters are the holes in it. They
  // are painted over with the colours around them, carried in from every side, so a white, a
  // black, a pink or a shaded bubble all come out as they were without their text.

  // Pixels close to a seed's colour, joined to it, inside a window of the page (window
  // coordinates). They get `id` in `labels`, which several floods share.
  const cleanFlood = (data, pageW, win, sx, sy, tolerance, labels, id) => {
    const w = win.right - win.left;
    const h = win.bottom - win.top;
    const at = ((sy + win.top) * pageW + sx + win.left) * 4;
    const seed = [data[at], data[at + 1], data[at + 2]];
    const close = (x, y) => {
      const i = ((y + win.top) * pageW + x + win.left) * 4;
      return Math.abs(data[i] - seed[0]) <= tolerance && Math.abs(data[i + 1] - seed[1]) <= tolerance && Math.abs(data[i + 2] - seed[2]) <= tolerance;
    };
    const mask = labels;
    const stack = [sx, sy];
    let area = 0;
    let left = sx;
    let right = sx;
    let top = sy;
    let bottom = sy;
    while (stack.length) {
      const y = stack.pop();
      let x = stack.pop();
      while (x >= 0 && !mask[y * w + x] && close(x, y)) x--;
      x++;
      let up = false;
      let down = false;
      for (; x < w; x++) {
        const index = y * w + x;
        if (mask[index] || !close(x, y)) break;
        mask[index] = id;
        area++;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (y > 0) {
          if (!mask[index - w] && close(x, y - 1)) {
            if (!up) {
              stack.push(x, y - 1);
              up = true;
            }
          } else up = false;
        }
        if (y < h - 1) {
          if (!mask[index + w] && close(x, y + 1)) {
            if (!down) {
              stack.push(x, y + 1);
              down = true;
            }
          } else down = false;
        }
      }
    }
    return { id, area, seed, box: { left, top, right: right + 1, bottom: bottom + 1 } };
  };

  // What the region wraps: the pixels outside it that can't reach the window's edge without
  // crossing it. Each hole is measured, to tell lettering from a drawing inside the bubble.
  const cleanHoles = (region, w, h) => {
    const { mask } = region;
    const outside = new Uint8Array(w * h);
    const queue = new Int32Array(w * h);
    let head = 0;
    let tail = 0;
    const push = (index) => {
      if (mask[index] || outside[index]) return;
      outside[index] = 1;
      queue[tail++] = index;
    };
    for (let x = 0; x < w; x++) {
      push(x);
      push((h - 1) * w + x);
    }
    for (let y = 0; y < h; y++) {
      push(y * w);
      push(y * w + w - 1);
    }
    // Past a lasso's outline is outside too, wherever the outline goes
    if (region.fence) for (let i = 0; i < w * h; i++) if (region.fence[i]) push(i);
    while (head < tail) {
      const index = queue[head++];
      const x = index % w;
      if (x > 0) push(index - 1);
      if (x < w - 1) push(index + 1);
      if (index >= w) push(index - w);
      if (index < w * (h - 1)) push(index + w);
    }
    // The holes, one by one
    const label = new Int32Array(w * h);
    const sizes = [0];
    for (let start = 0; start < w * h; start++) {
      if (mask[start] || outside[start] || label[start]) continue;
      const id = sizes.length;
      let size = 0;
      head = 0;
      tail = 0;
      label[start] = id;
      queue[tail++] = start;
      while (head < tail) {
        const index = queue[head++];
        size++;
        const x = index % w;
        const near = [x > 0 ? index - 1 : -1, x < w - 1 ? index + 1 : -1, index >= w ? index - w : -1, index < w * (h - 1) ? index + w : -1];
        for (let k = 0; k < 4; k++) {
          const n = near[k];
          if (n < 0 || mask[n] || outside[n] || label[n]) continue;
          label[n] = id;
          queue[tail++] = n;
        }
      }
      sizes.push(size);
    }
    return { outside, label, sizes };
  };

  // How far each pixel of a shape is from its edge, in pixels (0 outside it)
  const cleanDistances = (inside, w, h) => {
    const d = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const x = i % w;
      d[i] = inside[i] && x > 0 && x < w - 1 && i >= w && i < w * (h - 1) ? 1e9 : inside[i] ? 1 : 0;
    }
    const D = 1.4142;
    for (let y = 1; y < h; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (d[i] > 1) d[i] = Math.min(d[i], d[i - 1] + 1, d[i - w] + 1, d[i - w - 1] + D, d[i - w + 1] + D);
      }
    }
    for (let y = h - 2; y >= 0; y--) {
      for (let x = w - 2; x > 0; x--) {
        const i = y * w + x;
        if (d[i] > 1) d[i] = Math.min(d[i], d[i + 1] + 1, d[i + w] + 1, d[i + w + 1] + D, d[i + w - 1] + D);
      }
    }
    return d;
  };

  // How thick a flooded region is at its thickest: a letter's stroke is thin, a bubble isn't
  const cleanThickness = (labels, id, w, box) => {
    const bw = box.right - box.left;
    const bh = box.bottom - box.top;
    const inside = new Uint8Array(bw * bh);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) inside[y * bw + x] = labels[(y + box.top) * w + x + box.left] === id ? 1 : 0;
    }
    const d = cleanDistances(inside, bw, bh);
    let most = 0;
    for (let i = 0; i < d.length; i++) if (d[i] > most) most = d[i];
    return most;
  };

  // A shape grown by `r` pixels on every side (a square)
  const cleanGrow = (shape, w, h, r) => {
    const across = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      // From both sides: the nearest marked pixel to the left, then to the right
      let prev = -1e9;
      for (let x = 0; x < w; x++) {
        if (shape[y * w + x]) prev = x;
        if (x - prev <= r) across[y * w + x] = 1;
      }
      let nextOn = 1e9;
      for (let x = w - 1; x >= 0; x--) {
        if (shape[y * w + x]) nextOn = x;
        if (nextOn - x <= r) across[y * w + x] = 1;
      }
    }
    const out = new Uint8Array(w * h);
    for (let x = 0; x < w; x++) {
      let prev = -1e9;
      for (let y = 0; y < h; y++) {
        if (across[y * w + x]) prev = y;
        if (y - prev <= r) out[y * w + x] = 1;
      }
      let nextOn = 1e9;
      for (let y = h - 1; y >= 0; y--) {
        if (across[y * w + x]) nextOn = y;
        if (nextOn - y <= r) out[y * w + x] = 1;
      }
    }
    return out;
  };

  // Colours carried into the unknown pixels from the known ones around them, coarser and
  // coarser, then back down (push-pull). Smooth enough for a shaded bubble, exact on a flat one.
  const cleanInpaint = (rgb, known, w, h) => {
    const levels = [];
    let lw = w;
    let lh = h;
    let r = new Float32Array(w * h);
    let g = new Float32Array(w * h);
    let b = new Float32Array(w * h);
    let k = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      if (!known[i]) continue;
      r[i] = rgb[i * 3];
      g[i] = rgb[i * 3 + 1];
      b[i] = rgb[i * 3 + 2];
      k[i] = 1;
    }
    levels.push({ w: lw, h: lh, r, g, b, k });
    while (lw > 1 || lh > 1) {
      const nw = Math.max(1, Math.ceil(lw / 2));
      const nh = Math.max(1, Math.ceil(lh / 2));
      const nr = new Float32Array(nw * nh);
      const ng = new Float32Array(nw * nh);
      const nb = new Float32Array(nw * nh);
      const nk = new Float32Array(nw * nh);
      for (let y = 0; y < lh; y++) {
        for (let x = 0; x < lw; x++) {
          const i = y * lw + x;
          if (!k[i]) continue;
          const j = (y >> 1) * nw + (x >> 1);
          nr[j] += r[i];
          ng[j] += g[i];
          nb[j] += b[i];
          nk[j] += k[i];
        }
      }
      lw = nw;
      lh = nh;
      r = nr;
      g = ng;
      b = nb;
      k = nk;
      levels.push({ w: lw, h: lh, r, g, b, k });
    }
    // Every level as plain colours, filled from the level above where nothing was known
    const top = levels[levels.length - 1];
    const colours = [];
    const flat = (level) => {
      const out = new Float32Array(level.w * level.h * 3);
      for (let i = 0; i < level.w * level.h; i++) {
        if (!level.k[i]) continue;
        out[i * 3] = level.r[i] / level.k[i];
        out[i * 3 + 1] = level.g[i] / level.k[i];
        out[i * 3 + 2] = level.b[i] / level.k[i];
      }
      return out;
    };
    colours[levels.length - 1] = flat(top);
    for (let n = levels.length - 2; n >= 0; n--) {
      const level = levels[n];
      const above = levels[n + 1];
      const coarse = colours[n + 1];
      const out = flat(level);
      for (let y = 0; y < level.h; y++) {
        for (let x = 0; x < level.w; x++) {
          const i = y * level.w + x;
          if (level.k[i]) continue;
          // Bilinear, from the coarser level's centres
          const fx = Math.max(0, Math.min(above.w - 1, (x + 0.5) / 2 - 0.5));
          const fy = Math.max(0, Math.min(above.h - 1, (y + 0.5) / 2 - 0.5));
          const x0 = Math.floor(fx);
          const y0 = Math.floor(fy);
          const x1 = Math.min(above.w - 1, x0 + 1);
          const y1 = Math.min(above.h - 1, y0 + 1);
          const ax = fx - x0;
          const ay = fy - y0;
          const a = (y0 * above.w + x0) * 3;
          const bb = (y0 * above.w + x1) * 3;
          const c = (y1 * above.w + x0) * 3;
          const d = (y1 * above.w + x1) * 3;
          for (let o = 0; o < 3; o++) out[i * 3 + o] = (coarse[a + o] * (1 - ax) + coarse[bb + o] * ax) * (1 - ay) + (coarse[c + o] * (1 - ax) + coarse[d + o] * ax) * ay;
        }
      }
      colours[n] = out;
    }
    return colours[0];
  };

  // The plan of a clean: what gets painted, in which colours. `at` is a click, `box` a dragged
  // box, `points` a lasso's outline. Returns { left, top, width, height, pixels (RGBA) } or { error }.
  const planBubbleClean = (doc, options) => {
    const data = sampleData(doc, true);
    const pageW = doc.width;
    const pageH = doc.height;
    const tolerance = Math.max(0, Math.min(255, options.tolerance));
    const margin = Math.max(0, Math.min(20, Math.round(options.margin)));
    let win;
    let region;
    let labels;
    let holeLimit;
    let fence = null;
    if (options.points) {
      // A lasso works as a box would, only what is past its outline is left out
      const xs = options.points.map((p) => p[0]);
      const ys = options.points.map((p) => p[1]);
      options = Object.assign({}, options, { box: { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) } });
    }
    if (options.box) {
      const b = options.box;
      win = { left: Math.max(0, Math.floor(b.left)), top: Math.max(0, Math.floor(b.top)), right: Math.min(pageW, Math.ceil(b.right)), bottom: Math.min(pageH, Math.ceil(b.bottom)) };
      const w = win.right - win.left;
      const h = win.bottom - win.top;
      if (w < 4 || h < 4) return { error: "nothing" };
      let inside = w * h;
      if (options.points) {
        const shape = newCanvas(w, h);
        const ctx = shape.getContext("2d", { willReadFrequently: true });
        ctx.beginPath();
        options.points.forEach((p, n) => (n ? ctx.lineTo : ctx.moveTo).call(ctx, p[0] - win.left, p[1] - win.top));
        ctx.closePath();
        ctx.fill();
        const alpha = ctx.getImageData(0, 0, w, h).data;
        fence = new Uint8Array(w * h);
        inside = 0;
        for (let i = 0; i < w * h; i++) {
          if (alpha[i * 4 + 3] < 128) fence[i] = 1;
          else inside++;
        }
        if (inside < 16) return { error: "nothing" };
      }
      // The background is the box's most common colour, and every pixel near it
      const bins = new Map();
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (fence && fence[y * w + x]) continue;
          const i = ((y + win.top) * pageW + x + win.left) * 4;
          const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
          bins.set(key, (bins.get(key) || 0) + 1);
        }
      }
      let best = -1;
      let count = 0;
      bins.forEach((n, key) => {
        if (n > count) {
          count = n;
          best = key;
        }
      });
      const seed = [((best >> 10) & 31) * 8 + 4, ((best >> 5) & 31) * 8 + 4, (best & 31) * 8 + 4];
      labels = new Uint8Array(w * h);
      let area = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (fence && fence[y * w + x]) continue;
          const i = ((y + win.top) * pageW + x + win.left) * 4;
          if (Math.abs(data[i] - seed[0]) <= tolerance && Math.abs(data[i + 1] - seed[1]) <= tolerance && Math.abs(data[i + 2] - seed[2]) <= tolerance) {
            labels[y * w + x] = 1;
            area++;
          }
        }
      }
      if (area < inside * 0.3) return { error: "plain" };
      region = { id: 1, area, seed, box: { left: 0, top: 0, right: w, bottom: h } };
      holeLimit = Infinity;
    } else {
      // A click: the region under it, or, on a letter, the plain area around the letter
      win = { left: 0, top: 0, right: pageW, bottom: pageH };
      const x = Math.max(0, Math.min(pageW - 1, Math.round(options.x)));
      const y = Math.max(0, Math.min(pageH - 1, Math.round(options.y)));
      const THICK = 6;
      const leaks = (r) => {
        const edges = (r.box.left <= 0 ? 1 : 0) + (r.box.top <= 0 ? 1 : 0) + (r.box.right >= pageW ? 1 : 0) + (r.box.bottom >= pageH ? 1 : 0);
        return edges >= 3 || (r.box.right - r.box.left) * (r.box.bottom - r.box.top) > pageW * pageH * 0.6;
      };
      labels = new Uint8Array(pageW * pageH);
      const first = cleanFlood(data, pageW, win, x, y, tolerance, labels, 1);
      region = first;
      if (cleanThickness(labels, 1, pageW, first.box) < THICK) {
        // Out from the click in 16 directions: past the letter, what each direction meets
        const found = new Map();
        const tried = [first];
        let next = 2;
        for (let n = 0; n < 16; n++) {
          const angle = (n * Math.PI) / 8;
          const dx = Math.cos(angle);
          const dy = Math.sin(angle);
          let past = -1;
          for (let step = 1; step < 400; step++) {
            const px = Math.round(x + dx * step);
            const py = Math.round(y + dy * step);
            if (px < 0 || py < 0 || px >= pageW || py >= pageH) break;
            const owner = labels[py * pageW + px];
            if (past < 0 && owner === 1) continue;
            if (past < 0) past = step;
            if (step - past > 6) break;
            let r = owner ? tried[owner - 1] : null;
            if (!r) {
              if (next > 255) break;
              r = cleanFlood(data, pageW, win, px, py, tolerance, labels, next++);
              r.thick = leaks(r) ? 0 : cleanThickness(labels, r.id, pageW, r.box);
              tried.push(r);
            }
            if (r === first || !(r.thick >= THICK)) continue;
            found.set(r, (found.get(r) || 0) + 1);
            break;
          }
        }
        let votes = 0;
        found.forEach((n, r) => {
          if (n > votes) {
            votes = n;
            region = r;
          }
        });
        if (region === first) return { error: "background" };
      }
      if (leaks(region)) return { error: "open" };
      holeLimit = 0.18;
    }
    const w = win.right - win.left;
    const h = win.bottom - win.top;
    // The work happens in the region's box, one pixel wider so that its edge is outside
    const rb = region.box;
    const area = { left: Math.max(0, rb.left - 1), top: Math.max(0, rb.top - 1), right: Math.min(w, rb.right + 1), bottom: Math.min(h, rb.bottom + 1) };
    const aw = area.right - area.left;
    const ah = area.bottom - area.top;
    const mask = new Uint8Array(aw * ah);
    for (let y = 0; y < ah; y++) {
      for (let x = 0; x < aw; x++) mask[y * aw + x] = labels[(y + area.top) * w + x + area.left] === region.id ? 1 : 0;
    }
    // A box's region is the whole box: the fence fits the area as it is
    const { outside, label, sizes } = cleanHoles({ mask, fence }, aw, ah);
    let filled = region.area;
    for (let i = 1; i < sizes.length; i++) filled += sizes[i];
    if (!options.box && filled > pageW * pageH * 0.2) return { error: "open" };
    // A hole too big or too thick for lettering is a drawing, or a bubble in a panel: it stays
    let keep = sizes.map((size, id) => id > 0 && size <= filled * holeLimit);
    if (!options.box) {
      const depth = cleanDistances(label, aw, ah);
      const thickest = new Float32Array(sizes.length);
      for (let i = 0; i < aw * ah; i++) if (label[i] && depth[i] > thickest[label[i]]) thickest[label[i]] = depth[i];
      const most = Math.max(12, Math.min(pageW, pageH) * 0.04);
      keep = keep.map((on, id) => on && thickest[id] <= most);
    }
    const unknown = new Uint8Array(aw * ah);
    let any = false;
    for (let i = 0; i < aw * ah; i++) {
      if (label[i] && keep[label[i]]) {
        unknown[i] = 1;
        any = true;
      }
    }
    if (!any) return { error: "nothing" };
    // A pixel against the outline or a drawing is partly theirs: it is left as it is, and it
    // doesn't tell the bubble's colour
    const other = (i) => outside[i] === 1 || (label[i] > 0 && !keep[label[i]]);
    const againstOther = (x, y) => {
      for (let ny = Math.max(0, y - 1); ny <= Math.min(ah - 1, y + 1); ny++) {
        for (let nx = Math.max(0, x - 1); nx <= Math.min(aw - 1, x + 1); nx++) if (other(ny * aw + nx)) return true;
      }
      return false;
    };
    // The lettering's soft edge, and the halo a JPEG leaves around it
    const grown = cleanGrow(unknown, aw, ah, margin);
    const near = cleanGrow(unknown, aw, ah, margin + 3);
    for (let y = 0; y < ah; y++) {
      for (let x = 0; x < aw; x++) {
        const i = y * aw + x;
        if (!unknown[i] && mask[i] && grown[i] && !againstOther(x, y)) unknown[i] = 2;
      }
    }
    // A bubble of one colour, JPEG noise aside, gets that colour all over, as TypeR's Auto
    // Clean does: no trace of the letters' halo is left. A shaded one gets its own shades.
    const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    const pageAt = (x, y) => ((y + area.top + win.top) * pageW + x + area.left + win.left) * 4;
    let plainCount = 0;
    for (let y = 0; y < ah; y++) {
      for (let x = 0; x < aw; x++) {
        const i = y * aw + x;
        if (!mask[i] || near[i] || againstOther(x, y)) continue;
        const pi = pageAt(x, y);
        hist[0][data[pi]]++;
        hist[1][data[pi + 1]]++;
        hist[2][data[pi + 2]]++;
        plainCount++;
      }
    }
    const median = hist.map((h) => {
      let seen = 0;
      for (let v = 0; v < 256; v++) {
        seen += h[v];
        if (seen * 2 >= plainCount) return v;
      }
      return 255;
    });
    let flat = false;
    if (plainCount >= 200) {
      const spread = new Uint32Array(256);
      for (let y = 0; y < ah; y++) {
        for (let x = 0; x < aw; x++) {
          const i = y * aw + x;
          if (!mask[i] || near[i] || againstOther(x, y)) continue;
          const pi = pageAt(x, y);
          spread[Math.max(Math.abs(data[pi] - median[0]), Math.abs(data[pi + 1] - median[1]), Math.abs(data[pi + 2] - median[2]))]++;
        }
      }
      let seen = 0;
      let p90 = 255;
      for (let v = 0; v < 256; v++) {
        seen += spread[v];
        if (seen >= plainCount * 0.9) {
          p90 = v;
          break;
        }
      }
      flat = p90 <= 12;
    }
    // A box only cleans what it holds: painting all of it would show its edges
    if (flat && !options.box) {
      for (let y = 0; y < ah; y++) {
        for (let x = 0; x < aw; x++) {
          const i = y * aw + x;
          if (!unknown[i] && mask[i] && !againstOther(x, y)) unknown[i] = 2;
        }
      }
    }
    // Only around what changes, with some of the bubble around it to read the colours from
    let ux0 = aw;
    let uy0 = ah;
    let ux1 = -1;
    let uy1 = -1;
    for (let y = 0; y < ah; y++) {
      for (let x = 0; x < aw; x++) {
        if (!unknown[y * aw + x]) continue;
        if (x < ux0) ux0 = x;
        if (x > ux1) ux1 = x;
        if (y < uy0) uy0 = y;
        if (y > uy1) uy1 = y;
      }
    }
    const pad = flat ? 0 : 12 + margin * 2;
    const cx0 = Math.max(0, ux0 - pad);
    const cy0 = Math.max(0, uy0 - pad);
    const cw = Math.min(aw, ux1 + 1 + pad) - cx0;
    const ch = Math.min(ah, uy1 + 1 + pad) - cy0;
    let colourAt;
    if (flat) colourAt = () => median;
    else {
      const rgb = new Float32Array(cw * ch * 3);
      const known = new Uint8Array(cw * ch);
      let knownCount = 0;
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          const ai = (y + cy0) * aw + x + cx0;
          if (!mask[ai] || near[ai] || againstOther(x + cx0, y + cy0)) continue;
          const pi = pageAt(x + cx0, y + cy0);
          const i = y * cw + x;
          rgb[i * 3] = data[pi];
          rgb[i * 3 + 1] = data[pi + 1];
          rgb[i * 3 + 2] = data[pi + 2];
          known[i] = 1;
          knownCount++;
        }
      }
      if (!knownCount) return { error: "nothing" };
      const colours = cleanInpaint(rgb, known, cw, ch);
      colourAt = (i) => [colours[i * 3], colours[i * 3 + 1], colours[i * 3 + 2]];
    }
    const pixels = new Uint8ClampedArray(cw * ch * 4);
    let painted = 0;
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        if (!unknown[(y + cy0) * aw + x + cx0]) continue;
        const i = y * cw + x;
        const c = colourAt(i);
        pixels[i * 4] = c[0];
        pixels[i * 4 + 1] = c[1];
        pixels[i * 4 + 2] = c[2];
        pixels[i * 4 + 3] = 255;
        painted++;
      }
    }
    return { left: cx0 + area.left + win.left, top: cy0 + area.top + win.top, width: cw, height: ch, pixels, painted, flat, colour: flat ? median : region.seed };
  };

  // The page's clean layer, "TypeR Clean", with one more thing painted on it. It's made the
  // first time, above the page and under the texts, as TypeR does in Photoshop.
  const paintOnCleanLayer = (layers, makeOp) => {
    const clean = layers.find((layer) => layer.clean);
    if (clean) return layers.map((layer) => (layer === clean ? Object.assign({}, layer, { paint: (layer.paint || NONE).concat([makeOp(layer)]) }) : layer));
    const made = newRaster("TypeR Clean", { clean: true });
    made.paint = [makeOp(made)];
    const out = layers.slice();
    out.splice(underTexts(layers), 0, made);
    return out;
  };
  // Where a layer goes to be above the page and under the texts: before the first text, or
  // before the folder holding it
  const underTexts = (layers) => {
    let firstText = layers.findIndex((layer) => layer.kind === "text");
    // A text in a folder: under the whole folder, not among its content
    const rootOf = (layer) => {
      let root = layer;
      while (root && root.group) root = layers.find((item) => item.id === root.group);
      return root;
    };
    if (firstText >= 0 && layers[firstText].group) {
      const root = rootOf(layers[firstText]);
      while (firstText > 0 && rootOf(layers[firstText - 1]) === root) firstText--;
    }
    return firstText < 0 ? layers.length : firstText;
  };

  /* ========================= the application ========================= */

  const app = {
    docs: [],
    doc: null,
    files: new Map(),
    listeners: new Set(),
    panelListeners: {},
    keys: { meta: false, ctrl: false, alt: false, shift: false, key: "" },
    keysSeen: { meta: false, ctrl: false, alt: false, shift: false, key: "" },
    keysMuted: null,
    tool: "wand",
    tolerance: 32,
    cleanTolerance: 32,
    cleanMargin: 6,
    // The Bubble Cleaner's drag: "rectangle", "lasso" or "polygon"
    cleanShape: "rectangle",
    contiguous: true,
    sampleAll: true,
    magicTolerance: 32,
    magicAntiAlias: true,
    magicContiguous: true,
    magicSampleAll: false,
    autoSelect: true,
    selectionMode: "new",
    // The marquees' Style, as Photoshop's: drawn freely ("normal"), to a ratio, or at a size in
    // pixels. Width then height.
    marqueeStyle: "normal",
    marqueeRatio: [1, 1],
    marqueeSize: [64, 64],
    fg: { r: 0, g: 0, b: 0 },
    bg: { r: 255, g: 255, b: 255 },
    brush: { size: 24, hardness: 100 },
    textDefaults: { font: "WildjessNormal", family: "Wildjess", style: "Normal", size: 38, verticalAlign: "center", language: DEFAULT_TEXT_LANGUAGE, ligature: true },
    // The text being typed on the page: { doc, id } (see asTyped)
    typed: null,
    lastAction: 0,
    pendingActions: 0,
    monitor: { lastBounds: null, documentKey: null },
  };

  const emit = (type, detail) => app.listeners.forEach((listener) => listener(type, detail));

  const setDoc = (doc) => {
    if (doc && !app.docs.includes(doc)) app.docs.push(doc);
    // What the Magic Wand read of a page is a whole page, and quick to read again
    if (app.doc && app.doc !== doc) {
      app.doc.sampleCache = null;
      app.doc.sampleKey = null;
    }
    app.doc = doc;
    emit("document", doc);
    emit("render");
    emit("history");
    if (doc) emit("selection", doc.state.selection);
  };

  // What the screen may show that the state doesn't say: a layer being turned, something tried
  // out, a mask shown in red. paintDoc notes on the document that the screen showed it
  // (`looseShown`), until the whole page is drawn again without it. A layer being dragged or
  // painted isn't of them: each step of it says the part of the page it changes, its end too.
  const looseOn = (doc) => Boolean(doc.liveTransform || doc.preview || doc.extra || doc.orderPreview || doc.blendPreview || doc.levels || doc.maskView || (doc.stylePreview && doc.stylePreview.state === doc.state));
  const NO_RECT = { left: 0, top: 0, right: 0, bottom: 0 };
  // The part of the page two states differ in, when the layers alone tell: the same layers in
  // the same order, and those that changed plain ones (no folder, no adjustment, none in a
  // styled folder, which is drawn as one picture) that kept their folder and their place in a
  // clipping mask. Each changes the page where it showed and where it shows, its stroke, shadow
  // and glow included; what is clipped to it shows only there too. Undefined when more can have
  // changed: the whole page then. So on a page of fifty million pixels an arrow key, an undo or
  // a new font redraws a bubble, not the page.
  const changedRect = (doc, before, after) => {
    if (doc.looseShown || looseOn(doc) || doc.live || doc.liveStroke || before.quickMask || after.quickMask) return undefined;
    const was = before.layers;
    const now = after.layers;
    if (was === now) return NO_RECT;
    if (was.length !== now.length) return undefined;
    let box = null;
    let byId = null;
    for (let i = 0; i < now.length; i++) {
      const a = was[i];
      const b = now[i];
      if (a === b) continue;
      if (a.id !== b.id || a.kind !== b.kind || a.kind === "group" || a.adjustment || b.adjustment || Boolean(a.clipping) !== Boolean(b.clipping) || (a.group || null) !== (b.group || null)) return undefined;
      if (b.group) {
        byId = byId || new Map(now.map((layer) => [layer.id, layer]));
        if (nearestStyledOf(b, byId, now)) return undefined;
        // In a hidden folder, nothing of it shows
        if (!chainOf(Object.assign({}, b, { visible: true }), byId).visible) continue;
      }
      for (const layer of [a, b]) {
        if (layer.visible === false) continue;
        const visual = pageVisualOf(layer, doc);
        if (visual && visual.canvas && visual.canvas.width) box = unionOf(box, visualRect(visual));
      }
    }
    return box ? pageRect(doc, box.left, box.top, box.right, box.bottom) : NO_RECT;
  };

  // Gestures that repeat (arrow keys, a slider) make one step of history
  // `rect`, if given, says the part of the page the step changed, once the state is in place;
  // false, that nothing on screen did (a page that isn't in front)
  const commitState = (doc, name, change, coalesce, rect) => {
    // A font only tried out is not part of what is done
    if (doc.stylePreview) endStylePreview(doc);
    const before = doc.state;
    doc.state = Object.assign({}, doc.state, change);
    // The texts of a perspective zone follow it, and what changed of them
    const settled = settleSurfaces(doc, before);
    if (settled) {
      doc.state = Object.assign({}, doc.state, { layers: settled });
      rect = null;
    }
    const last = doc.history[doc.historyIndex];
    if (coalesce && last.coalesce === coalesce && (coalesce.indexOf("gesture:") === 0 || Date.now() - last.time < 1500) && doc.historyIndex === doc.history.length - 1) {
      last.state = doc.state;
      last.time = Date.now();
    } else pushHistory(doc, name, coalesce);
    emit("history");
    // Texts moved by their perspective zone: all the page
    if (rect !== false) emit("render", rect ? rect() : settled ? undefined : changedRect(doc, before, doc.state));
  };
  // Choosing the active layers is not a step of history: the step in place takes them, so an
  // undo after a change keeps the layer the user chose, as in Photoshop, and the next change
  // lands on it. A state still ahead of its step (a stroke under way) lends only its layers'
  // choice, the step's name and saved mark stay.
  const setActiveIds = (doc, ids) => {
    const entry = doc.history[doc.historyIndex];
    const before = doc.state;
    doc.state = Object.assign({}, doc.state, { activeIds: ids });
    if (!entry) return;
    entry.state = entry.state === before ? doc.state : Object.assign({}, entry.state, { activeIds: ids });
  };
  // The part of the page a layer's picture covers
  const visualBounds = (layer, doc) => {
    const visual = layer.kind === "group" ? null : visualOf(layer, doc);
    return visual && visual.canvas && visual.canvas.width ? visualRect(visual) : null;
  };
  const unionRect = (doc, before, after) => (before && after ? pageRect(doc, Math.min(before.left, after.left), Math.min(before.top, after.top), Math.max(before.right, after.right), Math.max(before.bottom, after.bottom)) : undefined);

  // The layers once `ids`' texts have a style changed: see ops.setTextStyle
  const styledTexts = (doc, ids, patch, paragraphPatch, range) => {
    const set = new Set(ids);
    return doc.state.layers.map((layer) => {
      if (!set.has(layer.id) || layer.kind !== "text") return layer;
      const box = boxOf(layer, doc);
      const params = clone(layer.params);
      const lt = params.layerText;
      const patched = (style) => {
        const change = typeof patch === "function" ? patch(style) : patch;
        Object.assign(style, change);
        // Extra Bold goes with Faux Bold
        if (!extraBoldOf(style)) delete style.extraBold;
        // No kerning set by hand: none kept, so the letter joins the style around it
        if (change.kerning === 0) delete style.kerning;
        if (change.size) style.impliedFontSize = change.size;
        if (change.leading) style.impliedLeading = change.leading;
        if (change.baselineShift !== undefined) style.impliedBaselineShift = change.baselineShift;
        return style;
      };
      if (patch && range) {
        const before = lt.textStyleRange;
        const made = new Map();
        const styles = [];
        for (let at = 0; at < lt.textKey.length; at++) {
          const source = (before.find((item) => at >= item.from && at < item.to) || before[before.length - 1]).textStyle;
          if (at < range[0] || at >= range[1]) styles.push(source);
          else {
            if (!made.has(source)) made.set(source, patched(clone(source)));
            styles.push(made.get(source));
          }
        }
        lt.textStyleRange = rangesFromStyles(styles, before[0].textStyle);
      } else if (patch) lt.textStyleRange.forEach((item) => patched(item.textStyle));
      if (paragraphPatch) lt.paragraphStyleRange.forEach((range) => Object.assign(range.paragraphStyle, paragraphPatch));
      const next = Object.assign({}, layer, { params, raster: null });
      if (boxShape(lt)) return patch ? boxFollowsSize(layer, next, doc) : next;
      if (paragraphPatch && paragraphPatch.alignment) return next;
      return centredOn(next, doc, box.xMid, box.yMid);
    });
  };
  // How much bigger a text's letters got, on average over its letters (1 when the same)
  const sizeRatio = (before, after) => {
    const sizeAt = (lt, at) => {
      const ranges = lt.textStyleRange;
      const style = (ranges.find((item) => at >= item.from && at < item.to) || ranges[ranges.length - 1]).textStyle;
      return style.impliedFontSize || style.size || 0;
    };
    const length = Math.min((before.textKey || "").length, (after.textKey || "").length);
    let sum = 0;
    let count = 0;
    for (let at = 0; at < length; at++) {
      const was = sizeAt(before, at);
      if (!(was > 0)) continue;
      sum += sizeAt(after, at) / was;
      count += 1;
    }
    return count ? sum / count : 1;
  };
  // A paragraph text whose letters changed size keeps its lines, as a point text does: unlike in
  // Photoshop, its box grows or shrinks with them, around its middle, instead of the lines
  // breaking again inside it (a word then cut in two) and the text going down past its bubble
  // The sides of a text's box as its lines use them: the one they run along, then the one
  // they follow each other on. A vertical text's lines run down its box.
  const boxSides = (lt) => (verticalOf(lt) ? ["height", "width"] : ["width", "height"]);
  // A box made that much wider or higher around its middle: its anchor is its top left
  // corner, a vertical text's its top right
  const growBox = (lt, shape, side, grow, doc) => {
    shape.box[side] += grow;
    if (side === "height") lt.textClickPoint.vertical -= (grow / 2 / doc.height) * 100;
    else lt.textClickPoint.horizontal += ((verticalOf(lt) ? grow : -grow) / 2 / doc.width) * 100;
  };
  const boxFollowsSize = (base, next, doc) => {
    const ratio = sizeRatio(base.params.layerText, next.params.layerText);
    if (!(ratio > 0) || Math.abs(ratio - 1) < 1e-6) return next;
    const lt = next.params.layerText;
    const shape = boxShape(lt);
    const lines = relativeLayout(base.params.layerText, doc.resolution).lines.length;
    const [along, across] = boxSides(lt);
    const width = shape.box[along] * ratio;
    shape.box[across] = Math.max(1, shape.box[across] * ratio);
    // Letters rounded to a tenth of a point may need a hair more room for the same lines
    for (let attempt = 0; attempt < 4; attempt++) {
      shape.box[along] = Math.max(1, width * (1 + attempt * 0.01) + attempt);
      if (relativeLayout(lt, doc.resolution).lines.length <= lines) break;
    }
    // A text on a perspective surface stays on it
    if (next.warp) return next;
    const [x0, y0] = middleOfText(base, doc);
    const [x1, y1] = middleOfText(next, doc);
    return shifted(next, x0 - x1, y0 - y1, doc);
  };
  // A font only tried out (ops.previewTextStyle) is only drawn (see onPage): the page's state
  // never holds it, so nothing done, kept or saved meanwhile can take it along. Whether there
  // was one on screen.
  const endStylePreview = (doc) => {
    const preview = doc.stylePreview;
    doc.stylePreview = null;
    return Boolean(preview) && preview.state === doc.state;
  };

  const activeTextLayer = (doc = app.doc) => {
    if (!doc) return null;
    const id = doc.state.activeIds[doc.state.activeIds.length - 1];
    return doc.state.layers.find((layer) => layer.id === id && layer.kind === "text") || null;
  };

  const selectedTextLayers = (doc = app.doc) => (doc ? doc.state.layers.filter((layer) => layer.kind === "text" && doc.state.activeIds.includes(layer.id)) : []);

  const replaceLayer = (doc, layer, changes) => doc.state.layers.map((item) => (item.id === layer.id ? Object.assign({}, item, changes) : item));
  // The part of the page a finished stroke changed: where it passed, as each step of it was
  // drawn (a layer's effects too: see settleEffects). All the page when more can change: its
  // stroke, a folder's style around it.
  const strokeEnd = (doc, holder, live) => {
    const box = live.box;
    if (!box || holder.kind === "group" || rasterStrokeOf(holder)) return undefined;
    if (holder.kind !== "quick" && nearestStyledOf(holder, new Map(doc.state.layers.map((item) => [item.id, item])), doc.state.layers)) return undefined;
    return () => box;
  };

  // How long after the last letter typed the panel is told of the text (see ops.setText)
  const TYPING_PAUSE = 400;
  let typingTold = 0;
  const firePanelEvent = (eventID, eventData) => {
    const type = "com.adobe.PhotoshopJSONCallback" + EXTENSION_ID;
    const payload = { eventID };
    if (eventData) payload.eventData = eventData;
    const event = { type, data: "ver1," + JSON.stringify(payload), scope: "APPLICATION", appId: "PHXS", extensionId: EXTENSION_ID };
    (app.panelListeners[type] || []).slice().forEach((entry) => {
      try {
        entry.listener.call(entry.obj || null, event);
      } catch (error) {
        console.error("TypeR demo: panel listener", error);
      }
    });
  };

  // A click made while the panel works waits for the moment the panel listens
  // again: in Photoshop such a click is queued by the application itself
  let waitingSelectionEvent = null;
  const fireWhenIdle = (send) => {
    waitingSelectionEvent = send;
    const attempt = () => {
      if (waitingSelectionEvent !== send) return;
      if (app.pendingActions > 0 || Date.now() - app.lastAction < 460) {
        setTimeout(attempt, 60);
        return;
      }
      waitingSelectionEvent = null;
      send();
    };
    attempt();
  };
  // A paste ends the selection it filled. A click made on the next bubble meanwhile, still
  // waiting for the panel, keeps its own: the panel pastes into it once it hears of it.
  const selectionAfterPaste = (doc) => (waitingSelectionEvent ? doc.state.selection : null);

  const descriptorFor = (selection) => {
    const target = { _ref: [{ _ref: "channel", _property: "selection" }] };
    const px = (value) => ({ _unit: "pixelsUnit", _value: value });
    if (selection.source === "wand") {
      const t = selection.trigger;
      return { null: target, to: { _obj: "paint", horizontal: px(t.x), vertical: px(t.y) }, tolerance: app.tolerance, contiguous: app.contiguous, antiAlias: true, merged: app.sampleAll };
    }
    if (selection.source === "rectangle") {
      const b = selection.bounds;
      return { null: target, to: { _obj: "rectangle", top: px(b.top), left: px(b.left), bottom: px(b.bottom), right: px(b.right) } };
    }
    if (selection.source === "ellipse") {
      const b = selection.bounds;
      return { null: target, to: { _obj: "ellipse", top: px(b.top), left: px(b.left), bottom: px(b.bottom), right: px(b.right) } };
    }
    return { null: target, to: { _obj: "polygon", points: [] } };
  };

  /* ------------------------- user gestures ------------------------- */

  // Is the hyphen at the end of a line part of the word? The script says so when TypeR
  // pasted the text, whatever its case. Otherwise, or when the text no longer has that word:
  // the French words written with one, the Japanese honorifics ("Ryou-chan"), and any hyphen
  // of a text in a language whose words are never cut, as Vietnamese, or one written
  // without Latin or Cyrillic letters.
  const UNCUT_TEXT = /[ăđơưĂĐƠƯ\u1EA0-\u1EF9]/;
  const hyphenKey = (left, right) => `${left}-${(/^[^\s.,;:!?…"”»)\]]*/.exec(right) || [""])[0]}`.toLowerCase();
  // A break between two words of a text written without spaces (see softBreaksOf) took nothing
  // away; one made at a space of such a text took the space, which comes back when the lines
  // are joined: the Line Breaks panel notes it, and so does the script TypeR pasted.
  const spaceKey = (left, right) => " " + hyphenKey(left, right);
  const spaceLost = (left, right, source, cuts) => {
    if (cuts && cuts.includes(spaceKey(left, right))) return true;
    const head = hyphenKey("", right).slice(1, 9);
    return Boolean(source && left && head) && String(source).toLowerCase().includes(`${left.slice(-8).toLowerCase()} ${head}`);
  };
  const realHyphen = (left, right, source, text, cuts) => {
    // The hyphens TypeR added itself, to cut a word in the Line Breaks panel
    if (cuts && cuts.includes(hyphenKey(left, right))) return false;
    if (source) {
      const script = String(source).toLowerCase();
      const word = hyphenKey("", right).slice(1);
      if (script.indexOf(`${left.toLowerCase()}-${word}`) >= 0) return true;
      if (script.indexOf(`${left.toLowerCase()}${word}`) >= 0) return false;
    }
    if (/^(être|ce|ci|là|il|ils|elle|elles|on|je|tu|nous|vous|moi|toi|lui|leur|même|dire|t|y|en|le|la|les)$/i.test(right)) return true;
    if (/^(chan|chin|san|kun|sama|senpai|sempai|sensei|dono|tan|han|nii|nee|niichan|neechan|niisan|neesan|kouhai|kohai)(?!\p{L})/iu.test(right)) return true;
    const all = String(text || "");
    return UNCUT_TEXT.test(all) || !/[A-Za-z\u00C0-\u024F\u0400-\u04FF]/.test(all);
  };

  // The lines of a text as the Line Breaks window sees them: its characters in a row,
  // with no line break and no added hyphen, and the places it breaks
  const lineModel = (layer, doc) => {
    const lt = layer.params.layerText;
    const rows = relativeLayout(lt, doc.resolution).wrapped;
    const base = (lt.textStyleRange && lt.textStyleRange[0] && lt.textStyleRange[0].textStyle) || {};
    const chars = [];
    const breaks = [];
    rows.forEach((runs, index) => {
      // A vertical text's characters say so: they are measured down their line (see lineWidth)
      runs.forEach((run) => lettersOf(run.text).forEach((ch) => chars.push(run.vertical ? { ch, style: run.style, vertical: true } : { ch, style: run.style })));
      if (index === rows.length - 1) return;
      const previous = chars[chars.length - 1];
      if (!previous) return;
      const wordBefore = () => {
        let left = "";
        for (let at = chars.length - 1; at >= 0 && chars[at].ch !== " "; at--) left = chars[at].ch + left;
        return left;
      };
      const following = rows[index + 1].map((run) => run.text).join("");
      if (runs.hyphenated) chars.pop();
      else if (following && breaksBare(previous.ch, lettersOf(following.slice(0, 16))[0])) {
        // Thai and the like: the next line follows with nothing between them, unless the
        // break was made at a space
        if (!runs.bare && spaceLost(wordBefore(), (/^[^\s]*/.exec(following) || [""])[0], layer.source, layer.cuts)) chars.push({ ch: " ", style: previous.style || base });
      } else if (previous.ch === "-") {
        let left = "";
        for (let at = chars.length - 2; at >= 0 && chars[at].ch !== " "; at--) left = chars[at].ch + left;
        const next = rows[index + 1].map((run) => run.text).join("");
        const right = (/^[^\s]*/.exec(next) || [""])[0];
        if (!realHyphen(left, right, layer.source, lt.textKey, layer.cuts)) chars.pop();
      } else if (previous.ch !== " ") chars.push({ ch: " ", style: previous.style || base });
      if (breaks[breaks.length - 1] !== chars.length) breaks.push(chars.length);
    });
    return { chars, breaks };
  };

  // The width of some of those characters, for the window's automatic line counts
  const lineWidth = (chars, doc) => {
    const runs = [];
    chars.forEach((item) => {
      const last = runs[runs.length - 1];
      if (last && last.style === item.style) last.text += item.ch;
      else runs.push(runOf(item.ch, item.style, item));
    });
    return measureRuns(runs, doc.resolution).advance;
  };

  // The layer with these breaks. A space becomes the break; inside a word, a hyphen is
  // added. The text stays where it is in its bubble, and a box grows if a line needs it.
  const layerWithBreaks = (layer, doc, model, breaks) => {
    const set = new Set(breaks);
    const out = [];
    const cuts = [];
    const wordAround = (index, step) => {
      let word = "";
      for (let at = index; at >= 0 && at < model.chars.length && !/\s/.test(model.chars[at].ch); at += step) word = step < 0 ? model.chars[at].ch + word : word + model.chars[at].ch;
      return word;
    };
    // The same, up to the next break: what the line after a break starts with
    const lineStartAt = (index) => {
      let word = "";
      for (let at = index; at < model.chars.length && !/\s/.test(model.chars[at].ch) && !(at > index && set.has(at)); at++) word += model.chars[at].ch;
      return word;
    };
    model.chars.forEach((item, index) => {
      if (set.has(index) && index > 0) {
        const previous = model.chars[index - 1];
        if (previous.ch === " ") {
          out.pop();
          // The space of a text written without spaces is noted, to come back with the lines joined
          if (index > 1 && breaksBare(model.chars[index - 2].ch, item.ch)) cuts.push(spaceKey(wordAround(index - 2, -1), lineStartAt(index)));
        } else if (previous.ch !== "-" && !breaksBare(previous.ch, item.ch)) {
          out.push({ ch: "-", style: previous.style });
          cuts.push(hyphenKey(wordAround(index - 1, -1), wordAround(index, 1)));
        }
        out.push({ ch: "\r", style: previous.style });
      }
      out.push(item);
    });
    const params = clone(layer.params);
    const lt = params.layerText;
    const ranges = [];
    let length = 0;
    out.forEach((item) => {
      const last = ranges[ranges.length - 1];
      if (last && last.textStyle === item.style) last.to = length + item.ch.length;
      else ranges.push({ from: length, to: length + item.ch.length, textStyle: item.style });
      length += item.ch.length;
    });
    lt.textKey = out.map((item) => item.ch).join("");
    lt.textStyleRange = ranges.length ? ranges : lt.textStyleRange;
    lt.paragraphStyleRange.forEach((range) => { range.to = length; });
    const next = Object.assign({}, layer, { params, raster: null, manualBreaks: true, cuts });
    const before = boxOf(layer, doc);
    const shape = boxShape(lt);
    if (!shape) return centredOn(next, doc, before.xMid, before.yMid);
    const [along, across] = boxSides(lt);
    const free = Object.assign({}, lt, { textShape: [{ textType: "point", orientation: shape.orientation }] });
    let widest = 0;
    relativeLayout(free, doc.resolution).lines.forEach((line) => { widest = Math.max(widest, line.m.advance); });
    if (widest + 1 > shape.box[along]) growBox(lt, shape, along, widest + 1 - shape.box[along], doc);
    if (shape.box.autoHeight) return across === "height" ? centredOn(next, doc, boxOf(next, doc).xMid, before.yMid) : centredOn(next, doc, before.xMid, boxOf(next, doc).yMid);
    const needed = relativeLayout(free, doc.resolution).lines.length;
    const full = relativeLayout(Object.assign({}, lt, { textShape: [{ textType: "box", orientation: shape.orientation, box: across === "height" ? { width: shape.box.width, height: 1, autoHeight: true } : { width: 1, height: shape.box.height, autoHeight: true } }] }), doc.resolution);
    if (needed && full.contentHeight > shape.box[across]) shape.box[across] = full.contentHeight;
    return next;
  };

  // Line breaks made by TypeR go away when the text moves into a box: spaces come back,
  // and a hyphen added to break a word goes (the script tells which ones are real)
  const unwrapText = (lt, source) => {
    const text = lt.textKey || "";
    const ranges = lt.textStyleRange || [];
    const styleAt = (index) => {
      const range = ranges.find((item) => index >= item.from && index < item.to) || ranges[ranges.length - 1];
      return range ? range.textStyle : {};
    };
    const chars = [];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch !== "\r" && ch !== "\n") {
        chars.push({ ch, style: styleAt(i) });
        continue;
      }
      const previous = chars[chars.length - 1];
      if (previous && previous.ch === "-") {
        let left = "";
        for (let at = chars.length - 2; at >= 0 && /[^\s]/.test(chars[at].ch); at--) left = chars[at].ch + left;
        const right = (/^[^\s]*/.exec(text.slice(i + 1)) || [""])[0];
        if (!realHyphen(left, right, source, text)) chars.pop();
        continue;
      }
      // Between two characters of a text written without spaces, a line broke with nothing
      // taken away: joined again, nothing is put back, unless the script had a space there
      const after = text.slice(i + 1);
      if (previous && after && breaksBare(previous.ch, String.fromCodePoint(after.codePointAt(0)))) {
        let left = "";
        for (let at = chars.length - 1; at >= 0 && /[^\s]/.test(chars[at].ch); at--) left = chars[at].ch + left;
        if (!spaceLost(left, (/^[^\s]*/.exec(after) || [""])[0], source)) continue;
      }
      chars.push({ ch: " ", style: styleAt(i) });
    }
    const out = [];
    chars.forEach((item, index) => {
      const last = out[out.length - 1];
      if (last && last.textStyle === item.style) last.to = index + 1;
      else out.push({ from: index, to: index + 1, textStyle: item.style });
    });
    lt.textKey = chars.map((item) => item.ch).join("");
    lt.textStyleRange = out.length ? out : [{ from: 0, to: 0, textStyle: ranges[0] ? ranges[0].textStyle : {} }];
    lt.paragraphStyleRange.forEach((range) => { range.to = lt.textKey.length; });
  };

  // A layer moved by (dx, dy): its anchor, and Photoshop's pixels if it still shows them
  // `all`: the whole page moved, unlinked masks with it
  const shifted = (layer, dx, dy, doc, all) => {
    if (layer.kind === "text") {
      const params = clone(layer.params);
      params.layerText.textClickPoint.horizontal += (dx / doc.width) * 100;
      params.layerText.textClickPoint.vertical += (dy / doc.height) * 100;
      const moved = Object.assign({}, layer, { params });
      if (layer.warp) moved.warp = Object.assign({}, layer.warp, { corners: layer.warp.corners.map(([x, y]) => [x + dx, y + dy]) });
      if (layer.raster) moved.raster = Object.assign({}, layer.raster, { left: layer.raster.left + dx, top: layer.raster.top + dy });
      return Object.assign(moved, movedMasks(layer, dx, dy, all));
    }
    if (layer.kind === "raster") return Object.assign({}, layer, { dx: (layer.dx || 0) + dx, dy: (layer.dy || 0) + dy }, movedMasks(layer, dx, dy, all));
    if (layer.mask || layer.vectorMask) return Object.assign({}, layer, movedMasks(layer, dx, dy, all));
    return layer;
  };

  // A text at `factor` times its size: its letters, its leading and its box. The size of the
  // last run comes with it.
  const grownText = (base, factor) => {
    const params = clone(base.params);
    const lt = params.layerText;
    let size = 0;
    lt.textStyleRange.forEach((range) => {
      const style = range.textStyle;
      style.size = Math.max(1, Math.round((style.impliedFontSize || style.size || 14) * factor * 10) / 10);
      style.impliedFontSize = style.size;
      if (style.leading) style.leading = Math.round(style.leading * factor * 10) / 10;
      if (style.impliedLeading) style.impliedLeading = style.leading;
      size = style.size;
    });
    const shape = boxShape(lt);
    if (shape) {
      shape.box.width = Math.max(1, shape.box.width * factor);
      shape.box.height = Math.max(1, shape.box.height * factor);
    }
    return { next: Object.assign({}, base, { params, raster: null }), size };
  };
  // The middle of a text's frame as it shows, turned or not
  const middleOfText = (layer, doc) => {
    if (layer.rotated && !layer.warp) return turnedFrame(layer, doc).center;
    const f = frameOf(layer, doc);
    return [f.left + f.width / 2, f.top + f.height / 2];
  };
  // A text turned by `delta` radians around `pivot`. In perspective, its surface turns: the
  // corners go round the pivot, the bends with them.
  const turnedText = (base, delta, pivot, doc) => {
    const cos = Math.cos(delta);
    const sin = Math.sin(delta);
    if (base.warp) {
      const round = ([x, y]) => [pivot[0] + cos * (x - pivot[0]) - sin * (y - pivot[1]), pivot[1] + sin * (x - pivot[0]) + cos * (y - pivot[1])];
      const spun = ([x, y]) => [cos * x - sin * y, sin * x + cos * y];
      // Turned on a perspective zone, it stops following the zone: its surface is its own
      return Object.assign({}, base, base.warp.auto ? { offSurface: true } : null, { warp: Object.assign({}, base.warp, { corners: base.warp.corners.map(round), bendTop: spun(base.warp.bendTop), bendBottom: spun(base.warp.bendBottom), auto: undefined }) });
    }
    const [a, b, c, d] = spinOf(base) || [1, 0, 0, 1];
    const clean = (value) => (Math.abs(value) < 1e-9 ? 0 : Math.abs(Math.abs(value) - 1) < 1e-9 ? Math.sign(value) : value);
    const spin = [cos * a - sin * b, sin * a + cos * b, cos * c - sin * d, sin * c + cos * d].map(clean);
    const straight = spin[0] === 1 && spin[1] === 0 && spin[2] === 0 && spin[3] === 1;
    // The anchor goes round the pivot: the turn is drawn around it
    const [ax, ay] = anchorOf(base.params.layerText, doc);
    const ux = ax - pivot[0];
    const uy = ay - pivot[1];
    const nx = pivot[0] + cos * ux - sin * uy;
    const ny = pivot[1] + sin * ux + cos * uy;
    const next = Object.assign({}, base, { rotated: !straight, spin: straight ? null : spin, raster: null });
    return shifted(next, nx - ax, ny - ay, doc);
  };

  // A text under Free Transform stays a text. On a surface, the surface follows the transform.
  // Otherwise it grows, stretches and turns as the frame did, and its middle goes where the frame
  // takes it. A flat text isn't mirrored: flipped, it still reads the right way.
  const transformedText = (layer, matrix, doc) => {
    const [a, b, c, d, e, f] = matrix;
    const map = ([x, y]) => [a * x + c * y + e, b * x + d * y + f];
    if (layer.warp) {
      const linear = ([x, y]) => [a * x + c * y, b * x + d * y];
      const { auto } = layer.warp;
      // On a perspective zone: made larger or smaller, it stays on the zone at that size;
      // turned, skewed or mirrored, its surface is its own from then on
      const straight = Boolean(auto) && Math.abs(b) < 1e-9 && Math.abs(c) < 1e-9 && a > 0 && d > 0;
      return Object.assign({}, layer, auto && !straight ? { offSurface: true } : null, { raster: null, warp: Object.assign({}, layer.warp, { corners: layer.warp.corners.map(map), bendTop: linear(layer.warp.bendTop), bendBottom: linear(layer.warp.bendBottom), auto: straight ? [auto[0] * a, auto[1] * d] : undefined }) });
    }
    // Skewed, or a skewed text: the text's own frame goes where the transform takes it
    const own = spinOf(layer);
    const whole = own ? [a * own[0] + c * own[1], b * own[0] + d * own[1], a * own[2] + c * own[3], b * own[2] + d * own[3]] : [a, b, c, d];
    if (skewedSpin(whole)) return skewedText(layer, whole, map(middleOfText(layer, doc)), doc);
    // Its own frame, as it now is: stretched along its own sides, turned
    const [wa, wb, wc, wd] = whole;
    const sx = Math.hypot(wa, wb);
    const sy = Math.hypot(wc, wd);
    if (sx < 1e-6 || sy < 1e-6) return layer;
    // Flipped, the turn is the one that leaves the text the most upright
    const turns = [Math.atan2(wb, wa), Math.atan2(-wc, wd)];
    const tilt = (angle) => Math.abs(Math.atan2(Math.sin(angle), Math.cos(angle)));
    const turn = wa * wd - wb * wc < 0 ? (tilt(turns[1]) < tilt(turns[0]) ? turns[1] : turns[0]) : turns[0];
    const to = map(middleOfText(layer, doc));
    // A skewed text made square again: straight, then turned as far as its frame now is
    const unskewed = own && skewedSpin(own) ? Object.assign({}, layer, { rotated: false, spin: null }) : layer;
    const already = unskewed === layer ? turnOf(layer) : 0;
    // Only turned or moved, its size isn't touched, not even rounded
    let next = Math.abs(sy - 1) > 1e-6 ? grownText(unskewed, sy).next : Object.assign({}, unskewed, { params: clone(layer.params), raster: null });
    const ratio = sx / sy;
    if (Math.abs(ratio - 1) > 0.005) {
      const lt = next.params.layerText;
      lt.textStyleRange.forEach(({ textStyle }) => {
        textStyle.horizontalScale = Math.round((textStyle.horizontalScale === undefined ? 100 : textStyle.horizontalScale) * ratio * 100) / 100;
      });
      const shape = boxShape(lt);
      if (shape) shape.box.width = Math.max(1, shape.box.width * ratio);
    }
    if (Math.abs(turn - already) > 1e-9) next = turnedText(next, turn - already, middleOfText(next, doc), doc);
    const now = middleOfText(next, doc);
    return shifted(next, to[0] - now[0], to[1] - now[1], doc);
  };
  // A text whose own frame goes through `whole` (from its straight letters to the page, its
  // size aside), its middle landing on `to`. As Photoshop keeps a skewed text: its size is the
  // one Photoshop shows, measured along its frame's side (its transform's yx, yy), the rest is
  // its skew, kept in `spin`. Flipped, it still reads the right way: its letters are turned
  // back along whichever side leaves them the most upright.
  const skewedText = (layer, whole, to, doc) => {
    let spin = whole.slice(0, 4);
    if (spin[0] * spin[3] - spin[1] * spin[2] < 0) {
      const alongX = [-spin[0], -spin[1], spin[2], spin[3]];
      const alongY = [spin[0], spin[1], -spin[2], -spin[3]];
      const tilt = (m) => Math.abs(Math.atan2(m[1], m[0]));
      spin = tilt(alongX) <= tilt(alongY) ? alongX : alongY;
    }
    const factor = Math.hypot(spin[2], spin[3]);
    if (!(factor > 1e-6)) return layer;
    let next = Object.assign({}, layer, { params: clone(layer.params), raster: null });
    if (Math.abs(factor - 1) > 1e-6) {
      // Its letters are rounded to a tenth: the skew takes what the rounding left
      const before = lastSize(layer);
      next = grownText(layer, factor).next;
      const grown = before > 0 ? lastSize(next) / before : factor;
      spin = spin.map((value) => value / grown);
    }
    const clean = (value) => (Math.abs(value) < 1e-12 ? 0 : value);
    next = Object.assign(next, { rotated: true, spin: spin.map(clean) });
    const now = middleOfText(next, doc);
    return shifted(next, to[0] - now[0], to[1] - now[1], doc);
  };

  // A text's parameters at `ratio` times its size: every run, a fixed leading and a box's frame
  // follow, as when its size is typed for the whole layer
  const scaledTextParams = (source, ratio) => {
    const params = clone(source);
    const lt = params.layerText;
    lt.textStyleRange.forEach((range) => {
      const style = range.textStyle;
      style.size = Math.max(0.1, (style.impliedFontSize || style.size) * ratio);
      if (style.impliedFontSize != null) style.impliedFontSize = style.size;
      if (style.autoLeading || style.leading == null) return;
      style.leading = Math.max(0.1, (style.impliedLeading || style.leading) * ratio);
      if (style.impliedLeading != null) style.impliedLeading = style.leading;
    });
    const shape = boxShape(lt);
    if (shape) {
      shape.box.width = Math.max(1, shape.box.width * ratio);
      shape.box.height = Math.max(1, shape.box.height * ratio);
    }
    return params;
  };

  const centredOn = (layer, doc, x, y) => {
    // A text on a surface stays there: the surface is what sets its place
    if (layer.warp) return layer;
    const box = boxOf(layer, doc);
    return shifted(layer, x - box.xMid, y - box.yMid, doc);
  };

  // A layer and everything inside it, if it is a folder
  const familyOf = (layers, id) => {
    const out = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      layers.forEach((layer) => {
        if (layer.group && out.has(layer.group) && !out.has(layer.id)) {
          out.add(layer.id);
          grew = true;
        }
      });
    }
    return out;
  };

  // Photoshop's locks: `locked` is Lock All, `locks` holds the others (transparency, pixels,
  // position), which Lock All takes in
  const lockOf = (layer, kind) => Boolean(layer && (layer.locked || (layer.locks && layer.locks[kind])));
  // Linked layers (Photoshop's Link Layers) move with each other
  const withLinked = (layers, ids) => {
    const links = new Set();
    layers.forEach((layer) => { if (layer.link && ids.includes(layer.id)) links.add(layer.link); });
    return links.size ? ids.concat(layers.filter((layer) => layer.link && links.has(layer.link) && !ids.includes(layer.id)).map((layer) => layer.id)) : ids;
  };
  // Where layers land when moved (or copied) beside, above, below or into another: the new
  // list and what becomes active, or null when nothing would move
  const reorderPlan = (all, ids, targetId, position, copy) => {
    const byId = new Map(all.map((layer) => [layer.id, layer]));
    const insideChosen = (layer) => {
      for (let up = layer.group; up && byId.get(up); up = byId.get(up).group) if (ids.includes(up)) return true;
      return false;
    };
    // The Background stays where it is, and a layer goes with its chosen folder
    const chosen = ids.filter((id) => byId.get(id) && (copy || !byId.get(id).isBackground) && !insideChosen(byId.get(id)));
    if (!chosen.length) return null;
    const family = new Set();
    chosen.forEach((id) => familyOf(all, id).forEach((member) => family.add(member)));
    if (!copy && family.has(targetId)) return null;
    const moved = all.filter((layer) => family.has(layer.id));
    const rest = copy ? all.slice() : all.filter((layer) => !family.has(layer.id));
    const target = rest.find((layer) => layer.id === targetId);
    if (!target) return null;
    let at = rest.indexOf(target);
    let parent = target.group || null;
    if (position === "inside" && target.kind === "group") parent = target.id;
    else if (position === "above") at += 1;
    else if (target.kind === "group") {
      // Below a folder: under everything it holds
      const members = familyOf(rest, target.id);
      at = rest.findIndex((layer) => members.has(layer.id));
    }
    // Nothing goes under the Background
    if (rest[0] && rest[0].isBackground && at < 1) {
      at = 1;
      parent = null;
    }
    // Dropped inside a clipping mask, a layer joins it; a clipped one dropped outside its
    // own is let go, as in Photoshop. A base moved with its clipped layers keeps them.
    const same = (layer) => Boolean(layer) && (layer.group || null) === parent && layer.kind !== "group";
    const above = rest[at];
    const intoClip = same(above) && Boolean(above.clipping);
    const siblingBelow = (layer) => {
      for (let index = all.indexOf(layer) - 1; index >= 0; index--) if ((all[index].group || null) === (layer.group || null)) return all[index];
      return null;
    };
    let below = rest[at - 1];
    let belowOriginal = null;
    const placed = moved.map((layer) => {
      if (family.has(layer.group)) return layer;
      const block = Boolean(belowOriginal) && siblingBelow(layer) === belowOriginal;
      const clipping = layer.kind !== "group" && (intoClip || (Boolean(layer.clipping) && (block || (same(below) && Boolean(below.clipping)))));
      const next = Object.assign({}, layer, { group: parent, isBackground: false, clipping });
      below = next;
      belowOriginal = layer;
      return next;
    });
    if (!copy) {
      const layers = rest.slice(0, at).concat(placed, rest.slice(at));
      return layers.every((layer, index) => layer === all[index]) ? null : { layers, activeIds: null };
    }
    const fresh = new Map(placed.map((layer) => [layer.id, newId()]));
    const copies = placed.map((layer) => Object.assign({}, layer, {
      id: fresh.get(layer.id),
      group: fresh.get(layer.group) || layer.group,
      name: chosen.includes(layer.id) ? `${layer.name} copy` : layer.name,
      clean: false,
      link: undefined,
      raw: layer.raw ? Object.assign({}, layer.raw) : undefined,
    }));
    return { layers: rest.slice(0, at).concat(copies, rest.slice(at)), activeIds: chosen.map((id) => fresh.get(id)) };
  };

  // What a move takes along: linked layers, a folder's layers, and what is clipped to a layer that
  // moves, as a gradient on a text: it is part of how the text looks, and stays on its letters
  const movableIds = (doc, ids) => {
    const out = new Set();
    withLinked(doc.state.layers, ids).forEach((id) => familyOf(doc.state.layers, id).forEach((member) => out.add(member)));
    const clip = clippingOf(doc.state.layers);
    clip.baseOf.forEach((base, id) => { if (out.has(base.id)) out.add(id); });
    return Array.from(out).filter((id) => {
      const layer = doc.state.layers.find((item) => item.id === id);
      return layer && !lockOf(layer, "position") && !layer.isBackground && layer.kind !== "group";
    });
  };

  // The page changed size: what depends on it starts over, and it shows whole if it changed shape
  const sizeChanged = (doc, before) => {
    doc.sampleCache = null;
    doc.sampleKey = "";
    doc.preview = null;
    if (doc.width !== before.width || doc.height !== before.height) {
      doc.view.fitted = true;
      doc.view.seen = false;
    }
    emit("document", doc);
    emit("selection", doc.state.selection);
  };

  // `place`: where a point of the page goes, for the work path, which follows the page
  const resizeDoc = (doc, name, size, layers, change, place) => {
    if (place && doc.state.workPath) change = Object.assign({}, change, { workPath: mappedVector(doc.state.workPath, place) });
    const before = sizeOf(doc);
    // History from before sizes were kept, in a document from an older session
    doc.history.forEach((entry) => { if (!entry.size) entry.size = before; });
    Object.assign(doc, size);
    commitState(doc, name, Object.assign({ layers, selection: null, lastSelection: null }, change));
    sizeChanged(doc, before);
    firePanelEvent(EVENT_HISTORY);
  };

  // A layer's new pixels replace what it had, painted things included, in Photoshop's file too
  const withPixels = (layer, bitmap, left, top, mask) => {
    const next = Object.assign({}, layer, { bitmap, left, top, dx: 0, dy: 0, paint: NONE, mask });
    if (layer.vectorMask) next.vectorMask = shiftedVector(layer.vectorMask, layer.dx || 0, layer.dy || 0);
    if (layer.raw) {
      next.raw = Object.assign({}, layer.raw, { canvas: bitmap, left, top, right: left + bitmap.width, bottom: top + bitmap.height });
      if (mask) next.raw.mask = mask;
      else if (layer.mask) delete next.raw.mask;
    }
    return next;
  };

  // A picture at (x, y) of the page, as it lands on the scaled page. Its edges stay where they
  // fall, between pixels too, so that the layers keep lining up.
  const scaledPixels = (source, x, y, sx, sy) => {
    const left = Math.floor(x * sx + 1e-6);
    const top = Math.floor(y * sy + 1e-6);
    const canvas = newCanvas(Math.ceil((x + source.width) * sx - 1e-6) - left, Math.ceil((y + source.height) * sy - 1e-6) - top);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, x * sx - left, y * sy - top, source.width * sx, source.height * sy);
    return { canvas, left, top };
  };

  const scaledRaster = (layer, doc, sx, sy) => {
    const masks = scaledMasks(layer, doc, sx, sy);
    const visual = visualOf(Object.assign({}, layer, { mask: null, vectorMask: null }), doc);
    if (!visual) return layer.mask || layer.vectorMask ? Object.assign({}, layer, masks, { dx: 0, dy: 0 }) : layer;
    const p = scaledPixels(visual.canvas, visual.x, visual.y, sx, sy);
    return Object.assign(withPixels(layer, p.canvas, p.left, p.top, masks.mask || null), masks.vectorMask ? { vectorMask: masks.vectorMask } : null);
  };

  // Where a pixel layer really has pixels, without its mask. A painted layer's picture covers
  // the whole page, whatever is on it. Null for a layer with nothing on it.
  const trimmedBoxes = new WeakMap();
  // A pixel's alpha, in the number its four bytes make on this machine
  const ALPHA_BITS = new Uint8Array(new Uint32Array([0xff000000]).buffer)[3] ? 0xff000000 : 0xff;
  // Does a picture reach its four sides? Most layers do (a page's art, a layer as its file
  // cut it), and its sides alone tell: a few thousand pixels read, not the fifty million of a
  // large page.
  let sideRows = null;
  let sideColumns = null;
  const fillsItsPicture = (canvas) => {
    const { width, height } = canvas;
    const strip = (kept, w, h) => {
      const made = kept && kept.width >= w && kept.height >= h ? kept : newCanvas(w, h);
      const ctx = made.getContext("2d", { willReadFrequently: true });
      ctx.globalCompositeOperation = "copy";
      ctx.imageSmoothingEnabled = false;
      return made;
    };
    const shows = (ctx, w, h) => {
      const px = new Uint32Array(ctx.getImageData(0, 0, w, h).data.buffer);
      for (let i = 0; i < px.length; i++) if (px[i] & ALPHA_BITS) return true;
      return false;
    };
    sideRows = strip(sideRows, width, 1);
    sideColumns = strip(sideColumns, 1, height);
    const rows = sideRows.getContext("2d");
    const columns = sideColumns.getContext("2d");
    for (const y of [0, height - 1]) {
      rows.drawImage(canvas, 0, y, width, 1, 0, 0, width, 1);
      if (!shows(rows, width, 1)) return false;
    }
    for (const x of [0, width - 1]) {
      columns.drawImage(canvas, x, 0, 1, height, 0, 0, 1, height);
      if (!shows(columns, 1, height)) return false;
    }
    return true;
  };
  const trimmedBox = (layer, doc) => {
    const visual = visualOf(Object.assign({}, layer, { mask: null }), doc);
    if (!visual) return null;
    const dx = layer.dx || 0;
    const dy = layer.dy || 0;
    const key = layer.paint && layer.paint.length ? layer.paint : layer.bitmap;
    let box = trimmedBoxes.get(key);
    if (box === undefined) {
      const { width, height } = visual.canvas;
      let left = width;
      let top = 0;
      let right = 0;
      let bottom = height;
      if (fillsItsPicture(visual.canvas)) {
        left = 0;
        right = width;
      } else {
        // From the edges inwards, a pixel at a time as one number
        const px = new Uint32Array(visual.canvas.getContext("2d").getImageData(0, 0, width, height).data.buffer);
        const rowHas = (y) => {
          for (let i = y * width, end = i + width; i < end; i++) if (px[i] & ALPHA_BITS) return true;
          return false;
        };
        while (top < height && !rowHas(top)) top++;
        if (top === height) bottom = top;
        else while (!rowHas(bottom - 1)) bottom--;
        for (let y = top; y < bottom && (left > 0 || right < width); y++) {
          const row = y * width;
          for (let x = 0; x < left; x++) if (px[row + x] & ALPHA_BITS) left = x;
          for (let x = width - 1; x >= right; x--) if (px[row + x] & ALPHA_BITS) right = x + 1;
        }
      }
      const ox = visual.x - dx;
      const oy = visual.y - dy;
      box = right ? { left: left + ox, top: top + oy, right: right + ox, bottom: bottom + oy } : null;
      trimmedBoxes.set(key, box);
    }
    return box && rectFrom(box.left + dx, box.top + dy, box.right + dx, box.bottom + dy);
  };

  // A part of a picture at (x, y) of the page, through a matrix, on a canvas just big enough
  const transformedPixels = (source, x, y, part, matrix, fill) => {
    const [a, b, c, d, e, f] = matrix;
    const xs = [part.left, part.right, part.right, part.left].map((px, i) => a * px + c * (i < 2 ? part.top : part.bottom) + e);
    const ys = [part.left, part.right, part.right, part.left].map((px, i) => b * px + d * (i < 2 ? part.top : part.bottom) + f);
    const left = Math.floor(Math.min(...xs) + 1e-6);
    const top = Math.floor(Math.min(...ys) + 1e-6);
    const canvas = newCanvas(Math.ceil(Math.max(...xs) - 1e-6) - left, Math.ceil(Math.max(...ys) - 1e-6) - top);
    const ctx = canvas.getContext("2d");
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.imageSmoothingQuality = "high";
    ctx.setTransform(a, b, c, d, e - left, f - top);
    const width = part.right - part.left;
    const height = part.bottom - part.top;
    ctx.drawImage(source, part.left - x, part.top - y, width, height, part.left, part.top, width, height);
    return { canvas, left, top };
  };

  // What a Clone Stamp stroke paints from: the page as it is when the stroke starts, so that it
  // never clones what it has just painted. Places are the page's.
  const cloneSource = (doc, layer, sample) => {
    if (sample === "current") {
      const visual = visualOf(layer, doc);
      if (!visual) return { canvas: newCanvas(1, 1), x: 0, y: 0 };
      const canvas = newCanvas(visual.canvas.width, visual.canvas.height);
      canvas.getContext("2d").drawImage(visual.canvas, 0, 0);
      return { canvas, x: visual.x, y: visual.y };
    }
    const canvas = newCanvas(doc.width, doc.height);
    const at = doc.state.layers.indexOf(layer);
    paintDoc(doc, canvas.getContext("2d"), { keep: true, skip: sample === "below" ? (item) => doc.state.layers.indexOf(item) > at : null });
    return { canvas, x: 0, y: 0 };
  };
  // A stroke only needs what is under it: a whole page for each one would fill the memory
  const cropCloneSource = (op) => {
    const reach = op.size / 2 + 2;
    const xs = op.points.map((p) => p[0]);
    const ys = op.points.map((p) => p[1]);
    const left = Math.floor(Math.min(...xs) - reach);
    const top = Math.floor(Math.min(...ys) - reach);
    const canvas = newCanvas(Math.ceil(Math.max(...xs) + reach) - left, Math.ceil(Math.max(...ys) + reach) - top);
    canvas.getContext("2d").drawImage(op.source.canvas, op.source.x - left, op.source.y - top);
    op.source = { canvas, x: left, y: top };
  };

  const TEXT_LENGTHS = ["size", "impliedFontSize", "leading", "impliedLeading", "baselineShift", "impliedBaselineShift"];
  // What a text is made of, for the same text in another document: its anchor, in parts of the
  // page, and its sizes in points, so that it is as large in pixels where the two documents
  // don't have the same resolution
  const textParamsIn = (layer, from, to) => {
    const params = from.resolution === to.resolution ? clone(layer.params) : scaledText(layer, 1, 1, from.resolution / to.resolution).params;
    const point = params.layerText.textClickPoint;
    point.horizontal = ((point.horizontal / 100) * from.width / to.width) * 100;
    point.vertical = ((point.vertical / 100) * from.height / to.height) * 100;
    return params;
  };

  // points: what a size in points is multiplied by, the page's resolution being part of it
  const scaledText = (layer, sx, sy, points) => {
    const params = clone(layer.params);
    const lt = params.layerText;
    const stretched = Math.abs(sx / sy - 1) > 0.005;
    lt.textStyleRange.forEach(({ textStyle }) => {
      TEXT_LENGTHS.forEach((field) => {
        if (typeof textStyle[field] === "number") textStyle[field] = Math.round(textStyle[field] * points * 1000) / 1000;
      });
      if (stretched) textStyle.horizontalScale = Math.round((textStyle.horizontalScale === undefined ? 100 : textStyle.horizontalScale) * (sx / sy) * 100) / 100;
    });
    const next = Object.assign({}, layer, { params });
    if (sx === 1 && sy === 1) return next;
    const shape = boxShape(lt);
    if (shape) {
      shape.box.width = Math.max(1, shape.box.width * sx);
      shape.box.height = Math.max(1, shape.box.height * sy);
    }
    if (layer.stroke) {
      next.stroke = Object.assign({}, layer.stroke, { size: Math.round(layer.stroke.size * sy * 100) / 100 });
      if (layer.stroke.outer) next.stroke.outer = Object.assign({}, layer.stroke.outer, { size: Math.round(layer.stroke.outer.size * sy * 100) / 100 });
    }
    // Its effects' sizes and distances, as the stroke's
    if (layer.effects) {
      next.effects = {};
      Object.keys(layer.effects).forEach((name) => {
        const effect = layer.effects[name];
        next.effects[name] = effect && typeof effect === "object" ? Object.assign({}, effect) : effect;
        ["size", "distance"].forEach((field) => {
          if (effect && typeof effect[field] === "number") next.effects[name][field] = Math.round(effect[field] * sy * 100) / 100;
        });
      });
    }
    if (layer.warp) {
      const { source, corners, bendTop, bendBottom } = layer.warp;
      const scaled = ([x, y]) => [x * sx, y * sy];
      next.warp = Object.assign({}, layer.warp, {
        source: { left: source.left * sx, top: source.top * sy, width: source.width * sx, height: source.height * sy },
        corners: corners.map(scaled),
        bendTop: scaled(bendTop),
        bendBottom: scaled(bendBottom),
      });
    }
    const { raster, raw } = layer;
    if (raster) {
      // Photoshop's pixels stay, scaled, and Photoshop's text follows them in the file
      const p = scaledPixels(raster.bitmap, raster.left, raster.top, sx, sy);
      next.raster = Object.assign({}, raster, { bitmap: p.canvas, left: p.left, top: p.top });
      if (raster.display) {
        const d = scaledPixels(raster.display, raster.left + (raster.displayLeft || 0), raster.top + (raster.displayTop || 0), sx, sy);
        Object.assign(next.raster, { display: d.canvas, displayLeft: d.left - p.left, displayTop: d.top - p.top });
      }
      if (raw && raw.text) {
        const t = raw.text.transform || [1, 0, 0, 1, 0, 0];
        const x = t[4] + raster.left - (raw.left || 0);
        const y = t[5] + raster.top - (raw.top || 0);
        next.raw = Object.assign({}, raw, { left: p.left, top: p.top, text: Object.assign({}, raw.text, { transform: [t[0] * sx, t[1] * sy, t[2] * sx, t[3] * sy, x * sx, y * sy] }) });
        if (raw.effects && raw.effects.stroke) {
          next.raw.effects = Object.assign({}, raw.effects, { stroke: raw.effects.stroke.map((stroke) => Object.assign({}, stroke, { size: Object.assign({}, stroke.size, { value: stroke.size.value * sy }) })) });
        }
      }
    }
    return next;
  };

  // The layers of a page that changes size, with what it had moved by (ox, oy). Layers keep
  // what goes off the page; the Background, which has nothing outside it, gets cut or filled.
  const onNewCanvas = (doc, width, height, ox, oy, fill) => doc.state.layers.map((layer) => {
    if (layer.isBackground) {
      const visual = visualOf(layer, doc);
      const bitmap = newCanvas(width, height);
      const ctx = bitmap.getContext("2d");
      ctx.fillStyle = fill;
      ctx.fillRect(0, 0, width, height);
      ctx.clearRect(ox, oy, doc.width, doc.height);
      if (visual) ctx.drawImage(visual.canvas, visual.x + ox, visual.y + oy);
      return withPixels(layer, bitmap, 0, 0, null);
    }
    if (layer.kind !== "text") return shifted(layer, ox, oy, doc, true);
    // An anchor is a share of the page: the same place is another share of a new page
    const params = clone(layer.params);
    params.layerText.textClickPoint.horizontal *= doc.width / width;
    params.layerText.textClickPoint.vertical *= doc.height / height;
    return shifted(Object.assign({}, layer, { params }), ox, oy, { width, height }, true);
  });

  const pageRect = (doc, left, top, right, bottom) => ({
    left: Math.max(0, Math.floor(left)),
    top: Math.max(0, Math.floor(top)),
    right: Math.min(doc.width, Math.ceil(right)),
    bottom: Math.min(doc.height, Math.ceil(bottom)),
  });
  // Where what is being dragged shows right now
  const liveBounds = (doc) => {
    const { ids, dx, dy } = doc.live;
    let box = null;
    doc.state.layers.forEach((layer) => {
      if (!ids.has(layer.id) || layer.kind === "group") return;
      const visual = visualOf(layer, doc);
      if (!visual) return;
      const area = visualRect(visual);
      const left = area.left + Math.round(dx);
      const top = area.top + Math.round(dy);
      const right = area.right + Math.round(dx);
      const bottom = area.bottom + Math.round(dy);
      box = box ? { left: Math.min(box.left, left), top: Math.min(box.top, top), right: Math.max(box.right, right), bottom: Math.max(box.bottom, bottom) } : { left, top, right, bottom };
    });
    return box;
  };

  // Where what is being transformed shows right now, with room for the smoothing of its edges.
  // Null when it can't be told from the layers' pictures: one of them in a styled folder,
  // drawn with it as one picture.
  const turnedArea = (doc, { ids, matrix }) => {
    const layers = doc.state.layers;
    const byId = new Map(layers.map((layer) => [layer.id, layer]));
    const [a, b, c, d, e, f] = matrix;
    let box = null;
    for (const layer of layers) {
      if (!ids.has(layer.id) || layer.kind === "group") continue;
      if (nearestStyledOf(layer, byId, layers)) return null;
      const visual = pageVisualOf(layer, doc);
      if (!visual || !visual.canvas || !visual.canvas.width) continue;
      const area = visualRect(visual);
      [[area.left, area.top], [area.right, area.top], [area.right, area.bottom], [area.left, area.bottom]].forEach(([x, y]) => {
        const px = a * x + c * y + e;
        const py = b * x + d * y + f;
        box = box ? { left: Math.min(box.left, px), top: Math.min(box.top, py), right: Math.max(box.right, px), bottom: Math.max(box.bottom, py) } : { left: px, top: py, right: px, bottom: py };
      });
    }
    return box && { left: box.left - 2, top: box.top - 2, right: box.right + 2, bottom: box.bottom + 2 };
  };

  // Levels on the selected part of the layer's picture, from the pixels it had at the start
  const levelsPaint = (session, tables) => {
    const { source, output, box, inside, ctx } = session;
    const src = source.data;
    const out = output.data;
    const width = source.width;
    const bw = box.right - box.left;
    const [red, green, blue] = tables || [];
    for (let y = box.top; y < box.bottom; y++) {
      let i = (y * width + box.left) * 4;
      let k = (y - box.top) * bw;
      for (let x = box.left; x < box.right; x++, i += 4, k++) {
        if (inside && !inside[k]) continue;
        if (tables) {
          out[i] = red[src[i]];
          out[i + 1] = green[src[i + 1]];
          out[i + 2] = blue[src[i + 2]];
        } else {
          out[i] = src[i];
          out[i + 1] = src[i + 1];
          out[i + 2] = src[i + 2];
        }
      }
    }
    ctx.putImageData(output, 0, 0, box.left, box.top, bw, box.bottom - box.top);
  };
  // A masked layer keeps a picture of itself, and this one changes in place
  const levelsForget = (session) => {
    const entry = rasterCache.get(session.id);
    if (entry && entry.bitmap === session.canvas) forgetRaster(session.id, entry);
    maskedVisuals.delete(session.id);
  };

  /* ---- Filter > Gaussian Blur ---- */
  // Photoshop's Radius is the Gaussian's standard deviation; under 4 px its kernel is a little
  // wider than that, and under 0.2 px it leaves the pixels as they are. Measured in Photoshop
  // 2026 on a blurred 16-bit edge: [radius, variance of its kernel].
  const BLUR_VARIANCES = [[0, 0], [0.1, 0], [0.2, 0.078], [0.3, 0.289], [0.4, 0.383], [0.5, 0.461], [0.7, 0.688], [1, 1.172], [1.5, 2.461], [2, 4.375], [3, 8.666], [4, 16]];
  const BLUR_MAX = 1000;
  const blurVariance = (radius) => {
    const r = Math.max(0, Math.min(BLUR_MAX, Number(radius) || 0));
    if (r >= 4) return r * r;
    const at = BLUR_VARIANCES.findIndex(([x]) => x >= r);
    if (at <= 0) return 0;
    const [x0, v0] = BLUR_VARIANCES[at - 1];
    const [x1, v1] = BLUR_VARIANCES[at];
    return v0 + ((v1 - v0) * (r - x0)) / (x1 - x0);
  };
  // How far a pixel's blur reaches: past 4.5 standard deviations, less than 1/100 000th of it
  const blurReach = (variance) => (variance > 0 ? Math.ceil(Math.sqrt(variance) * 4.5) + 1 : 0);
  // A preview blurs only the part of a larger layer that is on screen
  const BLUR_PREVIEW_PIXELS = 4e6;
  // What a blur does to a plane of numbers, and how far it reaches: Gaussian Blur's, given by
  // its variance, or another filter's own { plane(plane, W, H), reach } (Motion Blur's)
  const blurOf = (how) => (typeof how === "number" ? { reach: blurReach(how), plane: (plane, W, H) => blurPlane(plane, W, H, how) } : how);

  /* Filter > Blur > Motion Blur: each pixel the mean of those on a line through it at `angle`
     (0: across, 90: up and down, counterclockwise as Photoshop's): `distance` + 1 pixels of it,
     as many each side, the one more ahead for an odd distance (measured in Photoshop 2026: a
     line 1 pixel wide comes out as d + 1 pixels of 1 / (d + 1)). Each line is laid along a row
     of pixels (a column when it is steeper than 45°), whole pixels up or down as it goes, and
     averaged by a running sum: as quick for a long blur as for a short one. The edges carry on
     past the picture, as Gaussian Blur's. */
  const MOTION_MAX = 2000;
  const motionKernel = (angle, distance) => {
    const length = Math.max(0, Math.min(MOTION_MAX, Number(distance) || 0));
    const turn = ((Number(angle) || 0) * Math.PI) / 180;
    const c = Math.cos(turn);
    const sn = -Math.sin(turn);
    return { reach: Math.ceil(length / 2) + 2, plane: (plane, W, H) => motionPlane(plane, W, H, c, sn, length) };
  };
  // Along each line: `get(i)` the line's i-th pixel (i from 0 to n - 1), `put(i, v)` its mean,
  // over `half` pixels each side (a fraction of a pixel at the ends)
  const motionLine = (n, get, put, half, shift, ext) => {
    const m = Math.ceil(half + Math.abs(shift)) + 1;
    const len = n + 2 * m;
    const sum = ext.sums;
    const val = ext.vals;
    sum[0] = 0;
    for (let i = 0; i < len; i++) {
      const v = get(Math.max(0, Math.min(n - 1, i - m)));
      val[i] = v;
      sum[i + 1] = sum[i] + v;
    }
    // The integral of the line up to t (in pixels, the pixel i covering i - 0.5 to i + 0.5)
    const upTo = (t) => {
      const u = t + m + 0.5;
      const i = Math.floor(u);
      return sum[i] + (u - i) * val[i];
    };
    const width = 2 * half;
    for (let i = 0; i < n; i++) put(i, (upTo(i + shift + half) - upTo(i + shift - half)) / width);
  };
  const motionPlane = (plane, W, H, c, sn, length) => {
    if (length < 1 || !W || !H) return;
    const across = Math.abs(c) >= Math.abs(sn);
    // Pixels along: x for a line closer to horizontal, y otherwise; `step`: how far the other
    // way each one goes
    const n = across ? W : H;
    const other = across ? H : W;
    const step = across ? sn / c : c / sn;
    const along = across ? c : sn;
    const half = ((Math.round(length) + 1) / 2) * Math.abs(along);
    const shift = Math.round(length) % 2 ? Math.abs(along) / 2 : 0;
    if (half < 0.5) return;
    const off = new Int32Array(n);
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < n; i++) {
      off[i] = Math.round(i * step);
      if (off[i] < lo) lo = off[i];
      if (off[i] > hi) hi = off[i];
    }
    const out = new Float32Array(plane.length);
    const m = Math.ceil(half + Math.abs(shift)) + 1;
    const ext = { sums: new Float64Array(n + 2 * m + 1), vals: new Float64Array(n + 2 * m) };
    const index = across ? (i, o) => o * W + i : (i, o) => i * W + o;
    for (let r = -hi; r < other - lo; r++) {
      // The pixels of this line inside the picture: one run of them
      let a = -1;
      let b = -1;
      for (let i = 0; i < n; i++) {
        const o = r + off[i];
        if (o < 0 || o >= other) {
          if (a >= 0) break;
          continue;
        }
        if (a < 0) a = i;
        b = i;
      }
      if (a < 0) continue;
      motionLine(b - a + 1, (i) => plane[index(a + i, r + off[a + i])], (i, v) => { out[index(a + i, r + off[a + i])] = v; }, half, shift, ext);
    }
    plane.set(out);
  };
  // Small blurs: the sampled Gaussian of that variance, its width found by halving
  const blurKernels = new Map();
  const blurKernel = (variance) => {
    const key = Math.round(variance * 1e4);
    if (blurKernels.has(key)) return blurKernels.get(key);
    const make = (s) => {
      const r = Math.ceil(s * 5) + 1;
      const k = new Float64Array(r * 2 + 1);
      let sum = 0;
      for (let x = -r; x <= r; x++) sum += k[x + r] = Math.exp((-x * x) / (2 * s * s));
      let v = 0;
      for (let x = -r; x <= r; x++) {
        k[x + r] /= sum;
        v += k[x + r] * x * x;
      }
      return { k, r, v };
    };
    let lo = 0.01;
    let hi = 4;
    for (let i = 0; i < 48; i++) {
      const mid = (lo + hi) / 2;
      if (make(mid).v < variance) lo = mid;
      else hi = mid;
    }
    const kernel = make((lo + hi) / 2);
    blurKernels.set(key, kernel);
    return kernel;
  };
  // One line through the kernel, from `src` into `dst`. Past the ends: nothing, or (`clamp`)
  // the end pixel again, as on a Background.
  const blurLineFir = (src, dst, n, k, r, clamp) => {
    const last = n - 1;
    for (let x = 0; x < n; x++) {
      const a = x - r;
      let sum = 0;
      if (a >= 0 && x + r <= last) {
        for (let j = 0, i = a; j < k.length; j++, i++) sum += k[j] * src[i];
      } else {
        for (let j = 0; j < k.length; j++) {
          let i = a + j;
          if (i < 0 || i > last) {
            if (!clamp) continue;
            i = i < 0 ? 0 : last;
          }
          sum += k[j] * src[i];
        }
      }
      dst[x] = sum;
    }
  };
  // Larger blurs: Deriche's recursive filter of order 4, as many sums a pixel whatever the
  // radius, within a few thousandths of the Gaussian (coefficients from Getreuer, "A Survey of
  // Gaussian Convolution Algorithms", IPOL 2013), scaled so that a flat colour stays the same
  const dericheOf = (sigma) => {
    const [a0, a1, b0, b1, w0, w1, c0, c1] = [1.68, 3.735, 1.783, 1.723, 0.6318, 1.997, -0.6803, -0.2598];
    const e0 = Math.exp(-b0 / sigma);
    const e1 = Math.exp(-b1 / sigma);
    const cw0 = Math.cos(w0 / sigma);
    const sw0 = Math.sin(w0 / sigma);
    const cw1 = Math.cos(w1 / sigma);
    const sw1 = Math.sin(w1 / sigma);
    const n0 = a0 + c0;
    const n1 = e1 * (c1 * sw1 - (c0 + 2 * a0) * cw1) + e0 * (a1 * sw0 - (2 * c0 + a0) * cw0);
    const n2 = 2 * e0 * e1 * ((a0 + c0) * cw1 * cw0 - a1 * cw1 * sw0 - c1 * cw0 * sw1) + c0 * e0 * e0 + a0 * e1 * e1;
    const n3 = e1 * e0 * e0 * (c1 * sw1 - c0 * cw1) + e0 * e1 * e1 * (a1 * sw0 - a0 * cw0);
    const d1 = -2 * e1 * cw1 - 2 * e0 * cw0;
    const d2 = 4 * cw1 * cw0 * e0 * e1 + e1 * e1 + e0 * e0;
    const d3 = -2 * cw0 * e0 * e1 * e1 - 2 * cw1 * e1 * e0 * e0;
    const d4 = e0 * e0 * e1 * e1;
    const m1 = n1 - d1 * n0;
    const m2 = n2 - d2 * n0;
    const m3 = n3 - d3 * n0;
    const m4 = -d4 * n0;
    const poles = 1 + d1 + d2 + d3 + d4;
    const gain = (n0 + n1 + n2 + n3 + m1 + m2 + m3 + m4) / poles;
    const f = { n0: n0 / gain, n1: n1 / gain, n2: n2 / gain, n3: n3 / gain, m1: m1 / gain, m2: m2 / gain, m3: m3 / gain, m4: m4 / gain, d1, d2, d3, d4 };
    // What each pass settles at on a flat line of 1, for the ends
    f.causal = (f.n0 + f.n1 + f.n2 + f.n3) / poles;
    f.anti = (f.m1 + f.m2 + f.m3 + f.m4) / poles;
    return f;
  };
  const blurLineIir = (src, dst, n, f, clamp, tmp) => {
    const { n0, n1, n2, n3, m1, m2, m3, m4, d1, d2, d3, d4 } = f;
    const left = clamp ? src[0] : 0;
    let x1 = left;
    let x2 = left;
    let x3 = left;
    let y1 = left * f.causal;
    let y2 = y1;
    let y3 = y1;
    let y4 = y1;
    for (let i = 0; i < n; i++) {
      const x0 = src[i];
      const y = n0 * x0 + n1 * x1 + n2 * x2 + n3 * x3 - d1 * y1 - d2 * y2 - d3 * y3 - d4 * y4;
      tmp[i] = y;
      x3 = x2;
      x2 = x1;
      x1 = x0;
      y4 = y3;
      y3 = y2;
      y2 = y1;
      y1 = y;
    }
    const right = clamp ? src[n - 1] : 0;
    x1 = x2 = x3 = right;
    let x4 = right;
    y1 = y2 = y3 = y4 = right * f.anti;
    for (let i = n - 1; i >= 0; i--) {
      const y = m1 * x1 + m2 * x2 + m3 * x3 + m4 * x4 - d1 * y1 - d2 * y2 - d3 * y3 - d4 * y4;
      dst[i] = tmp[i] + y;
      x4 = x3;
      x3 = x2;
      x2 = x1;
      x1 = src[i];
      y4 = y3;
      y3 = y2;
      y2 = y1;
      y1 = y;
    }
  };
  // A plane of W × H values blurred in place, across then down. Lines of nothing are skipped.
  const blurPlane = (plane, W, H, variance, clamp = true) => {
    if (!(variance > 1e-3)) return;
    const n = Math.max(W, H);
    const a = new Float64Array(n);
    const b = new Float64Array(n);
    const t = new Float64Array(n);
    const fir = variance < 9 ? blurKernel(variance) : null;
    const iir = fir ? null : dericheOf(Math.sqrt(variance));
    const run = (len) => (fir ? blurLineFir(a, b, len, fir.k, fir.r, clamp) : blurLineIir(a, b, len, iir, clamp, t));
    for (let y = 0; y < H; y++) {
      const row = y * W;
      let any = false;
      for (let x = 0; x < W; x++) if ((a[x] = plane[row + x]) !== 0) any = true;
      if (!any) continue;
      run(W);
      for (let x = 0; x < W; x++) plane[row + x] = b[x];
    }
    for (let x = 0; x < W; x++) {
      let any = false;
      for (let y = 0, i = x; y < H; y++, i += W) if ((a[y] = plane[i]) !== 0) any = true;
      if (!any) continue;
      run(H);
      for (let y = 0, i = x; y < H; y++, i += W) plane[i] = b[y];
    }
  };
  // An ImageData blurred in place within `out` (a rectangle of it), as Photoshop's filter: each
  // colour weighed by its alpha, so that the transparent round the pixels doesn't darken them,
  // and the edges carrying on past it, as Photoshop's do at the page's edges (a green square in
  // a corner stays green there). `weight` (a byte a pixel of `out`): how much of the blur each
  // one takes, the selection's; what is outside it doesn't change, but is blurred in. `opaque`:
  // a Background, no alpha to weigh by. `keepAlpha`: Lock Transparent Pixels, only the colours.
  const blurImage = (image, variance, out, weight, opaque, keepAlpha) => {
    const { width: W, height: H, data } = image;
    const N = W * H;
    const ow = out.right - out.left;
    let alpha = null;
    if (!opaque) {
      alpha = new Float32Array(N);
      for (let i = 0; i < N; i++) alpha[i] = data[i * 4 + 3];
      blurOf(variance).plane(alpha, W, H);
    }
    const plane = new Float32Array(N);
    for (let c = 0; c < 3; c++) {
      if (opaque) for (let i = 0; i < N; i++) plane[i] = data[i * 4 + c];
      else for (let i = 0; i < N; i++) plane[i] = (data[i * 4 + c] * data[i * 4 + 3]) / 255;
      blurOf(variance).plane(plane, W, H);
      for (let y = out.top; y < out.bottom; y++) {
        for (let x = out.left, i = y * W + out.left, k = (y - out.top) * ow; x < out.right; x++, i++, k++) {
          const s = weight ? weight[k] / 255 : 1;
          if (!s) continue;
          const o = i * 4;
          const was = data[o + c];
          if (opaque) {
            data[o + c] = was + (plane[i] - was) * s;
            continue;
          }
          const a = data[o + 3];
          const ab = alpha[i];
          if (keepAlpha) {
            data[o + c] = was + ((ab > 1e-3 ? (plane[i] * 255) / ab : was) - was) * s;
            continue;
          }
          const am = a + (ab - a) * s;
          const pm = (was * a) / 255 + (plane[i] - (was * a) / 255) * s;
          data[o + c] = am > 1e-3 ? (pm * 255) / am : 0;
        }
      }
    }
    if (opaque || keepAlpha) return;
    for (let y = out.top; y < out.bottom; y++) {
      for (let x = out.left, i = y * W + out.left, k = (y - out.top) * ow; x < out.right; x++, i++, k++) {
        const s = weight ? weight[k] / 255 : 1;
        if (s) data[i * 4 + 3] += (alpha[i] - data[i * 4 + 3]) * s;
      }
    }
  };
  const blurClip = (a, b) => ({ left: Math.max(a.left, Math.floor(b.left)), top: Math.max(a.top, Math.floor(b.top)), right: Math.min(a.right, Math.ceil(b.right)), bottom: Math.min(a.bottom, Math.ceil(b.bottom)) });
  const blurGrow = (a, by) => ({ left: a.left - by, top: a.top - by, right: a.right + by, bottom: a.bottom + by });
  // The selection over a rectangle of the page, a byte a pixel: 255 inside
  const selectionWeights = (selection, rect) => {
    const w = rect.right - rect.left;
    const h = rect.bottom - rect.top;
    const weight = new Uint8Array(w * h);
    const b = selection.bounds;
    const m = selection.mask;
    for (let y = 0; y < h; y++) {
      const py = rect.top + y;
      for (let x = 0; x < w; x++) {
        const px = rect.left + x;
        let inside;
        if (m) {
          const mx = px - m.left;
          const my = py - m.top;
          inside = mx >= 0 && my >= 0 && mx < m.width && my < m.height && m.data[my * m.width + mx];
        } else inside = px >= b.left && px < b.right && py >= b.top && py < b.bottom;
        if (inside) weight[y * w + x] = 255;
      }
    }
    return weight;
  };
  // Where the blur changes a picture at `vis` (page pixels): all the page, as in Photoshop (and
  // the picture where it is past the page), within the selection, and within `area` too for the
  // preview of a large one; `grows` false: the picture only. Then what it reads for that: round
  // it as far as the blur reaches, within the page and the picture, whose edges carry on past
  // them. Null when nothing is left.
  const blurRegions = (doc, vis, variance, grows, area) => {
    const margin = blurOf(variance).reach;
    const whole = unionOf(vis, { left: 0, top: 0, right: doc.width, bottom: doc.height });
    let out = grows ? whole : vis;
    const selection = doc.state.selection;
    if (selection) out = blurClip(out, selection.bounds);
    let partial = false;
    if (area && (out.right - out.left) * (out.bottom - out.top) > BLUR_PREVIEW_PIXELS) {
      out = blurClip(out, area);
      partial = true;
    }
    if (emptyRect(out)) return null;
    const read = blurClip(blurGrow(out, margin), whole);
    const local = { left: out.left - read.left, top: out.top - read.top, right: out.right - read.left, bottom: out.bottom - read.top };
    return { out, read, local, partial, weight: selection ? selectionWeights(selection, out) : null };
  };
  // A pixel layer's own pixels blurred: { canvas, x, y } on the page, the part that changed
  const blurredRaster = (doc, layer, variance, area) => {
    const visual = rasterVisual(layer, doc);
    if (!visual || !visual.canvas.width || !visual.canvas.height) return { error: "empty" };
    const vis = { left: Math.floor(visual.x), top: Math.floor(visual.y), right: Math.floor(visual.x) + visual.canvas.width, bottom: Math.floor(visual.y) + visual.canvas.height };
    const opaque = Boolean(layer.isBackground);
    const keepAlpha = !opaque && lockOf(layer, "transparency");
    const regions = blurRegions(doc, vis, variance, !opaque && !keepAlpha, area);
    if (!regions) return { error: "outside" };
    const { out, read, local, partial, weight } = regions;
    const image = new ImageData(read.right - read.left, read.bottom - read.top);
    const from = blurClip(read, vis);
    if (!emptyRect(from)) {
      const fw = from.right - from.left;
      const part = visual.canvas.getContext("2d").getImageData(from.left - vis.left, from.top - vis.top, fw, from.bottom - from.top).data;
      for (let y = from.top; y < from.bottom; y++) image.data.set(part.subarray((y - from.top) * fw * 4, (y - from.top + 1) * fw * 4), ((y - read.top) * image.width + from.left - read.left) * 4);
    }
    blurImage(image, variance, local, weight, opaque, keepAlpha);
    const box = unionOf(vis, out);
    const canvas = canvasLike(visual.canvas, box.right - box.left, box.bottom - box.top);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(visual.canvas, vis.left - box.left, vis.top - box.top);
    ctx.putImageData(image, read.left - box.left, read.top - box.top, local.left, local.top, local.right - local.left, local.bottom - local.top);
    return { canvas, x: box.left, y: box.top, rect: out, partial };
  };
  // A mask (a layer's or the Quick Mask) blurred, the colour all round it too: its new settings
  const blurredMask = (doc, holder, variance, area) => {
    const picture = maskPicture(holder, doc, true);
    if (!picture.canvas || !picture.canvas.width || !picture.canvas.height) return { error: "plain" };
    const outside = Math.round(picture.outside * 255);
    const pw = picture.canvas.width;
    const ph = picture.canvas.height;
    const vis = { left: Math.floor(picture.x), top: Math.floor(picture.y), right: Math.floor(picture.x) + pw, bottom: Math.floor(picture.y) + ph };
    const regions = blurRegions(doc, vis, variance, true, area);
    if (!regions) return { error: "outside" };
    const { out, read, partial, weight } = regions;
    const W = read.right - read.left;
    const H = read.bottom - read.top;
    const own = picture.canvas.getContext("2d").getImageData(0, 0, pw, ph).data;
    // Blurred as what differs from the colour all round the picture
    const plane = new Float32Array(W * H);
    const from = blurClip(read, vis);
    for (let y = from.top; y < from.bottom; y++) {
      for (let x = from.left; x < from.right; x++) plane[(y - read.top) * W + x - read.left] = own[((y - vis.top) * pw + x - vis.left) * 4 + 3] - outside;
    }
    blurOf(variance).plane(plane, W, H);
    const box = unionOf(vis, out);
    const bw = box.right - box.left;
    const result = new ImageData(bw, box.bottom - box.top);
    const px = result.data;
    if (outside) for (let i = 3; i < px.length; i += 4) px[i] = outside;
    for (let y = vis.top; y < vis.bottom; y++) {
      for (let x = vis.left, o = ((y - vis.top) * pw) * 4 + 3, p = ((y - box.top) * bw + vis.left - box.left) * 4 + 3; x < vis.right; x++, o += 4, p += 4) px[p] = own[o];
    }
    const ow = out.right - out.left;
    for (let y = out.top; y < out.bottom; y++) {
      for (let x = out.left, k = (y - out.top) * ow; x < out.right; x++, k++) {
        const s = weight ? weight[k] / 255 : 1;
        if (!s) continue;
        const p = ((y - box.top) * bw + x - box.left) * 4 + 3;
        px[p] += (plane[(y - read.top) * W + x - read.left] + outside - px[p]) * s;
      }
    }
    const canvas = newCanvas(bw, box.bottom - box.top);
    canvas.getContext("2d", { willReadFrequently: true }).putImageData(result, 0, 0);
    const file = maskForFile({ canvas, x: box.left, y: box.top }, holder.mask.defaultColor);
    const [sx, sy] = maskShift(holder);
    const mask = Object.assign({}, holder.mask, { paint: NONE, canvas: file ? file.canvas : null, left: file ? file.left - sx : 0, top: file ? file.top - sy : 0 });
    mask.right = mask.left + (file ? file.canvas.width : 0);
    mask.bottom = mask.top + (file ? file.canvas.height : 0);
    return { mask, rect: out, partial };
  };

  // Filter > Gaussian Blur on a text that stays a text. Photoshop has no blur among its layer
  // effects, but a Drop Shadow in the letters' colour right under them (distance and spread 0),
  // with the letters at Fill 0% and Layer Knocks Out Drop Shadow off, is the letters blurred,
  // in Photoshop as here. A shadow of size S spreads as a Gaussian of S / 2.385 there (measured
  // in Photoshop 2026). The shadow's opacity keeps the Fill the letters had.
  const TEXT_BLUR_SIZE = 2.385;
  const TEXT_BLUR_MAX = Math.floor((FX_MAX_SIZE / TEXT_BLUR_SIZE) * 10) / 10;
  // The letters' one colour, or null when they have several
  const textColourOf = (layer) => {
    const colours = (layer.params.layerText.textStyleRange || []).map((range) => {
      const c = (range.textStyle && range.textStyle.color) || { red: 0, green: 0, blue: 0 };
      return { r: Math.round(c.red || 0), g: Math.round(c.green || 0), b: Math.round(c.blue || 0) };
    });
    if (!colours.length) return { r: 0, g: 0, b: 0 };
    return colours.every((c) => c.r === colours[0].r && c.g === colours[0].g && c.b === colours[0].b) ? colours[0] : null;
  };
  // The radius a text is blurred by, 0 when it isn't
  const textBlurOf = (layer) => {
    if (!layer || layer.kind !== "text" || fillOf(layer) > 0) return 0;
    const shadow = layer.effects && layer.effects.dropShadow;
    if (!shadow || shadow.enabled === false || shadow.knockout !== false || shadow.distance || shadow.spread || (shadow.blend && shadow.blend !== "normal") || !(shadow.size > 0)) return 0;
    const colour = textColourOf(layer);
    const c = shadow.color || {};
    if (!colour || c.r !== colour.r || c.g !== colour.g || c.b !== colour.b) return 0;
    return Math.round((shadow.size / TEXT_BLUR_SIZE) * 10) / 10;
  };
  // Why a text can't be blurred and stay a text, or null: its look would change otherwise
  const textBlurRefusal = (layer) => {
    if (!layer || layer.kind !== "text") return "none";
    if (textBlurOf(layer)) return null;
    if (!textColourOf(layer)) return "colours";
    // Photoshop draws the shadow differently inside letters that have a stroke (measured in
    // Photoshop 2026: darker by up to a third), and the stroke would stay sharp
    if (layer.stroke && layer.stroke.enabled !== false && layer.stroke.size > 0) return "stroke";
    const effects = layer.effects || {};
    if (effects.dropShadow && effects.dropShadow.enabled !== false) return "shadow";
    if (FX_INSIDE.some((name) => effects[name] && effects[name].enabled !== false)) return "effects";
    if (fillOf(layer) <= 0) return "fill";
    return null;
  };

  // Edit > Auto-Align Layers works in align-worker.js, away from the page: one worker per run
  const startAligner = () => new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker("align-worker.js");
    } catch (error) {
      reject(error);
      return;
    }
    const jobs = new Map();
    let last = 0;
    const late = setTimeout(() => reject(new Error("The alignment worker didn't start.")), 15000);
    const stop = (error) => {
      jobs.forEach((job) => job.reject(error));
      jobs.clear();
    };
    worker.onerror = (event) => {
      clearTimeout(late);
      const error = new Error((event && event.message) || "The alignment worker stopped.");
      reject(error);
      stop(error);
    };
    worker.onmessage = ({ data }) => {
      if (data.ready) {
        clearTimeout(late);
        resolve({
          ask: (type, payload, transfer, progress) => new Promise((done, fail) => {
            const id = ++last;
            jobs.set(id, { resolve: done, reject: fail, progress });
            worker.postMessage({ id, type, payload }, transfer || []);
          }),
          stop: () => {
            worker.terminate();
            stop(new Error("Stopped."));
          },
        });
        return;
      }
      const job = jobs.get(data.id);
      if (!job) return;
      if (data.progress !== undefined) {
        if (job.progress) job.progress(data.progress);
        return;
      }
      jobs.delete(data.id);
      if (data.error) job.reject(new Error(data.error));
      else job.resolve(data.result);
    };
  });
  // A part of a picture at (x, y) of the page, as bytes
  const pixelsOf = (source, x, y, part) => source.getContext("2d").getImageData(part.left - x, part.top - y, part.width, part.height);
  const canvasOfBytes = ({ data, width, height }) => {
    const canvas = newCanvas(width, height);
    canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
    return canvas;
  };

  /* ---------------------- Generative Fill: laying it back ---------------------- */

  // 3 × 3 matrices, row by row
  const mul3 = (a, b) => [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]));
  const inv3 = (m) => {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h;
    const B = -(d * i - f * g);
    const C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (!det) return null;
    return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det);
  };
  // The page around a selection and a model's picture of it, made small and grey, to judge
  // where the picture goes. `m` takes the picture's page places to the page's (null: as it came).
  const fitGround = (page, picture, hole, x0, y0) => {
    const level = (longest) => {
      const k = Math.min(1, longest / Math.max(page.width, page.height));
      const w = Math.max(8, Math.round(page.width * k));
      const h = Math.max(8, Math.round(page.height * k));
      const canvas = newCanvas(w, h);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.imageSmoothingQuality = "high";
      const grey = (source) => {
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(source, 0, 0, w, h);
        const d = ctx.getImageData(0, 0, w, h).data;
        const g = new Float32Array(w * h);
        for (let i = 0; i < g.length; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
        return { g, a: d };
      };
      const ref = grey(page);
      const pic = grey(picture);
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(hole, 0, 0, w, h);
      const m = ctx.getImageData(0, 0, w, h).data;
      const valid = new Uint8Array(w * h);
      let count = 0;
      for (let i = 0; i < valid.length; i++) if (!m[i * 4 + 3]) {
        valid[i] = 1;
        count++;
      }
      // A small pixel's centre on the page, and back
      const kx = w / page.width;
      const ky = h / page.height;
      const toPage = [1 / kx, 0, x0 + 0.5 / kx - 0.5, 0, 1 / ky, y0 + 0.5 / ky - 0.5, 0, 0, 1];
      return { w, h, ref: ref.g, pic: pic.g, valid, count, toPage, toSmall: inv3(toPage) };
    };
    const coarse = level(96);
    const fine = level(320);
    // Mean difference where the page counts, through `h`: the page's small places to the picture's
    const errorAt = (L, h) => {
      const { w, ref, pic, valid } = L;
      const H = L.h;
      let sum = 0;
      let n = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (!valid[i]) continue;
          const z = h[6] * x + h[7] * y + h[8];
          const gx = (h[0] * x + h[1] * y + h[2]) / z;
          const gy = (h[3] * x + h[4] * y + h[5]) / z;
          if (!(gx >= 0 && gy >= 0 && gx <= w - 1 && gy <= H - 1)) continue;
          const ix = Math.min(w - 2, Math.floor(gx));
          const iy = Math.min(H - 2, Math.floor(gy));
          const fx = gx - ix;
          const fy = gy - iy;
          const j = iy * w + ix;
          const value = (pic[j] * (1 - fx) + pic[j + 1] * fx) * (1 - fy) + (pic[j + w] * (1 - fx) + pic[j + w + 1] * fx) * fy;
          sum += Math.abs(value - ref[i]);
          n++;
        }
      }
      // Too little of the page left to compare: no judgement
      return n >= Math.max(40, L.count * 0.6) ? sum / n : Infinity;
    };
    const smallOf = (L, m) => (m ? mul3(L.toSmall, mul3(inv3(m), L.toPage)) : [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const pageOf = (L, h) => inv3(mul3(L.toPage, mul3(h, L.toSmall)));
    // Resized by s (sx, sy) around the middle, and moved by (tx, ty): the page's small places to the picture's
    const scaled = (L, sx, sy, tx, ty) => {
      const cx = (L.w - 1) / 2;
      const cy = (L.h - 1) / 2;
      return [1 / sx, 0, cx - (cx + tx) / sx, 0, 1 / sy, cy - (cy + ty) / sy, 0, 0, 1];
    };
    return {
      error: (m) => {
        const h = smallOf(fine, m);
        return h ? errorAt(fine, h) : Infinity;
      },
      // Coarse first, every size from 90 to 110 % and every move up to 8 %, then finer, one
      // number at a time
      search: () => {
        if (coarse.count < 40) return null;
        let best = { e: Infinity };
        const reach = Math.ceil(Math.max(coarse.w, coarse.h) * 0.08);
        for (let s = 0.9; s <= 1.1001; s += 0.02) {
          for (let ty = -reach; ty <= reach; ty++) {
            for (let tx = -reach; tx <= reach; tx++) {
              const e = errorAt(coarse, scaled(coarse, s, s, tx, ty));
              if (e < best.e) best = { e, s, tx, ty };
            }
          }
        }
        if (!Number.isFinite(best.e)) return null;
        const r = fine.w / coarse.w;
        let p = [best.s, best.s, best.tx * r, best.ty * r];
        let e = errorAt(fine, scaled(fine, ...p));
        const steps = [0.01, 0.01, r, r];
        for (let round = 0; round < 40 && steps[2] > 0.1; round++) {
          let better = false;
          for (let k = 0; k < 4; k++) {
            for (const sign of [1, -1]) {
              const q = p.slice();
              q[k] += sign * steps[k];
              const eq = errorAt(fine, scaled(fine, ...q));
              if (eq < e) {
                e = eq;
                p = q;
                better = true;
              }
            }
          }
          if (!better) for (let k = 0; k < 4; k++) steps[k] /= 2;
        }
        return pageOf(fine, scaled(fine, ...p));
      },
    };
  };
  // Match the surrounding histograms using only levels actually observed there.
  // Interpolate between those anchors: empty histogram bins carry no evidence
  // about the selected drawing, and must not crush its tones or darken white.
  const matchLevels = (picture, page, hole) => {
    for (let c = 0; c < 3; c++) {
      const from = new Float64Array(256);
      const to = new Float64Array(256);
      let n = 0;
      for (let i = 0; i < picture.length; i += 4) {
        if (hole[i + 3]) continue;
        from[picture[i + c]]++;
        to[page[i + c]]++;
        n++;
      }
      if (n < 500) return;
      for (let v = 1; v < 256; v++) {
        from[v] += from[v - 1];
        to[v] += to[v - 1];
      }
      const anchors = [];
      let u = 0;
      for (let v = 0; v < 256; v++) {
        const count = from[v] - (v ? from[v - 1] : 0);
        if (!count) continue;
        // The middle of the levels v stands for, in the page's levels
        const at = from[v] - count / 2;
        while (u < 255 && to[u] < at) u++;
        anchors.push({ from: v, to: u });
      }
      const lut = new Uint8ClampedArray(256);
      let right = 0;
      for (let v = 0; v < 256; v++) {
        while (right < anchors.length - 1 && anchors[right].from < v) right++;
        const b = anchors[right];
        if (v <= anchors[0].from || v >= anchors[anchors.length - 1].from) {
          // Outside the observed range, keep contrast with the nearest offset.
          const edge = v <= anchors[0].from ? anchors[0] : anchors[anchors.length - 1];
          lut[v] = v + edge.to - edge.from;
        } else {
          const a = anchors[Math.max(0, right - 1)];
          lut[v] = a.to + (b.to - a.to) * (v - a.from) / (b.from - a.from);
        }
      }
      for (let i = 0; i < picture.length; i += 4) picture[i + c] = lut[picture[i + c]];
    }
  };
  // Inside `hole`, `picture` brought to the brightness of the page that borders it. A model can
  // draw the inside lighter or darker than its own surroundings (FLUX smooths a screentone into
  // a paler grey), which no levels matched around the hole can see. Along the hole's edge, the
  // page's average just outside is set against the picture's just inside; each piece of the hole
  // gets the correction those differences agree on, a level and a slope (a gradient goes on
  // across it). The edge points that disagree (a balloon's outline, a line of the art next to
  // the hole) weigh nothing, so they don't stain it.
  const matchTones = (picture, page, hole, width, height) => {
    const n = width * height;
    const inside = new Uint8Array(n);
    for (let p = 0; p < n; p++) if (hole[p * 4 + 3]) inside[p] = 1;
    // Averages over a square around each point: of the page outside the hole, of the picture in it
    const r = Math.max(4, Math.min(16, Math.round(Math.sqrt(n) * 0.012)));
    const W1 = width + 1;
    const sums = (fromPicture) => {
      const table = new Float64Array(W1 * (height + 1) * 4);
      for (let y = 0; y < height; y++) {
        const row = [0, 0, 0, 0];
        for (let x = 0; x < width; x++) {
          const p = y * width + x;
          const take = fromPicture ? inside[p] : !inside[p];
          if (take) {
            const source = fromPicture ? picture : page;
            row[0] += source[p * 4];
            row[1] += source[p * 4 + 1];
            row[2] += source[p * 4 + 2];
            row[3]++;
          }
          const at = ((y + 1) * W1 + x + 1) * 4;
          const above = (y * W1 + x + 1) * 4;
          for (let k = 0; k < 4; k++) table[at + k] = table[above + k] + row[k];
        }
      }
      return table;
    };
    const outer = sums(false);
    const inner = sums(true);
    const box = (table, x, y, k) => {
      const a = Math.max(0, x - r);
      const b = Math.max(0, y - r);
      const c = Math.min(width, x + r + 1);
      const d = Math.min(height, y + r + 1);
      return table[(d * W1 + c) * 4 + k] - table[(b * W1 + c) * 4 + k] - table[(d * W1 + a) * 4 + k] + table[(b * W1 + a) * 4 + k];
    };
    const enough = (r * 2 + 1) * (r * 2 + 1) * 0.2;
    // Each piece of the hole on its own, with its edge points: where it is, and how far the
    // page's average stands from the picture's there
    const piece = new Int32Array(n).fill(-1);
    const pieces = [];
    const stack = [];
    for (let start = 0; start < n; start++) {
      if (!inside[start] || piece[start] >= 0) continue;
      const id = pieces.length;
      const one = { pixels: [], samples: [] };
      pieces.push(one);
      piece[start] = id;
      stack.push(start);
      while (stack.length) {
        const p = stack.pop();
        one.pixels.push(p);
        const x = p % width;
        const y = (p - x) / width;
        let edge = false;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const q = ny * width + nx;
          if (!inside[q]) edge = true;
          else if (piece[q] < 0) {
            piece[q] = id;
            stack.push(q);
          }
        }
        if (!edge) continue;
        const outCount = box(outer, x, y, 3);
        const inCount = box(inner, x, y, 3);
        if (outCount < enough || inCount < enough) continue;
        const gap = [0, 1, 2].map((k) => box(outer, x, y, k) / outCount - box(inner, x, y, k) / inCount);
        one.samples.push({ x, y, gap });
      }
    }
    pieces.forEach((one) => {
      const { pixels, samples } = one;
      if (samples.length < 8) return;
      let cx = 0;
      let cy = 0;
      samples.forEach((s) => { cx += s.x; cy += s.y; });
      cx /= samples.length;
      cy /= samples.length;
      let spread = 0;
      samples.forEach((s) => { spread = Math.max(spread, Math.abs(s.x - cx), Math.abs(s.y - cy)); });
      // A slope only where the piece is wide enough to show one
      const sloped = spread > r * 3 && samples.length >= 40;
      const scale = spread || 1;
      const offsets = [0, 1, 2].map((k) => {
        // Least squares, again and again, each point weighed by how well it agrees (Tukey):
        // a level, and in a wide piece a slope along x and y
        let fit = [0, 0, 0];
        const values = samples.map((s) => s.gap[k]).sort((a, b) => a - b);
        fit[0] = values[values.length >> 1];
        let cut = 24;
        for (let round = 0; round < 12; round++) {
          const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
          const v = [0, 0, 0];
          const residuals = [];
          samples.forEach((s) => {
            const u = (s.x - cx) / scale;
            const w = (s.y - cy) / scale;
            const e = s.gap[k] - (fit[0] + fit[1] * u + fit[2] * w);
            residuals.push(Math.abs(e));
            const t = e / cut;
            const weight = Math.abs(t) < 1 ? (1 - t * t) * (1 - t * t) : 0;
            if (!weight) return;
            const f = [1, u, w];
            for (let i = 0; i < 3; i++) {
              v[i] += weight * f[i] * s.gap[k];
              for (let j = 0; j < 3; j++) m[i * 3 + j] += weight * f[i] * f[j];
            }
          });
          if (m[0] < 4) break;
          if (sloped) {
            // A little held back, so that a few points can't tip it
            m[4] += m[0] * 0.02;
            m[8] += m[0] * 0.02;
            const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
            if (Math.abs(det) < 1e-9) break;
            const solve = (col) => {
              const a = m.slice();
              for (let i = 0; i < 3; i++) a[i * 3 + col] = v[i];
              return (a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6])) / det;
            };
            fit = [solve(0), solve(1), solve(2)];
          } else fit = [v[0] / m[0], 0, 0];
          // The cut follows how far the points stray: wide at first, then around the agreeing ones
          residuals.sort((a, b) => a - b);
          cut = Math.max(6, Math.min(48, residuals[residuals.length >> 1] * 4.7));
        }
        return fit;
      });
      pixels.forEach((p) => {
        const x = p % width;
        const u = (x - cx) / scale;
        const w = ((p - x) / width - cy) / scale;
        for (let k = 0; k < 3; k++) {
          const [a, b, c] = offsets[k];
          const shift = Math.max(-96, Math.min(96, a + b * u + c * w));
          picture[p * 4 + k] = picture[p * 4 + k] + shift;
        }
      });
    });
  };
  // Inside `hole`, the picture's fine detail brought to the contrast the page's has around it.
  // A model's picture, brought down to the page's size, keeps a screentone's dots but softens
  // them: grey dots on a light grey where the page has black dots on white. The detail is what a
  // small blur takes away; its spread (between the 10th and 90th percentiles, so a few lines of
  // the art don't decide it) is measured just outside the hole on the page and inside it on the
  // picture, and the picture's is raised to match, by at most twice. A flat inside (the inside
  // of a balloon) is left as it is: raising it would raise the ghosts of the letters gone.
  // Measured on seven sound effects over screentone: sharpness 0.69 to 0.97 of the page's on a
  // fine tone, the joins at the edge unchanged.
  const restoreDetail = (picture, page, hole, width, height) => {
    const n = width * height;
    const inside = new Float32Array(n);
    for (let p = 0; p < n; p++) inside[p] = hole[p * 4 + 3] ? 1 : 0;
    // A box blur of radius r over a float plane, twice (close to a gaussian), by running sums
    const blur = (plane, r, passes = 2) => {
      let src = plane;
      const tmp = new Float32Array(n);
      for (let pass = 0; pass < passes; pass++) {
        const out = new Float32Array(n);
        for (let y = 0; y < height; y++) {
          let sum = 0;
          const row = y * width;
          for (let x = -r; x <= r; x++) sum += src[row + Math.min(width - 1, Math.max(0, x))];
          for (let x = 0; x < width; x++) {
            tmp[row + x] = sum / (2 * r + 1);
            sum += src[row + Math.min(width - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
          }
        }
        for (let x = 0; x < width; x++) {
          let sum = 0;
          for (let y = -r; y <= r; y++) sum += tmp[Math.min(height - 1, Math.max(0, y)) * width + x];
          for (let y = 0; y < height; y++) {
            out[y * width + x] = sum / (2 * r + 1);
            sum += tmp[Math.min(height - 1, y + r + 1) * width + x] - tmp[Math.max(0, y - r) * width + x];
          }
        }
        src = out;
      }
      return src;
    };
    const grey = (data) => {
      const out = new Float32Array(n);
      for (let p = 0; p < n; p++) out[p] = data[p * 4] * 0.299 + data[p * 4 + 1] * 0.587 + data[p * 4 + 2] * 0.114;
      return out;
    };
    const pictureGrey = grey(picture);
    const pageGrey = grey(page);
    const pictureLow = blur(pictureGrey, 1);
    const pageLow = blur(pageGrey, 1);
    // Just outside the hole: near it (a band about 12 pixels wide), but not on its edge
    const near = blur(inside, 12, 1);
    const edge = blur(inside, 2, 1);
    // The spread of the detail, from a histogram of whole levels (-255 to 255)
    const spread = (pick, plane, low) => {
      const counts = new Uint32Array(511);
      let total = 0;
      for (let p = 0; p < n; p++) {
        if (!pick(p)) continue;
        counts[Math.round(plane[p] - low[p]) + 255]++;
        total++;
      }
      if (total < 400) return 0;
      const at = (share) => {
        let seen = 0;
        for (let v = 0; v < 511; v++) {
          seen += counts[v];
          if (seen >= total * share) return v;
        }
        return 510;
      };
      return at(0.9) - at(0.1);
    };
    // Inside, away from its edge, where a blur mixes in what is around
    const fade = blur(inside, 2);
    const around = spread((p) => !inside[p] && near[p] > 0 && edge[p] === 0, pageGrey, pageLow);
    const within = spread((p) => fade[p] > 0.999, pictureGrey, pictureLow);
    if (around < 6 || within < 6) return;
    const gain = Math.min(2, around / within);
    if (gain <= 1.02) return;
    // Raised over the hole, fading out over its last pixels, on each channel alike
    const lows = [0, 1, 2].map((c) => {
      const plane = new Float32Array(n);
      for (let p = 0; p < n; p++) plane[p] = picture[p * 4 + c];
      return [plane, blur(plane, 1)];
    });
    for (let p = 0; p < n; p++) {
      const weight = inside[p] * fade[p] * (gain - 1);
      if (!weight) continue;
      for (let c = 0; c < 3; c++) picture[p * 4 + c] = lows[c][0][p] + (lows[c][0][p] - lows[c][1][p]) * weight;
    }
  };

  /* -------------------------- Content-Aware Fill -------------------------- */

  // inpaint.js does the long work in a worker, so the page stays alive. A browser that
  // refuses workers runs the same code here, as the script it also is.
  let inpaintWorker = null;
  let inpaintRefused = false;
  let inpaintJobs = 0;
  const inpaintWaiting = new Map();
  const startInpaintWorker = () => new Promise((resolve) => {
    if (inpaintWorker || inpaintRefused) {
      resolve(inpaintWorker);
      return;
    }
    let candidate;
    const lost = () => {
      inpaintRefused = true;
      inpaintWorker = null;
      resolve(null);
      inpaintWaiting.forEach((job) => job.reject(new Error("The fill worker stopped.")));
      inpaintWaiting.clear();
    };
    try {
      candidate = new Worker("inpaint.js");
    } catch (error) {
      lost();
      return;
    }
    const late = setTimeout(lost, 15000);
    candidate.onerror = () => {
      clearTimeout(late);
      lost();
    };
    candidate.onmessage = ({ data }) => {
      if (data.ready) {
        clearTimeout(late);
        inpaintWorker = candidate;
        resolve(candidate);
        return;
      }
      const job = inpaintWaiting.get(data.id);
      if (!job) return;
      if (data.progress !== undefined) {
        if (job.progress) job.progress(data.progress);
        return;
      }
      inpaintWaiting.delete(data.id);
      if (data.error) job.reject(new Error(data.error));
      else job.resolve(data.result);
    };
  });
  const inpaint = async (payload, options, progress) => {
    const worker = await startInpaintWorker();
    if (!worker) {
      if (!window.TypeRInpaint) throw new Error("inpaint.js isn't loaded.");
      return window.TypeRInpaint.inpaint(payload, options, progress);
    }
    return new Promise((resolve, reject) => {
      const id = ++inpaintJobs;
      inpaintWaiting.set(id, { resolve, reject, progress });
      worker.postMessage({ id, payload, options }, [payload.data.buffer, payload.mask.buffer, payload.source.buffer]);
    });
  };

  // Whether what is right around the stroke is a screentone: a pattern that repeats itself,
  // close by, in two directions. A line repeats along itself only; letters, not that closely.
  // If so, the pixels it was read on (those close to the stroke), else null.
  const TONE_RING = 10;
  const TONE_PERIOD = 14;
  const TONE_LIKE = 0.5;
  const TONE_DIP = 0.4;
  const grayAt = (data, i) => data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114;
  const screentoned = (data, mask, width, height) => {
    const n = width * height;
    // The pixels within TONE_RING of the stroke (its steps away from it in `far`)
    const far = new Uint8Array(n);
    const walk = new Int32Array(n);
    let head = 0;
    let tail = 0;
    for (let i = 0; i < n; i++) {
      if (!mask[i]) continue;
      far[i] = 1;
      walk[tail++] = i;
    }
    const step = (from, to) => {
      if (far[to] || far[from] > TONE_RING) return;
      far[to] = far[from] + 1;
      walk[tail++] = to;
    };
    while (head < tail) {
      const i = walk[head++];
      const x = i % width;
      if (x > 0) step(i, i - 1);
      if (x < width - 1) step(i, i + 1);
      if (i >= width) step(i, i - width);
      if (i < n - width) step(i, i + width);
    }
    const ring = [];
    for (let k = 0; k < tail; k++) if (!mask[walk[k]] && data[walk[k] * 4 + 3] >= 128) ring.push(walk[k]);
    if (ring.length < 200) return null;
    // A long stroke: one pixel in so many is enough
    const every = Math.max(1, Math.round(ring.length / 20000));
    const tone = (i) => grayAt(data, i);
    let sum = 0;
    let count = 0;
    for (let k = 0; k < ring.length; k += every) {
      sum += tone(ring[k]);
      count++;
    }
    const mean = sum / count;
    let spread = 0;
    for (let k = 0; k < ring.length; k += every) spread += (tone(ring[k]) - mean) ** 2;
    spread /= count;
    // Flat: nothing repeats
    if (spread < 100) return null;
    // How much the tones match, moved by each step (dx, dy) up to TONE_PERIOD: 1 the same
    const likes = new Map();
    for (let dy = 0; dy <= TONE_PERIOD; dy++) {
      for (let dx = -TONE_PERIOD; dx <= TONE_PERIOD; dx++) {
        if ((dy === 0 && dx <= 0) || dx * dx + dy * dy > TONE_PERIOD * TONE_PERIOD) continue;
        let product = 0;
        let pairs = 0;
        for (let k = 0; k < ring.length; k += every) {
          const i = ring[k];
          const x = (i % width) + dx;
          const y = Math.floor(i / width) + dy;
          if (x < 0 || x >= width || y >= height) continue;
          const j = y * width + x;
          if (mask[j] || data[j * 4 + 3] < 128) continue;
          product += (tone(i) - mean) * (tone(j) - mean);
          pairs++;
        }
        if (pairs * 2 >= count) likes.set(`${dx},${dy}`, product / pairs / spread);
      }
    }
    const likeAt = (dx, dy) => (dy < 0 || (dy === 0 && dx < 0) ? likes.get(`${-dx},${-dy}`) : likes.get(`${dx},${dy}`));
    // A step at which it repeats: the same again, after something else on the way (a thick
    // stroke is the same a step further too, but all along the way)
    const repeats = [];
    likes.forEach((like, key) => {
      const [dx, dy] = key.split(",").map(Number);
      if (like < TONE_LIKE || dx * dx + dy * dy < 4) return;
      const between = [0.35, 0.5, 0.65].map((t) => likeAt(Math.round(dx * t), Math.round(dy * t))).filter((value) => value !== undefined);
      if (between.length && Math.min(...between) <= like - TONE_DIP) repeats.push({ dx, dy, like });
    });
    repeats.sort((a, b) => b.like - a.like);
    const first = repeats[0];
    if (!first) return null;
    // And in a second direction, well apart from the first
    const length = Math.hypot(first.dx, first.dy);
    return repeats.some((other) => Math.abs(first.dx * other.dy - first.dy * other.dx) >= 0.5 * length * Math.hypot(other.dx, other.dy)) ? ring : null;
  };

  // Where the Spot Healing Brush may read from: what the edge of the stroke belongs to, grown
  // from it pixel by pixel as long as the colour changes gently. Inside a bubble, that is the
  // bubble, and not its outline nor the sky beyond, which a fill would otherwise bring in; a
  // line crossing the stroke comes along, so it carries on. On a screentone, the paper between
  // the dots joins up on its own, and read alone it would heal into a blank patch: there, what
  // has the tone's look is read too. A busy picture breaks it into crumbs: then everything
  // around is read, as Content-Aware Fill does.
  const HEAL_STEP = 24;
  const healSource = (data, mask, width, height) => {
    const n = width * height;
    const all = new Uint8Array(n).fill(1);
    const reached = new Uint8Array(n);
    const queue = new Int32Array(n);
    let head = 0;
    let tail = 0;
    let holes = 0;
    const open = (i) => !mask[i] && data[i * 4 + 3] >= 128;
    for (let i = 0; i < n; i++) {
      if (mask[i]) {
        holes++;
        continue;
      }
      if (!open(i)) continue;
      const x = i % width;
      const edge = (x > 0 && mask[i - 1]) || (x < width - 1 && mask[i + 1]) || (i >= width && mask[i - width]) || (i < n - width && mask[i + width]);
      if (edge) {
        reached[i] = 1;
        queue[tail++] = i;
      }
    }
    if (!tail) return all;
    const near = (a, b) => Math.abs(data[a * 4] - data[b * 4]) <= HEAL_STEP && Math.abs(data[a * 4 + 1] - data[b * 4 + 1]) <= HEAL_STEP && Math.abs(data[a * 4 + 2] - data[b * 4 + 2]) <= HEAL_STEP;
    const visit = (from, to) => {
      if (reached[to] || !open(to) || !near(from, to)) return;
      reached[to] = 1;
      queue[tail++] = to;
    };
    while (head < tail) {
      const i = queue[head++];
      const x = i % width;
      if (x > 0) visit(i, i - 1);
      if (x < width - 1) visit(i, i + 1);
      if (i >= width) visit(i, i - width);
      if (i < n - width) visit(i, i + width);
    }
    // Enough to draw from (as much as there is to fill), else the whole neighbourhood
    if (tail < Math.max(600, holes)) return all;
    const ring = screentoned(data, mask, width, height);
    if (!ring) return reached;
    // On a screentone, what has its grain all around (TONE_PERIOD) is read too: its dots, and
    // where the paper breaks into crumbs, with a tone between the screentone's and the paper's
    // (its edge against the plain paper). Not a letter or a dark shape amid it.
    const W = width + 1;
    const sums = new Float64Array(W * (height + 1));
    const squares = new Float64Array(W * (height + 1));
    const counts = new Int32Array(W * (height + 1));
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const at = (y + 1) * W + x + 1;
        const ok = !mask[i] && data[i * 4 + 3] >= 128;
        const value = ok ? grayAt(data, i) : 0;
        sums[at] = sums[at - 1] + sums[at - W] - sums[at - W - 1] + value;
        squares[at] = squares[at - 1] + squares[at - W] - squares[at - W - 1] + value * value;
        counts[at] = counts[at - 1] + counts[at - W] - counts[at - W - 1] + (ok ? 1 : 0);
      }
    }
    // The tone and grain around (x, y), in `mean` and `spread`; false if too little is known
    const R = TONE_PERIOD >> 1;
    let mean = 0;
    let spread = 0;
    const around = (x, y) => {
      const top = Math.max(0, y - R) * W;
      const bottom = Math.min(height, y + R + 1) * W;
      const left = Math.max(0, x - R);
      const right = Math.min(width, x + R + 1);
      const box = (table) => table[bottom + right] - table[bottom + left] - table[top + right] + table[top + left];
      const count = box(counts);
      if (count < 4) return false;
      mean = box(sums) / count;
      spread = box(squares) / count - mean * mean;
      return true;
    };
    // The screentone's, read where the stroke's surroundings vary (not the plain paper beside)
    const means = [];
    const spreads = [];
    ring.forEach((i) => {
      if (!around(i % width, Math.floor(i / width)) || spread < 400) return;
      means.push(mean);
      spreads.push(spread);
    });
    if (means.length < 50) return reached;
    const median = (values) => values.sort((a, b) => a - b)[values.length >> 1];
    const toneMean = median(means);
    const toneSpread = median(spreads);
    let paper = 0;
    for (let k = 0; k < tail; k++) paper += grayAt(data, queue[k]);
    paper /= tail;
    const lightest = Math.max(toneMean, paper) + HEAL_STEP;
    const darkest = Math.min(toneMean, paper) - HEAL_STEP;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (reached[i] || mask[i] || data[i * 4 + 3] < 128 || !around(x, y)) continue;
        if (mean >= darkest && mean <= lightest && spread >= toneSpread / 4 && spread <= toneSpread * 2) reached[i] = 1;
      }
    }
    return reached;
  };

  const ops = {
    // Image > Canvas Size: the page changes around an anchor, 0 to 1 on each side
    resizeCanvas(width, height, ax, ay, fill) {
      const doc = app.doc;
      if (!doc || (width === doc.width && height === doc.height)) return;
      const ox = Math.round((width - doc.width) * ax);
      const oy = Math.round((height - doc.height) * ay);
      resizeDoc(doc, "Canvas Size", { width, height }, onNewCanvas(doc, width, height, ox, oy, fill), surfacesShifted(doc, ox, oy), (x, y) => [x + ox, y + oy]);
    },
    // What Free Transform works on: the active pixel layers and texts, and those in the active
    // folders (an SFX's letters with it)
    transformableIds() {
      const doc = app.doc;
      if (!doc) return [];
      const out = new Set();
      withLinked(doc.state.layers, doc.state.activeIds).forEach((id) => familyOf(doc.state.layers, id).forEach((member) => out.add(member)));
      const fits = (layer) => (layer.kind === "text" ? !lockOf(layer, "position") : layer.kind === "raster" && !layer.adjustment && !lockOf(layer, "position") && !lockOf(layer, "pixels") && visualOf(layer, doc));
      return doc.state.layers.filter((layer) => out.has(layer.id) && fits(layer)).map((layer) => layer.id);
    },
    // Where a layer shows: a pixel layer's pixels, a text's letters. Of the page in front, or of `doc`.
    pixelBox(layer, doc = app.doc) {
      if (!doc) return null;
      return layer.kind === "text" ? boxOf(layer, doc) : trimmedBox(layer, doc);
    },
    // Gives back the part of the page to draw again, when it can be told: where the layers
    // showed through the matrix before, and where they show through this one
    setLiveTransform(ids, matrix) {
      const doc = app.doc;
      if (!doc) return undefined;
      const last = doc.liveTransform;
      doc.liveTransform = ids ? { ids: new Set(ids), matrix, area: null } : null;
      if (!ids) {
        doc.sampleCache = null;
        return undefined;
      }
      const area = turnedArea(doc, doc.liveTransform);
      doc.liveTransform.area = area;
      // The first one draws the page whole: the layers leave where they were
      if (!area || !last || !last.area || last.ids.size !== ids.length || ids.some((id) => !last.ids.has(id))) return undefined;
      return pageRect(doc, Math.min(area.left, last.area.left), Math.min(area.top, last.area.top), Math.max(area.right, last.area.right), Math.max(area.bottom, last.area.bottom));
    },
    transformLayers(ids, matrix, name) {
      const doc = app.doc;
      if (!doc) return;
      const set = new Set(ids);
      const layers = doc.state.layers.map((layer) => {
        if (!set.has(layer.id)) return layer;
        if (layer.kind === "text") return transformedText(layer, matrix, doc);
        const part = trimmedBox(layer, doc);
        if (!part) return layer;
        const visual = visualOf(Object.assign({}, layer, { mask: null, vectorMask: null }), doc);
        const p = transformedPixels(visual.canvas, visual.x, visual.y, part, matrix);
        let mask = pageMask(layer, doc);
        if (mask && mask.canvas) {
          const x = mask.left || 0;
          const y = mask.top || 0;
          const m = transformedPixels(mask.canvas, x, y, rectFrom(x, y, x + mask.canvas.width, y + mask.canvas.height), matrix, mask.defaultColor ? "#fff" : "#000");
          mask = Object.assign({}, mask, { canvas: m.canvas, left: m.left, top: m.top, right: m.left + m.canvas.width, bottom: m.top + m.canvas.height });
        }
        const next = withPixels(layer, p.canvas, p.left, p.top, mask);
        if (layer.vectorMask) {
          const [a, b, c, d, e, f] = matrix;
          const ax = layer.dx || 0;
          const ay = layer.dy || 0;
          next.vectorMask = mappedVector(layer.vectorMask, (x, y) => [a * (x + ax) + c * (y + ay) + e, b * (x + ax) + d * (y + ay) + f]);
        }
        // As in Photoshop, a Background that is transformed becomes a layer like any other
        if (layer.isBackground) Object.assign(next, { isBackground: false, name: `${(app.names && app.names.layer) || "Layer"} 0` });
        return next;
      });
      commitState(doc, name, { layers });
      firePanelEvent(EVENT_HISTORY);
    },
    // Edit > Auto-Align Layers: the active pixel layers, and those in the active folders. A locked
    // one, or the Background, is the reference and stays where it is, as in Photoshop.
    alignableIds() {
      const doc = app.doc;
      if (!doc) return [];
      const out = new Set();
      doc.state.activeIds.forEach((id) => familyOf(doc.state.layers, id).forEach((member) => out.add(member)));
      return doc.state.layers.filter((layer) => out.has(layer.id) && layer.kind === "raster" && !layer.adjustment && visualOf(layer, doc)).map((layer) => layer.id);
    },
    // `projection`: auto, perspective, collage or reposition. One step in the history; null when
    // the page changed meanwhile.
    // `settle(doc)`: what to wait for before the result lands (what is under way on the page)
    async autoAlignLayers(projection, progress = () => {}, settle = null) {
      const doc = app.doc;
      if (!doc) return null;
      const before = doc.state.layers;
      const wanted = new Set(ops.alignableIds());
      const picked = before.filter((layer) => wanted.has(layer.id)).map((layer) => {
        const part = trimmedBox(layer, doc);
        const visual = part && visualOf(Object.assign({}, layer, { mask: null, vectorMask: null }), doc);
        return visual && { layer, part, visual };
      }).filter(Boolean);
      if (picked.length < 2) return { moved: 0, failed: 0, total: picked.length };
      const aligner = await startAligner();
      try {
        const transfer = [];
        const layers = picked.map(({ layer, part, visual }) => {
          const { data } = pixelsOf(visual.canvas, visual.x, visual.y, part);
          transfer.push(data.buffer);
          return { id: layer.id, x: part.left, y: part.top, width: part.width, height: part.height, data: data.buffer, fixed: Boolean(layer.locked || layer.isBackground) };
        });
        const found = await aligner.ask("analyse", { layers, projection }, transfer, (percent) => progress(Math.round(percent * 0.85)));
        const changed = new Map();
        for (let index = 0; index < found.moves.length; index++) {
          const move = found.moves[index];
          const { layer, part, visual } = picked.find((item) => item.layer.id === move.id);
          // Moved by whole pixels, the pixels stay as they are; otherwise they are drawn again, bicubic
          const shift = move.shift && [1, 0, 0, 1, move.shift[0], move.shift[1]];
          const place = async (source, x, y, rect, fill) => {
            if (shift) return transformedPixels(source, x, y, rect, shift, fill === undefined ? undefined : fill ? "#fff" : "#000");
            const { data } = pixelsOf(source, x, y, rect);
            const out = await aligner.ask("warp", { data: data.buffer, width: rect.width, height: rect.height, x: rect.left, y: rect.top, matrix: move.matrix, fill: fill === undefined ? undefined : fill ? 255 : 0 }, [data.buffer]);
            return { canvas: canvasOfBytes(out), left: out.left, top: out.top };
          };
          let p;
          let mask = pageMask(layer, doc);
          try {
            p = await place(visual.canvas, visual.x, visual.y, part);
            if (mask && mask.canvas) {
              const x = mask.left || 0;
              const y = mask.top || 0;
              const m = await place(mask.canvas, x, y, rectFrom(x, y, x + mask.canvas.width, y + mask.canvas.height), Boolean(mask.defaultColor));
              mask = Object.assign({}, mask, { canvas: m.canvas, left: m.left, top: m.top, right: m.left + m.canvas.width, bottom: m.top + m.canvas.height });
            }
          } catch (error) {
            // Taken too far to draw (past the horizon, or far too big): it stays where it was
            console.warn("TypeR web: a layer could not be aligned", error);
            found.failed.push(move.id);
            continue;
          }
          const next = withPixels(layer, p.canvas, p.left, p.top, mask);
          if (layer.isBackground) Object.assign(next, { isBackground: false, name: `${(app.names && app.names.layer) || "Layer"} 0` });
          changed.set(layer.id, next);
          progress(85 + Math.round(((index + 1) / found.moves.length) * 15));
        }
        if (settle) await settle(doc);
        // The page stayed free meanwhile: the result lands as long as the layers it compared
        // are as they were. The others may have changed.
        if (!app.docs.includes(doc)) return null;
        const now = new Map(doc.state.layers.map((layer) => [layer.id, layer]));
        if (picked.some(({ layer }) => now.get(layer.id) !== layer)) return null;
        if (changed.size) {
          commitState(doc, "Auto-Align Layers", { layers: doc.state.layers.map((layer) => changed.get(layer.id) || layer) });
          firePanelEvent(EVENT_HISTORY);
        }
        return { moved: changed.size, failed: found.failed.length, resized: (found.resized || []).filter((id) => changed.has(id)).length, total: picked.length };
      } finally {
        aligner.stop();
      }
    },
    // The Crop tool: the page becomes a part of what it was, or more than it was. Cropped pixels
    // stay on their layers, as with Canvas Size, unless they are to go.
    crop(left, top, right, bottom, fill, removeHidden) {
      const doc = app.doc;
      if (!doc) return;
      const width = right - left;
      const height = bottom - top;
      if (!left && !top && width === doc.width && height === doc.height) return;
      let layers = onNewCanvas(doc, width, height, -left, -top, fill);
      if (removeHidden) {
        layers = layers.map((layer) => {
          if (layer.kind !== "raster" || layer.isBackground) return layer;
          const visual = visualOf(Object.assign({}, layer, { mask: null, vectorMask: null }), doc);
          if (!visual) return layer;
          const bitmap = newCanvas(width, height);
          bitmap.getContext("2d").drawImage(visual.canvas, visual.x, visual.y);
          return withPixels(layer, bitmap, 0, 0, pageMask(layer, doc));
        });
      }
      resizeDoc(doc, "Crop", { width, height }, layers, surfacesShifted(doc, -left, -top), (x, y) => [x - left, y - top]);
    },
    // An image dropped on a side of the page, for double pages: the page grows on that side
    // and the image goes there, on a layer of its own under everything that sits on the page.
    addPage(bitmap, name, side, fill) {
      const doc = app.doc;
      if (!doc) return null;
      const width = doc.width + bitmap.width;
      const height = Math.max(doc.height, bitmap.height);
      const layers = onNewCanvas(doc, width, height, side === "left" ? bitmap.width : 0, 0, fill);
      const layer = newRaster(name, { bitmap, left: side === "left" ? 0 : doc.width, top: 0 });
      let at = layers[0] && layers[0].isBackground ? 1 : 0;
      while (layers[at] && layers[at].clipping) at++;
      layers.splice(at, 0, layer);
      resizeDoc(doc, "Add Page", { width, height }, layers, Object.assign({ activeIds: [layer.id] }, surfacesShifted(doc, side === "left" ? bitmap.width : 0, 0)), (x, y) => [x + (side === "left" ? bitmap.width : 0), y]);
      firePanelEvent(EVENT_SELECT);
      return layer;
    },
    // Image > Image Size: everything scales. A new resolution alone only renames the sizes:
    // the pixels stay as they are, and a text in points stays as many pixels tall.
    resizeImage(width, height, resolution) {
      const doc = app.doc;
      if (!doc || (width === doc.width && height === doc.height && resolution === doc.resolution)) return;
      const sx = width / doc.width;
      const sy = height / doc.height;
      const points = (sy * doc.resolution) / resolution;
      const layers = doc.state.layers.map((layer) => {
        if (sx === 1 && sy === 1) return layer.kind === "text" ? scaledText(layer, sx, sy, points) : layer;
        if (layer.kind === "text") return Object.assign(scaledText(layer, sx, sy, points), scaledMasks(layer, doc, sx, sy));
        if (layer.kind === "group") return layer.mask || layer.vectorMask ? Object.assign({}, layer, scaledMasks(layer, doc, sx, sy)) : layer;
        return scaledRaster(layer, doc, sx, sy);
      });
      resizeDoc(doc, "Image Size", { width, height, resolution }, layers, surfacesScaled(doc, sx, sy), (x, y) => [x * sx, y * sy]);
    },
    // The Magic Eraser: what a click on the active pixel layer takes, as the Magic Wand would,
    // goes transparent. A Background becomes Layer 0 first, as in Photoshop: it can't be.
    magicErase(x, y) {
      const doc = app.doc;
      const layer = doc && activeRaster(doc);
      if (!layer || layer.adjustment) return false;
      // A Background's own locks (its transparency and its place, which a PSD's keeps) don't
      // stop it: it becomes a layer, without them
      if (lockOf(layer, "pixels") || (!layer.isBackground && lockOf(layer, "transparency"))) {
        emit("layer-locked");
        return false;
      }
      const region = magicRegion(doc, layer, x, y);
      if (!region) return false;
      const op = { t: "fill", erase: true, clip: { canvas: region.canvas, x: region.x - (layer.dx || 0), y: region.y - (layer.dy || 0) } };
      const changes = { paint: (layer.paint || NONE).concat([op]) };
      if (layer.isBackground) Object.assign(changes, { isBackground: false, locks: undefined, name: `${(app.names && app.names.layer) || "Layer"} 0` });
      commitState(doc, "Magic Eraser", { layers: replaceLayer(doc, layer, changes) });
      return true;
    },
    // bubbleOnly: a finger's tap that pastes the script's line. What isn't a bubble is left
    // unselected, and false says so.
    wandAt(x, y, mode, bubbleOnly) {
      const doc = app.doc;
      if (!doc) return null;
      // Beside the page there is nothing to select: a click there lets go of the selection
      if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return !mode || mode === "new" ? ops.deselect() : null;
      const selection = floodSelect(doc, x, y, app.tolerance);
      if (bubbleOnly && !looksLikeBubble(doc, selection)) return false;
      selection.trigger = { source: "wand", x: Math.round(x), y: Math.round(y) };
      return ops.userSelection(selection, "Magic Wand", mode);
    },
    // What the Quick Selection Tool reads (quick-select.js): the page as the Magic Wand reads
    // it, with every layer or the active pixel layer alone, and a key that changes when those
    // pixels do
    quickSelectSource(everyLayer) {
      const doc = app.doc;
      if (!doc) return null;
      const data = sampleData(doc, everyLayer, true);
      return { data, width: doc.width, height: doc.height, key: `${doc.id}|${doc.sampleKey}` };
    },
    // The Quick Selection Tool's stroke as it grows: `part` is what the stroke selects so far, a
    // byte per pixel of its box of the page (null: nothing), put together with `base`, the
    // selection there was before the stroke. The whole stroke is one step of history (`token`).
    // The panel hears of it once, at the end (`done`), and not as a click to paste into: it is
    // a tool for cleaning, as in Photoshop, where TypeR doesn't paste into its selections either.
    quickSelection(part, mode, base, token, done) {
      const doc = app.doc;
      if (!doc) return null;
      const grown = part ? fromBoxMask(part.mask, part.left, part.top, part.width, part.height, "quick") : null;
      let final = grown;
      if (mode === "subtract") final = base && grown ? combineSelections(doc, base, grown, "subtract") : base;
      else if (mode === "add" && base) final = grown ? combineSelections(doc, base, grown, "add") : base;
      final = final || null;
      if (!final && !doc.state.selection) return null;
      commitState(doc, "Quick Selection", { selection: final, lastSelection: final || doc.state.lastSelection }, token);
      emit("selection", final);
      if (done) firePanelEvent(EVENT_HISTORY);
      return final;
    },
    // Color Range reads what the Magic Wand reads with all layers: the page, never the text
    colorRangeSource(maxSide) {
      const doc = app.doc;
      if (!doc) return null;
      const data = sampleData(doc, true);
      const scale = Math.min(1, maxSide / Math.max(doc.width, doc.height));
      const width = Math.max(1, Math.round(doc.width * scale));
      const height = Math.max(1, Math.round(doc.height * scale));
      const full = newCanvas(doc.width, doc.height);
      full.getContext("2d").putImageData(new ImageData(data, doc.width, doc.height), 0, 0);
      const small = newCanvas(width, height);
      const ctx = small.getContext("2d", { willReadFrequently: true });
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(full, 0, 0, width, height);
      const image = ctx.getImageData(0, 0, width, height);
      // Only inside the selection, if there is one, as in Photoshop
      const selection = doc.state.selection;
      let inside = null;
      if (selection) {
        inside = new Uint8Array(width * height);
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) inside[y * width + x] = selectionContains(selection, (x + 0.5) / scale, (y + 0.5) / scale) ? 1 : 0;
        }
      }
      return { image, width, height, scale, inside };
    },
    colorRangePreview(source, settings) {
      const cover = rangeCoverage(source.image.data, source.width, source.height, settings, source.scale);
      if (source.inside) for (let i = 0; i < cover.length; i++) if (!source.inside[i]) cover[i] = 0;
      return cover;
    },
    colorAt(x, y) {
      const doc = app.doc;
      if (!doc) return null;
      const px = Math.floor(x);
      const py = Math.floor(y);
      if (px < 0 || py < 0 || px >= doc.width || py >= doc.height) return null;
      const data = sampleData(doc, true);
      const i = (py * doc.width + px) * 4;
      return [data[i], data[i + 1], data[i + 2]];
    },
    // What belongs half or more becomes the selection, within the one there was.
    // Returns false when no pixel does, and the selection stays as it was.
    colorRange(settings) {
      const doc = app.doc;
      if (!doc) return false;
      const cover = rangeCoverage(sampleData(doc, true), doc.width, doc.height, settings);
      const inside = doc.state.selection ? fullMaskOf(doc, doc.state.selection) : null;
      const full = new Uint8Array(cover.length);
      for (let i = 0; i < full.length; i++) full[i] = cover[i] >= 128 && (!inside || inside[i]) ? 1 : 0;
      const selection = fromFullMask(doc, full, "colorRange");
      if (!selection) return false;
      ops.quietSelection(selection, "Color Range");
      return true;
    },
    rectangle(left, top, right, bottom, mode) {
      const doc = app.doc;
      if (!doc) return null;
      const b = rectFrom(Math.round(Math.max(0, left)), Math.round(Math.max(0, top)), Math.round(Math.min(doc.width, right)), Math.round(Math.min(doc.height, bottom)));
      if (b.width < 4 || b.height < 4) return mode && mode !== "new" ? null : ops.deselect();
      return ops.userSelection(makeSelection({ rect: b }), "Rectangular Marquee", mode);
    },
    ellipse(left, top, right, bottom, mode) {
      const doc = app.doc;
      if (!doc) return null;
      const selection = right - left >= 4 && bottom - top >= 4 ? ellipseSelection(doc, left, top, right, bottom) : null;
      if (!selection) return mode && mode !== "new" ? null : ops.deselect();
      return ops.userSelection(selection, "Elliptical Marquee", mode);
    },
    lasso(points, mode, name = "Lasso") {
      const doc = app.doc;
      if (!doc || points.length < 3) return mode && mode !== "new" ? null : ops.deselect();
      const selection = polygonSelection(doc, points);
      if (!selection) return ops.deselect();
      return ops.userSelection(selection, name, mode);
    },
    userSelection(selection, name, mode) {
      const doc = app.doc;
      const current = doc.state.selection;
      const combining = mode && mode !== "new" && current;
      let final = selection;
      let label = name;
      if (combining) {
        final = combineSelections(doc, current, selection, mode);
        label = { add: "Add to Selection", subtract: "Subtract from Selection", intersect: "Intersect Selection" }[mode];
        if (!final) return ops.deselect();
      }
      commitState(doc, label, { selection: final, lastSelection: final });
      emit("selection", final);
      // Only a new selection is a click TypeR can paste into
      if (combining) firePanelEvent(EVENT_HISTORY);
      else {
        const descriptor = descriptorFor(final);
        fireWhenIdle(() => firePanelEvent(EVENT_SET, descriptor));
      }
      return final;
    },
    // Selections from the menu never trigger a paste
    quietSelection(selection, name) {
      const doc = app.doc;
      if (!doc) return null;
      commitState(doc, name, { selection, lastSelection: selection || doc.state.lastSelection });
      emit("selection", selection);
      firePanelEvent(EVENT_HISTORY);
      return selection;
    },
    selectAll() {
      const doc = app.doc;
      if (doc) ops.quietSelection(makeSelection({ rect: rectFrom(0, 0, doc.width, doc.height) }), "Select All");
    },
    invert() {
      const doc = app.doc;
      if (!doc || !doc.state.selection) return;
      const inverted = invertSelection(doc, doc.state.selection);
      if (inverted) ops.quietSelection(inverted, "Inverse");
      else ops.deselect();
    },
    reselect() {
      const doc = app.doc;
      if (doc && doc.state.lastSelection && !doc.state.selection) ops.quietSelection(doc.state.lastSelection, "Reselect");
    },
    grow(radius) {
      const doc = app.doc;
      if (!doc || !doc.state.selection || !radius) return;
      const next = growSelection(doc, doc.state.selection, radius);
      if (next) ops.quietSelection(next, radius > 0 ? "Expand" : "Contract");
      else ops.deselect();
    },
    selectionContains(x, y) {
      const doc = app.doc;
      return Boolean(doc && doc.state.selection && selectionContains(doc.state.selection, x, y));
    },
    nudgeSelection(dx, dy, coalesce) {
      const doc = app.doc;
      if (!doc || !doc.state.selection) return;
      const moved = translateSelection(doc.state.selection, dx, dy);
      commitState(doc, "Move Selection", { selection: moved, lastSelection: moved }, coalesce);
      emit("selection", moved);
    },
    deselect() {
      const doc = app.doc;
      if (!doc || !doc.state.selection) return null;
      commitState(doc, "Deselect", { selection: null });
      emit("selection", null);
      return null;
    },
    selectLayer(id, additive) {
      const doc = app.doc;
      if (!doc) return;
      const ids = additive ? (doc.state.activeIds.includes(id) ? doc.state.activeIds.filter((item) => item !== id) : doc.state.activeIds.concat([id])) : [id];
      setActiveIds(doc, ids);
      emit("history");
      emit("active");
      firePanelEvent(EVENT_SELECT);
    },
    // No active layer: on a touch screen, what hides the handles and the text's actions
    clearActiveLayers() {
      const doc = app.doc;
      if (!doc || !doc.state.activeIds.length) return;
      setActiveIds(doc, []);
      emit("history");
      emit("active");
      firePanelEvent(EVENT_SELECT);
    },
    // Several layers chosen at once (a Shift + click), without a word to anyone: the caller draws
    // them. An undo keeps them chosen, as selectLayer's.
    chooseLayers(ids) {
      const doc = app.doc;
      if (doc) setActiveIds(doc, ids.slice());
    },
    toggleLayer(id) {
      const doc = app.doc;
      if (!doc) return;
      const layer = doc.state.layers.find((item) => item.id === id);
      if (!layer) return;
      commitState(doc, layer.visible === false ? "Show Layer" : "Hide Layer", { layers: replaceLayer(doc, layer, { visible: layer.visible === false }) });
    },
    setLayerProps(id, changes, name, coalesce) {
      const doc = app.doc;
      const layer = doc && doc.state.layers.find((item) => item.id === id);
      if (!layer) return;
      commitState(doc, name || "Layer Properties", { layers: replaceLayer(doc, layer, changes) }, coalesce);
    },
    // A whole new list of layers in one step, as an SFX lays out its letters again. `amend`
    // puts it in the step just made instead, as when a pasted line turns into an SFX.
    setLayers(layers, name, { coalesce, activeIds, amend, selection } = {}) {
      const doc = app.doc;
      if (!doc) return;
      const change = { layers };
      if (activeIds) change.activeIds = activeIds.filter((id) => layers.some((layer) => layer.id === id));
      if (selection !== undefined) change.selection = selection;
      if (amend) {
        const before = doc.state;
        doc.state = Object.assign({}, doc.state, change);
        const settled = settleSurfaces(doc, before);
        if (settled) doc.state = Object.assign({}, doc.state, { layers: settled });
        doc.history[doc.historyIndex].state = doc.state;
        emit("history");
        emit("render");
      } else commitState(doc, name, change, coalesce);
      if (selection === null) emit("selection", null);
      firePanelEvent(activeIds ? EVENT_SELECT : EVENT_HISTORY);
    },
    // While a text is dragged, moved by dx, dy so far: how far it is from its bubble's sides
    // (see roomAround). Nothing for an SFX's letters, which go over the drawing.
    roomAround(id, dx, dy) {
      const doc = app.doc;
      const layer = doc && doc.state.layers.find((item) => item.id === id);
      if (!layer || layer.kind !== "text") return [];
      if (!othersKept || othersKept.layers !== doc.state.layers || othersKept.id !== id) {
        const byId = new Map(doc.state.layers.map((item) => [item.id, item]));
        const inSfx = Boolean(layer.sfx || (layer.group && byId.get(layer.group) && byId.get(layer.group).sfx));
        othersKept = {
          layers: doc.state.layers,
          id,
          box: inSfx ? null : boxOf(layer, doc),
          boxes: doc.state.layers.filter((item) => item.kind === "text" && item.id !== id && chainOf(item, byId).visible).map((item) => boxOf(item, doc)),
        };
      }
      const b = othersKept.box;
      if (!b || !(b.width > 0 && b.height > 0)) return [];
      return roomAround(doc, rectFrom(b.left + dx, b.top + dy, b.right + dx, b.bottom + dy), othersKept.boxes);
    },
    // The live part of a move: only the picture on screen changes until it ends
    beginLiveMove(ids) {
      const doc = app.doc;
      if (!doc) return [];
      const list = movableIds(doc, ids);
      doc.live = { ids: new Set(list), dx: 0, dy: 0 };
      return list;
    },
    updateLiveMove(dx, dy) {
      const doc = app.doc;
      if (!doc || !doc.live) return;
      const before = liveBounds(doc);
      doc.live.dx = dx;
      doc.live.dy = dy;
      const after = liveBounds(doc);
      emit("render", before && after ? pageRect(doc, Math.min(before.left, after.left), Math.min(before.top, after.top), Math.max(before.right, after.right), Math.max(before.bottom, after.bottom)) : undefined);
    },
    endLiveMove(commit) {
      const doc = app.doc;
      if (!doc || !doc.live) return;
      const { ids, dx, dy } = doc.live;
      const x = Math.round(dx);
      const y = Math.round(dy);
      // Let go where it was, or given up: back in its place, the page is drawn again where it
      // was shown and where it is. A click that moved nothing leaves the page as it is.
      let back = NO_RECT;
      if ((x || y) && !commit) {
        const shown = liveBounds(doc);
        doc.live.dx = 0;
        doc.live.dy = 0;
        const home = liveBounds(doc);
        back = shown && home ? pageRect(doc, Math.min(shown.left, home.left), Math.min(shown.top, home.top), Math.max(shown.right, home.right), Math.max(shown.bottom, home.bottom)) : undefined;
      }
      doc.live = null;
      if (commit && (x || y)) ops.moveLayers(Array.from(ids), x, y);
      else emit("render", back);
    },
    moveLayers(ids, dx, dy, coalesce) {
      const doc = app.doc;
      if (!doc || (!dx && !dy)) return;
      const list = movableIds(doc, ids);
      if (!list.length) return;
      const set = new Set(list);
      // A folder that moves whole takes its masks along
      ids.forEach((id) => familyOf(doc.state.layers, id).forEach((member) => {
        const layer = doc.state.layers.find((item) => item.id === member);
        if (layer && layer.kind === "group" && !layer.locked && (layer.mask || layer.vectorMask)) set.add(member);
      }));
      commitState(doc, "Move", { layers: doc.state.layers.map((layer) => (set.has(layer.id) ? shifted(layer, dx, dy, doc) : layer)) }, coalesce);
      firePanelEvent(EVENT_MOVE);
    },
    moveLayer(id, dx, dy) {
      ops.moveLayers([id], dx, dy);
    },
    // The top layer under a point: text by its box, pixels by what is painted there. A letter
    // of an SFX gives its SFX, unless `deep` asks for the letter itself.
    hitLayer(x, y, deep) {
      const doc = app.doc;
      if (!doc) return null;
      const layers = doc.state.layers;
      const byId = new Map(layers.map((layer) => [layer.id, layer]));
      const sfxOf = (layer) => {
        let found = null;
        for (let id = layer.group; id; ) {
          const parent = byId.get(id);
          if (!parent) break;
          if (parent.sfx) found = parent;
          id = parent.group;
        }
        return found;
      };
      // A clipped layer shows only on its base: a click there picks the base, as a gradient
      // clipped to a text gives the text, and moving the text takes the gradient along
      const clipped = clippingOf(layers).clipped;
      for (let i = layers.length - 1; i >= 0; i--) {
        const layer = layers[i];
        if (layer.kind === "group" || layer.locked || layer.isBackground || clipped.has(layer.id) || !chainOf(layer, byId).visible) continue;
        if (layer.kind === "text") {
          // A turned letter answers inside its own turned box, not the square around it
          let inside;
          if (meshOn(layer) && outlineOk(layer.outline)) {
            const outline = outlineOnPage(layer, doc);
            const near = window.TypeROutline.nearest(outline, x, y);
            inside = window.TypeROutline.contains(outline, x, y) || Boolean(near && near.distance <= 6);
          } else if (meshOn(layer)) inside = insidePolygon(meshOutline(layer, doc), x, y, 6);
          else if (layer.envelope && !layer.warp) {
            // A warped text shows away from its frame: picked where it shows
            const box = boxOf(layer, doc);
            inside = x >= box.left - 6 && x <= box.right + 6 && y >= box.top - 6 && y <= box.bottom + 6;
          } else if (layer.rotated && !layer.warp && skewedSpin(layer.spin)) inside = insidePolygon(turnedFrame(layer, doc).corners, x, y, 6);
          else if (layer.rotated && !layer.warp) {
            const f = turnedFrame(layer, doc);
            const [a, b, , d] = f.corners;
            const ux = b[0] - a[0];
            const uy = b[1] - a[1];
            const vx = d[0] - a[0];
            const vy = d[1] - a[1];
            const lu = Math.hypot(ux, uy) || 1;
            const lv = Math.hypot(vx, vy) || 1;
            const pu = ((x - a[0]) * ux + (y - a[1]) * uy) / lu;
            const pv = ((x - a[0]) * vx + (y - a[1]) * vy) / lv;
            inside = pu >= -6 && pu <= lu + 6 && pv >= -6 && pv <= lv + 6;
          } else {
            const box = frameOf(layer, doc);
            inside = x >= box.left - 6 && x <= box.right + 6 && y >= box.top - 6 && y <= box.bottom + 6;
          }
          if (inside) return (!deep && sfxOf(layer)) || layer;
          continue;
        }
        const visual = visualOf(layer, doc);
        if (!visual) continue;
        const px = Math.floor(x - visual.x);
        const py = Math.floor(y - visual.y);
        if (px < 0 || py < 0 || px >= visual.canvas.width || py >= visual.canvas.height) continue;
        if (!ops._hitCtx) {
          const hit = newCanvas(1, 1);
          ops._hitCtx = hit.getContext("2d", { willReadFrequently: true });
        }
        const hctx = ops._hitCtx;
        hctx.clearRect(0, 0, 1, 1);
        hctx.drawImage(visual.canvas, px, py, 1, 1, 0, 0, 1, 1);
        if (hctx.getImageData(0, 0, 1, 1).data[3] > 24) return layer;
      }
      return null;
    },
    // A paste is a layer too: one step that also drops the selection, as in Photoshop
    newLayer(name, above, fields, pasted) {
      const doc = app.doc;
      if (!doc) return null;
      const count = doc.state.layers.filter((layer) => layer.kind === "raster" && !layer.clean).length + 1;
      const layer = newRaster(name || `${(app.names && app.names.layer) || "Layer"} ${count}`, fields);
      const anchor = above !== undefined ? above : doc.state.activeIds[doc.state.activeIds.length - 1];
      const at = doc.state.layers.findIndex((item) => item.id === anchor);
      const layers = doc.state.layers.slice();
      if (at >= 0) {
        layer.group = layers[at].kind === "group" ? layers[at].id : layers[at].group;
        const slot = layers[at].kind === "group" ? at : at + 1;
        layers.splice(slot, 0, layer);
        // Inside a clipping mask, it joins it, as in Photoshop: clipped when the layer above is
        const over = layers[slot + 1];
        if (!pasted && over && over.clipping && over.kind !== "group" && (over.group || null) === (layer.group || null)) layer.clipping = true;
      } else layers.push(layer);
      const hadSelection = Boolean(doc.state.selection);
      commitState(doc, pasted ? "Paste" : "New Layer", pasted ? { layers, activeIds: [layer.id], selection: null } : { layers, activeIds: [layer.id] });
      if (pasted && hadSelection) emit("selection", null);
      firePanelEvent(EVENT_SELECT);
      return layer;
    },
    newGroup(name) {
      const doc = app.doc;
      if (!doc) return null;
      const group = { id: newId(), kind: "group", name: name || "Group", visible: true, opacity: 1, blend: "pass through", open: true, group: null };
      commitState(doc, "New Group", { layers: doc.state.layers.concat([group]), activeIds: [group.id] });
      return group;
    },
    duplicateLayers() {
      const doc = app.doc;
      if (!doc) return;
      const layers = doc.state.layers.slice();
      const created = [];
      doc.state.activeIds.forEach((id) => {
        const at = layers.findIndex((item) => item.id === id);
        if (at < 0 || layers[at].kind === "group") return;
        const copy = Object.assign({}, layers[at], { id: newId(), name: layers[at].name + " copy", isBackground: false, raw: layers[at].raw ? Object.assign({}, layers[at].raw) : undefined });
        layers.splice(at + 1, 0, copy);
        created.push(copy.id);
      });
      if (created.length) commitState(doc, "Duplicate Layer", { layers, activeIds: created });
    },
    // Cmd+J with a selection on one pixel layer, Photoshop's Layer via Copy: only the selected
    // pixels, on a new layer just above, which looks like its source; the selection is dropped.
    // null when it doesn't apply (Cmd+J then duplicates the whole layer), "empty" when the
    // selection holds none of the layer's pixels.
    layerViaCopy(name) {
      const doc = app.doc;
      const selection = doc && doc.state.selection;
      if (!selection || doc.state.activeIds.length !== 1) return null;
      const layer = activeRaster(doc);
      if (!layer) return null;
      const visual = rasterVisual(layer, doc);
      if (!visual) return "empty";
      const b = selection.bounds;
      const left = Math.max(Math.floor(b.left), Math.floor(visual.x));
      const top = Math.max(Math.floor(b.top), Math.floor(visual.y));
      const right = Math.min(Math.ceil(b.right), Math.ceil(visual.x + visual.canvas.width));
      const bottom = Math.min(Math.ceil(b.bottom), Math.ceil(visual.y + visual.canvas.height));
      if (right <= left || bottom <= top) return "empty";
      const bitmap = newCanvas(right - left, bottom - top);
      const ctx = bitmap.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(visual.canvas, visual.x - left, visual.y - top);
      const clip = clipOf(selection, 0, 0);
      if (clip.canvas) {
        ctx.globalCompositeOperation = "destination-in";
        ctx.drawImage(clip.canvas, clip.x - left, clip.y - top);
        ctx.globalCompositeOperation = "source-over";
      }
      const alpha = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let any = false;
      for (let i = 3; i < alpha.length && !any; i += 4) any = alpha[i] > 0;
      if (!any) return "empty";
      const copy = newRaster(name || layer.name + " copy", { bitmap, left, top, opacity: layer.opacity, blend: layer.blend, fill: layer.fill, knockout: layer.knockout, stroke: layer.stroke ? clone(layer.stroke) : undefined, effects: layer.effects ? clone(layer.effects) : undefined, group: layer.group || null, clipping: Boolean(layer.clipping) });
      const layers = doc.state.layers.slice();
      layers.splice(layers.indexOf(layer) + 1, 0, copy);
      commitState(doc, "Duplicate Layer", { layers, activeIds: [copy.id], selection: null });
      emit("selection", null);
      firePanelEvent(EVENT_SELECT);
      return copy;
    },
    // The selected layers in a new group, where the topmost of them was
    groupLayers(name) {
      const doc = app.doc;
      if (!doc) return null;
      const layers = doc.state.layers;
      const chosen = doc.state.activeIds.filter((id) => {
        const layer = layers.find((item) => item.id === id);
        return layer && !layer.isBackground;
      });
      if (!chosen.length) return null;
      const moving = new Set();
      chosen.forEach((id) => familyOf(layers, id).forEach((member) => moving.add(member)));
      const members = layers.filter((layer) => moving.has(layer.id));
      const roots = members.filter((layer) => !moving.has(layer.group));
      const topRoot = roots[roots.length - 1];
      const group = { id: newId(), kind: "group", name: name || "Group", visible: true, opacity: 1, blend: "pass through", open: true, group: topRoot.group || null };
      const lastAt = layers.lastIndexOf(members[members.length - 1]);
      const rest = layers.filter((layer) => !moving.has(layer.id));
      const at = layers.slice(0, lastAt).filter((layer) => !moving.has(layer.id)).length;
      const moved = members.map((layer) => (roots.includes(layer) ? Object.assign({}, layer, { group: group.id }) : layer));
      commitState(doc, "Group Layers", { layers: rest.slice(0, at).concat(moved, [group], rest.slice(at)), activeIds: [group.id] });
      firePanelEvent(EVENT_SELECT);
      return group;
    },
    ungroupLayers() {
      const doc = app.doc;
      if (!doc) return;
      const groups = doc.state.layers.filter((layer) => layer.kind === "group" && doc.state.activeIds.includes(layer.id));
      if (!groups.length) return;
      const gone = new Map(groups.map((group) => [group.id, group]));
      const parentOf = (id) => {
        let parent = id;
        while (parent && gone.has(parent)) parent = gone.get(parent).group || null;
        return parent || null;
      };
      const freed = doc.state.layers.filter((layer) => gone.has(layer.group)).map((layer) => layer.id);
      const layers = doc.state.layers.filter((layer) => !gone.has(layer.id)).map((layer) => (gone.has(layer.group) ? Object.assign({}, layer, { group: parentOf(layer.group) }) : layer));
      commitState(doc, "Ungroup Layers", { layers, activeIds: freed.filter((id) => layers.some((layer) => layer.id === id)) });
      firePanelEvent(EVENT_SELECT);
    },
    // Layers carried to another page. Their pixels are never drawn on again, so they can be
    // shared; only what depends on the page's size changes when they land.
    copyLayers() {
      const doc = app.doc;
      if (!doc || !doc.state.activeIds.length) return 0;
      const chosen = new Set();
      doc.state.activeIds.forEach((id) => familyOf(doc.state.layers, id).forEach((member) => chosen.add(member)));
      const layers = doc.state.layers.filter((layer) => chosen.has(layer.id));
      app.layerClipboard = { layers, width: doc.width, height: doc.height };
      return layers.length;
    },
    pasteLayers() {
      const doc = app.doc;
      const held = app.layerClipboard;
      if (!doc || !held) return 0;
      const ids = new Map(held.layers.map((layer) => [layer.id, newId()]));
      const copies = held.layers.map((layer) => {
        const copy = Object.assign({}, layer, { id: ids.get(layer.id), group: ids.get(layer.group) || null, isBackground: false, clean: false, raw: layer.raw ? Object.assign({}, layer.raw) : undefined });
        if (layer.kind === "text") {
          copy.params = clone(layer.params);
          const point = copy.params.layerText.textClickPoint;
          point.horizontal = ((point.horizontal / 100) * held.width / doc.width) * 100;
          point.vertical = ((point.vertical / 100) * held.height / doc.height) * 100;
        }
        return copy;
      });
      commitState(doc, "Paste Layers", { layers: doc.state.layers.concat(copies), activeIds: copies.filter((layer) => !layer.group).map((layer) => layer.id) });
      firePanelEvent(EVENT_SELECT);
      return copies.length;
    },
    // A layer's look (a text's without its words), from one layer to others
    copyLayerStyle() {
      const doc = app.doc;
      const id = doc && doc.state.activeIds[doc.state.activeIds.length - 1];
      const layer = doc && doc.state.layers.find((item) => item.id === id);
      if (!layer) return false;
      const lt = layer.kind === "text" ? layer.params.layerText : null;
      app.styleClipboard = {
        text: lt ? clone(lt.textStyleRange[0].textStyle) : null,
        paragraph: lt ? clone(lt.paragraphStyleRange[0].paragraphStyle) : null,
        antiAlias: lt ? lt.antiAlias : null,
        stroke: layer.stroke ? clone(layer.stroke) : null,
        effects: styleable(layer) && layer.effects ? clone(layer.effects) : null,
        blend: layer.blend,
        opacity: layer.opacity,
        // Fill too, as Photoshop's blending options: a text's blur (see textBlurOf) goes with it
        fill: styleable(layer) ? fillOf(layer) : 1,
      };
      return true;
    },
    pasteLayerStyle() {
      const doc = app.doc;
      const held = app.styleClipboard;
      if (!doc || !held) return;
      const chosen = new Set(doc.state.activeIds);
      const byId = new Map(doc.state.layers.map((layer) => [layer.id, layer]));
      // An SFX's letters are drawn again from its recipe: effects on them would be lost
      const inSfx = (layer) => {
        for (let id = layer.group; id; ) {
          const parent = byId.get(id);
          if (!parent) return false;
          if (parent.sfx) return true;
          id = parent.group;
        }
        return false;
      };
      const layers = doc.state.layers.map((layer) => {
        if (!chosen.has(layer.id)) return layer;
        // A folder takes the stroke, the effects and the Fill, as in Photoshop, and stays in its
        // own blend mode. An SFX's stroke and Fill are its recipe's: only the effects.
        if (layer.kind === "group") {
          const styled = Object.assign({}, layer, { effects: held.effects ? clone(held.effects) : undefined });
          if (!layer.sfx) {
            styled.stroke = held.stroke ? clone(held.stroke) : undefined;
            if (held.fill !== undefined) Object.assign(styled, { knockout: held.fill <= 0, fill: held.fill > 0 && held.fill < 1 ? held.fill : undefined });
          }
          return styled;
        }
        const next = Object.assign({}, layer);
        if (layer.kind !== "text" || held.text) {
          next.blend = held.blend;
          next.opacity = held.opacity;
        }
        // A pixel layer takes the stroke and the effects too, as in Photoshop (not the
        // Background, which has none)
        if (styleable(layer) && layer.kind === "raster" && !layer.isBackground) {
          next.stroke = held.stroke ? clone(held.stroke) : undefined;
          next.effects = held.effects ? clone(held.effects) : undefined;
          if (held.fill !== undefined) Object.assign(next, { knockout: false, fill: held.fill < 1 ? held.fill : undefined });
        }
        if (layer.kind !== "text") return next;
        // From a pixel layer or a folder, a text takes what they have in common: the stroke, the
        // effects and the blending, its letters as they are (not an SFX's, drawn from its recipe)
        if (!held.text) {
          if (inSfx(layer)) return layer;
          return Object.assign(next, { blend: held.blend, opacity: held.opacity, stroke: held.stroke ? clone(held.stroke) : null, effects: held.effects ? clone(held.effects) : undefined, knockout: held.fill <= 0, fill: held.fill > 0 && held.fill < 1 ? held.fill : undefined, raster: null });
        }
        const box = boxOf(layer, doc);
        next.params = clone(layer.params);
        const lt = next.params.layerText;
        lt.textStyleRange.forEach((range) => { range.textStyle = clone(held.text); });
        lt.paragraphStyleRange.forEach((range) => { range.paragraphStyle = Object.assign(range.paragraphStyle, clone(held.paragraph)); });
        if (held.antiAlias) lt.antiAlias = held.antiAlias;
        next.stroke = held.stroke ? clone(held.stroke) : null;
        if (!inSfx(layer)) {
          next.effects = held.effects ? clone(held.effects) : undefined;
          if (held.fill !== undefined) Object.assign(next, { knockout: held.fill <= 0, fill: held.fill > 0 && held.fill < 1 ? held.fill : undefined });
        }
        next.raster = null;
        return boxShape(lt) ? next : centredOn(next, doc, box.xMid, box.yMid);
      });
      if (layers.every((layer, at) => layer === doc.state.layers[at])) return;
      commitState(doc, "Paste Layer Style", { layers });
      firePanelEvent(EVENT_HISTORY);
    },
    // A layer's pixels as a selection. It's not a click: TypeR doesn't paste into it.
    selectLayerPixels(id, mode) {
      const doc = app.doc;
      const layer = doc && doc.state.layers.find((item) => item.id === id);
      // As Photoshop's: the layer's own pixels, without the shadow or the glow of its effects
      const visual = layer && visualOf(layer.effects ? Object.assign({}, layer, { effects: undefined }) : layer, doc);
      if (!visual || !visual.canvas.width || !visual.canvas.height) return null;
      const left = Math.max(0, Math.ceil(visual.x));
      const top = Math.max(0, Math.ceil(visual.y));
      const right = Math.min(doc.width, Math.floor(visual.x + visual.canvas.width));
      const bottom = Math.min(doc.height, Math.floor(visual.y + visual.canvas.height));
      if (right <= left || bottom <= top) return null;
      const pixels = visual.canvas.getContext("2d").getImageData(left - visual.x, top - visual.y, right - left, bottom - top).data;
      const width = right - left;
      const height = bottom - top;
      let x0 = width;
      let y0 = height;
      let x1 = -1;
      let y1 = -1;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (pixels[(y * width + x) * 4 + 3] < 128) continue;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
      if (x1 < 0) return null;
      const boxW = x1 - x0 + 1;
      const boxH = y1 - y0 + 1;
      const mask = new Uint8Array(boxW * boxH);
      for (let y = 0; y < boxH; y++) {
        for (let x = 0; x < boxW; x++) {
          if (pixels[((y + y0) * width + x + x0) * 4 + 3] >= 128) mask[y * boxW + x] = 1;
        }
      }
      const selection = makeSelection({ source: "layer", mask, boxW, boxH, left: left + x0, top: top + y0 });
      return mode ? ops.userSelection(selection, "Load Selection", mode) : ops.quietSelection(selection, "Load Selection");
    },
    // Every open page, each with its own history
    replaceFonts(faces) {
      let count = 0;
      app.docs.forEach((doc) => {
        let touched = false;
        const layers = doc.state.layers.map((layer) => {
          if (layer.kind !== "text" || !layer.params.layerText.textStyleRange.some((range) => faces[range.textStyle.fontPostScriptName])) return layer;
          const params = clone(layer.params);
          params.layerText.textStyleRange.forEach((range) => {
            const face = faces[range.textStyle.fontPostScriptName];
            if (face) Object.assign(range.textStyle, face);
          });
          touched = true;
          count++;
          return Object.assign({}, layer, { params, raster: null });
        });
        if (touched) commitState(doc, "Replace Fonts", { layers });
      });
      return count;
    },
    // Typing after this starts a history step of its own, whatever came just before
    sealHistory() {
      const doc = app.doc;
      if (doc) doc.history[doc.historyIndex].coalesce = null;
    },
    deleteLayers() {
      const doc = app.doc;
      if (!doc || !doc.state.activeIds.length) return;
      const gone = new Set();
      let refused = false;
      doc.state.activeIds.forEach((id) => {
        const family = Array.from(familyOf(doc.state.layers, id));
        if (family.some((member) => doc.state.layers.find((layer) => layer.id === member).locked)) refused = true;
        else family.forEach((member) => gone.add(member));
      });
      if (refused) emit("layer-locked");
      if (!gone.size) return;
      const layers = doc.state.layers.filter((layer) => !gone.has(layer.id));
      const top = layers[layers.length - 1];
      commitState(doc, "Delete Layer", { layers, activeIds: top ? [top.id] : [] });
      firePanelEvent(EVENT_SELECT);
    },
    // New place in the stack: before the index in the list without the moved rows
    reorderLayer(id, targetId, position) {
      ops.reorderLayers([id], targetId, position);
    },
    // Several layers at once, as the Layers panel drags them: each with what its folder holds,
    // in their order. With `copy` (Alt in Photoshop), copies go there and the layers stay.
    reorderLayers(ids, targetId, position, copy) {
      const doc = app.doc;
      if (!doc) return;
      const plan = reorderPlan(doc.state.layers, ids, targetId, position, copy);
      if (!plan) return;
      if (!copy) {
        commitState(doc, "Reorder Layer", { layers: plan.layers });
        return;
      }
      commitState(doc, "Duplicate Layer", { layers: plan.layers, activeIds: plan.activeIds });
      firePanelEvent(EVENT_SELECT);
    },
    // While layers are dragged in the panel, the page shows them where they would land
    previewOrder(ids, targetId, position) {
      const doc = app.doc;
      if (!doc) return;
      const plan = ids ? reorderPlan(doc.state.layers, ids, targetId, position, false) : null;
      const layers = plan ? plan.layers : null;
      if (layers === doc.orderPreview || (!layers && !doc.orderPreview)) return;
      doc.orderPreview = layers;
      emit("render");
    },
    // A blend mode tried from the Layers panel's list, shown before it is picked
    previewBlend(ids, blend) {
      const doc = app.doc;
      if (!doc) return;
      const next = blend ? { ids: new Set(ids), blend } : null;
      if (!next && !doc.blendPreview) return;
      if (next && doc.blendPreview && doc.blendPreview.blend === blend) return;
      doc.blendPreview = next;
      emit("render");
    },
    // Layers dragged from another page's panel: copied here, where they were dropped, or on top.
    // `place`: { dx, dy } to move them by, or { at: [x, y] }, the point they are centred on.
    pasteLayersFrom(source, ids, targetId, position, place) {
      const doc = app.doc;
      if (!doc || !source || source === doc) return 0;
      const chosen = new Set();
      ids.forEach((id) => familyOf(source.state.layers, id).forEach((member) => chosen.add(member)));
      const held = source.state.layers.filter((layer) => chosen.has(layer.id));
      if (!held.length) return 0;
      const fresh = new Map(held.map((layer) => [layer.id, newId()]));
      let copies = held.map((layer) => {
        const copy = Object.assign({}, layer, { id: fresh.get(layer.id), group: fresh.get(layer.group) || null, isBackground: false, clean: false, link: undefined, raw: layer.raw ? Object.assign({}, layer.raw) : undefined });
        if (layer.kind === "text") copy.params = textParamsIn(layer, source, doc);
        return copy;
      });
      if (place) {
        let dx = place.dx || 0;
        let dy = place.dy || 0;
        const boxes = place.at ? copies.filter((layer) => (layer.kind === "raster" && !layer.adjustment) || layer.kind === "text").map((layer) => (layer.kind === "text" ? boxOf(layer, doc) : trimmedBox(layer, doc))).filter(Boolean) : [];
        if (boxes.length) {
          dx = place.at[0] - (Math.min(...boxes.map((box) => box.left)) + Math.max(...boxes.map((box) => box.right))) / 2;
          dy = place.at[1] - (Math.min(...boxes.map((box) => box.top)) + Math.max(...boxes.map((box) => box.bottom))) / 2;
        }
        dx = Math.round(dx);
        dy = Math.round(dy);
        if (dx || dy) copies = copies.map((layer) => shifted(layer, dx, dy, doc));
      }
      const heads = copies.filter((layer) => !layer.group).map((layer) => layer.id);
      let layers = doc.state.layers.concat(copies);
      const target = targetId !== undefined && doc.state.layers.find((layer) => layer.id === targetId);
      if (target) {
        const plan = reorderPlan(layers, heads, target.id, position, false);
        if (plan) layers = plan.layers;
      }
      commitState(doc, "Paste Layers", { layers, activeIds: heads });
      firePanelEvent(EVENT_SELECT);
      return copies.length;
    },
    /* ---- a text that goes on from a page to the next (across.js) ---- */
    // A text of the page `from` as it is on the page `to`, whose corner is at (dx, dy) of
    // `from`: the same text, placed so that each page shows its part of it. `fields`: what is
    // its own there (its number, its folder).
    textOn(layer, from, to, dx, dy, fields) {
      const copy = Object.assign({}, layer, { params: textParamsIn(layer, from, to), clean: false, link: undefined, raw: layer.raw ? Object.assign({}, layer.raw) : undefined }, fields);
      return shifted(copy, -dx, -dy, to);
    },
    // A change to a page that may not be the one in front. `amend` puts it in the step just
    // made, as setLayers does.
    changeDoc(doc, name, change, { coalesce, amend } = {}) {
      if (!doc) return;
      // The page in front is drawn again; another one only as Flow shows it, in its own time
      const front = doc === app.doc;
      if (!amend) {
        commitState(doc, name, change, coalesce, front ? undefined : false);
        return;
      }
      // A font only tried out is not part of the step
      if (doc.stylePreview) endStylePreview(doc);
      doc.state = Object.assign({}, doc.state, change);
      doc.history[doc.historyIndex].state = doc.state;
      emit("history");
      if (front) emit("render");
    },
    // A page that may not be the one in front, at another step of its history, of the same size
    stepDoc(doc, index) {
      const entry = doc && doc.history[index];
      if (!entry || index === doc.historyIndex) return false;
      const now = sizeOf(doc);
      if (entry.size && (entry.size.width !== now.width || entry.size.height !== now.height || entry.size.resolution !== now.resolution)) return false;
      doc.historyIndex = index;
      doc.state = entry.state;
      emit("history");
      if (doc !== app.doc) return true;
      emit("selection", doc.state.selection);
      emit("render");
      firePanelEvent(EVENT_HISTORY);
      return true;
    },
    // Cmd + click on the New Layer button: under the active layer, as in Photoshop. Under a
    // clipped layer, it joins the clipping mask.
    newLayerBelow(name) {
      const doc = app.doc;
      if (!doc) return null;
      const active = doc.state.layers.find((layer) => layer.id === doc.state.activeIds[doc.state.activeIds.length - 1]);
      if (!active || active.isBackground) return ops.newLayer(name);
      const members = familyOf(doc.state.layers, active.id);
      const at = doc.state.layers.findIndex((layer) => members.has(layer.id));
      const layer = newRaster(name, { group: active.group || null, clipping: active.kind !== "group" && Boolean(active.clipping) });
      const layers = doc.state.layers.slice();
      layers.splice(at, 0, layer);
      commitState(doc, "New Layer", { layers, activeIds: [layer.id] });
      firePanelEvent(EVENT_SELECT);
      return layer;
    },
    mergeDown() {
      const doc = app.doc;
      if (!doc) return;
      const id = doc.state.activeIds[doc.state.activeIds.length - 1];
      const at = doc.state.layers.findIndex((layer) => layer.id === id);
      if (at < 1) return;
      const top = doc.state.layers[at];
      if (top.kind === "group") {
        ops.mergeGroup(top.id);
        return;
      }
      const below = doc.state.layers[at - 1];
      if (below.kind === "group") return;
      if (top.locked || below.locked) {
        emit("layer-locked");
        return;
      }
      // The merged pixels already have each layer's opacity in them. Two layers clipped to the
      // same base merge as they are, and the result stays clipped to it.
      const info = clippingOf(doc.state.layers);
      const bothClipped = info.clipped.has(top.id) && info.clipped.has(below.id);
      const merged = newRaster(below.name, { group: below.group, isBackground: below.isBackground, blend: below.blend, opacity: 1, clipping: bothClipped });
      merged.bitmap = paintAlone(doc, bothClipped ? [Object.assign({}, below, { clipping: false }), Object.assign({}, top, { clipping: false })] : [below, top]);
      const layers = doc.state.layers.slice();
      layers.splice(at - 1, 2, merged);
      commitState(doc, "Merge Layers", { layers, activeIds: [merged.id] });
    },
    // The selected layers into one, what shows of them. Alone, a layer goes into the one below.
    mergeSelected() {
      const doc = app.doc;
      if (!doc) return;
      if (doc.state.activeIds.length < 2) {
        ops.mergeDown();
        return;
      }
      const all = doc.state.layers;
      const chosen = new Set();
      doc.state.activeIds.forEach((id) => familyOf(all, id).forEach((member) => chosen.add(member)));
      const list = all.filter((layer) => chosen.has(layer.id) && layer.kind !== "group" && layer.visible !== false);
      // A folder goes into the merge whole, as in Photoshop: it and what it holds are gone after
      const folders = all.filter((layer) => layer.kind === "group" && doc.state.activeIds.includes(layer.id));
      if (list.length < 2 && !folders.length) return;
      const gone = new Set(list.map((layer) => layer.id));
      folders.forEach((folder) => familyOf(all, folder.id).forEach((member) => gone.add(member)));
      if (all.some((layer) => gone.has(layer.id) && layer.locked)) {
        emit("layer-locked");
        return;
      }
      const drawn = all.filter((layer) => gone.has(layer.id) && (layer.kind === "group" || layer.visible !== false));
      const bottom = list[0] || drawn[0];
      const top = drawn[drawn.length - 1];
      const anchor = bottom.isBackground ? bottom : top;
      const merged = newRaster(top.name, { group: bottom.isBackground ? null : outsideOf(anchor.group, gone, all), isBackground: Boolean(bottom.isBackground), blend: bottom.kind === "group" ? "normal" : bottom.blend, opacity: 1 });
      merged.bitmap = paintAlone(doc, drawn);
      const layers = all.flatMap((layer) => (layer === anchor ? [merged] : gone.has(layer.id) ? [] : [layer]));
      commitState(doc, "Merge Layers", { layers, activeIds: [merged.id] });
      firePanelEvent(EVENT_SELECT);
    },
    // A folder into one layer, in its place and with its name, opacity and blend mode, as
    // Photoshop's Merge Group. What's hidden inside it is dropped.
    mergeGroup(id) {
      const doc = app.doc;
      const all = doc ? doc.state.layers : [];
      const folder = all.find((layer) => layer.id === id && layer.kind === "group");
      if (!folder) return;
      const family = familyOf(all, id);
      if (all.some((layer) => family.has(layer.id) && layer.locked)) {
        emit("layer-locked");
        return;
      }
      // Its own opacity stays on the new layer, not in its pixels
      const whole = Object.assign({}, folder, { visible: true, opacity: 1 });
      const inside = all.filter((layer) => family.has(layer.id)).map((layer) => (layer === folder ? whole : layer));
      const merged = newRaster(folder.name, { group: folder.group || null, visible: folder.visible !== false, opacity: folder.opacity === undefined ? 1 : folder.opacity, blend: folder.blend === "pass through" ? "normal" : folder.blend || "normal" });
      merged.bitmap = paintAlone(doc, inside);
      const layers = all.flatMap((layer) => (layer === folder ? [merged] : family.has(layer.id) ? [] : [layer]));
      commitState(doc, "Merge Layers", { layers, activeIds: [merged.id] });
      firePanelEvent(EVENT_SELECT);
    },
    // All that shows into one layer, at the place of the lowest. What's hidden stays as it is.
    mergeVisible() {
      const doc = app.doc;
      if (!doc) return;
      const byId = new Map(doc.state.layers.map((layer) => [layer.id, layer]));
      const list = doc.state.layers.filter((layer) => layer.kind !== "group" && layer.visible !== false && chainOf(layer, byId).visible);
      if (list.length < 2) return;
      if (list.some((layer) => layer.locked)) {
        emit("layer-locked");
        return;
      }
      const gone = new Set(list.map((layer) => layer.id));
      const merged = newRaster(list[list.length - 1].name, { group: null, isBackground: list[0].isBackground, blend: "normal", opacity: 1 });
      const canvas = newCanvas(doc.width, doc.height);
      paintDoc(doc, canvas.getContext("2d"), { keep: true, skip: (layer) => !gone.has(layer.id) });
      merged.bitmap = canvas;
      let layers = doc.state.layers.flatMap((layer) => (layer === list[0] ? [merged] : gone.has(layer.id) ? [] : [layer]));
      // A group that held only what was merged is empty now
      for (let before = -1; before !== layers.length; ) {
        before = layers.length;
        layers = layers.filter((layer) => layer.kind !== "group" || layer.visible === false || layers.some((item) => item.group === layer.id));
      }
      commitState(doc, "Merge Visible", { layers, activeIds: [merged.id] });
      firePanelEvent(EVENT_SELECT);
    },
    flatten() {
      const doc = app.doc;
      if (!doc) return;
      const background = newRaster((app.names && app.names.background) || "Background", { isBackground: true });
      const canvas = newCanvas(doc.width, doc.height);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, doc.width, doc.height);
      paintDoc(doc, ctx, { keep: true });
      background.bitmap = canvas;
      commitState(doc, "Flatten Image", { layers: [background], activeIds: [background.id] });
    },
    rasterizeText(id) {
      const doc = app.doc;
      const layer = doc && doc.state.layers.find((item) => item.id === id && item.kind === "text");
      if (!layer) return;
      const raster = newRaster(layer.name, { group: layer.group, opacity: layer.opacity, blend: layer.blend, visible: layer.visible, clipping: layer.clipping, mask: layer.mask || null, vectorMask: layer.vectorMask || null, bitmap: flattenLayers(doc, [Object.assign({}, layer, { opacity: 1, blend: "normal", mask: null, vectorMask: null })]) });
      commitState(doc, "Rasterize Layer", { layers: doc.state.layers.map((item) => (item.id === id ? raster : item)), activeIds: [raster.id] });
    },
    /* ---- the work path (pen.js) ---- */
    // A document's work path, Photoshop's, drawn with the Pen: { paths } in the page's pixels,
    // each subpath as a vector mask has them (see tracePaths). Part of the history, and kept
    // in the PSD where Photoshop keeps it. null: none.
    setWorkPath(path, name, coalesce) {
      const doc = app.doc;
      if (!doc) return false;
      const next = path && Array.isArray(path.paths) && path.paths.length ? { paths: path.paths } : null;
      if (!next && !doc.state.workPath) return false;
      // Nothing of the page's picture changes
      commitState(doc, name || "Work Path", { workPath: next }, coalesce, false);
      return true;
    },
    // Make Selection: the work path as a selection, anti-aliased and feathered as asked.
    // `mode`: "add", "subtract" or "intersect" with the selection there is. Says whether the
    // path covered anything.
    selectPath(mode, { antiAlias = true, feather = 0 } = {}) {
      const doc = app.doc;
      const path = doc && doc.state.workPath;
      if (!path) return false;
      let picture = pathAlpha(doc, path, antiAlias, feather);
      const current = doc.state.selection;
      const combining = Boolean(mode && mode !== "new" && current);
      if (!picture && !combining) return false;
      if (combining) {
        // Both as pictures, so that their edges stay soft where they meet
        const a = selectionBox(doc, current);
        const box = picture ? { left: Math.min(a.left, picture.x), top: Math.min(a.top, picture.y), right: Math.max(a.right, picture.x + picture.canvas.width), bottom: Math.max(a.bottom, picture.y + picture.canvas.height) } : a;
        const canvas = newCanvas(box.right - box.left, box.bottom - box.top);
        const c = canvas.getContext("2d", { willReadFrequently: true });
        const clip = clipOf(current, box.left, box.top);
        if (clip.canvas) c.drawImage(clip.canvas, clip.x, clip.y);
        else c.fillRect(clip.x, clip.y, clip.width, clip.height);
        if (picture) {
          c.globalCompositeOperation = mode === "add" ? "source-over" : mode === "subtract" ? "destination-out" : "destination-in";
          c.drawImage(picture.canvas, picture.x - box.left, picture.y - box.top);
        } else if (mode === "intersect") c.clearRect(0, 0, canvas.width, canvas.height);
        picture = { canvas, x: box.left, y: box.top };
      }
      const selection = softSelection(picture);
      if (!selection) {
        if (combining) ops.deselect();
        return combining;
      }
      ops.quietSelection(selection, combining ? { add: "Add to Selection", subtract: "Subtract from Selection", intersect: "Intersect Selection" }[mode] : "Make Selection");
      return true;
    },
    // Fill Path: the work path's shape in a colour on the active pixel layer (a new one when
    // there is none), within the selection if there is one, as in Photoshop
    fillPath(color, { antiAlias = true, feather = 0 } = {}) {
      const doc = app.doc;
      const path = doc && doc.state.workPath;
      const picture = path && pathAlpha(doc, path, antiAlias, feather);
      if (!picture) return false;
      const selection = doc.state.selection;
      if (selection) {
        const c = picture.canvas.getContext("2d");
        const clip = clipOf(selection, picture.x, picture.y);
        c.globalCompositeOperation = "destination-in";
        if (clip.canvas) c.drawImage(clip.canvas, clip.x, clip.y);
        else c.fillRect(clip.x, clip.y, clip.width, clip.height);
      }
      const layer = activeRaster(doc) || ops.newLayer();
      if (lockOf(layer, "pixels")) {
        emit("layer-locked");
        return false;
      }
      const op = { t: "fill", color, clip: { canvas: picture.canvas, x: picture.x - (layer.dx || 0), y: picture.y - (layer.dy || 0) } };
      if (lockOf(layer, "transparency")) op.atop = true;
      commitState(doc, "Fill Path", { layers: replaceLayer(doc, layer, { paint: (layer.paint || NONE).concat([op]) }) });
      return true;
    },
    // The steps made since the one at `index` become a single one, under `name`: a path is
    // stroked one subpath after the other, and undone at once
    joinSteps(index, name) {
      const doc = app.doc;
      if (!doc || index < 0 || doc.historyIndex <= index || doc.historyIndex !== doc.history.length - 1) return;
      const last = doc.history[doc.historyIndex];
      doc.history.length = index + 1;
      doc.history.push(Object.assign({}, last, { name, coalesce: null }));
      doc.historyIndex = index + 1;
      emit("history");
    },
    /* ---- masks ---- */
    // What the brushes work on: the active layer's pixel or vector mask when its thumbnail is
    // targeted in the Layers panel, as in Photoshop. Not part of the history.
    maskTarget(doc = app.doc) {
      const t = doc && doc.maskTarget;
      if (!t || doc.state.activeIds.length !== 1 || doc.state.activeIds[0] !== t.id) return null;
      const layer = doc.state.layers.find((item) => item.id === t.id);
      if (!layer || !(t.part === "vector" ? layer.vectorMask : layer.mask)) return null;
      return { id: t.id, part: t.part, layer };
    },
    setMaskTarget(id, part) {
      const doc = app.doc;
      if (!doc) return;
      const before = ops.maskTarget(doc);
      doc.maskTarget = part ? { id, part } : null;
      const after = ops.maskTarget(doc);
      if (doc.maskView && (!after || after.id !== doc.maskView.id || after.part !== doc.maskView.part)) doc.maskView = null;
      if (Boolean(before) !== Boolean(after) || (before && after && (before.id !== after.id || before.part !== after.part))) {
        emit("mask-target", after);
        emit("render");
      }
    },
    // Alt + click on a mask's thumbnail shows it alone, in grey; \ shows it in red over the page
    setMaskView(mode) {
      const doc = app.doc;
      const target = ops.maskTarget(doc);
      doc.maskView = mode && target ? { id: target.id, part: target.part, mode } : null;
      emit("mask-view", doc.maskView);
      emit("render");
    },
    canHaveMask(layer) {
      return Boolean(layer) && !layer.adjustment && (layer.kind === "raster" || layer.kind === "text" || layer.kind === "group");
    },
    // Layer > Layer Mask > Reveal All, Hide All, Reveal Selection, Hide Selection, From Transparency.
    // A Background becomes Layer 0 first: it can't have a mask.
    addMask(kind, ids) {
      const doc = app.doc;
      if (!doc) return false;
      const selection = doc.state.selection;
      if (!selection && (kind === "revealSelection" || kind === "hideSelection")) kind = kind === "revealSelection" ? "revealAll" : "hideAll";
      const wanted = new Set(ids || doc.state.activeIds);
      const chosen = doc.state.layers.filter((layer) => wanted.has(layer.id) && ops.canHaveMask(layer) && !layer.mask);
      if (!chosen.length) return false;
      if (chosen.some((layer) => layer.locked)) {
        emit("layer-locked");
        return false;
      }
      const made = new Map();
      chosen.forEach((layer) => {
        const [sx, sy] = maskShift(layer);
        let mask;
        if (kind === "revealSelection" || kind === "hideSelection") {
          const b = selection.bounds;
          const left = Math.floor(b.left);
          const top = Math.floor(b.top);
          const alpha = newCanvas(Math.ceil(b.right) - left, Math.ceil(b.bottom) - top);
          const clip = clipOf(selection, 0, 0);
          const a = alpha.getContext("2d");
          if (clip.canvas) a.drawImage(clip.canvas, clip.x - left, clip.y - top);
          else a.fillRect(clip.x - left, clip.y - top, clip.width, clip.height);
          const gray = maskAsGray(alpha);
          if (kind === "hideSelection") {
            const g = gray.getContext("2d");
            g.globalCompositeOperation = "difference";
            g.fillStyle = "#fff";
            g.fillRect(0, 0, gray.width, gray.height);
          }
          mask = { canvas: gray, left: left - sx, top: top - sy, defaultColor: kind === "hideSelection" ? 255 : 0 };
        } else if (kind === "transparency") {
          const visual = visualOf(Object.assign({}, layer, { mask: null, vectorMask: null }), doc);
          if (!visual) mask = { canvas: null, left: -sx, top: -sy, defaultColor: 0 };
          else mask = { canvas: maskAsGray(visual.canvas), left: visual.x - sx, top: visual.y - sy, defaultColor: 0 };
        } else mask = { canvas: null, left: -sx, top: -sy, defaultColor: kind === "hideAll" ? 0 : 255 };
        mask.right = mask.left + (mask.canvas ? mask.canvas.width : 0);
        mask.bottom = mask.top + (mask.canvas ? mask.canvas.height : 0);
        mask.paint = NONE;
        const next = Object.assign({}, layer, { mask });
        if (layer.isBackground) Object.assign(next, { isBackground: false, name: `${(app.names && app.names.layer) || "Layer"} 0` });
        made.set(layer.id, next);
      });
      const change = { layers: doc.state.layers.map((layer) => made.get(layer.id) || layer) };
      if (kind === "revealSelection" || kind === "hideSelection") change.selection = null;
      commitState(doc, "Add Layer Mask", change);
      if (change.selection === null) emit("selection", null);
      const last = chosen[chosen.length - 1];
      if (doc.state.activeIds.length === 1) ops.setMaskTarget(last.id, "mask");
      firePanelEvent(EVENT_HISTORY);
      return true;
    },
    // Layer > Vector Mask > Reveal All, Hide All, Current Selection (its outline, as paths),
    // Current Path (the work path, its open subpaths closed)
    addVectorMask(kind, ids) {
      const doc = app.doc;
      if (!doc) return false;
      const selection = doc.state.selection;
      if (kind === "selection" && !selection) return false;
      if (kind === "path" && !doc.state.workPath) return false;
      const wanted = new Set(ids || doc.state.activeIds);
      const chosen = doc.state.layers.filter((layer) => wanted.has(layer.id) && ops.canHaveMask(layer) && !layer.vectorMask);
      if (!chosen.length) return false;
      if (chosen.some((layer) => layer.locked)) {
        emit("layer-locked");
        return false;
      }
      const corner = (x, y) => ({ linked: false, points: [x, y, x, y, x, y] });
      let paths = [];
      if (kind === "selection" && selection.ellipse) {
        // An ellipse is four curves, as Photoshop draws it
        const { left, top, right, bottom } = selection.ellipse;
        const cx = (left + right) / 2;
        const cy = (top + bottom) / 2;
        const rx = (right - left) / 2;
        const ry = (bottom - top) / 2;
        const k = 0.5522847498;
        const smooth = (x, y, hx, hy) => ({ linked: true, points: [x - hx, y - hy, x, y, x + hx, y + hy] });
        paths = [{ open: false, operation: "combine", fillRule: "even-odd", knots: [smooth(cx, top, -rx * k, 0), smooth(right, cy, 0, -ry * k), smooth(cx, bottom, rx * k, 0), smooth(left, cy, 0, ry * k)] }];
      } else if (kind === "selection") {
        paths = selection.rings.map((ring, index) => ({ open: false, operation: index ? undefined : "combine", fillRule: "even-odd", knots: ring.map(([x, y]) => corner(x, y)) }));
      } else if (kind === "path") {
        paths = doc.state.workPath.paths.filter((path) => path.knots.length > 1).map((path) => Object.assign({}, path, { open: false }));
        if (!paths.length) return false;
      }
      const made = new Map();
      chosen.forEach((layer) => {
        const [sx, sy] = maskShift(layer);
        const vectorMask = shiftedVector({ paths, fillStartsWithAllPixels: kind === "revealAll" }, -sx, -sy);
        const next = Object.assign({}, layer, { vectorMask });
        if (layer.isBackground) Object.assign(next, { isBackground: false, name: `${(app.names && app.names.layer) || "Layer"} 0` });
        made.set(layer.id, next);
      });
      const change = { layers: doc.state.layers.map((layer) => made.get(layer.id) || layer) };
      if (kind === "selection") change.selection = null;
      commitState(doc, "Add Vector Mask", change);
      if (kind === "selection") emit("selection", null);
      if (doc.state.activeIds.length === 1) ops.setMaskTarget(chosen[chosen.length - 1].id, "vector");
      firePanelEvent(EVENT_HISTORY);
      return true;
    },
    // Layer > Layer Mask > Delete (or Vector Mask > Delete). `apply`: its pixels go into the layer first.
    deleteMask(id, part = "mask", apply) {
      const doc = app.doc;
      const layer = doc && doc.state.layers.find((item) => item.id === id);
      if (!layer || !(part === "vector" ? layer.vectorMask : layer.mask)) return false;
      if (layer.locked) {
        emit("layer-locked");
        return false;
      }
      if (apply && part === "mask") return ops.applyMask(id);
      commitState(doc, part === "vector" ? "Delete Vector Mask" : "Delete Layer Mask", { layers: replaceLayer(doc, layer, part === "vector" ? { vectorMask: null } : { mask: null }) });
      if (doc.maskView && doc.maskView.id === id) doc.maskView = null;
      emit("mask-target", ops.maskTarget(doc));
      firePanelEvent(EVENT_HISTORY);
      return true;
    },
    canApplyMask(layer) {
      return Boolean(layer && layer.mask && layer.kind === "raster" && !layer.adjustment);
    },
    // Layer > Layer Mask > Apply: what it hides is gone from the pixels, and so is the mask
    applyMask(id) {
      const doc = app.doc;
      const layer = doc && doc.state.layers.find((item) => item.id === id);
      if (!ops.canApplyMask(layer)) return false;
      if (layer.locked) {
        emit("layer-locked");
        return false;
      }
      const visual = visualOf(Object.assign({}, layer, { vectorMask: null }), doc);
      let next;
      if (!visual) next = Object.assign({}, layer, { mask: null });
      else {
        const canvas = newCanvas(visual.canvas.width, visual.canvas.height);
        canvas.getContext("2d").drawImage(visual.canvas, 0, 0);
        next = withPixels(layer, canvas, visual.x, visual.y, null);
      }
      if (next.raw) next.raw = Object.assign({}, next.raw);
      commitState(doc, "Apply Layer Mask", { layers: replaceLayer(doc, layer, next) });
      if (doc.maskView && doc.maskView.id === id) doc.maskView = null;
      emit("mask-target", ops.maskTarget(doc));
      firePanelEvent(EVENT_HISTORY);
      return true;
    },
    // Enabled, linked, Density, Feather. `part`: "vector" for the vector mask.
    setMaskProps(id, changes, name, coalesce, part = "mask") {
      const doc = app.doc;
      const layer = doc && doc.state.layers.find((item) => item.id === id);
      const mask = layer && (part === "vector" ? layer.vectorMask : layer.mask);
      if (!mask) return false;
      commitState(doc, name || "Mask Properties", { layers: replaceLayer(doc, layer, { [part === "vector" ? "vectorMask" : "mask"]: Object.assign({}, mask, changes) }) }, coalesce);
      return true;
    },
    // Image > Adjustments > Invert, on a mask: what it hid shows, and the other way round
    invertMask(id, target = "mask") {
      const doc = app.doc;
      const layer = doc && maskHolder(doc, target, id);
      if (!layer) return false;
      if (layer.locked) {
        emit("layer-locked");
        return false;
      }
      const settled = settledMask(layer, doc);
      let canvas = null;
      if (settled.canvas) {
        canvas = newCanvas(settled.canvas.width, settled.canvas.height);
        const c = canvas.getContext("2d");
        c.drawImage(settled.canvas, 0, 0);
        c.globalCompositeOperation = "difference";
        c.fillStyle = "#fff";
        c.fillRect(0, 0, canvas.width, canvas.height);
      }
      const mask = Object.assign({}, settled, { canvas, defaultColor: settled.defaultColor ? 0 : 255 });
      if (target === "quick") commitState(doc, "Invert", { quickMask: mask });
      else commitState(doc, "Invert", { layers: replaceLayer(doc, layer, { mask }) });
      return true;
    },
    // A mask's alpha over the page, a byte per pixel: 1 where it shows the layer more than half
    maskPixels(layer, part) {
      const doc = app.doc;
      const picture = part === "vector" ? vectorPicture(Object.assign({}, layer, { vectorMask: Object.assign({}, layer.vectorMask, { disable: false }) })) : maskPicture(layer, doc, true);
      // Outside the mask's own picture the page is all its outside colour: only the picture is read
      const full = new Uint8Array(doc.width * doc.height);
      if (Math.round(picture.outside * 255) > 127) full.fill(1);
      if (!picture.canvas) return full;
      const left = Math.max(0, Math.floor(picture.x));
      const top = Math.max(0, Math.floor(picture.y));
      const bw = Math.min(doc.width, Math.ceil(picture.x + picture.canvas.width)) - left;
      const bh = Math.min(doc.height, Math.ceil(picture.y + picture.canvas.height)) - top;
      if (bw <= 0 || bh <= 0) return full;
      const alpha = maskOverPage(picture, left, top, bw, bh);
      const data = alpha.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, bw, bh).data;
      for (let y = 0; y < bh; y++) {
        const row = (top + y) * doc.width + left;
        const at = y * bw * 4 + 3;
        for (let x = 0; x < bw; x++) full[row + x] = data[at + x * 4] > 127 ? 1 : 0;
      }
      return full;
    },
    // Cmd + click on a mask's thumbnail: it becomes the selection (Shift adds, Alt takes away)
    maskToSelection(id, mode, part = "mask") {
      const doc = app.doc;
      const layer = doc && doc.state.layers.find((item) => item.id === id);
      if (!layer || !(part === "vector" ? layer.vectorMask : layer.mask)) return null;
      const selection = fromFullMask(doc, ops.maskPixels(layer, part), "layer");
      if (!selection) {
        if (!mode || mode === "intersect") ops.deselect();
        return null;
      }
      return mode ? ops.userSelection(selection, "Load Selection", mode) : ops.quietSelection(selection, "Load Selection");
    },
    // The Move tool on an unlinked mask: it moves alone
    moveMask(id, dx, dy, coalesce, part = "mask") {
      const doc = app.doc;
      const layer = doc && doc.state.layers.find((item) => item.id === id);
      const mask = layer && (part === "vector" ? layer.vectorMask : layer.mask);
      if (!mask || (!dx && !dy)) return false;
      if (layer.locked) {
        emit("layer-locked");
        return false;
      }
      const moved = part === "vector" ? { vectorMask: shiftedVector(mask, dx, dy) } : { mask: Object.assign({}, mask, { left: (mask.left || 0) + dx, top: (mask.top || 0) + dy, right: (mask.right || 0) + dx, bottom: (mask.bottom || 0) + dy }) };
      commitState(doc, "Move", { layers: replaceLayer(doc, layer, moved) }, coalesce);
      return true;
    },
    // A mask's thumbnail dragged onto another layer: it goes there, or a copy with Alt
    transferMask(fromId, toId, copy, part = "mask") {
      const doc = app.doc;
      if (!doc || fromId === toId) return false;
      const from = doc.state.layers.find((item) => item.id === fromId);
      const to = doc.state.layers.find((item) => item.id === toId);
      const key = part === "vector" ? "vectorMask" : "mask";
      if (!from || !from[key] || !ops.canHaveMask(to)) return false;
      if (from.locked || to.locked) {
        emit("layer-locked");
        return false;
      }
      const [fx, fy] = maskShift(from);
      const [tx, ty] = maskShift(to);
      const moved = part === "vector" ? shiftedVector(from.vectorMask, fx - tx, fy - ty) : Object.assign({}, from.mask, { left: (from.mask.left || 0) + fx - tx, top: (from.mask.top || 0) + fy - ty, right: (from.mask.right || 0) + fx - tx, bottom: (from.mask.bottom || 0) + fy - ty });
      const layers = doc.state.layers.map((layer) => {
        if (layer.id === toId) return Object.assign({}, layer, { [key]: moved }, layer.isBackground ? { isBackground: false, name: `${(app.names && app.names.layer) || "Layer"} 0` } : null);
        if (layer.id === fromId && !copy) return Object.assign({}, layer, { [key]: null });
        return layer;
      });
      commitState(doc, copy ? "Duplicate Layer Mask" : "Move Layer Mask", { layers, activeIds: [toId] });
      ops.setMaskTarget(toId, part);
      firePanelEvent(EVENT_SELECT);
      return true;
    },
    // Layer > Rasterize > Vector Mask: its shape goes into the pixel mask, made if need be
    rasterizeVectorMask(id) {
      const doc = app.doc;
      const layer = doc && doc.state.layers.find((item) => item.id === id);
      if (!layer || !layer.vectorMask) return false;
      if (layer.locked) {
        emit("layer-locked");
        return false;
      }
      const [sx, sy] = maskShift(layer);
      const vector = vectorPicture(Object.assign({}, layer, { vectorMask: Object.assign({}, layer.vectorMask, { disable: false }) }));
      let mask;
      if (!layer.mask) {
        const file = maskForFile(vector, vector.outside >= 0.5);
        mask = { canvas: file ? file.canvas : null, left: (file ? file.left : 0) - sx, top: (file ? file.top : 0) - sy, defaultColor: vector.outside >= 0.5 ? 255 : 0, paint: NONE };
      } else {
        // Both: what each one hides stays hidden
        const own = maskPicture(layer, doc, true);
        const left = Math.min(own.canvas ? own.x : Infinity, vector.canvas ? vector.x : Infinity, 0);
        const top = Math.min(own.canvas ? own.y : Infinity, vector.canvas ? vector.y : Infinity, 0);
        const right = Math.max(own.canvas ? own.x + own.canvas.width : -Infinity, vector.canvas ? vector.x + vector.canvas.width : -Infinity, doc.width);
        const bottom = Math.max(own.canvas ? own.y + own.canvas.height : -Infinity, vector.canvas ? vector.y + vector.canvas.height : -Infinity, doc.height);
        const alpha = maskOverPage(own, left, top, right - left, bottom - top);
        cutWith(alpha.getContext("2d"), alpha.width, alpha.height, left, top, vector);
        const outside = own.outside * vector.outside >= 0.5;
        const file = maskForFile({ canvas: alpha, x: left, y: top }, outside);
        mask = Object.assign({}, layer.mask, { canvas: file ? file.canvas : null, left: (file ? file.left : 0) - sx, top: (file ? file.top : 0) - sy, defaultColor: outside ? 255 : 0, paint: NONE });
      }
      mask.right = mask.left + (mask.canvas ? mask.canvas.width : 0);
      mask.bottom = mask.top + (mask.canvas ? mask.canvas.height : 0);
      commitState(doc, "Rasterize Vector Mask", { layers: replaceLayer(doc, layer, { mask, vectorMask: null }) });
      ops.setMaskTarget(id, "mask");
      return true;
    },
    // A layer's masks as Photoshop's file keeps them: the pixel mask in `mask`, or in
    // `realMask` with the vector mask's shape in `mask` when it has both
    masksForFile(layer, doc) {
      const [sx, sy] = maskShift(layer);
      let pixel = null;
      if (layer.mask) {
        const m = layer.mask;
        let canvas = m.canvas || null;
        let left = (m.left || 0) + sx;
        let top = (m.top || 0) + sy;
        if (m.paint && m.paint.length) {
          const file = maskForFile(maskPicture(layer, doc, true), m.defaultColor);
          canvas = file ? file.canvas : null;
          left = file ? file.left : 0;
          top = file ? file.top : 0;
        }
        if (!canvas) {
          left = 0;
          top = 0;
        }
        pixel = { left, top, right: left + (canvas ? canvas.width : 0), bottom: top + (canvas ? canvas.height : 0), defaultColor: m.defaultColor ? 255 : 0, disabled: Boolean(m.disabled) };
        if (canvas) pixel.canvas = canvas;
        if (m.userMaskDensity !== undefined && m.userMaskDensity < 1) pixel.userMaskDensity = m.userMaskDensity;
        if (m.userMaskFeather > 0) pixel.userMaskFeather = m.userMaskFeather;
      }
      if (!layer.vectorMask) return pixel ? { mask: pixel } : {};
      const vm = layer.vectorMask;
      const vectorMask = shiftedVector(vm, sx, sy);
      delete vectorMask.density;
      delete vectorMask.feather;
      const shape = vectorPicture(Object.assign({}, layer, { vectorMask: Object.assign({}, vm, { disable: false, density: undefined, feather: undefined }) }));
      const file = maskForFile(shape, shape.outside >= 0.5);
      const drawn = { left: file ? file.left : 0, top: file ? file.top : 0, defaultColor: shape.outside >= 0.5 ? 255 : 0, disabled: Boolean(vm.disable), fromVectorData: true };
      drawn.right = drawn.left + (file ? file.canvas.width : 0);
      drawn.bottom = drawn.top + (file ? file.canvas.height : 0);
      if (file) drawn.canvas = file.canvas;
      if (vm.density !== undefined && vm.density < 1) drawn.vectorMaskDensity = vm.density;
      if (vm.feather > 0) drawn.vectorMaskFeather = vm.feather;
      if (!pixel) return { mask: drawn, vectorMask };
      if (pixel.userMaskDensity !== undefined) drawn.userMaskDensity = pixel.userMaskDensity;
      if (pixel.userMaskFeather !== undefined) drawn.userMaskFeather = pixel.userMaskFeather;
      return { mask: drawn, realMask: pixel, vectorMask };
    },
    // The thumbnail of a mask, in grey, as the Layers panel shows it
    maskThumb(layer, part, width, height) {
      const doc = app.doc;
      const canvas = newCanvas(width, height);
      if (!doc) return canvas;
      const scale = Math.min(width / doc.width, height / doc.height);
      const picture = part === "vector" ? vectorPicture(Object.assign({}, layer, { vectorMask: Object.assign({}, layer.vectorMask, { disable: false, density: undefined, feather: undefined }) })) : maskPicture(layer, doc, true);
      const alpha = newCanvas(width, height);
      const a = alpha.getContext("2d");
      if (picture.outside > 0) {
        a.globalAlpha = picture.outside;
        a.fillRect(0, 0, width, height);
        a.globalAlpha = 1;
      }
      if (picture.canvas) {
        a.save();
        a.scale(scale, scale);
        a.clearRect(picture.x, picture.y, picture.canvas.width, picture.canvas.height);
        a.imageSmoothingQuality = "high";
        a.drawImage(picture.canvas, picture.x, picture.y);
        a.restore();
      }
      canvas.getContext("2d").drawImage(maskAsGray(alpha), 0, 0);
      return canvas;
    },
    /* ---- clipping masks ---- */
    // Whether a layer is clipped to the one under it, and whether one is a base
    clipping(doc = app.doc) {
      return doc ? clippingOf(doc.state.layers) : { clipped: new Set(), bases: new Set(), baseOf: new Map() };
    },
    // What Layer > Create Clipping Mask (Alt + Cmd + G) would do with the active layers:
    // "release" when one of them is clipped or a base, "create" when they can be, else null
    clippingPlan(doc = app.doc) {
      if (!doc || !doc.state.activeIds.length) return null;
      const layers = doc.state.layers;
      const info = clippingOf(layers);
      const active = layers.filter((layer) => doc.state.activeIds.includes(layer.id));
      if (active.some((layer) => info.clipped.has(layer.id) || layers.some((item) => info.baseOf.get(item.id) === layer))) return "release";
      const lowest = active[0];
      const at = layers.indexOf(lowest);
      if (active.length === 1) {
        const below = layers[at - 1];
        return lowest.kind !== "group" && below && (below.group || null) === (lowest.group || null) ? "create" : null;
      }
      return active.slice(1).some((layer) => layer.kind !== "group" && (layer.group || null) === (lowest.group || null)) ? "create" : null;
    },
    // Create Clipping Mask, or Release it: Photoshop's one command
    toggleClipping() {
      const doc = app.doc;
      const plan = ops.clippingPlan(doc);
      if (!plan) return false;
      const layers = doc.state.layers;
      const info = clippingOf(layers);
      const active = layers.filter((layer) => doc.state.activeIds.includes(layer.id));
      const change = new Set();
      if (plan === "release") {
        // A clipped layer goes with those clipped above it; a base lets all of its own go
        active.forEach((layer) => {
          const at = layers.indexOf(layer);
          const base = info.clipped.has(layer.id) ? info.baseOf.get(layer.id) : layer;
          for (let j = info.clipped.has(layer.id) ? at : at + 1; j < layers.length && info.clipped.has(layers[j].id) && info.baseOf.get(layers[j].id) === base; j++) change.add(layers[j].id);
        });
        commitState(doc, "Release Clipping Mask", { layers: layers.map((layer) => (change.has(layer.id) ? Object.assign({}, layer, { clipping: false }) : layer)) });
      } else {
        const lowest = active[0];
        const from = layers.indexOf(lowest);
        const to = layers.indexOf(active[active.length - 1]);
        if (active.length === 1) change.add(lowest.id);
        // The lowest is the base; those between it and the highest go with it
        else for (let j = from + 1; j <= to; j++) if (layers[j].kind !== "group" && (layers[j].group || null) === (lowest.group || null)) change.add(layers[j].id);
        commitState(doc, "Create Clipping Mask", { layers: layers.map((layer) => (change.has(layer.id) ? Object.assign({}, layer, { clipping: true }) : layer)) });
      }
      firePanelEvent(EVENT_HISTORY);
      return true;
    },
    // Alt + click between two layers in the Layers panel: the upper one is clipped to the lower
    // one, or let go with those above it
    clipToBelow(id) {
      const doc = app.doc;
      if (!doc) return false;
      const layers = doc.state.layers;
      const info = clippingOf(layers);
      const at = layers.findIndex((layer) => layer.id === id);
      const layer = layers[at];
      if (!layer || layer.kind === "group") return false;
      if (info.clipped.has(id)) {
        const base = info.baseOf.get(id);
        const change = new Set();
        for (let j = at; j < layers.length && info.clipped.has(layers[j].id) && info.baseOf.get(layers[j].id) === base; j++) change.add(layers[j].id);
        commitState(doc, "Release Clipping Mask", { layers: layers.map((item) => (change.has(item.id) ? Object.assign({}, item, { clipping: false }) : item)) });
      } else {
        const below = layers[at - 1];
        if (!below || (below.group || null) !== (layer.group || null)) return false;
        commitState(doc, "Create Clipping Mask", { layers: replaceLayer(doc, layer, { clipping: true }) });
      }
      firePanelEvent(EVENT_HISTORY);
      return true;
    },
    /* ---- Quick Mask (Q) ---- */
    // The selection becomes a mask the brushes paint on, red where nothing is selected; going
    // back, what is more white than black becomes the selection
    toggleQuickMask() {
      const doc = app.doc;
      if (!doc) return false;
      if (doc.state.quickMask) {
        const holder = maskHolder(doc, "quick");
        const full = ops.maskPixels(holder, "mask");
        let all = true;
        for (let i = 0; i < full.length && all; i++) all = full[i] === 1;
        const selection = all ? null : fromFullMask(doc, full, "mixed");
        commitState(doc, "Exit Quick Mask", { quickMask: null, selection: selection || null });
        maskCache.delete(holder.id);
        emit("selection", selection || null);
        emit("quick-mask", false);
        return true;
      }
      const selection = doc.state.selection;
      let quickMask;
      if (selection) {
        const b = selection.bounds;
        const left = Math.floor(b.left);
        const top = Math.floor(b.top);
        const alpha = newCanvas(Math.ceil(b.right) - left, Math.ceil(b.bottom) - top);
        const clip = clipOf(selection, 0, 0);
        const a = alpha.getContext("2d");
        if (clip.canvas) a.drawImage(clip.canvas, clip.x - left, clip.y - top);
        else a.fillRect(clip.x - left, clip.y - top, clip.width, clip.height);
        quickMask = { canvas: maskAsGray(alpha), left, top, defaultColor: 0, paint: NONE };
      } else quickMask = { canvas: null, left: 0, top: 0, defaultColor: 255, paint: NONE };
      commitState(doc, "Quick Mask", { quickMask, selection: null });
      emit("selection", null);
      emit("quick-mask", true);
      return true;
    },
    // Alt + Backspace and the others on a mask or the Quick Mask: a grey within the selection,
    // or all over it when nothing is selected, as in Photoshop
    fillMask(target, layerId, gray) {
      const doc = app.doc;
      if (!doc) return false;
      const holder = maskHolder(doc, target, layerId);
      if (!holder) return false;
      if (holder.locked) {
        emit("layer-locked");
        return true;
      }
      const [ox, oy] = maskOrigin(holder);
      const op = { t: "fill", gray, clip: doc.state.selection ? clipOf(doc.state.selection, ox, oy) : null };
      // Black or white all over: the mask is that colour, round the page too
      const plain = !op.clip && (gray === 0 || gray === 255);
      const mask = plain ? Object.assign({}, holder.mask, { canvas: null, defaultColor: gray, paint: NONE, right: holder.mask.left || 0, bottom: holder.mask.top || 0 }) : Object.assign({}, holder.mask, { paint: (holder.mask.paint || NONE).concat([op]) });
      if (target === "quick") commitState(doc, "Fill", { quickMask: mask });
      else commitState(doc, "Fill", { layers: replaceLayer(doc, holder, { mask }) });
      return true;
    },
    /* ---- painting ---- */
    // `fields.target`: "mask" paints the layer's mask, "quick" the Quick Mask, in `fields.gray`
    // `fields.retouch`: the Smudge, Blur or Sharpen tool (see beginRetouch)
    // `fields.preset`: a brush of the library (see beginPreset)
    beginStroke(layerId, fields) {
      const doc = app.doc;
      if (doc && fields.retouch) return beginRetouch(doc, layerId, fields);
      if (doc && fields.preset) return beginPreset(doc, layerId, fields);
      if (doc && fields.target) {
        const holder = maskHolder(doc, fields.target, layerId);
        if (!holder) return false;
        if (holder.locked) {
          emit("layer-locked");
          return false;
        }
        const [ox, oy] = maskOrigin(holder);
        const op = { t: "stroke", points: [], size: fields.size, hardness: fields.hardness, gray: fields.gray };
        if (fields.erase) op.erase = true;
        if (doc.state.selection) op.clip = clipOf(doc.state.selection, ox, oy);
        doc.liveStroke = { layerId, holderId: holder.id, target: fields.target, op, dx: ox, dy: oy };
        maskEntry(holder, doc);
        return true;
      }
      const layer = doc && doc.state.layers.find((item) => item.id === layerId && item.kind === "raster");
      if (!layer) return false;
      if (lockOf(layer, "pixels")) {
        emit("layer-locked");
        return false;
      }
      const selection = doc.state.selection;
      const dx = layer.dx || 0;
      const dy = layer.dy || 0;
      const { clone, ...rest } = fields;
      const op = Object.assign({ t: "stroke", points: [] }, rest);
      // Transparent pixels locked: paint only on what is there, and the Eraser paints the
      // background colour, as in Photoshop
      if (lockOf(layer, "transparency")) {
        op.atop = true;
        if (op.erase) {
          delete op.erase;
          op.color = Object.assign({}, app.bg);
        }
      }
      if (clone) {
        const shot = cloneSource(doc, layer, clone.sample);
        op.source = { canvas: shot.canvas, x: shot.x - clone.ox - dx, y: shot.y - clone.oy - dy };
      }
      if (selection) op.clip = clipOf(selection, dx, dy);
      doc.liveStroke = { layerId, op, dx, dy };
      rasterEntry(layer, doc);
      // Painted, a layer shows its canvas over all the page, not only where its picture was:
      // the parts of the page drawn again during the stroke find it there
      visualBoxes.delete(layer);
      return true;
    },
    // `pen`: { pressure (0 to 1), tilt (0 upright to 1 flat; 0 too when it isn't known), time
    // (ms) }, for the brushes of the library
    extendStroke(x, y, pen) {
      const doc = app.doc;
      const live = doc && doc.liveStroke;
      if (!live) return;
      if (live.retouch) {
        extendRetouch(live, x, y);
        return;
      }
      if (live.preset) {
        extendPreset(live, x, y, pen);
        return;
      }
      const point = [x - live.dx, y - live.dy];
      const previous = live.op.points[live.op.points.length - 1];
      live.op.points.push(point);
      const segment = previous ? [previous, point] : [point];
      const from = previous || point;
      const reach = (live.op.size || 1) + 2;
      // In the layer's (or the mask's) own pixels
      const area = { left: Math.min(from[0], point[0]) - reach, top: Math.min(from[1], point[1]) - reach, right: Math.max(from[0], point[0]) + reach, bottom: Math.max(from[1], point[1]) + reach };
      const onCanvas = (entry, x0, y0) => withinCanvas({ left: area.left - x0, top: area.top - y0, right: area.right - x0, bottom: area.bottom - y0 }, entry.canvas);
      if (live.target) {
        const holder = maskHolder(doc, live.target, live.layerId);
        if (!holder) return;
        const entry = maskEntry(holder, doc);
        maskDrawOp(entry.ctx, live.op, segment);
        entry.version++;
        touched(entry.canvas, entry.version - 1, entry.version, onCanvas(entry, entry.x0, entry.y0));
      } else {
        const layer = doc.state.layers.find((item) => item.id === live.layerId);
        const entry = rasterEntry(layer, doc);
        if (live.op.source) cloneSegment(entry, live, segment);
        else drawOp(entry.ctx, live.op, segment);
        entry.version++;
        touched(entry.canvas, entry.version - 1, entry.version, onCanvas(entry, entry.cx0, entry.cy0));
      }
      const rect = pageRect(doc, area.left + live.dx, area.top + live.dy, area.right + live.dx, area.bottom + live.dy);
      live.box = unionOf(live.box, rect);
      emit("render", rect);
    },
    endStroke() {
      const doc = app.doc;
      const live = doc && doc.liveStroke;
      if (!live) return;
      doc.liveStroke = null;
      if (live.retouch) {
        endRetouch(doc, live);
        return;
      }
      if (live.preset) {
        endPreset(doc, live);
        return;
      }
      if (live.target) {
        const holder = maskHolder(doc, live.target, live.layerId);
        if (!holder || !live.op.points.length) {
          emit("render");
          return;
        }
        const paint = (holder.mask.paint || NONE).concat([live.op]);
        const entry = maskCache.get(holder.id);
        if (entry) entry.paint = paint;
        const mask = Object.assign({}, holder.mask, { paint });
        const name = live.target === "quick" ? "Quick Mask" : live.op.erase ? "Eraser" : "Brush";
        if (live.target === "quick") commitState(doc, name, { quickMask: mask }, undefined, strokeEnd(doc, holder, live));
        else commitState(doc, name, { layers: replaceLayer(doc, holder, { mask }) }, undefined, strokeEnd(doc, holder, live));
        return;
      }
      const layer = doc.state.layers.find((item) => item.id === live.layerId);
      if (!live.op.points.length) return;
      if (live.op.source) cropCloneSource(live.op);
      const paint = (layer.paint || NONE).concat([live.op]);
      const entry = rasterCache.get(layer.id);
      if (entry) {
        entry.paint = paint;
        if (paint.length % MARK_EVERY === 0) markRaster(entry, paint);
      }
      if (effectsOn(layer)) settleEffects(doc, layer.id);
      commitState(doc, live.op.source ? "Clone Stamp" : live.op.erase ? "Eraser" : "Brush", { layers: replaceLayer(doc, layer, { paint }) }, undefined, strokeEnd(doc, layer, live));
    },
    // Alt+Backspace, Cmd+Backspace, Delete: fills or clears the selection on a pixel layer
    fillSelection(color) {
      const doc = app.doc;
      if (!doc || !doc.state.selection) return false;
      let layer = activeRaster(doc);
      if (!layer) {
        if (!color) return false;
        layer = ops.newLayer();
      }
      if (lockOf(layer, "pixels")) {
        emit("layer-locked");
        return true;
      }
      const selection = doc.state.selection;
      const op = { t: "fill", clip: clipOf(selection, layer.dx || 0, layer.dy || 0) };
      if (color) op.color = color;
      else op.erase = true;
      if (lockOf(layer, "transparency")) {
        op.atop = true;
        if (op.erase) {
          delete op.erase;
          op.color = Object.assign({}, app.bg);
        }
      }
      commitState(doc, color ? "Fill" : "Clear", { layers: replaceLayer(doc, layer, { paint: (layer.paint || NONE).concat([op]) }) });
      return true;
    },
    // The Bubble Cleaner: a click in a bubble, or a box dragged around some text
    cleanBubble(where) {
      const doc = app.doc;
      if (!doc) return { error: "doc" };
      const plan = planBubbleClean(doc, Object.assign({ tolerance: app.cleanTolerance, margin: app.cleanMargin }, where));
      if (plan.error) return plan;
      const canvas = newCanvas(plan.width, plan.height);
      canvas.getContext("2d").putImageData(new ImageData(plan.pixels, plan.width, plan.height), 0, 0);
      const layers = paintOnCleanLayer(doc.state.layers, (layer) => ({ t: "image", canvas, x: plan.left - (layer.dx || 0), y: plan.top - (layer.dy || 0) }));
      commitState(doc, "Bubble Cleaner", { layers });
      // Painted on a hidden layer, or in a hidden folder, the clean happens but can't be seen
      const clean = layers.find((layer) => layer.clean);
      const hidden = !chainOf(clean, new Map(layers.map((layer) => [layer.id, layer]))).visible;
      return { ok: true, painted: plan.painted, colour: plan.colour, hidden };
    },
    /* ---- the Bubble Reshaper (reshape-tool.js) ---- */
    // The page as the Reshaper reads it: every pixel layer on white, never the text, and
    // without the bubble layer being shaped again
    // `of`: another open page than the one shown (Remove Text on several pages)
    reshapePage(without, of) {
      const doc = of || app.doc;
      if (!doc) return null;
      const shown = without ? Object.assign({}, doc, { state: Object.assign({}, doc.state, { layers: doc.state.layers.filter((layer) => layer.id !== without) }) }) : doc;
      const data = sampleData(shown, true);
      // A page in the background keeps no copy of its pixels: a chapter's worth would fill the memory
      if (doc !== app.doc) {
        doc.sampleCache = null;
        doc.sampleKey = null;
      }
      return { data, width: doc.width, height: doc.height };
    },
    // The bubble layer under a point: the topmost one shown there that remembers its shape
    reshapedAt(x, y) {
      const doc = app.doc;
      if (!doc) return null;
      const byId = new Map(doc.state.layers.map((layer) => [layer.id, layer]));
      for (let i = doc.state.layers.length - 1; i >= 0; i--) {
        const layer = doc.state.layers[i];
        if (layer.kind !== "raster" || !layer.bubble || !layer.bitmap || layer.visible === false || !chainOf(layer, byId).visible) continue;
        const lx = Math.floor(x - layer.left - (layer.dx || 0));
        const ly = Math.floor(y - layer.top - (layer.dy || 0));
        if (lx < 0 || ly < 0 || lx >= layer.bitmap.width || ly >= layer.bitmap.height) continue;
        if (layer.bitmap.getContext("2d", { willReadFrequently: true }).getImageData(lx, ly, 1, 1).data[3] > 0) return layer;
      }
      return null;
    },
    // The bubble being shaped, on screen only; null takes it off
    reshapeShow(extra, area) {
      const doc = app.doc;
      if (!doc) return;
      doc.extra = extra;
      emit("render", area ? pageRect(doc, area.left, area.top, area.right, area.bottom) : undefined);
    },
    // The bubble becomes a layer: a new one under the texts, or the one it was shaped from
    reshapeCommit({ canvas, left, top, bubble, replaces, name }) {
      const doc = app.doc;
      if (!doc) return null;
      doc.extra = null;
      const old = replaces && doc.state.layers.find((layer) => layer.id === replaces);
      let layers;
      let id;
      if (old) {
        id = old.id;
        layers = replaceLayer(doc, old, { bitmap: canvas, left, top, dx: 0, dy: 0, paint: NONE, bubble });
      } else {
        const made = newRaster(name || "Bubble", { bitmap: canvas, left, top, bubble });
        id = made.id;
        layers = doc.state.layers.slice();
        // Where TypeR Clean goes: above the page, under the texts and their folders
        let at = layers.findIndex((layer) => layer.kind === "text");
        const rootOf = (layer) => {
          let root = layer;
          while (root && root.group) root = layers.find((item) => item.id === root.group);
          return root;
        };
        if (at >= 0 && layers[at].group) {
          const root = rootOf(layers[at]);
          while (at > 0 && rootOf(layers[at - 1]) === root) at--;
        }
        layers.splice(at < 0 ? layers.length : at, 0, made);
      }
      commitState(doc, "Bubble Reshaper", { layers, activeIds: [id] });
      firePanelEvent(EVENT_HISTORY);
      return id;
    },
    // Detect Text and Remove Text (textmask.js): a selection as one byte a pixel over the whole
    // page (1 inside), and back; a selection made from a mask without putting it on the page
    selectionFullMask(selection, of) {
      const doc = of || app.doc;
      return doc && selection ? fullMaskOf(doc, selection) : null;
    },
    fullMaskSelection(full, source, of) {
      const doc = of || app.doc;
      return doc ? fromFullMask(doc, full, source) : null;
    },
    maskSelection(mask, width, height, left, top, source) {
      return makeSelection({ source: source || "mask", mask, boxW: width, boxH: height, left, top });
    },
    // Remove Text: letters on a plain background painted over with that background, on TypeR
    // Clean, in one step. `pieces`: [{ left, top, width, height, data, colour: { r, g, b },
    // pixels }], `data` one byte a pixel over the piece, 1 where it's painted, in `colour` or,
    // for a shaded background, in the colours of `pixels` (RGBA over the piece).
    fillPlain(doc, pieces, name) {
      if (!doc || !app.docs.includes(doc) || !pieces.length) return null;
      let layers = doc.state.layers;
      pieces.forEach((piece) => {
        const canvas = newCanvas(piece.width, piece.height);
        const ctx = canvas.getContext("2d");
        const image = ctx.createImageData(piece.width, piece.height);
        const { r, g, b } = piece.colour;
        const shaded = piece.pixels;
        for (let i = 0; i < piece.data.length; i++) {
          if (!piece.data[i]) continue;
          image.data[i * 4] = shaded ? shaded[i * 4] : r;
          image.data[i * 4 + 1] = shaded ? shaded[i * 4 + 1] : g;
          image.data[i * 4 + 2] = shaded ? shaded[i * 4 + 2] : b;
          image.data[i * 4 + 3] = 255;
        }
        ctx.putImageData(image, 0, 0);
        layers = paintOnCleanLayer(layers, (layer) => ({ t: "image", canvas, x: piece.left - (layer.dx || 0), y: piece.top - (layer.dy || 0) }));
      });
      commitState(doc, name || "Remove Text", { layers });
      const clean = layers.find((layer) => layer.clean);
      return { hidden: !chainOf(clean, new Map(layers.map((layer) => [layer.id, layer]))).visible };
    },
    // A selection from a mask on the page (one byte a pixel), without TypeR pasting into it
    selectMask(mask, width, height, left, top, name) {
      const doc = app.doc;
      if (!doc) return null;
      return ops.quietSelection(makeSelection({ source: "mask", mask, boxW: width, boxH: height, left, top }), name || "Select");
    },
    // Edit > Content-Aware Fill: the selection is painted over with what surrounds it, read
    // from every pixel layer and never from the text, onto the active pixel layer or a new
    // one. Long: resolves once done, telling its progress meanwhile, 0 to 1.
    async contentAwareFill(options, progress) {
      const doc = app.doc;
      const selection = doc && doc.state.selection;
      if (!selection) return "none";
      let layer = options.output === "new" ? null : activeRaster(doc);
      if (layer && lockOf(layer, "pixels")) {
        emit("layer-locked");
        return "locked";
      }
      const b = selection.bounds;
      // The fill reads around the selection, as far again as the selection is wide, within reason
      const reach = options.area === "page" ? Math.max(doc.width, doc.height) : Math.max(64, Math.min(1024, Math.round(Math.max(b.width, b.height)) + 48));
      const left = Math.max(0, Math.floor(b.left - reach));
      const top = Math.max(0, Math.floor(b.top - reach));
      const right = Math.min(doc.width, Math.ceil(b.right + reach));
      const bottom = Math.min(doc.height, Math.ceil(b.bottom + reach));
      const width = right - left;
      const height = bottom - top;
      if (width <= 0 || height <= 0) return "none";
      const canvas = newCanvas(width, height);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      paintDoc(doc, ctx, { x: -left, y: -top, skip: (item) => item.kind === "text" });
      const data = ctx.getImageData(0, 0, width, height).data;
      const clip = selectionCanvas(selection);
      const clipData = clip.getContext("2d").getImageData(0, 0, clip.width, clip.height).data;
      const mask = new Uint8Array(width * height);
      let any = false;
      for (let y = 0; y < clip.height; y++) {
        const py = b.top + y - top;
        if (py < 0 || py >= height) continue;
        for (let x = 0; x < clip.width; x++) {
          const px = b.left + x - left;
          if (px < 0 || px >= width || !clipData[(y * clip.width + x) * 4 + 3]) continue;
          mask[py * width + px] = 1;
          any = true;
        }
      }
      if (!any) return "none";
      const source = new Uint8Array(width * height).fill(1);
      const size = [doc.width, doc.height];
      const result = await inpaint({ data, width, height, mask, source }, { mirror: Boolean(options.mirror), adapt: options.adapt !== false }, progress);
      // Worked out while the page stayed free: it lands once what is under way there is over
      if (options.settle) await options.settle(doc);
      // Meanwhile the page may have closed, changed size, or the layer gone
      if (!app.docs.includes(doc) || doc.width !== size[0] || doc.height !== size[1]) return "gone";
      if (layer) {
        layer = doc.state.layers.find((item) => item.id === layer.id && item.kind === "raster") || null;
        if (!layer) return "gone";
      }
      const region = newCanvas(width, height);
      region.getContext("2d").putImageData(new ImageData(result, width, height), 0, 0);
      const pixels = newCanvas(b.width, b.height);
      pixels.getContext("2d").drawImage(region, b.left - left, b.top - top, b.width, b.height, 0, 0, b.width, b.height);
      const dx = layer ? layer.dx || 0 : 0;
      const dy = layer ? layer.dy || 0 : 0;
      const op = { t: "patch", source: { canvas: pixels, x: b.left - dx, y: b.top - dy }, clip: clipOf(selection, dx, dy) };
      if (layer) {
        commitState(doc, "Content-Aware Fill", { layers: replaceLayer(doc, layer, { paint: (layer.paint || NONE).concat([op]) }) });
        return "done";
      }
      // A new layer goes where New Layer puts one: above the active layer, in its folder
      const made = newRaster(options.name || `${(app.names && app.names.layer) || "Layer"} ${doc.state.layers.filter((item) => item.kind === "raster" && !item.clean).length + 1}`, { paint: [op] });
      const anchor = doc.state.activeIds[doc.state.activeIds.length - 1];
      const layers = doc.state.layers.slice();
      const at = layers.findIndex((item) => item.id === anchor);
      if (at >= 0) {
        made.group = layers[at].kind === "group" ? layers[at].id : layers[at].group;
        layers.splice(layers[at].kind === "group" ? at : at + 1, 0, made);
      } else layers.push(made);
      commitState(doc, "Content-Aware Fill", { layers, activeIds: [made.id] });
      return "done";
    },
    // The Spot Healing Brush: where a stroke went is painted over with what surrounds it, as
    // Content-Aware Fill does a selection, but read close by and without a question. Onto the
    // pixel layer `layerId`, or the TypeR Clean layer (made under the texts if there is none).
    // `sampleAll`: read the page as it shows, without its texts; else only the layer itself.
    // Within the selection, if there is one. Long on a long stroke: progress goes 0 to 1.
    async spotHeal({ doc, layerId, points, size, sampleAll }, progress) {
      if (!doc || !app.docs.includes(doc) || !points.length) return "none";
      const layerNow = () => (layerId ? doc.state.layers.find((item) => item.id === layerId && item.kind === "raster") : doc.state.layers.find((item) => item.clean) || null);
      let layer = layerNow();
      if (layerId && !layer) return "gone";
      if (layer && lockOf(layer, "pixels")) {
        emit("layer-locked");
        return "locked";
      }
      const r = size / 2 + 1;
      const xs = points.map((p) => p[0]);
      const ys = points.map((p) => p[1]);
      const sl = Math.floor(Math.min(...xs) - r);
      const st = Math.floor(Math.min(...ys) - r);
      const sr = Math.ceil(Math.max(...xs) + r);
      const sb = Math.ceil(Math.max(...ys) + r);
      // Close by: a spot is healed from its neighbourhood, not from across the page
      const reach = Math.max(40, Math.min(400, Math.round(Math.max(sr - sl, sb - st) * 0.6) + 24));
      const left = Math.max(0, sl - reach);
      const top = Math.max(0, st - reach);
      const right = Math.min(doc.width, sr + reach);
      const bottom = Math.min(doc.height, sb + reach);
      const width = right - left;
      const height = bottom - top;
      if (width <= 0 || height <= 0) return "none";
      // Where the stroke went, its edge a little soft, so that the healed part melts in
      const hard = newCanvas(width, height);
      const h = hard.getContext("2d");
      h.translate(-left, -top);
      h.strokeStyle = "#000";
      const brush = { size, hardness: 100 };
      points.forEach((point, index) => paintStroke(h, brush, index ? [points[index - 1], point] : [point]));
      const selection = doc.state.selection;
      if (selection) {
        h.globalCompositeOperation = "destination-in";
        const clip = clipOf(selection, 0, 0);
        if (clip.canvas) h.drawImage(clip.canvas, clip.x, clip.y);
        else h.fillRect(clip.x, clip.y, clip.width, clip.height);
      }
      const soft = newCanvas(width, height);
      const s = soft.getContext("2d", { willReadFrequently: true });
      s.filter = `blur(${Math.max(0.6, Math.min(2, size / 24))}px)`;
      s.drawImage(hard, 0, 0);
      s.filter = "none";
      s.drawImage(hard, 0, 0);
      const softData = s.getImageData(0, 0, width, height).data;
      const mask = new Uint8Array(width * height);
      let hl = width;
      let ht = height;
      let hr = -1;
      let hb = -1;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (softData[(y * width + x) * 4 + 3] < 4) continue;
          mask[y * width + x] = 1;
          if (x < hl) hl = x;
          if (x > hr) hr = x;
          if (y < ht) ht = y;
          if (y > hb) hb = y;
        }
      }
      if (hr < 0) return "none";
      const canvas = newCanvas(width, height);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const alone = !(sampleAll || !layer);
      paintDoc(doc, ctx, { x: -left, y: -top, skip: (item) => item.kind === "text" || (alone && item.id !== layer.id) });
      const data = ctx.getImageData(0, 0, width, height).data;
      // An empty layer, read alone, has nothing to heal from: not a black patch
      if (!mask.some((hole, i) => !hole && data[i * 4 + 3] >= 128)) return "none";
      const source = healSource(data, mask, width, height);
      const result = await inpaint({ data, width, height, mask, source }, { adapt: true }, progress);
      // Meanwhile the page may have closed, or the layer gone
      if (!app.docs.includes(doc)) return "gone";
      layer = layerNow();
      if (layerId && !layer) return "gone";
      const region = newCanvas(width, height);
      region.getContext("2d").putImageData(new ImageData(result, width, height), 0, 0);
      const bw = hr - hl + 1;
      const bh = hb - ht + 1;
      const pixels = newCanvas(bw, bh);
      pixels.getContext("2d").drawImage(region, hl, ht, bw, bh, 0, 0, bw, bh);
      const edge = newCanvas(bw, bh);
      edge.getContext("2d").drawImage(soft, hl, ht, bw, bh, 0, 0, bw, bh);
      const opFor = (target) => {
        const dx = target.dx || 0;
        const dy = target.dy || 0;
        const op = { t: "patch", source: { canvas: pixels, x: left + hl - dx, y: top + ht - dy }, clip: { canvas: edge, x: left + hl - dx, y: top + ht - dy } };
        if (lockOf(target, "transparency")) op.atop = true;
        return op;
      };
      const layers = layer ? replaceLayer(doc, layer, { paint: (layer.paint || NONE).concat([opFor(layer)]) }) : paintOnCleanLayer(doc.state.layers, opFor);
      commitState(doc, "Spot Healing Brush", { layers });
      const painted = layers.find((item) => (layer ? item.id === layer.id : item.clean));
      return painted && !chainOf(painted, new Map(layers.map((item) => [item.id, item]))).visible ? "hidden" : "done";
    },
    /* ---- the Gradient tool ---- */
    // `spec`: { type, start, end (page pixels), stops: [{ at, r, g, b, a }], method, reverse,
    // opacity, dither }. `where`: { kind: "layer" | "mask" | "quick" | "clip" | "new", id }: a
    // pixel layer, a layer's mask or the Quick Mask (in grey), or a new layer, clipped to the
    // text or folder `id` for "clip". Within the selection, else over the page, or around what
    // a new layer is clipped to. Returns what to give back as `edit`, for that gradient to be
    // drawn again in its place (its ends dragged, an option changed): all the calls with the
    // same `token` are one step of history. `quick`: drawn smaller, enough while dragging.
    drawGradient({ spec, where, edit, token, quick, name }) {
      const doc = app.doc;
      if (!doc) return null;
      if (edit && !ops.gradientLive(edit)) return null;
      const target = edit ? edit.where : where;
      const selection = doc.state.selection;
      let layers = doc.state.layers;
      let holder = null;
      let layer = null;
      let made = null;
      if (target.kind === "quick" || target.kind === "mask") {
        holder = maskHolder(doc, target.kind, target.id);
        if (!holder) return null;
        if (holder.locked) {
          emit("layer-locked");
          return null;
        }
      } else if (target.kind === "layer") {
        layer = layers.find((item) => item.id === target.id && item.kind === "raster");
        if (!layer) return null;
        if (lockOf(layer, "pixels")) {
          emit("layer-locked");
          return null;
        }
      }
      let area = edit ? edit.area : null;
      if (!area) {
        let box = { left: 0, top: 0, right: doc.width, bottom: doc.height };
        const cut = (other) => {
          box = { left: Math.max(box.left, other.left), top: Math.max(box.top, other.top), right: Math.min(box.right, other.right), bottom: Math.min(box.bottom, other.bottom) };
        };
        const base = target.kind === "clip" ? layers.find((item) => item.id === target.id) : null;
        if (base) {
          // Around what it is clipped to, with room for it to move a little
          const byId = new Map(layers.map((item) => [item.id, item]));
          const members = base.kind === "group" ? Array.from(familyOf(layers, base.id)).map((id) => byId.get(id)).filter((item) => item && item.kind !== "group") : [base];
          let l = Infinity;
          let t = Infinity;
          let r = -Infinity;
          let b = -Infinity;
          members.forEach((member) => {
            const visual = visualOf(member, doc);
            if (!visual || !visual.canvas) return;
            l = Math.min(l, visual.x);
            t = Math.min(t, visual.y);
            r = Math.max(r, visual.x + visual.canvas.width);
            b = Math.max(b, visual.y + visual.canvas.height);
          });
          if (r > l && b > t) {
            const pad = Math.round(Math.max(r - l, b - t) * 0.5);
            cut({ left: l - pad, top: t - pad, right: r + pad, bottom: b + pad });
          }
        }
        if (selection) {
          const s = selection.bounds;
          cut({ left: Math.floor(s.left), top: Math.floor(s.top), right: Math.ceil(s.right), bottom: Math.ceil(s.bottom) });
        }
        if (box.right - box.left < 1 || box.bottom - box.top < 1) return null;
        area = { left: box.left, top: box.top, width: box.right - box.left, height: box.bottom - box.top };
      }
      if (target.kind === "clip" || target.kind === "new") {
        made = newRaster(name || "Gradient", { clipping: target.kind === "clip" });
        layers = layers.slice();
        let at;
        if (target.kind === "clip") {
          at = layers.findIndex((item) => item.id === target.id);
          if (at < 0) return null;
          // On top of what is already clipped to it
          const clip = clippingOf(doc.state.layers);
          const base = layers[at];
          while (at + 1 < layers.length && clip.clipped.has(layers[at + 1].id) && clip.baseOf.get(layers[at + 1].id) === base) at++;
          made.group = base.group || null;
          layers.splice(at + 1, 0, made);
        } else {
          const anchor = doc.state.activeIds[doc.state.activeIds.length - 1];
          at = layers.findIndex((item) => item.id === anchor);
          if (at >= 0) {
            made.group = layers[at].kind === "group" ? layers[at].id : layers[at].group;
            layers.splice(layers[at].kind === "group" ? at : at + 1, 0, made);
          } else layers.push(made);
        }
        layer = made;
      }
      const pixels = area.width * area.height;
      const scale = quick && pixels > 1200000 ? Math.sqrt(1200000 / pixels) : 1;
      const [ox, oy] = holder ? maskOrigin(holder) : [layer.dx || 0, layer.dy || 0];
      const drawn = renderGradient(spec, area, scale, Boolean(holder));
      const op = { t: "gradient", canvas: drawn.canvas, x: area.left - ox, y: area.top - oy, width: area.width, height: area.height, clip: selection ? clipOf(selection, ox, oy) : null, spec };
      if (drawn.cover) op.cover = drawn.cover;
      if (!holder && lockOf(layer, "transparency")) op.atop = true;
      const laid = (paint) => (edit ? (paint || NONE).slice(0, -1) : paint || NONE).concat([op]);
      let change;
      if (holder) {
        const mask = Object.assign({}, holder.mask, { paint: laid(holder.mask.paint) });
        change = target.kind === "quick" ? { quickMask: mask } : { layers: replaceLayer(doc, holder, { mask }) };
      } else {
        change = { layers: layers.map((item) => (item.id === layer.id ? Object.assign({}, item, { paint: laid(item.paint) }) : item)) };
        if (made) change.activeIds = [made.id];
      }
      commitState(doc, "Gradient", change, token);
      return { docId: doc.id, where: holder ? { kind: target.kind, id: target.id } : { kind: "layer", id: layer.id }, op, area, token, made: Boolean(made || (edit && edit.made)) };
    },
    // Whether the gradient an earlier drawGradient made is still the last thing done, where it was
    gradientLive(edit) {
      const doc = app.doc;
      if (!doc || !edit || doc.id !== edit.docId) return false;
      const last = doc.history[doc.historyIndex];
      if (!last || last.coalesce !== edit.token || doc.historyIndex !== doc.history.length - 1) return false;
      let paint = null;
      if (edit.where.kind === "quick" || edit.where.kind === "mask") {
        const holder = maskHolder(doc, edit.where.kind, edit.where.id);
        paint = holder && holder.mask.paint;
      } else {
        const layer = doc.state.layers.find((item) => item.id === edit.where.id);
        paint = layer && layer.paint;
      }
      return Boolean(paint && paint[paint.length - 1] === edit.op);
    },
    // The page as the Gradient tool reads its colours: without its texts, on white. With `edit`,
    // as it was before that gradient, which must not be matched to itself.
    pageData(edit) {
      const doc = app.doc;
      if (!doc) return null;
      const before = edit && ops.gradientLive(edit) ? doc.history[doc.historyIndex - 1] : null;
      return before ? sampleData(Object.assign({}, doc, { state: before.state, sampleCache: null, sampleKey: null }), true) : sampleData(doc, true);
    },
    // The colour of the page around a point (`data`: pageData's): a few pixels averaged, so
    // that a screentone gives its grey
    pageColor(x, y, radius = 3, page) {
      const doc = app.doc;
      if (!doc) return null;
      const data = page || sampleData(doc, true);
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let py = Math.max(0, Math.round(y) - radius); py <= Math.min(doc.height - 1, Math.round(y) + radius); py++) {
        for (let px = Math.max(0, Math.round(x) - radius); px <= Math.min(doc.width - 1, Math.round(x) + radius); px++) {
          const i = (py * doc.width + px) * 4;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          n++;
        }
      }
      return n ? { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) } : null;
    },
    // The page's own colours along a gradient: every pixel in a band just outside the selection
    // says what colour the gradient has where it lies. Read from the page without its texts,
    // with the median of each step, so the bubble's outline or a stray letter doesn't count.
    // Null when the band says too little: no selection, or a gradient too short.
    pageStops(spec, band = 10, page) {
      const doc = app.doc;
      const selection = doc && doc.state.selection;
      if (!selection) return null;
      const length = Math.hypot(spec.end[0] - spec.start[0], spec.end[1] - spec.start[1]);
      if (length < 4) return null;
      const b = selection.bounds;
      const left = Math.max(0, Math.floor(b.left) - band);
      const top = Math.max(0, Math.floor(b.top) - band);
      const right = Math.min(doc.width, Math.ceil(b.right) + band);
      const bottom = Math.min(doc.height, Math.ceil(b.bottom) + band);
      const width = right - left;
      const height = bottom - top;
      if (width <= 0 || height <= 0) return null;
      // The band: the selection grown, less the selection
      const ring = newCanvas(width, height);
      const c = ring.getContext("2d", { willReadFrequently: true });
      const clip = selectionCanvas(selection);
      for (let step = 0; step < 16; step++) {
        const turn = (step / 16) * Math.PI * 2;
        for (const reach of [band / 2, band]) c.drawImage(clip, b.left - left + Math.round(Math.cos(turn) * reach), b.top - top + Math.round(Math.sin(turn) * reach));
      }
      c.globalCompositeOperation = "destination-out";
      c.drawImage(clip, b.left - left, b.top - top);
      const inBand = c.getImageData(0, 0, width, height).data;
      const data = page || sampleData(doc, true);
      const place = gradientPlace(Object.assign({}, spec, { reverse: false }));
      const STEPS = Math.max(4, Math.min(64, Math.round(length / 6)));
      const bins = Array.from({ length: STEPS + 1 }, () => [[], [], []]);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (inBand[(y * width + x) * 4 + 3] < 128) continue;
          const t = place(left + x + 0.5, top + y + 0.5);
          if (!(t >= -0.02 && t <= 1.02)) continue;
          const bin = bins[Math.max(0, Math.min(STEPS, Math.round(t * STEPS)))];
          const i = ((top + y) * doc.width + left + x) * 4;
          bin[0].push(data[i]);
          bin[1].push(data[i + 1]);
          bin[2].push(data[i + 2]);
        }
      }
      const median = (list) => {
        list.sort((p, q) => p - q);
        return list[list.length >> 1];
      };
      const stops = [];
      bins.forEach((bin, k) => {
        if (bin[0].length >= 3) stops.push({ at: k / STEPS, r: median(bin[0]), g: median(bin[1]), b: median(bin[2]), a: 1 });
      });
      // The band goes all round the selection: what it says covers all of the gradient that
      // shows, and beyond it the gradient keeps its last colours
      if (!stops.length) return null;
      if (stops.length === 1) return [Object.assign({}, stops[0], { at: 0 }), Object.assign({}, stops[0], { at: 1 })];
      return stops;
    },
    // Edit > Generative Fill: the selection and what surrounds it, read from every pixel layer
    // and never from the text, go to an image model through `draw(canvas, { ratio, size })`,
    // which resolves with the model's picture. Such a picture comes back a little moved or
    // resized: Auto-Align Layers' engine lays it back on the page by what lies around the
    // selection, and only the selection is kept, on a new layer above the active one.
    // `ratios`: the shapes the model draws, as { label, value }. Long: progress goes 0 to 1.
    // It runs alongside the person's work: the page, the selection and the active layer are the
    // ones of the moment it starts, and `settle(doc)` resolves when the page may take the layer
    // (no gesture under way). The new layer becomes the active one only if the active layers
    // are still those of the start.
    // A generation that waited its turn passes its own `doc`, `selection` and `activeIds`.
    // `fixed`: the model draws a square of that many pixels, in place to the pixel (LaMa Manga,
    // on this device): the area is that square at the page's own size when the selection fits
    // in it, and the picture needs no aligning. `inPlace`: the picture needs no aligning either
    // (FLUX on this computer, which redraws only the selection); `longest`: its largest side.
    // `context`: how much of the page around the selection the model sees, in percent of the
    // selection's larger side (40 unless said).
    // `folder`: { name, id }, for Remove Text: the layer goes in that folder, made under the
    // texts the first time (its id kept in `folder.id`) and made again if it was deleted.
    // `matchTones`: the inside then brought to the brightness of the page that borders it.
    async generativeFill({ draw, ratios, name, settle, doc: wanted, selection: chosen, activeIds, hide, fixed, inPlace: drawnInPlace, longest, context, folder, matchTones: tones }, progress = () => {}) {
      const doc = wanted || app.doc;
      if (!doc || !app.docs.includes(doc)) return { outcome: "gone" };
      const selection = chosen || doc.state.selection;
      if (!selection || (!chosen && doc.state.quickMask)) return { outcome: "none" };
      // The debug mode (see generative-debug.js): its settings in place of the usual ones, and
      // each step's picture kept for it
      const run = window.TypeRGenDebug ? window.TypeRGenDebug.begin({ selection: [selection.bounds.width, selection.bounds.height] }) : null;
      const tuned = run ? run.options : null;
      const inPlace = Boolean(fixed || drawnInPlace || (tuned && !tuned.align));
      const b = selection.bounds;
      const activeAtStart = (activeIds || doc.state.activeIds).slice();
      const sizeAtStart = [doc.width, doc.height];
      // Enough around the selection for the model to see the art it continues
      const reach = Math.max(tuned && tuned.reach !== 40 ? 0 : 48, Math.round((Math.max(b.width, b.height) * (tuned && tuned.reach !== 40 ? tuned.reach : context || 40)) / 100));
      let x0 = b.left - reach;
      let y0 = b.top - reach;
      let x1 = b.right + reach;
      let y1 = b.bottom + reach;
      // Grown to the model's nearest shape, then slid inside the page, then cut by it
      const shape = (ratios || [{ label: "1:1", value: 1 }]).reduce((best, one) => (Math.abs(Math.log(one.value / ((x1 - x0) / (y1 - y0)))) < Math.abs(Math.log(best.value / ((x1 - x0) / (y1 - y0)))) ? one : best));
      if (tuned && !tuned.snap) {
        // Its own shape, as the margin gives it
      } else if ((x1 - x0) / (y1 - y0) < shape.value) {
        const grow = (y1 - y0) * shape.value - (x1 - x0);
        x0 -= grow / 2;
        x1 += grow / 2;
      } else {
        const grow = (x1 - x0) / shape.value - (y1 - y0);
        y0 -= grow / 2;
        y1 += grow / 2;
      }
      const inside = (a, z, limit) => {
        const length = z - a;
        if (length >= limit) return [0, limit];
        if (a < 0) return [0, Math.round(length)];
        if (z > limit) return [limit - Math.round(length), limit];
        return [Math.round(a), Math.round(a) + Math.round(length)];
      };
      // A model that draws a fixed square (LaMa) gets the page at its own size, never scaled: a
      // side shorter than the square grows to it, and a bigger area is drawn square by square
      // (see viaLocal in generative.js)
      if (fixed && x1 - x0 < fixed) {
        const cx = (x0 + x1) / 2;
        x0 = cx - fixed / 2;
        x1 = cx + fixed / 2;
      }
      if (fixed && y1 - y0 < fixed) {
        const cy = (y0 + y1) / 2;
        y0 = cy - fixed / 2;
        y1 = cy + fixed / 2;
      }
      [x0, x1] = inside(x0, x1, doc.width);
      [y0, y1] = inside(y0, y1, doc.height);
      const width = x1 - x0;
      const height = y1 - y0;
      if (width <= 0 || height <= 0) return { outcome: "none" };
      // The page as the model sees it: on white, without the text layers, nor the layers a
      // tool leaves out (the Bubble Reshaper's new bubble, so that the old one goes whole)
      const area = newCanvas(width, height);
      const actx = area.getContext("2d", { willReadFrequently: true });
      actx.fillStyle = "#fff";
      actx.fillRect(0, 0, width, height);
      const drawn = newCanvas(width, height);
      paintDoc(doc, drawn.getContext("2d"), { x: -x0, y: -y0, skip: (item) => item.kind === "text" || Boolean(hide && hide.includes(item.id)) });
      actx.drawImage(drawn, 0, 0);
      // A big area goes smaller, a small one bigger: the models draw at one to four megapixels
      // anyway, and some refuse a picture under 256 pixels a side
      const LONGEST = longest || 2048;
      const SHORTEST = 512;
      const scale = fixed ? 1 : Math.min(LONGEST / Math.max(width, height), Math.max(1, SHORTEST / Math.min(width, height), tuned && tuned.least ? Math.sqrt((tuned.least * 1e6) / (width * height)) : 0));
      let sent = area;
      if (scale !== 1) {
        sent = newCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
        const sctx = sent.getContext("2d");
        sctx.imageSmoothingQuality = "high";
        sctx.drawImage(area, 0, 0, sent.width, sent.height);
      }
      // The selection, a little grown: where the picture may differ from the page. Models that
      // take a mask get it black on white, at the size sent; the aligner leaves it out.
      const hole = newCanvas(width, height);
      const hctx = hole.getContext("2d", { willReadFrequently: true });
      const clip = selectionCanvas(selection);
      const grow = Math.max(3, Math.round(Math.max(b.width, b.height) * 0.02));
      for (let step = 0; step < 16; step++) {
        const turn = (step / 16) * Math.PI * 2;
        hctx.drawImage(clip, b.left - x0 + Math.round(Math.cos(turn) * grow), b.top - y0 + Math.round(Math.sin(turn) * grow));
      }
      hctx.drawImage(clip, b.left - x0, b.top - y0);
      const holeData = hctx.getImageData(0, 0, width, height).data;
      const mask = newCanvas(sent.width, sent.height);
      const kctx = mask.getContext("2d", { willReadFrequently: true });
      const black = newCanvas(width, height);
      const bctx = black.getContext("2d");
      bctx.drawImage(hole, 0, 0);
      bctx.globalCompositeOperation = "source-in";
      bctx.fillStyle = "#000";
      bctx.fillRect(0, 0, width, height);
      kctx.fillStyle = "#fff";
      kctx.fillRect(0, 0, mask.width, mask.height);
      kctx.drawImage(black, 0, 0, mask.width, mask.height);
      // Always 2K for the models that take a size, even for a small area: at 1K a model draws a
      // screentone's dots as a soft grey, which comes back paler and blurred once brought to the
      // page; at 2K it draws them as dots, which stay dots (measured on four sound effects over
      // screentone: half the sharpness at 1K, and a patch paler than the page)
      const size = tuned && tuned.size !== "auto" ? tuned.size : "2K";
      if (run) {
        run.facts({ area: [width, height], sent: [sent.width, sent.height], share: (b.width * b.height) / (width * height), sizeAsked: size, ratio: shape.label });
        run.stage("sent", sent);
        run.stage("mask", mask);
      }
      const picture = await draw(sent, { ratio: shape.label, size, mask, inside: { left: (b.left - x0) * scale, top: (b.top - y0) * scale, width: b.width * scale, height: b.height * scale } });
      // Meanwhile the page may have closed
      if (!app.docs.includes(doc)) {
        if (run) run.end({ outcome: "page closed" });
        return { outcome: "gone" };
      }
      progress(0.05);
      // First laid over the area as it is, stretched to it
      const made = newCanvas(width, height);
      const mctx = made.getContext("2d", { willReadFrequently: true });
      mctx.imageSmoothingQuality = "high";
      mctx.drawImage(picture, 0, 0, width, height);
      if (run) run.stage("returned", picture);
      if (picture.close) picture.close();
      // Then aligned on what surrounds the selection: the selection itself, a little grown (the
      // hole), differs on purpose (its text is gone) and says nothing about where the picture goes
      const holed = (canvas) => {
        const data = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, width, height).data;
        for (let i = 3; i < data.length; i += 4) if (holeData[i]) data[i] = 0;
        return data;
      };
      // Each way of laying it is judged on the same ground: how far its grey levels stay from
      // the page's around the selection. Kept as it came, moved and resized by a direct search
      // (enough for the drift of such models), or as Auto-Align Layers' engine finds it.
      const judge = inPlace ? null : fitGround(area, made, hole, x0, y0);
      const candidates = [{ how: "as is", m: null, error: inPlace ? 0 : judge.error(null) }];
      const searched = inPlace ? null : judge.search();
      if (searched) candidates.push({ how: "search", m: searched, error: judge.error(searched) });
      progress(0.2);
      const reference = inPlace ? null : holed(area);
      const moving = inPlace ? null : holed(made);
      let aligner = null;
      if (!inPlace) try {
        aligner = await startAligner();
        const found = await aligner.ask("analyse", {
          layers: [
            { id: "page", x: x0, y: y0, width, height, data: reference.buffer, fixed: true },
            { id: "picture", x: x0, y: y0, width, height, data: moving.buffer, fixed: false },
          ],
          projection: "auto",
        }, [reference.buffer, moving.buffer], (percent) => progress(0.2 + (percent / 100) * 0.6));
        const move = found.moves.find((one) => one.id === "picture");
        if (move && !found.failed.includes("picture")) {
          const m = move.shift ? [1, 0, move.shift[0], 0, 1, move.shift[1], 0, 0, 1] : move.matrix;
          candidates.push({ how: "details", m, error: judge.error(m) });
        }
      } catch (error) {
        console.warn("TypeR web: Auto-Align Layers' engine couldn't place the generated picture", error);
      }
      const best = candidates.reduce((one, other) => (other.error < one.error - 0.05 ? other : one));
      const aligned = Number.isFinite(best.error);
      let placed = { canvas: made, left: x0, top: y0 };
      try {
        if (best.m && best.m[6] === 0 && best.m[7] === 0) {
          const m = best.m;
          placed = transformedPixels(made, x0, y0, rectFrom(x0, y0, x1, y1), [m[0] / m[8], m[3] / m[8], m[1] / m[8], m[4] / m[8], m[2] / m[8], m[5] / m[8]]);
        } else if (best.m) {
          const { data } = mctx.getImageData(0, 0, width, height);
          const out = await aligner.ask("warp", { data: data.buffer, width, height, x: x0, y: y0, matrix: best.m }, [data.buffer]);
          placed = { canvas: canvasOfBytes(out), left: out.left, top: out.top };
        }
      } catch (error) {
        console.warn("TypeR web: the generated picture could not be moved", error);
      } finally {
        if (aligner) aligner.stop();
      }
      if (!app.docs.includes(doc)) {
        if (run) run.end({ outcome: "page closed" });
        return { outcome: "gone" };
      }
      progress(0.9);
      // The picture laid on the area: the aligned one over the stretched one, so no edge shows through
      const laid = newCanvas(width, height);
      const lctx = laid.getContext("2d", { willReadFrequently: true });
      lctx.drawImage(made, 0, 0);
      if (placed.canvas !== made) lctx.drawImage(placed.canvas, placed.left - x0, placed.top - y0);
      // Unless turned off, the inside brought to the brightness of the page at its edge, whatever
      // the model. The picture's levels are no longer matched to the page's around the selection
      // (only in the debug mode, when asked): over a screentone, the page there is black and white
      // dots and the picture greys, and matching the two sent the greys to white. Laid again
      // without it, 77 of 83 pictures of four sound effects joined the page better.
      // Then a screentone's dots given back the contrast they have around the selection: brought
      // down from the model's size, they come back grey on light grey (see restoreDetail).
      if (run) run.stage("aligned", laid);
      if (tones || !fixed) {
        const laidData = lctx.getImageData(0, 0, width, height);
        const pageData = actx.getImageData(0, 0, width, height).data;
        if (tuned && tuned.histogram && !fixed) matchLevels(laidData.data, pageData, holeData);
        if (tones) matchTones(laidData.data, pageData, holeData, width, height);
        if (!fixed && !(tuned && tuned.detail === false)) restoreDetail(laidData.data, pageData, holeData, width, height);
        lctx.putImageData(laidData, 0, 0);
      }
      progress(0.95);
      const pixels = newCanvas(b.width, b.height);
      pixels.getContext("2d").drawImage(laid, x0 - b.left, y0 - b.top);
      if (run) {
        run.stage("final", laid);
        run.stage("kept", pixels);
        run.end({ outcome: "done", how: best.how, tried: inPlace ? "" : candidates.map((one) => `${one.how} ${one.error.toFixed(2)}`).join(", ") });
      }
      if (settle) await settle(doc);
      if (!app.docs.includes(doc)) return { outcome: "gone" };
      // A page cropped or resized meanwhile has moved its places: the picture would land wrong
      if (doc.width !== sizeAtStart[0] || doc.height !== sizeAtStart[1]) return { outcome: "resized" };
      const op = { t: "patch", source: { canvas: pixels, x: b.left, y: b.top }, clip: clipOf(selection, 0, 0) };
      const layer = newRaster(name || "Generative Fill", { paint: [op] });
      // Above the layer active at the start, or the one active now, or on top
      const layers = doc.state.layers.slice();
      if (folder) {
        // Remove Text: each area on its own layer, all in the folder of their run, above TypeR
        // Clean, or under the texts; closed, so many areas don't fill the Layers panel
        let home = layers.findIndex((item) => item.id === folder.id && item.kind === "group");
        if (home < 0) {
          const clean = layers.findIndex((item) => item.clean);
          home = clean >= 0 ? clean + 1 : underTexts(layers);
          const group = { id: newId(), kind: "group", name: folder.name || "Text removed", visible: true, opacity: 1, blend: "pass through", open: false, group: clean >= 0 ? layers[clean].group || null : null };
          layers.splice(home, 0, group);
          folder.id = group.id;
        }
        layer.group = folder.id;
        layers.splice(home, 0, layer);
      } else {
        let at = layers.findIndex((item) => item.id === activeAtStart[activeAtStart.length - 1]);
        if (at < 0) at = layers.findIndex((item) => item.id === doc.state.activeIds[doc.state.activeIds.length - 1]);
        if (at >= 0) {
          layer.group = layers[at].kind === "group" ? layers[at].id : layers[at].group;
          layers.splice(layers[at].kind === "group" ? at : at + 1, 0, layer);
        } else layers.push(layer);
      }
      const unchanged = !folder && doc.state.activeIds.length === activeAtStart.length && doc.state.activeIds.every((id, i) => id === activeAtStart[i]);
      commitState(doc, folder ? "Remove Text" : "Generative Fill", unchanged ? { layers, activeIds: [layer.id] } : { layers });
      if (app.doc === doc) firePanelEvent(EVENT_HISTORY);
      progress(1);
      return { outcome: "done", aligned, how: best.how, error: Math.round(best.error * 100) / 100, tried: candidates.map((one) => `${one.how} ${one.error.toFixed(2)}`).join(", "), id: layer.id, doc };
    },
    // Settings > Type units changed: TypeR's panel reads the active text again, in the new unit
    typeUnitChanged() {
      if (app.doc) firePanelEvent(EVENT_SELECT);
    },
    pickColor(x, y) {
      const doc = app.doc;
      if (!doc) return null;
      const canvas = newCanvas(1, 1);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      paintDoc(doc, ctx, { keep: true, x: -Math.floor(x), y: -Math.floor(y) });
      const px = ctx.getImageData(0, 0, 1, 1).data;
      return px[3] ? { r: px[0], g: px[1], b: px[2] } : null;
    },
    /* ---- text ---- */
    // `orientation`: "vertical" for Photoshop's Vertical Type, its lines from top to bottom
    // (x, y is then the top of its first line, or the top right of its box). Its lines start
    // at the top, as a Chinese or Japanese page sets them, where a horizontal text is centred.
    newText(x, y, value, box, orientation) {
      const doc = app.doc;
      if (!doc) return null;
      const d = app.textDefaults;
      const text = value || "";
      const way = orientation === "vertical" ? "vertical" : "horizontal";
      const style = { fontPostScriptName: d.font, fontName: d.family, fontStyleName: d.style, size: d.size, impliedFontSize: d.size, autoLeading: true, tracking: 0, horizontalScale: 100, verticalScale: 100, ligature: d.ligature, textLanguage: d.language, autoKern: d.autoKern === "manual" || d.autoKern === "opticalKern" ? d.autoKern : "metricsKern", color: { red: app.fg.r, green: app.fg.g, blue: app.fg.b } };
      const params = { layerText: { textKey: text, antiAlias: d.antiAlias || "antiAliasSmooth", textClickPoint: { horizontal: (x / doc.width) * 100, vertical: (y / doc.height) * 100 }, textStyleRange: [{ from: 0, to: text.length, textStyle: style }], paragraphStyleRange: [{ from: 0, to: text.length, paragraphStyle: Object.assign({ alignment: way === "vertical" ? "left" : "center", autoLeadingPercentage: 1.2 }, d.hyphenate ? { hyphenate: true } : {}) }], textShape: [box ? { textType: "box", orientation: way, box: Object.assign({ verticalAlign: d.verticalAlign }, box) } : { textType: "point", orientation: way }] } };
      const layer = newTextLayer(doc, params, null, text || "Text");
      commitState(doc, "Type Tool", { layers: addNewTexts(doc.state.layers, [layer], textSpotOf(doc)), activeIds: [layer.id] });
      firePanelEvent(EVENT_SELECT);
      return layer;
    },
    setText(id, value, coalesce) {
      const doc = app.doc;
      const layer = doc && doc.state.layers.find((item) => item.id === id && item.kind === "text");
      if (!layer) return;
      const base = layer.params.layerText.textStyleRange[0].textStyle;
      const params = paramsFromStyle({ textProps: layer.params }, value, null, shownSize(base));
      params.layerText.textClickPoint = clone(layer.params.layerText.textClickPoint);
      if (boxShape(layer.params.layerText)) params.layerText.textShape = clone(layer.params.layerText.textShape);
      // Typed in, a text from a PSD keeps breaking its lines as Photoshop did (see fitOf)
      const fit = layer.raster && boxShape(params.layerText) ? fitOf(layer, doc) : 0;
      if (fit) boxShape(params.layerText).box.fit = fit;
      if (layer.params.layerText.textStyleRange.length > 1) params.layerText.textStyleRange = rangesAfterEdit(layer.params.layerText, params.layerText.textKey);
      const name = String(value).replace(/[\r\n]+/g, " ").substring(0, 60) || layer.name;
      // Typing redraws where the text was and where it is, not the whole page
      // (a styled folder draws its stroke around all it holds: the whole page then)
      const styled = layer.group && styledParentOf(layer, new Map(doc.state.layers.map((item) => [item.id, item])), doc.state.layers);
      const next = Object.assign({}, layer, { params, raster: null, name, source: null });
      // A letter typed may be drawn quickly, and drawn again once the typing pauses (see
      // drawTextFrom): that pause starts again with each letter
      const typing = coalesce === "typing";
      if (typing) quickTexts++;
      try {
        const before = styled ? null : visualBounds(layer, doc);
        commitState(doc, "Edit Type", { layers: doc.state.layers.map((item) => (item.id === layer.id ? next : item)) }, coalesce, () => unionRect(doc, before, before && visualBounds(next, doc)));
      } finally {
        if (typing) quickTexts--;
      }
      if (typing && (refineTimer || refining)) refineLater();
      // The panel reads the text again each time it is told, and works out its shapes: told
      // once the typing pauses, as Photoshop tells it once the text is typed in, not at
      // every letter
      clearTimeout(typingTold);
      if (coalesce === "typing") typingTold = setTimeout(() => firePanelEvent(EVENT_HISTORY), TYPING_PAUSE);
      else firePanelEvent(EVENT_HISTORY);
    },
    // Font, size, leading, colour, alignment: on all the selected text layers, or on the
    // letters of `range` when text is selected in the editor. A patch can be a function of
    // each style, for what is relative to it.
    setTextStyle(ids, patch, paragraphPatch, coalesce, range) {
      const doc = app.doc;
      if (!doc) return;
      endStylePreview(doc);
      commitState(doc, "Character", { layers: styledTexts(doc, ids, patch, paragraphPatch, range) }, coalesce);
      firePanelEvent(EVENT_HISTORY);
    },
    // The same, only shown: what a font would look like while the pointer is on it in the font
    // list, as in Photoshop. No step of history, and nothing kept: `patch` null takes it back.
    // `doc`: the page it was tried on, which may no longer be the one in front.
    previewTextStyle(ids, patch, range, doc = app.doc) {
      if (!doc) return;
      const had = endStylePreview(doc);
      if (patch) {
        const layers = new Map();
        styledTexts(doc, ids, patch, null, range).forEach((layer, at) => {
          if (layer !== doc.state.layers[at]) layers.set(layer.id, layer);
        });
        // Shown in the texts' place for as long as the page is in this state
        if (layers.size) doc.stylePreview = { state: doc.state, layers };
      }
      if (!had && !doc.stylePreview) return;
      if (doc === app.doc) emit("render");
    },
    // The side handles: the box changes and the text flows again. A base layer in, so
    // a whole gesture starts from the same text.
    setTextFrame(base, frame, coalesce) {
      const doc = app.doc;
      if (!doc || !doc.state.layers.some((item) => item.id === base.id)) return;
      const params = clone(base.params);
      const lt = params.layerText;
      if (!boxShape(lt) && base.source !== undefined && base.source !== null && !base.manualBreaks) unwrapText(lt, base.source);
      const orientation = (lt.textShape && lt.textShape[0] && lt.textShape[0].orientation) || "horizontal";
      // A box from a PSD has no vertical alignment yet: resizing it gives it the usual one
      const verticalAlign = (boxShape(lt) && boxShape(lt).box.verticalAlign) || app.textDefaults.verticalAlign;
      lt.textShape = [{ textType: "box", orientation, box: { width: Math.max(1, frame.width), height: Math.max(1, frame.height), autoHeight: Boolean(frame.autoHeight), verticalAlign } }];
      // A vertical text's anchor is the top right of its box, where its first line is
      lt.textClickPoint = { horizontal: ((orientation === "vertical" ? frame.left + Math.max(1, frame.width) : frame.left) / doc.width) * 100, vertical: (frame.top / doc.height) * 100 };
      commitState(doc, "Text Box", { layers: replaceLayer(doc, base, { params, raster: null }) }, coalesce);
      firePanelEvent(EVENT_HISTORY);
    },
    // The corners: the size of the text, with its box, around a fixed point of the frame
    scaleTextFrom(base, factor, ax, ay, coalesce) {
      const doc = app.doc;
      if (!doc || !doc.state.layers.some((item) => item.id === base.id)) return null;
      const before = frameOf(base, doc);
      const { next, size } = grownText(base, factor);
      const after = frameOf(next, doc);
      const moved = shifted(next, before.left + ax * before.width - (after.left + ax * after.width), before.top + ay * before.height - (after.top + ay * after.height), doc);
      commitState(doc, "Character", { layers: replaceLayer(doc, base, moved) }, coalesce);
      firePanelEvent(EVENT_HISTORY);
      return size;
    },
    // Several texts from the corners of the frame around them all, as one: each grows as its own
    // corner would make it, and its middle moves away from `pivot` as much; without a pivot, each
    // stays where it is. A text in perspective, its surface. One step in the history; the size of
    // the last text, or null.
    scaleTexts(bases, factor, pivot, coalesce) {
      const doc = app.doc;
      if (!doc) return null;
      const changed = new Map();
      let size = null;
      bases.forEach((base) => {
        if (base.kind !== "text" || !doc.state.layers.some((item) => item.id === base.id)) return;
        const [px, py] = pivot || middleOfText(base, doc);
        const away = ([x, y]) => [px + (x - px) * factor, py + (y - py) * factor];
        if (base.warp) {
          const scaled = ([x, y]) => [x * factor, y * factor];
          changed.set(base.id, Object.assign({}, base, { warp: Object.assign({}, base.warp, { corners: base.warp.corners.map(away), bendTop: scaled(base.warp.bendTop), bendBottom: scaled(base.warp.bendBottom), auto: base.warp.auto ? [base.warp.auto[0] * factor, base.warp.auto[1] * factor] : undefined }) }));
          return;
        }
        const from = middleOfText(base, doc);
        const made = grownText(base, factor);
        const now = middleOfText(made.next, doc);
        const [x, y] = away(from);
        changed.set(base.id, shifted(made.next, x - now[0], y - now[1], doc));
        size = made.size;
      });
      if (!changed.size) return null;
      commitState(doc, "Free Transform", { layers: doc.state.layers.map((layer) => changed.get(layer.id) || layer) }, coalesce);
      firePanelEvent(EVENT_HISTORY);
      return size;
    },
    // Turns a text by `delta` radians around `pivot`, as Photoshop's transform controls do.
    // It stays a text: Photoshop gets it turned, and it can still be typed in.
    turnText(base, delta, pivot, coalesce) {
      ops.turnTexts([base], delta, pivot, coalesce);
    },
    // Several texts around the same pivot, in one step of the history
    turnTexts(bases, delta, pivot, coalesce) {
      const doc = app.doc;
      if (!doc) return;
      const changed = new Map();
      bases.forEach((base) => {
        if (base && base.kind === "text" && doc.state.layers.some((item) => item.id === base.id)) changed.set(base.id, turnedText(base, delta, pivot, doc));
      });
      if (!changed.size) return;
      commitState(doc, "Free Transform", { layers: doc.state.layers.map((layer) => changed.get(layer.id) || layer) }, coalesce);
      firePanelEvent(EVENT_HISTORY);
    },
    // Type > Convert: a box becomes a point text with the lines it had, and back
    convertText(id) {
      const doc = app.doc;
      const layer = doc && doc.state.layers.find((item) => item.id === id && item.kind === "text");
      if (!layer) return;
      const layout = layoutLayer(layer, doc);
      // Every line, the ones a box too small doesn't show too: nothing typed gets lost
      const rows = layout.relative.wrapped.map((runs) => ({ runs }));
      if (!boxShape(layer.params.layerText)) {
        const f = textBoxOf(layer, doc);
        const widest = layout.relative.lines.reduce((max, line) => Math.max(max, line.m.advance), 0);
        // A vertical text's lines run down its box, which then grows to the left with them.
        // They stay where they are: the box starts where they do, by how they are aligned.
        if (layout.vertical) {
          const long = widest + 2;
          const align = (layer.params.layerText.paragraphStyleRange[0].paragraphStyle.alignment) || "center";
          const top = layout.anchor[1] - (align === "left" ? 0 : align === "right" ? long : long / 2);
          ops.setTextFrame(layer, { left: f.left, top, width: f.width, height: long, autoHeight: true });
        } else ops.setTextFrame(layer, { left: f.left, top: f.top, width: Math.max(f.width, widest) + 2, height: f.height, autoHeight: true });
        return;
      }
      const params = clone(layer.params);
      const lt = params.layerText;
      const paragraph = lt.paragraphStyleRange[0].paragraphStyle;
      const key = rows.map((row) => row.runs.map((run) => run.text).join("")).join("\r");
      const first = lt.textStyleRange[0].textStyle;
      lt.textKey = key;
      if (lt.textStyleRange.length > 1) lt.textStyleRange = rangesOfLines(rows, first);
      else lt.textStyleRange[0].to = key.length;
      lt.paragraphStyleRange[0].to = key.length;
      lt.textShape = [{ textType: "point", orientation: layout.vertical ? "vertical" : "horizontal" }];
      const f = layout.frame;
      const align = paragraph.alignment || "center";
      let x = align === "left" ? f.left : align === "right" ? f.right : f.xMid;
      let y = f.top + (layout.relative.lines[0] ? layout.relative.lines[0].baseline : 0);
      if (layout.vertical) {
        // Its first line stays where it is: the anchor on the middle of it, at its top,
        // its middle or its bottom as the text is aligned
        const first = layout.relative.lines[0] ? layout.relative.lines[0].baseline : 0;
        const point = relativeLayout(lt, doc.resolution).lines[0];
        x = f.right - first + (point ? point.baseline : 0);
        y = align === "left" ? f.top : align === "right" ? f.bottom : f.yMid;
      }
      lt.textClickPoint = { horizontal: (x / doc.width) * 100, vertical: (y / doc.height) * 100 };
      commitState(doc, "Convert Text", { layers: replaceLayer(doc, layer, { params, raster: null }) });
    },
    // The text typed on the page, or none: it shows as TypeR sets it (see asTyped)
    showTyped(id) {
      const before = app.typed;
      app.typed = id && app.doc ? { doc: app.doc, id } : null;
      const changes = (typed) => Boolean(typed) && typed.doc.state.layers.some((layer) => layer.id === typed.id && layer.raster);
      if (changes(before) || changes(app.typed)) emit("render");
    },
    // The Line Breaks window: the page shows a break before it is clicked
    previewBreaks(id, model, breaks) {
      const doc = app.doc;
      if (!doc) return;
      const layer = id && doc.state.layers.find((item) => item.id === id);
      const next = layer ? layerWithBreaks(layer, doc, model, breaks) : null;
      if (!next && !doc.preview) return;
      doc.preview = next;
      emit("render");
    },
    setLineBreaks(id, model, breaks) {
      const doc = app.doc;
      const layer = doc && doc.state.layers.find((item) => item.id === id);
      if (!layer) return;
      doc.preview = null;
      commitState(doc, "Line Breaks", { layers: replaceLayer(doc, layer, layerWithBreaks(layer, doc, model, breaks)) });
      firePanelEvent(EVENT_HISTORY);
    },
    /* ---- Image > Levels ---- */
    // The active pixel layer, or what of it is selected. Its pixels are read once: each change
    // redraws the selected part only, and the page shows it before anything is applied.
    levelsBegin() {
      const doc = app.doc;
      if (!doc) return { error: "none" };
      const layer = activeRaster(doc);
      if (!layer || layer.adjustment) return { error: "none" };
      if (lockOf(layer, "pixels")) return { error: "locked" };
      const visual = visualOf(Object.assign({}, layer, { mask: null, vectorMask: null }), doc);
      if (!visual || !visual.canvas.width || !visual.canvas.height) return { error: "empty" };
      const width = visual.canvas.width;
      const height = visual.canvas.height;
      const canvas = newCanvas(width, height);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(visual.canvas, 0, 0);
      const source = ctx.getImageData(0, 0, width, height);
      const output = new ImageData(new Uint8ClampedArray(source.data), width, height);
      let box = { left: 0, top: 0, right: width, bottom: height };
      let inside = null;
      const selection = doc.state.selection;
      if (selection) {
        const b = selection.bounds;
        box = {
          left: Math.max(0, Math.floor(b.left - visual.x)),
          top: Math.max(0, Math.floor(b.top - visual.y)),
          right: Math.min(width, Math.ceil(b.right - visual.x)),
          bottom: Math.min(height, Math.ceil(b.bottom - visual.y)),
        };
        if (box.right <= box.left || box.bottom <= box.top) return { error: "outside" };
        const m = selection.mask;
        if (m) {
          const bw = box.right - box.left;
          inside = new Uint8Array(bw * (box.bottom - box.top));
          for (let y = box.top; y < box.bottom; y++) {
            const my = y + visual.y - m.top;
            if (my < 0 || my >= m.height) continue;
            for (let x = box.left; x < box.right; x++) {
              const mx = x + visual.x - m.left;
              if (mx >= 0 && mx < m.width && m.data[my * m.width + mx]) inside[(y - box.top) * bw + x - box.left] = 1;
            }
          }
        }
      }
      // What the pixels hold, channel by channel, transparent ones left out
      const rgb = new Uint32Array(256);
      const r = new Uint32Array(256);
      const g = new Uint32Array(256);
      const b = new Uint32Array(256);
      const data = source.data;
      const bw = box.right - box.left;
      for (let y = box.top; y < box.bottom; y++) {
        let i = (y * width + box.left) * 4;
        let k = (y - box.top) * bw;
        for (let x = box.left; x < box.right; x++, i += 4, k++) {
          if (!data[i + 3] || (inside && !inside[k])) continue;
          r[data[i]]++;
          g[data[i + 1]]++;
          b[data[i + 2]]++;
          rgb[(data[i] * 77 + data[i + 1] * 151 + data[i + 2] * 28) >> 8]++;
        }
      }
      doc.levels = { id: layer.id, visual, canvas, ctx, source, output, box, inside, shown: false };
      return { histograms: { rgb, r, g, b }, selection: Boolean(selection), name: layer.name };
    },
    // `tables` is three lists of 256 values, red, green and blue; none shows the layer as it was
    levelsPreview(tables) {
      const doc = app.doc;
      const session = doc && doc.levels;
      if (!session) return;
      levelsPaint(session, tables);
      const layer = doc.state.layers.find((item) => item.id === session.id);
      if (!session.shown) {
        session.shown = true;
        doc.preview = Object.assign({}, layer, { bitmap: session.canvas, left: session.visual.x - (layer.dx || 0), top: session.visual.y - (layer.dy || 0), paint: NONE });
      }
      levelsForget(session);
      const { box, visual } = session;
      emit("render", pageRect(doc, visual.x + box.left, visual.y + box.top, visual.x + box.right, visual.y + box.bottom));
    },
    levelsEnd(tables) {
      const doc = app.doc;
      const session = doc && doc.levels;
      if (!session) return;
      doc.levels = null;
      if (session.shown) doc.preview = null;
      levelsForget(session);
      const layer = doc.state.layers.find((item) => item.id === session.id);
      if (!tables || !layer) {
        emit("render");
        return;
      }
      levelsPaint(session, tables);
      commitState(doc, "Levels", { layers: replaceLayer(doc, layer, withPixels(layer, session.canvas, session.visual.x, session.visual.y, pageMask(layer, doc))) });
      firePanelEvent(EVENT_HISTORY);
    },
    /* ---- Filter > Gaussian Blur ---- */
    // What it works on, as in Photoshop: the Quick Mask, the mask targeted in the Layers panel,
    // or the active layer: pixels, or a text (see blurText). { kind, id, name } or { error }.
    gaussianBlurTarget() {
      const doc = app.doc;
      if (!doc) return { error: "none" };
      if (doc.state.quickMask) return { kind: "quick", name: "Quick Mask" };
      const masked = ops.maskTarget(doc);
      if (masked) {
        if (masked.part === "vector") return { error: "vector" };
        if (masked.layer.locked) return { error: "locked" };
        return { kind: "mask", id: masked.id, name: masked.layer.name };
      }
      const id = doc.state.activeIds[doc.state.activeIds.length - 1];
      const layer = doc.state.layers.find((item) => item.id === id);
      if (layer && layer.kind === "text") return { kind: "text", id, name: layer.name };
      if (!layer || layer.kind !== "raster" || layer.adjustment) return { error: "none" };
      if (lockOf(layer, "pixels")) return { error: "locked" };
      return { kind: "pixels", id, name: layer.name };
    },
    // Filter > Gaussian Blur on that target, `radius` in pixels as Photoshop's (0.1 to 1000).
    // `options.id`: a pixel layer of one's own choosing; `options.coalesce`: the step a dialog
    // tries it out in; `options.area`: a part of the page, for a quick look at a large layer
    // (only that part is blurred). { partial } when done, { error } when not.
    gaussianBlur(radius, options = {}) {
      const variance = blurVariance(radius);
      return ops.blurWith(variance || null, "Gaussian Blur", options);
    },
    // Filter > Blur > Motion Blur, as Photoshop's: `angle` in degrees, `distance` in pixels (1
    // to 2000), on what Gaussian Blur works on, with its options
    motionBlur(angle, distance, options = {}) {
      return ops.blurWith(distance >= 1 ? motionKernel(angle, distance) : null, "Motion Blur", options);
    },
    // A blur (a Gaussian's variance, or a kernel: see blurOf) on Gaussian Blur's target, as the
    // step `name`
    blurWith(how, name, options = {}) {
      const doc = app.doc;
      const target = options.id !== undefined ? { kind: "pixels", id: options.id } : ops.gaussianBlurTarget();
      if (target.error) return target;
      if (target.kind === "text") return { error: "text" };
      const variance = how;
      if (!variance) return { partial: false };
      let done;
      if (target.kind === "pixels") {
        const layer = doc.state.layers.find((item) => item.id === target.id && item.kind === "raster");
        if (!layer) return { error: "none" };
        if (lockOf(layer, "pixels")) return { error: "locked" };
        done = blurredRaster(doc, layer, variance, options.area);
        if (done.error) return done;
        commitState(doc, name, { layers: replaceLayer(doc, layer, withPixels(layer, done.canvas, done.x, done.y, pageMask(layer, doc))) }, options.coalesce, () => pageRect(doc, done.rect.left, done.rect.top, done.rect.right, done.rect.bottom));
      } else {
        const holder = maskHolder(doc, target.kind === "quick" ? "quick" : "mask", target.id);
        if (!holder) return { error: "none" };
        done = blurredMask(doc, holder, variance, options.area);
        if (done.error) return done;
        const change = target.kind === "quick" ? { quickMask: done.mask } : { layers: replaceLayer(doc, holder, { mask: done.mask }) };
        commitState(doc, name, change, options.coalesce, () => pageRect(doc, done.rect.left, done.rect.top, done.rect.right, done.rect.bottom));
      }
      if (!options.coalesce) firePanelEvent(EVENT_HISTORY);
      return { partial: done.partial };
    },
    // Filter > Gaussian Blur on texts that stay texts (see TEXT_BLUR_SIZE): `radius` up to
    // textBlurMax, 0 to take a text's blur off and give it its Fill back. Texts that can't
    // (textBlurRefusal) are left as they are. The number of texts changed.
    blurText(ids, radius, coalesce) {
      const doc = app.doc;
      if (!doc) return 0;
      const chosen = new Set(ids);
      const size = Math.round(Math.max(0, Math.min(TEXT_BLUR_MAX, Number(radius) || 0)) * TEXT_BLUR_SIZE);
      let count = 0;
      const layers = doc.state.layers.map((layer) => {
        if (!chosen.has(layer.id) || layer.kind !== "text") return layer;
        const blurred = textBlurOf(layer) > 0;
        if (!blurred && (!size || textBlurRefusal(layer))) return layer;
        const was = blurred ? layer.effects.dropShadow : null;
        count++;
        if (!size) {
          const effects = Object.assign({}, layer.effects);
          delete effects.dropShadow;
          const fill = Math.max(0, Math.min(1, (was.opacity === undefined ? 100 : was.opacity) / 100));
          return Object.assign({}, layer, { effects: FX_DRAWN.some((name) => effects[name]) ? effects : undefined, knockout: fill <= 0, fill: fill > 0 && fill < 1 ? fill : undefined, raster: null });
        }
        const shadow = { enabled: true, blend: "normal", color: textColourOf(layer), opacity: was ? was.opacity : Math.round(fillOf(layer) * 100), angle: was ? was.angle : 90, distance: 0, spread: 0, size, knockout: false };
        return Object.assign({}, layer, { effects: Object.assign({}, layer.effects, { dropShadow: shadow }), knockout: true, fill: undefined, raster: null });
      });
      if (!count) return 0;
      commitState(doc, "Gaussian Blur", { layers }, coalesce);
      if (!coalesce) firePanelEvent(EVENT_HISTORY);
      return count;
    },
    // A text's blur as a radius (0: none), and why one can't be given to it as a text (null: it can)
    textBlur(layer) {
      return textBlurOf(layer);
    },
    textBlurRefusal(layer) {
      return textBlurRefusal(layer);
    },
    textBlurMax: TEXT_BLUR_MAX,
    // Convert to Smart Object, on texts: each becomes a smart object holding its text (see
    // SMART_FILTERS), which looks the same until it is given a filter. The number converted.
    convertToSmartObject(ids) {
      const doc = app.doc;
      if (!doc) return 0;
      const chosen = new Set(ids);
      let count = 0;
      const layers = doc.state.layers.map((layer) => {
        if (!chosen.has(layer.id) || layer.kind !== "text" || isSmart(layer)) return layer;
        count++;
        return Object.assign({}, layer, { filters: [] });
      });
      if (!count) return 0;
      commitState(doc, "Convert to Smart Object", { layers });
      firePanelEvent(EVENT_HISTORY);
      return count;
    },
    // A Smart Filter on these texts, those that are smart objects: `filter` ({ type, ...its
    // settings }) takes the place of the one of its type, or joins the list. The number changed.
    setSmartFilter(ids, filter, coalesce) {
      const doc = app.doc;
      const next = cleanFilter(filter);
      if (!doc || !next) return 0;
      const chosen = new Set(ids);
      let count = 0;
      const layers = doc.state.layers.map((layer) => {
        if (!chosen.has(layer.id) || !isSmart(layer)) return layer;
        const at = layer.filters.findIndex((item) => item.type === next.type);
        if (at >= 0 && JSON.stringify(layer.filters[at]) === JSON.stringify(next)) return layer;
        count++;
        return Object.assign({}, layer, { filters: at < 0 ? layer.filters.concat(next) : layer.filters.map((item, index) => (index === at ? next : item)) });
      });
      if (!count) return 0;
      commitState(doc, SMART_FILTER_NAMES[next.type], { layers }, coalesce);
      if (!coalesce) firePanelEvent(EVENT_HISTORY);
      return count;
    },
    // The filter of that type taken off these texts; one left with no filter is a plain text
    // again, saved as a text layer. The number changed.
    removeSmartFilter(ids, type) {
      const doc = app.doc;
      if (!doc) return 0;
      const chosen = new Set(ids);
      let count = 0;
      const layers = doc.state.layers.map((layer) => {
        if (!chosen.has(layer.id) || !isSmart(layer) || !layer.filters.some((item) => item.type === type)) return layer;
        count++;
        const out = Object.assign({}, layer, { filters: layer.filters.filter((item) => item.type !== type) });
        if (!out.filters.length) delete out.filters;
        return out;
      });
      if (!count) return 0;
      commitState(doc, SMART_FILTER_NAMES[type] || "Smart Filters", { layers });
      firePanelEvent(EVENT_HISTORY);
      return count;
    },
    // Whether a text is a smart object here, and its filter of a type (null: none)
    isSmart(layer) {
      return isSmart(layer);
    },
    smartFilterOf(layer, type) {
      return (isSmart(layer) && layer.filters.find((item) => item.type === type)) || null;
    },
    // Layer > Layer Style > Clear Layer Style: no stroke, no effects, and the blending back to
    // Normal at 100%, Fill 100%, as Photoshop clears it. On texts, pixel layers and folders (an
    // SFX keeps its own). The number of layers cleared.
    clearLayerStyle(ids) {
      const doc = app.doc;
      if (!doc) return 0;
      const chosen = new Set(ids || doc.state.activeIds);
      const byId = new Map(doc.state.layers.map((layer) => [layer.id, layer]));
      const inSfx = (layer) => Boolean(layer.sfx || (layer.group && byId.get(layer.group) && byId.get(layer.group).sfx));
      let count = 0;
      let refused = false;
      const layers = doc.state.layers.map((layer) => {
        if (!chosen.has(layer.id) || !(layer.kind === "text" || layer.kind === "group" || layer.kind === "raster") || layer.adjustment || layer.isBackground || inSfx(layer)) return layer;
        const plain = layer.kind === "group" ? "pass through" : "normal";
        const styled = Boolean(layer.stroke) || Boolean(layer.effects) || (layer.blend || plain) !== plain || (layer.opacity !== undefined && layer.opacity !== 1) || fillOf(layer) !== 1;
        if (!styled) return layer;
        if (layer.locked) {
          refused = true;
          return layer;
        }
        count++;
        const next = Object.assign({}, layer, { stroke: layer.kind === "raster" ? undefined : null, effects: undefined, blend: plain, opacity: 1, knockout: false, fill: undefined });
        if (layer.kind === "text") next.raster = null;
        return next;
      });
      if (refused) emit("layer-locked");
      if (!count) return 0;
      commitState(doc, "Clear Layer Style", { layers });
      firePanelEvent(EVENT_HISTORY);
      return count;
    },
    // The text's rectangle becomes a surface, with nothing moved yet
    startTextWarp(id) {
      const doc = app.doc;
      const layer = doc && doc.state.layers.find((item) => item.id === id && item.kind === "text");
      if (!layer || layer.warp || layer.rotated) return;
      const f = frameOf(Object.assign({}, layer, { raster: null }), doc);
      const [ax, ay] = anchorOf(layer.params.layerText, doc);
      const width = Math.max(1, f.width);
      const height = Math.max(1, f.height);
      const warp = {
        source: { left: f.left - ax, top: f.top - ay, width, height },
        corners: [[f.left, f.top], [f.left + width, f.top], [f.left + width, f.top + height], [f.left, f.top + height]],
        bendTop: [0, 0],
        bendBottom: [0, 0],
        wrap: 0,
      };
      commitState(doc, "Perspective", { layers: replaceLayer(doc, layer, { warp, raster: null }) });
      firePanelEvent(EVENT_HISTORY);
    },
    // A base layer in, so that a whole gesture starts from the same surface
    setTextWarp(base, warp, coalesce) {
      const doc = app.doc;
      if (!doc || !doc.state.layers.some((item) => item.id === base.id)) return;
      commitState(doc, "Perspective", { layers: replaceLayer(doc, base, { warp }) }, coalesce);
      firePanelEvent(EVENT_HISTORY);
    },
    // Photoshop's Warp Text on these texts: `envelope` as TypeRTextWarp takes it, null for None.
    // A text showing Photoshop's pixels is drawn here from then on.
    setEnvelope(ids, envelope, coalesce) {
      const doc = app.doc;
      if (!doc) return;
      const set = new Set(ids);
      const next = window.TypeRTextWarp.clean(envelope);
      const key = window.TypeRTextWarp.keyOf(next);
      let changed = false;
      const layers = doc.state.layers.map((layer) => {
        if (!set.has(layer.id) || layer.kind !== "text" || layer.warp || meshOn(layer)) return layer;
        if (window.TypeRTextWarp.keyOf(layer.envelope) === key) return layer;
        changed = true;
        const out = Object.assign({}, layer, { raster: null });
        if (next) out.envelope = next;
        else delete out.envelope;
        return out;
      });
      if (!changed) return;
      commitState(doc, "Warp Text", { layers }, coalesce);
      firePanelEvent(EVENT_HISTORY);
    },
    // Back to a plain text, where the surface was
    removeTextWarp(id) {
      const doc = app.doc;
      const layer = doc && doc.state.layers.find((item) => item.id === id && item.kind === "text");
      if (!layer || !layer.warp) return;
      const place = frameOf(layer, doc);
      const plain = Object.assign({}, layer, { warp: null });
      // In a perspective zone, it would be laid on it at once: it stays off it
      if (surfaceAt(surfacesOf(doc.state), placeOnSurface(layer, doc))) plain.offSurface = true;
      commitState(doc, "Perspective", { layers: replaceLayer(doc, layer, centredOn(plain, doc, place.xMid, place.yMid)) });
      firePanelEvent(EVENT_HISTORY);
    },
    /* ---- the Perspective tool (perspective-tool.js) ---- */
    // The grey levels of a zone of the page, without its texts: as it shows (`shown`), and,
    // where the layers above changed it, as its lowest picture alone has it (`under`): what
    // was drawn before any cleaning, the writing still on it
    surfaceGrey(zone) {
      const doc = app.doc;
      if (!doc) return null;
      const left = Math.max(0, Math.floor(zone.left));
      const top = Math.max(0, Math.floor(zone.top));
      const width = Math.min(doc.width, Math.ceil(zone.right)) - left;
      const height = Math.min(doc.height, Math.ceil(zone.bottom)) - top;
      if (width < 1 || height < 1) return null;
      const grey = (skip) => {
        const canvas = newCanvas(width, height);
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, width, height);
        paintDoc(doc, ctx, { x: -left, y: -top, keep: true, skip });
        const data = ctx.getImageData(0, 0, width, height).data;
        const out = new Uint8Array(width * height);
        for (let i = 0; i < out.length; i++) out[i] = (data[4 * i] * 77 + data[4 * i + 1] * 150 + data[4 * i + 2] * 29) >> 8;
        return out;
      };
      const shown = grey((layer) => layer.kind === "text");
      const byId = new Map(doc.state.layers.map((layer) => [layer.id, layer]));
      const lowest = doc.state.layers.find((layer) => layer.kind === "raster" && !layer.adjustment && layer.bitmap && chainOf(layer, byId).visible);
      let under = null;
      if (lowest && doc.state.layers.some((layer) => layer !== lowest && layer.kind === "raster")) {
        const group = (layer) => layer.kind === "group" && familyOf(doc.state.layers, layer.id).has(lowest.id);
        under = grey((layer) => layer !== lowest && !group(layer));
        let differs = 0;
        for (let i = 0; i < shown.length && differs < 40; i++) if (Math.abs(shown[i] - under[i]) > 24) differs++;
        if (differs < 40) under = null;
      }
      return { left, top, width, height, shown, under };
    },
    // A perspective zone drawn (see surfacesOf): the texts in it lie on it from then on.
    // `replaced`: the ids of the zones it takes the place of. Its id.
    addSurface({ corners, unit, found }, replaced = []) {
      const doc = app.doc;
      if (!doc) return null;
      const id = newId();
      const surfaces = surfacesOf(doc.state).filter((zone) => !replaced.includes(zone.id)).concat([{ id, corners, unit, wide: 1, found: found || { across: false, down: false } }]);
      commitState(doc, "Perspective Zone", { surfaces });
      firePanelEvent(EVENT_HISTORY);
      return id;
    },
    // Its corners, its size or its width changed: its texts follow
    setSurface(id, changes, coalesce) {
      const doc = app.doc;
      if (!doc || !surfacesOf(doc.state).some((zone) => zone.id === id)) return;
      commitState(doc, "Perspective Zone", { surfaces: surfacesOf(doc.state).map((zone) => (zone.id === id ? Object.assign({}, zone, changes) : zone)) }, coalesce);
      firePanelEvent(EVENT_HISTORY);
    },
    // A zone removed: its texts are plain texts again
    removeSurface(id) {
      const doc = app.doc;
      if (!doc || !surfacesOf(doc.state).some((zone) => zone.id === id)) return;
      commitState(doc, "Perspective Zone", { surfaces: surfacesOf(doc.state).filter((zone) => zone.id !== id) });
      firePanelEvent(EVENT_HISTORY);
    },
    // These texts, in a perspective zone, follow it (`on`) or stay as typed. One whose
    // corners were set by hand takes the zone's again. How many changed.
    setSurfaceFollow(ids, on) {
      const doc = app.doc;
      if (!doc) return 0;
      const set = new Set(ids);
      const zones = surfacesOf(doc.state);
      let count = 0;
      let refused = false;
      const layers = doc.state.layers.map((layer) => {
        if (!set.has(layer.id) || layer.kind !== "text" || !surfaceAt(zones, placeOnSurface(layer, doc))) return layer;
        const follows = Boolean(layer.warp && layer.warp.auto);
        if (follows === on && Boolean(layer.offSurface) === !on) return layer;
        if (lockOf(layer, "position")) {
          refused = true;
          return layer;
        }
        if (on && !layer.warp && !surfaceFits(layer, doc)) return layer;
        count++;
        const next = layer.warp ? liftedOff(layer, doc) : Object.assign({}, layer);
        if (on) delete next.offSurface;
        else next.offSurface = true;
        return next;
      });
      if (refused) emit("layer-locked");
      if (!count) return 0;
      commitState(doc, "Perspective", { layers });
      firePanelEvent(EVENT_HISTORY);
      return count;
    },
    // A text on a zone whose corners are taken by hand: its surface is its own from then on
    ownTextWarp(id) {
      const doc = app.doc;
      const layer = doc && doc.state.layers.find((item) => item.id === id && item.kind === "text");
      if (!layer || !layer.warp || !layer.warp.auto) return;
      commitState(doc, "Perspective", { layers: replaceLayer(doc, layer, { offSurface: true, warp: Object.assign({}, layer.warp, { auto: undefined }) }) });
      firePanelEvent(EVENT_HISTORY);
    },
    // Photoshop's Type > Orientation: the same text set across the page ("horizontal") or
    // down it ("vertical"). It stays where it is: a box keeps its place and its size, a box
    // as tall as its text keeps its lines as long as they were, and any other text its middle.
    setTextOrientation(ids, value) {
      const doc = app.doc;
      if (!doc) return;
      const way = value === "vertical" ? "vertical" : "horizontal";
      const set = new Set(ids);
      let changed = false;
      const plain = (layer) => Object.assign({}, layer, { rotated: false, spin: null, raster: null, mesh: null, outline: null, envelope: null });
      const layers = doc.state.layers.map((layer) => {
        if (!set.has(layer.id) || layer.kind !== "text" || layer.warp) return layer;
        if ((verticalOf(layer.params.layerText) ? "vertical" : "horizontal") === way) return layer;
        changed = true;
        const params = clone(layer.params);
        const lt = params.layerText;
        const shape = boxShape(lt);
        if (shape) shape.orientation = way;
        else lt.textShape = [{ textType: "point", orientation: way }];
        const fixed = shape && !shape.box.autoHeight;
        if (shape && !fixed) [shape.box.width, shape.box.height] = [shape.box.height, shape.box.width];
        // Centred lines become lines that start at the top, and back: what each way is set with
        lt.paragraphStyleRange.forEach((range) => {
          const from = way === "vertical" ? "center" : "left";
          if ((range.paragraphStyle.alignment || "center") === from) range.paragraphStyle.alignment = way === "vertical" ? "left" : "center";
        });
        const next = Object.assign({}, layer, { params, raster: null });
        // The box's own corner, or the middle of what shows, before any turn of the text
        const before = fixed ? textBoxOf(plain(layer), doc) : frameOf(plain(layer), doc);
        const after = fixed ? textBoxOf(plain(next), doc) : frameOf(plain(next), doc);
        const dx = fixed ? before.left - after.left : before.xMid - after.xMid;
        const dy = fixed ? before.top - after.top : before.yMid - after.yMid;
        const [a, b, c, d] = spinOf(layer) || [1, 0, 0, 1];
        return shifted(next, a * dx + c * dy, b * dx + d * dy, doc);
      });
      if (!changed) return;
      commitState(doc, "Text Orientation", { layers });
      firePanelEvent(EVENT_HISTORY);
    },
    setTextVerticalAlign(ids, value) {
      const doc = app.doc;
      if (!doc) return;
      const set = new Set(ids);
      let changed = false;
      const layers = doc.state.layers.map((layer) => {
        const shape = set.has(layer.id) && layer.kind === "text" && boxShape(layer.params.layerText);
        if (!shape || (shape.box.verticalAlign || "top") === value) return layer;
        changed = true;
        const params = clone(layer.params);
        boxShape(params.layerText).box.verticalAlign = value;
        return Object.assign({}, layer, { params, raster: null });
      });
      if (!changed) return;
      commitState(doc, "Text Box", { layers });
      firePanelEvent(EVENT_HISTORY);
    },
    setTextAntiAlias(ids, value) {
      const doc = app.doc;
      if (!doc) return;
      const set = new Set(ids);
      const layers = doc.state.layers.map((layer) => {
        if (!set.has(layer.id) || layer.kind !== "text" || layer.params.layerText.antiAlias === value) return layer;
        const params = clone(layer.params);
        params.layerText.antiAlias = value;
        return Object.assign({}, layer, { params, raster: null });
      });
      commitState(doc, "Anti-Alias", { layers });
      firePanelEvent(EVENT_HISTORY);
    },
    // `stroke` can be a function of each layer, for a change made on each one's own stroke
    setTextStroke(ids, stroke, coalesce) {
      const doc = app.doc;
      if (!doc) return;
      const set = new Set(ids);
      const strokeOf = typeof stroke === "function" ? stroke : () => stroke;
      commitState(doc, "Stroke", { layers: doc.state.layers.map((layer) => {
        if (!set.has(layer.id) || !styleable(layer)) return layer;
        const next = strokeOf(layer);
        if (next === layer.stroke) return layer;
        // A text's own pixels (Photoshop's) may hold its stroke: drawn again
        return Object.assign({}, layer, layer.kind === "text" ? { stroke: next, raster: null } : { stroke: next || undefined });
      }) }, coalesce);
    },
    // A text's or a pixel layer's effects (see FX_DEFAULTS): the whole `effects` object, or a
    // function of each layer for a change made on each one's own. Null takes them all off. The
    // pixels stay as they are, Photoshop's own included: only what is drawn around and on them
    // changes.
    setLayerEffects(ids, effects, coalesce) {
      const doc = app.doc;
      if (!doc) return;
      const set = new Set(ids);
      const effectsOf = typeof effects === "function" ? effects : () => effects;
      commitState(doc, "Layer Style", { layers: doc.state.layers.map((layer) => {
        if (!set.has(layer.id) || !styleable(layer)) return layer;
        const next = effectsOf(layer) || undefined;
        return next === layer.effects ? layer : Object.assign({}, layer, { effects: next });
      }) }, coalesce);
    },
    undo() {
      const doc = app.doc;
      if (!doc || doc.historyIndex <= 0) return false;
      ops.jump(doc.historyIndex - 1);
      emit("undo");
      return true;
    },
    redo() {
      const doc = app.doc;
      if (!doc || doc.historyIndex >= doc.history.length - 1) return false;
      ops.jump(doc.historyIndex + 1);
      emit("redo");
      return true;
    },
    // What a dialog tried out, gone as if it had never been
    rollbackHistory(index) {
      const doc = app.doc;
      if (!doc || doc.historyIndex <= index) return;
      ops.jump(index);
      doc.history.length = index + 1;
      emit("history");
    },
    // An action played as one state of history (Playback Options): what it made after the
    // state `fromId`, as one state named `name`. The last state stays itself, with its id, so a
    // page saved at the end stays saved. Nothing when the action changed nothing, or when the
    // state it started from is gone (past the history's length).
    groupHistory(doc, fromId, name) {
      if (!doc) return false;
      const from = doc.history.findIndex((entry) => entry.id === fromId);
      if (from < 0 || doc.historyIndex <= from + 1) {
        if (from >= 0 && doc.historyIndex === from + 1) doc.history[from + 1].name = name;
        emit("history");
        return false;
      }
      const last = doc.history[doc.historyIndex];
      last.name = name;
      last.coalesce = null;
      doc.history.splice(from + 1, doc.history.length, last);
      doc.historyIndex = from + 1;
      emit("history");
      return true;
    },
    jump(index) {
      const doc = app.doc;
      const before = sizeOf(doc);
      const left = doc.state;
      const { size } = doc.history[index];
      doc.historyIndex = index;
      doc.state = doc.history[index].state;
      if (size) Object.assign(doc, size);
      const resized = doc.width !== before.width || doc.height !== before.height || doc.resolution !== before.resolution;
      emit("history");
      emit("selection", doc.state.selection);
      // An undo redraws what it changed, when that can be told
      emit("render", resized ? undefined : changedRect(doc, left, doc.state));
      if (resized) sizeChanged(doc, before);
      firePanelEvent(EVENT_HISTORY);
    },
    /* ---- documents ---- */
    addDoc(fields) {
      const doc = createDoc(fields);
      setDoc(doc);
      return doc;
    },
    // A document session.js kept, as it was. Ids go on after its own, and its repeated
    // gestures stay apart from the ones to come, whose keys start over with the page.
    restoreDoc({ nextId: nextFree, name, path, stamp, handle, width, height, resolution, psd, idml, state, history, historyIndex, savedId, view }, activate) {
      nextId = Math.max(nextId, nextFree);
      history.forEach((entry) => { entry.coalesce = null; });
      if (view.fitted) view.seen = false;
      const doc = { id: newId(), name, path, stamp: stamp || null, handle: handle || null, width, height, resolution, psd: psd || null, idml: idml || null, sampleCache: null, sampleKey: "", state, history, historyIndex, savedId, view };
      if (doc.idml && window.TypeRInDesign) window.TypeRInDesign.adopt(doc);
      if (activate) setDoc(doc);
      else {
        app.docs.push(doc);
        emit("document", app.doc);
      }
      return doc;
    },
    newDocument({ name, width, height, resolution, background }) {
      const layer = newRaster(background ? (app.names && app.names.background) || "Background" : `${(app.names && app.names.layer) || "Layer"} 1`, { isBackground: Boolean(background) });
      if (background) {
        layer.bitmap = newCanvas(width, height);
        const ctx = layer.bitmap.getContext("2d");
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, width, height);
      }
      return ops.addDoc({ name, path: "new://" + newId(), width, height, resolution, layers: [layer] });
    },
    imageDocument(image, name, path, handle, resolution) {
      refuseIfTooLarge(image.naturalWidth || image.width, image.naturalHeight || image.height);
      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;
      const bitmap = newCanvas(width, height);
      bitmap.getContext("2d").drawImage(image, 0, 0);
      const layer = newRaster((app.names && app.names.background) || "Background", { bitmap, isBackground: true });
      return ops.addDoc({ name, path, width, height, resolution, layers: [layer], handle });
    },
    loadImage(url, name, path, handle, resolution) {
      return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(ops.imageDocument(image, name, path || url, handle, resolution));
        image.onerror = () => reject(new Error("Could not read " + name));
        image.src = url;
      });
    },
    // A PNG, a JPEG or a PSD, picked by the user or by TypeR's page sync
    // `aside`: the file bears the name of a page of the chapter without being that page (see
    // setAside)
    async openBlob(file, name, path, handle, aside = false) {
      handle = handle || fileHandles.get(handleKey(file)) || null;
      const named = path || "web-file://" + file.name;
      // The same name isn't the same file: every chapter has its 01.psd, and a file can
      // change on disk while its document is kept in the browser
      const stamp = fileStamp(file);
      const same = (doc) => !doc.stamp || doc.stamp === stamp;
      const known = (!aside && app.docs.find((doc) => doc.path === named && same(doc))) || app.docs.find((doc) => doc.path !== named && ops.sharedPath(doc.path) === named && same(doc));
      if (known) {
        if (handle && !known.handle) known.handle = handle;
        setDoc(known);
        return known;
      }
      // Another file of this name is open already: this one is a document of its own
      let key = named;
      if (!path && (aside || app.docs.some((doc) => doc.path === named))) {
        key = `${named}#${newId()}`;
        app.files.set(key, file);
      } else if (!path) ops.registerFile(file);
      if (/\.psd$/i.test(name) || /\.psb$/i.test(name)) {
        // Told by the file's first bytes, before anything is decoded
        const head = new DataView(await file.slice(0, 26).arrayBuffer());
        if (head.byteLength >= 26 && head.getUint32(0) === 0x38425053) refuseIfTooLarge(head.getUint32(18), head.getUint32(14));
        const read = await window.TypeRPSD.read(await file.arrayBuffer(), name, file);
        const doc = ops.addDoc(Object.assign(read, { name, path: key, handle, stamp }));
        emit("psd-opened", { doc, missing: read.missingFonts, notes: read.notes });
        return doc;
      }
      const resolution = await imageResolution(file);
      const url = URL.createObjectURL(file);
      try {
        const doc = await ops.loadImage(url, name, key, handle, resolution);
        doc.stamp = stamp;
        return doc;
      } finally {
        URL.revokeObjectURL(url);
      }
    },
    // A file read for Batch Save: a document that no tab shows, let go with dropDetached()
    async readDetached(file, name) {
      if (/\.ps[db]$/i.test(name)) {
        const head = new DataView(await file.slice(0, 26).arrayBuffer());
        if (head.byteLength >= 26 && head.getUint32(0) === 0x38425053) refuseIfTooLarge(head.getUint32(18), head.getUint32(14));
        const read = await window.TypeRPSD.read(await file.arrayBuffer(), name, file);
        return createDoc(Object.assign(read, { name, path: "batch://" + newId() }));
      }
      const url = URL.createObjectURL(file);
      try {
        const image = await new Promise((resolve, reject) => {
          const picture = new Image();
          picture.onload = () => resolve(picture);
          picture.onerror = () => reject(new Error("Could not read " + name));
          picture.src = url;
        });
        const width = image.naturalWidth;
        const height = image.naturalHeight;
        refuseIfTooLarge(width, height);
        const bitmap = newCanvas(width, height);
        bitmap.getContext("2d").drawImage(image, 0, 0);
        const layer = newRaster((app.names && app.names.background) || "Background", { bitmap, isBackground: true });
        return createDoc({ name, path: "batch://" + newId(), width, height, resolution: await imageResolution(file), layers: [layer] });
      } finally {
        URL.revokeObjectURL(url);
      }
    },
    dropDetached(doc) {
      forgetDocPixels(doc);
    },
    // A page opened in a tab behind the one in front (Remove Text on several pages, on the
    // chapter's closed pages): the page being worked on stays in front
    async openBehind(file, name, handle) {
      const doc = await ops.readDetached(file, name);
      doc.path = ops.registerFile(file);
      doc.handle = handle || null;
      doc.stamp = fileStamp(file);
      if (!app.doc) setDoc(doc);
      else {
        app.docs.push(doc);
        emit("document", app.doc);
      }
      return doc;
    },
    // The file on disk is now the document's: opening it again finds the document, and
    // the next save can tell whether someone else changed it
    fileWritten(doc, file) {
      const named = "web-file://" + file.name;
      // A document set aside stays so: its file isn't the one the chapter's page of that name reads
      if (doc.path !== ops.sharedPath(doc.path) || app.docs.some((one) => one !== doc && one.path === named)) {
        if (ops.sharedPath(doc.path) !== named || doc.path === named) doc.path = `${named}#${newId()}`;
        app.files.set(doc.path, file);
      } else doc.path = ops.registerFile(file);
      doc.stamp = fileStamp(file);
    },
    // Every chapter has its 01.psd, 02.psd…: an open document of the name of a page of another
    // chapter would be taken for that page (the pager, Flow, the script). Set aside, it keeps a
    // path of its own, and stays a document apart.
    setAside(doc) {
      if (doc.path !== ops.sharedPath(doc.path)) return;
      const file = app.files.get(doc.path);
      doc.path = `${doc.path}#${newId()}`;
      if (file && doc.stamp && fileStamp(file) === doc.stamp) app.files.set(doc.path, file);
    },
    // The path a document set aside had: the name its file bears
    sharedPath: (path) => String(path || "").replace(/^(web-file:\/\/.*)#\d+$/, "$1"),
    fileStamp,
    rememberHandle(file, handle) {
      fileHandles.set(handleKey(file), handle);
    },
    registerFile(file) {
      const key = "web-file://" + file.name;
      app.files.set(key, file);
      return key;
    },
    fontsReady() {
      return Fonts.builtinsLoaded();
    },
    closeDoc(doc) {
      const at = app.docs.indexOf(doc);
      if (at < 0) return;
      app.docs.splice(at, 1);
      forgetDocPixels(doc);
      if (!app.docs.length) releaseScratch();
      if (app.doc === doc) setDoc(app.docs[Math.min(at, app.docs.length - 1)] || null);
      else emit("document", app.doc);
    },
    // What was written can be older than the document: what was typed during a long
    // write is still to save
    markSaved(doc, savedId) {
      doc.savedId = savedId === undefined ? doc.history[doc.historyIndex].id : savedId;
      emit("saved", doc);
      emit("history");
    },
    closeAll() {
      app.docs.forEach(forgetDocPixels);
      releaseScratch();
      app.docs = [];
      app.doc = null;
    },
  };

  // Some layers of a page drawn on their own, as the page draws them: folders with their
  // opacity and style, clipped layers on their base. Those whose folder isn't among them
  // are drawn as if at the top of the page.
  const paintAlone = (doc, layers) => {
    const ids = new Set(layers.map((layer) => layer.id));
    const all = doc.state.layers;
    const alone = layers.map((layer) => {
      const at = all.indexOf(layer);
      let under = at - 1;
      while (under >= 0 && all[under].clipping && all[under].kind !== "group") under--;
      const lonely = layer.clipping && (under < 0 || !ids.has(all[under].id));
      const free = layer.group && !ids.has(layer.group);
      return lonely || free ? Object.assign({}, layer, lonely ? { clipping: false } : null, free ? { group: null } : null) : layer;
    });
    const canvas = newCanvas(doc.width, doc.height);
    paintDoc(Object.assign({}, doc, { state: Object.assign({}, doc.state, { layers: alone }), live: null, liveTransform: null, preview: null }), canvas.getContext("2d"));
    return canvas;
  };

  // The nearest folder above `id` that stays
  const outsideOf = (id, gone, layers) => {
    while (id && gone.has(id)) {
      const parent = layers.find((layer) => layer.id === id);
      id = parent ? parent.group || null : null;
    }
    return id || null;
  };

  const flattenLayers = (doc, layers) => {
    const canvas = newCanvas(doc.width, doc.height);
    const ctx = canvas.getContext("2d");
    layers.forEach((layer) => {
      // As they show: a pixel layer's effects become pixels too
      const visual = pageVisualOf(layer, doc);
      if (!visual) return;
      if (visual.under) drawUnder(ctx, visual, 0, 0, layer.opacity === undefined ? 1 : layer.opacity);
      ctx.globalAlpha = layer.opacity === undefined ? 1 : layer.opacity;
      ctx.globalCompositeOperation = BLENDS[layer.blend] || "source-over";
      ctx.drawImage(visual.canvas, visual.x, visual.y);
    });
    return canvas;
  };

  /* --------------------- what ExtendScript answers --------------------- */

  // Sizes are kept in points here, which are pixels only at 72 ppi. As Photoshop's
  // Preferences > Units > Type, the panel is told the unit chosen in the settings.
  const typeUnitAt = (resolution) => (app.textDefaults.typeUnit === "pixels" || resolution === 72 ? "pixelsUnit" : "pointsUnit");

  // Photoshop honours the unit a style was saved with: a size in pixels is that many pixels on
  // every page. What the panel sends is brought to points, the only unit a layer is kept in.
  const pointsPerTypeUnit = (unit, resolution) => (unit === "pixelsUnit" ? 72 / resolution : unit === "millimetersUnit" ? 72 / 25.4 : 1);
  const lengthsInPoints = (textStyle, factor) => {
    if (textStyle && factor !== 1) TEXT_LENGTHS.forEach((field) => {
      if (typeof textStyle[field] === "number") textStyle[field] *= factor;
    });
    return textStyle;
  };
  // A style copied from a layer holds its size twice (size, impliedFontSize), and the panel
  // only ever changes the first: its size field, its Scale field, the size it keeps from the
  // selected layer. The two also differ in a style copied in Photoshop from a text made larger
  // or smaller with Free Transform (the size it had before, the size it showed). The first is
  // the one the panel shows and fits texts with, and the one Photoshop writes: it is the style's
  // size here too, with its leading and baseline shift. Kept apart, the text was drawn at the
  // second and came back to the first as soon as it was typed in.
  const WRITTEN_LENGTHS = [["size", "impliedFontSize"], ["leading", "impliedLeading"], ["baselineShift", "impliedBaselineShift"]];
  const asWritten = (textStyle) => {
    if (textStyle) WRITTEN_LENGTHS.forEach(([written, shown]) => {
      if (typeof textStyle[written] === "number" && textStyle[shown] != null) textStyle[shown] = textStyle[written];
    });
    return textStyle;
  };
  // The size a layer's text shows: the one to keep when its text or its style is replaced
  const shownSize = (textStyle) => textStyle.impliedFontSize || textStyle.size;
  const paramsInPoints = (params, resolution) => {
    const out = clone(params);
    const factor = pointsPerTypeUnit(out.typeUnit, resolution);
    delete out.typeUnit;
    ((out.layerText && out.layerText.textStyleRange) || []).forEach((range) => asWritten(lengthsInPoints(range.textStyle, factor)));
    return out;
  };

  // A layer's lengths (in points) in the unit the panel is told, for one text style
  const lengthsInTypeUnit = (textStyle, resolution) => lengthsInPoints(textStyle, 1 / pointsPerTypeUnit(typeUnitAt(resolution), resolution));
  const sizeInTypeUnit = (points, resolution) => (typeof points === "number" ? points / pointsPerTypeUnit(typeUnitAt(resolution), resolution) : points);

  // Photoshop always names the unit, and the style window can't open without one. It is
  // this model's unit, whatever the style the layer was made from said.
  // The panel reads `size`: it is given the size the text shows, in the unit it is told
  const textProps = (layer, doc) => {
    const props = Object.assign(clone(layer.params), { typeUnit: typeUnitAt(doc.resolution) });
    ((props.layerText && props.layerText.textStyleRange) || []).forEach((range) => {
      if (range.textStyle && range.textStyle.impliedFontSize) range.textStyle.size = range.textStyle.impliedFontSize;
      lengthsInTypeUnit(range.textStyle, doc.resolution);
    });
    // As Photoshop says it, beside the text's shape: a style the panel takes from a layer
    // drops the shape (a box, a point) and keeps this, so a vertical text makes a vertical style
    if (props.layerText) props.layerText.orientation = verticalOf(props.layerText) ? "vertical" : "horizontal";
    return props;
  };

  // As Photoshop's host: a stroke switched off keeps its settings but isn't applied
  const strokeToApply = (stroke) => {
    if (!stroke || stroke.enabled === false || (!(stroke.size > 0) && stroke.enabled !== true)) return null;
    return Object.assign(clone(stroke), { enabled: true, size: stroke.size || 3 });
  };

  const newTextLayer = (doc, params, stroke, name) => ({
    id: newId(),
    kind: "text",
    name: (name || (params.layerText.textKey || "").replace(/[\r\n]+/g, " ")).substring(0, 60),
    visible: true,
    opacity: 1,
    blend: "normal",
    group: null,
    params,
    stroke: strokeToApply(stroke),
  });

  // New text goes right above the active layer, in its folder, or first in the selected
  // folder; on top of the document with nothing selected. With "Always place new text on
  // top", it goes first in the active layer's folder, or on top of the document. The list
  // runs from the bottom of the stack up, with a folder's own entry right above its content.
  const textSpotOf = (doc) => {
    const active = doc.state.layers.find((layer) => layer.id === doc.state.activeIds[doc.state.activeIds.length - 1]);
    if (!active) return {};
    if (active.kind === "group") return { folder: active.id };
    return app.textDefaults.textOnTop ? { folder: active.group || null } : { folder: active.group || null, above: active.id };
  };
  const addNewTexts = (layers, created, spot) => {
    const anchor = spot.above ? layers.findIndex((layer) => layer.id === spot.above) : -1;
    let at = anchor >= 0 ? anchor + 1 : spot.folder ? layers.findIndex((layer) => layer.id === spot.folder) : -1;
    let folder = spot.folder || null;
    // Never under TypeR Clean, whose white would hide it
    const clean = layers.findIndex((layer) => layer.clean);
    if (at >= 0 && clean >= 0 && at <= clean) {
      at = clean + 1;
      folder = layers[clean].group || null;
    }
    if (at < 0) return layers.concat(created);
    created.forEach((layer) => { layer.group = folder; });
    return layers.slice(0, at).concat(created, layers.slice(at));
  };

  const isPunctuationOnly = (text) => typeof text === "string" && /^[!?.,;:'"()\[\]~\-\u00A1\u00AB\u00BB\u00BF\u060C\u061B\u061F\u2013\u2014\u2018\u2019\u201C\u201D\u2026\u203C\u203D\u2047\u2048\u2049\u3001\u3002\u301C\uFF01\uFF1F\uFF5E]+$/.test(text.replace(/[\s\u00A0\u202F]+/g, ""));

  // Style option: a line made only of punctuation ("?!", "!!") is set larger
  const scaleForPunctuation = (style, text) => {
    const scale = style ? parseFloat(style.punctuationOnlyScale) : 0;
    if (!(scale > 1) || !isPunctuationOnly(text)) return style;
    const scaled = clone(style);
    const ranges = (scaled.textProps && scaled.textProps.layerText && scaled.textProps.layerText.textStyleRange) || [];
    ranges.forEach((range) => {
      ["size", "impliedFontSize", "leading", "impliedLeading"].forEach((field) => {
        if (range.textStyle && typeof range.textStyle[field] === "number") range.textStyle[field] *= scale;
      });
    });
    return scaled;
  };

  // The style's text with its own runs, ready to be a layer
  const sameStyle = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
  const rangesFromStyles = (styles, fallback) => {
    const ranges = [];
    styles.forEach((style, at) => {
      const last = ranges[ranges.length - 1];
      if (last && sameStyle(last.textStyle, style)) last.to = at + 1;
      else ranges.push({ from: at, to: at + 1, textStyle: clone(style) });
    });
    return ranges.length ? ranges : [{ from: 0, to: 0, textStyle: clone(fallback) }];
  };
  // A typed change keeps the style of the text around it. What's new takes the style of
  // the letter before it, or of the first one at the very start.
  const rangesAfterEdit = (lt, after) => {
    const before = String(lt.textKey || "");
    const ranges = lt.textStyleRange;
    const styleAt = (index) => (ranges.find((range) => index >= range.from && index < range.to) || ranges[index < 0 ? 0 : ranges.length - 1]).textStyle;
    let start = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start++;
    let end = 0;
    while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
    // The kerning set by hand before a letter stays that letter's: what is typed after it
    // doesn't take it, but the font's kerning of the letters around
    let typed = styleAt(start > 0 ? start - 1 : 0);
    if (typed.kerning) {
      let plain = null;
      for (let at = start - 2; at >= 0 && !plain; at--) if (!styleAt(at).kerning) plain = styleAt(at);
      if (!plain) plain = (ranges.find((range) => !range.textStyle.kerning) || {}).textStyle;
      typed = clone(typed);
      delete typed.kerning;
      if (plain && plain.autoKern) typed.autoKern = plain.autoKern;
      else delete typed.autoKern;
    }
    const styles = [];
    for (let at = 0; at < after.length; at++) {
      if (at < start) styles.push(styleAt(at));
      else if (at >= after.length - end) styles.push(styleAt(before.length - (after.length - at)));
      else styles.push(typed);
    }
    return rangesFromStyles(styles, ranges[0].textStyle);
  };
  // The same styles, on a text that now has a line break for each of its lines
  const rangesOfLines = (lines, fallback) => {
    const styles = [];
    lines.forEach((line, index) => {
      if (index) styles.push(styles[styles.length - 1] || fallback);
      line.runs.forEach((run) => Array.from({ length: run.text.length }).forEach(() => styles.push(run.style)));
    });
    return rangesFromStyles(styles, fallback);
  };

  // resolution: the page's, for a style the panel sends (its sizes are in its own unit).
  // Without it the sizes are a layer's own, in points already. sizeOverride is in points.
  const paramsFromStyle = (style, text, richTextRuns, sizeOverride, resolution) => {
    const source = style && style.textProps ? style.textProps : { layerText: {} };
    const params = resolution ? paramsInPoints(source, resolution) : clone(source);
    const toPoints = resolution ? pointsPerTypeUnit(source.typeUnit, resolution) : 1;
    const lt = params.layerText;
    const base = (lt.textStyleRange && lt.textStyleRange[0] && lt.textStyleRange[0].textStyle) || { fontPostScriptName: "WildjessNormal", fontName: "Wildjess", fontStyleName: "Normal", size: 34, autoLeading: true, color: { red: 0, green: 0, blue: 0 } };
    if (sizeOverride) {
      base.size = sizeOverride;
      if (base.impliedFontSize != null) base.impliedFontSize = sizeOverride;
    }
    const clean = String(text || "").replace(/\r\n?/g, "\r").replace(/\n/g, "\r");
    lt.textKey = clean;
    const ranges = [];
    if (Array.isArray(richTextRuns) && richTextRuns.length) {
      let at = 0;
      richTextRuns.forEach((run) => {
        const length = (run.text || "").length;
        if (!length) return;
        const style = clone(base);
        if (run.textStyle) Object.assign(style, asWritten(lengthsInPoints(clone(run.textStyle), toPoints)));
        if (run.bold) style.syntheticBold = true;
        if (run.italic) style.syntheticItalic = true;
        ranges.push({ from: at, to: at + length, textStyle: style });
        at += length;
      });
    }
    lt.textStyleRange = ranges.length ? ranges : [{ from: 0, to: clean.length, textStyle: base }];
    lt.paragraphStyleRange = [{ from: 0, to: clean.length, paragraphStyle: Object.assign({ alignment: "center", autoLeadingPercentage: 1.2 }, lt.paragraphStyleRange && lt.paragraphStyleRange[0] && lt.paragraphStyleRange[0].paragraphStyle) }];
    // A vertical text stays vertical, and so does the text made from a vertical style (the
    // panel's styles keep a text's orientation without its shape). Any other style follows
    // the Type tool, as a text typed does: the panel's styles all say horizontal, whether
    // it was chosen or not.
    const says = source.layerText || {};
    const vertical = says.textShape ? verticalOf(says) : says.orientation === "vertical" || app.textDefaults.orientation === "vertical";
    lt.textShape = [{ textType: "point", orientation: vertical ? "vertical" : "horizontal" }];
    delete lt.orientation;
    return params;
  };
  // The panel's Text Direction ("rtl" or "ltr"), set on every paragraph as Photoshop's
  // Paragraph panel sets it: in Arabic or Hebrew text, what side a line's dots and other
  // punctuation fall on. None given: the text keeps its own.
  const withDirection = (params, direction) => {
    if (direction !== "rtl" && direction !== "ltr") return params;
    (params.layerText.paragraphStyleRange || []).forEach((range) => {
      range.paragraphStyle = Object.assign(range.paragraphStyle || {}, { directionType: direction === "rtl" ? "dirRightToLeft" : "dirLeftToRight" });
    });
    return params;
  };

  // Text the panel makes follows the settings for new text, as the Type tool's does. Its
  // styles say English, ligatures and hyphenation on because Photoshop and the panel start
  // that way, not because they were chosen for this text: the settings win, but a style that
  // turns ligatures off means it. A text the panel restyles (`layer`) keeps its own language,
  // ligatures and hyphenation instead.
  // The same for the kerning: the panel's styles start on Metrics, so only a style set to
  // Optical means it. Any other takes the kerning chosen last in the Character panel, or
  // leaves a restyled text the one it has.
  const followTextDefaults = (params, layer) => {
    const d = app.textDefaults;
    const lt = params.layerText;
    const own = layer && layer.params.layerText;
    const ownStyle = own && own.textStyleRange[0].textStyle;
    const language = (ownStyle && ownStyle.textLanguage) || d.language;
    const ligature = ownStyle ? ownStyle.ligature !== false : d.ligature !== false;
    const kept = ownStyle ? ownStyle.autoKern : d.autoKern;
    (lt.textStyleRange || []).forEach((range) => {
      if (!range.textStyle) return;
      range.textStyle.textLanguage = language;
      range.textStyle.ligature = ligature && range.textStyle.ligature !== false;
      // A letter kerned by hand keeps its number
      if (!range.textStyle.kerning && range.textStyle.autoKern !== "opticalKern" && range.textStyle.autoKern !== "manual" && (kept === "opticalKern" || kept === "manual")) range.textStyle.autoKern = kept;
    });
    const hyphenate = own ? own.paragraphStyleRange[0].paragraphStyle.hyphenate === true : Boolean(d.hyphenate);
    (lt.paragraphStyleRange || []).forEach((range) => {
      if (!range.paragraphStyle) return;
      if (hyphenate) range.paragraphStyle.hyphenate = true;
      else delete range.paragraphStyle.hyphenate;
    });
    return params;
  };
  // The panel writes the lines of the text it fits in a balloon into it: with Hyphenate on,
  // the patterns of the language must be there first, or its long words would stay whole
  const hyphenationPending = () => {
    const Hyphenation = window.TypeRHyphenation;
    const language = app.textDefaults.hyphenate && Hyphenation && HYPHEN_LANGUAGES[app.textDefaults.language];
    return language && !Hyphenation.isLoaded(language) ? loadHyphenation(language) : null;
  };

  // The fonts of the text the panel pastes, loaded before its lines are measured: a font of
  // the computer is only listed until a text uses it, and lines measured in the stand-in
  // font would break too early
  const fontsPending = (styles, runs) => {
    const names = [];
    styles.forEach((style) => {
      const lt = style && style.textProps && style.textProps.layerText;
      ((lt && lt.textStyleRange) || []).forEach((range) => names.push(range.textStyle && range.textStyle.fontPostScriptName));
    });
    (runs || []).forEach((run) => names.push(run && run.textStyle && run.textStyle.fontPostScriptName));
    const wanted = names.filter(Boolean);
    return wanted.every((name) => (Fonts.get(name) && Fonts.get(name).ready) || Fonts.isMissing(name)) ? null : Fonts.ready(wanted);
  };
  // What a paste waits for, or null: hyphenation patterns and fonts
  const pasteWaits = (styles, runs) => {
    const waits = [hyphenationPending(), fontsPending(styles, runs)].filter(Boolean);
    return waits.length ? Promise.all(waits).catch(() => null) : null;
  };

  // The lines of a text the panel fits in a balloon. With hyphenRules (Hyphenate on), a word
  // that doesn't fit at the end of a line is cut at a syllable, with a hyphen, as in
  // paragraph text, rather than going whole to the next line or leaving a line too wide.
  // `vertical`: for a vertical text, whose lines are as long as their characters are high
  const wrapWords = (text, base, width, resolution, hyphenRules, vertical) => {
    const size = sizePxOf(base, resolution);
    setRunFont(measureCtx, base, size);
    const fits = vertical
      ? (candidate) => measureRuns([{ text: candidate, style: base, vertical: true }], resolution).advance <= width
      : (candidate) => measureCtx.measureText(candidate).width <= width;
    const language = hyphenRules ? hyphenLanguage(base) : null;
    // Where `word`, already cut at `from`, can be cut again so that `line` ends with its
    // start and a hyphen: the latest such place, or -1
    const hyphenCut = (line, word, from, glue) => {
      if (!language) return -1;
      const lead = /^[^\p{L}]*/u.exec(word)[0].length;
      const core = /^[\p{L}'’]+/u.exec(word.slice(lead));
      if (!core || core[0].length < hyphenRules.wordSize) return -1;
      if (!hyphenRules.capitalized && /^\p{Lu}/u.test(core[0])) return -1;
      const points = window.TypeRHyphenation.breakPoints(core[0], language)
        .map((point) => lead + point)
        .filter((cut) => cut - lead >= hyphenRules.pre && lead + core[0].length - cut >= hyphenRules.post && cut - from >= hyphenRules.pre)
        .sort((a, b) => b - a);
      return points.find((cut) => fits((line ? line + glue : "") + word.slice(from, cut) + "-")) || -1;
    };
    const out = [];
    String(text || "").split(/\r\n?|\n/).forEach((paragraph) => {
      let line = "";
      // Each word and what joins it to the one before: a space, or nothing between two words
      // of a text written without spaces (see softBreaksOf)
      const words = [];
      paragraph.split(/\s+/).filter(Boolean).forEach((spaced) => {
        let start = 0;
        Array.from(softBreaksOf(spaced) || []).sort((a, b) => a - b).concat(spaced.length).forEach((end) => {
          words.push([spaced.slice(start, end), start ? "" : " "]);
          start = end;
        });
      });
      words.forEach(([word, glue]) => {
        let from = 0;
        for (;;) {
          const rest = word.slice(from);
          const candidate = line ? line + glue + rest : rest;
          if (fits(candidate)) {
            line = candidate;
            break;
          }
          const cut = hyphenCut(line, word, from, glue);
          if (cut > 0) {
            out.push((line ? line + glue : "") + word.slice(from, cut) + "-");
            line = "";
            from = cut;
            continue;
          }
          // A word too wide alone, with nowhere to cut it, keeps its line
          if (!line) {
            line = rest;
            break;
          }
          out.push(line);
          line = "";
        }
      });
      out.push(line);
    });
    return out;
  };

  // Moves a layer so the middle of its ink lands on (x, y)
  const centreLayer = (doc, params, stroke, x, y) => {
    const box = layoutLayer({ params, stroke }, doc).box;
    params.layerText.textClickPoint.horizontal += ((x - box.xMid) / doc.width) * 100;
    params.layerText.textClickPoint.vertical += ((y - box.yMid) / doc.height) * 100;
  };

  // A text Smart Paste set, made paragraph text as the panel's setting asks: its lines stay
  // as they were fitted to the balloon, in a box a little wider than the longest, so that none
  // wraps again; its ink stays where it was
  const asParagraph = (layer, doc) => {
    const ink = boxOf(layer, doc);
    const rel = relativeLayout(layer.params.layerText, doc.resolution);
    const f = textBoxOf(layer, doc);
    const params = clone(layer.params);
    const lt = params.layerText;
    const lines = rel.lines.length;
    const size = sizePxOf(lt.textStyleRange[0].textStyle, doc.resolution);
    // A vertical text's lines run down its box, from its top right corner
    const vertical = verticalOf(lt);
    lt.textClickPoint = { horizontal: ((vertical ? f.right : f.left) / doc.width) * 100, vertical: (f.top / doc.height) * 100 };
    const widest = rel.lines.reduce((max, line) => Math.max(max, line.m.advance), 0);
    let width = Math.max(vertical ? f.height : f.width, widest) + 2;
    for (let attempt = 0; attempt < 5; attempt++) {
      lt.textShape = [{ textType: "box", orientation: vertical ? "vertical" : "horizontal", box: vertical ? { width: Math.max(1, f.width), height: width, autoHeight: true, verticalAlign: app.textDefaults.verticalAlign } : { width, height: Math.max(1, f.height), autoHeight: true, verticalAlign: app.textDefaults.verticalAlign } }];
      if (relativeLayout(lt, doc.resolution).lines.length <= lines) break;
      width += size * (attempt < 2 ? 0.5 : 1.5);
    }
    return centredOn(Object.assign({}, layer, { params, raster: null }), doc, ink.xMid, ink.yMid);
  };

  // `point`: the panel's setting for pasted text (Point text, or Paragraph text), the style's
  // own when it has one. As in Photoshop, a paragraph is the whole text in a box as wide as
  // the balloon allows, as tall as its lines.
  const classicParams = (doc, data, bounds, point) => {
    const padding = Number(data.padding) || 0;
    const params = withDirection(followTextDefaults(paramsFromStyle(scaleForPunctuation(data.style, data.text), data.text, data.richTextRuns, data.textSizeOverride, doc.resolution)), data.direction);
    const base = params.layerText.textStyleRange[0].textStyle;
    // The enlarged text must not wrap in a box sized for the selection
    const enlarged = !data.textSizeOverride && data.style && isPunctuationOnly(data.text) ? Math.max(1, parseFloat(data.style.punctuationOnlyScale) || 1) : 1;
    // A vertical text's lines run down the balloon: they are as long as it is high allows
    const vertical = verticalOf(params.layerText);
    const width = Math.max(24, (vertical ? bounds.height : bounds.width) * 0.9 - padding * 2) * enlarged;
    if (!point) {
      params.layerText.textShape = [{ textType: "box", orientation: vertical ? "vertical" : "horizontal", box: vertical ? { width: 1, height: width, autoHeight: true, verticalAlign: app.textDefaults.verticalAlign } : { width, height: 1, autoHeight: true, verticalAlign: app.textDefaults.verticalAlign } }];
      params.layerText.textClickPoint = vertical
        ? { horizontal: (bounds.xMid / doc.width) * 100, vertical: ((bounds.yMid - width / 2) / doc.height) * 100 }
        : { horizontal: ((bounds.xMid - width / 2) / doc.width) * 100, vertical: (bounds.top / doc.height) * 100 };
      centreLayer(doc, params, null, bounds.xMid, bounds.yMid);
      return params;
    }
    // Text with styled parts keeps its own lines (see below): it isn't cut either
    const hyphenRules = data.richTextRuns ? null : hyphenRulesOf(params.layerText.paragraphStyleRange[0].paragraphStyle);
    const lines = wrapWords(data.text, base, width, doc.resolution, hyphenRules, vertical);
    if (!data.richTextRuns) {
      params.layerText.textKey = lines.join("\r");
      params.layerText.textStyleRange = [{ from: 0, to: params.layerText.textKey.length, textStyle: base }];
    }
    params.layerText.textClickPoint = { horizontal: (bounds.xMid / doc.width) * 100, vertical: (bounds.top / doc.height) * 100 };
    centreLayer(doc, params, null, bounds.xMid, bounds.yMid);
    return params;
  };

  const shapeRows = (selection, samples) => {
    const b = selection.bounds;
    const rows = [];
    for (let i = 0; i < samples; i++) {
      const y = samples <= 1 ? 0.5 : i / (samples - 1);
      if (!selection.mask) {
        rows.push({ y, left: 0, right: 1, width: 1 });
        continue;
      }
      const m = selection.mask;
      const row = Math.min(m.height - 1, Math.max(0, Math.round(y * (m.height - 1))));
      let first = -1;
      let last = -1;
      for (let x = 0; x < m.width; x++) {
        if (m.data[row * m.width + x]) {
          if (first === -1) first = x;
          last = x;
        }
      }
      if (first === -1) rows.push({ y, left: 0.5, right: 0.5, width: 0 });
      else rows.push({ y, left: first / m.width, right: (last + 1) / m.width, width: (last + 1 - first) / m.width });
    }
    return { scan: "web", bounds: b, rows, fallback: false };
  };

  // Smart Paste turns the text white on a black bubble: the panel's rule, a bubble whose pixels
  // are nearly all 15 or less. A dark grey or a dark colour gets white text here too, only where
  // it is needed and safe:
  // - the style has no stroke: a stroked text carries its own contrast, and keeps its look;
  // - the text is dark itself, and reads badly there (a contrast under 4.5 to 1): a light
  //   colour was chosen for a dark bubble, and stays;
  // - the bubble is dark all over. Its inside is looked at in small cells, each one averaged so
  //   that a screentone gives its grey, and nine in ten must be dark (a relative luminance
  //   under 0.179, where white reads better than black). A gradient, artwork with light parts
  //   or old lettering left in white keep the style's colour. Only what is inside the bubble
  //   counts: not the page around a cell that its outline crosses.
  // The pixels are those the bubble was found in, the page's before the paste, without its texts.
  const DARK_LUMINANCE = 0.179;
  const READABLE_CONTRAST = 4.5;
  const linearOf = (c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const luminanceOf = (r, g, b) => 0.2126 * linearOf(r) + 0.7152 * linearOf(g) + 0.0722 * linearOf(b);
  // The bubble's luminance when it is dark all over, null otherwise
  const darkBubbleLuminance = (doc, plan) => {
    if (!plan) return null;
    const raw = Array.isArray(plan.cleanPolygon) && plan.cleanPolygon.length >= 3 ? plan.cleanPolygon : null;
    const polygon = raw ? raw.map((point) => (Array.isArray(point) ? point : [point.x, point.y])) : null;
    const b = polygon
      ? { left: Math.min(...polygon.map((p) => p[0])), top: Math.min(...polygon.map((p) => p[1])), right: Math.max(...polygon.map((p) => p[0])), bottom: Math.max(...polygon.map((p) => p[1])) }
      : plan.selectionBounds;
    if (!b || !(b.right > b.left) || !(b.bottom > b.top)) return null;
    const data = sampleData(doc);
    const CELLS = 12;
    const INSIDE = 4;
    const cw = (b.right - b.left) / CELLS;
    const ch = (b.bottom - b.top) / CELLS;
    const cells = [];
    for (let iy = 0; iy < CELLS; iy++) {
      for (let ix = 0; ix < CELLS; ix++) {
        const left = b.left + cw * ix;
        const top = b.top + ch * iy;
        let sum = 0;
        let count = 0;
        for (let sy = 0; sy < INSIDE; sy++) {
          for (let sx = 0; sx < INSIDE; sx++) {
            const x = left + (cw * (sx + 0.5)) / INSIDE;
            const y = top + (ch * (sy + 0.5)) / INSIDE;
            if (polygon && !insidePolygon(polygon, x, y, 0)) continue;
            const px = Math.floor(x);
            const py = Math.floor(y);
            if (px < 0 || py < 0 || px >= doc.width || py >= doc.height) continue;
            const i = (py * doc.width + px) * 4;
            sum += luminanceOf(data[i], data[i + 1], data[i + 2]);
            count++;
          }
        }
        // A cell mostly outside the bubble says little about it
        if (count >= (INSIDE * INSIDE) / 2) cells.push(sum / count);
      }
    }
    if (cells.length < 8) return null;
    cells.sort((x, y) => x - y);
    if (cells[Math.floor(cells.length * 0.9)] >= DARK_LUMINANCE) return null;
    return cells[Math.floor(cells.length / 2)];
  };
  // The dark runs of a text pasted in a dark bubble, which would read badly there, turned white
  const whiteOnDarkBubble = (doc, plan, params, stroke) => {
    if (strokeToApply(stroke)) return;
    const ranges = (params.layerText.textStyleRange || []).filter((range) => range.textStyle);
    if (!ranges.length) return;
    const bubble = darkBubbleLuminance(doc, plan);
    if (bubble === null) return;
    ranges.forEach((range) => {
      const color = range.textStyle.color || { red: 0, green: 0, blue: 0 };
      const text = luminanceOf(color.red || 0, color.green || 0, color.blue || 0);
      const contrast = (Math.max(text, bubble) + 0.05) / (Math.min(text, bubble) + 0.05);
      if (text < DARK_LUMINANCE && contrast < READABLE_CONTRAST) range.textStyle.color = { red: 255, green: 255, blue: 255 };
    });
  };

  const layerSignature = (doc, layer) => (layer ? layer.id + ":" + doc.historyIndex : "");

  const activeLayerSnapshot = (doc, layer) => ({
    layerId: layer.id,
    bounds: boxOf(layer, doc),
    textType: "point",
    textProps: textProps(layer, doc),
    stroke: layer.stroke || { enabled: false, size: 0, opacity: 100, position: "outer", color: { r: 255, g: 255, b: 255 } },
  });

  const host = {
    nativeAlert(data) {
      emit("alert", data);
      return "";
    },
    nativeConfirm(data) {
      return new Promise((resolve) => emit("confirm", Object.assign({}, data, { answer: (ok) => resolve(ok ? "1" : "0") })));
    },
    getUserFonts() {
      return JSON.stringify({ fonts: Fonts.list().map(({ name, postScriptName, family, style }) => ({ name, postScriptName, family, style })) });
    },
    reloadUserFonts() {
      return host.getUserFonts();
    },
    getHotkeyPressed() {
      // The panel only asks every 75 ms: a key tapped in between still counts
      const k = app.keysSeen;
      app.keysSeen = Object.assign({}, app.keys);
      if (app.keysMuted && app.keysMuted()) return "a";
      let out = "a";
      if (k.meta) out += "WINa";
      if (k.ctrl) out += "CTRLa";
      if (k.alt) out += "ALTa";
      if (k.shift) out += "SHIFTa";
      if (k.key) out += k.key + "a";
      return out;
    },
    getActiveLayerText() {
      const doc = app.doc;
      const layer = activeTextLayer(doc);
      return layer ? JSON.stringify(activeLayerSnapshot(doc, layer)) : "";
    },
    getSelectedTextLayers() {
      if (!app.doc) return JSON.stringify({ error: "doc" });
      return JSON.stringify({ layers: selectedTextLayers().map((layer) => ({ id: layer.id })) });
    },
    getCurrentSelection() {
      const doc = app.doc;
      if (!doc) return JSON.stringify({ error: "doc" });
      const selection = doc.state.selection;
      if (!selection) return JSON.stringify({ error: "noSelection" });
      if (selection.bounds.width * selection.bounds.height < 200) return JSON.stringify({ error: "smallSelection" });
      return JSON.stringify(selection.bounds);
    },
    getTypeRSelectionSnapshot() {
      const doc = app.doc;
      const selection = doc && doc.state.selection;
      return JSON.stringify({ selection: selection ? selection.bounds : null, layers: selectedTextLayers().map((layer) => ({ id: layer.id })) });
    },
    getActiveLayerTextIfChanged(data) {
      const doc = app.doc;
      const layer = activeTextLayer(doc);
      if (!layer) return JSON.stringify({ error: "layer", signature: "" });
      const signature = layerSignature(doc, layer);
      if (data && data.signature === signature) return JSON.stringify({ unchanged: true, signature });
      return JSON.stringify(Object.assign(activeLayerSnapshot(doc, layer), { signature }));
    },
    getActiveTextLayerGeometry() {
      const doc = app.doc;
      const layer = activeTextLayer(doc);
      if (!layer) return JSON.stringify({ error: "layer", signature: "" });
      return JSON.stringify({ layerId: layer.id, bounds: boxOf(layer, doc), signature: layerSignature(doc, layer) });
    },
    getTypeRPanelSnapshot(data) {
      const selection = JSON.parse(host.getTypeRSelectionSnapshot());
      return JSON.stringify({ activeLayer: JSON.parse(host.getActiveLayerTextIfChanged(data || {})), selection: selection.selection, layers: selection.layers });
    },
    startSelectionMonitoring() { return ""; },
    stopSelectionMonitoring() {
      app.monitor.lastBounds = null;
      return "";
    },
    deselectDocumentSelection() {
      if (!app.doc) return "doc";
      ops.deselect();
      app.monitor.lastBounds = null;
      return "";
    },
    getSelectionChanged() {
      const doc = app.doc;
      const key = doc ? "web:" + doc.id : "";
      if (app.monitor.documentKey !== key) {
        app.monitor.documentKey = key;
        app.monitor.lastBounds = null;
        return JSON.stringify({ documentChanged: true, documentKey: key });
      }
      const selection = doc && doc.state.selection;
      if (!selection) return JSON.stringify({ noChange: true, shiftKey: app.keys.shift, documentKey: key });
      const b = selection.bounds;
      const last = app.monitor.lastBounds;
      if (last && ["left", "top", "right", "bottom"].every((side) => Math.abs(last[side] - b[side]) <= 5)) {
        return JSON.stringify({ noChange: true, shiftKey: app.keys.shift, documentKey: key });
      }
      app.monitor.lastBounds = b;
      const item = Object.assign({ shiftKey: app.keys.shift, documentKey: key }, b);
      return JSON.stringify(Object.assign({ multiSelection: [item] }, item));
    },
    // TextShapeR's star: the text as it shows, a paragraph's lines as its box sets them
    async getRenderedTextLines() {
      const doc = app.doc;
      const layer = activeTextLayer(doc);
      if (!layer) return JSON.stringify({ error: "layer" });
      await linesReady([layer]);
      return JSON.stringify({ text: shownLines(layer.params.layerText, doc.resolution) });
    },
    // Ctrl or Alt + the star: every text layer that shows, its folders included
    async getAllRenderedTextLines() {
      const doc = app.doc;
      if (!doc) return JSON.stringify({ error: "document" });
      const byId = new Map(doc.state.layers.map((layer) => [layer.id, layer]));
      const layers = doc.state.layers.filter((layer) => layer.kind === "text" && chainOf(layer, byId).visible);
      await linesReady(layers);
      const entries = [];
      layers.forEach((layer) => {
        try {
          entries.push({ layerId: layer.id, text: shownLines(layer.params.layerText, doc.resolution) });
        } catch (readError) {
          // A text that can't be laid out teaches nothing
        }
      });
      return JSON.stringify({ entries });
    },
    // TextShapeR learns from the line breaks of finished pages: each text layer as it shows,
    // a paragraph's lines as its box sets them (Photoshop turns it into point text for this).
    // No path means the current page; an open file is read as it is now, unsaved work included.
    async scanTextShapeRTraining(path) {
      const raw = String(path || "");
      try {
        let resolution;
        let layers;
        const fromDoc = (doc) => {
          const byId = new Map(doc.state.layers.map((layer) => [layer.id, layer]));
          const pathOf = (layer) => {
            const names = [layer.name || ""];
            for (let id = layer.group; id && byId.get(id); id = byId.get(id).group) names.unshift(byId.get(id).name || "");
            return names.join(" / ");
          };
          resolution = doc.resolution;
          layers = doc.state.layers.filter((layer) => layer.kind === "text").map((layer) => ({
            layerId: layer.id, name: layer.name || "", path: pathOf(layer), visible: chainOf(layer, byId).visible, params: layer.params,
          }));
        };
        if (!raw) {
          if (!app.doc) return JSON.stringify({ error: "document" });
          fromDoc(app.doc);
        } else {
          if (!/\.ps[db]$/i.test(raw)) return JSON.stringify({ error: "badPath" });
          const file = app.files.get(raw);
          if (!file) return JSON.stringify({ error: "notFound" });
          const open = app.docs.find((doc) => doc.path === raw && doc.stamp === fileStamp(file));
          if (open) fromDoc(open);
          else ({ resolution, layers } = await window.TypeRPSD.readText(await file.arrayBuffer()));
        }
        await linesReady(layers);
        const entries = layers.map((layer, index) => {
          const entry = { layerId: layer.layerId || index + 1, name: layer.name, layerPath: layer.path, visible: layer.visible !== false, text: "" };
          try {
            entry.text = shownLines(layer.params.layerText, resolution);
          } catch (readError) {
            entry.error = "readFailed";
          }
          return entry;
        });
        return JSON.stringify({ entries });
      } catch (scanError) {
        return JSON.stringify({ error: "scanFailed" });
      }
    },
    getCurrentSelectionShape(data) {
      const doc = app.doc;
      if (!doc) return JSON.stringify({ error: "doc" });
      const selection = doc.state.selection;
      if (!selection) return JSON.stringify({ error: "noSelection" });
      return JSON.stringify(shapeRows(selection, Math.max(5, parseInt(data && data.samples, 10) || 17)));
    },
    getActiveLayerBubbleShape(data) {
      const doc = app.doc;
      if (!doc) return JSON.stringify({ error: "doc" });
      const layer = activeTextLayer(doc);
      if (!layer) return JSON.stringify({ error: "layer" });
      if (doc.state.selection) return JSON.stringify({ error: "hasSelection" });
      const box = boxOf(layer, doc);
      const scan = floodSelect(doc, box.xMid, box.yMid, parseInt(data && data.tolerance, 10) || 20);
      if (scan.bounds.width * scan.bounds.height < 200 || scan.bounds.width * scan.bounds.height > box.width * box.height * 60) return JSON.stringify({ error: "noBubble" });
      return JSON.stringify(shapeRows(scan, Math.max(5, parseInt(data && data.samples, 10) || 21)));
    },
    selectLayerById(id) {
      ops.selectLayer(parseInt(id, 10));
      return "";
    },
    setActiveLayerText(data) {
      const doc = app.doc;
      if (!doc || !activeTextLayer(doc)) return "layer";
      // As in Photoshop, every text layer selected takes the change, not only the active one,
      // all in one history step
      const changed = new Map();
      selectedTextLayers(doc).forEach((layer) => {
        const box = boxOf(layer, doc);
        // A style-only apply has no text of its own: each layer keeps its text
        const text = data.text || layer.params.layerText.textKey;
        const style = data.style ? scaleForPunctuation(data.style, text) : { textProps: layer.params };
        const kept = data.preserveActiveTextSize ? shownSize(layer.params.layerText.textStyleRange[0].textStyle) : null;
        const params = paramsFromStyle(style, text, data.richTextRuns, kept, data.style ? doc.resolution : 0);
        if (data.style) followTextDefaults(params, layer);
        // Only its text pasted, a text turns right to left but isn't turned back, as in Photoshop
        withDirection(params, data.style || data.direction === "rtl" ? data.direction : null);
        params.layerText.textClickPoint = clone(layer.params.layerText.textClickPoint);
        // A text keeps the way it is set, across or down, whatever the style
        params.layerText.textShape[0].orientation = verticalOf(layer.params.layerText) ? "vertical" : "horizontal";
        if (boxShape(layer.params.layerText)) params.layerText.textShape = clone(layer.params.layerText.textShape);
        else centreLayer(doc, params, null, box.xMid, box.yMid);
        const changes = { params, raster: null, stroke: (data.style && strokeToApply(data.style.stroke)) || layer.stroke };
        if (data.text) Object.assign(changes, { source: String(data.text), name: String(data.text).replace(/[\r\n]+/g, " ").substring(0, 60) });
        // A style of another size on a paragraph text: its box follows, as for a size typed
        changed.set(layer.id, boxShape(layer.params.layerText) && !data.text ? boxFollowsSize(layer, Object.assign({}, layer, changes), doc) : changes);
      });
      const layers = doc.state.layers.map((item) => (changed.has(item.id) ? Object.assign({}, item, changed.get(item.id)) : item));
      commitState(doc, "TyperTools Change", { layers });
      return "";
    },
    setTextShapeRLayerText(data) {
      const doc = app.doc;
      const layer = activeTextLayer(doc);
      if (!doc || !layer) return "layer";
      const box = boxOf(layer, doc);
      const base = layer.params.layerText.textStyleRange[0].textStyle;
      const params = withDirection(paramsFromStyle({ textProps: layer.params }, data.text, data.richTextRuns, shownSize(base)), data.direction);
      params.layerText.textClickPoint = clone(layer.params.layerText.textClickPoint);
      const kept = boxShape(layer.params.layerText);
      if (!kept || layer.rotated || layer.warp) {
        centreLayer(doc, params, null, box.xMid, box.yMid);
        commitState(doc, "TyperTools Change", { layers: replaceLayer(doc, layer, { params, raster: null }) });
        return "";
      }
      // A text box keeps its frame: the new lines are laid in it, and it only grows, around
      // its middle, when a line is wider than it or the lines need more height
      const lt = params.layerText;
      const shape = clone(kept);
      const before = textBoxOf(layer, doc);
      lt.textShape = [shape];
      const [along, across] = boxSides(lt);
      let widest = 0;
      relativeLayout(Object.assign({}, lt, { textShape: [{ textType: "point", orientation: shape.orientation }] }), doc.resolution).lines.forEach((line) => { widest = Math.max(widest, line.m.advance); });
      if (widest + 1 > shape.box[along]) growBox(lt, shape, along, widest + 1 - shape.box[along], doc);
      if (!shape.box.autoHeight) {
        const full = relativeLayout(Object.assign({}, lt, { textShape: [{ textType: "box", orientation: shape.orientation, box: across === "height" ? { width: shape.box.width, height: 1, autoHeight: true } : { width: 1, height: shape.box.height, autoHeight: true } }] }), doc.resolution);
        if (full.contentHeight > shape.box[across]) growBox(lt, shape, across, full.contentHeight - shape.box[across], doc);
      }
      let next = Object.assign({}, layer, { params, raster: null, manualBreaks: true });
      // A box that follows its text's height keeps its middle where it was (a vertical
      // text's box follows its lines to the left)
      if (shape.box.autoHeight) {
        const after = textBoxOf(next, doc);
        next = across === "height" ? shifted(next, 0, before.yMid - after.yMid, doc) : shifted(next, before.xMid - after.xMid, 0, doc);
      }
      commitState(doc, "TyperTools Change", { layers: replaceLayer(doc, layer, next) });
      return "";
    },
    setSelectedTextLayers(data) {
      const doc = app.doc;
      if (!doc) return "doc";
      const items = (data && data.items) || [];
      if (items.length < 2) return "layer";
      let layers = doc.state.layers;
      items.forEach((item) => {
        const layer = layers.find((entry) => String(entry.id) === String(item.layerId));
        if (!layer) return;
        const box = boxOf(layer, doc);
        const text = item.text || layer.params.layerText.textKey;
        // As on one layer: the style's stroke, each layer's own size if asked, and its box
        const kept = item.preserveActiveTextSize ? shownSize(layer.params.layerText.textStyleRange[0].textStyle) : null;
        const params = paramsFromStyle(item.style ? scaleForPunctuation(item.style, text) : { textProps: layer.params }, text, item.richTextRuns, kept, item.style ? doc.resolution : 0);
        if (item.style) followTextDefaults(params, layer);
        withDirection(params, item.direction);
        params.layerText.textClickPoint = clone(layer.params.layerText.textClickPoint);
        // A text keeps the way it is set, across or down, whatever the style
        params.layerText.textShape[0].orientation = verticalOf(layer.params.layerText) ? "vertical" : "horizontal";
        if (boxShape(layer.params.layerText)) params.layerText.textShape = clone(layer.params.layerText.textShape);
        else centreLayer(doc, params, null, box.xMid, box.yMid);
        const stroke = (item.style && strokeToApply(item.style.stroke)) || layer.stroke;
        let next = Object.assign({}, layer, { params, raster: null, stroke });
        if (boxShape(layer.params.layerText) && !item.text) next = boxFollowsSize(layer, next, doc);
        layers = layers.map((entry) => (entry.id === layer.id ? next : entry));
      });
      commitState(doc, "TyperTools Change", { layers });
      return "";
    },
    createTextLayerInSelection(data, point, loaded) {
      const pending = !loaded && pasteWaits([data && data.style], data && data.richTextRuns);
      if (pending) return pending.then(() => host.createTextLayerInSelection(data, point, true));
      const doc = app.doc;
      if (!doc) return "doc";
      const selection = doc.state.selection;
      if (!selection) return "noSelection";
      if (selection.bounds.width * selection.bounds.height < 200) return "smallSelection";
      let size = null;
      if (data.preserveActiveTextSize) {
        const layer = activeTextLayer(doc);
        if (!layer) return "sizeSource";
        size = shownSize(layer.params.layerText.textStyleRange[0].textStyle);
      }
      const params = classicParams(doc, Object.assign({}, data, { textSizeOverride: size }), selection.bounds, point !== false);
      const layer = newTextLayer(doc, params, data.style && data.style.stroke, data.text);
      layer.source = String(data.text || "");
      commitState(doc, "TyperTools Paste", { layers: addNewTexts(doc.state.layers, [layer], textSpotOf(doc)), activeIds: [layer.id] });
      emit("paste", { classic: true, layers: [layer] });
      return "";
    },
    createTextLayersInStoredSelections(data, point, loaded) {
      const pending = !loaded && pasteWaits((data && data.styles) || [], ((data && data.richTextRuns) || []).flat());
      if (pending) return pending.then(() => host.createTextLayersInStoredSelections(data, point, true));
      const doc = app.doc;
      if (!doc) return "doc";
      // As one paste: the size of the active text if asked, each text's bold and italic parts
      let size = null;
      if (data && data.preserveActiveTextSize) {
        const layer = activeTextLayer(doc);
        if (!layer) return "sizeSource";
        size = shownSize(layer.params.layerText.textStyleRange[0].textStyle);
      }
      const created = [];
      const texts = (data && data.texts) || [];
      const selections = (data && data.selections) || [];
      const styles = (data && data.styles) || [];
      const runs = (data && data.richTextRuns) || [];
      const modes = (data && data.pointModes) || [];
      selections.forEach((bounds, i) => {
        if (texts[i] == null) return;
        const style = styles[i] || styles[0];
        const params = classicParams(doc, { text: texts[i], style, richTextRuns: runs[i] || null, textSizeOverride: size, padding: data.padding, direction: data.direction },rectFrom(bounds.left, bounds.top, bounds.right, bounds.bottom), modes[i] === undefined ? point !== false : Boolean(modes[i]));
        const layer = newTextLayer(doc, params, style && style.stroke, texts[i]);
        layer.source = String(texts[i]);
        created.push(layer);
      });
      commitState(doc, "TyperTools Paste", { layers: addNewTexts(doc.state.layers, created, textSpotOf(doc)), activeIds: created.map((layer) => layer.id), selection: selectionAfterPaste(doc) });
      emit("paste", { classic: true, layers: created });
      return "";
    },
    alignCapture() {
      const doc = app.doc;
      if (!doc) return JSON.stringify({ error: "doc" });
      const selected = selectedTextLayers(doc);
      const texts = selected.map((layer) => ({
        id: layer.id,
        index: doc.state.layers.indexOf(layer),
        box: boxOf(layer, doc),
        sizePixels: sizePxOf(layer.params.layerText.textStyleRange[0].textStyle, doc.resolution),
      }));
      const bubbles = [];
      if (doc.state.selection) {
        const s = doc.state.selection;
        bubbles.push({ selectionBounds: { left: s.bounds.left, top: s.bounds.top, right: s.bounds.right, bottom: s.bounds.bottom }, rawPath: ringsToPath(s.rings), textIds: texts.map((text) => text.id) });
      } else {
        // As TypeR's Legacy host (_alignCaptureRun): the wand probes around each text, its
        // centre first, and the bubble they find (probed: the panel then only places the texts that
        // lie inside it)
        texts.forEach((text) => {
          const found = probeBubble(doc, text.box, text.sizePixels, []).best;
          if (!found) return;
          const b = found.bounds;
          let known = bubbles.find((bubble) => bubble.selectionBounds.left === b.left && bubble.selectionBounds.top === b.top && bubble.selectionBounds.right === b.right && bubble.selectionBounds.bottom === b.bottom);
          if (!known) {
            known = { selectionBounds: { left: b.left, top: b.top, right: b.right, bottom: b.bottom }, rawPath: ringsToPath(regionSelection(found).rings), textIds: [], probed: true };
            bubbles.push(known);
          }
          known.textIds.push(text.id);
        });
      }
      return JSON.stringify({ documentId: doc.id, width: doc.width, height: doc.height, resolution: doc.resolution, texts, bubbles });
    },
    alignTextLayerToSelection(data) {
      const doc = app.doc;
      if (!doc) return "doc";
      const selected = selectedTextLayers(doc);
      if (!selected.length) return "layer";
      // The chamber of a double or triple bubble the panel found for a text. Its centre (the
      // chamber's body centre) is kept when it lies in its box, as in TypeR's Legacy host
      // (_alignPlacementMap); otherwise the box's middle
      const placements = {};
      ((data && data.placements) || []).forEach((placement) => {
        const r = placement && placement.rect;
        if (!r || placement.id === undefined || placement.id === null) return;
        const [left, top, right, bottom] = [r.left, r.top, r.right, r.bottom].map(Number);
        if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) return;
        const rect = rectFrom(left, top, right, bottom);
        const x = Number(r.xMid);
        const y = Number(r.yMid);
        if (Number.isFinite(x) && Number.isFinite(y) && x >= left && x <= right && y >= top && y <= bottom) Object.assign(rect, { xMid: x, yMid: y });
        placements[placement.id] = rect;
      });
      let layers = doc.state.layers;
      let failure = "";
      let aligned = 0;
      selected.forEach((layer) => {
        const box = boxOf(layer, doc);
        let rect = placements[layer.id];
        if (!rect) {
          // A single bubble, as in TypeR's Legacy host (_alignCurrentTextLayerToSelection): the
          // user's selection with the text's box filled in, else the bubble the wand takes at the
          // text's middle (tolerance 20, the texts left out), opened: a tail does not pull the
          // text off the bubble's middle. No size limit, as there.
          let selection = doc.state.selection;
          const holes = selection ? [box] : null;
          if (!selection) {
            const region = bubbleAt(doc, box.xMid, box.yMid);
            selection = region ? regionSelection(region) : null;
          }
          if (!selection) {
            failure = failure || "noSelection";
            return;
          }
          rect = openedSelectionBounds(selection, holes);
          if (rect.width * rect.height < MIN_BUBBLE_AREA) {
            failure = failure || "smallSelection";
            return;
          }
        }
        const moved = centredOn(layer, doc, rect.xMid, rect.yMid);
        layers = layers.map((entry) => (entry.id === layer.id ? moved : entry));
        aligned++;
      });
      if (!aligned) return failure || "layer";
      commitState(doc, "TyperTools Align", { layers });
      emit("align");
      return "";
    },
    alignTextLayersToDoubleBubble() {
      const doc = app.doc;
      if (!doc) return "doc";
      const selected = selectedTextLayers(doc);
      if (selected.length < 2 || selected.length !== doc.state.activeIds.length) return "doubleBubbleLayers";
      const rects = doubleBubbleRects(doc, selected);
      if (typeof rects === "string") return rects;
      const moved = new Map(selected.map((layer, i) => [layer.id, centredOn(layer, doc, rects[i].xMid, rects[i].yMid)]));
      commitState(doc, "TyperTools Align", { layers: doc.state.layers.map((layer) => moved.get(layer.id) || layer) });
      emit("align");
      return "";
    },
    changeActiveLayerTextSize(value) {
      const doc = app.doc;
      if (!doc) return "doc";
      const selected = selectedTextLayers(doc);
      if (!selected.length) return "layer";
      let layers = doc.state.layers;
      selected.forEach((layer) => {
        const box = boxOf(layer, doc);
        // The step applies to the displayed size; the other runs, a fixed leading and
        // a box frame follow by the same ratio
        const first = layer.params.layerText.textStyleRange[0].textStyle;
        const shown = first.impliedFontSize || first.size;
        // The step is in the panel's unit; the sizes here are in points
        const step = Number(value) * pointsPerTypeUnit(typeUnitAt(doc.resolution), doc.resolution);
        const ratio = Math.max(pointsPerTypeUnit(typeUnitAt(doc.resolution), doc.resolution), shown + step) / shown;
        const params = scaledTextParams(layer.params, ratio);
        centreLayer(doc, params, null, box.xMid, box.yMid);
        layers = layers.map((entry) => (entry.id === layer.id ? Object.assign({}, entry, { params, raster: null }) : entry));
      });
      commitState(doc, "TyperTools Resize", { layers });
      return "";
    },
    toggleCleaningLayers() {
      const doc = app.doc;
      if (!doc) return "";
      const hasClean = doc.state.layers.some((layer) => layer.clean);
      if (hasClean) commitState(doc, "Toggle Clean", { layers: doc.state.layers.map((layer) => (layer.clean ? Object.assign({}, layer, { visible: layer.visible === false }) : layer)) });
      return "";
    },
    undoLastTyperChange() {
      const doc = app.doc;
      if (!doc) return "doc";
      for (let i = doc.historyIndex; i > 0; i--) {
        if (doc.history[i].name === "TyperTools Change") {
          ops.jump(i - 1);
          return "";
        }
      }
      return "none";
    },
    openFile(path) {
      const raw = String(path);
      const known = app.docs.find((doc) => doc.path === raw);
      const done = (doc) => JSON.stringify({ ok: true, path: raw, documentKey: "web:" + doc.id });
      if (known) {
        setDoc(known);
        return done(known);
      }
      const name = raw.split(/[\\/]/).pop();
      const file = app.files.get(raw);
      const fail = (error) => JSON.stringify({ ok: false, path: raw, error: String((error && error.message) || error) });
      if (file) return ops.openBlob(file, name, raw).then(done, fail);
      if (raw.indexOf("/typer/app/assets/") === 0) {
        return ops.loadImage((window.TypeRPhotoshop.panelBase || "panel/") + "assets/" + raw.split("/").pop(), name, raw).then(done, fail);
      }
      // At startup, the page may be among the documents still coming back from last time
      const restoring = window.TypeRSession && window.TypeRSession.restoring();
      if (restoring) return restoring.catch(() => null).then(() => host.openFile(raw));
      // So may be the chapter's pages, read again from their files (restoreChapter in app.js)
      const pages = window.TypeRApp && window.TypeRApp.pagesComing && window.TypeRApp.pagesComing();
      if (pages) return pages.then(() => host.openFile(raw));
      // The tutorial's practice pages aren't kept after a reload: they are drawn again
      const practice = window.TypeRGuide && window.TypeRGuide.practiceFile && window.TypeRGuide.practiceFile(raw);
      if (practice) return practice.then((drawn) => ops.openBlob(drawn, name)).then(done, fail);
      // The page of a chapter that is no longer open: the app says so in its own words
      emit("page-lost", { path: raw });
      return fail("Open this file first: it is not in the browser yet.");
    },
    // A document already open is read as it is now, unsaved work included, as in Photoshop
    async scanPsdFonts(path) {
      const file = app.files.get(path);
      if (!file) return JSON.stringify({ error: "notFound", file: path });
      const open = app.docs.find((doc) => doc.path === path && doc.stamp === fileStamp(file));
      try {
        const { resolution, layers } = open
          ? { resolution: open.resolution, layers: open.state.layers.filter((layer) => layer.kind === "text") }
          : await window.TypeRPSD.readText(await file.arrayBuffer());
        // By the time the panel shows them, each font is known to be here or missing
        await Fonts.ready(layers.flatMap(({ params }) => params.layerText.textStyleRange.map((range) => range.textStyle.fontPostScriptName)));
        return JSON.stringify({
          file: path,
          layers: layers.map(({ name, params, stroke }) => ({
            layerName: name,
            antiAlias: params.layerText.antiAlias || "antiAliasSmooth",
            typeUnit: typeUnitAt(resolution),
            paragraphStyle: params.layerText.paragraphStyleRange[0].paragraphStyle,
            stroke: stroke || null,
            runs: params.layerText.textStyleRange.map((range) => lengthsInTypeUnit(clone(range.textStyle), resolution)),
          })),
        });
      } catch (error) {
        return JSON.stringify({ error: "scanFailed", file: path, message: String((error && error.message) || error) });
      }
    },
    ensureWandSampleAll() {
      if (app.tool !== "wand" || app.sampleAll) return JSON.stringify({ wasOff: false });
      app.sampleAll = true;
      emit("options");
      return JSON.stringify({ wasOff: true });
    },
    smartPasteSelectionProbe() {
      const doc = app.doc;
      if (!doc) return JSON.stringify({ error: "doc" });
      const toolId = { wand: "magicWandTool", quickSelect: "quickSelectTool", rectangle: "marqueeRectTool", ellipse: "marqueeEllipTool", lasso: "lassoTool", polygon: "polySelTool", move: "moveTool", brush: "paintbrushTool", eraser: "eraserTool", magicEraser: "magicEraserTool", text: "typeCreateOrEditTool" }[app.tool] || "";
      const selection = doc.state.selection;
      const b = selection && selection.bounds;
      return JSON.stringify({ documentId: doc.id, tool: toolId, bounds: b ? { left: b.left, top: b.top, right: b.right, bottom: b.bottom } : null });
    },
    smartPasteCapture(data) {
      const doc = app.doc;
      if (!doc) return JSON.stringify({ error: "doc" });
      const selection = doc.state.selection;
      if (!selection || selection.bounds.width < 8 || selection.bounds.height < 8) return JSON.stringify({ error: "noSelection" });
      const b = selection.bounds;
      const result = {
        documentId: doc.id,
        width: doc.width,
        height: doc.height,
        resolution: doc.resolution,
        selectionBounds: { left: b.left, top: b.top, right: b.right, bottom: b.bottom },
        histograms: [],
        rawPath: null,
        activeTextSize: null,
      };
      // A click whose selection leaks into the page, as in TypeR's Legacy host: the panel is
      // told so, and asks again with the polygon of a disc around the click (data.local) for
      // the outline of the selection inside it. The text then goes around the click.
      const trigger = data && data.trigger;
      const clicked = !!trigger && ((trigger.source === "wand" && typeof trigger.x === "number") ||
        (trigger.source === "manual" && trigger.lastSource === "wand" && !!trigger.lastClick));
      const local = data && Array.isArray(data.local) && data.local.length >= 3 ? data.local : null;
      const sw = b.right - b.left;
      const sh = b.bottom - b.top;
      const leak = (sw >= doc.width * 0.94 && sh >= Math.min(doc.width * 0.7, doc.height * 0.6)) || (sh >= doc.height * 0.96 && sw >= doc.width * 0.6);
      if (!local && clicked && trigger.source !== "rectangle" && leak) {
        result.leak = true;
        return JSON.stringify(result);
      }
      let read = selection;
      if (local) {
        const disc = polygonSelection(doc, local);
        read = disc ? combineSelections(doc, selection, disc, "intersect") : null;
        if (!read) return JSON.stringify({ error: "shape" });
      }
      result.histograms = selectionHistograms(doc, read);
      if (data && data.keepSize) {
        const layer = activeTextLayer(doc);
        if (layer) {
          result.activeTextSize = sizeInTypeUnit(shownSize(layer.params.layerText.textStyleRange[0].textStyle), doc.resolution);
          result.activeTextUnit = typeUnitAt(doc.resolution);
        }
      }
      if (!data || !data.trigger || data.trigger.source !== "rectangle") result.rawPath = ringsToPath(read.rings);
      // New text is vertical here when the Type tool is: the panel fits it in columns
      if (app.textDefaults.orientation === "vertical") result.vertical = true;
      return JSON.stringify(result);
    },
    smartPasteMeasure(data) {
      const doc = app.doc;
      if (!doc) return JSON.stringify({ error: "doc" });
      const requests = (data && data.requests) || [];
      // The ink of the line as the page will draw it (Roman Hanging Punctuation, the spaces that
      // end a line), a point text at the page's centre: what the engine fits and centres is what
      // shows. An atlas gets its first line, which the engine does not read (it measures each
      // line again).
      const measure = () => JSON.stringify(requests.map((request) => {
        const lt = followTextDefaults(paramsInPoints(request.params, doc.resolution)).layerText;
        const key = String(lt.textKey || "").split(/\r\n?|\n/)[0];
        // A vertical text is fitted column by column: the line is measured standing
        const line = Object.assign({}, lt, { textKey: key, textClickPoint: { horizontal: 50, vertical: 50 }, textShape: [{ textType: "point", orientation: verticalOf(lt) ? "vertical" : "horizontal" }] });
        delete line.orientation;
        const b = layoutLayer({ params: { layerText: line } }, doc).box;
        return { bounds: { left: b.left, top: b.top, right: b.right, bottom: b.bottom } };
      }));
      const names = [];
      requests.forEach((request) => (request.params.layerText.textStyleRange || []).forEach((range) => names.push(range.textStyle.fontPostScriptName)));
      if (names.every((name) => !name || (Fonts.get(name) && Fonts.get(name).ready) || Fonts.isMissing(name))) return measure();
      return Fonts.ready(names).then(measure);
    },
    smartPasteCommit(data) {
      const doc = app.doc;
      if (!doc) return JSON.stringify({ error: "doc" });
      if (!data || String(doc.id) !== String(data.documentId)) return JSON.stringify({ error: "doc" });
      const before = doc.history[doc.historyIndex].id;
      let layers = doc.state.layers;
      const created = [];
      let spot = textSpotOf(doc);
      (data.sessions || []).forEach((session) => {
        const plan = session.plan;
        if (plan.autoClean && plan.cleanupPolygon) {
          const op = { t: "poly", polygon: plan.cleanupPolygon, color: plan.fillRGB || { red: 255, green: 255, blue: 255 }, inset: plan.cleanupInset || 0 };
          layers = paintOnCleanLayer(layers, () => op);
        }
        const params = followTextDefaults(paramsInPoints(session.text.params, doc.resolution));
        // The shape says which way the text runs: Photoshop's second word for it is the panel's
        delete params.layerText.orientation;
        // As the panel does on a black bubble, on a dark one: white text
        whiteOnDarkBubble(doc, plan, params, session.text.stroke);
        let layer = newTextLayer(doc, params, session.text.stroke, session.layerName);
        if (data.pointText === false) layer = asParagraph(layer, doc);
        // As TypeR's hosts settle a pasted text (_smartSettleInk): the middle of its ink box on
        // the bubble's centre, where the engine laid it out and where Align puts it. Photoshop
        // reads whole pixels and moves when half a pixel off; Studio's ink and moves are exact,
        // so a hundredth of a pixel off is moved, and Align then has nothing left to move.
        const target = session.text && session.text.target;
        if (target && Number.isFinite(target.x) && Number.isFinite(target.y)) {
          const ink = boxOf(layer, doc);
          if (Math.abs(target.x - ink.xMid) > 0.01 || Math.abs(target.y - ink.yMid) > 0.01) layer = centredOn(layer, doc, target.x, target.y);
        }
        layer.source = session.layerName || "";
        created.push(layer);
        layers = addNewTexts(layers, [layer], spot);
        // The next one goes above this one
        if (spot.above) spot = { folder: layer.group, above: layer.id };
      });
      commitState(doc, "TyperTools Smart Paste", { layers, selection: selectionAfterPaste(doc), activeIds: created.length ? [created[created.length - 1].id] : doc.state.activeIds });
      emit("selection", doc.state.selection);
      emit("paste", { sessions: data.sessions, layers: created, source: data.source });
      return JSON.stringify({ layerIds: created.map((layer) => layer.id), history: { documentId: doc.id, before, after: doc.history[doc.historyIndex].id } });
    },
    getHistorySnapshot() {
      const doc = app.doc;
      if (!doc) return JSON.stringify(null);
      return JSON.stringify({ documentId: doc.id, current: doc.history[doc.historyIndex].id, states: doc.history.map((entry) => entry.id) });
    },
    restoreHistoryState(data) {
      const doc = app.doc;
      if (!doc) return JSON.stringify({ error: "doc" });
      if (!data || String(doc.id) !== String(data.documentId)) return JSON.stringify({ error: "doc" });
      const index = doc.history.findIndex((entry) => String(entry.id) === String(data.state));
      if (index < 0) return JSON.stringify({ error: "history" });
      ops.jump(index);
      return JSON.stringify({ ok: true });
    },
    replaySelectionTrigger(trigger) {
      const doc = app.doc;
      if (!doc) return JSON.stringify({ error: "doc" });
      if (!trigger) return JSON.stringify({ error: "trigger" });
      let selection = null;
      if (trigger.source === "wand") {
        selection = floodSelect(doc, trigger.x, trigger.y, (trigger.options && trigger.options.tolerance) || app.tolerance);
        selection.trigger = trigger;
      } else if (trigger.source === "rectangle" && typeof trigger.left === "number") {
        selection = makeSelection({ rect: rectFrom(trigger.left, trigger.top, trigger.right, trigger.bottom), trigger });
      } else return JSON.stringify({ error: "trigger" });
      commitState(doc, "Select Again", { selection });
      emit("selection", selection);
      // Photoshop reports it too: the panel knows its own replay and ignores it
      setTimeout(() => firePanelEvent(EVENT_SET, descriptorFor(selection)), 0);
      return JSON.stringify({ ok: true });
    },
  };

  // Calls the panel makes all the time: they do not count as work
  const QUIET_CALL = /^\s*(getHotkeyPressed|getTypeRPanelSnapshot|getTypeRSelectionSnapshot|getActiveLayerTextIfChanged|getSelectionChanged|getCurrentSelection|getSelectedTextLayers|getUserFonts|getHistorySnapshot|ensureWandSampleAll|smartPasteSelectionProbe|stopSelectionMonitoring|startSelectionMonitoring)\s*\(/;

  // A smart paste doesn't hold clicks back: the panel queues the ones made meanwhile
  const SMART_PASTE_CALL = /^\s*(smartPasteCapture|smartPasteMeasure|smartPasteCommit|restoreHistoryState)\s*\(/;

  // ExtendScript's evalScript: the panel sends a line of JavaScript
  const evalScript = (script, callback) => {
    const source = String(script);
    const quiet = QUIET_CALL.test(source) || SMART_PASTE_CALL.test(source);
    if (!quiet) {
      app.pendingActions++;
      app.lastAction = Date.now();
    }
    let result;
    try {
      // eslint-disable-next-line no-new-func
      result = new Function("host", "with (host) { return (" + source + "\n); }")(host);
    } catch (error) {
      if (!(error instanceof ReferenceError)) console.warn("TypeR demo:", error, source.slice(0, 120));
      result = "";
    }
    const finish = (value) => {
      if (!quiet) {
        app.pendingActions = Math.max(0, app.pendingActions - 1);
        app.lastAction = Date.now();
      }
      if (typeof callback === "function") {
        callback(value === undefined || value === null ? "undefined" : typeof value === "string" ? value : String(value));
      }
    };
    if (result && typeof result.then === "function") result.then(finish, () => finish(""));
    else setTimeout(() => finish(result), 0);
  };

  window.TypeRPhotoshop = {
    app,
    ops,
    FX_ORDER,
    FX_DEFAULTS,
    fxDefault,
    effectsOn,
    flatVisual,
    BLENDS,
    grayOf,
    maskOn,
    vectorOn,
    host,
    evalScript,
    drawTextLayer,
    paintDoc,
    offCard,
    canvasFits,
    visualOf,
    boxOf,
    frameOf,
    textBoxOf,
    onPage,
    turnOf,
    turnedFrame,
    lineModel,
    lineWidth,
    layoutLayer,
    caretLines,
    photoshopLines,
    surfaceOf,
    surfaceFits,
    surfacesOf: (doc) => surfacesOf(doc.state),
    surfaceAt: (doc, point) => surfaceAt(surfacesOf(doc.state), point),
    flatSurface,
    placeOnSurface,
    meshOk,
    meshShift,
    meshOutline,
    outlineOk,
    outlineOnPage,
    shapeFrameOf,
    envelopeOn,
    warpBoundsOf,
    isSmart,
    filtersOn,
    cleanFilter,
    smartContents,
    traceText,
    isDirty,
    newRaster,
    newId,
    newCanvas,
    clipOf,
    tracePaths,
    asCanvas,
    imageResolution,
    withResolution,
    wrapWords,
    softBreaksOf,
    wordCutsOf,
    verticalOf,
    layTurnOf,
    pairsOfText,
    breaksBare,
    cssFont,
    EXTRA_BOLD_WIDTH,
    blendedText,
    strokeUnder,
    lightnessOf,
    languageTagOf,
    TEXT_LANGUAGES,
    DEFAULT_TEXT_LANGUAGE,
    textLanguageNumber,
    textLanguageName,
    textLanguageBlockNumber,
    drawOp,
    renderGradient,
    labRange,
    setActiveDoc: (doc) => setDoc(doc),
    paramsFromStyle: (style, text, runs, size) => paramsFromStyle(style, text, runs, size),
    newTextLayer: (doc, params, stroke, name) => newTextLayer(doc, params, stroke, name),
    familyOf: (layers, id) => familyOf(layers, id),
    fillOf,
    strokeOutside,
    // A stroke's colour or, with Fill Type Gradient, its gradient: for ringOf and innerRingOf
    strokePaint,
    strokeReach,
    strokeAlpha,
    ringOf,
    innerRingOf,
    lockOf,
    groupVisual: (group, doc) => groupVisual(group, doc),
    centredOn,
    get fonts() { return Fonts.list(); },
    extensionId: EXTENSION_ID,
    activeTextLayer,
    on(listener) {
      app.listeners.add(listener);
      return () => app.listeners.delete(listener);
    },
    addPanelListener(type, listener, obj) {
      (app.panelListeners[type] = app.panelListeners[type] || []).push({ listener, obj });
    },
    removePanelListener(type, listener) {
      if (app.panelListeners[type]) app.panelListeners[type] = app.panelListeners[type].filter((entry) => entry.listener !== listener);
    },
    resetPanelListeners() {
      app.panelListeners = {};
    },
    announce(type) {
      // A text is only shown as it was quickly drawn while it is typed
      if (type === "editing") settleTexts();
      emit(type);
    },
    warnStorage() {
      emit("storage-full");
    },
    setKeys(keys) {
      Object.assign(app.keys, keys);
      if (keys.key) app.keysSeen = Object.assign({}, app.keys);
      else ["meta", "ctrl", "alt", "shift"].forEach((name) => {
        if (keys[name]) app.keysSeen[name] = true;
      });
    },
    clearKeys() {
      app.keys = { meta: false, ctrl: false, alt: false, shift: false, key: "" };
      app.keysSeen = Object.assign({}, app.keys);
    },
    muteKeys(test) {
      app.keysMuted = test;
    },
    keyName(event) {
      const key = event.key;
      if (!key || key === "Meta" || key === "Control" || key === "Alt" || key === "Shift" || key === "OS") return "";
      if (key === " ") return "SPACE";
      if (key === "+") return "PLUS";
      if (key === "-") return "MINUS";
      if (key === "=") return "EQUAL";
      if (key === "/") return "DIVIDE";
      if (key === "*") return "MULTIPLY";
      if (key === "Escape") return "ESCAPE";
      // Read as Settings records it: Option+L types "¬", AZERTY's 1 types "&", and both are still L and 1
      const code = event.keyCode;
      if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90)) return String.fromCharCode(code);
      // Option+L on a Mac types "¬", and a Cyrillic layout "д": the shortcut means the physical letter
      if (/^Key[A-Z]$/.test(event.code || "") && (key === "Dead" || (key.length === 1 && key.charCodeAt(0) > 127))) return event.code.slice(3);
      return key.toUpperCase();
    },
  };
})();
