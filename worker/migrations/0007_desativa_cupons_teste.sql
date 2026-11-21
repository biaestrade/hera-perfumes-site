-- Cupons de teste desligados (20/11/2026). Os códigos dos representantes de verdade são cadastrados na tabela cupons.
UPDATE cupons SET ativo = 0 WHERE codigo IN ('TESTE10', 'TESTE15');
