import { createHash } from 'node:crypto'
import type { ParseTask, ProjectFile } from '../domain/models.js'
import { originalObjectKey, type ObjectReference, type ObjectStorage } from '../domain/object-storage.js'
import type { BidRepository } from '../domain/repository.js'
import { AppError, dependencyErrorDiagnostic } from '../lib/app-error.js'

export interface UploadIngestionInput {
  file: ProjectFile
  task: ParseTask
  content: Buffer
}

interface IngestionErrorContext {
  tenantId: string
  projectId: string
  fileId: string
  stage: 'persistence-check' | 'compensation-delete'
}

function storageUnavailable(cause?: unknown): AppError {
  return new AppError(
    503,
    'OBJECT_STORAGE_UNAVAILABLE',
    'Object storage is temporarily unavailable',
    'Service Unavailable',
    cause === undefined ? undefined : dependencyErrorDiagnostic(cause),
  )
}

export class UploadIngestionService {
  constructor(
    private readonly repository: BidRepository,
    private readonly objectStorage: ObjectStorage,
    private readonly reportError: (error: unknown, context: IngestionErrorContext) => void = () => undefined,
  ) {}

  async ping(): Promise<void> {
    try {
      await this.objectStorage.ping()
    } catch (error) {
      throw storageUnavailable(error)
    }
  }

  async ingest(
    input: UploadIngestionInput,
  ): Promise<{ file: ProjectFile; task: ParseTask }> {
    const { file, task, content } = input
    if (content.length !== file.sizeBytes) {
      throw new Error('Upload content size does not match file metadata')
    }
    if (createHash('sha256').update(content).digest('hex') !== file.sha256) {
      throw new Error('Upload content digest does not match file metadata')
    }

    const expectedKey = originalObjectKey(file)
    let reference: ObjectReference
    try {
      reference = await this.objectStorage.putObject({
        key: expectedKey,
        body: content,
        contentType: file.mediaType,
        sha256: file.sha256,
      })
    } catch (error) {
      throw storageUnavailable(error)
    }

    if (reference.key !== expectedKey) {
      await this.compensate(reference, file)
      throw storageUnavailable()
    }

    try {
      return await this.repository.createUpload({
        file: { ...file, objectReference: { ...reference } },
        task,
      })
    } catch (error) {
      try {
        const committed = await this.findCommittedUpload(file, task, reference)
        if (committed) return committed
      } catch (checkError) {
        this.reportError(checkError, {
          tenantId: file.tenantId,
          projectId: file.projectId,
          fileId: file.id,
          stage: 'persistence-check',
        })
        // A failed or ambiguous check may mean COMMIT succeeded but its acknowledgement
        // was lost. Preserve the object so a reconciliation job can repair any orphan;
        // deleting here could create a durable database reference to a missing object.
        throw error
      }
      await this.compensate(reference, file)
      throw error
    }
  }

  private async findCommittedUpload(
    file: ProjectFile,
    task: ParseTask,
    reference: ObjectReference,
  ): Promise<{ file: ProjectFile; task: ParseTask } | null> {
    const [storedFile, storedTask] = await Promise.all([
      this.repository.findStoredFile(file.tenantId, file.id),
      this.repository.findTask(task.tenantId, task.id),
    ])
    if (!storedFile && !storedTask) return null

    const storedReference = storedFile?.source.kind === 'object'
      ? storedFile.source.reference
      : null
    if (
      storedFile &&
      storedTask &&
      storedFile.tenantId === file.tenantId &&
      storedFile.projectId === file.projectId &&
      storedTask.tenantId === task.tenantId &&
      storedTask.projectId === task.projectId &&
      storedTask.fileId === file.id &&
      storedReference?.key === reference.key &&
      storedReference.versionId === reference.versionId &&
      storedReference.etag === reference.etag
    ) {
      return {
        file: {
          id: storedFile.id,
          tenantId: storedFile.tenantId,
          projectId: storedFile.projectId,
          fileName: storedFile.fileName,
          mediaType: storedFile.mediaType,
          sizeBytes: storedFile.sizeBytes,
          sha256: storedFile.sha256,
          parseStatus: storedFile.parseStatus,
          createdAt: storedFile.createdAt,
          updatedAt: storedFile.updatedAt,
        },
        task: storedTask,
      }
    }

    throw new Error('Upload persistence outcome was ambiguous after the database error')
  }

  private async compensate(reference: ObjectReference, file: ProjectFile): Promise<void> {
    try {
      await this.objectStorage.deleteObject(reference)
    } catch (error) {
      this.reportError(error, {
        tenantId: file.tenantId,
        projectId: file.projectId,
        fileId: file.id,
        stage: 'compensation-delete',
      })
    }
  }
}
