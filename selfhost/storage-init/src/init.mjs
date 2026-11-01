/**
 * One-shot bucket initializer for the self-hosted S3-compatible store.
 *
 * Creates the public/private buckets and sets anonymous download on the
 * public bucket (matching how dub's R2 buckets are configured upstream).
 * Works against any S3-compatible endpoint (RustFS, MinIO, external S3).
 */
import { AwsClient } from "aws4fetch";

const ENDPOINT = (process.env.STORAGE_ENDPOINT || "").replace(/\/$/, "");
const ACCESS_KEY = process.env.STORAGE_ACCESS_KEY_ID || "";
const SECRET_KEY = process.env.STORAGE_SECRET_ACCESS_KEY || "";
const PUBLIC_BUCKET = process.env.STORAGE_PUBLIC_BUCKET || "dub-public";
const PRIVATE_BUCKET = process.env.STORAGE_PRIVATE_BUCKET || "dub-private";

if (!ENDPOINT || !ACCESS_KEY || !SECRET_KEY) {
  console.error("[storage-init] STORAGE_ENDPOINT / STORAGE_ACCESS_KEY_ID / STORAGE_SECRET_ACCESS_KEY are required");
  process.exit(1);
}

const client = new AwsClient({
  accessKeyId: ACCESS_KEY,
  secretAccessKey: SECRET_KEY,
  service: "s3",
  region: process.env.STORAGE_REGION || "us-east-1",
});

async function ensureBucket(bucket) {
  const res = await client.fetch(ENDPOINT + "/" + bucket, { method: "PUT" });
  // 200 ok / 409 bucket-already-owned-by-you are both fine
  if (res.ok || res.status === 409) {
    console.log("[storage-init] bucket ready:", bucket);
    return;
  }
  throw new Error("create bucket " + bucket + " failed: HTTP " + res.status + " " + (await res.text()).slice(0, 200));
}

async function setPublicReadPolicy(bucket) {
  const policy = {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { AWS: ["*"] },
        Action: ["s3:GetObject"],
        Resource: ["arn:aws:s3:::" + bucket + "/*"],
      },
    ],
  };
  const res = await client.fetch(ENDPOINT + "/" + bucket + "?policy=", {
    method: "PUT",
    body: JSON.stringify(policy),
    headers: { "content-type": "application/json" },
  });
  if (res.ok) {
    console.log("[storage-init] public-read policy set on:", bucket);
  } else {
    console.warn("[storage-init] policy set failed on " + bucket + ": HTTP " + res.status + " " + (await res.text()).slice(0, 200));
  }
}

async function waitForEndpoint(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      await client.fetch(ENDPOINT, { method: "GET" });
      return;
    } catch {
      // 403/401 responses also prove the endpoint is up; fetch only throws on network errors
      return;
    }
  }
  throw new Error("endpoint not reachable: " + ENDPOINT);
}

await waitForEndpoint();
await ensureBucket(PUBLIC_BUCKET);
await ensureBucket(PRIVATE_BUCKET);
await setPublicReadPolicy(PUBLIC_BUCKET);
console.log("[storage-init] done");
