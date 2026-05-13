import { success } from "@/lib/apiResponse";

export async function GET() {
  return success({
    SILVER: { min: 1, max: 1999 },
    GOLD: { min: 2000, max: 4999 },
    PLATINUM: { min: 5000, max: null },
    OTHERS: { min: null, max: null, description: "Custom pricing — set manually via ClientPriceList" },
  });
}
