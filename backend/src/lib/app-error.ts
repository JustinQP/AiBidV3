export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly title: string,
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
