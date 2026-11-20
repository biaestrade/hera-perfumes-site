-- Perfil da cliente (Minha conta > Meus dados) e endereço de entrega guardado em cada pedido
ALTER TABLE clientes ADD COLUMN nome TEXT;
ALTER TABLE clientes ADD COLUMN cpf TEXT;            -- só números; necessário para a nota fiscal
ALTER TABLE clientes ADD COLUMN telefone TEXT;       -- só números, com DDD
ALTER TABLE clientes ADD COLUMN nascimento TEXT;     -- AAAA-MM-DD (opcional)
ALTER TABLE clientes ADD COLUMN cep TEXT;
ALTER TABLE clientes ADD COLUMN logradouro TEXT;
ALTER TABLE clientes ADD COLUMN numero TEXT;
ALTER TABLE clientes ADD COLUMN complemento TEXT;
ALTER TABLE clientes ADD COLUMN bairro TEXT;
ALTER TABLE clientes ADD COLUMN cidade TEXT;
ALTER TABLE clientes ADD COLUMN uf TEXT;
ALTER TABLE clientes ADD COLUMN atualizado_em TEXT;
ALTER TABLE pedidos ADD COLUMN entrega TEXT;         -- cópia (JSON) do nome, CPF, telefone e endereço na hora da compra
