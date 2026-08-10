#!/usr/bin/env python3
"""Parsea la tab 'Viabilidades' de la planilla de Angie/Ursula → data/viabilidades.json

Columnas: n, Asesor, % Cierre, Fecha Viab, Doctor, Paciente, Viabilidad (nivel),
ID (externo si se convirtió), Cupón, Vencimiento, Seguimiento, Convertido (fecha).
Filas separadoras de mes: solo traen una fecha en la col Asesor → dan contexto
de mes para filas sin Fecha Viab.

Matching de doctor contra Noloco (gestion-mx/data/noloco_mx.json) por token-set,
igual criterio que parse_enrichment.py.
"""
import json
import re
import unicodedata
from datetime import date, datetime
from pathlib import Path

import openpyxl

BASE = Path(__file__).resolve().parent.parent
XLSX = BASE / "data" / "viabilidades.xlsx"
NOLOCO = BASE.parent / "gestion-mx" / "data" / "noloco_mx.json"
OUT = BASE / "data" / "viabilidades.json"

STOP = {"dr", "dra", "doctor", "doctora", "med", "od", "cd", "mtro", "mtra"}


def norm(s):
    s = unicodedata.normalize("NFD", s or "")
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9 ]", " ", s.lower()).strip()


def tokens(s):
    return {t for t in norm(s).split() if len(t) > 1 and t not in STOP}


def main():
    # doctores Noloco: id -> nombre + tokens
    raw = json.load(open(NOLOCO))
    casos = raw["casos"] if isinstance(raw, dict) else raw
    doctors = {}
    for c in casos:
        d = c.get("doctores")
        if d and d["id"] not in doctors:
            doctors[d["id"]] = {"nombre": d["nombre"], "toks": tokens(d["nombre"])}

    def match_doctor(nombre):
        t = tokens(nombre)
        if not t:
            return None, 0.0
        best, score = None, 0.0
        for did, d in doctors.items():
            if not d["toks"]:
                continue
            inter = len(t & d["toks"])
            s = inter / max(1, min(len(t), len(d["toks"])))
            # bonus por cobertura del nombre más corto completo
            if s > score or (s == score and best and inter > 0):
                best, score = did, s
        return (best, score) if score >= 0.67 else (None, score)

    wb = openpyxl.load_workbook(XLSX, read_only=True, data_only=True)
    ws = wb["Viabilidades"]

    rows = []
    month_ctx = None
    for r in ws.iter_rows(min_row=2, values_only=True):
        r = list(r) + [None] * (12 - len(r))
        n, asesor, pct, fecha, doctor, paciente, nivel, id_ext, cupon, venc, seg, conv = r[:12]
        # separador de mes: fecha en la columna asesor y el resto vacío
        if isinstance(asesor, datetime) and not doctor and not paciente:
            month_ctx = asesor.date()
            continue
        if not doctor and not paciente:
            continue
        f = fecha.date() if isinstance(fecha, datetime) else month_ctx
        c = conv.date() if isinstance(conv, datetime) else None
        try:
            p = float(pct) if pct is not None else None
        except (TypeError, ValueError):
            p = None
        rows.append(
            {
                "asesor": str(asesor).strip() if asesor else None,
                "pct_cierre": p,
                "fecha_viab": f.isoformat() if f else None,
                "doctor_raw": str(doctor).strip() if doctor else None,
                "paciente": str(paciente).strip() if paciente else None,
                # OJO: la columna "Viabilidad" de la planilla NO es el nivel
                # (Medium/Full/Fast) — trae quién la gestiona (ej. "Rocio")
                "gestionada_por": str(nivel).strip() if nivel else None,
                "id_externo": str(id_ext).strip() if id_ext else None,
                "vencimiento": venc.date().isoformat() if isinstance(venc, datetime) else None,
                "seguimiento": str(seg).strip() if seg else None,
                "convertido": c.isoformat() if c else None,
            }
        )

    matched = 0
    for row in rows:
        did, score = match_doctor(row["doctor_raw"] or "")
        row["doctor_noloco_id"] = did
        row["match_score"] = round(score, 2)
        if did:
            row["doctor_noloco_nombre"] = doctors[did]["nombre"]
            matched += 1

    OUT.write_text(json.dumps(rows, ensure_ascii=False, indent=1))

    # ---- stats ----
    total = len(rows)
    conv = sum(1 for r in rows if r["convertido"] or r["id_externo"])
    by_month = {}
    for r in rows:
        m = (r["fecha_viab"] or "")[:7] or "sin-fecha"
        s = by_month.setdefault(m, [0, 0])
        s[0] += 1
        if r["convertido"] or r["id_externo"]:
            s[1] += 1
    print(f"Viabilidades parseadas: {total} | con doctor matcheado: {matched}")
    print(f"Convertidas (fecha o ID): {conv} ({round(conv/total*100)}%)")
    for m in sorted(by_month):
        t, c = by_month[m]
        print(f"  {m}: {t} enviadas, {c} convertidas")


if __name__ == "__main__":
    main()
