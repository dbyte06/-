/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useMemo, ChangeEvent } from 'react';
import {
  initDB,
  getAllReports,
  putReport,
  deleteReport,
  hasPassword,
  savePassword,
  verifyPassword,
  downloadFile
} from './db';
import { ReportItem, SAMPLE_REPORTS } from './sampleReports';
import {
  GitHubConfig,
  getSavedGitHubConfig,
  saveGitHubConfig,
  testGitHubConnection,
  fetchReportsFromGitHub,
  commitReportAndCatalogToGitHub,
  pushAllReportsToGitHub,
  generateGitHubPagesZip,
  generateStandaloneIndexHtml,
  ConnectionTestResult
} from './github';
import {
  Github,
  Share2,
  Cloud,
  Database,
  Upload,
  Download,
  RefreshCw,
  ExternalLink,
  Check,
  Copy,
  Lock,
  Unlock,
  Printer,
  BookOpen,
  CheckCircle2,
  AlertCircle,
  FileText,
  HelpCircle,
  X,
  FileCode,
  Globe
} from 'lucide-react';

interface PendingReport {
  filename: string;
  date: string;
  category: '데일리' | '위클리' | '기획 시황';
  title: string;
  html: string;
}

export default function App() {
  const [reports, setReports] = useState<ReportItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [activeTab, setActiveTab] = useState<string>('전체');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedYear, setSelectedYear] = useState<string>('');

  // Storage source mode: 'local' | 'github'
  const [dataSource, setDataSource] = useState<'local' | 'github'>('local');

  // GitHub state
  const [ghConfig, setGhConfig] = useState<GitHubConfig>(getSavedGitHubConfig());
  const [ghTestResult, setGhTestResult] = useState<ConnectionTestResult | null>(null);
  const [isTestingGh, setIsTestingGh] = useState<boolean>(false);
  const [isSyncingGh, setIsSyncingGh] = useState<boolean>(false);
  const [syncProgress, setSyncProgress] = useState<string>('');
  const [autoCommitToGh, setAutoCommitToGh] = useState<boolean>(true);

  // Modals
  const [showShareModal, setShowShareModal] = useState<boolean>(false);
  const [showGhSetupModal, setShowGhSetupModal] = useState<boolean>(false);
  const [showGhGuideModal, setShowGhGuideModal] = useState<boolean>(false);
  const [copiedLink, setCopiedLink] = useState<string | null>(null);

  // View state: 'archive' or 'admin'
  const [view, setView] = useState<'archive' | 'admin'>('archive');
  const [isAdminUnlocked, setIsAdminUnlocked] = useState<boolean>(false);
  const [isPasswordRegistered, setIsPasswordRegistered] = useState<boolean>(false);

  // Auth inputs
  const [authPassword, setAuthPassword] = useState<string>('');
  const [authConfirmPassword, setAuthConfirmPassword] = useState<string>('');

  // Password change inputs
  const [newPassword, setNewPassword] = useState<string>('');
  const [newPasswordConfirm, setNewPasswordConfirm] = useState<string>('');

  // Pending file upload
  const [pendingList, setPendingList] = useState<PendingReport[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const restoreInputRef = useRef<HTMLInputElement>(null);

  // Active Report in Viewer
  const [activeReport, setActiveReport] = useState<ReportItem | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Toast
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const showToast = (msg: string) => {
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    setToastMessage(msg);
    toastTimerRef.current = window.setTimeout(() => {
      setToastMessage(null);
    }, 4000);
  };

  // URL Query handling for shared links (e.g. ?repo=owner/repo&branch=main&report=id)
  useEffect(() => {
    (async () => {
      try {
        await initDB();
        const hasPw = await hasPassword();
        setIsPasswordRegistered(hasPw);

        const params = new URLSearchParams(window.location.search);
        const repoParam = params.get('repo');
        const branchParam = params.get('branch') || 'main';
        const reportParam = params.get('report');
        const modeParam = params.get('mode');

        if (repoParam && repoParam.includes('/')) {
          const [owner, repo] = repoParam.split('/');
          const initialGhConfig: GitHubConfig = {
            ...ghConfig,
            owner: owner.trim(),
            repo: repo.trim(),
            branch: branchParam,
            enabled: true
          };
          setGhConfig(initialGhConfig);
          saveGitHubConfig(initialGhConfig);
          setDataSource('github');
          showToast(`GitHub 저장소 (${owner}/${repo}) 연결 중...`);

          try {
            const ghReports = await fetchReportsFromGitHub(initialGhConfig);
            if (ghReports.length > 0) {
              ghReports.sort((a, b) => b.date.localeCompare(a.date) || b.created.localeCompare(a.created));
              setReports(ghReports);
              showToast(`GitHub에서 ${ghReports.length}개 보고서를 성공적으로 불러왔습니다.`);

              if (reportParam) {
                const target = ghReports.find(r => r.id === reportParam || r.id.includes(reportParam));
                if (target) {
                  setActiveReport(target);
                  document.body.style.overflow = 'hidden';
                }
              }
              setLoading(false);
              return;
            } else {
              showToast('GitHub 저장소에서 보고서를 찾지 못하여 로컬 보관소로 전환합니다.');
            }
          } catch {
            showToast('GitHub 보고서 불러오기 실패. 로컬 보관소로 연결합니다.');
          }
        }

        // Default or fallback to local DB
        if (modeParam === 'github' && ghConfig.owner && ghConfig.repo) {
          setDataSource('github');
          await loadFromGitHub(ghConfig);
        } else {
          setDataSource('local');
          await reloadLocalReports();
        }

        if (reportParam) {
          const list = await getAllReports();
          const target = list.find(r => r.id === reportParam || r.id.includes(reportParam));
          if (target) {
            setActiveReport(target);
            document.body.style.overflow = 'hidden';
          }
        }
      } catch (err: any) {
        showToast('저장소 초기화 오류: ' + (err?.message || err));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const reloadLocalReports = async () => {
    const list = await getAllReports();
    list.sort((a, b) => b.date.localeCompare(a.date) || b.created.localeCompare(a.created));
    setReports(list);
  };

  const loadFromGitHub = async (configToUse?: GitHubConfig) => {
    const cfg = configToUse || ghConfig;
    if (!cfg.owner || !cfg.repo) {
      showToast('GitHub 저장소 소유자(Owner)와 저장소 이름(Repo)을 먼저 입력하세요.');
      setShowGhSetupModal(true);
      return;
    }

    setIsSyncingGh(true);
    setSyncProgress('GitHub 저장소에서 보고서 목록 및 파일을 가져오는 중...');
    try {
      const ghReports = await fetchReportsFromGitHub(cfg);
      if (ghReports.length === 0) {
        showToast(`'${cfg.owner}/${cfg.repo}' 저장소에 reports.json 또는 reports/ 폴더가 비어 있습니다.`);
      } else {
        ghReports.sort((a, b) => b.date.localeCompare(a.date) || b.created.localeCompare(a.created));
        setReports(ghReports);
        setDataSource('github');
        showToast(`GitHub에서 ${ghReports.length}개 보고서를 로드했습니다.`);
      }
    } catch (err: any) {
      showToast('GitHub 데이터 로드 실패: ' + (err?.message || err));
    } finally {
      setIsSyncingGh(false);
      setSyncProgress('');
    }
  };

  const switchDataSource = async (mode: 'local' | 'github') => {
    if (mode === 'github') {
      if (!ghConfig.owner || !ghConfig.repo) {
        setShowGhSetupModal(true);
        return;
      }
      await loadFromGitHub(ghConfig);
    } else {
      setDataSource('local');
      await reloadLocalReports();
      showToast('로컬 브라우저 보관소로 전환되었습니다.');
    }
  };

  // Available Years
  const availableYears = useMemo(() => {
    const set = new Set<string>();
    reports.forEach(r => {
      if (r.date && r.date.length >= 4) {
        set.add(r.date.slice(0, 4));
      }
    });
    return Array.from(set).sort().reverse();
  }, [reports]);

  // Filtered reports
  const filteredReports = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return reports.filter(r => {
      const matchTab = activeTab === '전체' || r.category === activeTab;
      const matchYear = !selectedYear || r.date.startsWith(selectedYear);
      const matchSearch =
        !q ||
        (r.title + ' ' + r.date + ' ' + r.category).toLowerCase().includes(q);
      return matchTab && matchYear && matchSearch;
    });
  }, [reports, activeTab, selectedYear, searchQuery]);

  // Group by Month (YYYY-MM)
  const groupedByMonth = useMemo(() => {
    const map: Record<string, ReportItem[]> = {};
    filteredReports.forEach(r => {
      const m = r.date.slice(0, 7) || '기타';
      if (!map[m]) map[m] = [];
      map[m].push(r);
    });
    return Object.entries(map);
  }, [filteredReports]);

  // Viewer controls
  const handleOpenReport = (report: ReportItem) => {
    setActiveReport(report);
    document.body.style.overflow = 'hidden';
  };

  const handleCloseViewer = () => {
    setActiveReport(null);
    document.body.style.overflow = '';
  };

  const handlePrint = () => {
    try {
      if (iframeRef.current?.contentWindow) {
        iframeRef.current.contentWindow.focus();
        iframeRef.current.contentWindow.print();
      }
    } catch {
      showToast('인쇄가 차단되었습니다. 브라우저에서 인쇄 권한을 확인해 주세요.');
    }
  };

  const handleDownloadReport = (r: ReportItem) => {
    downloadFile(r.filename || `${r.date}.html`, r.html, 'text/html;charset=utf-8');
  };

  // Copy helper
  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedLink(label);
      showToast(`${label} 복사 완료! 동료들에게 바로 공유하세요.`);
      setTimeout(() => setCopiedLink(null), 2500);
    } catch {
      showToast('클립보드 복사 실패');
    }
  };

  // Admin page navigation
  const handleEnterAdmin = async () => {
    const hasPw = await hasPassword();
    setIsPasswordRegistered(hasPw);
    setView('admin');
  };

  const handleBackToArchive = () => {
    setView('archive');
  };

  const handleLockAdmin = () => {
    setIsAdminUnlocked(false);
    setAuthPassword('');
    setAuthConfirmPassword('');
    showToast('관리자 화면이 잠겼습니다.');
  };

  // Admin Authenticate / Register
  const handleAuthSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!isPasswordRegistered) {
      if (authPassword.length < 8) {
        showToast('암호는 8자 이상 입력해 주세요.');
        return;
      }
      if (authPassword !== authConfirmPassword) {
        showToast('암호 확인이 일치하지 않습니다.');
        return;
      }
      try {
        await savePassword(authPassword);
        setIsPasswordRegistered(true);
        setIsAdminUnlocked(true);
        setAuthPassword('');
        setAuthConfirmPassword('');
        showToast('관리자 암호가 등록되었으며 인증되었습니다.');
      } catch (err: any) {
        showToast('암호 저장 실패: ' + (err?.message || err));
      }
    } else {
      try {
        const ok = await verifyPassword(authPassword);
        if (!ok) {
          showToast('관리자 암호가 올바르지 않습니다.');
          return;
        }
        setIsAdminUnlocked(true);
        setAuthPassword('');
        showToast('관리자 인증이 완료되었습니다.');
      } catch (err: any) {
        showToast('인증 오류: ' + (err?.message || err));
      }
    }
  };

  // Change password
  const handleChangePassword = async () => {
    if (!isAdminUnlocked) return;
    if (newPassword.length < 8 || newPassword !== newPasswordConfirm) {
      showToast('8자 이상의 동일한 새 암호를 입력해 주세요.');
      return;
    }
    try {
      await savePassword(newPassword);
      setNewPassword('');
      setNewPasswordConfirm('');
      showToast('관리자 암호를 변경했습니다.');
    } catch (err: any) {
      showToast('암호 변경 실패: ' + (err?.message || err));
    }
  };

  // GitHub Connection test
  const handleTestGh = async () => {
    setIsTestingGh(true);
    setGhTestResult(null);
    try {
      const res = await testGitHubConnection(ghConfig);
      setGhTestResult(res);
      if (res.success) {
        saveGitHubConfig(ghConfig);
        showToast(res.message);
      } else {
        showToast(res.message);
      }
    } catch (err: any) {
      setGhTestResult({ success: false, message: '테스트 오류: ' + (err?.message || err) });
    } finally {
      setIsTestingGh(false);
    }
  };

  // Push local reports to GitHub
  const handlePushAllToGitHub = async () => {
    if (!ghConfig.token) {
      showToast('GitHub에 커밋하려면 Personal Access Token(PAT)이 필요합니다.');
      setShowGhSetupModal(true);
      return;
    }
    if (!window.confirm(`현재 보관된 ${reports.length}개의 보고서를 GitHub 저장소(${ghConfig.owner}/${ghConfig.repo})로 커밋 및 업로드할까요?`)) {
      return;
    }

    setIsSyncingGh(true);
    try {
      const res = await pushAllReportsToGitHub(ghConfig, reports, msg => {
        setSyncProgress(msg);
      });
      showToast(res.message);
      // Auto test
      await handleTestGh();
    } catch (err: any) {
      showToast('GitHub 업로드 실패: ' + (err?.message || err));
    } finally {
      setIsSyncingGh(false);
      setSyncProgress('');
    }
  };

  // Download GitHub Pages complete ZIP
  const handleDownloadPagesZip = async () => {
    try {
      showToast('GitHub 배포용 패키지 ZIP 생성 중...');
      const blob = await generateGitHubPagesZip(reports, ghConfig);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ChemMarket_GitHub_Pages_${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      showToast('GitHub Pages 배포 패키지 다운로드 완료!');
    } catch (err: any) {
      showToast('ZIP 생성 실패: ' + (err?.message || err));
    }
  };

  // Download standalone single index.html for direct GitHub upload
  const handleDownloadSingleHtml = () => {
    try {
      const html = generateStandaloneIndexHtml(
        'ChemMarket Intelligence | Report Archive',
        '석유화학 시황 · 가격 · 인사이트 | HTML 보고서 보관소 & GitHub 클라우드 공유',
        reports
      );
      downloadFile('index.html', html, 'text/html;charset=utf-8');
      showToast('GitHub용 단일 HTML(index.html) 다운로드 완료! 저장소에 직접 업로드하여 배포할 수 있습니다.');
    } catch (err: any) {
      showToast('HTML 다운로드 실패: ' + (err?.message || err));
    }
  };

  // File parsing helpers
  const parseDateFromFilename = (filename: string): string => {
    const m = filename.match(/(20\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?([0-3]\d)/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : new Date().toISOString().slice(0, 10);
  };

  const inferCategory = (filename: string): '데일리' | '위클리' | '기획 시황' => {
    if (/weekly|위클리/i.test(filename)) return '위클리';
    if (/special|기획/i.test(filename)) return '기획 시황';
    return '데일리';
  };

  const handleFilesSelected = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const list: PendingReport[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!/\.html?$/i.test(file.name)) {
        showToast('HTML 파일만 등록할 수 있습니다: ' + file.name);
        continue;
      }
      if (file.size > 15 * 1024 * 1024) {
        showToast('15MB를 초과하는 HTML 파일은 제외됩니다: ' + file.name);
        continue;
      }

      const text = await file.text();
      list.push({
        filename: file.name,
        date: parseDateFromFilename(file.name),
        category: inferCategory(file.name),
        title: file.name.replace(/\.html?$/i, '').replace(/[_-]/g, ' '),
        html: text
      });
    }

    setPendingList(prev => [...prev, ...list]);
  };

  const updatePending = (idx: number, key: keyof PendingReport, value: string) => {
    setPendingList(prev => {
      const next = [...prev];
      next[idx] = { ...next[idx], [key]: value };
      return next;
    });
  };

  const removePending = (idx: number) => {
    setPendingList(prev => prev.filter((_, i) => i !== idx));
  };

  const handleSaveReports = async () => {
    for (const item of pendingList) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(item.date) || !Number.isFinite(Date.parse(item.date))) {
        showToast('올바른 날짜를 입력해 주세요.');
        return;
      }
      if (!item.title.trim()) {
        showToast('보고서 제목을 입력해 주세요.');
        return;
      }
    }

    try {
      const savedItems: ReportItem[] = [];
      for (const item of pendingList) {
        const newReport: ReportItem = {
          id: crypto.randomUUID ? crypto.randomUUID() : 'rep-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
          date: item.date,
          category: item.category,
          title: item.title.trim(),
          filename: item.filename,
          html: item.html,
          created: new Date().toISOString()
        };
        await putReport(newReport);
        savedItems.push(newReport);
      }

      // Check if GitHub auto-commit is enabled and configured
      if (autoCommitToGh && ghConfig.token && ghConfig.owner && ghConfig.repo) {
        showToast('GitHub 저장소로 실시간 커밋 중...');
        try {
          for (const item of savedItems) {
            await commitReportAndCatalogToGitHub(ghConfig, item, reports);
          }
          showToast(`${savedItems.length}개 보고서가 로컬 및 GitHub에 저장·발행되었습니다!`);
        } catch (ghErr: any) {
          showToast('로컬 저장은 완료되었으나 GitHub 커밋 중 오류: ' + (ghErr?.message || ghErr));
        }
      } else {
        showToast(`${savedItems.length}개 HTML 보고서가 로컬에 저장되었습니다.`);
      }

      setPendingList([]);
      if (fileInputRef.current) fileInputRef.current.value = '';
      await reloadLocalReports();
    } catch (err: any) {
      showToast('보고서 저장 실패: ' + (err?.message || err));
    }
  };

  const handleDeleteReport = async (id: string) => {
    if (!isAdminUnlocked) {
      showToast('관리자 인증이 필요합니다.');
      return;
    }
    if (!window.confirm('이 보고서를 삭제할까요? 삭제 후 복구할 수 없습니다.')) {
      return;
    }
    try {
      await deleteReport(id);
      await reloadLocalReports();
      showToast('보고서를 삭제했습니다.');
    } catch (err: any) {
      showToast('보고서 삭제 실패: ' + (err?.message || err));
    }
  };

  // Backup & Restore
  const handleBackup = () => {
    if (!isAdminUnlocked) return;
    const jsonStr = JSON.stringify(
      { format: 'chemMarketHTMLArchive_v1', reports },
      null,
      2
    );
    const today = new Date().toISOString().slice(0, 10);
    downloadFile(`ChemMarket_Backup_${today}.json`, jsonStr, 'application/json');
    showToast('전체 백업 파일 다운로드가 시작되었습니다.');
  };

  const handleRestore = async (e: ChangeEvent<HTMLInputElement>) => {
    if (!isAdminUnlocked) return;
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (data.format !== 'chemMarketHTMLArchive_v1' || !Array.isArray(data.reports)) {
        throw new Error('올바른 백업 파일(chemMarketHTMLArchive_v1)이 아닙니다.');
      }
      if (!window.confirm(`${data.reports.length}개 보고서를 복원할까요? 기존 데이터와 병합됩니다.`)) {
        return;
      }

      for (const r of data.reports) {
        if (
          typeof r.id !== 'string' ||
          typeof r.html !== 'string' ||
          typeof r.date !== 'string' ||
          typeof r.title !== 'string' ||
          !['데일리', '위클리', '기획 시황'].includes(r.category)
        ) {
          throw new Error('백업 데이터 항목의 형식이 올바르지 않습니다.');
        }
        await putReport(r);
      }

      await reloadLocalReports();
      showToast('복원이 완료되었습니다.');
    } catch (err: any) {
      showToast('복원 실패: ' + (err?.message || err));
    } finally {
      if (restoreInputRef.current) restoreInputRef.current.value = '';
    }
  };

  // Restore sample reports helper
  const handleRestoreSampleReports = async () => {
    if (!window.confirm('기본 샘플 보고서(4종)를 추가하시겠습니까?')) return;
    for (const r of SAMPLE_REPORTS) {
      await putReport(r);
    }
    await reloadLocalReports();
    showToast('샘플 보고서가 등록되었습니다.');
  };

  // Sharing links
  const originUrl = typeof window !== 'undefined' ? window.location.origin + window.location.pathname : '';
  const shareWebUrl = useMemo(() => {
    if (ghConfig.owner && ghConfig.repo) {
      return `${originUrl}?repo=${ghConfig.owner}/${ghConfig.repo}&branch=${ghConfig.branch || 'main'}`;
    }
    return originUrl;
  }, [originUrl, ghConfig]);

  const ghPagesUrl = useMemo(() => {
    if (ghConfig.owner && ghConfig.repo) {
      return `https://${ghConfig.owner.toLowerCase()}.github.io/${ghConfig.repo.toLowerCase()}/`;
    }
    return '';
  }, [ghConfig]);

  const ghRepoUrl = useMemo(() => {
    if (ghConfig.owner && ghConfig.repo) {
      return `https://github.com/${ghConfig.owner}/${ghConfig.repo}`;
    }
    return '';
  }, [ghConfig]);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Top Banner / Cloud Sync Status Bar */}
      <div className="bg-[#031322] border-b border-[#1b3552] text-xs px-4 py-2 text-slate-300 flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1.5 font-medium">
            {dataSource === 'github' ? (
              <span className="flex items-center gap-1 text-emerald-400 font-semibold bg-emerald-950/60 border border-emerald-800/80 px-2 py-0.5 rounded">
                <Globe className="w-3.5 h-3.5" />
                GitHub 클라우드 연동 중: {ghConfig.owner}/{ghConfig.repo}
              </span>
            ) : (
              <span className="flex items-center gap-1 text-sky-300 font-semibold bg-sky-950/60 border border-sky-800/80 px-2 py-0.5 rounded">
                <Database className="w-3.5 h-3.5" />
                로컬 보관소 모드 (브라우저)
              </span>
            )}
          </div>

          <div className="flex items-center gap-1">
            <button
              onClick={() => switchDataSource('local')}
              className={`px-2 py-0.5 rounded transition ${
                dataSource === 'local'
                  ? 'bg-slate-700 text-white font-bold'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              로컬
            </button>
            <span className="text-slate-600">|</span>
            <button
              onClick={() => switchDataSource('github')}
              className={`px-2 py-0.5 rounded transition flex items-center gap-1 ${
                dataSource === 'github'
                  ? 'bg-emerald-800 text-white font-bold'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <Github className="w-3 h-3" />
              GitHub 연동
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowGhSetupModal(true)}
            className="flex items-center gap-1 px-2.5 py-1 rounded bg-[#102d4b] hover:bg-[#183f68] text-slate-200 transition text-xs font-semibold border border-[#234b76]"
          >
            <Github className="w-3.5 h-3.5 text-slate-300" />
            GitHub 연동 설정
          </button>

          <button
            onClick={() => setShowShareModal(true)}
            className="flex items-center gap-1 px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white transition text-xs font-bold shadow-sm"
          >
            <Share2 className="w-3.5 h-3.5" />
            다른 사람에게 공유하기
          </button>
        </div>
      </div>

      {/* Header */}
      <header className="chem-header">
        <div style={{ maxWidth: '1100px', margin: '0 auto' }}>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <small>GLOBAL PETROCHEMICAL INSIGHTS</small>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowGhGuideModal(true)}
                className="text-xs bg-white/10 hover:bg-white/20 text-cyan-200 px-3 py-1.5 rounded-md backdrop-blur border border-cyan-400/30 font-semibold transition flex items-center gap-1"
              >
                <BookOpen className="w-3.5 h-3.5" />
                GitHub Pages 배포 가이드
              </button>
            </div>
          </div>
          <h1>ChemMarket Intelligence</h1>
          <p>석유화학 시황 · 가격 · 인사이트 | HTML 보고서 보관소 &amp; GitHub 클라우드 공유</p>
        </div>
      </header>

      {/* Sync indicator if active */}
      {isSyncingGh && (
        <div className="bg-blue-900/90 text-blue-100 text-xs px-4 py-2 text-center flex items-center justify-center gap-2">
          <RefreshCw className="w-3.5 h-3.5 animate-spin text-cyan-300" />
          <span>{syncProgress || 'GitHub와 동기화 중입니다...'}</span>
        </div>
      )}

      {/* Main Content Area */}
      <main className="wrap" style={{ flex: 1 }}>
        {/* Archive View */}
        {view === 'archive' && (
          <div id="archiveView">
            {/* Top Toolbar */}
            <div className="toolbar">
              <div className="tabs" id="tabs">
                {(['전체', '데일리', '위클리', '기획 시황'] as const).map(tab => (
                  <button
                    key={tab}
                    data-filter={tab}
                    className={activeTab === tab ? 'active' : ''}
                    onClick={() => setActiveTab(tab)}
                  >
                    {tab}
                  </button>
                ))}
              </div>

              <input
                className="search"
                id="search"
                placeholder="날짜, 제목 검색"
                aria-label="보고서 검색"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
              />

              <select
                id="year"
                value={selectedYear}
                onChange={e => setSelectedYear(e.target.value)}
              >
                <option value="">전체 연도</option>
                {availableYears.map(y => (
                  <option key={y} value={y}>
                    {y}년
                  </option>
                ))}
              </select>

              <button
                className="btn alt adminlink"
                id="adminBtn"
                onClick={handleEnterAdmin}
              >
                <Lock className="w-3.5 h-3.5" /> 관리자
              </button>
            </div>

            {/* Sub-bar with count & quick actions */}
            <div className="flex items-center justify-between flex-wrap gap-2 my-3">
              <p className="muted" id="count" style={{ margin: 0 }}>
                총 <b className="text-slate-800">{filteredReports.length}건</b> · 전체 보관{' '}
                <b className="text-slate-800">{reports.length}건</b>
                {dataSource === 'github' && (
                  <span className="ml-2 text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded text-[11px] font-semibold">
                    GitHub 연동 모드
                  </span>
                )}
              </p>

              <div className="flex items-center gap-2">
                {dataSource === 'github' && (
                  <button
                    onClick={() => loadFromGitHub()}
                    className="btn alt"
                    style={{ padding: '6px 12px', fontSize: '12px' }}
                    title="GitHub 저장소에서 새로고침"
                  >
                    <RefreshCw className="w-3 h-3" /> GitHub 새로고침
                  </button>
                )}
                <button
                  onClick={() => setShowShareModal(true)}
                  className="btn alt"
                  style={{ padding: '6px 12px', fontSize: '12px' }}
                >
                  <Share2 className="w-3 h-3" /> 공유 링크 생성
                </button>
              </div>
            </div>

            {/* Report List */}
            <div id="reportList">
              {groupedByMonth.length === 0 ? (
                <div className="month empty">
                  <div className="max-w-md mx-auto">
                    <p className="text-base font-semibold text-slate-700 mb-2">
                      등록된 보고서가 없습니다.
                    </p>
                    <p className="text-xs text-slate-500 mb-4">
                      관리자 화면에서 HTML 보고서를 등록하거나, GitHub 저장소와 연동하여 보관된 보고서를 불러올 수 있습니다.
                    </p>
                    <div className="flex items-center justify-center gap-2 flex-wrap">
                      <button
                        className="btn alt"
                        style={{ fontSize: '13px' }}
                        onClick={handleRestoreSampleReports}
                      >
                        샘플 보고서 불러오기 (데모 4건)
                      </button>
                      <button
                        className="btn"
                        style={{ fontSize: '13px' }}
                        onClick={() => setShowGhSetupModal(true)}
                      >
                        <Github className="w-3.5 h-3.5" /> GitHub 저장소 연동하기
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                groupedByMonth.map(([monthKey, items]) => (
                  <section key={monthKey} className="month">
                    <h3>{monthKey}</h3>
                    {items.map(item => (
                      <div key={item.id} className="row">
                        <span className="date">{item.date}</span>
                        <span
                          className={`tag ${
                            item.category === '위클리'
                              ? 'weekly'
                              : item.category === '기획 시황'
                              ? 'special'
                              : ''
                          }`}
                        >
                          {item.category}
                        </span>
                        <span className="title">{item.title}</span>
                        <div className="actions">
                          <button
                            className="btn"
                            onClick={() => handleOpenReport(item)}
                          >
                            리포트 보기
                          </button>
                          <button
                            className="btn alt"
                            style={{ padding: '8px 10px' }}
                            title="보고서 직접 링크 복사"
                            onClick={() => {
                              const directUrl = `${originUrl}?${ghConfig.owner && ghConfig.repo ? `repo=${ghConfig.owner}/${ghConfig.repo}&` : ''}report=${item.id}`;
                              copyToClipboard(directUrl, `[${item.date}] ${item.title} 링크`);
                            }}
                          >
                            <Copy className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </section>
                ))
              )}
            </div>
          </div>
        )}

        {/* Admin View */}
        {view === 'admin' && (
          <section id="adminView">
            <div className="toolbar">
              <button className="btn alt" id="backBtn" onClick={handleBackToArchive}>
                ← 보관소로 돌아가기
              </button>
              <strong>🔐 보고서 관리자</strong>
              {isAdminUnlocked && (
                <button
                  id="lockBtn"
                  className="btn alt adminlink"
                  onClick={handleLockAdmin}
                >
                  <Lock className="w-3.5 h-3.5" /> 로그아웃 / 잠금
                </button>
              )}
            </div>

            {/* Locked: Auth Panel */}
            {!isAdminUnlocked ? (
              <div className="panel" id="authPanel">
                <h2 id="authTitle">
                  {!isPasswordRegistered ? '1. 최초 관리자 암호 설정' : '1. 관리자 인증'}
                </h2>

                {!isPasswordRegistered && (
                  <div id="setupHelp" className="notice">
                    최초 실행입니다. 관리자 암호를 설정하세요. 이 암호는 현재 브라우저에 안전하게 저장됩니다.
                  </div>
                )}

                <form onSubmit={handleAuthSubmit}>
                  <div className="field">
                    <label htmlFor="password">관리자 암호 (8자 이상)</label>
                    <input
                      id="password"
                      type="password"
                      autoComplete="current-password"
                      placeholder="관리자 암호"
                      value={authPassword}
                      onChange={e => setAuthPassword(e.target.value)}
                    />
                  </div>

                  {!isPasswordRegistered && (
                    <div id="confirmWrap" className="field">
                      <label htmlFor="confirmPassword">암호 재입력</label>
                      <input
                        id="confirmPassword"
                        type="password"
                        autoComplete="new-password"
                        placeholder="관리자 암호 확인"
                        value={authConfirmPassword}
                        onChange={e => setAuthConfirmPassword(e.target.value)}
                      />
                    </div>
                  )}

                  <button id="authSubmit" type="submit" className="btn" style={{ marginTop: '8px' }}>
                    {!isPasswordRegistered ? '관리자 암호 설정' : '인증'}
                  </button>
                </form>

                <p className="mini">
                  이 화면의 암호 기능은 브라우저 상의 관리자 기능을 잠그는 기능입니다.
                </p>
              </div>
            ) : (
              /* Unlocked: Editor, GitHub Sync & Management */
              <div id="editor">
                {/* 1. GitHub 클라우드 연동 및 자동 발행 설정 (NEW) */}
                <div className="panel" style={{ border: '1.5px solid #0f3f72', background: '#f8fbff' }}>
                  <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
                    <div className="flex items-center gap-2">
                      <div className="p-1.5 bg-blue-100 rounded-lg text-blue-900">
                        <Github className="w-5 h-5" />
                      </div>
                      <div>
                        <h2 style={{ margin: 0, fontSize: '18px', color: '#092749' }}>
                          1. GitHub 클라우드 연동 및 다른 사람과 공유
                        </h2>
                        <span className="text-xs text-slate-600">
                          보고서를 GitHub 저장소에 동기화하면 누구나 웹 브라우저나 GitHub Pages를 통해 보고서를 볼 수 있습니다.
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={() => setShowGhGuideModal(true)}
                      className="btn alt text-xs"
                      style={{ padding: '6px 10px' }}
                    >
                      <BookOpen className="w-3.5 h-3.5" /> 설정 안내 가이드
                    </button>
                  </div>

                  {/* GitHub Config Quick Fields */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
                    <div className="field" style={{ margin: '4px 0' }}>
                      <label>GitHub 저장소 소유자 (사용자명 또는 조직)</label>
                      <input
                        type="text"
                        placeholder="예: dbyte06"
                        value={ghConfig.owner}
                        onChange={e => {
                          const updated = { ...ghConfig, owner: e.target.value.trim() };
                          setGhConfig(updated);
                          saveGitHubConfig(updated);
                        }}
                      />
                    </div>
                    <div className="field" style={{ margin: '4px 0' }}>
                      <label>저장소 이름 (Repository)</label>
                      <input
                        type="text"
                        placeholder="예: chemmarket-reports"
                        value={ghConfig.repo}
                        onChange={e => {
                          const updated = { ...ghConfig, repo: e.target.value.trim() };
                          setGhConfig(updated);
                          saveGitHubConfig(updated);
                        }}
                      />
                    </div>
                  </div>

                  <div className="field" style={{ margin: '4px 0' }}>
                    <label className="flex items-center justify-between">
                      <span>GitHub 개인 액세스 토큰 (Personal Access Token, PAT)</span>
                      <a
                        href="https://github.com/settings/tokens/new?scopes=repo&description=ChemMarket_Intelligence"
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue-600 hover:underline text-xs flex items-center gap-1"
                      >
                        토큰 발급 바로가기 <ExternalLink className="w-3 h-3" />
                      </a>
                    </label>
                    <input
                      type="password"
                      placeholder="github_pat_... 또는 ghp_... (보고서 업로드 및 비공개 저장소 필수)"
                      value={ghConfig.token || ''}
                      onChange={e => {
                        const updated = { ...ghConfig, token: e.target.value.trim() };
                        setGhConfig(updated);
                        saveGitHubConfig(updated);
                      }}
                    />
                    <span className="text-[11px] text-slate-500">
                      * 단순 공개(Public) 저장소의 보고서 열람은 토큰 없이도 가능하며, 보고서 커밋/업로드 시에는 'repo' 또는 'Contents: Read and write' 권한이 부여된 토큰이 필요합니다.
                    </span>
                  </div>

                  {/* Connection Test Result */}
                  {ghTestResult && (
                    <div
                      className={`notice ${ghTestResult.success ? '' : 'warning'}`}
                      style={{ margin: '12px 0', display: 'flex', alignItems: 'center', gap: '8px' }}
                    >
                      {ghTestResult.success ? (
                        <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
                      ) : (
                        <AlertCircle className="w-5 h-5 text-amber-600 shrink-0" />
                      )}
                      <div>
                        <strong>{ghTestResult.message}</strong>
                        {ghTestResult.repoInfo?.hasPages && (
                          <div className="mt-1">
                            GitHub Pages 활성화됨:{' '}
                            <a
                              href={ghTestResult.repoInfo.pagesUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="text-blue-600 underline font-semibold"
                            >
                              {ghTestResult.repoInfo.pagesUrl}
                            </a>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* GitHub Action Buttons */}
                  <div className="flex items-center gap-2 flex-wrap mt-3 pt-3 border-t border-slate-200">
                    <button
                      className="btn alt"
                      onClick={handleTestGh}
                      disabled={isTestingGh || !ghConfig.owner || !ghConfig.repo}
                    >
                      {isTestingGh ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                      저장소 연결 테스트
                    </button>

                    <button
                      className="btn green"
                      onClick={handlePushAllToGitHub}
                      disabled={isSyncingGh || !ghConfig.token || !ghConfig.owner || !ghConfig.repo}
                      title="로컬 보고서들을 GitHub 저장소로 커밋"
                    >
                      <Upload className="w-3.5 h-3.5" />
                      로컬 보고서 → GitHub로 전체 커밋
                    </button>

                    <button
                      className="btn alt"
                      onClick={() => loadFromGitHub()}
                      disabled={isSyncingGh || !ghConfig.owner || !ghConfig.repo}
                    >
                      <Download className="w-3.5 h-3.5" />
                      GitHub에서 최신 보고서 가져오기
                    </button>

                    <button
                      className="btn alt"
                      onClick={handleDownloadPagesZip}
                      title="GitHub Pages 배포용 전체 ZIP 파일 생성"
                    >
                      <FileCode className="w-3.5 h-3.5" />
                      GitHub Pages 배포 ZIP 다운로드
                    </button>

                    <button
                      className="btn alt"
                      onClick={handleDownloadSingleHtml}
                      title="GitHub 저장소에 올릴 단일 index.html 파일 다운로드"
                    >
                      <FileText className="w-3.5 h-3.5" />
                      GitHub용 단일 HTML (index.html) 다운로드
                    </button>
                  </div>
                </div>

                {/* 2. HTML 보고서 등록 */}
                <div className="panel">
                  <h2>2. HTML 보고서 등록</h2>
                  <div className="notice">
                    보고서는 <b>HTML 파일(.html, .htm)</b>로 업로드합니다. 여러 개를 한 번에 선택할 수 있으며, 날짜·분류·제목은 등록 전에 수정할 수 있습니다. 동일 날짜/분류의 보고서도 별도로 보관됩니다.
                  </div>

                  <div
                    className="filebox"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    📄 <b>HTML 파일 선택</b>
                    <br />
                    <span style={{ fontSize: '13px', color: '#64748b' }}>
                      (클릭하거나 드래그하여 .html 파일을 추가하세요)
                    </span>
                    <br />
                    <br />
                    <input
                      ref={fileInputRef}
                      id="files"
                      type="file"
                      accept=".html,.htm,text/html"
                      multiple
                      style={{ display: 'none' }}
                      onChange={handleFilesSelected}
                    />
                  </div>

                  {pendingList.length > 0 && (
                    <div id="pending" style={{ margin: '18px 0' }}>
                      {pendingList.map((p, idx) => (
                        <div
                          key={idx}
                          className="panel"
                          style={{
                            background: '#f8fafc',
                            border: '1px solid #dae3ed',
                            marginTop: '12px'
                          }}
                        >
                          <div
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              marginBottom: '8px'
                            }}
                          >
                            <b style={{ color: '#0f2744' }}>{p.filename}</b>
                            <button
                              type="button"
                              className="btn alt"
                              style={{ padding: '4px 8px', fontSize: '12px' }}
                              onClick={() => removePending(idx)}
                            >
                              제거
                            </button>
                          </div>
                          <div className="field">
                            <label>보고서 날짜</label>
                            <input
                              type="date"
                              value={p.date}
                              onChange={e => updatePending(idx, 'date', e.target.value)}
                            />
                          </div>
                          <div className="field">
                            <label>분류</label>
                            <select
                              value={p.category}
                              onChange={e =>
                                updatePending(
                                  idx,
                                  'category',
                                  e.target.value as '데일리' | '위클리' | '기획 시황'
                                )
                              }
                            >
                              <option value="데일리">데일리</option>
                              <option value="위클리">위클리</option>
                              <option value="기획 시황">기획 시황</option>
                            </select>
                          </div>
                          <div className="field">
                            <label>보고서 제목</label>
                            <input
                              type="text"
                              value={p.title}
                              onChange={e => updatePending(idx, 'title', e.target.value)}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="my-3 flex items-center gap-2">
                    <input
                      id="autoCommitGh"
                      type="checkbox"
                      checked={autoCommitToGh}
                      onChange={e => setAutoCommitToGh(e.target.checked)}
                      className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 w-4 h-4 cursor-pointer"
                    />
                    <label htmlFor="autoCommitGh" className="text-sm font-semibold text-slate-700 cursor-pointer">
                      저장 시 GitHub 저장소({ghConfig.owner ? `${ghConfig.owner}/${ghConfig.repo}` : '미설정'})에도 자동 커밋 &amp; 발행
                    </label>
                  </div>

                  <button
                    className="btn green"
                    id="saveReports"
                    disabled={pendingList.length === 0}
                    onClick={handleSaveReports}
                  >
                    선택한 {pendingList.length}개 HTML 보고서 저장
                  </button>
                </div>

                {/* 3. 등록 보고서 관리 */}
                <div className="panel">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                    <h2 style={{ margin: 0 }}>3. 등록 보고서 관리</h2>
                    <button
                      className="btn alt"
                      style={{ fontSize: '12px', padding: '6px 10px' }}
                      onClick={handleRestoreSampleReports}
                    >
                      + 샘플 보고서 추가
                    </button>
                  </div>
                  <div id="manageList">
                    {reports.length === 0 ? (
                      <p className="muted">등록된 보고서가 없습니다.</p>
                    ) : (
                      reports.map(r => (
                        <div key={r.id} className="row">
                          <span className="date">{r.date}</span>
                          <span
                            className={`tag ${
                              r.category === '위클리'
                                ? 'weekly'
                                : r.category === '기획 시황'
                                ? 'special'
                                : ''
                            }`}
                          >
                            {r.category}
                          </span>
                          <span className="title">{r.title}</span>
                          <div className="actions">
                            <button
                              className="btn alt"
                              onClick={() => handleOpenReport(r)}
                            >
                              보기
                            </button>
                            <button
                              className="btn alt"
                              onClick={() => handleDownloadReport(r)}
                            >
                              HTML 받기
                            </button>
                            <button
                              className="btn danger"
                              onClick={() => handleDeleteReport(r.id)}
                            >
                              삭제
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                {/* 4. 보관 데이터 백업 / 복원 */}
                <div className="panel">
                  <h2>4. 보관 데이터 로컬 백업 / 복원</h2>
                  <p className="mini">
                    HTML 파일과 등록 정보를 JSON 파일로 백업합니다. 다른 PC로 옮길 때 백업 파일을 가져와 복원할 수 있습니다. 복원 시 기존 보고서는 유지하고 ID가 같은 보고서는 덮어씁니다.
                  </p>
                  <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <button className="btn alt" id="backup" onClick={handleBackup}>
                      전체 백업 다운로드
                    </button>
                    <input
                      ref={restoreInputRef}
                      id="restore"
                      type="file"
                      accept=".json,application/json"
                      style={{ maxWidth: '260px' }}
                      onChange={handleRestore}
                    />
                  </div>
                </div>

                {/* 5. 관리자 암호 변경 */}
                <div className="panel">
                  <h2>5. 관리자 암호 변경</h2>
                  <div className="field">
                    <label>새 관리자 암호</label>
                    <input
                      id="newPass"
                      type="password"
                      minLength={8}
                      placeholder="8자 이상"
                      value={newPassword}
                      onChange={e => setNewPassword(e.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label>새 관리자 암호 확인</label>
                    <input
                      id="newPass2"
                      type="password"
                      minLength={8}
                      placeholder="새 암호 다시 입력"
                      value={newPasswordConfirm}
                      onChange={e => setNewPasswordConfirm(e.target.value)}
                    />
                  </div>
                  <button
                    id="changePass"
                    className="btn alt"
                    onClick={handleChangePassword}
                  >
                    암호 변경
                  </button>
                </div>
              </div>
            )}
          </section>
        )}
      </main>

      {/* Share Modal */}
      {showShareModal && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-xl w-full p-6 border border-slate-200">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <div className="flex items-center gap-2">
                <Share2 className="w-5 h-5 text-blue-600" />
                <h3 className="text-lg font-bold text-slate-900">보고서 보관소 다른 사람에게 공유하기</h3>
              </div>
              <button
                onClick={() => setShowShareModal(false)}
                className="text-slate-400 hover:text-slate-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4 my-4">
              {/* Option 1: Direct Web App link with repo configured */}
              <div className="bg-slate-50 p-3.5 rounded-lg border border-slate-200">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                    <Globe className="w-3.5 h-3.5 text-blue-600" />
                    1. 실시간 웹 보관소 공유 링크 (가장 간편)
                  </span>
                  <button
                    onClick={() => copyToClipboard(shareWebUrl, '실시간 공유 링크')}
                    className="text-xs text-blue-600 hover:text-blue-800 font-bold flex items-center gap-1"
                  >
                    {copiedLink === '실시간 공유 링크' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                    {copiedLink === '실시간 공유 링크' ? '복사됨!' : '링크 복사'}
                  </button>
                </div>
                <input
                  type="text"
                  readOnly
                  value={shareWebUrl}
                  className="w-full text-xs font-mono bg-white border border-slate-300 rounded p-2 text-slate-700 select-all"
                />
                <p className="text-[11px] text-slate-500 mt-1">
                  * 이 링크를 전달받은 동료나 고객은 별도 설치 없이 브라우저에서 바로 모든 보고서를 검색하고 열람할 수 있습니다.
                </p>
              </div>

              {/* Option 2: GitHub Pages URL */}
              {ghPagesUrl && (
                <div className="bg-emerald-50/70 p-3.5 rounded-lg border border-emerald-200">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-bold text-emerald-900 flex items-center gap-1.5">
                      <ExternalLink className="w-3.5 h-3.5 text-emerald-700" />
                      2. GitHub Pages 정적 웹사이트 주소
                    </span>
                    <button
                      onClick={() => copyToClipboard(ghPagesUrl, 'GitHub Pages 주소')}
                      className="text-xs text-emerald-700 hover:text-emerald-900 font-bold flex items-center gap-1"
                    >
                      {copiedLink === 'GitHub Pages 주소' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                      {copiedLink === 'GitHub Pages 주소' ? '복사됨!' : '주소 복사'}
                    </button>
                  </div>
                  <input
                    type="text"
                    readOnly
                    value={ghPagesUrl}
                    className="w-full text-xs font-mono bg-white border border-emerald-300 rounded p-2 text-emerald-900 select-all"
                  />
                  <p className="text-[11px] text-emerald-700 mt-1">
                    * GitHub Pages로 배포된 완전 무료 호스팅 URL입니다.
                  </p>
                </div>
              )}

              {/* Option 3: GitHub Repository Link */}
              {ghRepoUrl && (
                <div className="bg-slate-50 p-3.5 rounded-lg border border-slate-200">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                      <Github className="w-3.5 h-3.5 text-slate-700" />
                      3. GitHub 원본 저장소 링크
                    </span>
                    <a
                      href={ghRepoUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-blue-600 hover:underline flex items-center gap-1"
                    >
                      GitHub에서 열기 <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                  <input
                    type="text"
                    readOnly
                    value={ghRepoUrl}
                    className="w-full text-xs font-mono bg-white border border-slate-300 rounded p-2 text-slate-700 select-all"
                  />
                </div>
              )}

              {/* Option 4: Direct index.html download */}
              <div className="bg-blue-50/70 p-3.5 rounded-lg border border-blue-200">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-bold text-blue-900 flex items-center gap-1.5">
                    <FileCode className="w-3.5 h-3.5 text-blue-700" />
                    4. GitHub 저장소 직접 배포용 단일 HTML (index.html)
                  </span>
                  <button
                    onClick={handleDownloadSingleHtml}
                    className="text-xs text-blue-700 hover:text-blue-900 font-bold flex items-center gap-1 bg-white px-2.5 py-1 rounded border border-blue-300"
                  >
                    <Download className="w-3.5 h-3.5" />
                    index.html 다운로드
                  </button>
                </div>
                <p className="text-[11px] text-blue-800 mt-1">
                  * 다운로드한 <code>index.html</code>을 본인의 GitHub 저장소에 그대로 올리면, GitHub Pages 환경에서 아무런 빌드나 추가 작업 없이 동일하게 즉시 구동됩니다.
                </p>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
              <button
                onClick={() => setShowShareModal(false)}
                className="btn alt text-xs"
              >
                닫기
              </button>
            </div>
          </div>
        </div>
      )}

      {/* GitHub Setup Modal */}
      {showGhSetupModal && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full p-6 border border-slate-200 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <div className="flex items-center gap-2">
                <Github className="w-5 h-5 text-slate-900" />
                <h3 className="text-lg font-bold text-slate-900">GitHub 저장소 연동 설정</h3>
              </div>
              <button
                onClick={() => setShowGhSetupModal(false)}
                className="text-slate-400 hover:text-slate-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3.5 my-4">
              <div className="field" style={{ margin: 0 }}>
                <label>저장소 소유자 (GitHub 사용자명 / 조직명) *</label>
                <input
                  type="text"
                  placeholder="예: dbyte06"
                  value={ghConfig.owner}
                  onChange={e => setGhConfig({ ...ghConfig, owner: e.target.value.trim() })}
                />
              </div>

              <div className="field" style={{ margin: 0 }}>
                <label>저장소 이름 (Repository Name) *</label>
                <input
                  type="text"
                  placeholder="예: chemmarket-reports"
                  value={ghConfig.repo}
                  onChange={e => setGhConfig({ ...ghConfig, repo: e.target.value.trim() })}
                />
              </div>

              <div className="field" style={{ margin: 0 }}>
                <label>브랜치 (기본: main)</label>
                <input
                  type="text"
                  placeholder="main"
                  value={ghConfig.branch || 'main'}
                  onChange={e => setGhConfig({ ...ghConfig, branch: e.target.value.trim() })}
                />
              </div>

              <div className="field" style={{ margin: 0 }}>
                <label className="flex items-center justify-between">
                  <span>GitHub 토큰 (Personal Access Token, PAT)</span>
                  <a
                    href="https://github.com/settings/tokens/new?scopes=repo&description=ChemMarket_Intelligence"
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-600 text-xs hover:underline flex items-center gap-1"
                  >
                    새 토큰 발급 <ExternalLink className="w-3 h-3" />
                  </a>
                </label>
                <input
                  type="password"
                  placeholder="ghp_... 또는 github_pat_... (커밋/업로드 및 비공개 저장소 필수)"
                  value={ghConfig.token || ''}
                  onChange={e => setGhConfig({ ...ghConfig, token: e.target.value.trim() })}
                />
                <p className="text-[11px] text-slate-500 mt-1">
                  * 토큰은 브라우저의 로컬 보안 저장소에만 보관됩니다.
                </p>
              </div>

              {ghTestResult && (
                <div className={`notice ${ghTestResult.success ? '' : 'warning'}`} style={{ margin: 0 }}>
                  <p className="font-semibold text-xs">{ghTestResult.message}</p>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between pt-3 border-t border-slate-200">
              <button
                type="button"
                onClick={handleTestGh}
                disabled={isTestingGh || !ghConfig.owner || !ghConfig.repo}
                className="btn alt text-xs"
              >
                {isTestingGh ? <RefreshCw className="w-3 h-3 animate-spin" /> : null}
                연결 테스트
              </button>

              <div className="flex gap-2">
                <button
                  onClick={() => setShowGhSetupModal(false)}
                  className="btn alt text-xs"
                >
                  취소
                </button>
                <button
                  onClick={async () => {
                    saveGitHubConfig(ghConfig);
                    setShowGhSetupModal(false);
                    showToast('GitHub 설정이 저장되었습니다.');
                    if (ghConfig.owner && ghConfig.repo) {
                      await switchDataSource('github');
                    }
                  }}
                  className="btn text-xs font-bold"
                >
                  설정 저장 및 연동
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* GitHub Pages Guide Modal */}
      {showGhGuideModal && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full p-6 border border-slate-200 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <div className="flex items-center gap-2">
                <BookOpen className="w-5 h-5 text-blue-600" />
                <h3 className="text-lg font-bold text-slate-900">GitHub 연동 및 공유 쉬운 가이드</h3>
              </div>
              <button
                onClick={() => setShowGhGuideModal(false)}
                className="text-slate-400 hover:text-slate-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4 my-4 text-xs text-slate-700 leading-relaxed">
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3.5">
                <h4 className="font-bold text-blue-900 text-sm mb-1">
                  💡 왜 GitHub와 연동하나요?
                </h4>
                <p>
                  브라우저에만 저장되는 로컬 데이터와 달리, <b>GitHub에 보고서를 연동하면</b> 전 세계 어디서든 링크 하나로 동료, 상사, 고객사에게 최신 석유화학 시황 보고서를 실시간으로 공유하고 안전하게 영구 보관할 수 있습니다.
                </p>
              </div>

              <div className="border border-slate-200 rounded-lg p-3.5">
                <h4 className="font-bold text-slate-900 text-sm mb-1.5 flex items-center gap-1.5">
                  <span className="bg-blue-600 text-white w-5 h-5 rounded-full flex items-center justify-center text-[11px]">1</span>
                  GitHub 새 저장소(Repository) 만들기
                </h4>
                <ol className="list-decimal pl-5 space-y-1">
                  <li>
                    <a href="https://github.com/new" target="_blank" rel="noreferrer" className="text-blue-600 underline">
                      github.com/new
                    </a>
                    로 이동합니다.
                  </li>
                  <li>저장소 이름(Repository name)에 <b>chemmarket-reports</b> 를 입력합니다.</li>
                  <li><b>Public (공개)</b>으로 설정합니다. (무료 호스팅 가능)</li>
                  <li><b>[Create repository]</b> 초록색 버튼을 클릭합니다.</li>
                </ol>
              </div>

              <div className="border border-slate-200 rounded-lg p-3.5">
                <h4 className="font-bold text-slate-900 text-sm mb-1.5 flex items-center gap-1.5">
                  <span className="bg-blue-600 text-white w-5 h-5 rounded-full flex items-center justify-center text-[11px]">2</span>
                  원클릭 ZIP 다운로드 및 GitHub에 업로드하기
                </h4>
                <p className="mb-2">
                  관리자 화면 또는 아래 버튼에서 <b>'GitHub Pages 배포 ZIP 다운로드'</b>를 누른 후 압축을 풀어 GitHub 저장소에 올리거나, 관리자 화면의 <b>'로컬 보고서 → GitHub로 전체 커밋'</b> 기능을 사용하세요!
                </p>
                <button
                  onClick={handleDownloadPagesZip}
                  className="btn green text-xs py-1.5"
                >
                  <Download className="w-3.5 h-3.5" /> 배포용 ZIP 파일 즉시 다운로드
                </button>
              </div>

              <div className="border border-slate-200 rounded-lg p-3.5">
                <h4 className="font-bold text-slate-900 text-sm mb-1.5 flex items-center gap-1.5">
                  <span className="bg-blue-600 text-white w-5 h-5 rounded-full flex items-center justify-center text-[11px]">3</span>
                  GitHub Pages 무료 웹사이트 활성화
                </h4>
                <ol className="list-decimal pl-5 space-y-1">
                  <li>GitHub 저장소의 <b>Settings</b> 탭을 클릭합니다.</li>
                  <li>좌측 메뉴의 <b>Pages</b>를 클릭합니다.</li>
                  <li><b>Branch</b>를 <code>main</code>, 폴더를 <code>/ (root)</code>로 선택 후 <b>Save</b>를 누릅니다.</li>
                  <li>잠시 후 <code>https://&lt;내아이디&gt;.github.io/chemmarket-reports/</code> 주소가 생성됩니다!</li>
                </ol>
              </div>

              <div className="border border-slate-200 rounded-lg p-3.5">
                <h4 className="font-bold text-slate-900 text-sm mb-1.5 flex items-center gap-1.5">
                  <span className="bg-blue-600 text-white w-5 h-5 rounded-full flex items-center justify-center text-[11px]">4</span>
                  새 보고서 올릴 때마다 자동 반영
                </h4>
                <p>
                  관리자 화면에서 HTML 파일을 추가할 때 <b>'저장 시 GitHub 저장소에도 자동 커밋 &amp; 발행'</b> 체크박스가 켜져 있으면, 보고서를 등록하는 즉시 GitHub 저장소에도 파일이 커밋되어 공유된 링크에 자동으로 최신 리포트가 반영됩니다.
                </p>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
              <button
                onClick={() => setShowGhGuideModal(false)}
                className="btn text-xs font-bold"
              >
                확인
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Viewer Modal */}
      {activeReport && (
        <div className="viewer" id="viewer">
          <div className="viewerbar">
            <button
              id="closeViewer"
              className="btn alt"
              onClick={handleCloseViewer}
            >
              ← 목록
            </button>
            <strong id="viewerTitle">
              {activeReport.date} | {activeReport.title}
            </strong>
            <button
              className="btn alt"
              style={{ fontSize: '13px' }}
              onClick={() => {
                const directUrl = `${originUrl}?${ghConfig.owner && ghConfig.repo ? `repo=${ghConfig.owner}/${ghConfig.repo}&` : ''}report=${activeReport.id}`;
                copyToClipboard(directUrl, `[${activeReport.date}] 리포트 링크`);
              }}
            >
              <Share2 className="w-3.5 h-3.5" /> 링크 공유
            </button>
            <button
              id="printReport"
              className="btn"
              onClick={handlePrint}
            >
              <Printer className="w-3.5 h-3.5" /> 🖨 인쇄 / PDF 저장
            </button>
            <button
              id="downloadReport"
              className="btn alt"
              onClick={() => handleDownloadReport(activeReport)}
            >
              <Download className="w-3.5 h-3.5" /> HTML 다운로드
            </button>
          </div>
          <iframe
            ref={iframeRef}
            id="reportFrame"
            title="HTML 보고서"
            sandbox="allow-same-origin allow-modals"
            srcDoc={activeReport.html}
          />
        </div>
      )}

      {/* Toast Notification */}
      {toastMessage && (
        <div id="toast" role="status">
          {toastMessage}
        </div>
      )}
    </div>
  );
}
