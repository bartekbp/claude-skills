#!/usr/bin/env bash
# Noise the formatter can't reproduce: a JSON file with reordered keys, a YAML
# file with reordered keys (comments untouched), and a TS file whose only change
# is indentation. Two traps that MUST stay expanded: a YAML file where only a
# comment changed (comments are for reviewers), and a Python file with a
# whitespace change (whitespace is semantics there). Plus one real change.
source "$(dirname "$0")/../../fixtures/lib.sh"

mkdir -p src config

cat > config/app.json <<'EOF'
{
  "timeoutMs": 5000,
  "retries": 3,
  "baseUrl": "https://api.acme.example"
}
EOF

cat > config/deploy.yaml <<'EOF'
# deployment knobs for the acme webapp
replicas: 3
image: acme/webapp
ports:
  - 8080
  - 9090
EOF

cat > config/notes.yaml <<'EOF'
# rollout is gated on the EU cluster
gate: eu-cluster
window: nightly
EOF

cat > src/ws.ts <<'EOF'
export function area(w: number, h: number): number {
  if (w < 0 || h < 0) {
    return 0;
  }
  return w * h;
}
EOF

cat > src/pad.py <<'EOF'
def area(w, h):
    if w < 0 or h < 0:
        return 0
    return w * h
EOF

cat > src/real.ts <<'EOF'
export const MAX_UPLOAD_MB = 25;
EOF

commit "base"

git checkout -qb pr

cat > config/app.json <<'EOF'
{
    "baseUrl": "https://api.acme.example",
    "retries": 3,
    "timeoutMs": 5000
}
EOF

cat > config/deploy.yaml <<'EOF'
# deployment knobs for the acme webapp
image: acme/webapp
ports:
  - 8080
  - 9090
replicas: 3
EOF

# only the comment changes — reviewers read comments, must stay expanded
cat > config/notes.yaml <<'EOF'
# rollout is gated on the US cluster
gate: eu-cluster
window: nightly
EOF

# indentation only — whitespace is not semantic in TS
cat > src/ws.ts <<'EOF'
export function area(w: number, h: number): number {
    if (w < 0 || h < 0) {
        return 0;
    }
    return w * h;
}
EOF

# whitespace change in Python — semantic, must stay expanded
cat > src/pad.py <<'EOF'
def area(w, h):
        if w < 0 or h < 0:
            return 0
        return w * h
EOF

cat > src/real.ts <<'EOF'
export const MAX_UPLOAD_MB = 50;
EOF

commit "chore: config cleanup"

add_origin
