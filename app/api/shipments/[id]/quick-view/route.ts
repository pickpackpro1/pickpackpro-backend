import { getShipmentViewBundle } from "@/lib/shipmentViewBundle";

export async function GET(req: Request, context: { params: { id: string } }) {
  return getShipmentViewBundle(req, context, "quick");
}
