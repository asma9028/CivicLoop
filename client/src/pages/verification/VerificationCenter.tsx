import { useEffect, useState, type ChangeEvent } from 'react';
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, Clock3, Eye, FileCheck2, Flag, RefreshCw, ShieldCheck, Upload, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { apiRequest, apiUrl } from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import './verification.css';

type Action = {
  id: string;
  actionType: string;
  reason: string | null;
  evidenceUrls: string[];
  createdAt: string;
  actor: { id: string; fullName: string; role: string } | null;
};

type VerificationCase = {
  id: string;
  createdAt: string;
  status: string;
  citizenDecision: string | null;
  responseDeadline: string;
  remainingResponseHours: number;
  ageHours: number;
  escalationAt: string | null;
  reviewDueAt: string | null;
  overdue: boolean;
  assignedReviewer: { id: string; fullName: string } | null;
  incident: {
    id: string;
    title: string;
    description: string;
    category: string;
    severity: string;
    priorityBand: string;
    locationText: string;
    imageUrls: string[];
    imageEvidence: Array<{ url: string; uploadedAt: string | null }>;
    status: string;
    createdAt: string;
    department: { id: string; name: string; code: string } | null;
    assignedAuthority: { id: string; fullName: string } | null;
    activities: Array<{ activityType: string; activityDescription: string; createdAt: string }>;
  };
  resolution: {
    evidenceImageUrls: string[];
    evidenceDescription: string;
    workCompleted: string | null;
    resolutionDate: string | null;
    submittedAt: string;
    evidenceImages: Array<{ url: string; uploadedAt: string | null }>;
  };
  actions: Action[];
  analyses: Array<{
    id: string;
    recommendation: string;
    confidence: number;
    evidenceRelevance: number;
    apparentImprovement: string;
    evidenceQuality: string;
    potentialInconsistencies: string[];
    explanation: string;
    recommendedNextAction: string;
    provider: string;
    createdAt: string;
  }>;
};

type CaseResponse = { verification: VerificationCase };
type ActionDecision = 'CONFIRM' | 'ISSUE_REMAINS' | 'INCOMPLETE' | 'EVIDENCE_MISMATCH' | 'REQUEST_FURTHER_ACTION';

const decisionLabels: Record<ActionDecision, string> = {
  CONFIRM: 'Confirm resolution',
  ISSUE_REMAINS: 'Issue still exists',
  INCOMPLETE: 'Work is incomplete',
  EVIDENCE_MISMATCH: 'Evidence does not match',
  REQUEST_FURTHER_ACTION: 'Request further action',
};

function formatStatus(status: string) {
  return status.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatTime(value: string) {
  return new Date(value).toLocaleString();
}

function timeRemaining(hours: number) {
  if (hours <= 0) return 'Overdue';
  const days = Math.floor(hours / 24);
  return days ? `${days} day${days === 1 ? '' : 's'} remaining` : `${hours} hour${hours === 1 ? '' : 's'} remaining`;
}

async function uploadEvidence(files: FileList | null) {
  if (!files?.length) return [];
  if (files.length > 5) throw new Error('You can upload at most 5 images at a time.');
  const form = new FormData();
  Array.from(files).forEach((file) => form.append('images', file));
  const result = await apiRequest<{ files: string[] }>('/api/uploads', { method: 'POST', body: form });
  return result.files;
}

function EvidenceGallery({ label, urls, emptyLabel, uploadedAt, caption }: { label: string; urls: string[]; emptyLabel: string; uploadedAt?: Array<string | null>; caption?: string | null }) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const move = (offset: number) => setActiveIndex((index) =>
    index === null || !urls.length ? null : (index + offset + urls.length) % urls.length,
  );
  useEffect(() => {
    if (activeIndex === null) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setActiveIndex(null);
      if (event.key === 'ArrowLeft') setActiveIndex((index) =>
        index === null || !urls.length ? null : (index - 1 + urls.length) % urls.length,
      );
      if (event.key === 'ArrowRight') setActiveIndex((index) =>
        index === null || !urls.length ? null : (index + 1) % urls.length,
      );
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [activeIndex, urls.length]);

  return <section className="verification-evidence">
    <h3>{label}</h3>
    {caption&&<p className="verification-evidence-caption">{caption}</p>}
    {urls.length ? <div className="verification-image-grid">
      {urls.map((url, index) => {
        const timestamp = uploadedAt?.[index];
        return <button key={`${url}-${index}`} type="button" onClick={() => setActiveIndex(index)} aria-label={`Enlarge ${label.toLowerCase()} image ${index + 1}`}>
          <img src={apiUrl(url)} alt={`${label} evidence ${index + 1}`} loading="lazy"/>
          <span><Eye size={16}/> View image {index + 1}{timestamp ? ` · ${formatTime(timestamp)}` : ''}</span>
        </button>;
      })}
    </div> : <p className="verification-muted">{emptyLabel}</p>}
    {activeIndex !== null && <div className="verification-lightbox" role="dialog" aria-modal="true" aria-label={`${label} image viewer`} onClick={close}>
      <button className="verification-lightbox-close" type="button" onClick={close} aria-label="Close image viewer"><X/></button>
      {urls.length > 1 && <button className="verification-lightbox-prev" type="button" onClick={(event) => { event.stopPropagation(); move(-1); }} aria-label="Previous image"><ArrowLeft/></button>}
      <img src={apiUrl(urls[activeIndex])} alt={`${label} evidence ${activeIndex + 1}`} onClick={(event) => event.stopPropagation()}/>
      {urls.length > 1 && <button className="verification-lightbox-next" type="button" onClick={(event) => { event.stopPropagation(); move(1); }} aria-label="Next image"><ArrowRight/></button>}
      <span>{label} · {activeIndex + 1} of {urls.length}</span>
    </div>}
  </section>;
}

function VerificationTimeline({ record }: { record: VerificationCase }) {
  const entries = [
    ...record.incident.activities.map((item, index) => ({
      id: `activity-${index}-${item.createdAt}`,
      label: item.activityType,
      description: item.activityDescription,
      createdAt: item.createdAt,
    })),
    ...record.actions.map((item) => ({
      id: item.id,
      label: item.actionType,
      description: item.reason || formatStatus(item.actionType),
      createdAt: item.createdAt,
    })),
  ].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  return <div className="verification-timeline">
    {entries.map((entry) => <div key={entry.id}><span/><section><strong>{formatStatus(entry.label)}</strong><small>{formatTime(entry.createdAt)}</small><p>{entry.description}</p></section></div>)}
  </div>;
}

function CitizenCaseCard({ record, onChanged }: { record: VerificationCase; onChanged: () => void }) {
  const [decision, setDecision] = useState<ActionDecision>('CONFIRM');
  const [reason, setReason] = useState('');
  const [evidenceUrls, setEvidenceUrls] = useState<string[]>([]);
  const [additionalEvidenceUrls, setAdditionalEvidenceUrls] = useState<string[]>([]);
  const [additionalDescription, setAdditionalDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [additionalBusy, setAdditionalBusy] = useState(false);
  const [additionalUploading, setAdditionalUploading] = useState(false);
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [analysisConsentAccepted, setAnalysisConsentAccepted] = useState(false);
  const [analysis, setAnalysis] = useState<VerificationCase['analyses'][number] | null>(record.analyses[0] ?? null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const canRespond = ['PENDING', 'REVIEW_REQUIRED'].includes(record.status) && !record.citizenDecision;
  const disagreement = decision !== 'CONFIRM';

  const onEvidenceChange = async (event: ChangeEvent<HTMLInputElement>) => {
    setError('');
    if ((event.target.files?.length ?? 0) > 5 - evidenceUrls.length) {
      setError(`You can attach ${5 - evidenceUrls.length} more image${5 - evidenceUrls.length === 1 ? '' : 's'} to this response.`);
      event.target.value = '';
      return;
    }
    setUploading(true);
    try {
      const uploaded = await uploadEvidence(event.target.files);
      setEvidenceUrls((current) => [...current, ...uploaded].slice(0, 5));
      event.target.value = '';
    } catch (reasonValue) {
      setError(reasonValue instanceof Error ? reasonValue.message : 'Evidence upload failed');
    } finally {
      setUploading(false);
    }
  };

  const onAdditionalEvidenceChange = async (event: ChangeEvent<HTMLInputElement>) => {
    setError('');
    setAdditionalUploading(true);
    try {
      const uploaded = await uploadEvidence(event.target.files);
      setAdditionalEvidenceUrls((current) => [...current, ...uploaded]);
      event.target.value = '';
    } catch (reasonValue) {
      setError(reasonValue instanceof Error ? reasonValue.message : 'Evidence upload failed');
    } finally {
      setAdditionalUploading(false);
    }
  };

  const submitAdditionalEvidence = async () => {
    if (additionalDescription.trim().length < 3 || !additionalEvidenceUrls.length) {
      setError('Add a short description and at least one supporting image.');
      return;
    }
    setAdditionalBusy(true);
    setError('');
    try {
      await apiRequest(`/api/verification/cases/${record.id}/evidence`, {
        method: 'POST',
        body: JSON.stringify({ description: additionalDescription.trim(), evidenceUrls: additionalEvidenceUrls }),
      });
      setAdditionalDescription('');
      setAdditionalEvidenceUrls([]);
      setNotice('Additional evidence was added to the independent review.');
      onChanged();
    } catch (reasonValue) {
      setError(reasonValue instanceof Error ? reasonValue.message : 'Unable to save additional evidence');
    } finally {
      setAdditionalBusy(false);
    }
  };

  const submitResponse = async () => {
    setError('');
    setNotice('');
    if (decision === 'CONFIRM' && !window.confirm('Confirm that the reported issue has been satisfactorily addressed?')) return;
    if (disagreement && reason.trim().length < 10) {
      setError('Please explain the concern in at least 10 characters.');
      return;
    }
    setBusy(true);
    try {
      await apiRequest<CaseResponse>(`/api/verification/cases/${record.id}/respond`, {
        method: 'POST',
        body: JSON.stringify({ decision, reason: reason.trim() || undefined, evidenceUrls }),
      });
      setNotice(decision === 'CONFIRM' ? 'Your confirmation is recorded.' : 'Your concern was recorded for independent review.');
      onChanged();
    } catch (reasonValue) {
      setError(reasonValue instanceof Error ? reasonValue.message : 'Unable to save your verification response');
    } finally {
      setBusy(false);
    }
  };

  const runAnalysis = async () => {
    if (!analysisConsentAccepted) {
      setError('Accept the optional AI disclosure before requesting analysis.');
      return;
    }
    setAnalysisBusy(true);
    setError('');
    try {
      const consent = await apiRequest<{ consentToken: string }>(`/api/verification/cases/${record.id}/analysis-consent`, {
        method: 'POST',
        body: JSON.stringify({ accepted: true }),
      });
      const result = await apiRequest<{ analysis: VerificationCase['analyses'][number] }>(`/api/verification/cases/${record.id}/analyze`, {
        method: 'POST',
        body: JSON.stringify({ aiConsentToken: consent.consentToken }),
      });
      setAnalysis(result.analysis);
    } catch (reasonValue) {
      setError(reasonValue instanceof Error ? reasonValue.message : 'AI analysis is unavailable');
    } finally {
      setAnalysisBusy(false);
    }
  };

  return <article className="verification-case-card">
    <div className="verification-case-heading">
      <div><span className="verification-eyebrow">{record.incident.category.replaceAll('_', ' ')} · {record.incident.id}</span><h2>{record.incident.title}</h2><p>{record.incident.locationText}</p></div>
      <span className={`verification-status ${record.status.toLowerCase()}`}>{formatStatus(record.status)}</span>
    </div>
    <div className="verification-facts">
      <div><small>Department</small><strong>{record.incident.department?.name || 'Not assigned'}</strong></div>
      <div><small>Assigned authority</small><strong>{record.incident.assignedAuthority?.fullName || 'Not assigned'}</strong></div>
      <div><small>Resolution submitted</small><strong>{formatTime(record.resolution.submittedAt)}</strong></div>
      <div><small>Response deadline</small><strong>{formatTime(record.responseDeadline)} · {timeRemaining(record.remainingResponseHours)}</strong></div>
    </div>
    {record.overdue && <div className="verification-alert"><Clock3 size={18}/>This verification is overdue. Silence does not count as approval; independent review remains available.</div>}
    <div className="verification-description-grid">
      <section><h3>Original report</h3><p>{record.incident.description}</p></section>
      <section><h3>Authority resolution</h3><p>{record.resolution.evidenceDescription}</p><small>{record.resolution.workCompleted || 'Work completed details not provided'}</small></section>
    </div>
    <p className="verification-comparison-note"><ShieldCheck size={16}/>The images are shown for review; they are not assumed to be the same location or viewpoint.</p>
    <div className="verification-comparison">
      <EvidenceGallery label="Before · original report" urls={record.incident.imageEvidence.map((item)=>item.url)} uploadedAt={record.incident.imageEvidence.map((item)=>item.uploadedAt)} emptyLabel="No original report photographs were provided."/>
      <EvidenceGallery label="After · resolution evidence" urls={record.resolution.evidenceImages.map((item)=>item.url)} uploadedAt={record.resolution.evidenceImages.map((item)=>item.uploadedAt)} caption={record.resolution.evidenceDescription} emptyLabel="No resolution photographs were submitted; visual comparison is unavailable."/>
    </div>
    {record.actions.filter((action)=>action.actionType==='CITIZEN_DISPUTED'||action.actionType==='CITIZEN_EVIDENCE_SUBMITTED').filter((action)=>action.evidenceUrls.length>0).map((action)=> <EvidenceGallery key={action.id} label="Citizen-submitted evidence" urls={action.evidenceUrls} uploadedAt={action.evidenceUrls.map(()=>action.createdAt)} caption={action.reason} emptyLabel="No additional citizen evidence was submitted."/>)}
    {analysis && <section className="verification-ai">
      <div><span>AI assistance · {formatStatus(analysis.recommendation)} · {analysis.confidence}% confidence</span><p>{analysis.explanation}</p><small>Evidence relevance {analysis.evidenceRelevance}% · {formatStatus(analysis.apparentImprovement)} · {formatStatus(analysis.evidenceQuality)} quality · {analysis.provider === 'unavailable' ? 'AI unavailable' : `Analyzed ${formatTime(analysis.createdAt)}`}</small>
        {!!analysis.potentialInconsistencies.length && <ul>{analysis.potentialInconsistencies.map((item) => <li key={item}>{item}</li>)}</ul>}
      </div>
      <strong>AI does not decide the outcome.</strong>
    </section>}
    {canRespond && <>
      <div className="verification-decision">
        <h3>Your review</h3>
        <p>Compare the original issue with the submitted work. Your response is recorded with the incident history.</p>
        <div className="verification-decision-options">
          {(Object.keys(decisionLabels) as ActionDecision[]).map((value) => <button type="button" key={value} className={decision === value ? 'selected' : ''} onClick={() => setDecision(value)}>{value === 'CONFIRM' ? <CheckCircle2 size={17}/> : <Flag size={17}/>}<span>{decisionLabels[value]}</span></button>)}
        </div>
        {disagreement && <label className="verification-field">Explain what remains unresolved or needs review<textarea value={reason} onChange={(event) => setReason(event.target.value)} minLength={10} maxLength={2000} required placeholder="Describe what is still wrong, incomplete, or inconsistent."/></label>}
        {disagreement && <label className="verification-upload"><Upload size={18}/><span>{uploading ? 'Uploading evidence…' : 'Add supporting images (optional, up to 5)'}</span><input type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={uploading || evidenceUrls.length >= 5} onChange={onEvidenceChange}/></label>}
        {!!evidenceUrls.length && <div className="verification-upload-list">{evidenceUrls.map((url) => <span key={url}>{url.split('/').pop()}<button type="button" onClick={() => setEvidenceUrls((items) => items.filter((item) => item !== url))} aria-label={`Remove ${url}`}>×</button></span>)}</div>}
        <div className="verification-actions"><button type="button" className="button outline" onClick={runAnalysis} disabled={analysisBusy || !analysisConsentAccepted}>{analysisBusy ? 'Analyzing…' : 'Request AI evidence analysis'}</button><button type="button" className="button primary" onClick={submitResponse} disabled={busy || uploading}>{busy ? 'Saving…' : decisionLabels[decision]}</button></div>
        <p className="verification-disclosure">This optional analysis sends redacted report and resolution text, relevant public incident history, and up to three unmodified images from each evidence set to Google Gemini. The report's exact location field is omitted, but images may contain embedded location metadata. The result is advisory; people decide the outcome. You may continue without AI analysis.</p>
        <label className="verification-ai-consent"><input type="checkbox" checked={analysisConsentAccepted} onChange={(event) => setAnalysisConsentAccepted(event.target.checked)} /><span>I agree to send the described evidence to Google Gemini for this analysis.</span></label>
      </div>
    </>}
    {record.citizenDecision && <div className="verification-recorded"><CheckCircle2 size={18}/><span>Your response: <strong>{formatStatus(record.citizenDecision)}</strong>{record.status === 'DISPUTED' && ' · independent review is pending'}</span></div>}
    {record.citizenDecision && ['DISPUTED', 'REVIEW_REQUIRED'].includes(record.status) && <section className="verification-additional-evidence">
      <h3>{record.actions.some((action)=>action.actionType==='REVIEW_REQUESTED_EVIDENCE')?'Additional evidence requested':'Add information to the review'}</h3>
      <label className="verification-field">Evidence description<textarea value={additionalDescription} onChange={(event)=>setAdditionalDescription(event.target.value)} maxLength={2000} placeholder="Explain what this evidence shows."/></label>
      <label className="verification-upload"><Upload size={18}/><span>{additionalUploading?'Uploading evidence…':'Add supporting images (up to 5 per submission)'}</span><input type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={additionalUploading} onChange={onAdditionalEvidenceChange}/></label>
      {!!additionalEvidenceUrls.length&&<div className="verification-upload-list">{additionalEvidenceUrls.map((url)=><span key={url}>{url.split('/').pop()}<button type="button" onClick={()=>setAdditionalEvidenceUrls((items)=>items.filter((item)=>item!==url))} aria-label={`Remove ${url}`}>×</button></span>)}</div>}
      <button type="button" className="button outline" onClick={submitAdditionalEvidence} disabled={additionalBusy||additionalUploading}>{additionalBusy?'Saving…':'Submit additional evidence'}</button>
    </section>}
    {error && <div className="verification-error" role="alert"><AlertTriangle size={17}/>{error}</div>}
    {notice && <div className="verification-success" role="status">{notice}</div>}
    <details className="verification-history"><summary>Verification history ({record.actions.length + record.incident.activities.length})</summary><VerificationTimeline record={record}/></details>
  </article>;
}

export function VerificationCenter() {
  const [cases, setCases] = useState<VerificationCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    void apiRequest('/api/verification/process-deadlines', { method: 'POST' })
      .then(() => apiRequest<{ cases: VerificationCase[] }>('/api/verification/me'))
      .then((result) => { if (active) setCases(result.cases); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : 'Unable to load verifications'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [refresh]);

  return <div className="page-shell verification-page">
    <div className="page-header"><div><span>Citizen verification center</span><h1>Review resolution evidence</h1><p>Confirm completed work or ask for an independent review when the issue remains.</p></div><Link className="button outline" to="/citizen/my-reports">My reports</Link></div>
    {loading ? <div className="empty-state">Loading verification requests…</div>
      : error ? <div className="verification-error" role="alert"><AlertTriangle/>{error}<button type="button" className="button outline" onClick={() => setRefresh((value) => value + 1)}>Try again</button></div>
        : cases.length === 0 ? <div className="empty-state"><FileCheck2/><h3>No verification requests</h3><p>When an authority submits resolution evidence for your report, you can review it here.</p><Link className="button primary" to="/citizen/my-reports">View my reports</Link></div>
          : cases.map((record) => <CitizenCaseCard key={record.id} record={record} onChanged={() => setRefresh((value) => value + 1)}/>)}
  </div>;
}

export function ReviewerWorkspace() {
  const { user } = useAuth();
  const [cases, setCases] = useState<VerificationCase[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [reason, setReason] = useState('');
  const [decision, setDecision] = useState<'CONFIRM' | 'REOPEN' | 'REQUEST_EVIDENCE'>('REOPEN');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const selected = cases.find((record) => record.id === selectedId) ?? null;

  const loadQueue = async () => {
    setError('');
    try {
      await apiRequest('/api/verification/process-deadlines', { method: 'POST' });
      const result = await apiRequest<{ cases: VerificationCase[] }>('/api/verification/review-queue?limit=50');
      setCases(result.cases);
      setSelectedId((current) => result.cases.some((record) => record.id === current) ? current : result.cases[0]?.id || '');
    } catch (reasonValue) {
      setError(reasonValue instanceof Error ? reasonValue.message : 'Unable to load the review queue');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    let active = true;
    void apiRequest('/api/verification/process-deadlines', { method: 'POST' })
      .then(() => apiRequest<{ cases: VerificationCase[] }>('/api/verification/review-queue?limit=50'))
      .then((result) => {
        if (!active) return;
        setCases(result.cases);
        setSelectedId(result.cases[0]?.id || '');
      })
      .catch((reasonValue: unknown) => {
        if (active) setError(reasonValue instanceof Error ? reasonValue.message : 'Unable to load the review queue');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const assignToMe = async () => {
    if (!selected || !user) return;
    setBusy(true);
    setError('');
    try {
      await apiRequest(`/api/verification/cases/${selected.id}/reviewer`, {
        method: 'PATCH',
        body: JSON.stringify({ reviewerId: user.id }),
      });
      await loadQueue();
    } catch (reasonValue) {
      setError(reasonValue instanceof Error ? reasonValue.message : 'Unable to assign this case');
    } finally {
      setBusy(false);
    }
  };

  const submitReview = async () => {
    if (!selected || reason.trim().length < 10) {
      setError('A meaningful review reason of at least 10 characters is required.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await apiRequest(`/api/verification/cases/${selected.id}/decision`, {
        method: 'POST',
        body: JSON.stringify({ decision, reason: reason.trim() }),
      });
      setReason('');
      await loadQueue();
    } catch (reasonValue) {
      setError(reasonValue instanceof Error ? reasonValue.message : 'Unable to record the review decision');
    } finally {
      setBusy(false);
    }
  };

  return <div className="page-shell verification-page">
    <div className="page-header"><div><span>Independent review</span><h1>Dispute review workspace</h1><p>Assess disputed or overdue verifications. Your decision and reason are retained in the audit history.</p></div><button className="button outline" type="button" onClick={() => void loadQueue()}><RefreshCw size={16}/> Refresh</button></div>
    {error && <div className="verification-error" role="alert"><AlertTriangle size={17}/>{error}</div>}
    {loading ? <div className="empty-state">Loading review queue…</div> : <div className="review-workspace">
      <aside className="review-queue"><h2>Needs review <span>{cases.length}</span></h2>
        {cases.length === 0 ? <p className="verification-muted">No disputes or overdue cases currently require review.</p> : cases.map((record) => <button type="button" key={record.id} className={record.id === selectedId ? 'active' : ''} onClick={() => setSelectedId(record.id)}>
          <strong>{record.incident.title}</strong><small>{record.incident.department?.name || 'No department'} · {record.incident.priorityBand} · {formatStatus(record.status)}</small><small>{record.overdue ? 'Overdue' : `Open for ${record.ageHours} hours`}</small>
        </button>)}
      </aside>
      {selected ? <article className="review-detail">
        <div className="verification-case-heading"><div><span className="verification-eyebrow">{selected.incident.category.replaceAll('_', ' ')} · {selected.incident.id}</span><h2>{selected.incident.title}</h2><p>{selected.incident.description}</p></div><span className={`verification-status ${selected.status.toLowerCase()}`}>{formatStatus(selected.status)}</span></div>
        <p><strong>Department:</strong> {selected.incident.department?.name || 'Not assigned'} · <strong>Priority:</strong> {selected.incident.priorityBand} · <strong>Resolution submitted:</strong> {formatTime(selected.resolution.submittedAt)}</p>
        <p><strong>Citizen concern:</strong> {selected.actions.find((action) => action.actionType === 'CITIZEN_DISPUTED')?.reason || 'No citizen response; verification deadline elapsed.'}</p>
        <div className="verification-description-grid"><section><h3>Resolution</h3><p>{selected.resolution.evidenceDescription}</p><p>{selected.resolution.workCompleted}</p></section><section><h3>Original report</h3><p>{selected.incident.description}</p></section></div>
        <div className="verification-comparison">
          <EvidenceGallery label="Original report evidence" urls={selected.incident.imageEvidence.map((item)=>item.url)} uploadedAt={selected.incident.imageEvidence.map((item)=>item.uploadedAt)} emptyLabel="No original report photographs."/>
          <EvidenceGallery label="Resolution evidence" urls={selected.resolution.evidenceImages.map((item)=>item.url)} uploadedAt={selected.resolution.evidenceImages.map((item)=>item.uploadedAt)} caption={selected.resolution.evidenceDescription} emptyLabel="No resolution photographs."/>
        </div>
        {selected.actions.filter((action)=>action.actionType==='CITIZEN_DISPUTED'||action.actionType==='CITIZEN_EVIDENCE_SUBMITTED').filter((action)=>action.evidenceUrls.length>0).map((action)=> <EvidenceGallery key={action.id} label="Citizen-submitted evidence" urls={action.evidenceUrls} uploadedAt={action.evidenceUrls.map(()=>action.createdAt)} caption={action.reason} emptyLabel="No additional citizen evidence was submitted."/>)}
        {selected.analyses[0] && <section className="verification-ai"><div><span>AI assistance · {formatStatus(selected.analyses[0].recommendation)}</span><p>{selected.analyses[0].explanation}</p><small>{selected.analyses[0].confidence}% confidence · {formatStatus(selected.analyses[0].evidenceQuality)} evidence quality</small></div><strong>Advisory only</strong></section>}
        <div className="review-assignment"><span>Reviewer: {selected.assignedReviewer?.fullName || 'Unassigned'}</span><button type="button" className="button outline" onClick={assignToMe} disabled={busy || selected.assignedReviewer?.id === user?.id}>Assign to me</button></div>
        <label className="verification-field">Review outcome<select value={decision} onChange={(event) => setDecision(event.target.value as typeof decision)}><option value="REOPEN">Reopen incident for additional work</option><option value="CONFIRM">Confirm resolution</option><option value="REQUEST_EVIDENCE">Request additional evidence</option></select></label>
        <label className="verification-field">Reason<textarea value={reason} onChange={(event) => setReason(event.target.value)} minLength={10} maxLength={2000} placeholder="Explain the evidence supporting this decision."/></label>
        <button type="button" className="button primary" onClick={submitReview} disabled={busy || (selected.assignedReviewer !== null && selected.assignedReviewer.id !== user?.id)}>{busy ? 'Saving review…' : 'Record review decision'}</button>
        <details className="verification-history"><summary>Complete audit timeline</summary><VerificationTimeline record={selected}/></details>
      </article> : <div className="empty-state"><Flag/><h3>Select a case to review</h3></div>}
    </div>}
  </div>;
}

export function DepartmentTrustCard({ departmentId }: { departmentId: string }) {
  const [data, setData] = useState<{
    trustIndicator: { label: string; value?: number; unit?: string; sampleSize: number; minimumSampleSize?: number; basis?: string };
    metrics: { requiringVerification: number; verifiedResolutions: number; disputedResolutions: number; reopenedIncidents: number; pendingVerification: number; overdueVerification: number };
  } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void apiRequest<typeof data extends infer T ? NonNullable<T> : never>(`/api/verification/public/departments/${departmentId}/metrics`)
      .then((result) => { if (active) setData(result); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : 'Metrics unavailable'); });
    return () => { active = false; };
  }, [departmentId]);
  return <div className="aside-card department-trust-card"><h3>Verification accountability</h3>
    {error ? <p className="verification-muted">{error}</p> : !data ? <p className="verification-muted">Loading public metrics…</p> : <>
      <strong className="trust-indicator">{data.trustIndicator.label}{data.trustIndicator.value !== undefined ? ` · ${data.trustIndicator.value}%` : ''}</strong>
      <small>{data.trustIndicator.sampleSize} final decisions in this public dataset. Open cases and citizen silence are excluded.</small>
      <div className="trust-metrics"><span>Verified <b>{data.metrics.verifiedResolutions}</b></span><span>Disputed <b>{data.metrics.disputedResolutions}</b></span><span>Reopened <b>{data.metrics.reopenedIncidents}</b></span><span>Pending <b>{data.metrics.pendingVerification}</b></span></div>
    </>}
  </div>;
}
