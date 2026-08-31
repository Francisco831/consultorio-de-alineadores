// Protección con contraseña (HTTP Basic) para todo el panel.
export const config = { matcher: "/(.*)" };

export default function middleware(req) {
  const auth = req.headers.get("authorization") || "";
  const esperado = "Basic " + btoa("keepsmiling:Euge-2394");
  if (auth === esperado) return;
  return new Response("Panel Ortodoncistas — ingresá usuario y contraseña", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Panel Ortodoncistas"' },
  });
}
