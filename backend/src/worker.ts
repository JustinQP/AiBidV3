import os from 'node:os'
import { DevelopmentDocumentParser } from './application/development-document-parser.js'
import { DocumentParserRouter } from './application/document-parser.js'
import {
  DurableTaskWorker,
  type DurableTaskWorkerErrorContext,
} from './application/durable-task-worker.js'
import { FileContentLoader } from './application/file-content-loader.js'
import { OutboxRelay, type OutboxRelayErrorContext } from './application/outbox-relay.js'
import { loadConfig } from './config.js'
import { createObjectStorage } from './infrastructure/object-storage-factory.js'
import { IsolatedDocumentParser } from './infrastructure/parser/isolated-document-parser.js'
import { RedisTaskQueue } from './infrastructure/redis/redis-task-queue.js'
import { createRepository } from './infrastructure/repository-factory.js'

function diagnostic(error: unknown): Record<string, unknown> {
  const record = typeof error === 'object' && error !== null
    ? error as Record<string, unknown>
    : null
  return {
    name: error instanceof Error ? error.name : 'UnknownError',
    code: typeof record?.code === 'string' ? record.code : null,
  }
}

function log(level: 'info' | 'error', message: string, context: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, time: new Date().toISOString(), message, ...context })
  const output = level === 'error' ? process.stderr : process.stdout
  output.write(`${line}\n`)
}

const config = loadConfig()
if (config.repositoryDriver !== 'postgres') {
  throw new Error('The durable worker requires REPOSITORY_DRIVER=postgres')
}
if (config.objectStorageDriver !== 's3') {
  throw new Error('The durable worker requires OBJECT_STORAGE_DRIVER=s3')
}
if (config.redisUrl === null) throw new Error('REDIS_URL is required by the durable worker')

const workerId = config.workerId ?? `${os.hostname()}:${process.pid}`
const abortController = new AbortController()
let stopping = false

const repository = await createRepository(config)
const objectStorage = createObjectStorage(config)
const queue = new RedisTaskQueue({
  url: config.redisUrl,
  streamKey: config.redisStreamKey,
  consumerGroup: config.redisConsumerGroup,
  onError: (error) => log('error', 'Redis client error', { error: diagnostic(error) }),
})

const reportError = (
  error: unknown,
  context: DurableTaskWorkerErrorContext | OutboxRelayErrorContext,
): void => log('error', 'Durable task runtime error', { ...context, error: diagnostic(error) })

const relay = new OutboxRelay(
  repository,
  queue,
  {
    relayId: `${workerId}:relay`,
    pollIntervalMs: config.outboxPollIntervalMs,
    leaseMs: config.outboxLeaseMs,
    batchSize: config.outboxBatchSize,
    retryBackoffMs: config.taskRetryBackoffMs,
  },
  reportError,
)
const parser = new DocumentParserRouter(
  new DevelopmentDocumentParser(),
  new IsolatedDocumentParser({
    timeoutMs: config.parserTimeoutMs,
    maxOldGenerationSizeMb: config.parserMaxOldGenerationSizeMb,
  }),
)
const worker = new DurableTaskWorker(
  repository,
  queue,
  new FileContentLoader(repository, objectStorage),
  parser,
  {
    workerId,
    concurrency: config.workerConcurrency,
    leaseMs: config.taskLeaseMs,
    heartbeatMs: config.taskHeartbeatMs,
    maxAttempts: config.taskMaxAttempts,
    retryBackoffMs: config.taskRetryBackoffMs,
    queueClaimIdleMs: config.redisClaimIdleMs,
  },
  reportError,
)

function close(): void {
  if (stopping) return
  stopping = true
  abortController.abort()
  queue.interruptReads()
}

process.once('SIGTERM', close)
process.once('SIGINT', close)

try {
  await Promise.all([repository.ping(), objectStorage.ping(), queue.connect()])
  log('info', 'Durable task runtime started', {
    workerId,
    concurrency: config.workerConcurrency,
    parserTimeoutMs: config.parserTimeoutMs,
    parserMaxOldGenerationSizeMb: config.parserMaxOldGenerationSizeMb,
  })
  await Promise.all([
    relay.run(abortController.signal),
    worker.run(abortController.signal),
  ])
} catch (error) {
  process.exitCode = 1
  log('error', 'Durable task runtime stopped unexpectedly', { error: diagnostic(error) })
  abortController.abort()
} finally {
  await Promise.allSettled([queue.close(), objectStorage.close(), repository.close()])
  log('info', 'Durable task runtime stopped', { workerId })
}
