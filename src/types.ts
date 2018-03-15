export type EngineConfig = string | Object;

export interface LauncherOptions {
  // Milliseconds to wait for the proxy binary to start; set to <=0 to wait
  // forever.  If not set, defaults to 5000ms.
  startupTimeout?: number;
  proxyStdoutStream?: NodeJS.WritableStream;
  proxyStderrStream?: NodeJS.WritableStream;
  extraArgs?: string[];
  processCleanupEvents?: string[];
}

export interface ListeningAddress {
  ip: string;
  port: number;
  url: string;
}
