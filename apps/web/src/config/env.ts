export interface WebConfig {
  apiBaseUrl: string;
}

export function loadWebConfig(environment: ImportMetaEnv = import.meta.env): WebConfig {
  const apiBaseUrl = environment.VITE_API_BASE_URL;
  if (!apiBaseUrl || (!apiBaseUrl.startsWith('/') && !URL.canParse(apiBaseUrl))) {
    throw new Error('VITE_API_BASE_URL must be an absolute path or valid URL');
  }
  return { apiBaseUrl: apiBaseUrl.replace(/\/$/, '') };
}
