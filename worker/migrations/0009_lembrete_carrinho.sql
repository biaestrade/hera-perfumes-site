-- Lembrete de carrinho abandonado: um e-mail só, 24 horas depois, por versão do carrinho
CREATE TABLE IF NOT EXISTS lembretes (
  email        TEXT NOT NULL,
  carrinho_em  TEXT NOT NULL,   -- atualizado_em do carrinho lembrado (carrinho mexido de novo = pode lembrar de novo)
  enviado_em   TEXT NOT NULL,
  token_hash   TEXT NOT NULL,   -- para o link "não quero receber"
  PRIMARY KEY (email, carrinho_em)
);
CREATE INDEX IF NOT EXISTS lembretes_token ON lembretes (token_hash);
-- quem clicou em "não quero receber esses lembretes"
CREATE TABLE IF NOT EXISTS sem_lembrete (
  email  TEXT PRIMARY KEY,
  em     TEXT NOT NULL
);
