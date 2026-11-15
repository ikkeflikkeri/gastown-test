import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import OpenAI from 'openai';
import { z } from 'zod';
import { calculateGrade, centeringRatio } from './grading.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const app = express();
app.disable('x-powered-by');
const upload=multer({storage:multer.memoryStorage(),limits:{files:8,fileSize:12*1024*1024},fileFilter(_req,file,cb){cb(null,['image/jpeg','image/png','image/webp'].includes(file.mimetype));}});
const Defect=z.object({imageIndex:z.number().int(),category:z.enum(['corner','edge','surface']),severity:z.enum(['minor','moderate','major','critical']),label:z.string(),explanation:z.string(),box:z.object({x:z.number(),y:z.number(),w:z.number(),h:z.number()}),visibility:z.enum(['clear','possible'])});
const Border=z.object({left:z.number().nullable(),right:z.number().nullable(),top:z.number().nullable(),bottom:z.number().nullable(),quality:z.enum(['measurable','approximate','unavailable'])});
const Observation=z.object({imageIndex:z.number().int(),notes:z.string(),quality:z.enum(['good','fair','poor'])});
const Vision=z.object({cardName:z.string(),imageQualityScore:z.number(),frontBorders:Border,backBorders:Border,defects:z.array(Defect),observations:z.array(Observation),warnings:z.array(z.string()),explanation:z.string(),overallCondition:z.string(),suspectedAlteration:z.boolean()});
const SYSTEM=`You are a conservative collectible Pokémon-card visual condition inspector. The input is photographic evidence, NOT a laboratory inspection. Distinguish actual visible defects from possible glare, artifacts and shadows. Analyze front and back centering, four corners, all edges and surface. Do not pretend to see micro-defects invisible in the photographs. Return a structured inspection, not an official PSA grade. For each photographed defect return a concise label and box coordinates normalized to [0,1] relative to the FULL ORIGINAL IMAGE (x/y origin top left; w/h width/height); do not invent defect boxes. Mark ambiguous defects visibility=possible. Border widths in normalized IMAGE coordinate lengths must refer to the four visible printed border widths INSIDE the card, not the empty background around the card. If no visible border boundary, use nulls and unavailable. Only quantify where reliable; estimate if approximate and mark it. Image indices are zero based as provided. If a major crease, bend or suspected alteration appears, flag it and describe. Do not mistake artwork or printing texture for damage. If photos are not appropriate card images, return no defects, border nulls, low quality and warnings. Be succinct, accurate and transparent.`;
function fmtBorder(b,side){
  const horizontal= b.left!=null&&b.right!=null ? {ratio:centeringRatio([b.left,b.right]),left:b.left,right:b.right} : {ratio:null,left:null,right:null};
  const vertical= b.top!=null&&b.bottom!=null ? {ratio:centeringRatio([b.top,b.bottom]),top:b.top,bottom:b.bottom} : {ratio:null,top:null,bottom:null};
  return {side,quality:b.quality,horizontal,vertical};
}
app.get('/api/health',(_req,res)=>res.json({ok:true,configured:!!process.env.OPENAI_API_KEY}));
app.post('/api/grade',upload.array('photos',8),async(req,res)=>{
 try{
  if(!process.env.OPENAI_API_KEY) return res.status(503).json({error:'AI service not configured. Add OPENAI_API_KEY to .env on the server.'});
  const files=req.files||[];
  if(!files.length) return res.status(400).json({error:'Upload at least one JPEG, PNG or WebP image.'});
  const roles=JSON.parse(req.body.roles||'[]');
  if(!Array.isArray(roles)||roles.length!==files.length||roles.some(r=>!['front','back','detail'].includes(r))) return res.status(400).json({error:'Each photo needs a front, back or detail label.'});
  const content=[{type:'text',text:`Inspect the same Pokémon card across ${files.length} photos. The image roles in order are: ${roles.join(', ')}. Index each photo from 0. For detail images, use their defect evidence but only measure centering from front or back full-card images. Assess all six grading dimensions. Full-card image crops may vary; never measure outside margins as card borders. Return ONLY valid JSON matching this exact shape: {\"cardName\":string,\"imageQualityScore\":number,\"frontBorders\":{\"left\":number|null,\"right\":number|null,\"top\":number|null,\"bottom\":number|null,\"quality\":\"measurable\"|\"approximate\"|\"unavailable\"},\"backBorders\":same,\"defects\":[{\"imageIndex\":number,\"category\":\"corner\"|\"edge\"|\"surface\",\"severity\":\"minor\"|\"moderate\"|\"major\"|\"critical\",\"label\":string,\"explanation\":string,\"box\":{\"x\":number,\"y\":number,\"w\":number,\"h\":number},\"visibility\":\"clear\"|\"possible\"}],\"observations\":[{\"imageIndex\":number,\"notes\":string,\"quality\":\"good\"|\"fair\"|\"poor\"}],\"warnings\":[string],\"explanation\":string,\"overallCondition\":string,\"suspectedAlteration\":boolean}. Do not wrap JSON in markdown fences.`}];
  for(let i=0;i<files.length;i++){
   const file=files[i];
   let processed;
   try {processed=await sharp(file.buffer,{limitInputPixels:35_000_000}).rotate().resize({width:1600,height:1600,fit:'inside',withoutEnlargement:true}).jpeg({quality:87}).toBuffer();}
   catch{return res.status(400).json({error:`Could not decode image ${i+1}.`});}
   content.push({type:'text',text:`PHOTO INDEX ${i}; ROLE ${roles[i]}`},{type:'image_url',image_url:{url:`data:image/jpeg;base64,${processed.toString('base64')}`,detail:'high'}});
  }
  const client=new OpenAI({
   apiKey:process.env.OPENAI_API_KEY,
   ...(process.env.OPENAI_BASE_URL ? {baseURL:process.env.OPENAI_BASE_URL} : {})
  });
  const response=await client.chat.completions.create({
   model:process.env.OPENAI_MODEL||'MiniMax-M3',
   messages:[{role:'system',content:SYSTEM},{role:'user',content}],
   response_format:{type:'json_object'},
   max_tokens:3500
  });
  const raw=response.choices?.[0]?.message?.content;
  if(!raw) return res.status(502).json({error:'The model did not return a usable visual inspection.'});
  let parsed;
  try { parsed=JSON.parse(raw); } catch { return res.status(502).json({error:'The model returned invalid JSON.'}); }
  const checked=Vision.safeParse(parsed);
  if(!checked.success){ console.error('Vision schema failure:',checked.error.message); return res.status(502).json({error:'The model response did not match the expected grading schema.'}); }
  const v=checked.data;
  if(!v) return res.status(502).json({error:'The model did not return a usable visual inspection.'});
  const defects=v.defects.filter(d=>d.imageIndex>=0&&d.imageIndex<files.length).map(d=>({...d,box:{x:Math.max(0,Math.min(1,d.box.x)),y:Math.max(0,Math.min(1,d.box.y)),w:Math.max(0,Math.min(1-d.box.x,d.box.w)),h:Math.max(0,Math.min(1-d.box.y,d.box.h))}}));
  const centering={front:fmtBorder(v.frontBorders,'front'),back:fmtBorder(v.backBorders,'back')};
  const result=calculateGrade({...v,defects,centering},roles);
  if(v.suspectedAlteration) result.warnings.unshift('Possible alteration detected: a professional authenticity and alteration check is needed.');
  res.json({...result,centering,defects,observations:v.observations,cardName:v.cardName,explanation:v.explanation,overallCondition:v.overallCondition,imageQualityScore:v.imageQualityScore,engine:'openai-compatible vision + transparent rules',disclaimer:'PSA is a trademark of Collectors Universe, Inc. This independent tool is not affiliated with or endorsed by PSA.'});
 }catch(err){console.error('Grading failure:',err?.message);res.status(500).json({error:'Unable to analyze the photographs. Check server configuration or try again.'});}
});
if(process.env.NODE_ENV==='production'){
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../dist');
 app.use(express.static(root));app.get('*',(_req,res)=>res.sendFile(path.join(root,'index.html')));
}
app.listen(Number(process.env.PORT)||8787,()=>console.log('CardGrade API listening on port '+(process.env.PORT||8787)));
