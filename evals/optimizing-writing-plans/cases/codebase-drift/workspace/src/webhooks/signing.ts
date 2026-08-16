import { createHmac } from "node:crypto";

/** HMAC-SHA256 signature every outbound webhook body is signed with. */
export function signPayload(secret: string, payload: unknown): string {
  return createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");
}
