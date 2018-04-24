export type EngineConfig = string | Object;

export interface LauncherOptions {
  // Milliseconds to wait for the proxy binary to start; set to <=0 to wait
  // forever.  If not set, defaults to 5000ms.
  startupTimeout?: number;
  proxyStdoutStream?: NodeJS.WritableStream;
  proxyStderrStream?: NodeJS.WritableStream;
  extraArgs?: string[];
  processCleanupEvents?: string[];

  // Only for tests.
  extraEnv?: Record<string, string>;
}

export interface TcpListeningAddress {
  ip: string;
  port: number;
  url: string;
  pipeName: undefined;
}

export interface PipeListeningAddress {
  pipeName: string;
  url: undefined;
  port: undefined;
  ip: undefined;
}

export type ListeningAddress = TcpListeningAddress | PipeListeningAddress;
