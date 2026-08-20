# Extrae los movimientos de Mercado Pago México 2026. Dos formatos:
#
#   · PDF "ESTADO DE SALDOS Y MOVIMIENTOS" (ene, feb, mar, abr, jun) — trae
#     beneficiario, controles de Entradas/Salidas y saldos inicial/final.
#   · CSV export (ene, may, jul) — sin beneficiario, solo SOURCE_ID y montos.
#
# Enero existe en ambos: gana el PDF (tiene los nombres). La cadena de saldos
# entre meses es el gate global: el inicial de cada mes debe ser el final del
# anterior, si no falta un archivo o un mes está incompleto.
#
#   python3 scripts/extraer/mp_mx.py <carpeta contable> <salida.json>

import sys, os, re, json, csv, hashlib
import pdfplumber

RE_PERIODO = re.compile(r'Periodo:\s*Del\s+\d+\s+al\s+\d+\s+de\s+(\w+)\s+de\s+(\d{4})')
RE_CTRL = {
    'entradas':      re.compile(r'Entradas:\s*\$\s*(-?[\d,]+\.\d\d)'),
    'salidas':       re.compile(r'Salidas:\s*\$\s*(-?[\d,]+\.\d\d)'),
    'saldo_inicial': re.compile(r'Saldo inicial:\s*\$\s*(-?[\d,]+\.\d\d)'),
    'saldo_final':   re.compile(r'Saldo final:\s*\$\s*(-?[\d,]+\.\d\d)'),
}
MESES = {'enero':1,'febrero':2,'marzo':3,'abril':4,'mayo':5,'junio':6,
         'julio':7,'agosto':8,'septiembre':9,'octubre':10,'noviembre':11,'diciembre':12}
RE_FECHA = re.compile(r'^(\d{2})-(\d{2})-(\d{4})$')
RE_MONTO = re.compile(r'^\$?-?[\d,]+\.\d{2}$')
RE_OPID  = re.compile(r'^\d{9,}$')

X_VALOR = 350   # x1 < 350 → columna Valor; si no → columna Saldo

def monto(t): return float(t.replace('$','').replace(',',''))

def filas(page):
    fs = {}
    for w in page.extract_words():
        fs.setdefault(round(w['top'] / 3), []).append(w)
    return [sorted(v, key=lambda w: w['x0']) for _, v in sorted(fs.items())]

def parsear_pdf(ruta):
    with pdfplumber.open(ruta) as pdf:
        cab = pdf.pages[0].extract_text() or ''
        mper = RE_PERIODO.search(cab)
        if not mper or 'MOVIMIENTOS' not in cab: return None
        mes, anio = MESES.get(mper.group(1).lower()), int(mper.group(2))
        if not mes: return None
        ctrl = {k: monto(rx.search(cab).group(1)) for k, rx in RE_CTRL.items() if rx.search(cab)}

        # MP centra la celda de descripción VERTICALMENTE: en una fila de dos
        # renglones, el primero queda ARRIBA de la línea de la fecha y el
        # segundo abajo. Leer en orden mezclaba las descripciones entre filas
        # vecinas. Por eso: primero se anclan las filas con fecha, y cada
        # renglón suelto se asigna al ancla más cercana en vertical.
        movs = []
        for page in pdf.pages:
            anclas, sueltas = [], []
            for ws in filas(page):
                txts = [w['text'] for w in ws]
                if not txts: continue
                if any('Fecha de generac' in t or 'PAGINA' in t.upper() for t in txts): continue
                top = ws[0]['top']
                mf = RE_FECHA.match(txts[0])
                if mf:
                    a = {'fecha': f"{mf.group(3)}-{mf.group(2)}-{mf.group(1)}",
                         'descripcion': [], 'op_id': None, 'valor': None,
                         'saldo': None, 'top': top}
                    for w in ws[1:]:
                        t = w['text']
                        if RE_OPID.match(t) and a['op_id'] is None:
                            a['op_id'] = t; continue
                        if RE_MONTO.match(t) and t != '$':
                            if w['x1'] < X_VALOR and a['valor'] is None: a['valor'] = monto(t)
                            elif a['valor'] is not None: a['saldo'] = monto(t)
                            continue
                        if t != '$': a['descripcion'].append((top, t))
                    anclas.append(a)
                else:
                    # renglón sin fecha: texto de descripción (o ruido del pie)
                    texto = ' '.join(t for t in txts if t != '$')
                    if re.search(r'ID de la|Descripción Valor|Si tienes dudas|Este documento|ESTADO DE SALDOS', texto):
                        continue
                    sueltas.append((top, texto))
            for top, texto in sueltas:
                if not anclas: continue
                cerca = min(anclas, key=lambda a: abs(a['top'] - top))
                if abs(cerca['top'] - top) <= 14:      # una línea de distancia
                    cerca['descripcion'].append((top, texto))
            for a in anclas:
                a['descripcion'].sort(key=lambda x: x[0])
                a['descripcion'] = [t for _, t in a['descripcion']]
            movs.extend(anclas)

        limpios = []
        for m in movs:
            if m['valor'] is None: continue
            d = re.sub(r'\s+', ' ', ' '.join(m['descripcion'])).strip()
            # el pie del PDF a veces queda pegado a la última fila
            d = re.split(r'Si tienes dudas|Este documento', d)[0].strip()
            limpios.append({'fecha': m['fecha'], 'descripcion': d,
                            'op_id': m['op_id'], 'valor': m['valor']})
        return {'formato': 'pdf', 'periodo': f"{anio:04d}-{mes:02d}", 'control': ctrl,
                'movimientos': limpios}

def parsear_csv(ruta):
    with open(ruta, encoding='utf-8-sig') as f:
        rd = csv.DictReader(f, delimiter=';')
        rows = list(rd)
    movs = []
    for r in rows:
        v = float(r['REAL_AMOUNT'])
        fecha = r['TRANSACTION_DATE'][:10]
        movs.append({'fecha': fecha,
                     'descripcion': r['TRANSACTION_TYPE'],
                     'op_id': r['SOURCE_ID'], 'valor': v})
    if not movs: return None
    per = sorted(m['fecha'] for m in movs)[len(movs)//2][:7]
    return {'formato': 'csv', 'periodo': per, 'control': {}, 'movimientos': movs}

RAIZ, SALIDA = sys.argv[1], sys.argv[2]
CANDIDATOS = [
    'Estados de cuenta Clara/2026/Estado de cuenta mp enero 2026.pdf',
    'Estados de cuenta BBVA/2026/Febrero 26 Meli.pdf',
    'Estados de cuenta BBVA/2026/account_statement_generic-ee3b8bc0-eb0e-46df-afad-7247abba1133.pdf',
    'Estados de cuenta BBVA/2026/Abril 26 Meli.pdf',
    'Estados de Cuenta Mercado pago/2026/Mercado pago mayo 26.csv',
    'Estados de cuenta BBVA/2026/junio 26 mercado pago.pdf',
    'Estados de cuenta BBVA/2026/julio 26 mercado pago.csv',
]
porMes = {}
for rel in CANDIDATOS:
    ruta = os.path.join(RAIZ, rel)
    r = parsear_csv(ruta) if ruta.endswith('.csv') else parsear_pdf(ruta)
    if not r:
        print(f"  !! {rel}: no parsea", file=sys.stderr); continue
    r['archivo'] = rel
    r['sha256'] = hashlib.sha256(open(ruta,'rb').read()).hexdigest()[:16]
    # un PDF con controles pisa a un CSV del mismo mes
    if r['periodo'] in porMes and porMes[r['periodo']]['formato'] == 'pdf': continue
    porMes[r['periodo']] = r

estados = [porMes[k] for k in sorted(porMes)]
for e in estados:
    ent = sum(m['valor'] for m in e['movimientos'] if m['valor'] > 0)
    sal = sum(m['valor'] for m in e['movimientos'] if m['valor'] < 0)
    c = e['control']
    okE = 'OK' if 'entradas' in c and abs(ent - c['entradas']) < 0.01 else ('≠≠' if c else '--')
    okS = 'OK' if 'salidas' in c and abs(sal - c['salidas']) < 0.01 else ('≠≠' if c else '--')
    print(f"  {e['periodo']} [{e['formato']}] {len(e['movimientos']):>3} movs  "
          f"entradas {ent:>12,.2f} {okE}  salidas {sal:>13,.2f} {okS}")

# gate global: cadena de saldos entre PDFs consecutivos
for a, b in zip(estados, estados[1:]):
    if 'saldo_final' in a['control'] and 'saldo_inicial' in b['control']:
        d = abs(a['control']['saldo_final'] - b['control']['saldo_inicial'])
        print(f"  cadena {a['periodo']}→{b['periodo']}: {'OK' if d < 0.01 else f'ROTA ({d:.2f})'}")

json.dump({'fuente': RAIZ, 'estados': estados}, open(SALIDA, 'w'), ensure_ascii=False, indent=0)
print(f"\n{len(estados)} meses → {SALIDA}")
