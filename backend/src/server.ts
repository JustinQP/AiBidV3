import { buildApp } from './app.js'
import { loadApiConfig } from './config.js'

const config = loadApiConfig()
const app = await buildApp({ config, enableLogger: true })
let closing = false

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (closing) return
  closing = true
  app.log.info({ signal }, 'shutting down')
  await app.close()
}

process.once('SIGTERM', () => void shutdown('SIGTERM'))
process.once('SIGINT', () => void shutdown('SIGINT'))

try {
  await app.listen({ host: config.host, port: config.port })
} catch (error) {
  app.log.error(error)
  process.exitCode = 1
  await app.close()
}
