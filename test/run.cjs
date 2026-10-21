// Browser tests for Better MD viewer. Each one opens index.html over file:// in Chromium, with a fake
// folder standing in for the folder picker, so nothing is served and nothing leaves the machine.
//
// Playwright lives outside the repo. Install it once, anywhere:
//   npm install --prefix ~/.cache/bmv-tests playwright@1.58.2
//   ~/.cache/bmv-tests/node_modules/.bin/playwright install chromium
// Then, from the repo:
//   node test/run.cjs ~/.cache/bmv-tests/node_modules/playwright [page-url] [screenshot-dir]
// page-url defaults to this checkout's index.html; give the live site's address to check that instead.
const path = require("path");
const { pathToFileURL } = require("url");
const [pwDir, pageUrl = pathToFileURL(path.join(__dirname, "..", "index.html")).href, shotDir] = process.argv.slice(2);
if (!pwDir) {
  console.error("Usage: node test/run.cjs <path to the playwright package> [page-url] [screenshot-dir]");
  process.exit(2);
}
const { chromium } = require(pwDir);

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const filler = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} ` + "lorem ipsum ".repeat(30)).join("\n\n");
const README = `---
title: Project
tags: [docs, test]
---
# Project

See the [guide](guide/intro.md), the [setup section](guide/intro.md#setup), the [guide folder](guide/), [account](site/guide/account.md), a [missing doc](nope.md), and the [spec](files/spec.pdf). Wiki: [[intro]], [[intro#Setup|setup via wiki]], [[nothing-here]].

![diagram](img/diagram.png) ![logo](./img/logo.svg) ![gone](img/missing.png) ![remote](https://example.com/pixel.png)

Jump to the [second example](#example-1), [Q&A](#qa--notes), [snake](#my_var-setup).

Fixed in PR #123 and issue #45; tagged #roadmap and #2024-plan.

> [!NOTE]
> GitHub-style note with a [link](guide/intro.md).
> Second line.

> [!TIP]
> Tip text.

> [!IMPORTANT]
> Important text.

> [!WARNING]
> Line one.
> Line two.

> [!CAUTION]
> Careful.

> [!info] See [the guide](guide/intro.md) for **details**.

> Just a quote.

Footnote here[^1] and again[^note].

[^1]: The first footnote.
[^note]: A named footnote
    with a second line.

## Example
text
## Example
text
## Q&A — notes
text
## my_var setup
text

${filler}
`;

const FIXTURE = {
  "a-first.md": "# A first\n\nnothing special",
  "README.md": README,
  "guide/README.md": "# Guide home",
  "guide/intro.md": `# Intro\n\nBack to [readme](../README.md).\n\n${filler}\n\n## Setup\n\nSetup text.`,
  "site/guide/account.md": "# Account\n\n[billing](/guide/billing) and [billing html](/guide/billing.html) and [root readme](/README.md)",
  "site/guide/billing.md": "# Billing",
  "img/diagram.png": { b64: PNG, type: "image/png" },
  "img/logo.svg": { text: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>' },
  "files/spec.pdf": { text: "%PDF-1.4 fake", type: "application/pdf" },
  ".github/CONTRIBUTING.md": "# Contributing",
  ".hidden/secret.md": "# Secret",
  "node_modules/pkg/README.md": "# pkg",
  "notes/n1.md": "# Note 1\n\nzebra and another zebra",
  "notes/n2.md": "# Note 2",
};

// Runs in the page: a fake folder behind window.showDirectoryPicker, editable from the test.
function installHarness({ files, rootName }) {
  class FakeFile {
    constructor(name, spec) { this.kind = "file"; this.name = name; this.spec = spec; this.mtime = 1000; this.deleted = false; this.delay = 0; }
    async getFile() {
      if (this.deleted) throw new DOMException("gone", "NotFoundError");
      if (this.delay) await new Promise(r => setTimeout(r, this.delay));
      const s = this.spec;
      const body = typeof s === "string" ? s : s.b64 ? Uint8Array.from(atob(s.b64), c => c.charCodeAt(0)) : s.text;
      return new File([body], this.name, { type: (typeof s === "object" && s.type) || "", lastModified: this.mtime });
    }
  }
  class FakeDir {
    constructor(name) { this.kind = "directory"; this.name = name; this.children = []; }
    async *entries() { for (const c of this.children.slice()) yield [c.name, c]; }
  }
  const root = new FakeDir(rootName);
  const byPath = new Map();
  const add = (p, spec) => {
    const parts = p.split("/");
    let d = root;
    for (const part of parts.slice(0, -1)) {
      let n = d.children.find(c => c.kind === "directory" && c.name === part);
      if (!n) { n = new FakeDir(part); d.children.push(n); }
      d = n;
    }
    const f = new FakeFile(parts[parts.length - 1], spec);
    d.children.push(f);
    byPath.set(p, { file: f, dir: d });
    return f;
  };
  for (const [p, spec] of Object.entries(files)) add(p, spec);
  window.__fake = {
    root, add,
    edit(p, text) { const f = byPath.get(p).file; f.spec = text; f.mtime = Date.now(); },
    remove(p) { const { file, dir } = byPath.get(p); file.deleted = true; dir.children = dir.children.filter(c => c !== file); },
    slow(p, ms) { byPath.get(p).file.delay = ms; },
  };
  window.showDirectoryPicker = async () => root;
}

const results = [];
function check(name, actual, expected) {
  const ok = typeof expected === "function" ? expected(actual) : JSON.stringify(actual) === JSON.stringify(expected);
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n       got:      ${JSON.stringify(actual)}${typeof expected === "function" ? "" : `\n       expected: ${JSON.stringify(expected)}`}`}`);
}

async function openFixture(context, { files = FIXTURE, rootName = "docs", viewport, beforeOpen } = {}) {
  const page = await context.newPage();
  if (viewport) await page.setViewportSize(viewport);
  page.logs = []; page.requests = [];
  page.on("console", m => { if (["error", "warning"].includes(m.type())) page.logs.push(`${m.type()}: ${m.text().slice(0, 160)}`); });
  page.on("pageerror", e => page.logs.push(`pageerror: ${e.message}`));
  page.on("request", r => page.requests.push(r.url()));
  await page.goto(pageUrl + (beforeOpen && beforeOpen.hash || ""));
  await page.evaluate(installHarness, { files, rootName });
  await page.click((await page.isVisible("#openFolderBtn")) ? "#openFolderBtn" : "#splashDrop");
  await page.waitForSelector(".file-row.active", { state: "attached" });
  await page.waitForTimeout(300);
  return page;
}
const active = page => page.evaluate(() => document.querySelector(".file-row.active")?.title || null);
const crumbs = page => page.evaluate(() => document.querySelector("#crumbs").textContent.replace(/\s+/g, ""));
const toastText = page => page.evaluate(() => document.querySelector("#toast.on")?.textContent || "");
const settle = (page, ms = 250) => page.waitForTimeout(ms);
const clickFile = async (page, title) => {
  const sel = `.file-row[title="${title}"] .row-main`;
  if (!(await page.isVisible(sel))) { await page.click("#expandAllBtn"); await settle(page, 100); }
  await page.click(sel, { timeout: 5000 });
  await settle(page);
};
const expandAll = async page => { await page.click("#expandAllBtn"); await settle(page, 100); };

(async () => {
  const browser = await chromium.launch({ channel: "chromium" });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });

  // ---------------- A. Load
  const page = await openFixture(ctx);
  // The page's own files are fine (file://, or the site's origin when testing the live site).
  const ownOrigin = new URL(pageUrl).origin;
  check("A1 no network requests on load", page.requests.filter(u => !/^(file|data|blob):/.test(u) && new URL(u).origin !== ownOrigin), []);
  check("A2 README opens first (not a-first.md)", await active(page), "README.md");
  check("A3 title + URL follow the file", await page.evaluate(() => [document.title, location.hash]), ["README.md — Better MD viewer", "#/README.md"]);
  await expandAll(page);
  const paths = await page.evaluate(() => [...document.querySelectorAll(".file-row")].map(r => r.title));
  check("A4 .github kept; .hidden and node_modules skipped",
    [paths.includes(".github/CONTRIBUTING.md"), paths.some(p => p.startsWith(".hidden")), paths.some(p => p.includes("node_modules"))], [true, false, false]);
  check("A5 the vendored DOMPurify is the expected version", await page.evaluate(() => DOMPurify.version), "3.4.17");

  // ---------------- B. Rendering
  await clickFile(page, "README.md");
  const r = await page.evaluate(() => {
    const a = document.querySelector("#readerInner");
    const img = sel => a.querySelector(sel);
    return {
      ids: [...a.querySelectorAll("h1,h2")].map(h => h.id),
      brokenAnchors: [...a.querySelectorAll('a[data-path="README.md"]')].map(x => x.dataset.anchor).filter(x => x && !a.querySelector(`[id="user-content-${CSS.escape(x)}"]`)),
      callouts: [...a.querySelectorAll(".callout")].map(c => c.className.replace("callout ", "") + ":" + c.querySelector(".callout-title").lastChild.textContent),
      plainQuote: [...a.querySelectorAll("blockquote:not(.callout)")].map(b => b.textContent.trim()),
      noteBody: a.querySelector(".callout-info .callout-body").textContent.replace(/\s+/g, " ").trim(),
      noteHasLink: !!a.querySelector(".callout-info .callout-body a[data-path]"),
      infoKeepsFormatting: (() => { const c = [...a.querySelectorAll(".callout-info")].find(x => x.textContent.includes("details")); return !!(c && c.querySelector("a[data-path]") && c.querySelector("strong")); })(),
      tags: [...a.querySelectorAll(".tag-token")].map(t => t.textContent),
      footnotes: [...a.querySelectorAll(".footnotes li")].map(li => li.textContent.replace(/\s+/g, " ").trim()),
      footnoteRefs: [...a.querySelectorAll(".footnote-ref a")].map(x => x.textContent),
      literalFootnote: a.textContent.includes("[^"),
      frontmatterRows: a.querySelectorAll(".frontmatter tr").length,
      png: { blob: img('img[alt="diagram"]').src.startsWith("blob:"), w: img('img[alt="diagram"]').naturalWidth },
      svg: { blob: img('img[alt="logo"]').src.startsWith("blob:"), w: img('img[alt="logo"]').naturalWidth },
      missing: img('img[alt="gone"]').className,
      remote: { src: img('img[alt="remote"]').getAttribute("src"), held: img('img[alt="remote"]').dataset.remoteSrc },
      notice: !!a.querySelector(".remote-notice"),
      links: Object.fromEntries([...a.querySelectorAll("a")].filter(x => !x.classList.contains("heading-anchor") && !x.closest(".footnotes, .footnote-ref"))
        .map(x => [x.textContent.trim(), x.dataset.path !== undefined ? `doc:${x.dataset.path}${x.dataset.anchor ? "#" + x.dataset.anchor : ""}` : x.dataset.asset ? `asset:${x.dataset.asset}` : x.classList.contains("broken-link") ? "broken" : x.getAttribute("href")])),
    };
  });
  check("B1 GitHub-style heading ids", r.ids, ["user-content-project", "user-content-example", "user-content-example-1", "user-content-qa--notes", "user-content-my_var-setup"]);
  check("B2 every in-page anchor link has a target", r.brokenAnchors, []);
  check("B3 GitHub alerts + Obsidian callouts", r.callouts, ["callout-info:Note", "callout-question:Tip", "callout-important:Important", "callout-warning:Warning", "callout-danger:Caution", "callout-info:Info"]);
  check("B4 plain quote untouched", r.plainQuote, ["Just a quote."]);
  check("B5 multi-line note keeps both lines and its link", [r.noteBody, r.noteHasLink], ["GitHub-style note with a link. Second line.", true]);
  check("B6 callout keeps link + bold", r.infoKeepsFormatting, true);
  check("B7 issue numbers are not tags", r.tags, ["#roadmap", "#2024-plan"]);
  check("B8 footnotes rendered", [r.footnotes, r.footnoteRefs, r.literalFootnote], [["The first footnote. ↩", "A named footnote with a second line. ↩"], ["1", "2"], false]);
  check("B9 frontmatter table", r.frontmatterRows, 2);
  check("B10 relative PNG loads from the folder", r.png, { blob: true, w: 1 });
  check("B11 untyped SVG loads", r.svg, { blob: true, w: 10 });
  check("B12 missing image marked", r.missing, "missing-asset");
  check("B13 remote image held, notice shown", [r.remote.src, r.remote.held, r.notice], [null, "https://example.com/pixel.png", true]);
  check("B14 link targets", r.links, {
    "guide": "doc:guide/intro.md", "setup section": "doc:guide/intro.md#setup", "guide folder": "doc:guide/README.md",
    "account": "doc:site/guide/account.md", "missing doc": "broken", "spec": "asset:files/spec.pdf",
    "intro": "doc:guide/intro.md", "setup via wiki": "doc:guide/intro.md#setup", "nothing-here": "broken",
    "second example": "doc:README.md#example-1", "Q&A": "doc:README.md#qa--notes", "snake": "doc:README.md#my_var-setup",
    "link": "doc:guide/intro.md", "the guide": "doc:guide/intro.md",
  });
  check("B15 no failed local file loads", page.logs.filter(l => /ERR_FILE_NOT_FOUND/.test(l)), []);
  check("B16 nothing requested from example.com yet", page.requests.filter(u => u.includes("example.com")), []);

  // ---------------- C. Links in action
  await page.click('#readerInner a[data-anchor="my_var-setup"]'); await settle(page);
  check("C1 in-page anchor scrolls + updates URL", await page.evaluate(() => {
    const h = document.getElementById("user-content-my_var-setup");
    return [Math.round(h.getBoundingClientRect().top - document.querySelector("#reader").getBoundingClientRect().top) < 80, location.hash];
  }), [true, "#/README.md#my_var-setup"]);
  await page.evaluate(() => document.querySelector("#reader").scrollTop = 0);
  await page.click('#readerInner a:text-is("guide")'); await settle(page);
  check("C2 relative .md link opens in the app", [await crumbs(page), new URL(page.url()).hash], ["guide/intro.md", "#/guide/intro.md"]);
  await page.goBack(); await settle(page);
  check("C3 Back returns to README", await active(page), "README.md");
  await page.click('#readerInner a:text-is("setup section")'); await settle(page, 400);
  check("C4 link with #fragment scrolls to heading", await page.evaluate(() => {
    const h = document.getElementById("user-content-setup");
    const pane = document.querySelector("#reader").getBoundingClientRect(), box = h.getBoundingClientRect();
    return [document.querySelector("#crumbs").textContent.includes("intro"), box.top >= pane.top && box.bottom <= pane.bottom];
  }), [true, true]);
  await page.goBack(); await settle(page);
  await page.click('#readerInner a:text-is("guide folder")'); await settle(page);
  check("C5 folder link opens its README", await active(page), "guide/README.md");
  await page.goBack(); await settle(page);
  await page.click('#readerInner a:text-is("account")'); await settle(page);
  const site = await page.evaluate(() => [...document.querySelectorAll("#readerInner a")].filter(a => !a.classList.contains("heading-anchor")).map(a => a.dataset.path || "broken"));
  check("C6 site-root links (/guide/billing, .html, /README.md)", site, ["site/guide/billing.md", "site/guide/billing.md", "README.md"]);
  await page.goBack(); await settle(page);
  await page.click('#readerInner a:text-is("missing doc")'); await settle(page, 150);
  check("C7 broken link: toast, no navigation", [await toastText(page), new URL(page.url()).hash.split("#")[1]], ["Not found in this folder: nope.md", "/README.md"]);
  const popup = ctx.waitForEvent("page", { timeout: 3000 }).catch(() => null);
  await page.click('#readerInner a:text-is("spec")');
  const opened = await popup;
  check("C8 link to a non-markdown file opens it from the folder", opened ? opened.url().startsWith("blob:") : "no tab opened", true);
  if (opened) await opened.close();

  // ---------------- D. Remote images
  await page.click('.remote-notice button[data-remote="file"]'); await settle(page, 400);
  check("D1 Load releases the image", await page.evaluate(() => document.querySelector('img[alt="remote"]').getAttribute("src")), "https://example.com/pixel.png");
  check("D2 ...and only then is it requested", page.requests.some(u => u.includes("example.com")), true);

  // ---------------- E. Keyboard
  await page.evaluate(() => document.querySelector("#reader").scrollTop = 0);
  await page.click("#readerInner h1");
  await page.keyboard.press("ArrowDown"); await settle(page);
  check("E1 ↓ scrolls the document and keeps the file", [await page.evaluate(() => document.querySelector("#reader").scrollTop > 0), await active(page)], [true, "README.md"]);
  await page.keyboard.press("j"); await settle(page);
  const afterJ = await active(page);
  await page.keyboard.press("k"); await settle(page);
  check("E2 j/k still move between files", [afterJ !== "README.md", await active(page)], [true, "README.md"]);
  await page.keyboard.press("/");
  check("E3 / focuses the filter", await page.evaluate(() => document.activeElement.id), "searchInput");
  await page.keyboard.press("Escape");

  // ---------------- F. Content search
  await page.click("#contentSearchBtn");
  await page.keyboard.type("zebra"); await settle(page, 600);
  const cs = await page.evaluate(() => [...document.querySelectorAll(".file-row")].map(row => `${row.title}:${row.querySelector(".count.hits")?.textContent || "-"}`));
  check("F1 content search finds files by text, with counts", cs, ["notes/n1.md:2"]);
  await clickFile(page, "notes/n1.md");
  check("F2 matches highlighted in the document", await page.evaluate(() => document.querySelectorAll("#readerInner mark.hit").length), 2);
  await page.click("#searchInput"); await page.keyboard.press("Escape"); await settle(page);
  check("F3 Esc clears the search and highlights", await page.evaluate(() => [document.querySelector("#searchInput").value, document.querySelectorAll("mark.hit").length]), ["", 0]);
  await page.click("#contentSearchBtn");

  // ---------------- G. Live reload + rescan
  await clickFile(page, "README.md");
  await page.evaluate(() => window.__fake.edit("README.md", "# Project v2\n\nEdited on disk."));
  await page.waitForFunction(() => document.querySelector("#readerInner h1")?.firstChild?.textContent === "Project v2", null, { timeout: 4000 }).catch(() => {});
  check("G1 open file reloads when it changes on disk", [await page.evaluate(() => document.querySelector("#readerInner h1").firstChild.textContent), await toastText(page)],
    ["Project v2", "Reloaded README.md · 2 changes highlighted"]);
  await page.evaluate(() => window.__fake.add("notes/n3.md", "# Note 3"));
  await page.click("#rescanBtn"); await settle(page, 300);
  check("G2 rescan picks up a new file, marked as new", [await page.evaluate(() => document.querySelector('.file-row[title="notes/n3.md"]')?.classList.contains("unseen")), await toastText(page)], [true, "1 new file"]);
  await page.hover('.file-row[title="notes/n2.md"]');
  await page.click('.file-row[title="notes/n2.md"] .remove'); await settle(page);
  await page.click("#rescanBtn"); await settle(page, 300);
  check("G3 a file removed from the list stays removed after rescan", await page.evaluate(() => !!document.querySelector('.file-row[title="notes/n2.md"]')), false);
  await clickFile(page, "notes/n3.md");
  await page.evaluate(() => window.__fake.remove("notes/n3.md"));
  await page.click("#rescanBtn"); await settle(page, 300);
  check("G4 deleting the open file is reported", [await toastText(page), await page.evaluate(() => !!document.querySelector('.file-row[title="notes/n3.md"]'))], ["n3.md was moved or deleted", false]);

  // ---------------- H. Opening the same folder again; print
  await page.click("#openFolderBtn"); await page.waitForTimeout(500);
  check("H1 reopening the same folder keeps one Recent entry", await page.evaluate(() => [...document.querySelectorAll(".recent .rtitle")].map(e => e.textContent)), ["docs"]);
  await clickFile(page, "guide/intro.md");
  const pdf = await page.pdf({ format: "A4" });
  check("H2 printing a long document gives several pages", (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length, n => n >= 4);

  // ---------------- I. Outline
  await page.close();

  const p2 = await openFixture(ctx);
  const outline = await p2.evaluate(() => [...document.querySelectorAll("#outline a")].map(a => a.className.replace(" on", "") + ":" + a.textContent));
  check("I1 outline lists headings", outline, ["lvl-0:Project", "lvl-1:Example", "lvl-1:Example", "lvl-1:Q&A — notes", "lvl-1:my_var setup"]);
  await p2.click('#outline a[data-anchor="qa--notes"]'); await settle(p2);
  check("I2 outline click scrolls to the heading", await p2.evaluate(() => Math.abs(document.getElementById("user-content-qa--notes").getBoundingClientRect().top - document.querySelector("#reader").getBoundingClientRect().top) < 80), true);
  await p2.setViewportSize({ width: 1000, height: 900 }); await settle(p2);
  check("I3 outline hidden on narrower windows", await p2.evaluate(() => getComputedStyle(document.querySelector("#outline")).display), "none");
  await p2.setViewportSize({ width: 1400, height: 900 });

  // ---------------- J. Rendering cost: open = no tree rebuild; filter typing is debounced
  const rebuilds = await p2.evaluate(async () => {
    let n = 0;
    const mo = new MutationObserver(list => { for (const m of list) if ([...m.addedNodes].some(x => x.id === "fileTree")) n++; });
    mo.observe(document.querySelector("#filesSection"), { childList: true });
    document.querySelector('.file-row[title="a-first.md"] .row-main').click();
    await new Promise(r => setTimeout(r, 300));
    const onOpen = n;
    const input = document.querySelector("#searchInput");
    for (const ch of "notes") { input.value += ch; input.dispatchEvent(new Event("input")); await new Promise(r => setTimeout(r, 30)); }
    await new Promise(r => setTimeout(r, 400));
    mo.disconnect();
    return { onOpen, whileTyping: n - onOpen };
  });
  check("J1 opening a file doesn't rebuild the tree", rebuilds.onOpen, 0);
  check("J2 typing 5 characters rebuilds once", rebuilds.whileTyping, 1);
  await p2.evaluate(() => { const i = document.querySelector("#searchInput"); i.value = ""; i.dispatchEvent(new Event("input")); });
  await settle(p2);

  // ---------------- K. Keyboard access to files
  await p2.focus("#searchInput");
  let reached = false;
  for (let i = 0; i < 25 && !reached; i++) {
    await p2.keyboard.press("Tab");
    reached = await p2.evaluate(() => document.activeElement.matches(".file-row .row-main"));
  }
  const tabbed = await p2.evaluate(() => document.activeElement.closest(".file-row")?.title);
  await p2.keyboard.press("Enter"); await settle(p2);
  check("K1 files reachable with Tab and opened with Enter", [reached, await active(p2) === tabbed], [true, true]);

  // ---------------- L. Sidebar: toggle, resize
  await p2.keyboard.press("Meta+b"); await settle(p2);
  check("L1 ⌘B hides the sidebar", await p2.evaluate(() => [document.querySelector("#app").classList.contains("sidebar-hidden"), Math.round(document.querySelector(".sidebar").getBoundingClientRect().width)]), [true, 0]);
  await p2.click("#sidebarToggle"); await settle(p2);
  const handle = await p2.locator("#sidebarResizer").boundingBox();
  await p2.mouse.move(handle.x + 3, handle.y + 200);
  await p2.mouse.down();
  await p2.mouse.move(handle.x + 103, handle.y + 200, { steps: 5 });
  await p2.mouse.up();
  check("L2 dragging the edge resizes and remembers", await p2.evaluate(() => [Math.round(document.querySelector(".sidebar").getBoundingClientRect().width), JSON.parse(localStorage.getItem("mdviewer.layout.v1")).sidebarWidth]), [400, 400]);
  if (shotDir) await p2.screenshot({ path: path.join(shotDir, "20-desktop.png") });
  await p2.dblclick("#sidebarResizer");

  // ---------------- M. Settings
  check("M1 settings apply as you change them, with outline and remote-image options",await p2.evaluate(() => [!!document.querySelector("#tweaksApply"), !!document.querySelector("#tw-outline"), document.querySelector('input[name="tw-remote"]:checked').value]), [false, true, "block"]);
  await p2.click("#settingsBtn");
  await p2.click('label:has(input[name="tw-face"][value="serif"])'); await settle(p2, 100);
  const serif = await p2.evaluate(() => [getComputedStyle(document.querySelector("#readerInner")).fontFamily.split(",")[0], JSON.parse(localStorage.getItem("mdviewer.tweaks.v2")).bodyFace]);
  await p2.click('label:has(input[name="tw-face"][value="sans"])'); await settle(p2, 100);
  check("M3 segmented Body face switches the reading font", [serif, await p2.evaluate(() => getComputedStyle(document.querySelector("#readerInner")).fontFamily.split(",")[0])], [['"IBM Plex Serif"', "serif"], '"IBM Plex Sans"']);
  await p2.click("#settingsBtn");
  check("M2 default reading width is 76ch", await p2.evaluate(() => document.documentElement.style.getPropertyValue("--reader-width")), "76ch");
  await p2.close();

  // ---------------- N. Narrow screens
  const p3 = await openFixture(ctx, { viewport: { width: 600, height: 900 } });
  const vis = () => p3.evaluate(() => { const r = document.querySelector(".sidebar").getBoundingClientRect(); return r.right > 0 && getComputedStyle(document.querySelector(".sidebar")).visibility === "visible"; });
  const drawerClosed = await vis();
  await p3.click("#sidebarToggle"); await settle(p3, 300);
  const drawerOpen = await vis();
  if (shotDir) await p3.screenshot({ path: path.join(shotDir, "21-mobile-drawer.png") });
  await p3.click("#expandAllBtn"); await settle(p3, 250);
  const stillOpen = await vis();
  await p3.click("#collapseAllBtn"); await settle(p3, 250);
  check("N0 mobile: Expand/Collapse all keep the drawer open", [stillOpen, await vis()], [true, true]);
  await clickFile(p3, "a-first.md"); await settle(p3, 300);
  check("N1 mobile: drawer hidden, opens, closes after picking a file", [drawerClosed, drawerOpen, await vis(), await active(p3)], [false, true, false, "a-first.md"]);
  await p3.close();

  // ---------------- O. URL route on load, with fallback
  const p4 = await openFixture(ctx, { beforeOpen: { hash: "#/guide/intro.md#setup" } });
  check("O1 URL opens that file at that heading", [await active(p4), await p4.evaluate(() => location.hash)], ["guide/intro.md", "#/guide/intro.md#setup"]);
  await p4.close();
  const p5 = await openFixture(ctx, { beforeOpen: { hash: "#/does/not/exist.md" } });
  check("O2 unknown path in URL falls back to README", await active(p5), "README.md");
  await p5.close();

  // ---------------- P. Race: slow file then fast file
  const p6 = await openFixture(ctx);
  await p6.evaluate(() => window.__fake.slow("notes/n1.md", 400));
  await expandAll(p6);
  await p6.evaluate(() => {
    document.querySelector('.file-row[title="notes/n1.md"] .row-main').click();
    setTimeout(() => document.querySelector('.file-row[title="a-first.md"] .row-main').click(), 50);
  });
  await p6.waitForTimeout(900);
  check("P1 the last file clicked wins", [await active(p6), await p6.evaluate(() => document.querySelector("#readerInner h1").firstChild.textContent)], ["a-first.md", "A first"]);
  await p6.close();

  // ---------------- Q. Multi-item drop
  const p7 = await ctx.newPage();
  await p7.goto(pageUrl);
  await p7.evaluate(installHarness, { files: { "one/a.md": "# A", "two/b.md": "# B" }, rootName: "drop" });
  await p7.evaluate(() => {
    const dirs = window.__fake.root.children;
    let dispatching = true;   // like the browser: handles are only handed out during the event
    const items = dirs.map(d => ({ kind: "file", getAsFileSystemHandle: () => Promise.resolve(dispatching ? d : null) }));
    const ev = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", { value: { types: ["Files"], items, files: [] } });
    window.dispatchEvent(ev);
    dispatching = false;
  });
  await p7.waitForTimeout(400);
  await expandAll(p7);
  check("Q1 dropping two folders loads both", await p7.evaluate(() => [...document.querySelectorAll(".file-row")].map(r => r.title)), ["one/a.md", "two/b.md"]);
  await p7.close();

  // ---------------- R. Storage failure doesn't block opening
  const ctxNoIdb = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctxNoIdb.addInitScript(() => { indexedDB.open = () => { throw new Error("storage blocked"); }; });
  const p8 = await openFixture(ctxNoIdb);
  check("R1 folder opens even when IndexedDB fails", [await active(p8), await p8.evaluate(() => document.querySelectorAll(".file-row").length > 0)], ["README.md", true]);
  await ctxNoIdb.close();

  // ---------------- T. Extras
  const p9 = await openFixture(ctx);
  await p9.keyboard.press("Meta+b"); await settle(p9);
  await p9.click("#readerInner h1");
  await p9.keyboard.press("/"); await settle(p9);
  check("T1 / brings back a hidden sidebar and focuses the filter", await p9.evaluate(() => [document.querySelector("#app").classList.contains("sidebar-hidden"), document.activeElement.id]), [false, "searchInput"]);
  await p9.keyboard.press("Escape");
  await p9.keyboard.press("Meta+b");   // leave the stored layout as we found it
  await p9.keyboard.press("Meta+b");
  await p9.close();

  const big = {};
  for (let i = 0; i < 1000; i++) big[`d${i % 40}/f${i}.md`] = "# x";
  const p10 = await ctx.newPage();
  await p10.goto(pageUrl);
  await p10.evaluate(installHarness, { files: big, rootName: "big" });
  await p10.evaluate(() => {
    const proto = Object.getPrototypeOf(window.__fake.root);
    const entries = proto.entries;
    proto.entries = async function* () { for await (const e of entries.call(this)) { await new Promise(r => setTimeout(r, 1)); yield e; } };
  });
  await p10.click("#openFolderBtn");
  let sawProgress = "";
  for (let i = 0; i < 200 && !sawProgress; i++) {
    const t = await toastText(p10);
    if (t.startsWith("Scanning…")) sawProgress = t;
    else await p10.waitForTimeout(25);
  }
  await p10.waitForSelector(".file-row.active", { state: "attached", timeout: 30000 });
  check("T2 big folders show scan progress", sawProgress, t => /^Scanning… [\d,]+ items$/.test(t));
  await p10.close();

  const colours = {};
  for (const theme of ["slate", "paper", "catppuccin-latte", "catppuccin-mocha", "gruvbox-light", "gruvbox-dark", "solarized-light", "solarized-dark", "tokyo-night", "nord", "dracula", "one-dark"]) {
    const pt = await ctx.newPage();
    await pt.goto(pageUrl);
    await pt.evaluate(t => localStorage.setItem("mdviewer.tweaks.v2", JSON.stringify({ theme: t })), theme);
    await pt.reload();
    await pt.evaluate(installHarness, { files: FIXTURE, rootName: "docs" });
    await pt.click("#openFolderBtn");
    await pt.waitForSelector(".callout");
    colours[theme] = await pt.evaluate(() => new Set([...document.querySelectorAll(".callout")].slice(0, 5).map(c => getComputedStyle(c.querySelector(".callout-title")).color)).size);
    await pt.close();
  }
  check("T3 all five alert kinds have distinct colours in every theme", Object.entries(colours).filter(([, n]) => n !== 5), []);
  await ctx.newPage().then(async pr => { await pr.goto(pageUrl); await pr.evaluate(() => localStorage.removeItem("mdviewer.tweaks.v2")); await pr.close(); });

  // ---------------- U. Redesign: settings migration and defaults
  const ctxM = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const pm = await ctxM.newPage();
  await pm.goto(pageUrl);
  await pm.evaluate(() => { localStorage.clear(); localStorage.setItem("mdviewer.tweaks.v1", JSON.stringify({ bodySize: 17, readingWidth: 120, bodyFace: "sans", theme: "one-dark" })); });
  await pm.reload(); await settle(pm);
  check("U1 old settings migrate: Slate, old defaults updated, choices kept", await pm.evaluate(() => {
    const t = JSON.parse(localStorage.getItem("mdviewer.tweaks.v2"));
    return [t.theme, t.readingWidth, t.bodySize, t.bodyFace, getComputedStyle(document.body).backgroundColor];
  }), ["slate", 76, 16, "sans", "rgb(46, 52, 64)"]);
  await pm.evaluate(() => { localStorage.clear(); localStorage.setItem("mdviewer.tweaks.v1", JSON.stringify({ readingWidth: 90, bodySize: 18 })); });
  await pm.reload(); await settle(pm);
  check("U2 values you changed survive the migration", await pm.evaluate(() => { const t = JSON.parse(localStorage.getItem("mdviewer.tweaks.v2")); return [t.readingWidth, t.bodySize]; }), [90, 18]);
  await pm.evaluate(() => localStorage.clear());
  await pm.reload(); await settle(pm);
  check("U3 fresh visitors get Slate + sans", await pm.evaluate(() => [document.querySelector("#tw-theme").value, document.querySelector('input[name="tw-face"]:checked').value]), ["slate", "sans"]);
  await ctxM.close();

  // ---------------- V. What changed (#2)
  const DOC = "# T\n\nAlpha para.\n\nBeta para.\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n";
  const pv = await openFixture(ctx, { files: { "doc.md": DOC, "notes/other.md": "# Other\n\nText." } });
  await pv.evaluate(d => window.__fake.edit("doc.md", d.replace("Beta para.", "Beta para, edited.").replace("- two", "- two\n- three").replace("| 3 | 4 |", "| 3 | 5 |")), DOC);
  await pv.waitForFunction(() => document.querySelectorAll("#readerInner .changed").length > 0, null, { timeout: 4000 }).catch(() => {});
  check("V1 live reload highlights only what changed", await pv.evaluate(() => [...document.querySelectorAll("#readerInner .changed")].map(n => `${n.tagName}:${n.textContent.replace(/\s+/g, " ").trim()}`)),
    ["P:Beta para, edited.", "LI:three", "TR:3 5"]);
  await pv.waitForTimeout(4400);
  check("V2 highlights fade after they've been seen", await pv.evaluate(() => document.querySelectorAll("#readerInner .changed.settled").length), 3);
  await pv.evaluate(() => window.__fake.edit("notes/other.md", "# Other\n\nText, edited elsewhere."));
  await pv.click("#rescanBtn"); await settle(pv, 300);
  const marked = await pv.evaluate(() => ({
    file: document.querySelector('.file-row[title="notes/other.md"]')?.classList.contains("unseen"),
    folderPip: !!document.querySelector('.dir-row[title="notes"] .pip'),
    toast: document.querySelector("#toast.on")?.textContent,
  }));
  check("V3 a file edited in the background is marked, folder too", marked, { file: true, folderPip: true, toast: "1 changed" });
  await clickFile(pv, "notes/other.md");
  check("V4 opening it clears the mark", await pv.evaluate(() => [document.querySelector('.file-row[title="notes/other.md"]').classList.contains("unseen"), !!document.querySelector(".pip")]), [false, false]);
  await pv.close();

  // ---------------- W. Copy button (#3)
  const CODE = "const answer = 42; // " + "x".repeat(300);
  const pw = await openFixture(ctx, { files: { "code.md": "# Code\n\n```js\n" + CODE + "\nconsole.log(answer);\n```\n\n```\nplain block\n```\n", "notes.txt": "plain text file" } });
  check("W1 every code block gets a Copy button", await pw.evaluate(() => [document.querySelectorAll("#readerInner pre").length, document.querySelectorAll("#readerInner .copy-code").length]), [2, 2]);
  const hidden = await pw.evaluate(() => getComputedStyle(document.querySelector(".copy-code")).opacity);
  await pw.hover("#readerInner .code-block");
  await settle(pw, 200);
  check("W2 hidden until you hover the block", [hidden, await pw.evaluate(() => getComputedStyle(document.querySelector(".copy-code")).opacity)], ["0", "1"]);
  await pw.evaluate(() => { navigator.clipboard.writeText = async t => { window.__copied = t; }; });
  await pw.click("#readerInner .copy-code");
  await settle(pw, 100);
  const copied = await pw.evaluate(() => [window.__copied, document.querySelector(".copy-code").textContent]);
  await pw.waitForTimeout(1600);
  check("W3 copies the exact code, says Copied, then resets", [copied[0] === CODE + "\nconsole.log(answer);", copied[1], await pw.evaluate(() => document.querySelector(".copy-code").textContent)], [true, "Copied", "Copy"]);
  await pw.evaluate(() => {
    navigator.clipboard.writeText = () => Promise.reject(new Error("blocked"));
    document.execCommand = cmd => { window.__fallback = [cmd, document.querySelector(".clipboard-buffer")?.value]; return true; };
  });
  await pw.click("#readerInner .copy-code");
  await settle(pw, 100);
  check("W4 falls back when the clipboard API is blocked", await pw.evaluate(() => [window.__fallback[0], window.__fallback[1].startsWith("const answer"), !!document.querySelector(".clipboard-buffer")]), ["copy", true, false]);
  check("W5 the button stays in the corner while long code scrolls", await pw.evaluate(() => {
    const pre = document.querySelector("#readerInner pre"), btn = document.querySelector(".copy-code");
    const before = btn.getBoundingClientRect().left;
    pre.scrollLeft = 400;
    return [pre.scrollLeft > 0, btn.getBoundingClientRect().left === before];
  }), [true, true]);
  await pw.emulateMedia({ media: "print" });
  check("W6 hidden when printing", await pw.evaluate(() => getComputedStyle(document.querySelector(".copy-code")).display), "none");
  await pw.emulateMedia({ media: "screen" });
  await clickFile(pw, "notes.txt");
  check("W7 plain text files have no Copy button", await pw.evaluate(() => document.querySelectorAll("#readerInner .copy-code").length), 0);
  await pw.close();

  // ---------------- X. Match system theme (#4)
  const ctxX = await browser.newContext({ viewport: { width: 1200, height: 800 }, colorScheme: "dark" });
  const px = await ctxX.newPage();
  await px.goto(pageUrl);
  await px.evaluate(() => localStorage.clear());
  await px.reload(); await settle(px, 150);
  check("X0 Slate stays the default", await px.evaluate(() => document.querySelector("#tw-theme").value), "slate");
  await px.click("#settingsBtn");
  await px.selectOption("#tw-theme", "system"); await settle(px, 150);
  const bg = () => px.evaluate(() => [getComputedStyle(document.body).backgroundColor, document.querySelector('meta[name="theme-color"]').content]);
  check("X1 Match system uses Slate when the OS is dark", await bg(), ["rgb(46, 52, 64)", "#2e3440"]);
  await px.emulateMedia({ colorScheme: "light" }); await settle(px, 150);
  check("X2 and switches to Paper live when the OS goes light", await bg(), ["rgb(250, 248, 243)", "#faf8f3"]);
  check("X3 the choice is saved as system", await px.evaluate(() => JSON.parse(localStorage.getItem("mdviewer.tweaks.v2")).theme), "system");
  await px.reload(); await settle(px, 150);
  check("X4 still follows the OS after a reload", [await bg(), await px.evaluate(() => document.querySelector("#tw-theme").value)], [["rgb(250, 248, 243)", "#faf8f3"], "system"]);
  await ctxX.close();

  // ---------------- Y. Clickable tags (#5)
  const py = await openFixture(ctx);
  check("Y1 tags are buttons", await py.evaluate(() => [...document.querySelectorAll("#readerInner .tag-token")].map(t => t.tagName)), ["BUTTON", "BUTTON"]);
  await py.keyboard.press("Meta+b"); await settle(py);
  await py.click('#readerInner .tag-token:text-is("#roadmap")'); await settle(py, 600);
  check("Y2 clicking a tag searches the folder's contents for it", await py.evaluate(() => ({
    sidebar: !document.querySelector("#app").classList.contains("sidebar-hidden"),
    contentSearch: document.querySelector("#contentSearchBtn").getAttribute("aria-pressed"),
    query: document.querySelector("#searchInput").value,
    files: [...document.querySelectorAll(".file-row")].map(r => `${r.title}:${r.querySelector(".count.hits")?.textContent || "-"}`),
    marks: [...document.querySelectorAll("#readerInner mark.hit")].length,
    tagHits: [...document.querySelectorAll("#readerInner .tag-token.hit")].map(t => t.textContent),
  })), { sidebar: true, contentSearch: "true", query: "#roadmap", files: ["README.md:1"], marks: 0, tagHits: ["#roadmap"] });
  await py.click("#searchInput"); await py.keyboard.press("Escape"); await settle(py);
  await py.focus('#readerInner .tag-token:text-is("#2024-plan")');
  await py.keyboard.press("Enter"); await settle(py, 600);
  check("Y3 tags work from the keyboard", await py.evaluate(() => [document.querySelector("#searchInput").value, [...document.querySelectorAll(".file-row")].map(r => r.title)]), ["#2024-plan", ["README.md"]]);
  await py.close();

  // ---------------- Z. Scroll memory (#6)
  const pz = await openFixture(ctx);
  const top = () => pz.evaluate(() => Math.round(document.querySelector("#reader").scrollTop));
  const near = (a, b) => Math.abs(a - b) <= 3;
  await pz.evaluate(() => { document.querySelector("#reader").scrollTop = 1200; });
  await settle(pz, 150);
  await clickFile(pz, "guide/intro.md");
  const introTop = await top();
  await clickFile(pz, "README.md");
  check("Z1 a first visit starts at the top; returning restores where you were", [introTop, near(await top(), 1200)], [0, true]);
  await pz.evaluate(() => { document.querySelector("#reader").scrollTop = 2000; });
  await settle(pz, 150);
  await clickFile(pz, "guide/intro.md");
  await pz.goBack(); await settle(pz, 300);
  check("Z2 Back lands where you were", [await active(pz), near(await top(), 2000)], ["README.md", true]);
  await pz.goForward(); await settle(pz, 300);
  await pz.click('#readerInner a:text-is("readme")'); await settle(pz, 300);
  check("Z3 an ordinary link also returns to where you were", near(await top(), 2000), true);
  await clickFile(pz, "guide/intro.md");
  await pz.evaluate(() => { location.hash = ""; });
  await clickFile(pz, "README.md");
  await pz.click('#readerInner a[data-anchor="my_var-setup"]'); await settle(pz, 200);
  check("Z4 a #heading link decides where the page opens", await pz.evaluate(() => Math.abs(document.getElementById("user-content-my_var-setup").getBoundingClientRect().top - document.querySelector("#reader").getBoundingClientRect().top) < 80), true);
  await pz.evaluate(() => { document.querySelector("#reader").scrollTop = 900; });
  await settle(pz, 500);
  await pz.reload();
  await pz.evaluate(installHarness, { files: FIXTURE, rootName: "docs" });
  await pz.click("#openFolderBtn");
  await pz.waitForSelector(".file-row.active"); await settle(pz, 400);
  check("Z5 survives a reload of the tab", [await active(pz), near(await top(), 900)], ["README.md", true]);
  await pz.close();

  // ---------------- AA. Your place survives images loading late (#7)
  const TALL = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="1400"><rect width="600" height="1400" fill="#888"/></svg>`;
  const IMG1 = `# Images\n\n![tall](tall.svg)\n\n${Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}. ` + "steady reading text ".repeat(12)).join("\n\n")}`;
  const IMG2 = IMG1.replace("Paragraph 38.", "Paragraph 38, edited.");
  const IMG3 = IMG2.replace("![tall]", "A paragraph added above the image.\n\n![tall]");
  const IMG_FILES = { "images.md": IMG1, "other.md": "# Other\n\nShort.", "tall.svg": TALL };
  const firstPara = p => p.evaluate(() => {
    const top = document.querySelector("#reader").getBoundingClientRect().top;
    const n = [...document.querySelectorAll("#readerInner p")].find(x => x.getBoundingClientRect().bottom > top + 1);
    return n ? n.textContent.split(/[.,]/)[0] : null;
  });
  const readTo = (p, label) => p.evaluate(l => {
    const r = document.querySelector("#reader");
    const n = [...document.querySelectorAll("#readerInner p")].find(x => x.textContent.startsWith(l + "."));
    r.scrollTop += n.getBoundingClientRect().top - r.getBoundingClientRect().top;
  }, label);
  const imageLoaded = p => p.waitForFunction(() => { const i = document.querySelector("#readerInner img"); return i && i.complete && i.naturalHeight > 0; }, null, { timeout: 6000 });
  const pa = await openFixture(ctx, { files: IMG_FILES, rootName: "pics" });
  await imageLoaded(pa);
  await readTo(pa, "Paragraph 20"); await settle(pa, 400);
  await pa.evaluate(d => window.__fake.edit("images.md", d), IMG2);
  await pa.waitForFunction(() => document.querySelector("#readerInner .changed"), null, { timeout: 5000 });
  await imageLoaded(pa); await settle(pa, 300);
  check("AA1 a live reload keeps your paragraph, with a tall image above it", await firstPara(pa), "Paragraph 20");
  await pa.evaluate(d => window.__fake.edit("images.md", d), IMG3);
  await pa.waitForFunction(() => [...document.querySelectorAll("#readerInner p")].some(p => p.textContent.startsWith("A paragraph added")), null, { timeout: 5000 });
  await imageLoaded(pa); await settle(pa, 300);
  check("AA2 so does an edit above it", await firstPara(pa), "Paragraph 20");
  await clickFile(pa, "other.md");
  await pa.goBack(); await imageLoaded(pa); await settle(pa, 300);
  check("AA3 Back returns to the same paragraph", [await active(pa), await firstPara(pa)], ["images.md", "Paragraph 20"]);
  await readTo(pa, "Paragraph 30"); await settle(pa, 500);
  await pa.reload();
  await pa.evaluate(installHarness, { files: { ...IMG_FILES, "images.md": IMG3 }, rootName: "pics" });
  await pa.click("#openFolderBtn");
  await pa.waitForSelector(".file-row.active"); await imageLoaded(pa); await settle(pa, 300);
  check("AA4 and so does a reload of the tab", await firstPara(pa), "Paragraph 30");
  await pa.evaluate(() => window.__fake.slow("tall.svg", 1500));
  await clickFile(pa, "other.md");
  await clickFile(pa, "images.md");
  await pa.mouse.move(700, 400);
  await pa.mouse.wheel(0, 900); await settle(pa, 200);
  const scrolledTo = await firstPara(pa);
  await imageLoaded(pa); await settle(pa, 300);
  check("AA5 scrolling while an image loads isn't undone", [scrolledTo !== "Paragraph 30", await firstPara(pa) === scrolledTo], [true, true]);
  await pa.close();

  // ---------------- BB. A save that changes nothing (#8)
  const SAME = "# Same\n\n<details><summary>More</summary>\n\nHidden text.\n\n</details>\n\nEnd.";
  const pb = await openFixture(ctx, { files: { "same.md": SAME } });
  await pb.click("#readerInner summary");
  await pb.evaluate(d => window.__fake.edit("same.md", d), SAME);
  await settle(pb, 2600);
  check("BB1 saving without changes leaves the page alone", await pb.evaluate(() => [document.querySelector("#readerInner details").open, document.querySelector("#toast").textContent]), [true, ""]);
  await pb.evaluate(d => window.__fake.edit("same.md", d.replace("End.", "The end.")), SAME);
  await pb.waitForFunction(() => document.querySelector("#readerInner .changed"), null, { timeout: 5000 }).catch(() => {});
  check("BB2 a real edit still reloads and highlights it", await pb.evaluate(() => [...document.querySelectorAll("#readerInner .changed")].map(n => n.textContent.trim())), ["The end."]);
  await pb.close();

  // ---------------- CC. "Load" for remote images lasts through reloads (#9)
  const REMOTE = "# Remote\n\n![pic](https://example.com/pic.svg)\n\nText.";
  const pc = await openFixture(ctx, { files: { "remote.md": REMOTE, "second.md": "# Second\n\n![pic](https://example.com/other.svg)" } });
  await pc.route(/example\.com/, r => r.fulfill({ status: 200, contentType: "image/svg+xml", body: TALL }));
  const remoteState = () => pc.evaluate(() => [!!document.querySelector(".remote-notice"), !!document.querySelector("#readerInner img[data-remote-src]")]);
  await pc.click('.remote-notice button[data-remote="file"]'); await settle(pc, 200);
  await pc.evaluate(d => window.__fake.edit("remote.md", d + "\n\nMore text."), REMOTE);
  await pc.waitForFunction(() => [...document.querySelectorAll("#readerInner p")].some(p => p.textContent === "More text."), null, { timeout: 5000 });
  check("CC1 after Load, a save keeps the images and doesn't ask again", await remoteState(), [false, false]);
  await clickFile(pc, "second.md");
  check("CC2 other files still ask", await remoteState(), [true, true]);
  await clickFile(pc, "remote.md");
  check("CC3 the file you allowed doesn't ask when you come back to it", await remoteState(), [false, false]);
  await pc.click("#openFolderBtn"); await pc.waitForSelector(".file-row.active"); await settle(pc, 300);
  check("CC4 opening the folder again asks again", [await active(pc), ...(await remoteState())], ["remote.md", true, true]);
  await pc.close();

  // ---------------- DD. [[#Heading]] in the same note (#10)
  const pd = await openFixture(ctx, { files: {
    "note.md": `# Note\n\nJump to [[#Second part]] or [[other#Far heading]].\n\n${filler}\n\n## Second part\n\nHere.\n\n${filler}`,
    "other.md": `# Other\n\n${filler}\n\n## Far heading\n\nThere.\n\n${filler}`,
  } });
  const headingAtTop = (p, id) => p.evaluate(i => Math.abs(document.getElementById(i).getBoundingClientRect().top - document.querySelector("#reader").getBoundingClientRect().top) < 80, id);
  check("DD1 [[#Heading]] isn't marked broken", await pd.evaluate(() => [...document.querySelectorAll("#readerInner .wiki-link")].map(a => a.classList.contains("broken-link"))), [false, false]);
  await pd.click('#readerInner .wiki-link:text-is("#Second part")'); await settle(pd, 300);
  check("DD2 it goes to that heading in the same file", [await pd.evaluate(() => location.hash), await headingAtTop(pd, "user-content-second-part")], ["#/note.md#second-part", true]);
  await pd.click('#readerInner .wiki-link:text-is("other#Far heading")'); await settle(pd, 400);
  check("DD3 [[other#Heading]] still opens the other note at its heading", [await active(pd), await headingAtTop(pd, "user-content-far-heading")], ["other.md", true]);
  await pd.close();

  // ---------------- EE. A subfolder the browser can't read (#11)
  const pe = await ctx.newPage();
  await pe.goto(pageUrl);
  await pe.evaluate(installHarness, { files: { "ok.md": "# Fine", "notes/n.md": "# Note" }, rootName: "mixed" });
  await pe.evaluate(() => {
    window.__fake.root.children.push({ kind: "directory", name: "locked", async *entries() { throw new DOMException("denied", "NotReadableError"); } });
  });
  await pe.click("#openFolderBtn");
  await pe.waitForSelector(".file-row.active", { state: "attached", timeout: 5000 }).catch(() => {});
  await settle(pe, 300);
  check("EE1 it opens with everything else in the folder", await pe.evaluate(() => [...document.querySelectorAll(".file-row")].map(r => r.title)), ["ok.md", "notes/n.md"]);
  check("EE2 and says what it skipped", await toastText(pe), "Skipped 1 folder the browser couldn't read");
  await pe.waitForTimeout(3400);
  await pe.click("#rescanBtn", { timeout: 2000 }).catch(() => {}); await settle(pe, 400);
  check("EE3 rescans skip it quietly", [await pe.evaluate(() => document.querySelectorAll(".file-row").length), await toastText(pe)], [2, "No new, changed or removed files"]);
  await pe.close();
  const pe2 = await ctx.newPage();
  await pe2.goto(pageUrl);
  await pe2.evaluate(() => {
    // The FileSystemEntry API that Safari and Firefox hand over on a drop.
    const file = (name, text) => ({ isFile: true, isDirectory: false, name, file: ok => ok(new File([text], name)) });
    const dir = (name, kids, unreadable) => ({ isFile: false, isDirectory: true, name, createReader() {
      let sent = false;
      return { readEntries(ok, fail) { if (unreadable) fail(new DOMException("denied", "NotReadableError")); else { ok(sent ? [] : kids); sent = true; } } };
    } });
    const root = dir("dropped", [file("a.md", "# A"), dir("locked", [], true), dir("sub", [file("b.md", "# B")])]);
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { types: ["Files"], items: [{ kind: "file", webkitGetAsEntry: () => root }], files: [] } });
    window.dispatchEvent(drop);
  });
  await pe2.waitForSelector(".file-row", { state: "attached", timeout: 5000 }).catch(() => {});
  await settle(pe2, 300);
  check("EE4 so does a folder dropped in Safari or Firefox", [await pe2.evaluate(() => [...document.querySelectorAll(".file-row")].map(r => r.title)), await toastText(pe2)], [["a.md", "sub/b.md"], "Skipped 1 folder the browser couldn't read"]);
  await pe2.close();

  // ---------------- FF. The Settings popover from the keyboard (#12)
  const pf = await openFixture(ctx);
  const settingsState = () => pf.evaluate(() => [document.querySelector("#tweaks").classList.contains("on"), document.querySelector("#settingsBtn").getAttribute("aria-expanded"), document.activeElement.id]);
  check("FF1 the button tells screen readers Settings is closed", (await settingsState()).slice(0, 2), [false, "false"]);
  await pf.focus("#settingsBtn"); await pf.keyboard.press("Enter"); await settle(pf, 100);
  check("FF2 Enter opens it and moves focus into it", await settingsState(), [true, "true", "tw-size"]);
  await pf.keyboard.press("Tab"); await pf.keyboard.press("Escape"); await settle(pf, 100);
  check("FF3 Escape closes it and puts focus back on the button", await settingsState(), [false, "false", "settingsBtn"]);
  await pf.click("#settingsBtn"); await settle(pf, 100);
  const byMouse = await settingsState();
  await pf.click("#readerInner h1"); await settle(pf, 100);
  check("FF4 a click opens it without moving focus; a click outside closes it", [byMouse, (await settingsState()).slice(0, 2)], [[true, "true", "settingsBtn"], [false, "false"]]);
  await pf.close();

  // ---------------- GG. Reduced motion (#13)
  const motionOf = p => p.evaluate(() => {
    const css = sel => getComputedStyle(document.querySelector(sel));
    return [css("#toast").transitionProperty, parseFloat(css("#toast").transform.split(",").pop()), css("#sidebar").transitionDuration, css(".tree-row .twist svg").transitionDuration];
  });
  const drawerOpenMotion = async p => { await p.click("#sidebarToggle"); await settle(p, 300); return p.evaluate(() => getComputedStyle(document.querySelector("#sidebar")).transitionDuration); };
  const ctxG = await browser.newContext({ viewport: { width: 390, height: 800 }, reducedMotion: "reduce" });
  const pg = await openFixture(ctxG);
  check("GG1 with reduced motion on, nothing slides or rotates; toasts still fade", [await motionOf(pg), await drawerOpenMotion(pg)], [["opacity", 0, "0s", "0s"], "0s"]);
  await ctxG.close();
  const ctxG2 = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const pg2 = await openFixture(ctxG2);
  check("GG2 nothing changes when it's off", [await motionOf(pg2), await drawerOpenMotion(pg2)], [["opacity, transform", 8, "0.16s, 0s", "0.12s"], "0.16s"]);
  await ctxG2.close();

  // ---------------- S. Errors across the run
  check("S1 no page errors or CSP violations", page.logs.filter(l => !/ERR_NAME_NOT_RESOLVED|ERR_INTERNET|example\.com|net::ERR/.test(l)), []);

  console.log(results.join("\n"));
  console.log(`\n${results.filter(x => x.startsWith("PASS")).length}/${results.length} passed`);
  if (results.some(x => x.startsWith("FAIL"))) process.exitCode = 1;
  await browser.close();
})().catch(e => { console.log(results.join("\n")); console.error("\nCRASHED:", e.message.split("\n")[0]); process.exit(1); });
