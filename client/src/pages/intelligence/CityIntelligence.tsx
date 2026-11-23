import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, BarChart3, Lightbulb, RefreshCw, Sparkles } from 'lucide-react';
import { Circle, MapContainer, Popup, TileLayer } from 'react-leaflet';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { apiRequest } from '../../services/api';
import './intelligence.css';

type Period = '7d' | '30d' | '90d' | '6m' | '12m' | 'custom';
type Category = 'ROAD' | 'WASTE' | 'WATER' | 'DRAINAGE' | 'ELECTRICITY' | 'PUBLIC_SPACE' | 'OTHER';

interface Hotspot {
  id: string;
  latitude: number;
  longitude: number;
  incidentCount: number;
  dominantCategory: Category;
  categoryCounts?: Record<string, number>;
  severityDistribution?: Record<string, number>;
  trend?: Array<{ period: string; incidents: number }>;
  repeatedIssueCount?: number;
  reopenedIncidents?: number;
  verifiedResolutions?: number;
  disputedResolutions?: number;
  unresolvedIncidents?: number;
  overdueIncidents?: number;
  department?: { id: string; name: string } | null;
  departmentName?: string | null;
  intensity: number;
  riskScore: number;
  riskLevel: string;
  riskExplanation?: string;
  detectedAt?: string;
  incidentIds?: string[];
}

interface Recurrence {
  id: string;
  category: Category;
  latitude?: number;
  longitude?: number;
  approximateLatitude?: number;
  approximateLongitude?: number;
  incidentCount: number;
  independentReports?: number;
  duplicateReports?: number;
  reopenedIncidents: number;
  disputedResolutions?: number;
  verifiedResolutions?: number;
  averageRecurrenceDays: number | null;
  recurrenceIntervalsDays?: number[];
  departments?: Array<{ id: string; name: string }>;
  incidentIds?: string[];
}

interface IntelligenceData {
  period: { from: string; to: string };
  metrics: {
    totalReported: number;
    open: number;
    resolved: number;
    verifiedResolutions: number;
    disputedResolutions: number;
    reopenedIncidents: number;
    overdueUnresolved: number;
    verificationSuccessRate: number | null;
    recurringIssueCount: number;
    emergingHotspotCount: number;
    sampleSize: number;
  };
  byCategory: Record<string, number>;
  bySeverity?: Record<string, number>;
  byStatus?: Record<string, number>;
  monthlyTrend: Array<{ period: string; incidents: number }>;
  resolutionTrend: Array<{ period: string; count: number }>;
  hotspots: Hotspot[];
  recurrences: Recurrence[];
  comparisons: {
    currentReports: number;
    previousReports: number;
    reportChangePercent: number | null;
    reportChangeDescription: string | null;
    categoryTrends: Array<{ category: string; current: number; previous: number; changePercent: number | null; trend: string; comparison: string | null }>;
    reopenedChange?: number;
    disputeChange?: number;
    departmentWorkload?: Array<{ departmentId: string; departmentName: string; currentOpen: number; previousOpen: number; currentResolved: number; previousResolved: number }>;
  };
  byDepartment?: Array<{ departmentId: string; departmentName: string; total: number; open: number; overdue: number; resolved: number; reopened: number; disputed: number; verified: number }>;
  dataLimitations: string[];
  dataQuality: { totalIncidentsInRange?: number; incidentsAnalyzed: number; truncated: boolean; resolutionTrendTruncated?: boolean; invalidCoordinateCount?: number };
  methodology?: { overdueHours: number };
}

interface Recommendation {
  id: string;
  title: string;
  description: string;
  areaLabel: string;
  latitude: number;
  longitude: number;
  category: Category | null;
  riskScore: number;
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  status: 'PENDING' | 'ACCEPTED' | 'DISMISSED' | 'IN_PROGRESS' | 'COMPLETED';
  supportingMetrics: Record<string, number | string>;
  recommendedAction: string;
  dismissalReason: string | null;
  actionSummary: string | null;
  generatedAt: string;
  responsibleDepartmentId: string | null;
  responsibleDepartment: { id: string; name: string; code: string } | null;
  history: Array<{ id: string; action: string; reason: string | null; createdAt: string; actor: { fullName: string; role: string } | null }>;
}

interface Department { id: string; name: string; status: string }
interface CityNarrative {
  citySummary: string;
  emergingPatterns: string[];
  areasRequiringAttention: string[];
  recommendedActions: string[];
  dataLimitations: string[];
}

const categoryColors: Record<string, string> = {
  ROAD: '#d97706', WASTE: '#64748b', WATER: '#0284c7', DRAINAGE: '#2563eb',
  ELECTRICITY: '#ca8a04', PUBLIC_SPACE: '#059669', OTHER: '#7c3aed',
};
const severityColors: Record<string, string> = { LOW: '#0d9488', MEDIUM: '#d97706', HIGH: '#ea580c', CRITICAL: '#dc2626' };
const periods: Array<{ value: Period; label: string }> = [
  { value: '7d', label: 'Last 7 days' }, { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' }, { value: '6m', label: 'Last 6 months' },
  { value: '12m', label: 'Last 12 months' }, { value: 'custom', label: 'Custom range' },
];

function label(value: string) {
  return value.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function useQueryString(period: Period, from: string, to: string, departmentId: string, category: string, severity: string) {
  return useMemo(() => {
    const params = new URLSearchParams({ period });
    if (period === 'custom') {
      if (from) params.set('from', from);
      if (to) params.set('to', to);
    }
    if (departmentId && departmentId !== 'ALL') params.set('departmentId', departmentId);
    if (category !== 'ALL') params.set('category', category);
    if (severity !== 'ALL') params.set('severity', severity);
    return params.toString();
  }, [period, from, to, departmentId, category, severity]);
}

function EmptyChart({ text }: { text: string }) {
  return <div className="intelligence-empty-chart"><BarChart3 size={24}/><span>{text}</span></div>;
}

function RiskMap({ hotspots, publicView, selectedId, onSelect }: { hotspots: Hotspot[]; publicView: boolean; selectedId: string; onSelect: (id: string) => void }) {
  const center: [number, number] = hotspots.length ? [hotspots[0].latitude, hotspots[0].longitude] : [0, 0];
  return <div className="intelligence-map">
    {hotspots.length ? <MapContainer center={center} zoom={hotspots.length === 1 ? 12 : 10} scrollWheelZoom className="leaflet-map">
      <TileLayer attribution='&copy; OpenStreetMap contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"/>
      {hotspots.map((hotspot) => {
        const color = hotspot.riskLevel === 'CRITICAL' ? '#dc2626' : hotspot.riskLevel === 'HIGH' ? '#ea580c' : hotspot.riskLevel === 'MODERATE' ? '#d97706' : '#0d9488';
        return <Circle key={hotspot.id} center={[hotspot.latitude, hotspot.longitude]} radius={Math.max(180, Math.min(900, hotspot.incidentCount * 75))} pathOptions={{ color, fillColor: color, fillOpacity: 0.18, weight: selectedId === hotspot.id ? 4 : 2 }} eventHandlers={{ click: () => onSelect(hotspot.id) }}>
          <Popup><strong>{label(hotspot.riskLevel)} risk · {hotspot.incidentCount} reports</strong><br/>{label(hotspot.dominantCategory)} · score {hotspot.riskScore}/100<br/>{publicView ? 'Approximate location' : hotspot.department?.name || 'Department not assigned'}</Popup>
        </Circle>;
      })}
    </MapContainer> : <EmptyChart text="No areas meet the minimum report threshold for a hotspot."/>}
  </div>;
}

function RecommendationPanel({ publicView, recommendations, departments, onRefresh, onGenerate }: {
  publicView: boolean;
  recommendations: Recommendation[];
  departments: Department[];
  onRefresh: () => void;
  onGenerate: () => void;
}) {
  const { user } = useAuth();
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [reasonById, setReasonById] = useState<Record<string, string>>({});
  const [actionById, setActionById] = useState<Record<string, string>>({});
  const [assignById, setAssignById] = useState<Record<string, string>>({});
  if (publicView) return null;

  const update = async (item: Recommendation, status?: Recommendation['status']) => {
    setError('');
    if (status === 'DISMISSED' && (reasonById[item.id] ?? '').trim().length < 10) {
      setError('Dismissal requires a reason of at least 10 characters.');
      return;
    }
    if (status === 'COMPLETED' && (actionById[item.id] ?? '').trim().length < 10) {
      setError('Completion requires an action summary of at least 10 characters.');
      return;
    }
    const responsibleDepartmentId = assignById[item.id];
    setBusyId(item.id);
    try {
      await apiRequest(`/api/intelligence/recommendations/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          ...(status ? { status } : {}),
          ...(status === 'DISMISSED' ? { reason: reasonById[item.id] } : {}),
          ...(status === 'COMPLETED' ? { actionSummary: actionById[item.id] } : {}),
          ...(user?.role === 'ADMIN' && responsibleDepartmentId !== undefined ? { responsibleDepartmentId: responsibleDepartmentId || null } : {}),
        }),
      });
      onRefresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to update the recommendation');
    } finally {
      setBusyId('');
    }
  };

  const nextStatus: Partial<Record<Recommendation['status'], Array<{ status: Recommendation['status']; label: string }>>> = {
    PENDING: [{ status: 'ACCEPTED', label: 'Accept' }, { status: 'DISMISSED', label: 'Dismiss' }],
    ACCEPTED: [{ status: 'IN_PROGRESS', label: 'Start work' }, { status: 'DISMISSED', label: 'Dismiss' }],
    IN_PROGRESS: [{ status: 'COMPLETED', label: 'Complete' }, { status: 'DISMISSED', label: 'Dismiss' }],
  };
  return <section className="chart-card intelligence-recommendations">
    <div className="chart-title"><div><span>Proactive actions · not citizen incidents</span><h3>Recommendations</h3></div>{user?.role === 'ADMIN'&&<button type="button" className="button outline" onClick={onGenerate}><RefreshCw size={15}/> Generate from latest 90 days</button>}</div>
    {error&&<div className="auth-notice" role="alert">{error}</div>}
    {!recommendations.length ? <EmptyChart text={user?.role === 'ADMIN' ? 'No data-supported recommendations yet. Refresh after enough reports are available.' : 'No recommendations are assigned to your department.'}/> : <div className="intelligence-recommendation-list">
      {recommendations.map((item) => <article key={item.id} className="intelligence-recommendation">
        <div className="intelligence-recommendation-top"><span className={`recommendation-priority ${item.priority.toLowerCase()}`}>{item.priority}</span><span className={`recommendation-status ${item.status.toLowerCase()}`}>{label(item.status)}</span><strong>{item.riskScore}/100</strong></div>
        <h4>{item.title}</h4><p>{item.description}</p>
        <div className="intelligence-supporting"><strong>{item.areaLabel}</strong><span>{item.category ? label(item.category) : 'Multiple categories'} · {item.responsibleDepartment?.name || 'Department not assigned'}</span><small>{item.supportingMetrics.incidentCount ?? 0} reports · {item.supportingMetrics.repeatedIssueCount ?? 0} recurring groups · {item.supportingMetrics.overdueIncidents ?? 0} overdue</small></div>
        <div className="intelligence-recommendation-action"><Lightbulb size={17}/><span>{item.recommendedAction}</span></div>
        {user?.role === 'ADMIN'&&item.status!=='COMPLETED'&&item.status!=='DISMISSED'&&<label className="intelligence-assignment">Assign to department
          <select value={assignById[item.id] ?? item.responsibleDepartmentId ?? ''} onChange={(event)=>setAssignById((current)=>({...current,[item.id]:event.target.value}))}><option value="">Unassigned</option>{departments.filter((department)=>department.status==='ACTIVE').map((department)=><option key={department.id} value={department.id}>{department.name}</option>)}</select>
          <button type="button" className="button outline" disabled={busyId===item.id||assignById[item.id]===undefined||assignById[item.id]===item.responsibleDepartmentId} onClick={()=>void update(item)}>{busyId===item.id?'Saving…':'Assign'}</button>
        </label>}
        {item.status!=='COMPLETED'&&item.status!=='DISMISSED'&&<div className="intelligence-recommendation-manage">
          {nextStatus[item.status]?.map((action)=><div key={action.status} className="intelligence-status-action">
            {action.status==='DISMISSED'&&<input aria-label="Dismissal reason" value={reasonById[item.id]??''} onChange={(event)=>setReasonById((current)=>({...current,[item.id]:event.target.value}))} placeholder="Why dismiss this recommendation?"/>}
            {action.status==='COMPLETED'&&<input aria-label="Completion action summary" value={actionById[item.id]??''} onChange={(event)=>setActionById((current)=>({...current,[item.id]:event.target.value}))} placeholder="Summarize the completed action"/>}
            <button type="button" className={action.status==='DISMISSED'?'button outline':'button primary'} disabled={busyId===item.id} onClick={()=>void update(item,action.status)}>{busyId===item.id?'Saving…':action.label}</button>
          </div>)}
        </div>}
        <details><summary>Recommendation audit history ({item.history.length})</summary><ul>{item.history.map((entry)=><li key={entry.id}>{label(entry.action)} · {new Date(entry.createdAt).toLocaleString()}{entry.actor?` · ${entry.actor.fullName}`:''}{entry.reason?` · ${entry.reason}`:''}</li>)}</ul></details>
      </article>)}
    </div>}
  </section>;
}

export function CityIntelligenceDashboard({ publicView = false }: { publicView?: boolean }) {
  const { user } = useAuth();
  const [period, setPeriod] = useState<Period>('30d');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [departmentId, setDepartmentId] = useState('ALL');
  const [category, setCategory] = useState('ALL');
  const [severity, setSeverity] = useState('ALL');
  const [data, setData] = useState<IntelligenceData | null>(null);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [narrative, setNarrative] = useState<(CityNarrative & { provider: string; query: string }) | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [narrativeBusy, setNarrativeBusy] = useState(false);
  const [narrativeError, setNarrativeError] = useState('');
  const [selectedHotspotId, setSelectedHotspotId] = useState('');
  const query = useQueryString(period, from, to, departmentId, category, severity);
  const incompleteCustomRange = period === 'custom' && (!from || !to);
  const selectedHotspot = data?.hotspots.find((hotspot) => hotspot.id === selectedHotspotId) ?? data?.hotspots[0] ?? null;

  useEffect(() => {
    let active = true;
    if (incompleteCustomRange) return () => { active = false; };
    const path = publicView ? `/api/intelligence/public?${query}` : `/api/intelligence/overview?${query}`;
    void Promise.resolve().then(() => {
      if (!active) return undefined;
      setLoading(true);
      setData(null);
      setError('');
      return apiRequest<{ intelligence: IntelligenceData; methodology?: IntelligenceData['methodology'] }>(path);
    }).then((response) => { if (active && response) setData({ ...response.intelligence, methodology: response.methodology }); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : 'Unable to load intelligence'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [publicView, query, refreshKey, incompleteCustomRange]);

  useEffect(() => {
    if (publicView || !user || (user.role !== 'ADMIN' && user.role !== 'AUTHORITY')) return;
    let active = true;
    const recommendationsQuery = new URLSearchParams({ limit: '50' });
    if (user.role === 'AUTHORITY' && departmentId !== 'ALL') recommendationsQuery.set('departmentId', departmentId);
    if (departmentId !== 'ALL') recommendationsQuery.set('departmentId', departmentId);
    void apiRequest<{ recommendations: Recommendation[] }>(`/api/intelligence/recommendations?${recommendationsQuery}`)
      .then((result) => { if (active) setRecommendations(result.recommendations); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : 'Unable to load recommendations'); });
    if (user.role === 'ADMIN') {
      void apiRequest<{ departments: Department[] }>('/api/admin/departments')
        .then((result) => { if (active) setDepartments(result.departments); })
        .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : 'Unable to load departments'); });
    }
    return () => { active = false; };
  }, [publicView, user, departmentId, refreshKey]);

  const refreshRecommendations = async () => {
    setError('');
    try {
      await apiRequest('/api/intelligence/recommendations/refresh', {
        method: 'POST',
        body: JSON.stringify(departmentId === 'ALL' ? {} : { departmentId }),
      });
      setRefreshKey((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to generate recommendations');
    }
  };

  const requestNarrative = async () => {
    setNarrativeBusy(true);
    setNarrativeError('');
    try {
      const filters: Record<string, string> = {};
      new URLSearchParams(query).forEach((value, key) => { filters[key] = value; });
      const result = await apiRequest<{ narrative: CityNarrative; provider: string }>('/api/intelligence/summary', {
        method: 'POST', body: JSON.stringify(filters),
      });
      setNarrative({ ...result.narrative, provider: result.provider, query });
    } catch (reason) {
      setNarrativeError(reason instanceof Error ? reason.message : 'AI summary is unavailable');
    } finally {
      setNarrativeBusy(false);
    }
  };

  const categoryData = data ? Object.entries(data.byCategory ?? {}).map(([name, value]) => ({ name: label(name), value, key: name, fill: categoryColors[name] })) : [];
  const severityData = data ? Object.entries(data.bySeverity ?? {}).map(([name, value]) => ({ name: label(name), value, key: name, fill: severityColors[name] ?? '#64748b' })) : [];
  const selectedDepartment = departments.find((department) => department.id === departmentId);
  const title = publicView ? 'City insights' : user?.role === 'AUTHORITY' ? 'Department intelligence' : 'City intelligence';
  const description = publicView
    ? 'Aggregated, privacy-safe trends and approximate issue hotspots from public reports.'
    : 'Data-derived reporting trends, recurring issues, service risk, and practical recommendations.';

  return <div className={`page-shell city-intelligence-page ${publicView ? 'public-intelligence' : ''}`}>
    <div className="page-header"><div><span>{publicView ? 'Public transparency' : 'Urban operations intelligence'}</span><h1>{title}</h1><p>{description}</p></div>
      {publicView&&<Link className="button outline" to="/transparency">Transparency dashboard</Link>}
    </div>
    <div className="intelligence-filter-bar">
      <label>Reporting period<select value={period} onChange={(event)=>setPeriod(event.target.value as Period)}>{periods.map((option)=><option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      {period==='custom'&&<><label>From<input type="date" value={from} onChange={(event)=>setFrom(event.target.value)}/></label><label>To<input type="date" value={to} onChange={(event)=>setTo(event.target.value)}/></label></>}
      {!publicView&&user?.role==='ADMIN'&&<label>Department<select value={departmentId} onChange={(event)=>setDepartmentId(event.target.value)}><option value="ALL">All departments</option>{departments.filter((item)=>item.status==='ACTIVE').map((item)=><option value={item.id} key={item.id}>{item.name}</option>)}</select></label>}
      <label>Category<select value={category} onChange={(event)=>setCategory(event.target.value)}><option value="ALL">All categories</option>{Object.keys(categoryColors).map((value)=><option key={value} value={value}>{label(value)}</option>)}</select></label>
      <label>Severity<select value={severity} onChange={(event)=>setSeverity(event.target.value)}><option value="ALL">All severities</option>{Object.keys(severityColors).map((value)=><option key={value} value={value}>{label(value)}</option>)}</select></label>
      <button className="button outline intelligence-refresh" type="button" onClick={()=>setRefreshKey((value)=>value+1)}><RefreshCw size={16}/> Refresh</button>
    </div>
    {error&&<div className="auth-notice" role="alert">{error}</div>}
    {incompleteCustomRange ? <div className="empty-state"><AlertTriangle/><h3>Choose a date range</h3><p>Select both a start and end date to view custom-range intelligence.</p></div>
      : loading&&!data ? <div className="intelligence-loading"><span/>Loading city intelligence…</div>
      : error&&!data ? <div className="empty-state"><AlertTriangle/><h3>Intelligence unavailable</h3><p>{error}</p></div>
        : data&&<>
          {data.dataQuality.truncated&&<div className="intelligence-notice warning"><AlertTriangle size={17}/>{publicView?'The report analysis limit was reached; public trend and cluster metrics may be incomplete.':`Only the latest ${data.dataQuality.incidentsAnalyzed.toLocaleString()} of ${(data.dataQuality.totalIncidentsInRange??0).toLocaleString()} reports were analyzed. Cluster metrics may be incomplete.`}</div>}
          {data.dataQuality.invalidCoordinateCount>0&&<div className="intelligence-notice warning">{data.dataQuality.invalidCoordinateCount} incident records have invalid geographic coordinates and were excluded.</div>}
          <div className="intelligence-kpi-grid">
            <article><span>Total reported</span><strong>{data.metrics.totalReported.toLocaleString()}</strong><small>{data.comparisons.reportChangePercent===null?data.comparisons.reportChangeDescription||'No previous-period baseline':`${data.comparisons.reportChangePercent>0?'+':''}${data.comparisons.reportChangePercent}% vs prior period`}</small></article>
            <article><span>Open incidents</span><strong>{data.metrics.open.toLocaleString()}</strong><small>Current selected period</small></article>
            <article><span>Verified resolutions</span><strong>{data.metrics.verifiedResolutions.toLocaleString()}</strong><small>{data.metrics.verificationSuccessRate===null?'Insufficient final decisions':`${data.metrics.verificationSuccessRate}% of verified/reopened final outcomes`}</small></article>
            <article><span>Disputed resolutions</span><strong>{data.metrics.disputedResolutions.toLocaleString()}</strong><small>Cases reported disputed or under review</small></article>
            <article><span>Reopened issues</span><strong>{data.metrics.reopenedIncidents.toLocaleString()}</strong><small>{data.comparisons.reopenedChange===undefined?'Public aggregate':`${data.comparisons.reopenedChange>0?'+':''}${data.comparisons.reopenedChange} vs prior period`}</small></article>
            <article><span>Overdue unresolved</span><strong>{data.metrics.overdueUnresolved.toLocaleString()}</strong><small>{data.methodology?`Configured threshold: ${data.methodology.overdueHours}h`:'Public aggregate'}</small></article>
            <article><span>Recurring issue groups</span><strong>{data.metrics.recurringIssueCount.toLocaleString()}</strong><small>Same category and nearby within configured time window</small></article>
            <article><span>Emerging hotspots</span><strong>{data.metrics.emergingHotspotCount.toLocaleString()}</strong><small>Areas meeting report-density threshold</small></article>
          </div>
          {!publicView&&<div className="intelligence-ai-summary">
            <div><Sparkles/><span><strong>Optional AI situation summary</strong><small>Uses aggregated metrics only. Human judgment remains necessary.</small></span></div>
            <button type="button" className="button outline" disabled={narrativeBusy||period==='custom'&&(!from||!to)} onClick={requestNarrative}>{narrativeBusy?'Summarizing…':'Generate summary'}</button>
            {narrativeError&&<p role="alert">{narrativeError}</p>}
            {narrative&&narrative.query===query&&<section><strong>{narrative.citySummary}</strong><small>Provider: {narrative.provider} · Advisory narrative generated from the selected filters.</small>
              {!!narrative.emergingPatterns.length&&<div><h4>Observed patterns</h4><ul>{narrative.emergingPatterns.map((item)=><li key={item}>{item}</li>)}</ul></div>}
              {!!narrative.areasRequiringAttention.length&&<div><h4>Areas requiring attention</h4><ul>{narrative.areasRequiringAttention.map((item)=><li key={item}>{item}</li>)}</ul></div>}
              {!!narrative.recommendedActions.length&&<div><h4>Suggested actions</h4><ul>{narrative.recommendedActions.map((item)=><li key={item}>{item}</li>)}</ul></div>}
              {!!narrative.dataLimitations.length&&<div><h4>Limitations</h4><ul>{narrative.dataLimitations.map((item)=><li key={item}>{item}</li>)}</ul></div>}
            </section>}
          </div>}
          <div className="intelligence-chart-grid">
            <section className="chart-card"><div className="chart-title"><div><span>Current period · {data.dataQuality.incidentsAnalyzed} analyzed</span><h3>Incident reporting trend</h3></div></div>{data.monthlyTrend.length?<ResponsiveContainer width="100%" height={260}><AreaChart data={data.monthlyTrend}><CartesianGrid strokeDasharray="3 3" vertical={false}/><XAxis dataKey="period"/><YAxis allowDecimals={false}/><Tooltip/><Area type="monotone" dataKey="incidents" name="Reports" stroke="#0d9488" fill="#0d9488" fillOpacity=".15"/></AreaChart></ResponsiveContainer>:<EmptyChart text="No incident reports in this period."/>}</section>
            <section className="chart-card"><div className="chart-title"><div><span>Resolution status-change date · selected period</span><h3>Resolution trend</h3></div></div>{data.resolutionTrend.length?<ResponsiveContainer width="100%" height={260}><AreaChart data={data.resolutionTrend}><CartesianGrid strokeDasharray="3 3" vertical={false}/><XAxis dataKey="period"/><YAxis allowDecimals={false}/><Tooltip/><Area type="monotone" dataKey="count" name="Resolved" stroke="#2563eb" fill="#2563eb" fillOpacity=".13"/></AreaChart></ResponsiveContainer>:<EmptyChart text="No resolution events in this period."/>}{data.dataQuality.resolutionTrendTruncated&&<p className="intelligence-caption">Resolution events are capped at 5,000 records for this period.</p>}</section>
            <section className="chart-card"><div className="chart-title"><div><span>Actual report counts</span><h3>Category distribution</h3></div></div>{categoryData.some((item)=>item.value>0)?<ResponsiveContainer width="100%" height={260}><PieChart><Pie data={categoryData.filter((item)=>item.value>0)} dataKey="value" nameKey="name" innerRadius={58} outerRadius={92} paddingAngle={3}>{categoryData.filter((item)=>item.value>0).map((item)=><Cell key={item.key} fill={item.fill}/>)}</Pie><Tooltip/></PieChart></ResponsiveContainer>:<EmptyChart text="No category data for the selected filters."/>}</section>
            {!publicView&&<section className="chart-card"><div className="chart-title"><div><span>Incident severity</span><h3>Severity distribution</h3></div></div>{severityData.some((item)=>item.value>0)?<ResponsiveContainer width="100%" height={260}><BarChart data={severityData}><CartesianGrid strokeDasharray="3 3" vertical={false}/><XAxis dataKey="name"/><YAxis allowDecimals={false}/><Tooltip/><Bar dataKey="value" name="Reports" radius={[5,5,0,0]}>{severityData.map((item)=><Cell key={item.key} fill={item.fill}/>)}</Bar></BarChart></ResponsiveContainer>:<EmptyChart text="No severity data for the selected filters."/>}</section>}
          </div>
          <section className="chart-card intelligence-wide"><div className="chart-title"><div><span>Aggregated incident coordinates</span><h3>{publicView?'Public issue hotspots':'Geographic risk and hotspot map'}</h3></div></div>
            <p className="intelligence-caption">{publicView?'Hotspots require at least 5 public reports. Locations are approximate and rounded; individual incidents are not shown.':'Deterministic proximity clusters; click a circle to inspect its aggregated details.'}</p>
            <div className="intelligence-map-layout"><RiskMap hotspots={data.hotspots} publicView={publicView} selectedId={selectedHotspot?.id||''} onSelect={setSelectedHotspotId}/>
              <aside className="intelligence-hotspot-panel">{selectedHotspot?<><span className={`risk-level ${selectedHotspot.riskLevel.toLowerCase()}`}>{label(selectedHotspot.riskLevel)} risk · {selectedHotspot.riskScore}/100</span><h3>{label(selectedHotspot.dominantCategory)} hotspot</h3><strong>{selectedHotspot.incidentCount} nearby reports</strong><p>{selectedHotspot.riskExplanation??'This approximate area groups public reports; co-location does not establish cause.'}</p><div className="hotspot-facts">{selectedHotspot.repeatedIssueCount!==undefined&&<span>Repeated issue groups <b>{selectedHotspot.repeatedIssueCount}</b></span>}<span>Reopened <b>{selectedHotspot.reopenedIncidents??0}</b></span>{!publicView&&<><span>Disputed <b>{selectedHotspot.disputedResolutions??0}</b></span><span>Verified <b>{selectedHotspot.verifiedResolutions??0}</b></span><span>Unresolved <b>{selectedHotspot.unresolvedIncidents??0}</b></span><span>Overdue <b>{selectedHotspot.overdueIncidents??0}</b></span></>}</div>
                {!publicView&&!!selectedHotspot.incidentIds?.length&&<div className="hotspot-drilldown"><strong>Incident drill-down</strong>{selectedHotspot.incidentIds.slice(0,8).map((id)=><Link key={id} to={`/authority/incidents/${id}`}>{id}<ArrowRight size={14}/></Link>)}</div>}
              </>:<EmptyChart text="No hotspot qualifies at the configured minimum."/>}
              <div className="hotspot-list"><h4>Detected areas</h4>{data.hotspots.map((hotspot)=><button type="button" key={hotspot.id} className={hotspot.id===selectedHotspot?.id?'active':''} onClick={()=>setSelectedHotspotId(hotspot.id)}><span>{label(hotspot.riskLevel)}</span><strong>{hotspot.incidentCount} reports</strong><small>{label(hotspot.dominantCategory)}</small></button>)}</div>
            </aside>
            </div>
          </section>
          <div className="intelligence-chart-grid">
            <section className="chart-card intelligence-wide"><div className="chart-title"><div><span>Current vs previous comparable period</span><h3>Category trend comparison</h3></div></div>{data.comparisons.categoryTrends.some((item)=>item.current||item.previous)?<div className="intelligence-trend-table"><table><thead><tr><th>Category</th><th>Current</th><th>Previous</th><th>Change</th><th>Direction</th></tr></thead><tbody>{data.comparisons.categoryTrends.filter((item)=>item.current||item.previous).map((item)=><tr key={item.category}><td>{label(item.category)}</td><td>{item.current}</td><td>{item.previous}</td><td>{item.changePercent===null?item.comparison||'—':`${item.changePercent>0?'+':''}${item.changePercent}%`}</td><td>{label(item.trend)}</td></tr>)}</tbody></table></div>:<EmptyChart text="There are no reports in either comparison period."/>}</section>
            {!publicView&&<section className="chart-card intelligence-wide"><div className="chart-title"><div><span>Workload · current open vs previous open</span><h3>Department workload</h3></div></div>{data.comparisons.departmentWorkload?.length?<ResponsiveContainer width="100%" height={280}><BarChart data={data.comparisons.departmentWorkload}><CartesianGrid strokeDasharray="3 3" vertical={false}/><XAxis dataKey="departmentName" interval={0} angle={-15} textAnchor="end" height={65}/><YAxis allowDecimals={false}/><Tooltip/><Bar dataKey="currentOpen" name="Open now" fill="#0d9488"/><Bar dataKey="previousOpen" name="Open previous period" fill="#94a3b8"/></BarChart></ResponsiveContainer>:<EmptyChart text="No department-assigned incident workload in this period."/>}</section>}
            <section className="chart-card intelligence-wide"><div className="chart-title"><div><span>{data.recurrences.length} detected groups</span><h3>Recurring issue analysis</h3></div></div>{data.recurrences.length?<div className="intelligence-recurrence-grid">{data.recurrences.map((item)=><article key={item.id}><span>{label(item.category)}</span><strong>{item.incidentCount} related reports</strong><small>{item.independentReports??item.incidentCount} distinct reports · {item.duplicateReports??0} confirmed duplicate links</small><small>{item.averageRecurrenceDays===null?'No recurrence interval':'Average interval: '+item.averageRecurrenceDays+' days'}</small><small>{item.reopenedIncidents} reopened · {item.disputedResolutions??0} disputed · {item.verifiedResolutions??0} verified</small><small>{item.departments?.map((department)=>department.name).join(', ')||'Department not assigned'}</small>{!publicView&&item.incidentIds?.map((id)=><Link to={`/authority/incidents/${id}`} key={id}>{id}</Link>)}</article>)}</div>:<EmptyChart text="No same-category issue groups meet the recurrence rules."/>}</section>
          </div>
          {!publicView&&<RecommendationPanel publicView={false} recommendations={recommendations} departments={departments} onRefresh={()=>setRefreshKey((value)=>value+1)} onGenerate={()=>void refreshRecommendations()}/>}
          {publicView&&<section className="chart-card intelligence-limitations"><h3>How to interpret these insights</h3><p>These are summaries of submitted reports, not a census of all city conditions or proof of causation. Hotspot locations are approximate and categories can be affected by reporting access and data quality.</p></section>}
          <details className="intelligence-methodology"><summary>Methodology and data limitations</summary>
            {!publicView&&<p><strong>Civic Risk Index (0–100):</strong> density 30%, severity 25%, recurrence 20%, overdue unresolved reports 15%, and disputes/reopenings 10%. Components are normalized and capped; severity inputs are LOW 20, MEDIUM 45, HIGH 70, CRITICAL 100. Categories are LOW 0–34, MODERATE 35–54, HIGH 55–74, CRITICAL 75–100. This is a deterministic operational signal, not a forecast or causal claim.</p>}
            <ul>{data.dataLimitations.map((item)=><li key={item}>{item}</li>)}</ul>
            <p>{data.dataQuality.totalIncidentsInRange===undefined?`${data.dataQuality.incidentsAnalyzed.toLocaleString()} public incidents analyzed.`:`${data.dataQuality.totalIncidentsInRange.toLocaleString()} incidents in range; ${data.dataQuality.incidentsAnalyzed.toLocaleString()} analyzed.`} {selectedDepartment?`Department scope: ${selectedDepartment.name}.`:departmentId!=='ALL'?'Department-scoped results.':'All departments.'}</p>
          </details>
        </>}
  </div>;
}

