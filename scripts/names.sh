# names.sh: the product names in ONE place for every shell script of Project/scripts (POSIX sh, sourced, never run).
# Use:  . "$(dirname "$0")/names.sh"      (bash scripts: . "$SCRIPT_DIR/names.sh")
# install.sh is downloaded alone by curl and cannot source this file: it repeats the C4MP_NAME .. C4MP_TAP lines
# inline, and test/install-script.test.ts proves the two copies are equal. Change a name here and in install.sh together.
C4MP_NAME=c4mp
C4MP_PRODUCT=C4MP
C4MP_LEGACY_NAME=c4pm
C4MP_RELEASES_REPO=tgsoon2002/c4mp-releases
C4MP_TAP=tgsoon2002/c4mp

# c4mp_env <SUFFIX>: print the value of the env var C4MP_<SUFFIX>; when it is unset or empty, of the old C4PM_<SUFFIX>
# (read for 2 more versions); empty when neither is set. Example: DIR="$(c4mp_env RELEASE_DIR)".
c4mp_env() {
  c4mp_env_value=""
  eval "c4mp_env_value=\"\${C4MP_$1:-}\""
  if [ -z "$c4mp_env_value" ]; then eval "c4mp_env_value=\"\${C4PM_$1:-}\""; fi
  printf '%s' "$c4mp_env_value"
}

# c4mp_top <project dir>: the top folder that holds Release/ and the brand folder: the git top level of <project dir>
# (private repo: the folder above Project/; public repo: the clone itself), else <project dir> (a plain copy, no git).
c4mp_top() {
  c4mp_top_value="$(git -C "$1" rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -z "$c4mp_top_value" ]; then c4mp_top_value="$1"; fi
  printf '%s' "$c4mp_top_value"
}

# c4mp_brand_dir <top>: <top>/Brand when it exists, else <top>/brand (the public tree), else <top>/Brand.
c4mp_brand_dir() {
  if [ -d "$1/Brand" ] || [ ! -d "$1/brand" ]; then printf '%s/Brand' "$1"; else printf '%s/brand' "$1"; fi
}

# c4mp_binary_name <version> <platform>: the release binary file name, e.g. c4mp-0.11.0-darwin-arm64 (add .exe on Windows).
c4mp_binary_name() { printf '%s-%s-%s' "$C4MP_NAME" "$1" "$2"; }

# c4mp_zip_name <version> <stamp>: the release zip file name, e.g. c4mp_0.11.0_20261201-1200.zip.
c4mp_zip_name() { printf '%s_%s_%s.zip' "$C4MP_NAME" "$1" "$2"; }
