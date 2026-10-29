# Doce Custo — cadastro de insumos por áudio (Gemini + Supabase)

## O que foi adicionado
- Botão **Gravar áudio** dentro de **Insumos > Novo insumo**.
- A gravação é enviada à Edge Function `parse-ingredient-audio`, que chama a Gemini no servidor.
- A IA sugere nome, quantidade, unidade, preço e, quando a fala trouxer esses dados, aproveitamentos.
- Os campos são apenas preenchidos para revisão. O usuário ainda precisa conferir e tocar em **Salvar**.
- A chave da Gemini não fica no HTML nem no navegador.

## Configuração necessária no Supabase

1. Crie uma chave de API em Google AI Studio: https://aistudio.google.com/apikey
2. No painel do projeto Supabase, abra **Edge Functions** e configure o secret:
   - Nome: `GEMINI_API_KEY`
   - Valor: sua chave da Gemini
3. Publique a função `parse-ingredient-audio` que está em `supabase/functions/parse-ingredient-audio/index.ts`.
4. Mantenha a verificação JWT ativada para essa função. O arquivo `supabase/config.toml` já especifica `verify_jwt = true`.
5. Teste usando uma conta autenticada no app e permita acesso ao microfone no navegador.

### Publicar usando o Supabase CLI
Na pasta do projeto, com o CLI instalado e o projeto vinculado:

```bash
supabase login
supabase link --project-ref pofviqmpthyteodifqza
supabase secrets set GEMINI_API_KEY=SUA_CHAVE_GEMINI_AQUI
supabase functions deploy parse-ingredient-audio
```

Não coloque sua chave real neste arquivo, no HTML, no GitHub ou em mensagens. Se a chave for exposta, revogue-a e crie outra.

## Como testar
1. Abra **Insumos > Novo insumo**.
2. Clique em **Gravar áudio** e diga, por exemplo: “Chocolate em pó, pacote de 500 gramas, paguei 18 reais”.
3. Clique em **Parar e analisar**.
4. Confira os campos preenchidos e corrija qualquer informação antes de salvar.

## Observações
- A gravação precisa de permissão do microfone e de uma conexão segura HTTPS (ou localhost durante desenvolvimento).
- O uso da Gemini pode gerar cobrança ou estar sujeito aos limites do plano da sua conta Google; confira os limites atuais no Google AI Studio.
- O recurso depende da Edge Function publicada e do secret configurado. O HTML sozinho não consegue chamar a Gemini com segurança.
- Não foi possível validar uma chamada real à Gemini/Supabase sem acesso ao seu painel e à sua chave; faça o teste de ponta a ponta após configurar.

## Importação de receitas por imagem

A versão atual também inclui a função `parse-recipe-image`, usada no cadastro de receitas para importar uma foto ou print. Ela usa o mesmo segredo `GEMINI_API_KEY` já configurado para a IA de insumos.

1. Atualize os arquivos do aplicativo no seu serviço de hospedagem.
2. Publique a nova Edge Function a partir da pasta do projeto:

   ```bash
   supabase functions deploy parse-recipe-image
   ```

3. Entre no Doce Custo, abra **Receitas → Nova receita** e clique em **Importar foto ou print**.
4. Revise nome, rendimento, ingredientes, unidades e vínculos com insumos. A IA apenas preenche o formulário; não salva a receita automaticamente.

Formatos aceitos: JPG, PNG e WebP, até 10 MB. Ingredientes sem vínculo ou com quantidade incerta devem ser revisados manualmente. Se o segredo `GEMINI_API_KEY` já existe nas Edge Functions, não é necessário cadastrá-lo novamente.
