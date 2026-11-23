import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, ArrowRight, Check, CheckCircle2, FileImage, MapPin, Sparkles, Upload, X } from 'lucide-react';
import { z } from 'zod';
import type { Category } from '../../types';
import { apiRequest } from '../../services/api';
import { reportCategories } from '../../data/report-categories';
import { LocationPicker } from './LocationPicker';

const reportSchema = z.object({
  title: z.string().trim().min(5, 'Enter at least 5 characters for the title').max(160, 'Title must be 160 characters or fewer'),
  description: z.string().trim().min(20, 'Describe the issue in at least 20 characters').max(2_000, 'Description must be 2,000 characters or fewer'),
  category: z.string().min(1, 'Choose the closest issue category'),
  locationText: z.string().trim().min(3, 'Enter an address or recognizable location').max(250),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

interface Analysis {
  summary: string;
  classification: {
    category: Category;
    subcategory: string;
    summary: string;
    severity: string;
    confidence: number;
    reasoning: string;
    source: 'gemini' | 'rules';
  };
  priority: { score: number; band: string; reasoning: string };
  department: { id: string | null; name: string | null };
  duplicates: { id: string; title: string; category: Category; status: string; locationText: string; description: string; createdAt: string; distanceMeters: null; distanceLabel: string; similarity: number }[];
  source: 'gemini' | 'rules';
  note: string;
}

interface DraftImage {
  file: File;
  preview: string;
}

const steps = ['Describe', 'Evidence', 'Location', 'AI analysis', 'Review'];

export function CitizenReportPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<Category | ''>('');
  const [images, setImages] = useState<DraftImage[]>([]);
  const [locationText, setLocationText] = useState('');
  const [latitude, setLatitude] = useState(28.6139);
  const [longitude, setLongitude] = useState(77.209);
  const [isPublic, setIsPublic] = useState(true);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [useAiAnalysis, setUseAiAnalysis] = useState(false);
  const [aiConsentAccepted, setAiConsentAccepted] = useState(false);
  const [confirmedDuplicateId, setConfirmedDuplicateId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const selectFiles = (selected: FileList | null) => {
    if (!selected) return;
    const newFiles = Array.from(selected);
    if (images.length + newFiles.length > 5) return setError('You can attach up to 5 images.');
    if (newFiles.some((file) => !['image/jpeg', 'image/png', 'image/webp'].includes(file.type))) return setError('Choose JPEG, PNG, or WebP images.');
    if (newFiles.some((file) => file.size > 5 * 1024 * 1024)) return setError('Each image must be 5 MB or smaller.');
    setError('');
    setImages((current) => [...current, ...newFiles.map((file) => ({ file, preview: URL.createObjectURL(file) }))]);
  };

  const removeImage = (index: number) => {
    setImages((current) => {
      URL.revokeObjectURL(current[index].preview);
      return current.filter((_, position) => position !== index);
    });
  };

  const invalidateAiConsent = () => {
    setAiConsentAccepted(false);
    setUseAiAnalysis(false);
    setAnalysis(null);
    setConfirmedDuplicateId('');
  };

  const validateStep = () => {
    setError('');
    if (step === 0) {
      const result = reportSchema.pick({ title: true, description: true, category: true }).safeParse({ title, description, category });
      if (!result.success) return setError(result.error.issues[0]?.message ?? 'Check the report details'), false;
    }
    if (step === 2) {
      const result = reportSchema.pick({ locationText: true, latitude: true, longitude: true }).safeParse({ locationText, latitude, longitude });
      if (!result.success) return setError(result.error.issues[0]?.message ?? 'Check the location'), false;
    }
    return true;
  };

  const analyze = async () => {
    if (!aiConsentAccepted) {
      setError('Accept the optional AI disclosure before requesting analysis.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const consent = await apiRequest<{ consentToken: string }>('/api/incidents/analysis-consent', {
        method: 'POST',
        body: JSON.stringify({ accepted: true, operation: 'INCIDENT_PREVIEW', title, description }),
      });
      const body = await apiRequest<{ analysis: Analysis }>('/api/incidents/analyze', {
        method: 'POST',
        body: JSON.stringify({
          title,
          description,
          category: category || undefined,
          locationText,
          latitude,
          longitude,
          useAiAnalysis: true,
          aiConsentToken: consent.consentToken,
        }),
      });
      setUseAiAnalysis(true);
      setAnalysis(body.analysis);
      setConfirmedDuplicateId('');
      setStep(3);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Analysis could not be completed.');
    } finally {
      setBusy(false);
    }
  };

  const continueWithoutAi = () => {
    setAnalysis(null);
    setUseAiAnalysis(false);
    setAiConsentAccepted(false);
    setConfirmedDuplicateId('');
    setError('');
    setStep(4);
  };

  const advance = async () => {
    if (!validateStep()) return;
    if (step === 2) return void await analyze();
    setStep((current) => Math.min(current + 1, 4));
  };

  const submit = async () => {
    if (!validateAll()) return;
    if (useAiAnalysis && !aiConsentAccepted) {
      setError('Accept the optional AI disclosure again before submitting with AI analysis.');
      setStep(2);
      return;
    }
    setBusy(true);
    setError('');
    try {
      let imageUrls: string[] = [];
      if (images.length) {
        const formData = new FormData();
        images.forEach(({ file }) => formData.append('images', file));
        const uploaded = await apiRequest<{ files: string[] }>('/api/uploads', { method: 'POST', body: formData });
        imageUrls = uploaded.files;
      }
      const consent = useAiAnalysis
        ? await apiRequest<{ consentToken: string }>('/api/incidents/analysis-consent', {
          method: 'POST',
          body: JSON.stringify({ accepted: true, operation: 'INCIDENT_SUBMISSION', title, description }),
        })
        : undefined;
      const response = await apiRequest<{ incident: { id: string } }>('/api/incidents', {
        method: 'POST',
        body: JSON.stringify({
          title, description, category, locationText, latitude, longitude, imageUrls, isPublic, useAiAnalysis,
          aiConsentToken: consent?.consentToken,
          subcategory: analysis?.classification.subcategory,
          confirmedDuplicateId: confirmedDuplicateId || undefined,
        }),
      });
      images.forEach(({ preview }) => URL.revokeObjectURL(preview));
      navigate(`/citizen/report/success/${response.incident.id}`, { replace: true });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Your report could not be submitted.');
    } finally {
      setBusy(false);
    }
  };

  const validateAll = () => {
    const result = reportSchema.safeParse({ title, description, category, locationText, latitude, longitude });
    if (!result.success) {
      setError(result.error.issues[0]?.message ?? 'Review your report details');
      setStep(result.error.issues[0]?.path.includes('locationText') ? 2 : 0);
      return false;
    }
    return true;
  };

  return (
    <div className="report-page">
      <header className="report-topbar">
        <Link to="/citizen"><ArrowLeft size={17} /> Back to dashboard</Link>
        <span>CivicLoop <b>·</b> New report</span>
      </header>
      <div className="report-container">
        <div className="report-intro"><span>COMMUNITY REPORTING</span><h1>Make your city better,<br /><em>one report at a time.</em></h1><p>Share what you’ve noticed. Your report stays editable until you submit it.</p></div>
        <div className="report-stepper" aria-label="Report steps">{steps.map((label, index) => <div className={`report-step ${index === step ? 'current' : ''} ${index < step ? 'done' : ''}`} key={label}><span>{index < step ? <Check size={16} /> : index + 1}</span><small>{label}</small></div>)}</div>
        <section className="report-card">
          <div className="report-card-heading"><div><small>STEP {step + 1} OF 5</small><h2>{['Describe the problem','Add photo evidence','Pinpoint the location','AI-assisted analysis','Review your report'][step]}</h2><p>{['Tell us what happened in your own words.','Photos help document the issue. Images are optional.','Drop a pin or adjust the coordinates to mark the spot.','Recommendations are suggestions and never replace your choices.','Check your details before sending this report.'][step]}</p></div><span className="report-step-icon">{[<FileImage/>,<Upload/>,<MapPin/>,<Sparkles/>,<CheckCircle2/>][step]}</span></div>

          {step === 0 && <div className="report-fields">
            <label>Issue title<input value={title} onChange={(event) => { setTitle(event.target.value); invalidateAiConsent(); }} placeholder="e.g. Deep pothole at the bus stop" maxLength={160} /></label>
            <label>What’s happening?<textarea value={description} onChange={(event) => { setDescription(event.target.value); invalidateAiConsent(); }} placeholder="Describe what you noticed, where it is, and how it affects the community." rows={5} maxLength={2000}/><small>{description.length}/2,000 characters</small></label>
            <fieldset><legend>Choose a category (you can change this later)</legend><div className="report-category-grid">{reportCategories.map((item) => <button type="button" className={category === item.id ? 'selected' : ''} key={item.id} onClick={() => setCategory(item.id)}>{item.label}{category === item.id && <Check size={16}/>}</button>)}</div></fieldset>
          </div>}

          {step === 1 && <div className="report-upload">
            <label className="upload-drop"><input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(event) => { selectFiles(event.target.files); event.target.value = ''; }} /><Upload/><strong>Choose photos or drop them here</strong><small>JPEG, PNG or WebP · up to 5 images · 5 MB each</small></label>
            {images.length > 0 && <div className="image-preview-grid">{images.map((image,index)=><div className="image-preview" key={image.preview}><img src={image.preview} alt={`Issue evidence ${index + 1}`}/><button type="button" aria-label="Remove image" onClick={()=>removeImage(index)}><X/></button><small>{image.file.name}</small></div>)}</div>}
            <p className="privacy-note">Only attach photos that help document the issue. Avoid including faces, license plates, or other personal information.</p>
          </div>}

          {step === 2 && <div className="report-location">
            <label>Address or place name<input value={locationText} onChange={(event)=>setLocationText(event.target.value)} placeholder="Street, landmark, neighborhood…" /></label>
            <p className="map-helper"><MapPin size={16}/> Click the map or drag the marker to refine the location. Browser location is not requested.</p>
            <LocationPicker latitude={latitude} longitude={longitude} onSelect={(lat,lon)=>{setLatitude(Number(lat.toFixed(6)));setLongitude(Number(lon.toFixed(6)));}}/>
            <div className="coordinate-fields"><label>Latitude<input type="number" value={latitude} min="-90" max="90" step="0.000001" onChange={(event)=>setLatitude(Number(event.target.value))}/></label><label>Longitude<input type="number" value={longitude} min="-180" max="180" step="0.000001" onChange={(event)=>setLongitude(Number(event.target.value))}/></label></div>
            <div className="ai-disclosure" role="note">
              <strong>Optional Google Gemini analysis</strong>
              <p>If Gemini is enabled, choosing “Analyze report” sends your title and description to Google for suggestions. CivicLoop applies best-effort filtering for common identifiers, but this is not guaranteed anonymization. Avoid personal or sensitive details. Suggestions are advisory; you can continue without AI and submit normally.</p>
            </div>
            <label className="public-consent"><input type="checkbox" checked={aiConsentAccepted} onChange={(event) => setAiConsentAccepted(event.target.checked)}/><span><strong>Allow this report text to be sent to Google Gemini</strong><small>This is optional. Your title and description are sent for analysis only after you check this box.</small></span></label>
          </div>}

          {step === 3 && analysis && <div className="analysis-panel">
            <div className="analysis-source"><Sparkles size={18}/><span><strong>{analysis.source === 'gemini' ? 'AI-assisted suggestions' : 'Rule-based fallback suggestions'}</strong><small>{analysis.note}</small></span></div>
            <div className="analysis-grid"><div><small>Suggested category</small><strong>{analysis.classification.category.replace('_',' ')}</strong></div><div><small>Suggested severity</small><strong>{analysis.classification.severity}</strong></div><div><small>Department recommendation</small><strong>{analysis.department.name ?? 'Unassigned — review needed'}</strong></div><div><small>Priority recommendation</small><strong>{analysis.priority.band} · {analysis.priority.score}/100</strong></div></div>
            <div className="analysis-summary"><small>Incident summary</small><p>{analysis.summary}</p></div>
            <div className="analysis-summary"><small>Why this suggestion?</small><p>{analysis.classification.reasoning}</p><small>Confidence: {Math.round(analysis.classification.confidence*100)}% · {analysis.priority.reasoning}</small></div>
            <div className="recommendation-note"><AlertTriangle size={17}/> These are recommendations only. Your selected category and report details are not silently changed.</div>
            {analysis.duplicates.length>0&&<div className="duplicate-list"><h3>Possible matching reports</h3><p>These are potential matches, not a reason to block your report.</p>{analysis.duplicates.map((duplicate)=><article className={`duplicate-card ${confirmedDuplicateId===duplicate.id?'chosen':''}`} key={duplicate.id}><div><strong>{duplicate.title}</strong><small>{duplicate.category.replace('_',' ')} · {duplicate.status.replaceAll('_',' ')} · {duplicate.locationText}</small><small>{duplicate.distanceLabel} · {Math.round(duplicate.similarity*100)}% text/location match · {new Date(duplicate.createdAt).toLocaleDateString()}</small></div><div className="duplicate-actions"><Link to={`/issues/${duplicate.id}`} target="_blank">View</Link><button type="button" onClick={()=>setConfirmedDuplicateId(confirmedDuplicateId===duplicate.id?'':duplicate.id)}>{confirmedDuplicateId===duplicate.id?'Same issue selected':'This is the same issue'}</button></div></article>)}</div>}
            {confirmedDuplicateId&&<div className="duplicate-confirmed">You confirmed a possible duplicate. We will still preserve this report and link it to the existing incident.</div>}
          </div>}

          {step === 4 && <div className="report-review">
            <div className="review-section"><div><small>ISSUE</small><button type="button" onClick={()=>setStep(0)}>Edit</button></div><h3>{title}</h3><p>{description}</p><span>{reportCategories.find((item)=>item.id===category)?.label}</span></div>
            <div className="review-section"><div><small>LOCATION</small><button type="button" onClick={()=>setStep(2)}>Edit</button></div><p>{locationText}</p><small>{latitude.toFixed(6)}, {longitude.toFixed(6)}</small></div>
            <div className="review-section"><div><small>EVIDENCE</small><button type="button" onClick={()=>setStep(1)}>Edit</button></div>{images.length?<div className="review-thumbnails">{images.map((image)=><img key={image.preview} src={image.preview} alt="Report evidence"/>)}</div>:<p>No photos attached</p>}</div>
            {analysis
              ? <div className="review-ai"><Sparkles size={18}/><p><strong>{analysis.classification.category.replace('_',' ')} · {analysis.classification.severity} · {analysis.priority.band}</strong><br/>{analysis.department.name??'Department unassigned'} · {analysis.note}</p><button type="button" onClick={()=>setStep(3)}>Review suggestions</button></div>
              : <div className="review-ai"><Sparkles size={18}/><p><strong>AI analysis skipped</strong><br/>Your report can still be submitted. No Gemini analysis will be requested.</p><button type="button" onClick={()=>setStep(2)}>Add optional analysis</button></div>}
            {confirmedDuplicateId&&<div className="duplicate-confirmed">This report will be marked as a citizen-confirmed possible duplicate. The submission is still retained.</div>}
            <label className="public-consent"><input type="checkbox" checked={isPublic} onChange={(event)=>setIsPublic(event.target.checked)}/><span><strong>Share this report publicly</strong><small>Public reports show issue details and location, but never your account information. You can uncheck this to keep the report private.</small></span></label>
          </div>}

          {error&&<div className="report-error" role="alert"><AlertTriangle size={17}/>{error}</div>}
          <div className="report-actions">{step>0&&<button type="button" className="button outline" disabled={busy} onClick={()=>{setError('');setStep((current)=>current===4&&!analysis?2:current-1);}}><ArrowLeft size={16}/> Back</button>}{step===2&&<button type="button" className="button outline" disabled={busy} onClick={continueWithoutAi}>Continue without AI</button>}{step<4?<button type="button" className="button primary" disabled={busy || (step === 2 && !aiConsentAccepted)} onClick={advance}>{busy?'Analyzing…':step===2?'Analyze report':'Continue'}<ArrowRight size={16}/></button>:<button type="button" className="button primary" disabled={busy} onClick={submit}>{busy?'Submitting…':'Submit report'}<ArrowRight size={16}/></button>}</div>
        </section>
      </div>
    </div>
  );
}

export function ReportSuccess() {
  const { id } = useParams();
  return <div className="report-success"><div><span><CheckCircle2 size={32}/></span><small>REPORT SUBMITTED</small><h1>Your voice is in the loop.</h1><p>Your incident was submitted successfully. Keep this reference ID to track its progress.</p><div className="success-id"><small>INCIDENT ID</small><strong>{id}</strong></div><Link className="button primary" to={`/citizen/my-reports/${id}`}>View your report</Link><Link className="success-secondary" to="/citizen">Back to dashboard</Link></div></div>;
}
