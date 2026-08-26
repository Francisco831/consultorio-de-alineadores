/**
 * Apps Script: publica la agenda de Google Calendar de UNA persona como JSON,
 * para que el CRM sepa a quién va a llamar antes de la llamada.
 *
 * POR QUÉ ESTO Y NO OAUTH (decisión 26/8/26): el repo no tiene ninguna
 * dependencia de Google ni dónde guardar un refresh token — todas las
 * credenciales del CRM viven en envs planas. Un .ics público obligaría a hacer
 * pública la agenda de una persona. Acá Rocío autoriza UNA vez en su propia
 * cuenta y el script corre como ella: el CRM solo ve lo que este archivo saca.
 * Mismo molde que gas-pagos-planilla.LISTO.gs, que ya está andando.
 *
 * Instalación (una vez, 5 minutos, EN LA CUENTA DE ROCÍO):
 *   1. Entrar a script.google.com con la cuenta de Rocío → Nuevo proyecto →
 *      pegar este archivo entero.
 *   2. Cambiar SECRET por un secreto largo propio, generado con
 *      `openssl rand -hex 24` (cualquier frase sin espacios sirve).
 *   3. Implementar → Nueva implementación → tipo "Aplicación web" →
 *      Ejecutar como: Yo (rocio@…) · Quién tiene acceso: Cualquier usuario →
 *      Implementar. La primera vez pide autorizar acceso a Calendar: aceptar.
 *   4. Copiar la URL que termina en /exec y cargarla en Vercel junto al secreto:
 *        CALENDAR_URL     = https://script.google.com/macros/s/…/exec
 *        CALENDAR_SECRET  = el mismo secreto de arriba
 *        CALENDAR_PROFILE = Rocío   (el `nombre` en la tabla profiles)
 *
 * Después: /api/sync/calendar lo lee solo (cron de Vercel). Ver docs/CALENDAR.md.
 *
 * OJO: cada vez que se edita este archivo hay que hacer Implementar → Nueva
 * implementación (o "Administrar implementaciones" → editar → Nueva versión).
 * Guardar el código NO actualiza la URL /exec que ya está publicada.
 */
const SECRET = "CAMBIAR-POR-UN-SECRETO-PROPIO";

/** Ventana hacia adelante. 14 días alcanza para la agenda de la semana y la
 *  que viene sin traer un año entero en cada corrida. */
const DIAS_ADELANTE = 14;

function doGet(e) {
  if (!e || !e.parameter || e.parameter.secret !== SECRET) {
    return ContentService.createTextOutput("no").setMimeType(ContentService.MimeType.TEXT);
  }

  const desde = new Date();
  const hasta = new Date(desde.getTime() + DIAS_ADELANTE * 24 * 60 * 60 * 1000);
  const eventos = CalendarApp.getDefaultCalendar().getEvents(desde, hasta).map(function (ev) {
    return {
      id: ev.getId(),
      titulo: ev.getTitle(),
      inicio: ev.getStartTime().toISOString(),
      fin: ev.getEndTime().toISOString(),
      todoElDia: ev.isAllDayEvent(),
      // el mail de los invitados es lo que después cruza contra doctors.email:
      // es el único match exacto que existe, el título es siempre a dedo
      invitados: ev.getGuestList().map(function (g) { return g.getEmail(); }),
      descripcion: ev.getDescription(),
      ubicacion: ev.getLocation(),
    };
  });

  return ContentService
    .createTextOutput(JSON.stringify({ generado: new Date().toISOString(), eventos: eventos }))
    .setMimeType(ContentService.MimeType.JSON);
}
