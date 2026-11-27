-- E-mails automáticos novos: cada um sai uma vez só
ALTER TABLE pedidos ADD COLUMN avaliacao_pedida_em TEXT;   -- pedido de avaliação no Google (2 dias depois da entrega)
ALTER TABLE pedidos ADD COLUMN aviso_pagamento_em TEXT;    -- aviso de Pix/boleto pendente ou de pagamento não aprovado
ALTER TABLE newsletter ADD COLUMN boas_vindas_em TEXT;     -- boas-vindas de quem entrou na lista de promoções
