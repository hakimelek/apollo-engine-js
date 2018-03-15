import * as http from 'http';
import * as express from 'express';
import * as tmp from 'tmp';
import * as bodyParser from 'body-parser';
import { graphqlExpress } from 'apollo-server-express';
import { writeFileSync, unlinkSync, renameSync, readFileSync } from 'fs';
import { Writable } from 'stream';

import { schema, rootValue, verifyEndpointSuccess } from './schema';
import { processIsRunning, devNull } from './util';
import { runCleanupTests } from './engine-common';

import { ApolloEngineLauncher } from '../launcher';

function basicConfig(port: number) {
  return {
    apiKey: 'faked',
    logging: {
      level: 'WARN',
      destination: 'STDERR',
    },
    frontends: [
      {
        // We need to know which to connect to.
        host: '127.0.0.1',
      },
    ],
    reporting: {
      disabled: true,
    },
    origins: [
      {
        http: {
          url: `http://127.0.0.1:${port}/graphql`,
        },
      },
    ],
  };
}

describe('ApolloEngineLauncher', () => {
  let httpServers: http.Server[] = [];
  let port: number;
  let config: any;
  let launcher: ApolloEngineLauncher | null = null;

  beforeEach(() => {
    httpServers = [];
    port = gqlServer();
    config = basicConfig(port);
  });
  afterEach(async () => {
    if (launcher !== null) {
      const child = launcher['child'];
      if (child !== null) {
        await launcher.stop();
        expect(processIsRunning(child.pid)).toBe(false);
      }
      launcher = null;
    }
    httpServers.forEach(server => server.close());
  });

  function gqlServer(path = '/graphql') {
    const app = express();
    app.use(
      path,
      bodyParser.json(),
      graphqlExpress({
        schema: schema,
        rootValue: rootValue,
        tracing: true,
      }),
    );

    const server = http.createServer(app);
    httpServers.push(server);
    return server.listen().address().port;
  }

  describe('config', () => {
    test('allows reading and reloading config from file', async () => {
      // Make a temp filename for the config we're going to reload, and for a
      // log file we're going to eventually look for.
      const tmpConfig = tmp.fileSync({ discardDescriptor: true });
      const tmpLog = tmp.fileSync({ discardDescriptor: true });
      unlinkSync(tmpLog.name);

      // Write a basic config file out to disk. It does not have request logging
      // turned on.
      writeFileSync(tmpConfig.name, JSON.stringify(config));

      // Run Engine. Ask it to check the config file for reloads every 5ms
      // instead of the default 5s, for a faster test.
      launcher = new ApolloEngineLauncher(tmpConfig.name);

      // Make sure it runs properly.
      const listeningAddress = await launcher.start({
        extraArgs: ['-config-reload-file=5ms'],
      });

      await verifyEndpointSuccess(`${listeningAddress.url}/graphql`, false);

      // Add request logging to the config file. Write it out (atomically!) and
      // wait twice the -config-reload-file amount of time.
      (config.logging as any).request = {
        destination: tmpLog.name,
      };
      writeFileSync(tmpConfig.name + '.atomic', JSON.stringify(config));
      renameSync(tmpConfig.name + '.atomic', tmpConfig.name);
      await new Promise(resolve => setTimeout(resolve, 10));

      // Make a request, which should be logged.
      await verifyEndpointSuccess(`${listeningAddress.url}/graphql`, false);
      // Wait a moment and verify the request log exists.
      await new Promise(resolve => setTimeout(resolve, 10));
      readFileSync(tmpLog.name);
    });

    test('allows reading config from argument', async () => {
      launcher = new ApolloEngineLauncher(config);
      // Make sure it runs properly.
      const listeningAddress = await launcher.start();

      await verifyEndpointSuccess(`${listeningAddress.url}/graphql`, false);
    });
  });

  describe('stdio redirection', () => {
    test('custom stdout', async () => {
      config.logging.level = 'INFO';
      config.logging.destination = 'STDOUT';
      launcher = new ApolloEngineLauncher(config);
      let written = false;
      const proxyStdoutStream = new Writable({
        write(chunk, encoding, callback) {
          written = true;
          callback();
        },
      });
      await launcher.start({ proxyStdoutStream });
      expect(written).toBe(true);
    });

    test('custom stderr', async () => {
      config.logging.level = 'INFO';
      launcher = new ApolloEngineLauncher(config);
      let written = false;
      const proxyStderrStream = new Writable({
        write(chunk, encoding, callback) {
          written = true;
        },
      });
      await launcher.start({ proxyStderrStream });
      expect(written).toBe(true);
    });
  });

  describe('process management', () => {
    test('restarts binary', async () => {
      launcher = new ApolloEngineLauncher(config);
      const listenAddress = await launcher.start();
      await verifyEndpointSuccess(`${listenAddress.url}/graphql`, false);

      const child = launcher['child'];
      expect(child).toBeDefined();
      const childPid = child!.pid;
      expect(processIsRunning(childPid)).toBe(true);

      // Directly kill process, wait for notice another process has started:
      const restartingPromise = new Promise(resolve => {
        launcher!.once('restarting', resolve);
      });
      const restartPromise = new Promise(resolve => {
        launcher!.once('start', resolve);
      });
      child!.kill('SIGKILL');
      await restartingPromise;
      await restartPromise;

      const child2 = launcher['child'];
      expect(child2).toBeDefined();
      const restartedPid = child2!.pid;
      expect(restartedPid).not.toBe(child);
      expect(processIsRunning(childPid)).toBe(false);
      expect(processIsRunning(restartedPid)).toBe(true);
    });

    test('exits faster than timeout on invalid config', async () => {
      config.logging.level = 'invalid-level';
      launcher = new ApolloEngineLauncher(config);

      const start = +new Date();
      await expect(
        launcher.start({ proxyStderrStream: devNull() }),
      ).rejects.toThrow(/Engine crashed due to invalid configuration/);
      const end = +new Date();
      expect(end - start).toBeLessThan(5000);
    });

    test('hits timeout on problems other than invalid config', async () => {
      launcher = new ApolloEngineLauncher(config);

      const start = +new Date();
      let restarted = 0;
      launcher.on('restarting', () => {
        restarted++;
      });
      const p = launcher.start({
        proxyStdoutStream: devNull(),
        startupTimeout: 300,
        // This is a kind of silly way to get it to "fail" with a non-bad-config
        // reason, but hey, it works.
        extraArgs: ['-version'],
      });

      await expect(p).rejects.toThrow(/engineproxy timed out/);
      const end = +new Date();
      expect(end - start).toBeGreaterThanOrEqual(300);
      expect(restarted).toBeGreaterThan(0);
    });

    runCleanupTests(true);
  });
});
