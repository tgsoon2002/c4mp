// Removes this run's temp root made by test/globalSetup.js (b626).
// The prefix check guards against removing anything else.
const fs = require('fs');
const path = require('path');

module.exports = async () => {
  const runRoot = process.env.C4PM_TEST_TMP_ROOT;
  if (runRoot && path.basename(runRoot).startsWith('c4pm-jest-')) fs.rmSync(runRoot, { recursive: true, force: true });
};
