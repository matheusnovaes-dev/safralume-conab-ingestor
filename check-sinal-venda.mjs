import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY;
if (DRY_RUN) {
  console.log("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes — rodando em modo dry-run.");
}
const supabase = DRY_RUN ? null : createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Mesmo mapeamento de src/config/b3.ts — único lugar de verdade seria o app,
// mas esse script roda fora do bundle dele, então é replicado aqui (mesma
// abordagem já usada em check-alertas-clima.mjs pras coordenadas de capital).
const CULTURA_PARA_B3 = {
  boi: ["BGI"],
  milho: ["CCM"],
  "café arábica": ["ICF"],
  "café conillon": ["CNL"],
  soja: ["SJC", "SOY"],
  "cana de açúcar": ["ETH"],
};

const capitalPorUf = {
  AC: [-9.97, -67.81], AL: [-9.65, -35.72], AP: [0.04, -51.05], AM: [-3.1, -60.02],
  BA: [-12.97, -38.51], CE: [-3.72, -38.54], DF: [-15.78, -47.93], ES: [-20.32, -40.34],
  GO: [-16.68, -49.25], MA: [-2.53, -44.3], MT: [-15.6, -56.1], MS: [-20.44, -54.65],
  MG: [-19.92, -43.94], PA: [-1.46, -48.5], PB: [-7.12, -34.88], PR: [-25.43, -49.27],
  PE: [-8.05, -34.9], PI: [-5.09, -42.8], RJ: [-22.91, -43.17], RN: [-5.79, -35.21],
  RS: [-30.03, -51.23], RO: [-8.76, -63.9], RR: [2.82, -60.67], SC: [-27.6, -48.55],
  SP: [-23.55, -46.63], SE: [-10.91, -37.07], TO: [-10.25, -48.32],
};

// --- Portado de src/lib/sinalVenda.ts (funções puras, sem dependência de UI) ---

const LIMITE_POSICAO_ALTO = 70;
const LIMITE_POSICAO_BAIXO = 30;
const LIMITE_CURVA_PCT = 1.5;
const LIMITE_DIAS_CHUVA_RISCO = 2;

function sinalDaPosicao(posicao) {
  if (posicao == null) return null;
  if (posicao >= LIMITE_POSICAO_ALTO) return "alto";
  if (posicao <= LIMITE_POSICAO_BAIXO) return "baixo";
  return "neutro";
}

function sinalDaCurvaFuturos(futuros) {
  const ordenados = [...futuros].sort((a, b) => a.mesAnoVencimento.localeCompare(b.mesAnoVencimento));
  const distintos = ordenados.filter(
    (f, i) => i === 0 || f.mesAnoVencimento !== ordenados[i - 1].mesAnoVencimento,
  );
  if (distintos.length < 2) return null;
  const maisProximo = distintos[0];
  const maisDistante = distintos[distintos.length - 1];
  if (maisProximo.preco === 0) return null;
  const variacaoPct = ((maisDistante.preco - maisProximo.preco) / maisProximo.preco) * 100;
  if (Math.abs(variacaoPct) < LIMITE_CURVA_PCT) return "neutro";
  return variacaoPct > 0 ? "alta" : "baixa";
}

function combinarSinalVenda(posicao, curva) {
  if (posicao == null && curva == null) return null;
  if (posicao === "alto" && curva !== "alta") {
    return { tone: "up", texto: "Preço bem posicionado nos últimos 90 dias e o mercado futuro não aponta mais alta — pode ser um bom momento pra vender." };
  }
  if (posicao === "alto" && curva === "alta") {
    return { tone: "neutral", texto: "Preço já está bem posicionado, mas o mercado futuro ainda aponta alta — dá pra vender agora e travar esse preço, ou esperar mais um pouco de melhora." };
  }
  if (posicao === "baixo" && curva === "alta") {
    return { tone: "neutral", texto: "Preço abaixo da média dos últimos 90 dias, mas o mercado futuro aponta alta — se der pra esperar, pode valer." };
  }
  if (posicao === "baixo" && curva !== "alta") {
    return { tone: "down", texto: "Preço abaixo da média dos últimos 90 dias e o mercado futuro também não aponta melhora no curto prazo." };
  }
  if (posicao === "neutro" && curva && curva !== "neutro") {
    return curva === "alta"
      ? { tone: "neutral", texto: "Preço na média dos últimos 90 dias, mas o mercado futuro aponta alta." }
      : { tone: "neutral", texto: "Preço na média dos últimos 90 dias, e o mercado futuro aponta queda." };
  }
  if (curva == null && posicao && posicao !== "neutro") {
    return posicao === "alto"
      ? { tone: "up", texto: "Preço bem posicionado nos últimos 90 dias." }
      : { tone: "down", texto: "Preço abaixo da média dos últimos 90 dias." };
  }
  return null;
}

function combinarComClima(sinal, diasDeChuva) {
  const riscoClima = diasDeChuva != null && diasDeChuva >= LIMITE_DIAS_CHUVA_RISCO;
  if (!riscoClima) return sinal;
  const nota = `Tem chuva forte prevista em ${diasDeChuva} dos próximos 5 dias — pode atrapalhar colheita ou escoamento, o que pesa a favor de não esperar demais pra vender.`;
  if (!sinal) return { tone: "warn", texto: nota };
  if (sinal.tone === "up") return { ...sinal, texto: `${sinal.texto} ${nota}` };
  return { tone: "warn", texto: `${sinal.texto} ${nota}` };
}

// --- Fim da lógica portada ---

// Mesma proteção de precos.tsx/InsightsPanel.tsx: a busca por substring pode
// casar mais de uma variante de embalagem da mesma cultura — fica só com a
// mais publicada, senão a posição mistura séries diferentes.
function serieUnica(rows) {
  const counts = new Map();
  for (const r of rows) counts.set(r.produto, (counts.get(r.produto) ?? 0) + 1);
  let principal = null;
  let max = 0;
  for (const [produto, count] of counts) {
    if (count > max) {
      max = count;
      principal = produto;
    }
  }
  return rows.filter((r) => r.produto === principal).sort((a, b) => a.data_referencia.localeCompare(b.data_referencia));
}

async function buscarPrevisao(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=precipitation_probability_max&timezone=auto&forecast_days=5`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  return json.daily.precipitation_probability_max.filter((p) => p != null && p >= 60).length;
}

async function run() {
  const desde = new Date();
  desde.setDate(desde.getDate() - 90);
  const desdeIso = desde.toISOString().slice(0, 10);
  const inicioMesIso = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
    .toISOString()
    .slice(0, 10);

  const { data: produtores, error } = DRY_RUN
    ? { data: [], error: null }
    : await supabase
        .from("produtores")
        .select("id, whatsapp, cultura_principal, uf, lat, lon, sinal_venda_ultimo_tone")
        .not("cultura_principal", "is", null)
        .not("uf", "is", null);

  if (error) {
    console.error("Erro ao buscar produtores:", error);
    process.exit(1);
  }
  if (!produtores || produtores.length === 0) {
    console.log(DRY_RUN ? "Dry-run: nada a checar." : "Nenhum produtor com cultura/UF definidos.");
    return;
  }

  const culturas = new Set(produtores.map((p) => p.cultura_principal));
  const ufs = new Set(produtores.map((p) => p.uf));

  // Uma busca de preço por cultura (cobre todas as UFs de uma vez, igual ao
  // painel faz), e uma busca de futuros por código B3 mapeado.
  const precosPorCultura = new Map();
  for (const cultura of culturas) {
    const { data } = await supabase
      .from("precos")
      .select("preco, data_referencia, produto, uf")
      .ilike("produto", `%${cultura}%`)
      .gte("data_referencia", desdeIso)
      .order("data_referencia", { ascending: true });
    precosPorCultura.set(cultura, serieUnica(data ?? []));
  }

  const futurosPorCultura = new Map();
  for (const cultura of culturas) {
    const codigo = CULTURA_PARA_B3[cultura]?.[0];
    if (!codigo) {
      futurosPorCultura.set(cultura, null);
      continue;
    }
    const { data } = await supabase
      .from("b3_futuros")
      .select("mes_ano_vencimento, preco_ajuste_atual, data_pregao")
      .eq("produto", codigo)
      .gte("mes_ano_vencimento", inicioMesIso)
      .order("data_pregao", { ascending: false })
      .order("mes_ano_vencimento", { ascending: true })
      .limit(10);
    const rows = data ?? [];
    const pregaoMaisRecente = rows[0]?.data_pregao;
    const doDiaCerto = rows.filter((r) => r.data_pregao === pregaoMaisRecente);
    futurosPorCultura.set(
      cultura,
      doDiaCerto.slice(0, 3).map((r) => ({ mesAnoVencimento: r.mes_ano_vencimento, preco: r.preco_ajuste_atual })),
    );
  }

  // Previsão por UF (capital) reaproveitada entre produtores da mesma UF sem
  // cidade própria cadastrada — só busca por coordenada exata quando o
  // produtor já tem lat/lon (mesmo critério do painel).
  const previsaoPorUf = new Map();
  for (const uf of ufs) {
    const coords = capitalPorUf[uf];
    if (coords) previsaoPorUf.set(uf, await buscarPrevisao(coords[0], coords[1]));
  }

  console.log(`Checando sinal de venda de ${produtores.length} produtor(es)...`);
  let novosParaEnviar = 0;
  let tonesAtualizados = 0;

  for (const produtor of produtores) {
    const serie = (precosPorCultura.get(produtor.cultura_principal) ?? []).filter((r) => r.uf === produtor.uf);
    if (serie.length === 0) continue;

    const precos = serie.map((p) => p.preco);
    const min = Math.min(...precos);
    const max = Math.max(...precos);
    const posicao = max > min ? ((serie.at(-1).preco - min) / (max - min)) * 100 : null;

    const futuros = futurosPorCultura.get(produtor.cultura_principal);
    const curva = futuros && futuros.length > 0 ? sinalDaCurvaFuturos(futuros) : null;

    const diasDeChuva =
      produtor.lat != null && produtor.lon != null
        ? await buscarPrevisao(produtor.lat, produtor.lon)
        : (previsaoPorUf.get(produtor.uf) ?? null);

    const sinal = combinarComClima(combinarSinalVenda(sinalDaPosicao(posicao), curva), diasDeChuva);
    const toneAtual = sinal?.tone ?? null;

    if (toneAtual == null) continue; // nada calculável ainda — não sobrescreve o último tone conhecido.

    const mudouParaUp = toneAtual === "up" && produtor.sinal_venda_ultimo_tone !== "up";

    const update = { sinal_venda_ultimo_tone: toneAtual };
    if (mudouParaUp) {
      update.sinal_venda_para_enviar = true;
      update.sinal_venda_ultimo_texto = sinal.texto;
      novosParaEnviar++;
      console.log(`  -> Produtor ${produtor.id}: virou "bom momento pra vender" (${produtor.cultura_principal}/${produtor.uf}).`);
    }
    if (toneAtual !== produtor.sinal_venda_ultimo_tone) tonesAtualizados++;

    const { error: updErr } = await supabase.from("produtores").update(update).eq("id", produtor.id);
    if (updErr) console.error(`  Erro ao atualizar produtor ${produtor.id}:`, updErr);
  }

  console.log(`OK. ${tonesAtualizados} tone(s) atualizado(s), ${novosParaEnviar} marcado(s) pra envio.`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
