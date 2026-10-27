// Cálculo do PLACAR do padrão do ano (teste sem espiar o futuro). Funções puras, sem rede: o job mensal (placar-mensal.mjs) e o script do app
// (dados/placar/placar3-serie.mjs) usam ESTE arquivo, e um teste do app confere que o resultado é igual ao de src/lib/sazonalidade.ts (calcularSazonalidade).
const MESES_ANOS_MINIMOS = 3;
const MESES_NO_ANO_MINIMOS = 11;
export const CONSISTENCIA_MINIMA = 0.7;
export const AMPLITUDE_MINIMA = 0.03;
export const LIMITE_ACERTO = 55;
export const MIN_CASOS = 30;
const media = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Mesma conta de calcularSazonalidade (src/lib/sazonalidade.ts), só com os campos que o placar usa. `hoje` define o ano de corte (só entram anos anteriores). */
export function sazonalidadeDoMes(serie, anoDeTeste, mesAlvo, anosDeHistorico = 10) {
  const porAno = new Map();
  for (const p of serie) {
    if (!Number.isFinite(p.valor) || p.valor <= 0) continue;
    if (!porAno.has(p.ano)) porAno.set(p.ano, new Map());
    porAno.get(p.ano).set(p.mes, p.valor);
  }
  const anos = [...porAno.entries()].filter(([ano, meses]) => ano < anoDeTeste && meses.size >= MESES_NO_ANO_MINIMOS).sort((a, b) => b[0] - a[0]).slice(0, anosDeHistorico);
  if (anos.length < MESES_ANOS_MINIMOS) return null;
  const razoesPorMes = new Map();
  for (const [, meses] of anos) {
    const mediaDoAno = media([...meses.values()]);
    for (const [mes, valor] of meses) razoesPorMes.set(mes, [...(razoesPorMes.get(mes) ?? []), valor / mediaDoAno]);
  }
  const indices = new Map();
  for (const [mes, razoes] of razoesPorMes) if (razoes.length >= MESES_ANOS_MINIMOS) indices.set(mes, media(razoes));
  const indiceDoMes = indices.get(mesAlvo);
  if (indiceDoMes == null || indices.size < 10) return null;
  const ordenados = [...indices.entries()].sort((a, b) => b[1] - a[1]);
  const razoesDoMes = razoesPorMes.get(mesAlvo) ?? [];
  const anosDeAcordo = razoesDoMes.filter((r) => (indiceDoMes >= 1 ? r >= 1 : r < 1)).length;
  return { indiceDoMes, anosUsados: razoesDoMes.length, anosDeAcordo, amplitude: ordenados[0][1] - ordenados.at(-1)[1] };
}

const r1 = (x) => Math.round(x * 10) / 10;
const NOME = { "soja-em-grao-sc-60kg": "Soja", "milho-seco-sc-60kg": "Milho", "boi-gordo-15kg": "Boi gordo", "vaca-gorda": "Vaca gorda", "trigo-em-grao-nacional-sc-60kg": "Trigo", arroz: "Arroz", feijao: "Feijão", ovos: "Ovos", "cafe-arabica-duro-sc-60kg": "Café arábica", "algodao-em-pluma-15kg": "Algodão", "cana-de-acucar": "Cana de açúcar" };

/** rows: linhas de historico_mensal {produto, uf, ano, mes, valor}. Devolve { series, acertos, resumo } no formato que o app lê. */
export function calcularPlacar(rows, anoIni = 2014, anoFim = 2025) {
  const por = new Map();
  for (const r of rows) { const k = `${r.produto}|${r.uf}`; if (!por.has(k)) por.set(k, []); por.get(k).push({ ano: r.ano, mes: r.mes, valor: Number(r.valor) }); }
  const series = [], acertos = {};
  for (const [k, serie] of [...por].sort((a, b) => a[0].localeCompare(b[0]))) {
    const [prod, uf] = k.split("|"); const meses = new Map();
    for (const p of serie) { if (!meses.has(p.ano)) meses.set(p.ano, new Map()); meses.get(p.ano).set(p.mes, p.valor); }
    const anos = []; let n = 0, ok = 0;
    for (let Y = anoIni; Y <= anoFim; Y++) {
      const my = meses.get(Y); if (!my || my.size < 11) continue;
      const mediaY = [...my.values()].reduce((a, b) => a + b, 0) / my.size;
      const prev = [], real = [], afirma = [];
      for (let M = 1; M <= 12; M++) {
        const s = sazonalidadeDoMes(serie, Y, M);
        real.push(my.has(M) ? r1((my.get(M) / mediaY - 1) * 100) : null);
        if (!s) { prev.push(null); afirma.push(0); continue; }
        const d = (s.indiceDoMes - 1) * 100; prev.push(r1(d));
        const firme = s.amplitude >= AMPLITUDE_MINIMA && Math.abs(d) >= 1 && s.anosDeAcordo / s.anosUsados >= CONSISTENCIA_MINIMA;
        afirma.push(firme ? (d > 0 ? 1 : -1) : 0);
        if (firme && my.has(M)) { n++; if ((d > 0) === (my.get(M) / mediaY >= 1)) ok++; }
      }
      anos.push({ y: Y, p: prev, r: real, a: afirma });
    }
    if (!anos.length) continue;
    const acerto = n ? r1((ok / n) * 100) : 0;
    acertos[k] = { casos: n, acerto };
    series.push({ k, c: NOME[prod] ?? prod, uf, q: n, a: acerto, passa: n >= MIN_CASOS && acerto >= LIMITE_ACERTO, anos });
  }
  const acc = (sr, y0, y1) => { let n = 0, ok = 0; for (const a of sr.anos) if (a.y >= y0 && a.y <= y1) a.a.forEach((c, i) => { if (c && a.r[i] != null) { n++; if ((c > 0) === (a.r[i] >= 0)) ok++; } }); return [n, ok]; };
  const pct = (ok, n) => (n ? r1((ok / n) * 100) : 0);
  const geral = series.reduce((t, sr) => { const [n, ok] = acc(sr, anoIni, anoFim); return [t[0] + n, t[1] + ok]; }, [0, 0]);
  const culturas = [...new Set(series.map((x) => x.c))].map((c) => {
    const ss = series.filter((x) => x.c === c); const [n, ok] = ss.reduce((t, sr) => { const [a, b] = acc(sr, anoIni, anoFim); return [t[0] + a, t[1] + b]; }, [0, 0]);
    return { nome: c, casos: n, acerto: pct(ok, n), estados: ss.map((x) => ({ uf: x.uf, casos: x.q, acerto: x.a, passa: x.passa })).sort((a, b) => b.acerto - a.acerto) };
  }).sort((a, b) => b.acerto - a.acerto);
  const anosGeral = []; for (let y = anoIni; y <= anoFim; y++) { const [n, ok] = series.reduce((t, sr) => { const [a, b] = acc(sr, y, y); return [t[0] + a, t[1] + b]; }, [0, 0]); anosGeral.push({ ano: y, casos: n, acerto: pct(ok, n) }); }
  const meio = anoIni + 5;
  const cego = { escolhidas: 0, rejeitadas: 0, acertoEscolhidas: [0, 0], acertoRejeitadas: [0, 0] };
  for (const sr of series) { const [n1, o1] = acc(sr, anoIni, meio); const [n2, o2] = acc(sr, meio + 1, anoFim); if (n1 < 15) continue; const alvo = (o1 / n1) * 100 >= LIMITE_ACERTO ? "Escolhidas" : "Rejeitadas"; cego[alvo.toLowerCase()]++; cego["acerto" + alvo][0] += n2; cego["acerto" + alvo][1] += o2; }
  const resumo = { geral: { casos: geral[0], acerto: pct(geral[1], geral[0]), series: series.length, passam: series.filter((x) => x.passa).length }, culturas, anos: anosGeral,
    cego: { escolhidas: cego.escolhidas, rejeitadas: cego.rejeitadas, acertoEscolhidas: pct(cego.acertoEscolhidas[1], cego.acertoEscolhidas[0]), casosEscolhidas: cego.acertoEscolhidas[0], acertoRejeitadas: pct(cego.acertoRejeitadas[1], cego.acertoRejeitadas[0]), casosRejeitadas: cego.acertoRejeitadas[0] } };
  return { series, acertos, resumo };
}
