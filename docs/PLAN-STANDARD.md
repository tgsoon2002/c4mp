# C4PM Plan Standard

Version 1.12 (2026-11-23)

Copyright (c) 2026 Kien Nguyen

This document is licensed under the Creative Commons Attribution 4.0 International license (CC BY 4.0), https://creativecommons.org/licenses/by/4.0/. You may copy, share and adapt it, also commercially, if you give credit.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are used as in RFC 2119 and RFC 8174. Rules are numbered `PS-<chapter>.<n>` so they can be cited, for example PS-4.3. The number counts rules in a chapter. The sub-headings (2.1, 2.2, ...) only help reading; they are not part of a rule number. Every rule describes what the reference implementation (the `c4pm` program, source in `Project/src/`) does. Appendix B gives the source file and line for each group of rules.

A conformance corpus (files and expected results) is in `Document/plan-standard-corpus/`. See PS-9.9.

## Contents

1. Scope and terms
2. Folder layout and file discovery
3. The `.c4` text format
4. Metadata keys
5. Links to code
6. Plan checks
7. Safe editing
8. The board file
9. Versioning and compatibility
10. Simulation files
- Appendix A: Grammar (EBNF)
- Appendix B: Where each rule is implemented
- Appendix C: Change history

---

## 1. Scope and terms

**PS-1.1** This standard defines how a software architecture plan is stored in a repository: the plain-text `.c4` plan files, the folder they live in, the JSON board file next to them, and the JSON simulation files (since 1.10). It lets a program other than `c4pm` read, check and write a plan.

**PS-1.2** This standard does not define: the scan of source code, the snapshot files in `data/`, the history store, the browser map page, the `C4PM/` export folder, or the command line of `c4pm`. Where a rule names a `c4pm` command it is only an example of a tool.

**PS-1.3** Terms.

| Term | Meaning |
|---|---|
| plan | All `.c4` files found by section 2, read as one unit. |
| element | One named thing in the plan: a system, container, component, screen, and so on. C4PM documents also call it a c-item. |
| kind | The word that says what an element is (`system`, `component`, ...). PS-3.10. |
| id | The short name of an element, written before `=`. |
| fqn | Fully qualified name: the ids of all ancestors and the element, joined by `.`. It identifies the element. |
| relation | A directed line from one fqn to another, with an optional label. |
| link | A pointer from an element to code (a file, a folder, a function) or to a URL. |
| claim | A link on a `component` element, read as "this component owns that code". PS-5.7. |
| metadata | Key and value pairs of an element. Section 4. |
| uid | A UUID stored in metadata. It identifies an element and survives renames. |
| parse issue | A problem found while reading the text of a `.c4` file. |
| finding | A result of a check rule. It has `severity`, `rule`, `id` and `message`. Section 6. |
| anchor | The folder that holds `.c4pm/`. PS-2.1. |
| project id | The folder name of a project inside `.c4pm/projects/`. PS-2.4. |
| board | A list of work items (tasks, bugs, ...) stored in `board.json`. Section 8. |
| board item | One entry of a board. C4PM documents also call it a b-item. |
| s-item | A simulation item: how the system runs for one scenario, as a flow of steps or a journey of stages. One JSON file each. Chapter 10. |
| reader | A program that reads plan files, the board file or simulation files. |
| writer | A program that changes plan files, the board file or simulation files. |
| checker | A reader that also computes findings. |

**PS-1.4** A conforming implementation states which roles it fills: reader, checker, writer. PS-9.5 to PS-9.7 list the duties of each.

---

## 2. Folder layout and file discovery

### 2.1 Anchor

**PS-2.1** The anchor of a target folder is the nearest folder, starting at the target itself and going up, that contains an entry named `.c4pm` or `.git`. For `.git` a file counts as well as a folder (worktrees and submodules use a file). If no folder up to the filesystem root has one, there is no anchor.

### 2.2 The `.c4pm` folder

**PS-2.2** `<anchor>/.c4pm/` holds the internal data of the tool. It is committed to version control, except the folders named in PS-2.3 and PS-2.5.

**PS-2.3** Layout:

```
<anchor>/
  .c4pm/
    .gitignore                  ignores projects/*/data/ and projects/*/history/
    config.json                 settings (committed)
    projects/<id>/
      plan/                     the .c4 files (committed)
      board/board.json          the board file (committed)
      sim/s-<N>.json            one simulation file per s-item (committed, since 1.10)
      data/                     rebuilt scan results (not committed, not part of this standard)
      history/                  rebuilt snapshots (not committed, not part of this standard)
  C4PM/                         generated map page, ignores itself (not part of this standard)
```

### 2.3 Project id

**PS-2.4** The project id is made from a name by this function (`toId`): insert `-` between a lower-case letter or digit and a following upper-case letter; lower-case everything; replace every run of characters outside `a-z0-9` with `-`; trim `-` from both ends; if nothing is left use `unnamed`. The name is the `name` field of the scan target's `package.json` if it is a string, else the base name of the target folder.

**PS-2.5** A writer that creates `.c4pm/` SHOULD create `.c4pm/.gitignore` with this exact content, and MUST NOT overwrite an existing one:

```
# c4pm regenerable data (rebuilt from the code and from git). Plan, config and layout stay committed.
projects/*/data/
projects/*/history/
```

A reader of a plan does not need the project id: it MAY be given the plan folder directly.

### 2.4 Which `.c4` files form the plan

**PS-2.6** Candidate plan folders are tried in this order. The first candidate that exists and holds at least one `.c4` file is the plan folder. Folders are never merged.

1. `architectureDir` from the settings, resolved against the scan target (only if set).
2. `<anchor>/.c4pm/projects/<id>/plan/` (only if there is an anchor).
3. `<target>/c4/` (older layout).

**PS-2.7** If no candidate qualifies, the plan is every `.c4` file found by walking the whole scan target.

**PS-2.8** A `.c4` file is a regular file whose extension is exactly `.c4` (case-sensitive). The walk is recursive and the result is sorted by path. The walk skips: symbolic links; folders named `node_modules`, `dist`, `build`, `out`, `coverage`, `venv`, `__pycache__`, `target`, `vendor`; every folder whose name starts with `.`; the export folder `C4PM` at an anchor; and anything matched by the `ignore` patterns of the settings. The folder where the walk starts is never skipped.

**PS-2.9** The files of the plan are read in sorted path order, as UTF-8 text. The elements of the whole plan are then sorted by fqn (`localeCompare`). A file that cannot be read gives a parse issue with line 0 and the message `read failed: ...`; the other files are still read.

**PS-2.10** File names carry no meaning. A reader MUST NOT depend on a file name.

### 2.5 Wireframe files

**PS-2.11** Wireframe files (since 1.7, optional). The wireframe of a `screen` is the file `<plan folder>/io/<screen fqn>.html`, where the plan folder is the one chosen by PS-2.6. A plan found by PS-2.7 has no plan folder, so it has no wireframes. Wireframe files and the stylesheets in `io/` are not plan files: PS-2.8 still reads only `.c4` files, so a `.c4` file inside `io/` is part of the plan. A reader of the plan MAY ignore wireframes. The rules on them are in PS-6.4 and PS-6.4a.

**PS-2.12** A wireframe file is an HTML fragment (no `<html>`, `<head>` or `<body>`). It says where each region and control of its screen sits; the plan stays the source of what exists.

- `data-c4="<ref>"` links an element to a part of this screen. `<ref>` is the part's id, or the dotted path from the screen (it MUST be the path when the id is used twice under the screen). Only parts of this screen count; titles are never used. Regions and controls are placed; a ref to a state is allowed and not required.
- `hidden` on an element means it is shown only sometimes (a popup, a drawer).
- A wireframe SHOULD carry only classes. Sizes and positions SHOULD live in one stylesheet inside `io/` that every wireframe links with `<link rel="stylesheet" href="<path>">`, a relative `.css` path that stays inside `io/` (the reference tool: `io/site.css`). Colours do not belong in a wireframe file: a map draws wireframes with its own colours.
- The reference tool reads only regular files (no symbolic links) of at most 512 KB, keeps only layout CSS properties (the list `WIREFRAME_CSS`, printed in its guide `c4pm guide c4`) and lays a screen out at its device size (`web` 1280 x 800, `phone` 390 x 844) or at its `viewport` (PS-4.3).

---

## 3. The `.c4` text format

### 3.1 Lexical rules

**PS-3.1** Whitespace is space, tab, carriage return and line feed. A byte order mark is not whitespace: a file that starts with one gives a parse issue `unexpected word` on line 1.

**PS-3.2** Comments:

- `//` starts a comment that ends at the end of the line.
- `/*` starts a comment that ends at the next `*/`. If there is no `*/` the comment runs to the end of the file, without an issue.
- `#` does not start a comment.

A comment is recognised only where a token could start. Inside a bare word (for example a link) `//` is part of the word.

**PS-3.3** Tokens are:

| Token | Form |
|---|---|
| `string` | Between single quotes or between double quotes. PS-3.5. |
| `lbrace`, `rbrace` | `{` and `}` |
| `equals` | `=` |
| `arrow` | `->` (when `-` is followed by `>` where a token starts) |
| `ident` | `[A-Za-z_][A-Za-z0-9_-]*` followed by zero or more groups `.` plus the same pattern. Only if the next character is the end of the file, whitespace, `{`, `}`, `=`, `"` or `'`. |
| `word` | Any other run of characters that are not whitespace, `{` or `}`. |

**PS-3.4** Because of PS-3.3, `a->b` and `shop.api->shop.db` are each one `word`, not three tokens. A writer MUST put whitespace on both sides of `->`. The corpus file `invalid/06-arrow-without-spaces.c4` shows the result.

**PS-3.5** Strings.

- The quote that opens a string closes it.
- `\` followed by the same quote character gives that character. `\\` gives one backslash. A backslash before any other character stays as a backslash, so `\n` is two characters.
- A string may contain line breaks.
- If the closing quote is missing, the string runs to the end of the file. The parser records the issue `unterminated string` at the line where the string started and keeps the text up to the first line break as the value. Everything after that point is lost to the reader.

A writer SHOULD quote with `'`. Inside a string a writer MUST escape the quote character it used and the backslash (`\'` and `\\` for `'`). The reference implementation does exactly this. A writer SHOULD NOT write line breaks inside a value.

### 3.2 File structure

**PS-3.6** A file is a sequence of top-level blocks. Each starts with an `ident`:

| Keyword | Meaning |
|---|---|
| `model` | `model { ... }` holds elements, relations and `extend` blocks. A file may have several. |
| `extend` | `extend <fqn> { ... }` outside a `model` block. Same meaning as inside. PS-3.23. |
| `specification` | `specification { ... }`. Skipped up to the matching `}`. Nothing inside is read. |
| `views` | `views { ... }`. Skipped in the same way. |

Any other `ident` gives the parse issue `unexpected keyword`. A token that is not an `ident` gives `unexpected <token type>`, for example `unexpected rbrace` or `unexpected word`. After either issue the reader skips the rest of the line (all tokens on the same line).

### 3.3 Elements

**PS-3.7** An element is written

```
<id> = <kind> '<title>' ['<description>'] [ { <body> } ]
```

`kind` is an `ident`. `title` is required. If there is no string after the kind the reader gives `expected title` and skips the line; no element is created. A second string is the description. A third string gives `unexpected string`.

**PS-3.8** An element is created even if its body is wrong. If a `{` is opened and the matching `}` is missing, the issue is `expected }`.

**PS-3.9** Position. Each element records the file, the line of its id (`line`) and the line of its closing brace (`endLine`). Without a body `endLine` is the line of the last token read for the element.

### 3.4 Kinds

**PS-3.10** The parser accepts any `ident` as a kind, case-sensitive. It stores unknown kinds without an issue. These kinds have a meaning in the reference implementation (`kinds.ts`):

| Kind | Family | Tree level | Needs code when `done` or `in-progress` | Notes |
|---|---|---|---|---|
| `system` | architecture | c1 | yes | The whole product. |
| `container` | architecture | c2 | yes | An app, service, worker or database. |
| `subregion` | architecture | c3 | no | A named group of components inside a container; a project may order its subregions top to bottom and use them as layers. Child of a `container`. Holds components. Claims nothing (PS-5.7). Old name until 1.8: `layer` (PS-3.11e). |
| `component` | architecture | c3 | yes | A part of a container. Child of a `container` or of a `subregion`. Only components make claims (PS-5.7). |
| `person` | architecture | none | no | A human actor, outside the system. |
| `external` | architecture | none | no | An outside system, outside the system boundary. |
| `screen` | front-end | none | no | A screen of a user interface. |
| `region` | front-end | none | no | A part of a screen. |
| `control` | front-end | none | no | A button, field or other control. |
| `state` | front-end | none | no | A state of a screen or control. |
| `flow` | front-end | none | no | A sequence of steps over screens. |
| `journey` | front-end | none | no | A path of one kind of user over flows. |
| `command` | front-end | none | yes | A command of a command line tool. Child of a `container` or of a `command` (subcommand). |
| `options` | front-end | none | no | A group of options of a `command`. |
| `flag` | front-end | none | no | An option of a `command`, such as `--json`. Child of a `command` or of an `options`. |
| `arg` | front-end | none | no | A positional argument of a `command`. |
| `route` | front-end | none | yes | A route of an HTTP API, such as `GET /orders/:id`. Child of a `container`. |
| `body` | front-end | none | no | The request body of a `route`. |
| `param` | front-end | none | no | A parameter or a field. Child of a `route`, a `body` or a `tool`. |
| `tool` | front-end | none | yes | A tool of an MCP server. Child of a `container`. |
| `store` | storage | none | no | A place that keeps data: a database, a file, a folder, a bucket. Child of a `container`. |
| `record` | storage | none | no | A table, collection, row or file inside a store. Child of a `store`. |
| `field` | storage | none | no | A column, key or field of a record. Child of a `record` or of another `field` (nested data). |
| `function`, `class`, `method`, `type` | planned code | none | see PS-6.4 | Code that is planned. Nested under a component (PS-3.13, PS-5.13). |

**PS-3.11** The twenty-three kinds `system` to `field` in the table are the "element kinds". Tools give a `uid` to element kinds only (PS-4.7). The four planned code kinds are a separate list (`function`, `class`, `method`, `type`). A `test` block (PS-3.11d) is not a kind and not an element: it gets no `uid`, no fqn and no tree level.

**PS-3.11a** The storage kinds nest as `container` > `store` > `record` > `field`. A `record` sits only under a `store`. A `field` sits under a `record` or under a `field`. The element's `technology` line names the kind of store (`postgres`, `mongodb`, `json`, ...). Tools choose the display word (table, collection, file, ...) from it. The parser does not enforce this nesting; the `plan add` command does.

**PS-3.11b** The CLI, API and MCP kinds (since 1.2) nest as `container` > `command` > (`options` >) `flag`, `arg`; `container` > `route` > `param`, `body` > `param`; `container` > `tool` > `param`. `command`, `route` and `tool` need code when `done` or `in-progress` (PS-3.10); their parts do not. The parser does not enforce this nesting; the `plan add` command does. The metadata keys `in`, `type`, `required` of a `param` and `method` of a `route` are not checked.

**PS-3.11c** The subregion kind (since 1.3, named `layer` until 1.8) nests as `container` > `subregion` > `component`. The fqn of a component in a subregion is `<container fqn>.<subregion id>.<component id>`; the subregion is one more segment (PS-3.13). The order of the subregions of a container is the order of their declaration (plan file order, then line); the first is the top, so a project can use its subregions as layers. A component in a subregion and a component directly in the same container may coexist. The parser does not enforce this nesting; the rule `subregion-misplaced` (PS-6.3) and the `plan add` command do. A subregion that every other subregion of its container may use directly carries the metadata key `shared 'true'` (PS-4.3, since 1.6).

**PS-3.11d** Test blocks (since 1.5). A `test` block is an accessory of the element whose body holds it: a test of that element. It has no `uid`, no fqn, no box on a map and no board link. Syntax (Appendix A): `test '<name>'`, then optionally `{ }` holding at most one `case '<id>'`. Without `case` it is a test to write; with `case` it is a hand link, where `<id>` is a test case id (`<file>#<describe> › <name>`, the file repo-relative) or a test file (a helper; the link then covers every test case that uses it). The word `test` starts a block only when a string follows it, so `test = component 'T'` is still an element. Its parent SHOULD be a `container`, `component`, `function` or `method`; the `plan add test` command refuses any other. One element may hold several blocks; names SHOULD be unique per element. A writer MUST write a block on one line (`test 'n' {}`, `test 'n' { case 'f#a › b' }`): a reader of version 1.4 or older does not know the word and skips only the rest of its line (PS-3.18), so a block over several lines would close the parent element early there. A reader of 1.5 MUST accept a block over several lines.

**PS-3.11e** Old kind words (since 1.9). Readers MUST accept the kind word `layer` as `subregion` (the name until 1.8), in an element and in a `specification` block; writers MUST write `subregion`. A file that mixes both words reads as one kind. A tool MAY offer to rewrite the old words of a file (the reference implementation: `c4pm plan upgrade`); such a rewrite changes kind words only, never ids, strings or comments.

**PS-3.12** A reader MUST keep an element of an unknown kind. A checker treats an unknown kind as one that needs code.

### 3.5 Nesting, ids and fqn

**PS-3.13** An element body may hold child elements. The fqn of a child is `<parent fqn>.<id>`. A top-level element's fqn is its id. Example: the component `cli` in the subregion `entry` of the container `app` of the system `shop` has the fqn `shop.app.entry.cli`.

**PS-3.14** An id SHOULD match `[A-Za-z_][A-Za-z0-9_-]*`. The lexer also accepts an id with dots (`a.b = system 'X'` creates the element with fqn `a.b`); a writer MUST NOT produce one, because `.` separates the parts of an fqn.

**PS-3.15** Ids are case-sensitive. Ids SHOULD be unique among siblings. Two elements with the same fqn are both kept and give the finding `duplicate-fqn`.

**PS-3.16** An id MUST NOT be one of the words that have a meaning at its place, because the parser reads them first:

- In a `model` block or an `extend` block: `specification`, `views`, `extend`.
- In an element body: `technology`, `description`, `title`, `link`, `metadata`, `specification`, `views`, `extend`; and `test` when a string follows it (PS-3.11d).

### 3.6 Body statements

**PS-3.17** Inside an element body these statements are allowed, in any order and any number:

| Statement | Effect |
|---|---|
| `technology '<text>'` | Sets `technology`. The last one wins. |
| `description '<text>'` | Sets `description`. Replaces the second string of the head. |
| `title '<text>'` | Replaces the title. |
| `link <target> ['<title>']` | Adds a link. Chapter 5. |
| `metadata { <key> '<value>' ... }` | Sets metadata. Chapter 4. May appear several times; keys merge. |
| `<id> = <kind> '<title>' ...` | A child element. |
| `-> <fqn> ['<label>'] [{ ... }]` | A relation from this element. |
| `<fqn> -> <fqn> ['<label>'] [{ ... }]` | A relation with the source named. |
| `extend <fqn> { ... }` | See PS-3.23. |
| `test '<name>' [{ [case '<id>'] }]` | A test block (PS-3.11d). |
| `specification { ... }`, `views { ... }` | Skipped. |

A keyword (`technology`, `description`, `title`, `link`) without a string value gives `expected value` and the rest of the line is skipped.

**PS-3.18** An `ident` in a body or model block that is followed by neither `=` nor `->`: if the next token is on the same line, the reader skips the rest of that line with no issue (tolerant reading, PS-9.4). If nothing follows the `ident` on its line, the reader reports `stray word '<id>': expected = or -> after it` on that line and goes on with the next line, so the element or `}` there is read as written (since 1.8; before, that whole next line was skipped without any issue). A token that is not an `ident` (and is not `->` in a body) gives `unexpected <token type>`. Writers MUST NOT leave stray words in a block.

**PS-3.19** After `=` a reader expects an `ident` (the kind). Otherwise the issue is `expected kind` and the line is skipped.

### 3.7 Relations

**PS-3.20** A relation has a source, a target and an optional label. The parser stores `from` and `to` exactly as written. It does not add prefixes, not even inside `extend`, and it does not check that the target exists.

**PS-3.21** A writer MUST write full fqns for both ends. The short form `-> target` inside a body takes the enclosing element's fqn as source.

**PS-3.22** After the label a relation may have a `{ ... }` block. It is skipped. A relation whose target is not an `ident` gives `expected target`.

### 3.8 `extend`

**PS-3.23** `extend <fqn> { ... }` adds elements and relations as if they were written inside the element `<fqn>`. The `fqn` is used as written and does not have to exist. `extend` may appear at the top level of a file, inside `model`, inside another `extend`, and inside an element body. Inside an element body the target is not prefixed by the enclosing element; write the full fqn.

**PS-3.24** The parent of a child created by `extend X` is `X`. A missing fqn after `extend` gives `expected fqn`.

### 3.9 Parse issues

**PS-3.25** The messages a reader produces, with the cause:

| Message | Cause |
|---|---|
| `unterminated string` | A quote was never closed (PS-3.5). |
| `unexpected <token type>` | A token where none can start. Types: `word`, `string`, `rbrace`, `lbrace`, `arrow`, `equals`, `eof`. |
| `unexpected keyword` | A top-level `ident` that is not `model`, `extend`, `specification`, `views`. |
| `expected title` | An element head without a string. |
| `expected kind` | Nothing usable after `=`. |
| `expected target` | Nothing usable after `->`. |
| `expected fqn` | Nothing usable after `extend`. |
| `stray word '<id>': expected = or -> after it` | An `ident` alone at the end of its line in a body or model block (PS-3.18). |
| `expected value` | A body keyword without its string, or a `link` without a target. |
| `expected }` | A block that is not closed. |
| `metadata value must be quoted (key <key>)` | PS-4.1. |
| `test block takes one case` | A second `case` in a `test` block (the first is kept). |
| `unexpected <token> in test block` | Anything but `case '<id>'` inside a `test` block (skipped up to its `}`). |
| `read failed: <reason>` | The file could not be read. Line 0. |

An issue has `file` (repo-relative path), `line` (1-based) and `message`. A reader MUST report issues and MUST continue after them: the elements read so far are kept.

---

## 4. Metadata keys

### 4.1 Syntax

**PS-4.1** `metadata { key 'value' key2 'value2' }`. A key is an `ident` (a key with a dot is accepted). A value MUST be a quoted string. A key followed by anything else gives the issue `metadata value must be quoted (key <key>)` and the rest of that line is skipped. A line in the block that does not start with an `ident` is skipped without an issue. A key written twice keeps the last value. A missing `}` gives `expected }`.

**PS-4.2** All values are strings. A reader MUST NOT convert them.

### 4.2 Keys

**PS-4.3** The keys the reference implementation reads:

| Key | Meaning | Allowed values | Checked by |
|---|---|---|---|
| `uid` | Stable identity of the element. | A lower-case UUID, any version: `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` | `invalid-metadata`, `duplicate-uid` |
| `layout` | Saved box position on the map. | `bx,by;rx,ry,rw,rh` or `;rx,ry,rw,rh`. Integers (all but `rw` and `rh` may be negative); `rw` and `rh` above 0. Spaces around numbers are allowed. | not checked; a bad value is ignored by the map |
| `status` | Progress. | `planned`, `in-progress`, `done`, `abandoned` | `invalid-metadata` and many rules |
| `owner` | Who is responsible. | Any text. `done` needs a non-blank owner. | `invalid-metadata` |
| `sprint` | Planned period. | `S` and digits, as in `S15` (`^S\d+$`) | `invalid-metadata`, `late` |
| `priority` | Importance. | `high`, `medium`, `low` | `invalid-metadata` |
| `tags` | Search words. | Comma separated. Each tag after trimming: `^[a-z0-9][a-z0-9-]*$`. Empty entries are dropped. | `invalid-metadata` |
| `signature` | Signature of planned code. | Any text | `missing-signature` |
| `purpose` | What planned code is for. | Any text | not checked |
| `shared` | On a `subregion` only (since 1.6): a shared subregion, one that every other subregion of its container may use directly. A map MAY draw it beside the other subregions instead of in their stack. | `true`, on a `subregion` | `invalid-metadata` |
| `device` | On a `screen`: its shape, and the size its wireframe (PS-2.12) is laid out at. Without it, a tool decides from the names. | `web`, `phone`; another value is ignored | not checked |
| `design` | On a `screen`: where its design (a picture, a Figma page) lives. | Any text, such as a URL or a repo path | not checked |
| `viewport` | On a `screen` (since 1.7): the size its wireframe is laid out at, instead of the device size. A bad value is ignored by the map, which uses the device size. | `<W>x<H>`: whole numbers, each 10 to 99999, checked as numbers (`1440x900`) | `invalid-metadata` |
| `shape` | On a `person` (since 1.11), optional: how a map draws its head. `person` (the default when the key is missing): a round head; `robot`: a square head, for an AI agent or another program that acts like a user. Another value is drawn as `person`. | `person`, `robot`, on a `person` | `invalid-metadata` |
| `role` | On a `component` (since 1.12), optional: what the component is to the rest of the plan. `foundation`: a component nearly every other component uses (shared types, helpers). A map MAY draw it apart and MAY hide the arrows into it until it is pointed at. Another value is ignored by a map. | `foundation`, on a `component` | `invalid-metadata` |

**PS-4.3a** Storage keys (since 1.1). They describe the shape of stored data. Values are quoted text. They are not checked in 1.1: a bad value is kept and ignored.

| On | Key | Meaning | Value |
|---|---|---|---|
| `field` | `type` | Data type. | Any text, such as `uuid` or `varchar(100)`. |
| `field` | `pk` | The field is (part of) the primary key. | `true` |
| `field` | `nullable` | Null is allowed. | `true` or `false` |
| `field` | `unique` | Values are unique. | `true` |
| `field` | `default` | Default value. | Any text |
| `field` | `values` | Allowed values. | Comma separated list |
| `field` | `fk` | Foreign key. | `<record>.<field>` |
| `field` | `onDelete` | What a delete does to the referring rows. | Any text, such as `cascade` |
| `record` | `pk` | Composite primary key. | `col1,col2` |
| `record` | `index.<name>` | One index. | `[unique ]col1,col2[ where <expr>]` |
| `record` | `check.<name>` | One check constraint. | An SQL expression |

The key `index.<name>` has a dot in it. A reader and a writer MUST keep it unchanged (PS-4.4).

**PS-4.4** Other keys are allowed. A reader MUST keep them. A writer MUST NOT remove keys it does not know.

**PS-4.5** A missing key is never a finding by itself, except as stated in chapter 6 (`done` without `owner`, planned function without `signature`).

### 4.3 Keys owned by tools

**PS-4.6** `uid` and `layout` are owned by tools. A person SHOULD NOT edit them by hand. A writer that edits an element MUST NOT change or delete an existing `uid` or `layout` line. The safe-edit gate (PS-7.3) refuses an edit that does so.

**PS-4.7** A uid is given once and then never changes, also when the element is renamed or moved. Tools mint uids for element kinds (PS-3.11) that have none. Planned code kinds get none. A new uid MUST be unique in the plan. Board items refer to elements by uid (PS-8.7).

**PS-4.8** `layout` is written by a layout tool from positions a person exported from the map page. Its numbers are in map units relative to the parent box.

---

## 5. Links to code

### 5.1 Syntax

**PS-5.1** `link <target> ['<title>']`. The target is a bare `ident` or `word`, or a quoted string (needed when the path has spaces). An optional string after the target is the title of the link. A link with no usable target gives `expected value`.

### 5.2 Forms of a target

**PS-5.2** The parts of a target:

| Form | Example | Result |
|---|---|---|
| URL | `https://example.com/a#b` | Target matches `^[a-z][a-z0-9+.-]*://`. Stored as written. No name, no lines. It matches no file, so it claims no code. |
| File | `./src/orders.ts` | A path to a file. |
| Folder | `./src/models/` | A path with a trailing `/`. The slash is kept. |
| Function or name | `./src/orders.ts#makeOrder`, `...#OrderService.create` | `#` and a name. The name is the text after the first `#`. |
| Line range | `./src/orders.ts#L10-L20`, `#L7` | The text after `#` matches `^L(\d+)(?:-L(\d+))?$`. One line `L7` means start 7, end 7. |

**PS-5.3** The fragment is the text after the first `#`. If it matches the line range pattern it is a line range, otherwise it is a name. A name for a method is `Class.method`.

**PS-5.4** A link keeps its original text (`raw`) and the resolved `path`.

### 5.3 Relative paths

**PS-5.5** A path is relative to the folder that contains the `.c4` file, not to the repository root. The rule: if the target starts with `./` or `../`, or does not start with `/` and does not contain `:`, then it is joined to the folder of the `.c4` file (a repo-relative path with `/` separators) and normalised. A target that starts with `/` or contains `:` is kept as written.

**PS-5.6** If the plan folder is outside the scan target, a resolved path may start with `../`. A reader that works against a repository root SHOULD fold such a path to a repo-relative path when it lands inside the root, and keep a trailing `/` (the reference implementation does).

Example: in `<anchor>/.c4pm/projects/shop/plan/a.c4`, `link ../../../../src/api/` resolves to `src/api/` when the anchor is the repository root. Four `..` climb out of `plan`, `shop`, `projects`, `.c4pm`.

### 5.4 Which links claim code

**PS-5.7** Only links of elements of kind `component` are claims. Links on other kinds (for example `subregion`) are kept and resolved, but they claim nothing.

**PS-5.8** The kind of a claim is taken from the link's resolved path and name, in this order:

1. the path ends with `/`: folder claim (rank 1);
2. the link has a name: function claim (rank 3);
3. otherwise: file claim (rank 2). A line range link is a file claim of the whole file.

**PS-5.9** A claim matches code as follows. Folder: the file path starts with the claim path (the claim path ends with `/`). File: the paths are equal. Function: same file and same function name.

### 5.5 Claim mode and folder mode

**PS-5.10** The mode belongs to the whole plan, not to a file or an element. The plan is in claim mode if at least one claim is a function claim. Otherwise it is in folder mode. A tool decides by this test only. Plain file and folder links never make a plan claim mode.

**PS-5.11** In claim mode, ownership is decided per function. Every claim that matches a function competes. The claim with the higher rank wins (function 3, file 2, folder 1); one element with several matching claims counts with its best one. When elements tie on rank, the element that comes first in plan order wins; plan order is the elements sorted by fqn. A function that no claim matches is "shared" if some file owned by a component imports its file, otherwise "unassigned".

**PS-5.12** The mode decides which rules apply in section 6: `component-claim-conflict`, `split-file`, `shared-auto` and `unassigned-code` only in claim mode; `unplanned-code` and `plan-unmatched` only in folder mode.

### 5.6 Planned code

**PS-5.13** An element of kind `function`, `class`, `method` or `type` plans code that may not exist yet. Its name is its title. Its code link is its first link that has a name. Its `parentComponent` is the fqn of the nearest ancestor that is not one of these four kinds. A link on planned code claims nothing (PS-5.7). The `case` of a test block (PS-3.11d) is not a link: it claims nothing and names a test, not code.

---

## 6. Plan checks

### 6.1 Findings

**PS-6.1** A finding has four fields: `severity` (`critical`, `warning` or `info`), `rule`, `id` (an element fqn, a file path or a source path, depending on the rule) and `message`. A list of findings is sorted by severity (critical, warning, info), then by rule name, then by id.

**PS-6.2** A checker MUST use the rule names and severities given under PS-6.3 and PS-6.4 for the conditions listed there. Text in `message` is for people: a consumer MUST NOT parse it. The messages in the corpus are examples.

### 6.2 Rules that need only the plan

**PS-6.3** These rules need only the parsed plan.

| Rule | Severity | Condition |
|---|---|---|
| `parse-error` | warning | One per parse issue (PS-3.25). `id` is the file; `message` is `<file>:<line> <issue>`. |
| `invalid-metadata` | warning | `status` not in the list; `priority` not in the list; `sprint` not `S<digits>`; `status` is `done` and `owner` missing or blank; `uid` present and not a UUID; a tag that does not match the tag pattern; `shared` on an element that is not a `subregion`, or with a value other than `true` (since 1.6); `viewport` present and not `<W>x<H>` with whole numbers 10 to 99999 (since 1.7); `shape` on an element that is not a `person`, or with a value other than `person` or `robot` (since 1.11); `role` on an element that is not a `component`, or with a value other than `foundation` (since 1.12). One finding per problem. Elements with no metadata are skipped. |
| `duplicate-uid` | warning | The same `uid` is on two or more elements. One finding per uid; `id` is the first fqn in sorted order. |
| `duplicate-fqn` | warning | Two or more elements have the same fqn. One finding per fqn. |
| `subregion-misplaced` | warning | A `subregion` whose parent is not a `container` (also a subregion at the top level or in a subregion), or a `subregion` with a link. One finding per problem; `id` is the subregion's fqn. Named `layer-misplaced` before 1.9: a checker MUST emit the new name; an acknowledgement written with the old name still matches. |

### 6.3 Rules that also need the code

**PS-6.4** These rules need a scan of the code (files, functions, imports). Let `status` be the element's `status` and a link "exists" when its path exists in the repository.

| Rule | Severity | Condition |
|---|---|---|
| `missing-code` | critical | `status` is `done` or `in-progress`, and the element has links but none exists. Also: no links, the kind needs code (PS-3.10), and it is not planned code. |
| `missing-code` | warning | Planned code, `done` or `in-progress`, no link, and no function with its name in the files claimed by its parent component. |
| `broken-function` | warning | A function link (a name) whose file exists but has no such function. Skipped for planned code with status `planned`, and for a `type` linked to a file type that has no type index. |
| `broken-claim-link` | warning | A folder link whose folder exists but contains no scanned source file. |
| `folder-link-no-slash` | warning | A link to an existing folder written without the trailing `/`: it resolves but claims no files (PS-5.8). |
| `stub-in-done` | warning | `status` is `done` and a claimed file has an unimplemented function (planned code: the named function). |
| `abandoned-but-present` | warning | `status` is `abandoned` and a linked path still exists. |
| `late` | warning | The caller gave a current sprint; `status` is `planned` or `in-progress`; `sprint` is below it. |
| `code-parse-error` | warning | A scanned source file did not parse cleanly. `id` is the file. |
| `planned-but-built` | info | `status` is `planned`, a link exists, not planned code. Also a `record` with `status` `planned` that a record in the code matches; the message gives its file and line. |
| `planned-not-built` | info | Planned code, `status` `planned` or `in-progress`, and no link resolves to code. Also a test block without `case` (PS-3.11d) that no detected test case matches: the case name equals the block name (trimmed, case-sensitive), or the last part of the case name (after the last ` › `) equals it and no other test case of the repository has that last part. `id` is the parent's fqn; one finding per block. |
| `test-link-dead` | warning | A test block with `case` (PS-3.11d) whose value is neither a detected test case id nor a test file of the repository (renamed or deleted since, or no test code at all): the hand link attaches nothing. `id` is the parent's fqn; one finding per block. |
| `planned-built-update-status` | info | Planned code, `status` `planned`, a link resolves, and the code is not a stub. |
| `missing-signature` | info | A planned `function` or `method` with status `planned` and no `signature`. |
| `line-link` | info | A link uses a line range. One finding per such link. |
| `component-claim-conflict` | warning | Claim mode. Two elements claim the same function or file; names the winner and the loser. Reason is `specificity` or `plan-order`. |
| `split-file` | info | Claim mode. The functions of one file are owned by two or more elements. |
| `shared-auto` | info | Claim mode. An unclaimed function whose file is imported by a claimed file. |
| `unassigned-code` | critical | Claim mode. No claim matches a function and nothing imports its file. |
| `plan-unmatched` | info | Folder mode, and the plan has at least one component. Plan components (with a link, or `done` or `in-progress`) that match no scanned node. One finding for all. |
| `unplanned-code` | critical | Folder mode, and the plan has at least one component. A source file that no link claims. |
| `no-tests` | info | Only when the caller asks for it (reference tool: config `tests.noTests`). A component on the map with no test case attached to it or below it and no test block on it or below it. |
| `wireframe-missing` | info | The plan folder has an `io/` folder and a `screen` has no file `io/<screen fqn>.html` ("no wireframe"). Also a file that exists but cannot be used (a symbolic link, larger than 512 KB, unreadable), and every screen when `io/` is not a plain folder; the message gives the reason. `id` is the screen fqn. |
| `wireframe-out-of-date` | warning | A region or control of the screen has no `data-c4` in its wireframe, or a `data-c4` names nothing under the screen, or names two or more parts ("wireframe out of date"). One finding per problem; `id` is the screen fqn. |
| `wireframe-orphan` | warning | A file `io/<name>.html` where `<name>` is the fqn of no screen. `id` is the file. |
| `wireframe-bad-stylesheet` | warning | A `<link>` in a wireframe that is not `rel="stylesheet"` with a relative `.css` path inside `io/`, or whose file does not exist. The link is dropped. One finding per link; `id` is the file. |
| `wireframe-inline-style` | info | A wireframe file with `style` attributes or `<style>` blocks outside comments. `id` is the file. |
| `missing-store` | by status | The plan has a `store`, and the store has no code files: no reader serves its technology, or its reader finds no files. The message gives the reason; its records get no `missing-record`. Severity of the storage rules marked "by status": `status` `planned` info, `in-progress` or no `status` warning, `done` critical; an `abandoned` store, record or field gets no storage finding. `id` is the store fqn. |
| `store-unreadable` | warning | A store that cannot be read: an ambiguous technology (several readers find files and the store names no `reader`), an unknown reader, a live reader, a reader limit, or a reader error. The message is the error. A reader error on the repository scan has `id` `store-scan`; else `id` is the store fqn. |
| `missing-record` | by status | A `record` of a read store that matches no record in the code. `id` is the record fqn. |
| `field-drift` | by status | A field of a matched record differs: missing (the code has it, the plan record does not list it; only when the plan record lists at least one field), extra (the plan lists it, the code has none), or a stated `type`, `nullable` or `fk` differs. One finding per difference; the message names the kind and both values. Severity by the field's `status`, else its record's. `id` is the plan field's fqn (the record's for missing). |
| `unplanned-record` | info | The plan has a `store`. A record in the code of a read store that the store does not list. `id` is `file#name`. |
| `unplanned-store` | info | The plan has a `store`. Records a reader finds that no store covers (same reader, and the store's `source`, if any, holds every file). `id` is the folder of the files, or the reader. |

**PS-6.4a** The wireframe rules (since 1.7) need the plan and the wireframe files of PS-2.11, not a scan of the code. They give no finding for a plan without a plan folder (PS-2.7). `wireframe-missing` fires only when the plan folder has an `io/` folder, so a plan that uses no wireframes gets none. Each rule gives one finding per problem: a screen with two missing parts gives two `wireframe-out-of-date` findings. The rules on a screen (`wireframe-missing`, `wireframe-out-of-date`) have the screen's fqn as `id`; the rules on a file (`wireframe-orphan`, `wireframe-bad-stylesheet`, `wireframe-inline-style`) have the file's repository path. The severities mean: a missing or unusable wireframe is not built yet (info); a wireframe that no longer matches the plan, a file that names no screen, and a dropped stylesheet link are warnings; inline style is info. The safe-edit gate (PS-7.3) does not compute these rules, so a plan edit is never refused because of a wireframe.

**PS-6.4b** The storage rules (since 1.7: `missing-store`, `store-unreadable`, `missing-record`, `field-drift`, `unplanned-record`, `unplanned-store`, and `planned-but-built` for a record) need the plan and the store code: the schema files that a reader turns into records and fields, never a live database. They give no finding for a plan without a `store`, not even `unplanned-store`. A store's reader is the one its `reader` key names; else the reader that serves its `technology`. When several readers serve it, it is the one that finds files; when more than one finds files, the store is ambiguous (`store-unreadable`). The store's `source`, when present, limits the reader to that file or folder. A plan record matches a code record by a link to `<file>#<name>` first, else by its title or local id; a plan field matches a code field by its title or local id. Each rule gives one finding per problem: a record with three differing fields gives three `field-drift` findings. A record that lists no field is checked by name only (no "missing" field). The ids are the fqn of the plan element; a record only the code has is `<file>#<name>`. "By status" is the status of the element the finding is about: `planned` info, `in-progress` or no `status` warning, `done` critical; a field with no `status` takes its record's. `unplanned-record` and `unplanned-store` are info whatever the status. An `abandoned` store, record or field gets no finding, and neither does what is under it. The safe-edit gate (PS-7.3) does not compute these rules.

**PS-6.5** Findings are not errors of the file. A plan with findings is still a valid plan. Only parse issues say the text is wrong.

---

## 7. Safe editing

**PS-7.1** These rules are for a writer that changes `.c4` files of a plan. They describe the gate of the reference implementation (`planTx.ts`).

**PS-7.2** Dry run first. A writer MUST be able to show the change as a diff without writing it, and SHOULD do that by default. It writes only when told to.

**PS-7.3** The gate. A writer MUST read the whole plan from the old texts and from the new texts (in memory) and MUST refuse the edit, writing nothing, when any of these is true:

1. the new texts have a parse issue that the old texts did not have (compared by file and message, not by line);
2. the new texts have a finding of severity `warning` or `critical` that the old texts did not have; `info` findings never refuse;
3. a line that starts with `uid` or `layout` (after optional whitespace) in an old text is missing from the new text, comparing trimmed lines and counting repeats; the lines of an element the writer moves or renames (PS-7.13) may change file, so they are counted over all the texts of the plan instead;
4. an element of the old plan is missing from the new plan (counted per fqn), unless the writer moves or renames it (PS-7.13): then it MUST be found at the new fqn of the writer's old -> new map, with the same kind and, when it has a `uid`, the same `uid`; a mapped element not found there refuses the edit;
5. a file is removed from the edit, or the edit adds a file;
6. a test block (PS-3.11d) of the old plan has no block of the same name under the same parent in the new plan (since 1.5). Exceptions: the edit removes that block on purpose (the reference tool: `plan remove <element> --test <name>`), the parent element is itself removed or moved (a moved parent is followed to its new fqn).

**PS-7.4** To decide "new" in PS-7.3, findings are compared by `rule`, `id` and `message`. For `parse-error` the `<file>:<line> ` prefix is removed first. For `invalid-metadata` the leading `<title>: ` is removed first. This way an edit that only shifts lines or renames a title does not make old problems look new. When the writer moves or renames elements (PS-7.13), the `id` and every fqn-shaped word of the `message` of each OLD finding are first mapped through the old -> new map (the longest dotted head of the word that the map holds is replaced, the rest kept), so an old finding that only moved with its element is not new.

**PS-7.5** Fast mode and full mode. In fast mode the gate compares parse issues and the findings `parse-error`, `invalid-metadata` and `duplicate-uid`. In full mode it compares all findings of chapter 6 computed against a scan of the code, except the wireframe rules (PS-6.4a) and the storage rules (PS-6.4b), both since 1.7.

**PS-7.6** Where to write. A writer MUST write only files with the extension `.c4`. By default it MUST write only inside `<anchor>/.c4pm/` or `<anchor>/C4PM/`. It MAY write elsewhere only when the person asks for it explicitly (the reference tool has `--force`). The explicit choice never allows a file that is not `.c4`. The one exception: a writer that moves or renames a screen (PS-7.13) MAY rename and edit its wireframe `<plan folder>/io/<fqn>.html` (the screen's HTML wireframe: a regular file named by the screen's fqn, directly in that folder); PS-7.7 and PS-7.8 cover these files too. A writer that starts a wireframe (since 1.7, optional; the reference tool's `plan wireframe`) MAY create one new wireframe file `<plan folder>/io/<fqn>.html` of a screen that has none, and the `io/` folder when it is missing. It MUST NOT overwrite an existing file and writes no `.c4` file; PS-7.8 covers it too: when the check after the write fails, it removes the new file and the `io/` folder it made.

**PS-7.7** Check before write. Before writing, a writer MUST read each target file again and refuse if it no longer equals the text the edit started from.

**PS-7.8** Check after write. After writing, a writer MUST read the plan again from disk. If the check of the command fails, it MUST restore every old text. If the restore itself fails, it MUST say which files could not be restored.

**PS-7.9** Minimal change. A writer SHOULD change only the lines it means to change and keep every other byte, including comments, spacing, `uid` and `layout` lines.

**PS-7.10** Values. A writer MUST quote every metadata value and every title (PS-3.5). The reference implementation refuses empty values, values with line breaks, a `status` not in the list, a `priority` not in the list, a `sprint` not like `S15`, a `shape` not in the list (since 1.11), a `role` not in the list (since 1.12), and `status` `done` without an owner. A writer MAY remove a metadata key the user names (the reference implementation: `plan set --unset <key>`, since 1.12), never `uid` or `layout` (PS-4.6).

**PS-7.11** A writer MUST NOT edit source code files to make the plan pass.

**PS-7.12** Board writes follow the same ideas. See PS-8.9.

**PS-7.13** Move and rename (since 1.4, optional for a writer). A writer that moves an element to a new parent or gives it a new id MUST:

1. build an old -> new fqn map of each moved or renamed element and of every element inside it (prefix rule: `<old>.<rest>` becomes `<new>.<rest>`);
2. move the element's block whole (from its declaration line to its closing brace, with every child, `uid` and `layout` line), or, for a rename, change only the id token of the declaration;
3. rewrite, in every `.c4` file of the plan, every relation end (PS-3.20) and every `extend` target (PS-3.23) that the map names, and nothing else: text in strings and comments is never rewritten;
4. refuse the whole edit, writing nothing and listing every problem, when the new parent's kind is not a parent kind of the element (PS-3.10, PS-3.11a to PS-3.11c), when an element would move into itself or its descendant, or when a new fqn is already taken;
5. check the result with the gate of PS-7.3, using the map (PS-7.3 items 3 and 4, PS-7.4).

A writer SHOULD list, without editing them, the places outside the rewritten references that still name an old fqn (comments, strings, docs, the board). The reference implementation (`c4pm plan move`, `c4pm plan rename`) puts a moved block at the end of the new parent's body, leaves comment lines above the block where they were, and refuses to move a block with relative links (PS-5.5) to a `.c4` file in another folder.

---

## 8. The board file

### 8.1 Location and encoding

**PS-8.1** The board is the file `<anchor>/.c4pm/projects/<id>/board/board.json`. It is UTF-8 JSON. It is committed. A repository without the file has no board.

**PS-8.2** A writer SHOULD write it with 2-space indentation and a final line feed. Boards and groups keep their order. Items are sorted: ids of the form `b<number>` first by number (`b9` before `b10`), then other ids by plain string comparison. Keys of an item are written in the order of the table in PS-8.4.

### 8.2 File, board and group

```json
{
  "schemaVersion": 1,
  "boards": [
    {
      "id": "roadmap",
      "name": "Roadmap",
      "archived": true,
      "groups": [ { "id": "later", "name": "Later" }, { "id": "doing", "name": "Doing", "status": "in-progress" } ],
      "items": [ ]
    }
  ]
}
```

**PS-8.3** Fields.

| Object | Field | Type | Rule |
|---|---|---|---|
| file | `schemaVersion` | number | MUST be `1`. |
| file | `boards` | array | Required. |
| board | `id` | string | Required, matches `^[A-Za-z_][A-Za-z0-9_-]*$`, unique in the file. |
| board | `name` | string | Required, not empty. |
| board | `archived` | boolean | Optional. Only `true` is stored. |
| board | `groups` | array | Optional. When absent the board has three groups with ids `planned`, `in-progress`, `done`. |
| board | `items` | array | Items of the board. |
| group | `id` | string | Required, same pattern as a board id, unique in the board. |
| group | `name` | string | Required, not empty. |
| group | `status` | string | Optional. A status (PS-8.5). Absent means a custom group. |

### 8.3 Item

**PS-8.4** Fields of an item. Strings are trimmed when read, except `description` and `outcome`, which are kept as written.

| Field | Type | Rule |
|---|---|---|
| `id` | string | Required. Same pattern as a board id. Unique across the whole file, not only the board. Never reused. The reference tool makes `b<number>`. |
| `title` | string | Required, not empty. |
| `kind` | string | One of `task`, `feature`, `issue`, `bug`, `decision`, `question`. Another value is kept as written and the checker warns. |
| `status` | string | One of `planned`, `in-progress`, `done`, `abandoned`. Same handling. |
| `owner` | string | Optional. |
| `parent` | string | Optional. Id of an item in the same board. |
| `dependsOn` | array of string | Ids of items that must finish first. Written even if empty. |
| `links` | array of string | `uid` values of plan elements. Written even if empty. |
| `tags` | array of string | Each tag matches the tag pattern of PS-4.3. Written even if empty. |
| `sprint` | string | Optional, like `S15`. |
| `priority` | string | Optional, `high`, `medium`, `low`. |
| `start`, `due`, `created`, `updated`, `closed` | string | Optional, `YYYY-MM-DD`, a real calendar day. |
| `group` | string | Optional. Id of a group of the board. |
| `description` | string | Optional. At most 8000 characters. |
| `docs` | array | Optional. Entries `{ "label"?, "path"?, "url"? }`. Each entry has exactly one of `path` or `url`. |
| `outcome` | string | Optional. How it ended. At most 2000 characters. |
| `size` | string | Optional. One of `S`, `M`, `L`, `XL`. |

The kinds of an item are only the six listed. There are no other kinds in version 1.

**PS-8.5** Statuses of items are the same four words as plan statuses (PS-4.3).

**PS-8.6** A `path` in `docs` MUST be relative to the repository: not starting with `/`, `~` or a drive letter, no backslash, no `..` part, not empty. A `url` MUST be `http` or `https`.

**PS-8.7** `links` hold uids. A link is "dead" when no plan element has that uid. Any element kind of 3.11 can be linked.

### 8.4 Board rules

**PS-8.8** Rules of the board check. `id` is the item id, the board id for board rules, or `board.json` for file rules.

| Rule | Severity | Condition |
|---|---|---|
| `board-parse` | warning | A structure problem of the file (one per parse issue, and one per tolerated unknown item key). |
| `board-dead-link` | warning | A uid in `links` matches no plan element. |
| `board-links-unchecked` | info | No plan loaded and there are links. |
| `board-unknown-parent` | warning | `parent` is not an item of the same board. |
| `board-unknown-dependency` | warning | A `dependsOn` id is not an item. |
| `board-invalid-field` | warning | Bad `kind`, `status`, tag, `size`, a too long `description` or `outcome`, or a bad `docs` entry. |
| `board-doc-missing` | info | A `docs` path does not exist in the repository. |
| `board-unknown-group` | warning | An item names a group the board does not have, or a group has an unknown `status`. |
| `board-dates-reversed` | warning | `due` is earlier than `start`. |
| `board-overdue` | info | `due` is before today and the status is not `done` or `abandoned`. |
| `board-nest-cycle` | warning | `parent` links form a cycle. |
| `board-depends-cycle` | warning | `dependsOn` links form a cycle. |
| `board-cycles-truncated` | info | The cycle search stopped early. |

### 8.5 Writing the board

**PS-8.9** A writer MUST NOT write the board if the file it read has any structure problem: the reader drops what it cannot read, so writing back would lose data. It MUST write to a temporary file in the same folder and rename it. It MUST refuse if the file changed since it was read. After writing it MUST read the file again; on any problem it MUST restore the old content (or remove the new file). It MUST write only the board file of the project, inside `.c4pm/`.

---

## 9. Versioning and compatibility

### 9.1 Versions

**PS-9.1** This standard has a version `major.minor`. This is 1.10. A change that makes a valid file invalid, or changes the meaning of a rule, raises the major number. A new optional feature raises the minor number. Appendix C lists changes.

**PS-9.2** `.c4` files carry no version marker. A writer MUST NOT add a new top-level keyword (such as `version`): a reader of this version reports it as `unexpected keyword`. A comment such as `// plan-standard: 1.1` is safe.

**PS-9.3** The board file has `schemaVersion`, an integer. Its value is 1. A reader MUST reject a file with any other value (no data is returned; the problem is `schemaVersion: must be 1`). A writer MUST write 1. The number is raised only for a change that older readers cannot read safely: renamed or removed fields, changed meaning, or a changed type. Adding an optional item key does not raise it. Each simulation file (chapter 10) has its own `schemaVersion`, also 1, with the same rules. A reader rejects only that file; the other files are still read (PS-10.3).

### 9.2 Tolerant reading

**PS-9.4** What a reader does with things it does not know:

| Where | Unknown thing | Reader MUST |
|---|---|---|
| `.c4` | Element kind | Keep the element. |
| `.c4` | Metadata key | Keep it. |
| `.c4` | `specification` or `views` content | Skip it. |
| `.c4` | A line in a body or model block that starts with an unknown `ident` not followed by `=` or `->` on the same line | Skip the rest of the line. A lone word on its line: report a parse issue, skip only the word (PS-3.18). |
| board item | Unknown key | Keep it with its value, report a warning (`board-parse`), and write it back after the known keys when it saves the file. |
| board file, board, group, docs entry | Unknown key | Report it as a structure problem. A writer then refuses to save (PS-8.9). |
| board item | Unknown `kind`, `status`, `size`, group | Keep the value as written, and report `board-invalid-field` or `board-unknown-group`. |
| s-item, step, stage, call | Unknown key | Keep it with its value, report a warning (`sim-parse`), and write it back after the known keys when it saves the file. The s-item is still read (since 1.10). |
| step, stage | A known key in the wrong place: a stage key on a step, or a key of another stage form (PS-10.9) | Report it as a structure problem. The s-item is not read, and a writer refuses to save that file (PS-10.15). |
| step, inline step stage | Old `view` word `architecture`, `front` or `data` | Read it as `arch`, `io` or `storage` (PS-10.6). |
| `sim/` folder | A file whose name does not end in `.json` | Skip it. No problem is reported. |

### 9.3 Duties

**PS-9.5** A **conforming reader** MUST:

1. find the plan files by chapter 2;
2. tokenise and parse by chapter 3, including the recovery rules, and report parse issues with file and line;
3. keep unknown kinds and metadata keys (PS-4.4), and read old kind words as their current word (PS-3.11e);
4. resolve link paths by PS-5.5;
5. never change a file.

A reader SHOULD offer the board file reading of chapter 8 and MUST reject a `schemaVersion` other than 1. A reader MAY offer the simulation file reading of chapter 10 (since 1.10); if it does, it MUST reject a simulation file with a `schemaVersion` other than 1.

**PS-9.6** A **conforming checker** is a reader that MUST also produce the rules of PS-6.3 with the names and severities given. It MAY produce the rules of PS-6.4 if it has a scan of the code; if it does, it MUST use the names and severities given. The same holds for the simulation rules of PS-10.11 (since 1.10). A checker MAY add rules with other names.

**PS-9.7** A **conforming writer** MUST:

1. follow chapter 7 (gate, location, read-before-write, rollback);
2. write strings and metadata as in PS-3.5 and PS-4.1;
3. never change an existing `uid` or `layout` line (PS-4.6);
4. keep unknown kinds, keys and board item keys;
5. write full fqns in relations (PS-3.21);
6. for the board, follow PS-8.2 and PS-8.9;
7. for simulation files, follow PS-10.4 and PS-10.15 to PS-10.17 (since 1.10), and keep unknown s-item, step, stage and call keys.

A writer SHOULD change only what it means to change (PS-7.9). A writer MAY mint uids for elements that lack one (PS-4.7).

### 9.4 Extensions

**PS-9.8** A producer MAY add metadata keys. It SHOULD use lower-case names and SHOULD avoid the names in 4.3. A producer MAY add board item keys; a reader of this version keeps them but reports a warning. The same holds for keys of an s-item, a step, a stage or a call (since 1.10).

### 9.5 Conformance corpus

**PS-9.9** `Document/plan-standard-corpus/` has three folders:

- `valid/`: files that MUST parse with no parse issue.
- `invalid/`: files whose first line is `// expect: <rule> | <text>`. A conforming checker MUST report a finding with that rule whose message contains the text.
- `expected/`: for each valid file, a JSON file with `plan` (the elements, relations and issues a reader produces, with the file name `plan/<name>.c4`) and `findings` (the findings of a checker with no source code in the repository).

The element fields in `expected/` are `id`, `kind`, `title`, `description`, `technology`, `links` (`raw`, `path`, `name`, `lines`, `title`), `metadata`, `parent`, `source`. The relation fields are `from`, `to`, `label`, `source`.

Since 1.7 the store of `valid/14-storage-kinds.c4` gives a finding: with no source code in the repository no reader finds files for `postgres`, and the store has no `status`, so `expected/14-storage-kinds.json` has one `missing-store` warning on `app.api.db` (PS-6.4b). The file itself is still valid: it parses with no issue.

Since 1.9 `valid/15-layers.c4`, `valid/17-shared-layer.c4` and `invalid/17-layer-misplaced.c4` keep the old kind word `layer` on purpose (PS-3.11e): their `expected/` files give the kind `subregion`. `valid/18-subregions.c4`, `valid/19-shared-subregion.c4` and `invalid/21-subregion-misplaced.c4` are the same plans written with `subregion`; a reader MUST give the same elements for each pair.

Since 1.10 the corpus also has `sim/` for simulation files (chapter 10):

- `sim/valid/`: s-item files with their real names (`s-1.json` a flow, `s-2.json` a journey). A reader MUST read each with no structure problem and no unknown key. A writer that writes the read s-item again MUST give the same bytes (PS-10.4).
- `sim/invalid/`: files named `<nn>-<what is wrong>.json`. Read each one under the file name `s-1.json`. A reader MUST report a structure problem whose message contains the text that `sim/expected-issues.json` gives for the file, and MUST NOT return the s-item. Each file has exactly one problem.

---

## 10. Simulation files

Since 1.10. An s-item says HOW the system runs for one scenario: ordered steps across the IO view (screens, commands, routes, tools), the arch view (components and code) and the storage view (stores and records), with the state after each step. There are two kinds. A `flow` is a list of steps. A `journey` is a list of stages: a flow, something outside the system, or one step. S-items are written on demand, by a person or a tool told to; a scan of the code never writes them. A repository with no s-items is normal and gives no finding.

### 10.1 Location and encoding

**PS-10.1** Each s-item is one file `<anchor>/.c4pm/projects/<id>/sim/<s-id>.json`, next to `board/`. It is UTF-8 JSON. It is committed. A repository without the `sim/` folder has no s-items. A reader MUST NOT create the folder.

**PS-10.2** File names. A reader reads every regular file in `sim/` whose name ends in `.json`, and skips other files without a problem. The name without `.json` MUST be an s-item id: `s-<N>`, regex `^s-([1-9][0-9]*)$` (N is 1 or more, no leading zero). A `.json` file with another name is a structure problem (`file name must be s-<N>.json (file skipped)`) and is not read. Files are read in number order (`s-2` before `s-10`).

**PS-10.3** Each file is read on its own. A file that cannot be read, or has a structure problem, does not stop the reading of the other files, and does not block a write of another file.

**PS-10.4** A writer SHOULD write a file with 2-space indentation and a final line feed. Keys are written in the order of the tables in PS-10.5 to PS-10.8 (stage: `name`, then `flow`, `outside` or `target`, then the rest in table order), then the unknown keys in the order they were read. A step `target` with one ref is written as a string, with more refs as an array. Old view words are written as the new word (PS-10.6). A file written this way reads back and writes again to the same bytes.

### 10.2 s-item

A journey, shortened from `sim/valid/s-2.json` of the corpus:

```json
{
  "schemaVersion": 1,
  "id": "s-2",
  "kind": "journey",
  "title": "First-time buyer",
  "person": "customer",
  "stages": [
    { "name": "Discover", "outside": "Sees an ad", "goal": "Find something worth buying" },
    { "name": "Sign in", "target": "u-login", "goal": "Sign in", "view": "io", "state": "session: signed out" },
    { "name": "Buy", "flow": "s-1", "goal": "Buy" },
    { "name": "Follow-up", "outside": "Gets a confirmation email", "from": "Newsletter tool", "channel": "email" }
  ]
}
```

**PS-10.5** Fields of an s-item. The reader takes keys in any order. Strings are trimmed when read, except free text (`description`, `state`, `caption`, `label`, `outside`, `goal`), which is kept as written. Every string MUST hold at least one character that is not white space.

| Field | Type | Rule |
|---|---|---|
| `schemaVersion` | number | Required. MUST be `1` (PS-9.3). |
| `id` | string | Required. `s-<N>` (PS-10.2). MUST equal the file name without `.json`. |
| `kind` | string | Required. `flow` or `journey`. |
| `title` | string | Required, not empty. |
| `person` | string | Optional, on a flow or a journey. Who goes through the scenario, as text. When it names a plan `person` element (by uid, fqn, id or name) a tool MAY link the two; else it is plain text. Not checked. |
| `description` | string | Optional. Free text. |
| `steps` | array of step | Optional, flow only. MAY be empty (a draft). PS-10.6. |
| `stages` | array of stage | Optional, journey only. MAY be empty. PS-10.8. |

`steps` on a journey and `stages` on a flow are structure problems (`steps: not allowed on a journey`).

### 10.3 Step, call and stage

**PS-10.6** Fields of a step.

| Field | Type | Rule |
|---|---|---|
| `target` | string or array of string | Required. One ref, or a non-empty array of refs. A ref names what the step lights: the `uid` of a plan element when it has one; else the fqn of a plan element (for example a planned function, PS-5.13); else a code function as `<path>#<name>`, the path relative to the repository. A reader does not resolve refs; the checks do (PS-10.12). |
| `view` | string | Required. `arch`, `io` or `storage`: the view the step is shown in. A reader also takes the old words `architecture`, `front` and `data` and reads them as `arch`, `io` and `storage`. |
| `call` | object | Optional. The arrow of the step. PS-10.7. |
| `state` | string | Optional. Free text: the state after the step, for example `cart: 1 item`. |
| `rows` | object | Optional. Sample data. Each key is the `uid` of a plan `record`; each value is an array of objects, the record's whole sample table after the step. Rows are kept as written. |
| `caption` | string | Optional. Free text, one or two sentences. |
| `durationSec` | number | Optional. Greater than 0. How long the step shows when a tool plays the s-item. |

**PS-10.7** Fields of a call. All are optional; `{}` is a valid call.

| Field | Type | Rule |
|---|---|---|
| `from` | string | A ref (as a target) or a name: where the arrow starts. When absent, a tool draws it from the previous step (for step 1: the person). |
| `to` | string | A ref: where the arrow ends. When absent, a tool uses the first target of the step. |
| `label` | string | Free text on the arrow, for example `POST /cart/items`. |
| `reply` | boolean | `true`: a return arrow. |

A step without `call` has an arrow that a tool derives, with no label. A reader keeps an absent key absent; the defaults are for display only.

**PS-10.8** A stage has exactly one of `flow`, `outside` and `target`. That key gives its form. The other keys it may hold depend on the form.

| Field | Type | Flow stage | Outside stage | Inline step stage | Rule |
|---|---|---|---|---|---|
| `name` | string | optional | optional | optional | A short name. A tool shows `Stage <n>` when absent. |
| `flow` | string | required | - | - | The id of a flow s-item (`s-<N>`). |
| `outside` | string | - | required | - | Free text: what happens outside the system. |
| `target` | string or array | - | - | required | As in a step. |
| `goal` | string | optional | optional | optional | Free text: what the person wants in this stage. |
| `from` | string | - | optional | - | Who sends it, as text (a shop, a tool, a person). |
| `channel` | string | - | optional | - | How it arrives, as text: for example `email`, `phone`, `letter`, `chat`. |
| `view` | string | - | - | required | As in a step. |
| `call` | object | - | - | optional | As in a step. |
| `state` | string | - | optional | optional | As in a step. |
| `rows` | object | - | - | optional | As in a step. |
| `caption` | string | - | optional | optional | As in a step. |
| `durationSec` | number | - | optional | optional | As in a step. |

**PS-10.9** A known key in the wrong place is a structure problem: a key of a stage form on a step (`steps[0].name: not allowed on a step`), or a key of one stage form on another (`stages[2].state: not allowed on a flow stage`). A stage with none or more than one of `flow`, `outside`, `target` is a structure problem too. A key that is known nowhere is an unknown key (PS-9.4).

**PS-10.10** Structure problems and notes. A reader reports every structure problem of a file, each with the JSON path of the value (`steps[0].view: ...`), not only the first. Three problems stop the reading of the file at once: text that is not JSON, a value that is not a JSON object, and a `schemaVersion` other than 1. A file with any structure problem gives no s-item. An unknown key is a note, not a structure problem: the s-item is read, and the key is kept (PS-9.4). The messages in the corpus are examples (PS-6.2).

### 10.4 Simulation checks

**PS-10.11** A checker that reads s-items MUST use these rule names and severities. The `id` of a finding is a file name, or an s-item id with a place after `:` (step numbers and stage numbers start at 1).

| Rule | Severity | Condition | `id` |
|---|---|---|---|
| `sim-parse` | warning | One per structure problem, note (unknown key) or bad file name of PS-10.2 to PS-10.10. | the file, `s-3.json` |
| `sim-target-missing` | warning | A target of a step or an inline step stage, or a `rows` key, resolves to nothing (PS-10.12). A `rows` key also when it is not a `record`. | `s-1:3` (step 3), `s-2:stage-2` (stage 2) |
| `sim-step-unconnected` | info | A judged pair of steps (PS-10.13) with no link between them. | `s-1:2-3` |
| `sim-step-unverified` | info | A function to function pair that cannot be proved either way (PS-10.13). | `s-1:6-7` |
| `sim-stage-missing` | warning | A `flow` stage names no s-item, a journey, or its own journey. | `s-2:stage-3` |

**PS-10.12** A ref resolves in this order: (1) the `uid` of a plan element; (2) the exact fqn of a plan element, planned code included; (3) a function `<path>#<name>` of the scanned code. A ref that matches none is missing.

**PS-10.13** Judged pairs. The checker looks at each two steps in a row of a flow. With several targets, a pair is connected when any target of the first step connects to any target of the second. A pair with a missing target is skipped. Three pairs are judged:

1. IO to IO, where the second is an entry (screen, command, route, tool): connected when both have the same owning entry, or when a plan relation goes from the first's owning entry to the second.
2. IO to arch (a component, function, method or class): connected when a plan relation, with any label, goes from the IO element or one of its ancestors up to its entry, to the arch element, an ancestor of it, or an element under it. It is also connected when the second step has a `call` whose `from` is in the same container as the first's entry (or a plan relation goes from the IO side to it), and a plan relation goes from `call.from` (or its ancestors up to its component) to `call.to`, its ancestors or the elements under it, where `call.to` is the second step's element, an ancestor or an element under it.
3. Function or method to function or method: connected when a chain of at most 3 resolved calls in the scanned code leads from the first to the second. When either side is planned only (no code), or when the first has an unresolved call whose last name part equals the second's name, the pair is unverified. Else it is unconnected. A checker that did not read the calls gives no finding for this pair.

Other pairs (arch to storage, storage to IO, component to component, ...) are not judged in this version.

**PS-10.14** These findings are sorted with the others (PS-6.1). The plan gate (PS-7.3) does not compute them: an edit of `.c4` files is never refused for a simulation finding. At version 1.10 the reference implementation reads and writes simulation files but does not compute these findings yet; Appendix B marks them as planned.

### 10.5 Writing simulation files

**PS-10.15** A writer of simulation files MUST:

1. write only files `sim/<s-id>.json` of the project, inside `.c4pm/`;
2. not rewrite a file that has a structure problem (PS-10.10): the reader drops what it cannot read, so writing back would lose data; notes do not block;
3. refuse if a file changed since it was read; for a new file, refuse if a file with that name exists by now ("s-5 was created meanwhile; run again"), and never overwrite it;
4. write each file through a temporary file in the same folder, and create a new file so that the create fails when the name exists;
5. read every written file again; on any problem, restore every file of the change (old text, or remove a new file).

A change to several s-items is all or nothing.

**PS-10.16** A new s-item gets the id `s-<M+1>`, where M is the highest N of the `s-<N>.json` file names in `sim/`, files with structure problems included (0 when there is none). Several new s-items take the next numbers in order. The file names count, not the contents, so a broken file still holds its number.

**PS-10.17** A writer SHOULD refuse to remove an s-item that a `flow` stage of a journey names.

---

## Appendix A: Grammar (EBNF)

Notation: `|` alternative, `[ ]` optional, `{ }` zero or more, `( )` group. Terminals in quotes. Whitespace and comments may appear between any two tokens and are not shown. This grammar describes the text the parser accepts; the parser also recovers from errors (section 3), which a grammar cannot show.

```ebnf
file        = { block } ;
block       = model | extend | skipped ;
model       = "model" "{" scope "}" ;
skipped     = ( "specification" | "views" ) "{" balanced "}" ;
balanced    = { any token except an unmatched "}" } ;   (* braces inside must pair *)

scope       = { scope-item } ;
scope-item  = element | relation | extend | skipped ;

extend      = "extend" fqn "{" scope "}" ;

element     = id "=" kind title [ description ] [ "{" body "}" ] ;
body        = { body-item } ;
body-item   = "technology" string
            | "description" string
            | "title" string
            | link
            | metadata
            | element
            | relation
            | short-rel
            | extend
            | test
            | skipped ;

test        = "test" string [ "{" [ "case" string ] "}" ] ;   (* writers put it on ONE line, PS-3.11d *)

relation    = fqn "->" fqn [ string ] [ "{" balanced "}" ] ;
short-rel   = "->" fqn [ string ] [ "{" balanced "}" ] ;

link        = "link" target [ string ] ;
target      = ident | word | string ;

metadata    = "metadata" "{" { key string } "}" ;
key         = ident ;

id          = ident ;                        (* SHOULD be: letter-or-underscore { letter | digit | "_" | "-" } *)
fqn         = ident ;                        (* ids joined by "." *)
kind        = ident ;
title       = string ;
description = string ;

ident       = ident-start { ident-char } { "." ident-start { ident-char } } ;
ident-start = "A".."Z" | "a".."z" | "_" ;
ident-char  = ident-start | "0".."9" | "-" ;
word        = nonspace { nonspace } ;        (* no whitespace, no "{", no "}" *)
string      = "'" { char | "\\'" | "\\\\" } "'"
            | '"' { char | '\\"' | '\\\\' } '"' ;
comment     = "//" { any char but LF } LF | "/*" { any char } "*/" ;
```

Lexical conditions the grammar cannot show:

- An `ident` is an `ident` only if it is followed by the end of the file, whitespace, `{`, `}`, `=`, `"` or `'`. Otherwise the whole run is a `word` (PS-3.3).
- `->` is the `arrow` token only where a token starts.
- The words `specification`, `views`, `extend`, `model` (top level) and `technology`, `description`, `title`, `link`, `metadata` (body) are keywords at the places shown and cannot be ids there (PS-3.16).
- A target of `link` is read as a token of type `ident`, `word` or `string`; its inner structure (path, `#fragment`) is defined in section 5.

Board file JSON shape (informal):

```ebnf
board-file  = "{" '"schemaVersion"' ":" 1 "," '"boards"' ":" "[" { board } "]" "}" ;
board       = "{" '"id"' ":" string "," '"name"' ":" string
              [ "," '"archived"' ":" true ] [ "," '"groups"' ":" "[" { group } "]" ]
              "," '"items"' ":" "[" { item } "]" "}" ;
```

---

## Appendix B: Where each rule is implemented

Paths are relative to `Project/` in the repository. Line numbers are for the commit this version was written against (599dc60), and for 962af9f in the PS-10 rows; they will drift.

| Rules | File:line |
|---|---|
| PS-2.1 anchor search | `src/paths.ts:37-56` |
| PS-2.2, PS-2.3 folders | `src/paths.ts:59-82` (`internalDir`, `projectDir`, `dataDir`, `historyDir`, `planDir`); `src/outputs.ts:108-120` |
| PS-2.4 project id | `src/names.ts:3-26` (`toId`); `src/outputs.ts:19-23` (`projectIdFor`); `src/history/meta.ts:8-27` (name source) |
| PS-2.5 `.gitignore` text | `src/init.ts:12-30` |
| PS-2.6, PS-2.7 plan folder choice | `src/plan/files.ts:89-130` (`planDirsFor`, `findPlanFiles`) |
| PS-2.8 file walk | `src/plan/files.ts:12-86`; skipped folders `src/constants.ts:13` (`IGNORE_DIRS`); extension `src/constants.ts:72` |
| PS-2.9 read order, sort, `read failed` | `src/plan/parser.ts:401-457` |
| PS-2.11, PS-2.12 wireframe files | `src/c4/wireframeFiles.ts:57-102` (`loadWireframes`), `138-154` (`readGuarded`: no symlink, 512 KB cap), `199-252` (`inlineSheets`: stylesheet links inside `io/`); refs `src/c4/wireframeRefs.ts:28-72` (`resolveWireRef`, `resolveWireRefs`, `wireframeOf`); `src/c4/wireframeHtml.ts:17-21` (`WIREFRAME_CSS`), `97` (`scanWireRefSpans`); sizes `src/plan/ioWords.ts:45-61` (`DEVICE_VIEWPORT`, `parseViewport`); `src/view/navLayout.ts:18-41` (`deviceOf`, `viewportOf`) |
| PS-3.1-3.5 lexer | `src/plan/lexer.ts:11-209` (whitespace 30-36, comments 39-65, strings 68-115, arrow 118-122, ident or word 143-197) |
| PS-3.6 top-level blocks | `src/plan/parser.ts:110-174` |
| PS-3.7-3.9 elements | `src/plan/parser.ts:61-108` |
| PS-3.10-3.12 kinds | `src/plan/kinds.ts` (`KIND_TABLE`); planned code kinds `src/plan/plannedElements.ts:5` |
| PS-3.11c subregions | `src/plan/kinds.ts` (`subregion`, parents of `component`); `src/plan/layers.ts` (`containerOf`, `subregionOf`, `subregionsOf`) |
| PS-3.11e old kind words | `src/plan/renames.ts` (`STANDARD_STEPS`, `canonicalKind`, `canonicalRule`); `src/plan/parser.ts` (`addElem`); `src/c4/planUpgrade.ts` (`upgradePlanText`), `src/services/planUpgrade.ts` (`c4pm plan upgrade`) |
| PS-3.11a storage nesting, display words | `src/plan/kinds.ts` (parents of `store`, `record`, `field`); `src/storage/storageWords.ts`; tech keys `src/schema/storageTech.ts` |
| PS-3.13-3.16 nesting, ids, fqn | `src/plan/parser.ts:77` (fqn), `src/plan/parser.ts:176-250` (scope), `src/plan/parser.ts:252-399` (body keywords at 282, 296, 316, 341, 347) |
| PS-3.17-3.19 body statements | `src/plan/parser.ts:252-399` |
| PS-3.20-3.22 relations | `src/plan/parser.ts:56-59`, `226-241`, `255-273`, `378-393` |
| PS-3.23, PS-3.24 extend | `src/plan/parser.ts:149-166`, `196-212`, `347-363` |
| PS-3.25 issue messages | `src/plan/parser.ts:37-39` and the `issue(...)` calls; `src/plan/lexer.ts:104` |
| PS-4.1 metadata syntax | `src/plan/parser.ts:316-339` |
| PS-4.3 key checks | `src/c4/validate.ts:42-135` (status 42-54, priority 56-68, sprint 70-82, owner 84-96, uid 98-108, tags 110-121, shared 123-135), `146-156` (viewport, since 1.7; `parseViewport` `src/plan/ioWords.ts:55-61`), `160-172` (shape, since 1.11; `PERSON_SHAPES` `src/constants.ts:54`), `174-187` (role, since 1.12; `COMPONENT_ROLES` `src/constants.ts:56`); `src/plan/layers.ts` (`isSharedSubregion`); `src/constants.ts:65-66`; `src/tags.ts:2` |
| PS-4.3a storage keys | `src/storage/storageMeta.ts` (names and formats only; no check) |
| PS-4.3 `layout` format | `src/view/model.ts:53-66` |
| PS-4.3 `uid` format | `src/c4/ids.ts:11` |
| PS-4.3 `signature`, `purpose` | `src/plan/plannedElements.ts:30-32` |
| PS-4.6 protected lines | `src/c4/planTx.ts:14-15`, `68-77`, `113-117`; `src/c4/editSet.ts:5`, `86`; `src/cli/setCmd.ts:20-30` |
| PS-4.7 uid minting | `src/c4/ids.ts:24-61`; `src/cli/addCmd.ts:89` |
| PS-5.1-5.4 link syntax and parts | `src/plan/parser.ts:296-314`; `src/plan/links.ts:14-87` |
| PS-5.5 relative paths | `src/plan/links.ts:56-78` |
| PS-5.6 fold of `../` | `src/plan/parser.ts:436-446` |
| PS-5.7, PS-5.8 claim kinds | `src/c4/ownership.ts:22-52` |
| PS-5.9 claim match | `src/c4/ownership.ts:9-13` |
| PS-5.10 claim mode test | `src/c4/ownership.ts:64-66`; `src/c4/check.ts:341-342` |
| PS-5.11 ownership | `src/c4/ownership.ts:6`, `83-241` |
| PS-5.12 mode and rules | `src/c4/check.ts:347-461` |
| PS-5.13 planned code | `src/plan/plannedElements.ts:19-38`, `98-107` |
| PS-3.11d test blocks | `src/plan/parser.ts` (`parseTest`); `src/c4/editMeta.ts` (walker `testLines`, `testBlockText`, `addTestText`, `removeTestText`); `src/plan/kinds.ts` (`ACCESSORY_ADD_KINDS`); `src/c4/planTests.ts` (`matchPlannedTest`, `lostTestBlocks`); `src/util/testIds.ts` (test case ids); `src/c4/generate.ts` (`testsWriter`) |
| PS-6.1 sort | `src/c4/check.ts:463-477`; `src/constants.ts:62` |
| `parse-error` | `src/c4/check.ts:57-66` |
| `code-parse-error` | `src/c4/check.ts:68-76` |
| `invalid-metadata` | `src/c4/validate.ts:35-135` |
| `duplicate-uid` | `src/c4/validate.ts:138-159` |
| `duplicate-fqn` | `src/c4/check.ts:87-99` |
| `subregion-misplaced` | `src/c4/validate.ts` (`validateMetadata`); old ids in acks: `src/findings/ack.ts` (`canonicalRule`) |
| `missing-code` | `src/c4/check.ts:118-156` |
| `broken-function` | `src/c4/check.ts:158-173` |
| `broken-claim-link` | `src/c4/check.ts:175-190` |
| `folder-link-no-slash` | `src/c4/check.ts` (checkPlan) |
| `stub-in-done` | `src/c4/check.ts:192-230` |
| `abandoned-but-present` | `src/c4/check.ts:232-244` |
| `late` | `src/c4/check.ts:246-261` |
| `planned-but-built` | `src/c4/check.ts:263-277` |
| `planned-not-built`, `planned-built-update-status`, `missing-signature` | `src/c4/check.ts:279-316` |
| `line-link` | `src/c4/check.ts:318-330` |
| `component-claim-conflict` | `src/c4/check.ts:350-360` |
| `split-file` | `src/c4/check.ts:362-398` |
| `shared-auto` | `src/c4/check.ts:400-409` |
| `unassigned-code` | `src/c4/check.ts:411-419` |
| `plan-unmatched` | `src/c4/check.ts:421-447` |
| `unplanned-code` | `src/c4/check.ts:448-461` |
| `planned-not-built` (test blocks), `test-link-dead`, `no-tests` | `src/c4/check.ts` (`checkTestBlocks`); `src/util/testIds.ts` (`isTestRef`) |
| `wireframe-out-of-date`, `wireframe-inline-style`, `wireframe-bad-stylesheet` | `src/c4/wireframeCheck.ts:33-63` (`fileFindings`) |
| `wireframe-missing`, `wireframe-orphan` | `src/c4/wireframeCheck.ts:70-102` (`checkWireframes`); fixes for unusable files `17-30` (`unusableFix`) |
| PS-6.4a wireframe rules outside the gate | `src/check/collect.ts:44-49` (`collectFindings` calls `loadWireframes` and `checkWireframes`); the gate uses `checkPlan` only `src/c4/planTx.ts:90-91` (`findingsOf`) |
| `missing-store`, `store-unreadable`, `missing-record`, `planned-but-built` (records), `field-drift`, `unplanned-record` | `src/storage/checkStorage.ts:49-93` (`storeFindings`); severity by status `14-17` (`SEVERITY_BY_STATUS`, `severityOf`); `src/storage/storageState.ts:43` (`storeHasNoCode`) |
| `unplanned-store`, `store-unreadable` with `id` `store-scan` | `src/storage/checkStorage.ts:100-108` (`checkStorage`); `src/schema/storeScan.ts:84-90` (`storeCovers`) |
| PS-6.4b reader choice, store read, matching | `src/schema/readers.ts:91-117` (`resolveStoreReader`), `123-139` (`readResolved`); `src/storage/storageState.ts:70-109` (`buildStorageState`, `readStorage`); `src/storage/matchRecords.ts:35-65` (`matchRecords`); `src/storage/fieldDiff.ts:46` (`matchFields`), `69-92` (`fieldDiff`) |
| PS-6.4b storage rules only with a store, outside the gate | `src/check/collect.ts:51-55` (`collectFindings` calls `readStorage` and `checkStorage`); the gate uses `checkPlan` only `src/c4/planTx.ts:90-91` (`findingsOf`) |
| PS-7.3 item 6 lost test blocks | `src/c4/planTx.ts` (`allowLostTests`); `src/c4/planTests.ts` (`lostTestBlocks`) |
| PS-7.2, PS-7.3, PS-7.4 gate | `src/c4/planTx.ts:41-136`; dry run default `src/cli/common.ts:235-302` |
| PS-7.5 fast and full mode | `src/c4/planTx.ts:54-66`; `src/cli/common.ts:228-231` |
| PS-7.6 location | `src/c4/writeGuard.ts:9-16`; `src/c4/planTx.ts:162-167`; `src/paths.ts:85-91`; new wireframe file (since 1.7) `src/services/planOps.ts:577-607` (`wireframeStarterEdit`), `src/c4/planTx.ts:257-360` (`commitPlanEdit`, `create`), `src/c4/writeGuard.ts:36-48` (`isWireframeFile`, `create`) |
| PS-7.7, PS-7.8 re-read and rollback | `src/c4/planTx.ts:158-207` |
| PS-7.10 value rules | `src/services/fieldRules.ts:7-22`; quoting `src/c4/editMeta.ts:289-291` |
| PS-7.13 move and rename | `src/c4/planMove.ts:62-110` (`fqnMapOf`, `rewriteRefs`), `193-314` (`planMove`), `381-433` (`planRenameEl`); wireframes `src/c4/wireframeMove.ts:30` (`planWireframeMoves`); gate map `src/c4/planTx.ts:66-81` (`mapFqn`, `findingKey`), `139-190` (moved elements, protected lines); wireframe writes `src/c4/planTx.ts:236-318` (`commitPlanEdit`), `src/c4/writeGuard.ts:36-44` (`isWireframeFile`); mentions `src/services/planMove.ts:234-291` (`findMentions`) |
| PS-8.1 board location | `src/board/load.ts:10-12` |
| PS-8.2 serialisation | `src/board/serialize.ts:3-62` |
| PS-8.3, PS-8.4 structure | `src/board/parse.ts:6-219`; types `src/types.ts:434-461` |
| PS-8.4 kinds, sizes, limits | `src/constants.ts:67-71` |
| PS-8.4 dates | `src/board/dates.ts:1-9` |
| PS-8.6 docs rules | `src/board/docs.ts:7-23` |
| PS-8.8 board rules | `src/board/check.ts:32-155`; `board-parse` `src/board/run.ts:17-23` |
| PS-8.9 board writing | `src/board/write.ts:37-52` (refuse on issues), `60-69` (atomic write), `88-108` (stale check, re-read, rollback) |
| PS-9.3 `schemaVersion` | `src/board/parse.ts:47-58` |
| PS-9.4 tolerant reading | `src/board/parse.ts:30-34`, `59`, `138-143`; `src/plan/parser.ts:395-397` |
| PS-10.1, PS-10.2 sim folder and file names | `src/sim/load.ts:8-15` (`simDirFor`, `simFileFor`), `40-81` (`loadSims`: `.json` only, name check, number order); `src/sim/parse.ts:6` (`SIM_ID_RE`) |
| PS-10.3 one file at a time | `src/sim/load.ts:63-78` (`loadSims`) |
| PS-10.4 sim serialisation | `src/sim/serialize.ts:7-33` (`ordered`, `valueOut`, `serializeSim`); key order `src/sim/parse.ts:12-15` (`SIM_KEYS`, `STEP_KEYS`, `CALL_KEYS`, `STAGE_KEYS`) |
| PS-10.5 to PS-10.10 sim structure | `src/sim/parse.ts:18-24` (stage forms), `27-33` (`normaliseView`, old view words), `52-126` (value readers: trimmed `word`, kept `freeText`), `132-148` (`readObject`: wrong place, unknown keys), `154-171` (`parseStep`, `parseStage`), `180-214` (`parseSim`); types `src/types.ts:799-811`; view words `src/constants.ts:59` (`VIEW_NAMES`) |
| PS-9.3, PS-9.4 for sim files | `src/sim/parse.ts:204-207` (`schemaVersion`), `141-144` (unknown key kept as a note) |
| PS-10.11 to PS-10.14 sim checks | planned (Phase 25 task T7): `src/sim/resolve.ts` (`resolveSimTarget`), `src/sim/check.ts` (`checkSims`), `src/sim/run.ts` (`simsForCheck`), `src/check/collect.ts` (`collectFindings`) |
| PS-10.15, PS-10.16 sim writing and ids | planned (Phase 25 task T2): `src/util/fsCommit.ts` (`commitFileSet`), `src/sim/write.ts` (`planSimWrites`, `applySimWrites`), `src/sim/ops.ts` (`mintSimIds`) |
| PS-10.17 remove refused | planned (Phase 25 task T4): `src/services/simEdit.ts` (`removeSim`) |

---

## Appendix C: Change history

| Version | Date | Change |
|---|---|---|
| 1.0 | 2026-10-25 | First written standard. Describes the behaviour of `c4pm` at commit 599dc60. Board file `schemaVersion` 1. |
| 1.1 | 2026-11-01 | New kinds `store`, `record`, `field` (family storage, PS-3.10, PS-3.11, PS-3.11a). New storage metadata keys, not checked (PS-4.3a). No change to the board file or to checks. |
| 1.2 | 2026-11-01 | New kinds `command`, `options`, `flag`, `arg`, `route`, `body`, `param`, `tool` (family front-end, PS-3.10, PS-3.11, PS-3.11b). `command`, `route` and `tool` need code when `done` (PS-3.10). New keys `in`, `type`, `required`, `method`, not checked. No change to the board file. |
| 1.3 | 2026-11-04 | New kind `layer` (family architecture, PS-3.10, PS-3.11, PS-3.11c): a group of components inside a container; a `component` may sit in a `container` or a `layer`, so a layered component has the fqn `container.layer.component`. New rule `layer-misplaced` (PS-6.3). No change to the board file. |
| 1.4 | 2026-11-04 | Writers may move and rename elements (PS-7.13, optional): references follow through an old -> new fqn map. The gate matches moved elements at their new fqn with the same uid (PS-7.3 items 3 and 4) and maps old findings before comparing (PS-7.4); a writer may rename and edit the wireframe of a moved screen (PS-7.6). No change to the file format, the checks or the board file. |
| 1.5 | 2026-11-05 | New `test` block in an element body (PS-3.11d, PS-3.16, PS-3.17, PS-3.25, Appendix A): a test to write or, with `case`, a hand link to a test case or helper file. Not a kind, no uid (PS-3.11); `case` claims nothing (PS-5.13). `planned-not-built` also covers test blocks; new rule `test-link-dead` and opt-in rule `no-tests` (PS-6.4); the gate refuses a lost test block (PS-7.3). Writers emit one line per block. No change to the board file. |
| 1.6 | 2026-11-05 | New metadata key `shared` on a `layer` (PS-3.11c, PS-4.3): `shared 'true'` marks a layer every other layer of its container may use directly. `invalid-metadata` also covers `shared` on another kind or with a value other than `true` (PS-6.3). No change to the file format or the board file. |
| 1.7 | 2026-11-07 | Wireframe files: one HTML file per screen in `<plan folder>/io/`, `data-c4` refs, classes only with one shared stylesheet in `io/` (PS-2.11, PS-2.12). New screen keys in the key table: `device`, `design`, and `viewport` (PS-4.3); `invalid-metadata` also covers a bad `viewport` (PS-6.3). New rules `wireframe-missing`, `wireframe-out-of-date`, `wireframe-orphan`, `wireframe-bad-stylesheet`, `wireframe-inline-style` (PS-6.4, PS-6.4a); the gate does not compute them (PS-7.5). A writer may create one new wireframe file of a screen, never over an existing one (PS-7.6). New storage rules `missing-store`, `store-unreadable`, `missing-record`, `field-drift`, `unplanned-record`, `unplanned-store`; `planned-but-built` also covers a planned record that the code has (PS-6.4, PS-6.4b): they run only when the plan has a store, their severity follows the element's status, and the gate does not compute them (PS-7.5). Corpus: `expected/14-storage-kinds.json` now expects one finding, `missing-store` (warning) on `app.api.db` (PS-9.9). No change to the `.c4` format or the board file. |
| 1.8 | 2026-11-10 | A stray word at the end of a line gives a parse issue (`stray word '<id>': expected = or -> after it`, PS-3.25) and no longer hides the next line (PS-3.18, PS-9.4). No change for valid files: a stray word already broke a writer MUST (PS-3.18). New rule `folder-link-no-slash` (warning, PS-6.4): a link to an existing folder written without the trailing `/` resolves but claims no files (PS-5.8). Corpus: new `invalid/20-stray-word.c4`. No change to the board file. |
| 1.9 | 2026-11-12 | The kind `layer` is renamed `subregion` (PS-3.10, PS-3.11c, PS-3.11e): readers accept both words, writers write `subregion`, a file may mix them. The rule `layer-misplaced` is renamed `subregion-misplaced` (PS-6.3); an acknowledgement with the old name still matches. A file written with `layer` stays valid. Corpus: new `valid/18-subregions.c4`, `valid/19-shared-subregion.c4`, `invalid/21-subregion-misplaced.c4`; `expected/15-layers.json` and `expected/17-shared-layer.json` now give the kind `subregion`. No change to the board file. |
| 1.10 | 2026-11-15 | New optional simulation files (chapter 10): one JSON file per s-item in `.c4pm/projects/<id>/sim/`, `schemaVersion` 1 (PS-9.3); kinds `flow` (steps) and `journey` (stages: a flow, something outside, or an inline step); step `target`, `view` (`arch`, `io`, `storage`; old words read), `call`, `state`, `rows` by record uid, `caption`, `durationSec`; `person` on both kinds. Unknown keys are kept with a `sim-parse` warning (PS-9.4, PS-9.8). New rules `sim-parse`, `sim-target-missing`, `sim-step-unconnected`, `sim-step-unverified`, `sim-stage-missing` (PS-10.11), outside the plan gate; the reference checker adds them later. Writing: one file each, changed-since-read, exclusive create, ids max+1 over the file names (PS-10.15, PS-10.16). Corpus: new `sim/valid/`, `sim/invalid/`, `sim/expected-issues.json` (PS-9.9). No change to the `.c4` format, the plan checks or the board file. |
| 1.11 | 2026-11-16 | New optional metadata key `shape` on a `person` (PS-4.3): `person` (default, a round head) or `robot` (a square head, for an AI agent). `invalid-metadata` also covers `shape` on another kind or with another value (PS-6.3); a writer refuses another value (PS-7.10). No change to the `.c4` format or the board file. |
| 1.12 | 2026-11-23 | New optional metadata key `role` on a `component` (PS-4.3): `foundation`. `invalid-metadata` also covers `role` on another kind or with another value (PS-6.3); a writer refuses another value and may remove a named key (PS-7.10). No change to the `.c4` format or the board file. |
