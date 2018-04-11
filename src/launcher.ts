import { EventEmitter } from 'events';
import { ChildProcess, spawn } from 'child_process';

import { EngineConfig, LauncherOptions, ListeningAddress } from './types';

// An arbitrary function; suitable as an EventEmitter event handler.
type eventHandler = (...args: any[]) => any;

// ApolloEngineLauncher knows how to run an engineproxy binary, wait for it to
// be listening, learn on what address it is listening, and restart it when it
// crashes. It doesn't know how to automatically connect it to a GraphQL server
// in this process --- that's what ApolloEngine is for. It's used to implement
// ApolloEngine, and it's an alternative to the Docker container for folks who
// want to put engineproxy in front of a non-Node GraphQL server.
export class ApolloEngineLauncher extends EventEmitter {
  private config: EngineConfig;
  private binary: string;
  private child: ChildProcess | null;
  private eventStopper?: () => void;

  // The constructor takes the same argument as ApolloEngine: the underlying
  // engineproxy config file.  Note that unlike the ApolloEngine constructor,
  // the config is mandatory, because you need to at least define an origin URL.
  public constructor(config: EngineConfig) {
    super();

    this.config = config;
    switch (process.platform) {
      case 'darwin':
        this.binary = require.resolve(
          'apollo-engine-binary-darwin/engineproxy_darwin_amd64',
        );
        break;
      case 'linux':
        this.binary = require.resolve(
          'apollo-engine-binary-linux/engineproxy_linux_amd64',
        );
        break;
      case 'win32':
        this.binary = require.resolve(
          'apollo-engine-binary-windows/engineproxy_windows_amd64.exe',
        );
        break;
      default:
        throw new Error('Unsupported platform');
    }
  }

  // start takes the same options as the launcherOptions option to
  // `ApolloEngine.listen`. It runs engineproxy, returning a Promise that
  // resolves once engineproxy is listening, or rejects if startup fails
  // (including due to a timeout). It restarts engineproxy if it exits for any
  // reason other than invalid config (emitting 'restarting' as it does so).
  // The Promise resolves to a structure telling on what port engineproxy is
  // listening.
  public start(options: LauncherOptions = {}): Promise<ListeningAddress> {
    if (this.child) {
      throw new Error(
        'Only call start() on an ApolloEngineLauncher object once',
      );
    }

    const spawnChild = () => {
      // We want to read from engineproxy's special listening reporter fd 3
      // (which we tell it about with an env var). We let it write directly to
      // our stdout and stderr (unless the user passes in their own output
      // streams) so we don't spend CPU copying output around (and if we crash
      // for some reason, engineproxy's output still gets seen). We don't care
      // about engineproxy's stdin.
      //
      // We considered having stdout and stderr always wrapped with a prefix. We
      // used to do this before we switched to JSON but apparently it was slow:
      // https://github.com/apollographql/apollo-engine-js/pull/50#discussion_r153961664
      // Users can use proxyStd*Stream to do this themselves, and we can make it
      // easier if it's popular.
      const stdio = ['ignore', 'inherit', 'inherit', 'pipe'];

      // If we are provided writable streams, ask child_process to create a pipe
      // which we will pipe to them. (We could put the streams directly in
      // `stdio` but this only works for pipes based directly on files.)
      if (options.proxyStdoutStream) {
        stdio[1] = 'pipe';
      }
      if (options.proxyStderrStream) {
        stdio[2] = 'pipe';
      }

      const args: string[] = ['-listening-reporter-fd=3'];
      const env = Object.assign({}, process.env);
      if (typeof this.config === 'string') {
        // Load config from a file. engineproxy will watch the file for changes.
        args.push(`-config=${this.config}`);
      } else {
        args.push(`-config=env`);
        env.ENGINE_CONFIG = JSON.stringify(this.config);
      }

      // Add extra arguments; used by ApolloEngine and by tests.
      if (options.extraArgs) {
        options.extraArgs.forEach(a => args.push(a));
      }

      // Add extra environment variables. Used by tests.
      if (options.extraEnv) {
        Object.keys(options.extraEnv).forEach(k => {
          env[k] = options.extraEnv![k];
        });
      }

      const child = spawn(this.binary, args, { stdio, env });
      this.child = child;

      // Hook up custom logging streams, if provided. We don't end the streams
      // when the child ends, as we may run several restarting childs against
      // one set of output streams.
      if (options.proxyStdoutStream) {
        child.stdout.pipe(options.proxyStdoutStream, { end: false });
      }
      if (options.proxyStderrStream) {
        child.stderr.pipe(options.proxyStderrStream, { end: false });
      }

      let listeningAddress = '';
      child.stdio[3].on('data', chunk => {
        listeningAddress += chunk.toString();
      });
      child.stdio[3].on('end', () => {
        // If we read something, then it started. (If not, then this is probably
        // just end of process cleanup.)
        if (listeningAddress !== '') {
          // Notify that proxy has started. The object is of the form `{ip:
          // "127.0.0.1", port: 1234}`.
          const la: ListeningAddress = JSON.parse(listeningAddress);
          // Convert IPs which mean "any address" (IPv4 or IPv6) into localhost
          // corresponding loopback ip. Note that the url field we're setting is
          // primarily for consumption by our test suite. If this heuristic is
          // wrong for your use case, explicitly specify a frontend host (in the
          // `frontends.host` field in your engine config, or in the `host`
          // option to ApolloEngine.listen).
          let hostForUrl = la.ip;
          if (la.ip === '' || la.ip === '::') {
            hostForUrl = 'localhost';
          }
          la.url = `http://${joinHostPort(hostForUrl, la.port)}`;
          this.emit('start', la);
        }
      });
      // Re-emit any errors from talking to engineproxy.
      // XXX Not super clear if this will happen in practice, but at least
      //     if it does, doing it this way will make it clear that the error
      //     is coming from Engine.
      child.stdio[3].on('error', err => this.emit('error', err));

      // Connect shutdown hooks:
      child.on('exit', (code, signal) => {
        if (!this.child) {
          // It's not an error if we've killed it (due to timeout or stop()).
          return;
        }
        if (code === 78) {
          this.emit(
            'error',
            new Error('Engine crashed due to invalid configuration.'),
          );
          return;
        }

        if (code != null) {
          this.emitRestarting(`Engine crashed unexpectedly with code: ${code}`);
        }
        if (signal != null) {
          this.emitRestarting(
            `Engine was killed unexpectedly by signal: ${signal}`,
          );
        }
        spawnChild();
      });
    };

    spawnChild();

    this.setUpStopEvents(
      options.processCleanupEvents || [
        'exit',
        'uncaughtException',
        'SIGINT',
        'SIGTERM',
        // We mostly care about SIGUSR2 because nodemon uses it.
        'SIGUSR2',
      ],
    );

    return new Promise((resolve, reject) => {
      let startupErrorHandler: (error: Error) => void;
      let cancelTimeout: NodeJS.Timer;
      if (options.startupTimeout === undefined || options.startupTimeout > 0) {
        cancelTimeout = setTimeout(() => {
          if (this.child) {
            this.child.kill('SIGKILL');
            this.child = null;
          }
          this.removeListener('error', startupErrorHandler);
          reject(Error('engineproxy timed out'));
        }, options.startupTimeout || 5000);
      }

      this.on('start', (listeningAddress: ListeningAddress) => {
        clearTimeout(cancelTimeout);
        this.removeListener('error', startupErrorHandler);
        resolve(listeningAddress);
      });

      // Errors during startup turn into rejections of the 'start'
      // Promise. Later errors are just emitted as 'error' events (as are
      // startup errors).
      startupErrorHandler = (error: Error) => {
        clearTimeout(cancelTimeout);
        this.child = null;
        reject(error);
      };
      this.once('error', startupErrorHandler);
    });
  }

  // Stops the process. The returned Promise resolves once the child has exited.
  public stop(): Promise<void> {
    if (this.child === null) {
      throw new Error('No engine instance running!');
    }
    if (this.eventStopper) {
      this.eventStopper();
    }
    const childRef = this.child;
    this.child = null;
    return new Promise(resolve => {
      childRef.on('exit', () => {
        resolve();
      });
      childRef.kill();
    });
  }

  private emitRestarting(error: string) {
    if (!this.emit('restarting', new Error(error))) {
      // No listeners; default to console.error.
      console.error(error);
    }
  }

  private setUpStopEvent(event: string): eventHandler {
    const handler = (maybeError?: Error) => {
      let childPromise = Promise.resolve();
      // Kill the child if it's running.
      if (this.child) {
        // Note that in the case of the 'exit' event we're not going to
        // actually get a chance to wait for anything to happen, but at least
        // we'll fire off the signal.
        childPromise = this.stop();
      }

      // For uncaughtException, rethrow the error. This does slightly change the
      // printed error (but not its stack trace) and converts the exit status of
      // 1 into 7, but it's pretty close. We do this synchronously rather than
      // allow the program to keep running after uncaught exception. Note that
      // we don't allow this function to be an async function, so that this
      // throw is truly synchronous.
      if (event === 'uncaughtException') {
        throw maybeError;
      }

      if (event.startsWith('SIG')) {
        // Wait for the child to finish. In a signal handler we can afford to
        // be asynchronous, unlike with 'exit' or 'uncaughtException'.
        childPromise.then(() => {
          // Re-signal self. Since this was a 'once', the signal won't hit this
          // handler again. Re-signaling ourself means that our exit status will
          // be as if we were killed by the signal we received, which is
          // something that things like nodemon like to see.
          process.kill(process.pid, event);
        });
      }
    };
    (process as EventEmitter).once(event, handler);
    return handler;
  }

  private setUpStopEvents(events: string[]) {
    const handlers = new Map<string, eventHandler>();
    events.forEach(event => {
      // Process any given event at most once.
      if (handlers.has(event)) {
        return;
      }
      handlers.set(event, this.setUpStopEvent(event));
    });
    this.eventStopper = () => {
      handlers.forEach((handler, event) => {
        process.removeListener(event, handler);
      });
      delete this.eventStopper;
    };
  }
}

// Literal IPv6 addresses contain colons and need to be wrapped in square
// brackets (like Go's net.JoinHostPort).
export function joinHostPort(host: string, port: number) {
  if (host.includes(':')) {
    host = `[${host}]`;
  }
  return `${host}:${port}`;
}
