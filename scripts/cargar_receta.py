#!/usr/bin/env python3
"""
Carga una receta y su escandallo usando los ENDPOINTS del backend
(no toca la BD directo). Requiere el server corriendo (npm run dev).

Para la siguiente receta: edita el diccionario `receta` y vuelve a correr.
"""
import json, urllib.request, urllib.error

BASE = "http://localhost:4000/api"
EMPRESA_ID = 4

# ------- EDITA AQUÍ PARA CADA RECETA -------
receta = {
    "nombre": "Turco Arrachera",
    "categoria": "Plato fuerte",
    "precio_venta": 155,
    "activo": True,
    # (nombre exacto del insumo, cantidad en la unidad de ese insumo)
    "ingredientes": [
        ("Pan Turco", 1),
        ("Arrachera", 100),
        ("Lechuga Baby", 20),
        ("Queso Americano", 1),
        ("Jitomate Bola", 20),
        ("Tocino", 20),
    ],
    # Opcional: nombre tal como aparece en el reporte de Toteat, para el mapeo
    "nombre_pos": "Pan Turco de Arrachera",
}
# -------------------------------------------

def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:    return e.code, json.loads(e.read().decode() or "{}")
        except: return e.code, {}

# 1. índice nombre -> producto_id
st, productos = api("GET", f"/productos/{EMPRESA_ID}")
if st != 200 or not isinstance(productos, list):
    print("No pude leer productos:", st, productos); raise SystemExit(1)
idx = {p["producto"]: p["id"] for p in productos}

# 2. crear la receta
st, r = api("POST", f"/recetas/{EMPRESA_ID}", {
    "nombre": receta["nombre"], "categoria": receta["categoria"],
    "precio_venta": receta["precio_venta"], "costo_total": 0, "activo": receta["activo"],
})
if st != 201:
    print("Error creando receta:", st, r); raise SystemExit(1)
rid = r["id"]
print(f"Receta creada  id={rid}  {receta['nombre']}")

# 3. escandallo
faltantes = []
for nombre, cant in receta["ingredientes"]:
    pid = idx.get(nombre)
    if not pid:
        faltantes.append(nombre); continue
    st, d = api("POST", f"/recetas/{rid}/detalle", {"producto_id": pid, "cantidad": cant})
    print(f"  {'OK ' if st==201 else 'ERR'} {nombre} x{cant}" + ("" if st==201 else f"  -> {d}"))
if faltantes:
    print("  NO ENCONTRADOS (revisa el nombre exacto en productos):", faltantes)

# 4. resultado del costeo (solo insumos)
st, rr = api("GET", f"/recetas/{EMPRESA_ID}/{rid}")
print(f"costo_total (solo insumos): {rr.get('costo_total')}  |  margen: {rr.get('margen')}")
print(f"\nReceta id = {rid}  (para mapearla en pos_map como '{receta.get('nombre_pos','')}')")
