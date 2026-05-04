#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { loadConfig } from './config.js';
import { AENodeRunner } from './runner.js';
import { logger } from './logger.js';

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
