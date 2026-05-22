import { NextResponse, type NextRequest } from "next/server";

const ALLOWED_ORIGIN =
  process.env.FRONTEND_URL ?? "https://pick-pack-pro-virid.vercel.app";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-User-Id, X-Shipment-Id, Cache-Control, Pragma",
  "Access-Control-Allow-Credentials": "true",
};

export async function middleware(req: NextRequest) {
  if (req.method === "OPTIONS") {
    return NextResponse.json({}, { status: 200, headers: CORS_HEADERS });
  }

  const response = NextResponse.next();
  Object.entries(CORS_HEADERS).forEach(([k, v]) => response.headers.set(k, v));

  if (!req.nextUrl.pathname.startsWith("/api")) return response;
  if (req.nextUrl.pathname === "/api/health") return response;
  if (req.nextUrl.pathname === "/api/auth/login") return response;
  if (req.nextUrl.pathname === "/api/auth/register") return response;

  const auth = req.headers.get("authorization");
  const forwardedUserId = req.headers.get("x-user-id");
  const hasCookie = req.cookies
    .getAll()
    .some(
      (cookie) =>
        cookie.name.includes("auth-token") || cookie.name === "sb-access-token"
    );

  if (!auth && !hasCookie && !forwardedUserId) {
    return NextResponse.json(
      { success: false, error: "Not authenticated" },
      { status: 401, headers: CORS_HEADERS }
    );
  }

  return response;
}

export const config = {
  matcher: ["/api/:path*"],
};
