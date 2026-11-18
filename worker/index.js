/**
 * Hera Perfumes — servidor da loja (Cloudflare Worker)
 *
 * Rotas:
 *   POST /api/cotacao       calcula o total do carrinho (preços oficiais + descontos + cupom)
 *   POST /api/pagar         registra o pedido e cria o pagamento no Mercado Pago (Checkout Pro)
 *   POST /api/mp-webhook    recebe o aviso do Mercado Pago e atualiza o pedido
 *   GET  /api/relatorio.csv planilha de vendas e comissões (pede usuário e senha)
 *   POST /api/newsletter    guarda o e-mail de quem quer receber promoções
 *   GET  /api/newsletter.csv planilha de cadastros da newsletter (mesma senha da planilha de vendas)
 *   POST /api/entrar        envia o link de entrada para o e-mail da cliente (sem senha)
 *   POST /api/entrar/confirmar  troca o link por uma sessão (a cliente fica conectada)
 *   GET  /api/minha-conta   pedidos da cliente conectada, com situação da entrega
 *   POST /api/sair          desconecta
 *   GET  /admin             painel da Hera para pôr rastreio e situação da entrega (mesma senha do relatório)
 *   POST /api/admin/pedido  salva o que foi preenchido no painel
 *   GET  /api/saude         mostra se o servidor está configurado (sem revelar segredos)
 *
 * Segredos (colados no painel do Cloudflare, nunca no código):
 *   MP_ACCESS_TOKEN    Access Token do Mercado Pago (de teste primeiro)
 *   MP_WEBHOOK_SECRET  "Assinatura secreta" das notificações do Mercado Pago
 *   RELATORIO_SENHA    senha para baixar a planilha de vendas e abrir o /admin
 *   PLANILHA_URL       endereço do Apps Script da planilha Google de e-mails (newsletter e clientes)
 *   PLANILHA_SEGREDO   senha combinada com o Apps Script (a mesma escrita lá)
 *   RESEND_API_KEY     chave do Resend (resend.com), que manda os e-mails de entrada e de "pedido enviado"
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
    if (url.pathname === '/admin') return await painelAdmin(request, env);
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
        case 'POST /api/newsletter':
          if (!cors) return json({ erro: 'Origem não permitida.' }, 403);
          return json(await newsletter(request, env, ctx), 200, cors);
        case 'GET /api/newsletter.csv':
          return await newsletterCsv(request, env);
        case 'POST /api/entrar':
          if (!cors) return json({ erro: 'Origem não permitida.' }, 403);
          return json(await entrar(request, env), 200, cors);
        case 'POST /api/entrar/confirmar':
          if (!cors) return json({ erro: 'Origem não permitida.' }, 403);
          return json(await confirmarEntrada(request, env, ctx), 200, cors);
        case 'GET /api/minha-conta':
          if (!cors) return json({ erro: 'Origem não permitida.' }, 403);
          return json(await minhaConta(request, env), 200, cors);
        case 'POST /api/sair':
          if (!cors) return json({ erro: 'Origem não permitida.' }, 403);
          return json(await sair(request, env), 200, cors);
        case 'POST /api/admin/pedido':
          return await salvarAdmin(request, env);
        case 'GET /api/relatorio.csv':
          return await relatorio(request, env, url);
        case 'GET /api/saude':
          return json({
            ok: true,
            modo: env.MODO || 'teste',
            mercado_pago_configurado: !!env.MP_ACCESS_TOKEN,
            assinatura_webhook_configurada: !!env.MP_WEBHOOK_SECRET,
            relatorio_configurado: !!env.RELATORIO_SENHA,
            email_configurado: !!env.RESEND_API_KEY,
            planilha_configurada: !!(env.PLANILHA_URL && env.PLANILHA_SEGREDO),
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

  const sessao = await sessaoAtual(request, env);
  let emailCliente = sessao ? sessao.email : emailValido(corpo.email);
  const pedidoId = 'HERA-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + crypto.randomUUID().slice(0, 8).toUpperCase();
  const agora = new Date().toISOString();
  const modo = env.MODO || 'teste';

  await env.DB.prepare(
    `INSERT INTO pedidos (id, criado_em, modo, itens, subtotal_centavos, desconto_centavos, frete_centavos, total_centavos,
       cupom, representante, comissao_pct, comissao_centavos, status, atualizado_em, email_cliente)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'criado', ?2, ?13)`
  ).bind(
    pedidoId, agora, modo,
    JSON.stringify(c.linhas.map(l => ({ id: l.id, titulo: l.titulo, quantidade: l.quantidade, unitario_centavos: l.unitarioCentavos }))),
    c.subtotal, c.desconto, c.frete, c.total,
    c.cupom ? c.cupom.codigo : null, c.cupom ? c.cupom.representante : null,
    c.comissaoPct, c.comissaoCentavos, emailCliente
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
  if (emailCliente) preferencia.payer = { email: emailCliente };

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
  // se o pedido ainda não tem e-mail (cliente não estava conectada), usa o e-mail informado no Mercado Pago
  const emailPagador = emailValido(pg.payer && pg.payer.email);
  if (emailPagador) await env.DB.prepare('UPDATE pedidos SET email_cliente = COALESCE(email_cliente, ?2) WHERE id = ?1').bind(pedidoId, emailPagador).run();

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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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


/* ---------------- Newsletter ---------------- */
async function newsletter(request, env, ctx) {
  let dados = {};
  try { dados = await request.json(); } catch { throw new Error('Dados inválidos.'); }
  const email = String(dados.email || '').trim().toLowerCase();
  const nome = String(dados.nome || '').trim().slice(0, 80);
  if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email) || email.length > 254) throw new Error('Confira o e-mail digitado.');
  if (dados.aceite !== true) throw new Error('Para receber as promoções, aceite a política de privacidade.');
  if (dados.site) return { ok: true }; // campo escondido preenchido = robô; finge que deu certo
  const agora = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO newsletter (email, nome, origem, aceite_em, criado_em, ativo) VALUES (?1, ?2, ?3, ?4, ?4, 1)
     ON CONFLICT(email) DO UPDATE SET nome = COALESCE(NULLIF(?2, ''), nome), ativo = 1, aceite_em = ?4`
  ).bind(email, nome, String(dados.origem || 'site').slice(0, 30), agora).run();
  paraPlanilha(env, ctx, { aba: 'newsletter', email, nome, origem: String(dados.origem || 'site').slice(0, 30) });
  return { ok: true, mensagem: 'Pronto! Você vai receber nossas promoções no seu e-mail.' };
}

async function newsletterCsv(request, env) {
  if (!env.RELATORIO_SENHA) return new Response('Defina o segredo RELATORIO_SENHA no Cloudflare.', { status: 503 });
  const auth = request.headers.get('Authorization') || '';
  let senha = '';
  if (auth.startsWith('Basic ')) {
    try { senha = atob(auth.slice(6)).split(':').slice(1).join(':'); } catch { senha = ''; }
  }
  if (!senha || !igualSeguro(senha, env.RELATORIO_SENHA)) {
    return new Response('Senha necessária', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Newsletter Hera", charset="UTF-8"' } });
  }
  const { results } = await env.DB.prepare('SELECT * FROM newsletter WHERE ativo = 1 ORDER BY criado_em DESC').all();
  const celula = v => {
    let s = String(v == null ? '' : v);
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const linhas = [['E-mail', 'Nome', 'Origem', 'Cadastrado em', 'Aceite da privacidade em']];
  for (const r of results) linhas.push([r.email, r.nome, r.origem, r.criado_em, r.aceite_em]);
  const csv = '\uFEFF' + linhas.map(l => l.map(celula).join(';')).join('\r\n');
  return new Response(csv, { headers: {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="hera-newsletter.csv"',
    'Cache-Control': 'no-store',
  } });
}


/* ---------------- Conta da cliente (login por link no e-mail) ---------------- */
const LINK_MINUTOS = 20;
const SESSAO_DIAS = 30;

function emailValido(v) {
  const e = String(v || '').trim().toLowerCase();
  return e.length <= 254 && /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(e) ? e : null;
}
function tokenNovo() {
  const b = new Uint8Array(32); crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}
async function hashDe(texto) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto));
  return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join('');
}
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function mandarEmail(env, para, assunto, html) {
  if (!env.RESEND_API_KEY) return false;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_REMETENTE || 'Hera Perfumes <contato@heraevodiaperfumes.com.br>', to: [para], subject: assunto, html }),
  });
  if (!r.ok) { console.error('Resend recusou o e-mail', r.status, (await r.text()).slice(0, 300)); throw new Error('falha ao enviar e-mail'); }
  return true;
}
function moldeEmail(titulo, texto, botao, link) {
  return `<div style="background:#FBF7F2;padding:32px 16px;font-family:Montserrat,Arial,sans-serif;color:#3B0B18">
  <div style="max-width:480px;margin:auto;background:#fff;border-radius:16px;padding:32px 28px">
    <p style="letter-spacing:4px;font-size:12px;color:#88072B;margin:0 0 12px">HERA PERFUMES</p>
    <h1 style="font-family:Georgia,serif;font-weight:400;font-size:26px;margin:0 0 12px">${titulo}</h1>
    <p style="line-height:1.6;color:#5a4a4f">${texto}</p>
    ${botao ? `<p style="margin:24px 0"><a href="${link}" style="background:#3B0B18;color:#FBF7F2;text-decoration:none;padding:14px 26px;border-radius:999px;display:inline-block">${botao}</a></p>` : ''}
    <p style="font-size:12px;color:#8a7a7f">Se você não pediu este e-mail, pode ignorar.</p>
  </div></div>`;
}

async function entrar(request, env) {
  const corpo = await lerCorpo(request);
  const email = emailValido(corpo.email);
  if (!email) throw new ErroCliente('Confira o e-mail digitado.');
  const agora = new Date();
  const recentes = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_links WHERE email = ?1 AND criado_em > ?2')
    .bind(email, new Date(agora - 15 * 60e3).toISOString()).first();
  if (recentes && recentes.n >= 3) throw new ErroCliente('Já mandamos alguns links agora há pouco. Confira seu e-mail (e a caixa de spam) ou tente de novo em 15 minutos.');

  const token = tokenNovo();
  await env.DB.prepare('INSERT INTO login_links (hash, email, criado_em, expira_em) VALUES (?1, ?2, ?3, ?4)')
    .bind(await hashDe(token), email, agora.toISOString(), new Date(+agora + LINK_MINUTOS * 60e3).toISOString()).run();

  const site = (env.SITE_URL || new URL(request.url).origin).replace(/\/+$/, '');
  const link = `${site}/#minha-conta/entrar/${token}`;
  const enviado = await mandarEmail(env, email, 'Seu link para entrar na Hera Perfumes',
    moldeEmail('Entrar na sua conta', `Toque no botão para ver seus pedidos e acompanhar a entrega. O link vale por ${LINK_MINUTOS} minutos e só funciona uma vez.`, 'Entrar na minha conta', link));
  if (enviado) return { ok: true, mensagem: `Enviamos um link de entrada para ${email}. Abra seu e-mail neste aparelho.` };
  // sem serviço de e-mail configurado: só no modo de teste o link aparece na tela, para testar
  if ((env.MODO || 'teste') === 'teste') return { ok: true, mensagem: 'Modo de teste: o e-mail ainda não está configurado, então o link aparece aqui.', link_teste: link };
  throw new Error('RESEND_API_KEY não configurado');
}

async function confirmarEntrada(request, env, ctx) {
  const corpo = await lerCorpo(request);
  const token = String(corpo.token || '');
  if (!/^[0-9a-f]{64}$/.test(token)) throw new ErroCliente('Esse link de entrada não é válido. Peça um novo.');
  const agora = new Date().toISOString();
  const link = await env.DB.prepare('SELECT * FROM login_links WHERE hash = ?1').bind(await hashDe(token)).first();
  if (!link || link.usado_em || link.expira_em < agora) throw new ErroCliente('Esse link já foi usado ou expirou. Peça um novo.');
  await env.DB.prepare('UPDATE login_links SET usado_em = ?2 WHERE hash = ?1').bind(link.hash, agora).run();
  const jaCliente = await env.DB.prepare('SELECT 1 FROM clientes WHERE email = ?1').bind(link.email).first();
  if (!jaCliente) paraPlanilha(env, ctx, { aba: 'clientes', email: link.email, origem: 'minha conta' });
  await env.DB.prepare('INSERT INTO clientes (email, criado_em, ultimo_acesso) VALUES (?1, ?2, ?2) ON CONFLICT(email) DO UPDATE SET ultimo_acesso = ?2')
    .bind(link.email, agora).run();
  const sessao = tokenNovo();
  await env.DB.prepare('INSERT INTO sessoes (hash, email, criado_em, expira_em) VALUES (?1, ?2, ?3, ?4)')
    .bind(await hashDe(sessao), link.email, agora, new Date(Date.now() + SESSAO_DIAS * 864e5).toISOString()).run();
  return { ok: true, sessao, email: link.email };
}

async function sessaoAtual(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer ([0-9a-f]{64})$/);
  if (!m || !env.DB) return null;
  const s = await env.DB.prepare('SELECT email, expira_em FROM sessoes WHERE hash = ?1').bind(await hashDe(m[1])).first();
  if (!s || s.expira_em < new Date().toISOString()) return null;
  return s;
}

async function minhaConta(request, env) {
  const s = await sessaoAtual(request, env);
  if (!s) return { conectada: false };
  const { results } = await env.DB.prepare(
    `SELECT id, criado_em, itens, total_centavos, status, pago_em, status_envio, transportadora, rastreio_codigo, rastreio_url, nota_fiscal_url, enviado_em, entregue_em
     FROM pedidos WHERE email_cliente = ?1 AND status NOT IN ('criado', 'erro_ao_criar') ORDER BY criado_em DESC LIMIT 50`
  ).bind(s.email).all();
  const pedidos = results.map(p => {
    let itens = [];
    try { itens = JSON.parse(p.itens).map(i => ({ titulo: i.titulo, quantidade: i.quantidade })); } catch {}
    return { ...p, itens };
  });
  return { conectada: true, email: s.email, pedidos };
}

async function sair(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer ([0-9a-f]{64})$/);
  if (m) await env.DB.prepare('DELETE FROM sessoes WHERE hash = ?1').bind(await hashDe(m[1])).run();
  return { ok: true };
}

/* ---------------- Painel da Hera: rastreio e situação da entrega ---------------- */
function senhaAdminOk(request, env) {
  const auth = request.headers.get('Authorization') || '';
  let senha = '';
  if (auth.startsWith('Basic ')) { try { senha = atob(auth.slice(6)).split(':').slice(1).join(':'); } catch { senha = ''; } }
  return !!env.RELATORIO_SENHA && !!senha && igualSeguro(senha, env.RELATORIO_SENHA);
}
function pedeSenha() {
  return new Response('Senha necessária', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Painel Hera", charset="UTF-8"' } });
}
const ENVIO = { aguardando: 'Aguardando', separando: 'Em separação', enviado: 'Enviado', entregue: 'Entregue' };

async function painelAdmin(request, env) {
  if (!env.RELATORIO_SENHA) return new Response('Defina o segredo RELATORIO_SENHA no Cloudflare.', { status: 503 });
  if (!senhaAdminOk(request, env)) return pedeSenha();
  const url = new URL(request.url);
  const { results } = await env.DB.prepare(
    `SELECT * FROM pedidos WHERE status LIKE 'aprovado%' OR status = 'pendente' ORDER BY criado_em DESC LIMIT 100`
  ).all();
  const reais = c => 'R$ ' + ((c || 0) / 100).toFixed(2).replace('.', ',');
  const linhas = results.map(p => {
    let itens = '';
    try { itens = JSON.parse(p.itens).map(i => `${i.quantidade}x ${i.titulo}`).join('<br>'); } catch {}
    const opc = Object.entries(ENVIO).map(([k, v]) => `<option value="${k}"${p.status_envio === k ? ' selected' : ''}>${v}</option>`).join('');
    return `<form method="post" action="/api/admin/pedido" class="ped">
      <input type="hidden" name="id" value="${escHtml(p.id)}">
      <div class="cab"><b>${escHtml(p.id)}</b><span>${escHtml((p.criado_em || '').slice(0, 10))}</span><span class="st st-${escHtml(p.status)}">${escHtml(p.status)}</span><span>${reais(p.total_centavos)}</span></div>
      <div class="itens">${itens}<br><small>${escHtml(p.email_cliente || 'sem e-mail')}${p.cupom ? ' · código ' + escHtml(p.cupom) : ''}</small></div>
      <div class="campos">
        <label>Entrega<select name="status_envio">${opc}</select></label>
        <label>Transportadora<input name="transportadora" value="${escHtml(p.transportadora || '')}" placeholder="Correios, Melhor Envio…"></label>
        <label>Código de rastreio<input name="rastreio_codigo" value="${escHtml(p.rastreio_codigo || '')}"></label>
        <label>Link do rastreio (opcional)<input name="rastreio_url" value="${escHtml(p.rastreio_url || '')}" placeholder="https://…"></label>
        <label>Link da nota fiscal (opcional)<input name="nota_fiscal_url" value="${escHtml(p.nota_fiscal_url || '')}" placeholder="https://…"></label>
        <button>Salvar</button>
      </div></form>`;
  }).join('') || '<p>Nenhum pedido pago ainda.</p>';
  const aviso = url.searchParams.get('ok') ? `<p class="ok">Pedido ${escHtml(url.searchParams.get('ok'))} atualizado${url.searchParams.get('email') ? ' e e-mail enviado para a cliente' : ''}.</p>` : '';
  const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Painel Hera — pedidos</title><style>
body{font-family:Montserrat,Arial,sans-serif;background:#FBF7F2;color:#3B0B18;margin:0;padding:24px}h1{font-family:Georgia,serif;font-weight:400}
.ped{background:#fff;border:1px solid #eadfd8;border-radius:14px;padding:16px;margin:0 0 14px}.cab{display:flex;flex-wrap:wrap;gap:14px;align-items:center;margin-bottom:8px}
.st{padding:2px 10px;border-radius:999px;background:#f3e6e9;font-size:12px}.st-aprovado{background:#dff2e5;color:#1f6b3a}.itens{font-size:14px;margin-bottom:10px}
.campos{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));align-items:end}label{display:grid;gap:4px;font-size:12px}
input,select{min-height:38px;border:1px solid #d9cbc4;border-radius:8px;padding:0 10px;font:inherit}button{min-height:40px;border:0;border-radius:999px;background:#3B0B18;color:#fff;font:inherit;cursor:pointer}
.ok{background:#dff2e5;color:#1f6b3a;padding:10px 14px;border-radius:10px}</style></head><body>
<h1>Pedidos · Hera Perfumes</h1><p>Quando você marcar <b>Enviado</b> com o código de rastreio, a cliente recebe um e-mail e vê o rastreio em "Minha conta".</p>${aviso}${linhas}</body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

async function salvarAdmin(request, env) {
  if (!senhaAdminOk(request, env)) return pedeSenha();
  const propria = new URL(request.url).origin;
  const origem = request.headers.get('Origin');
  if (origem && origem !== propria) return new Response('Origem não permitida', { status: 403 });
  const f = await request.formData();
  const id = String(f.get('id') || '');
  const antes = await env.DB.prepare('SELECT * FROM pedidos WHERE id = ?1').bind(id).first();
  if (!antes) return new Response('Pedido não encontrado', { status: 404 });
  const campo = (n, max = 300) => String(f.get(n) || '').trim().slice(0, max) || null;
  const link = n => { const v = campo(n, 500); return v && /^https:\/\//i.test(v) ? v : null; };
  const envio = ENVIO[f.get('status_envio')] ? String(f.get('status_envio')) : 'aguardando';
  const agora = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE pedidos SET status_envio = ?2, transportadora = ?3, rastreio_codigo = ?4, rastreio_url = ?5, nota_fiscal_url = ?6,
       enviado_em = CASE WHEN ?2 IN ('enviado','entregue') THEN COALESCE(enviado_em, ?7) ELSE enviado_em END,
       entregue_em = CASE WHEN ?2 = 'entregue' THEN COALESCE(entregue_em, ?7) ELSE entregue_em END,
       atualizado_em = ?7 WHERE id = ?1`
  ).bind(id, envio, campo('transportadora', 60), campo('rastreio_codigo', 60), link('rastreio_url'), link('nota_fiscal_url'), agora).run();

  let avisou = false;
  if (envio === 'enviado' && antes.status_envio !== 'enviado' && antes.email_cliente) {
    const site = (env.SITE_URL || propria).replace(/\/+$/, '');
    const codigo = campo('rastreio_codigo', 60);
    try {
      avisou = await mandarEmail(env, antes.email_cliente, `Seu pedido ${id} foi enviado`,
        moldeEmail('Seu perfume está a caminho!', `O pedido <b>${escHtml(id)}</b> foi enviado${campo('transportadora') ? ' por ' + escHtml(campo('transportadora')) : ''}.${codigo ? ' Código de rastreio: <b>' + escHtml(codigo) + '</b>.' : ''}`, 'Acompanhar meu pedido', `${site}/#minha-conta`));
    } catch { avisou = false; }
  }
  return Response.redirect(`${propria}/admin?ok=${encodeURIComponent(id)}${avisou ? '&email=1' : ''}`, 303);
}


/* ---------------- Planilha Google (cópia dos e-mails no Drive) ---------------- */
// Manda o e-mail para a planilha sem atrasar a resposta para a cliente. Se a planilha falhar, o cadastro continua salvo no banco.
function paraPlanilha(env, ctx, dados) {
  if (!env.PLANILHA_URL || !env.PLANILHA_SEGREDO) return;
  const envio = fetch(env.PLANILHA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...dados, segredo: env.PLANILHA_SEGREDO }),
    redirect: 'follow',
  }).catch(e => console.error('planilha falhou', e && e.message));
  if (ctx && ctx.waitUntil) ctx.waitUntil(envio);
}
