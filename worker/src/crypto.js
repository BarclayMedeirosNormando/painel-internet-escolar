// Senhas (PBKDF2-SHA256) e tokens de sessão assinados (HMAC-SHA256) via WebCrypto.
const enc = new TextEncoder();
export const MAX_ITERATIONS = 100000; // máximo aceito pelo Workers
let iterations = MAX_ITERATIONS;
/** Custo do PBKDF2 para NOVAS senhas (cada hash guarda o seu). Reduza só se o plano gratuito estourar o limite de CPU. */
export function setIterations(n) { iterations = Math.min(MAX_ITERATIONS, Math.max(10000, Number(n) || MAX_ITERATIONS)); }

export function b64u(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function unb64u(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function hashPassword(pw, salt = crypto.getRandomValues(new Uint8Array(16)), iter = iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256);
  return `pbkdf2$${iter}$${b64u(salt)}$${b64u(bits)}`;
}

export async function verifyPassword(pw, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const calc = await hashPassword(pw, unb64u(parts[2]), Number(parts[1]));
  return safeEqual(calc, stored);
}

/** Impressão digital do hash: amarra o token à senha atual (trocar/redefinir invalida sessões). */
export const pwFingerprint = (stored) => String(stored).slice(-16);

async function hmac(data, secret) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

export async function signToken(payload, secret) {
  const body = b64u(enc.encode(JSON.stringify(payload)));
  return `${body}.${await hmac(body, secret)}`;
}

export async function verifyToken(token, secret) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) return null;
  if (!safeEqual(await hmac(body, secret), sig)) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(unb64u(body)));
    if (!p.exp || p.exp < Math.floor(Date.now() / 1000)) return null;
    return p;
  } catch { return null; }
}
