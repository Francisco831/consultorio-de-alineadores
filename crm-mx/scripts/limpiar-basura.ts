/**
 * Borra las filas que el parser de planillas coló como "doctores" pero no son
 * un lead: encabezados de tabla, nombres de ciudad y placeholders.
 *
 * CONSERVADOR a propósito: solo borra si NO tiene teléfono, NI email, NI casos,
 * NI pagos. Las clínicas ("Dental Gallardo", "Clinica Bukal") NO se tocan: son
 * targets comerciales legítimos aunque el nombre no sea una persona.
 *
 *   npx tsx scripts/limpiar-basura.ts            lista lo que borraría (no borra)
 *   npx tsx scripts/limpiar-basura.ts --aplicar  borra de verdad
 *
 * Borra filas: el modo por defecto NO escribe. `--dry` era opt-in, o sea que la
 * corrida más corta —la que uno tipea sin pensar— era la que borraba.
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { fetchAll } from "./lib/fetch-all";
import { confirmarDestino, salirConDestinoRechazado } from "./lib/destino";

config({ path: ".env.local" });

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

// encabezados de planilla, placeholders y ciudades sueltas
const NO_ES_LEAD =
  /^(acceso a plataforma|nombre apellido|sin nombre|nombre|apellidos?|telefono|teléfono|correo|email|direccion|dirección|ciudad|estado|documentaci[oó]n|total|resumen|pendientes?|contacto|prueba|test)$/i;
const CIUDADES =
  /^(ciudad (juarez|juárez|obregon|obregón|victoria|de mexico|de méxico)|guadalajara|monterrey|tijuana|mexicali|culiacan|culiacán|hermosillo|puebla|toluca|saltillo|torreon|torreón|merida|mérida|cancun|cancún|queretaro|querétaro|morelia|oaxaca|veracruz|tampico|mazatlan|mazatlán|la paz|chihuahua|durango|zacatecas|aguascalientes)$/i;

async function main() {
  const dry = !process.argv.includes("--aplicar");
  const doctors = await fetchAll<{
    id: string;
    nombre: string;
    phone: string | null;
    whatsapp: string | null;
    email: string | null;
    new_case_count: number;
    is_accredited: boolean;
  }>(
    db,
    "doctors",
    "id, nombre, phone, whatsapp, email, new_case_count, is_accredited"
  );

  const candidatos = doctors.filter((d) => {
    const n = d.nombre.trim();
    if (!(NO_ES_LEAD.test(n) || CIUDADES.test(n))) return false;
    // red de seguridad: cualquier señal de que es real y no se toca
    return (
      !d.phone && !d.whatsapp && !d.email && !d.new_case_count && !d.is_accredited
    );
  });

  console.log(`${doctors.length} doctores · ${candidatos.length} filas a borrar`);
  for (const c of candidatos) console.log("  -", JSON.stringify(c.nombre));
  if (candidatos.length === 0) return;
  if (dry) {
    console.log("\n  (no se borró nada — agregá --aplicar para ejecutarlo)");
    return;
  }

  await confirmarDestino({
    accion: `borrar ${candidatos.length} doctores sin teléfono, email, casos ni pagos`,
    destructivo: true,
    auto: process.argv.includes("--yes"),
  });

  for (const c of candidatos) {
    // solo se borra si de verdad no cuelga nada de negocio
    const { count: pagos } = await db
      .from("payments")
      .select("id", { count: "exact", head: true })
      .eq("doctor_id", c.id);
    const { count: casos } = await db
      .from("cases")
      .select("id", { count: "exact", head: true })
      .eq("doctor_id", c.id);
    if (pagos || casos) {
      console.log(`  ! ${c.nombre} tiene casos/pagos — NO se borra`);
      continue;
    }
    const { error } = await db.from("doctors").delete().eq("id", c.id);
    if (error) throw error;
  }
  console.log("listo ✓");
}

main().catch((e) => {
  salirConDestinoRechazado(e);
  console.error("Falló:", e);
  process.exit(1);
});
