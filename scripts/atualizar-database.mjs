// Gera o arquivo de dados do Dashboard a partir do Azure DevOps.
// Pais (US, User Story Design, Problema) em nome do RESPONSAVEL + todos os filhos deles.
import { writeFileSync } from 'node:fs';

const ORG = 'lamoda';
const PROJETO = 'Digital';
const RESPONSAVEL = 'gustavo.arruda@lamoda.com.br';
const TIPOS_PAI = ['User Story', 'User Story Design', 'Problema'];
const ARQUIVO = process.env.ARQUIVO_SAIDA || 'database.json';
const PAT = process.env.AZDO_PAT;

const BASE = `https://dev.azure.com/${ORG}/${encodeURIComponent(PROJETO)}/_apis/wit`;
const CAMPOS = [
  'System.Id', 'System.WorkItemType', 'System.Title', 'System.State',
  'System.IterationPath', 'System.AssignedTo', 'System.Tags', 'System.Parent',
  'System.CreatedDate', 'System.ChangedDate',
  'Microsoft.VSTS.Scheduling.StoryPoints',
  'Microsoft.VSTS.Common.ActivatedDate', 'Microsoft.VSTS.Common.ClosedDate'
];

async function chamarAzure(url, corpo) {
  const auth = 'Basic ' + Buffer.from(':' + PAT).toString('base64');
  let ultimoErro;
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': auth, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(corpo)
      });
      // PAT inválido às vezes volta 203 com página de login em HTML, em vez de 401
      const ehJson = (res.headers.get('content-type') || '').includes('application/json');
      if (res.status === 401 || res.status === 403 || (res.ok && !ehJson)) {
        throw Object.assign(new Error(`Falha de autenticação no Azure DevOps (HTTP ${res.status}). Confira se o Secret AZDO_PAT existe, não venceu e tem Work Items: Read.`), { definitivo: true });
      }
      if (!res.ok) throw new Error(`Azure DevOps respondeu HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return await res.json();
    } catch (err) {
      if (err.definitivo) throw err;
      ultimoErro = err;
      if (tentativa < 3) await new Promise(r => setTimeout(r, 2000 * tentativa));
    }
  }
  throw ultimoErro;
}

function wiql(query) {
  return chamarAzure(`${BASE}/wiql?api-version=7.1`, { query });
}

const filtroPais = (prefixo) => `${prefixo}[System.WorkItemType] IN (${TIPOS_PAI.map(t => `'${t}'`).join(', ')})
  AND ${prefixo}[System.AssignedTo] = '${RESPONSAVEL}'`;

async function buscarIdsPais() {
  const r = await wiql(`SELECT [System.Id] FROM WorkItems
WHERE [System.TeamProject] = @project
  AND ${filtroPais('')}`);
  return (r.workItems || []).map(w => w.id);
}

async function buscarIdsFilhos() {
  const r = await wiql(`SELECT [System.Id] FROM WorkItemLinks
WHERE ${filtroPais('[Source].')}
  AND [System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward'
MODE (MustContain)`);
  return (r.workItemRelations || [])
    .filter(rel => rel.rel === 'System.LinkTypes.Hierarchy-Forward' && rel.target)
    .map(rel => rel.target.id);
}

async function buscarItens(ids) {
  const itens = [];
  for (let i = 0; i < ids.length; i += 200) {
    const r = await chamarAzure(`${BASE}/workitemsbatch?api-version=7.1`, {
      ids: ids.slice(i, i + 200), fields: CAMPOS, errorPolicy: 'Omit'
    });
    itens.push(...(r.value || []).filter(Boolean));
  }
  return itens;
}

function diasCiclo(f) {
  if (f['System.State'] !== 'Closed') return null;
  const inicio = f['Microsoft.VSTS.Common.ActivatedDate'] || f['System.CreatedDate'];
  const fim = f['Microsoft.VSTS.Common.ClosedDate'] || f['System.ChangedDate'];
  if (!inicio || !fim) return null;
  const dias = (new Date(fim) - new Date(inicio)) / 86400000;
  return dias > 0 ? Math.round(dias * 10) / 10 : null;
}

function paraLinha(wi) {
  const f = wi.fields || {};
  return {
    ID: wi.id,
    Tipo: f['System.WorkItemType'] || '',
    Titulo: f['System.Title'] || '',
    Status: f['System.State'] || '',
    Sprint: f['System.IterationPath'] || '',
    Responsavel: f['System.AssignedTo']?.displayName || 'Não atribuído',
    Tags: f['System.Tags'] || '',
    ID_Pai: f['System.Parent'] ?? 'Nenhum',
    Story_Points: f['Microsoft.VSTS.Scheduling.StoryPoints'] ?? null,
    Data_Criacao: f['System.CreatedDate'] || '',
    Ultima_Alteracao: f['System.ChangedDate'] || '',
    Dias_Ciclo: diasCiclo(f),
    URL: `https://dev.azure.com/${ORG}/${encodeURIComponent(PROJETO)}/_workitems/edit/${wi.id}`
  };
}

async function main() {
  if (!PAT) throw new Error('Secret AZDO_PAT não encontrado. Crie em Settings → Secrets and variables → Actions.');

  const idsPais = await buscarIdsPais();
  if (idsPais.length === 0) {
    throw new Error(`Nenhum pai encontrado para ${RESPONSAVEL}. Nada foi gravado, para não apagar o Dashboard.`);
  }
  const idsFilhos = await buscarIdsFilhos();
  const ids = Array.from(new Set([...idsPais, ...idsFilhos]));

  const itens = (await buscarItens(ids)).map(paraLinha).sort((a, b) => a.ID - b.ID);
  if (itens.length === 0) throw new Error('O Azure não devolveu nenhum item. Nada foi gravado.');

  const saida = { geradoEm: new Date().toISOString(), itens };
  writeFileSync(ARQUIVO, JSON.stringify(saida, null, 2) + '\n', 'utf8');

  // Repositório público: o log mostra só contagens, nunca títulos ou nomes
  const porTipo = {};
  itens.forEach(it => { porTipo[it.Tipo] = (porTipo[it.Tipo] || 0) + 1; });
  console.log(`Pais: ${idsPais.length} | Filhos: ${idsFilhos.length} | Itens gravados: ${itens.length}`);
  console.log('Por tipo:', JSON.stringify(porTipo));
  console.log(`Arquivo: ${ARQUIVO}`);
}

main().catch(err => {
  console.error('ERRO:', err.message);
  process.exit(1);
});
