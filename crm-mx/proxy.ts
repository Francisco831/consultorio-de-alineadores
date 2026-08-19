import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // refresca el token si expiró; no usar getSession() acá
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isLogin = request.nextUrl.pathname.startsWith("/login");
  if (!user && !isLogin) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  if (user && isLogin) {
    const url = request.nextUrl.clone();
    url.pathname = "/doctores";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: [
    // todo menos assets estáticos y /api/sync/* — el cron de Vercel no tiene
    // sesión: esa ruta se protege sola con CRON_SECRET (Bearer), y un redirect
    // a /login le respondería 307 al cron y el sync no correría nunca
    "/((?!_next/static|_next/image|favicon.ico|api/sync/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
