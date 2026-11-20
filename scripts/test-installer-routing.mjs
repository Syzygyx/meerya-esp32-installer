import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const html=fs.readFileSync(new URL('../installer/index.html',import.meta.url),'utf8');
const functions=html.slice(html.indexOf('    function isMeeryaDevice('),html.indexOf('    function scoreHostDevice('));
const select=(value,label)=>({value,label});
const els={hostOutputSelect:select('realtek','Realtek speakers'),meeryaInputSelect:select('usb-mic','Microphone (Meerya)'),meeryaOutputSelect:select('usb-speaker','Speaker (Meerya)'),hostInputSelect:select('intel','Intel microphone')};
const nodes={micSlotsResult:{},audioSuiteSummary:{}};
let clears=0,panel,message;
const ctx=vm.createContext({els,state:{audioSuiteSteps:[{status:'passed'}],micDiagnostics:{status:'passed'},captureSettings:{}},deviceLabel:d=>d.label||'',selectedOptionLabel:s=>s.label,clearAudioResults:()=>clears++,document:{getElementById:id=>nodes[id]},setAudioPanelState:v=>panel=v,setAudioTestState:v=>message=v});
vm.runInContext(functions,ctx);
for(const label of ['Microphone','Speaker','UAC1','ESP32 audio','Intel Smart Sound','Realtek']) assert.equal(ctx.isMeeryaDevice({label}),false,label);
for(const label of ['Meerya','USB Audio (Meerya Rev.C UAC)']) assert.equal(ctx.isMeeryaDevice({label}),true,label);
assert.doesNotThrow(()=>ctx.requireMeeryaRoutes());
for(const which of ['meeryaInputSelect','meeryaOutputSelect']) {
 const original={...els[which]};
 for(const [value,label] of [['intel','Intel Smart Sound'],['default','Default - Meerya'],['communications','Meerya'],['','Meerya']]) {
  Object.assign(els[which],{value,label});
  assert.throws(()=>ctx.requireMeeryaRoutes(),/Select explicitly named Meerya/);
  assert.equal(panel,'review');assert.equal(ctx.state.micDiagnostics.status,'not-run');assert.equal(ctx.state.audioSuiteSteps.length,0);
 }
 Object.assign(els[which],original);
}
const before=ctx.audioRouteKey();
ctx.invalidateAudioRoutes(); // hot unplug, even if endpoint IDs reappear unchanged
assert.throws(()=>ctx.requireMeeryaRoutes(before),/run the test again/);
const beforeSelection=ctx.audioRouteKey();els.hostOutputSelect.value='other-speaker';
assert.throws(()=>ctx.requireMeeryaRoutes(beforeSelection),/run the test again/);
assert.ok(clears>0);assert.match(message,/changed/);
// An invalid selection is rejected before any capture or playback can start,
// even when enumerateDevices previously reported Meerya present.
const path=html.slice(html.indexOf('    async function runAudioPathTest('),html.indexOf('    async function maybeAutoRunAudioSmokeTest('));
vm.runInContext(path,ctx);
els.meeryaInputSelect.label='Intel Smart Sound';
await assert.rejects(ctx.runAudioPathTest({readiness:{hasMeeryaInput:true,hasMeeryaOutput:true}}),/Select explicitly named Meerya/);
// The two Meerya dropdowns must not silently fall back to an unrelated endpoint.
const populate=html.slice(html.indexOf('    function populateDeviceSelect('),html.indexOf('    async function refreshAudioDevices('));
ctx.document.createElement=()=>({});
for(const which of ['meeryaInputSelect','meeryaOutputSelect']) {
 const target=els[which];target.appendChild=o=>(target.options??=[]).push(o);
 vm.runInContext(populate,ctx);
 ctx.populateDeviceSelect(target,[{kind:'audioinput',deviceId:'intel',label:'Intel Smart Sound'},{kind:'audiooutput',deviceId:'realtek',label:'Realtek'}],which==='meeryaInputSelect'?'audioinput':'audiooutput','intel');
 assert.equal(target.options.at(-1).value,'');
}
assert.match(html,/select\.addEventListener\("change", invalidateAudioRoutes\)/);
console.log('PASS: explicit Meerya identity, default aliases rejected, wrong routes blocked before capture, stale results invalidated on selection/hotplug, no unrelated dropdown fallback');
