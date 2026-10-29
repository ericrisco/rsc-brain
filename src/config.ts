// Settings come from the environment, read once at start. Nothing secret has a default.
export type Config = {
  databaseUrl: string
  port: number
  host: string
  timezone: string
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.RSC_BRAIN_DATABASE_URL
  if (!databaseUrl) {
    throw new Error('RSC_BRAIN_DATABASE_URL is not set. Point it at the PostgreSQL database for RSC Brain.')
  }
  const port = Number(env.RSC_BRAIN_PORT ?? 8090)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`RSC_BRAIN_PORT must be a port number, got "${env.RSC_BRAIN_PORT}".`)
  }
  return {
    databaseUrl,
    port,
    host: env.RSC_BRAIN_HOST ?? '127.0.0.1',
    timezone: env.RSC_BRAIN_TIMEZONE ?? 'UTC',
  }
}
