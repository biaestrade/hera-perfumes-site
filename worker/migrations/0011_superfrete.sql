-- Etiqueta da SuperFrete criada automaticamente quando o pedido é pago (fica "aguardando pagamento" no painel da SuperFrete)
ALTER TABLE pedidos ADD COLUMN superfrete_id TEXT;
ALTER TABLE pedidos ADD COLUMN superfrete_preco_centavos INTEGER;
ALTER TABLE pedidos ADD COLUMN superfrete_em TEXT;
ALTER TABLE pedidos ADD COLUMN superfrete_erro TEXT;
ALTER TABLE pedidos ADD COLUMN superfrete_tentativas INTEGER DEFAULT 0;
