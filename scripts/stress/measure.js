// Preloaded into the c4pm process (node -r measure.js cli.js ...). On exit it
// writes peak memory and CPU time to $STRESS_MEASURE_OUT, so the runner gets
// numbers for the child process itself, the same way on every platform.
const fs = require('fs');
const out = process.env.STRESS_MEASURE_OUT;
if (out) {
  process.on('exit', (code) => {
    const r = process.resourceUsage();
    // maxRSS is in kilobytes on every platform Node supports.
    fs.writeFileSync(out, JSON.stringify({ code, maxRssKb: r.maxRSS, userMs: r.userCPUTime / 1000, sysMs: r.systemCPUTime / 1000 }));
  });
}
