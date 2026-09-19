// Talks to UFSA's public OCDS (Open Contracting Data Standard) feed —
// https://ufsa.dotcom.co.mz/ocds/releases — a no-auth, publicly documented
// API meant precisely for third-party consumption like this.
const OCDS_BASE = 'https://ufsa.dotcom.co.mz/ocds-publisher-service/api/ocds-releases';

const stripHtml = (value) => String(value || '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim();

const fetchReleasesPage = async (page, size = 50) => {
  const url = `${OCDS_BASE}?page=${page}&size=${size}&sort=createdAt,desc`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`UFSA OCDS respondeu ${res.status} em ${url}`);
  return res.json();
};

const OPEN_STATUSES = new Set(['planned', 'active']);
const CANCELLED_STATUSES = new Set(['cancelled', 'withdrawn', 'unsuccessful']);

// Collapses an OCDS release into the fields we actually keep, and resolves
// our own status vocabulary (aberto/cancelado/concluido/expirado) from the
// OCDS tender status plus whether the submission deadline has passed.
const normalizeRelease = (release, now = Date.now()) => {
  const tender = release.tender || {};
  const endDate = tender.tenderPeriod?.endDate ? Date.parse(tender.tenderPeriod.endDate) : null;
  const ocdsStatus = String(tender.status || '').toLowerCase();

  let status = 'aberto';
  if (CANCELLED_STATUSES.has(ocdsStatus)) status = 'cancelado';
  else if (ocdsStatus === 'complete') status = 'concluido';
  else if (endDate && endDate < now) status = 'expirado';
  else if (!OPEN_STATUSES.has(ocdsStatus)) status = 'expirado';

  return {
    ocid: release.ocid,
    title: tender.title || '(sem título)',
    description: stripHtml(tender.description).slice(0, 4000),
    status,
    ocdsStatus,
    submissionStart: tender.tenderPeriod?.startDate || null,
    submissionDeadline: tender.tenderPeriod?.endDate || null,
    valueAmount: tender.value?.amount ?? null,
    valueCurrency: tender.value?.currency || null,
    buyerName: tender.procuringEntity?.name || release.buyer?.name || null,
    documents: (tender.documents || []).map((doc) => ({
      title: doc.title || 'Documento',
      url: doc.url,
    })),
    releaseDate: release.date || null,
    sourceUrl: 'https://ufsa.dotcom.co.mz/concursos',
  };
};

module.exports = { fetchReleasesPage, normalizeRelease, stripHtml };
