/** Small helpers for reading raw environment values (used before zod runs). */

export function env(key, fallback = undefined) {
  const value = process.env[key];
  return value === undefined || value === '' ? fallback : value;
}

export function envNumber(key, fallback) {
  const raw = env(key);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function envInt(key, fallback) {
  const parsed = envNumber(key, undefined);
  return parsed === undefined ? fallback : Math.trunc(parsed);
}

export function envBool(key, fallback = false) {
  const raw = env(key);
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}
