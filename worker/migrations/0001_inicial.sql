-- Banco da loja Hera Perfumes (Cloudflare D1)

-- Cupons dos representantes. Os cupons de verdade são cadastrados pelo painel do Cloudflare
-- (D1 > hera-loja > Console), NUNCA aqui, porque este repositório é público.
CREATE TABLE IF NOT EXISTS cupons (
  codigo        TEXT PRIMARY KEY,           -- sempre em MAIÚSCULAS, sem espaços
  representante TEXT NOT NULL,
  desconto_pct  REAL NOT NULL DEFAULT 0,    -- desconto para a cliente, em %
  comissao_pct  REAL NOT NULL DEFAULT 0,    -- comissão do representante, em %
  ativo         INTEGER NOT NULL DEFAULT 1  -- 1 = sim, 0 = não
);

-- Pedidos feitos pelo pagamento online (um por clique em "Pagar agora")
CREATE TABLE IF NOT EXISTS pedidos (
  id                  TEXT PRIMARY KEY,     -- ex.: HERA-20261118-1A2B3C4D (vai para o Mercado Pago como referência)
  criado_em           TEXT NOT NULL,
  modo                TEXT NOT NULL,        -- teste ou producao
  itens               TEXT NOT NULL,        -- lista dos perfumes (JSON)
  subtotal_centavos   INTEGER NOT NULL,
  desconto_centavos   INTEGER NOT NULL,
  frete_centavos      INTEGER NOT NULL DEFAULT 0,
  total_centavos      INTEGER NOT NULL,
  cupom               TEXT,
  representante       TEXT,
  comissao_pct        REAL,
  comissao_centavos   INTEGER,
  status              TEXT NOT NULL DEFAULT 'criado', -- criado, pendente, aprovado, recusado, estornado...
  pagamento_id        TEXT,
  valor_pago_centavos INTEGER,
  pago_em             TEXT,
  atualizado_em       TEXT
);
CREATE INDEX IF NOT EXISTS pedidos_status ON pedidos (status, criado_em);
CREATE INDEX IF NOT EXISTS pedidos_cupom ON pedidos (cupom);

-- 2 cupons de TESTE (troque/desative antes de ir para produção)
INSERT OR IGNORE INTO cupons (codigo, representante, desconto_pct, comissao_pct, ativo) VALUES
  ('TESTE10', 'Representante Teste 1', 10, 5, 1),
  ('TESTE15', 'Representante Teste 2', 15, 8, 1);
