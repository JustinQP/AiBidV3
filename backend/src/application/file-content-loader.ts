import { createHash } from 'node:crypto'
import { ObjectStorageSizeLimitError, type ObjectStorage } from '../domain/object-storage.js'
import type { StoredProjectFile } from '../domain/models.js'
import type { BidRepository } from '../domain/repository.js'
import { AppError, dependencyErrorDiagnostic } from '../lib/app-error.js'

function unavailable(code: string, message: string, cause?: unknown): AppError {
  return new AppError(
    503,
    code,
    message,
    'Service Unavailable',
    cause === undefined ? undefined : dependencyErrorDiagnostic(cause),
  )
}

export class FileContentLoader {
  constructor(
    private readonly repository: BidRepository,
    private readonly objectStorage: ObjectStorage,
  ) {}

  async loadForProcessing(tenantId: string, fileId: string): Promise<StoredProjectFile | null> {
    const stored = await this.repository.findStoredFile(tenantId, fileId)
    if (!stored) return null

    let content: Buffer
    if (stored.source.kind === 'legacy-inline') {
      content = Buffer.from(stored.source.content)
    } else {
      try {
        content = await this.objectStorage.getObject(stored.source.reference, {
          maxBytes: stored.sizeBytes,
        })
      } catch (error) {
        if (error instanceof ObjectStorageSizeLimitError) {
          throw unavailable(
            'STORED_FILE_INTEGRITY_FAILED',
            'Stored file content did not match its recorded size',
          )
        }
        throw unavailable(
          'OBJECT_STORAGE_UNAVAILABLE',
          'Stored file content is temporarily unavailable',
          error,
        )
      }
    }

    if (content.length !== stored.sizeBytes) {
      throw unavailable(
        'STORED_FILE_INTEGRITY_FAILED',
        'Stored file content did not match its recorded size',
      )
    }
    const sha256 = createHash('sha256').update(content).digest('hex')
    if (sha256 !== stored.sha256) {
      throw unavailable(
        'STORED_FILE_INTEGRITY_FAILED',
        'Stored file content did not match its recorded digest',
      )
    }

    return {
      id: stored.id,
      tenantId: stored.tenantId,
      projectId: stored.projectId,
      fileName: stored.fileName,
      mediaType: stored.mediaType,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      parseStatus: stored.parseStatus,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      content: Buffer.from(content),
    }
  }
}
