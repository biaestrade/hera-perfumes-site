-- Cadastros da newsletter ("Receba nossas promoções")
CREATE TABLE IF NOT EXISTS newsletter (
  email        TEXT PRIMARY KEY,          -- sempre em minúsculas
  nome         TEXT,
  origem       TEXT,                      -- de onde veio o cadastro (ex.: popup)
  aceite_em    TEXT NOT NULL,             -- data do aceite da política de privacidade
  criado_em    TEXT NOT NULL,
  ativo        INTEGER NOT NULL DEFAULT 1 -- 0 = pediu para sair
);
