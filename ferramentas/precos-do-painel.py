"""Aplica no produtos.json os preços que o Painel da Hera quer no site.

Uso:  python3 ferramentas/precos-do-painel.py painel.json
painel.json = o documento "site/painel" do banco do Painel: {"mapa": {id: {preco, preco_de, estoque}}, "alertas": [{id, nome, motivos}]}
Perfumes com aviso de preço estranho ficam de fora (o Painel mostra o aviso).
"""
import json, sys

def main(caminho):
    painel = json.load(open(caminho, encoding='utf-8'))
    mapa = painel.get('mapa') or {}
    bloqueados = {a.get('id') for a in (painel.get('alertas') or [])}
    lista = json.load(open('produtos.json', encoding='utf-8'))
    mudou = []
    for p in lista:
        chave = p.get('painel_id') or p.get('id')  # painel_id: quando o código no Painel é diferente do código no site
        v = mapa.get(chave)
        if not v or chave in bloqueados or p['id'] in bloqueados:
            continue
        preco = round(float(v.get('preco') or 0), 2)
        if preco <= 0:
            continue
        de = v.get('preco_de')
        de = round(float(de), 2) if de and float(de) > preco else None
        antes = (p.get('preco'), p.get('preco_de'), p.get('estoque'))
        p['preco'] = preco
        if de: p['preco_de'] = de
        else: p.pop('preco_de', None)
        est = v.get('estoque')
        if isinstance(est, (int, float)) and est >= 0: p['estoque'] = int(est)
        if antes != (p.get('preco'), p.get('preco_de'), p.get('estoque')):
            mudou.append(f"{p['id']}: {antes} -> {(p.get('preco'), p.get('preco_de'), p.get('estoque'))}")
    if mudou:
        json.dump(lista, open('produtos.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        open('produtos.json', 'a', encoding='utf-8').write('\n')
    print(f"{len(mudou)} perfume(s) mudaram; {len(bloqueados)} com aviso ficaram de fora")
    for m in mudou: print(' ', m)

if __name__ == '__main__':
    main(sys.argv[1])
