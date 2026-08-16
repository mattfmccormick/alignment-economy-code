#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { loadConfig } from './config.js';
import { AENodeRunner } from './runner.js';
import { logger } from './logger.js';

// Last-resort handlers. Consensus, sync and gossip all catch their own errors,
// but anything that escapes those unwinds into a raw `ws.on('message')`
// listener with no catch of its own, and the default Node behaviour is to print
// a stack to stderr and exit — which in practice looked like the node
// "just stopping" with nothing useful in the log stream. These make the last
// moment diagnosable. They deliberately do NOT swallow: an unhandled throw
// means state is unknown, and a node with unknown state must not keep voting.
process.on('uncaughtException', (err) => {
  logger.error('cli', 'FATAL: uncaught exception, shutting down', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error('cli', 'FATAL: unhandled promise rejection, shutting down', reason);
  process.exit(1);
});

const args = process.argv.slice(2);
const configPath = args.find((a) => a.startsWith('--config='))?.split('=')[1];

const config = loadConfig(configPath);

// Auto-generate node ID if not set
if (!config.nodeId) {
  config.nodeId = randomBytes(16).toString('hex');
  logger.info('cli', `Generated node ID: ${config.nodeId}`);
}

// Default authority to self if not set (single-node mode)
if (!config.authorityNodeId) {
  config.authorityNodeId = config.nodeId;
  logger.info('cli', 'No authority set, running as authority (single-node mode)');
}

const runner = new AENodeRunner(config);

try {
  runner.start();
} catch (err) {
  logger.error('cli', 'Failed to start node', err);
  process.exit(1);
}
