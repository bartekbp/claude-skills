#!/usr/bin/env bash
# Both noise classes at once, plus the documented blind spot: a formatter
# sweep (a/b/c), a directory move with one importer (engine, cli), a Go file
# whose block-style import path changes (the skill says these never collapse —
# review manually), a real API change, and a file mixing formatting with a
# logic change.
source "$(dirname "$0")/../../fixtures/lib.sh"

mkdir -p src/core pkg/worker

printf '%s' "export const A = {
    name: 'alpha',



    weight: 1,
};
" > src/a.ts

printf '%s' "export function b(x: number): number {
    return x * 2;



}
" > src/b.ts

printf '%s' "import { A } from './a';

export function label(): string {
    return A.name;
}
" > src/c.ts

cat > src/core/engine.ts <<'EOF'
export function run(steps: string[]): number {
  return steps.length;
}
EOF

cat > src/cli.ts <<'EOF'
import { run } from "./core/engine";

export function main(args: string[]): number {
  return run(args);
}
EOF

cat > pkg/worker/worker.go <<'EOF'
package worker

import (
	"fmt"

	"acme.example/legacy/queue"
)

func Drain() {
	fmt.Println(queue.Pop())
}
EOF

cat > src/api.ts <<'EOF'
export function statusCode(ok: boolean): number {
  return ok ? 200 : 500;
}
EOF

printf '%s' "export function backoffMs(attempt: number): number {
    return attempt * 100;



}
" > src/d.ts

commit "base"

git checkout -qb pr

scripts/format.sh

mkdir -p src/runtime
git mv src/core/engine.ts src/runtime/engine.ts
rmdir src/core
sed -i 's|"./core/engine"|"./runtime/engine"|' src/cli.ts

sed -i 's|acme.example/legacy/queue|acme.example/platform/queue|' pkg/worker/worker.go

cat > src/api.ts <<'EOF'
export function statusCode(ok: boolean): number {
  return ok ? 200 : 503;
}
EOF

# formatted AND the multiplier changes — substantive
cat > src/d.ts <<'EOF'
export function backoffMs(attempt: number): number {
  return attempt * 250;
}
EOF

commit "refactor: runtime module + queue import migration"

add_origin
