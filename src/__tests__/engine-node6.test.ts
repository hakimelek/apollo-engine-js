// We put the micro tests in this file because you can't even import hapi or
// koa-bodyparser on versions of Node older than 6 (due to destructuring
// assignment).

import * as http from 'http';

import { microGraphql } from 'apollo-server-micro';
import { default as micro } from 'micro';
import * as microRouter from 'microrouter';

import { schema, rootValue } from './schema';
import { runSuite, runSuitesForHttpServerFramework } from './engine-common';
import { ApolloEngine } from '../engine';

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
