import { deepStrictEqual, equal } from "node:assert";
import { containsEicar, sniffImage, stripExif } from "../lib/file-scan";
import { createUploadKey, getUploadIdFromKey, isUploadFinished, toUploadView } from "../lib/upload";

const jpeg = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0xff, 0xda, 0x00, 0x02,
  0x11, 0x22,
]);
const expected = Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0x11, 0x22]);
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const uploadId = "01234567-89ab-cdef-0123-456789abcdef";

equal(sniffImage(jpeg), "image/jpeg");
equal(sniffImage(png), "image/png");
equal(sniffImage(new TextEncoder().encode("not an image")), null);
equal(
  containsEicar(
    new TextEncoder().encode(
      "prefix X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H* suffix",
    ),
  ),
  true,
);
equal(containsEicar(jpeg), false);
deepStrictEqual(stripExif(jpeg, "image/jpeg"), expected);
equal(isUploadFinished("uploading"), false);
equal(isUploadFinished("scanning"), false);
equal(isUploadFinished("ready"), true);
equal(isUploadFinished("rejected"), true);
equal(createUploadKey(uploadId), `uploads/${uploadId}`);
equal(getUploadIdFromKey(createUploadKey(uploadId)), uploadId);
equal(getUploadIdFromKey(`other/${uploadId}`), null);
const uploadWithInternalKey = {
  id: "upload-id",
  key: "uploads/secret",
  name: "photo.png",
  status: "ready" as const,
  mime: "image/png" as const,
  reason: null,
  createdAt: 123,
};
deepStrictEqual(toUploadView(uploadWithInternalKey), {
  id: "upload-id",
  name: "photo.png",
  status: "ready",
  mime: "image/png",
  reason: null,
  createdAt: 123,
  url: "/api/public/upload-id",
});
