import { Prisma } from "@prisma/client";

export function success(data: unknown, status = 200) {
  return Response.json({ success: true, data }, { status });
}

export function error(message: string, status = 400, details?: unknown) {
  return Response.json({ success: false, error: message, details }, { status });
}

export function handleApiError(err: unknown) {
  if (err instanceof ApiError) return error(err.message, err.status, err.details);
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      return error("A record with the same unique value already exists.", 409, { code: err.code });
    }
    if (err.code === "P2003") {
      return error("The request references related records that are missing or invalid.", 409, { code: err.code });
    }
    if (err.code === "P2028") {
      return error("The database transaction took too long to complete. Please retry the request.", 503, { code: err.code });
    }
    console.error("[api] Prisma request failed:", err);
    return error("Database request failed.", 500, { code: err.code });
  }
  if (err instanceof Prisma.PrismaClientValidationError) {
    console.error("[api] Prisma validation failed:", err);
    return error("Invalid database request.", 400);
  }
  if (err instanceof Error) {
    if (err.message.includes("Transaction API error") || err.message.includes("Transaction not found")) {
      return error("The database transaction took too long to complete. Please retry the request.", 503);
    }
    console.error("[api] Unexpected error:", err);
    return error("Unexpected server error", 500);
  }
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
