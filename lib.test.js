const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRelease, stripHtml } = require('./lib');

test('stripHtml removes tags and collapses whitespace', () => {
  assert.equal(stripHtml('<font size="3">Olá   mundo</font>'), 'Olá mundo');
});

test('normalizeRelease marks a future, planned tender as aberto', () => {
  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const release = {
    ocid: 'ocds-test-1',
    date: '2026-01-01T00:00:00Z',
    tender: {
      title: 'Teste',
      description: '<p>Descrição</p>',
      status: 'planned',
      tenderPeriod: { startDate: future, endDate: future },
      value: { amount: 1000, currency: 'MZN' },
      procuringEntity: { name: 'Entidade Teste' },
      documents: [{ title: 'Doc', url: 'https://example.com/doc.pdf' }],
    },
  };
  const result = normalizeRelease(release);
  assert.equal(result.status, 'aberto');
  assert.equal(result.title, 'Teste');
  assert.equal(result.description, 'Descrição');
  assert.equal(result.buyerName, 'Entidade Teste');
});

test('normalizeRelease marks a past-deadline tender as expirado even if OCDS status is planned', () => {
  const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const release = {
    ocid: 'ocds-test-2',
    tender: { title: 'Expirado', status: 'planned', tenderPeriod: { endDate: past } },
  };
  assert.equal(normalizeRelease(release).status, 'expirado');
});

test('normalizeRelease marks a cancelled tender as cancelado regardless of deadline', () => {
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const release = {
    ocid: 'ocds-test-3',
    tender: { title: 'Cancelado', status: 'cancelled', tenderPeriod: { endDate: future } },
  };
  assert.equal(normalizeRelease(release).status, 'cancelado');
});
