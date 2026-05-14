import { NextResponse, type NextRequest } from "next/server";

export async function middleware(req: NextRequest) {
  if (!req.nextUrl.pathname.startsWith("/api")) return NextResponse.next();
  if (req.nextUrl.pathname === "/api/health") return NextResponse.next();
  if (req.nextUrl.pathname === "/api/auth/login") return NextResponse.next();

  const auth = req.headers.get("authorization");
  const forwardedUserId = req.headers.get("x-user-id");
  const hasCookie = req.cookies.getAll().some((cookie) => cookie.name.includes("auth-token") || cookie.name === "sb-access-token");
  if (!auth && !hasCookie && !forwardedUserId) {
    return Response.json({ success: false, error: "Not authenticated" }, { status: 401 });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"],
};
