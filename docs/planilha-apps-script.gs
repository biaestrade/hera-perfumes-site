/**
 * Hera Perfumes — recebe os e-mails do site e grava na planilha
 * Planilha: "Hera Perfumes — E-mails (newsletter e clientes)", abas "Newsletter" e "Clientes".
 * Vendas pagas vão para outra planilha, "Hera Perfumes — Vendas do site" (o Painel da Hera lê dela).
 *
 * Como instalar (uma vez só):
 * 1. Abra script.google.com > Novo projeto (ou, na planilha, Extensões > Apps Script). Apague o que estiver lá e cole este arquivo inteiro.
 * 2. Na linha da constante SEGREDO (logo abaixo deste comentário), troque o texto entre aspas pela senha da planilha (a mesma do segredo PLANILHA_SEGREDO no Cloudflare).
 * 3. Salve. Clique em Implantar > Nova implantação > tipo "App da Web".
 *    Executar como: Eu. Quem pode acessar: Qualquer pessoa. Implantar e autorizar.
 * 4. Copie o "URL do app da Web" e cole no Cloudflare como segredo PLANILHA_URL.
 */
const SEGREDO = 'COLE_AQUI_O_SEGREDO';
// id da planilha (o trecho do endereço entre /d/ e /edit); assim o script funciona também fora da planilha
const PLANILHA_ID = '1OAMdJe0iYFT7pkftfj-2G8dT2qQpRbnDLYBDZWdSlc0';

function doPost(e) {
  let d = {};
  try { d = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { return saida({ ok: false }); }
  if (!SEGREDO || SEGREDO === 'COLE_AQUI_O_SEGREDO' || d.segredo !== SEGREDO) return saida({ ok: false });

  if (d.aba === 'vendas') return saida({ ok: gravaVenda(d) });
  if (d.aba === 'painel') return saida({ ok: gravaDadosPainel(d.dados) });

  const clientes = d.aba === 'clientes';
  const aba = SpreadsheetApp.openById(PLANILHA_ID).getSheetByName(clientes ? 'Clientes' : 'Newsletter');
  const email = limpa(String(d.email || '').trim().toLowerCase());
  if (!aba || !email || email.indexOf('@') < 1) return saida({ ok: false });

  const trava = LockService.getScriptLock();
  trava.waitLock(10000);
  try {
    const colunaEmail = clientes ? 2 : 3;
    const n = aba.getLastRow() - 1;
    const existentes = n > 0 ? aba.getRange(2, colunaEmail, n, 1).getValues().map(function (l) { return String(l[0]).toLowerCase(); }) : [];
    if (existentes.indexOf(email) < 0) {
      aba.appendRow(clientes
        ? [new Date(), email, limpa(d.origem || 'site')]
        : [new Date(), limpa(d.nome || ''), email, limpa(d.origem || 'site'), 'Sim']);
    }
  } finally { trava.releaseLock(); }
  return saida({ ok: true });
}

// Uma linha por pedido pago (não repete o mesmo pedido), na planilha "Hera Perfumes — Vendas do site" (o Painel lê a 1ª aba dela).
const VENDAS_ID = '1V5ZviIA3tjKOaM8Ti6WgDqloN3e9PMl7fBruieI02t4';
const VENDAS_CABECALHO = ['Recebido em', 'Pedido', 'Data do pagamento', 'Modo', 'Situação', 'Cliente', 'WhatsApp', 'E-mail',
  'Itens (resumo)', 'Subtotal', 'Desconto', 'Frete', 'Total pago', 'Cupom', 'Representante', 'Comissão', 'Itens (dados)'];
function gravaVenda(d) {
  const pedido = limpa(String(d.pedido || '').trim());
  if (!pedido) return false;
  const trava = LockService.getScriptLock();
  trava.waitLock(10000);
  try {
    const aba = SpreadsheetApp.openById(VENDAS_ID).getSheets()[0];
    if (aba.getLastRow() < 1) aba.appendRow(VENDAS_CABECALHO);
    const n = aba.getLastRow() - 1;
    const existentes = n > 0 ? aba.getRange(2, 2, n, 1).getValues().map(function (l) { return String(l[0]); }) : [];
    if (existentes.indexOf(pedido) >= 0) return true;
    const itens = Array.isArray(d.itens) ? d.itens.slice(0, 50) : [];
    const resumo = itens.map(function (i) { return (Number(i.qtd) || 1) + 'x ' + String(i.nome || ''); }).join(' | ');
    const valor = function (v) { return Number(v) || 0; };
    aba.appendRow([new Date(), pedido, limpa(d.data || ''), limpa(d.modo || ''), limpa(d.situacao || ''), limpa(d.nome || ''),
      limpa(d.telefone || ''), limpa(d.email || ''), limpa(resumo), valor(d.subtotal), valor(d.desconto), valor(d.frete),
      valor(d.total), limpa(d.cupom || ''), limpa(d.representante || ''), valor(d.comissao), JSON.stringify(itens).slice(0, 45000)]);
    return true;
  } finally { trava.releaseLock(); }
}

// Arquivo hera-site-dados.json no Drive (o Painel da Hera lê): o site manda de 30 em 30 minutos
const DADOS_PAINEL_ID = '1kzgphlvfNi6w1vSIj74eHS4bX8OiqDHV';
function gravaDadosPainel(dados) {
  if (!dados || typeof dados !== 'object') return false;
  DriveApp.getFileById(DADOS_PAINEL_ID).setContent(JSON.stringify(dados));
  return true;
}

// evita que um texto vire fórmula na planilha
function limpa(v) { v = String(v).slice(0, 120); return /^[=+\-@]/.test(v) ? "'" + v : v; }
function saida(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
