import { graphqlExpress, graphqlConnect } from 'apollo-server-express';
import * as bodyParser from 'body-parser';
import * as connect from 'connect';
import { NextHandleFunction } from 'connect';
import * as express from 'express';
import * as http from 'http';
import * as qs from 'qs';
import * as urlModule from 'url';

import {
  schema,
  rootValue,
  verifyEndpointSuccess,
  verifyEndpointGet,
  verifyEndpointError,
  verifyEndpointFailure,
  verifyEndpointBatch,
} from './schema';
import { processIsRunning, devNull } from './util';
import {
  runSuite,
  runSuitesForHttpServerFramework,
  runCleanupTests,
} from './engine-common';

import { ApolloEngine } from '../engine';
import * as os from 'os';

runSuitesForHttpServerFramework('express', {
  createApp() {
    const path = '/graphql';
    const app = express();
    app.get(`${path}/ping`, (req, res) => {
      res.json({ pong: true });
    });
    app.use(
      path,
      bodyParser.json(),
      graphqlExpress({
        schema,
        rootValue,
        tracing: true,
        cacheControl: true,
      }),
    );
    return app;
  },
  serverForApp(app: any) {
    return http.createServer(app);
  },
  appParameter: 'expressApp',
});

function connectQuery(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  next: Function,
) {
  const parsedUrl = urlModule.parse(req.url!);
  (req as any).query = qs.parse(parsedUrl.query!);
  next();
}

runSuitesForHttpServerFramework('connect', {
  createApp() {
    const path = '/graphql';
    const app = connect().use(connectQuery);
    app.use(
      `${path}/ping`,
      (req: http.IncomingMessage, res: http.ServerResponse) => {
        res.end(JSON.stringify({ pong: true }));
      },
    );
    app.use(path, bodyParser.json() as NextHandleFunction);
    app.use(path, graphqlConnect({
      schema,
      rootValue,
      tracing: true,
      cacheControl: true,
    }) as NextHandleFunction);
    return app;
  },
  serverForApp(app: any) {
    return http.createServer(app);
  },
  appParameter: 'connectApp',
});

test('can pass a string as a port', async () => {
  const httpServer = http.createServer();
  const engine = new ApolloEngine({
    apiKey: 'faked',
    logging: {
      level: 'WARN',
      destination: 'STDERR',
    },
    reporting: {
      disabled: true,
    },
  });
  try {
    const p = new Promise(resolve =>
      engine.listen({ port: '0', httpServer }, resolve),
    );
    await p;
  } finally {
    await engine.stop();
    httpServer.close();
  }
});

test('must specify apiKey', async () => {
  const httpServer = http.createServer();
  const engine = new ApolloEngine();
  const p = new Promise((resolve, reject) => {
    engine.on('error', e => resolve(e));
    engine.listen(
      {
        port: '0',
        httpServer,
        launcherOptions: { proxyStderrStream: devNull() },
      },
      () => reject(new Error('should not start')),
    );
  });
  await p;
  httpServer.close();
});

describe('env var', () => {
  let oldValue: string | undefined;
  beforeEach(() => {
    oldValue = process.env.ENGINE_API_KEY;
  });
  afterEach(() => {
    if (oldValue === undefined) {
      delete process.env.ENGINE_API_KEY;
    } else {
      process.env.ENGINE_API_KEY = oldValue;
    }
  });

  test('can specify apiKey as env var', async () => {
    const httpServer = http.createServer();
    const engine = new ApolloEngine();
    process.env.ENGINE_API_KEY = 'faked';
    try {
      const p = new Promise(resolve =>
        engine.listen(
          {
            port: '0',
            httpServer,
            launcherOptions: { proxyStderrStream: devNull() },
          },
          resolve,
        ),
      );
      await p;
    } finally {
      await engine.stop();
      httpServer.close();
    }
  });
});

describe('launch failure', () => {
  let engine: ApolloEngine | null = null;
  let httpServer: http.Server | null = null;
  beforeEach(() => {
    engine = null;
    httpServer = null;
  });
  afterEach(async () => {
    if (engine !== null) {
      const child = engine['launcher']['child'];
      if (child) {
        await engine.stop();
        expect(processIsRunning(child.pid)).toBe(false);
      }
      engine = null;
    }

    if (httpServer) {
      httpServer.close();
    }
  });
  test('emits error on invalid config', async () => {
    engine = new ApolloEngine({
      apiKey: 'faked',
      logging: {
        level: 'INVALID',
      },
      reporting: {
        disabled: true,
      },
    });

    const start = +new Date();
    httpServer = http.createServer();
    const p = new Promise((resolve, reject) => {
      // Help TS understand that these variables are still set.
      httpServer = httpServer!;
      engine = engine!;
      // We expect to get an error, so that's why we're *resolving* with it.
      engine!.once('error', err => {
        resolve(err.message);
      });
      engine!.listen(
        {
          httpServer,
          port: 0,
          launcherOptions: { proxyStderrStream: devNull() },
        },
        () => reject(new Error('Engine should not listen successfully')),
      );
    });
    await expect(p).resolves.toMatch(
      /Engine crashed due to invalid configuration/,
    );
    const end = +new Date();
    expect(end - start).toBeLessThan(5000);
  });
  if (os.type() === 'Windows_NT') {
    // Named pipes should actually work
    test('using pipePath on Windows should actually work', async () => {
      httpServer = http.createServer();
      httpServer = httpServer!;
      engine = new ApolloEngine({
        apiKey: 'faked',
        logging: {
          level: 'DEBUG',
          destination: 'STDERR',
        },
        reporting: {
          disabled: true,
        },
      });
      try {
        const p = new Promise(resolve => {
          httpServer = httpServer!;
          engine!.listen({ pipePath: '\\\\.\\pipe\\foo', httpServer }, resolve);
        });
        await p;
      } finally {
        await engine.stop();
        httpServer.close();
      }
    });
  } else {
    test('using pipePath on non-Windows results in a configuration error', async () => {
      engine = new ApolloEngine({
        apiKey: 'faked',
        reporting: {
          disabled: true,
        },
      });

      const start = +new Date();
      httpServer = http.createServer();
      const p = new Promise((resolve, reject) => {
        // Help TS understand that these variables are still set.
        httpServer = httpServer!;
        engine = engine!;
        // We expect to get an error, so that's why we're *resolving* with it.
        engine!.once('error', err => {
          resolve(err.message);
        });
        engine!.listen(
          {
            httpServer,
            pipePath: 'anything',
            launcherOptions: { proxyStderrStream: devNull() },
          },
          () => reject(new Error('Engine should not listen successfully')),
        );
      });
      await expect(p).resolves.toMatch(
        /Engine crashed due to invalid configuration/,
      );
      const end = +new Date();
      expect(end - start).toBeLessThan(5000);
    });
  }
});

runCleanupTests(false);
