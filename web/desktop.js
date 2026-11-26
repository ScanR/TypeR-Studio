// What changes when this page runs in TypeR Studio, the desktop app. Only that app loads this
// file. It lives with the page so that both change together when an update arrives.

(function () {
  "use strict";

  const Desktop = window.TypeRDesktop;
  if (!Desktop) return;

  document.documentElement.classList.add("desktop", `desktop--${Desktop.platform}`);
  try {
    // A window is a window, whatever the screen: the touch interface stays for tablets, and the
    // beta notice talks about the web version
    window.localStorage.setItem("typer.web.interface", "desktop");
    window.localStorage.setItem("typer.web.betaNotice", "1");
  } catch (error) {
    console.warn("TypeR Studio: no storage", error);
  }

  /* --------------------------- a file opened from the system --------------------------- */

  // The app drops it on the window: taken here, it opens as a new page wherever it lands
  const entriesOf = async (transfer) => {
    const found = Array.from(transfer.items).filter((item) => item.kind === "file").map((item) => ({
      file: item.getAsFile(),
      asked: item.getAsFileSystemHandle().catch(() => null),
    }));
    const entries = [];
    for (const { file, asked } of found) {
      const handle = await asked;
      entries.push({ file, handle: handle && handle.kind === "file" ? handle : null });
    }
    return entries;
  };
  window.addEventListener("dragover", (event) => {
    if (!window.TypeRDesktopOpening) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  window.addEventListener("dragenter", (event) => {
    if (window.TypeRDesktopOpening) event.stopImmediatePropagation();
  }, true);
  window.addEventListener("drop", async (event) => {
    if (!window.TypeRDesktopOpening) return;
    window.TypeRDesktopOpening = false;
    event.preventDefault();
    event.stopImmediatePropagation();
    const entries = await entriesOf(event.dataTransfer);
    if (entries.length) window.TypeRApp.openFiles(entries);
  }, true);

  /* ------------------------- starting from TypeR for Photoshop ------------------------- */

  // Only the app says this, so its words live here rather than in strings/
  const WORDS = {
    fr: ["Reprendre vos réglages TypeR de Photoshop ?", "TypeR pour Photoshop est installé sur cet ordinateur. TypeR Studio peut démarrer avec les mêmes styles, dossiers, réglages et raccourcis. Le plugin garde sa propre copie.", "Styles trouvés : {count}", "Les reprendre", "Partir de zéro", "Vos réglages TypeR de Photoshop sont là."],
    es: ["¿Traer tus ajustes de TypeR desde Photoshop?", "TypeR para Photoshop está instalado en este ordenador. TypeR Studio puede empezar con los mismos estilos, carpetas, ajustes y atajos. El plugin conserva su propia copia.", "Estilos encontrados: {count}", "Traerlos", "Empezar de cero", "Tus ajustes de TypeR de Photoshop ya están aquí."],
    it: ["Riprendere le impostazioni di TypeR da Photoshop?", "TypeR per Photoshop è installato su questo computer. TypeR Studio può partire con gli stessi stili, cartelle, impostazioni e scorciatoie. Il plugin conserva la sua copia.", "Stili trovati: {count}", "Riprendile", "Parti da zero", "Le tue impostazioni di TypeR da Photoshop sono qui."],
    de: ["Ihre TypeR-Einstellungen aus Photoshop übernehmen?", "TypeR für Photoshop ist auf diesem Computer installiert. TypeR Studio kann mit denselben Stilen, Ordnern, Einstellungen und Tastenkürzeln starten. Das Plugin behält seine eigene Kopie.", "Gefundene Stile: {count}", "Übernehmen", "Neu beginnen", "Ihre TypeR-Einstellungen aus Photoshop sind da."],
    pt: ["Trazer suas configurações do TypeR do Photoshop?", "O TypeR para Photoshop está instalado neste computador. O TypeR Studio pode começar com os mesmos estilos, pastas, configurações e atalhos. O plugin mantém sua própria cópia.", "Estilos encontrados: {count}", "Trazer", "Começar do zero", "Suas configurações do TypeR do Photoshop estão aqui."],
    ru: ["Перенести настройки TypeR из Photoshop?", "На этом компьютере установлен TypeR для Photoshop. TypeR Studio может начать с теми же стилями, папками, настройками и сочетаниями клавиш. У плагина останется своя копия.", "Найдено стилей: {count}", "Перенести", "Начать с нуля", "Ваши настройки TypeR из Photoshop на месте."],
    uk: ["Перенести налаштування TypeR із Photoshop?", "На цьому комп’ютері встановлено TypeR для Photoshop. TypeR Studio може почати з тими самими стилями, теками, налаштуваннями та сполученнями клавіш. Плагін збереже свою копію.", "Знайдено стилів: {count}", "Перенести", "Почати з нуля", "Ваші налаштування TypeR із Photoshop на місці."],
    pl: ["Przenieść ustawienia TypeR z Photoshopa?", "Na tym komputerze jest zainstalowany TypeR dla Photoshopa. TypeR Studio może zacząć z tymi samymi stylami, folderami, ustawieniami i skrótami. Wtyczka zachowa własną kopię.", "Znalezione style: {count}", "Przenieś", "Zacznij od zera", "Twoje ustawienia TypeR z Photoshopa są już tutaj."],
    nl: ["Je TypeR-instellingen uit Photoshop overnemen?", "TypeR voor Photoshop staat op deze computer. TypeR Studio kan beginnen met dezelfde stijlen, mappen, instellingen en sneltoetsen. De plug-in houdt zijn eigen kopie.", "Gevonden stijlen: {count}", "Overnemen", "Opnieuw beginnen", "Je TypeR-instellingen uit Photoshop staan klaar."],
    tr: ["TypeR ayarlarınız Photoshop'tan alınsın mı?", "Bu bilgisayarda Photoshop için TypeR kurulu. TypeR Studio aynı stiller, klasörler, ayarlar ve kısayollarla başlayabilir. Eklenti kendi kopyasını korur.", "Bulunan stiller: {count}", "Al", "Sıfırdan başla", "Photoshop'taki TypeR ayarlarınız burada."],
    ar: ["هل تريد نقل إعدادات TypeR من Photoshop؟", "TypeR لـ Photoshop مثبّت على هذا الحاسوب. يمكن لـ TypeR Studio أن يبدأ بالأنماط والمجلدات والإعدادات والاختصارات نفسها. تحتفظ الإضافة بنسختها الخاصة.", "الأنماط الموجودة: {count}", "انقلها", "ابدأ من جديد", "إعدادات TypeR من Photoshop أصبحت هنا."],
    vi: ["Chuyển cài đặt TypeR từ Photoshop sang?", "Máy tính này đã cài TypeR cho Photoshop. TypeR Studio có thể bắt đầu với cùng các kiểu chữ, thư mục, cài đặt và phím tắt. Plugin vẫn giữ bản riêng của nó.", "Số kiểu chữ tìm thấy: {count}", "Chuyển sang", "Bắt đầu từ đầu", "Cài đặt TypeR từ Photoshop của bạn đã có ở đây."],
    id: ["Bawa pengaturan TypeR dari Photoshop?", "TypeR untuk Photoshop terpasang di komputer ini. TypeR Studio bisa dimulai dengan gaya, folder, pengaturan, dan pintasan yang sama. Plugin tetap menyimpan salinannya sendiri.", "Gaya yang ditemukan: {count}", "Bawa", "Mulai dari awal", "Pengaturan TypeR dari Photoshop sudah ada di sini."],
    th: ["นำการตั้งค่า TypeR จาก Photoshop มาใช้ไหม", "คอมพิวเตอร์เครื่องนี้ติดตั้ง TypeR สำหรับ Photoshop ไว้ TypeR Studio เริ่มต้นด้วยสไตล์ โฟลเดอร์ การตั้งค่า และคีย์ลัดเดียวกันได้ ปลั๊กอินยังเก็บสำเนาของตัวเองไว้", "สไตล์ที่พบ: {count}", "นำมาใช้", "เริ่มใหม่", "การตั้งค่า TypeR จาก Photoshop อยู่ที่นี่แล้ว"],
    ja: ["Photoshop の TypeR の設定を引き継ぎますか？", "このコンピューターには Photoshop 用 TypeR がインストールされています。TypeR Studio は同じスタイル、フォルダー、設定、ショートカットで始められます。プラグイン側の設定はそのまま残ります。", "見つかったスタイル：{count}", "引き継ぐ", "新しく始める", "Photoshop の TypeR の設定を引き継ぎました。"],
    ko: ["Photoshop의 TypeR 설정을 가져올까요?", "이 컴퓨터에 Photoshop용 TypeR가 설치되어 있습니다. TypeR Studio는 같은 스타일, 폴더, 설정, 단축키로 시작할 수 있습니다. 플러그인은 자체 사본을 그대로 유지합니다.", "찾은 스타일: {count}", "가져오기", "새로 시작", "Photoshop의 TypeR 설정을 가져왔습니다."],
    zh: ["要沿用 Photoshop 中 TypeR 的设置吗？", "这台电脑上装有 Photoshop 版 TypeR。TypeR Studio 可以使用相同的样式、文件夹、设置和快捷键开始。插件会保留自己的那一份。", "找到的样式：{count}", "沿用", "从头开始", "Photoshop 中 TypeR 的设置已经带过来了。"],
  };
  const ENGLISH = ["Bring your TypeR settings over from Photoshop?", "TypeR for Photoshop is installed on this computer. TypeR Studio can start with the same styles, folders, settings and shortcuts. The plugin keeps its own copy.", "Styles found: {count}", "Bring them over", "Start fresh", "Your TypeR settings from Photoshop are here."];
  const words = () => WORDS[window.TYPER_I18N && window.TYPER_I18N.lang] || ENGLISH;

  // What only the plugin needs: its update checks, its own log, a background image left behind
  const PLUGIN_ONLY = ["language", "checkUpdates", "autoUpdate", "lastUpdateCheckAt", "backgroundImage", "mcpOperations", "mcpProgress"];
  const STORAGE_FILE = /^storage(_profile_.+)?$/;
  const OFFERED = "typer.studio.photoshopOffered";

  const styleCount = (text) => {
    try {
      const styles = JSON.parse(text).styles;
      return Array.isArray(styles) ? styles.length : 0;
    } catch (error) {
      return 0;
    }
  };

  // Someone who already made styles here keeps them: the question at start doesn't come then.
  // The setup assistant still offers them, saying what they replace.
  const hasOwnStyles = () => {
    const Kit = window.TypeRKit;
    return Kit.storedPaths().some((file) => Kit.keeps(file) && styleCount(Kit.read(file)) > 0);
  };

  // TypeR for Photoshop's files, made ready for here: { files, styles, replaces }, or null
  // without them. `overOwn` finds them even when there are styles here already.
  const findPhotoshopSettings = async ({ overOwn = false } = {}) => {
    const replaces = hasOwnStyles();
    if (!Desktop.findPhotoshopSettings || (replaces && !overOwn)) return null;
    const Kit = window.TypeRKit;
    const found = await Desktop.findPhotoshopSettings();
    if (!found || !found.files) return null;
    const files = {};
    let styles = 0;
    Object.keys(found.files).forEach((name) => {
      try {
        const value = JSON.parse(found.files[name]);
        if (STORAGE_FILE.test(name)) {
          PLUGIN_ONLY.forEach((key) => { delete value[key]; });
          Object.assign(value, { checkUpdates: false, autoUpdate: false, textShapeRPerformanceTipShown: true });
          // As for anyone starting here (Kit.freshStorage): no tour of what 3.0 changed in Photoshop
          if (!(parseFloat(value.whatsNewSeen) >= 3)) value.whatsNewSeen = "3.0";
          if (value.editorTheme === "custom-image") value.editorTheme = "system";
          // A script's pages are files on the disk, which the page can't open by their path:
          // the script stays, its pages are loaded again here
          if (Array.isArray(value.tabs)) value.tabs.forEach((tab) => {
            if (!tab || typeof tab !== "object") return;
            // A name taken from the pages' folder stays
            if (Array.isArray(tab.images) && tab.images.length) tab.autoName = false;
            tab.images = [];
            tab.lastOpenedImagePath = null;
          });
          if (Array.isArray(value.styles)) styles += value.styles.length;
        }
        files[`${Kit.ROOT}/${name}`] = JSON.stringify(value);
      } catch (error) {
        console.warn("TypeR Studio: a file of TypeR for Photoshop can't be read", name, error);
      }
    });
    return Object.keys(files).length ? { files, styles, replaces } : null;
  };

  // The panel isn't running: its files are replaced whole, profiles included
  const takePhotoshopSettings = async ({ files }) => {
    const Kit = window.TypeRKit;
    try {
      window.localStorage.setItem(OFFERED, "taken");
    } catch (error) {
      console.warn("TypeR Studio: no storage", error);
    }
    await Promise.all(Kit.storedPaths().filter((file) => Kit.keeps(file) && !files[file]).map((file) => Kit.forget(file)));
    const kept = await Promise.all(Object.keys(files).map((file) => Kit.keep(file, files[file])));
    if (kept.every(Boolean)) window.TypeRApp.toast(words()[5]);
  };

  // Asked once, on a first start, when the setup assistant (onboarding.js) didn't ask it
  const offerPhotoshopSettings = async () => {
    const App = window.TypeRApp;
    try {
      if (window.localStorage.getItem(OFFERED)) return;
    } catch (error) {
      return;
    }
    const found = await findPhotoshopSettings();
    if (!found) return;
    const [title, text, count, yes, no] = words();
    const body = document.createElement("div");
    body.style.display = "grid";
    body.style.gap = "8px";
    [text, found.styles ? App.fill(count, { count: found.styles }) : null].filter(Boolean).forEach((line) => {
      const p = document.createElement("p");
      p.textContent = line;
      body.appendChild(p);
    });
    const answer = await App.dialog({ title, body, ok: yes, cancel: no });
    if (answer) await takePhotoshopSettings(found);
    else {
      try {
        window.localStorage.setItem(OFFERED, "declined");
      } catch (error) {
        console.warn("TypeR Studio: no storage", error);
      }
    }
  };
  window.TypeRStudio = { beforePanel: offerPhotoshopSettings, findPhotoshopSettings, takePhotoshopSettings, OFFERED };

  /* --------------------------------- an update is ready -------------------------------- */

  // A new version was downloaded while the app is open: it's there at the next launch, or now
  // with Restart. Pages kept by the session come back; the others are asked about as the window
  // closes, as for any closing.
  const UPDATE_WORDS = {
    fr: ["Mise à jour installée. Redémarrer TypeR Studio ?", "Redémarrer", "Plus tard"],
    es: ["Actualización instalada. ¿Reiniciar TypeR Studio?", "Reiniciar", "Más tarde"],
    it: ["Aggiornamento installato. Riavviare TypeR Studio?", "Riavvia", "Più tardi"],
    de: ["Update installiert. TypeR Studio neu starten?", "Neu starten", "Später"],
    pt: ["Atualização instalada. Reiniciar o TypeR Studio?", "Reiniciar", "Mais tarde"],
    ru: ["Обновление установлено. Перезапустить TypeR Studio?", "Перезапустить", "Позже"],
    uk: ["Оновлення встановлено. Перезапустити TypeR Studio?", "Перезапустити", "Пізніше"],
    pl: ["Aktualizacja zainstalowana. Uruchomić ponownie TypeR Studio?", "Uruchom ponownie", "Później"],
    nl: ["Update geïnstalleerd. TypeR Studio opnieuw starten?", "Opnieuw starten", "Later"],
    tr: ["Güncelleme yüklendi. TypeR Studio yeniden başlatılsın mı?", "Yeniden başlat", "Sonra"],
    ar: ["تم تثبيت التحديث. هل تريد إعادة تشغيل TypeR Studio؟", "إعادة التشغيل", "لاحقًا"],
    vi: ["Đã cài bản cập nhật. Khởi động lại TypeR Studio?", "Khởi động lại", "Để sau"],
    id: ["Pembaruan terpasang. Mulai ulang TypeR Studio?", "Mulai ulang", "Nanti"],
    th: ["ติดตั้งอัปเดตแล้ว รีสตาร์ท TypeR Studio ไหม", "รีสตาร์ท", "ไว้ทีหลัง"],
    ja: ["アップデートをインストールしました。TypeR Studio を再起動しますか？", "再起動", "あとで"],
    ko: ["업데이트가 설치되었습니다. TypeR Studio를 다시 시작할까요?", "다시 시작", "나중에"],
    zh: ["更新已安装。要重新启动 TypeR Studio 吗？", "重新启动", "稍后"],
  };
  const UPDATE_ENGLISH = ["Update installed. Restart TypeR Studio?", "Restart", "Later"];

  const showUpdateNote = () => {
    putBehindAway();
    const shown = document.getElementById("update-note");
    if (shown && !shown.classList.contains("update-note--downloading")) return;
    if (shown) shown.remove();
    const lang = window.TYPER_I18N && window.TYPER_I18N.lang;
    const [text, restart, later] = UPDATE_WORDS[lang] || UPDATE_ENGLISH;
    const note = document.createElement("div");
    note.id = "update-note";
    note.className = "update-note";
    note.setAttribute("role", "status");
    if (lang === "ar") note.dir = "rtl";
    const label = document.createElement("span");
    label.className = "update-note__text";
    label.textContent = text;
    const now = document.createElement("button");
    now.type = "button";
    now.className = "btn btn--small btn--main";
    now.textContent = restart;
    now.addEventListener("click", () => Desktop.reloadForUpdate());
    const notNow = document.createElement("button");
    notNow.type = "button";
    notNow.className = "btn btn--small";
    notNow.textContent = later;
    notNow.addEventListener("click", () => note.remove());
    note.append(label, now, notNow);
    document.body.appendChild(note);
  };

  // A new version of the app itself is a long download: the same note shows how far it has gone,
  // then offers to restart. Put away, it stays away until the download is done.
  let progressPutAway = false;
  const showUpdateProgress = (percent) => {
    const App = window.TypeRApp;
    updateSeen = true;
    putBehindAway();
    let note = document.getElementById("update-note");
    if (note && !note.classList.contains("update-note--downloading")) return;
    if (!note) {
      if (progressPutAway) return;
      const lang = window.TYPER_I18N && window.TYPER_I18N.lang;
      note = document.createElement("div");
      note.id = "update-note";
      note.className = "update-note update-note--downloading";
      note.setAttribute("role", "status");
      if (lang === "ar") note.dir = "rtl";
      const label = document.createElement("span");
      label.className = "update-note__text";
      label.textContent = App.T("Downloading the update…");
      const bar = document.createElement("progress");
      bar.className = "update-note__bar";
      bar.max = 100;
      bar.setAttribute("aria-label", label.textContent);
      const amount = document.createElement("span");
      amount.className = "update-note__amount";
      const hide = document.createElement("button");
      hide.type = "button";
      hide.className = "btn btn--small";
      hide.textContent = App.T("Hide");
      hide.addEventListener("click", () => {
        progressPutAway = true;
        note.remove();
      });
      note.append(label, bar, amount, hide);
      document.body.appendChild(note);
    }
    const lang = window.TYPER_I18N && window.TYPER_I18N.lang;
    note.querySelector(".update-note__bar").value = percent;
    let said;
    try {
      said = new Intl.NumberFormat(lang || undefined, { style: "percent" }).format(percent / 100);
    } catch (error) {
      said = `${percent} %`;
    }
    note.querySelector(".update-note__amount").textContent = said;
  };

  // Help > Check for Updates…: what's found downloads, then the note above offers to restart.
  // Up to date, or no connection, is said in a toast.
  let checkingUpdates = false;
  const checkForUpdates = async () => {
    const App = window.TypeRApp;
    if (checkingUpdates || !Desktop.checkForUpdates) return;
    checkingUpdates = true;
    App.toast(App.T("Checking for updates…"));
    try {
      // The note shows the download where the app tells how far it has gone
      const result = await Desktop.checkForUpdates(() => {
        if (Desktop.onUpdateProgress) {
          progressPutAway = false;
          showUpdateProgress(0);
        } else App.toast(App.T("Downloading the update…"), true);
      });
      // The app couldn't update itself while a newer one is out: the note offers it to download
      const latest = result === "ready" ? null : await latestRelease();
      if (latest) {
        const progress = document.getElementById("update-note");
        if (progress && progress.classList.contains("update-note--downloading")) progress.remove();
        showBehind(latest, true);
      }
      else if (result === "none") App.toast(App.T("TypeR Studio is up to date."));
      else if (result !== "ready") App.toast(App.T("Couldn't check for updates. Check your connection and try again."), true);
    } catch (error) {
      console.warn("TypeR Studio: update check", error);
      App.toast(App.T("Couldn't check for updates. Check your connection and try again."), true);
    } finally {
      checkingUpdates = false;
    }
  };
  window.TypeRStudio.checkForUpdates = checkForUpdates;

  /* ------------------------- an app left behind by its own updates ---------------------- */

  // The page follows the site in every installed app, whatever its version; the app itself updates
  // on its own, but on some computers that never happens. Then, once the app has had its chance,
  // a note says a newer version is out: the app downloads it when it can, otherwise the installer
  // is downloaded in the browser. The page is the only part sure to reach these apps.
  const RELEASES = "https://github.com/ScanR/TypeR-Studio/releases/latest";
  const RELEASE_API = "https://api.github.com/repos/ScanR/TypeR-Studio/releases/latest";
  const LATEST_STORE = "typer.studio.latestRelease";
  const LATER_STORE = "typer.studio.behindLater";
  const LATEST_EVERY = 6 * 3600 * 1000;
  const LATER_FOR = 24 * 3600 * 1000;
  // The app's own automatic check runs a few seconds after the page is up
  const BEHIND_WAIT = 45 * 1000;
  // The installer each system downloads; a Mac's depends on its chip
  const INSTALLERS = { windows: ["TypeR-Studio-Setup.exe"], mac: ["TypeR-Studio-arm64.dmg", "TypeR-Studio-x64.dmg"], linux: [] };

  // { version, files } of the latest release, or null when it can't be told
  let updateSeen = false;
  const appVersion = () => {
    const found = /TypeRStudio\/(\d+)\.(\d+)\.(\d+)/.exec(navigator.userAgent || "");
    return found ? found.slice(1).map(Number) : null;
  };
  const versionOf = (text) => {
    const found = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(text || ""));
    return found ? found.slice(1).map(Number) : null;
  };
  const newer = (a, b) => {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return false;
  };
  const readStore = (key) => {
    try {
      return JSON.parse(window.localStorage.getItem(key) || "null");
    } catch (error) {
      return null;
    }
  };
  const writeStore = (key, value) => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      // Nothing kept: it's asked again next time
    }
  };
  // Only a release newer than this app, with this system's installer in it
  const latestRelease = async () => {
    const mine = appVersion();
    if (!mine || Desktop.releaseCheck === false) return null;
    let known = readStore(LATEST_STORE);
    if (!known || !Array.isArray(known.files) || !(Date.now() - known.at < LATEST_EVERY)) {
      try {
        const response = await fetch(RELEASE_API, { headers: { Accept: "application/vnd.github+json" }, cache: "no-store" });
        if (!response.ok) return null;
        const release = await response.json();
        known = { at: Date.now(), version: String(release.tag_name || ""), files: (release.assets || []).map((asset) => asset.name) };
        writeStore(LATEST_STORE, known);
      } catch (error) {
        return null;
      }
    }
    const latest = versionOf(known.version);
    if (!latest || !newer(latest, mine)) return null;
    const wanted = INSTALLERS[Desktop.platform] || [];
    if (wanted.length && !wanted.some((name) => known.files.includes(name))) return null;
    return { version: latest.join("."), files: known.files };
  };

  const BEHIND_WORDS = {
    fr: ["TypeR Studio {v} est disponible (vous avez la {mine}).", "Mettre à jour", "Plus tard", "Une fois le fichier téléchargé, fermez TypeR Studio et ouvrez-le pour installer la mise à jour. Vos pages et vos réglages sont conservés."],
    es: ["TypeR Studio {v} está disponible (tienes la {mine}).", "Actualizar", "Más tarde", "Cuando termine la descarga, cierra TypeR Studio y abre el archivo para instalar la actualización. Tus páginas y ajustes se conservan."],
    it: ["È disponibile TypeR Studio {v} (hai la {mine}).", "Aggiorna", "Più tardi", "Al termine del download, chiudi TypeR Studio e apri il file per installare l'aggiornamento. Pagine e impostazioni vengono mantenute."],
    de: ["TypeR Studio {v} ist verfügbar (du hast {mine}).", "Aktualisieren", "Später", "Wenn der Download fertig ist, schließe TypeR Studio und öffne die Datei, um das Update zu installieren. Deine Seiten und Einstellungen bleiben erhalten."],
    pt: ["O TypeR Studio {v} está disponível (você tem a {mine}).", "Atualizar", "Mais tarde", "Quando o download terminar, feche o TypeR Studio e abra o arquivo para instalar a atualização. Suas páginas e configurações são mantidas."],
    ru: ["Доступна версия TypeR Studio {v} (у вас {mine}).", "Обновить", "Позже", "Когда файл загрузится, закройте TypeR Studio и откройте его, чтобы установить обновление. Страницы и настройки сохранятся."],
    uk: ["Доступна версія TypeR Studio {v} (у вас {mine}).", "Оновити", "Пізніше", "Коли файл завантажиться, закрийте TypeR Studio і відкрийте його, щоб установити оновлення. Сторінки й налаштування збережуться."],
    pl: ["Dostępny jest TypeR Studio {v} (masz {mine}).", "Aktualizuj", "Później", "Po pobraniu pliku zamknij TypeR Studio i otwórz go, aby zainstalować aktualizację. Strony i ustawienia zostaną zachowane."],
    nl: ["TypeR Studio {v} is beschikbaar (je hebt {mine}).", "Bijwerken", "Later", "Sluit TypeR Studio zodra het bestand is gedownload en open het om de update te installeren. Je pagina's en instellingen blijven bewaard."],
    tr: ["TypeR Studio {v} çıktı (sizdeki {mine}).", "Güncelle", "Sonra", "Dosya indirilince TypeR Studio'yu kapatın ve güncellemeyi yüklemek için dosyayı açın. Sayfalarınız ve ayarlarınız korunur."],
    ar: ["يتوفر TypeR Studio {v} (لديك {mine}).", "تحديث", "لاحقًا", "بعد اكتمال التنزيل، أغلق TypeR Studio وافتح الملف لتثبيت التحديث. تبقى صفحاتك وإعداداتك كما هي."],
    vi: ["Đã có TypeR Studio {v} (bạn đang dùng {mine}).", "Cập nhật", "Để sau", "Khi tải xong, hãy đóng TypeR Studio rồi mở tệp để cài bản cập nhật. Các trang và cài đặt của bạn được giữ nguyên."],
    id: ["TypeR Studio {v} sudah tersedia (Anda memakai {mine}).", "Perbarui", "Nanti", "Setelah berkas selesai diunduh, tutup TypeR Studio lalu buka berkas itu untuk memasang pembaruan. Halaman dan pengaturan Anda tetap ada."],
    th: ["TypeR Studio {v} พร้อมให้ใช้แล้ว (ของคุณคือ {mine})", "อัปเดต", "ไว้ทีหลัง", "เมื่อดาวน์โหลดเสร็จ ให้ปิด TypeR Studio แล้วเปิดไฟล์เพื่อติดตั้งอัปเดต หน้างานและการตั้งค่าของคุณจะยังอยู่ครบ"],
    ja: ["TypeR Studio {v} が公開されています（現在は {mine}）。", "アップデート", "あとで", "ダウンロードが終わったら TypeR Studio を閉じ、ファイルを開いてアップデートをインストールしてください。ページと設定はそのまま残ります。"],
    ko: ["TypeR Studio {v}이(가) 나왔습니다(현재 {mine}).", "업데이트", "나중에", "다운로드가 끝나면 TypeR Studio를 닫고 파일을 열어 업데이트를 설치하세요. 페이지와 설정은 그대로 유지됩니다."],
    zh: ["TypeR Studio {v} 已发布（你的版本是 {mine}）。", "更新", "稍后", "下载完成后，请关闭 TypeR Studio 并打开该文件来安装更新。你的页面和设置都会保留。"],
  };
  const BEHIND_ENGLISH = ["TypeR Studio {v} is available (you have {mine}).", "Update", "Later", "Once it has downloaded, close TypeR Studio and open the file to install the update. Your pages and settings are kept."];
  const behindWords = () => {
    const lang = window.TYPER_I18N && window.TYPER_I18N.lang;
    return BEHIND_WORDS[lang] || BEHIND_ENGLISH;
  };

  const installerLink = async (files) => {
    let wanted = INSTALLERS[Desktop.platform] || [];
    if (Desktop.platform === "mac") {
      try {
        const { architecture } = await navigator.userAgentData.getHighEntropyValues(["architecture"]);
        if (architecture === "x86") wanted = wanted.slice().reverse();
      } catch (error) {
        // Apple chips are most of them
      }
    }
    const file = wanted.find((name) => files.includes(name));
    return file ? `${RELEASES}/download/${file}` : RELEASES;
  };
  // The installer, downloaded in the browser: it installs over this app and keeps everything
  const downloadInstaller = async (latest) => {
    window.open(await installerLink(latest.files), "_blank", "noopener");
    window.TypeRApp.toast(behindWords()[3], true);
  };

  const putBehindAway = () => {
    const note = document.getElementById("update-note");
    if (note && note.classList.contains("update-note--behind")) note.remove();
  };
  // `asked`: from Help > Check for Updates…, where the app already tried: straight to the download
  const showBehind = (latest, asked) => {
    const shown = document.getElementById("update-note");
    if (shown && !shown.classList.contains("update-note--behind")) return;
    if (shown) shown.remove();
    const mine = appVersion();
    const [text, update, later] = behindWords();
    const lang = window.TYPER_I18N && window.TYPER_I18N.lang;
    const note = document.createElement("div");
    note.id = "update-note";
    note.className = "update-note update-note--behind";
    note.setAttribute("role", "status");
    if (lang === "ar") note.dir = "rtl";
    const label = document.createElement("span");
    label.className = "update-note__text";
    label.textContent = text.replace("{v}", latest.version).replace("{mine}", mine ? mine.join(".") : "?");
    const now = document.createElement("button");
    now.type = "button";
    now.className = "btn btn--small btn--main";
    now.textContent = update;
    now.addEventListener("click", async () => {
      note.remove();
      // Help > Check for Updates… exists from 0.1.5: the app tries once more, with its own note
      if (!asked && Desktop.checkForUpdates && !checkingUpdates) {
        checkingUpdates = true;
        let result = "failed";
        try {
          result = await Desktop.checkForUpdates(() => {
            progressPutAway = false;
            if (Desktop.onUpdateProgress) showUpdateProgress(0);
          });
        } catch (error) {
          console.warn("TypeR Studio: update check", error);
        } finally {
          checkingUpdates = false;
        }
        if (result === "ready") return;
        const progress = document.getElementById("update-note");
        if (progress && progress.classList.contains("update-note--downloading")) progress.remove();
      }
      downloadInstaller(latest);
    });
    const notNow = document.createElement("button");
    notNow.type = "button";
    notNow.className = "btn btn--small";
    notNow.textContent = later;
    notNow.addEventListener("click", () => {
      writeStore(LATER_STORE, { version: latest.version, until: Date.now() + LATER_FOR });
      note.remove();
    });
    note.append(label, now, notNow);
    document.body.appendChild(note);
  };

  // Once the app has had time to find the update itself, and not again the day after Later. The
  // note of an update of the page (Restart) goes first: this one waits for it to be put away.
  // An app that shows how far its own download has gone is on its way: nothing then.
  const watchBehind = () => {
    const look = async () => {
      if (updateSeen) return;
      if (document.getElementById("update-note")) {
        setTimeout(look, BEHIND_WAIT);
        return;
      }
      const latest = await latestRelease();
      if (!latest || updateSeen || document.getElementById("update-note")) return;
      const later = readStore(LATER_STORE);
      if (later && later.version === latest.version && Date.now() < later.until) return;
      showBehind(latest, false);
    };
    setTimeout(look, BEHIND_WAIT);
  };

  /* ----------------------------------- once it's up ------------------------------------ */

  const ACCELERATOR_KEYS = { ArrowRight: "Right", ArrowLeft: "Left", ArrowUp: "Up", ArrowDown: "Down" };
  const accelerator = (keys) => (keys
    ? keys.split("+").map((part) => (part === "Cmd" ? "CmdOrCtrl" : ACCELERATOR_KEYS[part] || part)).join("+")
    : undefined);

  const syncMenu = () => {
    const App = window.TypeRApp;
    const menus = App.MENUS;
    const model = menus.map(([name, items], m) => ({
      name,
      label: App.T(name),
      items: items.map((item, n) => (item
        ? {
          id: `${m}:${n}`,
          name: item.label,
          // A name that follows what it does (Release Clipping Mask), or the panel's own (TypeR)
          label: App.T(item.title ? item.title() : item.label),
          accelerator: item.keys ? accelerator(item.keys) : item.shownAccelerator ? item.shownAccelerator() : undefined,
          enabled: item.enabled ? Boolean(item.enabled()) : true,
          checked: item.check ? Boolean(item.check()) : undefined,
        }
        : null)),
    }));
    const signature = JSON.stringify(model);
    if (signature === syncMenu.last) return;
    syncMenu.last = signature;
    Desktop.setMenu(model);
  };

  // The menu follows what the page can do: looked at after each gesture, sent only if it changed
  let waiting = false;
  const syncSoon = () => {
    if (waiting) return;
    waiting = true;
    setTimeout(() => {
      waiting = false;
      syncMenu();
    }, 120);
  };

  const typingNow = () => {
    let active = document.activeElement;
    while (active && active.tagName === "IFRAME") {
      try {
        active = active.contentDocument.activeElement;
      } catch (error) {
        return false;
      }
    }
    return Boolean(active) && (/^(INPUT|TEXTAREA)$/.test(active.tagName) || active.isContentEditable);
  };

  /* ------------------------------- Discord's Rich Presence ------------------------------ */

  // What the page is on goes to the app when it changes (Settings > Discord activity). The app
  // spaces the changes out as Discord asks, and shows nothing while Discord isn't running.
  const PRESENCE_EVERY = 5000;
  const watchPresence = () => {
    const App = window.TypeRApp;
    if (!Desktop.discord || !App.presence) return;
    let said = "";
    const tell = () => {
      const now = App.presence();
      const key = JSON.stringify(now);
      if (key === said) return;
      said = key;
      Desktop.discord.set(now);
    };
    tell();
    setInterval(tell, PRESENCE_EVERY);
  };

  // The page's scripts have run; bringing the last session back still takes its time
  const whenLoaded = () => {
    const App = window.TypeRApp;
    Desktop.setStrings({
      closeTitle: App.T("Save your changes before closing?"),
      protectedPlace: App.T("This place is protected by the system. Choose another one."),
      ok: App.T("OK"),
      discard: App.T("Don't save"),
      cancel: App.T("Cancel"),
      // The title of the system's dialog that Locate Photoshop… opens
      locatePhotoshop: App.T("Locate Photoshop…").replace(/…$/, ""),
      // The small window shown while the app restarts for an update
      installingUpdate: App.T("Installing the update…"),
      restartingForUpdate: App.T("Restarting TypeR Studio…"),
      reopensItself: App.T("TypeR Studio will reopen by itself in a moment."),
      crashed: App.T("TypeR Studio stopped working, maybe for lack of memory."),
      tryAgain: App.T("Try Again"),
      quit: App.T("Quit"),
      dir: document.documentElement.dir === "rtl" || (window.TYPER_I18N && window.TYPER_I18N.lang) === "ar" ? "rtl" : "ltr",
    });
    watchPresence();
    if (Desktop.platform === "mac") {
      syncMenu();
      ["pointerup", "keyup", "focusin"].forEach((name) => window.addEventListener(name, syncSoon, true));
      window.TypeRPhotoshop.on(syncSoon);
      // TypeR's modes, switched in its panel
      window.addEventListener("typer-modes", syncSoon);
      const menuAction = (id) => {
        const [m, n] = id.split(":").map(Number);
        const item = App.MENUS[m][1][n];
        // As with the page's own menus, a dialog on screen comes first
        if (document.getElementById("modal").open) return;
        App.renderMenusState();
        if (item && item.row && !item.row.disabled) item.row.click();
        syncSoon();
      };
      // main.js runs it as a click, so a file window can open from the menu bar; older ones
      // send it as a message
      window.TypeRDesktopMenu = menuAction;
      Desktop.onMenuAction(menuAction);
      // A key the page left alone: only a text field has a use for it, Undo in it is the field's
      Desktop.onMenuKey((command) => {
        if (typingNow()) Desktop.textEdit(command);
      });
    }
    // The computer's fonts are there from the start (main.js grants them). One installed while
    // the app is open shows up when the app is back in front.
    let fontsAsked = 0;
    window.addEventListener("focus", () => {
      if (Date.now() - fontsAsked < 5000) return;
      fontsAsked = Date.now();
      window.TypeRFonts.useInstalled().catch(() => {});
    });
    Desktop.onUpdateReady(() => {
      progressPutAway = false;
      showUpdateNote();
    });
    if (Desktop.onUpdateProgress) Desktop.onUpdateProgress(showUpdateProgress);
    watchBehind();
    Desktop.alive();
  };

  document.addEventListener("DOMContentLoaded", () => {
    const logo = document.querySelector(".mbar__logo");
    if (logo) logo.removeAttribute("href");
    document.title = "TypeR Studio";
    document.querySelectorAll(".mbar__title, .start h1").forEach((title) => { title.textContent = "TypeR Studio"; });
    if (!window.TypeRApp) return;
    whenLoaded();
    if (window.TypeRApp.booted) Desktop.ready();
    else window.addEventListener("typer-booted", () => Desktop.ready(), { once: true });
  });
})();
