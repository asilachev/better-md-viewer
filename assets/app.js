/* Better MD viewer — local-only markdown reader */

// Settings toggle — bound early so init errors can't block it.
document.addEventListener("click", (e) => {
  const btn = e.target && e.target.closest && e.target.closest("#settingsBtn");
  const tw = document.getElementById("tweaks");
  if (!tw) return;
  if (btn) {
    e.stopPropagation();
    const on = tw.classList.toggle("on");
    btn.classList.toggle("on", on);
    return;
  }
  if (tw.classList.contains("on") && !tw.contains(e.target)) {
    tw.classList.remove("on");
    const sb = document.getElementById("settingsBtn");
    if (sb) sb.classList.remove("on");
  }
});

(() => {
  "use strict";

  // Marked + DOMPurify
  if (window.marked) {
    marked.use({ gfm: true, breaks: false }, markedFootnotes());
  }
  const PURIFY_CFG = {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["form", "iframe", "object", "embed", "style", "script"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus", "onblur", "formaction", "style"],
    // Prefix ids and names with "user-content-" (as GitHub does) so a document can't shadow the app's own elements.
    SANITIZE_NAMED_PROPS: true,
  };
  const ID_PREFIX = "user-content-";
  const APP_NAME = "Better MD viewer";
  const APP_TITLE = document.title;

  const state = {
    files: [],
    assets: new Map(),   // every non-markdown file by path, for images and links
    root: null,          // directory handle of the open folder, when the browser gives one (enables live reload)
    rootName: "",
    removed: new Set(),  // paths the user removed from the list, so rescans don't bring them back
    activeId: null,
    activeStamp: 0,      // lastModified of the open file
    stamps: new Map(),   // lastModified of each file as last seen (live folders only)
    unseen: new Set(),   // paths that changed or appeared on disk since you last opened them
    activeFolderKey: null,
    recents: [],
    searchQuery: "",
    contentSearch: false,
    expanded: {},
    filterCollapsed: {},
  };

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const el = {
    app: $("#app"),
    sidebar: $("#sidebar"),
    sideSections: $("#sideSections"),
    recentsSection: $("#recentsSection"),
    filesSection: $("#filesSection"),
    searchWrap: $("#searchWrap"),
    searchInput: $("#searchInput"),
    contentToggle: $("#contentSearchBtn"),
    crumbs: $("#crumbs"),
    reader: $("#reader"),
    outline: $("#outline"),
    splash: $("#splash"),
    splashResume: $("#splashResume"),
    dropOver: $("#dropOver"),
    fileCount: $("#fileCount"),
    openFolderBtn: $("#openFolderBtn"),
    openFilesBtn: $("#openFilesBtn"),
    splashDrop: $("#splashDrop"),
    sidebarToggle: $("#sidebarToggle"),
    sidebarResizer: $("#sidebarResizer"),
    settingsBtn: $("#settingsBtn"),
    filePicker: $("#filePicker"),
    dirPicker: $("#dirPicker"),
    toast: $("#toast"),
    tweaks: $("#tweaks"),
  };

  // ---------------------------------------------------------------
  // IndexedDB — recents
  // ---------------------------------------------------------------
  const DB_NAME = "md-viewer";
  const DB_VERSION = 1;
  const STORE = "recents";
  let _db = null;

  function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "key" });
        }
      };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }
  async function idbPut(v) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(v);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function idbGetAll() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbGet(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbDel(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function idbClear() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ---------------------------------------------------------------
  // File gathering
  // ---------------------------------------------------------------
  const SUPPORTED = /\.(md|markdown|txt)$/i;
  // Dependency and cache folders: often huge, never the docs you came to read.
  const IGNORED_DIRS = new Set(["node_modules", "bower_components", "jspm_packages", "__pycache__", "site-packages", "venv"]);
  // Hidden entries are skipped, except folders that usually hold docs.
  const HIDDEN_DIRS_KEPT = new Set([".github"]);

  function skipEntry(name, isDir) {
    if (name.startsWith(".")) return !(isDir && HIDDEN_DIRS_KEPT.has(name));
    return isDir && IGNORED_DIRS.has(name);
  }
  function skipPath(path) {
    const parts = path.split("/");
    return parts.some((p, i) => skipEntry(p, i < parts.length - 1));
  }

  function uid() { return "f_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }

  function deriveGroup(path) {
    const parts = path.split("/");
    if (parts.length <= 1) return "";
    return parts.slice(0, -1).join("/");
  }

  function makeFile(path, kind, src, size = 0) {
    const f = { id: uid(), path, name: path.slice(path.lastIndexOf("/") + 1), group: deriveGroup(path), kind, size };
    if (kind === "handle") f.handle = src;
    else f.file = src;
    return f;
  }

  // A scan collects the docs plus every other file (images, link targets) and reports progress on big folders.
  function newScan({ quiet = false } = {}) {
    let seen = 0;
    return {
      files: [], assets: new Map(), started: Date.now(), reported: false,
      tick() {
        if (quiet || ++seen % 250 || Date.now() - this.started < 400) return;
        this.reported = true;
        toast(`Scanning… ${seen.toLocaleString()} items`, 5000);
      },
    };
  }

  async function scanDirHandle(dir, prefix = "", scan = newScan()) {
    for await (const [name, ent] of dir.entries()) {
      const isDir = ent.kind === "directory";
      if (skipEntry(name, isDir)) continue;
      const rel = prefix ? prefix + "/" + name : name;
      if (isDir) await scanDirHandle(ent, rel, scan);
      else if (SUPPORTED.test(name)) scan.files.push(makeFile(rel, "handle", ent));
      else scan.assets.set(rel, ent);
      scan.tick();
    }
    return scan;
  }

  // FileSystemEntry API (Safari/Firefox drops). `rel` is "" for the dropped folder itself.
  async function scanEntry(ent, rel, scan) {
    if (ent.isDirectory) {
      const reader = ent.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const kid of batch) {
          if (!skipEntry(kid.name, kid.isDirectory)) await scanEntry(kid, rel ? rel + "/" + kid.name : kid.name, scan);
        }
      }
    } else if (SUPPORTED.test(ent.name)) {
      const file = await new Promise((res, rej) => ent.file(res, rej));
      scan.files.push(makeFile(rel, "file", file, file.size));
    } else {
      scan.assets.set(rel, ent);
    }
    scan.tick();
  }

  function fileObject(f) { return f.kind === "handle" ? f.handle.getFile() : Promise.resolve(f.file); }

  // Assets arrive as handles, Files, or FileSystemFileEntries.
  async function assetBlob(src, path) {
    const blob = src instanceof Blob ? src
      : src.getFile ? await src.getFile()
      : await new Promise((res, rej) => src.file(res, rej));
    // An untyped blob won't render as SVG.
    return !blob.type && /\.svg$/i.test(path) ? new Blob([blob], { type: "image/svg+xml" }) : blob;
  }

  // ---------------------------------------------------------------
  // Toast
  // ---------------------------------------------------------------
  let toastT = null;
  function toast(msg, ms = 2200) {
    el.toast.textContent = msg;
    el.toast.classList.add("on");
    clearTimeout(toastT);
    toastT = setTimeout(() => el.toast.classList.remove("on"), ms);
  }

  // ---------------------------------------------------------------
  // Opening folders / files
  // ---------------------------------------------------------------
  async function openFolderViaHandle() {
    try {
      const dir = await window.showDirectoryPicker({ mode: "read" });
      const scan = await scanDirHandle(dir);
      if (!scan.files.length) { toast("No .md / .txt files found in that folder"); return; }
      await loadFolder({ name: dir.name || "folder", source: "handle", handle: dir, scan });
    } catch (e) {
      if (e && e.name !== "AbortError") { console.warn(e); toast("Could not open folder"); }
    }
  }

  const SAFARI_NOTE_KEY = "mdviewer.safariNote.v1";
  const usesLegacyPicker = !window.showDirectoryPicker;
  function primeLegacyPicker(onContinue) {
    if (!usesLegacyPicker) { onContinue(); return; }
    if (localStorage.getItem(SAFARI_NOTE_KEY) === "dismissed") { onContinue(); return; }
    const wrap = document.getElementById("safariNote");
    const btnContinue = document.getElementById("safariNoteContinue");
    const btnCancel = document.getElementById("safariNoteCancel");
    const hide = document.getElementById("safariNoteHide");
    if (!wrap || !btnContinue || !btnCancel) { onContinue(); return; }
    wrap.hidden = false;
    const cleanup = () => {
      wrap.hidden = true;
      btnContinue.removeEventListener("click", onYes);
      btnCancel.removeEventListener("click", onNo);
      wrap.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onEsc);
    };
    const maybePersist = () => {
      if (hide && hide.checked) localStorage.setItem(SAFARI_NOTE_KEY, "dismissed");
    };
    const onYes = () => { maybePersist(); cleanup(); onContinue(); };
    const onNo = () => { cleanup(); };
    const onBackdrop = (e) => { if (e.target === wrap) onNo(); };
    const onEsc = (e) => { if (e.key === "Escape") onNo(); };
    btnContinue.addEventListener("click", onYes);
    btnCancel.addEventListener("click", onNo);
    wrap.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onEsc);
    setTimeout(() => btnContinue.focus(), 0);
  }
  function openFolderViaInput() { primeLegacyPicker(() => { el.dirPicker.value = ""; el.dirPicker.click(); }); }
  function openFilesViaInput()  { primeLegacyPicker(() => { el.filePicker.value = ""; el.filePicker.click(); }); }

  async function openFolderUpload(fileList) {
    const all = [...fileList];
    let rootName = "";
    for (const f of all) {
      const first = (f.webkitRelativePath || f.name).split("/")[0];
      if (!rootName) rootName = first;
      else if (first !== rootName) { rootName = ""; break; }
    }
    const scan = newScan();
    for (const f of all) {
      const rp = f.webkitRelativePath || f.name;
      const rel = rootName && rp.startsWith(rootName + "/") ? rp.slice(rootName.length + 1) : rp;
      if (skipPath(rel)) continue;
      if (SUPPORTED.test(f.name)) scan.files.push(makeFile(rel, "file", f, f.size));
      else scan.assets.set(rel, f);
    }
    if (!scan.files.length) { toast("No .md / .txt files found"); return; }
    await loadFolder({ name: rootName || "folder", source: "upload", scan });
    toast(`Read ${scan.files.length} file${scan.files.length === 1 ? "" : "s"} locally · nothing uploaded`, 2800);
  }

  function openLooseFiles(fileList) {
    const files = [...fileList].filter(f => SUPPORTED.test(f.name)).map(f => makeFile(f.name, "file", f, f.size));
    if (!files.length) { toast("No .md / .txt files found"); return; }
    addFiles(files);
  }

  // Every way of opening a whole folder ends here.
  async function loadFolder({ name, source, handle = null, scan, recentKey = null, lastFilePath = null }) {
    if (scan.reported) toast(`Found ${scan.files.length.toLocaleString()} files`, 1600);
    for (const f of scan.files) f.fromRoot = true;
    state.root = handle;
    state.rootName = name;
    state.assets = scan.assets;
    lastScanMs = Date.now() - scan.started;
    el.splashResume.hidden = true;
    setFiles(scan.files);
    // Baseline for marking files that change later; reads run in the background.
    if (handle) readStamps(state.files).then(stamps => {
      if (state.root !== handle) return;
      for (const [path, stamp] of stamps) if (!state.stamps.has(path)) state.stamps.set(path, stamp);
    });
    state.activeFolderKey = await rememberFolder({ key: recentKey, name, source, handle, fileCount: scan.files.length });
    const route = parseRoute();
    const first = pickInitialFile(state.files, route && route.path, lastFilePath);
    if (first) openFile(first.id, { anchor: route && route.path === first.path ? route.anchor : "", nav: "replace" });
  }

  // The file in the URL, else where you left off, else the folder's README or index, else the first file.
  function pickInitialFile(files, ...preferred) {
    for (const p of preferred) {
      const f = p && files.find(x => x.path === p);
      if (f) return f;
    }
    const atRoot = re => files.find(f => !f.group && re.test(f.name));
    return atRoot(/^readme\.(md|markdown)$/i) || atRoot(/^index\.(md|markdown)$/i) || files[0];
  }

  // ---------------------------------------------------------------
  // Drag & drop
  // ---------------------------------------------------------------
  let dragDepth = 0;
  function hasFiles(e) {
    return e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files");
  }
  function onDragEnter(e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    el.dropOver.classList.add("on");
    document.body.classList.add("dragging");
  }
  function onDragOver(e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }
  function onDragLeave() {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) {
      el.dropOver.classList.remove("on");
      document.body.classList.remove("dragging");
    }
  }
  async function onDrop(e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    el.dropOver.classList.remove("on");
    document.body.classList.remove("dragging");

    // Drop data is only readable while this event is being dispatched,
    // so every item is requested before the first await.
    const items = [...(e.dataTransfer.items || [])].filter(it => it.kind === "file");
    const looseFiles = [...(e.dataTransfer.files || [])];
    try {
      if (items.length && items[0].getAsFileSystemHandle) {
        const pending = items.map(it => it.getAsFileSystemHandle().catch(() => null));
        const handles = (await Promise.all(pending)).filter(Boolean);
        if (handles.length) return await openDroppedHandles(handles);
      } else if (items.length && items[0].webkitGetAsEntry) {
        const entries = items.map(it => it.webkitGetAsEntry()).filter(Boolean);
        if (entries.length) return await openDroppedEntries(entries);
      }
      if (looseFiles.length) openLooseFiles(looseFiles);
    } catch (err) {
      console.warn(err);
      toast("Could not open what you dropped");
    }
  }

  async function openDroppedHandles(handles) {
    const dirs = handles.filter(h => h.kind === "directory");
    if (dirs.length === 1 && handles.length === 1) {
      const scan = await scanDirHandle(dirs[0]);
      if (!scan.files.length) { toast("No .md / .txt files in drop"); return; }
      await loadFolder({ name: dirs[0].name, source: "handle", handle: dirs[0], scan });
      return;
    }
    const scan = newScan();
    for (const d of dirs) await scanDirHandle(d, d.name, scan);
    for (const h of handles) {
      if (h.kind === "file" && SUPPORTED.test(h.name)) scan.files.push(makeFile(h.name, "handle", h));
    }
    if (!scan.files.length) { toast("No .md / .txt files in drop"); return; }
    addFiles(scan.files, scan.assets);
  }

  async function openDroppedEntries(entries) {
    const root = entries.length === 1 && entries[0].isDirectory ? entries[0] : null;
    const scan = newScan();
    if (root) await scanEntry(root, "", scan);
    else for (const ent of entries) await scanEntry(ent, ent.name, scan);
    if (!scan.files.length) { toast("No .md / .txt files in drop"); return; }
    if (root) await loadFolder({ name: root.name, source: "upload", scan });
    else addFiles(scan.files, scan.assets);
  }

  // ---------------------------------------------------------------
  // File list manipulation
  // ---------------------------------------------------------------
  function setFiles(arr) {
    state.files = sortFiles(arr);
    state.activeId = null;
    state.removed = new Set();
    state.stamps = new Map();
    state.unseen = new Set();
    state.expanded = {};
    state.filterCollapsed = {};
    state.searchQuery = "";
    el.searchInput.value = "";
    contentCache.clear();
    renderFiles();
    renderTopMeta();
  }
  function addFiles(arr, assets) {
    if (!state.files.length) {
      state.activeFolderKey = null;
      state.root = null;
      state.assets = new Map();
    }
    const existing = new Set(state.files.map(f => f.path));
    const added = [];
    for (const f of arr) {
      let p = f.path, i = 1;
      while (existing.has(p)) { p = f.path.replace(/(\.[^.]+)?$/, "-" + (++i) + "$1"); }
      existing.add(p);
      added.push({ ...f, path: p, group: deriveGroup(p) });
    }
    if (assets) for (const [p, src] of assets) if (!state.assets.has(p)) state.assets.set(p, src);
    state.files = sortFiles([...state.files, ...added]);
    renderFiles();
    renderTopMeta();
    if (added[0]) openFile(added[0].id);
  }
  const collator = new Intl.Collator(undefined, { numeric: true });
  function sortFiles(arr) {
    return arr.slice().sort((a, b) => comparePaths(a.path, b.path));
  }
  // Tree order: within each folder, its own files come before its subfolders.
  function comparePaths(a, b) {
    const pa = a.split("/"), pb = b.split("/");
    for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
      const fileA = i === pa.length - 1, fileB = i === pb.length - 1;
      if (fileA !== fileB) return fileA ? -1 : 1;
      if (pa[i] !== pb[i]) return collator.compare(pa[i], pb[i]) || (pa[i] < pb[i] ? -1 : 1);
    }
    return pa.length - pb.length;
  }
  function removeFile(id) {
    const idx = state.files.findIndex(f => f.id === id);
    if (idx < 0) return;
    const [f] = state.files.splice(idx, 1);
    if (f.fromRoot) state.removed.add(f.path);
    state.unseen.delete(f.path);
    contentCache.delete(id);
    renderFiles();
    renderTopMeta();
    if (state.activeId === id) {
      state.activeId = null;
      const next = state.files[idx] || state.files[idx - 1];
      if (next) openFile(next.id);
      else showSplash();
    }
  }
  function clearFiles() {
    state.files = [];
    state.assets = new Map();
    state.root = null;
    state.activeId = null;
    state.activeFolderKey = null;
    state.stamps = new Map();
    state.unseen = new Set();
    contentCache.clear();
    renderFiles();
    renderTopMeta();
    showSplash();
  }
  function activeFile() {
    return state.files.find(f => f.id === state.activeId) || null;
  }

  // ---------------------------------------------------------------
  // File tree
  // ---------------------------------------------------------------
  // Folders start collapsed. While filtering they start expanded so every
  // match shows, and toggles made there don't touch the unfiltered tree.
  const isFiltering = () => !!state.searchQuery.trim();

  function isCollapsed(path) {
    return isFiltering() ? !!state.filterCollapsed[path] : !state.expanded[path];
  }
  function setCollapsed(path, collapsed) {
    if (isFiltering()) state.filterCollapsed[path] = collapsed;
    else state.expanded[path] = !collapsed;
  }
  function setAllCollapsed(collapsed) {
    for (const p of folderPaths(state.files)) setCollapsed(p, collapsed);
    renderFiles();
  }
  function folderPaths(files) {
    const out = new Set();
    for (const f of files) {
      for (let p = f.group; p && !out.has(p); p = deriveGroup(p)) out.add(p);
    }
    return out;
  }
  function revealFile(f) {
    for (let p = f.group; p; p = deriveGroup(p)) {
      state.expanded[p] = true;
      state.filterCollapsed[p] = false;
    }
  }

  // Files matching the filter. With content search on, files whose text contains it match too,
  // and `hits` says how often.
  function searchResults() {
    const q = state.searchQuery.trim().toLowerCase();
    const hits = new Map();
    if (!q) return { files: state.files, hits };
    const files = state.files.filter(f => {
      const n = state.contentSearch ? countHits(contentCache.get(f.id)?.lower, q) : 0;
      if (n) hits.set(f.id, n);
      return n > 0 || f.path.toLowerCase().includes(q) || f.name.toLowerCase().includes(q);
    });
    return { files, hits };
  }
  function countHits(text, q) {
    let n = 0;
    if (text) for (let i = text.indexOf(q); i >= 0 && n < 999; i = text.indexOf(q, i + q.length)) n++;
    return n;
  }

  function buildTree(files) {
    const root = { name: "", path: "", dirs: new Map(), files: [], count: 0, unseen: 0 };
    for (const f of files) {
      const fresh = state.unseen.has(f.path) ? 1 : 0;
      let node = root;
      node.count++;
      node.unseen += fresh;
      for (const name of f.group ? f.group.split("/") : []) {
        let next = node.dirs.get(name);
        if (!next) {
          next = { name, path: node.path ? node.path + "/" + name : name, dirs: new Map(), files: [], count: 0, unseen: 0 };
          node.dirs.set(name, next);
        }
        next.count++;
        next.unseen += fresh;
        node = next;
      }
      node.files.push(f);
    }
    return root;
  }

  // A chain of folders that each hold just one subfolder renders as a single "a/b/c" row.
  function compactDir(dir) {
    let label = dir.name;
    while (!dir.files.length && dir.dirs.size === 1) {
      dir = dir.dirs.values().next().value;
      label += "/" + dir.name;
    }
    return { dir, label };
  }

  // Files in sidebar order, skipping the contents of collapsed folders.
  function visibleFiles() {
    const out = [];
    (function walk(node) {
      out.push(...node.files);
      for (const child of node.dirs.values()) {
        const { dir } = compactDir(child);
        if (!isCollapsed(dir.path)) walk(dir);
      }
    })(buildTree(searchResults().files));
    return out;
  }

  // ---------------------------------------------------------------
  // Rendering: sidebar
  // ---------------------------------------------------------------
  const ICON_CHEVRON = `<svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>`;
  const ICON_COLLAPSE_ALL = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 2.5 3 3 3-3"/><path d="m5 13.5 3-3 3 3"/></svg>`;
  const ICON_EXPAND_ALL = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 5.5 3-3 3 3"/><path d="m5 10.5 3 3 3-3"/></svg>`;
  const ICON_RESCAN = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89"/><path d="M13.5 2.5v3h-3"/></svg>`;
  const ICON_FOLDER = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 4.5v8a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.5 3.5H2.5a1 1 0 0 0-1 1z"/></svg>`;
  const ICON_UPLOAD = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 10.5v-8"/><path d="m5 5.5 3-3 3 3"/><path d="M2.5 10.5v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2"/></svg>`;

  function renderRecents() {
    const root = el.recentsSection;
    root.replaceChildren();
    if (!state.recents.length) return;

    const title = document.createElement("div");
    title.className = "side-title";
    title.innerHTML = `<span>Recent</span><button id="clearRecentsBtn" type="button">Forget all</button>`;
    root.appendChild(title);

    const wrap = document.createElement("div");
    wrap.className = "recents";
    for (const r of state.recents) {
      const row = document.createElement("div");
      row.className = "recent" + (r.source === "handle" ? "" : " no-handle");
      row.innerHTML = `
        <button class="recent-open" type="button">
          <span class="ricon" title="${r.source === "handle" ? "Folder — reopens directly" : "Read from an upload — re-select to reopen"}">${r.source === "handle" ? ICON_FOLDER : ICON_UPLOAD}</span>
          <span class="rtitle"></span>
          <span class="rmeta"></span>
        </button>
        <button class="rforget" type="button" title="Forget" aria-label="Forget">×</button>
      `;
      $(".rtitle", row).textContent = r.name;
      $(".rmeta", row).textContent = `${timeAgo(r.at)} · ${r.fileCount} file${r.fileCount === 1 ? "" : "s"}`;
      $(".recent-open", row).addEventListener("click", () => reopenRecent(r));
      $(".rforget", row).addEventListener("click", async () => {
        try { await idbDel(r.key); } catch (_) {}
        loadRecents();
      });
      wrap.appendChild(row);
    }
    root.appendChild(wrap);

    $("#clearRecentsBtn", root).addEventListener("click", async () => {
      try { await idbClear(); } catch (_) {}
      loadRecents();
      toast("Recents cleared");
    });
  }

  function renderFiles() {
    const root = el.filesSection;
    root.replaceChildren();
    el.searchWrap.classList.toggle("on", state.files.length > 0);

    if (!state.files.length) {
      const em = document.createElement("div");
      em.className = "empty-side";
      em.innerHTML = `
        <b>No files yet.</b><br>
        Click <b>Open folder</b>, or drop a folder / <span class="kbd">.md</span> files anywhere.
      `;
      root.appendChild(em);
      return;
    }

    const n = state.files.length;
    const hasFolders = state.files.some(f => f.group);
    const title = document.createElement("div");
    title.className = "side-title files-title";
    title.style.marginTop = "12px";
    title.innerHTML = `
      <span>${n} file${n === 1 ? "" : "s"}</span>
      <span class="side-tools">
        ${state.root ? `<button class="tool" id="rescanBtn" type="button" title="Rescan folder" aria-label="Rescan folder">${ICON_RESCAN}</button>` : ""}
        ${hasFolders ? `
          <button class="tool" id="collapseAllBtn" type="button" title="Collapse all folders" aria-label="Collapse all folders">${ICON_COLLAPSE_ALL}</button>
          <button class="tool" id="expandAllBtn" type="button" title="Expand all folders" aria-label="Expand all folders">${ICON_EXPAND_ALL}</button>
        ` : ""}
        <button id="clearFilesBtn" type="button">Clear</button>
      </span>
    `;
    root.appendChild(title);
    $("#clearFilesBtn", title).addEventListener("click", clearFiles);
    $("#rescanBtn", title)?.addEventListener("click", () => rescanFolder({ manual: true }));
    $("#collapseAllBtn", title)?.addEventListener("click", () => setAllCollapsed(true));
    $("#expandAllBtn", title)?.addEventListener("click", () => setAllCollapsed(false));

    const { files: visible, hits } = searchResults();
    const tree = document.createElement("div");
    tree.className = "tree";
    tree.id = "fileTree";
    renderTreeLevel(buildTree(visible), 0, tree, hits);
    root.appendChild(tree);

    if (!visible.length) {
      const em = document.createElement("div");
      em.className = "empty-side";
      em.textContent = state.contentSearch
        ? `Nothing matches "${state.searchQuery}" in names or contents.`
        : `No files match "${state.searchQuery}".`;
      root.appendChild(em);
    }
  }

  function renderTreeLevel(node, depth, parent, hits) {
    for (const f of node.files) parent.appendChild(renderFileRow(f, depth, hits));
    for (const child of node.dirs.values()) {
      const { dir, label } = compactDir(child);
      const collapsed = isCollapsed(dir.path);
      const wrap = document.createElement("div");
      wrap.className = "tree-dir" + (collapsed ? " collapsed" : "");
      wrap.style.setProperty("--depth", depth);

      const head = document.createElement("button");
      head.type = "button";
      head.className = "tree-row dir-row";
      head.title = dir.path;
      head.setAttribute("aria-expanded", String(!collapsed));
      head.innerHTML = `
        <span class="twist">${ICON_CHEVRON}</span>
        <span class="name"></span>
        ${dir.unseen ? `<span class="pip" title="${dir.unseen} changed since you last opened ${dir.unseen === 1 ? "it" : "them"}"></span>` : ""}
        <span class="count">${dir.count}</span>
      `;
      $(".name", head).textContent = label;
      // Toggle in place — no re-render, so scroll position and focus stay put.
      head.addEventListener("click", () => {
        const nowCollapsed = wrap.classList.toggle("collapsed");
        head.setAttribute("aria-expanded", String(!nowCollapsed));
        setCollapsed(dir.path, nowCollapsed);
      });

      const kids = document.createElement("div");
      kids.className = "tree-children";
      renderTreeLevel(dir, depth + 1, kids, hits);
      wrap.append(head, kids);
      parent.appendChild(wrap);
    }
  }

  function renderFileRow(f, depth, hits) {
    const row = document.createElement("div");
    const unseen = state.unseen.has(f.path);
    row.className = "tree-row file-row" + (f.id === state.activeId ? " active" : "") + (unseen ? " unseen" : "");
    row.dataset.id = f.id;
    row.style.setProperty("--depth", depth);
    row.title = f.path;
    if (unseen) row.setAttribute("aria-description", "changed since you last opened it");
    const n = hits && hits.get(f.id);
    row.innerHTML = `
      <button class="row-main" type="button"><span class="twist"><span class="dot-mark"></span></span><span class="name"></span></button>
      ${n ? `<span class="count hits" title="${n} match${n === 1 ? "" : "es"}">${n > 99 ? "99+" : n}</span>` : ""}
      <button class="remove" type="button" title="Remove from list" aria-label="Remove from list">×</button>
    `;
    $(".name", row).textContent = f.name;
    row.addEventListener("click", (e) => {
      if (e.target.closest(".remove")) return;
      openFile(f.id);
    });
    $(".remove", row).addEventListener("click", (e) => {
      e.stopPropagation();
      removeFile(f.id);
    });
    return row;
  }

  // Move the highlight to the open file without rebuilding the tree, opening its folders.
  function syncActiveRow() {
    const tree = $("#fileTree");
    if (!tree) return;
    $$(".file-row.active", tree).forEach(r => r.classList.remove("active"));
    const row = $(`.file-row[data-id="${state.activeId}"]`, tree);
    if (!row) return;
    for (let dir = row.closest(".tree-dir"); dir; dir = dir.parentElement.closest(".tree-dir")) {
      dir.classList.remove("collapsed");
      dir.firstElementChild.setAttribute("aria-expanded", "true");
    }
    row.classList.add("active");
    row.scrollIntoView({ block: "nearest" });
  }

  function renderTopMeta() {
    const n = state.files.length;
    el.fileCount.textContent = !n ? "no files" : `${n.toLocaleString()} file${n === 1 ? "" : "s"}`;
  }

  // ---------------------------------------------------------------
  // Rendering: reader
  // ---------------------------------------------------------------
  let openGen = 0;
  let renderGen = 0;
  let blobUrls = [];

  async function openFile(id, { anchor = "", nav = "push" } = {}) {
    const f = state.files.find(x => x.id === id);
    if (!f) return;
    const gen = ++openGen;
    state.activeId = id;
    revealFile(f);
    if (state.unseen.delete(f.path)) renderFiles();
    syncActiveRow();
    renderCrumbs(f);
    document.title = `${f.name} — ${APP_NAME}`;
    setRoute(f.path, anchor, nav);
    closeDrawer();

    let text = "", stamp = 0;
    try {
      const file = await fileObject(f);
      stamp = file.lastModified;
      text = await file.text();
    } catch (e) {
      text = "# Could not read this file\n\n`" + (e && e.message || e) + "`";
    }
    if (gen !== openGen) return;   // another file was opened while this one was loading
    state.activeStamp = stamp;
    if (f.kind === "handle") state.stamps.set(f.path, stamp);
    renderDocument(f, text);

    const hit = $("mark.hit", el.reader);
    if (anchor) scrollToAnchor(anchor);
    else if (hit) hit.scrollIntoView({ block: "center" });
    else el.reader.scrollTop = 0;
    const focused = document.activeElement;
    if (!focused || !focused.closest("input, textarea, select")) el.reader.focus({ preventScroll: true });
    rememberLastFile(f);
  }

  function renderDocument(f, text) {
    const gen = ++renderGen;
    if (changeObserver) { changeObserver.disconnect(); changeObserver = null; }
    const article = document.createElement("article");
    article.className = "reader-inner md";
    article.id = "readerInner";
    let held = 0;
    if (/\.(md|markdown)$/i.test(f.name)) {
      const { frontmatter, body } = splitFrontmatter(text);
      // The fragment belongs to DOMPurify's inert document: nothing in it loads until it is inserted below.
      const frag = DOMPurify.sanitize(renderFrontmatterTable(frontmatter) + marked.parse(body), { ...PURIFY_CFG, RETURN_DOM_FRAGMENT: true });
      if (tweaks.remoteImages !== "load") held = holdRemoteMedia(frag);
      holdLocalMedia(frag);
      article.append(frag);
    } else {
      const pre = document.createElement("pre");
      pre.className = "plain";
      pre.textContent = text;
      article.append(pre);
    }
    revokeBlobUrls();
    el.reader.replaceChildren(article);
    enhanceCallouts(article);
    enhanceInlineTokens(article);
    enhanceHeadingAnchors(article);
    highlightCodeBlocks(article);
    addCopyButtons(article);
    wireLinks(article, f);
    loadLocalMedia(article, f, gen);
    if (held) showRemoteNotice(article, held);
    renderOutline(article, f);
    highlightHits(article);
  }

  // Remote images (and other media) tell their host who opened the document, so they wait for consent.
  const REMOTE_ATTRS = ["src", "srcset", "poster", "background"];
  const REMOTE_URL = /(^|[\s,])(https?:)?\/\//i;
  function holdRemoteMedia(root) {
    let held = 0;
    root.querySelectorAll("[src], [srcset], [poster], [background]").forEach(node => {
      let hit = false;
      for (const attr of REMOTE_ATTRS) {
        const value = node.getAttribute(attr);
        if (!value || !REMOTE_URL.test(value.trim())) continue;
        node.setAttribute("data-remote-" + attr, value);
        node.removeAttribute(attr);
        hit = true;
      }
      if (hit) { node.classList.add("remote-held"); held++; }
    });
    return held;
  }
  function releaseRemoteMedia(root) {
    $$(".remote-held", root).forEach(node => {
      for (const attr of REMOTE_ATTRS) {
        const value = node.getAttribute("data-remote-" + attr);
        if (value === null) continue;
        node.setAttribute(attr, value);
        node.removeAttribute("data-remote-" + attr);
      }
      node.classList.remove("remote-held");
    });
  }
  function showRemoteNotice(article, count) {
    const bar = document.createElement("div");
    bar.className = "remote-notice";
    bar.setAttribute("role", "note");
    bar.innerHTML = `
      <span>${count} remote image${count === 1 ? "" : "s"} blocked. Loading ${count === 1 ? "it" : "them"} tells the host you opened this file.</span>
      <button type="button" data-remote="once">Load</button>
      <button type="button" data-remote="always">Always load</button>
    `;
    bar.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-remote]");
      if (!btn) return;
      if (btn.dataset.remote === "always") {
        tweaks.remoteImages = "load";
        persistTweaks();
        syncTweakControls();
      }
      releaseRemoteMedia(article);
      bar.remove();
    });
    article.prepend(bar);
  }

  // Relative image paths point into the opened folder, not next to index.html.
  const HAS_SCHEME = /^([a-z][a-z\d+.-]*:|\/\/)/i;
  function holdLocalMedia(root) {
    root.querySelectorAll("[src]").forEach(node => {
      const src = node.getAttribute("src");
      if (!src || HAS_SCHEME.test(src)) return;
      node.setAttribute("data-local-src", src);
      node.removeAttribute("src");
      node.removeAttribute("srcset");
    });
  }
  function loadLocalMedia(root, f, gen) {
    return Promise.all($$("[data-local-src]", root).map(async node => {
      const path = resolvePath(f.path, node.getAttribute("data-local-src")).path;
      const src = findAsset(path);
      if (!src) { markMissing(node, path); return; }
      try {
        const blob = await assetBlob(src, path);
        if (gen !== renderGen) return;
        const url = URL.createObjectURL(blob);
        blobUrls.push(url);
        node.setAttribute("src", url);
      } catch (_) {
        markMissing(node, path);
      }
    }));
  }
  function markMissing(node, path) {
    node.classList.add("missing-asset");
    node.title = `Not found in this folder: ${path}`;
  }
  function revokeBlobUrls() {
    blobUrls.forEach(u => URL.revokeObjectURL(u));
    blobUrls = [];
  }

  function renderCrumbs(f) {
    const parts = f.path.split("/");
    const frag = document.createDocumentFragment();
    parts.forEach((p, i) => {
      const span = document.createElement("span");
      span.className = i === parts.length - 1 ? "cur" : "";
      span.textContent = p;
      frag.appendChild(span);
      if (i < parts.length - 1) {
        const sep = document.createElement("span");
        sep.className = "sep";
        sep.textContent = "/";
        frag.appendChild(sep);
      }
    });
    const spacer = document.createElement("span");
    spacer.className = "spacer";
    frag.appendChild(spacer);
    const meta = document.createElement("span");
    meta.className = "meta";
    if (f.size) meta.textContent = formatSize(f.size);
    frag.appendChild(meta);
    el.crumbs.innerHTML = "";
    el.crumbs.appendChild(frag);
  }

  function showSplash() {
    el.reader.replaceChildren(el.splash);
    el.crumbs.innerHTML = `<span class="meta">No document selected</span>`;
    document.title = APP_TITLE;
    renderOutline(null);
    if (location.hash.startsWith("#/")) history.replaceState(null, "", location.pathname + location.search);
  }

  // ---------------------------------------------------------------
  // Links inside documents
  // ---------------------------------------------------------------
  // Resolve a link against the folder of `fromPath`; "/x" starts at the opened folder's root.
  function resolvePath(fromPath, ref) {
    const hashAt = ref.indexOf("#");
    const fragment = hashAt < 0 ? "" : safeDecode(ref.slice(hashAt + 1));
    const raw = (hashAt < 0 ? ref : ref.slice(0, hashAt)).split("?")[0];
    const out = raw.startsWith("/") ? [] : fromPath.split("/").slice(0, -1);
    for (const seg of raw.split("/").map(safeDecode)) {
      if (!seg || seg === ".") continue;
      if (seg === "..") out.pop();
      else out.push(seg);
    }
    return { path: out.join("/"), fragment, rooted: raw.startsWith("/") };
  }
  function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (_) { return s; }
  }
  function fileByPath(path) {
    const lower = path.toLowerCase();
    return state.files.find(f => f.path === path) || state.files.find(f => f.path.toLowerCase() === lower) || null;
  }
  function findAsset(path) {
    if (state.assets.has(path)) return state.assets.get(path);
    const lower = path.toLowerCase();
    for (const [p, src] of state.assets) if (p.toLowerCase() === lower) return src;
    return null;
  }

  // The loaded file a link points at, trying the spellings docs sites use:
  // "x", "x.html", "x/" (its README or index), and "/x" from a site root nested in the folder.
  function findLinkedFile(fromPath, target) {
    const bases = [target.path];
    if (target.rooted) {
      const dirs = fromPath.split("/").slice(0, -1);
      for (let i = 1; i <= dirs.length; i++) bases.push(dirs.slice(0, i).join("/") + "/" + target.path);
      const rootPrefix = state.rootName + "/";
      if (state.rootName && target.path.startsWith(rootPrefix)) bases.push(target.path.slice(rootPrefix.length));
    }
    for (const base of bases) {
      const b = base.replace(/\/+$/, "");
      const tries = b
        ? [b, b.replace(/\.html?$/i, ".md"), b + ".md", b + ".markdown", b + "/README.md", b + "/index.md"]
        : ["README.md", "index.md"];
      for (const p of tries) {
        const f = fileByPath(p);
        if (f) return f;
      }
    }
    return null;
  }

  // Point every link at something that works here: docs open in the app (their href is the
  // app's own URL, so new-tab clicks work too), other files open from the folder.
  function wireLinks(root, f) {
    $$("a[href]", root).forEach(a => {
      if (a.classList.contains("wiki-link")) { wireWikiLink(a); return; }
      const href = a.getAttribute("href");
      if (HAS_SCHEME.test(href)) {
        if (/^(https?:)?\/\//i.test(href)) {
          a.setAttribute("target", "_blank");
          a.setAttribute("rel", "noopener noreferrer");
        }
        return;
      }
      if (href.startsWith("#")) { pointAt(a, f, safeDecode(href.slice(1))); return; }
      const target = resolvePath(f.path, href);
      const doc = findLinkedFile(f.path, target);
      if (doc) pointAt(a, doc, target.fragment);
      else if (findAsset(target.path)) a.dataset.asset = target.path;
      else markBroken(a, target.path, `Not found in this folder: ${target.path}`);
    });
  }
  function pointAt(a, doc, anchor) {
    a.dataset.path = doc.path;
    a.dataset.anchor = anchor || "";
    a.setAttribute("href", routeHash(doc.path, anchor));
  }
  function markBroken(a, path, message) {
    a.classList.add("broken-link");
    a.dataset.missing = path;
    a.title = message;
  }
  function wireWikiLink(a) {
    const [name, heading = ""] = (a.dataset.wikiTarget || "").split("#");
    const doc = findWikiFile(name);
    if (doc) pointAt(a, doc, heading.trim() ? githubSlug(heading) : "");
    else markBroken(a, name, `No file named "${name.trim()}" in this folder`);
  }

  function followDocLink(path, anchor) {
    const doc = fileByPath(path);
    if (!doc) return;
    if (doc.id === state.activeId) goToAnchor(anchor);
    else openFile(doc.id, { anchor });
  }
  async function openAsset(path) {
    const src = findAsset(path);
    if (!src) return;
    try {
      const url = URL.createObjectURL(await assetBlob(src, path));
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (_) {
      toast(`Could not open ${path}`);
    }
  }

  function goToAnchor(anchor, nav = "push") {
    const f = activeFile();
    if (f) setRoute(f.path, anchor, nav);
    scrollToAnchor(anchor);
  }
  function scrollToAnchor(anchor) {
    const target = findAnchor(anchor);
    if (target) target.scrollIntoView({ block: "start" });
    else if (!anchor) el.reader.scrollTop = 0;
  }
  function findAnchor(anchor) {
    const article = $("#readerInner");
    if (!article || !anchor) return null;
    for (const id of [ID_PREFIX + anchor, anchor]) {
      const q = CSS.escape(id);
      const node = article.querySelector(`[id="${q}"], [name="${q}"]`);
      if (node) return node;
    }
    return null;
  }

  // ---------------------------------------------------------------
  // Outline
  // ---------------------------------------------------------------
  let outlineTargets = [];
  function renderOutline(article, f) {
    const heads = article ? $$("h1, h2, h3", article).filter(h => h.id) : [];
    const show = !!tweaks.outline && heads.length >= 3;
    outlineTargets = show ? heads : [];
    el.outline.hidden = !show;
    el.outline.replaceChildren();
    if (!show) return;
    const title = document.createElement("div");
    title.className = "outline-title";
    title.textContent = "On this page";
    el.outline.append(title);
    const top = Math.min(...heads.map(h => +h.tagName[1]));
    for (const h of heads) {
      const anchor = h.id.startsWith(ID_PREFIX) ? h.id.slice(ID_PREFIX.length) : h.id;
      const a = document.createElement("a");
      a.href = routeHash(f.path, anchor);
      a.dataset.anchor = anchor;
      a.className = `lvl-${+h.tagName[1] - top}`;
      a.textContent = headingText(h);
      el.outline.append(a);
    }
    syncOutline();
  }
  function syncOutline() {
    if (!outlineTargets.length) return;
    const line = el.reader.getBoundingClientRect().top + 90;
    let current = 0;
    outlineTargets.forEach((h, i) => { if (h.getBoundingClientRect().top <= line) current = i; });
    $$("a", el.outline).forEach((a, i) => a.classList.toggle("on", i === current));
  }
  function refreshOutline() {
    const f = activeFile();
    renderOutline(f ? $("#readerInner") : null, f);
  }

  // ---------------------------------------------------------------
  // Routing: the URL hash names the open file and heading, "#/plans/a.md#goal"
  // ---------------------------------------------------------------
  function routeHash(path, anchor) {
    return "#/" + path.split("/").map(encodeURIComponent).join("/") + (anchor ? "#" + encodeURIComponent(anchor) : "");
  }
  function parseRoute() {
    if (!location.hash.startsWith("#/")) return null;
    const rest = location.hash.slice(2);
    const at = rest.indexOf("#");
    return {
      path: (at < 0 ? rest : rest.slice(0, at)).split("/").map(safeDecode).join("/"),
      anchor: at < 0 ? "" : safeDecode(rest.slice(at + 1)),
    };
  }
  function setRoute(path, anchor, nav) {
    const hash = routeHash(path, anchor);
    if (nav === "none" || location.hash === hash) return;
    if (nav === "replace") history.replaceState(null, "", hash);
    else history.pushState(null, "", hash);
  }

  // ---------------------------------------------------------------
  // Live reload
  // ---------------------------------------------------------------
  // The open file is re-read when it changes on disk, and the folder is rescanned for added or
  // removed files. Needs real file handles (Chromium); uploaded files are fixed snapshots.
  const LIVE_FILE_MS = 2000;
  const LIVE_FOLDER_MS = 6000;
  let checkingFile = false;
  let rescanning = false;
  let lastScanMs = 0;

  async function checkOpenFile() {
    const f = activeFile();
    if (!f || f.kind !== "handle" || checkingFile || document.hidden) return;
    checkingFile = true;
    try {
      const file = await f.handle.getFile();
      if (f !== activeFile() || file.lastModified === state.activeStamp) return;
      const text = await file.text();
      if (f !== activeFile()) return;
      state.activeStamp = file.lastModified;
      state.stamps.set(f.path, file.lastModified);
      contentCache.delete(f.id);
      const before = blockCounts($("#readerInner"));
      const top = el.reader.scrollTop;
      renderDocument(f, text);
      el.reader.scrollTop = top;
      const changed = markChanges($("#readerInner"), before);
      toast(changed
        ? `Reloaded ${f.name} · ${changed} change${changed === 1 ? "" : "s"} highlighted`
        : `Reloaded ${f.name} — it changed on disk`, 2000);
    } catch (e) {
      if (e && e.name === "NotFoundError") rescanFolder();
    } finally {
      checkingFile = false;
    }
  }

  async function rescanFolder({ manual = false } = {}) {
    if (!state.root || rescanning) return;
    rescanning = true;
    try {
      const scan = await scanDirHandle(state.root, "", newScan({ quiet: !manual }));
      const stamps = await readStamps(scan.files);
      lastScanMs = Date.now() - scan.started;
      applyRescan(scan, stamps, manual);
    } catch (e) {
      console.warn(e);
      if (manual) toast("Could not rescan the folder");
    } finally {
      rescanning = false;
    }
  }

  function applyRescan(scan, stamps, manual) {
    for (const [p, src] of scan.assets) state.assets.set(p, src);
    const before = new Set(state.files.filter(f => f.fromRoot).map(f => f.path));
    const found = scan.files.filter(f => !state.removed.has(f.path));
    const foundPaths = new Set(found.map(f => f.path));
    const added = found.filter(f => !before.has(f.path));
    const gone = state.files.filter(f => f.fromRoot && !foundPaths.has(f.path));
    const active = activeFile();

    // Files edited since you last looked, and new ones, stay marked until opened.
    // The open file is skipped: live reload shows its changes in place.
    let edited = 0;
    for (const [path, stamp] of stamps) {
      const seen = state.stamps.get(path);
      state.stamps.set(path, stamp);
      if (seen === undefined || seen === stamp || state.removed.has(path) || (active && active.path === path)) continue;
      if (!state.unseen.has(path)) { state.unseen.add(path); edited++; }
    }
    for (const f of added) state.unseen.add(f.path);

    if (!added.length && !gone.length && !edited) {
      if (manual) toast("No new, changed or removed files");
      return;
    }
    for (const f of added) f.fromRoot = true;
    const goneIds = new Set(gone.map(f => f.id));
    state.files = sortFiles([...state.files.filter(f => !goneIds.has(f.id)), ...added]);
    for (const f of gone) {
      contentCache.delete(f.id);
      state.unseen.delete(f.path);
      state.stamps.delete(f.path);
    }
    renderFiles();
    renderTopMeta();
    if (active && goneIds.has(active.id)) {
      state.activeId = null;
      toast(`${active.name} was moved or deleted`, 3000);
    } else if (added.length || gone.length || manual) {
      const parts = [];
      if (added.length) parts.push(`${added.length} new file${added.length === 1 ? "" : "s"}`);
      if (edited) parts.push(`${edited} changed`);
      if (gone.length) parts.push(`${gone.length} removed`);
      toast(parts.join(" · "));
    }
  }

  // lastModified of every file read through a live handle.
  async function readStamps(files) {
    const stamps = new Map();
    const queue = files.filter(f => f.kind === "handle");
    let next = 0;
    const worker = async () => {
      while (next < queue.length) {
        const f = queue[next++];
        try { stamps.set(f.path, (await f.handle.getFile()).lastModified); } catch (_) {}
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    return stamps;
  }

  // The pieces of a document a reader notices changing: paragraphs, list items, table rows, code blocks…
  function readingBlocks(article) {
    const blocks = [];
    for (const node of article ? article.children : []) {
      if (node.matches(".remote-notice")) continue;
      if (node.matches(".code-block")) blocks.push(node.querySelector("pre"));
      else if (node.matches("ul, ol")) blocks.push(...node.querySelectorAll(":scope > li"));
      else if (node.matches("table, section")) blocks.push(...node.querySelectorAll("tr, li"));
      else blocks.push(node);
    }
    return blocks;
  }
  function blockKey(node) {
    const media = $$("img", node).map(i => i.getAttribute("data-local-src") || i.getAttribute("data-remote-src") || i.getAttribute("src") || "");
    return `${node.tagName}|${node.textContent.replace(/\s+/g, " ").trim()}|${media.join(",")}`;
  }
  function blockCounts(article) {
    const counts = new Map();
    for (const node of readingBlocks(article)) {
      const key = blockKey(node);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }

  // Tint the blocks that weren't in the previous render; each fades a few seconds after you've seen it.
  let changeObserver = null;
  function markChanges(article, before) {
    if (changeObserver) changeObserver.disconnect();
    const changed = readingBlocks(article).filter(node => {
      const key = blockKey(node), n = before.get(key) || 0;
      if (n) before.set(key, n - 1);
      return !n;
    });
    const observer = changeObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        setTimeout(() => entry.target.classList.add("settled"), 4000);
      }
    }, { root: el.reader });
    for (const node of changed) {
      node.classList.add("changed");
      observer.observe(node);
    }
    return changed.length;
  }

  // ---------------------------------------------------------------
  // Recents
  // ---------------------------------------------------------------
  const RECENT_LIMIT = 5;

  // Best effort: failing to save history must never stop a folder from opening.
  async function rememberFolder({ key, name, source, handle, fileCount }) {
    try {
      const all = await idbGetAll();
      const prev = key ? all.find(r => r.key === key) : await findSameFolder(all, name, source, handle);
      const entry = {
        ...prev,
        key: prev ? prev.key : `${source === "handle" ? "h" : "u"}::${name}::${Date.now().toString(36)}`,
        name, source, fileCount, at: Date.now(),
      };
      if (handle) entry.handle = handle;
      await idbPut(entry);
      const older = all.filter(r => r.key !== entry.key).sort((a, b) => b.at - a.at);
      for (const r of older.slice(RECENT_LIMIT - 1)) await idbDel(r.key);
      await loadRecents();
      return entry.key;
    } catch (e) {
      console.warn("Could not save this folder to Recent", e);
      return null;
    }
  }
  async function findSameFolder(all, name, source, handle) {
    for (const r of all) {
      if (r.source !== source || r.name !== name) continue;
      // Uploads have no handle to compare, so the same name is the best match there is.
      if (!handle || !r.handle || typeof r.handle.isSameEntry !== "function") return r;
      try { if (await r.handle.isSameEntry(handle)) return r; } catch (_) {}
    }
    return null;
  }
  async function loadRecents() {
    try {
      const all = await idbGetAll();
      state.recents = all.sort((a, b) => b.at - a.at).slice(0, RECENT_LIMIT);
    } catch (_) {
      state.recents = [];
    }
    renderRecents();
  }
  async function rememberLastFile(f) {
    if (!state.activeFolderKey) return;
    try {
      const rec = await idbGet(state.activeFolderKey);
      if (!rec) return;
      rec.lastFilePath = f.path;
      rec.at = Date.now();
      await idbPut(rec);
      const cached = state.recents.find(r => r.key === rec.key);
      if (cached) Object.assign(cached, { lastFilePath: rec.lastFilePath, at: rec.at });
      state.recents.sort((a, b) => b.at - a.at);
      renderRecents();
    } catch (_) {}
  }

  async function reopenRecent(r) {
    if (r.source !== "handle" || !r.handle || !r.handle.requestPermission) {
      toast("Re-select this folder — browser can't restore uploads");
      openFolderViaInput();
      return;
    }
    try {
      let perm = await r.handle.queryPermission({ mode: "read" });
      if (perm !== "granted") perm = await r.handle.requestPermission({ mode: "read" });
      if (perm !== "granted") { toast("Permission denied"); return; }
      const scan = await scanDirHandle(r.handle);
      if (!scan.files.length) { toast("No .md / .txt files in that folder anymore"); return; }
      await loadFolder({ name: r.name, source: "handle", handle: r.handle, scan, recentKey: r.key, lastFilePath: r.lastFilePath });
    } catch (e) {
      console.warn(e);
      toast("Could not re-open folder");
    }
  }

  // Pick up the last folder on load: straight away if the browser kept read access, else one click away.
  let resumeTarget = null;
  async function offerResume() {
    const last = state.recents.find(r => r.source === "handle" && r.handle && r.handle.queryPermission);
    if (!last || state.files.length) return;
    try {
      if (await last.handle.queryPermission({ mode: "read" }) === "granted") {
        await reopenRecent(last);
        return;
      }
    } catch (_) {}
    resumeTarget = last;
    $(".resume-name", el.splashResume).textContent = last.name;
    $(".resume-file", el.splashResume).textContent = last.lastFilePath || "";
    el.splashResume.hidden = false;
  }

  // ---------------------------------------------------------------
  // Content search
  // ---------------------------------------------------------------
  const contentCache = new Map();   // file id -> { stamp, lower }
  let contentLoad = null;
  let contentCheckedAt = 0;

  // Read every file once so the filter can search inside them; re-check for edits every few seconds.
  function loadContents() {
    if (contentLoad) return contentLoad;
    const recheck = Date.now() - contentCheckedAt > 5000;
    const files = state.files.filter(f => recheck || !contentCache.has(f.id));
    contentLoad = (async () => {
      let changed = false, next = 0;
      const worker = async () => {
        while (next < files.length) {
          const f = files[next++];
          try {
            const file = await fileObject(f);
            if (contentCache.get(f.id)?.stamp === file.lastModified) continue;
            contentCache.set(f.id, { stamp: file.lastModified, lower: (await file.text()).toLowerCase() });
            changed = true;
          } catch (_) {}
        }
      };
      await Promise.all(Array.from({ length: 6 }, worker));
      if (recheck) contentCheckedAt = Date.now();
      return changed;
    })().finally(() => { contentLoad = null; });
    return contentLoad;
  }

  function runSearch(value) {
    state.searchQuery = value;
    state.filterCollapsed = {};
    renderFiles();
    highlightHits($("#readerInner"));
    if (state.contentSearch && value.trim()) {
      loadContents().then(changed => { if (changed) renderFiles(); });
    }
  }

  // Mark content-search matches in the open document.
  function highlightHits(root) {
    if (!root) return;
    $$("mark.hit", root).forEach(m => m.replaceWith(...m.childNodes));
    root.normalize();
    const q = state.contentSearch ? state.searchQuery.trim().toLowerCase() : "";
    if (!q) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: node => node.parentElement.closest(".remote-notice, .heading-anchor")
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    const nodes = [];
    while (walker.nextNode()) {
      if (walker.currentNode.nodeValue.toLowerCase().includes(q)) nodes.push(walker.currentNode);
    }
    for (const node of nodes) {
      const text = node.nodeValue, lower = text.toLowerCase();
      const frag = document.createDocumentFragment();
      let from = 0;
      for (let at = lower.indexOf(q); at >= 0; at = lower.indexOf(q, at + q.length)) {
        frag.append(text.slice(from, at));
        const mark = document.createElement("mark");
        mark.className = "hit";
        mark.textContent = text.slice(at, at + q.length);
        frag.append(mark);
        from = at + q.length;
      }
      frag.append(text.slice(from));
      node.replaceWith(frag);
    }
  }

  // ---------------------------------------------------------------
  // Utils
  // ---------------------------------------------------------------
  function timeAgo(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 10) return "just now";
    if (s < 60) return s + "s ago";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    const h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    const d = Math.floor(h / 24);
    if (d < 7) return d + "d ago";
    return new Date(ts).toLocaleDateString();
  }
  function formatSize(b) {
    if (b < 1024) return b + " B";
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
    return (b / 1024 / 1024).toFixed(2) + " MB";
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // GitHub's heading ids (github-slugger): lowercase, drop punctuation, spaces become "-".
  function githubSlug(text) {
    return String(text || "").trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "").replace(/ /g, "-");
  }
  // Repeated headings get -1, -2, … like on GitHub.
  function makeSlugger() {
    const seen = new Map();
    return (text) => {
      const base = githubSlug(text) || "section";
      let slug = base;
      while (seen.has(slug)) {
        seen.set(base, seen.get(base) + 1);
        slug = `${base}-${seen.get(base)}`;
      }
      seen.set(slug, 0);
      return slug;
    };
  }

  function enhanceHeadingAnchors(root) {
    if (!root) return;
    const slug = makeSlugger();
    $$("h1,h2,h3,h4,h5,h6", root).forEach(heading => {
      $(".heading-anchor", heading)?.remove();
      if (!heading.id) heading.id = ID_PREFIX + slug(heading.textContent);

      const anchor = document.createElement("a");
      anchor.className = "heading-anchor";
      anchor.href = "#" + (heading.id.startsWith(ID_PREFIX) ? heading.id.slice(ID_PREFIX.length) : heading.id);
      anchor.setAttribute("aria-label", `Link to ${heading.textContent}`);
      anchor.textContent = "#";
      heading.appendChild(anchor);
    });
  }
  function headingText(h) {
    const copy = h.cloneNode(true);
    copy.querySelector(".heading-anchor")?.remove();
    return copy.textContent.trim();
  }

  function normalizeWikiTarget(value) {
    return String(value || "")
      .split("#")[0]
      .trim()
      .replace(/\\/g, "/")
      .replace(/\.(md|markdown|txt)$/i, "")
      .toLowerCase();
  }

  function findWikiFile(target) {
    const normalized = normalizeWikiTarget(target);
    if (!normalized) return null;

    return state.files.find(file => {
      const path = normalizeWikiTarget(file.path || file.name);
      const name = normalizeWikiTarget(file.name);
      return path === normalized || name === normalized || path.endsWith(`/${normalized}`);
    }) || null;
  }

  // GitHub alerts and Obsidian callouts ("> [!note]"): type -> [style, label, icon].
  const CALLOUTS = {
    note: ["info", "Note", "i"], info: ["info", "Info", "i"], todo: ["info", "Todo", "i"],
    abstract: ["info", "Abstract", "i"], summary: ["info", "Summary", "i"], tldr: ["info", "TL;DR", "i"],
    example: ["info", "Example", "i"], quote: ["info", "Quote", "”"], cite: ["info", "Cite", "”"],
    tip: ["question", "Tip", "✓"], hint: ["question", "Hint", "✓"], success: ["question", "Success", "✓"],
    check: ["question", "Check", "✓"], done: ["question", "Done", "✓"],
    question: ["question", "Question", "?"], help: ["question", "Help", "?"], faq: ["question", "FAQ", "?"],
    important: ["important", "Important", "!"],
    warning: ["warning", "Warning", "!"], warn: ["warning", "Warning", "!"], attention: ["warning", "Attention", "!"],
    caution: ["danger", "Caution", "!"], danger: ["danger", "Danger", "!"], error: ["danger", "Error", "!"],
    bug: ["danger", "Bug", "!"], failure: ["danger", "Failure", "×"], fail: ["danger", "Fail", "×"], missing: ["danger", "Missing", "×"],
  };

  // Only the marker text is removed, so links and formatting in the callout survive.
  function enhanceCallouts(root) {
    if (!root) return;
    $$("blockquote", root).forEach(blockquote => {
      const first = blockquote.firstElementChild;
      const lead = first && first.tagName === "P" ? first.firstChild : null;
      if (!lead || lead.nodeType !== Node.TEXT_NODE) return;
      const match = lead.nodeValue.match(/^\s*\[!([a-z]+)\][+-]?[ \t]*\n?/i);
      const kind = match && CALLOUTS[match[1].toLowerCase()];
      if (!kind) return;

      const [style, label, iconText] = kind;
      lead.nodeValue = lead.nodeValue.slice(match[0].length);
      if (!first.textContent.trim() && !first.querySelector("img")) first.remove();

      blockquote.classList.add("callout", `callout-${style}`);
      blockquote.setAttribute("role", "note");

      const icon = document.createElement("span");
      icon.className = "callout-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = iconText;

      const title = document.createElement("div");
      title.className = "callout-title";
      title.append(icon, document.createTextNode(label));

      const body = document.createElement("div");
      body.className = "callout-body";
      while (blockquote.firstChild) {
        body.appendChild(blockquote.firstChild);
      }

      blockquote.append(title, body);
    });
  }

  function highlightCodeBlocks(root) {
    if (!root || !window.hljs) return;
    $$("pre code", root).forEach(code => {
      try {
        window.hljs.highlightElement(code);
      } catch (_) {}
    });
  }

  // The button sits in a wrapper outside the scrolling <pre>, so it stays in the corner.
  function addCopyButtons(root) {
    $$("pre:not(.plain)", root).forEach(pre => {
      const wrap = document.createElement("div");
      wrap.className = "code-block";
      pre.replaceWith(wrap);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "copy-code";
      btn.textContent = "Copy";
      btn.setAttribute("aria-label", "Copy code");
      wrap.append(pre, btn);
    });
  }
  const copyTimers = new WeakMap();
  async function copyCode(btn) {
    // Without the trailing newline, a pasted command doesn't run before you've looked at it.
    const text = btn.parentElement.querySelector("pre").textContent.replace(/\n$/, "");
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      // Older browsers, or a blocked clipboard API: copy through a hidden textarea.
      const buffer = document.createElement("textarea");
      buffer.className = "clipboard-buffer";
      buffer.value = text;
      document.body.append(buffer);
      buffer.select();
      document.execCommand("copy");
      buffer.remove();
    }
    btn.textContent = "Copied";
    btn.classList.add("done");
    clearTimeout(copyTimers.get(btn));
    copyTimers.set(btn, setTimeout(() => {
      btn.textContent = "Copy";
      btn.classList.remove("done");
    }, 1500));
  }

  function buildInlineTokenFragment(text) {
    const pattern = /(\[\[([^\]|]+)(?:\|([^\]]+))?\]\])|(^|[\s(])#([_\p{Letter}\p{Number}][_\p{Letter}\p{Number}/-]*)/gu;
    const fragment = document.createDocumentFragment();
    let index = 0;
    let match;

    while ((match = pattern.exec(text))) {
      // Tags need a letter: "#123" is an issue or PR number.
      if (!match[1] && !/\p{Letter}/u.test(match[5])) continue;
      const start = match.index;
      if (start > index) fragment.append(document.createTextNode(text.slice(index, start)));

      if (match[1]) {
        const target = match[2].trim();
        const label = (match[3] || target).trim();
        const link = document.createElement("a");
        link.className = "wiki-link";
        link.href = "#";
        link.dataset.wikiTarget = target;
        link.title = target;
        link.textContent = label;
        fragment.append(link);
        index = start + match[1].length;
      } else {
        const prefix = match[4] || "";
        const tag = match[5];
        if (prefix) fragment.append(document.createTextNode(prefix));

        const chip = document.createElement("span");
        chip.className = "tag-token";
        chip.textContent = `#${tag}`;
        fragment.append(chip);
        index = start + prefix.length + tag.length + 1;
      }
    }

    if (index < text.length) fragment.append(document.createTextNode(text.slice(index)));
    return index ? fragment : null;
  }

  function enhanceInlineTokens(root) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || !node.nodeValue || !/(\[\[|#[_\p{Letter}\p{Number}])/u.test(node.nodeValue)) {
          return NodeFilter.FILTER_REJECT;
        }
        if (parent.closest("a,code,pre,script,style,textarea,.heading-anchor,.tag-token,.wiki-link")) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    nodes.forEach(node => {
      const fragment = buildInlineTokenFragment(node.nodeValue);
      if (fragment) node.replaceWith(fragment);
    });
  }

  function splitFrontmatter(text) {
    const match = String(text || "").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
    if (!match) return { frontmatter: null, body: text };
    return { frontmatter: match[1], body: match[2] };
  }

  function parseFrontmatterValue(rawValue) {
    const value = String(rawValue || "").trim();
    if (
      (value.startsWith("[") && value.endsWith("]")) ||
      (value.startsWith("{") && value.endsWith("}"))
    ) {
      try {
        const parsed = JSON.parse(value.replace(/'/g, '"'));
        if (Array.isArray(parsed)) return parsed.join(", ");
        if (parsed && typeof parsed === "object") {
          return Object.entries(parsed).map(([k, v]) => `${k}: ${v}`).join(", ");
        }
      } catch (_) {}
    }
    return value.replace(/^["']|["']$/g, "");
  }

  function renderFrontmatterTable(source) {
    if (!source) return "";
    const rows = [];
    let currentKey = null;

    source.split(/\r?\n/).forEach(line => {
      if (!line.trim() || line.trim().startsWith("#")) return;

      const listItem = line.match(/^\s*-\s+(.+)$/);
      if (listItem && currentKey) {
        const last = rows[rows.length - 1];
        last.value = last.value ? `${last.value}, ${parseFrontmatterValue(listItem[1])}` : parseFrontmatterValue(listItem[1]);
        return;
      }

      const pair = line.match(/^([^:\n]+):\s*(.*)$/);
      if (!pair) {
        currentKey = null;
        return;
      }

      currentKey = pair[1].trim();
      rows.push({ key: currentKey, value: parseFrontmatterValue(pair[2]) });
    });

    if (!rows.length) return "";

    return `<section class="frontmatter" aria-label="Document frontmatter">
      <table>
        <tbody>
          ${rows.map(row => `
            <tr>
              <th scope="row">${escapeHtml(row.key)}</th>
              <td>${escapeHtml(row.value || "—")}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </section>`;
  }

  // GFM footnotes for marked: "[^id]" references and "[^id]: text" definitions,
  // numbered in order of first reference and listed at the end.
  function markedFootnotes() {
    let defs = new Map(), order = [];
    const key = id => id.toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, "-");
    return {
      hooks: {
        preprocess(src) { defs = new Map(); order = []; return src; },
        postprocess(html) {
          const used = order.filter(id => defs.get(id)?.html !== undefined);
          if (!used.length) return html;
          const items = used.map(id => {
            const back = ` <a href="#fnref-${key(id)}" class="footnote-backref" aria-label="Back to text">↩</a>`;
            const body = defs.get(id).html;
            // The back link goes inside the last paragraph when there is one.
            const withBack = /<\/p>\s*$/.test(body) ? body.replace(/<\/p>\s*$/, back + "</p>") : body + back;
            return `<li id="fn-${key(id)}">${withBack}</li>`;
          });
          return `${html}<section class="footnotes" aria-label="Footnotes"><ol>${items.join("")}</ol></section>`;
        },
      },
      extensions: [
        {
          name: "footnoteDef",
          level: "block",
          start: src => src.match(/^\[\^[^\]\s]+\]:/m)?.index,
          tokenizer(src) {
            const match = /^\[\^([^\]\s]+)\]:[ \t]*([^\n]*(?:\n+(?: {2,}|\t)[^\n]*)*)(?:\n|$)/.exec(src);
            if (!match) return;
            const token = { type: "footnoteDef", raw: match[0], id: match[1], tokens: [] };
            this.lexer.blockTokens(match[2].replace(/^(?: {1,4}|\t)/gm, ""), token.tokens);
            defs.set(match[1], token);
            return token;
          },
          renderer(token) {
            token.html = this.parser.parse(token.tokens);
            return "";
          },
        },
        {
          name: "footnoteRef",
          level: "inline",
          start: src => { const i = src.indexOf("[^"); return i < 0 ? undefined : i; },
          tokenizer(src) {
            const match = /^\[\^([^\]\s]+)\]/.exec(src);
            if (match && defs.has(match[1])) return { type: "footnoteRef", raw: match[0], id: match[1] };
          },
          renderer(token) {
            let n = order.indexOf(token.id) + 1;
            const first = !n;
            if (first) n = order.push(token.id);
            return `<sup class="footnote-ref"><a href="#fn-${key(token.id)}"${first ? ` id="fnref-${key(token.id)}"` : ""}>${n}</a></sup>`;
          },
        },
      ],
    };
  }

  // ---------------------------------------------------------------
  // Tweaks
  // ---------------------------------------------------------------
  const TWEAK_KEY = "mdviewer.tweaks.v2";
  const defaults = window.TWEAK_DEFAULTS || {
    bodySize: 16, readingWidth: 76, bodyFace: "sans", theme: "slate", outline: true, remoteImages: "block"
  };

  let tweaks = { ...defaults };
  try {
    const saved = JSON.parse(localStorage.getItem(TWEAK_KEY) || "null");
    const old = saved ? null : JSON.parse(localStorage.getItem("mdviewer.tweaks.v1") || "null");
    if (saved && typeof saved === "object") {
      tweaks = { ...defaults, ...saved };
    } else if (old && typeof old === "object") {
      // The redesign moves everyone to Slate once; settings still at the old defaults move to the new ones.
      tweaks = { ...defaults, ...old, theme: defaults.theme };
      if (old.readingWidth === 120) tweaks.readingWidth = defaults.readingWidth;
      if (old.bodySize === 17) tweaks.bodySize = defaults.bodySize;
      if (old.bodyFace === "serif") tweaks.bodyFace = defaults.bodyFace;
      persistTweaks();
    }
  } catch (_) {}

  function persistTweaks() {
    try { localStorage.setItem(TWEAK_KEY, JSON.stringify(tweaks)); } catch (_) {}
  }

  // Slate and Paper name their layers (surface, line); the other themes get them mixed from paper and ink.
  const THEMES = {
    "slate": { accent: "#88c0d0", accent2: "#3b4956", paper: "#2e3440", ink: "#edeff4", ink2: "#d8dee9", ink3: "#a6b1c5", ink4: "#7b869c", surface: "#3b4252", surface2: "#434c5e", line: "#3e4555", line2: "#434c5d" },
    "paper": { accent: "#8f6023", accent2: "#f1e6d2", paper: "#faf8f3", ink: "#1a1814", ink2: "#3a352c", ink3: "#6b6558", ink4: "#9a9383", surface: "#f2eee5", surface2: "#e9e3d5", line: "#e6e0d1", line2: "#d6ceb9" },
    "catppuccin-latte": { accent: "#8839ef", accent2: "#eadcf8", paper: "#eff1f5", p2: "#e6e9ef", p3: "#dce0e8", ink: "#4c4f69", ink2: "#5c5f77", ink3: "#6c6f85", ink4: "#8c8fa1", rule: "#ccd0da", rule2: "#bcc0cc" },
    "catppuccin-mocha": { accent: "#cba6f7", accent2: "#332641", paper: "#1e1e2e", p2: "#181825", p3: "#313244", ink: "#cdd6f4", ink2: "#bac2de", ink3: "#9399b2", ink4: "#6c7086", rule: "#45475a", rule2: "#585b70" },
    "gruvbox-light": { accent: "#af3a03", accent2: "#f2e5bc", paper: "#fbf1c7", p2: "#f2e5bc", p3: "#ebdbb2", ink: "#3c3836", ink2: "#504945", ink3: "#7c6f64", ink4: "#928374", rule: "#d5c4a1", rule2: "#bdae93", infoAccent: "#076678", infoBg: "#f2e5bc", infoRule: "#458588", questionAccent: "#79740e", questionBg: "#f2e5bc", questionRule: "#98971a", warningAccent: "#b57614", warningBg: "#f2e5bc", warningRule: "#d79921" },
    "gruvbox-dark": { accent: "#fe8019", accent2: "#3c3836", paper: "#282828", p2: "#1d2021", p3: "#3c3836", ink: "#ebdbb2", ink2: "#d5c4a1", ink3: "#bdae93", ink4: "#a89984", rule: "#504945", rule2: "#665c54", infoAccent: "#83a598", infoBg: "#32302f", infoRule: "#458588", questionAccent: "#b8bb26", questionBg: "#32302f", questionRule: "#98971a", warningAccent: "#fabd2f", warningBg: "#32302f", warningRule: "#d79921" },
    "solarized-light": { accent: "#268bd2", accent2: "#d8edf4", paper: "#fdf6e3", p2: "#eee8d5", p3: "#e4dcc7", ink: "#073642", ink2: "#586e75", ink3: "#657b83", ink4: "#93a1a1", rule: "#d9d0b8", rule2: "#c8bea4" },
    "solarized-dark": { accent: "#2aa198", accent2: "#073e43", paper: "#002b36", p2: "#073642", p3: "#0f4652", ink: "#eee8d5", ink2: "#93a1a1", ink3: "#839496", ink4: "#657b83", rule: "#164b55", rule2: "#1f5d68" },
    "tokyo-night": { accent: "#7aa2f7", accent2: "#202b45", paper: "#1a1b26", p2: "#16161e", p3: "#24283b", ink: "#c0caf5", ink2: "#a9b1d6", ink3: "#9aa5ce", ink4: "#565f89", rule: "#414868", rule2: "#565f89" },
    "nord": { accent: "#88c0d0", accent2: "#334651", paper: "#2e3440", p2: "#252a33", p3: "#3b4252", ink: "#eceff4", ink2: "#e5e9f0", ink3: "#d8dee9", ink4: "#81a1c1", rule: "#4c566a", rule2: "#5e81ac", infoAccent: "#88c0d0", infoBg: "#303946", infoRule: "#5e81ac", questionAccent: "#a3be8c", questionBg: "#303a35", questionRule: "#8fbc8f", warningAccent: "#ebcb8b", warningBg: "#3c372f", warningRule: "#d08770" },
    "dracula": { accent: "#bd93f9", accent2: "#3b2d4d", paper: "#282a36", p2: "#21222c", p3: "#343746", ink: "#f8f8f2", ink2: "#e6e6dc", ink3: "#c7c7bd", ink4: "#9696a2", rule: "#44475a", rule2: "#6272a4" },
    "one-dark": { accent: "#61afef", accent2: "#233448", paper: "#282c34", p2: "#21252b", p3: "#3e4451", ink: "#abb2bf", ink2: "#c8ccd4", ink3: "#8b949e", ink4: "#5c6370", rule: "#3e4451", rule2: "#4b5263" },
  };

  const SYNTAX_THEMES = {
    "slate": { comment: "#616e88", keyword: "#81a1c1", string: "#a3be8c", title: "#88c0d0", variable: "#d8dee9", number: "#b48ead", attr: "#ebcb8b", addition: "#a3be8c", deletion: "#bf616a" },
    "paper": { comment: "#928374", keyword: "#9d0006", string: "#79740e", title: "#076678", variable: "#8f3f71", number: "#af3a03", attr: "#b57614", addition: "#79740e", deletion: "#9d0006" },
    "catppuccin-latte": { comment: "#8c8fa1", keyword: "#8839ef", string: "#40a02b", title: "#1e66f5", variable: "#dd7878", number: "#fe640b", attr: "#df8e1d", addition: "#40a02b", deletion: "#d20f39" },
    "catppuccin-mocha": { comment: "#6c7086", keyword: "#cba6f7", string: "#a6e3a1", title: "#89b4fa", variable: "#f5c2e7", number: "#fab387", attr: "#f9e2af", addition: "#a6e3a1", deletion: "#f38ba8" },
    "gruvbox-light": { comment: "#928374", keyword: "#9d0006", string: "#79740e", title: "#076678", variable: "#8f3f71", number: "#af3a03", attr: "#b57614", addition: "#79740e", deletion: "#9d0006" },
    "gruvbox-dark": { comment: "#928374", keyword: "#fb4934", string: "#b8bb26", title: "#83a598", variable: "#d3869b", number: "#fe8019", attr: "#fabd2f", addition: "#b8bb26", deletion: "#fb4934" },
    "solarized-light": { comment: "#93a1a1", keyword: "#859900", string: "#2aa198", title: "#268bd2", variable: "#6c71c4", number: "#d33682", attr: "#b58900", addition: "#859900", deletion: "#dc322f" },
    "solarized-dark": { comment: "#657b83", keyword: "#859900", string: "#2aa198", title: "#268bd2", variable: "#6c71c4", number: "#d33682", attr: "#b58900", addition: "#859900", deletion: "#dc322f" },
    "tokyo-night": { comment: "#565f89", keyword: "#bb9af7", string: "#9ece6a", title: "#7aa2f7", variable: "#c0caf5", number: "#ff9e64", attr: "#e0af68", addition: "#9ece6a", deletion: "#f7768e" },
    "nord": { comment: "#616e88", keyword: "#81a1c1", string: "#a3be8c", title: "#88c0d0", variable: "#d8dee9", number: "#b48ead", attr: "#ebcb8b", addition: "#a3be8c", deletion: "#bf616a" },
    "dracula": { comment: "#6272a4", keyword: "#ff79c6", string: "#f1fa8c", title: "#50fa7b", variable: "#f8f8f2", number: "#bd93f9", attr: "#8be9fd", addition: "#50fa7b", deletion: "#ff5555" },
    "one-dark": { comment: "#5c6370", keyword: "#c678dd", string: "#98c379", title: "#61afef", variable: "#e06c75", number: "#d19a66", attr: "#e5c07b", addition: "#98c379", deletion: "#e06c75" },
  };

  // Callout colours as on GitHub — blue note, green tip, purple important, yellow warning, red caution —
  // taken from each theme's palette. A theme's own info/question/warning colours win.
  const CALLOUT_COLORS = {
    "slate": ["#81a1c1", "#a3be8c", "#b48ead", "#ebcb8b", "#bf616a"],
    "paper": ["#3d6d99", "#5b7f2e", "#86509b", "#a86f12", "#b0412b"],
    "catppuccin-latte": ["#1e66f5", "#40a02b", "#8839ef", "#df8e1d", "#d20f39"],
    "catppuccin-mocha": ["#89b4fa", "#a6e3a1", "#cba6f7", "#f9e2af", "#f38ba8"],
    "gruvbox-light": ["#076678", "#79740e", "#8f3f71", "#b57614", "#9d0006"],
    "gruvbox-dark": ["#83a598", "#b8bb26", "#d3869b", "#fabd2f", "#fb4934"],
    "solarized-light": ["#268bd2", "#859900", "#6c71c4", "#b58900", "#dc322f"],
    "solarized-dark": ["#268bd2", "#859900", "#6c71c4", "#b58900", "#dc322f"],
    "tokyo-night": ["#7aa2f7", "#9ece6a", "#bb9af7", "#e0af68", "#f7768e"],
    "nord": ["#88c0d0", "#a3be8c", "#b48ead", "#ebcb8b", "#bf616a"],
    "dracula": ["#8be9fd", "#50fa7b", "#bd93f9", "#f1fa8c", "#ff5555"],
    "one-dark": ["#61afef", "#98c379", "#c678dd", "#e5c07b", "#e06c75"],
  };

  // "system" follows the OS appearance: Slate when it's dark, Paper when it's light.
  const darkScheme = window.matchMedia("(prefers-color-scheme: dark)");
  function resolveTheme(theme) {
    if (theme === "system") return darkScheme.matches ? "slate" : "paper";
    return THEMES[theme] ? theme : defaults.theme;
  }

  // CSS variables rather than an injected <style>, so the page's CSP needs no inline styles.
  function applyReaderTypography() {
    const rs = document.documentElement.style;
    rs.setProperty("--reader-font", tweaks.bodyFace === "serif" ? "var(--serif)" : "var(--sans)");
    rs.setProperty("--reader-size", `${tweaks.bodySize}px`);
    rs.setProperty("--reader-width", `${tweaks.readingWidth}ch`);
  }

  function applyTweaks() {
    const rs = document.documentElement.style;
    const themeKey = resolveTheme(tweaks.theme);
    if (tweaks.theme !== "system") tweaks.theme = themeKey;
    const t = THEMES[themeKey];
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t.paper);
    rs.setProperty("--accent",   t.accent);
    rs.setProperty("--accent-2", t.accent2);
    rs.setProperty("--paper",   t.paper);
    rs.setProperty("--ink",     t.ink);
    rs.setProperty("--ink-2",   t.ink2);
    rs.setProperty("--ink-3",   t.ink3);
    rs.setProperty("--ink-4",   t.ink4);
    for (const [prop, key] of [["--surface", "surface"], ["--surface-2", "surface2"], ["--line", "line"], ["--line-2", "line2"]]) {
      if (t[key]) rs.setProperty(prop, t[key]);
      else rs.removeProperty(prop);
    }

    const [note, tip, important, warning, caution] = CALLOUT_COLORS[themeKey];
    const tint = c => `color-mix(in oklab, ${c} 10%, ${t.paper})`;
    const edge = c => `color-mix(in oklab, ${c} 35%, ${t.rule})`;
    const callout = (name, accent, bg, rule) => {
      rs.setProperty(`--${name}-accent`, accent);
      rs.setProperty(`--${name}-bg`, bg || tint(accent));
      rs.setProperty(`--${name}-rule`, rule || edge(accent));
    };
    callout("info", t.infoAccent || note, t.infoBg, t.infoRule);
    callout("question", t.questionAccent || tip, t.questionBg, t.questionRule);
    callout("important", important);
    callout("warning", t.warningAccent || warning, t.warningBg, t.warningRule);
    callout("danger", caution);

    const syntax = SYNTAX_THEMES[themeKey] || SYNTAX_THEMES[defaults.theme];
    Object.entries(syntax).forEach(([key, value]) => {
      rs.setProperty(`--syntax-${key}`, value);
    });

    applyReaderTypography();
    syncTweakControls();
  }

  function syncTweakControls() {
    const szEl = document.getElementById("tw-size");
    const wdEl = document.getElementById("tw-width");
    const thEl = document.getElementById("tw-theme");
    const olEl = document.getElementById("tw-outline");
    if (szEl) szEl.value = tweaks.bodySize;
    if (wdEl) wdEl.value = tweaks.readingWidth;
    if (thEl) thEl.value = tweaks.theme;
    if (olEl) olEl.checked = !!tweaks.outline;
    $$('input[name="tw-face"]').forEach(r => { r.checked = r.value === tweaks.bodyFace; });
    $$('input[name="tw-remote"]').forEach(r => { r.checked = r.value === tweaks.remoteImages; });
  }

  function bindTweaks() {
    const set = (k, v) => { tweaks[k] = v; persistTweaks(); applyTweaks(); };
    document.getElementById("tw-size").addEventListener("input",  e => set("bodySize",     +e.target.value));
    document.getElementById("tw-width").addEventListener("input", e => set("readingWidth", +e.target.value));
    $$('input[name="tw-face"]').forEach(r => r.addEventListener("change", e => set("bodyFace", e.target.value)));
    document.getElementById("tw-theme").addEventListener("change", e => set("theme", e.target.value));
    darkScheme.addEventListener("change", () => { if (tweaks.theme === "system") applyTweaks(); });
    document.getElementById("tw-outline").addEventListener("change", e => { set("outline", e.target.checked); refreshOutline(); });
    $$('input[name="tw-remote"]').forEach(r => r.addEventListener("change", e => {
      set("remoteImages", e.target.value);
      const article = $("#readerInner");
      if (article && tweaks.remoteImages === "load") {
        releaseRemoteMedia(article);
        $(".remote-notice", article)?.remove();
      }
    }));
  }

  // ---------------------------------------------------------------
  // Layout: collapsible, resizable sidebar; a drawer on narrow screens
  // ---------------------------------------------------------------
  const LAYOUT_KEY = "mdviewer.layout.v1";
  const narrow = window.matchMedia("(max-width: 760px)");
  let layout = { sidebarWidth: 300, sidebarHidden: false };
  try { layout = { ...layout, ...JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}") }; } catch (_) {}

  function saveLayout() {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch (_) {}
  }
  function clampWidth(w) {
    return Math.round(Math.max(200, Math.min(w, 560, window.innerWidth * 0.6)));
  }
  function applyLayout() {
    el.app.style.setProperty("--sidebar-w", `${clampWidth(layout.sidebarWidth)}px`);
    el.app.classList.toggle("sidebar-hidden", layout.sidebarHidden && !narrow.matches);
    const open = narrow.matches ? el.app.classList.contains("drawer-open") : !layout.sidebarHidden;
    el.sidebarToggle.setAttribute("aria-expanded", String(open));
  }
  function toggleSidebar() {
    if (narrow.matches) el.app.classList.toggle("drawer-open");
    else { layout.sidebarHidden = !layout.sidebarHidden; saveLayout(); }
    applyLayout();
  }
  function closeDrawer() {
    if (!el.app.classList.contains("drawer-open")) return;
    el.app.classList.remove("drawer-open");
    applyLayout();
  }
  function resizeSidebar(width) {
    layout.sidebarWidth = clampWidth(width);
    applyLayout();
  }

  el.sidebarToggle.addEventListener("click", toggleSidebar);
  el.sidebarResizer.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX, startW = layout.sidebarWidth;
    el.app.classList.add("resizing");
    const move = (ev) => resizeSidebar(startW + ev.clientX - startX);
    const up = () => {
      el.app.classList.remove("resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      saveLayout();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
  el.sidebarResizer.addEventListener("dblclick", () => { resizeSidebar(300); saveLayout(); });
  el.sidebarResizer.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowLeft" ? -16 : e.key === "ArrowRight" ? 16 : 0;
    if (!step) return;
    e.preventDefault();
    resizeSidebar(layout.sidebarWidth + step);
    saveLayout();
  });
  narrow.addEventListener("change", () => { el.app.classList.remove("drawer-open"); applyLayout(); });
  el.app.addEventListener("click", (e) => {
    if (!el.app.classList.contains("drawer-open")) return;
    // composedPath() still includes the sidebar when the clicked button was re-rendered away.
    if (e.composedPath().some(n => n === el.sidebar || n === el.sidebarToggle)) return;
    closeDrawer();
  });

  // ---------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------
  function openFolder() {
    if (window.showDirectoryPicker) openFolderViaHandle();
    else openFolderViaInput();
  }

  if (el.openFolderBtn) el.openFolderBtn.addEventListener("click", openFolder);
  if (el.openFilesBtn)  el.openFilesBtn.addEventListener("click", openFilesViaInput);
  if (el.splashDrop)    el.splashDrop.addEventListener("click", openFolder);
  el.splashResume.addEventListener("click", () => { if (resumeTarget) reopenRecent(resumeTarget); });

  el.filePicker.addEventListener("change", (e) => {
    if (e.target.files && e.target.files.length) openLooseFiles(e.target.files);
  });
  el.dirPicker.addEventListener("change", (e) => {
    if (e.target.files && e.target.files.length) openFolderUpload(e.target.files);
  });

  let searchT = null;
  el.searchInput.addEventListener("input", (e) => {
    clearTimeout(searchT);
    searchT = setTimeout(() => runSearch(e.target.value), 120);
  });
  el.searchInput.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    clearTimeout(searchT);
    el.searchInput.value = "";
    runSearch("");
    el.searchInput.blur();
  });
  el.contentToggle.addEventListener("click", () => {
    state.contentSearch = !state.contentSearch;
    el.contentToggle.setAttribute("aria-pressed", String(state.contentSearch));
    el.searchInput.placeholder = state.contentSearch ? "Search names and contents…" : "Filter files…";
    runSearch(el.searchInput.value);
    el.searchInput.focus();
  });

  el.reader.addEventListener("click", (e) => {
    const copy = e.target.closest && e.target.closest(".copy-code");
    if (copy) { copyCode(copy); return; }
    const a = e.target.closest && e.target.closest("a");
    if (!a || !el.reader.contains(a)) return;
    if (a.dataset.path !== undefined) {
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;   // the href is the app's own URL, so a new tab works
      e.preventDefault();
      followDocLink(a.dataset.path, a.dataset.anchor);
    } else if (a.dataset.asset) {
      e.preventDefault();
      openAsset(a.dataset.asset);
    } else if (a.dataset.missing !== undefined) {
      e.preventDefault();
      toast(a.title);
    }
  });
  el.outline.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-anchor]");
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    goToAnchor(a.dataset.anchor);
  });
  let spyFrame = 0;
  el.reader.addEventListener("scroll", () => {
    if (!spyFrame) spyFrame = requestAnimationFrame(() => { spyFrame = 0; syncOutline(); });
  }, { passive: true });

  window.addEventListener("popstate", () => {
    const route = parseRoute();
    const f = route && fileByPath(route.path);
    if (!f) return;
    if (f.id === state.activeId) scrollToAnchor(route.anchor);
    else openFile(f.id, { anchor: route.anchor, nav: "none" });
  });

  window.addEventListener("dragenter", onDragEnter);
  window.addEventListener("dragover",  onDragOver);
  window.addEventListener("dragleave", onDragLeave);
  window.addEventListener("drop",      onDrop);

  setInterval(checkOpenFile, LIVE_FILE_MS);
  // Periodic rescans only while scanning stays cheap; big folders rescan on focus or on demand.
  setInterval(() => { if (!document.hidden && lastScanMs < 400) rescanFolder(); }, LIVE_FOLDER_MS);
  const refreshFromDisk = () => { checkOpenFile(); rescanFolder(); };
  window.addEventListener("focus", refreshFromDisk);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshFromDisk(); });

  window.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && !e.altKey && !e.shiftKey && key === "o") {
      e.preventDefault();
      openFolder();
      return;
    }
    if (mod && !e.altKey && !e.shiftKey && key === "b") {
      e.preventDefault();
      toggleSidebar();
      return;
    }
    if (e.key === "Escape") closeDrawer();
    if (mod || e.altKey) return;
    if (document.activeElement?.closest?.("input,textarea,select,[contenteditable=true]")) return;
    if (e.key === "/" && state.files.length) {
      e.preventDefault();
      if (el.sidebarToggle.getAttribute("aria-expanded") === "false") toggleSidebar();
      el.searchInput.focus();
      el.searchInput.select();
      return;
    }
    if (!state.files.length || e.shiftKey) return;
    if (document.getSelection()?.toString()) return;
    // ↑/↓ are left to scroll the document; j/k move between files.
    if (e.key === "j") {
      e.preventDefault();
      navigateFile(1);
    }
    if (e.key === "k") {
      e.preventDefault();
      navigateFile(-1);
    }
  });
  // Steps through the files the sidebar shows; with every folder collapsed it uses all files.
  function navigateFile(dir) {
    const visible = visibleFiles();
    const pool = visible.length || isFiltering() ? visible : state.files;
    if (!pool.length) return;
    let idx = pool.findIndex(f => f.id === state.activeId);
    if (idx < 0) {
      // Active file is hidden (or none is open): step from the slot it would occupy.
      const rank = new Map(state.files.map((f, i) => [f.id, i]));
      const cur = rank.get(state.activeId) ?? -1;
      const after = pool.findIndex(f => rank.get(f.id) > cur);
      idx = (after < 0 ? pool.length : after) - (dir > 0 ? 1 : 0);
    }
    idx = (idx + dir + pool.length) % pool.length;
    openFile(pool[idx].id);
  }

  // Init
  bindTweaks();
  applyTweaks();
  applyLayout();
  renderFiles();
  renderTopMeta();
  loadRecents().then(offerResume);
})();
