// Daily job: pulls currently-open tenders from UFSA's official site
// (ufsa.gov.mz), stores genuinely new ones in Firebase (for the "Concursos"
// tab in the app), and emails companies with moduloSMS active about new
// open opportunities.
//
// Usage:
//   node run.js               (writes to Firebase, sends real emails)
//   node run.js --dry-run     (prints what it would do, no writes, no emails)
//   node run.js --skip-email  (writes to Firebase for real, never emails)
require('dotenv').config();
const { initializeApp, cert } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { fetchOpenTenders, normalizeTender } = require('./lib');

const DRY_RUN = process.argv.includes('--dry-run');
const SKIP_EMAIL = process.argv.includes('--skip-email');
const SEND_EMAIL_URL = process.env.SEND_EMAIL_URL || 'https://mohvi-sendmail.vercel.app/send-email';
// mohvi-sendmail's /send-email caps at 50 requests/15min per IP. Recipients
// here are a bounded, known population (paying moduloSMS customers), not an
// open-ended backlog — so instead of a hard cap that would silently and
// permanently skip whoever doesn't fit in the first batch every single day,
// we send in batches of BATCH_SIZE and wait out the rate-limit window
// between batches until everyone eligible actually gets the digest.
const BATCH_SIZE = 45;
const BATCH_WAIT_MS = 15 * 60 * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({
  credential: cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});
const db = getDatabase();

const safeKey = (reference) => reference.replace(/[.#$/[\]]/g, '_');

const hasActiveModuloSMS = (company, now) => {
  const mod = company.activeModules?.moduloSMS;
  if (!mod || mod.status !== 'active') return false;
  return !mod.expiresAt || mod.expiresAt > now;
};

const isVerified = (company) => {
  const v = company?.subscriptions?.isverify;
  return v === true || v === 'true';
};

const describeTender = (tender) => {
  const deadline = tender.submissionDeadline
    ? new Date(tender.submissionDeadline).toLocaleString('pt-PT', { dateStyle: 'medium', timeStyle: 'short' })
    : 'não especificado';
  return `[${tender.modality}] ${tender.title}
Entidade: ${tender.buyerName || 'não especificado'}
Província: ${tender.provincia || 'não especificado'}
Prazo de submissão: ${deadline}
Detalhes: ${tender.sourceUrl}`;
};

// One digest email per run (not one email per tender) — nobody wants 5
// separate emails the day 5 tenders happen to appear.
const buildDigestEmail = (tenders) => {
  const subject = tenders.length === 1
    ? `Novo concurso público: ${tenders[0].title}`
    : `${tenders.length} novos concursos públicos na UFSA`;

  const text = `Novo(s) concurso(s) publicado(s) pela UFSA (Unidade Funcional de Supervisão das Aquisições):

${tenders.map(describeTender).join('\n---\n\n')}

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

  // 1. Fetch every currently-open tender from UFSA (one request, no pagination).
  const raw = await fetchOpenTenders();
  const tenders = raw.map((tender) => normalizeTender(tender, now));
  console.log(`Lidos ${tenders.length} concursos abertos da UFSA.`);

  // 2. Find which of these are genuinely new to us.
  const existingSnapshot = await db.ref('concursos_publicos').once('value');
  const existing = existingSnapshot.val() || {};
  const newTenders = [];
  for (const tender of tenders) {
    const key = safeKey(tender.reference);
    if (existing[key]) continue;
    newTenders.push({ key, ...tender });
  }
  console.log(`Concursos novos encontrados: ${newTenders.length}`);

  // 3. Persist all new tenders.
  if (!DRY_RUN) {
    const writes = {};
    newTenders.forEach((tender) => {
      const { key, ...data } = tender;
      writes[`concursos_publicos/${key}`] = { ...data, firstSeenAt: new Date(now).toISOString(), notifiedAt: null };
    });
    if (Object.keys(writes).length > 0) await db.ref().update(writes);
  }

  // 4. Notify companies with moduloSMS active about new OPEN tenders only.
  const openNewTenders = newTenders.filter((t) => t.status === 'aberto');
  console.log(`Concursos novos e abertos (a notificar): ${openNewTenders.length}`);

  if (openNewTenders.length === 0) {
    console.log('Nada para notificar nesta corrida.');
    return;
  }

  if (SKIP_EMAIL) {
    console.log('--skip-email: dados gravados, mas nenhum email será enviado.');
    return;
  }

  const companiesSnapshot = await db.ref('company').once('value');
  const companies = companiesSnapshot.val() || {};
  const recipients = Object.values(companies).filter(
    (c) => c?.email && isVerified(c) && hasActiveModuloSMS(c, now),
  );
  console.log(`Empresas elegíveis (moduloSMS ativo e verificadas): ${recipients.length}`);

  const { subject, text } = buildDigestEmail(openNewTenders);
  const batches = [];
  for (let i = 0; i < recipients.length; i += BATCH_SIZE) batches.push(recipients.slice(i, i + BATCH_SIZE));
  if (batches.length > 1) {
    console.log(`${recipients.length} destinatários — a enviar em ${batches.length} lotes de até ${BATCH_SIZE}, com pausa de 15min entre lotes para respeitar o limite do servidor de email.`);
  }

  let emailsSent = 0;
  for (let b = 0; b < batches.length; b += 1) {
    if (b > 0 && !DRY_RUN) await sleep(BATCH_WAIT_MS);
    for (const company of batches[b]) {
      const outcome = await sendEmail(company.email, subject, text);
      if (outcome.success) emailsSent += 1;
      else console.log(`  FALHOU: ${company.email}`);
    }
  }

  if (!DRY_RUN) {
    const notifiedWrites = {};
    openNewTenders.forEach((tender) => {
      notifiedWrites[`concursos_publicos/${tender.key}/notifiedAt`] = new Date(now).toISOString();
    });
    await db.ref().update(notifiedWrites);
  }

  console.log(`Digest enviado a ${emailsSent}/${recipients.length} empresas (${DRY_RUN ? 'dry-run' : 'real'}).`);
}

run()
  .then(() => process.exit(0))
  .catch((error) => { console.error('ERRO FATAL', error); process.exit(1); });
