export const MAIN_SESSION_KEYS = ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL", "PI_OFFLINE"];

export function executorEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  MAIN_SESSION_KEYS.forEach((key) => delete env[key]);
  return env;
}
