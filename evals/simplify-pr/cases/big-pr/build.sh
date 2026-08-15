#!/usr/bin/env bash
# 113 changed files — past GitHub's files(first:100) page size. 110 are
# formatter-only noise, two carry real changes, one is added. Exercises
# pagination in the metadata fetch, chunking in the mutation batch, and
# pagination in the read-back verify; without all three, the tail past the
# first page is silently left expanded (or unverified).
source "$(dirname "$0")/../../fixtures/lib.sh"

mkdir -p src/bulk

for i in $(seq -w 0 109); do
  printf '%s' "export const value$i = {
    name: 'bulk-$i',



    weight: $((10#$i)),
};
" > "src/bulk/f$i.ts"
done

cat > src/keep1.ts <<'EOF'
export function retries(): number {
  return 3;
}
EOF

cat > src/keep2.ts <<'EOF'
export function timeoutMs(): number {
  return 5000;
}
EOF

commit "base"

git checkout -qb pr

scripts/format.sh

cat > src/keep1.ts <<'EOF'
export function retries(): number {
  return 5;
}
EOF

cat > src/keep2.ts <<'EOF'
export function timeoutMs(): number {
  return 8000;
}
EOF

cat > src/new.ts <<'EOF'
export const FEATURE_FLAG = "bulk-import";
EOF

commit "chore: formatter sweep across bulk modules + retry tuning"

add_origin
