# Contributing to C4MP

C4MP ("your crew, your map, your plan, in one camp") reads a repository and a folder of plain-text `.c4` plan files
and shows both as one zoomable map, so you can see where the plan and the code disagree. Thank you for helping.

## Build and test

You need Node.js 20 or newer. From the engine folder:

```
npm ci
npm run build        # tsc -p tsconfig.build.json
npm test             # jest
npm run typecheck    # tsc -p tsconfig.test.json (also checks the tests)
```

Run one test file with `npx jest test/<name>.test.ts`. Run `npm run cli -- <command>` to try the CLI from source.

## Code style

There is no separate formatter. The rules are what `tsconfig.json` enforces (`strict` is on) and what the existing
code does: follow the style of the file you edit. `npm run typecheck` and `npm test` must pass before you open a pull
request.

## Adding a language

Each language is one folder in `src/languages/` (for example `src/languages/typescript/`) with an `index.ts` that
exports a language descriptor (the shape is in `src/languages/define.ts`): file extensions, the outline of
functions and classes, imports, calls, and import resolution. The one list of languages is `src/languages/registry.ts`:
add your descriptor there and the rest (extension lists, handlers, manifests, smoke checks) is derived from it.
Copy the nearest existing language, add tests next to the others in `test/`, and keep fixtures small.

## Plan first

C4MP plans its own architecture in `.c4` files. Before you add a new file or function, add it to the plan as planned
and link it after you build it. The format is in the plan standard (`Document/PLAN-STANDARD.md` in the project
documents) and `c4mp guide c4`. Small fixes need no plan change.

## Sign off your commits (DCO)

We use the Developer Certificate of Origin (https://developercertificate.org). Sign every commit with
`git commit -s`, which adds a line `Signed-off-by: Your Name <you@example.com>`. By signing off you certify, in short:

1. You wrote the change, or you have the right to submit it under this project's open source licence.
2. Or it is based on earlier work that carries a compatible open source licence, and you have the right to pass it on.
3. Or it was given to you by someone who certified 1 or 2, and you did not change it.
4. You understand that the contribution and your sign-off are public and kept with the project.

A forgotten sign-off on the last commit: `git commit --amend -s`. On several commits:
`git rebase --signoff <base>`.

## Pull requests

Branch from the latest `develop`, keep a pull request to one topic, describe what and why, and say how you tested it.
Be kind: see `CODE_OF_CONDUCT.md`. Report security problems privately: see `SECURITY.md`.
