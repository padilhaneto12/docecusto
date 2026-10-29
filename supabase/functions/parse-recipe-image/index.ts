import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
});

async function refundCredit(serviceClient: any, userId: string, transactionId: string, reason: string) {
  try {
    await serviceClient.rpc('refund_ai_credit', {
      p_user_id: userId,
      p_transaction_id: transactionId,
      p_reason: reason,
    });
  } catch (error) {
    console.error('Could not refund AI credit:', error);
  }
}

Deno.serve(async (req) => {
  let serviceClient: any = null;
  let creditUserId: string | null = null;
  let creditTransactionId: string | null = null;
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Método não permitido.' }, 405);

  try {
    const authorization = req.headers.get('Authorization');
    if (!authorization?.startsWith('Bearer ')) return json({ error: 'Faça login para importar uma receita.' }, 401);
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const geminiKey = Deno.env.get('GEMINI_API_KEY');
    if (!supabaseUrl || !anonKey || !serviceRoleKey) return json({ error: 'Configure SUPABASE_URL, a chave pública e SUPABASE_SERVICE_ROLE_KEY nos segredos da função.' }, 500);
    if (!geminiKey) return json({ error: 'Configure o segredo GEMINI_API_KEY nas Edge Functions do Supabase.' }, 500);

    const authClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error: authError } = await authClient.auth.getUser();
    if (authError || !user) return json({ error: 'Sua sessão expirou. Entre novamente.' }, 401);
    creditUserId = user.id;
    serviceClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const body = await req.json();
    const imageBase64 = body?.imageBase64;
    const mimeType = String(body?.mimeType || '').split(';')[0];
    const allowedMime = ['image/jpeg', 'image/png', 'image/webp'];
    if (typeof imageBase64 !== 'string' || imageBase64.length < 100) return json({ error: 'Nenhuma imagem válida foi recebida.' }, 400);
    if (imageBase64.length > 14_000_000) return json({ error: 'A imagem passou do limite de tamanho.' }, 413);
    if (!allowedMime.includes(mimeType)) return json({ error: 'Formato não suportado. Use JPG, PNG ou WebP.' }, 415);

    const { data: credit, error: creditError } = await serviceClient.rpc('consume_ai_credit', {
      p_user_id: user.id,
      p_operation: 'image',
    });
    if (creditError) {
      console.error('Credit reservation failed:', creditError.message);
      return json({ error: 'Não foi possível verificar seus créditos agora. Tente novamente.' }, 500);
    }
    if (!credit?.ok) {
      return json({ error: 'Seus créditos de IA acabaram. Compre mais créditos pelo WhatsApp para continuar.', code: 'NO_AI_CREDITS', balance: 0 }, 200);
    }
    creditTransactionId = credit.transaction_id;
    const refundResponse = async (message: string, status = 502) => {
      if (creditTransactionId) await refundCredit(serviceClient, user.id, creditTransactionId, message);
      creditTransactionId = null;
      return json({ error: message }, status);
    };

    const prompt = `Você extrai dados de receitas culinárias a partir de fotos ou prints para um aplicativo brasileiro de precificação de doces. Leia a imagem e responda SOMENTE JSON válido, sem markdown, neste formato exato:
{"recipe":{"nome":"string","rend":number|null,"un":"un|g|kg|ml|L","ingredients":[{"nome":"string","qtd":number|null,"un":"g|kg|ml|L|un|colher de sopa|xícara de chá"}]}}
Regras importantes:
- Extraia somente informações visíveis e legíveis na imagem. Não invente ingredientes, quantidades, rendimento ou unidades.
- Mantenha os ingredientes na ordem em que aparecem e não junte itens diferentes.
- Converta números escritos com vírgula decimal para números JSON com ponto.
- Padronize unidades: gramas/g -> g; quilogramas/kg -> kg; mililitros/ml -> ml; litros/l -> L; unidade/peça -> un; colher de sopa -> "colher de sopa"; xícara de chá -> "xícara de chá".
- Se a quantidade estiver expressa em colher de sopa ou xícara de chá, preserve a quantidade numérica e use a unidade correspondente: "colher de sopa" ou "xícara de chá". Para lata, caixa ou pacote, use un e não invente conversões de peso/volume.
- Para ingredientes sem quantidade legível, use qtd:null. Não estime pela imagem.
- Se o rendimento não estiver explícito, use rend:null. Se a unidade de rendimento não estiver clara, use un:"un".
- Se o nome da receita não estiver legível, use "Receita importada".
- Ignore modo de preparo, comentários, preços, publicidade e informações não relacionadas aos ingredientes.
- Se não conseguir identificar ingredientes com confiança, retorne {"recipe":{"nome":"Receita importada","rend":null,"un":"un","ingredients":[]}}.`;

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${encodeURIComponent(geminiKey)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: imageBase64 } }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.1 },
      }),
    });
    const result = await response.json();
    if (!response.ok) {
      console.error('Gemini API error:', result?.error?.message || response.status);
      return await refundResponse('A IA não conseguiu analisar a imagem agora. Confira a configuração da Gemini e tente novamente.', 502);
    }
    const text = result?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text || '').join('');
    if (!text) return await refundResponse('Não consegui ler os dados. Tente uma imagem mais nítida.', 422);
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { return await refundResponse('A resposta da IA veio em formato inesperado. Tente novamente.', 502); }
    const raw = parsed?.recipe ?? parsed;
    const unitAliases: Record<string, string> = {
      g: 'g', grama: 'g', gramas: 'g', kg: 'kg', quilograma: 'kg', quilogramas: 'kg',
      ml: 'ml', mililitro: 'ml', mililitros: 'ml', l: 'L', litro: 'L', litros: 'L',
      un: 'un', unidade: 'un', unidades: 'un', peça: 'un', peças: 'un',
      'colher de sopa': 'colher de sopa', 'colher sopa': 'colher de sopa', 'colheres de sopa': 'colher de sopa', cs: 'colher de sopa',
      'xícara de chá': 'xícara de chá', 'xicara de cha': 'xícara de chá', 'xícaras de chá': 'xícara de chá', 'xicaras de cha': 'xícara de chá', 'xicara': 'xícara de chá', 'xícara': 'xícara de chá',
    };
    const ingredients = (Array.isArray(raw?.ingredients) ? raw.ingredients : []).slice(0, 60).map((item: any) => {
      const rawUnit = String(item?.un || 'g').toLowerCase();
      const quantity = item?.qtd;
      return {
        nome: String(item?.nome || '').trim().slice(0, 120),
        qtd: quantity !== null && quantity !== undefined && Number.isFinite(Number(quantity)) && Number(quantity) > 0 ? Number(quantity) : null,
        un: unitAliases[rawUnit] || 'g',
      };
    }).filter((item: any) => item.nome);
    if (!ingredients.length) return await refundResponse('Não consegui identificar ingredientes legíveis. Tente uma foto mais nítida e completa.', 422);
    const rend = raw?.rend !== null && raw?.rend !== undefined && Number.isFinite(Number(raw.rend)) && Number(raw.rend) > 0 ? Number(raw.rend) : null;
    const recipe = {
      nome: String(raw?.nome || 'Receita importada').trim().slice(0, 120) || 'Receita importada',
      rend,
      un: unitAliases[String(raw?.un || 'un').toLowerCase()] || 'un',
      ingredients,
    };
    const usage = result?.usageMetadata || {};
    await serviceClient.rpc('record_ai_credit_usage', {
      p_transaction_id: creditTransactionId,
      p_input_tokens: Number.isFinite(Number(usage.promptTokenCount)) ? Number(usage.promptTokenCount) : null,
      p_output_tokens: Number.isFinite(Number(usage.candidatesTokenCount)) ? Number(usage.candidatesTokenCount) : null,
      p_model: 'gemini-3.6-flash',
    });
    const creditsRemaining = credit.balance;
    creditTransactionId = null;
    return json({ recipe, creditsRemaining });
  } catch (error) {
    console.error('parse-recipe-image failed:', error);
    if (serviceClient && creditUserId && creditTransactionId) {
      await refundCredit(serviceClient, creditUserId, creditTransactionId, 'Erro inesperado durante o processamento');
      creditTransactionId = null;
    }
    return json({ error: 'Ocorreu um erro ao analisar a imagem. Tente novamente.' }, 500);
  }
});
