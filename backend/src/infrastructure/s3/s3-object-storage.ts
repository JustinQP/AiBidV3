import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import type {
  DeleteObjectCommandInput,
  DeleteObjectCommandOutput,
  GetObjectCommandInput,
  GetObjectCommandOutput,
  HeadBucketCommandOutput,
  PutObjectCommandOutput,
  S3ClientConfig,
} from '@aws-sdk/client-s3'
import {
  ObjectStorageSizeLimitError,
  type GetObjectOptions,
  type ObjectReference,
  type ObjectStorage,
  type PutObjectInput,
} from '../../domain/object-storage.js'

type S3StorageCommand = PutObjectCommand | GetObjectCommand | DeleteObjectCommand | HeadBucketCommand
type S3Operation = 'put' | 'get' | 'delete' | 'ping'

export interface S3ObjectStorageConfig {
  endpoint: string | null
  region: string
  bucket: string
  accessKeyId: string | null
  secretAccessKey: string | null
  forcePathStyle: boolean
  requestTimeoutMs: number
}

export interface S3CommandClient {
  send(command: S3StorageCommand, options?: { abortSignal?: AbortSignal }): Promise<unknown>
  destroy(): void
}

export class ObjectStorageTimeoutError extends Error {
  constructor(operation: S3Operation, timeoutMs: number, cause?: unknown) {
    super(`S3 ${operation} request exceeded ${timeoutMs} ms`, { cause })
    this.name = 'ObjectStorageTimeoutError'
  }
}

function createClient(config: S3ObjectStorageConfig): S3CommandClient {
  const clientConfig: S3ClientConfig = {
    region: config.region,
    forcePathStyle: config.forcePathStyle,
  }
  if (config.endpoint !== null) clientConfig.endpoint = config.endpoint
  if (config.accessKeyId !== null && config.secretAccessKey !== null) {
    clientConfig.credentials = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    }
  }
  return new S3Client(clientConfig) as unknown as S3CommandClient
}

function normalizeEtag(value: string | undefined): string | null {
  if (value === undefined || value.length === 0) return null
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1)
  return value
}

function byteChunk(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (typeof value === 'string') return Buffer.from(value)
  throw new Error('S3 returned an unsupported response body chunk')
}

function destroyBody(body: GetObjectCommandOutput['Body']): void {
  const destroy = (body as { destroy?: () => void } | undefined)?.destroy
  if (typeof destroy === 'function') destroy.call(body)
}

async function readBody(
  body: GetObjectCommandOutput['Body'],
  key: string,
  abortSignal: AbortSignal,
  maxBytes?: number,
): Promise<Buffer> {
  if (!body || !(Symbol.asyncIterator in Object(body))) {
    throw new Error(`S3 returned an unreadable body for object: ${key}`)
  }

  const chunks: Buffer[] = []
  let totalBytes = 0
  const abortBody = () => destroyBody(body)
  if (abortSignal.aborted) abortBody()
  abortSignal.throwIfAborted()
  abortSignal.addEventListener('abort', abortBody, { once: true })
  try {
    for await (const value of body as AsyncIterable<unknown>) {
      abortSignal.throwIfAborted()
      const chunk = byteChunk(value)
      totalBytes += chunk.length
      if (maxBytes !== undefined && totalBytes > maxBytes) {
        destroyBody(body)
        throw new ObjectStorageSizeLimitError(key, maxBytes)
      }
      chunks.push(chunk)
    }
    return Buffer.concat(chunks, totalBytes)
  } finally {
    abortSignal.removeEventListener('abort', abortBody)
  }
}

export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3CommandClient

  constructor(
    private readonly config: S3ObjectStorageConfig,
    client?: S3CommandClient,
  ) {
    this.client = client ?? createClient(config)
  }

  async putObject(input: PutObjectInput): Promise<ObjectReference> {
    const output = await this.withTimeout('put', (abortSignal) =>
      this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: input.key,
          Body: input.body,
          ContentLength: input.body.length,
          ContentType: input.contentType,
          Metadata: { sha256: input.sha256 },
        }),
        { abortSignal },
      ),
    ) as PutObjectCommandOutput
    return {
      key: input.key,
      versionId: output.VersionId ?? null,
      etag: normalizeEtag(output.ETag),
    }
  }

  async getObject(reference: ObjectReference, options: GetObjectOptions = {}): Promise<Buffer> {
    const input: GetObjectCommandInput = {
      Bucket: this.config.bucket,
      Key: reference.key,
    }
    if (reference.versionId !== null) input.VersionId = reference.versionId
    if (options.maxBytes !== undefined) input.Range = `bytes=0-${options.maxBytes}`

    return this.withTimeout('get', async (abortSignal) => {
      const output = await this.client.send(new GetObjectCommand(input), {
        abortSignal,
      }) as GetObjectCommandOutput
      if (!output.Body) throw new Error(`S3 returned an empty body for object: ${reference.key}`)
      if (
        options.maxBytes !== undefined &&
        output.ContentLength !== undefined &&
        output.ContentLength > options.maxBytes
      ) {
        destroyBody(output.Body)
        throw new ObjectStorageSizeLimitError(reference.key, options.maxBytes)
      }
      return readBody(output.Body, reference.key, abortSignal, options.maxBytes)
    })
  }

  async deleteObject(reference: ObjectReference): Promise<void> {
    const input: DeleteObjectCommandInput = {
      Bucket: this.config.bucket,
      Key: reference.key,
    }
    if (reference.versionId !== null) input.VersionId = reference.versionId
    await this.withTimeout('delete', (abortSignal) =>
      this.client.send(new DeleteObjectCommand(input), { abortSignal }),
    ) as DeleteObjectCommandOutput
  }

  async ping(): Promise<void> {
    await this.withTimeout('ping', (abortSignal) =>
      this.client.send(new HeadBucketCommand({ Bucket: this.config.bucket }), { abortSignal }),
    ) as HeadBucketCommandOutput
  }

  async close(): Promise<void> {
    this.client.destroy()
  }

  private async withTimeout<T>(
    operation: S3Operation,
    request: (abortSignal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController()
    let timeout: NodeJS.Timeout | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        const error = new ObjectStorageTimeoutError(operation, this.config.requestTimeoutMs)
        controller.abort(error)
        reject(error)
      }, this.config.requestTimeoutMs)
    })
    try {
      return await Promise.race([
        Promise.resolve().then(() => request(controller.signal)),
        deadline,
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }
}

