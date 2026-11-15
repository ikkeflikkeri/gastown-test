export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const impact = {minor:0.32,moderate:1.1,major:2.6,critical:4.3};

export function centeringRatio(pair) {
  if (!pair || pair.length !== 2 || pair.some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0)) return null;
  const sum = pair[0] + pair[1];
  if (sum < 1) return null;
  return Math.round(Math.max(pair[0],pair[1]) / sum * 1000) / 10;
}

function centeringPenalty(side) {
  if (!side) return 0;
  const worst = Math.max(...[side.horizontal,side.vertical].map(x=>x?.ratio ?? 50));
  const excess = Math.max(0,worst-(side.side==='front'?55:75));
  return clamp(excess / (side.side==='front'?5:9),0,4.5);
}

export function calculateGrade(vision, roles=[]) {
  const defects = (vision.defects || []).filter(d => d && impact[d.severity]);
  const byType = (type) => defects.filter(d=>d.category===type).reduce((sum,d)=>sum+impact[d.severity],0);
  const corners = clamp(10-byType('corner'),1,10);
  const edges = clamp(10-byType('edge'),1,10);
  const surface = clamp(10-byType('surface'),1,10);
  const front = vision.centering?.front || null, back=vision.centering?.back || null;
  const frontCenter = clamp(10-centeringPenalty(front),1,10);
  const backCenter = clamp(10-centeringPenalty(back),1,10);
  const score = Math.min(corners,edges,surface,frontCenter,backCenter) - Math.min(1.8,defects.length*0.12);
  let predictedGrade = clamp(Math.round(score),1,10);
  const imgQuality = clamp(Number(vision.imageQualityScore)||0.5,0,1);
  const sides = new Set(roles.map(x=>x.toLowerCase()));
  const missingSide = !sides.has('front') || !sides.has('back');
  const unknownCenter = (sides.has('front')&&!front?.horizontal?.ratio) || (sides.has('back')&&!back?.horizontal?.ratio);
  const confidence = clamp(Math.round((0.3 + 0.54*imgQuality - (missingSide?0.18:0) - (unknownCenter?0.07:0))*100),12,85);
  const sigma = clamp(0.8 + (100-confidence)/100*1.7,0.85,2.7);
  const unnormalized = Array.from({length:10},(_,i)=>Math.exp(-0.5*((i+1-score)/sigma)**2));
  const total=unnormalized.reduce((a,b)=>a+b,0);
  const probabilities=unnormalized.map((p,i)=>({grade:i+1,probability:Math.round(p/total*1000)/10}));
  const warnings = [...(vision.warnings||[])];
  if(missingSide) warnings.unshift('Both front and back photos are needed for a comprehensive estimate.');
  if(unknownCenter) warnings.push('At least one border measurement is unavailable; centering was not assumed.');
  if(imgQuality<0.65) warnings.push('Photo quality may hide micro-scratches, whitening, or fine print defects.');
  warnings.push('This is an AI photo-based estimate, not an official PSA grade or authentication.');
  return {predictedGrade,probabilities,confidence,uncertainty:confidence<55?'high':confidence<75?'moderate':'lower',warnings:[...new Set(warnings)],scores:{frontCentering:Number(frontCenter.toFixed(1)),backCentering:Number(backCenter.toFixed(1)),corners:Number(corners.toFixed(1)),edges:Number(edges.toFixed(1)),surface:Number(surface.toFixed(1)),overall:Number(clamp(score,1,10).toFixed(1))}};
}
