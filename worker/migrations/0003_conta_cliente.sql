-- Conta da cliente: login por link no e-mail (sem senha) e acompanhamento do pedido

-- Clientes que já entraram na conta
CREATE TABLE IF NOT EXISTS clientes (
  email          TEXT PRIMARY KEY,   -- sempre em minúsculas
  criado_em      TEXT NOT NULL,
  ultimo_acesso  TEXT
);

-- Links de entrada enviados por e-mail (valem 20 minutos, uma vez só). Guardamos só o "hash", nunca o link.
CREATE TABLE IF NOT EXISTS login_links (
  hash       TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  criado_em  TEXT NOT NULL,
  expira_em  TEXT NOT NULL,
  usado_em   TEXT
);
CREATE INDEX IF NOT EXISTS login_links_email ON login_links (email, criado_em);

-- Sessões abertas (a cliente fica conectada por 30 dias naquele aparelho)
CREATE TABLE IF NOT EXISTS sessoes (
  hash       TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  criado_em  TEXT NOT NULL,
  expira_em  TEXT NOT NULL
);

-- Pedido: de quem é e em que pé está a entrega
ALTER TABLE pedidos ADD COLUMN email_cliente TEXT;
ALTER TABLE pedidos ADD COLUMN status_envio TEXT NOT NULL DEFAULT 'aguardando'; -- aguardando, separando, enviado, entregue
ALTER TABLE pedidos ADD COLUMN transportadora TEXT;
ALTER TABLE pedidos ADD COLUMN rastreio_codigo TEXT;
ALTER TABLE pedidos ADD COLUMN rastreio_url TEXT;
ALTER TABLE pedidos ADD COLUMN nota_fiscal_url TEXT;
ALTER TABLE pedidos ADD COLUMN enviado_em TEXT;
ALTER TABLE pedidos ADD COLUMN entregue_em TEXT;
CREATE INDEX IF NOT EXISTS pedidos_email ON pedidos (email_cliente, criado_em);
