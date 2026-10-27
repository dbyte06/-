import JSZip from 'jszip';
import { ReportItem } from './sampleReports';

export interface GitHubConfig {
  owner: string;
  repo: string;
  branch: string;
  token?: string; // Optional: PAT (Personal Access Token) for private repo & write operations
  reportsPath: string; // e.g., 'reports'
  enabled: boolean;
}

const GITHUB_CONFIG_KEY = 'chemmarket_github_config';

export function getSavedGitHubConfig(): GitHubConfig {
  try {
    const raw = localStorage.getItem(GITHUB_CONFIG_KEY);
    if (raw) {
      return JSON.parse(raw);
    }
  } catch {
    // ignore
  }
  return {
    owner: '',
    repo: '',
    branch: 'main',
    token: '',
    reportsPath: 'reports',
    enabled: false
  };
}

export function saveGitHubConfig(config: GitHubConfig): void {
  try {
    localStorage.setItem(GITHUB_CONFIG_KEY, JSON.stringify(config));
  } catch {
    // ignore
  }
}

// Helper to make GitHub API calls with authorization if token is set
async function githubApiRequest(
  endpoint: string,
  token?: string,
  options: RequestInit = {}
): Promise<Response> {
  const url = endpoint.startsWith('https://') ? endpoint : `https://api.github.com${endpoint}`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(options.headers as Record<string, string> || {})
  };

  if (token && token.trim()) {
    headers['Authorization'] = `Bearer ${token.trim()}`;
  }

  return fetch(url, {
    ...options,
    headers
  });
}

// Convert unicode string to base64
export function utf8ToBase64(str: string): string {
  return btoa(
    encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (_, p1) =>
      String.fromCharCode(parseInt(p1, 16))
    )
  );
}

// Convert base64 to unicode string
export function base64ToUtf8(str: string): string {
  const cleaned = str.replace(/\s/g, '');
  return decodeURIComponent(
    Array.prototype.map
      .call(atob(cleaned), (c: string) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
      .join('')
  );
}

export interface ConnectionTestResult {
  success: boolean;
  message: string;
  repoInfo?: {
    name: string;
    fullName: string;
    isPrivate: boolean;
    description: string;
    defaultBranch: string;
    hasPages: boolean;
    pagesUrl?: string;
  };
  canWrite?: boolean;
}

// Test GitHub connection
export async function testGitHubConnection(config: GitHubConfig): Promise<ConnectionTestResult> {
  const { owner, repo, token } = config;
  if (!owner.trim() || !repo.trim()) {
    return { success: false, message: '저장소 소유자(Owner)와 저장소 이름(Repo)을 입력해 주세요.' };
  }

  try {
    const res = await githubApiRequest(`/repos/${owner.trim()}/${repo.trim()}`, token);
    if (res.status === 404) {
      return {
        success: false,
        message: '저장소를 찾을 수 없습니다 (404). 저장소 이름이 올바른지, 또는 비공개 저장소인 경우 토큰 권한을 확인하세요.'
      };
    }
    if (res.status === 401) {
      return {
        success: false,
        message: 'GitHub 토큰 인증 실패 (401). 올바른 Personal Access Token인지 확인하세요.'
      };
    }
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      return {
        success: false,
        message: `GitHub 오류 (${res.status}): ${errData.message || res.statusText}`
      };
    }

    const data = await res.json();
    const canWrite = Boolean(data.permissions?.push || data.permissions?.admin || token);

    let pagesUrl: string | undefined = undefined;
    if (data.has_pages) {
      pagesUrl = `https://${owner.toLowerCase()}.github.io/${repo.toLowerCase()}/`;
    }

    return {
      success: true,
      message: `연결 성공! (${data.full_name}) ${data.private ? '🔒 비공개 저장소' : '🌐 공개 저장소'}`,
      repoInfo: {
        name: data.name,
        fullName: data.full_name,
        isPrivate: data.private,
        description: data.description || '',
        defaultBranch: data.default_branch,
        hasPages: Boolean(data.has_pages),
        pagesUrl
      },
      canWrite
    };
  } catch (err: any) {
    return {
      success: false,
      message: '네트워크 연결 실패: ' + (err?.message || err)
    };
  }
}

// Fetch all reports from GitHub
export async function fetchReportsFromGitHub(config: GitHubConfig): Promise<ReportItem[]> {
  const { owner, repo, branch, token, reportsPath } = config;
  const targetBranch = branch || 'main';

  // 1. Try to load `reports.json` first (fastest and most complete)
  try {
    // Try raw github content first for speed, fallback to API
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${targetBranch}/reports.json`;
    const rawRes = await fetch(rawUrl, {
      cache: 'no-store',
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });

    if (rawRes.ok) {
      const data = await rawRes.json();
      if (Array.isArray(data) && data.length > 0) {
        return data;
      }
    }
  } catch {
    // continue to API method
  }

  // 2. Query GitHub contents API for `reports.json`
  try {
    const apiRes = await githubApiRequest(
      `/repos/${owner}/${repo}/contents/reports.json?ref=${targetBranch}`,
      token
    );
    if (apiRes.ok) {
      const fileData = await apiRes.json();
      if (fileData.content) {
        const decoded = base64ToUtf8(fileData.content);
        const parsed = JSON.parse(decoded);
        if (Array.isArray(parsed)) {
          return parsed;
        }
      }
    }
  } catch {
    // fallback to directory scan
  }

  // 3. Fallback: Scan the reportsPath directory
  const reportsFolder = reportsPath.replace(/^\/+|\/+$/g, '') || 'reports';
  const folderRes = await githubApiRequest(
    `/repos/${owner}/${repo}/contents/${reportsFolder}?ref=${targetBranch}`,
    token
  );

  if (!folderRes.ok) {
    return [];
  }

  const items = await folderRes.json();
  if (!Array.isArray(items)) return [];

  const htmlFiles = items.filter(
    (item: any) => item.type === 'file' && /\.html?$/i.test(item.name)
  );

  const loadedReports: ReportItem[] = [];

  for (const f of htmlFiles) {
    try {
      const fRes = await githubApiRequest(f.url, token);
      if (fRes.ok) {
        const fileContentObj = await fRes.json();
        const html = base64ToUtf8(fileContentObj.content);
        
        // Infer date & category & title
        const m = f.name.match(/(20\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?([0-3]\d)/);
        const date = m ? `${m[1]}-${m[2]}-${m[3]}` : new Date().toISOString().slice(0, 10);
        let category: '데일리' | '위클리' | '기획 시황' = '데일리';
        if (/weekly|위클리/i.test(f.name) || /위클리/.test(html)) category = '위클리';
        else if (/special|기획/i.test(f.name) || /기획/.test(html)) category = '기획 시황';

        // Extract title from <title> if present
        let title = f.name.replace(/\.html?$/i, '').replace(/[_-]/g, ' ');
        const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
        if (titleMatch && titleMatch[1].trim()) {
          title = titleMatch[1].trim();
        }

        loadedReports.push({
          id: `gh-${f.sha.slice(0, 12)}`,
          date,
          category,
          title,
          filename: f.name,
          html,
          created: new Date().toISOString()
        });
      }
    } catch {
      // skip failed item
    }
  }

  return loadedReports;
}

// Get file SHA if it already exists on GitHub
async function getFileSha(
  owner: string,
  repo: string,
  path: string,
  branch: string,
  token?: string
): Promise<string | undefined> {
  try {
    const res = await githubApiRequest(
      `/repos/${owner}/${repo}/contents/${path}?ref=${branch}`,
      token
    );
    if (res.ok) {
      const data = await res.json();
      return data.sha;
    }
  } catch {
    // not found
  }
  return undefined;
}

// Commit a single file to GitHub repo
export async function commitFileToGitHub(
  config: GitHubConfig,
  path: string,
  content: string,
  commitMessage: string
): Promise<{ success: boolean; message: string }> {
  const { owner, repo, branch, token } = config;
  if (!token) {
    return { success: false, message: 'GitHub Personal Access Token(PAT)이 필요합니다.' };
  }

  const targetBranch = branch || 'main';
  const sha = await getFileSha(owner, repo, path, targetBranch, token);

  const base64Content = utf8ToBase64(content);

  const body: any = {
    message: commitMessage,
    content: base64Content,
    branch: targetBranch
  };
  if (sha) {
    body.sha = sha;
  }

  try {
    const res = await githubApiRequest(
      `/repos/${owner}/${repo}/contents/${path}`,
      token,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }
    );

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return {
        success: false,
        message: `커밋 실패 (${res.status}): ${err.message || res.statusText}`
      };
    }

    return { success: true, message: '커밋 성공' };
  } catch (err: any) {
    return { success: false, message: err?.message || '네트워크 오류' };
  }
}

// Commit a single report and update reports.json manifest
export async function commitReportAndCatalogToGitHub(
  config: GitHubConfig,
  report: ReportItem,
  existingReports: ReportItem[]
): Promise<{ success: boolean; message: string }> {
  const reportsFolder = (config.reportsPath || 'reports').replace(/^\/+|\/+$/g, '');
  const fileName = report.filename || `${report.date}_${report.id.slice(0, 8)}.html`;
  const filePath = `${reportsFolder}/${fileName}`;

  // 1. Commit HTML file
  const fileRes = await commitFileToGitHub(
    config,
    filePath,
    report.html,
    `feat(report): add ${report.category} [${report.date}] ${report.title}`
  );
  if (!fileRes.success) {
    return fileRes;
  }

  // 2. Update catalog reports.json
  const updatedCatalog = [report, ...existingReports.filter(r => r.id !== report.id)].sort(
    (a, b) => b.date.localeCompare(a.date) || b.created.localeCompare(a.created)
  );

  const catalogRes = await commitFileToGitHub(
    config,
    'reports.json',
    JSON.stringify(updatedCatalog, null, 2),
    `chore: update reports catalog (${updatedCatalog.length} reports)`
  );

  return catalogRes;
}

// Push all local reports to GitHub repo (batch sync)
export async function pushAllReportsToGitHub(
  config: GitHubConfig,
  reports: ReportItem[],
  onProgress?: (message: string) => void
): Promise<{ success: boolean; message: string; count: number }> {
  if (!config.token) {
    return { success: false, message: 'GitHub 토큰이 등록되어 있지 않습니다.', count: 0 };
  }

  const reportsFolder = (config.reportsPath || 'reports').replace(/^\/+|\/+$/g, '');
  let count = 0;

  for (let i = 0; i < reports.length; i++) {
    const r = reports[i];
    onProgress?.(`보고서 업로드 중 (${i + 1}/${reports.length}): ${r.title}`);
    const fileName = r.filename || `${r.date}_${r.id.slice(0, 8)}.html`;
    const res = await commitFileToGitHub(
      config,
      `${reportsFolder}/${fileName}`,
      r.html,
      `sync: publish ${r.category} [${r.date}] ${r.title}`
    );
    if (res.success) {
      count++;
    }
  }

  onProgress?.('보고서 카탈로그(reports.json) 업데이트 중...');
  await commitFileToGitHub(
    config,
    'reports.json',
    JSON.stringify(reports, null, 2),
    `sync: full catalog update (${reports.length} reports)`
  );

  return {
    success: true,
    message: `${count}개 보고서가 GitHub 저장소에 동기화되었습니다.`,
    count
  };
}

// Generate complete standalone HTML viewer & admin for GitHub Pages / static hosting
export function generateStandaloneIndexHtml(
  title: string,
  subtitle: string,
  initialReports: ReportItem[] = []
): string {
  const serializedInitial = JSON.stringify(initialReports).replace(/<\/script>/gi, '<\\/script>');

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  <meta name="description" content="${subtitle}">
  <style>
    :root {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Malgun Gothic", sans-serif;
      color: #14243f;
      background: #f0f4f9;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background-color: #f0f4f9; color: #14243f; }
    button, input, select { font: inherit; }
    button { cursor: pointer; }

    .top-bar {
      background: #031322; border-bottom: 1px solid #1b3552; color: #cbd5e1;
      padding: 8px 16px; font-size: 12px; display: flex; justify-content: space-between;
      align-items: center; flex-wrap: wrap; gap: 8px;
    }
    .badge-status {
      display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px;
      border-radius: 4px; font-weight: 700; font-size: 11px;
    }
    .badge-github { background: #064e3b; color: #34d399; border: 1px solid #059669; }
    .badge-local { background: #0c4a6e; color: #38bdf8; border: 1px solid #0284c7; }

    header {
      background: linear-gradient(110deg, #041a2d, #183a5a); color: #fff;
      padding: 48px max(24px, calc((100vw - 1100px)/2)); min-height: 210px;
    }
    header small { letter-spacing: 3px; color: #7ee4e8; font-weight: 800; display: block; }
    header h1 { font-size: clamp(28px, 4vw, 44px); margin: 12px 0 8px; font-weight: 800; }
    header p { margin: 0; color: #d9e6f5; font-size: 15px; }

    .wrap { max-width: 1100px; margin: 0 auto; padding: 22px 18px 60px; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 9px; align-items: center; }
    .tabs { display: flex; background: #e3e9f1; border-radius: 10px; padding: 4px; gap: 2px; }
    .tabs button {
      background: none; border: 0; padding: 10px 14px; border-radius: 8px; font-weight: 700;
      color: #35455e; transition: all 0.15s ease;
    }
    .tabs button:hover { color: #152c69; }
    .tabs button.active { background: #fff; color: #152c69; box-shadow: 0 1px 3px rgba(204, 212, 224, 0.8); }

    .search { flex: 1; min-width: 180px; }
    .search, select, input[type=text], input[type=password], input[type=date] {
      border: 1px solid #cbd6e4; border-radius: 9px; padding: 11px 13px; background: #fff;
      color: #15243d; font-size: 14px;
    }
    .search:focus, select:focus, input[type=text]:focus, input[type=password]:focus, input[type=date]:focus {
      outline: 2px solid #213fae;
    }

    .btn {
      border: 0; border-radius: 8px; padding: 9px 15px; background: #213fae; color: white;
      font-weight: 700; display: inline-flex; align-items: center; justify-content: center;
      gap: 5px; font-size: 13.5px; transition: background-color 0.15s ease;
    }
    .btn:hover:not(:disabled) { background: #193290; }
    .btn.alt { background: #e4eaf3; color: #263a59; }
    .btn.alt:hover:not(:disabled) { background: #d3dfea; }
    .btn.danger { background: #bd3345; color: #fff; }
    .btn.danger:hover:not(:disabled) { background: #9b2837; }
    .btn.green { background: #167b69; color: #fff; }
    .btn.green:hover:not(:disabled) { background: #106052; }
    .btn:disabled { opacity: .5; cursor: not-allowed; }

    .adminlink { margin-left: auto; }
    .muted { font-size: 12px; color: #71819a; }

    .month {
      background: white; border: 1px solid #dae3ed; border-radius: 12px; overflow: hidden;
      margin: 14px 0; box-shadow: 0 1px 4px rgba(16, 39, 71, 0.04);
    }
    .month h3 {
      margin: 0; background: #f8fafc; border-bottom: 1px solid #e5eaf1; padding: 13px 16px;
      font-size: 15px; font-weight: 800; color: #1e3354;
    }
    .row {
      display: flex; align-items: center; gap: 14px; padding: 12px 16px; border-bottom: 1px solid #e9edf3; min-height: 58px;
    }
    .row:hover { background-color: #fbfcfe; }
    .row:last-child { border-bottom: 0; }

    .date { font-size: 12px; font-weight: 800; min-width: 105px; color: #3b506f; }
    .tag {
      font-size: 11px; font-weight: 700; color: #1747ad; background: #e1edff; border-radius: 20px;
      padding: 5px 12px; white-space: nowrap;
    }
    .tag.weekly { color: #0b6755; background: #e0f4f0; }
    .tag.special { color: #78350f; background: #fef3c7; }
    .title { flex: 1; font-size: 14px; font-weight: 600; min-width: 100px; }
    .actions { display: flex; gap: 6px; flex-wrap: wrap; }

    .panel {
      background: #fff; border: 1px solid #dae3ed; border-radius: 12px; padding: 22px; margin-top: 18px;
      box-shadow: 0 2px 8px rgba(16, 39, 71, 0.04);
    }
    .panel h2 { margin: 0 0 14px; font-size: 18px; font-weight: 800; color: #142845; }
    .field { display: flex; flex-direction: column; gap: 5px; margin: 12px 0; }
    .field label { font-size: 12px; font-weight: 700; color: #2b3e5a; }
    .field input, .field select { width: 100%; max-width: 580px; }

    .notice {
      background: #eef6ff; border: 1px solid #c9def7; color: #254466; border-radius: 9px;
      padding: 13px 15px; font-size: 13px; line-height: 1.6; margin: 12px 0;
    }
    .warning { background: #fff8e8; border-color: #f1dc9d; color: #634300; }
    .hidden { display: none !important; }

    .viewer { position: fixed; inset: 0; background: #eef2f7; z-index: 100; display: flex; flex-direction: column; }
    .viewerbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 12px 20px; background: #102842; color: #fff; }
    .viewerbar strong { flex: 1; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .viewer iframe { flex: 1; width: 100%; border: 0; background: white; }

    .filebox {
      border: 2px dashed #aebed2; background: #f8fafc; border-radius: 12px; text-align: center;
      padding: 26px; margin: 14px 0; cursor: pointer;
    }
    .filebox:hover { border-color: #213fae; background: #f0f5fc; }
    .empty { text-align: center; padding: 50px 20px; color: #687b94; font-size: 14px; }
    .mini { font-size: 11.5px; color: #62738b; line-height: 1.6; }

    #toast {
      position: fixed; bottom: 22px; right: 22px; background: #14243f; color: #fff; border-radius: 9px;
      padding: 14px 18px; display: none; z-index: 999; max-width: 380px; font-size: 13px; font-weight: 600;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
    }

    .modal-backdrop {
      position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 150; display: flex;
      align-items: center; justify-content: center; padding: 16px;
    }
    .modal-box {
      background: white; border-radius: 12px; max-width: 580px; width: 100%; padding: 22px;
      box-shadow: 0 8px 30px rgba(0,0,0,0.25); max-height: 90vh; overflow-y: auto;
    }
    .modal-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #e2e8f0; padding-bottom: 12px; margin-bottom: 14px; }
    .modal-header h3 { margin: 0; font-size: 17px; font-weight: 800; color: #0f172a; }

    @media(max-width: 720px){
      .row { align-items: flex-start; flex-wrap: wrap; }
      .date { min-width: 95px; }
      .title { flex-basis: 100%; margin: 4px 0; }
      .actions { width: 100%; }
      .toolbar .adminlink { margin-left: 0; width: 100%; }
      header { padding: 35px 20px; min-height: auto; }
      .wrap { padding: 14px; }
    }
    @media print {
      header, .toolbar, .wrap, .viewerbar, .top-bar { display: none !important; }
      .viewer { position: static !important; }
      .viewer iframe { height: 100vh !important; }
    }
  </style>
</head>
<body>

<div class="top-bar">
  <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
    <span id="statusBadge" class="badge-status badge-local">💻 로컬 보관소 모드</span>
    <span id="repoText" style="color:#94a3b8;"></span>
    <button class="btn alt" style="padding:4px 8px; font-size:11px;" id="switchModeBtn">모드 전환</button>
  </div>
  <div style="display:flex; align-items:center; gap:8px;">
    <button class="btn alt" style="padding:5px 10px; font-size:12px;" id="shareBtn">🔗 공유하기</button>
    <button class="btn alt" style="padding:5px 10px; font-size:12px;" id="ghSettingsBtn">⚙️ GitHub 설정</button>
  </div>
</div>

<header>
  <small>GLOBAL PETROCHEMICAL INSIGHTS</small>
  <h1>${title}</h1>
  <p>${subtitle}</p>
</header>

<main class="wrap">
  <div id="archiveView">
    <div class="toolbar">
      <div class="tabs" id="tabs">
        <button data-filter="전체" class="active">전체</button>
        <button data-filter="데일리">데일리</button>
        <button data-filter="위클리">위클리</button>
        <button data-filter="기획 시황">기획 시황</button>
      </div>
      <input class="search" id="search" placeholder="날짜, 제목 검색" aria-label="보고서 검색">
      <select id="year"><option value="">전체 연도</option></select>
      <button class="btn alt adminlink" id="adminBtn">🔒 관리자</button>
    </div>

    <div style="display:flex; justify-content:space-between; align-items:center; margin:14px 2px; flex-wrap:wrap; gap:8px;">
      <p class="muted" id="count" style="margin:0;"></p>
      <button class="btn alt" style="padding:6px 10px; font-size:12px;" id="refreshGhBtn">🔄 GitHub 새로고침</button>
    </div>

    <div id="reportList"></div>
  </div>

  <section id="adminView" class="hidden">
    <div class="toolbar">
      <button class="btn alt" id="backBtn">← 보관소로 돌아가기</button>
      <strong>🔐 보고서 관리자</strong>
      <button id="lockBtn" class="btn alt adminlink hidden">로그아웃 / 잠금</button>
    </div>

    <div class="panel" id="authPanel">
      <h2 id="authTitle">1. 관리자 인증</h2>
      <div id="setupHelp" class="notice hidden">
        최초 실행입니다. 관리자 암호를 설정하세요. 이 암호는 현재 브라우저에 안전하게 저장됩니다.
      </div>
      <div class="field">
        <label for="password">관리자 암호 (8자 이상)</label>
        <input id="password" type="password" autocomplete="new-password" placeholder="관리자 암호">
      </div>
      <div id="confirmWrap" class="field hidden">
        <label for="confirmPassword">암호 재입력</label>
        <input id="confirmPassword" type="password" autocomplete="new-password" placeholder="관리자 암호 확인">
      </div>
      <button id="authSubmit" class="btn">인증</button>
      <p class="mini">이 암호 기능은 브라우저 상의 관리자 화면을 잠그는 기능입니다.</p>
    </div>

    <div id="editor" class="hidden">
      <div class="panel" style="border: 1.5px solid #0f3f72; background: #f8fbff;">
        <h2>1. GitHub 클라우드 연동 및 자동 발행</h2>
        <div class="notice">
          보고서를 GitHub에 연동하면 <b>GitHub Pages 무료 웹사이트</b>나 <b>공유 링크</b>를 통해 누구나 실시간으로 최신 보고서를 열람할 수 있습니다.
        </div>
        <div class="field">
          <label>저장소 소유자 (GitHub 사용자명 / 조직명)</label>
          <input id="ghOwner" type="text" placeholder="예: dbyte06">
        </div>
        <div class="field">
          <label>저장소 이름 (Repository)</label>
          <input id="ghRepo" type="text" placeholder="예: chemmarket-reports">
        </div>
        <div class="field">
          <label>GitHub 개인 액세스 토큰 (Personal Access Token, PAT) [업로드·커밋 시 필수]</label>
          <input id="ghToken" type="password" placeholder="ghp_... 또는 github_pat_...">
          <span class="mini">* 토큰 권한: 'repo' 또는 'Contents: Read and write' 선택.</span>
        </div>
        <div id="ghStatusNotice" class="notice hidden"></div>
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:12px;">
          <button class="btn alt" id="testGhBtn">저장소 연결 테스트</button>
          <button class="btn green" id="pushAllGhBtn">로컬 보고서 → GitHub로 전체 커밋</button>
          <button class="btn alt" id="pullGhBtn">GitHub에서 최신 보고서 가져오기</button>
        </div>
      </div>

      <div class="panel">
        <h2>2. HTML 보고서 등록</h2>
        <div class="notice">
          보고서는 <b>HTML 파일(.html, .htm)</b>로 업로드합니다. 날짜·분류·제목은 등록 전에 수정할 수 있으며, 여러 개를 한 번에 선택할 수 있습니다.
        </div>
        <div class="filebox" id="filebox">
          📄 <b>HTML 파일 선택</b><br><br>
          <span style="font-size:12px; color:#64748b;">(클릭하거나 드래그하여 파일을 추가하세요)</span><br><br>
          <input id="files" type="file" accept=".html,.htm,text/html" multiple>
        </div>
        <div id="pending"></div>
        <div style="margin: 12px 0; display:flex; align-items:center; gap:8px;">
          <input id="autoPushGh" type="checkbox" checked style="width:18px; height:18px; cursor:pointer;">
          <label for="autoPushGh" style="font-size:13px; font-weight:700; cursor:pointer;">
            저장 시 GitHub 저장소에도 자동 커밋 &amp; 발행
          </label>
        </div>
        <button class="btn green" id="saveReports" disabled>선택한 HTML 보고서 저장</button>
      </div>

      <div class="panel">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
          <h2 style="margin:0;">3. 등록 보고서 관리</h2>
          <button class="btn alt" style="font-size:12px; padding:6px 10px;" id="addSamplesBtn">+ 데모 샘플 보고서 추가</button>
        </div>
        <div id="manageList"></div>
      </div>

      <div class="panel">
        <h2>4. 보관 데이터 백업 / 복원</h2>
        <button class="btn alt" id="backup">전체 백업 다운로드</button>
        <input id="restore" type="file" accept=".json,application/json" style="max-width:240px">
      </div>

      <div class="panel">
        <h2>5. 관리자 암호 변경</h2>
        <div class="field">
          <label>새 관리자 암호</label>
          <input id="newPass" type="password" minlength="8" placeholder="8자 이상">
        </div>
        <div class="field">
          <label>새 관리자 암호 확인</label>
          <input id="newPass2" type="password" minlength="8">
        </div>
        <button id="changePass" class="btn alt">암호 변경</button>
      </div>
    </div>
  </section>
</main>

<div class="viewer hidden" id="viewer">
  <div class="viewerbar">
    <button id="closeViewer" class="btn alt">← 목록</button>
    <strong id="viewerTitle"></strong>
    <button id="shareSingleReportBtn" class="btn alt">🔗 링크 공유</button>
    <button id="printReport" class="btn">🖨 인쇄 / PDF 저장</button>
    <button id="downloadReport" class="btn alt">HTML 다운로드</button>
  </div>
  <iframe id="reportFrame" title="HTML 보고서" sandbox="allow-same-origin allow-modals"></iframe>
</div>

<div class="modal-backdrop hidden" id="shareModal">
  <div class="modal-box">
    <div class="modal-header">
      <h3>보고서 보관소 공유하기</h3>
      <button class="btn alt" style="padding:4px 8px;" id="closeShareModal">✕</button>
    </div>
    <div style="font-size:13px; line-height:1.6; color:#334155;">
      <div class="field">
        <label><b>1. 웹 브라우저 실시간 공유 링크</b></label>
        <input type="text" id="shareWebUrlInput" readonly style="font-family:monospace; font-size:12px;">
        <button class="btn alt" style="margin-top:6px; font-size:12px;" id="copyWebUrlBtn">공유 링크 복사</button>
      </div>

      <div class="field" style="margin-top:16px;">
        <label><b>2. GitHub Pages 웹사이트 주소</b></label>
        <input type="text" id="shareGhPagesInput" readonly style="font-family:monospace; font-size:12px;">
        <button class="btn alt" style="margin-top:6px; font-size:12px;" id="copyGhPagesBtn">GitHub Pages 주소 복사</button>
      </div>

      <div class="field" style="margin-top:16px;">
        <label><b>3. GitHub 원본 저장소</b></label>
        <a id="shareGhRepoLink" href="#" target="_blank" rel="noreferrer" style="color:#2563eb; font-weight:700;">GitHub에서 열기 ↗</a>
      </div>
    </div>
  </div>
</div>

<div id="toast" role="status"></div>

<script>
'use strict';
const $ = id => document.getElementById(id);
let db, unlocked = false, filter = '전체', allReports = [], pending = [], current = null;
let mode = 'local';

const EMBEDDED_REPORTS = ${serializedInitial};

function toast(s) {
  $('toast').textContent = s;
  $('toast').style.display = 'block';
  clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(() => $('toast').style.display = 'none', 3600);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function req(r) {
  return new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
}

async function openDB() {
  return new Promise((ok, no) => {
    try {
      const r = indexedDB.open('chemMarketHTMLArchive_v1', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('reports')) d.createObjectStore('reports', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings', { keyPath: 'key' });
      };
      r.onsuccess = () => ok(r.result);
      r.onerror = () => no(r.error);
    } catch (e) {
      no(e);
    }
  });
}

async function storeGet(name, key) {
  if (!db) return null;
  return req(db.transaction(name, 'readonly').objectStore(name).get(key));
}
async function storeAll(name) {
  if (!db) return [];
  return req(db.transaction(name, 'readonly').objectStore(name).getAll());
}
async function storePut(name, value) {
  if (!db) return;
  return req(db.transaction(name, 'readwrite').objectStore(name).put(value));
}
async function storeDel(name, key) {
  if (!db) return;
  return req(db.transaction(name, 'readwrite').objectStore(name).delete(key));
}

function getGhConfig() {
  try {
    const raw = localStorage.getItem('chemmarket_gh_config');
    if (raw) return JSON.parse(raw);
  } catch (e) {}

  let autoOwner = '';
  let autoRepo = '';
  if (location.hostname.endsWith('github.io')) {
    autoOwner = location.hostname.split('.')[0];
    const pathParts = location.pathname.split('/').filter(Boolean);
    if (pathParts.length > 0) autoRepo = pathParts[0];
  }

  const p = new URLSearchParams(location.search);
  const repoParam = p.get('repo');
  if (repoParam && repoParam.includes('/')) {
    const [o, r] = repoParam.split('/');
    autoOwner = o;
    autoRepo = r;
  }

  return { owner: autoOwner, repo: autoRepo, branch: 'main', token: '', reportsPath: 'reports' };
}

function saveGhConfig(cfg) {
  try {
    localStorage.setItem('chemmarket_gh_config', JSON.stringify(cfg));
  } catch (e) {}
}

function utf8ToBase64(str) {
  return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (_, p1) => String.fromCharCode(parseInt(p1, 16))));
}
function base64ToUtf8(str) {
  const cleaned = str.replace(/\\s/g, '');
  return decodeURIComponent(Array.prototype.map.call(atob(cleaned), c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
}

async function ghApi(endpoint, token, options = {}) {
  const url = endpoint.startsWith('https://') ? endpoint : 'https://api.github.com' + endpoint;
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(options.headers || {})
  };
  if (token && token.trim()) {
    headers['Authorization'] = 'Bearer ' + token.trim();
  }
  return fetch(url, { ...options, headers });
}

async function fetchReportsFromGitHub(cfg) {
  const { owner, repo, branch, token } = cfg;
  const b = branch || 'main';

  try {
    const localRes = await fetch('./reports.json', { cache: 'no-store' });
    if (localRes.ok) {
      const data = await localRes.json();
      if (Array.isArray(data) && data.length > 0) return data;
    }
  } catch (e) {}

  if (owner && repo) {
    try {
      const rawRes = await fetch('https://raw.githubusercontent.com/' + owner + '/' + repo + '/' + b + '/reports.json', { cache: 'no-store' });
      if (rawRes.ok) {
        const data = await rawRes.json();
        if (Array.isArray(data) && data.length > 0) return data;
      }
    } catch (e) {}

    try {
      const apiRes = await ghApi('/repos/' + owner + '/' + repo + '/contents/reports.json?ref=' + b, token);
      if (apiRes.ok) {
        const fileObj = await apiRes.json();
        if (fileObj.content) {
          const parsed = JSON.parse(base64ToUtf8(fileObj.content));
          if (Array.isArray(parsed)) return parsed;
        }
      }
    } catch (e) {}
  }

  return [];
}

async function commitGhFile(cfg, path, content, message) {
  const { owner, repo, branch, token } = cfg;
  if (!token) throw new Error('GitHub Personal Access Token(PAT)이 필요합니다.');
  const b = branch || 'main';

  let sha;
  try {
    const res = await ghApi('/repos/' + owner + '/' + repo + '/contents/' + path + '?ref=' + b, token);
    if (res.ok) {
      const d = await res.json();
      sha = d.sha;
    }
  } catch (e) {}

  const body = { message: message || 'update ' + path, content: utf8ToBase64(content), branch: b };
  if (sha) body.sha = sha;

  const putRes = await ghApi('/repos/' + owner + '/' + repo + '/contents/' + path, token, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!putRes.ok) {
    const err = await putRes.json().catch(() => ({}));
    throw new Error('GitHub 커밋 실패 (' + putRes.status + '): ' + (err.message || putRes.statusText));
  }
  return true;
}

function bytes(a) { return Array.from(a).map(x => x.toString(16).padStart(2, '0')).join(''); }
function fromHex(s) { return new Uint8Array(s.match(/.{2}/g).map(x => parseInt(x, 16))); }
async function derive(pass, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveBits']);
  return bytes(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 160000, hash: 'SHA-256' }, key, 256)));
}
async function savePassword(pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  await storePut('settings', { key: 'adminAuth', salt: bytes(salt), hash: await derive(pass, salt) });
}
async function hasPassword() { return !!(await storeGet('settings', 'adminAuth')); }

async function authenticate() {
  const p = $('password').value;
  const registered = await hasPassword();
  if (!registered) {
    if (p.length < 8) return toast('암호는 8자 이상 입력해 주세요.');
    if (p !== $('confirmPassword').value) return toast('암호 확인이 일치하지 않습니다.');
    await savePassword(p);
  } else {
    const a = await storeGet('settings', 'adminAuth');
    if (await derive(p, fromHex(a.salt)) !== a.hash) return toast('관리자 암호가 올바르지 않습니다.');
  }
  unlocked = true;
  $('password').value = '';
  $('confirmPassword').value = '';
  showEditor();
  toast('관리자 인증이 완료되었습니다.');
}

async function showAuth() {
  const setup = !(await hasPassword());
  $('setupHelp').classList.toggle('hidden', !setup);
  $('confirmWrap').classList.toggle('hidden', !setup);
  $('authTitle').textContent = setup ? '1. 최초 관리자 암호 설정' : '1. 관리자 인증';
  $('authSubmit').textContent = setup ? '관리자 암호 설정' : '인증';
  $('authPanel').classList.remove('hidden');
  $('editor').classList.add('hidden');
  $('lockBtn').classList.add('hidden');
}

function showEditor() {
  $('authPanel').classList.add('hidden');
  $('editor').classList.remove('hidden');
  $('lockBtn').classList.remove('hidden');
  const cfg = getGhConfig();
  $('ghOwner').value = cfg.owner || '';
  $('ghRepo').value = cfg.repo || '';
  $('ghToken').value = cfg.token || '';
  renderManage();
}

async function adminPage() {
  $('archiveView').classList.add('hidden');
  $('adminView').classList.remove('hidden');
  if (unlocked) showEditor();
  else await showAuth();
}

function back() {
  $('adminView').classList.add('hidden');
  $('archiveView').classList.remove('hidden');
  refresh();
}

async function refresh() {
  const cfg = getGhConfig();

  if (mode === 'github' && cfg.owner && cfg.repo) {
    try {
      const ghList = await fetchReportsFromGitHub(cfg);
      if (ghList.length > 0) {
        allReports = ghList;
      } else {
        allReports = (await storeAll('reports')) || [];
        if (!allReports.length && Array.isArray(EMBEDDED_REPORTS) && EMBEDDED_REPORTS.length) {
          allReports = [...EMBEDDED_REPORTS];
        }
      }
    } catch (e) {
      allReports = (await storeAll('reports')) || [];
    }
  } else {
    allReports = (await storeAll('reports')) || [];
    if (!allReports.length && Array.isArray(EMBEDDED_REPORTS) && EMBEDDED_REPORTS.length) {
      allReports = [...EMBEDDED_REPORTS];
      for (const s of EMBEDDED_REPORTS) await storePut('reports', s);
    }
  }

  allReports.sort((a, b) => b.date.localeCompare(a.date) || (b.created || '').localeCompare(a.created || ''));

  const years = [...new Set(allReports.map(x => (x.date || '').slice(0, 4)))].filter(Boolean).sort().reverse();
  const old = $('year').value;
  $('year').innerHTML = '<option value="">전체 연도</option>' + years.map(y => '<option value="' + esc(y) + '">' + esc(y) + '년</option>').join('');
  $('year').value = years.includes(old) ? old : '';

  updateStatusHeader();
  renderArchive();
  if (unlocked) renderManage();
}

function updateStatusHeader() {
  const cfg = getGhConfig();
  if (mode === 'github' && cfg.owner && cfg.repo) {
    $('statusBadge').className = 'badge-status badge-github';
    $('statusBadge').textContent = '🌐 GitHub 연동 중';
    $('repoText').textContent = cfg.owner + '/' + cfg.repo;
  } else {
    $('statusBadge').className = 'badge-status badge-local';
    $('statusBadge').textContent = '💻 로컬 보관소 모드';
    $('repoText').textContent = '(내 브라우저)';
  }
}

function renderArchive() {
  const q = $('search').value.trim().toLowerCase();
  const year = $('year').value;
  const a = allReports.filter(x => (filter === '전체' || x.category === filter) && (!year || x.date.startsWith(year)) && (!q || (x.title + ' ' + x.date + ' ' + x.category).toLowerCase().includes(q)));

  $('count').textContent = '총 ' + a.length + '건 · 전체 보관 ' + allReports.length + '건 ' + (mode === 'github' ? '(GitHub 모드)' : '');

  if (!a.length) {
    $('reportList').innerHTML = '<div class="month empty">등록된 보고서가 없습니다. 관리자에서 HTML 보고서를 등록하거나 GitHub 저장소를 연동하세요.</div>';
    return;
  }

  const months = {};
  for (const x of a) (months[x.date.slice(0, 7)] ??= []).push(x);

  $('reportList').innerHTML = Object.entries(months).map(([m, items]) => 
    '<section class="month">' +
      '<h3>' + esc(m) + '</h3>' +
      items.map(x => 
        '<div class="row">' +
          '<span class="date">' + esc(x.date) + '</span>' +
          '<span class="tag ' + (x.category === '위클리' ? 'weekly' : x.category === '기획 시황' ? 'special' : '') + '">' + esc(x.category) + '</span>' +
          '<span class="title">' + esc(x.title) + '</span>' +
          '<div class="actions">' +
            '<button class="btn" data-open="' + esc(x.id) + '">리포트 보기</button>' +
            '<button class="btn alt" style="padding:6px 9px;" data-share-id="' + esc(x.id) + '" title="링크 복사">🔗</button>' +
          '</div>' +
        '</div>'
      ).join('') +
    '</section>'
  ).join('');
}

function renderManage() {
  $('manageList').innerHTML = allReports.length ? allReports.map(x => 
    '<div class="row">' +
      '<span class="date">' + esc(x.date) + '</span>' +
      '<span class="tag ' + (x.category === '위클리' ? 'weekly' : x.category === '기획 시황' ? 'special' : '') + '">' + esc(x.category) + '</span>' +
      '<span class="title">' + esc(x.title) + '</span>' +
      '<div class="actions">' +
        '<button class="btn alt" data-open="' + esc(x.id) + '">보기</button>' +
        '<button class="btn alt" data-export="' + esc(x.id) + '">HTML 받기</button>' +
        '<button class="btn danger" data-delete="' + esc(x.id) + '">삭제</button>' +
      </div>' +
    '</div>'
  ).join('') : '<p class="muted">등록된 보고서가 없습니다.</p>';
}

function parseName(filename) {
  const m = filename.match(/(20\\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?([0-3]\\d)/);
  return m ? m[1] + '-' + m[2] + '-' + m[3] : new Date().toISOString().slice(0, 10);
}

function inferCat(filename) {
  return /weekly|위클리/i.test(filename) ? '위클리' : /special|기획/i.test(filename) ? '기획 시황' : '데일리';
}

function renderPending() {
  $('pending').innerHTML = pending.map((x, i) => 
    '<div class="panel" style="background:#f8fafc; margin-top:10px;">' +
      '<b>' + esc(x.filename) + '</b>' +
      '<div class="field"><label>보고서 날짜</label><input type="date" data-i="' + i + '" data-key="date" value="' + esc(x.date) + '"></div>' +
      '<div class="field"><label>분류</label><select data-i="' + i + '" data-key="category">' + ['데일리', '위클리', '기획 시황'].map(y => '<option ' + (x.category === y ? 'selected' : '') + '>' + y + '</option>').join('') + '</select></div>' +
      '<div class="field"><label>보고서 제목</label><input type="text" data-i="' + i + '" data-key="title" value="' + esc(x.title) + '"></div>' +
    '</div>'
  ).join('');
  $('saveReports').disabled = !pending.length;
}

async function loadFiles(e) {
  pending = [];
  for (const file of e.target.files) {
    if (!/\\.html?$/i.test(file.name)) {
      toast('HTML 파일만 등록할 수 있습니다.');
      continue;
    }
    if (file.size > 15 * 1024 * 1024) {
      toast('15MB를 초과하는 파일은 제외됩니다.');
      continue;
    }
    pending.push({
      filename: file.name,
      date: parseName(file.name),
      category: inferCat(file.name),
      title: file.name.replace(/\\.html?$/i, '').replace(/[_-]/g, ' '),
      html: await file.text()
    });
  }
  renderPending();
}

async function saveReports() {
  for (const x of pending) {
    if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(x.date) || !Number.isFinite(Date.parse(x.date))) {
      return toast('올바른 날짜를 입력해 주세요.');
    }
    if (!x.title.trim()) return toast('보고서 제목을 입력해 주세요.');
  }

  const savedList = [];
  for (const x of pending) {
    const item = {
      id: crypto.randomUUID ? crypto.randomUUID() : 'rep-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      date: x.date,
      category: x.category,
      title: x.title.trim(),
      filename: x.filename,
      html: x.html,
      created: new Date().toISOString()
    };
    await storePut('reports', item);
    savedList.push(item);
  }

  const autoPush = $('autoPushGh').checked;
  const cfg = getGhConfig();
  if (autoPush && cfg.owner && cfg.repo && cfg.token) {
    toast('GitHub 저장소로 커밋 중...');
    try {
      for (const item of savedList) {
        await commitGhFile(cfg, 'reports/' + item.filename, item.html, 'feat: add report [' + item.date + '] ' + item.title);
      }
      const updatedCatalog = [...savedList, ...allReports.filter(r => !savedList.some(s => s.id === r.id))];
      await commitGhFile(cfg, 'reports.json', JSON.stringify(updatedCatalog, null, 2), 'chore: update catalog (' + updatedCatalog.length + ' reports)');
      toast(savedList.length + '개 보고서가 로컬 및 GitHub에 저장·발행되었습니다!');
    } catch (err) {
      toast('GitHub 커밋 중 오류: ' + err.message);
    }
  } else {
    toast(savedList.length + '개 HTML 보고서가 저장되었습니다.');
  }

  pending = [];
  $('files').value = '';
  renderPending();
  await refresh();
}

function openReport(id) {
  current = allReports.find(x => x.id === id);
  if (!current) return;
  $('viewerTitle').textContent = current.date + ' | ' + current.title;
  $('reportFrame').srcdoc = current.html;
  $('viewer').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeReport() {
  $('viewer').classList.add('hidden');
  $('reportFrame').removeAttribute('srcdoc');
  document.body.style.overflow = '';
  current = null;
}

function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}

function exportHTML(id) {
  const x = allReports.find(y => y.id === id);
  if (x) download(x.filename || (x.date + '.html'), x.html, 'text/html;charset=utf-8');
}

async function removeReport(id) {
  if (!unlocked) return;
  if (!confirm('이 보고서를 삭제할까요?')) return;
  await storeDel('reports', id);
  await refresh();
  toast('보고서를 삭제했습니다.');
}

async function backup() {
  if (!unlocked) return;
  download('ChemMarket_Backup_' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify({ format: 'chemMarketHTMLArchive_v1', reports: allReports }, null, 2), 'application/json');
}

async function restore(e) {
  if (!unlocked) return;
  const f = e.target.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.format !== 'chemMarketHTMLArchive_v1' || !Array.isArray(data.reports)) throw Error('올바른 백업 파일이 아닙니다.');
    if (!confirm(data.reports.length + '개 보고서를 복원할까요?')) return;
    for (const x of data.reports) await storePut('reports', x);
    await refresh();
    toast('복원이 완료되었습니다.');
  } catch (err) {
    toast('복원 실패: ' + err.message);
  } finally {
    e.target.value = '';
  }
}

async function testGh() {
  const cfg = {
    owner: $('ghOwner').value.trim(),
    repo: $('ghRepo').value.trim(),
    token: $('ghToken').value.trim(),
    branch: 'main'
  };
  saveGhConfig(cfg);

  if (!cfg.owner || !cfg.repo) return toast('저장소 소유자와 이름을 입력하세요.');
  $('ghStatusNotice').className = 'notice';
  $('ghStatusNotice').textContent = 'GitHub 저장소 확인 중...';
  $('ghStatusNotice').classList.remove('hidden');

  try {
    const res = await ghApi('/repos/' + cfg.owner + '/' + cfg.repo, cfg.token);
    if (!res.ok) throw new Error('연결 실패 (' + res.status + ')');
    const d = await res.json();
    $('ghStatusNotice').innerHTML = '✅ 연결 성공! (' + d.full_name + ') ' + (d.private ? '🔒 비공개' : '🌐 공개') +
      (d.has_pages ? '<br>GitHub Pages: <a href="https://' + cfg.owner + '.github.io/' + cfg.repo + '/" target="_blank" style="color:#2563eb; font-weight:bold;">https://' + cfg.owner + '.github.io/' + cfg.repo + '/</a>' : '');
    toast('GitHub 연결 성공!');
  } catch (err) {
    $('ghStatusNotice').className = 'notice warning';
    $('ghStatusNotice').textContent = '연결 오류: ' + err.message;
  }
}

async function pushAllToGh() {
  const cfg = getGhConfig();
  cfg.owner = $('ghOwner').value.trim();
  cfg.repo = $('ghRepo').value.trim();
  cfg.token = $('ghToken').value.trim();
  saveGhConfig(cfg);

  if (!cfg.token) return toast('커밋을 위해 GitHub Personal Access Token(PAT)이 필요합니다.');
  if (!confirm(allReports.length + '개 보고서를 GitHub 저장소로 전체 업로드/커밋할까요?')) return;

  toast('GitHub 저장소로 전체 보고서 업로드 중...');
  try {
    for (let i = 0; i < allReports.length; i++) {
      const r = allReports[i];
      await commitGhFile(cfg, 'reports/' + (r.filename || r.date + '.html'), r.html, 'sync: publish ' + r.title);
    }
    await commitGhFile(cfg, 'reports.json', JSON.stringify(allReports, null, 2), 'sync: full catalog update (' + allReports.length + ' reports)');
    toast(allReports.length + '개 보고서가 GitHub에 커밋되었습니다!');
  } catch (err) {
    toast('업로드 실패: ' + err.message);
  }
}

async function pullFromGh() {
  const cfg = getGhConfig();
  cfg.owner = $('ghOwner').value.trim();
  cfg.repo = $('ghRepo').value.trim();
  cfg.token = $('ghToken').value.trim();
  saveGhConfig(cfg);

  toast('GitHub에서 최신 보고서 불러오는 중...');
  try {
    const list = await fetchReportsFromGitHub(cfg);
    if (!list.length) return toast('GitHub 저장소에서 보고서를 찾지 못했습니다.');
    for (const r of list) await storePut('reports', r);
    await refresh();
    toast(list.length + '개 보고서를 GitHub에서 성공적으로 가져왔습니다!');
  } catch (err) {
    toast('가져오기 실패: ' + err.message);
  }
}

function openShareModal() {
  const cfg = getGhConfig();
  const origin = location.origin + location.pathname;
  let webUrl = origin;
  if (cfg.owner && cfg.repo) webUrl += '?repo=' + cfg.owner + '/' + cfg.repo;

  $('shareWebUrlInput').value = webUrl;
  $('shareGhPagesInput').value = cfg.owner && cfg.repo ? 'https://' + cfg.owner + '.github.io/' + cfg.repo + '/' : 'GitHub 저장소 설정 후 표시됩니다';
  $('shareGhRepoLink').href = cfg.owner && cfg.repo ? 'https://github.com/' + cfg.owner + '/' + cfg.repo : '#';

  $('shareModal').classList.remove('hidden');
}

async function copyText(text, msg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(msg || '클립보드에 복사되었습니다.');
  } catch (e) {
    toast('복사 실패');
  }
}

$('tabs').addEventListener('click', e => {
  const b = e.target.closest('[data-filter]');
  if (!b) return;
  filter = b.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach(x => x.classList.toggle('active', x === b));
  renderArchive();
});
$('search').addEventListener('input', renderArchive);
$('year').addEventListener('change', renderArchive);
$('adminBtn').onclick = adminPage;
$('backBtn').onclick = back;
$('authSubmit').onclick = () => authenticate().catch(e => toast('인증 오류: ' + e.message));
$('password').addEventListener('keydown', e => { if (e.key === 'Enter') $('authSubmit').click(); });
$('lockBtn').onclick = () => { unlocked = false; showAuth(); toast('관리자 화면이 잠겼습니다.'); };
$('files').onchange = loadFiles;
$('filebox').onclick = () => $('files').click();
$('pending').addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.i !== undefined) pending[+t.dataset.i][t.dataset.key] = t.value;
});
$('pending').addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.i !== undefined) pending[+t.dataset.i][t.dataset.key] = t.value;
});
$('saveReports').onclick = saveReports;

document.addEventListener('click', e => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.open) openReport(t.dataset.open);
  if (t.dataset.export) exportHTML(t.dataset.export);
  if (t.dataset.delete) removeReport(t.dataset.delete);
  if (t.dataset.shareId) {
    const rId = t.dataset.shareId;
    const cfg = getGhConfig();
    const url = location.origin + location.pathname + '?' + (cfg.owner && cfg.repo ? 'repo=' + cfg.owner + '/' + cfg.repo + '&' : '') + 'report=' + rId;
    copyText(url, '보고서 링크가 복사되었습니다!');
  }
});

$('closeViewer').onclick = closeReport;
$('printReport').onclick = () => {
  try {
    $('reportFrame').contentWindow.focus();
    $('reportFrame').contentWindow.print();
  } catch (e) {
    toast('인쇄 권한을 확인해 주세요.');
  }
};
$('downloadReport').onclick = () => current && exportHTML(current.id);
$('shareSingleReportBtn').onclick = () => {
  if (!current) return;
  const cfg = getGhConfig();
  const url = location.origin + location.pathname + '?' + (cfg.owner && cfg.repo ? 'repo=' + cfg.owner + '/' + cfg.repo + '&' : '') + 'report=' + current.id;
  copyText(url, '보고서 링크 복사 완료!');
};

$('backup').onclick = backup;
$('restore').onchange = restore;
$('changePass').onclick = async () => {
  if (!unlocked) return;
  const a = $('newPass').value;
  if (a.length < 8 || a !== $('newPass2').value) return toast('8자 이상의 동일한 새 암호를 입력해 주세요.');
  await savePassword(a);
  $('newPass').value = '';
  $('newPass2').value = '';
  toast('관리자 암호를 변경했습니다.');
};

$('shareBtn').onclick = openShareModal;
$('closeShareModal').onclick = () => $('shareModal').classList.add('hidden');
$('copyWebUrlBtn').onclick = () => copyText($('shareWebUrlInput').value, '공유 링크가 복사되었습니다!');
$('copyGhPagesBtn').onclick = () => copyText($('shareGhPagesInput').value, 'GitHub Pages 주소가 복사되었습니다!');

$('ghSettingsBtn').onclick = () => adminPage();
$('switchModeBtn').onclick = () => {
  mode = mode === 'local' ? 'github' : 'local';
  toast(mode === 'github' ? 'GitHub 모드로 전환했습니다.' : '로컬 보관소 모드로 전환했습니다.');
  refresh();
};
$('refreshGhBtn').onclick = () => {
  toast('새로고침 중...');
  refresh();
};

$('testGhBtn').onclick = testGh;
$('pushAllGhBtn').onclick = pushAllToGh;
$('pullGhBtn').onclick = pullFromGh;

$('addSamplesBtn').onclick = async () => {
  if (!confirm('샘플 보고서를 추가하시겠습니까?')) return;
  if (Array.isArray(EMBEDDED_REPORTS)) {
    for (const s of EMBEDDED_REPORTS) await storePut('reports', s);
  }
  await refresh();
  toast('샘플 보고서가 추가되었습니다.');
};

(async () => {
  try {
    db = await openDB();
  } catch (e) {
    console.warn('IndexedDB failed, running in memory/network mode', e);
  }

  const cfg = getGhConfig();
  if (cfg.owner && cfg.repo) {
    mode = 'github';
  }

  const p = new URLSearchParams(location.search);
  const repId = p.get('report');

  await refresh();

  if (repId) {
    const target = allReports.find(x => x.id === repId || x.id.includes(repId));
    if (target) openReport(target.id);
  }
})();
</script>
</body>
</html>`;
}

// Generate complete downloadable ZIP for GitHub repository with GitHub Pages workflow
export async function generateGitHubPagesZip(
  reports: ReportItem[],
  config?: GitHubConfig
): Promise<Blob> {
  const zip = new JSZip();

  const title = 'ChemMarket Intelligence | Report Archive';
  const subtitle = '석유화학 시황 · 가격 · 인사이트 | HTML 보고서 보관소';

  // 1. Root index.html (self-contained with embedded reports & GitHub sync)
  zip.file('index.html', generateStandaloneIndexHtml(title, subtitle, reports));

  // 2. reports.json
  zip.file('reports.json', JSON.stringify(reports, null, 2));

  // 3. reports/ folder with individual .html files
  const reportsFolder = zip.folder('reports');
  if (reportsFolder) {
    for (const r of reports) {
      const name = r.filename || `${r.date}_${r.id.slice(0, 8)}.html`;
      reportsFolder.file(name, r.html);
    }
  }

  // 4. GitHub Actions workflow for automated Pages deployment
  const workflowsFolder = zip.folder('.github')?.folder('workflows');
  if (workflowsFolder) {
    workflowsFolder.file(
      'deploy-pages.yml',
      `name: Deploy ChemMarket Archive to GitHub Pages

on:
  push:
    branches: ["main"]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: "pages"
  cancel-in-progress: false

jobs:
  deploy:
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Setup Pages
        uses: actions/configure-pages@v4
      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: '.'
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
`
    );
  }

  // 5. README.md with clear Korean setup instructions
  zip.file(
    'README.md',
    `# ChemMarket Intelligence | HTML 보고서 보관소

석유화학 시황 · 가격 · 인사이트 HTML 보고서 웹 보관소입니다.  
GitHub Pages 및 GitHub 저장소를 통해 팀원 및 고객사와 실시간으로 공유할 수 있습니다.

## 🚀 빠른 시작 (GitHub Pages 배포 방법)

1. 이 저장소를 본인의 GitHub 계정에 업로드(Push)합니다.
2. GitHub 저장소 상단 **Settings** → 좌측 메뉴 **Pages**로 이동합니다.
3. **Build and deployment** 항목의 **Source**를 \`GitHub Actions\` 또는 \`Deploy from a branch\`(main / root)로 지정합니다.
4. 배포가 완료되면 발급된 주소(\`https://<사용자이름>.github.io/<저장소이름>/\`)를 동료들에게 공유하세요!

## 📂 파일 구조
- \`index.html\` : 모바일/PC 반응형 리포트 검색 및 뷰어 웹 페이지
- \`reports.json\` : 등록된 모든 보고서의 메타데이터 및 인덱스
- \`reports/\` : 개별 HTML 보고서 원본 파일들
- \`.github/workflows/deploy-pages.yml\` : GitHub Pages 자동 배포 워크플로우

---
발행: ChemMarket Intelligence Center
`
  );

  return zip.generateAsync({ type: 'blob' });
}
