import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceWords, inspectEdge, joinContext } from '../utterance.mjs';

const ws = sourceWords(['Готово.','Если','будет','дождь,','останемся','дома.','Надолго?','Да.'].map((w,i) => ({w,s:i,e:i+.6})),100);
const gaps = [{s:105.7,e:105.96},{s:106.65,e:106.95}];
test('source clock, punctuated OUT and independent IN', () => {
  for (const side of ['in','out']) assert.equal(inspectEdge(ws,105.8,side,gaps).status,'candidate');
  assert.equal(ws[0].s,100);
});
test('quiet syntactically incomplete OUT proposes a later measured pause', () => {
  const e = inspectEdge(ws,101.8,'out',gaps);
  assert.ok(e.reasons.includes('open-construction-on-left'));
  assert.equal(e.alternatives[0].last.w,'дома.');
  assert.ok(e.alternatives[0].t > 105.7);
  assert.equal(inspectEdge(ws,101.8,'out',[]).alternatives.length,0);
});
test('cut through token, dependent IN and omitted words', () => {
  assert.ok(inspectEdge(ws,104.3,'in').reasons.some(s => s.startsWith('inside-asr-word')));
  const edge1 = inspectEdge(ws,100.8,'out'), edge2 = inspectEdge(ws,103.8,'in',[{s:100.65,e:100.9}]);
  assert.equal(edge2.alternatives[0].next.w,'Если');
  assert.equal(joinContext(ws,{t:100},edge1,edge2,{t:108}).omitted.map(w => w.w).join(' '),'Если будет дождь,');
  const dependent = sourceWords([{s:0,e:.4,w:'Ответ.'},{s:.7,e:.95,w:'Который'}]);
  assert.equal(inspectEdge(dependent,.52,'in').status,'review');
});
test('retained join context excludes words beyond short ranges on either side', () => {
  const out=inspectEdge(ws,102.8,'out'), into=inspectEdge(ws,104.8,'in');
  const join=joinContext(ws,{t:101.8},out,into,{t:105.8});
  assert.equal(join.retainedTail,'будет');
  assert.equal(join.retainedHead,'дома.');
  assert.equal(join.omitted.map(w => w.w).join(' '),'дождь, останемся');
});
test('missing context, uncertain punctuation and weak recognition', () => {
  assert.equal(inspectEdge([],0,'in').status,'unknown');
  assert.equal(inspectEdge(ws,108,'out').status,'unknown');
  assert.equal(inspectEdge([{s:0,e:1,w:'Правда…'},{s:1.4,e:2,w:'Да.'}],1.2,'out').status,'review');
  assert.equal(inspectEdge([{s:0,e:1,w:'Yes.',p:.2},{s:1.4,e:2,w:'Next'}],1.2,'out').status,'review');
  assert.throws(() => sourceWords([{startSec:0,endSec:10,text:'sentence only'}]));
});
