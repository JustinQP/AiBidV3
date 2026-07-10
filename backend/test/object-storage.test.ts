import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  isOriginalObjectKeyWithinBoundary,
  ObjectStorageSizeLimitError,
  originalObjectKey,
} from '../src/domain/object-storage.js'
import { loadConfig } from '../src/config.js'
import { createObjectStorage } from '../src/infrastructure/object-storage-factory.js'
import { InMemoryObjectStorage } from '../src/infrastructure/memory/in-memory-object-storage.js'
import {
  ObjectStorageTimeoutError,
  S3ObjectStorage,
} from '../src/infrastructure/s3/s3-object-storage.js'
import type {
  S3CommandClient,
  S3ObjectStorageConfig,
} from '../src/infrastructure/s3/s3-object-storage.js'

const s3Config: S3ObjectStorageConfig = {
  endpoint: 'http://localhost:9000',
  region: 'us-east-1',
  bucket: 'aibid-test',
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
  forcePathStyle: true,
  requestTimeoutMs: 1_000,
}

describe('InMemoryObjectStorage', () => {
  it('copies object bytes and deletes objects idempotently', async () => {
    const storage = new InMemoryObjectStorage()
    const body = Buffer.from('original bytes')
    const reference = await storage.putObject({
      key: 'tenants/t1/projects/p1/files/f1/v1/original',
      body,
      contentType: 'text/plain',
      sha256: 'a'.repeat(64),
    })

    body.fill(0)
    const firstRead = await storage.getObject(reference)
    expect(firstRead.toString()).toBe('original bytes')
    firstRead.fill(0)
    await expect(storage.getObject(reference)).resolves.toEqual(Buffer.from('original bytes'))
    await expect(storage.getObject(reference, { maxBytes: 4 })).rejects.toBeInstanceOf(
      ObjectStorageSizeLimitError,
    )

    await storage.ping()
    await storage.deleteObject(reference)
    await storage.deleteObject(reference)
    await expect(storage.getObject(reference)).rejects.toThrow('Object was not found')
    await storage.close()
  })

  it('is the default factory implementation', async () => {
    const storage = createObjectStorage(loadConfig({}))
    expect(storage).toBeInstanceOf(InMemoryObjectStorage)
    await storage.close()
  })
})

describe('object key boundaries', () => {
  it('uses a canonical key and rejects a key from another tenant boundary', () => {
    const file = { tenantId: 'tenant-a', projectId: 'project-a', id: 'file-a' }
    const key = originalObjectKey(file)

    expect(key).toBe('tenants/tenant-a/projects/project-a/files/file-a/v1/original')
    expect(isOriginalObjectKeyWithinBoundary(key, file)).toBe(true)
    expect(isOriginalObjectKeyWithinBoundary(key, { ...file, tenantId: 'tenant-b' })).toBe(false)
  })
})

describe('S3ObjectStorage', () => {
  it('uses Put, Get, Delete, and HeadBucket with the configured bucket and version', async () => {
    const commands: unknown[] = []
    const abortSignals: Array<AbortSignal | undefined> = []
    const destroy = vi.fn()
    const client: S3CommandClient = {
      async send(command, options): Promise<unknown> {
        commands.push(command)
        abortSignals.push(options?.abortSignal)
        if (command instanceof PutObjectCommand) return { ETag: '"etag-value"', VersionId: 'version-1' }
        if (command instanceof GetObjectCommand) {
          return {
            Body: Readable.from([Buffer.from('stored bytes')]),
          }
        }
        return {}
      },
      destroy,
    }
    const storage = new S3ObjectStorage(s3Config, client)

    const reference = await storage.putObject({
      key: 'tenants/t1/projects/p1/files/f1/v1/original',
      body: Buffer.from('stored bytes'),
      contentType: 'text/plain',
      sha256: 'b'.repeat(64),
    })
    expect(reference).toEqual({
      key: 'tenants/t1/projects/p1/files/f1/v1/original',
      versionId: 'version-1',
      etag: 'etag-value',
    })
    await expect(storage.getObject(reference, { maxBytes: 12 })).resolves.toEqual(Buffer.from('stored bytes'))
    await storage.deleteObject(reference)
    await storage.ping()
    await storage.close()

    expect(commands).toHaveLength(4)
    expect(commands[0]).toBeInstanceOf(PutObjectCommand)
    expect((commands[0] as PutObjectCommand).input).toMatchObject({
      Bucket: 'aibid-test',
      Key: reference.key,
      ContentLength: 12,
      ContentType: 'text/plain',
      Metadata: { sha256: 'b'.repeat(64) },
    })
    expect(commands[1]).toBeInstanceOf(GetObjectCommand)
    expect((commands[1] as GetObjectCommand).input).toMatchObject({
      Bucket: 'aibid-test',
      Key: reference.key,
      VersionId: 'version-1',
      Range: 'bytes=0-12',
    })
    expect(commands[2]).toBeInstanceOf(DeleteObjectCommand)
    expect((commands[2] as DeleteObjectCommand).input).toMatchObject({
      Bucket: 'aibid-test',
      Key: reference.key,
      VersionId: 'version-1',
    })
    expect(commands[3]).toBeInstanceOf(HeadBucketCommand)
    expect((commands[3] as HeadBucketCommand).input).toEqual({ Bucket: 'aibid-test' })
    expect(abortSignals.every((signal) => signal instanceof AbortSignal)).toBe(true)
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('aborts requests that exceed the configured timeout', async () => {
    const client: S3CommandClient = {
      send(_command, options): Promise<unknown> {
        return new Promise((_resolve, reject) => {
          options?.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          })
        })
      },
      destroy() {},
    }
    const storage = new S3ObjectStorage({ ...s3Config, requestTimeoutMs: 5 }, client)

    await expect(storage.ping()).rejects.toBeInstanceOf(ObjectStorageTimeoutError)
    await storage.close()
  })

  it('enforces the deadline when a client ignores the abort signal', async () => {
    const client: S3CommandClient = {
      send(): Promise<unknown> {
        return new Promise(() => undefined)
      },
      destroy() {},
    }
    const storage = new S3ObjectStorage({ ...s3Config, requestTimeoutMs: 5 }, client)

    await expect(storage.ping()).rejects.toBeInstanceOf(ObjectStorageTimeoutError)
    await storage.close()
  })

  it('stops reading an object as soon as it exceeds the configured byte limit', async () => {
    const client: S3CommandClient = {
      async send(command): Promise<unknown> {
        if (command instanceof GetObjectCommand) {
          return {
            Body: Readable.from([Buffer.from('1234'), Buffer.from('5678')]),
          }
        }
        return {}
      },
      destroy() {},
    }
    const storage = new S3ObjectStorage(s3Config, client)

    await expect(
      storage.getObject({ key: 'oversized', versionId: null, etag: null }, { maxBytes: 5 }),
    ).rejects.toBeInstanceOf(ObjectStorageSizeLimitError)
    await storage.close()
  })

  it('destroys an oversized response body before rejecting from content length', async () => {
    const destroy = vi.fn()
    const client: S3CommandClient = {
      async send(command): Promise<unknown> {
        if (command instanceof GetObjectCommand) {
          return {
            ContentLength: 6,
            Body: {
              destroy,
              async *[Symbol.asyncIterator]() {
                yield Buffer.from('123456')
              },
            },
          }
        }
        return {}
      },
      destroy() {},
    }
    const storage = new S3ObjectStorage(s3Config, client)

    await expect(
      storage.getObject({ key: 'oversized', versionId: null, etag: null }, { maxBytes: 5 }),
    ).rejects.toBeInstanceOf(ObjectStorageSizeLimitError)
    expect(destroy).toHaveBeenCalledOnce()
    await storage.close()
  })
})

describe('object storage configuration', () => {
  it('loads an explicit S3 configuration', () => {
    const config = loadConfig({
      REPOSITORY_DRIVER: 'postgres',
      OBJECT_STORAGE_DRIVER: 's3',
      OBJECT_STORAGE_TIMEOUT_MS: '2500',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'aibid-test',
      S3_ACCESS_KEY: 'access-key',
      S3_SECRET_KEY: 'secret-key',
      S3_FORCE_PATH_STYLE: 'true',
    })

    expect(config).toMatchObject({
      repositoryDriver: 'postgres',
      objectStorageDriver: 's3',
      objectStorageTimeoutMs: 2_500,
      s3Endpoint: 'http://localhost:9000',
      s3Region: 'us-east-1',
      s3Bucket: 'aibid-test',
      s3AccessKeyId: 'access-key',
      s3SecretAccessKey: 'secret-key',
      s3ForcePathStyle: true,
    })
  })

  it('rejects unsafe or incomplete configuration combinations', () => {
    expect(() => createObjectStorage(loadConfig({ REPOSITORY_DRIVER: 'postgres' }))).toThrow(
      'OBJECT_STORAGE_DRIVER=s3 is required',
    )
    expect(() => loadConfig({ OBJECT_STORAGE_DRIVER: 's3' })).toThrow('S3_BUCKET is required')
    expect(() =>
      loadConfig({
        OBJECT_STORAGE_DRIVER: 's3',
        S3_BUCKET: 'aibid-test',
        S3_ACCESS_KEY: 'access-key',
      }),
    ).toThrow('S3_ACCESS_KEY and S3_SECRET_KEY must be provided together')
    expect(() => loadConfig({ S3_ENDPOINT: 'file:///tmp/bucket' })).toThrow(
      'S3_ENDPOINT must be a valid HTTP or HTTPS URL',
    )
    expect(() => loadConfig({ OBJECT_STORAGE_TIMEOUT_MS: '0' })).toThrow(
      'OBJECT_STORAGE_TIMEOUT_MS must be greater than zero',
    )
    expect(() => loadConfig({ S3_FORCE_PATH_STYLE: 'sometimes' })).toThrow(
      'S3_FORCE_PATH_STYLE must be a boolean',
    )
  })
})
