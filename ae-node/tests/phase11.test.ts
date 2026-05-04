import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, type AENodeConfig } from '../src/node/config.js';
import { logger, setLogLevel } from '../src/node/logger.js';

describe('Phase 11: Deployment and Operations', () => {

  // Test 1: Config loading with defaults
  it('loads default config when no file or env vars exist', () => {
    // Clear relevant env vars
    const saved: Record<string, string | undefined> = {};
    const envKeys = [
      'AE_NODE_ID', 'AE_AUTHORITY_NODE_ID', 'AE_API_PORT', 'AE_P2P_PORT',
      'AE_DB_PATH', 'AE_SEED_NODES', 'AE_CONFIG_FILE', 'AE_LOG_LEVEL',
    ];
    for (const k of envKeys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }

    const config = loadConfig('/nonexistent/path.json');

    assert.equal(config.apiPort, 3000);
    assert.equal(config.p2pPort, 9000);
    assert.equal(config.maxPeers, 20);
    assert.equal(config.logLevel, 'info');
    assert.equal(config.dbPath, './data/ae-node.db');
    assert.deepEqual(config.seedNodes, []);

    // Restore env
    for (const k of envKeys) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
    }
  });

  // Test 2: Environment variable overrides
  it('overrides config from environment variables', () => {
    const saved: Record<string, string | undefined> = {};
    const envVars: Record<string, string> = {
      AE_NODE_ID: 'test-node-env',
      AE_API_PORT: '4000',
      AE_P2P_PORT: '9500',
      AE_SEED_NODES: 'host1:9000,host2:9001',
      AE_LOG_LEVEL: 'debug',
    };

    for (const [k, v] of Object.entries(envVars)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }

    const config = loadConfig('/nonexistent.json');
    assert.equal(config.nodeId, 'test-node-env');
    assert.equal(config.apiPort, 4000);
    assert.equal(config.p2pPort, 9500);
    assert.equal(config.logLevel, 'debug');
    assert.equal(config.seedNodes.length, 2);
    assert.equal(config.seedNodes[0].host, 'host1');
    assert.equal(config.seedNodes[0].port, 9000);
    assert.equal(config.seedNodes[1].host, 'host2');
    assert.equal(config.seedNodes[1].port, 9001);

    // Restore
    for (const k of Object.keys(envVars)) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
    }
  });

  // Test 3: Logger respects log levels
  it('logger filters messages below configured level', () => {
    // Capture console output
    const messages: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => { messages.push(args.join(' ')); };

    setLogLevel('warn');
    logger.debug('test', 'debug message');
    logger.info('test', 'info message');
    logger.warn('test', 'warn message');
    logger.error('test', 'error message');

    console.log = origLog;
    setLogLevel('info'); // restore

    // Only warn and error should appear
    assert.equal(messages.length, 2);
    assert.ok(messages[0].includes('WARN'));
    assert.ok(messages[1].includes('ERROR'));
  });

  // Test 4: Health endpoint returns ok
  it('health endpoint returns 200 with ok status', async () => {
    // Import dynamically to avoid side effects
    const { DatabaseSync } = await import('node:sqlite');
    const { initializeSchema } = await import('../src/db/schema.js');
    const { seedParams } = await import('../src/config/params.js');
    const { createGenesisBlock } = await import('../src/core/block.js');
    const { createApp } = await import('../src/api/server.js');
    const { createServer } = await import('http');

    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    initializeSchema(db);
    seedParams(db);
    createGenesisBlock(db);

    const app = createApp(db);
    const server = createServer(app);

    const port: number = await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve((server.address() as { port: number }).port);
      });
    });

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      assert.equal(res.status, 200);
      const body = await res.json() as any;
      assert.equal(body.status, 'ok');
    } finally {
      server.close();
    }
  });

  // Test 5: Status endpoint returns node details
  it('status endpoint returns chain and memory info', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { initializeSchema } = await import('../src/db/schema.js');
    const { seedParams } = await import('../src/config/params.js');
    const { createGenesisBlock } = await import('../src/core/block.js');
    const { createApp } = await import('../src/api/server.js');
    const { createServer } = await import('http');

    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    initializeSchema(db);
    seedParams(db);
    createGenesisBlock(db);

    const app = createApp(db);
    const server = createServer(app);

    const port: number = await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve((server.address() as { port: number }).port);
      });
    });

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/status`);
      assert.equal(res.status, 200);
      const body = await res.json() as any;
      assert.equal(body.status, 'ok');
      assert.equal(body.chain.blockHeight, 0);
      assert.ok(body.node.uptime >= 0);
      assert.ok(body.memory.heapUsedMb > 0);
    } finally {
      server.close();
    }
  });

  // Test 6: Prometheus metrics endpoint
  it('metrics endpoint returns prometheus-format text', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { initializeSchema } = await import('../src/db/schema.js');
    const { seedParams } = await import('../src/config/params.js');
    const { createGenesisBlock } = await import('../src/core/block.js');
    const { createApp } = await import('../src/api/server.js');
    const { createServer } = await import('http');

    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    initializeSchema(db);
    seedParams(db);
    createGenesisBlock(db);

    const app = createApp(db);
    const server = createServer(app);

    const port: number = await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve((server.address() as { port: number }).port);
      });
    });

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/metrics`);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes('ae_block_height'));
      assert.ok(text.includes('ae_current_day'));
      assert.ok(text.includes('ae_uptime_seconds'));
      assert.ok(text.includes('ae_memory_heap_bytes'));
    } finally {
      server.close();
    }
  });
});
