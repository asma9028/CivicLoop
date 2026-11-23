import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, NavLink, useParams } from 'react-router-dom';
import { Activity, ArrowLeft, Bell, CheckCircle2, Heart, MapPin, Megaphone, ShieldCheck, type LucideIcon } from 'lucide-react';
import { apiRequest, apiUrl } from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import './community.css';

type CommunityMode = 'feed' | 'incident' | 'campaigns' | 'campaign' | 'impact';
type PortalMode = 'dashboard' | 'areas' | 'participation' | 'notifications' | 'manage';
type CommunityIncident = {
  id: string;
  title: string;
  category: string;
  status: string;
  location: { label: string; latitude: number; longitude: number };
  supportCount: number;
  isSupported: boolean;
  progressPercent: number;
  verificationStatus: string;
  latestPublicUpdate: { message: string; createdAt: string } | null;
  signal?: { score: number; level: string };
  overview?: string;
  signalMethod?: { note: string };
  timeline?: Array<{ id: string; type: string; message: string; createdAt: string }>;
  verification?: { status: string; verifiedAt?: string; evidenceImageUrls?: string[] };
};
type Campaign = {
  id: string;
  name: string;
  description: string;
  objective: string;
  campaignType: string;
  startAt: string;
  endAt: string;
  targetAreaLabel: string;
  status: string;
  participants: number;
  linkedPublicReports: number;
  verifiedLinkedReports?: number;
  linkedReportVerificationPercent?: number | null;
  isJoined: boolean;
  linkedIncidents?: CommunityIncident[];
};
type ImpactRecord = {
  incidentId: string;
  category: string;
  location: { label: string; latitude: number; longitude: number };
  reportedAt: string;
  resolvedAt: string | null;
  verifiedAt: string | null;
  department: string;
  resolutionSummary: string;
  verificationOutcome: string;
  publicEvidence: string[];
};
type FollowedArea = {
  id: string;
  name: string;
  centerLatitude: number;
  centerLongitude: number;
  radiusMeters: number;
  followedAt: string;
};
type NotificationItem = {
  id: string;
  title: string;
  message: string;
  entityType: string;
  entityId: string;
  readAt: string | null;
  createdAt: string;
};

const categories = ['ROAD', 'WASTE', 'WATER', 'DRAINAGE', 'ELECTRICITY', 'PUBLIC_SPACE', 'OTHER'];
const label = (value: string) => value.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
const dateLabel = (value?: string | null) => value ? new Date(value).toLocaleDateString() : 'Not available';
const campaignJoinable = (campaign: Campaign) => campaign.status === 'ACTIVE'
  && Date.now() >= new Date(campaign.startAt).getTime()
  && Date.now() <= new Date(campaign.endAt).getTime();

function CommunityPublicLayout({ children }: { children: ReactNode }) {
  return <div className="community-app">
    <header className="community-public-nav">
      <Link to="/" className="community-brand"><ShieldCheck size={20}/> Civic<span>Loop</span></Link>
      <nav><NavLink to="/community">Community</NavLink><NavLink to="/campaigns">Campaigns</NavLink><NavLink to="/impact">Impact</NavLink></nav>
      <Link to="/login" className="button outline">Sign in</Link>
    </header>
    <main className="community-shell">{children}</main>
  </div>;
}

function CommunityHeading({ eyebrow, title, description, back }: { eyebrow: string; title: string; description: string; back?: string }) {
  return <header className="community-heading">
    {back && <Link to={back} className="community-back"><ArrowLeft size={15}/> Back</Link>}
    <span>{eyebrow}</span><h1>{title}</h1><p>{description}</p>
  </header>;
}

function Message({ error, info }: { error: string; info?: string }) {
  if (!error && !info) return null;
  return <div className={error ? 'community-message error' : 'community-message'} role="status">{error || info}</div>;
}

function useLoad<T>(path: string, refreshNotifications = false) {
  const [result, setResult] = useState<{ key: string; data: T | null; error: string; loading: boolean }>({
    key: '',
    data: null,
    error: '',
    loading: true,
  });
  const [version, setVersion] = useState(0);
  const key = `${path}:${version}`;
  const reload = () => setVersion((value) => value + 1);
  const setError = useCallback((error: string) => setResult((current) => ({ ...current, error })), []);
  useEffect(() => {
    let active = true;
    const load = async () => {
      if (refreshNotifications) {
        await apiRequest('/api/community/notifications/materialize', { method: 'POST' });
      }
      return apiRequest<T>(path);
    };
    void load()
      .then((data) => { if (active) setResult({ key, data, error: '', loading: false }); })
      .catch((reason: unknown) => {
        if (active) setResult({ key, data: null, error: reason instanceof Error ? reason.message : 'Unable to load this page', loading: false });
      });
    return () => { active = false; };
  }, [key, path, refreshNotifications]);
  return {
    data: result.key === key ? result.data : null,
    error: result.key === key ? result.error : '',
    loading: result.key !== key || result.loading,
    reload,
    setError,
  };
}

export function CommunityPublicPage({ mode }: { mode: CommunityMode }) {
  if (mode === 'feed') return <CommunityFeed/>;
  if (mode === 'incident') return <CommunityIncidentPage/>;
  if (mode === 'campaigns') return <CampaignList/>;
  if (mode === 'campaign') return <CampaignDetail/>;
  return <ImpactLedger/>;
}

function CommunityFeed() {
  const [sort, setSort] = useState('recent');
  const [page, setPage] = useState(1);
  const path = `/api/community/incidents?page=${page}&limit=20&sort=${sort}`;
  const { data, error, loading, reload } = useLoad<{ incidents: CommunityIncident[]; pagination: { pages: number } }>(path);
  const { user } = useAuth();
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');
  const incidents = data?.incidents ?? [];
  const toggleSupport = async (incident: CommunityIncident) => {
    if (!user) return;
    setBusy(incident.id);
    setActionError('');
    try {
      await apiRequest(`/api/community/incidents/${incident.id}/support`, { method: incident.isSupported ? 'DELETE' : 'PUT' });
      reload();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : 'Unable to update support');
    } finally {
      setBusy('');
    }
  };
  return <CommunityPublicLayout><CommunityHeading eyebrow="Community signal" title="Issues in the community" description="Follow public reports, see community support, and track progress. Support is not an authority priority vote."/>
    <div className="community-toolbar"><span>{data?.pagination ? `${incidents.length} reports · page ${page} of ${data.pagination.pages || 1}` : 'Public incident feed'}</span><select value={sort} onChange={(event) => { setSort(event.target.value); setPage(1); }} aria-label="Sort community reports"><option value="recent">Most recent</option><option value="supported">Most supported</option><option value="priority">Priority</option></select></div>
    <Message error={error || actionError}/>{loading ? <div className="community-empty">Loading community reports…</div> : incidents.length === 0 ? <div className="community-empty">No public community reports are available yet.</div> :
      <div className="community-grid">{incidents.map((incident) => <article className="community-card" key={incident.id}>
        <Link to={`/community/incidents/${incident.id}`} className="community-card-main">
          <div className="community-card-top"><span className="community-category">{label(incident.category)}</span>{incident.signal && <span className={`signal signal-${incident.signal.level.toLowerCase()}`}>{label(incident.signal.level)} signal</span>}</div>
          <h2>{incident.title}</h2><p>{incident.overview || 'Public civic issue reported by the community.'}</p>
          <div className="community-meta"><span><MapPin size={14}/>{incident.location.label}</span><span>{label(incident.status)}</span></div>
          <div className="community-progress"><i style={{ width: `${incident.progressPercent}%` }}/></div>
          <small>{incident.progressPercent}% progress · {label(incident.verificationStatus)}</small>
        </Link>
        <div className="community-card-footer"><span><Heart size={15}/>{incident.supportCount} support</span>
          {user?.role === 'CITIZEN' && <button className={`community-action ${incident.isSupported ? 'selected' : ''}`} disabled={busy === incident.id} onClick={() => void toggleSupport(incident)}>{incident.isSupported ? 'Supported' : 'Support'}</button>}
        </div>
      </article>)}</div>}
    {data?.pagination && data.pagination.pages > 1 && <div className="community-pagination"><button className="button outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button><button className="button outline" disabled={page >= data.pagination.pages} onClick={() => setPage(page + 1)}>Next</button></div>}
  </CommunityPublicLayout>;
}

function CommunityIncidentPage() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const { data, error, loading, reload } = useLoad<{ incident: CommunityIncident }>(`/api/community/incidents/${id}`);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const incident = data?.incident;
  const toggleSupport = async () => {
    if (!incident) return;
    setBusy(true);
    setActionError('');
    try {
      await apiRequest(`/api/community/incidents/${incident.id}/support`, { method: incident.isSupported ? 'DELETE' : 'PUT' });
      reload();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : 'Unable to update support');
    } finally {
      setBusy(false);
    }
  };
  return <CommunityPublicLayout><CommunityHeading eyebrow="Community report" title={incident?.title ?? 'Community issue'} description={incident?.overview ?? 'Public issue activity, support, and independently verified outcome.'} back="/community"/>
    <Message error={error || actionError}/>
    {loading ? <div className="community-empty">Loading issue details…</div> : !incident ? <div className="community-empty">This public issue is unavailable.</div> :
      <div className="community-detail-grid"><article className="community-panel">
        <div className="community-detail-stats"><div><small>Community support</small><strong>{incident.supportCount}</strong></div><div><small>Collective signal</small><strong>{incident.signal?.score ?? 0}/100</strong></div><div><small>Status</small><strong>{label(incident.status)}</strong></div></div>
        <h2>Progress</h2><div className="community-progress large"><i style={{ width: `${incident.progressPercent}%` }}/></div><p>{incident.progressPercent}% status progress. The collective signal is separate from the authority's incident priority.</p>
        {incident.signalMethod && <p className="community-note">{incident.signalMethod.note}</p>}
        {incident.verification?.status === 'VERIFIED' && <div className="community-verified"><CheckCircle2/><span><strong>Independently verified</strong><small>Verified {dateLabel(incident.verification.verifiedAt)}</small></span></div>}
        {incident.verification?.evidenceImageUrls?.length ? <div className="community-evidence">{incident.verification.evidenceImageUrls.map((url) => <a key={url} href={apiUrl(url)} target="_blank" rel="noreferrer">Public resolution evidence</a>)}</div> : null}
        <h2>Public updates</h2>{incident.timeline?.length ? <div className="community-timeline">{incident.timeline.map((item) => <div key={item.id}><Activity/><span><strong>{label(item.type)}</strong><small>{dateLabel(item.createdAt)} · {item.message}</small></span></div>)}</div> : <p>No public activity updates yet.</p>}
      </article><aside className="community-panel community-aside"><span className="community-category">{label(incident.category)}</span><h2>{incident.location.label}</h2><p>Approximate coordinates: {incident.location.latitude.toFixed(2)}, {incident.location.longitude.toFixed(2)}</p>
        <div className="community-status"><span>Progress</span><strong>{incident.progressPercent}%</strong></div><div className="community-status"><span>Verification</span><strong>{label(incident.verificationStatus)}</strong></div>
        {user?.role === 'CITIZEN' && <button className={`button ${incident.isSupported ? 'outline' : 'primary'} full`} disabled={busy} onClick={() => void toggleSupport()}><Heart size={16}/>{busy ? 'Saving…' : incident.isSupported ? 'Remove support' : 'Support this issue'}</button>}
        {!user && <Link className="button primary full" to="/login">Sign in to support</Link>}
      </aside></div>}
  </CommunityPublicLayout>;
}

function CampaignList() {
  const [search, setSearch] = useState('');
  const path = `/api/community/campaigns?limit=30${search.trim() ? `&search=${encodeURIComponent(search.trim())}` : ''}`;
  const { data, error, loading, reload } = useLoad<{ campaigns: Campaign[] }>(path);
  const { user } = useAuth();
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');
  const changeParticipation = async (campaign: Campaign) => {
    if (!user) return;
    setBusy(campaign.id);
    setActionError('');
    try {
      await apiRequest(`/api/community/campaigns/${campaign.id}/join`, { method: campaign.isJoined ? 'DELETE' : 'POST' });
      reload();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : 'Unable to update campaign participation');
    } finally {
      setBusy('');
    }
  };
  return <CommunityPublicLayout><CommunityHeading eyebrow="Civic campaigns" title="Take action together" description="Discover public campaigns and join community-led civic participation."/>
    <label className="community-search">Search campaigns<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Campaign, objective, or area"/></label>
    <Message error={error || actionError}/>{loading ? <div className="community-empty">Loading campaigns…</div> : !data?.campaigns.length ? <div className="community-empty">No public campaigns are available yet.</div> :
      <div className="community-grid">{data.campaigns.map((campaign) => <article className="community-card campaign-card" key={campaign.id}>
        <Link to={`/campaigns/${campaign.id}`} className="community-card-main"><div className="community-card-top"><span className="community-category">{label(campaign.campaignType)}</span><span className="community-status-pill">{label(campaign.status)}</span></div>
          <h2>{campaign.name}</h2><p>{campaign.description}</p><div className="community-meta"><span><MapPin size={14}/>{campaign.targetAreaLabel}</span><span>{campaign.participants} participants</span></div><small>{dateLabel(campaign.startAt)} – {dateLabel(campaign.endAt)}</small>
        </Link>
        <div className="community-card-footer"><span>{campaign.linkedPublicReports} linked public reports</span>
          {user?.role === 'CITIZEN' && (campaign.isJoined || campaignJoinable(campaign)) && <button className={`community-action ${campaign.isJoined ? 'selected' : ''}`} disabled={busy === campaign.id} onClick={() => void changeParticipation(campaign)}>{campaign.isJoined ? 'Joined' : 'Join campaign'}</button>}
        </div>
      </article>)}</div>}
  </CommunityPublicLayout>;
}

function CampaignDetail() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const { data, error, loading, reload, setError } = useLoad<{ campaign: Campaign & { auditHistory?: Array<{ action: string; createdAt: string }> } }>(`/api/community/campaigns/${id}`);
  const [busy, setBusy] = useState(false);
  const [incidentId, setIncidentId] = useState('');
  const campaign = data?.campaign;
  const isManager = user?.role === 'ADMIN' || user?.role === 'AUTHORITY';
  const updateCampaign = async (status: string) => {
    if (!campaign) return;
    setBusy(true);
    setError('');
    try {
      await apiRequest(`/api/community/campaigns/${campaign.id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to update campaign');
    } finally {
      setBusy(false);
    }
  };
  const join = async () => {
    if (!campaign) return;
    setBusy(true);
    setError('');
    try {
      await apiRequest(`/api/community/campaigns/${campaign.id}/join`, { method: campaign.isJoined ? 'DELETE' : 'POST' });
      reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to update participation');
    } finally {
      setBusy(false);
    }
  };
  const linkIncident = async (event: FormEvent) => {
    event.preventDefault();
    if (!campaign || !incidentId.trim()) return;
    setBusy(true);
    setError('');
    try {
      await apiRequest(`/api/community/campaigns/${campaign.id}/incidents/${encodeURIComponent(incidentId.trim())}`, { method: 'PUT' });
      setIncidentId('');
      reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to link public report');
    } finally {
      setBusy(false);
    }
  };
  const back = isManager ? (user?.role === 'ADMIN' ? '/admin/campaigns' : '/authority/campaigns') : '/campaigns';
  return <CommunityPublicLayout><CommunityHeading eyebrow="Civic campaign" title={campaign?.name ?? 'Campaign details'} description={campaign?.targetAreaLabel ?? 'Campaign information and participation.'} back={back}/>
    <Message error={error}/>{loading ? <div className="community-empty">Loading campaign…</div> : !campaign ? <div className="community-empty">This campaign is unavailable.</div> :
      <div className="community-detail-grid"><article className="community-panel"><div className="community-card-top"><span className="community-category">{label(campaign.campaignType)}</span><span className="community-status-pill">{label(campaign.status)}</span></div>
        <h2>Objective</h2><p>{campaign.objective}</p><h2>About this campaign</h2><p>{campaign.description}</p>
        <div className="community-detail-stats"><div><small>Participants</small><strong>{campaign.participants}</strong></div><div><small>Linked public issues</small><strong>{campaign.linkedPublicReports}</strong></div><div><small>Verified linked reports</small><strong>{campaign.verifiedLinkedReports ?? 0}</strong></div></div>
        <h2>Linked public issues</h2>{campaign.linkedIncidents?.length ? campaign.linkedIncidents.map((incident) => <Link className="community-linked-row" key={incident.id} to={`/community/incidents/${incident.id}`}><span>{label(incident.category)}</span><strong>{incident.title}</strong><span>{label(incident.status)}</span></Link>) : <p>No public issue reports are linked yet.</p>}
        {isManager && <form className="community-inline-form" onSubmit={(event) => void linkIncident(event)}><label>Link public incident ID<input value={incidentId} onChange={(event) => setIncidentId(event.target.value)} required/></label><button className="button outline" disabled={busy}>Link report</button></form>}
        {isManager && campaign.auditHistory && <><h2>Management history</h2><div className="community-timeline">{campaign.auditHistory.map((event, index) => <div key={`${event.action}-${index}`}><Megaphone/><span><strong>{label(event.action)}</strong><small>{dateLabel(event.createdAt)}</small></span></div>)}</div></>}
      </article><aside className="community-panel community-aside"><div className="community-status"><span>Campaign period</span><strong>{dateLabel(campaign.startAt)} – {dateLabel(campaign.endAt)}</strong></div><div className="community-status"><span>Target area</span><strong>{campaign.targetAreaLabel}</strong></div>
        {user?.role === 'CITIZEN' && (campaign.isJoined || campaignJoinable(campaign)) && <button className={`button ${campaign.isJoined ? 'outline' : 'primary'} full`} disabled={busy} onClick={() => void join()}>{campaign.isJoined ? 'Leave campaign' : 'Join campaign'}</button>}
        {isManager && <div className="community-manager-actions">{campaign.status === 'DRAFT' && <button className="button primary full" disabled={busy} onClick={() => void updateCampaign('ACTIVE')}>Publish campaign</button>}
          {campaign.status === 'ACTIVE' && <><button className="button outline full" disabled={busy} onClick={() => void updateCampaign('PAUSED')}>Pause campaign</button><button className="button outline full" disabled={busy} onClick={() => void updateCampaign('COMPLETED')}>Complete campaign</button></>}
          {campaign.status === 'PAUSED' && <><button className="button primary full" disabled={busy} onClick={() => void updateCampaign('ACTIVE')}>Resume campaign</button><button className="button outline full" disabled={busy} onClick={() => void updateCampaign('COMPLETED')}>Complete campaign</button></>}
        </div>}
      </aside></div>}
  </CommunityPublicLayout>;
}

function ImpactLedger() {
  const [category, setCategory] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [centerLatitude, setCenterLatitude] = useState('');
  const [centerLongitude, setCenterLongitude] = useState('');
  const [radiusMeters, setRadiusMeters] = useState('1000');
  const path = useMemo(() => {
    const params = new URLSearchParams({ limit: '20' });
    if (category) params.set('category', category);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (centerLatitude || centerLongitude) {
      if (centerLatitude) params.set('centerLatitude', centerLatitude);
      if (centerLongitude) params.set('centerLongitude', centerLongitude);
      if (centerLatitude && centerLongitude) params.set('radiusMeters', radiusMeters);
    }
    return `/api/community/impact?${params}`;
  }, [category, from, to, centerLatitude, centerLongitude, radiusMeters]);
  const { data, error, loading } = useLoad<{
    ledger: ImpactRecord[];
    stats: {
      verifiedIssuesResolved: number;
      reopenedCases: number;
      disputedCases: number;
      verificationRate: number | null;
      averageResolutionHours: number | null;
      verifiedOutcomesByCategory: Record<string, number>;
      verifiedOutcomesByDepartment: Array<{ department: string; verifiedOutcomes: number }>;
      verifiedOutcomesOverTime: Array<{ period: string; count: number }>;
    };
    stories: string[];
    dataLimitations: string[];
  }>(path);
  const stats = data?.stats;
  return <CommunityPublicLayout><CommunityHeading eyebrow="Verified civic impact" title="A ledger of confirmed improvements" description="Only public incidents with an independently verified resolution count as completed impact."/>
    <div className="community-filter-row"><select value={category} onChange={(event) => setCategory(event.target.value)}><option value="">All categories</option>{categories.map((item) => <option key={item} value={item}>{label(item)}</option>)}</select><label>From<input type="date" value={from} onChange={(event) => setFrom(event.target.value)}/></label><label>To<input type="date" value={to} onChange={(event) => setTo(event.target.value)}/></label><label>Area center latitude<input type="number" step="any" min="-90" max="90" value={centerLatitude} onChange={(event) => setCenterLatitude(event.target.value)}/></label><label>Longitude<input type="number" step="any" min="-180" max="180" value={centerLongitude} onChange={(event) => setCenterLongitude(event.target.value)}/></label><label>Radius (m)<input type="number" min="100" max="50000" value={radiusMeters} onChange={(event) => setRadiusMeters(event.target.value)}/></label></div>
    <Message error={error}/>
    {loading ? <div className="community-empty">Loading verified outcomes…</div> : <>
      <div className="community-detail-stats"><div><small>Verified issues resolved</small><strong>{stats?.verifiedIssuesResolved ?? 0}</strong></div><div><small>Reopened cases</small><strong>{stats?.reopenedCases ?? 0}</strong></div><div><small>Disputed / under review</small><strong>{stats?.disputedCases ?? 0}</strong></div><div><small>Final verification rate</small><strong>{stats?.verificationRate === null || stats?.verificationRate === undefined ? 'Insufficient data' : `${stats.verificationRate}%`}</strong></div><div><small>Average resolution time</small><strong>{stats?.averageResolutionHours === null || stats?.averageResolutionHours === undefined ? 'Insufficient data' : `${stats.averageResolutionHours} hrs`}</strong></div></div>
      <div className="community-panel community-impact-summary"><h2>Verified improvement summary</h2><p>{data?.stories[0]}</p>{stats?.verifiedOutcomesOverTime?.length ? <div className="community-months">{stats.verifiedOutcomesOverTime.map((item) => <span key={item.period}><strong>{item.count}</strong><small>{item.period}</small></span>)}</div> : null}</div>
      <div className="community-area-layout"><div className="community-panel"><h2>By category</h2>{Object.entries(stats?.verifiedOutcomesByCategory ?? {}).length ? Object.entries(stats?.verifiedOutcomesByCategory ?? {}).map(([categoryName, count]) => <div className="community-status" key={categoryName}><span>{label(categoryName)}</span><strong>{count}</strong></div>) : <p>No category outcomes in this period.</p>}</div><div className="community-panel"><h2>By department</h2>{stats?.verifiedOutcomesByDepartment.length ? stats.verifiedOutcomesByDepartment.map((item) => <div className="community-status" key={item.department}><span>{item.department}</span><strong>{item.verifiedOutcomes}</strong></div>) : <p>No department outcomes in this period.</p>}</div></div>
      <h2 className="community-section-title">Verified outcomes</h2>{data?.ledger.length ? <div className="community-impact-list">{data.ledger.map((item) => <article className="community-panel" key={item.incidentId}><div className="community-card-top"><span className="community-category">{label(item.category)}</span><span className="community-verified"><CheckCircle2/> Verified</span></div><h3>{item.resolutionSummary}</h3><p>{item.location.label} · {item.department}</p><small>Resolved {dateLabel(item.resolvedAt)} · verified {dateLabel(item.verifiedAt)}</small>{item.publicEvidence.length > 0 && <div className="community-evidence">{item.publicEvidence.map((url) => <a key={url} href={apiUrl(url)} target="_blank" rel="noreferrer">Public evidence</a>)}</div>}</article>)}</div> : <div className="community-empty">No verified public outcomes match these filters.</div>}
      <ul className="community-limitations">{data?.dataLimitations.map((text) => <li key={text}>{text}</li>)}</ul>
    </>}
  </CommunityPublicLayout>;
}

export function CommunityPortalPage({ mode }: { mode: PortalMode }) {
  if (mode === 'dashboard') return <CitizenCommunityDashboard/>;
  if (mode === 'areas') return <FollowedAreasPage/>;
  if (mode === 'participation') return <ParticipationHistory/>;
  if (mode === 'notifications') return <NotificationsPage/>;
  return <CampaignManagement/>;
}

function CitizenCommunityDashboard() {
  const { data, error, loading } = useLoad<{
    summary: { activeSupports: number; activeAreas: number; activeCampaigns: number; unreadNotifications: number };
    recentSupports: Array<{ id: string; title: string; category: string; status: string }>;
    campaigns: Array<{ id: string; name: string; status: string; endAt: string }>;
  }>('/api/community/me/dashboard', true);
  const cards: Array<[string, number, LucideIcon]> = [
    ['Supported issues', data?.summary.activeSupports ?? 0, Heart],
    ['Followed areas', data?.summary.activeAreas ?? 0, MapPin],
    ['Joined campaigns', data?.summary.activeCampaigns ?? 0, Megaphone],
    ['Unread updates', data?.summary.unreadNotifications ?? 0, Bell],
  ];
  return <section className="community-portal"><CommunityHeading eyebrow="Citizen community" title="Your community activity" description="Track issues you support, areas you follow, and campaigns you have joined."/>
    <Message error={error}/>{loading ? <div className="community-empty">Loading your community dashboard…</div> : <>
      <div className="community-portal-stats">{cards.map(([title, value, Icon]) => <div className="community-panel" key={title}><Icon size={19}/><small>{title}</small><strong>{value}</strong></div>)}</div>
      <div className="community-shortcuts"><NavLink to="/community">Community feed</NavLink><NavLink to="/citizen/areas">Manage followed areas</NavLink><NavLink to="/campaigns">Explore campaigns</NavLink><NavLink to="/citizen/participation">Participation history</NavLink><NavLink to="/citizen/notifications">Notifications</NavLink><NavLink to="/impact">Verified impact</NavLink></div>
      <div className="community-panel"><h2>Recent supported issues</h2>{data?.recentSupports.length ? data.recentSupports.map((item) => <Link className="community-linked-row" key={item.id} to={`/community/incidents/${item.id}`}><span>{label(item.category)}</span><strong>{item.title}</strong><span>{label(item.status)}</span></Link>) : <p>You have not supported a public issue yet.</p>}</div>
      <div className="community-panel"><h2>Campaigns you joined</h2>{data?.campaigns.length ? data.campaigns.map((item) => <Link className="community-linked-row" key={item.id} to={`/campaigns/${item.id}`}><span>{label(item.status)}</span><strong>{item.name}</strong><span>Ends {dateLabel(item.endAt)}</span></Link>) : <p>You have not joined a campaign yet.</p>}</div>
    </>}
  </section>;
}

function FollowedAreasPage() {
  const { data, error, loading, reload, setError } = useLoad<{ areas: FollowedArea[] }>('/api/community/areas');
  const [selected, setSelected] = useState('');
  const [activityState, setActivityState] = useState<{ areaId: string; data: { incidents: CommunityIncident[]; campaigns: Campaign[] } } | null>(null);
  const [form, setForm] = useState({ name: '', centerLatitude: '', centerLongitude: '', radiusMeters: '500' });
  const [busy, setBusy] = useState(false);
  const selectedId = selected || data?.areas[0]?.id || '';
  const activity = activityState?.areaId === selectedId ? activityState.data : null;
  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    void apiRequest<{ incidents: CommunityIncident[]; campaigns: Campaign[] }>(`/api/community/areas/${selectedId}/activity`)
      .then((result) => { if (active) setActivityState({ areaId: selectedId, data: result }); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : 'Unable to load followed-area activity'); });
    return () => { active = false; };
  }, [selectedId, setError]);
  const createArea = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await apiRequest<{ area: FollowedArea }>('/api/community/areas', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          centerLatitude: Number(form.centerLatitude),
          centerLongitude: Number(form.centerLongitude),
          radiusMeters: Number(form.radiusMeters),
        }),
      });
      setForm({ name: '', centerLatitude: '', centerLongitude: '', radiusMeters: '500' });
      setSelected(result.area.id);
      reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to follow area');
    } finally {
      setBusy(false);
    }
  };
  const unfollow = async (areaId: string) => {
    setBusy(true);
    setError('');
    try {
      await apiRequest(`/api/community/areas/${areaId}`, { method: 'DELETE' });
      setSelected('');
      reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to unfollow area');
    } finally {
      setBusy(false);
    }
  };
  const current = data?.areas.find((area) => area.id === selectedId);
  return <section className="community-portal"><CommunityHeading eyebrow="Personalized activity" title="Followed areas" description="Create up to 20 circular areas. These are personal watch areas, not official neighborhood boundaries."/>
    <Message error={error}/><div className="community-area-layout"><div className="community-panel"><h2>Your areas</h2>{loading ? <p>Loading followed areas…</p> : !data?.areas.length ? <p>You are not following any areas yet.</p> : data.areas.map((area) => <button key={area.id} className={`community-area-choice ${selectedId === area.id ? 'active' : ''}`} onClick={() => setSelected(area.id)}><span><strong>{area.name}</strong><small>{area.radiusMeters} m radius · followed {dateLabel(area.followedAt)}</small></span><MapPin size={17}/></button>)}</div>
      <div className="community-panel"><h2>Follow a new area</h2><form className="community-form" onSubmit={(event) => void createArea(event)}><label>Area name<input required minLength={2} maxLength={60} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })}/></label><div className="community-form-row"><label>Center latitude<input required type="number" step="any" min="-90" max="90" value={form.centerLatitude} onChange={(event) => setForm({ ...form, centerLatitude: event.target.value })}/></label><label>Center longitude<input required type="number" step="any" min="-180" max="180" value={form.centerLongitude} onChange={(event) => setForm({ ...form, centerLongitude: event.target.value })}/></label></div><label>Radius (100–10,000 m)<input required type="number" min="100" max="10000" value={form.radiusMeters} onChange={(event) => setForm({ ...form, radiusMeters: event.target.value })}/></label><button className="button primary" disabled={busy}>Follow area</button></form></div></div>
    {current && <div className="community-panel community-area-activity"><div className="community-panel-heading"><h2>Activity near {current.name}</h2><button className="button outline" disabled={busy} onClick={() => void unfollow(current.id)}>Unfollow</button></div>
      <h3>Public issues</h3>{activity?.incidents.length ? activity.incidents.map((incident) => <Link className="community-linked-row" key={incident.id} to={`/community/incidents/${incident.id}`}><span>{label(incident.category)}</span><strong>{incident.title}</strong><span>{label(incident.status)}</span></Link>) : <p>No recent public issues were found in this area.</p>}
      <h3>Nearby campaigns</h3>{activity?.campaigns.length ? activity.campaigns.map((campaign) => <Link className="community-linked-row" key={campaign.id} to={`/campaigns/${campaign.id}`}><span>{label(campaign.status)}</span><strong>{campaign.name}</strong><span>{campaign.participants} participants</span></Link>) : <p>No campaigns were found nearby.</p>}
    </div>}
  </section>;
}

type ParticipationEvent = { id: string; type: string; createdAt: string; subject: { type: string; id: string; name?: string; title?: string; category?: string; status?: string } };
function ParticipationHistory() {
  const { data, error, loading } = useLoad<{ events: ParticipationEvent[]; pagination: { total: number } }>('/api/community/me/participation?limit=50');
  return <section className="community-portal"><CommunityHeading eyebrow="Your civic record" title="Participation history" description="A timeline of your support, area follows, and campaign participation."/>
    <Message error={error}/>{loading ? <div className="community-empty">Loading your participation history…</div> : <div className="community-panel"><p>{data?.pagination.total ?? 0} recorded activities</p>{data?.events.length ? <div className="community-timeline">{data.events.map((event) => <div key={event.id}><Activity/><span><strong>{label(event.type)} · {event.subject.name || event.subject.title || label(event.subject.category || event.subject.type)}</strong><small>{dateLabel(event.createdAt)}{event.subject.status ? ` · ${label(event.subject.status)}` : ''}</small></span>{event.subject.type === 'INCIDENT' && <Link to={`/community/incidents/${event.subject.id}`}>Open issue</Link>}{event.subject.type === 'CAMPAIGN' && <Link to={`/campaigns/${event.subject.id}`}>Open campaign</Link>}</div>)}</div> : <p>No participation history is recorded yet.</p>}</div>}
  </section>;
}

function NotificationsPage() {
  const { data, error, loading, reload, setError } = useLoad<{ notifications: NotificationItem[]; unread: number }>('/api/community/notifications?limit=50', true);
  const markRead = async (id?: string) => {
    setError('');
    try {
      await apiRequest(id ? `/api/community/notifications/${id}/read` : '/api/community/notifications/read-all', { method: 'POST' });
      reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to update notifications');
    }
  };
  const hrefFor = (item: NotificationItem) => item.entityType === 'CAMPAIGN' ? `/campaigns/${item.entityId}` : `/community/incidents/${item.entityId}`;
  return <section className="community-portal"><CommunityHeading eyebrow="In-app updates" title="Notifications" description="Recent public activity related to reports you support, areas you follow, and campaigns you joined."/>
    <Message error={error}/><div className="community-panel"><div className="community-panel-heading"><h2>{data?.unread ?? 0} unread</h2><button className="button outline" disabled={!data?.unread} onClick={() => void markRead()}>Mark all read</button></div>
      {loading ? <p>Loading notifications…</p> : data?.notifications.length ? data.notifications.map((item) => <div className={`community-notification ${item.readAt ? '' : 'unread'}`} key={item.id}><Bell/><span><Link to={hrefFor(item)} onClick={() => !item.readAt && void markRead(item.id)}><strong>{item.title}</strong><small>{item.message} · {dateLabel(item.createdAt)}</small></Link></span>{!item.readAt && <button className="text-button" onClick={() => void markRead(item.id)}>Mark read</button>}</div>) : <p>You have no notifications yet.</p>}
    </div>
  </section>;
}

function CampaignManagement() {
  const { data, error, loading, reload, setError } = useLoad<{ campaigns: Campaign[] }>('/api/community/campaigns/manage?limit=50');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    name: '', description: '', objective: '', campaignType: 'OTHER', targetAreaLabel: '',
    startAt: '', endAt: '', targetLatitude: '', targetLongitude: '', radiusMeters: '',
  });
  const createCampaign = async (event: FormEvent) => {
    event.preventDefault();
    const hasCoordinates = form.targetLatitude !== '' || form.targetLongitude !== '' || form.radiusMeters !== '';
    const hasCompleteCoordinates = form.targetLatitude !== '' && form.targetLongitude !== '' && form.radiusMeters !== '';
    if (hasCoordinates && !hasCompleteCoordinates) {
      setError('Provide target latitude, longitude, and radius together, or leave all three blank.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const { targetLatitude, targetLongitude, radiusMeters, ...campaignFields } = form;
      await apiRequest('/api/community/campaigns', {
        method: 'POST',
        body: JSON.stringify({
          ...campaignFields,
          startAt: new Date(form.startAt).toISOString(),
          endAt: new Date(form.endAt).toISOString(),
          ...(hasCompleteCoordinates ? {
            targetLatitude: Number(targetLatitude),
            targetLongitude: Number(targetLongitude),
            radiusMeters: Number(radiusMeters),
          } : {}),
        }),
      });
      setForm({ name: '', description: '', objective: '', campaignType: 'OTHER', targetAreaLabel: '', startAt: '', endAt: '', targetLatitude: '', targetLongitude: '', radiusMeters: '' });
      reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to create campaign');
    } finally {
      setBusy(false);
    }
  };
  return <section className="community-portal"><CommunityHeading eyebrow="Campaign oversight" title="Manage civic campaigns" description="Create and publish campaigns, track participation, and review linked public incidents."/>
    <Message error={error}/><div className="community-area-layout"><div className="community-panel"><h2>Campaigns</h2>{loading ? <p>Loading campaigns…</p> : data?.campaigns.length ? data.campaigns.map((campaign) => <Link className="community-linked-row" key={campaign.id} to={`/campaigns/${campaign.id}`}><span>{label(campaign.status)}</span><strong>{campaign.name}</strong><span>{campaign.participants} participants</span></Link>) : <p>No campaigns created yet.</p>}</div>
      <div className="community-panel"><h2>Create a campaign</h2><form className="community-form" onSubmit={(event) => void createCampaign(event)}>
        <label>Name<input required minLength={5} maxLength={120} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })}/></label>
        <label>Campaign type<select value={form.campaignType} onChange={(event) => setForm({ ...form, campaignType: event.target.value })}>{['AWARENESS', 'CLEANUP', 'INFRASTRUCTURE', 'SAFETY', 'CONSERVATION', 'OTHER'].map((type) => <option key={type} value={type}>{label(type)}</option>)}</select></label>
        <label>Description<textarea required minLength={20} maxLength={2000} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })}/></label>
        <label>Objective<textarea required minLength={10} maxLength={1000} value={form.objective} onChange={(event) => setForm({ ...form, objective: event.target.value })}/></label>
        <label>Target area label<input required minLength={2} maxLength={120} value={form.targetAreaLabel} onChange={(event) => setForm({ ...form, targetAreaLabel: event.target.value })}/></label>
        <div className="community-form-row"><label>Start<input required type="datetime-local" value={form.startAt} onChange={(event) => setForm({ ...form, startAt: event.target.value })}/></label><label>End<input required type="datetime-local" value={form.endAt} onChange={(event) => setForm({ ...form, endAt: event.target.value })}/></label></div>
        <div className="community-form-row"><label>Target latitude (optional)<input type="number" step="any" min="-90" max="90" value={form.targetLatitude} onChange={(event) => setForm({ ...form, targetLatitude: event.target.value })}/></label><label>Target longitude<input type="number" step="any" min="-180" max="180" value={form.targetLongitude} onChange={(event) => setForm({ ...form, targetLongitude: event.target.value })}/></label></div>
        <label>Target radius in meters<input type="number" min="100" max="50000" value={form.radiusMeters} onChange={(event) => setForm({ ...form, radiusMeters: event.target.value })}/></label>
        <button className="button primary" disabled={busy}>Create draft</button>
      </form></div></div>
  </section>;
}
