# Stress harness

Board item b180 on the `stress-test` board. Finds where c4pm breaks by growing one dimension of a
synthetic repository (file count, huge file, imports per file, folder depth, commits) until a step fails.

```
npm run build
npx ts-node scripts/stress/run.ts                          # smoke: a few seconds
npx ts-node scripts/stress/run.ts --suite scale            # every ladder, up to 100k files
npx ts-node scripts/stress/run.ts --suite scale --only bigfile --heap 512 --timeout 300
npx ts-node scripts/stress/run.ts --cli /Applications/c4pm/dist/bin/cli.js   # test an installed release
```

- `gen.ts` writes a deterministic git repo per spec into `$TMPDIR/c4pm-stress/<spec key>` and reuses it.
- `run.ts` runs snapshot, generate-c4, ids, check, view (or history, diff) on each rung. It stops a ladder
  at the first failure, so the last `ok` rung and the first failing rung bracket the limit.
- `measure.js` is preloaded into the c4pm process and reports its own peak RSS and CPU time.
- Results: `out/stress/<timestamp>/results.jsonl` (one object per step) and `summary.md`.

A step fails on a non-zero exit, a signal (out of memory kills show as `KILLED SIGKILL` or exit 134),
or the timeout (default 900 s).
