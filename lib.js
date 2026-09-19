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
const normalizeTender = (tender, now = Date.now()) => {
  const deadline = tender.submissionDeadline ? Date.parse(tender.submissionDeadline) : null;
  const status = deadline && deadline < now ? 'expirado' : 'aberto';
  return {
    ...tender,
    status,
    description: tender.title,
    valueAmount: null,
    valueCurrency: null,
    documents: [],
    releaseDate: tender.launchDate,
  };
};

module.exports = { fetchOpenTenders, parseListingHtml, normalizeTender, DETAIL_URL };
