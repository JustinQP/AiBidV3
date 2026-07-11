import {
  ObjectStorageSizeLimitError,
  type GetObjectOptions,
  type ObjectReference,
  type ObjectStorage,
  type PutObjectInput,
} from '../../domain/object-storage.js'

interface MemoryObject {
  body: Buffer
  etag: string
}

export class InMemoryObjectStorage implements ObjectStorage {
  private readonly objects = new Map<string, MemoryObject>()

  async putObject(input: PutObjectInput): Promise<ObjectReference> {
    this.objects.set(input.key, {
      body: Buffer.from(input.body),
      etag: input.sha256,
    })
    return { key: input.key, versionId: null, etag: input.sha256 }
  }

  async getObject(reference: ObjectReference, options: GetObjectOptions = {}): Promise<Buffer> {
    const object = this.objects.get(reference.key)
    if (!object) throw new Error(`Object was not found: ${reference.key}`)
    if (options.maxBytes !== undefined && object.body.length > options.maxBytes) {
      throw new ObjectStorageSizeLimitError(reference.key, options.maxBytes)
    }
    return Buffer.from(object.body)
  }

  async deleteObject(reference: ObjectReference): Promise<void> {
    this.objects.delete(reference.key)
  }

  async ping(): Promise<void> {}

  async close(): Promise<void> {
    this.objects.clear()
  }
}

