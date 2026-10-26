// Mesma regra do app (rural-heart-project: src/lib/precoFonte.ts + precos.ts).
// Quando o mesmo produto/UF tem preço único do estado (regiao = '', ex: Conab)
// e preço por praça (ex: BBM, diário), o do estado vence a não ser que esteja
// defasado em pelo menos 7 dias frente ao regional. Achado real: soja de MT
// ficou 4 semanas em R$129,80 (Conab, 21/08) enquanto a BBM publicava ~R$143
// todo dia — alertas e sinal de venda decidiam em cima do preço velho.
export const DIAS_ESTADO_DEFASADO = 7;

const MS_POR_DIA = 24 * 60 * 60 * 1000;
const paraMs = (d) => Date.parse(`${String(d).slice(0, 10)}T00:00:00Z`);

export function diasEntre(a, b) {
  return Math.round((paraMs(b) - paraMs(a)) / MS_POR_DIA);
}

// Fonte principal por praça (coleta diária); as outras são a reserva pela data mais recente. Mesma regra do app (precoFonte.ts).
// O rótulo vem da configuração privada (bucket `coleta-b`): quem usa este módulo chama carregarFontePrincipal(supabase) uma vez. Sem
// configuração, fica vazio e a regra de fonte principal simplesmente não se aplica (comportamento anterior).
export let FONTE_PRINCIPAL = "";
export async function carregarFontePrincipal(supabase) {
  try {
    const { data } = await supabase.storage.from("coleta-b").download("config/fonte-b.json");
    FONTE_PRINCIPAL = JSON.parse(await data.text()).rotulo ?? "";
  } catch {
    FONTE_PRINCIPAL = "";
  }
  return FONTE_PRINCIPAL;
}
export const DIAS_TOLERANCIA_PRINCIPAL = 2;

export function escolherFonte(ultimaDoEstado, ultimaRegional, { regionalPrincipal = false } = {}) {
  if (!ultimaDoEstado && !ultimaRegional) return null;
  if (!ultimaRegional) return "estado";
  if (!ultimaDoEstado) return "regional";
  const dif = diasEntre(ultimaDoEstado, ultimaRegional);
  if (Number.isNaN(dif)) return "estado";
  if (regionalPrincipal && dif >= -DIAS_TOLERANCIA_PRINCIPAL) return "regional";
  return dif >= DIAS_ESTADO_DEFASADO ? "regional" : "estado";
}

export function mediaDePracas(precos) {
  if (precos.length === 0) return null;
  return Math.round((precos.reduce((a, p) => a + p, 0) / precos.length) * 100) / 100;
}

// "milho" também casa "MILHO DE PIPOCA (60 kg)" (~2x mais caro) — soja e milho
// usam só a variante principal.
const PRODUTO_PRINCIPAL = {
  soja: "SOJA EM GRÃOS (60 kg)",
  milho: "MILHO EM GRÃOS (60 kg)",
  boi: "BOI GORDO (15 kg)",
};
// Nomes que o produtor usa pra uma cultura que a base chama de outro jeito (a
// carne bovina é o boi gordo). Mesmo mapa do app (src/config/culturas.ts).
const ALIAS_CULTURA = {
  "carne bovina": "boi",
  "carne de boi": "boi",
  "boi gordo": "boi",
  gado: "boi",
  "gado de corte": "boi",
  bovino: "boi",
  bovinos: "boi",
  "pecuária de corte": "boi",
};
export function normalizarCultura(cultura) {
  const c = String(cultura).trim().toLowerCase();
  return ALIAS_CULTURA[c] ?? c;
}

export function padraoDeProduto(cultura) {
  const c = normalizarCultura(cultura);
  return PRODUTO_PRINCIPAL[c] ?? `%${c}%`;
}

/** Última data regional (praça) de uma cultura numa UF, ou null. */
export async function ultimaDataRegional(supabase, cultura, uf) {
  const { data } = await supabase
    .from("precos")
    .select("data_referencia")
    .ilike("produto", padraoDeProduto(cultura))
    .eq("uf", uf)
    .neq("regiao", "")
    // Praça CIF (porto/indústria) é outro nível de preço: fora do preço do interior.
    .not("regiao", "ilike", "%cif%")
    // o aviso proativo de sinal de venda ainda NÃO usa a fonte principal (pouco histórico por estado): segue como antes, sem ele
    .neq("fonte", FONTE_PRINCIPAL || "__nenhuma__")
    .order("data_referencia", { ascending: false })
    .limit(1);
  return data?.[0]?.data_referencia ?? null;
}

/**
 * Preço atual de uma cultura numa UF já com a fonte escolhida: o mais recente
 * do estado, ou a média das praças do dia mais recente quando o do estado
 * está defasado (ou não existe). Devolve null se não há dado nenhum.
 */
export async function buscarPrecoAtual(supabase, cultura, uf) {
  const padrao = padraoDeProduto(cultura);
  const [{ data: estado }, { data: regionais }] = await Promise.all([
    supabase
      .from("precos")
      .select("produto, preco, data_referencia, fonte")
      .ilike("produto", padrao)
      .eq("uf", uf)
      .eq("regiao", "")
      .order("data_referencia", { ascending: false })
      .limit(1),
    supabase
      .from("precos")
      .select("produto, preco, unidade, data_referencia, fonte")
      .ilike("produto", padrao)
      .eq("uf", uf)
      .neq("regiao", "")
      .not("regiao", "ilike", "%cif%")
      .order("data_referencia", { ascending: false })
      .limit(300),
  ]);
  const linhaEstado = estado?.[0] ?? null;
  const ultimaRegional = regionais?.[0]?.data_referencia ?? null;
  const regionalPrincipal = !!FONTE_PRINCIPAL && (regionais ?? []).some((r) => r.data_referencia === ultimaRegional && r.fonte === FONTE_PRINCIPAL);
  const fonte = escolherFonte(linhaEstado?.data_referencia, ultimaRegional, { regionalPrincipal });
  if (fonte === "estado") {
    return { preco: Number(linhaEstado.preco), data_referencia: linhaEstado.data_referencia, produto: linhaEstado.produto, origem: "estado" };
  }
  if (fonte === "regional") {
    let doDia = regionais.filter((r) => r.data_referencia === ultimaRegional);
    if (regionalPrincipal) doDia = doDia.filter((r) => r.fonte === FONTE_PRINCIPAL); // na mesma data, só a fonte principal (a praça não conta duas vezes)
    const saca = doDia.filter((r) => String(r.unidade ?? "").includes("60"));
    const usadas = saca.length > 0 ? saca : doDia;
    return { preco: mediaDePracas(usadas.map((r) => Number(r.preco))), data_referencia: ultimaRegional, produto: usadas[0].produto, origem: `regional (média de ${usadas.length} praça(s))` };
  }
  return null;
}
