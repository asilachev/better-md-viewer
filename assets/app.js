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
    marked.setOptions({ gfm: true, breaks: false, headerIds: true, mangle: false });
  }
  const PURIFY_CFG = {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["form", "iframe", "object", "embed", "style", "script"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus", "onblur", "formaction", "style"]
  };

  const state = {
    files: [],
    activeId: null,
    activeFolderKey: null,
    searchQuery: "",
    collapsed: {},
  };

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const el = {
    app: $("#app"),
    sideSections: $("#sideSections"),
    searchWrap: $("#searchWrap"),
    searchInput: $("#searchInput"),
    crumbs: $("#crumbs"),
    reader: $("#reader"),
    splash: $("#splash"),
    dropOver: $("#dropOver"),
    fileCount: $("#fileCount"),
    openFolderBtn: $("#openFolderBtn"),
    openFilesBtn: $("#openFilesBtn"),
    splashDrop: $("#splashDrop"),
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

  function uid() { return "f_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }

  function deriveGroup(path) {
    const parts = path.split("/");
    if (parts.length <= 1) return "";
    return parts.slice(0, -1).join("/");
  }

  async function walkDirHandle(handle, pathPrefix = "") {
    const out = [];
    for await (const [name, ent] of handle.entries()) {
      if (name.startsWith(".")) continue;
      const rel = pathPrefix ? pathPrefix + "/" + name : name;
      if (ent.kind === "directory") {
        out.push(...(await walkDirHandle(ent, rel)));
      } else if (ent.kind === "file" && SUPPORTED.test(name)) {
        out.push({
          id: uid(), path: rel, name,
          group: deriveGroup(rel), kind: "handle", handle: ent, size: 0,
        });
      }
    }
    return out;
  }

  async function readFromFileHandle(h) {
    const f = await h.getFile();
    return await f.text();
  }
  async function readFromFile(f) { return await f.text(); }

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
      const files = await walkDirHandle(dir);
      if (!files.length) { toast("No .md / .txt files found in that folder"); return; }
      const sourceName = dir.name || "folder";
      const key = "h::" + sourceName + "::" + Date.now().toString(36);
      state.activeFolderKey = key;
      await saveRecent({
        key, name: sourceName, source: "handle", handle: dir,
        fileCount: files.length, lastFilePath: null, at: Date.now(),
      });
      setFiles(files);
      if (files[0]) openFile(files[0].id);
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
    const incoming = [...fileList].filter(f => SUPPORTED.test(f.name));
    if (!incoming.length) { toast("No .md / .txt files found"); return; }

    let rootName = "";
    for (const f of incoming) {
      const rp = f.webkitRelativePath || f.name;
      const first = rp.split("/")[0];
      if (!rootName) rootName = first;
      else if (first !== rootName) { rootName = ""; break; }
    }
    if (!rootName) rootName = "folder";

    const files = incoming.map(f => {
      const rp = f.webkitRelativePath || f.name;
      const rel = rp.startsWith(rootName + "/") ? rp.slice(rootName.length + 1) : rp;
      return {
        id: uid(), path: rel, name: f.name,
        group: deriveGroup(rel), kind: "file", file: f, size: f.size,
      };
    });

    const key = "u::" + rootName + "::" + Date.now().toString(36);
    state.activeFolderKey = key;
    await saveRecent({
      key, name: rootName, source: "upload",
      fileCount: files.length, lastFilePath: null, at: Date.now(),
    });
    setFiles(files);
    if (files[0]) openFile(files[0].id);
    toast(`Read ${files.length} file${files.length === 1 ? "" : "s"} locally · nothing uploaded`, 2800);
  }

  async function openLooseFiles(fileList) {
    const incoming = [...fileList].filter(f => SUPPORTED.test(f.name));
    if (!incoming.length) { toast("No .md / .txt files found"); return; }
    const newFiles = incoming.map(f => ({
      id: uid(), path: f.name, name: f.name, group: "",
      kind: "file", file: f, size: f.size,
    }));
    if (!state.files.length) state.activeFolderKey = null;
    addFiles(newFiles);
    if (newFiles[0]) openFile(newFiles[0].id);
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

    const items = e.dataTransfer.items ? [...e.dataTransfer.items] : null;

    if (items && items[0] && items[0].getAsFileSystemHandle) {
      const handles = [];
      for (const it of items) {
        if (it.kind !== "file") continue;
        try {
          const h = await it.getAsFileSystemHandle();
          if (h) handles.push(h);
        } catch (_) {}
      }
      if (handles.length) {
        const dirs = handles.filter(h => h.kind === "directory");
        const fhs  = handles.filter(h => h.kind === "file");
        let allFiles = [];
        for (const d of dirs) {
          const f = await walkDirHandle(d, d.name);
          allFiles.push(...f);
        }
        for (const fh of fhs) {
          if (!SUPPORTED.test(fh.name)) continue;
          allFiles.push({
            id: uid(), path: fh.name, name: fh.name, group: "",
            kind: "handle", handle: fh, size: 0
          });
        }
        if (!allFiles.length) { toast("No .md / .txt files in drop"); return; }
        if (dirs.length === 1 && !fhs.length) {
          const root = dirs[0];
          allFiles = allFiles.map(f => {
            const rel = f.path.startsWith(root.name + "/") ? f.path.slice(root.name.length + 1) : f.path;
            return { ...f, path: rel, group: deriveGroup(rel) };
          });
          const key = "h::" + root.name + "::" + Date.now().toString(36);
          state.activeFolderKey = key;
          await saveRecent({
            key, name: root.name, source: "handle",
            handle: root, fileCount: allFiles.length, lastFilePath: null, at: Date.now(),
          });
          setFiles(allFiles);
        } else {
          if (!state.files.length) state.activeFolderKey = null;
          addFiles(allFiles);
        }
        if (allFiles[0]) openFile(allFiles[0].id);
        return;
      }
    }

    if (items && items[0] && items[0].webkitGetAsEntry) {
      const entries = items.map(i => i.webkitGetAsEntry()).filter(Boolean);
      const collected = [];
      let rootName = "";
      const singleDir = entries.length === 1 && entries[0].isDirectory;
      if (singleDir) rootName = entries[0].name;

      async function walk(ent, prefix) {
        if (ent.isFile) {
          if (!SUPPORTED.test(ent.name)) return;
          const file = await new Promise((r, rej) => ent.file(r, rej));
          const p = prefix ? prefix + "/" + ent.name : ent.name;
          collected.push({
            id: uid(), path: p, name: ent.name,
            group: deriveGroup(p), kind: "file", file, size: file.size
          });
        } else if (ent.isDirectory) {
          const reader = ent.createReader();
          const readAll = () => new Promise((res) => {
            const out = [];
            const step = () => reader.readEntries((chunk) => {
              if (!chunk.length) return res(out);
              out.push(...chunk); step();
            });
            step();
          });
          const kids = await readAll();
          for (const k of kids) {
            const newPrefix = prefix ? prefix + "/" + ent.name : (singleDir ? "" : ent.name);
            await walk(k, newPrefix);
          }
        }
      }
      for (const ent of entries) await walk(ent, "");

      if (!collected.length) { toast("No .md / .txt files in drop"); return; }
      if (singleDir) {
        const key = "u::" + rootName + "::" + Date.now().toString(36);
        state.activeFolderKey = key;
        await saveRecent({
          key, name: rootName, source: "upload",
          fileCount: collected.length, lastFilePath: null, at: Date.now(),
        });
        setFiles(collected);
      } else {
        if (!state.files.length) state.activeFolderKey = null;
        addFiles(collected);
      }
      if (collected[0]) openFile(collected[0].id);
      return;
    }

    const files = [...(e.dataTransfer.files || [])];
    if (files.length) await openLooseFiles(files);
  }

  // ---------------------------------------------------------------
  // File list manipulation
  // ---------------------------------------------------------------
  function setFiles(arr) {
    state.files = sortFiles(arr);
    state.activeId = null;
    state.collapsed = {};
    state.searchQuery = "";
    el.searchInput.value = "";
    renderSidebar();
    renderTopMeta();
  }
  function addFiles(arr) {
    const existing = new Set(state.files.map(f => f.path));
    const merged = state.files.slice();
    for (const f of arr) {
      let p = f.path, i = 1;
      while (existing.has(p)) { p = f.path.replace(/(\.[^.]+)?$/, "-" + (++i) + "$1"); }
      existing.add(p);
      merged.push({ ...f, path: p, group: deriveGroup(p) });
    }
    state.files = sortFiles(merged);
    renderSidebar();
    renderTopMeta();
  }
  function sortFiles(arr) {
    return arr.slice().sort((a, b) => {
      if (a.group !== b.group) return a.group.localeCompare(b.group);
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
  }
  function removeFile(id) {
    const idx = state.files.findIndex(f => f.id === id);
    if (idx < 0) return;
    const wasActive = state.activeId === id;
    state.files.splice(idx, 1);
    if (wasActive) {
      state.activeId = null;
      const next = state.files[idx] || state.files[idx - 1];
      if (next) openFile(next.id);
      else showSplash();
    }
    renderSidebar();
    renderTopMeta();
  }
  function clearFiles() {
    state.files = [];
    state.activeId = null;
    state.activeFolderKey = null;
    renderSidebar();
    renderTopMeta();
    showSplash();
  }

  // ---------------------------------------------------------------
  // Rendering: sidebar
  // ---------------------------------------------------------------
  let sidebarRenderGen = 0;
  async function renderSidebar() {
    const gen = ++sidebarRenderGen;
    const recents = await loadRecentsSorted();
    if (gen !== sidebarRenderGen) return;
    const root = el.sideSections;
    root.innerHTML = "";

    if (recents.length) {
      const title = document.createElement("div");
      title.className = "side-title";
      title.innerHTML = `<span>Recent</span><button id="clearRecentsBtn">Forget all</button>`;
      root.appendChild(title);

      const wrap = document.createElement("div");
      wrap.className = "recents";
      for (const r of recents) {
        const row = document.createElement("div");
        row.className = "recent" + (r.source === "handle" ? "" : " no-handle");
        const icon = r.source === "handle" ? "fs" : "up";
        row.innerHTML = `
          <div class="ricon">${icon}</div>
          <div class="rtitle"></div>
          <div class="rmeta"></div>
          <button class="rforget" title="Forget">×</button>
        `;
        row.querySelector(".rtitle").textContent = r.name;
        row.querySelector(".rmeta").textContent = `${timeAgo(r.at)} · ${r.fileCount} file${r.fileCount === 1 ? "" : "s"}`;
        row.addEventListener("click", (e) => {
          if (e.target.closest(".rforget")) return;
          reopenRecent(r);
        });
        row.querySelector(".rforget").addEventListener("click", async (e) => {
          e.stopPropagation();
          await idbDel(r.key);
          renderSidebar();
        });
        wrap.appendChild(row);
      }
      root.appendChild(wrap);

      $("#clearRecentsBtn").addEventListener("click", async () => {
        await idbClear();
        renderSidebar();
        toast("Recents cleared");
      });
    }

    if (state.files.length) {
      const title = document.createElement("div");
      title.className = "side-title";
      title.style.marginTop = "12px";
      title.innerHTML = `<span>${state.files.length} file${state.files.length === 1 ? "" : "s"}</span><button id="clearFilesBtn">Clear</button>`;
      root.appendChild(title);

      if (state.files.length > 10) el.searchWrap.classList.add("on");
      else el.searchWrap.classList.remove("on");

      const q = state.searchQuery.trim().toLowerCase();
      const visible = q
        ? state.files.filter(f => f.path.toLowerCase().includes(q) || f.name.toLowerCase().includes(q))
        : state.files;

      const groups = new Map();
      for (const f of visible) {
        if (!groups.has(f.group)) groups.set(f.group, []);
        groups.get(f.group).push(f);
      }
      const groupKeys = [...groups.keys()].sort((a, b) => a.localeCompare(b));

      for (const gk of groupKeys) {
        const g = document.createElement("div");
        g.className = "group";
        const headName = gk || "(root)";
        const collapsed = state.collapsed[gk];
        const head = document.createElement("div");
        head.className = "group-head" + (collapsed ? " collapsed" : "");
        head.innerHTML = `
          <span class="caret">▾</span>
          <span class="name" title="${escapeAttr(headName)}">${escapeHtml(headName)}</span>
          <span class="count">${groups.get(gk).length}</span>
        `;
        head.addEventListener("click", () => {
          state.collapsed[gk] = !state.collapsed[gk];
          renderSidebar();
        });
        g.appendChild(head);

        const list = document.createElement("div");
        list.className = "files";
        for (const f of groups.get(gk)) {
          const fe = document.createElement("div");
          fe.className = "file" + (f.id === state.activeId ? " active" : "");
          fe.innerHTML = `
            <span class="dot-mark"></span>
            <span class="label"></span>
            <button class="remove" title="Remove from list">×</button>
          `;
          fe.querySelector(".label").textContent = f.name;
          fe.title = f.path;
          fe.addEventListener("click", (e) => {
            if (e.target.closest(".remove")) return;
            openFile(f.id);
          });
          fe.querySelector(".remove").addEventListener("click", (e) => {
            e.stopPropagation();
            removeFile(f.id);
          });
          list.appendChild(fe);
        }
        g.appendChild(list);
        root.appendChild(g);
      }

      const clearBtn = $("#clearFilesBtn");
      if (clearBtn) clearBtn.addEventListener("click", clearFiles);

      if (!visible.length) {
        const em = document.createElement("div");
        em.className = "empty-side";
        em.textContent = `No files match "${state.searchQuery}".`;
        root.appendChild(em);
      }
    } else {
      el.searchWrap.classList.remove("on");
      const em = document.createElement("div");
      em.className = "empty-side";
      em.innerHTML = `
        <b>No files yet.</b><br>
        Click <b>Open folder</b>, or drop a folder / <span class="kbd">.md</span> files anywhere.
      `;
      root.appendChild(em);
    }
  }

  function renderTopMeta() {
    const n = state.files.length;
    el.fileCount.textContent = !n ? "No files loaded" : `${n} file${n === 1 ? "" : "s"} loaded`;
  }

  // ---------------------------------------------------------------
  // Rendering: reader
  // ---------------------------------------------------------------
  async function openFile(id) {
    const f = state.files.find(x => x.id === id);
    if (!f) return;
    state.activeId = id;
    renderSidebar();
    renderCrumbs(f);

    let text = "";
    try {
      if (f.kind === "handle") text = await readFromFileHandle(f.handle);
      else if (f.kind === "file") text = await readFromFile(f.file);
    } catch (e) {
      text = "# Could not read this file\n\n`" + (e && e.message || e) + "`";
    }

    const isMd = /\.(md|markdown)$/i.test(f.name);
    let html;
    if (isMd) {
      const { frontmatter, body } = splitFrontmatter(text);
      const raw = renderFrontmatterTable(frontmatter) + marked.parse(body);
      html = DOMPurify.sanitize(raw, PURIFY_CFG);
    } else {
      const pre = document.createElement("pre");
      pre.className = "plain";
      pre.textContent = text;
      html = pre.outerHTML;
    }

    el.reader.innerHTML = `<article class="reader-inner md" id="readerInner">${html}</article>`;
    enhanceCallouts($("#readerInner"));
    enhanceInlineTokens($("#readerInner"));
    enhanceHeadingAnchors($("#readerInner"));
    highlightCodeBlocks($("#readerInner"));
    $$("#readerInner a").forEach(a => {
      const href = a.getAttribute("href") || "";
      if (/^(https?:)?\/\//i.test(href)) {
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener noreferrer");
      }
    });
    $$("#readerInner .wiki-link").forEach(a => {
      a.addEventListener("click", e => {
        const target = a.dataset.wikiTarget || "";
        const match = findWikiFile(target);
        if (!match) return;
        e.preventDefault();
        openFile(match.id);
      });
    });
    el.reader.scrollTop = 0;
    applyReaderTypography();

    if (state.activeFolderKey) {
      const rec = await idbGet(state.activeFolderKey);
      if (rec) {
        rec.lastFilePath = f.path;
        rec.at = Date.now();
        await idbPut(rec);
      }
    }
  }

  function renderCrumbs(f) {
    const parts = f.path.split("/");
    const frag = document.createDocumentFragment();
    parts.forEach((p, i) => {
      const span = document.createElement("span");
      span.className = i === parts.length - 1 ? "cur" : "";
      span.textContent = p.toUpperCase();
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
    el.reader.innerHTML = "";
    el.reader.appendChild(el.splash);
    el.crumbs.innerHTML = `<span class="meta">No document selected</span>`;
  }

  // ---------------------------------------------------------------
  // Recents
  // ---------------------------------------------------------------
  const RECENT_LIMIT = 5;

  async function saveRecent(entry) {
    await idbPut(entry);
    const all = await idbGetAll();
    all.sort((a, b) => b.at - a.at);
    for (const e of all.slice(RECENT_LIMIT)) await idbDel(e.key);
    renderSidebar();
  }
  async function loadRecentsSorted() {
    try {
      const all = await idbGetAll();
      all.sort((a, b) => b.at - a.at);
      return all.slice(0, RECENT_LIMIT);
    } catch (e) { return []; }
  }

  async function reopenRecent(r) {
    if (r.source === "handle" && r.handle && r.handle.requestPermission) {
      try {
        let perm = await r.handle.queryPermission({ mode: "read" });
        if (perm !== "granted") perm = await r.handle.requestPermission({ mode: "read" });
        if (perm !== "granted") { toast("Permission denied"); return; }
        const files = await walkDirHandle(r.handle);
        if (!files.length) { toast("No .md / .txt files in that folder anymore"); return; }
        state.activeFolderKey = r.key;
        r.fileCount = files.length;
        r.at = Date.now();
        await idbPut(r);
        setFiles(files);
        const target = r.lastFilePath ? files.find(f => f.path === r.lastFilePath) : files[0];
        if (target) openFile(target.id);
      } catch (e) {
        console.warn(e);
        toast("Could not re-open folder");
      }
    } else {
      toast("Re-select this folder — browser can't restore uploads");
      openFolderViaInput();
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
  function escapeAttr(s) { return escapeHtml(s); }

  function slugifyHeading(text, counts) {
    const base = String(text || "")
      .toLowerCase()
      .normalize("NFKD")
      .trim()
      .replace(/[`"'’‘“”]/g, "")
      .replace(/\p{Mark}/gu, "")
      .replace(/&/g, " and ")
      .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "section";
    const count = counts.get(base) || 0;
    counts.set(base, count + 1);
    return count ? `${base}-${count + 1}` : base;
  }

  function enhanceHeadingAnchors(root) {
    if (!root) return;
    const counts = new Map();
    $$("h1,h2,h3,h4,h5,h6", root).forEach(heading => {
      $(".heading-anchor", heading)?.remove();
      if (!heading.id) heading.id = slugifyHeading(heading.textContent, counts);

      const anchor = document.createElement("a");
      anchor.className = "heading-anchor";
      anchor.href = `#${heading.id}`;
      anchor.setAttribute("aria-label", `Link to ${heading.textContent}`);
      anchor.textContent = "#";
      heading.appendChild(anchor);
    });
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

  function enhanceCallouts(root) {
    if (!root) return;
    $$("blockquote", root).forEach(blockquote => {
      const first = blockquote.querySelector("p,li");
      if (!first) return;

      const text = first.textContent.trim();
      const match = text.match(/^\[!(info|question|warning|warn|caution|attention)\]\s*(.*)$/i);
      if (!match) return;

      const kind = match[1].toLowerCase();
      const normalizedKind = ["warn", "caution", "attention"].includes(kind) ? "warning" : kind;
      const label = normalizedKind === "question" ? "Question" : normalizedKind === "warning" ? "Warning" : "Info";
      const bodyText = match[2].trim();

      blockquote.classList.add("callout", `callout-${normalizedKind}`);
      blockquote.setAttribute("role", "note");

      const icon = document.createElement("span");
      icon.className = "callout-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = normalizedKind === "question" ? "?" : normalizedKind === "warning" ? "!" : "i";

      const title = document.createElement("div");
      title.className = "callout-title";
      title.append(icon, document.createTextNode(label));

      const body = document.createElement("div");
      body.className = "callout-body";

      if (bodyText) {
        first.innerHTML = DOMPurify.sanitize(marked.parseInline(bodyText), PURIFY_CFG);
      } else {
        first.remove();
      }

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

  function buildInlineTokenFragment(text) {
    const pattern = /(\[\[([^\]|]+)(?:\|([^\]]+))?\]\])|(^|[\s(])#([_\p{Letter}\p{Number}][_\p{Letter}\p{Number}/-]*)/gu;
    const fragment = document.createDocumentFragment();
    let index = 0;
    let match;

    while ((match = pattern.exec(text))) {
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

  // ---------------------------------------------------------------
  // Tweaks
  // ---------------------------------------------------------------
  const TWEAK_KEY = "mdviewer.tweaks.v1";
  const defaults = window.TWEAK_DEFAULTS || {
    bodySize: 17, readingWidth: 120, bodyFace: "serif", theme: "catppuccin-latte"
  };

  let tweaks = { ...defaults };
  try {
    const saved = JSON.parse(localStorage.getItem(TWEAK_KEY) || "null");
    if (saved && typeof saved === "object") tweaks = { ...defaults, ...saved };
  } catch (_) {}

  function persistTweaks() {
    try { localStorage.setItem(TWEAK_KEY, JSON.stringify(tweaks)); } catch (_) {}
  }

  const THEMES = {
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

  function applyReaderTypography() {
    let tag = document.getElementById("tweak-style");
    if (!tag) { tag = document.createElement("style"); tag.id = "tweak-style"; document.head.appendChild(tag); }
    const face = tweaks.bodyFace === "serif" ? "var(--serif)" : "var(--sans)";
    tag.textContent = `.reader-inner{font-family:${face};font-size:${tweaks.bodySize}px;max-width:${tweaks.readingWidth}ch}`;
  }

  function applyTweaks() {
    const rs = document.documentElement.style;
    const themeKey = THEMES[tweaks.theme] ? tweaks.theme : defaults.theme;
    tweaks.theme = themeKey;
    const t = THEMES[themeKey];
    rs.setProperty("--accent",   t.accent);
    rs.setProperty("--accent-2", t.accent2);
    rs.setProperty("--paper",   t.paper);
    rs.setProperty("--paper-2", t.p2);
    rs.setProperty("--paper-3", t.p3);
    rs.setProperty("--ink",     t.ink);
    rs.setProperty("--ink-2",   t.ink2);
    rs.setProperty("--ink-3",   t.ink3);
    rs.setProperty("--ink-4",   t.ink4);
    rs.setProperty("--rule",    t.rule);
    rs.setProperty("--rule-2",  t.rule2);
    rs.setProperty("--info-accent", t.infoAccent || t.accent);
    rs.setProperty("--info-bg", t.infoBg || t.accent2);
    rs.setProperty("--info-rule", t.infoRule || t.rule2);
    rs.setProperty("--question-accent", t.questionAccent || t.accent);
    rs.setProperty("--question-bg", t.questionBg || t.accent2);
    rs.setProperty("--question-rule", t.questionRule || t.rule2);
    rs.setProperty("--warning-accent", t.warningAccent || t.accent);
    rs.setProperty("--warning-bg", t.warningBg || t.accent2);
    rs.setProperty("--warning-rule", t.warningRule || t.rule2);

    const syntax = SYNTAX_THEMES[themeKey] || SYNTAX_THEMES[defaults.theme];
    Object.entries(syntax).forEach(([key, value]) => {
      rs.setProperty(`--syntax-${key}`, value);
    });

    applyReaderTypography();

    // sync controls
    const szEl = document.getElementById("tw-size");
    const wdEl = document.getElementById("tw-width");
    const faEl = document.getElementById("tw-face");
    const thEl = document.getElementById("tw-theme");
    if (szEl) szEl.value = tweaks.bodySize;
    if (wdEl) wdEl.value = tweaks.readingWidth;
    if (faEl) faEl.value = tweaks.bodyFace;
    if (thEl) thEl.value = tweaks.theme;
  }

  function bindTweaks() {
    const set = (k, v) => { tweaks[k] = v; persistTweaks(); applyTweaks(); };
    document.getElementById("tw-size").addEventListener("input",  e => set("bodySize",     +e.target.value));
    document.getElementById("tw-width").addEventListener("input", e => set("readingWidth", +e.target.value));
    document.getElementById("tw-face").addEventListener("change", e => set("bodyFace",      e.target.value));
    document.getElementById("tw-theme").addEventListener("change", e => set("theme", e.target.value));
    const applyBtn = document.getElementById("tweaksApply");
    if (applyBtn) applyBtn.addEventListener("click", () => {
      persistTweaks();
      applyTweaks();
      toast("Saved \u2713");
    });
  }

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

  el.filePicker.addEventListener("change", (e) => {
    if (e.target.files && e.target.files.length) openLooseFiles(e.target.files);
  });
  el.dirPicker.addEventListener("change", (e) => {
    if (e.target.files && e.target.files.length) openFolderUpload(e.target.files);
  });

  el.searchInput.addEventListener("input", (e) => {
    state.searchQuery = e.target.value;
    renderSidebar();
  });

  window.addEventListener("dragenter", onDragEnter);
  window.addEventListener("dragover",  onDragOver);
  window.addEventListener("dragleave", onDragLeave);
  window.addEventListener("drop",      onDrop);

  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "o") {
      e.preventDefault();
      openFolder();
    }
    if (!state.files.length) return;
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (document.getSelection()?.toString()) return;
    if (document.activeElement?.closest?.("input,textarea,select,[contenteditable=true],#readerInner")) return;
    if (e.key === "ArrowDown" || e.key === "j") {
      e.preventDefault();
      navigateFile(1);
    }
    if (e.key === "ArrowUp" || e.key === "k") {
      e.preventDefault();
      navigateFile(-1);
    }
  });
  function navigateFile(dir) {
    if (!state.files.length) return;
    let idx = state.files.findIndex(f => f.id === state.activeId);
    if (idx < 0) idx = 0;
    else idx = (idx + dir + state.files.length) % state.files.length;
    openFile(state.files[idx].id);
  }

  // Init
  bindTweaks();
  applyTweaks();
  renderSidebar();
  renderTopMeta();
})();
