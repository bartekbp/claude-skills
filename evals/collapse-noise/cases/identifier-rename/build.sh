#!/usr/bin/env bash
# The PR renames the shopCart concept to basket. ledger.ts and labels.ts
# change only by that rename in every case style (shopCartId, ShopCart,
# shop_cart_id, SHOP_CART, "shop cart"); the moved shop-cart.ts carries the
# rename plus import-path edits. payout.ts renames AND changes a limit — it
# must stay expanded, and so must the
# rename-only schema/shop_cart.sql, which defines a stored name.
source "$(dirname "$0")/../../fixtures/lib.sh"

mkdir -p src/cart schema

cat > schema/shop_cart.sql <<'EOF2'
CREATE TABLE shop_cart (shop_cart_id INT PRIMARY KEY);
EOF2

cat > src/cart/shop-cart.ts <<'EOF2'
export interface ShopCart {
  shopCartId: number;
  balance: number;
}
EOF2

cat > src/ledger.ts <<'EOF2'
import { ShopCart } from "./cart/shop-cart";

export const SHOP_CART_TABLE = "shop_cart";

export function balanceOf(shopCart: ShopCart): number {
  return shopCart.balance;
}

export function keyOf(shopCart: ShopCart): string {
  return `shop_cart_id:${shopCart.shopCartId}`;
}
EOF2

cat > src/labels.ts <<'EOF2'
export function describe(id: number): string {
  // The shop cart this label names.
  return `Shop cart ${id}`;
}
EOF2

cat > src/payout.ts <<'EOF2'
import { ShopCart } from "./cart/shop-cart";

export const MAX_PAYOUT = 100;

export function payout(shopCart: ShopCart): number {
  return Math.min(shopCart.balance, MAX_PAYOUT);
}
EOF2

commit "base"

git checkout -qb pr

mkdir -p src/basket
git mv src/cart/shop-cart.ts src/basket/basket.ts
rmdir src/cart
cat > src/basket/basket.ts <<'EOF2'
export interface Basket {
  basketId: number;
  balance: number;
}
EOF2

cat > schema/shop_cart.sql <<'EOF2'
CREATE TABLE basket (basket_id INT PRIMARY KEY);
EOF2

cat > src/ledger.ts <<'EOF2'
import { Basket } from "./basket/basket";

export const BASKET_TABLE = "basket";

export function balanceOf(basket: Basket): number {
  return basket.balance;
}

export function keyOf(basket: Basket): string {
  return `basket_id:${basket.basketId}`;
}
EOF2

cat > src/labels.ts <<'EOF2'
export function describe(id: number): string {
  // The basket this label names.
  return `Basket ${id}`;
}
EOF2

cat > src/payout.ts <<'EOF2'
import { Basket } from "./basket/basket";

export const MAX_PAYOUT = 250;

export function payout(basket: Basket): number {
  return Math.min(basket.balance, MAX_PAYOUT);
}
EOF2

commit "refactor: rename shop cart to basket"

add_origin
