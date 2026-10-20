import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
});

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Método não permitido.' }, 405);

  try {
    const authorization = req.headers.get('Authorization');
    if (!authorization?.startsWith('Bearer ')) return json({ error: 'Faça login para usar esta função.' }, 401);

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY');
    const geminiKey = Deno.env.get('GEMINI_API_KEY');
    if (!supabaseUrl || !anonKey) return json({ error: 'A função ainda não está configurada no Supabase.' }, 500);
    if (!geminiKey) return json({ error: 'Configure o segredo GEMINI_API_KEY nas Edge Functions do Supabase.' }, 500);

    const authClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error: authError } = await authClient.auth.getUser();
    if (authError || !user) return json({ error: 'Sua sessão expirou. Entre novamente.' }, 401);

    const body = await req.json();
    const audioBase64 = body?.audioBase64;
    const mimeType = String(body?.mimeType || 'audio/webm').split(';')[0];
    const allowedMime = ['audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/aac', 'audio/flac'];
    if (typeof audioBase64 !== 'string' || audioBase64.length < 100) return json({ error: 'Nenhum áudio válido foi recebido.' }, 400);
    if (audioBase64.length > 21_000_000) return json({ error: 'O áudio passou do limite. Grave uma fala mais curta.' }, 413);
    if (!allowedMime.includes(mimeType)) return json({ error: 'Formato de áudio não suportado pelo navegador.' }, 415);

    const prompt = `Você é um assistente de cadastro de insumos para um aplicativo brasileiro de precificação de doces. Ouça o áudio e extraia APENAS dados que a pessoa realmente informou. Responda somente JSON válido, sem markdown, neste formato:
{"ingredients":[{"nome":"string","qtd":number|null,"un":"g|kg|ml|L|un","preco":number|null,"aproveitamentos":[{"nome":"string","quantidade":number,"pesoMedio":number}]}]}
Regras:
- Extraia TODOS os insumos diferentes mencionados no áudio, na mesma ordem em que foram falados. Não junte ingredientes diferentes.
- Se a pessoa mencionar quantidade comprada e preço por embalagem, registre a quantidade de UMA embalagem e o preço de UMA embalagem; quando disser preço total de várias embalagens sem preço unitário, registre o total pago e a quantidade total somente se estiver claro.
- nome deve ser o nome do insumo ou embalagem, em português.
- qtd é a quantidade comprada na embalagem, usando a unidade un.
- Normalize unidades: gramas -> g, quilogramas -> kg, mililitros -> ml, litros -> L. Para dúzias, bandejas, pacotes ou unidades contáveis, use un e qtd como número de embalagens/unidades compradas conforme a fala.
- preco é o valor total pago pela embalagem em reais, apenas número decimal (ex.: 12.5), sem símbolo.
- Se a pessoa mencionar diferentes tipos/tamanhos aproveitáveis de um insumo, inclua-os em aproveitamentos. quantidade é número de peças daquele tipo; pesoMedio é o peso em gramas por peça. Só preencha quando ambos forem explicitamente informados. Caso contrário use [].
- Não invente valores. Se não entender um campo, use null para qtd/preco e "un" para unidade; não inclua itens cujo nome não possa ser identificado.
- Se houver apenas um insumo, ainda assim retorne-o dentro do array ingredients. Se não houver nenhum, retorne {"ingredients":[]}.
- Use ponto decimal e números JSON. O usuário pode falar valores em reais com vírgula.`;

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${encodeURIComponent(geminiKey)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: audioBase64 } }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.1 },
      }),
    });
    const result = await response.json();
    if (!response.ok) {
      console.error('Gemini API error:', result?.error?.message || response.status);
      return json({ error: 'A IA não conseguiu analisar o áudio agora. Confira a configuração da Gemini e tente novamente.' }, 502);
    }
    const text = result?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text || '').join('');
    if (!text) return json({ error: 'Não consegui identificar os dados. Grave novamente falando mais devagar.' }, 422);
    let parsed;
    try { parsed = JSON.parse(text); } catch { return json({ error: 'A resposta da IA veio em formato inesperado. Tente novamente.' }, 502); }
    const rawItems = Array.isArray(parsed?.ingredients) ? parsed.ingredients : (parsed?.ingredient ? [parsed.ingredient] : (parsed?.nome ? [parsed] : []));
    const unitAliases: Record<string, string> = { g: 'g', grama: 'g', gramas: 'g', kg: 'kg', quilograma: 'kg', quilogramas: 'kg', ml: 'ml', mililitro: 'ml', mililitros: 'ml', l: 'L', litro: 'L', litros: 'L', un: 'un', unidade: 'un', unidades: 'un' };
    const ingredients = rawItems.slice(0, 30).map((raw: any) => ({
      nome: String(raw?.nome || '').trim().slice(0, 120),
      qtd: Number.isFinite(Number(raw?.qtd)) && raw?.qtd !== null ? Number(raw.qtd) : null,
      un: unitAliases[String(raw?.un || 'un').toLowerCase()] || 'un',
      preco: Number.isFinite(Number(raw?.preco)) && raw?.preco !== null ? Number(raw.preco) : null,
      aproveitamentos: Array.isArray(raw?.aproveitamentos) ? raw.aproveitamentos.slice(0, 10).map((a: any) => ({
        nome: String(a?.nome || '').trim().slice(0, 80),
        quantidade: Number(a?.quantidade) || 0,
        pesoMedio: Number(a?.pesoMedio) || 0,
      })).filter((a: any) => a.nome && a.quantidade > 0 && a.pesoMedio > 0) : [],
    })).filter((x: any) => x.nome);
    if (!ingredients.length) return json({ error: 'Não consegui identificar o nome dos insumos. Tente falar novamente.' }, 422);
    return json({ ingredients });
  } catch (error) {
    console.error('parse-ingredient-audio failed:', error);
    return json({ error: 'Ocorreu um erro ao analisar o áudio. Tente novamente.' }, 500);
  }
});
