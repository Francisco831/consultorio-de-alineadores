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
    // Todo menos los assets estáticos y **todo `/api/`**.
    //
    // Hasta el 2/9/2026 esto excluía rutas de API una por una (`api/sync/`,
    // `api/ai/brief/cron`, `api/webhooks/`) y cada ruta nueva que corriera sin
    // sesión había que acordarse de sumarla. `/api/ops/respaldo` nació sin esa
    // línea y el redirect a /login se la comía: el cron del respaldo contestaba
    // 307 y no corría nunca. Un cron que no corre no avisa, así que eso podía
    // pasar meses sin que nadie lo notara.
    //
    // Excluir `/api/` entero es correcto, no una concesión: **cada ruta de API
    // se protege sola y es mejor puerta que ésta**. Las de cron y el respaldo
    // exigen `Authorization: Bearer $CRON_SECRET`, el webhook su token, y las
    // tres de IA verifican sesión y rol adentro del handler (`lib/ai/guard.ts`).
    // Además, a un cliente de API le corresponde un 401 en JSON y no un 307 a
    // una pantalla de login. Verificado el 2/9: las 13 rutas tienen su guard.
    "/((?!_next/static|_next/image|favicon.ico|api/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
