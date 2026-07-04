import { z } from 'zod';

// Zod schemas for write-route request bodies (the inner `payload`). Applied via
// validateBody() in each route's middleware chain.
//
// Scope note: these validate presence, primitive type, and fixed-set enums.
// Numeric-range and cross-field rules (e.g. minimum vouch stake, score 0-100,
// sufficient balance) stay in the business layer, which throws typed AppErrors
// with specific domain codes that callers and tests rely on. Schemas are
// non-strict (unknown keys are stripped, not rejected) so forward-compatible
// extra fields don't break older clients.

const pointType = z.enum(['active', 'supportive', 'ambient', 'earned']);

// A transaction amount, on the wire as a positive integer string in base units
// (10^8 per point) with no leading zeros. Money never round-trips through a JS
// float at the boundary: this is exactly the canonical value the client signs
// over, and the server parses it straight to bigint. Rejects floats, negatives,
// NaN/Infinity, and non-numeric strings.
const baseUnitAmount = z
  .string()
  .regex(/^[1-9]\d*$/, 'amount must be a positive base-unit integer string');

export const createTransaction = z.object({
  to: z.string().min(1),
  amount: baseUnitAmount,
  pointType,
  isInPerson: z.boolean().optional(),
  recipientIsHuman: z.boolean().optional(),
  memo: z.string().optional(),
  receiverSignature: z.string().optional(),
});

export const createAccount = z.object({
  // The route validates `type` against its own list with an INVALID_TYPE code,
  // so keep it a string here rather than an enum to avoid double-coding.
  type: z.string().min(1),
  publicKey: z.string().optional(),
});

export const fileChallenge = z.object({
  defendantAccountId: z.string().min(1),
  caseType: z.enum(['not_human', 'duplicate_account']),
  stakePercent: z.number(),
  openingArgument: z.string().optional(),
});

export const submitArgument = z.object({
  text: z.string().min(1),
  attachmentHash: z.string().optional(),
});

export const castVote = z.object({
  vote: z.enum(['human', 'not_human']),
});

export const submitTags = z.object({
  day: z.number(),
  tags: z.array(z.unknown()),
});

export const registerProduct = z.object({
  name: z.string().min(1),
  category: z.string().min(1),
  manufacturerId: z.string().optional(),
});

export const registerSpace = z.object({
  name: z.string().min(1),
  // The route checks `type` against VALID_SPACE_TYPES with its own message.
  type: z.string().min(1),
  parentId: z.string().optional(),
  entityId: z.string().optional(),
  collectionRate: z.number().optional(),
});

export const submitEvidence = z.object({
  evidenceTypeId: z.string().min(1),
  evidenceHash: z.string().min(1),
});

export const scorePanel = z.object({
  score: z.number(),
});

export const createVouch = z.object({
  vouchedId: z.string().min(1),
  stakePercent: z.number(),
});

export const createVouchRequest = z.object({
  toId: z.string().min(1),
  message: z.string().optional(),
});

export const respondVouchRequest = z.object({
  status: z.enum(['accepted', 'declined']),
});

export const createContact = z.object({
  contactAccountId: z.string().min(1),
  nickname: z.string().optional(),
});

export const createRecurring = z.object({
  toId: z.string().min(1),
  // Recurring transfers accept the amount as a number or a numeric string
  // (the route persists `amount.toString()`), unlike a live transaction which
  // needs a number to compute the fee.
  amount: z.union([z.number(), z.string().min(1)]),
  pointType: pointType.optional(),
  schedule: z.unknown().optional(),
});
