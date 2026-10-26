/**
 * Regras (puras, testáveis) para decidir se o Fonte B pode ser a fonte principal de um produto/UF.
 *
 * Princípio: o Fonte B só entra no banco como principal onde ele CONCORDA com a fonte que já usamos (mesma definição de preço, diferença
 * pequena nas praças em comum) ou onde não temos dado nenhum. Onde diverge (ex.: PR e RS, 5 a 7% abaixo da BBM na soja), a fonte atual fica
 * até o Matheus decidir qual definição vale: trocar de uma para outra de um dia para o outro faria o preço "pular" e quebraria o sinal de
 * venda, a variação e os alertas de preço dos clientes. Como as linhas do Fonte B são as mais novas (diárias), o app, que sempre usa a data
 * mais recente, passa a mostrá-las sozinho; se o Fonte B parar de atualizar, a data mais nova volta a ser a das outras fontes (reserva).
 */
export const semAcento = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "");
export const norm = (s) => semAcento(s).toLowerCase().replace(/\(.*?\)/g, " ").replace(/[^a-z0-9/ ]+/g, " ").replace(/\s+/g, " ").trim();

/** "Sorriso / Lucas do Rio Verde" -> ["sorriso", "lucas do rio verde"]; "Paranaguá - PR (CIF Porto)" -> ["paranagua pr"] */
export function partesDaPraca(regiao) {
  return norm(regiao)
    .split("/")
    .map((x) => x.trim())
    .filter(Boolean);
}
export const ehPracaCif = (regiao) => /cif|porto/i.test(regiao ?? "");

export const LIMITES = {
  minimoDePares: 2, // praças em comum necessárias para comparar
  toleranciaDaMediaPct: 2.5, // |diferença média| máxima (praças em comum)
  toleranciaAbsolutaPct: 3.5, // diferença absoluta média máxima (praças em comum)
  toleranciaDaMediaDaUfPct: 4.0, // sem praças em comum suficientes: compara a média da UF, com margem maior (conjuntos de praças diferentes)
};

/**
 * @param coleta-b [{ cidade, preco }] praças do Fonte B do produto/UF (dia mais recente de cada uma)
 * @param outras [{ regiao, preco, data_referencia }] linhas de OUTRAS fontes (mesmo produto/UF, últimos dias; a mais recente por praça)
 * @returns { decisao: "lacuna" | "concorda" | "diverge" | "sem_como_comparar", pares, mediaPct, absPct }
 */
export function compararComNossasFontes(coleta-b, outras) {
  const usaveis = (outras ?? []).filter((o) => !ehPracaCif(o.regiao) && Number.isFinite(o.preco) && o.preco > 0);
  if (usaveis.length === 0) return { decisao: "lacuna", pares: 0, mediaPct: null, absPct: null };
  const ultima = new Map(); // parte normalizada da praça -> preço mais recente
  for (const o of [...usaveis].sort((a, b) => a.data_referencia.localeCompare(b.data_referencia))) {
    for (const parte of partesDaPraca(o.regiao)) ultima.set(parte, o.preco);
  }
  const difs = [];
  for (const a of coleta-b) {
    const c = norm(a.cidade);
    const ref = ultima.get(c);
    if (ref && Number.isFinite(a.preco)) difs.push(((a.preco - ref) / ref) * 100);
  }
  if (difs.length < LIMITES.minimoDePares) {
    // poucas praças em comum: confere pela média da UF (sem praça CIF). Só aprova se estiver bem perto; se estiver longe, segura.
    const ultimasPorRegiao = new Map();
    for (const o of [...usaveis].sort((a, b) => a.data_referencia.localeCompare(b.data_referencia))) ultimasPorRegiao.set(o.regiao, o.preco);
    const precosOutras = [...ultimasPorRegiao.values()];
    const mediaOutras = precosOutras.reduce((x, y) => x + y, 0) / precosOutras.length;
    const mediaAg = coleta-b.reduce((x, y) => x + y.preco, 0) / coleta-b.length;
    const pct = Math.round(((mediaAg - mediaOutras) / mediaOutras) * 1000) / 10;
    if (precosOutras.length >= 3 && Math.abs(pct) <= LIMITES.toleranciaDaMediaDaUfPct) return { decisao: "concorda", pares: difs.length, mediaPct: pct, absPct: Math.abs(pct), pelaMediaDaUf: true };
    return { decisao: "sem_como_comparar", pares: difs.length, mediaPct: pct, absPct: Math.abs(pct) };
  }
  const mediaPct = difs.reduce((s, x) => s + x, 0) / difs.length;
  const absPct = difs.reduce((s, x) => s + Math.abs(x), 0) / difs.length;
  const concorda = Math.abs(mediaPct) <= LIMITES.toleranciaDaMediaPct && absPct <= LIMITES.toleranciaAbsolutaPct;
  return { decisao: concorda ? "concorda" : "diverge", pares: difs.length, mediaPct: Math.round(mediaPct * 10) / 10, absPct: Math.round(absPct * 10) / 10 };
}
