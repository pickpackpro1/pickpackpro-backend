import { z } from "zod";
import { ApiError, error, handleApiError, success } from "@/lib/apiResponse";
import { prisma } from "@/lib/prisma";
import { supabaseAnon } from "@/lib/supabase";
import { json } from "@/lib/validation";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function POST(req: Request) {
  try {
    const body = await json(req, schema);
    const auth = await supabaseAnon.auth.signInWithPassword({
      email: body.email,
      password: body.password,
    });

    if (auth.error || !auth.data.session || !auth.data.user.email) {
      return error("Invalid email or password", 401);
    }

    const appUser = await prisma.users.findUnique({
      where: { email: auth.data.user.email },
      include: { clients: true },
    });
    if (!appUser) throw new ApiError("Application user profile not found", 403);
    if (!appUser.active) throw new ApiError("User account is disabled", 403);

    const updatedUser = await prisma.users.update({
      where: { id: appUser.id },
      data: { last_login_at: new Date() },
      include: { clients: true },
    });

    return success({
      user: updatedUser,
      supabaseUser: {
        id: auth.data.user.id,
        email: auth.data.user.email,
      },
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
