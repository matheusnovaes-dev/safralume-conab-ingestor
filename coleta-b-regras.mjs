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
    const temNivelEstado = usaveis.some((o) => !o.regiao);
    if ((precosOutras.length >= 3 || temNivelEstado) && Math.abs(pct) <= LIMITES.toleranciaDaMediaDaUfPct) return { decisao: "concorda", pares: difs.length, mediaPct: pct, absPct: Math.abs(pct), pelaMediaDaUf: true };
    return { decisao: "sem_como_comparar", pares: difs.length, mediaPct: pct, absPct: Math.abs(pct) };
  }
  const mediaPct = difs.reduce((s, x) => s + x, 0) / difs.length;
  const absPct = difs.reduce((s, x) => s + Math.abs(x), 0) / difs.length;
  const concorda = Math.abs(mediaPct) <= LIMITES.toleranciaDaMediaPct && absPct <= LIMITES.toleranciaAbsolutaPct;
  return { decisao: concorda ? "concorda" : "diverge", pares: difs.length, mediaPct: Math.round(mediaPct * 10) / 10, absPct: Math.round(absPct * 10) / 10 };
}

// ---- praças de porto e densidade ----
/** Cidades-porto: o app só reconhece praça de porto pelo texto "CIF" no nome (convenção da BBM), então o Fonte B recebe o mesmo sufixo. */
const PORTOS = new Set(["paranagua", "rio grande", "santos", "sao francisco do sul", "itaqui", "sao luis", "barcarena", "santarem", "tubarao", "antonina", "imbituba", "cabedelo", "itajai", "aratu", "vitoria"]);
export const nomeDaPraca = (cidade) => (PORTOS.has(norm(cidade)) ? `${cidade} (CIF Porto)` : cidade);

/** No máximo K praças de interior por produto/UF/dia: as que casam com praças das outras fontes primeiro (continuidade), depois ordem de nome (estável). Portos entram à parte (até 2). */
export const MAX_PRACAS_POR_UF = 10;
export function escolherPracas(pracas, outras, k = MAX_PRACAS_POR_UF) {
  const conhecidas = new Set();
  for (const o of outras ?? []) for (const parte of partesDaPraca(o.regiao)) conhecidas.add(parte);
  const interior = pracas.filter((x) => !PORTOS.has(norm(x.cidade)));
  const portos = pracas.filter((x) => PORTOS.has(norm(x.cidade))).slice(0, 2);
  const ordenadas = [...interior].sort((a, b) => Number(conhecidas.has(norm(b.cidade))) - Number(conhecidas.has(norm(a.cidade))) || norm(a.cidade).localeCompare(norm(b.cidade)));
  return [...ordenadas.slice(0, k), ...portos];
}
