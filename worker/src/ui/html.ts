import { ProcessingStats } from "../types";

const brandLogoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 530" role="img" aria-labelledby="logo-title">
  <title id="logo-title">MTGSold Logo</title>
  <g transform="translate(250, 245) skewX(8)">
    <rect x="-88" y="-120" width="44" height="120" fill="#495562"/>
    <rect x="-44" y="-120" width="9" height="120" fill="#374151"/>
    <rect x="-30" y="-158" width="44" height="158" fill="#2a4171"/>
    <rect x="14" y="-158" width="9" height="158" fill="#1e3050"/>
    <rect x="28" y="-195" width="44" height="195" fill="#3e3e3f"/>
    <rect x="72" y="-195" width="9" height="195" fill="#2d2d2e"/>
  </g>
  <path d="M 168,178 C 182,170 192,168 205,158 C 218,148 225,142 238,128 C 251,114 258,108 272,95 C 286,82 296,68 310,58 C 318,52 322,50 328,48" fill="none" stroke="#2a4171" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="250" y="345" text-anchor="middle" font-family="system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif" font-size="76" font-weight="700" fill="#3e3e3f" letter-spacing="1">MTGSold</text>
  <rect x="100" y="365" width="300" height="8" fill="#2a4171"/>
</svg>`;

const brandLogoDataUrl = `data:image/svg+xml,${encodeURIComponent(brandLogoSvg)}`;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getLayoutHtml(
  title: string,
  content: string,
  additionalStyles: string = "",
  scripts: string = "",
): string {
  const year = new Date().getFullYear();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#f5efe6">
  <title>${escapeHtml(title)}</title>
  <link rel="icon" type="image/svg+xml" href="${brandLogoDataUrl}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.0/font/bootstrap-icons.css">
  <style>
    :root {
      --bg-top: #f5efe6;
      --bg-bottom: #ece2d5;
      --surface: rgba(255, 252, 248, 0.9);
      --surface-strong: #fffdfa;
      --border: rgba(95, 73, 49, 0.16);
      --text: #2d241d;
      --muted: #6b5d50;
      --accent: #9b3d2f;
      --accent-strong: #7d3025;
      --accent-soft: rgba(155, 61, 47, 0.1);
      --success-soft: rgba(35, 114, 73, 0.12);
      --success: #237249;
      --danger-soft: rgba(161, 48, 48, 0.12);
      --danger: #a13030;
      --shadow: 0 24px 60px rgba(54, 37, 22, 0.12);
      --radius-xl: 24px;
      --radius-lg: 18px;
      --radius-md: 14px;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      color: var(--text);
      font-family: "Inter", "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at top left, rgba(155, 61, 47, 0.12), transparent 34%),
        radial-gradient(circle at top right, rgba(84, 114, 83, 0.12), transparent 30%),
        linear-gradient(180deg, var(--bg-top) 0%, var(--bg-bottom) 100%);
      padding: 2rem 0 2.5rem;
    }

    .page-shell {
      background: rgba(255, 255, 255, 0.3);
      border: 1px solid rgba(255, 255, 255, 0.4);
      border-radius: 32px;
      padding: 1rem;
      box-shadow: var(--shadow);
      backdrop-filter: blur(12px);
    }

    .app-card {
      border: 1px solid var(--border);
      border-radius: var(--radius-xl);
      box-shadow: none;
      background: var(--surface);
      overflow: hidden;
      margin-bottom: 1rem;
    }

    .card-header {
      padding: 1.25rem 1.5rem;
      background:
        linear-gradient(135deg, rgba(155, 61, 47, 0.98), rgba(111, 44, 34, 0.98)),
        linear-gradient(135deg, rgba(255, 255, 255, 0.08), transparent);
      color: #fff;
      border-bottom: 0;
    }

    .card-body {
      padding: 1.5rem;
    }

    .header-row {
      display: flex;
      align-items: center;
      gap: 0.9rem;
    }

    .brand-mark {
      width: 2.75rem;
      height: 2.75rem;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 0.95rem;
      background: rgba(255, 255, 255, 0.16);
      border: 1px solid rgba(255, 255, 255, 0.22);
      font-size: 1.2rem;
    }

    .eyebrow {
      display: block;
      margin-bottom: 0.15rem;
      font-size: 0.72rem;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      opacity: 0.75;
    }

    .header-title {
      margin: 0;
      font-family: "Fraunces", Georgia, serif;
      font-size: 1.35rem;
      font-weight: 700;
      line-height: 1.15;
    }

    .form-panel,
    .result-panel,
    .preview-panel {
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      background: var(--surface-strong);
    }

    .panel-title {
      margin: 0 0 0.7rem;
      font-family: "Fraunces", Georgia, serif;
      font-size: 1.05rem;
      font-weight: 600;
    }

    .nav-tabs {
      gap: 0.65rem;
      border-bottom: 0;
      margin-bottom: 1rem !important;
    }

    .nav-tabs .nav-link {
      border: 1px solid var(--border);
      border-radius: 999px;
      color: var(--muted);
      font-weight: 600;
      padding: 0.7rem 1rem;
      background: rgba(255, 255, 255, 0.55);
    }

    .nav-tabs .nav-link.active {
      color: #fff;
      border-color: transparent;
      background: linear-gradient(135deg, var(--accent), var(--accent-strong));
      box-shadow: 0 12px 28px rgba(125, 48, 37, 0.2);
    }

    .form-panel {
      padding: 1.15rem;
    }

    .form-label {
      font-weight: 600;
      color: var(--text);
    }

    .form-control {
      border: 1px solid rgba(95, 73, 49, 0.2);
      border-radius: 14px;
      padding: 0.85rem 0.95rem;
      box-shadow: none;
    }

    .form-control:focus {
      border-color: rgba(155, 61, 47, 0.4);
      box-shadow: 0 0 0 0.25rem rgba(155, 61, 47, 0.12);
    }

    textarea.form-control {
      min-height: 13rem;
      resize: vertical;
    }

    .form-text,
    .section-note,
    .result-note {
      color: var(--muted);
    }

    .btn {
      border-radius: 999px;
      padding: 0.72rem 1.05rem;
      font-weight: 600;
    }

    .btn-primary {
      background: linear-gradient(135deg, var(--accent), var(--accent-strong));
      border-color: transparent;
      box-shadow: 0 12px 24px rgba(125, 48, 37, 0.16);
    }

    .btn-primary:hover,
    .btn-primary:focus {
      background: linear-gradient(135deg, var(--accent-strong), #67271f);
      border-color: transparent;
    }

    .btn-outline-secondary,
    .btn-outline-danger {
      border-width: 1px;
    }

    .btn-outline-secondary {
      color: var(--text);
      border-color: rgba(95, 73, 49, 0.18);
      background: rgba(255, 255, 255, 0.6);
    }

    .btn-outline-secondary:hover,
    .btn-outline-secondary:focus {
      color: var(--text);
      border-color: rgba(95, 73, 49, 0.28);
      background: rgba(95, 73, 49, 0.08);
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 0.9rem;
      margin-bottom: 1rem;
    }

    .stat-card {
      padding: 1rem;
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      background: linear-gradient(180deg, rgba(255,255,255,0.94), rgba(248,242,236,0.92));
    }

    .stat-value {
      font-size: clamp(1.8rem, 4vw, 2.3rem);
      line-height: 1;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      margin-bottom: 0.4rem;
    }

    .stat-value.success { color: var(--success); }
    .stat-value.danger { color: var(--danger); }
    .stat-value.accent { color: var(--accent-strong); }

    .stat-label {
      font-size: 0.76rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
      font-weight: 700;
    }

    .result-panel,
    .preview-panel {
      padding: 1rem 1.05rem;
      margin-top: 1rem;
    }

    .section-card {
      border: 1px solid var(--border);
      border-radius: var(--radius-xl);
      background: var(--surface);
      margin-top: 1rem;
    }

    .section-card .card-body {
      padding: 1.35rem 1.5rem 1.5rem;
    }

    .instruction-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 1rem;
    }

    .instruction-panel {
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      background: var(--surface-strong);
      padding: 1rem 1rem 0.9rem;
    }

    .instruction-panel h3 {
      margin: 0 0 0.75rem;
      font-size: 1rem;
      font-weight: 700;
    }

    .instruction-list {
      margin: 0;
      padding-left: 1.2rem;
      color: var(--muted);
    }

    .instruction-list li + li {
      margin-top: 0.45rem;
    }

    .support-dock-wrap {
      display: flex;
      justify-content: center;
      margin-top: 0.5rem;
    }

    .support-strip {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: center;
      gap: 0.35rem 0.9rem;
      padding: 0;
      border: none;
      background: none;
    }

    .support-strip a {
      color: var(--muted);
      text-decoration: none;
      font-size: 0.72rem;
      font-weight: 500;
      opacity: 0.7;
      transition: opacity 0.15s;
    }

    .support-strip a:hover {
      opacity: 1;
      color: var(--text);
    }

    .status-badge {
      display: inline-flex;
      align-items: center;
    }

    .status-badge img {
      display: block;
      width: auto;
      height: 14px;
    }

    .brand-link {
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      padding: 0;
      border-radius: 0;
      background: none;
      border: none;
      color: var(--muted);
      text-decoration: none;
      font-weight: 500;
      font-size: 0.72rem;
    }

    .brand-link:hover,
    .brand-link:focus {
      color: var(--text);
      background: none;
    }

    .brand-link img {
      width: 0.75rem;
      height: 0.75rem;
      display: block;
    }

    .kofi-logo {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      border-radius: 0;
      background: none;
      border: none;
    }

    .kofi-logo img {
      display: block;
      width: 52px;
      height: auto;
      opacity: 0.7;
      transition: opacity 0.15s;
    }

    .kofi-logo:hover img {
      opacity: 1;
    }

    .result-banner {
      display: flex;
      gap: 0.8rem;
      align-items: flex-start;
      padding: 1rem 1.05rem;
      border-radius: var(--radius-lg);
      margin-bottom: 1rem;
      border: 1px solid transparent;
    }

    .result-banner.success {
      background: var(--success-soft);
      border-color: rgba(35, 114, 73, 0.15);
    }

    .result-banner.warning {
      background: rgba(201, 124, 23, 0.1);
      border-color: rgba(201, 124, 23, 0.16);
    }

    .result-banner.error {
      background: var(--danger-soft);
      border-color: rgba(161, 48, 48, 0.16);
    }

    .banner-icon {
      width: 2.25rem;
      height: 2.25rem;
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      font-size: 1rem;
    }

    .result-banner.success .banner-icon {
      background: rgba(35, 114, 73, 0.16);
      color: var(--success);
    }

    .result-banner.warning .banner-icon {
      background: rgba(201, 124, 23, 0.16);
      color: #a5640c;
    }

    .result-banner.error .banner-icon {
      background: rgba(161, 48, 48, 0.16);
      color: var(--danger);
    }

    .banner-title {
      margin: 0 0 0.2rem;
      font-weight: 700;
    }

    .banner-copy {
      margin: 0;
      color: var(--muted);
    }

    .error-list {
      margin: 0.8rem 0 0;
      padding-left: 1rem;
      color: var(--text);
    }

    .error-list li + li {
      margin-top: 0.45rem;
    }

    .action-row {
      display: flex;
      flex-wrap: wrap;
      gap: 0.75rem;
    }

    .preview-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 0.75rem;
    }

    .preview-header h5 {
      margin: 0;
      font-family: "Fraunces", Georgia, serif;
      font-size: 1.05rem;
      font-weight: 600;
    }

    .preview-panel textarea {
      background: #fff;
      min-height: 12rem;
    }

    .footer {
      font-size: 0.82rem;
      color: var(--muted);
      text-align: center;
      margin-top: 1.1rem;
    }

    @media (max-width: 991.98px) {
      .stats-grid,
      .instruction-grid {
        grid-template-columns: 1fr;
      }
    }

    @media (max-width: 767.98px) {
      body {
        padding: 1rem 0 1.5rem;
      }

      .page-shell {
        padding: 0.7rem;
        border-radius: 24px;
      }

      .card-header,
      .card-body {
        padding: 1.1rem;
      }

      .preview-header,
      .action-row {
        align-items: stretch;
      }

      .preview-header {
        flex-direction: column;
      }

      .btn,
      .nav-tabs .nav-link {
        width: 100%;
        justify-content: center;
      }

      .support-dock-wrap {
        justify-content: center;
      }
    }

    ${additionalStyles}
  </style>
</head>
<body>
  <div class="container">
    <div class="row justify-content-center">
      <div class="col-xl-9 col-lg-10">
        <div class="page-shell">
          ${content}
          <div class="footer">
            <a href="https://ko-fi.com/mtgsold" class="kofi-logo" target="_blank" rel="noopener noreferrer" style="margin-bottom:0.4rem;display:inline-flex;">
              <img src="https://storage.ko-fi.com/cdn/fullLogoKofi.png" alt="Support on Ko-fi">
            </a>
            <div>MTG CSV Processor &copy; YourFriendsHouseCo ${year}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
  ${scripts}
</body>
</html>`;
}

export function getIndexHtml(): string {
  const content = `
<div class="card app-card mb-4">
  <div class="card-header">
    <div class="header-row">
      <span class="brand-mark"><i class="bi bi-magic"></i></span>
      <div>
        <span class="eyebrow">MTG CSV Processor</span>
        <h1 class="header-title">ManaBox to TCGplayer Converter</h1>
      </div>
    </div>
  </div>
  <div class="card-body">
    <ul class="nav nav-tabs mb-3" id="inputMethodTabs" role="tablist">
      <li class="nav-item" role="presentation">
        <button class="nav-link active" id="upload-tab" data-bs-toggle="tab" data-bs-target="#upload-tab-pane" type="button" role="tab">Upload File</button>
      </li>
      <li class="nav-item" role="presentation">
        <button class="nav-link" id="paste-tab" data-bs-toggle="tab" data-bs-target="#paste-tab-pane" type="button" role="tab">Paste CSV</button>
      </li>
    </ul>
    <div class="tab-content" id="inputMethodTabsContent">
      <div class="tab-pane fade show active" id="upload-tab-pane" role="tabpanel">
        <form action="/convert" method="post" enctype="multipart/form-data" class="mt-3 js-submit-form">
          <input type="hidden" name="mode" value="upload">
          <div class="form-panel">
            <div class="mb-3">
              <label for="file" class="form-label">Select CSV file</label>
              <input class="form-control" type="file" id="file" name="file" accept=".csv,text/csv" required>
              <div class="form-text">Use your ManaBox export. The file must include the Scryfall ID column.</div>
              <div class="section-note mt-2" id="fileSelectionNote">No file selected yet.</div>
            </div>
            <div class="form-check mb-3">
              <input class="form-check-input" type="checkbox" id="pro_account" name="pro_account" value="1">
              <label class="form-check-label" for="pro_account">TCGplayer Pro account <span class="form-text">(adds My Store columns)</span></label>
            </div>
            <button type="submit" class="btn btn-primary js-submit-button" data-default-label="Upload and Convert" data-loading-label="Processing...">
              <i class="bi bi-upload"></i> Upload and Convert
            </button>
          </div>
        </form>
      </div>
      <div class="tab-pane fade" id="paste-tab-pane" role="tabpanel">
        <form action="/convert" method="post" class="mt-3 js-submit-form">
          <input type="hidden" name="mode" value="paste">
          <div class="form-panel">
            <div class="mb-3">
              <label for="csv_content" class="form-label">Paste CSV content</label>
              <textarea class="form-control" id="csv_content" name="csv_content" rows="10" placeholder="Paste the full CSV export here..." required></textarea>
              <div class="form-text">The first row should include headers, including Scryfall ID.</div>
            </div>
            <div class="form-check mb-3">
              <input class="form-check-input" type="checkbox" id="pro_account_paste" name="pro_account" value="1">
              <label class="form-check-label" for="pro_account_paste">TCGplayer Pro account <span class="form-text">(adds My Store columns)</span></label>
            </div>
            <button type="submit" class="btn btn-primary js-submit-button" data-default-label="Process CSV" data-loading-label="Processing...">
              <i class="bi bi-arrow-repeat"></i> Process CSV
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</div>`;
  const scripts = `<script>
const fileInput = document.getElementById("file");
const fileSelectionNote = document.getElementById("fileSelectionNote");

fileInput?.addEventListener("change", function(event) {
  const input = event.currentTarget;
  const file = input && "files" in input ? input.files?.[0] : null;
  if (fileSelectionNote) {
    fileSelectionNote.textContent = file ? "Selected: " + file.name : "No file selected yet.";
  }
});

document.querySelectorAll(".js-submit-form").forEach(function(form) {
  form.addEventListener("submit", function() {
    const button = form.querySelector(".js-submit-button");
    if (!(button instanceof HTMLButtonElement)) return;
    const loadingLabel = button.getAttribute("data-loading-label") || "Processing...";
    button.disabled = true;
    button.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>' + loadingLabel;
  });
});
</script>`;
  const secondaryContent = `
<div class="card section-card">
  <div class="card-body">
    <h2 class="panel-title mb-3">Instructions</h2>
    <div class="instruction-grid">
      <div class="instruction-panel">
        <h3><i class="bi bi-laptop me-2"></i>Upload Flow</h3>
        <ol class="instruction-list">
          <li>Export your collection from ManaBox as a CSV.</li>
          <li>Upload the file here.</li>
          <li>Download the converted CSV.</li>
        </ol>
      </div>
      <div class="instruction-panel">
        <h3><i class="bi bi-phone me-2"></i>Paste Flow</h3>
        <ol class="instruction-list">
          <li>Copy the full CSV export.</li>
          <li>Paste it into the text area.</li>
          <li>Copy the converted output.</li>
        </ol>
      </div>
    </div>
  </div>
</div>
<div class="support-dock-wrap">
  <div class="support-strip">
    <a href="https://github.com/ipkstef/fictional-winner/actions/workflows/sync-r2-to-d1.yml" class="status-badge" target="_blank" rel="noopener noreferrer">
      <img src="https://github.com/ipkstef/fictional-winner/actions/workflows/sync-r2-to-d1.yml/badge.svg" alt="Sync R2 to D1">
    </a>
    <a href="https://mtgsold.com" class="brand-link" target="_blank" rel="noopener noreferrer">
      <img src="${brandLogoDataUrl}" alt="MTGSold">
      <span>mtgsold.com</span>
    </a>
  </div>
</div>`;
  return getLayoutHtml("MTG CSV Processor", content + secondaryContent, "", scripts);
}

function getStatsCards(stats: ProcessingStats): string {
  return `
<div class="stats-grid">
  <div class="stat-card">
    <div class="stat-value accent">${stats.inputRows}</div>
    <div class="stat-label">Rows Read</div>
  </div>
  <div class="stat-card">
    <div class="stat-value success">${stats.matchedRows}</div>
    <div class="stat-label">Listings Created</div>
  </div>
  <div class="stat-card">
    <div class="stat-value danger">${stats.errors}</div>
    <div class="stat-label">Rows Skipped</div>
  </div>
</div>`;
}

function getResultBannerHtml(stats: ProcessingStats, downloadMode: boolean): string {
  if (stats.errors === 0) {
    const aggregateNote =
      stats.aggregatedFrom > stats.matchedRows
        ? ` ${stats.aggregatedFrom} matched rows were condensed into ${stats.matchedRows} final listings.`
        : "";

    return `
<div class="result-banner success">
  <span class="banner-icon"><i class="bi bi-check-lg"></i></span>
  <div>
    <p class="banner-title">Conversion complete</p>
    <p class="banner-copy">Everything that could be matched was converted successfully.${aggregateNote}</p>
  </div>
</div>`;
  }

  const modeCopy = downloadMode
    ? "The output is ready, and the skipped rows can be exported as a failures CSV."
    : "The output is ready below, and the skipped rows are shown separately for quick cleanup.";

  return `
<div class="result-banner warning">
  <span class="banner-icon"><i class="bi bi-exclamation-triangle"></i></span>
  <div>
    <p class="banner-title">Conversion finished with ${stats.errors} skipped row${stats.errors === 1 ? "" : "s"}</p>
    <p class="banner-copy">${modeCopy}</p>
  </div>
</div>`;
}

function getSampleErrorsHtml(stats: ProcessingStats): string {
  if (stats.sampleErrors.length === 0) return "";

  const items = stats.sampleErrors
    .map((error) => `<li>${escapeHtml(error)}</li>`)
    .join("");
  const extraCount = Math.max(stats.errors - stats.sampleErrors.length, 0);
  const extraCopy =
    extraCount > 0
      ? `<p class="result-note mt-3 mb-0">Showing ${stats.sampleErrors.length} sample issue${stats.sampleErrors.length === 1 ? "" : "s"}. ${extraCount} more row${extraCount === 1 ? " was" : "s were"} skipped.</p>`
      : "";

  return `
<div class="result-panel">
  <h2 class="panel-title">What Needs Attention</h2>
  <ol class="error-list">
    ${items}
  </ol>
  ${extraCopy}
</div>`;
}

export function getUploadResultsHtml(stats: ProcessingStats, csvContent: string): string {
  const failuresButton = stats.failuresCsv
    ? `<button id="downloadFailuresBtn" class="btn btn-outline-danger"><i class="bi bi-exclamation-triangle"></i> Download Failures CSV (${stats.errors})</button>`
    : "";
  const failuresData = stats.failuresCsv
    ? `<textarea id="failuresCsvData" style="display:none;">${escapeHtml(stats.failuresCsv)}</textarea>`
    : "";

  const content = `
<div class="card app-card">
  <div class="card-header">
    <div class="header-row">
      <span class="brand-mark"><i class="bi bi-check2-circle"></i></span>
      <div>
        <span class="eyebrow">Results</span>
        <h1 class="header-title">Processing Complete</h1>
      </div>
    </div>
  </div>
  <div class="card-body">
    ${getResultBannerHtml(stats, true)}
    ${getStatsCards(stats)}
    <div class="action-row">
      <button id="downloadBtn" class="btn btn-primary"><i class="bi bi-download"></i> Download TCG CSV</button>
      ${failuresButton}
      <a href="/" class="btn btn-outline-secondary"><i class="bi bi-arrow-left"></i> Process Another File</a>
    </div>
    <p class="result-note mt-3 mb-0">Your converted file stays in the browser until you download it.</p>
    ${getSampleErrorsHtml(stats)}
    <textarea id="csvData" style="display:none;">${escapeHtml(csvContent)}</textarea>
    ${failuresData}
  </div>
</div>`;

  const scripts = `<script>
function downloadTextFile(content, filename) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}
document.getElementById("downloadBtn")?.addEventListener("click", function() {
  downloadTextFile(document.getElementById("csvData").value || "", "tcgplayer_output.csv");
});
document.getElementById("downloadFailuresBtn")?.addEventListener("click", function() {
  downloadTextFile(document.getElementById("failuresCsvData").value || "", "tcgplayer_failures.csv");
});
</script>`;

  return getLayoutHtml("Processing Results - MTG CSV Processor", content, "", scripts);
}

export function getPasteResultsHtml(stats: ProcessingStats, csvContent: string): string {
  const failuresOutputHtml = stats.failuresCsv
    ? `<div class="preview-panel">
        <div class="preview-header">
          <h5>Failures CSV (${stats.errors} row${stats.errors === 1 ? "" : "s"})</h5>
          <button type="button" class="btn btn-outline-danger btn-sm js-copy-button" data-target="failuresOutput" data-default-label="Copy Failures CSV" data-success-label="Copied">
            <i class="bi bi-clipboard"></i> Copy Failures CSV
          </button>
        </div>
        <textarea id="failuresOutput" class="form-control" rows="6" readonly>${escapeHtml(stats.failuresCsv)}</textarea>
      </div>`
    : "";

  const content = `
<div class="card app-card">
  <div class="card-header">
    <div class="header-row">
      <span class="brand-mark"><i class="bi bi-card-checklist"></i></span>
      <div>
        <span class="eyebrow">Results</span>
        <h1 class="header-title">Processing Complete</h1>
      </div>
    </div>
  </div>
  <div class="card-body">
    ${getResultBannerHtml(stats, false)}
    ${getStatsCards(stats)}
    <div class="preview-panel">
      <div class="preview-header">
        <h5>TCGplayer CSV Output</h5>
        <button type="button" class="btn btn-outline-secondary btn-sm js-copy-button" data-target="csvOutput" data-default-label="Copy Output CSV" data-success-label="Copied">
          <i class="bi bi-clipboard"></i> Copy Output CSV
        </button>
      </div>
      <textarea id="csvOutput" class="form-control" rows="10" readonly>${escapeHtml(csvContent)}</textarea>
    </div>
    ${failuresOutputHtml}
    ${getSampleErrorsHtml(stats)}
    <div class="action-row mt-3">
      <a href="/" class="btn btn-outline-secondary"><i class="bi bi-arrow-left"></i> Process Another File</a>
    </div>
  </div>
</div>`;
  const scripts = `<script>
document.querySelectorAll(".js-copy-button").forEach(function(button) {
  button.addEventListener("click", async function() {
    if (!(button instanceof HTMLButtonElement)) return;
    const targetId = button.getAttribute("data-target");
    const defaultLabel = button.getAttribute("data-default-label") || "Copy";
    const successLabel = button.getAttribute("data-success-label") || "Copied";
    const target = targetId ? document.getElementById(targetId) : null;
    if (!(target instanceof HTMLTextAreaElement)) return;
    try {
      await navigator.clipboard.writeText(target.value);
      button.innerHTML = '<i class="bi bi-check2"></i> ' + successLabel;
      window.setTimeout(function() {
        button.innerHTML = '<i class="bi bi-clipboard"></i> ' + defaultLabel;
      }, 1800);
    } catch (_error) {
      target.focus();
      target.select();
      document.execCommand("copy");
      button.innerHTML = '<i class="bi bi-check2"></i> ' + successLabel;
      window.setTimeout(function() {
        button.innerHTML = '<i class="bi bi-clipboard"></i> ' + defaultLabel;
      }, 1800);
    }
  });
});
</script>`;
  return getLayoutHtml("Text Results - MTG CSV Processor", content, "", scripts);
}

export function getErrorHtml(message: string): string {
  const content = `
<div class="card app-card">
  <div class="card-header" style="background:linear-gradient(135deg, #a13030, #7d2424);">
    <div class="header-row">
      <span class="brand-mark"><i class="bi bi-x-octagon"></i></span>
      <div>
        <span class="eyebrow">Error</span>
        <h1 class="header-title">Something Stopped The Conversion</h1>
      </div>
    </div>
  </div>
  <div class="card-body">
    <div class="result-banner error" role="alert">
      <span class="banner-icon"><i class="bi bi-exclamation-octagon"></i></span>
      <div>
        <p class="banner-title">The request could not be completed</p>
        <p class="banner-copy">${escapeHtml(message)}</p>
      </div>
    </div>
    <div class="action-row">
      <a href="/" class="btn btn-outline-secondary"><i class="bi bi-arrow-left"></i> Try Again</a>
    </div>
  </div>
</div>`;
  return getLayoutHtml("Error - MTG CSV Processor", content);
}
