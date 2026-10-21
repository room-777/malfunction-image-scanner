import { defineEnv, string } from "void/env";

export default defineEnv({
  R2_ACCOUNT_ID: string().optional(),
  R2_ACCESS_KEY_ID: string().optional(),
  R2_SECRET_ACCESS_KEY: string().optional(),
});

declare global {
  interface VoidGeneratedEnvBindings {
    QUARANTINE: R2Bucket;
    PUBLIC_UPLOADS: R2Bucket;
  }
}
