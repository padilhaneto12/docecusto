# Doce Custo — implantação dos créditos de IA

Este pacote implementa um saldo compartilhado de créditos entre a importação de receita por imagem e o cadastro de insumos por áudio.

## O que muda
- Cada conta recebe 20 créditos iniciais (inclusive contas já existentes sem saldo anterior).
- Cada leitura de imagem ou processamento de áudio bem-sucedido consome 1 crédito do mesmo saldo.
- Falhas de processamento devolvem o crédito reservado.
- O saldo aparece no menu da conta.
- O botão "Comprar mais créditos" abre o WhatsApp de suporte com o e-mail do usuário.
- O painel Admin mostra o saldo de cada usuário e permite adicionar/remover créditos.
- As Edge Functions registram os tokens de entrada/saída retornados pelo Gemini, quando disponíveis.

## Passo 1 — backup
Antes de publicar, baixe uma cópia do `index.html` atual e copie os códigos atuais das Edge Functions `parse-recipe-image` e `parse-ingredient-audio`.

## Passo 2 — executar o SQL
1. Abra o projeto no Supabase.
2. Entre em **SQL Editor** e crie uma nova consulta.
3. Copie todo o conteúdo de `supabase/ai_credits_setup.sql`.
4. Execute uma única vez.
5. Confirme que as tabelas `ai_credit_balances` e `ai_credit_transactions` foram criadas.

O script concede 20 créditos às contas existentes que ainda não têm saldo e cria um gatilho para novas contas. Contas que já tenham uma linha em `ai_credit_balances` não recebem créditos duplicados.

## Passo 3 — configurar o segredo das Edge Functions
As duas funções precisam destes segredos no Supabase:
- `GEMINI_API_KEY` — já usado pela IA.
- `SUPABASE_SERVICE_ROLE_KEY` — chave secreta do projeto, disponível em **Project Settings → API Keys** (ou na área equivalente de chaves do projeto).

O Supabase normalmente disponibiliza `SUPABASE_SERVICE_ROLE_KEY` como variável de ambiente às Edge Functions. Confira se ela está disponível no ambiente da função; se não estiver, adicione-a aos **Secrets** do projeto. `SUPABASE_URL` e a chave pública/anon também costumam ser fornecidas automaticamente. O código aceita `SUPABASE_ANON_KEY` ou `SUPABASE_PUBLISHABLE_KEY`.

**Nunca coloque a chave service role/secret no `index.html`, GitHub público ou navegador.** Ela só é usada no servidor pelas funções.

## Passo 4 — publicar as duas Edge Functions
No Supabase → **Edge Functions**, abra cada função existente e substitua o código pelo arquivo correspondente do pacote:
- `supabase/functions/parse-recipe-image/index.ts`
- `supabase/functions/parse-ingredient-audio/index.ts`

Publique/deploy ambas as funções. Mantenha a verificação JWT habilitada para as duas.

## Passo 5 — publicar o app
Substitua o `index.html` do app hospedado pelo `index.html` deste pacote. Os outros arquivos estáticos do app podem ser mantidos.

## Passo 6 — testar
1. Entre com uma conta normal e confira o saldo de 20 créditos no menu da conta.
2. Faça uma leitura por imagem: o saldo deve cair para 19.
3. Faça um cadastro por áudio: o saldo deve cair para 18.
4. No painel Admin, confirme que aparece o saldo do usuário.
5. Teste um ajuste positivo (por exemplo, `+5`) e confira o novo saldo.
6. Teste um ajuste negativo pequeno e confira que o saldo não fica abaixo de zero.
7. Teste uma falha de IA: o crédito reservado deve ser devolvido.
8. Com saldo zero, ambas as funções devem avisar que os créditos acabaram e oferecer compra pelo WhatsApp.

## Observações importantes
- Imagem e áudio compartilham o mesmo saldo; cada operação concluída com sucesso custa 1 crédito no Doce Custo.
- O saldo é controlado no banco/servidor, não no navegador.
- O painel Admin usa o campo `profiles.role = 'admin'` e a função existente `public.is_admin()`. A conta administradora precisa já ter esse papel corretamente configurado.
- O botão de compra direciona para o WhatsApp que já é usado pelo app para suporte (`+55 42 99862-356`). Confirme que esse é o número correto para receber pedidos de compra.
- O sistema não confirma pagamentos. Você deve conferir o Pix no banco e só então adicionar os créditos no painel Admin.
- A tabela `ai_credit_transactions` mantém o histórico técnico e comercial de concessões, consumo, estornos e ajustes. O app atual mostra o saldo, mas ainda não tem uma tela de histórico detalhado.
- O registro de tokens depende dos metadados devolvidos pelo modelo Gemini. Isso ajuda a estimar custos, mas deve ser comparado com o painel de uso/faturamento do Google.
