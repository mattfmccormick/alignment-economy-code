// Invite-link format for distributing a network spec.
//
// The founder runs a genesis ceremony, downloads the public spec, and now
// also gets an "invite link" they can paste into a DM. The joiner pastes
// it into their wallet and the genesis spec materializes — no need to
// hand-share a 10 KB JSON file. The joiner still needs their own
// (private) keystore separately.
//
// Format:
//   https://invite.alignmenteconomy.org/v1#<base64url(spec-json)>
//
// Notes:
//   - Spec lives in the URL FRAGMENT (everything after #), so even if the
//     user clicks the link by accident it never gets sent to a server.
//     We decode purely client-side.
//   - We parse a few formats on the joiner side so users can paste:
//       * the canonical link above
//       * the bare fragment payload (`v1#...`)
//       * the base64 chunk by itself
//     This is forgiving without being magical.
//   - No invite hash check yet. The spec hash is derivable from the spec
//     itself (genesisSpecHash on the server, or could be re-derived
//     client-side later). Out-of-band hash comparison is still the
//     recommended sanity check before peering, just like with the
//     download flow.

const INVITE_HOST_PREFIX = 'https://invite.alignmenteconomy.org/v1#';
const INVITE_FRAGMENT_PREFIX = 'v1#';

function toBase64Url(s: string): string {
  // btoa expects ASCII; serialize via TextEncoder + bytewise concat so
  // any non-ASCII chars in spec strings don't break encoding.
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): string {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function encodeInviteLink(spec: unknown): string {
  return INVITE_HOST_PREFIX + toBase64Url(JSON.stringify(spec));
}

/**
 * Try to extract a spec from a pasted invite. Accepts the canonical URL,
 * the bare fragment (e.g. "v1#abc..."), or the raw base64 payload. Returns
 * null when the input doesn't decode or doesn't look like a spec.
 */
export function decodeInviteLink(input: string): { spec: { networkId: string; accounts?: unknown[] } } | null {
  if (!input) return null;
  let payload = input.trim();

  // Strip the canonical prefix if present.
  if (payload.startsWith(INVITE_HOST_PREFIX)) {
    payload = payload.slice(INVITE_HOST_PREFIX.length);
  } else if (payload.startsWith(INVITE_FRAGMENT_PREFIX)) {
    payload = payload.slice(INVITE_FRAGMENT_PREFIX.length);
  }

  // Empty or obviously wrong inputs.
  if (!payload || /\s/.test(payload)) return null;

  let json: string;
  try {
    json = fromBase64Url(payload);
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const spec = parsed as { networkId?: unknown; accounts?: unknown };
  if (typeof spec.networkId !== 'string') return null;
  if (!Array.isArray(spec.accounts)) return null;
  return { spec: spec as { networkId: string; accounts?: unknown[] } };
}
