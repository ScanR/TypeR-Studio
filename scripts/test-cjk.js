// Checks web/cjk.js: where a Chinese or Japanese line may break, which way a character stands
// in a vertical text, and the pairs set side by side.
//
//   node scripts/test-cjk.js
const path = require("path");

global.window = {};
require(path.resolve(__dirname, "..", "web", "cjk.js"));
const CJK = window.TypeRCJK;

let failed = 0;
const same = (name, got, wanted) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(wanted);
  if (a === b) return;
  failed++;
  console.error(`FAIL ${name}\n  got    ${a}\n  wanted ${b}`);
};
// A text with a | at each place a line may break
const cut = (text) => {
  const breaks = CJK.breaksOf(text);
  let out = "";
  let at = 0;
  for (const ch of text) {
    if (breaks && breaks.has(at)) out += "|";
    out += ch;
    at += ch.length;
  }
  return out;
};

// Between any two ideographs, never before a mark that closes nor after one that opens
same("ideographs", cut("天地玄黄"), "天|地|玄|黄");
same("stops stay with what they follow", cut("天地，玄黄。"), "天|地，|玄|黄。");
same("brackets keep what they hold", cut("他说：“你好！”（真的）"), "他|说：|“你|好！”|（真|的）");
same("corner brackets, long vowel, small kana", cut("「漫画」ー、ばっちり"), "「漫|画」ー、|ばっ|ち|り");
same("a dash or an ellipsis written twice is one mark", cut("啊……他——走了"), "啊|……|他|——|走|了");
same("Latin words stay whole, and break from the ideographs around them", cut("第12话 Hello世界ABC。"), "第|12|话 Hello|世|界|ABC。");
same("a number keeps its unit and its currency sign", cut("100％的人$5"), "100％|的|人|$5");
same("characters written with two code units", cut("𠀋𠀋"), "𠀋|𠀋");
same("no ideograph, no break", CJK.breaksOf("Hello world, again"), null);
// A full-width mark in a Latin text stays with its word; a letter keeps the marks it carries
same("full-width marks in Latin words", ["Yay～♪", "Ooh～nice", "Oui！？Non", "A・B「quote」"].map(cut), ["Yay～♪", "Ooh～nice", "Oui！？Non", "A・B「quote」"]);
same("between two marks of a Chinese text", cut("他说。「你好」"), "他|说。|「你|好」");
same("voicing marks and variation selectors", [cut("か\u3099き"), cut("ｶﾞｷ"), cut("葛\u{E0100}城")], ["か\u3099|き", "ｶﾞ|ｷ", "葛\u{E0100}|城"]);
same("Korean breaks at its spaces", CJK.breaksOf("한국어 텍스트"), null);
same("breaksBetween", [CJK.breaksBetween("天", "地"), CJK.breaksBetween("天", "。"), CJK.breaksBetween("「", "天"), CJK.breaksBetween("a", "b"), CJK.breaksBetween("天", " "), CJK.breaksBetween("", "天")], [true, false, false, false, false, false]);

// Unicode's Vertical_Orientation
same("orientation", ["A", "1", "中", "あ", "，", "。", "「", "（", "ー", "…", "—", "！", "→", "★", "“", "ｱ"].map((ch) => ch + CJK.orientationOf(ch)).join(" "),
  "AR 1R 中U あU ，Tu 。Tu 「Tr （Tr ーTr …R —R ！Tu →R ★U “Tr ｱR");

// Two digits, or two of ! and ?, on their own
same("pairs", ["第12话", "2026年", "!?", "啊!!", "3.5", "12%", "a12", "12 34", "!!!", "99.", "10,20", "1", ""].map((text) => CJK.pairsOf(text)),
  [[[1, 3]], null, [[0, 2]], [[1, 3]], null, null, null, [[0, 2], [3, 5]], null, [[0, 2]], null, null, null]);

if (failed) {
  console.error(`${failed} check${failed > 1 ? "s" : ""} failed`);
  process.exit(1);
}
console.log("cjk.js: all checks passed");
