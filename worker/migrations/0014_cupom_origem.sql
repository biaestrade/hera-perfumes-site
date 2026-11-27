-- De onde veio o código promocional: 'painel' (sincronizado do hera-cupons.json do Painel da Hera) ou vazio (criado no site).
-- Só os que vieram do Painel são desativados quando somem do arquivo.
ALTER TABLE cupons ADD COLUMN origem TEXT;
