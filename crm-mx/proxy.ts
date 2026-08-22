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
    url.pathname = "/hoy";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: [
    // todo menos assets estáticos y las rutas que corren SIN sesión: /api/sync/*
    // y /api/ai/brief/cron se protegen solas con CRON_SECRET (Bearer) y
    // /api/webhooks/* con su token en la URL — un redirect a /login les
    // respondería 307 al cron/webhook y nunca correrían
    "/((?!_next/static|_next/image|favicon.ico|api/sync/|api/ai/brief/cron|api/webhooks/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
