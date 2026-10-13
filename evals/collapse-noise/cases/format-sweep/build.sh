#!/usr/bin/env bash
# A formatter sweep rode along with a feature: six files are formatter-only
# noise, one is a pure feature change, one mixes formatting with a logic
# change (must stay expanded), one is added (must stay expanded).
source "$(dirname "$0")/../../fixtures/lib.sh"

mkdir -p src

ugly() { # $1 = path, $2 = body — single quotes and triple blanks are the dirt
  printf '%s' "$2" > "$1"
}

ugly src/config.ts "export const config = {
    apiUrl: 'https://api.acme.example',
    retries: 3,



    timeoutMs: 5000,
};
"

ugly src/logger.ts "export function log(level: string, message: string) {
    console.log('[' + level + '] ' + message);
}



export function warn(message: string) {
    log('warn', message);
}
"

ugly src/http.ts "import { config } from './config';

export async function get(path: string) {
    const response = await fetch(config.apiUrl + path);



    return response.json();
}
"

ugly src/dates.ts "export function isoDay(date: Date): string {
    return date.toISOString().slice(0, 10);
}



export const EPOCH = '1970-01-01';
"

ugly src/ids.ts "let counter = 0;

export function nextId(prefix: string): string {
    counter += 1;



    return prefix + '-' + counter;
}
"

ugly src/env.ts "export function envOr(name: string, fallback: string): string {
    return process.env[name] ?? fallback;
}



export const NODE_ENV = envOr('NODE_ENV', 'development');
"

cat > src/feature.ts <<'EOF'
import { get } from "./http";

export async function fetchUser(id: string) {
  return get("/users/" + id);
}
EOF

ugly src/mixed.ts "import { log } from './logger';

export function retryCount(attempt: number): number {
    if (attempt > 5) {



        return 0;
    }
    log('info', 'attempt ' + attempt);
    return attempt + 1;
}
"

commit "base"

git checkout -qb pr

scripts/format.sh

cat > src/feature.ts <<'EOF'
import { get } from "./http";

export async function fetchUser(id: string) {
  return get("/users/" + id);
}

export async function fetchUserOrders(id: string) {
  return get("/users/" + id + "/orders");
}
EOF

# formatting cleanup AND a behavior change: the cap moves from 5 to 3
cat > src/mixed.ts <<'EOF'
import { log } from "./logger";

export function retryCount(attempt: number): number {
  if (attempt > 3) {
    return 0;
  }
  log("info", "attempt " + attempt);
  return attempt + 1;
}
EOF

cat > src/new-module.ts <<'EOF'
export function parseCursor(raw: string): number {
  const value = Number.parseInt(raw, 10);
  return Number.isNaN(value) ? 0 : value;
}
EOF

commit "feat: user orders endpoint + formatter sweep"

add_origin
