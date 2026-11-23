import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  Activity, AlertTriangle, ArrowRight, BarChart3, Bell, Building2, CheckCircle2,
  ChevronRight, CircleUserRound, ClipboardList, Clock3, Grid2X2, LayoutDashboard, ListFilter,
  MapPin, Menu, Search, Settings, ShieldCheck,
  Trash2, Users, X, Droplets, RefreshCw, Route as RoadIcon, Lightbulb, Waves, TreePine,
  type LucideIcon
} from 'lucide-react';
import { PieChart, Pie, Cell, ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip } from 'recharts';
import { incidents } from './data/incidents';
import type { Category } from './types';
import { useAuth, type UserRole } from './context/AuthContext';
import { apiRequest, apiUrl, type PublicIncident } from './services/api';
import { CitizenReportPage, ReportSuccess } from './pages/citizen/CitizenReportPage';
import {
  AuthorityAnalytics, AuthorityDashboard, AuthorityIncidentDetail, AuthorityIncidentQueue, AuthorityProfilePage,
} from './pages/authority/AuthorityOperations';
import { DepartmentTrustCard, ReviewerWorkspace, VerificationCenter } from './pages/verification/VerificationCenter';
import { CityIntelligenceDashboard } from './pages/intelligence/CityIntelligence';
import { CommunityPortalPage, CommunityPublicPage } from './pages/community/CommunityEngagement';

interface AdminUserRecord { id:string; fullName:string; email:string; role:string; accountStatus:string }
interface AdminDepartmentRecord { id:string; name:string; code:string; status:string; description?:string }

const colors: Record<Category, string> = {
  ROAD:'#d97706', WASTE:'#64748b', WATER:'#0284c7', DRAINAGE:'#2563eb',
  ELECTRICITY:'#ca8a04', PUBLIC_SPACE:'#059669', OTHER:'#7c3aed',
};

const categoryIcons: Record<Category, LucideIcon> = {
  ROAD:RoadIcon, WASTE:Trash2, WATER:Droplets, DRAINAGE:Waves,
  ELECTRICITY:Lightbulb, PUBLIC_SPACE:TreePine, OTHER:Grid2X2,
};

function CategoryIcon({category}:{category:Category}) {
  const Icon=categoryIcons[category];
  return <Icon size={18}/>;
}

const statusLabel = (status: string) =>
  status.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
const markerIcon = (category: Category) => L.divIcon({
  className:'incident-marker',
  html:`<div style="background:${colors[category]}"></div>`,
  iconSize:[26,26], iconAnchor:[13,26],
});

function DemoBadge() {
  return <span className="demo-badge">DEMO DATA</span>;
}

function Logo({ compact=false }: { compact?: boolean }) {
  return <NavLink to="/" className="logo"><span className="logo-mark"><ShieldCheck size={compact ? 20 : 22}/></span>{!compact && <span>Civic<span>Loop</span></span>}</NavLink>;
}

function PublicNav() {
  const [open,setOpen]=useState(false);
  const close=()=>setOpen(false);
  return <header className="public-nav">
    <div className="nav-inner"><Logo/>
      <button className="icon-button mobile-menu" aria-label="Toggle navigation" onClick={()=>setOpen(!open)}>{open?<X/>:<Menu/>}</button>
      <nav className={open?'open':''}>
        <NavLink to="/" onClick={close}>Home</NavLink>
        <NavLink to="/issues" onClick={close}>Explore Issues</NavLink>
        <NavLink to="/transparency" onClick={close}>Transparency</NavLink>
        <NavLink to="/insights" onClick={close}>City Insights</NavLink>
        <NavLink to="/map" onClick={close}>Map</NavLink>
        <NavLink to="/community" onClick={close}>Community</NavLink>
        <NavLink to="/campaigns" onClick={close}>Campaigns</NavLink>
        <NavLink to="/impact" onClick={close}>Impact</NavLink>
      </nav>
      <div className="nav-actions">
        <NavLink className="button ghost" to="/login">Log in</NavLink>
        <NavLink className="button primary" to="/register">Get Started</NavLink>
      </div>
    </div>
  </header>;
}

function PublicLayout({ children }: { children: React.ReactNode }) {
  return <><PublicNav/><main>{children}</main><Footer/></>;
}

function Footer() {
  return <footer className="footer"><div className="footer-grid">
    <div><Logo/><p>Community visibility. Traceable action.</p></div>
    <div><h4>Platform</h4><NavLink to="/issues">Explore Issues</NavLink><NavLink to="/transparency">Transparency</NavLink><NavLink to="/insights">City Insights</NavLink><NavLink to="/map">Civic Map</NavLink><NavLink to="/community">Community</NavLink><NavLink to="/campaigns">Campaigns</NavLink><NavLink to="/impact">Verified impact</NavLink></div>
    <div><h4>Organization</h4><a href="#about">About CivicLoop</a><a href="#contact">Contact placeholder</a></div>
    <div><h4>Legal</h4><a href="#privacy">Privacy</a><a href="#terms">Terms</a></div>
  </div><div className="footer-bottom"><span>© 2026 CivicLoop</span><span>Independent civic-tech concept · Not a government service</span></div></footer>;
}

function Landing() {
  const navigate=useNavigate();
  return <PublicLayout><>
    <section className="hero-section">
      <div className="hero-copy">
        <div className="eyebrow"><span></span> Civic accountability platform</div>
        <h1>Your city.<br/><em>Your voice.</em><br/>Verified action.</h1>
        <p>Report local issues, track real progress, and hold resolutions accountable. CivicLoop connects communities with the action their cities need.</p>
        <div className="hero-actions">
          <button className="button primary large" onClick={()=>navigate('/citizen/report')}>Report an Issue <ArrowRight size={18}/></button>
          <button className="button outline large" onClick={()=>navigate('/issues')}>Explore Civic Issues</button>
        </div>
      </div>
      <DashboardVisual/>
    </section>
    <section className="impact-strip">
      {[['Issues Reported','12,840','+18.2%'],['Issues Resolved','9,621','74.9%'],['Resolution Rate','74.9%','+6.4%'],['Active Civic Areas','42','Across the demo city']].map(([label,value,note]) =>
        <div className="metric" key={label}><span>{label}</span><strong>{value}</strong><small>{note}</small><DemoBadge/></div>)}
    </section>
    <section className="section">
      <SectionHeading eyebrow="A clear public process" title="How CivicLoop works"/>
      <div className="steps">
        {[['01','Report','Submit an issue with location and evidence.'],['02','Analyze','Prioritize, categorize, and flag duplicates.'],['03','Resolve','Authorities act and publish verification evidence.'],['04','Verify','Citizens confirm outcomes and reopen when needed.']].map(([n,title,text]) =>
          <div className="step" key={n}><span>{n}</span><h3>{title}</h3><p>{text}</p></div>)}
      </div>
    </section>
    <section className="section category-section">
      <SectionHeading eyebrow="Issue categories" title="Every civic concern has a place"/>
      <div className="category-grid">{(Object.keys(colors) as Category[]).map(cat=>{
        const Icon=categoryIcons[cat];
        return <button key={cat} onClick={()=>navigate('/issues')}><span style={{background:colors[cat]+'18',color:colors[cat]}}><Icon/></span><strong>{cat.replace('_',' ')}</strong><small>{incidents.filter(i=>i.category===cat).length} demo reports</small></button>
      })}</div>
    </section>
    <section className="accountability">
      <div><SectionHeading eyebrow="Accountability by design" title="An issue isn't resolved just because someone says it is."/>
      <p>Every outcome is tied to an action trail, public evidence, and a clear verification stage.</p></div>
      <div className="workflow">{['Report','Authority Action','Evidence','Verification'].map((label,i)=><div className="workflow-step" key={label}><span>{i+1}</span><strong>{label}</strong>{i<3&&<ArrowRight/>}</div>)}</div>
    </section>
  </></PublicLayout>;
}

function DashboardVisual() {
  const data=[{v:28},{v:42},{v:38},{v:56},{v:49},{v:67},{v:74},{v:82},{v:76},{v:91}];
  return <div className="hero-visual">
    <div className="visual-top"><div><small>City response</small><strong>Resolution overview</strong></div><span><DemoBadge/></span></div>
    <div className="visual-chart">
      <ResponsiveContainer width="100%" height="100%"><AreaChart data={data}><defs><linearGradient id="mint" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#0d9488" stopOpacity=".28"/><stop offset="100%" stopColor="#0d9488" stopOpacity="0"/></linearGradient></defs><Area type="monotone" dataKey="v" stroke="#0d9488" strokeWidth={3} fill="url(#mint)"/></AreaChart></ResponsiveContainer>
    </div>
    <div className="map-card"><div className="map-grid"></div>{incidents.slice(0,6).map((i,n)=><span key={i.id} className="map-dot" style={{left:`${18+n*12}%`,top:`${25+(n%3)*20}%`,background:colors[i.category]}}><MapPin size={12}/></span>)}
      <div className="floating-status"><CheckCircle2/><div><small>Recently verified</small><strong>Streetlight restored</strong></div></div>
    </div>
  </div>;
}

function SectionHeading({eyebrow,title}:{eyebrow:string,title:string}) {
  return <div className="section-heading"><span>{eyebrow}</span><h2>{title}</h2></div>;
}

function IssueStatus({status}:{status:string}) {
  return <span className={`status status-${status.toLowerCase()}`}><i></i>{statusLabel(status)}</span>;
}

function SeverityBadge({severity}:{severity:string}) {
  return <span className={`severity severity-${severity.toLowerCase()}`}>{severity}</span>;
}

function IssuesPage() {
  const [query,setQuery]=useState('');
  const [category,setCategory]=useState('ALL');
  const [status,setStatus]=useState('ALL');
  const [sort,setSort]=useState('newest');
  const [priority,setPriority]=useState('ALL');
  const [page,setPage]=useState(1);
  const [rows,setRows]=useState<PublicIncident[]>([]);
  const [pages,setPages]=useState(1);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [view,setView]=useState<'list'|'map'>('list');
  const navigate=useNavigate();
  useEffect(()=>{
    let active=true;
    const params=new URLSearchParams({page:String(page),limit:'12',sort});
    if(query) params.set('search',query);
    if(category!=='ALL') params.set('category',category);
    if(status!=='ALL') params.set('status',status);
    if(priority!=='ALL') params.set('priority',priority);
    void Promise.resolve().then(()=>{
      if(!active)return;
      setLoading(true);setError('');
      return apiRequest<{incidents:PublicIncident[];pagination:{pages:number}}>(`/api/incidents/public?${params}`);
    })
      .then(data=>{if(active&&data){setRows(data.incidents);setPages(Math.max(1,data.pagination.pages));}})
      .catch(reason=>{if(active)setError(reason instanceof Error?reason.message:'Unable to load public incidents');})
      .finally(()=>{if(active)setLoading(false);});
    return ()=>{active=false;};
  },[query,category,status,sort,priority,page]);
  return <PublicLayout><div className="page-shell">
    <PageHeader eyebrow="Public issue explorer" title="Explore civic issues" description="Search publicly shared incident reports from the CivicLoop community." showDemo={false}/>
    <div className="toolbar">
      <label className="search-field"><Search/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search issue, address, or category"/></label>
      <select value={category} onChange={e=>setCategory(e.target.value)} aria-label="Filter category"><option value="ALL">All categories</option>{Object.keys(colors).map(c=><option key={c} value={c}>{c.replace('_',' ')}</option>)}</select>
      <select value={status} onChange={e=>setStatus(e.target.value)} aria-label="Filter status"><option value="ALL">All statuses</option>{['REPORTED','ACKNOWLEDGED','IN_PROGRESS','RESOLUTION_SUBMITTED','VERIFICATION_PENDING','RESOLVED','REOPENED','ON_HOLD','REJECTED','DUPLICATE'].map(s=><option key={s} value={s}>{statusLabel(s)}</option>)}</select>
      <select value={priority} onChange={e=>setPriority(e.target.value)} aria-label="Filter priority"><option value="ALL">All priorities</option>{['P1','P2','P3','P4'].map(x=><option key={x}>{x}</option>)}</select>
      <select value={sort} onChange={e=>setSort(e.target.value)} aria-label="Sort incidents"><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select>
      <div className="view-toggle"><button className={view==='list'?'active':''} onClick={()=>setView('list')}><ListFilter/>List</button><button className={view==='map'?'active':''} onClick={()=>setView('map')}><MapPin/>Map</button></div>
    </div>
    {error?<div className="empty-state"><AlertTriangle/><h3>Could not load incidents</h3><p>{error}</p></div>:loading?<div className="empty-state">Loading public reports…</div>:rows.length===0?<EmptyState/>:view==='list'?<div className="issue-grid">{rows.map(i=><IssueCard key={i.id} incident={i} onClick={()=>navigate(`/issues/${i.id}`)}/>)}</div>:
      <MiniMap incidents={rows}/>}
    {!loading&&!error&&pages>1&&<div className="pagination"><button className="button outline" disabled={page<=1} onClick={()=>setPage(page-1)}>Previous</button><span>Page {page} of {pages}</span><button className="button outline" disabled={page>=pages} onClick={()=>setPage(page+1)}>Next</button></div>}
  </div></PublicLayout>;
}

function PageHeader({eyebrow,title,description,showDemo=true}:{eyebrow:string,title:string,description:string,showDemo?:boolean}) {
  return <div className="page-header"><div><span>{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{showDemo&&<DemoBadge/>}</div>;
}

function IssueCard({incident,onClick}:{incident:PublicIncident,onClick:()=>void}) {
  const Icon=categoryIcons[incident.category];
  return <button className="issue-card" onClick={onClick}>
    <div className="issue-card-top"><span className="category-icon" style={{color:colors[incident.category],background:colors[incident.category]+'16'}}><Icon size={19}/></span><SeverityBadge severity={incident.priorityBand}/></div>
    <h3>{incident.title}</h3><p>{incident.summary||incident.description}</p>
    <div className="issue-location"><MapPin size={15}/>{incident.locationText}</div>
    <div className="issue-card-bottom">    <IssueStatus status={incident.verificationStatus==='UNDER_REVIEW'?'UNDER_REVIEW':incident.status}/><span>{new Date(incident.createdAt).toLocaleDateString()}</span></div>
  </button>;
}

function EmptyState() {
  return <div className="empty-state"><Search/><h3>No incidents found</h3><p>Try adjusting your search or filters.</p></div>;
}

function MiniMap({incidents}: {incidents: PublicIncident[]}) {
  return <div className="map-layout">
    <MapContainer center={[28.6139,77.209]} zoom={12} scrollWheelZoom={true} className="leaflet-map">
      <TileLayer attribution='&copy; OpenStreetMap contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"/>
      {incidents.map(i=><Marker key={i.id} position={[i.latitude,i.longitude]} icon={markerIcon(i.category)}><Popup><strong>{i.title}</strong><br/><span>{statusLabel(i.status)}</span></Popup></Marker>)}
    </MapContainer>
  </div>;
}

function IncidentDetail() {
  const {id}=useParams();
  const location=useLocation();
  const [incident,setIncident]=useState<PublicIncident|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  useEffect(()=>{
    let active=true;
    void Promise.resolve().then(()=>{
      if(!active)return;
      setLoading(true);setError('');
      return apiRequest<{incident:PublicIncident}>(`/api/incidents/${id}`);
    })
      .then(data=>{if(active&&data)setIncident(data.incident);})
      .catch(reason=>{if(active)setError(reason instanceof Error?reason.message:'Unable to load incident');})
      .finally(()=>{if(active)setLoading(false);});
    return ()=>{active=false;};
  },[id]);
  if(loading)return <PublicLayout><div className="page-shell"><div className="empty-state">Loading incident…</div></div></PublicLayout>;
  if(error||!incident)return <PublicLayout><div className="page-shell"><div className="empty-state"><AlertTriangle/><h3>Incident unavailable</h3><p>{error||'This incident may be private or no longer available.'}</p><NavLink className="button outline" to="/issues">Back to public issues</NavLink></div></div></PublicLayout>;
  const Icon=categoryIcons[incident.category];
  return <PublicLayout><div className="page-shell detail-page">
    <NavLink className="back-link" to={location.pathname.startsWith('/citizen')?'/citizen/my-reports':'/issues'}>← Back to issues</NavLink>
    <div className="detail-grid">
      <article className="detail-main">
        <div className="detail-visual"><div className="map-grid"></div><span className="detail-pin" style={{background:colors[incident.category]}}><Icon/></span></div>
        <div className="detail-title"><span className="category-icon" style={{color:colors[incident.category],background:colors[incident.category]+'16'}}><Icon/></span><div><span>{incident.category.replace('_',' ')}</span><h1>{incident.title}</h1></div></div>
        {location.pathname.startsWith('/citizen')&&incident.status==='VERIFICATION_PENDING'&&<div className="citizen-verification-link"><ShieldCheck/><div><strong>Resolution submitted for your review</strong><small>Compare the evidence and record your response in the verification center.</small></div><NavLink className="button outline" to="/citizen/verifications">Review</NavLink></div>}
        <h2>Incident description</h2><p>{incident.description}</p>
        <h2>Report details</h2>
        <div className="timeline">
          {incident.activities?.length ? incident.activities.map((item)=><div key={item.id}><Activity/><span><strong>{item.activityType.replaceAll('_',' ')}</strong><small>{new Date(item.createdAt).toLocaleString()} · {item.actor?.fullName||'CivicLoop'}</small><small>{item.activityDescription}</small></span></div>):<>
            <div><CheckCircle2/><span><strong>Incident reported</strong><small>{new Date(incident.createdAt).toLocaleString()}</small></span></div>
            {incident.status!== 'REPORTED'&&<div><Activity/><span><strong>{statusLabel(incident.status)}</strong><small>Latest public status</small></span></div>}
          </>}
        </div>
        {incident.imageUrls.length > 0 && (
          <>
            <h2>Supporting evidence</h2>
            <div className="detail-gallery">
              {incident.imageUrls.map((url) => (
                <img key={url} src={apiUrl(url)} alt="Incident evidence" />
              ))}
            </div>
          </>
        )}
        {incident.verification && <section className="public-verification-summary">
          <div className="public-verification-heading"><span><ShieldCheck size={19}/> Verified resolution</span><strong>{new Date(incident.verification.verifiedAt).toLocaleDateString()} · {incident.verification.method}</strong></div>
          <h2>Resolution summary</h2><p>{incident.verification.resolutionSummary}</p>
          {incident.verification.workCompleted&&<p>{incident.verification.workCompleted}</p>}
          {incident.verification.evidenceImageUrls.length>0&&<EvidenceImages urls={incident.verification.evidenceImageUrls}/>}
        </section>}
        {incident.verificationStatus==='UNDER_REVIEW'&&<div className="public-verification-notice"><Clock3 size={18}/>Verification under review</div>}
        {incident.status==='REOPENED'&&<div className="public-verification-notice reopened"><RefreshCw size={18}/>Issue reopened</div>}
      </article>
      <aside className="detail-aside">
        <div className="aside-card"><div className="aside-row"><span>Status</span><IssueStatus status={incident.status}/></div><div className="aside-row"><span>Priority</span><SeverityBadge severity={incident.priorityBand}/></div><div className="aside-row"><span>Incident ID</span><strong>{incident.id}</strong></div><div className="aside-row"><span>Reported</span><strong>{new Date(incident.createdAt).toLocaleDateString()}</strong></div></div>
        <div className="aside-card"><h3>Location</h3><div className="location-line"><MapPin/><span>{incident.locationText}</span></div></div>
        {incident.department&&<div className="aside-card"><h3>Recommended department</h3><div className="location-line"><Building2/><span>{incident.department.name}</span></div></div>}
        {incident.department&&<DepartmentTrustCard departmentId={incident.department.id}/>}
      </aside>
    </div>
  </div></PublicLayout>;
}

function EvidenceImages({urls}:{urls:string[]}) {
  return <div className="detail-gallery">{urls.map((url)=><img key={url} src={apiUrl(url)} alt="Public resolution evidence"/>)}</div>;
}

function Transparency() {
  const [data,setData]=useState<{incidents:PublicIncident[];aggregates:{statuses:Record<string,number>;categories:Record<string,number>;departments:{id:string;name:string;total:number;resolved:number}[]};pagination:{total:number}}|null>(null);
  const [departmentTrustState,setDepartmentTrustState]=useState<{key:string;items:Array<{id:string;name:string;label:string;value:number|null;sampleSize:number;verified:number;reopened:number;requiringVerification:number;overdue:number}>}|null>(null);
  const [error,setError]=useState('');
  const departmentKey=data?.aggregates.departments.map((department)=>department.id).join('|')??'';
  const trustLoaded=Boolean(data&&departmentTrustState?.key===departmentKey);
  const departmentTrust=departmentTrustState?.key===departmentKey?departmentTrustState.items:[];
  useEffect(()=>{
    let active=true;
    void apiRequest<typeof data extends infer T?NonNullable<T>:never>('/api/incidents/public?limit=50')
      .then(result=>{if(active)setData(result);})
      .catch(reason=>{if(active)setError(reason instanceof Error?reason.message:'Unable to load public metrics');});
    return ()=>{active=false;};
  },[]);
  useEffect(()=>{
    if(!data)return;
    let active=true;
    const key=data.aggregates.departments.map((department)=>department.id).join('|');
    void Promise.all(data.aggregates.departments.map(async department=>{
      const result=await apiRequest<{trustIndicator:{label:string;value?:number;sampleSize:number};metrics:{verifiedResolutions:number;reopenedIncidents:number;requiringVerification:number;overdueVerification:number}}>(`/api/verification/public/departments/${department.id}/metrics`);
      return {id:department.id,name:department.name,label:result.trustIndicator.label,value:result.trustIndicator.value??null,sampleSize:result.trustIndicator.sampleSize,verified:result.metrics.verifiedResolutions,reopened:result.metrics.reopenedIncidents,requiringVerification:result.metrics.requiringVerification,overdue:result.metrics.overdueVerification};
    }))
      .then(result=>{if(active)setDepartmentTrustState({key,items:result});})
      .catch(reason=>{if(active){setDepartmentTrustState({key,items:[]});setError(reason instanceof Error?reason.message:'Unable to load public verification metrics');}});
    return ()=>{active=false;};
  },[data]);
  const total=data?.pagination.total||0;
  const verified=departmentTrust.reduce((sum,item)=>sum+item.verified,0);
  const reopened=departmentTrust.reduce((sum,item)=>sum+item.reopened,0);
  const finalDecisions=verified+reopened;
  const requiringVerification=departmentTrust.reduce((sum,item)=>sum+item.requiringVerification,0);
  const overdue=departmentTrust.reduce((sum,item)=>sum+item.overdue,0);
  const pending=Math.max(0,requiringVerification-finalDecisions);
  const categories=(Object.keys(colors) as Category[]).map(category=>({name:category.replace('_',' '),value:data?.aggregates.categories[category]||0}));
  const trend=[...(data?.incidents||[])].slice(0,12).reverse().map((item,index)=>({month:`#${index+1}`,reported:1,resolved:item.status==='RESOLVED'?1:0}));
  return <PublicLayout><div className="page-shell">
    <PageHeader eyebrow="Public accountability" title="Transparency dashboard" description="Aggregate metrics based on publicly shared incident reports." showDemo={false}/>
    {error&&<div className="auth-notice">{error}</div>}
    <StatCardGrid items={[['Public incidents',total,ClipboardList],['Verified outcomes',trustLoaded?verified:'…',CheckCircle2],['Awaiting verification',trustLoaded?pending:'…',Activity],['Overdue verification',trustLoaded?overdue:'…',Clock3]]}/>
    <div className="public-outcome-rate">Verified outcome rate: <strong>{!trustLoaded?'Loading…':finalDecisions>=5?`${Math.round(verified/finalDecisions*100)}%`:'Insufficient data'}</strong><span>Calculated only from final verified or reopened decisions; citizen silence and open cases are excluded.</span></div>
    <div className="chart-grid">
      <div className="chart-card"><div className="chart-title"><div><span>Public reports</span><h3>Category distribution</h3></div></div><div className="pie-wrap"><ResponsiveContainer width="100%" height={240}><PieChart><Pie data={categories} dataKey="value" nameKey="name" innerRadius={62} outerRadius={92} paddingAngle={3}>{categories.map((_,i)=><Cell key={i} fill={Object.values(colors)[i]}/>)}</Pie><Tooltip/></PieChart></ResponsiveContainer></div></div>
      <div className="chart-card"><div className="chart-title"><div><span>Latest public records</span><h3>Incident activity</h3></div></div><div className="chart-wrap"><ResponsiveContainer width="100%" height={240}><AreaChart data={trend}><XAxis dataKey="month" axisLine={false} tickLine={false}/><YAxis axisLine={false} tickLine={false}/><Tooltip/><Area type="monotone" dataKey="reported" stroke="#10243a" fill="#10243a" fillOpacity=".08"/><Area type="monotone" dataKey="resolved" stroke="#0d9488" fill="#0d9488" fillOpacity=".14"/></AreaChart></ResponsiveContainer></div></div>
      <div className="chart-card wide"><div className="chart-title"><div><span>Public verification outcomes</span><h3>Department accountability indicators</h3></div></div>
        <p className="verification-muted">Outcome indicators use final verified or reopened decisions only. Open cases and citizen silence are excluded; departments are not ranked.</p>
        {!trustLoaded?<div className="verification-muted">Loading public verification metrics…</div>:departmentTrust.length===0?<div className="verification-muted">No public department verification decisions are available yet.</div>:<div className="department-trust-list">{departmentTrust.map(item=><div key={item.id}><strong>{item.name}</strong><span>{item.value===null?'Insufficient data':`${item.label}: ${item.value}%`}</span><small>{item.sampleSize} final decisions</small></div>)}</div>}
      </div>
    </div>
  </div></PublicLayout>;
}

function PublicMapPage() {
  const [category,setCategory]=useState('ALL');
  const [status,setStatus]=useState('ALL');
  const [rows,setRows]=useState<PublicIncident[]>([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  useEffect(()=>{
    let active=true;
    const params=new URLSearchParams({limit:'50'});
    if(category!=='ALL')params.set('category',category);
    if(status!=='ALL')params.set('status',status);
    void Promise.resolve().then(()=>{
      if(!active)return;
      setLoading(true);setError('');
      return apiRequest<{incidents:PublicIncident[]}>(`/api/incidents/public?${params}`);
    })
      .then(data=>{if(active&&data)setRows(data.incidents);})
      .catch(reason=>{if(active)setError(reason instanceof Error?reason.message:'Unable to load public locations');})
      .finally(()=>{if(active)setLoading(false);});
    return ()=>{active=false;};
  },[category,status]);
  return <PublicLayout><div className="page-shell map-page">
    <PageHeader eyebrow="Public incident locations" title="Civic map" description="Explore locations shared by citizens in public incident reports." showDemo={false}/>
    <div className="map-controls"><select value={category} onChange={e=>setCategory(e.target.value)}><option value="ALL">All categories</option>{Object.keys(colors).map(c=><option key={c} value={c}>{c.replace('_',' ')}</option>)}</select><select value={status} onChange={e=>setStatus(e.target.value)}><option value="ALL">All statuses</option>{['REPORTED','ACKNOWLEDGED','IN_PROGRESS','RESOLUTION_SUBMITTED','VERIFICATION_PENDING','RESOLVED','REOPENED','ON_HOLD','REJECTED','DUPLICATE'].map(s=><option key={s} value={s}>{statusLabel(s)}</option>)}</select><span>{rows.length} incidents</span></div>
    {error?<div className="empty-state"><AlertTriangle/><h3>Map data unavailable</h3><p>{error}</p></div>:loading?<div className="empty-state">Loading public map…</div>:rows.length===0?<EmptyState/>:<div className="full-map-layout"><MiniMap incidents={rows}/><div className="map-list">{rows.map(i=><NavLink key={i.id} to={`/issues/${i.id}`}><span style={{background:colors[i.category]}}></span><div><strong>{i.title}</strong><small>{i.locationText}</small></div><ChevronRight/></NavLink>)}</div></div>}
  </div></PublicLayout>;
}

type PortalType='citizen'|'authority'|'admin';

function PortalLayout({role,children}:{role:PortalType,children:React.ReactNode}) {
  const [open,setOpen]=useState(false);
  const {user,logout}=useAuth();
  const navigate=useNavigate();
  const initial=user?.fullName.split(/\s+/).map(part=>part[0]).slice(0,2).join('').toUpperCase()||'CL';
  const signOut=async()=>{await logout();navigate('/',{replace:true});};
  const config={
    citizen:{name:'Citizen Portal',items:[{to:'/citizen',label:'Overview',icon:LayoutDashboard},{to:'/citizen/my-reports',label:'My Reports',icon:ClipboardList},{to:'/citizen/verifications',label:'Verifications',icon:ShieldCheck},{to:'/citizen/community',label:'Community activity',icon:Users},{to:'/citizen/areas',label:'Followed areas',icon:MapPin},{to:'/citizen/participation',label:'Participation',icon:Activity},{to:'/citizen/notifications',label:'Notifications',icon:Bell},{to:'/citizen/report',label:'Report Issue',icon:MapPin},{to:'/citizen/profile',label:'Profile',icon:CircleUserRound}]},
    authority:{name:'Authority Portal',items:[{to:'/authority',label:'Overview',icon:LayoutDashboard},{to:'/authority/incidents',label:'Incident Queue',icon:ClipboardList},{to:'/authority/analytics',label:'Analytics',icon:BarChart3},{to:'/authority/intelligence',label:'Department intelligence',icon:BarChart3},{to:'/authority/campaigns',label:'Campaign management',icon:Users},{to:'/authority/profile',label:'Profile',icon:CircleUserRound}]},
    admin:{name:'Admin Console',items:[{to:'/admin',label:'Overview',icon:LayoutDashboard},{to:'/admin/users',label:'Users',icon:Users},{to:'/admin/departments',label:'Departments',icon:Building2},{to:'/admin/incidents',label:'Incidents',icon:ClipboardList},{to:'/admin/verification',label:'Verification review',icon:ShieldCheck},{to:'/admin/intelligence',label:'City intelligence',icon:BarChart3},{to:'/admin/campaigns',label:'Campaign oversight',icon:Users},{to:'/admin/settings',label:'Settings',icon:Settings}]},
  }[role];
  return <div className="portal">
    <aside className={`sidebar ${open?'open':''}`}><div className="sidebar-logo"><Logo/><button className="icon-button" onClick={()=>setOpen(false)}><X/></button></div><div className="portal-label">{config.name}</div><nav>{config.items.map(({to,label,icon:Icon})=><NavLink key={to} to={to} onClick={()=>setOpen(false)}><Icon size={18}/>{label}</NavLink>)}</nav><div className="sidebar-user"><span>{initial}</span><div><strong>{user?.fullName??'CivicLoop user'}</strong><small>{user?.role??role}</small></div></div></aside>
    {open&&<button className="sidebar-backdrop" aria-label="Close sidebar" onClick={()=>setOpen(false)}/>}
    <div className="portal-main"><header className="portal-header"><button className="icon-button" onClick={()=>setOpen(true)}><Menu/></button><div><span>Workspace</span><strong>{config.name}</strong></div><div className="portal-header-actions"><NavLink className="icon-button" aria-label="Notifications" to={role==='citizen'?'/citizen/notifications':'/community'}><Bell/></NavLink><NavLink className="avatar" to={role==='admin'?'/admin/settings':`/${role}/profile`}>{initial}</NavLink><button className="text-button" onClick={signOut}>Logout</button></div></header><main className="portal-content">{children}</main></div>
  </div>;
}

function PortalHeader({title,subtitle,action}:{title:string,subtitle:string,action?:string}) {
  const navigate=useNavigate();
  return <div className="portal-page-header"><div><span>DEMO PREVIEW</span><h1>{title}</h1><p>{subtitle}</p></div>{action&&<button className="button primary" onClick={()=>navigate('/citizen/report')}>{action}</button>}</div>;
}

function StatCardGrid({items}:{items:[string,string|number,LucideIcon][]}) {
  return <div className="stats-grid">{items.map(([label,value,Icon])=><div className="stat-card" key={label}><span className="stat-icon"><Icon size={20}/></span><small>{label}</small><strong>{value}</strong></div>)}</div>;
}

function CitizenDashboard() {
  const [rows,setRows]=useState<PublicIncident[]>([]);
  const [verificationCases,setVerificationCases]=useState<Array<{id:string;status:string;responseDeadline:string;incident:{title:string;category:Category;locationText:string}}>>([]);
  const [counts,setCounts]=useState<Record<string,number>>({});
  const [error,setError]=useState('');
  useEffect(()=>{
    let active=true;
    void apiRequest<{incidents:PublicIncident[];counts:Record<string,number>}>('/api/incidents/my?limit=5')
      .then(data=>{if(active){setRows(data.incidents);setCounts(data.counts);}})
      .catch(reason=>{if(active)setError(reason instanceof Error?reason.message:'Unable to load your reports');});
    void apiRequest('/api/verification/process-deadlines',{method:'POST'})
      .then(()=>apiRequest<{cases:Array<{id:string;status:string;responseDeadline:string;incident:{title:string;category:Category;locationText:string}}>}>('/api/verification/me?limit=5'))
      .then(data=>{if(active)setVerificationCases(data.cases);})
      .catch(reason=>{if(active)setError(reason instanceof Error?reason.message:'Unable to load verification requests');});
    return ()=>{active=false;};
  },[]);
  const total=Object.values(counts).reduce((sum,value)=>sum+value,0);
  return <PortalLayout role="citizen"><PortalHeader title="Good morning" subtitle="A current view of your submitted reports." action="Report an Issue"/>
    {error&&<div className="auth-notice">{error}</div>}
    <div className="portal-stats"><StatCardGrid items={[['My Reports',total,ClipboardList],['In Progress',counts.IN_PROGRESS||0,Activity],['Resolved',counts.RESOLVED||0,CheckCircle2],['Awaiting Verification',counts.VERIFICATION_PENDING||0,ShieldCheck]]}/></div>
    <div className="panel verification-dashboard-card"><div className="panel-header"><div><span>Review submitted work</span><h3>Resolution verification</h3></div><NavLink to="/citizen/verifications">Open verification center</NavLink></div>
      {verificationCases.filter((item)=>['PENDING','DISPUTED','REVIEW_REQUIRED'].includes(item.status)).length===0
        ? <p className="verification-dashboard-empty">No active verification requests. When an authority submits resolution evidence, it will appear here.</p>
        : verificationCases.filter((item)=>['PENDING','DISPUTED','REVIEW_REQUIRED'].includes(item.status)).map((item)=><NavLink className="report-row" key={item.id} to="/citizen/verifications"><span style={{color:colors[item.incident.category],background:colors[item.incident.category]+'16'}}><ShieldCheck size={18}/></span><div><strong>{item.incident.title}</strong><small>{item.incident.locationText} · due {new Date(item.responseDeadline).toLocaleDateString()}</small></div><IssueStatus status={item.status==='DISPUTED'?'UNDER_REVIEW':item.status}/></NavLink>)}
    </div>
    <div className="panel"><div className="panel-header"><div><span>Recent activity</span><h3>My reports</h3></div><NavLink to="/citizen/my-reports">View all</NavLink></div>{rows.length===0?<div className="empty-state"><p>No reports yet. Start by reporting an issue in your community.</p></div>:rows.map((incident)=><NavLink className="report-row" key={incident.id} to={`/citizen/my-reports/${incident.id}`}><span style={{color:colors[incident.category],background:colors[incident.category]+'16'}}><CategoryIcon category={incident.category}/></span><div><strong>{incident.title}</strong><small>{incident.locationText}</small></div><IssueStatus status={incident.status}/></NavLink>)}</div>
  </PortalLayout>;
}

function CitizenReports() {
  const navigate=useNavigate();
  const [rows,setRows]=useState<PublicIncident[]>([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  useEffect(()=>{
    let active=true;
    void apiRequest<{incidents:PublicIncident[]}>('/api/incidents/my?limit=50')
      .then(data=>{if(active)setRows(data.incidents);})
      .catch(reason=>{if(active)setError(reason instanceof Error?reason.message:'Unable to load your reports');})
      .finally(()=>{if(active)setLoading(false);});
    return ()=>{active=false;};
  },[]);
  return <PortalLayout role="citizen"><PortalHeader title="My Reports" subtitle="Your submitted incident reports." action="Report an Issue"/>{error&&<div className="auth-notice">{error}</div>}{loading?<div className="empty-state">Loading your reports…</div>:rows.length===0?<div className="empty-state"><ClipboardList/><h3>No reports yet</h3><p>Report an issue to see it here.</p><NavLink className="button primary" to="/citizen/report">Report an Issue</NavLink></div>:<div className="panel"><div className="table-scroll"><table><thead><tr><th>Incident</th><th>Category</th><th>Status</th><th>Priority</th><th>Reported</th></tr></thead><tbody>{rows.map(i=><tr key={i.id} onClick={()=>navigate(`/citizen/my-reports/${i.id}`)}><td><strong>{i.title}</strong><small>{i.id}</small></td><td>{i.category.replace('_',' ')}</td><td><IssueStatus status={i.status}/></td><td><SeverityBadge severity={i.priorityBand}/></td><td>{new Date(i.createdAt).toLocaleDateString()}</td></tr>)}</tbody></table></div></div>}</PortalLayout>;
}

function CitizenReport() {
  return <CitizenReportPage/>;
}

function CitizenProfile() {
  const {user,updateProfile}=useAuth();
  const [fullName,setFullName]=useState(user?.fullName||'');
  const [phone,setPhone]=useState(user?.phoneNumber||'');
  const [notice,setNotice]=useState('');
  const save=async()=>{
    try { await updateProfile({fullName,phoneNumber:phone||null}); setNotice('Profile updated'); }
    catch(error) { setNotice(error instanceof Error?error.message:'Profile update failed'); }
  };
  return <PortalLayout role="citizen"><PortalHeader title="Citizen Profile" subtitle="Database-backed account profile."/><div className="profile-card"><span className="profile-avatar">{fullName.slice(0,2).toUpperCase()||'CL'}</span><h3>{fullName}</h3><p>{user?.email}</p><div className="department-form"><input value={fullName} onChange={e=>setFullName(e.target.value)} placeholder="Full name"/><input value={phone} onChange={e=>setPhone(e.target.value)} placeholder="Phone number"/></div>{notice&&<div className="auth-notice">{notice}</div>}<button className="button primary" onClick={save}>Save profile</button></div></PortalLayout>;
}

function AdminDashboard() {
  return <PortalLayout role="admin"><PortalHeader title="System overview" subtitle="Synthetic administrative dashboard."/><div className="portal-stats"><StatCardGrid items={[['Users',1846,Users],['Authorities',38,ShieldCheck],['Departments',12,Building2],['Total incidents',incidents.length,ClipboardList]]}/></div><div className="portal-grid"><div className="panel"><div className="panel-header"><div><span>Activity</span><h3>System activity</h3></div></div>{['Department queue refreshed','Demo incident CL-1004 verified','New authority account previewed','Dataset synchronized'].map((x,i)=><div className="activity-row" key={x}><span>{i+1}</span><strong>{x}</strong><small>Demo activity</small></div>)}</div><div className="panel"><div className="panel-header"><div><span>Health</span><h3>Platform status</h3></div></div><div className="health-list"><div><span><i></i>Frontend</span><strong>Operational</strong></div><div><span><i></i>API health</span><strong>Available</strong></div><div><span><i></i>Database</span><strong>Configure locally</strong></div></div></div></div></PortalLayout>;
}

function AdminSection({title}:{title:string}) {
  const [rows,setRows]=useState<AdminUserRecord[]|AdminDepartmentRecord[]>([]);
  const [search,setSearch]=useState('');
  const [role,setRole]=useState('ALL');
  const [status,setStatus]=useState('ALL');
  const [notice,setNotice]=useState('');

  useEffect(()=>{
    const load=async()=>{
      try {
        if(title==='Users') {
          const params=new URLSearchParams({page:'1',limit:'25'});
          if(search) params.set('search',search);
          if(role!=='ALL') params.set('role',role);
          if(status!=='ALL') params.set('status',status);
          const body=await apiRequest<{users:AdminUserRecord[]}>(`/api/admin/users?${params}`);
          setRows(body.users);
        } else if(title==='Departments') {
          const params=new URLSearchParams();
          if(search) params.set('search',search);
          const body=await apiRequest<{departments:AdminDepartmentRecord[]}>(`/api/admin/departments?${params}`);
          setRows(body.departments);
        }
      } catch(error) {
        setNotice(error instanceof Error?error.message:'Unable to load records');
      }
    };
    if(title==='Users'||title==='Departments') void load();
  },[title,search,role,status]);

  const updateUser=async(id:string,field:'role'|'status',value:string)=>{
    const path=field==='role'?'role':'status';
    const bodyValue=field==='role'?{role:value}:{accountStatus:value};
    try {
      const body=await apiRequest<{user:AdminUserRecord}>(`/api/admin/users/${id}/${path}`,{method:'PATCH',body:JSON.stringify(bodyValue)});
      setNotice('User updated');
      setRows((current)=>current.map((row)=>row.id===id?body.user:row));
    } catch(error) {
      setNotice(error instanceof Error?error.message:'Update failed');
    }
  };

  return <PortalLayout role="admin"><PortalHeader title={title} subtitle={`Database-backed ${title.toLowerCase()} management.`}/>
    {notice&&<div className="auth-notice">{notice}</div>}
    {(title==='Users'||title==='Departments')&&<div className="toolbar"><label className="search-field"><Search/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder={`Search ${title.toLowerCase()}`}/></label>{title==='Users'&&<><select value={role} onChange={e=>setRole(e.target.value)}><option value="ALL">All roles</option><option>CITIZEN</option><option>AUTHORITY</option><option>ADMIN</option></select><select value={status} onChange={e=>setStatus(e.target.value)}><option value="ALL">All statuses</option><option>ACTIVE</option><option>INACTIVE</option><option>SUSPENDED</option></select></>}</div>}
    {title==='Users'?<div className="panel"><div className="table-scroll"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th></tr></thead><tbody>{(rows as AdminUserRecord[]).map((user)=><tr key={user.id}><td><strong>{user.fullName}</strong><small>{user.id}</small></td><td>{user.email}</td><td><select value={user.role} onChange={e=>updateUser(user.id,'role',e.target.value)}><option>CITIZEN</option><option>AUTHORITY</option><option>ADMIN</option></select></td><td><select value={user.accountStatus} onChange={e=>updateUser(user.id,'status',e.target.value)}><option>ACTIVE</option><option>INACTIVE</option><option>SUSPENDED</option></select></td></tr>)}</tbody></table></div></div>:
    title==='Departments'?<DepartmentAdmin rows={rows as AdminDepartmentRecord[]} setRows={(next)=>setRows(next)} setNotice={setNotice}/>:
    <div className="empty-state"><Settings/><h3>Administrative operation not enabled</h3><p>This Module 02 route has no incident or settings operations by scope.</p></div>}
  </PortalLayout>;
}

function DepartmentAdmin({rows,setRows,setNotice}:{rows:AdminDepartmentRecord[],setRows:(rows:AdminDepartmentRecord[])=>void,setNotice:(notice:string)=>void}) {
  const [name,setName]=useState('');
  const [code,setCode]=useState('');
  const [description,setDescription]=useState('');
  const [authorityName,setAuthorityName]=useState('');
  const [authorityEmail,setAuthorityEmail]=useState('');
  const [authorityPassword,setAuthorityPassword]=useState('');
  const [departmentId,setDepartmentId]=useState('');
  const [designation,setDesignation]=useState('');
  const [employeeIdentifier,setEmployeeIdentifier]=useState('');

  const createDepartment=async()=>{
    try {
      const body=await apiRequest<{department:AdminDepartmentRecord}>('/api/admin/departments',{method:'POST',body:JSON.stringify({name,code,description})});
      setRows([body.department,...rows]);
      setName('');setCode('');setDescription('');setNotice('Department created');
    } catch(error) {
      setNotice(error instanceof Error?error.message:'Department creation failed');
    }
  };

  const toggleDepartment=async(id:string,status:string)=>{
    try {
      const body=await apiRequest<{department:AdminDepartmentRecord}>(`/api/admin/departments/${id}`,{method:'PATCH',body:JSON.stringify({status:status==='ACTIVE'?'INACTIVE':'ACTIVE'})});
      setRows(rows.map((row)=>row.id===id?body.department:row));
    } catch(error) {
      setNotice(error instanceof Error?error.message:'Department update failed');
    }
  };

  const provisionAuthority=async()=>{
    try {
      await apiRequest<{user:AdminUserRecord}>('/api/admin/authorities',{method:'POST',body:JSON.stringify({fullName:authorityName,email:authorityEmail,temporaryPassword:authorityPassword,departmentId,designation,employeeIdentifier})});
      setNotice('Authority account provisioned. Provide the temporary password securely.');
      setAuthorityName('');setAuthorityEmail('');setAuthorityPassword('');setDepartmentId('');setDesignation('');setEmployeeIdentifier('');
    } catch(error) {
      setNotice(error instanceof Error?error.message:'Authority provisioning failed');
    }
  };

  return <div className="portal-grid"><div className="panel"><div className="panel-header"><div><span>Add department</span><h3>New synthetic department</h3></div></div><div className="department-form"><input value={name} onChange={e=>setName(e.target.value)} placeholder="Department name"/><input value={code} onChange={e=>setCode(e.target.value.toUpperCase())} placeholder="CODE"/><input value={description} onChange={e=>setDescription(e.target.value)} placeholder="Description"/><button className="button primary" onClick={createDepartment}>Create department</button></div><div className="department-list">{rows.map((department)=><div className="department-row" key={department.id}><div><strong>{department.name}</strong><small>{department.code}</small></div><span>{department.status}</span><button className="text-button" onClick={()=>toggleDepartment(department.id,department.status)}>{department.status==='ACTIVE'?'Deactivate':'Activate'}</button></div>)}</div></div>
  <div className="panel"><div className="panel-header"><div><span>Foundation</span><h3>Provision authority</h3></div></div><div className="department-form"><input value={authorityName} onChange={e=>setAuthorityName(e.target.value)} placeholder="Full name"/><input value={authorityEmail} onChange={e=>setAuthorityEmail(e.target.value)} placeholder="Authority email"/><input value={authorityPassword} onChange={e=>setAuthorityPassword(e.target.value)} type="password" placeholder="Temporary password"/><select value={departmentId} onChange={e=>setDepartmentId(e.target.value)}><option value="">Select department</option>{rows.map((department)=><option key={department.id} value={department.id}>{department.name}</option>)}</select><input value={designation} onChange={e=>setDesignation(e.target.value)} placeholder="Designation"/><input value={employeeIdentifier} onChange={e=>setEmployeeIdentifier(e.target.value)} placeholder="Employee identifier"/><button className="button primary" onClick={provisionAuthority}>Provision authority</button></div></div></div>;
}

function AuthPage({mode}:{mode:'login'|'register'}) {
  const navigate=useNavigate();
  const location=useLocation();
  const { user,loading,login,register }=useAuth();
  const [fullName,setFullName]=useState('');
  const [email,setEmail]=useState('');
  const [password,setPassword]=useState('');
  const [confirm,setConfirm]=useState('');
  const [showPassword,setShowPassword]=useState(false);
  const [notice,setNotice]=useState('');
  const [busy,setBusy]=useState(false);
  if (!loading && user) return <Navigate to={user.role==='ADMIN'?'/admin':user.role==='AUTHORITY'?'/authority':'/citizen'} replace />;
  const submit=async()=>{
    setNotice('');
    if (mode==='register') {
      if (fullName.trim().length<2) return setNotice('Full name must be at least 2 characters.');
      if (password!==confirm) return setNotice('Passwords do not match.');
      if (password.length<8 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) return setNotice('Use 8+ characters with uppercase, lowercase, and a number.');
    }
    setBusy(true);
    try {
      const authenticated=mode==='login'?await login(email,password):await register(fullName,email,password);
      const destination=(location.state as {from?:string}|null)?.from;
      const home=authenticated.role==='ADMIN'?'/admin':authenticated.role==='AUTHORITY'?'/authority':'/citizen';
      const allowedDestination=destination && (
        authenticated.role==='ADMIN' ||
        (authenticated.role==='AUTHORITY'&&destination.startsWith('/authority')) ||
        (authenticated.role==='CITIZEN'&&destination.startsWith('/citizen'))
      );
      navigate(allowedDestination?destination:home, {replace:true});
    } catch (error) {
      setNotice(error instanceof Error?error.message:'Authentication failed');
    } finally {
      setBusy(false);
    }
  };
  return <PublicLayout><div className="auth-shell"><div className="auth-card"><Logo/><span className="auth-eyebrow">{mode==='login'?'Welcome back':'Create your civic account'}</span><h1>{mode==='login'?'Log in to CivicLoop':'Get started with CivicLoop'}</h1>
    {mode==='register'&&<label>Full name<input value={fullName} onChange={e=>setFullName(e.target.value)} placeholder="Demo Citizen"/></label>}
    <label>Email address<input value={email} onChange={e=>setEmail(e.target.value)} type="email" placeholder="you@example.demo"/></label>
    <label>Password<div className="password-input"><input value={password} onChange={e=>setPassword(e.target.value)} type={showPassword?'text':'password'} placeholder="Minimum 8 characters"/><button type="button" onClick={()=>setShowPassword(!showPassword)}>{showPassword?'Hide':'Show'}</button></div></label>
    {mode==='register'&&<label>Confirm password<input value={confirm} onChange={e=>setConfirm(e.target.value)} type={showPassword?'text':'password'} placeholder="Repeat password"/></label>}
    {notice&&<div className="auth-notice">{notice}</div>}
    <button className="button primary full" disabled={busy} onClick={submit}>{busy?'Please wait...':mode==='login'?'Continue':'Create account'}</button>
    <p>{mode==='login'?'New to CivicLoop?':'Already have an account?'} <button className="text-button" onClick={()=>navigate(mode==='login'?'/register':'/login')}>{mode==='login'?'Create account':'Log in'}</button></p>
  </div></div></PublicLayout>;
}

function ProtectedRoute({roles,children}:{roles:UserRole[],children:React.ReactNode}) {
  const {user,loading}=useAuth();
  const location=useLocation();
  if (loading) return <div className="auth-loading"><div className="loading-spinner"></div><span>Loading session...</span></div>;
  if (!user) return <Navigate to="/login" replace state={{from:location.pathname}} />;
  if (!roles.includes(user.role)) return <PublicLayout><div className="empty-state unauthorized"><ShieldCheck/><h3>Unauthorized</h3><p>Your account does not have permission to access this area.</p><NavLink className="button outline" to="/">Return home</NavLink></div></PublicLayout>;
  return <>{children}</>;
}

function NotFound() {
  return <PublicLayout><div className="empty-state"><AlertTriangle/><h3>Page not found</h3><NavLink className="button outline" to="/">Return home</NavLink></div></PublicLayout>;
}

function App() {
  return <BrowserRouter><Routes>
    <Route path="/" element={<Landing/>}/>
    <Route path="/issues" element={<IssuesPage/>}/>
    <Route path="/issues/:id" element={<IncidentDetail/>}/>
    <Route path="/transparency" element={<Transparency/>}/>
    <Route path="/insights" element={<PublicLayout><CityIntelligenceDashboard publicView/></PublicLayout>}/>
    <Route path="/map" element={<PublicMapPage/>}/>
    <Route path="/community" element={<CommunityPublicPage mode="feed"/>}/>
    <Route path="/community/incidents/:id" element={<CommunityPublicPage mode="incident"/>}/>
    <Route path="/campaigns" element={<CommunityPublicPage mode="campaigns"/>}/>
    <Route path="/campaigns/:id" element={<CommunityPublicPage mode="campaign"/>}/>
    <Route path="/impact" element={<CommunityPublicPage mode="impact"/>}/>
    <Route path="/login" element={<AuthPage mode="login"/>}/>
    <Route path="/register" element={<AuthPage mode="register"/>}/>
    <Route path="/citizen" element={<ProtectedRoute roles={['CITIZEN','ADMIN']}><CitizenDashboard/></ProtectedRoute>}/>
    <Route path="/citizen/report" element={<ProtectedRoute roles={['CITIZEN']}><CitizenReport/></ProtectedRoute>}/>
    <Route path="/citizen/report/success/:id" element={<ProtectedRoute roles={['CITIZEN']}><ReportSuccess/></ProtectedRoute>}/>
    <Route path="/citizen/my-reports" element={<ProtectedRoute roles={['CITIZEN','ADMIN']}><CitizenReports/></ProtectedRoute>}/>
    <Route path="/citizen/my-reports/:id" element={<ProtectedRoute roles={['CITIZEN','ADMIN']}><IncidentDetail/></ProtectedRoute>}/>
    <Route path="/citizen/verifications" element={<ProtectedRoute roles={['CITIZEN']}><PortalLayout role="citizen"><VerificationCenter/></PortalLayout></ProtectedRoute>}/>
    <Route path="/citizen/profile" element={<ProtectedRoute roles={['CITIZEN','ADMIN']}><CitizenProfile/></ProtectedRoute>}/>
    <Route path="/citizen/community" element={<ProtectedRoute roles={['CITIZEN']}><PortalLayout role="citizen"><CommunityPortalPage mode="dashboard"/></PortalLayout></ProtectedRoute>}/>
    <Route path="/citizen/areas" element={<ProtectedRoute roles={['CITIZEN']}><PortalLayout role="citizen"><CommunityPortalPage mode="areas"/></PortalLayout></ProtectedRoute>}/>
    <Route path="/citizen/participation" element={<ProtectedRoute roles={['CITIZEN']}><PortalLayout role="citizen"><CommunityPortalPage mode="participation"/></PortalLayout></ProtectedRoute>}/>
    <Route path="/citizen/notifications" element={<ProtectedRoute roles={['CITIZEN']}><PortalLayout role="citizen"><CommunityPortalPage mode="notifications"/></PortalLayout></ProtectedRoute>}/>
    <Route path="/authority" element={<ProtectedRoute roles={['AUTHORITY','ADMIN']}><AuthorityDashboard/></ProtectedRoute>}/>
    <Route path="/authority/incidents" element={<ProtectedRoute roles={['AUTHORITY','ADMIN']}><AuthorityIncidentQueue/></ProtectedRoute>}/>
    <Route path="/authority/incidents/:id" element={<ProtectedRoute roles={['AUTHORITY','ADMIN']}><AuthorityIncidentDetail/></ProtectedRoute>}/>
    <Route path="/authority/analytics" element={<ProtectedRoute roles={['AUTHORITY','ADMIN']}><AuthorityAnalytics/></ProtectedRoute>}/>
    <Route path="/authority/intelligence" element={<ProtectedRoute roles={['AUTHORITY','ADMIN']}><PortalLayout role="authority"><CityIntelligenceDashboard/></PortalLayout></ProtectedRoute>}/>
    <Route path="/authority/profile" element={<ProtectedRoute roles={['AUTHORITY','ADMIN']}><AuthorityProfilePage/></ProtectedRoute>}/>
    <Route path="/authority/campaigns" element={<ProtectedRoute roles={['AUTHORITY','ADMIN']}><PortalLayout role="authority"><CommunityPortalPage mode="manage"/></PortalLayout></ProtectedRoute>}/>
    <Route path="/admin" element={<ProtectedRoute roles={['ADMIN']}><AdminDashboard/></ProtectedRoute>}/>
    <Route path="/admin/users" element={<ProtectedRoute roles={['ADMIN']}><AdminSection title="Users"/></ProtectedRoute>}/>
    <Route path="/admin/departments" element={<ProtectedRoute roles={['ADMIN']}><AdminSection title="Departments"/></ProtectedRoute>}/>
    <Route path="/admin/incidents" element={<ProtectedRoute roles={['ADMIN']}><AdminSection title="Incidents"/></ProtectedRoute>}/>
    <Route path="/admin/verification" element={<ProtectedRoute roles={['ADMIN']}><PortalLayout role="admin"><ReviewerWorkspace/></PortalLayout></ProtectedRoute>}/>
    <Route path="/admin/intelligence" element={<ProtectedRoute roles={['ADMIN']}><PortalLayout role="admin"><CityIntelligenceDashboard/></PortalLayout></ProtectedRoute>}/>
    <Route path="/admin/settings" element={<ProtectedRoute roles={['ADMIN']}><AdminSection title="Settings"/></ProtectedRoute>}/>
    <Route path="/admin/campaigns" element={<ProtectedRoute roles={['ADMIN']}><PortalLayout role="admin"><CommunityPortalPage mode="manage"/></PortalLayout></ProtectedRoute>}/>
    <Route path="*" element={<NotFound/>}/>
  </Routes></BrowserRouter>;
}

export default App;
