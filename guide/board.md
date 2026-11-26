# c4mp boards: tasks, features, issues and bugs

Written for: AI agents and people who plan work with `c4mp board ...`.

A board item (b-item) is not a plan element. Plan elements are the architecture (system, container, component,
planned code); b-items are the work (task, feature, issue, bug) or the thinking around it (decision, question) and point at plan elements with `links` (their
uids). Everything lives in ONE file, `.c4mp/projects/<repoId>/board/board.json`: a list of boards, each holding its
items. Do not edit that file by hand; the commands below validate every change.

## File shape

```
{ "schemaVersion": 1,
  "boards": [
    { "id": "sprint-s12", "name": "Sprint S12",
      "groups": [ {"id":"planned","name":"Planned","status":"planned"}, {"id":"triage","name":"Needs triage"} ],
      "items": [ { "id": "b1", "title": "Quiz generator", "kind": "feature", "status": "in-progress",
                   "owner": "K", "dependsOn": [], "links": ["<uid>"], "tags": [], "due": "2026-10-30" },
                 { "id": "b2", "parent": "b1", "title": "Build makeQuiz()", ... } ] } ] }
```
Rules: item ids are unique across the whole file (new ids are `b<highest number + 1>`); `parent` names an item of the
SAME board; `dependsOn` may name an item of another board; a board with `archived: true` is hidden from `board list`
and from the page and cannot receive items (`board add` and `board move` refuse it); set it with `board archive <id>`,
clear it with `board unarchive <id>`; `board list --all` shows it; a board with no `groups` shows the three default columns (planned, in-progress, done); a
group with a `status` follows that status (built in), a group without one is custom and items join it with `group`.

**Smaller git diffs of `board.json`.** The file is written in one stable order (items sorted by id), so a change only
touches the items it changes. But git's default diff (Myers) lines up the many identical JSON lines (`"dependsOn": [],`,
`},`) badly: moving 20 items to a new board showed as 2,761 changed lines, of which about 880 were the real move. Tell
git to use the histogram diff, once per repo or for all repos:

```
git config diff.algorithm histogram            # this repo
git config --global diff.algorithm histogram   # every repo
```

The same move then shows as 883 lines. c4mp never changes your git config itself.

## Item fields

Besides `id`, `title`, `kind`, `status`, `owner`, `parent`, `dependsOn`, `links`, `tags`, `start`, `due`, `group`
(and the dates `created`, `updated`, `closed` that the commands set), an item can carry these OPTIONAL fields. A file
without them is unchanged: nothing is added or rewritten when a field is absent.

| Field | Meaning | Limit / rule |
|---|---|---|
| `description` | free plain text, several lines allowed | 8000 characters; for more, put the text in a document and point at it with `docs` |
| `docs` | list of documents `{label?, path?, url?}` | each has exactly ONE of `path` (repo-relative, never absolute, no `..`) or `url` (http or https only) |
| `outcome` | how it ended: a commit hash, a verified-by note | 2000 characters, plain text |
| `size` | `S`, `M`, `L` or `XL` | exactly these words |
| `sprint` | sprint label such as `S15` | letter `S` and digits |
| `priority` | `high`, `medium` or `low` | exactly these words |

`docs` is how an issue or decision links to a document instead of carrying long text: keep the write-up in
`docs/...md` and add it with `--doc path:docs/...md`. A `path` that does not exist yet is only an info finding
(`board-doc-missing`), because the document may be written later. The `kind`s `decision` and `question` are for open
choices and open questions; they use the same statuses as every item (`planned`, `in-progress`, `done`,
`abandoned`). There is no `blocked` status: an item is blocked while something in its `dependsOn` is not done.

Flags (a field is cleared on `set` with the word `none`):

| Flag | Command | Meaning |
|---|---|---|
| `--description <text>` | add, set | the description; on `set`, `none` clears it |
| `--description-file <path>` | add, set | read the description from a UTF-8 file (for long text); not together with `--description` |
| `--append-description <text>` | set | add text AFTER the description: one blank line between; no old text = the new text |
| `--append-description-file <path>` | set | like `--append-description`, the text read from a UTF-8 file |
| `--prepend-description <text>` | set | add text BEFORE the description: one blank line between; no old text = the new text |
| `--prepend-description-file <path>` | set | like `--prepend-description`, the text read from a UTF-8 file |
| `--doc <spec>` | add, set | a document: `path:docs/x.md` or `url:https://...`, optional label `Label=path:docs/x.md`; repeat the flag or use a comma list; on `set` it REPLACES the list and `none` clears it |
| `--add-doc <spec>` | set | ADD documents to the existing ones (same spec; the same path or url is kept once) |
| `--remove-doc <spec>` | set | REMOVE documents, matched by path or url (same spec; the label is ignored) |
| `--add-tag <tags>` | set | ADD tags (comma list or repeat the flag) |
| `--remove-tag <tags>` | set | REMOVE tags (comma list or repeat the flag) |
| `--add-depends <ids>` | set | ADD items this one waits for (each must exist; comma list or repeat the flag) |
| `--remove-depends <ids>` | set | REMOVE items from the ones this one waits for (an id that no longer exists can be removed too) |
| `--outcome <text>` | add, set | how it ended; on `set`, `none` clears it |
| `--size <size>` | add, set | `S`, `M`, `L`, `XL`; on `set`, `none` clears it |
| `--sprint <sprint>` | add, set | `S15` style; on `set`, `none` clears it |
| `--priority <priority>` | add, set | `high`, `medium`, `low`; on `set`, `none` clears it |

`--tag` is still accepted as the old spelling of `--tags` (on `board add`, `set` and `list`; not both in one call).

`--add-*` keeps a value once (one already there is not added again); `--remove-*` of a value that is not there is
no error: it prints a note line (`note: b3 has no tag 'x' (nothing to remove)`) and changes nothing, so a script need
not read the list first. `--tags`, `--depends` and `--doc` replace the whole list and cannot be combined with
`--add-*` / `--remove-*` of the same field; one value both added and removed is refused too.

A file written by a newer c4mp may hold item keys this version does not know. They are kept as written and
written back unchanged; `check` reports each one as a `board-parse` warning (`unknown key 'x' (kept as written)`)
and no command refuses to edit the file because of it.

## Commands

Every write command: dry run unless `--yes`; `--repo` is required; `--json` prints exactly one object on stdout;
errors are `error: <code>: <message>` on stderr (at most 10 reason lines in text, all of them in `--json`); exit 0 or 1.
`--board` may be left out when only one board is open.

| Command | Reads / writes |
|---|---|
| `board list [--board --status --kind --tags --owner --overdue --due-before --all --json]` | read; `--tags a,b` lists items with every one of these tags; `--all` also lists archived boards, marked `(archived)` |
| `board show <id> [--with-tests] [--json]` | read: item, parent, children, depends on, required by, linked plan elements, docs, outcome, description; with `--with-tests` also the tests of the linked c-items (scans the code) |
| `board tree [<id>] [--board B] [-r] [--format mermaid\|text\|json] [--direction TD\|LR] [--max-nodes n] [--fence]` | read |
| `board for <target>` | read: items linking a plan element (uid, fqn, id or name) |
| `board add --title T --kind K [--status --owner --parent --depends --tags --link --start --due --group --board --board-name --description --description-file --doc --outcome --size --sprint --priority --json]` | write one item; `--json` prints one object, the new id is `minted[0].id` |
| `board add --from-file items.json [--board B [--board-name N]]` | write many items at once; `--board-name` names a NEW board (refused for an existing one) |
| `board set <id> [--status --title --owner --kind --parent --depends --tags --start --due --group --description --description-file --append-description --append-description-file --prepend-description --prepend-description-file --doc --add-doc --remove-doc --add-tag --remove-tag --add-depends --remove-depends --outcome --size --sprint --priority]` | write; `none` clears; only one description option per call |
| `board link <id> <target>` / `board unlink <id> <target>` | write |
| `board remove <id>` | write; refused while another item depends on it or nests under it |
| `board move <id> --board B` | write; ids stay; a top-level item takes everything nested under it; a nested item moves alone and each nest link that would cross boards becomes a dependency (the parent waits for the child) |
| `board rename <board> [--id NEW] [--name TEXT]` | write; the board id and/or display name change, item ids stay |
| `board archive <board>` / `board unarchive <board>` | write; only the board's `archived` flag changes (items stay); already in that state = nothing to change |
| `board delete <board>` | write; an EMPTY board only (archived or not); refused while it holds items, which are listed |
| `board group add <name>` / `remove <name>` / `order "A,B,C"` | write |
| `plan tree <c1\|c2\|c3> <target> --boards` | read: the plan tree plus the b-items that link to shown elements |

### The bulk file

```
{ "items": [
  { "ref": "f",   "title": "Quiz export", "kind": "feature", "owner": "K", "links": ["<uid>"], "due": "2026-12-01" },
  { "title": "Write exporter", "kind": "task", "parentRef": "f" },
  { "ref": "fmt", "title": "Pick file format", "kind": "task", "parentRef": "f" },
  { "title": "Export tests", "kind": "task", "parentRef": "f", "dependsOnRefs": ["fmt"] } ] }
```
Keys: `ref`, `title` and `kind` (required), `status` (default `planned`), `owner`, `parent`, `parentRef`, `dependsOn`,
`dependsOnRefs`, `links`, `tags`, `start`, `due`, `group`, `description`, `docs` (a list of spec strings such as
`"path:docs/x.md"` or of `{label?, path?, url?}` objects), `outcome`, `size`, `sprint`, `priority`. `ref` is a key local to the file; `parentRef` and
`dependsOnRefs` name it (a reference may come before the item it names). `parent` and `dependsOn` name items that
ALREADY exist. Ids are minted in file order. Any bad item (unknown kind, bad date, unknown ref or link uid, a cycle)
refuses the whole file and nothing is written.

### What makes a change refuse

The result is checked with the same rules as `c4mp check` (`board-*` findings). A change that adds a NEW warning is
refused: a `dependsOn` or nesting cycle, an unknown parent or dependency, a group the board does not have, reversed
dates, a bad kind or status. Warnings the file already had never block an edit. A file that does not parse is never
edited (the message says what to fix by hand).

## Real run

Run on a copy of this repo's own plan (two boards: `sprint-s12` with 5 items, `backlog` with 1; `b1` has a dead link
and an old due date). `S` stands for the scratch folder.

```
$ c4mp board add --from-file S/feature.json --board sprint-s12 --repo .
add 4 items to board 'sprint-s12':
  b7  feature  planned  K  Quiz export  (ref f)
  b8  task  planned  Write exporter  parent b7
  b9  task  planned  Pick file format  parent b7  (ref fmt)
  b10  task  planned  Export tests  parent b7  depends b9
dry run: nothing written. Add --yes to apply.
```
The same line with `--yes` ends with `written: .c4mp/projects/c4mp/board/board.json`.

```
$ c4mp board tree b7 -r --format text --repo .
b7  [feature]  planned K  Quiz export
  b8  [task]  planned  Write exporter
  b9  [task]  planned  Pick file format
  b10  [task]  planned  Export tests
dependencies:
  b10 waits for b9

$ c4mp board for settings --repo .
c4mp.c4mp.foundation.settings  (uid 24feca1a-ba65-473f-a4c9-44ceab1cd54c)  is linked by 3 items:
  sprint-s12  b3  task  done  Quiz schema  -> 1 link
  sprint-s12  b7  feature  planned  K  Quiz export  due 2026-12-01  -> 1 link
  backlog  b6  task  planned  Later idea  -> 1 link

$ c4mp board show b10 --repo .
b10  task  planned  Export tests
board:       sprint-s12  Sprint S12
parent:      b7  Quiz export  planned
depends on:  b9  Pick file format  planned
fields:      created 2026-10-23

$ c4mp board move b7 --board backlog --yes --repo .
move b7  Quiz export  from board 'sprint-s12' to board 'backlog'
  moves with it (3): b10, b9, b8
  updated: 2026-10-23 on 4 items
written: .c4mp/projects/c4mp/board/board.json

$ c4mp board group add "QA review" --board sprint-s12 --yes --repo .
add group 'QA review' (id qa-review) to board 'sprint-s12'
written: .c4mp/projects/c4mp/board/board.json

$ c4mp board group order "QA review,Needs triage,Planned,Done" --board sprint-s12 --yes --repo .
order groups of board 'sprint-s12': QA review, Needs triage, Planned, Done
written: .c4mp/projects/c4mp/board/board.json

$ c4mp board group remove "QA review" --board sprint-s12 --yes --repo .
remove group 'QA review' (id qa-review) from board 'sprint-s12'
written: .c4mp/projects/c4mp/board/board.json
```

Refusals (exit 1, nothing written):

```
$ c4mp board remove b9 --repo .
error: invalid: cannot remove 'b9': 1 reason (items depend on it or nest under it; remove or change them first)
  - b10 depends on b9

$ c4mp board move b1 --board backlog --yes --repo .
error: invalid: this would make the board worse (1 new problem), nothing changed
  - b3: group 'triage' is not a group of board 'backlog'

$ c4mp board group remove Done --board sprint-s12 --repo .
error: invalid: group 'Done' follows the status 'done' and is built in; only custom groups can be removed

$ c4mp board add --from-file S/bad.json --board sprint-s12 --yes --repo .
error: invalid: 1 problem in the file, nothing changed
  - items[0]: kind 'epic' should be one of task, feature, issue, bug, decision, question
```

A nested item moves alone (b444). Each nest link that would cross boards becomes a dependency, the parent waiting for
the child: here `b3` was nested under `b1` and has the child `b4` (a scratch repo: `backlog` holds `b1` > `b3` > `b4`,
plus `b2` under `b1`):

```
$ c4mp board move b3 --board sprint-s12 --repo .
move b3  Pick file format  from board 'backlog' to board 'sprint-s12' (alone: it was nested under b1)
  nest link b1 > b3 becomes a dependency: b1 depends on b3
  nest link b3 > b4 becomes a dependency: b3 depends on b4
  updated: 2026-11-22 on 3 items
dry run: nothing written. Add --yes to apply.
```
A dependency that already existed is marked `(already a dependency)`; one that would close a cycle refuses the move.

After all of it, `c4mp check` lists exactly the two board findings the starting file already had
(`warning board-dead-link b1`, `info board-overdue b1`): the commands added none.

### Real run: description, docs, outcome, size

Run on a scratch copy of the sample-v2 fixture (`c4mp init`, `plan generate`, `plan ids --yes`), with a `docs/design.md` in
the repo and a `notes.txt` holding three lines of text. `S` stands for the scratch folder.

```
$ c4mp board add --repo . --title "Pick a database" --kind decision --description-file notes.txt --doc "Design=path:docs/design.md" --doc url:https://www.sqlite.org/whentouse.html --size M --sprint S15 --priority high --board main --board-name Main --yes
create board 'main' (Main) and add:
  id: b1
  title: Pick a database
  kind: decision
  status: planned
  sprint: S15
  priority: high
  created: 2026-10-24
  description: "We must pick one database for the quiz data. ..." (179 characters)
  docs: Design=path:docs/design.md; url:https://www.sqlite.org/whentouse.html
  size: M
added b1 to board 'main'

$ c4mp board add --repo . --title "Which login provider?" --kind question --description "Google only, or also email and password?" --doc path:docs/login-notes.md --size S --yes
add to board 'main':
  id: b2
  title: Which login provider?
  kind: question
  status: planned
  created: 2026-10-24
  description: Google only, or also email and password?
  docs: path:docs/login-notes.md
  size: S
  note: docs path 'docs/login-notes.md' does not exist in the repo yet
added b2 to board 'main'

$ c4mp board set b2 --repo . --add-doc "Spec=url:https://example.com/spec" --yes
set b2 (board 'main'):
  updated: (none) -> 2026-10-24
  docs: path:docs/login-notes.md -> path:docs/login-notes.md; Spec=url:https://example.com/spec
  note: docs path 'docs/login-notes.md' does not exist in the repo yet
updated b2

$ c4mp board set b1 --repo . --outcome "SQLite chosen; verified by a prototype run" --status done --owner K --yes
set b1 (board 'main'):
  status: planned -> done
  owner: (none) -> K
  updated: (none) -> 2026-10-24
  closed: (none) -> 2026-10-24
  outcome: (none) -> SQLite chosen; verified by a prototype run
updated b1

$ c4mp board show b1 --repo .
b1  decision  done  K  Pick a database
board:       main  Main
fields:      size M, sprint S15, priority high, created 2026-10-24, updated 2026-10-24, closed 2026-10-24
docs:        Design=path:docs/design.md
             url:https://www.sqlite.org/whentouse.html
outcome:     SQLite chosen; verified by a prototype run
description:
  We must pick one database for the quiz data.
  
  Options: SQLite (simple, one file) or Postgres (needs a server).
  Decision needed before the sprint starts, so the API work can begin.

$ c4mp check --repo .
c4mp check · sample-shop · 1 findings (0 critical, 0 warning, 1 info)
info     board-doc-missing b2  b2: docs[0] path 'docs/login-notes.md' does not exist in the repo
```

### The tests of a task: `board show <id> --with-tests`

A task handed to an agent should say what to run and what to write. `--with-tests` adds the tests of every c-item the
item links (its own links, not those of nested items), and of the c-items below them:

- **to run**: test cases attached to a linked c-item or below it, each with its run command. A subregion link gives the
  tests of its components. A test listed by two links is listed once.
- **to write**: planned tests (`test '<name>' {}` blocks in the plan, added with `c4mp plan add test`) of a linked
  element and its plan children that no test case matches yet.
- **touching**: tests attached elsewhere that reach a linked c-item. Text gives only their count; `--json` lists them.

Plain `board show` reads the board and plan files only. `--with-tests` scans the code with the repo's config (one scan,
like `c4mp check`), so it is slower on a big repo. Text shows at most 20 rows per list (`+N more`); `--json` adds a `tests` object with
`run`, `toWrite`, `touches` (every test, with `id`, `file`, `line`, `name`, `level`, `target`, `run` = `{ command, cwd }`
or null) and `counts`. The command runs in `cwd` (the container root); the text prints it as `cd <cwd> && <command>`.
(The flag is not `--tests`: that name is the scan option for test file patterns on the scanning commands.)

Real run on a copy of the `layers-claim` test fixture with jest in `api/`, two test files, a planned test `refunds` on
Orders, and b1 linking the components Orders and Pages:

```
$ c4mp board show b1 --repo . --with-tests
b1  task  planned  Refunds for orders  -> 2 links
board:       main  Main
links:       u-orders  component  shop.api.logic.orders  Orders
             u-pages  component  shop.web.pages  Pages
tests:       2 to run, 1 to write, 1 touching (attached elsewhere; --json lists them)
  to run:    api/test/orders.test.ts:5  orders › places  (element api/src/orders.ts#placeOrder)
               cd api && npx jest test/orders.test.ts -t "orders places"
             web/test/page.test.ts:3  renders  (element web/src/page.ts#renderPage)
               no run command: no test runner found (config tests.command sets one)
  to write:  refunds  (on shop.api.logic.orders, c4/plan.c4:14)
```

`web/` has no test runner in its root (no jest, vitest or mocha in its `package.json`), so that case has no command;
config `tests.command` sets one.

## The Kanban page

The page (`c4mp view`) cannot write files. After you drag cards or groups it prints the commands that make the
same change: `c4mp board group add "<name>" --board B`, `c4mp board group remove "<name>" --board B`,
`c4mp board group order "A,B,C" --board B`, `c4mp board set <id> --status S [--group none]` and
`c4mp board set <id> --group "<name>"`. Run them with `--yes --repo .`.

The detail panel of a selected item shows the description (line breaks kept, scrolls when long), the documents
(an http or https `url` is a link that opens in a new tab; a `path` is shown as text with a Copy path button, because
the page cannot open repo files), the outcome and the size. On a page with test data it also has a Tests section: the
same three lists as `board show --with-tests` (to run, with the run command and a Copy button; to write; touching), for
the c-items the item links. The List and Kanban views show a small size chip next to
the title, `decision` items have a teal `D` chip and `question` items a magenta `Q` chip, and the search box also
finds words in a description.
