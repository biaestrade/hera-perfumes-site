/**
 * Hera Perfumes — recebe os e-mails do site e grava na planilha
 * Planilha: "Hera Perfumes — E-mails (newsletter e clientes)", abas "Newsletter" e "Clientes".
 *
 * Como instalar (uma vez só):
 * 1. Abra script.google.com > Novo projeto (ou, na planilha, Extensões > Apps Script). Apague o que estiver lá e cole este arquivo inteiro.
 * 2. Troque COLE_AQUI_O_SEGREDO pela senha combinada (a mesma do segredo PLANILHA_SEGREDO no Cloudflare).
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

// evita que um texto vire fórmula na planilha
function limpa(v) { v = String(v).slice(0, 120); return /^[=+\-@]/.test(v) ? "'" + v : v; }
function saida(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
