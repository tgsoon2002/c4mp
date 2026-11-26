# Changelog

What changed in each c4mp (formerly c4pm) version: new features (Added), changed behaviour (Changed) and bug fixes (Fixed).
Newest version first. Dates are release dates (YYYY-MM-DD).

Versions 0.1.0 to 0.8.1 were written down afterwards (2026-11-10) from the roadmap, the git history and the board.
They list the main points of each version, not every change.

## 0.11.0 (2026-11-26)

### Added
- `c4mp migrate`: moves an old `.c4pm/` folder to `.c4mp/` (`git mv` in a git repo) and fixes the text in its
  `.gitignore`; dry run by default, `--yes` to apply; refuses when both folders exist (Phase 35).
- The page carries the C4MP brand: a favicon, a small tent-4 badge in the header, and the C, M, P loading spinner on
  the first load of a served page and while the live map rebuilds.

### Changed
- Licence: the engine is now Apache-2.0 (was FSL-1.1-MIT); `LICENSE` and `package.json` say so.
- The product is renamed from C4PM to C4MP ("camp"): "C4MP: your crew, your map, your plan, in one camp." (Phase 35)
  - Command `c4mp`. The `c4pm` command still works as an alias for 2 versions and prints a note that it was renamed.
  - Data folder `.c4mp/` for new repos. A repo with an old `.c4pm/` folder keeps working in it (reads and writes stay
    there, so one repo's data is never split) and prints a one-line note until you run `c4mp migrate`. If both
    folders exist, `.c4mp/` wins with a warning.
  - `c4mp install` installs `c4mp` plus a `c4pm` alias next to it; git hooks call `c4mp` and fall back to `c4pm`;
    `install-hooks` replaces an old c4pm hook block.
  - Config file `.c4mprc.json` (an old `.c4pmrc.json` is still read when the new one is missing); cache folders and the
    export file name (`c4mp-<repo>-<date>.html`) say c4mp; the viewer's saved settings move to `c4mp.*` keys (old
    `c4pm.*` values are still read).
  - Environment variables `C4MP_*`. The old `C4PM_*` names are still read.
  - Page file `c4mpView.html`, export folder `C4MP/`, layout download `c4mp-layout.json`.
  - MCP server name `c4mp`.
  - User folder `~/.c4mp`; `~/.c4pm` is used when `~/.c4mp` does not exist.
  - The guides are now `Document/C4MP-AI-Guide.md`, `C4MP-Board-Guide.md` and `C4MP-C4-Guide.md`.

## 0.10.1 (2026-11-25)

### Added
- `c4pm serve --link`: prints this repo's served-page link (the kept port and the remembered key) and whether a server
  answers on it: `running`, `running, busy (rebuilding?)`, `another server answers on this port` or `not running`.
  Starts nothing, makes no key. The page that opens without its key names the command (b939).
- `c4pm install` finds every other `c4pm` (each PATH folder, `/usr/local/bin`, `/opt/homebrew/bin`, `~/.local/bin`):
  for each it asks remove / back up (renamed `c4pm-<version>`) / leave, then offers to put its own folder first on
  PATH. A copy in a folder you cannot write gets the exact `sudo` command printed; a Homebrew copy gets
  `brew uninstall c4pm` printed and is never touched. `--old remove|backup|leave` for scripts (b938).

### Fixed
- `c4pm install` stopped at "Already installed: same version" without checking PATH, so an older `c4pm` earlier on
  PATH kept running; the same-version run now checks PATH and other copies too, and the last line names the `c4pm` the
  next shell will run (b938).

## 0.10.0 (2026-11-25)

### Added
- `c4pm serve`: the live map in your browser on 127.0.0.1 (a link with a key; the same port and key for a repo across
  restarts). The page reloads itself when the plan, board or code changes; a small light shows live or stopped
  (Phase 30).
- Editing in the served page: Edit layout + Save layout writes the layout line into the .c4 file; Kanban moves and the
  panel's Edit section save to the board; theme and viewer settings live in a personal settings file
  (`~/.c4pm/settings.json`; `C4PM_USER_DIR` moves it).
- Export in the settings: downloads a copy of the page and rewrites the page file; "Leave source code out" drops
  function source and the repo path. Same on the command line: `c4pm view --no-source`.
- Edit layout resizes a box from all four sides and all four corners; left and top keep the contents in place (b925).
- `--repo` is optional on every command: without it, c4pm uses the folder that holds `.c4pm`, found from the working
  folder (else the git root, else the working folder) (b936).
- Shared code with the `foundation` role (helpers, types) is drawn with its own tinted look (b908); a box subtitle
  ends in "+N more" when it is cut (b909, b912); board cards without an owner show an `unassigned` tag (b910).
- `c4pm sim upgrade`: rewrite the refs of existing s-items as uids (b899).
- `outline`, `find`, `show`, `plan link` / `resolve-link`, `check` and `c4pm edit` reach functions declared inside a
  function (TypeScript/JavaScript, Python) as `outer.inner` (b782, b787). The map and the call graph are unchanged.
- `outline` and `show` read `.json` (keys, arrays as `[i]`), `.md` (headings) and `.c4` files (plan elements and test
  blocks), named `a › b`, without the code scan; `show` also reads a plan file outside the repo (b683).
- `c4pm plan unlink <target> <path[#name]>` removes a link line through the plan write gate.
- An unknown key in `board add --from-file` and `plan set` says which key it most likely meant
  (`tag` -> `did you mean 'tags'?`).
- `board add --json` (single item) prints one JSON object; the new id is in `minted`.
- `board set --append-description` / `--prepend-description` (and `-file` forms) add text after / before the
  description, one blank line between; only one description option per call.
- `board set --add-tag/--remove-tag/--add-depends/--remove-depends/--remove-doc` (with the existing `--add-doc`):
  change one value of a list; removing a value that is not there is a note, exit 0.
- `board archive <board>`, `board unarchive <board>` and `board delete <board>` (an empty board only; refused while it
  holds items, which are listed). `board list --all` also lists archived boards, marked archived.

### Changed
- A repo can hold several program folders side by side (Phase 34): run c4pm from the folder that holds `.c4pm`. When
  that folder has no package.json name, the one project under `.c4pm/projects/` names the project (history and
  snapshot paths too) (b927, b934).
- Map (claim mode): a folder c4pm finds as a program (package.json, Cargo.toml) is drawn as the plan container that
  links it or claims its code, not as a second box; an empty found program no plan element stands for is not drawn
  (b933).
- Rebuilding a saved layout grows the top box to cover boxes resized past it, as the live page does (b937).
- Sims store uids only (b899): a sim command stores every ref as the uid of its plan element; a code `path#name` not
  in the plan yet is first added to it (done, owner, `#name` link) in the same write. `--owner` on sim step add/set,
  stage add and apply; MCP `sim_apply` takes `owner`.
- `board add|set|list` take `--tags` (the JSON key); `--tag` still works, hidden from help (both in one call are
  refused). `board list --tags a,b` lists items with every tag.
- `board set --doc` together with `--add-doc` in one call is now refused (as every replace flag with the add/remove
  flags of the same field).
- `board move` of a nested item moves it alone; its nest links become dependencies, the parent waiting for the child
  (was refused). A top-level item still moves with everything nested under it.

### Fixed
- `board add --board <archived>` added the item to an archived board; now refused with the unarchive hint (as
  `--from-file` and `board move`). Without `--board`, the add goes to the only OPEN board.

## 0.9.1 (2026-11-19)

### Added
- Releases carry `SHA256SUMS`: one sha256 line per release file (`scripts/sha256sums.sh`), checked with
  `shasum -a 256 -c SHA256SUMS` or `sha256sum -c SHA256SUMS` in the release folder.
- An Intel Mac binary (`c4pm-<version>-darwin-x64`), self-tested under Rosetta when the release is built.
- One-line install script `install.sh` (macOS, Linux: `curl -fsSL <release>/install.sh | sh`): downloads the binary
  for the platform, checks it against `SHA256SUMS` and runs its `c4pm install` (no sudo; env `C4PM_RELEASE_BASE`,
  `C4PM_VERSION`). Its Windows twin `scripts/install.ps1` ships with the first release that has a Windows binary.
- The map page shows a small "Made with C4PM" link (bottom-right, to the public releases page; hidden in `&bare`
  windows, present mode, and on a phone while the sim strip shows).
- The release zip and the release folder carry LICENSE (FSL-1.1-MIT).
- Map page: inside a box, arrows between files that import each other; a box with more than 20 shows only the arrows
  of the selected card.

### Changed
- The release zip carries no source maps.
- New one-line description: "Architecture-first project tool: zoomable C4 map, task boards, simulations".
- 0.9.1 ships macOS (Apple Silicon, Intel) and Linux x64 binaries; Windows comes in a later release.
- make-release.sh builds the targets named in C4PM_RELEASE_TARGETS (default: all four).

## 0.9.0 (2026-11-18)

### Added
- Simulations (s-items, Phase 25): flows (ordered steps across the arch, io and storage views, each with an optional
  call `from -> to` and reply) and journeys (stages), one file each in `.c4pm/projects/<repoId>/sim/s-<N>.json`.
  `c4pm sim list|show|add|set|remove|step|stage|apply` (dry run, `--yes` writes, one guarded write); MCP tools
  `sim_list`, `sim_show`, `sim_apply`, `sim_remove` (the first MCP write tools); `check` rules `sim-parse`,
  `sim-target-missing`, `sim-stage-missing`, `sim-step-unconnected` (accepts the step's call chain), `sim-step-unverified`.
- Map page, simulations: a Simulations section in the left panel (always shown, with its count, also "Simulations (0)"),
  the sim strip (steps as chips, play / pause / step, a **Depth** dropdown Context / Container / Component / Code that
  merges the steps to that level, default Code, merged steps play the sum of their seconds), lit boxes and arrows on the
  Architecture map with a whole-path fly, a sequence diagram (own window possible, `&depth=` in the link), present mode,
  and two-window present (map + IO window; the window that started present leads, Esc / Exit ends it everywhere).
  Lit components open their file and code boxes early so function names stay readable.
- Map page keeps the view across reloads: view, camera, selection, panel, tree, search, overlays, timeline, IO screen.
- C1 system context drawn like the demo: the system as one box with its people and outside systems around it, a second
  system as its own box, the technology line under outside systems, labels kept off region headers.
- Subregions can be moved and resized in edit mode; their place is saved with apply-layout.
- `c4pm plan apply-layout`: a layout file entry `null` removes that element's `layout` metadata (back to auto); `removeElementMetadata` in editMeta.
- Map page, edit mode: an **Auto arrange** button (next to Reset layout) puts the selected container (its boxes, frames
  and size; its top-left stays) or subregion (its frame and boxes) back to the automatic layout, as one undo step. The
  export then lists those boxes as `null` when the plan had a layout for them. The page data carries each box's auto
  rect (`autoLayout`) only when the plan has some saved layout (the layout then runs twice).
- `c4pm board rename <board> [--id <new-id>] [--name <text>]`: changes a board id and/or its display name; items keep their ids (dry run, `--yes` writes).
- THIRD-PARTY-NOTICES.txt (licences of the bundled packages and the Bun runtime) ships in the release zip and beside the binaries.
- `check` warns `folder-link-no-slash` when a link to a folder is written without the trailing `/`: such a link
  resolves but claims no files.
- `c4pm languages [--json]`: checks that each language grammar loads and parses (PASS/FAIL per language); `scripts/grammar-smoke.js` uses it.
- `c4pm deps <element> --files`: under each arrow, the import lines behind it (`file:line -> target file { names }`); MCP `deps` takes `files`.
- `c4pm deps <element> --compare <ref>`: per target box, the arrow weight at a stored snapshot and now, with new and gone arrows; the old files are mapped onto today's plan boxes. MCP `deps` takes `compare`.
- `c4pm plan upgrade [--yes] [--force] [--check] [--json]`: rewrites old plan words to the current plan standard (today
  the kind `layer` becomes `subregion`, also in a `specification` block). Dry run by default; safe to repeat.
- `check` rule `layer-upward` (warning): a code arrow from a component into a subregion above its own in the same
  container, by the plan's subregion order (first declared = top). A shared subregion is never its target.
- `check` rule `layer-skip` (warning, off by default): an entry point that skips the services, i.e. a code arrow from
  the top subregion that jumps over the second one (lower layers may jump); the message names a component in between that already calls the target. Turned on by the new config key `"layers": {"skip": true}`
  (env `C4PM_LAYERS_SKIP`).
- `c4pm plan path <from> <to> [--json]`: read-only, the layer-by-layer route from a component to a target (component
  or function): the layers between, the components there that already call the target, and a ready-made
  `c4pm plan add planned-fn <name> ...` command for each layer where one is missing.

### Changed
- `hooks` and `view` write the map page atomically (never a half-written c4pmView.html).
- `watch` sees changes in the `.c4pm` folder (plan, board, s-items); before, dot-folders were skipped.
- Binaries are built in a fixed folder, so every build embeds the same paths (no random temp path).
- A hook that runs long keeps its lock up to 6 hours (was 30 minutes); a lock whose process is gone is still taken over.
- `last-hook.txt` labels its memory field `maxRSS <n> MB`: on macOS it leaves out compressed and swapped pages.
- Plan standard 1.9 (was 1.8): the plan kind `layer` is now `subregion`. c4pm still reads `layer` as `subregion` (old plans
  stay valid, a file may mix both words) and writes `subregion` (`plan add layer` adds a subregion).
- The check rule `layer-misplaced` is now `subregion-misplaced`; an ack written with the old id still hides the finding.
- `deps --json` and the MCP `deps` tool give `"level": "subregion"` where they gave `"layer"`; the map's tree, panel and
  frame labels say Subregion.
- imports.json entries carry the `language` that read the file.
- `plan ids` and `plan apply-layout` edit each file in one pass (b721): on a 2000-element plan `plan ids --yes` takes
  0.5 s (was 23.7 s) and `apply-layout` 0.46 s (was 32.1 s); 5000 elements take 0.5 s and 0.7 s. The written bytes are
  the same. `editMetadataBatch` in editMeta plans every edit on the file read once, with the code the single edits use.

### Fixed
- `board add --from-file` accepts `--board-name` to name a new board (an existing board refuses it, as the single-item add does); one `pickAddBoard` serves both (b565).
- JS/TS functions assigned to a property (`res.cookie = function`, `exports.x = ...`, `Foo.prototype.x = ...`, arrow forms) are indexed: `res.cookie` is a method, `exports.x` a function, `Foo.prototype.x` is `Foo.x`; the disk parse cache format is 2 (b567).
- `plan add` never writes a keyword as an element id: a default id that is a plan keyword (`title`, `description`, ...) becomes `<id>_<kind>` (`title_field`) and the dry run says so; an explicit keyword `--id` is refused (b694).
- A lone word on its own line in a `.c4` file hid the next line silently (an element could vanish or get the wrong
  parent). It now gives a parse issue (`stray word '<id>'`) and the next line is read normally.
- The README's "Where data goes" and language list match what c4pm does today.
- Output piped into a reader that stops early (`c4pm guide ai | head`) no longer prints an `EPIPE` stack on stderr;
  c4pm stops quietly with exit code 0.
- `check` now reports `broken-function` for a done `type` link to a missing interface, enum, trait or protocol in
  Rust, C#, PHP, C++ and Swift files too (before: TypeScript only). Python lists no types, so it stays skipped there.
- `plan generate` keeps every existing block as written (comments, hand-written lines); it only adds elements the plan does not have. Links and technology of existing elements are no longer refreshed from the scan.
- `view` reads each source file once for its code snippets; memory no longer grows with (functions x file size), so a 20k-line file takes 206 MB instead of running out of memory (b585).
- Folder mode (no plan): `find`, `outline` and `show` no longer exit 1 with "Owner 'unassigned' is not a component of the snapshot" on a test file alone in its folder (`tests/test_x.py`); its owner shows as Unassigned (b705, regression of b509).
- `show` header prints the claim repo-relative (`(claim folder src/query/)`), not as the plan text relative to the plan file (`../../../../Project/src/query/`); `show --json` / MCP `show` add `how.claim.path` (repo-relative), `how.claim.link` keeps the raw plan text (b665).
- `find` (CLI and MCP) lists source hits before test-file hits of the same match tier (test files: config `tests.globs`); exact > prefix > substring still comes first, so library code is no longer cut by `--limit` behind tests (b580).
- `diff` sees edits that keep the line count (`return x + 1` -> `return x * 2`, `const f` -> `export const f`): snapshots store a content hash per file and function (`hash`, 16 hex chars of sha1, CRLF read as LF); a snapshot from before compares by line count as before; the disk parse cache format is 3 (b568, b582).
- C++ files with export / namespace macros (`FMT_EXPORT class`, `NLOHMANN_JSON_NAMESPACE_BEGIN`, `class JSON_API name`, `FMT_CONSTEXPR inline`) no longer parse as errors with no elements: a file with parse errors is read again with such macros blanked (line numbers kept), kept when it has fewer errors; a clean file is read as before (new `retryMacros` in `defineLanguage`); the disk parse cache format is 4 (b573).
- C++ nested classes and member template classes (`struct Outer { struct Inner {...}; template<class T> struct Tmpl {...}; }`) are indexed, under their plain name with their own methods (`Inner`, `Inner.innerMethod`), as in C# and Swift (b575).
- `check` and `diff` output piped into another program (`check --format json | jq`) is no longer cut at 8 KB: no command ends with `process.exit` after printing any more (b706).
- `check` / `diff`: an unknown `--format`, `--min-severity` or `--fail-on` value is now refused (exit 1, the allowed values listed); before, `--min-severity critcal` hid every finding so `--fail-on critical` exited 0 with a critical present (b707).
- `history --max abc|-1|2.5`, `history --since not-a-date` and `watch --debounce soon` are now refused (exit 1, the reason on stderr, nothing written); before, a bad `--max` snapshotted every commit. All numeric options share one parser (`numberOpt` / `wholeNumberOpt` in src/cliHelp.ts) (b708).
- `board list --status bogus` / `--kind bogus` is now refused (exit 1, the allowed values listed), with the same check and text as `board add` / `set` (`kindProblem` / `statusProblem` in src/board/fields.ts); before, it printed an empty list with exit 0 (b709).
- `diff --a/--b` with a file that is not a snapshot.json (another JSON, an array, not JSON) says `invalid: <file> is not a c4pm snapshot.json (<why>)`, exit 1, instead of a raw `Cannot read properties of undefined` (b710).
- `check --format json` with no plan prints `[]` on stdout (the "no .c4 files found" note on stderr) instead of the plain-text note, so scripts parsing the array keep working (b566).
- Top-level `c4pm --help` lists every language `--lang` reads (built from the language registry) instead of "TypeScript/JavaScript and Python"; the AI and C4 guides no longer say other languages are not parsed (b570).
- `--repo` to a missing folder, a typo or a file is now refused for every command (`error: invalid: --repo is not a directory: <path>`, or the JSON error object with `--json` / `--format json`; exit 1); before, read commands exited 0, `init` created the folder and `board add --yes` wrote a phantom project. A `--repo` that would start a new project while the anchor holds others prints a `note:` on stderr naming them (b564).
- A writer killed between its temp write and the rename no longer leaves `<file>.<pid>.<ms>.tmp` behind for good: the next atomic write of that file removes the temp files whose pid is no longer running (`removeStaleTemps` in src/util/fsAtomic.ts) (b725).
- `plan generate`, `plan apply-layout`, `plan ids`, `plan remove` (the write and its rollback) and `snapshot` (the four data JSON files) now write through `writeAtomic` (temp file + rename) instead of `fs.writeFileSync`, which empties the file first: a kill mid-write can no longer leave a cut or empty file (b724).
- A write that fails (read-only `.c4pm`, full disk, ...) says `cannot write <file>: permission denied` (or `read-only file system`, `disk full`, `folder does not exist`), naming the file instead of its `.tmp` temp file (`writeError` in src/util/fsAtomic.ts; the fs `code` is kept). `plan remove`, `plan ids`, `plan generate`, `plan apply-layout` and `snapshot` now print their failure as `error: invalid: <message>` through the same printer as the board and plan-edit commands (`emitThrown` -> `emitFailure` in src/cli/common.ts); before, the raw message had no `error:` prefix. Exit code stays 1 (b723).
- A query whose scan fails (`error: scan-failed: <message>`) keeps the original error as `cause`, so its stack is no longer lost; the printed error is unchanged. The `Maximum call stack size exceeded` it hid on `--repo <git root>` comes from the plan parser's nesting recursion (b720) on a 2000-level stress `.c4` file that the repo-wide plan fallback picks up (b728).
- A `history` run killed mid-run (SIGINT, SIGKILL) no longer leaves its `$TMPDIR/c4pm-export-*` folder (a full export of one commit) for 24 h: export folders are now named `c4pm-export-<pid>-XXXXXX`, and the next run removes those whose pid is not running (`removeStaleExports` in src/scan/historyRun.ts, with `isAlive` now exported from src/util/fileLock.ts and also used by `removeStaleTemps`). Old names keep the 24 h rule (b735).

### Docs
- Board guide: `git config diff.algorithm histogram` makes `board.json` diffs about 3 times smaller.

## 0.8.2 (2026-11-10)

### Added
- Fast queries: `find`, `show`, `outline`, `search`, `deps`, `calls` and `callers` keep their parse results in a cache
  in your user cache folder (macOS `~/Library/Caches/c4pm`, Linux `~/.cache/c4pm`, Windows `%LOCALAPPDATA%\c4pm\Cache`),
  so a query on an unchanged repo takes about 1.3 s instead of 9 s. Your repo is not touched. `C4PM_CACHE_DIR=<folder>`
  moves the cache, `C4PM_CACHE_DIR=off` turns it off. The MCP server starts warm from the same cache.
- `c4pm edit replace | insert | remove <file#name>`: edit a function, class, method or test case by its name.
  A dry run shows the diff; `--yes` writes. The edit is refused if it adds parse errors or if the file changed since
  it was read. The new text comes from `--from <file>` or stdin. A test case is named like `test/a.test.ts#suite > case`;
  removing a test case that a plan `test` block names removes that block too. See "Edit code and tests" in `c4pm guide ai`.
- `scripts/bench-query.sh`: times each query command, cold and warm.

### Changed
- A file written by c4pm keeps its mode (an executable script stays executable) and is written through a symlink
  instead of replacing it.

## 0.8.1 (2026-11-10)

### Fixed
- Person and External were drawn inside the system box, beside its containers. They now sit beside the system on a
  new top level, "C1 · System context". A plan without a person or external looks the same as before.
- Containers inside an `external` (for example a cloud provider's services) are drawn inside that external. Before,
  they were drawn as your own containers, or merged into one of yours with the same name.

### Changed
- A release is one folder per version: `Release/<version>/` holds the zip and the three binaries (macOS arm64,
  Linux x64, Windows x64).
- `paths.ts` counts as a Reader (layer L1) in `layers.json`, matching the plan.

## 0.8.0 (2026-11-09)

### Added
- Storage view (Phase 23): stores, records and fields from the plan and from the code (SQL migrations, Drizzle
  schemas), with their own panel, tree, search and check rules. `find` and `outline` return records.
- Wireframes in the IO view (Phase 20): screens drawn from wireframe HTML boxes; `c4pm plan wireframe <screen>`
  writes a starter wireframe; wireframe check rules.

### Changed
- Git hooks use far less memory and time (Phase 29): the parse cache is keyed by file content, hooks scan only the
  final state of a commit or merge, one hook runs at a time (file lock), and history writes are atomic. A hook used
  up to 6.5 GB before; it now stays under about 600 MB. Re-run `c4pm install-hooks` after installing this version.

### Fixed
- IO view readability: screen rows use the full width, arrows leave by the nearest edge, region names never cover a box.
- The view switch keeps its short labels (Arch / IO / Storage) at narrow widths.

## 0.7.1 (2026-11-06)

### Added
- Tests attached to c-items (Phase 26): each test case is a code element (kind `test`) for TypeScript/JavaScript,
  Python, Rust, C#, PHP, C++ and Swift, and sits on the lowest c-item it tests. `plan show`, `show` and the board
  list the tests to run and to write; the map shows a test count; `plan add test` and `plan remove --test`.
- `c4pm plan move` and `c4pm plan rename`: move or rename a plan element and every reference to it.
- Layers (Phase 28): a container can group its components in layers, drawn as frames; a shared layer is drawn as a
  side column.

### Changed
- The code was reorganised into layers (Foundation, Readers, Engines, Services, Entry) behind the same commands; no
  command changed.

## 0.7.0 (2026-11-02)

### Added
- CLI commands, API routes and MCP tools as IO view entries (`command`, `route`, `tool` kinds), drawn as cards.
- `--view arch|io|storage` on `plan show`, `plan tree`, `plan unplanned` and `plan generate`.
- SQL migrations reader for the storage kinds.

### Changed
- IO view cards grow to fit their rows; edge labels stay in the gap between cards.

## 0.6.0 (2026-11-01)

### Added
- IO view (front view): screens, their parts and the navigation between them, with its own panel and tree; open a
  view in its own window.
- Storage kinds in the plan: `store`, `record`, `field` (`plan add --meta`); Drizzle schema reader.
- Settings popup (theme, search start mode, help text); drag to resize the side panels.

### Changed
- Commands that edit plan items moved under `c4pm plan` (`plan add`, `plan set`, `plan link`, ...). The old names
  still work as hidden aliases.

### Fixed
- A saved region size now comes back exactly after reload.

## 0.5.3 (2026-10-25)

### Added
- `c4pm install` / `c4pm uninstall` for the single-file binary.
- Plan standard 1.0 with a conformance test corpus.

## 0.5.2 (2026-10-25)

### Added
- Single-file binaries (no Node needed), built with Bun.
- More languages: Rust, C#, PHP and C++ (functions, classes, methods), with their manifests and default ignored folders.
- `c4pm calls` and `c4pm callers` (function call graph, TypeScript/JavaScript) and `c4pm search` (text search),
  also as MCP tools. Names / Content switch in the map's search box.
- Person and external drawn on the architecture map, with their relations.
- Board Dashboard view (counts per status, kind, owner, tag; overdue and blocked items).

### Changed
- License: Functional Source License 1.1 with MIT future license (FSL-1.1-MIT).

### Fixed
- Parse failures are shown in `status` and `check` instead of passing silently.
- `type`, `interface` and `enum` are indexed; code inside IIFE wrappers is found.
- The stub detector no longer flags throw helpers and intentional no-ops.
- One shared ignore matcher, also used for `.c4` discovery, warns about patterns that match nothing.

## 0.5.1 (2026-10-24)

### Added
- Board items carry a description, documents, outcome and size; new kinds `decision` and `question`.
- Board edge tabs (Top and Board) like the side panels.

### Fixed
- The board view keeps its scroll position when it redraws.

## 0.5.0 (2026-10-23)

### Added
- Tools for AI agents (Phase 15): `find`, `show`, `outline`, `deps`, `check`, `status` and the `c4pm mcp` server.
- Boards (Phase 16): tasks, features, issues and bugs on boards, linked to plan elements; Kanban and list views.
- Plan-editing commands for AI agents (Phase 18): `tree`, `unplanned`, `add`, `set`, `link`, `relate`, and the
  board commands (`board add`, `set`, `move`, `show`, `tree`, ...), all dry run unless `--yes`.
- The AI guide (`c4pm guide ai`).

## 0.4.0 (2026-10-17)

### Added
- Every map box says where it comes from (scanned folder, plan file and lines, both, or made up).
- A stable `uid` for each system, container and component in the `.c4` files; `c4pm ids`, `element` and a dry-run `remove`.
- Files of languages without a parser (Java, Go, ...) appear at file level.
- The built-in guide (`c4pm guide`).

### Changed
- New tree layout: each map region is sized to fit its own children; bubbles have a standard size.
- `languages` and `ignore` in `.c4pm/config.json` are used by every scan.

## 0.3.0 (2026-10-12)

### Added
- Viewer panels: left tree with a Files tab, right detail panel (plan lines, owners, used by, depends on, declared
  relations), narrow-screen layout with collapsible panels.

### Changed
- `package.json` is the only place the version is set.

### Fixed
- Scanned source text can no longer break the page template.
- A system id that equals one of its children's ids no longer collides.

## 0.2.0 (2026-10-11)

First packaged version (portable zip). Phases 1 to 12:

### Added
- Scan a code base (TypeScript/JavaScript, Python) into snapshots, and compare two snapshots (drift).
- `.c4` plan files, checked against the code; claim-based ownership (a plan element owns the code its links point at).
- Zoomable map page (`c4pm view`): blueprint renderer, layout editing saved to the plan.
- `.c4pm/` (project data) and `C4PM/` (generated pages) folders; history per git commit; git hooks.

## 0.1.0 (2026-09-29)

Start of the project. Not released.
