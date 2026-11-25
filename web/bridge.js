// Loaded first in the panel's iframe: rebuilds the CEP environment the TypeR
// panel expects (window.__adobe_cep__, window.cep), then starts the panel. No
// file of the panel is changed: it runs as it does in Photoshop.

(function () {
  "use strict";

  const params = new URLSearchParams(window.location.search);
  // Only the app starts the panel (startPanel in app.js), once it has read TypeR's files. A
  // browser also loads this page by itself, from its history: as soon as a page that comes back
  // (a tab reopened, the browser's session restored, Back) holds the frame, long before the
  // files are read, or at a later Back. A panel started then would find no file, start as a new
  // user's and write that over the user's styles, settings and scripts. That page stays empty;
  // the app, when it is already running, starts the panel itself.
  const frame = window.frameElement;
  if (!frame || !params.get("v") || frame.dataset.start !== params.get("v")) {
    const app = window.parent !== window && window.parent.TypeRApp;
    if (app && app.booted && app.startPanel) setTimeout(() => app.startPanel(), 0);
    return;
  }
  const photoshop = window.parent.TypeRPhotoshop;
  const seed = window.parent.TypeRSeed;
  const ROOT = "/typer";
  const language = params.get("lang") || "en";
  const LOCALES = { en: "en_US", fr: "fr_FR", es: "es_SP", it: "it_IT", de: "de_DE", pt: "pt_BR", ru: "ru_RU", tr: "tr_TR", uk: "uk_UA", vi: "vi_VN", ar: "ar_AE" };
  // Languages the Photoshop plugin doesn't ship yet live in web/panel-locale/
  const EXTRA_LOCALES = ["it_IT"];
  const appLocale = LOCALES[language] || "en_US";
  const gray = { antialiasLevel: 0, type: 1, color: { red: 58, green: 56, blue: 56, alpha: 255 } };

  // TypeR's storage files live in the browser. The scripts in scripts/ can run the
  // panel on a seeded copy, for the site's pictures: it is never kept.
  const kit = window.parent.TypeRKit;
  const seeded = params.get("seeded") === "1" && Boolean(seed);
  // Another tab has written TypeR's files since this panel read them (kit.js): what it holds is
  // the past, and isn't written over what is kept now. The app starts it again on that.
  const readAt = kit.elsewhere();
  const upToDate = () => kit.elsewhere() === readAt;
  const remember = (path, value) => {
    if (!seeded && kit.keeps(path) && upToDate()) kit.keep(path, value);
  };
  const forget = (path) => {
    if (!seeded && kit.keeps(path) && upToDate()) kit.forget(path);
  };
  let startingStorage = !seeded && kit.read(ROOT + "/storage");
  const shell = window.parent.TypeRShell;
  if (!startingStorage) {
    // A new user starts as in Photoshop: no styles, no script, and TypeR's own tutorial.
    // On a touch screen the tutorial's gestures don't apply.
    // TypeR Studio has its own tutorial (guide.js): the panel's isn't started here
    startingStorage = JSON.stringify(seeded ? seed.storage(language) : shell.touch ? kit.freshTouchStorage(window.parent.TypeRApp.T("Dialogue")) : kit.freshStorage(!window.parent.TypeRGuide));
  } else {
    // The panel speaks the app's language: a language picked in its settings before they
    // lost the choice would win over it
    try {
      const stored = JSON.parse(startingStorage);
      delete stored.language;
      if (params.get("tour")) stored.notFirstTime = false;
      startingStorage = JSON.stringify(stored);
    } catch (error) {
      console.warn("TypeR web: could not read TypeR's settings", error);
    }
  }
  const files = { [ROOT + "/storage"]: startingStorage };
  // The other profiles, and the list of profiles
  if (!seeded) kit.storedPaths().forEach((path) => { files[path] = kit.read(path); });
  const FS = { NO_ERROR: 0, ERR_UNKNOWN: 1, ERR_INVALID_PARAMS: 2, ERR_NOT_FOUND: 3, ERR_CANT_READ: 4, ERR_UNSUPPORTED_ENCODING: 5, ERR_CANT_WRITE: 6, ERR_OUT_OF_SPACE: 7, ERR_NOT_FILE: 8, ERR_NOT_DIRECTORY: 9, ERR_FILE_EXISTS: 10 };

  const parseProperties = (text) => {
    const out = {};
    let key = null;
    let value = "";
    String(text || "").replace(/\r/g, "").split("\n").forEach((line) => {
      if (key === null && (line.startsWith("#") || !line.trim())) return;
      if (key !== null) value += line;
      else {
        const at = line.indexOf("=");
        if (at === -1) return;
        key = line.slice(0, at).trim();
        value = line.slice(at + 1);
      }
      if (value.endsWith("\\")) {
        value = value.slice(0, -1) + "\n";
        return;
      }
      out[key] = value;
      key = null;
      value = "";
    });
    return out;
  };

  const fs = Object.assign({}, FS, {
    readFile(path) {
      if (Object.prototype.hasOwnProperty.call(files, path)) return { err: FS.NO_ERROR, data: files[path] };
      return { err: FS.ERR_NOT_FOUND, data: "" };
    },
    writeFile(path, data, encoding) {
      files[path] = String(data);
      if (window.parent.TypeRTouch) window.parent.TypeRTouch.panelChanged();
      if (kit.keeps(path)) remember(path, files[path]);
      // The app follows what the panel keeps: its current line in the status bar, its shortcuts
      if (kit.keeps(path)) window.parent.dispatchEvent(new Event("typer-storage"));
      // A file written outside TypeR's own folder is an export: it is downloaded. A font or a
      // .zip comes as Base64, and the file must hold its bytes, not that text
      else if (String(path).indexOf(ROOT + "/") !== 0) downloadFile(String(path).split(/[\\/]/).pop(), encoding === "Base64" ? fromBase64(files[path]) : files[path]);
      return { err: FS.NO_ERROR };
    },
    deleteFile(path) {
      const existed = Object.prototype.hasOwnProperty.call(files, path);
      delete files[path];
      forget(path);
      return { err: existed ? FS.NO_ERROR : FS.ERR_NOT_FOUND };
    },
    makedir() { return { err: FS.NO_ERROR }; },
    readdir() { return { err: FS.NO_ERROR, data: [] }; },
    stat() { return { err: FS.ERR_NOT_FOUND }; },
    rename() { return { err: FS.NO_ERROR }; },
    // The panel's file dialogs: a folder means "where to export", which is a download
    showOpenDialogEx(multiple, chooseDirectory, title, initial, types) {
      if (chooseDirectory) return { err: FS.NO_ERROR, data: ["/downloads"] };
      return pickFiles(multiple, types);
    },
    // Saving goes to the browser's downloads (see writeFile)
    showSaveDialogEx(title, initial, types, name) {
      const extension = types && types[0] ? "." + types[0] : "";
      if (extension === ".zip") lendZipHost();
      return { err: FS.NO_ERROR, data: "/downloads/" + (name || "TypeR" + extension) };
    },
  });
  fs.showOpenDialog = fs.showOpenDialogEx;
  fs.showSaveDialog = fs.showSaveDialogEx;

  const downloadFile = (name, data) => {
    const link = window.parent.document.createElement("a");
    link.href = URL.createObjectURL(new Blob([data], { type: "application/octet-stream" }));
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 4000);
  };

  const fromBase64 = (text) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

  const toBase64 = (bytes) => {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  };

  // The fonts a .zip can carry: the files loaded in this browser, and the computer's own
  // when the browser may read them. The built-in fonts stay out, like any font without a file.
  const fontFileBytes = async (font) => {
    if (font.source === "file") {
      await window.parent.TypeRFonts.ensure(font.postScriptName);
      const loaded = window.parent.TypeRFonts.get(font.postScriptName);
      return loaded && loaded.url ? new Uint8Array(await (await fetch(loaded.url)).arrayBuffer()) : null;
    }
    if (font.source !== "local" || !window.parent.queryLocalFonts) return null;
    const [local] = await window.parent.queryLocalFonts({ postscriptNames: [font.postScriptName] });
    return local ? new Uint8Array(await (await local.blob()).arrayBuffer()) : null;
  };

  const findFont = (ref) => {
    const Fonts = window.parent.TypeRFonts;
    return Fonts.get(ref.postScriptName) || Fonts.list().find((font) => font.family === ref.fontName && font.style === (ref.fontStyleName || "Regular"));
  };

  const fontFileName = (font, bytes) => {
    const tag = String.fromCharCode.apply(null, bytes.subarray(0, 4));
    return `fonts/${font.postScriptName}.${tag === "OTTO" ? "otf" : tag === "ttcf" ? "ttc" : "ttf"}`;
  };

  const exportZip = async ({ zipPath, jsonFileName, jsonString, fontRefs }) => {
    const entries = [{ name: jsonFileName, data: new TextEncoder().encode(jsonString) }];
    const missing = [];
    const used = new Set();
    for (const ref of fontRefs || []) {
      const font = findFont(ref);
      const bytes = font ? await fontFileBytes(font).catch(() => null) : null;
      if (!bytes) missing.push(ref.label);
      else if (!used.has(font.postScriptName)) {
        used.add(font.postScriptName);
        entries.push({ name: fontFileName(font, bytes), data: bytes });
      }
    }
    downloadFile(String(zipPath).split(/[\\/]/).pop(), await kit.writeArchive(entries));
    return { ok: true, missing, fontCount: used.size };
  };

  // fontFileExport.js leaves a .zip to the plugin's host when window.typerUXP exists. The
  // panel calls it right after the save dialog, before any timer runs, and everything else
  // only looks for that host when it loads: it stays here for that one step.
  const lendZipHost = () => {
    window.typerUXP = { request: (name, data) => (name === "exportZipWithFonts" ? exportZip(data) : Promise.reject(new Error(name))) };
    setTimeout(() => { delete window.typerUXP; }, 0);
  };

  // The fonts the Font FindeR installs (TypeR's fontInstaller.js): kept here like a font file
  // the user loads, so the text can use them at once. The desktop app also installs them on
  // the computer, for the other apps, as the Photoshop plugin does.
  window.typerFontHost = {
    async installFonts(fonts) {
      const files = (fonts || []).map((font) => ({ name: font.saveName, displayName: font.displayName, bytes: font.bytes }));
      const { added } = await window.parent.TypeRFonts.addFiles(files.map((file) => ({ name: file.name, buffer: file.bytes.slice().buffer })));
      if (!added.length) throw new Error("installFailed");
      const desktop = window.parent.TypeRDesktop;
      if (desktop && desktop.installFonts) {
        const result = await desktop.installFonts(files);
        if (!result || !result.ok) throw new Error((result && result.message) || "installFailed");
      }
      return files.length;
    },
  };

  const pickFiles = (multiple, types) => new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = Boolean(multiple);
    // A style file can also be the .zip TypeR exports with its fonts
    const styleFile = types && types.includes("json");
    // Not on a touch screen: iOS greys out the extensions it doesn't know (see touch.js)
    if (types && types.length && !shell.touch) input.accept = types.map((type) => "." + type).concat(styleFile ? [".zip"] : []).join(",");
    input.addEventListener("change", async () => {
      const picked = Array.from(input.files);
      // A .zip is imported by the window around the panel
      if (styleFile && picked.some((file) => /\.zip$/i.test(file.name))) {
        resolve({ err: FS.NO_ERROR, data: [] });
        window.parent.TypeRApp.importKits(picked);
        return;
      }
      const paths = [];
      for (const file of Array.from(input.files)) {
        const key = photoshop.ops.registerFile(file);
        if (/\.(json|txt|properties)$/i.test(file.name)) files[key] = await file.text();
        // A tool preset, or the picture of the Custom image theme, is binary: the panel asks for
        // it in Base64
        else if (/\.(tpl|png|jpe?g|webp|bmp|gif)$/i.test(file.name)) files[key] = toBase64(new Uint8Array(await file.arrayBuffer()));
        paths.push(key);
      }
      resolve({ err: FS.NO_ERROR, data: paths });
    });
    input.addEventListener("cancel", () => resolve({ err: FS.NO_ERROR, data: [] }));
    input.click();
  });

  window.cep = {
    fs,
    encoding: { UTF8: "UTF-8", Base64: "Base64", convertion: {} },
    util: {
      openURLInDefaultBrowser(url) {
        window.open(String(url), "_blank", "noopener");
        return { err: FS.NO_ERROR };
      },
      registerExtensionUnloadCallback() {},
    },
  };

  const environment = () => ({
    appName: "PHXS",
    // Photoshop 2024: no switch to the UXP plugin is offered in the browser
    appVersion: "25.0.0",
    appLocale,
    appUILocale: appLocale,
    appId: "PHXS",
    isAppOnline: true,
    appSkinInfo: {
      baseFontFamily: "system-ui",
      baseFontSize: 12,
      appBarBackgroundColor: gray,
      panelBackgroundColor: gray,
      appBarBackgroundColorSRGB: gray,
      panelBackgroundColorSRGB: gray,
      systemHighlightColor: { red: 40, green: 142, blue: 223, alpha: 255 },
    },
  });

  let bundle = {};
  window.__adobe_cep__ = {
    getHostEnvironment: () => JSON.stringify(environment()),
    getCurrentApiVersion: () => JSON.stringify({ major: 11, minor: 0, micro: 0 }),
    getSystemPath: () => ROOT,
    getExtensionId: () => photoshop.extensionId,
    getHostCapabilities: () => JSON.stringify({ EXTENDED_PANEL_MENU: false, EXTENDED_PANEL_ICONS: false, DELEGATE_APE_ENGINE: false, SUPPORT_HTML_EXTENSIONS: true, DISABLE_FLASH_EXTENSIONS: true }),
    evalScript: (script, callback) => photoshop.evalScript(script, callback),
    addEventListener: (type, listener, obj) => photoshop.addPanelListener(type, listener, obj),
    removeEventListener: (type, listener) => photoshop.removePanelListener(type, listener),
    dispatchEvent() {},
    closeExtension() {},
    requestOpenExtension() {},
    getExtensions: () => "[]",
    getNetworkPreferences: () => "{}",
    initResourceBundle: () => JSON.stringify(bundle),
    dumpInstallationInfo: () => "",
    getScaleFactor: () => window.devicePixelRatio || 1,
    getMonitorScaleFactor: () => window.devicePixelRatio || 1,
    setScaleFactorChangedHandler() {},
    invokeSync: (name) => (name === "isWindowVisible" ? "true" : ""),
    invokeAsync() {},
    resizeContent() {},
    registerInvalidCertificateCallback() {},
    registerKeyEventsInterest() {},
    loadSnapshot() {},
  };

  // No installer in the browser: the update check answers "up to date"
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = String((input && input.url) || input);
    if (/api\.github\.com\/repos\/ScanR\/TypeR/i.test(url)) {
      return Promise.resolve(new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
    }
    return realFetch(input, init);
  };

  // Files the visitor imports stay in the browser: their "path" is a blob URL
  Object.defineProperty(File.prototype, "path", {
    configurable: true,
    get() {
      return photoshop.ops.registerFile(this);
    },
  });

  // The panel previews styles with local() fonts: here they are web fonts
  const webFonts = {};
  window.parent.TypeRFonts.BUILTIN.forEach((font) => {
    const url = `url("../../assets/fonts/${font.file}.woff2") format("woff2")`;
    webFonts[font.postScriptName] = url;
    webFonts[font.name] = url;
    webFonts[`${font.family} ${font.style}`] = url;
  });
  const LOCAL_FONT = /local\("([^"]+)"\)/g;
  const rewriteFontRules = (style) => {
    const text = style.textContent;
    if (!text || text.indexOf("local(") === -1) return;
    let changed = false;
    const next = text.replace(/src:([^;}]*)/g, (whole, list) => {
      let url = null;
      LOCAL_FONT.lastIndex = 0;
      let match = LOCAL_FONT.exec(list);
      while (match && !url) {
        const loaded = window.parent.TypeRFonts.urlOf(match[1]);
        url = webFonts[match[1]] || (loaded ? `url("${loaded}")` : null);
        match = LOCAL_FONT.exec(list);
      }
      if (!url) return whole;
      changed = true;
      return "src:" + url;
    });
    if (changed) style.textContent = next;
  };
  // Only the <style> elements a change touches are read again, not all of them at each
  // change of the panel: the panel's own rules are in its head, the previews' in its body
  const styleOf = (node) => {
    const element = node.nodeType === 1 ? node : node.parentNode;
    return element && element.nodeType === 1 ? element.closest("style") : null;
  };
  const rewriteTouchedRules = (mutations) => {
    const touched = new Set();
    mutations.forEach((mutation) => {
      const style = styleOf(mutation.target);
      if (style) touched.add(style);
      else if (mutation.type === "childList") {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType !== 1) return;
          if (node.nodeName === "STYLE") touched.add(node);
          else if (node.firstElementChild) node.querySelectorAll("style").forEach((inner) => touched.add(inner));
        });
      }
    });
    touched.forEach(rewriteFontRules);
  };
  // In the panel, and in the windows its parts are shown in (below)
  const watchFontRules = (doc = document) => {
    const scan = () => Array.prototype.forEach.call(doc.querySelectorAll("style"), rewriteFontRules);
    const observer = new MutationObserver(rewriteTouchedRules);
    observer.observe(doc.documentElement, { childList: true, subtree: true, characterData: true });
    // A kept font is read when it's first asked for: its rule waits for it
    const stopFonts = window.parent.TypeRFonts.onChange(scan);
    const stop = () => {
      observer.disconnect();
      stopFonts();
    };
    if (doc === document) window.addEventListener("pagehide", stop);
    scan();
    return stop;
  };

  // Help's illustrations are optional (the panel hides one that doesn't load) and none ship
  // yet: rather than asking for each and getting a 404, the image fails at once
  const HELP_MEDIA = /\/icons\/help\/[^/]+\.gif$/;
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (this.tagName === "IMG" && name === "src" && HELP_MEDIA.test(String(value))) {
      const image = this;
      setTimeout(() => image.dispatchEvent(new Event("error")), 0);
      return;
    }
    return setAttribute.call(this, name, value);
  };

  // In Photoshop the panel is its own window. Here a scrollIntoView would also
  // scroll the page around the iframe: keep it inside the panel.
  Element.prototype.scrollIntoView = function (options) {
    for (let box = this.parentElement; box; box = box.parentElement) {
      const overflow = getComputedStyle(box).overflowY;
      if ((overflow !== "auto" && overflow !== "scroll") || box.scrollHeight <= box.clientHeight) continue;
      const item = this.getBoundingClientRect();
      const room = box.getBoundingClientRect();
      const block = options && typeof options === "object" ? options.block : options === false ? "end" : "start";
      if (block === "center") box.scrollTop += item.top + item.height / 2 - (room.top + room.height / 2);
      else if (block === "end") box.scrollTop += item.bottom - room.bottom;
      else if (block === "nearest") {
        if (item.top < room.top) box.scrollTop += item.top - room.top;
        else if (item.bottom > room.bottom) box.scrollTop += item.bottom - room.bottom;
      } else box.scrollTop += item.top - room.top;
      return;
    }
  };

  // The panel writes its script a moment after the last key, up to five seconds later while
  // the typing goes on, and at once when its page closes. A page is also taken away without
  // closing (a phone that puts the browser aside, a tab the browser puts to sleep) or left for
  // another tab that keeps the same files. So the panel is told to write, as it is on closing,
  // whenever the app goes out of sight or loses the keyboard.
  const writeNow = () => window.dispatchEvent(new Event("beforeunload"));
  const writeWhenLeft = () => setTimeout(() => {
    if (!kit.inFront()) writeNow();
  }, 0);
  const host = window.parent;
  const writeWhenHidden = () => {
    if (host.document.visibilityState === "hidden") writeNow();
  };
  host.document.addEventListener("visibilitychange", writeWhenHidden);
  host.addEventListener("pagehide", writeNow);
  host.addEventListener("blur", writeWhenLeft);
  window.addEventListener("blur", writeWhenLeft);
  window.addEventListener("pagehide", () => {
    host.document.removeEventListener("visibilitychange", writeWhenHidden);
    host.removeEventListener("pagehide", writeNow);
    host.removeEventListener("blur", writeWhenLeft);
  });

  const syncKeyboard = () => shell.syncKeyboard();
  if (window.visualViewport) window.visualViewport.addEventListener("resize", syncKeyboard);
  ["focusin", "focusout"].forEach((name) => window.addEventListener(name, () => {
    [100, 350, 700].forEach((wait) => setTimeout(syncKeyboard, wait));
  }));

  // Reading the script on a touch screen: the whole row picks the line, its end pastes it.
  // The row's own buttons are the size of a mouse pointer.
  const pressSvg = (host) => {
    const icon = host && host.querySelector("svg");
    if (icon) icon.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  };
  document.addEventListener("click", (event) => {
    const root = document.documentElement;
    if (!root.classList.contains("t-touch") || root.classList.contains("t-writing")) return;
    const row = event.target.closest && event.target.closest(".text-line");
    if (!row || event.target.closest(".text-line-select svg, .text-line-insert svg")) return;
    pressSvg(event.clientX > row.getBoundingClientRect().right - 48 ? row.querySelector(".text-line-insert") : row.querySelector(".text-line-select"));
  });

  // iOS greys out every file whose extension it doesn't know, .psd included: on a touch screen
  // the panel's file pickers take anything, and the panel keeps what it can read (see touch.js)
  document.addEventListener("click", (event) => {
    const input = event.target;
    if (document.documentElement.classList.contains("t-touch") && input instanceof HTMLInputElement && input.type === "file") input.removeAttribute("accept");
  }, true);

  // The panel's Import pages button is a plain file input: its files can be read, not written
  // back, so Save always asked where. Where the browser has a real picker, the panel gets the
  // same files from it, each with the file on disk behind it, and Save writes over the PSD
  const PICKER_TYPES = { ".psd": "image/vnd.adobe.photoshop", ".psb": "image/vnd.adobe.photoshop", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
  document.addEventListener("click", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.type !== "file" || shell.touch || typeof window.showOpenFilePicker !== "function") return;
    const extensions = input.accept.split(",").map((item) => item.trim().toLowerCase());
    if (!extensions.includes(".psd") || !extensions.every((item) => PICKER_TYPES[item])) return;
    event.preventDefault();
    const accept = {};
    extensions.forEach((item) => (accept[PICKER_TYPES[item]] = accept[PICKER_TYPES[item]] || []).push(item));
    window.showOpenFilePicker({ multiple: input.multiple, types: [{ description: "Photoshop, PNG, JPEG", accept }] }).then(async (handles) => {
      const list = new DataTransfer();
      for (const handle of handles) {
        const file = await handle.getFile();
        photoshop.ops.rememberHandle(file, handle);
        list.items.add(file);
      }
      input.files = list.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, (error) => {
      if (error.name !== "AbortError") console.error(error);
    });
  }, true);

  // Import pages is the app's File > Open a Chapter…, in the panel: the same dialog, and the
  // chapter it opens is the one the pager, Page Down / Page Up and Flow go through, its first
  // page opened. The app then gives the pages to this button (pagesFromApp, below). The same
  // button, lit, unlinks them.
  let fromApp = false;
  document.addEventListener("change", (event) => {
    const input = event.target;
    if (!fromApp && input instanceof HTMLInputElement && input.dataset.tour === "import-pages-input" && window.parent.TypeRApp) window.parent.TypeRApp.setPages(input.files, true);
  }, true);
  document.addEventListener("click", (event) => {
    const button = event.target.closest && event.target.closest('[data-tour="import-pages"]');
    const app = window.parent.TypeRApp;
    if (fromApp || !button || !app) return;
    if (button.classList.contains("is-active")) {
      app.setPages(null, true);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    app.openPages();
  }, true);
  // The walkthrough offered by the panel's Help is Photoshop's: here the app's own tutorial
  // (guide.js) takes its place, the Help closing behind it
  document.addEventListener("click", (event) => {
    const guide = window.parent.TypeRGuide;
    const button = event.target.closest && event.target.closest(".help-actions .help-action");
    if (!guide || window.parent.TypeRShell.touch || !button || button !== button.parentNode.querySelector(".help-action")) return;
    event.preventDefault();
    event.stopPropagation();
    const modal = button.closest(".app-modal");
    const close = modal && modal.querySelector(".topcoat-icon-button--large--quiet");
    if (close) close.click();
    guide.show();
  }, true);
  // The panel keeps its pages script by script, and the app has one chapter: the script that
  // comes in front (another tab, a new one) is linked to the chapter's pages too
  let scriptInFront = null;
  new MutationObserver(() => {
    const tab = document.querySelector(".tab-bar-tab.m-active");
    const id = tab ? tab.getAttribute("data-tour-tab") : null;
    if (!id || id === scriptInFront) return;
    const first = scriptInFront === null;
    scriptInFront = id;
    if (!first && window.parent.TypeRApp) window.parent.TypeRApp.linkPages();
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  const pagesFromApp = {
    // Made again in this window: the panel reads each file's path, which only this window's files have
    importPages(files) {
      const input = document.querySelector('[data-tour="import-pages-input"]');
      if (!input) return;
      const list = new DataTransfer();
      files.forEach((file) => list.items.add(new File([file], file.name, { type: file.type, lastModified: file.lastModified })));
      fromApp = true;
      try {
        input.files = list.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      } finally {
        fromApp = false;
      }
    },
    unlinkPages() {
      const button = document.querySelector('[data-tour="import-pages"].is-active');
      if (!button) return;
      fromApp = true;
      try {
        button.click();
      } finally {
        fromApp = false;
      }
    },
  };

  // Keys for TypeR's shortcut poll, read in the page and in the panel
  const track = (event) => {
    photoshop.setKeys({ meta: event.metaKey, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, key: event.type === "keydown" ? photoshop.keyName(event) : "" });
    if (window.parent.TypeRApp) window.parent.TypeRApp.showSampling(event);
  };
  window.addEventListener("keydown", track, true);
  // The keys that stand for the mouse's buttons click in the panel too (keyclick.js)
  if (window.parent.TypeRKeyClick) window.parent.TypeRKeyClick.watch(window);
  window.addEventListener("keydown", (event) => {
    if (window.parent.TypeRApp) window.parent.TypeRApp.handleKey(event, true);
  });
  window.addEventListener("keyup", track, true);
  window.addEventListener("blur", () => photoshop.clearKeys());
  if (window.parent.TypeRApp) window.parent.TypeRApp.watchChoices(document);

  /* ---------------- the panel's parts in panels of their own ---------------- */

  // The Window menu opens the script, the styles, TextShapeR or the Paste and Center buttons as
  // panels of their own (workspace.js), each a frame of the app with an empty page. The page
  // gets the panel's stylesheets, theme and keys here, and the panel draws its part in it
  // (panelParts.js in TypeR): still one panel, with one state. Closed, the part comes back.
  const shownParts = {};
  const PART_CSS = "html, body { height: 100%; margin: 0; overflow: hidden; } #app { height: 100%; }";
  const STYLESHEETS = 'style, link[rel="stylesheet"]';

  const copyAttributes = (from, to) => {
    Array.from(to.attributes).forEach((attribute) => {
      if (!from.hasAttribute(attribute.name)) to.removeAttribute(attribute.name);
    });
    Array.from(from.attributes).forEach((attribute) => {
      if (to.getAttribute(attribute.name) !== attribute.value) to.setAttribute(attribute.name, attribute.value);
    });
  };

  // The panel's stylesheets in the part's page, in their order, and its theme (the classes and
  // variables of its <html> and <body>), again whenever they change. A sheet already there
  // stays put: moved, a <link> would load again.
  // The panel's theme is written rule by rule into a <style> (TypeR's themeManager.js), not
  // as its text: a sheet is read from its rules
  const sheetText = (node) => {
    try {
      if (node.sheet) return Array.prototype.map.call(node.sheet.cssRules, (rule) => rule.cssText).join("\n");
    } catch (error) {
      // Not readable: its text
    }
    return node.textContent;
  };
  const cloneSheet = (doc, node, text) => {
    if (node.nodeName !== "STYLE") return doc.importNode(node, true);
    const clone = doc.createElement("style");
    Array.from(node.attributes).forEach((attribute) => clone.setAttribute(attribute.name, attribute.value));
    clone.textContent = text;
    return clone;
  };
  const mirrorStyles = (doc, own) => {
    const clones = new Map();
    const sync = () => {
      const wanted = [];
      document.head.querySelectorAll(STYLESHEETS).forEach((node) => {
        const text = node.nodeName === "STYLE" ? sheetText(node) : "";
        const sign = node.nodeName === "STYLE" ? `s${text}` : `l${node.href}|${node.media}|${node.disabled}`;
        let entry = clones.get(node);
        if (!entry || entry.sign !== sign) {
          if (entry) entry.clone.remove();
          entry = { sign, clone: cloneSheet(doc, node, text) };
          clones.set(node, entry);
        }
        wanted.push(entry.clone);
      });
      clones.forEach((entry, node) => {
        if (wanted.includes(entry.clone)) return;
        entry.clone.remove();
        clones.delete(node);
      });
      let next = own;
      for (let index = wanted.length - 1; index >= 0; index--) {
        if (wanted[index].nextSibling !== next || wanted[index].parentNode !== doc.head) doc.head.insertBefore(wanted[index], next);
        next = wanted[index];
      }
      copyAttributes(document.documentElement, doc.documentElement);
      copyAttributes(document.body, doc.body);
    };
    const observer = new MutationObserver(sync);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true, attributes: true });
    observer.observe(document.documentElement, { attributes: true });
    observer.observe(document.body, { attributes: true });
    // Rules added that way change no element: read again when the panel may have changed them
    // (it starts, its theme comes), and whenever the pointer comes into the part
    const timers = [0, 500, 2000].map((wait) => setTimeout(sync, wait));
    doc.documentElement.addEventListener("mouseenter", sync);
    sync();
    return () => {
      observer.disconnect();
      timers.forEach(clearTimeout);
      doc.documentElement.removeEventListener("mouseenter", sync);
      clones.forEach((entry) => entry.clone.remove());
    };
  };

  // The part's page as the panel's own: its sheets, its fonts, its keys
  const setUpPart = (doc) => {
    const win = doc.defaultView;
    const base = doc.querySelector("base") || doc.head.insertBefore(doc.createElement("base"), doc.head.firstChild);
    base.href = document.baseURI;
    const own = doc.getElementById("typer-part-css") || doc.head.appendChild(doc.createElement("style"));
    own.id = "typer-part-css";
    own.textContent = PART_CSS;
    const stopStyles = mirrorStyles(doc, own);
    const stopFonts = watchFontRules(doc);
    const handleKey = (event) => {
      if (window.parent && window.parent.TypeRApp) window.parent.TypeRApp.handleKey(event, true);
    };
    const clearKeys = () => photoshop.clearKeys();
    win.addEventListener("keydown", track, true);
    win.addEventListener("keyup", track, true);
    win.addEventListener("keydown", handleKey);
    win.addEventListener("blur", clearKeys);
    // Listeners of the app's own, kept for the page's life (the mouse's keys are keyclick.js's)
    if (!doc.__typerChoices && window.parent.TypeRApp) {
      doc.__typerChoices = true;
      window.parent.TypeRApp.watchChoices(doc);
    }
    return () => {
      stopStyles();
      stopFonts();
      win.removeEventListener("keydown", track, true);
      win.removeEventListener("keyup", track, true);
      win.removeEventListener("keydown", handleKey);
      win.removeEventListener("blur", clearKeys);
    };
  };

  const showPart = (part, frame) => {
    const entry = { frame, stop: null };
    const ready = () => {
      if (shownParts[part] !== entry || entry.stop) return;
      const doc = frame.contentDocument;
      const host = doc && doc.getElementById("app");
      if (!host) return;
      frame.removeEventListener("load", ready);
      entry.stop = setUpPart(doc);
      window.__typerParts.attach(part, host);
    };
    entry.cancel = () => frame.removeEventListener("load", ready);
    shownParts[part] = entry;
    frame.addEventListener("load", ready);
    ready();
  };

  const hidePart = (part) => {
    const entry = shownParts[part];
    delete shownParts[part];
    entry.cancel();
    window.__typerParts.release(part);
    if (entry.stop) entry.stop();
  };

  // The parts the workspace has open, once the panel can draw them
  const syncParts = () => {
    const parts = window.__typerParts;
    const Workspace = window.parent && window.parent.TypeRWorkspace;
    if (!parts || !Workspace || !Workspace.typerParts) return;
    const open = Workspace.typerParts();
    parts.parts.forEach((part) => {
      const frame = open.includes(part) ? Workspace.typerPartFrame(part) : null;
      const entry = shownParts[part];
      if (entry && entry.frame !== frame) hidePart(part);
      if (frame && !shownParts[part]) showPart(part, frame);
    });
  };
  // The panel's own button on each part opens it apart, where it stood
  const offerDetach = () => {
    const parts = window.__typerParts;
    const app = window.parent;
    if (!parts || !parts.setDetacher || !app.TypeRWorkspace || !app.TypeRWorkspace.openTypeRPart || app.TypeRShell.touch) return;
    parts.setDetacher({
      label: app.TypeRApp ? app.TypeRApp.T("Detach") : "Detach",
      detach: (part, rect) => {
        const frame = window.frameElement;
        const box = frame ? frame.getBoundingClientRect() : { left: 0, top: 0 };
        const zoom = parseFloat(document.documentElement.style.zoom) || 1;
        app.TypeRWorkspace.openTypeRPart(part, rect && { x: box.left + rect.x * zoom, y: box.top + rect.y * zoom, w: rect.w * zoom, h: rect.h * zoom });
      },
    });
  };
  // One of the panel's windows open: the panel stays in sight for it (workspace.js)
  let dialogShown = false;
  const followModal = () => {
    const open = document.body.classList.contains("typer-modal-open");
    if (open === dialogShown) return;
    dialogShown = open;
    const Workspace = window.parent && window.parent.TypeRWorkspace;
    if (Workspace && Workspace.typerDialog) Workspace.typerDialog(open);
  };
  new MutationObserver(followModal).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  window.addEventListener("typer-parts-ready", offerDetach);
  window.addEventListener("typer-parts-ready", syncParts);
  const stopParts = photoshop.on((type) => {
    if (type === "workspace") syncParts();
  });
  // The panel starts again (a new theme): what it drew in the parts' pages goes with it
  window.addEventListener("pagehide", () => {
    stopParts();
    if (dialogShown && window.parent && window.parent.TypeRWorkspace) window.parent.TypeRWorkspace.typerDialog(false);
    Object.keys(shownParts).forEach((part) => {
      const entry = shownParts[part];
      entry.cancel();
      if (entry.stop) entry.stop();
      const doc = entry.frame.contentDocument;
      const host = doc && doc.getElementById("app");
      if (host) host.textContent = "";
    });
  });
  // The panel's element, wherever its part is shown (TypeR Studio presses the panel's buttons)
  const queryPanel = (selector) => {
    const here = document.querySelector(selector);
    if (here) return here;
    for (const part of Object.keys(shownParts)) {
      const doc = shownParts[part].frame.contentDocument;
      const found = doc && doc.querySelector(selector);
      if (found) return found;
    }
    return null;
  };

  const load = (url) => fetch(url).then((response) => (response.ok ? response.text() : "")).catch(() => "");

  // FontScanR reads the list of fonts once, when it opens, but the browser only learns
  // about the computer's fonts one by one, during the scan: it would call them missing.
  // The rows added are marked, once per frame, and all of them again when the fonts change
  const markFound = (item) => {
    const preview = item.querySelector(".fsr-item-preview");
    if (!preview) return;
    const state = window.parent.TypeRFonts.isMissing(preview.title) ? "missing" : "found";
    if (item.dataset.font !== state) item.dataset.font = state;
  };
  const fsrAdded = new Set();
  let fsrAll = false;
  let fsrFrame = 0;
  const markFsrItems = () => {
    fsrFrame = 0;
    const all = fsrAll;
    const added = Array.from(fsrAdded);
    fsrAll = false;
    fsrAdded.clear();
    if (all) {
      document.querySelectorAll(".fsr-item").forEach(markFound);
      return;
    }
    added.forEach((node) => {
      if (!node.isConnected) return;
      const item = node.closest(".fsr-item");
      if (item) markFound(item);
      else if (node.firstElementChild) node.querySelectorAll(".fsr-item").forEach(markFound);
    });
  };
  const markFsrSoon = () => {
    if (!fsrFrame) fsrFrame = window.requestAnimationFrame(markFsrItems);
  };
  new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        const element = node.nodeType === 1 ? node : node.parentElement;
        if (element) fsrAdded.add(element);
      });
    });
    if (fsrAdded.size) markFsrSoon();
  }).observe(document.documentElement, { childList: true, subtree: true });
  const stopMarking = window.parent.TypeRFonts.onChange(() => {
    fsrAll = true;
    markFsrSoon();
  });
  window.addEventListener("pagehide", stopMarking);

  // Sentences that say something else here than in Photoshop: there are no profiles
  const loadWebText = () => fetch("../panel-locale/web-text.json").then((response) => response.json()).catch(() => ({}));
  // Sections hidden here (see panel/index.html): the profiles; the language, which is the
  // app's own (?lang=); and the updates, since the web version is always the latest.
  // Without their titles, the settings search doesn't offer them either
  const HIDDEN_TITLES = ["profilesTitle", "profilesManageTitle", "profilesCreateTitle", "settingsLanguageLabel", "settingsCheckUpdatesLabel", "settingsAutoUpdateLabel", "settingsCheckUpdatesButton"];
  const withoutHiddenTitles = (text) => text.replace(new RegExp(`^(${HIDDEN_TITLES.join("|")})=.*$`, "gm"), "");

  // Under fingers a click is a tap, and the Magic Wand is already in hand: the paste mode says
  // so, in the app's own words (touch.js)
  const touchText = () => {
    if (!shell.touch) return {};
    const T = window.parent.TypeRApp.T;
    const tap = T("Paste on tap");
    return { settingsPasteOnClickLabel: tap, footerPasteOnClick: tap, settingsPasteOnClickHelp: T("A tap on a bubble now pastes the line."), footerPasteOnClickTitle: T("A tap on a bubble now pastes the line."), pasteOnClickEnabled: T("A tap on a bubble now pastes the line."), pasteOnClickDisabled: T("A tap on a bubble now only selects it.") };
  };

  Promise.all([
    load("locale/messages.properties"),
    appLocale === "en_US" ? "" : load(EXTRA_LOCALES.includes(appLocale) ? `../panel-locale/${appLocale}/messages.properties` : `locale/${appLocale}/messages.properties`),
    loadWebText(),
  ]).then(([fullBase, fullLocal, webText]) => {
    const base = withoutHiddenTitles(fullBase);
    const local = withoutHiddenTitles(fullLocal);
    files[ROOT + "/locale/messages.properties"] = base;
    if (local) files[`${ROOT}/locale/${appLocale}/messages.properties`] = local;
    bundle = Object.assign({}, parseProperties(base), webText.en_US, parseProperties(local), webText[appLocale], touchText());
    watchFontRules();
    const script = document.createElement("script");
    script.src = "modern.index.js";
    document.body.appendChild(script);
  });

  window.__typerWeb = {
    importPages: pagesFromApp.importPages,
    unlinkPages: pagesFromApp.unlinkPages,
    getFile: (path) => files[path],
    query: queryPanel,
    // The panel's words in its language, for what the app shows of it (its menu, its modes)
    text: (key) => (typeof bundle[key] === "string" ? bundle[key] : ""),
    setFile: (path, value) => { files[path] = value; },
  };
  // The panel's button to the other app (TypeR's openInStudio.js): here, the app's own Open in
  // Photoshop, only in the desktop app, which can reach Photoshop
  const parentApp = window.parent;
  if (parentApp.TypeRDesktop && parentApp.TypeRDesktop.photoshop && parentApp.TypeRApp && parentApp.TypeRApp.openInPhotoshop) {
    window.__typerWeb.openInPhotoshop = () => { parentApp.TypeRApp.openInPhotoshop(); };
  }
})();
