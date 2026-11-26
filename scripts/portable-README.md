# c4mp (portable bundle)

This is a self-contained, pre-built copy of `c4mp` — no `git clone`, no `npm install`,
no build step. Everything the CLI needs (compiled `dist/`, the viewer assets, and
production `node_modules`) is already inside this folder.

c4mp turns a code base into a zoomable C4 architecture map (system → containers →
components → code) and tracks how it drifts over time.

## Quick start

```bash
node dist/bin/cli.js view --repo /path/to/your/code
```

That scans the code and writes the map page `C4MP/<project>/c4mpView.html` next to your
`.git` folder. Open it in any browser.

Optionally add this folder to your `PATH`, or symlink `dist/bin/cli.js` as `c4mp`
somewhere on your `PATH`, to run `c4mp ...` instead of `node dist/bin/cli.js ...`.

## Where c4mp puts things

c4mp finds the nearest folder above your code that holds `.git` (or `.c4mp`), called the
anchor. Your code folder may sit one level below the git root; the folders go at the anchor.

```
<anchor>/.c4mp/                     internal data (commit it, except what it ignores itself)
    config.json                     settings (optional)
    .gitignore                      ignores data/ and history/, which are rebuilt
    projects/<project>/
        data/                       scan output (outline, imports, components, snapshot)
        history/                    one snapshot per git commit
        plan/                       your .c4 plan files (architecture you write or edit)
<anchor>/C4MP/                      export, ignores itself
    <project>/c4mpView.html         the map page
```

- No `.git` anywhere above your code? Run `c4mp init --repo <path>` once; it creates
  `.c4mp/` at that folder.
- c4mp writes automatically only inside `.c4mp/` and `C4MP/`. Anything else (`--out`,
  `install-hooks`, `apply-layout`) only happens when you ask for it.
- Passing `--out` or `--store` explicitly always wins and works without an anchor.
- Earlier versions were called c4pm: a repo that still has a `.c4pm/` folder is read as before, and `c4pm` still runs as an alias.
- Old `out/` folders from earlier versions are left alone. Plans in `<repo>/c4/` are still found.

## The map page

Open `c4mpView.html`. Scroll to zoom, drag to pan, double-click a shape to dive in.

- **Auto level**: top-bar toggle that opens the right level of detail as you zoom.
- **Edit layout**: drag a shape to move it, drag a blueprint header to move the blueprint,
  drag its right/bottom edge or corner to resize. **Undo / Redo** (Ctrl/Cmd+Z, Shift+Ctrl/Cmd+Z).
  **Reset layout** returns to the automatic layout.
- **Export layout**: downloads `c4mp-layout.json`. A page cannot write into your repo, so
  save it into the plan with:

```bash
node dist/bin/cli.js apply-layout --repo /path/to/your/code --file c4mp-layout.json --dry-run
node dist/bin/cli.js apply-layout --repo /path/to/your/code --file c4mp-layout.json
```

  This adds a `layout` line to each element's metadata in the existing `.c4` files and
  changes nothing else. The next `view` draws the saved positions.

## Writing a plan

Plans are plain `.c4` text files in `.c4mp/projects/<project>/plan/`: elements, `a -> b`
relations, `link` lines pointing at code, and metadata (status, priority, sprint).

```bash
node dist/bin/cli.js generate-c4 --repo <code>      # first draft from the code
node dist/bin/cli.js check --repo <code>            # plan vs code: unplanned code, broken links
node dist/bin/cli.js plan --repo <code>             # show the plan structure
```

Edit the `.c4` files by hand (or with an AI tool), run `check`, then `view`.
Regenerating keeps the metadata you added. `--out` or the `architectureDir` setting
send the plan to another folder instead.

## Keeping it up to date

```bash
node dist/bin/cli.js install-hooks --repo <code>
```

After each `git commit` and `git merge`, a background job records a history snapshot and,
if `viewOnCommit` is true (the default), rewrites `c4mpView.html`. It never blocks git and
works even when `c4mp` is not on your `PATH`. Turn the page refresh off with
`{ "viewOnCommit": false }` in `.c4mp/config.json`. Remove the hooks with `uninstall-hooks`.

## Other commands

`status`, `snapshot`, `history`, `snapshots`, `diff`, `stubs`, `resolve-link`, `watch`,
`config show`. Run `node dist/bin/cli.js <command> --help` for each.

## Platform support

`c4mp` parses code with `tree-sitter`, which ships pre-built native binaries
(`.node` files) per platform instead of compiling from source. This bundle's
`node_modules` carries prebuilds for:

- **macOS, Apple Silicon** (`darwin-arm64`)
- **macOS, Intel** (`darwin-x64`)
- **Linux, x64** (`linux-x64`)
- **Windows, x64** (`win32-x64`)

**Not covered:** Linux ARM64 (e.g. AWS Graviton, Raspberry Pi 64-bit) and
Windows ARM64. On an unsupported platform, `tree-sitter`'s native module will
fail to load — rebuild from source on that machine instead of using this
portable bundle (see the main repo's `Project/README.md`, "Install from source").

This list was confirmed by inspecting `node_modules/tree-sitter*/prebuilds/`
after a real `npm install --omit=dev` into this bundle — it is not assumed.

## Node version

Requires Node 20+ (developed on Node 25).

## What's inside

```
dist/            compiled CLI + library code
viewer/          viewer HTML/JS/CSS assets
node_modules/    production dependencies only (npm install --omit=dev)
package.json
package-lock.json
README.md        this file
```
