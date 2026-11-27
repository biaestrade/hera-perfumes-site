/**
 * Ligação da loja com o Bling (API v3): pedido pago no site -> pedido de venda no Bling -> NF-e -> e-mail para a cliente.
 *
 * Segredos (ficam SÓ no painel do Cloudflare, nunca neste arquivo):
 *   BLING_CLIENT_ID      "Client ID" do aplicativo criado no Bling (Cadastro de aplicativos)
 *   BLING_CLIENT_SECRET  "Client Secret" do mesmo aplicativo
 *
 * Os tokens de acesso que o Bling devolve depois do "Autorizar" ficam no banco D1 (tabela bling_tokens),
 * porque o Bling troca o token a cada renovação e o servidor precisa guardar o novo sozinho.
 *
 * Regras em wrangler.toml [vars]:
 *   BLING_EMITIR_NFE   "1" = gera e envia a NF-e sozinho depois que o pedido entra no Bling; "0" = só lança o pedido
 *   BLING_NCM          NCM dos perfumes (o contador confirma), usado ao cadastrar o produto no Bling
 *   BLING_FORMA_PIX / BLING_FORMA_CARTAO   (opcional) ID da forma de pagamento no Bling
 */

const API_PADRAO = 'https://api.bling.com.br/Api/v3';
const base = env => env.BLING_API_URL || API_PADRAO; // BLING_API_URL só para teste local com um Bling de mentira
const AUTORIZAR = 'https://www.bling.com.br/Api/v3/oauth/authorize';
const ESPERA_MS = 380; // o Bling aceita 3 chamadas por segundo
const SITUACAO_NFE = { 1: 'Pendente', 2: 'Cancelada', 3: 'Aguardando recibo', 4: 'Rejeitada', 5: 'Autorizada', 6: 'Emitida', 7: 'Registrada', 8: 'Aguardando protocolo', 9: 'Denegada', 10: 'Consultando', 11: 'Bloqueada' };
const NFE_FINAL = new Set([2, 5, 6, 7, 9]); // situações em que não adianta mais consultar
const dorme = ms => new Promise(r => setTimeout(r, ms));
const agoraIso = () => new Date().toISOString();

export function blingConfigurado(env) { return !!(env.BLING_CLIENT_ID && env.BLING_CLIENT_SECRET && env.DB); }
export function nomeSituacaoNfe(s) { return SITUACAO_NFE[s] || (s ? `Situação ${s}` : ''); }

function basico(env) { return 'Basic ' + btoa(`${env.BLING_CLIENT_ID}:${env.BLING_CLIENT_SECRET}`); }
function retornoUrl(env, origem) { return `${(env.LOJA_URL || origem).replace(/\/+$/, '')}/api/bling/retorno`; }

// ---------- conexão (OAuth) ----------

export async function linkConectar(env) {
  const estado = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO bling_estado (estado, criado_em) VALUES (?1, ?2)').bind(estado, agoraIso()).run();
  await env.DB.prepare('DELETE FROM bling_estado WHERE criado_em < ?1').bind(new Date(Date.now() - 3600_000).toISOString()).run();
  return `${AUTORIZAR}?response_type=code&client_id=${encodeURIComponent(env.BLING_CLIENT_ID)}&state=${estado}`;
}

export async function retornoBling(url, env) {
  const code = url.searchParams.get('code'), estado = url.searchParams.get('state');
  const pagina = (titulo, texto, ok) => new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${titulo}</title>
     <body style="font-family:system-ui,sans-serif;max-width:520px;margin:60px auto;padding:0 20px;color:#3b0b18">
     <h1 style="font-weight:500">${ok ? '✅' : '⚠️'} ${titulo}</h1><p style="font-size:17px;line-height:1.5">${texto}</p>
     <p><a href="/admin" style="color:#88072b">Voltar ao painel da loja</a></p></body>`,
    { status: ok ? 200 : 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  if (!blingConfigurado(env)) return pagina('Bling ainda não configurado', 'Faltam os segredos BLING_CLIENT_ID e BLING_CLIENT_SECRET no Cloudflare.', false);
  if (!code || !estado) return pagina('Autorização cancelada', 'O Bling não mandou a autorização. Tente de novo pelo painel da loja.', false);
  const ok = await env.DB.prepare('DELETE FROM bling_estado WHERE estado = ?1').bind(estado).run();
  if (!ok.meta || !ok.meta.changes) return pagina('Link vencido', 'Este link de autorização já foi usado ou venceu. Clique de novo em "Conectar Bling" no painel da loja.', false);
  const r = await fetch(`${base(env)}/oauth/token`, {
    method: 'POST',
    headers: { Authorization: basico(env), 'Content-Type': 'application/x-www-form-urlencoded', Accept: '1.0' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code }).toString(),
  });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.access_token) return pagina('Não deu certo', 'O Bling recusou a autorização (' + (t.error && (t.error.description || t.error.message) || r.status) + '). Tente de novo em 1 minuto.', false);
  await guardarTokens(env, t, true);
  return pagina('Bling conectado!', 'A partir de agora, cada pedido pago no site vai sozinho para o Bling' + (env.BLING_EMITIR_NFE === '1' ? ', a nota fiscal é emitida e enviada por e-mail para a cliente.' : '. A emissão automática da nota ainda está desligada (BLING_EMITIR_NFE).'), true);
}

async function guardarTokens(env, t, primeiraVez) {
  const expira = new Date(Date.now() + (Number(t.expires_in || 21600) - 120) * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO bling_tokens (id, access_token, refresh_token, expira_em, conectado_em, atualizado_em, erro)
     VALUES (1, ?1, ?2, ?3, ?4, ?4, NULL)
     ON CONFLICT(id) DO UPDATE SET access_token = ?1, refresh_token = ?2, expira_em = ?3, atualizado_em = ?4, erro = NULL,
       conectado_em = CASE WHEN ?5 = 1 THEN ?4 ELSE bling_tokens.conectado_em END`
  ).bind(t.access_token, t.refresh_token, expira, agoraIso(), primeiraVez ? 1 : 0).run();
}

async function tokenAtual(env) {
  const t = await env.DB.prepare('SELECT * FROM bling_tokens WHERE id = 1').first();
  if (!t || !t.refresh_token) throw new ErroBling('Bling não conectado. Clique em "Conectar Bling" no painel da loja.', true);
  if (t.expira_em > agoraIso()) return t.access_token;
  const r = await fetch(`${base(env)}/oauth/token`, {
    method: 'POST',
    headers: { Authorization: basico(env), 'Content-Type': 'application/x-www-form-urlencoded', Accept: '1.0' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token }).toString(),
  });
  const n = await r.json().catch(() => ({}));
  if (!r.ok || !n.access_token) {
    const msg = 'O Bling desconectou (' + (n.error && (n.error.description || n.error.type) || r.status) + '). Clique em "Conectar Bling" no painel da loja.';
    await env.DB.prepare('UPDATE bling_tokens SET erro = ?1, atualizado_em = ?2 WHERE id = 1').bind(msg, agoraIso()).run();
    throw new ErroBling(msg, true);
  }
  await guardarTokens(env, n, false);
  return n.access_token;
}

export class ErroBling extends Error { constructor(m, conexao) { super(m); this.conexao = !!conexao; } }

async function bling(env, metodo, caminho, corpo) {
  const token = await tokenAtual(env);
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    await dorme(ESPERA_MS);
    const r = await fetch(base(env) + caminho, {
      method: metodo,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(corpo ? { 'Content-Type': 'application/json' } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    if (r.status === 429) { await dorme(1500 * (tentativa + 1)); continue; }
    const texto = await r.text();
    let j = {}; try { j = texto ? JSON.parse(texto) : {}; } catch (e) { j = { bruto: texto.slice(0, 300) }; }
    if (!r.ok) {
      const e = j.error || {};
      const campos = (e.fields || []).map(f => f.msg || f.element).filter(Boolean).join('; ');
      throw new ErroBling(`Bling ${metodo} ${caminho.split('?')[0]}: ${e.description || e.message || r.status}${campos ? ' — ' + campos : ''}`, r.status === 401);
    }
    return j;
  }
  throw new ErroBling('O Bling pediu para esperar (muitas chamadas). Tento de novo na próxima rodada.');
}

// ---------- cadastros (cliente e produto) ----------

const so = v => String(v || '').replace(/\D/g, '');

async function contatoDoPedido(env, ent, cliente, email) {
  const cpf = so(ent.cpf || (cliente && cliente.cpf));
  if (cpf.length !== 11) throw new ErroBling('Pedido sem CPF válido (a nota precisa do CPF da cliente).');
  const end = {
    endereco: ent.logradouro || (cliente && cliente.logradouro) || '',
    numero: String(ent.numero || (cliente && cliente.numero) || 'S/N'),
    complemento: ent.complemento || (cliente && cliente.complemento) || '',
    bairro: ent.bairro || (cliente && cliente.bairro) || '',
    cep: so(ent.cep || (cliente && cliente.cep)),
    municipio: ent.cidade || (cliente && cliente.cidade) || '',
    uf: String(ent.uf || (cliente && cliente.uf) || '').toUpperCase(),
  };
  if (!end.endereco || !end.cep || !end.municipio || !end.uf) throw new ErroBling('Pedido sem endereço completo para a nota.');
  const dados = {
    nome: ent.nome || (cliente && cliente.nome) || 'Cliente', tipo: 'F', situacao: 'A', numeroDocumento: cpf,
    indicadorIe: 9, email: email || '', emailNotaFiscal: email || '', celular: so(ent.telefone || (cliente && cliente.telefone)),
    endereco: { geral: end },
  };
  const achou = await bling(env, 'GET', `/contatos?numeroDocumento=${cpf}&limite=1`);
  const existente = achou.data && achou.data[0];
  if (existente) {
    // atualiza endereço e e-mail (a cliente pode ter mudado) — mantém o mesmo cadastro
    await bling(env, 'PUT', `/contatos/${existente.id}`, dados).catch(e => console.error('bling atualizar contato', e.message));
    return { id: existente.id, ...dados };
  }
  const novo = await bling(env, 'POST', '/contatos', dados);
  return { id: novo.data.id, ...dados };
}

// NCM por concentração (decidido em 27/11/2026): Eau de Toilette / Eau de Cologne = águas-de-colônia;
// Parfum, Elixir, Eau de Parfum e kits = perfumes (extratos). BLING_NCM continua valendo como reserva.
function ncmDoProduto(env, of, item) {
  const texto = `${of.conc || ''} ${of.titulo || item.titulo || ''}`;
  if (of.tipo !== 'cofre' && /toilette|cologne|col[oô]nia/i.test(texto)) return so(env.BLING_NCM_COLONIA) || so(env.BLING_NCM);
  return so(env.BLING_NCM_PERFUME) || so(env.BLING_NCM);
}

async function produtoNoBling(env, item, oficiais) {
  const codigo = String(item.id).slice(0, 60);
  const cache = await env.DB.prepare('SELECT bling_id FROM bling_produtos WHERE codigo = ?1').bind(codigo).first();
  if (cache) return cache.bling_id;
  const achou = await bling(env, 'GET', `/produtos?codigos[]=${encodeURIComponent(codigo)}&limite=1`);
  let id = achou.data && achou.data[0] && achou.data[0].id;
  if (!id) {
    const of = oficiais.get(item.id) || {};
    const criado = await bling(env, 'POST', '/produtos', {
      nome: (of.titulo || item.titulo || codigo).slice(0, 120), codigo, tipo: 'P', situacao: 'A', formato: 'S',
      preco: (of.precoCentavos || item.unitario_centavos || 0) / 100, unidade: 'UN', condicao: 1,
      marca: of.marca || '', pesoBruto: of.pesoKg || 0.5, pesoLiquido: of.pesoKg || 0.4,
      tributacao: { origem: Number(env.BLING_ORIGEM || 0), ...(ncmDoProduto(env, of, item) ? { ncm: ncmDoProduto(env, of, item) } : {}) },
    });
    id = criado.data.id;
  }
  await env.DB.prepare('INSERT OR REPLACE INTO bling_produtos (codigo, bling_id, em) VALUES (?1, ?2, ?3)').bind(codigo, id, agoraIso()).run();
  return id;
}

// ---------- pedido -> Bling -> nota ----------

export async function enviarPedidoBling(env, pedidoId, oficiais) {
  const p = await env.DB.prepare('SELECT * FROM pedidos WHERE id = ?1').bind(pedidoId).first();
  if (!p || !String(p.status).startsWith('aprovado')) return null;
  // pedido só com produto de teste: nunca vai para o Bling (não emite nota)
  let itensTeste = []; try { itensTeste = JSON.parse(p.itens || '[]'); } catch (e) {}
  // pedidos feitos em modo de teste (Mercado Pago de teste) também nunca vão para o Bling
  if (p.modo === 'teste' || (itensTeste.length && itensTeste.every(i => String(i.id).startsWith('teste-')))) {
    await env.DB.prepare('UPDATE pedidos SET bling_tentativas = 99 WHERE id = ?1').bind(p.id).run();
    return null;
  }
  try {
    let blingId = p.bling_pedido_id;
    if (!blingId) {
      // já existe? (evita pedido em dobro se a rodada anterior caiu no meio)
      const ja = await bling(env, 'GET', `/pedidos/vendas?numerosLojas[]=${encodeURIComponent(p.id)}&limite=1`);
      blingId = ja.data && ja.data[0] && ja.data[0].id;
    }
    if (!blingId) {
      let ent = {}; try { ent = JSON.parse(p.entrega || '{}'); } catch (e) {}
      const cliente = p.email_cliente ? await env.DB.prepare('SELECT * FROM clientes WHERE email = ?1').bind(p.email_cliente).first() : null;
      const contato = await contatoDoPedido(env, ent, cliente, p.email_cliente);
      let itens = []; try { itens = JSON.parse(p.itens || '[]'); } catch (e) {}
      const linhas = [];
      for (const i of itens) {
        const produtoId = await produtoNoBling(env, i, oficiais);
        linhas.push({ codigo: String(i.id).slice(0, 60), descricao: (i.titulo || (oficiais.get(i.id) || {}).titulo || i.id).slice(0, 120), unidade: 'UN', quantidade: i.quantidade, valor: (i.unitario_centavos || 0) / 100, produto: { id: produtoId } });
      }
      const somaItens = itens.reduce((s, i) => s + (i.unitario_centavos || 0) * i.quantidade, 0);
      const diferenca = somaItens + (p.frete_centavos || 0) - (p.total_centavos || 0); // arredondamento de cupom/Pix
      const data = (p.pago_em || p.criado_em || agoraIso()).slice(0, 10);
      const formaId = Number(ent.pagamento === 'Pix' ? env.BLING_FORMA_PIX : env.BLING_FORMA_CARTAO) || 0;
      const corpo = {
        numeroLoja: p.id, data, dataSaida: data, contato: { id: contato.id },
        itens: linhas,
        ...(diferenca > 0 ? { desconto: { valor: diferenca / 100, unidade: 'REAL' } } : {}),
        ...(diferenca < 0 ? { outrasDespesas: -diferenca / 100 } : {}),
        parcelas: [{ dataVencimento: data, valor: (p.total_centavos || 0) / 100, observacoes: `${ent.pagamento || 'Mercado Pago'} — pagamento ${p.pagamento_id || ''}`.trim(), ...(formaId ? { formaPagamento: { id: formaId } } : {}) }],
        transporte: {
          fretePorConta: 0, frete: (p.frete_centavos || 0) / 100, quantidadeVolumes: 1,
          ...(ent.prazo_dias ? { prazoEntrega: Number(ent.prazo_dias) } : {}),
          etiqueta: { nome: contato.nome, ...contato.endereco.geral },
        },
        observacoes: `Pedido ${p.id} do site Hera Perfumes${ent.envio ? ' · envio ' + ent.envio : ''}`,
        observacoesInternas: `Pagamento Mercado Pago ${p.pagamento_id || ''} · ${ent.pagamento || ''}${p.cupom ? ' · cupom ' + p.cupom : ''}`,
      };
      const criado = await bling(env, 'POST', '/pedidos/vendas', corpo);
      blingId = criado.data.id;
    }
    await env.DB.prepare('UPDATE pedidos SET bling_pedido_id = ?2, bling_em = COALESCE(bling_em, ?3), bling_erro = NULL WHERE id = ?1').bind(p.id, blingId, agoraIso()).run();

    if (env.BLING_EMITIR_NFE === '1' && so(env.BLING_NCM)) { // sem NCM a SEFAZ recusa: só lança o pedido
      let nfeId = p.bling_nfe_id;
      if (!nfeId) {
        const g = await bling(env, 'POST', `/pedidos/vendas/${blingId}/gerar-nfe`);
        nfeId = g.data && (g.data.idNotaFiscal || g.data.id);
        await env.DB.prepare('UPDATE pedidos SET bling_nfe_id = ?2 WHERE id = ?1').bind(p.id, nfeId).run();
      }
      if (nfeId && !p.nfe_enviada_em) {
        await bling(env, 'POST', `/nfe/${nfeId}/enviar?enviarEmail=true`);
        await env.DB.prepare('UPDATE pedidos SET nfe_enviada_em = ?2 WHERE id = ?1').bind(p.id, agoraIso()).run();
      }
      if (nfeId) await atualizarNotaDoPedido(env, p.id, nfeId);
    }
    return blingId;
  } catch (e) {
    await env.DB.prepare('UPDATE pedidos SET bling_erro = ?2, bling_tentativas = COALESCE(bling_tentativas, 0) + 1, bling_em = COALESCE(bling_em, ?3) WHERE id = ?1')
      .bind(p.id, String(e.message || e).slice(0, 500), agoraIso()).run();
    throw e;
  }
}

async function atualizarNotaDoPedido(env, pedidoId, nfeId) {
  const n = (await bling(env, 'GET', `/nfe/${nfeId}`)).data || {};
  const link = n.linkDanfe || n.linkPDF || null;
  await env.DB.prepare(
    `UPDATE pedidos SET nfe_numero = ?2, nfe_situacao = ?3, nfe_chave = ?4, nfe_link = ?5,
       nota_fiscal_url = COALESCE(?5, nota_fiscal_url), nfe_atualizada_em = ?6 WHERE id = ?1`
  ).bind(pedidoId, n.numero || null, n.situacao || null, n.chaveAcesso || null, link, agoraIso()).run();
  return n;
}

// ---------- rodada do cron (a cada 30 min) ----------

export async function rodadaBling(env, oficiais) {
  if (!blingConfigurado(env)) return { ok: false, motivo: 'não configurado' };
  const t = await env.DB.prepare('SELECT conectado_em, erro FROM bling_tokens WHERE id = 1').first();
  if (!t || t.erro) return { ok: false, motivo: t ? t.erro : 'não conectado' };
  const resumo = { enviados: 0, erros: 0, notas: 0 };

  // 1) pedidos pagos depois da conexão que ainda não foram (ou deram erro, até 8 tentativas)
  const pend = (await env.DB.prepare(
    `SELECT id FROM pedidos WHERE status LIKE 'aprovado%' AND COALESCE(pago_em, criado_em) >= ?1
       AND (bling_pedido_id IS NULL OR (?2 = '1' AND (bling_nfe_id IS NULL OR nfe_enviada_em IS NULL)))
       AND COALESCE(bling_tentativas, 0) < 8
     ORDER BY criado_em LIMIT 10`
  ).bind(t.conectado_em, (env.BLING_EMITIR_NFE === '1' && so(env.BLING_NCM)) ? '1' : '0').all()).results || [];
  for (const r of pend) {
    try { await enviarPedidoBling(env, r.id, oficiais); resumo.enviados++; }
    catch (e) { resumo.erros++; console.error('bling pedido', r.id, e.message); if (e.conexao) return resumo; }
  }

  // 2) notas do site ainda sem resultado final (aguardando SEFAZ etc.)
  const abertas = (await env.DB.prepare(
    `SELECT id, bling_nfe_id FROM pedidos WHERE bling_nfe_id IS NOT NULL AND (nfe_situacao IS NULL OR nfe_situacao NOT IN (2,5,6,7,9)) LIMIT 15`
  ).all()).results || [];
  for (const r of abertas) { try { await atualizarNotaDoPedido(env, r.id, r.bling_nfe_id); } catch (e) { console.error('bling nota', r.id, e.message); } }

  // 3) todas as notas de saída dos últimos 45 dias (site + Mercado Livre + manuais) para o Painel
  try { resumo.notas = await sincronizarNotas(env); } catch (e) { console.error('bling notas', e.message); }
  return resumo;
}

async function nomeDoCanal(env, lojaId) {
  if (!lojaId) return '';
  const c = await env.DB.prepare('SELECT nome FROM bling_canais WHERE id = ?1').bind(lojaId).first();
  if (c) return c.nome;
  let nome = 'Loja ' + lojaId;
  try {
    const j = (await bling(env, 'GET', `/canais-venda/${lojaId}`)).data || {};
    nome = j.descricao || j.nome || nome;
    if (/mercado\s*livre/i.test(String(j.tipo || '') + ' ' + nome)) nome = 'Mercado Livre';
  } catch (e) { /* mantém o nome genérico */ }
  await env.DB.prepare('INSERT OR REPLACE INTO bling_canais (id, nome) VALUES (?1, ?2)').bind(lojaId, nome).run();
  return nome;
}

async function sincronizarNotas(env) {
  const ini = new Date(Date.now() - 45 * 86400_000).toISOString().slice(0, 10);
  const fim = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
  const doSite = new Map(((await env.DB.prepare('SELECT id, bling_nfe_id FROM pedidos WHERE bling_nfe_id IS NOT NULL').all()).results || []).map(r => [Number(r.bling_nfe_id), r.id]));
  let total = 0;
  for (let pagina = 1; pagina <= 5; pagina++) {
    const lista = (await bling(env, 'GET', `/nfe?tipo=1&dataEmissaoInicial=${ini}&dataEmissaoFinal=${fim}&pagina=${pagina}&limite=100`)).data || [];
    for (const n of lista) {
      const pedidoSite = doSite.get(Number(n.id)) || null;
      const canal = pedidoSite ? 'Site' : (await nomeDoCanal(env, n.loja && n.loja.id)) || 'Bling (manual)';
      const antes = await env.DB.prepare('SELECT situacao, link FROM bling_notas WHERE id = ?1').bind(n.id).first();
      let link = antes && antes.link;
      // o link do PDF só vem no detalhe da nota: busca uma vez quando ela é autorizada
      if (!link && [5, 6, 7].includes(Number(n.situacao))) {
        try { const d = (await bling(env, 'GET', `/nfe/${n.id}`)).data || {}; link = d.linkDanfe || d.linkPDF || null; n.valorNota = d.valorNota; n.numeroPedidoLoja = d.numeroPedidoLoja; } catch (e) {}
      }
      await env.DB.prepare(
        `INSERT INTO bling_notas (id, numero, situacao, emitida_em, cliente, documento, canal, pedido_site, pedido_loja, valor, chave, link, atualizado_em)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(id) DO UPDATE SET numero = ?2, situacao = ?3, emitida_em = ?4, cliente = ?5, documento = ?6, canal = ?7,
           pedido_site = ?8, pedido_loja = COALESCE(?9, bling_notas.pedido_loja), valor = COALESCE(?10, bling_notas.valor),
           chave = ?11, link = COALESCE(?12, bling_notas.link), atualizado_em = ?13`
      ).bind(n.id, n.numero || '', n.situacao || null, n.dataEmissao || '', (n.contato && n.contato.nome) || '', (n.contato && n.contato.numeroDocumento) || '',
        canal, pedidoSite, n.numeroPedidoLoja || null, n.valorNota != null ? n.valorNota : null, n.chaveAcesso || '', link || null, agoraIso()).run();
      total++;
    }
    if (lista.length < 100) break;
  }
  return total;
}

// ---------- o que vai para o Painel ----------

export async function notasParaPainel(env) {
  if (!env.DB) return { conectado: false, notas: [] };
  const t = await env.DB.prepare('SELECT conectado_em, erro, atualizado_em FROM bling_tokens WHERE id = 1').first().catch(() => null);
  const notas = (await env.DB.prepare('SELECT * FROM bling_notas ORDER BY emitida_em DESC LIMIT 300').all().catch(() => ({ results: [] }))).results || [];
  const erros = (await env.DB.prepare(`SELECT id, bling_erro, bling_tentativas FROM pedidos WHERE bling_erro IS NOT NULL ORDER BY criado_em DESC LIMIT 30`).all().catch(() => ({ results: [] }))).results || [];
  return {
    conectado: !!(t && !t.erro), conectado_em: t ? t.conectado_em : '', aviso: t && t.erro ? t.erro : '',
    emissao_automatica: env.BLING_EMITIR_NFE === '1',
    notas: notas.map(n => ({ nota: n.numero, situacao: nomeSituacaoNfe(n.situacao), emitida_em: n.emitida_em, canal: n.canal, cliente: n.cliente, pedido: n.pedido_site || n.pedido_loja || '', valor: n.valor, link: n.link || '' })),
    erros: erros.map(e => ({ pedido: e.id, erro: e.bling_erro, tentativas: e.bling_tentativas })),
  };
}

export async function statusBling(env) {
  const t = blingConfigurado(env) ? await env.DB.prepare('SELECT conectado_em, expira_em, erro, atualizado_em FROM bling_tokens WHERE id = 1').first() : null;
  return { configurado: blingConfigurado(env), conectado: !!(t && !t.erro), conectado_em: t && t.conectado_em, aviso: t && t.erro, emissao_automatica: env.BLING_EMITIR_NFE === '1', ncm: env.BLING_NCM || '' };
}
