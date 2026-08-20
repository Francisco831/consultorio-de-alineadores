// Herramientas de venta — el playbook comercial destilado del kit LATAM
// (Plan Comercial 2026, Manual KeepDay v2, Playbook KOS + Comercial 2025,
// comparativo de precios LATAM y los mails de Keudys; minado 8/8/2026,
// fuente completa en data/cuestionario_comercial_keepsmiling.md).
// Página estática a propósito: es material de consulta en la llamada.

const S = {
  h2: "text-base font-semibold tracking-tight",
  p: "text-sm leading-relaxed",
  muted: "text-sm text-muted-foreground leading-relaxed",
  quote:
    "border-l-2 border-primary/40 pl-3 text-sm italic leading-relaxed text-muted-foreground",
  li: "text-sm leading-relaxed",
  warn: "rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm leading-relaxed",
  ok: "rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm leading-relaxed",
  bad: "rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm leading-relaxed",
};

function Seccion({
  id,
  titulo,
  children,
  abierta,
}: {
  id: string;
  titulo: string;
  children: React.ReactNode;
  abierta?: boolean;
}) {
  return (
    <details id={id} open={abierta} className="rounded-lg border bg-card">
      <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold">
        {titulo}
      </summary>
      <div className="space-y-3 border-t px-4 py-4">{children}</div>
    </details>
  );
}

export default function HerramientasPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">
          Herramientas de venta
        </h1>
        <p className="text-sm text-muted-foreground">
          El playbook comercial KS destilado: pitch, competencia, proceso,
          KeepDay, precio y límites. Fuente: kit comercial LATAM 2026.
        </p>
      </div>

      <Seccion id="pitch" titulo="1 · El pitch" abierta>
        <blockquote className={S.quote}>
          “La única multinacional latinoamericana de ortodoncia invisible hecha
          para ortodoncistas latinoamericanos.”
        </blockquote>
        <p className={S.p}>
          Y el complemento: <strong>“somos empresa escuela”</strong> — lo que se
          vende no es el alineador sino la formación y el acompañamiento que
          vienen con iniciar con Keep.
        </p>
        <p className={S.p}>
          <strong>Credenciales duras</strong> (van en toda presentación): 7
          países · +8.000 ortodoncistas acreditados · +16 años · +35 convenios
          universitarios.
        </p>
        <p className={S.p}>
          <strong>Los 4 diferenciales</strong>, en cuatro palabras: marca
          internacional, laboratorio local, servicio, entregas en pocos días.
        </p>
      </Seccion>

      <Seccion id="competencia" titulo="2 · Por qué KS y no otra marca">
        <p className={S.p}>
          <strong>Contra los caros e importados (Invisalign, Spark,
          ClearCorrect)</strong> — acá el precio juega a favor. México:
          Complejo KS $26.900 MXN vs Spark $37.082 (−27%) y ClearCorrect
          $38.731 (−31%); Sencillo KS $12.700 vs ClearCorrect $24.930 (casi
          mitad). Además: sin cancelation fee ni costo de envío (ellos lo
          cobran), y entrega local vs +14-21 días de un caso importado.
        </p>
        <div className={S.warn}>
          El “entrega en 6-8 días” fue campaña regional dic/25 y Chile pidió no
          usarlo porque no cumplía esos tiempos. <strong>Confirmar el SLA de
          México antes de prometer un plazo.</strong>
        </div>
        <p className={S.p}>
          <strong>Contra los baratos (Aliwell)</strong> — el precio deja de ser
          argumento: Aliwell está abajo en Complejo y Medio. Se compite con:
          (1) <strong>valor por alineador</strong> (KS entrega más alineadores
          por etapa — comparar $/alineador, no precio de lista), (2){" "}
          <strong>servicio</strong>: los clientes de Aliwell se quejan de
          producción, diseño y de que “ya se perdió la atención personalizada”
          — espacios que Aliwell no va a explotar, y (3) el KOS, que nadie más
          ofrece (12 pasos, 12 meses, valuado USD 3.000-4.000, gratis).
        </p>
        <blockquote className={S.quote}>
          “No se trata de cambiar de marca, sino de ganar un mercado que hoy no
          estás atendiendo.” — la regla madre: KS no pelea de frente, se ofrece
          como marca adicional.
        </blockquote>
        <p className={S.muted}>
          Dato para no quedar pagando: Invisalign no tiene UN precio — tiene
          escalera por volumen del doctor. Preguntar en qué categoría está
          antes de comparar.
        </p>
      </Seccion>

      <Seccion id="frases" titulo="3 · Frases que venden / frases prohibidas">
        <div className={S.ok}>
          <p className="font-medium">Sí — literales del material:</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            <li>
              “Doctor(a), no venimos a vender alineadores… venimos a construir
              con usted.”
            </li>
            <li>
              “No vinimos a venderle más, vinimos a ayudarle a ser más: más
              líder, más clínico, más recordado por sus pacientes.”
            </li>
            <li>
              “Le propongo un caso piloto con acompañamiento clínico
              personalizado. Usted evalúa por resultados, no por promesas.”
            </li>
          </ul>
        </div>
        <div className={S.bad}>
          <p className="font-medium">No — marcadas como respuesta débil o prohibida:</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            <li>“Sí, pero es que los alineadores son costosos…” (justifica el precio en vez de construir valor)</li>
            <li>“Claro, me avisás cuando decidas…” (nunca salir sin próximo paso definido)</li>
            <li>“Si me cargás el caso hoy te hago un 20%.” (el descuento no es herramienta de cierre del vendedor)</li>
            <li>Comparar de frente contra otra marca — el material autorizado compara contra brackets, nunca contra Invisalign/Spark/Aliwell.</li>
          </ul>
        </div>
        <p className={S.p}>
          <strong>Reglas de registro:</strong> de usted al doctor y “nosotros”
          para la relación (“analicemos juntos”) · abrir reencuadrando, nunca
          vendiendo (“hoy no venimos a mostrarle algo nuevo”) · validar antes
          de proponer (“su clínica ya funciona bien”) · emoción antes que
          técnica · escuchar más de lo que se habla · el doctor no recuerda lo
          que dijiste sino cómo lo hiciste sentir.
        </p>
      </Seccion>

      <Seccion id="proceso" titulo="4 · La venta a un doctor nuevo, paso a paso">
        <ol className="list-decimal space-y-2 pl-5">
          <li className={S.li}>
            <strong>Encontrarlo.</strong> Panel segmentado por zona y
            potencial, no salir a ciegas. Estándar: 4 contactos diarios por
            asesor + 1 KeepDay mensual. Disparador de oro: apertura de
            consultorio nuevo (todo por decidir, ninguna lealtad que romper).
            El sábado es el día de mayor actividad clínica en MX.
          </li>
          <li className={S.li}>
            <strong>Primer contacto.</strong> Mail formal + WhatsApp corto con
            pregunta gancho. Llevar contenido de valor, no producto.
          </li>
          <li className={S.li}>
            <strong>La reunión (5 fases):</strong> preparación (historial en el
            CRM + objetivo concreto) → apertura → diagnóstico SPIN (“¿cómo está
            manejando hoy los alineadores?” / “¿qué desafíos encontró con otras
            marcas?”) → presentación de valor → cierre: “¿le parece si
            definimos juntos ese primer paso?”. En México la puerta de entrada
            es llamada → videollamada, no visita.
          </li>
          <li className={S.li}>
            <strong>Mostrar:</strong> los 4 diferenciales, credenciales,
            antes/después reales, comparativo de precios, demo del escáner
            (obligatoria en el 100% de las presentaciones).
          </li>
          <li className={S.li}>
            <strong>Convencer con el caso piloto:</strong> “usted evalúa por
            resultados, no por promesas — ¿le gustaría intentarlo con un
            paciente que ya tenga en mente?”
          </li>
          <li className={S.li}>
            <strong>Acreditación:</strong> es paga y es la puerta al ecosistema
            (MX mar/26: $2.500 MXN presencial / $1.900 virtual).
          </li>
          <li className={S.li}>
            <strong>Primeros 90 días (Beginner):</strong> KeepDay como
            prioridad 1, alerta al día 75 sin caso, 15% para el caso 2 en
            semana 10-11, graduación a Activo. El cuello del primer caso suele
            ser administrativo (carga + documentación), no clínico: acompañar
            la carga.
          </li>
        </ol>
      </Seccion>

      <Seccion id="prospect" titulo="5 · A quién ir a buscar (y a quién no)">
        <p className={S.p}>
          <strong>El buen prospect no es el que ya vende mucho:</strong> es el
          que tiene el material crudo y no lo está usando. Checklist de 5
          (CP09): ¿buen panel de pacientes pero pocos casos activos? ¿equipo
          motivado? ¿dispuesto a invertir mínimo en ads? ¿buena reputación o
          ubicación? ¿se deja guiar por KS?
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li className={S.li}>
            <strong>Beginner ideal:</strong> acreditado hace &lt;6 meses,
            consultorio activo, interesado sin caso aún. Alerta: &gt;12 meses
            sin caso → evaluar si vale la pena.
          </li>
          <li className={S.li}>
            <strong>Lapsed ideal:</strong> hizo 3+ casos y dejó por razón
            conocida. Alerta: conflicto grave o se fue a la competencia = no
            forzar.
          </li>
          <li className={S.li}>
            <strong>Activo con potencial:</strong> hace 1-3 casos/mes, quiere
            crecer y no sabe captar. Alerta: 5+ casos/mes → no necesita
            KeepDay, invertir en otro doctor.
          </li>
        </ul>
        <div className={S.bad}>
          <strong>NO-GO (basta uno):</strong> quiere “probar” sin comprometerse
          · no tiene equipo auxiliar · lo quiere en &lt;15 días · espera que KS
          le traiga los pacientes · no tiene base propia ni redes activas.
          “Si el doctor no cumple criterios GO, buscá otro candidato.”
        </div>
      </Seccion>

      <Seccion id="keepday" titulo="6 · KeepDay — el arma número 1">
        <blockquote className={S.quote}>
          “Un Beginner que hace su primer caso en un KeepDay tiene 3x más
          probabilidad de convertirse en doctor activo.”
        </blockquote>
        <p className={S.p}>
          No es un evento: es una jornada de venta montada en el consultorio
          del doctor. 1 por mes por asesor, obligatorio, pesa 10% de la
          comisión y solo cuenta registrado en el CRM. Expectativa: 5-15 casos
          en un día; <strong>el 70% se cierra después del evento</strong> — el
          seguimiento a 48h no es opcional.
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li className={S.li}>T-21 pitch al doctor · T-18 firma del compromiso · T-17→T-7 campaña de captación (mín. USD 50-100 en Meta Ads)</li>
          <li className={S.li}><strong>T-7 GO/NO-GO: mínimo 3 pacientes confirmados</strong> o se cancela</li>
          <li className={S.li}>T-6→T-1 entrenamiento del equipo + simulacro · T-0 evento (10 pacientes ideal / 6 aceptable / 3 mínimo)</li>
          <li className={S.li}>T+1 seguimiento de los que no cerraron · T+7 reporte y registro en CRM</li>
        </ul>
        <p className={S.muted}>
          Regla del manual: “el acompañamiento es NO NEGOCIABLE. No es
          ‘arrancar y me voy’.” KS pone material POP, escáner si el doctor no
          tiene, entrenamiento y el asesor todo el día.
        </p>
      </Seccion>

      <Seccion id="crecer" titulo="7 · De 1 caso a 5-10 (el salto de volumen)">
        <p className={S.p}>
          <strong>Criterio de Pancho:</strong> el salto lo produce la confianza
          en la técnica, no en la marca. El doctor de 1-2 casos no está
          eligiendo entre marcas: está decidiendo si los alineadores le sirven.
          La competencia real en ese tramo son los brackets — y la palanca es
          clínica (que le funcione un caso y lo vea), no comercial.
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li className={S.li}>
            <strong>La escalera de categorías ES el salto:</strong> Lista (1-4
            casos) → GOLD (5-19, −5%) → PLATINUM (20-34, −10%) → BLACK (35-49,
            −15%) → ELITE (50+, −20%). Pasar de 4 a 5 casos cambia el tramo de
            precio: cerrar con el próximo escalón, no con descuento suelto.
            Decirle a cada doctor cuántos casos acumula (la categoría se
            recalcula el 1 de enero).
          </li>
          <li className={S.li}>
            <strong>Encadenar los primeros casos:</strong> caso 1 con 20%, caso
            2 con 15% (meta: antes de 60 días), caso 3+ con 10%.
          </li>
          <li className={S.li}>
            <strong>La tesis KS:</strong> “optimizar lo que ya está en
            tratamiento es más rápido y rentable que esperar casos nuevos” —
            el volumen sale del cierre del doctor: entrenar a su equipo,
            guion de cierre, propuesta escrita.
          </li>
          <li className={S.li}>
            <strong>Reactivar la base dormida del doctor:</strong> revisar sus
            últimos 10 presupuestos no iniciados, activar mínimo 3 (“1 de cada
            3 escaneados que no inició puede reactivarse”).
          </li>
          <li className={S.li}>
            <strong>El segundo caso importa más que el primero</strong> — y un
            primer caso que sale mal cuesta el doctor entero.
          </li>
        </ul>
      </Seccion>

      <Seccion id="dormidos" titulo="8 · Recuperar a un doctor dormido">
        <p className={S.p}>
          Arranca SIEMPRE con una llamada de diagnóstico <strong>sin
          venta</strong>: “te llamo porque noté que hace tiempo no trabajamos
          juntos y genuinamente quería saber cómo estás.{" "}
          <em>No te voy a vender nada, solo entender qué pasó.</em>” Las 3
          preguntas, en orden: ¿dejaste los alineadores o cambiaste de
          proveedor? · si fue algo con KS, ¿qué pasó? · ¿qué podríamos hacer
          diferente?
        </p>
        <p className={S.p}>
          Con un <strong>inactivo</strong> (se acreditó y nunca cargó): tono
          “curiosidad, no reclamo”, la pregunta es “¿qué te frenó para cargar
          tu primer caso?”, y máximo 1 contacto por trimestre.
        </p>
        <div className={S.bad}>
          <strong>Lo que NO:</strong> vender en la llamada de diagnóstico ·
          reclamar la ausencia · arrancar por el descuento (el 20% es solo
          post-clasificación, con cupo) · insistir · forzar al que se fue por
          conflicto grave · pelear contra la marca que usa hoy (“KOS no es
          para competir, es para fortalecer su práctica”).
        </div>
        <p className={S.muted}>
          Palancas por grupo: 20% el próximo caso (“si sale bien, 2 más al
          15%”) · workshop de captación · Buddy VIP (un doctor top lo acompaña
          en el primer caso) · visita presencial al top 20 lapsed.
        </p>
      </Seccion>

      <Seccion id="precio" titulo="9 · Precio: cómo y cuándo hablar de plata">
        <blockquote className={S.quote}>
          “En KeepSmiling no competimos por precio. Competimos por respaldo,
          agilidad y confianza real.”
        </blockquote>
        <ul className="list-disc space-y-1 pl-5">
          <li className={S.li}>
            <strong>Secuencia canónica:</strong> diagnóstico → propuesta
            emocional → valor → <strong>precio recién en 4º lugar</strong>,
            como inversión (“la inversión es de X y tenemos formas de pago
            pensadas para ti”) → cierre sin presión. En el KeepDay el bloque
            “Inversión” arranca en el minuto 22 de 30.
          </li>
          <li className={S.li}>
            Si el doctor pregunta el precio directo: <strong>parafrasear</strong>{" "}
            (¿pregunta por el programa o por el alineador?), dar un aproximado
            y redirigir al objetivo de la reunión. No esquivar dos veces.
          </li>
          <li className={S.li}>
            <strong>Descuentos autorizados</strong> (siempre atados a hito, con
            tope o deadline): Beginner 1er caso 20% “sin letra chica” · caso 2
            15% · Bienvenida 3-2-1 (20/15/10) · reactivación Grupo A 20%.
            Nada más — y nunca como cierre del vendedor.
          </li>
          <li className={S.li}>
            <strong>Los asesores no otorgan condiciones de pago.</strong>{" "}
            Cuenta corriente: 30 días, aprobación en 24h (comercial +
            finanzas).
          </li>
        </ul>
      </Seccion>

      <Seccion id="limites" titulo="10 · Qué NUNCA prometer">
        <ul className="list-disc space-y-1 pl-5">
          <li className={S.li}>
            Plazo de entrega sin confirmar el SLA de México (el “6-8 días” es
            campaña regional, no promesa MX verificada).
          </li>
          <li className={S.li}>
            Cambio de alineador cada 7 días (KS es cada 14; Invisalign y Spark
            cada 7 — no entrar ahí).
          </li>
          <li className={S.li}>
            Refinamientos ilimitados: KS da 0 gratuitos en Complejo/Sencillo
            (la competencia da ilimitados en Complejo). Vender el borde:
            FULL hasta 3 reposiciones por etapa incluidas; MEDIUM 1; después
            se cobra.
          </li>
          <li className={S.li}>Casos Express: KS no los ofrece — no inventar el producto.</li>
          <li className={S.li}>Contención incluida (Smartee y ClearCorrect la incluyen, KS no).</li>
          <li className={S.li}>
            Nada clínico que el plan no diga: “no todo se resuelve con
            alineadores, hay que saber elegir al paciente” es parte del pitch,
            no una debilidad.
          </li>
        </ul>
      </Seccion>

      <Seccion id="sla" titulo="11 · Compromisos con número (lo que sí se puede prometer)">
        <ul className="list-disc space-y-1 pl-5">
          <li className={S.li}>SOS WhatsApp: respuesta &lt;2h, &gt;90% resuelto &lt;24h</li>
          <li className={S.li}>Welcome Kit digital &lt;24h post-acreditación</li>
          <li className={S.li}>Aprobación de cuenta corriente en 24h</li>
          <li className={S.li}>1 asesor cada 15 beginners · primera llamada 1-1 de 45 min · WhatsApp directo</li>
          <li className={S.li}>Acompañamiento del escaneo (presencial/virtual) y re-escaneo sin costo si hubo error</li>
          <li className={S.li}>Llamada de feedback 24-48h post-instalación</li>
          <li className={S.li}>KOS completo gratis: 12 pasos, 12 meses, reunión mensual de 30-45 min (valuado USD 3.000-4.000)</li>
        </ul>
        <div className={S.warn}>
          Estos SLA son del Plan Comercial 2026 regional. Antes de prometerlos
          en México confirmar cuáles ya operan acá (el canal SOS y el plazo de
          entrega, sobre todo).
        </div>
      </Seccion>

      <Seccion id="instagram" titulo="12 · Prospección por Instagram (censo 20/8)">
        <p className={S.p}>
          El censo de los 1.402 seguidores de @keepsmiling_mex dejó{" "}
          <strong>147 fichas nuevas</strong> en el CRM y marcó a las que ya
          existían. La regla de este canal es distinta a la del outbound: acá{" "}
          <strong>el doctor ya levantó la mano</strong> —te sigue— así que el
          primer mensaje no tiene que explicar quién sos, tiene que dar una razón
          para responder.
        </p>

        <h3 className={S.h2}>Dónde están</h3>
        <ul className="ml-4 list-disc space-y-1">
          <li className={S.li}>
            <strong>Por acreditarse → chip “Ortodoncistas que te siguen en IG”</strong>:
            115 ortodoncistas que te siguen y no compraron.
          </li>
          <li className={S.li}>
            <strong>Doctores → chip “Te siguen en IG”</strong>: 41 acreditados. A
            estos no se les vende: se les pide contenido y casos.
          </li>
          <li className={S.li}>
            El handle está en la ficha, arriba, al lado del bloque de WhatsApp.
            Para la mayoría de estos 147 <strong>es el único canal que hay</strong>.
          </li>
        </ul>

        <h3 className={S.h2}>Los tres mensajes</h3>
        <p className={S.muted}>
          Cortos a propósito. Un DM largo en Instagram no se lee, y el objetivo
          del primer mensaje no es vender: es que conteste.
        </p>

        <div className="space-y-1">
          <p className="text-sm font-medium">
            A · Ortodoncista que te sigue (los 15 de acción “DM presentación”)
          </p>
          <blockquote className={S.quote}>
            Hola Dra. [Nombre], soy [tu nombre] de KeepSmiling México. Vi que nos
            sigue y quería presentarme en persona. Somos fabricantes de
            alineadores, latinoamericanos, y trabajamos muy de cerca con
            ortodoncistas en [su ciudad]. ¿Le interesa que le mande cómo
            trabajamos y los precios? Sin compromiso.
          </blockquote>
          <p className={S.muted}>
            Personalizá <strong>la ciudad</strong>: está en el nombre de la
            cuenta (Mty, GDL, Querétaro, Hermosillo, Xalapa, Cancún). Es lo único
            que hace que el mensaje no parezca copiado.
          </p>
        </div>

        <div className="space-y-1">
          <p className="text-sm font-medium">
            B · Clínica multiespecialidad (los 16 de “invitar a KeepDay”)
          </p>
          <blockquote className={S.quote}>
            Hola, soy [tu nombre] de KeepSmiling México. Vi que nos siguen.
            Hacemos un KeepDay —una jornada con casos en vivo— y suele servir
            mucho a clínicas donde varios profesionales tocan ortodoncia.
            ¿Les mando la info de la próxima fecha?
          </blockquote>
          <p className={S.muted}>
            En una clínica la compra se decide a varias manos: el DM individual
            rinde poco, la invitación grupal rinde mucho.
          </p>
        </div>

        <div className="space-y-1">
          <p className="text-sm font-medium">
            C · Cuenta con audiencia (colegios, facultades, referentes)
          </p>
          <blockquote className={S.quote}>
            Hola, soy [tu nombre] de KeepSmiling México. Seguimos lo que publican
            y nos gustaría acercarnos: damos formación en ortodoncia con
            alineadores y podemos aportar una charla o un caso comentado, sin
            costo. ¿Con quién puedo hablarlo?
          </blockquote>
          <p className={S.muted}>
            Acá NO se vende. El Colegio de Ortodoncia de Chihuahua, la Facultad
            de Odontología de la UANL y el posgrado de la UJAT le hablan a cientos
            de ortodoncistas cada uno: valen como puerta, no como cliente.
          </p>
        </div>

        <div className={S.warn}>
          <strong>109 fichas tienen el país sin confirmar</strong> (tag{" "}
          <code>pais:por-confirmar</code>). El nombre de Instagram no dice de
          dónde son y la cuenta mexicana la sigue mucha gente de la red argentina
          de la marca. Antes de escribirles: abrir el perfil, mirar la bio, y si
          no es de México sacarle el tag <code>sigue-instagram</code>. Es un
          minuto por ficha y sin eso el resto del canal no se puede medir.
        </div>

        <div className={S.bad}>
          Nunca abrir con precio en un DM. El canal es de relación: precio recién
          cuando pidieron la información, y siempre por WhatsApp o mail, donde
          queda registro en el CRM.
        </div>
      </Seccion>

      <p className="text-xs text-muted-foreground">
        Fuente: kit comercial LATAM (Plan Comercial 2026, Manual KeepDay v2,
        Playbook KOS y Comercial 2025, comparativo de precios) + 62 mails de
        Keudys Alvarado, minado el 8/8/2026. Los precios MXN son del comparativo
        a esa fecha — verificar vigencia antes de usarlos en una propuesta.
      </p>
    </div>
  );
}
