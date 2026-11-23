import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type ReactNode } from 'react';
import { Link, NavLink, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { MapContainer, Marker, Popup, TileLayer } from 'react-leaflet';
import L from 'leaflet';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  Activity, AlertTriangle, ArrowLeft, ArrowRight, BarChart3, Bell, Building2, CalendarClock,
  CheckCircle2, ChevronLeft, ChevronRight, ClipboardList, Clock3, FileCheck2, ImagePlus,
  LayoutDashboard, ListFilter, LogOut, MapPin, Menu, Search, ShieldCheck, UserRound, X,
} from 'lucide-react';
import { apiRequest, apiUrl } from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import type { Category } from '../../types';
import './authority.css';

type Status = 'REPORTED' | 'ACKNOWLEDGED' | 'IN_PROGRESS' | 'RESOLUTION_SUBMITTED' | 'VERIFICATION_PENDING' | 'RESOLVED' | 'REOPENED' | 'ON_HOLD' | 'REJECTED' | 'DUPLICATE';
type Priority = 'P1' | 'P2' | 'P3' | 'P4';
type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
type View = 'all' | 'new' | 'unassigned' | 'critical' | 'high-priority' | 'in-progress' | 'awaiting-verification' | 'overdue';

interface AuthorityIncident {
  id: string;
  title: string;
  description: string;
  category: Category;
  subcategory: string | null;
  locationText: string;
  latitude: number;
  longitude: number;
  status: Status;
  severity: Severity;
  priorityBand: Priority;
  priorityScore: number;
  createdAt: string;
  updatedAt: string;
  acknowledgedAt: string | null;
  assignedAt: string | null;
  resolutionSubmittedAt: string | null;
  holdReason: string | null;
  rejectionReason: string | null;
  resolutionDescription: string | null;
  resolutionBreakdown?: unknown;
  resolutionEvidenceUrls?: string[];
  imageUrls: string[];
  isPublic: boolean;
  aiSummary: string | null;
  aiCategory: Category | null;
  aiSubcategory: string | null;
  aiConfidence: number | null;
  aiReasoning: string | null;
  aiProvider: string | null;
  department: { id: string; name: string; code: string } | null;
  assignedAuthority: { id: string; fullName: string; email?: string } | null;
  reporter: { id: string; fullName: string } | null;
  duplicateOf: { id: string; title: string; status: Status } | null;
  duplicates: { id: string; title: string; status: Status }[];
  evidence: ResolutionEvidence[];
  verificationCases?: {
    id: string;
    status: string;
    citizenDecision: string | null;
    responseDeadline: string;
    escalationAt: string | null;
    reviewDueAt: string | null;
    actions: Array<{ actionType: string; reason: string | null; evidenceUrls: string[]; createdAt: string }>;
    analyses: Array<{ result: string; confidence: number; explanation: string; createdAt: string }>;
  }[];
  activities: ActivityRecord[];
  allowedTransitions?: Status[];
}

interface ActivityRecord {
  id: string;
  activityType: string;
  activityDescription: string;
  previousStatus: Status | null;
  newStatus: Status | null;
  visibility: 'PUBLIC' | 'INTERNAL';
  createdAt: string;
  actor: { id: string; fullName: string } | null;
}

interface ResolutionEvidence {
  id: string;
  evidenceImageUrls: string[];
  evidenceDescription: string;
  verificationResult: string;
  workCompleted: string | null;
  resolutionDate: string | null;
  internalNotes: string | null;
  submittedAt: string;
  submittedBy: { id: string; fullName: string } | null;
}

interface QueueResponse {
  incidents: AuthorityIncident[];
  pagination: { page: number; limit: number; total: number; pages: number };
}

interface DashboardResponse {
  kpis: { new: number; awaitingAcknowledgment: number; inProgress: number; awaitingVerification: number; overdue: number; resolved: number };
  priorityQueue: AuthorityIncident[];
  recentlyUpdated: AuthorityIncident[];
  alerts: { critical: number; highPriority: number; overdue: AuthorityIncident[]; unacknowledged: number };
  workload: { open: number; byStatus: Record<string, number>; byPriority: Record<string, number>; assigned: number; unassigned: number; averageResolutionHours: number | null; resolutionSampleSize: number };
  thresholds: { overdueHours: number; unacknowledgedHours: number };
}

interface AnalyticsResponse {
  metrics: {
    totalReports: number;
    open: number;
    resolved: number;
    overdue: number;
    averageAcknowledgmentHours: number | null;
    acknowledgmentSampleSize: number;
    averageResolutionHours: number | null;
    resolutionSampleSize: number;
    averageMetricsLimit: boolean;
  };
  byStatus: { status: string; count: number }[];
  byCategory: { category: string; count: number }[];
  byPriority: { priorityBand: string; count: number }[];
  authorityWorkload: { authorityId: string; name: string; active: boolean; assignedIncidents: number }[];
  weeklyTrend: { period: string; reports: number; resolved: number }[];
  monthlyTrend: { period: string; reports: number; resolved: number }[];
  dateSemantics: { reports: string; resolved: string; workload: string };
}

interface AuthoritySummary {
  id: string;
  fullName: string;
  designation: string;
  departmentId: string;
  active: boolean;
}

const categoryColors: Record<Category, string> = {
  ROAD: '#d97706', WASTE: '#64748b', WATER: '#0284c7', DRAINAGE: '#2563eb',
  ELECTRICITY: '#ca8a04', PUBLIC_SPACE: '#059669', OTHER: '#7c3aed',
};
const statusOptions: Status[] = ['REPORTED', 'ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLUTION_SUBMITTED', 'VERIFICATION_PENDING', 'RESOLVED', 'REOPENED', 'ON_HOLD', 'REJECTED', 'DUPLICATE'];
const views: { id: View; label: string }[] = [
  { id: 'all', label: 'All incidents' },
  { id: 'new', label: 'New reports' },
  { id: 'unassigned', label: 'Unassigned' },
  { id: 'critical', label: 'Critical' },
  { id: 'high-priority', label: 'High priority' },
  { id: 'in-progress', label: 'In progress' },
  { id: 'awaiting-verification', label: 'Awaiting verification' },
  { id: 'overdue', label: 'Overdue' },
];
const marker = L.divIcon({ className: 'authority-map-marker', html: '<span></span>', iconSize: [26, 26], iconAnchor: [13, 26] });

function label(value: string) {
  return value.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function dateTime(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : '—';
}

function Portal({ children }: { children: ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const initial = user?.fullName.split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase() || 'CL';
  const signOut = async () => {
    await logout();
    navigate('/', { replace: true });
  };
  const links = [
    { to: '/authority', label: 'Overview', Icon: LayoutDashboard, end: true },
    { to: '/authority/incidents', label: 'Incident Queue', Icon: ClipboardList, end: false },
    { to: '/authority/analytics', label: 'Analytics', Icon: BarChart3, end: false },
    { to: '/authority/profile', label: 'Profile', Icon: UserRound, end: false },
  ];
  return (
    <div className="portal authority-portal">
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="sidebar-logo"><Link className="logo" to="/"><span className="logo-mark"><ShieldCheck size={21}/></span><span>Civic<span>Loop</span></span></Link><button className="icon-button" aria-label="Close menu" onClick={() => setSidebarOpen(false)}><X/></button></div>
        <div className="portal-label">Authority Operations</div>
        <nav>{links.map(({ to, label: linkLabel, Icon, end }) => <NavLink key={to} to={to} end={end} onClick={() => setSidebarOpen(false)}><Icon size={18}/>{linkLabel}</NavLink>)}</nav>
        <div className="sidebar-user"><span>{initial}</span><div><strong>{user?.fullName ?? 'Authority'}</strong><small>{user?.role === 'ADMIN' ? 'Administrator' : 'Authority'}</small></div></div>
      </aside>
      {sidebarOpen && <button className="sidebar-backdrop" aria-label="Close menu" onClick={() => setSidebarOpen(false)}/>}
      <div className="portal-main">
        <header className="portal-header">
          <button className="icon-button authority-menu-button" aria-label="Open menu" onClick={() => setSidebarOpen(true)}><Menu/></button>
          <div><span>Secure workspace</span><strong>Authority Operations Center</strong></div>
          <div className="portal-header-actions"><Bell size={18}/><span className="avatar">{initial}</span><button className="text-button" onClick={() => void signOut()}><LogOut size={15}/> Sign out</button></div>
        </header>
        <main className="portal-content authority-content">{children}</main>
      </div>
    </div>
  );
}

function PageTitle({ eyebrow = 'AUTHORITY OPERATIONS', title, subtitle, action }: { eyebrow?: string; title: string; subtitle: string; action?: ReactNode }) {
  return <div className="portal-page-header authority-page-title"><div><span>{eyebrow}</span><h1>{title}</h1><p>{subtitle}</p></div>{action}</div>;
}

function ErrorNotice({ children }: { children: ReactNode }) {
  return <div className="authority-error" role="alert"><AlertTriangle size={17}/><span>{children}</span></div>;
}

function LoadingPanel({ text = 'Loading live incident data…' }: { text?: string }) {
  return <div className="authority-loading"><span className="loading-spinner"/>{text}</div>;
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`authority-status status-${status.toLowerCase()}`}>{label(status)}</span>;
}

function PriorityBadge({ priority, score }: { priority: string; score?: number }) {
  return <span className={`authority-priority priority-${priority.toLowerCase()}`}>{priority}{score !== undefined && <small>{score}</small>}</span>;
}

function IncidentTable({ rows }: { rows: AuthorityIncident[] }) {
  if (!rows.length) return <div className="authority-empty"><ClipboardList size={25}/><strong>Nothing in this queue</strong><span>New reports matching this view will appear here.</span></div>;
  return <div className="table-scroll"><table className="authority-table"><thead><tr><th>Incident</th><th>Priority</th><th>Status</th><th>Assigned to</th><th>Reported</th><th/></tr></thead><tbody>
    {rows.map((incident) => <tr key={incident.id}>
      <td><Link to={`/authority/incidents/${incident.id}`} className="authority-incident-title"><strong>{incident.title}</strong><small>{incident.id} · {label(incident.category)} · {incident.locationText}</small></Link></td>
      <td><PriorityBadge priority={incident.priorityBand} score={incident.priorityScore}/><small className="authority-severity">{label(incident.severity)} severity</small></td>
      <td><StatusBadge status={incident.status}/></td>
      <td>{incident.assignedAuthority?.fullName ?? <span className="muted">Unassigned</span>}</td>
      <td>{new Date(incident.createdAt).toLocaleDateString()}</td>
      <td><Link className="authority-open-link" aria-label={`Open ${incident.title}`} to={`/authority/incidents/${incident.id}`}><ChevronRight size={18}/></Link></td>
    </tr>)}
  </tbody></table></div>;
}

function KPI({ label: title, value, Icon, to, tone }: { label: string; value: number; Icon: typeof Activity; to: string; tone?: string }) {
  return <Link to={to} className={`authority-kpi ${tone ?? ''}`}><span className="authority-kpi-icon"><Icon size={19}/></span><span>{title}</span><strong>{value}</strong><ArrowRight size={15} className="authority-kpi-arrow"/></Link>;
}

export function AuthorityDashboard() {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    void apiRequest<DashboardResponse>('/api/authority/dashboard')
      .then((response) => { if (active) setData(response); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : 'Unable to load authority dashboard'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  return <Portal><PageTitle title="Department overview" subtitle="Live workload, priority reports, and operational alerts." action={<Link className="button outline" to="/authority/incidents"><ListFilter size={16}/> Open incident queue</Link>}/>
    {error && <ErrorNotice>{error}</ErrorNotice>}
    {loading ? <LoadingPanel/> : data && <>
      <div className="authority-kpi-grid">
        <KPI label="New incidents" value={data.kpis.new} Icon={ClipboardList} to="/authority/incidents?view=new"/>
        <KPI label="Awaiting acknowledgment" value={data.kpis.awaitingAcknowledgment} Icon={Clock3} to="/authority/incidents?view=new" tone="amber"/>
        <KPI label="In progress" value={data.kpis.inProgress} Icon={Activity} to="/authority/incidents?view=in-progress"/>
        <KPI label="Awaiting verification" value={data.kpis.awaitingVerification} Icon={FileCheck2} to="/authority/incidents?view=awaiting-verification" tone="amber"/>
        <KPI label="Overdue" value={data.kpis.overdue} Icon={AlertTriangle} to="/authority/incidents?view=overdue" tone="red"/>
        <KPI label="Resolved" value={data.kpis.resolved} Icon={CheckCircle2} to="/authority/incidents?status=RESOLVED" tone="green"/>
      </div>
      <div className="authority-alert-strip">
        <span><AlertTriangle size={17}/><strong>{data.alerts.critical}</strong> critical actionable</span>
        <span><PriorityBadge priority="P1"/> <strong>{data.alerts.highPriority}</strong> P1/P2 queue</span>
        <span><Clock3 size={17}/><strong>{data.alerts.unacknowledged}</strong> unacknowledged over {data.thresholds.unacknowledgedHours}h</span>
        <span><CalendarClock size={17}/><strong>{data.kpis.overdue}</strong> overdue alerts</span>
      </div>
      <div className="authority-dashboard-grid">
        <section className="panel authority-panel authority-wide">
          <div className="panel-header"><div><span>Prioritized by urgency, score, and age</span><h3>Priority queue</h3></div><Link to="/authority/incidents">View all <ArrowRight size={14}/></Link></div>
          <IncidentTable rows={data.priorityQueue}/>
        </section>
        <section className="panel authority-panel">
          <div className="panel-header"><div><span>Current department load</span><h3>Workload overview</h3></div></div>
          <div className="authority-workload-total"><strong>{data.workload.open}</strong><span>open incidents</span></div>
          <div className="authority-workload-split"><span>Assigned <strong>{data.workload.assigned}</strong></span><span>Unassigned <strong>{data.workload.unassigned}</strong></span></div>
          <div className="authority-bars">{Object.entries(data.workload.byStatus).map(([status, count]) => { const maxCount=Math.max(1,...Object.values(data.workload.byStatus)); return <div key={status}><span>{label(status)}</span><b><i style={{ width: `${Math.min(100, count / maxCount * 100)}%` }}/></b><strong>{count}</strong></div>; })}</div>
          <div className="authority-average"><span>Avg. resolution time</span><strong>{data.workload.averageResolutionHours === null ? 'Insufficient data' : `${data.workload.averageResolutionHours}h`}</strong><small>{data.workload.resolutionSampleSize} resolved records sampled</small></div>
        </section>
        <section className="panel authority-panel authority-wide">
          <div className="panel-header"><div><span>Most recent database updates</span><h3>Recently updated incidents</h3></div></div>
          <IncidentTable rows={data.recentlyUpdated}/>
        </section>
        <section className="panel authority-panel">
          <div className="panel-header"><div><span>Action needed</span><h3>Overdue incidents</h3></div><Link to="/authority/incidents?view=overdue">See queue</Link></div>
          {!data.alerts.overdue.length ? <div className="authority-inline-empty">No overdue actionable reports.</div> : data.alerts.overdue.map((incident) => <Link className="authority-alert-row" key={incident.id} to={`/authority/incidents/${incident.id}`}><span className="authority-alert-dot"/><span><strong>{incident.title}</strong><small>{incident.priorityBand} · {dateTime(incident.createdAt)}</small></span><ChevronRight size={16}/></Link>)}
        </section>
      </div>
    </>}
  </Portal>;
}

export function AuthorityIncidentQueue() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState(searchParams.get('search') ?? '');
  const [status, setStatus] = useState(searchParams.get('status') ?? 'ALL');
  const [priority, setPriority] = useState('ALL');
  const [severity, setSeverity] = useState('ALL');
  const [category, setCategory] = useState('ALL');
  const [assigned, setAssigned] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sort, setSort] = useState('priority');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<QueueResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const view = (searchParams.get('view') as View | null) ?? 'all';
  const paramsKey = searchParams.toString();

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams({ page: String(page), limit: '20', sort, view });
    if (search.trim()) params.set('search', search.trim());
    if (status !== 'ALL') params.set('status', status);
    if (priority !== 'ALL') params.set('priority', priority);
    if (severity !== 'ALL') params.set('severity', severity);
    if (category !== 'ALL') params.set('category', category);
    if (assigned !== 'all') params.set('assigned', assigned);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    void Promise.resolve().then(() => {
      if (!active) return;
      setLoading(true);
      setError('');
      return apiRequest<QueueResponse>(`/api/authority/incidents?${params}`);
    }).then((response) => { if (active && response) setData(response); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : 'Unable to load incident queue'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [page, search, status, priority, severity, category, assigned, from, to, sort, view, paramsKey]);

  const selectView = (value: View) => {
    const next = new URLSearchParams(searchParams);
    if (value === 'all') next.delete('view');
    else next.set('view', value);
    setPage(1);
    setSearchParams(next);
  };
  const updateFilter = <T,>(setter: (value: T) => void, value: T) => { setter(value); setPage(1); };
  return <Portal><PageTitle title="Incident queue" subtitle="Search and manage reports assigned to your department."/>
    <div className="authority-view-tabs">{views.map((item) => <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => selectView(item.id)}>{item.label}</button>)}</div>
    <div className="toolbar authority-filters">
      <label className="search-field"><Search/><input aria-label="Search incidents" value={search} onChange={(event) => updateFilter(setSearch, event.target.value)} placeholder="Search title, description, or location"/></label>
      <select aria-label="Filter status" value={status} onChange={(event) => updateFilter(setStatus, event.target.value)}><option value="ALL">All statuses</option>{statusOptions.map((item) => <option key={item} value={item}>{label(item)}</option>)}</select>
      <select aria-label="Filter priority" value={priority} onChange={(event) => updateFilter(setPriority, event.target.value)}><option value="ALL">All priorities</option>{['P1', 'P2', 'P3', 'P4'].map((item) => <option key={item}>{item}</option>)}</select>
      <select aria-label="Filter severity" value={severity} onChange={(event) => updateFilter(setSeverity, event.target.value)}><option value="ALL">All severity</option>{['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((item) => <option key={item}>{item}</option>)}</select>
      <select aria-label="Filter category" value={category} onChange={(event) => updateFilter(setCategory, event.target.value)}><option value="ALL">All categories</option>{Object.keys(categoryColors).map((item) => <option key={item}>{item}</option>)}</select>
      <select aria-label="Filter assignment" value={assigned} onChange={(event) => updateFilter(setAssigned, event.target.value)}><option value="all">Any assignment</option><option value="assigned">Assigned</option><option value="unassigned">Unassigned</option><option value="mine">Assigned to me</option></select>
      <label className="authority-date-filter">From<input type="date" value={from} onChange={(event) => updateFilter(setFrom, event.target.value)}/></label>
      <label className="authority-date-filter">To<input type="date" value={to} onChange={(event) => updateFilter(setTo, event.target.value)}/></label>
      <select aria-label="Sort incidents" value={sort} onChange={(event) => updateFilter(setSort, event.target.value)}><option value="priority">Priority order</option><option value="newest">Newest</option><option value="oldest">Oldest</option><option value="updated">Recently updated</option></select>
    </div>
    {error && <ErrorNotice>{error}</ErrorNotice>}
    <section className="panel authority-panel">
      <div className="panel-header"><div><span>{data?.pagination.total ?? 0} matching reports</span><h3>{views.find((item) => item.id === view)?.label}</h3></div><span className="authority-scope"><Building2 size={15}/> Authorized department scope</span></div>
      {loading ? <LoadingPanel text="Loading department queue…"/> : <IncidentTable rows={data?.incidents ?? []}/>}
      {!!data?.pagination.pages && data.pagination.pages > 1 && <div className="authority-pagination"><span>Page {data.pagination.page} of {data.pagination.pages} · {data.pagination.total} incidents</span><div><button disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={16}/> Previous</button><button disabled={page >= data.pagination.pages} onClick={() => setPage((value) => value + 1)}>Next <ChevronRight size={16}/></button></div></div>}
    </section>
  </Portal>;
}

export function AuthorityIncidentDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const [incident, setIncident] = useState<AuthorityIncident | null>(null);
  const [authorities, setAuthorities] = useState<AuthoritySummary[]>([]);
  const [selectedAuthority, setSelectedAuthority] = useState('');
  const [targetStatus, setTargetStatus] = useState('');
  const [reason, setReason] = useState('');
  const [relatedId, setRelatedId] = useState('');
  const [updateText, setUpdateText] = useState('');
  const [visibility, setVisibility] = useState<'PUBLIC' | 'INTERNAL'>('PUBLIC');
  const [resolutionDescription, setResolutionDescription] = useState('');
  const [workCompleted, setWorkCompleted] = useState('');
  const [resolutionDate, setResolutionDate] = useState(new Date().toISOString().slice(0, 10));
  const [resolutionNotes, setResolutionNotes] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const previews = useMemo(() => files.map((file) => ({ file, url: URL.createObjectURL(file) })), [files]);
  useEffect(() => () => previews.forEach(({ url }) => URL.revokeObjectURL(url)), [previews]);

  const loadIncident = useCallback(async () => {
    if (!id) return;
    const response = await apiRequest<{ incident: AuthorityIncident }>(`/api/authority/incidents/${id}`);
    setIncident(response.incident);
    if (user?.role === 'ADMIN' && response.incident.department?.id) {
      const authorityResponse = await apiRequest<{ authorities: AuthoritySummary[] }>(`/api/authority/authorities?departmentId=${encodeURIComponent(response.incident.department.id)}`);
      setAuthorities(authorityResponse.authorities);
    }
  }, [id, user?.role]);
  useEffect(() => {
    let active = true;
    if (!id) return;
    void Promise.resolve().then(() => active ? loadIncident() : undefined)
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : 'Unable to load incident details'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id, loadIncident]);

  const refresh = async (message: string) => {
    await loadIncident();
    setNotice(message);
    setError('');
  };

  const assignToSelf = async () => {
    if (!id) return;
    setBusy(true); setError(''); setNotice('');
    try { await apiRequest(`/api/authority/incidents/${id}/assign`, { method: 'POST', body: JSON.stringify({}) }); await refresh('Incident assigned to you.'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Assignment failed'); }
    finally { setBusy(false); }
  };

  const setAssignment = async (assignedAuthorityId: string | null) => {
    if (!id) return;
    setBusy(true); setError(''); setNotice('');
    try { await apiRequest(`/api/authority/incidents/${id}/assignment`, { method: 'PATCH', body: JSON.stringify({ assignedAuthorityId }) }); await refresh('Assignment updated.'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Assignment failed'); }
    finally { setBusy(false); }
  };

  const changeStatus = async () => {
    if (!id || !targetStatus) return;
    if (['REJECTED', 'DUPLICATE'].includes(targetStatus) && !window.confirm(`Confirm moving this incident to ${label(targetStatus)}? This action is recorded in its history.`)) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await apiRequest(`/api/authority/incidents/${id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: targetStatus, reason: reason || undefined, relatedIncidentId: relatedId || undefined }),
      });
      setReason(''); setRelatedId(''); setTargetStatus('');
      await refresh(`Status updated to ${label(targetStatus)}.`);
    } catch (reasonValue) { setError(reasonValue instanceof Error ? reasonValue.message : 'Status change failed'); }
    finally { setBusy(false); }
  };

  const addUpdate = async () => {
    if (!id) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await apiRequest(`/api/authority/incidents/${id}/updates`, { method: 'POST', body: JSON.stringify({ text: updateText, visibility }) });
      setUpdateText('');
      await refresh(visibility === 'INTERNAL' ? 'Internal note added.' : 'Operational update published.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to save update'); }
    finally { setBusy(false); }
  };

  const selectEvidence = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files ?? []);
    if (files.length + selected.length > 5) { setError('Attach no more than five images.'); return; }
    if (selected.some((file) => file.size > 5 * 1024 * 1024)) { setError('Each image must be 5 MB or smaller.'); return; }
    if (selected.some((file) => !['image/jpeg', 'image/png', 'image/webp'].includes(file.type))) { setError('Choose JPEG, PNG, or WebP evidence images.'); return; }
    setError('');
    setFiles((current) => [...current, ...selected]);
    event.target.value = '';
  };

  const submitResolution = async () => {
    if (!id) return;
    setBusy(true); setError(''); setNotice('');
    try {
      let imageUrls: string[] = [];
      if (files.length) {
        const formData = new FormData();
        files.forEach((file) => formData.append('images', file));
        const uploaded = await apiRequest<{ files: string[] }>('/api/uploads', { method: 'POST', body: formData });
        imageUrls = uploaded.files;
      }
      await apiRequest(`/api/authority/incidents/${id}/resolution`, {
        method: 'POST',
        body: JSON.stringify({
          description: resolutionDescription,
          workCompleted,
          resolutionDate: resolutionDate || undefined,
          notes: resolutionNotes || undefined,
          imageUrls,
        }),
      });
      setFiles([]); setResolutionDescription(''); setWorkCompleted(''); setResolutionNotes('');
      await refresh('Resolution submitted for verification. It has not been marked resolved.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to submit resolution'); }
    finally { setBusy(false); }
  };

  if (loading) return <Portal><LoadingPanel text="Loading incident operations…"/></Portal>;
  if (error && !incident) return <Portal><PageTitle title="Incident unavailable" subtitle="The incident could not be opened in your authorized department scope."/><ErrorNotice>{error}</ErrorNotice><Link className="button outline" to="/authority/incidents"><ArrowLeft size={16}/> Back to queue</Link></Portal>;
  if (!incident) return <Portal><PageTitle title="Incident unavailable" subtitle="No incident was found."/></Portal>;

  const transitionOptions = incident.allowedTransitions ?? [];
  const needsReason = ['ON_HOLD', 'REJECTED', 'DUPLICATE'].includes(targetStatus);
  const canResolve = incident.status === 'IN_PROGRESS';
  return <Portal>
    <Link className="authority-back" to="/authority/incidents"><ArrowLeft size={16}/> Back to queue</Link>
    <PageTitle eyebrow="INCIDENT OPERATIONS" title={incident.title} subtitle={`${incident.id} · ${incident.department?.name ?? 'Department unavailable'}`}/>
    {error && <ErrorNotice>{error}</ErrorNotice>}
    {notice && <div className="authority-success" role="status"><CheckCircle2 size={17}/>{notice}</div>}
    <div className="authority-detail-layout">
      <div className="authority-detail-main">
        <section className="panel authority-panel">
          <div className="panel-header"><div><span>Incident overview</span><h3>Report details</h3></div><StatusBadge status={incident.status}/></div>
          <p className="authority-description">{incident.description}</p>
          <div className="authority-fact-grid">
            <Fact label="Category" value={`${label(incident.category)}${incident.subcategory ? ` · ${incident.subcategory}` : ''}`}/>
            <Fact label="Severity" value={label(incident.severity)}/>
            <Fact label="Priority" value={<PriorityBadge priority={incident.priorityBand} score={incident.priorityScore}/>}/>
            <Fact label="Reported" value={dateTime(incident.createdAt)}/>
            <Fact label="Last updated" value={dateTime(incident.updatedAt)}/>
            <Fact label="Reporter" value={incident.reporter?.fullName ?? 'Not available'}/>
            <Fact label="Assigned authority" value={incident.assignedAuthority?.fullName ?? 'Unassigned'}/>
            <Fact label="Visibility" value={incident.isPublic ? 'Public report' : 'Private report'}/>
          </div>
        </section>
        <section className="panel authority-panel">
          <div className="panel-header"><div><span>Location coordinates</span><h3>{incident.locationText}</h3></div><MapPin size={18}/></div>
          <MapContainer center={[incident.latitude, incident.longitude]} zoom={15} scrollWheelZoom className="authority-leaflet">
            <TileLayer attribution='&copy; OpenStreetMap contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"/>
            <Marker position={[incident.latitude, incident.longitude]} icon={marker}><Popup>{incident.title}</Popup></Marker>
          </MapContainer>
        </section>
        <section className="panel authority-panel">
          <div className="panel-header"><div><span>Citizen-submitted evidence</span><h3>Report images</h3></div></div>
          {incident.imageUrls.length ? <ImageGallery urls={incident.imageUrls}/> : <div className="authority-inline-empty">No report images were submitted.</div>}
        </section>
        <section className="panel authority-panel">
          <div className="panel-header"><div><span>Model output is advisory</span><h3>AI analysis</h3></div><span className="authority-ai-tag">{incident.aiProvider ?? 'No provider data'}</span></div>
          <div className="authority-ai-grid"><Fact label="Summary" value={incident.aiSummary ?? 'No summary available'}/><Fact label="Suggested classification" value={incident.aiCategory ? `${label(incident.aiCategory)}${incident.aiSubcategory ? ` · ${incident.aiSubcategory}` : ''}` : 'Unavailable'}/><Fact label="Confidence" value={incident.aiConfidence === null ? 'Unavailable' : `${Math.round(incident.aiConfidence * 100)}%`}/></div>
          {incident.aiReasoning && <p className="authority-muted-block">{incident.aiReasoning}</p>}
        </section>
        {(incident.duplicateOf || incident.duplicates.length > 0) && <section className="panel authority-panel">
          <div className="panel-header"><div><span>Suggestions do not merge records</span><h3>Duplicate relationships</h3></div></div>
          {incident.duplicateOf && <p>Linked as duplicate of <Link to={`/authority/incidents/${incident.duplicateOf.id}`}>{incident.duplicateOf.title}</Link> · {incident.duplicateOf.status}</p>}
          {incident.duplicates.map((duplicate) => <p key={duplicate.id}><Link to={`/authority/incidents/${duplicate.id}`}>{duplicate.title}</Link> · {duplicate.status} · {duplicate.id}</p>)}
        </section>}
        <section className="panel authority-panel">
          <div className="panel-header"><div><span>Chronological audit trail</span><h3>Incident activity</h3></div></div>
          <ActivityTimeline activities={incident.activities}/>
        </section>
        {incident.evidence.map((evidence) => <section className="panel authority-panel" key={evidence.id}>
          <div className="panel-header"><div><span>Submitted by {evidence.submittedBy?.fullName ?? 'authority'} · {dateTime(evidence.submittedAt)}</span><h3>Resolution evidence</h3></div><StatusBadge status={evidence.verificationResult ?? 'PENDING'}/></div>
          <p className="authority-description">{evidence.evidenceDescription}</p>
          {evidence.workCompleted && <p><strong>Work completed:</strong> {evidence.workCompleted}</p>}
          {evidence.resolutionDate && <p><strong>Resolution date:</strong> {new Date(evidence.resolutionDate).toLocaleDateString()}</p>}
          {evidence.internalNotes && <p className="authority-internal-text"><strong>Internal notes:</strong> {evidence.internalNotes}</p>}
          <ImageGallery urls={evidence.evidenceImageUrls}/>
        </section>)}
        {incident.verificationCases?.[0]&&<section className="panel authority-panel">
          <div className="panel-header"><div><span>Citizen and independent review</span><h3>Verification status</h3></div><StatusBadge status={incident.verificationCases[0].status}/></div>
          <p>Citizen response deadline: {dateTime(incident.verificationCases[0].responseDeadline)}</p>
          {incident.verificationCases[0].citizenDecision&&<p><strong>Citizen decision:</strong> {label(incident.verificationCases[0].citizenDecision)}</p>}
          {incident.verificationCases[0].actions.filter((action)=>action.actionType==='CITIZEN_DISPUTED'||action.actionType==='CITIZEN_EVIDENCE_SUBMITTED').map((action,index)=><div key={`${action.actionType}-${index}`}>
            {action.reason&&<p><strong>{label(action.actionType)}:</strong> {action.reason}</p>}
            {!!action.evidenceUrls.length&&<ImageGallery urls={action.evidenceUrls}/>}
          </div>)}
          {incident.verificationCases[0].analyses[0]&&<p className="authority-muted-block"><strong>AI advisory ({incident.verificationCases[0].analyses[0].confidence}%):</strong> {incident.verificationCases[0].analyses[0].explanation}</p>}
          {incident.verificationCases[0].status==='DISPUTED'||incident.verificationCases[0].status==='REVIEW_REQUIRED'
            ? <p className="authority-note">Independent review is in progress. Authorities cannot verify their own resolution.</p>
            : <p className="authority-note">A citizen confirmation or independent decision is required; silence does not resolve the incident.</p>}
        </section>}
      </div>
      <aside className="authority-detail-side">
        <section className="panel authority-panel authority-action-panel">
          <div className="panel-header"><div><span>Secure operational action</span><h3>Assignment</h3></div></div>
          {user?.role === 'ADMIN' ? <>
            <select aria-label="Select authority" value={selectedAuthority} onChange={(event) => setSelectedAuthority(event.target.value)}><option value="">Select eligible authority</option>{authorities.map((authority) => <option key={authority.id} value={authority.id} disabled={!authority.active}>{authority.fullName} · {authority.designation}{authority.active ? '' : ' (inactive)'}</option>)}</select>
            <button className="button primary full" disabled={busy || !selectedAuthority} onClick={() => void setAssignment(selectedAuthority)}>Assign selected authority</button>
            {incident.assignedAuthority && <button className="button outline full" disabled={busy} onClick={() => void setAssignment(null)}>Unassign incident</button>}
          </> : <>
            <p>Currently assigned to <strong>{incident.assignedAuthority?.fullName ?? 'No one'}</strong></p>
            <button className="button primary full" disabled={busy || incident.assignedAuthority?.id === user?.id || Boolean(incident.assignedAuthority)} onClick={() => void assignToSelf()}>{incident.assignedAuthority?.id === user?.id ? 'Assigned to you' : incident.assignedAuthority ? 'Assigned to another authority' : 'Assign to myself'}</button>
            {incident.assignedAuthority?.id === user?.id && <button className="button outline full" disabled={busy} onClick={() => void setAssignment(null)}>Unassign from me</button>}
          </>}
        </section>
        <section className="panel authority-panel authority-action-panel">
          <div className="panel-header"><div><span>Validated server-side lifecycle</span><h3>Change status</h3></div></div>
          {transitionOptions.length ? <>
            <label className="authority-field">Next status<select value={targetStatus} onChange={(event) => setTargetStatus(event.target.value)}><option value="">Choose an allowed transition</option>{transitionOptions.map((status) => <option key={status} value={status}>{label(status)}</option>)}</select></label>
            {needsReason && <label className="authority-field">Reason<textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={1000} placeholder="Provide a clear operational reason."/></label>}
            {targetStatus === 'DUPLICATE' && <label className="authority-field">Related incident ID<input value={relatedId} onChange={(event) => setRelatedId(event.target.value)} placeholder="Paste the related incident ID"/></label>}
            <button className="button primary full" disabled={busy || !targetStatus || (needsReason && !reason.trim()) || (targetStatus === 'DUPLICATE' && !relatedId.trim())} onClick={() => void changeStatus()}>Apply status change</button>
          </> : <div className="authority-inline-empty">No direct authority transitions are available for this status.</div>}
          {incident.holdReason && <p className="authority-note"><strong>Hold reason:</strong> {incident.holdReason}</p>}
          {incident.rejectionReason && <p className="authority-note"><strong>Rejection reason:</strong> {incident.rejectionReason}</p>}
        </section>
        <section className="panel authority-panel authority-action-panel">
          <div className="panel-header"><div><span>Public update or confidential note</span><h3>Operational update</h3></div></div>
          <label className="authority-field">Visibility<select value={visibility} onChange={(event) => setVisibility(event.target.value as 'PUBLIC' | 'INTERNAL')}><option value="PUBLIC">Public update</option><option value="INTERNAL">Internal note</option></select></label>
          <label className="authority-field">Update<textarea rows={4} maxLength={2000} value={updateText} onChange={(event) => setUpdateText(event.target.value)} placeholder="Record the inspection, work plan, or operational update."/></label>
          <button className="button primary full" disabled={busy || updateText.trim().length < 3} onClick={() => void addUpdate()}>Save {visibility === 'INTERNAL' ? 'internal note' : 'public update'}</button>
          {visibility === 'INTERNAL' && <small className="authority-private-hint">Only authorized authorities and administrators can view this note.</small>}
        </section>
        {canResolve && <section className="panel authority-panel authority-action-panel">
          <div className="panel-header"><div><span>Independent verification follows</span><h3>Submit resolution</h3></div></div>
          <label className="authority-field">Resolution description<textarea rows={3} maxLength={2000} value={resolutionDescription} onChange={(event) => setResolutionDescription(event.target.value)} placeholder="Describe the reported issue's current outcome."/></label>
          <label className="authority-field">Work completed<textarea rows={3} maxLength={2000} value={workCompleted} onChange={(event) => setWorkCompleted(event.target.value)} placeholder="List the work completed by the department."/></label>
          <label className="authority-field">Resolution date<input type="date" value={resolutionDate} onChange={(event) => setResolutionDate(event.target.value)}/></label>
          <label className="authority-field">Optional internal notes<textarea rows={2} maxLength={2000} value={resolutionNotes} onChange={(event) => setResolutionNotes(event.target.value)} placeholder="Private handoff notes (not shown publicly)."/></label>
          <label className="authority-upload"><ImagePlus size={18}/><span>Add before/after images</span><small>JPEG, PNG, WebP · 5 MB each · up to 5</small><input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={selectEvidence}/></label>
          {previews.length > 0 && <div className="authority-previews">{previews.map(({ file, url }, index) => <div key={url}><img src={url} alt={file.name}/><button type="button" aria-label={`Remove ${file.name}`} onClick={() => setFiles((current) => current.filter((_, position) => position !== index))}><X size={14}/></button></div>)}</div>}
          <button className="button primary full" disabled={busy || resolutionDescription.trim().length < 10 || workCompleted.trim().length < 10} onClick={() => void submitResolution()}>{busy ? 'Submitting…' : 'Submit for verification'}</button>
          <small className="authority-private-hint">Submission moves this report to verification pending. It is not marked resolved automatically.</small>
        </section>}
      </aside>
    </div>
  </Portal>;
}

function Fact({ label: title, value }: { label: string; value: ReactNode }) {
  return <div className="authority-fact"><small>{title}</small><strong>{value}</strong></div>;
}

function ImageGallery({ urls }: { urls: string[] }) {
  if (!urls.length) return null;
  return <div className="authority-gallery">{urls.map((url) => <a href={apiUrl(url)} target="_blank" rel="noreferrer" key={url}><img src={apiUrl(url)} alt="Incident evidence"/></a>)}</div>;
}

function ActivityTimeline({ activities }: { activities: ActivityRecord[] }) {
  if (!activities.length) return <div className="authority-inline-empty">No activity has been recorded.</div>;
  return <ol className="authority-timeline">{activities.map((activity) => <li key={activity.id} className={activity.visibility === 'INTERNAL' ? 'internal' : ''}>
    <span className="authority-timeline-dot"/>
    <div><div className="authority-timeline-head"><strong>{label(activity.activityType)}</strong><time>{dateTime(activity.createdAt)}</time></div>
      <p>{activity.activityDescription}</p><small>{activity.actor?.fullName ?? 'System'}{activity.visibility === 'INTERNAL' && <em>Internal</em>}</small></div>
  </li>)}</ol>;
}

export function AuthorityAnalytics() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const suffix = params.size ? `?${params}` : '';
    void Promise.resolve().then(() => {
      if (!active) return;
      setLoading(true); setError('');
      return apiRequest<AnalyticsResponse>(`/api/authority/analytics${suffix}`);
    }).then((response) => { if (active && response) setData(response); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : 'Unable to load analytics'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [from, to]);

  const metrics = data?.metrics;
  return <Portal><PageTitle title="Department analytics" subtitle="Performance and workload calculated from authorized database records."/>
    <div className="authority-analytics-range"><label>From<input type="date" value={from} onChange={(event) => setFrom(event.target.value)}/></label><label>To<input type="date" value={to} onChange={(event) => setTo(event.target.value)}/></label></div>
    {error && <ErrorNotice>{error}</ErrorNotice>}
    {loading ? <LoadingPanel text="Calculating department metrics…"/> : data && <>
      <div className="authority-kpi-grid authority-analytics-kpis">
        <Metric label="Reports received" value={metrics?.totalReports}/>
        <Metric label="Open incidents" value={metrics?.open}/>
        <Metric label="Resolved" value={metrics?.resolved}/>
        <Metric label="Overdue" value={metrics?.overdue}/>
        <Metric label="Avg. acknowledgment" value={metrics?.averageAcknowledgmentHours === null ? null : `${metrics?.averageAcknowledgmentHours}h`} hint={`${metrics?.acknowledgmentSampleSize ?? 0} samples`}/>
        <Metric label="Avg. resolution" value={metrics?.averageResolutionHours === null ? null : `${metrics?.averageResolutionHours}h`} hint={`${metrics?.resolutionSampleSize ?? 0} samples`}/>
      </div>
      <p className="authority-inline-note">Report counts use creation dates; resolved counts and trend lines use recorded resolution status-change dates. Workload includes all currently non-terminal assigned incidents, independent of the selected date range.</p>
      {metrics?.averageMetricsLimit && <p className="authority-inline-note">Average time metrics use the most recent 20,000 matching reports.</p>}
      <div className="authority-chart-grid">
        <ChartCard title="Weekly reports and outcomes"><ResponsiveContainer width="100%" height={260}><AreaChart data={data.weeklyTrend}><CartesianGrid strokeDasharray="3 3" vertical={false}/><XAxis dataKey="period" tickFormatter={(value: string) => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}/><YAxis allowDecimals={false}/><Tooltip labelFormatter={(value) => new Date(String(value)).toLocaleDateString()}/><Area type="monotone" dataKey="reports" stroke="#10243a" fill="#10243a" fillOpacity=".08"/><Area type="monotone" dataKey="resolved" stroke="#0d9488" fill="#0d9488" fillOpacity=".16"/></AreaChart></ResponsiveContainer></ChartCard>
        <ChartCard title="Monthly incident trend"><ResponsiveContainer width="100%" height={260}><BarChart data={data.monthlyTrend}><CartesianGrid strokeDasharray="3 3" vertical={false}/><XAxis dataKey="period" tickFormatter={(value: string) => new Date(value).toLocaleDateString(undefined, { month: 'short', year: '2-digit' })}/><YAxis allowDecimals={false}/><Tooltip labelFormatter={(value) => new Date(String(value)).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}/><Bar dataKey="reports" fill="#0d9488" radius={[4, 4, 0, 0]}/></BarChart></ResponsiveContainer></ChartCard>
        <ChartCard title="Incidents by status"><ResponsiveContainer width="100%" height={260}><BarChart data={data.byStatus} layout="vertical"><CartesianGrid strokeDasharray="3 3" horizontal={false}/><XAxis type="number" allowDecimals={false}/><YAxis dataKey="status" type="category" width={145} tickFormatter={label}/><Tooltip/><Bar dataKey="count" fill="#10243a" radius={[0, 5, 5, 0]}/></BarChart></ResponsiveContainer></ChartCard>
        <ChartCard title="Category distribution"><ResponsiveContainer width="100%" height={260}><PieChart><Pie data={data.byCategory} dataKey="count" nameKey="category" innerRadius={55} outerRadius={88} paddingAngle={3}>{data.byCategory.map((row) => <Cell key={row.category} fill={categoryColors[row.category as Category] ?? '#64748b'}/>)}</Pie><Tooltip formatter={(value) => [value, 'Reports']} labelFormatter={(value) => label(String(value))}/></PieChart></ResponsiveContainer></ChartCard>
        <ChartCard title="Workload by authority"><div className="authority-load-list">{data.authorityWorkload.length ? data.authorityWorkload.map((row) => <div key={row.authorityId}><span><strong>{row.name}</strong><small>{row.active ? 'Active' : 'Inactive'}</small></span><b>{row.assignedIncidents}</b></div>) : <div className="authority-inline-empty">No authorities in this department scope.</div>}</div></ChartCard>
        <ChartCard title="Incidents by priority"><ResponsiveContainer width="100%" height={260}><BarChart data={data.byPriority}><CartesianGrid strokeDasharray="3 3" vertical={false}/><XAxis dataKey="priorityBand"/><YAxis allowDecimals={false}/><Tooltip/><Bar dataKey="count" fill="#d97706" radius={[5, 5, 0, 0]}/></BarChart></ResponsiveContainer></ChartCard>
      </div>
      {!data.metrics.totalReports && <div className="authority-inline-note">No incident data is available for this date range.</div>}
    </>}
  </Portal>;
}

function Metric({ label: title, value, hint }: { label: string; value: string | number | null | undefined; hint?: string }) {
  return <div className="authority-kpi authority-metric"><span>{title}</span><strong>{value === null || value === undefined ? '—' : value}</strong><small>{hint ?? (value === null || value === undefined ? 'Insufficient data' : 'Live database')}</small></div>;
}

function ChartCard({ title, children }: { title: string; children: ReactNode }) {
  return <section className="chart-card authority-chart-card"><div className="chart-title"><div><span>Department operations</span><h3>{title}</h3></div></div>{children}</section>;
}

export function AuthorityProfilePage() {
  const { user } = useAuth();
  const [profile, setProfile] = useState<{ designation: string; employeeIdentifier: string; department: { name: string; code: string; status: string } } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void apiRequest<{ profile: typeof profile }>('/api/authority/profile')
      .then((response) => { if (active) setProfile(response.profile); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : 'Unable to load profile'); });
    return () => { active = false; };
  }, []);
  return <Portal><PageTitle title="Authority profile" subtitle="Your assigned operational role and department."/>
    {error && <ErrorNotice>{error}</ErrorNotice>}
    <section className="panel authority-profile-card"><span className="authority-profile-avatar">{user?.fullName.split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase()}</span><div><h2>{user?.fullName}</h2><p>{user?.email}</p><StatusBadge status={user?.role ?? 'AUTHORITY'}/></div>
      {profile && <div className="authority-profile-details"><Fact label="Designation" value={profile.designation}/><Fact label="Employee identifier" value={profile.employeeIdentifier}/><Fact label="Department" value={`${profile.department.name} (${profile.department.code})`}/><Fact label="Department status" value={label(profile.department.status)}/></div>}
      {user?.role === 'ADMIN' && <p className="authority-inline-note">Administrator access can operate across departments under the existing admin role.</p>}
    </section>
  </Portal>;
}
