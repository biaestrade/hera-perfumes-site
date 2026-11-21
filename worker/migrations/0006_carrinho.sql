-- Carrinho guardado no servidor (só de quem está conectada na conta), para lembrar a cliente e para o Painel ver carrinhos abandonados
CREATE TABLE IF NOT EXISTS carrinhos (
  email          TEXT PRIMARY KEY,   -- sempre em minúsculas
  itens          TEXT NOT NULL,      -- JSON: [{id, quantidade}]
  cupom          TEXT,
  atualizado_em  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS carrinhos_atualizado ON carrinhos (atualizado_em);
