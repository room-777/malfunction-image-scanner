export interface R2UploadEvent {
  action: string;
  bucket: string;
  object: { key: string; size: number };
}
