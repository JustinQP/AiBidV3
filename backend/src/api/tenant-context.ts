import type { FastifyRequest } from 'fastify'
import type { AppConfig } from '../config.js'
import { badRequest } from '../lib/app-error.js'

export function getTenantId(request: FastifyRequest, config: AppConfig): string {
  const header = request.headers['x-tenant-id']
  if (Array.isArray(header)) throw badRequest('INVALID_TENANT_ID', 'x-tenant-id must have one value')
  const tenantId = header ?? config.devTenantId
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tenantId)) {
    throw badRequest(
      'INVALID_TENANT_ID',
      'x-tenant-id must contain only letters, digits, underscores, or hyphens',
    )
  }
  return tenantId
}

