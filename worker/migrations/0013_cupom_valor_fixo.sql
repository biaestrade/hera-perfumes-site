-- Código promocional com desconto em reais (ex.: R$ 20 de desconto). Em centavos; 0 = usa só desconto_pct.
ALTER TABLE cupons ADD COLUMN desconto_centavos INTEGER DEFAULT 0;
