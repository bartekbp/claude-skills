#!/usr/bin/env bash
# No mechanical noise at all: three files, every change substantive, already
# formatted. The right move is to mark nothing — the restraint case.
source "$(dirname "$0")/../../fixtures/lib.sh"

mkdir -p src

cat > src/auth.ts <<'EOF'
export function tokenTtlSeconds(remember: boolean): number {
  return remember ? 86400 : 3600;
}
EOF

cat > src/session.ts <<'EOF'
import { tokenTtlSeconds } from "./auth";

export function sessionExpiry(now: number, remember: boolean): number {
  return now + tokenTtlSeconds(remember) * 1000;
}
EOF

cat > src/routes.ts <<'EOF'
export const routes = {
  login: "/login",
  logout: "/logout",
};
EOF

commit "base"

git checkout -qb pr

cat > src/auth.ts <<'EOF'
export function tokenTtlSeconds(remember: boolean): number {
  return remember ? 604800 : 3600;
}
EOF

cat > src/session.ts <<'EOF'
import { tokenTtlSeconds } from "./auth";

export function sessionExpiry(now: number, remember: boolean): number {
  const skewMs = 5000;
  return now + tokenTtlSeconds(remember) * 1000 - skewMs;
}
EOF

commit "fix: extend remember-me TTL, apply clock skew"

add_origin
