import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import Fastify from 'fastify'
import type { FastifyError } from 'fastify'
import { DevelopmentDocumentParser } from './application/development-document-parser.js'
import { FileContentLoader } from './application/file-content-loader.js'
import { UploadIngestionService } from './application/upload-ingestion-service.js'
import { UploadProcessingService } from './application/upload-processing-service.js'
import { registerRoutes } from './api/routes.js'
import { loadConfig } from './config.js'
import type { AppConfig } from './config.js'
import type { ObjectStorage } from './domain/object-storage.js'
import type { BidRepository } from './domain/repository.js'
import { createObjectStorage } from './infrastructure/object-storage-factory.js'
import { createRepository } from './infrastructure/repository-factory.js'
import { AppError, dependencyErrorDiagnostic } from './lib/app-error.js'

export interface BuildAppOptions {
  config?: AppConfig
  repository?: BidRepository
  objectStorage?: ObjectStorage
  enableLogger?: boolean
}

export async function buildApp(options: BuildAppOptions = {}) {
  const config = options.config ?? loadConfig()
  const repository = options.repository ?? (await createRepository(config))
  const objectStorage = options.objectStorage ?? createObjectStorage(config)
  const app = Fastify({
    logger: options.enableLogger ? { level: config.logLevel } : false,
    bodyLimit: 1024 * 1024,
  })
  const processor = new UploadProcessingService(
    repository,
    new FileContentLoader(repository, objectStorage),
    new DevelopmentDocumentParser(),
    config.devParserDelayMs,
    (error, context) => app.log.error({ err: error, ...context }, 'development parser task failed'),
  )
  const ingestion = new UploadIngestionService(repository, objectStorage, (error, context) => {
    app.log.error(
      { dependencyError: dependencyErrorDiagnostic(error), ...context },
      'upload ingestion recovery requires attention',
    )
  })
  const recoveredTasks = await repository.recoverPendingTasks()
  for (const task of recoveredTasks) {
    processor.enqueue(task.tenantId, task.id)
  }

  await app.register(cors, {
    origin: config.corsOrigins,
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-tenant-id'],
  })
  await app.register(multipart, {
    limits: { files: 1, fileSize: config.maxUploadBytes },
  })

  app.setNotFoundHandler((request, reply) => {
    return reply.type('application/problem+json').code(404).send({
      type: 'https://aibid.dev/problems/route-not-found',
      title: 'Not Found',
      status: 404,
      detail: 'Route was not found',
      instance: request.url,
      code: 'ROUTE_NOT_FOUND',
      requestId: request.id,
    })
  })

  app.setErrorHandler((error: FastifyError | AppError, request, reply) => {
    const isKnown = error instanceof AppError
    const status = isKnown ? error.status : (error.statusCode ?? 500)
    const isMultipartLimit = status === 413
    const code = isKnown
      ? error.code
      : isMultipartLimit
        ? 'FILE_TOO_LARGE'
        : status < 500
          ? 'REQUEST_REJECTED'
          : 'INTERNAL_ERROR'
    const title = isKnown
      ? error.title
      : isMultipartLimit
        ? 'Payload Too Large'
        : status < 500
          ? 'Request Rejected'
          : 'Internal Server Error'
    const detail = isKnown || status < 500 ? error.message : 'An unexpected error occurred'
    if (status >= 500) request.log.error({ err: error }, 'request failed')
    return reply.type('application/problem+json').code(status).send({
      type: `https://aibid.dev/problems/${code.toLowerCase().replaceAll('_', '-')}`,
      title,
      status,
      detail,
      instance: request.url,
      code,
      requestId: request.id,
    })
  })

  await registerRoutes(app, { config, repository, ingestion, processor })
  app.addHook('onClose', async () => {
    await processor.waitForIdle()
    try {
      await repository.close()
    } finally {
      await objectStorage.close()
    }
  })
  return app
}
