import type { AppConfig } from '../config.js'
import type { ObjectStorage } from '../domain/object-storage.js'
import { InMemoryObjectStorage } from './memory/in-memory-object-storage.js'
import { S3ObjectStorage } from './s3/s3-object-storage.js'

export function createObjectStorage(config: AppConfig): ObjectStorage {
  if (config.objectStorageDriver === 'memory') {
    if (config.repositoryDriver === 'postgres') {
      throw new Error('OBJECT_STORAGE_DRIVER=s3 is required when REPOSITORY_DRIVER=postgres')
    }
    return new InMemoryObjectStorage()
  }
  if (config.s3Bucket === null) {
    throw new Error('S3_BUCKET is required when OBJECT_STORAGE_DRIVER=s3')
  }
  if ((config.s3AccessKeyId === null) !== (config.s3SecretAccessKey === null)) {
    throw new Error('S3_ACCESS_KEY and S3_SECRET_KEY must be provided together')
  }

  return new S3ObjectStorage({
    endpoint: config.s3Endpoint,
    region: config.s3Region,
    bucket: config.s3Bucket,
    accessKeyId: config.s3AccessKeyId,
    secretAccessKey: config.s3SecretAccessKey,
    forcePathStyle: config.s3ForcePathStyle,
    requestTimeoutMs: config.objectStorageTimeoutMs,
  })
}

