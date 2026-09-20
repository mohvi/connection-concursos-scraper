// Talks to the real, official UFSA site — https://www.ufsa.gov.mz/concursos.php
// (confirmed against https://ufsa.dotcom.co.mz/, which turned out to be a
// separate system still full of placeholder/test entries, not production
// data). The "Concursos Abertos" listing is rendered by a small AJAX
// endpoint that returns a plain HTML table, no JS execution required —
// found by inspecting the page's own network requests.
//
// robots.txt sets `Crawl-delay: 10` for all bots. We make exactly one
// request per run to this endpoint (it returns every open tender at once,
// no pagination), so that's trivially respected.
const cheerio = require('cheerio');

const LISTING_URL = 'https://www.ufsa.gov.mz/query/Busca_concurso1.php?dado=&dt=';
const DETAIL_URL = (reference) => `https://www.ufsa.gov.mz/concurso_detalhes.php?referencia=${encodeURIComponent(reference)}`;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();

// The bytes are genuinely UTF-8 (the page's own <meta charset=iso-8859-1> is
// stale/wrong — decoding as Latin-1 makes accents worse, not better). The
// real artifact is upstream, on UFSA's own system: some fields (Objecto
// Geral in particular) come back with correctly-encoded but wrongly-cased
// accented letters ("AQUISIçãO" instead of "AQUISIÇÃO") — a classic
// PHP `strtoupper()`-only-uppercases-ASCII-bytes bug baked into their stored
// data. Since this system's convention is ALL CAPS throughout, normalizing
// case is a safe, targeted fix rather than a guess.
const fixUpstreamCasing = (value) => (value ? value.toUpperCase() : value);

// "2026-09-21" + "08H00" -> ISO datetime (server is in Mozambique local
// time, CAT/UTC+2, which has no DST — safe to hardcode the offset).
const parseDateTime = (dateStr, timeStr) => {
  if (!dateStr) return null;
  const time = (timeStr || '00H00').replace('H', ':');
  const iso = `${dateStr}T${time}:00+02:00`;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

const fetchOpenTenders = async () => {
  const res = await fetch(LISTING_URL, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' } });
  if (!res.ok) throw new Error(`UFSA respondeu ${res.status} em ${LISTING_URL}`);
  const html = await res.text();
  return parseListingHtml(html);
};

const parseListingHtml = (html) => {
  const $ = cheerio.load(html);
  const tenders = [];

  $('#lista > tbody > tr, table#lista > tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 6) return;

    const col0 = $(cells[0]);
    const referenceLink = col0.find('a');
    const href = referenceLink.attr('href') || '';
    const referenceMatch = href.match(/referencia=(.+)$/);
    const reference = referenceMatch ? decodeURIComponent(referenceMatch[1]) : clean(col0.text()).split(':').pop();
    const modality = clean(col0.text()).split(':')[0];

    const objectoRaw = clean($(cells[1]).text());
    const [category, ...rest] = objectoRaw.split(':');
    const objecto = rest.join(':').trim() || objectoRaw;

    const buyerName = clean($(cells[2]).text());
    const provincia = clean($(cells[3]).text());
    const launchDate = clean($(cells[4]).text());
    // <br/> produces no whitespace in cheerio's .text(), so "2026-09-21" and
    // "08H00" arrive concatenated ("2026-09-2108H00") — pull each out by shape.
    const openingCellText = clean($(cells[5]).text());
    const openingDate = (openingCellText.match(/\d{4}-\d{2}-\d{2}/) || [])[0] || null;
    const openingTime = (openingCellText.match(/\d{2}H\d{2}/) || [])[0] || null;

    if (!reference) return;

    tenders.push({
      reference,
      modality,
      category: category ? clean(category) : null,
      title: objecto || modality,
      buyerName: buyerName || null,
      provincia: provincia || null,
      launchDate: launchDate || null,
      submissionDeadline: parseDateTime(openingDate, openingTime),
      sourceUrl: DETAIL_URL(reference),
    });
  });

  return tenders;
};

// Resolves our own status from the submission deadline. Every tender coming
// from this endpoint is, by definition, currently listed as open by UFSA;
// we only downgrade it ourselves once the deadline has actually passed.
// `details` is optional (from fetchTenderDetails) — merged in when available.
const normalizeTender = (tender, now = Date.now(), details = null) => {
  const deadline = tender.submissionDeadline ? Date.parse(tender.submissionDeadline) : null;
  const status = deadline && deadline < now ? 'expirado' : 'aberto';
  const valorEstimado = details?.valorEstimado ? Number(details.valorEstimado) : null;
  return {
    ...tender,
    status,
    description: details?.objetoGeral || tender.title,
    valueAmount: Number.isFinite(valorEstimado) && valorEstimado > 0 ? valorEstimado : null,
    valueCurrency: details?.moeda || null,
    documents: details?.documents || [],
    releaseDate: tender.launchDate,
  };
};

// Detail page has a label/value table (<th>Valor Estimado:</th><td>650000.00</td>,
// sometimes <th>label</th><th>value</th> instead of th/td) plus two download
// links at the bottom (Baixar_anuncio.php, Baixar_cad_enc.php). Technique
// confirmed against a same-purpose scraper found already on this machine
// (c:\Users\moham\scraper-concursos, dormant since Oct 2025) — its own
// find-by-label approach, reimplemented here with cheerio instead of Puppeteer
// since the detail pages, like the listing, don't need JS execution.
const LABEL_FIELD_MAP = {
  'valor estimado': 'valorEstimado',
  'moeda': 'moeda',
  'garantia provis': 'garantiaProvisoria', // matches "provisória" regardless of encoding
  'criterio de adjudicacao': 'criterioAdjudicacao',
  'critério de adjudicação': 'criterioAdjudicacao',
  'numero de lotes': 'numeroLotes',
  'entrega de propostas': 'localEntrega',
  'regime': 'regime',
  'classe': 'classeDetalhada',
  'objecto geral': 'objetoGeral',
  'objeto geral': 'objetoGeral',
  'ugea': 'ugeaDetalhada',
  'observa': 'observacoes',
  'data de publica': 'dataPublicacao',
};

const matchLabel = (label) => {
  const normalized = label.toLowerCase();
  for (const [key, field] of Object.entries(LABEL_FIELD_MAP)) {
    if (normalized.includes(key)) return field;
  }
  return null;
};

const fetchTenderDetails = async (detailUrl) => {
  const res = await fetch(detailUrl, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' } });
  if (!res.ok) throw new Error(`UFSA respondeu ${res.status} em ${detailUrl}`);
  const html = await res.text();
  return parseDetailHtml(html, detailUrl);
};

const parseDetailHtml = (html, detailUrl) => {
  const $ = cheerio.load(html);
  const details = {};

  $('tr').each((_, row) => {
    const cells = $(row).find('th, td').filter((__, cell) => clean($(cell).text()) !== '');
    if (cells.length < 2) return;
    const label = clean($(cells[0]).text());
    if (!label.endsWith(':')) return;
    const field = matchLabel(label);
    if (!field || details[field]) return;
    const value = clean($(cells[1]).text());
    if (!value) return;
    // "Objecto Geral" is the field observed with the casing artifact; other
    // fields on this page (codes, UGEA names, dates) come through clean.
    details[field] = field === 'objetoGeral' ? fixUpstreamCasing(value) : value;
  });

  const documents = [];
  $('a[href*="Baixar_anuncio"]').each((_, a) => {
    documents.push({ title: 'Anúncio', url: new URL($(a).attr('href'), detailUrl).toString() });
  });
  $('a[href*="Baixar_cad_enc"]').each((_, a) => {
    documents.push({ title: 'Documento de concurso', url: new URL($(a).attr('href'), detailUrl).toString() });
  });

  return { ...details, documents };
};

module.exports = {
  fetchOpenTenders, parseListingHtml, normalizeTender, DETAIL_URL,
  fetchTenderDetails, parseDetailHtml,
};
