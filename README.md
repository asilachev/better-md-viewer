# Better MD viewer

A calm reader for folders of Markdown that runs entirely in your browser. Open a folder and read: nothing is uploaded, nothing is installed, and the page makes no network requests of its own.

**[Open the viewer →](https://asilachev.github.io/better-md-viewer/)**

![Better MD viewer showing a handbook folder in the Slate theme](docs/screenshots/slate.png)

## Features

- **Whole folders, not single files.** A compact tree with collapsible folders, a filter by name, and search inside files with match counts.
- **Links that work.** Relative links, images, `#heading` anchors and `[[wiki links]]` resolve inside the folder, and the URL follows the file and heading you're on.
- **GitHub-flavoured Markdown.** Tables, task lists, alerts (`> [!NOTE]`), footnotes, frontmatter and syntax highlighting.
- **Live reload.** The open file re-renders when it changes on disk, and new or deleted files show up on their own.
- **Picks up where you left off.** Recent folders and the last file you read are remembered in the browser.
- **Private by design.** Fonts and libraries ship with the page, a Content-Security-Policy keeps it local, and remote images stay blocked until you allow them.
- **Comfortable to read.** An outline of headings, twelve themes, adjustable type and width, a layout for phones, and clean printing.

## Use it

1. Open [the hosted viewer](https://asilachev.github.io/better-md-viewer/), or clone this repo and open `index.html`. There is no build step and no server to run.
2. Click **Open folder**, or drag a folder onto the page.

Chrome, Edge and Arc read the folder directly, which is what makes live reload and reopening recent folders work. Safari and Firefox fall back to a file picker that reads a one-time copy; the browser calls it an upload, but the files never leave your machine.

## Keyboard

| Key | Action |
|---|---|
| `⌘O` / `Ctrl O` | Open a folder |
| `j` / `k` | Next / previous file |
| `/` | Search (`Esc` clears it) |
| `⌘B` / `Ctrl B` | Show or hide the sidebar |

## Screenshots

<p>
  <img src="docs/screenshots/paper.png" alt="The Paper theme showing a decision record" width="74%">
  <img src="docs/screenshots/mobile.png" alt="The phone layout" width="21.5%">
</p>

## How it works

Plain HTML, CSS and JavaScript, with no build step and nothing to install. [marked](https://marked.js.org) turns Markdown into HTML, [DOMPurify](https://github.com/cure53/DOMPurify) sanitizes it, and [highlight.js](https://highlightjs.org) colours code. Folders are read through the File System Access API where the browser has it.

| File | What's in it |
|---|---|
| `index.html` | Page structure and the Content-Security-Policy |
| `assets/app.js` | Reading folders, rendering, links, live reload, search |
| `assets/style.css` | The design system; each theme sets a small palette |

## Third-party code

- [marked](https://github.com/markedjs/marked): MIT
- [DOMPurify](https://github.com/cure53/DOMPurify): Apache-2.0 or MPL-2.0
- [highlight.js](https://github.com/highlightjs/highlight.js): BSD-3-Clause
- [IBM Plex](https://github.com/IBM/plex) fonts: SIL Open Font License 1.1 (`assets/fonts/LICENSE.txt`)

## License

MIT. See [LICENSE](LICENSE).
