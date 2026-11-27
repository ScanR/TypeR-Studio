// Checks that Vertical Text goes through the InDesign export and import (web/indesign.js):
// texts of a page are exported as an .idml and opened again, at 72 and at 300 ppi, and each must
// come back vertical, its letters within a pixel of where they were; then a file written the way
// InDesign writes its own (Ascent offset, insets, the vertical settings in its styles) is opened.
// InDesign itself is not run: what it does with the file can't be checked here.
//
//   node scripts/test-indesign-vertical.js [-v]        -v lists every check
//
// Needs Google Chrome (CHROME), desktop/node_modules (npm install in desktop/, or PLAYWRIGHT for
// playwright-core elsewhere) and a Chinese font: PingFang SC, which macOS has.
const http = require("http");
const fs = require("fs");
const path = require("path");
const REPO = path.resolve(__dirname, "..");
const { chromium } = require(process.env.PLAYWRIGHT || path.join(REPO, "desktop", "node_modules", "playwright-core"));
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".wasm": "application/wasm" };

const inPage = async () => {
  const PS = window.TypeRPhotoshop;
  const ops = PS.ops;
  const Fonts = window.TypeRFonts;
  const ID = window.TypeRInDesign;
  const Kit = window.TypeRKit;
  const log = [];
  const ok = (name, cond, extra) => log.push(`${cond ? "ok  " : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
  const wait = (ms) => new Promise((done) => setTimeout(done, ms));
  // The font's forms for a vertical line come a moment after it is first drawn
  const settle = async (doc) => {
    for (let i = 0, last = -1; i < 40; i++) {
      doc.state.layers.forEach((layer) => layer.kind === "text" && PS.visualOf(layer, doc));
      await wait(250);
      if (Fonts.generation === last) break;
      last = Fonts.generation;
    }
  };
  const rect = (r) => (r ? [r.left, r.top, r.right, r.bottom] : null);
  const snap = (doc, layer) => {
    const lt = layer.params.layerText;
    const shape = lt.textShape[0];
    return {
      text: lt.textKey,
      vertical: PS.verticalOf(lt),
      type: shape.textType,
      align: lt.paragraphStyleRange[0].paragraphStyle.alignment,
      across: shape.box ? shape.box.verticalAlign : null,
      ways: lt.textStyleRange.map((range) => [range.from, range.to, range.textStyle.baselineDirection || ""]),
      pairs: PS.pairsOfText(lt),
      box: rect(PS.boxOf(layer, doc)),
      frame: rect(PS.frameOf(layer, doc)),
      // Its own box before any turn, and the turn
      own: rect(PS.layoutLayer(layer, doc).frame),
      spin: layer.rotated && layer.spin ? layer.spin : [1, 0, 0, 1],
      picture: PS.visualOf(layer, doc),
    };
  };
  // Within a pixel: every pixel of ink of one picture has ink beside it in the other (a text
  // set at the same place from another anchor is drawn a fraction of a pixel away)
  const pixelsApart = (a, b) => {
    const x0 = Math.floor(Math.min(a.x, b.x));
    const y0 = Math.floor(Math.min(a.y, b.y));
    const w = Math.ceil(Math.max(a.x + a.canvas.width, b.x + b.canvas.width)) - x0;
    const h = Math.ceil(Math.max(a.y + a.canvas.height, b.y + b.canvas.height)) - y0;
    const alpha = (v) => {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(v.canvas, Math.round(v.x - x0), Math.round(v.y - y0));
      return ctx.getImageData(0, 0, w, h).data;
    };
    const da = alpha(a);
    const db = alpha(b);
    const near = (d, x, y) => {
      let most = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (x + dx < 0 || y + dy < 0 || x + dx >= w || y + dy >= h) continue;
        most = Math.max(most, d[((y + dy) * w + x + dx) * 4 + 3]);
      }
      return most;
    };
    let ink = 0;
    let off = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4 + 3;
      if (da[i] > 8 || db[i] > 8) ink++;
      if ((da[i] > 128 && da[i] - near(db, x, y) > 96) || (db[i] > 128 && db[i] - near(da, x, y) > 96)) off++;
    }
    return { ink, off };
  };
  const paperOf = async (doc) => {
    const canvas = document.createElement("canvas");
    canvas.width = doc.width;
    canvas.height = doc.height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return new Uint8Array(await (await new Promise((done) => canvas.toBlob(done, "image/png"))).arrayBuffer());
  };
  const unpack = async (bytes) => {
    const zip = Kit.zipEntries(bytes.buffer);
    const files = {};
    for (const entry of zip.entries) files[entry.name] = new Uint8Array(await zip.read(entry));
    return files;
  };
  const textOf = (bytes) => new TextDecoder().decode(bytes);
  const largest = (values) => values.reduce((most, value) => Math.max(most, Math.abs(value)), 0);

  await Fonts.ensure("PingFangSC-Regular", "PingFangSC-Regular", "PingFang SC", "Regular");
  await Fonts.ensure("ArialMT", "ArialMT", "Arial", "Regular");

  /* ----------------------- out of TypeR and back in ----------------------- */

  const roundTrip = async (resolution, size) => {
    const tag = `${resolution} ppi`;
    const k = resolution / 72;
    ops.newDocument({ width: Math.round(1500 * k), height: Math.round(1100 * k), resolution, name: "vertical" });
    Object.assign(PS.app.textDefaults, { font: "PingFangSC-Regular", family: "PingFang SC", style: "Regular", size });
    const get = (id) => PS.app.doc.state.layers.find((layer) => layer.id === id);
    const made = [];
    const add = (name, x, y, text, box, way) => {
      const id = ops.newText(x * k, y * k, text, box ? Object.assign({}, box, { width: box.width * k, height: box.height * k }) : null, way || "vertical").id;
      made.push([name, id]);
      return id;
    };
    const LINES = "天地玄黄，宇宙洪荒。\r日月盈昃辰宿列张";
    const LONG = "天地玄黄宇宙洪荒，日月盈昃辰宿列张。寒来暑往";
    const BOX = { width: 150, height: 230, autoHeight: false, verticalAlign: "top" };
    add("point, top", 1400, 80, LINES);
    ops.setTextStyle([add("point, centre", 1250, 300, LINES)], null, { alignment: "center" });
    ops.setTextStyle([add("point, bottom", 1100, 520, LINES)], null, { alignment: "right" });
    add("box, top", 950, 60, LONG, BOX);
    ops.setTextStyle([add("box, centre", 760, 60, LONG, BOX)], null, { alignment: "center" });
    ops.setTextStyle([add("box, bottom", 570, 60, LONG, BOX)], null, { alignment: "right" });
    ops.setTextVerticalAlign([add("box, centred across", 380, 60, LONG, Object.assign({}, BOX, { width: 220 }))], "center");
    add("box, as wide as its lines", 190, 60, LONG, Object.assign({}, BOX, { autoHeight: true }));
    // Its last line reaches past its box, as Photoshop lets it
    add("tight box", 1420, 640, "天地玄黄宇宙洪荒日月盈昃", { width: (2 * size * 72) / 72, height: 6.3 * size, autoHeight: false, verticalAlign: "top" });
    ops.turnText(get(add("turned point", 1200, 760, LINES)), 0.4, [1200 * k, 760 * k]);
    ops.turnText(get(add("turned box", 1000, 640, LONG, BOX)), -0.3, [900 * k, 700 * k]);
    // Tate-Chu-Yoko: pairs TypeR finds, two in a row, and a run set so
    add("pairs", 780, 640, "平成12年！？\r共12!?页");
    ops.setTextStyle([add("Tate-Chu-Yoko", 680, 640, "共2026年ABC完")], { baselineDirection: "cross" }, null, false, [1, 5]);
    // Latin words: upright, on their side, both in one text
    add("Latin upright", 580, 640, "他说Hello吧，OK");
    ops.setTextStyle([add("Latin on its side", 480, 640, "他说Hello吧，OK")], { baselineDirection: "rotated" });
    ops.setTextStyle([add("Latin both ways", 380, 640, "他说Hello吧，OK")], { baselineDirection: "rotated" }, null, false, [2, 7]);
    ops.setTextStyle([add("Latin font", 280, 640, "Vertical 12")], { fontPostScriptName: "ArialMT", fontName: "Arial", fontStyleName: "Regular" });
    {
      const id = add("sizes, Faux Bold, Stroke", 180, 640, "大小粗体，混排");
      ops.setTextStyle([id], { size: size * 1.5, impliedFontSize: size * 1.5 }, null, false, [0, 2]);
      ops.setTextStyle([id], { syntheticBold: true }, null, false, [2, 4]);
      ops.setTextStroke([id], () => ({ enabled: true, size: 3 * k, color: { r: 255, g: 255, b: 255 }, position: "outer" }));
    }
    ops.setTextStyle([add("narrow letters, in a box", 80, 640, "窄字宽字\r第二行", { width: 100, height: 200, autoHeight: false, verticalAlign: "top" })], { horizontalScale: 70, verticalScale: 110, tracking: 80 });
    add("horizontal", 120, 1000, "Horizontal text", null, "horizontal");

    const first = PS.app.doc;
    await settle(first);
    const before = made.map(([name, id]) => Object.assign({ name }, snap(first, get(id))));
    const bytes = new Uint8Array(await (await ID.exportPackage("vertical.idml", [{ doc: first, picture: await paperOf(first) }])).arrayBuffer());
    const parts = await unpack(bytes);
    const stories = Object.keys(parts).filter((name) => /^Stories\//.test(name)).map((name) => textOf(parts[name]));
    ok(`${tag}: a vertical story for each vertical text`, stories.filter((story) => /StoryOrientation="Vertical"/.test(story)).length === before.length - 1 && stories.filter((story) => /StoryOrientation="Horizontal"/.test(story)).length === 1);
    await window.TypeRApp.openFiles([new File([bytes], `vertical-${resolution}.idml`)]);
    for (let i = 0; i < 100 && !(PS.app.doc && PS.app.doc.idml); i++) await wait(100);
    const second = PS.app.doc;
    await settle(second);
    ok(`${tag}: the page is back`, second !== first && second.width === first.width && second.height === first.height && second.resolution === first.resolution, `${second.width} x ${second.height} at ${second.resolution}`);
    const left = second.state.layers.filter((layer) => layer.kind === "text");
    ok(`${tag}: every text is back`, left.length === before.length, `${left.length} of ${before.length}`);
    const waysOf = (s) => {
      const out = [];
      let at = 0;
      for (const ch of s.text) {
        // Line ends come back as returns
        if (ch !== "\r") out.push((s.ways.find((way) => at >= way[0] && at < way[1]) || [0, 0, ""])[2].replace("withStream", ""));
        at += ch.length;
      }
      return out.join(",");
    };
    before.forEach((was) => {
      // By its words and the nearest place: several texts share theirs
      let best = null;
      left.forEach((layer) => {
        if (layer.params.layerText.textKey.replace(/\r/g, "") !== was.text.replace(/\r/g, "")) return;
        const box = PS.boxOf(layer, second);
        const far = Math.abs(box.left - was.box[0]) + Math.abs(box.top - was.box[1]);
        if (!best || far < best.far) best = { layer, far };
      });
      const name = `${tag}, ${was.name}`;
      if (!best) return ok(`${name}: back`, false);
      left.splice(left.indexOf(best.layer), 1);
      const now = snap(second, best.layer);
      ok(`${name}: ${was.vertical ? "vertical" : "horizontal"} again`, now.vertical === was.vertical);
      if (was.name === "Latin both ways") {
        // InDesign says once for a paragraph which way its Latin letters go: the way most went
        return ok(`${name}: every Latin letter the way most of them went, on their side`, now.ways.every((way) => way[2] === "rotated"), JSON.stringify(now.ways));
      }
      const moved = largest(now.box.map((v, i) => v - was.box[i]).concat(now.frame.map((v, i) => v - was.frame[i])));
      ok(`${name}: its letters' box within a pixel`, moved <= 1, `${moved.toFixed(3)} px`);
      const apart = pixelsApart(was.picture, now.picture);
      ok(`${name}: its pixels within a pixel`, apart.off === 0, `${apart.off} of ${apart.ink}`);
      ok(`${name}: turned the same`, largest(now.spin.map((v, i) => v - was.spin[i])) < 1e-4);
      ok(`${name}: aligned the same`, now.align === was.align && (was.type !== "box" || now.across === was.across), `${was.align} ${was.across} -> ${now.align} ${now.across}`);
      ok(`${name}: the same characters side by side, the same Latin letters on their side`, JSON.stringify(now.pairs) === JSON.stringify(was.pairs) && waysOf(now) === waysOf(was), `${JSON.stringify(was.ways)} -> ${JSON.stringify(now.ways)}`);
      if (was.type !== "box") return;
      // As a horizontal text's frame is a little wider than its box, a vertical one is a little
      // longer: 3% or 2 points of room along its lines, for what InDesign measures its own way
      const room = Math.max((was.own[3] - was.own[1]) * 0.03, (2 * resolution) / 72);
      const d = now.own.map((v, i) => v - was.own[i]);
      const ends = was.align === "left" ? [0, room] : was.align === "right" ? [-room, 0] : [-room / 2, room / 2];
      ok(`${name}: its box as long, but for its room`, Math.abs(d[1] - ends[0]) <= 0.05 && Math.abs(d[3] - ends[1]) <= 0.05, `${d[1].toFixed(2)} ${d[3].toFixed(2)}`);
      // The frame is made to hold the last line of the tight one, which InDesign would leave out
      if (was.name === "tight box") ok(`${name}: two lines, its box wider on the left only, by less than a third of the size`, PS.layoutLayer(best.layer, second).relative.lines.length === 2 && d[0] < -1 && d[0] > -0.3 * size * k && Math.abs(d[2]) <= 0.01, `${d[0].toFixed(2)} ${d[2].toFixed(2)}`);
      else ok(`${name}: its box's sides within a pixel`, Math.max(Math.abs(d[0]), Math.abs(d[2])) <= 1, `${d[0].toFixed(3)} ${d[2].toFixed(3)}`);
    });
    // Saved again untouched: nothing is rewritten
    const again = await unpack(new Uint8Array(await (await ID.build(second.idml.pkg, [second])).blob.arrayBuffer()));
    ok(`${tag}: saved again untouched, the stories and the page as they were`, Object.keys(parts).filter((name) => /^(Stories|Spreads)\//.test(name)).every((name) => textOf(parts[name]) === textOf(again[name])));
    // One made horizontal, the horizontal one made vertical: both stories say so
    const texts = second.state.layers.filter((layer) => layer.kind === "text");
    ops.setTextOrientation([texts.find((layer) => /Hello/.test(layer.params.layerText.textKey)).id], "horizontal");
    ops.setTextOrientation([texts.find((layer) => !PS.verticalOf(layer.params.layerText)).id], "vertical");
    const third = await unpack(new Uint8Array(await (await ID.build(PS.app.doc.idml.pkg, [PS.app.doc])).blob.arrayBuffer()));
    const changed = Object.keys(parts).filter((name) => /^Stories\//.test(name) && textOf(parts[name]) !== textOf(third[name]));
    const wayNow = (word) => changed.map((name) => textOf(third[name])).filter((story) => (story.match(/<Content>[^<]*<\/Content>/g) || []).join("").replace(/<\/?Content>|[\u2028\s]/g, "").includes(word)).map((story) => /StoryOrientation="(\w+)"/.exec(story)[1]).join();
    ok(`${tag}: Text Orientation changed in an opened file, each story the other way`, changed.length === 2 && wayNow("Hello") === "Horizontal" && wayNow("Horizontaltext") === "Vertical", `${changed.length} ${wayNow("Hello")} ${wayNow("Horizontaltext")}`);
  };
  await roundTrip(72, 32);
  await roundTrip(300, 9);

  /* ------------------- a file as InDesign writes its own ------------------- */

  {
    const resolution = 144;
    const k = resolution / 72;
    ops.newDocument({ width: 1200, height: 900, resolution, name: "indesign" });
    Object.assign(PS.app.textDefaults, { font: "PingFangSC-Regular", family: "PingFang SC", style: "Regular", size: 14 });
    const id = ops.newText(900, 100, "他说Hello吧，共2026年", { width: 200, height: 320, autoHeight: false, verticalAlign: "top" }, "vertical").id;
    ops.setTextStyle([id], { baselineDirection: "cross" }, null, false, [10, 14]);
    const doc = PS.app.doc;
    await settle(doc);
    const parts = await unpack(new Uint8Array(await (await ID.exportPackage("indesign.idml", [{ doc, picture: await paperOf(doc) }])).arrayBuffer()));
    const storyName = Object.keys(parts).find((name) => /^Stories\//.test(name));
    const spreadName = Object.keys(parts).find((name) => /^Spreads\//.test(name));
    const story = textOf(parts[storyName]);
    const spread = textOf(parts[spreadName]);
    const styles = textOf(parts["Resources/Styles.xml"]);
    // The frame as written, in points: its corner and its size
    const frame = /<TextFrame [^>]*ItemTransform="1 0 0 1 ([\d.-]+) ([\d.-]+)"[^>]*>.*?<\/TextFrame>/.exec(spread);
    const anchors = (frame[0].match(/Anchor="[^"]*"/g) || []).map((anchor) => anchor.slice(8, -1).split(" ").map(Number));
    const place = { left: Number(frame[1]), top: Number(frame[2]), width: Math.max(...anchors.map((anchor) => anchor[0])), height: Math.max(...anchors.map((anchor) => anchor[1])) };
    const open = async (changes) => {
      const files = Object.assign({}, parts);
      const put = (name, text) => { files[name] = new TextEncoder().encode(text); };
      put(storyName, changes.story ? changes.story(story) : story);
      put(spreadName, changes.spread ? changes.spread(spread) : spread);
      put("Resources/Styles.xml", changes.styles ? changes.styles(styles) : styles);
      const order = ["mimetype"].concat(Object.keys(files).filter((name) => name !== "mimetype"));
      const blob = await Kit.writeArchive(order.map((name) => ({ name, data: files[name], store: name === "mimetype" })));
      const read = await ID.read(new File([blob], "indesign.idml"));
      const page = (await ID.pages(read, null)).pages[0];
      await Fonts.ready(page.fontNames);
      const layer = page.layers.find((item) => item.kind === "text");
      return { layer, lt: layer.params.layerText, page: { width: page.width, height: page.height, resolution: page.resolution } };
    };
    const ways = (lt) => lt.textStyleRange.map((range) => `${range.from}-${range.to}${range.textStyle.baselineDirection || ""}`).join(" ");
    // What is set side by side, and whether everything else lies on its side
    const acrossOf = (lt) => lt.textStyleRange.filter((range) => range.textStyle.baselineDirection === "cross").map((range) => lt.textKey.slice(range.from, range.to)).join("|") + (lt.textStyleRange.every((range) => /^(cross|rotated)$/.test(range.textStyle.baselineDirection)) ? " rotated" : "");
    // InDesign's own settings off: none of what TypeR writes for itself
    const bare = (text) => text.replace(/ (RotateSingleByteCharacters|Tatechuyoko|Composer|LeadingModel|CharacterAlignment|GridAlignment|AutoTcy)="[^"]*"/g, "");
    const crossed = (text) => text.replace(/(<CharacterStyleRange )([^>]*>(?:(?!<\/CharacterStyleRange>).)*<Content>2026<)/, "$1Tatechuyoko=\"true\" $2");

    // Nothing said: InDesign lays Latin letters on their side, and so does TypeR then
    let back = await open({ story: bare });
    ok("InDesign's file: vertical, its Latin letters on their side when nothing says otherwise", PS.verticalOf(back.lt) && back.lt.textStyleRange.every((range) => range.textStyle.baselineDirection === "rotated"), ways(back.lt));
    // Rotate Roman in Vertical Text, from the paragraph style: upright
    back = await open({ story: bare, styles: (text) => text.replace('Name="$ID/NormalParagraphStyle"', 'Name="$ID/NormalParagraphStyle" RotateSingleByteCharacters="true"') });
    ok("InDesign's file: Latin letters upright when the paragraph style rotates them", back.lt.textStyleRange.every((range) => !range.textStyle.baselineDirection), ways(back.lt));
    // Tate-Chu-Yoko on a run, and from a character style
    back = await open({ story: (text) => crossed(bare(text)) });
    ok("InDesign's file: Tate-Chu-Yoko on a run", acrossOf(back.lt) === "2026 rotated", ways(back.lt));
    back = await open({
      story: (text) => bare(text).replace(/(<CharacterStyleRange AppliedCharacterStyle=")[^"]*("[^>]*>(?:(?!<\/CharacterStyleRange>).)*<Content>2026<)/, "$1CharacterStyle/Across$2"),
      styles: (text) => text.replace("</RootCharacterStyleGroup>", '<CharacterStyle Self="CharacterStyle/Across" Imported="false" Name="Across" Tatechuyoko="true"/></RootCharacterStyleGroup>'),
    });
    ok("InDesign's file: Tate-Chu-Yoko from a character style", acrossOf(back.lt) === "2026 rotated", ways(back.lt));
    // Ascent offset and insets (top 4, left 6, bottom 8, right 10 points): the box is the frame
    // inside its insets, held by its top right corner
    back = await open({ spread: (text) => text.replace('FirstBaselineOffset="EmboxHeight"', 'FirstBaselineOffset="AscentOffset"').replace(/<InsetSpacing type="list">.*?<\/InsetSpacing>/, '<InsetSpacing type="list"><ListItem type="unit">4</ListItem><ListItem type="unit">6</ListItem><ListItem type="unit">8</ListItem><ListItem type="unit">10</ListItem></InsetSpacing>') });
    {
      const shape = back.lt.textShape[0];
      const at = [(back.lt.textClickPoint.horizontal / 100) * back.page.width, (back.lt.textClickPoint.vertical / 100) * back.page.height];
      const wanted = { x: (place.left + place.width - 10) * k, y: (place.top + 4) * k, width: (place.width - 16) * k, height: (place.height - 12) * k };
      const off = largest([at[0] - wanted.x, at[1] - wanted.y, shape.box.width - wanted.width, shape.box.height - wanted.height]);
      ok("InDesign's file: Ascent offset and insets, the box is the frame inside its insets, held by its top right", shape.orientation === "vertical" && shape.textType === "box" && off < 0.01, `${off.toFixed(4)} px`);
    }
    // Centred across the frame, and a text aligned to the bottom
    back = await open({ spread: (text) => text.replace('VerticalJustification="TopAlign"', 'VerticalJustification="CenterAlign"'), story: (text) => text.replace('Justification="LeftAlign"', 'Justification="RightAlign"') });
    ok("InDesign's file: centred across its frame, aligned to the bottom", back.lt.textShape[0].box.verticalAlign === "center" && back.lt.paragraphStyleRange[0].paragraphStyle.alignment === "right");
    // Without its story orientation, or horizontal: a horizontal text, as before
    back = await open({ story: (text) => text.replace('StoryOrientation="Vertical"', 'StoryOrientation="Horizontal"') });
    ok("InDesign's file: a horizontal story stays horizontal", !PS.verticalOf(back.lt) && back.lt.textStyleRange.every((range) => !range.textStyle.baselineDirection), ways(back.lt));
  }
  return log;
};

(async () => {
  const server = http.createServer((req, res) => {
    const file = path.join(REPO, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!file.startsWith(REPO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.statusCode = 404;
      return res.end();
    }
    res.setHeader("Content-Type", MIME[path.extname(file)] || "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--enable-gpu", "--use-angle=metal", "--enable-features=FontAccess"] });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1, locale: "en-US", permissions: ["local-fonts"] });
  await context.addInitScript(() => {
    try {
      ["typer.web.onboarding=done", "typer.web.betaNotice=1", "typer.web.whatsNew.off=1", "typer.web.flowOffered=1", "typer-lang=en"].forEach((pair) => localStorage.setItem(...pair.split("=")));
    } catch (error) {}
  });
  // Nothing but this repository's own files
  await context.route((url) => !/^(http:\/\/127\.0\.0\.1|data:|blob:|about:)/.test(url.href), (route) => route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String((error && error.stack) || error)));
  await page.goto(`http://127.0.0.1:${server.address().port}/web/index.html`);
  await page.waitForFunction(() => window.TypeRApp && window.TypeRPhotoshop && window.TypeRApp.booted, null, { timeout: 30000 });
  await page.waitForTimeout(400);
  let log = [];
  try {
    log = await page.evaluate(inPage);
  } catch (error) {
    errors.push(String((error && error.stack) || error));
  }
  await browser.close();
  server.close();
  const failed = log.filter((line) => line.startsWith("FAIL"));
  console.log((process.argv.includes("-v") ? log : failed).join("\n"));
  if (errors.length) console.log(errors.join("\n"));
  console.log(failed.length || errors.length ? `${failed.length} of ${log.length} checks failed` : `ok: ${log.length} checks`);
  process.exit(failed.length || errors.length ? 1 : 0);
})();
