import { z } from 'zod';
import * as schemas from './schemas.js';

// OpenAPI 3.1 spec for the node API, generated from the same zod schemas the
// write routes validate against (api/schemas.ts). Because the request schema
// and the documentation come from one source, they can't drift. Served at
// GET /api/v1/openapi.json and written to docs/openapi.json by
// `npm run gen:openapi`.

const BASE = '/api/v1';

type Method = 'get' | 'post' | 'put' | 'delete';

interface Endpoint {
  method: Method;
  path: string; // relative to BASE; path params as {id}
  summary: string;
  auth: boolean;
  payload?: z.ZodType; // inner payload schema, wrapped in the signed envelope
}

// Write endpoints validated by validateBody(). The payload here is exactly the
// schema enforced at runtime.
const ENDPOINTS: Endpoint[] = [
  { method: 'post', path: '/accounts', summary: 'Create an account', auth: false, payload: schemas.createAccount },
  { method: 'post', path: '/transactions', summary: 'Submit a signed transaction', auth: false, payload: schemas.createTransaction },
  { method: 'post', path: '/court/challenges', summary: 'File a challenge (miner only)', auth: true, payload: schemas.fileChallenge },
  { method: 'post', path: '/court/cases/{id}/arguments', summary: 'Submit a case argument', auth: true, payload: schemas.submitArgument },
  { method: 'post', path: '/court/cases/{id}/vote', summary: 'Cast a juror vote (miner only)', auth: true, payload: schemas.castVote },
  { method: 'post', path: '/tags/products', summary: 'Register a durable good', auth: true, payload: schemas.registerProduct },
  { method: 'post', path: '/tags/spaces', summary: 'Register a space', auth: true, payload: schemas.registerSpace },
  { method: 'post', path: '/tags/supportive', summary: 'Submit supportive tags', auth: true, payload: schemas.submitTags },
  { method: 'post', path: '/tags/ambient', summary: 'Submit ambient tags', auth: true, payload: schemas.submitTags },
  { method: 'post', path: '/verification/evidence', summary: 'Submit verification evidence', auth: true, payload: schemas.submitEvidence },
  { method: 'post', path: '/verification/panels/{id}/score', summary: 'Score a verification panel (miner only)', auth: true, payload: schemas.scorePanel },
  { method: 'post', path: '/miners/evidence', summary: 'Submit miner identity evidence', auth: true, payload: schemas.submitEvidence },
  { method: 'post', path: '/miners/vouches', summary: 'Vouch for another account', auth: true, payload: schemas.createVouch },
  { method: 'post', path: '/miners/vouch-requests', summary: 'Request a vouch', auth: true, payload: schemas.createVouchRequest },
  { method: 'put', path: '/miners/vouch-requests/{id}', summary: 'Respond to a vouch request', auth: true, payload: schemas.respondVouchRequest },
  { method: 'post', path: '/recurring', summary: 'Create a recurring transfer', auth: true, payload: schemas.createRecurring },
  { method: 'post', path: '/contacts', summary: 'Add a contact', auth: true, payload: schemas.createContact },

  // Representative read endpoints (no request body).
  { method: 'get', path: '/health', summary: 'Liveness check', auth: false },
  { method: 'get', path: '/accounts/{id}', summary: 'Get an account', auth: false },
  { method: 'get', path: '/accounts/{id}/ledger', summary: 'Get an account audit trail', auth: false },
  { method: 'get', path: '/court/cases/{id}', summary: 'Get a court case', auth: false },
];

function payloadJsonSchema(payload: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(payload) as Record<string, unknown>;
  delete js.$schema; // noise when embedded as a sub-schema
  return js;
}

function envelope(payload: z.ZodType): Record<string, unknown> {
  return {
    type: 'object',
    required: ['accountId', 'timestamp', 'signature', 'payload'],
    properties: {
      accountId: { type: 'string' },
      timestamp: { type: 'number', description: 'Unix seconds; must be within 5 minutes of server time' },
      signature: { type: 'string', description: 'ML-DSA-65 signature over the canonical payload + timestamp' },
      payload: payloadJsonSchema(payload),
    },
  };
}

const errorResponse = {
  description: 'Error',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean', enum: [false] },
          error: {
            type: 'object',
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
              requestId: { type: 'string' },
            },
          },
        },
      },
    },
  },
};

export function buildOpenApiSpec(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const ep of ENDPOINTS) {
    const full = BASE + ep.path;
    paths[full] ??= {};

    const op: Record<string, unknown> = {
      summary: ep.summary,
      responses: {
        '200': { description: 'Success' },
        '400': errorResponse,
        ...(ep.auth ? { '401': errorResponse } : {}),
        '500': errorResponse,
      },
    };

    const params = [...ep.path.matchAll(/\{(\w+)\}/g)].map((m) => ({
      name: m[1],
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));
    if (params.length) op.parameters = params;

    if (ep.payload) {
      op.requestBody = {
        required: true,
        content: { 'application/json': { schema: envelope(ep.payload) } },
      };
    }

    if (ep.auth) op.security = [{ signedEnvelope: [] }];

    paths[full][ep.method] = op;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Alignment Economy Node API',
      version: '0.1.0',
      description:
        'The Alignment Economy protocol node API. Write requests are signed: the body is a ' +
        '{ accountId, timestamp, signature, payload } envelope, where signature is an ML-DSA-65 ' +
        'signature over the canonical payload. Amounts are base-unit integer strings (10^8 per point).',
    },
    servers: [{ url: 'https://alignmenteconomy.org' }, { url: 'http://localhost:3000' }],
    paths,
    components: {
      securitySchemes: {
        signedEnvelope: {
          type: 'apiKey',
          in: 'header',
          name: 'signature',
          description:
            'Authentication is a signed request envelope, not a header token: send ' +
            '{ accountId, timestamp, signature, payload } where signature is the ML-DSA-65 ' +
            'signature over the payload. Documented as apiKey for tooling compatibility.',
        },
      },
    },
  };
}
