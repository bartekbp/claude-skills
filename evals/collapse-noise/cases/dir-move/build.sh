#!/usr/bin/env bash
# src/utils/ moves to src/lib/. The moved files and two importers carry
# path-only edits (noise). service.ts updates the path but ALSO imports a new
# symbol, and main.ts changes logic — both must stay expanded. Everything is
# pre-formatted, so the formatter test alone catches nothing and the
# import-path fallback has to do the work.
source "$(dirname "$0")/../../fixtures/lib.sh"

mkdir -p src/utils

cat > src/utils/math.ts <<'EOF'
export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export function sum(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}
EOF

cat > src/utils/strings.ts <<'EOF'
export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

export function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}
EOF

cat > src/app.ts <<'EOF'
import { clamp } from "./utils/math";

export function pageSize(requested: number): number {
  return clamp(requested, 1, 100);
}
EOF

cat > src/report.ts <<'EOF'
import { sum } from "./utils/math";
import { slugify } from "./utils/strings";

export function reportKey(title: string): string {
  return slugify(title);
}

export function total(amounts: number[]): number {
  return sum(amounts);
}
EOF

cat > src/service.ts <<'EOF'
import { slugify } from "./utils/strings";

export function channelName(raw: string): string {
  return slugify(raw);
}
EOF

cat > src/main.ts <<'EOF'
import { pageSize } from "./app";

export function defaultPage(): number {
  return pageSize(20);
}
EOF

commit "base"

git checkout -qb pr

mkdir -p src/lib
git mv src/utils/math.ts src/lib/math.ts
git mv src/utils/strings.ts src/lib/strings.ts
rmdir src/utils

sed -i 's|"./utils/|"./lib/|' src/app.ts src/report.ts

# path update PLUS a new import and behavior — substantive
cat > src/service.ts <<'EOF'
import { slugify, truncate } from "./lib/strings";

export function channelName(raw: string): string {
  return truncate(slugify(raw), 24);
}
EOF

cat > src/main.ts <<'EOF'
import { pageSize } from "./app";

export function defaultPage(): number {
  return pageSize(25);
}
EOF

commit "refactor: move utils to lib"

add_origin
