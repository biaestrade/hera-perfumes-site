-- Conta com e-mail e senha (a senha só passa a valer depois que a cliente confirma o e-mail pelo link)
ALTER TABLE clientes ADD COLUMN senha_hash TEXT;            -- nunca a senha: só o "hash" (PBKDF2 com sal)
ALTER TABLE clientes ADD COLUMN aceite_termos_em TEXT;      -- quando aceitou a política de compra e privacidade
ALTER TABLE clientes ADD COLUMN aceite_promocoes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE login_links ADD COLUMN senha_hash TEXT;         -- senha escolhida no cadastro, aguardando a confirmação do e-mail
ALTER TABLE login_links ADD COLUMN aceite_promocoes INTEGER;
ALTER TABLE login_links ADD COLUMN nome TEXT;

-- Tentativas de senha errada (para bloquear quem tenta adivinhar)
CREATE TABLE IF NOT EXISTS tentativas_login (
  email TEXT NOT NULL,
  em    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tentativas_login_email ON tentativas_login (email, em);
