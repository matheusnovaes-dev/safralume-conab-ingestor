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

export function escolherFonte(ultimaDoEstado, ultimaRegional) {
  if (!ultimaDoEstado && !ultimaRegional) return null;
  if (!ultimaRegional) return "estado";
  if (!ultimaDoEstado) return "regional";
  const dif = diasEntre(ultimaDoEstado, ultimaRegional);
  if (Number.isNaN(dif)) return "estado";
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
};
export function padraoDeProduto(cultura) {
  return PRODUTO_PRINCIPAL[String(cultura).trim().toLowerCase()] ?? `%${cultura}%`;
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
      .limit(60),
  ]);
  const linhaEstado = estado?.[0] ?? null;
  const ultimaRegional = regionais?.[0]?.data_referencia ?? null;
  const fonte = escolherFonte(linhaEstado?.data_referencia, ultimaRegional);
  if (fonte === "estado") {
    return { preco: Number(linhaEstado.preco), data_referencia: linhaEstado.data_referencia, produto: linhaEstado.produto, origem: "estado" };
  }
  if (fonte === "regional") {
    const doDia = regionais.filter((r) => r.data_referencia === ultimaRegional);
    const saca = doDia.filter((r) => String(r.unidade ?? "").includes("60"));
    const usadas = saca.length > 0 ? saca : doDia;
    return { preco: mediaDePracas(usadas.map((r) => Number(r.preco))), data_referencia: ultimaRegional, produto: usadas[0].produto, origem: `regional (média de ${usadas.length} praça(s))` };
  }
  return null;
}
