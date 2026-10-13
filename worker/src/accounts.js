// Regras de conta: matrícula, telefone, senha provisória e política de senha.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sem I, O, 0, 1

const COMMON = new Set([
  "12345678", "123456789", "1234567890", "87654321", "11111111", "00000000",
  "senha123", "senha1234", "mudar123", "mudar1234", "abc12345", "qwerty123",
  "password", "password1", "escola123", "educacao", "educacao123",
]);

export function tempPassword() {
  const buf = new Uint8Array(10);
  const limit = 256 - (256 % ALPHABET.length); // evita viés de módulo
  let raw = "";
  while (raw.length < 10) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < limit && raw.length < 10) raw += ALPHABET[b % ALPHABET.length];
    }
  }
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

export const normMatricula = (raw) => String(raw ?? "").replace(/\D/g, "");
export const validMatricula = (m) => m.length >= 3 && m.length <= 15;

/** Retorna só dígitos (DDD+número) ou "" se vazio. Lança Error se inválido. */
export function normalizePhone(raw) {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) d = d.slice(2);
  if (d.length !== 10 && d.length !== 11) {
    throw new Error("Telefone inválido. Use DDD + número, ex.: (83) 99999-9999.");
  }
  return d;
}

/** Mensagem do problema, ou null se a senha é aceitável. */
export function passwordProblem(nova, matricula, atual = null) {
  if (nova.length < 8) return "A senha deve ter pelo menos 8 caracteres.";
  if (nova.length > 128) return "A senha é longa demais (máximo 128 caracteres).";
  if (matricula && nova.includes(matricula)) return "A senha não pode conter a sua matrícula.";
  if (COMMON.has(nova.toLowerCase()) || new Set(nova).size <= 2) {
    return "Senha fácil demais. Evite sequências como 12345678 ou senha123.";
  }
  if (atual !== null && nova === atual) return "A nova senha deve ser diferente da atual.";
  return null;
}
