// Client for the AE platform-server (custodial track).
//
// All the encryption that protects the user's AE private key happens
// client-side in this module. The wire calls match the routes in
// platform-server/src/routes/auth.ts and routes/recovery.ts.
//
// The threat model this protects against:
//   - Server breach: vault blobs leak but are encrypted with a key
//     derived from each user's password (PBKDF2-SHA256, 600k rounds).
//     Attacker still needs the password to read them.
//   - Recovery key leak: recovery blobs are encrypted to the server's
//     long-term x25519 public key with a one-time ephemeral key the
//     client generates. Without the server's matching private key,
//     they're useless.
//
// The accepted limitation (Soft Flavor 2, by design):
//   - A full server breach (recovery private key + recovery_blob rows)
//     lets the attacker decrypt every recovery_blob and learn every
//     AE private key. Mitigation in prod: hold the recovery private
//     key in HSM / KMS, never in process memory. Documented in
//     docs/platform-track-plan.md.

import { x25519 } from '@noble/curves/ed25519.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { gcm } from '@noble/ciphers/aes.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { deriveAccountId, generateKeyPair } from './crypto.js';
import { bytesToHex, hexToBytes } from './crypto.js';

const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_KEY_LEN = 32;
const AES_GCM_NONCE_LEN = 12;

// ── crypto helpers ─────────────────────────────────────────────────────

/**
 * Derive the per-user vault key from password + email. PBKDF2-SHA256 with
 * a salt anchored to the email so two users with the same password get
 * different vault keys. 600k iterations matches the OWASP-2025 floor.
 * Runs in Node and the browser (uses @noble/hashes, no WebCrypto coupling).
 */
async function deriveVaultKey(password: string, email: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const salt = sha256(enc.encode(`vault:${email.toLowerCase()}`));
  return pbkdf2Async(sha256, enc.encode(password), salt, { c: PBKDF2_ITERATIONS, dkLen: PBKDF2_KEY_LEN });
}

/**
 * AES-256-GCM encrypt the plaintext with the password-derived key. The
 * stored blob is `nonce(12) || ciphertext(rest)` hex-encoded.
 */
function encryptVault(plaintext: Uint8Array, vaultKey: Uint8Array): string {
  const nonce = randomBytes(AES_GCM_NONCE_LEN);
  const ct = gcm(vaultKey, nonce).encrypt(plaintext);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return bytesToHex(out);
}

function decryptVault(blobHex: string, vaultKey: Uint8Array): Uint8Array {
  const blob = hexToBytes(blobHex);
  if (blob.length < AES_GCM_NONCE_LEN + 16) throw new Error('vault blob too short');
  const nonce = blob.slice(0, AES_GCM_NONCE_LEN);
  const ct = blob.slice(AES_GCM_NONCE_LEN);
  return gcm(vaultKey, nonce).decrypt(ct);
}

/**
 * ECIES-style envelope: x25519 + chacha20-poly1305. Client makes a
 * one-time x25519 keypair, mixes its private half with the server's
 * long-term public key to get a shared secret, encrypts the plaintext
 * with chacha20-poly1305 + a random nonce, ships `ephPub || nonce ||
 * ciphertext`. Server reverses with its long-term private key. Same
 * shape platform-server/src/crypto.ts:decryptRecoveryBlob parses.
 */
function encryptRecovery(plaintext: Uint8Array, serverPubHex: string): string {
  const serverPub = hexToBytes(serverPubHex);
  if (serverPub.length !== 32) throw new Error('server recovery public key must be 32 bytes');
  const ephPriv = randomBytes(32);
  const ephPub = x25519.getPublicKey(ephPriv);
  const sharedSecret = x25519.getSharedSecret(ephPriv, serverPub);
  const nonce = randomBytes(12);
  const ct = chacha20poly1305(sharedSecret, nonce).encrypt(plaintext);
  const out = new Uint8Array(ephPub.length + nonce.length + ct.length);
  out.set(ephPub, 0);
  out.set(nonce, ephPub.length);
  out.set(ct, ephPub.length + nonce.length);
  return bytesToHex(out);
}

// ── client ─────────────────────────────────────────────────────────────

export interface PlatformClientOptions {
  /** Base URL pointing at the platform-server's API root, e.g. http://localhost:3500/api/v1 */
  baseUrl: string;
  /** Optional fetch override. */
  fetch?: typeof globalThis.fetch;
}

export interface PlatformSession {
  /** Opaque session token. Pass as Authorization: Bearer <token> on /me and /signout. */
  sessionToken: string;
  /** Seconds-since-epoch the token expires. */
  expiresAt: number;
  /** AE account id derived from the keypair. */
  accountId: string;
  /** Hex-encoded ML-DSA private key. Held in memory by the wallet for the session. */
  privateKey: string;
  /** Public key (hex). Useful for verifying signatures against. */
  publicKey: string;
}

export interface SignupArgs {
  email: string;
  password: string;
  /** If you already have an AE keypair (e.g. importing from self-custody),
   *  pass it here. Otherwise the client generates a fresh one. */
  existingKeypair?: { publicKey: string; privateKey: string };
}

export class PlatformError extends Error {
  constructor(message: string, public readonly code: string, public readonly httpStatus: number) {
    super(message);
    this.name = 'PlatformError';
  }
}

export class PlatformClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(opts: PlatformClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async request<T>(method: string, path: string, body?: unknown, sessionToken?: string): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (sessionToken) headers['Authorization'] = `Bearer ${sessionToken}`;
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json: any;
    try { json = await res.json(); } catch { throw new PlatformError(`Non-JSON ${res.status}`, 'PARSE_ERROR', res.status); }
    if (typeof json === 'object' && json && 'success' in json) {
      if (!json.success) {
        const err = json.error ?? {};
        throw new PlatformError(err.message ?? 'request failed', err.code ?? 'API_ERROR', res.status);
      }
      return json.data as T;
    }
    if (!res.ok) throw new PlatformError(`HTTP ${res.status}`, 'HTTP_ERROR', res.status);
    return json as T;
  }

  /** Fetch the server's long-term x25519 public key so we can encrypt recovery blobs. */
  async getRecoveryPublicKey(): Promise<string> {
    const data = await this.request<{ recoveryPublicKey: string }>('GET', '/recovery-pubkey');
    return data.recoveryPublicKey;
  }

  /**
   * Sign up on the platform track. Generates an AE keypair locally (or
   * uses the provided one), encrypts it twice (vault blob with password-
   * derived key, recovery blob with server pubkey), posts to /signup.
   * Returns a session plus the in-memory private key so the wallet can
   * immediately sign transactions.
   */
  async signup(args: SignupArgs): Promise<PlatformSession> {
    const recoveryPubKey = await this.getRecoveryPublicKey();
    const kp = args.existingKeypair ?? generateKeyPair();
    const accountId = deriveAccountId(kp.publicKey);
    const privateKeyBytes = hexToBytes(kp.privateKey);
    const vaultKey = await deriveVaultKey(args.password, args.email);
    const vaultBlob = encryptVault(privateKeyBytes, vaultKey);
    const recoveryBlob = encryptRecovery(privateKeyBytes, recoveryPubKey);

    const data = await this.request<{ sessionToken: string; expiresAt: number; accountId: string; userId: string }>(
      'POST',
      '/signup',
      { email: args.email, password: args.password, vaultBlob, recoveryBlob, accountId },
    );

    return {
      sessionToken: data.sessionToken,
      expiresAt: data.expiresAt,
      accountId: data.accountId,
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
    };
  }

  /**
   * Sign in with email + password. Decrypts the vault locally. If the
   * user has 2FA enabled, callers either pass `code` up front or catch
   * a `PlatformError` with `code: 'TOTP_REQUIRED'` and re-call with
   * the user's TOTP. `TOTP_INVALID` means the code was wrong.
   */
  async signin(args: { email: string; password: string; code?: string }): Promise<PlatformSession> {
    const data = await this.request<{ sessionToken: string; expiresAt: number; accountId: string; vaultBlob: string; userId: string }>(
      'POST',
      '/signin',
      args,
    );
    const vaultKey = await deriveVaultKey(args.password, args.email);
    const privateKeyBytes = decryptVault(data.vaultBlob, vaultKey);
    // The public key isn't on the wire (server doesn't store it). Derive
    // it from the private key using the same ML-DSA path generateKeyPair
    // would have used at signup. For ML-DSA this is non-trivial; the
    // wallet typically caches the publicKey alongside the session. For
    // now we return privateKey and accountId; downstream uses accountId
    // for protocol calls and derives publicKey from the keypair only on
    // demand. Adding publicKey here would require importing the ML-DSA
    // helper that splits a private key, which is a Phase 6 cleanup.
    return {
      sessionToken: data.sessionToken,
      expiresAt: data.expiresAt,
      accountId: data.accountId,
      privateKey: bytesToHex(privateKeyBytes),
      publicKey: '', // see comment above
    };
  }

  async signout(sessionToken: string): Promise<void> {
    await this.request<{ revoked: boolean }>('POST', '/signout', undefined, sessionToken);
  }

  // ── 2FA / TOTP ────────────────────────────────────────────────────────

  /** Start 2FA enrollment. Returns a fresh secret + otpauth URI for QR
   *  rendering. Not yet committed server-side; finalize with confirm2FA. */
  async enroll2FA(sessionToken: string): Promise<{ secret: string; otpauthUri: string }> {
    return this.request('POST', '/2fa/enroll', {}, sessionToken);
  }

  /** Finalize 2FA enrollment. Server verifies the code matches the secret
   *  before persisting; if not, throws PlatformError(code='TOTP_INVALID'). */
  async confirm2FA(sessionToken: string, secret: string, code: string): Promise<{ enabled: true }> {
    return this.request('POST', '/2fa/confirm', { secret, code }, sessionToken);
  }

  /** Turn 2FA off. Requires both a valid session AND a current TOTP. */
  async disable2FA(sessionToken: string, code: string): Promise<{ disabled: true }> {
    return this.request('POST', '/2fa/disable', { code }, sessionToken);
  }

  async me(sessionToken: string): Promise<{ userId: string; email: string; accountId: string; emailVerified: boolean; twoFactorEnabled: boolean }> {
    return this.request('GET', '/me', undefined, sessionToken);
  }

  // ── recovery ─────────────────────────────────────────────────────────

  /** Kick off the forgot-password flow. Server emails a token. */
  async recoverStart(args: { email: string }): Promise<{ sent: boolean; devToken?: string }> {
    return this.request('POST', '/recover/start', args);
  }

  /** Mark the recovery token verified. The wallet calls this after the
   *  user opens the email link (or pastes the token into the wallet). */
  async recoverVerify(args: { token: string }): Promise<{ verified: boolean }> {
    return this.request('POST', '/recover/verify', args);
  }

  /**
   * Finalize the recovery. Fetches the server-decrypted plaintext via
   * /recover/peek, re-encrypts it with the new password, posts
   * /recover/complete with the new blobs. Then signs the user in with
   * the new password and returns a fresh session.
   *
   * `now` is forwarded to both /peek and /complete so test code with
   * AE_PLATFORM_ALLOW_TEST_NOW=1 can skip the cooldown.
   */
  async recoverComplete(args: { email: string; token: string; newPassword: string; now?: number }): Promise<PlatformSession> {
    const peeked = await this.request<{ plaintextHex: string; accountId: string; recoveryPublicKey: string }>(
      'POST',
      '/recover/peek',
      { token: args.token, now: args.now },
    );
    const privateKeyBytes = hexToBytes(peeked.plaintextHex);
    const vaultKey = await deriveVaultKey(args.newPassword, args.email);
    const newVaultBlob = encryptVault(privateKeyBytes, vaultKey);
    const newRecoveryBlob = encryptRecovery(privateKeyBytes, peeked.recoveryPublicKey);

    await this.request<{ recovered: boolean; userId: string }>(
      'POST',
      '/recover/complete',
      {
        token: args.token,
        newPassword: args.newPassword,
        newVaultBlob,
        newRecoveryBlob,
        now: args.now,
      },
    );

    return this.signin({ email: args.email, password: args.newPassword });
  }
}
