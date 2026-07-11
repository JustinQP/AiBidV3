export interface ErrorDiagnostic {
  name: string
  code: string | null
  requestId: string | null
}

export function dependencyErrorDiagnostic(error: unknown): ErrorDiagnostic {
  const record = typeof error === 'object' && error !== null
    ? error as Record<string, unknown>
    : null
  const metadata = typeof record?.$metadata === 'object' && record.$metadata !== null
    ? record.$metadata as Record<string, unknown>
    : null
  const code = typeof record?.code === 'string'
    ? record.code
    : typeof record?.Code === 'string'
      ? record.Code
      : null
  const requestId = typeof metadata?.requestId === 'string'
    ? metadata.requestId
    : typeof record?.requestId === 'string'
      ? record.requestId
      : null
  return {
    name: error instanceof Error ? error.name : 'UnknownError',
    code,
    requestId,
  }
}

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly title: string,
    public readonly diagnostic?: ErrorDiagnostic,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export function badRequest(code: string, message: string): AppError {
  return new AppError(400, code, message, 'Bad Request')
}

export function notFound(code: string, message: string): AppError {
  return new AppError(404, code, message, 'Not Found')
}

export function unsupportedMediaType(code: string, message: string): AppError {
  return new AppError(415, code, message, 'Unsupported Media Type')
}

export function payloadTooLarge(code: string, message: string): AppError {
  return new AppError(413, code, message, 'Payload Too Large')
}

