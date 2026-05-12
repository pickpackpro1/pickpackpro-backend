import { z } from "zod";
import { ApiError } from "./apiResponse";

export async function json<T extends z.ZodTypeAny>(req: Request, schema: T): Promise<z.infer<T>> {
  const body = await req.json().catch(() => {
    throw new ApiError("Invalid JSON body", 400);
  });
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiError("Validation failed", 400, parsed.error.flatten());
  return parsed.data;
}

export const uuid = z.string().uuid();
export const pagination = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});
