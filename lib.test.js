const test = require('node:test');
const assert = require('node:assert/strict');
const { parseListingHtml, normalizeTender } = require('./lib');

const SAMPLE_ROW = `
<table width='800' border='0' id='lista' class='tabela' >
<tr align='left'>
<td width='170'>AJUSTE DIRECTO:<br />31I001841/AD/03<br />
/2026<br/><a href='concurso_detalhes.php?referencia=31I001841/AD/03/2026'>Ver detalhes</a><br/> </td>
<td width='200'>BENS E SERVICOS:<br/> SERVICO DE MANUTENCAO E REPARACAO DE VIATURAS <br/><br/></td>
<td width='175'>DELEGACAO DISTRITAL DE TESTE <br/><br/></td>
<td width='100'>INHAMBANE</td>
<td width='65' align='right'>2026-09-16</td>
<td width='75' align='right'>2026-09-21<br/>08H00<br/></td>
</tr>
</table>
`;

test('parseListingHtml extracts every field from a real UFSA row', () => {
  const [tender] = parseListingHtml(SAMPLE_ROW);
  assert.equal(tender.reference, '31I001841/AD/03/2026');
  assert.equal(tender.modality, 'AJUSTE DIRECTO');
  assert.equal(tender.category, 'BENS E SERVICOS');
  assert.equal(tender.title, 'SERVICO DE MANUTENCAO E REPARACAO DE VIATURAS');
  assert.equal(tender.buyerName, 'DELEGACAO DISTRITAL DE TESTE');
  assert.equal(tender.provincia, 'INHAMBANE');
  assert.equal(tender.launchDate, '2026-09-16');
});

test('parseListingHtml correctly separates date and time despite <br/> collapsing whitespace', () => {
  const [tender] = parseListingHtml(SAMPLE_ROW);
  // 08H00 in Mozambique (UTC+2, no DST) is 06:00 UTC.
  assert.equal(tender.submissionDeadline, '2026-09-21T06:00:00.000Z');
});

test('normalizeTender marks a future deadline as aberto', () => {
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const result = normalizeTender({ reference: 'x', title: 'Teste', submissionDeadline: future });
  assert.equal(result.status, 'aberto');
});

test('normalizeTender marks a past deadline as expirado', () => {
  const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const result = normalizeTender({ reference: 'x', title: 'Teste', submissionDeadline: past });
  assert.equal(result.status, 'expirado');
});
