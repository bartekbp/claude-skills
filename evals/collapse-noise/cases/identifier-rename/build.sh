#!/usr/bin/env bash
# The PR renames the userBonus concept to wagering. ledger.ts and labels.ts
# change only by that rename in every case style (userBonusId, UserBonus,
# user_bonus_id, USER_BONUS, "user bonus"); the moved user-bonus.ts carries the
# rename plus import-path edits. payout.ts renames AND changes a limit — it
# must stay expanded, and so must the
# rename-only schema/user_bonus.sql, which defines a stored name.
source "$(dirname "$0")/../../fixtures/lib.sh"

mkdir -p src/bonus schema

cat > schema/user_bonus.sql <<'EOF2'
CREATE TABLE user_bonus (user_bonus_id INT PRIMARY KEY);
EOF2

cat > src/bonus/user-bonus.ts <<'EOF2'
export interface UserBonus {
  userBonusId: number;
  balance: number;
}
EOF2

cat > src/ledger.ts <<'EOF2'
import { UserBonus } from "./bonus/user-bonus";

export const USER_BONUS_TABLE = "user_bonus";

export function balanceOf(userBonus: UserBonus): number {
  return userBonus.balance;
}

export function keyOf(userBonus: UserBonus): string {
  return `user_bonus_id:${userBonus.userBonusId}`;
}
EOF2

cat > src/labels.ts <<'EOF2'
export function describe(id: number): string {
  // The user bonus this label names.
  return `User bonus ${id}`;
}
EOF2

cat > src/payout.ts <<'EOF2'
import { UserBonus } from "./bonus/user-bonus";

export const MAX_PAYOUT = 100;

export function payout(userBonus: UserBonus): number {
  return Math.min(userBonus.balance, MAX_PAYOUT);
}
EOF2

commit "base"

git checkout -qb pr

mkdir -p src/wagering
git mv src/bonus/user-bonus.ts src/wagering/wagering.ts
rmdir src/bonus
cat > src/wagering/wagering.ts <<'EOF2'
export interface Wagering {
  wageringId: number;
  balance: number;
}
EOF2

cat > schema/user_bonus.sql <<'EOF2'
CREATE TABLE wagering (wagering_id INT PRIMARY KEY);
EOF2

cat > src/ledger.ts <<'EOF2'
import { Wagering } from "./wagering/wagering";

export const WAGERING_TABLE = "wagering";

export function balanceOf(wagering: Wagering): number {
  return wagering.balance;
}

export function keyOf(wagering: Wagering): string {
  return `wagering_id:${wagering.wageringId}`;
}
EOF2

cat > src/labels.ts <<'EOF2'
export function describe(id: number): string {
  // The wagering this label names.
  return `Wagering ${id}`;
}
EOF2

cat > src/payout.ts <<'EOF2'
import { Wagering } from "./wagering/wagering";

export const MAX_PAYOUT = 250;

export function payout(wagering: Wagering): number {
  return Math.min(wagering.balance, MAX_PAYOUT);
}
EOF2

commit "refactor: rename user bonus to wagering"

add_origin
