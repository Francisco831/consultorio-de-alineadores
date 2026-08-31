#!/usr/bin/env python3
"""Baja de Noloco (keepsmiling-v2) los datos del panel por ortodoncista → data.json.

Uso: python3 fetch_datos.py
Credenciales: usuario de servicio en ../tracer/.env (KEEPSMILING_EMAIL/PASSWORD).
Solo lectura. No dejar tokens ni credenciales en el HTML.
"""
import json
import os
import re
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone

API = "https://api.portals.noloco.io/data/keepsmiling-v2"
ENV_PATH = os.path.join(os.path.dirname(__file__), "..", "tracer", ".env")
OUT = os.path.join(os.path.dirname(__file__), "data.json")  # data del panel

HIST_DIAS = 180
PAGE = 200


def leer_env(path):
    vals = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                vals[k] = v
    return vals


def gql(query, token=None, variables=None, reintentos=3):
    body = {"query": query}
    if variables:
        body["variables"] = variables
    req = urllib.request.Request(API, data=json.dumps(body).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("x-noloco-project", "keepsmiling-v2")
    req.add_header("x-noloco-ghost", "false")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    for intento in range(reintentos):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.loads(r.read())
            break
        except Exception as e:
            if intento == reintentos - 1:
                raise
            print(f"  reintento {intento + 1} tras: {e}", file=sys.stderr)
            time.sleep(10 * (intento + 1))
    if data.get("errors"):
        raise RuntimeError(json.dumps(data["errors"])[:500])
    return data["data"]


def login(email, password):
    d = gql(f'mutation {{ login(email: "{email}", password: "{password}") {{ token }} }}')
    return d["login"]["token"]


def paginar(token, where, campos, label, coleccion="keepsmilingCasosCollection"):
    """Trae todas las páginas de una colección para un where dado."""
    nodos, cursor = [], None
    while True:
        after = f', after: "{cursor}"' if cursor else ""
        wh = f", where: {where}" if where else ""
        q = f"""{{ {coleccion}(first: {PAGE}{wh}{after}) {{
            totalCount
            edges {{ node {{ {campos} }} }}
            pageInfo {{ hasNextPage endCursor }}
        }} }}"""
        c = gql(q, token)[coleccion]
        nodos += [e["node"] for e in c["edges"]]
        print(f"  {label}: {len(nodos)}/{c['totalCount']}", file=sys.stderr)
        if not c["pageInfo"]["hasNextPage"]:
            return nodos
        cursor = c["pageInfo"]["endCursor"]


_JUNK = re.compile(r"(\d)\1{5,}")   # 6+ dígitos iguales seguidos = basura


def normalizar_telefono(tel, pais):
    """Devuelve dígitos en formato internacional para wa.me, o None si no es usable."""
    d = re.sub(r"\D", "", tel or "")
    if d.startswith("00"):
        d = d[2:]
    if not d or _JUNK.search(d):
        return None
    p = (pais or "").upper()
    if p == "ARGENTINA":
        if d.startswith("549") and len(d) == 13:
            return d
        if d.startswith("54") and len(d) == 12:
            return "549" + d[2:]
        if d.startswith("0") and len(d) == 11:
            d = d[1:]
        if len(d) == 10 and d[0] in "123" and not d.startswith("15"):
            return "549" + d
        return None
    if p == "PERU":
        if d.startswith("51") and len(d) == 11:
            return d
        return "51" + d if len(d) == 9 and d[0] == "9" else None
    if p == "CHILE":
        if d.startswith("56") and len(d) == 11:
            return d
        return "56" + d if len(d) == 9 and d[0] == "9" else None
    if p == "URUGUAY":
        if d.startswith("598") and len(d) == 11:
            return d
        if len(d) == 9 and d.startswith("09"):
            return "598" + d[1:]
        return "598" + d if len(d) == 8 and d[0] == "9" else None
    if p == "PARAGUAY":
        if d.startswith("595") and len(d) == 12:
            return d
        if len(d) == 10 and d.startswith("09"):
            return "595" + d[1:]
        return "595" + d if len(d) == 9 and d[0] == "9" else None
    if p == "BOLIVIA":
        if d.startswith("591") and len(d) == 11:
            return d
        return "591" + d if len(d) == 8 and d[0] in "67" else None
    if p == "COLOMBIA":
        if d.startswith("57") and len(d) == 12:
            return d
        return "57" + d if len(d) == 10 and d[0] == "3" else None
    if p == "ECUADOR":
        if d.startswith("593") and len(d) == 12:
            return d
        if len(d) == 10 and d.startswith("09"):
            return "593" + d[1:]
        return "593" + d if len(d) == 9 and d[0] == "9" else None
    # país desconocido: aceptar solo si ya parece internacional
    return d if 11 <= len(d) <= 15 else None


CAMPOS_COLA = """
    idExterno paciente subStage videoEstado pais sumaAlineadores doctorFullName
    doctores { id } userMovimientos { id fullName }
    fechaAsignacionMovimientos fechaEdicion fechaIngreso fechaRechazado rechazoDestino
    fechaProcesoMovimientos
"""

CAMPOS_HIST = """
    idExterno paciente stage subStage videoEstado pais sumaAlineadores doctorFullName
    doctores { id } userMovimientos { id fullName }
    fechaMovimientos fechaAsignacionMovimientos fechaEdicion
    fechaMovimientosAct fechaMovimientosActualizacion fechaVideoAct
    fechaRechazado rechazoDestino fechaAprobacionVideo
"""


def main():
    env = leer_env(ENV_PATH)
    token = login(env["KEEPSMILING_EMAIL"], env["KEEPSMILING_PASSWORD"])
    print("login OK", file=sys.stderr)

    ahora = datetime.now(timezone.utc)
    desde = (ahora - timedelta(days=HIST_DIAS)).strftime("%Y-%m-%dT00:00:00Z")
    hasta = (ahora + timedelta(days=1)).strftime("%Y-%m-%dT00:00:00Z")

    usuarios = [
        e["node"]
        for e in gql(
            "{ keepsmilingUserCollection(first: 300) { edges { node { id email fullName rol } } } }",
            token,
        )["keepsmilingUserCollection"]["edges"]
    ]

    cola = paginar(token, '{stage: {equals: "MOVIMIENTOS"}}', CAMPOS_COLA, "cola")
    rechazados = paginar(token, '{stage: {equals: "RECHAZADO"}}', CAMPOS_COLA, "rechazados")
    historico = paginar(
        token,
        f'{{fechaMovimientos: {{gte: "{desde}", lte: "{hasta}"}}}}',
        CAMPOS_HIST,
        "historico",
    )
    modif_coms = paginar(
        token,
        f'{{motivo: {{equals: "MODIFICACIONES_DE_VIDEO_YO_RENDERS"}}, createdAt: {{gte: "{desde}"}}}}',
        "createdAt estado mensajeCliente casos { idExterno } doctores { id }",
        "modif-coms",
        coleccion="keepsmilingComunicacionCollection",
    )

    doctoras_raw = paginar(
        token, None, "id nombre telefono pais aprobacionDirecta", "doctoras",
        coleccion="keepsmilingDoctoresCollection",
    )
    telefonos, tel_stats = {}, {}
    for dd in doctoras_raw:
        t = normalizar_telefono(dd.get("telefono"), dd.get("pais"))
        p = (dd.get("pais") or "?").upper()
        tot, ok = tel_stats.get(p, (0, 0))
        tel_stats[p] = (tot + 1, ok + (1 if t else 0))
        if t:
            telefonos[str(dd["id"])] = t
    for p, (tot, ok) in sorted(tel_stats.items(), key=lambda kv: -kv[1][0])[:8]:
        print(f"  tel {p}: {ok}/{tot} usables", file=sys.stderr)
    aprobacion_directa = {str(dd["id"]): True for dd in doctoras_raw if dd.get("aprobacionDirecta")}
    print(f"  aprobación directa: {len(aprobacion_directa)} doctoras", file=sys.stderr)

    # propuestas reales por caso (cantPropuestaCaso viene denormalizado en cada fila)
    propuestas_raw = paginar(
        token,
        f'{{createdAt: {{gte: "{desde}"}}}}',
        "relCaso { idExterno } cantPropuestaCaso",
        "propuestas",
        coleccion="keepsmilingPropuestasCollection",
    )
    propuestas_por_caso = {}
    for pr in propuestas_raw:
        caso = (pr.get("relCaso") or {}).get("idExterno")
        n = pr.get("cantPropuestaCaso")
        if caso and n:
            propuestas_por_caso[caso] = max(propuestas_por_caso.get(caso, 0), n)
    print(f"  propuestas: {len(propuestas_por_caso)} casos con conteo real", file=sys.stderr)

    with open(OUT, "w") as f:
        json.dump(
            {
                "generado": ahora.isoformat(),
                "histDias": HIST_DIAS,
                "usuarios": usuarios,
                "cola": cola,
                "rechazados": rechazados,
                "historico": historico,
                "modifComs": modif_coms,
                "telefonos": telefonos,
                "aprobacionDirecta": aprobacion_directa,
                "propuestasPorCaso": propuestas_por_caso,
            },
            f,
            ensure_ascii=False,
        )
    print(
        f"OK → data.json  (cola {len(cola)}, rechazados {len(rechazados)}, "
        f"histórico {len(historico)}, usuarios {len(usuarios)})",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
