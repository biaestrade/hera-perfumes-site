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
 *   POST /api/cadastrar     cria a conta com e-mail e senha (manda link para confirmar o e-mail)
 *   POST /api/login         entra com e-mail e senha
 *   POST /api/login-google  entra com a conta Google (botão "Continuar com Google")
 *   GET  /api/config        dados públicos que o site precisa (ID do Google)
 *   GET  /api/perfil        dados da cliente (nome, CPF, WhatsApp, endereço)
 *   POST /api/perfil        salva os dados da cliente
 *   POST /api/senha         cria ou troca a senha (cliente já conectada)
 *   POST /api/entrar        envia o link de entrada para o e-mail da cliente (também serve para "esqueci a senha")
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
 *   SUPERFRETE_TOKEN   chave da SuperFrete (cotação de PAC, SEDEX, Jadlog e Loggi)
 *   BLING_CLIENT_ID / BLING_CLIENT_SECRET   aplicativo do Bling (pedidos e nota fiscal) — ver worker/bling.js
 *
 * A cada 30 minutos (cron em wrangler.toml) o Worker manda para o Drive o arquivo hera-site-dados.json,
 * que o Painel da Hera lê: cadastros, carrinhos e checkouts abandonados e a situação de entrega dos pedidos.
 *
 * Regras ajustáveis ficam em wrangler.toml, na seção [vars].
 * Os cupons ficam na tabela "cupons" do banco D1 (não no código, porque o repositório é público).
 */

import { blingConfigurado, linkConectar, retornoBling, enviarPedidoBling, rodadaBling, notasParaPainel, statusBling, nomeSituacaoNfe } from './bling.js';

const MP_API = 'https://api.mercadopago.com';
const MAX_ITENS = 30;
const MAX_QTD = 10;

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((blingConfigurado(env) ? produtosOficiais(env).then(of => rodadaBling(env, of)).catch(e => console.error('bling', e && e.message)) : Promise.resolve())
      .then(() => enviarDadosPainel(env)).catch(e => console.error('dados do painel', e && e.message)));
    ctx.waitUntil(lembrarCarrinhos(env).catch(e => console.error('lembrete de carrinho', e && e.message)));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/admin') return await painelAdmin(request, env);
    if (!url.pathname.startsWith('/api/')) {
      // ambiente de teste: o próprio Worker serve as páginas do site
      if (env.ASSETS && request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html' || /^\/p\/[^/]+\/?$/.test(url.pathname))) {
        return await paginaComPrevia(env, url);
      }
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
          return await webhook(request, env, url, ctx);
        case 'GET /api/bling/conectar':
          if (!senhaAdminOk(request, env)) return pedeSenha();
          if (!blingConfigurado(env)) return new Response('Faltam os segredos BLING_CLIENT_ID e BLING_CLIENT_SECRET no Cloudflare.', { status: 503 });
          return Response.redirect(await linkConectar(env), 302);
        case 'GET /api/bling/retorno':
          return await retornoBling(url, env);
        case 'GET /api/bling/status':
          if (!senhaAdminOk(request, env)) return pedeSenha();
          return json(await statusBling(env));
        case 'POST /api/bling/reenviar': {
          if (!senhaAdminOk(request, env)) return pedeSenha();
          const f = await request.formData();
          const id = String(f.get('id') || '');
          await env.DB.prepare('UPDATE pedidos SET bling_tentativas = 0, bling_erro = NULL WHERE id = ?1').bind(id).run();
          let msg = 'enviado';
          try { await enviarPedidoBling(env, id, await produtosOficiais(env)); } catch (e) { msg = 'erro'; }
          return Response.redirect(new URL(`/admin?bling=${encodeURIComponent(id)}&r=${msg}`, request.url).toString(), 303);
        }
        case 'POST /api/newsletter':
          if (!cors) return json({ erro: 'Origem não permitida.' }, 403);
          return json(await newsletter(request, env, ctx), 200, cors);
        case 'GET /api/newsletter.csv':
          return await newsletterCsv(request, env);
        case 'POST /api/cadastrar':
          if (!cors) return json({ erro: 'Origem não permitida.' }, 403);
          return json(await cadastrar(request, env), 200, cors);
        case 'POST /api/login':
          if (!cors) return json({ erro: 'Origem não permitida.' }, 403);
          return json(await login(request, env), 200, cors);
        case 'POST /api/login-google':
          if (!cors) return json({ erro: 'Origem não permitida.' }, 403);
          return json(await loginGoogle(request, env, ctx), 200, cors);
        case 'GET /api/config':
          return json({ google_client_id: env.GOOGLE_CLIENT_ID || '' }, 200, { ...(cors || {}), 'Cache-Control': 'public, max-age=300' });
        case 'GET /api/perfil':
          if (!cors) return json({ erro: 'Origem não permitida.' }, 403);
          return json(await lerPerfil(request, env), 200, cors);
        case 'POST /api/perfil':
          if (!cors) return json({ erro: 'Origem não permitida.' }, 403);
          return json(await salvarPerfil(request, env, ctx), 200, cors);
        case 'POST /api/senha':
          if (!cors) return json({ erro: 'Origem não permitida.' }, 403);
          return json(await trocarSenha(request, env), 200, cors);
        case 'POST /api/entrar':
          if (!cors) return json({ erro: 'Origem não permitida.' }, 403);
          return json(await entrar(request, env), 200, cors);
        case 'POST /api/entrar/confirmar':
          if (!cors) return json({ erro: 'Origem não permitida.' }, 403);
          return json(await confirmarEntrada(request, env, ctx), 200, cors);
        case 'POST /api/carrinho':
          if (!cors) return json({ erro: 'Origem não permitida.' }, 403);
          return json(await salvarCarrinho(request, env), 200, cors);
        case 'GET /api/lembrete/sair':
          return await sairDosLembretes(url, env);
        case 'GET /api/carrinho':
          if (!cors) return json({ erro: 'Origem não permitida.' }, 403);
          return json(await lerCarrinho(request, env), 200, cors);
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
            frete_embutido: Number(env.FRETE_EMBUTIDO) || 0,
            frete_cliente_pct: Number(env.FRETE_CLIENTE_PCT ?? 100),
            frete_configurado: !!env.SUPERFRETE_TOKEN && String(env.FRETE_CEP_ORIGEM || '').replace(/\D/g, '').length === 8,
            email_configurado: !!env.RESEND_API_KEY,
            google_configurado: !!env.GOOGLE_CLIENT_ID,
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
    // desconto extra pagando com Pix pelo site (só nos perfumes, não no frete; soma com o código promocional)
    pixDescontoPct: Math.min(Math.max(num(env.PIX_DESCONTO_PCT, 5), 0), 50),
    descontoMaxPct: 90,
  };
}

/* ------------------------------------------------------------------- frete */
// Cotação pela SuperFrete (PAC e SEDEX dos Correios, sem contrato). Sem o segredo SUPERFRETE_TOKEN, vale o frete fixo FRETE_CENTAVOS.
// Caixas simuladas pelo Fernando (cm) e peso estimado já embalado (kg): frasco + caixinha do perfume + caixa de envio e proteção.
const CAIXAS = {
  P: { width: 16.5, length: 11, height: 7, weight: 0.3 },  // 30 a 50 ml
  M: { width: 19, length: 14, height: 10, weight: 0.55 },  // 70 a 125 ml
  G: { width: 27, length: 18, height: 9, weight: 0.85 },   // mais de 125 ml (até 200 ml) e kits
};
const SERVICOS_FRETE = { 1: 'PAC', 2: 'SEDEX', 17: 'Mini Envios', 3: 'Jadlog', 31: 'Loggi', 33: 'J&T Express' };
function caixaDoPerfume(p) {
  if (!p || p.tipo === 'cofre') return CAIXAS.G;
  const ml = p.ml || 100;
  return ml <= 50 ? CAIXAS.P : ml <= 125 ? CAIXAS.M : CAIXAS.G;
}
// quais formas de envio aparecem no site (códigos da SuperFrete), em FRETE_SERVICOS no wrangler.toml
function servicosFrete(env) {
  const L = String(env.FRETE_SERVICOS || '1,2').split(',').map(x => Number(x.trim())).filter(x => SERVICOS_FRETE[x]);
  return L.length ? L : [1, 2];
}
const cacheFrete = new Map(); // mesma cotação por 15 minutos, para não chamar a SuperFrete a cada clique
async function cotarFrete(env, cep, linhas, produtos, totalProdutos) {
  const destino = String(cep || '').replace(/\D/g, '');
  if (destino.length !== 8 || !env.SUPERFRETE_TOKEN) return null;
  const origem = String(env.FRETE_CEP_ORIGEM || '').replace(/\D/g, '');
  if (origem.length !== 8) throw new Error('FRETE_CEP_ORIGEM não configurado');
  const products = linhas.map(l => ({ quantity: l.quantidade, ...caixaDoPerfume(produtos.get(l.id)) }));
  const chave = destino + '|' + JSON.stringify(products);
  const guardado = cacheFrete.get(chave);
  let lista;
  if (guardado && Date.now() - guardado.quando < 15 * 60_000) lista = guardado.lista;
  else {
    const base = (env.SUPERFRETE_URL || 'https://api.superfrete.com').replace(/\/+$/, '');
    const r = await fetch(base + '/api/v0/calculator', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SUPERFRETE_TOKEN}`,
        'User-Agent': 'HeraPerfumes/1.0 (contato@heraevodiaperfumes.com.br)',
        'Content-Type': 'application/json', accept: 'application/json',
      },
      body: JSON.stringify({
        from: { postal_code: origem }, to: { postal_code: destino }, services: servicosFrete(env).join(','),
        options: { own_hand: false, receipt: false, insurance_value: 0, use_insurance_value: false },
        products,
      }),
    });
    if (!r.ok) {
      console.error('SuperFrete recusou a cotação', r.status, (await r.text()).slice(0, 300));
      throw new ErroCliente('Não conseguimos calcular o frete agora. Tente de novo em instantes.');
    }
    const j = await r.json();
    lista = (Array.isArray(j) ? j : [])
      .filter(x => x && !x.has_error && !x.error && SERVICOS_FRETE[x.id] && Number(x.price) > 0)
      .map(x => ({ id: x.id, nome: SERVICOS_FRETE[x.id], centavos: Math.round(Number(x.price) * 100), prazo: Number(x.delivery_time) || 0 }));
    cacheFrete.set(chave, { quando: Date.now(), lista });
    if (cacheFrete.size > 500) cacheFrete.clear();
  }
  // prazo: dias da transportadora + dias para a Hera postar (perfumes 2 a 3 dias úteis, kits 1 dia útil;
  // com perfume e kit juntos, vale o prazo maior)
  const temPerfume = linhas.some(l => { const p = produtos.get(l.id); return !p || p.tipo !== 'cofre'; });
  const dias = temPerfume ? env.FRETE_POSTAGEM_PERFUME_DIAS : env.FRETE_POSTAGEM_KIT_DIAS;
  const extra = Math.max(0, Math.round(Number(dias ?? env.FRETE_PRAZO_EXTRA_DIAS ?? 1)) || 0);
  // frete grátis na opção mais barata a partir de FRETE_GRATIS_ACIMA (em reais; 0 = desligado)
  const gratisAcima = Math.round((Number(env.FRETE_GRATIS_ACIMA) || 0) * 100);
  return lista.slice().sort((a, b) => a.centavos - b.centavos).map((x, i) => {
    const gratis = gratisAcima > 0 && totalProdutos >= gratisAcima && i === 0;
    // o cliente paga só FRETE_CLIENTE_PCT % do frete (a Hera paga o resto)
    const pct = Math.min(100, Math.max(0, Number(env.FRETE_CLIENTE_PCT ?? 100)));
    return { ...x, prazo: x.prazo + extra, gratis, cobrado: gratis ? 0 : Math.round(x.centavos * pct / 100) };
  });
}

/* ---------------------------------------------------------------- produtos */

let cacheProdutos = null; // { quando, mapa }

/* ------------------------------------------- prévia do link (WhatsApp etc.) */
// "/" mostra a capa da Hera; "/p/<id>" mostra a foto e o nome do perfume e abre a página dele no site
async function paginaComPrevia(env, url) {
  const resp = await env.ASSETS.fetch(new Request(url.origin + '/'));
  if (!resp.ok) return resp;
  const origem = (env.SITE_URL || url.origin).replace(/\/+$/, '');
  let meta = { titulo: 'Hera Perfumes — Fragrâncias icônicas', desc: null, imagem: origem + '/assets/compartilhar/hera.jpg', url: origem + '/', alt: 'Hera Perfumes' };
  let idProduto = null;
  const m = url.pathname.match(/^\/p\/([^/]+)/);
  if (m) {
    idProduto = decodeURIComponent(m[1]);
    let p = null;
    try {
      const r = await env.ASSETS.fetch(new Request(url.origin + '/produtos.json'));
      if (r.ok) p = (await r.json()).find(x => x.id === idProduto) || null;
    } catch (e) {}
    if (!p) return Response.redirect(url.origin + '/#catalogo', 302);
    const preco = n => 'R$ ' + Number(n).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    const tipo = p.tipo === 'cofre' ? 'Kit para presente' : [p.conc, p.vol].filter(Boolean).join(' ');
    const por = Number(p.preco) + (Number(env.FRETE_EMBUTIDO) || 0); // mesmo preço que o site mostra
    const pixPct = Math.min(Math.max(Number(env.PIX_DESCONTO_PCT) || 0, 0), 50);
    const noPix = Math.round(por * (100 - pixPct)) / 100;
    const de = (Number(p.preco_de) > por ? `De ${preco(p.preco_de)} por ` : '') + (pixPct ? `${preco(noPix)} no Pix ou ${preco(por)} no cartão` : preco(por));
    meta = {
      titulo: `${p.marca} ${p.nome} — Hera Perfumes`,
      desc: `${tipo ? tipo + '. ' : ''}${de}. Perfume original. Em até 4x sem juros no cartão.`,
      imagem: `${origem}/assets/compartilhar/${encodeURIComponent(p.id)}.jpg`,
      url: `${origem}/p/${encodeURIComponent(p.id)}`,
      alt: `${p.marca} ${p.nome}`,
    };
  }
  const troca = (valor) => ({ element(el) { el.setAttribute('content', valor); } });
  let rw = new HTMLRewriter()
    .on('meta[property="og:title"]', troca(meta.titulo))
    .on('meta[property="og:url"]', troca(meta.url))
    .on('meta[property="og:image"]', troca(meta.imagem))
    .on('meta[property="og:image:alt"]', troca(meta.alt));
  if (meta.desc) {
    rw = rw.on('meta[property="og:description"]', troca(meta.desc)).on('meta[name="description"]', troca(meta.desc))
      .on('title', { element(el) { el.setInnerContent(meta.titulo); } })
      .on('head', { element(el) { el.prepend(`<script>history.replaceState(null,'','/#produto/'+${JSON.stringify(idProduto).replace(/</g, '\\u003c')})</script>`, { html: true }); } });
  }
  const out = rw.transform(resp);
  const h = new Headers(out.headers);
  h.set('Cache-Control', 'public, max-age=300');
  return new Response(out.body, { status: 200, headers: h });
}

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
    const base = Math.round(Number(p.preco) * 100);
    if (!p.id || !Number.isInteger(base) || base <= 0) continue;
    // metade do frete por conta da Hera: FRETE_EMBUTIDO (reais) vai somado ao preço de cada perfume (o site mostra o mesmo)
    const preco = base + Math.max(0, Math.round((Number(env.FRETE_EMBUTIDO) || 0) * 100));
    mapa.set(String(p.id), {
      id: String(p.id),
      titulo: [p.marca, p.nome, p.conc, p.vol].filter(Boolean).join(' '),
      precoCentavos: preco,
      ativo: p.ativo !== false,
      estoque: Number.isInteger(p.estoque) ? p.estoque : null, // controle de estoque: preparado, ainda não usado
      ml: parseInt(String(p.vol || ''), 10) || null, // para escolher a caixa do frete
      tipo: p.tipo || '',
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
    'SELECT * FROM cupons WHERE codigo = ?1 AND ativo = 1'
  ).bind(codigo).first();
  if (!c) return null;
  // código com data final: depois do dia, para de valer (horário de Brasília)
  const hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  if (c.valido_ate && String(c.valido_ate).slice(0, 10) < hoje) return null;
  return c;
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

async function calcular(env, corpo, cepEntrega) {
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

  // Pix: mais X% em cima do preço já com o código, por unidade (o total do Mercado Pago bate exatamente)
  const pixPct = r.pixDescontoPct;
  const metodo = corpo && corpo.metodo === 'pix' && pixPct > 0 ? 'pix' : 'cartao';
  for (const l of linhas) {
    l.unitarioPixCentavos = Math.round(l.unitarioCentavos * (100 - pixPct) / 100);
    l.totalPixCentavos = l.unitarioPixCentavos * l.quantidade;
  }
  const subtotal = linhas.reduce((s, l) => s + l.precoCentavos * l.quantidade, 0);
  const totalCartaoProdutos = linhas.reduce((s, l) => s + l.totalCentavos, 0);
  const totalPixProdutos = linhas.reduce((s, l) => s + l.totalPixCentavos, 0);
  const descontoPix = totalCartaoProdutos - totalPixProdutos;
  if (metodo === 'pix') for (const l of linhas) { l.unitarioCentavos = l.unitarioPixCentavos; l.totalCentavos = l.totalPixCentavos; }
  const totalProdutos = metodo === 'pix' ? totalPixProdutos : totalCartaoProdutos;
  const desconto = subtotal - totalProdutos;

  // frete: com a SuperFrete ligada, depende do CEP (no pagamento, sempre o CEP do endereço da conta)
  let frete = r.freteCentavos, fretes = null, freteEscolhido = null, freteErro = '';
  const cep = cepEntrega || (corpo && corpo.cep);
  if (env.SUPERFRETE_TOKEN) {
    frete = 0;
    if (String(cep || '').replace(/\D/g, '').length === 8) {
      try {
        fretes = await cotarFrete(env, cep, linhas, produtos, totalCartaoProdutos);
      } catch (e) {
        if (cepEntrega) throw e;
        console.error('frete', e && e.message);
        freteErro = e instanceof ErroCliente ? e.message : 'Não conseguimos calcular o frete agora.';
      }
      if (fretes && !fretes.length) freteErro = 'Não encontramos entrega para esse CEP. Confira o número.';
      if (fretes && fretes.length) {
        const pedido = Number(corpo && corpo.servico);
        freteEscolhido = fretes.find(x => x.id === pedido) || fretes[0];
        frete = freteEscolhido.cobrado;
      }
    }
  }

  let nomeDesconto = '';
  if (pct > 0) {
    if (r.combinar === 'somar' && pctBase && pctCupom) nomeDesconto = `Desconto do site (${pctBase}%) + código ${cupom.codigo} (${pctCupom}%)`;
    else if (cupom && pctCupom >= pctBase) nomeDesconto = `Código ${cupom.codigo} (${pctCupom}%)`;
    else nomeDesconto = `Desconto do site (${pctBase}%)`;
  }
  if (metodo === 'pix') nomeDesconto = nomeDesconto ? `${nomeDesconto} + Pix (${pixPct}%)` : `Pix (${pixPct}%)`;
  const descontoCodigo = subtotal - totalCartaoProdutos;

  let mensagemCupom = '';
  if (codigo && !cupom) mensagemCupom = 'Código não encontrado ou inativo.';
  else if (cupom && r.combinar === 'maior' && pctCupom < pctBase) mensagemCupom = `Código aplicado. O desconto do site (${pctBase}%) é maior e foi mantido.`;
  else if (cupom) mensagemCupom = pctCupom > 0 ? `Código aplicado: ${pctCupom}% de desconto.` : 'Código aplicado.';

  const comissaoPct = cupom ? Number(cupom.comissao_pct) || 0 : 0;
  return {
    linhas, subtotal, desconto, frete, totalProdutos, fretes, freteEscolhido, freteErro,
    freteAtivo: !!env.SUPERFRETE_TOKEN,
    total: totalProdutos + frete,
    metodo, pixPct, descontoPix, descontoCodigo,
    totalPix: totalPixProdutos + frete, totalCartao: totalCartaoProdutos + frete,
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
    frete_ativo: c.freteAtivo,
    frete_calculado: !!c.freteEscolhido,
    frete_erro: c.freteErro,
    fretes: c.fretes ? c.fretes.map(x => ({ id: x.id, nome: x.nome, preco: x.cobrado, preco_cheio: x.centavos, prazo: x.prazo, gratis: x.gratis })) : null,
    servico: c.freteEscolhido ? c.freteEscolhido.id : null,
    descontos: c.desconto > 0 ? [{ nome: c.nomeDesconto, valor: c.desconto }] : [],
    // os dois jeitos de pagar no site (o carrinho mostra os dois)
    pix: c.pixPct > 0 ? { pct: c.pixPct, desconto: c.descontoPix, total: c.totalPix } : null,
    cartao: { total: c.totalCartao, desconto: c.descontoCodigo },
    cupom: c.cupom ? c.cupom.codigo : null,
    cupom_valido: !!c.cupom,
    mensagem_cupom: c.mensagemCupom,
    cupom_condicoes: c.cupom ? [c.cupom.condicoes, c.cupom.valido_ate ? `Válido até ${String(c.cupom.valido_ate).slice(0, 10).split('-').reverse().join('/')}.` : ''].filter(Boolean).join(' ') : '',
    itens: c.linhas.map(l => ({ id: l.id, quantidade: l.quantidade, unitario: l.unitarioCentavos, total: l.totalCentavos })),
  };
}

/* ----------------------------------------------------------------- pagar */

async function pagar(request, env) {
  const sessao = await sessaoAtual(request, env);
  if (!sessao) throw new ErroCliente('Entre na sua conta para finalizar a compra.');
  const emailCliente = sessao.email;
  const perfil = await env.DB.prepare('SELECT * FROM clientes WHERE email = ?1').bind(emailCliente).first();
  if (!perfilCompleto(perfil)) throw new ErroCliente('Complete seus dados de entrega em Minha conta para finalizar a compra.');
  if (!env.MP_ACCESS_TOKEN) throw new Error('MP_ACCESS_TOKEN não configurado');
  if (!env.DB) throw new Error('banco D1 não configurado');
  const corpo = await lerCorpo(request);
  const c = await calcular(env, corpo, perfil.cep);
  if (c.freteAtivo && !c.freteEscolhido) throw new ErroCliente('Não conseguimos calcular o frete para o CEP da sua conta. Confira o CEP em Minha conta ou fale com a Hera pelo WhatsApp.');
  if (corpo.cupom && !c.cupom) throw new ErroCliente('Esse código promocional não é válido. Corrija ou apague o código.');

  const pedidoId = 'HERA-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + crypto.randomUUID().slice(0, 8).toUpperCase();
  const agora = new Date().toISOString();
  const modo = env.MODO || 'teste';

  await env.DB.prepare(
    `INSERT INTO pedidos (id, criado_em, modo, itens, subtotal_centavos, desconto_centavos, frete_centavos, total_centavos,
       cupom, representante, comissao_pct, comissao_centavos, status, atualizado_em, email_cliente, entrega)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'criado', ?2, ?13, ?14)`
  ).bind(
    pedidoId, agora, modo,
    JSON.stringify(c.linhas.map(l => ({ id: l.id, titulo: l.titulo, quantidade: l.quantidade, unitario_centavos: l.unitarioCentavos }))),
    c.subtotal, c.desconto, c.frete, c.total,
    c.cupom ? c.cupom.codigo : null, c.cupom ? c.cupom.representante : null,
    c.comissaoPct, c.comissaoCentavos, emailCliente,
    JSON.stringify({ ...entregaDe(perfil), ...(c.freteEscolhido ? { envio: c.freteEscolhido.nome, prazo_dias: c.freteEscolhido.prazo } : {}), pagamento: c.metodo === 'pix' ? 'Pix' : 'Cartão' })
  ).run();

  const origemApi = new URL(request.url).origin;
  const site = (env.SITE_URL || origemApi).replace(/\/+$/, '');
  const itensMp = c.linhas.map(l => ({
    id: l.id, title: l.titulo.slice(0, 250), quantity: l.quantidade,
    unit_price: l.unitarioCentavos / 100, currency_id: 'BRL',
  }));
  if (c.frete > 0) itensMp.push({ id: 'frete', title: c.freteEscolhido ? `Frete ${c.freteEscolhido.nome}` : 'Frete', quantity: 1, unit_price: c.frete / 100, currency_id: 'BRL' });

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
    metadata: { pedido_id: pedidoId, cupom: c.cupom ? c.cupom.codigo : null, metodo: c.metodo },
    // Pix com desconto: o Mercado Pago só mostra Pix (o saldo em conta do Mercado Pago não pode ser tirado).
    // Cartão: só cartão (sem Pix, que tem o preço menor, e sem boleto).
    payment_methods: c.metodo === 'pix'
      ? { excluded_payment_types: [{ id: 'credit_card' }, { id: 'debit_card' }, { id: 'ticket' }, { id: 'atm' }, { id: 'prepaid_card' }], installments: 1 }
      // até 8x no cartão (2x a 4x sem juros para o cliente é configurado na conta do Mercado Pago)
      // sem desconto no Pix (PIX_DESCONTO_PCT = 0): um botão só, e a cliente escolhe Pix ou cartão no Mercado Pago
      : { excluded_payment_types: c.pixPct > 0 ? [{ id: 'bank_transfer' }, { id: 'ticket' }, { id: 'atm' }] : [{ id: 'ticket' }, { id: 'atm' }], installments: 8 },
  };
  const nomes = String(perfil.nome || '').trim().split(/\s+/);
  preferencia.payer = {
    email: emailCliente,
    first_name: nomes[0] || undefined, last_name: nomes.slice(1).join(' ') || undefined,
    identification: perfil.cpf ? { type: 'CPF', number: perfil.cpf } : undefined,
    phone: perfil.telefone ? { area_code: perfil.telefone.slice(0, 2), number: perfil.telefone.slice(2) } : undefined,
    address: { zip_code: perfil.cep, street_name: perfil.logradouro, street_number: perfil.numero },
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

// pedido acabou de ser pago: lança no Bling (e emite a nota) se o Bling estiver conectado.
// Se falhar, a rodada de 30 em 30 minutos tenta de novo.
async function blingAoPagar(env, pedidoId) {
  if (!blingConfigurado(env)) return;
  const t = await env.DB.prepare('SELECT conectado_em, erro FROM bling_tokens WHERE id = 1').first().catch(() => null);
  if (!t || t.erro) return;
  await enviarPedidoBling(env, pedidoId, await produtosOficiais(env));
}

async function webhook(request, env, url, ctx) {
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
  const atualizou = await env.DB.prepare(
    `UPDATE pedidos SET status = ?2, pagamento_id = ?3, valor_pago_centavos = ?4,
       pago_em = CASE WHEN ?2 LIKE 'aprovado%' THEN COALESCE(?5, pago_em) ELSE pago_em END,
       atualizado_em = ?6
     WHERE id = ?1 AND (status NOT LIKE 'aprovado%' OR pagamento_id = ?3)`
  ).bind(pedidoId, status, String(pg.id), valorPago, pg.date_approved || null, new Date().toISOString()).run();
  // se o pedido ainda não tem e-mail (cliente não estava conectada), usa o e-mail informado no Mercado Pago
  const emailPagador = emailValido(pg.payer && pg.payer.email);
  if (emailPagador) await env.DB.prepare('UPDATE pedidos SET email_cliente = COALESCE(email_cliente, ?2) WHERE id = ?1').bind(pedidoId, emailPagador).run();

  // primeira vez que o pedido fica pago: avisa a Hera e confirma para a cliente (uma vez só)
  const virouPago = status.startsWith('aprovado') && !String(pedido.status || '').startsWith('aprovado')
    && atualizou.meta && atualizou.meta.changes > 0;
  if (virouPago) {
    const tarefa = avisarPedidoPago(env, new URL(request.url).origin, pedidoId).catch(e => console.error('aviso de pedido', e))
      .then(() => blingAoPagar(env, pedidoId)).catch(e => console.error('bling', e && e.message))
      .then(() => enviarDadosPainel(env)).catch(e => console.error('dados do painel', e && e.message));
    if (ctx && ctx.waitUntil) ctx.waitUntil(tarefa); else await tarefa;
  }

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

// e-mail de "pedido novo pago" para a Hera (AVISO_PEDIDO_EMAIL, padrão: contato@) e "recebemos seu pedido" para a cliente
export async function avisarPedidoPago(env, origem, pedidoId) {
  const p = await env.DB.prepare('SELECT * FROM pedidos WHERE id = ?1').bind(pedidoId).first();
  if (!p) return;
  const reais = c => 'R$ ' + ((c || 0) / 100).toFixed(2).replace('.', ',');
  let itens = []; try { itens = JSON.parse(p.itens || '[]'); } catch (e) {}
  let ent = null; try { ent = JSON.parse(p.entrega || 'null'); } catch (e) {}
  const lista = itens.map(i => `${i.quantidade}× ${escHtml(i.titulo || i.id)} — ${reais((i.unitario_centavos || 0) * i.quantidade)}`).join('<br>');
  const descLinha = p.desconto_centavos ? `<br>Desconto${p.cupom ? ' (' + escHtml(p.cupom) + ')' : ''}: −${reais(p.desconto_centavos)}` : '';
  const freteLinha = p.frete_centavos ? `<br>Frete: ${reais(p.frete_centavos)}` : '';
  const cpfFmt = c => String(c || '').replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  const site = (env.SITE_URL || origem).replace(/\/+$/, '');
  const teste = (p.modo || env.MODO || 'teste') === 'teste' ? ' [TESTE]' : '';
  const divergente = p.status === 'aprovado_valor_divergente'
    ? '<br><b style="color:#B00020">Atenção: o valor pago é diferente do total do pedido. Confira no Mercado Pago antes de enviar.</b>' : '';
  const fone = ent && ent.telefone ? String(ent.telefone).replace(/\D/g, '') : '';
  // copia a venda para a aba "Vendas do site" da planilha (o Painel da Hera lê de lá)
  await vendaParaPlanilha(env, p, itens, ent);
  const paraHera = env.AVISO_PEDIDO_EMAIL || 'contato@heraevodiaperfumes.com.br';
  const textoHera = `<b>${escHtml(p.id)}</b> · pago ${reais(p.valor_pago_centavos)}${p.cupom ? ' · cupom ' + escHtml(p.cupom) + ' (' + escHtml(p.representante || '') + ')' : ''}${divergente}<br><br>
    ${lista}${descLinha}${freteLinha}<br><br>
    ${ent && ent.envio ? `<b>Envio:</b> ${escHtml(ent.envio)}${ent.prazo_dias ? ' (até ' + ent.prazo_dias + ' dias úteis)' : ''}<br>` : ''}${ent ? `<b>Entregar para:</b> ${escHtml(ent.nome)} · CPF ${escHtml(cpfFmt(ent.cpf))}<br>${escHtml(ent.endereco)}<br>
    WhatsApp: ${fone ? `<a href="https://wa.me/55${fone}">${escHtml(ent.telefone)}</a>` : '-'}` : ''}${p.email_cliente ? '<br>E-mail: ' + escHtml(p.email_cliente) : ''}`;
  await mandarEmail(env, paraHera, `Pedido pago${teste}: ${p.id} · ${reais(p.valor_pago_centavos)}`,
    moldeEmail('Pedido novo pago', textoHera, 'Abrir o painel de pedidos', site + '/admin', true));
  if (p.email_cliente) {
    const nome = ent && ent.nome ? escHtml(String(ent.nome).split(' ')[0]) + ', r' : 'R';
    await mandarEmail(env, p.email_cliente, `Recebemos seu pedido ${p.id}`,
      moldeEmail('Pedido confirmado', `${nome}ecebemos o pagamento do seu pedido <b>${escHtml(p.id)}</b>. Agora vamos separar seus perfumes com todo o cuidado.<br><br>${lista}${descLinha}${freteLinha}<br><br>Total pago: <b>${reais(p.valor_pago_centavos)}</b>${ent ? `<br>Entrega: ${escHtml(ent.endereco)}` : ''}<br><br>Você acompanha o envio e o rastreio em Minha conta.`,
        'Ver meu pedido', site + '/#minha-conta', true));
  }
}

// Uma linha por pedido pago na aba "Vendas do site". Se a planilha falhar, o pedido continua salvo no banco.
async function vendaParaPlanilha(env, p, itens, ent) {
  if (!env.PLANILHA_URL || !env.PLANILHA_SEGREDO) return;
  const r = c => Math.round(c || 0) / 100;
  try {
    await fetch(env.PLANILHA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      redirect: 'follow',
      body: JSON.stringify({
        segredo: env.PLANILHA_SEGREDO, aba: 'vendas',
        pedido: p.id, data: p.pago_em || p.criado_em, modo: p.modo || env.MODO || 'teste', situacao: p.status,
        nome: ent && ent.nome || '', telefone: ent && ent.telefone || '', email: p.email_cliente || '',
        itens: itens.map(i => ({ id: i.id, nome: i.titulo || i.id, qtd: i.quantidade, preco: r(i.unitario_centavos) })),
        subtotal: r(p.subtotal_centavos), desconto: r(p.desconto_centavos), frete: r(p.frete_centavos),
        total: r(p.valor_pago_centavos || p.total_centavos), cupom: p.cupom || '', representante: p.representante || '',
        comissao: r(p.comissao_centavos),
      }),
    });
  } catch (e) { console.error('planilha de vendas falhou', e && e.message); }
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
function moldeEmail(titulo, texto, botao, link, semRodape) {
  return `<div style="background:#FBF7F2;padding:32px 16px;font-family:Montserrat,Arial,sans-serif;color:#3B0B18">
  <div style="max-width:480px;margin:auto;background:#fff;border-radius:16px;padding:32px 28px">
    <p style="letter-spacing:4px;font-size:12px;color:#88072B;margin:0 0 12px">HERA PERFUMES</p>
    <h1 style="font-family:Georgia,serif;font-weight:400;font-size:26px;margin:0 0 12px">${titulo}</h1>
    <p style="line-height:1.6;color:#5a4a4f">${texto}</p>
    ${botao ? `<p style="margin:24px 0"><a href="${link}" style="background:#3B0B18;color:#FBF7F2;text-decoration:none;padding:14px 26px;border-radius:999px;display:inline-block">${botao}</a></p>` : ''}
    ${semRodape ? '' : '<p style="font-size:12px;color:#8a7a7f">Se você não pediu este e-mail, pode ignorar.</p>'}
  </div></div>`;
}

async function entrar(request, env) {
  const corpo = await lerCorpo(request);
  const email = emailValido(corpo.email);
  if (!email) throw new ErroCliente('Confira o e-mail digitado.');
  if (await muitosLinks(env, email)) throw new ErroCliente('Já mandamos alguns links agora há pouco. Confira seu e-mail (e a caixa de spam) ou tente de novo em 15 minutos.');

  return await enviarLink(request, env, email, {
    assunto: 'Seu link para entrar na Hera Perfumes', titulo: 'Entrar na sua conta',
    texto: `Toque no botão para ver seus pedidos e acompanhar a entrega. O link vale por ${LINK_MINUTOS} minutos e só funciona uma vez.`,
    botao: 'Entrar na minha conta', mensagem: `Enviamos um link de entrada para ${email}. Abra seu e-mail neste aparelho.`,
  });
}

async function enviarLink(request, env, email, txt, extra = {}) {
  const agora = new Date();
  const token = tokenNovo();
  await env.DB.prepare('INSERT INTO login_links (hash, email, criado_em, expira_em, senha_hash, aceite_promocoes, nome) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
    .bind(await hashDe(token), email, agora.toISOString(), new Date(+agora + LINK_MINUTOS * 60e3).toISOString(),
      extra.senha_hash || null, extra.aceite_promocoes ? 1 : 0, extra.nome || null).run();
  const site = (env.SITE_URL || new URL(request.url).origin).replace(/\/+$/, '');
  const link = `${site}/#minha-conta/entrar/${token}`;
  const enviado = await mandarEmail(env, email, txt.assunto, moldeEmail(txt.titulo, txt.texto, txt.botao, link));
  if (enviado) return { ok: true, mensagem: txt.mensagem };
  // sem serviço de e-mail configurado: só no modo de teste o link aparece na tela, para testar
  if ((env.MODO || 'teste') === 'teste') return { ok: true, mensagem: 'Modo de teste: o e-mail ainda não está configurado, então o link aparece aqui.', link_teste: link };
  throw new Error('RESEND_API_KEY não configurado');
}

async function muitosLinks(env, email) {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_links WHERE email = ?1 AND criado_em > ?2')
    .bind(email, new Date(Date.now() - 15 * 60e3).toISOString()).first();
  return r && r.n >= 3;
}

/* ---- senha ---- */
const PBKDF2_VOLTAS = 30000; // o plano grátis do Cloudflare tem pouco tempo de processamento por pedido
function b64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
function deB64(s) { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }
async function hashSenha(senha, sal = crypto.getRandomValues(new Uint8Array(16)), voltas = PBKDF2_VOLTAS) {
  const chave = await crypto.subtle.importKey('raw', new TextEncoder().encode(senha), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: sal, iterations: voltas }, chave, 256);
  return `pbkdf2$${voltas}$${b64(sal)}$${b64(bits)}`;
}
async function senhaConfere(senha, guardado) {
  const [tipo, voltas, sal] = String(guardado || '').split('$');
  if (tipo !== 'pbkdf2' || !sal) return false;
  return igualSeguro(await hashSenha(senha, deB64(sal), Number(voltas)), guardado);
}
function senhaValida(s) {
  s = String(s || '');
  if (s.length < 8) throw new ErroCliente('A senha precisa ter pelo menos 8 caracteres.');
  if (s.length > 128) throw new ErroCliente('Senha longa demais.');
  return s;
}

async function cadastrar(request, env) {
  const corpo = await lerCorpo(request);
  const email = emailValido(corpo.email);
  if (!email) throw new ErroCliente('Confira o e-mail digitado.');
  const senha = senhaValida(corpo.senha);
  if (corpo.aceite !== true) throw new ErroCliente('Para criar a conta, aceite a política de compra e de privacidade.');
  if (await muitosLinks(env, email)) throw new ErroCliente('Já mandamos alguns e-mails agora há pouco. Confira sua caixa de entrada (e o spam) ou tente de novo em 15 minutos.');
  const existe = await env.DB.prepare('SELECT senha_hash FROM clientes WHERE email = ?1').bind(email).first();
  if (existe && existe.senha_hash) throw new ErroCliente('Já existe uma conta com esse e-mail. Entre com sua senha ou use "Esqueci minha senha".');
  return await enviarLink(request, env, email, {
    assunto: 'Confirme seu e-mail para criar sua conta Hera', titulo: 'Falta só confirmar seu e-mail',
    texto: `Toque no botão para confirmar seu e-mail e ativar sua conta. O link vale por ${LINK_MINUTOS} minutos.`,
    botao: 'Confirmar e entrar', mensagem: `Quase lá! Enviamos um link para ${email}. Abra o e-mail e toque em "Confirmar e entrar" para ativar sua conta.`,
  }, { senha_hash: await hashSenha(senha), aceite_promocoes: corpo.promocoes === true, nome: String(corpo.nome || '').trim().slice(0, 80) });
}

async function login(request, env) {
  const corpo = await lerCorpo(request);
  const email = emailValido(corpo.email);
  const senha = String(corpo.senha || '');
  if (!email || !senha) throw new ErroCliente('Digite seu e-mail e sua senha.');
  const desde = new Date(Date.now() - 15 * 60e3).toISOString();
  const erros = await env.DB.prepare('SELECT COUNT(*) AS n FROM tentativas_login WHERE email = ?1 AND em > ?2').bind(email, desde).first();
  if (erros && erros.n >= 8) throw new ErroCliente('Muitas tentativas com senha errada. Espere 15 minutos ou use "Esqueci minha senha".');
  const c = await env.DB.prepare('SELECT senha_hash FROM clientes WHERE email = ?1').bind(email).first();
  if (!c || !c.senha_hash || !(await senhaConfere(senha, c.senha_hash))) {
    await env.DB.prepare('INSERT INTO tentativas_login (email, em) VALUES (?1, ?2)').bind(email, new Date().toISOString()).run();
    throw new ErroCliente('E-mail ou senha incorretos. Se você ainda não tem senha, crie sua conta ou use "Esqueci minha senha".');
  }
  await env.DB.prepare('UPDATE clientes SET ultimo_acesso = ?2 WHERE email = ?1').bind(email, new Date().toISOString()).run();
  return { ok: true, sessao: await abrirSessao(env, email), email };
}

async function trocarSenha(request, env) {
  const s = await sessaoAtual(request, env);
  if (!s) throw new ErroCliente('Entre na sua conta de novo para trocar a senha.');
  const corpo = await lerCorpo(request);
  const senha = senhaValida(corpo.senha);
  await env.DB.prepare('UPDATE clientes SET senha_hash = ?2 WHERE email = ?1').bind(s.email, await hashSenha(senha)).run();
  return { ok: true, mensagem: 'Senha salva. Da próxima vez, entre com seu e-mail e senha.' };
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
  if (link.senha_hash) { // veio do "Criar conta": a senha passa a valer agora que o e-mail foi confirmado
    await env.DB.prepare('UPDATE clientes SET senha_hash = ?2, aceite_termos_em = ?3, aceite_promocoes = ?4 WHERE email = ?1')
      .bind(link.email, link.senha_hash, agora, link.aceite_promocoes ? 1 : 0).run();
    if (link.aceite_promocoes) {
      await env.DB.prepare(`INSERT INTO newsletter (email, nome, origem, aceite_em, criado_em, ativo) VALUES (?1, ?2, 'cadastro', ?3, ?3, 1)
        ON CONFLICT(email) DO UPDATE SET ativo = 1, aceite_em = ?3`).bind(link.email, link.nome || '', agora).run();
      paraPlanilha(env, ctx, { aba: 'newsletter', email: link.email, nome: link.nome || '', origem: 'cadastro' });
    }
  }
  return { ok: true, sessao: await abrirSessao(env, link.email), email: link.email };
}

async function abrirSessao(env, email) {
  const sessao = tokenNovo();
  const agora = new Date().toISOString();
  await env.DB.prepare('INSERT INTO sessoes (hash, email, criado_em, expira_em) VALUES (?1, ?2, ?3, ?4)')
    .bind(await hashDe(sessao), email, agora, new Date(Date.now() + SESSAO_DIAS * 864e5).toISOString()).run();
  return sessao;
}

async function sessaoAtual(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer ([0-9a-f]{64})$/);
  if (!m || !env.DB) return null;
  const s = await env.DB.prepare('SELECT email, expira_em FROM sessoes WHERE hash = ?1').bind(await hashDe(m[1])).first();
  if (!s || s.expira_em < new Date().toISOString()) return null;
  return s;
}

/* ---------------- Carrinho guardado (cliente conectada) ---------------- */
async function salvarCarrinho(request, env) {
  const s = await sessaoAtual(request, env);
  if (!s) return { ok: false };
  const corpo = await lerCorpo(request);
  const itens = (Array.isArray(corpo.itens) ? corpo.itens : []).slice(0, MAX_ITENS)
    .map(i => ({ id: String(i && i.id || '').slice(0, 100), quantidade: Math.min(MAX_QTD, Math.max(1, parseInt(i && i.quantidade, 10) || 1)) }))
    .filter(i => i.id);
  if (!itens.length) {
    await env.DB.prepare('DELETE FROM carrinhos WHERE email = ?1').bind(s.email).run();
    return { ok: true };
  }
  await env.DB.prepare(
    `INSERT INTO carrinhos (email, itens, cupom, atualizado_em) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(email) DO UPDATE SET itens = excluded.itens, cupom = excluded.cupom, atualizado_em = excluded.atualizado_em`
  ).bind(s.email, JSON.stringify(itens), normalizaCupom(corpo.cupom) || null, new Date().toISOString()).run();
  return { ok: true };
}
async function lerCarrinho(request, env) {
  const s = await sessaoAtual(request, env);
  if (!s) return { itens: [] };
  const c = await env.DB.prepare('SELECT itens, cupom FROM carrinhos WHERE email = ?1').bind(s.email).first();
  let itens = []; try { itens = c ? JSON.parse(c.itens) : []; } catch (e) {}
  return { itens, cupom: c && c.cupom || '' };
}

/* ---------------- Dados para o Painel da Hera (arquivo no Drive) ---------------- */
/* ---------------- Lembrete de carrinho abandonado (24 horas depois) ---------------- */
// Roda junto com o relógio de 30 em 30 minutos. Um e-mail só por carrinho: se a cliente mexer no carrinho de novo,
// conta outra vez do zero. Carrinhos com mais de 3 dias não recebem (evita lembrar coisa velha).
async function lembrarCarrinhos(env) {
  if (!env.DB || !env.RESEND_API_KEY) return;
  const horas = Math.max(1, Number(env.LEMBRETE_CARRINHO_HORAS || 24));
  const agora = Date.now(), iso = d => new Date(d).toISOString();
  const car = (await env.DB.prepare(
    `SELECT c.email, c.itens, c.cupom, c.atualizado_em, cl.nome FROM carrinhos c LEFT JOIN clientes cl ON cl.email = c.email
     WHERE c.atualizado_em < ?1 AND c.atualizado_em >= ?2
       AND NOT EXISTS (SELECT 1 FROM pedidos p WHERE p.email_cliente = c.email AND p.status LIKE 'aprovado%' AND p.criado_em >= c.atualizado_em)
       AND NOT EXISTS (SELECT 1 FROM lembretes l WHERE l.email = c.email AND l.carrinho_em = c.atualizado_em)
       AND NOT EXISTS (SELECT 1 FROM sem_lembrete s WHERE s.email = c.email)
     ORDER BY c.atualizado_em LIMIT 20`
  ).bind(iso(agora - horas * 3600e3), iso(agora - (horas + 48) * 3600e3)).all()).results || [];
  if (!car.length) return;
  const produtos = await produtosOficiais(env);
  const pixPct = regras(env).pixDescontoPct;
  const reais = c => 'R$ ' + ((c || 0) / 100).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const site = (env.SITE_URL || env.LOJA_URL || '').replace(/\/+$/, '');
  const loja = (env.LOJA_URL || env.SITE_URL || '').replace(/\/+$/, '');
  if (!site) return;
  for (const c of car) {
    let itens = []; try { itens = JSON.parse(c.itens) || []; } catch (e) {}
    const linhas = itens.map(i => ({ p: produtos.get(i.id), q: i.quantidade || 1 })).filter(x => x.p && x.p.ativo);
    if (!linhas.length) continue;
    const total = linhas.reduce((t, x) => t + x.p.precoCentavos * x.q, 0);
    const lista = linhas.map(x => `${x.q > 1 ? x.q + 'x ' : ''}${escHtml(x.p.titulo)} · ${reais(x.p.precoCentavos)}`).join('<br>');
    const token = tokenNovo();
    const primeiro = String(c.nome || '').trim().split(/\s+/)[0];
    const texto = `${primeiro ? escHtml(primeiro) + ', s' : 'S'}eus perfumes ainda estão esperando por você no carrinho da Hera:<br><br>${lista}<br><br>` +
      `Total: <b>${reais(total)}</b>${pixPct ? ` · no Pix, ${pixPct}% off nos perfumes` : ''}${c.cupom ? `<br>Seu código ${escHtml(c.cupom)} continua guardado.` : ''}<br><br>` +
      `Ficou com alguma dúvida? Responda este e-mail ou chame a Hera no WhatsApp (11) 91318-4495.` +
      `<br><br><span style="font-size:12px;color:#8a7a7f">Não quer mais receber este lembrete? <a href="${loja}/api/lembrete/sair?t=${token}" style="color:#8a7a7f">Clique aqui</a>.</span>`;
    let enviado = false;
    try { enviado = await mandarEmail(env, c.email, 'Seus perfumes ficaram no carrinho', moldeEmail('Seu carrinho está guardado', texto, 'Voltar ao meu carrinho', `${site}/#carrinho`, true)); } catch (e) { console.error('lembrete', c.email, e && e.message); }
    if (enviado) {
      await env.DB.prepare('INSERT OR IGNORE INTO lembretes (email, carrinho_em, enviado_em, token_hash) VALUES (?1, ?2, ?3, ?4)')
        .bind(c.email, c.atualizado_em, new Date().toISOString(), await hashDe(token)).run();
    }
  }
}

async function sairDosLembretes(url, env) {
  const t = String(url.searchParams.get('t') || '').slice(0, 200);
  let ok = false;
  if (t && env.DB) {
    const l = await env.DB.prepare('SELECT email FROM lembretes WHERE token_hash = ?1').bind(await hashDe(t)).first();
    if (l) {
      await env.DB.prepare('INSERT OR IGNORE INTO sem_lembrete (email, em) VALUES (?1, ?2)').bind(l.email, new Date().toISOString()).run();
      ok = true;
    }
  }
  const corpo = moldeEmail(ok ? 'Pronto' : 'Link inválido', ok ? 'Você não vai mais receber lembretes de carrinho da Hera. Os e-mails do seu pedido (pagamento e envio) continuam chegando normalmente.' : 'Esse link não funciona mais. Se quiser, peça pelo e-mail contato@heraevodiaperfumes.com.br.', '', '', true);
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hera Perfumes</title><body style="margin:0">${corpo}</body>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

async function enviarDadosPainel(env) {
  if (!env.PLANILHA_URL || !env.PLANILHA_SEGREDO || !env.DB) return;
  const agora = Date.now(), iso = d => new Date(d).toISOString();
  const produtos = await produtosOficiais(env).catch(() => new Map());
  const titulo = id => (produtos.get(id) || {}).titulo || id;
  const resumo = itensJson => { try { return JSON.parse(itensJson || '[]').map(i => `${i.quantidade}x ${i.titulo || titulo(i.id)}`).join(' | '); } catch (e) { return ''; } };
  const entregaNome = e => { try { const j = JSON.parse(e || 'null'); return j ? { nome: j.nome || '', telefone: j.telefone || '' } : {}; } catch (x) { return {}; } };

  const cad = (await env.DB.prepare(
    `SELECT email, nome, telefone, cidade, uf, criado_em, ultimo_acesso, aceite_promocoes FROM clientes ORDER BY criado_em DESC LIMIT 500`
  ).all()).results || [];
  // carrinho parado há mais de 1 hora, sem pedido pago depois dele
  const car = (await env.DB.prepare(
    `SELECT c.email, c.itens, c.cupom, c.atualizado_em, cl.nome, cl.telefone FROM carrinhos c LEFT JOIN clientes cl ON cl.email = c.email
     WHERE c.atualizado_em < ?1 AND NOT EXISTS (SELECT 1 FROM pedidos p WHERE p.email_cliente = c.email AND p.status LIKE 'aprovado%' AND p.criado_em >= c.atualizado_em)
     ORDER BY c.atualizado_em DESC LIMIT 200`
  ).bind(iso(agora - 3600_000)).all()).results || [];
  // foi até o Mercado Pago e não pagou (últimos 30 dias), sem compra paga depois
  const chk = (await env.DB.prepare(
    `SELECT id, criado_em, status, email_cliente, entrega, itens, total_centavos, cupom, modo FROM pedidos p
     WHERE status NOT LIKE 'aprovado%' AND criado_em >= ?1 AND criado_em < ?2
       AND NOT EXISTS (SELECT 1 FROM pedidos q WHERE q.email_cliente = p.email_cliente AND q.status LIKE 'aprovado%' AND q.criado_em >= p.criado_em)
     ORDER BY criado_em DESC LIMIT 200`
  ).bind(iso(agora - 30 * 86400_000), iso(agora - 1800_000)).all()).results || [];
  const ped = (await env.DB.prepare(
    `SELECT * FROM pedidos
     WHERE status LIKE 'aprovado%' ORDER BY criado_em DESC LIMIT 300`
  ).all()).results || [];

  const dados = {
    gerado_em: iso(agora), modo: env.MODO || 'teste',
    cadastros: cad.map(c => ({ email: c.email, nome: c.nome || '', telefone: c.telefone || '', cidade: c.cidade ? `${c.cidade}/${c.uf || ''}` : '', criado_em: c.criado_em, ultimo_acesso: c.ultimo_acesso || '', promocoes: !!c.aceite_promocoes })),
    carrinhos: car.map(c => {
      let itens = []; try { itens = JSON.parse(c.itens); } catch (e) {}
      const total = itens.reduce((t, i) => t + ((produtos.get(i.id) || {}).precoCentavos || 0) * (i.quantidade || 1), 0);
      return { email: c.email, nome: c.nome || '', telefone: c.telefone || '', atualizado_em: c.atualizado_em, cupom: c.cupom || '', itens: itens.map(i => `${i.quantidade}x ${titulo(i.id)}`).join(' | '), valor: total / 100 };
    }),
    checkouts: chk.map(p => ({ pedido: p.id, criado_em: p.criado_em, status: p.status, email: p.email_cliente || '', ...entregaNome(p.entrega), itens: resumo(p.itens), valor: (p.total_centavos || 0) / 100, cupom: p.cupom || '', modo: p.modo })),
    pedidos: ped.map(p => ({ pedido: p.id, canal: 'Site', pago_em: p.pago_em || '', status: p.status, envio: p.status_envio || 'aguardando', transportadora: p.transportadora || '', rastreio: p.rastreio_codigo || '', rastreio_url: p.rastreio_url || '', enviado_em: p.enviado_em || '', entregue_em: p.entregue_em || '', modo: p.modo,
      ...entregaNome(p.entrega), email: p.email_cliente || '', valor: (p.total_centavos || 0) / 100,
      bling: p.bling_pedido_id ? 'no Bling' : (p.bling_erro ? 'erro: ' + p.bling_erro : ''),
      nota: p.nfe_numero || '', nota_situacao: nomeSituacaoNfe(p.nfe_situacao), nota_link: p.nfe_link || p.nota_fiscal_url || '' })),
    notas_fiscais: await notasParaPainel(env).catch(() => ({ conectado: false, notas: [] })),
  };
  const r = await fetch(env.PLANILHA_URL, {
    method: 'POST', redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ segredo: env.PLANILHA_SEGREDO, aba: 'painel', dados }),
  });
  if (!r.ok) throw new Error('Apps Script respondeu ' + r.status);
}

async function minhaConta(request, env) {
  const s = await sessaoAtual(request, env);
  if (!s) return { conectada: false };
  const { results } = await env.DB.prepare(
    `SELECT id, criado_em, itens, total_centavos, status, pago_em, status_envio, transportadora, rastreio_codigo, rastreio_url, nota_fiscal_url, enviado_em, entregue_em, entrega
     FROM pedidos WHERE email_cliente = ?1 AND status NOT IN ('criado', 'erro_ao_criar') ORDER BY criado_em DESC LIMIT 50`
  ).bind(s.email).all();
  const pedidos = results.map(p => {
    let itens = [];
    try { itens = JSON.parse(p.itens).map(i => ({ id: i.id, titulo: i.titulo, quantidade: i.quantidade })); } catch {}
    let entrega = null;
    try { entrega = p.entrega ? JSON.parse(p.entrega) : null; } catch {}
    if (entrega) entrega = { nome: entrega.nome, endereco: entrega.endereco };
    return { ...p, itens, entrega };
  });
  const perfil = await env.DB.prepare('SELECT * FROM clientes WHERE email = ?1').bind(s.email).first();
  return { conectada: true, email: s.email, pedidos, perfil: perfilPublico(perfil), perfil_completo: perfilCompleto(perfil) };
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
function blingLinha(p) {
  if (!p.bling_pedido_id && !p.bling_erro) return '';
  const nota = p.nfe_numero ? `Nota nº ${escHtml(p.nfe_numero)} · ${escHtml(nomeSituacaoNfe(p.nfe_situacao))}${p.nfe_link ? ` · <a href="${escHtml(p.nfe_link)}" target="_blank" rel="noopener">ver nota</a>` : ''}` : '';
  const erro = p.bling_erro ? `<span class="er">Bling: ${escHtml(p.bling_erro)}</span> <button formaction="/api/bling/reenviar" formmethod="post">Tentar de novo</button>` : '';
  return `<div class="bl">${p.bling_pedido_id ? '<span>✔ no Bling</span>' : ''}${nota ? '<span>' + nota + '</span>' : ''}${erro}</div>`;
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
    let ent = null; try { ent = p.entrega ? JSON.parse(p.entrega) : null; } catch {}
    const cpfFmt = c => String(c || '').replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
    const entHtml = ent ? `<div class="ent"><b>Entregar para:</b> ${escHtml(ent.nome)} · CPF ${escHtml(cpfFmt(ent.cpf))} · WhatsApp ${escHtml(ent.telefone)}<br>${escHtml(ent.endereco)}</div>` : '';
    const opc = Object.entries(ENVIO).map(([k, v]) => `<option value="${k}"${p.status_envio === k ? ' selected' : ''}>${v}</option>`).join('');
    return `<form method="post" action="/api/admin/pedido" class="ped">
      <input type="hidden" name="id" value="${escHtml(p.id)}">
      <div class="cab"><b>${escHtml(p.id)}</b><span>${escHtml((p.criado_em || '').slice(0, 10))}</span><span class="st st-${escHtml(p.status)}">${escHtml(p.status)}</span><span>${reais(p.total_centavos)}</span></div>
      <div class="itens">${itens}<br><small>${escHtml(p.email_cliente || 'sem e-mail')}${p.cupom ? ' · código ' + escHtml(p.cupom) : ''}</small>${entHtml}</div>
      <div class="campos">
        <label>Entrega<select name="status_envio">${opc}</select></label>
        <label>Transportadora<input name="transportadora" value="${escHtml(p.transportadora || '')}" placeholder="Correios, Melhor Envio…"></label>
        <label>Código de rastreio<input name="rastreio_codigo" value="${escHtml(p.rastreio_codigo || '')}"></label>
        <label>Link do rastreio (opcional)<input name="rastreio_url" value="${escHtml(p.rastreio_url || '')}" placeholder="https://…"></label>
        <label>Link da nota fiscal (opcional)<input name="nota_fiscal_url" value="${escHtml(p.nota_fiscal_url || '')}" placeholder="https://…"></label>
        <button>Salvar</button>
      </div>${blingLinha(p)}</form>`;
  }).join('') || '<p>Nenhum pedido pago ainda.</p>';
  const bs = await statusBling(env);
  const blingBox = !bs.configurado
    ? `<div class="bling">Bling: faltam os segredos <b>BLING_CLIENT_ID</b> e <b>BLING_CLIENT_SECRET</b> no Cloudflare.</div>`
    : bs.conectado
      ? `<div class="bling ok2">Bling conectado desde ${escHtml((bs.conectado_em || '').slice(0, 16).replace('T', ' '))} · nota automática: <b>${bs.emissao_automatica ? 'ligada' : 'desligada'}</b>${bs.ncm ? '' : ' · <b>falta o NCM (BLING_NCM)</b>'} · <a href="/api/bling/conectar">reconectar</a></div>`
      : `<div class="bling">${bs.aviso ? escHtml(bs.aviso) + '<br>' : ''}<a class="btn" href="/api/bling/conectar">Conectar Bling</a></div>`;
  const blingMsg = url.searchParams.get('bling') ? `<p class="ok">Pedido ${escHtml(url.searchParams.get('bling'))}: ${url.searchParams.get('r') === 'erro' ? 'o Bling recusou de novo (veja o motivo no pedido)' : 'enviado para o Bling'}.</p>` : '';
  const aviso = blingMsg + (url.searchParams.get('ok') ? `<p class="ok">Pedido ${escHtml(url.searchParams.get('ok'))} atualizado${url.searchParams.get('email') ? ' e e-mail enviado para a cliente' : ''}.</p>` : '');
  const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Painel Hera — pedidos</title><style>
body{font-family:Montserrat,Arial,sans-serif;background:#FBF7F2;color:#3B0B18;margin:0;padding:24px}h1{font-family:Georgia,serif;font-weight:400}
.ped{background:#fff;border:1px solid #eadfd8;border-radius:14px;padding:16px;margin:0 0 14px}.cab{display:flex;flex-wrap:wrap;gap:14px;align-items:center;margin-bottom:8px}
.st{padding:2px 10px;border-radius:999px;background:#f3e6e9;font-size:12px}.st-aprovado{background:#dff2e5;color:#1f6b3a}.itens{font-size:14px;margin-bottom:10px}
.campos{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));align-items:end}label{display:grid;gap:4px;font-size:12px}
input,select{min-height:38px;border:1px solid #d9cbc4;border-radius:8px;padding:0 10px;font:inherit}button{min-height:40px;border:0;border-radius:999px;background:#3B0B18;color:#fff;font:inherit;cursor:pointer}
.ok{background:#dff2e5;color:#1f6b3a;padding:10px 14px;border-radius:10px}.bling{background:#fff;border:1px solid #eadfd8;border-radius:12px;padding:12px 14px;margin:0 0 14px;font-size:14px}.bling.ok2{border-color:#bfe3cb}.btn{display:inline-block;margin-top:6px;background:#3B0B18;color:#fff;padding:8px 16px;border-radius:999px;text-decoration:none}.bl{margin-top:10px;font-size:13px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}.bl .er{color:#9a1c1c}.bl button{min-height:30px;padding:0 14px;font-size:12px}.ent{margin-top:8px;font-size:13px;background:#fbf7f2;border-radius:8px;padding:8px 10px}</style></head><body>
<h1>Pedidos · Hera Perfumes</h1>${blingBox}<p>Quando você marcar <b>Enviado</b> com o código de rastreio, a cliente recebe um e-mail e vê o rastreio em "Minha conta".</p>${aviso}${linhas}</body></html>`;
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


/* ---------------- Continuar com Google ---------------- */
// O Google entrega um "crachá" assinado (ID token). Conferimos a assinatura com as chaves públicas do Google,
// se o crachá é para o nosso site (aud), se não venceu e se o e-mail foi verificado.
let CHAVES_GOOGLE = null, CHAVES_GOOGLE_VALIDADE = 0;
async function chavesGoogle() {
  if (CHAVES_GOOGLE && Date.now() < CHAVES_GOOGLE_VALIDADE) return CHAVES_GOOGLE;
  const r = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  if (!r.ok) throw new Error('não foi possível buscar as chaves do Google');
  const m = /max-age=(\d+)/.exec(r.headers.get('Cache-Control') || '');
  CHAVES_GOOGLE = (await r.json()).keys || [];
  CHAVES_GOOGLE_VALIDADE = Date.now() + (m ? Number(m[1]) : 3600) * 1000;
  return CHAVES_GOOGLE;
}
function b64url(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
export async function verificaTokenGoogle(token, clientId, chaves, agoraSeg = Math.floor(Date.now() / 1000)) {
  const partes = String(token || '').split('.');
  if (partes.length !== 3) return null;
  let cab, dados;
  try { cab = JSON.parse(new TextDecoder().decode(b64url(partes[0]))); dados = JSON.parse(new TextDecoder().decode(b64url(partes[1]))); } catch { return null; }
  if (cab.alg !== 'RS256') return null;
  const jwk = chaves.find(k => k.kid === cab.kid);
  if (!jwk) return null;
  const chave = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', chave, b64url(partes[2]), new TextEncoder().encode(partes[0] + '.' + partes[1]));
  if (!ok) return null;
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(dados.iss)) return null;
  if (dados.aud !== clientId) return null;
  if (!dados.exp || dados.exp < agoraSeg - 60) return null;
  if (dados.email_verified !== true && dados.email_verified !== 'true') return null;
  return dados;
}

async function loginGoogle(request, env, ctx) {
  if (!env.GOOGLE_CLIENT_ID) throw new ErroCliente('O login com Google ainda não está ligado.');
  const corpo = await lerCorpo(request);
  const dados = await verificaTokenGoogle(corpo.credencial, env.GOOGLE_CLIENT_ID, await chavesGoogle());
  const email = dados && emailValido(dados.email);
  if (!email) throw new ErroCliente('Não foi possível entrar com o Google. Tente de novo ou entre com e-mail e senha.');
  const agora = new Date().toISOString();
  const jaCliente = await env.DB.prepare('SELECT 1 FROM clientes WHERE email = ?1').bind(email).first();
  if (!jaCliente) paraPlanilha(env, ctx, { aba: 'clientes', email, origem: 'Google' });
  // ao entrar pelo botão, a cliente aceita a política (o aviso fica logo abaixo do botão)
  await env.DB.prepare(`INSERT INTO clientes (email, criado_em, ultimo_acesso, aceite_termos_em) VALUES (?1, ?2, ?2, ?2)
    ON CONFLICT(email) DO UPDATE SET ultimo_acesso = ?2, aceite_termos_em = COALESCE(aceite_termos_em, ?2)`).bind(email, agora).run();
  return { ok: true, sessao: await abrirSessao(env, email), email, nome: dados.given_name || '' };
}


/* ---------------- Perfil da cliente (Meus dados) ---------------- */
const UFS = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'];
function soNumeros(v) { return String(v || '').replace(/\D/g, ''); }
function cpfValido(c) {
  c = soNumeros(c);
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  for (let t = 9; t < 11; t++) {
    let s = 0;
    for (let i = 0; i < t; i++) s += Number(c[i]) * (t + 1 - i);
    if (((s * 10) % 11) % 10 !== Number(c[t])) return false;
  }
  return true;
}
function perfilCompleto(p) {
  return !!(p && p.nome && p.cpf && p.telefone && p.cep && p.logradouro && p.numero && p.bairro && p.cidade && p.uf);
}
function perfilPublico(p) {
  if (!p) return {};
  const campos = ['nome', 'cpf', 'telefone', 'nascimento', 'cep', 'logradouro', 'numero', 'complemento', 'bairro', 'cidade', 'uf'];
  const o = {}; campos.forEach(k => { o[k] = p[k] || ''; }); o.promocoes = !!p.aceite_promocoes; return o;
}
function entregaDe(p) {
  const end = `${p.logradouro}, ${p.numero}${p.complemento ? ' - ' + p.complemento : ''} · ${p.bairro} · ${p.cidade}/${p.uf} · CEP ${p.cep.replace(/(\d{5})(\d{3})/, '$1-$2')}`;
  return { nome: p.nome, cpf: p.cpf, telefone: p.telefone, endereco: end,
    logradouro: p.logradouro, numero: p.numero, complemento: p.complemento || '', bairro: p.bairro, cidade: p.cidade, uf: p.uf, cep: p.cep };
}
async function lerPerfil(request, env) {
  const s = await sessaoAtual(request, env);
  if (!s) throw new ErroCliente('Entre na sua conta de novo.');
  const p = await env.DB.prepare('SELECT * FROM clientes WHERE email = ?1').bind(s.email).first();
  return { ok: true, email: s.email, perfil: perfilPublico(p), completo: perfilCompleto(p) };
}
async function salvarPerfil(request, env, ctx) {
  const s = await sessaoAtual(request, env);
  if (!s) throw new ErroCliente('Entre na sua conta de novo para salvar seus dados.');
  const d = await lerCorpo(request);
  const txt = (v, n) => String(v || '').trim().replace(/\s+/g, ' ').slice(0, n);
  const p = {
    nome: txt(d.nome, 120), cpf: soNumeros(d.cpf), telefone: soNumeros(d.telefone), nascimento: txt(d.nascimento, 10),
    cep: soNumeros(d.cep), logradouro: txt(d.logradouro, 160), numero: txt(d.numero, 20), complemento: txt(d.complemento, 80),
    bairro: txt(d.bairro, 80), cidade: txt(d.cidade, 80), uf: txt(d.uf, 2).toUpperCase(),
  };
  if (p.nome.split(' ').length < 2) throw new ErroCliente('Digite seu nome completo (nome e sobrenome).');
  if (!cpfValido(p.cpf)) throw new ErroCliente('Confira o CPF: ele precisa ser válido para emitir a nota fiscal.');
  if (p.telefone.length < 10 || p.telefone.length > 11) throw new ErroCliente('Confira o WhatsApp com DDD.');
  if (p.nascimento && !/^\d{4}-\d{2}-\d{2}$/.test(p.nascimento)) p.nascimento = '';
  if (p.cep.length !== 8) throw new ErroCliente('Confira o CEP (8 números).');
  if (!p.logradouro || !p.numero || !p.bairro || !p.cidade) throw new ErroCliente('Preencha o endereço completo: rua, número, bairro e cidade.');
  if (!UFS.includes(p.uf)) throw new ErroCliente('Confira o estado (UF).');
  const agora = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO clientes (email, criado_em, ultimo_acesso, nome, cpf, telefone, nascimento, cep, logradouro, numero, complemento, bairro, cidade, uf, atualizado_em)
     VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?2)
     ON CONFLICT(email) DO UPDATE SET nome=?3, cpf=?4, telefone=?5, nascimento=?6, cep=?7, logradouro=?8, numero=?9, complemento=?10, bairro=?11, cidade=?12, uf=?13, atualizado_em=?2`
  ).bind(s.email, agora, p.nome, p.cpf, p.telefone, p.nascimento, p.cep, p.logradouro, p.numero, p.complemento, p.bairro, p.cidade, p.uf).run();
  if (typeof d.promocoes === 'boolean') { // caixinha "Autorizo a Hera a me enviar e-mails"
    const antes = await env.DB.prepare('SELECT aceite_promocoes FROM clientes WHERE email = ?1').bind(s.email).first();
    await env.DB.prepare('UPDATE clientes SET aceite_promocoes = ?2 WHERE email = ?1').bind(s.email, d.promocoes ? 1 : 0).run();
    if (d.promocoes) {
      await env.DB.prepare(`INSERT INTO newsletter (email, nome, origem, aceite_em, criado_em, ativo) VALUES (?1, ?2, 'minha conta', ?3, ?3, 1)
        ON CONFLICT(email) DO UPDATE SET ativo = 1, aceite_em = ?3`).bind(s.email, p.nome, agora).run();
      if (!(antes && antes.aceite_promocoes)) paraPlanilha(env, ctx, { aba: 'newsletter', email: s.email, nome: p.nome, origem: 'minha conta' });
    } else {
      await env.DB.prepare('UPDATE newsletter SET ativo = 0 WHERE email = ?1').bind(s.email).run();
    }
    p.promocoes = d.promocoes;
  }
  return { ok: true, mensagem: 'Dados salvos.', perfil: p, completo: true };
}
