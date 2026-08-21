/**
 * Apps Script: publica la hoja "Facturación y Cobranzas" de la planilla
 * "Administración México" como JSON, para que el sync de pagos la lea sin
 * bajar el archivo entero.
 *
 * Instalación (una vez, 5 minutos, cuenta francisco@keepsmiling.com.ar):
 *   1. script.google.com → Nuevo proyecto → pegar este archivo.
 *   2. Cambiar SECRET por un secreto largo propio (cualquier frase sin espacios).
 *   3. Implementar → Nueva implementación → tipo "Aplicación web" →
 *      Ejecutar como: Yo · Acceso: Cualquier persona con el vínculo → Implementar.
 *      (La primera vez pide autorizar acceso a Sheets: aceptar.)
 *   4. Copiar la URL que termina en /exec y guardarla junto al secreto en
 *      crm-mx/.env.local:
 *        PLANILLA_MX_URL="https://script.google.com/macros/s/…/exec"
 *        PLANILLA_MX_SECRET="el-mismo-secreto"
 *
 * Después: npx tsx scripts/sync-pagos-planilla.ts (ver ese archivo).
 */
const SHEET_ID = "12n4w566gJmHa1ky73dmsRwRoHMorYemq95BIOCSKXog";
const TAB = "Facturación y Cobranzas";
const SECRET = "CAMBIAR-POR-UN-SECRETO-LARGO";

function doGet(e) {
  if (!e || !e.parameter || e.parameter.secret !== SECRET) {
    return ContentService.createTextOutput("no").setMimeType(ContentService.MimeType.TEXT);
  }
  const values = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TAB).getDataRange().getValues();
  const out = values.map(function (row) {
    return row.map(function (c) {
      if (c instanceof Date) return Utilities.formatDate(c, "America/Mexico_City", "yyyy-MM-dd");
      return c === "" ? null : c;
    });
  });
  return ContentService
    .createTextOutput(JSON.stringify({ tab: TAB, rows: out.length, values: out }))
    .setMimeType(ContentService.MimeType.JSON);
}
