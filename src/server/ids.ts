import { randomBytes } from "node:crypto";

const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";

/** Short, URL-safe, unambiguous ids like "k3m9xq2p". */
export function newId(len = 10): string {
  const bytes = randomBytes(len);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}
