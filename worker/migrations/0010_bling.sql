-- Ligação com o Bling (pedidos de venda e notas fiscais). Nenhum segredo aqui.
-- Tokens que o Bling devolve depois do "Autorizar" (trocam sozinhos a cada renovação)
CREATE TABLE IF NOT EXISTS bling_tokens (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  access_token  TEXT,
  refresh_token TEXT,
  expira_em     TEXT,
  conectado_em  TEXT,   -- só pedidos pagos depois daqui vão para o Bling
  atualizado_em TEXT,
  erro          TEXT    -- preenchido quando a conexão cai (precisa conectar de novo)
);
-- "state" de cada clique em Conectar (proteção do login)
CREATE TABLE IF NOT EXISTS bling_estado (estado TEXT PRIMARY KEY, criado_em TEXT NOT NULL);
-- código do produto no site -> id do produto no Bling
CREATE TABLE IF NOT EXISTS bling_produtos (codigo TEXT PRIMARY KEY, bling_id INTEGER NOT NULL, em TEXT);
-- nomes dos canais de venda do Bling (Mercado Livre etc.)
CREATE TABLE IF NOT EXISTS bling_canais (id INTEGER PRIMARY KEY, nome TEXT);
-- todas as notas de saída (site, Mercado Livre, manuais), para o Painel
CREATE TABLE IF NOT EXISTS bling_notas (
  id INTEGER PRIMARY KEY, numero TEXT, situacao INTEGER, emitida_em TEXT, cliente TEXT, documento TEXT,
  canal TEXT, pedido_site TEXT, pedido_loja TEXT, valor REAL, chave TEXT, link TEXT, atualizado_em TEXT
);
CREATE INDEX IF NOT EXISTS bling_notas_data ON bling_notas (emitida_em);

ALTER TABLE pedidos ADD COLUMN bling_pedido_id INTEGER;
ALTER TABLE pedidos ADD COLUMN bling_nfe_id INTEGER;
ALTER TABLE pedidos ADD COLUMN bling_em TEXT;
ALTER TABLE pedidos ADD COLUMN bling_erro TEXT;
ALTER TABLE pedidos ADD COLUMN bling_tentativas INTEGER DEFAULT 0;
ALTER TABLE pedidos ADD COLUMN nfe_enviada_em TEXT;
ALTER TABLE pedidos ADD COLUMN nfe_numero TEXT;
ALTER TABLE pedidos ADD COLUMN nfe_situacao INTEGER;
ALTER TABLE pedidos ADD COLUMN nfe_chave TEXT;
ALTER TABLE pedidos ADD COLUMN nfe_link TEXT;
ALTER TABLE pedidos ADD COLUMN nfe_atualizada_em TEXT;
