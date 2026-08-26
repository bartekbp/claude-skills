#!/usr/bin/env bash
# The fixture project's auto-formatter, standing in for prettier/biome:
#   - single-quoted strings become double-quoted
#   - trailing whitespace is stripped
#   - runs of blank lines collapse to one
#   - the file ends with exactly one newline
# Every transform is idempotent, so formatted files are a fixed point — the
# property the compress-pr detection ("format the base, compare to head")
# depends on. JS/TS only; .go files are untouched, like a real JS formatter.
#
# Usage: scripts/format.sh [files...]    no args: every tracked .ts/.js file
set -euo pipefail
cd "$(dirname "$0")/.."

if [ $# -gt 0 ]; then
  files=("$@")
else
  mapfile -t files < <(git ls-files '*.ts' '*.js')
fi
[ "${#files[@]}" -eq 0 ] && exit 0

python3 - "${files[@]}" <<'PY'
import re
import sys

for path in sys.argv[1:]:
    if not path.endswith((".ts", ".js")):
        continue
    with open(path) as f:
        src = f.read()
    lines = []
    for line in src.split("\n"):
        line = line.rstrip()
        line = re.sub(r"'([^'\"]*)'", r'"\1"', line)
        lines.append(line)
    text = "\n".join(lines)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = text.strip("\n") + "\n"
    with open(path, "w") as f:
        f.write(text)
PY
