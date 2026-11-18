# Loja online da Hera: guia passo a passo

Este guia explica, sem termos técnicos, o que foi feito e o que **você** precisa fazer no Mercado Pago e no Cloudflare.
Tudo começa em **modo de teste**: nenhum dinheiro de verdade passa por aqui, e o site no ar não muda enquanto você não aprovar.

---

## 1. Como funciona

```
Cliente no site  ──►  Carrinho ("Minha lista")  ──►  "Pagar agora"
                                                        │
                                   Servidor da Hera (Cloudflare)
                                   • confere os preços na lista oficial (produtos.json)
                                   • confere o código do representante
                                   • calcula os descontos
                                                        │
                                              Mercado Pago (Pix ou cartão)
                                                        │
                      volta para o site: aprovado / pendente / recusado
                                                        │
                   Mercado Pago avisa o servidor ──► venda registrada (com a comissão)
```

- **O pedido pelo WhatsApp continua igual**, como alternativa. Se a cliente digitar um código de representante, ele vai junto na mensagem.
- **Os preços**: o servidor sempre recalcula pelo `produtos.json`. Mesmo que alguém altere o preço no navegador, não adianta nada.
- **Os cupons** ficam no banco de dados do Cloudflare, **não** no GitHub. O repositório do site é público, e qualquer pessoa poderia ver os códigos.

### Onde fica cada coisa

| O quê | Onde | Como trocar |
|---|---|---|
| Perfumes e preços | `produtos.json` | Edite o arquivo (o preço é em reais, ex.: `359.0`) |
| Regras de desconto (5%, se soma com o cupom, frete) | `wrangler.toml`, seção `[vars]` | Edite e publique de novo o servidor |
| Cupons dos representantes | Cloudflare > D1 > `hera-loja` > tabela `cupons` | Pelo painel (veja a seção 5) |
| Vendas e comissões | Cloudflare > D1 > tabela `pedidos` | Baixe a planilha (veja a seção 6) |
| Chaves secretas | Cloudflare > Worker `hera-loja` > Configurações > Variáveis e segredos | Só pelo painel |

---

## 2. Mercado Pago (em modo de teste)

1. Entre em **https://www.mercadopago.com.br/developers** com a conta da Hera.
2. Clique em **Suas integrações** → **Criar aplicação**.
   - Nome: `Hera Perfumes - Site`
   - Tipo de pagamento: **Pagamentos on-line** → **Checkout Pro**
3. Dentro da aplicação, abra **Contas de teste** e crie **duas contas**: uma **Vendedor** e uma **Comprador** (país: Brasil).
   Anote o usuário e a senha de cada uma (o Mercado Pago mostra na tela).
4. Pegue o **Access Token de teste**:
   - Em **Credenciais de teste**, copie o **Access Token**. Ele começa com `TEST-` ou `APP_USR-`.
   - Se o painel pedir, use as credenciais da **conta de teste Vendedor**. O nome dos menus pode mudar um pouco; o importante é que seja a credencial **de teste**.
   - ⚠️ **Não mande essa chave por WhatsApp, e-mail ou chat** (nem para mim). Você vai colar direto no Cloudflare (seção 3, passo 6).
5. Configure o aviso de pagamento (webhook). **Faça este passo depois da seção 3**, porque você vai precisar do endereço do servidor:
   - Na aplicação, abra **Webhooks** → **Configurar notificações** → aba **Modo de teste**.
   - URL: `https://hera-loja.SEU-SUBDOMINIO.workers.dev/api/mp-webhook`
   - Eventos: marque **Pagamentos**.
   - Salve. O Mercado Pago mostra uma **Assinatura secreta**. Copie e cole no Cloudflare como `MP_WEBHOOK_SECRET` (seção 3, passo 6).

---

## 3. Cloudflare (plano gratuito)

1. Crie uma conta grátis em **https://dash.cloudflare.com/sign-up**.
2. Em **Workers e Pages**, escolha um subdomínio (ex.: `heraperfumes`). O endereço de teste vai ficar `https://hera-loja.heraperfumes.workers.dev`.
3. No seu computador é preciso ter o **Node.js** (programa gratuito que o Cloudflare usa para publicar).
4. Na pasta do projeto, rode **um de cada vez** (o Claude pode rodar para você):

   ```powershell
   npm install
   ```
   ```powershell
   npx wrangler login
   ```
   *(abre o navegador: entre na sua conta do Cloudflare e clique em **Allow**)*
   ```powershell
   npx wrangler d1 create hera-loja
   ```
   *(mostra um `database_id`: ele vai no `wrangler.toml`, no lugar de `COLE-AQUI-O-ID-DO-BANCO`)*
   ```powershell
   npm run banco:criar-tabelas
   ```
   ```powershell
   npx wrangler deploy
   ```
   No final, aparece o endereço do servidor: `https://hera-loja.....workers.dev`. Esse é o **site de teste** completo.

5. Abra `https://hera-loja.SEU-SUBDOMINIO.workers.dev/api/saude`. Deve aparecer `"ok": true`.

6. **Cole as chaves secretas (só você faz isto):**
   1. Em **https://dash.cloudflare.com**, abra **Workers e Pages** → **hera-loja**.
   2. Abra **Configurações** (*Settings*) → **Variáveis e segredos** (*Variables and Secrets*) → **Adicionar** (*Add*).
   3. Em **Tipo**, escolha **Segredo** (*Secret*). Não use "Texto", porque o segredo fica escondido até de quem tem acesso ao painel.
   4. Crie os três segredos:

      | Nome (igual, com maiúsculas) | Valor |
      |---|---|
      | `MP_ACCESS_TOKEN` | o Access Token de teste do Mercado Pago |
      | `MP_WEBHOOK_SECRET` | a "Assinatura secreta" dos webhooks (seção 2, passo 5) |
      | `RELATORIO_SENHA` | uma senha forte que você inventar, para baixar a planilha de vendas |

   5. Clique em **Implantar** (*Deploy*) para salvar.
   6. Abra de novo o endereço `/api/saude`. Os três itens devem estar como `true`.

---

## 4. Roteiro de teste (compra de mentira)

Use uma **janela anônima** do navegador (assim você não fica logada na sua conta real do Mercado Pago).

1. Abra o site de teste: `https://hera-loja.SEU-SUBDOMINIO.workers.dev`
2. No catálogo, toque em **+ Lista** em 2 perfumes. Abra a **Minha lista** e aumente a quantidade de um deles para 2.
   Confira que o **subtotal** é a soma do preço de tabela × quantidade.
3. Em **Código do representante**, digite `teste10` e toque em **Aplicar**.
   Deve aparecer *"Código aplicado: 10% de desconto."*, e o total online deve cair 10% em relação ao subtotal.
   Teste também um código errado (ex.: `ABC`): deve aparecer *"Código não encontrado ou inativo."*
4. Toque em **Pagar agora**. Vai abrir o Mercado Pago.
5. Entre com a **conta de teste Comprador** (seção 2, passo 3) e pague com um **cartão de teste**:
   - Cartão Mastercard: `5031 4332 1540 6351`, validade `11/30`, código `123`
   - CPF: `12345678909`
   - **Nome no cartão** decide o resultado:
     - `APRO`: aprovado
     - `CONT`: pendente
     - `OTHE`: recusado
6. Confira se você voltou para a página certa do site (aprovado, pendente ou recusado). No aprovado, o carrinho fica vazio.
7. Baixe a planilha: `https://hera-loja.SEU-SUBDOMINIO.workers.dev/api/relatorio.csv`
   - Usuário: qualquer um (ex.: `hera`). Senha: a sua `RELATORIO_SENHA`.
   - A venda aprovada deve aparecer com o código `TESTE10`, o representante, o valor pago e a **comissão de 5%**.
   - Para ver **todas** as tentativas (inclusive recusadas e pendentes), use `.../api/relatorio.csv?todos=1`.
8. Teste o **WhatsApp**: monte outra lista com o código e toque em **Enviar pelo WhatsApp**. A mensagem deve listar as quantidades e o código.

---

## 5. Cupons dos representantes

Começam 2 cupons de **teste**:

| Código | Representante | Desconto | Comissão |
|---|---|---|---|
| `TESTE10` | Representante Teste 1 | 10% | 5% |
| `TESTE15` | Representante Teste 2 | 15% | 8% |

Para cadastrar ou mudar um cupom: Cloudflare → **Armazenamento e bancos de dados** → **D1** → **hera-loja** → **Console**. Cole um dos comandos abaixo e clique em **Executar**.

Os comandos mais úteis:

```sql
-- novo cupom (código sempre em MAIÚSCULAS e sem espaços)
INSERT INTO cupons (codigo, representante, desconto_pct, comissao_pct, ativo)
VALUES ('MARIA10', 'Maria Souza', 10, 5, 1);

-- mudar desconto ou comissão
UPDATE cupons SET desconto_pct = 8, comissao_pct = 6 WHERE codigo = 'MARIA10';

-- desativar (o código para de funcionar, mas o histórico fica)
UPDATE cupons SET ativo = 0 WHERE codigo = 'MARIA10';

-- ver todos
SELECT * FROM cupons;

-- comissão por representante (só vendas aprovadas)
SELECT representante, COUNT(*) AS vendas, SUM(total_centavos)/100.0 AS vendido, SUM(comissao_centavos)/100.0 AS comissao
FROM pedidos WHERE status = 'aprovado' GROUP BY representante;
```

> Antes de ir para produção, desative os cupons de teste: `UPDATE cupons SET ativo = 0 WHERE codigo LIKE 'TESTE%';`

---

## 6. Regras ainda em aberto (já preparadas)

Tudo fica no `wrangler.toml`, seção `[vars]`. Depois de mudar, publique de novo com `npx wrangler deploy`.

| Decisão | Opção no arquivo | Agora (teste) |
|---|---|---|
| Os 5% valem pagando online? | `DESCONTO_BASE_NO_ONLINE = "sim"` ou `"nao"` | `sim` |
| O cupom soma com os 5%? | `COMBINAR_DESCONTOS = "maior"` (vale o maior) ou `"somar"` (5% + cupom) | `maior` |
| Valor do desconto de cada cupom | tabela `cupons` (seção 5) | 10% e 15% |
| Comissão de cada representante | tabela `cupons` (seção 5) | 5% e 8% |
| Frete no pagamento online | `FRETE_CENTAVOS` (ex.: `"2500"` = R$ 25,00) | `0` (sem frete) |
| Estoque | campo `estoque` em cada perfume do `produtos.json` (o servidor já lê, mas ainda não bloqueia) | desligado |

Como a comissão é calculada: **% do representante × valor dos perfumes já com desconto** (sem o frete).

Para tirar um perfume da venda online sem apagá-lo, coloque `"ativo": false` nele no `produtos.json`.

---

## 7. Para ir para produção (só com a sua aprovação)

Ainda **não** faça isto. É o roteiro para quando os testes estiverem ok:

1. No Mercado Pago, pegue o **Access Token de produção** da conta real da Hera e troque o segredo `MP_ACCESS_TOKEN` no Cloudflare.
2. Configure o webhook na aba **Modo produtivo** e troque o segredo `MP_WEBHOOK_SECRET`.
3. No `wrangler.toml`:
   `MODO = "producao"`, `SITE_URL = "https://heraevodiaperfumes.com.br"`, `PRODUTOS_URL = "https://heraevodiaperfumes.com.br/produtos.json"`. Depois publique com `npx wrangler deploy`.
4. No `index.html`, preencha `var API_LOJA = 'https://hera-loja.SEU-SUBDOMINIO.workers.dev';`.
   **Enquanto essa linha estiver vazia, o site oficial não mostra o botão "Pagar agora"**: continua só com o WhatsApp.
5. Desative os cupons de teste e cadastre os reais.
6. Aprove o Pull Request no GitHub (é isso que publica o site).
7. Faça uma compra real de valor baixo e confira na planilha.
