# c4mp — guide for AI assistants

You are reading this because a human wants you to use **c4mp** on a code base. This file says what
c4mp is, which commands exist, and the loop to follow. Everything here was checked against
the c4mp release this guide ships with (`c4mp --version` prints it), including the code-query commands `find`, `search`, `show`, `outline`, `deps`, `calls`, `callers`, the MCP server
`c4mp mcp`, the plan-editing commands and the `board` commands (section 4). Anything not yet built is in section 9: do not pretend it exists.

Full .c4 format details: run `c4mp guide c4`.

Renamed from C4PM: the command `c4pm` still works as an alias for 2 versions (with a note), the env vars `C4PM_*` are still read, and a repo with an old `.c4pm/` folder keeps working until you run `c4mp migrate` (it moves the folder to `.c4mp/`).

## 1. What c4mp is

c4mp scans a code base and turns it into a **C4 architecture map**: a zoomable picture from the
whole system down to single functions. It also reads a human-editable **plan** (`.c4` text files)
and compares plan to code. It is a command line tool (`c4mp ...`) that writes a map page
(`c4mpView.html`) which the human opens in a browser.

Main goals, in order of importance:

1. **Make a code base visible.** Show its structure (what the parts are, what depends on what) so a
   person or an AI can understand a project without reading every file.
2. **Support planning.** Keep a plan next to the code: what each part is for, what is done, in
   progress, planned or abandoned, who owns it, which sprint. `check` tells you where plan and code
   disagree.
3. **Support discussion of change.** Record a snapshot of the architecture for each git commit and
   compare any two (`diff`): which parts grew, shrank, appeared, disappeared, or started depending on
   each other. Use it to talk about what a change did to the design.
4. **Help break down features.** Add planned parts to the plan (no code yet), give them a status,
   priority, owner and sprint, link them to the code that will implement them, and let `check` show
   progress.
5. **Give AI tools to find and read code.** `find`, `search`, `show`, `outline`, `deps`, `calls`, `callers` (command line) and the
   same tools over MCP (`c4mp mcp`). The call tools trace only what they can prove: see sections 4 and 9.

## 2. Terms

| Term | Meaning |
|---|---|
| **C4 levels** | C1 System, C2 Container (a deployable or top-level folder/service), C3 Component (a group of code with one purpose), C4 Code (file, function, class). |
| **Scan target / repo** | The folder you pass as `--repo`. Often a code folder one level below the git root. |
| **Anchor** | The nearest folder at or above the scan target that holds `.git` (or `.c4mp`). c4mp's folders go there. |
| **Project id** | Name used for the project's folders: `package.json` `name`, else the folder name, lower-cased with dashes (e.g. `ptms-personal-task-management-system`). `init` uses the folder name; the other commands use the `package.json` name (section 3). |
| **Snapshot** | A saved scan result: every file, function, import, container, component and dependency edge. |
| **History** | One snapshot per git commit, built by `history`. |
| **Plan** | The `.c4` files. Human or AI written architecture: names, descriptions, relations, links to code, statuses. |
| **Draft** | The first plan produced by `plan generate` from folder structure. Has no real meaning yet. |
| **Link** | A line in a `.c4` element pointing to code: a folder, a file, or a function (`file.ts#functionName`). A component *owns* the code its links point at. |
| **Claim** | A function-level link. A plan with function-level links is in "claim mode": components are defined by purpose, not folders. On a tie between components of the same rank, the one first in plan order wins; plan order is the element ids sorted alphabetically (`localeCompare`), not file order. |
| **Stub** | A function whose body is not implemented yet (empty, TODO, throws "not implemented"). Not stubs, on purpose: a `never` throw helper, a body that is only a `nop`/`no-op`/`intentionally` comment, an empty arrow used as a default, object value, argument or `handler`/`callback`/`mock` variable. Checked on Hono: 1 hit of 14 left (a real test double). |
| **Drift** | Change in the architecture between two snapshots. |
| **Layout** | Where the human dragged boxes on the map. Stored as a `layout` line in an element's metadata. |

## 3. Where c4mp puts files

```
<anchor>/.c4mp/                         internal; commit it
    config.json                         optional settings
    .gitignore                          ignores data/ and history/ (regenerable)
    projects/<project-id>/
        data/        outline.json, imports.json, components.json, snapshot.json   (regenerable)
                     (each imports.json entry: file, language = the language that read it, imports)
        history/     one snapshot per commit + manifest.json                      (regenerable)
        plan/        the .c4 files   <-- the plan; read and edit these
<anchor>/C4MP/                          export; ignores itself (git sees nothing in it)
    <project-id>/c4mpView.html          the map page
```

- c4mp writes **automatically only inside `.c4mp/` and `C4MP/`**. It changes your source code only when you run `c4mp edit ... --yes`, and then only the one file you name.
- No `.git` above the code folder: run `c4mp init --repo <path>` once. Other commands stop and say so.
- `--repo` must be an existing folder (a sub-folder of a repo is fine). A missing path, a typo or a file is refused
  before the command runs: `error: invalid: --repo is not a directory: <path>` on stderr (with `--json` or
  `--format json` the object `{"ok": false, "command": ..., "error": {"code": "invalid", ...}}` on stdout), exit 1,
  nothing created (`init` included).
- When `--repo` resolves to a project id that has no folder yet while the anchor already holds other projects (the
  usual sign of `--repo .` at the git root instead of the code folder), every command except `init` prints on stderr
  `note: no c4mp project '<id>' at <anchor> yet; it holds: <ids>. Check --repo ...`. It also shows after `init` until
  the first write when the `package.json` name differs from the folder name (next point).
- **Project id source.** `init` names the folder after the code folder (`resolvePaths` in `src/paths.ts`); the other
  commands use the `package.json` `name`, or the folder name when there is none (`src/history/meta.ts`).
  Checked on a test repo folder `repo` with `package.json` name `sample-shop`: `init` created
  `projects/repo`, `status` reported `sample-shop`, `plan generate` wrote `projects/sample-shop`. Use the
  path `plan generate` prints.
- An older layout (`out/<repoId>/...`, plan in `<repo>/c4/`) is no longer written; a plan in
  `<repo>/c4/` is still read.
- Explicit `--out` / `--store` flags always win and need no anchor.

## 4. Commands

Run as `c4mp <command> --repo <path-to-code-folder> [options]`. If `c4mp` is not on the PATH, use
`node <c4mp-folder>/dist/bin/cli.js ...`.

**IMPORTANT — languages.** The default is TypeScript/JavaScript only. Python needs
`--lang typescript,python`; Rust, C#, PHP, C++ (`.cpp .cc .cxx .hpp .hh .hxx .h`) and Swift need `rust` / `csharp` / `php` / `cpp` / `swift` in the list
(`--lang typescript,rust,csharp,php,cpp,swift`). Rust, PHP, C#, C++ and Swift read functions, classes, methods and imports. Swift lists class, struct and actor as classes, enum and protocol as types, and the members of an `extension` under the extended type's name. Swift reads `import` (also `@testable` and `@_spi(...)` imports; `import Foo.Bar` counts as `Foo`): a target of a `Package.swift` (its `path:` folder, or else `Sources/<name>`, for a test target `Tests/<name>`) resolves to every scanned file of that target (one arrow per file); other modules (`Foundation`, `XCTest`, package dependencies) are external. Rust reads `use`, `mod x;` and `extern crate`, resolved through the module tree and the `Cargo.toml` crate names (other crates are external; `use Token::*` of an enum or other type the file itself declares is that file). C++ reads `#include` (`"x.h"` relative to the file, then the `-I` dirs of `compile_commands.json` or else the repo root, `src/`, `include/` and the literal folders of `include_directories` / `target_include_directories` in the `CMakeLists.txt` files; `<system>` headers are external, and so is a quoted `"lib/x.h"` found nowhere in the repo when no repo folder is named `lib`). C# reads `using` (also `global using`, `using static` and aliases), resolved to every scanned file that declares that namespace (one arrow per file; `using static` and aliases drop the type name); `System.*`, `Microsoft.*` and the `PackageReference` packages of the `.csproj` files are external, other names are `unresolved` (`ImplicitUsings` is not read). PHP is described below. **Pass the same `--lang` to every command** (`plan generate`, `check`, `view`,
`snapshot`, `history`), or set `languages` in `.c4mp/config.json` and leave `--lang` out. A language
flag given to one command and not another makes parts of the project vanish from that step.
Verified (`status`, `snapshot`, `check`, `view`, `plan generate` with only `config.json` set): the config
value is used. `element` was not verified with the config alone.
PHP also reads imports: `use` names (including `use A\{B, C}`, `use function`) resolve through the nearest `composer.json` `autoload`/`autoload-dev` PSR-4 map to a repo file (a mapped name with no file, or any name when there is no `composer.json`, is `unresolved`, except a mapped name whose first two parts name a `require`/`require-dev` package, `Slim\Http\X` for `slim/http`, which is `external`; an unmapped name is `external`), and `require`/`include` with a literal path (also `__DIR__ . '/x.php'`) resolve to the repo file; dynamic paths are `unresolved`.
With `php`, `csharp` or `swift` selected, `composer.json`, `*.csproj` or `Package.swift` also mark a container (`CMakeLists.txt` and `Cargo.toml` always do).
A selected language also skips its build folders at any depth, added to your `ignore` (`rust` target, `php` vendor, `csharp` bin and obj, `cpp` cmake-build-*, `swift` .build, DerivedData and Pods); `snapshot` prints `default ignores for <language>: <dirs>`.
`--lang files` lists files of other languages (Java, Go, C, ... extensions in `fileOnlyExtensions`) as
**file-only boxes**: no functions, no imports, no arrows. It is off by default
(`FILE_ONLY_EXTENSIONS` in `src/constants.ts`, `fileOnlyExtensionsFor` in `src/pipeline.ts`).
**Test files** (config `tests`: `globs`, `ignoreReach`, `command`, `noTests`; scan option `--tests <patterns>`, env
`C4MP_TESTS`): see "Tests attached to c-items" at the end of this section.
**Layer rules** (config `"layers": {"skip": false}`, env `C4MP_LAYERS_SKIP` true/false/1/0): `check` always reports
`layer-upward` (a code arrow into a subregion above, in the same container); `"skip": true` also turns on `layer-skip`
(an entry point that skips the services: an arrow from the top subregion that jumps over the second one). The order is the plan's subregion order; see the check rules table.

### Set-up

| Command | What it does |
|---|---|
| `c4mp init --repo <p>` | Creates `.c4mp/` (config, gitignore, project folders). Safe to repeat; never overwrites. |
| `c4mp config show --repo <p>` | Prints the effective settings as JSON only (no source info). Verified in `configShow` in `bin/cli.ts`. |
| `c4mp guide [topic]` | Prints a built-in guide: no topic lists the topics, `c4mp guide c4` prints the `.c4` format guide, `c4mp guide ai` prints this guide, `c4mp guide board` prints the board guide (`src/guide.ts`). |
| `c4mp guide ai --skill [--format skill\|agents] [--out <path>] [--force]` | Makes a short agent file from the marked description and rules of section 10 of this guide (the only parts it copies) plus one pointer line: a Claude Code `SKILL.md` (default) or an `AGENTS.md` snippet (`--format agents`). Without `--out` it prints the text; with `--out` it writes the file (parent folders are created, any path is allowed) and refuses to overwrite a file whose content differs unless `--force` (`src/guideSkill.ts`). |
| `c4mp install-hooks --repo <p>` | After every `git commit` / `git merge`, records the final state in history and (if `viewOnCommit` is true, the default) rewrites `c4mpView.html`. Runs in the background, one hook at a time; never blocks git. Each run adds a line to `last-hook.txt`. Remove with `uninstall-hooks`. Details: "Hooks" under "Talk about change" below. |
| `c4mp languages [--json]` | **Check the language grammars.** Machine-level: no `--repo`, reads no project, writes nothing. Parses a small snippet per language and prints `PASS <language> (<package> <version>)` or `FAIL <language>: <reason>` (a package version that cannot be read prints `version unknown`, not a failure), then `ALL PASS`. One failing grammar never stops the others; exit 1 when any fails. `--json` prints `{node, platform, arch, abi, treeSitter, languages[{id, extensions}], grammars[{label, language, pkg, key, version, ok, error?}], ok}`. Works in the single-file binary. `scripts/grammar-smoke.js` of the release zip runs it. |
| `c4mp install [--dir <folder>] [--yes] [--no-path]` / `c4mp uninstall [--dir <folder>] [--yes]` | **Install the binary.** Only from the single-file binary (from source use `npm link`). Copies the running binary to `~/.local/bin/c4mp` (Windows: `%LOCALAPPDATA%\Programs\c4mp\c4mp.exe`), prints the plan as `would ...` lines and asks once `[y/N]`; without a terminal it refuses unless `--yes`. An existing different version is shown old and new before it is replaced; the same version changes nothing. If the folder is not on PATH it adds a marked block (`# >>> c4mp >>>` ... `# <<< c4mp <<<`) to `~/.zshrc` / `~/.bashrc` (Windows: the user PATH through PowerShell); `--no-path` skips that. Never uses sudo; for `/usr/local/bin` run `sudo cp` yourself. `uninstall` removes only that binary and that block (`src/selfInstall.ts`). |

### See the code base

| Command | What it does |
|---|---|
| `c4mp view --repo <p> [--open] [--from <ref>] [--out <file>] [--no-source]` | Scans, reads the plan, writes `C4MP/<id>/c4mpView.html` (or `--out`). `--from prev` marks what changed since the previous snapshot. `--no-source` leaves the function and method source and the absolute repo path out (the map, plan text and board stay): a copy to share. Prints the file path. |
| `c4mp serve --repo <p> [--port <n>] [--new-key] [--link] [--no-open] [--from <ref>]` | Serves the live map page on 127.0.0.1 until Ctrl+C: the page refreshes when code, plan, board or s-items change, and a light shows the state (green live, amber updating or new data, red stopped). The page saves layout (Save layout), kanban moves and b-item fields through the same checks as `plan apply-layout` and `board set`, and keeps the settings in ~/.c4mp/settings.json (the file wins; `C4MP_USER_DIR` moves it or turns it off). Export in the gear popup downloads a static page and rewrites `c4mpView.html` (Leave source code out = `view --no-source`). Same port and link key for a repo each run (`--port` sets the port, `--new-key` makes a fresh key). `--link` starts nothing: it prints the repo's link and `running` / `not running` (`no link yet: run c4mp serve once` when no key is remembered; not with `--new-key`). For humans; an agent uses the CLI. |
| `c4mp status --repo <p>` | One-screen summary: snapshot size, history, plan, config. Never writes (not verified). |
| `c4mp snapshot --repo <p> [--save]` | Scans and writes the four JSON files into `data/`. `--save` also stores it in history. |
| `c4mp stubs --repo <p>` | Lists functions that are not implemented yet (intentional no-ops and `never` throw helpers are skipped). |
| `c4mp plan resolve-link <path[#name]> --repo <p>` | Resolves a repo-relative path, optionally `#functionName`, to a code element (file, line range, `found`). Use it to test a link before writing it. Method links must be `#Class.method`: `#OrderService.create` gives `found: true`; bare `#create` and `#validate` give `found: false` (outline names are `Class.method`, `addNamed` in `src/languages/typescript/outline.ts`; exact match, `resolveLinks` in `src/plan/resolve.ts`). A function declared inside a function is `#outer.inner` (`viewer/tree.js#build.decorate`); the bare inner name gives `found: false`. |
| `c4mp watch --repo <p>` | Re-scans when files change (not verified). |

### Find and read code

Read-only: they scan live, write nothing in your repo (not even `.c4mp/`) and need no history or plan. They keep their parse results in a cache in your user cache folder (macOS `~/Library/Caches/c4mp`, Linux `~/.cache/c4mp`, Windows `%LOCALAPPDATA%\c4mp\Cache`), so a query on an unchanged repo takes about 1.3 s instead of 9 s; `C4MP_CACHE_DIR=<folder>` moves the cache, `C4MP_CACHE_DIR=off` turns it off. Paths in
input and output are relative to the `--repo` folder. Each takes `--lang`, `--ignore` and `--json`
(one JSON object on stdout). On an error they print `error: <code>: <message>` (+ one candidate per line) on
stderr, exit 1, and print nothing on stdout. Error codes: `scan-failed`, `not-found`,
`ambiguous`, `out-of-repo`, `invalid`. They need no `.c4mp`/`.git` anchor: a folder without one is scanned normally.

| Command | What it does |
|---|---|
| `c4mp find <query> --repo <p> [--kind function\|class\|method\|type\|test\|file\|record] [--limit n]` | Case-insensitive substring of an element name or a file path. `type` hits are interfaces, type aliases, enums, traits and protocols; `test` hits are test cases (named `describe › it`). Another kind is `invalid` and the message lists the kinds. `record` hits are tables a storage reader finds: only when the plan has a store (the code of the plan's stores, and what the readers find outside them), once per `file#name`, ranked by name like functions. `--limit` 1-100, default 20 (outside 1-100 is `invalid`). A query that starts with `-` goes after `--`, options first: `c4mp find --repo <p> -- -helper`. An empty query is `invalid`. |
| `c4mp search <text> --repo <p> [--regex] [--case] [--ext .html,.css] [--max n] [--context n]` | Content search: looks for an error message or a UI label in the text of the files, not in names (`find` does names). Literal and case-insensitive by default; `--regex` for a pattern, `--case` for case-sensitive. Reads the source of every language plus `.html .htm .css .scss .md .json .yaml .yml .txt .vue .svelte .phtml .tpl .twig .ejs .hbs` (`--ext` replaces that list). Skips binary files, files over 1 MB, dot folders, `node_modules`, `dist`, `build`, config `ignore` and `--ignore`. `--max` 1-1000, default 50; `--context` 0-10 lines around a hit, default 0. Each hit: `file`, `line`, `text` (trimmed, 200 chars), `function` (enclosing function from the outline, or null) and `owner` (component id, or null). Result: `{query, results, total, filesSearched, filesSkipped:{binary,tooBig}, truncated}`; text output groups hits by file. An empty query is `invalid`. A query that starts with `-` goes after `--`. |
| `c4mp show <target> --repo <p> [--max-lines n]` | Prints source. Target: `path`, `path#name`, `path#Class.method`, `path#L10`, `path#L10-L20` (same forms as plan links). `--max-lines` default and maximum 400 (0 is `invalid`; a larger value is cut to 400). Only scanned source files are shown, and `.json`, `.md` and `.c4` files (read without the scan): `path#a › b` names a JSON key, a heading or a plan element by its chain from the top (`layers.json#folders › src/edit`, `guide/ai.md#c4mp — guide for AI assistants › 2. Terms`; the chain starts with the file's `#` title; ASCII ` > ` works for ` › `; a repeated name among siblings is `name#2`); a bare inner name is `not-found` with the full names as candidates. A plan file outside the repo is shown by the path `plan show` prints (`../.c4mp/projects/<id>/plan/c4mp.c4#readers › structure_readers`); other paths outside the repo are `out-of-repo`. These files have no `how` and no `tests`. For a function, class or method on the map it then lists its tests (`tests:` block, as in `plan show`; `--json` adds `tests`). |
| `c4mp outline <file> --repo <p>` | Every function, class and method of one file; methods are nested under their class. Functions declared inside a function (TypeScript/JavaScript, Python) are listed under it as `outer.inner` (kind `function`); `find`, `show`, `plan link` and `c4mp edit` take that name. They are not on the map and own no calls (their calls count for the outer function). A file the scan does not walk that holds tables of a plan store (a `.sql` migration) lists its tables (kind `record`) with their columns (kind `field`) as `children`. A `.sql` file that creates no table of its own (only `ALTER TABLE`) is `not-found`. A `.json` file lists its keys (kind `key`; an array lists its object elements as `[i]`), a `.md` file its headings (kind `heading`; not in fenced code), a `.c4` file its plan elements (their plan kind) with their test blocks (kind `test`). Rows carry the full name `a › b`, the one `show` takes. `parseError` is true for broken JSON or a .c4 parse issue. Owner: the folder and file links of the plan, as for `.sql` files. |
| `c4mp deps <element> --repo <p>` | What a container or component uses and what uses it (the map's arrows and weights, rolled up for a container), plus declared plan relations. Element: uid, id, fqn, local id or title. `--files` adds under each arrow the import lines behind it (`file:line -> target file { names }`; the names are what the file binds from that import path, the same list for two lines of one path; TypeScript/JavaScript and Python have them, other languages none; an arrow made by a plan relation alone has no lines; `--json`: `usesFiles`, `usedByFiles`). `--compare <ref>` adds, per target box, the weight at a stored snapshot -> now (`+` new, `-` gone, `~` changed; unchanged ones are counted; `--json`: `compare` with every row and its status). Ref: `latest`, `prev`, `oldest`, an id, a commit prefix or `YYYY-MM-DD` (as `c4mp diff`); needs snapshots from `c4mp history` or `c4mp snapshot --save` (`--store` picks the store). Stored snapshots carry no plan, so the old files are mapped onto TODAY's plan boxes with today's claims: a box new since then shows `0 -> n`, a file deleted since counts for the box that claims its path today. |
| `c4mp calls <function> --repo <p>` | The functions and methods a function calls (TypeScript/JavaScript). Function: `path#name` (`path#Class.method`), or a name found in exactly one file (more than one is `ambiguous` with `path#name` candidates). Calls outside any named function (top level, callbacks there) belong to the pseudo function `path#<module>`; a call inside an anonymous callback belongs to the enclosing named function. |
| `c4mp callers <function> --repo <p>` | The functions that call a function (same name rules), each once at `file:line:column` of its first call site of the function, then `(also line:column, ...)` for its other call sites (`--json`: `line`, `column`, `sites`). |
| `c4mp mcp --repo <p>` | Serves these tools (and `plan_show`, `check`, `status`, `view_path`, `sim_list`, `sim_show`, `sim_apply`, `sim_remove`) to an AI client over MCP. Not for typing by hand: see "MCP server" below. |

Output shapes (`--json`), copied from runs on `test/fixtures/sample` (`--repo test/fixtures/sample`):

`find order --limit 2` (`total` counts all hits; `truncated` is true when `results` was cut; a hit
also has `stub` for an unimplemented function and `fileOnly: true` for a file-only file; a file hit has
no `startLine`/`endLine`/`lineCount`; `owner.kind` is `component`, `shared` or `unassigned`):

```
{"results":[{"path":"api/src/routes/orders.ts","name":"orderRoutes","kind":"function","startLine":4,"endLine":10,"lineCount":7,"owner":{"id":"api/routes","title":"Routes","kind":"component"}}, ...],"total":9,"truncated":true}
```

`show api/src/services/orderService.ts#OrderService.create` (`code` is an array of lines;
`targetKind` is `element`, `file` or `range`; `name`, `elementKind`, `how` and `stub` only for an
element; `how` is `{"mode":"folder-mode"}` or `{"mode":"claim", ...}` and says why `owner` was chosen;
`truncated` is true when `--max-lines` cut the code, and `totalLines` is the file length; an element on the map
also has `tests` (the object of "Tests attached to c-items" at the end of this section), with `toWrite` filled only from `test` blocks of a plan function
block that links it):

```
{"path":"api/src/services/orderService.ts","targetKind":"element","name":"OrderService.create","elementKind":"method","startLine":6,"endLine":12,"totalLines":17,"owner":{"id":"api/services","title":"Services","kind":"component"},"how":{"mode":"folder-mode"},"code":["  create(input: Partial<Order>): Order {", ...],"truncated":false,"tests":{"run":[],"toWrite":[],"touches":[],"counts":{"run":0,"toWrite":0,"touches":0}}}
```

`outline api/src/services/orderService.ts` (`parseError` is true when the file did not parse; `children`
are the methods of a class):

```
{"path":"api/src/services/orderService.ts","lineCount":17,"parseError":false,"elements":[{"name":"OrderService","kind":"class","startLine":3,"endLine":17,"lineCount":15,"owner":{"id":"api/services","title":"Services","kind":"component"},"children":[{"name":"OrderService.create","kind":"method","startLine":6,"endLine":12,"lineCount":7,"owner":{"id":"api/services","title":"Services","kind":"component"}}, ...]}]}
```

`calls src/queryCli.ts#runQuery` and `callers src/queryCli.ts#runQuery` (run on C4MP itself). `target` is the function asked
about. A `calls` entry has `name`, `file` and `line` of the called function's definition and `resolved` (always true: only
traced calls are listed, each function once). A `callers` entry is one calling function: `line` and `column` are its first
call of the target (1-based; the column counts UTF-16 code units and points at the called name, `save` in `repo.save()`),
`sites` lists every call of the target in that function. `unresolved` counts calls that could not be traced; for `callers`
it counts untraced calls of the same name elsewhere (possible callers). `external` (calls only) counts calls to packages and
JS or Python builtins. Treat a non-zero `unresolved` as "there may be more":

```
{"target":{"name":"runQuery","file":"src/queryCli.ts","line":40},"callers":[{"name":"registerPlanPathCommand","file":"src/queryCli.ts","line":118,"column":57,"resolved":true,"sites":[{"line":118,"column":57}]},{"name":"registerQueryCommands","file":"src/queryCli.ts","line":140,"column":7,"resolved":true,"sites":[{"line":140,"column":7},{"line":158,"column":7},{"line":185,"column":7},{"line":197,"column":5},{"line":216,"column":7},{"line":232,"column":40},{"line":243,"column":40}]}],"unresolved":0}
```

`deps api/services` (`uses` = "Depends on" in the map, `usedBy` = "Used by"; `weight` is the arrow weight of the map: the number of distinct importing-file to imported-file pairs between the two elements, plus 1 for each plan relation between them (summed over the members for a container); `declared` and `unresolvedDeclared` list plan relations: a relation with an
end the map does not have goes to `unresolvedDeclared`; `uid` appears when the plan element has one):

```
{"id":"api/services","title":"Services","level":"component","resolvedFrom":"id","uses":[{"id":"api/models","title":"Models","weight":1}],"usedBy":[{"id":"api/routes","title":"Routes","weight":1}],"declared":[],"unresolvedDeclared":[]}
```

A `declared` entry (from a repo with the plan relation `shop.api -> shop.web 'calls'`) is
`{"from":"api","to":"web","label":"calls","source":{"file":"architecture.c4","line":13}}`; an
`unresolvedDeclared` entry is `{"from":"shop.web","to":"shop.ghost","reason":"endpoint not found in the map"}`.

Method names are `Class.method`: `show path#create` does not find a method, `path#OrderService.create` does.

Tables (run on a copy of `test/fixtures/schema-sql/pg` with a plan store `shop.api.main`, `source 'db/migrations'`;
see "Storage kinds" in section 5). In claim mode the owner of a `.sql` file comes from the folder and file links of
the plan (the most specific one wins); in folder mode, or with no such link, it is `Unassigned`. `find class --kind record`:

```
db/migrations/0001_init.sql:14-20  record  classes  [Unassigned]
db/migrations/0001_init.sql:22-28  record  class_members  [Unassigned]
```

`--json` of the same: `{"results":[{"path":"db/migrations/0001_init.sql","name":"classes","kind":"record","startLine":14,"endLine":20,"lineCount":7,"owner":{"id":"unassigned","title":"Unassigned","kind":"unassigned"}}, ...],"total":2,"truncated":false}`.

`outline db/migrations/0001_init.sql` (the last table only):

```
db/migrations/0001_init.sql  34 lines
   ...
  30-34  record  invoices  [Unassigned]
    31  field  id  [Unassigned]
    32  field  user_id  [Unassigned]
    33  field  tags  [Unassigned]
```

`outline conf/app.json` and `show 'conf/app.json#scripts › test'` (run on a temp repo):

```
conf/app.json  11 lines
  2  key  name  [Unassigned]
  3-6  key  scripts  [Unassigned]
    4  key  scripts › build  [Unassigned]
    5  key  scripts › test  [Unassigned]
  7-10  key  files  [Unassigned]
    9  key  files › [1]  [Unassigned]
      9  key  files › [1] › from  [Unassigned]
      9  key  files › [1] › to  [Unassigned]
```

```
conf/app.json:5  key  scripts › test  [Unassigned]
  5      "test": "jest"
```

### Edit code and tests

`c4mp edit` changes ONE function, class, method or test case, named like a `show` target. Every edit is a dry run
that prints the diff until you add `--yes`. Each takes `--repo`, `--lang`, `--tests`, `--yes` and `--json`
(the same report shape as the plan edits). The new text comes from `--from <file>` (relative to `--repo`) or from
stdin (`--from` is needed when stdin is a terminal).

| Command | What it does |
|---|---|
| `c4mp edit replace <file#name> --repo <p> [--from <file>]` | Replaces exactly the lines `c4mp show <file#name>` prints. The doc comment and decorators above stay; put new ones in the new text only if you replace them on purpose (then `remove` first). A test case (`test/a.test.ts#suite › case`, or `suite > case`) is replaced as its whole `it(...)` statement. |
| `c4mp edit insert <file#name> --after\|--before --repo <p> [--from <file>]` | Inserts the new text after the element, or before it (above its doc comment and decorators). |
| `c4mp edit insert <file#Class> --into --repo <p> [--from <file>]` | Inserts at the end of a class body; with a `describe` name (`test/a.test.ts#suite`) at the end of that describe block. |
| `c4mp edit remove <file#name> --repo <p>` | Removes the element with the comment, decorator and bare `export` lines directly above it, and one of the blank lines around it. Removing a test case that a plan `test` block names (`case '<file#name>'`) removes that block too, through the plan write gate, in the same command (code first; if the plan write fails, the code is put back: `rolled-back`). |

Refusals (exit 1, nothing written): `not-found` (no such file or name), `ambiguous` (two elements of that name: the
candidates' lines are in the notes), `invalid` (no `#name`, a line range, a file type c4mp does not read, empty new
text, `--into` on a function), `parse-worse` (the edit adds parse errors to the file; a file that was already broken
can still be edited if the edit does not make it worse), `changed` (the file changed on disk between the read and the
write), `ambiguous` also when two plan `test` blocks name the removed case. A file with uncommitted git changes is
edited, with a note. Python: a `#` comment line above a function is not taken by `remove`.

Example (dry run, then the same with `--yes`):

```
$ c4mp edit replace 'src/textOps.ts#lineCount' --repo . --from new-lineCount.ts
edit replace src/textOps.ts#lineCount
--- a/src/textOps.ts
+++ b/src/textOps.ts
@@ -36,6 +36,7 @@
 function lineCount(code: string): number {
+  // counts lines, keeping line endings
   return splitLines(code, { keepEol: true }).length;
 }
dry run: nothing written. Add --yes to apply.
```

### MCP server

`c4mp mcp --repo <p> [--lang ...] [--ignore ...]` serves tools to an AI client over MCP (stdio;
JSON-RPC lines on stdin and stdout, logs on stderr; it stops when stdin closes). It is read-only EXCEPT `sim_apply` and
`sim_remove`: they write only `.c4mp/projects/<id>/sim/`, and only with `yes: true` (without it: a dry run, nothing written).
Do not start it by hand: put it in the client's MCP config. The `.mcp.json` snippet below uses the
bundle folder, because `c4mp` is usually not on the PATH:

```
{"mcpServers":{"c4mp":{"command":"node","args":["<bundle>/dist/bin/cli.js","mcp","--repo","<path-to-code-folder>"]}}}
```

If `c4mp` is on the PATH: `"command":"c4mp","args":["mcp","--repo","."]`. Add `"--lang","typescript,python"`
to `args` for Python. Tools (arguments in brackets are optional). A tool result is one text item holding
the JSON object printed by the command with `--json`; an error is the same item with `isError: true` and
text `{"error":{"code":"not-found","message":"...","candidates":[...]}}` (`candidates` only when there are some):

| Tool | Arguments | Result |
|---|---|---|
| `find` | `query`, [`kind`], [`limit`] | as `c4mp find --json` |
| `search` | `query`, [`regex`], [`case`], [`ext`], [`max`], [`context`] | as `c4mp search --json` (`ext` is an array like `[".html"]`) |
| `show` | `target`, [`max_lines`] | as `c4mp show --json` |
| `plan_show` | `target` | as `c4mp plan show <target> --json`: one plan element (uid, fqn, local id or name); for a store its `code` (`{reader, records}`, or `reason` / `error`), for a record the code record it matches (`record`, see "Storage kinds" in section 5); and, for a c-item of the map, its `tests` ("Tests attached to c-items" at the end of this section). No match is `not-found`, several are `ambiguous`, each with `uid  fqn  title` candidates. |
| `outline` | `path` | as `c4mp outline --json` |
| `deps` | `id`, `files`, `compare` | as `c4mp deps --json` (`files: true` = `--files`, `compare: "<ref>"` = `--compare <ref>`) |
| `calls` | `function` | as `c4mp calls --json` |
| `callers` | `function` | as `c4mp callers --json` |
| `view_path` | none | `{"path":".../C4MP/<id>/c4mpView.html","exists":false}`; `modified` (ISO time) is added when the file exists; `path` is null when there is no anchor. Does not write the page: run `c4mp view`. |
| `check` | [`min_severity`], [`sprint`] | the findings array of `c4mp check --format json` (section 7); `{"plan":false,"findings":[]}` when the repo has no `.c4` files |
| `status` | none | `{"snapshot":{"name","containers","components","files","codeElements","componentEdges","unresolvedImports"},"history":{"count","latest","anchored"},"plan":{"files","critical","warning","info"},"config":{"languages","ignore"}}`; `plan` is null with no `.c4` files |
| `sim_list` | [`kind`] | as `c4mp sim list --json`: `{sims, issues, notes}` ("Simulations (s-items)" below). An unknown `kind` is the CLI's refusal `{"ok":false,"command":"sim list","error":{"code":"invalid","message":"..."}}` with `isError: true`. |
| `sim_show` | `id` | as `c4mp sim show <id> --json`: one s-item with every ref resolved. An unknown id is the CLI's refusal `{"ok":false,"command":"sim show","error":{"code":"not-found",...}}`, a file that does not parse `invalid` with a `hint` (its problems), each with `isError: true`. |
| `sim_apply` | `spec`, [`yes`], [`owner`] | as `c4mp sim apply <file> [--owner NAME] [--yes] --json`, `spec` = the file's content (`{"sims": [ ... ]}`, "Simulations (s-items)" below): `{ok, command, dryRun, written, file, changes, minted?, error}`. Refs are stored as uids; a code `path#name` not in the plan yet is first added to it (a done function under the component that owns its file, owner from `owner` or that component) in the same write, so it writes `.c4mp/projects/<id>/sim/` and, then, the plan `.c4` files; dry run unless `yes` is `true` (default `false`). A refusal (a bad entry, a ref nothing names, the file changed meanwhile) is the same object with `ok: false`, `error: {code, message, reasons}` and `isError: true`; nothing is written. |
| `sim_remove` | `id`, [`yes`] | as `c4mp sim remove <id> [--yes] --json`. Writes only `.c4mp/projects/<id>/sim/`; dry run unless `yes` is `true`. Refused (`isError: true`, the journey stages in `reasons`) while a journey stage names the flow; an unknown id is `not-found`. |

The query tools reuse one scan and rescan when files changed, also the files only a storage reader reads (`.sql`);
`check` and `status` scan on every call; `sim_list`, `sim_show`, `sim_apply` and `sim_remove` read the s-item files and the plan on every call (no scan).
The two write tools keep every guard of the CLI (the same Simulation editing calls): only `sim/` files, a refusal when a file
changed since it was read, a new file never overwrites one.

### Talk about change

| Command | What it does |
|---|---|
| `c4mp history --repo <p> [--max 20] [--since <date>]` | Builds one snapshot per git commit into `history/`: the newest `--max` first-parent commits, skipping those already stored. The full timeline (the hooks record the final state only, see "Hooks" below). `--since` takes an ISO 8601 date (`2026-01-01`, a time may follow); a `--max` that is not a whole number of 1 or more, or a `--since` that is not such a date, is refused (exit 1, nothing written). Which commits `--since` keeps: not verified. |
| `c4mp snapshots --repo <p>` | Lists stored snapshots. |
| `c4mp diff --repo <p> [--from prev] [--to latest] [--format text\|markdown\|github\|json] [--min-severity info\|warning\|critical]` | Compares two snapshots (parts that grew, shrank, appeared, disappeared or gained dependencies, per `diff --help`). Also `--a <file> --b <file>` for two snapshot files. Output formats not verified. |

### Hooks

`c4mp install-hooks` adds a post-commit and a post-merge hook. Each starts `c4mp hook <kind>` in the background
(output to /dev/null), so git is never blocked and never fails because of c4mp. A hook records the **final state
only**; `c4mp history --repo . --max N` gives the full timeline.

- **post-commit** records the new commit (HEAD). No drift.
- **post-merge** (after `git merge`, or a `git pull` that merges or fast-forwards) records the merge result
  (HEAD), plus the state before the merge (ORIG_HEAD) when it is not stored yet. A merge or fast-forward of 5
  commits adds one entry, not 5.
- **Drift** = the state before the merge (ORIG_HEAD) vs the state after it (HEAD), found by commit, warning and
  critical changes only, written to `last-drift.txt` in the project data folder `.c4mp/projects/<id>/data/`
  (git-ignored) (`writeMergeDiff` in `src/scan/commit.ts`). It prints one line only when its stdout is a
  terminal (`runHook` in `src/hookRun.ts`), which the installed hooks never have.
- **One hook at a time** per project (`hook.lock` in the data folder). A second hook waits up to 10 minutes,
  then logs `skipped: busy`.
- **Its own commit**: the hook script reads HEAD (post-merge: also ORIG_HEAD) with `git rev-parse` before it
  starts c4mp in the background and passes them (`c4mp hook <kind> --head <sha> --orig-head <sha>`, hidden
  options; `hookBlock` in `src/hooks.ts`, `hookShas` in `src/hookRun.ts`). So a queued hook, or one whose node
  start is slow, records its own commit, not the one HEAD moved to since. Hooks installed before 0.8.0 read the
  shas only once node runs (they still work): tell the human to run `c4mp install-hooks --repo <repo>` again.
- **Finish order**: waiting hooks poll for the lock, so queued hooks may finish in any order, not the order git
  fired them (5 quick merges finished 1, 2, 4, 5, 3). Each run still records its own commit (`head`, `refs`) and
  its own drift (the `drift` field of its line); `last-drift.txt` is the drift of the run that finished last.
- **`last-hook.txt`** in `.c4mp/projects/<id>/data/`: one line per run, appended when the run finishes, so in
  finish order (the last line is not always the newest merge): to find a merge, match the `head <sha7>` in each
  line, not the line's position. The last 20 lines are kept.
  Fields, split by ` | `: start (ISO, UTC) · kind · `head <sha7>` · `refs <sha7> ...` (commits added, the
  before-state first; `none` = all stored already) · `drift <N> changes` or `drift skipped: not a merge` /
  `skipped: no ORIG_HEAD` / `skipped: nothing changed` / `error: <message>` · `page written` / `off`
  (`viewOnCommit` false) · `<s> s` (wait included) · `maxRSS <n> MB` (peak resident memory of the hook process; on macOS it leaves out compressed and swapped pages, so Activity Monitor can show more) · result `ok` / `skipped: busy` /
  `failed: <message>`. `-` marks a field the run did not reach. Real line:
  `2026-11-08T07:28:26.179Z | post-merge | head fc62717 | refs 0c8725b fc62717 | drift 0 changes | page written | 31.3 s | maxRSS 96 MB | ok`.
  When the human asks why the history or the page did not update, read this file first.
- **Batch merges**: turn the hooks off per merge, then record once:
  `git -c core.hooksPath=/dev/null merge <branch>` (repeat), then `c4mp history --repo . --max N`
  (N at least the number of merges). `history` writes no drift and no page: use `c4mp diff --from <sha> --to <sha>`
  and `c4mp view --repo .`.
- **`git pull --rebase` with local commits** fires no post-merge (there is no merge): no merge drift. Run
  `c4mp history --repo .` to record the new commits. A merge that stops on conflicts fires no post-merge either;
  the `git commit` that ends it fires post-commit (records the merge commit, no drift).

Full text with every field value: `c4mp guide c4`, section 15.

### Plan

| Command | What it does |
|---|---|
| `c4mp plan generate --repo <p> [--out <dir>] [--view storage [--container <target>] [--yes] [--force]]` | Writes a **draft** plan into `.c4mp/projects/<id>/plan/`. Run once. A re-run copies each existing element block (system, container, component, subregion, planned code) as you wrote it, comments and your own lines included, and keeps `link` and `technology` as written (they are not refreshed from the scan); only comments inside the braces are kept, not those above a block. New scanned components go into `<container>.c4`, new containers inside the system block. Components the scan no longer finds stay (marked `// kept by user: not found in the scan`); it keeps your relations too (a relation that the generator does not write itself goes to `architecture.c4`; one whose end is missing is written as a comment). It adds components for new code (`generateC4` in `src/c4/generate.ts`). Checked on a scratch copy of the sample fixture: after adding a comment and `technology` inside a component and a comment and `description` inside a container, two re-runs left every file byte-identical (`diff -r` clean). `--view storage` instead adds, from the code only, one `store` (with its `record`s and `field`s, metadata `reader` and `source`) for every storage reader hit that no store covers, under the container whose components own most of the hit's files; a hit no component owns is skipped with its files listed, run again with `--container <target>`. A dry run by default (it prints the stores, record counts and the diff), `--yes` writes, a re-run adds nothing, and an existing store is never changed. `--view io` says there is nothing to generate yet. |
| `c4mp plan show --repo <p> [--view arch\|io\|storage]` | Parses the plan and shows its structure (the same as `c4mp plan --repo <p>`). `--view` lists only the elements of that view (count line `N elements (storage view)`); with a target it does nothing. With a target it shows one element, see the next rows. |
| `c4mp check --repo <p> [--sprint S15] [--min-severity ...] [--fail-on critical\|warning\|none] [--format text\|github\|json]` | Validates the plan **and** compares it to the code. Writes nothing. `--sprint` late items: not verified. |
| `c4mp plan apply-layout --repo <p> --file <layout.json> [--dry-run] [--force]` | Writes a layout exported from the map page into the `.c4` files as `layout` metadata. Checked by the plan write gate (like `plan set`); a plan outside `.c4mp/` needs `--force`. |
| `c4mp plan ids --repo <p> [--yes] [--force]` | Gives each plan element (system, container, component, person, external, screen, ...) a `uid` (see section 5). Without `--yes` it only prints what would be added. `--force` also writes plan files outside `.c4mp/` and `C4MP/` (`buildIds` in `bin/cli.ts`). |
| `c4mp plan show <uid\|fqn\|id\|name> --repo <p> [--json] [--all] [--lang ...] [--ignore ...]` | Shows one plan element: kind, uid, fqn, parent, children, plan lines, links, status. Matches by uid, fqn, local id or name (`showPlanElement` in `src/query/planShow.ts`, also the MCP tool `plan_show`). The `origin` and `claims` lines (claim mode) are not verified with the config alone. It scans the code, so pass the same `--lang` as for `check`. For a store it adds an `as:` line (database, file, ...) and a `code:` line: the reader and its number of records, or why there is none. For a record the code has, a `code:` line (file, lines, `by link` or `by name`) and one row per code column, and `--json` adds `record` (see "Storage kinds" in section 5). For a container, subregion, component or planned function it then prints a `tests:` block (to run, to write, touching; `--all` lists every test, `--json` adds `tests`): see "Tests attached to c-items" at the end of this section. No match or several matches: the message and candidates on stdout, exit 1. |
| `c4mp plan remove <uid\|id\|name> --repo <p> [--yes] [--relations]` | Removes one element from the plan. **Dry run by default**: prints the lines that would go; `--yes` writes. Without `--relations` the relation lines that mention it stay, and `plan` still reported 0 issues after such a removal. With `--relations` those relation lines are removed (`buildRemove` in `bin/cli.ts`). `--force` (writes outside `.c4mp/`, `C4MP/`): not verified. `--test "<name>"` removes only that test block of the element, through the write gate ("Tests attached to c-items" at the end of this section). |

`--fail-on` makes the command exit 1 when a finding at that severity exists (use it in CI).
`check` and `diff` refuse a value of `--format`, `--min-severity` or `--fail-on` that is not in their list (exit 1,
nothing on stdout): a typo such as `--min-severity critcal` can no longer hide every finding.
`check --format json` prints the findings as one JSON array; with no plan it prints `[]` (the "no .c4 files" note goes to stderr).

### Draw and edit the plan

`plan tree` and `plan unplanned` only read (they write nothing, not even `.c4mp/`). `plan add`, `plan set`, `plan link` and
`plan relate` write one `.c4` file each; `plan move` and `plan rename` write every `.c4` file that names the element and
rename its wireframe files; `plan wireframe` writes one new wireframe file and no `.c4` file. Every target (`<target>`, `--parent`, `<from>`, `<to>`, `<element>`) is a uid, fqn,
id, local id or title; a target that matches nothing prints the 5 closest, one that matches several prints
`uid  fqn  title` lines (run `c4mp plan ids` when some have no uid).

| Command | What it does |
|---|---|
| `c4mp plan tree <c1\|c2\|c3> <target> --repo <p> [--view arch] [-r] [--depth n] [--format mermaid\|text\|json] [--direction TD\|LR] [--external] [--max-nodes n] [--fence] [--boards]` | Draws the plan below one element. The level must match the target (`c1` system, `c2` container, `c3` component); a wrong level is refused and names the right one. `c4mp plan tree <target> --view io\|storage` has no level: the one argument is a container or any element of that view (a store, a screen), and only that view's kinds are drawn. One level down by default, `-r` all levels, `--depth n` n levels (not both). Default `--format mermaid`: paste it in any Mermaid viewer (`--fence` wraps it in a ```` ```mermaid ```` block). `text` is the AI form, `json` the graph. Draws declared relations whose two ends are both shown; the others are counted in a `%%` comment, or drawn dashed with `--external`. More than `--max-nodes` (120) nodes is refused. `--boards` adds one dashed node per board item that links to a shown element (`b12 task in-progress`; archived boards left out; no board file is not an error, one `note:` line on stderr). |
| `c4mp plan unplanned --repo <p> [--lang ...] [--ignore ...] [--json] [--view storage]` | Lists code that no plan element owns (files in folder mode, functions in claim mode), grouped by `check` rule with a fix hint (`unplanned-code`, `unassigned-code`, `shared-auto`, `component-claim-conflict`, `split-file`, and `test-only-code`: unclaimed code only tests use). It is the same findings as `check`, filtered; it scans like `check`. Nothing to list prints `nothing unplanned`. `--view storage` lists instead `unplanned-record` (a record in the code that a store with a reader does not list; add it with `plan add record <name> --parent <store>`) and `unplanned-store` (records a reader finds that no store covers; fix with `plan generate --view storage`): the storage findings of `check` with these two rules, nothing else. A store c4mp cannot read is one `warning: store <fqn>: <error>` line after the groups (`problems` in `--json`). `--view io` has no code reader yet. |
| `c4mp plan add <kind> <name> --parent <target> --repo <p> [--title T] [--id ID] [--description D] [--tech T] [--meta key=value ...] [--link path[#name]] [--status S] [--owner O] [--sprint S15] [--priority P] [--signature S] [--purpose P] [--yes] [--force] [--check] [--json]` | Adds `container` (parent: a system), `subregion` (parent: a container; the old word `layer` still works and writes `subregion`), `component` (parent: a container or a subregion) or `planned-fn`, `planned-class`, `planned-type` (parent: a component), or a storage kind: `store` (parent: a container), `record` (parent: a store), `field` (parent: a record or a field). Or an IO view kind: `screen` (parent: a container), `region` (a screen), `control` (a screen or a region), `state` (a screen, a region or a control); or a CLI, API or MCP kind: `command` (a container or a command), `options` (a command), `flag` (a command or an options group), `arg` (a command), `route` (a container), `body` (a route), `param` (a route, a body or a tool), `tool` (a container); `--meta device=phone`, `--meta design=<URL or path>` and `--meta viewport=1440x900` on a screen (see "IO view kinds" below). Or `test` (a container, component, function or method): a one-line test block, not an element; only `--parent` and `--case <test id or helper file>` ("Tests attached to c-items" at the end of this section). The name becomes the title; the id is the name made safe (`Billing`, `my_app`), or `--id`. When that id is a plan keyword (`title`, `description`, `technology`, `link`, `metadata`, `specification`, `views`, `extend`; PS-3.16) it becomes `<id>_<kind>` (`title_field`) and the dry run says so; an explicit `--id` that is a keyword is refused. A duplicate id under the same parent is refused. A new container, subregion or component gets a `uid`. Written next to its siblings of the same view (architecture, IO or storage): into the file that defines the parent when that file holds one, else at the end of the first `extend <parent>` block (file path order) that holds one, else into the defining file; a top-level element into the `model` block of the file that holds the first system. `--status done` needs `--owner`. `--meta key=value` writes one metadata line and can be repeated; use it for the storage keys (see "Storage kinds" below). |
| `c4mp plan set <target> [key=value ...] [--unset <key> ...] --repo <p> [--yes] [--force] [--check] [--json]` | Changes fields of one element. Keys: `status`, `owner`, `sprint`, `priority`, `signature`, `purpose`, `shape`, `role`, `title`, `description`, `technology`. The value is quoted for you. `status` must be planned, in-progress, done or abandoned; `priority` high, medium or low; `sprint` like `S15`; `shape` person or robot (on a person); `role` must be `foundation` (on a component); `--unset <key>` removes a metadata key (repeatable; not uid or layout); an empty value, a line break, `uid` or `layout` is refused. `status=done` needs an owner (on the element or in the same call). Setting the value it already has prints `no change`. `title` does not change the id. |
| `c4mp plan link <target> <path[#name]> --repo <p> [--title T] [--yes] [--force] [--check] [--json]` | Adds a code link to an element (also planned code). The path is repo-relative; a folder ends with `/`. The code must exist and a `#name` must be found, else refused with the reason. The line is written relative to the `.c4` file. The same link twice is refused. |
| `c4mp plan unlink <target> <path[#name]> --repo <p> [--yes] [--force] [--check] [--json]` | Removes one code link line from an element, through the plan write gate (the same path as `plan link`: dry run by default, `--yes` writes, `--force` for plan files outside `.c4mp/` and `C4MP/`). The path is repo-relative as in `plan link`; a folder ends with `/`. Refused when the element has no such link (the message lists the links it has) or when hand edits left several identical lines. The element and its other lines stay; to delete a whole element use `plan remove`. Refused too when the removal leaves code unowned (the findings gate). |
| `c4mp plan relate <from> <to> --repo <p> [--label TEXT] [--yes] [--force] [--check] [--json]` | Adds `-> <to-fqn> 'label'` inside the body of `<from>`. Both ends must exist. The same element twice, or the same pair twice, is refused. |
| `c4mp plan move <element>... --parent <target> --repo <p> [--yes] [--force] [--check] [--json] [--no-mentions]` | Moves one or more elements (with everything inside them) to the end of a new parent, in the order given; see "Moving and renaming" below. The kind must fit the parent (`a region goes under a screen, but 'x' is a control`). An element moved into itself or its own child, an element named twice, two elements that would get the same fqn, or a new fqn that is taken is refused. The same parent is allowed: the block moves to the end of it (useful to reorder subregions). All or nothing: every problem is listed and nothing is written. |
| `c4mp plan rename <element> <new-id> --repo <p> [--yes] [--force] [--check] [--json] [--no-mentions]` | Gives one element a new id (letters, digits, `_` and `-`, starting with a letter or `_`; a keyword such as `description` is refused). The title stays (change it with `plan set <x> title=...`). Everything inside it, every reference and its wireframe files follow, as for `plan move`. |
| `c4mp plan path <from> <to> --repo <p> [--lang ...] [--ignore ...] [--json]` | Read-only. The layer-by-layer route from a component to a target (a component, or a function `path#name` or a name found in one file, whose owner is used), by the plan's subregion order (first declared = top). Prints both ends with their layer (`n/total`), each non-shared layer between with the components that already call the target (code arrows; for a function, the traced callers), the route (one component per layer, or `(planned-fn needed in <layer>)`), and per missing layer a ready-made `c4mp plan add planned-fn <name> --parent <component> --signature "<name>(...)"` (replace the literal `<name>`; c4mp never guesses a name). Up, same layer, a shared target, two containers or a component in no subregion print one line and exit 0. Element errors as `deps`. `planPath` in `src/query/planPath.ts`. |
| `c4mp plan upgrade --repo <p> [--yes] [--force] [--check] [--json]` | Rewrites old plan words to the current plan standard (today: the kind `layer` becomes `subregion`, also in a `specification` block). Only kind words change: ids, strings and comments stay. Dry run by default: prints the diff; `--yes` writes through the plan write gate (`--force` for plan files outside `.c4mp/` and `C4MP/`). Safe to repeat: a plan in the current words gives `nothing to upgrade`. Readers accept the old words anyway, so the upgrade is never required (`planUpgradeService` in `src/services/planUpgrade.ts`). |
| `c4mp plan wireframe <screen> --repo <p> [--yes] [--force] [--check] [--json]` | Writes a starter wireframe `io/<screen fqn>.html` in the plan folder for a person or an AI to arrange (see "IO view kinds" below): nested like the plan, one `<div data-c4>` per region (its class is the region's id), each run of its controls in a `<div class="row">` as `<button data-c4 class="btn">`, states not placed. Classes only, and it links `site.css`: every size goes into `io/site.css`, which the command does not create (one file per command; until it exists `check` warns `wireframe-bad-stylesheet`, and a `note:` says so). The file round-trips: no `wireframe-out-of-date` and no `wireframe-inline-style`. `io/` is made when missing. It writes no `.c4` file. Never overwrites: an existing file is refused, as are a target that is not a screen and a plan with no plan folder (the whole repo). |

Rules shared by `plan add`, `plan set`, `plan link`, `plan unlink`, `plan relate`, `plan move`, `plan rename` (verified by runs on a copy of `test/fixtures/phofast`; move and rename on a copy of `test/fixtures/io-shop`):

- **Dry run is the default.** Without `--yes` they print the diff and write nothing; the last line is
  `dry run: nothing written. Add --yes to apply.` With `--yes` they write, then read the plan back from
  disk and restore the old text if it differs from what was checked (`error: rolled-back: ...`).
- **Plan files outside `.c4mp/` and `C4MP/`** (like the fixture's `src/architecture.c4`) are refused, even in
  a dry run, unless `--force`: `error: outside-c4pm: outside .c4mp/ (use --force): src/architecture.c4`.
- **Gate.** The whole edited plan is checked before anything is written. The edit is refused
  (`new-findings`) when it adds a parse issue or a NEW warning or critical finding; old findings never
  block and `info` findings are only listed. The default check is fast (plan only). `plan link` always scans
  the code; `plan add` and `plan set` scan when the status is `done` or `in-progress` (they need to see the link),
  and `plan add` also with `--link`;
  `--check` makes any of them run the full `check` before and after (slower). More than 10 reasons print
  as 10 lines plus `... N more (use --json for all)`.
- **Output.** Text results go to stdout, errors to stderr as `error: <code>: <message>`. `--json` prints
  exactly one JSON object on stdout (a failure is `{"ok":false,...,"error":{"code","message",...}}`).
  Error codes: `no-plan`, `not-found`, `ambiguous`, `invalid`, `outside-c4pm`, `new-findings`,
  `rolled-back`. A repo with no `.c4` file: `no-plan` (`no .c4 files found; run c4mp plan generate to start a plan`).
- **Exit codes.** 0 = success, including a clean dry run and a read command with nothing to list.
  1 = anything else: a usage error, no match, an invalid value, a refusal by the gate, `outside-c4pm`,
  `rolled-back`, and a dry run that WOULD be refused.
- **Bytes.** Only the intended lines change; `layout` and existing `uid` lines are never touched (`plan move`
  carries them with the block). Values are
  quoted by the writer (`'` becomes `\'`, `\` becomes `\\`), so a title like `Loyalty & Rob's points` is
  written as `'Loyalty & Rob\'s points'` and `plan remove` can remove it again.
- **Never hand-edit .c4 files.** Every change has a command (`plan add`, `set`, `link`, `unlink`, `relate`, `move`, `rename`, `remove`); a hand edit skips the dry run, the parse check and the findings gate. If a command is missing, report it instead of editing the file.
- **Metadata you type by hand is not checked like this.** An unquoted value (`status done`) is dropped by
  the parser without any message (`c4.md` section 4); a quoted wrong one (`status 'finished'`) is an
  `invalid-metadata` warning from `check`. `plan set` refuses both mistakes, so use it for metadata.

**Moving and renaming.** Never move or rename an element by cutting and pasting its text: use `plan move` and
`plan rename`. They change the plan only (code never moves) and keep the element's `uid` and `layout` lines:

- **References follow.** Every relation end (`-> x`, `a -> b`) and every `extend <fqn>` that names the element or
  anything inside it is rewritten to the new fqn, in all `.c4` files. The gate finds each moved element at its new
  fqn (same kind, same uid), so a move is not an "element lost".
- **Wireframes follow.** A screen's wireframe `io/<old fqn>.html` is renamed to `io/<new fqn>.html` and its
  `data-c4` refs are rewritten. A part that leaves its screen is listed as a `note:`; its ref is not edited.
- **Mentions are listed, never edited.** Comments and strings in the plan, docs, the board files and other text
  files under the anchor that still name an old fqn are printed as `file:line  fqn` (20 lines in text, all with
  `--json`). `--no-mentions` skips this search (big repos).
- **Where the block lands.** At the end of the new parent's body: the last block of the parent in the element's own
  file (its declaration or an `extend <parent>` block), else the parent's declaration. The block is re-indented.
  Comment lines directly above it stay where they were (a `note:` names the line). A block with relative links
  cannot move to a `.c4` file in another folder (refused).

Real dry run on a copy of `test/fixtures/io-shop` with a `docs/screens.md` that names the screen,
`plan rename shop.web.home start --repo . --force`:

```
rename shop.web.home
--- a/c4/shop.c4
+++ b/c4/shop.c4
@@ -10,7 +10,7 @@
           email = control 'Email input'
           password = control 'Password input'
           submit = control 'Sign in button' {
-            -> shop.web.home 'Sign in'
+            -> shop.web.start 'Sign in'
             loading = state 'Loading'
           }
         }
@@ -19,7 +19,7 @@
         }
         err = state 'Error: wrong password'
       }
-      home = screen 'Home' {
+      start = screen 'Home' {
         header = region 'Header' {
           logo = control 'Logo'
           search = control 'Search box'
renamed shop.web.home -> shop.web.start  with 10 inside
renamed io/shop.web.home.html -> io/shop.web.start.html
references rewritten: 1 in 1 file (shop.c4 1)
mentions outside the plan (not edited):
  c4/io/shop.web.start.html:2  shop.web.home
  docs/screens.md:3  shop.web.home
dry run: nothing written. Add --yes to apply.
```

`plan move shop.web.home.hero --parent shop.web.products --repo . --force` ends with
`moved shop.web.home.hero -> shop.web.products.hero  with 1 inside` and
`note: wireframe c4/io/shop.web.home.html:14 ref 'hero' now names a part outside its screen: not edited`.
A refusal lists every problem (exit 1):

```
error: invalid: cannot move, nothing written:
  - cannot move shop.web.home.hero into itself or its descendant shop.web.home.hero.shop_now
  - a region goes under a screen, but 'shop.web.home.hero.shop_now' is a control
```

`--json` adds `moved` (every old -> new fqn with its uid), `wireframes`, `rewritten` and `mentions` (and, for a move,
`headline`) to the usual object.

**The folder to claim trap.** A plan starts in folder mode (a component owns whole files). The FIRST link
with `#functionName` switches the whole plan to claim mode, where every function needs an owner, so
`plan link` is refused while other functions are unclaimed and `plan unplanned` is where you see them. Real run
(`plan link Loyalty src/api/loyalty/points.ts#pointsFor`):

```
error: new-findings: the edit would make the plan worse, nothing written:
  - new critical unassigned-code src/web/admin/Dashboard.tsx#AdminDashboard: no component claims src/web/admin/Dashboard.tsx#AdminDashboard and nothing calls it
NEXT STEP: link the file or folder without #name to stay in folder mode, or claim every function of it (see: c4mp plan unplanned)
note: this function link switches the whole plan to claim mode (c4.md section 5)
```

Link the file (`c4mp plan link Loyalty src/api/loyalty/points.ts --yes`) to stay in folder mode.

Other real refusals (same run):

```
error: new-findings: the edit would make the plan worse, nothing written:
  - new critical missing-code phofast.api.Loyalty: Loyalty is in-progress but its code is missing: no link
error: invalid: status 'finished' is not allowed (use planned, in-progress, done, abandoned)
error: invalid: uid cannot be changed with set (uids are written by c4mp plan ids and c4mp plan add)
error: invalid: sprint '15' should look like S15
error: invalid: status 'done' needs an owner (add owner=<name>)
error: invalid: a container goes under a system, but 'api' is a container
error: invalid: phofast.api.Loyalty -> phofast.api.orders already exists ('reads order totals'); nothing added
error: invalid: 'api' is a container, use level c2: c4mp plan tree c2 api
error: invalid: function 'addPoints' not found in src/api/loyalty/points.ts
```

Outputs, copied from runs on a copy of `test/fixtures/phofast` (`--repo .` in the copy):

`plan add component Loyalty --parent api --description "Points for repeat customers" --status planned --owner jay --force`
(dry run; the diff is what `--yes` would write; the `uid` is new each run):

```
add phofast.api.Loyalty  (uid 064f7c2e-9a20-4153-b356-c45859ac0cf4)
--- a/src/architecture.c4
+++ b/src/architecture.c4
@@ -15,7 +15,16 @@
   phofast = system 'PhoFast' {
     description 'Order pho online, pick it up hot'
     web = container 'Web App' { technology 'React SPA' }
-    api = container 'API'     { technology 'Node / Express' }
+    api = container 'API'     { technology 'Node / Express' 
+      Loyalty = component 'Loyalty' {
+        description 'Points for repeat customers'
+        metadata {
+          uid '064f7c2e-9a20-4153-b356-c45859ac0cf4'
+          status 'planned'
+          owner 'jay'
+        }
+      }
+    }
     db  = container 'Database' { technology 'PostgreSQL' }
   }
 
dry run: nothing written. Add --yes to apply.
```

`plan link Loyalty src/api/loyalty/points.ts --force --yes` (the report also lists findings that appear and
disappear because of the edit):

```
link phofast.api.Loyalty  (uid d810f2a6-7b85-4763-a455-3a121e5eaac8)
--- a/src/architecture.c4
+++ b/src/architecture.c4
@@ -18,6 +18,7 @@
     api = container 'API'     { technology 'Node / Express' 
       Loyalty = component 'Loyalty' {
         description 'Points for repeat customers'
+        link ./api/loyalty/points.ts
         metadata {
           uid 'd810f2a6-7b85-4763-a455-3a121e5eaac8'
           status 'planned'
new findings:
  info planned-but-built phofast.api.Loyalty: Loyalty is planned but code exists: src/api/loyalty/points.ts; update the status?
fixed findings:
  critical unplanned-code src/api/loyalty/points.ts: no .c4 element claims this file
written: src/architecture.c4
```

`plan set Loyalty status=in-progress owner=jay sprint=S15 --force --yes`:

```
set phofast.api.Loyalty  (uid d810f2a6-7b85-4763-a455-3a121e5eaac8)
--- a/src/architecture.c4
+++ b/src/architecture.c4
@@ -21,8 +21,9 @@
         link ./api/loyalty/points.ts
         metadata {
           uid 'd810f2a6-7b85-4763-a455-3a121e5eaac8'
-          status 'planned'
+          status 'in-progress'
           owner 'jay'
+          sprint 'S15'
         }
       }
     }
fixed findings:
  info planned-but-built phofast.api.Loyalty: Loyalty is planned but code exists: src/api/loyalty/points.ts; update the status?
written: src/architecture.c4
```

`plan relate Loyalty orders --label "reads order totals" --force --yes`:

```
relate phofast.api.Loyalty  (uid d810f2a6-7b85-4763-a455-3a121e5eaac8)
--- a/src/architecture.c4
+++ b/src/architecture.c4
@@ -25,6 +25,7 @@
           owner 'jay'
           sprint 'S15'
         }
+        -> phofast.api.orders 'reads order totals'
       }
     }
     db  = container 'Database' { technology 'PostgreSQL' }
written: src/architecture.c4
```

`plan set Loyalty priority=high --force --json` (one object; a failure has `"ok": false` and `error`):

```
{
  "ok": true,
  "command": "set",
  "dryRun": true,
  "written": false,
  "target": {
    "uid": "d810f2a6-7b85-4763-a455-3a121e5eaac8",
    "fqn": "phofast.api.Loyalty",
    "kind": "component"
  },
  "files": [
    {
      "file": "src/architecture.c4",
      "diff": "--- a/src/architecture.c4\n+++ b/src/architecture.c4\n@@ -24,6 +24,7 @@\n           status 'in-progress'\n           owner 'jay'\n           sprint 'S15'\n+          priority 'high'\n         }\n         -> phofast.api.orders 'reads order totals'\n       }\n"
    }
  ],
  "findings": {
    "new": [],
    "fixed": []
  },
  "notes": [],
  "error": null
}
```

`plan tree c2 api -r` after those edits (Mermaid; node ids are `n_` + the fqn with every other character
replaced by `_`; the first `%%` line counts the relations that leave the view). The same text as a diagram
needs a Mermaid viewer; it was not opened in one for this guide, so its rendering is not verified:

```
flowchart TD
  %% 3 relation(s) leave this view
  subgraph n_phofast_api["API (container)"]
    n_phofast_api_Loyalty["Loyalty<br/>component · in-progress · jay"]:::inprogress
    n_phofast_api_auth["Auth Service<br/>component · done · kien"]:::done
    n_phofast_api_menu["Menu Service<br/>component · done · kien"]:::done
    n_phofast_api_notify["Notification Service<br/>component · planned · jay"]:::planned
    n_phofast_api_orders["Order Service<br/>component · in-progress · jay"]:::inprogress
    n_phofast_api_payments["Payment Service<br/>component · done · kien"]:::done
  end
  n_phofast_api_Loyalty -->|"reads order totals"| n_phofast_api_orders
  classDef planned fill:#eef2ff,stroke:#6366f1,color:#1e1b4b
  classDef inprogress fill:#fef9c3,stroke:#ca8a04,color:#422006
  classDef done fill:#dcfce7,stroke:#16a34a,color:#052e16
```

`plan tree c1 phofast` (default: one level down, so the `%%` line says deeper levels are hidden):

```
flowchart TD
  %% 3 relation(s) leave this view
  %% deeper levels are hidden (use -r or --depth)
  subgraph n_phofast["PhoFast (system)"]
    n_phofast_api["API<br/>container"]
    n_phofast_db["Database<br/>container"]
    n_phofast_web["Web App<br/>container"]
  end
  n_phofast_api -->|"reads / writes"| n_phofast_db
  n_phofast_web -->|"JSON over HTTPS"| n_phofast_api
```

`plan tree c2 api --format text`:

```
phofast.api  [container]
  phofast.api.Loyalty  [component]  in-progress jay
  phofast.api.auth  [component]  done kien
  phofast.api.menu  [component]  done kien
  phofast.api.notify  [component]  planned jay
  phofast.api.orders  [component]  in-progress jay
  phofast.api.payments  [component]  done kien
relations:
  phofast.api.Loyalty -> phofast.api.orders  reads order totals
```

`plan unplanned` (before the file was linked: two files; after: one):

```
unplanned-code (2): no component claims the file: c4mp plan link <component> <path>
  src/api/loyalty/points.ts  no .c4 element claims this file
  src/web/admin/Dashboard.tsx  no .c4 element claims this file
```

`plan unplanned --json` gives `{"groups":[{"rule","hint","items":[{"id","message"}]}]}`.

Known rough edge: a container written on one line (`api = container 'API' { technology '...' }`) gets
its closing brace moved to a new line and a trailing space after the `technology` line, as in the diff above.
The plan still parses the same; a line-based diff shows the container line changed.

### Boards (tasks, features, issues, bugs)

A board item (b-item, id `b1`, `b2`, ...) is NOT a plan element. The items live in one file,
`.c4mp/projects/<repoId>/board/board.json`: a list of boards, each holding its items. An item has a `kind`
(`task|feature|issue|bug|decision|question`), a `status` (`planned|in-progress|done|abandoned`; there is no `blocked`:
an item is blocked while something in its `dependsOn` is not done), an optional `owner`, `parent` (nesting,
same board), `dependsOn` (other items, any board), `links` (uids of plan elements), `tags`, `start`/`due` dates, a
Kanban `group`, and the optional fields `description` (plain text, up to 8000 characters), `docs` (documents:
`path:docs/x.md` repo-relative or `url:https://...`; use them to point at a write-up instead of putting long text in the
item), `outcome` (how it ended: commit hash, verified-by note; up to 2000 characters), `size` (`S|M|L|XL`), `sprint`
(`S15`) and `priority` (`high|medium|low`). Item keys this version does not know are kept and written back unchanged
(`check` shows a `board-parse` warning). `check` reports `board-doc-missing` (info) for a doc path that does not exist, and
`board-invalid-field` for a bad size, doc or over-long text. `check` reports `board-*` findings (dead link, overdue, cycle, ...). Never edit the JSON by hand: these
commands go through one guarded writer (dry run unless `--yes`, refuses when the file changed meanwhile, writes
atomically, re-reads the file and restores it on any problem, writes only inside `.c4mp/`). Full reference with
runs: `c4mp guide board`.

| Command | What it does |
|---|---|
| `c4mp board list --repo <p> [--board B] [--status S] [--kind K] [--tags T] [--owner O] [--overdue] [--due-before D] [--all] [--json]` | Lists items by board, nested. Read-only. Archived boards are hidden unless `--all` (marked `(archived)`, `"archived": true` in JSON) or `--board` names one. `--tags a,b` lists items with every listed tag. An unknown `--status` or `--kind` (or `--board`, or a `--due-before` that is not a date) exits 1 with `error: ...` on stderr. |
| `c4mp board show <id> --repo <p> [--with-tests] [--json]` | One item: board, parent, children, `depends on`, `required by`, and every linked plan element (kind, fqn, title, status, owner; a uid no plan element has is `missing`). Read-only. `--with-tests` (scans the code) adds the tests of the linked c-items and those below them: to run (with run commands), to write (planned `test` blocks no case matches) and a count of touching ones (`--json` lists them); use it when handing a task to an agent. |
| `c4mp board tree [<id>] --repo <p> [--board B] [-r] [--format mermaid\|text\|json] [--direction TD\|LR] [--max-nodes n] [--fence]` | Nesting and dependencies as Mermaid, text or JSON. With an id: that item and one level below (`-r` all); without: the top-level items of a board (`--board` when 2+ boards are open). An arrow runs from the item waited for to the item that waits. Read-only. |
| `c4mp board for <target> --repo <p> [--json]` | Every item (any board) that links to a plan element (uid, fqn, id or name; it needs a uid, else `run c4mp plan ids`). Read-only. |
| `c4mp board add --repo <p> --title T --kind K [--board B] [--status S] [--owner O] [--parent ID] [--depends IDS] [--tags TAGS] [--link UIDS] [--start D] [--due D] [--group G] [--description TEXT] [--description-file PATH] [--doc SPEC]... [--outcome TEXT] [--size S\|M\|L\|XL] [--sprint S15] [--priority high\|medium\|low] [--yes] [--json]` | Adds one item; mints `b<max+1>` over the whole file; sets `created`. `--json` prints one object; the new id is `minted[0].id`. `--doc` is `path:docs/x.md` or `url:https://...`, optional `Label=` in front; repeat it or give a comma list. A doc path that does not exist yet is only a note. |
| `c4mp board add --repo <p> --from-file items.json [--board B [--board-name N]] [--yes] [--json]` | Creates many items in one write. JSON: `{"items":[{"ref":"f","title":"..","kind":"feature","parentRef":"f","dependsOnRefs":["x"],"parent":"b3","dependsOn":["b2"],"links":[uid],"status":..,"owner":..,"tags":[..],"start":..,"due":..,"group":..,"description":"..","docs":["path:docs/x.md",{"url":"https://.."}],"outcome":"..","size":"M","sprint":"S15","priority":"high"}]}`. `ref` is a local key; `parentRef`/`dependsOnRefs` name it (forward references allowed); `parent`/`dependsOn` name items that already exist. One bad item refuses the whole file. Without `--yes` it prints every item with its minted id. `--board-name` names a NEW board only (refused when the board exists). Do not combine with `--title` etc. |
| `c4mp board set <id> --repo <p> [--status S] [--title T] [--owner O\|none] [--kind K] [--parent ID\|none] [--depends IDS\|none] [--tags TAGS\|none] [--start D\|none] [--due D\|none] [--group NAME\|none] [--description TEXT\|none] [--description-file PATH] [--append-description TEXT] [--prepend-description TEXT] [--append-description-file PATH] [--prepend-description-file PATH] [--doc SPEC\|none]... [--add-doc SPEC]... [--remove-doc SPEC]... [--add-tag TAGS]... [--remove-tag TAGS]... [--add-depends IDS]... [--remove-depends IDS]... [--outcome TEXT\|none] [--size S\|M\|L\|XL\|none] [--sprint S15\|none] [--priority high\|medium\|low\|none] [--yes]` | Changes the named fields only; sets `updated` (and `closed` when the status becomes `done`). `--group` takes a group name or id. `--doc` REPLACES the document list (`none` clears it); `--add-doc` appends to it (the same path or url is kept once). `--add-tag` / `--add-depends` / `--add-doc` add values (kept once), `--remove-tag` / `--remove-depends` / `--remove-doc` remove them (a value not there is a note line, exit 0); not together with `--tags` / `--depends` / `--doc` of the same field. `--append-description` / `--prepend-description` (or their `-file` forms) add text after / before the description with one blank line between (no old text = the new text); only one description option per call. `c4mp board show <id>` prints docs, outcome and the wrapped description. |
| `c4mp board link <id> <target> --repo <p> [--yes]` / `c4mp board unlink <id> <target> --repo <p> [--yes]` | Adds or removes the link to a plan element (stores its uid). Never edits the plan. |
| `c4mp board remove <id> --repo <p> [--yes] [--json]` | Removes one item. Refused while another item depends on it or is nested under it (they are listed); there is no cascade. |
| `c4mp board move <id> --board B --repo <p> [--yes] [--json]` | Moves an item to another board; ids stay; sets `updated`. A top-level item takes everything nested under it; a nested item moves alone and each nest link that would cross boards (to its parent, to its children) becomes a dependency, the parent waiting for the child (the dry run lists each one; a dependency cycle refuses). Refused for a missing or archived board, and when an item keeps a group the target board lacks (`board set <id> --group none` first). |
| `c4mp board rename <board> [--id <new-id>] [--name <text>] --repo <p> [--yes] [--json]` | Renames a board: changes its id and/or its display name. Items keep their ids (they live inside the board). An archived board can be renamed too. Refused for a missing board, when neither `--id` nor `--name` is given, for an invalid id or one another board already uses, for an empty name, and when nothing would change. |
| `c4mp board archive <board> --repo <p> [--yes] [--json]` / `c4mp board unarchive <board> --repo <p> [--yes] [--json]` | Archives a board (hidden from `board list` and the page; `board add` and `board move` refuse it with the unarchive hint; its items stay) or brings it back. Only the `archived` flag changes; already in that state = `nothing to change`, exit 0. |
| `c4mp board delete <board> --repo <p> [--yes] [--json]` | Deletes an EMPTY board (archived or not). Refused while it holds items (each is listed): move or remove them first, or archive the board instead. |
| `c4mp board group add <name> --repo <p> [--board B] [--yes] [--json]` | Adds a custom Kanban group (id made from the name). A board with no groups first gets the three default ones written. Refused for a duplicate name or id, or a name with a comma. |
| `c4mp board group remove <name> --repo <p> [--board B] [--yes] [--json]` | Removes a custom group (name or id). Refused while an item is in it and for a group that follows a status. |
| `c4mp board group order "A,B,C" --repo <p> [--board B] [--yes] [--json]` | Sets the group order; the list must name every group once. Only the order changes. |

Rules: `--board` may be left out when only one board is open. `--tag` is still accepted as the old spelling of `--tags` (not both in one call). Dry run is the default and the last line is
`dry run: nothing written. Add --yes to apply.`; a write ends with `written: <file>`. Errors go to stderr as
`error: <code>: <message>` followed by at most 10 reason lines (`... N more (use --json for all)`); `--json`
(`show`, `plan tree --format json`, `for`, `add`, `remove`, `move`, `rename`, `archive`, `unarchive`, `delete`, `group`, `add --from-file`) prints exactly one object on
stdout, with the full `reasons` list on failure. Exit 0 = success (also a clean dry run and "no board file":
`no board file (c4mp board add --repo R --title T --kind task --yes to start one)`), 1 = anything else. A change
that would add a new `board-*` warning (dependency or nesting cycle, unknown parent, unknown group, ...) is refused;
warnings the file already had never block. `plan tree <level> <target> --boards` also draws the board items (see the
`plan tree` row above).

**Typical sequence for an agent** (all lines run for real, section "Real run" of `c4mp guide board`):
break a feature down with one `board add --from-file`, see it with `board tree <id> -r --format text`, find the work
touching a component with `board for <component>`, then `board set <id> --status in-progress --yes` while you work and
`board set <id> --status done --yes` at the end. `c4mp check` afterwards shows no new `board-*` finding.

### Simulations (s-items)

An s-item (id `s-1`, `s-2`, ...) stores HOW the system runs for one scenario. It is the third item family, next to
c-items (the plan) and b-items (the board), and it is NOT a plan element. A **flow** is an ordered list of steps;
each step has one or more targets (a c-item in the io, arch or storage view, or a code function `path#name`), a view
(`arch|io|storage`), and optionally a state, a caption, sample rows of records after the step, a duration and its
arrow (`call`: from, to, label, reply). A **journey** is a list of stages for one person: a flow (`--flow s-1`), an
event outside the system (`--outside`, with `--from` and `--channel`), or one inline step (`--target`). One file per
s-item: `.c4mp/projects/<repoId>/sim/s-<N>.json`, committed. Refs are stored as uids (b899): a c-item or planned
function by its uid (one is added when it has none); a code `path#name` the plan does not hold yet is first added to
it as a done function under the component that owns its file (`--owner`, else that component's owner). Older files
may hold an fqn or a `path#name`: they still read, and `c4mp sim upgrade` rewrites them; `person` is free text (the page links it when it names a plan
person). Nothing writes s-items but these commands (or a person by hand): a scan never does. `c4mp check` reports
`sim-*` findings (section 7).

**When to write one:** when someone asks how a feature runs end to end, or before you build a feature that crosses
screens, services and data: write the flow first (planned functions are fine targets), then `c4mp check` tells you
which consecutive steps the plan and the code do not connect yet.

| Command | What it does |
|---|---|
| `c4mp sim list --repo <p> [--kind flow\|journey] [--json]` | Lists the s-items (id, kind, title, steps or stages, person) and the files that do not parse. Read-only. |
| `c4mp sim show <id> --repo <p> [--json]` | One s-item with every target, call end and rows record resolved (kind, fqn, title; a code target shows as `code`, a ref nothing names as `missing`). Read-only. |
| `c4mp sim add --repo <p> --kind flow\|journey --title T [--description TEXT] [--person TEXT] [--yes] [--json]` | Starts an s-item with the next id `s-<max+1>` (printed), no steps or stages yet. |
| `c4mp sim set <id> --repo <p> [--title T] [--description TEXT\|none] [--person TEXT\|none] [--yes] [--json]` | Changes the title, description or person. |
| `c4mp sim remove <id> --repo <p> [--yes] [--json]` | Removes the file. Refused while a journey stage names the flow (the stages are listed). |
| `c4mp sim step add <id> --repo <p> --target REF [--target REF]... [--view V] [--call-from REF] [--call-to REF] [--call-label TEXT] [--reply] [--state TEXT] [--caption TEXT] [--duration SEC] [--rows-file PATH] [--at N] [--owner NAME] [--yes] [--json]` | Adds a step to a flow (last, or at `--at`). A target is a uid, fqn, id or name of a c-item, or `path#name`. `--view` defaults to the view of the first target. `--rows-file` is a JSON file `{"<record>": [rows]}`. |
| `c4mp sim step set <id> <n> --repo <p> [the step add flags but at] [--reply none] [--owner NAME] [--yes] [--json]` | Changes step `n`: only the named fields; `none` clears an optional field. |
| `c4mp sim step remove <id> <n> --repo <p> [--yes] [--json]` / `c4mp sim step move <id> <n> --to M --repo <p> [--yes] [--json]` | Removes or moves step `n`. |
| `c4mp sim stage add <id> --repo <p> (--flow S-ID \| --outside TEXT \| --target REF...) [--name TEXT] [--goal TEXT] [--from TEXT] [--channel TEXT] [--view V] [--state TEXT] [--caption TEXT] [--duration SEC] [--call-from REF] [--call-to REF] [--call-label TEXT] [--reply] [--at N] [--owner NAME] [--yes] [--json]` | Adds a stage to a journey: exactly one of `--flow`, `--outside` or `--target`. `--from` / `--channel` belong to an outside stage. |
| `c4mp sim stage remove <id> <n> --repo <p> [--yes] [--json]` | Removes stage `n`. |
| `c4mp sim apply <file.json> --repo <p> [--owner NAME] [--yes] [--json]` | Many s-items in ONE write: `{"sims": [ ... ]}`, each entry an s-item as in the file; no `id` = new (next ids in file order, a local `ref` that a journey stage names with `flowRef`), an `id` replaces that s-item whole. One bad entry or ref refuses the whole file. |
| `c4mp sim upgrade --repo <p> [--owner NAME] [--yes] [--json]` | Stores every ref of every s-item as a uid; code not in the plan yet is added to it. One write of the plan and the s-items. A ref that names nothing refuses the upgrade. |

Every write is a dry run unless `--yes`, refuses when the file changed meanwhile, writes only inside `.c4mp/`, and
prints the change (the last line `dry run: nothing written. Add --yes to apply.` or `written: <file>`). `--json`
prints one object `{ok, command, dryRun, written, file, changes, minted?, error}`. Errors go to stderr as
`error: <code>: <message>` with the reasons below it; exit 0 = success, 1 = anything else.

**In the page** (`c4mp view`; a page without s-items shows none of this):

- **The list.** The section **Simulations (N)** at the bottom of the left column lists the s-items (closed at first;
  the page remembers open or closed). The search finds an s-item by id, title or kind. A click on a row selects it,
  a second click unselects it; its ▶ starts present mode at step 1.
- **The path in every view.** A selected s-item lights its path in each view. Architecture: a ring and the step
  numbers on each box, one arrow per step call (dashed with `?` while the code has no such call). IO: a ring and a
  number on each screen or part, arcs between screens; when the path has an IO step, the other screens fade. Storage:
  a ring and the step numbers on each record. The left tree marks the lit rows (`step 1 · 2`).
- **The strip and the step cursor.** A strip on top of the map shows the s-item and one chip per step, coloured by
  view. A chip, ← or → moves the cursor to a step and flies there, in that step's view; a step outside the system
  shows a note instead. **All** goes back to the whole path, ✕ clears the s-item. Esc clears the s-item, but a
  selected c-item or b-item goes first. ← and → do nothing with Alt, Cmd, Ctrl or Shift held (the browser keeps
  them), and no key acts while you type in a field.
- **The right panel.** With no c-item selected it shows the s-item and one card per step (a click goes to that step).
  A c-item's panel lists the steps that touch it ("In simulations").
- **▶ Present.** Hides the rest of the page and flies from step to step with a caption card. Keys: → or PageDown next,
  ← or PageUp back, Space play or pause (each step waits its duration, 4 s when it has none), F full screen, Esc exit.
  Exit puts back the view, the camera and the selection. **⧉ Two windows** opens the IO view (or the s-item's other
  view) in a second window; with the window link on, both windows present the same step: a step plays in the window
  that shows its view (the caption card is there, the other window shows one line), the window that started present
  runs the timer, and Esc or Exit in either window ends present in both (each puts back its own view and camera).
  Closing the window that started present ends it in the others; starting present in the second window takes the lead.
- **≡ Sequence.** Opens a drawer under the map: the s-item as a sequence diagram, one lane per container (plus the
  person, outside senders and externals), one arrow per step. A click on a row goes to that step; drag the top edge
  to resize. **⧉ Own window** opens the diagram alone in a second window; there a row click, ‹ › or ← → only move the
  cursor. Esc does nothing there.
- **Other windows** of the page follow the selected s-item and its cursor (setting "Window link", on by default),
  without moving their camera or changing their view.
- **Sample rows.** In the Storage view a record that has rows in the s-item shows them under its fields once you zoom
  in far enough to read them: the rows after the current step (no cursor: after the last step), a new row with `+`,
  a changed cell as `old→new`, and a label (`changed here`, `unchanged`, `as after step N`, `no rows yet`).
- **The page address.** `#arch&sim=s-1&step=3` opens the page with s-1 selected and the cursor on step 3 (counted
  from 1); the page then goes to that step's view. Add `&seqonly` to show only the sequence drawer (the own window
  uses it). The view word comes first, as in section 8.

### Tests attached to c-items

**Ask before you build or change a c-item:** `c4mp plan show <c-item>` (MCP `plan_show`) lists the tests to run, each
with its run command, and the tests still to write. A test is an accessory of the c-item it tests (container, subregion,
component, function or method): no box, no uid, no tree node, no board link, no arrows. The scan finds the test cases
and hangs each one on the lowest c-item it exercises, on every run (never stored). The plan stores only what the scan
cannot know: tests to write and hand links (`test` blocks).

**Test files.** Config key `tests` in `.c4mp/config.json` says which scanned files are tests (role `test`):
`"tests": {"globs": [...], "ignoreReach": [...], "command": "...", "noTests": false}`. `globs` uses the `ignore` syntax
(folder prefix, file path or glob `*` `**` `?`, repo-relative; a folder pattern covers every file below it). Set, it
replaces the defaults `**/*.test.*`, `**/*.spec.*`, `**/test/`, `**/tests/`, `**/Tests/`, `**/__tests__/`,
`**/test_*.py`, `**/*_test.*`, `**/*Test.php`, `**/*Tests.cs`, `**/*Test.cs` (`DEFAULT_TEST_GLOBS` in
`src/importer/testMatch.ts`); `[]` = no test files. `--tests <patterns>` (comma list) and env `C4MP_TESTS` replace
`globs` only. A test file is still scanned (`search` and `outline` see it), its snapshot entry carries
`"role": "test"` (no `role` = source, as in older snapshots), and it draws no box and no arrow, makes no component a
user, gets no ownership finding, and the storage readers skip it. Folder mode makes no component or container out of
test folders or test projects (a C# test project, a gtest folder with its own `CMakeLists.txt`).

**Test cases.** Only test files are searched for cases. The id of a case is `file#name`:

| Language | A test case is | Name |
|---|---|---|
| TypeScript / JavaScript | an `it` / `test` call (also `xit`, `fit`, `.only`, `.skip`, `.todo`, `.each`, `Deno.test`, a name assigned from them) | the `describe` chain and the title: `orders › places`; a repeated name in one describe gets ` (2)` |
| Python | a `test*` function, or a `test*` method of a class (pytest, unittest) | `test_free`, `TestOrders.test_total` |
| Rust | a function marked `#[test]` (also `#[tokio::test]`, `#[async_std::test]`) | `total_doubles` |
| C# | a method marked `[Fact]`, `[Theory]`, `[Test]`, `[TestCase]`, `[TestCaseSource]`, `[TestMethod]`, `[DataTestMethod]` | `OrderTests.IsFree` |
| PHP | a `test*` method, or one with a `@test` docblock or a `#[Test]` attribute | `OrderTest.testPays` |
| C++ | a gtest body: `TEST`, `TEST_F`, `TEST_P`, `TYPED_TEST`, `TYPED_TEST_P` | `TEST(OrderTest, IsFree)` |
| Swift | an XCTest `test*` method, or a swift-testing `@Test` function or method | `ShopTests.testOrder`, `freeOrder` |

`c4mp outline <test file>` lists the cases (kind `test`). A test file without cases is a helper (fixtures, setup,
`test/helpers/*`): it is not attached itself; what it reaches counts for the cases that use it. A test file without
cases that no other test file imports (a stub server run as a process, say) is one whole-file case, `name` empty.

**Where a case attaches.** From what the case's body reaches (TypeScript/JavaScript: its calls, the imported names it
uses, and path strings, below; the other languages: the imports of its file, so every case of one file gets the same
place, a component or higher):
- One function or method: that function. Several of one component: the component. Several components of one container:
  the container; subregions are skipped (two components of one subregion still give the container). Several containers: the
  system. Code no container owns (shared, unassigned) counts as outside: one such function alone gives that function;
  with one container, that container.
- Subject first: setup code (`beforeAll`/`beforeEach`, the `describe` body, the file's top level) counts only when the
  body alone reaches no c-item. Type-only uses never count.
- `tests.ignoreReach` (globs; C4MP: `src/outputs.ts`, `src/paths.ts`, `src/log.ts`): calls into those files count only
  when the case reaches nothing else, so a logging or path helper does not lift a unit test to the container.
- Mocks: a module named in `jest.mock`, `jest.doMock`, `jest.unstable_mockModule`, `vi.mock` or `vi.doMock` is not reach.
- Path strings: a string that is exactly a scanned path (from the repo root, or from the test's folder:
  `'viewer/panel.js'`, `'../viewer/panel.js'`) counts as using that file only when it goes into a file, path or process
  call (`fs.*`, `path.join`/`path.resolve`, `spawn`/`exec`/`execFile`/`fork`, `require.resolve`), directly, through one
  `const`, or into a parameter of a test helper that passes it to one. A string in a data table, an `expect` or a
  title is data. Build output (`dist/...`) is never mapped back to its source.
- `touches`: the other c-items the case reaches. `plan show X` lists the cases attached elsewhere that reach X as
  "touching" (a container-level flow test touching component X, say).
- Hand links (next part): a link to a case id overrides the place; a link to a helper file adds its parent to the reach
  of every case using the helper. C4MP links its CLI flow tests that way, on Command Line:
  `test 'cli runs' { case 'test/helpers/runCli.ts' }`. A case that spawns the built CLI through that helper reaches
  Command Line, and attaches there unless it also reaches other components.

**Tests in the plan (plan standard 1.5): to write and hand links.** A one-line `test` block in the body of a container,
component, function or method (full syntax: `c4mp guide c4`, section 13; never a `link` line):
- `test 'voids' {}`: a test to write. `check` reports `planned-not-built` (`test 'voids' not written`) until a detected
  case has that name: the full chain (`orders › voids`), or the last part after ` › ` when it is unique in the repo.
- `test 'orders and store' { case 'api/test/orders.test.ts#orders › orders and store' }`: a hand link to a case id puts
  that case on the block's parent (the place found from the code stays in its touches).
- `test 'cli runs' { case 'test/helpers/runCli.ts' }`: a hand link to a test file (a helper) adds the parent to what
  every case using it reaches.
- `c4mp plan add test "<name>" --parent <target> [--case <test id | test file>] --repo R [--yes]` writes the block at
  the end of the parent's body; only `--parent` and `--case`. Refused: a parent of another kind, a second block with
  the same name, a `--case` that is no test case id and no test file of the scan (`c4mp outline <test file>` lists the
  ids), any element option.
- `c4mp plan remove <target> --test "<name>" --repo R [--yes]` removes one block. The write gate refuses any other edit
  that loses a test block; `plan move` and `plan rename` take them along; `plan generate` writes them back.

Real dry run on a copy of the `layers-claim` fixture with the test files of `test/helpers/tests-fixture.ts`, plus
`cancelOrder` and `api/test/cancel.test.ts` of `test/plan-show-tests.test.ts` (jest in `api/`, no runner in `web/`), the
plan moved to `.c4mp/projects/layers-claim/plan/shop.c4`:

```
$ c4mp plan add test "voids" --parent orders --repo .
add shop.api.logic.orders
--- a/.c4mp/projects/layers-claim/plan/shop.c4
+++ b/.c4mp/projects/layers-claim/plan/shop.c4
@@ -12,6 +12,7 @@
         orders = component 'Orders' {
           link ../../../../api/src/orders.ts#placeOrder 'Order entry'
           link ../../../../api/src/orders.ts#cancelOrder
+          test 'voids' {}
         }
       }
       data = layer 'Data' {
dry run: nothing written. Add --yes to apply.
```

**Reading the tests of a c-item.**
- `c4mp plan show <c-item> --repo R` (container, subregion, component or planned function) prints a `tests:` block: the
  counts, then `to run` (cases attached to it or below it), `to write` (its `test` blocks and those below it that no case
  matches) and `touching`; each case as `file:line  name  [level target]` with its run command on the next line
  (`cd <container folder> && ...`, relative to `--repo`) or `no run command: <why>`. Text lists the first 10 of each list
  and `... N more (--all lists every test)`; `--all` lists all. It scans, so pass the same `--lang` as for `check`.
- `c4mp show <file#function> --repo R` prints the same block for a function, class or method on the map (`toWrite`
  only from `test` blocks of a plan function that links it).
- `--json` of both, and MCP `plan_show` (`target`) and `show`, add a `tests` object (below).
- `c4mp board show <id> --with-tests --repo R`: the tests of every c-item a board task links (to run, to write, a count
  of touching ones). Use it in a task brief; text and JSON: `c4mp guide board`, "The tests of a task".
- The map page: each box carries a test count pill (the Tests toggle of the legend hides it; a pill that would cover the
  box's name or detail is left out until you zoom in), and the right panel has a Tests section: rows to run (level,
  place, `file:line`, run command with a Copy button), to write (dashed rows: name and plan element) and touching. The
  Files tab keeps test files (role `test`) and flags code only tests use as `test-only`.

Real run on that copy after `plan add test "voids" --parent orders --repo . --yes` and
`plan add test "orders and store" --parent orders --case "api/test/orders.test.ts#orders › orders and store" --repo . --yes`:

```
$ c4mp plan show orders --repo .
...
tests:     3 to run, 1 to write, 0 touching
  to run:
    api/test/cancel.test.ts:3  places and cancels  [component shop.api.logic.orders]
      cd api && npx jest test/cancel.test.ts -t "places and cancels"
    api/test/orders.test.ts:6  orders › places  [element api/src/orders.ts#placeOrder]
      cd api && npx jest test/orders.test.ts -t "orders places"
    api/test/orders.test.ts:7  orders › orders and store  [component shop.api.logic.orders]
      cd api && npx jest test/orders.test.ts -t "orders orders and store"
  to write:
    voids  [shop.api.logic.orders]  .c4mp/projects/layers-claim/plan/shop.c4:15
```

Without the hand link the last case is `[container api]`, listed under `touching:` (it calls `placeOrder` of Orders and
`savePrice` of Store, two components of `api`).

The `tests` object of `--json` and MCP is `{run, toWrite, touches, counts}`. `run` = test cases attached to the element
(`relation` `own`) or below it (`child`); `touches` = cases attached elsewhere that reach it (`touch`); each has `id`
(`file#describe › name`), `file`, `name`, `line`, `level` (`element`, `component`, `container`, `system`), `target`
(where it is attached: `file#name` or a c-item id), `via` (`calls`, `imports`, or `hand` for a hand link) and `run`:
`{"command","cwd"}` (`cwd` is the container folder, relative to the repo) or null with `noRun` saying why. `toWrite` =
`{name, parent, source, case}` of each `test` block to write. A subregion's tests are its components'; other kinds (store,
screen, ...) have no `tests`. Real run (Orders of `test/plan-show-tests.test.ts`: jest in `api`, no runner in `web`):

```
{"run":[{"id":"api/test/cancel.test.ts#places and cancels","file":"api/test/cancel.test.ts","name":"places and cancels","line":3,"level":"component","target":"shop.api.logic.orders","via":"calls","relation":"own","run":{"command":"npx jest test/cancel.test.ts -t \"places and cancels\"","cwd":"api"}},{"id":"api/test/orders.test.ts#orders › places", ...,"level":"element","target":"api/src/orders.ts#placeOrder","via":"calls","relation":"child", ...}],"toWrite":[{"name":"voids","parent":"shop.api.logic.orders","source":{"file":"c4/plan.c4","line":15,"endLine":15},"case":null}],"touches":[{"id":"api/test/orders.test.ts#orders › orders and store", ...,"level":"container","target":"api","via":"calls","relation":"touch", ...}],"counts":{"run":2,"toWrite":1,"touches":1}}
```

A test in a container without a runner: `{"id":"web/test/page.test.ts#renders", ...,"run":null,"noRun":"typescript tests in web: no jest, vitest, mocha found; set config tests.command"}`.

**Run commands.** The runner is found in the root folder of the container that holds the test file; the command runs
there (`cwd`) with the file path relative to it. The first runner found wins, in this order:

| Language | Runner: found by | Command |
|---|---|---|
| TypeScript / JavaScript | jest: `jest` in `package.json` or a `jest.config.*`; vitest: the same for `vitest`; mocha: `mocha` or a `.mocharc.*` | `npx jest {file} -t "{nameRegex}"`, `npx vitest run {file} -t "{nameRegex}"`, `npx mocha {file} --grep "{nameRegex}"` (the chain joined with spaces) |
| Python | pytest: `pytest.ini`, `conftest.py`, `pytest` in `pyproject.toml` or a `requirements*.txt`, `[tool:pytest]` in `setup.cfg`, `[pytest]` in `tox.ini` | `pytest "{file}::{name}"` (`TestOrders::test_total`) |
| Rust | cargo: `Cargo.toml` | `cargo test "{name}"` |
| C# | dotnet: a `.csproj` that references `Microsoft.NET.Test.Sdk` | `dotnet test --filter "FullyQualifiedName~{name}"` |
| PHP | phpunit: `phpunit.xml`, `phpunit.xml.dist`, or `phpunit/phpunit` in `composer.json` | `vendor/bin/phpunit --filter "{nameRegex}" {file}` |
| Swift | swift: a `.testTarget(` in `Package.swift` | `swift test --filter "{nameRegex}"` (`ShopTests/testOrder`) |
| C++ | none: the gtest binary is known only to the build | set `tests.command` (`{name}` = `Suite.Name`) |

`{name}` and `{nameRegex}` are escaped for a double-quoted shell word, `{nameRegex}` also as a regular expression; the
suffix ` (2)` of a repeated name is dropped. No runner and no `tests.command`: no command, never a guess (`noRun`,
`no run command: ...`). Config `tests.command` is one template for every container and language, and wins over
detection: `{file}`, `{name}`, `{nameRegex}` (any other `{...}` is an error). Real `plan show pages` row with
`"command": "node --test {file} --test-name-pattern \"{nameRegex}\""` on the copy above:

```
    web/test/page.test.ts:3  renders  [component shop.web.pages]
      cd web && node --test test/page.test.ts --test-name-pattern "renders"
```

**Check rules** (table in section 7): `test-only-code` (info: unclaimed code only tests reach), `test-only-component`
(info: a plan component or container whose files are all tests; remove it after moving its board links),
`test-link-dead` (warning: a `case` that names no case and no test file any more), `planned-not-built` for a `test` block
to write, `no-tests` (info, off by default; `"tests": {"noTests": true}`: a plan component with no attached test and no
`test` block on it or below it). Real `check` on the copy above, with `"noTests": true`, the blocks `test 'voids' {}`
(Orders), `test 'renders twice' {}` and `test 'page renders' { case 'web/test/page.test.ts#renders' }` (Pages), after
renaming `web/test/page.test.ts` to `page.spec.ts`:

```
c4mp check · layers-claim · 5 findings (0 critical, 1 warning, 4 info)
warning  test-link-dead  shop.web.pages  test 'page renders' links 'web/test/page.test.ts#renders', which is no test case id and no test file: renamed or deleted?
info     no-tests        shop.api.data.store  Store has no tests: none attached and none planned (c4mp plan add test "<name>" --parent shop.api.data.store)
info     planned-not-built shop.api.logic.orders  test 'voids' not written
info     planned-not-built shop.web.pages  test 'renders twice' not written
info     test-only-code  api/src/util.ts#fmt  api/src/util.ts#fmt is used only by tests: dead code, or tested but not wired in yet
```

**Limits (do not rely on these).**
- Tests written inside source files are not seen: only files matching `tests.globs` are searched for cases. Rust
  `#[cfg(test)] mod tests` in `src/`, Python doctests and other colocated cases are missing from every list.
- A `.each` / `.for` case keeps its template title (`'%s works'`, `%j`): the run command filters on the template, which
  matches no expanded name; run the whole file. Real, on C4MP:
  `npx jest test/test-runner.test.ts -t "detected runner: command and cwd per container %s"`.
- Paths in data tables are not followed: a test that reads files named in an `it.each` row, an array it loops over or
  `[...].flatMap(read)` is not attached through those files. Link it by hand.
- The runner is searched only in the container's own root folder: a jest set up only in a monorepo root is not found for
  a sub-package (set `tests.command`). jest `-t` and the other name filters are not anchored, so they may also run longer
  names that contain the name. When one root has several runners, jest wins over vitest over mocha.
- Rust, C#, PHP, C++ and Swift attach by file imports (no calls): all cases of one file share one place, and their
  mocks are not read. Python cases go by their calls like TypeScript ones, but `unittest.mock.patch` mocks are not read,
  and a case that only uses a pytest fixture or `setup_method` state calls nothing traced: it attaches nowhere (link it
  by hand).
- A whole-file case (a test file without cases that no test file imports) gets a command with an empty name filter
  (`-t ""`), which runs nothing useful for a helper started as a process.

## 5. The `.c4` plan format

Plain text. The generated files look like this:

```
specification {
  element system
  element container
  element component
}

model {
  shop = system 'Shop' {
    api = container 'API' {
      technology 'Node.js / TypeScript'
    }
  }
}
```

Add components, in the same file or another using `extend <full.dotted.id> { ... }`:

```
model {
  extend shop.api {
    order_handlers = component 'Order Handlers' {
      description 'HTTP handlers for creating and listing orders'
      link ../../../../code/src/orders/                    // a folder
      link ../../../../code/src/orders/routes.ts           // a file
      link ../../../../code/src/orders/routes.ts#createOrder   // a function
      metadata {
        status 'in-progress'
        owner 'K'
        priority 'high'
        sprint 'S15'
      }
    }
    payments = component 'Payments' {            // planned: no code yet
      description 'Charge cards through the payment provider'
      metadata { status 'planned'  priority 'medium' }
    }
  }

  shop.api.order_handlers -> shop.api.payments   // relation: "uses / calls"
}
```

Rules that matter:

- **Ids** are letters, digits, `_` and `-`, starting with a letter or `_`, joined by dots (`shop.api.order_handlers`). The quoted text is the title shown on the map.
- **Link paths are relative to the folder holding the `.c4` file**, not to the repo root. The plan lives
  in `.c4mp/projects/<id>/plan/`, so links start with `../../../../` (four levels up reaches the anchor)
  plus the path from the anchor, e.g. `link ../../../../code/src/a.ts` for a scan target `code/`.
  **Copy an existing `link` line from the same plan and change the tail.** Then run `check`.
- Prefer folder or file or `#function` links. **Avoid line-number links** (`#L10-L20`): `check` flags them (`line-link`).
- `status`: `planned`, `in-progress`, `done`, `abandoned`. `priority`: `high`, `medium`, `low`.
  `sprint`: `S` plus a number (`S15`). `done` should have an `owner`.
- **Unknown metadata keys are kept.** Do not remove `layout '...'` lines; the human placed those boxes.
- **`shared 'true'`** in the metadata of a `subregion` marks one every other subregion may use directly (types, small
  helpers). The map draws it as a column on the right of the container, as tall as the other subregions' stack. Only on
  a subregion, only `'true'` (else `invalid-metadata`); one per container. Details: `c4mp guide c4`, section 2.
- **`role 'foundation'`** in the metadata of a `component` marks one that nearly every other component uses (shared
  types, small helpers): `c4mp plan set <component> role=foundation`, remove with `--unset role`. The map draws it as
  tinted glass with a "used by N" badge and hides the arrows into it until pointed at. Only on a component, only
  `'foundation'` (else `invalid-metadata`). Details: `c4mp guide c4`, section 2.
- Comments: `// to end of line` and `/* block */`. Do not use `#`.
- Metadata values must be quoted: write `status 'done'`, not `status done`. **An unquoted value is silently
  ignored (no error)**, so a status you think you set may not exist. After editing, `check` and re-read the file.
- **`uid`** (written by c4mp, never by hand): a quoted UUID such as `uid '1abe1f82-...'` in the metadata of
  each system, container and component. `plan generate` writes it for new elements (`generateC4` in `src/c4/generate.ts`);
  `c4mp plan ids --yes` adds it where missing, also to the other element kinds such as `person`, `screen` and `store`
  (`backfillUids` in `src/c4/ids.ts`). Code elements get no uid.
  `element` and `remove` accept it.

**Storage kinds** (the Storage view). Three kinds describe stored data: `store`, `record`, `field`.
They need no code link (like `person` and `screen`). Use them for databases, JSON or YAML files, folders and buckets, in any project.

```
container     an app, a service
  store       a place that keeps data (a database, a file, a folder, a bucket)
    record    a table, collection, row or file in the store
      field   a column or key; a field can hold fields (nested data)
```

A `record` sits only under a `store`. A `field` sits under a `record` or a `field`. The element's
`technology` line says which kind of store it is. c4mp picks the word to show from it:

| technology | store | record | field |
|---|---|---|---|
| postgres, mysql, sqlite | database | table | column |
| mongodb | database | collection | field |
| json, yaml | file | record | key |
| csv | file | row | column |
| fs | folder | file | field |
| s3 | bucket | object | field |
| redis | instance | key pattern | field |

Any other technology shows `store`, `record`, `field`.

Metadata keys for storage (all values quoted; not checked in plan standard 1.1, kept as written):

| On | Key | Value |
|---|---|---|
| field | `type`, `default` | any text |
| field | `pk`, `unique` | `true` |
| field | `nullable` | `true` or `false` |
| field | `values` | comma list: `new,paid,shipped` |
| field | `fk` | `<record>.<field>`, for example `customers.id` |
| field | `onDelete` | for example `cascade` |
| store | `reader` | a reader id, for example `drizzle`; wins over the technology |
| store | `source` | repo-relative file or folder with the store's code, no leading `./`, for example `src/db/schema` |
| record | `pk` | composite key: `col1,col2` |
| record | `index.<name>` | `[unique ]col1,col2[ where <expr>]` |
| record | `check.<name>` | an SQL expression |

Add them with `plan add --meta key=value` (repeat the option for more keys). Without `--yes`, `plan add` is a dry run and writes nothing:

```
c4mp plan add store Main --id main --parent shop.api --tech postgres --repo . --yes
c4mp plan add record customers --parent shop.api.main --repo . --yes
c4mp plan add record orders --parent shop.api.main --repo . --yes --meta "index.by_customer=customer_id,created_at"
c4mp plan add field id --parent shop.api.main.orders --repo . --yes --meta type=uuid --meta pk=true
c4mp plan add field customer_id --parent shop.api.main.orders --repo . --yes \
  --meta type=uuid --meta fk=customers.id --meta onDelete=cascade
```

To tie a store to its code, add `reader` and `source`. `plan show <store>` reads the code behind a store through its reader.
A named file is always read; a folder, or no `source`, is searched by the reader.

```
c4mp plan add store Main --id main --parent shop.api --tech postgres --repo . --yes --meta reader=drizzle --meta source=src/db/schema
```

A JSON file works the same way: a `store` with `--tech json`, a `record` for the file, and a `field`
inside a `field` for nested data (`address` holding `city`).

Example: a Postgres store with `customers` and `orders`. The foreign key is on the field, one index is one line on the record:

```
main = store 'Main' {
  technology 'postgres'
  customers = record 'customers' {
    id = field 'id' { metadata { type 'uuid'  pk 'true' } }
  }
  orders = record 'orders' {
    metadata { index.by_customer 'customer_id,created_at' }
    customer_id = field 'customer_id' {
      metadata { type 'uuid'  fk 'customers.id'  onDelete 'cascade' }
    }
  }
}
```

A JSON file store with a nested field:

```
settings = store 'Settings' {
  technology 'json'
  config = record 'config.json' {
    address = field 'address' {
      city = field 'city' { metadata { type 'string' } }
    }
  }
}
```

**How c4mp reads a store.** c4mp reads the schema code, never a live database. Two readers exist: `drizzle`
(technology postgres; `.ts` files that mention `drizzle-orm/`) and `sql-migrations` (postgres, mysql, sqlite; `.sql`
files in a migration folder, named like Flyway files, or holding `CREATE TABLE`, applied in migration order). The
`reader` key picks one. Without it, c4mp takes the reader that serves the technology; when two serve it and both find
files, the store is ambiguous (`store-unreadable`): set `reader`. `source` limits the reader to one file or folder.
Test files are never read. A plan record matches a code record by its link first (`link <file>#<table>`), else by
name (title or local id); a plan field matches a code field by name.

**Ids.** A plan store, record or field has its fqn. A record only the code has is `<file>#<name>`
(`db/migrations/0001_init.sql#invoices`); a field only the code has is `<file>#<name>.<field>`
(`db/migrations/0001_init.sql#invoices.user_id`), also under a plan record (`db/migrations/0001_init.sql#users.full_name`);
a nested field adds `.<child>`. `unplanned-record` findings and the storage view use these ids; `find --kind record`
gives the same `path` and `name`.

**Read the code behind a record.** `c4mp plan show <record>` (MCP `plan_show`) shows the code record a plan record
matches. Run on a copy of `test/fixtures/schema-sql/pg` (store `main` with `source 'db/migrations'`; record `users`
lists `email` with `type 'varchar'` and a `ghost` field the code lacks):

```
record  users
uid:       (none: run c4mp plan ids)
fqn:       shop.api.main.users
parent:    shop.api.main
as:        table
code:      db/migrations/0001_init.sql:5-12 (by name)
           id          uuid                      pk
           email       text
           full_name   text                      null
           role        user_role
           manager_id  uuid                      null  fk users.id  on delete set null
           created_at  timestamp with time zone
           updated_at  timestamptz               null
children:  2
source:    c4/arch.c4:7-10
```

`--json` adds `record`. `by` is `link` or `name`. Each field has `name`, `type`, `nullable`, `pk`, `fk`
(`table.column` or null), `onDelete` (or null) and `plan` (the fqn of the plan field matched to it, or null). `diffs`
are the field differences, as `field-drift` reports them: `kind` `missing` (the code has it, the plan does not),
`extra` (the plan has it, the code does not), `type`, `nullable` or `fk`, with the `plan` and `code` values where they
exist:

```
"record":{"file":"db/migrations/0001_init.sql","line":5,"endLine":12,"by":"name","fields":[{"name":"id","type":"uuid","nullable":false,"pk":true,"fk":null,"onDelete":null,"plan":null},{"name":"email","type":"text","nullable":false,"pk":false,"fk":null,"onDelete":null,"plan":"shop.api.main.users.email"}, ...,{"name":"manager_id","type":"uuid","nullable":true,"pk":false,"fk":"users.id","onDelete":"set null","plan":null}, ...],"diffs":[{"record":"users","field":"email","kind":"type","plan":"varchar","code":"text"},{"record":"users","field":"ghost","kind":"extra"},{"record":"users","field":"id","kind":"missing","code":"uuid"}, ...]}
```

A plan record the code does not have gets no `code:` line and no `record` key (`check` reports `missing-record`).
`plan show <store>` prints `code:      reader sql-migrations, 4 records`; `--json` has
`"code":{"reader":"sql-migrations","records":4}`. A store with no code has `records` 0 and a `reason`; a store c4mp
cannot read has `reader` null, `records` 0 and an `error`. Tables are found with `find <name> --kind record` and listed per file with `outline <file>.sql`
(section 4, "Find and read code"). What `check` says about stores is in section 7.

**The storage view.** `c4mp view` adds it to the map page when the plan has a store. The human opens it with the
**Storage** button of the view switch in the top bar, or with `#storage` at the end of the page address; the button is
disabled when the plan has no store. It draws zones (containers) > stores > record boxes with one row per field (PK / FK
tags, type, `?` when nullable), and an arrow from each FK row to the row it points to. A record only in the code has a
dashed border; a record only in the plan has a grey header; a field with a `field-drift` finding has a coloured bar.
Plan-only records and fields, and a store with no code, are marked `planned (no code yet)` in the left tree. Selecting a
record lights the records joined to it by an FK; the side panel lists its fields, FKs, indexes, checks, the components
that own its file and its b-items. The search finds records and fields by name (Names) and by type, FK, index or check
(Content).

**IO view kinds** (the IO view). Six kinds describe what a person sees and does in an app: `screen`, `region`, `control`, `state`, `flow`, `journey`.
They need no code link (like `person` and `store`). A plan with no `screen` has no IO view.

```
container     an app (a web app, a phone app)
  screen      one page or view of the app
    region    a part of the screen (a header, a form, a list)
      control   something to press or type into (a button, a link, a field)
        state     a way the thing looks (error, empty, loading)
```

Where each kind may go (`plan add` refuses any other parent):

| kind | parent |
|---|---|
| `screen` | a container |
| `region` | a screen |
| `control` | a screen or a region |
| `state` | a screen, a region or a control |
| `flow`, `journey` | no rule yet: `plan add` cannot create them. They parse, show in `plan show` and `check` accepts them, but the IO view does not read them yet |

In the IO view the words change: a container is an **App** (the top box is **All apps**), a `screen` is a **Screen**.
The IO view has no C1, C2 or C3 level words: the word comes from the kind (`Region`, `Control`, `State`, `Flow`, `Journey`).

**Navigation.** Write a relation. A screen is reached from a screen, or from one of its own parts:

| You write | It means |
|---|---|
| `screen -> screen` | the first screen can open the second |
| `control -> screen` (also from a region or a state) | pressing that control opens the screen; the arrow is drawn between the two screens |

The label is optional. A label you give (`plan relate ... --label "after sign in"`) is shown on the arrow and on the control's row.
Without a label, the arrow has no text; the control's title is not used on the map (the model keeps it as a fallback name).
Several relations between the same two screens draw one arrow; their different labels are joined with `, `.
A screen that points at itself draws nothing. A relation between two parts of one screen is not navigation and is dropped.

**Calls.** A screen, or a part of it, can say which architecture element it uses. Write a relation to a component, or to a planned function, class or type:

| You write | It means |
|---|---|
| `screen -> component` or `control -> component` | the screen calls the component, or the component implements the screen |
| `screen -> function` or `control -> function` (also class, type) | the same, to one function; `toComponent` is the component that holds it |

The label is optional and is kept only when you write it. A call is not a screen arrow: it is listed in the page data (`C4PM_DATA.nav.calls`, with `from` the screen and `via` the control, or `null`).
For a call to a function, use `plan relate` with the function as the target: `c4mp plan relate shop.web.cart.checkout shop.api.carts.addItem --repo . --yes`. A planned function, class, method or type can be the `<from>` or the `<to>` of `plan relate`.

**Metadata of a screen** (quoted values, like all metadata):

| Key | Value | Effect |
|---|---|---|
| `device` | `web` or `phone` | the shape of the screen card: a 4:3 box (`web`) or a tall phone box (`phone`); also the size a wireframe is laid out at |
| `design` | a URL or a repo path, any text | where the design (a picture, a Figma page) lives; kept with the card, not opened and not checked |
| `viewport` | `'<W>x<H>'`, whole numbers 10 to 99999, for example `'1440x900'` | the size the screen's wireframe is laid out at, instead of the device size (`web` 1280 x 800, `phone` 390 x 844). A bad value is `invalid-metadata` (warning) and the device size is used |

Without `device`, c4mp decides. The card is a `phone` when the container's technology, the container's title, the screen's title or the screen's fqn
contains one of `mobile`, `ios`, `android`, `phone`, `flutter`, `react native`, `swift`, `kotlin` (any case, anywhere in the text, so `Scenarios` matches `ios`). Otherwise it is `web`.
A `device` value other than `web` or `phone` is ignored and the rule above decides. Set `device` yourself when a name matches by accident.
Any part (region, control, state) takes `status` like other elements; it shows on the row.

**Check rules for these kinds.** Two things matter:

- `relation-target-missing` (warning): a relation written inside a screen, command, route or tool, or one of their parts, points to an fqn that is no plan element. Fix the target. Real output:
  `warning relation-target-missing shop.web.cart.checkout  shop.web.cart.checkout: relation to 'shop.api.nope' (.c4mp/projects/demo/plan/shop.c4:44) matches no plan element`
- `missing-code` is not asked of these kinds (a `done` screen needs no link). A planned function you point at gets the usual info `planned-not-built`.

A relation from a screen to a region, control or state of another screen is accepted by `check` but not drawn.

**Wireframes** (where each part of a screen sits; full rules and an example: `c4mp guide c4`, section 2, "Wireframes").
A wireframe is plain HTML, one file per screen, that the IO view lays out in the browser and draws in its own style.
A screen without one is drawn as stacked strips. How to write one:

- **File:** `<plan folder>/io/<screen fqn>.html`, for example `io/shop.web.home.html`. The plan folder holds the `.c4`
  files; a plan read from the whole repo has none, so no wireframes. No `.c4` file in `io/` (it would join the plan).
- **An HTML fragment, nested like the real UI** (page, top bar, main row, panels). Nesting gives only the position;
  the plan says who owns what.
- **`data-c4="<ref>"`** on the element of each region and control of this screen: its id, or the dotted path from the
  screen when the id is used twice (`top_bar.search`). Own screen only, never titles. Elements without `data-c4` only
  shape the layout. States are not placed. `hidden` = shown sometimes (popup, drawer): laid out as if shown, drawn dashed.
- **Classes only.** Every size and position lives in one global `io/site.css`, linked by every screen with
  `<link rel="stylesheet" href="site.css">` (a relative `.css` path inside `io/`). No `style` attributes, no `<style>`
  blocks (`wireframe-inline-style`), no colours: c4mp draws with its theme colours.
- **Layout properties only**, exactly the list in `c4mp guide c4` (display, flex, grid, sizes, padding, margin,
  position, ...). Everything else is removed. Give everything that holds text, and every form control, a width and a height.
- **Size:** the device size (`web` 1280 x 800, `phone` 390 x 844), or `viewport '<W>x<H>'` on the screen. The root
  element fills it (`height: 100%`).

Marks: **no wireframe** (no file; only when another screen of the page has one), **wireframe out of date** (a part has
no `data-c4`, or a ref names nothing or two parts), **wireframe not drawn** (the file could not be used or measured; the
panel gives the reason). The `wireframe-*` rules (section 7) run in `check`, `status`, MCP `check` and `view`, never in
the safe-edit gate: `plan add control` under a screen with a wireframe is never refused (also with `--check`); the new
control is a `wireframe-out-of-date` warning until its `data-c4` is written. Real output:
`warning  wireframe-out-of-date shop.web.home  no data-c4 for top_bar.help`.

**CLI, API and MCP**. A command line tool, an HTTP API and an MCP server are drawn like screens. Eight more kinds:

```
container     an app (technology says CLI, API or MCP)
  command     a command; a subcommand is a command under a command
    options   a group of options (optional)
      flag      --json, --file <path>
    flag      a flag without a group
    arg       <name>
  route       an API route, titled like "GET /orders/:id"
    param     a path or query parameter (metadata in, type, required)
    body      the request body
      param     a field of the body
  tool        an MCP tool
    param     an input of the tool
```

Where each kind may go (`plan add` refuses any other parent):

| kind | parent | shown as |
|---|---|---|
| `command` | a container, or a command (subcommand) | Command |
| `options` | a command | Option group |
| `flag` | a command or an options group | Flag |
| `arg` | a command | Argument |
| `route` | a container | Route |
| `body` | a route | Body |
| `param` | a route, a body or a tool | Param (Field under a body) |
| `tool` | a container | Tool |

`command`, `route` and `tool` are the cards of the IO view (like `screen`); the others are rows on the card. Each subcommand is its own card, titled with its full path (`plan show`).
Unlike a screen, a `command`, `route` or `tool` that is `done` or `in-progress` needs a `link` to its code (check rule `missing-code`); its parts need none.
The word of an app comes from its `technology`: commander, yargs, click, cli give **CLI**; express, fastify, hono, rest, http, api, openapi give **API**; mcp gives **MCP**; anything else stays **App**.
The title is shown as written (`--json`, `<target>`, `GET /orders/:id`). A route takes its HTTP method from `--meta method=GET`, else from the first word of the title when that is GET, POST, PUT, PATCH, DELETE, HEAD or OPTIONS.
A `param` takes `--meta in=path|query|header|body` (default `query` under a route, `body` under a body), `--meta type=<text>` and `--meta required=true`; they are kept as written and not checked.
A relation from a command, route or tool, or from one of its parts, to a component or planned function is a call, like a screen's (`plan relate <command> <component>`). Readers that fill these kinds from code come later; for now you write them.

Example run (a CLI with `plan show`, an API with two routes, an MCP server with one tool; each `plan add` prints a diff without `--yes`):

```
c4mp plan add container cli --parent shop --title "Shop CLI" --tech "Node / commander" --repo . --yes
c4mp plan add command plan --parent shop.cli --title plan --repo . --yes
c4mp plan add command show --parent shop.cli.plan --title "plan show" --repo . --yes
c4mp plan add flag json --parent shop.cli.plan.show --title "--json" --repo . --yes
c4mp plan add arg target --parent shop.cli.plan.show --title "<target>" --repo . --yes
c4mp plan add container api --parent shop --title "Shop API" --tech Express --repo . --yes
c4mp plan add route get_order --parent shop.api --title "GET /orders/:id" --repo . --yes
c4mp plan add param id --parent shop.api.get_order --meta in=path --meta type=uuid --repo . --yes
c4mp plan add param expand --parent shop.api.get_order --meta in=query --repo . --yes
c4mp plan add route post_order --parent shop.api --title "POST /orders" --repo . --yes
c4mp plan add body body --parent shop.api.post_order --title Body --repo . --yes
c4mp plan add param sku --parent shop.api.post_order.body --meta type=string --repo . --yes
c4mp plan add param qty --parent shop.api.post_order.body --meta type=int --repo . --yes
c4mp plan add container mcp --parent shop --title "Shop MCP" --tech "TypeScript / MCP" --repo . --yes
c4mp plan add tool find_product --parent shop.mcp --repo . --yes
c4mp plan add param query --parent shop.mcp.find_product --meta type=string --repo . --yes
c4mp plan add param limit --parent shop.mcp.find_product --meta type=int --repo . --yes
c4mp plan relate shop.cli.plan.show.json shop.core.orders --label reads --repo . --yes
```

`plan show` then prints `1 .c4 files, 20 elements, 2 relations, 0 issues` (with two relations and a `core` container holding the component `orders`), and `check` prints `0 findings`. The plan file holds, for example:

```
get_order = route 'GET /orders/:id' {
  id = param 'id' {
    metadata {
      in 'path'
      type 'uuid'
    }
  }
}
```

The page data (`C4PM_DATA.nav`) lists the entries per app (`word` `CLI`, `API` or `MCP`), and the IO view draws one card per command, route and tool.

Worked example: a web app with Login and Cart, an API with a Cart service, and a phone app. Build it with commands (each prints a diff without `--yes`):

```
c4mp init --repo .                                # the project folder name is the plan name, here "shop"
printf 'model {\n}\n' > .c4mp/projects/shop/plan/shop.c4      # an empty plan to add into
c4mp plan add context shop --as system --title "Shop" --repo . --yes
c4mp plan add container web --parent shop --title "Web app" --tech React --repo . --yes
c4mp plan add container mobile --parent shop --title "Mobile app" --tech "iOS app (Swift)" --repo . --yes
c4mp plan add container api --parent shop --title "Shop API" --tech Node --repo . --yes
c4mp plan add component carts --parent shop.api --title "Cart service" --repo . --yes
c4mp plan add planned-fn addItem --parent shop.api.carts --signature "addItem(cartId: string, sku: string): Cart" --status planned --repo . --yes
c4mp plan add screen login --parent shop.web --title Login --meta design=https://example.com/design/login --repo . --yes
c4mp plan add screen cart --parent shop.web --title Cart --meta design=design/cart.png --repo . --yes
c4mp plan add region form --parent shop.web.login --title "Sign-in form" --repo . --yes
c4mp plan add control signin --parent shop.web.login.form --title "Sign in" --repo . --yes
c4mp plan add state error --parent shop.web.login.form --title "Wrong password" --repo . --yes
c4mp plan add control checkout --parent shop.web.cart --title Checkout --repo . --yes
c4mp plan add control logout --parent shop.web.cart --title "Log out" --repo . --yes
c4mp plan add screen home --parent shop.mobile --title Home --repo . --yes
c4mp plan add screen dashboard --parent shop.mobile --title Dashboard --meta device=web --repo . --yes
c4mp plan relate shop.web.login.form.signin shop.web.cart --label "after sign in" --repo . --yes
c4mp plan relate shop.web.cart.logout shop.web.login --repo . --yes
c4mp plan relate shop.web.cart.checkout shop.api.carts --label "places the order" --repo . --yes
c4mp plan relate shop.mobile.home shop.mobile.dashboard --label open --repo . --yes
```

Then add the call to the function (inside `checkout`, under its `->` line):

```
c4mp plan relate shop.web.cart.checkout shop.api.carts.addItem --repo . --yes
```

The result is this plan
(the `uid` lines that c4mp writes are left out here):

```
model {
  shop = system 'Shop' {
    web = container 'Web app' {
      technology 'React'
      login = screen 'Login' {
        metadata {
          design 'https://example.com/design/login'
        }
        form = region 'Sign-in form' {
          signin = control 'Sign in' {
            -> shop.web.cart 'after sign in'
          }
          error = state 'Wrong password'
        }
      }
      cart = screen 'Cart' {
        metadata {
          design 'design/cart.png'
        }
        checkout = control 'Checkout' {
          -> shop.api.carts 'places the order'
          -> shop.api.carts.addItem
        }
        logout = control 'Log out' {
          -> shop.web.login
        }
      }
    }
    mobile = container 'Mobile app' {
      technology 'iOS app (Swift)'
      home = screen 'Home' {
        -> shop.mobile.dashboard 'open'
      }
      dashboard = screen 'Dashboard' {
        metadata {
          device 'web'
        }
      }
    }
    api = container 'Shop API' {
      technology 'Node'
      carts = component 'Cart service' {
        addItem = function 'addItem' {
          metadata {
            status 'planned'
            signature 'addItem(cartId: string, sku: string): Cart'
          }
        }
      }
    }
  }
}
```

Real output of this plan (no code in the repo):

```
$ c4mp plan show --repo .
1 .c4 files, 15 elements, 5 relations, 0 issues
$ c4mp check --repo .
c4mp check · shop · 1 findings (0 critical, 0 warning, 1 info)
info     planned-not-built shop.api.carts.addItem  addItem is planned and not built yet: has no link to its code
```

`c4mp view --repo . --out view.html` builds the page. Its data (`C4PM_DATA.nav`) has these edges and calls:

```
edges  shop.web.login -> shop.web.cart          label "after sign in"  via shop.web.login.form.signin  (labelled)
       shop.web.cart -> shop.web.login          label "Log out" (the control title, not shown)  via shop.web.cart.logout
       shop.mobile.home -> shop.mobile.dashboard  label "open"  via null  (labelled)
calls  shop.web.cart via shop.web.cart.checkout -> shop.api.carts          component  label "places the order"
       shop.web.cart via shop.web.cart.checkout -> shop.api.carts.addItem  function   label null (toComponent shop.api.carts)
```

and the screen cards (`C4PM_DATA.navView`) are: `login` device `web`, design `https://example.com/design/login`, rows region `form` (depth 0), control `signin` (depth 1, nav to `shop.web.cart` labelled "after sign in"), state `error` (depth 1);
`cart` device `web`, design `design/cart.png`, rows `checkout`, `logout` (nav to `shop.web.login`, no label);
`home` device `phone` (the technology `iOS app (Swift)` matches); `dashboard` device `web` (set by hand).

**Planned code** (function, class, method or type, nested in a component) describes code that does not
exist yet or is being built. Kinds: `PLANNED_CODE_KINDS` in `src/plan/plannedElements.ts`.

```
model {
  billing = component 'Billing' {
    plan_fn = function 'planFn' {
      link ../src/planned.ts#planFn
      metadata {
        status 'planned'
        signature 'planFn(): void'
      }
    }
  }
}
```

- Its `link` names the function, class or type (`#name`); `status` and `signature` are read from metadata
  (`extractPlannedCode` in `src/plan/plannedElements.ts`, fixture `test/fixtures/level4/c4/plan.c4`).
- On the map, planned code with no scanned node is a **ghost box** (`attachGhostNodes` in `src/view/model.ts`). Planned
  boxes are drawn with a faint tint and a **dashed outline** (`drawBubble` in `viewer/render.js`).

**Plan-only containers and components** (in the plan, no code matched yet) are added to the map in
folder mode and labelled `planned (no code yet)` in the tree and the side panel (`attachPlanOnlyNodes` in `src/view/model.ts`;
`renderNode` in `viewer/tree.js`; `renderHeader` in `viewer/panel.js`). Checked on a scratch repo: a component with only a
`description` and no link appeared in the map data with `planOnly: true`.
**One `link path#fn` line switches the plan to claim mode** (`isClaimModePlan` in `src/c4/ownership.ts`),
and then the plan-only components are not added. Checked: a component with
`link ../../../../api/src/server.ts#start` lost its plan-only node; removing that line brought it back.

## 6. The workflow

**First time on a project**

```
c4mp init        --repo R                      # skip if the code is already inside a git repo
c4mp view        --repo R --lang ... --open    # look at the raw scan first
c4mp plan generate --repo R --lang ...           # draft plan
   ... read the project's docs (README, CLAUDE.md, status notes) and the draft; edit the .c4 files:
       readable titles, descriptions, group code by purpose with #function links,
       add relations (a -> b), add planned parts, set statuses ...
c4mp check       --repo R --lang ...           # fix what it reports, repeat
c4mp view        --repo R --lang ... --open
```

**Every later change**

- Edit the plan or the code, then `check`. **Run `check` after every `.c4` edit**, even when the code did not change: your edit can add new findings.
- `view` whenever the human wants to look. `view` never changes the plan.
- Re-run `plan generate` only after adding new code; it keeps your changes and the components you added by hand (see the `plan generate` row in section 4).
- To discuss a change: `history` once, then `diff --from <a> --to <b> --format markdown`.

**Breaking down a feature**

1. Add components with `status 'planned'` for each piece, with `description`, `priority`, `sprint` (`c4mp plan add component ... --parent ... --status planned`).
   If the container has subregions used as layers, write the feature's path layer by layer first (entry point -> service -> engine or reader) and plan any missing service function, instead of calling a reader or an engine straight from the entry point ("Planning with layers" in the `.c4` guide, section 2).
2. Add relations between them and to the existing parts (`c4mp plan relate`).
3. As code is written, add links (`c4mp plan link`, file or folder first, see "The folder to claim trap" in section 4) and change status to `in-progress` (`c4mp plan set`), then `done` with an `owner`.
4. `check --sprint S15` shows mismatched items (late items: not verified). `stubs` shows unfinished functions.

## 7. What `check` reports

Output lines look like `severity  rule  id  message`.

| Rule | Meaning | Usual fix |
|---|---|---|
| `parse-error` | Syntax error in a `.c4` file. | Fix the syntax (quotes, braces). |
| `code-parse-error` (warning) | A source file the parser could not fully read; its code elements and imports may be incomplete. | Fix the syntax error in the source file. |
| `invalid-metadata` | Bad status/priority/sprint, or `done` with no owner. Also `shared` on an element that is not a subregion, or with a value other than `'true'`. Also a `viewport` that is not `'<W>x<H>'` with whole numbers 10 to 99999. Also `shape` on an element that is not a person, or with a value other than `'person'` or `'robot'`. Also `role` on an element that is not a component, or with a value other than `'foundation'`. | Use the allowed values. |
| `missing-code` | `done`/`in-progress` but no link, or the link finds nothing. Not asked of subregion, person, external, screen-family kinds and storage kinds (store, record, field). | Fix the link or the status. |
| `broken-function` | `link ...#name` names a function that does not exist. | Check with `plan resolve-link`. |
| `stub-in-done` | `done` but the linked function is a stub. | Implement it or lower the status. |
| `planned-but-built` | `planned` but the code exists. Also a `planned` record that a record in the code matches. | Update the status. |
| `planned-not-built` (info) | Planned or in-progress planned code whose link finds no code (or has no link). Also a `test` block to write (no `case`) that no detected test case matches yet: `test '<name>' not written`. | Link the code once written; write the test (same name, or same last part after ` › `). |
| `planned-built-update-status` (info) | Planned code whose link finds code that is not a stub, but the status is still `planned`. | Update the status. |
| `missing-signature` (info) | Planned function or method with status `planned` and no `signature` metadata. | Add `signature`. |
| `broken-claim-link` (warning) | A folder link whose folder exists but holds no source file. | Fix the folder link. |
| `folder-link-no-slash` (warning) | A link to a folder without the trailing `/`: it claims no files. | Add the `/` to the link. |
| `abandoned-but-present` | `abandoned` but the code is still there. | Remove the code or change the status. |
| `duplicate-fqn` | Two elements have the same fqn. | Rename one. |
| `duplicate-uid` (warning) | Two elements use the same `uid`. | Give one a new uid. |
| `subregion-misplaced` (warning) | A `subregion` not directly in a container, or a subregion with a `link`. Was `layer-misplaced` before plan standard 1.9; old acks still work. | Move the subregion into a container; link its components, not the subregion. |
| `relation-target-missing` | A relation from a screen or one of its parts points to an fqn that is no plan element. | Fix the target fqn. |
| `late` | Sprint passed, item not done (needs `--sprint`). Late items: not verified. | Re-plan or finish. |
| `line-link` | Link uses line numbers. | Link the function instead. |
| `unplanned-code` | A file no component owns. | Add it to a component. |
| `plan-unmatched` (info) | A component with a link, or `done`/`in-progress`, that matches no scanned node. | Link a folder the scan finds. |
| `split-file` / `component-claim-conflict` / `shared-auto` / `unassigned-code` | Ownership is split, in conflict, shared or missing. | Make links less ambiguous. |
| `test-only-code` (info) | Claim mode: unclaimed code that only test files reach: dead, or tested but not wired in. Test files (config `tests.globs`) never make their component a user and get no ownership findings. | Wire it in, claim it, or delete it. |
| `test-only-component` (info) | A plan component or container whose claimed files (its links and those of the elements below it) are all test files (config `tests.globs`). Tests attach to the code they test; folder mode makes no component or container out of test folders or test projects. Reported on the outermost one only. | Remove it (move its board links first). |
| `test-link-dead` (warning) | A `test` block's `case` names neither a detected test case id nor a test file (renamed or deleted since): the hand link attaches nothing. | Point `case` at the new id or file (`plan remove --test`, then `plan add test --case`). |
| `no-tests` (info) | Off by default; config `"tests": { "noTests": true }` turns it on in `check`: a plan component on the map with no attached test and no `test` block on it or below it. | Write a test, or plan one with `plan add test`. |
| `layer-upward` (warning) | A code arrow from a component to a component of a subregion above its own in the same container (declaration order, first = top). A shared subregion is never the target; as the source it is checked by its place. `id` is `from -> to`. | Call the layer below; or move the code both need into a lower or shared subregion. |
| `layer-skip` (warning) | Off by default; config `"layers": {"skip": true}` (env `C4MP_LAYERS_SKIP`) turns it on: an entry point that skips the services, i.e. a code arrow from a component of the top non-shared subregion to one below the next non-shared subregion (it jumps over the second layer). A lower subregion jumping over one is not reported; shared subregions never count. The message names a component in between that already calls the target. | Go through the component the message names, or plan a service function (`c4mp plan path <from> <to>` shows where). |
| `foundation-candidate` (info) | A component used by more than half of the other components (claim mode, code imports) and not marked. | `c4mp plan set <component> role=foundation` (the map hides the arrows into it until hovered, focused or selected). |
| `wireframe-missing` (info) | **No wireframe**: a screen has no `io/<screen fqn>.html` (only when the plan folder has an `io/` folder). Also a wireframe file c4mp cannot use (symbolic link, over 512 KB, unreadable) or an `io/` that is not a plain folder; the message says why. | Write the file as a plain file in `io/`, or do what the message says. |
| `wireframe-out-of-date` (warning) | **Wireframe out of date**: a region or control of the screen has no `data-c4`, or a `data-c4` names nothing under the screen or names two parts. One finding per problem. | Add the `data-c4`, fix the ref, or write the dotted path from the screen. |
| `wireframe-orphan` (warning) | `io/<name>.html` names no screen of the plan (renamed or removed?). | Rename the file to the screen's fqn, or delete it. |
| `wireframe-bad-stylesheet` (warning) | A `<link>` in a wireframe that is no stylesheet inside `io/`, or whose file does not exist; it is dropped. | Link a `.css` file inside `io/` by a relative path. |
| `wireframe-inline-style` (info) | A wireframe file with `style` attributes or `<style>` blocks. | Move them to classes in `io/site.css`. |
| `missing-store` (by status) | A store with no code files: no reader serves its technology, or its reader finds no files (only when the plan has a store). Severity of the storage rules by status: `planned` info, `in-progress` or none warning, `done` critical; `abandoned` gets none. | Write the schema, fix `technology` / `metadata { reader source }`, or lower the status. |
| `store-unreadable` (warning) | A store c4mp cannot read: ambiguous technology, unknown reader, live reader, a limit or a reader error (`store-scan`: the repository scan failed). The message is the error. | Set `metadata { reader '<id>' }`, or fix what the message says. |
| `missing-record` (by status) | A record of a read store that is not in the code. | Create the table, fix the name or link, or lower the status. |
| `field-drift` (by status) | A field of a matched record differs: missing, extra, type, nullable or fk; the message names the kind and both values. | Make the plan field and the code agree. |
| `unplanned-record` (info) | A record in the code that a read store does not list. | `c4mp plan add record <name> --parent <store>`. |
| `unplanned-store` (info) | Records a reader finds that no store covers. | `c4mp plan generate --view storage`. |
| `sim-parse` (warning) | An s-item file in the project's `sim/` folder with a structure problem (the item is not loaded), an unknown key (kept as written), or a `.json` not named `s-<N>.json`. `id` is the file (`s-3.json`). | Fix the file as the message says. |
| `sim-target-missing` (warning) | A step target, an inline journey stage target, a step `call.from` / `call.to`, or a `rows` key that names no plan element (uid or fqn) and no scanned function (`path#name`); a `rows` key that is not a `record`. `id` is `s-1:3` (step 3) or `s-2:stage-3`. | Point it at the element's uid or fqn, or the function's `path#name` (renamed or removed?). |
| `sim-step-unconnected` (info) | Two consecutive flow steps with no link: no navigation relation (screen to screen), no relation from the screen part to the component or function (or its component), or no resolved call path of at most 3 calls (function to function; a longer path is named). Other pairs are not judged. `id` is `s-1:2-3`. | Add the missing relation (`c4mp plan relate`), add the step in between, or fix the order. |
| `sim-step-unverified` (info) | A function -> function pair that cannot be proven: one side is planned only, or the first has an untraced call with the second's name. Only when the scan read the calls. `id` is `s-1:6-7`. | Write or link the code; a real untraced call needs nothing. |
| `sim-stage-missing` (warning) | A journey `flow` stage that names no s-item, a journey, or the journey itself. `id` is `s-2:stage-3`. | Name an existing flow. |

The `sim-*` rules read the s-items (flows and journeys, one file each in `.c4mp/projects/<id>/sim/`). They run in
`check`, `status`, MCP `check` and `view`, only when the project has a `sim/` folder. `person` is free text, never a finding.

The `wireframe-*` rules read the plan and the files in `io/`. They run in `check`, `status`, MCP `check` and `view`,
never in the safe-edit gate of the plan commands, so no plan edit is refused because of a wireframe.

The storage rules (`missing-store` to `unplanned-store`, and `planned-but-built` for a record) read the plan and the
store code ("Storage kinds", section 5). They run in the same places, also never in the safe-edit gate.
- Only when the plan has a `store`: a plan with no store gets no storage finding, not even `unplanned-store`.
- "By status" is the status of the element the finding is about: `planned` info, `in-progress` or no status warning,
  `done` critical. A `field-drift` on a field with no status takes its record's status. An `abandoned` store, record or
  field gets no finding, and neither does what is under it. `unplanned-record` and `unplanned-store` are always info.
- `missing-store`: the store has no code files (no reader serves its technology, or the reader finds none); its records
  get no `missing-record`. `store-unreadable`: only a real read failure (ambiguous technology, unknown reader id, live
  reader, a reader limit, a reader error).
- A plan record that lists no field is checked by name only; once it lists one, every code column it does not list is a
  `field-drift` "missing in the plan".
- `c4mp plan unplanned --view storage` lists the `unplanned-record` and `unplanned-store` findings only.

Real `check` lines (copies of `test/fixtures/schema-sql/pg` and `schema-drizzle`):

```
info     missing-record  shop.api.main.payments  record 'payments' is not in the code of store shop.api.main (reader sql-migrations)
info     planned-but-built shop.api.main.classes  classes is planned but code exists: db/migrations/0001_init.sql:14; update the status?
warning  field-drift     shop.api.main.users.email  users.email: type 'varchar' in the plan, 'text' in the code
warning  field-drift     shop.api.main.users.ghost  users.ghost: extra in the plan, the code has no such field
warning  field-drift     shop.api.main.users  users.id: missing in the plan (the code has it, type 'uuid')
info     unplanned-record db/migrations/0001_init.sql#invoices  record 'invoices' (line 30) is not under store shop.api.main
info     missing-store   school.api.cache  no reader for technology 'redis'
warning  store-unreadable school.api.files  unknown reader 'prisma'; known readers: drizzle, sql-migrations
warning  store-unreadable school.api.old  ambiguous: readers drizzle, sql-migrations all find files for 'postgres'; set metadata reader
info     unplanned-store db/migrations/0001_init.sql  sql-migrations finds 4 records in 1 files, no store covers them
```

**Planning functions, classes and types.** Nested `function`/`class`/`method`/`type` elements under a component plan code; the full syntax and the real output are in `c4mp guide c4`, section 13. Workflow:

1. Add the nested element with `status`, `signature` and `link <path>#<name>` (the path is relative to the `.c4` file).
2. `plan resolve-link <path>#<name> --repo R` (repo-root path) to confirm the function exists.
3. `check --repo R` and fix the `planned-*` and `missing-signature` findings.
4. `stubs --repo R` before you set `done`.

**Tests in the plan** (`test` blocks: tests to write and hand links, `plan add test`, `plan remove --test`): section 4,
"Tests attached to c-items". Full syntax: `c4mp guide c4`, section 13.

**A command feels slow?** Set `C4MP_TIMING=1` and it prints one table to stderr when it ends (stdout is unchanged): seconds per step, such as `load plan`, `scan repo`, `checkPlan`, `board gate`, `write plan`. Off by default. Example: `C4MP_TIMING=1 c4mp plan link auth src/auth/ --repo .`

## 8. The map page

The human opens `c4mpView.html` in a browser: scroll to zoom, drag to pan, double-click a shape to
dive in, **Auto level** to open the right detail while zooming, **Edit layout** to drag and resize
boxes with Undo/Redo, **Auto arrange** to put the selected container or subregion back to the automatic
layout (one undo step; the export then drops the saved `layout` of those boxes), **Export layout** to download
`c4mp-layout.json`. The static page cannot write files: the human (or you) saves the layout with `c4mp plan apply-layout --file c4mp-layout.json`. In a page served by `c4mp serve` the human presses Save layout instead.
You do not need to touch layout.

The view switch in the top bar has three buttons: Architecture view, IO view (when the plan has a screen, command,
route or tool) and Storage view (when the plan has a store; see "Storage kinds" in section 5). The page address
`#io` or `#storage` opens that view directly.

With s-items the page also has a Simulations list, a path strip, present mode and a sequence drawer: section 4,
"Simulations (s-items)", "In the page".

## 9. Not available yet (do not rely on these)

- **A complete call graph.** `calls` and `callers` (section 4) trace only calls they can prove (TypeScript/JavaScript and Python; same file, names imported from a repo file, methods of a known class or namespace, `this` / Python `self` and `cls` in a method) and count the rest as `unresolved`; the other languages have no calls. A function passed around as a value, callbacks through parameters and methods on untyped variables are not traced: use your normal search tools to double-check when `unresolved` is not 0.
- **Tests written inside source files** (Rust `#[cfg(test)] mod tests`, doctests), and the other limits of tests listed at the end of "Tests attached to c-items" (section 4).
- **Renaming or moving code.** `c4mp edit` replaces, inserts and removes one function, class, method or test case (see "Edit code and tests"), but it cannot yet rename or move one, nor update its callers and plan `link` lines (planned). Plan files change through `plan add`, `plan set`, `plan link`, `plan relate`, `plan remove`, `plan move`, `plan rename`, `plan ids`, `plan apply-layout` or by hand.
- **Planned-or-built state of a linked element in `board show`.** It needs a code scan, so `board show` gives the plan's own facts (kind, fqn, status, owner) only.
- **A VS Code extension / own UI.** Planned. For now: command line, MCP server and the HTML page.
- **Automatic language detection.** Pass `--lang` with the ids of the languages to read (functions and imports): typescript, python, rust, csharp, php, cpp, swift (`c4mp languages` checks each grammar). Other file types are only listed as file-only boxes with `--lang files` (section 4).
- **Several code folders merged into one system map.** Each scan target is its own system.
- **Function/file layout and notes stored in source comments** (`// c4mp:`). Under discussion.
- **A full timeline from the hooks.** The git hooks record the final state of each commit or merge only, not the
  commits a merge brings in: run `c4mp history` for those ("Hooks" in section 4).

## 10. Rules for you

The block between the `skill:description` and `skill:rules` markers below is the source of the Claude Code skill
file: `c4mp guide ai --skill` copies exactly these two parts (and nothing else of this guide) into `SKILL.md`
(or, with `--format agents`, into an `AGENTS.md` snippet). Keep every rule short and self-contained.

<!-- skill:description -->
Use c4mp when the repo has a `.c4mp` folder, or when the user mentions the plan, C4, the architecture map, boards, b-items or c-items.
<!-- /skill:description -->

<!-- skill:rules -->
1. Read before you edit. Never guess a function name or path: look it up with `find` or `outline`, read it with `show`, see what it calls and who calls it with `calls` and `callers`, and test a link with `plan resolve-link <path>#name` first. Change one function, class, method or test case with `edit replace|insert|remove <file#name>`: it needs no exact old text and refuses an edit that breaks parsing.
2. Look at the plan with `plan tree` (and at unowned code with `plan unplanned`) before you add to it.
3. Edit only files under `.c4mp/projects/<id>/plan/`, never `data/`, `history/` or `C4MP/` (regenerated). Change the plan with `plan add`, `plan set`, `plan link`, `plan relate`, `plan move`, `plan rename` rather than by hand: they quote values, keep `layout` and `uid` lines and refuse an edit that makes `check` worse.
4. Every write command is a dry run until you add `--yes`: read the diff first, then repeat with `--yes`.
5. After any plan edit run `check` and show the human the findings you could not fix.
6. Read a `new-findings` refusal and its `NEXT STEP` line; do not retry the same edit. Do not use `--force` to get past `outside-c4pm` unless the human said the plan lives outside `.c4mp/`.
7. Never delete a `layout` line, and never run `plan generate` into a different folder than the existing plan (copied blocks keep their old relative link base).
8. When unsure whether a part is `done`, check the code (`stubs`, `plan resolve-link`) before setting the status.
9. Never edit the board file `board.json` by hand: change boards only with the `c4mp board` commands (dry run unless `--yes`).
10. Do not rely on anything the AI guide (`c4mp guide ai`) lists as not available yet: do not pretend it exists.
<!-- /skill:rules -->
