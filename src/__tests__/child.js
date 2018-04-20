// This script is run via child_process.fork by tests in order to test engine's
// process shutdown behavior. This file must be kept Node 4-compatible.

// Note that you may need to manually run "npm install"/"tsc" before running
// tests to pick up changes to the non-test Engine code.
const lib = require('../../lib');
const http = require('http');

const config = {
  apiKey: 'dummy',
  reporting: {
    disabled: true,
  },
  origins: [
    {
      http: {
        url: 'http://127.0.0.1:1234/graphql',
      },
    },
  ],
};

function maybeDie() {
  if (process.env.AEJ_TEST_UNCAUGHT_EXCEPTION) {
    throw new Error('bam');
  }
  if (process.env.AEJ_TEST_PROCESS_EXIT) {
    process.exit(42);
  }
}

if (process.env.AEJ_TEST_LAUNCHER) {
  const launcher = new lib.ApolloEngineLauncher(config);

  // Make sure thrown errors throw rather than end up in Promises.  (This is
  // isn't just inlined into the catch call later because otherwise prettier's
  // formatting will add a trailing comma after the function definition, which
  // breaks running tests on Node 6 and older.)
  function throwSoon(err) {
    process.nextTick(() => {
      throw err;
    });
  }

  launcher
    .start()
    .then(() => {
      process.send({ pid: launcher.child.pid });
      setTimeout(maybeDie, 2);
    })
    .catch(throwSoon);
} else {
  const engine = new lib.ApolloEngine(config);

  engine.listen({ port: 0, httpServer: http.createServer() }, () => {
    process.send({ pid: engine.launcher.child.pid });
    setTimeout(maybeDie, 2);
  });
}
