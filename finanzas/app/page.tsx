import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { COOKIE_EMPRESA, esEmpresaSlug } from "@/lib/empresas";

export default async function Home() {
  const jar = await cookies();
  const last = jar.get(COOKIE_EMPRESA)?.value;
  if (last && esEmpresaSlug(last)) redirect(`/${last}/hoy`);
  redirect("/elegir");
}
