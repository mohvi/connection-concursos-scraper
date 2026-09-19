// Daily job: pulls the newest releases from UFSA's public OCDS feed, stores
// genuinely new tenders in Firebase (for the "Concursos" tab in the app),
// and emails companies with moduloSMS active about new open opportunities.
//
// Usage:
//   node run.js            (writes to Firebase, sends real emails)
//   node run.js --dry-run  (prints what it would do, no writes, no emails)
require('dotenv').config();
const { initializeApp, cert } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { fetchReleasesPage, normalizeRelease } = require('./lib');

const DRY_RUN = process.argv.includes('--dry-run');
const SEND_EMAIL_URL = process.env.SEND_EMAIL_URL || 'https://mohvi-sendmail.vercel.app/send-email';
const MAX_PAGES_PER_RUN = 6; // 6 * 50 = 300 newest releases checked per run
const MAX_EMAILS_PER_RUN = 40; // same rate-limit ceiling reasoning as the email-campaigns job

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({
  credential: cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});
const db = getDatabase();

const safeKey = (ocid) => ocid.replace(/[.#$/[\]]/g, '_');

const hasActiveModuloSMS = (company, now) => {
  const mod = company.activeModules?.moduloSMS;
  if (!mod || mod.status !== 'active') return false;
  return !mod.expiresAt || mod.expiresAt > now;
};

const isVerified = (company) => {
  const v = company?.subscriptions?.isverify;
  return v === true || v === 'true';
};

const formatMT = (amount, currency) => {
  if (amount == null) return null;
  const n = Number(amount).toLocaleString('pt-MZ');
  return `${n} ${currency || 'MZN'}`;
};

const describeTender = (tender) => {
  const deadline = tender.submissionDeadline
    ? new Date(tender.submissionDeadline).toLocaleString('pt-PT', { dateStyle: 'medium', timeStyle: 'short' })
    : 'não especificado';
  const value = formatMT(tender.valueAmount, tender.valueCurrency);
  return `${tender.title}
Entidade: ${tender.buyerName || 'não especificado'}
${value ? `Valor estimado: ${value}\n` : ''}Prazo de submissão: ${deadline}
${tender.description ? `${tender.description}\n` : ''}`;
};

// One digest email per run (not one email per tender) — nobody wants 5
// separate emails the day 5 tenders happen to appear.
const buildDigestEmail = (tenders) => {
  const subject = tenders.length === 1
    ? `Novo concurso público: ${tenders[0].title}`
    : `${tenders.length} novos concursos públicos na UFSA`;

  const text = `Novo(s) concurso(s) publicado(s) pela UFSA (Unidade Funcional de Supervisão das Aquisições):

${tenders.map(describeTender).join('\n---\n\n')}
Consulte os detalhes e documentos oficiais em: https://ufsa.dotcom.co.mz/concursos

Também pode consultar todos os concursos abertos na aba "Concursos" da Connection Mozambique:
https://www.connectionmozambique.com/concursos

Equipa Connection Mozambique`;

  return { subject, text };
};

async function sendEmail(to, subject, text) {
  if (DRY_RUN) return { success: true, dryRun: true };
  const response = await fetch(SEND_EMAIL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, subject, text }),
  });
  const data = await response.json().catch(() => ({}));
  return { success: response.ok && data.success !== false, status: response.status, data };
}

async function run() {
  const now = Date.now();

  // 1. Fetch the newest releases from UFSA and normalize them.
  const releases = [];
  for (let page = 0; page < MAX_PAGES_PER_RUN; page += 1) {
    const data = await fetchReleasesPage(page);
    const content = data.content || data.page?.content || [];
    if (content.length === 0) break;
    content.forEach((release) => releases.push(normalizeRelease(release, now)));
  }
  console.log(`Lidas ${releases.length} releases da UFSA (até ${MAX_PAGES_PER_RUN} páginas).`);

  // 2. Keep only the latest release per ocid (releases arrive newest-first).
  const latestByOcid = new Map();
  releases.forEach((tender) => {
    if (!latestByOcid.has(tender.ocid)) latestByOcid.set(tender.ocid, tender);
  });

  // 3. Find which of these are genuinely new to us.
  const existingSnapshot = await db.ref('concursos_publicos').once('value');
  const existing = existingSnapshot.val() || {};
  const newTenders = [];
  for (const tender of latestByOcid.values()) {
    const key = safeKey(tender.ocid);
    if (existing[key]) continue; // already known — a future job could refresh status here if needed
    newTenders.push({ key, ...tender });
  }
  console.log(`Concursos novos encontrados: ${newTenders.length}`);

  // 4. Persist all new tenders (regardless of status — cancelled ones matter for the record too).
  if (!DRY_RUN) {
    const writes = {};
    newTenders.forEach((tender) => {
      const { key, ...data } = tender;
      writes[`concursos_publicos/${key}`] = { ...data, firstSeenAt: new Date(now).toISOString(), notifiedAt: null };
    });
    if (Object.keys(writes).length > 0) await db.ref().update(writes);
  }

  // 5. Notify companies with moduloSMS active about new OPEN tenders only.
  const openNewTenders = newTenders.filter((t) => t.status === 'aberto');
  console.log(`Concursos novos e abertos (a notificar): ${openNewTenders.length}`);

  if (openNewTenders.length === 0) {
    console.log('Nada para notificar nesta corrida.');
    return;
  }

  const companiesSnapshot = await db.ref('company').once('value');
  const companies = companiesSnapshot.val() || {};
  const recipients = Object.values(companies).filter(
    (c) => c?.email && isVerified(c) && hasActiveModuloSMS(c, now),
  );
  console.log(`Empresas elegíveis (moduloSMS ativo e verificadas): ${recipients.length}`);

  const { subject, text } = buildDigestEmail(openNewTenders);
  const sendTo = recipients.slice(0, MAX_EMAILS_PER_RUN);
  if (recipients.length > MAX_EMAILS_PER_RUN) {
    console.log(`Mais destinatários (${recipients.length}) do que o limite por execução (${MAX_EMAILS_PER_RUN}) — os restantes não recebem este digest, mas os concursos continuam visíveis na aba "Concursos".`);
  }

  let emailsSent = 0;
  for (const company of sendTo) {
    const outcome = await sendEmail(company.email, subject, text);
    if (outcome.success) emailsSent += 1;
    else console.log(`  FALHOU: ${company.email}`);
  }

  if (!DRY_RUN) {
    const notifiedWrites = {};
    openNewTenders.forEach((tender) => {
      notifiedWrites[`concursos_publicos/${tender.key}/notifiedAt`] = new Date(now).toISOString();
    });
    await db.ref().update(notifiedWrites);
  }

  console.log(`Digest enviado a ${emailsSent}/${sendTo.length} empresas (${DRY_RUN ? 'dry-run' : 'real'}).`);
}

run()
  .then(() => process.exit(0))
  .catch((error) => { console.error('ERRO FATAL', error); process.exit(1); });
