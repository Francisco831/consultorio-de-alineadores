/**
 * Apps Script: publica las pestañas 2026 de la caja del consultorio
 * ("Caja Consultorio - SCALABRINI ORTIZ -") como JSON, para que la rutina
 * diaria importe la caja sin bajar el archivo entero por el navegador.
 *
 * Instalación (una vez, 5 minutos, cuenta francisco@keepsmiling.com.ar):
 *   1. script.google.com → Nuevo proyecto → pegar este archivo.
 *   2. Cambiar SECRET por un secreto largo propio (cualquier frase sin espacios).
 *   3. Implementar → Nueva implementación → tipo "Aplicación web" →
 *      Ejecutar como: Yo · Acceso: Cualquier persona con el vínculo → Implementar.
 *      (La primera vez pide autorizar acceso a Sheets: aceptar.)
 *   4. Copiar la URL /exec y guardarla junto al secreto en finanzas/.env.local:
 *        CAJA_AR_URL="https://script.google.com/macros/s/…/exec"
 *        CAJA_AR_SECRET="el-mismo-secreto"
 *
 * Después: npx tsx scripts/sync-caja-ar.ts (ver ese archivo).
 */
const SHEET_ID = "1sCLms1wUq7LL7TZRljvjnex3CYDDw0yNh83FeKC0J1I";
// nombres EXACTOS de las pestañas (ojo espacios dobles y finales)
const TABS = [
  "MONI", "MARIANA  MATELLI", "MARIANA KS", "ROCIO 2025",
  "EUGENIA 2020", "CONI 2020", "VIRGINIA ",
  "SOLICITUD FACTURAS Y CONSULTAS ",
];
const SECRET = "CAMBIAR-POR-UN-SECRETO-LARGO";

function doGet(e) {
  if (!e || !e.parameter || e.parameter.secret !== SECRET) {
    return ContentService.createTextOutput("no").setMimeType(ContentService.MimeType.TEXT);
  }
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const tabs = {};
  TABS.forEach(function (name) {
    const sh = ss.getSheetByName(name);
    if (!sh) return;
    tabs[name] = sh.getDataRange().getValues()
      .filter(function (row) {
        return row.some(function (c) { return c instanceof Date && c.getFullYear() >= 2026; });
      })
      .map(function (row) {
        return row.map(function (c) {
          if (c instanceof Date) return Utilities.formatDate(c, "America/Argentina/Buenos_Aires", "yyyy-MM-dd");
          return c === "" ? null : c;
        });
      });
  });
  return ContentService
    .createTextOutput(JSON.stringify({ tabs: tabs }))
    .setMimeType(ContentService.MimeType.JSON);
}
