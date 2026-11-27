-- Condições de cada código promocional (validade, se vale em promoções etc.).
-- Aparecem no carrinho, logo abaixo do campo do código, quando a pessoa aplica o código.
ALTER TABLE cupons ADD COLUMN condicoes TEXT;
ALTER TABLE cupons ADD COLUMN valido_ate TEXT; -- data final (AAAA-MM-DD), opcional; depois dela o código para de valer
