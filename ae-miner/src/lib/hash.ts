// Compute the SHA-256 of a file entirely in the browser. The file's bytes
// never leave the device; only the resulting hex digest is sent to the
// network as identity evidence. Uses the native Web Crypto API (no deps).
export async function hashFileSHA256(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
