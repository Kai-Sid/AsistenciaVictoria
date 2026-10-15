import { HttpError } from "./http-error.js";

export const MAX_YAPE_QR_BYTES = 300_000;

export type YapeQrContentType = "image/jpeg" | "image/png" | "image/webp";

export type YapeQrImage = {
  contentType: YapeQrContentType;
  bytes: Buffer;
};

export function yapeQrContentType(bytes: Buffer): YapeQrContentType | null {
  if (bytes.length < 32 || bytes.length > MAX_YAPE_QR_BYTES) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length >= png.length && bytes.subarray(0, png.length).equals(png)) return "image/png";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

export function parseYapeQrRequest(body: unknown): { employeeId: string; remove: true } | { employeeId: string; image: YapeQrImage } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Datos no válidos.");
  const record = body as { employeeId?: unknown; remove?: unknown; image?: unknown };
  const employeeId = String(record.employeeId ?? "").trim();
  if (!employeeId || employeeId.includes("/") || employeeId.length > 128) throw new HttpError(400, "Datos no válidos.");
  if (record.remove === true) return { employeeId, remove: true };
  if (typeof record.image !== "string" || record.image.length === 0 || record.image.length > 410_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(record.image)) {
    throw new HttpError(400, "La imagen del QR no es válida. Sube el código que generó el trabajador en Yape.");
  }
  const bytes = Buffer.from(record.image, "base64");
  if (bytes.toString("base64") !== record.image) {
    throw new HttpError(400, "La imagen del QR no es válida. Sube el código que generó el trabajador en Yape.");
  }
  const contentType = yapeQrContentType(bytes);
  if (!contentType) throw new HttpError(400, "La imagen debe ser JPEG, PNG o WebP, de hasta 300 KB.");
  return { employeeId, image: { contentType, bytes } };
}
