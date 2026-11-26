# c4mp <version> release

Install in 3 steps:

1. Unzip this release.
2. `cd` into the unzipped folder and run `bash release-install.sh`.
   - If a c4mp with a different version is already installed, the script shows the old and new versions and asks `Replace existing c4mp <old> with <new>? [y/N]`. Type `y` to replace; anything else leaves it unchanged.
   - If it is the same version, it says `Already installed` and changes nothing.
3. Open a new terminal and run `c4mp --version`.

Notes:

- Needs Node 20+.
- The script writes only inside this folder and npm's global link. It never uses sudo.
- No `npm install` is needed (node_modules is included).
- `C4MP_ASSUME_YES=1 bash release-install.sh` skips the question (needed when not run from a terminal). The old name `C4PM_ASSUME_YES` still works.
- On `FAIL`, send the printed text to K.
- Check the native parsers on this machine: `node scripts/grammar-smoke.js`; send the output to K.

For the commands, run c4mp --help.
