// PLACEHOLDER — derived from general most-visited-destination knowledge, not real
// VisaPath usage data (none exists yet as of this writing). Revisit and replace with
// real traffic-derived rankings once usage logs accumulate. See visapath-rag-handover.md §1.
//
// official_source_url is a best-effort guess at each country's current visa-info domain.
// tos_review_status starts "unreviewed" for every entry — the ingestion pipeline runs an
// automated robots.txt pre-check per source before first fetch, and any source it cannot
// clear automatically must be manually reviewed before ingestion proceeds for that country.
var OFFICIAL_TIER_COUNTRIES = [
  { country_code: "US", country_name: "United States", official_source_url: "https://travel.state.gov/content/travel/en/us-visas.html" },
  { country_code: "GB", country_name: "United Kingdom", official_source_url: "https://www.gov.uk/check-uk-visa" },
  { country_code: "CA", country_name: "Canada", official_source_url: "https://www.canada.ca/en/immigration-refugees-citizenship/services/visit-canada.html" },
  { country_code: "AU", country_name: "Australia", official_source_url: "https://immi.homeaffairs.gov.au" },
  { country_code: "JP", country_name: "Japan", official_source_url: "https://www.mofa.go.jp/j_info/visit/visa/index.html" },
  { country_code: "SG", country_name: "Singapore", official_source_url: "https://www.ica.gov.sg/enter-transit-depart/entering-singapore" },
  { country_code: "FR", country_name: "France", official_source_url: "https://france-visas.gouv.fr" },
  { country_code: "DE", country_name: "Germany", official_source_url: "https://www.auswaertiges-amt.de/en/visa-service" },
  { country_code: "IT", country_name: "Italy", official_source_url: "https://vistoperitalia.esteri.it" },
  { country_code: "ES", country_name: "Spain", official_source_url: "https://www.exteriores.gob.es/en/ServiciosAlCiudadano/Paginas/Visados.aspx" },
  { country_code: "NL", country_name: "Netherlands", official_source_url: "https://www.netherlandsworldwide.nl/travelling-to-the-netherlands/short-stay-visa" },
  { country_code: "CN", country_name: "China", official_source_url: "https://www.visaforchina.cn" },
  { country_code: "KR", country_name: "South Korea", official_source_url: "https://www.visa.go.kr" },
  { country_code: "TH", country_name: "Thailand", official_source_url: "https://thaievisa.go.th" },
  { country_code: "IN", country_name: "India", official_source_url: "https://indianvisaonline.gov.in" },
  { country_code: "ID", country_name: "Indonesia", official_source_url: "https://evisa.imigrasi.go.id" },
  { country_code: "VN", country_name: "Vietnam", official_source_url: "https://evisa.xuatnhapcanh.gov.vn" },
  { country_code: "MY", country_name: "Malaysia", official_source_url: "https://www.imi.gov.my" },
  { country_code: "PH", country_name: "Philippines", official_source_url: "https://immigration.gov.ph" },
  { country_code: "NZ", country_name: "New Zealand", official_source_url: "https://www.immigration.govt.nz/new-zealand-visas" },
  { country_code: "TR", country_name: "Turkey", official_source_url: "https://www.evisa.gov.tr" },
  { country_code: "EG", country_name: "Egypt", official_source_url: "https://visa2egypt.gov.eg" },
  { country_code: "AE", country_name: "United Arab Emirates", official_source_url: "https://icp.gov.ae/en/visa-services" },
  { country_code: "SA", country_name: "Saudi Arabia", official_source_url: "https://visa.mofa.gov.sa" },
  { country_code: "QA", country_name: "Qatar", official_source_url: "https://portal.moi.gov.qa/qmoi-service-portal/HomePage.action" },
  { country_code: "BR", country_name: "Brazil", official_source_url: "https://www.gov.br/mre/en/subject-consular-affairs/visas" },
  { country_code: "MX", country_name: "Mexico", official_source_url: "https://www.gob.mx/sre" },
  { country_code: "ZA", country_name: "South Africa", official_source_url: "https://www.dha.gov.za/index.php/immigration-services/types-of-visas" },
  { country_code: "KE", country_name: "Kenya", official_source_url: "https://evisa.go.ke" },
  { country_code: "MA", country_name: "Morocco", official_source_url: "https://www.consulat.ma" },
  { country_code: "CH", country_name: "Switzerland", official_source_url: "https://www.sem.admin.ch/sem/en/home/themen/einreise.html" },
  { country_code: "IE", country_name: "Ireland", official_source_url: "https://www.irishimmigration.ie" },
  { country_code: "SE", country_name: "Sweden", official_source_url: "https://www.migrationsverket.se/English/Private-individuals/Visiting-Sweden.html" },
  { country_code: "PT", country_name: "Portugal", official_source_url: "https://vistos.mne.gov.pt" },
  { country_code: "GR", country_name: "Greece", official_source_url: "https://www.mfa.gr/en/visas" },
  { country_code: "IL", country_name: "Israel", official_source_url: "https://www.gov.il/en/departments/topics/entry_to_israel" },
  { country_code: "HK", country_name: "Hong Kong", official_source_url: "https://www.immd.gov.hk/eng/services/visas/visit-transit/entry-hongkong.html" },
  { country_code: "TW", country_name: "Taiwan", official_source_url: "https://www.boca.gov.tw/cp-149-1-e6b4c-2.html" },
  { country_code: "KH", country_name: "Cambodia", official_source_url: "https://www.evisa.gov.kh" },
  { country_code: "LK", country_name: "Sri Lanka", official_source_url: "https://www.eta.gov.lk" },
  { country_code: "NP", country_name: "Nepal", official_source_url: "https://www.immigration.gov.np" }
];

function resolveCountryCode(destination) {
  if (!destination) return null;
  var normalized = destination.trim().toLowerCase();
  for (var i = 0; i < OFFICIAL_TIER_COUNTRIES.length; i++) {
    var c = OFFICIAL_TIER_COUNTRIES[i];
    if (c.country_code.toLowerCase() === normalized || c.country_name.toLowerCase() === normalized) {
      return c.country_code;
    }
  }
  return null;
}

export { OFFICIAL_TIER_COUNTRIES, resolveCountryCode };
