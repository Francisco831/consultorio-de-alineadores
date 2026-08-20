# Extrae los movimientos de los estados de cuenta BBVA México (Maestra PYME).
#
# No confía en el nombre del archivo: abre TODOS los PDF del árbol contable y se
# queda con los que dicen "Periodo DEL .. AL .." y el número de cuenta de KS.
# (El estado de enero 2026 estaba archivado dentro de la carpeta "Clara".)
#
# Cargo vs abono se decide por la POSICIÓN de la columna, no por el código de
# operación: el x1 del importe cae en CARGOS (~408) o en ABONOS (~469).
# Los saldos (~534 y ~602) se ignoran, salvo el de control.
#
#   python3 scripts/extraer/bbva_mx.py <carpeta> <salida.json>

import sys, os, re, json, hashlib
import pdfplumber

MESES = {'ENE':1,'FEB':2,'MAR':3,'ABR':4,'MAY':5,'JUN':6,
         'JUL':7,'AGO':8,'SEP':9,'OCT':10,'NOV':11,'DIC':12}
RE_PERIODO = re.compile(r'Periodo\s+DEL\s+(\d{2})/(\d{2})/(\d{4})\s+AL\s+(\d{2})/(\d{2})/(\d{4})')
RE_CUENTA  = re.compile(r'No\.\s*de\s*Cuenta\s+(\d+)')
RE_FECHA   = re.compile(r'^(\d{2})/([A-Z]{3})$')
RE_MONTO   = re.compile(r'^-?[\d,]+\.\d{2}$')
RE_COD     = re.compile(r'^[A-Z]\d{2}$')

# fronteras de columna (x1 del importe); tomadas del header CARGOS/ABONOS
LIM_CARGO, LIM_ABONO, LIM_SALDO_OP = 420, 480, 545

def monto(txt):
    return float(txt.replace(',', ''))

def filas_de_pagina(page):
    """Agrupa las palabras por renglón (tolerancia 2pt) y las ordena por x."""
    filas = {}
    for w in page.extract_words():
        clave = round(w['top'] / 2)
        filas.setdefault(clave, []).append(w)
    return [sorted(ws, key=lambda w: w['x0']) for _, ws in sorted(filas.items())]

def parsear_pdf(ruta):
    with pdfplumber.open(ruta) as pdf:
        texto_todo = "\n".join((p.extract_text() or "") for p in pdf.pages[:3])
        mper = RE_PERIODO.search(texto_todo)
        mcta = RE_CUENTA.search(texto_todo)
        if not mper:
            return None
        d1, m1, a1, d2, m2, a2 = mper.groups()
        desde, hasta = f"{a1}-{m1}-{d1}", f"{a2}-{m2}-{d2}"
        anio = int(a1)

        # totales de control declarados por el propio banco
        ctrl = {}
        t = texto_todo
        for clave, patron in [
            ('abonos',  r'Dep[óo]sitos\s*/\s*Abonos\s*\(\+\)\s+(\d+)\s+([\d,]+\.\d\d)'),
            ('cargos',  r'Retiros\s*/\s*Cargos\s*\(-\)\s+(\d+)\s+([\d,]+\.\d\d)'),
        ]:
            m = re.search(patron, t)
            if m: ctrl[clave] = {'n': int(m.group(1)), 'total': monto(m.group(2))}
        for clave, patron in [
            ('saldo_inicial', r'Saldo de Liquidaci[óo]n Inicial\s+([\d,]+\.\d\d)'),
            ('saldo_final',   r'Saldo Final \(\+\)\s+([\d,]+\.\d\d)'),
        ]:
            m = re.search(patron, t)
            if m: ctrl[clave] = monto(m.group(1))

        movs, actual, corte = [], None, False
        for page in pdf.pages:
            if corte: break
            for ws in filas_de_pagina(page):
                if corte: break
                textos = [w['text'] for w in ws]
                if not textos: continue
                # El bloque "Total de Movimientos / TOTAL IMPORTE CARGOS ..." va
                # pegado al último movimiento: si no se corta acá, ese renglón se
                # come el total del banco y los cargos salen exactamente al doble.
                ini = next((i for i in range(len(textos) - 2)
                            if textos[i] == 'Total' and textos[i+1] == 'de'
                            and textos[i+2].startswith('Movimientos')), None)
                if ini is not None:
                    ws, textos, corte = ws[:ini], textos[:ini], True
                    if not textos:
                        break
                mf = RE_FECHA.match(textos[0])
                if mf and mf.group(2) in MESES:
                    # renglón nuevo: fecha de operación + (a veces) fecha de liquidación
                    dia, mes = int(mf.group(1)), MESES[mf.group(2)]
                    # el estado puede cruzar el fin de año (dic/ene)
                    y = anio if mes >= int(m1) or a1 == a2 else anio + 1
                    actual = {'fecha': f"{y:04d}-{mes:02d}-{dia:02d}",
                              'cod': None, 'descripcion': [], 'cargo': None,
                              'abono': None, 'saldo': None}
                    movs.append(actual)
                    resto = ws[1:]
                elif actual is not None:
                    resto = ws          # renglón de continuación
                else:
                    continue

                for w in resto:
                    tx = w['text']
                    if tx == 'Total': break
                    if RE_FECHA.match(tx): continue
                    if RE_COD.match(tx) and actual['cod'] is None and w['x0'] < 110:
                        actual['cod'] = tx; continue
                    if RE_MONTO.match(tx):
                        x1 = w['x1']
                        if x1 < LIM_CARGO:
                            if actual['cargo'] is None: actual['cargo'] = monto(tx)
                            else: actual['descripcion'].append(tx)
                        elif x1 < LIM_ABONO:
                            if actual['abono'] is None: actual['abono'] = monto(tx)
                            else: actual['descripcion'].append(tx)
                        elif x1 < LIM_SALDO_OP:
                            actual['saldo'] = monto(tx)
                        # la columna de liquidación se descarta
                        continue
                    actual['descripcion'].append(tx)

        # descartar los renglones de encabezado que empiezan con fecha pero no son movimientos
        limpios = []
        for m in movs:
            if m['cargo'] is None and m['abono'] is None: continue
            desc = " ".join(m['descripcion']).strip()
            desc = re.sub(r'\s+', ' ', desc)
            limpios.append({'fecha': m['fecha'], 'cod': m['cod'], 'descripcion': desc,
                            'cargo': m['cargo'], 'abono': m['abono'], 'saldo': m['saldo']})
        return {
            'archivo': os.path.relpath(ruta, RAIZ),
            'sha256': hashlib.sha256(open(ruta, 'rb').read()).hexdigest()[:16],
            'cuenta': mcta.group(1) if mcta else None,
            'desde': desde, 'hasta': hasta,
            'control': ctrl,
            'movimientos': limpios,
        }

RAIZ = sys.argv[1]
salida = sys.argv[2]
desde_anio = sys.argv[3] if len(sys.argv) > 3 else "2026"

estados = []
EXCLUIR = ('Pagos',)   # 977 facturas de proveedor: no son estados de cuenta
for dirpath, dirs, files in os.walk(RAIZ):
    dirs[:] = [d for d in dirs if d not in EXCLUIR]
    for f in sorted(files):
        if not f.lower().endswith('.pdf'): continue
        ruta = os.path.join(dirpath, f)
        try:
            r = parsear_pdf(ruta)
        except Exception as e:
            print(f"  !! {f}: {e}", file=sys.stderr); continue
        if not r: continue
        if not r['desde'].startswith(desde_anio): continue
        estados.append(r)
        c = r['control']
        print(f"  {r['desde']}..{r['hasta']}  cta {r['cuenta']}  {len(r['movimientos'])} movs  "
              f"cargos {c.get('cargos',{}).get('n','?')}  abonos {c.get('abonos',{}).get('n','?')}  ← {f}")

estados.sort(key=lambda r: r['desde'])
json.dump({'fuente': RAIZ, 'estados': estados}, open(salida, 'w'), ensure_ascii=False, indent=0)
print(f"\n{len(estados)} estado(s) → {salida}")
