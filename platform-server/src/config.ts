// Platform server configuration. Loads from env vars, falls back to sane
// defaults for local dev. In production every secret here comes from env.
//
// Critical secrets:
//   AE_PLATFORM_RECOVERY_PRIVATE_KEY  hex-encoded server-side recovery
//                                     private key. The server uses it to
//                                     decrypt user recovery_blobs during
//                                     the (controlled) recovery flow. Lives
//                                     in env / KMS in prod; never in code.
//                                     If unset in dev, a deterministic
//                                     dev-only keypair is generated.
//   AE_PLATFORM_SESSION_SECRET        random 32-byte hex used to sign
//                                     session tokens. Same lifecycle.

import { readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { x25519 } from '@noble/curves/ed25519.js';
import { mkdirSync } from 'node:fs';

export interface PlatformConfig {
  port: number;
  dbPath: string;
  /** Hex-encoded x25519 private key the server uses to decrypt recovery blobs. */
  recoveryPrivateKey: string;
  /** Derived from `recoveryPrivateKey` at boot; safe to share with clients. */
  recoveryPublicKey: string;
  /** Hex-encoded HMAC secret for session tokens. */
  sessionSecret: string;
  /** How long a signin session is valid before re-auth is required. Default 1 hour. */
  sessionTtlSeconds: number;
  /** Forced delay between recover/start and recover/complete. Defaults to 24h. */
  recoveryCooldownSeconds: number;
  /** 'dev' logs verification + recovery links to stdout. 'smtp' sends real emails. */
  emailMode: 'dev' | 'smtp';
  /** SMTP target host (used only in emailMode=smtp). */
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPassword?: string;
  smtpFrom?: string;
}

function ensureDevSecret(name: string, lengthBytes: number): string {
  const fromEnv = process.env[name];
  if (fromEnv && /^[0-9a-fA-F]+$/.test(fromEnv)) return fromEnv;
  // For dev, generate once and persist next to the db so restarts are stable.
  // Production deployments MUST set the env var; the dev fallback is loud.
  const path = `./data/dev-${name.toLowerCase()}.hex`;
  try {
    if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  } catch { /* fall through */ }
  const fresh = randomBytes(lengthBytes).toString('hex');
  try {
    mkdirSync(dirname(path), { recursive: true });
    const fs = require('node:fs');
    fs.writeFileSync(path, fresh, { mode: 0o600 });
  } catch { /* non-fatal in dev */ }
  console.warn(`[config] DEV ONLY: generated ${name} at ${path}. Set the env var in production.`);
  return fresh;
}

export function loadConfig(): PlatformConfig {
  const recoveryPrivateKey = ensureDevSecret('AE_PLATFORM_RECOVERY_PRIVATE_KEY', 32);
  const sessionSecret = ensureDevSecret('AE_PLATFORM_SESSION_SECRET', 32);

  // Derive the matching public key. x25519 is the curve we use for the
  // recovery key envelope. Clients encrypt recovery_blob with this public
  // key plus an ephemeral keypair (ECIES-style); server decrypts with the
  // matching private key during a verified recovery flow.
  const priv = Buffer.from(recoveryPrivateKey, 'hex');
  if (priv.length !== 32) {
    throw new Error('AE_PLATFORM_RECOVERY_PRIVATE_KEY must be 32 bytes (64 hex chars)');
  }
  const recoveryPublicKey = Buffer.from(x25519.getPublicKey(priv)).toString('hex');

  return {
    port: parseInt(process.env.AE_PLATFORM_PORT ?? '3500', 10),
    dbPath: process.env.AE_PLATFORM_DB_PATH ?? './data/platform.db',
    recoveryPrivateKey,
    recoveryPublicKey,
    sessionSecret,
    sessionTtlSeconds: parseInt(process.env.AE_PLATFORM_SESSION_TTL_SECONDS ?? '3600', 10),
    recoveryCooldownSeconds: parseInt(process.env.AE_PLATFORM_RECOVERY_COOLDOWN_SECONDS ?? '86400', 10),
    emailMode: (process.env.AE_PLATFORM_EMAIL_MODE as 'dev' | 'smtp') ?? 'dev',
    smtpHost: process.env.AE_PLATFORM_SMTP_HOST,
    smtpPort: process.env.AE_PLATFORM_SMTP_PORT ? parseInt(process.env.AE_PLATFORM_SMTP_PORT, 10) : undefined,
    smtpUser: process.env.AE_PLATFORM_SMTP_USER,
    smtpPassword: process.env.AE_PLATFORM_SMTP_PASSWORD,
    smtpFrom: process.env.AE_PLATFORM_SMTP_FROM,
  };
}
