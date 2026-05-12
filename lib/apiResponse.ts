export function success(data: unknown, status = 200) {
  return Response.json({ success: true, data }, { status });
}

export function error(message: string, status = 400, details?: unknown) {
  return Response.json({ success: false, error: message, details }, { status });
}

export function handleApiError(err: unknown) {
  if (err instanceof ApiError) return error(err.message, err.status, err.details);
  if (err instanceof Error) return error(err.message, 400);
  return error("Unexpected error", 500);
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status = 400,
    public details?: unknown,
  ) {
    super(message);
  }
}
