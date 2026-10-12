export const PUBLISHED_WEB_ORIGIN = "https://asistenciavictoria-web.onrender.com";

export function resolveAllowedOrigins(raw: string | undefined): string[] {
  const configured = (raw ?? "http://localhost:5174")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return [...new Set([...configured, PUBLISHED_WEB_ORIGIN])];
}
