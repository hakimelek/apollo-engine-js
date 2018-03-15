import { graphqlExpress, graphqlConnect } from 'apollo-server-express';
import { graphqlHapi } from 'apollo-server-hapi';
import { graphqlKoa } from 'apollo-server-koa';
import { microGraphql } from 'apollo-server-micro';
import * as bodyParser from 'body-parser';
import * as connect from 'connect';
import { NextHandleFunction } from 'connect';
import * as express from 'express';
import * as hapi from 'hapi';
import * as http from 'http';
import * as koa from 'koa';
import * as koaBodyparser from 'koa-bodyparser';
import * as koaRouter from 'koa-router';
import { default as micro } from 'micro';
import * as microRouter from 'microrouter';
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
  (req as any).query = qs.parse(parsedUrl.query);
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

runSuitesForHttpServerFramework('koa', {
  createApp() {
    const app = new koa();
    const path = '/graphql';
    const graphqlHandler = graphqlKoa({
      schema,
      rootValue,
      tracing: true,
      cacheControl: true,
    });
    const router = new koaRouter();
    router.post('/graphql', koaBodyparser(), graphqlHandler);
    router.get('/graphql', graphqlHandler);
    router.get('/graphql/ping', async ctx => {
      ctx.body = JSON.stringify({ pong: true });
    });
    app.use(router.routes());
    app.use(router.allowedMethods());
    return app;
  },
  serverForApp(app: any) {
    return http.createServer(app.callback());
  },
  appParameter: 'koaApp',
});

runSuitesForHttpServerFramework('micro', {
  createApp() {
    const handler = microGraphql({
      schema,
      rootValue,
      tracing: true,
      cacheControl: true,
    });

    return micro(
      microRouter.router(
        microRouter.get('/graphql/ping', () => {
          return JSON.stringify({ pong: true });
        }),
        microRouter.get('/graphql', handler),
        microRouter.get('/graphql/', handler),
        microRouter.post('/graphql', handler),
        microRouter.post('/graphql/', handler),
      ),
    );
  },
  serverForApp(app: any) {
    return app;
  },
  appParameter: 'httpServer',
});

// hapi requires its own API since it doesn't directly give you an http.Server.
describe('hapi integration', () => {
  let server: hapi.Server;
  let engine: ApolloEngine | null;
  beforeEach(() => {
    engine = null;
  });
  afterEach(async () => {
    if (engine) {
      await engine.stop();
    }
    await server.stop();
  });
  async function gqlServer(options: any) {
    server = new hapi.Server({
      ...options,
      router: {
        stripTrailingSlash: true,
      },
    } as hapi.ServerOptions);

    server.route({
      path: '/graphql/ping',
      method: 'GET',
      handler: () => {
        return JSON.stringify({ pong: true });
      },
    });

    await server.register({
      plugin: graphqlHapi,
      options: {
        path: '/graphql',
        graphqlOptions: {
          schema: schema,
          rootValue: rootValue,
          tracing: true,
          cacheControl: true,
        },
        route: {
          cors: true,
        },
      },
    } as any);
  }

  describe('without engine', () => {
    runSuite(
      async () => {
        await gqlServer({ host: 'localhost', port: 0 });
        await server.start();
        return `http://localhost:${server.info!.port}/graphql`;
      },
      true,
      'hapi',
    );
  });

  describe('with engine', () => {
    runSuite(
      async () => {
        engine = new ApolloEngine({
          apiKey: 'faked',
          logging: {
            level: 'WARN',
            destination: 'STDERR',
          },
          reporting: {
            disabled: true,
          },
          frontends: [
            {
              extensions: {
                strip: ['tracing'], // ... but not cache control!
              },
            },
          ],
        });
        const hapiListener = await engine.hapiListener({
          // Let engineproxy get an ephemeral port; we'll learn about it in the
          // listening callback.
          port: 0,
        });
        await gqlServer({ autoListen: false, listener: hapiListener });
        await server.start();
        return `${engine.engineListeningAddress.url}/graphql`;
      },
      false,
      'hapi',
    );
  });
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
});

runCleanupTests(false);
