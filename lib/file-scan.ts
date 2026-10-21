import type { ImageMime } from "./upload";

export type { ImageMime } from "./upload";

const EICAR = new TextEncoder().encode(
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*",
);

export function sniffImage(bytes: Uint8Array): ImageMime | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  return null;
}

export function containsEicar(bytes: Uint8Array): boolean {
  outer: for (let i = 0; i <= bytes.length - EICAR.length; i++) {
    for (let j = 0; j < EICAR.length; j++) {
      if (bytes[i + j] !== EICAR[j]) continue outer;
    }
    return true;
  }
  return false;
}

export function stripExif(bytes: Uint8Array, mime: ImageMime): Uint8Array {
  if (mime === "image/jpeg") {
    const output: Uint8Array<ArrayBufferLike>[] = [bytes.slice(0, 2)];
    let offset = 2;
    while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
      const marker = bytes[offset + 1];
      if (marker === 0xda || marker === 0xd9) break;
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
      if (length < 2 || offset + 2 + length > bytes.length) return bytes;
      const segment = bytes.subarray(offset, offset + 2 + length);
      if (!(marker === 0xe1 && new TextDecoder().decode(segment.subarray(4, 10)) === "Exif\0\0")) {
        output.push(segment);
      }
      offset += 2 + length;
    }
    output.push(bytes.slice(offset));
    return concat(output);
  }

  const output: Uint8Array<ArrayBufferLike>[] = [bytes.slice(0, 8)];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
    const end = offset + 12 + length;
    if (end > bytes.length) return bytes;
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
    if (type !== "eXIf") output.push(bytes.subarray(offset, end));
    offset = end;
    if (type === "IEND") break;
  }
  output.push(bytes.slice(offset));
  return concat(output);
}

function concat(parts: Uint8Array<ArrayBufferLike>[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
