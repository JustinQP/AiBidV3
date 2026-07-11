export interface ObjectReference {
  key: string
  versionId: string | null
  etag: string | null
}

export interface ObjectKeyBoundary {
  tenantId: string
  projectId: string
  id: string
}

export function originalObjectKey(file: ObjectKeyBoundary): string {
  return `tenants/${file.tenantId}/projects/${file.projectId}/files/${file.id}/v1/original`
}

export function isOriginalObjectKeyWithinBoundary(key: string, file: ObjectKeyBoundary): boolean {
  const prefix = `tenants/${file.tenantId}/projects/${file.projectId}/files/${file.id}/`
  return key.startsWith(prefix) && /^v[1-9][0-9]*\/original$/.test(key.slice(prefix.length))
}

export interface PutObjectInput {
  key: string
  body: Buffer
  contentType: string
  sha256: string
}

export interface GetObjectOptions {
  maxBytes?: number
}

export class ObjectStorageSizeLimitError extends Error {
  constructor(
    public readonly key: string,
    public readonly maxBytes: number,
  ) {
    super(`Object exceeded the ${maxBytes} byte read limit: ${key}`)
    this.name = 'ObjectStorageSizeLimitError'
  }
}

export interface ObjectStorage {
  putObject(input: PutObjectInput): Promise<ObjectReference>
  getObject(reference: ObjectReference, options?: GetObjectOptions): Promise<Buffer>
  deleteObject(reference: ObjectReference): Promise<void>
  ping(): Promise<void>
  close(): Promise<void>
}

