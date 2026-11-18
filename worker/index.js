/**
 * Hera Perfumes — servidor da loja (Cloudflare Worker)
 *
 * Rotas:
 *   POST /api/cotacao       calcula o total do carrinho (preços oficiais + descontos + cupom)
 *   POST /api/pagar         registra o pedido e cria o pagamento no Mercado Pago (Checkout Pro)
 *   POST /api/mp-webhook    recebe o aviso do Mercado Pago e atualiza o pedido
 *   GET  /api/relatorio.csv planilha de vendas e comissões (pede usuário e senha)
 *   GET  /api/saude         mostra se o servidor está configurado (sem revelar segredos)
 *
 * Segredos (colados no painel do Cloudflare, nunca no código):
 *   MP_ACCESS_TOKEN    Access Token do Mercado Pago (de teste primeiro)
 *   MP_WEBHOOK_SECRET  "Assinatura secreta" das notificações do Mercado Pago
 *   RELATORIO_SENHA    senha para baixar a planilha de vendas
 *
 * Regras ajustáveis ficam em wrangler.toml, na seção [vars].
 * Os cupons ficam na tabela "cupons" do banco D1 (não no código, porque o repositório é público).
 */

const MP_API = 'https://api.mercadopago.com';
const MAX_ITENS = 30;
const MAX_QTD = 10;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      // ambiente de teste: o próprio Worker serve as páginas do site
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response('Não encontrado', { status: 404 });
    }

    const cors = cabecalhosCors(request, env);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: cors ? 204 : 403, headers: cors || {} });
    }

    try {
      switch (`${request.method} ${url.pathname}`) {
        case 'POST /api/cotacao':
          if (!cors) return json({ erro: 'Origem não permitida.' }, 403);
          return json(await cotacao(request, env), 200, cors);
        case 'POST /api/pagar':
          if (!cors) return json({ erro: 'Origem não permitida.' }, 403);
          return json(await pagar(request, env), 200, cors);
        case 'POST /api/mp-webhook':
          return await webhook(request, env, url);
        case 'GET /api/relatorio.csv':
          return await relatorio(request, env, url);
        case 'GET /api/saude':
          return json({
            ok: true,
            modo: env.MODO || 'teste',
            mercado_pago_configurado: !!env.MP_ACCESS_TOKEN,
            assinatura_webhook_configurada: !!env.MP_WEBHOOK_SECRET,
            relatorio_configurado: !!env.RELATORIO_SENHA,
            banco_configurado: !!env.DB,
          }, 200, cors || {});
        default:
          return json({ erro: 'Rota não encontrada.' }, 404, cors || {});
      }
    } catch (e) {
      if (e instanceof ErroCliente) return json({ erro: e.message }, 400, cors || {});
      console.error('erro inesperado', e && e.stack || e);
      return json({ erro: 'Não foi possível concluir agora. Tente de novo em instantes.' }, 500, cors || {});
    }
  },
};

class ErroCliente extends Error {}

/* ------------------------------------------------------------------ regras */

function regras(env) {
  const num = (v, padrao) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : padrao;
  };
  return {
    descontoBasePct: num(env.DESCONTO_BASE_PCT, 5),
    // "sim": os 5% também valem pagando online; "nao": só pelo WhatsApp
    descontoBaseNoOnline: String(env.DESCONTO_BASE_NO_ONLINE || 'sim').toLowerCase() !== 'nao',
    // "maior": vale o maior desconto entre os 5% e o cupom; "somar": soma os dois
    combinar: String(env.COMBINAR_DESCONTOS || 'maior').toLowerCase() === 'somar' ? 'somar' : 'maior',
    freteCentavos: Math.max(0, Math.round(num(env.FRETE_CENTAVOS, 0))),
    descontoMaxPct: 90,
  };
}

/* ---------------------------------------------------------------- produtos */

let cacheProdutos = null; // { quando, mapa }

async function produtosOficiais(env) {
  if (cacheProdutos && Date.now() - cacheProdutos.quando < 60_000) return cacheProdutos.mapa;
  let resp;
  if (env.PRODUTOS_URL) {
    resp = await fetch(env.PRODUTOS_URL, { cf: { cacheTtl: 60 } });
  } else if (env.ASSETS) {
    resp = await env.ASSETS.fetch(new Request('https://assets.local/produtos.json'));
  } else {
    throw new Error('Defina PRODUTOS_URL no wrangler.toml');
  }
  if (!resp.ok) throw new Error(`não consegui ler produtos.json (${resp.status})`);
  const lista = await resp.json();
  const mapa = new Map();
  for (const p of lista) {
    const preco = Math.round(Number(p.preco) * 100);
    if (!p.id || !Number.isInteger(preco) || preco <= 0) continue;
    mapa.set(String(p.id), {
      id: String(p.id),
      titulo: [p.marca, p.nome, p.conc, p.vol].filter(Boolean).join(' '),
      precoCentavos: preco,
      ativo: p.ativo !== false,
      estoque: Number.isInteger(p.estoque) ? p.estoque : null, // controle de estoque: preparado, ainda não usado
    });
  }
  cacheProdutos = { quando: Date.now(), mapa };
  return mapa;
}

/* ------------------------------------------------------------------ cupons */

function normalizaCupom(c) {
  return String(c || '').trim().toUpperCase().replace(/\s+/g, '').slice(0, 30);
}

async function buscaCupom(env, codigo) {
  if (!codigo || !env.DB) return null;
  const c = await env.DB.prepare(
    'SELECT codigo, representante, desconto_pct, comissao_pct FROM cupons WHERE codigo = ?1 AND ativo = 1'
  ).bind(codigo).first();
  return c || null;
}

/* ----------------------------------------------------------------- cálculo */

function lerItens(corpo) {
  const itens = Array.isArray(corpo && corpo.itens) ? corpo.itens : null;
  if (!itens || !itens.length) throw new ErroCliente('O carrinho está vazio.');
  if (itens.length > MAX_ITENS) throw new ErroCliente('Carrinho com itens demais.');
  const junto = new Map();
  for (const it of itens) {
    const id = String(it && it.id || '').slice(0, 100);
    const q = Number(it && it.quantidade);
    if (!id || !Number.isInteger(q) || q < 1 || q > MAX_QTD) throw new ErroCliente('Quantidade inválida no carrinho.');
    junto.set(id, Math.min(MAX_QTD, (junto.get(id) || 0) + q));
  }
  return [...junto].map(([id, quantidade]) => ({ id, quantidade }));
}

async function calcular(env, corpo) {
  const r = regras(env);
  const itens = lerItens(corpo);
  const produtos = await produtosOficiais(env);
  const codigo = normalizaCupom(corpo && corpo.cupom);
  const cupom = await buscaCupom(env, codigo);

  const pctBase = r.descontoBaseNoOnline ? r.descontoBasePct : 0;
  const pctCupom = cupom ? Number(cupom.desconto_pct) || 0 : 0;
  let pct = r.combinar === 'somar' ? pctBase + pctCupom : Math.max(pctBase, pctCupom);
  pct = Math.min(Math.max(pct, 0), r.descontoMaxPct);

  const linhas = itens.map(({ id, quantidade }) => {
    const p = produtos.get(id);
    if (!p || !p.ativo) throw new ErroCliente('Um dos perfumes do carrinho não está mais disponível. Atualize a página.');
    // desconto aplicado por unidade, em centavos: o total do Mercado Pago bate exatamente com o nosso
    const unitario = Math.round(p.precoCentavos * (100 - pct) / 100);
    return { id, titulo: p.titulo, quantidade, precoCentavos: p.precoCentavos, unitarioCentavos: unitario, totalCentavos: unitario * quantidade };
  });

  const subtotal = linhas.reduce((s, l) => s + l.precoCentavos * l.quantidade, 0);
  const totalProdutos = linhas.reduce((s, l) => s + l.totalCentavos, 0);
  const desconto = subtotal - totalProdutos;
  const frete = r.freteCentavos;

  let nomeDesconto = '';
  if (pct > 0) {
    if (r.combinar === 'somar' && pctBase && pctCupom) nomeDesconto = `Desconto do site (${pctBase}%) + código ${cupom.codigo} (${pctCupom}%)`;
    else if (cupom && pctCupom >= pctBase) nomeDesconto = `Código ${cupom.codigo} (${pctCupom}%)`;
    else nomeDesconto = `Desconto do site (${pctBase}%)`;
  }

  let mensagemCupom = '';
  if (codigo && !cupom) mensagemCupom = 'Código não encontrado ou inativo.';
  else if (cupom && r.combinar === 'maior' && pctCupom < pctBase) mensagemCupom = `Código aplicado. O desconto do site (${pctBase}%) é maior e foi mantido.`;
  else if (cupom) mensagemCupom = pctCupom > 0 ? `Código aplicado: ${pctCupom}% de desconto.` : 'Código aplicado.';

  const comissaoPct = cupom ? Number(cupom.comissao_pct) || 0 : 0;
  return {
    linhas, subtotal, desconto, frete, totalProdutos,
    total: totalProdutos + frete,
    pct, nomeDesconto, mensagemCupom, codigo, cupom,
    comissaoPct,
    // comissão calculada sobre o valor dos produtos já com desconto (sem frete)
    comissaoCentavos: Math.round(totalProdutos * comissaoPct / 100),
  };
}

async function lerCorpo(request) {
  const texto = await request.text();
  if (texto.length > 20_000) throw new ErroCliente('Pedido grande demais.');
  try { return JSON.parse(texto || '{}'); } catch { throw new ErroCliente('Pedido inválido.'); }
}

/* ----------------------------------------------------------------- cotação */

async function cotacao(request, env) {
  const c = await calcular(env, await lerCorpo(request));
  return {
    subtotal: c.subtotal,
    desconto: c.desconto,
    frete: c.frete,
    total: c.total,
    descontos: c.desconto > 0 ? [{ nome: c.nomeDesconto, valor: c.desconto }] : [],
    cupom: c.cupom ? c.cupom.codigo : null,
    cupom_valido: !!c.cupom,
    mensagem_cupom: c.mensagemCupom,
    itens: c.linhas.map(l => ({ id: l.id, quantidade: l.quantidade, unitario: l.unitarioCentavos, total: l.totalCentavos })),
  };
}

/* ----------------------------------------------------------------- pagar */

async function pagar(request, env) {
  if (!env.MP_ACCESS_TOKEN) throw new Error('MP_ACCESS_TOKEN não configurado');
  if (!env.DB) throw new Error('banco D1 não configurado');
  const corpo = await lerCorpo(request);
  const c = await calcular(env, corpo);
  if (corpo.cupom && !c.cupom) throw new ErroCliente('Esse código de representante não é válido. Corrija ou apague o código.');

  const pedidoId = 'HERA-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + crypto.randomUUID().slice(0, 8).toUpperCase();
  const agora = new Date().toISOString();
  const modo = env.MODO || 'teste';

  await env.DB.prepare(
    `INSERT INTO pedidos (id, criado_em, modo, itens, subtotal_centavos, desconto_centavos, frete_centavos, total_centavos,
       cupom, representante, comissao_pct, comissao_centavos, status, atualizado_em)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'criado', ?2)`
  ).bind(
    pedidoId, agora, modo,
    JSON.stringify(c.linhas.map(l => ({ id: l.id, titulo: l.titulo, quantidade: l.quantidade, unitario_centavos: l.unitarioCentavos }))),
    c.subtotal, c.desconto, c.frete, c.total,
    c.cupom ? c.cupom.codigo : null, c.cupom ? c.cupom.representante : null,
    c.comissaoPct, c.comissaoCentavos
  ).run();

  const origemApi = new URL(request.url).origin;
  const site = (env.SITE_URL || origemApi).replace(/\/+$/, '');
  const itensMp = c.linhas.map(l => ({
    id: l.id, title: l.titulo.slice(0, 250), quantity: l.quantidade,
    unit_price: l.unitarioCentavos / 100, currency_id: 'BRL',
  }));
  if (c.frete > 0) itensMp.push({ id: 'frete', title: 'Frete', quantity: 1, unit_price: c.frete / 100, currency_id: 'BRL' });

  const preferencia = {
    items: itensMp,
    external_reference: pedidoId,
    back_urls: {
      success: `${site}/?pagamento=aprovado`,
      pending: `${site}/?pagamento=pendente`,
      failure: `${site}/?pagamento=recusado`,
    },
    auto_return: 'approved',
    notification_url: `${origemApi}/api/mp-webhook?source_news=webhooks`,
    statement_descriptor: 'HERA PERFUMES',
    metadata: { pedido_id: pedidoId, cupom: c.cupom ? c.cupom.codigo : null },
  };

  const resp = await fetch(`${MP_API}/checkout/preferences`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.MP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': pedidoId,
    },
    body: JSON.stringify(preferencia),
  });
  const mp = await resp.json().catch(() => ({}));
  if (!resp.ok || !mp.init_point) {
    console.error('Mercado Pago recusou a preferência', resp.status, JSON.stringify(mp).slice(0, 500));
    await env.DB.prepare("UPDATE pedidos SET status = 'erro_ao_criar', atualizado_em = ?2 WHERE id = ?1").bind(pedidoId, new Date().toISOString()).run();
    throw new Error('falha ao criar preferência');
  }
  return { url: mp.init_point, pedido: pedidoId };
}

/* --------------------------------------------------------------- webhook */

const STATUS = {
  approved: 'aprovado',
  authorized: 'pendente', pending: 'pendente', in_process: 'pendente', in_mediation: 'em_disputa',
  rejected: 'recusado', cancelled: 'recusado',
  refunded: 'estornado', charged_back: 'estornado',
};

async function webhook(request, env, url) {
  const corpo = await request.json().catch(() => ({}));
  const tipo = corpo.type || corpo.topic || url.searchParams.get('type') || url.searchParams.get('topic');
  const dataId = String(url.searchParams.get('data.id') || (corpo.data && corpo.data.id) || url.searchParams.get('id') || '');
  if (tipo !== 'payment' || !dataId) return new Response('ignorado', { status: 200 });

  if (env.MP_WEBHOOK_SECRET) {
    const ok = await assinaturaValida(request, env.MP_WEBHOOK_SECRET, dataId);
    if (!ok) return new Response('assinatura inválida', { status: 401 });
  }
  if (!env.MP_ACCESS_TOKEN || !env.DB) return new Response('não configurado', { status: 503 });

  // nunca confiar só no aviso: consulta o pagamento direto no Mercado Pago
  const resp = await fetch(`${MP_API}/v1/payments/${encodeURIComponent(dataId)}`, {
    headers: { Authorization: `Bearer ${env.MP_ACCESS_TOKEN}` },
  });
  if (resp.status === 404) return new Response('pagamento não encontrado', { status: 200 });
  if (!resp.ok) return new Response('erro ao consultar', { status: 502 }); // o Mercado Pago tenta de novo depois
  const pg = await resp.json();

  const pedidoId = pg.external_reference;
  if (!pedidoId) return new Response('sem pedido', { status: 200 });
  const pedido = await env.DB.prepare('SELECT id, total_centavos, status, pagamento_id FROM pedidos WHERE id = ?1').bind(pedidoId).first();
  if (!pedido) return new Response('pedido desconhecido', { status: 200 });

  let status = STATUS[pg.status] || String(pg.status || 'desconhecido');
  const valorPago = Math.round(Number(pg.transaction_amount || 0) * 100);
  if (status === 'aprovado' && valorPago !== pedido.total_centavos) status = 'aprovado_valor_divergente';

  // um pedido aprovado não volta para "recusado" por causa de uma tentativa antiga;
  // só muda se for o mesmo pagamento (ex.: estorno)
  await env.DB.prepare(
    `UPDATE pedidos SET status = ?2, pagamento_id = ?3, valor_pago_centavos = ?4,
       pago_em = CASE WHEN ?2 LIKE 'aprovado%' THEN COALESCE(?5, pago_em) ELSE pago_em END,
       atualizado_em = ?6
     WHERE id = ?1 AND (status NOT LIKE 'aprovado%' OR pagamento_id = ?3)`
  ).bind(pedidoId, status, String(pg.id), valorPago, pg.date_approved || null, new Date().toISOString()).run();

  return new Response('ok', { status: 200 });
}

async function assinaturaValida(request, segredo, dataId) {
  const assinatura = request.headers.get('x-signature') || '';
  const requestId = request.headers.get('x-request-id') || '';
  const partes = Object.fromEntries(assinatura.split(',').map(p => p.trim().split('=').map(s => s.trim())));
  if (!partes.ts || !partes.v1) return false;
  const id = /^[a-z0-9]+$/i.test(dataId) ? dataId.toLowerCase() : dataId;
  let manifesto = `id:${id};`;
  if (requestId) manifesto += `request-id:${requestId};`;
  manifesto += `ts:${partes.ts};`;
  const chave = await crypto.subtle.importKey('raw', new TextEncoder().encode(segredo), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', chave, new TextEncoder().encode(manifesto));
  const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
  return igualSeguro(hex, partes.v1.toLowerCase());
}

function igualSeguro(a, b) {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  return crypto.subtle.timingSafeEqual(ea, eb);
}

/* -------------------------------------------------------------- relatório */

async function relatorio(request, env, url) {
  if (!env.RELATORIO_SENHA) return new Response('Defina o segredo RELATORIO_SENHA no Cloudflare.', { status: 503 });
  const auth = request.headers.get('Authorization') || '';
  let senha = '';
  if (auth.startsWith('Basic ')) {
    try { senha = atob(auth.slice(6)).split(':').slice(1).join(':'); } catch { senha = ''; }
  }
  if (!senha || !igualSeguro(senha, env.RELATORIO_SENHA)) {
    return new Response('Senha necessária', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Relatorio Hera", charset="UTF-8"' } });
  }

  const todos = url.searchParams.get('todos') === '1';
  const { results } = await env.DB.prepare(
    `SELECT * FROM pedidos ${todos ? '' : "WHERE status LIKE 'aprovado%'"} ORDER BY criado_em DESC`
  ).all();

  const reais = c => (c == null ? '' : (c / 100).toFixed(2).replace('.', ','));
  const celula = v => {
    let s = String(v == null ? '' : v);
    if (/^[=+\-@]/.test(s)) s = "'" + s; // evita fórmulas ao abrir no Excel
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const linhas = [[
    'Data do pedido', 'Pedido', 'Situação', 'Pago em', 'Pagamento MP', 'Modo', 'Itens',
    'Subtotal (R$)', 'Desconto (R$)', 'Frete (R$)', 'Total (R$)', 'Valor pago (R$)',
    'Código', 'Representante', 'Comissão (%)', 'Comissão (R$)',
  ]];
  for (const p of results) {
    let itens = '';
    try { itens = JSON.parse(p.itens).map(i => `${i.quantidade}x ${i.titulo}`).join(' | '); } catch { itens = p.itens; }
    linhas.push([
      p.criado_em, p.id, p.status, p.pago_em || '', p.pagamento_id || '', p.modo, itens,
      reais(p.subtotal_centavos), reais(p.desconto_centavos), reais(p.frete_centavos), reais(p.total_centavos), reais(p.valor_pago_centavos),
      p.cupom || '', p.representante || '', p.comissao_pct == null ? '' : String(p.comissao_pct).replace('.', ','), reais(p.comissao_centavos),
    ]);
  }
  const csv = '﻿' + linhas.map(l => l.map(celula).join(';')).join('\r\n') + '\r\n';
  const nome = `vendas-hera-${new Date().toISOString().slice(0, 10)}${todos ? '-todos' : ''}.csv`;
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${nome}"`,
      'Cache-Control': 'no-store',
    },
  });
}

/* ------------------------------------------------------------------ util */

function cabecalhosCors(request, env) {
  const origem = request.headers.get('Origin');
  const propria = new URL(request.url).origin;
  if (!origem || origem === propria) return { Vary: 'Origin' }; // mesmo endereço (ambiente de teste)
  const permitidas = String(env.ORIGENS_PERMITIDAS || '').split(',').map(s => s.trim()).filter(Boolean);
  const local = (env.MODO || 'teste') === 'teste' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origem);
  if (!permitidas.includes(origem) && !local) return null;
  return {
    'Access-Control-Allow-Origin': origem,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(dados, status = 200, extra = {}) {
  return new Response(JSON.stringify(dados), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}
