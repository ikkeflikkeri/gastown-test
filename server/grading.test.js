import test from 'node:test';
import assert from 'node:assert/strict';
import {centeringRatio,calculateGrade} from './grading.js';
test('centering computes worst side',()=>{assert.equal(centeringRatio([45,55]),55);assert.equal(centeringRatio([0,0]),null);assert.equal(centeringRatio([-1,30]),null);});
test('missing evidence lowers confidence',()=>{const v={defects:[],imageQualityScore:1,warnings:[],centering:{}};assert.ok(calculateGrade(v,['front']).confidence<calculateGrade(v,['front','back']).confidence);});
test('major defects reduce grade and probabilities sum close to 100',()=>{const v={defects:[{category:'surface',severity:'critical'}],imageQualityScore:.85,warnings:[],centering:{}};const r=calculateGrade(v,['front','back']);assert.ok(r.predictedGrade<10);assert.ok(Math.abs(r.probabilities.reduce((s,x)=>s+x.probability,0)-100)<1);});
