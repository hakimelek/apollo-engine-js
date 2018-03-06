const koa = require('koa');
const koaRouter = require('koa-router');
const koaBody = require('koa-bodyparser');
const { graphqlKoa } = require('apollo-server-koa');
const request = require('request');
const { assert } = require('chai');

const {
  schema,
  rootValue,
  verifyEndpointSuccess,
  verifyEndpointFailure,
  verifyEndpointError,
  verifyEndpointGet,
} = require('./schema');
const { testEngine } = require('./test');

describe('koa middleware', () => {
  let app;

  const echoRequestHeadersMiddleware = async (ctx, next) => {
    const { req, res } = ctx;
    const injectedHeader = ctx.req.headers['x-echo-header'];
    if (injectedHeader) {
      const reqHeaders = req.headers;
      ctx.set('x-echoed-request-headers', JSON.stringify(reqHeaders));
    }
    await next();
  };

  function gqlServer() {
    let graphqlHandler = graphqlKoa({
      schema,
      rootValue,
      tracing: true,
    });
    const router = new koaRouter();
    router.post('/graphql', koaBody(), graphqlHandler);
    router.get('/graphql', graphqlHandler);
    app.use(echoRequestHeadersMiddleware);
    app.use(router.routes());
    app.use(router.allowedMethods());
    return app.listen(0);
  }

  beforeEach(() => {
    app = new koa();
    // Don't print errors from middleware to stderr.
    app.silent = true;
  });

  describe('without engine', () => {
    let url;
    beforeEach(() => {
      let server = gqlServer();
      url = `http://localhost:${server.address().port}/graphql`;
    });

    it('processes successful query', () => {
      return verifyEndpointSuccess(url, true);
    });
    it('processes successful GET query', () => {
      return verifyEndpointGet(url, true);
    });
    it('processes invalid query', () => {
      return verifyEndpointFailure(url);
    });
    it('processes query that errors', () => {
      return verifyEndpointError(url);
    });
  });

  describe('with engine', () => {
    let url, engine;
    beforeEach(async () => {
      engine = testEngine();
      app.use(engine.koaMiddleware());
      let server = gqlServer();
      engine.graphqlPort = server.address().port;
      await engine.start();

      url = `http://localhost:${engine.graphqlPort}/graphql`;
    });
    afterEach(() => {
      engine.stop();
    });

    it('processes successful query', () => {
      return verifyEndpointSuccess(url, false);
    });
    it('processes successful GET query', () => {
      return verifyEndpointGet(url, false);
    });
    it('processes invalid query', () => {
      return verifyEndpointFailure(url);
    });
    it('processes query that errors', () => {
      return verifyEndpointError(url);
    });

    it('handles invalid response from engine', () => {
      // After engine has started, redirect the middleware to an invalid URL
      // This simulates engine returning an invalid response, without triggering
      // any actual bugs.
      engine.middlewareParams.uri = 'http://127.0.0.1:22';
      return new Promise(resolve => {
        request.post(
          {
            url,
            json: true,
            body: { query: '{ hello }' },
          },
          (err, response, body) => {
            assert.strictEqual(500, response.statusCode);
            resolve();
          },
        );
      });
    });

    it.only('passes Host header through Koa middleware', () => {
      var testKoaHeaders = {
        Host: 'example.com',
        'x-echo-header': 'xyz',
      };
      return new Promise(resolve => {
        request.post(
          {
            url,
            headers: testKoaHeaders,
            json: true,
            body: { query: '{hello}' },
          },
          (err, response, body) => {
            const echoedReq = JSON.parse(
              response.headers['x-echoed-request-headers'],
            );
            assert.strictEqual(echoedReq.host, testKoaHeaders['Host']);
            resolve();
          },
        );
      });
    });
  });
});