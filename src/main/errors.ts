export class AppError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(code: string, message: string, options: { retryable?: boolean; details?: unknown } = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function toErrorPayload(error: unknown): { code: string; message: string; retryable: boolean; details?: unknown } {
  if (error instanceof AppError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: error.details
    };
  }

  if (error instanceof Error) {
    return {
      code: "internal_error",
      message: error.message,
      retryable: false
    };
  }

  return {
    code: "internal_error",
    message: "Unknown application error",
    retryable: false,
    details: error
  };
}
