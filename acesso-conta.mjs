// Quem pode receber aviso automático (alerta, sinal de venda, resumo): mesma regra do bot e do painel
// (verificarAcessoWhatsapp em rural-heart-project): assinatura ativa, trial dentro do prazo,
// inadimplente ainda na carência de 24h, ou produtor coberto por cooperativa.
// Achado 2026-10-15 (teste das travas de plano): alerta de quem cancelou, teve o trial vencido ou
// foi cortado por inadimplência continuava disparando, porque nenhum checador olhava a assinatura.
export const HORAS_DE_GRACA = 24;

export async function produtoresComAcesso(supabase) {
  try {
    const agora = Date.now();
    const permitidos = new Set();
    const pagina = 1000;
    for (let de = 0; ; de += pagina) {
      const { data, error } = await supabase
        .from("assinaturas")
        .select("produtor_id, status, trial_expira_em, updated_at")
        .not("produtor_id", "is", null)
        .order("id")
        .range(de, de + pagina - 1);
      if (error) throw error;
      for (const a of data ?? []) {
        const trialValido =
          a.status === "trial" && a.trial_expira_em && new Date(a.trial_expira_em).getTime() > agora;
        const naGraca =
          a.status === "inadimplente" &&
          (agora - new Date(a.updated_at).getTime()) / 3_600_000 < HORAS_DE_GRACA;
        if (a.status === "ativa" || trialValido || naGraca) permitidos.add(a.produtor_id);
      }
      if (!data || data.length < pagina) break;
    }
    for (let de = 0; ; de += pagina) {
      const { data, error } = await supabase
        .from("produtores")
        .select("id")
        .not("cooperativa_id", "is", null)
        .order("id")
        .range(de, de + pagina - 1);
      if (error) throw error;
      for (const p of data ?? []) permitidos.add(p.id);
      if (!data || data.length < pagina) break;
    }
    return permitidos;
  } catch (err) {
    // Falha de leitura não pode calar todos os avisos de quem paga em dia: libera e avisa no log.
    console.error("Falha ao ler quem tem acesso; seguindo sem filtro:", err);
    return null;
  }
}

/** Filtra linhas que têm produtor_id; `null` (falha de leitura) não filtra nada. */
export function soComAcesso(linhas, permitidos, rotulo) {
  if (!permitidos) return linhas;
  const ficam = linhas.filter((l) => permitidos.has(l.produtor_id ?? l.id));
  const fora = linhas.length - ficam.length;
  if (fora > 0) console.log(`${rotulo}: ${fora} de conta sem acesso (cancelada, trial vencido ou cortada) ignorado(s).`);
  return ficam;
}
