// Marca de un retiro de los dueños en meta.tipo_origen.
//
// Vive fuera de lib/actions/retiros.ts porque un archivo "use server" sólo
// puede exportar funciones async: exportar la constante desde ahí rompe el
// build (y el typecheck no lo ve, lo caza recién el build de Next).
//
// No confundir con 'retiro_liquidacion', que es el retiro de una DOCTORA a
// cuenta de su liquidación y sí le descuenta saldo.
export const TIPO_RETIRO_SOCIO = "retiro_socio";
