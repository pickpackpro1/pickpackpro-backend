import { success } from "@/lib/apiResponse";

export async function GET() {
  return success({
    silver: { minUnits: 1, invoiceMin: 1999 },
    gold: { minUnits: 2000, invoiceMin: 4999 },
    platinum: { minUnits: 5000, invoiceMin: null },
  });
}
