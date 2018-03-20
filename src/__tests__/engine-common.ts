import * as http from 'http';
import * as request from 'request';
import { join as pathJoin } from 'path';
import { fork } from 'child_process';
import { stub, SinonStub } from 'sinon';

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

import { ApolloEngine } from '../engine';

const acceptableEndings = ['/', '?', '?123', '/?123'];

export function runSuite(
  before: Function,
  hasTracing: boolean,
  frameworkName: string,
) {
  let url: string;

  // micro has an unconfigurable behavior to console.error any error thrown by a
  // handler (https://github.com/zeit/micro/issues/329).  We use sinon to
  // override console.error; however, we use callThrough to ensure that by
  // default, it just calls console.error normally. The tests that throw errors
  // tell the stub to "stub out" console.error on the first call.
  let consoleErrorStub: SinonStub;

  beforeEach(async () => {
    consoleErrorStub = stub(console, 'error');
    consoleErrorStub.callThrough();

    url = await before();
  });

  afterEach(() => {
    consoleErrorStub.restore();
  });

  test('processes successful query', () => {
    return verifyEndpointSuccess(url, hasTracing);
  });
  acceptableEndings.forEach(acceptableEnding => {
    test(`using server endpoint ${acceptableEnding}`, () => {
      return verifyEndpointSuccess(url + acceptableEnding, hasTracing);
    });
  });
  test('processes successful GET query', () => {
    return verifyEndpointGet(url, hasTracing);
  });
  test('processes invalid query', () => {
    if (frameworkName === 'micro') {
      consoleErrorStub.onFirstCall().returns(undefined);
    }
    return verifyEndpointFailure(url);
  });
  test('processes query that errors', () => {
    return verifyEndpointError(url);
  });
  test('processes batched queries', () => {
    return verifyEndpointBatch(url, hasTracing);
  });
  test('returns cache information', async () => {
    const body: any = await verifyEndpointSuccess(url, hasTracing);
    expect(
      body['extensions'] && body['extensions']['cacheControl'],
    ).toBeDefined();
  });

  test('http proxying works', done => {
    const childUrl = `${url}/ping`;
    request(childUrl, (err, response, body) => {
      expect(err).toBe(null);
      expect(body).toBe('{"pong":true}');
      done();
    });
  });
}

export function runSuitesForHttpServerFramework(
  frameworkName: string,
  { createApp, serverForApp, appParameter }: any,
) {
  describe(`${frameworkName} integration`, () => {
    let httpServers: http.Server[] = [];
    let engine: ApolloEngine | null;

    beforeEach(() => {
      engine = null;
      httpServers = [];
    });
    afterEach(async () => {
      if (engine) {
        await engine.stop();
      }
      httpServers.forEach(server => server.close());
    });

    function gqlServer() {
      const app = createApp();
      const server = serverForApp(app);
      httpServers.push(server);
      return server.listen().address().port;
    }

    describe('without engine', () => {
      runSuite(
        async () => {
          return `http://localhost:${gqlServer()}/graphql`;
        },
        true,
        frameworkName,
      );
    });

    describe('with engine', () => {
      runSuite(
        async () => {
          const app = createApp();
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
          const p = new Promise(resolve => {
            engine!.listen(
              {
                // Let engineproxy get an ephemeral port; we'll learn about it in the
                // listening callback.
                port: 0,
                [appParameter]: app,
                launcherOptions: {
                  extraEnv: {
                    // engineproxy should only try to connect to our origin
                    // (reporting is diabled), which is on localhost, so this
                    // bad proxy should be ignored. This is a regression test
                    // from back when we would put unspecified IPs in the origin
                    // URL by default (instead of listening on 127.0.0.1 by
                    // default) and the Go http library would try to use the
                    // proxy (https://github.com/golang/go/issues/24737).
                    HTTP_PROXY: 'http://bad.proxy.example.com/',
                  },
                },
              },
              () => {
                resolve(`${engine!.engineListeningAddress!.url}/graphql`);
              },
            );
          });
          return await p;
        },
        false,
        frameworkName,
      );
    });
  });
}

export function runCleanupTests(forLauncher: boolean) {
  describe('engineproxy cleaned up', () => {
    ['SIGINT', 'SIGTERM', 'SIGUSR2', 'uncaughtException', 'exit'].forEach(
      event => {
        test(`on ${event}`, async () => {
          // There is no SIGUSR2 on Windows.
          if (event === 'SIGUSR2' && process.platform === 'win32') {
            return;
          }

          const env: NodeJS.ProcessEnv = {
            ...process.env,
          };
          if (forLauncher) {
            env.AEJ_TEST_LAUNCHER = 't';
          }
          if (event === 'uncaughtException') {
            env.AEJ_TEST_UNCAUGHT_EXCEPTION = 't';
          }
          if (event === 'exit') {
            env.AEJ_TEST_PROCESS_EXIT = 't';
          }
          const child = fork(pathJoin(__dirname, 'child.js'), [], {
            env,
            // You may want to remove the following line to debug failures in
            // these tests.
            silent: true,
          });
          const proxyPid = await new Promise<number>(resolve => {
            child.on('message', m => {
              resolve(m.pid);
            });
          });

          // Verify that the proxy exists.
          process.kill(proxyPid, 0);

          const childDone = new Promise(resolve => {
            child.on('exit', resolve);
          });

          if (event.startsWith('SIG')) {
            child.kill(event);
          }
          await childDone;

          // 'exit' and 'uncaughtException' don't actually wait for the proxy to
          // be gone, so sleep a bit to avoid races in tests.
          if (event === 'exit' || event === 'uncaughtException') {
            await new Promise(resolve => setTimeout(resolve, 10));
          }

          // Verify that the proxy is gone.
          expect(() => process.kill(proxyPid, 0)).toThrow();
        });
      },
    );
  });
}
