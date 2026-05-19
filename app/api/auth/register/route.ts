import { error } from "@/lib/apiResponse";

export async function POST() {
  return error("Direct registration is disabled. Use invite flow.", 410);
}
