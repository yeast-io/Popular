// Configuration evidence only: custom dispatchers, NO_PROXY and system tunnels can change the route.
export function telegramNetworkDiagnostics(env: NodeJS.ProcessEnv = process.env) {
  const proxyEnvironment = Object.fromEntries(
    ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'].map((key) => {
      const value = env[key];
      if (!value) return [key, { configured: false }];
      try {
        const url = new URL(value);
        return [key, {
          configured: true,
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port,
          authenticationConfigured: Boolean(url.username || url.password),
        }];
      } catch {
        return [key, { configured: true, invalidUrl: true }];
      }
    })
  );
  return {
    targetHost: 'api.telegram.org',
    nodeVersion: process.version,
    nodeUseEnvProxy: env.NODE_USE_ENV_PROXY === '1',
    envProxyFlagSupported: process.allowedNodeEnvironmentFlags.has('--use-env-proxy'),
    envProxyFlagRequested: [...process.execArgv, env.NODE_OPTIONS ?? ''].some((value) => {
      return /(?:^|\s)--use-env-proxy(?:\s|$)/.test(value);
    }),
    noProxyConfigured: Boolean(env.NO_PROXY || env.no_proxy),
    proxyEnvironment,
    proxyRoute: 'unverified',
    timeoutMs: 15_000,
  };
}
