-- 0033: cerrar auth_allowlist_audit() para anon — el revoke que 0031 no hizo.
--
-- QUÉ PASÓ. 0031 creó tres funciones y a esta —la de auditoría de la allowlist,
-- 0031:131— le faltó el revoke que las otras sí tienen. En Postgres una función
-- nueva nace ejecutable por PUBLIC, así que quedó ejecutable por anon y el
-- chequeo 1 de security-checks pasó de OK a FALLA el 18/8, al aplicarla en
-- producción.
--
-- EXPOSICIÓN REAL: ninguna hoy. Devuelve `trigger`, y una función que devuelve
-- trigger no se puede invocar por RPC (el propio chequeo lo dice: "0 invocables
-- como RPC"). Esto restituye la regla del proyecto —cero SECURITY DEFINER
-- ejecutables por anon— que es la línea que el chequeo 1 defiende.
--
-- Revocar EXECUTE no afecta al trigger: el privilegio de ejecución de la función
-- se chequea al CREAR el trigger, no en cada disparo.

revoke execute on function auth_allowlist_audit() from public, anon, authenticated;
