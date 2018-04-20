// We put the hapi and koa tests in their own file because you can't even import
// hapi or koa-bodyparser on versions of Node older than 8 (due to async/await).

import * as http from 'http';

import { graphqlHapi } from 'apollo-server-hapi';
import * as hapi from 'hapi';

import { graphqlKoa } from 'apollo-server-koa';
import * as koa from 'koa';
import * as koaBodyparser from 'koa-bodyparser';
import * as koaRouter from 'koa-router';

import { schema, rootValue } from './schema';
import { runSuite, runSuitesForHttpServerFramework } from './engine-common';
import { ApolloEngine } from '../engine';

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
        return `${engine.engineListeningAddress!.url}/graphql`;
      },
      false,
      'hapi',
    );
  });
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
