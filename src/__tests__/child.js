// This script is run via child_process.fork by tests in order to test engine's
// process shutdown behavior.

// Note that you may need to manually run "npm install"/"tsc" before running
// tests to pick up changes to the non-test Engine code.
const { ApolloEngine, ApolloEngineLauncher } = require('../../lib');
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
  const launcher = new ApolloEngineLauncher(config);

  launcher
    .start()
    .then(() => {
      process.send({ pid: launcher.child.pid });
      setTimeout(maybeDie, 2);
    })
    .catch(err =>
      // Make sure thrown errors throw rather than end up in Promises.
      process.nextTick(() => {
        throw err;
      }),
    );
} else {
  const engine = new ApolloEngine(config);

  engine.listen({ port: 0, httpServer: http.createServer() }, () => {
    process.send({ pid: engine.launcher.child.pid });
    setTimeout(maybeDie, 2);
  });
}
