import type Anthropic from "@anthropic-ai/sdk";

export type MediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

// API limits from the vision docs: 10 MB per image counted as base64 text, and 8000 px on each side.
export const MAX_IMAGE_BASE64_CHARS = 10 * 1024 * 1024;
export const MAX_IMAGE_SIDE = 8000;

export const EXTENSION: Record<MediaType, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

// The type comes from the first bytes, so a renamed file is still recognised and a fake one is refused.
export function mediaTypeOf(bytes: Buffer): MediaType | null {
  if (bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return "image/png";
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (bytes.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

// Reads the dimensions from the header. Null when the header is cut or unusual; the API then has the last word.
export function imageSize(bytes: Buffer, type: MediaType): ImageSize | null {
  try {
    if (type === "image/png") {
      if (bytes.length < 24) return null;
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    if (type === "image/gif") {
      if (bytes.length < 10) return null;
      return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
    }
    if (type === "image/webp") return webpSize(bytes);
    return jpegSize(bytes);
  } catch {
    return null;
  }
}

function webpSize(bytes: Buffer): ImageSize | null {
  const chunk = bytes.subarray(12, 16).toString("latin1");
  if (chunk === "VP8X" && bytes.length >= 30) {
    return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
  }
  if (chunk === "VP8 " && bytes.length >= 30) {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L" && bytes.length >= 25) {
    const bits = bytes.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  return null;
}

// Walks the JPEG segments up to the first start-of-frame marker, which holds the size.
function jpegSize(bytes: Buffer): ImageSize | null {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xff) {
      offset++;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
    offset += 2 + length;
  }
  return null;
}

// Checks what the API would refuse, so the error reaches the model in words instead of a failed request.
export function checkImage(bytes: Buffer): { readonly type: MediaType; readonly size: ImageSize | null } | string {
  const type = mediaTypeOf(bytes);
  if (type === null) return "unsupported format (use PNG, JPEG, GIF or WebP)";
  if (Math.ceil(bytes.length / 3) * 4 > MAX_IMAGE_BASE64_CHARS) return "larger than 10 MB in base64";
  const size = imageSize(bytes, type);
  if (size !== null && (size.width > MAX_IMAGE_SIDE || size.height > MAX_IMAGE_SIDE)) {
    return `${size.width}x${size.height} px exceeds the limit of ${MAX_IMAGE_SIDE} px per side`;
  }
  return { type, size };
}

export function imageBlock(bytes: Buffer, type: MediaType): Anthropic.ImageBlockParam {
  return { type: "image", source: { type: "base64", media_type: type, data: bytes.toString("base64") } };
}
