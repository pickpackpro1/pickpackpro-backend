import { z } from "zod";
import { ApiError, error, handleApiError, success } from "@/lib/apiResponse";
import { prisma } from "@/lib/prisma";
import { supabaseAnon } from "@/lib/supabase";
import { json } from "@/lib/validation";

const schema = z.object({
  refreshToken: z.string().min(1).optional(),
  refresh_token: z.string().min(1).optional(),
});

export async function POST(req: Request) {
  try {
    const body = await json(req, schema);
    const refreshToken = body.refreshToken ?? body.refresh_token;
    if (!refreshToken) return error("refreshToken is required", 400);

    const auth = await supabaseAnon.auth.refreshSession({
      refresh_token: refreshToken,
    });

    if (auth.error || !auth.data.session || !auth.data.user?.email) {
      return error("Invalid or expired refresh token", 401);
    }

    const appUser = await prisma.users.findUnique({
      where: { email: auth.data.user.email },
      include: { clients: true },
    });
    if (!appUser) throw new ApiError("Application user profile not found", 403);
    if (!appUser.active) throw new ApiError("User account is disabled", 403);

    return success({
      user: appUser,
      session: {
        accessToken: auth.data.session.access_token,
        refreshToken: auth.data.session.refresh_token,
        expiresAt: auth.data.session.expires_at,
        expiresIn: auth.data.session.expires_in,
        tokenType: auth.data.session.token_type,
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
