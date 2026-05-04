// Founder route. Lets a wallet client run a genesis ceremony from inside
// the desktop app instead of dropping to the `npm run genesis:init` CLI.
//
// POST /api/v1/founder/generate-genesis
//
//   body: {
//     networkId: string,            // required, NETWORK_ID_REGEX
//     validatorCount?: number,      // default 2
//     names?: string[],             // friendly labels per validator
//     initialEarnedDisplay?: number,
//     stakeDisplay?: number,
//     genesisTimestamp?: number,
//   }
//
//   response: { success: true, data: {
//     spec: GenesisSpec,            // shared, public, send to all operators
//     keystores: ValidatorKeystore[], // one per validator, PRIVATE
//     specHash: string,             // operators compare out-of-band before peering
//   }}
//
// This is a pure computation: it builds the genesis bundle in memory and
// returns it. It does NOT write to disk or change the running node's state.
// The wallet UI is responsible for letting the founder save/share the
// outputs. Wiring the bundled ae-node to actually boot ON this generated
// genesis is the next milestone task (the join-mode work covers the same
// spawn rewiring).
//
// No auth: generating a spec doesn't affect any chain state. Spam protection
// rides on the standard rate limiter applied app-wide. We do gate by sane
// input validation (network id format, validator count <= 50).

import { Router } from 'express';
import { buildGenesisSet } from '../../node/genesis-init.js';
import { genesisSpecHash, NETWORK_ID_REGEX } from '../../node/genesis-config.js';

interface GenerateGenesisBody {
  networkId?: unknown;
  validatorCount?: unknown;
  names?: unknown;
  initialEarnedDisplay?: unknown;
  stakeDisplay?: unknown;
  genesisTimestamp?: unknown;
}

const MAX_VALIDATORS = 50;

export function founderRoutes(): Router {
  const router = Router();

  router.post('/generate-genesis', (req, res) => {
    const body = (req.body ?? {}) as GenerateGenesisBody;

    if (typeof body.networkId !== 'string' || !NETWORK_ID_REGEX.test(body.networkId)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_NETWORK_ID',
          message: 'networkId must be lowercase alphanumeric or hyphen, 3-32 chars (matches NETWORK_ID_REGEX).',
        },
      });
    }

    let validatorCount = 2;
    if (body.validatorCount !== undefined) {
      if (typeof body.validatorCount !== 'number' || !Number.isInteger(body.validatorCount) || body.validatorCount < 1) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_VALIDATOR_COUNT', message: 'validatorCount must be an integer >= 1' },
        });
      }
      if (body.validatorCount > MAX_VALIDATORS) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATOR_COUNT_TOO_LARGE', message: `validatorCount must be <= ${MAX_VALIDATORS}` },
        });
      }
      validatorCount = body.validatorCount;
    }

    let names: string[] | undefined;
    if (body.names !== undefined) {
      if (!Array.isArray(body.names) || body.names.some((n) => typeof n !== 'string')) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_NAMES', message: 'names must be an array of strings if provided' },
        });
      }
      names = (body.names as string[]).map((n) => n.trim()).filter((n) => n.length > 0);
      if (names.length > 0 && names.length !== validatorCount) {
        return res.status(400).json({
          success: false,
          error: { code: 'NAMES_LENGTH_MISMATCH', message: `names length (${names.length}) must match validatorCount (${validatorCount}) when provided` },
        });
      }
      if (names.length === 0) names = undefined;
    }

    const initialEarnedDisplay = typeof body.initialEarnedDisplay === 'number' ? body.initialEarnedDisplay : undefined;
    const stakeDisplay = typeof body.stakeDisplay === 'number' ? body.stakeDisplay : undefined;
    const genesisTimestamp = typeof body.genesisTimestamp === 'number' ? body.genesisTimestamp : undefined;

    try {
      const set = buildGenesisSet({
        networkId: body.networkId,
        validatorCount,
        names,
        initialEarnedDisplay,
        stakeDisplay,
        genesisTimestamp,
      });
      const specHash = genesisSpecHash(set.spec);

      return res.json({
        success: true,
        data: {
          spec: set.spec,
          keystores: set.keystores,
          specHash,
        },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to generate genesis';
      return res.status(400).json({
        success: false,
        error: { code: 'GENESIS_BUILD_FAILED', message },
      });
    }
  });

  return router;
}
