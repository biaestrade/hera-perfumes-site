"""Gera as imagens da prévia do link (WhatsApp) de cada perfume: assets/compartilhar/<id>.jpg (1200x630).
Rodar de novo sempre que entrar perfume novo no produtos.json (precisa de Python, Pillow e Playwright):
    pip install pillow playwright && python -m playwright install chromium
    python ferramentas/gerar-imagens-compartilhar.py
"""
import re, json, base64, asyncio, pathlib
from PIL import Image
from playwright.async_api import async_playwright

R = pathlib.Path(__file__).resolve().parent.parent
h = (R / 'index.html').read_text(encoding='utf-8')
logo = re.search(r'<link rel="icon" href="(data:image/svg\+xml;base64,[^"]+)"', h).group(1)
fotos = dict(re.findall(r'"([^"]+)"\s*:\s*"(assets/produtos/[^"]+)"', re.search(r'var FOTOS\s*=\s*\{(.*?)\};', h, re.S).group(1)))
prods = json.loads((R / 'produtos.json').read_text(encoding='utf-8'))
(R / 'assets/compartilhar').mkdir(exist_ok=True)

def doc(p):
    f = fotos.get(p['id'])
    img = 'data:image/webp;base64,' + base64.b64encode((R / f).read_bytes()).decode() if f else ''
    sub = ' · '.join(x for x in [p.get('conc', ''), p.get('vol', '')] if x)
    return f'''<html><head><link href="https://fonts.googleapis.com/css2?family=Marcellus&family=Montserrat:wght@400;500;600&display=swap" rel="stylesheet">
<style>body{{margin:0}}.c{{width:1200px;height:630px;display:flex;background:#FBF7F2}}
.l{{width:560px;background:#3B0B18;color:#FBF7F2;padding:64px 60px;box-sizing:border-box;display:flex;flex-direction:column;justify-content:space-between}}
.m{{display:flex;align-items:center;gap:16px}}.m img{{width:52px}}.m b{{font:400 34px Marcellus;letter-spacing:5px;display:block;line-height:1}}.m small{{font:500 12px Montserrat;letter-spacing:8px;color:#F3DF86}}
.br{{font:600 20px Montserrat;letter-spacing:5px;text-transform:uppercase;color:#EA99A2;margin-bottom:14px}}.n{{font:400 54px/1.08 Marcellus}}.s{{font:400 24px Montserrat;color:#F3DF86;margin-top:18px}}
.f{{font:500 18px Montserrat;color:#d8c6ca;letter-spacing:1px}}
.r{{flex:1;display:flex;align-items:center;justify-content:center}}.r img{{max-width:520px;max-height:540px}}</style></head>
<body><div class="c"><div class="l"><div class="m"><img src="{logo}"><div><b>HERA</b><small>PERFUMES</small></div></div>
<div><div class="br">{p['marca']}</div><div class="n">{p['nome']}</div><div class="s">{sub}</div></div><div class="f">Original · Fragrâncias icônicas</div></div>
<div class="r">{f'<img src="{img}">' if img else ''}</div></div></body></html>'''

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(); pg = await b.new_page(viewport={'width': 1200, 'height': 630})
        tmp = R / 'ferramentas' / '_tmp.html'
        for i, p in enumerate(prods):
            tmp.write_text(doc(p), encoding='utf-8'); await pg.goto(tmp.as_uri()); await pg.wait_for_timeout(900 if i == 0 else 250)
            await pg.screenshot(path=str(R / 'ferramentas' / '_tmp.png'))
            Image.open(R / 'ferramentas' / '_tmp.png').convert('RGB').save(R / f"assets/compartilhar/{p['id']}.jpg", quality=82, optimize=True)
        await b.close(); tmp.unlink(); (R / 'ferramentas' / '_tmp.png').unlink()
    print(len(prods), 'imagens geradas em assets/compartilhar/')

asyncio.run(main())
